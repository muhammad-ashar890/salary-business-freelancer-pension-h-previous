"use strict";
/**
 * DP-4 (Data Push, 16-Oct-2026): the IRIS business tab "Inadmissible/
 * Admissible Deductions" -- add-backs by reason (lib/tax/business-addbacks.ts),
 * the wizard sanitizer (subcategories.ts), the business packet (v7) and the
 * IRIS expectations for 3239 / 3259 / 3270 / 3000.
 *
 * IRIS facts used (captures 30 / 31 / 32 of 15-Oct-2026,
 * ~/iris-business-captures; live run of 15-Oct-2026): picker "Add
 * Inadmissible Deductions" (36 cards = rows 3201 ... 3238), picker "Add
 * Admissible Deductions" (10 cards), card text = row description = contract
 * label, typable rows E E E D. Synthetic data only.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

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

const ab = require(path.join(root, "lib/tax/business-addbacks.ts"));
const filing = require(path.join(root, "lib/tax/business-filing.ts"));
const subs = require(path.join(root, "lib/tax/rules/ty2026/subcategories.ts"));
const expectations = require(path.join(root, "lib/tax/business-iris-expectations.ts"));
const scheduleFields = require(path.join(root, "lib/tax/business-schedule-fields.ts"));
const contract = require(path.join(root, "electron-connect/iris-business-contract.json"));
const plain = (value) => JSON.parse(JSON.stringify(value));

const PERSONAL = "3212"; // Add Backs u/s 21(h) Personal Expenditure
const FINE = "3211"; // Add Backs u/s 21(g) Fine / Penalty ...
const ENTERTAINMENT = "3208"; // Add Backs u/s 21(d) Entertainment Expenditure above prescribed limit

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
test("catalogue: 36 + 10 picker rows, exact contract labels, typable = first cell editable", () => {
  const rows = ab.allDeductionRows();
  assert.equal(rows.length, 46);
  assert.equal(rows.filter((r) => r.picker === "inadmissible").length, 36);
  assert.equal(rows.filter((r) => r.picker === "admissible").length, 10);
  assert.equal(new Set(rows.map((r) => r.code)).size, 46);
  const grid = contract.business_deductions.rows;
  for (const row of rows) {
    assert.ok(grid[row.code], `${row.code} is a captured row`);
    assert.equal(row.label, grid[row.code].label, `${row.code} label = capture text`);
    assert.equal(row.typable, !grid[row.code].disabled[0], `${row.code} typable`);
    assert.equal(grid[row.code].optional, true, `${row.code} is added through a picker`);
  }
  // Every optional (picker) row of the captured grid is in the catalogue.
  const optional = Object.entries(grid).filter(([, spec]) => spec.optional).map(([code]) => code);
  assert.deepEqual([...optional].sort(), rows.map((r) => r.code).sort());
  // Rows IRIS fills itself are never typable / never offered.
  for (const code of ["3235", "3236", "3237", "3238", "3245", "3246", "3247", "3248"]) {
    assert.equal(ab.findDeductionRow(code).typable, false, code);
    assert.equal(ab.findDeductionRow(code).unsupported, "computed", code);
  }
  assert.equal(ab.findDeductionRow("3231").label.includes("\u2019"), true, "curly apostrophe kept");
  assert.equal(ab.IRIS_DEDUCTION_PICKERS.inadmissible.title, "Add Inadmissible Deductions");
  assert.equal(ab.IRIS_DEDUCTION_PICKERS.admissible.title, "Add Admissible Deductions");
  assert.equal(ab.IRIS_DEDUCTION_PICKERS.inadmissible.button, "+ Inadmissible");
  assert.equal(ab.IRIS_DEDUCTION_PICKERS.admissible.button, "+ Admissible");
});

test("reasons offered: 27 inadmissible rows; AOP-only, company-only, intangibles, asset-list and pre-commencement rows are not", () => {
  const offered = ab.addBackReasons().map((r) => r.code);
  assert.equal(offered.length, 27);
  assert.deepEqual(offered, [
    "3201", "3202", "3203", "3204", "3205", "3206", "3207", "3208", "3209", "320901",
    "3210", "3211", "3212", "3215", "3216", "3217", "3218", "3219", "3220", "3224",
    "3227", "322901", "322902", "322903", "322905", "3231", "3234",
  ]);
  assert.equal(ab.findDeductionRow("3213").unsupported, "aop_only");
  assert.equal(ab.findDeductionRow("322904").unsupported, "company_only");
  assert.equal(ab.findDeductionRow("3225").unsupported, "intangibles");
  assert.equal(ab.findDeductionRow("3226").unsupported, "asset_schedule");
  assert.equal(ab.findDeductionRow("3230").unsupported, "pre_commencement");
  assert.equal(ab.isSelectableAddBack("3256"), false, "admissible rows are not add-backs");
  assert.equal(ab.isSelectableAddBack("3258"), false);
  assert.equal(ab.isSelectableAddBack(" 3212 "), true);
  assert.equal(ab.DISPOSAL_GAIN_ROW, "3226");
  assert.equal(ab.DISPOSAL_LOSS_ROW, "3256");
  assert.equal(ab.UNABSORBED_DEPRECIATION_ROW, "3258");
});

test("sanitize: empty lines dropped, malformed input refused (never fixed)", () => {
  const ok = ab.sanitizeBusinessAddBacks([{ code: PERSONAL, amount: 50_000 }, { code: "" }, { code: FINE }]);
  assert.equal(ok.ok, true);
  assert.deepEqual(plain(ok.rows), [{ code: PERSONAL, amount: 50_000 }, { code: FINE }]);
  assert.deepEqual(plain(ab.sanitizeBusinessAddBacks(undefined)), { ok: true, rows: [] });
  for (const [bad, message] of [
    ["x", /must be a list/],
    [[1], /must be an object/],
    [[{ code: 3212 }], /must be text/],
    [[{ code: "21(h)" }], /not an IRIS reason code/],
    [[{ code: PERSONAL, amount: -1 }], /positive number/],
    [[{ code: PERSONAL, amount: 10.5 }], /whole rupees/],
    [Array.from({ length: 28 }, () => ({ code: PERSONAL, amount: 1 })), /at most 27/],
  ]) {
    const out = ab.sanitizeBusinessAddBacks(bad);
    assert.equal(out.ok, false, JSON.stringify(bad).slice(0, 60));
    assert.match(out.error, message);
  }
});

test("validate: reason, amount, duplicates and reasons that do not apply", () => {
  assert.deepEqual(ab.validateBusinessAddBacks([{ code: PERSONAL, amount: 50_000 }, { code: FINE, amount: 30_000 }]), []);
  const msgs = (rows) => ab.validateBusinessAddBacks(rows).join(" | ");
  assert.match(msgs([{ code: "", amount: 5 }]), /choose the IRIS reason/);
  assert.match(msgs([{ code: "3999", amount: 5 }]), /not an IRIS add-back reason/);
  assert.match(msgs([{ code: "3256", amount: 5 }]), /not an IRIS add-back reason/);
  assert.match(msgs([{ code: "3238", amount: 5 }]), /IRIS fills this row by itself/);
  assert.match(msgs([{ code: "3213", amount: 5 }]), /association of persons/);
  assert.match(msgs([{ code: "322904", amount: 5 }]), /foreign-controlled resident company/);
  assert.match(msgs([{ code: "3226", amount: 5 }]), /list of business assets/);
  assert.match(msgs([{ code: PERSONAL }]), /enter the amount/);
  assert.match(msgs([{ code: PERSONAL, amount: 0 }]), /more than zero/);
  assert.match(msgs([{ code: PERSONAL, amount: 1 }, { code: PERSONAL, amount: 2 }]), /listed twice/);
});

test("compare with the total: more is an error, equal leaves nothing, less leaves the rest manual", () => {
  const rows = [{ code: PERSONAL, amount: 50_000 }, { code: FINE, amount: 30_000 }];
  assert.deepEqual(plain(ab.compareWithInadmissibleTotal(rows, 80_000)), { problems: [], remainder: 0 });
  assert.deepEqual(plain(ab.compareWithInadmissibleTotal(rows, 100_000)), { problems: [], remainder: 20_000 });
  assert.match(ab.compareWithInadmissibleTotal(rows, 70_000).problems[0], /Rs 80,000, which is more than "Expenses that are not allowed" \(Rs 70,000\)/);
  assert.match(ab.compareWithInadmissibleTotal(rows, null).problems[0], /is empty/);
  assert.deepEqual(plain(ab.compareWithInadmissibleTotal([], 5)), { problems: [], remainder: 5 });
});

test("plan: IRIS order, exact labels, total; an incomplete list is refused", () => {
  const plan = plain(ab.buildAddBacksPlan([{ code: FINE, amount: 30_000 }, { code: ENTERTAINMENT, amount: 10_000 }, { code: PERSONAL, amount: 50_000 }]));
  assert.equal(plan.version, "add-backs-v1");
  assert.deepEqual(plan.entries.map((e) => e.code), [ENTERTAINMENT, FINE, PERSONAL]);
  assert.equal(plan.entries[2].label, "Add Backs u/s 21(h) Personal Expenditure");
  assert.equal(plan.total, 90_000);
  assert.throws(() => ab.buildAddBacksPlan([{ code: PERSONAL }]), /enter the amount/);
});

test("wizard sanitizer: the list survives save and reload; a malformed one is refused / left out", () => {
  const rows = [{ code: PERSONAL, amount: 50_000 }, { code: FINE, amount: 30_000 }];
  const saved = subs.resolveTy2026IncomeSelections({
    incomeSources: ["business"],
    selections: [{ source: "business", subcategory: "profit-return", details: { businessGrossSales: 100, businessAddBacks: rows } }],
  });
  assert.equal(saved.success, true, saved.error);
  assert.match(JSON.stringify(plain(saved)), /"businessAddBacks":\[\{"code":"3212","amount":50000\},\{"code":"3211","amount":30000\}\]/);
  const bad = subs.resolveTy2026IncomeSelections({
    incomeSources: ["business"],
    selections: [{ source: "business", subcategory: "profit-return", details: { businessGrossSales: 100, businessAddBacks: [{ code: PERSONAL, amount: 1.5 }] } }],
  });
  assert.equal(bad.success, false);
  assert.match(bad.error, /whole rupees/);
  const kept = subs.parsePersistedSelectionUserDetails(JSON.stringify({ userDetails: { businessGrossSales: 1, businessAddBacks: rows } }));
  assert.deepEqual(plain(kept.businessAddBacks), rows);
  const broken = subs.parsePersistedSelectionUserDetails(JSON.stringify({ userDetails: { businessGrossSales: 1, businessAddBacks: "x" } }));
  assert.equal(broken.businessAddBacks, undefined);
});

// ---------------------------------------------------------------------------
// Packet: same synthetic business figures as DP-1 / DP-3.
// ---------------------------------------------------------------------------
const VALUES = {
  businessGrossSales: 6_000_000, businessOtherRevenue: 120_000, businessCostOfSales: 2_000_000,
  businessOperatingExpenses: 1_000_000, businessDepreciation: 150_000, businessInadmissibleExpenses: 80_000,
  businessLossBroughtForward: 50_000, businessWithholdingDeducted: 120_000, businessSalesExcludeIndirectTax: true,
};
const packetInput = (extra = {}, books = null) => ({
  taxYear: 2026,
  filerType: "myself",
  incomeSources: ["business"],
  selections: [{ source: "business", subcategory: "profit-return", detailsJson: JSON.stringify({ userDetails: { ...VALUES, ...extra } }) }],
  ...(books ? { books: [books] } : {}),
});
const row = (p, code) => p.expectedIrisTotals.rows.find((r) => r.code === code);
const deductionFields = (p) => p.fields.filter((f) => f.section === "Inadmissible/Admissible Deductions");

test("packet v7: every listed reason is queued on the deductions tab; the manual item is gone", () => {
  const before = plain(filing.buildBusinessPacket(packetInput()));
  assert.ok(before.pending.some((item) => item.key === "businessInadmissibleExpenses"));
  assert.equal(before.addBacks, null);
  const p = plain(filing.buildBusinessPacket(packetInput({
    businessAddBacks: [{ code: FINE, amount: 30_000 }, { code: PERSONAL, amount: 50_000 }],
  })));
  assert.equal(p.version, "business-entry-v7");
  assert.deepEqual(
    deductionFields(p).map((f) => [f.irisCode, f.ourAmount, f.column, f.portalArea, f.irisDescription]),
    [
      [FINE, 30_000, "Total Amount", "Business", "Add Backs u/s 21(g) Fine / Penalty for violation of any law / rule / regulation"],
      [PERSONAL, 50_000, "Total Amount", "Business", "Add Backs u/s 21(h) Personal Expenditure"],
    ],
  );
  assert.ok(!p.pending.some((item) => item.key === "businessInadmissibleExpenses"));
  assert.equal(p.addBacks.total, 80_000);
  // The estimate is unchanged: the list only splits the same total.
  assert.equal(p.computedEstimate.taxableIncome, before.computedEstimate.taxableIncome);
  // 3239 = typed reasons (no 3088 typed without Books); not yet seen live for 3211.
  assert.equal(row(p, "3239").expected, 80_000);
  assert.equal(row(p, "3239").proven, false);
  assert.equal(row(p, "3259").expected, 0);
  assert.equal(row(p, "3270").expected, row(before, "3270").expected + 80_000);
});

test("packet: a part not listed stays manual; only 3212 keeps the older version", () => {
  const p = plain(filing.buildBusinessPacket(packetInput({ businessAddBacks: [{ code: PERSONAL, amount: 50_000 }] })));
  assert.notEqual(p.version, "business-entry-v7", "3212 alone is typed by every fix44+ agent");
  assert.deepEqual(deductionFields(p).map((f) => [f.irisCode, f.ourAmount]), [[PERSONAL, 50_000]]);
  const manual = p.pending.find((item) => item.key === "businessInadmissibleExpenses");
  assert.equal(manual.amount, 30_000);
  assert.match(manual.reason, /not listed by reason/);
  assert.equal(row(p, "3239").proven, true, "3212 was typed on the live run");
});

test("packet: a list above the total, or with a reason that does not apply, stops generation", () => {
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessAddBacks: [{ code: PERSONAL, amount: 90_000 }] })),
    /more than "Expenses that are not allowed"/,
  );
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessAddBacks: [{ code: "3213", amount: 10_000 }] })),
    /Expenses that are not allowed, by reason: .*association of persons/,
  );
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessAddBacks: [{ code: FINE }] })),
    /enter the amount/,
  );
});

// Business Books with a personal-expenditure add-back (DP-1 synthetic books).
const ANNUAL = {
  "Business Name": "SYNTHETIC TEST BUSINESS", "Tax Year": 2026, Currency: "PKR",
  "Reporting Period Start": "2025-07-01", "Reporting Period End": "2026-06-30",
  "Sales for the year": 6000000, "Other business receipts": 120000, "Cost of sales": 2000000,
  "Business expenses": 1000000, Depreciation: 150000, "Expenses that are not allowed": 80000,
  "Business loss brought forward": 50000, "Tax already deducted on business receipts": 120000,
};
function booksDoc(components) {
  const data = { ...ANNUAL };
  for (const [k, v] of Object.entries(components)) data[scheduleFields.BUSINESS_SCHEDULE_LABELS[k]] = v;
  return {
    id: "synthetic-books",
    extractionStatus: "MAPPED",
    extractedData: JSON.stringify({ fields: Object.entries(data).map(([label, value]) => ({ label, value, confidence: 1 })) }),
  };
}

test("books: with a reasons list, 3212 is queued once (from the list) and must equal the Books' personal add-back", () => {
  const books = booksDoc({ personalAddback: 50_000, accountingDepreciation: 150_000 });
  // Without a list: the Books' add-back must equal the whole total (old rule).
  assert.throws(() => filing.buildBusinessPacket(packetInput({}, books)), /does not match the approved aggregate/);
  const p = plain(filing.buildBusinessPacket(packetInput({
    businessAddBacks: [{ code: PERSONAL, amount: 50_000 }, { code: FINE, amount: 30_000 }],
  }, books)));
  assert.equal(p.version, "business-entry-v7");
  assert.deepEqual(deductionFields(p).map((f) => [f.irisCode, f.ourAmount, f.ourCategory]), [
    [FINE, 30_000, "BUSINESS_ADD_BACK_3211"],
    [PERSONAL, 50_000, "BUSINESS_ADD_BACK_3212"],
  ]);
  assert.ok(!p.pending.some((item) => item.key === "businessInadmissibleExpenses"));
  // 3088 is typed from the Books, so IRIS adds 3238 itself: 3239 = 80,000 + 150,000.
  assert.equal(row(p, "3239").expected, 230_000);
  assert.match(row(p, "3239").formula, /3211 \+ 3212 \+ 3238/);
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessAddBacks: [{ code: FINE, amount: 80_000 }] }, books)),
    /Business Books show a personal-expenditure add-back of PKR 50,000, but the reasons list .* has PKR 0/,
  );
});

// ---------------------------------------------------------------------------
// Expectations for the rows IRIS computes on this tab
// ---------------------------------------------------------------------------
const field = (irisCode, ourAmount, section) => ({
  irisCode, ourAmount, section, ourCategory: "T", ourDescription: "T", irisDescription: "T",
  portalArea: "Business", column: "Total Amount", isTaxField: false, sourceEntryCount: 1,
});
const T = "Manufacturing/ Trading Items";
const D = "Inadmissible/Admissible Deductions";
const O = "Other Revenues";
const base = () => [field("3009", 6_000_000, T), field("3059", 2_000_000, T)];
const build = (fields, extra = {}) =>
  plain(expectations.buildExpectedIrisTotals({ fields, incomeSources: ["business"], assetCodes: [], liabilityCodes: [], ...extra }));
const r = (out, code) => out.rows.find((x) => x.code === code);

test("expectations: 3259 counts tax depreciation (3248) and IRIS's own gain rows; never a proven 0 then", () => {
  const plainRun = build(base());
  assert.equal(r(plainRun, "3259").expected, 0);
  assert.equal(r(plainRun, "3259").proven, true, "seen as 0 on the live run");
  assert.equal(r(plainRun, "3270").formula, "3200 + 3239 \u2212 3259");

  const dep = build(base(), { depreciationDeduction: 150_000 });
  assert.equal(r(dep, "3259").expected, 150_000);
  assert.equal(r(dep, "3259").formula, "3248");
  assert.equal(r(dep, "3259").proven, false);
  assert.equal(r(dep, "3270").expected, 4_000_000, "before adjustment of admissible depreciation");
  assert.equal(r(dep, "3270").formula, "3200 + 3239 \u2212 (3259 \u2212 3248)");
  assert.equal(r(dep, "3000").expected, 3_850_000);
  assert.equal(r(dep, "3000").formula, "3270 \u2212 3248");

  const gain = build([...base(), field("3116", 40_000, O)]);
  assert.equal(r(gain, "3129").expected, 40_000);
  assert.equal(r(gain, "3259").expected, 40_000);
  assert.equal(r(gain, "3259").formula, "3246 (= 3116)");
  assert.equal(r(gain, "3270").expected, 4_000_000, "the accounting gain is taken out again");
  assert.equal(r(gain, "3270").proven, false);
});

test("expectations: typed add-back, disposal and unabsorbed-depreciation rows", () => {
  const out = build([
    ...base(),
    field(FINE, 30_000, D),
    field("3226", 50_000, D), // tax gain on assets sold
    field("3256", 20_000, D), // tax loss on assets sold
    field("3258", 100_000, D), // unabsorbed depreciation of earlier years
  ], { depreciationDeduction: 150_000 });
  assert.equal(r(out, "3239").expected, 80_000);
  assert.equal(r(out, "3259").expected, 20_000 + 100_000 + 150_000);
  assert.equal(r(out, "3259").formula, "3256 + 3258 + 3248");
  // 3270 = 4,000,000 + 80,000 - 20,000 (depreciation rows are adjusted after 3270)
  assert.equal(r(out, "3270").expected, 4_060_000);
  assert.equal(r(out, "3270").formula, "3200 + 3239 \u2212 (3259 \u2212 3248 \u2212 3258)");
  assert.equal(r(out, "3000").expected, 4_060_000 - 150_000 - 100_000);
  assert.equal(r(out, "3000").formula, "3270 \u2212 3248 \u2212 3258");
  for (const code of ["3239", "3259", "3270", "3000", "9100"]) assert.equal(r(out, code)?.proven ?? false, false, code);
  // A code the packet never queues on this tab stays unknown.
  const unknown = build([...base(), field("3213", 5_000, D)]);
  assert.ok(unknown.skipped.some((s) => s.code === "3239" && /3213/.test(s.reason)));
});

// ---------------------------------------------------------------------------
// Item 2: tax gain / loss on business assets sold (s.22(8)) -> 3226 / 3256
// ---------------------------------------------------------------------------
const sales = require(path.join(root, "lib/tax/business-asset-sales.ts"));
const profit = require(path.join(root, "lib/tax/business-profit.ts"));
const depSchedule = require(path.join(root, "lib/tax/business-depreciation-schedule.ts"));
// Building row 330205: WDV 1,200,000; sold part with tax WDV 200,000 for 250,000 -> tax gain 50,000.
const GAIN_SALE = [{ code: "330205", wdvBroughtForward: 1_200_000, deletion: 200_000, deletionSalePrice: 250_000 }];
// Plant row 33030105: WDV 1,000,000; sold part with tax WDV 300,000 for 260,000 -> tax loss 40,000.
const LOSS_SALE = [{ code: "33030105", wdvBroughtForward: 1_000_000, deletion: 300_000, deletionSalePrice: 260_000 }];

test("asset sales: answers are read as given, must sit inside their figures, rows and text are exact", () => {
  assert.equal(sales.scheduleHasSale(GAIN_SALE), true);
  assert.equal(sales.scheduleHasSale([{ code: "330205", wdvBroughtForward: 5 }]), false);
  assert.deepEqual(plain(sales.readAssetSaleAnswers({ businessAssetSaleBookGain: 0 })), { bookGain: 0, bookLoss: null });
  assert.deepEqual(sales.validateAssetSaleAnswers({ bookGain: 20_000, bookLoss: 0 }, { otherRevenue: 120_000, operatingExpenses: 1 }), []);
  assert.match(sales.validateAssetSaleAnswers({ bookGain: 200_000, bookLoss: null }, { otherRevenue: 120_000, operatingExpenses: 0 })[0], /more than "Other business receipts"/);
  assert.match(sales.validateAssetSaleAnswers({ bookGain: null, bookLoss: 5 }, { otherRevenue: 0, operatingExpenses: null })[0], /more than "Business expenses"/);
  assert.equal(ab.findDeductionRow(sales.TAX_GAIN_ON_ASSETS_ROW).label, "Add Backs Tax Gain on Sale of Assets");
  assert.equal(ab.findDeductionRow(sales.TAX_LOSS_ON_ASSETS_ROW).label, "Tax (Loss) on Sale of Assets");
  assert.equal(contract.business_other_revenues.rows[sales.BOOK_GAIN_ON_ASSETS_ROW].label, "Accounting Gain on Sale of Assets");
  // Per-asset rules shown next to the rows (s.22(10), s.22(13)(b)/(d)).
  assert.match(depSchedule.DEPRECIATION_ROW_HINTS["3304105"], /sale price x 7,500,000 \/ its cost \(s\.22\(10\)\)/);
  assert.match(depSchedule.DEPRECIATION_ROW_HINTS["330205"], /without the land, and at most what the building cost you \(s\.22\(13\)\(d\)\)/);
});

test("estimate: the accounting profit / loss already in the P&L is taken out; the tax gain / loss counts once", () => {
  const base = { ...VALUES, businessDepreciationSchedule: GAIN_SALE };
  const noAnswer = profit.computeBusinessProfit(base);
  const answered = profit.computeBusinessProfit({ ...base, businessAssetSaleBookGain: 30_000, businessAssetSaleBookLoss: 0 });
  assert.equal(noAnswer.disposalResult, 50_000);
  assert.equal(answered.assetSaleBookGain, 30_000);
  assert.equal(answered.profitBeforeLossRelief, noAnswer.profitBeforeLossRelief - 30_000);
  const loss = profit.computeBusinessProfit({ ...VALUES, businessDepreciationSchedule: LOSS_SALE, businessAssetSaleBookGain: 0, businessAssetSaleBookLoss: 25_000 });
  const lossNoBook = profit.computeBusinessProfit({ ...VALUES, businessDepreciationSchedule: LOSS_SALE });
  assert.equal(loss.disposalResult, -40_000);
  assert.equal(loss.profitBeforeLossRelief, lossNoBook.profitBeforeLossRelief + 25_000);
  // Stale answers without a sale change nothing.
  const stale = profit.computeBusinessProfit({ ...VALUES, businessAssetSaleBookGain: 99_000, businessAssetSaleBookLoss: 99_000 });
  assert.equal(stale.profitBeforeLossRelief, profit.computeBusinessProfit(VALUES).profitBeforeLossRelief);
  assert.equal(stale.assetSaleBookGain, 0);
});

test("packet: with both answers the tax gain goes to 3226 (v7), the manual item is gone; a book gain stays a 3116 item", () => {
  const unanswered = plain(filing.buildBusinessPacket(packetInput({ businessDepreciationSchedule: GAIN_SALE })));
  assert.ok(unanswered.pending.some((item) => item.key === "businessDisposalGainLoss"));
  assert.ok(!deductionFields(unanswered).length);
  const p = plain(filing.buildBusinessPacket(packetInput({
    businessDepreciationSchedule: GAIN_SALE, businessAssetSaleBookGain: 30_000, businessAssetSaleBookLoss: 0,
  })));
  assert.equal(p.version, "business-entry-v7");
  assert.deepEqual(deductionFields(p).map((f) => [f.irisCode, f.ourAmount, f.ourCategory, f.column]), [
    ["3226", 50_000, "BUSINESS_TAX_GAIN_ON_ASSETS_SOLD", "Total Amount"],
  ]);
  assert.ok(!p.pending.some((item) => item.key === "businessDisposalGainLoss"));
  const bookGain = p.pending.find((item) => item.key === "businessAssetSaleBookGain");
  assert.equal(bookGain.amount, 30_000);
  assert.match(bookGain.reason, /3116 "Accounting Gain on Sale of Assets"/);
  assert.ok(!p.pending.some((item) => item.key === "businessAssetSaleBookLoss"));
  assert.equal(p.computedEstimate.taxableIncome, unanswered.computedEstimate.taxableIncome - 30_000);
  // IRIS from the typed rows: 3239 = 3226 (no Books, so no 3088 / 3238).
  assert.equal(row(p, "3239").expected, 50_000);
  assert.equal(row(p, "3239").proven, false);
});

test("packet: a tax loss goes to 3256 and a book loss becomes a 3196 item; answers above their figure stop the packet", () => {
  const p = plain(filing.buildBusinessPacket(packetInput({
    businessDepreciationSchedule: LOSS_SALE, businessAssetSaleBookGain: 0, businessAssetSaleBookLoss: 25_000,
  })));
  assert.equal(p.version, "business-entry-v7");
  assert.deepEqual(deductionFields(p).map((f) => [f.irisCode, f.ourAmount]), [["3256", 40_000]]);
  const bookLoss = p.pending.find((item) => item.key === "businessAssetSaleBookLoss");
  assert.equal(bookLoss.amount, 25_000);
  assert.match(bookLoss.reason, /Accounting \(Loss\) on Sale of Assets" \(3196\)/);
  // 3259 = 3256 + 3248 (tax depreciation on the 700,000 left: 15% = 105,000).
  assert.equal(row(p, "3259").expected, 40_000 + 105_000);
  assert.equal(row(p, "3259").formula, "3256 + 3248");
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessDepreciationSchedule: LOSS_SALE, businessAssetSaleBookGain: 500_000, businessAssetSaleBookLoss: 0 })),
    /more than "Other business receipts"/,
  );
});

test("packet + Books: the Books' 3116 must equal the book-gain answer; then no 3116 item is added", () => {
  const books = booksDoc({ assetGain: 30_000, scrap: 90_000 });
  const ok = plain(filing.buildBusinessPacket(packetInput({
    businessDepreciationSchedule: GAIN_SALE, businessAssetSaleBookGain: 30_000, businessAssetSaleBookLoss: 0,
  }, books)));
  assert.ok(ok.fields.some((f) => f.irisCode === "3116" && f.ourAmount === 30_000));
  assert.ok(ok.fields.some((f) => f.irisCode === "3226" && f.ourAmount === 50_000));
  assert.ok(!ok.pending.some((item) => item.key === "businessAssetSaleBookGain"));
  // IRIS takes 3116 out again itself (3246): 3259 = 3248 (10% of the building's
  // 1,000,000 left = 100,000) + 3246 (= 3116, 30,000).
  assert.equal(row(ok, "3259").expected, 100_000 + 30_000);
  assert.equal(row(ok, "3259").formula, "3248 + 3246 (= 3116)");
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessDepreciationSchedule: GAIN_SALE, businessAssetSaleBookGain: 0, businessAssetSaleBookLoss: 0 }, books)),
    /Business Books show a gain on sale of assets of PKR 30,000 \(IRIS 3116\).*Make them the same/,
  );
});

test("wizard sanitizer keeps the two answers as numbers", () => {
  const kept = subs.parsePersistedSelectionUserDetails(JSON.stringify({ userDetails: { businessGrossSales: 1, businessAssetSaleBookGain: 0, businessAssetSaleBookLoss: 25_000 } }));
  assert.equal(kept.businessAssetSaleBookGain, 0);
  assert.equal(kept.businessAssetSaleBookLoss, 25_000);
  const bad = subs.resolveTy2026IncomeSelections({
    incomeSources: ["business"],
    selections: [{ source: "business", subcategory: "profit-return", details: { businessGrossSales: 100, businessAssetSaleBookGain: -1 } }],
  });
  assert.equal(bad.success, false);
});

// ---------------------------------------------------------------------------
// Item 3 (3d): losses by year (327021-327025) and unabsorbed depreciation (3258)
// ---------------------------------------------------------------------------
const lr = require(path.join(root, "lib/tax/business-loss-rules.ts"));

test("loss rules: IRIS years 2021-2025, row codes, list checks against the total", () => {
  assert.deepEqual([...lr.irisLossYears(2026)], [2021, 2022, 2023, 2024, 2025]);
  for (const year of lr.irisLossYears(2026)) {
    const code = lr.lossRowCode(year);
    assert.equal(contract.business_adjustments.rows[code].label, `Unadjusted (Loss) from Business for ${year}`);
    assert.equal(contract.business_adjustments.rows[code].disabled[0], false, `${code} Total Amount typable`);
  }
  assert.deepEqual(plain(lr.sanitizeBusinessLossesByYear([{ year: 2023, amount: 5 }, { year: 2024 }])), { ok: true, rows: [{ year: 2023, amount: 5 }, { year: 2024 }] });
  for (const [bad, message] of [["x", /must be a list/], [[{ year: "2023" }], /tax year of a loss/], [[{ year: 2023, amount: 1.5 }], /whole rupees/], [Array.from({ length: 7 }, (_, i) => ({ year: 2019 + i })), /at most 6/]]) {
    const out = lr.sanitizeBusinessLossesByYear(bad);
    assert.equal(out.ok, false);
    assert.match(out.error, message);
  }
  const v = (rows) => lr.validateBusinessLossesByYear(rows, 2026).join(" | ");
  assert.equal(v([{ year: 2021, amount: 1 }, { year: 2025, amount: 2 }]), "");
  assert.match(v([{ year: 2026, amount: 1 }]), /only losses of earlier tax years/);
  assert.match(v([{ year: 2019, amount: 1 }]), /six tax years only/);
  assert.match(v([{ year: 2020, amount: 1 }]), /IRIS for tax year 2026 has no row for this year/);
  assert.match(v([{ year: 2023, amount: 1 }, { year: 2023, amount: 2 }]), /listed twice/);
  assert.match(v([{ year: 2023 }]), /enter the unused loss/);
  assert.deepEqual(plain(lr.compareWithLossTotal([{ year: 2023, amount: 30 }], 50)), { problems: [], remainder: 20 });
  assert.match(lr.compareWithLossTotal([{ year: 2023, amount: 60 }], 50).problems[0], /more than "Business loss brought forward"/);
});

test("set-off: earliest year first, then unabsorbed depreciation at 100% / 50%, or the taxpayer decides", () => {
  const out = lr.setOffBroughtForward({
    businessIncome: 1_000_000,
    losses: [{ year: 2024, amount: 300_000 }, { year: 2022, amount: 500_000 }],
    unabsorbedDepreciation: 400_000,
    otherIncomeHeads: false,
  });
  assert.deepEqual(out.lossSetOff.map((l) => [l.year, l.setOff, l.remaining]), [[2022, 500_000, 0], [2024, 300_000, 0]]);
  assert.equal(out.balanceAfterLosses, 200_000);
  // Business-only and below Rs 10 million: 100% (both readings agree).
  assert.equal(out.unabsorbed.rate, 1);
  assert.equal(out.unabsorbed.typable, 200_000);
  assert.equal(out.unabsorbed.remaining, 200_000);
  assert.equal(out.taxableBusinessIncome, 0);
  // Loss bigger than income: the later year keeps the rest.
  const big = lr.setOffBroughtForward({ businessIncome: 600_000, losses: [{ year: 2022, amount: 500_000 }, { year: 2024, amount: 300_000 }], unabsorbedDepreciation: 0, otherIncomeHeads: false });
  assert.deepEqual(big.lossSetOff.map((l) => [l.year, l.setOff, l.remaining]), [[2022, 500_000, 0], [2024, 100_000, 200_000]]);
  // Far above Rs 10 million even after a full set-off: 50%.
  const high = lr.setOffBroughtForward({ businessIncome: 30_000_000, losses: [], unabsorbedDepreciation: 8_000_000, otherIncomeHeads: true });
  assert.equal(high.unabsorbed.rate, 0.5);
  assert.equal(high.unabsorbed.typable, 8_000_000, "50% of 30m = 15m caps nothing here");
  const half = lr.setOffBroughtForward({ businessIncome: 30_000_000, losses: [], unabsorbedDepreciation: 20_000_000, otherIncomeHeads: false });
  assert.equal(half.unabsorbed.rate, 0.5);
  assert.equal(half.unabsorbed.typable, 15_000_000);
  // In between: the two readings differ -> not typed, estimate uses 50%.
  const mid = lr.setOffBroughtForward({ businessIncome: 14_000_000, losses: [], unabsorbedDepreciation: 8_000_000, otherIncomeHeads: false });
  assert.equal(mid.unabsorbed.ambiguous, true);
  assert.equal(mid.unabsorbed.typable, 0);
  assert.equal(mid.unabsorbed.estimateSetOff, 7_000_000);
  assert.equal(mid.unabsorbed.fullSetOff, 8_000_000);
  assert.match(lr.unabsorbedAmbiguousMessage(mid.unabsorbed), /Rs 7,000,000 \(50%\).*Rs 8,000,000 \(100%\)/);
  // Other income heads and below Rs 10 million: taxable income unknown -> taxpayer decides.
  const mixed = lr.setOffBroughtForward({ businessIncome: 2_000_000, losses: [], unabsorbedDepreciation: 500_000, otherIncomeHeads: true });
  assert.equal(mixed.unabsorbed.ambiguous, true);
  // No income: nothing set off.
  const none = lr.setOffBroughtForward({ businessIncome: -50, losses: [{ year: 2023, amount: 10 }], unabsorbedDepreciation: 10, otherIncomeHeads: false });
  assert.equal(none.totalLossSetOff, 0);
  assert.equal(none.unabsorbed.estimateSetOff, 0);
  assert.equal(none.unabsorbed.remaining, 10);
});

test("estimate: the loss total is unchanged by the list; unabsorbed depreciation lowers taxable income", () => {
  const plainEst = profit.computeBusinessProfit(VALUES);
  const listed = profit.computeBusinessProfit({ ...VALUES, businessLossesByYear: [{ year: 2023, amount: 20_000 }, { year: 2022, amount: 30_000 }] });
  assert.equal(listed.lossSetOff, plainEst.lossSetOff);
  assert.equal(listed.taxableIncome, plainEst.taxableIncome);
  assert.deepEqual(listed.lossSetOffByYear.map((l) => [l.year, l.setOff]), [[2022, 30_000], [2023, 20_000]]);
  const withU = profit.computeBusinessProfit({ ...VALUES, businessUnabsorbedDepreciation: 100_000 });
  assert.equal(withU.unabsorbedDepreciation.rate, 1);
  assert.equal(withU.taxableIncome, plainEst.taxableIncome - 100_000);
});

test("packet: losses by year are typed in 327021-327025; 3258 typed when both readings agree; a 2020 loss stops the packet", () => {
  const p = plain(filing.buildBusinessPacket(packetInput({
    businessLossesByYear: [{ year: 2024, amount: 20_000 }, { year: 2022, amount: 30_000 }],
    businessUnabsorbedDepreciation: 100_000,
  })));
  const adjustments = p.fields.filter((f) => f.section === "Adjustments");
  assert.deepEqual(adjustments.map((f) => [f.irisCode, f.ourAmount, f.column, f.irisDescription]), [
    ["327022", 30_000, "Total Amount", "Unadjusted (Loss) from Business for 2022"],
    ["327024", 20_000, "Total Amount", "Unadjusted (Loss) from Business for 2024"],
  ]);
  assert.ok(!p.pending.some((item) => item.key === "businessLossBroughtForward"));
  assert.deepEqual(deductionFields(p).map((f) => [f.irisCode, f.ourAmount, f.ourCategory]), [["3258", 100_000, "BUSINESS_UNABSORBED_DEPRECIATION"]]);
  assert.equal(p.version, "business-entry-v7");
  // IRIS from the typed rows: 3000 = 3270 - 3258; 9000 = 3000 - losses.
  assert.equal(row(p, "3000").formula, "3270 \u2212 3258");
  assert.equal(row(p, "9000").expected, row(p, "3000").expected - 50_000);
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessLossesByYear: [{ year: 2020, amount: 50_000 }] })),
    /Business losses by year: .*no row for this year/,
  );
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessLossesByYear: [{ year: 2023, amount: 60_000 }] })),
    /more than "Business loss brought forward"/,
  );
  const part = plain(filing.buildBusinessPacket(packetInput({ businessLossesByYear: [{ year: 2023, amount: 20_000 }] })));
  assert.equal(part.pending.find((item) => item.key === "businessLossBroughtForward").amount, 30_000);
});

test("packet: in the two-readings zone 3258 is not typed and the taxpayer gets both figures; super tax base adds 3258 back", () => {
  const mid = { ...VALUES, businessGrossSales: 16_150_000, businessLossBroughtForward: 0, businessUnabsorbedDepreciation: 8_000_000 };
  const p = plain(filing.buildBusinessPacket(packetInput(mid)));
  assert.ok(!deductionFields(p).some((f) => f.irisCode === "3258"));
  const item = p.pending.find((x) => x.key === "businessUnabsorbedDepreciation");
  assert.ok(item, JSON.stringify(p.pending.map((x) => x.key)));
  assert.match(item.reason, /\(50%\).*\(100%\)/);
  // Super tax (s.4C(2)(ii)): business income before unabsorbed depreciation.
  const out = build([field("3009", 200_000_000, T), field("3258", 5_000_000, D)]);
  assert.equal(out.computations.superTax.action, "TYPE");
  assert.match(out.computations.superTax.basis, /200,000,000 \(3000 \+ 3258/);
  assert.equal(out.computations.expectedBusinessIncome, 195_000_000);
});

test("books: with losses by year the Books' single loss year must equal the list's line; the list types it", () => {
  const books = booksDoc({ lossYear: 2024, ordinaryLoss: 20_000 });
  const p = plain(filing.buildBusinessPacket(packetInput({ businessLossesByYear: [{ year: 2024, amount: 20_000 }, { year: 2022, amount: 30_000 }] }, books)));
  assert.deepEqual(p.fields.filter((f) => f.section === "Adjustments").map((f) => [f.irisCode, f.ourCategory]), [
    ["327022", "BUSINESS_LOSS_BROUGHT_FORWARD_2022"],
    ["327024", "BUSINESS_LOSS_BROUGHT_FORWARD_2024"],
  ]);
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessLossesByYear: [{ year: 2022, amount: 50_000 }] }, books)),
    /Business Books show an unused loss of PKR 20,000 for tax year 2024, but the losses by year .* have PKR 0 for that year/,
  );
});

test("wizard sanitizer keeps the loss list and the unabsorbed figure", () => {
  const rows = [{ year: 2022, amount: 30_000 }];
  const kept = subs.parsePersistedSelectionUserDetails(JSON.stringify({ userDetails: { businessGrossSales: 1, businessLossesByYear: rows, businessUnabsorbedDepreciation: 5 } }));
  assert.deepEqual(plain(kept.businessLossesByYear), rows);
  assert.equal(kept.businessUnabsorbedDepreciation, 5);
  const bad = subs.resolveTy2026IncomeSelections({
    incomeSources: ["business"],
    selections: [{ source: "business", subcategory: "profit-return", details: { businessGrossSales: 100, businessLossesByYear: [{ year: "x" }] } }],
  });
  assert.equal(bad.success, false);
});
