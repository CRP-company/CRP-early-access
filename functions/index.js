"use strict";

const { setGlobalOptions } = require("firebase-functions/v2/options");

/**
 * CRP early-access Cloud Functions.
 *
 * Ownership map — who may write what:
 *
 *   requests/  Written by the public (guarded by firestore.rules) and by the
 *              staff callables below. Never written by a visitor directly
 *              beyond the initial create.
 *   testers/   Written ONLY by this backend via the Admin SDK. The security
 *              rules set `allow create, update, delete: if false`, so there is
 *              no client path at all.
 *   audit/     Append-only trail written by src/audit.js.
 *
 * Because a callable function runs with Admin SDK privileges and therefore
 * bypasses Firestore rules, every callable re-checks the `admin` custom claim
 * in code as well. Two independent checks, not one.
 *
 * Region note — READ THIS BEFORE DEPLOYING.
 *
 * A Firestore trigger only fires in the SAME region as the database. If these
 * values disagree, the trigger never runs and fails completely silently: no
 * error, no log line, no email, and the Resend dashboard stays empty. That is
 * the single most confusing failure in this project, so it is checked on boot.
 *
 * Find your database's region (expect "nam5" if you never chose one):
 *
 *   firebase firestore:databases:list --project crp-cuby-display
 *
 * Then set REGION to the matching value below. A multi-region database maps to
 * the nearest functions region: nam5 -> us-central1, eur3 -> europe-west1.
 */

// Default is europe-west1. Override with CRP_FUNCTIONS_REGION when deploying
// against a database in another location.
const REGION = process.env.CRP_FUNCTIONS_REGION || "europe-west1";

setGlobalOptions({ region: REGION, maxInstances: 10 });

// Firestore multi-region names differ from functions region names, so a direct
// string comparison would report a false mismatch for the common defaults.
const EXPECTED_FIRESTORE_REGIONS = {
  "us-central1": ["us-central", "nam5"],
  "europe-west1": ["europe-west", "eur3"],
};

if (process.env.CRP_FIRESTORE_LOCATION) {
  const dbLocation = process.env.CRP_FIRESTORE_LOCATION;
  const allowed = EXPECTED_FIRESTORE_REGIONS[REGION] || [REGION];
  if (!allowed.includes(dbLocation)) {
    // Loud, because the symptom otherwise looks like "Resend is broken".
    console.warn(
      `\n\x1b[31m\x1b[1m*** REGION MISMATCH ***\x1b[0m\n` +
        `Firestore database is in "${dbLocation}" but these functions run in "${REGION}".\n` +
        `Firestore triggers only fire in the same region as the database, so\n` +
        `onRequestCreated will NEVER run: no emails, no logs, no errors.\n\n` +
        `Fix: set CRP_FUNCTIONS_REGION="${allowed[0]}" (or the nearest region to\n` +
        `"${dbLocation}") and redeploy. See README "When nothing is delivered".\n`,
    );
  }
}

const admin = require("./src/admin");
const testers = require("./src/testers");
const activity = require("./src/activity");
const email = require("./src/email");
const testerNumber = require("./src/tester-number");

module.exports = {
  // Promotion pipeline
  onRequestApproved: admin.onRequestApproved,

  // Transactional email
  onRequestCreated: email.onRequestCreated,
  onManualResend: email.onManualResend,

  // Staff operations
  decideRequest: admin.decideRequest,
  setTesterActive: testers.setTesterActive,
  setTesterStatus: testers.setTesterStatus,
  recordActivity: activity.recordActivity,
  peekNextTesterNumber: testerNumber.peekNextTesterNumber,

  // Wallet passes
  issueWalletPass: testers.issueWalletPass,
  getMyWalletPass: testers.getMyWalletPass,
};
