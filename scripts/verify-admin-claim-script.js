#!/usr/bin/env node
"use strict";

/**
 * Offline check for scripts/set-admin-claim.js.
 *
 * Firebase Auth cannot be reached in CI, so this stubs the Admin SDK and
 * asserts the parts that are actually our responsibility: that the key is read
 * from disk and handed to cert(), that the project is the one the key belongs
 * to, and that `--revoke` toggles while preserving other claims.
 *
 * No network, and no real account is touched.
 *
 *   node scripts/verify-admin-claim-script.js
 */

const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const SCRIPT = path.join(__dirname, "set-admin-claim.js");
const KEY_PATH = path.join(os.homedir(), "crp-worker-key.json");

const calls = [];

/**
 * A fixture key for the CRP project.
 *
 * The script only needs a well-formed key on disk to exercise its logic; these
 * tests never contact Google. Using a fixture means the checks run regardless
 * of which key happens to be on the machine.
 */
const FIXTURE = path.join(os.tmpdir(), "crp-cuby-display-key-fixture.json");
fs.writeFileSync(
  FIXTURE,
  JSON.stringify({
    type: "service_account",
    project_id: "crp-cuby-display",
    client_email: "crp-tester-worker@crp-cuby-display.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nFIXTURE\n-----END PRIVATE KEY-----\n",
  }),
);

const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "firebase-admin/app") {
    return {
      initializeApp: (opts) => calls.push({ type: "init", ...opts }),
      getApps: () => (calls.some((c) => c.type === "init") ? [{}] : []),
      cert: (sa) => {
        calls.push({ type: "cert", sa });
        return { __cert: true };
      },
    };
  }
  if (request === "firebase-admin/auth") {
    return {
      getAuth: () => ({
        getUserByEmail: async (email) => ({
          uid: "uid-123",
          email,
          // Pre-existing claims that must survive the update.
          customClaims: { role: "staff", plan: "pro" },
        }),
        getUser: async (uid) => ({ uid, email: null, customClaims: {} }),
        setCustomUserClaims: async (uid, claims) =>
          calls.push({ type: "set", uid, claims }),
      }),
    };
  }
  return load(request, parent, isMain);
};

/** Run the script and collect what it did. */
async function run(args) {
  calls.length = 0;
  Module._cache = {};
  process.argv = ["node", "set-admin-claim.js", ...args];

  // The script calls process.exit() on failure, which would end the entire test
  // run. Neutralise it for the duration so a rejection can be asserted on.
  const realExit = process.exit;
  process.exit = (code) => calls.push({ type: "exit", code });

  const realError = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(" "));

  try {
    require(SCRIPT);
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    process.exit = realExit;
    console.error = realError;
  }

  return { calls: [...calls], errors, exited: calls.some((c) => c.type === "exit") };
}

(async () => {
  const tests = [];
  const test = (name, fn) => tests.push([name, fn]);

  test("reads the key from disk and passes it to cert()", async () => {
    const { calls: c } = await run(["atronamir5@gmail.com", "--key", FIXTURE]);
    const cert = c.find((x) => x.type === "cert");
    assert.ok(cert, "cert() was never called");
    assert.ok(cert.sa.private_key, "private_key must reach cert()");
    assert.strictEqual(cert.sa.project_id, "crp-cuby-display");
  });

  test("initialises for the CRP project, not the Wallet project", async () => {
    const { calls: c } = await run(["atronamir5@gmail.com", "--key", FIXTURE]);
    const init = c.find((x) => x.type === "init");
    assert.ok(init, "initializeApp was never called");
    assert.strictEqual(init.projectId, "crp-cuby-display");
  });

  test("refuses a key belonging to the Wallet project", async () => {
    // crp-tester-card has no Firebase Auth, so this must fail fast rather than
    // surface as an opaque Google API error.
    const walletKey = "/tmp/wallet-key-fixture.json";
    fs.writeFileSync(
      walletKey,
      JSON.stringify({
        project_id: "crp-tester-card",
        client_email: "crp-tester-worker@crp-tester-card.iam.gserviceaccount.com",
        private_key: "x",
      }),
    );
    try {
      const { calls: c, errors, exited } = await run([
        "atronamir5@gmail.com",
        "--key",
        walletKey,
      ]);
      assert.strictEqual(
        c.some((x) => x.type === "init"),
        false,
        "must not initialise against the Wallet project",
      );
      assert.ok(exited, "should exit non-zero");
      assert.match(errors.join("\n"), /Google Wallet project/);
    } finally {
      fs.unlinkSync(walletKey);
    }
  });

  test("grants admin: true and preserves other claims", async () => {
    const { calls: c } = await run(["atronamir5@gmail.com", "--key", FIXTURE]);
    const set = c.find((x) => x.type === "set");
    assert.ok(set, "setCustomUserClaims was never called");
    assert.strictEqual(set.claims.admin, true);
    // Claim preservation: existing claims must not be wiped.
    assert.strictEqual(set.claims.role, "staff");
    assert.strictEqual(set.claims.plan, "pro");
  });

  test("--revoke sets admin: false and still preserves other claims", async () => {
    const { calls: c } = await run([
      "atronamir5@gmail.com",
      "--revoke",
      "--key",
      FIXTURE,
    ]);
    const set = c.find((x) => x.type === "set");
    assert.strictEqual(set.claims.admin, false);
    assert.strictEqual(set.claims.role, "staff");
  });

  test("accepts a bare uid as well as an email", async () => {
    const { calls: c } = await run(["uid-123", "--key", FIXTURE]);
    const set = c.find((x) => x.type === "set");
    assert.ok(set, "should resolve a uid");
    assert.strictEqual(set.uid, "uid-123");
  });

  test("does not mistake --key for the user argument", async () => {
    const { calls: c } = await run([
      "atronamir5@gmail.com",
      "--key",
      FIXTURE,
    ]);
    const set = c.find((x) => x.type === "set");
    assert.ok(set, "no claim written");
    assert.strictEqual(set.claims.admin, true);
  });

  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL  ${name}`);
      console.log(`        ${String(error.message).split("\n")[0]}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} admin-claim script checks passed.`);
  process.exit(failed ? 1 : 0);
})();
