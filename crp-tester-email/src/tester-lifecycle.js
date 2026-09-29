/**
 * Tester lifecycle vocabulary, ported from functions/src/tester-status.js.
 *
 * Duplicated deliberately: the Worker is ESM and standalone, the Functions are
 * CommonJS, and neither can import the other. The two files must stay in step;
 * tests/tester-status.test.js and the Worker suite assert the same invariants.
 */

export const STATUS = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  REVOKED: "revoked",
};

export const ALL_STATUSES = Object.values(STATUS);

export function isValidStatus(value) {
  return ALL_STATUSES.includes(value);
}

/**
 * The `active` boolean that must accompany a status.
 *
 * Keeping this in one function is what stops a caller writing
 * `status: "accepted"` with `active: false`, which would leave a tester who
 * looks present on the roster but whose Wallet card is revoked.
 */
export function activeForStatus(status) {
  return status === STATUS.ACCEPTED;
}

/** Counter document holding the last tester number handed out. */
export const COUNTER_DOC = "testerCounter";
export const META_COLLECTION = "meta";

/**
 * How many times to retry a contended allocation before giving up.
 *
 * Sized for a burst, not a steady state: acceptance is a rare, deliberate
 * staff action, so the worst realistic case is a handful of admins accepting
 * together. With jittered backoff this leaves ample headroom, and a caller who
 * still exhausts it gets a clear error rather than a duplicate number.
 */
const MAX_ATTEMPTS = 12;

/**
 * Reserve the next sequential tester number.
 *
 * Concurrency: the counter is created with `currentDocument.exists=false`, so
 * exactly one writer can create it. A second concurrent writer gets 409 and
 * retries the whole read-and-write. On the update path the same precondition
 * prevents two writers from both writing last+1.
 *
 * The alternative — read the number, add one, write it — is not safe. It was
 * tested against this emulator: 25 concurrent calls all returned `1`.
 *
 * @param {ReturnType<import("./firestore-rest.js").createFirestore>} store
 * @returns {Promise<number>} A unique positive integer.
 */
export async function allocateTesterNumber(store) {
  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const counter = await store.getDocument(META_COLLECTION, COUNTER_DOC);

    if (!counter) {
      // First tester ever: create the counter, claiming number 1.
      try {
        await store.createDocument(META_COLLECTION, COUNTER_DOC, {
          lastNumber: 1,
          updatedAt: new Date(),
        });
        return 1;
      } catch (error) {
        // Lost the create race — another writer made the counter. Retry with
        // jitter so contenders do not retry in lockstep.
        if (error.status === 409) {
          lastError = error;
          const backoff = Math.min(10 * 2 ** attempt, 200) * (0.5 + Math.random());
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw error;
      }
    }

    const current = counter.lastNumber;
    if (typeof current !== "number" || !Number.isInteger(current) || current < 0) {
      throw new Error(
        `testerNumber counter is corrupt (lastNumber=${current}). ` +
          `Fix or delete ${META_COLLECTION}/${COUNTER_DOC} before accepting more testers.`,
      );
    }

    try {
      // This MUST be a versioned precondition, not `exists=true`.
      //
      // Verified against the Firestore emulator: two writers holding the same
      // `currentDocument.exists=true` both succeed, and the second silently
      // overwrites the first (value 2 -> 3). Only the updateTime variant
      // detects the collision. Do not weaken this.
      await store.updateDocument(
        META_COLLECTION,
        COUNTER_DOC,
        { lastNumber: current + 1, updatedAt: new Date() },
        { updateTime: counter.updateTime },
      );
      return current + 1;
    } catch (error) {
      if (error.status === 409 || error.status === 412) {
        lastError = error;
        // Back off with jitter before retrying. Without jitter every contender
        // retries in lockstep and collides again — with 25 simultaneous
        // acceptances, a few immediate retries are not enough.
        const backoff = Math.min(10 * 2 ** attempt, 200) * (0.5 + Math.random());
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `Could not allocate a tester number after ${MAX_ATTEMPTS} attempts. ` +
      "Another admin may be accepting at the same time; try again.",
  );
}
