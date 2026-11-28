/**
 * Google Play Console bulk reports ingestion engine.
 *
 * Responsibilities:
 * - Google Cloud Storage authentication via WebCrypto and service-account JWT exchange.
 * - Listing and paginating objects in the Google Play bulk reports bucket (stats/installs/).
 * - Strict package name matching to prevent cross-app data leakage.
 * - Dimension file discovery using only documented dimensions:
 *   ["app_version", "carrier", "country", "device", "language", "os_version"]
 * - Deterministic single-dimension file selection per month (country > app_version > device > os_version > carrier > language).
 * - Aggregation of dimension rows by date while detecting and handling total/aggregate rows to prevent double counting.
 * - Preserving "Current Device Installs" and "Installs on active devices" as distinct metrics.
 * - Mapping dashboard active-device metric to actual "Installs on active devices" (30-day active device definition).
 * - Keeping "Daily Device Installs" and "Daily User Installs" separate; never using "Total User Installs" as a daily fallback.
 * - Enforcing a hard subrequest-budget guard (Cloudflare Workers Free 50 subrequests limit) across token exchange,
 *   GCS listing pagination, GCS media download, and Firestore reads and writes.
 * - Bounded, resumable multi-month historical backfill with explicit continuation and empty bucket safety.
 */

import { buildInstallationRecord } from "./analytics-engine.js";

export const DEFAULT_GCS_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";
export const DEFAULT_PACKAGE_NAME = "com.crp.focus";
export const DEFAULT_REPORTS_PREFIX = "stats/installs/";

/**
 * Supported documented Google Play installation report dimensions.
 * Undocumented names (such as "overview") are strictly excluded.
 */
export const SUPPORTED_DIMENSIONS = [
  "app_version",
  "carrier",
  "country",
  "device",
  "language",
  "os_version",
];

/**
 * Deterministic dimension file selection priority order.
 * For any given month, if multiple dimension files exist, exactly one file
 * is selected according to this preference order to prevent double-counting.
 */
export const DIMENSION_PREFERENCE_ORDER = [
  "country",
  "app_version",
  "device",
  "os_version",
  "carrier",
  "language",
];

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GCS_API_BASE = "https://storage.googleapis.com/storage/v1/b";
const JWT_LIFETIME_SECONDS = 3600;

// Isolate-level token cache
let cachedToken = null;
let inFlightTokenPromise = null;

/**
 * Reset token cache for testing.
 */
export function __resetPlayTokenCache() {
  cachedToken = null;
  inFlightTokenPromise = null;
}

/**
 * Subrequest budget guard for Cloudflare Workers Free plan.
 * Guarantees that the total number of outgoing fetch requests (OAuth token,
 * GCS object listing and pagination, GCS media download, Firestore reads/writes,
 * and status updates) never exceeds the execution limit of 50 subrequests.
 */
export class SubrequestBudget {
  /**
   * @param {number} [limit=50] Cloudflare Workers Free subrequest limit
   * @param {number} [safetyMargin=3] Reserved requests for final status and error handling
   */
  constructor(limit = 50, safetyMargin = 3) {
    this.limit = limit;
    this.safetyMargin = safetyMargin;
    this.used = 0;
  }

  get remaining() {
    return Math.max(0, this.limit - this.used);
  }

  canAfford(count = 1) {
    return (this.used + count + this.safetyMargin) <= this.limit;
  }

  recordRequest(count = 1) {
    this.used += count;
    return this.used;
  }
}

/**
 * Sanitize error messages so credentials, bearer tokens, and private keys never leak.
 * @param {unknown} err
 * @returns {string|null}
 */
export function sanitizeErrorMessage(err) {
  if (!err) return null;
  const msg = typeof err === "string" ? err : err.message || String(err);
  return msg
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/-----BEGIN[^-]+-----[\s\S]+?-----END[^-]+-----/g, "[REDACTED_KEY]")
    .replace(/[A-Za-z0-9+/=]{40,}/g, "[REDACTED_TOKEN]")
    .slice(0, 500);
}

/**
 * Convert PEM-armoured private key string to raw binary ArrayBuffer.
 * @param {string} pem
 * @returns {ArrayBuffer}
 */
