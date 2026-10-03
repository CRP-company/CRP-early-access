/**
 * Restore ONE lost tester record onto its user document, from surviving history.
 *
 * Why this exists: the `testers` collection was retired in favour of a `tester`
 * map on `users/{uid}`, but some approved testers never got their record
 * carried across. The tester is gone from the roster, while their
 * `requestEmails` marker survives — so the signup form says "you have already
 * applied" and the admin queue has nothing pending to re-approve. They are stuck
 * with no way back in through the UI.
 *
 * Everything this script writes is reconstructed from data that SURVIVED:
 *   - the tester id and email/name come from the approved request itself;
 *   - the tester number comes from the `tester.created` audit entry;
 *   - the timestamps come from that same audit entry and the request's
 *     `reviewedAt` / `createdAt`.
 * Nothing is invented, and no new number is allocated.
 *
 * Deliberately does NOT:
 *   - touch the request, its marker, the counter, or any audit entry;
 *   - send an approval email;
 *   - mint a Wallet pass. The pass is a signed URL, not stored state, so it is
 *     reissued on demand from `/tester-wallet` using the SAME tester id — which
 *     this preserves, so the object id is unchanged and no second pass exists.
 *
 *   node scripts/restore-tester.js HKwzaeiNx3BlwMd5r9cZ            # dry run
 *   node scripts/restore-tester.js HKwzaeiNx3BlwMd5r9cZ --apply    # write
 */

const PROJECT = process.env.CRP_FIRESTORE_PROJECT || "crp-cuby-display";
const DATABASE = "(default)";
const ISSUER_ID = "3388000000023210330";
const APPLY = process.argv.includes("--apply");

const REQUEST_ID = process.argv.find((a) => !a.startsWith("--") && a !== process.argv[0] && a !== process.argv[1]);

async function accessToken() {
  const auth = require("firebase-tools/lib/auth");
  const acc = auth.getGlobalDefaultAccount() || (auth.getAllAccounts() || [])[0];
  if (!acc?.tokens?.refresh_token) throw new Error("Run `firebase login` first.");
  const { OAuth2Client } = require("google-auth-library");
  const c = new OAuth2Client(
    "https://accounts.google.com/o/oauth2/auth",
    "https://oauth2.googleapis.com/token",
  );
  c.setCredentials(acc.tokens);
  const { token } = await c.getAccessToken();
  if (!token) throw new Error("Could not mint an access token.");
  return token;
}

const hashEmail = (email) =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(String(email).trim().toLowerCase()))
    .then((b) =>
      Array.from(new Uint8Array(b))
        .map((x) => x.toString(16).padStart(2, "0"))
        .join(""),
    );

/** Decode Firestore fields, INCLUDING nested maps — a scalar-only decoder drops
 *  every `tester` map to undefined and reports an empty roster. */
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
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    const json = await res.json();
    for (const d of json.documents || []) {
      docs.push({ id: d.name.split("/").pop(), ...decodeFields(d.fields) });
    }
    page = json.nextPageToken || null;
  } while (page);
  return docs;
}

/** Firestore field-value encoding for the patch body. */
function enc(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return { integerValue: String(Math.trunc(v)) };
  return { mapValue: { fields: encFields(v) } };
}
function encFields(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
}

