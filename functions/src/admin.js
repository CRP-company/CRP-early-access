"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions/v2/options");

const { db, serverTimestamp } = require("./firebase");
const audit = require("./audit");
const wallet = require("./wallet");
const { allocateTesterNumber } = require("./tester-number");
const { STATUS } = require("./tester-status");

/** Collection names, in one place so the requests/testers split is auditable. */
const REQUESTS = "requests";
const TESTERS = "testers";

/**
 * Guard every staff-only callable behind the `admin` custom claim, which is set
 * by scripts/set-admin-claim.js. This is a defence-in-depth check: Firestore
 * rules already deny non-admins, but a callable function runs with Admin SDK
 * rights and so bypasses rules entirely.
 */
function requireAdmin(request) {
  const token = request.auth?.token;
  if (!token?.admin) {
    throw new HttpsError("permission-denied", "This action is restricted to CRP staff.");
  }
  return { uid: request.auth.uid, email: token.email || null };
}

/* ------------------------------------------------------------------ *
 * Promotion: request -> tester
 * ------------------------------------------------------------------ */

/**
 * When a request is approved, create the matching tester record.
 *
 * This trigger is the ONLY writer of the `testers` collection. Doing promotion
 * in a trigger rather than in the admin UI means the two collections cannot
 * drift apart, even if someone edits a request directly in the Firebase console.
 *
 * The tester id is derived from the request id, so re-approving a request
 * updates the existing tester instead of creating a duplicate.
 */
exports.onRequestApproved = onDocumentUpdated(
  { document: `${REQUESTS}/{requestId}`, retry: true },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    // Only act on a genuine pending -> approved transition.
    if (before.status === after.status || after.status !== "approved") return;

    const requestId = event.params.requestId;
    const testerId = `t_${requestId}`;

    try {
      // If this email is already a tester under a different id, point the
      // request at the canonical record instead of creating a second one.
      const existing = await db()
        .collection(TESTERS)
        .where("email", "==", after.email)
        .limit(1)
        .get();

      if (!existing.empty && existing.docs[0].id !== testerId) {
        const canonicalId = existing.docs[0].id;
        await db().collection(REQUESTS).doc(requestId).update({
          testerId: canonicalId,
          updatedAt: serverTimestamp(),
        });
        logger.info("request approved for an existing tester", { requestId, testerId: canonicalId });
        return;
      }

      // Reserve a sequential tester number. Allocated only on first promotion:
      // re-approving must not burn a number, or the roster would develop gaps.
      const existingDoc = await db().collection(TESTERS).doc(testerId).get();
      const alreadyHasNumber =
        existingDoc.exists && typeof existingDoc.data().testerNumber === "number";

      const testerNumber = alreadyHasNumber
        ? existingDoc.data().testerNumber
        : await allocateTesterNumber();

      await db().collection(TESTERS).doc(testerId).set(
        {
          requestId,
          name: after.name,
          email: after.email,

          // --- CRP Tester lifecycle -----------------------------------------
          // status is the lifecycle; active is the boolean the rest of the
          // system already keys off. They are written together so they can
          // never disagree.
          status: STATUS.ACCEPTED,
          statusChangedAt: serverTimestamp(),
          statusChangedBy: after.reviewedBy || "system",
          appliedAt: after.createdAt || serverTimestamp(),
          acceptedAt: serverTimestamp(),
          testerNumber,
          // -------------------------------------------------------------------

          // The active / not-active flag: single source of truth for whether
          // this tester is currently in the program.
          active: true,
          activatedAt: serverTimestamp(),
          deactivatedAt: null,
          deactivatedBy: null,
          deactivationReason: null,
          wallet: {
            issuerId: wallet.ISSUER_ID,
            classId: wallet.CLASS_ID,
            accountId: wallet.accountIdFor(testerId),
            objectId: `${wallet.ISSUER_ID}.crp_tester_loyalty_${testerId}`,
            lastIssuedAt: null,
          },
          activity: { lastPeriod: null, comments: 0, reviews: 0 },
          createdAt: after.createdAt || serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        // merge:true so a re-approval does not wipe a manual deactivation
        // back to active, nor reset the wallet object's last-issued timestamp.
        { merge: true },
      );

      await audit.record({
        actor: after.reviewedBy || "system",
        action: "tester.created",
        testerId,
        requestId,
        detail: { email: after.email, testerNumber },
      });

      logger.info("tester promoted from request", { requestId, testerId, testerNumber });
    } catch (error) {
      logger.error("promotion failed", { requestId, error: error && error.message });
      throw error; // surface the failure so Firestore retries the trigger
    }
  },
);

/* ------------------------------------------------------------------ *
 * Admin: decide a request
 * ------------------------------------------------------------------ */

/**
 * Approve or reject an early access request.
 *
 * Approving only flips the request status — the trigger above does the
 * promotion. Rejecting is terminal and never produces a tester record.
 */
exports.decideRequest = onCall(async (request) => {
  const admin = requireAdmin(request);
  const { requestId, decision, note } = request.data || {};

  if (!requestId || typeof requestId !== "string") {
    throw new HttpsError("invalid-argument", "requestId is required.");
  }
  if (decision !== "approved" && decision !== "rejected") {
    throw new HttpsError("invalid-argument", "decision must be 'approved' or 'rejected'.");
  }

  const ref = db().collection(REQUESTS).doc(requestId);
  const snap = await ref.get();

  if (!snap.exists) throw new HttpsError("not-found", "No such request.");
  if (snap.data().status !== "pending") {
    throw new HttpsError("failed-precondition", `This request was already ${snap.data().status}.`);
  }

  await ref.update({
    status: decision,
    note: typeof note === "string" ? note.slice(0, 500) : null,
    reviewedBy: admin.uid,
    reviewedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await audit.record({
    actor: admin.uid,
    action: `request.${decision}`,
    requestId,
    detail: { note: note || null },
  });

  return { requestId, status: decision };
});
