import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { webcrypto as crypto } from "node:crypto";
import { requireAdmin, AuthError, __resetKeyCache } from "../src/auth.js";
import {
  STATUS,
  ALL_STATUSES,
  isValidStatus,
  activeForStatus,
  allocateTesterNumber,
  META_COLLECTION,
  COUNTER_DOC,
} from "../src/tester-lifecycle.js";
import { encodeFields, decodeFields } from "../src/firestore-rest.js";

/**
 * In-memory stand-in for the Firestore REST client, modelling the one behaviour
 * that matters for correctness: `createDocument` throws a 409 when the document
 * already exists, exactly as `currentDocument.exists=false` does in production.
 *
 * Deliberately does NOT serialise reads and writes, so concurrent allocations
 * genuinely interleave. That is what makes the duplicate-number test meaningful.
 */
function memoryStore(seed = {}) {
  const docs = new Map();
  let version = 0;
  const bump = () => `v${(version += 1)}`;

  for (const [k, v] of Object.entries(seed)) docs.set(k, { ...v, updateTime: bump() });

  const stats = { creates: 0, updates: 0 };

  return {
    docs,
    stats,
    async getDocument(collection, id) {
      const doc = docs.get(`${collection}/${id}`);
      return doc ? { ...doc, exists: true } : null;
    },
    async createDocument(collection, id, data) {
      const key = `${collection}/${id}`;
      if (docs.has(key)) {
        // currentDocument.exists=false -> 409
        const err = new Error("already exists");
        err.status = 409;
        throw err;
      }
      stats.creates += 1;
      docs.set(key, { ...data, updateTime: bump() });
      return true;
    },
    async updateDocument(collection, id, data, options = {}) {
      const key = `${collection}/${id}`;
      const current = docs.get(key);
      if (!current) {
        const err = new Error("not found");
        err.status = 409;
        throw err;
      }
      // currentDocument.updateTime -> 409 when the doc changed since the read.
      // Without this branch the stub would pass a broken implementation.
      if (options.updateTime && options.updateTime !== current.updateTime) {
        const err = new Error("precondition failed");
        err.status = 409;
        throw err;
      }
      stats.updates += 1;
      docs.set(key, { ...current, ...data, updateTime: bump() });
      return true;
    },
    async listCollection(collection) {
      return [...docs.entries()]
        .filter(([k]) => k.startsWith(`${collection}/`))
        .map(([k, v]) => ({ id: k.split("/").pop(), ...v }));
    },
  };
}

afterEach(() => vi.restoreAllMocks());

/* ------------------------------------------------------------------ *
 * Auth: the security boundary
 *
 * These mint a genuine RSA key pair and sign genuine tokens, so signature
 * verification is really exercised rather than stubbed. The Worker writes with
 * a service account that bypasses security rules, so this check is the only
 * thing preventing an anonymous POST from promoting itself.
 * ------------------------------------------------------------------ */

const PROJECT = "crp-cuby-display";
const KID = "test-key-1";

let keyPair;

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Sign a JWT with the test private key. */
async function mintToken(claims, { key = keyPair.privateKey, kid = KID } = {}) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const payload = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

const adminClaims = (over = {}) => ({
  iss: `https://securetoken.google.com/${PROJECT}`,
  aud: PROJECT,
  sub: "uid-123",
  user_id: "uid-123",
  email: "staff@crp.com",
  admin: true,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...over,
});

