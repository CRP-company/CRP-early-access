/**
 * Financial Dashboard module for CRP Admin.
 *
 * Implements:
 * - Financial Overview (KPIs, Realized Performance, Charts, Freshness)
 * - Transactions management (Add, Edit, Void, Filter, Search)
 * - Recurring arrangements (Add, Edit, Pause, Deterministic Occurrence Generation)
 * - Pure SVG interactive charts with crisp Shopify-style design
 * - Real-time currency conversion preview (ILS, USD, EUR, GBP)
 * - Server authorization and step-up reauthentication handling
 */

import { formatILS, formatCurrency, getDefaultExchangeRate } from "./currency.js";

let authInstance = null;
let workerUrl = "";
let currentPeriod = "current_month"; // "current_month" | "all_time"

let overviewData = null;
let allTransactions = [];
let allRecurring = [];

// Filter state for transactions
const txFilter = {
  search: "",
  type: "all",
  status: "all",
  category: "all",
};

/**
 * Fetch helper calling Worker with current Firebase ID token.
 */
async function callWorker(path, options = {}) {
  const token = await authInstance?.currentUser?.getIdToken();
  if (!token) {
    throw new Error("Your session has expired. Please sign in again.");
  }

  const endpoint = `${workerUrl.replace(/\/+$/, "")}${path}`;
  const res = await fetch(endpoint, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.ok === false) {
    if (res.status === 401 && (data.code === "REAUTH_REQUIRED" || data.error?.includes("step-up"))) {
      // Trigger step-up auth modal
      showReauthModal();
    }
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }

  return data;
}

/**
 * Initialize Financial dashboard.
 * @param {object} auth Firebase Auth instance
 * @param {string} url Worker endpoint base URL
 */
export function initFinancial(auth, url) {
  authInstance = auth;
  workerUrl = url || window.CRP_WORKER_URL || "";

  setupNavTabs();
  setupEventListeners();
  loadAllFinancialData();
}

/**
 * Main navigation and sub-navigation tab switching.
 */
function setupNavTabs() {
  const tabEarlyAccess = document.getElementById("nav-tab-early-access");
  const tabFinancial = document.getElementById("nav-tab-financial");
  const sectionEarlyAccess = document.getElementById("section-early-access");
  const sectionFinancial = document.getElementById("section-financial");

  tabEarlyAccess?.addEventListener("click", () => {
    tabEarlyAccess.classList.add("nav-tab--active");
    tabFinancial.classList.remove("nav-tab--active");
    sectionEarlyAccess.hidden = false;
    sectionFinancial.hidden = true;
  });

  tabFinancial?.addEventListener("click", () => {
    tabFinancial.classList.add("nav-tab--active");
    tabEarlyAccess.classList.remove("nav-tab--active");
    sectionEarlyAccess.hidden = true;
    sectionFinancial.hidden = false;
    loadAllFinancialData();
  });

  // Financial Subtabs: Overview, Transactions, Recurring
  const subtabs = [
    { id: "subtab-financial-overview", viewId: "view-financial-overview" },
    { id: "subtab-financial-transactions", viewId: "view-financial-transactions" },
    { id: "subtab-financial-recurring", viewId: "view-financial-recurring" },
  ];

  subtabs.forEach(({ id, viewId }) => {
    const btn = document.getElementById(id);
    btn?.addEventListener("click", () => {
      subtabs.forEach((s) => {
        document.getElementById(s.id)?.classList.remove("subnav-tab--active");
        const v = document.getElementById(s.viewId);
        if (v) v.hidden = true;
      });
      btn.classList.add("subnav-tab--active");
      const targetView = document.getElementById(viewId);
      if (targetView) targetView.hidden = false;

      if (id === "subtab-financial-transactions") {
        renderTransactionsTable();
      } else if (id === "subtab-financial-recurring") {
        renderRecurringTable();
      }
    });
  });
}

/**
 * Setup UI event listeners for filters, buttons, and modals.
 */
