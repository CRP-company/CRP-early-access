/**
 * CRP early-access admin dashboard.
 *
 * Shows the two collections side by side, which is the point of the redesign:
 * `requests` is the raw public intake queue, `testers` is the accepted roster.
 * Approving a request creates a tester via a Cloud Function, and the
 * active / not-active flag lives only on `testers`.
 *
 * Security: the dashboard never writes to Firestore directly. Reads are allowed
 * by the `admin` custom claim; every mutation goes through a callable function,
 * which re-checks that claim server-side. A tampered client therefore cannot
 * approve a request or flip a tester's status by talking to Firestore.
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
};

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

function formatDate(value) {
  if (!value) return "—";
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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

function renderTesters(snapshot) {
  els.testersBody.innerHTML = "";

  // Removed testers are archived, not deleted, so they are still in the
  // collection. Filter them out here so the roster — and its counts — show the
  // people actually in the program, while the record and its audit history
  // survive untouched.
  const visible = snapshot.docs.filter((doc) => !doc.data().removed);

  els.testersCount.textContent = visible.length;
  els.activeCount.textContent = visible.filter((doc) => doc.data().active).length;

  if (visible.length === 0) {
    els.testersBody.innerHTML =
      `<tr><td colspan="5" class="empty">No testers yet. Approve a request to create one.</td></tr>`;
    return;
  }

  for (const doc of visible) {
    const data = doc.data();
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
        <button class="btn" data-wallet="${doc.id}">Wallet pass</button>
        ${
          isActive
            ? `<button class="btn btn--deactivate" data-deactivate="${doc.id}">Deactivate</button>`
            : `<button class="btn btn--approve" data-activate="${doc.id}">Reactivate</button>`
        }
        <button class="btn btn--deactivate" data-remove="${doc.id}" data-tester-name="${escapeHtml(data.name || data.email || "this tester")}">Remove</button>
      </td>
    `;
    els.testersBody.appendChild(tr);
  }
}

let unsubscribeRequests = null;
let unsubscribeTesters = null;

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
  const filter = els.testerFilter.value;
  const constraints = [orderBy("createdAt", "desc"), limit(200)];
  if (filter === "active") constraints.unshift(where("active", "==", true));
  if (filter === "inactive") constraints.unshift(where("active", "==", false));

  return onSnapshot(
    query(collection(db, "testers"), ...constraints),
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

async function toggleTester(testerId, active, button) {
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
      body: { testerId, active, reason },
    });
    toast(active ? "Tester reactivated." : "Tester deactivated.");
  } catch (error) {
    toast(error.message || "Could not update the tester.", "error");
  } finally {
    setBusy(button, false);
  }
}

async function removeTester(testerId, button) {
  // Two prompts, deliberately. Remove is the one destructive action here: it
  // takes someone out of the program AND lets them apply again. A single "are
  // you sure?" is too easy to click through, and unlike Deactivate it cannot be
  // undone from this screen.
  const name = button.dataset.testerName || "this tester";
  const understood = confirm(
    `Remove ${name} from the CRP Testing Program?\n\n` +
      `This takes them out of the program and revokes their testing card.\n` +
      `Their record and history are kept, and their tester number is retired.\n` +
      `They will be allowed to apply again.\n\n` +
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
      body: { testerId, reason },
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

async function issueWallet(testerId, button) {
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
      body: { testerId },
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
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);

  onAuthStateChanged(auth, async (user) => {
    if (!user) return showLogin();

    // The claim lives on the ID token, not in Firestore. Force a refresh so a
    // freshly granted claim takes effect without needing a full re-login.
    try {
      await user.getIdToken(true);
    } catch {
      /* fall through to the claim check below */
    }

    const tokenResult = await user.getIdTokenResult();

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

