/**
 * Decision-flow tests: rejection, approval, Wallet, and the decision emails.
 *
 * These cover the end-to-end requirements for /accept:
 *   - rejection updates status and emails, creates no tester, burns no number
 *   - approval creates the tester, allocates a number, issues a Wallet pass
 *     and emails the applicant with the number and an Add-to-Wallet link
 *   - a duplicate approval is refused before allocating anything
 *   - rejection never touches Wallet
 *   - the request document keeps every field it had before the decision
 *   - rejection releases only its own email marker; approved/inactive markers
 *     remain so duplicate applications stay blocked
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { decideRequest, setTesterStatus, removeTester } from "../src/accept.js";
import { META_COLLECTION, COUNTER_DOC } from "../src/tester-lifecycle.js";
import { buildAcceptanceEmail, buildRejectionEmail } from "../src/decision-emails.js";
import { buildSaveUrl, accountIdFor, ISSUER_ID, CLASS_ID } from "../src/wallet.js";

// Vite inlines these as strings at build time. The Workers test runtime has no
// filesystem, so readFileSync is not available here.
// eslint-disable-next-line import/extensions
import adminSource from "../../admin/js/admin.js?raw";
// eslint-disable-next-line import/extensions
import indexSource from "../src/index.js?raw";

/** Minimal in-memory store with the preconditions decideRequest relies on. */
function memoryStore(seed = {}) {
  const docs = new Map();
  let version = 0;
  const bump = () => `v${(version += 1)}`;
  for (const [k, v] of Object.entries(seed)) docs.set(`${k}`, { ...v, updateTime: bump() });

  return {
    docs,
    async getDocument(c, id) {
      const d = docs.get(`${c}/${id}`);
      return d ? { ...d, exists: true } : null;
    },
    async createDocument(c, id, data) {
      const key = `${c}/${id}`;
      if (docs.has(key)) {
        const e = new Error("exists");
        e.status = 409;
        throw e;
      }
      docs.set(key, { ...data, updateTime: bump() });
      return true;
    },
    async updateDocument(c, id, data, options = {}) {
      const key = `${c}/${id}`;
      const cur = docs.get(key);
      if (!cur || (options.updateTime && options.updateTime !== cur.updateTime)) {
        const e = new Error("precondition");
        e.status = 409;
        throw e;
      }
      // Merge, mirroring the updateMask behaviour of the REST client.
      docs.set(key, { ...cur, ...data, updateTime: bump() });
      return true;
    },
    async rejectRequestAndReleaseMarker({ requestId, requestUpdateTime, patch, markerCollection, markerId }) {
      const requestKey = `requests/${requestId}`;
      const request = docs.get(requestKey);
      if (!request || request.updateTime !== requestUpdateTime) {
        const e = new Error("precondition");
        e.status = 409;
        throw e;
      }

      const markerKey = `${markerCollection}/${markerId}`;
      const marker = docs.get(markerKey);
      const released = marker?.requestId === requestId;
      docs.set(requestKey, { ...request, ...patch, updateTime: bump() });
      if (released) docs.delete(markerKey);
      return { released };
    },
    async releaseRejectedRequestMarker({ requestId, markerCollection, markerId }) {
      const request = docs.get(`requests/${requestId}`);
      if (!request || request.status !== "rejected") {
        const e = new Error("request is no longer rejected");
        e.status = 409;
        throw e;
      }
      const markerKey = `${markerCollection}/${markerId}`;
      const marker = docs.get(markerKey);
      const released = marker?.requestId === requestId;
      if (released) docs.delete(markerKey);
      return { released };
    },
    async listCollection(c) {
      return [...docs.entries()]
        .filter(([k]) => k.startsWith(`${c}/`))
        .map(([k, v]) => ({ id: k.split("/").pop(), ...v }));
    },

    /** Merge into `tester.<key>`, mirroring the real masked update. */
    async patchTester(c, id, patch) {
      const key = `${c}/${id}`;
      const cur = docs.get(key);
      if (!cur) {
        const e = new Error("precondition");
        e.status = 409;
        throw e;
      }
      const tester = { ...(cur.tester || {}) };
      for (const [k, v] of Object.entries(patch)) tester[k] = v;
      docs.set(key, { ...cur, tester, updateTime: bump() });
      return true;
    },

    /**
     * Atomic move-to-history + marker release, mirroring firestore-rest.js.
     *
     * All-or-nothing on purpose: the whole point of the transaction is that a
     * partial remove is impossible. A stub that applied the writes one at a time
     * would let a broken implementation pass.
     *
     * Removal MOVES the tester — the snapshot goes onto `testerHistory` and the
     * `tester` map is deleted — so "in the programme" stays a field-existence
     * check with no flag left to drift.
     */
    async removeTesterToHistory({
      collection,
      id,
      archived,
      auditCollection,
      auditId,
      auditEntry,
      releaseCollection = null,
      releaseId = null,
      updateTime,
    }) {
      // Staged first, applied only once everything has been validated.
      const staged = [];
      const key = `${collection}/${id}`;
      const cur = docs.get(key);
      if (!cur) {
        const e = new Error("not found");
        e.status = 404;
        throw e;
      }
      if (updateTime && updateTime !== cur.updateTime) {
        const e = new Error("precondition");
        e.status = 409;
        throw e;
      }
      if (!cur.tester) {
        return { removed: true, alreadyRemoved: true };
      }

      const history = Array.isArray(cur.testerHistory) ? cur.testerHistory : [];
      const next = { ...cur, testerHistory: [...history, archived] };
      // An explicit null in the updateMask is how a field is deleted.
      delete next.tester;
      staged.push([key, { ...next, updateTime: bump() }]);

      const aKey = `${auditCollection}/${auditId}`;
      if (docs.has(aKey)) {
        // `create` fails on an existing id: a second history entry is impossible.
        const e = new Error("exists");
        e.status = 409;
        throw e;
      }
      staged.push([aKey, { ...auditEntry, updateTime: bump() }]);

      if (releaseCollection && releaseId) {
        // A delete of an absent document is a no-op, as in Firestore.
        const rKey = `${releaseCollection}/${releaseId}`;
        staged.push([rKey, null]);
      }

      for (const [k, v] of staged) {
        if (v === null) docs.delete(k);
        else docs.set(k, v);
      }
      return { removed: true };
    },
  };
}

