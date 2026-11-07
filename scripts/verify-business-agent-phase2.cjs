"use strict";
/**
 * Phase 2 (fix47): IRIS totals check + one end-of-run Save.
 *
 * Synthetic data only. The business figures are the repo's SYNTHETIC TEST
 * BUSINESS fixture; the IRIS totals they must produce are the ones IRIS 2.0
 * showed on the live run of 15-Oct-2026 (job cmv9aoyuy001udgqzwqbey1hi). No
 * taxpayer withholding/wealth values from that run are used. No request leaves
 * the machine; Submit/Calculate are never pressed.
 *
 * Covers:
 *  2a  expected IRIS totals from exactly the typed figures (17 rows = live
 *      IRIS), skip rules, slab helper, column-aware totals reader, comparison
 *  2b  the Save probe: only the lower-bar Save, never Submit; what IRIS shows
 *      is classified; dialogs/busy/duplicates block the click; digits masked
 *  report: job report sections for the check and the Save
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { chromium } = require("playwright");
const census = require("../electron-connect/iris-tour-census");
const saveDraft = require("../electron-connect/iris-save-draft");
const report = require("../electron-connect/job-report");

const root = path.join(__dirname, "..");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(
    this,
    request.startsWith("@/") ? path.join(root, request.slice(2)) : request,
    ...rest,
  );
};
require.extensions[".ts"] = (m, file) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    file,
  );
const business = require("../lib/tax/business-filing.ts");
const schedules = require("../lib/tax/business-schedule-fields.ts");
const expectations = require("../lib/tax/business-iris-expectations.ts");
const taxCalc = require("../lib/tax/tax-calculation.ts");

// ---------------------------------------------------------------------------
// The SYNTHETIC TEST BUSINESS packet (same figures as verify-business-schedules)
// ---------------------------------------------------------------------------
const values = {
  businessGrossSales: 6000000,
  businessOtherRevenue: 120000,
  businessCostOfSales: 2000000,
  businessOperatingExpenses: 1000000,
  businessDepreciation: 150000,
  businessInadmissibleExpenses: 80000,
  businessLossBroughtForward: 50000,
  businessWithholdingDeducted: 120000,
  businessSalesExcludeIndirectTax: true,
};
function fixturePacket(incomeSources = ["business"]) {
  const annual = {
    "Business Name": "SYNTHETIC TEST BUSINESS",
    "Tax Year": 2026,
    Currency: "PKR",
    "Reporting Period Start": "2025-07-01",
    "Reporting Period End": "2026-06-30",
    "Sales for the year": 6000000,
    "Other business receipts": 120000,
    "Cost of sales": 2000000,
    "Business expenses": 1000000,
    Depreciation: 150000,
    "Expenses that are not allowed": 80000,
    "Business loss brought forward": 50000,
    "Tax already deducted on business receipts": 120000,
  };
  const components = {
    openingStock: 300000, purchases: 1850000, closingStock: 300000, otherDirect: 150000,
    purchaseBasis: true, rent: 240000, salaries: 360000, utilities: 120000, transport: 100000,
    marketing: 80000, bankCharges: 100000, scrap: 120000, accountingDepreciation: 150000,
    lossYear: 2025, ordinaryLoss: 50000, personalAddback: 80000,
  };
  const data = { ...annual };
  for (const [key, value] of Object.entries(components))
    data[schedules.BUSINESS_SCHEDULE_LABELS[key]] = value;
  const sheet = {
    businessName: "SYNTHETIC TEST BUSINESS", taxYear: 2026, closingDate: "2026-06-30", currency: "PKR",
    totalAssets: 7300000, totalEquityLiabilities: 7300000, plant: 600000, stock: 300000,
    advances: 150000, cash: 100000, securities: 100000, otherAssets: 50000, capital: 5700000,
    loans: 1000000, payables: 400000, otherLiabilities: 200000, land: 800000, building: 1200000,
    bank: 3500000, vehicle: 500000,
  };
  return business.buildBusinessPacket({
    taxYear: 2026,
    filerType: "myself",
    incomeSources,
    selections: [
      { source: "business", subcategory: "profit-return", detailsJson: JSON.stringify({ userDetails: values }) },
    ],
    books: [
      {
        id: "synthetic-books",
        extractionStatus: "MAPPED",
        extractedData: JSON.stringify({
          fields: Object.entries(data).map(([label, value]) => ({ label, value, confidence: 1 })),
        }),
      },
    ],
    balanceSheet: {
      id: "synthetic-balance",
      extractionStatus: "MAPPED",
      extractedData: JSON.stringify({
        fields: Object.entries(business.BUSINESS_BALANCE_LABELS).map(([key, label]) => ({
          label,
          value: sheet[key],
        })),
      }),
    },
  });
}

/** What IRIS 2.0 showed on the live run of 15-Oct-2026 for these 25 figures. */
const LIVE_IRIS = {
  3029: 6000000, 3030: 2150000, 3100: 3850000, 3129: 120000, 3199: 1000000,
  3200: 2970000, 3238: 150000, 3239: 230000, 3259: 0, 3270: 3200000, 3000: 3200000,
  9000: 3150000, 9100: 3150000, 920000: 635000, 9200: 635000, 3349: 1300000, 3399: 7300000,
};

