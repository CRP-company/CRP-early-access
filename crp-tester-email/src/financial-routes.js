/**
 * Financial & Analytics routes handler for Cloudflare Worker.
 *
 * Implements:
 * - Strict financial admin authentication and step-up auth freshness check.
 * - Transactions CRUD.
 * - Recurring definitions CRUD & occurrence generation engine.
 * - Financial overview aggregation and charts time series.
 * - Shopify synchronization and webhook listener.
 * - Google Play and Firebase Analytics ingestion and aggregation.
 */

import { requireFinancialAdmin } from "./auth.js";
import { createFirestore } from "./firestore-rest.js";
import { validateTransaction, validateRecurringDefinition } from "./financial-validate.js";
import {
  calculateFinancialSummary,
  generateMonthlyChartData,
} from "./financial-calc.js";
import { generateRecurringOccurrences } from "./recurring-engine.js";
import {
  syncShopifyOrders,
  verifyShopifyWebhookHmac,
  verifyShopifyOAuthHmac,
  verifyShopifyTimestamp,
  sanitizeShopDomain,
  buildShopifyAuthUrl,
  exchangeShopifyCodeForToken,
  getValidShopifyAccessToken,
  parseShopifyOrderToTransactions,
} from "./shopify.js";
import {
  buildCohortRecord,
  calculateAggregatedRetention,
  buildInstallationRecord,
  aggregateInstallationMetrics,
} from "./analytics-engine.js";
import { syncGooglePlayReports } from "./google-play.js";

export const RECURRING_COLLECTION = "financials/recurring/items";

/**
 * Retrieve all recurring definitions, querying the canonical 4-segment subcollection
 * `financials/recurring/items` first, while preserving compatibility with any existing
 * records in legacy locations.
 *
 * @param {object} store Firestore client
 * @returns {Promise<Array<object>>} List of recurring definitions
 */
export async function listRecurringDefinitions(store) {
  if (!store || typeof store.listCollection !== "function") return [];

  // 1. Primary canonical subcollection: financials/recurring/items (3 segments)
  let recurring = (await store.listCollection(RECURRING_COLLECTION).catch(() => [])) || [];

  // 2. Compatibility check: if items subcollection returned empty, check legacy paths
  if (recurring.length === 0) {
    const rules = (await store.listCollection("financials/recurring/rules").catch(() => [])) || [];
    if (rules.length > 0) {
      recurring = rules;
    } else {
      const legacy = (await store.listCollection("financials/recurring").catch(() => [])) || [];
      if (legacy.length > 0) {
        recurring = legacy;
      }
    }
  }

  // Deduplicate by ID
  const seen = new Set();
  const deduped = [];
  for (const item of recurring) {
    if (item && item.id && !seen.has(item.id)) {
      seen.add(item.id);
      deduped.push(item);
    }
  }
  return deduped;
}

/**
 * Handle all /financial/* routes.
 *
 * @param {Request} request
 * @param {URL} url
 * @param {object} env
 * @param {Function} jsonResponse Helper (status, payload, origin, extraHeaders)
 * @param {string} origin
 * @returns {Promise<Response>}
 */
