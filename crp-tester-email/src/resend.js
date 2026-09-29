/**
 * Minimal Resend client over the REST API.
 *
 * Deliberately hand-rolled rather than using the `resend` npm package: the
 * Workers runtime has no process/Buffer polyfill by default, and this endpoint
 * needs exactly one call. `fetch` is native, so the dependency buys nothing.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Send one email.
 *
 * @param {object} options
 * @param {string} options.apiKey    RESEND_API_KEY (a Worker secret).
 * @param {string} options.from      Sender, e.g. "CRP <testing@crp.company>".
 * @param {string} options.to        Recipient address.
 * @param {string} options.subject
 * @param {string} options.html
 * @param {string} options.text
 * @param {string} options.idempotencyKey  Stable per request.
 * @returns {Promise<{ok: true, id: string} | {ok: false, status: number, message: string}>}
 */
export async function sendEmail({
  apiKey,
  from,
  to,
  subject,
  html,
  text,
  idempotencyKey,
}) {
  if (!apiKey) {
    return { ok: false, status: 500, message: "RESEND_API_KEY is not configured." };
  }

  let response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Resend dedupes on this for 24h, so a retried request for the same
        // applicant cannot produce a second email.
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
  } catch (error) {
    return {
      ok: false,
      status: 502,
      message: `Could not reach Resend: ${error.message}`,
    };
  }

  const bodyText = await response.text();

  if (!response.ok) {
    let message = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      message = parsed.message || bodyText;
    } catch {
      /* keep the raw body */
    }
    return { ok: false, status: response.status, message };
  }

  let id = "";
  try {
    id = JSON.parse(bodyText).id ?? "";
  } catch {
    /* id is only used for logging */
  }

  return { ok: true, id };
}
