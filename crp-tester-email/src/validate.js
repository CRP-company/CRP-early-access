/**
 * Input validation for the email endpoint.
 *
 * The Firestore security rules already constrain what a visitor can write to
 * the `requests` collection, but this Worker is a separate public HTTP surface
 * with its own attack surface. These limits mirror the rules so a crafted
 * direct call cannot push junk into someone's inbox.
 */

// Kept in step with firestore.rules validNewRequest().
const NAME_MIN = 2;
const NAME_MAX = 80;
const EMAIL_MAX = 254;
// Firestore document ids are at most 1500 bytes; cap far below that.
const REQUEST_ID_MAX = 128;

// Deliberately permissive but shaped: one @, a dot in the domain, no spaces.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Validate a signup payload.
 *
 * @param {unknown} body Parsed JSON request body.
 * @returns {{ok: true, value: {name: string, email: string, requestId: string}}
 *          |{ok: false, error: string}}
 */
export function validateSignup(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object." };
  }

  const { name, email, requestId } = body;

  if (typeof name !== "string" || typeof email !== "string") {
    return { ok: false, error: "name and email are required strings." };
  }
  if (typeof requestId !== "string" || !requestId) {
    return { ok: false, error: "requestId is required." };
  }

  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  const cleanId = requestId.trim();

  if (cleanName.length < NAME_MIN || cleanName.length > NAME_MAX) {
    return { ok: false, error: `name must be ${NAME_MIN}-${NAME_MAX} characters.` };
  }
  if (cleanEmail.length > EMAIL_MAX || !EMAIL_RE.test(cleanEmail)) {
    return { ok: false, error: "email is not a valid address." };
  }
  if (cleanId.length > REQUEST_ID_MAX) {
    return { ok: false, error: "requestId is too long." };
  }
  // A request id becomes part of the Resend Idempotency-Key header, so keep it
  // to characters that cannot break header encoding.
  if (!/^[A-Za-z0-9._-]+$/.test(cleanId)) {
    return { ok: false, error: "requestId contains invalid characters." };
  }

  return { ok: true, value: { name: cleanName, email: cleanEmail, requestId: cleanId } };
}

/**
 * Is this request from an allowed origin?
 *
 * Origin is browser-set and cannot be forged by a script, so it is a real
 * control here, not a formality. Note it is NOT a substitute for
 * authentication: a non-browser client can set any header it likes. Its job is
 * to stop other websites from silently using this Worker as a mail relay.
 *
 * @param {string | null} origin   The Origin header.
 * @param {string[]} allowedOrigins
 */
export function isAllowedOrigin(origin, allowedOrigins) {
  if (!origin) return false; // A browser always sends Origin on cross-origin POSTs.
  return allowedOrigins.includes(origin);
}
