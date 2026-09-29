"use strict";

const { Resend } = require("resend");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");

// Import the logger from the shared module rather than firebase-functions/
// v2/options: the latter is only populated inside a deployed runtime, so
// importing it here would make this module unloadable from tests and scripts.
const { db, serverTimestamp, logger } = require("./firebase");
const audit = require("./audit");
const { buildApplicationReceivedEmail } = require("./email-template");

/**
 * Send the "application received" acknowledgement through Resend.
 *
 * Runs as a Firestore trigger rather than in the browser, for two reasons:
 * the API key must never be shipped to visitors, and the browser cannot know
 * whether delivery actually succeeded.
 *
 * Retry safety: Firestore triggers are at-least-once, so a transient Resend
 * error would otherwise resend to a real applicant. Two layers prevent that —
 * a Firestore flag so we skip anything already sent, and a Resend idempotency
 * key so a duplicate inside Resend's 24h window is collapsed server-side too.
 */

const FROM = process.env.CRP_EMAIL_FROM || "CRP <onboarding@resend.dev>";

/**
 * Lazily construct the client so a missing key fails per-send, not at import.
 *
 * `resendClient` is a module-level binding the send path reads on every call
 * rather than capturing, which is what lets the test suite swap in a stub
 * without touching the network.
 */
let resendClient = null;
function getClient() {
  if (!resendClient) {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      throw new Error(
        "RESEND_API_KEY is not set. Add it with: firebase functions:secrets:set RESEND_API_KEY",
      );
    }
    resendClient = new Resend(key);
  }
  return resendClient;
}

/** Test seam: inject a fake Resend client. */
function __setClientForTesting(client) {
  resendClient = client;
}

/**
 * Send the acknowledgement for one request.
 *
 * @param {object} request  Firestore request document data.
 * @param {string} requestId
 * @returns {Promise<{skipped?: string, id?: string}>}
 */
async function sendApplicationReceived(request, requestId) {
  const ref = db().collection("requests").doc(requestId);

  // Belt and braces: skip anything a previous attempt already sent. This also
  // covers a manual re-run of the trigger from the console.
  const current = await ref.get();
  if (current.exists && current.data().acknowledgementSentAt) {
    return { skipped: "already-sent" };
  }

  const { subject, html, text } = buildApplicationReceivedEmail({
    name: request.name,
    email: request.email,
  });

  const { data, error } = await getClient().emails.send(
    {
      from: FROM,
      to: [request.email],
      subject,
      html,
      text,
      // Lets a client thread the conversation back to this specific request.
      headers: { "X-Entity-Ref-ID": requestId },
      tags: [{ name: "category", value: "application-received" }],
    },
    {
      // Stable per request, so a retry resolves to the same email.
      idempotencyKey: `application-received/${requestId}`,
    },
  );

  if (error) {
    // Throwing makes Firestore retry with backoff. Log first so a permanent
    // failure (bad address, unverified domain) stays diagnosable.
    logger.error("resend failed", {
      requestId,
      statusCode: error.statusCode,
      message: error.message,
    });
    throw new Error(`Resend rejected the email: ${error.message}`);
  }

  await ref.update({
    acknowledgementSentAt: serverTimestamp(),
    acknowledgementResendId: data.id,
  });

  await audit.record({
    actor: "system",
    action: "request.acknowledged",
    requestId,
    detail: { email: request.email, resendId: data.id },
  });

  logger.info("acknowledgement sent", { requestId, resendId: data.id });
  return { id: data.id };
}

/** Firestore trigger: a new public request just landed. */
exports.onRequestCreated = onDocumentCreated(
  {
    document: "requests/{requestId}",
    retry: true,
    // Declaring the secret is what binds it into this function's environment
    // at runtime. Without this line the key exists in Secret Manager but
    // process.env.RESEND_API_KEY stays undefined and every send throws.
    secrets: ["RESEND_API_KEY"],
  },
  async (event) => {
    const request = event.data.data();
    if (!request) return;

    // Only acknowledge genuine public submissions. The rules already force
    // status to "pending", but checking keeps this correct if they are relaxed.
    if (request.status !== "pending") return;

    // A filled honeypot means a bot. The rules let it through (a bot that
    // ignores CSS fills every field), so refuse to do the bot's work for it.
    if (request.website) {
      logger.info("skipping acknowledgement for honeypot submission", {
        requestId: event.params.requestId,
      });
      return;
    }

    await sendApplicationReceived(request, event.params.requestId);
  },
);

/**
 * Staff-triggered resend, for when an applicant says they never got it.
 *
 * Uses no idempotency key, unlike the automatic path, so this genuinely sends
 * again instead of being swallowed by Resend's 24h dedupe window.
 *
 * Triggered by adding a document to `manualResends/{anyId}` containing
 * `{ requestId: "..." }` — no deploy needed, and the Admin SDK bypasses rules.
 */
exports.onManualResend = onDocumentCreated(
  {
    document: "manualResends/{resendId}",
    retry: false,
    secrets: ["RESEND_API_KEY"],
  },
  async (event) => {
    const { requestId } = event.data.data() || {};
    if (!requestId) return;

    const snap = await db().collection("requests").doc(requestId).get();
    if (!snap.exists) throw new Error(`No such request: ${requestId}`);

    const request = snap.data();
    const { subject, html, text } = buildApplicationReceivedEmail({
      name: request.name,
      email: request.email,
    });

    const { data, error } = await getClient().emails.send({
      from: FROM,
      to: [request.email],
      subject,
      html,
      text,
    });

    if (error) {
      throw new Error(`Resend rejected the manual resend: ${error.message}`);
    }

    await snap.ref.update({
      acknowledgementManualResendAt: serverTimestamp(),
      acknowledgementManualResendId: data.id,
    });

    logger.info("manual acknowledgement resent", { requestId, resendId: data.id });
    return { id: data.id };
  },
);

// Exported for tests and for reuse by other handlers. Note this must come
// AFTER the `exports.x = ...` trigger assignments above, or it replaces the
// whole exports object and silently drops them.
module.exports = {
  ...module.exports,
  sendApplicationReceived,
  getClient,
  __setClientForTesting,
  FROM,
};
