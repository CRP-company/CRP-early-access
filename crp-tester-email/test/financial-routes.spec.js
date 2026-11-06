import { describe, it, expect, vi, beforeEach } from "vitest";
import { webcrypto } from "node:crypto";
import { encodeFields } from "../src/firestore-rest.js";
import { _resetRateLimits } from "../src/rate-limit.js";

const ORIGIN = "https://crp-company.github.io";
const PROJECT = "crp-cuby-display";

vi.stubGlobal("crypto", webcrypto);

const b64url = (b) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let worker;
let store;
let keyPair;

const env = {
  ALLOWED_ORIGINS: ORIGIN,
  FIREBASE_PROJECT_ID: PROJECT,
  FIREBASE_SERVICE_ACCOUNT_JSON: "",
  ADMIN_EMAILS: "owner@crp.com,admin@crp.com",
  SHOPIFY_SHOP_DOMAIN: "crp-company.myshopify.com",
  SHOPIFY_ACCESS_TOKEN: "shpat_mock_test_token",
  SHOPIFY_WEBHOOK_SECRET: "test_webhook_secret_key",
};

beforeEach(async () => {
  _resetRateLimits();
  worker = (await import("../src/index.js")).default;
  store = new Map();

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

    // Firestore GET / PATCH / DELETE / list
    if (s.includes("/documents/")) {
      const pathname = new URL(s).pathname;
      const path = pathname.slice(pathname.lastIndexOf("/documents/") + "/documents/".length);

      // List collection
      if (!init || !init.method || init.method === "GET") {
        if (store.has(path)) {
          const doc = store.get(path);
          return new Response(JSON.stringify({ fields: encodeFields(doc) }), { status: 200 });
        }

        // Return list of matching documents in subcollection
        const matchingDocs = [];
        for (const [key, value] of store.entries()) {
          if (key.startsWith(path + "/")) {
            matchingDocs.push({
              name: `projects/${PROJECT}/databases/(default)/documents/${key}`,
              fields: encodeFields(value),
            });
          }
        }
        return new Response(JSON.stringify({ documents: matchingDocs }), { status: 200 });
      }

      // Create / Update document
      if (init && init.method === "PATCH") {
        const body = JSON.parse(init.body || "{}");
        const existing = store.get(path) || {};
        const decoded = {};
        for (const [f, v] of Object.entries(body.fields || {})) {
          decoded[f] = v.stringValue ?? v.integerValue ?? v.doubleValue ?? v.booleanValue ?? null;
        }
        store.set(path, { ...existing, ...decoded });
        return new Response(JSON.stringify({}), { status: 200 });
      }

      // Delete
      if (init && init.method === "DELETE") {
        store.delete(path);
        return new Response(JSON.stringify({}), { status: 200 });
      }
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

  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );

  return `${header}.${payload}.${b64url(sig)}`;
}

describe("Financial API Routes & Security", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const req = new Request("https://worker.local/financial/overview", {
      method: "GET",
      headers: { Origin: ORIGIN },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("rejects non-owner / non-financial admin with 403", async () => {
    const token = await mintToken({
      email: "staff@crp.com",
      admin: true, // Only regular admin, NOT owner or financials
      auth_time: Math.floor(Date.now() / 1000),
    });

    const req = new Request("https://worker.local/financial/overview", {
      method: "GET",
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("restricted to CRP financial owners");
  });

  it("rejects stale authentication (> 15 min old) with 401 REAUTH_REQUIRED", async () => {
    const staleTime = Math.floor(Date.now() / 1000) - 1200; // 20 minutes ago
    const token = await mintToken({
      email: "owner@crp.com",
      role: "owner",
      admin: true,
      auth_time: staleTime,
    });

    const req = new Request("https://worker.local/financial/overview", {
      method: "GET",
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("REAUTH_REQUIRED");
  });

  it("permits fresh owner authentication to GET /financial/overview", async () => {
    const freshTime = Math.floor(Date.now() / 1000) - 30;
    const token = await mintToken({
      email: "owner@crp.com",
      role: "owner",
      admin: true,
      auth_time: freshTime,
    });

    const req = new Request("https://worker.local/financial/overview", {
      method: "GET",
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.summary).toBeDefined();
    expect(body.kpis).toBeDefined();
    expect(body.charts).toBeDefined();
    expect(body.integrations).toBeDefined();
  });

  it("creates a financial transaction via POST /financial/transactions", async () => {
    const freshTime = Math.floor(Date.now() / 1000);
    const token = await mintToken({
      email: "owner@crp.com",
      role: "owner",
      admin: true,
      auth_time: freshTime,
    });

    const payload = {
      type: "revenue",
      description: "Custom CUBY Sale",
      amount: 450,
      currency: "ILS",
      category: "Hardware",
      status: "paid",
    };

    const req = new Request("https://worker.local/financial/transactions", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.transaction.amount).toBe(450);
    expect(body.transaction.amountILS).toBe(450);
    expect(body.transaction.category).toBe("Hardware");
  });

  it("creates and generates occurrences for recurring definitions", async () => {
    const freshTime = Math.floor(Date.now() / 1000);
    const token = await mintToken({
      email: "owner@crp.com",
      role: "owner",
      admin: true,
      auth_time: freshTime,
    });

    // 1. Create recurring rule
    const recPayload = {
      type: "expense",
      description: "Cloudflare Subscription",
      amount: 25,
      currency: "USD",
      exchangeRate: 3.65,
      frequency: "monthly",
      startDate: "2026-10-01",
      status: "active",
      category: "Infrastructure",
    };

    const createReq = new Request("https://worker.local/financial/recurring", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(recPayload),
    });

    const createRes = await worker.fetch(createReq, env);
    expect(createRes.status).toBe(201);

    // 2. Generate occurrences
    const genReq = new Request("https://worker.local/financial/recurring/generate", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    const genRes = await worker.fetch(genReq, env);
    expect(genRes.status).toBe(200);
    const genBody = await genRes.json();
    expect(genBody.ok).toBe(true);
    expect(genBody.generatedCount).toBeGreaterThanOrEqual(1);
  });

  it("processes valid Shopify webhooks and rejects invalid signatures", async () => {
    const orderData = {
      id: 9999,
      order_number: 9999,
      created_at: "2026-11-06T12:00:00Z",
      currency: "ILS",
      total_price: "350.00",
      financial_status: "PAID",
    };
    const rawBody = JSON.stringify(orderData);

    // 1. Invalid signature
    const invalidReq = new Request("https://worker.local/financial/shopify/webhook", {
      method: "POST",
      headers: {
        "X-Shopify-Hmac-Sha256": "invalid_hmac_header",
        "Content-Type": "application/json",
      },
      body: rawBody,
    });
    const invalidRes = await worker.fetch(invalidReq, env);
    expect(invalidRes.status).toBe(401);

    // 2. Valid signature
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(env.SHOPIFY_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
    const validHmac = btoa(String.fromCharCode(...new Uint8Array(sig)));

    const validReq = new Request("https://worker.local/financial/shopify/webhook", {
      method: "POST",
      headers: {
        "X-Shopify-Hmac-Sha256": validHmac,
        "Content-Type": "application/json",
      },
      body: rawBody,
    });
    const validRes = await worker.fetch(validReq, env);
    expect(validRes.status).toBe(200);
    const validBody = await validRes.json();
    expect(validBody.ok).toBe(true);
    expect(validBody.processedCount).toBe(1);
  });
});

