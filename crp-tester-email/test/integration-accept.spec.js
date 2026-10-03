import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { webcrypto as crypto } from "node:crypto";
import worker from "../src/index.js";
import { decideViaWorker } from "../../admin/js/worker-client.js";
import { __resetKeyCache } from "../src/auth.js";
import { __resetTokenCache } from "../src/oauth.js";
import { findTesterByEmail, hashEmail } from "../src/tester-portal.js";

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
// The Firebase Auth accounts this run knows about, and the calls made against
// it. The applicant creates their own account during signup, so this fake models
// an account that ALREADY EXISTS — which is the only thing approval now needs.
// A create here would mean the Worker had tried to make one, so the endpoint
// fails loudly instead of quietly succeeding.
let authUsers = new Map();
let authCalls = [];
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

/**
 * Apply a Firestore updateMask to a document.
 *
 * Two behaviours matter and neither is a plain merge:
 *
 *  - Dotted paths address nested fields. `tester.active` must set one key
 *    inside the `tester` map and leave the rest of the user document alone.
 *  - A null value inside the mask DELETES that field. This is how the
 *    move-to-history removes the `tester` map: there is no "delete field" verb,
 *    so the field is listed in the mask and sent as a nullValue.
 */
function applyMask(current, decoded, mask, updateTime) {
  // Deep clone: `current` is shared with the store and must not be mutated in
  // place, or a failed transaction would still have applied its changes.
  const next = JSON.parse(JSON.stringify(current));

  for (const path of mask) {
    const parts = path.split(".");
    const leaf = parts[parts.length - 1];

    // Resolve the value this path names, walking `decoded` in step. A mask entry
    // is a full path (`tester.wallet`) while the body is nested
    // (`{tester: {wallet: ...}}`), so the lookup has to descend both.
    let value = decoded;
    for (const part of parts) {
      value =
        value && typeof value === "object" && part in value ? value[part] : undefined;
    }

    // Walk to the container that owns the leaf, creating intermediate maps
    // exactly as Firestore would.
    let target = next;
    for (const part of parts.slice(0, -1)) {
      if (typeof target[part] !== "object" || target[part] === null) target[part] = {};
      target = target[part];
    }

    if (value === null) {
      // Deleting the field. When that empties a nested map, the map itself goes
      // with it, which is exactly what must happen to `tester` so a removed
      // tester stops reading as present anywhere in the app.
      delete target[leaf];
      continue;
    }

    if (parts.length === 1) {
      target[leaf] = value;
    } else if (typeof value === "object" && value !== null) {
      // A nested map write replaces the subtree at that path, per Firestore.
      target[leaf] = { ...(target[leaf] || {}), ...value };
    } else {
      target[leaf] = value;
    }
  }

  next.updateTime = updateTime;
  return next;
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

    // Firebase Auth admin API. Real: the promotion path genuinely calls this
    // now, because the tester record is written to `users/{uid}` and that uid
    // only exists once an Auth account does.
    if (url === "https://identitytoolkit.googleapis.com/v1/accounts:lookup") {
      const { email = [] } = JSON.parse(init.body || "{}");
      const found = email
        .map((e) => authUsers.get(String(e).toLowerCase()))
        .filter(Boolean);
      if (found.length === 0) return json({});
      return json({ users: found });
    }
    if (url === "https://identitytoolkit.googleapis.com/v1/accounts") {
      const body = JSON.parse(init.body || "{}");
      const key = String(body.email || "").toLowerCase();
      // Any create attempt is a bug: the applicant set their own password during
      // signup, and approval must never create an account. Recording it and
      // failing means a regression shows up as a broken approval rather than as a
      // silently-created account.
      authCalls.push({ kind: "create", email: key, password: body.password });
      return json(
        { error: { code: 400, message: "PERMISSION_DENIED : approval must not create accounts." } },
        400,
      );
    }
    if (url.startsWith(BASE)) {
      const parsed = new URL(url);
      const body = init.body ? JSON.parse(init.body) : {};
      if (parsed.pathname.endsWith("/documents:beginTransaction")) {
        return json({ transaction: "integration-transaction" });
      }
      if (parsed.pathname.endsWith("/documents:rollback")) return json({});
      if (parsed.pathname.endsWith("/documents:commit")) {
        const writes = body.writes || [];
        const staged = [];
        for (const write of writes) {
          if (write.update) {
            const key = write.update.name.slice(write.update.name.indexOf("/documents/") + 11);
            const current = store.docs.get(key);
            const expected = write.currentDocument?.updateTime;
            if (!current || (expected && current.updateTime !== expected)) {
              return json({ error: { code: 409 } }, 409);
            }
            const decoded = decodeFields(write.update.fields);
            // Honour the updateMask the way Firestore does: only the listed
            // paths change, and a null value in the mask DELETES the field.
            // `tester` is a nested map on the user document, so both the dotted
            // paths and the field deletion have to be modelled or the harness
            // would quietly pass a broken implementation.
            const mask = write.updateMask?.fieldPaths || Object.keys(decoded);
            staged.push([key, applyMask(current, decoded, mask, bump())]);
          } else if (write.delete) {
            const key = write.delete.slice(write.delete.indexOf("/documents/") + 11);
            const current = store.docs.get(key);
            const expected = write.currentDocument?.updateTime;
            if (expected && (!current || current.updateTime !== expected)) {
              return json({ error: { code: 409 } }, 409);
            }
            staged.push([key, null]);
          }
        }
        for (const [key, value] of staged) {
          if (value === null) store.docs.delete(key);
          else store.docs.set(key, value);
        }
        return json({});
      }
      // Split on the LAST "/documents/" — the database id is "(default)",
      // which itself contains a slash and would defeat a naive split.
      const path = parsed.pathname.slice(parsed.pathname.lastIndexOf("/documents/") + 11);
      if (path.includes(":")) return json({});

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
        if (parsed.searchParams.get("currentDocument.exists") === "false") {
          const res = await store.create(c, id, decoded);
          return json({ error: res.status === 409 ? { code: 409 } : undefined }, res.status);
        }
        // Masked update, honouring dotted paths: `tester.wallet` must write one
        // nested key without disturbing the rest of the user document.
        //
        // getAll, not get: updateDocument appends one `updateMask.fieldPaths`
        // parameter PER FIELD, and get() returns only the first. Reading it that
        // way silently drops every field after the first, which is exactly the
        // kind of harness bug that looks like a production failure.
        const mask = parsed.searchParams
          .getAll("updateMask.fieldPaths")
          .flatMap((v) => v.split(","))
          .filter(Boolean);
        const cur = await store.get(c, id);
        if (!cur) return json({ error: { code: 404 } }, 404);
        store.docs.set(
          `${c}/${id}`,
          applyMask(cur, decoded, mask.length ? mask : Object.keys(decoded), bump()),
        );
        return json({});
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
  // The admin routes are gated on an email allowlist as well as the admin claim
  // (see src/admin-access.js). The harness mints its token as staff@crp.com, so
  // that address is allowlisted here explicitly rather than relying on the
  // production default — the same way ALLOWED_ORIGINS is set above. A test that
  // wanted to prove the allowlist bites should pass a different one; see
  // test/portal.spec.js.
  ADMIN_EMAILS: "staff@crp.com",
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
    experienceCategory: "developer",
    createdAt: "2026-09-01T00:00:00.000Z",
    updateTime: "seed-version",
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
  authUsers = new Map();
  authCalls = [];

  // The applicant created their own account during signup. Approval links to
  // this uid and never creates an account itself, so seeding it here is the
  // realistic starting state for every approval test below.
  authUsers.set("alex@example.com", {
    localId: "uid-1",
    email: "alex@example.com",
    displayName: "Alex Morgan",
    emailVerified: false,
  });

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
      password: "correct horse battery",
    });

    expect(result.ok).toBe(true);
    expect(result.testerNumber).toBe(1);

    const req = store.docs.get("requests/r1");
    expect(req.status).toBe("approved");
    expect(req.testerId).toBe(result.testerId);
    expect(req.userId).toBe(result.userId);
    expect(req.reviewedBy).toBe("admin-uid");

    // The tester is a MAP on the user document, addressed by the Auth uid.
    const user = store.docs.get(`users/${result.userId}`);
    expect(user).toBeDefined();
    const tester = user.tester;
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

  /**
   * Regression: approval must write a RESOLVABLE pointer.
   *
   * /tester-me can only find a tester through `testerIndex/{sha256(email)}`. A
   * pointer whose userId is null is treated as a stale pre-migration record and
   * answered with 409 "Your tester record needs migrating", so a freshly approved
   * tester would be unable to open their own dashboard. Production carried two
   * such pointers, so this asserts the shape directly rather than inferring it.
   */
  it("writes a testerIndex pointer with a real userId after approval", async () => {
    const token = await mintAdminToken();
    const result = await decideViaWorker({
      url: `${WORKER_ORIGIN}/accept`,
      token,
      requestId: "r1",
      decision: "approved",
    });

    const indexId = await hashEmail("alex@example.com");
    const pointer = store.docs.get(`testerIndex/${indexId}`);

    expect(pointer).toBeDefined();
    expect(pointer.userId).toBe(result.userId);
    // The exact defect: a null here turns every dashboard load into a 409.
    expect(pointer.userId).not.toBeNull();
    expect(typeof pointer.userId).toBe("string");
    expect(pointer.userId.length).toBeGreaterThan(0);

    // And the pointer must actually resolve the tester, which is the whole point.
    // This spec's store is a wire-level fake (get/list); findTesterByEmail wants
    // the REST client's shape (getDocument), so adapt rather than duplicate.
    const portalStore = {
      getDocument: (c, id) => store.get(c, id),
      listSubcollection: (parent, name) => store.list(`${parent}/${name}`),
    };
    const resolved = await findTesterByEmail(portalStore, "alex@example.com");
    expect(resolved).not.toBeNull();
    expect(resolved.userId).toBe(result.userId);
    expect(resolved.testerNumber).toBe(1);
  });

  it("links the account the applicant created, and never creates one", async () => {
    const token = await mintAdminToken();
    const result = await decideViaWorker({
      url: `${WORKER_ORIGIN}/accept`,
      token,
      requestId: "r1",
      decision: "approved",
    });

    // Linked to the uid seeded in beforeEach — the account the applicant made
    // for themselves on the public form.
    expect(result.userId).toBe("uid-1");
    expect(store.docs.get("users/uid-1").tester.testerNumber).toBe(1);

    // The Worker never called the create endpoint.
    expect(authCalls).toHaveLength(0);
    // And nothing password-shaped came back over the wire.
    expect(JSON.stringify(result)).not.toMatch(/password/i);
  });

  it("refuses to approve when the applicant has no account", async () => {
    const token = await mintAdminToken();
    // No account at all: the applicant skipped signup, or used another address.
    // This is reported as an inconsistency rather than papered over by creating
    // one — creating here is exactly the admin-typed-password path we removed.
    authUsers.delete("alex@example.com");

    await expect(
      decideViaWorker({
        url: `${WORKER_ORIGIN}/accept`,
        token,
        requestId: "r1",
        decision: "approved",
      }),
    ).rejects.toThrow(/no CRP account/i);

    // Nothing created, no number burned, no stray user document — so the admin
    // can retry once the applicant signs up.
    expect(authCalls).toHaveLength(0);
    expect(store.docs.get("meta/testerCounter")).toBeUndefined();
    expect([...store.docs.keys()].filter((k) => k.startsWith("users/"))).toHaveLength(0);
  });

  it("ignores a password sent by a stale admin dashboard", async () => {
    const token = await mintAdminToken();
    const result = await decideViaWorker({
      url: `${WORKER_ORIGIN}/accept`,
      token,
      requestId: "r1",
      decision: "approved",
      password: "admin-typed-password",
    });

    // Accepted as normal — the route no longer destructures `password`.
    expect(result.userId).toBe("uid-1");
    expect(authCalls).toHaveLength(0);
    // And it was not written anywhere the response or the store can see.
    const blob = JSON.stringify([...store.docs.entries()]);
    expect(blob).not.toContain("admin-typed-password");
  });

  it("does not clobber the user's other fields when promoting them", async () => {
    // The user document is shared with the main app, so this is the field that
    // matters most: a wallet reissue or a status change must not rewrite them.
    authUsers.set("alex@example.com", {
      localId: "uid-existing",
      email: "alex@example.com",
      displayName: "Alex M",
    });
    store.docs.set("users/uid-existing", {
      email: "alex@example.com",
      displayName: "Alex M",
      friends: ["f1", "f2"],
      friendRequests: ["f3"],
      lastLogin: "2026-09-30T14:57:01.000Z",
    });

    const token = await mintAdminToken();
    await decideViaWorker({
      url: `${WORKER_ORIGIN}/accept`,
      token,
      requestId: "r1",
      decision: "approved",

    });

    const user = store.docs.get("users/uid-existing");
    expect(user.friends).toEqual(["f1", "f2"]);
    expect(user.friendRequests).toEqual(["f3"]);
    expect(user.lastLogin).toBe("2026-09-30T14:57:01.000Z");
    expect(user.displayName).toBe("Alex M");
    // ...and the tester map is there alongside them.
    expect(user.tester.testerNumber).toBe(1);
    expect(user.tester.wallet.lastIssuedAt).toBeTruthy();
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
      const email = `p${i + 1}@example.com`;
      store.docs.set(`requests/r${i + 1}`, {
        name: `P${i + 1}`,
        email,
        status: "pending",
      });
      // Each of these applicants created their own account at signup too.
      authUsers.set(email, {
        localId: `uid-p${i + 1}`,
        email,
        displayName: `P${i + 1}`,
        emailVerified: false,
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
    // Those two applicants also created their own accounts at signup.
    for (const [email, name] of [["b@example.com", "B"], ["c@example.com", "C"]]) {
      authUsers.set(email, { localId: `uid-${email}`, email, displayName: name });
    }

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
    expect([...store.docs.keys()].filter((k) => k.startsWith("users/"))).toHaveLength(0);
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
    expect([...store.docs.keys()].filter((k) => k.startsWith("users/"))).toHaveLength(0);
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
    expect([...store.docs.keys()].filter((k) => k.startsWith("users/"))).toHaveLength(0);
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
    expect(await store.list("users")).toHaveLength(0);
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

    // The tester is a map on the user document, addressed by the Auth uid.
    const user = await store.get("users", body.userId);
    expect(user.tester.status).toBe("accepted");
    expect(user.tester.active).toBe(true);
    expect(user.tester.testerNumber).toBe(1);
    expect(user.tester.wallet.classId).toBe("3388000000023210330.crp_tester_loyalty");
    // And the user document carries the fields this project owns.
    expect(user.email).toBe("alex@example.com");
    expect(user.displayName).toBe("Alex Morgan");

    // Request fields preserved, tester linked.
    const request = await store.get("requests", "r1");
    expect(request.name).toBe("Alex Morgan");
    expect(request.email).toBe("alex@example.com");
    expect(request.createdAt).toBe("2026-09-01T00:00:00.000Z");
    expect(request.status).toBe("approved");
    expect(request.testerId).toBe("t_r1");
    expect(request.userId).toBe(body.userId);
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

    expect(await store.list("users")).toHaveLength(1);
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

  // The tester is a map on the user document, so the wallet route is addressed
  // by Auth uid. The `t_r1` id lives inside the map and is what the Wallet
  // object id is still derived from.
  const seedTester = (over = {}) =>
    store.docs.set("users/uid-1", {
      email: "alex@example.com",
      friends: ["f1"],
      tester: {
        id: "t_r1",
        requestId: "r1",
        name: "Alex Morgan",
        email: "alex@example.com",
        status: "accepted",
        active: true,
        testerNumber: 1,
        ...over,
      },
    });

  it("replaces the undeployed issueWalletPass Cloud Function", async () => {
    seedTester();
    const token = await mintAdminToken();
    const res = await postWallet(token, { userId: "uid-1" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.saveUrl).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    expect(body.active).toBe(true);
    expect(body.testerId).toBe("t_r1");
  });

  it("writes only tester.wallet, leaving the user's other fields alone", async () => {
    seedTester();
    const token = await mintAdminToken();
    await postWallet(token, { userId: "uid-1" });

    const user = store.docs.get("users/uid-1");
    // The masked path is the whole point: a wallet reissue must not rewrite the
    // rest of a document the main app also owns.
    expect(user.friends).toEqual(["f1"]);
    expect(user.email).toBe("alex@example.com");
    expect(user.tester.testerNumber).toBe(1);
    expect(user.tester.wallet.lastIssuedAt).toBeTruthy();
    expect(user.tester.wallet.accountId).toBe("CRP-R1");
  });

  it("signs with the Wallet key and the existing tester number", async () => {
    seedTester();
    const token = await mintAdminToken();
    const res = await postWallet(token, { userId: "uid-1" });
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
    const first = await (await postWallet(token, { userId: "uid-1" })).json();
    const second = await (await postWallet(token, { userId: "uid-1" })).json();

    const objectId = (u) =>
      JSON.parse(Buffer.from(u.split("/").pop().split(".")[1], "base64url").toString())
        .payload.loyaltyObjects[0].id;

    // Derived from the tester id stored inside the map, so a reissue updates one
    // object — the restructure does not mint a second pass for existing testers.
    expect(objectId(first.saveUrl)).toBe(objectId(second.saveUrl));
    expect(objectId(first.saveUrl)).toBe("3388000000023210330.crp_tester_loyalty_t_r1");
    expect([...store.docs.keys()].filter((k) => k.startsWith("users/"))).toEqual(["users/uid-1"]);
  });

  it("issues a REVOKED card for an inactive tester", async () => {
    seedTester({ status: "revoked", active: false });
    const token = await mintAdminToken();
    const res = await postWallet(token, { userId: "uid-1" });
    const { saveUrl, active } = await res.json();

    expect(active).toBe(false);
    const claims = JSON.parse(Buffer.from(saveUrl.split("/").pop().split(".")[1], "base64url").toString());
    expect(claims.payload.loyaltyObjects[0].state).toBe("REVOKED");
  });

  it("404s a user who is not a tester", async () => {
    // Removed from the programme: no `tester` map, so there is no card to issue.
    store.docs.set("users/uid-1", { email: "alex@example.com", testerHistory: [] });
    const token = await mintAdminToken();
    const res = await postWallet(token, { userId: "uid-1" });
    expect(res.status).toBe(404);
  });

  it("requires the admin claim", async () => {
    seedTester();
    // A valid token that is not staff.
    const nonAdmin = await mintAdminToken({ admin: false });
    const res = await postWallet(nonAdmin, { userId: "uid-1" });
    expect(res.status).toBe(403);

    const anon = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/tester-wallet`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ userId: "uid-1" }),
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
        body: JSON.stringify({ userId: "uid-1" }),
      }),
      env,
    );
    expect(wrongOrigin.status).toBe(403);

    const missing = await postWallet(token, { userId: "does-not-exist" });
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



