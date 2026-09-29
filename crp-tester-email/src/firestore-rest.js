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

  async function authHeaders() {
    return {
      Authorization: `Bearer ${await getAccessToken(secretJson)}`,
      "Content-Type": "application/json",
    };
  }

  /** Fetch a document. Returns null when it does not exist. */
  async function getDocument(collection, id) {
    const res = await fetch(docName(collection, id), { headers: await authHeaders() });
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
    const res = await fetch(`${docName(collection, id)}?currentDocument.exists=false`, {
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
    const url = new URL(docName(collection, id));
    if (options.updateTime) {
      url.searchParams.set("currentDocument.updateTime", options.updateTime);
    } else {
      url.searchParams.set("currentDocument.exists", "true");
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
   * Used to find an existing tester by email. The roster is small, so a full
   * scan is acceptable and avoids maintaining a separate email index.
   *
   * @returns {Promise<Array<{id: string} & Record<string, any>>>}
   */
  async function listCollection(collection) {
    const out = [];
    let pageToken = null;

    do {
      const url = new URL(`${base}/${collection}`);
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

  return {
    getDocument,
    createDocument,
    updateDocument,
    listCollection,
    beginTransaction,
    commit,
    rollback,
    docName,
  };
}

