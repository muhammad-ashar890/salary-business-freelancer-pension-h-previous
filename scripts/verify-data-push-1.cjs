"use strict";
/**
 * DP-1 (Data Push, 15-Oct-2026): asset schedule as the IRIS Depreciation tab
 * takes it (lib/tax/business-depreciation-schedule.ts).
 *
 * Expected figures are worked out by hand from ITO 2001 s.22/s.23 and the
 * Third Schedule (see lib/tax/tax-depreciation.ts for page references).
 * IRIS rows/columns: capture 11 + live census job cmv9f3gso002g13ldnhvodcvc.
 * Synthetic figures only.
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

const schedule = require(path.join(root, "lib/tax/business-depreciation-schedule.ts"));
const plain = (value) => JSON.parse(JSON.stringify(value));

const SAMPLE = [
  { code: "3304105", additionNew: 10_000_000, additionNewExtent: 100 },
  { code: "330205", wdvBroughtForward: 1_200_000, deletion: 200_000, deletionSalePrice: 250_000 },
  { code: "330308", additionNew: 400_000, additionNewExtent: 100 },
  { code: "33030105", wdvBroughtForward: 1_000_000 },
  { code: "33030305" },
];

test("sanitize: drops empty rows, keeps IRIS order, refuses malformed input", () => {
  const ok = schedule.sanitizeDepreciationSchedule(SAMPLE);
  assert.equal(ok.ok, true);
  assert.deepEqual(
    ok.rows.map((row) => row.code),
    ["330205", "33030105", "330308", "3304105"],
  );
  assert.equal(schedule.sanitizeDepreciationSchedule(undefined).ok, true);
  assert.match(schedule.sanitizeDepreciationSchedule({}).error, /list of IRIS rows/);
  assert.match(schedule.sanitizeDepreciationSchedule([{ code: "3302" }]).error, /not an IRIS Depreciation row/);
  assert.match(
    schedule.sanitizeDepreciationSchedule([{ code: "330205" }, { code: "330205" }]).error,
    /listed twice/,
  );
  assert.match(
    schedule.sanitizeDepreciationSchedule([{ code: "330205", wdvBroughtForward: 10.5 }]).error,
    /whole rupees/,
  );
  assert.match(
    schedule.sanitizeDepreciationSchedule([{ code: "330205", wdvBroughtForward: -1 }]).error,
    /zero or more/,
  );
  assert.match(
    schedule.sanitizeDepreciationSchedule([{ code: "330205", wdvBroughtForward: "5" }]).error,
    /zero or more/,
  );
});

test("validate: IRIS row rules and missing companions are reported", () => {
  const rows = schedule.sanitizeDepreciationSchedule(SAMPLE).rows;
  assert.deepEqual(schedule.validateDepreciationSchedule(rows), []);
  const bad = schedule.validateDepreciationSchedule([
    { code: "330308", wdvBroughtForward: 5, additionUsed: 10, additionUsedExtent: 100 },
    { code: "330205", wdvBroughtForward: 100, deletion: 50 },
    { code: "33030105", wdvBroughtForward: 100, deletion: 200, deletionSalePrice: 0 },
    { code: "33030305", additionNew: 1000 },
    { code: "33030405", additionUsedExtent: 50 },
    { code: "33030205", deletionSalePrice: 10 },
  ]);
  const text = bad.join("\n");
  assert.match(text, /330308\): IRIS takes only this year's new additions/);
  assert.match(text, /330308\): machinery used before in Pakistan/);
  assert.match(text, /330205\): enter what was received/);
  assert.match(text, /33030105\): Deletion \(200\) is more than WDV \(BF\) \(100\)/);
  assert.match(text, /33030305\): enter the business use \(1-100 %\) of the new addition/);
  assert.match(text, /33030405\): business use is given for an opening WDV \/ used-addition pool of 0/);
  assert.match(text, /33030205\): a sale price needs the WDV/);
  assert.equal(bad.length, 7);
});

test("engine: hand-worked figures, vehicle total is not cut by the per-vehicle cap", () => {
  const rows = schedule.sanitizeDepreciationSchedule(SAMPLE).rows;
  const result = plain(schedule.computeScheduleDepreciation(rows));
  const byCode = Object.fromEntries(result.rows.map((row) => [row.code, row]));
  // Building 10%: (1,200,000 - 200,000) x 10% = 100,000; gain 250,000 - 200,000.
  assert.equal(byCode["330205"].depreciation, 100_000);
  assert.equal(byCode["330205"].writtenDownValueCarriedForward, 900_000);
  assert.equal(byCode["330205"].disposalGain, 50_000);
  // Plant 15% on WDV 1,000,000.
  assert.equal(byCode["33030105"].depreciation, 150_000);
  assert.equal(byCode["33030105"].writtenDownValueCarriedForward, 850_000);
  // New plant: IA 25% = 100,000; 15% of 300,000 = 45,000; WDV CF 255,000.
  assert.equal(byCode["330308"].initialAllowance, 100_000);
  assert.equal(byCode["330308"].depreciation, 45_000);
  assert.equal(byCode["330308"].writtenDownValueCarriedForward, 255_000);
  // Two vehicles at 5,000,000 each: 15% of 10,000,000 (each under the 7.5m cap).
  assert.equal(byCode["3304105"].additionsNew, 10_000_000);
  assert.equal(byCode["3304105"].depreciation, 1_500_000);
  assert.equal(byCode["3304105"].writtenDownValueCarriedForward, 8_500_000);
  assert.equal(result.totals.initialAllowance, 100_000);
  assert.equal(result.totals.depreciation, 1_795_000);
  assert.equal(result.totals.deduction, 1_895_000);
  assert.deepEqual(result.issues, []);
});

test("agent fields: only typed, non-zero IRIS columns; second Extent of Use is occurrence 2", () => {
  const rows = schedule.sanitizeDepreciationSchedule(SAMPLE).rows;
  const fields = plain(schedule.buildDepreciationAgentFields(rows));
  assert.deepEqual(
    fields.map((f) => [f.irisCode, f.column, f.headerOccurrence, f.cellIndex, f.ourAmount]),
    [
      ["330205", "WDV (BF)", 1, 0, 1_200_000],
      ["330205", "Deletion", 1, 1, 200_000],
      ["330205", "Extent of Use", 1, 3, 100],
      ["33030105", "WDV (BF)", 1, 0, 1_000_000],
      ["33030105", "Extent of Use", 1, 3, 100],
      ["330308", "Addition (New)", 1, 4, 400_000],
      ["330308", "Extent of Use", 2, 5, 100],
      ["3304105", "Addition (New)", 1, 4, 10_000_000],
      ["3304105", "Extent of Use", 2, 5, 100],
    ],
  );
  assert.ok(fields.every((f) => f.key.startsWith(`depreciation.${f.irisCode}.`)));
  // The sale price is never typed: IRIS has no column for it.
  assert.ok(!fields.some((f) => f.key.endsWith("deletionSalePrice")));
});

test("first Extent: an explicit opening-pool percentage is typed and used by the engine", () => {
  const rows = schedule.sanitizeDepreciationSchedule([
    { code: "33030205", wdvBroughtForward: 800_000, additionUsedExtent: 50, additionNew: 300_000, additionNewExtent: 100 },
    { code: "3304105", wdvBroughtForward: 3_000_000, additionUsedExtent: 40 },
  ]).rows;
  assert.deepEqual(schedule.validateDepreciationSchedule(rows), []);
  const fields = plain(schedule.buildDepreciationAgentFields(rows));
  assert.deepEqual(
    fields.map((f) => [f.irisCode, f.column, f.headerOccurrence, f.cellIndex, f.ourAmount]),
    [
      ["33030205", "WDV (BF)", 1, 0, 800_000],
      ["33030205", "Extent of Use", 1, 3, 50],
      ["33030205", "Addition (New)", 1, 4, 300_000],
      ["33030205", "Extent of Use", 2, 5, 100],
      ["3304105", "WDV (BF)", 1, 0, 3_000_000],
      ["3304105", "Extent of Use", 1, 3, 40],
    ],
  );
  const result = plain(schedule.computeScheduleDepreciation(rows));
  const byCode = Object.fromEntries(result.rows.map((row) => [row.code, row]));
  // Computer: 30% x (800,000 x 50%) + 30% x 300,000 = 120,000 + 90,000.
  assert.equal(byCode["33030205"].depreciation, 210_000);
  // Vehicle: 15% x (3,000,000 x 40%).
  assert.equal(byCode["3304105"].depreciation, 180_000);
});

test("expectations: computed IRIS cells per row and the 324802 total", () => {
  const rows = schedule.sanitizeDepreciationSchedule(SAMPLE).rows;
  const expected = plain(schedule.buildDepreciationExpectations(rows));
  assert.equal(expected.total.code, "324802");
  assert.equal(expected.total.initialAllowance, 100_000);
  assert.equal(expected.total.depreciation, 1_795_000);
  assert.equal(expected.total.writtenDownValueCarriedForward, 900_000 + 850_000 + 255_000 + 8_500_000);
  assert.equal(expected.deduction, 1_895_000);
  assert.equal(expected.disposalGain, 50_000);
  assert.equal(expected.rows.length, 4);
  assert.deepEqual(schedule.DEPRECIATION_GRID_HEADINGS.length, 9);
});

// ---------------------------------------------------------------------------
// Packet, saved details and estimate (synthetic figures of the live test run)
// ---------------------------------------------------------------------------
const filing = require(path.join(root, "lib/tax/business-filing.ts"));
const scheduleFields = require(path.join(root, "lib/tax/business-schedule-fields.ts"));
const subcategories = require(path.join(root, "lib/tax/rules/ty2026/subcategories.ts"));
const businessProfit = require(path.join(root, "lib/tax/business-profit.ts"));

const VALUES = {
  businessGrossSales: 6000000, businessOtherRevenue: 120000, businessCostOfSales: 2000000,
  businessOperatingExpenses: 1000000, businessDepreciation: 150000, businessInadmissibleExpenses: 80000,
  businessLossBroughtForward: 50000, businessWithholdingDeducted: 120000, businessSalesExcludeIndirectTax: true,
};
const ANNUAL = {
  "Business Name": "SYNTHETIC TEST BUSINESS", "Tax Year": 2026, Currency: "PKR",
  "Reporting Period Start": "2025-07-01", "Reporting Period End": "2026-06-30",
  "Sales for the year": 6000000, "Other business receipts": 120000, "Cost of sales": 2000000,
  "Business expenses": 1000000, Depreciation: 150000, "Expenses that are not allowed": 80000,
  "Business loss brought forward": 50000, "Tax already deducted on business receipts": 120000,
};
const COMPONENTS = {
  openingStock: 300000, purchases: 1850000, closingStock: 300000, otherDirect: 150000, purchaseBasis: true,
  rent: 240000, salaries: 360000, utilities: 120000, transport: 100000, marketing: 80000, bankCharges: 100000,
  scrap: 120000, accountingDepreciation: 150000, lossYear: 2025, ordinaryLoss: 50000,
};
function booksDoc() {
  const data = { ...ANNUAL };
  for (const [k, v] of Object.entries(COMPONENTS)) data[scheduleFields.BUSINESS_SCHEDULE_LABELS[k]] = v;
  return {
    id: "synthetic-books",
    extractionStatus: "MAPPED",
    extractedData: JSON.stringify({ fields: Object.entries(data).map(([label, value]) => ({ label, value, confidence: 1 })) }),
  };
}
const packetInput = (extra = {}) => ({
  taxYear: 2026,
  filerType: "myself",
  incomeSources: ["business"],
  selections: [{ source: "business", subcategory: "profit-return", detailsJson: JSON.stringify({ userDetails: { ...VALUES, ...extra } }) }],
  books: [booksDoc()],
});
const PLANT = [{ code: "33030105", wdvBroughtForward: 1_000_000 }];

test("packet v3: Depreciation-tab fields, 3248 / 3000 expectations, manual item gone, estimate 3,000,000", () => {
  const before = plain(filing.buildBusinessPacket(packetInput()));
  assert.equal(before.version, "business-entry-v2");
  assert.equal(before.depreciation, null);
  assert.ok(before.pending.some((item) => item.key === "businessDepreciation"));

  const p = plain(filing.buildBusinessPacket(packetInput({ businessDepreciationSchedule: PLANT })));
  assert.equal(p.version, "business-entry-v3");
  assert.equal(p.fields.length, before.fields.length, "the Data-tab fields are unchanged");
  assert.deepEqual(
    p.depreciation.fields.map((f) => [f.irisCode, f.column, f.headerOccurrence, f.cellIndex, f.ourAmount]),
    [
      ["33030105", "WDV (BF)", 1, 0, 1_000_000],
      ["33030105", "Extent of Use", 1, 3, 100],
    ],
  );
  assert.equal(p.depreciation.expectations.deduction, 150_000);
  // 3088 is queued from the Books, so IRIS adds book depreciation back itself.
  assert.ok(!p.pending.some((item) => item.key === "businessDepreciation"));
  assert.ok(!p.pending.some((item) => item.key === "businessDisposalGainLoss"));
  // 6,120,000 - 2,000,000 - 1,000,000 - 150,000 + 150,000 + 80,000 - 150,000 = 3,050,000; less loss 50,000.
  assert.equal(p.computedEstimate.taxDepreciation, 150_000);
  assert.equal(p.computedEstimate.taxableIncome, 3_000_000);
  const rows = Object.fromEntries(p.expectedIrisTotals.rows.map((row) => [row.code, row]));
  const beforeRows = Object.fromEntries(before.expectedIrisTotals.rows.map((row) => [row.code, row]));
  // These Books queue no inadmissible row (80,000 stays manual), so IRIS's
  // typed-figure chain is 3,120,000 here; only the Depreciation tab changes it.
  assert.equal(rows["3270"].expected, beforeRows["3270"].expected);
  assert.equal(rows["3270"].expected, 3_120_000);
  assert.equal(rows["3248"].expected, 150_000);
  assert.equal(rows["3248"].proven, false);
  assert.equal(beforeRows["3248"], undefined);
  assert.equal(rows["3000"].expected, 3_120_000 - 150_000);
  assert.equal(rows["3000"].formula, "3270 \u2212 3248");
  assert.equal(rows["3000"].proven, false);
  assert.equal(rows["9100"].expected, 3_120_000 - 150_000 - 50_000);
  // Non-salaried slab at 2,920,000: 170,000 + 30% x 1,320,000 = 566,000.
  assert.equal(rows["9200"].expected, 566_000);
  assert.equal(rows["9200"].proven, false);
});

test("packet: a broken schedule stops generation; a disposal stays a manual item until the asset-sale answers are given", () => {
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessDepreciationSchedule: [{ code: "330308", wdvBroughtForward: 5 }] })),
    /Asset schedule: .*330308/,
  );
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessDepreciationSchedule: [{ code: "9999" }] })),
    /Asset schedule: Row 9999 is not an IRIS Depreciation row/,
  );
  const p = plain(filing.buildBusinessPacket(packetInput({
    businessDepreciationSchedule: [{ code: "330205", wdvBroughtForward: 1_200_000, deletion: 200_000, deletionSalePrice: 250_000 }],
  })));
  const gain = p.pending.find((item) => item.key === "businessDisposalGainLoss");
  assert.equal(gain.amount, 50_000);
  // DP-4 item 2: without the two answers on assets sold, 3226 / 3256 are not typed.
  assert.match(gain.reason, /answer how much profit or loss on these sales/);
  assert.ok(!p.fields.some((f) => ["3226", "3256"].includes(f.irisCode)));
  assert.deepEqual(p.depreciation.fields.map((f) => f.column), ["WDV (BF)", "Deletion", "Extent of Use"]);
});

test("saved details: the schedule survives save and reload; a malformed one is refused", () => {
  const ok = subcategories.resolveTy2026IncomeSelections({
    incomeSources: ["business"],
    selections: [{ source: "business", subcategory: "profit-return", details: { businessGrossSales: 100, businessDepreciationSchedule: [{ code: "33030105", wdvBroughtForward: 1000 }, { code: "330205" }] } }],
  });
  assert.equal(ok.success, true, ok.error);
  const saved = plain(ok.selections || ok.data || ok.value || ok);
  assert.match(JSON.stringify(saved), /"businessDepreciationSchedule":\[\{"code":"33030105","wdvBroughtForward":1000\}\]/);
  const bad = subcategories.resolveTy2026IncomeSelections({
    incomeSources: ["business"],
    selections: [{ source: "business", subcategory: "profit-return", details: { businessGrossSales: 100, businessDepreciationSchedule: [{ code: "33030105", wdvBroughtForward: 10.5 }] } }],
  });
  assert.equal(bad.success, false);
  assert.match(bad.error, /whole rupees/);
  const reloaded = plain(subcategories.parsePersistedSelectionUserDetails(
    JSON.stringify({ userDetails: { businessGrossSales: 100, businessDepreciationSchedule: PLANT } }),
  ));
  assert.deepEqual(reloaded.businessDepreciationSchedule, PLANT);
  const brokenStore = plain(subcategories.parsePersistedSelectionUserDetails(
    JSON.stringify({ userDetails: { businessGrossSales: 100, businessDepreciationSchedule: "x" } }),
  ));
  assert.equal(brokenStore.businessDepreciationSchedule, undefined);
});

test("estimate: computeBusinessProfit uses the saved schedule; explicit null still means none", () => {
  const withSchedule = businessProfit.computeBusinessProfit({ ...VALUES, businessDepreciationSchedule: PLANT });
  assert.equal(withSchedule.taxDepreciation, 150_000);
  assert.equal(withSchedule.taxDepreciationPending, false);
  assert.equal(withSchedule.taxableIncome, 3_000_000);
  const none = businessProfit.computeBusinessProfit({ ...VALUES, businessDepreciationSchedule: PLANT }, { depreciationSchedule: null });
  assert.equal(none.taxDepreciation, 0);
  assert.equal(none.taxableIncome, 3_150_000);
  assert.equal(businessProfit.computeBusinessProfit(VALUES).taxableIncome, 3_150_000);
});
