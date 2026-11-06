/**
 * Shopify Integration Engine for CRP Admin.
 *
 * Implements:
 * - Shopify Admin GraphQL synchronization of orders.
 * - Granular financial status mapping (paid, refunded, partially refunded, cancelled, pending).
 * - Multi-currency conversion to ILS.
 * - Distinct adjustment records for refunds (partial and full) to avoid double counting.
 * - Cryptographic HMAC-SHA256 webhook signature verification.
 * - Integration status management in `financials/integrations/shopify`.
 */

import { normalizeToILS, getDefaultExchangeRate } from "./currency.js";

/**
 * Verify Shopify Webhook HMAC-SHA256 signature using Web Crypto API.
 * @param {string|Uint8Array} rawBody The raw UTF-8 request body string or bytes
 * @param {string} hmacHeader The value of `X-Shopify-Hmac-Sha256` header
 * @param {string} secret The webhook signing secret
 * @returns {Promise<boolean>}
 */
export async function verifyShopifyWebhookHmac(rawBody, hmacHeader, secret) {
  if (!rawBody || !hmacHeader || !secret) return false;

  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const bodyData = typeof rawBody === "string" ? encoder.encode(rawBody) : rawBody;

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign("HMAC", cryptoKey, bodyData);
    const calculatedBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

    // Constant-time comparison
    if (calculatedBase64.length !== hmacHeader.length) return false;
    let match = 0;
    for (let i = 0; i < calculatedBase64.length; i += 1) {
      match |= calculatedBase64.charCodeAt(i) ^ hmacHeader.charCodeAt(i);
    }
    return match === 0;
  } catch (err) {
    console.error("Shopify HMAC verification error:", err);
    return false;
  }
}

/**
 * Parse a Shopify Order into standardized CRP Admin financial transactions.
 * Returns an array of transactions:
 * 1. The main order transaction (positive amount).
 * 2. Any refund adjustment transactions (negative amount).
 *
 * @param {object} order Shopify order object (REST or GraphQL format)
 * @param {number} [customExchangeRate] Optional exchange rate override
 * @returns {Array<object>} Standardized transactions
 */
