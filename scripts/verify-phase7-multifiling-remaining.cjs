"use strict";
/**
 * Phase 7: Remaining Multifiling Safeguards & High-Income Business Combinations
 *   - 7A: Fail-closed Setup & Documents gating for unsupported TY2026 Myself
 *         Freelancer / Services source combinations (unsupported 3+ source
 *         combinations, non-TY2026, non-Myself), with clear UI alert.
 *   - 7B: `Salary + Business` and normal/exempt `Pension + Business` (> PKR 10M
 *         / > PKR 150M) combined Computations (`923184` 9% vs 10% 75%-salary
 *         test and `9231822` Section 4C super tax) while preserving backward
 *         compatibility when companion normal-slab figures are omitted.
 *   - 7C: `Business + Pension (final_above_10m)` and `Salary + Business +
 *         Pension (final_above_10m)` single-cell `923184` coordination across
 *         packet generation, `pension-packet-validation.ts`, `pension-guard.js`,
 *         and `iris-computations-driver.js`.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithAlias(
  request,
  parent,
  isMain,
  options,
) {
  if (request.startsWith("@/")) {
    const base = path.join(root, request.slice(2));
    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      path.join(base, "index.ts"),
      path.join(base, "index.tsx"),
    ]) {
      if (fs.existsSync(candidate)) {
        return originalResolveFilename.call(
          this,
          candidate,
          parent,
          isMain,
          options,
        );
      }
    }
    request = base;
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
const compileTs = (mod, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  mod._compile(
    ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    filename,
  );
};
require.extensions[".ts"] = compileTs;
require.extensions[".tsx"] = compileTs;

const {
  isSingleFreelancerServicesFiling,
} = require("../lib/tax/business-bank-categories.ts");
const { WizardSetupStep } = require("../components/tax/filing/wizard-setup-step.tsx");
const { calculateTaxEstimate } = require("../lib/tax/tax-calculation.ts");
const { buildBusinessPacket } = require("../lib/tax/business-filing.ts");
const { buildPortalFieldMap } = require("../lib/tax/portal-field-map.ts");
const {
  resolveFinalPensionAdditionalNormalSurcharge,
} = require("../lib/tax/non-business-computations-plan.ts");
const computationsDriver = require("../electron-connect/iris-computations-driver.js");
const { pensionEntryHold } = require("../electron-connect/pension-guard.js");
const { harness } = require("./helpers/pension-harness.cjs");

const plain = (value) => JSON.parse(JSON.stringify(value));
const rowOf = (t, code) => t.rows.find((r) => r.code === code);
const cell = (value, editable = false) => ({ value, editable });

function estimateEngine(sources, overrides = {}) {
  return calculateTaxEstimate({
    taxYear: 2026,
    filerStatus: "ATL",
    totalIncome: sources.reduce((total, s) => total + s.income, 0),
    totalExpenses: 0,
    incomeSources: sources,
    isSalariedRoute: sources.some((s) => s.route === "salary"),
    isPensionRoute: sources.some((s) => s.route === "pension"),
    isRentalRoute: sources.some((s) => s.route === "property_rent"),
    isBankProfitRoute: sources.some((s) => s.route === "bank_profit"),
    ...overrides,
  });
}

function makeBusinessPacket({
  incomeSources,
  grossSales,
  costOfSales = 0,
  companionNormalIncome = undefined,
  turnoverEarlierYear = false,
}) {
  return plain(
    buildBusinessPacket({
      taxYear: 2026,
      filerType: "myself",
      incomeSources,
      companionNormalIncome,
      selections: [
        {
          source: "business",
          subcategory: "profit-return",
          detailsJson: JSON.stringify({
            userDetails: {
              businessGrossSales: grossSales,
              businessOtherRevenue: 0,
              businessCostOfSales: costOfSales,
              businessOperatingExpenses: 0,
              businessDepreciation: 0,
              businessInadmissibleExpenses: 0,
              businessLossBroughtForward: 0,
              businessWithholdingDeducted: 0,
              businessSalesExcludeIndirectTax: true,
              businessTurnover100mEarlierYear: turnoverEarlierYear,
            },
          }),
        },
      ],
    }),
  );
}

function makeComputationsDomRows({
  business = "0",
  total = "15,000,000",
  taxable = "15,000,000",
  normal = "4,431,000",
  surchargeTotal = "",
  surchargeNormal = "",
  superTaxTotal = "",
  taxChargeable = null,
} = {}) {
  const numericNormal = Number(String(normal).replace(/,/g, "")) || 0;
  const computedChargeable =
    taxChargeable !== null ? taxChargeable : numericNormal.toLocaleString("en-US");
  return [
    {
      code: "3000",
      description: "Income / (Loss) from Business",
      cells: [cell(business), cell("0"), cell("0"), cell(business)],
    },
    {
      code: "9000",
      description: "Total Income",
      cells: [cell(total), cell("0"), cell("0"), cell(taxable)],
    },
    {
      code: "9100",
      description: "Taxable Income",
      cells: [cell("0"), cell("0"), cell("0"), cell(taxable)],
    },
    {
      code: "920000",
      description: "Normal Income Tax",
      cells: [cell("0"), cell("0"), cell("0"), cell(normal)],
    },
    {
      code: "923184",
      description: "Surcharge u/s 4AB",
      cells: [
        cell(surchargeTotal, true),
        cell("0"),
        cell("0"),
        cell(surchargeNormal),
      ],
    },
    {
      code: "9231822",
      description: "Super Tax u/s 4C",
      cells: [cell(superTaxTotal, true), cell("0"), cell("0"), cell("0")],
    },
    {
      code: "9200",
      description: "Tax Chargeable",
      cells: [
        cell(computedChargeable),
        cell("0"),
        cell("0"),
        cell(computedChargeable),
      ],
    },
  ];
}

function makeDriverHarness(rows) {
  const calls = { navigate: [], fill: [] };
  return {
    calls,
    options: {
      mode: "live",
      taxYear: 2026,
      taxpayerIdentifier: "4210112345671",
      sleep: async () => {},
      navigate: async (_w, req) => {
        calls.navigate.push(req);
        return { ok: true, status: "switched" };
      },
      snapshot: async () => rows,
      fill: async (_w, fields, options) => {
        calls.fill.push({ fields, options });
        return {
          results: fields.map((f) => ({
            key: f.key,
            irisCode: f.irisCode,
            status: "filled",
            readback: f.value,
          })),
        };
      },
    },
  };
}

test("7A: unsupported Services multi-source combinations fail closed at Setup and Documents with clear guidance", () => {
  assert.equal(
    isSingleFreelancerServicesFiling({
      taxYear: 2026,
      filerType: "myself",
      incomeSources: ["services"],
    }),
    true,
  );
  assert.equal(
    isSingleFreelancerServicesFiling({
      taxYear: 2026,
      filerType: "myself",
      incomeSources: ["salary", "services"],
    }),
    true,
  );
  assert.equal(
    isSingleFreelancerServicesFiling({
      taxYear: 2026,
      filerType: "myself",
      incomeSources: ["pension", "services"],
    }),
    true,
  );
  assert.equal(
    isSingleFreelancerServicesFiling({
      taxYear: 2026,
      filerType: "myself",
      incomeSources: ["business", "services"],
    }),
    true,
  );
  assert.equal(
    isSingleFreelancerServicesFiling({
      taxYear: 2026,
      filerType: "myself",
      incomeSources: ["salary", "business", "services"],
    }),
    true,
  );
  assert.equal(
    isSingleFreelancerServicesFiling({
      taxYear: 2026,
      filerType: "myself",
      incomeSources: ["salary", "pension", "services"],
    }),
    true,
    "Salary + Pension + Services is the supported pension twin of the Business triple",
  );
  for (const bad of [
    {
      taxYear: 2026,
      filerType: "myself",
      incomeSources: ["business", "pension", "services"],
    },
    {
      taxYear: 2026,
      filerType: "myself",
      incomeSources: ["salary", "business", "pension", "services"],
    },
    { taxYear: 2025, filerType: "myself", incomeSources: ["services"] },
    { taxYear: 2026, filerType: "my_business", incomeSources: ["services"] },
  ]) {
    assert.equal(isSingleFreelancerServicesFiling(bad), false);
  }

  const baseProps = {
    currentStepKey: "income",
    filerType: "myself",
    businessStructure: null,
    incomeSources: ["business", "services"],
    bankAccounts: [],
    taxYear: 2026,
    filerStatus: "ATL",
    residencyStatus: "resident",
    readinessCompleted: [],
    showStructureRow: false,
    needsIncomeSourceSelection: true,
    documentRequirementSummary: "3 required documents",
    requiredDocumentLabels: [],
    eligibilityRouteLabel: "TY2026 Myself",
    eligibilityRouteTone: "amanah",
    canSubmit: false,
    onFilerTypeChange: () => {},
    onBusinessStructureChange: () => {},
    onIncomeSourceToggle: () => {},
    onBankAccountsChange: () => {},
    onTaxYearChange: () => {},
    onFilerStatusChange: () => {},
    onResidencyStatusChange: () => {},
    onReadinessToggle: () => {},
  };

  const blockedHtml = renderToStaticMarkup(
    React.createElement(WizardSetupStep, {
      ...baseProps,
      unsupportedServicesSelection: true,
    }),
  );
  assert.match(blockedHtml, /data-testid="unsupported-services-income-alert"/);
  assert.match(blockedHtml, /Salary \+ Services/);
  assert.match(blockedHtml, /Pension \+ Services/);
  assert.match(blockedHtml, /Business Income/);

  const allowedHtml = renderToStaticMarkup(
    React.createElement(WizardSetupStep, {
      ...baseProps,
      incomeSources: ["pension", "services"],
      unsupportedServicesSelection: false,
    }),
  );
  assert.doesNotMatch(allowedHtml, /unsupported-services-income-alert/);

  const wizardSrc = fs.readFileSync(
    path.join(root, "components/tax/filing/filing-wizard.tsx"),
    "utf8",
  );
  assert.match(
    wizardSrc,
    /if \(currentStepKey === "income"\) \{\s*return selectedIncomeSources\.length > 0 && !unsupportedServicesSelection;\s*\}/,
  );
  assert.match(
    wizardSrc,
    /if \(currentStepKey === "tax_year"\) \{\s*return Boolean\(taxYear\) && !unsupportedServicesSelection;\s*\}/,
  );
  assert.match(wizardSrc, /if \(unsupportedServicesSelection\) return false;/);
  assert.match(
    wizardSrc,
    /if \(navigationStepKey === "documents" && unsupportedServicesSelection\)/,
  );
});

test("7B: Salary + Business > PKR 10M prices exact 9% vs 10% Section 4AB surcharge and safe Section 4C super tax", async () => {
  // 1) Backward compatibility: when companionNormalIncome is omitted, multi-head skip remains intact.
  const withoutCompanion = makeBusinessPacket({
    incomeSources: ["salary", "business"],
    grossSales: 2_000_000,
  });
  assert.equal(
    withoutCompanion.expectedIrisTotals.computations.surcharge.action,
    "USER",
  );
  assert.ok(
    withoutCompanion.expectedIrisTotals.skipped.some(
      (s) => s.code === "9100" && /other income heads/.test(s.reason),
    ),
  );

  // 2) Salary 13M + Business 2M = 15M (86.7% salary > 75% -> salaried table + 9% surcharge).
  // Salaried table above 4.1M: 616,000 + 35% x (15,000,000 - 4,100,000) = 4,431,000; 9% = 398,790.
  const engineSalaried = estimateEngine([
    { route: "salary", income: 13_000_000 },
    { route: "business_profit", income: 2_000_000 },
  ]);
  assert.equal(engineSalaried.status, "ESTIMATE");
  assert.equal(engineSalaried.baseTax, 4_431_000);
  assert.equal(engineSalaried.surcharge, 398_790);

  const pktSalaried = makeBusinessPacket({
    incomeSources: ["salary", "business"],
    grossSales: 2_000_000,
    companionNormalIncome: {
      normalTaxableIncome: 13_000_000,
      salaryHeadIncome: 13_000_000,
    },
  });
  const compSalaried = pktSalaried.expectedIrisTotals.computations;
  assert.deepEqual(computationsDriver.validatePlan(compSalaried), []);
  assert.equal(compSalaried.expectedTaxableIncome, 15_000_000);
  assert.equal(compSalaried.expectedNormalTax, engineSalaried.baseTax);
  assert.equal(compSalaried.surcharge.action, "TYPE");
  assert.equal(compSalaried.surcharge.ratePercent, 9);
  assert.equal(compSalaried.surcharge.value, engineSalaried.surcharge);
  assert.equal(compSalaried.superTax.action, "NONE");
  assert.equal(rowOf(pktSalaried.expectedIrisTotals, "9100").expected, 15_000_000);
  assert.equal(rowOf(pktSalaried.expectedIrisTotals, "920000").expected, 4_431_000);
  assert.equal(rowOf(pktSalaried.expectedIrisTotals, "923184").expected, 398_790);
  assert.equal(
    rowOf(pktSalaried.expectedIrisTotals, "9200").expected,
    4_431_000 + 398_790,
  );

  // Desktop driver types 398790 when IRIS 9100/920000 match.
  const hType = makeDriverHarness(
    makeComputationsDomRows({
      business: "2,000,000",
      total: "15,000,000",
      taxable: "15,000,000",
      normal: "4,431,000",
    }),
  );
  const outType = await computationsDriver.fillComputations(
    {},
    compSalaried,
    hType.options,
  );
  assert.equal(outType.ok, true);
  assert.equal(hType.calls.fill.length, 1);
  assert.equal(hType.calls.fill[0].fields[0].irisCode, "923184");
  assert.equal(hType.calls.fill[0].fields[0].value, "398790");

  // Desktop driver leaves 923184 untouched if IRIS already auto-computed 398,790 in Subject to Normal Tax.
  const hAuto = makeDriverHarness(
    makeComputationsDomRows({
      business: "2,000,000",
      total: "15,000,000",
      taxable: "15,000,000",
      normal: "4,431,000",
      surchargeNormal: "398,790",
      taxChargeable: "4,829,790",
    }),
  );
  const outAuto = await computationsDriver.fillComputations(
    {},
    compSalaried,
    hAuto.options,
  );
  assert.equal(outAuto.ok, true);
  assert.equal(hAuto.calls.fill.length, 0);
  assert.equal(outAuto.decisions[0].reason, "iris_computed_in_normal_column");

  // 3) Salary 7M + Business 5M = 12M (58.3% salary <= 75% -> Clause 1 table + 10% surcharge).
  const engineNonSalaried = estimateEngine([
    { route: "salary", income: 7_000_000 },
    { route: "business_profit", income: 5_000_000 },
  ]);
  assert.equal(engineNonSalaried.baseTax, 4_490_000);
  assert.equal(engineNonSalaried.surcharge, 449_000);

  const pktNonSalaried = makeBusinessPacket({
    incomeSources: ["salary", "business"],
    grossSales: 5_000_000,
    companionNormalIncome: {
      normalTaxableIncome: 7_000_000,
      salaryHeadIncome: 7_000_000,
    },
  });
  const compNonSalaried = pktNonSalaried.expectedIrisTotals.computations;
  assert.deepEqual(computationsDriver.validatePlan(compNonSalaried), []);
  assert.equal(compNonSalaried.expectedTaxableIncome, 12_000_000);
  assert.equal(compNonSalaried.expectedNormalTax, 4_490_000);
  assert.equal(compNonSalaried.surcharge.action, "TYPE");
  assert.equal(compNonSalaried.surcharge.ratePercent, 10);
  assert.equal(compNonSalaried.surcharge.value, 449_000);

  // 4) Mixed return > PKR 150M keeps superTax as USER so row 3000 !== combined base never misfires.
  const pktAbove150m = makeBusinessPacket({
    incomeSources: ["salary", "business"],
    grossSales: 60_000_000,
    companionNormalIncome: {
      normalTaxableIncome: 100_000_000,
      salaryHeadIncome: 100_000_000,
    },
  });
  assert.equal(
    pktAbove150m.expectedIrisTotals.computations.superTax.action,
    "USER",
  );
  assert.ok(
    pktAbove150m.expectedIrisTotals.skipped.some((s) => s.code === "9200"),
  );
});

test("7B: Business + Pension (exempt and working-as-salary) > PKR 10M prices exact 10% or 9% surcharge", () => {
  // Business 12M + Pension 8M (exempt): 0 companion normal income -> 12M Clause 1 + 10% surcharge.
  const pktExempt = makeBusinessPacket({
    incomeSources: ["business", "pension"],
    grossSales: 12_000_000,
    companionNormalIncome: {
      normalTaxableIncome: 0,
      salaryHeadIncome: 0,
    },
  });
  assert.equal(
    pktExempt.expectedIrisTotals.computations.surcharge.action,
    "TYPE",
  );
  assert.equal(
    pktExempt.expectedIrisTotals.computations.surcharge.ratePercent,
    10,
  );
  assert.equal(
    pktExempt.expectedIrisTotals.computations.surcharge.value,
    449_000,
  );

  // Business 4M + Pension 12M (taxed as salary): 12M / 16M = 75.0% (NOT strictly > 75%) -> 10% Clause 1.
  const pktBoundary75 = makeBusinessPacket({
    incomeSources: ["business", "pension"],
    grossSales: 4_000_000,
    companionNormalIncome: {
      normalTaxableIncome: 12_000_000,
      salaryHeadIncome: 12_000_000,
    },
  });
  assert.equal(
    pktBoundary75.expectedIrisTotals.computations.surcharge.ratePercent,
    10,
  );

  // Business 3M + Pension 12M (taxed as salary): 12M / 15M = 80.0% (> 75%) -> 9% Clause 2 salaried!
  const pktWorking80 = makeBusinessPacket({
    incomeSources: ["business", "pension"],
    grossSales: 3_000_000,
    companionNormalIncome: {
      normalTaxableIncome: 12_000_000,
      salaryHeadIncome: 12_000_000,
    },
  });
  assert.equal(
    pktWorking80.expectedIrisTotals.computations.surcharge.ratePercent,
    9,
  );
  assert.equal(
    pktWorking80.expectedIrisTotals.computations.expectedNormalTax,
    4_431_000,
  );
  assert.equal(
    pktWorking80.expectedIrisTotals.computations.surcharge.value,
    398_790,
  );
});

test("7C: Business + Pension (final_above_10m) and Salary + Business + Pension (final_above_10m) coordinate row 923184 end-to-end", async () => {
  // Case A: Business 12M + Pension 14M (final_above_10m, age < 70).
  // Pension final tax = 5% of 4M = 200,000; pension surcharge = 20,000.
  // Business normal tax on 12M = 4,490,000; 10% normal surcharge = 449,000.
  // Combined 923184 Total Income = 469,000.
  const h = harness({
    pension: 14_000_000,
    ledgerPension: 14_000_000,
    taxDeducted: 200_000,
    ledgerTax: 200_000,
    dob: "1961-01-15",
    answer: false,
  });
  h.state.draft.incomeSources = JSON.stringify(["business", "pension"]);
  h.state.draft.taxCalculationRevision = 7;

  const resolvedPension = h
    .load("lib/tax/pension-source.ts")
    .resolveApprovedPensionSource({
      document: h.state.documents.find(
        (d) => d.documentType === "pension_statement",
      ),
      taxYear: 2026,
      profile: { dateOfBirth: new Date("1961-01-15T00:00:00Z"), cnic: null },
      taxAsSalary: false,
      ledgerPension: 14_000_000,
      ledgerTaxWithheld: 200_000,
      hasOtherIncomeSources: true,
    });
  assert.equal(resolvedPension.treatment, "final_above_10m");
  assert.equal(resolvedPension.surcharge, 20_000);

  h.state.lines.push({
    source: "pension",
    calculationRevision: 7,
    surcharge: 20_000,
    detailsJson: JSON.stringify({
      isFinalTax: true,
      pensionSource: { fingerprint: resolvedPension.fingerprint },
    }),
  });

  const business12m = makeBusinessPacket({
    incomeSources: ["business", "pension"],
    grossSales: 12_000_000,
    companionNormalIncome: {
      normalTaxableIncome: 0,
      salaryHeadIncome: 0,
      finalPensionSurcharge: resolvedPension.surcharge,
    },
  });
  assert.equal(
    business12m.expectedIrisTotals.computations.surcharge.alreadyHandledInFieldMap,
    true,
  );
  assert.equal(
    rowOf(business12m.expectedIrisTotals, "923184").column,
    "total",
  );
  assert.equal(
    rowOf(business12m.expectedIrisTotals, "923184").expected,
    469_000,
  );

  const additionalNormal = resolveFinalPensionAdditionalNormalSurcharge({
    incomeSources: ["business", "pension"],
    pensionTreatment: "final_above_10m",
    calculationLines: [],
    businessExpectedComputations: business12m.expectedIrisTotals.computations,
  });
  assert.equal(additionalNormal, 449_000);

  const pfm12m = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: [],
    taxCredits: [],
    taxableIncome: 12_000_000,
    taxWithheld: 200_000,
    pensionSource: resolvedPension,
    additionalSection4ABSurcharge: additionalNormal,
    reconciliation: {
      netWorthStart: 0,
      netWorthEnd: 0,
      totalInflows: 0,
      totalOutflows: 0,
      unreconciledGap: 0,
      accountBalances: [],
      personalExpenses: 0,
    },
  });
  const row923184 = pfm12m.adjustableTaxFields.find(
    (f) => f.irisCode === "923184" && f.column === "Total Income",
  );
  assert.equal(row923184.ourAmount, 469_000);
  assert.equal(pfm12m.computationHints.normalSlabSurcharge, 449_000);

  const snapshot12m = {
    filing: {
      taxYear: 2026,
      filerType: "myself",
      incomeSources: ["business", "pension"],
      taxCalculationRevision: 7,
    },
    pension: resolvedPension,
    business: { ...business12m, version: "business-entry-v9" },
    portalFieldMap: pfm12m,
  };

  // Both server validation and Electron pensionEntryHold accept 469,000!
  const valErr = await h
    .load("lib/tax/pension-packet-validation.ts")
    .pensionPacketValidationError(snapshot12m, "qa-draft", "qa-user");
  assert.equal(valErr, null);
  assert.equal(pensionEntryHold(snapshot12m), null);

  // Tampered packet omitting 449,000 normal surcharge is rejected fail-closed by BOTH!
  const staleSnapshot = plain(snapshot12m);
  staleSnapshot.portalFieldMap.adjustableTaxFields.find(
    (f) => f.irisCode === "923184",
  ).ourAmount = 20_000;
  delete staleSnapshot.portalFieldMap.computationHints.normalSlabSurcharge;
  const staleValErr = await h
    .load("lib/tax/pension-packet-validation.ts")
    .pensionPacketValidationError(staleSnapshot, "qa-draft", "qa-user");
  assert.match(String(staleValErr), /final-tax autofill contract is incomplete/);
  assert.notEqual(pensionEntryHold(staleSnapshot), null);

  // Desktop irisComputationsDriver leaves 923184 untouched (`typed_in_field_map`) when IRIS matches,
  // and alerts the taxpayer (`iris_base_differs`) if IRIS Normal Tax differs!
  const hMatch = makeDriverHarness(
    makeComputationsDomRows({
      business: "12,000,000",
      total: "12,000,000",
      taxable: "12,000,000",
      normal: "4,490,000",
      surchargeTotal: "469,000",
    }),
  );
  const outMatch = await computationsDriver.fillComputations(
    {},
    business12m.expectedIrisTotals.computations,
    hMatch.options,
  );
  assert.equal(outMatch.ok, true);
  assert.equal(hMatch.calls.fill.length, 0);
  assert.equal(outMatch.decisions[0].reason, "typed_in_field_map");
  assert.equal(outMatch.messages.length, 0);

  const hDiff = makeDriverHarness(
    makeComputationsDomRows({
      business: "12,000,000",
      total: "12,000,000",
      taxable: "12,000,000",
      normal: "4,500,000",
      surchargeTotal: "469,000",
    }),
  );
  const outDiff = await computationsDriver.fillComputations(
    {},
    business12m.expectedIrisTotals.computations,
    hDiff.options,
  );
  assert.equal(hDiff.calls.fill.length, 0);
  assert.equal(outDiff.decisions[0].reason, "iris_base_differs");
  assert.equal(outDiff.messages.length, 1);

  // Case B: Business 4M (<= 10M) + Pension 14M (final_above_10m) -> 923184 holds 20,000 without false warning!
  const business4m = makeBusinessPacket({
    incomeSources: ["business", "pension"],
    grossSales: 4_000_000,
    companionNormalIncome: {
      normalTaxableIncome: 0,
      salaryHeadIncome: 0,
      finalPensionSurcharge: 20_000,
    },
  });
  const hBelow10m = makeDriverHarness(
    makeComputationsDomRows({
      business: "4,000,000",
      total: "4,000,000",
      taxable: "4,000,000",
      normal: "945,000",
      surchargeTotal: "20,000",
    }),
  );
  const outBelow10m = await computationsDriver.fillComputations(
    {},
    business4m.expectedIrisTotals.computations,
    hBelow10m.options,
  );
  assert.equal(outBelow10m.ok, true);
  assert.equal(hBelow10m.calls.fill.length, 0);
  assert.equal(outBelow10m.decisions[0].reason, "typed_in_field_map");
  assert.equal(outBelow10m.messages.length, 0);

  // Case C: Salary 13M + Business 2M + Pension 14M (final_above_10m) -> 20,000 + 398,790 = 418,790!
  const businessSalPen = makeBusinessPacket({
    incomeSources: ["salary", "business", "pension"],
    grossSales: 2_000_000,
    companionNormalIncome: {
      normalTaxableIncome: 13_000_000,
      salaryHeadIncome: 13_000_000,
      finalPensionSurcharge: 20_000,
    },
  });
  const addSalPen = resolveFinalPensionAdditionalNormalSurcharge({
    incomeSources: ["salary", "business", "pension"],
    pensionTreatment: "final_above_10m",
    calculationLines: [],
    businessExpectedComputations:
      businessSalPen.expectedIrisTotals.computations,
  });
  assert.equal(addSalPen, 398_790);
  const pfmSalPen = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: [],
    taxCredits: [],
    taxableIncome: 15_000_000,
    taxWithheld: 200_000,
    salaryCertificateGrossSalary: 13_000_000,
    salaryCertificateTaxWithheld: 4_000_000,
    pensionSource: resolvedPension,
    additionalSection4ABSurcharge: addSalPen,
    reconciliation: {
      netWorthStart: 0,
      netWorthEnd: 0,
      totalInflows: 0,
      totalOutflows: 0,
      unreconciledGap: 0,
      accountBalances: [],
      personalExpenses: 0,
    },
  });
  const snapshotSalPen = {
    filing: {
      taxYear: 2026,
      filerType: "myself",
      incomeSources: ["salary", "business", "pension"],
      taxCalculationRevision: 7,
    },
    pension: resolvedPension,
    business: { ...businessSalPen, version: "business-entry-v9" },
    portalFieldMap: pfmSalPen,
  };
  assert.equal(
    snapshotSalPen.portalFieldMap.adjustableTaxFields.find(
      (f) => f.irisCode === "923184",
    ).ourAmount,
    418_790,
  );
  assert.equal(pensionEntryHold(snapshotSalPen), null);
});

test("7B + 7C real server actions: calculateTaxAction + generateFilingPacketAction produce exact combined surcharge packets", async () => {
  const { BUSINESS_BALANCE_LABELS } = require("../lib/tax/business-filing.ts");
  const {
    readReviewedBusinessFacts,
  } = require("../lib/tax/business-document-intake.ts");
  const balanceFields = Object.entries(BUSINESS_BALANCE_LABELS).map(
    ([key, label]) => ({
      label,
      value:
        {
          businessName: "SYNTHETIC TRADER",
          taxYear: 2026,
          closingDate: "2026-06-30",
          currency: "PKR",
          totalAssets: 1_000_000,
          totalEquityLiabilities: 1_000_000,
          land: 0,
          building: 0,
          plant: 0,
          vehicle: 0,
          advances: 250_000,
          stock: 600_000,
          cash: 150_000,
          bank: 0,
          securities: 0,
          otherAssets: 0,
          capital: 800_000,
          loans: 0,
          payables: 200_000,
          otherLiabilities: 0,
        }[key] ?? 0,
    }),
  );
  const makeBooksExtracted = (sales) =>
    JSON.stringify({
      fields: Object.entries({
        "Business Name": "SYNTHETIC TRADER",
        "Tax Year": 2026,
        Currency: "PKR",
        "Reporting Period Start": "2025-07-01",
        "Reporting Period End": "2026-06-30",
        "Sales for the year": sales,
        "Other business receipts": 0,
        "Cost of sales": 0,
        "Business expenses": 0,
        Depreciation: 0,
        "Expenses that are not allowed": 0,
        "Business loss brought forward": 0,
        "Tax already deducted on business receipts": 0,
      }).map(([label, value]) => ({ label, value, confidence: 1 })),
    });

  // 1) Real action: Business 12M + Pension 14M (final_above_10m)
  const hBizPen = harness({
    pension: 14_000_000,
    ledgerPension: 14_000_000,
    taxDeducted: 200_000,
    ledgerTax: 200_000,
    dob: "1961-01-15",
    answer: false,
    mockCompleteness: true,
  });
  hBizPen.state.draft.incomeSources = JSON.stringify(["business", "pension"]);
  hBizPen.state.documents.push(
    {
      id: "qa-biz-books",
      filingDraftId: "qa-draft",
      userId: "qa-user",
      documentType: "business_books",
      extractionStatus: "MAPPED",
      extractedData: makeBooksExtracted(12_000_000),
      createdAt: new Date("2026-10-20T00:00:00Z"),
    },
    {
      id: "qa-biz-bs",
      filingDraftId: "qa-draft",
      userId: "qa-user",
      documentType: "business_balance_sheet",
      extractionStatus: "MAPPED",
      extractedData: JSON.stringify({ fields: balanceFields }),
      createdAt: new Date("2026-10-20T00:00:00Z"),
    },
  );
  const syncedBizPenDetails = readReviewedBusinessFacts(
    hBizPen.state.documents,
    {
      businessName: "SYNTHETIC TRADER",
      businessIdentity: {
        businessName: "SYNTHETIC TRADER",
        brandName: "SYNTHETIC TRADER",
        principalActivity: "Trading",
        startDate: "2020-07-01",
      },
      businessActivities: ["620200"],
      businessGrossSales: 12_000_000,
      businessOtherRevenue: 0,
      businessCostOfSales: 0,
      businessOperatingExpenses: 0,
      businessDepreciation: 0,
      businessInadmissibleExpenses: 0,
      businessLossBroughtForward: 0,
      businessWithholdingDeducted: 0,
      businessSalesExcludeIndirectTax: true,
      businessTurnover100mEarlierYear: false,
      businessBankOwnershipDecisions: [
        {
          bankAccountId: "qa-bank",
          iban: "PK36SCBL0000001123456702",
          ownership: "personal",
          confirmed: true,
        },
      ],
    },
  ).details;
  hBizPen.state.draft.incomeSelections.push({
    id: "qa-biz-sel",
    filingDraftId: "qa-draft",
    userId: "qa-user",
    source: "business",
    subcategory: "profit-return",
    status: "SELECTED",
    detailsJson: JSON.stringify({ userDetails: syncedBizPenDetails }),
  });

  const calcBizPen = await hBizPen.calculate();
  assert.equal(calcBizPen.success, true, calcBizPen.error);
  // 20,000 pension surcharge + 449,000 business normal surcharge = 469,000!
  assert.equal(calcBizPen.result.surcharge, 469_000);

  const pktBizPen = await hBizPen.generate();
  assert.equal(pktBizPen.success, true, pktBizPen.error);
  const snapBizPen = JSON.parse(hBizPen.state.packets.at(-1).snapshotJson);
  assert.equal(
    snapBizPen.portalFieldMap.adjustableTaxFields.find(
      (f) => f.irisCode === "923184" && f.column === "Total Income",
    ).ourAmount,
    469_000,
  );
  assert.equal(
    snapBizPen.portalFieldMap.computationHints.normalSlabSurcharge,
    449_000,
  );
  assert.equal(
    snapBizPen.business.expectedIrisTotals.computations.surcharge
      .alreadyHandledInFieldMap,
    true,
  );
  assert.equal(
    await hBizPen
      .load("lib/tax/pension-packet-validation.ts")
      .pensionPacketValidationError(snapBizPen, "qa-draft", "qa-user"),
    null,
  );
  assert.equal(pensionEntryHold(snapBizPen), null);

  // 2) Real action: Salary 13M + Business 2M (86.7% salary -> 9% surcharge = 398,790)
  const hSalBiz = harness({
    pension: 0,
    ledgerPension: 0,
    salary: 13_000_000,
    mockCompleteness: true,
  });
  hSalBiz.state.draft.incomeSources = JSON.stringify(["salary", "business"]);
  hSalBiz.state.draft.incomeSelections = hSalBiz.state.draft.incomeSelections.filter(
    (s) => s.source !== "pension",
  );
  hSalBiz.state.documents = hSalBiz.state.documents.filter(
    (d) => d.documentType !== "pension_statement",
  );
  hSalBiz.state.entries = hSalBiz.state.entries.filter(
    (e) => e.category !== "PENSION",
  );
  hSalBiz.state.documents.push(
    {
      id: "qa-biz-books-2",
      filingDraftId: "qa-draft",
      userId: "qa-user",
      documentType: "business_books",
      extractionStatus: "MAPPED",
      extractedData: makeBooksExtracted(2_000_000),
      createdAt: new Date("2026-10-20T00:00:00Z"),
    },
    {
      id: "qa-biz-bs-2",
      filingDraftId: "qa-draft",
      userId: "qa-user",
      documentType: "business_balance_sheet",
      extractionStatus: "MAPPED",
      extractedData: JSON.stringify({ fields: balanceFields }),
      createdAt: new Date("2026-10-20T00:00:00Z"),
    },
  );
  const syncedSalBizDetails = readReviewedBusinessFacts(
    hSalBiz.state.documents,
    {
      businessName: "SYNTHETIC TRADER",
      businessIdentity: {
        businessName: "SYNTHETIC TRADER",
        brandName: "SYNTHETIC TRADER",
        principalActivity: "Trading",
        startDate: "2020-07-01",
      },
      businessActivities: ["620200"],
      businessGrossSales: 2_000_000,
      businessOtherRevenue: 0,
      businessCostOfSales: 0,
      businessOperatingExpenses: 0,
      businessDepreciation: 0,
      businessInadmissibleExpenses: 0,
      businessLossBroughtForward: 0,
      businessWithholdingDeducted: 0,
      businessSalesExcludeIndirectTax: true,
      businessTurnover100mEarlierYear: false,
      businessBankOwnershipDecisions: [
        {
          bankAccountId: "qa-bank",
          iban: "PK36SCBL0000001123456702",
          ownership: "personal",
          confirmed: true,
        },
      ],
    },
  ).details;
  hSalBiz.state.draft.incomeSelections.push({
    id: "qa-biz-sel-2",
    filingDraftId: "qa-draft",
    userId: "qa-user",
    source: "business",
    subcategory: "profit-return",
    status: "SELECTED",
    detailsJson: JSON.stringify({ userDetails: syncedSalBizDetails }),
  });

  const calcSalBiz = await hSalBiz.calculate();
  assert.equal(calcSalBiz.success, true, calcSalBiz.error);
  assert.equal(calcSalBiz.result.surcharge, 398_790);

  const pktSalBiz = await hSalBiz.generate();
  assert.equal(pktSalBiz.success, true, pktSalBiz.error);
  const snapSalBiz = JSON.parse(hSalBiz.state.packets.at(-1).snapshotJson);
  const compSalBiz = snapSalBiz.business.expectedIrisTotals.computations;
  assert.deepEqual(computationsDriver.validatePlan(compSalBiz), []);
  assert.equal(compSalBiz.expectedTaxableIncome, 15_000_000);
  assert.equal(compSalBiz.expectedNormalTax, 4_431_000);
  assert.equal(compSalBiz.surcharge.action, "TYPE");
  assert.equal(compSalBiz.surcharge.ratePercent, 9);
  assert.equal(compSalBiz.surcharge.value, 398_790);
  assert.equal(compSalBiz.superTax.action, "NONE");
});
