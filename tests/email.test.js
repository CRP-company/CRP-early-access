#!/usr/bin/env node
"use strict";

/**
 * Tests for the acknowledgement email template and the Resend send path.
 *
 * No network calls: the Resend client is stubbed, so this runs anywhere.
 *   npm run test:email
 */

const assert = require("node:assert");
const path = require("node:path");

const FN = path.join(__dirname, "..", "functions");

// Requiring the function module initialises the Admin SDK, which insists on a
// project id. Set a throwaway one before any of our modules load; the Resend
// path under test is stubbed and never reaches Firestore.
process.env.GCLOUD_PROJECT ||= "crp-email-test";
process.env.FIREBASE_CONFIG ||= JSON.stringify({ projectId: process.env.GCLOUD_PROJECT });
const {
  buildApplicationReceivedEmail,
  escapeHtml,
  greetingFor,
} = require(path.join(FN, "src", "email-template.js"));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ------------------------------------------------------------ escaping */

test("escapes HTML-significant characters", () => {
  assert.strictEqual(escapeHtml('<b>"x"</b>'), "&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
  assert.strictEqual(escapeHtml("a & b"), "a &amp; b");
  assert.strictEqual(escapeHtml("it's"), "it&#39;s");
});

test("a hostile name cannot inject markup into the email", () => {
  // greetingFor() strips everything that is not a letter/digit, so the tag
  // never survives in any form; escapeHtml then mops up the rest. Assert on
  // the outcome that matters: no live tag, no event handler.
  const { html } = buildApplicationReceivedEmail({
    name: '<img src=x onerror="alert(1)">',
    email: "x@example.com",
  });
  assert.ok(!html.includes("<img src=x"), "raw img tag must not survive");
  assert.ok(!/<img[^>]*onerror/i.test(html), "event handler must not survive");
  assert.ok(!/onerror=/.test(html), "onerror must not appear at all");
});

test("a hostile email is escaped too", () => {
  const { html } = buildApplicationReceivedEmail({ name: "Alex", email: "a@b.c<script>" });
  assert.ok(!html.includes("<script>"));
});

/* ----------------------------------------------------------- greeting */

test("greeting uses only the first name", () => {
  assert.strictEqual(greetingFor("Alex Morgan"), "Alex");
  assert.strictEqual(greetingFor("  Alex   Morgan "), "Alex");
  assert.strictEqual(greetingFor("Jean-Luc Picard"), "Jean-Luc");
  assert.strictEqual(greetingFor("Zoë O'Brien"), "Zoë");
});

test("greeting degrades safely on empty or punctuation-only names", () => {
  assert.strictEqual(greetingFor(""), "there");
  assert.strictEqual(greetingFor("   "), "there");
  assert.strictEqual(greetingFor("..."), "there");
  assert.strictEqual(greetingFor(undefined), "there");
  assert.strictEqual(greetingFor("<b>"), "there");
});

/* ------------------------------------------------------------ content */

test("subject matches the agreed wording exactly", () => {
  const { subject } = buildApplicationReceivedEmail({ name: "A", email: "a@b.c" });
  assert.strictEqual(subject, "CRP Tester Program — Application Received");
});

test("html contains the required copy and both images", () => {
  const { html } = buildApplicationReceivedEmail({
    name: "Alex Morgan",
    email: "alex@example.com",
  });
  assert.ok(html.includes("We're reviewing your application."));
  assert.ok(html.includes("Hi Alex"));
  assert.ok(html.includes("Thank you for applying to the CRP Tester Program."));
  assert.ok(html.includes("We'll notify you by email once there's an update."));
  assert.ok(html.includes("Thank you for your interest in CRP."));
  assert.ok(html.includes("https://i.postimg.cc/K8zf4q4q/CRPlogo.png"));
  assert.ok(
    html.includes("1776869274976-74e932ff-18d5-462e-885b-c6ed42d42bcf.png"),
    "hero image must be present",
  );
});

test("text alternative mirrors the html copy", () => {
  const { text } = buildApplicationReceivedEmail({
    name: "Alex Morgan",
    email: "alex@example.com",
  });
  assert.ok(text.includes("Hi Alex"));
  assert.ok(text.includes("CRP Tester Program"));
  assert.ok(text.includes("Thank you for your interest in CRP."));
  assert.ok(text.includes("https://"));
});

test("no leftover template markers", () => {
  const { html, text } = buildApplicationReceivedEmail({ name: "A", email: "a@b.c" });
  for (const blob of [html, text]) {
    assert.ok(!blob.includes("undefined"), "must not print 'undefined'");
    assert.ok(!blob.includes("{{"), "no unrendered mustache tags");
    assert.ok(!blob.includes("[object Object]"));
  }
});

test("email html is safe for mail clients", () => {
  const { html } = buildApplicationReceivedEmail({ name: "A", email: "a@b.c" });
  assert.ok(html.includes("<!DOCTYPE html>"));
  assert.ok(html.includes('role="presentation"'), "layout must be tables");
  assert.ok(!/<script/i.test(html), "no scripts in an email");
  assert.ok(!/<style/i.test(html), "inline styles only");
});

/* ------------------------------------------------------- Resend wiring */

// sendApplicationReceived touches Firestore (skip-if-sent check, then stamping
// acknowledgementSentAt). Point the module at a stub so these stay offline;
// the Firestore behaviour itself is covered by the rules suite.
function stubFirestore() {
  const firebase = require(path.join(FN, "src", "firebase.js"));

  const updates = [];
  firebase.db = () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false, data: () => ({}) }),
        update: async (payload) => updates.push(payload),
      }),
    }),
  });

  // email.js calls db() through the module object, so re-requiring it picks up
  // the stub. Also stub audit so it does not reach Firestore.
  const audit = require(path.join(FN, "src", "audit.js"));
  audit.record = async () => {};

  delete require.cache[require.resolve(path.join(FN, "src", "email.js"))];
  return { email: require(path.join(FN, "src", "email.js")), updates };
}

