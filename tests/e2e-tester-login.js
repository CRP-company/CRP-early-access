/**
 * End-to-end sign-in for the CRP tester portal, in a real browser.
 *
 * Covers the whole loop that the "you already have an account" message now
 * sends an applicant through:
 *
 *   apply with an existing address -> "Sign in to Tester Dashboard" -> the
 *   portal's sign-in form -> Firebase Auth -> an ID token -> /tester-me -> the
 *   dashboard, populated with that tester's own data.
 *
 * What is real here
 * -----------------
 *   - the browser, and the Firebase JS SDK's real sign-in flow;
 *   - a real account in the Firebase Auth emulator (created by this test);
 *   - a real roster in the Firestore emulator: `users/{uid}` with a `tester`
 *     map, plus the `testerIndex` pointer the Worker maintains;
 *   - the UNMODIFIED Worker (`crp-tester-email/src/index.js`), running locally
 *     via tests/lib/worker-harness.mjs — real CORS, real preflight, real
 *     `requireUser()` signature/issuer/audience checks, real roster resolution;
 *   - the portal's own index.html and tester.js, served by scripts/dev-server.js.
 *
 * The one substitution
 * --------------------
 * The Firebase Auth emulator signs ID tokens with `algorithm: "none"` — unsigned,
 * no keypair to publish. The Worker's `auth.js` rejects anything that is not
 * RS256, which is correct and deliberate. So the harness mints a real RS256 token
 * for the signed-in tester and substitutes it at the token-mint boundary: the
 * sign-in response is intercepted and its `idToken` replaced. Everything after
 * that point is the genuine article — the SDK stores and sends this token, and
 * the Worker verifies its signature for real. This is a stand-in for Google's
 * token service, which cannot be emulated.
 *
 * Isolation
 * ---------
 * Nothing here touches production. The browser is redirected away from the live
 * Worker URL and from identitytoolkit.googleapis.com by request interception
 * alone; no config file is edited, and the Firestore and Auth emulators are
 * per-run.
 *
 *   firebase emulators:exec --only firestore,auth -- node tests/e2e-tester-login.js
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const { startWorkerHarness, encodeFields } = require("./lib/worker-harness.mjs");

const EMULATOR_HOST = "127.0.0.1";
const AUTH_BASE = `http://${EMULATOR_HOST}:9099`;
const FIRESTORE_BASE = `http://${EMULATOR_HOST}:8080`;
const PROJECT = process.env.GCLOUD_PROJECT || "crp-cuby-display";
const API_KEY = "AIzaSyB_uiI4nlcyfgyq61ncJCMDodJPeE_OYIY";

const SITE_PORT = 8900;
const SITE = `http://localhost:${SITE_PORT}`;
const LANDING = `${SITE}/index.html?emulator=1`;
const PORTAL = `${SITE}/tester/index.html`;

const WORKER_PORT = 8901;
const DEV_SERVER = path.resolve(__dirname, "../scripts/dev-server.js");

// Unique per run: the Auth emulator keeps accounts between runs, so a leftover
// address from a previous run would read as "already has an account" for the
// wrong reason.
const EMAIL = `tina+${Date.now()}@example.com`;
const PASSWORD = "correct-horse-battery";

const adminHeaders = { Authorization: "Bearer owner" };

let failed = 0;
function check(name, ok, detail = "") {
  const line = `${ok ? "  PASS" : "  FAIL"}  ${name}`;
  console.log(ok ? line : `${line}${detail ? `\n          ${detail}` : ""}`);
  if (!ok) failed += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SHA-256 hex of a lowercased, trimmed address — must match tester-portal.js. */