// A census shaped like the live one (business and computation rows only;
// 9201/9203/703000 carry synthetic values).
const TOTAL_HEAD = ["Description", "Code", "Total Amount", "Subject to Final Tax", "Subject to Exemption", "Subject to Normal Tax"];
const COMP_HEAD = ["Description", "Code", "Total Income", "Subject to Final Tax", "Subject to Exemption", "Subject to Normal Tax"];
const row = (code, description, cells) => ({
  code,
  description,
  cells: cells.map((value) => ({ editable: false, value })),
});
function syntheticEndTour(overrides = {}) {
  const v = (code, fallback) => (code in overrides ? overrides[code] : fallback);
  return {
    complete: true,
    views: [
      { key: "Business > Manufacturing/ Trading Items", headings: TOTAL_HEAD, rows: [
        row("3000", "Income / (Loss) from Business", v("3000", ["3,200,000", "0", "0", "3,200,000"])),
        row("3029", "Net Revenue", v("3029", ["6,000,000", "0", "0", "6,000,000"])),
        row("3009", "Gross Revenue (excluding Sales Tax, Federal Excise)", ["6,000,000", "", "", "6,000,000"]),
        row("3030", "Cost of Sales / Services", v("3030", ["2,150,000", "0", "0", "2,150,000"])),
        row("3100", "Gross Profit / (Loss)", v("3100", ["3,850,000", "0", "0", "3,850,000"])),
      ] },
      { key: "Business > Other Revenues", headings: TOTAL_HEAD, rows: [
        row("3129", "Other Revenues", ["120,000", "0", "0", "120,000"]),
      ] },
      { key: "Business > Admin, Selling & Financial Expenses", headings: TOTAL_HEAD, rows: [
        row("3199", "Management, Administrative, Selling & Financial Expenses", ["1,000,000", "0", "0", "1,000,000"]),
        row("3200", "Accounting Profit / (Loss)", ["2,970,000", "0", "0", "2,970,000"]),
      ] },
      { key: "Business > Inadmissible/Admissible Deductions", headings: TOTAL_HEAD, rows: [
        row("3239", "Inadmissible Deductions", ["230,000", "0", "0", "230,000"]),
        ...("3238" in overrides && overrides["3238"] === null
          ? []
          : [row("3238", "Add Backs Accounting Depreciation", ["150,000", "0", "0", "150,000"])]),
        row("3259", "Admissible Deductions", ["", "", "", ""]),
      ] },
      { key: "Business > Adjustments", headings: TOTAL_HEAD, rows: [
        row("3270", "Income / (Loss) from Business before adjustment", ["", "", "", "3,200,000"]),
        row("327025", "Unadjusted (Loss) from Business for 2025", ["50,000", "", "", "50,000"]),
      ] },
      { key: "Business > Balance Sheet", headings: ["Description", "Code", "Amount"], rows: [
        row("3349", "Total Assets", ["1,300,000"]),
        row("3399", "Total Equity / Liabilities", ["7,300,000"]),
      ] },
      { key: "Tax Chargeable / Payments > Computations", headings: COMP_HEAD, rows: [
        row("3000", "Income / (Loss) from Business", ["9,999,999", "0", "0", "9,999,999"]),
        row("9000", "Total Income", ["3,200,000", "0", "0", "3,150,000"]),
        row("9100", "Taxable Income", ["", "", "", "3,150,000"]),
        row("920000", "Normal Tax", ["", "", "", "635,000"]),
        row("9200", "Tax Chargeable", ["", "", "", "635,000"]),
        row("9201", "Withholding Income Tax", ["", "1,000", "", ""]),
        row("9203", "Admitted Income Tax", ["", "", "", "634,000"]),
      ] },
      { key: "116 - Wealth Statement > Reconciliation of Net Assets", headings: ["Description", "Code", "Amount"], rows: [
        row("703000", "Unreconciled Amount", ["12,345"]),
      ] },
    ],
  };
}

