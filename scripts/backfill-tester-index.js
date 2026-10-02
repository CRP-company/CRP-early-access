/**
 * Write a missing `testerIndex` pointer for every active tester.
 *
 * Why this is needed: the tester portal resolves a signed-in tester through
 * `testerIndex/{sha256(email)}`, which the Worker writes on approval. A tester
 * whose pointer is missing — because they were accepted before that existed, or
 * whose migration left a stale one — is refused at the door with "you are not on
 * the roster", even though their record and number are committed.
 *
 * Read-only by default. `--apply` writes.
 *
 *   node scripts/backfill-tester-index.js           # dry run
 *   node scripts/backfill-tester-index.js --apply   # write the pointers
 *
 * Safe to re-run: a pointer that is already correct is left alone, so this only
 * ever fills gaps. It never touches `tester`, `testerHistory` or anything else on
 * the user document.
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

  // google-auth-library resolves to `{ token }`. Reading `.data` here yields
  // undefined, which is the sort of thing that makes a script look broken
  // rather than wrong.
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("Could not mint an access token from the stored login.");
  return token;
}

/** Lowercased, trimmed SHA-256 hex — must match hashEmail() in the Worker. */
const hashEmail = (email) =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(String(email).trim().toLowerCase()))
    .then((buf) =>
      Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );

/**
 * Decode Firestore fields, INCLUDING nested maps.
 *
 * The scalar-only version of this drops every `tester` map to undefined, which
 * made the check script report an empty roster while testers plainly existed.
 * A diagnostic that lies is worse than none.
 */
function decodeFields(fields = {}) {
  const one = (v) => {
    if (v === null || v === undefined) return undefined;
    if ("stringValue" in v) return v.stringValue;
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v) return Number(v.doubleValue);
    if ("booleanValue" in v) return v.booleanValue;
    if ("nullValue" in v) return null;
    if ("timestampValue" in v) return v.timestampValue;
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(one);
    if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
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

/**
 * Write the pointer.
 *
 * `testerId` is set to null rather than left stale: the portal resolves `userId`,
 * and a leftover `t_...` value would be rejected as a pre-migration pointer.
 */
async function writePointer(token, id, userId) {
  const url = new URL(
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents/testerIndex/${id}` +
      `?updateMask.fieldPaths=userId&updateMask.fieldPaths=testerId&updateMask.fieldPaths=updatedAt`,
  );
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        userId: { stringValue: userId },
        testerId: { nullValue: null },
        updatedAt: { timestampValue: new Date().toISOString() },
      },
    }),
  });
  if (!res.ok) throw new Error(`write ${id}: ${res.status} ${await res.text()}`);
}

(async () => {
  const token = await accessToken();
  const users = (await list(token, "users")).filter((u) => u.tester);
  const pointers = new Map((await list(token, "testerIndex")).map((p) => [p.id, p]));

  console.log(`\nTesters on user documents: ${users.length}`);
  console.log(`Existing pointers:         ${pointers.size}`);
  console.log(APPLY ? "\nApplying writes.\n" : "\nDRY RUN — nothing will be written.\n");

  let wrote = 0;
  let skipped = 0;

  for (const user of users) {
    const t = user.tester;
    const email = t.email || user.email;
    if (!email) {
      console.log(`  ?  ${user.id}: no email on the tester record or the user — skipped`);
      continue;
    }

    const key = await hashEmail(email);
    const existing = pointers.get(key);

    // Already resolvable: a pointer whose userId matches this account. Anything
    // else — absent, stale, or pointing at a different account — gets repaired.
    if (existing && existing.userId === user.id) {
      skipped += 1;
      continue;
    }

    const why = !existing
      ? "missing"
      : !existing.userId
        ? "stale (pre-migration)"
        : "wrong account";

    if (!APPLY) {
      console.log(`  -  #${t.testerNumber ?? "?"} ${email} — would write (${why})`);
      continue;
    }

    await writePointer(token, key, user.id);
    wrote += 1;
    console.log(`  ✓  #${t.testerNumber ?? "?"} ${email} — pointer written (${why})`);
  }

  console.log("");
  if (!APPLY) {
    console.log("Dry run complete. Re-run with --apply to write the pointer(s) above.");
  } else {
    console.log(`Done. ${wrote} written, ${skipped} already correct.`);
  }
  console.log("");
})().catch((e) => {
  console.error("backfill failed:", e.message);
  process.exit(1);
});