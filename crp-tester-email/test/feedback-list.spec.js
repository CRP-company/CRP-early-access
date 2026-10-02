/**
 * Regression test for the reported dashboard failure:
 *
 *   "Response to preflight request doesn't pass access control check:
 *    No 'Access-Control-Allow-Origin' header is present"
 *
 * That message was not a header bug. The route threw on a reference to a
 * `TESTERS` constant that the refactor had already removed, so the request never
 * reached the CORS-aware error path and the browser saw a bare failure. A throw
 * anywhere on a route must still produce a readable, CORS-bearing response —
 * otherwise every internal error becomes an unexplainable CORS complaint.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { webcrypto } from "node:crypto";

const ORIGIN = "https://crp-company.github.io";
const WORKER_ORIGIN = "https://crp-tester-email.example.workers.dev";
const PROJECT = "crp-cuby-display";

const env = {
  RESEND_API_KEY: "re_test",
  ALLOWED_ORIGINS: ORIGIN,
  FIREBASE_PROJECT_ID: PROJECT,
  // Filled in beforeEach with a real key, so the OAuth assertion genuinely runs
  // rather than being stubbed past.
  FIREBASE_SERVICE_ACCOUNT_JSON: "",
  ADMIN_EMAILS: "staff@crp.com",
};

/**
 * In-memory store covering the whole `users/{uid}/feedback` shape the route now
 * walks: the account, its tester map, and the feedback under it.
 */
function fakeStore() {
  const docs = new Map([
    [
      "users/uid_1",
      {
        email: "alex@example.com",
        displayName: "Alex Morgan",
        updateTime: "v1",
        tester: {
          id: "t_1",
          userId: "uid_1",
          name: "Alex Morgan",
          email: "alex@example.com",
          testerNumber: 4,
          status: "accepted",
          active: true,
        },
      },
    ],
    [
      "users/uid_1/feedback/fb1",
      {
        title: "Add a dark mode",
        body: "The display is bright at night.",
        area: "app",
        status: "submitted",
        period: "2026-09",
        email: "alex@example.com",
        createdAt: "2026-09-20T10:00:00.000Z",
        updateTime: "v2",
      },
    ],
  ]);

  return {
    docs,
    async getDocument(c, id) {
      const d = docs.get(`${c}/${id}`);
      return d ? { ...d, exists: true } : null;
    },
    async createDocument(c, id, data) {
      docs.set(`${c}/${id}`, { ...data, updateTime: `v${docs.size + 1}` });
    },
    async updateDocument(c, id, data) {
      const k = `${c}/${id}`;
      if (docs.has(k)) docs.set(k, { ...docs.get(k), ...data });
    },
    async listCollection(c) {
      // Only direct children: a listing must not return the feedback too.
      return [...docs.entries()]
        .filter(([k]) => k.startsWith(`${c}/`) && !k.slice(`${c}/`.length).includes("/"))
        .map(([k, v]) => ({ id: k.split("/").pop(), ...v }));
    },
    async listSubcollection(parent, name) {
      const prefix = `${parent}/${name}/`;
      return [...docs.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ id: k.split("/").pop(), ...v }));
    },
  };
}

let worker;
let store;
let keyPair;

vi.stubGlobal("crypto", webcrypto);

const b64url = (b) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Plain JS -> Firestore field-value form, as the REST client expects on reads. */
function encode(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return { integerValue: String(value) };
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  return { mapValue: { fields: encodeFields(value) } };
}

function encodeFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "updateTime") continue;
    out[k] = encode(v);
  }
  return out;
}

