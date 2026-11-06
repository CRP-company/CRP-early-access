import { describe, it, expect, vi, beforeEach } from "vitest";
import { webcrypto } from "node:crypto";
import { hashEmail } from "../src/tester-portal.js";
import { encodeFields } from "../src/firestore-rest.js";
import { _resetRateLimits } from "../src/rate-limit.js";

const ORIGIN = "https://crp-company.github.io";
const PROJECT = "crp-cuby-display";
const TESTER_EMAIL = "alex@example.com";
const TESTER_UID = "uid_tester_1";
const ADMIN_EMAIL = "staff@crp.com";
const ADMIN_UID = "uid_admin_1";

vi.stubGlobal("crypto", webcrypto);

const b64url = (b) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let worker;
let store;
let keyPair;
let resendCalls = [];

beforeEach(async () => {
  _resetRateLimits();
  resendCalls = [];
  worker = (await import("../src/index.js")).default;

  store = new Map([
    [
      `testerIndex/${await hashEmail(TESTER_EMAIL)}`,
      { userId: TESTER_UID },
    ],
    [
      `users/${TESTER_UID}`,
      {
        email: TESTER_EMAIL,
        displayName: "Alex Morgan",
        tester: {
          id: "t_1",
          userId: TESTER_UID,
          name: "Alex Morgan",
          email: TESTER_EMAIL,
          status: "accepted",
          active: true,
        },
      },
    ],
    [
      `testerIndex/${await hashEmail("revoked@example.com")}`,
      { userId: "uid_revoked" },
    ],
    [
      `users/uid_revoked`,
      {
        email: "revoked@example.com",
        tester: {
          id: "t_revoked",
          userId: "uid_revoked",
          email: "revoked@example.com",
          status: "revoked",
          active: false,
        },
      },
    ],
    [
      `requests/req_valid_1`,
      {
        name: "Sam Smith",
        email: "sam@example.com",
        status: "pending",
      },
    ],
    [
      `requests/req_already_sent`,
      {
        name: "Already Sent",
        email: "already@example.com",
        status: "pending",
        acknowledgementSentAt: "2026-11-06T10:00:00.000Z",
        acknowledgementResendId: "resend_previous_123",
      },
    ],
    [
      `requests/req_rejected`,
      {
        name: "Rejected",
        email: "rejected@example.com",
        status: "rejected",
      },
    ],
  ]);

  keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  const spki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  const certPem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(spki).toString("base64")}\n-----END CERTIFICATE-----`;

  vi.stubGlobal("fetch", async (url, init) => {
    const s = String(url);

    // Google signing keys
    if (s.includes("securetoken@system.gserviceaccount.com")) {
      return new Response(JSON.stringify({ "test-kid": certPem }), { status: 200 });
    }

    // Google OAuth
    if (s.endsWith("/token")) {
      return new Response(JSON.stringify({ access_token: "mock-oauth-token", expires_in: 3600 }), {
        status: 200,
      });
    }

    // Resend email
    if (s.includes("api.resend.com")) {
      resendCalls.push({ url: s, init });
      return new Response(JSON.stringify({ id: "resend_new_456" }), { status: 200 });
    }

    // Firestore GET
    if (s.includes("/documents/")) {
      const pathname = new URL(s).pathname;
      const path = pathname.slice(pathname.lastIndexOf("/documents/") + "/documents/".length);

      if ((!init.method || init.method === "GET") && store.has(path)) {
        const doc = store.get(path);
        return new Response(JSON.stringify({ fields: encodeFields(doc) }), { status: 200 });
      }

      if (init && init.method === "PATCH") {
        return new Response(JSON.stringify({}), { status: 200 });
      }

      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }

    return new Response("ok", { status: 200 });
  });

  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const b64 = Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n");
  const privateKeyPem = "-----BEGIN PRIVATE KEY-----\n" + b64 + "\n-----END PRIVATE KEY-----\n";

  env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    project_id: PROJECT,
    private_key: privateKeyPem,
    client_email: "test@example.com",
  });

  (await import("../src/auth.js")).__resetKeyCache();
  (await import("../src/oauth.js")).__resetTokenCache();
});

const env = {
  RESEND_API_KEY: "re_test",
  ALLOWED_ORIGINS: ORIGIN,
  FIREBASE_PROJECT_ID: PROJECT,
  FIREBASE_SERVICE_ACCOUNT_JSON: "",
  ADMIN_EMAILS: ADMIN_EMAIL,
  CRP_EMAIL_FROM: "CRP Tester Program <testing@crp.company>",
};

async function mintToken(claims) {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "test-kid" }));
  const payload = b64url(
    JSON.stringify({
      aud: PROJECT,
      iss: `https://securetoken.google.com/${PROJECT}`,
      sub: claims.sub || "user_1",
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...claims,
    }),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(signature)}`;
}

describe("Security Remediations", () => {
  describe("VULN-05: /tester-check route & PII protection", () => {
    it("allows unauthenticated callers to check roster eligibility", async () => {
      const req = new Request("https://worker.test/tester-check", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ email: TESTER_EMAIL }),
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ ok: true, eligible: true });
      expect(body.name).toBeUndefined();
      expect(body.userId).toBeUndefined();
    });

    it("returns 404 for an unknown email address", async () => {
      const req = new Request("https://worker.test/tester-check", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "unknown@example.com" }),
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(404);
      expect((await res.json()).ok).toBe(false);
    });

    it("returns 403 for an inactive or revoked tester", async () => {
      const req = new Request("https://worker.test/tester-check", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "revoked@example.com" }),
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(403);
      expect((await res.json()).ok).toBe(false);
    });
  });

  describe("VULN-06: Dual-Tier Rate Limiting", () => {
    it("enforces rate limits on /tester-check and returns 429 with Retry-After", async () => {
      const rateLimitedEnv = { ...env, TEST_RATE_LIMITING: true };
      const makeReq = () =>
        new Request("https://worker.test/tester-check", {
          method: "POST",
          headers: {
            Origin: ORIGIN,
            "Content-Type": "application/json",
            "CF-Connecting-IP": "198.51.100.1",
          },
          body: JSON.stringify({ email: TESTER_EMAIL }),
        });

      // Threshold is 10 requests per 15 minutes
      for (let i = 0; i < 10; i++) {
        const res = await worker.fetch(makeReq(), rateLimitedEnv);
        expect(res.status).toBe(200);
      }

      // 11th request triggers rate limit
      const blocked = await worker.fetch(makeReq(), rateLimitedEnv);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("Retry-After")).toBeTruthy();
    });
  });

  describe("VULN-01: /send Firestore Validation & Open Relay Prevention", () => {
    it("rejects /send when requestId does not exist in Firestore", async () => {
      const req = new Request("https://worker.test/send", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Spoofer",
          email: "victim@example.com",
          requestId: "req_non_existent",
        }),
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(404);
      expect(resendCalls).toHaveLength(0);
    });

    it("rejects /send when the email does not match the request document", async () => {
      const req = new Request("https://worker.test/send", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Sam Smith",
          email: "mismatched@example.com",
          requestId: "req_valid_1",
        }),
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(403);
      expect(resendCalls).toHaveLength(0);
    });

    it("rejects /send when the request status is not pending", async () => {
      const req = new Request("https://worker.test/send", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Rejected",
          email: "rejected@example.com",
          requestId: "req_rejected",
        }),
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      expect(resendCalls).toHaveLength(0);
    });

    it("prevents replay: returns 200 without sending another email if already sent", async () => {
      const req = new Request("https://worker.test/send", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Already Sent",
          email: "already@example.com",
          requestId: "req_already_sent",
        }),
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.id).toBe("resend_previous_123");
      expect(resendCalls).toHaveLength(0); // Zero calls to Resend!
    });

    it("sends email and updates Firestore when valid pending request is provided", async () => {
      const req = new Request("https://worker.test/send", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Sam Smith",
          email: "sam@example.com",
          requestId: "req_valid_1",
        }),
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      expect(resendCalls).toHaveLength(1);
    });
  });

  describe("VULN-07: Admin Step-Up Reauthentication", () => {
    it("refuses /tester-remove when admin auth_time is older than 15 minutes", async () => {
      const staleAuthTime = Math.floor(Date.now() / 1000) - 1000; // > 16 minutes
      const token = await mintToken({
        sub: ADMIN_UID,
        email: ADMIN_EMAIL,
        admin: true,
        auth_time: staleAuthTime,
      });

      const req = new Request("https://worker.test/tester-remove", {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: TESTER_UID, reason: "Test remove" }),
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.requireReauth).toBe(true);
    });
  });
});
