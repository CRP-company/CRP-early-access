#!/usr/bin/env node
"use strict";

/**
 * Guard against a Cloud Function being exported as `undefined`.
 *
 * This catches the class of mistake where index.js maps a function name to the
 * wrong module (e.g. `testers.recordActivity` when it actually lives in
 * activity.js). Such a mapping looks fine in review and passes `node --check`,
 * but deploys a broken endpoint that only fails when someone calls it.
 */

const path = require("node:path");

const functions = require(path.join(__dirname, "..", "functions", "index.js"));

const names = Object.keys(functions);
const broken = names.filter((name) => typeof functions[name] !== "function");

for (const name of names) {
  const ok = typeof functions[name] === "function";
  console.log(`  ${ok ? "ok     " : "BROKEN "} ${name}`);
}

console.log("");
if (broken.length) {
  console.error(`${broken.length} of ${names.length} exports are not functions:`);
  for (const name of broken) console.error(`  - ${name}`);
  process.exit(1);
}

console.log(`All ${names.length} Cloud Functions are wired correctly.`);
