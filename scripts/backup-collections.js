/**
 * Back up the users and testers collections to backup/, read-only against Firestore.
 *
 * Run this before anything that writes to the database. The output is the exact
 * REST payload, so a restore is a PATCH of the same documents and does not depend
 * on this script's decoding staying correct.
 *
 *   node scripts/backup-collections.js
 *
 * Backup files are gitignored — they contain real names and email addresses.
 */

const fs = require("node:fs");
const path = require("node:path");

const PROJECT = process.env.CRP_FIRESTORE_PROJECT || "crp-cuby-display";
const DATABASE = "(default)";
const COLLECTIONS = ["users", "testers", "testerIndex", "requests", "audit"];

async function accessToken() {
  if (process.env.FIREBASE_ACCESS_TOKEN) return process.env.FIREBASE_ACCESS_TOKEN.trim();
  const auth = require("firebase-tools/lib/auth");
  const account = auth.getGlobalDefaultAccount() || (auth.getAllAccounts() || [])[0];
  if (!account?.tokens?.refresh_token) throw new Error("Run `firebase login` first.");
  const { OAuth2Client } = require("google-auth-library");
  const client = new OAuth2Client(
    "https://accounts.google.com/o/oauth2/auth",
    "https://oauth2.googleapis.com/token",
  );
  client.setCredentials(account.tokens);
  return (await client.getAccessToken()).token;
}

/** Raw documents, untouched — this is what makes the backup restorable. */
async function listRaw(token, collection) {
  const docs = [];
  let page = null;
  do {
    const url = new URL(
      `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents/${collection}`,
    );
    url.searchParams.set("pageSize", "300");
    if (page) url.searchParams.set("pageToken", page);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    // A collection that does not exist yet is not an error worth stopping for.
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${collection}: ${res.status} ${await res.text()}`);
    const json = await res.json();
    for (const doc of json.documents || []) docs.push(doc);
    page = json.nextPageToken || null;
  } while (page);
  return docs;
}

(async () => {
  const token = await accessToken();
  const dir = path.join(__dirname, "..", "backup");
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = { project: PROJECT, database: DATABASE, takenAt: new Date().toISOString() };

  for (const collection of COLLECTIONS) {
    const docs = await listRaw(token, collection);
    if (docs === null) {
      console.log(`  ${collection}: does not exist, skipped`);
      continue;
    }
    out[collection] = docs;
    console.log(`  ${collection}: ${docs.length} document(s)`);
  }

  const file = path.join(dir, `pre-migrate-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  console.log(`\nBackup written to ${path.relative(process.cwd(), file)}`);
  console.log(`(${fs.statSync(file).size} bytes)\n`);
})().catch((error) => {
  console.error("Failed:", error.message);
  process.exit(1);
});