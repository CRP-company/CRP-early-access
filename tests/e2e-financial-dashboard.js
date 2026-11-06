#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

console.log("Admin Financial Dashboard — HTML & UI Integrity Verification\n");

const htmlPath = path.join(__dirname, "../admin/index.html");
const cssPath = path.join(__dirname, "../admin/css/admin.css");
const jsPath = path.join(__dirname, "../admin/js/financial.js");

const html = fs.readFileSync(htmlPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");

let passed = 0;
function pass(msg) {
  console.log(`  PASS  ${msg}`);
  passed += 1;
}

// 1. Navigation verification
assert.ok(html.includes('id="nav-tab-early-access"'), "Missing Early Access nav tab");
assert.ok(html.includes('id="nav-tab-financial"'), "Missing Financial nav tab");
pass("Main navigation tabs present (Early Access & Financial)");

// 2. Section isolation
assert.ok(html.includes('id="section-early-access"'), "Missing section-early-access container");
assert.ok(html.includes('id="section-financial"'), "Missing section-financial container");
pass("Early Access and Financial sections properly separated and contained");

// 3. Financial subtabs
assert.ok(html.includes('id="subtab-financial-overview"'), "Missing Overview subtab");
assert.ok(html.includes('id="subtab-financial-transactions"'), "Missing Transactions subtab");
assert.ok(html.includes('id="subtab-financial-recurring"'), "Missing Recurring subtab");
pass("All three financial subviews defined in sub-navigation");

// 4. KPI Performance elements
assert.ok(html.includes('id="kpi-installs"'), "Missing Total Installs KPI");
assert.ok(html.includes('id="kpi-d7"'), "Missing D7 Retention KPI");
assert.ok(html.includes('id="kpi-d30"'), "Missing D30 Retention KPI");
assert.ok(html.includes('id="kpi-mrr"'), "Missing Active MRR KPI");
pass("Top 4 KPI performance cards verified (Installs, D7, D30, MRR)");

// 5. Financial Summary & Status pills
assert.ok(html.includes('id="summary-revenue"'), "Missing recognized revenue element");
assert.ok(html.includes('id="summary-expenses"'), "Missing recognized expenses element");
assert.ok(html.includes('id="summary-net-profit"'), "Missing recognized net profit element");
assert.ok(html.includes('id="sb-rev-paid"'), "Missing realized status element");
assert.ok(html.includes('id="sb-rev-pending"'), "Missing pending status element");
assert.ok(html.includes('id="sb-rev-scheduled"'), "Missing scheduled status element");
assert.ok(html.includes('id="sb-rev-refunded"'), "Missing refunded status element");
pass("Realized financial performance and realization status breakdown verified");

// 6. SVG Chart containers
assert.ok(html.includes('id="chart-revenue-expenses"'), "Missing Revenue vs Expenses chart");
assert.ok(html.includes('id="chart-net-profit"'), "Missing Net Profit trend chart");
assert.ok(html.includes('id="chart-installations"'), "Missing App Installations chart");
assert.ok(html.includes('id="chart-retention"'), "Missing Cohort Retention chart");
pass("All 4 interactive SVG chart containers present");

// 7. Freshness indicators
assert.ok(html.includes('id="freshness-shopify-status"'), "Missing Shopify freshness status");
assert.ok(html.includes('id="freshness-play-status"'), "Missing Google Play freshness status");
assert.ok(html.includes('id="freshness-analytics-status"'), "Missing Firebase Analytics freshness status");
pass("Data freshness indicators for Shopify, Google Play, and Firebase Analytics verified");

// 8. Modals
assert.ok(html.includes('id="modal-transaction"'), "Missing transaction modal");
assert.ok(html.includes('id="modal-recurring"'), "Missing recurring modal");
assert.ok(html.includes('id="modal-void-confirm"'), "Missing void confirmation modal");
assert.ok(html.includes('id="modal-reauth"'), "Missing step-up reauthentication modal");
pass("All 4 administrative modals verified (Transaction, Recurring, Void, Reauth)");

// 9. CSS Styling verification
assert.ok(css.includes(".nav-tabs"), "Missing .nav-tabs in CSS");
assert.ok(css.includes(".kpi-card"), "Missing .kpi-card in CSS");
assert.ok(css.includes(".chart-svg"), "Missing .chart-svg in CSS");
assert.ok(css.includes(".period-switcher"), "Missing .period-switcher in CSS");
assert.ok(css.includes("border-radius: 25px"), "User 25px border-radius must be preserved");
pass("CSS styling consistent with design system and preserves user's 25px border radius");

console.log(`\nALL ${passed} UI & INTEGRITY CHECKS PASSED.`);

