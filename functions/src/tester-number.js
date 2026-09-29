"use strict";

const { db, serverTimestamp, logger } = require("./firebase");

/**
 * Sequential tester numbers.
 *
 * A plain "read the highest number, add one" is not safe: two admins
 * accepting applicants at the same time would both read the same maximum and
 * hand out the same number. This allocates inside a transaction, so Firestore
 * serialises concurrent allocations and the counter can never double-allocate.
 *
 * Storage is a single counter document rather than a new collection of
 * testers. It holds one integer and is not user data.
 */

const COUNTER_DOC = "testerCounter";

/** Where the counter lives. Kept here so the path is greppable. */
const META_COLLECTION = "meta";

/**
 * Reserve the next tester number.
 *
 * @returns {Promise<number>} A positive integer, unique across all allocations.
 */
async function allocateTesterNumber() {
  const ref = db().collection(META_COLLECTION).doc(COUNTER_DOC);

  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data().lastNumber : 0;

    // Defensive: a non-numeric or negative value would poison every future
    // allocation, so refuse to build on it.
    if (typeof current !== "number" || !Number.isInteger(current) || current < 0) {
      throw new Error(
        `testerNumber counter is corrupt (lastNumber=${current}). ` +
          `Fix or delete ${META_COLLECTION}/${COUNTER_DOC} before accepting more testers.`,
      );
    }

    const next = current + 1;
    tx.set(ref, { lastNumber: next, updatedAt: serverTimestamp() }, { merge: true });
    return next;
  });
}

/**
 * The highest number handed out so far, or 0 if none. Read-only, for the
 * dashboard's "next number" hint. Not transactional, so it is informational
 * only — never use it to allocate.
 */
async function peekNextTesterNumber() {
  const snap = await db().collection(META_COLLECTION).doc(COUNTER_DOC).get();
  const last = snap.exists ? snap.data().lastNumber : 0;
  return typeof last === "number" ? last + 1 : 1;
}

module.exports = { allocateTesterNumber, peekNextTesterNumber, META_COLLECTION };
