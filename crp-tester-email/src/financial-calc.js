/**
 * Financial calculation engine for CRP Admin.
 *
 * Responsibilities:
 * - Realized revenue, expense, and net profit calculations.
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

  let totalRevenueAllTime = 0;
  let totalExpensesAllTime = 0;
  let monthlyRevenue = 0;
  let monthlyExpenses = 0;

  // Breakdown counters
  const statusBreakdown = {
    revenue: { paid: 0, pending: 0, scheduled: 0, cancelled: 0, refunded: 0 },
    expense: { paid: 0, pending: 0, scheduled: 0, cancelled: 0, refunded: 0 },
  };

  // Category breakdowns
  const categoryTotals = {
    revenue: {},
    expense: {},
  };

  for (const t of transactions) {
    const type = t.type === "expense" ? "expense" : "revenue";
    const status = t.status || "pending";
    const amountILS = Number(t.amountILS) || 0;
    const isCurrentMonth = isInYearMonth(t.transactionDate, yearMonth);

    // Track status breakdown (All time)
    if (statusBreakdown[type][status] !== undefined) {
      statusBreakdown[type][status] += amountILS;
    }

    // Only "paid" transactions count toward recognized / realized revenue & expenses
    if (status === "paid") {
      if (type === "revenue") {
        totalRevenueAllTime += amountILS;
        if (isCurrentMonth) monthlyRevenue += amountILS;
        categoryTotals.revenue[t.category || "Other"] =
          (categoryTotals.revenue[t.category || "Other"] || 0) + amountILS;
      } else {
        totalExpensesAllTime += amountILS;
        if (isCurrentMonth) monthlyExpenses += amountILS;
        categoryTotals.expense[t.category || "Other"] =
          (categoryTotals.expense[t.category || "Other"] || 0) + amountILS;
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

  const totalRevenue = round(totalRevenueAllTime);
  const totalExpenses = round(totalExpensesAllTime);
  const netProfitAllTime = round(totalRevenue - totalExpenses);

  const mRevenue = round(monthlyRevenue);
  const mExpenses = round(monthlyExpenses);
  const mNetProfit = round(mRevenue - mExpenses);

  return {
    period,
    yearMonth,
    currency: "ILS",
    // All time totals
    totalRevenue,
    totalExpenses,
    netProfit: netProfitAllTime,
    // Current month totals
    monthlyRevenue: mRevenue,
    monthlyExpenses: mExpenses,
    monthlyNetProfit: mNetProfit,
    // Active recurring
    activeMRR: round(activeMRR),
    activeRecurringExpensesMonthly: round(activeRecurringExpenses),
    // Detailed breakdowns
    statusBreakdown: {
      revenue: {
        paid: round(statusBreakdown.revenue.paid),
        pending: round(statusBreakdown.revenue.pending),
        scheduled: round(statusBreakdown.revenue.scheduled),
        refunded: round(statusBreakdown.revenue.refunded),
        cancelled: round(statusBreakdown.revenue.cancelled),
      },
      expense: {
        paid: round(statusBreakdown.expense.paid),
        pending: round(statusBreakdown.expense.pending),
        scheduled: round(statusBreakdown.expense.scheduled),
        refunded: round(statusBreakdown.expense.refunded),
        cancelled: round(statusBreakdown.expense.cancelled),
      },
    },
    categoryTotals,
  };
}

/**
 * Generate monthly time-series buckets for charts (last N months).
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

  // Build the list of months in chronological order
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

  for (const t of transactions) {
    if (t.status !== "paid") continue;
    const dateStr = String(t.transactionDate || "");
    const monthKey = dateStr.slice(0, 7);
    const bucket = bucketMap.get(monthKey);
    if (!bucket) continue;

    const amount = Number(t.amountILS) || 0;
    if (t.type === "revenue") {
      bucket.revenue += amount;
    } else {
      bucket.expenses += amount;
    }
  }

  for (const b of buckets) {
    b.revenue = Math.round((b.revenue + Number.EPSILON) * 100) / 100;
    b.expenses = Math.round((b.expenses + Number.EPSILON) * 100) / 100;
    b.netProfit = Math.round((b.revenue - b.expenses + Number.EPSILON) * 100) / 100;
  }

  return buckets;
}

