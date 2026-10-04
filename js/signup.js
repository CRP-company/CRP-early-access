/**
 * CRP early-access signup.
 *
 * Replaces the old Formspree POST. The form writes a document straight to the
 * `requests` collection, which firestore.rules opens to anonymous `create` only.
 * Nothing here touches `users`: the tester record that approval creates is a
 * `tester` map on the applicant's user document, written by the Worker.
 *
 * The applicant creates their OWN Firebase Auth account here, choosing their own
 * password. Approval then only has to link the request to an existing uid — the
 * admin never sees, sets, or transmits a password.
 *
 * There is deliberately no "does this email already have an account?" check
 * before submitting. That question can only be answered by enumerating accounts,
 * which is a vulnerability, not a convenience. Instead the create is attempted and
 * `auth/email-already-in-use` is what tells us the account is taken. The applicant
 * only ever learns the state of the address they just typed themselves, and a
 * race (two tabs, or an admin creating the account first) lands on exactly the
 * same code path — so no duplicate account is possible.
 *
 * The page stays fully static — the SDK is loaded from the gstatic CDN as an
 * ES module, so there is no bundler and no build step.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import {
  getAuth,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

const form = document.getElementById("signupForm");
const joinBtn = document.getElementById("joinButton");
const consentCheck = document.getElementById("consentCheckbox");
const messageDiv = document.getElementById("formMessage");
/**
 * Link to the tester dashboard's sign-in form.
 *
 * Shown only alongside the "you already have an account" message. That dashboard
 * is a separate page in this same site and already has the full sign-in flow
 * (email + password + signInWithEmailAndPassword) against this same Firebase
 * project, so an existing account holder needs a way to REACH it — not a second
 * auth implementation on this page.
 */
const signinLink = document.getElementById("signinLink");
const emailInput = form.elements.email;
const nameInput = form.elements.name;
const passwordInput = form.elements.password;
const experienceInputs = form.elements.experienceCategory;
const websiteInput = form.elements.website;

/**
 * The address already has a CRP account.
 *
 * A distinct class so the catch below can tell "they already have an account"
 * apart from every other failure, without inspecting an error message string.
 */
class ExistingAccountError extends Error {}

/** Firebase's own minimum, mirrored so the form can check it without a round trip. */
const MIN_PASSWORD_LENGTH = 6;

/**
 * Cloudflare Worker that sends the confirmation email.
 *
 * The Firestore write above is the source of truth and happens first; this is
 * a best-effort follow-up. A failure here must never surface to the applicant
 * as a failed application, so every error path below is swallowed after being
 * logged.
 */
const EMAIL_WORKER_URL =
  (typeof CRP_EMAIL_WORKER_URL !== "undefined" && CRP_EMAIL_WORKER_URL) || null;

/**
 * Ask the Worker to email the applicant.
 *
 * Fire-and-forget by design: the caller does not await this for correctness,
 * only so the browser does not tear down the request during navigation. A
 * network error, a non-2xx, or a missing configuration all resolve quietly.
 *
 * @param {{name: string, email: string, requestId: string}} payload
 */
function requestConfirmationEmail({ name, email, requestId }) {
  if (!EMAIL_WORKER_URL) {
    // Not configured yet: the request is stored regardless, so this is safe.
    return;
  }

  // Keepalive lets the request finish even as we navigate to sent.html.
  fetch(EMAIL_WORKER_URL, {
    method: "POST",
    mode: "cors",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, requestId }),
    keepalive: true,
  })
    .then((response) => {
      if (!response.ok) {
        // Logged, never shown: the applicant already has their request saved.
        console.warn(
          `CRP: confirmation email not sent (worker returned ${response.status}). ` +
            "The application was still saved.",
        );
      }
    })
    .catch((error) => {
      console.warn("CRP: confirmation email request failed.", error);
    });
}

