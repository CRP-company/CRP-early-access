/**
 * Accept or reject an early access request.
 *
 * This replaces the `onRequestApproved` Firestore trigger. A Worker cannot
 * subscribe to Firestore events, but it does not need to: acceptance is always
 * initiated by an admin clicking Approve, so this handler runs at exactly the
 * moment the trigger used to fire. The promotion simply becomes synchronous
 * instead of reactive, which is better — the admin learns immediately if it
 * failed, rather than the failure being silent.
 *
 * The tester document shape and the `status` / `active` pairing are carried
 * over from functions/src/admin.js unchanged.
 */

import { STATUS, activeForStatus, allocateTesterNumber } from "./tester-lifecycle.js";

const REQUESTS = "requests";
const TESTERS = "testers";
const ISSUER_ID = "3388000000023210330";

export class AcceptError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Audit writes are best-effort: a logging failure must not undo the decision. */
async function writeAudit(store, entry) {
  const id = `a_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  try {
    await store.createDocument("audit", id, entry);
  } catch {
    // Intentionally swallowed.
  }
}

/** Find an existing tester with the same email, ignoring one id. */
async function findExistingTester(store, email, excludeId) {
  const list = await store.listCollection(TESTERS);
  const match = list.find((t) => t.email === email && t.id !== excludeId);
  return match ? match.id : null;
}

/**
 * Decide an application.
 *
 * @param {object} store   Firestore REST handle.
 * @param {object} args
 * @param {string} args.requestId
 * @param {"approved"|"rejected"} args.decision
 * @param {string} [args.note]
 * @param {string} args.actorUid
 * @param {string} [args.actorEmail]
 */
export async function decideRequest(store, { requestId, decision, note, actorUid, actorEmail }) {
  if (decision !== "approved" && decision !== "rejected") {
    throw new AcceptError(400, "decision must be 'approved' or 'rejected'.");
  }

  const request = await store.getDocument(REQUESTS, requestId);
  if (!request) throw new AcceptError(404, "No such request.");
  if (request.status !== "pending") {
    throw new AcceptError(409, `This request was already ${request.status}.`);
  }

  const now = new Date();
  const common = {
    status: decision,
    note: note ? String(note).slice(0, 500) : null,
    reviewedBy: actorUid || null,
    reviewedAt: now,
    updatedAt: now,
  };

  const audit = {
    actor: actorUid || "unknown",
    requestId,
    detail: { email: request.email, note: note || null },
    at: now,
  };

  if (decision === "rejected") {
    // A rejected applicant never gets a tester document, so nothing to
    // promote and no number burned.
    await store.updateDocument(REQUESTS, requestId, common);
    await writeAudit(store, { ...audit, action: "request.rejected" });
    return { requestId, status: "rejected" };
  }

  return acceptApplication(store, { request, requestId, common, audit, now, actorUid });
}

/** The promotion half of an approval. */
async function acceptApplication(store, { request, requestId, common, audit, now, actorUid }) {
  const testerId = `t_${requestId}`;

  // If this email is already a tester under a different id, point the request
  // at the canonical record rather than creating a second one.
  const canonical = await findExistingTester(store, request.email, testerId);
  if (canonical) {
    await store.updateDocument(REQUESTS, requestId, { ...common, testerId: canonical });
    await writeAudit(store, { ...audit, action: "tester.linked", testerId: canonical });
    return { requestId, status: "approved", testerId: canonical, testerNumber: null };
  }

  // Re-approving must not burn a number, or the roster would develop gaps.
  const existing = await store.getDocument(TESTERS, testerId);
  const testerNumber =
    existing && typeof existing.testerNumber === "number"
      ? existing.testerNumber
      : await allocateTesterNumber(store);

  const patch = {
    requestId,
    name: request.name,
    email: request.email,
    status: STATUS.ACCEPTED,
    statusChangedAt: now,
    statusChangedBy: actorUid || "system",
    appliedAt: request.createdAt || now,
    acceptedAt: now,
    testerNumber,
    // Derived from status, never set independently.
    active: activeForStatus(STATUS.ACCEPTED),
    activatedAt: now,
    deactivatedAt: null,
    deactivatedBy: null,
    deactivationReason: null,
    activity: existing?.activity || { lastPeriod: null, comments: 0, reviews: 0 },
    updatedAt: now,
  };

  if (existing) {
    await store.updateDocument(TESTERS, testerId, patch);
  } else {
    await store.createDocument(TESTERS, testerId, {
      ...patch,
      wallet: {
        issuerId: ISSUER_ID,
        classId: `${ISSUER_ID}.crp_tester_loyalty`,
        accountId: `CRP-${testerId.slice(2, 10).toUpperCase()}`,
        lastIssuedAt: null,
      },
      createdAt: now,
    });
  }

  await store.updateDocument(REQUESTS, requestId, { ...common, testerId });

  await writeAudit(store, {
    ...audit,
    action: "tester.created",
    testerId,
    detail: { ...audit.detail, testerNumber },
  });

  return { requestId, status: "approved", testerId, testerNumber };
}

/**
 * Set a tester's lifecycle status.
 *
 * Mirrors the setTesterStatus / setTesterActive callables, including the rule
 * that `active` is derived from `status` rather than set independently.
 */
export async function setTesterStatus(store, { testerId, status, active, reason, actorUid }) {
  const target = status || (active ? STATUS.ACCEPTED : STATUS.REVOKED);

  if (status && !Object.values(STATUS).includes(status)) {
    throw new AcceptError(400, "Unknown status.");
  }
  if (target === STATUS.REJECTED && !reason) {
    throw new AcceptError(400, "A reason is required when rejecting.");
  }

  const tester = await store.getDocument(TESTERS, testerId);
  if (!tester) throw new AcceptError(404, "No such tester.");
  if (tester.status === target) throw new AcceptError(409, `Already ${target}.`);

  const now = new Date();
  const patch = {
    status: target,
    // Derived, so the boolean can never drift from the lifecycle.
    active: activeForStatus(target),
    statusChangedAt: now,
    statusChangedBy: actorUid || "system",
    updatedAt: now,
  };

  if (patch.active) {
    // Preserve the original acceptance time; only fill it in if never set.
    if (!tester.acceptedAt) patch.acceptedAt = now;
    if (typeof tester.testerNumber !== "number") {
      patch.testerNumber = await allocateTesterNumber(store);
    }
    patch.activatedAt = now;
    patch.deactivatedAt = null;
    patch.deactivatedBy = null;
    patch.deactivationReason = null;
  } else {
    patch.deactivatedAt = now;
    patch.deactivatedBy = actorUid || "system";
    patch.deactivationReason = reason ? String(reason).slice(0, 300) : null;
  }

  await store.updateDocument(TESTERS, testerId, patch);

  await writeAudit(store, {
    actor: actorUid || "system",
    action: `tester.status.${target}`,
    testerId,
    detail: { from: tester.status ?? null, to: target, reason: reason || null },
    at: now,
  });

  return {
    testerId,
    status: target,
    active: patch.active,
    testerNumber: patch.testerNumber ?? tester.testerNumber ?? null,
  };
}