// ---------------------------------------------------------------------------
// 2a. Expected totals
// ---------------------------------------------------------------------------
test("2a: the packet's expected IRIS totals equal what IRIS showed on the live run (17 rows, all proven)", () => {
  const packet = fixturePacket();
  const expected = packet.expectedIrisTotals;
  assert.equal(expected.version, "iris-expect-v1");
  assert.equal(packet.fields.length, 25);
  assert.deepEqual(expected.skipped, []);
  assert.deepEqual(
    Object.fromEntries(expected.rows.map((r) => [r.code, r.expected])),
    Object.fromEntries(Object.entries(LIVE_IRIS).map(([k, v]) => [k, v])),
  );
  assert.ok(expected.rows.every((r) => r.proven), "every formula used only live-proven codes");
  const byCode = Object.fromEntries(expected.rows.map((r) => [r.code, r]));
  assert.equal(byCode["3030"].formula, "3039 + 3059 + 3083 + 3088 \u2212 3099");
  assert.equal(byCode["3239"].formula, "3212 + 3238");
  assert.equal(byCode["9100"].column, "normal");
  assert.equal(byCode["3000"].column, "total");
  // Manual items are NOT in the expectation: 3349 holds only the typed assets.
  assert.equal(byCode["3349"].expected, 1300000);
});

test("2a: the slab helper is the estimate's Division I clause (1) table", () => {
  assert.equal(taxCalc.divisionIClause1Tax(0), 0);
  assert.equal(taxCalc.divisionIClause1Tax(600000), 0);
  assert.equal(taxCalc.divisionIClause1Tax(1000000), 60000);
  assert.equal(taxCalc.divisionIClause1Tax(1600000), 170000);
  assert.equal(taxCalc.divisionIClause1Tax(3150000), 635000); // live IRIS 15-Oct-2026
  assert.equal(taxCalc.divisionIClause1Tax(3200000), 650000);
  assert.equal(taxCalc.divisionIClause1Tax(6000000), 1790000);
});

const field = (irisCode, ourAmount, section) => ({
  irisCode, ourAmount, section, ourCategory: "T", ourDescription: "T", irisDescription: "T",
  portalArea: "Business", column: "Total Amount", isTaxField: false, sourceEntryCount: 1,
});
const T = "Manufacturing/ Trading Items";
const base = () => [field("3009", 6000000, T), field("3059", 2000000, T)];
const build = (fields, incomeSources = ["business"]) =>
  expectations.buildExpectedIrisTotals({ fields, incomeSources, assetCodes: ["3303"], liabilityCodes: ["3352"] });

