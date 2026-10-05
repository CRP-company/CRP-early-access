/**
 * CRP tester dashboard.
 *
 * Testers sign in with the email and password they already use for CRP Focus —
 * same Firebase project, so no second account — and file requests for what CRP
 * should build or change.
 *
 * Where the work happens, and where it deliberately does not:
 *
 *   - This file never writes to Firestore. Every mutation goes to the Worker,
 *     which resolves the caller to their own tester record from their verified
 *     email and stamps the owner itself. A tampered client cannot file a request
 *     under someone else's number, because it never chooses the number.
 *   - The roster gate is the Worker's, not this page's. Hiding the form for a
 *     revoked tester is presentation; the Worker refuses the write regardless.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

const WORKER_URL = (typeof window !== "undefined" && window.CRP_WORKER_URL) || null;

const els = {
  login: document.getElementById("login-view"),
  app: document.getElementById("app-view"),
  loginForm: document.getElementById("login-form"),
  loginEmail: document.getElementById("login-email"),
  loginPassword: document.getElementById("login-password"),
  loginSubmit: document.getElementById("login-submit"),
  loginError: document.getElementById("login-error"),
  noPassword: document.getElementById("no-password"),
  noPasswordEmail: document.getElementById("no-password-email"),
  newPassword: document.getElementById("new-password"),
  newPasswordConfirm: document.getElementById("new-password-confirm"),
  createPassword: document.getElementById("create-password"),
  signOut: document.getElementById("sign-out"),
  name: document.getElementById("tester-name"),
  meta: document.getElementById("tester-meta"),
  targetText: document.getElementById("target-text"),
  requestSlots: document.getElementById("request-slots"),
  feedbackForm: document.getElementById("feedback-form"),
  feedbackTitle: document.getElementById("feedback-title"),
  feedbackArea: document.getElementById("feedback-area"),
  feedbackBody: document.getElementById("feedback-body"),
  feedbackSubmit: document.getElementById("feedback-submit"),
  feedbackError: document.getElementById("feedback-error"),
  feedbackDone: document.getElementById("feedback-done"),
  feedbackList: document.getElementById("feedback-list"),
  feedbackCount: document.getElementById("feedback-count"),
  canSubmit: document.getElementById("can-submit"),
  blocked: document.getElementById("feedback-blocked"),
};

const AREA_LABELS = {
  app: "CRP Focus app",
  product: "Product",
  hardware: "Cuby hardware",
  other: "Other",
};

// Why the form is closed, in the tester's own words rather than a status code.
const BLOCKED_COPY = {
  inactive: "Your tester account is not currently active, so requests are closed. Get in touch with CRP if you think that is wrong.",
  removed: "You have left the CRP tester program. Your account and history are kept, but new requests are closed.",
  "not-on-roster": "Your email is not on the CRP tester list.",
};

let auth = null;
let me = null;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function isConfigured() {
  return firebaseConfig.projectId && !firebaseConfig.projectId.startsWith("REPLACE_ME");
}

/** Escape untrusted values before putting them anywhere near the DOM. */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function formatDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function show(node, message) {
  node.textContent = message || "";
  node.hidden = !message;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = label || "Working…";
  } else if (button.dataset.originalText) {
    button.textContent = button.dataset.originalText;
  }
}

/**
 * POST JSON to a Worker route with the caller's ID token.
 *
 * Same contract as admin/js/worker-client.js: the token is the authorisation,
 * and every failure path resolves to a message worth showing a tester rather than
 * a raw status code.
 */
async function postToWorker(path, body, { auth: withAuth = true } = {}) {
  if (!WORKER_URL) {
    throw new Error("The tester service is not configured yet.");
  }

  const headers = { "Content-Type": "application/json" };
  if (withAuth) {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error("Your session has expired. Sign in again.");
    headers.Authorization = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(`${WORKER_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new Error("Could not reach CRP. Check your connection and try again.");
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Request failed (${response.status}).`);
  }

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }
  return payload;
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

/**
 * Draw one card per request made this month.
 *
 * Always at least `target` cards, so the minimum is visible as empty slots from
 * the start. Each request beyond the target adds another card.
 *
 * Colour carries the meaning:
 *   - grey  — a slot still to fill
 *   - green — a request inside the monthly minimum, i.e. the requirement met
 *   - blue  — a request beyond the minimum: extra, not obligation
 */
