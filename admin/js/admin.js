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
import {
  getFunctions,
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js";

import { firebaseConfig } from "./firebase-config.js";
import { decideViaWorker } from "./worker-client.js";

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
};

let auth = null;
let db = null;
let functions = null;

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

  if (snapshot.empty) {
    els.requestsBody.innerHTML =
      `<tr><td colspan="4" class="empty">No requests in this view.</td></tr>`;
    return;
  }

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const decided = data.status !== "pending";
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>
        <strong>${escapeHtml(data.name)}</strong>
        <div class="muted">${escapeHtml(data.email)}</div>
      </td>
      <td>${formatDate(data.createdAt)}</td>
      <td><span class="pill pill--${escapeHtml(data.status)}">${escapeHtml(data.status)}</span></td>
      <td class="actions">${
        decided
          ? `<span class="muted">${
              data.reviewedAt ? "reviewed " + formatDate(data.reviewedAt) : "—"
            }</span>`
          : `<button class="btn btn--approve" data-approve="${doc.id}">Approve</button>
             <button class="btn btn--reject" data-reject="${doc.id}">Reject</button>`
      }</td>
    `;
    els.requestsBody.appendChild(tr);
  }
}

function renderTesters(snapshot) {
  els.testersBody.innerHTML = "";
  els.testersCount.textContent = snapshot.size;

  let activeCount = 0;
  for (const doc of snapshot.docs) if (doc.data().active) activeCount += 1;
  els.activeCount.textContent = activeCount;

  if (snapshot.empty) {
    els.testersBody.innerHTML =
      `<tr><td colspan="5" class="empty">No testers yet. Approve a request to create one.</td></tr>`;
    return;
  }

  for (const doc of snapshot.docs) {
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

/* ------------------------------------------------------------------ *
 * Actions
 *
 * Approve / Reject go to the Cloudflare Worker, which is the only writable
 * path on the Spark plan (Cloud Functions cannot be deployed there). The
 * Worker verifies this same `admin` claim from the ID token, so the security
 * model is unchanged: the client still never writes to Firestore directly.
 *
 * The remaining actions still use callables, which are deployed when the
 * project moves to Blaze.
 * ------------------------------------------------------------------ */

const call = (name, data) => httpsCallable(functions, name)(data);

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
    if (decision === "approved" && result.testerNumber) {
      toast(`Approved — tester #${result.testerNumber} created.`);
    } else {
      toast(decision === "approved" ? "Approved — tester created." : "Request rejected.");
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
    await call("setTesterActive", { testerId, active, reason });
    toast(active ? "Tester reactivated." : "Tester deactivated.");
  } catch (error) {
    toast(error.message || "Could not update the tester.", "error");
  } finally {
    setBusy(button, false);
  }
}

async function issueWallet(testerId, button) {
  setBusy(button, true);
  try {
    const { data } = await call("issueWalletPass", { testerId });
    window.open(data.saveUrl, "_blank", "noopener");
    toast(data.active ? "Wallet pass opened." : "Pass opened — card is revoked.", data.active ? "ok" : "warn");
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

  if (approve) decideRequest(approve.dataset.approve, "approved", approve);
  else if (reject) decideRequest(reject.dataset.reject, "rejected", reject);
  else if (activate) toggleTester(activate.dataset.activate, true, activate);
  else if (deactivate) toggleTester(deactivate.dataset.deactivate, false, deactivate);
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
  functions = getFunctions(app);

  onAuthStateChanged(auth, async (user) => {
    if (!user) return showLogin();

    // The claim lives on the ID token, not in Firestore. Force a refresh so a
    // freshly granted claim takes effect without needing a full re-login.
    try {
      await user.getIdToken(true);
    } catch {
      /* fall through to the claim check below */
    }

    if (user.getIdTokenResult().claims.admin !== true) {
      await signOut(auth);
      els.loginError.textContent =
        "This account has no admin claim. Run: node scripts/set-admin-claim.js " + user.email;
      showLogin();
      return;
    }

    showApp();
  });
}


