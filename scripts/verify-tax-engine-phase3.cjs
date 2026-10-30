"use strict";
/**
 * Phase 3a (15-Oct-2026): tax depreciation engine + IRIS-style business profit.
 *
 * Every expected figure below is worked out by hand from the Income Tax
 * Ordinance 2001 as amended up to 31.07.2025 (research/ito-2025.pdf):
 *   s.22(2) rate x WDV (p.88); s.22(5)(a) cost less initial allowance (p.89);
 *   s.22(3)/(6) business-use share, WDV as if wholly used (p.88-89);
 *   s.22(7) never above cost (p.89); s.22(8) disposals (p.90);
 *   s.22(10)/(13)(a) Rs 7.5m vehicle cap (p.90-91);
 *   s.23 + Third Schedule Part II 25% initial allowance, plant and machinery
 *   only (p.92-93, 719); Third Schedule Part I rates (p.718).
 * The IRIS rows/codes are the ones the live census read on 15-Oct-2026
 * (job cmv9f3gso002g13ldnhvodcvc). Synthetic figures only.
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
const dep = require("../lib/tax/tax-depreciation.ts");
const profit = require("../lib/tax/business-profit.ts");
const taxCalc = require("../lib/tax/tax-calculation.ts");

const one = (input) => dep.computeTaxDepreciation({ rows: [input] });
const rowOf = (result, code) => result.rows.find((r) => r.code === code);

// The repo's SYNTHETIC TEST BUSINESS figures (same as the Phase 2 suite).
const FIXTURE = {
  businessGrossSales: 6000000,
  businessOtherRevenue: 120000,
  businessCostOfSales: 2000000,
  businessOperatingExpenses: 1000000,
  businessDepreciation: 150000,
  businessInadmissibleExpenses: 80000,
  businessLossBroughtForward: 50000,
  businessWithholdingDeducted: 120000,
};

test("rows = the 12 input rows of the IRIS Depreciation tab, Third Schedule rates", () => {
  // An ordered list: number-like object keys would be re-sorted by JS.
  const expected = [
    ["330205", 10, 0],
    ["33020405", 100, 0],
    ["33030105", 15, 0],
    ["330308", 15, 25],
    ["33030205", 30, 0],
    ["33030305", 15, 0],
    ["33030405", 15, 0],
    ["33030605", 20, 0],
    ["3304105", 15, 0],
    ["3304205", 15, 0],
    ["3304305", 15, 0],
    ["3304405", 30, 0],
  ];
  assert.deepEqual(
    dep.TAX_DEPRECIATION_ROWS.map((r) => [r.code, r.ratePercent, r.initialAllowancePercent]),
    expected,
    "same codes, same order as IRIS, Third Schedule rates",
  );
  assert.equal(dep.PASSENGER_VEHICLE_COST_CAP, 7_500_000, "s.22(13)(a), FA 2022");
  assert.equal(dep.getTaxDepreciationRow("3304105").costCapPerItem, 7_500_000);
  assert.equal(dep.getTaxDepreciationRow("33020405").maxCostPerItem, 250_000);
  assert.equal(dep.getTaxDepreciationRow("324802"), null, "324802 is IRIS's computed total, not an input row");
});

test("s.22(2): rate x WDV brought forward (building 10%, plant 15%)", () => {
  const building = rowOf(one({ code: "330205", writtenDownValueBroughtForward: 1_000_000 }), "330205");
  assert.equal(building.depreciation, 100_000);
  assert.equal(building.initialAllowance, 0);
  assert.equal(building.writtenDownValueCarriedForward, 900_000);
  const plant = rowOf(one({ code: "33030105", writtenDownValueBroughtForward: 600_000 }), "33030105");
  assert.equal(plant.depreciation, 90_000);
  assert.equal(plant.writtenDownValueCarriedForward, 510_000);
});

test("s.23 + s.22(5)(a): new plant gets 25% initial allowance, then 15% on cost less the allowance, full year", () => {
  const result = one({ code: "330308", additionsNew: [{ cost: 1_000_000 }] });
  const r = rowOf(result, "330308");
  assert.equal(r.initialAllowance, 250_000);
  assert.equal(r.depreciation, 112_500, "15% x 750,000");
  assert.equal(r.writtenDownValueCarriedForward, 637_500, "750,000 - 112,500");
  assert.equal(result.totals.deduction, 362_500, "allowance + depreciation");
});

test("330308 takes only new additions; used plant gets no allowance (s.23(5)(c))", () => {
  const result = one({
    code: "330308",
    writtenDownValueBroughtForward: 500_000,
    additionsUsedInPakistan: [{ cost: 400_000 }],
    additionsNew: [{ cost: 100_000 }],
  });
  const r = rowOf(result, "330308");
  assert.equal(r.writtenDownValueBroughtForward, 0);
  assert.equal(r.additionsUsedInPakistan, 0);
  assert.equal(r.initialAllowance, 25_000);
  assert.equal(result.issues.length, 2, result.issues.join(" | "));
  assert.match(result.issues.join(" "), /only new additions/);
  assert.match(result.issues.join(" "), /s\.23\(5\)\(c\)/);
});

test("no initial allowance outside 330308: computers 30%, furniture 15%, buildings 10%", () => {
  const result = dep.computeTaxDepreciation({
    rows: [
      { code: "33030205", additionsNew: [{ cost: 200_000 }] },
      { code: "33030305", additionsNew: [{ cost: 100_000 }] },
      { code: "330205", additionsNew: [{ cost: 2_000_000 }] },
    ],
  });
  assert.equal(rowOf(result, "33030205").depreciation, 60_000);
  assert.equal(rowOf(result, "33030305").depreciation, 15_000);
  assert.equal(rowOf(result, "330205").depreciation, 200_000);
  assert.equal(result.totals.initialAllowance, 0);
  assert.equal(result.totals.deduction, 275_000);
});

test("s.22(13)(a): passenger vehicle not plying for hire capped at Rs 7.5m; for hire not capped", () => {
  const capped = rowOf(one({ code: "3304105", additionsNew: [{ cost: 10_000_000 }] }), "3304105");
  assert.equal(capped.additionsNew, 7_500_000);
  assert.equal(capped.depreciation, 1_125_000, "15% x 7.5m");
  assert.equal(capped.writtenDownValueCarriedForward, 6_375_000);
  assert.equal(capped.initialAllowance, 0, "s.23(5)(a)");
  const forHire = rowOf(one({ code: "3304205", additionsNew: [{ cost: 10_000_000 }] }), "3304205");
  assert.equal(forHire.additionsNew, 10_000_000);
  assert.equal(forHire.depreciation, 1_500_000);
  const twoCars = rowOf(
    one({ code: "3304105", additionsNew: [{ cost: 9_000_000 }, { cost: 3_000_000 }] }),
    "3304105",
  );
  assert.equal(twoCars.additionsNew, 10_500_000, "the cap is per vehicle: 7.5m + 3m");
});

test("s.22(8): disposal leaves the base, no depreciation on it, gain or loss reported", () => {
  const result = one({
    code: "330205",
    writtenDownValueBroughtForward: 1_000_000,
    disposals: [
      { writtenDownValue: 400_000, consideration: 500_000 },
      { writtenDownValue: 100_000, consideration: 70_000 },
    ],
  });
  const r = rowOf(result, "330205");
  assert.equal(r.deletion, 500_000);
  assert.equal(r.depreciation, 50_000, "10% x (1m - 0.5m)");
  assert.equal(r.writtenDownValueCarriedForward, 450_000);
  assert.equal(r.disposalGain, 100_000);
  assert.equal(r.disposalLoss, 30_000);
});

test("s.22(10): capped vehicle disposal scales the sale price by 7.5m / actual cost", () => {
  const r = rowOf(
    one({
      code: "3304105",
      writtenDownValueBroughtForward: 3_000_000,
      disposals: [{ writtenDownValue: 3_000_000, consideration: 4_000_000, actualCost: 10_000_000 }],
    }),
    "3304105",
  );
  assert.equal(r.disposalGain, 0, "4m x 7.5/10 = 3m = WDV");
  assert.equal(r.disposalLoss, 0);
  assert.equal(r.depreciation, 0);
});

test("disposals above the brought-forward value are refused with an issue", () => {
  const result = one({
    code: "33030305",
    writtenDownValueBroughtForward: 100_000,
    disposals: [{ writtenDownValue: 150_000, consideration: 0 }],
  });
  assert.equal(rowOf(result, "33030305").deletion, 100_000);
  assert.match(result.issues[0], /more than the brought-forward value/);
});

test("s.22(3)/(6): business-use share cuts the deduction, not the WDV", () => {
  const r = rowOf(
    one({ code: "33030105", writtenDownValueBroughtForward: 1_000_000, broughtForwardBusinessUsePercent: 60 }),
    "33030105",
  );
  assert.equal(r.depreciation, 90_000, "15% x 1m x 60%");
  assert.equal(r.writtenDownValueCarriedForward, 850_000, "1m - 15% x 1m");
  const n = rowOf(one({ code: "330308", additionsNew: [{ cost: 1_000_000, businessUsePercent: 50 }] }), "330308");
  assert.equal(n.initialAllowance, 250_000, "s.23 has no proportion rule [CHECK-LIVE vs IRIS]");
  assert.equal(n.depreciation, 56_250, "15% x 750,000 x 50%");
  assert.equal(n.writtenDownValueCarriedForward, 637_500);
});

test("ramp for persons with disabilities: 100%, only up to Rs 250,000 each", () => {
  const result = one({ code: "33020405", additionsNew: [{ cost: 200_000 }, { cost: 300_000 }] });
  const r = rowOf(result, "33020405");
  assert.equal(r.additionsNew, 200_000);
  assert.equal(r.depreciation, 200_000);
  assert.equal(r.writtenDownValueCarriedForward, 0);
  assert.match(result.issues[0], /above Rs 250,000/);
});

test("s.22(7): allowance + depreciation never exceed cost, WDV never negative (sweep)", () => {
  for (const rule of dep.TAX_DEPRECIATION_ROWS) {
    for (const cost of [1, 999, 100_000, 7_499_999, 12_345_678]) {
      const result = one({
        code: rule.code,
        ...(rule.acceptsUsedAdditions ? { additionsUsedInPakistan: [{ cost }] } : {}),
        additionsNew: [{ cost }],
      });
      const r = rowOf(result, rule.code);
      const counted = r.additionsNew + r.additionsUsedInPakistan;
      assert.ok(r.initialAllowance + r.depreciation <= counted, `${rule.code} cost ${cost}`);
      assert.ok(r.writtenDownValueCarriedForward >= 0, `${rule.code} cost ${cost}`);
      assert.ok(Number.isInteger(r.depreciation) && Number.isInteger(r.initialAllowance), "whole rupees");
    }
  }
});

test("hostile input: unknown/duplicate rows, negative or NaN amounts, bad business use", () => {
  const result = dep.computeTaxDepreciation({
    rows: [
      { code: "999999", writtenDownValueBroughtForward: 1_000 },
      { code: "33030105", writtenDownValueBroughtForward: -5, additionsNew: [{ cost: Number.NaN }] },
      { code: "33030105", writtenDownValueBroughtForward: 1_000_000 },
      { code: "33030305", additionsNew: [{ cost: 100_000, businessUsePercent: 150 }] },
    ],
  });
  assert.equal(result.rows.length, 2);
  assert.equal(rowOf(result, "33030105").depreciation, 0, "the duplicate row is ignored");
  assert.equal(rowOf(result, "33030305").depreciation, 0, "invalid business use: nothing deducted");
  assert.equal(rowOf(result, "33030305").writtenDownValueCarriedForward, 85_000, "WDV still moves");
  assert.equal(result.issues.length, 3, result.issues.join(" | "));
  assert.deepEqual(dep.computeTaxDepreciation(null).totals, {
    initialAllowance: 0,
    depreciation: 0,
    deduction: 0,
    disposalGain: 0,
    disposalLoss: 0,
    writtenDownValueCarriedForward: 0,
  });
});

test("totals are the sums of the rounded rows", () => {
  const result = dep.computeTaxDepreciation({
    rows: [
      { code: "330205", writtenDownValueBroughtForward: 333_333 },
      { code: "33030205", writtenDownValueBroughtForward: 111_111 },
      { code: "330308", additionsNew: [{ cost: 333_333 }] },
    ],
  });
  const sum = (key) => result.rows.reduce((t, r) => t + r[key], 0);
  assert.equal(result.totals.depreciation, sum("depreciation"));
  assert.equal(result.totals.initialAllowance, sum("initialAllowance"));
  assert.equal(result.totals.deduction, sum("depreciation") + sum("initialAllowance"));
  assert.equal(rowOf(result, "330205").depreciation, 33_333);
  assert.equal(rowOf(result, "33030205").depreciation, 33_333);
  assert.equal(rowOf(result, "330308").initialAllowance, 83_333);
});

test("D1 = (a): the fixture estimate equals live IRIS (3,150,000 / tax 635,000)", () => {
  const r = profit.computeBusinessProfit(FIXTURE);
  assert.equal(r.accountingDepreciationAddedBack, 150_000, "IRIS 3238 = 3088");
  assert.equal(r.taxDepreciation, 0);
  assert.equal(r.taxDepreciationPending, true);
  assert.equal(r.taxDepreciationDetail, null);
  assert.equal(r.profitBeforeLossRelief, 3_200_000, "= IRIS 3000");
  assert.equal(r.taxableIncome, 3_150_000, "= IRIS 9100");
  assert.equal(taxCalc.divisionIClause1Tax(r.taxableIncome), 635_000, "= IRIS 920000");
});

test("with an asset schedule the estimate deducts tax depreciation and the disposal result", () => {
  const r = profit.computeBusinessProfit(FIXTURE, {
    depreciationSchedule: {
      rows: [
        { code: "330308", additionsNew: [{ cost: 600_000 }] },
        {
          code: "33030305",
          writtenDownValueBroughtForward: 200_000,
          disposals: [{ writtenDownValue: 50_000, consideration: 80_000 }],
        },
      ],
    },
  });
  // 330308: allowance 150,000 + 15% x 450,000 = 67,500; furniture: 15% x 150,000 = 22,500.
  assert.equal(r.taxDepreciation, 240_000);
  assert.equal(r.disposalResult, 30_000);
  assert.equal(r.taxDepreciationPending, false);
  assert.equal(r.profitBeforeLossRelief, 3_200_000 - 240_000 + 30_000);
  assert.equal(r.taxableIncome, 2_940_000, "less the 50,000 loss brought forward");
});

test("no book depreciation typed: nothing pending", () => {
  const r = profit.computeBusinessProfit({ ...FIXTURE, businessDepreciation: undefined });
  assert.equal(r.taxDepreciationPending, false);
  assert.equal(r.taxableIncome, 3_150_000, "same: book depreciation never changed the tax figure");
});

test("route-aware Save wording: standard routes may save once, Services never does", () => {
  const packet = fs.readFileSync(path.join(root, "components/tax/filing/wizard-packet-step.tsx"), "utf8");
  assert.doesNotMatch(packet, /will not Calculate, Save or Submit/);
  assert.doesNotMatch(packet, /presses Save once at the end/);
  const fbr = fs.readFileSync(path.join(root, "components/tax/fbr-connect-client.tsx"), "utf8");
  assert.doesNotMatch(fbr, /will not save or submit anything/);
  assert.doesNotMatch(fbr, /approved Salary return and its\s+Salary withholding section/);
  assert.doesNotMatch(fbr, /TaxRocket does not save, calculate, pay or submit for you/);
  assert.match(fbr, /presses Save once at the end/);
  assert.match(fbr, /Save, Calculate, payment and Submit are not pressed/);
  assert.match(fbr, /The agent did not press Save in this run/);
  const step = fs.readFileSync(path.join(root, "components/tax/filing/wizard-business-profit-step.tsx"), "utf8");
  assert.match(step, /taxDepreciationPending/);
  assert.match(step, /added back/);
});
