import { describe, it, expect, vi } from "vitest";
import {
  parseShopifyOrderToTransactions,
  verifyShopifyWebhookHmac,
  verifyShopifyOAuthHmac,
  verifyShopifyTimestamp,
  sanitizeShopDomain,
  buildShopifyAuthUrl,
  exchangeShopifyCodeForToken,
  refreshShopifyToken,
  getValidShopifyAccessToken,
  syncShopifyOrders,
} from "../src/shopify.js";

describe("Shopify Integration Engine", () => {
  it("parses a standard paid Shopify order to a revenue transaction", () => {
    const order = {
      id: "gid://shopify/Order/1001",
      name: "#1001",
      created_at: "2026-11-02T10:15:00Z",
      currency: "ILS",
      total_price: "250.00",
      financial_status: "PAID",
    };

    const transactions = parseShopifyOrderToTransactions(order);
    expect(transactions).toHaveLength(1);

    const tx = transactions[0];
    expect(tx.id).toBe("shopify_order_1001");
    expect(tx.type).toBe("revenue");
    expect(tx.amount).toBe(250);
    expect(tx.amountILS).toBe(250);
    expect(tx.currency).toBe("ILS");
    expect(tx.status).toBe("paid");
    expect(tx.source).toBe("shopify");
    expect(tx.transactionDate).toBe("2026-11-02");
  });

  it("handles foreign currency orders with currency conversion", () => {
    const order = {
      id: "1002",
      order_number: 1002,
      created_at: "2026-11-03T14:00:00Z",
      currency: "USD",
      total_price: "100.00",
      financial_status: "PAID",
    };

    // 100 USD at 3.65 = 365 ILS
    const transactions = parseShopifyOrderToTransactions(order, 3.65);
    expect(transactions[0].amount).toBe(100);
    expect(transactions[0].amountILS).toBe(365);
  });

  it("generates separate refund adjustment records for orders with refunds", () => {
    const order = {
      id: "1003",
      name: "#1003",
      created_at: "2026-10-15T12:00:00Z",
      currency: "ILS",
      total_price: "500.00",
      financial_status: "PARTIALLY_REFUNDED",
      refunds: [
        {
          id: "ref_901",
          created_at: "2026-10-20T16:00:00Z",
          total_refunded: 150,
        },
      ],
    };

    const transactions = parseShopifyOrderToTransactions(order);
    expect(transactions).toHaveLength(2);

    const orderTx = transactions[0];
    expect(orderTx.id).toBe("shopify_order_1003");
    expect(orderTx.amount).toBe(500);

    const refundTx = transactions[1];
    expect(refundTx.id).toBe("shopify_refund_ref_901");
    expect(refundTx.type).toBe("revenue");
    expect(refundTx.status).toBe("refunded");
    expect(refundTx.amount).toBe(150);
    expect(refundTx.transactionDate).toBe("2026-10-20");
  });

  it("marks cancelled orders with status 'cancelled'", () => {
    const order = {
      id: "1004",
      name: "#1004",
      created_at: "2026-11-01T08:00:00Z",
      currency: "ILS",
      total_price: "300.00",
      cancelled_at: "2026-11-01T09:00:00Z",
    };

    const transactions = parseShopifyOrderToTransactions(order);
    expect(transactions[0].status).toBe("cancelled");
  });

  it("verifies webhook HMAC signatures cryptographically", async () => {
    const secret = "test_webhook_secret_key_12345";
    const body = JSON.stringify({ id: 12345, note: "Test order" });

    // Generate valid HMAC using Web Crypto
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
    const validHmac = btoa(String.fromCharCode(...new Uint8Array(sig)));

    // Verify correct
    const isValid = await verifyShopifyWebhookHmac(body, validHmac, secret);
    expect(isValid).toBe(true);

    // Tampered body fails
    const isTamperedValid = await verifyShopifyWebhookHmac(body + "tamper", validHmac, secret);
    expect(isTamperedValid).toBe(false);

    // Wrong secret fails
    const isWrongSecretValid = await verifyShopifyWebhookHmac(body, validHmac, "wrong_secret");
    expect(isWrongSecretValid).toBe(false);
  });

  it("gracefully handles missing credentials in syncShopifyOrders", async () => {
    const result = await syncShopifyOrders({
      shopDomain: "",
      accessToken: "",
      store: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not configured");
  });

  describe("Shopify OAuth Helpers", () => {
    it("builds a correct authorization URL with grant_options[]=offline", () => {
      const urlStr = buildShopifyAuthUrl({
        shop: "crp-focus.myshopify.com",
        clientId: "test_client_id_123",
        redirectUri: "https://worker.local/financial/shopify/callback",
        state: "state_nonce_abc",
      });

      const url = new URL(urlStr);
      expect(url.hostname).toBe("crp-focus.myshopify.com");
      expect(url.pathname).toBe("/admin/oauth/authorize");
      expect(url.searchParams.get("client_id")).toBe("test_client_id_123");
      expect(url.searchParams.get("scope")).toBe("read_orders");
      expect(url.searchParams.get("redirect_uri")).toBe("https://worker.local/financial/shopify/callback");
      expect(url.searchParams.get("state")).toBe("state_nonce_abc");
      expect(url.searchParams.getAll("grant_options[]")).toContain("offline");
    });

    it("sanitizes and validates shop domains correctly", () => {
      expect(sanitizeShopDomain("crp-focus.myshopify.com")).toBe("crp-focus.myshopify.com");
      expect(sanitizeShopDomain("CRP-FOCUS.myshopify.com ")).toBe("crp-focus.myshopify.com");
      expect(sanitizeShopDomain("invalid-domain.com")).toBeNull();
      expect(sanitizeShopDomain("https://crp-focus.myshopify.com")).toBeNull();
      expect(sanitizeShopDomain("crp-focus.myshopify.com", "other-shop.myshopify.com")).toBeNull();
      expect(sanitizeShopDomain("crp-focus.myshopify.com", "crp-focus.myshopify.com")).toBe(
        "crp-focus.myshopify.com",
      );
    });

    it("validates timestamp freshness against clock skew", () => {
      const now = Math.floor(Date.now() / 1000);
      const freshParams = new URLSearchParams({ timestamp: String(now - 120) }); // 2 min ago
      expect(verifyShopifyTimestamp(freshParams, 600)).toBe(true);

      const staleParams = new URLSearchParams({ timestamp: String(now - 900) }); // 15 min ago
      expect(verifyShopifyTimestamp(staleParams, 600)).toBe(false);

      const invalidParams = new URLSearchParams({ timestamp: "not-a-number" });
      expect(verifyShopifyTimestamp(invalidParams, 600)).toBe(false);
    });

    it("verifies OAuth callback HMAC correctly and detects tampering", async () => {
      const secret = "secret_app_key_999";
      const params = new URLSearchParams({
        code: "oauth_auth_code_xyz",
        shop: "crp-focus.myshopify.com",
        state: "nonce_123",
        timestamp: "1740000000",
      });

      // Calculate HMAC over sorted params: code=...&shop=...&state=...&timestamp=...
      const message = "code=oauth_auth_code_xyz&shop=crp-focus.myshopify.com&state=nonce_123&timestamp=1740000000";
      const encoder = new TextEncoder();
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
      const hex = Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      params.set("hmac", hex);

      const isValid = await verifyShopifyOAuthHmac(params, secret);
      expect(isValid).toBe(true);

      // Wrong secret fails
      expect(await verifyShopifyOAuthHmac(params, "wrong_secret")).toBe(false);

      // Tampered code fails
      params.set("code", "tampered_code");
      expect(await verifyShopifyOAuthHmac(params, secret)).toBe(false);
    });

    it("exchanges authorization code for tokens with expiring=1", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: "shpua_test_access_token",
          scope: "read_orders,read_all_orders",
          expires_in: 3600,
          refresh_token: "shpr_test_refresh_token",
          refresh_token_expires_in: 7776000,
        }),
      });

      const res = await exchangeShopifyCodeForToken({
        shop: "crp-focus.myshopify.com",
        code: "auth_code_123",
        clientId: "client_id",
        clientSecret: "client_secret",
        fetchImpl: mockFetch,
      });

      expect(res.accessToken).toBe("shpua_test_access_token");
      expect(res.expiresIn).toBe(3600);
      expect(res.refreshToken).toBe("shpr_test_refresh_token");
      expect(res.refreshTokenExpiresIn).toBe(7776000);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://crp-focus.myshopify.com/admin/oauth/access_token");
      const sentBody = JSON.parse(init.body);
      expect(sentBody.expiring).toBe("1");
      expect(sentBody.code).toBe("auth_code_123");
    });

    it("refreshes expiring tokens and rotates refresh token", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: "shpua_new_refreshed_token",
          scope: "read_orders,read_all_orders",
          expires_in: 3600,
          refresh_token: "shpr_new_rotated_refresh_token",
          refresh_token_expires_in: 7776000,
        }),
      });

      const res = await refreshShopifyToken({
        shop: "crp-focus.myshopify.com",
        refreshToken: "shpr_old_refresh_token",
        clientId: "client_id",
        clientSecret: "client_secret",
        fetchImpl: mockFetch,
      });

      expect(res.accessToken).toBe("shpua_new_refreshed_token");
      expect(res.refreshToken).toBe("shpr_new_rotated_refresh_token");

      const [, init] = mockFetch.mock.calls[0];
      const sentBody = JSON.parse(init.body);
      expect(sentBody.grant_type).toBe("refresh_token");
      expect(sentBody.refresh_token).toBe("shpr_old_refresh_token");
    });

    it("retrieves valid token from Firestore and refreshes when expiring soon", async () => {
      const now = Date.now();
      const mockStore = {
        data: {
          "financials/shopify_integration": {
            accessToken: "shpua_old_token",
            expiresAt: now + 60_000, // expiring in 1 min (< 5 min threshold)
            refreshToken: "shpr_active_refresh",
            shopDomain: "crp-focus.myshopify.com",
          },
        },
        async getDocument(col, id) {
          return this.data[`${col}/${id}`] || null;
        },
        async updateDocument(col, id, patch) {
          this.data[`${col}/${id}`] = { ...this.data[`${col}/${id}`], ...patch };
          return true;
        },
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: "shpua_auto_refreshed_token",
          scope: "read_orders,read_all_orders",
          expires_in: 3600,
          refresh_token: "shpr_auto_rotated_refresh",
          refresh_token_expires_in: 7776000,
        }),
      });

      const tokenResult = await getValidShopifyAccessToken({
        store: mockStore,
        env: {
          SHOPIFY_CLIENT_ID: "cid",
          SHOPIFY_CLIENT_SECRET: "csec",
          SHOPIFY_STORE_DOMAIN: "crp-focus.myshopify.com",
        },
        fetchImpl: mockFetch,
      });

      expect(tokenResult.accessToken).toBe("shpua_auto_refreshed_token");
      expect(tokenResult.source).toBe("refreshed");
      expect(mockStore.data["financials/shopify_integration"].accessToken).toBe(
        "shpua_auto_refreshed_token",
      );
    });
  });
});

