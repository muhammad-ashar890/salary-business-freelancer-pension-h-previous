"use strict";

/**
 * Exact route contract for Salary + Business + Freelancer / Services.
 * These tests exercise the production server gate and the production Electron
 * route resolver; they do not infer support from UI labels or documentation.
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
} = require("../lib/tax/business-bank-categories.ts");
const {
  buildSalaryBusinessServicesPlan,
} = require("../lib/tax/salary-business-services-plan.ts");
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
const routeFunction = mainAst.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "getServicesPacketRoute",
);
assert.ok(routeFunction, "production Electron route resolver exists");
const computationsResolver = mainAst.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "resolveAutofillComputationsPlan",
);
assert.ok(computationsResolver, "production Electron computations resolver exists");
const electron = vm.createContext({ console });
vm.runInContext(routeFunction.getText(mainAst), electron);
vm.runInContext(computationsResolver.getText(mainAst), electron);

const targetSources = ["salary", "business", "services"];
const servicesPayload = {
  version: "services-tax-deduction-v1",
  route: "services_tax_deduction",
  coverage: "services_tax_deduction_only",
  taxYear: 2026,
  fields: [{ irisCode: "3101", ourAmount: 1 }],
};
const snapshot = (incomeSources, overrides = {}) => ({
  filing: {
    taxYear: 2026,
    filerType: "myself",
    incomeSources,
    ...overrides,
  },
  business: {
    version: "business-entry-v9",
    fields: [{ irisCode: "3009", ourAmount: 1 }],
  },
  services: servicesPayload,
  salaryBusinessServices: {
    version: "salary-business-services-v1",
    computations: { version: "computations-v1" },
  },
});

test("server gate accepts exactly Salary + Business + Services in any selection order", () => {
  for (const incomeSources of [
    targetSources,
    ["services", "salary", "business"],
    '["business","services","salary"]',
  ]) {
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

test("server gate preserves every other supported and blocked route boundary", () => {
  for (const incomeSources of [
    ["services"],
    ["salary", "services"],
    ["business", "services"],
    ["pension", "services"],
  ]) {
    assert.equal(
      isSingleFreelancerServicesFiling({
        taxYear: 2026,
        filerType: "myself",
        incomeSources,
      }),
      true,
    );
  }
  for (const input of [
    { incomeSources: ["business", "pension", "services"] },
    { incomeSources: ["salary", "business", "pension", "services"] },
    { incomeSources: ["salary", "business", "services", "services"] },
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
    );
  }
});

test("Electron activates the exact triple only with a separate valid Services envelope", () => {
  const route = electron.getServicesPacketRoute(snapshot(targetSources));
  assert.equal(route.selected, true);
  assert.equal(route.exact, true);
  assert.equal(route.payloadValid, true);
  assert.equal(route.active, true);
  assert.equal(route.salaryIncluded, true);
  assert.equal(route.businessIncluded, true);
  assert.equal(route.pensionIncluded, false);

  for (const invalid of [
    snapshot(["business", "pension", "services"]),
    snapshot(targetSources, { taxYear: 2025 }),
    snapshot(targetSources, { filerType: "my_business" }),
    { ...snapshot(targetSources), services: null },
    { ...snapshot(targetSources), salaryBusinessServices: null },
  ]) {
    assert.equal(electron.getServicesPacketRoute(invalid).active, false);
  }
});

test("Electron plan resolver selects only the intended route's computations", () => {
  const triplePlan = { version: "computations-v1", marker: "triple" };
  const businessPlan = { version: "computations-v1", marker: "business" };
  const nonBusinessPlan = { version: "computations-v1", marker: "non-business" };
  const triple = {
    salaryBusinessServices: {
      version: "salary-business-services-v1",
      computations: triplePlan,
    },
    business: {
      version: "business-entry-v9",
      expectedIrisTotals: { computations: businessPlan },
    },
  };
  assert.equal(
    electron.resolveAutofillComputationsPlan(triple, true),
    triplePlan,
  );
  assert.equal(
    electron.resolveAutofillComputationsPlan(
      { business: { expectedIrisTotals: { computations: businessPlan } } },
      false,
    ),
    businessPlan,
  );
  assert.equal(
    electron.resolveAutofillComputationsPlan(
      { business: null, computations: nonBusinessPlan },
      false,
    ),
    nonBusinessPlan,
  );
  assert.equal(
    electron.resolveAutofillComputationsPlan(triple, false),
    businessPlan,
    "a non-Services Business run keeps its existing Business plan",
  );
  assert.equal(
    electron.resolveAutofillComputationsPlan(
      { business: { version: "business-entry-v9" } },
      true,
    ),
    null,
    "an existing Services route without the new envelope does not inherit Business computations",
  );
});

test("triple never inherits zero, negative or non-finite companion Normal Tax", () => {
  for (const inheritedNormalTax of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const plan = buildSalaryBusinessServicesPlan({
      taxYear: 2026,
      filerType: "myself",
      incomeSources: targetSources,
      businessExpectedIrisTotals: {
        rows: [
          { code: "9100", column: "normal", expected: 1000, proven: false, formula: "test" },
          { code: "920000", column: "total", expected: inheritedNormalTax, proven: false, formula: "test" },
        ],
        skipped: [],
        computations: {
          version: "computations-v1",
          expectedBusinessIncome: 1000,
          expectedTaxableIncome: 1000,
          expectedNormalTax: inheritedNormalTax,
          surcharge: { action: "TYPE", value: 0, basis: "test" },
          superTax: { action: "USER", value: 0, basis: "test" },
          minimumTaxRegime: "not_applicable",
        },
      },
      servicesFields: [],
      hasUnmappedPortalIncome: false,
    });
    assert.ok(plan);
    assert.equal(plan.normalTaxStatus, "user_review_required");
    assert.equal(plan.expectedNormalTax, null);
    assert.equal(plan.computations.expectedNormalTax, null);
    assert.equal(plan.computations.surcharge.action, "USER");
    assert.equal(plan.expectedIrisTotals.rows.some((row) => row.code === "920000"), false);
  }
});