function renderTarget(activity) {
  const { submitted, target } = activity;

  const total = Math.max(target, submitted);

  els.requestSlots.replaceChildren();
  for (let i = 0; i < total; i += 1) {
    const slot = document.createElement("div");
    const filled = i < submitted;
    slot.className = filled
      ? (i < target ? "slot slot--done" : "slot slot--bonus")
      : "slot";
    els.requestSlots.appendChild(slot);
  }

  // The same fact, in words, for anyone not reading the colours.
  const remaining = Math.max(0, target - submitted);
  els.requestSlots.setAttribute(
    "aria-label",
    `${submitted} request${submitted === 1 ? "" : "s"} sent this month; ${target} needed.`,
  );
  els.targetText.textContent = remaining === 0
    ? `Done for ${activity.period}`
    : `${remaining} more this month`;
}

function renderFeedback(entries) {
  els.feedbackCount.textContent = entries.length;
  els.feedbackList.innerHTML = "";

  if (!entries.length) {
    els.feedbackList.innerHTML =
      `<p class="empty">Nothing yet. Send your first request above.</p>`;
    return;
  }

  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "entry";
    item.innerHTML = `
      <div class="entry__title">${escapeHtml(entry.title)}</div>
      <div class="entry__body">${escapeHtml(entry.body)}</div>
      <div class="entry__meta">
        <span>${escapeHtml(AREA_LABELS[entry.area] || entry.area)}</span>
        <span>${escapeHtml(formatDate(entry.createdAt))}</span>
      </div>
    `;
    els.feedbackList.appendChild(item);
  }
}

function render(payload) {
  me = payload;
  const { tester, activity, feedback } = payload;

  els.name.textContent = tester.name ? `Hi, ${tester.name.split(" ")[0]}` : "Welcome back";
  els.meta.textContent = tester.testerNumber
    ? `Tester #${tester.testerNumber} · ${tester.email}`
    : tester.email;

  renderTarget(activity);
  renderFeedback(feedback || []);

  // The form is only shown when the Worker says this tester may submit. The
  // Worker re-checks on every write, so this is presentation, not the gate.
  const open = tester.active === true;
  els.feedbackForm.hidden = !open;
  els.blocked.hidden = open;
  els.canSubmit.hidden = !open;
  els.canSubmit.textContent = "Open";

  if (!open) {
    els.blocked.textContent =
      BLOCKED_COPY[tester.blockedReason] || BLOCKED_COPY.inactive;
    els.canSubmit.className = "pill pill--bad";
    els.canSubmit.textContent = "Closed";
  }
}

function showLogin(message) {
  els.app.hidden = true;
  els.login.hidden = false;
  if (message) show(els.loginError, message);
}

function showApp() {
  els.login.hidden = true;
  els.app.hidden = false;
  els.loginPassword.value = "";
  els.loginError.hidden = true;
}

/* ------------------------------------------------------------------ *
 * Feedback
 * ------------------------------------------------------------------ */

els.feedbackForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const title = els.feedbackTitle.value.trim();
  const area = els.feedbackArea.value;
  const body = els.feedbackBody.value.trim();

  show(els.feedbackError, "");
  show(els.feedbackDone, "");

  // Mirrors validateFeedback() in the Worker. Checked here so the tester is told
  // which field is wrong, rather than the Worker returning a generic 400.
  if (title.length < 3) {
    show(els.feedbackError, "Give your request a short title.");
    return;
  }
  if (body.length < 10) {
    show(els.feedbackError, "Please describe your request in a bit more detail.");
    return;
  }
  if (!area) {
    show(els.feedbackError, "Pick which part of CRP this is about.");
    return;
  }

  setBusy(els.feedbackSubmit, true, "Sending…");

  try {
    await postToWorker("/feedback", { title, area, body });

    els.feedbackForm.reset();
    show(els.feedbackDone, "Thanks — that is with the CRP team now.");

    // Re-read rather than pushing the new entry in locally: the Worker assigns the
    // id and stamps the period, so its response is the authority on both.
    await loadDashboard();
  } catch (error) {
    show(els.feedbackError, error.message);
  } finally {
    setBusy(els.feedbackSubmit, false);
  }
});

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

/** Load the signed-in tester's dashboard, or explain why they cannot have one. */
async function loadDashboard() {
  const payload = await postToWorker("/tester-me");
  render(payload);
  showApp();
}

