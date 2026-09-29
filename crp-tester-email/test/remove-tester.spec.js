/**
 * Regression tests for the Remove lifecycle.
 *
 * Remove is the one destructive action in the admin: it takes someone out of the
 * program AND releases their duplicate-protection marker, so they can apply
 * again. The two halves must land together, the number must never be reused, and
 * the history must survive.
 *
 * Deactivate is deliberately untouched by all of this — a revoked tester stays in
 * the program and stays blocked from re-applying.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { removeTester, setTesterStatus, decideRequest } from "../src/accept.js";
import { META_COLLECTION, COUNTER_DOC } from "../src/tester-lifecycle.js";
import { buildSaveUrl, ISSUER_ID } from "../src/wallet.js";

// Vite inlines these as strings at build time; the Workers test runtime has no
// filesystem, so readFileSync is unavailable.
// eslint-disable-next-line import/extensions
import indexSource from "../src/index.js?raw";
// eslint-disable-next-line import/extensions
import adminSource from "../../admin/js/admin.js?raw";
// eslint-disable-next-line import/extensions
import restSource from "../src/firestore-rest.js?raw";

const EMAIL = "alex@example.com";

/** The requestEmails key js/signup.js computes for an address. */
async function markerKey(email) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(email.trim().toLowerCase()),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * In-memory Firestore with the preconditions the code relies on, including an
 * all-or-nothing removeTester so a partial implementation cannot pass.
 */
function memoryStore(seed = {}) {
  const docs = new Map();
  let version = 0;
  const bump = () => `v${(version += 1)}`;
  for (const [k, v] of Object.entries(seed)) docs.set(k, { ...v, updateTime: bump() });

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
      docs.set(key, { ...cur, ...data, updateTime: bump() });
      return true;
    },
    async listCollection(c) {
      return [...docs.entries()]
        .filter(([k]) => k.startsWith(`${c}/`))
        .map(([k, v]) => ({ id: k.split("/").pop(), ...v }));
    },

    /**
     * Atomic archive + marker release. Writes are staged and applied only once
     * every precondition has been validated, so a partial remove is impossible —
     * exactly the failure mode this feature exists to prevent.
     */
    async removeTester({
      collection,
      id,
      patch,
      updateTime,
      auditCollection,
      auditId,
      auditEntry,
      releaseCollection = null,
      releaseId = null,
    }) {
      const staged = [];

      const key = `${collection}/${id}`;
      const cur = docs.get(key);
      if (!cur || (updateTime && updateTime !== cur.updateTime)) {
        const e = new Error("precondition");
        e.status = 409;
        throw e;
      }
      staged.push([key, { ...cur, ...patch, updateTime: bump() }]);

      // `create` fails on an existing id, so a retry cannot append a second
      // history entry.
      const aKey = `${auditCollection}/${auditId}`;
      if (docs.has(aKey)) {
        const e = new Error("exists");
        e.status = 409;
        throw e;
      }
      staged.push([aKey, { ...auditEntry, updateTime: bump() }]);

      // A delete of an absent document is a no-op, as in Firestore.
      if (releaseCollection && releaseId) {
        staged.push([`${releaseCollection}/${releaseId}`, null]);
      }

      for (const [k, v] of staged) {
        if (v === null) docs.delete(k);
        else docs.set(k, v);
      }
      return { removed: true };
    },
  };
}

const TESTER = () => ({
  "testers/t1": {
    name: "Alex Morgan",
    email: EMAIL,
    status: "accepted",
    active: true,
    testerNumber: 4,
    createdAt: "2026-09-01T00:00:00.000Z",
    activity: { lastPeriod: null, comments: 3, reviews: 1 },
  },
});

const REASON = { reason: "no longer testing", actorUid: "admin-1" };
const actor = { actorUid: "admin-1", actorEmail: "staff@crp.com" };
const counterValue = (s) => s.docs.get(`${META_COLLECTION}/${COUNTER_DOC}`)?.lastNumber;

