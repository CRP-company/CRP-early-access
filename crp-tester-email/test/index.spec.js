import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index.js";
// Vite inlines these as strings at build time. The Workers test runtime has no
// filesystem, so readFileSync is not available here.
// eslint-disable-next-line import/extensions
import wranglerConfig from "../wrangler.jsonc?raw";
// eslint-disable-next-line import/extensions
import indexSource from "../src/index.js?raw";
// eslint-disable-next-line import/extensions
import resendSource from "../src/resend.js?raw";
// eslint-disable-next-line import/extensions
import templateSource from "../src/email-template.js?raw";

const ORIGIN = "https://crp-company.github.io";
const RESEND_API = "https://api.resend.com/emails";

const env = {
  RESEND_API_KEY: "re_test_key",
  ALLOWED_ORIGINS: ORIGIN,
  CRP_EMAIL_FROM: "CRP Tester Program <testing@crp.company>",
};

/** Build a request to /send. Pass `raw` to bypass JSON.stringify. */
function sendRequest(body, { origin = ORIGIN, method = "POST", raw } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  return new Request("https://worker.test/send", {
    method,
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
}

const validBody = {
  name: "Alex Morgan",
  email: "Alex.Morgan@Example.com",
  requestId: "req_abc123",
};

/**
 * Stub the Resend endpoint so tests never touch the network. Returns the array
 * of captured calls for asserting on headers and payload.
 */
function stubResend({ status = 200, body = { id: "email-123" } } = {}) {
  const calls = [];
  vi.stubGlobal("fetch", async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("health", () => {
  it("reports status without leaking the key", async () => {
    const res = await worker.fetch(new Request("https://worker.test/"), env, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.configured).toBe(true);
    expect(JSON.stringify(body)).not.toContain("re_test_key");
  });

  it("reports configured:false when the secret is missing", async () => {
    const res = await worker.fetch(
      new Request("https://worker.test/"),
      { ...env, RESEND_API_KEY: undefined },
      {},
    );
    expect((await res.json()).configured).toBe(false);
  });
});

describe("origin allow-list", () => {
  it("rejects a disallowed origin and sends nothing", async () => {
    const calls = stubResend();
    const res = await worker.fetch(
      sendRequest(validBody, { origin: "https://evil.example" }),
      env,
      {},
    );
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("rejects a request with no Origin header", async () => {
    const calls = stubResend();
    const res = await worker.fetch(sendRequest(validBody, { origin: null }), env, {});
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("answers preflight only for allowed origins", async () => {
    const good = await worker.fetch(
      new Request("https://worker.test/send", {
        method: "OPTIONS",
        headers: { Origin: ORIGIN },
      }),
      env,
      {},
    );
    expect(good.status).toBe(204);
    expect(good.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);

    const bad = await worker.fetch(
      new Request("https://worker.test/send", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example" },
      }),
      env,
      {},
    );
    expect(bad.status).toBe(403);
  });

  // The admin dashboard sends the Firebase ID token in Authorization, which
  // makes every /accept call a preflighted request. A preflight that omits
  // Authorization is rejected by the browser before the request is ever sent,
  // which is what broke the Approve button.
  it("allows Authorization in the preflight, alongside Content-Type", async () => {
    const res = await worker.fetch(
      new Request("https://worker.test/accept", {
        method: "OPTIONS",
        headers: {
          Origin: ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization, content-type",
        },
      }),
      env,
      {},
    );

    expect(res.status).toBe(204);
    const allowed = res.headers.get("Access-Control-Allow-Headers") || "";
    // Header names are case-insensitive to the browser, so compare lowercased.
    const lower = allowed.toLowerCase();
    expect(lower).toContain("authorization");
    expect(lower).toContain("content-type");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("never answers a preflight with a wildcard origin", async () => {
    const res = await worker.fetch(
      new Request("https://worker.test/accept", {
        method: "OPTIONS",
        headers: { Origin: ORIGIN },
      }),
      env,
      {},
    );
    // These routes are bearer-token authenticated; "*" would let any site call
    // them, so the specific origin must be echoed instead.
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
  });

  it("sets the CORS origin on the real response, not just the preflight", async () => {
    // Without this the browser runs the request, then refuses to hand the body
    // to JavaScript — the failure looks like a network error.
    stubResend();
    const res = await worker.fetch(sendRequest(validBody), env, {});
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("omits the CORS origin for a disallowed origin so the body stays unreadable", async () => {
    const res = await worker.fetch(
      sendRequest(validBody, { origin: "https://evil.example" }),
      env,
      {},
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("keeps a 401 readable so the dashboard can show the real reason", async () => {
    const res = await worker.fetch(
      new Request("https://worker.test/accept", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "req_1", decision: "approved" }),
      }),
      {
        ...env,
        FIREBASE_PROJECT_ID: "crp-cuby-display",
        // Present but never used: requireAdmin rejects the missing token first.
        FIREBASE_SERVICE_ACCOUNT_JSON: "{}",
      },
      {},
    );

    // No token supplied, so this is rejected by requireAdmin.
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    // The body must be readable, otherwise the dashboard shows a CORS error
    // instead of the real reason.
    expect((await res.json()).ok).toBe(false);
  });
});

describe("routing and methods", () => {
  it("rejects GET on /send", async () => {
    const res = await worker.fetch(
      new Request("https://worker.test/send", { headers: { Origin: ORIGIN } }),
      env,
      {},
    );
    expect(res.status).toBe(405);
  });

  it("404s an unknown path", async () => {
    const res = await worker.fetch(new Request("https://worker.test/nope"), env, {});
    expect(res.status).toBe(404);
  });
});

describe("validation", () => {
  const bad = [
    ["missing name", { ...validBody, name: undefined }],
    ["missing email", { ...validBody, email: undefined }],
    ["missing requestId", { ...validBody, requestId: undefined }],
    ["non-string name", { ...validBody, name: 42 }],
    ["malformed email", { ...validBody, email: "not-an-email" }],
    ["email without a domain dot", { ...validBody, email: "a@b" }],
    ["name too short", { ...validBody, name: "A" }],
    ["name too long", { ...validBody, name: "x".repeat(200) }],
    ["requestId with header-breaking characters", { ...validBody, requestId: "bad id" }],
    ["requestId too long", { ...validBody, requestId: "x".repeat(300) }],
    ["array body", []],
  ];

  for (const [label, body] of bad) {
    it(`rejects ${label} without sending`, async () => {
      const calls = stubResend();
      const res = await worker.fetch(sendRequest(body), env, {});
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  }

  it("rejects a malformed JSON body", async () => {
    const res = await worker.fetch(sendRequest(null, { raw: "{not json" }), env, {});
    expect(res.status).toBe(400);
  });
});

describe("sending through Resend", () => {
  it("returns 200 and reports the Resend id", async () => {
    stubResend();
    const res = await worker.fetch(sendRequest(validBody), env, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.id).toBe("email-123");
  });

  it("posts to the Resend API with the key and idempotency headers", async () => {
    const calls = stubResend();
    await worker.fetch(sendRequest(validBody), env, {});

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(RESEND_API);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe("Bearer re_test_key");
    // The request id is the idempotency key: one request, one email.
    expect(calls[0].init.headers["Idempotency-Key"]).toBe("req_abc123");
  });

  it("sends the agreed sender, recipient, subject and both bodies", async () => {
    const calls = stubResend();
    await worker.fetch(sendRequest(validBody), env, {});

    const sent = JSON.parse(calls[0].init.body);
    expect(sent.from).toBe("CRP Tester Program <testing@crp.company>");
    expect(sent.to).toEqual(["alex.morgan@example.com"]); // normalised
    expect(sent.subject).toBe("CRP Tester Program — Application Received");
    expect(sent.html).toContain("We're reviewing your application.");
    expect(sent.html).toContain("Hi Alex");
    expect(sent.text).toContain("Thank you for your interest in CRP.");
  });

  it("escapes a hostile name in the rendered email", async () => {
    const calls = stubResend();
    await worker.fetch(
      sendRequest({ ...validBody, name: '<img src=x onerror="alert(1)">' }),
      env,
      {},
    );

    const sent = JSON.parse(calls[0].init.body);
    expect(sent.html).not.toMatch(/<img[^>]*onerror/i);
    expect(sent.html).not.toContain("onerror=");
  });

  it("uses a 502 and hides Resend's error text from the caller", async () => {
    stubResend({
      status: 422,
      body: { message: "The from address is not verified" },
    });

    const res = await worker.fetch(sendRequest(validBody), env, {});
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.ok).toBe(false);
    // A browser must not learn Resend's internals.
    expect(JSON.stringify(body)).not.toContain("not verified");
  });

  it("fails clearly when the API key is not configured", async () => {
    const calls = stubResend();
    const res = await worker.fetch(sendRequest(validBody), { ...env, RESEND_API_KEY: undefined }, {});
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(0);
  });

  it("reports a 502 when Resend is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const res = await worker.fetch(sendRequest(validBody), env, {});
    expect(res.status).toBe(502);
    expect((await res.json()).ok).toBe(false);
  });
});

describe("no secrets in source", () => {
  it("wrangler.jsonc never inlines the API key", () => {
    expect(wranglerConfig).not.toMatch(/re_[A-Za-z0-9]{20,}/);
    // Referenced in comments only; never assigned a value.
    expect(wranglerConfig).not.toMatch(/"RESEND_API_KEY"\s*:/);
  });

  it("no source file hardcodes a Resend key", () => {
    for (const [name, source] of [
      ["src/index.js", indexSource],
      ["src/resend.js", resendSource],
      ["src/email-template.js", templateSource],
    ]) {
      expect(source, name).not.toMatch(/re_[A-Za-z0-9]{20,}/);
    }
  });
});

