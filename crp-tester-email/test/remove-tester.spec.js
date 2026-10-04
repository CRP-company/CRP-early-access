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
import { findTesterByEmail, hashEmail } from "../src/tester-portal.js";
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

// The Auth layer is stubbed so these tests stay about Firestore behaviour.
// A removed tester's account survives, so the fixture's uid is always found —
// which is exactly the re-application case tests 9 and 10 depend on.
const authState = { existing: new Map([[EMAIL, { uid: "u1", email: EMAIL }]]) };

vi.mock("../src/user-account.js", async () => {
  const actual = await vi.importActual("../src/user-account.js");
  return {
    ...actual,
    findUserByEmail: async (_sa, email) => authState.existing.get(String(email).toLowerCase()) || null,
    createUser: async (_sa, { email, displayName }) => {
      const user = { uid: `uid-${authState.existing.size + 1}`, email, displayName };
      authState.existing.set(String(email).toLowerCase(), user);
      return user;
    },
  };
});

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
    async deleteDocument(c, id) {
      const key = `${c}/${id}`;
      if (!docs.has(key)) {
        const e = new Error("not found");
        e.status = 404;
        throw e;
      }
      docs.delete(key);
      return true;
    },
    async listCollection(c) {
      return [...docs.entries()]
        .filter(([k]) => k.startsWith(`${c}/`))
        .map(([k, v]) => ({ id: k.split("/").pop(), ...v }));
    },

    /** Merge into `tester.<key>`, matching the real updateMask behaviour. */
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
     * Atomic archive + marker release. Writes are staged and applied only once
     * every precondition has been validated, so a partial remove is impossible —
     * exactly the failure mode this feature exists to prevent.
     *
     * Removal MOVES the tester: the snapshot is appended to `testerHistory` and
     * the `tester` field is deleted, so "in the programme" stays a plain
     * field-existence check.
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
      const staged = [];

      const key = `${collection}/${id}`;
      const cur = docs.get(key);
      if (!cur) {
        const e = new Error("not found");
        e.status = 404;
        throw e;
      }
      // Versioned precondition, as Firestore enforces inside the transaction:
      // a document that moved under us must fail rather than be clobbered.
      if (updateTime && updateTime !== cur.updateTime) {
        const e = new Error("precondition");
        e.status = 409;
        throw e;
      }
      // Already gone: a retry must not append a second history entry.
      if (!cur.tester) {
        return { removed: true, alreadyRemoved: true };
      }

      const history = Array.isArray(cur.testerHistory) ? cur.testerHistory : [];
      const next = { ...cur, testerHistory: [...history, archived] };
      // An explicit null in the updateMask is how a field is deleted.
      delete next.tester;
      staged.push([key, { ...next, updateTime: bump() }]);

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
      return { removed: true, alreadyRemoved: false };
    },
  };
}

const TESTER = () => ({
  // The tester is a map on the user document, and the user's own fields sit
  // alongside it. Removal must disturb neither the map's siblings nor the
  // archived snapshot's contents.
  "users/u1": {
    email: EMAIL,
    displayName: "Alex Morgan",
    friends: ["friend-1"],
    lastLogin: "2026-09-30T12:00:00.000Z",
    tester: {
      id: "t1",
      userId: "u1",
      name: "Alex Morgan",
      email: EMAIL,
      status: "accepted",
      active: true,
      testerNumber: 4,
      createdAt: "2026-09-01T00:00:00.000Z",
      activity: { lastPeriod: null, comments: 3, reviews: 1 },
    },
  },
});

const REASON = { reason: "no longer testing", actorUid: "admin-1" };
const actor = { actorUid: "admin-1", actorEmail: "staff@crp.com" };
const counterValue = (s) => s.docs.get(`${META_COLLECTION}/${COUNTER_DOC}`)?.lastNumber;