beforeEach(async () => {
  worker = (await import("../src/index.js")).default;
  store = fakeStore();
  // Each test mints a NEW keypair, and auth.js caches Google's signing keys for
  // an hour per isolate. Without this reset the cache holds the first test's key
  // and every later token fails signature verification with a 401.
  (await import("../src/auth.js")).__resetKeyCache();
  (await import("../src/oauth.js")).__resetTokenCache();
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

  // A genuine PKCS#8 PEM for the service account. oauth.js signs a real JWT
  // assertion with it before asking Google's token endpoint for a bearer token;
  // a placeholder here would throw before the request was ever made.
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    type: "service_account",
    project_id: PROJECT,
    client_email: "worker@crp-cuby-display.iam.gserviceaccount.com",
    private_key:
      "-----BEGIN PRIVATE KEY-----\n" +
      Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n").trim() +
      "\n-----END PRIVATE KEY-----\n",
  });

  vi.stubGlobal("fetch", async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input.url || input);
    if (url.includes("robot/v1/metadata/x509")) {
      const spki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
      return new Response(
        JSON.stringify({
          k1:
            "-----BEGIN CERTIFICATE-----\n" +
            Buffer.from(spki).toString("base64").replace(/(.{64})/g, "$1\n").trim() +
            "\n-----END CERTIFICATE-----\n",
        }),
        { status: 200 },
      );
    }
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "stub", expires_in: 3600 }), {
        status: 200,
      });
    }

    // Firestore REST. Only the listing calls are exercised by this route.
    if (url.includes("/documents/")) {
      const pathname = new URL(url).pathname;
      const path = pathname.slice(pathname.lastIndexOf("/documents/") + "/documents/".length);
      if (path.includes(":")) return new Response("{}", { status: 200 });

      // Firestore addresses a subcollection listing as `users/uid_1/feedback`
      // (an ODD segment count, no trailing slash) and a document as
      // `users/uid_1` (even). This parity rule is the same one Firestore itself
      // uses, and getting it backwards 404s the listing.
      const segments = path.split("/").filter(Boolean);
      const c = segments[0];
      const isListing = (init.method || "GET") === "GET" && segments.length % 2 === 1;

      if (isListing) {
        const prefix =
          segments.length === 1 ? `${c}/` : `${c}/${segments.slice(1).join("/")}/`;
        const docs = [...store.docs.entries()]
          .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
          .map(([k, v]) => ({ name: `${k}`, fields: encodeFields(v) }));
        return new Response(JSON.stringify({ documents: docs }), { status: 200 });
      }

      const id = segments.slice(1).join("/");
      const d = store.docs.get(`${c}/${id}`);
      if (!d) return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
      return new Response(
        JSON.stringify({ name: `${c}/${id}`, fields: encodeFields(d), updateTime: d.updateTime }),
        { status: 200 },
      );
    }

    throw new Error("unexpected fetch: " + url);
  });
});

/** A genuine admin ID token, so signature verification really runs. */
async function token(over = {}) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
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

const post = (authToken) =>
  worker.fetch(
    new Request(`${WORKER_ORIGIN}/feedback-list`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({}),
    }),
    env,
  );

describe("/feedback-list CORS", () => {
  it("answers the preflight with the origin echoed back", async () => {
    const res = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/feedback-list`, {
        method: "OPTIONS",
        headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" },
      }),
      env,
    );

    expect(res.status).toBe(204);
    // The two things the browser checks before it will send the POST at all.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("returns the feedback with CORS headers on the real POST", async () => {
    const res = await post(await token());

    // This is the assertion that would have caught the reported bug: the route
    // threw on a reference to the removed `TESTERS` constant, and the resulting
    // 500 carried no origin header, so the browser reported a CORS failure.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.feedback).toHaveLength(1);
    expect(body.feedback[0].title).toBe("Add a dark mode");
    // Annotated from the user document, since the stored entry only names its owner.
    expect(body.feedback[0].testerName).toBe("Alex Morgan");
    expect(body.feedback[0].testerNumber).toBe(4);
    expect(body.feedback[0].userId).toBe("uid_1");
  });

  it("does not hand feedback to a non-admin", async () => {
    const res = await post(
      await token({ sub: "someone-uid", user_id: "someone-uid", admin: false }),
    );

    expect(res.status).toBe(403);
    // Even a refusal needs the header, or the dashboard shows a CORS error
    // instead of the actual reason it was refused.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("returns an empty list rather than erroring when nobody has feedback", async () => {
    store.docs.delete("users/uid_1/feedback/fb1");

    const res = await post(await token());
    expect(res.status).toBe(200);
    expect((await res.json()).feedback).toEqual([]);
  });
});
