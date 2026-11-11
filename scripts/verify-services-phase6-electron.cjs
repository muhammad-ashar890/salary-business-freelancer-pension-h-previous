"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

// Load the shipped TypeScript packet builders. The point of this suite is the
// real Phase 5 -> server flattening -> Electron boundary, not a hand-copied
// approximation of those field shapes.
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithAlias(request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolveFilename.call(this, request, ...rest);
};
Module._extensions[".ts"] = function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
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

const { buildServicesPortalMappings } = require(
  path.join(root, "lib/tax/services-portal-map.ts"),
);
const {
  buildPortalFieldMap,
  filterCoveredSalary149TaxCredits,
  flattenPortalFieldMap,
} = require(path.join(root, "lib/tax/portal-field-map.ts"));
const { buildServicesTaxDeductionPacket } = require(
  path.join(root, "lib/tax/business-filing.ts"),
);
Module._resolveFilename = originalResolveFilename;

const navigation = require("../electron-connect/iris-navigation.js");
const rowFiller = require("../electron-connect/iris-row-filler.js");
const businessRows = require("../electron-connect/iris-business-row-driver.js");
const wealthDriver = require("../electron-connect/iris-wealth-driver.js");
const jobReport = require("../electron-connect/job-report.js");
const irisTourCensus = require("../electron-connect/iris-tour-census.js");

const mainSource = read("electron-connect/main.js");
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

const main = loadMain([
  "getServicesPacketRoute",
  "getServicesAutofillFields",
  "getSalaryFieldsForServicesRoute",
  "getPensionFieldsForServicesRoute",
  "buildHandoffScopeSummary",
], {
  autofillItemKey: (field) =>
    String(field.key || `${field.irisCode}:${field.column || ""}`),
});
// VM-created arrays/objects have another realm's prototypes; compare their
// JSON-safe values rather than requiring reference-prototype identity.
const plain = (value) => JSON.parse(JSON.stringify(value));

const mappings = buildServicesPortalMappings({
  invoices: [
    {
      id: "invoice-1",
      subcategory: "1b-service-it-ites",
      evidenceStatus: "CONFIRMED",
      sourceDocumentId: "invoice-doc-1",
      sourceDocumentExtractionStatus: "MAPPED",
      serviceDescription: "IT consultancy delivered under the signed work order",
      serviceCategoryHumanConfirmed: true,
      serviceCategoryEvidenceReference:
        "Invoice page 1, service category and scope reviewed",
      incomeCharacter: "TECHNICAL_PROFESSIONAL_FEE",
      incomeCharacterHumanConfirmed: true,
      incomeCharacterEvidenceReference: "Invoice page 1, technical scope clause",
      recognizedIncomePkr: 250550,
      paymentMatches: [
        {
          id: "match-1",
          withholdingTaxPkr: 4190,
          withholdingSection: "153(1)(b)",
          withholdingIrisCode: "64060158",
          withholdingEvidenceReference: "Tax certificate page 1, line 3",
          withholdingEvidenceHumanConfirmed: true,
          withholdingEvidenceDocumentId: "tax-doc-1",
          withholdingEvidenceDocumentExtractionStatus: "MAPPED",
          withholdingEvidenceDocumentType: "other_income_proof",
        },
      ],
    },
  ],
  incomeBySubcategory: { "1b-service-it-ites": 250550 },
  existingBusinessFields: [],
  taxCredits: [],
});

const salaryServiceFields = [
  {
    key: "1009:incomeFields:Total Amount",
    irisCode: "1009",
    value: "3600000",
    ourCategory: "SALARY_CERTIFICATE_GROSS",
    ourDescription: "Annual gross salary from mapped salary certificate",
    irisSection: "Salary",
    portalArea: "Employment",
    sourceGroup: "incomeFields",
    column: "Total Amount",
    isTaxField: false,
  },
  {
    key: "64020004:adjustableTaxFields:Tax Collected / Deducted",
    irisCode: "64020004",
    value: "360000",
    ourCategory: "TAX_149",
    ourDescription: "Section 149 salary withholding from mapped salary certificate → Tax Deducted",
    irisSection: "Adjustable Tax",
    portalArea: "Tax Chargeable / Payments",
    sourceGroup: "adjustableTaxFields",
    column: "Tax Collected / Deducted",
    isTaxField: true,
  },
];

const servicesPayload = buildServicesTaxDeductionPacket({
  taxYear: 2026,
  filerType: "myself",
  incomeSources: ["services"],
  businessFields: mappings.businessFields,
  withholdingFields: mappings.withholdingFields,
  withholdingGaps: mappings.withholdingGaps,
});

