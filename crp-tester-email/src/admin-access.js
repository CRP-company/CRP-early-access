/**
 * Restrict the admin routes to a named set of CRP staff addresses.
 *
 * The `admin` custom claim is the primary control — it is set by a script that
 * needs a service-account key, so a visitor cannot grant it to themselves. This
 * allowlist is a second, independent gate: if the claim is ever granted too
 * widely (a test account, a contractor, a mistake in set-admin-claim.js), the
 * blast radius is capped at these two addresses instead of reaching whoever
 * happens to hold the claim.
 *
 * Why it lives here and not in the dashboard: admin.js runs in the browser, where
 * anything it enforces can be deleted with devtools. This runs in the Worker,
 * which holds the service-account key and bypasses Firestore rules, so this is
 * the only place a check like this actually means anything.
 *
 * Configured with ADMIN_EMAILS (comma-separated). Left unset, the built-in list
 * applies — an unset variable must not silently open the routes to every admin.
 */

const DEFAULT_ADMIN_EMAILS = Object.freeze([
  "amiratron5@gmail.com",
  "idogaldavid@gmail.com",
]);

/**
 * The allowlist, lowercased for comparison.
 *
 * @param {string|undefined} configured  The ADMIN_EMAILS var, comma-separated.
 * @returns {string[]}
 */
export function adminEmails(configured) {
  const raw =
    typeof configured === "string" && configured.trim()
      ? configured
      : DEFAULT_ADMIN_EMAILS.join(",");

  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Is this address allowed to use the admin routes?
 *
 * @param {string|undefined} email  From the verified ID token.
 * @param {string|undefined} configured  The ADMIN_EMAILS var.
 * @returns {boolean}
 */
export function isAllowedAdminEmail(email, configured) {
  if (typeof email !== "string") return false;
  return adminEmails(configured).includes(email.trim().toLowerCase());
}