/**
 * Fail fast if the config is still a placeholder.
 *
 * Without this guard the SDK happily initialises with projectId "REPLACE_ME",
 * opens a Listen channel to a project that does not exist, and retries in a
 * backoff loop forever — which looks like a broken page and floods the console
 * with ERR_BLOCKED_BY_CLIENT. Checking first turns that into one clear message.
 */
const isConfigured =
  Boolean(firebaseConfig.projectId) &&
  !String(firebaseConfig.projectId).startsWith("REPLACE_ME") &&
  Boolean(firebaseConfig.apiKey);

if (!isConfigured) {
  joinBtn.disabled = true;
  messageDiv.textContent =
    "Signups are not available right now. Please email us and we will add you.";
  messageDiv.classList.add("error", "show");
  console.error(
    "CRP: js/firebase-config.js still contains placeholder values. " +
      "Copy js/firebase-config.example.js and paste your Firebase console values.",
  );
}

/** Firestore + Auth handles, created only when the config is valid. */
let db = null;
let auth = null;
if (isConfigured) {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);

  // Opt in to the local emulators with ?emulator=1, so a real submission can be
  // exercised end to end without touching production data. Without the flag we
  // talk to the real project, so this can never fire by accident in the wild.
  //
  // Auth needs its own emulator on 9099: account creation is now part of signup,
  // and without this the create would hit the live project from a local test.
  if (new URLSearchParams(location.search).has("emulator")) {
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    console.info("CRP: using the local Firestore + Auth emulators");
  }
}

/**
 * Is this address currently an ACTIVE CRP Tester?
 *
 * `testerIndex/{sha256(email)}` is the authoritative signal, and it is
 * deliberately the ONLY one consulted. The Worker writes the pointer when a
 * request is approved, and removal DELETES it — so the pointer's existence means
 * exactly "is on the roster right now", and its absence means exactly "is not",
 * whether the person was never a tester or was one and has since been removed.
 *
 * That distinction is the whole point. `testerHistory`, the legacy `testers`
 * collection and `/users/{uid}` are all deliberately NOT read here: a removed
 * tester keeps all three, and consulting them would make the archive permanent
 * and block exactly the re-application the programme supports.
 *
 * firestore.rules already grants `allow get: if true` on this document, so no
 * rule change is needed.
 *
 * @param {string} emailKey  sha256 of the lowercased address.
 * @returns {Promise<boolean>}
 */
async function isActiveTester(emailKey) {
  try {
    const snap = await getDoc(doc(db, "testerIndex", emailKey));
    return snap.exists();
  } catch {
    // The read is world-readable and cannot be denied by rules, so a failure
    // here is a transient network problem, not an authorisation one. Report "not
    // currently a tester" and let the request through: no account is created or
    // signed into, approval stays manual, and the requestEmails marker below
    // still blocks a genuine duplicate. Blocking here would only reintroduce the
    // dead end this whole check exists to remove.
    console.warn("CRP: could not read the tester index; treating as not a tester");
    return false;
  }
}

/**
 * Create the applicant's Firebase Auth account with the password they chose.
 *
 * The password goes from their browser straight to Firebase. It is never sent to
 * the Worker, never written to Firestore, and never logged — the only place it
 * exists is inside the SDK call below and inside Firebase itself.
 *
 * @throws {ExistingAccountError} when the address already has an account. That
 *   covers both a genuine existing account and a race (two tabs submitting, or an
 *   admin creating the account concurrently), because Firebase reports both as
 *   `auth/email-already-in-use`.
 */
async function createApplicantAccount(email, password) {
  try {
    await createUserWithEmailAndPassword(auth, email, password);
  } catch (error) {
    if (error && error.code === "auth/email-already-in-use") {
      // Deliberately not attempting a second create, and not falling back to a
      // sign-in: either would risk acting on an account the applicant does not own.
      throw new ExistingAccountError("auth/email-already-in-use");
    }
    throw error;
  }

  // The account exists and we are signed in as the applicant. Sign straight back
  // out: this page is a public form, and leaving a session behind would mean the
  // browser stays authenticated on a shared machine after submitting.
  try {
    await signOut(auth);
  } catch {
    // Non-fatal. The request is already stored; a lingering session is a
    // nuisance, not a failure, and must not fail the application.
  }
}

