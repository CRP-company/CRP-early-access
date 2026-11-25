/**
 * Currency conversion and formatting utilities for CRP Admin.
 *
 * Base reporting currency: ILS (₪).
 *
 * Requirements:
 * - ILS is the base currency (rate = 1.0).
 * - Every transaction preserves original amount, original currency, exchange rate, and converted ILS amount.
 * - Historical exchange rates are frozen at transaction creation and never silently recalculated.
 * - Foreign-currency transactions REQUIRE an explicitly confirmed exchange rate or verified settlement conversion.
 * - Default reference rates are strictly for display reference; they are NEVER silently used to finalize foreign conversions.
 */

export const BASE_CURRENCY = "ILS";

export const DEFAULT_EXCHANGE_RATES = {
  ILS: 1.0,
  USD: 3.65,
  EUR: 3.95,
  GBP: 4.65,
};

export function getDefaultExchangeRate(currency) {
  const code = String(currency || "").toUpperCase().trim();
  if (code === BASE_CURRENCY) return 1.0;
  return DEFAULT_EXCHANGE_RATES[code] || 1.0;
}

export function normalizeToILS(amount, currency, exchangeRate) {
  const num = Number(amount);
  if (!Number.isFinite(num)) return 0;

  const code = String(currency || "").toUpperCase().trim();
  if (code === BASE_CURRENCY) {
    return Math.round((num + Number.EPSILON) * 100) / 100;
  }

  const rate = Number(exchangeRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    return null;
  }
  return Math.round((num * rate + Number.EPSILON) * 100) / 100;
}

export function inspectCurrencySafety(record = {}) {
  const currency = String(record.currency || BASE_CURRENCY).toUpperCase().trim();
  const amount = Number(record.amount) || 0;
  const rate = Number(record.exchangeRate);
  const amountILS = record.amountILS != null ? Number(record.amountILS) : null;

  if (currency === BASE_CURRENCY) {
    return {
      confirmed: true,
      rateSource: "base_currency",
      exchangeRate: 1.0,
      amountILS: Math.round((amount + Number.EPSILON) * 100) / 100,
    };
  }

  if (record.rateSource === "settlement" && Number.isFinite(rate) && rate > 0) {
    return {
      confirmed: true,
      rateSource: "settlement",
      exchangeRate: rate,
      amountILS,
    };
  }

  if (record.rateSource === "explicit" && Number.isFinite(rate) && rate > 0) {
    return {
      confirmed: true,
      rateSource: "explicit",
      exchangeRate: rate,
      amountILS,
    };
  }

  if (Number.isFinite(rate) && rate > 0) {
    const isDefault = rate === DEFAULT_EXCHANGE_RATES[currency];
    const source = record.rateSource || (isDefault ? "fallback" : "explicit");
    return {
      confirmed: source !== "fallback",
      rateSource: source,
      exchangeRate: rate,
      amountILS,
      reason: source === "fallback" ? "Transaction was saved using an unconfirmed fallback exchange rate." : undefined,
    };
  }

  return {
    confirmed: false,
    rateSource: "unconfirmed",
    exchangeRate: null,
    amountILS: null,
    reason: `Missing exchange rate for foreign currency ${currency}. Explicit confirmation is required.`,
  };
}

export function formatILS(amount) {
  const num = Number(amount) || 0;
  return `₪${num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatCurrency(amount, currency) {
  const num = Number(amount) || 0;
  const code = String(currency || "ILS").toUpperCase().trim();
  const formatted = num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  switch (code) {
    case "ILS":
      return `₪${formatted}`;
    case "USD":
      return `$${formatted}`;
    case "EUR":
      return `€${formatted}`;
    case "GBP":
      return `£${formatted}`;
    default:
      return `${formatted} ${code}`;
  }
}
