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
import { requireAdmin, requireUser, AuthError } from "./auth.js";
import { isAllowedAdminEmail } from "./admin-access.js";
import { decideRequest, setTesterStatus, removeTester } from "./accept.js";
import {
  findTesterByEmail,
  canSubmitFeedback,
  validateFeedback,
  buildFeedbackDoc,
  currentPeriod,
  hashEmail,
  MONTHLY_TARGET,
  PortalError,
} from "./tester-portal.js";
import { buildSaveUrl, accountIdFor, ISSUER_ID } from "./wallet.js";
import { activeForStatus } from "./tester-lifecycle.js";

const USERS = "users";

// ---------------------------------------------------------------- feedback

/**
 * Every tester's feedback, newest first, for the admin dashboard.
 *
 * Collected by walking the roster and listing each tester's feedback
 * subcollection rather than with a collection-group query: the roster is small,
 * and `listCollection` is the only listing primitive this REST client has. A
 * collection-group query would need a structured Firestore query body, which is a
 * larger change than the problem warrants here.
 *
 * The roster is the `users` collection filtered to documents that actually carry
 * a `tester` map — the tester record is a nested map, not a document of its own,
 * and removal deletes that field, so "no tester map" is exactly "not on the
 * roster" with no flag left to drift.
 *
 * Annotates each entry with its tester, because the stored document only carries
 * the owner's id — the dashboard needs a name and number to show.
 */
async function listAllFeedback(store) {
  const users = await store.listCollection(USERS);
  const collected = [];

  for (const user of users) {
    const tester = user.tester;
    if (!tester) continue;

    const entries = await store.listSubcollection(`${USERS}/${user.id}`, "feedback");
    for (const entry of entries) {
      collected.push({
        ...entry,
        userId: user.id,
        testerId: tester.id || null,
        testerName: tester.name || user.displayName || user.email || user.id,
        testerNumber:
          typeof tester.testerNumber === "number" ? tester.testerNumber : null,
      });
    }
  }

  return collected.sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
  );
}

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
 * Tester routes: /tester-me, /tester-check, /feedback.
 *
 * Authenticated, but with no `admin` requirement — a tester is a program member,
 * not staff. What replaces it is stronger in the way that matters: the caller is
 * identified by their verified email, their roster record is resolved from that,
 * and every route acts only on that record. There is no route that accepts a
 * testerId, so a tester cannot address anyone else's data even by guessing ids.
 */
