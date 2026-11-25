/**
 * Shopify Integration Engine for CRP Admin.
 *
 * Implements:
 * - Shopify Admin GraphQL synchronization of orders.
 * - Granular financial status mapping (paid, refunded, partially refunded, cancelled, pending).
 * - Multi-currency conversion safety:
 *     - Inspects Shopify settlement conversion (shopMoney in ILS) when available.
 *     - Never silently converts foreign currencies using hardcoded fallback rates.
 *     - Marks foreign orders without confirmed rates as unconfirmed and pending.
 * - Distinct adjustment records for refunds (partial and full) to avoid double counting.
 *     - Links every refund directly to its parent order (orderId, parentTransactionId).
 *     - Computes and stores originalGrossAmount, totalRefunded, and netAmount.
 * - Cryptographic HMAC-SHA256 webhook signature verification.
 * - Shopify OAuth Authorization Code Grant flow:
 *     - HMAC verification and timestamp freshness validation for OAuth callback.
 *     - Exchange authorization code for offline access token (with expiring=1 support).
 *     - Token refresh rotation with isolate concurrency mutex.
 *     - Secure token resolution for financial sync.
 * - Integration status management in `financials/shopify_integration`.
 */

import { normalizeToILS, getDefaultExchangeRate, inspectCurrencySafety } from "./currency.js";

export const DEFAULT_SHOPIFY_SCOPES = "read_orders";
export const DEFAULT_CALLBACK_URL =
  "https://crp-tester-email.atronamir5.workers.dev/financial/shopify/callback";

/**
 * Build the Shopify OAuth Authorization URL.
 *
 * @param {object} params
 * @param {string} params.shop Sanitized Shopify store domain (e.g. crp-focus.myshopify.com)
 * @param {string} params.clientId Shopify App Client ID
 * @param {string} [params.redirectUri] Registered callback URL
 * @param {string} params.state Cryptographic nonce
 * @param {string} [params.scopes] Comma-separated scopes
 * @returns {string} Fully qualified Shopify authorization URL
 */
export function buildShopifyAuthUrl({
  shop,
  clientId,
  redirectUri = DEFAULT_CALLBACK_URL,
  state,
  scopes = DEFAULT_SHOPIFY_SCOPES,
}) {
  if (!shop || !clientId || !state) {
    throw new Error("shop, clientId, and state are required to build Shopify auth URL");
  }

  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.append("grant_options[]", "offline");

  return url.toString();
}

/**
 * Sanitize and validate a Shopify shop domain.
 * Ensures the format is {shop}.myshopify.com and optionally checks against an authorized domain.
 *
 * @param {string} shop
 * @param {string} [allowedDomain]
 * @returns {string|null} Sanitized domain, or null if invalid
 */
export function sanitizeShopDomain(shop, allowedDomain) {
  if (!shop || typeof shop !== "string") return null;
  const clean = shop.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9\-]*\.myshopify\.com$/.test(clean)) {
    return null;
  }
  if (allowedDomain) {
    const expected = allowedDomain.trim().toLowerCase();
    if (clean !== expected) {
      return null;
    }
  }
  return clean;
}

/**
 * Verify Shopify OAuth callback timestamp freshness.
 * Protects against replay attacks by rejecting timestamps outside maxSkewSeconds.
 *
 * @param {URLSearchParams|string|object} query
 * @param {number} [maxSkewSeconds=600] Maximum allowed clock skew in seconds (default 10 min)
 * @returns {boolean}
 */
export function verifyShopifyTimestamp(query, maxSkewSeconds = 600) {
  if (!query) return false;
  let searchParams;
  if (typeof query === "string") {
    searchParams = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  } else if (query instanceof URLSearchParams) {
    searchParams = query;
  } else if (typeof query === "object") {
    searchParams = new URLSearchParams(query);
  } else {
    return false;
  }

  const tsStr = searchParams.get("timestamp");
  if (!tsStr) return false;
  const timestamp = parseInt(tsStr, 10);
  if (Number.isNaN(timestamp) || timestamp <= 0) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  return Math.abs(nowSeconds - timestamp) <= maxSkewSeconds;
}

