/**
 * verify-business-profit
 *
 * Checks the Business Income (filing for yourself) feature, TY2026:
 *   1. the profit arithmetic (lib/tax/business-profit.ts);
 *   2. how the Business profit selection is validated and kept apart from the
 *      16 withholding-rate cards that "My Business" still uses;
 *   3. the tax estimate: business profit joins the individual slab, with
 *      hand-calculated amounts from Division I of Part I of the First Schedule
 *      (clause (1) for a non-salaried individual, clause (2) salaried table
 *      when salary is more than 75% of taxable income) and Section 4AB;
 *   4. wiring that cannot be exercised without a browser (source checks).
 *
 * Run with: npm run verify:business-profit
 */

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const root = path.join(__dirname, "..");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithAlias(request, ...rest) {
  if (request.startsWith("@/")) {
    request = path.join(root, request.slice(2));
  }
  return originalResolveFilename.call(this, request, ...rest);
};
Module._extensions[".ts"] = function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

let assertionCount = 0;
function equal(actual, expected, label) {
  assertionCount += 1;
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}
function ok(value, label) {
  assertionCount += 1;
  if (!value) throw new Error(`${label}: expected truthy value`);
}
function includes(source, fragment, label) {
  assertionCount += 1;
  if (!source.includes(fragment)) {
    throw new Error(`${label}: missing ${fragment}`);
  }
}
function excludes(source, fragment, label) {
  assertionCount += 1;
  if (source.includes(fragment)) {
    throw new Error(`${label}: unexpected ${fragment}`);
  }
}
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