function setupEventListeners() {
  // Period toggles: Current Month vs All Time
  document.getElementById("btn-period-month")?.addEventListener("click", (e) => {
    currentPeriod = "current_month";
    e.target.classList.add("btn-period--active");
    document.getElementById("btn-period-all")?.classList.remove("btn-period--active");
    loadOverview();
  });

  document.getElementById("btn-period-all")?.addEventListener("click", (e) => {
    currentPeriod = "all_time";
    e.target.classList.add("btn-period--active");
    document.getElementById("btn-period-month")?.classList.remove("btn-period--active");
    loadOverview();
  });

  // Refresh Overview
  document.getElementById("btn-refresh-overview")?.addEventListener("click", () => {
    loadAllFinancialData();
  });

  // Shopify Manual Sync Button
  document.getElementById("btn-sync-shopify")?.addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "Syncing…";
    try {
      const res = await callWorker("/financial/shopify/sync", { method: "POST" });
      showToast(`Shopify synchronized: ${res.syncedOrders || 0} orders processed.`, "ok");
      loadAllFinancialData();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Sync Shopify";
    }
  });

  // Generate Recurring Occurrences Button
  document.getElementById("btn-generate-occurrences")?.addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "Generating…";
    try {
      const res = await callWorker("/financial/recurring/generate", { method: "POST" });
      showToast(`Generated ${res.generatedCount || 0} recurring occurrences.`, "ok");
      loadAllFinancialData();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Generate Due Occurrences";
    }
  });

  // Add Transaction Buttons
  document.getElementById("btn-add-revenue")?.addEventListener("click", () => {
    openTransactionModal("revenue");
  });
  document.getElementById("btn-add-expense")?.addEventListener("click", () => {
    openTransactionModal("expense");
  });

  // Add Recurring Rule Button
  document.getElementById("btn-add-recurring")?.addEventListener("click", () => {
    openRecurringModal();
  });

  // Transaction Filters
  document.getElementById("tx-search")?.addEventListener("input", (e) => {
    txFilter.search = e.target.value.toLowerCase().trim();
    renderTransactionsTable();
  });

  document.getElementById("tx-type-filter")?.addEventListener("change", (e) => {
    txFilter.type = e.target.value;
    renderTransactionsTable();
  });

  document.getElementById("tx-status-filter")?.addEventListener("change", (e) => {
    txFilter.status = e.target.value;
    renderTransactionsTable();
  });

  // Currency & Rate conversion live preview in Transaction Modal
  const txAmountInput = document.getElementById("tx-amount");
  const txCurrencySelect = document.getElementById("tx-currency");
  const txRateInput = document.getElementById("tx-rate");
  const txPreview = document.getElementById("tx-ils-preview");

  function updateTxPreview() {
    const amt = Number(txAmountInput?.value) || 0;
    const curr = txCurrencySelect?.value || "ILS";
    let rate = Number(txRateInput?.value);
    if (!rate || rate <= 0) {
      rate = curr === "ILS" ? 1.0 : getDefaultExchangeRate(curr);
      if (txRateInput) txRateInput.value = rate;
    }
    const converted = curr === "ILS" ? amt : amt * rate;
    if (txPreview) {
      txPreview.textContent = `Converts to ${formatILS(converted)}`;
    }
  }

  txAmountInput?.addEventListener("input", updateTxPreview);
  txCurrencySelect?.addEventListener("change", (e) => {
    const curr = e.target.value;
    const defaultRate = curr === "ILS" ? 1.0 : getDefaultExchangeRate(curr);
    if (txRateInput) {
      txRateInput.value = defaultRate;
      txRateInput.disabled = curr === "ILS";
    }
    updateTxPreview();
  });
  txRateInput?.addEventListener("input", updateTxPreview);

  // Transaction form submit
  document.getElementById("tx-form")?.addEventListener("submit", handleTransactionSubmit);

  // Recurring form submit
  document.getElementById("rec-form")?.addEventListener("submit", handleRecurringSubmit);
}

/**
 * Load all financial data: Overview, Transactions, Recurring.
 */
export async function loadAllFinancialData() {
  await Promise.all([loadOverview(), loadTransactions(), loadRecurring()]);
}

/**
 * Load overview KPIs, summary, charts, and integration states.
 */
