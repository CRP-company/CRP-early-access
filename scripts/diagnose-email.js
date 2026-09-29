#!/usr/bin/env node
"use strict";

/**
 * Diagnose why acknowledgement emails are not being delivered.
 *
 * Answers the question that actually matters — is the trigger firing, and is
 * Resend accepting the send — without reading Cloud Logging by hand.
 *
 *   npm run fb:login
 *   npm run diagnose:email
 *
 * Optionally set RESEND_API_KEY in your shell to also run the live Resend
 * checks (domain verification, sender validity). The key lives in Secret
 * Manager in production, so skipping it is normal and not an error.
 */

process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||= process.env.GOOGLE_CREDENTIALS;

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PROJECT =
  process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "crp-cuby-display";

const FIREBASE_BIN = path.join(
  __dirname, "..", "node_modules", "firebase-tools", "lib", "bin", "firebase.js",
);

const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const bad = (m) => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const warn = (m) => console.log(`  \x1b[33mWARN\x1b[0m  ${m}`);
const info = (m) => console.log(`  \x1b[90mINFO\x1b[0m  ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

/** Run the Firebase CLI, returning stdout or null on failure. */
function fb(args) {
  try {
    return execFileSync("node", [FIREBASE_BIN, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

/**
 * Run a CLI command, keeping stderr so plan/permission errors can be reported
 * precisely instead of collapsing into a generic "could not reach project".
 */
function fbFull(args) {
  try {
    const stdout = execFileSync("node", [FIREBASE_BIN, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || "") + String(error.message || ""),
    };
  }
}

/**
 * Is the project on the Blaze plan?
 *
 * This is the single most common reason "no emails and no logs": Cloud
 * Functions and Secret Manager both require Blaze, so on the free Spark plan
 * the trigger cannot be deployed at all and nothing is ever sent.
 */
function checkBillingPlan() {
  const res = fbFull(["functions:secrets:access", "RESEND_API_KEY", "--project", PROJECT]);
  const combined = res.stdout + res.stderr;

  if (/must be on the Blaze/i.test(combined)) {
    bad("Project is on the FREE (Spark) plan — this blocks everything.");
    info("Cloud Functions and Secret Manager both require the Blaze plan,");
    info("so onRequestCreated cannot be deployed and no email is ever sent.");
    info("");
    info("Upgrade: https://console.firebase.google.com/project/crp-cuby-display/usage/details");
    info("Billing works on a pay-as-you-go model with a free quota; you are not");
    info("charged unless you exceed it. Set a budget alert to be safe.");
    return "spark";
  }

  if (res.ok || /secret/i.test(combined)) {
    ok("Blaze plan confirmed (secrets API reachable)");
    return "blaze";
  }

  warn("Could not determine the billing plan.");
  return "unknown";
}

/**
 * Is the CLI usable and authenticated?
 *
 * A bare `firebase` is often not on PATH — here it is only a local
 * devDependency — so `firebase login` fails with "command not found" and every
 * later check then reports the misleading "could not reach the project".
 * Distinguish those two situations so the cause is obvious.
 */
function checkCli() {
  if (!fs.existsSync(FIREBASE_BIN)) {
    bad("Firebase CLI is missing from node_modules.");
    info("Fix: npm install");
    return false;
  }

  let onPath = true;
  try {
    execFileSync("firebase", ["--version"], { stdio: "ignore" });
  } catch {
    onPath = false;
  }

  if (!onPath) {
    warn("`firebase` is not on your PATH (it is a local devDependency).");
    info("Use `npx firebase ...` or the npm scripts — both work with no global install.");
  }

  const listOut = fb(["login:list"]);
  const loggedIn = Boolean(listOut) && !/No authorized accounts/i.test(listOut);

  if (loggedIn) ok("Firebase CLI is authenticated");
  else {
    bad("Firebase CLI is NOT authenticated — this is why steps 3-5 are blank.");
    info("Fix: npm run fb:login        (or: npx firebase login)");
  }

  return loggedIn;
}

/** Deployed functions, or null when the CLI cannot reach the project. */
function deployedFunctions() {
  const out = fb(["functions:list", "--project", PROJECT, "--json"]);
  if (!out) return null;
  try {
    return JSON.parse(out).result ?? [];
  } catch {
    return [];
  }
}

(async () => {
  const key = process.env.RESEND_API_KEY;

  /* --------------------------------------------------------- 0. the CLI */

  head("0. Firebase CLI");
  const authenticated = checkCli();

  /* ------------------------------------------------------- 0b. plan */

  head("1. Billing plan");
  const plan = authenticated ? checkBillingPlan() : "unknown";

  /* ------------------------------------------------------------- 1. key */

  head("2. Resend API key");

  if (!key) {
    warn("RESEND_API_KEY is not set in this shell (expected in production)");
    info("It lives in Secret Manager. Set it locally to run the live checks:");
    info("  export RESEND_API_KEY=re_xxx");
  } else {
    info(`key found: ${key.slice(0, 8)}…${key.slice(-4)}`);
    const { Resend } = require(path.join(__dirname, "..", "functions", "node_modules", "resend"));
    const resend = new Resend(key);

    const { data, error } = await resend.domains.list();
    if (error) {
      bad(`Resend rejected the key: ${error.message}`);
    } else {
      ok("key accepted by Resend");
      const list = data?.data ?? data ?? [];
      console.log("\n  Domains on this Resend account:");
      if (!list.length) {
        warn("none verified — Resend will only send to your own email address");
      }
      for (const d of list) console.log(`    ${d.name}  [${d.status}]`);
    }
  }

  /* --------------------------------------------------------- 2. sender */

  head("3. Sender address");

  const from = process.env.CRP_EMAIL_FROM || "CRP <onboarding@resend.dev>";
  info(`from = ${from}`);

  if (from.includes("onboarding@resend.dev")) {
    bad("Using onboarding@resend.dev");
    info("Resend only allows this as the sender for your OWN email address.");
    info('Fix: npm run fb -- functions:config:set CRP_EMAIL_FROM="CRP <hello@yourdomain.com>"');
    info("...after verifying that domain at https://resend.com/domains");
  } else {
    const domain = from.match(/@([^\s>]+)/)?.[1];
    info(`sender domain: ${domain}`);
    warn("Confirm it shows as 'verified' in step 1, or Resend rejects the send.");
  }

  if (!authenticated) {
    head("Stopped");
    console.log("  The remaining steps need an authenticated CLI.\n");
    console.log("  Run this, then re-run the diagnostic:\n");
    console.log("    npm run fb:login\n");
    console.log("  No global install needed — the CLI is a local devDependency and");
    console.log("  `npx firebase login` works just as well.\n");
    return;
  }

  /* ------------------------------------------------------ 4. deployed */

  head("4. Deployed functions");

  const deployed = deployedFunctions();

  if (deployed === null) {
    // The CLI is authenticated, so this is not an auth problem. Report the
    // real reason instead of repeating the "run login" advice.
    const res = fbFull(["functions:list", "--project", PROJECT]);
    const detail = (res.stderr || res.stdout).split("\n").find((l) => /error/i.test(l));
    bad("Could not list functions.");
    info(detail ? detail.trim() : "(no detail returned)");
    if (plan === "spark") {
      info("This is expected on the free plan — upgrade to Blaze first.");
    } else {
      info("Check you have permission on this project, or that the Functions API is on.");
    }
  } else if (!deployed.length) {
    bad("NO functions are deployed.");
    if (plan === "spark") {
      info("This is the root cause: Cloud Functions need the Blaze plan.");
      info("Upgrade, then run: npm run deploy:functions");
    } else {
      info("Fix: npm run deploy:functions");
    }
  } else {
    ok(`${deployed.length} function(s) deployed`);
    for (const fn of deployed) {
      const isEmail = /onRequestCreated|onManualResend/.test(fn.name || "");
      console.log(`    ${String(fn.name).padEnd(24)} ${fn.region}${isEmail ? "  <-- email" : ""}`);
    }
    if (!deployed.some((f) => /onRequestCreated/.test(f.name || ""))) {
      bad("onRequestCreated is NOT deployed, so the email trigger does not exist.");
      info("Fix: npm run deploy:functions");
    }
  }

  /* --------------------------------------------------------- 5. secret */

  head("5. Secret binding");

  if (plan === "spark") {
    warn("Skipped — Secret Manager requires the Blaze plan.");
  } else {
    const secretRes = fbFull(["functions:secrets:access", "RESEND_API_KEY", "--project", PROJECT]);
    if (secretRes.ok) {
      ok(secretRes.stdout.trim() ? "RESEND_API_KEY exists in Secret Manager" : "RESEND_API_KEY is EMPTY");
    } else if (/must be on the Blaze/i.test(secretRes.stderr)) {
      warn("Cannot read secrets on the free plan.");
    } else if (/not found|does not exist/i.test(secretRes.stderr)) {
      bad("RESEND_API_KEY has not been set.");
      info("Fix: npm run fb -- functions:secrets:set RESEND_API_KEY");
    } else {
      warn("Could not read the secret.");
    }
  }
  info('The function must also declare it: secrets: ["RESEND_API_KEY"]');

  /* --------------------------------------------------------- 6. region */

  head("6. Region match (a silent killer)");

  // Note: `firestore:databases:list` has no --format json flag, so parse the
  // table. The database name does NOT include the region, so this can only
  // confirm the database exists — the authoritative region check needs the
  // Firestore API or the console.
  const dbOut = fb(["firestore:databases:list", "--project", PROJECT]);

  if (!dbOut) {
    warn("Could not read the Firestore database list.");
  } else {
    const exists = /databases\/\(default\)/.test(dbOut);
    if (exists) {
      ok("Firestore database exists: projects/" + PROJECT + "/databases/(default)");
    } else {
      bad("No Firestore database found in this project.");
    }
    info("");
    info("Confirm its REGION in the Firebase console under");
    info("Firestore Database > Location. These functions run in europe-west1.");
    info("If your database is nam5/us-central, the trigger will never fire.");
    info("Check: npm run fb:db");

    // If functions are deployed, we can at least report where they run.
    if (Array.isArray(deployed) && deployed.length) {
      for (const fn of deployed.filter((f) => /onRequestCreated/.test(f.name || ""))) {
        info(`${fn.name} is deployed in region: ${fn.region}`);
      }
    }
  }

  /* ---------------------------------------------------------- next steps */

  head("Next steps");

  if (plan === "spark") {
    console.log("  The blocking issue is the free plan. In order:\n");
    console.log("    1. Upgrade to Blaze:");
    console.log("       https://console.firebase.google.com/project/crp-cuby-display/usage/details");
    console.log("       (pay-as-you-go with a free quota; set a budget alert)");
    console.log("    2. Store the Resend key:");
    console.log("       npm run fb -- functions:secrets:set RESEND_API_KEY");
    console.log("    3. Verify your sender domain, then set it:");
    console.log('       npm run fb -- functions:config:set CRP_EMAIL_FROM="CRP <hello@yourdomain.com>"');
    console.log("    4. Deploy:");
    console.log("       npm run deploy:functions");
    console.log("    5. Re-run: npm run diagnose:email");
  } else {
    console.log("  Read the trigger's own logs:");
    console.log("    npm run fb:log\n");
    console.log("  No log lines at all  -> the trigger is not firing (region, or not deployed).");
    console.log("  Log lines with ERROR -> the error names the cause (key, sender, Resend).");
  }
})();
