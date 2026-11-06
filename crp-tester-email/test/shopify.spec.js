import { describe, it, expect } from "vitest";
import {
  parseShopifyOrderToTransactions,
  verifyShopifyWebhookHmac,
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
});

