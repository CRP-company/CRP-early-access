import { describe, it, expect } from "vitest";
import {
  findTesterByEmail,
  canSubmitFeedback,
  validateFeedback,
  buildFeedbackDoc,
  hashEmail,
  currentPeriod,
  PortalError,
  MONTHLY_TARGET,
} from "../src/tester-portal.js";
import { isAllowedAdminEmail, adminEmails } from "../src/admin-access.js";
import { STATUS } from "../src/tester-lifecycle.js";

const EMAIL = "alex@example.com";

/**
 * In-memory store seeded the way the real one is: a user document carrying a
 * `tester` map, plus the testerIndex pointer the Worker maintains on acceptance.
 *
 * The pointer holds a `userId`, because that is the document id of the account
 * that owns the tester record.
 */
async function storeWith(tester, { index = true, userId = "uid_1", indexEmail } = {}) {
  const docs = new Map();
  if (tester) {
    docs.set(`users/${userId}`, {
      email: tester.email,
      displayName: tester.name,
      tester: { id: "t_1", userId, ...tester },
    });
  }
  // `indexEmail` seeds the pointer from a different address than the stored
  // tester, which is how the "index points at the wrong person" case is built.
  if (tester && index) {
    docs.set(`testerIndex/${await hashEmail(indexEmail || tester.email)}`, { userId });
  }

  return {
    docs,
    async getDocument(c, id) {
      const d = docs.get(`${c}/${id}`);
      return d ? { ...d, exists: true } : null;
    },
    async createDocument(c, id, data) {
      const key = `${c}/${id}`;
      if (docs.has(key)) {
        const e = new Error("exists");
        e.status = 409;
        throw e;
      }
      docs.set(key, data);
    },
    async listCollection(c) {
      return [...docs.entries()]
        .filter(([k]) => k.startsWith(`${c}/`))
        .map(([k, v]) => ({ id: k.split("/").pop(), ...v }));
    },
  };
}

const tester = (over = {}) => ({
  name: "Alex Morgan",
  email: EMAIL,
  status: STATUS.ACCEPTED,
  active: true,
  testerNumber: 42,
  ...over,
});

describe("roster lookup", () => {
  it("resolves a tester from their email via the index", async () => {
    const store = await storeWith(tester());
    const found = await findTesterByEmail(store, EMAIL);
    expect(found.id).toBe("t_1");
    expect(found.email).toBe(EMAIL);
  });

  it("is case- and whitespace-insensitive, like the signup form", async () => {
    const store = await storeWith(tester());
    const found = await findTesterByEmail(store, "  Alex@Example.COM  ");
    expect(found.id).toBe("t_1");
  });

  it("returns null for someone who is not on the roster", async () => {
    const store = await storeWith(tester());
    expect(await findTesterByEmail(store, "stranger@example.com")).toBeNull();
  });

  // The index is keyed by a hash, so a wrong pointer would silently hand one
  // tester another person's record. This is the guard against that.
  it("refuses to return a tester whose email does not match the index", async () => {
    // The pointer for alex@example.com resolves to a document belonging to
    // someone else — the corruption this guard exists to catch.
    const store = await storeWith(tester({ email: "someone.else@example.com" }), {
      indexEmail: EMAIL,
    });
    await expect(findTesterByEmail(store, EMAIL)).rejects.toThrow(PortalError);
  });

  it("returns null when the pointer names an account with no tester record", async () => {
    // A pointer can outlive the membership it named — the account is still there,
    // but the `tester` map is gone. That is a removed tester, not a broken index,
    // so it reads the same as "not on the roster" rather than raising.
    const store = await storeWith(tester(), { index: false });
    const key = `testerIndex/${await hashEmail(EMAIL)}`;
    store.docs.set(key, { userId: "uid_removed" });

    expect(await findTesterByEmail(store, EMAIL)).toBeNull();
  });

  it("refuses a pre-migration pointer that still names a tester document", async () => {
    // A pointer written before the move to user documents carries `testerId`.
    // There is no such collection any more, so it cannot be resolved to anyone and
    // must not be guessed at — a wrong guess hands one tester another's record.
    const store = await storeWith(tester(), { index: false });
    const key = `testerIndex/${await hashEmail(EMAIL)}`;
    store.docs.set(key, { testerId: "t_1" });

    await expect(findTesterByEmail(store, EMAIL)).rejects.toThrow(/migrating/i);
  });

  it("resolves the uid as well as the tester id", async () => {
    // The uid is what feedback is written under and what the routes address.
    const store = await storeWith(tester());
    const found = await findTesterByEmail(store, EMAIL);
    expect(found.userId).toBe("uid_1");
    expect(found.id).toBe("t_1");
  });
});