async function loadOverview() {
  try {
    const res = await callWorker(`/financial/overview?period=${currentPeriod}`);
    overviewData = res;
    renderOverview();
  } catch (err) {
    console.error("Could not load financial overview:", err);
  }
}

/**
 * Load all transactions.
 */
async function loadTransactions() {
  try {
    const res = await callWorker("/financial/transactions");
    allTransactions = res.transactions || [];
    renderTransactionsTable();
  } catch (err) {
    console.error("Could not load transactions:", err);
  }
}

/**
 * Load recurring definitions.
 */
async function loadRecurring() {
  try {
    const res = await callWorker("/financial/recurring");
    allRecurring = res.recurring || [];
    renderRecurringTable();
  } catch (err) {
    console.error("Could not load recurring definitions:", err);
  }
}

/**
 * Render Overview View: KPIs, Summary, Status Pills, Freshness, and SVG Charts.
 */
function renderOverview() {
  if (!overviewData) return;

  const { summary, kpis, integrations, charts } = overviewData;

  // 1. KPI Cards
  const elInstalls = document.getElementById("kpi-installs");
  const elD7 = document.getElementById("kpi-d7");
  const elD30 = document.getElementById("kpi-d30");
  const elMRR = document.getElementById("kpi-mrr");

  if (elInstalls) elInstalls.textContent = (kpis?.totalInstalls || 0).toLocaleString();
  if (elD7) elD7.textContent = kpis?.d7Retention !== null && kpis?.d7Retention !== undefined ? `${kpis.d7Retention}%` : "Pending";
  if (elD30) elD30.textContent = kpis?.d30Retention !== null && kpis?.d30Retention !== undefined ? `${kpis.d30Retention}%` : "Pending";
  if (elMRR) elMRR.textContent = formatILS(kpis?.activeMRR || 0);

  // 2. Realized Performance Summary
  const rev = currentPeriod === "current_month" ? summary.monthlyRevenue : summary.totalRevenue;
  const exp = currentPeriod === "current_month" ? summary.monthlyExpenses : summary.totalExpenses;
  const profit = currentPeriod === "current_month" ? summary.monthlyNetProfit : summary.netProfit;

  const elRev = document.getElementById("summary-revenue");
  const elExp = document.getElementById("summary-expenses");
  const elProfit = document.getElementById("summary-net-profit");

  if (elRev) elRev.textContent = formatILS(rev);
  if (elExp) elExp.textContent = formatILS(exp);
  if (elProfit) {
    elProfit.textContent = formatILS(profit);
    elProfit.className = `metric-value ${profit >= 0 ? "metric-value--positive" : "metric-value--negative"}`;
  }

  // 3. Status Breakdown Pills
  const b = summary.statusBreakdown || { revenue: {}, expense: {} };
  const elRevPaid = document.getElementById("sb-rev-paid");
  const elRevPending = document.getElementById("sb-rev-pending");
  const elRevScheduled = document.getElementById("sb-rev-scheduled");
  const elRevRefunded = document.getElementById("sb-rev-refunded");

  if (elRevPaid) elRevPaid.textContent = formatILS(b.revenue.paid || 0);
  if (elRevPending) elRevPending.textContent = formatILS(b.revenue.pending || 0);
  if (elRevScheduled) elRevScheduled.textContent = formatILS(b.revenue.scheduled || 0);
  if (elRevRefunded) elRevRefunded.textContent = formatILS(b.revenue.refunded || 0);

  // 4. Integrations Freshness
  renderFreshness("shopify", integrations?.shopify);
  renderFreshness("play", integrations?.googlePlay);
  renderFreshness("analytics", integrations?.firebaseAnalytics);

  // 5. Render SVG Charts
  renderRevenueExpenseChart(charts?.financials || []);
  renderNetProfitChart(charts?.financials || []);
  renderInstallationsChart(charts?.installations || []);
  renderRetentionChart(charts?.cohorts || []);
}

