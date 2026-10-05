/**
 * Regression: POST /feedback must persist every validated field.
 *
 * The bug: `validateFeedback()` returns a WRAPPER, `{ ok, value }`, but the route
 * passed the wrapper itself to `buildFeedbackDoc()`, which reads the fields off
 * its argument. Every one of them was therefore `undefined`, and `encodeFields`
 * drops `undefined` silently — so the document was written with only
 * testerId / email / createdAt / updatedAt. title, body, area, status and period
 * were never stored, which left BOTH dashboards rendering a blank request and the
 * monthly counter stuck at zero (it counts documents carrying `period`).
 *
 * This spec drives the real route over the real wire — the request is encoded,
 * sent, decoded and stored exactly as Firestore would see it — then asserts the
 * stored document itself. Asserting on the response alone would have passed
 * throughout the bug: the route answered 201 either way.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { webcrypto } from "node:crypto";
import { hashEmail } from "../src/tester-portal.js";
import indexSource from "../src/index.js?raw";

const ORIGIN = "https://crp-company.github.io";
const WORKER_ORIGIN = "https://crp-tester-email.example.workers.dev";
const PROJECT = "crp-cuby-display";
const EMAIL = "alex@example.com";
const UID = "uid_1";

const env = {
  RESEND_API_KEY: "re_test",
  ALLOWED_ORIGINS: ORIGIN,
  FIREBASE_PROJECT_ID: PROJECT,
  FIREBASE_SERVICE_ACCOUNT_JSON: "",
  ADMIN_EMAILS: "staff@crp.com",
};

/** Firestore field-value form -> plain JS, the inverse of the worker's encoder. */
function decodeFields(fields) {
  const out = {};
  for (const [k, f] of Object.entries(fields || {})) {
    if ("stringValue" in f) out[k] = f.stringValue;
    else if ("booleanValue" in f) out[k] = f.booleanValue;
    else if ("integerValue" in f) out[k] = Number(f.integerValue);
    else if ("doubleValue" in f) out[k] = Number(f.doubleValue);
    else if ("nullValue" in f) out[k] = null;
    else if ("timestampValue" in f) out[k] = f.timestampValue;
    else if ("arrayValue" in f) out[k] = f.arrayValue.values.map(decodeField);
    else if ("mapValue" in f) out[k] = decodeFields(f.mapValue.fields);
  }
  return out;
}
function decodeField(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return decodeFields(v.mapValue.fields);
  return v;
}

function encode(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  return { mapValue: { fields: encodeFields(value) } };
}
function encodeFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "updateTime" || v === undefined) continue;
    out[k] = encode(v);
  }
  return out;
}

/** The store the wire-level fake writes into, and the route reads from. */
let store;
let worker;
let keyPair;

vi.stubGlobal("crypto", webcrypto);

const b64url = (b) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

beforeEach(async () => {
  worker = (await import("../src/index.js")).default;
  // The roster the route resolves: testerIndex pointer -> users doc with a
  // tester map, exactly as acceptance leaves it.
  store = new Map([
    [
      `testerIndex/${await hashEmail(EMAIL)}`,
      { userId: UID },
    ],
    [
      `users/${UID}`,
      {
        email: EMAIL,
        displayName: "Alex Morgan",
        updateTime: "v1",
        tester: {
          id: "t_1",
          userId: UID,
          name: "Alex Morgan",
          email: EMAIL,
          testerNumber: 4,
          status: "accepted",
          active: true,
        },
      },
    ],
  ]);

  (await import("../src/auth.js")).__resetKeyCache();
  (await import("../src/oauth.js")).__resetTokenCache();

  keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
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
      return new Response(JSON.stringify({ access_token: "stub", expires_in: 3600 }), { status: 200 });
    }

    if (url.includes("/documents/")) {
      const pathname = new URL(url).pathname;
      const path = pathname.slice(pathname.lastIndexOf("/documents/") + "/documents/".length);
      if (path.includes(":")) return new Response("{}", { status: 200 });
      const key = path.replace(/\/$/, "");
      const method = (init.method || "GET").toUpperCase();

      // Writes. Decoding the request body is the point: it proves what actually
      // reaches Firestore, rather than what the route believed it was sending.
      if (method === "PATCH" || method === "POST") {
        const body = JSON.parse(init.body || "{}");
        store.set(key, { ...decodeFields(body.fields), updateTime: `v${store.size + 1}` });
        return new Response(JSON.stringify({ name: key, fields: body.fields }), { status: 200 });
      }
      if (method === "DELETE") {
        store.delete(key);
        return new Response("{}", { status: 200 });
      }

      const segments = key.split("/").filter(Boolean);
      const isListing = method === "GET" && segments.length % 2 === 1;
      if (isListing) {
        const prefix = segments.length === 1 ? `${segments[0]}/` : `${key}/`;
        const documents = [...store.entries()]
          .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
          .map(([k, v]) => ({ name: k, fields: encodeFields(v) }));
        return new Response(JSON.stringify({ documents }), { status: 200 });
      }

      const d = store.get(key);
      if (!d) return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
      return new Response(
        JSON.stringify({ name: key, fields: encodeFields(d), updateTime: d.updateTime }),
        { status: 200 },
      );
    }

    throw new Error("unexpected fetch: " + url);
  });
});