const flattenedServicesFields = flattenPortalFieldMap({
  version: "phase6-test",
  generatedAt: new Date(0).toISOString(),
  taxYear: 2026,
  filerType: "myself",
  taxpayerListStatus: "ATL",
  totalFields: mappings.businessFields.length + mappings.withholdingFields.length,
  businessFields: mappings.businessFields,
  incomeFields: [],
  adjustableTaxFields: mappings.withholdingFields,
  wealthFields: [],
  computationHints: { totalIncome: 0, taxableIncome: 0, totalTaxWithheld: 0 },
  selectorBundle: { version: "test", portalType: "IRIS_2_0" },
});

function snapshotWith({
  incomeSources = ["services"],
  taxYear = 2026,
  filerType = "myself",
  business = servicesPayload,
  portalFieldMap = flattenedServicesFields,
} = {}) {
  return {
    filing: { taxYear, filerType, incomeSources },
    business,
    portalFieldMap,
  };
}

const validSnapshot = snapshotWith({
  portalFieldMap: [
    {
      key: "salary-must-not-be-selected",
      irisCode: "1009",
      value: "999",
      sourceGroup: "incomeFields",
    },
    ...flattenedServicesFields,
    {
      key: "wealth-travels-separately",
      irisCode: "7012",
      value: "123",
      sourceGroup: "wealthFields",
    },
  ],
});

test("Phase 6 route is active only for TY2026 Myself Services-only, Salary+Services or Pension+Services packets", () => {
  const route = main.getServicesPacketRoute(validSnapshot);
  assert.deepEqual(
    {
      selected: route.selected,
      exact: route.exact,
      payloadValid: route.payloadValid,
      active: route.active,
    },
    { selected: true, exact: true, payloadValid: true, active: true },
  );

  assert.equal(
    main.getServicesPacketRoute(
      snapshotWith({ incomeSources: '["services"]' }),
    ).active,
    true,
    "the stored JSON-string form is read exactly, not substring-matched",
  );

  const combined = main.getServicesPacketRoute(
    snapshotWith({ incomeSources: ["services", "salary"] }),
  );
  assert.equal(combined.active, true);
  assert.equal(combined.salaryIncluded, true);
  assert.equal(combined.pensionIncluded, false);

  const pensionCombined = main.getServicesPacketRoute(
    snapshotWith({ incomeSources: ["services", "pension"] }),
  );
  assert.equal(pensionCombined.active, true);
  assert.equal(pensionCombined.salaryIncluded, false);
  assert.equal(pensionCombined.pensionIncluded, true);

  // P2 unlock: Business + Services now reaches the gates. The payload and
  // section checks downstream still gate every Business row, so this only means
  // the route is recognised, not that Business schedules are entered.
  const businessCombined = main.getServicesPacketRoute(
    snapshotWith({ incomeSources: ["services", "business"] }),
  );
  assert.equal(businessCombined.active, true);
  assert.equal(businessCombined.salaryIncluded, false);
  assert.equal(businessCombined.pensionIncluded, false);
  assert.equal(businessCombined.businessIncluded, true);

  const rejected = [
    snapshotWith({ incomeSources: ["services", "pension", "salary"] }),
    snapshotWith({ incomeSources: ["services", "salary", "property_rent"] }),
    snapshotWith({ incomeSources: ["services", "services"] }),
    snapshotWith({ taxYear: 2025 }),
    snapshotWith({ filerType: "my_business" }),
    snapshotWith({
      business: { ...servicesPayload, route: "business" },
    }),
    snapshotWith({
      business: { ...servicesPayload, coverage: "partial_manual_required" },
    }),
    snapshotWith({ business: { ...servicesPayload, fields: [] } }),
  ];
  for (const snapshot of rejected) {
    assert.equal(main.getServicesPacketRoute(snapshot).active, false);
  }
});

