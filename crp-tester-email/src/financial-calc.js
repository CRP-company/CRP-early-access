/**
 * Financial calculation engine for CRP Admin.
 *
 * Responsibilities:
 * - Realized revenue, expense, and net profit calculations.
 * - Revenue recognized net of full and partial refunds.
 * - Temporal accuracy: refunds reduce recognized revenue in the month they occur,
 *   preserving historical order recognition in prior months.
 * - Filtering by Current Month (Asia/Jerusalem) vs All Time.
 * - Strict exclusion of pending, scheduled, and cancelled items from realized figures.
 * - Active MRR-equivalent calculation for recurring revenue and expenses.
 * - Time-series aggregation for financial charts (monthly and daily buckets).
 */

import { calculateMRREquivalent } from "./recurring-engine.js";

export const TIMEZONE = "Asia/Jerusalem";

/**
 * Get current year and month in Asia/Jerusalem timezone.
 * @param {Date} [now]
 * @returns {{year: number, month: number, yearMonth: string}} e.g. {year: 2026, month: 11, yearMonth: "2026-11"}
 */
export function getJerusalemYearMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);

  const year = Number(parts.find((p) => p.type === "year")?.value || now.getFullYear());
  const month = Number(parts.find((p) => p.type === "month")?.value || now.getMonth() + 1);
  const yearMonth = `${year}-${String(month).padStart(2, "0")}`;

  return { year, month, yearMonth };
}

/**
 * Determine if a transaction date string (YYYY-MM-DD or ISO) belongs to the given yearMonth.
 */
export function isInYearMonth(dateStr, yearMonth) {
  if (!dateStr) return false;
  return String(dateStr).startsWith(yearMonth);
}

/**
 * Calculate financial overview metrics.
 *
 * Accounting rules:
 * - Net Revenue = Gross Recognized Paid Revenue - Realized Refunds.
 * - Orders marked 'paid' or 'partially_refunded' represent gross purchase revenue.
 * - Distinct refund adjustment transactions (isRefund === true) reduce recognized revenue.
 * - Orders marked 'refunded' that have distinct refund transactions represent gross purchases whose
 *   adjustments are realized via their refund records (preserving month-over-month GAAP timing).
 * - Orders marked 'refunded' without distinct refund records contribute net 0.
 * - Pending, scheduled, and cancelled orders are excluded from recognized revenue.
 *
 * @param {Array<object>} transactions List of all financial transactions
 * @param {Array<object>} recurringDefinitions List of recurring definitions
 * @param {string} [period] "current_month" | "all_time" (default "current_month")
 * @param {Date} [referenceDate] Date used as "now" (default new Date())
 * @returns {object} Calculated financial summary
 */