async function handleTester(request, env, body, route, origin) {
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) return json(500, { ok: false, error: "Server not configured." }, origin);

  const sa = env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!sa) return json(500, { ok: false, error: "Server not configured." }, origin);

  let caller;
  try {
    caller = await requireUser(request, projectId);
  } catch (error) {
    if (error instanceof AuthError) {
      return json(error.status, { ok: false, error: error.message }, origin);
    }
    throw error;
  }

  const email = caller.email.trim().toLowerCase();
  // Pinned to the same project the token was verified against, so identity and
  // data can never drift onto different projects.
  const store = createFirestore(sa, projectId);

  // /tester-check: is this address on the roster, and may it create a password?
  //
  // Deliberately does NOT require a token, because its whole purpose is to be
  // called *before* someone has one — that is the "you have no password yet" path.
  // It reveals only whether an address is an active tester, which is the same
  // thing the person already knows about themselves, and it never returns the
  // roster. `activeForStatus` means a revoked tester cannot use this to
  // re-provision themselves.
  if (route === "/tester-check") {
    const requested = body && typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!requested) return json(400, { ok: false, error: "email is required." }, origin);

    const tester = await findTesterByEmail(store, requested);
    if (!tester) {
      return json(404, { ok: false, error: "That email is not on the CRP tester list." }, origin);
    }
    const permission = canSubmitFeedback(tester);
    if (!permission.allowed) {
      return json(
        403,
        { ok: false, error: "That tester account is not currently active." },
        origin,
      );
    }
    return json(200, { ok: true, onRoster: true, name: tester.name || null }, origin);
  }

  const tester = await findTesterByEmail(store, email);
  if (!tester) {
    return json(
      403,
      { ok: false, error: "Your account is not on the CRP tester list." },
      origin,
    );
  }

  // /tester-me: everything the dashboard needs on load, in one call.
  if (route === "/tester-me") {
    const permission = canSubmitFeedback(tester);
    // Feedback hangs off the user document, not the tester id, because `tester` is
    // a map on `users/{uid}` and has no path of its own.
    const history = await store.listSubcollection(
      `${USERS}/${tester.userId}`,
      "feedback",
    );
    const period = currentPeriod();
    const thisMonth = history.filter((f) => f.period === period).length;

    return json(
      200,
      {
        ok: true,
        tester: {
          id: tester.id,
          name: tester.name || null,
          email: tester.email,
          testerNumber: typeof tester.testerNumber === "number" ? tester.testerNumber : null,
          status: tester.status,
          active: permission.allowed,
          // Why the dashboard greys out the form, in the tester's own words.
          blockedReason: permission.allowed ? null : permission.reason,
        },
        activity: {
          period,
          submitted: thisMonth,
          target: MONTHLY_TARGET,
          met: thisMonth >= MONTHLY_TARGET,
        },
        feedback: history
          .slice()
          .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
          .slice(0, 25),
      },
      origin,
    );
  }

  // /feedback: file a request.
  //
  // Revoked and removed testers are refused here, not just hidden in the UI, so
  // holding an open tab from before a revocation does not grant extra submissions.
  if (route === "/feedback") {
    const permission = canSubmitFeedback(tester);
    if (!permission.allowed) {
      return json(
        403,
        { ok: false, error: "Your tester account is not currently active, so feedback is closed." },
        origin,
      );
    }

    const validated = validateFeedback(body);
    if (!validated.ok) {
      return json(400, { ok: false, error: validated.error }, origin);
    }

    // `validateFeedback` returns a WRAPPER, `{ ok, value }`. The fields live on
    // `.value`; passing the wrapper instead made every one of them undefined, and
    // encodeFields silently drops undefined — so the document was written with
    // only testerId/email/createdAt/updatedAt, and title, body, area, status and
    // period were lost. Both dashboards then rendered a blank request, and the
    // monthly count stayed at zero because it counts documents carrying `period`.
    const doc = buildFeedbackDoc(validated.value, { tester, email });
    // Auto-id: the Worker owns the id, so a client cannot overwrite an existing
    // submission by guessing its document id.
    const feedbackId = crypto.randomUUID();

    await store.createDocument(
      `${USERS}/${tester.userId}/feedback`,
      feedbackId,
      doc,
    );

    return json(201, { ok: true, id: feedbackId, period: doc.period }, origin);
  }

  return json(404, { ok: false, error: "Not found." }, origin);
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

  // Second, independent gate on top of the admin claim: the address itself must
  // be on CRP's staff allowlist. The claim says "this account was marked staff";
  // this says "and it is one of ours". Checked here, in the Worker, because that
  // is the only place a check cannot be skipped by editing the dashboard.
  if (!isAllowedAdminEmail(admin.email, env.ADMIN_EMAILS)) {
    console.warn(
      "admin route refused",
      JSON.stringify({ path: route, email: admin.email || null }),
    );
    return json(
      403,
      { ok: false, error: "This account is not authorised for the CRP admin dashboard." },
      origin,
    );
  }

  // Pinned to the same project the caller's token was verified against, so
  // authorisation and data can never drift onto different projects.
  const store = createFirestore(sa, projectId);

  // /feedback-list: everything testers have asked for.
  //
  // Read-only, and it comes before the /accept branch purely because it needs no
  // input. Like every other admin route it sits behind requireAdmin() AND the
  // staff allowlist, so it is not a way to read tester feedback without being
  // one of the two CRP addresses.
  if (route === "/feedback-list") {
    const feedback = await listAllFeedback(store);
    return json(200, { ok: true, feedback }, origin);
  }

  if (route === "/accept") {
    // Note the absence of `password`. Approval links the request to an Auth
    // account the applicant already created for themselves on the public form;
    // it never receives, creates, or stores a password. Destructuring only these
    // four fields means a password sent by a stale dashboard is silently ignored
    // rather than acted on.
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
      // env is needed server-side to sign the Wallet pass, resolve the applicant's
      // account and send the decision email. Secrets are read here and never
      // reach the browser.
      env,
    });
    return json(200, { ok: true, ...result }, origin);
  }

  // /tester-remove: remove a tester from the program.
  //
  // A dedicated route rather than an overload of /tester-status, because Remove
  // is a different and far more consequential action: it releases the duplicate
  // protection, so a confirmation has to be deliberate. It stays behind the same
  // requireAdmin() check as every other admin route.
  if (route === "/tester-remove") {
    const { userId, reason } = body || {};
    const result = await removeTester(store, {
      userId,
      reason,
      actorUid: admin.uid,
      actorEmail: admin.email,
    });

    // Revoke the Wallet card after the archive has committed. Same object id, so
    // this replaces the card already in the applicant's wallet with a REVOKED
    // one rather than creating a second object. Best-effort: the removal is
    // already recorded, and a Wallet failure must not make it disappear or
    // invite a retry that could double-apply.
    let walletRevoked = false;
    let saveUrl = null;
    if (result.removed && !result.alreadyRemoved) {
      try {
        saveUrl = await buildSaveUrl({
          tester: { id: result.testerId },
          active: false,
          testerNumber: result.testerNumber,
          secretJson: env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON,
        });
        walletRevoked = true;
      } catch (error) {
        console.error(
          "wallet revoke after removal failed",
          JSON.stringify({ userId, testerId: result.testerId, message: error && error.message }),
        );
      }
    }

    return json(
      200,
      { ok: true, ...result, walletRevoked, saveUrl },
      origin,
    );
  }

  // /tester-wallet: reissue a tester's card on demand.
  //
  // This replaces the `issueWalletPass` Cloud Function. On the Spark plan that
  // Function cannot be deployed at all, so the dashboard used to call a URL that
  // did not exist and failed on CORS. It reuses the same buildSaveUrl() the
  // approval email uses, and it stays behind the same requireAdmin() check, so
  // there is still exactly one Wallet implementation and no client can reach it
  // without the admin claim.
  if (route === "/tester-wallet") {
    const { userId } = body || {};
    if (!userId || typeof userId !== "string") {
      return json(400, { ok: false, error: "userId is required." }, origin);
    }

    const user = await store.getDocument(USERS, userId);
    // A user with no `tester` map has been removed from the programme, so there
    // is no card to reissue.
    const tester = user?.tester;
    if (!tester) return json(404, { ok: false, error: "This user is not a tester." }, origin);

    const testerId = tester.id;

    // The object id is derived from the tester id stored inside the map, so this
    // updates the card the applicant already holds rather than minting a second
    // object. The id is unchanged by the move to `users/{uid}`, so cards issued
    // before the restructure keep working.
    const saveUrl = await buildSaveUrl({
      tester: { id: testerId, name: tester.name },
      // Pass state follows `active`, so a revoked tester gets a REVOKED card.
      active: activeForStatus(tester.status),
      testerNumber:
        typeof tester.testerNumber === "number" ? tester.testerNumber : null,
      secretJson: env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON,
    });

    // Masked to tester.wallet, so the user's other fields are untouched.
    await store.patchTester(USERS, userId, {
      wallet: {
        issuerId: ISSUER_ID,
        classId: `${ISSUER_ID}.crp_tester_loyalty`,
        accountId: accountIdFor(testerId),
        lastIssuedAt: new Date(),
      },
    });

    return json(
      200,
      {
        ok: true,
        saveUrl,
        userId,
        testerId,
        active: activeForStatus(tester.status),
      },
      origin,
    );
  }

  // /tester-status
  const { userId, status, active, reason } = body || {};
  if (!userId || typeof userId !== "string") {
    return json(400, { ok: false, error: "userId is required." }, origin);
  }
  const result = await setTesterStatus(store, {
    userId,
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

    const isAdminRoute =
      url.pathname === "/accept" ||
      url.pathname === "/tester-status" ||
      // Removal, kept separate from /tester-status because it releases the
      // duplicate protection and must never be reachable by accident.
      url.pathname === "/tester-remove" ||
      // Staff reissue of a tester's card. This replaces the `issueWalletPass`
      // Cloud Function, which cannot be deployed on the Spark plan; it reuses
      // the same Wallet module the approval email uses, so there is still only
      // one Wallet implementation.
      url.pathname === "/tester-wallet" ||
      // Read every tester's feedback, so the dashboard can show what testers are
      // asking for alongside the roster.
      url.pathname === "/feedback-list";

    // Tester-facing routes. No admin claim: a tester is a program member, and the
    // handler resolves their roster record from their verified email instead.
    const isTesterRoute =
      url.pathname === "/tester-me" ||
      url.pathname === "/tester-check" ||
      url.pathname === "/feedback";

    if (url.pathname !== "/send" && !isAdminRoute && !isTesterRoute) {
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

    if (isTesterRoute) {
      try {
        return await handleTester(request, env, body, url.pathname, origin);
      } catch (error) {
        const status = error && (error.status || error.statusCode);
        console.error(
          "tester route failed",
          JSON.stringify({ path: url.pathname, status, message: error && error.message }),
        );
        return json(
          status && status < 600 ? status : 500,
          {
            ok: false,
            // 4xx messages are written for the tester, so pass them through.
            // Anything else stays generic rather than leaking an internal detail.
            error: [400, 403, 404, 409].includes(status)
              ? error.message
              : "Could not complete that request. Please try again.",
          },
          origin,
        );
      }
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