/** The most recent archived snapshot, i.e. what the roster used to show. */
const archived = (s) => s.docs.get("users/u1").testerHistory.at(-1);

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
    const result = await removeTester(store, { userId: "u1", ...REASON });

    expect(result.removed).toBe(true);
    expect(result.alreadyRemoved).toBe(false);

    // The `tester` map is gone, which is what "not in the programme" means now.
    expect(store.docs.get("users/u1").tester).toBeUndefined();
    // The user document itself survives — they are still a CRP account.
    expect(store.docs.has("users/u1")).toBe(true);
    // And the snapshot is on the history instead of being discarded.
    expect(archived(store).removed).toBe(true);
    expect(archived(store).active).toBe(false);
  });

  it("1b. leaves the user's other fields untouched", async () => {
    const { store } = await seeded();
    await removeTester(store, { userId: "u1", ...REASON });

    // The user document belongs partly to the main app, so a tester removal
    // must not disturb anything outside the tester fields.
    const user = store.docs.get("users/u1");
    expect(user.email).toBe(EMAIL);
    expect(user.displayName).toBe("Alex Morgan");
    expect(user.friends).toEqual(["friend-1"]);
    expect(user.lastLogin).toBe("2026-09-30T12:00:00.000Z");
  });

  it("2. keeps the tester number and retires it, never reusing it", async () => {
    const { store } = await seeded();
    const result = await removeTester(store, { userId: "u1", ...REASON });

    // The number stays on the archived snapshot...
    expect(result.testerNumber).toBe(4);
    expect(archived(store).testerNumber).toBe(4);
    // ...and the counter is untouched, so #4 is never handed out again.
    expect(counterValue(store)).toBeUndefined();
  });

  it("3. writes an audit entry with tester, number, email, admin and reason", async () => {
    const { store } = await seeded();
    await removeTester(store, {
      userId: "u1",
      reason: "no longer testing",
      actorUid: "admin-1",
      actorEmail: "staff@crp.com",
    });

    const audits = [...store.docs.entries()].filter(([k]) => k.startsWith("audit/"));
    expect(audits).toHaveLength(1);
    const entry = audits[0][1];

    expect(entry.action).toBe("tester.removed");
    expect(entry.testerId).toBe("t1");
    expect(entry.userId).toBe("u1");
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

    const result = await removeTester(store, { userId: "u1", ...REASON });

    expect(result.releasedMarker).toBe(true);
    expect(store.docs.has(`requestEmails/${key}`)).toBe(false);
  });

  it("5. requires a reason", async () => {
    const { store } = await seeded();

    for (const bad of [undefined, null, "", "   "]) {
      await expect(
        removeTester(store, { userId: "u1", reason: bad, actorUid: "admin-1" }),
      ).rejects.toThrow(/reason is required/i);
    }
    // Nothing was written, so the tester is still on the roster.
    expect(store.docs.get("users/u1").tester).toBeDefined();
    expect(store.docs.get("users/u1").testerHistory).toBeUndefined();
  });

  it("6. 404s an unknown user and 400s a missing id", async () => {
    const { store } = await seeded();

    await expect(removeTester(store, { userId: "nope", ...REASON })).rejects.toThrow(
      /No such user/,
    );
    await expect(removeTester(store, { ...REASON })).rejects.toThrow(/userId is required/);
  });

  it("7. preserves the activity history on the archived snapshot", async () => {
    const { store } = await seeded();
    await removeTester(store, { userId: "u1", ...REASON });

    const snap = archived(store);
    expect(snap.activity).toEqual({ lastPeriod: null, comments: 3, reviews: 1 });
    expect(snap.name).toBe("Alex Morgan");
    expect(snap.createdAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("7b. appends to an existing history rather than replacing it", async () => {
    // A second tenure on the same account must not erase the first one's record.
    const { store } = await seeded();
    store.docs.get("users/u1").testerHistory = [
      { id: "t_old", testerNumber: 2, removed: true, removalReason: "moved away" },
    ];

    await removeTester(store, { userId: "u1", ...REASON });

    const history = store.docs.get("users/u1").testerHistory;
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe("t_old");
    expect(history[0].removalReason).toBe("moved away");
    expect(history[1].id).toBe("t1");
  });

  it("8. running Remove twice is safe and writes only one audit entry", async () => {
    const { store } = await seeded();

    const first = await removeTester(store, { userId: "u1", ...REASON });
    expect(first.alreadyRemoved).toBe(false);

    const second = await removeTester(store, { userId: "u1", ...REASON });
    expect(second.removed).toBe(true);
    expect(second.alreadyRemoved).toBe(true);

    const audits = [...store.docs.entries()].filter(([k]) => k.startsWith("audit/"));
    expect(audits).toHaveLength(1);
    expect(second.testerNumber).toBe(4);
    // Crucially: the history was not appended a second time.
    expect(store.docs.get("users/u1").testerHistory).toHaveLength(1);
  });

  it("9. a new application from the same email is NOT linked to the old tester", async () => {
    const { store } = await seeded();
    await removeTester(store, { userId: "u1", ...REASON });

    // The old record now lives on testerHistory, so the "already a tester" check
    // — which looks at the `tester` map — must not find it, or the new
    // application would be linked back to the removed tenure.
    store.docs.set("requests/r2", REQ({ email: EMAIL }));
    const result = await decideRequest(store, {
      requestId: "r2",
      decision: "approved",
      ...actor,
      env: env(),
    });

    expect(result.testerId).toBe("t_r2");
    expect(store.docs.get("users/u1").tester.id).toBe("t_r2");
    // The previous tenure is still on the history, untouched.
    expect(store.docs.get("users/u1").testerHistory).toHaveLength(1);
  });

  it("10. re-approving after removal creates a NEW tester number", async () => {
    const { store } = await seeded();
    await removeTester(store, { userId: "u1", ...REASON });

    store.docs.set("requests/r2", REQ({ email: EMAIL }));
    const result = await decideRequest(store, {
      requestId: "r2",
      decision: "approved",
      ...actor,
      env: env(),
    });

    // A fresh number from the counter, not the retired #4.
    expect(result.testerNumber).toBe(1);
    expect(result.testerId).toBe("t_r2");
  });

  it("11. a removed tester's card is issued as REVOKED, same object id", async () => {
    const { store } = await seeded();
    await removeTester(store, { userId: "u1", ...REASON });

    expect(archived(store).active).toBe(false);

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
    // Same object id as before: revoked, not replaced by a second pass. The
    // tester id survives the move into the user document, so cards already
    // issued keep updating rather than being reissued under a new id.
    expect(claims.payload.loyaltyObjects[0].id).toBe(`${ISSUER_ID}.crp_tester_loyalty_t1`);
  });

  it("12. does NOT touch the marker for a rejected applicant", async () => {
    // A rejected applicant is not a tester, so they cannot be removed here at
    // all — their marker must stay put.
    const store = memoryStore({ "requests/r1": REQ() });
    const key = await markerKey(EMAIL);
    store.docs.set(`requestEmails/${key}`, { requestId: "r1", createdAt: "x" });

    await expect(removeTester(store, { userId: "u1", ...REASON })).rejects.toThrow(
      /No such user/,
    );
    expect(store.docs.has(`requestEmails/${key}`)).toBe(true);
  });

  it("13. does NOT release the marker for a merely deactivated tester", async () => {
    // Deactivate is not Remove. A revoked tester stays in the program and stays
    // blocked from re-applying.
    const { store, key } = await seeded();
    await setTesterStatus(store, {
      userId: "u1",
      active: false,
      reason: "paused",
      ...actor,
    });

    // The `tester` map is still present, which is what "still in the program"
    // means — and nothing was archived.
    expect(store.docs.get("users/u1").tester.active).toBe(false);
    expect(store.docs.get("users/u1").testerHistory).toBeUndefined();
    // Duplicate protection still in force.
    expect(store.docs.has(`requestEmails/${key}`)).toBe(true);
  });

  it("14. a concurrent edit fails the removal rather than clobbering it", async () => {
    const { store } = await seeded();

    // Someone else edits the user between our read and the commit, so the
    // versioned precondition must reject rather than overwrite their change.
    const stale = (await store.getDocument("users", "u1")).updateTime;
    await store.updateDocument("users", "u1", { lastLogin: "2026-09-30T13:00:00.000Z" });

    await expect(
      store.removeTesterToHistory({
        collection: "users",
        id: "u1",
        archived: { id: "t1", removed: true },
        auditCollection: "audit",
        auditId: "removed_t1",
        auditEntry: { action: "tester.removed" },
        // The stale version is what fails the precondition.
        updateTime: stale,
      }),
    ).rejects.toThrow();

    // The concurrent edit survived; nothing was clobbered.
    expect(store.docs.get("users/u1").lastLogin).toBe("2026-09-30T13:00:00.000Z");
    expect(store.docs.get("users/u1").tester).toBeDefined();
    expect(store.docs.get("users/u1").testerHistory).toBeUndefined();
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
      async removeTesterToHistory(args) {
        captured.push(args);
        return { removed: true, alreadyRemoved: false };
      },
    };
  }

  it("sends an update, an audit create and a marker delete in one call", async () => {
    const captured = [];
    await removeTester(recordingStore(captured), { userId: "u1", ...REASON });

    expect(captured).toHaveLength(1);
    const args = captured[0];

    // Addressed by uid, on the users collection, not by tester id.
    expect(args.collection).toBe("users");
    expect(args.id).toBe("u1");
    // The whole prior record is archived, not a partial patch.
    expect(args.archived.id).toBe("t1");
    expect(args.archived.removed).toBe(true);
    expect(args.archived.testerNumber).toBe(4);

    // The audit id is deterministic, so a retry cannot append a second entry.
    expect(args.auditId).toBe("removed_t1");
    expect(args.auditEntry.action).toBe("tester.removed");
    expect(args.auditEntry.userId).toBe("u1");
    expect(args.auditEntry.testerNumber).toBe(4);
    expect(args.auditEntry.email).toBe(EMAIL);

    // The marker to release is the same key js/signup.js writes.
    expect(args.releaseCollection).toBe("requestEmails");
    expect(args.releaseId).toBe(await markerKey(EMAIL));
  });

  it("keeps the tester number on the archived record, never decremented", async () => {
    const captured = [];
    await removeTester(recordingStore(captured), { userId: "u1", ...REASON });

    // The number is retained on the snapshot, so history can name it...
    expect(captured[0].archived.testerNumber).toBe(4);
    // ...and no counter field is ever written by a removal.
    expect(captured[0].archived.lastNumber).toBeUndefined();
  });

  it("omits the marker write when the tester has no email", async () => {
    const captured = [];
    const store = recordingStore(captured);
    store.docs.set("users/u9", {
      email: "",
      tester: { id: "t9", name: "No Email", status: "accepted", active: true },
    });

    await removeTester(store, { userId: "u9", ...REASON });

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

  it("deletes the tester map with an explicit null inside the updateMask", () => {
    // The move-to-history is the one non-obvious part of the wire format: there
    // is no "delete field" verb, so `tester` has to be listed in the mask AND
    // sent as a nullValue. Doing only one of the two leaves the field in place
    // (mask without null) or errors (null without mask).
    const source = restSource;
    expect(source).toMatch(/encodeFields\(\{ tester: null, testerHistory:/);
    expect(source).toMatch(/fieldPaths:\s*\["tester",\s*"testerHistory"\]/);
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
    // Membership is now the existence of the `tester` map, so the filter is on
    // that rather than on a `removed` flag — which no longer exists, so there is
    // no flag left to drift out of step with the truth.
    expect(adminSource).toMatch(/filter\(\(doc\) => Boolean\(doc\.data\(\)\.tester\)\)/);
    expect(adminSource).not.toMatch(/data\(\)\.removed/);
  });

  it("addresses the routes by userId, not testerId", () => {
    // The tester record lives on the user document, so the dashboard sends the
    // Auth uid and the Worker reads it back out of the body.
    expect(adminSource).toMatch(/body: \{ userId, reason \}/);
    expect(adminSource).toMatch(/body: \{ userId, active, reason \}/);
    expect(adminSource).toMatch(/body: \{ userId \}/);
    expect(indexSource).toMatch(/const \{ userId, reason \} = body \|\| \{\}/);
    expect(indexSource).toMatch(/const \{ userId \} = body \|\| \{\}/);
  });
});

/**
 * Regression: a failed token refresh must not be treated as a missing claim.
 *
 * The dashboard force-refreshes the ID token on every auth-state change and then
 * checks the `admin` claim. That refresh can fail transiently (offline, a proxy
 * blip). The old code swallowed the failure and then read `getIdTokenResult()`,
 * which falls back to the CACHED token — one minted before the claim existed, so
 * it has no `admin`. The code concluded "no admin claim" and called signOut(),
 * destroying a valid session and any fresh manual sign-in still completing in
 * another callback. Symptom: the dashboard appears, then vanishes back to login.
 *
 * Source-level guard: the refresh catch block must return without signing out,
 * and must not print the missing-claim message.
 */
describe("admin auth-state claim check", () => {
  const refreshCatch = adminSource.match(
    /await user\.getIdToken\(true\);[\s\S]*?catch \{([\s\S]*?)\n {4}\}/,
  );

  it("wraps the refresh and the claim read in one try block", () => {
    // If these are split again, the claim can be read from a stale token.
    expect(refreshCatch).not.toBeNull();
    expect(adminSource).toMatch(/tokenResult = await user\.getIdTokenResult\(\);/);
  });

  it("does NOT call signOut when the token refresh fails", () => {
    expect(refreshCatch[1]).not.toMatch(/signOut/);

    // Stronger: nothing between the forced refresh and the claim check may sign
    // the user out. On the pre-fix code `signOut` sat inside the claim branch
    // that a failed refresh fell through into, so this is what actually pins it.
    const between = adminSource.match(
      /await user\.getIdToken\(true\);[\s\S]*?tokenResult\.claims\.admin/,
    );
    expect(between).not.toBeNull();
    expect(between[0]).not.toMatch(/signOut/);
  });

  it("does NOT report a missing admin claim when the refresh fails", () => {
    expect(refreshCatch[1]).not.toMatch(/no admin claim/i);
    expect(refreshCatch[1]).toMatch(/Could not verify your session/i);
    expect(refreshCatch[1]).toMatch(/return;/);
  });

  it("still signs out a genuine non-admin account", () => {
    // The real deny path must be preserved, not weakened.
    const claimBranch = adminSource.match(
      /tokenResult\.claims\.admin !== true\) \{([\s\S]*?)\n {4}\}/,
    );
    expect(claimBranch).not.toBeNull();
    expect(claimBranch[1]).toMatch(/await signOut\(auth\)/);
    expect(claimBranch[1]).toMatch(/no admin claim/i);
  });
});

/**
 * Regression: removal must not leave a `testerIndex` document behind with a null
 * userId.
 *
 * The real defect this covers: clearTesterIndex() used to blank the pointer
 * (`userId: null`) instead of deleting it, and the delete it tried first
 * (`store.deleteDocument`) did not exist on the REST store, so that call threw,
 * was swallowed, and the blanking ran and succeeded. The result was a persistent
 * pointer that findTesterByEmail() treats as "stale, needs migrating" — so a
 * removed tester who later signed in got HTTP 409 from /tester-me instead of the
 * correct 403, and could never sign in again cleanly.
 */
describe("testerIndex after removal", () => {
  const EMAIL = "alex@example.com";

  async function removeWithPointer() {
    const indexId = await hashEmail(EMAIL);
    const store = memoryStore({
      [`users/u1`]: {
        email: EMAIL,
        displayName: "Alex Morgan",
        tester: {
          id: "t_1",
          name: "Alex Morgan",
          email: EMAIL,
          status: "accepted",
          testerNumber: 42,
        },
      },
      [`requests/req_1`]: { email: EMAIL, name: "Alex Morgan", status: "approved" },
      [`testerIndex/${indexId}`]: { userId: "u1", testerId: null },
    });

    const result = await removeTester(store, {
      userId: "u1",
      reason: "left the programme",
      actorUid: "admin-1",
      actorEmail: "staff@crp.com",
    });

    return { store, indexId, result };
  }

  it("deletes the pointer rather than blanking its userId", async () => {
    const { store, indexId, result } = await removeWithPointer();

    expect(result.removed).toBe(true);
    expect(store.docs.has(`testerIndex/${indexId}`)).toBe(false);

    // The precise shape that caused the 409. Asserted directly so the regression
    // cannot be reintroduced under a different implementation.
    const pointer = store.docs.get(`testerIndex/${indexId}`);
    expect(pointer === undefined || pointer.userId !== null).toBe(true);
  });

  it("leaves no document that would answer 409 to a later sign-in", async () => {
    const { store, indexId } = await removeWithPointer();

    // Exactly what findTesterByEmail() does: hash the address, read the pointer,
    // and refuse when one exists with no userId. With the pointer deleted, the
    // lookup returns null -> the portal reports a plain 403 "not on the roster".
    const found = await findTesterByEmail(store, EMAIL);
    expect(found).toBeNull();
    expect(store.docs.get(`testerIndex/${indexId}`)).toBeUndefined();
  });
});
