/**
 * Tester dashboard support: roster lookup and the monthly activity threshold.
 *
 * The dashboard is the first surface where a *tester* — not staff — talks to this
 * Worker, so the trust model inverts. Nothing here accepts a caller-supplied
 * testerId: the identity always comes from the verified ID token's email, and the
 * roster is resolved from that. A tester can therefore only ever read and write
 * their own record, without the Worker having to trust anything in the body.
 */

import { activeForStatus } from "./tester-lifecycle.js";

const USERS = "users";
const TESTER_INDEX = "testerIndex";

/**
 * How many submissions a tester is asked for per calendar month.
 *
 * The landing page promises inactive testers are removed, and the README calls
 * that promise mechanical rather than remembered. Two is the floor CRP settled
 * on: enough to be a habit, low enough that it is not a chore.
 */
export const MONTHLY_TARGET = 2;

export class PortalError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The document key for an address in `testerIndex`.
 *
 * Must match hashEmail() in the dashboard client exactly — same lowercased,
 * trimmed SHA-256 hex. If the two drift, a tester resolves to no record and is
 * told they are not on the roster, with nothing to act on.
 */
export function hashEmail(email) {
  const bytes = new TextEncoder().encode(String(email).trim().toLowerCase());
  return crypto.subtle.digest("SHA-256", bytes).then((buf) =>
    Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  );
}

/** The current calendar month as "YYYY-MM", in UTC. */
export function currentPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Resolve a signed-in tester's own record from their email.
 *
 * Reads the `testerIndex` pointer first, then the user document it names, so this
 * needs exactly two reads and no listing. The index exists purely because
 * `allow list: if isAdmin()` on `users` means a tester cannot query for their own
 * record.
 *
 * The pointer now holds a `userId` — the Auth uid, which is the document id of
 * the account that owns the `tester` map. A pointer written before the move to
 * user documents carries `testerId` instead, and is rejected rather than
 * silently resolved to the wrong person.
 *
 * @returns {Promise<{id: string, userId: string} & Record<string, any>|null>}
 *   `id` is the tester id from inside the map (still used for the Wallet object
 *   id), `userId` is the account that owns it. null when the email is not on the
 *   roster at all. Throws when the pointer names an account that no longer has a
 *   tester record — a real inconsistency worth surfacing rather than papering
 *   over with a "not found".
 */
export async function findTesterByEmail(store, email) {
  const pointer = await store.getDocument(TESTER_INDEX, await hashEmail(email));
  if (!pointer) return null;

  const userId = pointer.userId;
  if (!userId) {
    // A pre-migration pointer that still names a `t_...` tester document. There
    // is no such collection any more, so this cannot be resolved to anyone.
    throw new PortalError(
      409,
      "Your tester record needs migrating. Please contact CRP so we can repair it.",
    );
  }

  const user = await store.getDocument(USERS, userId);
  if (!user || !user.tester) {
    // The account exists but has no tester map: removed from the programme, or
    // the promotion never completed. Either way there is nothing to act on.
    return null;
  }

  // Defence in depth: the index is keyed by a hash of the email, so a mismatch
  // means the index was built wrong. Never hand back the wrong person's record.
  const want = String(email).trim().toLowerCase();
  const testerEmail = user.tester.email || user.email;
  if (typeof testerEmail !== "string" || testerEmail.trim().toLowerCase() !== want) {
    throw new PortalError(409, "Your tester record does not match your email. Please contact CRP.");
  }

  return { ...user.tester, userId, id: user.tester.id || null };
}

/**
 * Can this tester submit feedback right now?
 *
 * Only an active, non-removed tester may. This is re-checked on every submission
 * rather than trusted from the dashboard, so a revoked tester cannot keep filing
 * requests by holding a page open from before the revocation.
 *
 * @returns {{allowed: boolean, reason: string|null}}
 */
export function canSubmitFeedback(tester) {
  if (!tester) return { allowed: false, reason: "not-on-roster" };
  if (tester.removed) return { allowed: false, reason: "removed" };
  // Derived from status, so it cannot disagree with the lifecycle the rest of the
  // system already trusts.
  if (!activeForStatus(tester.status)) return { allowed: false, reason: "inactive" };
  return { allowed: true, reason: null };
}

/** The vocabulary the dashboard offers. Kept in step with firestore.rules. */
export const AREAS = Object.freeze(["app", "product", "hardware", "other"]);

/**
 * Validate a feedback submission from the dashboard.
 *
 * Mirrors validNewFeedback() in firestore.rules. The rules are the real enforcement
 * point, but this check exists so the tester sees a clear message about the
 * specific field that is wrong instead of a bare permission-denied, and so
 * obviously malformed input never reaches Firestore.
 *
 * @returns {{ok: true, value: object}|{ok: false, error: string}}
 */
export function validateFeedback(body, { period = currentPeriod() } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object." };
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const text = typeof body.body === "string" ? body.body.trim() : "";
  const area = typeof body.area === "string" ? body.area : "";

  if (title.length < 3) return { ok: false, error: "Give your request a short title." };
  if (title.length > 120) return { ok: false, error: "Title must be 120 characters or fewer." };
  if (text.length < 10) return { ok: false, error: "Please describe your request in a bit more detail." };
  if (text.length > 2000) return { ok: false, error: "Description must be 2000 characters or fewer." };
  if (!AREAS.includes(area)) return { ok: false, error: "Pick which part of CRP this is about." };

  return { ok: true, value: { title, body: text, area, status: "submitted", period } };
}

/**
 * Build the feedback document, stamped with the verified owner.
 *
 * testerId and email come from the caller's token and the resolved roster record,
 * never from the request body — that is what makes the ownership check in
 * firestore.rules hold rather than merely look like it does.
 */
export function buildFeedbackDoc(validated, { tester, email }) {
  const now = new Date();
  return {
    testerId: tester.id,
    email: String(email).trim().toLowerCase(),
    title: validated.title,
    body: validated.body,
    area: validated.area,
    status: validated.status,
    // Immutable copy of the month this was filed in, so "did they hit the target
    // this month" is answerable without inferring it from createdAt and a timezone.
    period: validated.period,
    createdAt: now,
    updatedAt: now,
  };
}