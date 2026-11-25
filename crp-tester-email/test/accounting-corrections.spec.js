import { describe, it, expect } from "vitest";
import {
  parseShopifyOrderToTransactions,
} from "../src/shopify.js";
import {
  normalizeToILS,
  getDefaultExchangeRate,
  inspectCurrencySafety,
} from "../src/currency.js";
import {
  validateTransaction,
  validateRecurringDefinition,
} from "../src/financial-validate.js";
import {
  calculateFinancialSummary,
  generateMonthlyChartData,
} from "../src/financial-calc.js";

describe("Accounting Corrections — Shopify Refund Accounting", () => {
  it("1. Normal paid order produces a single paid revenue transaction net of refunds", () => {
    const order = {
      id: "gid://shopify/Order/2001",
      name: "#2001",
      created_at: "2026-11-01T10:00:00Z",
      currency: "ILS",
      total_price: "450.00",
      financial_status: "PAID",
      refunds: [],
    };

    const transactions = parseShopifyOrderToTransactions(order);
    expect(transactions).toHaveLength(1);

    const tx = transactions[0];
    expect(tx.id).toBe("shopify_order_2001");
    expect(tx.orderId).toBe("2001");
    expect(tx.status).toBe("paid");
    expect(tx.amount).toBe(450);
    expect(tx.amountILS).toBe(450);
    expect(tx.originalGrossAmount).toBe(450);
    expect(tx.totalRefunded).toBe(0);
    expect(tx.netAmount).toBe(450);
    expect(tx.netAmountILS).toBe(450);
    expect(tx.isRefund).toBe(false);

    const summary = calculateFinancialSummary(transactions, [], "current_month", new Date("2026-11-05T00:00:00Z"));
    expect(summary.grossRevenue).toBe(450);
    expect(summary.totalRefunds).toBe(0);
    expect(summary.totalRevenue).toBe(450);
    expect(summary.monthlyRevenue).toBe(450);
    expect(summary.netProfit).toBe(450);
  });

  it("2. Fully refunded order creates order record and separate refund adjustment with 0 net revenue", () => {
    const order = {
      id: "2002",
      name: "#2002",
      created_at: "2026-11-02T12:00:00Z",
      currency: "ILS",
      total_price: "600.00",
      financial_status: "REFUNDED",
      refunds: [
        {
          id: "ref_full_1",
          created_at: "2026-11-03T15:00:00Z",
          total_refunded: 600,
        },
      ],
    };

    const transactions = parseShopifyOrderToTransactions(order);
    expect(transactions).toHaveLength(2);

    const [orderTx, refundTx] = transactions;
    expect(orderTx.id).toBe("shopify_order_2002");
    expect(orderTx.status).toBe("refunded");
    expect(orderTx.originalGrossAmount).toBe(600);
    expect(orderTx.totalRefunded).toBe(600);
    expect(orderTx.netAmount).toBe(0);
    expect(orderTx.netAmountILS).toBe(0);
    expect(orderTx.isRefund).toBe(false);

    expect(refundTx.id).toBe("shopify_refund_ref_full_1");
    expect(refundTx.orderId).toBe("2002");
    expect(refundTx.parentTransactionId).toBe("shopify_order_2002");
    expect(refundTx.isRefund).toBe(true);
    expect(refundTx.status).toBe("refunded");
    expect(refundTx.amount).toBe(600);
    expect(refundTx.amountILS).toBe(600);

    const summary = calculateFinancialSummary(transactions, [], "current_month", new Date("2026-11-05T00:00:00Z"));
    expect(summary.grossRevenue).toBe(600);
    expect(summary.totalRefunds).toBe(600);
    expect(summary.totalRevenue).toBe(0);
    expect(summary.monthlyRevenue).toBe(0);
    expect(summary.netProfit).toBe(0);
  });

  it("3. Partially refunded order creates parent and refund record, recognizing revenue net of refunds", () => {
    const order = {
      id: "2003",
      name: "#2003",
      created_at: "2026-11-01T09:00:00Z",
      currency: "ILS",
      total_price: "500.00",
      financial_status: "PARTIALLY_REFUNDED",
      refunds: [
        {
          id: "ref_part_1",
          created_at: "2026-11-04T11:00:00Z",
          total_refunded: 150,
        },
      ],
    };

    const transactions = parseShopifyOrderToTransactions(order);
    expect(transactions).toHaveLength(2);

    const [orderTx, refundTx] = transactions;
    expect(orderTx.status).toBe("partially_refunded");
    expect(orderTx.amount).toBe(500);
    expect(orderTx.totalRefunded).toBe(150);
    expect(orderTx.netAmount).toBe(350);
    expect(orderTx.netAmountILS).toBe(350);

    expect(refundTx.id).toBe("shopify_refund_ref_part_1");
    expect(refundTx.orderId).toBe("2003");
    expect(refundTx.amount).toBe(150);
    expect(refundTx.isRefund).toBe(true);

    const summary = calculateFinancialSummary(transactions, [], "current_month", new Date("2026-11-05T00:00:00Z"));
    expect(summary.grossRevenue).toBe(500);
    expect(summary.totalRefunds).toBe(150);
    expect(summary.totalRevenue).toBe(350);
    expect(summary.monthlyRevenue).toBe(350);
  });

  it("4. Multiple partial refunds on one order are accurately accumulated and audited", () => {
    const order = {
      id: "2004",
      name: "#2004",
      created_at: "2026-11-01T10:00:00Z",
      currency: "ILS",
      total_price: "1000.00",
      financial_status: "PARTIALLY_REFUNDED",
      refunds: [
        {
          id: "ref_m1",
          created_at: "2026-11-03T10:00:00Z",
          total_refunded: 200,
        },
        {
          id: "ref_m2",
          created_at: "2026-11-05T14:00:00Z",
          total_refunded: 300,
        },
      ],
    };

    const transactions = parseShopifyOrderToTransactions(order);
    expect(transactions).toHaveLength(3);

    const [orderTx, ref1, ref2] = transactions;
    expect(orderTx.status).toBe("partially_refunded");
    expect(orderTx.totalRefunded).toBe(500);
    expect(orderTx.netAmount).toBe(500);

    expect(ref1.id).toBe("shopify_refund_ref_m1");
    expect(ref1.orderId).toBe("2004");
    expect(ref1.amount).toBe(200);

    expect(ref2.id).toBe("shopify_refund_ref_m2");
    expect(ref2.orderId).toBe("2004");
    expect(ref2.amount).toBe(300);

    const summary = calculateFinancialSummary(transactions, [], "current_month", new Date("2026-11-06T00:00:00Z"));
    expect(summary.grossRevenue).toBe(1000);
    expect(summary.totalRefunds).toBe(500);
    expect(summary.totalRevenue).toBe(500);
  });

  it("5. Duplicate delivery of the same refund webhook remains idempotent and never double-counts", () => {
    const order = {
      id: "2005",
      name: "#2005",
      created_at: "2026-11-01T10:00:00Z",
      currency: "ILS",
      total_price: "800.00",
      financial_status: "PARTIALLY_REFUNDED",
      refunds: [
        {
          id: "ref_dup_1",
          created_at: "2026-11-02T10:00:00Z",
          total_refunded: 100,
        },
      ],
    };

    // First parsing / ingestion
    const delivery1 = parseShopifyOrderToTransactions(order);
    // Duplicate delivery of the exact same payload
    const delivery2 = parseShopifyOrderToTransactions(order);

    // Both deliveries produce the exact same deterministic IDs
    expect(delivery1[1].id).toBe("shopify_refund_ref_dup_1");
    expect(delivery2[1].id).toBe("shopify_refund_ref_dup_1");

    // Simulating database storage where deterministic IDs deduplicate documents:
    const dbStore = new Map();
    for (const tx of [...delivery1, ...delivery2]) {
      dbStore.set(tx.id, tx);
    }

    const uniqueStoredTransactions = Array.from(dbStore.values());
    expect(uniqueStoredTransactions).toHaveLength(2); // exactly 1 order + 1 refund

    const summary = calculateFinancialSummary(uniqueStoredTransactions, [], "current_month", new Date("2026-11-05T00:00:00Z"));
    expect(summary.grossRevenue).toBe(800);
    expect(summary.totalRefunds).toBe(100);
    expect(summary.totalRevenue).toBe(700); // 800 - 100 = 700, never 800 - 200
  });

  it("6. Order update after a refund updates the order without duplicating its revenue", () => {
    // Initial order state before refund
    const initialOrder = {
      id: "2006",
      name: "#2006",
      created_at: "2026-11-01T10:00:00Z",
      currency: "ILS",
      total_price: "700.00",
      financial_status: "PAID",
      refunds: [],
    };

    const dbStore = new Map();
    for (const tx of parseShopifyOrderToTransactions(initialOrder)) {
      dbStore.set(tx.id, tx);
    }
    expect(dbStore.get("shopify_order_2006").netAmount).toBe(700);

    // Later: order is partially refunded and updated
    const updatedOrder = {
      ...initialOrder,
      financial_status: "PARTIALLY_REFUNDED",
      refunds: [
        {
          id: "ref_up_1",
          created_at: "2026-11-04T12:00:00Z",
          total_refunded: 200,
        },
      ],
    };

    for (const tx of parseShopifyOrderToTransactions(updatedOrder)) {
      dbStore.set(tx.id, tx);
    }

    const txList = Array.from(dbStore.values());
    expect(txList).toHaveLength(2); // 1 order + 1 refund

    const summary = calculateFinancialSummary(txList, [], "current_month", new Date("2026-11-05T00:00:00Z"));
    expect(summary.grossRevenue).toBe(700);
    expect(summary.totalRefunds).toBe(200);
    expect(summary.totalRevenue).toBe(500);
  });

  it("7. Monthly and all-time totals use consistent accounting rules across different months", () => {
    // October order (500 ILS)
    const octoberOrder = {
      id: "shopify_order_oct",
      orderId: "oct_1",
      type: "revenue",
      amountILS: 500,
      status: "partially_refunded",
      transactionDate: "2026-10-15",
      isRefund: false,
    };

    // November refund (150 ILS)
    const novemberRefund = {
      id: "shopify_refund_nov",
      orderId: "oct_1",
      parentTransactionId: "shopify_order_oct",
      type: "revenue",
      amountILS: 150,
      status: "refunded",
      transactionDate: "2026-11-02",
      isRefund: true,
    };

    const allTx = [octoberOrder, novemberRefund];

    // Summary as of November (current month 2026-11)
    const novSummary = calculateFinancialSummary(allTx, [], "current_month", new Date("2026-11-05T00:00:00Z"));
    expect(novSummary.totalRevenue).toBe(350); // All time: 500 - 150 = 350
    expect(novSummary.grossRevenue).toBe(500);
    expect(novSummary.totalRefunds).toBe(150);

    // Current month (November) only contains the refund
    expect(novSummary.monthlyGrossRevenue).toBe(0);
    expect(novSummary.monthlyRefunds).toBe(150);
    expect(novSummary.monthlyRevenue).toBe(0); // net 0 (cannot be negative recognized revenue)

    // Summary as of October (reference date 2026-10-20)
    const octSummary = calculateFinancialSummary(allTx, [], "current_month", new Date("2026-10-20T00:00:00Z"));
    expect(octSummary.monthlyGrossRevenue).toBe(500);
    expect(octSummary.monthlyRefunds).toBe(0);
    expect(octSummary.monthlyRevenue).toBe(500); // In October, full 500 was recognized

    // Monthly chart generation
    const chart = generateMonthlyChartData(allTx, 2, new Date("2026-11-10T00:00:00Z"));
    const octBucket = chart.find((b) => b.month === "2026-10");
    const novBucket = chart.find((b) => b.month === "2026-11");

    expect(octBucket.revenue).toBe(500);
    expect(novBucket.revenue).toBe(0);
  });
});

