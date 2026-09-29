import { describe, it, expect, vi } from "vitest";
import {
  buildApplicationReceivedEmail,
  escapeHtml,
  greetingFor,
} from "../src/email-template.js";
import { postToWorker, decideViaWorker } from "../../admin/js/worker-client.js";

describe("escapeHtml", () => {
  it("escapes HTML-significant characters", () => {
    expect(escapeHtml('<b>"x"</b>')).toBe("&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });
});

describe("greetingFor", () => {
  it("uses only the first name", () => {
    expect(greetingFor("Alex Morgan")).toBe("Alex");
    expect(greetingFor("  Alex   Morgan ")).toBe("Alex");
    expect(greetingFor("Jean-Luc Picard")).toBe("Jean-Luc");
    expect(greetingFor("Zoë O'Brien")).toBe("Zoë");
  });

  it("validates rather than sanitising", () => {
    // Stripping would produce "b" or "img", inventing a name. Reject instead.
    expect(greetingFor("<b>")).toBe("there");
    expect(greetingFor("...")).toBe("there");
    expect(greetingFor("")).toBe("there");
    expect(greetingFor("   ")).toBe("there");
    expect(greetingFor(undefined)).toBe("there");
  });
});

describe("buildApplicationReceivedEmail", () => {
  const { subject, html, text } = buildApplicationReceivedEmail({
    name: "Alex Morgan",
    email: "alex@example.com",
  });

  it("uses the agreed subject", () => {
    expect(subject).toBe("CRP Tester Program — Application Received");
  });

  it("contains the required copy", () => {
    expect(html).toContain("We're reviewing your application.");
    expect(html).toContain("Hi Alex");
    expect(html).toContain("Thank you for applying to the CRP Tester Program.");
    expect(html).toContain("We'll notify you by email once there's an update.");
    expect(html).toContain("Thank you for your interest in CRP.");
  });

  it("includes both images", () => {
    expect(html).toContain("https://i.postimg.cc/K8zf4q4q/CRPlogo.png");
    expect(html).toContain("1776869274976-74e932ff-18d5-462e-885b-c6ed42d42bcf.png");
  });

  it("provides a matching plain-text alternative", () => {
    expect(text).toContain("Hi Alex");
    expect(text).toContain("CRP Tester Program");
    expect(text).toContain("Thank you for your interest in CRP.");
    expect(text).toContain("https://");
  });

  it("is safe for mail clients", () => {
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('role="presentation"'); // tables, not flex/grid
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<style/i);
  });

  it("has no leftover template markers", () => {
    for (const blob of [html, text]) {
      expect(blob).not.toContain("undefined");
      expect(blob).not.toContain("{{");
      expect(blob).not.toContain("[object Object]");
    }
  });

  it("neutralises a hostile name", () => {
    const evil = buildApplicationReceivedEmail({
      name: '<img src=x onerror="alert(1)">',
      email: "x@example.com",
    });
    expect(evil.html).not.toMatch(/<img[^>]*onerror/i);
    expect(evil.html).not.toContain("onerror=");
  });

  it("honours asset overrides", () => {
    const custom = buildApplicationReceivedEmail(
      { name: "Alex", email: "a@b.co" },
      { logoUrl: "https://example.com/logo.png" },
    );
    expect(custom.html).toContain("https://example.com/logo.png");
  });
});

/* ------------------------------------------------------------------ *
 * Admin dashboard -> Worker client
 *
 * The dashboard authorises itself with a Firebase ID token. The Worker writes
 * with a service account that bypasses security rules, so a missing or
 * malformed header is the difference between a guarded endpoint and an open one.
 * ------------------------------------------------------------------ */

const URL_UNDER_TEST = "https://crp-tester-email.example.workers.dev/accept";
const JWT = "header.payload.signature";

/** Capture what the client actually sent. */
function captureFetch(response = { ok: true, body: { ok: true, testerNumber: 1 } }) {
  const calls = [];
  const impl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { impl, calls };
}

describe("postToWorker", () => {
  it("sends the ID token as a bearer header", async () => {
    // The authorisation the Worker checks. Without it: 401.
    const { impl, calls } = captureFetch();
    await postToWorker({ url: URL_UNDER_TEST, token: JWT, body: { a: 1 }, fetchImpl: impl });

    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${JWT}`);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["Content-Type"]).toBe("application/json");
  });

  it("sends the payload as JSON", async () => {
    const { impl, calls } = captureFetch();
    await postToWorker({ url: URL_UNDER_TEST, token: JWT, body: { requestId: "r1" }, fetchImpl: impl });
    expect(JSON.parse(calls[0].init.body)).toEqual({ requestId: "r1" });
  });

  it("returns the parsed response", async () => {
    const { impl } = captureFetch({ ok: true, body: { ok: true, testerNumber: 4 } });
    const result = await postToWorker({ url: URL_UNDER_TEST, token: JWT, body: {}, fetchImpl: impl });
    expect(result).toEqual({ ok: true, testerNumber: 4 });
  });

  it("throws a readable error when the Worker reports one", async () => {
    const { impl } = captureFetch({
      status: 409,
      body: { ok: false, error: "This request was already approved." },
    });
    await expect(
      postToWorker({ url: URL_UNDER_TEST, token: JWT, body: {}, fetchImpl: impl }),
    ).rejects.toThrow("This request was already approved.");
  });

  it("refuses to call without a token", async () => {
    // Guards against silently sending an unauthenticated request.
    const { impl, calls } = captureFetch();
    await expect(
      postToWorker({ url: URL_UNDER_TEST, token: "", body: {}, fetchImpl: impl }),
    ).rejects.toThrow(/session/i);
    expect(calls).toHaveLength(0);
  });

  it("refuses to call without a URL", async () => {
    const { impl, calls } = captureFetch();
    await expect(
      postToWorker({ url: "", token: JWT, body: {}, fetchImpl: impl }),
    ).rejects.toThrow(/not configured/i);
    expect(calls).toHaveLength(0);
  });

  it("reports a network failure clearly", async () => {
    const impl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      postToWorker({ url: URL_UNDER_TEST, token: JWT, body: {}, fetchImpl: impl }),
    ).rejects.toThrow(/Could not reach/i);
  });

  it("survives a non-JSON error body", async () => {
    // A proxy or gateway error must not become "[object Object]".
    const impl = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
    await expect(
      postToWorker({ url: URL_UNDER_TEST, token: JWT, body: {}, fetchImpl: impl }),
    ).rejects.toThrow(/502/);
  });
});

describe("decideViaWorker", () => {
  it("posts the decision to /accept with requestId and note", async () => {
    const { impl, calls } = captureFetch();
    await decideViaWorker({
      url: URL_UNDER_TEST,
      token: JWT,
      requestId: "r1",
      decision: "approved",
      note: "strong fit",
      fetchImpl: impl,
    });

    expect(calls[0].url).toBe(URL_UNDER_TEST);
    expect(JSON.parse(calls[0].init.body)).toEqual({
      requestId: "r1",
      decision: "approved",
      note: "strong fit",
    });
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${JWT}`);
  });

  it("defaults note to an empty string", async () => {
    const { impl, calls } = captureFetch();
    await decideViaWorker({
      url: URL_UNDER_TEST,
      token: JWT,
      requestId: "r1",
      decision: "rejected",
      fetchImpl: impl,
    });
    expect(JSON.parse(calls[0].init.body).note).toBe("");
  });
});
