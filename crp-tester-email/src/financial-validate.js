/**
 * Server-side input validation for financial transactions, recurring definitions,
 * and categories.
 *
 * Enforces:
 * - Explicit exchange rate confirmation for foreign-currency transactions.
 * - Prevents finalizing transactions without confirmed rates.
 * - Granular status validation including 'partially_refunded'.
 * - Preserves refund and order association fields (orderId, parentTransactionId, isRefund).
 */

import { BASE_CURRENCY, normalizeToILS, getDefaultExchangeRate } from "./currency.js";

export const TRANSACTION_TYPES = ["revenue", "expense"];

export const TRANSACTION_STATUSES = [
  "paid",
  "pending",
  "scheduled",
  "cancelled",
  "refunded",
  "partially_refunded",
];

export const RECURRING_FREQUENCIES = [
  "weekly",
  "monthly",
  "quarterly",
  "annually",
];

export const RECURRING_STATUSES = ["active", "paused", "ended"];

export const DEFAULT_REVENUE_CATEGORIES = [
  "Hardware",
  "CUBY sale",
  "Software & Services",
  "Subscription",
  "Consulting",
  "Other Income",
];

export const DEFAULT_EXPENSE_CATEGORIES = [
  "Infrastructure",
  "APIs and AI",
  "Hardware",
  "Marketing",
  "Software",
  "Domains and Hosting",
  "Operations",
  "Other",
];

