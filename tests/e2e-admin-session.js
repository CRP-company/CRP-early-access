/**
 * Behavioural regression test for the admin dashboard session bug.
 *
 * The bug: onAuthStateChanged force-refreshes the ID token to read the `admin`
 * claim. When that refresh failed transiently, the failure was swallowed, the
 * claim was read from the CACHED token instead (which has no `admin`), and the
 * page concluded "no admin claim" and called signOut() — destroying a valid
 * session, and any fresh manual sign-in still completing in another callback.
 * Symptom: the dashboard appears, then bounces back to the login form.
 *
 * Runs against the local dev server (so it exercises the working tree) and never
 * writes to Firestore: nothing but Sign in is ever clicked. The admin password is
 * neither used nor needed — the sign-in response is answered with a genuine ID
 * token minted from the user's own stored claims.
 *
 *   node tests/e2e-admin-session.js      (dev server must be running on :8900)
 */
const { chromium } = require("playwright");
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ADMIN_PAGE = "http://localhost:8900/admin/";
const API_KEY = "AIzaSyB_uiI4nlcyfgyq61ncJCMDodJPeE_OYIY";
const ADMIN_EMAIL = "atronamir5@gmail.com";

const sa = JSON.parse(fs.readFileSync(path.join(os.homedir(), "crp-cuby-key.json"), "utf8"));
initializeApp({ credential: cert(sa), projectId: sa.project_id });
const auth = getAuth();

let failed = 0;
function check(name, ok, detail = "") {
  const line = `${ok ? "  PASS" : "  FAIL"}  ${name}`;
  console.log(ok ? line : `${line}${detail ? `\n          ${detail}` : ""}`);
  if (!ok) failed += 1;
}

/** A real ID token. `claims === undefined` keeps the user's stored claims. */
async function mintIdToken(uid, claims) {
  const custom = claims === undefined
    ? await auth.createCustomToken(uid)
    : await auth.createCustomToken(uid, claims);
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: custom, returnSecureToken: true }),
    },
  );
  const { idToken } = await res.json();
  return idToken;
}

/** The token the fake STS endpoint hands back, so refreshes are genuine. */
let currentToken = null;
let currentUid = null;

/** Route signInWithPassword and accounts:lookup to the given token. */
async function answerSignIn(context, idToken, uid) {
  currentToken = idToken;
  currentUid = uid;
  await context.unroute("**/identitytoolkit.googleapis.com/**").catch(() => {});
  await context.route("**/identitytoolkit.googleapis.com/**", async (route) => {
    const url = route.request().url();
    if (url.includes("signInWithPassword")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          kind: "identitytoolkit#VerifyPasswordResponse",
          idToken, email: ADMIN_EMAIL, localId: uid, registered: true,
          refreshToken: "repro-refresh-token", expiresIn: "3600",
        }),
      });
    }
    if (url.includes("accounts:lookup")) {
      // The SDK fetches account info with the ID token right after sign-in. It
      // must be answered too: without it the call 400s, the SDK treats the
      // session as invalidated and signs the user out on its own — which would
      // mask what is actually being tested here.
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          kind: "identitytoolkit#LookupAccountInfoResponse",
          users: [{
            localId: uid, email: ADMIN_EMAIL, emailVerified: false, disabled: false,
            displayName: "Admin",
            providerUserInfo: [{
              providerId: "password", displayName: "Admin", rawId: uid,
              federatedId: ADMIN_EMAIL, verifiedEmail: false,
            }],
          }],
        }),
      });
    }
    return route.continue();
  });
}

