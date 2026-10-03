/**
 * Security rules tests for the requests/users split.
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
  // Used to prove a client cannot delete the `tester` map off its own document
  // to erase the record of having been a tester.
  deleteField,
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

/* -------------------------------------- the applicant's account password */

// The signup form takes a password, but it goes STRAIGHT to Firebase Auth from
// the browser and is never part of the request document. These tests pin that:
// the allowlist has no `password` entry, so even a client that tried to attach
// one is refused. Without this, a future refactor could add the field to the
// document and silently start storing every applicant's password in Firestore.
test("anonymous visitor CANNOT write a password onto a request", async () => {
  await assertFails(
    addDoc(collection(anon(), "requests"), validRequest({ password: "correct-horse-battery" })),
  );
});

test("a request document can never contain a password field", async () => {
  // Proved against a real write rather than by reading the rules: submit with a
  // password, then confirm via the Admin SDK that nothing was stored.
  const before = await adminDb.collection("requests").count().get();
  await assertFails(
    addDoc(collection(anon(), "requests"), validRequest({ password: "leaked-password" })),
  );
  const after = await adminDb.collection("requests").count().get();

  if (before.data().count !== after.data().count) {
    throw new Error("a request was written despite the password field being refused");
  }

  // Belt and braces: nothing already stored carries one either.
  const all = await adminDb.collection("requests").get();
  for (const doc of all.docs) {
    if (Object.prototype.hasOwnProperty.call(doc.data(), "password")) {
      throw new Error(`request ${doc.id} has a password field`);
    }
  }
});

test("anonymous visitor CAN create the signup request, with no password field", async () => {
  // The positive case: the exact document js/signup.js writes today. If the
  // allowlist ever drifts away from that payload, this fails — which is the
  // signal that signup and the rules have diverged.
  await assertSucceeds(addDoc(collection(anon(), "requests"), validRequest()));

  const all = await adminDb.collection("requests").get();
  const latest = all.docs.map((d) => d.data()).find((d) => d.email === "alex@example.com");
  if (!latest) throw new Error("the valid request was not stored");
  if ("password" in latest) throw new Error("the stored request carries a password");
});

// Every admin-controlled field the public must never be able to set. These are
// the ones that would actually matter: a forged `testerId` or `reviewedAt`
// fabricates a decision, and a forged `tester` would invent a tester record.
const ADMIN_CONTROLLED = [
  "password",
  "tester",
  "testerId",
  "userId",
  "reviewedAt",
  "reviewedBy",
  "note",
  "active",
  "testerNumber",
  "wallet",
  "testerHistory",
];

for (const field of ADMIN_CONTROLLED) {
  test(`anonymous visitor CANNOT set "${field}" on a request`, async () => {
    await assertFails(
      addDoc(collection(anon(), "requests"), validRequest({ [field]: "forged" })),
    );
  });
}

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

/* --------------------------------------------- users: tester is not writable */

// The tester record is a nested `tester` map on the user document. That makes
// these rules load-bearing in a new way: the document is READABLE and partly
// WRITABLE by its owner for the main app's sake, so the guard cannot be "deny
// all client writes" any more. It has to be "the owner may never touch `tester`".

test("anonymous visitor CANNOT create a user document", async () => {
  await assertFails(
    setDoc(doc(anon(), "users", "forged"), { email: "mallory@example.com" }),
  );
});

test("anonymous visitor CANNOT set themselves active", async () => {
  await assertFails(updateDoc(doc(anon(), "users", "u2"), { "tester.active": true }));
});

test("anonymous visitor CANNOT list users", async () => {
  await assertFails(getDocs(collection(anon(), "users")));
});

test("anonymous visitor CANNOT read a user document", async () => {
  await assertFails(getDoc(doc(anon(), "users", "u2")));
});

test("signed-in non-admin CANNOT create a user document for someone else", async () => {
  // Self-service create IS allowed (the main app needs it at signup), so the
  // guard is on WHOSE document, not on creating at all. A client must never be
  // able to write a document for an account it does not own.
  await assertFails(
    setDoc(doc(asUser("u1", "someone@example.com"), "users", "u3"), {
      email: "other@example.com",
    }),
  );
});