export async function handleFinancial(request, url, env, jsonResponse, origin) {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // Webhook is public with cryptographic HMAC verification
  if (path === "/financial/shopify/webhook" && method === "POST") {
    return handleShopifyWebhook(request, env, jsonResponse, origin);
  }

  // OAuth callback is public with cryptographic HMAC, timestamp, and one-time state verification
  if (path === "/financial/shopify/callback" && method === "GET") {
    return handleShopifyCallback(request, url, env, jsonResponse, origin);
  }

  // All other financial routes require financial admin authorization + step-up auth
  const projectId = env.FIREBASE_PROJECT_ID;
  let caller;
  try {
    caller = await requireFinancialAdmin(request, projectId, env);
  } catch (authError) {
    return jsonResponse(
      authError.status || 401,
      {
        ok: false,
        error: authError.message,
        code: authError.code || "AUTH_FAILED",
      },
      origin,
    );
  }

  const store =
    env.FIREBASE_SERVICE_ACCOUNT_JSON && projectId
      ? createFirestore(env.FIREBASE_SERVICE_ACCOUNT_JSON, projectId)
      : null;

  if (!store) {
    return jsonResponse(500, { ok: false, error: "Database service account not configured." }, origin);
  }

  // Route dispatch
  try {
    // ------------------------------------------------------------------ OVERVIEW
    if (path === "/financial/overview" && (method === "GET" || method === "POST")) {
      const period = url.searchParams.get("period") || "current_month";

      // Fetch transactions & recurring
      const rawTransactions = await store.listCollection("financials/transactions");
      const rawRecurring = await listRecurringDefinitions(store);
      let rawInstallations = await store.listCollection("analytics/installations/history");
      if (!rawInstallations || rawInstallations.length === 0) {
        rawInstallations = (await store.listCollection("analytics/installations/daily")) || [];
      }
      if (!rawInstallations || rawInstallations.length === 0) {
        rawInstallations = (await store.listCollection("analytics/installations").catch(() => [])) || [];
      }
      let rawCohorts = await store.listCollection("analytics/cohorts/history");
      if (!rawCohorts || rawCohorts.length === 0) {
        rawCohorts = (await store.listCollection("analytics/cohorts/daily")) || [];
      }
      if (!rawCohorts || rawCohorts.length === 0) {
        rawCohorts = (await store.listCollection("analytics/cohorts").catch(() => [])) || [];
      }

      // Fetch integration statuses
      const shopifyIntegration =
        (await store.getDocument("financials", "shopify_integration").catch(() => null)) ||
        (await store.getDocument("financials/integrations", "shopify").catch(() => null)) ||
        null;
      const playIntegration =
        (await store.getDocument("analytics/syncStatus/services", "google_play").catch(() => null)) ||
        (await store.getDocument("analytics", "sync_google_play").catch(() => null)) ||
        (await store.getDocument("analytics/syncStatus", "google_play").catch(() => null)) ||
        null;
      const analyticsIntegration =
        (await store.getDocument("analytics/syncStatus/services", "firebase_analytics").catch(() => null)) ||
        (await store.getDocument("analytics", "sync_firebase_analytics").catch(() => null)) ||
        (await store.getDocument("analytics/syncStatus", "firebase_analytics").catch(() => null)) ||
        null;

      // Calculate financial summary & chart series
      const summary = calculateFinancialSummary(rawTransactions, rawRecurring, period);
      const monthlyCharts = generateMonthlyChartData(rawTransactions, 12);

      // Aggregate Play install metrics
      const installMetrics = aggregateInstallationMetrics(rawInstallations);

      // Aggregate Retention metrics
      const retentionMetrics = calculateAggregatedRetention(rawCohorts);

      // Sort cohorts for display
      const sortedCohorts = [...rawCohorts].sort((a, b) =>
        String(b.cohortDate).localeCompare(String(a.cohortDate)),
      );

      return jsonResponse(
        200,
        {
          ok: true,
          period,
          summary,
          charts: {
            financials: monthlyCharts,
            installations: installMetrics.dailyTrend,
            cohorts: sortedCohorts.slice(0, 30),
          },
          kpis: {
            totalInstalls: installMetrics.totalInstalls,
            d7Retention: retentionMetrics.d7Average,
            d30Retention: retentionMetrics.d30Average,
            activeMRR: summary.activeMRR,
          },
          integrations: {
            shopify: {
              connected: Boolean(shopifyIntegration?.connected || env.SHOPIFY_ACCESS_TOKEN),
              lastSync: shopifyIntegration?.lastSuccessfulSync || null,
              status: shopifyIntegration?.syncStatus || (env.SHOPIFY_ACCESS_TOKEN ? "connected" : "not_configured"),
              error: shopifyIntegration?.lastError || null,
            },
            googlePlay: {
              connected: Boolean(playIntegration?.connected),
              lastSync: playIntegration?.lastSuccessfulSync || null,
              status: playIntegration?.syncStatus || "not_configured",
              error: playIntegration?.lastError || null,
            },
            firebaseAnalytics: {
              connected: Boolean(analyticsIntegration?.connected || rawCohorts.length > 0),
              lastSync: analyticsIntegration?.lastSuccessfulSync || null,
              status: analyticsIntegration?.syncStatus || (rawCohorts.length > 0 ? "connected" : "not_configured"),
              error: analyticsIntegration?.lastError || null,
            },
          },
        },
        origin,
      );
    }

    // ------------------------------------------------------------------ TRANSACTIONS LIST & CREATE
    if (path === "/financial/transactions") {
      if (method === "GET") {
        const transactions = await store.listCollection("financials/transactions");
        // Sort newest first
        transactions.sort((a, b) =>
          String(b.transactionDate || "").localeCompare(String(a.transactionDate || "")),
        );
        return jsonResponse(200, { ok: true, transactions }, origin);
      }

      if (method === "POST") {
        const body = await request.json().catch(() => ({}));
        const val = validateTransaction(body);
        if (!val.ok) {
          return jsonResponse(400, { ok: false, error: val.error }, origin);
        }

        const nowIso = new Date().toISOString();
        const id = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const doc = {
          id,
          ...val.value,
          createdAt: nowIso,
          updatedAt: nowIso,
          createdBy: caller.email,
        };

        await store.createDocument("financials/transactions", id, doc);
        return jsonResponse(201, { ok: true, transaction: doc }, origin);
      }
    }

    // ------------------------------------------------------------------ TRANSACTION UPDATE
    if (path === "/financial/transaction-update" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const id = String(body.id || "").trim();
      if (!id) return jsonResponse(400, { ok: false, error: "Missing transaction id." }, origin);

      const existing = await store.getDocument("financials/transactions", id);
      if (!existing) return jsonResponse(404, { ok: false, error: "Transaction not found." }, origin);

      const patch = {
        updatedAt: new Date().toISOString(),
        updatedBy: caller.email,
      };

      if (body.status) patch.status = body.status;
      if (body.description) patch.description = String(body.description).slice(0, 250);
      if (body.notes !== undefined) patch.notes = String(body.notes).slice(0, 1000);
      if (body.category) patch.category = String(body.category).slice(0, 80);

      const currency = String(existing.currency || "ILS").toUpperCase();

      // Handle exchange rate modification
      if (body.exchangeRate !== undefined) {
        const newRate = Number(body.exchangeRate);
        if (!Number.isFinite(newRate) || newRate <= 0) {
          return jsonResponse(400, { ok: false, error: "Exchange rate must be a positive finite number." }, origin);
        }

        if (existing.source === "shopify" && existing.rateSource === "settlement") {
          return jsonResponse(400, { ok: false, error: "Cannot manually override exchange rate on Shopify settlement-verified transactions." }, origin);
        }

        if (currency === "ILS" && newRate !== 1.0) {
          return jsonResponse(400, { ok: false, error: "Exchange rate for ILS base currency must be 1.0." }, origin);
        }

        const effectiveAmount = body.amount !== undefined ? Number(body.amount) : Number(existing.amount);
        const newAmountILS = Math.round((effectiveAmount * newRate + Number.EPSILON) * 100) / 100;

        patch.exchangeRate = newRate;
        patch.amountILS = newAmountILS;
        patch.rateConfirmed = true;
        patch.rateSource = currency === "ILS" ? "base_currency" : "explicit";

        const rateHistory = Array.isArray(existing.rateHistory) ? [...existing.rateHistory] : [];
        rateHistory.push({
          rate: newRate,
          previousRate: existing.exchangeRate ?? null,
          previousAmountILS: existing.amountILS ?? null,
          updatedAt: patch.updatedAt,
          updatedBy: caller.email,
        });
        patch.rateHistory = rateHistory;

        // If transaction has refunds / netAmount, update netAmountILS
        if (existing.totalRefundedILS !== undefined || existing.totalRefunded !== undefined) {
          const refILS = Number(existing.totalRefundedILS) || 0;
          patch.netAmountILS = (existing.status === "refunded" || (existing.totalRefunded >= existing.amount))
            ? 0
            : Math.max(0, Math.round((newAmountILS - refILS + Number.EPSILON) * 100) / 100);
        }
      }

      // Handle manual amount modification
      if (body.amount !== undefined) {
        const newAmount = Number(body.amount);
        if (!Number.isFinite(newAmount) || newAmount <= 0) {
          return jsonResponse(400, { ok: false, error: "Amount must be a positive finite number." }, origin);
        }
        if (existing.source === "shopify") {
          return jsonResponse(400, { ok: false, error: "Cannot manually change amount on Shopify imported transactions." }, origin);
        }

        patch.amount = newAmount;
        if (body.exchangeRate === undefined) {
          const rate = Number(existing.exchangeRate) || 1.0;
          if (existing.rateConfirmed && Number.isFinite(rate) && rate > 0) {
            patch.amountILS = Math.round((newAmount * rate + Number.EPSILON) * 100) / 100;
          }
        }
      }

      await store.updateDocument("financials/transactions", id, patch);
      return jsonResponse(200, { ok: true, id, patch }, origin);
    }

    // ------------------------------------------------------------------ TRANSACTION VOID / DELETE
    if (path === "/financial/transaction-void" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const id = String(body.id || "").trim();
      if (!id) return jsonResponse(400, { ok: false, error: "Missing transaction id." }, origin);

      const existing = await store.getDocument("financials/transactions", id);
      if (!existing) return jsonResponse(404, { ok: false, error: "Transaction not found." }, origin);

      if (body.hardDelete === true) {
        await store.deleteDocument("financials/transactions", id);
        return jsonResponse(200, { ok: true, id, deleted: true }, origin);
      }

      await store.updateDocument("financials/transactions", id, {
        status: "cancelled",
        updatedAt: new Date().toISOString(),
        voidedBy: caller.email,
        voidedReason: String(body.reason || "Voided by admin").slice(0, 250),
      });

      return jsonResponse(200, { ok: true, id, voided: true }, origin);
    }

    // ------------------------------------------------------------------ RECURRING DEFINITIONS
    if (path === "/financial/recurring") {
      if (method === "GET") {
        const recurring = await listRecurringDefinitions(store);
        recurring.sort((a, b) =>
          String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
        );
        return jsonResponse(200, { ok: true, recurring }, origin);
      }

      if (method === "POST") {
        const body = await request.json().catch(() => ({}));
        const val = validateRecurringDefinition(body);
        if (!val.ok) {
          return jsonResponse(400, { ok: false, error: val.error }, origin);
        }

        const nowIso = new Date().toISOString();
        const id = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const doc = {
          id,
          ...val.value,
          createdAt: nowIso,
          updatedAt: nowIso,
          createdBy: caller.email,
        };

        if (typeof store.createDocument === "function") {
          await store.createDocument(RECURRING_COLLECTION, id, doc);
        } else {
          await store.upsertDocument(RECURRING_COLLECTION, id, doc);
        }
        return jsonResponse(201, { ok: true, recurring: doc }, origin);
      }

      if (method === "DELETE") {
        let id = url.searchParams.get("id");
        if (!id) {
          const body = await request.json().catch(() => ({}));
          id = body?.id || null;
        }
        id = String(id || "").trim();
        if (!id) return jsonResponse(400, { ok: false, error: "Missing recurring id." }, origin);

        let targetCollection = RECURRING_COLLECTION;
        let existing = await store.getDocument(targetCollection, id).catch(() => null);
        if (!existing) {
          const legacyRules = await store.getDocument("financials/recurring/rules", id).catch(() => null);
          if (legacyRules) {
            targetCollection = "financials/recurring/rules";
            existing = legacyRules;
          } else {
            const legacyDirect = await store.getDocument("financials/recurring", id).catch(() => null);
            if (legacyDirect) {
              targetCollection = "financials/recurring";
              existing = legacyDirect;
            }
          }
        }
        if (!existing) return jsonResponse(404, { ok: false, error: "Recurring rule not found." }, origin);

        if (typeof store.deleteDocument === "function") {
          try {
            await store.deleteDocument(RECURRING_COLLECTION, id);
          } catch {
            await store.deleteDocument(targetCollection, id);
          }
        } else {
          const deletePatch = { status: "ended", updatedAt: new Date().toISOString() };
          try {
            await store.updateDocument(RECURRING_COLLECTION, id, deletePatch);
          } catch {
            await store.updateDocument(targetCollection, id, deletePatch);
          }
        }

        return jsonResponse(200, { ok: true, id, deleted: true }, origin);
      }
    }

    // ------------------------------------------------------------------ RECURRING DELETE (POST ALTERNATIVE)
    if (path === "/financial/recurring-delete" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const id = String(body.id || url.searchParams.get("id") || "").trim();
      if (!id) return jsonResponse(400, { ok: false, error: "Missing recurring id." }, origin);

      let targetCollection = RECURRING_COLLECTION;
      let existing = await store.getDocument(targetCollection, id).catch(() => null);
      if (!existing) {
        const legacyRules = await store.getDocument("financials/recurring/rules", id).catch(() => null);
        if (legacyRules) {
          targetCollection = "financials/recurring/rules";
          existing = legacyRules;
        } else {
          const legacyDirect = await store.getDocument("financials/recurring", id).catch(() => null);
          if (legacyDirect) {
            targetCollection = "financials/recurring";
            existing = legacyDirect;
          }
        }
      }
      if (!existing) return jsonResponse(404, { ok: false, error: "Recurring rule not found." }, origin);

      if (typeof store.deleteDocument === "function") {
        try {
          await store.deleteDocument(RECURRING_COLLECTION, id);
        } catch {
          await store.deleteDocument(targetCollection, id);
        }
      } else {
        const deletePatch = { status: "ended", updatedAt: new Date().toISOString() };
        try {
          await store.updateDocument(RECURRING_COLLECTION, id, deletePatch);
        } catch {
          await store.updateDocument(targetCollection, id, deletePatch);
        }
      }

      return jsonResponse(200, { ok: true, id, deleted: true }, origin);
    }

    // ------------------------------------------------------------------ RECURRING UPDATE
    if (path === "/financial/recurring-update" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const id = String(body.id || "").trim();
      if (!id) return jsonResponse(400, { ok: false, error: "Missing recurring id." }, origin);

      let targetCollection = RECURRING_COLLECTION;
      let existing = await store.getDocument(targetCollection, id).catch(() => null);
      if (!existing) {
        const legacyRules = await store.getDocument("financials/recurring/rules", id).catch(() => null);
        if (legacyRules) {
          targetCollection = "financials/recurring/rules";
          existing = legacyRules;
        } else {
          const legacyDirect = await store.getDocument("financials/recurring", id).catch(() => null);
          if (legacyDirect) {
            targetCollection = "financials/recurring";
            existing = legacyDirect;
          }
        }
      }
      if (!existing) return jsonResponse(404, { ok: false, error: "Recurring rule not found." }, origin);

      const patch = {
        updatedAt: new Date().toISOString(),
        updatedBy: caller.email,
      };

      if (body.status) patch.status = body.status;
      if (body.description) patch.description = String(body.description).slice(0, 250);
      if (body.notes !== undefined) patch.notes = String(body.notes).slice(0, 1000);
      if (body.category) patch.category = String(body.category).slice(0, 80);
      if (body.endDate !== undefined) patch.endDate = body.endDate;

      try {
        await store.updateDocument(RECURRING_COLLECTION, id, patch);
      } catch {
        await store.updateDocument(targetCollection, id, patch);
      }
      return jsonResponse(200, { ok: true, id, patch }, origin);
    }

    // ------------------------------------------------------------------ GENERATE RECURRING OCCURRENCES
    if (path === "/financial/recurring/generate" && method === "POST") {
      const recurringList = await listRecurringDefinitions(store);
      const existingTransactions = await store.listCollection("financials/transactions");

      const horizon = new Date();
      // Allow optional horizon override
      const generated = generateRecurringOccurrences(recurringList, existingTransactions, horizon);

      for (const tx of generated) {
        try {
          await store.createDocument("financials/transactions", tx.id, tx);
        } catch {
          // Idempotency: skip if already exists
        }
      }

      return jsonResponse(200, { ok: true, generatedCount: generated.length, generated }, origin);
    }

    // ------------------------------------------------------------------ SHOPIFY OAUTH START
    if (path === "/financial/shopify/auth" && (method === "GET" || method === "POST")) {
      const clientId = env.SHOPIFY_CLIENT_ID;
      if (!clientId) {
        return jsonResponse(
          500,
          { ok: false, error: "SHOPIFY_CLIENT_ID is not configured in Worker secrets." },
          origin,
        );
      }

      const requestedShop =
        url.searchParams.get("shop") || env.SHOPIFY_STORE_DOMAIN || env.SHOPIFY_SHOP_DOMAIN;
      const sanitizedShop = sanitizeShopDomain(
        requestedShop,
        env.SHOPIFY_STORE_DOMAIN || env.SHOPIFY_SHOP_DOMAIN,
      );

      if (!sanitizedShop) {
        return jsonResponse(
          400,
          {
            ok: false,
            error:
              "Invalid shop domain. Must be in the format '{shop}.myshopify.com' and match the authorized store.",
          },
          origin,
        );
      }

      // Generate cryptographically secure random state nonce
      const state = crypto.randomUUID();
      const expiresAt = Date.now() + 600_000; // 10 minutes TTL

      // Store state in Firestore: financials/oauth_state_${state}
      try {
        await store.createDocument("financials", `oauth_state_${state}`, {
          state,
          adminUid: caller.uid,
          adminEmail: caller.email,
          shopDomain: sanitizedShop,
          createdAt: Date.now(),
          expiresAt,
        });
      } catch (err) {
        return jsonResponse(
          500,
          { ok: false, error: `Could not save OAuth state: ${err.message}` },
          origin,
        );
      }

      const callbackUrl =
        env.SHOPIFY_CALLBACK_URL ||
        "https://crp-tester-email.atronamir5.workers.dev/financial/shopify/callback";

      const authorizeUrl = buildShopifyAuthUrl({
        shop: sanitizedShop,
        clientId,
        redirectUri: callbackUrl,
        state,
        scopes: env.SHOPIFY_SCOPES || undefined,
      });

      return jsonResponse(
        200,
        {
          ok: true,
          authorizeUrl,
          state,
          shop: sanitizedShop,
          expiresAt,
        },
        origin,
      );
    }

    // ------------------------------------------------------------------ SHOPIFY STATUS
    if (path === "/financial/shopify/status" && method === "GET") {
      let doc = null;
      try {
        doc = await store.getDocument("financials", "shopify_integration");
      } catch {
        // ignore
      }
      if (!doc) {
        try {
          doc = await store.getDocument("financials/integrations", "shopify");
        } catch {
          // ignore
        }
      }

      const isConnected = Boolean(doc?.connected || env.SHOPIFY_ACCESS_TOKEN);
      const shopDomain =
        doc?.shopDomain || env.SHOPIFY_STORE_DOMAIN || env.SHOPIFY_SHOP_DOMAIN || null;

      return jsonResponse(
        200,
        {
          ok: true,
          connected: isConnected,
          shopDomain,
          syncStatus: doc?.syncStatus || (isConnected ? "connected" : "not_configured"),
          lastSuccessfulSync: doc?.lastSuccessfulSync || null,
          lastAttemptedSync: doc?.lastAttemptedSync || null,
          lastError: doc?.lastError || null,
          scope: doc?.scope || null,
          tokenType: doc?.refreshToken ? "expiring_offline" : (doc?.accessToken ? "offline" : null),
          expiresAt: doc?.expiresAt || null,
        },
        origin,
      );
    }

    // ------------------------------------------------------------------ SHOPIFY SYNC
    if (path === "/financial/shopify/sync" && method === "POST") {
      let tokenInfo;
      try {
        tokenInfo = await getValidShopifyAccessToken({ store, env });
      } catch (tokenErr) {
        return jsonResponse(
          400,
          {
            ok: false,
            error: tokenErr.message,
          },
          origin,
        );
      }

      const syncResult = await syncShopifyOrders({
        shopDomain: tokenInfo.shopDomain,
        accessToken: tokenInfo.accessToken,
        store,
      });

      return jsonResponse(syncResult.success ? 200 : 502, syncResult, origin);
    }

    // ------------------------------------------------------------------ GOOGLE PLAY BULK SYNC
    if (path === "/financial/play/sync" && method === "POST") {
      try {
        let bodyMonth = null;
        try {
          const body = await request.clone().json().catch(() => ({}));
          bodyMonth = body?.month || null;
        } catch {}
        const targetMonth = url.searchParams.get("month") || bodyMonth || null;
        const syncResult = await syncGooglePlayReports({ env, store, targetMonth });
        const statusCode = syncResult.ok && syncResult.filesDiscovered === 0 ? 200 : syncResult.success ? 200 : 502;
        return jsonResponse(statusCode, syncResult, origin);
      } catch (err) {
        return jsonResponse(500, { ok: false, error: err.message }, origin);
      }
    }

    // ------------------------------------------------------------------ INGEST PLAY INSTALLATIONS
    if (path === "/financial/analytics/installations" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!body.date) {
        return jsonResponse(400, { ok: false, error: "Date (YYYY-MM-DD) is required." }, origin);
      }

      const record = buildInstallationRecord(body);
      if (typeof store.upsertDocument === "function") {
        await store.upsertDocument("analytics/installations/history", record.date, record);
      } else {
        await store.createDocument("analytics/installations/history", record.date, record).catch(async () => {
          await store.updateDocument("analytics/installations/history", record.date, record);
        });
      }

      // Update sync status
      const syncStatusPayload = {
        connected: true,
        lastSuccessfulSync: new Date().toISOString(),
        syncStatus: "connected",
      };
      if (typeof store.upsertDocument === "function") {
        await store.upsertDocument("analytics/syncStatus/services", "google_play", syncStatusPayload);
      } else {
        await store.createDocument("analytics/syncStatus/services", "google_play", syncStatusPayload).catch(async () => {
          await store.updateDocument("analytics/syncStatus/services", "google_play", syncStatusPayload);
        });
      }

      return jsonResponse(200, { ok: true, record }, origin);
    }

    // ------------------------------------------------------------------ INGEST ANALYTICS COHORTS
    if (path === "/financial/analytics/cohorts" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!body.cohortDate) {
        return jsonResponse(400, { ok: false, error: "cohortDate (YYYY-MM-DD) is required." }, origin);
      }

      const record = buildCohortRecord(body);
      if (typeof store.upsertDocument === "function") {
        await store.upsertDocument("analytics/cohorts/history", record.cohortDate, record);
      } else {
        await store.createDocument("analytics/cohorts/history", record.cohortDate, record).catch(async () => {
          await store.updateDocument("analytics/cohorts/history", record.cohortDate, record);
        });
      }

      // Update sync status
      const syncStatusPayload = {
        connected: true,
        lastSuccessfulSync: new Date().toISOString(),
        syncStatus: "connected",
      };
      if (typeof store.upsertDocument === "function") {
        await store.upsertDocument("analytics/syncStatus/services", "firebase_analytics", syncStatusPayload);
      } else {
        await store.createDocument("analytics/syncStatus/services", "firebase_analytics", syncStatusPayload).catch(async () => {
          await store.updateDocument("analytics/syncStatus/services", "firebase_analytics", syncStatusPayload);
        });
      }

      return jsonResponse(200, { ok: true, record }, origin);
    }

    return jsonResponse(404, { ok: false, error: "Unknown financial endpoint." }, origin);
  } catch (err) {
    console.error("Financial route error:", err);
    return jsonResponse(
      500,
      { ok: false, error: err.message || "Financial operation failed." },
      origin,
    );
  }
}

