import { describe, it, expect, vi, beforeEach } from "vitest";
import { webcrypto } from "node:crypto";
import { encodeFields, decodeFields } from "../src/firestore-rest.js";
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
  SHOPIFY_CLIENT_ID: "test_shopify_client_id_123",
  SHOPIFY_CLIENT_SECRET: "test_shopify_client_secret_xyz",
  SHOPIFY_STORE_DOMAIN: "crp-company.myshopify.com",
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

    // Shopify OAuth token exchange / refresh
    if (s.includes("/admin/oauth/access_token")) {
      return new Response(
        JSON.stringify({
          access_token: "shpua_mock_offline_token",
          scope: "read_orders,read_all_orders",
          expires_in: 3600,
          refresh_token: "shpr_mock_refresh_token",
          refresh_token_expires_in: 7776000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Shopify Admin GraphQL endpoint
    if (s.includes("/admin/api/2026-01/graphql.json")) {
      return new Response(
        JSON.stringify({
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Order/9901",
                    name: "#9901",
                    createdAt: "2026-11-20T10:00:00Z",
                    displayFinancialStatus: "PAID",
                    totalPriceSet: {
                      shopMoney: { amount: "350.00", currencyCode: "ILS" },
                    },
                  },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Firestore GET / PATCH / DELETE / list
    if (s.includes("/documents/")) {
      const pathname = new URL(s).pathname;
      const path = pathname.slice(pathname.lastIndexOf("/documents/") + "/documents/".length);

      // List collection or document GET
      if (!init || !init.method || init.method === "GET") {
        if (store.has(path)) {
          const doc = store.get(path);
          return new Response(JSON.stringify({ fields: encodeFields(doc) }), { status: 200 });
        }

        // Single document GET that is absent returns 404
        if (!new URL(s).searchParams.has("pageSize")) {
          return new Response(
            JSON.stringify({ error: { code: 404, message: "Not found" } }),
            { status: 404 },
          );
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
        const decoded = decodeFields(body.fields || {});
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

  it("permits updating exchange rate on foreign-currency transaction, recalculating amountILS and logging rateHistory", async () => {
    const freshTime = Math.floor(Date.now() / 1000);
    const token = await mintToken({
      email: "owner@crp.com",
      role: "owner",
      admin: true,
      auth_time: freshTime,
    });

    // Store a transaction with unconfirmed rate
    store.set("financials/transactions/tx_manual_usd", {
      id: "tx_manual_usd",
      type: "revenue",
      description: "Overseas Client Fee",
      amount: 100,
      currency: "USD",
      exchangeRate: null,
      amountILS: null,
      rateConfirmed: false,
      rateSource: "unconfirmed",
      source: "manual",
      status: "pending",
    });

    const req = new Request("https://worker.local/financial/transaction-update", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "tx_manual_usd",
        exchangeRate: 3.75,
        status: "paid",
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.patch.exchangeRate).toBe(3.75);
    expect(body.patch.amountILS).toBe(375);
    expect(body.patch.rateConfirmed).toBe(true);
    expect(body.patch.rateSource).toBe("explicit");
    expect(body.patch.rateHistory).toHaveLength(1);
    expect(body.patch.rateHistory[0].rate).toBe(3.75);
    expect(body.patch.rateHistory[0].previousRate).toBeNull();
    expect(body.patch.rateHistory[0].updatedBy).toBe("owner@crp.com");
  });

  it("rejects non-finite, zero, or negative exchange rates with 400", async () => {
    const freshTime = Math.floor(Date.now() / 1000);
    const token = await mintToken({
      email: "owner@crp.com",
      role: "owner",
      admin: true,
      auth_time: freshTime,
    });

    store.set("financials/transactions/tx_usd_val", {
      id: "tx_usd_val",
      amount: 50,
      currency: "USD",
      source: "manual",
    });

    for (const badRate of [0, -1.5, "invalid", NaN, Infinity]) {
      const req = new Request("https://worker.local/financial/transaction-update", {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: "tx_usd_val", exchangeRate: badRate }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Exchange rate must be a positive finite number");
    }
  });

  it("rejects manual exchange rate edits on Shopify settlement-verified transactions with 400", async () => {
    const freshTime = Math.floor(Date.now() / 1000);
    const token = await mintToken({
      email: "owner@crp.com",
      role: "owner",
      admin: true,
      auth_time: freshTime,
    });

    store.set("financials/transactions/shopify_order_settled", {
      id: "shopify_order_settled",
      amount: 100,
      currency: "USD",
      amountILS: 370,
      exchangeRate: 3.70,
      rateSource: "settlement",
      rateConfirmed: true,
      source: "shopify",
    });

    const req = new Request("https://worker.local/financial/transaction-update", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: "shopify_order_settled", exchangeRate: 4.0 }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Cannot manually override exchange rate on Shopify settlement-verified transactions");
  });

  it("rejects exchange rate edits != 1.0 on ILS base currency transactions with 400", async () => {
    const freshTime = Math.floor(Date.now() / 1000);
    const token = await mintToken({
      email: "owner@crp.com",
      role: "owner",
      admin: true,
      auth_time: freshTime,
    });

    store.set("financials/transactions/tx_ils_base", {
      id: "tx_ils_base",
      amount: 250,
      currency: "ILS",
      amountILS: 250,
      exchangeRate: 1.0,
      rateSource: "base_currency",
      source: "manual",
    });

    const req = new Request("https://worker.local/financial/transaction-update", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: "tx_ils_base", exchangeRate: 1.2 }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Exchange rate for ILS base currency must be 1.0");
  });

  it("rejects manual amount modifications on Shopify imported transactions with 400", async () => {
    const freshTime = Math.floor(Date.now() / 1000);
    const token = await mintToken({
      email: "owner@crp.com",
      role: "owner",
      admin: true,
      auth_time: freshTime,
    });

    store.set("financials/transactions/shopify_order_amt", {
      id: "shopify_order_amt",
      amount: 150,
      currency: "ILS",
      source: "shopify",
    });

    const req = new Request("https://worker.local/financial/transaction-update", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: "shopify_order_amt", amount: 200 }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Cannot manually change amount on Shopify imported transactions");
  });

  it("webhook ordering: ignores older out-of-order webhook events and preserves newer state", async () => {
    // 1. Existing order in Firestore that is already refunded at T2
    store.set("financials/transactions/shopify_order_8888", {
      id: "shopify_order_8888",
      orderId: "8888",
      amount: 500,
      currency: "ILS",
      amountILS: 500,
      status: "refunded",
      totalRefunded: 500,
      totalRefundedILS: 500,
      netAmount: 0,
      netAmountILS: 0,
      shopifyCreatedAt: "2026-11-01T10:00:00Z",
      shopifyUpdatedAt: "2026-11-05T15:00:00Z", // T2
      source: "shopify",
    });

    // 2. Out-of-order webhook arrives from T1 (older event, e.g. delayed orders/create)
    const olderWebhookPayload = {
      id: 8888,
      order_number: 8888,
      created_at: "2026-11-01T10:00:00Z",
      updated_at: "2026-11-02T12:00:00Z", // T1 < T2
      currency: "ILS",
      total_price: "500.00",
      financial_status: "PAID",
      refunds: [],
    };

    const rawBody = JSON.stringify(olderWebhookPayload);
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

    const req = new Request("https://worker.local/financial/shopify/webhook", {
      method: "POST",
      headers: {
        "X-Shopify-Hmac-Sha256": validHmac,
        "Content-Type": "application/json",
      },
      body: rawBody,
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    // Order document must NOT have been reverted to "paid" or had totalRefunded reset to 0!
    const saved = store.get("financials/transactions/shopify_order_8888");
    expect(saved.status).toBe("refunded");
    expect(saved.totalRefunded).toBe(500);
    expect(saved.netAmount).toBe(0);
    expect(saved.shopifyUpdatedAt).toBe("2026-11-05T15:00:00Z");
  });

  it("refund history: preserves totalRefunded when incoming webhook has incomplete/partial refund payload", async () => {
    // Existing partially refunded order with 200 ILS refunded
    store.set("financials/transactions/shopify_order_7777", {
      id: "shopify_order_7777",
      orderId: "7777",
      amount: 600,
      currency: "ILS",
      amountILS: 600,
      status: "partially_refunded",
      totalRefunded: 200,
      totalRefundedILS: 200,
      netAmount: 400,
      netAmountILS: 400,
      shopifyCreatedAt: "2026-11-01T10:00:00Z",
      shopifyUpdatedAt: "2026-11-03T10:00:00Z",
      source: "shopify",
    });

    // Incoming newer webhook has empty refunds array or fewer refunds
    const incomingWebhookPayload = {
      id: 7777,
      order_number: 7777,
      created_at: "2026-11-01T10:00:00Z",
      updated_at: "2026-11-04T12:00:00Z", // Newer timestamp
      currency: "ILS",
      total_price: "600.00",
      financial_status: "PAID", // Payload says PAID because refunds array was omitted
      refunds: [],
    };

    const rawBody = JSON.stringify(incomingWebhookPayload);
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

    const req = new Request("https://worker.local/financial/shopify/webhook", {
      method: "POST",
      headers: {
        "X-Shopify-Hmac-Sha256": validHmac,
        "Content-Type": "application/json",
      },
      body: rawBody,
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    const saved = store.get("financials/transactions/shopify_order_7777");
    // Reconciled totalRefunded must NOT be lowered to 0!
    expect(saved.totalRefunded).toBe(200);
    expect(saved.totalRefundedILS).toBe(200);
    expect(saved.status).toBe("partially_refunded");
    expect(saved.netAmount).toBe(400);
  });

  describe("Shopify OAuth Routes & Integration", () => {
    it("generates state nonce and returns authorize URL on GET /financial/shopify/auth", async () => {
      const freshTime = Math.floor(Date.now() / 1000);
      const token = await mintToken({
        email: "owner@crp.com",
        role: "owner",
        admin: true,
        auth_time: freshTime,
      });

      const req = new Request("https://worker.local/financial/shopify/auth", {
        method: "GET",
        headers: {
          Origin: ORIGIN,
          Authorization: `Bearer ${token}`,
        },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.state).toBeDefined();
      expect(body.authorizeUrl).toContain("client_id=test_shopify_client_id_123");
      expect(body.authorizeUrl).toContain(`state=${body.state}`);
      expect(body.authorizeUrl).toContain("crp-company.myshopify.com");

      // Verify state was saved to Firestore in financials/oauth_state_${state}
      const stateDoc = store.get(`financials/oauth_state_${body.state}`);
      expect(stateDoc).toBeDefined();
      expect(stateDoc.adminEmail).toBe("owner@crp.com");
      expect(stateDoc.shopDomain).toBe("crp-company.myshopify.com");
      expect(stateDoc.expiresAt).toBeGreaterThan(Date.now());
    });

    it("rejects non-financial admin on /financial/shopify/auth", async () => {
      const freshTime = Math.floor(Date.now() / 1000);
      const token = await mintToken({
        email: "staff@crp.com",
        admin: true, // regular admin, not owner or financials
        auth_time: freshTime,
      });

      const req = new Request("https://worker.local/financial/shopify/auth", {
        method: "GET",
        headers: {
          Origin: ORIGIN,
          Authorization: `Bearer ${token}`,
        },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(403);
    });

    it("completes OAuth callback, consumes state, and saves tokens in financials/shopify_integration", async () => {
      const stateNonce = "test_nonce_state_888";
      // Seed state document
      store.set(`financials/oauth_state_${stateNonce}`, {
        state: stateNonce,
        adminUid: "uid_owner",
        adminEmail: "owner@crp.com",
        shopDomain: "crp-company.myshopify.com",
        createdAt: Date.now(),
        expiresAt: Date.now() + 600_000,
      });

      const now = Math.floor(Date.now() / 1000);
      const searchParams = new URLSearchParams({
        code: "test_code_999",
        shop: "crp-company.myshopify.com",
        state: stateNonce,
        timestamp: String(now),
      });

      // Calculate valid HMAC
      const message = `code=test_code_999&shop=crp-company.myshopify.com&state=${stateNonce}&timestamp=${now}`;
      const encoder = new TextEncoder();
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(env.SHOPIFY_CLIENT_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
      const hex = Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      searchParams.set("hmac", hex);

      const callbackUrl = `https://worker.local/financial/shopify/callback?${searchParams.toString()}`;
      const req = new Request(callbackUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      // Verify state was consumed (deleted)
      expect(store.has(`financials/oauth_state_${stateNonce}`)).toBe(false);

      // Verify tokens are stored in canonical document financials/shopify_integration
      const integrationDoc = store.get("financials/shopify_integration");
      expect(integrationDoc).toBeDefined();
      expect(integrationDoc.connected).toBe(true);
      expect(integrationDoc.accessToken).toBe("shpua_mock_offline_token");
      expect(integrationDoc.refreshToken).toBe("shpr_mock_refresh_token");
      expect(integrationDoc.shopDomain).toBe("crp-company.myshopify.com");
      expect(integrationDoc.installedBy).toBe("owner@crp.com");
    });

    it("returns HTTP 302 redirect with Location to CRP Admin for normal browser requests", async () => {
      const stateNonce = "test_nonce_state_browser_302";
      store.set(`financials/oauth_state_${stateNonce}`, {
        state: stateNonce,
        adminUid: "uid_owner",
        adminEmail: "owner@crp.com",
        shopDomain: "crp-company.myshopify.com",
        createdAt: Date.now(),
        expiresAt: Date.now() + 600_000,
      });

      const now = Math.floor(Date.now() / 1000);
      const searchParams = new URLSearchParams({
        code: "test_code_302",
        shop: "crp-company.myshopify.com",
        state: stateNonce,
        timestamp: String(now),
      });

      const message = `code=test_code_302&shop=crp-company.myshopify.com&state=${stateNonce}&timestamp=${now}`;
      const encoder = new TextEncoder();
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(env.SHOPIFY_CLIENT_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
      const hex = Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      searchParams.set("hmac", hex);

      // Normal browser GET redirect (no Accept: application/json)
      const callbackUrl = `https://worker.local/financial/shopify/callback?${searchParams.toString()}`;
      const req = new Request(callbackUrl, {
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://crp-company.github.io/CRP-early-access/admin/?shopify=connected",
      );
      expect(res.headers.get("Cache-Control")).toBe("no-store");

      // Verify tokens were stored in Firestore
      const integrationDoc = store.get("financials/shopify_integration");
      expect(integrationDoc).toBeDefined();
      expect(integrationDoc.connected).toBe(true);
    });

    it("rejects replayed OAuth callback when state nonce is already consumed", async () => {
      const now = Math.floor(Date.now() / 1000);
      const searchParams = new URLSearchParams({
        code: "test_code_999",
        shop: "crp-company.myshopify.com",
        state: "already_consumed_nonce",
        timestamp: String(now),
      });

      const message = `code=test_code_999&shop=crp-company.myshopify.com&state=already_consumed_nonce&timestamp=${now}`;
      const encoder = new TextEncoder();
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(env.SHOPIFY_CLIENT_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
      const hex = Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      searchParams.set("hmac", hex);

      const req = new Request(
        `https://worker.local/financial/shopify/callback?${searchParams.toString()}`,
        { method: "GET" },
      );

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("Invalid or already consumed");
    });

    it("rejects OAuth callback with expired timestamp", async () => {
      const oldTime = Math.floor(Date.now() / 1000) - 1000; // >15 minutes ago
      const searchParams = new URLSearchParams({
        code: "test_code_999",
        shop: "crp-company.myshopify.com",
        state: "some_nonce",
        timestamp: String(oldTime),
        hmac: "mock_hmac",
      });

      const req = new Request(
        `https://worker.local/financial/shopify/callback?${searchParams.toString()}`,
        { method: "GET" },
      );

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("timestamp is expired or skewed");
    });

    it("rejects OAuth callback with invalid HMAC", async () => {
      const now = Math.floor(Date.now() / 1000);
      const searchParams = new URLSearchParams({
        code: "test_code_999",
        shop: "crp-company.myshopify.com",
        state: "some_nonce",
        timestamp: String(now),
        hmac: "0000000000000000000000000000000000000000000000000000000000000000",
      });

      const req = new Request(
        `https://worker.local/financial/shopify/callback?${searchParams.toString()}`,
        { method: "GET" },
      );

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("Invalid Shopify OAuth callback HMAC signature");
    });

    it("returns connection status on GET /financial/shopify/status without exposing secret tokens", async () => {
      const freshTime = Math.floor(Date.now() / 1000);
      const token = await mintToken({
        email: "owner@crp.com",
        role: "owner",
        admin: true,
        auth_time: freshTime,
      });

      store.set("financials/shopify_integration", {
        connected: true,
        shopDomain: "crp-company.myshopify.com",
        accessToken: "shpua_super_secret_access_token",
        refreshToken: "shpr_super_secret_refresh_token",
        scope: "read_orders,read_all_orders",
        syncStatus: "connected",
        lastSuccessfulSync: "2026-11-20T12:00:00Z",
      });

      const req = new Request("https://worker.local/financial/shopify/status", {
        method: "GET",
        headers: {
          Origin: ORIGIN,
          Authorization: `Bearer ${token}`,
        },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.connected).toBe(true);
      expect(body.shopDomain).toBe("crp-company.myshopify.com");
      expect(body.tokenType).toBe("expiring_offline");
      expect(body.lastSuccessfulSync).toBe("2026-11-20T12:00:00Z");

      // CRITICAL SECURITY ASSERTION: Secret tokens MUST NEVER be exposed!
      expect(body.accessToken).toBeUndefined();
      expect(body.refreshToken).toBeUndefined();
    });

    it("triggers sync on POST /financial/shopify/sync using stored token in Firestore", async () => {
      const freshTime = Math.floor(Date.now() / 1000);
      const token = await mintToken({
        email: "owner@crp.com",
        role: "owner",
        admin: true,
        auth_time: freshTime,
      });

      store.set("financials/shopify_integration", {
        connected: true,
        shopDomain: "crp-company.myshopify.com",
        accessToken: "shpua_mock_offline_token",
        refreshToken: "shpr_mock_refresh_token",
        expiresAt: Date.now() + 3600_000,
        syncStatus: "connected",
      });

      // Clear env token to prove sync uses stored token!
      const envWithoutStaticToken = { ...env, SHOPIFY_ACCESS_TOKEN: "" };

      const req = new Request("https://worker.local/financial/shopify/sync", {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          Authorization: `Bearer ${token}`,
        },
      });

      const res = await worker.fetch(req, envWithoutStaticToken);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.syncedOrders).toBe(1);

      // Verify synced order was stored in transactions
      const tx = store.get("financials/transactions/shopify_order_9901");
      expect(tx).toBeDefined();
      expect(tx.amount).toBe(350);
      expect(tx.status).toBe("paid");
    });
  });
});