test("a user CAN create their own document at signup", async () => {
  // The positive case, so the rule above is an ownership check and not a
  // blanket denial that would break signup in the main app.
  await assertSucceeds(
    setDoc(doc(asUser("u1", "someone@example.com"), "users", "u1"), {
      email: "someone@example.com",
      displayName: "Someone",
      friends: [],
      friendRequests: [],
    }),
  );
});

test("a user CANNOT create their own document with a tester map", async () => {
  // Self-service create is allowed, but never one that arrives pre-approved.
  await assertFails(
    setDoc(doc(asUser("u1", "someone@example.com"), "users", "u1"), {
      email: "someone@example.com",
      tester: { id: "t_forged", status: "accepted", active: true, testerNumber: 99 },
    }),
  );
});

test("a tester CANNOT write their own tester map", async () => {
  // The single most important rule in the file. `tester.active` drives the
  // Google Wallet pass, so a client-writable flag would let anyone self-issue a
  // live card or claim a number.
  //
  // NOTE the value: the seed has active=true, and `diff()` only reports fields
  // that actually CHANGE. Setting active to true is a no-op, so the rule is not
  // even consulted and the write legitimately succeeds — which proves nothing.
  // The attack is flipping it to false to keep a live card after being removed,
  // so that is what is tested.
  await assertFails(
    updateDoc(doc(asUser("u2", "tester@example.com"), "users", "u2"), {
      "tester.active": false,
    }),
  );
});

test("a tester CANNOT mark themselves accepted", async () => {
  // The reverse direction: the seeded tester is accepted/active, so this is a
  // genuine change and must be caught by the diff allowlist.
  await assertFails(
    updateDoc(doc(asUser("u2", "tester@example.com"), "users", "u2"), {
      "tester.status": "revoked",
    }),
  );
});

test("a tester CANNOT give themselves a tester number", async () => {
  await assertFails(
    updateDoc(doc(asUser("u2", "tester@example.com"), "users", "u2"), {
      "tester.testerNumber": 1,
    }),
  );
});

test("a tester CANNOT rewrite their tester history", async () => {
  await assertFails(
    updateDoc(doc(asUser("u2", "tester@example.com"), "users", "u2"), {
      testerHistory: [{ id: "t_forged", testerNumber: 1 }],
    }),
  );
});

test("a tester CANNOT delete their own tester map to erase their record", async () => {
  // `deleteField()` removes the field from the mask, which the rule must catch:
  // it is still a change to a key the user does not own.
  await assertFails(
    updateDoc(doc(asUser("u2", "tester@example.com"), "users", "u2"), {
      tester: deleteField(),
    }),
  );
});

test("a tester CAN update their own app fields without touching tester", async () => {
  // The self-service path the main app depends on, so the allowlist above is
  // not accidentally a blanket denial.
  await assertSucceeds(
    updateDoc(doc(asUser("u2", "tester@example.com"), "users", "u2"), {
      lastLogin: serverTimestamp(),
    }),
  );
});

/* ---------------------------------------------------------- users: admin reads */

test("admin CAN list and read users", async () => {
  await assertSucceeds(getDocs(collection(asAdmin(), "users")));
  await assertSucceeds(getDoc(doc(asAdmin(), "users", "u2")));
});

test("admin CANNOT write the tester map directly (Worker only)", async () => {
  await assertFails(
    setDoc(doc(asAdmin(), "users", "forged"), {
      email: "staff-made@crp.com",
      tester: { id: "t_forged", active: true },
    }),
  );
});

test("user CAN read their own document but not another's", async () => {
  const db = asUser("u2", "tester@example.com");
  await assertSucceeds(getDoc(doc(db, "users", "u2")));
  await assertFails(getDoc(doc(db, "users", "u3")));
});

test("user CANNOT list the whole roster", async () => {
  await assertFails(getDocs(collection(asUser("u2", "tester@example.com"), "users")));
});

