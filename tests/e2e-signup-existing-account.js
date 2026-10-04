/**
 * Regression: "has a CRP account" is not the same as "is a CRP Tester".
 *
 * The defect: signup treated `auth/email-already-in-use` as fatal, so anyone
 * whose Auth account outlived their tester record could never apply again. The
 * account survives removal, so a removed tester was permanently locked out of
 * reapplying — the exact lifecycle the programme is built to support.
 *
 * The discriminator is `testerIndex/{sha256(email)}`: the Worker writes it on
 * approval and removal DELETES it, so it exists exactly while someone is on the
 * roster. `testerHistory`, the legacy `testers` collection and `/users/{uid}`
 * are deliberately not consulted — a removed tester keeps all three.
 *
 * Runs against the Auth + Firestore emulators. Nothing touches production.
 *
 *   firebase emulators:exec --only firestore,auth -- node tests/e2e-signup-existing-account.js
 */
const { chromium } = require("playwright");
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const FS_EMU = "http://127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT || "crp-cuby-display";
const SITE = "http://localhost:8900/index.html?emulator=1";
const PASSWORD = "correct-horse-battery";
const ADMIN_HEADERS = { Authorization: "Bearer owner" };

const sa = JSON.parse(fs.readFileSync(path.join(os.homedir(), "crp-cuby-key.json"), "utf8"));
// The service-account key doubles as the emulator credential; emulators accept
// any well-formed one.
const app = initializeApp({ credential: cert(sa), projectId: PROJECT });
const auth = getAuth(app);
const db = getFirestore(app);

const hash = (e) => crypto.createHash("sha256").update(String(e).trim().toLowerCase()).digest("hex");

let failed = 0;
function check(name, ok, detail = "") {
  const line = `${ok ? "  PASS" : "  FAIL"}  ${name}`;
  console.log(ok ? line : `${line}${detail ? `\n          ${detail}` : ""}`);
  if (!ok) failed += 1;
}

const stamp = Date.now();
const NEW_EMAIL = `fresh-${stamp}@example.com`;
const EXISTING_EMAIL = `existing-${stamp}@example.com`;
const ACTIVE_EMAIL = `active-${stamp}@example.com`;
const REMOVED_EMAIL = `removed-${stamp}@example.com`;

const createAccount = (email) => auth.createUser({ email, password: PASSWORD });
const seedPointer = (email, userId) =>
  db.collection("testerIndex").doc(hash(email)).set({ userId, testerId: null, updatedAt: new Date() });
const countRequests = async (email) =>
  (await db.collection("requests").where("email", "==", email).get()).size;

async function clearFirestore() {
  for (const c of ["requests", "requestEmails", "users", "testerIndex"]) {
    await fetch(`${FS_EMU}/emulator/v1/projects/${PROJECT}/databases/(default)/documents/${c}`,
      { method: "DELETE", headers: ADMIN_HEADERS });
  }
}

/** Fill in and submit the public application form. */
async function apply(page, email) {
  await page.goto(SITE, { waitUntil: "networkidle" });
  await page.fill('input[name="name"]', "Test Applicant");
  await page.fill('input[name="email"]', email);
  await page.fill("#applicantPassword", PASSWORD);
  await page.check('input[name="experienceCategory"][value="developer"]');
  await page.check("#consentCheckbox");
  await page.click("#joinButton");
}

const landedOnSent = (page) =>
  page.waitForURL("**/sent.html", { timeout: 20000 }).then(() => true).catch(() => false);

const messageOf = async (page) => ((await page.textContent("#formMessage")) || "").trim();

(async () => {
  await clearFirestore();

  // The fixtures. NEW_EMAIL deliberately gets NO Auth account — that is what
  // makes it the brand-new case. The other three each get an account, differing
  // only in whether they are currently on the roster.
  await createAccount(EXISTING_EMAIL);               // Auth account, never a tester
  const active = await createAccount(ACTIVE_EMAIL);
  await seedPointer(ACTIVE_EMAIL, active.uid);       // Auth + currently on the roster
  const removed = await createAccount(REMOVED_EMAIL);
  // Auth + testerHistory but NO pointer — precisely what removal leaves behind.
  await db.collection("users").doc(removed.uid).set({
    email: REMOVED_EMAIL, displayName: "Removed Tester",
    testerHistory: [{ id: "t_old", testerNumber: 3, removed: true, removalReason: "test 13" }],
  });

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 1. A brand-new address applies exactly as before.
  await apply(page, NEW_EMAIL);
  const newApplied = await landedOnSent(page);
  check("1. a brand-new email applies successfully", newApplied,
    newApplied ? "" : `message: "${await messageOf(page)}"`);
  check("   and a request was written", (await countRequests(NEW_EMAIL)) === 1,
    `${await countRequests(NEW_EMAIL)} request(s)`);

  // 2. An existing Auth account that is not a tester may apply.
  await apply(page, EXISTING_EMAIL);
  check("2. an existing Auth account with no testerIndex applies successfully",
    await landedOnSent(page));
  check("   and a request was written", (await countRequests(EXISTING_EMAIL)) === 1);

  // 3. An ACTIVE tester is still blocked, with the dashboard link.
  await apply(page, ACTIVE_EMAIL);
  await page.waitForTimeout(6000);
  const activeMsg = await messageOf(page);
  check("3. an active tester is blocked", !page.url().includes("sent.html"));
  check("   with the existing-account message",
    /already have a CRP account/i.test(activeMsg), `shown: "${activeMsg}"`);
  check("   and the tester dashboard link is shown",
    await page.locator("#signinLink").isVisible());
  check("   and no request was written", (await countRequests(ACTIVE_EMAIL)) === 0);

  // 4. A REMOVED tester may reapply: account and history intact, pointer gone.
  await apply(page, REMOVED_EMAIL);
  check("4. a removed tester can reapply", await landedOnSent(page));
  check("   and a request was written", (await countRequests(REMOVED_EMAIL)) === 1);
  const stillThere = await auth.getUserByEmail(REMOVED_EMAIL);
  check("   their existing account was neither modified nor deleted",
    stillThere.uid === removed.uid);
  const historyKept = await db.collection("users").doc(removed.uid).get();
  check("   and their tester history was left intact",
    Array.isArray(historyKept.data().testerHistory)
    && historyKept.data().testerHistory.length === 1);

  // 5. Duplicate protection still works, via requestEmails. Uses NEW_EMAIL,
  // whose application genuinely landed in case 1, so this exercises the marker on
  // its own rather than depending on case 2 having succeeded.
  await apply(page, NEW_EMAIL);
  await page.waitForTimeout(6000);
  const dupMsg = await messageOf(page);
  check("5. a second application is still refused",
    /already applied/i.test(dupMsg), `shown: "${dupMsg}"`);
  check("   and still only one request exists", (await countRequests(NEW_EMAIL)) === 1,
    `${await countRequests(NEW_EMAIL)} request(s)`);

  await browser.close();
  await clearFirestore();
  console.log("");
  console.log(failed === 0
    ? "SIGNUP EXISTING-ACCOUNT E2E PASS"
    : `SIGNUP EXISTING-ACCOUNT E2E FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error("harness error:", e.message); process.exit(1); });