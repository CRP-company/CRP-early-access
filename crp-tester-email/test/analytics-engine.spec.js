import { describe, it, expect } from "vitest";
import {
  getCohortAgeDays,
  buildCohortRecord,
  calculateAggregatedRetention,
  buildInstallationRecord,
  aggregateInstallationMetrics,
} from "../src/analytics-engine.js";

describe("Analytics & Retention Engine", () => {
  const refDate = new Date("2026-11-07T12:00:00Z");

  it("calculates cohort age correctly", () => {
    // 7 days ago
    expect(getCohortAgeDays("2026-10-31", refDate)).toBe(7);
    // 30 days ago
    expect(getCohortAgeDays("2026-10-08", refDate)).toBe(30);
    // Today
    expect(getCohortAgeDays("2026-11-07", refDate)).toBe(0);
  });

  it("calculates mature D7 and D30 retention", () => {
    // Cohort from 35 days ago (mature for both D7 and D30)
    const mature = buildCohortRecord(
      {
        cohortDate: "2026-10-01",
        cohortSize: 200,
        d7ActiveUsers: 80, // 40%
        d30ActiveUsers: 50, // 25%
      },
      refDate,
    );

    expect(mature.d7Eligible).toBe(true);
    expect(mature.d7Retention).toBe(40.0);
    expect(mature.d30Eligible).toBe(true);
    expect(mature.d30Retention).toBe(25.0);
  });

  it("marks immature cohorts as pending (null) and NEVER as 0% retention", () => {
    // Cohort from 3 days ago (immature for both D7 and D30)
    const immature = buildCohortRecord(
      {
        cohortDate: "2026-11-04",
        cohortSize: 100,
        d7ActiveUsers: 0,
        d30ActiveUsers: 0,
      },
      refDate,
    );

    expect(immature.d7Eligible).toBe(false);
    expect(immature.d7Retention).toBeNull(); // Pending, not 0!
    expect(immature.d30Eligible).toBe(false);
    expect(immature.d30Retention).toBeNull();

    // Cohort from 15 days ago (mature for D7, but immature for D30)
    const midCohort = buildCohortRecord(
      {
        cohortDate: "2026-10-23",
        cohortSize: 100,
        d7ActiveUsers: 35,
        d30ActiveUsers: 0,
      },
      refDate,
    );

    expect(midCohort.d7Eligible).toBe(true);
    expect(midCohort.d7Retention).toBe(35.0);
    expect(midCohort.d30Eligible).toBe(false);
    expect(midCohort.d30Retention).toBeNull(); // D30 still pending!
  });

  it("aggregates retention across mature cohorts using size-weighted averages", () => {
    const cohorts = [
      {
        cohortDate: "2026-09-01",
        cohortSize: 100,
        d7Eligible: true,
        d7Retention: 40.0,
        d30Eligible: true,
        d30Retention: 20.0,
      },
      {
        cohortDate: "2026-09-15",
        cohortSize: 200,
        d7Eligible: true,
        d7Retention: 50.0,
        d30Eligible: true,
        d30Retention: 30.0,
      },
      {
        cohortDate: "2026-11-05", // Immature
        cohortSize: 150,
        d7Eligible: false,
        d7Retention: null,
        d30Eligible: false,
        d30Retention: null,
      },
    ];

    const agg = calculateAggregatedRetention(cohorts);
    // D7 weighted: (40*100 + 50*200) / 300 = 14000 / 300 = 46.7%
    expect(agg.d7Average).toBe(46.7);
    // D30 weighted: (20*100 + 30*200) / 300 = 8000 / 300 = 26.7%
    expect(agg.d30Average).toBe(26.7);
    expect(agg.matureCohortCount).toBe(2);
  });

  it("processes and aggregates Google Play installation records correctly", () => {
    const records = [
      buildInstallationRecord({
        date: "2026-11-01",
        firstTimeInstalls: 50,
        activeDeviceInstalls: 450,
        uninstalls: 5,
        reinstalls: 2,
      }),
      buildInstallationRecord({
        date: "2026-11-02",
        firstTimeInstalls: 75,
        activeDeviceInstalls: 510,
        uninstalls: 10,
        reinstalls: 5,
      }),
    ];

    expect(records[0].netDeviceInstalls).toBe(47); // 50 + 2 - 5

    const agg = aggregateInstallationMetrics(records);
    expect(agg.totalInstalls).toBe(125); // 50 + 75
    expect(agg.currentActiveDevices).toBe(510);
    expect(agg.dailyTrend).toHaveLength(2);
  });
});