/** A genuine tester ID token, so signature verification really runs. */
async function token(over = {}) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
  const payload = b64url(
    JSON.stringify({
      iss: `https://securetoken.google.com/${PROJECT}`,
      aud: PROJECT,
      sub: UID,
      user_id: UID,
      email: EMAIL,
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

const post = (authToken, body) =>
  worker.fetch(
    new Request(`${WORKER_ORIGIN}/feedback`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
    }),
    env,
  );

const VALID = {
  title: "Add a dark mode",
  body: "The display is bright at night in the car.",
  area: "app",
};

/** The single feedback document the route wrote. */
const stored = () => {
  const entry = [...store.entries()].find(([k]) => k.startsWith(`users/${UID}/feedback/`));
  return entry ? { key: entry[0], ...entry[1] } : null;
};

describe("POST /feedback persistence", () => {
  it("writes every validated field to the document", async () => {
    const res = await post(await token(), VALID);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ ok: true });

    const doc = stored();
    expect(doc).not.toBeNull();

    // The fields the tester typed — the ones that rendered blank.
    expect(doc.title).toBe(VALID.title);
    expect(doc.body).toBe(VALID.body);
    expect(doc.area).toBe(VALID.area);

    // The fields the dashboard depends on.
    expect(doc.status).toBe("submitted");
    expect(doc.period).toMatch(/^\d{4}-\d{2}$/);
    expect(doc.testerId).toBe("t_1");
    expect(doc.email).toBe(EMAIL);
    expect(doc.createdAt).toBeTruthy();
    expect(doc.updatedAt).toBeTruthy();
  });

  it("returns the period in the 201 response", async () => {
    // The client treats this as authoritative and re-reads; an undefined period
    // here is the same defect showing up in the reply.
    const res = await post(await token(), VALID);
    const body = await res.json();
    expect(body.period).toMatch(/^\d{4}-\d{2}$/);
    expect(body.id).toBeTruthy();
  });

  it("counts the new document in this month's activity", async () => {
    // The counter is `history.filter(f => f.period === period).length`, so a
    // missing period is exactly what kept the dashboard at "2 more this month".
    await post(await token(), VALID);
    const period = stored().period;
    expect(period).toBeTruthy();

    const history = [stored()];
    const current = period;
    expect(history.filter((f) => f.period === current).length).toBe(1);
  });

  it("stores the document under the tester's own user id", async () => {
    await post(await token(), VALID);
    expect(stored().key.startsWith(`users/${UID}/feedback/`)).toBe(true);
  });

  it("still validates, and refuses a revoked tester", async () => {
    // The fix must not have loosened anything the route already rejected.
    const bad = await post(await token(), { ...VALID, title: "no" });
    expect(bad.status).toBe(400);

    store.set(`users/${UID}`, {
      ...store.get(`users/${UID}`),
      tester: { ...store.get(`users/${UID}`).tester, status: "revoked", active: false },
    });
    const revoked = await post(await token(), VALID);
    expect(revoked.status).toBe(403);
  });
});

/**
 * Guard against the wrapper being passed again.
 *
 * `validateFeedback()` returns `{ ok, value }`. Passing that wrapper where the
 * inner `value` is expected silently yields undefined for every field, and
 * `encodeFields` drops undefined without complaint — so the route still answers
 * 201 and writes a plausible-looking document. The behavioural test above is what
 * catches it; this pins the specific expression so the mistake is obvious in a
 * diff and cannot reappear via a refactor that "tidies" the call.
 */
describe("the /feedback route unwraps the validator result", () => {
  it("passes validated.value to buildFeedbackDoc, not the wrapper", () => {
    expect(indexSource).toMatch(/buildFeedbackDoc\(\s*validated\.value\s*,/);
    expect(indexSource).not.toMatch(/buildFeedbackDoc\(\s*validated\s*,/);
  });

  it("keeps validating before building, so no unvalidated data is stored", () => {
    const validateAt = indexSource.indexOf("const validated = validateFeedback(body)");
    const buildAt = indexSource.indexOf("buildFeedbackDoc(validated.value");
    expect(validateAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(validateAt);
  });
});