/**
 * Verify Shopify OAuth callback HMAC signature using Web Crypto API.
 * Shopify calculates HMAC-SHA256 across all query parameters except hmac and signature,
 * sorted lexicographically by key, formatted as key=value separated by &.
 *
 * @param {URLSearchParams|string|object} query
 * @param {string} clientSecret
 * @returns {Promise<boolean>}
 */
export async function verifyShopifyOAuthHmac(query, clientSecret) {
  if (!query || !clientSecret) return false;

  let searchParams;
  if (typeof query === "string") {
    searchParams = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  } else if (query instanceof URLSearchParams) {
    searchParams = query;
  } else if (typeof query === "object") {
    searchParams = new URLSearchParams(query);
  } else {
    return false;
  }

  const providedHmac = searchParams.get("hmac");
  if (!providedHmac) return false;

  // Collect and sort all keys except 'hmac' and 'signature'
  const keys = [];
  for (const key of searchParams.keys()) {
    if (key !== "hmac" && key !== "signature") {
      keys.push(key);
    }
  }
  keys.sort();

  // Construct message: key1=val1&key2=val2...
  const message = keys.map((k) => `${k}=${searchParams.get(k)}`).join("&");

  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(clientSecret);
    const msgData = encoder.encode(message);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
    const calculatedHex = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Constant-time comparison
    const a = calculatedHex.toLowerCase();
    const b = providedHmac.toLowerCase().trim();
    if (a.length !== b.length) return false;

    let match = 0;
    for (let i = 0; i < a.length; i += 1) {
      match |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return match === 0;
  } catch (err) {
    console.error("Shopify OAuth HMAC verification error:", err);
    return false;
  }
}

/**
 * Exchange Shopify OAuth authorization code for an offline access token.
 * Passes expiring=1 to support expiring offline tokens with a refresh token.
 *
 * @param {object} params
 * @param {string} params.shop
 * @param {string} params.code
 * @param {string} params.clientId
 * @param {string} params.clientSecret
 * @param {Function} [params.fetchImpl]
 * @returns {Promise<{accessToken: string, scope: string, expiresIn: number|null, refreshToken: string|null, refreshTokenExpiresIn: number|null}>}
 */
export async function exchangeShopifyCodeForToken({
  shop,
  code,
  clientId,
  clientSecret,
  fetchImpl = fetch,
}) {
  if (!shop || !code || !clientId || !clientSecret) {
    throw new Error("Missing required parameters for Shopify token exchange.");
  }

  const endpoint = `https://${shop}/admin/oauth/access_token`;
  const body = {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    expiring: "1",
  };

  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Shopify token exchange failed (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Shopify token exchange response missing access_token");
  }

  return {
    accessToken: data.access_token,
    scope: data.scope || "",
    expiresIn: data.expires_in != null ? Number(data.expires_in) : null,
    refreshToken: data.refresh_token || null,
    refreshTokenExpiresIn:
      data.refresh_token_expires_in != null ? Number(data.refresh_token_expires_in) : null,
  };
}

/**
 * Refresh an expiring Shopify access token using its refresh token.
 *
 * @param {object} params
 * @param {string} params.shop
 * @param {string} params.refreshToken
 * @param {string} params.clientId
 * @param {string} params.clientSecret
 * @param {Function} [params.fetchImpl]
 * @returns {Promise<{accessToken: string, scope: string, expiresIn: number|null, refreshToken: string|null, refreshTokenExpiresIn: number|null}>}
 */
export async function refreshShopifyToken({
  shop,
  refreshToken,
  clientId,
  clientSecret,
  fetchImpl = fetch,
}) {
  if (!shop || !refreshToken || !clientId || !clientSecret) {
    throw new Error("Missing required parameters for Shopify token refresh.");
  }

  const endpoint = `https://${shop}/admin/oauth/access_token`;
  const body = {
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  };

  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Shopify token refresh failed (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Shopify token refresh response missing access_token");
  }

  return {
    accessToken: data.access_token,
    scope: data.scope || "",
    expiresIn: data.expires_in != null ? Number(data.expires_in) : null,
    refreshToken: data.refresh_token || null,
    refreshTokenExpiresIn:
      data.refresh_token_expires_in != null ? Number(data.refresh_token_expires_in) : null,
  };
}

