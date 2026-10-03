import { describe, it, expect, beforeEach, vi } from "vitest";

// The Auth layer is stubbed so these tests exercise Firestore behaviour rather
// than the Identity Toolkit. Note there is NO `createUser` stub any more:
// approval must never create an account, and a stub for it would let a
// regression slip through silently. `findUserByEmail` returning null is the
// "applicant never finished signup" case, which must be an error.
const authState = { existing: new Map(), createCalls: 0 };

vi.mock("../src/user-account.js", async () => {
  const actual = await vi.importActual("../src/user-account.js");
  return {
    ...actual,
    findUserByEmail: async (_sa, email) => {
      authState.createCalls += 0;
      return authState.existing.get(String(email).toLowerCase()) || null;
    },
    // If approval ever calls this, the test that asserts `createCalls === 0`
    // fails. Exposing the real one keeps that honest.
    createUser: async () => {
      authState.createCalls += 1;
      throw new Error("createUser must not be called during approval");
    },
  };
});

const { decideRequest, setTesterStatus, AcceptError } = await import("../src/accept.js");
const { STATUS, META_COLLECTION, COUNTER_DOC } = await import("../src/tester-lifecycle.js");

/** Seed the account the applicant would have created during signup. */
function seedAccount(email, over = {}) {
  const key = String(email).toLowerCase();
  const user = { uid: `uid-${authState.existing.size + 1}`, email: key, ...over };
  authState.existing.set(key, user);
  return user;
}

/**
 * In-memory Firestore modelling the REST preconditions that matter:
 * create-if-absent (409) and versioned update (409 when the doc changed).
 * Deliberately does not serialise, so concurrency is genuinely interleaved.
 *
 * `patchTester` is the dotted-path update the `tester` map needs: it merges into
 * the nested map rather than replacing the user document, which is what stops a
 * lifecycle write from clobbering `friends` / `lastLogin`.
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
    async rejectRequestAndReleaseMarker({ requestId, requestUpdateTime, patch, markerCollection, markerId }) {
      const requestKey = `requests/${requestId}`;
      const request = docs.get(requestKey);
      if (!request || request.updateTime !== requestUpdateTime) {
        const e = new Error("precondition");
        e.status = 409;
        throw e;
      }
      const markerKey = `${markerCollection}/${markerId}`;
      const released = docs.get(markerKey)?.requestId === requestId;
      docs.set(requestKey, { ...request, ...patch, updateTime: bump() });
      if (released) docs.delete(markerKey);
      return { released };
    },
    async listCollection(c) {
      return [...docs.entries()]
        .filter(([k]) => k.startsWith(`${c}/`))
        .map(([k, v]) => ({ id: k.split("/").pop(), ...v }));
    },
  };
}

const REQ = (over = {}) => ({
  name: "Alex Morgan",
  email: "alex@example.com",
  status: "pending",
  createdAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

const actor = { actorUid: "admin-1", actorEmail: "staff@crp.com" };
const ENV = { FIREBASE_SERVICE_ACCOUNT_JSON: "{}" };
/**
 * Approval payload. Deliberately carries NO password: the applicant chose their
 * own during signup, and the admin never supplies one.
 */
const approve = { ...actor, env: ENV };

const counterValue = (s) => s.docs.get(`${META_COLLECTION}/${COUNTER_DOC}`)?.lastNumber;
const userKeys = (s) => [...s.docs.keys()].filter((k) => k.startsWith("users/"));
/** Every user document that currently has a `tester` map. */
const withTester = (s) =>
  [...s.docs.entries()]
    .filter(([k, v]) => k.startsWith("users/") && v.tester)
    .map(([, v]) => v.tester);

beforeEach(() => {
  authState.existing = new Map();
  authState.createCalls = 0;
});