test("combined Salary + Services selects only the certificate-backed Salary 1009 and 64020004 cells", () => {
  const resolved = main.getSalaryFieldsForServicesRoute([
    ...flattenedServicesFields,
    ...salaryServiceFields,
    { irisCode: "7012", sourceGroup: "wealthFields" },
    { irisCode: "3101", sourceGroup: "businessFields" },
  ]);
  assert.equal(resolved.invalid, false);
  assert.deepEqual(
    plain(resolved.fields.map((field) => [field.irisCode, field.value])),
    [["1009", "3600000"], ["64020004", "360000"]],
  );
  const missingSalary = main.getSalaryFieldsForServicesRoute(flattenedServicesFields);
  assert.equal(missingSalary.invalid, true);
  const unverifiedWithholding = main.getSalaryFieldsForServicesRoute([
    ...salaryServiceFields,
    { ...salaryServiceFields[1], ourDescription: "Unreviewed Section 149 credit" },
  ]);
  assert.equal(unverifiedWithholding.invalid, true);

  // Phase 1 (Bug #7): a generic Section 149 FilingTaxCredit row is suppressed
  // when a MAPPED Salary Certificate covers Salary, so the reviewed certificate
  // remains authoritative and passes the Salary + Services allowlist. Without a
  // MAPPED certificate, an explicit Section 149 credit still fails closed.
  const explicitCredits = [
    {
      id: "explicit-149",
      section: "149",
      subcategory: "Salary",
      amount: 99999,
      source: "MANUAL",
    },
  ];
  const coveredMap = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: [],
    taxCredits: filterCoveredSalary149TaxCredits(explicitCredits, {
      hasMappedSalaryCertificate: true,
    }),
    salaryCertificateGrossSalary: 3600000,
    salaryCertificateTaxWithheld: 360000,
  });
  const coveredResolved = main.getSalaryFieldsForServicesRoute([
    ...flattenedServicesFields,
    ...flattenPortalFieldMap(coveredMap),
  ]);
  assert.equal(coveredResolved.invalid, false);
  assert.deepEqual(
    plain(coveredResolved.fields.map((field) => [field.irisCode, field.value])),
    [["1009", "3600000"], ["64020004", "360000"]],
  );

  const zeroCertMap = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: [],
    taxCredits: filterCoveredSalary149TaxCredits(explicitCredits, {
      hasMappedSalaryCertificate: true,
    }),
    salaryCertificateGrossSalary: 3600000,
    salaryCertificateTaxWithheld: 0,
  });
  const zeroCertResolved = main.getSalaryFieldsForServicesRoute([
    ...flattenedServicesFields,
    ...flattenPortalFieldMap(zeroCertMap),
  ]);
  assert.equal(zeroCertResolved.invalid, false);
  assert.deepEqual(
    plain(zeroCertResolved.fields.map((field) => [field.irisCode, field.value])),
    [["1009", "3600000"]],
  );

  const uncoveredMap = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: [],
    taxCredits: filterCoveredSalary149TaxCredits(explicitCredits, {
      hasMappedSalaryCertificate: false,
    }),
    salaryCertificateGrossSalary: 3600000,
    salaryCertificateTaxWithheld: null,
  });
  const uncoveredResolved = main.getSalaryFieldsForServicesRoute([
    ...flattenedServicesFields,
    ...flattenPortalFieldMap(uncoveredMap),
  ]);
  assert.equal(uncoveredResolved.invalid, true);
});

test("combined Pension + Services resolves only the approved pension IRIS cells", () => {
  const pensionFields = [
    { key: "1008:total", irisCode: "1008", column: "Total Amount", ourCategory: "PENSION", sourceGroup: "incomeFields", irisSection: "Salary" },
    { key: "1008:final", irisCode: "1008", column: "Subject to Final Tax", ourCategory: "PENSION", sourceGroup: "incomeFields", irisSection: "Salary" },
    { key: "1008:exempt", irisCode: "1008", column: "Subject to Exemption", ourCategory: "PENSION", sourceGroup: "incomeFields", irisSection: "Salary" },
    { key: "64020007:base", irisCode: "64020007", column: "Taxable Amount", ourCategory: "PENSION_FINAL_TAX", sourceGroup: "adjustableTaxFields", irisSection: "Tax Deductions" },
    { key: "64020007:wht", irisCode: "64020007", column: "Tax Deducted", ourCategory: "PENSION_FINAL_TAX", sourceGroup: "adjustableTaxFields", irisSection: "Tax Deductions" },
    { key: "923184:surcharge", irisCode: "923184", column: "Total Income", ourCategory: "PENSION_SURCHARGE", sourceGroup: "adjustableTaxFields", irisSection: "Computations" },
    { key: "services-income", irisCode: "3101", column: "Total Amount", ourCategory: "SERVICES_INCOME" },
  ];
  const resolved = main.getPensionFieldsForServicesRoute(pensionFields);
  assert.equal(resolved.invalid, false);
  assert.deepEqual(
    plain(resolved.fields.map((field) => [field.irisCode, field.column])),
    pensionFields.slice(0, 6).map((field) => [field.irisCode, field.column]),
  );
  assert.equal(
    main.getPensionFieldsForServicesRoute([
      ...pensionFields,
      { key: "unexpected-pension", irisCode: "1008", column: "Subject to Normal Tax", ourCategory: "PENSION", sourceGroup: "incomeFields", irisSection: "Salary" },
    ]).invalid,
    true,
    "an unapproved pension column must not enter the Services route",
  );
});

