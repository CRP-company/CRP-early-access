import { describe, it, expect } from "vitest";
import { normalizeToILS, getDefaultExchangeRate, formatILS, formatCurrency } from "../src/currency.js";
import {
  calculateFinancialSummary,
  generateMonthlyChartData,
  isInYearMonth,
  getJerusalemYearMonth,
} from "../src/financial-calc.js";
import { calculateMRREquivalent } from "../src/recurring-engine.js";

describe("Financial Calculations & Currency", () => {
  it("normalizes ILS amounts directly", () => {
    expect(normalizeToILS(100, "ILS")).toBe(100);
    expect(normalizeToILS(250.755, "ILS")).toBe(250.76);
  });

  it("converts USD and other currencies to ILS using exchange rate", () => {
    // 100 USD at 3.65 = 365 ILS
    expect(normalizeToILS(100, "USD", 3.65)).toBe(365);
    // Custom historical rate: 100 EUR at 4.10 = 410 ILS
    expect(normalizeToILS(100, "EUR", 4.10)).toBe(410);
    // Default rate lookup
    expect(getDefaultExchangeRate("USD")).toBe(3.65);
    expect(getDefaultExchangeRate("EUR")).toBe(3.95);
    expect(getDefaultExchangeRate("ILS")).toBe(1.0);
  });

  it("formats ILS and other currencies properly", () => {
    expect(formatILS(1234.5)).toBe("₪1,234.50");
    expect(formatCurrency(100, "USD")).toBe("$100.00");
    expect(formatCurrency(200, "EUR")).toBe("€200.00");
    expect(formatCurrency(500, "ILS")).toBe("₪500.00");
  });

  it("calculates MRR equivalents across all frequencies", () => {
    // Monthly
    expect(calculateMRREquivalent(1000, "monthly")).toBe(1000);
    // Weekly: 100 * 52 / 12 = 433.33
    expect(calculateMRREquivalent(100, "weekly")).toBe(433.33);
    // Quarterly: 3000 / 3 = 1000
    expect(calculateMRREquivalent(3000, "quarterly")).toBe(1000);
    // Annually: 12000 / 12 = 1000
    expect(calculateMRREquivalent(12000, "annually")).toBe(1000);
  });

  it("calculates recognized revenue, expenses, and net profit excluding pending/scheduled", () => {
    const transactions = [
      {
        id: "tx1",
        type: "revenue",
        amountILS: 1000,
        status: "paid",
        transactionDate: "2026-11-05",
        category: "Hardware",
      },
      {
        id: "tx2",
        type: "revenue",
        amountILS: 500,
        status: "pending", // NOT recognized
        transactionDate: "2026-11-06",
      },
      {
        id: "tx3",
        type: "revenue",
        amountILS: 2000,
        status: "scheduled", // NOT recognized
        transactionDate: "2026-11-15",
      },
      {
        id: "tx4",
        type: "expense",
        amountILS: 300,
        status: "paid",
        transactionDate: "2026-11-02",
        category: "Infrastructure",
      },
      {
        id: "tx5",
        type: "expense",
        amountILS: 150,
        status: "scheduled", // NOT recognized
        transactionDate: "2026-11-20",
      },
      {
        id: "tx6",
        type: "revenue",
        amountILS: 5000,
        status: "paid",
        transactionDate: "2026-10-15", // Prior month
      },
    ];

    const recurring = [
      {
        id: "rec1",
        type: "revenue",
        amountILS: 1200,
        frequency: "monthly",
        status: "active",
      },
      {
        id: "rec2",
        type: "expense",
        amountILS: 50,
        frequency: "monthly",
        status: "active",
      },
    ];

    const refDate = new Date("2026-11-07T12:00:00Z");
    const summary = calculateFinancialSummary(transactions, recurring, "current_month", refDate);

    // All time recognized
    expect(summary.totalRevenue).toBe(6000); // 1000 + 5000
    expect(summary.totalExpenses).toBe(300); // 300
    expect(summary.netProfit).toBe(5700);

    // Current month recognized (2026-11)
    expect(summary.monthlyRevenue).toBe(1000);
    expect(summary.monthlyExpenses).toBe(300);
    expect(summary.monthlyNetProfit).toBe(700);

    // Pending / Scheduled breakdown
    expect(summary.statusBreakdown.revenue.pending).toBe(500);
    expect(summary.statusBreakdown.revenue.scheduled).toBe(2000);
    expect(summary.statusBreakdown.expense.scheduled).toBe(150);

    // MRR
    expect(summary.activeMRR).toBe(1200);
    expect(summary.activeRecurringExpensesMonthly).toBe(50);
  });

  it("generates monthly chart buckets accurately", () => {
    const transactions = [
      { type: "revenue", amountILS: 1000, status: "paid", transactionDate: "2026-11-01" },
      { type: "expense", amountILS: 400, status: "paid", transactionDate: "2026-11-03" },
      { type: "revenue", amountILS: 2500, status: "paid", transactionDate: "2026-10-20" },
      { type: "expense", amountILS: 1000, status: "paid", transactionDate: "2026-10-25" },
    ];

    const chartData = generateMonthlyChartData(transactions, 3, new Date("2026-11-10T00:00:00Z"));
    expect(chartData).toHaveLength(3);

    const nov = chartData.find((b) => b.month === "2026-11");
    expect(nov.revenue).toBe(1000);
    expect(nov.expenses).toBe(400);
    expect(nov.netProfit).toBe(600);

    const oct = chartData.find((b) => b.month === "2026-10");
    expect(oct.revenue).toBe(2500);
    expect(oct.expenses).toBe(1000);
    expect(oct.netProfit).toBe(1500);
  });
});

