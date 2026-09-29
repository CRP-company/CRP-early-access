/**
 * Service account -> Google OAuth2 access token, using only WebCrypto.
 *
 * A Cloudflare Worker cannot use the Firebase Admin SDK (it needs process and
 * Buffer), but the underlying mechanism is just a JWT signed with the service
 * account's RSA key, exchanged for a bearer token. That is ~60 lines here.
 *
 * The key never appears in source or logs: it is read from a Worker secret.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/datastore";
const JWT_LIFETIME_SECONDS = 3600;

// Cached per isolate. Firestore calls several times per request, and signing an
// RSA key on every one would be wasteful.
let cached = null;

/**
 * In-flight token request, shared so concurrent callers do not stampede.
 *
 * Without this, three simultaneous requests all miss the cache and each mints
 * its own token — three network round-trips to Google's token endpoint for one
 * logical call. Caching the promise (rather than the value) collapses them.
 */
let inFlight = null;

/**
 * Strip PEM armour and base64-decode to raw DER bytes.
 *
 * @throws {Error} A clear, actionable message rather than letting atob() throw
 *   a raw base64 complaint. A malformed key here almost always means the secret
 *   was pasted with literal "\n" sequences or truncated, and that diagnosis is
 *   far more useful than "invalid base64-encoded data".
 */
function pemToArrayBuffer(pem) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");

  if (!body || body.length < 64) {
    throw new Error(
      "The service account private key looks truncated or empty. Re-set " +
        "FIREBASE_SERVICE_ACCOUNT_JSON with the full key JSON, on one line.",
    );
  }

  let binary;
  try {
    binary = atob(body);
  } catch {
    throw new Error(
      "The service account private key is not valid base64. Re-set " +
        "FIREBASE_SERVICE_ACCOUNT_JSON with the full key JSON, on one line " +
        "(see .dev.vars.example for the exact format).",
    );
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64Url(bytes) {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint a signed JWT assertion for the service account.
 * @param {{client_email: string, private_key: string}} sa
 */
async function signAssertion(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + JWT_LIFETIME_SECONDS,
  };

  const signingInput = `${base64Url(new TextEncoder().encode(JSON.stringify(header)))}.${base64Url(
    new TextEncoder().encode(JSON.stringify(claims)),
  )}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64Url(signature)}`;
}

/**
 * Get an access token for the Firestore scope, reusing the cached one until it
 * is close to expiry.
 *
 * @param {string} secretJson  Raw service account JSON, from a Worker secret.
 * @returns {Promise<string>} An OAuth2 access token.
 */
export async function getAccessToken(secretJson) {
  if (!secretJson) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not configured. " +
        "Set it with: npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON",
    );
  }

  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  // Collapse concurrent misses onto a single token request. Acceptance can
  // easily produce parallel calls, and each one would otherwise mint its own
  // token against Google's endpoint.
  if (inFlight) return inFlight;

  inFlight = mintToken(secretJson)
    .then((result) => {
      cached = result;
      return result.token;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Perform the actual token exchange. */
async function mintToken(secretJson) {
  const sa = JSON.parse(secretJson);
  const assertion = await signAssertion(sa);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Could not obtain an access token (${response.status}): ${detail}`);
  }

  const json = await response.json();
  return {
    token: json.access_token,
    // expires_in is seconds; refresh a minute early to avoid racing expiry.
    expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
  };
}

/** Test seam: forget the cached token and any in-flight request. */
export function __resetTokenCache() {
  cached = null;
  inFlight = null;
}