describe("Accounting Corrections — Currency Conversion Safety", () => {
  it("1. ILS transaction converts with rate 1.0, base_currency source, and confirmed flag", () => {
    const input = {
      type: "revenue",
      description: "Direct ILS Hardware Sale",
      amount: 350.0,
      currency: "ILS",
      category: "Hardware",
      status: "paid",
    };

    const res = validateTransaction(input);
    expect(res.ok).toBe(true);
    expect(res.value.currency).toBe("ILS");
    expect(res.value.exchangeRate).toBe(1.0);
    expect(res.value.amountILS).toBe(350.0);
    expect(res.value.rateSource).toBe("base_currency");
    expect(res.value.rateConfirmed).toBe(true);
  });

  it("2. Foreign-currency transaction with explicitly confirmed rate converts and saves as paid", () => {
    const input = {
      type: "revenue",
      description: "Consulting in USD with invoice bank rate",
      amount: 100.0,
      currency: "USD",
      exchangeRate: 3.72,
      rateSource: "explicit",
      category: "Consulting",
      status: "paid",
    };

    const res = validateTransaction(input);
    expect(res.ok).toBe(true);
    expect(res.value.currency).toBe("USD");
    expect(res.value.exchangeRate).toBe(3.72);
    expect(res.value.amountILS).toBe(372.0);
    expect(res.value.rateSource).toBe("explicit");
    expect(res.value.rateConfirmed).toBe(true);
  });

  it("3. Foreign-currency transaction with NO rate is rejected when attempting to finalize", () => {
    const inputPaid = {
      type: "expense",
      description: "Server hosting without confirmed rate",
      amount: 50.0,
      currency: "USD",
      status: "paid", // Attempting to finalize
    };

    const resPaid = validateTransaction(inputPaid);
    expect(resPaid.ok).toBe(false);
    expect(resPaid.error).toContain("explicitly confirmed exchange rate is required");

    // Saving as pending/draft without rate is permitted, but marked unconfirmed with null amountILS
    const inputPending = {
      ...inputPaid,
      status: "pending",
    };

    const resPending = validateTransaction(inputPending);
    expect(resPending.ok).toBe(true);
    expect(resPending.value.exchangeRate).toBeNull();
    expect(resPending.value.amountILS).toBeNull();
    expect(resPending.value.rateConfirmed).toBe(false);
    expect(resPending.value.rateSource).toBe("unconfirmed");
  });

  it("4. Shopify order with supported settlement conversion amount uses shop_money ILS settlement", () => {
    const order = {
      id: "gid://shopify/Order/3001",
      name: "#3001",
      created_at: "2026-11-04T10:00:00Z",
      currency: "USD", // Customer paid in USD
      total_price: "100.00",
      totalPriceSet: {
        presentmentMoney: {
          amount: "100.00",
          currencyCode: "USD",
        },
        shopMoney: {
          amount: "368.50", // Store settled in ILS
          currencyCode: "ILS",
        },
      },
      financial_status: "PAID",
      refunds: [],
    };

    const transactions = parseShopifyOrderToTransactions(order);
    expect(transactions).toHaveLength(1);

    const tx = transactions[0];
    expect(tx.currency).toBe("USD");
    expect(tx.amount).toBe(100.0);
    expect(tx.amountILS).toBe(368.5);
    expect(tx.exchangeRate).toBe(3.685);
    expect(tx.rateSource).toBe("settlement");
    expect(tx.rateConfirmed).toBe(true);
    expect(tx.status).toBe("paid");
  });

  it("5. Shopify order without reliable conversion amount is flagged as unconfirmed and pending", () => {
    const order = {
      id: "3002",
      name: "#3002",
      created_at: "2026-11-04T12:00:00Z",
      currency: "USD",
      total_price: "200.00",
      totalPriceSet: {
        presentmentMoney: {
          amount: "200.00",
          currencyCode: "USD",
        },
        shopMoney: {
          amount: "200.00",
          currencyCode: "USD", // Shop money is ALSO foreign currency, no ILS settlement provided
        },
      },
      financial_status: "PAID",
    };

    const transactions = parseShopifyOrderToTransactions(order);
    expect(transactions).toHaveLength(1);

    const tx = transactions[0];
    expect(tx.currency).toBe("USD");
    expect(tx.amount).toBe(200.0);
    expect(tx.amountILS).toBeNull(); // Never silently converted using 3.65!
    expect(tx.exchangeRate).toBeNull();
    expect(tx.rateSource).toBe("unconfirmed");
    expect(tx.rateConfirmed).toBe(false);
    expect(tx.status).toBe("pending"); // Prevented from being finalized
    expect(tx.notes).toContain("Requires confirmed exchange rate");
  });

  it("6. Existing historical transaction using fallback rate is identified and preserved without rewriting", () => {
    // Record created under legacy system with static 3.65 rate
    const legacyRecord = {
      id: "tx_legacy_100",
      type: "revenue",
      description: "Old USD Hardware Sale",
      amount: 100.0,
      currency: "USD",
      exchangeRate: 3.65,
      amountILS: 365.0,
      status: "paid",
    };

    const safety = inspectCurrencySafety(legacyRecord);
    expect(safety.rateSource).toBe("fallback");
    expect(safety.confirmed).toBe(false);
    expect(safety.reason).toContain("unconfirmed fallback exchange rate");
    // Preserves original 365 ILS amount without recalculation
    expect(safety.amountILS).toBe(365.0);
    expect(safety.exchangeRate).toBe(3.65);

    // Summary calculation preserves the stored amountILS directly
    const summary = calculateFinancialSummary([legacyRecord]);
    expect(summary.totalRevenue).toBe(365.0);
  });

  it("7. GraphQL order without total_price uses presentmentMoney and never defaults to shopMoney for grossAmount", () => {
    const graphQLOrder = {
      id: "gid://shopify/Order/4001",
      name: "#4001",
      createdAt: "2026-11-05T12:00:00Z",
      displayFinancialStatus: "PAID",
      totalPriceSet: {
        presentmentMoney: {
          amount: "150.00",
          currencyCode: "USD",
        },
        shopMoney: {
          amount: "555.00",
          currencyCode: "ILS",
        },
      },
      refunds: [],
    };

    const transactions = parseShopifyOrderToTransactions(graphQLOrder);
    expect(transactions).toHaveLength(1);
    const tx = transactions[0];

    // Gross amount must be 150 USD, NOT 555 USD!
    expect(tx.currency).toBe("USD");
    expect(tx.amount).toBe(150.0);
    expect(tx.originalGrossAmount).toBe(150.0);

    // Settlement amount must be 555 ILS
    expect(tx.settlementAmount).toBe(555.0);
    expect(tx.settlementCurrency).toBe("ILS");
    expect(tx.amountILS).toBe(555.0);
    expect(tx.exchangeRate).toBe(3.7);
    expect(tx.rateSource).toBe("settlement");
    expect(tx.rateConfirmed).toBe(true);
    expect(tx.status).toBe("paid");
  });

  it("8. Foreign refund preserves presentment amount/currency and ILS settlement separately without cross-contamination", () => {
    const orderWithForeignRefund = {
      id: "4002",
      name: "#4002",
      created_at: "2026-11-05T10:00:00Z",
      currency: "USD",
      total_price: "200.00",
      totalPriceSet: {
        presentmentMoney: { amount: "200.00", currencyCode: "USD" },
        shopMoney: { amount: "740.00", currencyCode: "ILS" },
      },
      financial_status: "PARTIALLY_REFUNDED",
      refunds: [
        {
          id: "ref_usd_1",
          created_at: "2026-11-06T10:00:00Z",
          totalRefundedSet: {
            presentmentMoney: { amount: "50.00", currencyCode: "USD" },
            shopMoney: { amount: "185.00", currencyCode: "ILS" },
          },
        },
      ],
    };

    const transactions = parseShopifyOrderToTransactions(orderWithForeignRefund);
    expect(transactions).toHaveLength(2);

    const [orderTx, refundTx] = transactions;
    // Parent Order
    expect(orderTx.amount).toBe(200.0);
    expect(orderTx.amountILS).toBe(740.0);
    expect(orderTx.totalRefunded).toBe(50.0); // 50 USD refunded
    expect(orderTx.totalRefundedILS).toBe(185.0); // 185 ILS refunded
    expect(orderTx.netAmount).toBe(150.0);
    expect(orderTx.netAmountILS).toBe(555.0);

    // Refund Transaction
    expect(refundTx.currency).toBe("USD");
    expect(refundTx.amount).toBe(50.0); // Never labeled 185 USD!
    expect(refundTx.settlementAmount).toBe(185.0);
    expect(refundTx.settlementCurrency).toBe("ILS");
    expect(refundTx.amountILS).toBe(185.0);
    expect(refundTx.exchangeRate).toBe(3.7);
    expect(refundTx.rateSource).toBe("settlement");
    expect(refundTx.rateConfirmed).toBe(true);
    expect(refundTx.isRefund).toBe(true);
  });

  it("9. Full refund produces net 0 recognized revenue and 0 recognized ILS net amount", () => {
    const fullyRefundedOrder = {
      id: "4003",
      name: "#4003",
      created_at: "2026-11-05T10:00:00Z",
      currency: "USD",
      total_price: "100.00",
      totalPriceSet: {
        presentmentMoney: { amount: "100.00", currencyCode: "USD" },
        shopMoney: { amount: "370.00", currencyCode: "ILS" },
      },
      financial_status: "REFUNDED",
      refunds: [
        {
          id: "ref_full_usd",
          created_at: "2026-11-06T10:00:00Z",
          totalRefundedSet: {
            presentmentMoney: { amount: "100.00", currencyCode: "USD" },
            shopMoney: { amount: "370.00", currencyCode: "ILS" },
          },
        },
      ],
    };

    const transactions = parseShopifyOrderToTransactions(fullyRefundedOrder);
    const [orderTx] = transactions;

    expect(orderTx.status).toBe("refunded");
    expect(orderTx.netAmount).toBe(0);
    expect(orderTx.netAmountILS).toBe(0);

    const summary = calculateFinancialSummary(transactions);
    expect(summary.totalRevenue).toBe(0);
    expect(summary.grossRevenue).toBe(370);
    expect(summary.totalRefunds).toBe(370);
  });

  it("10. Missing settlement amounts (amountILS: null) are visibly tracked and excluded from recognized ILS revenue", () => {
    const unconfirmedOrder = {
      id: "shopify_order_unconf",
      type: "revenue",
      description: "Shopify Order #9999",
      amount: 250,
      currency: "USD",
      exchangeRate: null,
      rateSource: "unconfirmed",
      rateConfirmed: false,
      amountILS: null, // Missing settlement data
      status: "pending",
      transactionDate: "2026-11-05",
    };

    const confirmedOrder = {
      id: "shopify_order_conf",
      type: "revenue",
      description: "Shopify Order #1000",
      amount: 400,
      currency: "ILS",
      exchangeRate: 1.0,
      rateSource: "base_currency",
      rateConfirmed: true,
      amountILS: 400,
      status: "paid",
      transactionDate: "2026-11-05",
    };

    const summary = calculateFinancialSummary([unconfirmedOrder, confirmedOrder]);

    // Unconfirmed tracking
    expect(summary.unconfirmedCount).toBe(1);
    expect(summary.hasUnconfirmedAmounts).toBe(true);
    expect(summary.unconfirmedTransactions).toHaveLength(1);
    expect(summary.unconfirmedTransactions[0].id).toBe("shopify_order_unconf");
    expect(summary.unconfirmedForeignTotals.USD).toBe(250);

    // Recognized ILS revenue excludes unconfirmed amounts without silently treating them as ₪0
    expect(summary.grossRevenue).toBe(400);
    expect(summary.totalRevenue).toBe(400);

    // Monthly charts also exclude unconfirmed transactions
    const monthlyCharts = generateMonthlyChartData([unconfirmedOrder, confirmedOrder], 1, new Date("2026-11-06"));
    expect(monthlyCharts[0].revenue).toBe(400);
  });

  it("11. When all transactions are confirmed, hasUnconfirmedAmounts is false and unconfirmedCount is 0", () => {
    const confirmedList = [
      {
        id: "tx_1",
        type: "revenue",
        amount: 300,
        currency: "ILS",
        exchangeRate: 1.0,
        rateSource: "base_currency",
        rateConfirmed: true,
        amountILS: 300,
        status: "paid",
        transactionDate: "2026-11-01",
      },
    ];

    const summary = calculateFinancialSummary(confirmedList);
    expect(summary.unconfirmedCount).toBe(0);
    expect(summary.hasUnconfirmedAmounts).toBe(false);
    expect(summary.unconfirmedTransactions).toHaveLength(0);
    expect(summary.totalRevenue).toBe(300);
  });
});