export function calculateFinancialSummary(
  transactions = [],
  recurringDefinitions = [],
  period = "current_month",
  referenceDate = new Date(),
) {
  const { yearMonth } = getJerusalemYearMonth(referenceDate);

  let grossRevenueAllTime = 0;
  let refundsAllTime = 0;
  let totalExpensesAllTime = 0;

  let monthlyGrossRevenue = 0;
  let monthlyRefunds = 0;
  let monthlyExpenses = 0;

  // Track unconfirmed foreign currency amounts
  let unconfirmedCount = 0;
  const unconfirmedTransactions = [];
  const unconfirmedForeignTotals = {};

  // Breakdown counters
  const statusBreakdown = {
    revenue: {
      paid: 0,
      pending: 0,
      scheduled: 0,
      cancelled: 0,
      refunded: 0,
      partially_refunded: 0,
    },
    expense: {
      paid: 0,
      pending: 0,
      scheduled: 0,
      cancelled: 0,
      refunded: 0,
    },
  };

  // Category breakdowns
  const categoryTotals = {
    revenue: {},
    expense: {},
  };

  // Identify all orders that have associated separate refund records
  const refundedOrderKeys = new Set(
    transactions
      .filter((x) => x.isRefund || (x.parentTransactionId && x.status === "refunded"))
      .map((x) => x.orderId || x.parentTransactionId || x.externalId)
      .filter(Boolean),
  );

  for (const t of transactions) {
    const type = t.type === "expense" ? "expense" : "revenue";
    const status = t.status || "pending";
    const currency = String(t.currency || "ILS").toUpperCase();
    const isBaseILS = currency === "ILS";
    const isUnconfirmed = !isBaseILS && (t.amountILS == null || t.rateConfirmed === false || t.rateSource === "unconfirmed" || t.rateSource === "fallback");

    if (isUnconfirmed) {
      unconfirmedCount += 1;
      unconfirmedTransactions.push({
        id: t.id,
        description: t.description || t.notes || t.id,
        currency,
        amount: Number(t.amount) || 0,
        transactionDate: t.transactionDate,
        source: t.source,
        status: t.status,
      });
      unconfirmedForeignTotals[currency] = Math.round(((unconfirmedForeignTotals[currency] || 0) + (Number(t.amount) || 0) + Number.EPSILON) * 100) / 100;
    }

    // Transactions with null/missing ILS amounts cannot contribute to recognized ILS totals
    if (t.amountILS == null) {
      continue;
    }

    const amountILS = Number(t.amountILS) || 0;
    const isCurrentMonth = isInYearMonth(t.transactionDate, yearMonth);
    const isRefundAdjustment = Boolean(
      t.isRefund || (type === "revenue" && status === "refunded" && t.parentTransactionId),
    );

    // Track status breakdown (All time)
    if (statusBreakdown[type][status] !== undefined) {
      statusBreakdown[type][status] += amountILS;
    }

    if (type === "revenue") {
      if (isRefundAdjustment) {
        // Distinct refund adjustment record: deduct from recognized revenue
        refundsAllTime += amountILS;
        if (isCurrentMonth) monthlyRefunds += amountILS;

        const cat = t.category || "Other";
        categoryTotals.revenue[cat] = (categoryTotals.revenue[cat] || 0) - amountILS;
      } else if (status === "paid" || status === "partially_refunded") {
        // Recognized gross purchase
        grossRevenueAllTime += amountILS;
        if (isCurrentMonth) monthlyGrossRevenue += amountILS;

        const cat = t.category || "Other";
        categoryTotals.revenue[cat] = (categoryTotals.revenue[cat] || 0) + amountILS;
      } else if (status === "refunded") {
        // If order itself is status 'refunded', check if separate refund transactions exist for it
        const hasSeparateRefundRecords =
          refundedOrderKeys.has(t.id) ||
          refundedOrderKeys.has(t.orderId) ||
          refundedOrderKeys.has(t.externalId);

        if (hasSeparateRefundRecords) {
          // Gross order is recognized; the separate refund records deduct it in the month refunded
          grossRevenueAllTime += amountILS;
          if (isCurrentMonth) monthlyGrossRevenue += amountILS;

          const cat = t.category || "Other";
          categoryTotals.revenue[cat] = (categoryTotals.revenue[cat] || 0) + amountILS;
        }
        // If no separate refund records exist, order is fully refunded with net 0 contribution
      }
    } else {
      // Expense
      if (status === "paid") {
        totalExpensesAllTime += amountILS;
        if (isCurrentMonth) monthlyExpenses += amountILS;

        const cat = t.category || "Other";
        categoryTotals.expense[cat] = (categoryTotals.expense[cat] || 0) + amountILS;
      }
    }
  }

  // Active Recurring Revenue (MRR-equivalent) & Expenses
  let activeMRR = 0;
  let activeRecurringExpenses = 0;

  for (const r of recurringDefinitions) {
    if (r.status === "active") {
      const mrr = calculateMRREquivalent(r.amountILS, r.frequency);
      if (r.type === "revenue") {
        activeMRR += mrr;
      } else {
        activeRecurringExpenses += mrr;
      }
    }
  }

  // Round all metrics to 2 decimal places
  const round = (val) => Math.round((val + Number.EPSILON) * 100) / 100;

  // NET REVENUE = Gross Recognized - Realized Refunds
  const totalRevenue = round(Math.max(0, grossRevenueAllTime - refundsAllTime));
  const totalExpenses = round(totalExpensesAllTime);
  const netProfitAllTime = round(totalRevenue - totalExpenses);

  const mRevenue = round(Math.max(0, monthlyGrossRevenue - monthlyRefunds));
  const mExpenses = round(monthlyExpenses);
  const mNetProfit = round(mRevenue - mExpenses);

  return {
    period,
    yearMonth,
    currency: "ILS",
    unconfirmedCount,
    hasUnconfirmedAmounts: unconfirmedCount > 0,
    unconfirmedTransactions,
    unconfirmedForeignTotals,
    // All time totals
    totalRevenue,
    totalExpenses,
    netProfit: netProfitAllTime,
    // Gross and refund breakdown
    grossRevenue: round(grossRevenueAllTime),
    totalRefunds: round(refundsAllTime),
    // Current month totals
    monthlyRevenue: mRevenue,
    monthlyExpenses: mExpenses,
    monthlyNetProfit: mNetProfit,
    monthlyGrossRevenue: round(monthlyGrossRevenue),
    monthlyRefunds: round(monthlyRefunds),
    // Active recurring
    activeMRR: round(activeMRR),
    activeRecurringExpensesMonthly: round(activeRecurringExpenses),
    // Detailed breakdowns
    statusBreakdown: {
      revenue: {
        paid: round(statusBreakdown.revenue.paid),
        pending: round(statusBreakdown.revenue.pending),
        scheduled: round(statusBreakdown.revenue.scheduled),
        cancelled: round(statusBreakdown.revenue.cancelled),
        refunded: round(refundsAllTime > 0 ? refundsAllTime : statusBreakdown.revenue.refunded),
        partially_refunded: round(statusBreakdown.revenue.partially_refunded),
      },
      expense: {
        paid: round(statusBreakdown.expense.paid),
        pending: round(statusBreakdown.expense.pending),
        scheduled: round(statusBreakdown.expense.scheduled),
        cancelled: round(statusBreakdown.expense.cancelled),
        refunded: round(statusBreakdown.expense.refunded),
      },
    },
    categoryTotals: {
      revenue: Object.fromEntries(
        Object.entries(categoryTotals.revenue).map(([k, v]) => [k, round(v)]),
      ),
      expense: Object.fromEntries(
        Object.entries(categoryTotals.expense).map(([k, v]) => [k, round(v)]),
      ),
    },
  };
}

