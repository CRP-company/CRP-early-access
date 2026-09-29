"use strict";

const jwt = require("jsonwebtoken");
const { logger } = require("./firebase");

/**
 * Google Wallet pass generation.
 *
 * The issuer and class ids below are copied from the existing standalone
 * `index.js` so the passes produced here are identical to the ones that
 * generator produced. Move the secrets to environment variables (see
 * `firebase functions:config:set` / Secret Manager) before going to production
 * — never commit the service account key.
 */

const ISSUER_ID = process.env.GOOGLE_WALLET_ISSUER_ID || "3388000000023210330";
const CLASS_ID = `${ISSUER_ID}.crp_tester_loyalty`;
const PROGRAM_LOGO_URI =
  process.env.GOOGLE_WALLET_PROGRAM_LOGO_URI ||
  "https://i.postimg.cc/K8zf4q4q/CRPlogo.png";
const HOMEPAGE_URI =
  process.env.GOOGLE_WALLET_HOMEPAGE_URI ||
  "https://crp-company.github.io/CRP-early-access/";

/** Load the service account key from env rather than from a file on disk. */
function loadCredentials() {
  const raw =
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
    process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error(
      "Google Wallet credentials missing. Set GOOGLE_APPLICATION_CREDENTIALS_JSON " +
        "to the service account JSON (base64 or raw) for this function.",
    );
  }

  // Accept both a raw JSON string and a base64-encoded one, since env vars
  // holding multiline PEM keys are awkward to set by hand.
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  return JSON.parse(text);
}

/**
 * A stable, human-scannable account id for a tester, e.g. "CRP-4AF9E80E".
 *
 * This appears on the physical tester card and in the barcode, so it must stay
 * clean: the internal `t_` document-id prefix is stripped and only hex-ish
 * characters are kept. Uniqueness comes from the Firestore document id rather
 * than the email, which also keeps the id stable if the tester later changes
 * their email address.
 */
function accountIdFor(testerId) {
  const compact = String(testerId).replace(/^t_/, "").replace(/[^A-Za-z0-9]/g, "");
  return `CRP-${compact.slice(0, 8).toUpperCase()}`;
}

function loyaltyClass() {
  return {
    id: CLASS_ID,
    issuerName: "CRP",
    reviewStatus: "UNDER_REVIEW",
    programName: "CRP TESTING PROGRAM",
    programLogo: { sourceUri: { uri: PROGRAM_LOGO_URI } },
    homepageUri: { uri: HOMEPAGE_URI },
    hexBackgroundColor: "#000000",
    multipleDevicesAndHoldersAllowedStatus: "MULTIPLE_HOLDERS",
  };
}

function loyaltyObject(tester, { active }) {
  const accountId = accountIdFor(tester.id);

  return {
    id: `${ISSUER_ID}.crp_tester_loyalty_${tester.id}`,
    classId: CLASS_ID,
    // REVOKED removes the pass from the user's wallet. We drive this from the
    // same `active` flag the dashboard toggles, so deactivating a tester
    // actually revokes their card instead of leaving it live.
    state: active ? "ACTIVE" : "REVOKED",
    accountId,
    accountName: tester.name || "CRP Tester",
    barcode: {
      type: "QR_CODE",
      value: accountId,
      alternateText: accountId,
    },
  };
}

/**
 * Build a "Save to Google Wallet" URL for one tester.
 *
 * @param {object} tester  Firestore tester document data, plus its `id`.
 * @param {boolean} active Whether the tester is currently active.
 * @returns {string} The save-to-wallet URL.
 */
function buildSaveUrl(tester, active) {
  const credentials = loadCredentials();

  const claims = {
    iss: credentials.client_email,
    aud: "google",
    origins: [new URL(HOMEPAGE_URI).origin],
    typ: "savetowallet",
    iat: Math.floor(Date.now() / 1000),
    payload: {
      loyaltyClasses: [loyaltyClass()],
      loyaltyObjects: [loyaltyObject(tester, { active })],
    },
  };

  const token = jwt.sign(claims, credentials.private_key, { algorithm: "RS256" });
  return `https://pay.google.com/gp/v/save/${token}`;
}

module.exports = {
  buildSaveUrl,
  accountIdFor,
  ISSUER_ID,
  CLASS_ID,
  logger,
};
