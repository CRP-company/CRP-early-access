/**
 * Tests for the Firestore REST client, focused on the request shape.
 *
 * Regression: updateDocument() used to PATCH without an `updateMask`. The REST
 * API then treats the body as the whole document and deletes every field it
 * does not mention. Deciding a request sent only status/note/reviewedBy/
 * reviewedAt/updatedAt, which wiped the applicant's name, email, consent and
 * createdAt. Firestore excludes documents missing the orderBy field, so the
 * request vanished from the Admin Dashboard while the requestEmails dedupe
 * marker survived and still reported "you have already applied".
 *
 * These tests assert the URL that is built, because that is where the bug was.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createFirestore, encodeFields } from "../src/firestore-rest.js";
import * as oauth from "../src/oauth.js";

const SECRET = JSON.stringify({
  type: "service_account",
  project_id: "crp-cuby-display",
  client_email: "worker@crp-cuby-display.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----\n",
});

const PATH_PREFIX =
  "/v1/projects/crp-cuby-display/databases/(default)/documents";

let calls;

/** Stub fetch and the OAuth exchange, so nothing touches the network. */
function stub() {
  calls = [];
  vi.spyOn(oauth, "getAccessToken").mockResolvedValue("stub-token");
  vi.stubGlobal("fetch", async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  oauth.__resetTokenCache();
});

describe("updateDocument must send an updateMask", () => {
  it("includes every written field in updateMask.fieldPaths", async () => {
    stub();
    const store = createFirestore(SECRET, "crp-cuby-display");
    await store.updateDocument("requests", "req-1", {
      status: "rejected",
      note: null,
      reviewedBy: "uid-1",
    });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe(`${PATH_PREFIX}/requests/req-1`);
    expect(calls[0].init.method).toBe("PATCH");
    expect(url.searchParams.getAll("updateMask.fieldPaths").sort()).toEqual([
      "note",
      "reviewedBy",
      "status",
    ]);
  });

  it("keeps the existence precondition alongside the mask", async () => {
    stub();
    const store = createFirestore(SECRET, "crp-cuby-display");
    await store.updateDocument("requests", "req-1", { status: "approved" });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get("currentDocument.exists")).toBe("true");
    expect(url.searchParams.getAll("updateMask.fieldPaths")).toEqual(["status"]);
  });

  it("still honours an updateTime precondition (counter safety unchanged)", async () => {
    stub();
    const store = createFirestore(SECRET, "crp-cuby-display");
    await store.updateDocument(
      "meta",
      "testerCounter",
      { lastNumber: 2 },
      { updateTime: "2026-09-01T00:00:00.000Z" },
    );

    const url = new URL(calls[0].url);
    expect(url.searchParams.get("currentDocument.updateTime")).toBe("2026-09-01T00:00:00.000Z");
    expect(url.searchParams.get("currentDocument.exists")).toBeNull();
    expect(url.searchParams.getAll("updateMask.fieldPaths")).toEqual(["lastNumber"]);
  });

  it("sends only the changed fields in the body", async () => {
    stub();
    const store = createFirestore(SECRET, "crp-cuby-display");
    await store.updateDocument("requests", "req-1", { status: "rejected", note: null });

    const body = JSON.parse(calls[0].init.body);
    // With the mask this is a merge: unlisted fields stay untouched.
    expect(Object.keys(body.fields).sort()).toEqual(["note", "status"]);
  });
});

describe("createDocument is unchanged", () => {
  it("still uses the exists=false precondition for atomic create", async () => {
    stub();
    const store = createFirestore(SECRET, "crp-cuby-display");
    await store.createDocument("users", "uid_1", { email: "a@example.com" });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get("currentDocument.exists")).toBe("false");
  });
});

/**
 * Regression: the store must expose deleteDocument.
 *
 * removeTester() dropped the testerIndex pointer by calling store.deleteDocument,
 * but the REST client never defined it. The call threw TypeError, the caller's
 * catch swallowed it, and the fallback blanked the pointer to `userId: null`
 * instead — leaving a document that findTesterByEmail() reports as a stale
 * pre-migration record, so /tester-me answered 409 rather than 403 and the
 * removed tester could never sign in cleanly again. Production carried two such
 * pointers. The method being absent is the whole defect, so assert it is present.
 */