/**
 * Handle incoming Shopify webhook notifications.
 */
async function handleShopifyWebhook(request, env, jsonResponse, origin) {
  const secret = env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    return jsonResponse(500, { ok: false, error: "SHOPIFY_WEBHOOK_SECRET not configured." }, origin);
  }

  const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256");
  const rawBody = await request.text();

  const valid = await verifyShopifyWebhookHmac(rawBody, hmacHeader, secret);
  if (!valid) {
    return jsonResponse(401, { ok: false, error: "Invalid webhook HMAC signature." }, origin);
  }

  let orderData;
  try {
    orderData = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON payload." }, origin);
  }

  const projectId = env.FIREBASE_PROJECT_ID;
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON || !projectId) {
    return jsonResponse(500, { ok: false, error: "Database not configured." }, origin);
  }

  const store = createFirestore(env.FIREBASE_SERVICE_ACCOUNT_JSON, projectId);
  const transactions = parseShopifyOrderToTransactions(orderData);

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
      continue;
    }

    // Existing transaction found. Verify timestamp ordering.
    const incomingTime = new Date(tx.shopifyUpdatedAt || tx.updatedAt || 0).getTime();
    const existingTime = new Date(existing.shopifyUpdatedAt || existing.updatedAt || 0).getTime();

    // If incoming event is older than our existing record, do not overwrite with stale data
    if (incomingTime > 0 && existingTime > 0 && incomingTime < existingTime) {
      continue; // Stale webhook event ignored
    }

    if (tx.isRefund) {
      // For refund records, preserve existing confirmed rates/amounts
      try {
        await store.updateDocument("financials/transactions", tx.id, {
          amount: tx.amount,
          amountILS: existing.rateConfirmed && existing.amountILS != null ? existing.amountILS : tx.amountILS,
          exchangeRate: existing.rateConfirmed && existing.exchangeRate != null ? existing.exchangeRate : tx.exchangeRate,
          rateSource: existing.rateConfirmed ? existing.rateSource : tx.rateSource,
          rateConfirmed: existing.rateConfirmed || tx.rateConfirmed,
          shopifyUpdatedAt: tx.shopifyUpdatedAt || existing.shopifyUpdatedAt,
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // ignore
      }
    } else {
      // Parent Order Transaction:
      // Reconcile totalRefunded so an incomplete refund payload or partial event cannot decrease known refunds
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

      // Preserve manually confirmed exchange rate if manual override was done and incoming has no verified settlement
      const preserveManualRate = existing.rateSource === "explicit" && existing.rateConfirmed && tx.rateSource !== "settlement";

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
          notes: tx.notes || existing.notes,
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // ignore
      }
    }
  }

  return jsonResponse(200, { ok: true, processedCount: transactions.length }, origin);
}

