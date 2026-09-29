/**
 * CRP early-access signup.
 *
 * Replaces the old Formspree POST. The form now writes a document straight to
 * the `requests` collection, which firestore.rules opens to anonymous
 * `create` only. Nothing here touches `testers`: acceptance is a staff action,
 * and the Cloud Function that promotes a request into a tester is the only
 * thing that ever writes there.
 *
 * The page stays fully static — the SDK is loaded from the gstatic CDN as an
 * ES module, so there is no bundler and no build step.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  addDoc,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

const form = document.getElementById("signupForm");
const joinBtn = document.getElementById("joinButton");
const consentCheck = document.getElementById("consentCheckbox");
const messageDiv = document.getElementById("formMessage");
const emailInput = form.elements.email;
const nameInput = form.elements.name;
const websiteInput = form.elements.website;

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

/** Firestore handle, created only when the config is valid. */
let db = null;
if (isConfigured) {
  db = getFirestore(initializeApp(firebaseConfig));

  // Opt in to the local emulator with ?emulator=1, so a real submission can be
  // exercised end to end without touching production data. Without the flag we
  // talk to the real project, so this can never fire by accident in the wild.
  if (new URLSearchParams(location.search).has("emulator")) {
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    console.info("CRP: using the local Firestore emulator");
  }
}

/** Join button is gated on the consent checkbox. */
function syncSubmitState() {
  joinBtn.disabled =
    !isConfigured || !consentCheck.checked || form.dataset.submitting === "true";
}
consentCheck.addEventListener("change", syncSubmitState);

function showMessage(text, isError = false) {
  messageDiv.textContent = text;
  messageDiv.classList.toggle("error", isError);
  messageDiv.classList.add("show");
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

  if (!name || !email) {
    showMessage("Please fill in your name and email address.", true);
    return;
  }

  form.dataset.submitting = "true";
  joinBtn.textContent = "Sending…";
  messageDiv.classList.remove("show", "error");
  syncSubmitState();

  try {
    // Check for an existing application first. This is a `get` on a doc whose
    // body holds only an id and a timestamp, so nothing personal is exposed.
    const emailKey = await hashEmail(email);
    const existing = await getDoc(doc(db, "requestEmails", emailKey));

    if (existing.exists()) {
      form.reset();
      showMessage("You have already applied — we have your request on file.");
      return;
    }

    const requestRef = await addDoc(collection(db, "requests"), {
      name,
      email,
      consent: true,
      status: "pending",
      source: "early-access-site",
      userAgent: (navigator.userAgent || "").slice(0, 300),
      website: "",
      // serverTimestamp() resolves to the commit time, which is what the
      // `createdAt == request.time` rule checks.
      createdAt: serverTimestamp(),
    });

    await setDoc(doc(db, "requestEmails", emailKey), {
      requestId: requestRef.id,
      createdAt: serverTimestamp(),
    });

    // The request is now durably stored, so the email is a best-effort extra.
    // This MUST stay after the two writes above: if the Worker were called
    // first, a Firestore failure would mean emailing an applicant for an
    // application that does not exist.
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
    console.error("CRP signup failed", error);

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

syncSubmitState();
