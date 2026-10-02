/**
 * Copy tester records onto the matching `users` documents as a `tester` field.
 *
 * The program moves from two collections to one: a person is a `users` document
 * that may also be a tester, instead of a separate `testers` document.
 *
 * Non-destructive by construction:
 *   - `testers` is only ever read. Nothing is deleted or modified there.
 *   - `users` is written with an update mask limited to `tester` and
 *     `testerHistory`, so `displayName`, `email`, `friends`, `friendRequests`,
 *     `lastLogin` and anything else already present is left exactly as it is.
 *
 * Shape:
 *   users/{uid}.tester          the current record — the active one if there is
 *                               one, otherwise the most recently accepted
 *   users/{uid}.testerHistory   every other record for that person, oldest first
 *
 * A person can legitimately hold several tester records: re-applying after a
 * rejection leaves the old record behind. Collapsing those into one field would
 * discard that history, so the current record is separated from the rest.
 *
 *   node scripts/migrate-testers-to-users.js            # dry run, writes nothing
 *   node scripts/migrate-testers-to-users.js --apply    # actually writes
 */

const PROJECT = process.env.CRP_FIRESTORE_PROJECT || "crp-cuby-display";
const DATABASE = "(default)";
const APPLY = process.argv.includes("--apply");

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

/** Re-encode a plain value into the REST write format. */
function encodeValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (typeof value === "object") return { mapValue: { fields: encodeFields(value) } };
  throw new TypeError(`Cannot encode ${typeof value}`);
}

function encodeFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = encodeValue(v);
  }
  return out;
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

/**
 * Which record is current: the active one if there is one, otherwise the highest
 * tester number. A revoked person still needs a `tester` object, or the app would
 * read "no tester data" instead of "tester, not active".
 */
function pickCurrent(list) {
  const active = list.filter((t) => t.active === true);
  const pool = active.length ? active : list;
  return pool.reduce((best, t) =>
    (t.testerNumber ?? -1) >= (best.testerNumber ?? -1) ? t : best,
  );
}

const norm = (e) => String(e || "").trim().toLowerCase();

/** Fields that must never be written by this script. */
const PROTECTED = new Set(["displayName", "email", "uid", "createdAt", "friends", "friendRequests", "lastLogin"]);

function assertNoProtectedWrites(patch, uid) {
  for (const key of Object.keys(patch)) {
    if (PROTECTED.has(key)) {
      throw new Error(`Refusing to write protected field "${key}" on users/${uid}`);
    }
  }
}

(async () => {
  const token = await accessToken();
  const [users, testers] = await Promise.all([list(token, "users"), list(token, "testers")]);

  const byEmail = new Map(users.map((u) => [norm(u.email), u]));
  const groups = new Map();
  for (const t of testers) {
    const key = norm(t.email);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const plan = [];
  const unmatched = [];

  for (const [email, records] of groups) {
    const user = byEmail.get(email);
    if (!user) {
      unmatched.push(records);
      continue;
    }
    const current = pickCurrent(records);
    const history = records
      .filter((t) => t.id !== current.id)
      .sort((a, b) => (a.testerNumber ?? 0) - (b.testerNumber ?? 0));

    const patch = { tester: { ...current }, testerHistory: history.map((t) => ({ ...t })) };
    assertNoProtectedWrites(patch, user.id);

    plan.push({ user, patch, current, history });
  }

  console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} — ${plan.length} user document(s)\n`);

  for (const item of plan) {
    const kept = Object.keys(item.user).filter((k) => k !== "id");
    console.log(`users/${item.user.id}  (${item.user.email})`);
    console.log(
      `   tester         <- #${item.current.testerNumber} ${item.current.status} ` +
        `active=${item.current.active}`,
    );
    console.log(
      `   testerHistory  <- ${
        item.history.length
          ? item.history.map((h) => `#${h.testerNumber} ${h.status}`).join(", ")
          : "(empty)"
      }`,
    );
    console.log(`   preserved      <- ${kept.join(", ")}`);
    console.log("");
  }

  if (unmatched.length) {
    console.log("NOT migrated — no users document to attach to:");
    for (const records of unmatched) {
      for (const t of records) {
        console.log(`   #${t.testerNumber} ${t.email} (${t.status}) — left in testers/, untouched`);
      }
    }
    console.log("");
  }

  if (!APPLY) {
    console.log("Dry run — nothing written. Re-run with --apply to make these changes.\n");
    return;
  }

  for (const item of plan) {
    const name = `projects/${PROJECT}/databases/${DATABASE}/documents/users/${item.user.id}`;
    // The mask is what makes this safe: Firestore only touches these two fields.
    const url = `https://firestore.googleapis.com/v1/${name}` +
      "?updateMask.fieldPaths=tester&updateMask.fieldPaths=testerHistory";

    const res = await fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: encodeFields(item.patch) }),
    });

    if (!res.ok) {
      console.error(`  FAILED users/${item.user.id}: ${res.status} ${await res.text()}`);
      process.exitCode = 1;
    } else {
      console.log(`  wrote users/${item.user.id}`);
    }
  }

  console.log(`\nDone. ${plan.length} document(s) updated. testers/ was not modified.\n`);
})().catch((error) => {
  console.error("Failed:", error.message);
  process.exit(1);
});