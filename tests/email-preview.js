#!/usr/bin/env node
"use strict";

/**
 * Render the acknowledgement email to PNG so it can be eyeballed.
 *
 *   node tests/email-preview.js
 *   -> /tmp/email-desktop.png, /tmp/email-mobile.png
 */

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const {
  buildApplicationReceivedEmail,
} = require(path.join(__dirname, "..", "functions", "src", "email-template.js"));

(async () => {
  const { html } = buildApplicationReceivedEmail({
    name: "Alex Morgan",
    email: "alex@example.com",
  });

  fs.writeFileSync("/tmp/email.html", html);

  const browser = await chromium.launch();

  const desktop = await browser.newContext({ viewport: { width: 660, height: 1000 } });
  const page = await desktop.newPage();
  await page.goto("file:///tmp/email.html");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "/tmp/email-desktop.png", fullPage: true });
  console.log("desktop -> /tmp/email-desktop.png");

  const mobile = await browser.newContext({ viewport: { width: 375, height: 900 } });
  const mpage = await mobile.newPage();
  await mpage.goto("file:///tmp/email.html");
  await mpage.waitForLoadState("networkidle");
  await mpage.screenshot({ path: "/tmp/email-mobile.png", fullPage: true });
  console.log("mobile  -> /tmp/email-mobile.png");

  // Check the images actually resolved rather than showing alt text.
  const imgs = await page.$$eval("img", (els) =>
    els.map((i) => ({ src: i.getAttribute("src"), w: i.naturalWidth })),
  );
  for (const i of imgs) {
    console.log(`  img loaded=${i.w > 0} ${i.w}x -> ${i.src.slice(0, 70)}`);
  }

  await browser.close();
})();
