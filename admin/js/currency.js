/**
 * Currency conversion and formatting utilities for CRP Admin.
 *
 * Base reporting currency: ILS (₪).
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

  const rate = Number(exchangeRate) > 0 ? Number(exchangeRate) : getDefaultExchangeRate(code);
  return Math.round((num * rate + Number.EPSILON) * 100) / 100;
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