test("stored Services packet rows resolve only to their exact flattened Electron fields", () => {
  assert.equal(servicesPayload.fields[0].ourAmount, 250550);
  assert.equal(servicesPayload.fields[0].value, undefined, "stored packet row shape");
  assert.equal(servicesPayload.fields[1].ourAmount, 4190);
  assert.equal(servicesPayload.fields[1].taxableAmount, 250550);

  const resolved = main.getServicesAutofillFields(
    validSnapshot,
    validSnapshot.portalFieldMap,
  );
  assert.deepEqual(plain(resolved.unmatched), []);
  assert.deepEqual(plain(resolved.ambiguous), []);
  assert.deepEqual(
    plain(resolved.fields.map((field) => [field.irisCode, field.value, field.sourceGroup])),
    [
      ["3101", "250550", "businessFields"],
      ["64060158", "4190", "adjustableTaxFields"],
    ],
  );
  assert.ok(
    resolved.fields.every(
      (field) => rowFiller.validateServicesAutofillField(field).ok,
    ),
    "both resolved fields pass the independent Electron Services allowlist",
  );
  assert.ok(
    !resolved.fields.some((field) => ["1009", "7012"].includes(field.irisCode)),
    "Salary and Wealth cannot leak into the Services coded-field allowlist",
  );
});

test("a changed amount/evidence reference or duplicate flattened Services row fails resolution", () => {
  const changedAmount = structuredClone(validSnapshot.portalFieldMap);
  changedAmount.find((field) => field.irisCode === "64060158").value = "4191";
  let resolved = main.getServicesAutofillFields(validSnapshot, changedAmount);
  assert.equal(resolved.fields.length, 1);
  assert.deepEqual(
    plain(resolved.unmatched.map((field) => field.irisCode)),
    ["64060158"],
  );

  const changedEvidence = structuredClone(validSnapshot.portalFieldMap);
  changedEvidence.find((field) => field.irisCode === "3101").servicesEvidenceDocumentIds = [
    "different-document",
  ];
  resolved = main.getServicesAutofillFields(validSnapshot, changedEvidence);
  assert.deepEqual(
    plain(resolved.unmatched.map((field) => field.irisCode)),
    ["3101"],
  );

  const duplicated = structuredClone(validSnapshot.portalFieldMap);
  duplicated.push(
    structuredClone(duplicated.find((field) => field.irisCode === "3101")),
  );
  resolved = main.getServicesAutofillFields(validSnapshot, duplicated);
  assert.deepEqual(
    plain(resolved.ambiguous.map((field) => field.irisCode)),
    ["3101"],
  );
});

test("invalid Services packets stop inside runRealIrisAutofill before any worker window opens", async () => {
  let windowsOpened = 0;
  const sandbox = loadMain(
    [
      "getServicesPacketRoute",
      "getServicesAutofillFields",
      "getSalaryFieldsForServicesRoute",
      "autofillItemKey",
      "runLocalIrisNavigationCheck",
      "runRealIrisAutofill",
    ],
    {
      activeJobExecutionLog: null,
      pensionEntryHold: () => null,
      assertNavigatorBuild() {},
      pushStatus() {},
      async ensureWorkerWindow() {
        windowsOpened += 1;
        throw new Error("worker window must not open for an invalid packet");
      },
    },
  );

  const combined = await sandbox.runRealIrisAutofill(
    {
      filingPacket: {
        snapshot: snapshotWith({ incomeSources: ["services", "salary"] }),
      },
    },
    { id: "phase6-combined" },
    "live",
  );
  assert.equal(combined.paused, true);
  assert.equal(combined.pauseAction, "portal_state_confirmation");
  assert.equal(combined.result.businessCoverage, "salary_field_map_mismatch");

  const mismatchedMap = structuredClone(validSnapshot.portalFieldMap);
  mismatchedMap.find((field) => field.irisCode === "64060158").value = "1";
  const mismatch = await sandbox.runRealIrisAutofill(
    {
      filingPacket: {
        snapshot: snapshotWith({ portalFieldMap: mismatchedMap }),
      },
    },
    { id: "phase6-mismatch" },
    "live",
  );
  assert.equal(mismatch.paused, true);
  assert.equal(mismatch.result.businessCoverage, "services_field_map_mismatch");

  const navigationMismatch = await sandbox.runLocalIrisNavigationCheck(
    {
      filingPacket: {
        snapshot: snapshotWith({ portalFieldMap: mismatchedMap }),
      },
    },
    { id: "phase6-navigation-mismatch" },
  );
  assert.equal(navigationMismatch.paused, true);
  assert.equal(
    navigationMismatch.result.businessCoverage,
    "services_field_map_mismatch",
  );
  assert.equal(windowsOpened, 0);
});

