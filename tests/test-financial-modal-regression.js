#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

console.log("Running Focused Regression Test: Transaction Modal Scope & Currency Preview\n");

// ============================================================================
// PART 1: Reproduce the Original Button-Click Failure
// ============================================================================
console.log("1. Reproducing original failure (function trapped inside closure)...");

function setupEventListenersBuggy() {
  // In the buggy commit (ec8464f), updateTxPreview was scoped locally inside setupEventListeners
  function updateTxPreview() {
    return "preview updated";
  }
}

function buggyOpenTransactionModal(type = "revenue") {
  // openTransactionModal is declared at module scope and calls updateTxPreview()
  updateTxPreview();
}

assert.throws(
  () => {
    buggyOpenTransactionModal("revenue");
  },
  {
    name: "ReferenceError",
    message: /updateTxPreview is not defined/,
  },
  "Expected ReferenceError: updateTxPreview is not defined when updateTxPreview is scoped inside setupEventListeners"
);
console.log("  PASS  Original ReferenceError successfully reproduced when updateTxPreview is out of scope.");

// ============================================================================
// PART 2: Verify Fixed Implementation
// ============================================================================
(async function runRegressionVerifications() {
  console.log("\n2. Verifying fixed implementation with DOM environment...");

  const listeners = {};
  function makeEl(extra = {}) {
    return {
      id: extra.id || "",
      value: extra.value !== undefined ? extra.value : "",
      textContent: "",
      dataset: {},
      style: {},
      disabled: false,
      title: "",
      addEventListener(evt, fn) {
        listeners[`${this.id || extra.name || "el"}:${evt}`] = fn;
      },
      classList: { add() {}, remove() {} },
      reset() {
        this.value = "";
      },
      showModal() {
        this.open = true;
      },
      close() {
        this.open = false;
      },
      querySelectorAll() {
        return [];
      },
      ...extra,
    };
  }

  const elements = {};
  [
    "modal-transaction",
    "modal-tx-title",
    "tx-form",
    "tx-type",
    "tx-desc",
    "tx-amount",
    "tx-currency",
    "tx-rate",
    "tx-ils-preview",
    "tx-category",
    "tx-date",
    "tx-status",
    "tx-notes",
    "btn-add-revenue",
    "btn-add-expense",
  ].forEach((id) => {
    elements[id] = makeEl({ id });
  });

  globalThis.document = {
    getElementById(id) {
      if (!elements[id]) elements[id] = makeEl({ id });
      return elements[id];
    },
    querySelector() {
      return makeEl();
    },
    querySelectorAll() {
      return [];
    },
  };

  globalThis.window = {
    CRP_WORKER_URL: "",
    location: { search: "" },
    addEventListener() {},
  };
  globalThis.Event = class Event {};
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: true, summary: {}, transactions: [], recurring: [] }),
  });

  const financialMod = await import(path.resolve(__dirname, "../admin/js/financial.js"));
  financialMod.initFinancial({ currentUser: { getIdToken: async () => "mock-token" } }, "https://example.com");

  // --------------------------------------------------------------------------
  // Verify: Add Revenue Works
  // --------------------------------------------------------------------------
  assert.doesNotThrow(() => {
    listeners["btn-add-revenue:click"]();
  }, "Clicking Add Revenue must not throw ReferenceError");

  assert.equal(elements["modal-tx-title"].textContent, "Add Revenue");
  assert.equal(elements["tx-type"].value, "revenue");
  assert.equal(elements["tx-ils-preview"].textContent, "Converts to ₪0.00");
  console.log("  PASS  Add Revenue button click works and initializes modal preview.");

  // --------------------------------------------------------------------------
  // Verify: Add Expense Works
  // --------------------------------------------------------------------------
  assert.doesNotThrow(() => {
    listeners["btn-add-expense:click"]();
  }, "Clicking Add Expense must not throw ReferenceError");

  assert.equal(elements["modal-tx-title"].textContent, "Add Expense");
  assert.equal(elements["tx-type"].value, "expense");
  assert.equal(elements["tx-ils-preview"].textContent, "Converts to ₪0.00");
  console.log("  PASS  Add Expense button click works and initializes modal preview.");

  // --------------------------------------------------------------------------
  // Verify: Edit Transaction Works
  // --------------------------------------------------------------------------
  const existingTx = {
    id: "tx_cuby_001",
    type: "revenue",
    description: "CUBY Display Unit Sale",
    amount: 1200,
    currency: "USD",
    exchangeRate: 3.75,
    category: "Hardware",
    transactionDate: "2026-11-20",
    status: "paid",
    notes: "Batch #4 export",
  };

  assert.doesNotThrow(() => {
    financialMod.openTransactionModal("revenue", existingTx);
  }, "Opening transaction modal for edit must not throw");

  assert.equal(elements["modal-tx-title"].textContent, "Edit Transaction");
  assert.equal(elements["tx-form"].dataset.editId, "tx_cuby_001");
  assert.equal(elements["tx-desc"].value, "CUBY Display Unit Sale");
  assert.equal(elements["tx-amount"].value, 1200);
  assert.equal(elements["tx-currency"].value, "USD");
  assert.equal(elements["tx-rate"].value, 3.75);
  assert.equal(elements["tx-category"].value, "Hardware");
  assert.equal(elements["tx-date"].value, "2026-11-20");
  assert.equal(elements["tx-notes"].value, "Batch #4 export");
  // 1200 USD @ 3.75 ILS/USD = 4,500.00 ILS
  assert.equal(elements["tx-ils-preview"].textContent, "Converts to ₪4,500.00 (@ 3.75 ILS/USD)");
  console.log("  PASS  Edit Transaction works, populates existing fields, and calculates live conversion.");

  // --------------------------------------------------------------------------
  // Verify: Live Currency Preview Still Updates
  // --------------------------------------------------------------------------
  // 1. Amount change with existing confirmed rate: 200 * 3.75 = 750
  elements["tx-amount"].value = "200";
  listeners["tx-amount:input"]();
  assert.equal(elements["tx-ils-preview"].textContent, "Converts to ₪750.00 (@ 3.75 ILS/USD)");

  // 2. Switch to ILS: rate disabled, fixed at 1.0, preview = ₪200.00
  elements["tx-currency"].value = "ILS";
  listeners["tx-currency:change"]({ target: { value: "ILS" } });
  assert.equal(elements["tx-rate"].disabled, true);
  assert.equal(elements["tx-rate"].value, "1.0");
  assert.equal(elements["tx-ils-preview"].textContent, "Converts to ₪200.00");

  // 3. Switch to EUR without confirmed rate: warning prompt displayed
  elements["tx-currency"].value = "EUR";
  listeners["tx-currency:change"]({ target: { value: "EUR" } });
  assert.equal(elements["tx-rate"].disabled, false);
  assert.equal(elements["tx-rate"].value, "");
  assert.ok(
    elements["tx-ils-preview"].textContent.includes("Requires confirmed exchange rate for EUR"),
    "Expected warning prompt for unconfirmed exchange rate"
  );
  assert.equal(elements["tx-ils-preview"].style.color, "#b91c1c");

  // 4. Enter confirmed exchange rate 4.10: 200 * 4.10 = 820.00
  elements["tx-rate"].value = "4.10";
  listeners["tx-rate:input"]();
  assert.equal(elements["tx-ils-preview"].textContent, "Converts to ₪820.00 (@ 4.1 ILS/EUR)");
  assert.equal(elements["tx-ils-preview"].style.color, "");
  console.log("  PASS  Live currency preview updates dynamically on amount, currency switch, and rate change.");

  // --------------------------------------------------------------------------
  // Verify: Global window fallback
  // --------------------------------------------------------------------------
  assert.equal(typeof globalThis.window.updateTxPreview, "function");
  assert.equal(typeof globalThis.window.openTransactionModal, "function");
  console.log("  PASS  window.updateTxPreview and window.openTransactionModal global fallbacks verified.");

  console.log("\nALL FOCUSED REGRESSION VERIFICATIONS PASSED SUCCESSFULLY.");
})().catch((err) => {
  console.error("\nFOCUSED REGRESSION SUITE FAILED:\n", err);
  process.exit(1);
});