try {
  const profit = require(path.join(root, "lib", "tax", "business-profit.ts"));
  const subcategories = require(
    path.join(root, "lib", "tax", "rules", "ty2026", "subcategories.ts"),
  );
  const { calculateTaxEstimate } = require(
    path.join(root, "lib", "tax", "tax-calculation.ts"),
  );

  // ---------------------------------------------------------------------
  // 1. Profit arithmetic
  // ---------------------------------------------------------------------
  const simple = profit.computeBusinessProfit({
    businessGrossSales: 5_000_000,
    businessOtherRevenue: 100_000,
    businessCostOfSales: 3_000_000,
    businessOperatingExpenses: 800_000,
    businessDepreciation: 100_000,
    businessInadmissibleExpenses: 50_000,
  });
  equal(simple.turnover, 5_100_000, "turnover = sales + other receipts");
  // Phase 3a (s.22): book depreciation is added back in full, as IRIS does
  // (3238 = 3088); no asset schedule, so no tax depreciation is deducted.
  equal(
    simple.profitBeforeLossRelief,
    1_350_000,
    "5.1m - 3m - 0.8m - 0.1m + 0.1m (book depreciation added back) + 0.05m",
  );
  equal(simple.taxableIncome, 1_350_000, "no loss b/f: taxable = profit");
  equal(simple.accountingDepreciationAddedBack, 100_000, "book depreciation added back");
  equal(simple.taxDepreciation, 0, "no asset schedule: no tax depreciation");
  equal(simple.taxDepreciationPending, true, "tax depreciation is shown as pending");
  equal(simple.lossCarriedForward, 0, "a profit year carries no loss");
  equal(simple.needsMinimumTaxRules, false, "5.1m turnover is below s.113");

  const withLoss = profit.computeBusinessProfit({
    businessGrossSales: 2_000_000,
    businessCostOfSales: 1_000_000,
    businessLossBroughtForward: 400_000,
  });
  equal(withLoss.lossSetOff, 400_000, "b/f loss set off in full");
  equal(withLoss.taxableIncome, 600_000, "1m profit - 0.4m loss b/f");
  equal(withLoss.broughtForwardLossRemaining, 0, "no b/f loss left");

  const partialLoss = profit.computeBusinessProfit({
    businessGrossSales: 1_000_000,
    businessCostOfSales: 700_000,
    businessLossBroughtForward: 900_000,
  });
  equal(partialLoss.lossSetOff, 300_000, "set-off is capped at the profit");
  equal(partialLoss.taxableIncome, 0, "profit fully absorbed");
  equal(partialLoss.broughtForwardLossRemaining, 600_000, "unused b/f loss");

  const lossYear = profit.computeBusinessProfit({
    businessGrossSales: 1_000_000,
    businessCostOfSales: 900_000,
    businessOperatingExpenses: 300_000,
    businessLossBroughtForward: 250_000,
  });
  equal(lossYear.profitBeforeLossRelief, -200_000, "loss year");
  equal(lossYear.taxableIncome, 0, "a loss year is never taxable");
  equal(lossYear.lossCarriedForward, 200_000, "this year's loss carries on");
  equal(lossYear.lossSetOff, 0, "b/f loss is untouched by a loss year");
  equal(lossYear.broughtForwardLossRemaining, 250_000, "b/f loss kept");

  equal(
    profit.computeBusinessProfit({ businessGrossSales: 99_999_999 })
      .needsMinimumTaxRules,
    false,
    "just under Rs 100m is outside s.113",
  );
  equal(
    profit.computeBusinessProfit({ businessGrossSales: 100_000_000 })
      .needsMinimumTaxRules,
    true,
    "Rs 100m turnover reaches s.113",
  );
  equal(
    profit.computeBusinessProfit({
      businessGrossSales: 60_000_000,
      businessOtherRevenue: 40_000_000,
    }).needsMinimumTaxRules,
    true,
    "turnover counts other business receipts",
  );

  // Hostile input never produces a negative or non-finite figure.
  const hostile = profit.computeBusinessProfit({
    businessGrossSales: -5,
    businessCostOfSales: Number.NaN,
    businessOperatingExpenses: Infinity,
  });
  equal(hostile.turnover, 0, "negative sales ignored");
  equal(hostile.taxableIncome, 0, "NaN/Infinity expenses ignored");
  equal(profit.computeBusinessProfit(undefined).taxableIncome, 0, "empty form");

  equal(profit.hasBusinessSalesFigure(undefined), false, "no details");
  equal(profit.hasBusinessSalesFigure({}), false, "empty details");
  equal(
    profit.hasBusinessSalesFigure({ businessGrossSales: 0 }),
    false,
    "zero sales is not a sales figure",
  );
  equal(
    profit.hasBusinessSalesFigure({ businessGrossSales: 1 }),
    true,
    "positive sales",
  );

  // The withholding figure never changes the profit.
  equal(
    profit.computeBusinessProfit({
      businessGrossSales: 1_000_000,
      businessWithholdingDeducted: 500_000,
    }).taxableIncome,
    1_000_000,
    "withholding is informational only",
  );

  // ---------------------------------------------------------------------
  // 2. Selection handling
  // ---------------------------------------------------------------------
  const PROFIT = subcategories.TY2026_BUSINESS_PROFIT_SUBCATEGORY;
  equal(PROFIT, "profit-return", "profit selection subcategory");

  // The 16 withholding-rate cards are unchanged and do not include it.
  const cards = subcategories.getTy2026SubcategoryOptions("business");
  equal(cards.length, 16, "business still has 16 withholding-rate cards");
  ok(
    !cards.some((card) => card.subcategory === PROFIT),
    "profit selection is not a catalog card",
  );
  ok(
    subcategories
      .getTy2026SubcategoryStepKeys(["business"], 2026)
      .includes("subcategory_business"),
    "business step key is unchanged for every flow",
  );

  const fields = subcategories.getTy2026SubcategoryDetailFields(
    "business",
    PROFIT,
  );
  equal(fields.length, 8, "eight business-profit fields");
  equal(fields[0].key, "businessGrossSales", "sales is the first field");
  equal(fields[0].required, true, "sales is required");
  ok(
    fields.slice(1).every((field) => field.required === false),
    "every other field is optional",
  );
  equal(
    subcategories.getTy2026SubcategoryDetailFields(
      "business",
      "1c-contract-other",
    ).length,
    0,
    "withholding cards still carry no extra figures",
  );

  const accepted = subcategories.resolveTy2026IncomeSelections({
    incomeSources: ["business"],
    selections: [
      {
        source: "business",
        subcategory: PROFIT,
        details: { businessGrossSales: 1_000_000, businessCostOfSales: 400_000 },
      },
    ],
  });
  ok(accepted.success, "a profit selection with figures is accepted");
  equal(
    accepted.selections[0].details.businessGrossSales,
    1_000_000,
    "figures survive validation",
  );

  const missingStep = subcategories.resolveTy2026IncomeSelections({
    incomeSources: ["business"],
    selections: [],
  });
  equal(missingStep.success, false, "business without any selection is incomplete");

  const negative = subcategories.resolveTy2026IncomeSelections({
    incomeSources: ["business"],
    selections: [
      {
        source: "business",
        subcategory: PROFIT,
        details: { businessGrossSales: -1 },
      },
    ],
  });
  equal(negative.success, false, "a negative figure is refused");

  const unknownKey = subcategories.resolveTy2026IncomeSelections({
    incomeSources: ["business"],
    selections: [
      {
        source: "business",
        subcategory: PROFIT,
        details: { businessGrossSales: 5, notAFigure: 9 },
      },
    ],
  });
  ok(unknownKey.success, "unknown keys are dropped, not fatal");
  equal(
    Object.keys(unknownKey.selections[0].details).join(","),
    "businessGrossSales",
    "only known figures are kept",
  );

  const wrongSource = subcategories.resolveTy2026IncomeSelections({
    incomeSources: ["salary"],
    selections: [{ source: "services", subcategory: PROFIT }],
    requireComplete: false,
  });
  equal(wrongSource.success, false, "profit selection under another source");
  const bogus = subcategories.resolveTy2026IncomeSelections({
    incomeSources: ["business"],
    selections: [{ source: "business", subcategory: "made-up" }],
  });
  equal(bogus.success, false, "unknown business subcategory still refused");

  // Round trip through the stored shape the draft uses.
  const stored = JSON.stringify({
    userDetails: { businessGrossSales: 750_000, businessDepreciation: 20_000 },
  });
  const parsed = subcategories.parsePersistedSelectionUserDetails(stored);
  equal(parsed.businessGrossSales, 750_000, "stored sales read back");
  equal(parsed.businessDepreciation, 20_000, "stored depreciation read back");

  ok(
    subcategories.isTy2026BusinessProfitSelection({
      source: "business",
      subcategory: PROFIT,
    }),
    "profit selection recognised",
  );
  ok(
    !subcategories.isTy2026BusinessProfitSelection({
      source: "business",
      subcategory: "sale-to-retailer",
    }),
    "a card is not the profit selection",
  );

  // ---------------------------------------------------------------------
  // 3. Tax estimate (amounts worked by hand from the First Schedule)
  // ---------------------------------------------------------------------
  const base = {
    taxYear: 2026,
    filerStatus: "ATL",
    totalIncome: 0,
    totalExpenses: 0,
    isSalariedRoute: false,
    isBankProfitRoute: false,
  };
  const estimate = (sources, extra = {}) =>
    calculateTaxEstimate({
      ...base,
      isSalariedRoute: sources.some((source) => source.route === "salary"),
      incomeSources: sources,
      ...extra,
    });
  const biz = (income) => ({ route: "business_profit", income });

  // Business only: clause (1) table.
  const b1 = estimate([biz(500_000)]);
  equal(b1.status, "ESTIMATE", "business-only estimate");
  equal(b1.taxDue, 0, "500k is inside the 0% band");

  const b2 = estimate([biz(1_000_000)]);
  equal(b2.taxDue, 60_000, "15% of (1.0m - 0.6m)");
  equal(b2.breakdown.length, 1, "one slab line");
  equal(b2.breakdown[0].route, "combined_slab", "read through the joint slab");
  ok(b2.note.includes("Business profit"), "note explains the business figure");
  ok(
    b2.note.toLowerCase().includes("estimate"),
    "the result is labelled an estimate",
  );

  equal(estimate([biz(1_400_000)]).taxDue, 130_000, "90k + 20% of 0.2m");
  equal(estimate([biz(2_000_000)]).taxDue, 290_000, "170k + 30% of 0.4m");
  equal(estimate([biz(4_000_000)]).taxDue, 970_000, "650k + 40% of 0.8m");
  equal(
    estimate([biz(12_000_000)]).taxDue,
    4_939_000,
    "1.61m + 45% of 6.4m = 4.49m, plus 10% s.4AB surcharge 449k",
  );
  equal(
    estimate([biz(12_000_000)]).breakdown[0].surcharge,
    449_000,
    "10% surcharge without salary income",
  );

  // Loss / fully absorbed profit: a valid estimate of nothing, not an error.
  const loss = estimate([biz(0)]);
  equal(loss.status, "ESTIMATE", "a business loss still gives an estimate");
  equal(loss.taxDue, 0, "no tax on a loss");
  ok(loss.note.includes("no taxable profit"), "loss note is plain");

  // Salary and business together.
  const salaryOnly = estimate([{ route: "salary", income: 1_000_000 }]);
  const salaryPlusZeroBusiness = estimate([
    { route: "salary", income: 1_000_000 },
    biz(0),
  ]);
  equal(
    salaryPlusZeroBusiness.taxDue,
    salaryOnly.taxDue,
    "salary + a loss-making business is taxed as salary alone",
  );

  // Salary 1m + business 2m: salary is 33% -> clause (1): 170k + 30% of 1.4m.
  const mixedLow = estimate([{ route: "salary", income: 1_000_000 }, biz(2_000_000)]);
  equal(mixedLow.taxDue, 590_000, "salary at or below 75% -> clause (1)");
  ok(
    mixedLow.note.includes("clause (1)"),
    "note names the non-salaried table",
  );

  // Salary 3m + business 0.5m: salary is 85.7% -> salaried table on 3.5m.
  const mixedHigh = estimate([{ route: "salary", income: 3_000_000 }, biz(500_000)]);
  const salary35 = estimate([{ route: "salary", income: 3_500_000 }]);
  equal(
    mixedHigh.taxDue,
    salary35.taxDue,
    "salary above 75% -> the salaried table on the combined income",
  );
  ok(mixedHigh.note.includes("clause (2)"), "note names the salaried table");

  // The 75% boundary is strict: exactly 75% still reads clause (1).
  const boundary = estimate([{ route: "salary", income: 3_000_000 }, biz(1_000_000)]);
  ok(boundary.note.includes("clause (1)"), "exactly 75% reads clause (1)");

  // Surcharge on a mixed return (Phase 3b decision D4): salary is 55% of
  // 11m, so the clause (1) table applies and the surcharge is 10%; the 9%
  // rate is only for the salaried table (salary above 75%).
  const mixedHighIncome = estimate([
    { route: "salary", income: 6_000_000 },
    biz(5_000_000),
  ]);
  equal(
    mixedHighIncome.breakdown[0].baseTax,
    4_040_000,
    "11m combined: 1.61m + 45% of 5.4m",
  );
  equal(
    mixedHighIncome.breakdown[0].surcharge,
    404_000,
    "10% surcharge on the clause (1) table even with salary (D4)",
  );
  ok(
    mixedHighIncome.breakdown[0].note.includes("A 10% Section 4AB surcharge") &&
      mixedHighIncome.breakdown[0].note.includes("the 9% rate is only for the salaried table"),
    "note states the 10% rate and why 9% does not apply",
  );
  // Salary above 75% of a combined income over 10m: the salaried table and 9%.
  const salariedHigh = estimate([
    { route: "salary", income: 12_000_000 },
    biz(2_000_000),
  ]);
  ok(salariedHigh.breakdown[0].note.includes("clause (2)"), "86% salary reads the salaried table");
  equal(
    salariedHigh.breakdown[0].surcharge,
    Math.round(salariedHigh.breakdown[0].baseTax * 0.09),
    "9% surcharge on the salaried table (D4)",
  );

  // Withholding handed to the engine behaves exactly as it always has.
  const withheld = estimate([biz(1_000_000)], { taxWithheld: 20_000 });
  equal(withheld.taxPayable, 40_000, "60k tax - 20k withheld");

  // Other routes are unaffected by the presence of business profit.
  const withBank = estimate([
    biz(1_000_000),
    { route: "bank_profit", income: 100_000, subcategory: "other-profit-on-debt" },
  ]);
  equal(withBank.status, "ESTIMATE", "business profit beside a flat route");
  equal(
    withBank.breakdown.find((line) => line.route === "bank_profit").taxDue,
    15_000,
    "the flat route still prices at its own 15% rate",
  );
  equal(withBank.taxDue, 75_000, "60k slab tax + 15k on profit on debt");

  // A route with no income is still refused (only business profit is exempt).
  const emptySalary = estimate([{ route: "salary", income: 0 }]);
  equal(emptySalary.status, "NEEDS_RULES", "empty salary is still refused");

  // ---------------------------------------------------------------------
  // 4. Wiring (source checks for browser-only behaviour)
  // ---------------------------------------------------------------------
  const action = read("app", "actions", "tax-calculation.ts");
  includes(
    action,
    'draft.filerType !== "my_business" && incomeSources.includes("business")',
    "calculation separates a filing for yourself from My Business",
  );
  includes(
    action,
    'if (entry.source === "business" && isMyselfBusiness) continue;',
    "the withholding-card route is skipped for a filing for yourself",
  );
  includes(action, '"business_profit"', "profit route is queued");
  includes(
    action,
    "section113Applicability({",
    "turnover of Rs 100 million or more reaches Section 113, priced by the estimate (Phase 3c)",
  );
  excludes(
    action,
    "withholdingDeducted",
    "typed business withholding is not credited by the action",
  );

  const wizard = read("components", "tax", "filing", "filing-wizard.tsx");
  includes(wizard, "<WizardBusinessProfitStep", "profit step is rendered");
  includes(
    wizard,
    'getTy2026SourceForStep(currentStepKey) === "business"',
    "profit step replaces only the business step",
  );
  includes(
    wizard,
    "hydratesAsMyself",
    "cards saved on an old draft are dropped for a filing for yourself",
  );
  includes(
    wizard,
    "stepLabelFor",
    "rail and blockers use the profit step name",
  );

  const page = read("app", "tax", "new", "page.tsx");
  includes(
    page,
    "details?: unknown;",
    "auto-save reads the declared figures of each selection",
  );
  includes(
    page,
    "{ details: selection.details as Ty2026SelectionUserDetails }",
    "auto-save passes the declared figures on to the server",
  );

  // My Business keeps pricing through the withholding cards.
  const engine = read("lib", "tax", "tax-calculation.ts");
  includes(engine, 'catalogSource: "business"', "flat business route kept");
  includes(
    engine,
    '"1c-contract-company"',
    "company contract card still priced for My Business",
  );

  // English-only user-facing text in the new component.
  const component = read(
    "components",
    "tax",
    "filing",
    "wizard-business-profit-step.tsx",
  );
  ok(!/[^\x00-\x7F\u2013\u2014\u2022]/.test(component), "ASCII/English only");

  console.log(`verify-business-profit: ${assertionCount} checks passed`);
} catch (error) {
  console.error(`verify-business-profit FAILED after ${assertionCount} checks`);
  console.error(error);
  process.exit(1);
}
