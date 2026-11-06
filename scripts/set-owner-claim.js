#!/usr/bin/env node
"use strict";

/**
 * Grant or revoke the `owner` role / `financials` claim on a Firebase Auth user.
 *
 * This grant is what firestore.rules and the Cloudflare Worker financial routes
 * check to authorize access to the Financial Dashboard, revenue, expenses, and analytics.
 *
 * Usage:
 *   node scripts/set-owner-claim.js you@example.com
 *   node scripts/set-owner-claim.js you@example.com --revoke
 *   node scripts/set-owner-claim.js you@example.com --key <path>
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "crp-cuby-display";
const DEFAULT_KEY_PATH = path.join(os.homedir(), "crp-worker-key.json");

function loadServiceAccount(argv) {
  const explicit = argv.indexOf("--key");
  if (explicit !== -1 && argv[explicit + 1]) {
    const keyPath = path.resolve(argv[explicit + 1]);
    if (!fs.existsSync(keyPath)) {
      throw new Error(`Service account key not found at: ${keyPath}`);
    }
    return JSON.parse(fs.readFileSync(keyPath, "utf8"));
  }

  const envJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (envJson) {
    try {
      return JSON.parse(envJson);
    } catch {
      // ignore
    }
  }

  if (fs.existsSync(DEFAULT_KEY_PATH)) {
    return JSON.parse(fs.readFileSync(DEFAULT_KEY_PATH, "utf8"));
  }

  throw new Error(
    `No service account key found.\n` +
      `Provide a key with --key <path>, or set $FIREBASE_SERVICE_ACCOUNT_JSON.`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const revoke = argv.includes("--revoke");
  const target = argv.find((a) => !a.startsWith("--") && a !== argv[argv.indexOf("--key") + 1]);

  if (!target) {
    console.error("Usage: node scripts/set-owner-claim.js <email|uid> [--revoke] [--key <path>]");
    process.exit(1);
  }

  if (!getApps().length) {
    const serviceAccount = loadServiceAccount(argv);
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

  const existingClaims = user.customClaims || {};
  const claims = {
    ...existingClaims,
    admin: true, // Owners must also be staff/admin
    role: revoke ? "staff" : "owner",
    financials: !revoke,
  };

  await auth.setCustomUserClaims(user.uid, claims);

  console.log(
    revoke
      ? `Revoked financial owner role from ${user.email || user.uid}. They must sign in again.`
      : `Granted financial owner role to ${user.email || user.uid}. They must sign in again.`,
  );
}

main().catch((error) => {
  console.error("Failed:", error.message);
  process.exit(1);
});