describe("decideRequest — rejection", () => {
  let store;
  beforeEach(() => {
    store = memoryStore({ "requests/r1": REQ() });
  });

  it("marks the request rejected and creates no tester", async () => {
    const res = await decideRequest(store, { requestId: "r1", decision: "rejected", ...actor });
    expect(res.status).toBe("rejected");
    expect(store.docs.get("requests/r1").status).toBe("rejected");
    expect(store.docs.get("requests/r1").reviewedBy).toBe("admin-1");
    // A rejection must not create a user document or an account.
    expect(userKeys(store)).toHaveLength(0);
    expect(withTester(store)).toHaveLength(0);
  });

  it("creates no account on rejection, and never deletes one", async () => {
    // A rejection must not touch Auth at all: the applicant keeps the account
    // they made at signup and can use it for a future application.
    seedAccount("alex@example.com", { uid: "uid-existing" });
    const before = authState.existing.size;

    await decideRequest(store, { requestId: "r1", decision: "rejected", env: ENV, ...actor });

    expect(authState.createCalls).toBe(0);
    // Still there, untouched — nothing was deleted or added.
    expect(authState.existing.size).toBe(before);
    expect(authState.existing.has("alex@example.com")).toBe(true);
  });

  it("burns no tester number", async () => {
    await decideRequest(store, { requestId: "r1", decision: "rejected", ...actor });
    expect(counterValue(store)).toBeUndefined();
  });

  it("writes an audit entry", async () => {
    await decideRequest(store, { requestId: "r1", decision: "rejected", ...actor });
    const audits = [...store.docs.entries()].filter(([k]) => k.startsWith("audit/"));
    expect(audits).toHaveLength(1);
    expect(audits[0][1].actor).toBe("admin-1");
  });
});

