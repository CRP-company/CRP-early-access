import { describe, it, expect } from "vitest";
import {
  getDaysInMonth,
  addMonthsClamped,
  getDueOccurrencesForDefinition,
  generateRecurringOccurrences,
} from "../src/recurring-engine.js";

describe("Recurring Transaction Engine", () => {
  it("accurately computes days in month including leap years", () => {
    expect(getDaysInMonth(2026, 2)).toBe(28); // Not leap
    expect(getDaysInMonth(2024, 2)).toBe(29); // Leap year
    expect(getDaysInMonth(2028, 2)).toBe(29); // Leap year
    expect(getDaysInMonth(2026, 1)).toBe(31);
    expect(getDaysInMonth(2026, 4)).toBe(30);
  });

  it("handles month-end clamping (e.g. Jan 31 -> Feb 28 -> Mar 31)", () => {
    const jan31 = new Date("2026-01-31T00:00:00Z");
    const feb = addMonthsClamped(jan31, 1, 31);
    expect(feb.toISOString().split("T")[0]).toBe("2026-02-28");

    const mar = addMonthsClamped(jan31, 2, 31);
    expect(mar.toISOString().split("T")[0]).toBe("2026-03-31");

    const apr = addMonthsClamped(jan31, 3, 31);
    expect(apr.toISOString().split("T")[0]).toBe("2026-04-30");
  });

  it("generates monthly occurrences up to horizon date", () => {
    const rec = {
      id: "rec_firebase",
      type: "expense",
      description: "Firebase Subscription",
      amount: 150,
      currency: "ILS",
      amountILS: 150,
      frequency: "monthly",
      startDate: "2026-08-01",
      status: "active",
    };

    const occurrences = getDueOccurrencesForDefinition(rec, "2026-11-01");
    // Should have Aug, Sep, Oct, Nov = 4 occurrences
    expect(occurrences).toHaveLength(4);
    expect(occurrences[0].periodKey).toBe("2026-08");
    expect(occurrences[0].occurrenceId).toBe("occ_rec_firebase_2026-08");
    expect(occurrences[3].periodKey).toBe("2026-11");
    expect(occurrences[3].occurrenceId).toBe("occ_rec_firebase_2026-11");
  });

  it("generates weekly, quarterly, and annual occurrences properly", () => {
    // Weekly
    const recWeekly = {
      id: "rec_weekly",
      type: "revenue",
      frequency: "weekly",
      startDate: "2026-11-01",
      status: "active",
    };
    const weeklyOccs = getDueOccurrencesForDefinition(recWeekly, "2026-11-16");
    // 2026-11-01, 2026-11-08, 2026-11-15 = 3
    expect(weeklyOccs).toHaveLength(3);

    // Quarterly
    const recQ = {
      id: "rec_q",
      type: "expense",
      frequency: "quarterly",
      startDate: "2026-01-01",
      status: "active",
    };
    const qOccs = getDueOccurrencesForDefinition(recQ, "2026-07-01");
    // Q1, Q2, Q3 = 3
    expect(qOccs).toHaveLength(3);
    expect(qOccs[0].periodKey).toBe("2026-Q1");
    expect(qOccs[1].periodKey).toBe("2026-Q2");
    expect(qOccs[2].periodKey).toBe("2026-Q3");

    // Annual
    const recAnnual = {
      id: "rec_annual",
      type: "expense",
      frequency: "annually",
      startDate: "2024-05-10",
      status: "active",
    };
    const annOccs = getDueOccurrencesForDefinition(recAnnual, "2026-06-01");
    // 2024, 2025, 2026 = 3
    expect(annOccs).toHaveLength(3);
    expect(annOccs[0].periodKey).toBe("2024");
    expect(annOccs[2].periodKey).toBe("2026");
  });

  it("respects paused and ended statuses (generates zero occurrences)", () => {
    const paused = {
      id: "rec_p",
      startDate: "2026-01-01",
      frequency: "monthly",
      status: "paused",
    };
    expect(getDueOccurrencesForDefinition(paused, "2026-11-01")).toHaveLength(0);

    const ended = {
      id: "rec_e",
      startDate: "2026-01-01",
      frequency: "monthly",
      status: "ended",
    };
    expect(getDueOccurrencesForDefinition(ended, "2026-11-01")).toHaveLength(0);
  });

  it("respects optional endDate", () => {
    const rec = {
      id: "rec_term",
      frequency: "monthly",
      startDate: "2026-01-01",
      endDate: "2026-03-15",
      status: "active",
    };
    const occs = getDueOccurrencesForDefinition(rec, "2026-12-31");
    // Jan, Feb, Mar = 3
    expect(occs).toHaveLength(3);
    expect(occs[2].periodKey).toBe("2026-03");
  });

  it("generates transactions idempotently without duplicates", () => {
    const recs = [
      {
        id: "rec_hosting",
        type: "expense",
        description: "Cloudflare Workers Paid",
        amount: 20,
        currency: "USD",
        exchangeRate: 3.65,
        amountILS: 73,
        frequency: "monthly",
        startDate: "2026-09-01",
        status: "active",
      },
    ];

    const horizon = "2026-11-05";

    // First run
    const batch1 = generateRecurringOccurrences(recs, [], horizon);
    // Sep, Oct, Nov = 3
    expect(batch1).toHaveLength(3);
    expect(batch1[0].id).toBe("occ_rec_hosting_2026-09");
    expect(batch1[0].status).toBe("pending"); // Past due date starts as pending, NEVER paid

    // Second run with existing transactions
    const batch2 = generateRecurringOccurrences(recs, batch1, horizon);
    expect(batch2).toHaveLength(0); // Strictly zero duplicates!
  });
});

