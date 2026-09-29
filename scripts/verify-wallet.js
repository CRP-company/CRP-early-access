#!/usr/bin/env node
"use strict";

/**
 * Smoke test for the Google Wallet pass builder.
 *
 * Verifies the generated JWT is well formed, signed with RS256, and — most
 * importantly — that the pass `state` follows the tester's `active` flag, so a
 * deactivated tester gets a REVOKED card.
 *
 * Run with the service account JSON in the environment:
 *   GOOGLE_APPLICATION_CREDENTIALS_JSON="$(cat crp-tester-card-*.json)" \
 *     node scripts/verify-wallet.js
 */

const assert = require("node:assert");
const { buildSaveUrl } = require("../functions/src/wallet.js");

const tester = { id: "t_abc123XYZ789", name: "Alex Morgan" };

function claimsOf(url) {
  const token = url.split("/save/")[1];
  const [header, payload] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString()),
    claims: JSON.parse(Buffer.from(payload, "base64url").toString()),
  };
}

const activeUrl = buildSaveUrl(tester, true);
const inactiveUrl = buildSaveUrl(tester, false);

const active = claimsOf(activeUrl);
const inactive = claimsOf(inactiveUrl);

const activeObject = active.claims.payload.loyaltyObjects[0];
const inactiveObject = inactive.claims.payload.loyaltyObjects[0];
const loyaltyClass = active.claims.payload.loyaltyClasses[0];

assert.strictEqual(activeUrl.startsWith("https://pay.google.com/gp/v/save/"), true);
assert.strictEqual(active.header.alg, "RS256", "must be signed with RS256");
assert.strictEqual(active.claims.typ, "savetowallet");
assert.strictEqual(active.claims.aud, "google");
assert.deepStrictEqual(active.claims.origins, ["https://crp-company.github.io"]);

assert.strictEqual(activeObject.state, "ACTIVE", "active tester gets an ACTIVE pass");
assert.strictEqual(inactiveObject.state, "REVOKED", "inactive tester gets a REVOKED pass");

// The pass id must be derived from the tester, not shared across testers.
assert.strictEqual(activeObject.id, `${loyaltyClass.id.split(".")[0]}.crp_tester_loyalty_t_abc123XYZ789`);
assert.strictEqual(activeObject.accountId, "CRP-ABC123XY");
assert.strictEqual(activeObject.barcode.value, "CRP-ABC123XY");

// Two testers must never collide on a pass id.
const other = claimsOf(buildSaveUrl({ id: "t_zzz999YYY111", name: "Sam Lee" }, true));
assert.notStrictEqual(
  other.claims.payload.loyaltyObjects[0].id,
  activeObject.id,
  "different testers must get different pass ids",
);

console.log("All wallet checks passed.");
console.log("  class id   :", loyaltyClass.id);
console.log("  active pass:", activeObject.accountId, activeObject.state);
console.log("  inactive   :", inactiveObject.accountId, inactiveObject.state);
console.log("\nAdd to Google Wallet (active):\n" + activeUrl);
