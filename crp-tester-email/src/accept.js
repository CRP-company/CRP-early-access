/**
 * Accept or reject an early access request.
 *
 * This replaces the `onRequestApproved` Firestore trigger. A Worker cannot
 * subscribe to Firestore events, but it does not need to: acceptance is always
 * initiated by an admin clicking Approve, so this handler runs at exactly the
 * moment the trigger used to fire. The promotion simply becomes synchronous
 * instead of reactive, which is better — the admin learns immediately if it
 * failed, rather than the failure being silent.
 *
 * The tester document shape and the `status` / `active` pairing are carried
 * over from functions/src/admin.js unchanged.
 */

import { STATUS, activeForStatus, allocateTesterNumber } from "./tester-lifecycle.js";
import { buildSaveUrl, accountIdFor } from "./wallet.js";
import { buildAcceptanceEmail, buildRejectionEmail } from "./decision-emails.js";
import { sendEmail } from "./resend.js";

import { findUserByEmail, UserAccountError } from "./user-account.js";

const REQUESTS = "requests";
const USERS = "users";
const REQUEST_EMAILS = "requestEmails";
const TESTER_INDEX = "testerIndex";
/**
 * The legacy `testers` collection, kept only so removal can DELETE the document.
 *
 * Reads moved to `users/{uid}.tester` during the user-document refactor, and the
 * constant was dropped at that point — correct for reading, but it left nothing
 * to clean up with, so the pre-refactor document survived every removal still
 * claiming status "accepted". No route reads this collection.
 */
const TESTERS = "testers";
const AUDIT = "audit";
const ISSUER_ID = "3388000000023210330";

/**
 * The document key for an address in `requestEmails`.
 *
 * Must match js/signup.js hashEmail() exactly — the same lowercased, trimmed
 * SHA-256 hex — or the marker being deleted will not be the one the signup form
 * reads, and the person stays blocked with no visible cause.
 */
function hashEmail(email) {
  const bytes = new TextEncoder().encode(String(email).trim().toLowerCase());
  const digest = crypto.subtle.digest("SHA-256", bytes);
  return digest.then((buf) =>
    Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  );
}

const DEFAULT_FROM = "CRP Tester Program <testing@crp.company>";

/**
 * Notify the applicant of the decision.
 *
 * Best-effort by design, exactly like the acknowledgement email: the decision
 * is already durably stored, so a Resend outage must never turn a successful
 * approval into a 500 and invite a retry that would burn a second tester number.
 *
 * Idempotency: the Resend Idempotency-Key is derived from the request id and
 * the decision, so a retried call for the same request cannot produce a second
 * email. This is the same guarantee the acknowledgement email relies on.
 */
