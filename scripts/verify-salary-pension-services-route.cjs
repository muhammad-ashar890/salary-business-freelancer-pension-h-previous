"use strict";

/**
 * Exact route contract for TY2026 Myself Salary + Pension + Freelancer / Services.
 *
 * These tests exercise the production server gate, the production Electron route
 * resolver, the two companion allowlists and the pension guard. They do not infer
 * support from UI labels or documentation.
 *
 * Scope guarantees asserted here:
 *   - the new triple activates only with a verified Services payload;
 *   - Salary and Pension companions are both switched on, Business is not;
 *   - the pension 64020004 (PENSION_SALARY_149) row is owned by the pension
 *     allowlist and is never reported as an unsupported salary row;
 *   - the unproven summed 923184 (salary slab above PKR 10M + pension final tax)
 *     stays fail-closed with a specific message;
 *   - every previously supported set and every previously blocked set keeps its
 *     exact behaviour.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithAlias(request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolveFilename.call(this, request, ...rest);
};
Module._extensions[".ts"] = function loadTypeScript(module, filename) {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const {
  isSingleFreelancerServicesFiling,
  isSalaryPensionServicesSourceSet,
} = require("../lib/tax/business-bank-categories.ts");
const { pensionEntryHold } = require("../electron-connect/pension-guard.js");
Module._resolveFilename = originalResolveFilename;

const mainSource = fs.readFileSync(
  path.join(root, "electron-connect/main.js"),
  "utf8",
);
const mainAst = ts.createSourceFile(
  "main.js",
  mainSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);

function functionSource(name) {
  const found = mainAst.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(found, `main.js function ${name} exists`);
  return found.getText(mainAst);
}

function loadMain(names, extras = {}) {
  const context = vm.createContext({ console, Date, Promise, ...extras });
  for (const name of names) {
    if (name in extras) continue;
    vm.runInContext(functionSource(name), context);
  }
  return context;
}

const main = loadMain(
  [
    "getServicesPacketRoute",
    "getSalaryFieldsForServicesRoute",
    "getPensionFieldsForServicesRoute",
  ],
  {
    autofillItemKey: (field) =>
      String(field.key || `${field.irisCode}:${field.column || ""}`),
  },
);
const plain = (value) => JSON.parse(JSON.stringify(value));

const targetSources = ["salary", "pension", "services"];

/* ------------------------------------------------------------------ gate --- */

test("server gate accepts exactly Salary + Pension + Services in any order", () => {
  for (const incomeSources of [
    ["salary", "pension", "services"],
    ["services", "salary", "pension"],
    ["pension", "services", "salary"],
  ]) {
    assert.equal(
      isSalaryPensionServicesSourceSet(incomeSources),
      true,
      `set matcher accepts ${incomeSources.join(" + ")}`,
    );
    assert.equal(
      isSingleFreelancerServicesFiling({
        taxYear: 2026,
        filerType: "myself",
        incomeSources,
      }),
      true,
    );
  }
});

test("the five previously supported sets and every blocked set keep their behaviour", () => {
  for (const incomeSources of [
    ["services"],
    ["salary", "services"],
    ["business", "services"],
    ["pension", "services"],
    ["salary", "business", "services"],
  ]) {
    assert.equal(
      isSingleFreelancerServicesFiling({
        taxYear: 2026,
        filerType: "myself",
        incomeSources,
      }),
      true,
      `${incomeSources.join(" + ")} still supported`,
    );
  }

  for (const input of [
    { incomeSources: ["salary", "pension", "services", "business"] },
    { incomeSources: ["business", "pension", "services"] },
    { incomeSources: ["salary", "pension", "services", "services"] },
    { incomeSources: ["salary", "pension"] },
    { incomeSources: targetSources, taxYear: 2025 },
    { incomeSources: targetSources, filerType: "my_business" },
  ]) {
    assert.equal(
      isSingleFreelancerServicesFiling({
        taxYear: 2026,
        filerType: "myself",
        ...input,
      }),
      false,
      `${JSON.stringify(input)} stays blocked`,
    );
  }
});

/* --------------------------------------------------------------- electron --- */

const servicesPayload = {
  version: "services-tax-deduction-v1",
  route: "services_tax_deduction",
  coverage: "services_tax_deduction_only",
  taxYear: 2026,
  fields: [
    {
      irisCode: "3101",
      column: "Total Amount",
      ourAmount: 2_000_000,
      section: "Other Revenues",
    },
  ],
};

