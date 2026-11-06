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
import { syncShopifyOrders, verifyShopifyWebhookHmac, parseShopifyOrderToTransactions } from "./shopify.js";
import {
  buildCohortRecord,
  calculateAggregatedRetention,
  buildInstallationRecord,
  aggregateInstallationMetrics,
} from "./analytics-engine.js";

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
      const rawRecurring = await store.listCollection("financials/recurring");
      const rawInstallations = await store.listCollection("analytics/installations");
      const rawCohorts = await store.listCollection("analytics/cohorts");

      // Fetch integration statuses
      const shopifyIntegration = (await store.getDocument("financials/integrations", "shopify")) || null;
      const playIntegration = (await store.getDocument("analytics/syncStatus", "google_play")) || null;
      const analyticsIntegration =
        (await store.getDocument("analytics/syncStatus", "firebase_analytics")) || null;

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
              connected: Boolean(playIntegration?.connected || env.GOOGLE_PLAY_REPORT_BUCKET),
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
        const recurring = await store.listCollection("financials/recurring");
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

        await store.createDocument("financials/recurring", id, doc);
        return jsonResponse(201, { ok: true, recurring: doc }, origin);
      }
    }

    // ------------------------------------------------------------------ RECURRING UPDATE
    if (path === "/financial/recurring-update" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const id = String(body.id || "").trim();
      if (!id) return jsonResponse(400, { ok: false, error: "Missing recurring id." }, origin);

      const existing = await store.getDocument("financials/recurring", id);
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

      await store.updateDocument("financials/recurring", id, patch);
      return jsonResponse(200, { ok: true, id, patch }, origin);
    }

    // ------------------------------------------------------------------ GENERATE RECURRING OCCURRENCES
    if (path === "/financial/recurring/generate" && method === "POST") {
      const recurringList = await store.listCollection("financials/recurring");
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

    // ------------------------------------------------------------------ SHOPIFY SYNC
    if (path === "/financial/shopify/sync" && method === "POST") {
      const shopDomain = env.SHOPIFY_SHOP_DOMAIN;
      const accessToken = env.SHOPIFY_ACCESS_TOKEN;

      if (!shopDomain || !accessToken) {
        return jsonResponse(
          400,
          {
            ok: false,
            error: "Shopify domain and access token must be configured in Worker secrets.",
          },
          origin,
        );
      }

      const syncResult = await syncShopifyOrders({
        shopDomain,
        accessToken,
        store,
      });

      return jsonResponse(syncResult.success ? 200 : 502, syncResult, origin);
    }

    // ------------------------------------------------------------------ INGEST PLAY INSTALLATIONS
    if (path === "/financial/analytics/installations" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!body.date) {
        return jsonResponse(400, { ok: false, error: "Date (YYYY-MM-DD) is required." }, origin);
      }

      const record = buildInstallationRecord(body);
      await store.createDocument("analytics/installations", record.date, record).catch(async () => {
        await store.updateDocument("analytics/installations", record.date, record);
      });

      // Update sync status
      await store.createDocument("analytics/syncStatus", "google_play", {
        connected: true,
        lastSuccessfulSync: new Date().toISOString(),
        syncStatus: "connected",
      }).catch(async () => {
        await store.updateDocument("analytics/syncStatus", "google_play", {
          connected: true,
          lastSuccessfulSync: new Date().toISOString(),
          syncStatus: "connected",
        });
      });

      return jsonResponse(200, { ok: true, record }, origin);
    }

    // ------------------------------------------------------------------ INGEST ANALYTICS COHORTS
    if (path === "/financial/analytics/cohorts" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!body.cohortDate) {
        return jsonResponse(400, { ok: false, error: "cohortDate (YYYY-MM-DD) is required." }, origin);
      }

      const record = buildCohortRecord(body);
      await store.createDocument("analytics/cohorts", record.cohortDate, record).catch(async () => {
        await store.updateDocument("analytics/cohorts", record.cohortDate, record);
      });

      // Update sync status
      await store.createDocument("analytics/syncStatus", "firebase_analytics", {
        connected: true,
        lastSuccessfulSync: new Date().toISOString(),
        syncStatus: "connected",
      }).catch(async () => {
        await store.updateDocument("analytics/syncStatus", "firebase_analytics", {
          connected: true,
          lastSuccessfulSync: new Date().toISOString(),
          syncStatus: "connected",
        });
      });

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
    try {
      await store.createDocument("financials/transactions", tx.id, tx);
    } catch {
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
  }

  return jsonResponse(200, { ok: true, processedCount: transactions.length }, origin);
}

