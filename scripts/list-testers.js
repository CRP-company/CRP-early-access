/**
 * Print the tester roster from Firestore, as a table and as CSV.
 *
 * Read-only, and deliberately so: this uses the Firebase CLI's existing login to
 * mint a short-lived access token and calls the Firestore REST API. It never
 * writes, and it never accepts a project id from the command line — the project is
 * pinned to the one this repo targets, because a wrong-project read is exactly the
 * mistake this file exists to prevent.
 *
 *   node scripts/list-testers.js
 *   node scripts/list-testers.js --csv > testers.csv
 */

const PROJECT = process.env.CRP_FIRESTORE_PROJECT || "crp-cuby-display";
const DATABASE = "(default)";
const COLLECTION = "testers";

/**
 * Mint an OAuth access token from the Firebase CLI's existing login.
 *
 * Reuses firebase-tools' own auth module so the Windows Credential Manager is read
 * exactly the way the CLI reads it, and the refresh token never has to be copied
 * out by hand. Falls back to FIREBASE_ACCESS_TOKEN for a CI environment.
 */
async function accessToken() {
  if (process.env.FIREBASE_ACCESS_TOKEN) return process.env.FIREBASE_ACCESS_TOKEN.trim();

  const auth = require("firebase-tools/lib/auth");
  const account = auth.getGlobalDefaultAccount() || (auth.getAllAccounts() || [])[0];

  if (!account || !account.tokens || !account.tokens.refresh_token) {
    throw new Error(
      "No Firebase CLI login found. Run `firebase login`, or set FIREBASE_ACCESS_TOKEN.",
    );
  }

  // Exchange the stored refresh token for a short-lived access token.
  const { OAuth2Client } = require("google-auth-library");
  const client = new OAuth2Client(
    "https://accounts.google.com/o/oauth2/auth",
    "https://oauth2.googleapis.com/token",
  );
  client.setCredentials(account.tokens);

  const { token } = await client.getAccessToken();
  if (!token) throw new Error("Could not mint an access token from the stored login.");
  return token;
}

/** Firestore returns every value as a tagged object; flatten one. */
function decode(value) {
  if (!value || typeof value !== "object") return value;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("nullValue" in value) return null;
  if ("timestampValue" in value) return new Date(value.timestampValue);
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decode);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields);
  return undefined;
}

function decodeFields(fields = {}) {
  const out = {};
  for (const [key, wrapped] of Object.entries(fields)) out[key] = decode(wrapped);
  return out;
}

/** List every document in the collection, following pagination. */
async function listAll(token) {
  const docs = [];
  let pageToken = null;

  do {
    const url = new URL(
      `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents/${COLLECTION}`,
    );
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Firestore returned ${res.status}: ${await res.text()}`);
    }

    const json = await res.json();
    for (const doc of json.documents || []) {
      docs.push({ id: doc.name.split("/").pop(), ...decodeFields(doc.fields) });
    }
    pageToken = json.nextPageToken || null;
  } while (pageToken);

  return docs;
}

const COLS = ["testerNumber", "name", "email", "status", "active", "acceptedAt", "deactivationReason"];

function toCsv(rows) {
  const cell = (v) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [COLS.join(","), ...rows.map((r) => COLS.map((c) => cell(r[c])).join(","))].join("\n");
}

(async () => {
  const token = await accessToken();
  const rows = await listAll(token);

  if (process.argv.includes("--csv")) {
    process.stdout.write(toCsv(rows) + "\n");
    return;
  }

  const active = rows.filter((r) => r.active === true).length;
  console.log(`\nTesters in ${PROJECT}/${COLLECTION}: ${rows.length} (${active} active)\n`);

  if (!rows.length) {
    console.log("No tester documents yet.\n");
    return;
  }

  const widths = COLS.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
  );

  const line = (cells) =>
    cells.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join("  ").trimEnd();

  console.log(line(COLS));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));

  const sorted = rows.slice().sort((a, b) => {
    const na = typeof a.testerNumber === "number" ? a.testerNumber : Infinity;
    const nb = typeof b.testerNumber === "number" ? b.testerNumber : Infinity;
    return na - nb;
  });
  for (const r of sorted) console.log(line(COLS.map((c) => r[c])));

  console.log(`\n${rows.length} tester(s). Add --csv for spreadsheet output.\n`);
})().catch((error) => {
  console.error("Failed:", error.message);
  process.exit(1);
});