(async () => {
  const adminUser = await auth.getUserByEmail(ADMIN_EMAIL);
  const adminToken = await mintIdToken(adminUser.uid);
  const nonAdminToken = await mintIdToken(adminUser.uid, { admin: false });

  const browser = await chromium.launch();
  const context = await browser.newContext();
  await answerSignIn(context, adminToken, adminUser.uid);

  // getIdToken(true) FORCES a refresh through the STS endpoint. That refresh
  // must genuinely succeed, or every sign-in would look like a refresh failure.
  // So the STS endpoint is answered with the same token; `breakRefresh` then
  // aborts it to simulate the transient network failure under test.
  //
  // Aborting produces a NETWORK error, which the SDK does NOT treat as an
  // invalidated session. A real `invalid-refresh-token` would make the SDK sign
  // the user out on its own — a different situation entirely.
  let breakRefresh = false;
  await context.route("**/securetoken.googleapis.com/**", async (route) => {
    if (breakRefresh) return route.abort("failed");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        access_token: currentToken,
        id_token: currentToken,
        refresh_token: "repro-refresh-token",
        expires_in: "3600",
        token_type: "Bearer",
        user_id: currentUid,
        project_id: "crp-cuby-display",
      }),
    });
  });

  const page = await context.newPage();
  // Attribute-based, not isVisible(): `.login { display: grid }` in the author
  // stylesheet beats the UA stylesheet's `[hidden] { display: none }`, so the
  // hidden login card still computes as "visible". That is a separate,
  // pre-existing CSS issue and not what this test is about.
  const appShown = async (p = page) =>
    (await p.locator("#app-view").getAttribute("hidden")) === null;
  const loginShown = async (p = page) =>
    (await p.locator("#login-view").getAttribute("hidden")) === null;
  const errorText = async (p = page) =>
    (await p.locator("#login-error").textContent().catch(() => "")).trim();
  const signIn = async () => {
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", "intercepted-not-a-real-password");
    await page.click('#login-form button[type="submit"]');
  };
  // ---------------------------------------------------------------- phase 1
  console.log("\n  1. Fresh admin sign-in");
  await page.goto(ADMIN_PAGE, { waitUntil: "networkidle" });
  await signIn();
  await page.waitForSelector("#app-view:not([hidden])", { timeout: 20000 }).catch(() => {});
  check("the dashboard opens for a valid admin token", await appShown());

  // ---------------------------------------------------------------- phase 2
  console.log("\n  2. Reload while the token refresh is failing");
  breakRefresh = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);

  const failedRefreshError = await errorText();
  check("the page does NOT claim the account lacks the admin claim",
    !/no admin claim/i.test(failedRefreshError), `shown: "${failedRefreshError}"`);
  check("the page reports that it could not verify the session",
    /could not verify/i.test(failedRefreshError), `shown: "${failedRefreshError}"`);
  check("the dashboard is hidden while unverified", !(await appShown()));

  // ---------------------------------------------------------------- phase 3
  // The decisive check that signOut() was NOT called: with the network healthy
  // again, a reload must reach the dashboard from the PERSISTED session, with no
  // password entry. Had the page signed out, the session would be gone and the
  // login form would return instead.
  console.log("\n  3. Session survived (no signOut) — recover with no password");
  breakRefresh = false;
  // domcontentloaded, not networkidle: a persisted session immediately opens
  // Firestore listeners, so the network never goes idle.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app-view:not([hidden])", { timeout: 20000 }).catch(() => {});
  check("the dashboard returns from the persisted session alone", await appShown());
  check("the login view is marked hidden", !(await loginShown()));

  // ------------------------------------------------------ phase 4: the real bug
  // The faithful reproduction of the reported symptom.
  //
  // A session is persisted whose cached ID token does NOT carry the claim (it was
  // minted before `admin` was granted), and the refresh then fails. That is
  // exactly the production state: the old code read the claim off that stale
  // token, concluded "no admin claim", and called signOut() — destroying the
  // session and any fresh sign-in in flight. Once the claim is granted and the
  // network recovers, the user must simply get in.
  console.log("\n  4. Stale session without the claim, refresh failing");
  await answerSignIn(context, nonAdminToken, adminUser.uid);
  breakRefresh = true;
  await page.evaluate(() => {
    localStorage.clear();
    return new Promise((res) => {
      const req = indexedDB.deleteDatabase("firebase-auth-storage");
      req.onsuccess = req.onerror = req.onblocked = () => res();
    });
  });
  await page.goto(ADMIN_PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await signIn();
  await page.waitForTimeout(6000);

  const staleError = await errorText();
  check("a failed refresh is not reported as a missing admin claim",
    !/no admin claim/i.test(staleError), `shown: "${staleError}"`);
  // Permitted to be empty: when the SDK decides the session is itself invalid it
  // signs out before this handler runs. What must never appear is the page
  // blaming the account for a claim that is in fact present.
  check("any message shown is the verification failure, never a blame message",
    staleError === "" || /could not verify/i.test(staleError), `shown: "${staleError}"`);
  check("the dashboard stays hidden while unverifiable", !(await appShown()));

  // The claim now exists and the network is healthy. Recovery must be automatic
  // from the persisted session — no password, no sign-in. If the page had called
  // signOut() when the refresh failed, the session is gone and this fails.
  console.log("\n  5. Claim granted + network healthy — recovers with no password");
  await answerSignIn(context, adminToken, adminUser.uid);
  breakRefresh = false;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app-view:not([hidden])", { timeout: 20000 }).catch(() => {});
  check("the dashboard opens from the preserved session", await appShown());
  check("no password was re-entered", !(await loginShown()));

  // ---------------------------------------------------------------- phase 6
  // The genuine deny path must be intact: a real non-admin token is still
  // refused AND still signed out.
  console.log("\n  6. A genuine non-admin token is still rejected and signed out");
  await answerSignIn(context, nonAdminToken, adminUser.uid);
  await page.evaluate(() => {
    localStorage.clear();
    return new Promise((res) => {
      const req = indexedDB.deleteDatabase("firebase-auth-storage");
      req.onsuccess = req.onerror = req.onblocked = () => res();
    });
  });
  await page.goto(ADMIN_PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await signIn();
  await page.waitForTimeout(7000);

  const nonAdminError = await errorText();
  check("a genuine non-admin token is refused", /no admin claim/i.test(nonAdminError),
    `shown: "${nonAdminError}"`);
  check("the dashboard stays hidden for a non-admin token", !(await appShown()));

  // It must also have been SIGNED OUT, so a reload does not resurrect it.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  check("the non-admin session was actually signed out", await loginShown());

  // ---------------------------------------------------------------- phase 7
  console.log("\n  7. Wrong credentials still show the friendly error");
  await context.unroute("**/identitytoolkit.googleapis.com/**").catch(() => {});
  const page2 = await context.newPage();
  await page2.goto(ADMIN_PAGE, { waitUntil: "networkidle" });
  await page2.fill("#login-email", ADMIN_EMAIL);
  await page2.fill("#login-password", "definitely-not-the-password-7f3a");
  await page2.click('#login-form button[type="submit"]');
  await page2.waitForTimeout(7000);

  const wrongError =
    (await page2.locator("#login-error").textContent().catch(() => "")).trim();
  check("wrong credentials show a readable error", wrongError.length > 0, `shown: "${wrongError}"`);
  check("wrong credentials do not open the dashboard", !(await appShown(page2)));
  await browser.close();
  console.log("");
  console.log(failed === 0 ? "ADMIN SESSION E2E PASS" : `ADMIN SESSION E2E FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error("harness error:", e.message);
  process.exit(1);
});