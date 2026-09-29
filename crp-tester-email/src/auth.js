/**
 * Verify the caller is a CRP staff member.
 *
 * The Worker writes to Firestore with a service account, which bypasses
 * security rules — exactly like the Cloud Functions did. That makes
 * verification here the *only* thing standing between an anonymous POST and a
 * forged tester, so it is treated as a security boundary rather than a
 * formality.
 *
 * The dashboard signs in with Firebase Auth and sends its ID token in the
 * Authorization header. We validate the signature against Google's public
 * signing keys, then require the `admin` custom claim — the same check
 * `requireAdmin()` performed in the callable.
 */

import { extractSpkiFromCertificate, pemCertificateToDer, looksLikeCertificate } from "./x509.js";

const KEYS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

// Cached per isolate. Google's keys rotate rarely, and refetching on every
// request would add latency to every admin action.
let cachedKeys = null;
let cachedAt = 0;
const KEYS_TTL_MS = 60 * 60 * 1000;

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function base64UrlToBytes(segment) {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function signingKeys() {
  if (cachedKeys && Date.now() - cachedAt < KEYS_TTL_MS) return cachedKeys;

  const res = await fetch(KEYS_URL);
  if (!res.ok) throw new AuthError(503, "Could not fetch Firebase signing keys.");

  const json = await res.json();
  cachedKeys = {};
  for (const [kid, pem] of Object.entries(json)) {
    // The endpoint serves X.509 certificates, but importKey("spki") wants the
    // bare SubjectPublicKeyInfo inside one. Passing the whole certificate
    // throws a DataError that Workers reports as "Invalid SPKI input", which
    // turned every authenticated admin call into a 500. Extract the key first.
    const der = pemCertificateToDer(pem);
    const keyBytes = looksLikeCertificate(der)
      ? extractSpkiFromCertificate(der)
      : der;

    cachedKeys[kid] = await crypto.subtle.importKey(
      "spki",
      keyBytes,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }
  cachedAt = Date.now();
  return cachedKeys;
}

/** Test seam: force the next call to refetch keys. */
export function __resetKeyCache() {
  cachedKeys = null;
  cachedAt = 0;
}

/**
 * Verify a Firebase ID token and require the admin claim.
 *
 * @param {Request} request
 * @param {string} projectId
 * @returns {Promise<{uid: string, email: string}>} The caller's identity.
 * @throws {AuthError} 401 when unauthenticated/invalid, 403 when not staff.
 */
export async function requireAdmin(request, projectId) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new AuthError(401, "Missing bearer token.");

  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError(401, "Malformed token.");

  let header_;
  let payload;
  try {
    header_ = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])));
  } catch {
    throw new AuthError(401, "Malformed token.");
  }

  // Reject before the expensive signature check where possible.
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new AuthError(401, "Token expired.");
  if (header_.alg !== "RS256") throw new AuthError(401, "Unexpected token algorithm.");

  const keys = await signingKeys();
  const key = keys[header_.kid];
  if (!key) {
    // The kid may be newly rotated; refetch once before giving up.
    __resetKeyCache();
    const refreshed = await signingKeys();
    if (!refreshed[header_.kid]) throw new AuthError(401, "Unknown signing key.");
  }

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    (keys[header_.kid] || (await signingKeys())[header_.kid]),
    base64UrlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new AuthError(401, "Invalid token signature.");

  // An ID token is audience-scoped to this project; a token minted for another
  // project must not be accepted here.
  if (payload.aud !== projectId) throw new AuthError(401, "Token was not issued for this project.");

  const issuer = `https://securetoken.google.com/${projectId}`;
  if (payload.iss !== issuer) throw new AuthError(401, "Unexpected token issuer.");

  if (payload.admin !== true) {
    throw new AuthError(403, "This action is restricted to CRP staff.");
  }

  return { uid: payload.user_id || payload.sub || "", email: payload.email || "" };
}
