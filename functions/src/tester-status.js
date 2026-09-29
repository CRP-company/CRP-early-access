"use strict";

/**
 * Tester lifecycle vocabulary.
 *
 * Defined in one place so the field cannot drift between the promotion
 * trigger, the activation callable, the activity sweep, and the dashboard.
 *
 *   pending   applied, not yet reviewed
 *   accepted  in the program (mirrors testers.active === true)
 *   rejected  turned down; no tester benefits are ever granted
 *   revoked   was accepted, later removed; a Wallet pass is issued REVOKED
 *
 * `testers.active` remains the boolean the existing rules, queries and Wallet
 * logic depend on. `status` is the richer lifecycle on top of it, and the two
 * are kept consistent: accepted <-> active true, everything else <-> false.
 */

const STATUS = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  REVOKED: "revoked",
};

const ALL_STATUSES = Object.values(STATUS);

/**
 * Is this a status we recognise?
 * @param {unknown} value
 */
function isValidStatus(value) {
  return ALL_STATUSES.includes(value);
}

/**
 * The `active` boolean that must accompany a given status.
 *
 * Centralised so no caller can accidentally write accepted + active:false,
 * which would leave a tester who appears on the roster but is revoked from
 * their Wallet card.
 *
 * @param {string} status
 * @returns {boolean}
 */
function activeForStatus(status) {
  return status === STATUS.ACCEPTED;
}

module.exports = { STATUS, ALL_STATUSES, isValidStatus, activeForStatus };
