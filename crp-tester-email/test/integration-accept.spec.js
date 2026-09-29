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
  }
  return out;
}

/** Encode a plain JS value into Firestore field-value form. */
function encodeValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "number") return { integerValue: String(value) };
  if (typeof value === "boolean") return { booleanValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
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

async function serviceAccountPem() {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const b64 = Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n");
  return (
    "-----BEGIN PRIVATE KEY-----\n" + b64 + "\n-----END PRIVATE KEY-----\n"
  );
}

const seedRequest = (over = {}) => {
  store.docs.set("requests/r1", {
    name: "Alex Morgan",
    email: "alex@example.com",
    status: "pending",
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

  // A genuine signing key, so getAccessToken() exercises real JWT signing.
  serviceAccountJson = JSON.stringify({
    type: "service_account",
    project_id: PROJECT,
    client_email: "worker@crp-cuby-display.iam.gserviceaccount.com",
    private_key: await serviceAccountPem(),
  });
  env.FIREBASE_SERVICE_ACCOUNT_JSON = serviceAccountJson;
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