/** Join button is gated on consent and the required experience choice. */
function syncSubmitState() {
  // The password is part of the button's validity, not just the submit handler.
  // Checking it only on submit means an applicant can fill the whole form and
  // then be told at the last moment that the password is too short — the button
  // promising an action the form will refuse.
  const password = passwordInput.value;
  joinBtn.disabled =
    !isConfigured ||
    !consentCheck.checked ||
    !experienceInputs.value ||
    !password ||
    password.length < MIN_PASSWORD_LENGTH ||
    form.dataset.submitting === "true";
}
consentCheck.addEventListener("change", syncSubmitState);
form.addEventListener("change", (event) => {
  if (event.target === experienceInputs[0] || event.target.name === "experienceCategory") {
    syncSubmitState();
  }
});

function showMessage(text, isError = false) {
  messageDiv.textContent = text;
  messageDiv.classList.toggle("error", isError);
  messageDiv.classList.add("show");
  // Hidden by default and revealed only by the existing-account branch below, so
  // the link can never sit under an unrelated message ("already applied",
  // "weak password") where it would be a non sequitur.
  if (signinLink) signinLink.hidden = true;
}

/**
 * Tell the applicant they already have an account, and give them the way out.
 *
 * This is the one dead end in the signup flow: the account exists, so applying
 * again cannot work, and without this link the only thing the page could say was
 * "go sign in" with nowhere to go. The destination is the existing tester
 * dashboard, which signs them in with the very account they already have.
 */
function showExistingAccountMessage() {
  passwordInput.value = "";
  showMessage(
    "You already have a CRP account with this email address. Sign in to the " +
      "tester dashboard instead of applying again.",
    true,
  );
  if (signinLink) signinLink.hidden = false;
}

/**
 * Key for the duplicate-lookup doc. Hashing keeps the raw address out of the
 * document path so it never lands in a path, a log line, or a read rule.
 */
