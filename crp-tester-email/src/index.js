/**
 * crp-tester-email — Cloudflare Worker that sends CRP Tester Program
 * confirmation emails through Resend.
 *
 * Scope: this is an EMAIL-ONLY backend. It does not write to Firestore and
 * holds no database credentials. The browser still performs the Firestore
 * submission (js/signup.js) and then calls this Worker so the applicant gets
 * an acknowledgement. Keeping the two steps separate means a failure here can
 * never lose someone's application — the request is already stored, and the
 * email is best-effort.
 *
 * That trade-off is deliberate and has one consequence worth knowing: a
 * successful request with a failed email is not retried automatically. The
 * request is still in the queue for staff to see, so nothing is lost, but
 * re-sending a missed acknowledgement is currently a manual step.
 *
 * Secrets: RESEND_API_KEY is a Worker secret (wrangler secret put). It is
 * never written to wrangler.jsonc or committed. Locally it goes in .dev.vars,
 * which .gitignore already excludes.
 */

import { buildApplicationReceivedEmail } from "./email-template.js";
import { validateSignup, isAllowedOrigin } from "./validate.js";
import { sendEmail } from "./resend.js";
import { createFirestore } from "./firestore-rest.js";
import { requireAdmin, AuthError } from "./auth.js";
import { decideRequest, setTesterStatus } from "./accept.js";

// Only the live site may call this. Configurable so a staging deploy can point
// elsewhere, but the default is the production origin.
const DEFAULT_ALLOWED_ORIGINS = ["https://crp-company.github.io"];

const DEFAULT_FROM = "CRP Tester Program <testing@crp.company>";

// Headers the browser may send. Authorization carries the Firebase ID token on
// the admin routes, and a header outside this list is rejected by the browser
// during preflight — before the request ever reaches the Worker.
const ALLOWED_REQUEST_HEADERS = "Authorization, Content-Type";

/**
 * CORS response headers for an allowed origin.
 *
 * The origin is echoed back rather than sent as "*" because these routes are
 * authenticated with a bearer token; a wildcard would let any site read them.
 * `Vary: Origin` keeps caches from serving one origin's response to another.
 */
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": ALLOWED_REQUEST_HEADERS,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

const json = (status, payload, origin) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Never cache an API response.
      "Cache-Control": "no-store",
      // The real response needs the header too, not just the preflight: without
      // it the browser runs the request and then refuses to hand the body to
      // JavaScript. Omitted entirely for a disallowed origin, so such a caller
      // cannot read the body at all.
      ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    },
  });

