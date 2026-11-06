/**
 * Currency conversion and formatting utilities for CRP Admin Financial Dashboard.
 *
 * Base reporting currency: ILS (₪).
 *
 * Requirements:
 * - ILS is the base currency (rate = 1.0).
 * - Every transaction preserves original amount, original currency, exchange rate, and converted ILS amount.
 * - Historical exchange rates are frozen at transaction creation and never silently recalculated.
 */

export const BASE_CURRENCY = "ILS";

export const SUPPORTED_CURRENCIES = ["ILS", "USD", "EUR", "GBP"];

// Standard reference rates (ILS per 1 unit of foreign currency).
// In production, live rates can be fetched or manually configured per transaction.
export const DEFAULT_EXCHANGE_RATES = {
  ILS: 1.0,
  USD: 3.65,
  EUR: 3.95,
  GBP: 4.65,
};

/**
 * Get the default reference exchange rate for a given currency to ILS.
 * @param {string} currency e.g. "USD", "EUR", "ILS"
 * @returns {number} Exchange rate (ILS per unit)
 */
export function getDefaultExchangeRate(currency) {
  const code = String(currency || "").toUpperCase().trim();
  if (code === BASE_CURRENCY) return 1.0;
  return DEFAULT_EXCHANGE_RATES[code] || 1.0;
}

/**
 * Convert an amount from an original currency to ILS using the given exchange rate.
 * @param {number} amount Original currency amount
 * @param {string} currency Original currency code
 * @param {number} [exchangeRate] Specific exchange rate used at time of transaction
 * @returns {number} Normalized ILS amount rounded to 2 decimal places
 */
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

/**
 * Format a number in ILS currency format (e.g. ₪1,234.50).
 * @param {number} amount
 * @returns {string}
 */
export function formatILS(amount) {
  const num = Number(amount) || 0;
  return `₪${num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Format an amount with its currency symbol/code.
 * @param {number} amount
 * @param {string} currency
 * @returns {string}
 */
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