async function hashEmail(email) {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

class DuplicateApplicationError extends Error {}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (form.dataset.submitting === "true") return;

  // Honeypot: the field is hidden from humans via CSS/attributes, so anything
  // in it is a bot. Report success without writing anything, so the bot gets
  // no signal that it was detected.
  if (websiteInput.value) {
    form.reset();
    syncSubmitState();
    showMessage("Thanks — your request is in.");
    return;
  }

  const name = nameInput.value.trim();
  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  const experienceCategory = experienceInputs.value;

  if (!name || !email) {
    showMessage("Please fill in your name and email address.", true);
    return;
  }
  // Checked here as well as by `required`/`minlength`, because the form is
  // novalidate and reportValidity() below is what enforces it — this is the
  // message the applicant actually reads.
  if (!password || password.length < 6) {
    passwordInput.focus();
    showMessage("Choose a password of at least 6 characters.", true);
    return;
  }
  if (!experienceCategory) {
    experienceInputs[0].reportValidity();
    showMessage("Please select which best describes you.", true);
    return;
  }
  if (!form.reportValidity()) return;

  form.dataset.submitting = "true";
  joinBtn.textContent = "Sending…";
  messageDiv.classList.remove("show", "error");
  // Cleared alongside the message rather than through showMessage(): a stale
  // "Sign in" link must not survive into a fresh submission attempt.
  if (signinLink) signinLink.hidden = true;
  syncSubmitState();

  try {
    // The account comes FIRST. If this fails we must not write a request,
    // UNLESS the address already has an account but is not currently a tester —
    // a removed tester reapplying, or someone who already has a CRP Focus
    // account and has never been on the roster.
    //
    // "Has a CRP account" and "is a CRP Tester" are different questions, and
    // conflating them made removal permanent: the account outlives the
    // tester record, so the old check refused every re-application forever.
    try {
      await createApplicantAccount(email, password);
    } catch (error) {
      if (!(error instanceof ExistingAccountError)) throw error;

      if (await isActiveTester(await hashEmail(email))) {
        // Currently on the roster: applying again cannot help. Point them at the
        // dashboard they already have access to.
        showExistingAccountMessage();
        syncSubmitState();
        return;
      }

      // Not a tester. Carry on and let the application stand.
      //
      // Nothing about the existing account is touched: no second account is
      // created, nobody is signed in, and the stored account is not modified or
      // deleted. This proves nothing about who owns the address — approval is
      // still a manual act, and the Worker links the existing account by email
      // at that point, exactly as it already does for a returning applicant.
      console.info("CRP: address already has an account but is not a tester; allowing the application");
    }

    const emailKey = await hashEmail(email);
    const requestRef = doc(collection(db, "requests"));
    const markerRef = doc(db, "requestEmails", emailKey);
    await runTransaction(db, async (transaction) => {
      const existing = await transaction.get(markerRef);
      if (existing.exists()) throw new DuplicateApplicationError();

      transaction.set(requestRef, {
        name,
        email,
        consent: true,
        experienceCategory,
        status: "pending",
        source: "early-access-site",
        userAgent: (navigator.userAgent || "").slice(0, 300),
        website: "",
        // serverTimestamp() resolves to the commit time checked by the rules.
        createdAt: serverTimestamp(),
      });
      transaction.set(markerRef, {
        requestId: requestRef.id,
        createdAt: serverTimestamp(),
      });
    });

    // The request and marker are durably stored, so email is a best-effort extra.
    //
    // requestRef.id doubles as the Resend idempotency key, so a retry for the
    // same request can never produce a second email.
    requestConfirmationEmail({ name, email, requestId: requestRef.id });

    // Remember the address for the confirmation page so it can name it back.
    // Wrapped because sessionStorage throws in some privacy modes; the
    // confirmation page degrades to generic copy without it.
    try {
      sessionStorage.setItem("crp:lastRequestEmail", email);
    } catch {
      /* non-fatal */
    }

    // Hand off to the confirmation page.
    window.location.assign("sent.html");
  } catch (error) {
    if (error instanceof ExistingAccountError) {
      // Covers both a genuinely existing account and a race between two
      // submissions. Either way: no second account is created, and no request is
      // written, because an application without an account behind it is the
      // stuck state this change exists to prevent.
      //
      // Only ever tells the applicant about the address THEY typed.
      showExistingAccountMessage();
      syncSubmitState();
      return;
    }

    if (error instanceof DuplicateApplicationError) {
      form.reset();
      syncSubmitState();
      showMessage("You have already applied — we have your request on file.");
      return;
    }

    // The raw error object is logged, never the form values. Firebase's own auth
    // errors do not echo the password, and nothing above puts it in the message.
    console.error("CRP signup failed", error);

    // `auth/weak-password` means Firebase's own policy (not just our minlength)
    // rejected it. Say so in the applicant's terms.
    if (error && error.code === "auth/weak-password") {
      passwordInput.value = "";
      showMessage("That password is too weak. Please choose a longer one.", true);
      return;
    }

    // `permission-denied` almost always means the rules were not deployed, or
    // the config is pointed at the wrong project. Say so plainly rather than
    // showing a generic failure.
    if (error && error.code === "permission-denied") {
      showMessage(
        "Could not submit right now. Please email us directly and we will add you.",
        true,
      );
    } else {
      showMessage("Something went wrong. Please try again in a moment.", true);
    }
  } finally {
    form.dataset.submitting = "false";
    joinBtn.textContent = "Send request";
    syncSubmitState();
  }
});

// Re-evaluate as the applicant types, so the button reflects validity without
// needing a submit attempt to find out. `input` rather than `change`, so it
// responds as they type instead of on blur.
passwordInput.addEventListener("input", syncSubmitState);
emailInput.addEventListener("input", syncSubmitState);

syncSubmitState();
