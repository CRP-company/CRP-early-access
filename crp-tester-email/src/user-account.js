/**
 * Firebase Auth administration over REST, for the Worker.
 *
 * Why this exists: the tester record is no longer a top-level `testers` document
 * but a `tester` map nested inside `users/{uid}`. The uid is a Firebase Auth
 * identifier, so approving an applicant now has to resolve — and possibly
 * create — an Auth account, not just write Firestore.
 *
 * The Admin SDK is unavailable in a Worker (it needs `process` and `Buffer`), so
 * this speaks the Identity Toolkit v1 REST API directly, the same way
 * firestore-rest.js speaks Firestore. The service account's OAuth token is shared
 * with the Firestore client: it is minted once per isolate and cached in
 * oauth.js, so this module costs no extra token round-trips.
 *
 * Failure modes are normalised into UserAccountError with an HTTP-ish `status`,
 * because every caller here is an admin route that already speaks that dialect.
 */

import { getAccessToken } from "./oauth.js";

const IDENTITY_BASE = "https://identitytoolkit.googleapis.com/v1";

/** Firebase's own floor. Enforced here so the failure is a clear 400. */
export const MIN_PASSWORD_LENGTH = 6;

export class UserAccountError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Reject a password the Auth backend would refuse anyway.
 *
 * Checked up front so the admin gets "passwords must be at least 6 characters"
 * rather than a raw Google error quoting INTERNAL_ERROR.
 */
export function assertUsablePassword(password) {
  if (typeof password !== "string" || !password) {
    throw new UserAccountError(400, "A password is required to create the applicant's account.");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new UserAccountError(
      400,
      `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  // Auth accepts any non-empty string, but these are never what a human means
  // and both make the account trivially weak.
  if (/^\s+$/.test(password)) {
    throw new UserAccountError(400, "The password cannot be only whitespace.");
  }
  if (["password", "123456", "12345678"].includes(password.toLowerCase())) {
    throw new UserAccountError(400, "That password is too easy to guess. Choose another.");
  }
}

async function authHeaders(secretJson) {
  return {
    Authorization: `Bearer ${await getAccessToken(secretJson)}`,
    "Content-Type": "application/json",
  };
}

/** Pull a human-usable message out of Google's error envelope. */
function googleErrorMessage(payload, fallback) {
  const raw =
    payload?.error?.message || payload?.error?.status || payload?.error_description || "";
  // Google prefixes REST errors with the machine name, e.g.
  // "ENTITY_NOT_FOUND : No user record found for the given identifier".
  const cleaned = String(raw).replace(/^[A-Z_]+\s*:\s*/, "").trim();
  return cleaned || fallback;
}

/**
 * Find the Auth account for an email address.
 *
 * @returns {Promise<{uid: string, email: string, displayName: string|null}|null>}
 *   null when no account exists yet — which is the normal case for a brand-new
 *   applicant and must NOT be treated as an error.
 */
export async function findUserByEmail(secretJson, email) {
  const normalised = String(email || "").trim().toLowerCase();
  if (!normalised) throw new UserAccountError(400, "An email address is required.");

  const res = await fetch(`${IDENTITY_BASE}/accounts:lookup`, {
    method: "POST",
    headers: await authHeaders(secretJson),
    body: JSON.stringify({ email: [normalised] }),
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new UserAccountError(
      500,
      `Could not look up the applicant (${res.status}): ${googleErrorMessage(
        payload,
        "Firebase Auth lookup failed.",
      )}`,
    );
  }

  const users = (await res.json())?.users || [];
  if (users.length === 0) return null;

  const user = users[0];
  return {
    uid: user.localId,
    email: user.email || normalised,
    displayName: user.displayName || null,
  };
}

/**
 * Create an Auth account for a newly approved applicant.
 *
 * `emailVerified` is deliberately left at its false default. Acceptance is a
 * staff decision, not a statement that the applicant controls the mailbox, and
 * quietly marking mail verified would let them sign in with a password nobody
 * chose — without the admin ever having verified delivery.
 *
 * @returns {Promise<{uid: string, email: string, displayName: string}>}
 */
export async function createUser(secretJson, { email, password, displayName }) {
  assertUsablePassword(password);

  const normalised = String(email || "").trim().toLowerCase();
  if (!normalised) throw new UserAccountError(400, "An email address is required.");

  const body = { email: normalised, password, disabled: false };
  if (displayName) body.displayName = String(displayName).slice(0, 120);

  const res = await fetch(`${IDENTITY_BASE}/accounts`, {
    method: "POST",
    headers: await authHeaders(secretJson),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new UserAccountError(
      400,
      googleErrorMessage(
        payload,
        "Could not create the applicant's account. The password may also be rejected by Firebase.",
      ),
    );
  }

  const created = await res.json();
  return {
    uid: created.localId,
    email: created.email || normalised,
    displayName: created.displayName || displayName || null,
  };
}

/**
 * The error message when a create races another admin, or the address is taken.
 *
 * Kept as a predicate rather than a string match at the call site so the
 * decision lives next to the API contract.
 */
export function isEmailAlreadyRegistered(error) {
  return (
    error instanceof UserAccountError &&
    /already (exists|registered|in use)|EMAIL_EXISTS/i.test(String(error.message))
  );
}