test("Services planning uses only Other Revenues and the exact Business Tax Deduction group", () => {
  const resolved = main.getServicesAutofillFields(
    validSnapshot,
    validSnapshot.portalFieldMap,
  ).fields;
  const tour = {
    sections: [
      { id: "salary", mappingVerified: true, rows: [{ code: "1009" }] },
      {
        id: "business_other_revenues",
        mappingVerified: true,
        rows: [{ code: "3101" }],
      },
      { id: "business_tax_deduction", mappingVerified: true, rows: [] },
      {
        id: "business_trading",
        mappingVerified: true,
        rows: [{ code: "3000" }],
      },
    ],
  };
  const plan = navigation.planSectionFills(resolved, tour);
  assert.deepEqual(plan.unlocated, []);
  assert.deepEqual(
    plan.groups.map((group) => [
      group.sectionId,
      group.portalGroup,
      group.fields.map((field) => field.irisCode),
    ]),
    [
      ["business_other_revenues", null, ["3101"]],
      ["business_tax_deduction", "Minimum Tax", ["64060158"]],
    ],
  );

  assert.equal(
    navigation.isAllowedTaxDeductionTarget(
      "64060158",
      navigation.normalizeSetupLabel("Minimum Tax"),
      "business_tax_deduction",
    ),
    true,
  );
  assert.equal(
    navigation.isAllowedTaxDeductionTarget(
      "64060158",
      navigation.normalizeSetupLabel("Final Tax"),
      "business_tax_deduction",
    ),
    false,
  );
  assert.equal(
    navigation.isAllowedTaxDeductionTarget(
      "64020004",
      navigation.normalizeSetupLabel("Adjustable Tax"),
      "tax_deductions",
    ),
    true,
    "the established Salary withholding target is unchanged",
  );
});

test("Tax Deduction row creation accepts only the exact Services target and never runs in dry mode", async () => {
  const withholding = flattenedServicesFields.find(
    (field) => field.servicesMappingKind === "SERVICES_WITHHOLDING",
  );
  assert.deepEqual(businessRows.servicesTaxDeductionTarget(withholding), {
    code: "64060158",
    label: "Payment for IT/IT-enabled service u/s 153(1)(b) @4%",
    pickerLabels: [
      "Payment for IT/IT-enabled service u/s 153(1)(b) @4%",
      "Payment for Services u/s 153(1)(b) @4%",
    ],
    rowDescriptionLabels: [
      "Payment for IT/IT-enabled service u/s 153(1)(b) @4%",
      "Payment for Services u/s 153(1)(b) @4%",
    ],
    groupLabel: "Minimum Tax",
    dialogTitle: "Add Minimum Tax",
    writableInputIndexes: [0, 1],
  });
  assert.deepEqual(
    rowFiller.prepareField(withholding).rowDescriptionAliases,
    ["Payment for Services u/s 153(1)(b) @4%"],
    "the filler receives only the capture-backed, exact-code row-label alias",
  );

  const wrongGroup = { ...withholding, portalGroup: "Final Tax" };
  assert.equal(businessRows.servicesTaxDeductionTarget(wrongGroup), null);
  assert.equal(rowFiller.validateServicesAutofillField(wrongGroup).ok, false);
  assert.deepEqual(
    await businessRows.ensureTaxDeductionRows(null, [withholding], {
      mode: "dry",
    }),
    { ok: false, reason: "dry_run_no_row_creation" },
  );
  assert.deepEqual(
    await businessRows.ensureTaxDeductionRows(null, [wrongGroup], {
      mode: "live",
    }),
    {
      ok: false,
      reason: "services_tax_deduction_target_unverified",
      code: "64060158",
    },
    "target validation happens before navigation or any picker click",
  );
});