function allowedOrigins(env) {
  const configured = env.ALLOWED_ORIGINS;
  if (!configured) return DEFAULT_ALLOWED_ORIGINS;
  return String(configured)
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * CORS preflight. Only the allowed origins receive the header.
 *
 * The admin routes send `Authorization`, so it must appear in
 * Access-Control-Allow-Headers here; a browser aborts a preflight whose response
 * omits a header the request actually uses.
 */
function handleOptions(request, env) {
  const origin = request.headers.get("Origin");
  if (!isAllowedOrigin(origin, allowedOrigins(env))) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

/**
 * Admin routes: /accept and /tester-status.
 *
 * These write to Firestore with a service account, which bypasses security
 * rules — the same privilege the Cloud Functions had. Verification therefore
 * happens here, before any write: the caller's Firebase ID token must be valid
 * for this project and carry the `admin` claim.
 */
async function handleAdmin(request, env, body, route, origin) {
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) return json(500, { ok: false, error: "Server not configured." }, origin);

  const sa = env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!sa) return json(500, { ok: false, error: "Server not configured." }, origin);

  let admin;
  try {
    admin = await requireAdmin(request, projectId);
  } catch (error) {
    if (error instanceof AuthError) {
      // Even a 401 needs a readable body, otherwise the dashboard shows a bare
      // CORS failure instead of "sign in again".
      return json(error.status, { ok: false, error: error.message }, origin);
    }
    throw error;
  }

  // Pinned to the same project the caller's token was verified against, so
  // authorisation and data can never drift onto different projects.
  const store = createFirestore(sa, projectId);

  if (route === "/accept") {
    const { requestId, decision, note } = body || {};
    if (!requestId || typeof requestId !== "string") {
      return json(400, { ok: false, error: "requestId is required." }, origin);
    }
    const result = await decideRequest(store, {
      requestId,
      decision,
      note,
      actorUid: admin.uid,
      actorEmail: admin.email,
      // env is needed server-side to sign the Wallet pass and to send the
      // decision email. Secrets are read here and never reach the browser.
      env,
    });
    return json(200, { ok: true, ...result }, origin);
  }

  // /tester-status
  const { testerId, status, active, reason } = body || {};
  if (!testerId || typeof testerId !== "string") {
    return json(400, { ok: false, error: "testerId is required." }, origin);
  }
  const result = await setTesterStatus(store, {
    testerId,
    status,
    active,
    reason,
    actorUid: admin.uid,
  });
  return json(200, { ok: true, ...result }, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check, so uptime probes and manual verification do not need to
    // know about the POST shape. Reports configuration state without leaking it.
    if (url.pathname === "/" || url.pathname === "/health") {
      return json(200, {
        ok: true,
        service: "crp-tester-email",
        configured: Boolean(env.RESEND_API_KEY),
        firestore: Boolean(env.FIREBASE_SERVICE_ACCOUNT_JSON),
      });
    }

    const isAdminRoute = url.pathname === "/accept" || url.pathname === "/tester-status";

    if (url.pathname !== "/send" && !isAdminRoute) {
      return json(404, { ok: false, error: "Not found." });
    }

    if (request.method === "OPTIONS") {
      return handleOptions(request, env);
    }

    if (request.method !== "POST") {
      return json(405, { ok: false, error: "Method not allowed." });
    }

    // Origin check first: this endpoint relays email, so it must not be
    // callable from arbitrary sites. The admin routes additionally require a
    // verified staff token, which is the real control.
    const origin = request.headers.get("Origin");
    if (!isAllowedOrigin(origin, allowedOrigins(env))) {
      return json(403, { ok: false, error: "Origin not allowed." });
    }

    // Past this point the origin is known-good, so echoing it back is safe and
    // lets the browser read the response.
    let body = null;
    try {
      body = await request.json();
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body." }, origin);
    }

    if (isAdminRoute) {
      try {
        return await handleAdmin(request, env, body, url.pathname, origin);
      } catch (error) {
        const status = error && (error.status || error.statusCode);
        console.error(
          "admin route failed",
          JSON.stringify({ path: url.pathname, status, message: error && error.message }),
        );
        return json(
          status && status < 600 ? status : 500,
          {
            ok: false,
            // Surface the real reason in dev so a misconfiguration is diagnosable
            // from the response, while still keeping 5xx generic in production.
            error: status === 409 || status === 404 || status === 400
              ? error.message
              : `Request failed: ${error && error.message}`,
          },
          origin,
        );
      }
    }

    // The admin routes returned above; everything here is the public /send path,
    // which validates its own payload and never touches Firestore.
    const result = validateSignup(body);
    if (!result.ok) {
      return json(400, { ok: false, error: result.error }, origin);
    }

    const { name, email, requestId } = result.value;

    const { subject, html, text } = buildApplicationReceivedEmail(
      { name, email },
      {
        logoUrl: env.CRP_EMAIL_LOGO_URL,
        heroUrl: env.CRP_EMAIL_HERO_URL,
        siteUrl: env.CRP_SITE_URL,
        privacyUrl: env.CRP_PRIVACY_URL,
      },
    );

    const sent = await sendEmail({
      apiKey: env.RESEND_API_KEY,
      from: env.CRP_EMAIL_FROM || DEFAULT_FROM,
      to: email,
      subject,
      html,
      text,
      // The request id is the natural idempotency key: one request, one email,
      // and a retry of the same request cannot produce a second.
      idempotencyKey: requestId,
    });

    if (!sent.ok) {
      // Log the detail, but return a generic message: the caller is a browser
      // and the applicant learns nothing useful from a raw Resend error.
      console.error(
        "resend send failed",
        JSON.stringify({ requestId, status: sent.status, message: sent.message }),
      );
      return json(502, { ok: false, error: "Could not send the confirmation email." }, origin);
    }

    console.log("acknowledgement sent", JSON.stringify({ requestId, id: sent.id }));

    return json(200, { ok: true, id: sent.id }, origin);
  },
};

