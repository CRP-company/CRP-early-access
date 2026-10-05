/**
 * Regression: the tester's monthly-request cards must be VISIBLE, not merely present.
 *
 * The bug this guards against
 * ---------------------------
 * `.slot` (the "This month" cards) was styled `height: 100%`. Its parent,
 * `.request-slots`, is `display: flex` with `flex-wrap: wrap` and no explicit
 * height, so the container is auto-height. A percentage height against an
 * auto-height containing block resolves to `auto`, and the slot has no content
 * of its own — so every slot laid out at the correct WIDTH but with a computed
 * height of exactly 0px.
 *
 * That failure is invisible to any test that only inspects the DOM: the nodes
 * existed, the classes were right, the counts were right, and the request list
 * under "Your requests" rendered perfectly. Only a real layout measurement
 * catches it, which is why this runs in a real browser.
 *
 * What it asserts
 * ---------------
 * The genuine tester/index.html, the genuine tester.css, and the genuine
 * renderTarget()/renderFeedback() functions extracted verbatim from
 * tester/js/tester.js are driven with a realistic /tester-me payload. Nothing
 * about Firebase or the Worker is involved — this is a pure presentation test,
 * so it runs in well under a second and needs no emulator.
 *
 *   node tests/e2e-tester-feedback-cards.js
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "tester/js/tester.js"), "utf8");

/** Extract a shipped function verbatim, brace-balanced, so we test real code. */
function grab(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`could not find ${name} in tester.js`);
  let depth = 0;
  for (let i = SOURCE.indexOf("{", start); i < SOURCE.length; i++) {
    if (SOURCE[i] === "{") depth++;
    else if (SOURCE[i] === "}" && --depth === 0) return SOURCE.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const HELPERS = grab("escapeHtml") + "\n" + grab("formatDate");
const RENDER_TARGET = grab("renderTarget");
const RENDER_FEEDBACK = grab("renderFeedback");
const AREA_LABELS = /\nconst AREA_LABELS = (\{[\s\S]*?\n\});/.exec(SOURCE)[1];

let failed = 0;
function check(name, ok, detail = "") {
  const line = `${ok ? "  PASS" : "  FAIL"}  ${name}`;
  console.log(ok ? line : `${line}${detail ? `\n          ${detail}` : ""}`);
  if (!ok) failed++;
}

/** A /tester-me payload: one request filed this month. */
const PAYLOAD = {
  ok: true,
  tester: {
    id: "t_1",
    name: "Alex Morgan",
    email: "alex@example.com",
    testerNumber: 4,
    status: "accepted",
    active: true,
    blockedReason: null,
  },
  activity: { period: "2026-10", submitted: 1, target: 2, met: false },
  feedback: [
    {
      id: "fb1",
      title: "Add a dark mode",
      body: "The display is bright at night in the car.",
      area: "app",
      status: "submitted",
      period: "2026-10",
      email: "alex@example.com",
      createdAt: "2026-10-05T12:00:00.000Z",
    },
  ],
};

/** Load the real page + stylesheet and run the real render code. */
async function measure(browser, { width, height, fix = true } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto("file://" + path.join(ROOT, "tester/index.html"));
  await page.addStyleTag({ url: "file://" + path.join(ROOT, "tester/css/tester.css") });
  if (!fix) {
    // Reintroduce the historical `height: 100%` to prove this test can fail.
    await page.addStyleTag({
      content: ".slot { height: 100% !important; min-height: 0 !important; }",
    });
  }
  await page.evaluate(() => {
    document.getElementById("app-view").hidden = false;
    document.getElementById("login-view").hidden = true;
  });

  const out = await page.evaluate(
    ({ helpers, renderTarget, renderFeedback, areaLabels, payload }) => {
      const els = {
        targetText: document.getElementById("target-text"),
        requestSlots: document.getElementById("request-slots"),
        feedbackList: document.getElementById("feedback-list"),
        feedbackCount: document.getElementById("feedback-count"),
      };
      const AREA_LABELS = eval("(" + areaLabels + ")");
      eval(helpers);
      eval(renderTarget);
      eval(renderFeedback);

      renderTarget(payload.activity);
      renderFeedback(payload.feedback || []);

      const rect = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          display: cs.display,
          visibility: cs.visibility,
        };
      };

      return {
        targetText: els.targetText.textContent.trim(),
        countPill: els.feedbackCount.textContent.trim(),
        slots: [...els.requestSlots.children].map(rect),
        entries: [...els.feedbackList.querySelectorAll(".entry")].map(rect),
        entryCount: els.feedbackList.querySelectorAll(".entry").length,
      };
    },
    {
      helpers: HELPERS,
      renderTarget: RENDER_TARGET,
      renderFeedback: RENDER_FEEDBACK,
      areaLabels: AREA_LABELS,
      payload: PAYLOAD,
    },
  );

  await page.close();
  return out;
}

(async () => {
  console.log("Tester dashboard — monthly card visibility\n");
  const browser = await chromium.launch();

  try {
    // ---- desktop ----
    const d = await measure(browser, { width: 1280, height: 900 });

    check("two cards are drawn (the monthly target)", d.slots.length === 2, `got ${d.slots.length}`);
    check(
      "every card has real height, not 0px",
      d.slots.every((s) => s.h >= 20),
      `heights: ${JSON.stringify(d.slots.map((s) => s.h))}`,
    );
    check(
      "every card has real width",
      d.slots.every((s) => s.w >= 20),
      `widths: ${JSON.stringify(d.slots.map((s) => s.w))}`,
    );
    check(
      "cards are visible and not display:none",
      d.slots.every((s) => s.display !== "none" && s.visibility === "visible"),
    );

    check('the count still reads "1 more this month"', d.targetText === "1 more this month", `got "${d.targetText}"`);
    check("the request-list count pill is 1", d.countPill === "1", `got "${d.countPill}"`);
    check("the filed request renders as an entry", d.entryCount === 1, `got ${d.entryCount}`);
    check(
      "that entry is visible with height",
      d.entries.every((e) => e.h >= 20),
      `heights: ${JSON.stringify(d.entries.map((e) => e.h))}`,
    );

    // ---- mobile: the row stacks, which must not re-collapse the cards ----
    const m = await measure(browser, { width: 390, height: 844 });
    check(
      "cards are still sized when the layout stacks on mobile",
      m.slots.length === 2 && m.slots.every((s) => s.h >= 20),
      `heights: ${JSON.stringify(m.slots.map((s) => s.h))}`,
    );

    // ---- negative control ----
    // The point of the whole test: restoring `height: 100%` must make it fail.
    const broken = await measure(browser, { width: 1280, height: 900, fix: false });
    check(
      "NEGATIVE CONTROL: height:100% reproduces zero-height cards",
      broken.slots.every((s) => s.h === 0),
      `heights were ${JSON.stringify(broken.slots.map((s) => s.h))}, so the guard above is meaningful`,
    );
  } finally {
    await browser.close();
  }

  console.log("");
  console.log(failed === 0 ? "TESTER FEEDBACK CARDS E2E PASS" : `TESTER FEEDBACK CARDS E2E FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error("harness error:", e.message); process.exit(1); });