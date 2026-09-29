#!/usr/bin/env node
"use strict";

/**
 * Grant or revoke the `admin` custom claim on a Firebase Auth user.
 *
 * The claim is what both firestore.rules and every callable function check, so
 * this script is the only way to add staff. Run it from the project root with
 * Application Default Credentials in place:
 *
 *   gcloud auth application-default login
 *   node scripts/set-admin-claim.js you@example.com
 *   node scripts/set-admin-claim.js you@example.com --revoke
 *
 * The user must already exist in Firebase Auth (create them in the console, or
 * via `firebase auth:import`) — this script only sets claims.
 *
 * After granting, the user must sign out and back in: the claim is baked into
 * the ID token at sign-in, so an existing session keeps the old token until it
 * is refreshed.
 */

process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||= process.env.GOOGLE_CREDENTIALS;

const { initializeApp, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GCLOUD_PROJECT ||
  "crp-early-access";

async function main() {
  const target = process.argv[2];
  const revoke = process.argv.includes("--revoke");

  if (!target || target.startsWith("--")) {
    console.error("Usage: node scripts/set-admin-claim.js <email|uid> [--revoke]");
    process.exit(1);
  }

  if (!getApps().length) initializeApp({ projectId: PROJECT_ID });
  const auth = getAuth();

  let user;
  if (target.includes("@")) {
    user = await auth.getUserByEmail(target);
  } else {
    user = await auth.getUser(target);
  }

  // Preserve any other claims already on the user rather than replacing the set.
  const claims = { ...(user.customClaims || {}), admin: !revoke };

  await auth.setCustomUserClaims(user.uid, claims);

  console.log(
    revoke
      ? `Revoked admin from ${user.email || user.uid}. They must sign in again.`
      : `Granted admin to ${user.email || user.uid}. They must sign in again.`,
  );
}

main().catch((error) => {
  console.error("Failed:", error.message);
  if (error.code === "auth/user-not-found") {
    console.error("Create the user in Firebase console > Authentication first.");
  }
  process.exit(1);
});
