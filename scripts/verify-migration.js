/**
 * Verify the testers-to-users migration landed correctly.
 *
 * Checks the thing that actually matters: that the tester data now on each user
 * matches the source `testers` document, and that nothing that was on the user
 * before the migration was lost.
 *
 *   node scripts/verify-migration.js
 *
 * Compares against backup/pre-migrate-*.json when present, so it can prove the
 * preserved fields are unchanged.
 */

const fs = require("node:fs");
const path = require("node:path");

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

async function list(token, collection) {
  const docs = [];
  let page = null;
  do {
    const url = new URL(
      `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents/${collection}`,
    );
    url.searchParams.set("pageSize", "300");
    if (page) url.searchParams.set("pageToken", page);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${collection}: ${res.status}`);
    const json = await res.json();
    for (const doc of json.documents || []) {
      docs.push({ id: doc.name.split("/").pop(), ...decodeFields(doc.fields) });
    }
    page = json.nextPageToken || null;
  } while (page);
  return docs;
}

/** The newest pre-migrate backup, if one was taken. */
function loadBackup() {
  try {
    const dir = path.join(__dirname, "..", "backup");
    const files = fs.readdirSync(dir).filter((f) => f.startsWith("pre-migrate-")).sort();
    if (!files.length) return null;
    return JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), "utf8"));
  } catch {
    return null;
  }
}

const norm = (e) => String(e || "").trim().toLowerCase();

/** Fields that existed before the migration and must be untouched by it. */
const PRESERVED = ["displayName", "email", "uid", "createdAt", "friends", "friendRequests", "lastLogin"];

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};

(async () => {
  const token = await accessToken();
  const [users, testers] = await Promise.all([list(token, "users"), list(token, "testers")]);
  const backup = loadBackup();

  const withTester = users.filter((u) => u.tester !== undefined);
  console.log(`\n=== users carrying tester data (${withTester.length}/${users.length}) ===`);

  for (const u of withTester) {
    console.log(`\nusers/${u.id}  ${u.email}`);
    console.log(`   tester         #${u.tester.testerNumber} ${u.tester.status} active=${u.tester.active}`);
    const hist = u.testerHistory || [];
    console.log(
      `   testerHistory  ${hist.length ? hist.map((h) => `#${h.testerNumber} ${h.status}`).join(", ") : "(empty)"}`,
    );
  }

  console.log("\n=== checks ===");

  // Every copied record must still match its source document.
  const sourceById = new Map(testers.map((t) => [t.id, t]));
  const totalCopies = withTester.reduce((n, u) => n + 1 + (u.testerHistory?.length || 0), 0);
  let matched = 0;
  for (const u of withTester) {
    for (const copy of [u.tester, ...(u.testerHistory || [])]) {
      const src = sourceById.get(copy.id);
      const same =
        src &&
        src.testerNumber === copy.testerNumber &&
        src.status === copy.status &&
        src.active === copy.active &&
        norm(src.email) === norm(copy.email);
      if (same) matched += 1;
      else check(false, `users/${u.id}: copied record ${copy.id} does not match its source`);
    }
  }
  check(matched === totalCopies, `all ${totalCopies} copied tester records match their source`);

  // testers/ must be untouched — nothing deleted.
  check(testers.length === 5, `testers/ still holds all 5 documents (found ${testers.length})`);

  // Nothing that was on the user before may have changed.
  if (backup?.users) {
    const before = new Map(
      backup.users.map((d) => [d.name.split("/").pop(), decodeFields(d.fields)]),
    );
    let ok = true;
    for (const [id, old] of before) {
      const now = users.find((u) => u.id === id);
      if (!now) {
        ok = false;
        console.log(`       users/${id} is missing`);
        continue;
      }
      for (const field of PRESERVED) {
        if (old[field] === undefined) continue;
        if (JSON.stringify(now[field]) !== JSON.stringify(old[field])) {
          ok = false;
          console.log(`       users/${id}.${field} changed`);
        }
      }
    }
    check(ok, `every pre-existing field on all ${before.size} users is unchanged`);
  } else {
    console.log("  SKIP  no pre-migrate backup found to compare against");
  }

  // No user may hold tester data belonging to somebody else.
  for (const u of withTester) {
    const owns = testers.some((t) => t.id === u.tester.id && norm(t.email) === norm(u.email));
    check(owns, `users/${u.id}: tester record belongs to this user's own email`);
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error("Failed:", error.message);
  process.exit(1);
});