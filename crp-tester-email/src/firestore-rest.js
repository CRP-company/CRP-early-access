/**
 * Minimal Firestore client over the REST API.
 *
 * The Firestore Admin SDK is not an option in a Worker, so this speaks the
 * v1 REST API directly. Only what the acceptance flow needs is implemented:
 * get, create, update, and transactions.
 *
 * Preconditions: this uses `currentDocument.exists` as its concurrency guard.
 * That distinction is load-bearing. Putting `updateTime` in the request BODY
 * does NOT act as a precondition — it is silently ignored and the write
 * clobbers a concurrent writer. Only the `currentDocument.exists` query
 * parameter is enforced (409 ALREADY_EXISTS). This was verified against the
 * emulator before the approach was chosen.
 */

import { getAccessToken } from "./oauth.js";

/**
 * Encode a plain JS value into Firestore's field-value format.
 *
 * Integers become decimal strings, which is what the REST API expects for
 * int64 — not the base64-protobuf form the gRPC layer uses.
 */
export function encodeFields(obj) {
  const fields = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;

    if (value === null) {
      fields[key] = { nullValue: null };
    } else if (typeof value === "string") {
      fields[key] = { stringValue: value };
    } else if (typeof value === "boolean") {
      fields[key] = { booleanValue: value };
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError(`${key} is not a finite number`);
      fields[key] = { integerValue: String(Math.trunc(value)) };
    } else if (value instanceof Date) {
      fields[key] = { timestampValue: value.toISOString() };
    } else if (Array.isArray(value)) {
      fields[key] = { arrayValue: { values: value.map((v) => encodeFields({ v }).v) } };
    } else if (typeof value === "object") {
      fields[key] = { mapValue: { fields: encodeFields(value) } };
    } else {
      throw new TypeError(`Cannot encode field "${key}" of type ${typeof value}`);
    }
  }

  return fields;
}

const decodeOne = (v) => decodeFields({ v }).v;

/** Decode a Firestore document's fields back into plain JS values. */
export function decodeFields(fields) {
  const out = {};
  for (const [key, f] of Object.entries(fields || {})) {
    if ("stringValue" in f) out[key] = f.stringValue;
    else if ("booleanValue" in f) out[key] = f.booleanValue;
    else if ("integerValue" in f) out[key] = Number(f.integerValue);
    else if ("doubleValue" in f) out[key] = Number(f.doubleValue);
    else if ("nullValue" in f) out[key] = null;
    else if ("timestampValue" in f) out[key] = f.timestampValue;
    else if ("arrayValue" in f) out[key] = (f.arrayValue.values || []).map(decodeOne);
    else if ("mapValue" in f) out[key] = decodeFields(f.mapValue.fields);
  }
  return out;
}

/**
 * A Firestore handle bound to a service-account secret.
 *
 * @param {string} secretJson  Raw service account JSON (from a Worker secret).
 * @param {string} projectId   The project to operate on, from
 *   FIREBASE_PROJECT_ID. Required, and cross-checked against the key.
 */