/**
 * Validate a transaction payload (revenue or expense).
 * @param {object} input
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateTransaction(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Missing transaction payload." };
  }

  const type = String(input.type || "").trim().toLowerCase();
  if (!TRANSACTION_TYPES.includes(type)) {
    return { ok: false, error: `Type must be one of: ${TRANSACTION_TYPES.join(", ")}.` };
  }

  const description = String(input.description || "").trim();
  if (!description || description.length > 250) {
    return { ok: false, error: "Description must be between 1 and 250 characters." };
  }

  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Amount must be a positive number." };
  }

  const currency = String(input.currency || BASE_CURRENCY).trim().toUpperCase();
  if (!currency || currency.length > 10) {
    return { ok: false, error: "Invalid currency code." };
  }

  const status = String(input.status || "paid").trim().toLowerCase();
  if (!TRANSACTION_STATUSES.includes(status)) {
    return { ok: false, error: `Status must be one of: ${TRANSACTION_STATUSES.join(", ")}.` };
  }

  let exchangeRate = Number(input.exchangeRate);
  let rateSource = input.rateSource || "explicit";
  let rateConfirmed = false;
  let amountILS = null;

  if (currency === BASE_CURRENCY) {
    exchangeRate = 1.0;
    rateSource = "base_currency";
    rateConfirmed = true;
    amountILS = normalizeToILS(amount, "ILS", 1.0);
  } else if (Number.isFinite(exchangeRate) && exchangeRate > 0) {
    rateConfirmed = true;
    amountILS = normalizeToILS(amount, currency, exchangeRate);
  } else {
    // Foreign currency with no valid confirmed exchange rate
    if (status === "paid" || status === "partially_refunded") {
      return {
        ok: false,
        error: `An explicitly confirmed exchange rate is required for foreign currency (${currency}) transactions before they can be finalized. Please enter the exchange rate (ILS per 1 ${currency}).`,
      };
    }
    // Draft or pending transactions can be saved as unconfirmed
    exchangeRate = null;
    rateSource = "unconfirmed";
    rateConfirmed = false;
    amountILS = null;
  }

  const category = String(input.category || "Other").trim();
  if (!category || category.length > 80) {
    return { ok: false, error: "Category cannot be empty or exceed 80 characters." };
  }

  const source = String(input.source || "manual").trim().toLowerCase();

  // Transaction date: YYYY-MM-DD or full ISO
  const rawDate = input.transactionDate || input.date;
  let transactionDate = new Date().toISOString().split("T")[0];
  if (rawDate) {
    const parsed = new Date(rawDate);
    if (!Number.isNaN(parsed.getTime())) {
      transactionDate = parsed.toISOString().split("T")[0];
    }
  }

  const notes = String(input.notes || "").trim().slice(0, 1000);
  const recurringId = input.recurringId ? String(input.recurringId).trim() : null;
  const externalId = input.externalId ? String(input.externalId).trim() : null;
  const orderId = input.orderId ? String(input.orderId).trim() : null;
  const parentTransactionId = input.parentTransactionId ? String(input.parentTransactionId).trim() : null;
  const isRefund = Boolean(input.isRefund);

  const originalGrossAmount = input.originalGrossAmount != null ? Number(input.originalGrossAmount) : amount;
  const originalGrossAmountILS = input.originalGrossAmountILS != null ? Number(input.originalGrossAmountILS) : amountILS;
  const totalRefunded = Number(input.totalRefunded) || 0;
  const totalRefundedILS = Number(input.totalRefundedILS) || 0;
  const netAmount = input.netAmount != null ? Number(input.netAmount) : Math.max(0, originalGrossAmount - totalRefunded);
  const netAmountILS = input.netAmountILS != null ? Number(input.netAmountILS) : (amountILS != null ? Math.max(0, amountILS - totalRefundedILS) : null);

  return {
    ok: true,
    value: {
      type,
      description,
      amount,
      currency,
      exchangeRate,
      rateSource,
      rateConfirmed,
      amountILS,
      originalGrossAmount,
      originalGrossAmountILS,
      totalRefunded,
      totalRefundedILS,
      netAmount,
      netAmountILS,
      isRefund,
      orderId,
      parentTransactionId,
      category,
      source,
      status,
      transactionDate,
      notes,
      recurringId,
      externalId,
    },
  };
}

/**
 * Validate a recurring definition payload.
 * @param {object} input
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateRecurringDefinition(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Missing recurring definition payload." };
  }

  const type = String(input.type || "").trim().toLowerCase();
  if (!TRANSACTION_TYPES.includes(type)) {
    return { ok: false, error: `Type must be one of: ${TRANSACTION_TYPES.join(", ")}.` };
  }

  const description = String(input.description || "").trim();
  if (!description || description.length > 250) {
    return { ok: false, error: "Description must be between 1 and 250 characters." };
  }

  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Amount must be a positive number." };
  }

  const currency = String(input.currency || BASE_CURRENCY).trim().toUpperCase();
  const status = String(input.status || "active").trim().toLowerCase();
  if (!RECURRING_STATUSES.includes(status)) {
    return { ok: false, error: `Status must be one of: ${RECURRING_STATUSES.join(", ")}.` };
  }

  let exchangeRate = Number(input.exchangeRate);
  let rateSource = input.rateSource || "explicit";
  let rateConfirmed = false;
  let amountILS = null;

  if (currency === BASE_CURRENCY) {
    exchangeRate = 1.0;
    rateSource = "base_currency";
    rateConfirmed = true;
    amountILS = normalizeToILS(amount, "ILS", 1.0);
  } else if (Number.isFinite(exchangeRate) && exchangeRate > 0) {
    rateConfirmed = true;
    amountILS = normalizeToILS(amount, currency, exchangeRate);
  } else {
    if (status === "active") {
      return {
        ok: false,
        error: `An explicitly confirmed exchange rate is required for foreign currency (${currency}) recurring rules before they can be activated.`,
      };
    }
    exchangeRate = null;
    rateSource = "unconfirmed";
    rateConfirmed = false;
    amountILS = null;
  }

  const frequency = String(input.frequency || "monthly").trim().toLowerCase();
  if (!RECURRING_FREQUENCIES.includes(frequency)) {
    return {
      ok: false,
      error: `Frequency must be one of: ${RECURRING_FREQUENCIES.join(", ")}.`,
    };
  }

  const category = String(input.category || "Other").trim();

  // Start date
  let startDate = new Date().toISOString().split("T")[0];
  if (input.startDate) {
    const parsed = new Date(input.startDate);
    if (!Number.isNaN(parsed.getTime())) {
      startDate = parsed.toISOString().split("T")[0];
    }
  }

  let endDate = null;
  if (input.endDate) {
    const parsedEnd = new Date(input.endDate);
    if (!Number.isNaN(parsedEnd.getTime())) {
      endDate = parsedEnd.toISOString().split("T")[0];
    }
  }

  return {
    ok: true,
    value: {
      type,
      description,
      amount,
      currency,
      exchangeRate,
      rateSource,
      rateConfirmed,
      amountILS,
      frequency,
      category,
      status,
      startDate,
      endDate,
    },
  };
}
