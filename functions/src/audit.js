"use strict";

const { db, serverTimestamp, logger } = require("./firebase");

/**
 * Append an entry to the admin audit trail.
 *
 * Every privileged mutation in this backend goes through here, so there is
 * always a record of who did what to which tester and when. Audit writes are
 * best-effort by design: a logging failure must not roll back the operation the
 * admin actually asked for, so we log the failure and continue.
 *
 * @param {object} entry
 * @param {string} entry.actor     UID of the admin, or "system" for triggers.
 * @param {string} entry.action    e.g. "tester.activated".
 * @param {string} [entry.testerId]
 * @param {string} [entry.requestId]
 * @param {object} [entry.detail]   Action-specific context.
 */
async function record(entry) {
  try {
    await db().collection("audit").add({
      actor: entry.actor || "system",
      action: entry.action,
      testerId: entry.testerId ?? null,
      requestId: entry.requestId ?? null,
      detail: entry.detail ?? {},
      at: serverTimestamp(),
    });
  } catch (error) {
    logger.error("audit write failed", {
      action: entry.action,
      actor: entry.actor,
      error: error && error.message,
    });
  }
}

module.exports = { record };