describe("deleteDocument", () => {
  it("issues a DELETE to the document path", async () => {
    stub();
    const store = createFirestore(SECRET, "crp-cuby-display");
    await store.deleteDocument("testerIndex", "abc123");

    expect(calls[0].init.method).toBe("DELETE");
    expect(new URL(calls[0].url).pathname).toBe(
      `${PATH_PREFIX}/testerIndex/abc123`,
    );
  });

  it("surfaces a 404 as status 404 so callers can treat it as already gone", async () => {
    vi.spyOn(oauth, "getAccessToken").mockResolvedValue("stub-token");
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));

    const store = createFirestore(SECRET, "crp-cuby-display");
    await expect(store.deleteDocument("testerIndex", "missing")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("is actually exposed on the store the Worker uses", () => {
    stub();
    const store = createFirestore(SECRET, "crp-cuby-display");
    expect(typeof store.deleteDocument).toBe("function");
  });
});

describe("rejectRequestAndReleaseMarker", () => {
  function stubTransaction(markerRequestId, commitStatus = 200) {
    calls = [];
    vi.spyOn(oauth, "getAccessToken").mockResolvedValue("stub-token");
    vi.stubGlobal("fetch", async (url, init = {}) => {
      const parsed = new URL(String(url));
      calls.push({ url: parsed, init });
      if (parsed.href.endsWith(":beginTransaction")) {
        return new Response(JSON.stringify({ transaction: "txn-1" }), { status: 200 });
      }
      if (parsed.pathname.endsWith("/requestEmails/hash-1")) {
        return new Response(JSON.stringify({
          fields: encodeFields({ requestId: markerRequestId }),
          updateTime: "marker-version-1",
        }), { status: 200 });
      }
      if (parsed.href.endsWith(":commit")) {
        return new Response(commitStatus === 200 ? "{}" : "conflict", { status: commitStatus });
      }
      if (parsed.href.endsWith(":rollback")) {
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${parsed.href}`);
    });
  }

  it("releases only a marker owned by the exact rejected request", async () => {
    stubTransaction("req-1");
    const store = createFirestore(SECRET, "crp-cuby-display");

    const result = await store.rejectRequestAndReleaseMarker({
      requestId: "req-1",
      requestUpdateTime: "request-version-1",
      patch: { status: "rejected", note: "reviewed" },
      markerCollection: "requestEmails",
      markerId: "hash-1",
    });

    expect(result.released).toBe(true);
    const markerRead = calls.find(({ init }) => !init.method);
    expect(markerRead.url.searchParams.get("transaction")).toBe("txn-1");
    const commitCall = calls.find(({ url }) => url.href.endsWith(":commit"));
    const writes = JSON.parse(commitCall.init.body).writes;
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({
      delete: "projects/crp-cuby-display/databases/(default)/documents/requestEmails/hash-1",
      currentDocument: { updateTime: "marker-version-1" },
    });
    expect(writes[0].currentDocument).toEqual({ updateTime: "request-version-1" });
    expect(writes[0].updateMask.fieldPaths).toEqual(["status", "note"]);
  });

  it("leaves another request's marker untouched", async () => {
    stubTransaction("req-2");
    const store = createFirestore(SECRET, "crp-cuby-display");

    const result = await store.rejectRequestAndReleaseMarker({
      requestId: "req-1",
      requestUpdateTime: "request-version-1",
      patch: { status: "rejected" },
      markerCollection: "requestEmails",
      markerId: "hash-1",
    });

    expect(result.released).toBe(false);
    const commitCall = calls.find(({ url }) => url.href.endsWith(":commit"));
    expect(JSON.parse(commitCall.init.body).writes).toHaveLength(1);
  });

  it("surfaces a concurrent version conflict without partially committing", async () => {
    stubTransaction("req-1", 409);
    const store = createFirestore(SECRET, "crp-cuby-display");

    await expect(store.rejectRequestAndReleaseMarker({
      requestId: "req-1",
      requestUpdateTime: "request-version-1",
      patch: { status: "rejected" },
      markerCollection: "requestEmails",
      markerId: "hash-1",
    })).rejects.toMatchObject({ status: 409 });
    expect(calls.some(({ url }) => url.href.endsWith(":rollback"))).toBe(true);
  });
});

describe("releaseRejectedRequestMarker", () => {
  function stubTransaction(requestStatus, markerRequestId, commitStatus = 200) {
    calls = [];
    vi.spyOn(oauth, "getAccessToken").mockResolvedValue("stub-token");
    vi.stubGlobal("fetch", async (url, init = {}) => {
      const parsed = new URL(String(url));
      calls.push({ url: parsed, init });
      if (parsed.href.endsWith(":beginTransaction")) {
        return new Response(JSON.stringify({ transaction: "txn-retry" }), { status: 200 });
      }
      if (parsed.pathname.endsWith("/requests/req-1")) {
        return new Response(JSON.stringify({
          fields: encodeFields({ status: requestStatus }),
          updateTime: "request-version-1",
        }), { status: 200 });
      }
      if (parsed.pathname.endsWith("/requestEmails/hash-1")) {
        return new Response(JSON.stringify({
          fields: encodeFields({ requestId: markerRequestId }),
          updateTime: "marker-version-2",
        }), { status: 200 });
      }
      if (parsed.href.endsWith(":commit")) {
        return new Response(commitStatus === 200 ? "{}" : "conflict", { status: commitStatus });
      }
      if (parsed.href.endsWith(":rollback")) {
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${parsed.href}`);
    });
  }

  it("deletes only the exact-owned marker and leaves the request untouched", async () => {
    stubTransaction("rejected", "req-1");
    const store = createFirestore(SECRET, "crp-cuby-display");

    const result = await store.releaseRejectedRequestMarker({
      requestId: "req-1",
      markerCollection: "requestEmails",
      markerId: "hash-1",
    });

    expect(result.released).toBe(true);
    const reads = calls.filter(({ init }) => !init.method);
    expect(reads).toHaveLength(2);
    expect(reads.every(({ url }) => url.searchParams.get("transaction") === "txn-retry")).toBe(true);
    const writes = JSON.parse(calls.find(({ url }) => url.href.endsWith(":commit")).init.body).writes;
    expect(writes).toEqual([{
      delete: "projects/crp-cuby-display/databases/(default)/documents/requestEmails/hash-1",
      currentDocument: { updateTime: "marker-version-2" },
    }]);
  });

  it("does not delete a marker owned by a newer request", async () => {
    stubTransaction("rejected", "req-2");
    const store = createFirestore(SECRET, "crp-cuby-display");

    const result = await store.releaseRejectedRequestMarker({
      requestId: "req-1",
      markerCollection: "requestEmails",
      markerId: "hash-1",
    });

    expect(result.released).toBe(false);
    expect(calls.some(({ url }) => url.href.endsWith(":commit"))).toBe(false);
    expect(calls.some(({ url }) => url.href.endsWith(":rollback"))).toBe(true);
  });

  it("refuses recovery when the request is not rejected", async () => {
    stubTransaction("approved", "req-1");
    const store = createFirestore(SECRET, "crp-cuby-display");

    await expect(store.releaseRejectedRequestMarker({
      requestId: "req-1",
      markerCollection: "requestEmails",
      markerId: "hash-1",
    })).rejects.toMatchObject({ status: 409 });
    expect(calls.some(({ url }) => url.href.endsWith(":commit"))).toBe(false);
    expect(calls.some(({ url }) => url.href.endsWith(":rollback"))).toBe(true);
  });
});

describe("project pinning still holds", () => {
  it("refuses a key for a different project", () => {
    const walletKey = JSON.stringify({ project_id: "crp-tester-card" });
    expect(() => createFirestore(walletKey, "crp-cuby-display")).toThrow(/crp-tester-card/);
  });

  it("requires FIREBASE_PROJECT_ID", () => {
    expect(() => createFirestore(SECRET, undefined)).toThrow(/FIREBASE_PROJECT_ID/);
  });
});

describe("encodeFields", () => {
  it("encodes the types the request documents use", () => {
    const encoded = encodeFields({
      name: "Amir",
      consent: true,
      count: 3,
      at: new Date("2026-09-01T00:00:00.000Z"),
      nothing: null,
    });
    expect(encoded.name.stringValue).toBe("Amir");
    expect(encoded.consent.booleanValue).toBe(true);
    expect(encoded.count.integerValue).toBe("3");
    expect(encoded.at.timestampValue).toBe("2026-09-01T00:00:00.000Z");
    expect(encoded.nothing.nullValue).toBeNull();
  });

  it("skips undefined so a mask entry never carries no value", () => {
    expect(encodeFields({ a: 1, b: undefined })).toEqual({ a: { integerValue: "1" } });
  });
});