// In-memory single-isolate concurrency mutex
let inFlightTokenPromise = null;

/**
 * Retrieve a valid Shopify access token.
 * Checks stored credentials in Firestore (financials/shopify_integration).
 * Automatically refreshes expiring tokens with cross-request mutex protection.
 * Falls back to env.SHOPIFY_ACCESS_TOKEN if configured.
 *
 * @param {object} params
 * @param {object} params.store Firestore handle
 * @param {object} params.env Worker environment bindings
 * @param {Function} [params.fetchImpl]
 * @param {boolean} [params.forceRefresh=false]
 * @returns {Promise<{accessToken: string, shopDomain: string, source: string, doc?: object}>}
 */
export async function getValidShopifyAccessToken({
  store,
  env,
  fetchImpl = fetch,
  forceRefresh = false,
}) {
  // 1. Check canonical Firestore document: financials/shopify_integration (2 segments)
  let doc = null;
  if (store && typeof store.getDocument === "function") {
    try {
      doc = await store.getDocument("financials", "shopify_integration");
    } catch {
      // ignore
    }
    if (!doc) {
      // Legacy fallback
      try {
        doc = await store.getDocument("financials/integrations", "shopify");
      } catch {
        // ignore
      }
    }
  }

  const shopDomain =
    doc?.shopDomain || env?.SHOPIFY_STORE_DOMAIN || env?.SHOPIFY_SHOP_DOMAIN;

  // 2. If no stored token, fall back to environment variable
  if (!doc?.accessToken) {
    if (env?.SHOPIFY_ACCESS_TOKEN && shopDomain) {
      return {
        accessToken: env.SHOPIFY_ACCESS_TOKEN,
        shopDomain,
        source: "env",
      };
    }
    throw new Error(
      "Shopify is not connected. No access token found in database or environment.",
    );
  }

  const now = Date.now();
  const isExpiringSoon = doc.expiresAt && doc.expiresAt - now < 300_000; // 5 min safety threshold

  // 3. If token is permanent or still fresh and not forced to refresh:
  if (!forceRefresh && (!doc.expiresAt || !isExpiringSoon)) {
    return {
      accessToken: doc.accessToken,
      shopDomain,
      source: "firestore",
      doc,
    };
  }

  // 4. Token has no refresh token (permanent token)
  if (!doc.refreshToken) {
    return {
      accessToken: doc.accessToken,
      shopDomain,
      source: "firestore",
      doc,
    };
  }

  // 5. Must refresh token
  const clientId = env?.SHOPIFY_CLIENT_ID;
  const clientSecret = env?.SHOPIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    // If credentials missing but current token is still valid right now, return it
    if (doc.expiresAt && doc.expiresAt > now) {
      return { accessToken: doc.accessToken, shopDomain, source: "firestore", doc };
    }
    throw new Error(
      "SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET not configured to refresh Shopify token.",
    );
  }

  // Mutex for in-flight refresh within this isolate
  if (inFlightTokenPromise) {
    return await inFlightTokenPromise;
  }

  inFlightTokenPromise = (async () => {
    try {
      // Re-read Firestore to check if another isolate already refreshed it
      if (store && typeof store.getDocument === "function") {
        try {
          const freshDoc = await store.getDocument("financials", "shopify_integration");
          if (freshDoc?.expiresAt && freshDoc.expiresAt - Date.now() > 300_000) {
            return {
              accessToken: freshDoc.accessToken,
              shopDomain: freshDoc.shopDomain || shopDomain,
              source: "firestore",
              doc: freshDoc,
            };
          }
        } catch {
          // proceed
        }
      }

      const refreshed = await refreshShopifyToken({
        shop: shopDomain,
        refreshToken: doc.refreshToken,
        clientId,
        clientSecret,
        fetchImpl,
      });

      const updatedFields = {
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresIn ? Date.now() + (refreshed.expiresIn - 300) * 1000 : null,
        updatedAt: new Date().toISOString(),
      };

      if (refreshed.refreshToken) {
        updatedFields.refreshToken = refreshed.refreshToken;
        if (refreshed.refreshTokenExpiresIn) {
          updatedFields.refreshTokenExpiresAt =
            Date.now() + (refreshed.refreshTokenExpiresIn - 86400) * 1000;
        }
      }

      if (store && typeof store.updateDocument === "function") {
        try {
          await store.updateDocument("financials", "shopify_integration", updatedFields);
        } catch {
          // ignore write errors if document update fails
        }
      }

      return {
        accessToken: refreshed.accessToken,
        shopDomain,
        source: "refreshed",
        doc: { ...doc, ...updatedFields },
      };
    } finally {
      inFlightTokenPromise = null;
    }
  })();

  return await inFlightTokenPromise;
}

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
 * 2. Any refund adjustment transactions (associated with original order).
 *
 * @param {object} order Shopify order object (REST or GraphQL format)
 * @param {number} [customExchangeRate] Optional explicitly confirmed exchange rate override
 * @returns {Array<object>} Standardized transactions
 */
