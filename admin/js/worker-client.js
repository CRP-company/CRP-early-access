/**
 * HTTP client for the Cloudflare Worker's admin routes.
 *
 * Extracted from admin.js so the request shape is unit-testable. The dashboard
 * still owns all UI state, busy handling and error display; this module only
 * performs the request and normalises the error.
 *
 * Why the Worker: the acceptance flow runs on the Firebase Spark plan, where
 * Cloud Functions cannot be deployed at all. The Worker replaces the
 * `decideRequest` callable and verifies the same `admin` claim server-side.
 */

/**
 * POST JSON to a Worker route with the caller's Firebase ID token.
 *
 * The token is what authorises the call: the Worker writes to Firestore with a
 * service account that bypasses security rules, so it validates this token's
 * signature and the `admin` claim before touching anything.
 *
 * @param {object} options
 * @param {string} options.url        Full endpoint URL, e.g. ".../accept".
 * @param {string} options.token      Firebase ID token (a fresh or cached JWT).
 * @param {object} options.body       JSON payload.
 * @param {typeof fetch} [options.fetchImpl]  Injection point for tests.
 * @returns {Promise<object>} The parsed `{ok:true, ...}` response.
 * @throws {Error} With a human-readable `message` on any failure.
 */
export async function postToWorker({ url, token, body, fetchImpl = fetch }) {
  if (!url) {
    throw new Error("The acceptance Worker is not configured yet.");
  }
  if (!token) {
    throw new Error("Your session has expired. Sign in again.");
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // This is the authorisation. Without it the Worker returns 401.
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (networkError) {
    throw new Error("Could not reach the CRP server. Check your connection.");
  }

  // The Worker always answers with JSON, including on error paths.
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // A non-JSON body (proxy error page, gateway timeout) still needs to
    // surface as a readable message rather than "[object Object]".
    if (!response.ok) {
      throw new Error(`Request failed (${response.status}).`);
    }
    return {};
  }

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }

  return payload;
}

/**
 * Approve or reject an early access request via the Worker.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {string} options.token
 * @param {string} options.requestId
 * @param {"approved"|"rejected"} options.decision
 * @param {string} [options.note]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function decideViaWorker({ url, token, requestId, decision, note = "", fetchImpl }) {
  return postToWorker({
    url,
    token,
    body: { requestId, decision, note },
    fetchImpl,
  });
}
