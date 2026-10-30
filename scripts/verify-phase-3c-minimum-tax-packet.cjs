"use strict";
/**
 * Phase 3c-3 (16-Oct-2026): Section 113 in the business packet and the IRIS
 * expectations (lib/tax/business-filing.ts, lib/tax/business-iris-expectations.ts).
 *
 * IRIS facts used (captures 54 / 57-60, ~/iris-business-captures):
 *   "+ Turnover" on row 999905 opens "Add Turnover Tax u/s 113";
 *   rows 923152 @0.25%, 923206 @0.50%, 923168 @0.75%, 923161 @1.25%;
 *   cells E E E D (Total Income / Subject to Final Tax / Subject to
 *   Exemption editable, Subject to Normal Tax computed).
 * What IRIS charges in 9200 with a turnover row has not been seen live, so
 * every figure that depends on it is proven: false.
 *
 * Law (research/ito-2025.pdf): s.113(1)-(3), Division IX, s.4AB, s.4C.
 * Expected figures are worked out by hand from the TY2026 non-salaried slab.
 * Synthetic data only.
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

const expect = require(path.join(root, "lib/tax/business-iris-expectations.ts"));
const filing = require(path.join(root, "lib/tax/business-filing.ts"));
const minimum = require(path.join(root, "lib/tax/minimum-tax-113.ts"));
const plain = (value) => JSON.parse(JSON.stringify(value));

const TRADING = "Manufacturing/ Trading Items";
const field = (irisCode, ourAmount, section = TRADING) => ({
  irisCode,
  ourAmount,
  section,
  irisDescription: "",
  portalArea: "Business",
  column: "Total Amount",
  isTaxField: false,
  sourceEntryCount: 1,
});
const LABEL_125 = "Turnover / Tax Chargeable u/s 113 @ 1.25%";
const plan113 = (turnover, extra = {}) => ({
  turnover,
  ratePercent: 1.25,
  irisCode: "923161",
  irisLabel: LABEL_125,
  turnoverTypable: true,
  ...extra,
});
// Sales 3009 and purchases 3039 (a cost row): taxable income = the difference.
const totals = (sales, purchases, minimumTax, incomeSources = ["business"]) =>
  plain(
    expect.buildExpectedIrisTotals({
      fields: [field("3009", sales), field("3039", purchases)],
      incomeSources,
      assetCodes: [],
      liabilityCodes: [],
      minimumTax,
    }),
  );
const rowOf = (t, code) => t.rows.find((r) => r.code === code);
const skipOf = (t, code) => t.skipped.find((r) => r.code === code);

test("3c-3: minimum tax wins (150M turnover, 3M income): turnover row TYPE, 9200 = 1,875,000 not proven", () => {
  const t = totals(150_000_000, 147_000_000, plan113(150_000_000));
  assert.equal(rowOf(t, "9100").expected, 3_000_000);
  // 170,000 + 30% x 1,400,000 = 590,000 (the 30% band was seen live, but a
  // turnover row on the tab has not been).
  assert.equal(rowOf(t, "920000").expected, 590_000);
  assert.equal(rowOf(t, "920000").proven, false);
  const c = t.computations;
  assert.equal(c.version, "computations-v1", "the agent's plan version is unchanged (turnover is an added field)");
  assert.deepEqual(
    { ...c.turnover, basis: undefined },
    {
      code: "923161",
      label: LABEL_125,
      action: "TYPE",
      value: 150_000_000,
      ratePercent: 1.25,
      minimumTax: 1_875_000,
      basis: undefined,
      message: "",
    },
  );
  assert.equal(c.minimumTaxRegime, "minimum");
  assert.equal(c.surcharge.action, "NONE", "no surcharge at 3M");
  assert.equal(rowOf(t, "9200").expected, 1_875_000);
  assert.equal(rowOf(t, "9200").proven, false);
  assert.match(rowOf(t, "9200").formula, /minimum tax 1,875,000/);
  const turnoverRow = rowOf(t, "923161");
  assert.equal(turnoverRow.column, "normal", "IRIS fills Subject to Normal Tax from Total Income");
  assert.equal(turnoverRow.expected, 150_000_000);
  assert.equal(turnoverRow.proven, false);
  assert.equal(turnoverRow.label, LABEL_125);
});

test("3c-3: minimum tax wins over tax + surcharge: the surcharge row is left empty with a message", () => {
  // 20M: 8,090,000 + 809,000 = 8,899,000 < 1.25% x 1bn = 12,500,000.
  const t = totals(1_000_000_000, 980_000_000, plan113(1_000_000_000));
  const c = t.computations;
  assert.equal(c.minimumTaxRegime, "minimum");
  assert.equal(c.surcharge.action, "USER");
  assert.equal(c.surcharge.value, 0);
  assert.equal(c.surcharge.message, expect.SURCHARGE_MINIMUM_TAX_MESSAGE);
  assert.match(c.surcharge.message, /type it yourself/, "D4: the taxpayer may type it themselves");
  assert.equal(rowOf(t, "923184").expected, 0, "TaxRocket expects the surcharge row empty");
  assert.match(rowOf(t, "923184").formula, /^left empty/);
  assert.equal(rowOf(t, "9200").expected, 12_500_000);
});

test("3c-3: normal tax wins (120M turnover, 20M income): surcharge TYPE 809,000, 9200 = 8,899,000 not proven", () => {
  const t = totals(120_000_000, 100_000_000, plan113(120_000_000));
  const c = t.computations;
  assert.equal(c.minimumTaxRegime, "normal");
  assert.equal(c.turnover.action, "TYPE");
  assert.equal(c.turnover.minimumTax, 1_500_000);
  assert.equal(c.surcharge.action, "TYPE");
  assert.equal(c.surcharge.value, 809_000);
  assert.equal(rowOf(t, "923184").expected, 809_000);
  assert.equal(rowOf(t, "923184").column, "normal", "IRIS computes surcharge in Subject to Normal Tax");
  assert.equal(rowOf(t, "9200").expected, 8_899_000);
  assert.equal(rowOf(t, "9200").proven, false);
  assert.match(rowOf(t, "9200").formula, /normal tax is higher than the minimum tax 1,500,000/);
});

test("3c-3: super tax stays on top of the minimum tax (160M income, 20bn turnover)", () => {
  // 71,090,000 + 7,109,000 = 78,199,000 < 250,000,000; 4C 1% x 160M.
  const t = totals(20_000_000_000, 19_840_000_000, plan113(20_000_000_000));
  const c = t.computations;
  assert.equal(c.minimumTaxRegime, "minimum");
  assert.equal(c.superTax.action, "TYPE");
  assert.equal(c.superTax.value, 1_600_000);
  assert.equal(rowOf(t, "9231822").expected, 1_600_000);
  assert.equal(rowOf(t, "923184").expected, 0);
  assert.equal(rowOf(t, "9200").expected, 251_600_000);
});

test("3c-3: unconfirmed sales basis: the turnover row is left to the taxpayer and 9200 is not checked", () => {
  const t = totals(150_000_000, 147_000_000, plan113(150_000_000, { turnoverTypable: false }));
  const c = t.computations;
  assert.equal(c.turnover.action, "USER");
  assert.equal(c.turnover.value, 0);
  assert.equal(c.turnover.minimumTax, 1_875_000);
  assert.match(c.turnover.message, /\+ Turnover/);
  assert.ok(c.turnover.message.includes(LABEL_125));
  assert.equal(rowOf(t, "923161"), undefined);
  assert.equal(rowOf(t, "9200"), undefined);
  assert.match(skipOf(t, "9200").reason, /left to the taxpayer/);
});

test("3c-3: other income heads or a loss: the turnover row is still planned, the regime is unknown", () => {
  const mixed = totals(150_000_000, 147_000_000, plan113(150_000_000), ["business", "salary"]);
  assert.equal(mixed.computations.turnover.action, "TYPE");
  assert.equal(mixed.computations.minimumTaxRegime, "unknown");
  assert.equal(mixed.computations.surcharge.action, "USER");
  assert.equal(mixed.computations.surcharge.message, expect.SURCHARGE_WITH_MINIMUM_TAX_USER_MESSAGE);
  assert.equal(rowOf(mixed, "920000"), undefined);
  const loss = totals(100_000_000, 110_000_000, plan113(100_000_000));
  assert.equal(loss.computations.turnover.action, "TYPE");
  assert.equal(loss.computations.turnover.value, 100_000_000);
  assert.equal(loss.computations.minimumTaxRegime, "unknown");
  assert.equal(rowOf(loss, "923161").expected, 100_000_000);
});

test("3c-3: without a Section 113 plan nothing changes (older callers keep the 100M skip)", () => {
  const t = totals(150_000_000, 147_000_000, null);
  assert.equal(t.computations.turnover, undefined);
  assert.equal(t.computations.minimumTaxRegime, undefined);
  assert.ok(t.skipped.some((s) => s.code === "920000" && /Section 113/.test(s.reason)));
  const small = totals(6_000_000, 0, undefined);
  assert.equal(rowOf(small, "9200").expected, 1_790_000);
  const mixed = totals(6_000_000, 0, undefined, ["business", "salary"]);
  assert.equal(mixed.computations.surcharge.action, "USER");
  assert.equal(mixed.computations.surcharge.message, expect.SURCHARGE_USER_MESSAGE, "3b message kept");
});

// ------------------------------------------------------------ the packet
const VALUES = {
  businessGrossSales: 6_000_000, businessOtherRevenue: 120_000, businessCostOfSales: 2_000_000,
  businessOperatingExpenses: 1_000_000, businessDepreciation: 150_000, businessInadmissibleExpenses: 80_000,
  businessLossBroughtForward: 50_000, businessWithholdingDeducted: 120_000, businessSalesExcludeIndirectTax: true,
};
const packet = (extra = {}) =>
  plain(
    filing.buildBusinessPacket({
      taxYear: 2026,
      filerType: "myself",
      incomeSources: ["business"],
      selections: [
        {
          source: "business",
          subcategory: "profit-return",
          detailsJson: JSON.stringify({ userDetails: { ...VALUES, ...extra } }),
        },
      ],
    }),
  );

test("3c-3 packet: below 100M with no earlier-year answer: a pending item, no turnover row", () => {
  const p = packet();
  const item = p.pending.find((i) => i.key === "businessTurnover100mEarlierYear");
  assert.ok(item, "the missing answer is listed");
  assert.match(item.reason, /Rs 100 million or more/);
  assert.equal(p.expectedIrisTotals.computations.turnover, undefined);
  assert.equal(p.minimumTax113, null);
  const answeredNo = packet({ businessTurnover100mEarlierYear: false });
  assert.ok(!answeredNo.pending.some((i) => i.key === "businessTurnover100mEarlierYear"));
  assert.equal(answeredNo.expectedIrisTotals.computations.turnover, undefined);
});

test("3c-3 packet: earlier-year yes, poultry: 923168 with the whole turnover; the normal tax wins", () => {
  const p = packet({ businessTurnover100mEarlierYear: true, businessMinimumTaxCategory: "poultry" });
  const c = p.expectedIrisTotals.computations;
  // Turnover = sales 6,000,000 + other receipts 120,000 (s.113(3) and the
  // Explanation: receipts from all business activities).
  assert.equal(c.turnover.code, "923168");
  assert.equal(c.turnover.label, "Turnover / Tax Chargeable u/s 113 @0.75%");
  assert.equal(c.turnover.action, "TYPE");
  assert.equal(c.turnover.value, 6_120_000);
  assert.equal(c.turnover.minimumTax, 45_900);
  // IRIS sees only the typed 3009: 6,000,000 -> 1,790,000 > 45,900.
  assert.equal(c.minimumTaxRegime, "normal");
  const row9200 = p.expectedIrisTotals.rows.find((r) => r.code === "9200");
  assert.equal(row9200.expected, 1_790_000);
  assert.equal(row9200.proven, false);
  assert.deepEqual(
    { reason: p.minimumTax113.reason, categoryId: p.minimumTax113.categoryId, minimumTax: p.minimumTax113.minimumTax },
    { reason: "earlier_year", categoryId: "poultry", minimumTax: 45_900 },
  );
});

test("3c-3 packet: 150M sales and no type picked: the default 1.25% row 923161", () => {
  const p = packet({ businessGrossSales: 150_000_000 });
  const c = p.expectedIrisTotals.computations;
  assert.equal(c.turnover.code, "923161");
  assert.equal(c.turnover.value, 150_120_000);
  assert.equal(c.turnover.minimumTax, 1_876_500);
  assert.ok(!p.pending.some((i) => i.key === "businessTurnover100mEarlierYear"), "this year's turnover decides");
  assert.equal(p.minimumTax113.reason, "turnover_this_year");
  assert.equal(p.minimumTax113.categoryId, minimum.DEFAULT_MINIMUM_TAX_CATEGORY);
});

test("3c-3 packet: unconfirmed sales basis leaves the turnover row to the taxpayer", () => {
  const p = packet({ businessGrossSales: 150_000_000, businessSalesExcludeIndirectTax: false });
  assert.equal(p.expectedIrisTotals.computations.turnover.action, "USER");
  assert.equal(p.minimumTax113.turnoverTypable, false);
});

test("3c-3 packet: a cotton ginner or an unlisted business type stops packet generation", () => {
  assert.throws(
    () => packet({ businessGrossSales: 150_000_000, businessMinimumTaxCategory: "cotton_ginner" }),
    (error) => error.message === minimum.SECTION_113_TEXT.cottonGinner,
  );
  assert.throws(
    () => packet({ businessTurnover100mEarlierYear: false, businessMinimumTaxCategory: "oil_refinery" }),
    /not one of the listed types/,
  );
  // A cotton ginner below 100M who answered no: s.113 does not reach the return.
  const p = packet({ businessTurnover100mEarlierYear: false, businessMinimumTaxCategory: "cotton_ginner" });
  assert.equal(p.minimumTax113, null);
});
