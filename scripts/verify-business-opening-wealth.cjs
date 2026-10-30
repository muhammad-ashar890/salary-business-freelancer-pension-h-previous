"use strict";
/**
 * 28-Oct-2026: the Wealth Statement gap was found only at the end, inside IRIS.
 * These tests pin the earlier warning (lib/tax/business-opening-wealth.ts) to the
 * operator's two real packs, so a pack that cannot reconcile is stopped at
 * Business data review instead of after an agent run.
 *
 *   old pack: closing capital 15,200,000, profit 2,000,000, drawings 1,300,000,
 *             previous return net assets 8,780,220  -> 703000 came out 14,460,000
 *   new pack: closing capital    800,000, profit 2,000,000, drawings 1,200,000,
 *             previous return net assets 8,780,220  -> 703000 is 0
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const oldResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return oldResolve.call(
    this,
    request.startsWith("@/") ? path.join(root, request.slice(2)) : request,
    ...rest,
  );
};
require.extensions[".ts"] = (m, f) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(f, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    f,
  );

const { businessOpeningWealthCheck, businessAccountingProfit } = require(
  "../lib/tax/business-opening-wealth.ts",
);

const PREVIOUS = 8_780_220;

test("the rejected pack is stopped: capital 15,200,000 against a filed 8,780,220", () => {
  const verdict = businessOpeningWealthCheck({
    closingBusinessCapital: 15_200_000,
    accountingProfit: 2_000_000,
    previousReturnNetAssets: PREVIOUS,
    previousReturnTaxYear: 2025,
    taxYear: 2026,
  });
  assert.equal(verdict.status, "impossible");
  // A floor, not a guess: 15,200,000 − 2,000,000 = 13,200,000, and the old
  // documents actually declared 14,500,000 because they also paid 1,300,000 of
  // drawings. Either way the pack is impossible against the filed 8,780,220.
  assert.equal(verdict.impliedOpeningCapital, 13_200_000);
  assert.equal(verdict.excess, 13_200_000 - PREVIOUS);
  assert.match(verdict.message, /13,200,000/);
  assert.match(verdict.message, /at least/i);
  assert.match(verdict.message, /8,780,220/);
  assert.match(verdict.message, /no filed record/i);
  assert.match(verdict.message, /No value was guessed/);
  assert.match(verdict.message, /section 116/);
});

test("the accepted pack passes: capital 800,000 (0 + 2,000,000 - 1,200,000)", () => {
  const verdict = businessOpeningWealthCheck({
    closingBusinessCapital: 800_000,
    accountingProfit: 2_000_000,
    previousReturnNetAssets: PREVIOUS,
    previousReturnTaxYear: 2025,
    taxYear: 2026,
  });
  assert.equal(verdict.status, "ok");
  assert.equal(verdict.impliedOpeningCapital, -1_200_000);
  assert.equal(verdict.previousReturnNetAssets, PREVIOUS);
});

test("a client who declared business capital last year is not blocked", () => {
  // Previous net assets 8,780,220 of which business capital 5,000,000; the pack
  // opens at that capital and closes at 5,800,000 after 2,000,000 profit and
  // 1,200,000 drawings. Nothing is impossible here.
  const verdict = businessOpeningWealthCheck({
    closingBusinessCapital: 5_800_000,
    accountingProfit: 2_000_000,
    previousReturnNetAssets: PREVIOUS,
    previousReturnTaxYear: 2025,
    taxYear: 2026,
  });
  assert.equal(verdict.status, "ok");
  assert.equal(verdict.impliedOpeningCapital, 3_800_000);
});

test("exactly equal to the filed wealth is allowed; one rupee more is not", () => {
  assert.equal(
    businessOpeningWealthCheck({
      closingBusinessCapital: PREVIOUS + 2_000_000,
      accountingProfit: 2_000_000,
      previousReturnNetAssets: PREVIOUS,
      taxYear: 2026,
    }).status,
    "ok",
  );
  assert.equal(
    businessOpeningWealthCheck({
      closingBusinessCapital: PREVIOUS + 2_000_001,
      accountingProfit: 2_000_000,
      previousReturnNetAssets: PREVIOUS,
      taxYear: 2026,
    }).status,
    "impossible",
  );
});

test("no approved previous return stays silent instead of guessing", () => {
  const verdict = businessOpeningWealthCheck({
    closingBusinessCapital: 15_200_000,
    accountingProfit: 2_000_000,
    previousReturnNetAssets: null,
    taxYear: 2026,
  });
  assert.equal(verdict.status, "unknown");
  assert.match(verdict.reason, /previous-year return/i);
});

test("a Balance Sheet without owner capital stays silent", () => {
  assert.equal(
    businessOpeningWealthCheck({
      closingBusinessCapital: null,
      accountingProfit: 2_000_000,
      previousReturnNetAssets: PREVIOUS,
      taxYear: 2026,
    }).status,
    "unknown",
  );
});

test("a loss year is never faked into a profit", () => {
  assert.equal(
    businessAccountingProfit({
      businessGrossSales: 6_000_000,
      businessOtherRevenue: 0,
      businessCostOfSales: 3_600_000,
      businessOperatingExpenses: 2_900_000,
      businessDepreciation: 0,
    }),
    -500_000,
  );
});

test("accounting profit needs every yearly figure; book depreciation is an expense", () => {
  assert.equal(
    businessAccountingProfit({
      businessGrossSales: 6_000_000,
      businessOtherRevenue: 0,
      businessCostOfSales: 3_600_000,
      businessOperatingExpenses: 400_000,
      businessDepreciation: 100_000,
    }),
    1_900_000,
  );
  assert.equal(
    businessAccountingProfit({
      businessGrossSales: 6_000_000,
      businessOtherRevenue: 0,
      businessCostOfSales: 3_600_000,
      businessOperatingExpenses: 400_000,
    }),
    null,
  );
});

test("business data review shows the issue, and the previous return is read separately", () => {
  const action = fs.readFileSync(path.join(root, "app/actions/business-intake.ts"), "utf8");
  assert.match(action, /businessOpeningWealthCheck\(/);
  assert.match(action, /key:'businessOpeningWealth'/);
  // The previous return must not join the business evidence list, whose labels
  // overlap (Tax Year, Total Assets ...).
  assert.match(action, /documentType:'previous_return'/);
  assert.ok(
    !/documentType:\{in:\['business_books','business_balance_sheet','business_support','bank_statement','previous_return'\]\}/.test(
      action,
    ),
  );
});
