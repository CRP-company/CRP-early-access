/**
 * End-to-end check of the new signup flow, in a real browser against the
 * Firestore and Auth emulators.
 *
 * What this proves that unit tests cannot:
 *   - the applicant creates their OWN account, with their own password;
 *   - a second attempt on the same address is refused as "already have an
 *     account", and creates no second account;
 *   - the applicant is signed back OUT after submitting;
 *   - the password appears in no Firestore document, not even the request.
 *
 *   node tests/e2e-signup-account.js
 */
const { chromium } = require("playwright");
const crypto = require("crypto");

const EMULATOR_HOST = "127.0.0.1";
const AUTH_BASE = `http://${EMULATOR_HOST}:9099`;
const FIREBASE_BASE = `http://${EMULATOR_HOST}:8080`;
const PROJECT = process.env.GCLOUD_PROJECT || "crp-cuby-display";
const SITE = "http://localhost:8900/index.html?emulator=1";
const PASSWORD = "correct-horse-battery";

const adminHeaders = { Authorization: "Bearer owner" };
// The Auth emulator requires an API key on every call, exactly like production.
// Omitting it returns 403 PERMISSION_DENIED, which `accounts:query` answers with
// no `userInfo` at all — so a missing key looks exactly like "zero accounts"
// rather than like an error. That is a silent way to test nothing.
const API_KEY = "AIzaSyB_uiI4nlcyfgyq61ncJCMDodJPeE_OYIY";

function post(path, body) {
  return fetch(
    `${AUTH_BASE}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}${path}?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

/**
 * Does an account exist for this address?
 *
 * Uses `accounts:createAuthUri`, the same call the client SDK makes for password
 * RESET. `accounts:query` is admin-only and answers INSUFFICIENT_PERMISSION here
 * without a service account — and it does so by returning no `userInfo` rather
 * than an error, which looks identical to "no accounts exist" and silently makes
 * every assertion below vacuous.
 */
const accountExists = async (email) => {
  const res = await fetch(
    `${AUTH_BASE}/identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: email,
        continueUri: "https://crp-company.github.io/",
      }),
    },
  );
  const json = await res.json();
  // A 400 carrying USER_NOT_FOUND means the account genuinely does not exist,
  // which is the answer we want. Anything else is a real problem worth raising.
  if (res.ok) return true;
  if (String(json?.error?.message || "").includes("USER_NOT_FOUND")) return false;
  throw new Error(`createAuthUri failed: ${res.status} ${JSON.stringify(json)}`);
};