describe("who may submit feedback", () => {
  it("allows an accepted tester", () => {
    expect(canSubmitFeedback(tester())).toEqual({ allowed: true, reason: null });
  });

  it("blocks a revoked tester", () => {
    expect(canSubmitFeedback(tester({ status: STATUS.REVOKED, active: false })).reason).toBe("inactive");
  });

  it("blocks a rejected tester", () => {
    expect(canSubmitFeedback(tester({ status: STATUS.REJECTED })).reason).toBe("inactive");
  });

  it("blocks a removed tester even if the status was never flipped", () => {
    expect(canSubmitFeedback(tester({ removed: true })).reason).toBe("removed");
  });

  it("blocks someone who is not on the roster at all", () => {
    expect(canSubmitFeedback(null).reason).toBe("not-on-roster");
  });

  // status is the single source of truth. A document that somehow disagrees with
  // itself must be judged by status, so `active: true` on a revoked tester
  // cannot be used to slip past the gate.
  it("judges by status, not by the active flag", () => {
    const inconsistent = tester({ status: STATUS.REVOKED, active: true });
    expect(canSubmitFeedback(inconsistent).allowed).toBe(false);
  });
});

describe("validateFeedback", () => {
  const good = { title: "Dark mode", body: "Please add a dark theme to the app.", area: "app" };

  it("accepts a well-formed request", () => {
    const result = validateFeedback(good);
    expect(result.ok).toBe(true);
    expect(result.value.status).toBe("submitted");
  });

  it("rejects a title that is too short", () => {
    expect(validateFeedback({ ...good, title: "Hi" }).ok).toBe(false);
  });

  it("rejects a body that is too short to be useful", () => {
    expect(validateFeedback({ ...good, body: "do it" }).ok).toBe(false);
  });

  it("rejects an unknown area", () => {
    expect(validateFeedback({ ...good, area: "something-else" }).ok).toBe(false);
  });

  it("rejects an oversized body", () => {
    expect(validateFeedback({ ...good, body: "x".repeat(2001) }).ok).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(validateFeedback(null).ok).toBe(false);
    expect(validateFeedback([]).ok).toBe(false);
  });

  it("trims whitespace before measuring", () => {
    // "  ab  " is 6 characters raw but only 2 of content; trimming first is what
    // stops padded junk from satisfying the minimum.
    expect(validateFeedback({ ...good, title: "  ab  " }).ok).toBe(false);
  });

  // A client must not be able to triage its own request to "shipped".
  it("ignores a status supplied by the caller", () => {
    const result = validateFeedback({ ...good, status: "shipped" });
    expect(result.ok).toBe(true);
    expect(result.value.status).toBe("submitted");
  });
});

describe("buildFeedbackDoc", () => {
  it("stamps the owner from the resolved record, not the request", () => {
    const { value } = validateFeedback({
      title: "Add dark mode",
      body: "Please add it soon.",
      area: "app",
    });
    const doc = buildFeedbackDoc(value, {
      tester: { id: "t_9", ...tester() },
      email: "ALEX@example.com",
    });

    expect(doc.testerId).toBe("t_9");
    expect(doc.email).toBe(EMAIL);
    expect(doc.createdAt).toBeInstanceOf(Date);
  });

  it("carries the period the request counts towards", () => {
    const period = "2026-02";
    const { value } = validateFeedback(
      { title: "Add dark mode", body: "Please add it soon.", area: "app" },
      { period },
    );
    const doc = buildFeedbackDoc(value, { tester: { id: "t_9", ...tester() }, email: EMAIL });
    expect(doc.period).toBe(period);
  });
});

describe("currentPeriod", () => {
  it("formats as YYYY-MM and zero-pads the month", () => {
    expect(currentPeriod(new Date("2026-02-03T10:00:00Z"))).toBe("2026-02");
    expect(currentPeriod(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11");
  });
});

describe("MONTHLY_TARGET", () => {
  it("asks for two submissions a month", () => {
    expect(MONTHLY_TARGET).toBe(2);
  });
});

describe("admin allowlist", () => {
  it("permits the two CRP staff addresses", () => {
    expect(isAllowedAdminEmail("amiratron5@gmail.com")).toBe(true);
    expect(isAllowedAdminEmail("idogaldavid@gmail.com")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isAllowedAdminEmail("AmirAtron5@Gmail.com")).toBe(true);
  });

  it("refuses anyone else, including a holder of the admin claim", () => {
    expect(isAllowedAdminEmail("someone.else@gmail.com")).toBe(false);
    expect(isAllowedAdminEmail("attacker@evil.com")).toBe(false);
  });

  // The default must not be "allow everyone" — an unset variable has to fail closed.
  it("falls back to the built-in list when unset or blank", () => {
    expect(adminEmails(undefined)).toEqual(["amiratron5@gmail.com", "idogaldavid@gmail.com"]);
    expect(adminEmails("   ")).toEqual(["amiratron5@gmail.com", "idogaldavid@gmail.com"]);
  });

  it("honours an explicit override", () => {
    expect(adminEmails("one@x.com, two@y.com")).toEqual(["one@x.com", "two@y.com"]);
    expect(isAllowedAdminEmail("two@y.com", "one@x.com, two@y.com")).toBe(true);
    expect(isAllowedAdminEmail("amiratron5@gmail.com", "one@x.com")).toBe(false);
  });

  it("refuses a missing or non-string email", () => {
    expect(isAllowedAdminEmail(undefined)).toBe(false);
    expect(isAllowedAdminEmail("")).toBe(false);
  });
});