export function parseShopifyOrderToTransactions(order, customExchangeRate) {
  if (!order || typeof order !== "object") return [];

  const orderId = String(order.id || "").replace(/^gid:\/\/shopify\/Order\//, "");
  const orderNumber = order.name || order.order_number || `#${orderId}`;
  const shopifyCreatedAt = order.created_at || order.createdAt || new Date().toISOString();
  const shopifyUpdatedAt = order.updated_at || order.updatedAt || shopifyCreatedAt;
  const createdAt = shopifyCreatedAt;
  const dateStr = createdAt.split("T")[0];

  // 1. Currency & Settlement Conversion Inspection
  const presentmentCurrency = String(
    order.currency ||
    order.presentment_currency ||
    order.totalPriceSet?.presentmentMoney?.currencyCode ||
    order.total_price_set?.presentment_money?.currency_code ||
    "ILS",
  ).toUpperCase().trim();

  const shopCurrency = String(
    order.totalPriceSet?.shopMoney?.currencyCode ||
    order.total_price_set?.shop_money?.currency_code ||
    "",
  ).toUpperCase().trim();

  const shopMoneyAmountStr =
    order.totalPriceSet?.shopMoney?.amount ||
    order.total_price_set?.shop_money?.amount;

  // Extract original presentment gross amount.
  // CRITICAL: Prioritize presentmentMoney or total_price/current_total_price.
  // NEVER fall back to shopMoney.amount if presentment currency differs!
  let presentmentAmountStr =
    order.totalPriceSet?.presentmentMoney?.amount ||
    order.total_price_set?.presentment_money?.amount ||
    order.total_price ||
    order.current_total_price;

  if (presentmentAmountStr == null && (presentmentCurrency === shopCurrency || !shopCurrency) && shopMoneyAmountStr != null) {
    presentmentAmountStr = shopMoneyAmountStr;
  }
  const grossAmount = Math.max(0, Number(presentmentAmountStr) || 0);

  const settlementAmount = shopMoneyAmountStr != null ? Math.max(0, Number(shopMoneyAmountStr) || 0) : null;
  const settlementCurrency = shopCurrency || null;

  let currency = presentmentCurrency;
  let exchangeRate = null;
  let amountILS = null;
  let rateSource = "unconfirmed";
  let rateConfirmed = false;

  // Case A: ILS Base Currency
  if (presentmentCurrency === "ILS") {
    currency = "ILS";
    exchangeRate = 1.0;
    amountILS = Math.round((grossAmount + Number.EPSILON) * 100) / 100;
    rateSource = "base_currency";
    rateConfirmed = true;
  }
  // Case B: Shopify provides verified shop_money settlement in ILS
  else if (shopCurrency === "ILS" && settlementAmount != null && settlementAmount > 0) {
    currency = presentmentCurrency;
    amountILS = Math.round((settlementAmount + Number.EPSILON) * 100) / 100;
    exchangeRate = grossAmount > 0
      ? Math.round(((amountILS / grossAmount) + Number.EPSILON) * 10000) / 10000
      : 1.0;
    rateSource = "settlement";
    rateConfirmed = true;
  }
  // Case C: Explicit custom confirmed rate supplied
  else if (Number(customExchangeRate) > 0) {
    currency = presentmentCurrency;
    exchangeRate = Number(customExchangeRate);
    amountILS = Math.round((grossAmount * exchangeRate + Number.EPSILON) * 100) / 100;
    rateSource = "explicit";
    rateConfirmed = true;
  }
  // Case D: Foreign currency with NO reliable settlement or confirmed rate
  else {
    currency = presentmentCurrency;
    exchangeRate = null;
    amountILS = null;
    rateSource = "unconfirmed";
    rateConfirmed = false;
  }

  // 2. Process Refunds if any
  const refunds = order.refunds || [];
  let totalRefundedAmount = 0;
  let totalRefundedILS = 0;
  const refundTransactions = [];

  for (let idx = 0; idx < refunds.length; idx += 1) {
    const ref = refunds[idx];
    const refundId = String(ref.id || `${orderId}_ref_${idx}`).replace(/^gid:\/\/shopify\/Refund\//, "");
    const refCreated = ref.created_at || ref.createdAt || createdAt;
    const refUpdated = ref.updated_at || ref.updatedAt || refCreated;
    const refDate = refCreated.split("T")[0];

    // Determine refund currencies and amounts
    const refPresentmentCurrency = String(
      ref.totalRefundedSet?.presentmentMoney?.currencyCode ||
      ref.total_refunded_set?.presentment_money?.currency_code ||
      (ref.transactions && ref.transactions[0]?.currency) ||
      currency,
    ).toUpperCase().trim();

    const refShopCurrency = String(
      ref.totalRefundedSet?.shopMoney?.currencyCode ||
      ref.total_refunded_set?.shop_money?.currency_code ||
      shopCurrency ||
      "",
    ).toUpperCase().trim();

    const refPresentmentSetAmount =
      ref.totalRefundedSet?.presentmentMoney?.amount ||
      ref.total_refunded_set?.presentment_money?.amount;

    const refShopMoneySet =
      ref.totalRefundedSet?.shopMoney?.amount ||
      ref.total_refunded_set?.shop_money?.amount;

    let refAmount = 0;
    if (refPresentmentSetAmount != null) {
      refAmount = Number(refPresentmentSetAmount) || 0;
    } else if (ref.transactions && Array.isArray(ref.transactions) && ref.transactions.length > 0) {
      for (const t of ref.transactions) {
        if (t.kind === "refund" && (t.status === "success" || !t.status)) {
          refAmount += Number(t.amount) || 0;
        }
      }
    } else if (ref.total_refunded != null) {
      refAmount = Number(ref.total_refunded) || 0;
    } else if (refPresentmentCurrency === refShopCurrency && refShopMoneySet != null) {
      // ONLY use shopMoney amount if currencies are identical
      refAmount = Number(refShopMoneySet) || 0;
    }

    const refSettlementAmount = refShopMoneySet != null ? Number(refShopMoneySet) || 0 : null;
    const refSettlementCurrency = refShopCurrency || null;

    if (refAmount > 0) {
      totalRefundedAmount += refAmount;

      let refAmountILS = null;
      let refRateSource = "unconfirmed";
      let refRateConfirmed = false;
      let refExchangeRate = null;

      if (refPresentmentCurrency === "ILS") {
        refAmountILS = Math.round((refAmount + Number.EPSILON) * 100) / 100;
        refRateSource = "base_currency";
        refRateConfirmed = true;
        refExchangeRate = 1.0;
      } else if (refSettlementCurrency === "ILS" && refSettlementAmount != null && refSettlementAmount > 0) {
        refAmountILS = Math.round((refSettlementAmount + Number.EPSILON) * 100) / 100;
        refRateSource = "settlement";
        refRateConfirmed = true;
        refExchangeRate = refAmount > 0
          ? Math.round(((refAmountILS / refAmount) + Number.EPSILON) * 10000) / 10000
          : 1.0;
      } else if (rateConfirmed && exchangeRate > 0) {
        refAmountILS = Math.round((refAmount * exchangeRate + Number.EPSILON) * 100) / 100;
        refRateSource = rateSource;
        refRateConfirmed = true;
        refExchangeRate = exchangeRate;
      }

      if (refAmountILS != null) {
        totalRefundedILS += refAmountILS;
      }

      refundTransactions.push({
        id: `shopify_refund_${refundId}`,
        externalId: refundId,
        orderId: orderId, // strictly associated with parent order
        parentTransactionId: `shopify_order_${orderId}`,
        type: "revenue",
        isRefund: true, // explicit refund adjustment flag
        description: `Shopify Refund for Order ${orderNumber}`,
        amount: Math.round((refAmount + Number.EPSILON) * 100) / 100,
        currency: refPresentmentCurrency,
        settlementAmount: refSettlementAmount,
        settlementCurrency: refSettlementCurrency,
        exchangeRate: refExchangeRate,
        rateSource: refRateSource,
        rateConfirmed: refRateConfirmed,
        amountILS: refAmountILS,
        category: "Hardware",
        source: "shopify",
        status: "refunded",
        transactionDate: refDate,
        notes: `Refund for Shopify order ${orderNumber}.`,
        createdAt: refCreated,
        updatedAt: new Date().toISOString(),
        shopifyCreatedAt: refCreated,
        shopifyUpdatedAt: refUpdated,
      });
    }
  }

  // 3. Determine Financial Status
  const financialStatus = String(
    order.financial_status || order.displayFinancialStatus || "PAID",
  ).toUpperCase();
  const cancelledAt = order.cancelled_at || order.cancelledAt;

  let status = "paid";
  if (cancelledAt || financialStatus === "VOIDED") {
    status = "cancelled";
  } else if (!rateConfirmed) {
    status = "pending"; // Cannot finalize without confirmed exchange rate
  } else if (financialStatus === "PENDING" || financialStatus === "AUTHORIZED") {
    status = "pending";
  } else if (financialStatus === "REFUNDED" || (grossAmount > 0 && totalRefundedAmount >= grossAmount)) {
    status = "refunded";
  } else if (financialStatus === "PARTIALLY_REFUNDED" || totalRefundedAmount > 0) {
    status = "partially_refunded";
  }

  // If fully refunded, netAmount and netAmountILS must be exactly zero
  const isFullyRefunded = status === "refunded" || (grossAmount > 0 && totalRefundedAmount >= grossAmount);

  const netAmount = isFullyRefunded
    ? 0
    : Math.max(0, Math.round((grossAmount - totalRefundedAmount + Number.EPSILON) * 100) / 100);

  const netAmountILS = isFullyRefunded
    ? 0
    : (amountILS != null
      ? Math.max(0, Math.round((amountILS - totalRefundedILS + Number.EPSILON) * 100) / 100)
      : null);

  const notes = !rateConfirmed
    ? `Shopify Order ${orderNumber} (${currency} ${grossAmount}). Requires confirmed exchange rate before finalizing ILS revenue.`
    : `Shopify Order ${orderNumber} (${currency} ${grossAmount}). Financial status: ${financialStatus}.`;

  // 4. Primary Order Transaction
  const orderTx = {
    id: `shopify_order_${orderId}`,
    externalId: orderId,
    orderId,
    type: "revenue",
    isRefund: false,
    description: `Shopify Order ${orderNumber}`,
    amount: grossAmount,
    originalGrossAmount: grossAmount,
    currency,
    settlementAmount,
    settlementCurrency,
    exchangeRate,
    rateSource,
    rateConfirmed,
    amountILS,
    originalGrossAmountILS: amountILS,
    totalRefunded: Math.round((totalRefundedAmount + Number.EPSILON) * 100) / 100,
    totalRefundedILS: Math.round((totalRefundedILS + Number.EPSILON) * 100) / 100,
    netAmount,
    netAmountILS,
    category: "Hardware",
    source: "shopify",
    status,
    transactionDate: dateStr,
    notes,
    createdAt,
    updatedAt: new Date().toISOString(),
    shopifyCreatedAt,
    shopifyUpdatedAt,
  };

  return [orderTx, ...refundTransactions];
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
            updatedAt
            displayFinancialStatus
            cancelledAt
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
              presentmentMoney {
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
                  currencyCode
                }
                presentmentMoney {
                  amount
                  currencyCode
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
      let existing = null;
      try {
        existing = await store.getDocument("financials/transactions", tx.id);
      } catch {
        // proceed
      }

      if (!existing) {
        try {
          await store.createDocument("financials/transactions", tx.id, tx);
        } catch {
          // ignore
        }
      } else {
        const incomingTime = new Date(tx.shopifyUpdatedAt || tx.updatedAt || 0).getTime();
        const existingTime = new Date(existing.shopifyUpdatedAt || existing.updatedAt || 0).getTime();
        if (incomingTime > 0 && existingTime > 0 && incomingTime < existingTime) {
          syncedCount += 1;
          continue; // Skip stale sync records
        }

        const preserveManualRate = existing.rateSource === "explicit" && existing.rateConfirmed && tx.rateSource !== "settlement";
        const reconciledTotalRefunded = Math.max(Number(existing.totalRefunded) || 0, Number(tx.totalRefunded) || 0);
        const reconciledTotalRefundedILS = Math.max(Number(existing.totalRefundedILS) || 0, Number(tx.totalRefundedILS) || 0);
        const gross = Number(tx.amount) || Number(existing.amount) || 0;
        const grossILS = tx.amountILS != null ? tx.amountILS : existing.amountILS;

        let reconciledStatus = tx.status;
        if (existing.status === "refunded" && (gross > 0 && reconciledTotalRefunded >= gross)) {
          reconciledStatus = "refunded";
        } else if (reconciledTotalRefunded >= gross && gross > 0) {
          reconciledStatus = "refunded";
        } else if (reconciledTotalRefunded > 0) {
          if (tx.status === "paid" || existing.status === "partially_refunded" || existing.status === "refunded") {
            reconciledStatus = "partially_refunded";
          }
        }

        const reconciledNetAmount = (reconciledStatus === "refunded" || (gross > 0 && reconciledTotalRefunded >= gross))
          ? 0
          : Math.max(0, Math.round((gross - reconciledTotalRefunded + Number.EPSILON) * 100) / 100);

        const reconciledNetAmountILS = (reconciledStatus === "refunded" || (gross > 0 && reconciledTotalRefunded >= gross))
          ? 0
          : (grossILS != null
            ? Math.max(0, Math.round((grossILS - reconciledTotalRefundedILS + Number.EPSILON) * 100) / 100)
            : null);

        try {
          await store.updateDocument("financials/transactions", tx.id, {
            status: reconciledStatus,
            amount: gross,
            amountILS: preserveManualRate ? existing.amountILS : (tx.amountILS ?? existing.amountILS),
            exchangeRate: preserveManualRate ? existing.exchangeRate : (tx.exchangeRate ?? existing.exchangeRate),
            rateSource: preserveManualRate ? existing.rateSource : tx.rateSource,
            rateConfirmed: preserveManualRate ? existing.rateConfirmed : tx.rateConfirmed,
            totalRefunded: reconciledTotalRefunded,
            totalRefundedILS: reconciledTotalRefundedILS,
            netAmount: reconciledNetAmount,
            netAmountILS: reconciledNetAmountILS,
            shopifyUpdatedAt: tx.shopifyUpdatedAt || existing.shopifyUpdatedAt,
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
  const integrationStatus = {
    connected: true,
    shopDomain,
    lastSuccessfulSync: now,
    lastAttemptedSync: now,
    syncStatus: "connected",
    syncedCount,
    lastError: null,
    updatedAt: now,
  };

  try {
    await store.updateDocument("financials", "shopify_integration", integrationStatus);
  } catch {
    try {
      await store.createDocument("financials", "shopify_integration", integrationStatus);
    } catch {
      // Legacy fallback
      try {
        await store.updateDocument("financials/integrations", "shopify", integrationStatus, { exists: false });
      } catch {
        // ignore
      }
    }
  }

  return { success: true, syncedOrders: syncedCount };
}