const snapshot = (incomeSources, { filing = {}, ...overrides } = {}) => ({
  filing: { taxYear: 2026, filerType: "myself", incomeSources, ...filing },
  business: servicesPayload,
  services: null,
  ...overrides,
});

test("Electron activates the exact triple with both Salary and Pension companions", () => {
  const route = main.getServicesPacketRoute(snapshot(targetSources));
  assert.equal(route.selected, true);
  assert.equal(route.exact, true);
  assert.equal(route.payloadValid, true);
  assert.equal(route.active, true);
  assert.equal(route.salaryIncluded, true);
  assert.equal(route.pensionIncluded, true);
  assert.equal(route.businessIncluded, false);

  // The two triples that were already complete keep activating exactly as before.
  const sbs = main.getServicesPacketRoute(
    snapshot(["salary", "business", "services"], {
      salaryBusinessServices: {
        version: "salary-business-services-v1",
        computations: { version: "computations-v1" },
      },
    }),
  );
  assert.equal(sbs.active, true);
  assert.equal(sbs.businessIncluded, true);
  assert.equal(sbs.pensionIncluded, false);
  const pensionServices = main.getServicesPacketRoute(
    snapshot(["pension", "services"]),
  );
  assert.equal(pensionServices.active, true);
  assert.equal(pensionServices.pensionIncluded, true);
  assert.equal(pensionServices.salaryIncluded, false);

  for (const invalid of [
    snapshot(["business", "pension", "services"]),
    snapshot(["salary", "business", "pension", "services"]),
    snapshot(targetSources, { filing: { taxYear: 2025 } }),
    snapshot(targetSources, { filing: { filerType: "my_business" } }),
    { ...snapshot(targetSources), business: null },
    {
      ...snapshot(targetSources),
      business: { ...servicesPayload, version: "services-tax-deduction-v0" },
    },
  ]) {
    assert.equal(
      main.getServicesPacketRoute(invalid).active,
      false,
      "any unverified payload or blocked set stays inactive",
    );
  }
});

/* -------------------------------------------- Q8: companion allowlists --- */

const salaryOwned = [
  {
    irisCode: "1009",
    column: "Total Amount",
    sourceGroup: "incomeFields",
    ourCategory: "SALARY_CERTIFICATE_GROSS",
    portalArea: "Employment",
    irisSection: "Salary",
    ourAmount: 2_400_000,
  },
  {
    irisCode: "64020004",
    column: "Tax Collected / Deducted",
    sourceGroup: "adjustableTaxFields",
    ourCategory: "TAX_149",
    irisSection: "Adjustable Tax",
    ourDescription: "Salary withholding from mapped salary certificate",
    ourAmount: 100_000,
  },
];

const pensionOwned = [
  {
    irisCode: "1008",
    column: "Total Amount",
    sourceGroup: "incomeFields",
    ourCategory: "PENSION",
    irisSection: "Salary",
    ourAmount: 12_000_000,
  },
  {
    irisCode: "64020004",
    column: "Taxable Amount",
    sourceGroup: "adjustableTaxFields",
    ourCategory: "PENSION_SALARY_149",
    irisSection: "Adjustable Tax",
    ourAmount: 14_400_000,
  },
  {
    irisCode: "64020004",
    column: "Tax Collected / Deducted",
    sourceGroup: "adjustableTaxFields",
    ourCategory: "PENSION_SALARY_149",
    irisSection: "Adjustable Tax",
    ourAmount: 300_000,
  },
];

test("the salary allowlist ignores pension-owned 64020004 rows instead of rejecting them", () => {
  const salary = main.getSalaryFieldsForServicesRoute(
    plain([...salaryOwned, ...pensionOwned]),
  );
  assert.equal(salary.invalid, false);
  assert.equal(salary.fields.length, 2);
  assert.deepEqual(
    plain(salary.fields.map((field) => `${field.irisCode}:${field.column}`)),
    ["1009:Total Amount", "64020004:Tax Collected / Deducted"],
  );

  // An unrelated salary row is still refused: the exclusion is category-exact.
  const stray = main.getSalaryFieldsForServicesRoute(
    plain([
      ...salaryOwned,
      ...pensionOwned,
      {
        irisCode: "1009",
        column: "Total Amount",
        sourceGroup: "incomeFields",
        ourCategory: "SALARY_LEDGER",
        portalArea: "Employment",
        irisSection: "Salary",
        ourAmount: 1,
      },
    ]),
  );
  assert.equal(stray.invalid, true);
});