const REQ = (over = {}) => ({
  name: "Alex Morgan",
  email: "alex@example.com",
  consent: true,
  status: "pending",
  source: "early-access-site",
  userAgent: "test-agent",
  website: "",
  experienceCategory: "developer",
  createdAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

const actor = { actorUid: "admin-1", actorEmail: "staff@crp.com" };

// The Auth layer is stubbed so these tests stay about Firestore behaviour and
// the emails. An approval resolves — and may create — the applicant's Firebase
// account, because the tester record is written to `users/{uid}`.
const authState = { existing: new Map(), created: [] };

vi.mock("../src/user-account.js", async () => {
  const actual = await vi.importActual("../src/user-account.js");
  return {
    ...actual,
    findUserByEmail: async (_sa, email) =>
      authState.existing.get(String(email).toLowerCase()) || null,
    createUser: async (_sa, { email, password, displayName }) => {
      const user = { uid: `uid-${authState.existing.size + 1}`, email, displayName };
      authState.existing.set(String(email).toLowerCase(), user);
      authState.created.push({ email, password });
      return user;
    },
  };
});

beforeEach(() => {
  authState.existing = new Map();
  authState.created = [];
});

async function markerKey(email) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A throwaway RSA key so Wallet signing is genuine, not stubbed. */
let keyPair;
let walletSecret;

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
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const b64 = Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n");
  walletSecret = JSON.stringify({
    type: "service_account",
    project_id: "crp-tester-card",
    client_email: "crp-tester-worker@crp-tester-card.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\n" + b64 + "\n-----END PRIVATE KEY-----\n",
  });
});

