"use strict";
/**
 * Phase 3b (16-Oct-2026): Section 4AB surcharge rate (decision D4) and
 * Section 4C super tax (decision D5) in the TY2026 estimate.
 *
 * Law: Income Tax Ordinance 2001 as amended up to 31.07.2025
 * (research/ito-2025.pdf): s.4AB and its proviso; s.4C(1)-(2); s.2(28A);
 * First Schedule Part I Division I clauses (1)/(2) and Division IIB
 * ("tax year 2026 and onwards" column, pages 516-517). Research and the D4
 * evidence: business-income-work/phase-3/D2-D5-RESEARCH-2026-10-16.md.
 * Every expected figure below is worked out by hand. Synthetic figures only.
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
const taxCalc = require("../lib/tax/tax-calculation.ts");

function estimate(sources, overrides = {}) {
  return taxCalc.calculateTaxEstimate({
    taxYear: 2026,
    filerStatus: "ATL",
    totalIncome: sources.reduce((total, source) => total + source.income, 0),
    totalExpenses: 0,
    incomeSources: sources,
    isSalariedRoute: sources.some((s) => s.route === "salary"),
    isPensionRoute: sources.some((s) => s.route === "pension"),
    isRentalRoute: sources.some((s) => s.route === "property_rent"),
    isBankProfitRoute: sources.some((s) => s.route === "bank_profit"),
    ...overrides,
  });
}
const lineFor = (result, route) => result.breakdown.find((line) => line.route === route) ?? null;
const bank = (income) => ({
  route: "bank_profit",
  income,
  subcategory: "bank-or-financial-institution-deposit",
});

// ---------------------------------------------------------------- D4 (4AB)

test("4AB rate: 9% only when salary is MORE than 75% of taxable income", () => {
  assert.equal(taxCalc.section4ABRatePercent({ salaryHeadIncome: 7_600_001, taxableIncome: 10_000_000 }), 9);
  assert.equal(taxCalc.section4ABRatePercent({ salaryHeadIncome: 7_500_000, taxableIncome: 10_000_000 }), 10, "exactly 75% is not more");
  assert.equal(taxCalc.section4ABRatePercent({ salaryHeadIncome: 1, taxableIncome: 10_000_000 }), 10, "some salary is not enough");
  assert.equal(taxCalc.section4ABRatePercent({ salaryHeadIncome: 0, taxableIncome: 10_000_000 }), 10);
  assert.equal(taxCalc.SECTION_4AB_THRESHOLD, 10_000_000);
});

test("business only, 12m: clause (1) tax and the 10% surcharge", () => {
  const r = estimate([{ route: "business_profit", income: 12_000_000 }]);
  assert.equal(r.status, "ESTIMATE");
  // Clause (1): 1,610,000 + 45% x (12,000,000 - 5,600,000) = 4,490,000.
  assert.equal(r.baseTax, 4_490_000);
  assert.equal(r.surcharge, 449_000, "10% of 4,490,000");
  assert.equal(r.taxDue, 4_939_000);
  assert.equal(r.section4C.status, "NOT_APPLICABLE");
  assert.equal(lineFor(r, "super_tax"), null);
});

test("salary 7m + business 5m (58% salary): clause (1) and 10%, not 9%", () => {
  const r = estimate([
    { route: "salary", income: 7_000_000 },
    { route: "business_profit", income: 5_000_000 },
  ]);
  assert.equal(r.baseTax, 4_490_000);
  assert.equal(r.surcharge, 449_000);
  assert.match(r.note, /A 10% Section 4AB surcharge/);
  assert.match(r.note, /the 9% rate is only for the salaried table/);
});

test("salary 13m + business 2m (86.7% salary): salaried table and 9%", () => {
  const r = estimate([
    { route: "salary", income: 13_000_000 },
    { route: "business_profit", income: 2_000_000 },
  ]);
  // Salaried table above 4.1m: 616,000 + 35% x (15,000,000 - 4,100,000) = 4,431,000.
  assert.equal(r.baseTax, 4_431_000);
  assert.equal(r.surcharge, 398_790, "9% of 4,431,000");
});

test("at 10m exactly there is no surcharge (the threshold is 'exceeds')", () => {
  const r = estimate([{ route: "business_profit", income: 10_000_000 }]);
  assert.equal(r.surcharge, 0);
});

// ------------------------------------------------------------ D5 (4C bands)

test("4C bands: the rate applies to the whole income once a floor is passed", () => {
  const cases = [
    [150_000_000, 0, 0],
    [150_000_001, 1, 1_500_000.01],
    [200_000_000, 1, 2_000_000],
    [200_000_001, 1.5, 3_000_000.015],
    [250_000_000, 1.5, 3_750_000],
    [300_000_000, 2.5, 7_500_000],
    [350_000_000, 3.5, 12_250_000],
    [400_000_000, 5.5, 22_000_000],
    [500_000_000, 7.5, 37_500_000],
    [500_000_001, 10, 50_000_000.1],
  ];
  for (const [income, rate, tax] of cases) {
    const r = taxCalc.section4CSuperTax(income);
    assert.equal(r.ratePercent, rate, `rate at ${income}`);
    assert.ok(Math.abs(r.tax - tax) < 1e-6, `tax at ${income}: ${r.tax} vs ${tax}`);
  }
  assert.equal(taxCalc.section4CSuperTax(-5).tax, 0);
});

test("4C in the estimate: business 160m adds a 1% super tax line", () => {
  const r = estimate([{ route: "business_profit", income: 160_000_000 }]);
  // Business profit is priced on the joint slab line ("combined_slab").
  // Clause (1): 1,610,000 + 45% x 154,400,000 = 71,090,000; 4AB 10% = 7,109,000.
  assert.equal(lineFor(r, "combined_slab").baseTax, 71_090_000);
  assert.equal(lineFor(r, "combined_slab").surcharge, 7_109_000);
  const superTax = lineFor(r, "super_tax");
  assert.ok(superTax, "super tax line present");
  assert.equal(superTax.taxDue, 1_600_000, "1% of 160,000,000");
  assert.equal(superTax.income, 0, "the line adds no income");
  assert.equal(superTax.isFinalTax, false);
  assert.deepEqual(superTax.appliedRuleIds, ["ITO-4C-DIV-IIB-TY2026"]);
  assert.equal(r.taxableIncome, 160_000_000, "headline income unchanged");
  assert.equal(r.baseTax, 71_090_000 + 1_600_000);
  assert.equal(r.surcharge, 7_109_000);
  assert.equal(r.taxDue, 79_799_000);
  assert.equal(r.section4C.status, "CALCULATED");
  assert.equal(r.section4C.ratePercent, 1);
  assert.equal(r.section4C.tax, 1_600_000);
  assert.match(superTax.note, /1% of the whole Section 4C income of PKR 160,000,000/);
});

test("4C: profit on debt counts as received (clause (i)), salary 149m + bank 2m", () => {
  const r = estimate([{ route: "salary", income: 149_000_000 }, bank(2_000_000)]);
  assert.equal(r.section4C.status, "CALCULATED");
  assert.equal(r.section4C.income, 151_000_000);
  assert.equal(lineFor(r, "super_tax").taxDue, 1_510_000, "1% of 151,000,000");
});

test("4C: at or below 150m there is no super tax", () => {
  const r = estimate([{ route: "salary", income: 148_000_000 }, bank(2_000_000)]);
  assert.equal(r.section4C.status, "NOT_APPLICABLE");
  assert.equal(lineFor(r, "super_tax"), null);
  const small = estimate([{ route: "salary", income: 5_000_000 }]);
  assert.equal(small.section4C.status, "NOT_APPLICABLE");
  assert.equal(small.section4C.tax, 0);
});

test("4C: a final-tax line whose imputable income could cross 150m needs the taxpayer", () => {
  // Pension under s.149(IA) is a final tax: its imputable income is not the
  // pension itself, so with salary 145m it could take 4C income above 150m.
  const r = estimate(
    [
      { route: "salary", income: 145_000_000 },
      { route: "pension", income: 8_000_000 },
    ],
    { pensionerAgeBelow70: true },
  );
  assert.equal(r.status, "ESTIMATE");
  assert.equal(lineFor(r, "pension").isFinalTax, true);
  assert.equal(r.section4C.status, "NEEDS_REVIEW");
  assert.equal(r.section4C.tax, 0);
  assert.equal(lineFor(r, "super_tax"), null, "not added when it cannot be worked out");
  assert.match(r.note, /type it yourself/);
  assert.match(r.note, /9231822/);
});

test("4C: a small final-tax line next to a small income is exactly 0", () => {
  const r = estimate(
    [
      { route: "salary", income: 5_000_000 },
      { route: "pension", income: 3_000_000 },
    ],
    { pensionerAgeBelow70: true },
  );
  assert.equal(r.section4C.status, "NOT_APPLICABLE");
});

test("imputable-income bound uses the lowest (salaried) table", () => {
  // Pension 12m: final tax 5% of the 2m above 10m = 100,000, plus the 10%
  // surcharge FBR's card charges on pension = 110,000. The salaried table
  // reaches 110,000 at 1,200,000 + (110,000 - 6,000) / 11% = 2,145,454.
  const r = estimate(
    [
      { route: "salary", income: 140_000_000 },
      { route: "pension", income: 12_000_000 },
    ],
    { pensionerAgeBelow70: true },
  );
  assert.equal(lineFor(r, "pension").baseTax, 100_000);
  assert.equal(lineFor(r, "pension").taxDue, 110_000);
  // 140m + max(12m, 2,145,454) = 152m > 150m: needs the taxpayer.
  assert.equal(r.section4C.status, "NEEDS_REVIEW");
  assert.equal(r.section4C.upperBound, 152_000_000);
});
