import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { webcrypto as crypto } from "node:crypto";
import worker from "../src/index.js";
import { decideViaWorker } from "../../admin/js/worker-client.js";
import { __resetKeyCache } from "../src/auth.js";
import { __resetTokenCache } from "../src/oauth.js";

/**
 * Integration: Admin Dashboard -> Worker /accept -> Firestore.
 *
 * This drives the REAL worker's fetch handler end to end. Only the two external
 * boundaries are stubbed:
 *
 *   - Google's signing-key endpoint (we serve our own key and sign real JWTs,
 *     so signature verification is genuinely exercised)
 *   - Firestore REST (an in-memory store honouring the real preconditions)
 *
 * Route wiring, the origin check, token verification, the admin-claim check,
 * validation, the promotion logic and the dashboard's request shape all run for
 * real. Nothing between the dashboard and Firestore is mocked except the wire.
 */

const PROJECT = "crp-cuby-display";
const KID = "integration-key";
const ORIGIN = "https://crp-company.github.io";
const BASE =
  "https://firestore.googleapis.com/v1/projects/crp-cuby-display/databases/(default)/documents";
const WORKER_ORIGIN = "https://crp-tester-email.example.workers.dev";

let keyPair;
let store;
let keysDoc;
let accessTokenCalls = 0;
let resendCalls = [];
let walletKeyPair;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Decode a Firestore field-value map into plain JS. */
function decodeFields(fields) {
  const out = {};
  for (const [k, f] of Object.entries(fields || {})) {
    if ("integerValue" in f) out[k] = Number(f.integerValue);
    else if ("booleanValue" in f) out[k] = f.booleanValue;
    else if ("stringValue" in f) out[k] = f.stringValue;
    else if ("nullValue" in f) out[k] = null;
    // Timestamps round-trip as ISO strings, matching how the rest of the code
    // reads them back (request.createdAt is compared as a string).
    else if ("timestampValue" in f) out[k] = f.timestampValue;
    // Nested maps, so `wallet` on a tester document survives the round trip.
    else if ("mapValue" in f) out[k] = decodeFields(f.mapValue.fields);
  }
  return out;
}

/** Encode a plain JS value into Firestore field-value form. */
function encodeValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "number") return { integerValue: String(value) };
  if (typeof value === "boolean") return { booleanValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  // Nested maps, so a tester document round-trips its `wallet` sub-document.
  if (typeof value === "object" && !Array.isArray(value)) {
    const fields = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      fields[k] = encodeValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

/** Encode a whole document, mirroring the client's encodeFields(). */
function encodeDocument(doc) {
  const fields = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "updateTime" || v === undefined) continue;
    fields[k] = encodeValue(v);
  }
  return fields;
}