/**
 * Generate monthly time-series buckets for charts (last N months).
 * Reflects refunds by deducting them in the month the refund occurred.
 *
 * @param {Array<object>} transactions
 * @param {number} [monthsCount] Number of months to include (default 12)
 * @param {Date} [referenceDate]
 * @returns {Array<{month: string, label: string, revenue: number, expenses: number, netProfit: number}>}
 */
export function generateMonthlyChartData(
  transactions = [],
  monthsCount = 12,
  referenceDate = new Date(),
) {
  const buckets = [];
  const ref = new Date(referenceDate);

  // Build chronological list of month buckets
  for (let i = monthsCount - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - i, 1));
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const key = `${year}-${month}`;
    const label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });

    buckets.push({
      month: key,
      label,
      revenue: 0,
      expenses: 0,
      netProfit: 0,
    });
  }

  const bucketMap = new Map(buckets.map((b) => [b.month, b]));

  const refundedOrderKeys = new Set(
    transactions
      .filter((x) => x.isRefund || (x.parentTransactionId && x.status === "refunded"))
      .map((x) => x.orderId || x.parentTransactionId || x.externalId)
      .filter(Boolean),
  );

  for (const t of transactions) {
    const curr = String(t.currency || "ILS").toUpperCase();
    const isUnconfirmed = curr !== "ILS" && (t.amountILS == null || !t.rateConfirmed || t.rateSource === "unconfirmed");
    if (isUnconfirmed) continue;

    const dateStr = String(t.transactionDate || t.date || t.createdAt || "");
    const monthKey = dateStr.slice(0, 7);
    const bucket = bucketMap.get(monthKey);
    if (!bucket) continue;

    const amount = Number(t.amountILS) || 0;
    const isRefundAdjustment = Boolean(
      t.isRefund || (t.type === "revenue" && t.status === "refunded" && t.parentTransactionId),
    );

    if (t.type === "revenue") {
      if (isRefundAdjustment) {
        // Refund reduces revenue in the month the refund occurred
        bucket.revenue -= amount;
      } else if (
        t.status === "paid" ||
        t.status === "partially_refunded" ||
        (t.status === "refunded" && (
          refundedOrderKeys.has(t.id) ||
          refundedOrderKeys.has(t.orderId) ||
          refundedOrderKeys.has(t.externalId)
        ))
      ) {
        bucket.revenue += amount;
      }
    } else if (t.type === "expense" && t.status === "paid") {
      bucket.expenses += amount;
    }
  }

  for (const b of buckets) {
    b.revenue = Math.round((Math.max(0, b.revenue) + Number.EPSILON) * 100) / 100;
    b.expenses = Math.round((b.expenses + Number.EPSILON) * 100) / 100;
    b.netProfit = Math.round((b.revenue - b.expenses + Number.EPSILON) * 100) / 100;
  }

  return buckets;
}
