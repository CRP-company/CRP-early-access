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
import { buildSaveUrl, accountIdFor } from "./wallet.js";
import { buildAcceptanceEmail, buildRejectionEmail } from "./decision-emails.js";
import { sendEmail } from "./resend.js";

const REQUESTS = "requests";
const TESTERS = "testers";
const REQUEST_EMAILS = "requestEmails";
const AUDIT = "audit";
const ISSUER_ID = "3388000000023210330";

/**
 * The document key for an address in `requestEmails`.
 *
 * Must match js/signup.js hashEmail() exactly — the same lowercased, trimmed
 * SHA-256 hex — or the marker being deleted will not be the one the signup form
 * reads, and the person stays blocked with no visible cause.
 */
function hashEmail(email) {
  const bytes = new TextEncoder().encode(String(email).trim().toLowerCase());
  const digest = crypto.subtle.digest("SHA-256", bytes);
  return digest.then((buf) =>
    Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  );
}

const DEFAULT_FROM = "CRP Tester Program <testing@crp.company>";

/**
 * Notify the applicant of the decision.
 *
 * Best-effort by design, exactly like the acknowledgement email: the decision
 * is already durably stored, so a Resend outage must never turn a successful
 * approval into a 500 and invite a retry that would burn a second tester number.
 *
 * Idempotency: the Resend Idempotency-Key is derived from the request id and
 * the decision, so a retried call for the same request cannot produce a second
 * email. This is the same guarantee the acknowledgement email relies on.
 */
