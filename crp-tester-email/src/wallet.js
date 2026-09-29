/**
 * Google Wallet pass generation for the Worker.
 *
 * This is a port of `functions/src/wallet.js` to the Workers runtime, not a
 * second Wallet system. Every value that identifies the CRP programme — the
 * issuer id, the loyalty class id, the programme name, the logo, the homepage
 * and the `ACTIVE`/`REVOKED` state rule — is read from the same env vars and
 * defaults as the original, and the JWT claim structure is byte-for-byte the
 * same. The only differences are mechanical:
 *
 *   - the RS256 signature is produced with WebCrypto instead of `jsonwebtoken`,
 *     because Workers has no `node:crypto`;
 *   - credentials come from a Worker secret rather than process.env.
 *
 * The Wallet project is deliberately separate from the Firebase project: the
 * signing key is a `crp-tester-card` service account, while Firestore is
 * `crp-cuby-display`. The two are never mixed, and this module only ever signs
 * a save URL — the private key is never returned, logged or embedded.
 */

const ISSUER_ID = "3388000000023210330";
const CLASS_ID = `${ISSUER_ID}.crp_tester_loyalty`;
const PROGRAM_LOGO_URI = "https://i.postimg.cc/K8zf4q4q/CRPlogo.png";
const HOMEPAGE_URI = "https://crp-company.github.io/CRP-early-access/";

/**
 * A stable, human-scannable account id for a tester, e.g. "CRP-4AF9E80E".
 *
 * Identical to accountIdFor() in functions/src/wallet.js. The `t_` document-id
 * prefix is stripped and only hex-ish characters kept, so the value printed on
 * the card and encoded in the barcode is stable and clean.
 */
export function accountIdFor(testerId) {
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

/**
 * The loyalty object for one tester.
 *
 * The barcode value is the account id, which is derived from the tester
 * document id, so it is stable across reissues. The tester number is carried in
 * `accountName` so the number an applicant was emailed is also visible on the
 * card itself.
 */
function loyaltyObject(tester, { active, testerNumber }) {
  const accountId = accountIdFor(tester.id);

  return {
    // One object id per tester document, so reissuing updates the same object
    // rather than minting a second Wallet object.
    id: `${ISSUER_ID}.crp_tester_loyalty_${tester.id}`,
    classId: CLASS_ID,
    // REVOKED removes the pass from the user's wallet, driven by the same
    // `active` flag the dashboard toggles.
    state: active ? "ACTIVE" : "REVOKED",
    accountId,
    accountName: testerNumber
      ? `CRP Tester #${testerNumber}`
      : tester.name || "CRP Tester",
    barcode: {
      type: "QR_CODE",
      value: accountId,
      alternateText: accountId,
    },
  };
}

const base64Url = (bytes) => {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Strip PEM armour and decode a PKCS#8 private key to raw DER bytes. */
function pemToArrayBuffer(pem) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  if (!body || body.length < 64) {
    throw new Error(
      "GOOGLE_WALLET_SERVICE_ACCOUNT_JSON holds a truncated or empty private key. " +
        "Re-set it with the full key JSON on one line.",
    );
  }
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Build a "Save to Google Wallet" URL for one tester.
 *
 * @param {object} options
 * @param {object} options.tester        `{id, name}` — the tester document.
 * @param {boolean} options.active       Whether the tester is currently active.
 * @param {number} [options.testerNumber] Sequential tester number, shown on the card.
 * @param {string} options.secretJson    Wallet service-account JSON (Worker secret).
 * @returns {string} The save-to-wallet URL.
 */
export function buildSaveUrl({ tester, active, testerNumber, secretJson }) {
  if (!secretJson) {
    throw new Error(
      "GOOGLE_WALLET_SERVICE_ACCOUNT_JSON is not configured. " +
        "Set it with: npx wrangler secret put GOOGLE_WALLET_SERVICE_ACCOUNT_JSON",
    );
  }

  const credentials = JSON.parse(secretJson);

  const claims = {
    iss: credentials.client_email,
    aud: "google",
    origins: [new URL(HOMEPAGE_URI).origin],
    typ: "savetowallet",
    iat: Math.floor(Date.now() / 1000),
    payload: {
      loyaltyClasses: [loyaltyClass()],
      loyaltyObjects: [loyaltyObject(tester, { active, testerNumber })],
    },
  };

  const header = base64Url(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  );
  const body = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${header}.${body}`;

  // Sign synchronously-awaited: WebCrypto is the only signer available here.
  return crypto.subtle
    .importKey(
      "pkcs8",
      pemToArrayBuffer(credentials.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    )
    .then((key) =>
      crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        new TextEncoder().encode(signingInput),
      ),
    )
    .then((signature) => `https://pay.google.com/gp/v/save/${signingInput}.${base64Url(signature)}`);
}

export { ISSUER_ID, CLASS_ID, PROGRAM_LOGO_URI, HOMEPAGE_URI };