function pemToArrayBuffer(pem) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");

  if (!body || body.length < 64) {
    throw new Error("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON private key looks empty or truncated.");
  }

  let binary;
  try {
    binary = atob(body);
  } catch {
    throw new Error("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON private key is not valid base64.");
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Base64URL encode bytes.
 */
function base64Url(bytes) {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint a signed JWT assertion for Google OAuth token exchange.
 * @param {{client_email: string, private_key: string}} sa
 * @returns {Promise<string>}
 */
async function signAssertion(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: DEFAULT_GCS_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + JWT_LIFETIME_SECONDS,
  };

  const signingInput = `${base64Url(new TextEncoder().encode(JSON.stringify(header)))}.${base64Url(
    new TextEncoder().encode(JSON.stringify(claims)),
  )}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64Url(sig)}`;
}

/**
 * Obtain a Google Cloud Storage read-only access token using the service account JSON.
 * @param {string|object} serviceAccountJson
 * @param {object} [options]
 * @param {SubrequestBudget} [options.budget]
 * @returns {Promise<string>}
 */
export async function getGooglePlayStorageToken(serviceAccountJson, { budget } = {}) {
  if (!serviceAccountJson) {
    throw new Error(
      "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not configured in Worker secrets.",
    );
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  if (inFlightTokenPromise) {
    return inFlightTokenPromise;
  }

  inFlightTokenPromise = (async () => {
    const sa =
      typeof serviceAccountJson === "string"
        ? JSON.parse(serviceAccountJson)
        : serviceAccountJson;

    if (!sa.client_email || !sa.private_key) {
      throw new Error(
        "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is missing required fields (client_email or private_key).",
      );
    }

    const assertion = await signAssertion(sa);

    if (budget) {
      if (!budget.canAfford(1)) {
        throw new Error("Subrequest budget exhausted before OAuth token exchange.");
      }
      budget.recordRequest(1);
    }

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Failed to authenticate Google Play service account (${response.status}): ${sanitizeErrorMessage(detail)}`,
      );
    }

    const json = await response.json();
    cachedToken = {
      token: json.access_token,
      expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
    };
    return cachedToken.token;
  })().finally(() => {
    inFlightTokenPromise = null;
  });

  return inFlightTokenPromise;
}

/**
 * Decode an ArrayBuffer into text, auto-detecting UTF-16LE, UTF-16BE, UTF-8 BOM, or plain UTF-8.
 * Google Play Console bulk reports are encoded as UTF-16LE with BOM (0xFF, 0xFE).
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string}
 */
export function decodeReportBuffer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length === 0) return "";

  // UTF-16LE BOM: 0xFF, 0xFE
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }

  // UTF-16BE BOM: 0xFE, 0xFF
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes);
  }

  // UTF-8 BOM: 0xEF, 0xBB, 0xBF
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.slice(3));
  }

  // Default to standard UTF-8
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Parse an RFC 4180 CSV string into an array of object records.
 * Handles quoted fields containing commas, line breaks, and escaped double-quotes.
 * @param {string} csvText
 * @returns {Array<Record<string, string>>}
 */
export function parseGooglePlayCsv(csvText) {
  if (!csvText || !csvText.trim()) return [];

  const lines = [];
  let currentRow = [];
  let currentField = "";
  let insideQuotes = false;
  const len = csvText.length;

  for (let i = 0; i < len; i++) {
    const char = csvText[i];
    const nextChar = i + 1 < len ? csvText[i + 1] : "";

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentField += '"';
        i++; // skip escaped quote
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === "," && !insideQuotes) {
      currentRow.push(currentField.trim());
      currentField = "";
    } else if ((char === "\r" || char === "\n") && !insideQuotes) {
      if (char === "\r" && nextChar === "\n") i++; // handle CRLF
      currentRow.push(currentField.trim());
      if (currentRow.some((f) => f.length > 0)) {
        lines.push(currentRow);
      }
      currentRow = [];
      currentField = "";
    } else {
      currentField += char;
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some((f) => f.length > 0)) {
      lines.push(currentRow);
    }
  }

  if (lines.length < 2) return [];

  // Normalize header keys: strip BOM, trim, remove surrounding quotes
  const headers = lines[0].map((h) => h.replace(/^\uFEFF/, "").trim());
  const records = [];

  for (let r = 1; r < lines.length; r++) {
    const row = lines[r];
    if (row.length === 0 || (row.length === 1 && !row[0])) continue;
    const item = {};
    for (let c = 0; c < headers.length; c++) {
      item[headers[c]] = row[c] !== undefined ? row[c] : "";
    }
    records.push(item);
  }

  return records;
}

/**
 * Identify the dimension column name in a parsed CSV row.
 * @param {Record<string, string>} row
 * @param {string} dimension
 * @returns {string|null}
 */
export function findDimensionHeader(row, dimension = "") {
  if (!row) return null;
  const normalizedDim = dimension.replace(/[_\s-]+/g, "").toLowerCase();
  for (const header of Object.keys(row)) {
    const normalizedHeader = header.replace(/[_\s-]+/g, "").toLowerCase();
    if (normalizedHeader === normalizedDim || normalizedHeader.includes(normalizedDim)) {
      return header;
    }
  }
  for (const header of Object.keys(row)) {
    const lower = header.toLowerCase();
    if (
      lower === "country" ||
      lower === "device" ||
      lower === "carrier" ||
      lower === "language" ||
      lower.includes("app version") ||
      lower.includes("os version")
    ) {
      return header;
    }
  }
  return null;
}

/**
 * Check if a CSV row represents a total or aggregate summary row
 * (e.g. Country: "Total", "All", "Overall").
 * @param {Record<string, string>} row
 * @param {string|null} [dimensionHeader]
 * @returns {boolean}
 */
export function isTotalOrAggregateRow(row, dimensionHeader = null) {
  if (!row) return false;
  if (dimensionHeader && row[dimensionHeader] !== undefined) {
    const val = String(row[dimensionHeader]).trim().toLowerCase();
    if (val === "total" || val === "all" || val === "overall" || val === "total / all") {
      return true;
    }
  }
  for (const [key, val] of Object.entries(row)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("country") ||
      lowerKey.includes("device") ||
      lowerKey.includes("carrier") ||
      lowerKey.includes("version") ||
      lowerKey.includes("language")
    ) {
      const lowerVal = String(val).trim().toLowerCase();
      if (lowerVal === "total" || lowerVal === "all" || lowerVal === "overall") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Map a raw parsed Google Play CSV row to our normalized daily installation record.
 *
 * Metric separation:
 * - "Daily Device Installs" -> dailyDeviceInstalls & firstTimeInstalls
 * - "Installs on active devices" -> installsOnActiveDevices & activeDeviceInstalls (30-day active device definition)
 * - "Current Device Installs" -> currentDeviceInstalls (cumulative installed base; kept strictly distinct)
 * - "Daily User Installs" -> dailyUserInstalls (distinct user-level metric)
 * - "Total User Installs" -> totalUserInstalls (cumulative lifetime user count; NEVER used as daily fallback)
 * - "Install events" -> installEvents
 *
 * @param {Record<string, string>} row
 * @param {string} [expectedPackage]
 * @returns {object|null}
 */
export function mapGooglePlayRowToRecord(row, expectedPackage = DEFAULT_PACKAGE_NAME) {
  if (!row) return null;

  const pkg = String(row["Package Name"] || row["package_name"] || "").trim();
  if (pkg && expectedPackage && pkg !== expectedPackage) {
    return null;
  }

  const date = String(row["Date"] || row["date"] || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }

  // Canonical Daily Device Installs
  const rawDailyDeviceInstalls = row["Daily Device Installs"];
  const firstTimeInstalls = Math.max(0, Number(rawDailyDeviceInstalls) || 0);

  // Installs on active devices (30-day active device metric)
  const rawInstallsOnActive =
    row["Installs on active devices"] !== undefined && row["Installs on active devices"] !== ""
      ? row["Installs on active devices"]
      : row["Active Device Installs"] !== undefined && row["Active Device Installs"] !== ""
        ? row["Active Device Installs"]
        : "";
  const installsOnActiveDevices = rawInstallsOnActive !== "" ? Math.max(0, Number(rawInstallsOnActive) || 0) : 0;

  // Current Device Installs (Cumulative installed base on devices where not uninstalled)
  // Kept STRICTLY SEPARATE from Installs on active devices
  const rawCurrentDeviceInstalls =
    row["Current Device Installs"] !== undefined && row["Current Device Installs"] !== ""
      ? row["Current Device Installs"]
      : "";
  const currentDeviceInstalls = rawCurrentDeviceInstalls !== "" ? Math.max(0, Number(rawCurrentDeviceInstalls) || 0) : 0;

  // Daily Device Uninstalls
  const rawDailyDeviceUninstalls = row["Daily Device Uninstalls"];
  const uninstalls = Math.max(0, Number(rawDailyDeviceUninstalls) || 0);

  // Reinstalls
  const rawReinstalls =
    row["Daily Device Reinstalls"] !== undefined && row["Daily Device Reinstalls"] !== ""
      ? row["Daily Device Reinstalls"]
      : row["Reinstalls"] !== undefined && row["Reinstalls"] !== ""
        ? row["Reinstalls"]
        : "0";
  const reinstalls = Math.max(0, Number(rawReinstalls) || 0);

  const record = buildInstallationRecord({
    date,
    firstTimeInstalls,
    activeDeviceInstalls: installsOnActiveDevices, // Map dashboard active-device metric to actual "Installs on active devices"
    installsOnActiveDevices,
    currentDeviceInstalls,
    uninstalls,
    reinstalls,
    source: "google_play_bulk_report",
  });

  record.dailyDeviceInstalls = firstTimeInstalls;
  record.installsOnActiveDevices = installsOnActiveDevices;
  if (rawCurrentDeviceInstalls !== "") {
    record.currentDeviceInstalls = currentDeviceInstalls;
  }

  if (row["Daily User Installs"] !== undefined && row["Daily User Installs"] !== "") {
    record.dailyUserInstalls = Math.max(0, Number(row["Daily User Installs"]) || 0);
  }
  if (row["Daily User Uninstalls"] !== undefined && row["Daily User Uninstalls"] !== "") {
    record.dailyUserUninstalls = Math.max(0, Number(row["Daily User Uninstalls"]) || 0);
  }
  if (row["Total User Installs"] !== undefined && row["Total User Installs"] !== "") {
    record.totalUserInstalls = Math.max(0, Number(row["Total User Installs"]) || 0);
  }
  if (row["Install events"] !== undefined && row["Install events"] !== "") {
    record.installEvents = Math.max(0, Number(row["Install events"]) || 0);
  }

  return record;
}

/**
 * Aggregate rows within a selected dimension file by date.
 * If an explicit total/aggregate row exists for a date, uses it directly.
 * Otherwise, sums mutually-exclusive dimension slices while strictly filtering
 * out any total rows to avoid double-counting.
 *
 * @param {Array<Record<string, string>>} rows
 * @param {string} dimension Selected report dimension name (e.g. "country")
 * @param {string} [expectedPackage]
 * @returns {Map<string, object>} Map of date (YYYY-MM-DD) -> normalized installation record
 */
export function aggregateDimensionRows(rows, dimension = "", expectedPackage = DEFAULT_PACKAGE_NAME) {
  const rowsByDate = new Map();
  const dimHeader = rows.length > 0 ? findDimensionHeader(rows[0], dimension) : null;

  for (const row of rows) {
    const pkg = String(row["Package Name"] || row["package_name"] || "").trim();
    if (pkg && expectedPackage && pkg !== expectedPackage) {
      continue;
    }
    const date = String(row["Date"] || row["date"] || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      continue;
    }

    if (!rowsByDate.has(date)) {
      rowsByDate.set(date, []);
    }
    rowsByDate.get(date).push(row);
  }

  const resultByDate = new Map();

  for (const [date, dateRows] of rowsByDate.entries()) {
    // 1. Check if an explicit total/aggregate row exists for this date
    const totalRow = dateRows.find((r) => isTotalOrAggregateRow(r, dimHeader));
    if (totalRow) {
      // Use the canonical aggregate row directly; do NOT sum slices with it!
      const rec = mapGooglePlayRowToRecord(totalRow, expectedPackage);
      if (rec) {
        resultByDate.set(date, rec);
        continue;
      }
    }

    // 2. Sum mutually exclusive slice rows for this date
    let dailyDeviceInstalls = 0;
    let installsOnActiveDevices = 0;
    let currentDeviceInstalls = 0;
    let dailyDeviceUninstalls = 0;
    let dailyUserInstalls = 0;
    let dailyUserUninstalls = 0;
    let installEvents = 0;
    let reinstalls = 0;
    let totalUserInstalls = 0;
    let hasUserInstalls = false;
    let hasUserUninstalls = false;
    let hasInstallEvents = false;
    let hasTotalUserInstalls = false;
    let hasCurrentDeviceInstalls = false;
    let hasInstallsOnActiveDevices = false;

    for (const r of dateRows) {
      // Skip any total row if somehow present
      if (isTotalOrAggregateRow(r, dimHeader)) continue;

      if (r["Daily Device Installs"] !== undefined && r["Daily Device Installs"] !== "") {
        dailyDeviceInstalls += Math.max(0, Number(r["Daily Device Installs"]) || 0);
      }
      if (r["Installs on active devices"] !== undefined && r["Installs on active devices"] !== "") {
        installsOnActiveDevices += Math.max(0, Number(r["Installs on active devices"]) || 0);
        hasInstallsOnActiveDevices = true;
      } else if (r["Active Device Installs"] !== undefined && r["Active Device Installs"] !== "") {
        installsOnActiveDevices += Math.max(0, Number(r["Active Device Installs"]) || 0);
        hasInstallsOnActiveDevices = true;
      }
      if (r["Current Device Installs"] !== undefined && r["Current Device Installs"] !== "") {
        currentDeviceInstalls += Math.max(0, Number(r["Current Device Installs"]) || 0);
        hasCurrentDeviceInstalls = true;
      }
      if (r["Daily Device Uninstalls"] !== undefined && r["Daily Device Uninstalls"] !== "") {
        dailyDeviceUninstalls += Math.max(0, Number(r["Daily Device Uninstalls"]) || 0);
      }
      if (r["Daily Device Reinstalls"] !== undefined && r["Daily Device Reinstalls"] !== "") {
        reinstalls += Math.max(0, Number(r["Daily Device Reinstalls"]) || 0);
      } else if (r["Reinstalls"] !== undefined && r["Reinstalls"] !== "") {
        reinstalls += Math.max(0, Number(r["Reinstalls"]) || 0);
      }
      if (r["Daily User Installs"] !== undefined && r["Daily User Installs"] !== "") {
        dailyUserInstalls += Math.max(0, Number(r["Daily User Installs"]) || 0);
        hasUserInstalls = true;
      }
      if (r["Daily User Uninstalls"] !== undefined && r["Daily User Uninstalls"] !== "") {
        dailyUserUninstalls += Math.max(0, Number(r["Daily User Uninstalls"]) || 0);
        hasUserUninstalls = true;
      }
      if (r["Install events"] !== undefined && r["Install events"] !== "") {
        installEvents += Math.max(0, Number(r["Install events"]) || 0);
        hasInstallEvents = true;
      }
      if (r["Total User Installs"] !== undefined && r["Total User Installs"] !== "") {
        totalUserInstalls += Math.max(0, Number(r["Total User Installs"]) || 0);
        hasTotalUserInstalls = true;
      }
    }

    const record = buildInstallationRecord({
      date,
      firstTimeInstalls: dailyDeviceInstalls,
      activeDeviceInstalls: installsOnActiveDevices,
      currentDeviceInstalls: hasCurrentDeviceInstalls ? currentDeviceInstalls : 0,
      uninstalls: dailyDeviceUninstalls,
      reinstalls,
      source: "google_play_bulk_report",
    });

    record.dailyDeviceInstalls = dailyDeviceInstalls;
    record.installsOnActiveDevices = installsOnActiveDevices;
    if (hasCurrentDeviceInstalls) {
      record.currentDeviceInstalls = currentDeviceInstalls;
    }
    if (hasUserInstalls) {
      record.dailyUserInstalls = dailyUserInstalls;
    }
    if (hasUserUninstalls) {
      record.dailyUserUninstalls = dailyUserUninstalls;
    }
    if (hasInstallEvents) {
      record.installEvents = installEvents;
    }
    if (hasTotalUserInstalls) {
      record.totalUserInstalls = totalUserInstalls;
    }

    resultByDate.set(date, record);
  }

  return resultByDate;
}

/**
 * List Google Play report objects in Google Cloud Storage with strict package name matching,
 * supported dimension filtering, GCS pagination, and deterministic single-dimension file selection per month.
 *
 * Rules:
 * - Requires exact package match (e.g. `installs_com.crp.focus_` will not match `com.crp.focus.pro`).
 * - Only includes documented dimensions: ["app_version", "carrier", "country", "device", "language", "os_version"].
 * - Deterministically selects exactly ONE dimension file per month according to DIMENSION_PREFERENCE_ORDER.
 * - Enforces the subrequest budget on every page of GCS listing.
 *
 * @param {object} params
 * @param {string} params.bucket GCS bucket name
 * @param {string} params.token Bearer access token
 * @param {string} [params.packageName] App package name filter
 * @param {string} [params.prefix] Bucket folder prefix
 * @param {SubrequestBudget} [params.budget]
 * @returns {Promise<Array<{name: string, size: number, updated: string, dimension: string, yearMonth: string}>>}
 */
export async function listGooglePlayReports({
  bucket,
  token,
  packageName = DEFAULT_PACKAGE_NAME,
  prefix = DEFAULT_REPORTS_PREFIX,
  budget = null,
}) {
  const supportedFiles = [];
  let pageToken = null;

  // Strict regex: requires `installs_${packageName}_` followed by 6-digit YYYYMM, underscore, dimension, and .csv
  const escapedPrefix = prefix ? prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
  const escapedPkg = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fileRegex = new RegExp(`^${escapedPrefix}installs_${escapedPkg}_(\\d{6})_([a-z0-9_-]+)\\.csv$`, "i");

  do {
    if (budget) {
      if (!budget.canAfford(1)) {
        // Budget exhausted during listing pagination; break safely
        break;
      }
      budget.recordRequest(1);
    }

    const url = new URL(`${GCS_API_BASE}/${encodeURIComponent(bucket)}/o`);
    if (prefix) url.searchParams.set("prefix", prefix);
    url.searchParams.set("maxResults", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `Failed to list GCS bucket "${bucket}" (${res.status}): ${sanitizeErrorMessage(errText)}`,
      );
    }

    const json = await res.json();
    for (const item of json.items || []) {
      const name = item.name || "";
      const match = name.match(fileRegex);
      if (match) {
        const dimension = match[2].toLowerCase();
        // Only accept documented dimensions; discard unsupported dimensions
        if (SUPPORTED_DIMENSIONS.includes(dimension)) {
          supportedFiles.push({
            name,
            size: Number(item.size || 0),
            updated: item.updated || "",
            dimension,
            yearMonth: match[1],
          });
        }
      }
    }

    pageToken = json.nextPageToken || null;
  } while (pageToken);

  // Group discovered supported dimension files by yearMonth
  const filesByMonth = new Map();
  for (const file of supportedFiles) {
    if (!filesByMonth.has(file.yearMonth)) {
      filesByMonth.set(file.yearMonth, []);
    }
    filesByMonth.get(file.yearMonth).push(file);
  }

  // Deterministically select exactly ONE dimension file per month according to DIMENSION_PREFERENCE_ORDER
  const selectedMonthlyFiles = [];
  for (const [ym, monthFiles] of filesByMonth.entries()) {
    monthFiles.sort((a, b) => {
      const idxA = DIMENSION_PREFERENCE_ORDER.indexOf(a.dimension);
      const idxB = DIMENSION_PREFERENCE_ORDER.indexOf(b.dimension);
      const rankA = idxA === -1 ? 999 : idxA;
      const rankB = idxB === -1 ? 999 : idxB;
      return rankA - rankB || a.name.localeCompare(b.name);
    });
    selectedMonthlyFiles.push(monthFiles[0]);
  }

  // Sort chronologically by yearMonth
  selectedMonthlyFiles.sort((a, b) => a.yearMonth.localeCompare(b.yearMonth) || a.name.localeCompare(b.name));
  selectedMonthlyFiles.allDiscoveredCount = supportedFiles.length;
  return selectedMonthlyFiles;
}

/**
 * Download a single CSV report file from Google Cloud Storage.
 *
 * @param {object} params
 * @param {string} params.bucket GCS bucket name
 * @param {string} params.objectName GCS object path
 * @param {string} params.token Bearer access token
 * @param {SubrequestBudget} [params.budget]
 * @returns {Promise<string>} Decoded CSV text
 */
export async function downloadGooglePlayReport({ bucket, objectName, token, budget = null }) {
  if (budget) {
    if (!budget.canAfford(1)) {
      throw new Error("Subrequest budget exhausted before downloading report.");
    }
    budget.recordRequest(1);
  }

  const url = `${GCS_API_BASE}/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Failed to download GCS object "${objectName}" (${res.status}): ${sanitizeErrorMessage(errText)}`,
    );
  }

  const buffer = await res.arrayBuffer();
  return decodeReportBuffer(buffer);
}

/**
 * Execute a bounded, resumable sync of Google Play bulk installation reports:
 *
 * Hard Subrequest Budget Guarantee:
 * - Dynamically tracks every outgoing fetch against a limit of 50 subrequests.
 * - If the operation cannot safely finish within the remaining budget, halts daily writes
 *   and returns a resumable continuation response WITHOUT marking the month complete.
 *
 * Deterministic Dimension Processing:
 * - Discovers files matching documented dimensions (country, app_version, device, os_version, carrier, language).
 * - For each month, selects exactly ONE dimension file (country preferred).
 * - Aggregates dimension rows by date, preventing double-counting of total rows and dimension slices.
 *
 * Resumable Continuation:
 * - Ingests 1 month (or remaining days of a month) per invocation.
 * - Idempotently updates Firestore `analytics/installations/{date}`.
 * - Returns `hasMore: true` and `nextMonth: YYYYMM` when more months or days remain.
 * - Empty bucket or missing files explicitly reports status and does not claim false success.
 *
 * @param {object} options
 * @param {object} options.env Cloudflare Worker environment bindings
 * @param {object} options.store Firestore REST client
 * @param {string} [options.targetMonth] Optional YYYYMM to process specifically
 * @param {number} [options.budgetLimit=50] Subrequest budget ceiling
 * @returns {Promise<object>} Sync summary with continuation metadata
 */
export async function syncGooglePlayReports({ env, store, targetMonth = null, budgetLimit = 50 }) {
  const budget = new SubrequestBudget(budgetLimit, 3);

  const bucket =
    env.GOOGLE_PLAY_REPORT_BUCKET ||
    "pubsite_prod_7397695133408217043";
  const packageName =
    env.GOOGLE_PLAY_PACKAGE_NAME ||
    DEFAULT_PACKAGE_NAME;
  const prefix =
    env.GOOGLE_PLAY_REPORTS_PREFIX ||
    DEFAULT_REPORTS_PREFIX;

  if (!env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) {
    const err = new Error("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not configured. Please set the secret in Wrangler.");
    if (store && typeof store.upsertDocument === "function") {
      await store.upsertDocument("analytics/syncStatus", "google_play", {
        syncStatus: "failed",
        lastAttemptedSync: new Date().toISOString(),
        lastError: err.message,
        bucket,
        packageName,
      }).catch(() => {});
    }
    throw err;
  }

  let token;
  let allFiles = [];

  try {
    token = await getGooglePlayStorageToken(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, { budget });
    allFiles = await listGooglePlayReports({ bucket, packageName, token, prefix, budget });
  } catch (initErr) {
    const sanitized = sanitizeErrorMessage(initErr.message);
    if (budget.remaining >= 1 && store && typeof store.upsertDocument === "function") {
      budget.recordRequest(1);
      await store.upsertDocument("analytics/syncStatus", "google_play", {
        syncStatus: "failed",
        lastAttemptedSync: new Date().toISOString(),
        lastError: sanitized,
        bucket,
        packageName,
      }).catch(() => {});
    }
    throw new Error(sanitized);
  }

  // Handle empty bucket or no matching files explicitly: do NOT produce a false successful sync!
  if (allFiles.length === 0) {
    const nowIso = new Date().toISOString();
    const errMsg = `No Google Play installation reports found in bucket "${bucket}" for package "${packageName}".`;
    if (budget.remaining >= 1 && store && typeof store.upsertDocument === "function") {
      budget.recordRequest(1);
      await store.upsertDocument("analytics/syncStatus", "google_play", {
        connected: false,
        syncStatus: "no_reports_found",
        lastAttemptedSync: nowIso,
        lastError: errMsg,
        bucket,
        packageName,
        filesDiscovered: 0,
        filesProcessed: 0,
        recordsImported: 0,
        latestReportDate: null,
        syncedMonths: [],
      }).catch(() => {});
    }

    return {
      ok: true,
      success: false, // Explicit: false to prevent dashboard false success
      complete: true,
      hasMore: false,
      nextMonth: null,
      currentMonth: null,
      processedMonths: [],
      remainingMonths: [],
      totalMonthsDiscovered: 0,
      filesDiscovered: 0,
      filesProcessed: 0,
      recordsImported: 0,
      latestReportDate: null,
      subrequestsUsed: budget.used,
      subrequestBudget: budget.limit,
      errors: [errMsg],
    };
  }

  // Determine existing sync state to support automatic resumable continuation
  let existingStatus = null;
  if (budget.canAfford(1) && store && typeof store.getDocument === "function") {
    budget.recordRequest(1);
    existingStatus = await store.getDocument("analytics/syncStatus", "google_play").catch(() => null);
  }

  const alreadySyncedMonths = new Set(existingStatus?.syncedMonths || []);

  // Determine which single file to process in this invocation to respect the subrequest budget
  let selectedFile = null;
  if (targetMonth) {
    selectedFile = allFiles.find((f) => f.yearMonth === String(targetMonth).trim());
    if (!selectedFile) {
      const nowIso = new Date().toISOString();
      const errMsg = `Google Play report for month "${targetMonth}" is unavailable.`;
      if (budget.remaining >= 1 && store && typeof store.upsertDocument === "function") {
        budget.recordRequest(1);
        await store.upsertDocument("analytics/syncStatus", "google_play", {
          syncStatus: "failed",
          lastAttemptedSync: nowIso,
          lastError: errMsg,
          bucket,
          packageName,
        }).catch(() => {});
      }
      return {
        ok: true,
        success: false,
        complete: true,
        hasMore: false,
        nextMonth: null,
        currentMonth: String(targetMonth).trim(),
        monthUnavailable: true,
        processedMonths: [],
        remainingMonths: [],
        totalMonthsDiscovered: allFiles.length,
        filesDiscovered: allFiles.allDiscoveredCount || allFiles.length,
        filesProcessed: 0,
        recordsImported: 0,
        latestReportDate: null,
        subrequestsUsed: budget.used,
        subrequestBudget: budget.limit,
        errors: [errMsg],
      };
    }
  } else {
    // Pick the oldest pending month that has not been synced yet
    const pendingFiles = allFiles.filter((f) => !alreadySyncedMonths.has(f.yearMonth));
    if (pendingFiles.length > 0) {
      selectedFile = pendingFiles[0];
    } else {
      // All discovered months have been synced at least once; refresh the latest month
      selectedFile = allFiles[allFiles.length - 1];
    }
  }

  // Calculate remaining months for continuation
  const selectedIdx = allFiles.findIndex((f) => f.yearMonth === selectedFile.yearMonth);
  const remainingFiles = allFiles.slice(selectedIdx + 1);
  const furtherMonthsExist = remainingFiles.length > 0;

  // Process the single selected month's dimension report
  let recordsByDate = new Map();
  const errors = [];
  let filesProcessed = 0;

  try {
    const csvText = await downloadGooglePlayReport({
      bucket,
      objectName: selectedFile.name,
      token,
      budget,
    });

    const parsedRows = parseGooglePlayCsv(csvText);
    recordsByDate = aggregateDimensionRows(parsedRows, selectedFile.dimension, packageName);
    filesProcessed++;
  } catch (err) {
    errors.push(`Error processing ${selectedFile.name}: ${sanitizeErrorMessage(err.message)}`);
  }

  // Idempotently store daily records for this month using single-request upsertDocument
  let recordsImported = 0;
  let latestReportDate = null;
  let budgetExhausted = false;

  for (const [date, record] of recordsByDate.entries()) {
    if (!latestReportDate || date > latestReportDate) {
      latestReportDate = date;
    }

    // Explicit request budget guard: stop safely before exceeding 50 outgoing subrequests!
    if (!budget.canAfford(1)) {
      budgetExhausted = true;
      break;
    }

    try {
      await store.upsertDocument("analytics/installations", date, record);
      budget.recordRequest(1);
      recordsImported++;
    } catch (writeErr) {
      errors.push(`Error storing installation date ${date}: ${sanitizeErrorMessage(writeErr.message)}`);
    }
  }

  const nowIso = new Date().toISOString();
  const hasErrors = errors.length > 0;
  const monthFullyFinished = !budgetExhausted && !hasErrors && recordsImported === recordsByDate.size;

  // Maintain cumulative set of successfully synced months (only add month if fully finished without error)
  const updatedSyncedMonths = Array.from(
    new Set([...alreadySyncedMonths, ...(monthFullyFinished ? [selectedFile.yearMonth] : [])]),
  ).sort();

  // If budget was exhausted during writes, resume this same month on next invocation!
  const hasMore = !hasErrors && (budgetExhausted || furtherMonthsExist);
  const nextMonth = !hasErrors && hasMore ? (budgetExhausted ? selectedFile.yearMonth : remainingFiles[0].yearMonth) : null;
  const complete = !hasErrors && monthFullyFinished && !furtherMonthsExist;

  const statusData = {
    syncStatus: hasErrors ? "failed" : complete ? "connected" : "syncing",
    lastAttemptedSync: nowIso,
    lastError: hasErrors ? sanitizeErrorMessage(errors[0]) : null,
    bucket,
    packageName,
    filesDiscovered: allFiles.allDiscoveredCount || allFiles.length,
    filesProcessed,
    recordsImported,
    latestReportDate,
    currentMonth: selectedFile.yearMonth,
    lastProcessedMonth: selectedFile.yearMonth,
    syncedMonths: updatedSyncedMonths,
    hasMore,
    nextMonth,
    selectedDimension: selectedFile.dimension,
  };

  // Only update lastSuccessfulSync and mark connected: true if backfill is completely finished
  if (complete) {
    statusData.connected = true;
    statusData.lastSuccessfulSync = nowIso;
  }

  if (budget.remaining >= 1 && store && typeof store.upsertDocument === "function") {
    budget.recordRequest(1);
    await store.upsertDocument("analytics/syncStatus", "google_play", statusData).catch(() => {});
  }

  return {
    ok: true,
    success: !hasErrors,
    complete,
    hasMore,
    budgetExhausted,
    currentMonth: selectedFile.yearMonth,
    nextMonth,
    selectedDimension: selectedFile.dimension,
    processedMonths: monthFullyFinished ? [selectedFile.yearMonth] : [],
    remainingMonths: budgetExhausted
      ? [selectedFile.yearMonth, ...remainingFiles.map((f) => f.yearMonth)]
      : remainingFiles.map((f) => f.yearMonth),
    totalMonthsDiscovered: allFiles.length,
    filesDiscovered: allFiles.allDiscoveredCount || allFiles.length,
    filesProcessed,
    recordsImported,
    recordsTotal: recordsByDate.size,
    latestReportDate,
    subrequestsUsed: budget.used,
    subrequestBudget: budget.limit,
    errors,
  };
}
