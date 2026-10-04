/**
 * CRP early-access admin dashboard.
 *
 * Shows the two sides of the roster: `requests` is the raw public intake queue,
 * and the accepted testers are the `users` documents that carry a `tester` map.
 * The tester record is a nested map on the account, not a document of its own,
 * so every row is read one level down and every action is addressed by the
 * user's Auth uid.
 *
 * The active / not-active flag lives only inside `tester`.
 *
 * Security: the dashboard never writes to Firestore directly. Reads are allowed
 * by the `admin` custom claim; every mutation goes through the authenticated
 * Cloudflare Worker, which re-checks that claim server-side. A tampered client
 * therefore cannot approve a request, flip a status, or hand anyone a tester
 * map by writing `users.tester` directly — the security rules deny that to
 * clients entirely.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";
import { decideViaWorker, postToWorker } from "./worker-client.js";
import { experienceCategoryDisplay } from "./experience-category.js";

const els = {
  login: document.getElementById("login-view"),
  app: document.getElementById("app-view"),
  loginForm: document.getElementById("login-form"),
  loginEmail: document.getElementById("login-email"),
  loginPassword: document.getElementById("login-password"),
  loginError: document.getElementById("login-error"),
  signOutBtn: document.getElementById("sign-out"),
  requestsBody: document.getElementById("requests-body"),
  requestsCount: document.getElementById("requests-count"),
  testersBody: document.getElementById("testers-body"),
  testersCount: document.getElementById("testers-count"),
  activeCount: document.getElementById("active-count"),
  requestFilter: document.getElementById("request-filter"),
  testerFilter: document.getElementById("tester-filter"),
  toast: document.getElementById("toast"),
  requestDetails: document.getElementById("request-details"),
  requestDetailsContent: document.getElementById("request-details-content"),
  requestDetailsClose: document.getElementById("request-details-close"),
  feedbackBody: document.getElementById("feedback-body"),
  feedbackCount: document.getElementById("feedback-count"),
  feedbackFilter: document.getElementById("feedback-filter"),
};

const AREA_LABELS = {
  app: "CRP Focus app",
  product: "Product",
  hardware: "Hardware",
  other: "Other",
};

let allFeedback = [];

let auth = null;
let db = null;
let currentRequests = new Map();

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function isConfigured() {
  return firebaseConfig.projectId && !firebaseConfig.projectId.startsWith("REPLACE_ME");
}

function toast(message, kind = "ok") {
  els.toast.textContent = message;
  els.toast.className = `toast toast--${kind} show`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove("show"), 4000);
}

/**
 * Normalise any stored timestamp to milliseconds, for comparison.
 *
 * `acceptedAt` is not one type. The REST client decodes Firestore timestamps to
 * ISO strings; the Firestore SDK hands back a Timestamp object; records written
 * before either may hold a Date, a bare string, or nothing at all. Sorting with
 * `localeCompare` assumed a string and threw a TypeError on a Timestamp, which
 * took the whole roster down with it.
 *
 * Returns a number so callers can subtract. Anything unparseable — including
 * null, undefined and a missing field — becomes 0, which sorts it consistently
 * to the end rather than crashing the render.
 */