test("Services handoff is Services-only, hides the generic final-review item and records no-Save policy", () => {
  const scope = main.buildHandoffScopeSummary(
    { total: 2, filled: 2, skipped: 0 },
    false,
    [{ irisCode: "7012" }],
    {
      salarySummary: { total: 2, filled: 2, skipped: 0 },
      business: {
        total: 2,
        filled: 2,
        skipped: 0,
        mode: "live",
        coverage: "services_tax_deduction_only",
        pending: [
          {
            key: "servicesFinalReview",
            reason: "generic final-review wording that must not be shown",
          },
          {
            key: "servicesIncomeRow",
            reason: "a real evidence gap remains visible",
          },
        ],
      },
      wealth: {
        enabled: true,
        mode: "live",
        summary: { filled: 7, total: 7 },
      },
      employers: null,
      businessDetails: null,
      save: {
        status: "not_attempted",
        clicked: false,
        at: null,
        message: "",
        reason: "A scoped post-tab readback is required before the one draft Save.",
        routePolicy: "services_save_once",
      },
    },
  );

  assert.equal(scope.business.route, "services_tax_deduction");
  assert.equal(scope.business.status, "services_entered");
  assert.deepEqual(scope.business.pendingItems, [
    "servicesIncomeRow: a real evidence gap remains visible",
  ]);
  assert.equal(scope.salary, "not_applicable");
  assert.equal(scope.propertyPaymentsComputations, "not_applicable");
  assert.equal(scope.save.routePolicy, "services_save_once");
  assert.equal(scope.save.clicked, false);
  assert.match(scope.label, /Freelancer \/ Services 2\/2 verified field\(s\) entered/);
  assert.match(scope.label, /Wealth ✅ 7\/7 row\(s\) entered/);
  assert.match(scope.label, /draft Save is attempted only after scoped post-tab readback/i);
  assert.doesNotMatch(scope.label, /Salary|Business Details|press Calculate/);
});

test("combined Salary + Services handoff names both routes and keeps their field counts visible", () => {
  const scope = main.buildHandoffScopeSummary(
    { total: 13, filled: 13, skipped: 0 },
    false,
    [{ irisCode: "7087" }, { irisCode: "7030" }, { irisCode: "7098" }],
    {
      salarySummary: { total: 1, filled: 1, skipped: 0 },
      salaryIncluded: true,
      business: {
        total: 8, filled: 8, skipped: 0, mode: "live",
        coverage: "services_tax_deduction_only", pending: [],
      },
      wealth: { enabled: true, mode: "live", summary: { total: 3, filled: 3 } },
      save: { status: "not_attempted", clicked: false, routePolicy: "services_save_once", reason: "two figures need readback" },
    },
  );
  assert.equal(scope.salary, "filled");
  assert.equal(scope.salaryFields.total, 1);
  assert.equal(scope.salaryFields.filled, 1);
  assert.equal(scope.salaryFields.skipped, 0);
  assert.match(scope.label, /Salary 1\/1 \+ Freelancer \/ Services 8\/8 approved field\(s\) verified/);
});

test("combined Pension + Services handoff labels both sources and exposes pension readback totals", () => {
  const scope = main.buildHandoffScopeSummary(
    { total: 12, filled: 12, skipped: 0 },
    false,
    [],
    {
      pensionSummary: { total: 6, filled: 6, skipped: 0 },
      pensionIncluded: true,
      business: {
        total: 6, filled: 6, skipped: 0, mode: "live",
        coverage: "services_tax_deduction_only", pending: [],
      },
      save: { status: "not_attempted", clicked: false, routePolicy: "services_save_once", reason: "readback required" },
    },
  );
  assert.equal(scope.pension, "filled");
  assert.deepEqual(plain(scope.pensionFields), { total: 6, filled: 6, skipped: 0 });
  assert.equal(scope.salary, "not_applicable");
  assert.match(scope.label, /Pension 6\/6 \+ Freelancer \/ Services 6\/6 approved field\(s\) verified/);
});

test("Services draft Save gate requires every entered field to have a unique matching post-tab readback", () => {
  const entries = [
    { key: "3101:services", irisCode: "3101", status: "filled", value: "250550" },
    { key: "64060158:withholding", irisCode: "64060158", status: "already_correct", value: "4190" },
  ];
  const matches = [
    { key: entries[0].key, status: "match" },
    { key: entries[1].key, status: "match" },
  ];
  assert.equal(irisTourCensus.allEnteredEntriesReadBack(entries, matches), true);
  assert.equal(irisTourCensus.allEnteredEntriesReadBack(entries, matches.slice(0, 1)), false, "missing readback blocks Save");
  assert.equal(irisTourCensus.allEnteredEntriesReadBack(entries, [...matches.slice(0, 1), { key: entries[1].key, status: "not_seen" }]), false);
  assert.equal(irisTourCensus.allEnteredEntriesReadBack(entries, [...matches.slice(0, 1), { key: entries[1].key, status: "mismatch" }]), false);
  assert.equal(irisTourCensus.allEnteredEntriesReadBack(entries, [...matches, matches[1]]), false, "duplicate readback does not count");
  assert.equal(irisTourCensus.allEnteredEntriesReadBack([], []), false, "nothing entered is not a Save reason");
});