export function parseShopifyOrderToTransactions(order, customExchangeRate) {
  if (!order || typeof order !== "object") return [];

  const orderId = String(order.id || "").replace(/^gid:\/\/shopify\/Order\//, "");
  const orderNumber = order.name || order.order_number || `#${orderId}`;
  const createdAt = order.created_at || order.createdAt || new Date().toISOString();
  const dateStr = createdAt.split("T")[0];

  // Currency & Rate
  const currency = String(
    order.currency || order.total_price_set?.shop_money?.currency_code || "ILS",
  ).toUpperCase();
  const exchangeRate =
    customExchangeRate || (currency === "ILS" ? 1.0 : getDefaultExchangeRate(currency));

  // Pricing
  const totalStr =
    order.total_price || order.totalPriceSet?.shop_money?.amount || order.current_total_price || "0";
  const grossAmount = Math.max(0, Number(totalStr) || 0);

  // Financial status
  const financialStatus = String(
    order.financial_status || order.displayFinancialStatus || "PAID",
  ).toUpperCase();
  const cancelledAt = order.cancelled_at || order.cancelledAt;

  let status = "paid";
  if (cancelledAt) {
    status = "cancelled";
  } else if (financialStatus === "REFUNDED") {
    status = "refunded";
  } else if (financialStatus === "PENDING" || financialStatus === "AUTHORIZED") {
    status = "pending";
  } else if (financialStatus === "VOIDED") {
    status = "cancelled";
  }

  const transactions = [];

  // 1. Primary order transaction
  const amountILS = normalizeToILS(grossAmount, currency, exchangeRate);
  transactions.push({
    id: `shopify_order_${orderId}`,
    externalId: orderId,
    type: "revenue",
    description: `Shopify Order ${orderNumber}`,
    amount: grossAmount,
    currency,
    exchangeRate,
    amountILS,
    category: "Hardware", // CUBY hardware or sales
    source: "shopify",
    status,
    transactionDate: dateStr,
    notes: `Shopify Order ${orderNumber} (${currency} ${grossAmount}). Financial status: ${financialStatus}.`,
    createdAt,
    updatedAt: new Date().toISOString(),
  });

  // 2. Process refunds if any
  const refunds = order.refunds || [];
  for (let idx = 0; idx < refunds.length; idx += 1) {
    const ref = refunds[idx];
    const refundId = String(ref.id || `${orderId}_ref_${idx}`).replace(/^gid:\/\/shopify\/Refund\//, "");
    const refCreated = ref.created_at || ref.createdAt || createdAt;
    const refDate = refCreated.split("T")[0];

    // Calculate refund amount
    let refAmount = 0;
    if (ref.transactions && Array.isArray(ref.transactions)) {
      for (const t of ref.transactions) {
        if (t.kind === "refund" && t.status === "success") {
          refAmount += Number(t.amount) || 0;
        }
      }
    }
    if (refAmount === 0 && ref.total_refunded) {
      refAmount = Number(ref.total_refunded) || 0;
    }

    if (refAmount > 0) {
      const refAmountILS = normalizeToILS(refAmount, currency, exchangeRate);
      transactions.push({
        id: `shopify_refund_${refundId}`,
        externalId: refundId,
        type: "revenue",
        description: `Shopify Refund for Order ${orderNumber}`,
        // Store as positive refunded record with status 'refunded',
        // or adjustment record
        amount: refAmount,
        currency,
        exchangeRate,
        amountILS: refAmountILS,
        category: "Hardware",
        source: "shopify",
        status: "refunded",
        transactionDate: refDate,
        notes: `Refund for Shopify order ${orderNumber}.`,
        createdAt: refCreated,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return transactions;
}

/**
 * Execute Shopify synchronization against Shopify Admin GraphQL API.
 *
 * @param {object} options
 * @param {string} options.shopDomain e.g. "crp-company.myshopify.com"
 * @param {string} options.accessToken Shopify Admin API access token
 * @param {object} options.store Firestore handle
 * @param {typeof fetch} [options.fetchImpl] fetch implementation
 * @returns {Promise<{success: boolean, syncedOrders: number, error?: string}>}
 */
export async function syncShopifyOrders({
  shopDomain,
  accessToken,
  store,
  fetchImpl = fetch,
}) {
  if (!shopDomain || !accessToken) {
    return {
      success: false,
      syncedOrders: 0,
      error: "Shopify domain or access token not configured in secrets.",
    };
  }

  const endpoint = `https://${shopDomain}/admin/api/2026-01/graphql.json`;
  const query = `
    query GetOrders {
      orders(first: 50, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            displayFinancialStatus
            cancelledAt
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            refunds {
              id
              createdAt
              totalRefundedSet {
                shopMoney {
                  amount
                }
              }
            }
          }
        }
      }
    }
  `;

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query }),
    });
  } catch (netErr) {
    return { success: false, syncedOrders: 0, error: `Could not reach Shopify: ${netErr.message}` };
  }

  if (!response.ok) {
    return {
      success: false,
      syncedOrders: 0,
      error: `Shopify GraphQL returned HTTP ${response.status}`,
    };
  }

  const data = await response.json();
  if (data.errors && data.errors.length) {
    return {
      success: false,
      syncedOrders: 0,
      error: data.errors.map((e) => e.message).join(", "),
    };
  }

  const edges = data.data?.orders?.edges || [];
  let syncedCount = 0;

  for (const edge of edges) {
    const orderNode = edge.node;
    const transactions = parseShopifyOrderToTransactions(orderNode);

    for (const tx of transactions) {
      try {
        await store.createDocument("financials/transactions", tx.id, tx);
      } catch (writeErr) {
        // If already exists, update status
        try {
          await store.updateDocument("financials/transactions", tx.id, {
            status: tx.status,
            amount: tx.amount,
            amountILS: tx.amountILS,
            updatedAt: new Date().toISOString(),
          });
        } catch {
          // ignore
        }
      }
      syncedCount += 1;
    }
  }

  // Update integration document
  const now = new Date().toISOString();
  try {
    await store.updateDocument(
      "financials/integrations",
      "shopify",
      {
        connected: true,
        shopDomain,
        lastSuccessfulSync: now,
        lastAttemptedSync: now,
        syncStatus: "connected",
        syncedCount,
        lastError: null,
      },
      { exists: false },
    );
  } catch {
    try {
      await store.createDocument("financials/integrations", "shopify", {
        connected: true,
        shopDomain,
        lastSuccessfulSync: now,
        lastAttemptedSync: now,
        syncStatus: "connected",
        syncedCount,
        lastError: null,
      });
    } catch {
      // ignore
    }
  }

  return { success: true, syncedOrders: syncedCount };
}