describe("decideRequest — approval", () => {
  let store;
  beforeEach(() => {
    store = memoryStore({ "requests/r1": REQ() });
    // The applicant created their own account during signup. That is the only
    // thing approval now depends on.
    seedAccount("alex@example.com", { uid: "uid-existing", displayName: "Alex Morgan" });
  });

  it("links the existing Auth account and creates the tester", async () => {
    const res = await decideRequest(store, { requestId: "r1", decision: "approved", ...approve });

    expect(res.status).toBe("approved");
    expect(res.testerNumber).toBe(1);
    // Linked to the account the applicant created, not a fresh one.
    expect(res.userId).toBe("uid-existing");

    // The tester is a MAP on the user document, addressed by the Auth uid.
    const user = store.docs.get(`users/${res.userId}`);
    expect(user).toBeDefined();
    const t = user.tester;
    expect(t.status).toBe(STATUS.ACCEPTED);
    expect(t.active).toBe(true);
    expect(t.testerNumber).toBe(1);
    expect(t.email).toBe("alex@example.com");
    expect(t.appliedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(t.acceptedAt).toBeTruthy();
  });

  it("records the uid and the t_ id inside the tester map", async () => {
    const res = await decideRequest(store, { requestId: "r1", decision: "approved", ...approve });
    const t = store.docs.get(`users/${res.userId}`).tester;
    expect(t.userId).toBe(res.userId);
    // The t_ id survives inside the map, which is what keeps Wallet object ids
    // and CRP-XXXX account ids stable across the restructure.
    expect(t.id).toBe(res.testerId);
  });

  // The security property this change exists for: approval has no code path that
  // can create an account or receive a password.
  it("never creates an Auth account", async () => {
    await decideRequest(store, { requestId: "r1", decision: "approved", ...approve });
    expect(authState.createCalls).toBe(0);
  });

  it("refuses to approve when the applicant never finished signup", async () => {
    // No account: the applicant either skipped the password step or used a
    // different address. This is a real inconsistency, so it is reported as one
    // rather than papered over by inventing an account here.
    authState.existing.clear();

    await expect(
      decideRequest(store, { requestId: "r1", decision: "approved", ...approve }),
    ).rejects.toMatchObject({ status: 409 });

    // Nothing written — no number burned, no stray user document, no account.
    expect(userKeys(store)).toHaveLength(0);
    expect(counterValue(store)).toBeUndefined();
    expect(authState.createCalls).toBe(0);
  });

  it("ignores a password sent by a stale admin dashboard", async () => {
    // The route no longer destructures `password`, so it cannot be acted on even
    // if an old cached dashboard sends one.
    const res = await decideRequest(store, {
      requestId: "r1",
      decision: "approved",
      ...approve,
      password: "admin-typed-password",
    });
    expect(res.status).toBe("approved");
    expect(authState.createCalls).toBe(0);
    // And it never reached anything that was stored.
    const user = store.docs.get(`users/${res.userId}`);
    expect(JSON.stringify(user)).not.toContain("admin-typed-password");
  });

  it("does not clobber the user's other fields", async () => {
    // The user document is shared with the main app. An approval must add
    // `tester` and leave friends / lastLogin / displayName exactly as they were.
    authState.existing.set("alex@example.com", {
      uid: "uid-existing", email: "alex@example.com", displayName: "Alex",
    });
    store.docs.set("users/uid-existing", {
      email: "alex@example.com",
      displayName: "Alex",
      friends: ["a", "b"],
      lastLogin: "2026-09-30T00:00:00.000Z",
    });

    const res = await decideRequest(store, { requestId: "r1", decision: "approved", ...approve });

    const user = store.docs.get("users/uid-existing");
    expect(user.friends).toEqual(["a", "b"]);
    expect(user.lastLogin).toBe("2026-09-30T00:00:00.000Z");
    expect(user.displayName).toBe("Alex");
    expect(user.tester.testerNumber).toBe(1);
    expect(res.userId).toBe("uid-existing");
  });

  it("sets request status and links the tester", async () => {
    const res = await decideRequest(store, { requestId: "r1", decision: "approved", ...approve });
    const req = store.docs.get("requests/r1");
    expect(req.status).toBe("approved");
    expect(req.testerId).toBe(res.testerId);
    expect(req.userId).toBe(res.userId);
    expect(req.reviewedAt).toBeTruthy();
  });

  it("increments sequentially across approvals", async () => {
    store.docs.set("requests/r2", REQ({ email: "b@example.com" }));
    store.docs.set("requests/r3", REQ({ email: "c@example.com" }));
    // Each applicant created their own account at signup.
    seedAccount("b@example.com");
    seedAccount("c@example.com");

    const n1 = (await decideRequest(store, { requestId: "r1", decision: "approved", ...approve })).testerNumber;
    const n2 = (await decideRequest(store, { requestId: "r2", decision: "approved", ...approve })).testerNumber;
    const n3 = (await decideRequest(store, { requestId: "r3", decision: "approved", ...approve })).testerNumber;

    expect([n1, n2, n3]).toEqual([1, 2, 3]);
  });

  it("gives concurrent approvals distinct numbers", async () => {
    for (let i = 0; i < 5; i += 1) {
      store.docs.set(`requests/c${i}`, REQ({ email: `c${i}@example.com` }));
      seedAccount(`c${i}@example.com`);
    }
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        decideRequest(store, { requestId: `c${i}`, decision: "approved", ...approve }),
      ),
    );
    expect(results.map((r) => r.testerNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reuses the existing number when re-approving", async () => {
    const first = await decideRequest(store, { requestId: "r1", decision: "approved", ...approve });
    store.docs.get("requests/r1").status = "pending";
    const second = await decideRequest(store, { requestId: "r1", decision: "approved", ...approve });

    // Already a tester on this account, so the number and the record stand.
    expect(second.testerNumber).toBe(first.testerNumber);
    expect(counterValue(store)).toBe(1);
  });

  it("links to an existing tester rather than duplicating", async () => {
    // Already a tester on this account. Re-applying must reuse the record.
    authState.existing.set("alex@example.com", {
      uid: "uid-existing", email: "alex@example.com", displayName: "Alex",
    });
    store.docs.set("users/uid-existing", {
      email: "alex@example.com",
      tester: {
        id: "t_other", email: "alex@example.com", testerNumber: 3,
        status: STATUS.ACCEPTED, active: true,
      },
    });

    const res = await decideRequest(store, { requestId: "r1", decision: "approved", ...approve });

    expect(res.testerId).toBe("t_other");
    expect(res.testerNumber).toBe(3);
    // Exactly one tester map across the whole collection — no second record.
    expect(withTester(store)).toHaveLength(1);
    // And no number burned for a re-application.
    expect(counterValue(store)).toBeUndefined();
  });
});

describe("decideRequest — guards", () => {
  it("rejects an unknown decision", async () => {
    const store = memoryStore({ "requests/r1": REQ() });
    await expect(
      decideRequest(store, { requestId: "r1", decision: "maybe", ...actor }),
    ).rejects.toBeInstanceOf(AcceptError);
  });

  it("404s an unknown request", async () => {
    const store = memoryStore();
    await expect(
      decideRequest(store, { requestId: "nope", decision: "approved", ...actor }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses to decide an already-decided request", async () => {
    const store = memoryStore({ "requests/r1": REQ({ status: "approved" }) });
    await expect(
      decideRequest(store, { requestId: "r1", decision: "approved", ...actor }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("setTesterStatus", () => {
  // The tester is a map on the user document, so every fixture is a user
  // document and every call is addressed by uid.
  const accepted = (over = {}) => ({
    id: "t1",
    email: "alex@example.com",
    status: STATUS.ACCEPTED,
    active: true,
    testerNumber: 7,
    acceptedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  });
  const withTester = (tester) => ({ "users/u1": { email: "alex@example.com", tester } });

  it("revoking flips status and active together", async () => {
    const store = memoryStore(withTester(accepted()));
    const res = await setTesterStatus(store, {
      userId: "u1", active: false, reason: "inactive", ...actor,
    });

    expect(res.status).toBe(STATUS.REVOKED);
    const t = store.docs.get("users/u1").tester;
    expect(t.active).toBe(false);
    expect(t.deactivationReason).toBe("inactive");
  });

  it("reactivating keeps the original acceptedAt", async () => {
    const store = memoryStore(withTester(accepted({ status: STATUS.REVOKED, active: false })));
    await setTesterStatus(store, { userId: "u1", status: STATUS.ACCEPTED, ...actor });

    const t = store.docs.get("users/u1").tester;
    expect(t.status).toBe(STATUS.ACCEPTED);
    expect(t.active).toBe(true);
    // Must not rewrite when they originally joined.
    expect(t.acceptedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(t.testerNumber).toBe(7);
  });

  it("keeps the tester number through every transition", async () => {
    const store = memoryStore(withTester(accepted()));
    await setTesterStatus(store, { userId: "u1", status: STATUS.REVOKED, reason: "x", ...actor });
    await setTesterStatus(store, { userId: "u1", status: STATUS.ACCEPTED, ...actor });
    await setTesterStatus(store, { userId: "u1", status: STATUS.REJECTED, reason: "y", ...actor });
    expect(store.docs.get("users/u1").tester.testerNumber).toBe(7);
  });

  it("leaves the user's other fields untouched", async () => {
    // The dotted-path patch is what makes this safe: a status change must not
    // rewrite friends / lastLogin on a document the main app also owns.
    const store = memoryStore({
      "users/u1": {
        email: "alex@example.com",
        friends: ["a", "b"],
        lastLogin: "2026-09-30T00:00:00.000Z",
        tester: accepted(),
      },
    });

    await setTesterStatus(store, { userId: "u1", active: false, reason: "inactive", ...actor });

    const user = store.docs.get("users/u1");
    expect(user.friends).toEqual(["a", "b"]);
    expect(user.lastLogin).toBe("2026-09-30T00:00:00.000Z");
    expect(user.tester.active).toBe(false);
  });

  it("requires a reason to reject", async () => {
    const store = memoryStore(withTester(accepted()));
    await expect(
      setTesterStatus(store, { userId: "u1", status: STATUS.REJECTED, ...actor }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an unknown status", async () => {
    const store = memoryStore(withTester(accepted()));
    await expect(
      setTesterStatus(store, { userId: "u1", status: "banished", ...actor }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a no-op transition", async () => {
    const store = memoryStore(withTester(accepted()));
    await expect(
      setTesterStatus(store, { userId: "u1", status: STATUS.ACCEPTED, ...actor }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("404s a user who is not a tester", async () => {
    // Present, but no `tester` map: removed from the programme. This is a
    // different situation from a bad id, and must not silently recreate anyone.
    const store = memoryStore({ "users/u1": { email: "alex@example.com", testerHistory: [] } });
    await expect(
      setTesterStatus(store, { userId: "u1", status: STATUS.ACCEPTED, ...actor }),
    ).rejects.toMatchObject({ status: 404 });
    // And the removed person is not quietly put back on the roster.
    expect(store.docs.get("users/u1").tester).toBeUndefined();
  });

  it("404s an unknown user", async () => {
    const store = memoryStore();
    await expect(
      setTesterStatus(store, { userId: "nope", status: STATUS.ACCEPTED, ...actor }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