test("scoped census only clicks the requested Services view and avoids unrelated IRIS schedules", async () => {
  const actions = [];
  let activeTop = "Data";
  let activeLeft = "Other Revenues";
  const panels = [
    { label: "Business", expanded: true, tabs: [
      { label: "Other Revenues", active: false },
      { label: "Balance Sheet", active: true },
    ] },
    { label: "Employment", expanded: false, tabs: [{ label: "Salary", active: false }] },
  ];
  const state = (withView = false) => ({
    ok: true,
    dialogs: [],
    busy: false,
    topTabs: [
      { label: "Data", active: activeTop === "Data" },
      { label: "Payment", active: activeTop === "Payment" },
    ],
    panels,
    activeTop,
    activeLeft,
    ...(withView ? { view: { present: true, counts: { rows: 1, editable: 1, prefilled: 1 }, rows: [] } } : {}),
  });
  const frame = {
    url: "https://iris.fbr.gov.pk/return",
    async executeJavaScript(source) {
      const argStart = source.lastIndexOf(")(") + 2;
      const request = JSON.parse(source.slice(argStart, -1));
      if (request.op === "read") return state(Boolean(request.withView));
      actions.push(`${request.op}:${request.label || ""}`);
      if (request.op === "click_top") activeTop = request.label;
      if (request.op === "click_left") activeLeft = request.label;
      return { status: "clicked" };
    },
  };
  frame.framesInSubtree = [frame];
  const win = { isDestroyed: () => false, webContents: { mainFrame: frame, getURL: () => frame.url } };
  const tour = await irisTourCensus.runCensusTour(win, {
    label: "scoped services test",
    onlyViews: ["Business > Other Revenues"],
    settleTimeoutMs: 100,
    pollMs: 1,
  });
  assert.equal(tour.complete, true);
  assert.deepEqual(tour.views.map((view) => view.key), ["Business > Other Revenues"]);
  assert.ok(actions.some((action) => action === "click_left:Other Revenues"));
  assert.ok(!actions.some((action) => action === "click_left:Balance Sheet"));
  assert.ok(!actions.some((action) => action === "click_left:Salary"));
  assert.ok(!actions.some((action) => action === "click_top:Payment"));
});

test("job report records one gated Services draft Save and unsupported mappings as scope", () => {
  const report = jobReport
    .buildJobReport({
      finalStatus: "completed",
      savedAt: "2026-10-20T00:00:00.000Z",
      jobId: "phase6-services",
      build: "pension-services-multifiling-20261106a",
      executionLog: [
        {
          step: "iris_save_skipped",
          detail: "Save was not pressed: the scoped post-tab readback was not complete.",
          at: "2026-10-20T00:00:00.000Z",
        },
      ],
      result: {
        autofill: {
          salarySummary: { total: 1, filled: 1, skipped: 0 },
          salaryIncluded: true,
          results: [
            {
              irisCode: "3101",
              status: "filled",
              sectionId: "business_other_revenues",
              label: "Fee for Technical / Professional Services",
              value: "250550",
            },
            {
              irisCode: "64060158",
              status: "filled",
              sectionId: "business_tax_deduction",
              label: "Payment for IT/IT-enabled service u/s 153(1)(b) @4%",
              value: "4190",
            },
          ],
          employers: { prepared: [] },
          save: {
            status: "not_attempted",
            clicked: false,
            routePolicy: "services_save_once",
            reason: "the scoped post-tab readback was not complete.",
          },
        },
      },
    })
    .join("\n");

  assert.match(report, /SAVE \(Salary \+ Freelancer \/ Services draft-save policy\)/);
  assert.match(report, /Not pressed: the scoped post-tab readback was not complete/);
  assert.doesNotMatch(report, /Save: pressed once by the agent/);
  const pensionReport = jobReport.buildJobReport({
    finalStatus: "completed",
    savedAt: "2026-10-20T00:00:00.000Z",
    jobId: "phase6-pension-services",
    build: "pension-services-multifiling-20261106a",
    executionLog: [],
    result: {
      autofill: {
        pensionIncluded: true,
        salaryIncluded: false,
        save: {
          status: "not_attempted",
          clicked: false,
          routePolicy: "services_save_once",
          reason: "the scoped readback was not complete.",
        },
      },
    },
  }).join("\\n");
  assert.match(pensionReport, /SAVE \(Pension \+ Freelancer \/ Services draft-save policy\)/);
  assert.deepEqual(
    jobReport.classifyFieldResult({ status: "services_mapping_unverified" }),
    { outcome: "NOT_SUPPORTED_YET", category: "SCOPE" },
  );
});

