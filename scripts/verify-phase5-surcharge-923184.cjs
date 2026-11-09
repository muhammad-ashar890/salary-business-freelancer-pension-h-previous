"use strict";
/**
 * Phase 5 (Bug #4): Section 4AB Surcharge (IRIS row 923184) across non-business
 * high-income (> PKR 10M) single & multifiling routes:
 *   - Salary > 10M (9%)
 *   - Salary + Pension > 10M (exempt, exempt_age70, combined salary slab, and
 *     combined final_above_10m + Salary > 10M)
 *   - Pension-only > 10M taxed as salary (9%)
 *   - Services-only, Salary + Services, and Pension + Services > 10M
 *   - Non-interference with <= 10M filings and Business / Salary + Business
 *   - Fail-closed desktop validation on malformed `snapshot.computations`
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithAlias(request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolveFilename.call(this, request, ...rest);
};
require.extensions[".ts"] = (mod, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  mod._compile(
    ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    filename,
  );
};

const { calculateTaxEstimate } = require("../lib/tax/tax-calculation.ts");
const {
  buildNonBusinessComputationsPlan,
  resolveFinalPensionAdditionalNormalSurcharge,
  SURCHARGE_SERVICES_OR_MIXED_USER_MESSAGE,
} = require("../lib/tax/non-business-computations-plan.ts");
const computationsDriver = require("../electron-connect/iris-computations-driver.js");
const tourCensus = require("../electron-connect/iris-tour-census.js");
const { pensionEntryHold } = require("../electron-connect/pension-guard.js");
const { harness } = require("./helpers/pension-harness.cjs");

const validation = (h, snapshot) =>
  h
    .load("lib/tax/pension-packet-validation.ts")
    .pensionPacketValidationError(snapshot, "qa-draft", "qa-user");

function toLinesFromEstimate(result) {
  assert.equal(result.status, "ESTIMATE");
  return result.breakdown.map((line) => ({
    source: line.route,
    taxBase: line.income,
    baseTax: line.baseTax,
    surcharge: line.surcharge,
    calculatedTax: line.taxDue,
    detailsJson: JSON.stringify({
      rateShape: line.rateShape,
      isFinalTax: line.isFinalTax,
      appliedRuleIds: line.appliedRuleIds,
      note: line.note,
      combinedRoutes: line.combinedRoutes ?? [],
    }),
  }));
}

const cell = (value, editable = false) => ({ value, editable });
const computationsDomRows = ({
  taxable = "15,000,000",
  normal = "4,435,000",
  business = "0",
  total = "15,000,000",
  surcharge = "",
  surchargeNormal = "",
  taxChargeable = null,
} = {}) => [
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
    cells: [cell(""), cell(""), cell(""), cell(taxable)],
  },
  {
    code: "920000",
    description: "Normal Tax",
    cells: [cell(""), cell(""), cell(""), cell(normal)],
  },
  {
    code: "9231822",
    description: "Tax on High Earning Persons u/s 4C",
    cells: [cell("", true), cell(""), cell(""), cell("")],
  },
  {
    code: "923184",
    description: "Surcharge on high earning person u/s 4AB",
    cells: [cell(surcharge, true), cell(""), cell(""), cell(surchargeNormal)],
  },
  {
    code: "9200",
    description: "Tax Chargeable",
    cells: [cell(""), cell(""), cell(""), cell(taxChargeable ?? normal)],
  },
];

function driverHarness(rows) {
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

test("Salary > PKR 10M emits verified 9% TYPE plan on 923184; <= 10M emits null", async () => {
  const highSalary = calculateTaxEstimate({
    taxYear: 2026,
    filerStatus: "ATL",
    totalIncome: 15_000_000,
    totalExpenses: 0,
    bankProfitIncome: 0,
    incomeSources: [{ route: "salary", income: 15_000_000 }],
  });
  const plan = buildNonBusinessComputationsPlan({
    incomeSources: ["salary"],
    calculationLines: toLinesFromEstimate(highSalary),
  });
  assert.ok(plan);
  assert.equal(plan.version, "computations-v1");
  assert.deepEqual(computationsDriver.validatePlan(plan), []);
  assert.equal(plan.expectedTaxableIncome, 15_000_000);
  assert.equal(plan.expectedNormalTax, highSalary.baseTax);
  assert.equal(plan.surcharge.action, "TYPE");
  assert.equal(plan.surcharge.code, "923184");
  assert.equal(plan.surcharge.ratePercent, 9);
  assert.equal(plan.surcharge.value, highSalary.surcharge);
  assert.ok(highSalary.surcharge > 0);

  // Blank IRIS 923184 with matching 9100/920000 -> types into Total Income and passes readback.
  const blankH = driverHarness(
    computationsDomRows({
      taxable: "15,000,000",
      normal: highSalary.baseTax.toLocaleString("en-US"),
    }),
  );
  const typed = await computationsDriver.fillComputations({}, plan, blankH.options);
  assert.equal(typed.ok, true);
  assert.equal(blankH.calls.fill.length, 1);
  assert.equal(blankH.calls.fill[0].fields[0].irisCode, "923184");
  assert.equal(blankH.calls.fill[0].fields[0].value, String(highSalary.surcharge));

  // IRIS already auto-computed 9% in Subject to Normal Tax -> leaves Total Income blank (no double charge).
  const autoH = driverHarness(
    computationsDomRows({
      taxable: "15,000,000",
      normal: highSalary.baseTax.toLocaleString("en-US"),
      surchargeNormal: highSalary.surcharge.toLocaleString("en-US"),
      taxChargeable: (highSalary.baseTax + highSalary.surcharge).toLocaleString("en-US"),
    }),
  );
  const autoOut = await computationsDriver.fillComputations({}, plan, autoH.options);
  assert.equal(autoOut.ok, true);
  assert.equal(autoH.calls.fill.length, 0);
  assert.equal(autoOut.decisions[0].reason, "iris_computed_in_normal_column");

  // Salary <= PKR 10M emits null so ordinary tours never visit Computations unnecessarily.
  const belowThreshold = calculateTaxEstimate({
    taxYear: 2026,
    filerStatus: "ATL",
    totalIncome: 9_500_000,
    totalExpenses: 0,
    bankProfitIncome: 0,
    incomeSources: [{ route: "salary", income: 9_500_000 }],
  });
  assert.equal(
    buildNonBusinessComputationsPlan({
      incomeSources: ["salary"],
      calculationLines: toLinesFromEstimate(belowThreshold),
    }),
    null,
  );
});

test("Salary + Pension (exempt and working combined-slab) > PKR 10M emit verified 9% TYPE plan end-to-end", async () => {
  // 1) Salary 14M + Exempt Pension 3M: normal taxable income is 14M (9% surcharge).
  const hExempt = harness({
    pension: 3_000_000,
    ledgerPension: 3_000_000,
    answer: false,
    salary: 14_000_000,
  });
  const calcExempt = await hExempt.calculate();
  assert.equal(calcExempt.success, true, calcExempt.error);
  assert.ok(calcExempt.result.surcharge > 0);
  const pktExempt = await hExempt.generate();
  assert.equal(pktExempt.success, true, pktExempt.error);
  const snapExempt = JSON.parse(hExempt.state.packets.at(-1).snapshotJson);
  assert.ok(snapExempt.computations);
  assert.deepEqual(computationsDriver.validatePlan(snapExempt.computations), []);
  assert.equal(snapExempt.computations.surcharge.action, "TYPE");
  assert.equal(snapExempt.computations.surcharge.ratePercent, 9);
  assert.equal(snapExempt.computations.expectedTaxableIncome, 14_000_000);
  assert.equal(snapExempt.computations.surcharge.value, calcExempt.result.surcharge);
  assert.equal(await validation(hExempt, snapExempt), null);
  assert.equal(pensionEntryHold(snapExempt), null);

  // 2) Salary 7M + Working Pension 5M = 12M combined_slab (> 10M, 9% surcharge).
  const hCombined = harness({
    pension: 5_000_000,
    ledgerPension: 5_000_000,
    answer: true,
    salary: 7_000_000,
  });
  const calcCombined = await hCombined.calculate();
  assert.equal(calcCombined.success, true, calcCombined.error);
  assert.ok(calcCombined.result.surcharge > 0);
  const pktCombined = await hCombined.generate();
  assert.equal(pktCombined.success, true, pktCombined.error);
  const snapCombined = JSON.parse(hCombined.state.packets.at(-1).snapshotJson);
  assert.ok(snapCombined.computations);
  assert.deepEqual(computationsDriver.validatePlan(snapCombined.computations), []);
  assert.equal(snapCombined.computations.surcharge.action, "TYPE");
  assert.equal(snapCombined.computations.surcharge.ratePercent, 9);
  assert.equal(snapCombined.computations.expectedTaxableIncome, 12_000_000);
  assert.equal(snapCombined.computations.surcharge.value, calcCombined.result.surcharge);
  assert.equal(await validation(hCombined, snapCombined), null);
  assert.equal(pensionEntryHold(snapCombined), null);

  // 3) Pension-only 12M taxed as salary (still working for former employer): emits 9% TYPE plan.
  const hPensionSalaryOnly = harness({
    pension: 12_000_000,
    ledgerPension: 12_000_000,
    answer: true,
    salary: 0,
  });
  const calcPensionSalary = await hPensionSalaryOnly.calculate();
  assert.equal(calcPensionSalary.success, true, calcPensionSalary.error);
  assert.ok(calcPensionSalary.result.surcharge > 0);
  const pktPensionSalary = await hPensionSalaryOnly.generate();
  assert.equal(pktPensionSalary.success, true, pktPensionSalary.error);
  const snapPensionSalary = JSON.parse(
    hPensionSalaryOnly.state.packets.at(-1).snapshotJson,
  );
  assert.ok(snapPensionSalary.computations);
  assert.deepEqual(
    computationsDriver.validatePlan(snapPensionSalary.computations),
    [],
  );
  assert.equal(snapPensionSalary.computations.surcharge.action, "TYPE");
  assert.equal(snapPensionSalary.computations.surcharge.ratePercent, 9);
  assert.equal(snapPensionSalary.computations.expectedTaxableIncome, 12_000_000);
  assert.equal(
    snapPensionSalary.computations.surcharge.value,
    calcPensionSalary.result.surcharge,
  );
  assert.equal(await validation(hPensionSalaryOnly, snapPensionSalary), null);
  assert.equal(pensionEntryHold(snapPensionSalary), null);
});

test("Salary > 10M + Pension final_above_10M combines both Section 4AB surcharges onto 923184 and fails closed on stale omission", async () => {
  const hFinal = harness({
    pension: 12_000_000,
    ledgerPension: 12_000_000,
    dob: "1962-03-15",
    answer: false,
    salary: 15_000_000,
  });
  const calc = await hFinal.calculate();
  assert.equal(calc.success, true, calc.error);
  // Pension final surcharge on (12M - 10M) * 5% = 100,000 -> 10% = 10,000;
  // plus 9% surcharge on 15M salary normal tax.
  assert.ok(calc.result.surcharge > 10_000);

  const pkt = await hFinal.generate();
  assert.equal(pkt.success, true, pkt.error);
  const snapshot = JSON.parse(hFinal.state.packets.at(-1).snapshotJson);
  assert.equal(snapshot.computations, undefined, "final_above_10m keeps 923184 in portalFieldMap without running computations driver twice");
  const surchargeRow = snapshot.portalFieldMap.adjustableTaxFields.find(
    (f) => f.irisCode === "923184" && f.column === "Total Income",
  );
  assert.ok(surchargeRow);
  assert.equal(surchargeRow.ourAmount, calc.result.surcharge);
  assert.equal(
    snapshot.portalFieldMap.computationHints.normalSlabSurcharge,
    calc.result.surcharge - 10_000,
  );
  assert.equal(await validation(hFinal, snapshot), null);
  assert.equal(pensionEntryHold(snapshot), null);

  // Stale/tampered packet that only carries the 10,000 pension surcharge while Salary is 15M fails closed on both server and desktop!
  const stale = structuredClone(snapshot);
  stale.portalFieldMap.adjustableTaxFields.find(
    (f) => f.irisCode === "923184",
  ).ourAmount = 10_000;
  delete stale.portalFieldMap.computationHints.normalSlabSurcharge;
  assert.match(String(await validation(hFinal, stale)), /Section 4AB surcharge/i);
  assert.ok(pensionEntryHold(stale), "desktop guard must refuse stale final_above_10m packet missing Salary >10M surcharge");
});

test("Services / Salary + Services / Pension + Services > PKR 10M emit safe USER or TYPE plans and support scoped readback", async () => {
  // 1) Salary 8M + mapped Services 4M = 12M (> 10M in IRIS 9100): emits USER plan.
  const salary8m = calculateTaxEstimate({
    taxYear: 2026,
    filerStatus: "ATL",
    totalIncome: 12_000_000,
    totalExpenses: 0,
    bankProfitIncome: 0,
    incomeSources: [
      { route: "salary", income: 8_000_000 },
      { route: "services", income: 4_000_000, subcategory: "1b-service-it-ites" },
    ],
  });
  const mixedServicesPlan = buildNonBusinessComputationsPlan({
    incomeSources: ["salary", "services"],
    calculationLines: toLinesFromEstimate(salary8m),
    mappedServicesIncomePkr: 4_000_000,
    hasServicesIncomeGaps: false,
  });
  assert.ok(mixedServicesPlan);
  assert.deepEqual(computationsDriver.validatePlan(mixedServicesPlan), []);
  assert.equal(mixedServicesPlan.surcharge.action, "USER");
  assert.equal(
    mixedServicesPlan.surcharge.message,
    SURCHARGE_SERVICES_OR_MIXED_USER_MESSAGE,
  );

  // When IRIS 9100 > 10M and 923184 is blank, driver reports both 10% and 9% of IRIS's Normal Tax.
  const blankServicesH = driverHarness(
    computationsDomRows({ taxable: "12,000,000", normal: "3,440,000" }),
  );
  const userOut = await computationsDriver.fillComputations(
    {},
    mixedServicesPlan,
    blankServicesH.options,
  );
  assert.equal(blankServicesH.calls.fill.length, 0);
  assert.equal(userOut.reason, "left_for_taxpayer");
  assert.match(userOut.messages[0], /Rs 344,000/);
  assert.match(userOut.messages[0], /Rs 309,600/);

  // When IRIS already computed 10% in Subject to Normal Tax, USER plan leaves it cleanly with 0 messages.
  const irisAutoServicesH = driverHarness(
    computationsDomRows({
      taxable: "12,000,000",
      normal: "3,440,000",
      surchargeNormal: "344,000",
      taxChargeable: "3,784,000",
    }),
  );
  const irisAutoOut = await computationsDriver.fillComputations(
    {},
    mixedServicesPlan,
    irisAutoServicesH.options,
  );
  assert.equal(irisAutoOut.ok, true);
  assert.equal(irisAutoOut.messages.length, 0);

  // 2) Services-only 12M (> 10M): emits USER plan; Services-only 6M (<= 10M): emits null.
  const services12m = calculateTaxEstimate({
    taxYear: 2026,
    filerStatus: "ATL",
    totalIncome: 12_000_000,
    totalExpenses: 0,
    bankProfitIncome: 0,
    incomeSources: [
      { route: "services", income: 12_000_000, subcategory: "1b-service-it-ites" },
    ],
  });
  const servicesOnlyPlan = buildNonBusinessComputationsPlan({
    incomeSources: ["services"],
    calculationLines: toLinesFromEstimate(services12m),
    mappedServicesIncomePkr: 12_000_000,
  });
  assert.ok(servicesOnlyPlan);
  assert.equal(servicesOnlyPlan.surcharge.action, "USER");

  const services6m = calculateTaxEstimate({
    taxYear: 2026,
    filerStatus: "ATL",
    totalIncome: 6_000_000,
    totalExpenses: 0,
    bankProfitIncome: 0,
    incomeSources: [
      { route: "services", income: 6_000_000, subcategory: "1b-service-it-ites" },
    ],
  });
  assert.equal(
    buildNonBusinessComputationsPlan({
      incomeSources: ["services"],
      calculationLines: toLinesFromEstimate(services6m),
      mappedServicesIncomePkr: 6_000_000,
    }),
    null,
  );

  // 3) Salary 15M + Services 0 settled this year (no gaps): emits TYPE 9% and passes scoped census readback.
  const salary15mZeroServices = calculateTaxEstimate({
    taxYear: 2026,
    filerStatus: "ATL",
    totalIncome: 15_000_000,
    totalExpenses: 0,
    bankProfitIncome: 0,
    incomeSources: [{ route: "salary", income: 15_000_000 }],
  });
  const zeroServicesTypePlan = buildNonBusinessComputationsPlan({
    incomeSources: ["salary", "services"],
    calculationLines: toLinesFromEstimate(salary15mZeroServices),
    mappedServicesIncomePkr: 0,
    hasServicesIncomeGaps: false,
  });
  assert.ok(zeroServicesTypePlan);
  assert.equal(zeroServicesTypePlan.surcharge.action, "TYPE");
  assert.equal(zeroServicesTypePlan.surcharge.ratePercent, 9);
  const typeServicesH = driverHarness(
    computationsDomRows({
      taxable: "15,000,000",
      normal: salary15mZeroServices.baseTax.toLocaleString("en-US"),
    }),
  );
  const typeServicesOut = await computationsDriver.fillComputations(
    {},
    zeroServicesTypePlan,
    typeServicesH.options,
  );
  assert.equal(typeServicesOut.ok, true);
  const scopedTour = {
    views: [
      {
        key: "Tax Chargeable / Payments > Computations",
        rows: [
          {
            code: "923184",
            description: "Surcharge on high earning person u/s 4AB",
            cells: [
              { value: salary15mZeroServices.surcharge.toLocaleString("en-US") },
              { value: "" },
              { value: "" },
              { value: "" },
            ],
          },
        ],
      },
    ],
  };
  const [readbackCheck] = tourCensus.compareTypedEntries(
    scopedTour,
    typeServicesOut.results,
  );
  assert.equal(readbackCheck.status, "match");
});

test("Business / Salary + Business stay excluded; desktop main.js rejects malformed snapshot.computations before opening window", async () => {
  const combinedBiz = calculateTaxEstimate({
    taxYear: 2026,
    filerStatus: "ATL",
    totalIncome: 20_000_000,
    totalExpenses: 0,
    bankProfitIncome: 0,
    incomeSources: [
      { route: "salary", income: 12_000_000 },
      { route: "business_profit", income: 8_000_000 },
    ],
  });
  assert.equal(
    buildNonBusinessComputationsPlan({
      incomeSources: ["salary", "business"],
      calculationLines: toLinesFromEstimate(combinedBiz),
    }),
    null,
  );
  assert.equal(
    resolveFinalPensionAdditionalNormalSurcharge({
      incomeSources: ["salary", "business", "pension"],
      pensionTreatment: "final_above_10m",
      calculationLines: [{ source: "salary", surcharge: 300_000, detailsJson: "{}" }],
    }),
    0,
  );

  // Extract main.js functions to verify fail-closed guard + handoffSectionIds wiring.
  const mainSource = fs.readFileSync(
    path.join(root, "electron-connect/main.js"),
    "utf8",
  );
  function extractFunction(source, name) {
    const asyncMarker = `async function ${name}(`;
    const syncMarker = `function ${name}(`;
    const start = source.includes(asyncMarker)
      ? source.indexOf(asyncMarker)
      : source.indexOf(syncMarker);
    assert.ok(start >= 0, `found ${name}`);
    const bodyStart = source.indexOf("{", start);
    let depth = 0;
    for (let i = bodyStart; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    throw new Error(`unterminated ${name}`);
  }
  let windowsOpened = 0;
  const ctx = {
    console,
    Date,
    Error,
    Set,
    Map,
    Array,
    Object,
    Number,
    String,
    Boolean,
    Math,
    JSON,
    Promise,
    activeJobExecutionLog: null,
    AGENT_BUILD_TAG: "test-build",
    launchState: { accountReference: "4210112345671" },
    navigationStates: new Map(),
    lastNavigationOptions: null,
    lastTourStateKey: null,
    lastSectionTour: null,
    getLivePortalWindow: () => ({}),
    ensureNavigationJobActive: async () => {},
    captureWindowScreenshot: async () => null,
    updateLocalJobStatus: () => {},
    config: {},
    irisComputationsDriver: computationsDriver,
    irisNavigation: {
      BUILD_TAG: "test-build",
      DEFAULT_HOSTS: ["iris.fbr.gov.pk"],
      SALARY_WITHHOLDING_SECTION_IDS: ["salary", "tax_deductions"],
      async inspectNavigation(_getWin, opts) {
        inspectedSectionIds.push(opts.sectionIds);
        throw new Error("STOP_AFTER_CAPTURE");
      },
    },
    pensionEntryHold: () => null,
    assertNavigatorBuild() {},
    pushStatus() {},
    normalizeExplicitResidencyStatus: (v) => v || null,
    async ensureWorkerWindow() {
      windowsOpened += 1;
      return {};
    },
  };
  const inspectedSectionIds = [];
  const names = [
    "getServicesPacketRoute",
    "getServicesAutofillFields",
    "getSalaryFieldsForServicesRoute",
    "getPensionFieldsForServicesRoute",
    "autofillItemKey",
    "runLocalIrisNavigationCheck",
    "runRealIrisAutofill",
  ];
  vm.createContext(ctx);
  vm.runInContext(names.map((n) => extractFunction(mainSource, n)).join("\n\n"), ctx);

  for (const badComputations of [
    { version: "wrong-v0" },
    {
      version: "computations-v1",
      expectedTaxableIncome: 15_000_000,
      expectedNormalTax: 4_435_000,
      expectedBusinessIncome: null,
      turnover: { code: "923161", action: "TYPE", value: 100 },
      surcharge: { code: "923184", label: "Surcharge", action: "TYPE", value: 399_150, ratePercent: 9, basis: "ok", message: "" },
      superTax: { code: "9231822", label: "Super", action: "NONE", value: 0, ratePercent: 0, basis: "ok", message: "" },
    },
    {
      version: "computations-v1",
      expectedTaxableIncome: 15_000_000,
      expectedNormalTax: 4_435_000,
      expectedBusinessIncome: 160_000_000,
      surcharge: { code: "923184", label: "Surcharge", action: "TYPE", value: 399_150, ratePercent: 9, basis: "ok", message: "" },
      superTax: { code: "9231822", label: "Super", action: "TYPE", value: 1_600_000, ratePercent: 1, basis: "ok", message: "" },
    },
  ]) {
    const navOut = await ctx.runLocalIrisNavigationCheck(
      {
        filingPacket: {
          taxYear: 2026,
          snapshot: {
            filing: { taxYear: 2026, filerType: "myself", incomeSources: ["salary"] },
            portalFieldMap: [{ irisCode: "1009", column: "Total Amount", value: "15000000" }],
            computations: badComputations,
          },
        },
      },
      { id: "bad-comp-nav" },
    );
    assert.equal(navOut.paused, true);
    assert.equal(navOut.result.businessCoverage, "computations_plan_mismatch");

    const fillOut = await ctx.runRealIrisAutofill(
      {
        filingPacket: {
          taxYear: 2026,
          snapshot: {
            filing: { taxYear: 2026, filerType: "myself", incomeSources: ["salary"] },
            portalFieldMap: [{ irisCode: "1009", column: "Total Amount", value: "15000000" }],
            computations: badComputations,
          },
        },
      },
      { id: "bad-comp-fill" },
      "live",
    );
    assert.equal(fillOut.paused, true);
    assert.equal(fillOut.result.businessCoverage, "computations_plan_mismatch");
  }
  assert.equal(windowsOpened, 0, "worker window must never open on invalid computations plan");

  // Valid computations-v1 plan includes "computations" in handoffSectionIds; <=10M omits it.
  const validSalaryPlan = buildNonBusinessComputationsPlan({
    incomeSources: ["salary"],
    calculationLines: toLinesFromEstimate(
      calculateTaxEstimate({
        taxYear: 2026,
        filerStatus: "ATL",
        totalIncome: 15_000_000,
        totalExpenses: 0,
        bankProfitIncome: 0,
        incomeSources: [{ route: "salary", income: 15_000_000 }],
      }),
    ),
  });
  await assert.rejects(
    () =>
      ctx.runLocalIrisNavigationCheck(
        {
          filingPacket: {
            taxYear: 2026,
            packetHash: "hash-above-10m",
            snapshot: {
              filing: {
                taxYear: 2026,
                filerType: "myself",
                residencyStatus: "RESIDENT",
                reconciliationStatus: "RESOLVED",
                reconciliationGap: 0,
                incomeSources: ["salary"],
              },
              portalFieldMap: [{ irisCode: "1009", column: "Total Amount", value: "15000000" }],
              computations: validSalaryPlan,
            },
          },
        },
        { id: "nav-above-10m" },
      ),
    /STOP_AFTER_CAPTURE/,
  );
  await assert.rejects(
    () =>
      ctx.runLocalIrisNavigationCheck(
        {
          filingPacket: {
            taxYear: 2026,
            packetHash: "hash-below-10m",
            snapshot: {
              filing: {
                taxYear: 2026,
                filerType: "myself",
                residencyStatus: "RESIDENT",
                reconciliationStatus: "RESOLVED",
                reconciliationGap: 0,
                incomeSources: ["salary"],
              },
              portalFieldMap: [{ irisCode: "1009", column: "Total Amount", value: "8000000" }],
            },
          },
        },
        { id: "nav-below-10m" },
      ),
    /STOP_AFTER_CAPTURE/,
  );
  assert.deepEqual(Array.from(inspectedSectionIds[0]), [
    "salary",
    "tax_deductions",
    "computations",
  ]);
  assert.deepEqual(Array.from(inspectedSectionIds[1]), [
    "salary",
    "tax_deductions",
  ]);
});
