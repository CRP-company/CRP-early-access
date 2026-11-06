/**
 * Google Play Installation Analytics & Firebase Analytics Retention Engine for CRP Focus.
 *
 * Responsibilities:
 * - Google Play daily installation tracking (first-time installs, active devices, uninstalls).
 * - Distinguishes between first-time installs and active device installs.
 * - Cohort retention calculation (D7 and D30) based on `first_open` cohort entry date.
 * - Maturity guards: Incomplete cohorts display as pending/unavailable, NEVER as 0% retention.
 * - Distinct population tracking: Clearly separates Google Play installations from Analytics cohorts.
 * - Time-series aggregation for installation and retention trend charts.
 */

/**
 * Calculate cohort age in full days elapsed since cohortDate.
 * @param {string} cohortDateStr YYYY-MM-DD
 * @param {Date} [now]
 * @returns {number}
 */
export function getCohortAgeDays(cohortDateStr, now = new Date()) {
  const cohortDate = new Date(`${cohortDateStr}T00:00:00Z`);
  if (Number.isNaN(cohortDate.getTime())) return 0;
  const diffMs = now.getTime() - cohortDate.getTime();
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * Process raw cohort parameters into a standardized, mature cohort record.
 *
 * @param {object} input
 * @param {string} input.cohortDate YYYY-MM-DD
 * @param {number} input.cohortSize Number of users who first opened the app on this date
 * @param {number} [input.d7ActiveUsers] Users active on Day 7
 * @param {number} [input.d30ActiveUsers] Users active on Day 30
 * @param {string} [input.source]
 * @param {Date} [referenceDate]
 * @returns {object} Processed cohort snapshot
 */
export function buildCohortRecord(input, referenceDate = new Date()) {
  const cohortDate = String(input.cohortDate || "").trim();
  const cohortSize = Math.max(0, Number(input.cohortSize) || 0);
  const ageDays = getCohortAgeDays(cohortDate, referenceDate);

  // D7 is only eligible once 7 full days have elapsed
  const d7Eligible = ageDays >= 7 && cohortSize > 0;
  const d7Active = Math.max(0, Number(input.d7ActiveUsers) || 0);
  const d7Retention = d7Eligible
    ? Math.round(((d7Active / cohortSize) * 100 + Number.EPSILON) * 10) / 10
    : null;

  // D30 is only eligible once 30 full days have elapsed
  const d30Eligible = ageDays >= 30 && cohortSize > 0;
  const d30Active = Math.max(0, Number(input.d30ActiveUsers) || 0);
  const d30Retention = d30Eligible
    ? Math.round(((d30Active / cohortSize) * 100 + Number.EPSILON) * 10) / 10
    : null;

  return {
    cohortDate,
    cohortSize,
    ageDays,
    d7Eligible,
    d7ActiveUsers: d7Eligible ? d7Active : null,
    d7Retention, // null if immature, never misleading 0%
    d30Eligible,
    d30ActiveUsers: d30Eligible ? d30Active : null,
    d30Retention, // null if immature, never misleading 0%
    source: input.source || "firebase_analytics",
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Aggregate cohort retention metrics across mature cohorts.
 *
 * @param {Array<object>} cohorts List of cohort records
 * @returns {{d7Average: number|null, d30Average: number|null, matureCohortCount: number}}
 */
export function calculateAggregatedRetention(cohorts = []) {
  let d7WeightedSum = 0;
  let d7TotalSize = 0;

  let d30WeightedSum = 0;
  let d30TotalSize = 0;

  let matureCount = 0;

  for (const c of cohorts) {
    if (c.d7Eligible && typeof c.d7Retention === "number" && c.cohortSize > 0) {
      d7WeightedSum += c.d7Retention * c.cohortSize;
      d7TotalSize += c.cohortSize;
      matureCount += 1;
    }
    if (c.d30Eligible && typeof c.d30Retention === "number" && c.cohortSize > 0) {
      d30WeightedSum += c.d30Retention * c.cohortSize;
      d30TotalSize += c.cohortSize;
    }
  }

  const d7Average =
    d7TotalSize > 0 ? Math.round(((d7WeightedSum / d7TotalSize) + Number.EPSILON) * 10) / 10 : null;

  const d30Average =
    d30TotalSize > 0 ? Math.round(((d30WeightedSum / d30TotalSize) + Number.EPSILON) * 10) / 10 : null;

  return {
    d7Average,
    d30Average,
    matureCohortCount: matureCount,
  };
}

/**
 * Process a daily Google Play installation report entry.
 *
 * @param {object} input
 * @param {string} input.date YYYY-MM-DD
 * @param {number} input.firstTimeInstalls
 * @param {number} [input.activeDeviceInstalls]
 * @param {number} [input.uninstalls]
 * @param {number} [input.reinstalls]
 * @param {string} [input.source]
 * @returns {object}
 */
export function buildInstallationRecord(input) {
  const date = String(input.date || "").trim();
  const firstTimeInstalls = Math.max(0, Number(input.firstTimeInstalls) || 0);
  const activeDeviceInstalls = Math.max(0, Number(input.activeDeviceInstalls) || 0);
  const uninstalls = Math.max(0, Number(input.uninstalls) || 0);
  const reinstalls = Math.max(0, Number(input.reinstalls) || 0);
  const netDeviceInstalls = firstTimeInstalls + reinstalls - uninstalls;

  return {
    date,
    firstTimeInstalls,
    activeDeviceInstalls,
    uninstalls,
    reinstalls,
    netDeviceInstalls,
    source: input.source || "google_play_console",
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Aggregate total Google Play installations and generate chart trend.
 *
 * @param {Array<object>} installations List of daily installation records
 * @returns {{totalInstalls: number, currentActiveDevices: number, dailyTrend: Array<object>}}
 */
export function aggregateInstallationMetrics(installations = []) {
  const sorted = [...installations].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  let totalInstalls = 0;
  let latestActiveDevices = 0;

  const dailyTrend = [];

  for (const item of sorted) {
    totalInstalls += Number(item.firstTimeInstalls) || 0;
    if (item.activeDeviceInstalls) {
      latestActiveDevices = Number(item.activeDeviceInstalls);
    }

    dailyTrend.push({
      date: item.date,
      firstTimeInstalls: Number(item.firstTimeInstalls) || 0,
      activeDevices: Number(item.activeDeviceInstalls) || 0,
      uninstalls: Number(item.uninstalls) || 0,
    });
  }

  return {
    totalInstalls,
    currentActiveDevices: latestActiveDevices,
    dailyTrend,
  };
}

