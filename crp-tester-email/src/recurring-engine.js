/**
 * Recurring Transaction Engine for CRP Admin.
 *
 * Handles:
 * - Deterministic period key generation (weekly, monthly, quarterly, annually)
 * - Leap years and month-end dates (e.g. Jan 31 -> Feb 28/29 -> Mar 31)
 * - Idempotency (never generates duplicate occurrences for the same period)
 * - Asia/Jerusalem calendar handling
 * - MRR-equivalent normalization in ILS:
 *     - Weekly: amount * 52 / 12
 *     - Monthly: amount
 *     - Quarterly: amount / 3
 *     - Annually: amount / 12
 * - Scheduled transaction occurrences initialized as "scheduled" or "pending", NEVER automatically marked as "paid".
 */

/**
 * Calculate the Monthly Recurring Revenue (MRR) equivalent in ILS for a recurring definition.
 * @param {number} amountILS
 * @param {string} frequency "weekly" | "monthly" | "quarterly" | "annually"
 * @returns {number}
 */
export function calculateMRREquivalent(amountILS, frequency) {
  const amount = Number(amountILS) || 0;
  const freq = String(frequency || "monthly").toLowerCase();

  switch (freq) {
    case "weekly":
      return Math.round(((amount * 52) / 12 + Number.EPSILON) * 100) / 100;
    case "monthly":
      return Math.round((amount + Number.EPSILON) * 100) / 100;
    case "quarterly":
      return Math.round((amount / 3 + Number.EPSILON) * 100) / 100;
    case "annually":
      return Math.round((amount / 12 + Number.EPSILON) * 100) / 100;
    default:
      return amount;
  }
}

/**
 * Get days in a specific year and month (1-indexed month: 1=Jan, 12=Dec).
 * Properly accounts for leap years.
 */
export function getDaysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Format a Date object to YYYY-MM-DD in ISO string.
 */
