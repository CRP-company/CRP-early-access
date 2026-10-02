/**
 * Check whether the testerIndex pointers exist for the current roster.
 *
 * Read-only diagnostic. The tester dashboard resolves a signed-in tester through
 * `testerIndex/{sha256(email)}`, which the Worker writes on acceptance. Testers
 * accepted before that existed have no pointer, and cannot log in until an admin
 * re-approves them so the Worker writes one.
 *
 *   node scripts/check-tester-index.js
 *
 * Run after the first deploy to see who still needs re-approving.
 */

const PROJECT = process.env.CRP_FIRESTORE_PROJECT || "crp-cuby-display";
const DATABASE = "(default)";

async function accessToken() {
  if (process.env.FIREBASE_ACCESS_TOKEN) return process.env.FIREBASE_ACCESS_TOKEN.trim();

  const auth = require("firebase-tools/lib/auth");
  const account = auth.getGlobalDefaultAccount() || (auth.getAllAccounts() || [])[0];
  if (!account?.tokens?.refresh_token) {
    throw new Error("No Firebase CLI login found. Run `firebase login` first.");
  }

  const { OAuth2Client } = require("google-auth-library");
  const client = new OAuth2Client(
    "https://accounts.google.com/o/oauth2/auth",
    "https://oauth2.googleapis.com/token",
  );
  client.setCredentials(account.tokens);
  const { token } = await client.getAccessToken();
  return token;
}

/** Lowercased, trimmed SHA-256 hex — must match hashEmail() in the Worker. */
function hashEmail(email) {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(String(email).trim().toLowerCase()))
    .then((buf) =>
      Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
}

function decodeFields(fields = {}) {
  const one = (v) => {
    if ("stringValue" in v) return v.stringValue;
    if ("integerValue" in v) return Number(v.integerValue);
    if ("booleanValue" in v) return v.booleanValue;
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

(async () => {
  const token = await accessToken();
  const testers = await list(token, "testers");
  const pointers = new Map((await list(token, "testerIndex")).map((p) => [p.id, p]));

  console.log(`\ntesterIndex pointers found: ${pointers.size}\n`);
  console.log("#".padEnd(4) + "name".padEnd(18) + "email".padEnd(32) + "status".padEnd(12) + "login");
  console.log("-".repeat(84));

  let missing = 0;
  const rows = testers.slice().sort((a, b) => (a.testerNumber ?? 0) - (b.testerNumber ?? 0));

  for (const t of rows) {
    const key = await hashEmail(t.email);
    const pointer = pointers.get(key);
    // A revoked tester has no pointer on purpose, so treat it as expected.
    const expectedAbsent = t.active !== true;
    const ok = Boolean(pointer) || expectedAbsent;
    if (!ok) missing += 1;

    console.log(
      String(t.testerNumber ?? "-").padEnd(4) +
        String(t.name || "-").slice(0, 16).padEnd(18) +
        String(t.email || "-").slice(0, 30).padEnd(32) +
        String(t.status || "-").padEnd(12) +
        (pointer ? "OK" : expectedAbsent ? "n/a (not active)" : "MISSING"),
    );
  }

  console.log("");
  if (missing === 0) {
    console.log("Every active tester has a pointer and can sign in.\n");
  } else {
    console.log(
      `${missing} active tester(s) cannot sign in yet. Re-approve each from the admin\n` +
        "dashboard (or run the backfill) so the Worker writes their pointer.\n",
    );
  }
})().catch((error) => {
  console.error("Failed:", error.message);
  process.exit(1);
});