const authRequest = (token) =>
  new Request("https://worker.test/accept", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

describe("requireAdmin", () => {
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

    // Serve our own public key in the shape Google's x509 endpoint uses.
    const spki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    const pem =
      "-----BEGIN CERTIFICATE-----\n" +
      Buffer.from(spki).toString("base64").replace(/(.{64})/g, "$1\n").trim() +
      "\n-----END CERTIFICATE-----\n";

    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ [KID]: pem }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    __resetKeyCache();
  });

  it("accepts a validly signed token carrying the admin claim", async () => {
    const token = await mintToken(adminClaims());
    const admin = await requireAdmin(authRequest(token), PROJECT);
    expect(admin).toEqual({ uid: "uid-123", email: "staff@crp.com" });
  });

  it("rejects a token without a bearer header", async () => {
    await expect(
      requireAdmin(new Request("https://worker.test/accept"), PROJECT),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a malformed token", async () => {
    await expect(requireAdmin(authRequest("not.a.jwt"), PROJECT)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects a token signed by a different key", async () => {
    // The critical forgery case: right claims, wrong signature.
    const other = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const token = await mintToken(adminClaims(), { key: other.privateKey });
    await expect(requireAdmin(authRequest(token), PROJECT)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects a correctly signed token that lacks the admin claim", async () => {
    const token = await mintToken(adminClaims({ admin: false }));
    await expect(requireAdmin(authRequest(token), PROJECT)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects an expired token", async () => {
    const token = await mintToken(adminClaims({ exp: Math.floor(Date.now() / 1000) - 60 }));
    await expect(requireAdmin(authRequest(token), PROJECT)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects a token minted for a different Firebase project", async () => {
    const token = await mintToken(adminClaims({ aud: "someone-else" }));
    await expect(requireAdmin(authRequest(token), PROJECT)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects a token from an unexpected issuer", async () => {
    const token = await mintToken(adminClaims({ iss: "https://evil.example" }));
    await expect(requireAdmin(authRequest(token), PROJECT)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects a non-RS256 algorithm", async () => {
    // Guards against alg=none / algorithm-substitution attacks.
    const header = b64url(JSON.stringify({ alg: "none", kid: KID }));
    const payload = b64url(JSON.stringify(adminClaims()));
    await expect(
      requireAdmin(authRequest(`${header}.${payload}.`), PROJECT),
    ).rejects.toMatchObject({ status: 401 });
  });
});

/* ------------------------------------------------------------ vocabulary */

describe("status vocabulary", () => {
  it("contains exactly the four documented statuses", () => {
    expect([...ALL_STATUSES].sort()).toEqual([
      "accepted",
      "pending",
      "rejected",
      "revoked",
    ]);
  });

  it("rejects anything outside the set", () => {
    for (const bad of ["approved", "ACTIVE", "", null, undefined, 1]) {
      expect(isValidStatus(bad)).toBe(false);
    }
  });

  it("maps only accepted to active true", () => {
    // The invariant that stops status and active from drifting.
    expect(activeForStatus(STATUS.ACCEPTED)).toBe(true);
    for (const s of [STATUS.PENDING, STATUS.REJECTED, STATUS.REVOKED]) {
      expect(activeForStatus(s)).toBe(false);
    }
  });
});

/* ------------------------------------------------------ field encoding */

describe("field encoding", () => {
  it("round-trips the value types the tester document uses", () => {
    const original = {
      name: "Alex Morgan",
      email: "alex@example.com",
      active: true,
      testerNumber: 42,
      deactivatedAt: null,
      nested: { period: "2026-09", comments: 3 },
      list: ["a", "b"],
    };
    expect(decodeFields(encodeFields(original))).toEqual(original);
  });

  it("encodes integers as decimal strings", () => {
    // Not base64-protobuf: the REST API wants an int64 as a string.
    expect(encodeFields({ testerNumber: 7 }).testerNumber).toEqual({
      integerValue: "7",
    });
  });

  it("distinguishes null from undefined", () => {
    expect(encodeFields({ a: null })).toEqual({ a: { nullValue: null } });
    expect(encodeFields({ a: undefined })).toEqual({});
  });

  it("rejects non-finite numbers rather than writing garbage", () => {
    expect(() => encodeFields({ n: NaN })).toThrow();
    expect(() => encodeFields({ n: Infinity })).toThrow();
  });

  it("encodes dates as RFC3339 timestamps", () => {
    const when = new Date("2026-09-29T10:00:00.000Z");
    expect(encodeFields({ at: when }).at).toEqual({
      timestampValue: "2026-09-29T10:00:00.000Z",
    });
  });
});

/* --------------------------------------------------- number allocation */

describe("allocateTesterNumber", () => {
  it("returns 1 when the counter does not exist yet", async () => {
    const store = memoryStore();
    expect(await allocateTesterNumber(store)).toBe(1);
  });

  it("increments from the stored value", async () => {
    const store = memoryStore({ [`${META_COLLECTION}/${COUNTER_DOC}`]: { lastNumber: 41 } });
    expect(await allocateTesterNumber(store)).toBe(42);
  });

  it("never hands out the same number twice under concurrency", async () => {
    // The property that matters. The naive version fails this: 25 concurrent
    // calls all return 1.
    const store = memoryStore();
    const numbers = await Promise.all(
      Array.from({ length: 25 }, () => allocateTesterNumber(store)),
    );

    const unique = new Set(numbers);
    expect(unique.size, `duplicates: ${numbers.join(",")}`).toBe(25);
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
  });

  it("refuses to build on a corrupt counter", async () => {
    // Otherwise every future number descends from junk.
    const store = memoryStore({ [`${META_COLLECTION}/${COUNTER_DOC}`]: { lastNumber: "five" } });
    await expect(allocateTesterNumber(store)).rejects.toThrow(/corrupt/);
  });

  it("gives up with a clear error after repeated contention", async () => {
    const store = memoryStore();
    // Always 409, as if another writer kept winning the race.
    store.createDocument = async () => {
      const e = new Error("busy");
      e.status = 409;
      throw e;
    };
    store.getDocument = async () => null;
    await expect(allocateTesterNumber(store)).rejects.toThrow(/attempts/);
  });
});