/** Capture every Resend call instead of sending. */
function stubResend({ ok = true } = {}) {
  const sent = [];
  vi.stubGlobal("fetch", async (url, init) => {
    if (String(url).includes("api.resend.com")) {
      sent.push({ url: String(url), init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: "resend-1" }), {
        status: ok ? 200 : 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error("unexpected fetch: " + url);
  });
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const env = () => ({
  RESEND_API_KEY: "re_test",
  CRP_EMAIL_FROM: "CRP Tester Program <testing@crp.company>",
  GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: walletSecret,
});

const counterValue = (s) => s.docs.get(`${META_COLLECTION}/${COUNTER_DOC}`)?.lastNumber;

describe("REJECTION", () => {
  it("sets the request to rejected and creates no tester", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    stubResend();

    const result = await decideRequest(store, {
      requestId: "r1",
      decision: "rejected",
      ...actor,
      env: env(),
    });

    expect(result.status).toBe("rejected");
    expect(store.docs.get("requests/r1").status).toBe("rejected");
    expect([...store.docs.keys()].some((k) => k.startsWith("users/"))).toBe(false);
  });

  it("does not consume a tester number", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    stubResend();

    await decideRequest(store, { requestId: "r1", decision: "rejected", ...actor, env: env() });

    // No counter document may be created, so the next approval still gets #1.
    expect(counterValue(store)).toBeUndefined();
    expect(store.docs.has(`${META_COLLECTION}/${COUNTER_DOC}`)).toBe(false);
  });

  it("sends a rejection email to the applicant", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    const sent = stubResend();

    const result = await decideRequest(store, {
      requestId: "r1",
      decision: "rejected",
      ...actor,
      env: env(),
    });

    expect(result.emailed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.to).toEqual(["alex@example.com"]);
    expect(sent[0].body.subject).toBe("CRP Testing Program — Application Update");
    expect(sent[0].body.html).toContain("weren't able to accept it at this time");
  });

  it("never includes a Wallet link in a rejection email", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    const sent = stubResend();

    await decideRequest(store, { requestId: "r1", decision: "rejected", ...actor, env: env() });

    const { html, text } = sent[0].body;
    expect(html).not.toContain("pay.google.com");
    expect(html).not.toContain("ADD TO GOOGLE WALLET");
    expect(text).not.toContain("pay.google.com");
  });

  it("generates no Wallet pass and writes no wallet field", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    stubResend();

    await decideRequest(store, { requestId: "r1", decision: "rejected", ...actor, env: env() });

    // No user document means no tester map, so no wallet metadata anywhere.
    for (const [key, doc] of store.docs) {
      if (key.startsWith("users/")) expect(doc.tester).toBeUndefined();
    }
  });

  it("preserves every pre-existing request field", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    stubResend();

    await decideRequest(store, { requestId: "r1", decision: "rejected", ...actor, env: env() });

    const doc = store.docs.get("requests/r1");
    for (const field of [
      "name",
      "email",
      "consent",
      "source",
      "userAgent",
      "website",
      "experienceCategory",
      "createdAt",
    ]) {
      expect(doc[field], field).toBe(REQ()[field]);
    }
    expect(doc.status).toBe("rejected");
    expect(doc.reviewedBy).toBe("admin-1");
    expect(doc.reviewedAt).toBeInstanceOf(Date);
  });

  it("releases only its own marker and permits a fresh request with the same email", async () => {
    const markerId = await markerKey("alex@example.com");
    const store = memoryStore({
      "requests/r1": REQ(),
      [`requestEmails/${markerId}`]: { requestId: "r1", createdAt: "2026-09-01T00:00:00.000Z" },
    });
    stubResend();

    const result = await decideRequest(store, {
      requestId: "r1",
      decision: "rejected",
      note: "Try again later",
      ...actor,
      env: env(),
    });

    expect(result.releasedMarker).toBe(true);
    expect(store.docs.has(`requestEmails/${markerId}`)).toBe(false);
    expect(store.docs.get("requests/r1")).toMatchObject({
      status: "rejected",
      note: "Try again later",
      name: "Alex Morgan",
      email: "alex@example.com",
      experienceCategory: "developer",
    });

    store.docs.set("requests/r2", REQ({ createdAt: new Date(), status: "pending" }));
    store.docs.set(`requestEmails/${markerId}`, {
      requestId: "r2",
      createdAt: "2026-09-29T00:00:00.000Z",
    });
    const retry = await decideRequest(store, {
      requestId: "r1",
      decision: "rejected",
      ...actor,
      env: env(),
    });
    expect(retry).toMatchObject({ status: "rejected", releasedMarker: false, emailed: false });
    expect(store.docs.get("requests/r1").status).toBe("rejected");
    expect(store.docs.get(`requestEmails/${markerId}`).requestId).toBe("r2");
  });

  it("retries a rejection without changing history or repeating audit/email", async () => {
    const markerId = await markerKey("alex@example.com");
    const store = memoryStore({
      "requests/r1": REQ(),
      [`requestEmails/${markerId}`]: { requestId: "r1" },
    });
    const sent = stubResend();

    await decideRequest(store, { requestId: "r1", decision: "rejected", ...actor, env: env() });
    const rejectedRequest = store.docs.get("requests/r1");
    const auditCount = [...store.docs.keys()].filter((key) => key.startsWith("audit/")).length;
    const retry = await decideRequest(store, {
      requestId: "r1",
      decision: "rejected",
      ...actor,
      env: env(),
    });

    expect(retry).toMatchObject({ status: "rejected", releasedMarker: false, emailed: false });
    expect(store.docs.get("requests/r1")).toEqual(rejectedRequest);
    expect([...store.docs.keys()].filter((key) => key.startsWith("audit/"))).toHaveLength(auditCount);
    expect(sent).toHaveLength(1);
  });

  it("recovers an exact-owned marker left by an earlier rejection without editing the request", async () => {
    const markerId = await markerKey("alex@example.com");
    const store = memoryStore({
      "requests/r1": REQ({
        status: "rejected",
        note: "Original review",
        reviewedAt: "2026-09-02T00:00:00.000Z",
      }),
      [`requestEmails/${markerId}`]: { requestId: "r1" },
    });
    const rejectedRequest = store.docs.get("requests/r1");
    const sent = stubResend();

    const result = await decideRequest(store, {
      requestId: "r1",
      decision: "rejected",
      ...actor,
      env: env(),
    });

    expect(result).toMatchObject({ status: "rejected", releasedMarker: true, emailed: false });
    expect(store.docs.has(`requestEmails/${markerId}`)).toBe(false);
    expect(store.docs.get("requests/r1")).toEqual(rejectedRequest);
    expect(sent).toHaveLength(0);
  });

  it("does not release a marker now owned by a newer request", async () => {
    const markerId = await markerKey("alex@example.com");
    const store = memoryStore({
      "requests/r1": REQ(),
      [`requestEmails/${markerId}`]: { requestId: "r2", createdAt: "2026-09-29T00:00:00.000Z" },
    });
    stubResend();

    const result = await decideRequest(store, {
      requestId: "r1",
      decision: "rejected",
      ...actor,
      env: env(),
    });

    expect(result.releasedMarker).toBe(false);
    expect(store.docs.get(`requestEmails/${markerId}`).requestId).toBe("r2");
    expect(store.docs.get("requests/r1").status).toBe("rejected");
  });

  it("allows only one of two concurrent rejection attempts to complete", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    stubResend();

    const results = await Promise.allSettled([
      decideRequest(store, { requestId: "r1", decision: "rejected", ...actor, env: env() }),
      decideRequest(store, { requestId: "r1", decision: "rejected", ...actor, env: env() }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(store.docs.get("requests/r1").status).toBe("rejected");
  });

  it("records the rejection in the audit trail", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    stubResend();

    await decideRequest(store, { requestId: "r1", decision: "rejected", ...actor, env: env() });

    const audits = [...store.docs.entries()].filter(([k]) => k.startsWith("audit/"));
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).toContain("request.rejected");
  });

  it("still succeeds when Resend is down (the decision is not undone)", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    stubResend({ ok: false });

    const result = await decideRequest(store, {
      requestId: "r1",
      decision: "rejected",
      ...actor,
      env: env(),
    });

    // The request stays rejected; only the email is lost.
    expect(store.docs.get("requests/r1").status).toBe("rejected");
    expect(result.emailed).toBe(false);
  });
});

