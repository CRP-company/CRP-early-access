"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2/options");

const { db, serverTimestamp } = require("./firebase");
const audit = require("./audit");
const wallet = require("./wallet");
const { STATUS, ALL_STATUSES, isValidStatus, activeForStatus } = require("./tester-status");
const { allocateTesterNumber } = require("./tester-number");

const TESTERS = "testers";

/** Staff-only guard. See the note on requireAdmin in ./admin.js. */
function requireAdmin(request) {
  const token = request.auth?.token;
  if (!token?.admin) {
    throw new HttpsError("permission-denied", "This action is restricted to CRP staff.");
  }
  return { uid: request.auth.uid, email: token.email || null };
}

/* ------------------------------------------------------------------ *
 * Admin: activate / deactivate a tester
 * ------------------------------------------------------------------ */

/**
 * Toggle a tester's `active` flag.
 *
 * This is the only place the flag is changed from the admin side. It always
 * writes an audit entry, and deactivation requires a reason so the decision is
 * explainable later rather than a silent flag flip.
 */
exports.setTesterActive = onCall(async (request) => {
  const admin = requireAdmin(request);
  const { testerId, active, reason } = request.data || {};

  if (!testerId || typeof testerId !== "string") {
    throw new HttpsError("invalid-argument", "testerId is required.");
  }
  if (typeof active !== "boolean") {
    throw new HttpsError("invalid-argument", "active must be a boolean.");
  }
  if (active === false && !reason) {
    throw new HttpsError("invalid-argument", "A reason is required when deactivating a tester.");
  }

  const ref = db().collection(TESTERS).doc(testerId);
  const snap = await ref.get();

  if (!snap.exists) throw new HttpsError("not-found", "No such tester.");

  const patch = active
    ? {
        active: true,
        // Keep the lifecycle in step with the boolean. A tester who is
        // reactivated is "accepted" again; the original acceptedAt is left
        // alone so the history of when they joined is not rewritten.
        status: STATUS.ACCEPTED,
        statusChangedAt: serverTimestamp(),
        statusChangedBy: admin.uid,
        activatedAt: serverTimestamp(),
        deactivatedAt: null,
        deactivatedBy: null,
        deactivationReason: null,
      }
    : {
        active: false,
        // "revoked" rather than "rejected": they were accepted once and are
        // now being removed. Rejection is a decision made on a request.
        status: STATUS.REVOKED,
        statusChangedAt: serverTimestamp(),
        statusChangedBy: admin.uid,
        deactivatedAt: serverTimestamp(),
        deactivatedBy: admin.uid,
        deactivationReason: String(reason).slice(0, 300),
      };

  await ref.update({ ...patch, updatedAt: serverTimestamp() });

  await audit.record({
    actor: admin.uid,
    action: active ? "tester.activated" : "tester.revoked",
    testerId,
    detail: { reason: active ? null : reason, status: patch.status },
  });

  return { testerId, active, status: patch.status };
});

/* ------------------------------------------------------------------ *
 * Admin: set status directly
 * ------------------------------------------------------------------ */

/**
 * Set a tester's lifecycle status.
 *
 * `setTesterActive` remains the everyday toggle (accept <-> revoke) and is
 * what the dashboard's buttons use. This exists for the transitions that are
 * about the *application* rather than the membership — notably `rejected`,
 * which is a decision taken on a request and can be recorded against the
 * tester record so the outcome is visible in one place.
 *
 * A tester number is only ever assigned on acceptance and is never
 * reassigned or cleared, so the number a tester was given stays theirs even if
 * they are later rejected or revoked.
 */
exports.setTesterStatus = onCall(async (request) => {
  const admin = requireAdmin(request);
  const { testerId, status, reason } = request.data || {};

  if (!testerId || typeof testerId !== "string") {
    throw new HttpsError("invalid-argument", "testerId is required.");
  }
  if (!isValidStatus(status)) {
    throw new HttpsError(
      "invalid-argument",
      `status must be one of: ${ALL_STATUSES.join(", ")}.`,
    );
  }
  if (status === STATUS.REJECTED && !reason) {
    throw new HttpsError("invalid-argument", "A reason is required when rejecting.");
  }

  const ref = db().collection(TESTERS).doc(testerId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "No such tester.");

  const current = snap.data();
  if (current.status === status) {
    throw new HttpsError("failed-precondition", `Already ${status}.`);
  }

  const now = serverTimestamp();
  const active = activeForStatus(status);

  const patch = {
    status,
    // Derived from the status so the boolean and the lifecycle can never drift.
    active,
    statusChangedAt: now,
    statusChangedBy: admin.uid,
    updatedAt: now,
  };

  if (status === STATUS.ACCEPTED) {
    // Preserve the original acceptance time if this tester was accepted before.
    if (!current.acceptedAt) patch.acceptedAt = now;
    if (typeof current.testerNumber !== "number") {
      patch.testerNumber = await allocateTesterNumber();
    }
    patch.activatedAt = now;
    patch.deactivatedAt = null;
    patch.deactivatedBy = null;
    patch.deactivationReason = null;
  } else {
    patch.deactivatedAt = now;
    patch.deactivatedBy = admin.uid;
    patch.deactivationReason = reason ? String(reason).slice(0, 300) : null;
  }

  await ref.update(patch);

  await audit.record({
    actor: admin.uid,
    action: `tester.status.${status}`,
    testerId,
    detail: {
      from: current.status ?? null,
      to: status,
      reason: reason || null,
    },
  });

  return { testerId, status, active, testerNumber: patch.testerNumber ?? current.testerNumber ?? null };
});

/* ------------------------------------------------------------------ *
 * Google Wallet passes
 * ------------------------------------------------------------------ */

/**
 * Issue a "Save to Google Wallet" pass for a tester, driven by their `active`
 * flag. The pass state is derived from the same flag the dashboard toggles, so
 * deactivating a tester issues a REVOKED card rather than leaving a live one.
 */
async function issuePass(testerRef, data, testerId) {
  try {
    const saveUrl = wallet.buildSaveUrl(
      { id: testerId, name: data.name },
      Boolean(data.active),
    );
    await testerRef.update({
      "wallet.lastIssuedAt": serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return { saveUrl, active: Boolean(data.active) };
  } catch (error) {
    logger.error("wallet pass generation failed", { testerId, error: error && error.message });
    throw new HttpsError("internal", "Could not generate the tester card.");
  }
}

/**
 * Return a save-to-wallet URL for the caller's own tester record. Scoped by the
 * caller's verified token email, so a tester can self-serve their card without
 * needing staff rights.
 */
exports.getMyWalletPass = onCall(async (request) => {
  const token = request.auth?.token;
  if (!token?.email) {
    throw new HttpsError("unauthenticated", "Sign in to get your tester card.");
  }

  const snap = await db()
    .collection(TESTERS)
    .where("email", "==", token.email.toLowerCase())
    .limit(1)
    .get();

  if (snap.empty) throw new HttpsError("not-found", "No tester record for this account.");

  const found = snap.docs[0];
  return issuePass(found.ref, found.data(), found.id);
});

/** Issue a pass for any tester, on a tester's behalf. Staff only. */
exports.issueWalletPass = onCall(async (request) => {
  requireAdmin(request);
  const { testerId } = request.data || {};

  if (!testerId || typeof testerId !== "string") {
    throw new HttpsError("invalid-argument", "testerId is required.");
  }

  const snap = await db().collection(TESTERS).doc(testerId).get();
  if (!snap.exists) throw new HttpsError("not-found", "No such tester.");

  return issuePass(snap.ref, snap.data(), snap.id);
});