/** Minimal Firestore REST fake honouring the preconditions the code relies on. */
function installFirestore() {
  const docs = new Map();
  let version = 0;
  const bump = () => `v${(version += 1)}`;

  store = {
    docs,
    async get(c, id) {
      const d = docs.get(`${c}/${id}`);
      return d ? { ...d, exists: true } : null;
    },
    async create(c, id, data) {
      if (docs.has(`${c}/${id}`)) return { status: 409 };
      docs.set(`${c}/${id}`, { ...data, updateTime: bump() });
      return { status: 200 };
    },
    async update(c, id, data) {
      if (!docs.has(`${c}/${id}`)) return { status: 409 };
      docs.set(`${c}/${id}`, { ...docs.get(`${c}/${id}`), ...data, updateTime: bump() });
      return { status: 200 };
    },
    async list(c) {
      return [...docs.entries()]
        .filter(([k]) => k.startsWith(`${c}/`))
        .map(([k, v]) => ({ name: `${BASE}/${k}`, fields: {}, _id: k.split("/").pop(), _data: v }));
    },
  };

  vi.stubGlobal("fetch", async (input, init = {}) => {
    // Accept every form the runtime does: string, URL, or Request. Getting this
    // wrong is a harness bug that would masquerade as a production failure,
    // because firestore-rest.js passes a URL object to fetch.
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // The dashboard's own request to the Worker. The test drives
    // worker.fetch() directly, so this is the harness standing in for
    // Cloudflare's router. Real auth and real promotion logic run behind it.
    //
    // Origin is added because a real browser sends it automatically. Leaving
    // it off is what proves the allow-list is genuinely enforced.
    if (url.startsWith(WORKER_ORIGIN)) {
      const headers = new Headers(init.headers || {});
      if (!headers.has("Origin")) headers.set("Origin", ORIGIN);
      return worker.fetch(new Request(url, { ...init, headers }), env);
    }

    if (url.includes("robot/v1/metadata/x509")) {
      return new Response(JSON.stringify(keysDoc), { status: 200 });
    }
    // Resend: captured rather than sent, so the decision emails can be asserted
    // on. Deliberately not the Firestore or Worker branches above.
    if (url.includes("api.resend.com")) {
      resendCalls.push({ headers: init.headers || {}, body: JSON.parse(init.body) });
      return json({ id: "resend-1" });
    }
    if (url === "https://oauth2.googleapis.com/token") {
      accessTokenCalls += 1;
      return json({ access_token: "stub-access-token", expires_in: 3600 });
    }
    if (url.startsWith(BASE)) {
      const parsed = new URL(url);
      // Split on the LAST "/documents/" — the database id is "(default)",
      // which itself contains a slash and would defeat a naive split.
      const path = parsed.pathname.slice(parsed.pathname.lastIndexOf("/documents/") + 11);
      if (path.includes(":")) return json({}); // transaction verbs, unused here

      const method = init.method || "GET";
      const [c, ...rest] = path.split("/");
      const id = decodeURIComponent(rest.join("/"));

      if (method === "GET") {
        // A collection listing has no document id, and must be checked BEFORE
        // the single-document lookup, which would otherwise 404 it.
        if (!id) {
          const listed = await store.list(c);
          return json({
            documents: listed.map((d) => ({ name: d.name, fields: encodeDocument(d._data) })),
          });
        }

        const doc = await store.get(c, id);
        if (!doc) return json({ error: { code: 404 } }, 404);
        return json({
          name: `${BASE}/${path}`,
          fields: encodeDocument(doc),
          updateTime: doc.updateTime,
        });
      }

      if (method === "PATCH") {
        const decoded = decodeFields(JSON.parse(init.body).fields);
        // The versioned precondition the sequential counter depends on.
        const wanted = parsed.searchParams.get("currentDocument.updateTime");
        if (wanted) {
          const cur = await store.get(c, id);
          if (!cur || cur.updateTime !== wanted) {
            return json({ error: { code: 409, status: "FAILED_PRECONDITION" } }, 409);
          }
        }
        const res =
          parsed.searchParams.get("currentDocument.exists") === "false"
            ? await store.create(c, id, decoded)
            : await store.update(c, id, decoded);
        return json({ error: res.status === 409 ? { code: 409 } : undefined }, res.status);
      }

      // Collection listing, used to spot an existing tester with the same email.
      // A bare GET on a collection has no document id. Fields must be real,
      // because the caller reads `email` off each result to find a duplicate.
      if (method === "GET" && !id) {
        const docs = await store.list(c);
        return json({
          documents: docs.map((d) => {
            const fields = {};
            for (const [k, v] of Object.entries(d._data)) {
              if (k === "updateTime") continue;
              if (typeof v === "number") fields[k] = { integerValue: String(v) };
              else if (typeof v === "boolean") fields[k] = { booleanValue: v };
              else if (typeof v === "string") fields[k] = { stringValue: v };
            }
            return { name: d.name, fields };
          }),
        });
      }
    }

    return json({ error: `unexpected fetch: ${url}` }, 500);
  });
}
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function mintAdminToken(over = {}, { kid = KID } = {}) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const payload = b64url(
    JSON.stringify({
      iss: `https://securetoken.google.com/${PROJECT}`,
      aud: PROJECT,
      sub: "admin-uid",
      user_id: "admin-uid",
      email: "staff@crp.com",
      admin: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...over,
    }),
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

const env = {
  RESEND_API_KEY: "re_test",
  ALLOWED_ORIGINS: ORIGIN,
  FIREBASE_PROJECT_ID: PROJECT,
};

/**
 * A real PKCS#8 PEM, generated per test, so the JWT signing path runs for
 * genuine. A placeholder key would only prove the error handling works.
 */
let serviceAccountJson = "";

async function serviceAccountPem(key = keyPair.privateKey) {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", key);
  const b64 = Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n");
  return (
    "-----BEGIN PRIVATE KEY-----\n" + b64 + "\n-----END PRIVATE KEY-----\n"
  );
}

const seedRequest = (over = {}) => {
  // The full shape js/signup.js writes, so a decision can be asserted not to
  // destroy any of it.
  store.docs.set("requests/r1", {
    name: "Alex Morgan",
    email: "alex@example.com",
    consent: true,
    status: "pending",
    source: "early-access-site",
    userAgent: "test-agent",
    website: "",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...over,
  });
};

beforeEach(async () => {
  keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const spki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  keysDoc = {
    [KID]:
      "-----BEGIN CERTIFICATE-----\n" +
      Buffer.from(spki).toString("base64").replace(/(.{64})/g, "$1\n").trim() +
      "\n-----END CERTIFICATE-----\n",
  };

  installFirestore();
  seedRequest();
  __resetKeyCache();
  __resetTokenCache();
  accessTokenCalls = 0;
  resendCalls = [];

  // A genuine signing key, so getAccessToken() exercises real JWT signing.
  serviceAccountJson = JSON.stringify({
    type: "service_account",
    project_id: PROJECT,
    client_email: "worker@crp-cuby-display.iam.gserviceaccount.com",
    private_key: await serviceAccountPem(),
  });
  env.FIREBASE_SERVICE_ACCOUNT_JSON = serviceAccountJson;

  // A separate key for the Wallet issuer, which lives in the crp-tester-card
  // project — deliberately not the Firebase project, exactly as in production.
  walletKeyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON = JSON.stringify({
    type: "service_account",
    project_id: "crp-tester-card",
    client_email: "crp-tester-worker@crp-tester-card.iam.gserviceaccount.com",
    private_key: await serviceAccountPem(walletKeyPair.privateKey),
  });
});

afterEach(() => vi.unstubAllGlobals());

/* ------------------------------------------------------------------ */

describe("Admin Dashboard -> Worker /accept", () => {
  it("approves an application end to end", async () => {
    const token = await mintAdminToken();

    // The dashboard's own client function issues the real request.
    const result = await decideViaWorker({
      url: `${WORKER_ORIGIN}/accept`,
      token,
      requestId: "r1",
      decision: "approved",
    });

    expect(result.ok).toBe(true);
    expect(result.testerNumber).toBe(1);

    const req = store.docs.get("requests/r1");
    expect(req.status).toBe("approved");
    expect(req.testerId).toBe(result.testerId);
    expect(req.reviewedBy).toBe("admin-uid");

    const tester = store.docs.get(`testers/${result.testerId}`);
    expect(tester.status).toBe("accepted");
    expect(tester.active).toBe(true);
    expect(tester.testerNumber).toBe(1);
    expect(tester.email).toBe("alex@example.com");
    expect(tester.appliedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(tester.acceptedAt).toBeTruthy();

    // The sequential counter advanced.
    expect(store.docs.get("meta/testerCounter").lastNumber).toBe(1);
    expect([...store.docs.keys()].filter((k) => k.startsWith("audit/")).length).toBeGreaterThan(0);
  });

  it("sends the ID token in the Authorization header", async () => {
    const token = await mintAdminToken();
    const seen = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input, init = {}) => {
      if (String(input).includes("/accept")) seen.push(init.headers?.Authorization);
      return realFetch(input, init);
    });

    await decideViaWorker({
      url: `${WORKER_ORIGIN}/accept`,
      token,
      requestId: "r1",
      decision: "approved",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(`Bearer ${token}`);
  });

  it("assigns distinct numbers to concurrent approvals", async () => {
    for (let i = 1; i <= 3; i += 1) {
      store.docs.set(`requests/r${i + 1}`, {
        name: `P${i + 1}`,
        email: `p${i + 1}@example.com`,
        status: "pending",
      });
    }
    const token = await mintAdminToken();

    const results = await Promise.all(
      ["r1", "r2", "r3", "r4"].map((id) =>
        decideViaWorker({
          url: `${WORKER_ORIGIN}/accept`,
          token,
          requestId: id,
          decision: "approved",
        }),
      ),
    );

    expect(results.map((r) => r.testerNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("reuses the access token across calls", async () => {
    // The OAuth token should be cached per isolate, not re-minted each request.
    const token = await mintAdminToken();
    const post = (id) =>
      decideViaWorker({
        url: `${WORKER_ORIGIN}/accept`,
        token,
        requestId: id,
        decision: "approved",
      });

    store.docs.set("requests/r2", { name: "B", email: "b@example.com", status: "pending" });
    store.docs.set("requests/r3", { name: "C", email: "c@example.com", status: "pending" });

    const results = await Promise.all([post("r1"), post("r2"), post("r3")]);
    expect(results.map((r) => r.testerNumber).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(accessTokenCalls).toBe(1);
  });

  it("rejects without creating a tester or burning a number", async () => {
    const token = await mintAdminToken();
    await decideViaWorker({
      url: `${WORKER_ORIGIN}/accept`,
      token,
      requestId: "r1",
      decision: "rejected",
      note: "not a fit",
    });

    expect(store.docs.get("requests/r1").status).toBe("rejected");
    expect([...store.docs.keys()].filter((k) => k.startsWith("testers/"))).toHaveLength(0);
    expect(store.docs.get("meta/testerCounter")).toBeUndefined();
  });

  it("refuses a second approval of the same request", async () => {
    seedRequest({ status: "approved" });
    const token = await mintAdminToken();
    await expect(
      decideViaWorker({
        url: `${WORKER_ORIGIN}/accept`,
        token,
        requestId: "r1",
        decision: "approved",
      }),
    ).rejects.toThrow(/already approved/i);
  });

  it("404s an unknown request", async () => {
    const token = await mintAdminToken();
    await expect(
      decideViaWorker({
        url: `${WORKER_ORIGIN}/accept`,
        token,
        requestId: "nope",
        decision: "approved",
      }),
    ).rejects.toThrow(/No such request/i);
  });
});

describe("Admin Dashboard -> Worker /accept — refusals", () => {
  const post = (token, origin = ORIGIN) =>
    worker.fetch(
      new Request(`${WORKER_ORIGIN}/accept`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ requestId: "r1", decision: "approved" }),
      }),
      env,
    );

  it("401s a request with no token", async () => {
    const res = await post(null);
    expect(res.status).toBe(401);
    // Nothing written: the check runs before any Firestore call.
    expect(store.docs.get("requests/r1").status).toBe("pending");
    expect([...store.docs.keys()].filter((k) => k.startsWith("testers/"))).toHaveLength(0);
  });

  it("403s a validly signed token that lacks the admin claim", async () => {
    const res = await post(await mintAdminToken({ admin: false }));
    expect(res.status).toBe(403);
    expect(store.docs.get("requests/r1").status).toBe("pending");
  });

  it("401s a token whose kid we have no key for", async () => {
    // Right claims, right signature, but a kid that is not in Google's key set.
    // The Worker must refuse it rather than fall back to "trust the claims".
    const res = await post(await mintAdminToken({}, { kid: "unknown-kid" }));
    expect([401, 403]).toContain(res.status);
    expect(store.docs.get("requests/r1").status).toBe("pending");
    expect([...store.docs.keys()].filter((k) => k.startsWith("testers/"))).toHaveLength(0);
  });

  it("403s a disallowed origin even with a valid token", async () => {
    const res = await post(await mintAdminToken(), "https://evil.example");
    expect(res.status).toBe(403);
    expect(store.docs.get("requests/r1").status).toBe("pending");
  });

  it("404s an unknown request", async () => {
    const token = await mintAdminToken();
    const res = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/accept`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ requestId: "does-not-exist", decision: "approved" }),
      }),
      env,
    );
    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * End-to-end decision flows, through the real Worker handler.
 * ------------------------------------------------------------------ */

const postAccept = (token, body) =>
  worker.fetch(
    new Request(`${WORKER_ORIGIN}/accept`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
    env,
  );

describe("Admin Dashboard -> Worker /accept — rejection", () => {
  it("rejects, keeps every request field, and emails the applicant", async () => {
    const token = await mintAdminToken();
    const res = await postAccept(token, {
      requestId: "r1",
      decision: "rejected",
      note: "not this round",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("rejected");
    expect(body.emailed).toBe(true);

    // The signup fields survive: the updateMask fix must hold end to end.
    const request = await store.get("requests", "r1");
    expect(request.name).toBe("Alex Morgan");
    expect(request.email).toBe("alex@example.com");
    expect(request.consent).toBe(true);
    expect(request.source).toBe("early-access-site");
    expect(request.createdAt).toBe("2026-09-01T00:00:00.000Z");
    expect(request.status).toBe("rejected");
    expect(request.reviewedBy).toBe("admin-uid");

    // No tester, and no tester number consumed.
    expect(await store.list("testers")).toHaveLength(0);
    expect(await store.get("meta", "testerCounter")).toBeNull();
  });

  it("sends no Wallet link in the rejection email", async () => {
    const token = await mintAdminToken();
    await postAccept(token, { requestId: "r1", decision: "rejected" });

    expect(resendCalls).toHaveLength(1);
    const mail = resendCalls[0].body;
    expect(mail.subject).toBe("CRP Testing Program — Application Update");
    expect(mail.html).not.toContain("pay.google.com");
  });
});

describe("Admin Dashboard -> Worker /accept — approval", () => {
  it("creates the tester, allocates a number, and emails with the Wallet link", async () => {
    const token = await mintAdminToken();
    const res = await postAccept(token, { requestId: "r1", decision: "approved" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("approved");
    expect(body.testerId).toBe("t_r1");
    expect(body.testerNumber).toBe(1);
    expect(body.saveUrl).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);

    const tester = await store.get("testers", "t_r1");
    expect(tester.status).toBe("accepted");
    expect(tester.active).toBe(true);
    expect(tester.testerNumber).toBe(1);
    expect(tester.wallet.classId).toBe("3388000000023210330.crp_tester_loyalty");

    // Request fields preserved, tester linked.
    const request = await store.get("requests", "r1");
    expect(request.name).toBe("Alex Morgan");
    expect(request.email).toBe("alex@example.com");
    expect(request.createdAt).toBe("2026-09-01T00:00:00.000Z");
    expect(request.status).toBe("approved");
    expect(request.testerId).toBe("t_r1");
  });

  it("signs the Wallet pass with the crp-tester-card key, not the Firebase one", async () => {
    const adminToken = await mintAdminToken();
    const res = await postAccept(adminToken, { requestId: "r1", decision: "approved" });
    const { saveUrl } = await res.json();

    const parts = saveUrl.split("/").pop().split(".");
    const [header, payload, signature] = parts;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());

    expect(claims.iss).toBe("crp-tester-worker@crp-tester-card.iam.gserviceaccount.com");
    expect(JSON.parse(Buffer.from(header, "base64url").toString()).alg).toBe("RS256");

    // Genuinely signed by the wallet key.
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      walletKeyPair.publicKey,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  it("sends an acceptance email carrying the number and the Wallet link", async () => {
    const token = await mintAdminToken();
    const res = await postAccept(token, { requestId: "r1", decision: "approved" });
    const { saveUrl } = await res.json();

    expect(resendCalls).toHaveLength(1);
    const mail = resendCalls[0].body;
    expect(mail.to).toEqual(["alex@example.com"]);
    expect(mail.subject).toBe("You're in — CRP Testing Program");
    expect(mail.html).toContain("TESTER #1");
    expect(mail.html).toContain(saveUrl);
    expect(resendCalls[0].headers["Idempotency-Key"]).toBe("application-approved/r1");
  });

  it("leaks no credential in the response or the email", async () => {
    const token = await mintAdminToken();
    const res = await postAccept(token, { requestId: "r1", decision: "approved" });
    const responseText = await res.text();
    const mail = JSON.stringify(resendCalls[0].body);

    for (const secret of ["PRIVATE KEY", "re_test", "BEGIN RSA"]) {
      expect(responseText, secret).not.toContain(secret);
      expect(mail, secret).not.toContain(secret);
    }
  });

  it("refuses a retried approval without a second tester, number or email", async () => {
    const token = await mintAdminToken();

    const first = await postAccept(token, { requestId: "r1", decision: "approved" });
    expect(first.status).toBe(200);
    expect(resendCalls).toHaveLength(1);

    const second = await postAccept(token, { requestId: "r1", decision: "approved" });
    expect(second.status).toBe(409);

    expect(await store.list("testers")).toHaveLength(1);
    expect((await store.get("meta", "testerCounter")).lastNumber).toBe(1);
    expect(resendCalls).toHaveLength(1);
  });

  it("does not burn a number when a rejected request is later approved", async () => {
    const token = await mintAdminToken();
    await postAccept(token, { requestId: "r1", decision: "rejected" });
    const res = await postAccept(token, { requestId: "r1", decision: "approved" });

    expect(res.status).toBe(409);
    expect(await store.get("meta", "testerCounter")).toBeNull();
  });
});

describe("Admin Dashboard -> Worker /tester-wallet", () => {
  const postWallet = (token, body) =>
    worker.fetch(
      new Request(`${WORKER_ORIGIN}/tester-wallet`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      }),
      env,
    );

  const seedTester = (over = {}) =>
    store.docs.set("testers/t_r1", {
      requestId: "r1",
      name: "Alex Morgan",
      email: "alex@example.com",
      status: "accepted",
      active: true,
      testerNumber: 1,
      ...over,
    });

  it("replaces the undeployed issueWalletPass Cloud Function", async () => {
    seedTester();
    const token = await mintAdminToken();
    const res = await postWallet(token, { testerId: "t_r1" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.saveUrl).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    expect(body.active).toBe(true);
  });

  it("signs with the Wallet key and the existing tester number", async () => {
    seedTester();
    const token = await mintAdminToken();
    const res = await postWallet(token, { testerId: "t_r1" });
    const { saveUrl } = await res.json();

    const [header, payload, signature] = saveUrl.split("/").pop().split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims.iss).toBe("crp-tester-worker@crp-tester-card.iam.gserviceaccount.com");
    expect(claims.payload.loyaltyObjects[0].accountName).toBe("CRP Tester #1");

    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      walletKeyPair.publicKey,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  it("issues the SAME Wallet object, so no second pass is created", async () => {
    seedTester();
    const token = await mintAdminToken();
    const first = await (await postWallet(token, { testerId: "t_r1" })).json();
    const second = await (await postWallet(token, { testerId: "t_r1" })).json();

    const objectId = (u) =>
      JSON.parse(Buffer.from(u.split("/").pop().split(".")[1], "base64url").toString())
        .payload.loyaltyObjects[0].id;

    // Derived from the tester document id, so a reissue updates one object.
    expect(objectId(first.saveUrl)).toBe(objectId(second.saveUrl));
    expect(objectId(first.saveUrl)).toBe("3388000000023210330.crp_tester_loyalty_t_r1");
    expect([...store.docs.keys()].filter((k) => k.startsWith("testers/"))).toEqual(["testers/t_r1"]);
  });

  it("issues a REVOKED card for an inactive tester", async () => {
    seedTester({ status: "revoked", active: false });
    const token = await mintAdminToken();
    const res = await postWallet(token, { testerId: "t_r1" });
    const { saveUrl, active } = await res.json();

    expect(active).toBe(false);
    const claims = JSON.parse(Buffer.from(saveUrl.split("/").pop().split(".")[1], "base64url").toString());
    expect(claims.payload.loyaltyObjects[0].state).toBe("REVOKED");
  });

  it("requires the admin claim", async () => {
    seedTester();
    // A valid token that is not staff.
    const nonAdmin = await mintAdminToken({ admin: false });
    const res = await postWallet(nonAdmin, { testerId: "t_r1" });
    expect(res.status).toBe(403);

    const anon = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/tester-wallet`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ testerId: "t_r1" }),
      }),
      env,
    );
    expect(anon.status).toBe(401);
  });

  it("rejects an unknown origin and an unknown tester", async () => {
    seedTester();
    const token = await mintAdminToken();

    const wrongOrigin = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/tester-wallet`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ testerId: "t_r1" }),
      }),
      env,
    );
    expect(wrongOrigin.status).toBe(403);

    const missing = await postWallet(token, { testerId: "does-not-exist" });
    expect(missing.status).toBe(404);
  });

  it("exposes no credential in the response", async () => {
    seedTester();
    const token = await mintAdminToken();
    const res = await postWallet(token, { testerId: "t_r1" });
    const text = await res.text();

    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain("re_test");
    expect(text).not.toContain(env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON.slice(0, 60));
  });

  it("does not send an email when a pass is reissued", async () => {
    seedTester();
    const token = await mintAdminToken();
    await postWallet(token, { testerId: "t_r1" });
    // Reissuing a card is not an acceptance event.
    expect(resendCalls).toHaveLength(0);
  });
});