test("2a: what is not proven is never guessed: skipped with a reason, or marked not proven", () => {
  const withSalary = build(base(), ["salary", "business"]);
  for (const code of ["9000", "9100", "920000", "9200"])
    assert.match(withSalary.skipped.find((s) => s.code === code)?.reason || "", /other income heads/);
  assert.ok(withSalary.rows.some((r) => r.code === "3000"));

  const unknownDeduction = build([...base(), field("3213", 5000, "Inadmissible/Admissible Deductions")]);
  for (const code of ["3239", "3259", "3270", "3000", "9100"])
    assert.ok(unknownDeduction.skipped.some((s) => s.code === code), code);

  const fuel = build([...base(), field("3072", 10000, T)]);
  assert.equal(fuel.rows.find((r) => r.code === "3030").proven, false, "3072 was not on the live run");
  assert.equal(fuel.rows.find((r) => r.code === "3030").expected, 2010000);

  const unknownTrading = build([...base(), field("3049", 1, T)]);
  assert.ok(unknownTrading.skipped.some((s) => s.code === "3029" && /3049/.test(s.reason)) === false);
  const strange = build([...base(), field("3010", 1, T)]);
  assert.ok(strange.skipped.some((s) => s.code === "3029" && /3010/.test(s.reason)));

  // Phase 3b (fix51): above PKR 10 million the agent types the 10% Section
  // 4AB surcharge on the Computations tab, so 9200 is expected as 920000 +
  // 923184 and marked not proven (not yet seen on IRIS).
  const big = build([field("3009", 20000000, T)]);
  assert.equal(big.rows.find((r) => r.code === "920000").proven, false, "the 45% band was not seen live");
  // 1,610,000 + 45% x (20,000,000 - 5,600,000) = 8,090,000; 10% = 809,000.
  assert.equal(big.rows.find((r) => r.code === "920000").expected, 8090000);
  assert.equal(big.rows.find((r) => r.code === "923184").expected, 809000);
  assert.equal(big.rows.find((r) => r.code === "923184").proven, false);
  assert.equal(big.rows.find((r) => r.code === "9200").expected, 8899000);
  assert.equal(big.rows.find((r) => r.code === "9200").proven, false);
  assert.equal(big.computations.surcharge.action, "TYPE");
  assert.equal(big.computations.surcharge.value, 809000);
  assert.equal(big.computations.superTax.action, "NONE");

  const huge = build([field("3009", 150000000, T)]);
  assert.ok(huge.skipped.some((s) => s.code === "920000" && /Section 113/.test(s.reason)));
  // Section 113 may apply, so the surcharge base is unknown: the taxpayer
  // types it (the agent shows the message only if IRIS 9100 is above 10m).
  assert.equal(huge.computations.surcharge.action, "USER");
  assert.equal(huge.computations.superTax.action, "NONE", "150,000,000 exactly is 0%");

  const loss = build([...base(), field("327025", 9000000, "Adjustments")]);
  assert.ok(loss.skipped.some((s) => s.code === "9100" && /larger than business income/.test(s.reason)));
});

// ---------------------------------------------------------------------------
// 2a. Reader + comparison
// ---------------------------------------------------------------------------
test("2a: the totals reader keeps every column; 9100/920000/9200 are read from 'Subject to Normal Tax'", () => {
  const detailed = census.collectTotalsDetailed(syntheticEndTour());
  assert.deepEqual(detailed["9100"].cells, ["", "", "", "3,150,000"]);
  assert.equal(detailed["9100"].value, "3,150,000");
  assert.deepEqual(detailed["9100"].headings, COMP_HEAD.slice(2));
  assert.equal(census.pickTotalColumn(detailed["9000"], "total"), "3,200,000");
  assert.equal(census.pickTotalColumn(detailed["9000"], "normal"), "3,150,000");
  assert.equal(detailed["3000"].value, "3,200,000", "the first view that shows a code wins");
  const compat = census.collectTotals(syntheticEndTour());
  for (const code of ["9100", "920000", "9200", "9201", "9203", "703000"])
    assert.notEqual(compat[code], "", `${code} is no longer logged blank`);
  assert.equal(census.parseIrisAmount("(1,000)"), -1000);
  assert.equal(census.parseIrisAmount(""), null);
});

test("2a: IRIS rows against the packet: all 17 match on the live-shaped census", () => {
  const check = census.compareIrisTotals(
    census.collectTotalsDetailed(syntheticEndTour()),
    fixturePacket().expectedIrisTotals,
  );
  assert.equal(check.available, true);
  assert.equal(check.matched, 17);
  assert.equal(check.differs, 0);
  assert.equal(check.notSeen, 0);
});

