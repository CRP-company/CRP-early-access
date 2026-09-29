#!/usr/bin/env node
"use strict";

/**
 * Screenshot the confirmation page for visual review.
 *
 *   node scripts/dev-server.js &
 *   node tests/screenshot.js
 *
 * Writes /tmp/sent.png (desktop) and /tmp/sent-mobile.png.
 */

const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch();

  // Desktop, with an email in sessionStorage so the personalised copy renders.
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await desktop.newPage();
  await page.goto("http://localhost:8900/sent.html");
  await page.evaluate(() =>
    sessionStorage.setItem("crp:lastRequestEmail", "alex@example.com"),
  );
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "/tmp/sent.png" });
  console.log("desktop  -> /tmp/sent.png");

  const heading = await page.textContent("h1");
  const lede = (await page.textContent("#lede")).replace(/\s+/g, " ").trim();
  const backHref = await page.getAttribute(".btn-back", "href");
  console.log("h1       :", heading);
  console.log("lede     :", lede);
  console.log("back href:", backHref);

  // Mobile
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mpage = await mobile.newPage();
  await mpage.goto("http://localhost:8900/sent.html");
  await mpage.waitForLoadState("networkidle");
  await mpage.screenshot({ path: "/tmp/sent-mobile.png" });
  console.log("mobile   -> /tmp/sent-mobile.png");

  // Direct visit with no stored email must still read correctly.
  const plain = await browser.newContext();
  const ppage = await plain.newPage();
  await ppage.goto("http://localhost:8900/sent.html");
  await ppage.waitForLoadState("networkidle");
  console.log("no-email :", (await ppage.textContent("#lede")).replace(/\s+/g, " ").trim());

  // The honeypot path: filling the hidden field must short-circuit the write
  // and land on the confirmation page, with nothing sent to Firestore.
  const bot = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const bpage = await bot.newPage();
  const writes = [];
  bpage.on("request", (r) => {
    if (r.url().includes("firestore.googleapis.com") && r.method() !== "GET") {
      writes.push(r.url());
    }
  });
  await bpage.goto("http://localhost:8900/index.html");
  await bpage.fill('input[name="name"]', "Bot");
  await bpage.fill('input[name="email"]', "bot@spam.example");
  await bpage.check('input[name="experienceCategory"][value="new_to_technology"]');
  await bpage.check("#consentCheckbox");
  await bpage.evaluate(() => {
    document.querySelector('input[name="website"]').value = "http://spam.example";
  });
  await bpage.click("#joinButton");
  await bpage.waitForURL("**/sent.html", { timeout: 8000 }).catch(() => {});
  console.log("honeypot -> landed on", bpage.url().replace("http://localhost:8900", ""));
  console.log("honeypot -> firestore writes:", writes.length, writes.length === 0 ? "(none, as intended)" : "LEAKED");
  await bot.close();

  await browser.close();
})();