function timestampValue(value) {
  if (value === null || value === undefined) return 0;
  // Date first: a Date is `typeof "object"`, so it would otherwise be swallowed
  // by the branch below and come back as 0.
  if (value instanceof Date) return value.getTime();
  // Firestore Timestamp, and the bare {seconds} shape some records carry.
  if (typeof value === "object") {
    if (typeof value.toMillis === "function") return value.toMillis();
    if (typeof value.toDate === "function") return value.toDate().getTime();
    if (typeof value.seconds === "number") return value.seconds * 1000;
    return 0;
  }
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatDate(value) {
  const ms = timestampValue(value);
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

/** Escape untrusted values before putting them anywhere near the DOM. */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function setBusy(button, busy) {
  button.disabled = busy;
  if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
  button.textContent = busy ? "Working…" : button.dataset.originalText;
}

/* ------------------------------------------------------------------ *
 * Renders
 * ------------------------------------------------------------------ */

function renderRequests(snapshot) {
  els.requestsBody.innerHTML = "";
  els.requestsCount.textContent = snapshot.size;
  currentRequests = new Map();

  if (snapshot.empty) {
    els.requestsBody.innerHTML =
      `<tr><td colspan="5" class="empty">No requests in this view.</td></tr>`;
    return;
  }

  for (const doc of snapshot.docs) {
    const data = doc.data();
    currentRequests.set(doc.id, data);
    const decided = data.status !== "pending";
    const category = experienceCategoryDisplay(data.experienceCategory);
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>
        <strong>${escapeHtml(data.name)}</strong>
        <div class="muted">${escapeHtml(data.email)}</div>
      </td>
      <td><span class="experience-badge ${category.className}">${category.label}</span></td>
      <td>${formatDate(data.createdAt)}</td>
      <td><span class="pill pill--${escapeHtml(data.status)}">${escapeHtml(data.status)}</span></td>
      <td class="actions">${
        decided
          ? `<button class="btn" data-request-details="${escapeHtml(doc.id)}">Details</button>
             <span class="muted">${
              data.reviewedAt ? "reviewed " + formatDate(data.reviewedAt) : "—"
            }</span>`
          : `<button class="btn" data-request-details="${escapeHtml(doc.id)}">Details</button>
             <button class="btn btn--approve" data-approve="${escapeHtml(doc.id)}">Approve</button>
             <button class="btn btn--reject" data-reject="${escapeHtml(doc.id)}">Reject</button>`
      }</td>
    `;
    els.requestsBody.appendChild(tr);
  }
}

function showRequestDetails(requestId) {
  const data = currentRequests.get(requestId);
  if (!data) return;
  const category = experienceCategoryDisplay(data.experienceCategory);

  els.requestDetailsContent.innerHTML = `
    <dl class="request-detail-grid">
      <dt>Applicant</dt><dd>${escapeHtml(data.name || "—")}</dd>
      <dt>Email</dt><dd>${escapeHtml(data.email || "—")}</dd>
      <dt>Experience</dt>
      <dd><span class="experience-badge ${category.className}">${category.label}</span></dd>
      <dt>Status</dt><dd><span class="pill pill--${escapeHtml(data.status)}">${escapeHtml(data.status)}</span></dd>
      <dt>Received</dt><dd>${formatDate(data.createdAt)}</dd>
      <dt>Consent</dt><dd>${data.consent === true ? "Yes" : "No"}</dd>
      <dt>Review note</dt><dd>${escapeHtml(data.note || "—")}</dd>
      <dt>Reviewed by</dt><dd>${escapeHtml(data.reviewedBy || "—")}</dd>
      <dt>Reviewed at</dt><dd>${formatDate(data.reviewedAt)}</dd>
    </dl>
  `;
  els.requestDetails.showModal();
}

/**
 * One roster row, built from a `tester` map nested inside a user document.
 *
 * `tester` is a map on `users/{uid}`, not a document of its own, so every field
 * read here is one level down. The uid (`doc.id`) is what identifies the tester
 * for every action — the Worker routes all take `userId`.
 */
function renderTesters(snapshot) {
  els.testersBody.innerHTML = "";

  // A user is on the roster exactly when they have a `tester` map. Removal
  // deletes that field and pushes the snapshot onto `testerHistory`, so this
  // filter is what hides former testers — and unlike the old `removed` flag it
  // cannot drift, because there is no flag left to get out of step.
  //
  // The active/inactive filter is applied here rather than in the query: `active`
  // is nested under `tester`, and Firestore cannot filter on a nested field
  // without a composite index and a full-field path. The roster is small enough
  // that filtering client-side is cheaper than the index it would replace.
  const wanted = els.testerFilter.value;
  const withTester = snapshot.docs.filter((doc) => Boolean(doc.data().tester));

  const visible = withTester.filter((doc) => {
    if (wanted === "all") return true;
    const isActive = Boolean(doc.data().tester.active);
    return wanted === "active" ? isActive : !isActive;
  });

  // Ordered by acceptance, newest first, matching what the old orderBy did.
  //
  // Compared numerically via timestampValue rather than with localeCompare on the
  // raw field: acceptedAt is a Timestamp for records the SDK wrote and an ISO
  // string for records the REST client wrote, and both occur in production.
  // localeCompare threw a TypeError on the Timestamp ones, which stopped the
  // whole roster from rendering.
  visible.sort(
    (a, b) =>
      timestampValue(b.data().tester.acceptedAt) - timestampValue(a.data().tester.acceptedAt),
  );

  els.testersCount.textContent = withTester.length;
  els.activeCount.textContent = withTester.filter((doc) => doc.data().tester.active).length;

  if (visible.length === 0) {
    els.testersBody.innerHTML =
      `<tr><td colspan="5" class="empty">No testers yet. Approve a request to create one.</td></tr>`;
    return;
  }

  for (const doc of visible) {
    const data = doc.data().tester;
    const isActive = Boolean(data.active);
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>
        <strong>${escapeHtml(data.name || "—")}</strong>
        <div class="muted">${escapeHtml(data.email)}</div>
        <div class="muted mono">${escapeHtml(data.wallet?.accountId || "")}</div>
      </td>
      <td>${
        isActive
          ? `<span class="pill pill--active">Active</span>`
          : `<span class="pill pill--inactive">Not active</span>`
      }</td>
      <td>${formatDate(isActive ? data.activatedAt : data.deactivatedAt)}</td>
      <td class="muted">${escapeHtml(data.deactivationReason || "—")}</td>
      <td class="actions">
        <button class="btn" data-wallet="${escapeHtml(doc.id)}">Wallet pass</button>
        ${
          isActive
            ? `<button class="btn btn--deactivate" data-deactivate="${escapeHtml(doc.id)}">Deactivate</button>`
            : `<button class="btn btn--approve" data-activate="${escapeHtml(doc.id)}">Reactivate</button>`
        }
        <button class="btn btn--deactivate" data-remove="${escapeHtml(doc.id)}" data-tester-name="${escapeHtml(data.name || data.email || "this tester")}">Remove</button>
      </td>
    `;
    els.testersBody.appendChild(tr);
  }
}

let unsubscribeRequests = null;
let unsubscribeTesters = null;

/**
 * Load every tester's requests from the Worker.
 *
 * Fetched rather than subscribed: Firestore cannot watch a set of per-tester
 * subcollections in one query, and the Worker assembles them into a single list.
 * Refreshed on demand and whenever the roster changes, which is enough for a
 * review queue.
 */
async function loadFeedback() {
  if (!WORKER_URL) return; // warnIfWorkerUnconfigured() already said so.

  try {
    const token = await auth.currentUser.getIdToken(true);
    const result = await postToWorker({ url: `${WORKER_URL}/feedback-list`, token, body: {} });
    allFeedback = result.feedback || [];
    renderFeedback();
  } catch (error) {
    // A failure here must not take the rest of the dashboard down; the roster is
    // the part an admin cannot work without.
    console.warn("CRP: could not load tester feedback", error);
  }
}

function renderFeedback() {
  const area = els.feedbackFilter.value;
  const visible = area === "all" ? allFeedback : allFeedback.filter((f) => f.area === area);

  els.feedbackBody.innerHTML = "";
  els.feedbackCount.textContent = visible.length;

  if (visible.length === 0) {
    els.feedbackBody.innerHTML =
      `<tr><td colspan="4" class="empty">No requests yet.</td></tr>`;
    return;
  }

  for (const entry of visible) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <strong>${escapeHtml(entry.title)}</strong>
        <div class="muted">${escapeHtml(entry.body)}</div>
      </td>
      <td>
        ${escapeHtml(entry.testerName || "—")}
        ${entry.testerNumber ? `<div class="muted mono">#${entry.testerNumber}</div>` : ""}
      </td>
      <td><span class="pill pill--pending">${escapeHtml(AREA_LABELS[entry.area] || entry.area)}</span></td>
      <td>${formatDate(entry.createdAt)}</td>
    `;
    els.feedbackBody.appendChild(tr);
  }
}

els.feedbackFilter.addEventListener("change", renderFeedback);

function subscribeRequests() {
  const status = els.requestFilter.value;
  const constraints = [orderBy("createdAt", "desc"), limit(100)];
  if (status !== "all") constraints.unshift(where("status", "==", status));

  return onSnapshot(
    query(collection(db, "requests"), ...constraints),
    (snap) => renderRequests(snap),
    (error) => toast(`Could not load requests: ${error.message}`, "error"),
  );
}

function subscribeTesters() {
  // The roster is the `users` collection, filtered down to those with a `tester`
  // map. Only staff may list it — the rules deny `list` to everyone else, since
  // the collection holds every account's email address.
  //
  // No `where` and no `orderBy`: the fields that matter now live under `tester.*`,
  // which Firestore cannot filter or sort on without a composite index. The
  // active/inactive filter and the sort are applied in renderTesters() instead.
  // Re-subscribing on filter change is therefore unnecessary, but the handler is
  // left in place so a filter still refreshes the view if the rendering changes.
  return onSnapshot(
    query(collection(db, "users"), limit(500)),
    (snap) => renderTesters(snap),
    (error) => toast(`Could not load testers: ${error.message}`, "error"),
  );
}

function startSubscriptions() {
  unsubscribeRequests?.();
  unsubscribeTesters?.();
  unsubscribeRequests = subscribeRequests();
  unsubscribeTesters = subscribeTesters();
}

els.requestFilter.addEventListener("change", () => {
  unsubscribeRequests?.();
  unsubscribeRequests = subscribeRequests();
});
els.testerFilter.addEventListener("change", () => {
  unsubscribeTesters?.();
  unsubscribeTesters = subscribeTesters();
});
els.requestDetailsClose.addEventListener("click", () => els.requestDetails.close());

/* ------------------------------------------------------------------ *
 * Actions
 *
 * Every mutating action goes to the Cloudflare Worker, which is the only
 * writable path on the Spark plan (Cloud Functions cannot be deployed there).
 * The Worker verifies this same `admin` claim from the ID token, so the security
 * model is unchanged: the client still never writes to Firestore directly.
 *
 * No callable client is imported here at all. Every function that remains in
 * `functions/` is undeployed on Spark, and calling one fails on CORS from
 * GitHub Pages.
 * ------------------------------------------------------------------ */

/** Worker base URL, or null when not configured. */
const WORKER_URL =
  (typeof window !== "undefined" && window.CRP_WORKER_URL) || null;

async function decideRequest(requestId, decision, button) {
  let note = "";

  if (decision === "rejected") {
    const answer = prompt("Reason for rejection (optional):");
    if (answer === null) return; // cancelled
    note = answer;
  }

  // No password prompt, deliberately. The applicant chose their own password on
  // the public signup form and it went straight to Firebase, so CRP has never
  // seen it and neither has this dashboard. Approval only links the request to
  // the account that already exists.
  //
  // Asking here was actively harmful: it implied the admin knew the applicant's
  // credentials, and the password had to be transmitted to the Worker to be
  // usable at all.

  setBusy(button, true);
  try {
    // A fresh token so a newly granted admin claim takes effect without a
    // re-login, and so an expired one cannot fail mid-session.
    const token = await auth.currentUser.getIdToken(true);

    const result = await decideViaWorker({
      url: `${WORKER_URL}/accept`,
      token,
      requestId,
      decision,
      note,
    });

    // The roster list is a live onSnapshot subscription, so the new tester
    // appears on its own. Surface the number when we have one, since that is
    // the bit an admin actually wants to confirm.
    //
    // The decision email is best-effort server-side, so the Worker reports
    // whether it was sent. Reporting that explicitly matters: an admin who sees
    // only "Approved" would assume the applicant was told, when the mail may
    // never have left the building.
    const label =
      decision === "approved"
        ? result.testerNumber
          ? `Approved — tester #${result.testerNumber} created.`
          : "Approved — tester created."
        : "Request rejected.";

    if (result.emailed === false) {
      toast(`${label} But the email was NOT sent — check Resend.`, "error");
    } else if (decision === "approved" && !result.saveUrl) {
      toast(`${label} Email sent, but the Wallet link is missing — reissue the card.`, "warn");
    } else {
      toast(label);
    }
  } catch (error) {
    toast(error.message || "Could not save that decision.", "error");
  } finally {
    setBusy(button, false);
  }
}

async function toggleTester(userId, active, button) {
  let reason = null;
  if (!active) {
    const answer = prompt("Why is this tester being deactivated? (required)");
    if (answer === null) return; // cancelled
    if (!answer.trim()) {
      toast("A reason is required to deactivate.", "error");
      return;
    }
    reason = answer;
  }

  setBusy(button, true);
  try {
    // Goes to the Worker, not the `setTesterActive` callable. Cloud Functions
    // cannot be deployed on the Spark plan, so the old call hit a URL that does
    // not exist and failed on CORS. The Worker's /tester-status route performs
    // the same lifecycle transition — status stays in step with the `active`
    // flag, deactivation still requires a reason, and an audit entry is written —
    // behind the same `admin` claim check.
    const token = await auth.currentUser.getIdToken(true);
    await postToWorker({
      url: `${WORKER_URL}/tester-status`,
      token,
      // userId, not testerId: the tester record is a map on the user's document,
      // so the Worker's routes address the account that owns it.
      body: { userId, active, reason },
    });
    toast(active ? "Tester reactivated." : "Tester deactivated.");
  } catch (error) {
    toast(error.message || "Could not update the tester.", "error");
  } finally {
    setBusy(button, false);
  }
}

async function removeTester(userId, button) {
  // Two prompts, deliberately. Remove is the one destructive action here: it
  // takes someone out of the program AND lets them apply again. A single "are
  // you sure?" is too easy to click through, and unlike Deactivate it cannot be
  // undone from this screen.
  const name = button.dataset.testerName || "this tester";
  const understood = confirm(
    `Remove ${name} from the CRP Testing Program?\n\n` +
      `This takes them out of the program and revokes their testing card.\n` +
      `Their record moves to their history, and their tester number is retired.\n` +
      `Their CRP account is kept, so they can sign in and apply again.\n\n` +
      `This cannot be undone from here.`,
  );
  if (!understood) return;

  const reason = prompt("Why are they leaving the program? (required)");
  if (reason === null) return; // cancelled — nothing happened
  if (!reason.trim()) {
    toast("A reason is required to remove a tester.", "error");
    return;
  }

  setBusy(button, true);
  try {
    const token = await auth.currentUser.getIdToken(true);
    const result = await postToWorker({
      url: `${WORKER_URL}/tester-remove`,
      token,
      body: { userId, reason },
    });

    if (result.alreadyRemoved) {
      toast("Already removed — nothing changed.", "warn");
    } else if (result.walletRevoked === false) {
      toast(
        `Removed${result.testerNumber ? ` — tester #${result.testerNumber} retired` : ""}. ` +
          "But the card was NOT revoked — reissue it from the Wallet button.",
        "warn",
      );
    } else {
      toast(
        result.testerNumber
          ? `Removed from the program. Tester #${result.testerNumber} retired.`
          : "Removed from the program.",
      );
    }
  } catch (error) {
    toast(error.message || "Could not remove the tester.", "error");
  } finally {
    setBusy(button, false);
  }
}

async function issueWallet(userId, button) {
  setBusy(button, true);
  try {
    // Goes to the Worker, not the `issueWalletPass` callable. That Cloud Function
    // cannot be deployed on the Spark plan, so the old call hit a URL that does
    // not exist and failed on CORS. The Worker verifies the same `admin` claim
    // from the ID token, and signs the pass with the same Wallet module the
    // approval email uses.
    const token = await auth.currentUser.getIdToken(true);
    const result = await postToWorker({
      url: `${WORKER_URL}/tester-wallet`,
      token,
      body: { userId },
    });

    window.open(result.saveUrl, "_blank", "noopener");
    toast(
      result.active ? "Wallet pass opened." : "Pass opened — card is revoked.",
      result.active ? "ok" : "warn",
    );
  } catch (error) {
    toast(error.message || "Could not issue a pass.", "error");
  } finally {
    setBusy(button, false);
  }
}

// One delegated listener for the whole page, so re-rendering never leaves stale
// handlers attached to removed rows.
document.addEventListener("click", (event) => {
  const el = event.target;
  if (!(el instanceof Element)) return;

  const approve = el.closest("[data-approve]");
  const reject = el.closest("[data-reject]");
  const activate = el.closest("[data-activate]");
  const deactivate = el.closest("[data-deactivate]");
  const walletBtn = el.closest("[data-wallet]");
  const removeBtn = el.closest("[data-remove]");
  const requestDetails = el.closest("[data-request-details]");

  if (approve) decideRequest(approve.dataset.approve, "approved", approve);
  else if (reject) decideRequest(reject.dataset.reject, "rejected", reject);
  else if (requestDetails) showRequestDetails(requestDetails.dataset.requestDetails);
  else if (activate) toggleTester(activate.dataset.activate, true, activate);
  else if (deactivate) toggleTester(deactivate.dataset.deactivate, false, deactivate);
  else if (removeBtn) removeTester(removeBtn.dataset.remove, removeBtn);
  else if (walletBtn) issueWallet(walletBtn.dataset.wallet, walletBtn);
});

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.loginError.textContent = "";

  const submit = els.loginForm.querySelector("button[type=submit]");
  setBusy(submit, true);
  try {
    await signInWithEmailAndPassword(auth, els.loginEmail.value, els.loginPassword.value);
  } catch (error) {
    els.loginError.textContent =
      error.code === "auth/invalid-credential" ? "Incorrect email or password." : error.message;
  } finally {
    setBusy(submit, false);
  }
});