test("2a: a wrong IRIS figure reads DIFFERS, a missing row NOT SEEN, an old packet 'not available'", () => {
  const expected = fixturePacket().expectedIrisTotals;
  const check = census.compareIrisTotals(
    census.collectTotalsDetailed(syntheticEndTour({ "3100": ["3,851,000", "0", "0", "3,851,000"], "3238": null })),
    expected,
  );
  assert.equal(check.rows.find((r) => r.code === "3100").status, "differs");
  assert.equal(check.rows.find((r) => r.code === "3100").irisNumber, 3851000);
  assert.equal(check.rows.find((r) => r.code === "3238").status, "not_seen");
  assert.equal(check.matched, 15);
  const old = census.compareIrisTotals(census.collectTotalsDetailed(syntheticEndTour()), undefined);
  assert.equal(old.available, false);
});

// ---------------------------------------------------------------------------
// 2b. The Save probe (Playwright, synthetic lower bar as captured in IRIS)
// ---------------------------------------------------------------------------
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
after(async () => {
  await browser?.close();
});

async function withPage(html, run) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.route("**/*", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: html }),
  );
  await page.goto("https://iris.fbr.gov.pk/nitr/workflow");
  const mainFrame = {
    get url() {
      return page.url();
    },
    executeJavaScript: (source) => page.evaluate(source),
  };
  mainFrame.framesInSubtree = [mainFrame];
  const win = {
    isDestroyed: () => false,
    webContents: { mainFrame, getURL: () => page.url(), executeJavaScript: mainFrame.executeJavaScript },
  };
  try {
    await run(page, win);
  } finally {
    await context.close();
  }
}

function saveFixture({ mode = "toast", extraSave = false, dialogBefore = false, disabled = false, busyMs = 0, workflow = true, farBelow = false } = {}) {
  // farBelow: the bar sits below the fold on a page with IRIS's
  // `scroll-behavior: smooth` (capture 02), as when a grid was scrolled.
  const bar = farBelow
    ? "html{scroll-behavior:smooth}.lowerbar{margin-top:3000px;height:44px;background:#eee}"
    : ".lowerbar{position:fixed;bottom:0;left:0;right:0;height:44px;background:#eee}";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:14px sans-serif}${bar}