function renderFreshness(name, info) {
  const badge = document.getElementById(`freshness-${name}-status`);
  const syncTime = document.getElementById(`freshness-${name}-time`);
  if (!badge) return;

  const status = info?.status || "not_configured";
  badge.className = `pill pill--freshness pill--${status}`;
  badge.textContent = status === "connected" ? "Connected" : status === "syncing" ? "Syncing" : status === "failed" ? "Failed" : "Not configured";

  if (syncTime) {
    if (info?.lastSync) {
      const d = new Date(info.lastSync);
      syncTime.textContent = `Last sync: ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    } else {
      syncTime.textContent = status === "not_configured" ? "Needs API configuration" : "No sync recorded";
    }
  }
}

/* ------------------------------------------------------------------ *
 * Pure SVG Charts (Crisp, High-DPI, Zero Dependencies)
 * ------------------------------------------------------------------ */

function renderRevenueExpenseChart(data) {
  const container = document.getElementById("chart-revenue-expenses");
  if (!container) return;

  if (!data || data.length === 0) {
    container.innerHTML = `<div class="chart-empty">No historical transaction data available yet.</div>`;
    return;
  }

  const maxVal = Math.max(100, ...data.map((d) => Math.max(d.revenue, d.expenses)));
  const width = 600;
  const height = 240;
  const padLeft = 60;
  const padBottom = 35;
  const padTop = 20;
  const padRight = 20;

  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const barGroupW = plotW / data.length;
  const barW = Math.max(4, Math.min(18, barGroupW * 0.35));

  let barsSvg = "";
  let xLabels = "";

  data.forEach((d, i) => {
    const cx = padLeft + i * barGroupW + barGroupW / 2;
    const revH = (d.revenue / maxVal) * plotH;
    const expH = (d.expenses / maxVal) * plotH;

    const revX = cx - barW - 1;
    const expX = cx + 1;
    const revY = padTop + (plotH - revH);
    const expY = padTop + (plotH - expH);

    barsSvg += `
      <rect x="${revX}" y="${revY}" width="${barW}" height="${revH}" fill="#1b5e20" rx="3">
        <title>${d.month} Revenue: ${formatILS(d.revenue)}</title>
      </rect>
      <rect x="${expX}" y="${expY}" width="${barW}" height="${expH}" fill="#a1201a" rx="3">
        <title>${d.month} Expenses: ${formatILS(d.expenses)}</title>
      </rect>
    `;

    xLabels += `<text x="${cx}" y="${height - 10}" text-anchor="middle" class="chart-axis-label">${d.label.split(" ")[0]}</text>`;
  });

  // Guidelines
  let gridLines = "";
  for (let step = 0; step <= 4; step += 1) {
    const yVal = (maxVal / 4) * step;
    const yPos = padTop + plotH - (plotH / 4) * step;
    gridLines += `
      <line x1="${padLeft}" y1="${yPos}" x2="${width - padRight}" y2="${yPos}" stroke="#e2e2df" stroke-dasharray="3,3" />
      <text x="${padLeft - 8}" y="${yPos + 4}" text-anchor="end" class="chart-axis-label">₪${Math.round(yVal)}</text>
    `;
  }

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg">
      ${gridLines}
      ${barsSvg}
      ${xLabels}
    </svg>
  `;
}

function renderNetProfitChart(data) {
  const container = document.getElementById("chart-net-profit");
  if (!container) return;

  if (!data || data.length === 0) {
    container.innerHTML = `<div class="chart-empty">No historical net profit data.</div>`;
    return;
  }

  const values = data.map((d) => d.netProfit);
  const maxVal = Math.max(50, ...values);
  const minVal = Math.min(0, ...values);
  const range = maxVal - minVal || 1;

  const width = 600;
  const height = 240;
  const padLeft = 60;
  const padBottom = 35;
  const padTop = 20;
  const padRight = 20;

  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const stepX = plotW / Math.max(1, data.length - 1);

  const zeroY = padTop + plotH - ((0 - minVal) / range) * plotH;

  const points = data.map((d, i) => {
    const x = padLeft + i * stepX;
    const y = padTop + plotH - ((d.netProfit - minVal) / range) * plotH;
    return { x, y, ...d };
  });

  const polylineStr = points.map((p) => `${p.x},${p.y}`).join(" ");

  let circles = "";
  let xLabels = "";

  points.forEach((p) => {
    circles += `
      <circle cx="${p.x}" cy="${p.y}" r="4" fill="${p.netProfit >= 0 ? '#1b5e20' : '#a1201a'}" stroke="#ffffff" stroke-width="2">
        <title>${p.month} Net Profit: ${formatILS(p.netProfit)}</title>
      </circle>
    `;
    xLabels += `<text x="${p.x}" y="${height - 10}" text-anchor="middle" class="chart-axis-label">${p.label.split(" ")[0]}</text>`;
  });

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg">
      <line x1="${padLeft}" y1="${zeroY}" x2="${width - padRight}" y2="${zeroY}" stroke="#1a1a1a" stroke-width="1.2" />
      <polyline points="${polylineStr}" fill="none" stroke="#000000" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
      ${circles}
      ${xLabels}
    </svg>
  `;
}

function renderInstallationsChart(data) {
  const container = document.getElementById("chart-installations");
  if (!container) return;

  if (!data || data.length === 0) {
    container.innerHTML = `<div class="chart-empty">Google Play installation report not yet imported or synchronized.</div>`;
    return;
  }

  const width = 600;
  const height = 240;
  const padLeft = 50;
  const padBottom = 35;
  const padTop = 20;
  const padRight = 20;

  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const maxInstalls = Math.max(10, ...data.map((d) => d.firstTimeInstalls));

  const stepX = plotW / Math.max(1, data.length - 1);
  const points = data.map((d, i) => {
    const x = padLeft + i * stepX;
    const y = padTop + plotH - (d.firstTimeInstalls / maxInstalls) * plotH;
    return `${x},${y}`;
  }).join(" ");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg">
      <polyline points="${points}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linecap="round" />
    </svg>
  `;
}

function renderRetentionChart(cohorts) {
  const container = document.getElementById("chart-retention");
  if (!container) return;

  const matureCohorts = cohorts.filter((c) => c.d7Eligible && c.d7Retention !== null);

  if (!matureCohorts || matureCohorts.length === 0) {
    container.innerHTML = `<div class="chart-empty">Retention data matures after 7 and 30 full days of cohort activity.</div>`;
    return;
  }

  const width = 600;
  const height = 240;
  const padLeft = 50;
  const padBottom = 35;
  const padTop = 20;
  const padRight = 20;

  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const stepX = plotW / Math.max(1, matureCohorts.length - 1);

  const pointsD7 = matureCohorts.map((c, i) => {
    const x = padLeft + i * stepX;
    const y = padTop + plotH - ((c.d7Retention || 0) / 100) * plotH;
    return `${x},${y}`;
  }).join(" ");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg">
      <line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" stroke="#e2e2df" />
      <polyline points="${pointsD7}" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" />
    </svg>
  `;
}

/* ------------------------------------------------------------------ *
 * Transactions Table & CRUD
 * ------------------------------------------------------------------ */

function renderTransactionsTable() {
  const tbody = document.getElementById("transactions-body");
  const countEl = document.getElementById("transactions-count");
  if (!tbody) return;

  const filtered = allTransactions.filter((t) => {
    if (txFilter.type !== "all" && t.type !== txFilter.type) return false;
    if (txFilter.status !== "all" && t.status !== txFilter.status) return false;
    if (txFilter.category !== "all" && t.category !== txFilter.category) return false;
    if (txFilter.search) {
      const q = txFilter.search;
      const desc = String(t.description || "").toLowerCase();
      const notes = String(t.notes || "").toLowerCase();
      const id = String(t.id || "").toLowerCase();
      if (!desc.includes(q) && !notes.includes(q) && !id.includes(q)) return false;
    }
    return true;
  });

  if (countEl) countEl.textContent = filtered.length;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">No transactions found matching your criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((t) => {
    const isRev = t.type === "revenue";
    const typeBadge = `<span class="pill pill--${isRev ? 'revenue' : 'expense'}">${isRev ? 'Revenue' : 'Expense'}</span>`;
    const statusPill = `<span class="pill pill--${t.status}">${escapeHtml(t.status)}</span>`;
    const originalText = t.currency === "ILS" ? "" : `<div class="sub-amount">${formatCurrency(t.amount, t.currency)}</div>`;

    return `
      <tr data-id="${escapeHtml(t.id)}">
        <td class="mono">${escapeHtml(t.transactionDate || "—")}</td>
        <td>${typeBadge}</td>
        <td><strong>${escapeHtml(t.description || "—")}</strong></td>
        <td><span class="category-pill">${escapeHtml(t.category || "Other")}</span></td>
        <td class="num">${originalText}<strong>${formatILS(t.amountILS || 0)}</strong></td>
        <td>${statusPill}</td>
        <td class="actions">
          <button class="btn btn-tx-edit" data-id="${escapeHtml(t.id)}" type="button">Edit</button>
          <button class="btn btn-tx-void" data-id="${escapeHtml(t.id)}" type="button">Void</button>
        </td>
      </tr>
    `;
  }).join("");

  // Attach row actions
  tbody.querySelectorAll(".btn-tx-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const tx = allTransactions.find((x) => x.id === id);
      if (tx) openTransactionModal(tx.type, tx);
    });
  });

  tbody.querySelectorAll(".btn-tx-void").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      openVoidConfirmModal(id);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Recurring Table & CRUD
 * ------------------------------------------------------------------ */

function renderRecurringTable() {
  const tbody = document.getElementById("recurring-body");
  const countEl = document.getElementById("recurring-count");
  if (!tbody) return;

  if (countEl) countEl.textContent = allRecurring.length;

  if (allRecurring.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">No recurring arrangements configured yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = allRecurring.map((r) => {
    const isRev = r.type === "revenue";
    const typeBadge = `<span class="pill pill--${isRev ? 'revenue' : 'expense'}">${isRev ? 'Revenue' : 'Expense'}</span>`;
    const statusPill = `<span class="pill pill--${r.status}">${escapeHtml(r.status)}</span>`;

    return `
      <tr data-id="${escapeHtml(r.id)}">
        <td><strong>${escapeHtml(r.description)}</strong></td>
        <td>${typeBadge}</td>
        <td><span class="category-pill">${escapeHtml(r.frequency)}</span></td>
        <td>${formatCurrency(r.amount, r.currency)}</td>
        <td><strong>${formatILS(r.amountILS)}</strong></td>
        <td><span class="date-range">${escapeHtml(r.startDate)} ${r.endDate ? `→ ${escapeHtml(r.endDate)}` : ''}</span></td>
        <td>${statusPill}</td>
        <td class="actions">
          <button class="btn btn-rec-toggle" data-id="${escapeHtml(r.id)}" data-status="${r.status}" type="button">
            ${r.status === 'active' ? 'Pause' : 'Activate'}
          </button>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".btn-rec-toggle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const current = btn.dataset.status;
      const newStatus = current === "active" ? "paused" : "active";
      btn.disabled = true;
      try {
        await callWorker("/financial/recurring-update", {
          method: "POST",
          body: { id, status: newStatus },
        });
        showToast(`Recurring rule ${newStatus}.`, "ok");
        loadRecurring();
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * Modals & Forms
 * ------------------------------------------------------------------ */

function openTransactionModal(type = "revenue", existing = null) {
  const modal = document.getElementById("modal-transaction");
  const title = document.getElementById("modal-tx-title");
  const form = document.getElementById("tx-form");
  if (!modal || !form) return;

  form.reset();
  form.dataset.editId = existing ? existing.id : "";

  if (title) title.textContent = existing ? "Edit Transaction" : `Add ${type === "revenue" ? "Revenue" : "Expense"}`;

  // Populate fields
  const typeSelect = document.getElementById("tx-type");
  const descInput = document.getElementById("tx-desc");
  const amountInput = document.getElementById("tx-amount");
  const currSelect = document.getElementById("tx-currency");
  const rateInput = document.getElementById("tx-rate");
  const catInput = document.getElementById("tx-category");
  const dateInput = document.getElementById("tx-date");
  const statusSelect = document.getElementById("tx-status");
  const notesInput = document.getElementById("tx-notes");

  if (typeSelect) typeSelect.value = existing ? existing.type : type;
  if (descInput) descInput.value = existing ? existing.description : "";
  if (amountInput) amountInput.value = existing ? existing.amount : "";
  if (currSelect) currSelect.value = existing ? existing.currency : "ILS";
  if (rateInput) {
    rateInput.value = existing ? existing.exchangeRate : 1.0;
    rateInput.disabled = (currSelect?.value === "ILS");
  }
  if (catInput) catInput.value = existing ? existing.category : (type === "revenue" ? "Hardware" : "Infrastructure");
  if (dateInput) dateInput.value = existing ? existing.transactionDate : new Date().toISOString().split("T")[0];
  if (statusSelect) statusSelect.value = existing ? existing.status : "paid";
  if (notesInput) notesInput.value = existing ? existing.notes || "" : "";

  // Trigger preview update
  document.getElementById("tx-currency")?.dispatchEvent(new Event("change"));

  modal.showModal();
}

async function handleTransactionSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const editId = form.dataset.editId;
  const submitBtn = form.querySelector('button[type="submit"]');

  const payload = {
    type: document.getElementById("tx-type")?.value || "revenue",
    description: document.getElementById("tx-desc")?.value?.trim() || "",
    amount: Number(document.getElementById("tx-amount")?.value) || 0,
    currency: document.getElementById("tx-currency")?.value || "ILS",
    exchangeRate: Number(document.getElementById("tx-rate")?.value) || 1.0,
    category: document.getElementById("tx-category")?.value || "Other",
    transactionDate: document.getElementById("tx-date")?.value || new Date().toISOString().split("T")[0],
    status: document.getElementById("tx-status")?.value || "paid",
    notes: document.getElementById("tx-notes")?.value?.trim() || "",
  };

  submitBtn.disabled = true;
  submitBtn.textContent = "Saving…";

  try {
    if (editId) {
      await callWorker("/financial/transaction-update", {
        method: "POST",
        body: { id: editId, ...payload },
      });
      showToast("Transaction updated.", "ok");
    } else {
      await callWorker("/financial/transactions", {
        method: "POST",
        body: payload,
      });
      showToast("Transaction created.", "ok");
    }

    document.getElementById("modal-transaction")?.close();
    loadAllFinancialData();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save Transaction";
  }
}

function openRecurringModal() {
  const modal = document.getElementById("modal-recurring");
  if (modal) modal.showModal();
}

async function handleRecurringSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const submitBtn = form.querySelector('button[type="submit"]');

  const payload = {
    type: document.getElementById("rec-type")?.value || "expense",
    description: document.getElementById("rec-desc")?.value?.trim() || "",
    amount: Number(document.getElementById("rec-amount")?.value) || 0,
    currency: document.getElementById("rec-currency")?.value || "ILS",
    exchangeRate: Number(document.getElementById("rec-rate")?.value) || 1.0,
    frequency: document.getElementById("rec-frequency")?.value || "monthly",
    category: document.getElementById("rec-category")?.value || "Infrastructure",
    startDate: document.getElementById("rec-start-date")?.value || new Date().toISOString().split("T")[0],
    endDate: document.getElementById("rec-end-date")?.value || null,
    status: "active",
  };

  submitBtn.disabled = true;
  submitBtn.textContent = "Saving…";

  try {
    await callWorker("/financial/recurring", {
      method: "POST",
      body: payload,
    });
    showToast("Recurring definition created.", "ok");
    document.getElementById("modal-recurring")?.close();
    loadRecurring();
    loadOverview();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save Recurring Rule";
  }
}

function openVoidConfirmModal(id) {
  const modal = document.getElementById("modal-void-confirm");
  const btnConfirm = document.getElementById("btn-confirm-void");
  if (!modal || !btnConfirm) return;

  btnConfirm.onclick = async () => {
    btnConfirm.disabled = true;
    btnConfirm.textContent = "Voiding…";
    try {
      await callWorker("/financial/transaction-void", {
        method: "POST",
        body: { id },
      });
      showToast("Transaction voided.", "ok");
      modal.close();
      loadAllFinancialData();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btnConfirm.disabled = false;
      btnConfirm.textContent = "Confirm Void";
    }
  };

  modal.showModal();
}

function showReauthModal() {
  const modal = document.getElementById("modal-reauth");
  if (modal) modal.showModal();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function showToast(msg, kind = "ok") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = `toast toast--${kind} show`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.remove("show"), 4000);
}