describe("APPROVAL", () => {
  it("creates the tester, allocates #1, and links the request", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    stubResend();

    const result = await decideRequest(store, {
      requestId: "r1",
      decision: "approved",
      ...actor,
      env: env(),
      password: "correct horse",
    });

    expect(result.status).toBe("approved");
    expect(result.testerId).toBe("t_r1");
    expect(result.testerNumber).toBe(1);

    // The tester is a map on the user document, addressed by the Auth uid.
    const user = store.docs.get(`users/${result.userId}`);
    expect(user.tester.status).toBe("accepted");
    expect(user.tester.email).toBe("alex@example.com");
    expect(user.tester.active).toBe(true);
    expect(store.docs.get("requests/r1").status).toBe("approved");
  });

  it("keeps the email marker for approved applicants", async () => {
    const markerId = await markerKey("alex@example.com");
    const store = memoryStore({
      "requests/r1": REQ(),
      [`requestEmails/${markerId}`]: { requestId: "r1", createdAt: "2026-09-01T00:00:00.000Z" },
    });
    stubResend();

    await decideRequest(store, {
        requestId: "r1",
        decision: "approved",
        ...actor,
        env: env(),
        password: "correct horse",
      });

    expect(store.docs.get(`requestEmails/${markerId}`).requestId).toBe("r1");
  });

  it("generates a Google Wallet save URL for the accepted tester", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    stubResend();

    const result = await decideRequest(store, {
      requestId: "r1",
      decision: "approved",
      ...actor,
      env: env(),
      password: "correct horse",
    });

    expect(result.saveUrl).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);

    // The token must be a real, verifiable RS256 JWT signed by the wallet key.
    const token = result.saveUrl.split("/").pop();
    const [header, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(JSON.parse(Buffer.from(header, "base64url").toString()).alg).toBe("RS256");
    expect(claims.iss).toBe("crp-tester-worker@crp-tester-card.iam.gserviceaccount.com");
    expect(claims.aud).toBe("google");
    expect(claims.origins).toEqual(["https://crp-company.github.io"]);

    const object = claims.payload.loyaltyObjects[0];
    expect(claims.payload.loyaltyClasses[0].id).toBe(CLASS_ID);
    expect(object.id).toBe(`${ISSUER_ID}.crp_tester_loyalty_t_r1`);
    expect(object.state).toBe("ACTIVE");
    expect(object.accountId).toBe(accountIdFor("t_r1"));
    // The Wallet object is bound to the sequential tester number.
    expect(object.accountName).toBe("CRP Tester #1");

    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      keyPair.publicKey,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  it("sends the acceptance email with the number and the Wallet link", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    const sent = stubResend();

    const result = await decideRequest(store, {
      requestId: "r1",
      decision: "approved",
      ...actor,
      env: env(),
      password: "correct horse",
    });

    expect(result.emailed).toBe(true);
    expect(sent).toHaveLength(1);

    const mail = sent[0].body;
    expect(mail.to).toEqual(["alex@example.com"]);
    expect(mail.subject).toBe("You're in — CRP Testing Program");
    expect(mail.html).toContain("You're officially part of the CRP Testing Program");
    expect(mail.html).toContain("TESTER #1");
    expect(mail.html).toContain("ADD TO GOOGLE WALLET");
    expect(mail.html).toContain(result.saveUrl);
    expect(mail.text).toContain("TESTER #1");
    expect(mail.text).toContain(result.saveUrl);
  });

  it("preserves every pre-existing request field", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    stubResend();

    await decideRequest(store, {
        requestId: "r1",
        decision: "approved",
        ...actor,
        env: env(),
        password: "correct horse",
      });

    const doc = store.docs.get("requests/r1");
    for (const field of [
      "name",
      "email",
      "consent",
      "experienceCategory",
      "source",
      "userAgent",
      "createdAt",
    ]) {
      expect(doc[field], field).toBe(REQ()[field]);
    }
    expect(doc.status).toBe("approved");
    expect(doc.testerId).toBe("t_r1");
  });

  it("stamps the tester with its wallet metadata", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    stubResend();

    const result = await decideRequest(store, {
      requestId: "r1",
      decision: "approved",
      ...actor,
      env: env(),
      password: "correct horse",
    });

    const wallet = store.docs.get(`users/${result.userId}`).tester.wallet;
    expect(wallet.issuerId).toBe(ISSUER_ID);
    expect(wallet.classId).toBe(CLASS_ID);
    expect(wallet.accountId).toBe(accountIdFor("t_r1"));
    expect(wallet.lastIssuedAt).toBeInstanceOf(Date);
  });

  it("never puts a credential or private key in the email", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    const sent = stubResend();

    await decideRequest(store, {
        requestId: "r1",
        decision: "approved",
        ...actor,
        env: env(),
        password: "correct horse",
      });

    const blob = JSON.stringify(sent[0].body);
    expect(blob).not.toContain("PRIVATE KEY");
    expect(blob).not.toContain("BEGIN RSA");
    expect(blob).not.toMatch(/re_[A-Za-z0-9]{20,}/);
    expect(blob).not.toContain("crp-cuby-display.iam.gserviceaccount.com");
  });

  it("allocates sequentially across approvals", async () => {
    const store = memoryStore({ "requests/r1": REQ(), "requests/r2": REQ({ email: "b@x.com" }) });
    stubResend();

    const a = await decideRequest(store, {
        requestId: "r1",
        decision: "approved",
        ...actor,
        env: env(),
        password: "correct horse",
      });
    const b = await decideRequest(store, {
      requestId: "r2",
      decision: "approved",
      ...actor,
      env: env(),
      password: "correct horse",
    });

    expect(a.testerNumber).toBe(1);
    expect(b.testerNumber).toBe(2);
  });
});