test("the pension allowlist ignores salary-owned rows and still refuses unknown pension cells", () => {
  const pension = main.getPensionFieldsForServicesRoute(
    plain([...pensionOwned, ...salaryOwned]),
  );
  assert.equal(pension.invalid, false);
  assert.deepEqual(
    plain(pension.fields.map((field) => `${field.irisCode}:${field.column}`)),
    ["1008:Total Amount", "64020004:Taxable Amount", "64020004:Tax Collected / Deducted"],
  );

  const unknown = main.getPensionFieldsForServicesRoute(
    plain([
      ...pensionOwned,
      {
        irisCode: "1008",
        column: "Total Amount",
        sourceGroup: "incomeFields",
        ourCategory: "PENSION_MEDICAL",
        irisSection: "Salary",
        ourAmount: 1,
      },
    ]),
  );
  assert.equal(unknown.invalid, true);
});

/* ------------------------------------- Q1/L2: summed 923184 fail-closed --- */

const FINAL_PENSION = {
  version: "pension-source-v1",
  fingerprint: "a".repeat(64),
  treatment: "final_above_10m",
  annualPension: 12_000_000,
  baseTax: 100_000,
  surcharge: 10_000,
  taxDue: 110_000,
  taxDeducted: 100_000,
};

function finalPensionSnapshot({ salaryGross, normalSlabSurcharge }) {
  const fields = [
    { irisCode: "1008", column: "Total Amount", ourAmount: 12_000_000, ourCategory: "PENSION", sourceGroup: "incomeFields", irisSection: "Salary" },
    { irisCode: "1008", column: "Subject to Final Tax", ourAmount: 2_000_000, ourCategory: "PENSION", sourceGroup: "incomeFields", irisSection: "Salary" },
    { irisCode: "1008", column: "Subject to Exemption", ourAmount: 10_000_000, ourCategory: "PENSION", sourceGroup: "incomeFields", irisSection: "Salary" },
    { irisCode: "1009", column: "Total Amount", ourAmount: salaryGross, ourCategory: "SALARY_CERTIFICATE_GROSS", sourceGroup: "incomeFields", irisSection: "Salary" },
    { irisCode: "64020007", column: "Taxable Amount", ourAmount: 2_000_000, ourCategory: "PENSION_FINAL_TAX", sourceGroup: "adjustableTaxFields", irisSection: "Tax Deductions" },
    { irisCode: "64020007", column: "Tax Deducted", ourAmount: 100_000, ourCategory: "PENSION_FINAL_TAX", sourceGroup: "adjustableTaxFields", irisSection: "Tax Deductions" },
    {
      irisCode: "923184",
      column: "Total Income",
      ourAmount: 10_000 + (normalSlabSurcharge ?? 0),
      ourCategory: "PENSION_SURCHARGE",
      sourceGroup: "adjustableTaxFields",
      irisSection: "Computations",
    },
  ];
  return {
    filing: { taxYear: 2026, filerType: "myself", incomeSources: targetSources },
    pension: FINAL_PENSION,
    business: servicesPayload,
    portalFieldMap: fields,
    portalFieldMapDetailed: {
      incomeFields: fields,
      adjustableTaxFields: fields,
      mappingGaps: { unmappedCategories: [] },
      computationHints: {
        pensionSourceFingerprint: FINAL_PENSION.fingerprint,
        ...(normalSlabSurcharge === undefined
          ? {}
          : { normalSlabSurcharge }),
      },
    },
  };
}

test("L2: salary gross above PKR 10M keeps the summed 923184 fail-closed with a specific message", () => {
  const hold = pensionEntryHold(finalPensionSnapshot({ salaryGross: 12_000_000 }));
  assert.ok(hold, "guard pauses instead of typing an unproven summed surcharge");
  assert.match(
    String(hold.pauseMessage),
    /salary-slab Section 4AB surcharge/,
    "message names the unproven part",
  );
  assert.match(String(hold.pauseMessage), /923184/);
  assert.equal(hold.result.submitted, false);
});

test("L2: salary gross at or below PKR 10M keeps the pension-only 923184 contract valid", () => {
  assert.equal(
    pensionEntryHold(finalPensionSnapshot({ salaryGross: 6_000_000 })),
    null,
    "no slab surcharge is due, so the pension-only 923184 figure is provable",
  );
});

test("L2: a proven normal-slab surcharge is still accepted when it is carried in the packet", () => {
  assert.equal(
    pensionEntryHold(
      finalPensionSnapshot({ salaryGross: 12_000_000, normalSlabSurcharge: 449_000 }),
    ),
    null,
  );
});
