import { describe, it, expect, beforeEach } from "vitest";
import { decideRequest, setTesterStatus, AcceptError } from "../src/accept.js";
import { STATUS, META_COLLECTION, COUNTER_DOC } from "../src/tester-lifecycle.js";

/**
 * In-memory Firestore modelling the REST preconditions that matter:
 * create-if-absent (409) and versioned update (409 when the doc changed).
 * Deliberately does not serialise, so concurrency is genuinely interleaved.
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
const counterValue = (s) => s.docs.get(`${META_COLLECTION}/${COUNTER_DOC}`)?.lastNumber;
const testerKeys = (s) => [...s.docs.keys()].filter((k) => k.startsWith("testers/"));

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
    expect(testerKeys(store)).toHaveLength(0);
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
  });

  it("creates the tester with accepted status and a number", async () => {
    const res = await decideRequest(store, { requestId: "r1", decision: "approved", ...actor });

    expect(res.status).toBe("approved");
    expect(res.testerNumber).toBe(1);

    const t = store.docs.get(`testers/${res.testerId}`);
    expect(t.status).toBe(STATUS.ACCEPTED);
    expect(t.active).toBe(true);
    expect(t.testerNumber).toBe(1);
    expect(t.email).toBe("alex@example.com");
    expect(t.appliedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(t.acceptedAt).toBeTruthy();
  });

  it("sets request status and links the tester", async () => {
    const res = await decideRequest(store, { requestId: "r1", decision: "approved", ...actor });
    const req = store.docs.get("requests/r1");
    expect(req.status).toBe("approved");
    expect(req.testerId).toBe(res.testerId);
    expect(req.reviewedAt).toBeTruthy();
  });

  it("increments sequentially across approvals", async () => {
    store.docs.set("requests/r2", REQ({ email: "b@example.com" }));
    store.docs.set("requests/r3", REQ({ email: "c@example.com" }));

    const n1 = (await decideRequest(store, { requestId: "r1", decision: "approved", ...actor })).testerNumber;
    const n2 = (await decideRequest(store, { requestId: "r2", decision: "approved", ...actor })).testerNumber;
    const n3 = (await decideRequest(store, { requestId: "r3", decision: "approved", ...actor })).testerNumber;

    expect([n1, n2, n3]).toEqual([1, 2, 3]);
  });

  it("gives concurrent approvals distinct numbers", async () => {
    for (let i = 0; i < 5; i += 1) store.docs.set(`requests/c${i}`, REQ({ email: `c${i}@example.com` }));
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        decideRequest(store, { requestId: `c${i}`, decision: "approved", ...actor }),
      ),
    );
    expect(results.map((r) => r.testerNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reuses the existing number when re-approving", async () => {
    const first = await decideRequest(store, { requestId: "r1", decision: "approved", ...actor });
    store.docs.get("requests/r1").status = "pending";
    const second = await decideRequest(store, { requestId: "r1", decision: "approved", ...actor });

    expect(second.testerNumber).toBe(first.testerNumber);
    expect(counterValue(store)).toBe(1);
  });

  it("links to an existing tester rather than duplicating", async () => {
    store.docs.set("testers/t_other", {
      email: "alex@example.com", status: STATUS.ACCEPTED, active: true,
    });
    const res = await decideRequest(store, { requestId: "r1", decision: "approved", ...actor });
    expect(res.testerId).toBe("t_other");
    expect(testerKeys(store)).toHaveLength(1);
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
  const accepted = (over = {}) => ({
    email: "alex@example.com",
    status: STATUS.ACCEPTED,
    active: true,
    testerNumber: 7,
    acceptedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  });

  it("revoking flips status and active together", async () => {
    const store = memoryStore({ "testers/t1": accepted() });
    const res = await setTesterStatus(store, {
      testerId: "t1", active: false, reason: "inactive", ...actor,
    });

    expect(res.status).toBe(STATUS.REVOKED);
    const t = store.docs.get("testers/t1");
    expect(t.active).toBe(false);
    expect(t.deactivationReason).toBe("inactive");
  });

  it("reactivating keeps the original acceptedAt", async () => {
    const store = memoryStore({ "testers/t1": accepted({ status: STATUS.REVOKED, active: false }) });
    await setTesterStatus(store, { testerId: "t1", status: STATUS.ACCEPTED, ...actor });

    const t = store.docs.get("testers/t1");
    expect(t.status).toBe(STATUS.ACCEPTED);
    expect(t.active).toBe(true);
    // Must not rewrite when they originally joined.
    expect(t.acceptedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(t.testerNumber).toBe(7);
  });

  it("keeps the tester number through every transition", async () => {
    const store = memoryStore({ "testers/t1": accepted() });
    await setTesterStatus(store, { testerId: "t1", status: STATUS.REVOKED, reason: "x", ...actor });
    await setTesterStatus(store, { testerId: "t1", status: STATUS.ACCEPTED, ...actor });
    await setTesterStatus(store, { testerId: "t1", status: STATUS.REJECTED, reason: "y", ...actor });
    expect(store.docs.get("testers/t1").testerNumber).toBe(7);
  });

  it("requires a reason to reject", async () => {
    const store = memoryStore({ "testers/t1": accepted() });
    await expect(
      setTesterStatus(store, { testerId: "t1", status: STATUS.REJECTED, ...actor }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an unknown status", async () => {
    const store = memoryStore({ "testers/t1": accepted() });
    await expect(
      setTesterStatus(store, { testerId: "t1", status: "banished", ...actor }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a no-op transition", async () => {
    const store = memoryStore({ "testers/t1": accepted() });
    await expect(
      setTesterStatus(store, { testerId: "t1", status: STATUS.ACCEPTED, ...actor }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("404s an unknown tester", async () => {
    const store = memoryStore();
    await expect(
      setTesterStatus(store, { testerId: "nope", status: STATUS.ACCEPTED, ...actor }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