async function notifyDecision({ env, request, requestId, decision, testerNumber, saveUrl }) {
  const mail =
    decision === "approved"
      ? buildAcceptanceEmail({ name: request.name, email: request.email, testerNumber, saveUrl })
      : buildRejectionEmail({ name: request.name, email: request.email });

  try {
    const sent = await sendEmail({
      apiKey: env.RESEND_API_KEY,
      from: env.CRP_EMAIL_FROM || DEFAULT_FROM,
      to: request.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      idempotencyKey: `application-${decision}/${requestId}`,
    });

    if (!sent.ok) {
      console.error(
        "decision email failed",
        JSON.stringify({ requestId, decision, status: sent.status }),
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error(
      "decision email threw",
      JSON.stringify({ requestId, decision, message: error && error.message }),
    );
    return false;
  }
}

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

/**
 * Find an existing tester with the same email, ignoring one id.
 *
 * Removed testers are skipped. Someone who left the program and applied again
 * must get a genuinely new tester with a new number, not be linked back to
 * their archived record — which would resurrect the old number and make the
 * removal reversible by accident.
 */
async function findExistingTester(store, email, excludeId) {
  const list = await store.listCollection(TESTERS);
  const match = list.find((t) => t.email === email && t.id !== excludeId && !t.removed);
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
export async function decideRequest(store, { requestId, decision, note, actorUid, actorEmail, env }) {
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

  // Claim the request atomically before allocating anything.
  //
  // The status check above is only a fast path: two approvals that arrive
  // together both read "pending" and both pass it. Claiming with a versioned
  // precondition closes that window, so exactly one caller gets here and the
  // other sees a 409. Without this, the loser of a race would still have burned
  // a tester number before failing on the tester create.
  //
  // This writes the decision first, so a rejected request is never briefly
  // visible as pending, and the requestEmails marker is untouched either way.
  try {
    await store.updateDocument(REQUESTS, requestId, common, {
      updateTime: request.updateTime,
    });
  } catch (error) {
    if (error && (error.status === 409 || error.status === 412)) {
      const current = await store.getDocument(REQUESTS, requestId);
      throw new AcceptError(
        409,
        `This request was already ${(current && current.status) || "decided"}.`,
      );
    }
    throw error;
  }

  if (decision === "rejected") {
    // A rejected applicant never gets a tester document, so nothing to
    // promote, no number burned, and no Wallet pass. The requestEmails marker is
    // deliberately left in place, so a rejected applicant remains a known
    // applicant and cannot submit again.
    await writeAudit(store, { ...audit, action: "request.rejected" });

    const emailed = await notifyDecision({
      env,
      request,
      requestId,
      decision,
    });

    return { requestId, status: "rejected", emailed };
  }

  return acceptApplication(store, {
    request,
    requestId,
    audit,
    now,
    actorUid,
    env,
  });
}

/** The promotion half of an approval. */
async function acceptApplication(store, { request, requestId, audit, now, actorUid, env }) {
  const testerId = `t_${requestId}`;

  // If this email is already a tester under a different id, point the request
  // at the canonical record rather than creating a second one.
  const canonical = await findExistingTester(store, request.email, testerId);
  if (canonical) {
    // Status was already claimed atomically above; only the link is new here.
    await store.updateDocument(REQUESTS, requestId, { testerId: canonical });
    await writeAudit(store, { ...audit, action: "tester.linked", testerId: canonical });

    // The applicant is already on the roster, so no new number is burned — but
    // they are still accepted here, so they are still notified. Their existing
    // number and the existing Wallet object are reused, which is what makes
    // "do not create a second tester" true.
    const linked = await store.getDocument(TESTERS, canonical);
    const linkedNumber = typeof linked?.testerNumber === "number" ? linked.testerNumber : null;

    const saveUrl = linkedNumber
      ? await issueWalletPass({ store, env, testerId: canonical, testerNumber: linkedNumber, request })
      : null;

    const emailed = linkedNumber
      ? await notifyDecision({
          env,
          request,
          requestId,
          decision: "approved",
          testerNumber: linkedNumber,
          saveUrl,
        })
      : false;

    return { requestId, status: "approved", testerId: canonical, testerNumber: linkedNumber, emailed, saveUrl };
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

  // Status was already claimed atomically above; only the link is new here.
  await store.updateDocument(REQUESTS, requestId, { testerId });

  // Everything the email needs is now durably stored: the tester exists, the
  // number is allocated, and the request is decided. The Wallet pass is
  // generated after that point, and the email is sent last, so a failure in
  // either can never leave a number burned with no tester created.
  const saveUrl = await issueWalletPass({ store, env, testerId, testerNumber, request });

  const emailed = await notifyDecision({
    env,
    request,
    requestId,
    decision: "approved",
    testerNumber,
    saveUrl,
  });

  await writeAudit(store, {
    ...audit,
    action: "tester.created",
    testerId,
    detail: { ...audit.detail, testerNumber },
  });

  return { requestId, status: "approved", testerId, testerNumber, emailed, saveUrl };
}

/**
 * Generate the tester's "Save to Google Wallet" URL and stamp the tester doc.
 *
 * Reuses the existing Wallet implementation (src/wallet.js, ported from
 * functions/src/wallet.js) rather than introducing a second Wallet system. The
 * signing key is the crp-tester-card service account held in a Worker secret;
 * only the resulting URL ever leaves this function, and the private key is
 * never returned, logged, or written to Firestore.
 *
 * Best-effort: a Wallet failure must not undo an accepted application. The
 * tester already exists and the number is already allocated at this point, so
 * the failure is logged and `null` is returned; the acceptance email then
 * simply omits the button, and the admin can still issue the card by hand from
 * the dashboard.
 */
async function issueWalletPass({ store, env, testerId, testerNumber, request }) {
  try {
    const saveUrl = await buildSaveUrl({
      tester: { id: testerId, name: request.name },
      active: activeForStatus(STATUS.ACCEPTED),
      testerNumber,
      secretJson: env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON,
    });

    await store.updateDocument(TESTERS, testerId, {
      wallet: {
        issuerId: ISSUER_ID,
        classId: `${ISSUER_ID}.crp_tester_loyalty`,
        accountId: accountIdFor(testerId),
        lastIssuedAt: new Date(),
      },
    });

    return saveUrl;
  } catch (error) {
    console.error(
      "wallet pass generation failed",
      JSON.stringify({ testerId, message: error && error.message }),
    );
    return null;
  }
}

/**
 * Remove a tester from the Testing Program.
 *
 * This is deliberately NOT the same thing as deactivating, and does not touch
 * setTesterStatus(). Deactivate keeps someone in the program as `revoked`,
 * reversible, and still blocks them from re-applying. Remove is the exit
 * decision: the person leaves, and is allowed to apply again.
 *
 * What it does, in one Firestore transaction (see store.removeTester):
 *   1. archives the tester — `removed` flag, reason, who and when
 *   2. writes a permanent audit entry with testerId, number, email and actor
 *   3. deletes their requestEmails marker, releasing the duplicate protection
 *
 * What it deliberately preserves:
 *   - the tester document, so name, number, activity history and past audit
 *     entries survive. The document is archived, not deleted.
 *   - the sequential counter, so the number is never handed to anyone else.
 *     A re-approved person gets a brand new number.
 *
 * The archived tester is hidden from the active roster by the dashboard's
 * filter, and findExistingTester() skips removed testers, so a later
 * application from the same address creates a genuinely new tester rather than
 * being linked back to this one.
 *
 * @param {object} store Firestore handle.
 * @param {object} args
 * @param {string} args.testerId
 * @param {string} [args.reason]  Required: removal must be explainable.
 * @param {string} [args.actorUid] Admin uid, for the audit entry.
 * @param {string} [args.actorEmail]
 */
export async function removeTester(store, { testerId, reason, actorUid, actorEmail }) {
  if (!testerId || typeof testerId !== "string") {
    throw new AcceptError(400, "testerId is required.");
  }

  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (!cleanReason) {
    // Same rule as deactivation, and for the same reason: the audit trail is
    // only useful if it says why.
    throw new AcceptError(400, "A reason is required when removing a tester.");
  }

  const tester = await store.getDocument(TESTERS, testerId);
  if (!tester) throw new AcceptError(404, "No such tester.");

  // Idempotency: a repeat removal is a no-op, not a second archive and not a
  // second audit entry. This is the guard that makes the operation safe to retry
  // after a timeout or a double-click.
  if (tester.removed) {
    return {
      testerId,
      removed: true,
      alreadyRemoved: true,
      testerNumber: tester.testerNumber ?? null,
      releasedMarker: false,
    };
  }

  const now = new Date();
  const email = tester.email;

  // The marker key is the same hash js/signup.js writes. Without a marker there
  // is nothing to release — a tester created before markers existed, say — and
  // the removal still proceeds.
  const releaseId = email ? await hashEmail(email) : null;

  const auditEntry = {
    action: "tester.removed",
    actor: actorUid || "system",
    actorEmail: actorEmail || null,
    testerId,
    testerNumber: tester.testerNumber ?? null,
    email: email || null,
    reason: String(cleanReason).slice(0, 300),
    at: now,
    // Recorded so a future reader can see the Wallet card was revoked as part of
    // the same decision, not left live.
    walletRevoked: true,
  };

  // Archived, not deleted: the roster, number and history all stay on the
  // record; only the participation ends.
  const patch = {
    removed: true,
    removedAt: now,
    removedBy: actorUid || "system",
    removalReason: String(cleanReason).slice(0, 300),
    // Leaving the program implies not active. `status` moves to revoked so the
    // lifecycle vocabulary stays consistent and a reissue yields a REVOKED card.
    status: STATUS.REVOKED,
    active: false,
    statusChangedAt: now,
    statusChangedBy: actorUid || "system",
    deactivatedAt: now,
    deactivatedBy: actorUid || "system",
    deactivationReason: String(cleanReason).slice(0, 300),
    updatedAt: now,
  };

  try {
    await store.removeTester({
      collection: TESTERS,
      id: testerId,
      patch,
      // Version precondition: if anyone edited this tester between our read and
      // the commit, the removal fails rather than clobbering their change.
      updateTime: tester.updateTime,
      auditCollection: AUDIT,
      // Deterministic, so the create-if-absent write below fails on a retry
      // instead of appending a second removal entry.
      auditId: `removed_${testerId}`,
      auditEntry,
      releaseCollection: releaseId ? REQUEST_EMAILS : null,
      releaseId,
    });
  } catch (error) {
    if (error && (error.status === 409 || error.status === 412)) {
      // Someone changed the tester concurrently. Re-read so the retry reports
      // accurately rather than blindly clobbering.
      const current = await store.getDocument(TESTERS, testerId);
      if (current && current.removed) {
        return {
          testerId,
          removed: true,
          alreadyRemoved: true,
          testerNumber: current.testerNumber ?? null,
          releasedMarker: false,
        };
      }
      throw new AcceptError(409, "This tester changed while removing. Try again.");
    }
    throw error;
  }

  return {
    testerId,
    removed: true,
    alreadyRemoved: false,
    testerNumber: tester.testerNumber ?? null,
    email: email || null,
    // The caller reissues the card so the applicant's wallet shows REVOKED.
    // Deliberately not generated here: the transactional commit is the
    // authoritative record, and a Wallet failure must not undo a removal.
    releasedMarker: Boolean(releaseId),
  };
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
  // Deactivating must be explainable, exactly as the setTesterActive callable
  // required. Without this the dashboard could revoke a tester with no record of
  // why, which is the one thing the audit trail is for. Trimmed first, so a
  // whitespace-only reason is rejected rather than stored as "   ".
  const cleanReason = typeof reason === "string" ? reason.trim() : reason;
  if (active === false && !cleanReason) {
    throw new AcceptError(400, "A reason is required when deactivating a tester.");
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
    patch.deactivationReason = cleanReason ? String(cleanReason).slice(0, 300) : null;
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