describe("DUPLICATE PROTECTION ON APPROVAL", () => {
  it("refuses a second approval and allocates nothing more", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    stubResend();

    const first = await decideRequest(store, {
        requestId: "r1",
        decision: "approved",
        ...actor,
        env: env(),
        password: "correct horse",
      });
    expect(first.testerNumber).toBe(1);

    const counterAfterFirst = counterValue(store);

    await expect(
      decideRequest(store, {
        requestId: "r1",
        decision: "approved",
        ...actor,
        env: env(),
        password: "correct horse",
      }),
    ).rejects.toThrow(/already approved/);

    // No second number burned, no second tester, counter unchanged.
    expect(counterValue(store)).toBe(counterAfterFirst);
    const withTester = [...store.docs.values()].filter((d) => d.tester);
    expect(withTester).toHaveLength(1);
  });

  it("sends no second email when an approval is retried", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    const sent = stubResend();

    await decideRequest(store, {
        requestId: "r1",
        decision: "approved",
        ...actor,
        env: env(),
        password: "correct horse",
      });
    expect(sent).toHaveLength(1);

    await expect(
      decideRequest(store, {
        requestId: "r1",
        decision: "approved",
        ...actor,
        env: env(),
        password: "correct horse",
      }),
    ).rejects.toThrow();

    expect(sent).toHaveLength(1);
  });

  it("uses an idempotency key scoped to the request and decision", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    const sent = stubResend();

    await decideRequest(store, {
        requestId: "r1",
        decision: "approved",
        ...actor,
        env: env(),
        password: "correct horse",
      });

    // Resend dedupes on this for 24h, so even a retried send is collapsed.
    expect(sent[0].init.headers["Idempotency-Key"]).toBe("application-approved/r1");
  });

  it("refuses to re-approve a rejected request", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    stubResend();

    await decideRequest(store, { requestId: "r1", decision: "rejected", ...actor, env: env() });

    await expect(
      decideRequest(store, {
        requestId: "r1",
        decision: "approved",
        ...actor,
        env: env(),
        password: "correct horse",
      }),
    ).rejects.toThrow(/already rejected/);

    expect([...store.docs.keys()].some((k) => k.startsWith("users/"))).toBe(false);
    expect(counterValue(store)).toBeUndefined();
  });

  it("gives two concurrent approvals of one request a single number", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    stubResend();

    const results = await Promise.allSettled([
      decideRequest(store, {
        requestId: "r1",
        decision: "approved",
        ...actor,
        env: env(),
        password: "correct horse",
      }),
      decideRequest(store, {
        requestId: "r1",
        decision: "approved",
        ...actor,
        env: env(),
        password: "correct horse",
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(counterValue(store)).toBe(1);
    expect([...store.docs.values()].filter((d) => d.tester)).toHaveLength(1);
  });
});

describe("deactivation requires a reason (setTesterActive parity)", () => {
  // The dashboard toggle used to call the setTesterActive callable, which refused
  // to deactivate without a reason. Now that the toggle goes through the Worker's
  // /tester-status route, the same rule has to hold there, or a tester could be
  // revoked with no record of why.
  it("refuses to deactivate without a reason", async () => {
    const store = memoryStore({
      "users/u1": { email: "a@b.com", tester: { id: "t1", status: "accepted", active: true, testerNumber: 1 } },
    });

    await expect(
      setTesterStatus(store, { userId: "u1", active: false, reason: null, ...actor }),
    ).rejects.toThrow(/reason is required when deactivating/i);
  });

  it("refuses an empty or whitespace-only reason", async () => {
    const store = memoryStore({
      "users/u1": { email: "a@b.com", tester: { id: "t1", status: "accepted", active: true, testerNumber: 1 } },
    });

    await expect(
      setTesterStatus(store, { userId: "u1", active: false, reason: "   ", ...actor }),
    ).rejects.toThrow(/reason is required when deactivating/i);
  });

  it("deactivates with a reason and keeps status in step with active", async () => {
    const store = memoryStore({
      "users/u1": { email: "a@b.com", tester: { id: "t1", status: "accepted", active: true, testerNumber: 1 } },
    });

    const result = await setTesterStatus(store, {
      userId: "u1",
      active: false,
      reason: "asked to leave",
      ...actor,
    });

    expect(result.status).toBe("revoked");
    expect(result.active).toBe(false);
    const doc = store.docs.get("users/u1").tester;
    expect(doc.deactivationReason).toBe("asked to leave");
    expect(doc.deactivatedBy).toBe("admin-1");
    // The tester number must survive a revoke.
    expect(doc.testerNumber).toBe(1);
  });

  it("keeps an inactive tester's email marker so they cannot reapply", async () => {
    const email = "a@b.com";
    const markerId = await markerKey(email);
    const store = memoryStore({
      "users/u1": { email, tester: { id: "t1", status: "accepted", active: true, testerNumber: 1 } },
      [`requestEmails/${markerId}`]: { requestId: "r1" },
    });

    await setTesterStatus(store, {
      userId: "u1",
      active: false,
      reason: "inactive",
      ...actor,
    });

    expect(store.docs.get("users/u1").tester.active).toBe(false);
    expect(store.docs.get(`requestEmails/${markerId}`).requestId).toBe("r1");
  });

  it("reactivates without needing a reason and burns no number", async () => {
    const store = memoryStore({
      "users/u1": {
        email: "a@b.com",
        tester: {
          id: "t1",
          email: "a@b.com",
          status: "revoked",
          active: false,
          testerNumber: 1,
          acceptedAt: "2026-09-01T00:00:00.000Z",
        },
      },
    });

    const result = await setTesterStatus(store, { userId: "u1", active: true, ...actor });

    expect(result.status).toBe("accepted");
    expect(result.active).toBe(true);
    // Reactivating must not allocate a new number.
    expect(counterValue(store)).toBeUndefined();
  });
});

describe("acceptance email content", () => {
  const SAVE_URL = "https://pay.google.com/gp/v/save/abc.def.ghi";
  const build = (over = {}) =>
    buildAcceptanceEmail({ name: "Alex Morgan", email: "alex@example.com", testerNumber: 7, saveUrl: SAVE_URL, ...over });

  it("uses the agreed subject and confirmation line", () => {
    const mail = build();
    expect(mail.subject).toBe("You're in — CRP Testing Program");
    expect(mail.html).toContain("You're officially part of the CRP Testing Program");
    expect(mail.html).toContain("TESTER #7");
    expect(mail.text).toContain("TESTER #7");
  });

  it("renders the Add to Google Wallet button as a link", () => {
    const mail = build();
    expect(mail.html).toContain('href="' + SAVE_URL + '"');
    expect(mail.html).toContain("ADD TO GOOGLE WALLET");
    expect(mail.text).toContain(SAVE_URL);
  });

  it("explains what the card is for and that iPhone users need no setup", () => {
    const mail = build();
    // Both the html and the plain-text alternative must carry the same wording:
    // a text-only client must never receive different information.
    for (const rendered of [mail.html, mail.text]) {
      expect(rendered).toContain("helps us verify your identity as a tester");
      expect(rendered).toContain("no Wallet setup is required");
    }
  });

  it("uses the same CRP branding as the acknowledgement email", () => {
    const mail = build();
    // Same logo, same footer, same privacy link, table-based layout.
    expect(mail.html).toContain("github.com/CRP-company/CRP-early-access/blob/main/assets/CRPlogo.png?raw=true");
    expect(mail.html).toContain("&copy;2026 CRP. All rights reserved.");
    expect(mail.html).toContain("crp-company.github.io/CRP-Privacy-policy/");
    expect(mail.html).toContain("<table");
    expect(mail.html).not.toContain("<style");
  });

  it("greets by first name and neutralises a hostile name", () => {
    expect(build().text).toContain("Hi Alex");
    const hostile = build({ name: "<img onerror=alert(1)>" });
    expect(hostile.html).not.toMatch(/<img[^>]*onerror/i);
    expect(hostile.html).not.toContain("onerror=");
  });

  it("escapes a tampered save URL rather than emitting raw markup", () => {
    const mail = build({ saveUrl: 'https://x/"><script>alert(1)</script>' });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
  });
});

describe("rejection email content", () => {
  it("uses the agreed subject and says the application was not accepted", () => {
    const mail = buildRejectionEmail({ name: "Alex Morgan", email: "alex@example.com" });
    expect(mail.subject).toBe("CRP Testing Program — Application Update");
    expect(mail.html).toContain("weren't able to accept it at this time");
    expect(mail.text).toContain("weren't able to accept it at this time");
  });

  it("thanks the applicant and stays respectful", () => {
    const mail = buildRejectionEmail({ name: "Alex Morgan", email: "alex@example.com" });
    expect(mail.html).toContain("Thank you for applying to the CRP Tester Program.");
    expect(mail.html).toContain("we appreciate you taking the time to apply");
  });

  it("never contains a Wallet link or a tester number", () => {
    const mail = buildRejectionEmail({ name: "Alex", email: "a@b.com" });
    expect(mail.html).not.toContain("pay.google.com");
    expect(mail.html).not.toContain("TESTER #");
    expect(mail.text).not.toContain("pay.google.com");
  });

  it("matches the CRP branding of the other emails", () => {
    const mail = buildRejectionEmail({ name: "Alex", email: "a@b.com" });
    expect(mail.html).toContain("github.com/CRP-company/CRP-early-access/blob/main/assets/CRPlogo.png?raw=true");
    expect(mail.html).toContain("&copy;2026 CRP. All rights reserved.");
  });
});

describe("wallet module", () => {
  it("derives a stable account id from the tester document id", () => {
    // First 8 alphanumerics after the t_ prefix, uppercased — the same rule as
    // functions/src/wallet.js accountIdFor().
    expect(accountIdFor("t_E2sX6EmlxGP2VE6viqKG")).toBe("CRP-E2SX6EML");
    expect(accountIdFor("t_abc123")).toBe(accountIdFor("t_abc123"));
  });

  it("uses the CRP issuer and class", () => {
    expect(ISSUER_ID).toBe("3388000000023210330");
    expect(CLASS_ID).toBe(`${ISSUER_ID}.crp_tester_loyalty`);
  });

  it("marks the pass REVOKED when the tester is not active", async () => {
    const url = await buildSaveUrl({
      tester: { id: "t_r1", name: "Alex" },
      active: false,
      testerNumber: 1,
      secretJson: walletSecret,
    });
    const claims = JSON.parse(Buffer.from(url.split("/").pop().split(".")[1], "base64url").toString());
    expect(claims.payload.loyaltyObjects[0].state).toBe("REVOKED");
  });

  it("falls back to the tester's name when no number is known", async () => {
    const url = await buildSaveUrl({
      tester: { id: "t_r1", name: "Alex Morgan" },
      active: true,
      secretJson: walletSecret,
    });
    const claims = JSON.parse(Buffer.from(url.split("/").pop().split(".")[1], "base64url").toString());
    expect(claims.payload.loyaltyObjects[0].accountName).toBe("Alex Morgan");
  });

  it("fails loudly when the wallet secret is missing", () => {
    // Throws synchronously: the guard is before any await.
    expect(() =>
      buildSaveUrl({ tester: { id: "t_r1" }, active: true, secretJson: undefined }),
    ).toThrow(/GOOGLE_WALLET_SERVICE_ACCOUNT_JSON/);
  });

  it("never embeds the private key in the URL", async () => {
    const url = await buildSaveUrl({
      tester: { id: "t_r1", name: "Alex" },
      active: true,
      testerNumber: 1,
      secretJson: walletSecret,
    });
    expect(url).not.toContain("PRIVATE KEY");
    expect(url).not.toContain(JSON.parse(walletSecret).private_key.slice(40, 80));
  });
});

describe("admin dashboard source no longer calls the removed Cloud Function", () => {
  // Every callable left in `functions/` is undeployed on the Spark plan. Calling
  // one from GitHub Pages fails on CORS, so none of these names may appear as a
  // call in the admin client. Guards against any of them being reintroduced.
  const OBSOLETE_CALLABLES = [
    "issueWalletPass",
    "setTesterActive",
    "setTesterStatus",
    "decideRequest",
    "recordActivity",
    "peekNextTesterNumber",
    "getMyWalletPass",
  ];

  it("never calls an undeployed Cloud Function", () => {
    for (const name of OBSOLETE_CALLABLES) {
      expect(
        adminSource,
        `admin.js must not call the ${name} callable`,
      ).not.toMatch(new RegExp(`call\\(\\s*["']${name}["']`));
    }
  });

  it("has no httpsCallable/getFunctions machinery at all", () => {
    // The strongest guarantee: with the SDK import gone, no callable can be
    // called at all, whatever someone adds later.
    expect(adminSource).not.toContain("httpsCallable");
    expect(adminSource).not.toContain("getFunctions");
    expect(adminSource).not.toContain("firebase-functions.js");
  });

  it("routes Wallet issuance through the Worker /tester-wallet", () => {
    expect(adminSource).toContain("/tester-wallet");
    // The ID token must still be sent, so the Worker can re-check the claim.
    expect(adminSource).toContain("postToWorker");
    expect(adminSource).toContain("getIdToken");
  });

  it("routes the active/revoked toggle through the Worker /tester-status", () => {
    expect(adminSource).toContain("/tester-status");
  });

  it("still uses the Worker for approve/reject", () => {
    expect(adminSource).toContain("/accept");
  });

  it("shows experience categories in the request list and details", () => {
    expect(adminSource).toContain("experienceCategoryDisplay(data.experienceCategory)");
    expect(adminSource).toContain('data-request-details="${escapeHtml(doc.id)}"');
    expect(adminSource).toContain("<dt>Experience</dt>");
  });

  it("keeps the admin claim enforcement in the Worker", () => {
    // Every admin route must sit behind requireAdmin.
    expect(indexSource).toMatch(/requireAdmin\(request, projectId\)/);
    expect(indexSource).toContain("/tester-wallet");
    expect(indexSource).toContain("/tester-status");
  });

  it("never exposes a service-account credential in the admin client", () => {
    expect(adminSource).not.toMatch(/PRIVATE KEY/);
    expect(adminSource).not.toMatch(/service_account/);
    expect(adminSource).not.toMatch(/FIREBASE_SERVICE_ACCOUNT_JSON|GOOGLE_WALLET_SERVICE_ACCOUNT_JSON/);
  });
});