test("only captured Wealth expense rows with transient UI statuses are automatic-retry work", () => {
  assert.equal(
    wealthDriver.isRetryableExpenseResult({
      irisCode: "7051",
      status: "row_not_found",
    }),
    true,
  );
  assert.equal(
    wealthDriver.isRetryableExpenseResult({
      irisCode: "7087",
      status: "wealth_setup_failed",
    }),
    true,
  );
  assert.equal(
    wealthDriver.isRetryableExpenseResult({
      irisCode: "7030",
      status: "row_not_found",
    }),
    false,
    "bank rows keep their own policy",
  );
  assert.equal(
    wealthDriver.isRetryableExpenseResult({
      irisCode: "7051",
      status: "overwrite_needs_confirmation",
    }),
    false,
    "a value conflict is not automatic retry work",
  );
});

test("packaged agent identity, Services contract and web handoff contract stay wired", () => {
  const electronPackage = JSON.parse(read("electron-connect/package.json"));
  const electronLock = JSON.parse(read("electron-connect/package-lock.json"));
  assert.equal(electronPackage.version, "1.0.5");
  assert.equal(electronLock.version, "1.0.5");
  assert.equal(electronLock.packages[""].version, "1.0.5");
  assert.ok(electronPackage.build.files.includes("iris-services-contract.json"));
  const sharedBuildTag = navigation.BUILD_TAG;
  assert.equal(typeof sharedBuildTag, "string");
  assert.ok(sharedBuildTag.length > 0);
  assert.equal(rowFiller.BUILD_TAG, sharedBuildTag);
  assert.equal(businessRows.BUILD_TAG, sharedBuildTag);
  assert.equal(wealthDriver.BUILD_TAG, sharedBuildTag);
  assert.equal(jobReport.BUILD_TAG, sharedBuildTag);

  const contractHash = crypto
    .createHash("sha256")
    .update(
      fs
        .readFileSync(path.join(root, "electron-connect/iris-services-contract.json"), "utf8")
        .replace(/\r\n/g, "\n"),
    )
    .digest("hex");
  assert.equal(
    contractHash,
    "b0e834fa8df94c3ee4bd888504ed9073a72e75877cce560ed0f33bd799a2ed88",
  );

  const server = read("app/actions/fbr-jobs.ts");
  assert.match(server, /route: scope\.business\.route === "services_tax_deduction"/);
  assert.match(server, /salaryFields:\s*\{/);
  assert.match(server, /pensionFields:\s*\{/);
  assert.match(server, /hasLegacySalaryRows/);
  assert.match(server, /"1009", "64020004"/);
  assert.match(server, /"services_entered"/);
  assert.match(server, /save\.routePolicy === "services_save_once"/);

  const client = read("components/tax/fbr-connect-client.tsx");
  for (const needle of [
    "servicesRoute",
    "portal_state_confirmation",
    "portal_expense_retry",
    "automaticRetryPause",
    "Retry automatic filing",
    "servicesRouteName",
    "Salary + Freelancer / Services",
    "Pension + Freelancer / Services",
    "including Salary + Services or Pension + Services",
    "it may press Save once at the end",
    "If all scoped figures pass readback, it will press Save once at the end",
    "Draft Save was not pressed (${save?.reason",
    "saveReadbackVerified",
    "Draft Save pressed — verify in FBR",
  ]) {
    assert.ok(client.includes(needle), `FBR Connect client carries ${needle}`);
  }

  assert.match(mainSource, /routePolicy: "services_save_once"/);
  assert.match(mainSource, /if \(mode === "live"\) \{/);
  assert.match(mainSource, /onlyViews: requestedViews/);
  assert.match(mainSource, /allEnteredEntriesReadBack/);
  assert.match(mainSource, /services_readback_retry/);
  assert.match(mainSource, /final scoped readback did not confirm/);
  assert.match(mainSource, /portal_expense_retry/);
});