/** A store with a tester and the requestEmails marker signup would have left. */
async function seeded() {
  const store = memoryStore(TESTER());
  const key = await markerKey(EMAIL);
  store.docs.set(`requestEmails/${key}`, {
    requestId: "r1",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  return { store, key };
}

const REQ = (over = {}) => ({
  name: "Alex Morgan",
  email: EMAIL,
  consent: true,
  status: "pending",
  source: "early-access-site",
  userAgent: "test-agent",
  website: "",
  createdAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

let walletSecret;

beforeEach(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const b64 = Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n");
  walletSecret = JSON.stringify({
    type: "service_account",
    project_id: "crp-tester-card",
    client_email: "crp-tester-worker@crp-tester-card.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\n" + b64 + "\n-----END PRIVATE KEY-----\n",
  });
  // Email is best-effort and must never reach the network here.
  vi.stubGlobal("fetch", async (url) => {
    if (String(url).includes("api.resend.com")) {
      return new Response(JSON.stringify({ id: "r1" }), { status: 200 });
    }
    throw new Error("unexpected fetch: " + url);
  });
});

afterEach(() => vi.unstubAllGlobals());

const env = () => ({
  RESEND_API_KEY: "re_test",
  CRP_EMAIL_FROM: "CRP Tester Program <testing@crp.company>",
  GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: walletSecret,
});

describe("REMOVE — leaving the program", () => {
  it("1. takes the tester out of the active program", async () => {
    const { store } = await seeded();
    const result = await removeTester(store, { testerId: "t1", ...REASON });

    expect(result.removed).toBe(true);
    expect(result.alreadyRemoved).toBe(false);

    const tester = store.docs.get("testers/t1");
    expect(tester.removed).toBe(true);
    expect(tester.active).toBe(false);
    // Archived, not deleted: the document is still on the record.
    expect(store.docs.has("testers/t1")).toBe(true);
  });

  it("2. keeps the tester number and retires it, never reusing it", async () => {
    const { store } = await seeded();
    const result = await removeTester(store, { testerId: "t1", ...REASON });

    // The number stays on the record for history...
    expect(result.testerNumber).toBe(4);
    expect(store.docs.get("testers/t1").testerNumber).toBe(4);
    // ...and the counter is untouched, so #4 is never handed out again.
    expect(counterValue(store)).toBeUndefined();
  });

  it("3. writes an audit entry with tester, number, email, admin and reason", async () => {
    const { store } = await seeded();
    await removeTester(store, {
      testerId: "t1",
      reason: "no longer testing",
      actorUid: "admin-1",
      actorEmail: "staff@crp.com",
    });

    const audits = [...store.docs.entries()].filter(([k]) => k.startsWith("audit/"));
    expect(audits).toHaveLength(1);
    const entry = audits[0][1];

    expect(entry.action).toBe("tester.removed");
    expect(entry.testerId).toBe("t1");
    expect(entry.testerNumber).toBe(4);
    expect(entry.email).toBe(EMAIL);
    expect(entry.actor).toBe("admin-1");
    expect(entry.actorEmail).toBe("staff@crp.com");
    expect(entry.reason).toBe("no longer testing");
    expect(entry.at).toBeInstanceOf(Date);
    expect(entry.walletRevoked).toBe(true);
  });

  it("4. releases the requestEmails marker so they may apply again", async () => {
    const { store, key } = await seeded();
    expect(store.docs.has(`requestEmails/${key}`)).toBe(true);

    const result = await removeTester(store, { testerId: "t1", ...REASON });

    expect(result.releasedMarker).toBe(true);
    expect(store.docs.has(`requestEmails/${key}`)).toBe(false);
  });

  it("5. requires a reason", async () => {
    const { store } = await seeded();

    for (const bad of [undefined, null, "", "   "]) {
      await expect(
        removeTester(store, { testerId: "t1", reason: bad, actorUid: "admin-1" }),
      ).rejects.toThrow(/reason is required/i);
    }
    expect(store.docs.get("testers/t1").removed).toBeUndefined();
  });

  it("6. 404s an unknown tester and 400s a missing id", async () => {
    const { store } = await seeded();

    await expect(removeTester(store, { testerId: "nope", ...REASON })).rejects.toThrow(
      /No such tester/,
    );
    await expect(removeTester(store, { ...REASON })).rejects.toThrow(/testerId is required/);
  });

  it("7. preserves the activity history on the archived record", async () => {
    const { store } = await seeded();
    await removeTester(store, { testerId: "t1", ...REASON });

    const tester = store.docs.get("testers/t1");
    expect(tester.activity).toEqual({ lastPeriod: null, comments: 3, reviews: 1 });
    expect(tester.name).toBe("Alex Morgan");
    expect(tester.createdAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("8. running Remove twice is safe and writes only one audit entry", async () => {
    const { store } = await seeded();

    const first = await removeTester(store, { testerId: "t1", ...REASON });
    expect(first.alreadyRemoved).toBe(false);

    const second = await removeTester(store, { testerId: "t1", ...REASON });
    expect(second.removed).toBe(true);
    expect(second.alreadyRemoved).toBe(true);

    const audits = [...store.docs.entries()].filter(([k]) => k.startsWith("audit/"));
    expect(audits).toHaveLength(1);
    expect(second.testerNumber).toBe(4);
  });

  it("9. a new application from the same email is NOT linked to the old tester", async () => {
    const { store } = await seeded();
    await removeTester(store, { testerId: "t1", ...REASON });

    // The archived tester is still in the collection, so the duplicate-email
    // lookup must skip it or the new application would be linked back to t1.
    store.docs.set("requests/r2", REQ({ email: EMAIL }));
    const result = await decideRequest(store, {
      requestId: "r2",
      decision: "approved",
      ...actor,
      env: env(),
    });

    expect(result.testerId).toBe("t_r2");
    expect(store.docs.get("testers/t_r2")).toBeDefined();
  });

  it("10. re-approving after removal creates a NEW tester number", async () => {
    const { store } = await seeded();
    await removeTester(store, { testerId: "t1", ...REASON });

    store.docs.set("requests/r2", REQ({ email: EMAIL }));
    const result = await decideRequest(store, {
      requestId: "r2",
      decision: "approved",
      ...actor,
      env: env(),
    });

    expect(result.testerNumber).toBe(1);
    expect(result.testerId).toBe("t_r2");
  });

  it("11. a removed tester's card is issued as REVOKED, same object id", async () => {
    const { store } = await seeded();
    await removeTester(store, { testerId: "t1", ...REASON });

    expect(store.docs.get("testers/t1").active).toBe(false);

    const url = await buildSaveUrl({
      tester: { id: "t1", name: "Alex Morgan" },
      active: false,
      testerNumber: 4,
      secretJson: walletSecret,
    });
    const claims = JSON.parse(
      Buffer.from(url.split("/").pop().split(".")[1], "base64url").toString(),
    );
    expect(claims.payload.loyaltyObjects[0].state).toBe("REVOKED");
    // Same object id as before: revoked, not replaced by a second pass.
    expect(claims.payload.loyaltyObjects[0].id).toBe(`${ISSUER_ID}.crp_tester_loyalty_t1`);
  });

  it("12. does NOT touch the marker for a rejected applicant", async () => {
    // A rejected applicant is not a tester, so they cannot be removed here at
    // all — their marker must stay put.
    const store = memoryStore({ "requests/r1": REQ() });
    const key = await markerKey(EMAIL);
    store.docs.set(`requestEmails/${key}`, { requestId: "r1", createdAt: "x" });

    await expect(removeTester(store, { testerId: "r1", ...REASON })).rejects.toThrow(
      /No such tester/,
    );
    expect(store.docs.has(`requestEmails/${key}`)).toBe(true);
  });

  it("13. does NOT release the marker for a merely deactivated tester", async () => {
    // Deactivate is not Remove. A revoked tester stays in the program and stays
    // blocked from re-applying.
    const { store, key } = await seeded();
    await setTesterStatus(store, {
      testerId: "t1",
      active: false,
      reason: "paused",
      ...actor,
    });

    expect(store.docs.get("testers/t1").active).toBe(false);
    expect(store.docs.get("testers/t1").removed).toBeUndefined();
    // Duplicate protection still in force.
    expect(store.docs.has(`requestEmails/${key}`)).toBe(true);
  });

  it("14. a concurrent edit fails the removal rather than clobbering it", async () => {
    const { store } = await seeded();
    const stale = (await store.getDocument("testers", "t1")).updateTime;

    // Someone else edits the tester between our read and the commit, so the
    // versioned precondition must reject rather than overwrite their change.
    await store.updateDocument("testers", "t1", { status: "revoked" });

    await expect(
      store.removeTester({
        collection: "testers",
        id: "t1",
        patch: { removed: true },
        updateTime: stale,
        auditCollection: "audit",
        auditId: "removed_t1",
        auditEntry: { action: "tester.removed" },
      }),
    ).rejects.toThrow();

    // The concurrent edit survived; nothing was clobbered.
    expect(store.docs.get("testers/t1").status).toBe("revoked");
    expect(store.docs.get("testers/t1").removed).toBeUndefined();
    // And no audit entry was written for the failed attempt.
    expect([...store.docs.keys()].filter((k) => k.startsWith("audit/"))).toHaveLength(0);
  });
});

describe("removeTester wire format", () => {
  // The Firestore REST transaction payload is the part most likely to be subtly
  // wrong: a malformed write set is rejected by the API at runtime, long after
  // every unit test has passed. This asserts the exact shape that goes on the
  // wire, since the Worker's client hardcodes the production host and cannot be
  // pointed at the emulator.
  function recordingStore(captured) {
    const base = memoryStore(TESTER());
    return {
      ...base,
      async removeTester(args) {
        captured.push(args);
        return { removed: true };
      },
    };
  }

  it("sends an update, an audit create and a marker delete in one call", async () => {
    const captured = [];
    await removeTester(recordingStore(captured), { testerId: "t1", ...REASON });

    expect(captured).toHaveLength(1);
    const args = captured[0];

    // The tester is archived under a versioned precondition.
    expect(args.collection).toBe("testers");
    expect(args.id).toBe("t1");
    expect(args.updateTime).toBeTruthy();
    expect(args.patch.removed).toBe(true);

    // The audit id is deterministic, so a retry cannot append a second entry.
    expect(args.auditId).toBe("removed_t1");
    expect(args.auditEntry.action).toBe("tester.removed");
    expect(args.auditEntry.testerNumber).toBe(4);
    expect(args.auditEntry.email).toBe(EMAIL);

    // The marker to release is the same key js/signup.js writes.
    expect(args.releaseCollection).toBe("requestEmails");
    expect(args.releaseId).toBe(await markerKey(EMAIL));
  });

  it("keeps the tester number out of the archive patch's removable fields", async () => {
    const captured = [];
    await removeTester(recordingStore(captured), { testerId: "t1", ...REASON });

    const patch = captured[0].patch;
    // The number is retained on the record, never cleared or decremented.
    expect(patch.testerNumber).toBeUndefined();
    // Nor is the counter touched by a removal.
    expect(patch.lastNumber).toBeUndefined();
  });

  it("omits the marker write when the tester has no email", async () => {
    const captured = [];
    const store = recordingStore(captured);
    store.docs.set("testers/t9", { name: "No Email", status: "accepted", active: true });

    await removeTester(store, { testerId: "t9", ...REASON });

    // Nothing to release, and that must not become a malformed delete.
    expect(captured[0].releaseId).toBeNull();
  });
});

describe("Firestore Write shape", () => {
  // Firestore's Write message supports only `update` and `delete` — there is no
  // `create` verb. A first attempt used one and every unit test passed, but the
  // live API rejected the whole commit with
  //   Unknown name "create" at 'writes[1]': Cannot find field.
  // Create-if-absent must be an `update` guarded by `exists: false`, so this
  // pins the shape that actually goes on the wire.
  it("uses only update and delete writes", () => {
    const source = restSource;
    expect(source).not.toMatch(/\{\s*create:\s*\{/);
    expect(source).toMatch(/updateMask:\s*\{\s*fieldPaths/);
    // The audit write is an update guarded to create-if-absent.
    expect(source).toMatch(/currentDocument:\s*\{\s*exists:\s*false\s*\}/);
    // The marker release is a bare delete.
    expect(source).toMatch(/writes\.push\(\{\s*delete:/);
  });
});

describe("Worker route /tester-remove", () => {
  it("is a separate route and sits behind requireAdmin", () => {
    // Removal releases duplicate protection, so it must never be reachable via
    // the deactivate route or without the admin claim.
    expect(indexSource).toContain("/tester-remove");
    expect(indexSource).toMatch(/requireAdmin\(request, projectId\)/);
    expect(adminSource).toContain("/tester-remove");
  });

  it("the admin UI confirms before removing and requires a reason", () => {
    expect(adminSource).toContain("data-remove");
    // Two stages: an explicit understanding, then a reason.
    expect(adminSource).toMatch(/confirm\(/);
    expect(adminSource).toMatch(/reason is required to remove/i);
  });

  it("the admin UI keeps Remove separate from the deactivate toggle", () => {
    // A distinct attribute means the normal toggle cannot trigger it.
    expect(adminSource).toContain('data-deactivate=');
    expect(adminSource).toContain('data-remove=');
  });

  it("hides removed testers from the roster", () => {
    expect(adminSource).toMatch(/filter\(\(doc\) => !doc\.data\(\)\.removed\)/);
  });
});