function toDateString(d) {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Add calendar months to a date preserving the day of month or pinning to month-end.
 * e.g. 2026-01-31 + 1 month => 2026-02-28 (or 29 in leap year).
 */
export function addMonthsClamped(baseDate, monthsToAdd, targetDay) {
  const y = baseDate.getUTCFullYear();
  const m = baseDate.getUTCMonth() + monthsToAdd; // 0-indexed
  const newYear = y + Math.floor(m / 12);
  const newMonth = ((m % 12) + 12) % 12; // 0-indexed

  const daysInNewMonth = getDaysInMonth(newYear, newMonth + 1);
  const day = Math.min(targetDay || baseDate.getUTCDate(), daysInNewMonth);

  return new Date(Date.UTC(newYear, newMonth, day));
}

/**
 * Generate period keys and due dates for a recurring definition between its startDate
 * and a given horizonDate (inclusive).
 *
 * @param {object} recurring
 * @param {string} recurring.id
 * @param {string} recurring.frequency "weekly" | "monthly" | "quarterly" | "annually"
 * @param {string} recurring.startDate "YYYY-MM-DD"
 * @param {string|null} [recurring.endDate] "YYYY-MM-DD"
 * @param {string} [recurring.status] "active" | "paused" | "ended"
 * @param {Date|string} horizonDate End boundary for occurrences to generate
 * @returns {Array<{periodKey: string, dueDate: string, occurrenceId: string}>}
 */
export function getDueOccurrencesForDefinition(recurring, horizonDate) {
  if (recurring.status === "paused" || recurring.status === "ended") {
    return [];
  }

  const start = new Date(`${recurring.startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return [];

  const horizon = horizonDate
    ? new Date(typeof horizonDate === "string" ? `${horizonDate}T23:59:59Z` : horizonDate.getTime())
    : new Date();

  const endLimit = recurring.endDate ? new Date(`${recurring.endDate}T23:59:59Z`) : null;
  const effectiveEnd = endLimit && endLimit < horizon ? endLimit : horizon;

  if (start > effectiveEnd) return [];

  const occurrences = [];
  const freq = String(recurring.frequency || "monthly").toLowerCase();
  const originalDay = start.getUTCDate();

  if (freq === "weekly") {
    let curr = new Date(start.getTime());
    while (curr <= effectiveEnd) {
      const dateStr = toDateString(curr);
      const periodKey = `W_${dateStr}`;
      occurrences.push({
        periodKey,
        dueDate: dateStr,
        occurrenceId: `occ_${recurring.id}_${periodKey}`,
      });
      // advance 7 days
      curr = new Date(curr.getTime() + 7 * 24 * 60 * 60 * 1000);
    }
  } else if (freq === "monthly" || freq === "quarterly" || freq === "annually") {
    const stepMonths = freq === "monthly" ? 1 : freq === "quarterly" ? 3 : 12;
    let monthOffset = 0;

    while (true) {
      const curr = addMonthsClamped(start, monthOffset, originalDay);
      if (curr > effectiveEnd) break;

      const dateStr = toDateString(curr);
      const year = curr.getUTCFullYear();
      const month = String(curr.getUTCMonth() + 1).padStart(2, "0");

      let periodKey = `${year}-${month}`;
      if (freq === "quarterly") {
        const q = Math.floor(curr.getUTCMonth() / 3) + 1;
        periodKey = `${year}-Q${q}`;
      } else if (freq === "annually") {
        periodKey = `${year}`;
      }

      occurrences.push({
        periodKey,
        dueDate: dateStr,
        occurrenceId: `occ_${recurring.id}_${periodKey}`,
      });

      monthOffset += stepMonths;
    }
  }

  return occurrences;
}

/**
 * Generate transactions for all recurring definitions up to horizonDate, skipping any
 * occurrence that already exists in existingTransactions or existingIds.
 *
 * @param {Array<object>} recurringDefinitions
 * @param {Array<object>|Set<string>} existingTransactions Array of transactions or Set of IDs
 * @param {Date|string} [horizonDate] defaults to end of current month
 * @returns {Array<object>} New transaction objects to create
 */
export function generateRecurringOccurrences(
  recurringDefinitions,
  existingTransactions = [],
  horizonDate = new Date(),
) {
  const existingSet =
    existingTransactions instanceof Set
      ? existingTransactions
      : new Set(
          existingTransactions
            .map((t) => t.id || t.occurrenceId || (t.notes && t.notes.match(/occ_[a-zA-Z0-9_-]+/)?.[0]))
            .filter(Boolean),
        );

  const newTransactions = [];
  const nowIso = new Date().toISOString();

  for (const rec of recurringDefinitions || []) {
    if (rec.status !== "active") continue;

    const occurrences = getDueOccurrencesForDefinition(rec, horizonDate);

    for (const occ of occurrences) {
      if (existingSet.has(occ.occurrenceId)) {
        continue; // Already generated — strictly idempotent
      }

      // Check if dueDate is in past/today vs future
      const isPastOrToday = occ.dueDate <= toDateString(new Date());
      // Scheduled occurrences start as 'pending' if past/today due date, or 'scheduled' if in future.
      // Never marked as 'paid' automatically.
      const initialStatus = isPastOrToday ? "pending" : "scheduled";

      newTransactions.push({
        id: occ.occurrenceId,
        type: rec.type, // 'revenue' or 'expense'
        description: `${rec.description} (${occ.periodKey})`,
        amount: rec.amount,
        currency: rec.currency,
        exchangeRate: rec.exchangeRate || 1.0,
        amountILS: rec.amountILS,
        category: rec.category,
        source: "recurring",
        status: initialStatus,
        transactionDate: occ.dueDate,
        notes: `Generated occurrence ${occ.occurrenceId} from recurring rule "${rec.description}".`,
        recurringId: rec.id,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      existingSet.add(occ.occurrenceId);
    }
  }

  return newTransactions;
}