button{margin:4px}</style></head><body>
${workflow ? '<app-nitr-workflow><app-nitr-wf-body><div class="custom-tabs"><div class="sticky-tabs-head"><div class="head"><div class="title active">Data</div></div></div></div></app-nitr-wf-body></app-nitr-workflow>' : "<main>Dashboard</main>"}
${dialogBefore ? '<div role="dialog" id="pre"><p>Session notice</p><button>OK</button></div>' : ""}
<div class="lowerbar">
<button class="right correspondance-lowermenu-bar-item" onclick="actions.push('CLOSE')"><i class="fa fa-times-circle"></i>Close </button>
<button class="right correspondance-lowermenu-bar-item" onclick="actions.push('PRINT')"><i class="fa fa-print"></i>Print </button>
<button class="right correspondance-lowermenu-bar-item" onclick="actions.push('SUBMIT')"><i class="fa fa-check-circle"></i>Submit </button>
<span><button class="right correspondance-lowermenu-bar-item" id="save" ${disabled ? "disabled" : ""} onclick="onSave()"><i class="fa fa-save"></i>Save </button></span>
${extraSave ? `<button class="correspondance-lowermenu-bar-item" onclick="actions.push('SAVE2')"><i class="fa fa-save"></i>Save </button>` : ""}
</div>
<script>
window.actions = [];
const mode = ${JSON.stringify(mode)};
const busyMs = ${busyMs};
function later(fn) {
  if (!busyMs) return setTimeout(fn, 60);
  const overlay = document.createElement("div");
  overlay.className = "loading-overlay";
  overlay.style.cssText = "position:fixed;top:0;left:0;width:20px;height:20px";
  document.body.appendChild(overlay);
  setTimeout(() => { overlay.remove(); fn(); }, busyMs);
}
function dialog(text) {
  const d = document.createElement("mat-dialog-container");
  d.setAttribute("role", "dialog");
  d.innerHTML = "<p>" + text + "</p><button onclick=\\"actions.push('OK');this.parentNode.remove()\\">OK</button>";
  document.body.appendChild(d);
}
function onSave() {
  actions.push("SAVE");
  later(() => {
    if (mode === "toast") {
      const t = document.createElement("div");
      t.id = "toast-container";
      t.innerHTML = '<div class="toast"><div class="toast-message">Record saved successfully for 1234567890123</div></div>';
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 700);
    }
    if (mode === "success_dialog") dialog("Return saved successfully.");
    if (mode === "error_dialog") dialog("Please add Business Details before saving.");
  });
}
</script></body></html>`;
}
const fast = { pollMs: 40, quietMs: 250, timeoutMs: 4000, busyWaitMs: 1000 };

test("2b: Save presses ONLY the lower-bar Save; IRIS's success toast is read (digits masked); Submit is never touched", async () => {
  await withPage(saveFixture({ mode: "toast" }), async (page, win) => {
    const steps = [];
    const out = await saveDraft.saveReturnDraft(win, { ...fast, onStep: (s) => steps.push(s) });
    assert.equal(out.status, "saved_confirmed");
    assert.equal(out.clicked, true);
    assert.match(out.message, /Record saved successfully for #{13}/);
    assert.doesNotMatch(out.message, /1234567890123/);
    assert.deepEqual(await page.evaluate("actions"), ["SAVE"]);
    assert.ok(steps.includes("iris_save_clicked"));
    assert.equal(out.build, "pension-services-multifiling-20261106a");
  });
});

test("2b: a success dialog with a single OK is closed; an error dialog is left on screen", async () => {
  await withPage(saveFixture({ mode: "success_dialog" }), async (page, win) => {
    const out = await saveDraft.saveReturnDraft(win, fast);
    assert.equal(out.status, "saved_confirmed");
    assert.equal(out.dialog.closed, true);
    assert.deepEqual(await page.evaluate("actions"), ["SAVE", "OK"]);
  });
  await withPage(saveFixture({ mode: "error_dialog" }), async (page, win) => {
    const out = await saveDraft.saveReturnDraft(win, fast);
    assert.equal(out.status, "save_error_message");
    assert.equal(out.dialog.closed, false);
    assert.match(out.message, /Please add Business Details/);
    assert.deepEqual(await page.evaluate("actions"), ["SAVE"]);
    assert.equal(await page.locator("mat-dialog-container").count(), 1, "left for the taxpayer");
  });
});

test("2b: an open dialog, two Save buttons, a disabled Save or no workflow: nothing is clicked", async () => {
  const cases = [
    [{ dialogBefore: true }, "dialog_open_before_save"],
    [{ extraSave: true }, "save_button_not_unique"],
    [{ disabled: true }, "save_button_disabled"],
    [{ workflow: false }, "save_button_not_found"],
  ];
  for (const [options, reason] of cases) {
    await withPage(saveFixture(options), async (page, win) => {
      const out = await saveDraft.saveReturnDraft(win, fast);
      assert.equal(out.clicked, false, reason);
      assert.equal(out.status, "not_clicked");
      assert.equal(out.reason, reason);
      assert.deepEqual(await page.evaluate("actions"), [], reason);
    });
  }
});

test("2b: IRIS busy after the click is waited out; no message at all is reported as such", async () => {
  await withPage(saveFixture({ mode: "toast", busyMs: 400 }), async (page, win) => {
    const out = await saveDraft.saveReturnDraft(win, fast);
    assert.equal(out.status, "saved_confirmed");
    assert.deepEqual(await page.evaluate("actions"), ["SAVE"]);
  });
  await withPage(saveFixture({ mode: "silent" }), async (page, win) => {
    const out = await saveDraft.saveReturnDraft(win, fast);
    assert.equal(out.status, "saved_no_message");
    assert.equal(out.clicked, true);
    assert.deepEqual(await page.evaluate("actions"), ["SAVE"]);
  });
});

test("2b: a Save button below the fold on a smooth-scrolling IRIS page is scrolled into view instantly and pressed", async () => {
  await withPage(saveFixture({ mode: "toast", farBelow: true }), async (page, win) => {
    const out = await saveDraft.saveReturnDraft(win, fast);
    assert.equal(out.status, "saved_confirmed", out.reason || "");
    assert.deepEqual(await page.evaluate("actions"), ["SAVE"]);
  });
});

test("2b: message wording is classified error-first ('not saved' is never success)", () => {
  assert.equal(saveDraft.classifySaveMessage("Record saved successfully"), "success");
  assert.equal(saveDraft.classifySaveMessage("Return not saved"), "error");
  assert.equal(saveDraft.classifySaveMessage("Please fill all mandatory fields"), "error");
  assert.equal(saveDraft.classifySaveMessage("Draft updated"), "other");
  assert.match(saveDraft.describeSaveOutcome({ clicked: false, reason: "x" }), /not pressed: x/);
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
test("report: the job report shows the totals check, the Save and the after-Save readback", () => {
  const detailed = census.collectTotalsDetailed(syntheticEndTour({ "3100": ["3,851,000", "0", "0", "3,851,000"] }));
  const totalsCheck = census.compareIrisTotals(detailed, fixturePacket().expectedIrisTotals);
  const lines = report.buildJobReport({
    status: "completed",
    executionLog: [],
    result: {
      autofill: {
        totalsCheck,
        irisTotalsDetailed: detailed,
        appEstimate: { taxableIncome: 3000000, irisTaxableIncome: 3150000, difference: 150000, manualItems: [{ key: "businessDepreciation", amount: 150000 }] },
        save: {
          status: "saved_confirmed", clicked: true, at: "2026-10-15T09:00:00.000Z",
          message: "Record saved successfully", afterSave: { complete: true, match: 25, mismatch: 0, notSeen: 0 },
        },
      },
    },
  });
  const text = Array.isArray(lines) ? lines.join("\n") : String(lines);
  assert.match(text, /IRIS vs TAXROCKET \(computed totals from the typed figures\)/);
  assert.match(text, /16 match, 1 differ, 0 not seen/);
  assert.match(text, /3100 Gross Profit \/ \(Loss\): IRIS 3,851,000 · expected 3,850,000 \(3029 − 3030\) -> DIFFERS/);
  assert.match(text, /taxable income 3,000,000; IRIS now: 3,150,000 \(difference 150,000\)/);
  assert.match(text, /IRIS-only figures \(not from the packet\): 9201 Withholding Income Tax 1,000/);
  assert.match(text, /SAVE \(pressed once at the end/);
  assert.match(text, /Readback after Save: 25 match, 0 mismatch, 0 not seen/);
  assert.match(text, /Save: pressed once by the agent at 2026-10-15T09:00:00.000Z/);
  assert.match(text, /Submit, Prepare PSID, payment: never pressed/);
});

test("build: every agent module carries the Phase 2 tag and main.js checks the Save module", () => {
  const main = fs.readFileSync(path.join(root, "electron-connect/main.js"), "utf8");
  const tag = /const AGENT_BUILD_TAG = "([^"]+)"/.exec(main)[1];
  assert.equal(tag, "pension-services-multifiling-20261106a");
  for (const mod of ["iris-navigation", "iris-row-filler", "iris-business-row-driver", "iris-tour-census", "iris-wealth-driver", "iris-employer-driver", "iris-save-draft"])
    assert.equal(require(`../electron-connect/${mod}`).BUILD_TAG, tag, mod);
  assert.match(main, /\["iris-save-draft\.js", irisSaveDraft\.BUILD_TAG\]/);
  // The probe clicks exactly two things: the one Save button, and the single
  // OK of a success dialog. Submit is only counted, Calculate never named.
  const probe = saveDraft.saveProbe.toString();
  assert.deepEqual(probe.match(/[\w[\]]+\.click\(\)/g), ["saveButtons[0].click()", "buttons[0].click()"]);
  assert.doesNotMatch(probe, /Calculate/);
});