els.signOutBtn.addEventListener("click", () => signOut(auth));

function showLogin() {
  els.login.hidden = false;
  els.app.hidden = true;
  unsubscribeRequests?.();
  unsubscribeTesters?.();
  unsubscribeRequests = null;
  unsubscribeTesters = null;
}

function showApp() {
  els.login.hidden = true;
  els.app.hidden = false;
  startSubscriptions();
  // Awaited nowhere on purpose: the roster renders from its own live
  // subscription, and the request queue should not wait on this fetch.
  loadFeedback();
  warnIfWorkerUnconfigured();
}

/**
 * Make a missing Worker config obvious up front.
 *
 * Without this, an admin only discovers it by clicking Approve and reading a
 * toast. Reviewing the queue still works either way, so this is a warning, not
 * a blocker.
 */
function warnIfWorkerUnconfigured() {
  if (WORKER_URL) return;
  console.warn(
    "CRP: admin/js/worker-config.js has no CRP_WORKER_URL, so approving and " +
      "rejecting are unavailable. Copy admin/js/worker-config.example.js and set it.",
  );
  toast("Acceptance is unavailable: the Worker URL is not configured.", "warn");
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

if (!isConfigured()) {
  els.loginError.textContent =
    "Firebase is not configured yet. Copy admin/js/firebase-config.example.js to " +
    "admin/js/firebase-config.js and paste your project values.";
} else {
  // Named app "admin", deliberately not the default "[DEFAULT]".
  //
  // The tester portal (tester/js/tester.js) uses the same apiKey and projectId
  // on the same origin, so both would otherwise share ONE Auth persistence store
  // and the SDK's cross-tab sync. Signing into either page then replaced the
  // session for both: the other tab's onAuthStateChanged fired with a null user
  // and this dashboard dropped back to the login form about a second later,
  // even though its own sign-in had succeeded.
  //
  // A distinct app name gives the admin its own Auth instance, its own
  // IndexedDB store and its own cross-tab channel, so the two dashboards stop
  // overwriting each other's session. Nothing else changes: same project, same
  // apiKey, same claims, same rules.
  const app = initializeApp(firebaseConfig, "admin");
  auth = getAuth(app);
  db = getFirestore(app);

  onAuthStateChanged(auth, async (user) => {
    if (!user) return showLogin();

    // The claim lives on the ID token, not in Firestore. Force a refresh so a
    // freshly granted claim takes effect without needing a full re-login.
    //
    // A FAILED refresh must never be read as "this account has no admin claim".
    // getIdTokenResult() below falls back to whatever token is already cached, and
    // a token cached from before the claim was granted has no `admin` at all — so
    // treating the failure as a missing claim both misreported the reason AND
    // signed out a session that was in fact valid. Worse, that signOut also
    // destroyed a fresh manual sign-in still completing in another callback, which
    // is the "logged in for a second, then bounced back to the login form" symptom.
    // Bailing out here keeps the session intact and reports only what is true: we
    // could not verify, which is not the same as access being denied.
    let tokenResult;
    try {
      await user.getIdToken(true);
      tokenResult = await user.getIdTokenResult();
    } catch {
      els.loginError.textContent =
        "Could not verify your session. Please check your connection and try again.";
      showLogin();
      return;
    }

    if (tokenResult.claims.admin !== true) {
      await signOut(auth);
      els.loginError.textContent =
        "This account has no admin claim. Run: node scripts/set-admin-claim.js " + user.email;
      showLogin();
      return;
    }

    showApp();
  });
}

