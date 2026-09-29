#!/usr/bin/env node
"use strict";

/**
 * Grant or revoke the `admin` custom claim on a Firebase Auth user.
 *
 * The claim is what firestore.rules and the Cloudflare Worker's admin routes
 * check, so this script is the only way to add staff.
 *
 *   node scripts/set-admin-claim.js you@example.com
 *   node scripts/set-admin-claim.js you@example.com --revoke
 *
 * Credentials come from a service-account key file, not Application Default
 * Credentials, so `gcloud` is not required. The key is read from (in order):
 *
 *   1. --key <path>, if given
 *   2. $FIREBASE_SERVICE_ACCOUNT_JSON, if it holds real JSON
 *   3. ~/crp-worker-key.json
 *
 * The key is never copied into this repository. It stays outside the project
 * tree, and .gitignore excludes the usual key filenames as a safety net.
 *
 * The user must already exist in Firebase Auth (create them in the console) —
 * this script only sets claims.
 *
 * Project alignment: the default is `crp-cuby-display`, which owns the CRP
 * site, the admin dashboard and the Auth users. `crp-tester-card` is a separate
 * Google Cloud project used for Google Wallet infrastructure; it has no Firebase
 * Auth, and a key from it cannot manage these users, so the script refuses to
 * run against it rather than failing obscurely.
 *
 * After granting, the user must sign out and back in: the claim is baked into
 * the ID token at sign-in, so an existing session keeps the old token until it
 * is refreshed.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

// The project that owns the CRP Firebase Auth users and Firestore database.
// Matches .firebaserc, wrangler.jsonc and the frontend configs.
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "crp-cuby-display";

// The Google Wallet project. Deliberately separate; named only so that a
// mistaken key produces a clear message instead of a confusing API error.
const WALLET_PROJECT_ID = "crp-tester-card";

const DEFAULT_KEY_PATH = path.join(os.homedir(), "crp-worker-key.json");

/**
 * Locate and read the service-account key.
 *
 * Returns the parsed object (not a string) so it can go straight into cert().
 * Throws a specific, actionable error rather than letting a JSON parse fail
 * with something unhelpful.
 */
function loadServiceAccount(argv) {
  const keyFlagIndex = argv.indexOf("--key");
  const explicitPath = keyFlagIndex !== -1 ? argv[keyFlagIndex + 1] : null;

  // Env var: only accept it if it actually contains JSON. Assigning
  // `process.env.X ||= undefined` would store the string "undefined", which
  // then fails to parse and masks the real problem.
  const fromEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (fromEnv && fromEnv.trim().startsWith("{")) {
    try {
      return JSON.parse(fromEnv);
    } catch (error) {
      throw new Error(
        `FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON: ${error.message}`,
      );
    }
  }

  const keyPath = explicitPath || DEFAULT_KEY_PATH;

  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `No service-account key found at ${keyPath}.\n` +
        "Download one from Google Cloud console > IAM & Admin > Service Accounts, " +
        "or pass a path with --key /path/to/key.json",
    );
  }

  let raw;
  try {
    raw = fs.readFileSync(keyPath, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${keyPath}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${keyPath} is not valid JSON: ${error.message}`);
  }

  if (!parsed.private_key || !parsed.client_email) {
    throw new Error(
      `${keyPath} does not look like a service-account key ` +
        "(missing private_key or client_email).",
    );
  }

  return parsed;
}

async function main() {
  const argv = process.argv.slice(2);
  const target = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--key");
  const revoke = argv.includes("--revoke");

  if (!target) {
    console.error(
      "Usage: node scripts/set-admin-claim.js <email|uid> [--revoke] [--key <path>]",
    );
    process.exit(1);
  }

  if (!getApps().length) {
    const serviceAccount = loadServiceAccount(argv);

    // Refuse a key from the wrong project. Two mistakes are easy here: using
    // the Google Wallet key (crp-tester-card), which has no Firebase Auth, or
    // an explicit FIREBASE_PROJECT_ID override. Both previously surfaced as an
    // opaque Google API error.
    const keyProject = serviceAccount.project_id;
    if (keyProject && keyProject !== PROJECT_ID) {
      const hint =
        keyProject === WALLET_PROJECT_ID
          ? `That is the Google Wallet project. Create a service account in ` +
            `${PROJECT_ID} instead — it is a separate project.`
          : `Expected a key for "${PROJECT_ID}".`;
      throw new Error(
        `Service account belongs to "${keyProject}", but the CRP users live in ` +
          `"${PROJECT_ID}".\n${hint}\n` +
          `Pass a key for ${PROJECT_ID} with --key <path>.`,
      );
    }

    initializeApp({
      credential: cert(serviceAccount),
      projectId: PROJECT_ID,
    });
    console.log(`Project:         ${PROJECT_ID}`);
    console.log(`Service account: ${serviceAccount.client_email}`);
  }

  const auth = getAuth();

  const user = target.includes("@")
    ? await auth.getUserByEmail(target)
    : await auth.getUser(target);

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