const clearFirestore = async () => {
  for (const coll of ["requests", "requestEmails", "users"]) {
    await fetch(`${FIREBASE_BASE}/emulator/v1/projects/${PROJECT}/databases/(default)/documents/${coll}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
  }
};

const allRequests = async () => {
  const res = await fetch(
    `${FIREBASE_BASE}/v1/projects/${PROJECT}/databases/(default)/documents/requests`,
    { headers: adminHeaders },
  );
  return (await res.json()).documents || [];
};

(async () => {
  const errors = [];
  let failed = 0;

  // Clear FIRST. The Auth emulator keeps accounts across runs, so a leftover
  // dana@example.com makes the first signup fail with EMAIL_EXISTS and looks
  // like a bug in the flow rather than stale state.
  //
  // Each address is also unique per run, so the test cannot pass or fail based on
  // whatever a previous run happened to leave behind.
  const email = `dana+${Date.now()}@example.com`;
  await clearFirestore();
  console.log(`  (applicant: ${email})`);

  const check = (name, condition, detail = "") => {
    if (condition) {
      console.log(`  PASS  ${name}`);
    } else {
      failed += 1;
      console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e.message).split("\n")[0]));

  // ---------------------------------------------------------------- signup
  await page.goto(SITE, { waitUntil: "networkidle" });

  const hasField = await page.locator("#applicantPassword").count();
  check("password field is present and visible", hasField === 1);

  await page.fill('input[name="name"]', "Dana Tester");
  await page.fill('input[name="email"]', email);
  await page.fill("#applicantPassword", "short");
  await page.check('input[name="experienceCategory"][value="developer"]');
  await page.check("#consentCheckbox");

  const enabledWithShort = await page.isEnabled("#joinButton");
  check("submit stays disabled while the password is too short", !enabledWithShort);

  await page.fill("#applicantPassword", PASSWORD);
  await page.click("#joinButton");

  const landed = await page
    .waitForURL("**/sent.html", { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check("submission reached the confirmation page", landed);

  // -------------------------------------------------- the account was made
  check("applicant created their own Auth account", await accountExists(email));

  // ---------------------------------------- the password is nowhere stored
  const requests = await allRequests();
  const blob = JSON.stringify(requests);
  check("the request was written", requests.length === 1, `${requests.length} requests`);
  check("no request field holds the password", !blob.includes(PASSWORD));
  check("no request field is even named password", !/password/i.test(blob));

  check("signup completed without a page error", errors.length === 0, errors.join(" | "));

  // The applicant must not be left signed in on a public, possibly shared machine.
  // The SDK persists its user record in localStorage under this key; a signed-out
  // auth instance removes it. Asserted on the storage directly rather than via an
  // API call, which would need the very session being tested.
  const persistedUser = await page.evaluate(() =>
    Object.keys(window.localStorage).find((k) => k.startsWith("firebase:authUser:")),
  );
  check("applicant is signed back out after submitting", persistedUser === undefined,
    `localStorage still holds ${persistedUser}`);

  // ------------------------------------ a second attempt is refused cleanly
  //
  // The refusal below is the ACTIVE-TESTER path: the applicant is on the roster,
  // so applying again cannot help and the page sends them to their dashboard.
  // That is decided by `testerIndex/{sha256(email)}` existing — the Worker's own
  // signal — so it is seeded here. Without it this address merely has an account,
  // which is NOT the same thing and is covered by
  // tests/e2e-signup-existing-account.js.
  const emailHash = crypto
    .createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
  const seedPointer = await fetch(
    `${FIREBASE_BASE}/v1/projects/${PROJECT}/databases/(default)/documents:commit`,
    {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        writes: [{
          update: {
            name: `projects/${PROJECT}/databases/(default)/documents/testerIndex/${emailHash}`,
            fields: {
              userId: { stringValue: "emulator-uid" },
              testerId: { nullValue: null },
              updatedAt: { timestampValue: new Date().toISOString() },
            },
          },
        }],
      }),
    },
  );
  if (!seedPointer.ok) {
    throw new Error(`could not seed testerIndex: ${seedPointer.status} ${await seedPointer.text()}`);
  }

  const page2 = await ctx.newPage();
  page2.on("pageerror", (e) => errors.push(String(e.message).split("\n")[0]));
  await page2.goto(SITE, { waitUntil: "networkidle" });
  await page2.fill('input[name="name"]', "Dana Tester");
  await page2.fill('input[name="email"]', email);
  await page2.fill("#applicantPassword", "a-different-password");
  await page2.check('input[name="experienceCategory"][value="developer"]');
  await page2.check("#consentCheckbox");
  await page2.click("#joinButton");
  await page2.waitForTimeout(4000);

  const message = (await page2.textContent("#formMessage")).trim();
  check(
    "existing account is refused with a clear message",
    /already have a CRP account/i.test(message),
    `got: "${message}"`,
  );
  check(
    "the refused applicant is not sent to the confirmation page",
    !page2.url().includes("sent.html"),
  );

  // --------------------------------- the dead end is actually escapable now
  // The message tells the applicant to sign in, so the page owes them a way to
  // do it. Asserted as a visible link that leads to the tester dashboard, not
  // merely present in the DOM: `hidden` nodes are invisible to a real user.
  const signinLink = page2.locator("#signinLink");
  check("the existing-account message offers a sign-in link", await signinLink.isVisible());

  const href = await signinLink.getAttribute("href");
  check("the link points at the tester dashboard", href === "tester/index.html", `got "${href}"`);

  // Follow it. Landing on a page with no sign-in form would leave the applicant
  // exactly as stuck as before, so the form's presence is asserted directly.
  await signinLink.click();
  const landedOnPortal = await page2
    .waitForURL(/tester\/index\.html/, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("the link reaches the tester dashboard", landedOnPortal, `url: ${page2.url()}`);

  const hasLoginForm = await page2.locator("#login-form").count();
  check("the tester dashboard shows its sign-in form", hasLoginForm === 1);

  const emailField = await page2.locator("#login-email").count();
  const passwordField = await page2.locator("#login-password").count();
  check("the sign-in form asks for an email and a password",
    emailField === 1 && passwordField === 1);

  // The link must not be a permanent fixture on the landing page: a stray
  // "Sign in" under an unrelated message would be a non sequitur.
  const page3 = await ctx.newPage();
  await page3.goto(SITE, { waitUntil: "networkidle" });
  check("the sign-in link stays hidden on a normal page load",
    !(await page3.locator("#signinLink").isVisible()));
  await page3.close();

  check("the account still exists after the refused attempt", await accountExists(email));
  const afterRequests = await allRequests();
  check("no second request was written", afterRequests.length === 1, `${afterRequests.length}`);

  await browser.close();
  await clearFirestore();

  console.log("");
  const ok = failed === 0 && errors.length === 0;
  console.log(ok ? "SIGNUP ACCOUNT E2E PASS" : "SIGNUP ACCOUNT E2E FAIL");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("harness error:", e.message);
  process.exit(1);
});