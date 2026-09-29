#!/usr/bin/env node
"use strict";

/**
 * Tests for the CRP Tester acceptance logic.
 *
 * The sequential-number allocator is the part most likely to be wrong in a way
 * that only shows up in production, so it is tested against the real Firestore
 * emulator — including a genuine concurrent-allocation race.
 *
 * Run with:
 *   firebase emulators:exec --only firestore \
 *     "node tests/tester-status.test.js"
 */

process.env.GCLOUD_PROJECT ||= "crp-cuby-display";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";

const assert = require("node:assert");
const path = require("node:path");

const FN = path.join(__dirname, "..", "functions");
const { STATUS, ALL_STATUSES, isValidStatus, activeForStatus } = require(
  path.join(FN, "src", "tester-status.js"),
);

let db;
let allocateTesterNumber;
let peekNextTesterNumber;
let META_COLLECTION;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ------------------------------------------------------------ vocabulary */

test("the four documented statuses are the only valid ones", () => {
  assert.deepStrictEqual(ALL_STATUSES.sort(), [
    "accepted",
    "pending",
    "rejected",
    "revoked",
  ]);
  for (const s of ALL_STATUSES) assert.strictEqual(isValidStatus(s), true, s);
  assert.strictEqual(isValidStatus("approved"), false);
  assert.strictEqual(isValidStatus("ACTIVE"), false);
  assert.strictEqual(isValidStatus(""), false);
  assert.strictEqual(isValidStatus(null), false);
  assert.strictEqual(isValidStatus(undefined), false);
});

test("only accepted maps to active true", () => {
  // This invariant is what keeps `active` and `status` from drifting.
  assert.strictEqual(activeForStatus(STATUS.ACCEPTED), true);
  for (const s of [STATUS.PENDING, STATUS.REJECTED, STATUS.REVOKED]) {
    assert.strictEqual(activeForStatus(s), false, s);
  }
});

/* ------------------------------------------------------- number allocation */

test("numbers start at 1 and increment", async () => {
  await db.collection(META_COLLECTION).doc("testerCounter").delete();
  assert.strictEqual(await allocateTesterNumber(), 1);
  assert.strictEqual(await allocateTesterNumber(), 2);
  assert.strictEqual(await allocateTesterNumber(), 3);
});

test("numbers are unique under genuine concurrency", async () => {
  // The real hazard: two admins accepting applicants simultaneously. A
  // read-then-write implementation would hand out the same number twice.
  await db.collection(META_COLLECTION).doc("testerCounter").delete();

  const allocations = await Promise.all(
    Array.from({ length: 25 }, () => allocateTesterNumber()),
  );

  const unique = new Set(allocations);
  assert.strictEqual(
    unique.size,
    allocations.length,
    `expected 25 unique numbers, got ${allocations.length - unique.size} duplicate(s): ` +
      `${allocations.join(",")}`,
  );

  // Sequential, with no gaps: 1..25.
  const sorted = [...allocations].sort((a, b) => a - b);
  assert.deepStrictEqual(
    sorted,
    Array.from({ length: 25 }, (_, i) => i + 1),
    "numbers must be sequential with no gaps",
  );
});

test("allocation resumes from an existing counter", async () => {
  await db.collection(META_COLLECTION).doc("testerCounter").delete();
  await db.collection(META_COLLECTION).doc("testerCounter").set({ lastNumber: 41 });
  assert.strictEqual(await allocateTesterNumber(), 42);
  assert.strictEqual(await allocateTesterNumber(), 43);
});

test("a corrupt counter is refused rather than silently reused", async () => {
  await db.collection(META_COLLECTION).doc("testerCounter").set({ lastNumber: "five" });
  // Guarding this stops every future number from being derived from junk.
  await assert.rejects(() => allocateTesterNumber(), /corrupt/);
});

test("peek reports the next number without consuming it", async () => {
  await db.collection(META_COLLECTION).doc("testerCounter").delete();
  assert.strictEqual(await peekNextTesterNumber(), 1);
  await allocateTesterNumber();
  assert.strictEqual(await peekNextTesterNumber(), 2);
  // Peeking must not have advanced anything.
  assert.strictEqual(await allocateTesterNumber(), 2);
});

/* ----------------------------------------------------------------- runner */

/**
 * Prove the concurrency test has teeth: a naive read-then-write allocator
 * should FAIL the same assertion. If this test ever passes, the real
 * concurrency test is not actually exercising anything.
 */
test("a naive read-then-write allocator is caught (control)", async () => {
  await db.collection(META_COLLECTION).doc("naiveCounter").delete();

  const naiveAllocate = async () => {
    const ref = db.collection(META_COLLECTION).doc("naiveCounter");
    const snap = await ref.get();
    const next = (snap.exists ? snap.data().lastNumber : 0) + 1;
    await ref.set({ lastNumber: next });
    return next;
  };

  const numbers = await Promise.all(
    Array.from({ length: 25 }, () => naiveAllocate()),
  );

  const unique = new Set(numbers);
  // The naive version returns the same number repeatedly (typically all 1s),
  // which is exactly the production bug this design exists to prevent.
  assert.ok(
    unique.size < numbers.length,
    `expected duplicates in the naive implementation, got ${unique.size}/${numbers.length} unique`,
  );
  assert.ok(
    unique.size <= 3,
    `naive implementation collapsed far harder than expected (${unique.size} unique) — ` +
      `the emulator is interleaving every read before any write`,
  );
  console.log(
    `        (naive produced ${unique.size} unique of ${numbers.length}: ${[...unique].join(",")} — as expected)`,
  );
});

/* ----------------------------------------------------------------- runner */

(async () => {
  const { initializeApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");

  const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  db = getFirestore(app);

  const mod = require(path.join(FN, "src", "tester-number.js"));
  allocateTesterNumber = mod.allocateTesterNumber;
  peekNextTesterNumber = mod.peekNextTesterNumber;
  META_COLLECTION = mod.META_COLLECTION;

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
  console.log(`\n${tests.length - failed}/${tests.length} tester-status tests passed.`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error("harness failed:", error);
  process.exit(1);
});