test("user CANNOT delete their own document", async () => {
  await assertFails(deleteDoc(doc(asUser("u2", "tester@example.com"), "users", "u2")));
});

test("user activity log is readable by its owner and staff only", async () => {
  await assertSucceeds(getDoc(doc(asUser("u2", "tester@example.com"), "users", "u2", "activity", "2026-09")));
  await assertFails(getDoc(doc(asUser("u2", "tester@example.com"), "users", "u3", "activity", "2026-09")));
  await assertFails(
    setDoc(doc(asUser("u2", "tester@example.com"), "users", "u2", "activity", "2026-10"), {
      comments: 99,
    }),
  );
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
    setDoc(doc(asUser("u2", "tester@example.com"), "users", "u2", "feedback", "f1"), validFeedback()),
  );
});

test("anonymous visitor CANNOT file feedback", async () => {
  await assertFails(
    setDoc(doc(anon(), "users", "u2", "feedback", "f2"), validFeedback()),
  );
});

test("signed-in non-tester CANNOT file feedback", async () => {
  await assertFails(
    setDoc(
      doc(asUser("u9", "stranger@example.com"), "users", "u2", "feedback", "f3"),
      validFeedback({ email: "stranger@example.com" }),
    ),
  );
});

// The path says t_seed belongs to tester@example.com, so filing there with
// someone else's email must fail even though the caller is signed in.
test("tester CANNOT file feedback under another identity", async () => {
  await assertFails(
    setDoc(
      doc(asUser("u2", "tester@example.com"), "users", "u2", "feedback", "f4"),
      validFeedback({ email: "victim@example.com" }),
    ),
  );
});

test("tester CANNOT file feedback on another tester's record", async () => {
  await assertFails(
    setDoc(
      doc(asUser("u2", "tester@example.com"), "users", "u3", "feedback", "f5"),
      validFeedback({ testerId: "t_other" }),
    ),
  );
});

test("feedback status cannot be self-assigned to shipped", async () => {
  await assertFails(
    setDoc(
      doc(asUser("u2", "tester@example.com"), "users", "u2", "feedback", "f6"),
      validFeedback({ status: "shipped" }),
    ),
  );
});

test("feedback cannot carry extra fields", async () => {
  await assertFails(
    setDoc(
      doc(asUser("u2", "tester@example.com"), "users", "u2", "feedback", "f7"),
      validFeedback({ testerNumber: 1, escalated: true }),
    ),
  );
});

test("tester CANNOT edit or delete feedback after filing it", async () => {
  const db = asUser("u2", "tester@example.com");
  await assertFails(updateDoc(doc(db, "users", "u2", "feedback", "f1"), { title: "changed" }));
  await assertFails(deleteDoc(doc(db, "users", "u2", "feedback", "f1")));
});

test("tester CAN read their own feedback but not another's", async () => {
  const db = asUser("u2", "tester@example.com");
  await assertSucceeds(getDocs(collection(db, "users", "u2", "feedback")));
  await assertFails(getDocs(collection(db, "users", "u3", "feedback")));
});

test("admin CAN read all feedback", async () => {
  await assertSucceeds(getDocs(collection(asAdmin(), "users", "u2", "feedback")));
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

  // Seeded via the Admin SDK, bypassing rules — exactly how the Worker writes.
  // The tester is a nested map on the user document, and the surrounding
  // user fields are there to prove a tester write cannot disturb them.
  await adminDb.doc("users/u2").set({
    email: "tester@example.com",
    displayName: "Seed Tester",
    friends: ["u3"],
    lastLogin: new Date("2026-09-30T14:57:01.000Z"),
    tester: {
      id: "t_seed",
      userId: "u2",
      name: "Seed Tester",
      email: "tester@example.com",
      status: "accepted",
      active: true,
      testerNumber: 4,
    },
  });
  await adminDb.doc("users/u3").set({
    email: "other@example.com",
    displayName: "Other Tester",
    tester: {
      id: "t_other",
      userId: "u3",
      name: "Other Tester",
      email: "other@example.com",
      status: "revoked",
      active: false,
      testerNumber: 5,
    },
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
