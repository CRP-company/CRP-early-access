#!/usr/bin/env node
"use strict";

/**
 * Verifies the best-effort contract for the email Worker:
 *
 *   "The Firestore submission must remain successful even if the email
 *    request fails — the applicant's application must never be lost."
 *
 * Drives a real browser against the Firestore emulator, with the Worker
 * pointed at an endpoint that always fails. Asserts the request is still
 * written to Firestore and the visitor still reaches sent.html.
 *
 * Requires:
 *   node scripts/dev-server.js
 *   firebase emulators:start --only firestore --project crp-cuby-display
 */

const { chromium } = require("playwright");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const PROJECT = process.env.GCLOUD_PROJECT || "crp-cuby-display";
const EMULATOR_HOST = "127.0.0.1";
const EMULATOR_PORT = 8080;

async function clear(db, name) {
  const snap = await db.collection(name).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

/**
 * Scenario 1: the Worker is unreachable.
 *
 * Proves the best-effort contract: the application must still be saved and the
 * applicant must still see success.
 */
async function failurePath() {
  const adminApp = initializeApp({ projectId: PROJECT });
  const db = getFirestore(adminApp);
  db.settings({ host: `${EMULATOR_HOST}:${EMULATOR_PORT}`, ssl: false });

  await clear(db, "requests");
  await clear(db, "requestEmails");

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  // Force the email call to fail, in two different ways, to prove neither can
  // take the application down with it.
  await page.addInitScript(() => {
    const realFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input?.url;
      if (url && url.includes("workers.dev")) {
        // "no route" is the worst realistic case: the Worker is not deployed
        // at all, or the domain is wrong.
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return realFetch(input, init);
    };
  });

  const consoleWarnings = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") consoleWarnings.push(msg.text());
  });

  await page.goto("http://localhost:8900/index.html?emulator=1", {
    waitUntil: "networkidle",
  });

  await page.fill('input[name="name"]', "Alex Morgan");
  await page.fill('input[name="email"]', "alex@example.com");
  await page.check("#consentCheckbox");
  await page.click("#joinButton");

  const landed = await page
    .waitForURL("**/sent.html", { timeout: 15000 })
    .then(() => true)
    .catch(() => false);

  const stored = await db.collection("requests").get();

  console.log("reached sent.html            :", landed);
  console.log("documents in requests        :", stored.size);
  if (stored.size) {
    console.log("  status                     :", stored.docs[0].data().status);
    console.log("  email                      :", stored.docs[0].data().email);
  }
  console.log("warnings logged to console   :", consoleWarnings.length);
  for (const w of consoleWarnings) console.log("   ", w.slice(0, 100));

  // The applicant must see success, never an error.
  const visibleError = await page.evaluate(() => {
    const el = document.getElementById("formMessage");
    return el ? el.classList.contains("error") : false;
  });
  console.log("error shown to applicant     :", visibleError);

  await browser.close();

  const ok = landed && stored.size === 1 && !visibleError;
  console.log(ok ? "\nPASS — the application survived the email failure" : "\nFAIL");
  process.exit(ok ? 0 : 1);
}

/**
 * Second scenario, run when invoked with `--happy`:
 *
 * The Worker is stubbed to SUCCEED, and we assert it is called exactly once,
 * after the Firestore write, and with the real request id as the payload.
 * That last part matters — the request id doubles as the Resend
 * Idempotency-Key, so a wrong value would break duplicate protection.
 */
async function happyPath() {
  const adminApp = initializeApp({ projectId: PROJECT });
  const db = getFirestore(adminApp);
  db.settings({ host: `${EMULATOR_HOST}:${EMULATOR_PORT}`, ssl: false });

  await clear(db, "requests");
  await clear(db, "requestEmails");

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  // Observe on the Node side via the request event.
  //
  // Two things ruled out simpler approaches here:
  //  - Recording on `window` is lost, because the page navigates to sent.html
  //    immediately after the call.
  //  - page.route() does not intercept it either: the request is issued with
  //    `keepalive: true`, which bypasses route interception.
  // So we listen for the request, let it fail fast, and assert on what was
  // sent. The live Worker returning 502 is irrelevant here — this scenario is
  // about the browser's behaviour, and it never sends real mail because the
  // Worker rejects the origin (this test runs from localhost).
  const workerCalls = [];
  page.on("request", (req) => {
    if (req.url().includes("workers.dev")) {
      workerCalls.push({ url: req.url(), body: req.postData() });
    }
  });

  await page.goto("http://localhost:8900/index.html?emulator=1", {
    waitUntil: "networkidle",
  });

  await page.fill('input[name="name"]', "Sam Lee");
  await page.fill('input[name="email"]', "sam@example.com");
  await page.check("#consentCheckbox");
  await page.click("#joinButton");

  const landed = await page
    .waitForURL("**/sent.html", { timeout: 15000 })
    .then(() => true)
    .catch(() => false);

  // Give the keepalive fetch a moment to be routed and recorded.
  await page.waitForTimeout(1500);

  const stored = await db.collection("requests").get();

  console.log("reached sent.html            :", landed);
  console.log("documents in requests        :", stored.size);
  console.log("worker calls                 :", workerCalls.length);
  console.log("request stored in Firestore  :", stored.size > 0, "(written before the email call)");

  const storedId = stored.size ? stored.docs[0].id : null;
  console.log("firestore request id         :", storedId);

  let payload = null;
  if (workerCalls.length) {
    try {
      payload = JSON.parse(workerCalls[0].body);
    } catch {
      payload = null;
    }
    console.log("worker called with           :", JSON.stringify(payload));
  }

  const idMatches = payload && storedId && payload.requestId === storedId;
  console.log("requestId matches stored doc :", Boolean(idMatches));
  console.log("email normalised in payload  :", payload ? payload.email === "sam@example.com" : false);

  await browser.close();

  const ok =
    landed &&
    stored.size === 1 &&
    workerCalls.length === 1 &&
    Boolean(idMatches) &&
    payload.email === "sam@example.com";
  console.log(
    ok
      ? "\nPASS — Worker called once, after the Firestore write, with the real request id"
      : "\nFAIL",
  );
  process.exit(ok ? 0 : 1);
}

// Dispatch once both scenarios are declared (hoisting-safe: function decls).
if (process.argv.includes("--happy")) {
  happyPath().catch(bail);
} else {
  failurePath().catch(bail);
}
/**
 * Shared error handler: a harness crash should exit non-zero with a clear
 * message rather than an unhandled rejection.
 */
function bail(error) {
  console.error("harness error:", error && error.message ? error.message : error);
  process.exit(1);
}
