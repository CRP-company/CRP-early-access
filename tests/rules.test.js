/**
 * Security rules tests for the requests/testers split.
 *
 * These run against the real Firestore emulator, so they verify deployed
 * behaviour rather than our reading of the rules file.
 *
 *   npm i -D @firebase/rules-unit-testing firebase
 *   firebase emulators:exec --only firestore "node tests/rules.test.js"
 */

const fs = require("node:fs");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const {
  doc,
  collection,
  addDoc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} = require("firebase/firestore");

const PROJECT = process.env.GCLOUD_PROJECT || "crp-cuby-display";
const RULES = fs.readFileSync("firestore.rules", "utf8");

let testEnv;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** A request body that satisfies every rule. */
function validRequest(overrides = {}) {
  return {
    name: "Alex Morgan",
    email: "alex@example.com",
    consent: true,
    status: "pending",
    source: "early-access-site",
    userAgent: "test-agent",
    website: "",
    createdAt: serverTimestamp(),
    ...overrides,
  };
}

const anon = () => testEnv.unauthenticatedContext().firestore();
const asAdmin = () => testEnv.authenticatedContext("admin-1", { admin: true, email: "staff@crp.com" }).firestore();
const asUser = (uid, email) => testEnv.authenticatedContext(uid, { email }).firestore();

/* -------------------------------------------------- requests: public create */

test("anonymous visitor CAN create a valid request", async () => {
  await assertSucceeds(addDoc(collection(anon(), "requests"), validRequest()));
});

test("anonymous visitor CANNOT pre-approve their own request", async () => {
  await assertFails(addDoc(collection(anon(), "requests"), validRequest({ status: "approved" })));
});

test("anonymous visitor CANNOT forge consent", async () => {
  await assertFails(addDoc(collection(anon(), "requests"), validRequest({ consent: false })));
});

test("anonymous visitor CANNOT fill the honeypot", async () => {
  await assertFails(
    addDoc(collection(anon(), "requests"), validRequest({ website: "http://spam.example" })),
  );
});

test("anonymous visitor CANNOT smuggle extra fields", async () => {
  await assertFails(
    addDoc(collection(anon(), "requests"), validRequest({ active: true, reviewedBy: "x" })),
  );
});

test("anonymous visitor CANNOT spoof the timestamp", async () => {
  await assertFails(
    addDoc(collection(anon(), "requests"), validRequest({ createdAt: new Date("2020-01-01") })),
  );
});

test("anonymous visitor CANNOT submit a malformed email", async () => {
  await assertFails(addDoc(collection(anon(), "requests"), validRequest({ email: "not-an-email" })));
});

/* ------------------------------------------ requests: everything else denied */

test("anonymous visitor CANNOT list requests", async () => {
  await assertFails(getDocs(collection(anon(), "requests")));
});

test("anonymous visitor CANNOT read a request", async () => {
  await assertFails(getDoc(doc(anon(), "requests", "any-id")));
});

test("anonymous visitor CANNOT update a request", async () => {
  await assertFails(updateDoc(doc(anon(), "requests", "any-id"), { status: "approved" }));
});

test("anonymous visitor CANNOT delete a request", async () => {
  await assertFails(deleteDoc(doc(anon(), "requests", "any-id")));
});

/* ------------------------------------------------- testers: no client writes */

test("anonymous visitor CANNOT create a tester", async () => {
  await assertFails(
    setDoc(doc(anon(), "testers", "forged"), { email: "mallory@example.com", active: true }),
  );
});

test("anonymous visitor CANNOT set themselves active", async () => {
  await assertFails(updateDoc(doc(anon(), "testers", "t_seed"), { active: true }));
});

test("anonymous visitor CANNOT list testers", async () => {
  await assertFails(getDocs(collection(anon(), "testers")));
});

test("signed-in non-admin CANNOT create a tester", async () => {
  await assertFails(
    setDoc(doc(asUser("u1", "someone@example.com"), "testers", "forged"), {
      email: "someone@example.com",
      active: true,
    }),
  );
});

/* ------------------------------------------------------ testers: admin reads */

test("admin CAN list and read testers", async () => {
  await assertSucceeds(getDocs(collection(asAdmin(), "testers")));
  await assertSucceeds(getDoc(doc(asAdmin(), "testers", "t_seed")));
});

test("admin CANNOT write testers directly (functions only)", async () => {
  await assertFails(
    setDoc(doc(asAdmin(), "testers", "forged"), { email: "staff-made@crp.com", active: true }),
  );
});

test("tester CAN read their own record but not another's", async () => {
  const db = asUser("u2", "tester@example.com");
  await assertSucceeds(getDoc(doc(db, "testers", "t_seed")));
  await assertFails(getDoc(doc(db, "testers", "t_other")));
});

test("tester CANNOT list the whole roster", async () => {
  await assertFails(getDocs(collection(asUser("u2", "tester@example.com"), "testers")));
});

/* --------------------------------------------------------- audit is locked */

test("nobody can write the audit trail from a client", async () => {
  await assertFails(setDoc(doc(anon(), "audit", "x"), { action: "forged" }));
  await assertFails(setDoc(doc(asAdmin(), "audit", "x"), { action: "forged" }));
});

/* --------------------------------------------------------------- email index */

test("anonymous can create the email marker but not enumerate the collection", async () => {
  await assertSucceeds(
    setDoc(doc(anon(), "requestEmails", "hash-abc"), {
      requestId: "req-1",
      createdAt: serverTimestamp(),
    }),
  );
  await assertFails(getDocs(collection(anon(), "requestEmails")));
});

test("email marker cannot carry extra fields", async () => {
  await assertFails(
    setDoc(doc(anon(), "requestEmails", "hash-xyz"), {
      requestId: "req-2",
      email: "leak@example.com",
      createdAt: serverTimestamp(),
    }),
  );
});

/* ------------------------------------------------- default deny for strays */

test("unknown collections are denied by default", async () => {
  await assertFails(setDoc(doc(asAdmin(), "secrets", "x"), { a: 1 }));
});

/* ------------------------------------------------------------------- runner */

(async () => {
  testEnv = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: RULES } });

  // Seed with the Admin SDK against the emulator. Admin credentials bypass
  // rules, which is exactly how Cloud Functions write — and it doubles as
  // proof that the "functions-only" rule really does lock out normal clients,
  // since these same writes are rejected for every client context below.
  const { initializeApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");

  const adminApp = initializeApp({ projectId: PROJECT });
  const adminDb = getFirestore(adminApp);

  await adminDb.doc("testers/t_seed").set({
    email: "tester@example.com",
    name: "Seed Tester",
    active: true,
  });
  await adminDb.doc("testers/t_other").set({
    email: "other@example.com",
    name: "Other Tester",
    active: false,
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

  await testEnv.cleanup();
  console.log(`\n${tests.length - failed}/${tests.length} rules tests passed.`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error("Test harness failed:", error);
  process.exit(1);
});