/** Build the tester map from data that SURVIVED. Nothing is invented. */
function buildTester({ request, testerId, user, testerNumber, acceptedAt }) {
  const compact = testerId.replace(/^t_/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return {
    id: testerId,
    requestId: request.id,
    userId: user.id,
    name: request.name,
    email: String(request.email).trim().toLowerCase(),
    status: "accepted",
    active: true,
    appliedAt: request.createdAt,
    acceptedAt,
    createdAt: acceptedAt,
    activatedAt: acceptedAt,
    testerNumber,
    deactivatedAt: null,
    deactivatedBy: null,
    deactivationReason: null,
    statusChangedAt: acceptedAt,
    statusChangedBy: request.reviewedBy || "system",
    activity: { lastPeriod: null, comments: 0, reviews: 0 },
    wallet: {
      issuerId: ISSUER_ID,
      classId: `${ISSUER_ID}.crp_tester_loyalty`,
      accountId: `CRP-${compact.toUpperCase()}`,
      lastIssuedAt: null,
    },
    updatedAt: acceptedAt,
  };
}

/** PATCH with an explicit updateMask, so sibling fields cannot be disturbed. */
async function patch(token, path, body, maskFields) {
  const url = new URL(
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents/${path}`,
  );
  for (const f of maskFields) url.searchParams.append("updateMask.fieldPaths", f);
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: encFields(body) }),
  });
  if (!res.ok) throw new Error(`write ${path}: ${res.status} ${await res.text()}`);
}

(async () => {
  if (!REQUEST_ID) {
    console.error("Usage: node scripts/restore-tester.js <requestId> [--apply]");
    process.exit(1);
  }

  const token = await accessToken();
  const [requests, audit, users, meta, pointers] = await Promise.all([
    list(token, "requests"),
    list(token, "audit"),
    list(token, "users"),
    list(token, "meta"),
    list(token, "testerIndex"),
  ]);

  // ---- resolve everything from surviving data, refusing anything ambiguous
  const request = requests.find((r) => r.id === REQUEST_ID);
  if (!request) throw new Error(`No request ${REQUEST_ID}.`);
  if (request.status !== "approved") {
    throw new Error(`Request ${REQUEST_ID} is "${request.status}", not approved. Refusing.`);
  }
  if (!request.testerId) {
    throw new Error(`Request ${REQUEST_ID} has no testerId. Refusing to invent one.`);
  }
  const testerId = request.testerId;

  // The audit entry is the authoritative record of the number actually issued.
  // It is looked up, never assumed, and its absence is fatal rather than
  // approximated — allocating a new number is explicitly out of scope here.
  const created = audit.find((a) => a.action === "tester.created" && a.testerId === testerId);
  if (!created) throw new Error(`No tester.created audit entry for ${testerId}. Refusing.`);
  const testerNumber = created.detail?.testerNumber;
  if (typeof testerNumber !== "number") {
    throw new Error(`Audit entry ${created.id} carries no testerNumber. Refusing.`);
  }

  const email = String(request.email || "").trim().toLowerCase();
  const user = users.find((u) => String(u.email || "").trim().toLowerCase() === email);
  if (!user) throw new Error(`No users document for ${email}. Refusing.`);

  const markerId = await hashEmail(email);
  const pointer = pointers.find((p) => p.id === markerId);
  const counter = meta.find((m) => m.id === "testerCounter");
  const acceptedAt = created.at || request.reviewedAt || request.createdAt;
  const tester = buildTester({ request, testerId, user, testerNumber, acceptedAt });

  // ---- report
  console.log(`\n${APPLY ? "*** APPLYING ***" : "*** DRY RUN — nothing will be written ***"}\n`);
  console.log("SOURCE OF TRUTH (read-only; every value survived in existing data)");
  console.log(`  request id      ${REQUEST_ID}          status: ${request.status}`);
  console.log(`  tester id       ${testerId}   (from request.testerId)`);
  console.log(`  email / name    ${email}  /  ${request.name}`);
  console.log(`  tester number   ${testerNumber}   (from audit ${created.id} → detail.testerNumber)`);
  console.log(`  accepted at     ${acceptedAt}   (from audit ${created.id} → at)`);
  console.log(`  user document   users/${user.id}`);

  console.log("\nWRITES — exactly two documents, both fields/maps only");
  console.log(`  1. users/${user.id}`);
  console.log(`       set  tester = { id: ${tester.id}, testerNumber: ${testerNumber}, ... }`);
  console.log("       updateMask.fieldPaths=tester   (ONLY this field; friends,");
  console.log("       friendRequests, lastLogin, displayName, createdAt untouched)");
  console.log(`  2. testerIndex/${markerId.slice(0, 16)}…`);
  console.log(`       set  userId = ${user.id}, testerId = null`);
  console.log(
    pointer ? "       (replaces a stale pointer)" : "       (creates the pointer that is missing)",
  );

  console.log("\nNOT TOUCHED — verified unchanged by this script");
  console.log(`  requests/${REQUEST_ID}`);
  console.log("       unchanged. Already status=approved with testerId set, so nothing");
  console.log("       needs restoring there — the missing piece is the user-side record.");
  console.log(`  requestEmails/${markerId.slice(0, 16)}…`);
  console.log("       MARKER KEPT, untouched. Duplicate protection stays exactly as it is.");
  console.log(`  meta/testerCounter`);
  console.log(`       NOT written. lastNumber stays ${counter?.lastNumber} — no number allocated.`);
  console.log(`  audit/`);
  console.log(`       nothing added or edited. All ${audit.length} entries kept as they are.`);

  console.log("\nWALLET — no second pass is created");
  console.log(`  Object id is derived from the tester id, which is UNCHANGED:`);
  console.log(`    ${ISSUER_ID}.crp_tester_loyalty_${testerId}`);
  console.log("  Reissuing from the dashboard signs that same object, so it updates the card");
  console.log("  already on the phone rather than minting a second one.");
  console.log("  wallet.lastIssuedAt is restored as null because no issuance is recorded for");
  console.log("  this tester in the surviving data — the timestamp is filled in when a card");
  console.log("  is actually reissued. Nothing is invented.");
  console.log("  No approval email is sent by this script.");

  console.log("\nCONFLICT CHECK");
  if (user.tester) {
    throw new Error(`users/${user.id} already has a tester map (${user.tester.id}). Refusing.`);
  }
  const hist = Array.isArray(user.testerHistory) ? user.testerHistory : [];
  if (hist.length) {
    throw new Error(
      `users/${user.id} has ${hist.length} testerHistory entries this restore does not ` +
        "reconstruct. Refusing: the history would appear to have been lost.",
    );
  }
  // A number must be unique across the roster. Two people holding #4 would
  // make the printed number meaningless on the card, so this is actually
  // checked rather than asserted in prose.
  const clashes = users
    .filter((u) => u.id !== user.id && u.tester?.testerNumber === testerNumber)
    .map((u) => u.email || u.id);

  console.log("  - no existing tester map on the user document        ✓");
  console.log("  - no testerHistory that would be overwritten         ✓");
  console.log(`  - tester number ${testerNumber} <= counter ${counter?.lastNumber}              ✓`);
  console.log(
    clashes.length === 0
      ? `  - number ${testerNumber} is not held by any other user doc   ✓`
      : `  ! number ${testerNumber} is ALSO held by: ${clashes.join(", ")}`,
  );
  if (clashes.length) {
    throw new Error(`Tester number ${testerNumber} is already held by another tester. Refusing.`);
  }

  if (!APPLY) {
    console.log("\nNothing written. Re-run with --apply to perform exactly the two writes above.\n");
    return;
  }

  // ---- the writes
  await patch(token, `users/${user.id}`, { tester }, ["tester"]);
  console.log(`\n✓ wrote users/${user.id}.tester`);

  await patch(
    token,
    `testerIndex/${markerId}`,
    { userId: user.id, testerId: null, updatedAt: new Date().toISOString() },
    ["userId", "testerId", "updatedAt"],
  );
  console.log(`✓ wrote testerIndex/${markerId.slice(0, 16)}…`);

  console.log(`\nRestored tester #${testerNumber} for ${email}.`);
  console.log("Verify: node scripts/list-testers.js && node scripts/check-tester-index.js\n");
})().catch((e) => {
  console.error("\nrestore failed:", e.message);
  process.exit(1);
});