export function createFirestore(secretJson, projectId) {
  const keyProject = JSON.parse(secretJson).project_id;

  // The caller's token is verified against FIREBASE_PROJECT_ID, so the data
  // must be written to that same project. Deriving the target from the key
  // instead would let a mismatched key write into a *different* project's
  // database while the authorisation check passed against this one — a silent
  // cross-project write. Fail loudly rather than guess.
  if (!projectId) {
    throw new Error("FIREBASE_PROJECT_ID is not configured.");
  }
  if (keyProject !== projectId) {
    throw new Error(
      `Service account is for project "${keyProject}" but FIREBASE_PROJECT_ID is ` +
        `"${projectId}". Refusing to write to the wrong project. Use a key for ` +
        `${projectId}, or correct FIREBASE_PROJECT_ID.`,
    );
  }

  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

  const docName = (collection, id) => `${base}/${collection}/${id}`;

  /**
   * The relative resource name, e.g.
   * `projects/p/databases/(default)/documents/users/uid1`.
   *
   * Distinct from docName(), which is a full URL. The `name` inside a Firestore
   * `Write` must be relative, not an absolute URL — passing the full URL is
   * rejected with `Document name "https://..." lacks "projects" at index 0`.
   * (Verified live against production.)
   */
  const docPath = (collection, id) =>
    `projects/${projectId}/databases/(default)/documents/${collection}/${id}`;

  // Firestore document paths are slash-separated, so a subcollection is just a
  // deeper path. These two helpers accept one and split it back into the
  // (collection, id) pair the existing functions expect, which is what lets
  // `createDocument("testers/t1/feedback", id, doc)` work without duplicating
  // every method below.
  function splitPath(path) {
    const parts = String(path).split("/").filter(Boolean);
    if (parts.length < 2 || parts.length % 2 !== 0) {
      throw new Error(
        `Firestore path must be an even number of segments (collection/document[/...]), got "${path}".`,
      );
    }
    return { collection: parts[0], id: parts[1] };
  }

  function pathUrl(path) {
    return new URL(`${base}/${String(path).replace(/^\/+|\/+$/g, "")}`);
  }

  async function authHeaders() {
    return {
      Authorization: `Bearer ${await getAccessToken(secretJson)}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Fetch a document. Returns null when it does not exist.
   *
   * `collection` may be a nested path like "testers/t1/feedback", which is what
   * subcollection callers pass.
   */
  async function getDocument(collection, id, options = {}) {
    const url = pathUrl(`${collection}/${id}`);
    if (options.transaction) {
      url.searchParams.set("transaction", options.transaction);
    }
    const res = await fetch(url, { headers: await authHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore GET failed (${res.status}): ${await res.text()}`);
    const doc = await res.json();
    return { ...decodeFields(doc.fields), updateTime: doc.updateTime, exists: true };
  }

  /**
   * Create a document, failing if it already exists.
   *
   * `currentDocument.exists=false` is what makes this atomic: if another writer
   * created the document first this returns 409 rather than overwriting it.
   * The tester-number counter relies on exactly this.
   */
  async function createDocument(collection, id, data) {
    const res = await fetch(`${pathUrl(`${collection}/${id}`)}?currentDocument.exists=false`, {
      method: "PATCH",
      headers: await authHeaders(),
      body: JSON.stringify({ fields: encodeFields(data) }),
    });
    if (!res.ok) {
      const err = new Error(`create ${collection}/${id} failed (${res.status}): ${await res.text()}`);
      err.status = res.status;
      throw err;
    }
    return true;
  }

  /**
   * Merge fields into an existing document, under an optional precondition.
   *
   * The precondition is the whole point of this function, and it is easy to get
   * wrong. Verified against the Firestore emulator:
   *
   *   - `exists=true`  only checks the document is present. Two writers both
   *     succeed and the second silently overwrites the first. Unsafe.
   *   - `updateTime=X` checks the document has not changed since X was read.
   *     The second writer gets 409. This is what makes counters safe.
   *
   * @param {string} collection
   * @param {string} id
   * @param {object} data
   * @param {{updateTime?: string}} [options] Pass updateTime for a safe
   *   read-modify-write; omit it only for idempotent, non-counter writes.
   */
  async function updateDocument(collection, id, data, options = {}) {
    const url = pathUrl(`${collection}/${id}`);
    if (options.updateTime) {
      url.searchParams.set("currentDocument.updateTime", options.updateTime);
    } else {
      url.searchParams.set("currentDocument.exists", "true");
    }

    // An explicit updateMask is required. Without one, the REST API treats the
    // PATCH body as the *entire* document and DELETES every field it does not
    // mention. That silently destroyed data: deciding a request sent only
    // {status, note, reviewedBy, reviewedAt, updatedAt}, which wiped the
    // applicant's name, email, consent and createdAt. The doc then vanished
    // from the Admin Dashboard, because Firestore excludes documents that lack
    // the orderBy field, while the requestEmails dedupe marker survived and
    // kept reporting "you have already applied".
    for (const field of Object.keys(data)) {
      url.searchParams.append("updateMask.fieldPaths", field);
    }

    const res = await fetch(url, {
      method: "PATCH",
      headers: await authHeaders(),
      body: JSON.stringify({ fields: encodeFields(data) }),
    });

    if (!res.ok) {
      const err = new Error(`update ${collection}/${id} failed (${res.status}): ${await res.text()}`);
      err.status = res.status;
      throw err;
    }
    return true;
  }

  async function beginTransaction() {
    const res = await fetch(`${base}:beginTransaction`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ options: { readWrite: {} } }),
    });
    if (!res.ok) throw new Error(`beginTransaction failed (${res.status}): ${await res.text()}`);
    return (await res.json()).transaction;
  }

  /**
   * Commit writes atomically.
   *
   * A commit whose precondition no longer holds fails with 409, which is how a
   * lost update is detected instead of being silently applied.
   *
   * @param {string} transaction
   * @param {Array<object>} writes  Each may carry a `currentDocument` guard.
   */
  async function commit(transaction, writes) {
    const res = await fetch(`${base}:commit`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ transaction, writes }),
    });
    if (!res.ok) {
      const err = new Error(`commit failed (${res.status}): ${await res.text()}`);
      err.status = res.status;
      throw err;
    }
    return true;
  }

  async function rollback(transaction) {
    await fetch(`${base}:rollback`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ transaction }),
    }).catch(() => {
      // Not actionable: the transaction expires regardless.
    });
  }

  /**
   * List a whole collection with its document ids.
   *
   * Used to find an existing user by email. The roster is small, so a full
   * scan is acceptable and avoids maintaining a separate email index.
   *
   * `collection` may be a nested path like "testers/t1/feedback".
   *
   * @returns {Promise<Array<{id: string} & Record<string, any>>>}
   */
  async function listCollection(collection) {
    const out = [];
    let pageToken = null;

    do {
      const url = pathUrl(collection);
      url.searchParams.set("pageSize", "300");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const res = await fetch(url, { headers: await authHeaders() });
      if (!res.ok) throw new Error(`Firestore list failed (${res.status}): ${await res.text()}`);

      const json = await res.json();
      for (const doc of json.documents || []) {
        const id = doc.name.split("/").pop();
        out.push({ id, ...decodeFields(doc.fields) });
      }
      pageToken = json.nextPageToken || null;
    } while (pageToken);

    return out;
  }

  /**
   * List a subcollection, e.g. `users/uid/feedback`.
   *
   * A thin wrapper over listCollection, which already accepts a slash-separated
   * document path — Firestore's REST API addresses a subcollection exactly like
   * a document, by path segment. This exists so callers say what they mean
   * ("the feedback under this tester") instead of concatenating strings at the
   * call site and hoping the parent id has no slashes in it.
   *
   * @param {string} parentPath  e.g. `users/uid_1`.
   * @param {string} name        e.g. `feedback`.
   * @returns {Promise<Array<{id: string} & Record<string, any>>>}
   */
  async function listSubcollection(parentPath, name) {
    return listCollection(`${String(parentPath).replace(/^\/+|\/+$/g, "")}/${name}`);
  }

  /**
   * Merge a patch into the `tester` MAP nested inside a user document.
   *
   * `tester` is a map field on `users/{uid}`, not a subcollection, so every
   * lifecycle write targets a dotted path like `tester.active` rather than a
   * document of its own. That is what keeps a wallet reissue or a deactivation
   * from having to re-send the whole record — and, more importantly, from
   * clobbering the sibling fields on the user document (`friends`, `lastLogin`,
   * `friendRequests`) that the main app owns.
   *
   * The mask path is dotted (`tester.wallet`) but the request BODY must be
   * genuinely nested (`{tester: {wallet: ...}}`). Writing `{"tester.wallet": …}`
   * instead looks equivalent and is not: Firestore would store a top-level
   * field whose literal name contains a dot, the mask would find nothing to
   * update, and the write would silently do nothing.
   *
   * @param {string} collection
   * @param {string} id
   * @param {object} patch              Fields relative to the `tester` map.
   * @param {{updateTime?: string}} [options]
   */
  async function patchTester(collection, id, patch, options = {}) {
    const body = {};
    const maskPaths = [];
    for (const [key, value] of Object.entries(patch)) {
      body.tester = { ...(body.tester || {}), [key]: value };
      maskPaths.push(`tester.${key}`);
    }
    return patchNested(collection, id, body, maskPaths, options);
  }

  /**
   * Update specific field paths on a document.
   *
   * @param {string[]} maskPaths  Dotted field paths, e.g. `tester.wallet`.
   */
  async function patchNested(collection, id, body, maskPaths, options = {}) {
    const url = pathUrl(`${collection}/${id}`);
    if (options.updateTime) {
      url.searchParams.set("currentDocument.updateTime", options.updateTime);
    } else {
      url.searchParams.set("currentDocument.exists", "true");
    }
    // One parameter PER FIELD. A comma-joined single value also works, but the
    // per-field form is what updateDocument already uses, so keeping them
    // identical avoids a second shape to reason about.
    for (const field of maskPaths) {
      url.searchParams.append("updateMask.fieldPaths", field);
    }

    const res = await fetch(url, {
      method: "PATCH",
      headers: await authHeaders(),
      body: JSON.stringify({ fields: encodeFields(body) }),
    });

    if (!res.ok) {
      const err = new Error(
        `update ${collection}/${id} failed (${res.status}): ${await res.text()}`,
      );
      err.status = res.status;
      throw err;
    }
    return true;
  }

  /**
   * Atomically archive a tester and release their dedupe marker.
   *
   * These two writes MUST land together. A partial remove is the one genuinely
   * dangerous outcome here: either the tester is gone from the active roster
   * while their `requestEmails` marker survives forever (they are blocked from
   * ever applying again, with no way to fix it from the UI), or the marker is
   * released while the tester is still listed as active (a removed person is
   * still on the roster).
   *
   * A Firestore transaction gives real cross-document atomicity, so this uses
   * beginTransaction/commit rather than sequential writes. The existing
   * `commit()` already forwards REST `writes` verbatim, so a `delete` write is
   * just `{ delete: <docName> }`.
   *
   * `delete` without a precondition is a no-op when the marker is already
   * absent, which is what makes a retried removal harmless.
   *
   * @param {object} args
   * @param {string} args.collection          Tester collection.
   * @param {string} args.id                  Tester document id.
   * @param {object} args.patch               Fields to merge into the tester.
   * @param {string} args.updateTime          Version precondition for the tester.
   * @param {string} args.auditCollection
   * @param {string} args.auditId             Deterministic, so a retry cannot
   *                                           write a second history entry.
   * @param {object} args.auditEntry
   * @param {string|null} args.releaseCollection  Marker collection, or null to
   *                                           leave the marker alone.
   * @param {string|null} args.releaseId
   * @returns {Promise<{removed: boolean}>}
   */
  async function removeTester({
    collection,
    id,
    patch,
    updateTime,
    auditCollection,
    auditId,
    auditEntry,
    releaseCollection = null,
    releaseId = null,
  }) {
    const transaction = await beginTransaction();

    const writes = [
      {
        update: {
          name: docPath(collection, id),
          fields: encodeFields(patch),
        },
        // Only these fields change; name, email, testerNumber and the activity
        // history are deliberately left intact.
        updateMask: { fieldPaths: Object.keys(patch) },
        currentDocument: { updateTime },
      },
      {
        // Firestore's Write has no `create` verb — only `update` and `delete`.
        // Create-if-absent is expressed as an update guarded by
        // `exists: false`, which fails if the id is already taken. That is what
        // makes a repeated removal impossible: it cannot append a second
        // history entry. (Verified live: a `create` write is rejected outright
        // with `Unknown name "create" at 'writes[1]'`.)
        update: {
          name: docPath(auditCollection, auditId),
          fields: encodeFields(auditEntry),
        },
        currentDocument: { exists: false },
      },
    ];

    if (releaseCollection && releaseId) {
      writes.push({ delete: docPath(releaseCollection, releaseId) });
    }

    await commit(transaction, writes);
    return { removed: true };
  }

  /**
   * Archive a tester by pushing it onto the user's `testerHistory` array.
   *
   * The old model kept a `removed` flag on a standalone `testers/{id}` document
   * and hid it in the UI. That does not work here: `tester` is a field on a user
   * document, and a `removed` flag left in place would mean a removed tester
   * still reads as "present" to any other part of the app that inspects
   * `user.tester`. So removal MOVES the record: the snapshot goes onto
   * `testerHistory` and the `tester` field itself is deleted, which makes
   * "is this person in the programme" a single field-existence check.
   *
   * Atomicity is the same requirement as the old archive, and for the same
   * reason: the history entry and the marker release must land together. If the
   * history push succeeded but the `requestEmails` marker survived, the person
   * would be off the roster yet permanently blocked from re-applying. So all
   * three writes go in one transaction.
   *
   * The read of `testerHistory` happens inside the transaction on purpose. It is
   * a read-modify-write on an array, so it has to be inside for the retry to be
   * correct — reading it outside and appending would let a concurrent write
   * silently drop an earlier history entry.
   *
   * @param {object} args
   * @param {string} args.collection         The `users` collection.
   * @param {string} args.id                  The user document id (Auth uid).
   * @param {object} args.archived            The tester snapshot to push.
   * @param {object} args.auditCollection
   * @param {string} args.auditId             Deterministic, so a retry cannot
   *                                           append a second history entry.
   * @param {object} args.auditEntry
   * @param {string|null} [args.releaseCollection]
   * @param {string|null} [args.releaseId]
   * @param {string} [args.updateTime]        Version precondition for the user.
   * @returns {Promise<{removed: boolean, alreadyRemoved: boolean}>}
   */
  async function removeTesterToHistory({
    collection,
    id,
    archived,
    auditCollection,
    auditId,
    auditEntry,
    releaseCollection = null,
    releaseId = null,
    updateTime,
  }) {
    const transaction = await beginTransaction();
    try {
      const user = await getDocument(collection, id, { transaction });
      if (!user) {
        const error = new Error(`No such user ${collection}/${id}.`);
        error.status = 404;
        throw error;
      }

      // Version precondition. The user document is shared with the main app,
      // which writes `lastLogin` on every sign-in, so a document that moved
      // between our read and this commit is expected rather than exotic — but it
      // still has to fail rather than archive a stale snapshot over the top.
      if (updateTime && updateTime !== user.updateTime) {
        const error = new Error("The user changed while removing.");
        error.status = 409;
        throw error;
      }

      // The `tester` field is already gone, so this tester is gone. Re-pushing
      // would duplicate a history entry, which is exactly what the deterministic
      // audit id below exists to prevent.
      if (!user.tester) {
        await rollback(transaction);
        return { removed: true, alreadyRemoved: true };
      }

      const history = Array.isArray(user.testerHistory) ? user.testerHistory : [];

      const writes = [
        {
          update: {
            name: docPath(collection, id),
            // `tester: null` is the delete. Firestore has no "delete field"
            // verb, but a nullValue inside an updateMask removes the field, so
            // listing "tester" in the mask and sending an explicit null is how
            // the map is dropped. Sibling fields (friends, lastLogin, ...) are
            // untouched because the mask is explicit.
            fields: encodeFields({ tester: null, testerHistory: [...history, archived] }),
          },
          updateMask: { fieldPaths: ["tester", "testerHistory"] },
        },
        {
          // Create-if-absent, so a retry cannot append a second audit entry.
          update: {
            name: docPath(auditCollection, auditId),
            fields: encodeFields(auditEntry),
          },
          currentDocument: { exists: false },
        },
      ];

      if (releaseCollection && releaseId) {
        writes.push({ delete: docPath(releaseCollection, releaseId) });
      }

      await commit(transaction, writes);
      return { removed: true, alreadyRemoved: false };
    } catch (error) {
      await rollback(transaction);
      throw error;
    }
  }

  /**
   * Reject a request and release its email marker as one atomic decision.
   * The marker is deleted only if it still points to this request.
   */
  async function rejectRequestAndReleaseMarker({
    requestId,
    requestUpdateTime,
    patch,
    markerCollection,
    markerId,
  }) {
    const transaction = await beginTransaction();
    try {
      const marker = await getDocument(markerCollection, markerId, { transaction });
      const ownsMarker = marker?.requestId === requestId;
      const writes = [
        {
          update: {
            name: docPath("requests", requestId),
            fields: encodeFields(patch),
          },
          updateMask: { fieldPaths: Object.keys(patch) },
          currentDocument: { updateTime: requestUpdateTime },
        },
      ];

      if (ownsMarker) {
        writes.push({
          delete: docPath(markerCollection, markerId),
          currentDocument: { updateTime: marker.updateTime },
        });
      }

      await commit(transaction, writes);
      return { released: ownsMarker };
    } catch (error) {
      await rollback(transaction);
      throw error;
    }
  }

  /**
   * Recover a rejected request's marker without changing the historical request.
   * This is safe to call repeatedly and only removes a marker still owned by it.
   */
  async function releaseRejectedRequestMarker({ requestId, markerCollection, markerId }) {
    const transaction = await beginTransaction();
    try {
      const request = await getDocument("requests", requestId, { transaction });
      if (!request || request.status !== "rejected") {
        const error = new Error("Request is no longer rejected.");
        error.status = 409;
        throw error;
      }

      const marker = await getDocument(markerCollection, markerId, { transaction });
      if (marker?.requestId !== requestId) {
        await rollback(transaction);
        return { released: false };
      }

      await commit(transaction, [
        {
          delete: docPath(markerCollection, markerId),
          currentDocument: { updateTime: marker.updateTime },
        },
      ]);
      return { released: true };
    } catch (error) {
      await rollback(transaction);
      throw error;
    }
  }

  return {
    getDocument,
    createDocument,
    updateDocument,
    patchTester,
    listCollection,
    listSubcollection,
    beginTransaction,
    commit,
    rollback,
    removeTester,
    removeTesterToHistory,
    rejectRequestAndReleaseMarker,
    releaseRejectedRequestMarker,
    docName,
  };
}
