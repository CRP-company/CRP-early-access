/**
 * Compare the `users` and `testers` collections in Firestore, read-only.
 *
 * Diagnostic for the migration from a separate `testers` collection to tester
 * fields on `users`. Prints the shape of both, how they overlap by email, and the
 * cases that block a merge: testers with no `users` document, and users matched by
 * more than one tester record.
 *
 *   node scripts/inspect-collections.js
 *
 * Writes nothing.
 */

const PROJECT = process.env.CRP_FIRESTORE_PROJECT || "crp-cuby-display";
const DATABASE = "(default)";

const fs = require("node:fs");

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

/** Firebase Auth export, read straight off disk if the CLI already made one. */
function authUsers() {
  try {
    const raw = JSON.parse(fs.readFileSync("auth-users.json", "utf8"));
    return raw.users || [];
  } catch {
    return null;
  }
}

function decodeFields(fields = {}) {
  const one = (v) => {
    if ("stringValue" in v) return v.stringValue;
    if ("booleanValue" in v) return v.booleanValue;
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v) return Number(v.doubleValue);
    if ("nullValue" in v) return null;
    if ("timestampValue" in v) return v.timestampValue;
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(one);
    if ("mapValue" in v) return decodeFields(v.mapValue.fields);
    return undefined;
  };
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, one(v)]));
}

async function list(token, path) {
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
    for (const doc of json.documents || []) {
      docs.push({ id: doc.name.split("/").pop(), ...decodeFields(doc.fields) });
    }
    page = json.nextPageToken || null;
  } while (page);
  return docs;
}

const norm = (e) => String(e || "").trim().toLowerCase();

(async () => {
  const token = await accessToken();
  const [users, testers] = await Promise.all([
    list(token, "users"),
    list(token, "testers"),
  ]);

  const auth = authUsers();
  console.log(`\n=== users (${users.length}) ===`);
  for (const u of users) {
    console.log(`  ${u.id}  ${u.email || "(no email)"}`);
  }

  console.log(`\n=== testers (${testers.length}) ===`);
  for (const t of testers) {
    console.log(`  #${t.testerNumber ?? "-"} ${t.id} ${t.email} ${t.status} active=${t.active}`);
  }

  if (auth) {
    console.log(`\n=== firebase auth accounts (${auth.length}) ===`);
    for (const a of auth) {
      console.log(`  ${a.localId || "(no uid)"}  ${a.email || "(no email)"}`);
    }
  } else {
    console.log("\n=== firebase auth accounts: no auth-users.json export found ===");
  }

  const byEmail = new Map(users.map((u) => [norm(u.email), u]));
  const authByEmail = new Map((auth || []).map((a) => [norm(a.email), a]));

  console.log("\n=== merge analysis ===");
  const missing = [];
  const grouped = new Map();

  for (const t of testers) {
    const match = byEmail.get(norm(t.email));
    if (!match) {
      missing.push(t);
      const hasAuth = authByEmail.get(norm(t.email));
      console.log(
        `  #${t.testerNumber ?? "-"} ${t.email}  NO users document` +
          (hasAuth ? `  (auth uid: ${hasAuth.localId})` : "  (and NO firebase auth account)"),
      );
    } else {
      if (!grouped.has(match.id)) grouped.set(match.id, []);
      grouped.get(match.id).push(t);
      console.log(`  #${t.testerNumber ?? "-"} ${t.email}  -> users/${match.id}`);
    }
  }

  console.log("\n=== collisions: one user matched by several testers ===");
  let collisions = 0;
  for (const [userId, list] of grouped) {
    if (list.length > 1) {
      collisions += 1;
      console.log(`  users/${userId} (${list[0].email}) has ${list.length} tester records:`);
      for (const t of list) {
        console.log(`     #${t.testerNumber} ${t.status} active=${t.active} id=${t.id}`);
      }
    }
  }
  if (!collisions) console.log("  none");

  console.log(
    `\nsummary: ${testers.length - missing.length}/${testers.length} testers matched a users document; ` +
      `${missing.length} unmatched; ${collisions} collision(s).\n`,
  );
})().catch((error) => {
  console.error("Failed:", error.message);
  process.exit(1);
});