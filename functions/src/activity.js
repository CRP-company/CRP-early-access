"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { db, serverTimestamp } = require("./firebase");
const audit = require("./audit");
const { STATUS } = require("./tester-status");

const TESTERS = "testers";

/** Period key, e.g. "2026-09". */
const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

/**
 * Record a tester's activity for a period and deactivate anyone who fell below
 * the required threshold.
 *
 * The landing page promises testers are removed if they go inactive, so this
 * enforces that mechanically rather than by memory. Every period also writes an
 * immutable record to testers/{id}/activity/{period}, which gives a history to
 * appeal against if a tester disputes the count.
 */
exports.recordActivity = onCall(async (request) => {
  const token = request.auth?.token;
  if (!token?.admin) {
    throw new HttpsError("permission-denied", "This action is restricted to CRP staff.");
  }

  const { testerId, period, comments, reviews, minimumActivity } = request.data || {};

  if (!testerId || typeof testerId !== "string") {
    throw new HttpsError("invalid-argument", "testerId is required.");
  }
  if (!PERIOD_PATTERN.test(String(period || ""))) {
    throw new HttpsError("invalid-argument", "period must look like YYYY-MM.");
  }

  const commentCount = Number.isInteger(comments) ? comments : 0;
  const reviewCount = Number.isInteger(reviews) ? reviews : 0;
  const minimum = Number.isInteger(minimumActivity) ? minimumActivity : 1;
  const total = commentCount + reviewCount;

  const ref = db().collection(TESTERS).doc(testerId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "No such tester.");

  const actor = request.auth.uid;
  const summary = { comments: commentCount, reviews: reviewCount, total, minimum };
  const fellShort = total < minimum;

  const batch = db().batch();

  // Immutable per-period record.
  batch.set(ref.collection("activity").doc(period), {
    ...summary,
    recordedBy: actor,
    recordedAt: serverTimestamp(),
  });

  batch.update(ref, {
    activity: { lastPeriod: period, comments: commentCount, reviews: reviewCount },
    updatedAt: serverTimestamp(),
  });

  // Only flip the flag if it is currently on, so a later manual reactivation is
  // not silently undone by a replayed period.
  if (fellShort && snap.data().active) {
    batch.update(ref, {
      active: false,
      // Automatic removal is a revocation, matching the manual path.
      status: STATUS.REVOKED,
      statusChangedAt: serverTimestamp(),
      statusChangedBy: actor,
      deactivatedAt: serverTimestamp(),
      deactivatedBy: actor,
      deactivationReason: `Below minimum activity for ${period} (${total}/${minimum})`,
    });
  }

  await batch.commit();

  await audit.record({
    actor,
    action: fellShort ? "tester.deactivated" : "tester.activity.recorded",
    testerId,
    detail: { period, ...summary },
  });

  return { testerId, period, ...summary, active: !fellShort };
});