async function hashEmail(email) {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Create the account in the Auth emulator, the way the signup form does. */
async function createAuthAccount() {
  // No /projects/{id} segment: the Auth emulator answers the Identity Toolkit
  // shape (`/v1/accounts:signUp`) and derives the project from the API key. The
  // project-scoped path 404s.
  const res = await fetch(
    `${AUTH_BASE}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
    },
  );
  const json = await res.json();
  if (!res.ok) throw new Error(`auth seed failed: ${res.status} ${JSON.stringify(json)}`);
  return json.localId;
}

/**
 * Write documents to the Firestore emulator as its admin.
 *
 * Uses `:commit` rather than a document-scoped POST. The single-document create
 * route on this emulator version reports "Document parent name ... lacks / at
 * index 61" for a perfectly well-formed path, and a commit carries both seeded
 * documents in one round trip anyway. `update` with no updateMask is an upsert,
 * which is what seeding wants.
 */
async function seedDocs(docs) {
  const res = await fetch(
    `${FIRESTORE_BASE}/v1/projects/${PROJECT}/databases/(default)/documents:commit`,
    {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        writes: docs.map(({ collection, id, value }) => ({
          update: {
            name: `projects/${PROJECT}/databases/(default)/documents/${collection}/${id}`,
            fields: encodeFields(value),
          },
        })),
      }),
    },
  );
  if (!res.ok) throw new Error(`seed: ${res.status} ${await res.text()}`);
}

async function clearFirestore() {
  for (const coll of ["requests", "requestEmails", "users", "testerIndex"]) {
    await fetch(
      `${FIRESTORE_BASE}/emulator/v1/projects/${PROJECT}/databases/(default)/documents/${coll}`,
      { method: "DELETE", headers: adminHeaders },
    );
  }
}

/** Wait for a URL to answer, so the test never races a starting server. */
async function waitForUrl(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok || res.status === 404) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

(async () => {
  await clearFirestore();

  // ---- the roster: an accepted tester, exactly as acceptance would leave it --
  const uid = await createAuthAccount();
  console.log(`\n  (seeded ${EMAIL} as ${uid})`);

  await seedDocs([
    {
      collection: "users",
      id: uid,
      value: {
        email: EMAIL,
        displayName: "Tina Tester",
        tester: {
          id: "t_e2e_login",
          name: "Tina Tester",
          email: EMAIL,
          // STATUS.ACCEPTED is what makes `canSubmitFeedback` allow submissions.
          status: "accepted",
          testerNumber: 7,
        },
      },
    },
    { collection: "testerIndex", id: await hashEmail(EMAIL), value: { userId: uid } },
  ]);

  // ---- serve the site, and run the real worker behind it ------------------
  const devServer = spawn(process.execPath, [DEV_SERVER], {
    cwd: path.resolve(__dirname, ".."),
    stdio: "ignore",
  });
  await waitForUrl(`${SITE}/index.html`);
  check("the static site is served", true);

  const worker = await startWorkerHarness({
    port: WORKER_PORT,
    projectId: PROJECT,
    allowedOrigin: SITE,
    firestoreOrigin: FIRESTORE_BASE,
  });
  check("the real worker is running locally", true, `at ${worker.url}`);

  const browser = await chromium.launch();

  // The harness mints a real RS256 token, handed to the browser in place of the
  // emulator's unsigned one. Minted once: the same tester signs in twice below.
  const rsaToken = await worker.mintToken({ uid, email: EMAIL });
  let tokenSubstituted = false;

  /**
   * Point a context away from production, and record what it does.
   *
   * Applied per context rather than to the browser, because the two halves of
   * this test need genuinely different storage: the landing-page leg must start
   * signed OUT, or the portal correctly skips its login form and the leg cannot
   * be exercised at all.
   */
  function instrument(ctx, sink) {
    // 1. The committed worker-config.js points at the live Worker. Rewrite the
    //    response so the portal talks to the local one instead. The file on disk
    //    is untouched, and the page still reads the URL the way it ships.
    ctx.route("**/tester/js/worker-config.js", async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/https:\/\/[^\s"']*workers\.dev/, worker.url);
      await route.fulfill({
        response,
        body,
        headers: { ...response.headers(), "content-type": "application/javascript" },
      });
    });

    // 2. The Firebase SDK talks to identitytoolkit.googleapis.com by default.
    //    Point it at the Auth emulator, and substitute the harness's RS256 token
    //    (see the file header for why).
    ctx.route("**/identitytoolkit.googleapis.com/**", async (route) => {
      const request = route.request();
      // The host is swapped but the path prefix is KEPT: the emulator serves
      // /identitytoolkit.googleapis.com/v1/... and answers auth/not-found for a
      // bare /v1/..., which looks exactly like "that account does not exist".
      const target = request.url().replace(
        "https://identitytoolkit.googleapis.com",
        `${AUTH_BASE}/identitytoolkit.googleapis.com`,
      );
      const response = await route.fetch({ url: target });

      if (!request.url().includes("signInWithPassword")) {
        await route.fulfill({ response });
        return;
      }

      const original = await response.json();
      tokenSubstituted = true;
      await route.fulfill({
        response,
        json: { ...original, idToken: rsaToken, expiresIn: "3600" },
        headers: { ...response.headers(), "content-type": "application/json" },
      });
    });

    ctx.route("**/securetoken.googleapis.com/**", async (route) => {
      const target = route.request().url().replace(
        "https://securetoken.googleapis.com",
        `${AUTH_BASE}/securetoken.googleapis.com`,
      );
      await route.continue({ url: target });
    });

    // ---- watch for the failures this test is meant to catch ----------------
    ctx.on("page", (page) => {
      page.on("console", (msg) => {
        if (msg.type() === "error") sink.consoleErrors.push(msg.text());
      });
      page.on("pageerror", (error) =>
        sink.pageErrors.push(String(error.message).split("\n")[0]),
      );
      page.on("requestfailed", (request) => {
        sink.failedRequests.push(
          `${request.method()} ${request.url()}: ${request.failure()?.errorText}`,
        );
      });
      page.on("response", (response) => {
        // Every non-2xx, so the diagnostics can prove that the only failures are
        // the ones this test provokes on purpose.
        if (response.status() >= 400) {
          sink.badResponses.push(`${response.status()} ${response.url()}`);
        }
        if (!response.url().endsWith("/tester-me")) return;
        sink.testerMeCalls.push({
          status: response.status(),
          authorization: response.request().headers().authorization || "",
          cors: response.headers()["access-control-allow-origin"] || null,
        });
      });
    });
  }

  const context = await browser.newContext();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const testerMeCalls = [];
  const badResponses = [];
  const sink = { consoleErrors, pageErrors, failedRequests, testerMeCalls, badResponses };
  instrument(context, sink);

  try {
    // =========================================================== the portal
    console.log("\n  Tester Portal sign-in");
    const portal = await context.newPage();
    await portal.goto(PORTAL, { waitUntil: "networkidle" });

    check("the portal shows its sign-in form", await portal.locator("#login-form").isVisible());
    check(
      "the dashboard is hidden before sign-in",
      !(await portal.locator("#app-view").isVisible()),
    );

    // ---- wrong password first: the ordinary failure path ------------------
    await portal.fill("#login-email", EMAIL);
    await portal.fill("#login-password", "not-the-password");
    await portal.click("#login-submit");
    await portal.waitForFunction(
      () => {
        const node = document.getElementById("login-error");
        return node && !node.hidden && node.textContent.trim().length > 0;
      },
      { timeout: 20000 },
    );
    const wrongPasswordError = (await portal.textContent("#login-error")).trim();
    check(
      "a wrong password is refused with a readable error",
      /not right/i.test(wrongPasswordError),
      `got: "${wrongPasswordError}"`,
    );
    check(
      "a wrong password does not open the dashboard",
      !(await portal.locator("#app-view").isVisible()),
    );

    // ---- now the real thing ------------------------------------------------
    await portal.fill("#login-password", PASSWORD);
    await portal.click("#login-submit");

    const dashboardShown = await portal
      .locator("#app-view")
      .waitFor({ state: "visible", timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check("the correct password opens the dashboard", dashboardShown);
    check("Firebase sign-in succeeded", tokenSubstituted);

    // Persistence is asserted by BEHAVIOUR, below (reload still works), not by
    // reading storage. Firebase v12 persists auth to IndexedDB, not localStorage,
    // so a localStorage probe reports nothing even for a perfectly valid session.

    // ---- /tester-me, with the token ----------------------------------------
    check("the portal called /tester-me", testerMeCalls.length > 0, `${testerMeCalls.length} calls`);

    const call = testerMeCalls[testerMeCalls.length - 1] || {
      status: 0,
      authorization: "",
      cors: null,
    };
    check(
      "/tester-me was authorised with a bearer token",
      /^Bearer eyJ/.test(call.authorization || ""),
      `header: "${(call.authorization || "").slice(0, 40)}..."`,
    );

    // Decode the token the browser actually sent, and check it is this tester's.
    const payloadB64 = (call.authorization || "").replace("Bearer ", "").split(".")[1] || "";
    if (payloadB64) {
      const claims = JSON.parse(
        Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
      );
      check("the token identifies the seeded tester", claims.email === EMAIL, `email: ${claims.email}`);
      check("the token is scoped to this project", claims.aud === PROJECT, `aud: ${claims.aud}`);
      check(
        "the token has Google's real issuer",
        claims.iss === `https://securetoken.google.com/${PROJECT}`,
        `iss: ${claims.iss}`,
      );
    }

    check("/tester-me answered 200", call.status === 200, `status ${call.status}`);
    check(
      "/tester-me returned an origin the browser can read",
      call.cors === SITE,
      `Access-Control-Allow-Origin: ${call.cors}`,
    );

    // ---- the dashboard shows that tester's data ----------------------------
    const heading = (await portal.textContent("#tester-name")).trim();
    check("the dashboard greets the tester by name", /Tina/.test(heading), `got: "${heading}"`);

    const meta = (await portal.textContent("#tester-meta")).trim();
    check(
      "the dashboard shows the tester number and email",
      meta.includes("#7") && meta.includes(EMAIL),
      `got: "${meta}"`,
    );
    check("the request form is open for an active tester",
      await portal.locator("#feedback-form").isVisible());
    check("the dashboard shows the monthly target",
      (await portal.textContent("#target-text")).trim().length > 0);

    // ---- the session survives a reload -------------------------------------
    // This is the real persistence test, and it is behavioural on purpose: after a
    // reload the page has only persisted state to work from, so if the dashboard
    // comes back it can only be because the SDK restored the session and
    // re-obtained a token. Firebase v12 keeps that in IndexedDB, so inspecting
    // localStorage would prove nothing either way.
    const callsBeforeReload = testerMeCalls.length;
    await portal.reload({ waitUntil: "networkidle" });

    const survived = await portal
      .locator("#app-view")
      .waitFor({ state: "visible", timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check("the session survives a page reload", survived);

    check(
      "the login form is not shown again after the reload",
      !(await portal.locator("#login-form").isVisible()),
    );
    check(
      "the restored session re-issued /tester-me",
      testerMeCalls.length > callsBeforeReload,
      `${testerMeCalls.length - callsBeforeReload} new call(s) after reload`,
    );

    const afterReload = testerMeCalls[testerMeCalls.length - 1] || {};
    check(
      "the re-issued call was authorised and accepted",
      afterReload.status === 200 && /^Bearer eyJ/.test(afterReload.authorization || ""),
      `status ${afterReload.status}`,
    );
    check(
      "the dashboard still shows the tester after the reload",
      /Tina/.test((await portal.textContent("#tester-name")).trim()),
    );

    // ========================================= the link from the landing page
    console.log("\n  Existing account -> Sign in link");
    // A FRESH context: this leg is about an applicant who has no session. Sharing
    // the portal's context would leave the tester signed in, and the portal would
    // correctly skip its login form — right behaviour, but it would mean this leg
    // never actually tested signing in.
    const linkContext = await browser.newContext();
    instrument(linkContext, sink);
    const landing = await linkContext.newPage();

    // With ?emulator=1 the signup form uses the emulators directly, so applying
    // with the seeded address hits auth/email-already-in-use for real.
    await landing.goto(LANDING, { waitUntil: "networkidle" });
    await landing.fill('input[name="name"]', "Tina Tester");
    await landing.fill('input[name="email"]', EMAIL);
    await landing.fill("#applicantPassword", "a-different-password");
    await landing.check('input[name="experienceCategory"][value="developer"]');
    await landing.check("#consentCheckbox");
    await landing.click("#joinButton");
    await landing.waitForFunction(
      () => {
        const node = document.getElementById("formMessage");
        return node && /already have a CRP account/i.test(node.textContent);
      },
      { timeout: 20000 },
    );
    check("applying with an existing address is refused", true);

    const link = landing.locator("#signinLink");
    check("the refusal offers a sign-in link", await link.isVisible());

    await link.click();
    const reachedPortal = await landing
      .waitForURL(/tester\/index\.html/, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check("the link reaches the tester portal", reachedPortal, `url: ${landing.url()}`);

    // And that link must lead somewhere that works, not merely somewhere.
    await landing.fill("#login-email", EMAIL);
    await landing.fill("#login-password", PASSWORD);
    await landing.click("#login-submit");
    const signedInViaLink = await landing
      .locator("#app-view")
      .waitFor({ state: "visible", timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check("signing in through the link opens the dashboard", signedInViaLink);
    check(
      "the dashboard behind the link shows the same tester",
      /Tina/.test((await landing.textContent("#tester-name")).trim()),
    );

    // ---- nothing complained along the way ---------------------------------
    console.log("\n  Diagnostics");

    // This test deliberately provokes two failures, and both are supposed to
    // happen: a wrong password, and applying with an address that already has an
    // account. Each legitimately returns 400. The browser logs a generic
    // "Failed to load resource" line for every non-2xx it sees, so counting those
    // as unexpected would mean this test could not verify its own subject.
    //
    // Rather than ignore them wholesale, the exact set of non-2xx responses is
    // checked below: nothing may fail except those two deliberate attempts.
    const EXPECTED_FAILURES = [
      /accounts:signInWithPassword/, // the wrong-password attempt
      /accounts:signUp/, // applying with an existing address
    ];
    const unexpectedResponses = badResponses.filter(
      (entry) => !EXPECTED_FAILURES.some((pattern) => pattern.test(entry)),
    );
    check(
      "the only failed responses are the ones this test provokes",
      unexpectedResponses.length === 0,
      unexpectedResponses.join("\n          "),
    );
    check(
      "both deliberate failures actually happened",
      EXPECTED_FAILURES.every((pattern) => badResponses.some((entry) => pattern.test(entry))),
      badResponses.join("\n          "),
    );

    const corsOrAuth = [...consoleErrors, ...pageErrors, ...failedRequests].filter((line) =>
      /CORS|Access-Control|401|403|Unauthorized|Invalid token|signature/i.test(line),
    );
    check("no CORS or auth errors anywhere", corsOrAuth.length === 0, corsOrAuth.join("\n          "));
    check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
    check("no failed requests", failedRequests.length === 0, failedRequests.join(" | "));

    // Real application errors only. The browser's own "Failed to load resource"
    // line is generic network chrome for any non-2xx, and the two expected 400s
    // above already account for the ones this test causes.
    const appConsoleErrors = consoleErrors.filter(
      (line) => !/Failed to load resource/i.test(line),
    );
    check(
      "no unexpected console errors",
      appConsoleErrors.length === 0,
      appConsoleErrors.join(" | "),
    );
  } finally {
    await browser.close();
    await worker.close();
    devServer.kill();
    await clearFirestore();
  }

  console.log("");
  console.log(failed === 0 ? "TESTER LOGIN E2E PASS" : `TESTER LOGIN E2E FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error("harness error:", error.message);
  process.exit(1);
});