/**
 * Handle Shopify OAuth callback.
 * Public endpoint verified by HMAC signature, timestamp freshness, and one-time state nonce.
 */
async function handleShopifyCallback(request, url, env, jsonResponse, origin) {
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON || !projectId) {
    return jsonResponse(500, { ok: false, error: "Database not configured." }, origin);
  }

  const clientId = env.SHOPIFY_CLIENT_ID;
  const clientSecret = env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return jsonResponse(
      500,
      { ok: false, error: "SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be configured." },
      origin,
    );
  }

  const searchParams = url.searchParams;
  const code = searchParams.get("code");
  const shop = searchParams.get("shop");
  const state = searchParams.get("state");
  const hmac = searchParams.get("hmac");

  if (!code || !shop || !state || !hmac) {
    return jsonResponse(
      400,
      { ok: false, error: "Missing required Shopify OAuth callback parameters." },
      origin,
    );
  }

  // 1. Timestamp freshness check (10 min replay defense)
  if (!verifyShopifyTimestamp(searchParams, 600)) {
    return jsonResponse(
      400,
      { ok: false, error: "Shopify OAuth callback timestamp is expired or skewed." },
      origin,
    );
  }

  // 2. Cryptographic HMAC verification
  const isHmacValid = await verifyShopifyOAuthHmac(searchParams, clientSecret);
  if (!isHmacValid) {
    return jsonResponse(
      401,
      { ok: false, error: "Invalid Shopify OAuth callback HMAC signature." },
      origin,
    );
  }

  // 3. Shop domain validation
  const sanitizedShop = sanitizeShopDomain(
    shop,
    env.SHOPIFY_STORE_DOMAIN || env.SHOPIFY_SHOP_DOMAIN,
  );
  if (!sanitizedShop) {
    return jsonResponse(
      400,
      { ok: false, error: "Invalid or unauthorized Shopify store domain." },
      origin,
    );
  }

  // 4. State validation & one-time consumption from Firestore
  const store = createFirestore(env.FIREBASE_SERVICE_ACCOUNT_JSON, projectId);
  let stateDoc = null;
  try {
    stateDoc = await store.getDocument("financials", `oauth_state_${state}`);
  } catch (err) {
    return jsonResponse(
      500,
      { ok: false, error: `Failed to verify OAuth state: ${err.message}` },
      origin,
    );
  }

  if (!stateDoc) {
    return jsonResponse(
      403,
      { ok: false, error: "Invalid or already consumed OAuth state nonce." },
      origin,
    );
  }

  // Check state expiration (10 min TTL)
  if (stateDoc.expiresAt && Date.now() > stateDoc.expiresAt) {
    try {
      await store.deleteDocument("financials", `oauth_state_${state}`);
    } catch {
      // ignore
    }
    return jsonResponse(
      403,
      {
        ok: false,
        error: "OAuth state has expired. Please initiate authorization again from the dashboard.",
      },
      origin,
    );
  }

  // Check state shopDomain match
  if (stateDoc.shopDomain && stateDoc.shopDomain !== sanitizedShop) {
    return jsonResponse(
      403,
      { ok: false, error: "OAuth state does not match the target shop domain." },
      origin,
    );
  }

  // Immediately delete state document (prevent replay attacks)
  try {
    await store.deleteDocument("financials", `oauth_state_${state}`);
  } catch (err) {
    console.warn("Could not delete consumed OAuth state:", err);
  }

  // 5. Code exchange for offline access token (with expiring=1 support)
  let tokenResult;
  try {
    tokenResult = await exchangeShopifyCodeForToken({
      shop: sanitizedShop,
      code,
      clientId,
      clientSecret,
    });
  } catch (err) {
    return jsonResponse(
      502,
      { ok: false, error: `Token exchange failed: ${err.message}` },
      origin,
    );
  }

  // 6. Securely persist tokens to Firestore (financials/shopify_integration)
  const now = new Date().toISOString();
  const integrationData = {
    connected: true,
    shopDomain: sanitizedShop,
    accessToken: tokenResult.accessToken,
    scope: tokenResult.scope,
    expiresAt: tokenResult.expiresIn ? Date.now() + (tokenResult.expiresIn - 300) * 1000 : null,
    refreshToken: tokenResult.refreshToken || null,
    refreshTokenExpiresAt: tokenResult.refreshTokenExpiresIn
      ? Date.now() + (tokenResult.refreshTokenExpiresIn - 86400) * 1000
      : null,
    installedBy: stateDoc.adminEmail || "admin",
    installedAt: now,
    lastSuccessfulSync: null,
    lastAttemptedSync: null,
    syncStatus: "connected",
    lastError: null,
    updatedAt: now,
  };

  try {
    await store.updateDocument("financials", "shopify_integration", integrationData);
  } catch {
    try {
      await store.createDocument("financials", "shopify_integration", integrationData);
    } catch (saveErr) {
      return jsonResponse(
        500,
        { ok: false, error: `Failed to persist Shopify credentials: ${saveErr.message}` },
        origin,
      );
    }
  }

  // 7. Return friendly HTML or JSON
  const format = searchParams.get("format");
  const acceptHeader = request.headers.get("Accept") || "";
  if (format === "json" || acceptHeader.includes("application/json")) {
    return jsonResponse(
      200,
      {
        ok: true,
        message: "Shopify store successfully connected.",
        shop: sanitizedShop,
        scope: tokenResult.scope,
      },
      origin,
    );
  }

  // 8. For normal browser requests, return an HTTP 302 redirect to the exact CRP Admin frontend
  // Hardcoded target prevents open redirect vulnerabilities from user-supplied parameters
  const redirectTarget = "https://crp-company.github.io/CRP-early-access/admin/?shopify=connected";
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectTarget,
      "Cache-Control": "no-store",
    },
  });
}