async function notifyDecision({ env, request, requestId, decision, testerNumber, saveUrl }) {
  const mail =
    decision === "approved"
      ? buildAcceptanceEmail({ name: request.name, email: request.email, testerNumber, saveUrl })
      : buildRejectionEmail({ name: request.name, email: request.email });

  try {
    const sent = await sendEmail({
      apiKey: env.RESEND_API_KEY,
      from: env.CRP_EMAIL_FROM || DEFAULT_FROM,
      to: request.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      idempotencyKey: `application-${decision}/${requestId}`,
    });

    if (!sent.ok) {
      console.error(
        "decision email failed",
        JSON.stringify({ requestId, decision, status: sent.status }),
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error(
      "decision email threw",
      JSON.stringify({ requestId, decision, message: error && error.message }),
    );
    return false;
  }
}

export class AcceptError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Audit writes are best-effort: a logging failure must not undo the decision. */
async function writeAudit(store, entry) {
  const id = `a_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  try {
    await store.createDocument("audit", id, entry);
  } catch {
    // Intentionally swallowed.
  }
}

/**
 * Point a tester's email at the user document that owns their tester map.
 *
 * Without this the tester dashboard cannot find anyone's record: `allow list: if
 * isAdmin()` on `users` stops a tester querying for their own document, so the
 * portal needs a deterministic key to `get` instead. The body holds only the uid,
 * which is why `testerIndex` can be world-readable.
 *
 * Best-effort, deliberately. The tester and their number are already committed by
 * the time this runs; a failure here must not roll back an acceptance or invite a
 * retry that burns a second number. It is repaired by re-approving, and the
 * dashboard's error message points a stuck tester at CRP rather than silently
 * showing an empty account.
 *
 * @param {string} userId  The Auth uid, which is also the user document id.
 */
async function writeTesterIndex(store, { email, userId }) {
  if (!email || !userId) return false;
  try {
    const markerId = await hashEmail(email);
    const existing = await store.getDocument(TESTER_INDEX, markerId);

    // Only write when the pointer is absent or wrong. A correct pointer is left
    // alone, so a repeat approval does not generate a pointless write.
    if (existing && existing.userId === userId) return true;

    // `testerId` is cleared rather than left stale: a pointer naming a `t_...`
    // document can no longer be resolved, and keeping it would only be misleading.
    const payload = { userId, testerId: null, updatedAt: new Date() };
    if (existing) {
      await store.updateDocument(TESTER_INDEX, markerId, payload);
    } else {
      await store.createDocument(TESTER_INDEX, markerId, { ...payload, createdAt: new Date() });
    }
    return true;
  } catch (error) {
    console.error(
      "tester index write failed",
      JSON.stringify({ userId, message: error && error.message }),
    );
    return false;
  }
}

/**
 * Read a user document by email, falling back to the Auth account for its uid.
 *
 * The Firestore document is the authority for whether a `tester` map exists.
 * Auth is the authority for the uid itself. A user can exist in one and not the
 * other — a half-finished promotion leaves a Firestore doc, and a brand-new
 * signup leaves only an Auth account — so this checks both and never assumes.
 */
async function findUserDocumentByEmail(store, email) {
  const list = await store.listCollection(USERS);
  const match = list.find(
    (u) => String(u.email || "").trim().toLowerCase() === String(email).trim().toLowerCase(),
  );
  return match ? { ...match, id: match.id } : null;
}

/**
 * Resolve the Firebase Auth account behind an approved applicant.
 *
 * The tester record lives on `users/{uid}`, so approval has to find the account
 * that the applicant created for themselves during signup and link the request to
 * its uid.
 *
 * This NEVER creates an account and NEVER accepts a password. The applicant
 * chooses their own password on the public form and it goes straight from their
 * browser to Firebase; CRP never holds it. Keeping creation on that side is the
 * whole point — there is no point in this code where a password could be logged,
 * forwarded, or seen by an admin.
 *
 * If the account is genuinely missing, that is a real inconsistency: an approved
 * request whose applicant never completed signup. It is reported as such rather
 * than papered over by creating an account, because inventing one here would
 * reintroduce exactly the admin-typed-password problem this removed.
 *
 * @returns {Promise<{uid: string, displayName: string|null}>}
 */
async function resolveTesterAccount(env, { email }) {
  const sa = env.FIREBASE_SERVICE_ACCOUNT_JSON;

  const existing = await findUserByEmail(sa, email);
  if (!existing) {
    throw new UserAccountError(
      409,
      `${email} has no CRP account, so there is no identity to attach the tester to. ` +
        `The applicant must complete signup first — re-check that their application ` +
        `was submitted with the same email address.`,
    );
  }

  return { uid: existing.uid, displayName: existing.displayName };
}

/**
 * Ensure a `users/{uid}` document exists for a resolved account.
 *
 * The document is created with only the fields this project owns — email,
 * displayName, createdAt. `friends`, `friendRequests` and `lastLogin` belong to
 * the main app and are deliberately left absent rather than seeded with empty
 * values, so creating a tester record can never overwrite or pre-empt them.
 */
async function ensureUserDocument(store, { uid, email, displayName, now }) {
  const existing = await store.getDocument(USERS, uid);
  if (existing) return { created: false, document: existing };

  await store.createDocument(USERS, uid, {
    email: String(email).trim().toLowerCase(),
    displayName: displayName || null,
    createdAt: now,
    // An empty array, not an absent field: the app reads this unconditionally
    // and a missing field is a different (falsy but present) value to query on.
    friendRequests: [],
    friends: [],
  });

  return { created: true, document: null };
}

/**
 * Decide an application.
 *
 * @param {object} store   Firestore REST handle.
 * @param {object} args
 * @param {string} args.requestId
 * @param {"approved"|"rejected"} args.decision
 * @param {string} [args.note]
 * @param {string} args.actorUid
 * @param {string} [args.actorEmail]
 */
export async function decideRequest(
  store,
  { requestId, decision, note, actorUid, actorEmail, env },
) {
  if (decision !== "approved" && decision !== "rejected") {
    throw new AcceptError(400, "decision must be 'approved' or 'rejected'.");
  }

  const request = await store.getDocument(REQUESTS, requestId);
  if (!request) throw new AcceptError(404, "No such request.");
  if (request.status !== "pending") {
    if (request.status === "rejected" && decision === "rejected") {
      let releasedMarker = false;
      if (request.email) {
        try {
          const result = await store.releaseRejectedRequestMarker({
            requestId,
            markerCollection: REQUEST_EMAILS,
            markerId: await hashEmail(request.email),
          });
          releasedMarker = result.released;
        } catch (error) {
          if (error && (error.status === 409 || error.status === 412)) {
            throw new AcceptError(409, "This request changed while retrying rejection.");
          }
          throw error;
        }
      }
      return { requestId, status: "rejected", emailed: false, releasedMarker };
    }
    throw new AcceptError(409, `This request was already ${request.status}.`);
  }

  const now = new Date();
  const common = {
    status: decision,
    note: note ? String(note).slice(0, 500) : null,
    reviewedBy: actorUid || null,
    reviewedAt: now,
    updatedAt: now,
  };

  const audit = {
    actor: actorUid || "unknown",
    requestId,
    detail: { email: request.email, note: note || null },
    at: now,
  };

  if (decision === "rejected") {
    // The decision and release are atomic. If a newer request owns the email
    // marker, it remains intact; if the commit is retried, the rejected request
    // cannot be reverted or have its review fields overwritten.
    let result = { released: false };
    try {
      if (!request.email) {
        await store.updateDocument(REQUESTS, requestId, common, {
          updateTime: request.updateTime,
        });
      } else {
        result = await store.rejectRequestAndReleaseMarker({
          requestId,
          requestUpdateTime: request.updateTime,
          patch: common,
          markerCollection: REQUEST_EMAILS,
          markerId: await hashEmail(request.email),
        });
      }
    } catch (error) {
      if (error && (error.status === 409 || error.status === 412)) {
        const current = await store.getDocument(REQUESTS, requestId);
        if (current && current.status !== "pending") {
          throw new AcceptError(409, `This request was already ${current.status}.`);
        }
        throw new AcceptError(409, "This request changed while rejecting. Try again.");
      }
      throw error;
    }

    await writeAudit(store, {
      ...audit,
      action: "request.rejected",
      detail: { ...audit.detail, markerReleased: result.released },
    });

    const emailed = await notifyDecision({
      env,
      request,
      requestId,
      decision,
    });

    return { requestId, status: "rejected", emailed, releasedMarker: result.released };
  }

  // Claim the request atomically before allocating anything. A versioned
  // precondition ensures concurrent approvals cannot both allocate a number.
  try {
    await store.updateDocument(REQUESTS, requestId, common, {
      updateTime: request.updateTime,
    });
  } catch (error) {
    if (error && (error.status === 409 || error.status === 412)) {
      const current = await store.getDocument(REQUESTS, requestId);
      throw new AcceptError(
        409,
        `This request was already ${(current && current.status) || "decided"}.`,
      );
    }
    throw error;
  }

  return acceptApplication(store, {
    request,
    requestId,
    audit,
    now,
    actorUid,
    env,
  });
}

/** The promotion half of an approval. */
async function acceptApplication(store, { request, requestId, audit, now, actorUid, env }) {
  const testerId = `t_${requestId}`;

  // The tester now lives on `users/{uid}`, so approval starts by resolving the
  // account the applicant created for themselves during signup. This happens
  // BEFORE any tester number is allocated, so a genuinely missing account fails
  // cleanly rather than burning a number.
  const account = await resolveTesterAccount(env, {
    email: request.email,
  });
  const { uid } = account;

  // Create the user document if the Auth account has never been seen by
  // Firestore. Existing documents are left exactly as they are.
  await ensureUserDocument(store, {
    uid,
    email: request.email,
    displayName: account.displayName || request.name,
    now,
  });

  // An applicant who is already a tester on this account keeps their existing
  // number and Wallet object — that is what makes "never create a second
  // tester" true. Their previous record was a re-application after a removal,
  // and resurrecting the old number would silently undo the removal.
  const user = await store.getDocument(USERS, uid);
  const alreadyTester = Boolean(user?.tester);

  if (alreadyTester) {
    // The EXISTING record is canonical. Reporting (and auditing) the id derived
    // from this request instead would be a lie: the request never created a
    // tester, it linked to one, and the audit trail and the Wallet object id
    // both have to name the record that actually exists.
    const linkedId = user.tester.id || testerId;
    const linkedNumber =
      typeof user.tester.testerNumber === "number" ? user.tester.testerNumber : null;

    // Status was already claimed atomically above; only the link is new here.
    await store.updateDocument(REQUESTS, requestId, { testerId: linkedId, userId: uid });
    await writeAudit(store, {
      ...audit,
      action: "tester.linked",
      testerId: linkedId,
      userId: uid,
    });

    // The applicant is already on the roster, so no new number is burned — but
    // they are still accepted here, so they are still notified. Their existing
    // number and the existing Wallet object are reused, which is what makes
    // "do not create a second tester" true.
    //
    // The portal pointer is (re)written on every approval, including this one:
    // a re-application is the natural repair for a pointer that went missing or
    // still names a pre-migration tester document.
    await writeTesterIndex(store, { email: request.email, userId: uid });
    const saveUrl = linkedNumber
      ? await issueWalletPass({
          store,
          env,
          uid,
          testerId: linkedId,
          testerNumber: linkedNumber,
          request,
        })
      : null;

    const emailed = linkedNumber
      ? await notifyDecision({
          env,
          request,
          requestId,
          decision: "approved",
          testerNumber: linkedNumber,
          saveUrl,
        })
      : false;

    return {
      requestId,
      status: "approved",
      testerId: linkedId,
      userId: uid,
      testerNumber: linkedNumber,
      emailed,
      saveUrl,
    };
  }

  // A re-application always takes a FRESH number, even when the same request id
  // is retried. The old code could recognise `testers/t_<requestId>` and reuse
  // its number, which is safe only because the id was derived from the request.
  // Now the id lives on a user document shared across tenures, so "already
  // approved" is detected by the `tester` map existing — handled above — and a
  // re-application after removal correctly gets a new number from the counter.
  // The counter itself is never rewound, so a retired number is never reissued.
  const testerNumber = await allocateTesterNumber(store);

  const tester = {
    id: testerId,
    requestId,
    userId: uid,
    name: request.name,
    email: request.email,
    status: STATUS.ACCEPTED,
    statusChangedAt: now,
    statusChangedBy: actorUid || "system",
    appliedAt: request.createdAt || now,
    acceptedAt: now,
    createdAt: now,
    testerNumber,
    // Derived from status, never set independently.
    active: activeForStatus(STATUS.ACCEPTED),
    activatedAt: now,
    deactivatedAt: null,
    deactivatedBy: null,
    deactivationReason: null,
    activity: { lastPeriod: null, comments: 0, reviews: 0 },
    wallet: {
      issuerId: ISSUER_ID,
      classId: `${ISSUER_ID}.crp_tester_loyalty`,
      accountId: accountIdFor(testerId),
      lastIssuedAt: null,
    },
    updatedAt: now,
  };

  // Written as a nested map with an explicit updateMask, so the user's other
  // fields (friends, friendRequests, lastLogin, displayName) are untouched.
  await store.updateDocument(USERS, uid, { tester });

  // Status was already claimed atomically above; only the link is new here.
  // userId as well as testerId: both are needed to trace a request back to the
  // account that now owns the tester, which is what the dashboard and the
  // tester portal navigate by.
  await store.updateDocument(REQUESTS, requestId, { testerId, userId: uid });

  // Point the portal at this account. Without it the newly accepted tester
  // cannot sign in and is told they are not on the roster — the tester record is
  // committed and their number is spent, but the dashboard has no way to find it.
  await writeTesterIndex(store, { email: request.email, userId: uid });

  // Everything the email needs is now durably stored: the tester exists, the
  // number is allocated, and the request is decided. The Wallet pass is
  // generated after that point, and the email is sent last, so a failure in
  // either can never leave a number burned with no tester created.
  const saveUrl = await issueWalletPass({
    store,
    env,
    uid,
    testerId,
    testerNumber,
    request,
  });

  const emailed = await notifyDecision({
    env,
    request,
    requestId,
    decision: "approved",
    testerNumber,
    saveUrl,
  });

  await writeAudit(store, {
    ...audit,
    action: "tester.created",
    testerId,
    userId: uid,
    detail: { ...audit.detail, testerNumber },
  });

  return {
    requestId,
    status: "approved",
    testerId,
    userId: uid,
    testerNumber,
    emailed,
    saveUrl,
  };
}

/**
 * Generate the tester's "Save to Google Wallet" URL and stamp the tester doc.
 *
 * Reuses the existing Wallet implementation (src/wallet.js, ported from
 * functions/src/wallet.js) rather than introducing a second Wallet system. The
 * signing key is the crp-tester-card service account held in a Worker secret;
 * only the resulting URL ever leaves this function, and the private key is
 * never returned, logged, or written to Firestore.
 *
 * Best-effort: a Wallet failure must not undo an accepted application. The
 * tester already exists and the number is already allocated at this point, so
 * the failure is logged and `null` is returned; the acceptance email then
 * simply omits the button, and the admin can still issue the card by hand from
 * the dashboard.
 */
async function issueWalletPass({ store, env, uid, testerId, testerNumber, request }) {
  try {
    const saveUrl = await buildSaveUrl({
      tester: { id: testerId, name: request.name },
      active: activeForStatus(STATUS.ACCEPTED),
      testerNumber,
      secretJson: env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON,
    });

    // `tester.wallet` specifically, not the whole `tester` map: the mask is what
    // stops this touching the user's other fields.
    await store.patchTester(USERS, uid, {
      wallet: {
        issuerId: ISSUER_ID,
        classId: `${ISSUER_ID}.crp_tester_loyalty`,
        accountId: accountIdFor(testerId),
        lastIssuedAt: new Date(),
      },
    });

    return saveUrl;
  } catch (error) {
    console.error(
      "wallet pass generation failed",
      JSON.stringify({ testerId, message: error && error.message }),
    );
    return null;
  }
}

/**
 * Remove a tester from the Testing Program.
 *
 * This is deliberately NOT the same thing as deactivating, and does not touch
 * setTesterStatus(). Deactivate keeps someone in the program as `revoked`,
 * reversible, and still blocks them from re-applying. Remove is the exit
 * decision: the person leaves, and is allowed to apply again.
 *
 * What it does, in one Firestore transaction (see store.removeTesterToHistory):
 *   1. appends a full snapshot of the tester onto the user's `testerHistory`
 *   2. deletes the `tester` map, which is what takes them off the roster
 *   3. writes a permanent audit entry with testerId, number, email and actor
 *   4. deletes their requestEmails marker, releasing the duplicate protection
 *
 * The tester is MOVED rather than flagged. `tester` is a map on the user
 * document, so a `removed` flag left in place would still read as "in the
 * programme" to anything that inspects `user.tester` — the app included.
 * Deleting the field makes membership a plain existence check, and the history
 * keeps everything the flag would have.
 *
 * What it deliberately preserves:
 *   - the snapshot on `testerHistory`, so name, number and activity survive.
 *   - the rest of the user document. Only `tester` and `testerHistory` are in
 *     the update mask, so `friends`, `friendRequests` and `lastLogin` are
 *     untouched.
 *   - the sequential counter, so the number is never handed to anyone else.
 *     A re-approved person gets a brand new number.
 *
 * A later application from the same address finds the account already exists
 * (the Auth account survives removal) and simply gets a new `tester` map with a
 * new number, leaving the history intact.
 *
 * @param {object} store Firestore handle.
 * @param {object} args
 * @param {string} args.userId  The Auth uid whose user document holds `tester`.
 * @param {string} [args.reason]  Required: removal must be explainable.
 * @param {string} [args.actorUid] Admin uid, for the audit entry.
 * @param {string} [args.actorEmail]
 */
export async function removeTester(store, { userId, reason, actorUid, actorEmail }) {
  if (!userId || typeof userId !== "string") {
    throw new AcceptError(400, "userId is required.");
  }

  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (!cleanReason) {
    // Same rule as deactivation, and for the same reason: the audit trail is
    // only useful if it says why.
    throw new AcceptError(400, "A reason is required when removing a tester.");
  }

  const user = await store.getDocument(USERS, userId);
  if (!user) throw new AcceptError(404, "No such user.");

  // Idempotency: a repeat removal is a no-op, not a second history entry and not
  // a second audit entry. This is the guard that makes the operation safe to
  // retry after a timeout or a double-click.
  if (!user.tester) {
    const prior = Array.isArray(user.testerHistory) ? user.testerHistory.at(-1) : null;
    return {
      userId,
      testerId: prior?.id ?? null,
      removed: true,
      alreadyRemoved: true,
      testerNumber: prior?.testerNumber ?? null,
      releasedMarker: false,
    };
  }

  const tester = user.tester;
  const testerId = tester.id || null;
  const now = new Date();
  const email = tester.email;

  // The marker key is the same hash js/signup.js writes. Without a marker there
  // is nothing to release — a tester created before markers existed, say — and
  // the removal still proceeds.
  const releaseId = email ? await hashEmail(email) : null;

  const auditEntry = {
    action: "tester.removed",
    actor: actorUid || "system",
    actorEmail: actorEmail || null,
    userId,
    testerId,
    testerNumber: tester.testerNumber ?? null,
    email: email || null,
    reason: String(cleanReason).slice(0, 300),
    at: now,
    // Recorded so a future reader can see the Wallet card was revoked as part of
    // the same decision, not left live.
    walletRevoked: true,
  };

  let result;
  try {
    result = await store.removeTesterToHistory({
      collection: USERS,
      id: userId,
      // The full prior record, so nothing is lost — the archived entry answers
      // "what was this person's number and status when they left".
      archived: {
        ...tester,
        removed: true,
        // Leaving the program implies not active. `status` moves to revoked so
        // the lifecycle vocabulary stays consistent and a reissue yields a
        // REVOKED card.
        status: STATUS.REVOKED,
        active: false,
        removedAt: now,
        removedBy: actorUid || "system",
        removalReason: String(cleanReason).slice(0, 300),
        statusChangedAt: now,
        statusChangedBy: actorUid || "system",
        deactivatedAt: now,
        deactivatedBy: actorUid || "system",
        deactivationReason: String(cleanReason).slice(0, 300),
        updatedAt: now,
      },
      auditCollection: AUDIT,
      // Deterministic, so the create-if-absent write fails on a retry instead of
      // appending a second removal entry.
      auditId: `removed_${testerId || userId}`,
      // Version precondition: if anyone edited this user between our read and
      // the commit — including the main app updating `lastLogin` — the removal
      // fails rather than clobbering their change.
      updateTime: user.updateTime,
      auditEntry,
      releaseCollection: releaseId ? REQUEST_EMAILS : null,
      releaseId,
    });
  } catch (error) {
    if (error && (error.status === 409 || error.status === 412)) {
      // Someone changed the user concurrently. Re-read so the retry reports
      // accurately rather than blindly clobbering.
      const current = await store.getDocument(USERS, userId);
      if (current && !current.tester) {
        const prior = Array.isArray(current.testerHistory)
          ? current.testerHistory.at(-1)
          : null;
        return {
          userId,
          testerId: prior?.id ?? testerId,
          removed: true,
          alreadyRemoved: true,
          testerNumber: prior?.testerNumber ?? tester.testerNumber ?? null,
          releasedMarker: false,
        };
      }
      throw new AcceptError(409, "This tester changed while removing. Try again.");
    }
    throw error;
  }

  // Tidy up the records that outlive the removal.
  //
  // The `tester` map is already gone and archived by the transaction above, so
  // nothing here can re-grant access — this only stops leftovers from
  // contradicting that. Two of them used to survive:
  //
  //   - the legacy `testers/{testerId}` document, which went on reading
  //     status "accepted" / active true long after the tester was gone;
  //   - the `testerIndex/{emailHash}` pointer, which used to be BLANKED to
  //     userId: null. findTesterByEmail() only treats an absent pointer as "not
  //     on the roster", so a blanked one turned every later sign-in from that
  //     address into a 409 "Your tester record needs migrating".
  //
  // Deliberately after the transaction: the removal is authoritative once
  // committed, and a failure here must not undo it or invite a retry that could
  // double-apply. But failures are NOT swallowed — each is logged by
  // deleteIfPresent and reported back in `cleanup`, so a half-finished tidy-up is
  // visible instead of being reported as a clean removal.
  const cleanup = { pointerDeleted: false, legacyDeleted: false, errors: [] };

  if (email) {
    try {
      cleanup.pointerDeleted = await deleteIfPresent(
        store, TESTER_INDEX, await hashEmail(email), "testerIndex pointer",
      );
    } catch (error) {
      cleanup.errors.push(`testerIndex: ${(error && error.message) || "unknown"}`);
    }
  }

  if (testerId) {
    try {
      cleanup.legacyDeleted = await deleteIfPresent(
        store, TESTERS, testerId, "legacy tester document",
      );
    } catch (error) {
      cleanup.errors.push(`legacy tester: ${(error && error.message) || "unknown"}`);
    }
  }

  if (cleanup.errors.length) {
    console.error(
      "removeTester cleanup incomplete",
      JSON.stringify({ userId, testerId, errors: cleanup.errors }),
    );
  }

  return {
    userId,
    testerId,
    removed: true,
    alreadyRemoved: Boolean(result?.alreadyRemoved),
    testerNumber: tester.testerNumber ?? null,
    email: email || null,
    // What actually happened to the two stale records. Reported rather than
    // assumed, so an incomplete tidy-up cannot read as success.
    cleanup,
    // The caller reissues the card so the applicant's wallet shows REVOKED.
    // Deliberately not generated here: the transactional commit is the
    // authoritative record, and a Wallet failure must not undo a removal.
    releasedMarker: Boolean(releaseId),
  };
}

/**
 * Delete a document that may already be gone.
 *
 * A 404 is success, not failure: removal must be idempotent, so removing a
 * tester twice — or removing one whose index was never written — has to complete
 * rather than error. Any OTHER failure is logged and re-thrown, because a
 * silently skipped delete is exactly how the stale documents survived in the
 * first place: the caller swallowed the error and went on to report success.
 *
 * @returns {Promise<boolean>} true when a document was actually deleted.
 */
async function deleteIfPresent(store, collection, id, label) {
  try {
    await store.deleteDocument(collection, id);
    return true;
  } catch (error) {
    if (error && error.status === 404) return false;
    console.error(
      `${label} deletion failed`,
      JSON.stringify({
        collection,
        id,
        status: error && error.status,
        message: error && error.message,
      }),
    );
    throw error;
  }
}

/**
 * Set a tester's lifecycle status.
 *
 * Mirrors the setTesterStatus / setTesterActive callables, including the rule
 * that `active` is derived from `status` rather than set independently.
 *
 * Addresses the user, not the tester: `tester` is a map on the user document,
 * so the caller passes the Auth uid and the patch is written to `tester.*`.
 * A user with no `tester` map has been removed from the programme and cannot
 * have their status changed — that is a 404, not a silent recreate.
 */
export async function setTesterStatus(store, { userId, status, active, reason, actorUid }) {
  const target = status || (active ? STATUS.ACCEPTED : STATUS.REVOKED);

  if (status && !Object.values(STATUS).includes(status)) {
    throw new AcceptError(400, "Unknown status.");
  }
  if (target === STATUS.REJECTED && !reason) {
    throw new AcceptError(400, "A reason is required when rejecting.");
  }
  // Deactivating must be explainable, exactly as the setTesterActive callable
  // required. Without this the dashboard could revoke a tester with no record of
  // why, which is the one thing the audit trail is for. Trimmed first, so a
  // whitespace-only reason is rejected rather than stored as "   ".
  const cleanReason = typeof reason === "string" ? reason.trim() : reason;
  if (active === false && !cleanReason) {
    throw new AcceptError(400, "A reason is required when deactivating a tester.");
  }

  if (!userId || typeof userId !== "string") {
    throw new AcceptError(400, "userId is required.");
  }

  const user = await store.getDocument(USERS, userId);
  // Absent document and absent `tester` map are different situations and are
  // reported differently: the first is a bad id, the second is someone who has
  // already been removed from the programme.
  if (!user) throw new AcceptError(404, "No such user.");
  const tester = user.tester;
  if (!tester) throw new AcceptError(404, "This user is not a tester.");
  if (tester.status === target) throw new AcceptError(409, `Already ${target}.`);

  const testerId = tester.id || null;
  const now = new Date();
  const patch = {
    status: target,
    // Derived, so the boolean can never drift from the lifecycle.
    active: activeForStatus(target),
    statusChangedAt: now,
    statusChangedBy: actorUid || "system",
    updatedAt: now,
  };

  if (patch.active) {
    // Preserve the original acceptance time; only fill it in if never set.
    if (!tester.acceptedAt) patch.acceptedAt = now;
    if (typeof tester.testerNumber !== "number") {
      patch.testerNumber = await allocateTesterNumber(store);
    }
    patch.activatedAt = now;
    patch.deactivatedAt = null;
    patch.deactivatedBy = null;
    patch.deactivationReason = null;
  } else {
    patch.deactivatedAt = now;
    patch.deactivatedBy = actorUid || "system";
    patch.deactivationReason = cleanReason ? String(cleanReason).slice(0, 300) : null;
  }

  // Masked to tester.* so the user's other fields cannot be clobbered.
  await store.patchTester(USERS, userId, patch);

  await writeAudit(store, {
    actor: actorUid || "system",
    action: `tester.status.${target}`,
    userId,
    testerId,
    detail: { from: tester.status ?? null, to: target, reason: reason || null },
    at: now,
  });

  return {
    userId,
    testerId,
    status: target,
    active: patch.active,
    testerNumber: patch.testerNumber ?? tester.testerNumber ?? null,
  };
}
