/**
 * Print the full schema of the users and testers documents.
 *
 * The field inventory in inspect-collections.js came back short, and this is
 * deciding a data migration — so this dumps each document verbatim rather than
 * trusting an aggregate. Read-only.
 *
 *   node scripts/dump-schema.js
 */

const PROJECT = process.env.CRP_FIRESTORE_PROJECT || "crp-cuby-display";
const DATABASE = "(default)";

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

/** Fetch the raw REST payload, so nothing is dropped by decoding. */
async function raw(token, path) {
  const docs = [];
  let page = null;
  do {
    const url = new URL(
      `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents/${path}`,
    );
    url.searchParams.set("pageSize", "300");
    if (page) url.searchParams.set("pageToken", page);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    const json = await res.json();
    docs.push(...(json.documents || []));
    page = json.nextPageToken || null;
  } while (page);
  return docs;
}

/** The raw field names Firestore actually holds, with their type tags. */
const typeOf = (f) => Object.keys(f || {})[0] || "?";

(async () => {
  const token = await accessToken();

  for (const path of ["users", "testers"]) {
    const docs = await raw(token, path);
    console.log(`\n########## ${path} (${docs.length} docs) ##########`);

    const allTypes = new Map();
    for (const doc of docs) {
      const fields = doc.fields || {};
      for (const [k, v] of Object.entries(fields)) {
        if (!allTypes.has(k)) allTypes.set(k, new Set());
        allTypes.get(k).add(typeOf(v));
      }
    }

    console.log(`\n--- every field name present (${allTypes.size}) ---`);
    for (const [name, types] of [...allTypes].sort()) {
      console.log(`  ${name}: ${[...types].join(",")}`);
    }

    console.log("\n--- one full document ---");
    const sample = docs[0];
    if (sample) {
      console.log(`  id: ${sample.name.split("/").pop()}`);
      console.log(JSON.stringify(sample.fields, null, 2));
    }
  }
  console.log("");
})().catch((error) => {
  console.error("Failed:", error.message);
  process.exit(1);
});