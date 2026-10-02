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
  runTransaction,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} = require("firebase/firestore");

const PROJECT = process.env.GCLOUD_PROJECT || "crp-cuby-display";
const RULES = fs.readFileSync("firestore.rules", "utf8");

let testEnv;
let adminDb;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** A request body that satisfies every rule. */
function validRequest(overrides = {}) {
  return {
    name: "Alex Morgan",
    email: "alex@example.com",
    consent: true,
    experienceCategory: "developer",
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

test("anonymous visitor CANNOT omit or forge the experience category", async () => {
  const { experienceCategory: _category, ...withoutCategory } = validRequest();
  await assertFails(addDoc(collection(anon(), "requests"), withoutCategory));
  await assertFails(
    addDoc(collection(anon(), "requests"), validRequest({ experienceCategory: "expert" })),
  );
});

test("all supported experience categories are accepted", async () => {
  for (const experienceCategory of ["developer", "everyday_user", "new_to_technology"]) {
    await assertSucceeds(
      addDoc(collection(anon(), "requests"), validRequest({ experienceCategory })),
    );
  }
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

test("concurrent submissions atomically keep one request and its marker", async () => {
  const db = anon();
  const markerRef = doc(db, "requestEmails", `race-${Date.now()}`);
  const submit = () => runTransaction(db, async (transaction) => {
    const marker = await transaction.get(markerRef);
    if (marker.exists()) throw new Error("duplicate application");

    const requestRef = doc(collection(db, "requests"));
    transaction.set(requestRef, validRequest());
    transaction.set(markerRef, {
      requestId: requestRef.id,
      createdAt: serverTimestamp(),
    });
    return requestRef.id;
  });

  const results = await Promise.allSettled([submit(), submit()]);
  const accepted = results.filter((result) => result.status === "fulfilled");
  if (accepted.length !== 1) {
    throw new Error(`Expected one concurrent submission, received ${accepted.length}.`);
  }

  const marker = await getDoc(markerRef);
  if (!marker.exists() || marker.data().requestId !== accepted[0].value) {
    throw new Error("The email marker does not point to the accepted request.");
  }
  const request = await adminDb.doc(`requests/${accepted[0].value}`).get();
  if (!request.exists || request.data().status !== "pending") {
    throw new Error("The accepted request was not stored as pending.");
  }
});

test("a rejected applicant can submit a new request without changing the old one", async () => {
  const db = anon();
  const email = `reapply-${Date.now()}@example.com`;
  const emailKey = require("node:crypto").createHash("sha256").update(email).digest("hex");
  const markerRef = doc(db, "requestEmails", emailKey);
  const submit = () => runTransaction(db, async (transaction) => {
    const marker = await transaction.get(markerRef);
    if (marker.exists()) throw new Error("duplicate application");
    const requestRef = doc(collection(db, "requests"));
    transaction.set(requestRef, validRequest({ email }));
    transaction.set(markerRef, { requestId: requestRef.id, createdAt: serverTimestamp() });
    return requestRef.id;
  });

  const rejectedRequestId = await submit();
  await adminDb.doc(`requests/${rejectedRequestId}`).update({
    status: "rejected",
    note: "Try again later",
  });
  await adminDb.doc(`requestEmails/${emailKey}`).delete();

  const newRequestId = await submit();
  const oldRequest = await adminDb.doc(`requests/${rejectedRequestId}`).get();
  const newRequest = await adminDb.doc(`requests/${newRequestId}`).get();
  const marker = await adminDb.doc(`requestEmails/${emailKey}`).get();

  if (newRequestId === rejectedRequestId || oldRequest.data().status !== "rejected") {
    throw new Error("The reapplication replaced or changed the rejected request.");
  }
  if (oldRequest.data().note !== "Try again later" || newRequest.data().status !== "pending") {
    throw new Error("The request history or new request status was not preserved.");
  }
  if (marker.data().requestId !== newRequestId) {
    throw new Error("The marker does not point to the new application.");
  }
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

/** A feedback body that satisfies every rule. */
function validFeedback(overrides = {}) {
  return {
    testerId: "t_seed",
    email: "tester@example.com",
    title: "Add a dark mode",
    body: "The display is bright at night. A dark theme would help.",
    area: "app",
    status: "submitted",
    period: "2026-02",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

/* -------------------------------------------------- tester feedback: ownership */

test("tester CAN file feedback on their own record", async () => {
  await assertSucceeds(
    setDoc(doc(asUser("u2", "tester@example.com"), "testers", "t_seed", "feedback", "f1"), validFeedback()),
  );
});

test("anonymous visitor CANNOT file feedback", async () => {
  await assertFails(
    setDoc(doc(anon(), "testers", "t_seed", "feedback", "f2"), validFeedback()),
  );
});

test("signed-in non-tester CANNOT file feedback", async () => {
  await assertFails(
    setDoc(
      doc(asUser("u9", "stranger@example.com"), "testers", "t_seed", "feedback", "f3"),
      validFeedback({ email: "stranger@example.com" }),
    ),
  );
});

// The path says t_seed belongs to tester@example.com, so filing there with
// someone else's email must fail even though the caller is signed in.
test("tester CANNOT file feedback under another identity", async () => {
  await assertFails(
    setDoc(
      doc(asUser("u2", "tester@example.com"), "testers", "t_seed", "feedback", "f4"),
      validFeedback({ email: "victim@example.com" }),
    ),
  );
});

test("tester CANNOT file feedback on another tester's record", async () => {
  await assertFails(
    setDoc(
      doc(asUser("u2", "tester@example.com"), "testers", "t_other", "feedback", "f5"),
      validFeedback({ testerId: "t_other" }),
    ),
  );
});

test("feedback status cannot be self-assigned to shipped", async () => {
  await assertFails(
    setDoc(
      doc(asUser("u2", "tester@example.com"), "testers", "t_seed", "feedback", "f6"),
      validFeedback({ status: "shipped" }),
    ),
  );
});

test("feedback cannot carry extra fields", async () => {
  await assertFails(
    setDoc(
      doc(asUser("u2", "tester@example.com"), "testers", "t_seed", "feedback", "f7"),
      validFeedback({ testerNumber: 1, escalated: true }),
    ),
  );
});

test("tester CANNOT edit or delete feedback after filing it", async () => {
  const db = asUser("u2", "tester@example.com");
  await assertFails(updateDoc(doc(db, "testers", "t_seed", "feedback", "f1"), { title: "changed" }));
  await assertFails(deleteDoc(doc(db, "testers", "t_seed", "feedback", "f1")));
});

test("tester CAN read their own feedback but not another's", async () => {
  const db = asUser("u2", "tester@example.com");
  await assertSucceeds(getDocs(collection(db, "testers", "t_seed", "feedback")));
  await assertFails(getDocs(collection(db, "testers", "t_other", "feedback")));
});

test("admin CAN read all feedback", async () => {
  await assertSucceeds(getDocs(collection(asAdmin(), "testers", "t_seed", "feedback")));
});

/* ------------------------------------------------------------- tester index */

test("anonymous can read a tester index pointer but not enumerate it", async () => {
  await assertSucceeds(getDoc(doc(anon(), "testerIndex", "hash-abc")));
  await assertFails(getDocs(collection(anon(), "testerIndex")));
});

test("nobody can write the tester index from a client", async () => {
  await assertFails(setDoc(doc(anon(), "testerIndex", "forged"), { testerId: "t_seed" }));
  await assertFails(setDoc(doc(asAdmin(), "testerIndex", "forged"), { testerId: "t_seed" }));
});

/* --------------------------------------------------------- CRP Focus accounts */

test("a user CAN create their own account document", async () => {
  await assertSucceeds(
    setDoc(doc(asUser("u7", "owner@example.com"), "users", "u7"), {
      displayName: "owner",
      email: "owner@example.com",
      createdAt: serverTimestamp(),
      uid: "u7",
    }),
  );
});

test("a user CANNOT create an account document for someone else", async () => {
  await assertFails(
    setDoc(doc(asUser("u7", "owner@example.com"), "users", "victim"), {
      displayName: "victim",
      email: "victim@example.com",
      createdAt: serverTimestamp(),
      uid: "victim",
    }),
  );
});

test("a user CAN read their own account but not another's", async () => {
  await assertSucceeds(getDoc(doc(asUser("u7", "owner@example.com"), "users", "u7")));
  await assertFails(getDoc(doc(asUser("u7", "owner@example.com"), "users", "victim")));
});

// The update rule lets the owner change displayName but pins the identity fields,
// so a live session cannot repoint the record at another address.
test("a user CANNOT change the email on their account", async () => {
  await assertFails(
    updateDoc(doc(asUser("u7", "owner@example.com"), "users", "u7"), {
      email: "attacker@example.com",
    }),
  );
});

test("a user CAN rename their own account", async () => {
  await assertSucceeds(
    updateDoc(doc(asUser("u7", "owner@example.com"), "users", "u7"), {
      displayName: "renamed",
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
  adminDb = getFirestore(adminApp);

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
