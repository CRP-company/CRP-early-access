import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { webcrypto } from "node:crypto";
import {
  decodeReportBuffer,
  parseGooglePlayCsv,
  findDimensionHeader,
  isTotalOrAggregateRow,
  mapGooglePlayRowToRecord,
  aggregateDimensionRows,
  getGooglePlayStorageToken,
  listGooglePlayReports,
  downloadGooglePlayReport,
  syncGooglePlayReports,
  sanitizeErrorMessage,
  __resetPlayTokenCache,
  SUPPORTED_DIMENSIONS,
  DIMENSION_PREFERENCE_ORDER,
  SubrequestBudget,
  DEFAULT_PACKAGE_NAME,
} from "../src/google-play.js";

vi.stubGlobal("crypto", webcrypto);

let testKeyPair;
let privateKeyPem;
let testSaJson;

beforeAll(async () => {
  testKeyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  const pkcs8 = await crypto.subtle.exportKey("pkcs8", testKeyPair.privateKey);
  const b64 = Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n");
  privateKeyPem = "-----BEGIN PRIVATE KEY-----\n" + b64 + "\n-----END PRIVATE KEY-----\n";

  testSaJson = JSON.stringify({
    project_id: "crp-cuby-display",
    client_email: "crp-play-reporter@crp-cuby-display.iam.gserviceaccount.com",
    private_key: privateKeyPem,
  });
});

beforeEach(() => {
  __resetPlayTokenCache();
  vi.restoreAllMocks();
});

