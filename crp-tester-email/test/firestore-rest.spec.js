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
    await store.createDocument("testers", "t_1", { email: "a@example.com" });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get("currentDocument.exists")).toBe("false");
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
