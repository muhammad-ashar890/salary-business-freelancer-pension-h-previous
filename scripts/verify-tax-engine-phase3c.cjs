"use strict";
/**
 * Phase 3c (16-Oct-2026): Section 113 minimum tax in the TY2026 estimate
 * (decisions D2 / D3).
 *
 * Law: Income Tax Ordinance 2001 as amended up to 31.07.2025
 * (research/ito-2025.pdf). Sources:
 *   s.113(1)-(3), p.235-238;
 *   First Schedule Part I, Division I clause (1) (non-salaried slab);
 *   First Schedule Part I, Division IX (p.532-533);
 *   s.4AB, p.52;
 *   s.4C, Division IIB.
 * IRIS rows: captures 54 and 57-61 (business-income-work/phase-3).
 *
 * Every expected figure below is worked out by hand from the TY2026
 * non-salaried slab:
 *   up to 600,000: 0
 *   600,000 to 1.2M: 15%
 *   1.2M to 1.6M: 90,000 + 20%
 *   1.6M to 3.2M: 170,000 + 30%
 *   3.2M to 5.6M: 650,000 + 40%
 *   above 5.6M: 1,610,000 + 45%
 *   surcharge: 10% above 10M
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
const taxCalc = require("../lib/tax/tax-calculation.ts");
const minimum = require("../lib/tax/minimum-tax-113.ts");
const businessProfit = require("../lib/tax/business-profit.ts");

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
const business = (income) => ({ route: "business_profit", income });
const m113 = (turnover, ratePercent, reason = "turnover_this_year", categoryLabel = "all other businesses") => ({
  minimumTax113: { reason, turnover, ratePercent, categoryLabel },
});

test("3c: Division IX catalogue (TY2026) and IRIS rows from captures 54/57-61", () => {
  const list = minimum.MINIMUM_TAX_CATEGORIES;
  assert.equal(list.length, 11);
  assert.equal(new Set(list.map((entry) => entry.id)).size, 11, "ids are unique");
  assert.equal(minimum.DEFAULT_MINIMUM_TAX_CATEGORY, "standard");
  assert.equal(minimum.SECTION_113_TURNOVER_THRESHOLD, 100000000);
  assert.equal(businessProfit.BUSINESS_MINIMUM_TAX_TURNOVER_THRESHOLD, 100000000);
  const byId = Object.fromEntries(list.map((entry) => [entry.id, entry]));
  assert.deepEqual(
    [byId.standard.ratePercent, byId.standard.irisCode, byId.standard.irisPickerLabel],
    [1.25, "923161", "Turnover / Tax Chargeable u/s 113 @ 1.25%"],
  );
  assert.deepEqual(
    [byId.poultry.ratePercent, byId.poultry.irisCode, byId.poultry.irisPickerLabel],
    [0.75, "923168", "Turnover / Tax Chargeable u/s 113 @0.75%"],
  );
  assert.deepEqual(
    [byId.motorcycle_dealer.ratePercent, byId.motorcycle_dealer.irisCode, byId.motorcycle_dealer.irisPickerLabel],
    [0.5, "923206", "Turnover / Tax Chargeable u/s 113 @ 0.50%"],
  );
  const quarter = list.filter((entry) => entry.ratePercent === 0.25);
  assert.deepEqual(
    quarter.map((entry) => entry.id),
    [
      "distributor_pharma_fmcg_cigarettes",
      "petroleum_agent_distributor",
      "rice_mill_dealer",
      "tier1_fmcg_retailer",
      "ecommerce",
      "used_vehicle_dealer",
      "flour_mill",
    ],
    "Division IX S.No.3 (a)-(g)",
  );
  for (const entry of quarter) {
    assert.equal(entry.irisCode, "923152");
    assert.equal(entry.irisPickerLabel, "Turnover / Tax Chargeable u/s 113 @0.25%");
  }
  assert.equal(byId.cotton_ginner.ratePercent, null, "cotton ginners are not priced (own regime)");
  assert.equal(byId.cotton_ginner.irisCode, "9012");
  for (const entry of list) {
    assert.ok(/^[\x20-\x7E]+$/.test(entry.label), `ASCII dropdown label: ${entry.label}`);
    assert.ok(entry.shortLabel && entry.law, `${entry.id} has short words and a law reference`);
  }
  assert.equal(minimum.isMinimumTaxCategoryId("flour_mill"), true);
  assert.equal(minimum.isMinimumTaxCategoryId("oil_refinery"), false, "company-only rows are not offered");
  assert.equal(minimum.getMinimumTaxCategory("nope"), null);
});

test("3c (D2): who s.113 reaches - this year's turnover or the earlier-year answer", () => {
  const reach = (turnover, answer) =>
    minimum.section113Applicability({ turnover, turnover100mEarlierYear: answer });
  assert.deepEqual(reach(100000000, undefined), {
    applies: true,
    reason: "turnover_this_year",
    needsEarlierYearAnswer: false,
  });
  assert.deepEqual(reach(250000000, false), {
    applies: true,
    reason: "turnover_this_year",
    needsEarlierYearAnswer: false,
  }, "this year's turnover decides even after a no");
  assert.deepEqual(reach(99999999, undefined), {
    applies: false,
    reason: null,
    needsEarlierYearAnswer: true,
  });
  assert.deepEqual(reach(99999999, false), { applies: false, reason: null, needsEarlierYearAnswer: false });
  assert.deepEqual(reach(5000000, true), { applies: true, reason: "earlier_year", needsEarlierYearAnswer: false });
});

test("3c: computeSection113 rounds to the rupee; carry-forward = minimum tax - Division I tax", () => {
  // 123,456,789 x 1.25% = 1,543,209.8625 -> 1,543,210.
  const higher = minimum.computeSection113({
    turnover: 123456789,
    ratePercent: 1.25,
    taxPayable: 1000000,
    divisionITax: 1000000,
  });
  assert.deepEqual(higher, {
    turnover: 123456789,
    ratePercent: 1.25,
    minimumTax: 1543210,
    taxPayable: 1000000,
    applies: true,
    topUp: 543210,
    carryForward: 543210,
  });
  // With a surcharge: tax 1,000,000 + surcharge 100,000. The top-up brings
  // the total to the minimum tax; the carry-forward base is the Division I
  // tax alone (s.113(2)(c)).
  const withSurcharge = minimum.computeSection113({
    turnover: 123456789,
    ratePercent: 1.25,
    taxPayable: 1100000,
    divisionITax: 1000000,
  });
  assert.equal(withSurcharge.topUp, 443210);
  assert.equal(withSurcharge.carryForward, 543210);
  const equal = minimum.computeSection113({
    turnover: 100000000,
    ratePercent: 1.25,
    taxPayable: 1250000,
    divisionITax: 1250000,
  });
  assert.equal(equal.applies, false, "equal tax: the normal tax stays");
  assert.equal(equal.topUp, 0);
  assert.equal(equal.carryForward, 0);
});

test("3c: 150M turnover, 3M profit - minimum tax 1,875,000 replaces 590,000", () => {
  const result = estimate([business(3000000)], m113(150000000, 1.25));
  assert.equal(result.status, "ESTIMATE");
  // 170,000 + 30% x 1,400,000 = 590,000; no surcharge at 3M.
  const slab = lineFor(result, "combined_slab");
  assert.equal(slab.taxDue, 590000);
  const top = lineFor(result, "minimum_tax");
  assert.ok(top, "a minimum_tax line is added");
  assert.equal(top.income, 0);
  assert.equal(top.taxDue, 1285000);
  assert.equal(top.surcharge, 0);
  assert.equal(top.isFinalTax, false);
  assert.deepEqual(top.appliedRuleIds, ["ITO-113-DIV-IX-TY2026"]);
  assert.equal(result.taxableIncome, 3000000, "turnover is not added to taxable income");
  assert.equal(result.taxDue, 1875000);
  assert.equal(result.assessableTaxDue, 1875000);
  assert.deepEqual(
    {
      reason: result.minimumTax113.reason,
      minimumTax: result.minimumTax113.minimumTax,
      normalTax: result.minimumTax113.normalTax,
      applies: result.minimumTax113.applies,
      topUp: result.minimumTax113.topUp,
      carryForward: result.minimumTax113.carryForward,
    },
    {
      reason: "turnover_this_year",
      minimumTax: 1875000,
      normalTax: 590000,
      applies: true,
      topUp: 1285000,
      carryForward: 1285000,
    },
  );
  assert.match(top.note, /tax years 2027 and 2028/);
  assert.ok(result.appliedRuleIds.includes("ITO-113-DIV-IX-TY2026"));
});

test("3c: 120M turnover, 6M profit - the normal tax of 1,790,000 stays", () => {
  const result = estimate([business(6000000)], m113(120000000, 1.25));
  // 1,610,000 + 45% x 400,000 = 1,790,000 >= 1.25% x 120M = 1,500,000.
  assert.equal(lineFor(result, "minimum_tax"), null);
  assert.equal(result.taxDue, 1790000);
  assert.equal(result.minimumTax113.applies, false);
  assert.equal(result.minimumTax113.minimumTax, 1500000);
  assert.equal(result.minimumTax113.normalTax, 1790000);
  assert.equal(result.minimumTax113.carryForward, 0);
  assert.match(result.note, /the normal tax stays/);
});

test("3c: surcharge band - 1bn turnover, 20M profit: top-up 3,601,000", () => {
  const result = estimate([business(20000000)], m113(1000000000, 1.25));
  // 1,610,000 + 45% x 14,400,000 = 8,090,000; surcharge 10% = 809,000.
  const slab = lineFor(result, "combined_slab");
  assert.equal(slab.baseTax, 8090000);
  assert.equal(slab.surcharge, 809000);
  assert.equal(result.minimumTax113.normalTax, 8899000);
  assert.equal(result.minimumTax113.minimumTax, 12500000);
  assert.equal(lineFor(result, "minimum_tax").taxDue, 3601000);
  assert.equal(result.taxDue, 12500000);
  assert.equal(result.minimumTax113.carryForward, 4410000, "s.113(2)(c): 12,500,000 - Division I tax 8,090,000");
  assert.equal(lineFor(result, "super_tax"), null, "4C income 20M is under 150M");
});

test("3c: the surcharge counts in the comparison (Explanation leaves out only final and 4B/4C tax)", () => {
  // 12M profit: 1,610,000 + 45% x 6,400,000 = 4,490,000 + surcharge 449,000
  // = 4,939,000. Minimum tax 0.25% x 1.9bn = 4,750,000 sits between the two.
  const result = estimate([business(12000000)], m113(1900000000, 0.25));
  assert.equal(result.minimumTax113.minimumTax, 4750000);
  assert.equal(result.minimumTax113.normalTax, 4939000);
  assert.equal(result.minimumTax113.applies, false);
  assert.equal(lineFor(result, "minimum_tax"), null);
  assert.equal(result.taxDue, 4939000);
});

test("3c: loss year - minimum tax is the whole tax", () => {
  const result = estimate([business(0)], m113(100000000, 0.25));
  assert.equal(result.status, "ESTIMATE");
  assert.equal(result.minimumTax113.normalTax, 0);
  assert.equal(lineFor(result, "minimum_tax").taxDue, 250000);
  assert.equal(result.taxDue, 250000);
  assert.equal(result.minimumTax113.carryForward, 250000, "no tax payable: the whole amount carries forward");
});

test("3c (D2 yes): earlier-year turnover - 50M at 0.75% on a 1M profit", () => {
  // 15% x 400,000 = 60,000; 0.75% x 50M = 375,000.
  const result = estimate([business(1000000)], m113(50000000, 0.75, "earlier_year", "poultry"));
  assert.equal(result.minimumTax113.reason, "earlier_year");
  assert.equal(result.minimumTax113.normalTax, 60000);
  assert.equal(lineFor(result, "minimum_tax").taxDue, 315000);
  assert.equal(result.taxDue, 375000);
  assert.match(result.minimumTax113.note, /0\.75% \(poultry\)/);
});

test("3c: final-tax lines stay out of the comparison (Explanation (a))", () => {
  const result = estimate(
    [business(3000000), { route: "bank_profit", income: 1000000, subcategory: "bank-or-financial-institution-deposit" }],
    m113(150000000, 1.25),
  );
  const bankLine = lineFor(result, "bank_profit");
  assert.ok(bankLine && bankLine.isFinalTax, "profit on debt is a final-tax line here");
  assert.equal(result.minimumTax113.normalTax, 590000, "only the business slab tax is compared");
  assert.equal(lineFor(result, "minimum_tax").taxDue, 1285000);
  assert.equal(result.assessableTaxDue, 1875000);
  assert.equal(result.taxDue, 1875000 + bankLine.taxDue);
});

test("3c: super tax stays out of the comparison and is still payable (Explanation (b))", () => {
  // 160M: 1,610,000 + 45% x 154,400,000 = 71,090,000; surcharge 7,109,000;
  // normal tax 78,199,000. 4C: 1% x 160M = 1,600,000. Minimum tax 1.25% x
  // 20bn = 250,000,000.
  const result = estimate([business(160000000)], m113(20000000000, 1.25));
  assert.equal(lineFor(result, "super_tax").taxDue, 1600000);
  assert.equal(result.minimumTax113.normalTax, 78199000);
  assert.equal(lineFor(result, "minimum_tax").taxDue, 171801000);
  assert.equal(result.taxDue, 250000000 + 1600000);
  assert.equal(result.minimumTax113.carryForward, 250000000 - 71090000);
  assert.equal(result.section4C.income, 160000000, "4C is worked on income, not turnover");
});

test("3c: without the s.113 input nothing changes, and 4C ignores a minimum_tax line", () => {
  const plain = estimate([business(3000000)]);
  assert.equal(plain.minimumTax113, undefined);
  assert.equal(lineFor(plain, "minimum_tax"), null);
  assert.equal(plain.taxDue, 590000);
  const lines = [
    { route: "combined_slab", rateShape: "PROGRESSIVE", income: 3000000, baseTax: 590000, surcharge: 0, taxDue: 590000, isFinalTax: false, appliedRuleIds: [], note: "" },
  ];
  const without = taxCalc.assessSection4C(lines);
  const withTop = taxCalc.assessSection4C([
    ...lines,
    { route: "minimum_tax", rateShape: "FLAT", income: 0, baseTax: 9000000, surcharge: 0, taxDue: 9000000, isFinalTax: false, appliedRuleIds: [], note: "" },
  ]);
  assert.deepEqual(withTop, without);
});

// ------------------------------------------------- 3c-2: data, action, wizard
const subs = require("../lib/tax/rules/ty2026/subcategories.ts");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const resolveBusiness = (details) =>
  subs.resolveTy2026IncomeSelections({
    incomeSources: ["business"],
    selections: [{ source: "business", subcategory: subs.TY2026_BUSINESS_PROFIT_SUBCATEGORY, details }],
  });

test("3c-2: the D2 answer and the D3 business type are saved, and bad values are refused", () => {
  const saved = resolveBusiness({
    businessGrossSales: 50000000,
    businessTurnover100mEarlierYear: true,
    businessMinimumTaxCategory: "rice_mill_dealer",
  });
  assert.equal(saved.success, true);
  assert.equal(saved.selections[0].details.businessTurnover100mEarlierYear, true);
  assert.equal(saved.selections[0].details.businessMinimumTaxCategory, "rice_mill_dealer");
  const no = resolveBusiness({ businessGrossSales: 1, businessTurnover100mEarlierYear: false });
  assert.equal(no.selections[0].details.businessTurnover100mEarlierYear, false, "a no is kept (it is an answer)");
  const badType = resolveBusiness({ businessGrossSales: 1, businessMinimumTaxCategory: "oil_refinery" });
  assert.equal(badType.success, false);
  assert.match(badType.error, /businessMinimumTaxCategory/);
  const badAnswer = resolveBusiness({ businessGrossSales: 1, businessTurnover100mEarlierYear: "yes" });
  assert.equal(badAnswer.success, false);
  assert.match(badAnswer.error, /yes\/no/);
  const empty = resolveBusiness({ businessGrossSales: 1, businessMinimumTaxCategory: "" });
  assert.equal(empty.selections[0].details.businessMinimumTaxCategory, undefined);
});

test("3c-2: both answers survive save and resume; an unlisted stored type is dropped", () => {
  const restored = subs.parsePersistedSelectionUserDetails(
    JSON.stringify({
      userDetails: {
        businessGrossSales: 120000000,
        businessTurnover100mEarlierYear: false,
        businessMinimumTaxCategory: "poultry",
      },
    }),
  );
  assert.equal(restored.businessTurnover100mEarlierYear, false);
  assert.equal(restored.businessMinimumTaxCategory, "poultry");
  const stale = subs.parsePersistedSelectionUserDetails(
    JSON.stringify({ userDetails: { businessGrossSales: 1, businessMinimumTaxCategory: "oil_refinery" } }),
  );
  assert.equal(stale.businessMinimumTaxCategory, undefined);
});

test("3c-2: the estimate action prices s.113 instead of stopping; cotton ginners and a missing answer stop", () => {
  const action = read("app", "actions", "tax-calculation.ts");
  assert.ok(!action.includes("That calculation is not available here yet"), "the old s.113 stop is gone");
  assert.ok(!action.includes("profit.needsMinimumTaxRules"), "the action no longer stops on the threshold flag");
  for (const piece of [
    "section113Applicability({",
    "turnover100mEarlierYear: profitDetails?.businessTurnover100mEarlierYear",
    "profitDetails?.businessMinimumTaxCategory ?? DEFAULT_MINIMUM_TAX_CATEGORY",
    "businessProfitProblem = SECTION_113_TEXT.earlierYearMissing;",
    "businessProfitProblem = SECTION_113_TEXT.cottonGinner;",
    "minimumTax113: minimumTax113Input",
  ])
    assert.ok(action.includes(piece), `action: ${piece}`);
  assert.match(minimum.SECTION_113_TEXT.earlierYearMissing, /Rs 100 million or more/);
  assert.match(minimum.SECTION_113_TEXT.cottonGinner, /special regime/);
});

test("3c-2: the wizard asks D2 (yes/no) and D3 (business type), ASCII only, no new number inputs", () => {
  const wizard = read("components", "tax", "filing", "wizard-business-profit-step.tsx");
  assert.ok(/^[\x00-\x7F]*$/.test(wizard), "wizard file stays ASCII");
  // DP-4 (fix53) added four number inputs in source: the amount column of the
  // "Expenses that are not allowed, by reason" table, the two answers on
  // assets sold (one mapped input), the loss-by-year amount column and the
  // unabsorbed depreciation (6 -> 10). 16-Oct: the 8 yearly figures (one
  // mapped input in source) come from the Business Books and are shown
  // read-only (10 -> 9); the business bank balance comes from the account's
  // bank statement, so its input is gone too (9 -> 8).
  assert.equal((wizard.match(/type="number"/g) || []).length, 8, "number inputs unchanged");
  assert.equal((wizard.match(/name="business-turnover-100m-earlier-year"/g) || []).length, 2, "Yes + No radios");
  for (const piece of [
    "{SECTION_113_TEXT.earlierYearQuestion} *",
    "businessTurnover100mEarlierYear: true",
    "businessTurnover100mEarlierYear: false",
    "MINIMUM_TAX_CATEGORIES.map((entry) => (",
    "details?.businessMinimumTaxCategory ?? DEFAULT_MINIMUM_TAX_CATEGORY",
    "{SECTION_113_TEXT.cottonGinner}",
    "Minimum tax on turnover (Section 113)",
  ])
    assert.ok(wizard.includes(piece), `wizard: ${piece}`);
  assert.ok(!wizard.includes("special minimum tax applies at this size"), "the old stop text is gone");
});

// ---------------------------------------------- 3c-2: the real estimate action
// Same mocking as verify-business-bank-classification.cjs: the real server
// action runs with mocked session / storage / reconciliation.
const originalLoad = Module._load;
let activeMock = null;
Module._load = function (request, parent, isMain) {
  if (activeMock) {
    if (request === "next-auth/next") return { getServerSession: async () => ({ user: { email: "synthetic@example.invalid" } }) };
    if (request === "@/lib/auth") return { authOptions: {} };
    if (request === "@/lib/prisma") return { prisma: activeMock.prisma };
    if (request === "@/app/actions/notifications") return { createNotification: async () => {} };
    if (request === "@/lib/tax/reconciliation-calculation")
      return { validateAuthoritativeReconciliation: async () => ({ success: true, preview: {} }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
async function realAction(details) {
  const draft = {
    id: "synthetic-draft",
    userId: "synthetic-user",
    taxYear: 2026,
    filerType: "myself",
    incomeSources: JSON.stringify(["business"]),
    taxWithheld: 0,
    salaryPercentage: 0,
    incomeSelections: [
      { source: "business", subcategory: "profit-return", detailsJson: JSON.stringify({ userDetails: details }) },
    ],
  };
  const ledger = [{ entryType: "INCOME", category: "BUSINESS_SALES", description: "Net sales credits", amount: 985000 }];
  const noops = new Proxy({}, { get: () => async () => ({ count: 1 }) });
  activeMock = {
    prisma: {
      user: { findUnique: async () => ({ id: draft.userId, dateOfBirth: new Date("1990-05-15") }) },
      filingDraft: { findFirst: async () => draft },
      ledgerEntry: { findMany: async () => ledger },
      document: { findFirst: async () => null },
      $transaction: async (cb) => cb({ filingDraft: noops, filingTaxCalculationLine: noops, filingPacket: noops, fbrConnection: noops }),
    },
  };
  const file = path.join(root, "app/actions/tax-calculation.ts");
  delete require.cache[file];
  try {
    return await require(file).calculateTaxAction(draft.id, "ATL");
  } finally {
    activeMock = null;
    delete require.cache[file];
  }
}

test("3c-2 real action: below 100M with no earlier-year answer, the estimate stops with the question", async () => {
  const out = await realAction({ businessGrossSales: 1000000, businessCostOfSales: 600000 });
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.status, "NEEDS_RULES");
  assert.equal(out.result.taxableIncome, null);
  assert.ok(out.result.note.includes(minimum.SECTION_113_TEXT.earlierYearMissing), out.result.note);
  const answered = await realAction({ businessGrossSales: 1000000, businessCostOfSales: 600000, businessTurnover100mEarlierYear: false });
  assert.equal(answered.result.status, "ESTIMATE");
  assert.equal(answered.result.minimumTax113, undefined);
});

test("3c-2 real action: 150M turnover is priced with the minimum tax; a cotton ginner stops", async () => {
  const out = await realAction({
    businessGrossSales: 150000000,
    businessCostOfSales: 147000000,
    businessSalesExcludeIndirectTax: true,
  });
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.result.status, "ESTIMATE", out.result.note);
  assert.equal(out.result.taxableIncome, 3000000);
  assert.equal(out.result.minimumTax113.ratePercent, 1.25, "default business type (D3)");
  assert.equal(out.result.minimumTax113.reason, "turnover_this_year");
  assert.equal(out.result.breakdown.find((line) => line.route === "minimum_tax").taxDue, 1285000);
  assert.equal(out.result.taxDue, 1875000);
  const ginner = await realAction({
    businessGrossSales: 150000000,
    businessCostOfSales: 147000000,
    businessMinimumTaxCategory: "cotton_ginner",
  });
  assert.equal(ginner.result.status, "NEEDS_RULES");
  assert.ok(ginner.result.note.includes(minimum.SECTION_113_TEXT.cottonGinner), ginner.result.note);
});