describe("Google Play Bulk Reports Ingestion Engine", () => {
  describe("SubrequestBudget Guard", () => {
    it("tracks outgoing subrequest budget and enforces limits", () => {
      const budget = new SubrequestBudget(50, 3);
      expect(budget.limit).toBe(50);
      expect(budget.remaining).toBe(50);
      expect(budget.canAfford(47)).toBe(true);
      expect(budget.canAfford(48)).toBe(false); // 48 + 3 > 50

      budget.recordRequest(10);
      expect(budget.used).toBe(10);
      expect(budget.remaining).toBe(40);
      expect(budget.canAfford(37)).toBe(true);
      expect(budget.canAfford(38)).toBe(false);
    });
  });

  describe("sanitizeErrorMessage", () => {
    it("redacts bearer tokens, private keys, and long hashes from errors", () => {
      const raw =
        "Error at Bearer ya29.a0AfH6SM... with -----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----";
      const sanitized = sanitizeErrorMessage(raw);
      expect(sanitized).not.toContain("ya29.");
      expect(sanitized).toContain("Bearer [REDACTED]");
      expect(sanitized).toContain("[REDACTED_KEY]");
      expect(sanitized.length).toBeLessThanOrEqual(500);
    });

    it("returns null for null or empty input", () => {
      expect(sanitizeErrorMessage(null)).toBeNull();
      expect(sanitizeErrorMessage("")).toBeNull();
    });
  });

  describe("decodeReportBuffer", () => {
    it("decodes UTF-16LE reports with BOM (Google Play standard format)", () => {
      const text = "Date,Daily Device Installs\n2026-11-01,10";
      const u16 = new Uint16Array(text.length + 1);
      u16[0] = 0xfeff; // BOM
      for (let i = 0; i < text.length; i++) {
        u16[i + 1] = text.charCodeAt(i);
      }
      expect(decodeReportBuffer(u16.buffer)).toBe(text);
    });

    it("decodes UTF-16BE reports with BOM", () => {
      const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69]);
      expect(decodeReportBuffer(bytes)).toBe("Hi");
    });

    it("decodes UTF-8 reports with BOM", () => {
      const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
      expect(decodeReportBuffer(bytes)).toBe("Hello");
    });

    it("decodes standard UTF-8 without BOM", () => {
      const text = "Date,Daily Device Installs\n2026-11-05,25";
      const bytes = new TextEncoder().encode(text);
      expect(decodeReportBuffer(bytes)).toBe(text);
    });

    it("returns empty string for empty buffer", () => {
      expect(decodeReportBuffer(new Uint8Array([]))).toBe("");
      expect(decodeReportBuffer(new ArrayBuffer(0))).toBe("");
    });
  });

  describe("parseGooglePlayCsv", () => {
    it("parses valid CSV rows with official Google Play headers", () => {
      const csv =
        "Date,Package Name,Country,Daily Device Installs,Daily Device Uninstalls,Current Device Installs,Installs on active devices,Install events\n" +
        "2026-11-01,com.crp.focus,US,15,2,1200,980,18\n" +
        "2026-11-02,com.crp.focus,US,22,1,1221,995,25\n";
      const records = parseGooglePlayCsv(csv);
      expect(records).toHaveLength(2);
      expect(records[0]).toEqual({
        Date: "2026-11-01",
        "Package Name": "com.crp.focus",
        Country: "US",
        "Daily Device Installs": "15",
        "Daily Device Uninstalls": "2",
        "Current Device Installs": "1200",
        "Installs on active devices": "980",
        "Install events": "18",
      });
    });

    it("handles quoted fields containing commas and quotes safely", () => {
      const csv = `Date,Description,Notes\n2026-11-03,"CUBY Display, Black","Quote: ""Verified"""\n`;
      const records = parseGooglePlayCsv(csv);
      expect(records).toHaveLength(1);
      expect(records[0].Description).toBe("CUBY Display, Black");
      expect(records[0].Notes).toBe('Quote: "Verified"');
    });

    it("handles CRLF newlines correctly (standard Windows export in Play Console)", () => {
      const csv = "Date,Daily Device Installs\r\n2026-11-01,5\r\n2026-11-02,12\r\n";
      const records = parseGooglePlayCsv(csv);
      expect(records).toHaveLength(2);
      expect(records[0].Date).toBe("2026-11-01");
      expect(records[1].Date).toBe("2026-11-02");
    });

    it("strips leading BOM character from headers if present", () => {
      const csv = "\uFEFFDate,Daily Device Installs\n2026-11-01,30\n";
      const records = parseGooglePlayCsv(csv);
      expect(records).toHaveLength(1);
      expect(records[0]["Date"]).toBe("2026-11-01");
      expect(records[0]["\uFEFFDate"]).toBeUndefined();
    });

    it("returns empty array for empty or header-only CSV", () => {
      expect(parseGooglePlayCsv("")).toEqual([]);
      expect(parseGooglePlayCsv("   \n\n  ")).toEqual([]);
      expect(parseGooglePlayCsv("Date,Daily Device Installs\n")).toEqual([]);
    });
  });

  describe("mapGooglePlayRowToRecord - Metric Semantics & Separation", () => {
    it("SEPARATE METRICS: preserves Current Device Installs and Installs on active devices distinctly", () => {
      const row = {
        Date: "2026-11-10",
        "Package Name": "com.crp.focus",
        "Daily Device Installs": "50",
        "Daily Device Uninstalls": "8",
        "Current Device Installs": "1450", // Cumulative installed base
        "Installs on active devices": "1120", // 30-day active devices
        "Install events": "58",
      };

      const record = mapGooglePlayRowToRecord(row, "com.crp.focus");
      expect(record).not.toBeNull();
      expect(record.date).toBe("2026-11-10");
      expect(record.firstTimeInstalls).toBe(50);
      expect(record.currentDeviceInstalls).toBe(1450); // Preserved distinctly
      expect(record.installsOnActiveDevices).toBe(1120); // Preserved distinctly
      expect(record.activeDeviceInstalls).toBe(1120); // Dashboard active-device KPI maps to 30-day active devices
      expect(record.uninstalls).toBe(8);
      expect(record.installEvents).toBe(58);
      expect(record.source).toBe("google_play_bulk_report");
    });

    it("METRIC SEPARATION: Daily Device Installs is NOT mixed with Daily User Installs", () => {
      const mixedRow = {
        Date: "2026-11-11",
        "Package Name": "com.crp.focus",
        "Daily Device Installs": "30",
        "Daily User Installs": "22", // Separate user metric
        "Current Device Installs": "1200",
        "Installs on active devices": "950",
      };

      const record = mapGooglePlayRowToRecord(mixedRow, "com.crp.focus");
      expect(record.firstTimeInstalls).toBe(30);
      expect(record.dailyUserInstalls).toBe(22);
      expect(record.currentDeviceInstalls).toBe(1200);
      expect(record.installsOnActiveDevices).toBe(950);
    });

    it("STRICT CHECK: Total User Installs is NEVER mapped as daily firstTimeInstalls", () => {
      const rowWithCumulative = {
        Date: "2026-11-11",
        "Package Name": "com.crp.focus",
        "Total User Installs": "85400", // Cumulative lifetime count!
        "Daily Device Installs": "0",
        "Current Device Installs": "1200",
        "Installs on active devices": "980",
        "Daily Device Uninstalls": "3",
      };

      const record = mapGooglePlayRowToRecord(rowWithCumulative, "com.crp.focus");
      expect(record.firstTimeInstalls).toBe(0); // MUST be 0, NEVER 85400!
      expect(record.totalUserInstalls).toBe(85400); // Preserved separately
      expect(record.installsOnActiveDevices).toBe(980);
      expect(record.currentDeviceInstalls).toBe(1200);
    });

    it("rejects rows matching a different package name", () => {
      const row = {
        Date: "2026-11-10",
        "Package Name": "com.other.application",
        "Daily Device Installs": "100",
      };
      expect(mapGooglePlayRowToRecord(row, "com.crp.focus")).toBeNull();
    });

    it("rejects rows with invalid date formats", () => {
      const row = {
        Date: "11/10/2026",
        "Daily Device Installs": "10",
      };
      expect(mapGooglePlayRowToRecord(row)).toBeNull();
    });
  });

  describe("aggregateDimensionRows - Slice Summing & Total Row Double-Count Guard", () => {
    it("aggregates mutually-exclusive dimension slices by date", () => {
      const rows = [
        {
          Date: "2026-11-15",
          "Package Name": "com.crp.focus",
          Country: "US",
          "Daily Device Installs": "20",
          "Current Device Installs": "500",
          "Installs on active devices": "400",
          "Daily Device Uninstalls": "2",
          "Daily User Installs": "18",
          "Total User Installs": "2000",
        },
        {
          Date: "2026-11-15",
          "Package Name": "com.crp.focus",
          Country: "UK",
          "Daily Device Installs": "15",
          "Current Device Installs": "300",
          "Installs on active devices": "250",
          "Daily Device Uninstalls": "1",
          "Daily User Installs": "14",
          "Total User Installs": "1500",
        },
      ];

      const recordsByDate = aggregateDimensionRows(rows, "country", "com.crp.focus");
      expect(recordsByDate.size).toBe(1);

      const rec = recordsByDate.get("2026-11-15");
      expect(rec.firstTimeInstalls).toBe(35); // 20 + 15
      expect(rec.currentDeviceInstalls).toBe(800); // 500 + 300
      expect(rec.installsOnActiveDevices).toBe(650); // 400 + 250
      expect(rec.activeDeviceInstalls).toBe(650);
      expect(rec.uninstalls).toBe(3); // 2 + 1
      expect(rec.dailyUserInstalls).toBe(32); // 18 + 14
      expect(rec.totalUserInstalls).toBe(3500); // 2000 + 1500
    });

    it("DOUBLE-COUNT PREVENTION: detects explicit total row and does NOT sum slices with total", () => {
      const rowsWithTotal = [
        {
          Date: "2026-11-16",
          "Package Name": "com.crp.focus",
          Country: "US",
          "Daily Device Installs": "20",
          "Current Device Installs": "500",
          "Installs on active devices": "400",
        },
        {
          Date: "2026-11-16",
          "Package Name": "com.crp.focus",
          Country: "UK",
          "Daily Device Installs": "10",
          "Current Device Installs": "300",
          "Installs on active devices": "250",
        },
        {
          Date: "2026-11-16",
          "Package Name": "com.crp.focus",
          Country: "Total", // Explicit aggregate row!
          "Daily Device Installs": "30",
          "Current Device Installs": "800",
          "Installs on active devices": "650",
        },
      ];

      const recordsByDate = aggregateDimensionRows(rowsWithTotal, "country", "com.crp.focus");
      const rec = recordsByDate.get("2026-11-16");
      // Must NOT be 60 (30 + 30)! Must equal canonical 30
      expect(rec.firstTimeInstalls).toBe(30);
      expect(rec.currentDeviceInstalls).toBe(800);
      expect(rec.installsOnActiveDevices).toBe(650);
    });
  });

  describe("listGooglePlayReports - Documented Suffixes & Single-File Selection", () => {
    it("recognizes EVERY documented filename suffix", async () => {
      const items = SUPPORTED_DIMENSIONS.map((dim) => ({
        name: `stats/installs/installs_com.crp.focus_202611_${dim}.csv`,
        size: "1024",
      }));

      vi.stubGlobal("fetch", async () => {
        return new Response(JSON.stringify({ items }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const files = await listGooglePlayReports({
        bucket: "pubsite_prod_7397695133408217043",
        token: "mock-token",
        packageName: "com.crp.focus",
      });

      // Exactly 1 file selected for month 202611 (country preferred)
      expect(files).toHaveLength(1);
      expect(files[0].dimension).toBe("country");
      expect(files.allDiscoveredCount).toBe(6); // All 6 documented suffixes recognized
    });

    it("NO _overview.csv DEPENDENCY: filters out undocumented suffixes like _overview.csv", async () => {
      vi.stubGlobal("fetch", async () => {
        return new Response(
          JSON.stringify({
            items: [
              { name: "stats/installs/installs_com.crp.focus_202611_overview.csv", size: "1024" }, // Undocumented!
              { name: "stats/installs/installs_com.crp.focus_202611_country.csv", size: "2048" }, // Documented!
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" },
        });
      });

      const files = await listGooglePlayReports({
        bucket: "pubsite_prod_7397695133408217043",
        token: "mock-token",
        packageName: "com.crp.focus",
      });

      expect(files).toHaveLength(1);
      expect(files[0].name).toBe("stats/installs/installs_com.crp.focus_202611_country.csv");
      expect(files[0].dimension).toBe("country");
    });

    it("DETERMINISTIC SINGLE-FILE SELECTION: selects exactly 1 file per month in preference order", async () => {
      vi.stubGlobal("fetch", async () => {
        return new Response(
          JSON.stringify({
            items: [
              // Month 202610 has device and app_version -> selects app_version
              { name: "stats/installs/installs_com.crp.focus_202610_device.csv", size: "1024" },
              { name: "stats/installs/installs_com.crp.focus_202610_app_version.csv", size: "1024" },
              // Month 202611 has country, device, and os_version -> selects country
              { name: "stats/installs/installs_com.crp.focus_202611_country.csv", size: "1024" },
              { name: "stats/installs/installs_com.crp.focus_202611_device.csv", size: "1024" },
              { name: "stats/installs/installs_com.crp.focus_202611_os_version.csv", size: "1024" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" },
        });
      });

      const files = await listGooglePlayReports({
        bucket: "pubsite_prod_7397695133408217043",
        token: "mock-token",
        packageName: "com.crp.focus",
      });

      expect(files).toHaveLength(2); // One per month
      expect(files[0].yearMonth).toBe("202610");
      expect(files[0].dimension).toBe("app_version"); // Higher priority than device
      expect(files[1].yearMonth).toBe("202611");
      expect(files[1].dimension).toBe("country"); // Higher priority than device & os_version
    });

    it("GCS PAGINATION: iterates through pages with pageToken and tracks subrequest budget", async () => {
      let pageCount = 0;
      vi.stubGlobal("fetch", async (url) => {
        const u = new URL(String(url));
        pageCount++;
        if (pageCount === 1) {
          return new Response(
            JSON.stringify({
              items: [{ name: "stats/installs/installs_com.crp.focus_202609_country.csv", size: "1024" }],
              nextPageToken: "page-token-2",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            items: [{ name: "stats/installs/installs_com.crp.focus_202610_country.csv", size: "1024" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const budget = new SubrequestBudget(50, 3);
      const files = await listGooglePlayReports({
        bucket: "pubsite_prod_7397695133408217043",
        token: "mock-token",
        packageName: "com.crp.focus",
        budget,
      });

      expect(pageCount).toBe(2);
      expect(budget.used).toBe(2); // 2 pages fetched
      expect(files).toHaveLength(2);
      expect(files[0].yearMonth).toBe("202609");
      expect(files[1].yearMonth).toBe("202610");
    });
  });

  describe("syncGooglePlayReports - Bounded Sync & Budget Exhaustion", () => {
    it("REQUEST-BUDGET EXHAUSTION: stops safely before exceeding 50 subrequests and returns resumable continuation", async () => {
      // 31-day report
      let csvContent =
        "Date,Package Name,Country,Daily Device Installs,Current Device Installs,Installs on active devices\n";
      for (let day = 1; day <= 31; day++) {
        const d = day < 10 ? `0${day}` : `${day}`;
        csvContent += `2026-10-${d},com.crp.focus,US,10,1000,900\n`;
      }

      vi.stubGlobal("fetch", async (url) => {
        const s = String(url);
        if (s.endsWith("/token")) {
          return new Response(JSON.stringify({ access_token: "mock-token", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (s.includes("alt=media")) {
          return new Response(new TextEncoder().encode(csvContent), { status: 200 });
        }
        if (s.includes("/storage/v1/b/")) {
          return new Response(
            JSON.stringify({
              items: [{ name: "stats/installs/installs_com.crp.focus_202610_country.csv", size: "2048" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("ok", { status: 200 });
      });

      const inMemoryFirestore = new Map();
      const store = {
        getDocument: vi.fn().mockImplementation(async (col, id) => inMemoryFirestore.get(`${col}/${id}`) || null),
        upsertDocument: vi.fn().mockImplementation(async (col, id, data) => {
          const key = `${col}/${id}`;
          const existing = inMemoryFirestore.get(key) || {};
          inMemoryFirestore.set(key, { ...existing, ...data });
          return true;
        }),
      };

      const env = {
        GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: testSaJson,
        GOOGLE_PLAY_REPORT_BUCKET: "pubsite_prod_7397695133408217043",
      };

      // Set a low budget limit of 10 requests to test safety stop
      // 1 (token) + 1 (list) + 1 (getStatus) + 1 (media) = 4 spent.
      // Remaining for daily writes: 10 - 4 - 3 (safety margin) = 3 daily writes!
      const result = await syncGooglePlayReports({ env, store, budgetLimit: 10 });
      expect(result.ok).toBe(true);
      expect(result.budgetExhausted).toBe(true);
      expect(result.complete).toBe(false);
      expect(result.hasMore).toBe(true);
      expect(result.nextMonth).toBe("202610"); // Resumes the SAME month!
      expect(result.recordsImported).toBe(3); // Stopped after 3 records
      expect(result.subrequestsUsed).toBeLessThanOrEqual(10); // NEVER exceeds 10!

      // Verify that this month was NOT marked complete in syncedMonths
      const status = inMemoryFirestore.get("analytics/syncStatus/google_play");
      expect(status.syncedMonths).toEqual([]); // Empty because not fully finished
      expect(status.syncStatus).toBe("syncing");
      expect(status.connected).toBeUndefined(); // Not marked connected
    });

    it("EMPTY BUCKET BEHAVIOR: handles empty bucket explicitly without false success", async () => {
      vi.stubGlobal("fetch", async (url) => {
        const s = String(url);
        if (s.endsWith("/token")) {
          return new Response(JSON.stringify({ access_token: "mock-token", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (s.includes("/storage/v1/b/")) {
          return new Response(JSON.stringify({ items: [] }), { // Empty bucket!
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("ok", { status: 200 });
      });

      const inMemoryFirestore = new Map();
      const store = {
        getDocument: vi.fn().mockImplementation(async (col, id) => inMemoryFirestore.get(`${col}/${id}`) || null),
        upsertDocument: vi.fn().mockImplementation(async (col, id, data) => {
          inMemoryFirestore.set(`${col}/${id}`, data);
          return true;
        }),
      };

      const env = {
        GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: testSaJson,
        GOOGLE_PLAY_REPORT_BUCKET: "pubsite_prod_7397695133408217043",
      };

      const result = await syncGooglePlayReports({ env, store });
      expect(result.ok).toBe(true);
      expect(result.success).toBe(false); // EXPLICIT: not a false success!
      expect(result.filesDiscovered).toBe(0);
      expect(result.errors).toHaveLength(1);

      const status = inMemoryFirestore.get("analytics/syncStatus/google_play");
      expect(status.connected).toBe(false);
      expect(status.syncStatus).toBe("no_reports_found");
    });

    it("TARGET MONTH UNAVAILABLE: reports unavailable rather than marking successfully synced", async () => {
      vi.stubGlobal("fetch", async (url) => {
        const s = String(url);
        if (s.endsWith("/token")) {
          return new Response(JSON.stringify({ access_token: "mock-token", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (s.includes("/storage/v1/b/")) {
          return new Response(
            JSON.stringify({
              items: [{ name: "stats/installs/installs_com.crp.focus_202611_country.csv", size: "1024" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("ok", { status: 200 });
      });

      const inMemoryFirestore = new Map();
      const store = {
        getDocument: vi.fn().mockImplementation(async () => null),
        upsertDocument: vi.fn().mockImplementation(async (col, id, data) => {
          inMemoryFirestore.set(`${col}/${id}`, data);
          return true;
        }),
      };

      const env = {
        GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: testSaJson,
        GOOGLE_PLAY_REPORT_BUCKET: "pubsite_prod_7397695133408217043",
      };

      // Request a month that doesn't exist (e.g. 202601)
      const result = await syncGooglePlayReports({ env, store, targetMonth: "202601" });
      expect(result.ok).toBe(true);
      expect(result.success).toBe(false);
      expect(result.monthUnavailable).toBe(true);
      expect(result.errors[0]).toContain("unavailable");

      const status = inMemoryFirestore.get("analytics/syncStatus/google_play");
      expect(status.syncStatus).toBe("failed");
      expect(status.lastError).toContain("unavailable");
    });

    it("FAILED CONTINUATION: preserves previous successful sync timestamp", async () => {
      const prevSyncTime = "2026-11-25T10:00:00.000Z";

      vi.stubGlobal("fetch", async (url) => {
        const s = String(url);
        if (s.endsWith("/token")) {
          return new Response(JSON.stringify({ access_token: "mock-token", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (s.includes("alt=media")) {
          return new Response("Storage Read Error", { status: 500 });
        }
        if (s.includes("/storage/v1/b/")) {
          return new Response(
            JSON.stringify({
              items: [{ name: "stats/installs/installs_com.crp.focus_202611_country.csv", size: "512" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("ok", { status: 200 });
      });

      const inMemoryFirestore = new Map();
      inMemoryFirestore.set("analytics/syncStatus/google_play", {
        connected: true,
        syncStatus: "connected",
        lastSuccessfulSync: prevSyncTime,
        syncedMonths: ["202610"],
      });

      const store = {
        getDocument: vi.fn().mockImplementation(async (col, id) => inMemoryFirestore.get(`${col}/${id}`) || null),
        upsertDocument: vi.fn().mockImplementation(async (col, id, data) => {
          const key = `${col}/${id}`;
          const existing = inMemoryFirestore.get(key) || {};
          inMemoryFirestore.set(key, { ...existing, ...data });
          return true;
        }),
      };

      const env = {
        GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: testSaJson,
        GOOGLE_PLAY_REPORT_BUCKET: "pubsite_prod_7397695133408217043",
      };

      const result = await syncGooglePlayReports({ env, store, targetMonth: "202611" });
      expect(result.ok).toBe(true);
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);

      const status = inMemoryFirestore.get("analytics/syncStatus/google_play");
      expect(status.lastSuccessfulSync).toBe(prevSyncTime); // PRESERVED!
      expect(status.syncStatus).toBe("failed");
    });
  });
});