/**
 * Offer "create your password" for a tester who has no CRP Focus account yet.
 *
 * The roster check goes to the Worker first. That is the whole gate: it confirms
 * the address is an active tester before any account is created, so the public
 * form cannot be used to mint CRP Focus logins for strangers. An address that is
 * not on the roster gets a plain refusal and nothing is created.
 */
async function offerPasswordCreation(email) {
  try {
    await postToWorker("/tester-check", { email }, { auth: false });
  } catch (error) {
    showLogin(error.message);
    return;
  }

  els.loginPassword.value = "";
  els.noPasswordEmail.textContent = email;
  els.noPassword.hidden = false;
  show(els.loginError, "");
}

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = els.loginEmail.value.trim();
  const password = els.loginPassword.value;

  if (!email || !password) {
    show(els.loginError, "Enter your email and password.");
    return;
  }

  setBusy(els.loginSubmit, true, "Signing in…");
  show(els.loginError, "");

  try {
    await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged does the rest: it loads the dashboard, or signs out and
    // explains that the account is not a tester.
  } catch (error) {
    if (error.code === "auth/wrong-password" || error.code === "auth/invalid-credential") {
      show(els.loginError, "That password is not right. Try again, or reset it.");
    } else if (error.code === "auth/user-not-found") {
      // No CRP Focus account for this address. If they are an approved tester,
      // offer to create one; otherwise say so plainly.
      await offerPasswordCreation(email);
    } else if (error.code === "auth/too-many-requests") {
      show(els.loginError, "Too many attempts. Wait a moment and try again.");
    } else {
      show(els.loginError, error.message || "Could not sign in.");
    }
  } finally {
    setBusy(els.loginSubmit, false);
  }
});

els.createPassword.addEventListener("click", async () => {
  const email = els.loginEmail.value.trim();
  const password = els.newPassword.value;
  const confirm = els.newPasswordConfirm.value;

  if (password.length < 6) {
    show(els.loginError, "Use at least 6 characters.");
    return;
  }
  if (password !== confirm) {
    show(els.loginError, "Those passwords do not match.");
    return;
  }

  setBusy(els.createPassword, true, "Creating…");
  show(els.loginError, "");

  try {
    await createUserWithEmailAndPassword(auth, email, password);
    // Signed in by createUserWithEmailAndPassword; onAuthStateChanged finishes.
  } catch (error) {
    if (error.code === "auth/email-already-in-use") {
      // The account exists after all — most likely they had simply forgotten the
      // password. Point them at the reset flow rather than dead-ending them.
      show(
        els.loginError,
        "That account already has a password. Try signing in, or reset it below.",
      );
      await offerReset(email);
    } else if (error.code === "auth/weak-password") {
      show(els.loginError, "Use at least 6 characters.");
    } else {
      show(els.loginError, error.message || "Could not create the password.");
    }
  } finally {
    setBusy(els.createPassword, false);
  }
});

/**
 * Send a reset email, and tell the tester to check their inbox.
 *
 * Offered when someone reaches "create a password" but the account turns out to
 * exist — the common case is a tester who has the CRP Focus app but has forgotten
 * the password, not one who never registered.
 */
async function offerReset(email) {
  try {
    await sendPasswordResetEmail(auth, email);
    show(els.loginError, `Check ${email} for a reset link, then sign in.`);
  } catch {
    show(els.loginError, "That account already has a password. Try signing in again.");
  }
}

els.signOut.addEventListener("click", async () => {
  await signOut(auth);
  me = null;
  els.noPassword.hidden = true;
  els.newPassword.value = "";
  els.newPasswordConfirm.value = "";
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

if (!isConfigured()) {
  showLogin(
    "Firebase is not configured yet. Copy tester/js/firebase-config.example.js to " +
      "tester/js/firebase-config.js and paste your project values.",
  );
} else {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);

  // Persistence is deliberately not requested. A tester dashboard holds other
  // people's feedback in the same browser, so this is a page you sign into and
  // out of rather than one that reopens on a shared machine.
  onAuthStateChanged(auth, async (user) => {
    if (!user) return showLogin();

    try {
      await loadDashboard();
    } catch (error) {
      // A valid CRP Focus account that is not a CRP tester is the expected case
      // here, not an error worth a stack trace. Sign out so the next attempt
      // starts clean, and say what happened.
      await signOut(auth);
      showLogin(error.message);
    }
  });
}