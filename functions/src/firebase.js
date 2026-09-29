"use strict";

const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");

/**
 * Initialise the Admin SDK once per cold start.
 *
 * In Google-hosted runtime, ADC picks up the runtime service account with no
 * configuration at all. For local scripts and the emulator you can point
 * GOOGLE_APPLICATION_CREDENTIALS at a service account key instead.
 */
function initAdmin() {
  if (getApps().length) return;

  const credentialsJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (credentialsJson) {
    initializeApp({ credential: cert(JSON.parse(credentialsJson)) });
    return;
  }

  initializeApp();
}

initAdmin();

/** @returns {import("firebase-admin/firestore").Firestore} */
function db() {
  return getFirestore();
}

/** Firebase server timestamp sentinel, usable inside update()/set() payloads. */
const serverTimestamp = FieldValue.serverTimestamp;

/** Convert a Firestore Timestamp to a plain ISO string, for logs and exports. */
function toIso(value) {
  if (!value) return null;
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  return String(value);
}

module.exports = { db, serverTimestamp, toIso, logger, FieldValue };
