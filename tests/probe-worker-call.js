#!/usr/bin/env node
"use strict";

/**
 * Diagnostic probe: is the browser actually calling the Worker?
 *
 * Temporary debugging aid, kept because it answers the one question the E2E
 * test cannot when it reports zero calls: is the config global visible on the
 * page, and does a request leave the browser at all?
 */

const { chromium } = require("playwright");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const PROJECT = process.env.GCLOUD_PROJECT || "crp-cuby-display";

(async () => {
  const adminApp = initializeApp({ projectId: PROJECT });
  const db = getFirestore(adminApp);
  db.settings({ host: "127.0.0.1:8080", ssl: false });

  for (const name of ["requests", "requestEmails"]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const seen = [];
  page.on("request", (r) => {
    if (r.url().includes("workers.dev")) seen.push(r.url());
  });
  page.on("console", (m) => {
    console.log(`  [console.${m.type()}]`, m.text().slice(0, 160));
  });
  page.on("pageerror", (e) => {
    console.log("  [pageerror]", String(e).slice(0, 200));
  });

  await page.goto("http://localhost:8900/index.html?emulator=1", { waitUntil: "networkidle" });

  console.log("  window.CRP_EMAIL_WORKER_URL :", await page.evaluate(() => window.CRP_EMAIL_WORKER_URL));
  console.log("  typeof                      :", await page.evaluate(() => typeof window.CRP_EMAIL_WORKER_URL));

  await page.fill('input[name="name"]', "Probe");
  await page.fill('input[name="email"]', "probe@example.com");
  await page.check('input[name="experienceCategory"][value="developer"]');
  await page.check("#consentCheckbox");
  await page.click("#joinButton");

  await page.waitForTimeout(4000);

  console.log("  worker requests seen        :", seen.length, seen.join(", "));

  await browser.close();
})();
