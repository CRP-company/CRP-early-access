#!/usr/bin/env node
"use strict";

/**
 * End-to-end check of the real submission path, against the Firestore emulator.
 *
 * Verifies the whole chain: form fill -> rules accept the write -> document
 * lands in `requests` with status "pending" -> browser lands on sent.html.
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

(async () => {
  const adminApp = initializeApp({ projectId: PROJECT });
  const db = getFirestore(adminApp);
  db.settings({ host: `${EMULATOR_HOST}:${EMULATOR_PORT}`, ssl: false });

  await clear(db, "requests");
  await clear(db, "requestEmails");
  await clear(db, "testers");

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).split("\n")[0]));

  // ?emulator=1 makes the page talk to the local emulator instead of prod.
  await page.goto("http://localhost:8900/index.html?emulator=1", {
    waitUntil: "networkidle",
  });

  await page.fill('input[name="name"]', "Alex Morgan");
  // Mixed case on purpose: the client is expected to normalise before writing.
  await page.fill('input[name="email"]', "Alex.Morgan@Example.com");
  await page.check("#consentCheckbox");
  const blockedWithoutExperience = await page.isDisabled("#joinButton");
  await page.check('input[name="experienceCategory"][value="everyday_user"]');
  await page.click("#joinButton");

  const landed = await page
    .waitForURL("**/sent.html", { timeout: 15000 })
    .then(() => true)
    .catch(() => false);

  console.log("redirected to sent.html :", landed);
  console.log("submit blocked without experience:", blockedWithoutExperience);
  console.log("page errors             :", errors.length ? errors.join(" | ") : "none");

  if (landed) {
    console.log("confirmation lede       :", (await page.textContent("#lede")).replace(/\s+/g, " ").trim());
  }

  const stored = await db.collection("requests").get();
  console.log("documents in requests   :", stored.size);
  for (const d of stored.docs) {
    const data = d.data();
    console.log("  status    :", data.status);
    console.log("  email     :", data.email, data.email === data.email.toLowerCase() ? "(normalised)" : "(NOT normalised)");
    console.log("  consent   :", data.consent);
    console.log("  experience:", data.experienceCategory);
    console.log("  source    :", data.source);
    console.log("  website   :", JSON.stringify(data.website));
    console.log("  createdAt :", data.createdAt ? "server timestamp set" : "MISSING");
  }

  const markers = await db.collection("requestEmails").get();
  console.log("dedupe markers          :", markers.size);

  // The separation guarantee: a signup must NOT create a tester.
  const testers = await db.collection("testers").get();
  console.log(
    "documents in testers    :",
    testers.size,
    testers.size === 0 ? "(correct — requests stay separate from testers)" : "(UNEXPECTED)",
  );

  // A second submission with the same email must be refused as a duplicate.
  const page2 = await ctx.newPage();
  await page2.goto("http://localhost:8900/index.html?emulator=1", { waitUntil: "networkidle" });
  await page2.fill('input[name="name"]', "Alex Morgan");
  await page2.fill('input[name="email"]', "alex.morgan@example.com");
  await page2.check('input[name="experienceCategory"][value="everyday_user"]');
  await page2.check("#consentCheckbox");
  await page2.click("#joinButton");
  await page2.waitForTimeout(3000);
  const dupMessage = (await page2.textContent("#formMessage")).trim();
  console.log("duplicate resubmit says :", dupMessage || "(nothing shown)");
  const afterDup = await db.collection("requests").get();
  console.log("requests after resubmit :", afterDup.size, afterDup.size === 1 ? "(no duplicate created)" : "(DUPLICATE CREATED)");

  await browser.close();

  const ok =
    landed &&
    blockedWithoutExperience &&
    stored.size === 1 &&
    stored.docs[0].data().experienceCategory === "everyday_user" &&
    markers.size === 1 &&
    testers.size === 0 &&
    afterDup.size === 1 &&
    errors.length === 0;
  console.log(ok ? "\nE2E PASS" : "\nE2E FAIL");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("harness error:", e.message);
  process.exit(1);
});
