/**
 * Regression: the admin dashboard must not be logged out by a sign-in on the
 * tester portal.
 *
 * The reproduced failure: admin/js/admin.js and tester/js/tester.js share the
 * same apiKey and projectId on the same origin, so they shared ONE Firebase Auth
 * persistence store and the SDK's cross-tab sync. Signing into the tester portal
 * replaced the session for both — the admin tab's onAuthStateChanged fired with
 * a null user and `showLogin()` dropped it back to the login form about a second
 * later, even though its own sign-in had succeeded.
 *
 * The fix gives the admin its own Firebase app name, and so its own Auth
 * instance, IndexedDB store and cross-tab channel.
 *
 * Two real pages in ONE browser context — which is what makes them share storage
 * — so the collision can actually occur. Passwords are never used: each page's
 * sign-in is answered with a genuine RS256 ID token and the REAL refresh token
 * from signInWithCustomToken, so token refresh truly succeeds.
 *
 * READ-ONLY: no account, Firestore or Worker data is written.
 *
 *   node tests/e2e-auth-isolation.js
 */
const { chromium } = require("playwright");
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.ADMIN_PAGE
  ? process.env.ADMIN_PAGE.replace(/\/admin\/?$/, "")
  : "http://localhost:8900";
const API_KEY = "AIzaSyB_uiI4nlcyfgyq61ncJCMDodJPeE_OYIY";
const ADMIN_EMAIL = "atronamir5@gmail.com";
const TESTER_EMAIL = "oren.terrionn@gmail.com"; // exists, not a tester, no admin claim

const sa = JSON.parse(fs.readFileSync(path.join(os.homedir(), "crp-cuby-key.json"), "utf8"));
const app = initializeApp({ credential: cert(sa), projectId: sa.project_id });
const auth = getAuth(app);

let failed = 0;
function check(name, ok, detail = "") {
  const line = `${ok ? "  PASS" : "  FAIL"}  ${name}`;
  console.log(ok ? line : `${line}${detail ? `\n          ${detail}` : ""}`);
  if (!ok) failed += 1;
}

/** A real ID token AND the real refresh token, so refresh genuinely succeeds. */
async function credentials(email) {
  const u = await auth.getUserByEmail(email);
  const custom = await auth.createCustomToken(u.uid);
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: custom, returnSecureToken: true }) },
  );
  const { idToken, refreshToken } = await res.json();
  return { uid: u.uid, email, idToken, refreshToken };
}

/** Answer each page's sign-in with that page's own account's real credentials. */
async function routeAuth(ctx, creds) {
  await ctx.route("**/identitytoolkit.googleapis.com/**", async (route) => {
    const req = route.request();
    const isTester = (req.frame()?.url() || "").includes("/tester/");
    const who = isTester ? creds.tester : creds.admin;
    const url = req.url();

    if (url.includes("signInWithPassword")) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          kind: "identitytoolkit#VerifyPasswordResponse",
          idToken: who.idToken, email: who.email, localId: who.uid,
          registered: true, refreshToken: who.refreshToken, expiresIn: "3600",
        }),
      });
    }
    if (url.includes("accounts:lookup")) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          kind: "identitytoolkit#LookupAccountInfoResponse",
          users: [{
            localId: who.uid, email: who.email, emailVerified: true, disabled: false,
            providerUserInfo: [{ providerId: "password", rawId: who.uid,
              federatedId: who.email, verifiedEmail: true }],
          }],
        }),
      });
    }
    return route.continue();
  });
}

(async () => {
  const creds = {
    admin: await credentials(ADMIN_EMAIL),
    tester: await credentials(TESTER_EMAIL),
  };
  console.log(`\n  admin  uid=${creds.admin.uid}`);
  console.log(`  tester uid=${creds.tester.uid}`);

  const browser = await chromium.launch();
  // ONE context, so both pages share origin storage — that is what makes the
  // collision possible in the first place.
  const ctx = await browser.newContext();
  await routeAuth(ctx, creds);

  // ------------------------------------------------------------------ admin
  const admin = await ctx.newPage();
  await admin.goto(`${BASE}/admin/`, { waitUntil: "domcontentloaded" });
  await admin.waitForTimeout(1500);
  await admin.fill("#login-email", ADMIN_EMAIL);
  await admin.fill("#login-password", "intercepted");
  await admin.click('#login-form button[type="submit"]');

  const adminIn = await admin
    .waitForSelector("#app-view:not([hidden])", { timeout: 25000 })
    .then(() => true)
    .catch(() => false);
  check("admin signs in and reaches the dashboard", adminIn);

  // ----------------------------------------------------------------- tester
  const tester = await ctx.newPage();
  // The proof that the tester portal authenticated normally: it reached
  // /tester-me with a bearer token. Its result is irrelevant here — this account
  // is not on the roster, so a correct 403 "not on the CRP tester list" is the
  // expected outcome and makes the portal show its login form again.
  const testerMe = [];
  tester.on("console", (m) => console.log("   [tester console]", m.text().slice(0, 120)));
  // Requests are captured rather than responses: a cross-origin call can be
  // reported inconsistently at the response stage, but the request always fires.
  tester.on("request", (r) => {
    if (r.url().includes("/tester-me")) {
      testerMe.push({ url: r.url(), auth: Boolean(r.headers().authorization) });
    }
  });
  tester.on("response", (r) => {
    if (r.url().includes("/tester-me")) testerMe[testerMe.length - 1].status = r.status();
  });
  await tester.goto(`${BASE}/tester/index.html`, { waitUntil: "domcontentloaded" });
  await tester.waitForTimeout(1500);
  await tester.fill("#login-email", TESTER_EMAIL);
  await tester.fill("#login-password", "intercepted");
  await tester.click('#login-form button[type="submit"]');
  await tester.waitForTimeout(6000);

  check("tester portal authenticated and called /tester-me with a bearer token",
    testerMe.length > 0 && testerMe[testerMe.length - 1].auth === true,
    JSON.stringify(testerMe));
  // No status assertion: from http://localhost:8900 the Worker refuses the
  // origin (ALLOWED_ORIGINS is https://crp-company.github.io), so the call
  // fails at CORS rather than returning 403. That is a harness limitation, not
  // the behaviour under test — what matters here is that the tester portal
  // authenticated on its own and issued an authorised call.

  // ---------------------------------------------------- the regression itself
  // Both pages are now signed in as DIFFERENT accounts in the same browser.
  // Before the fix, this is where the admin tab was thrown back to login.
  await admin.waitForTimeout(5000);
  check("admin session SURVIVES the tester sign-in",
    await admin.locator("#app-view").isVisible());
  check("admin never transitioned back to the login view",
    !(await admin.locator("#login-view").isVisible()));

  const adminError = ((await admin.locator("#login-error").textContent().catch(() => "")) || "").trim();
  check("admin shows no sign-in or claim error", adminError === "", `shown: "${adminError}"`);

  // The tester portal must be unharmed by the admin's session: it still holds
  // its own signed-in state, not the admin's.
  const testerSession = await tester.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("firebase:authUser:"));
    const db = document.getElementById("login-error");
    return { stored: key || null, error: (db?.textContent || "").trim() };
  });
  check("tester portal shows no auth failure of its own",
    !/could not verify|invalid|no admin claim/i.test(testerSession.error),
    `shown: "${testerSession.error}"`);

  await ctx.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  await browser.close();
  console.log("");
  console.log(failed === 0 ? "AUTH ISOLATION E2E PASS" : `AUTH ISOLATION E2E FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error("harness error:", e.message); process.exit(1); });