test("send includes a stable idempotency key and returns the id", async () => {
  const { email, updates } = stubFirestore();
  const sent = [];

  email.__setClientForTesting({
    emails: {
      send: async (payload, options) => {
        sent.push({ payload, options });
        return { data: { id: "stub-email-id" }, error: null };
      },
    },
  });

  const result = await email.sendApplicationReceived(
    { name: "Alex Morgan", email: "alex@example.com" },
    "req_123",
  );

  assert.strictEqual(result.id, "stub-email-id");
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].payload.to[0], "alex@example.com");
  assert.strictEqual(
    sent[0].options.idempotencyKey,
    "application-received/req_123",
    "idempotency key must be stable per request",
  );
  assert.strictEqual(sent[0].payload.subject, "CRP Tester Program — Application Received");
  assert.ok(
    updates.some((u) => u.acknowledgementResendId === "stub-email-id"),
    "must stamp the resend id on the request",
  );
});

test("a Resend error is raised so Firestore retries", async () => {
  const { email } = stubFirestore();

  email.__setClientForTesting({
    emails: {
      send: async () => ({
        data: null,
        error: { message: "Invalid from address", statusCode: 422 },
      }),
    },
  });

  await assert.rejects(
    () => email.sendApplicationReceived({ name: "A", email: "a@b.c" }, "req_fail"),
    /Invalid from address/,
  );
});

/* ------------------------------------------------- secret wiring guard */

test("every email function declares the RESEND_API_KEY secret", () => {
  // Reading process.env is not enough on its own: firebase-functions only
  // injects a Secret Manager value into a function that opts in via the
  // `secrets` option. Without this, the key is stored but never delivered and
  // every send throws at runtime — a failure no offline test would otherwise
  // catch, because tests stub the client.
  const src = require("node:fs").readFileSync(
    path.join(FN, "src", "email.js"),
    "utf8",
  );

  // Match the options object up to its closing brace, allowing for nested
  // braces in values. A non-greedy `[\s\S]*?` stops at the first `}`, which is
  // inside the document path template literal, so anchor on the next field.
  const triggerOptions = [...src.matchAll(/onDocumentCreated\(\s*\{([\s\S]*?)\n\s*\}/g)]
    .map((m) => m[1]);

  assert.ok(triggerOptions.length >= 2, "expected both email triggers to be found");

  for (const opts of triggerOptions) {
    assert.ok(
      /secrets:\s*\[\s*"RESEND_API_KEY"\s*\]/.test(opts),
      `a trigger is missing the secrets binding:\n${opts.trim()}`,
    );
  }
});

test("no email source file hardcodes a resend key", () => {
  const fs = require("node:fs");
  for (const file of ["email.js", "email-template.js"]) {
    const src = fs.readFileSync(path.join(FN, "src", file), "utf8");
    // A real key looks like re_<alphanumerics>. Any literal would be a leak.
    assert.ok(
      !/re_[A-Za-z0-9]{20,}/.test(src),
      `${file} appears to contain a hardcoded API key`,
    );
  }
});

test(".env is gitignored and .env.example is not", () => {
  const { execSync } = require("node:child_process");
  const root = path.join(__dirname, "..");
  const check = (p) => {
    try {
      execSync(`git check-ignore -q "${p}"`, { cwd: root });
      return true;
    } catch {
      return false;
    }
  };
  assert.strictEqual(check("functions/.env"), true, "functions/.env MUST be gitignored");
  assert.strictEqual(
    check("functions/.env.example"),
    false,
    "the example template must stay committed",
  );
});

/* ---------------------------------------------------------------- run */

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL  ${name}`);
      console.log(`        ${String(error.message).split("\n")[0]}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} email tests passed.`);
  process.exit(failed ? 1 : 0);
})();
