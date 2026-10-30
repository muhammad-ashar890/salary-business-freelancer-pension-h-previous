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
const { flattenPortalFieldMap } = require(
  path.join(root, "lib/tax/portal-field-map.ts"),
);
const { buildServicesTaxDeductionPacket } = require(
  path.join(root, "lib/tax/business-filing.ts"),
);
Module._resolveFilename = originalResolveFilename;

const navigation = require("../electron-connect/iris-navigation.js");
const rowFiller = require("../electron-connect/iris-row-filler.js");
const businessRows = require("../electron-connect/iris-business-row-driver.js");
const wealthDriver = require("../electron-connect/iris-wealth-driver.js");
const jobReport = require("../electron-connect/job-report.js");

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
  "buildHandoffScopeSummary",
]);
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

test("Phase 6 route is active only for the exact TY2026 Myself single-Services packet", () => {
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

  const rejected = [
    snapshotWith({ incomeSources: ["services", "salary"] }),
    snapshotWith({ incomeSources: ["business", "services"] }),
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
  assert.equal(combined.result.businessCoverage, "services_payload_missing");

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
    groupLabel: "Minimum Tax",
    dialogTitle: "Add Minimum Tax",
    writableInputIndexes: [0, 1],
  });

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
        reason: "Save is not pressed on the Freelancer / Services route.",
        routePolicy: "services_no_save",
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
  assert.equal(scope.save.routePolicy, "services_no_save");
  assert.equal(scope.save.clicked, false);
  assert.match(scope.label, /Freelancer \/ Services 2\/2 verified field\(s\) entered/);
  assert.match(scope.label, /Wealth ✅ 7\/7 row\(s\) entered/);
  assert.match(scope.label, /Save not pressed on this route/);
  assert.doesNotMatch(scope.label, /Salary|Business Details|press Calculate/);
});

test("job report treats Services no-Save as route policy and unsupported mappings as scope, not a Save failure", () => {
  const report = jobReport
    .buildJobReport({
      finalStatus: "completed",
      savedAt: "2026-10-20T00:00:00.000Z",
      jobId: "phase6-services",
      build: "wealth-recon-20261027f",
      executionLog: [
        {
          step: "iris_save_skipped",
          detail: "Save was not pressed: the Freelancer / Services route never presses Save.",
          at: "2026-10-20T00:00:00.000Z",
        },
      ],
      result: {
        autofill: {
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
            routePolicy: "services_no_save",
            reason: "Save is not pressed on the Freelancer / Services route.",
          },
        },
      },
    })
    .join("\n");

  assert.match(report, /SAVE \(Freelancer \/ Services route policy\)/);
  assert.match(report, /Save is never pressed on this route/);
  assert.doesNotMatch(report, /Save: pressed once by the agent/);
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
  assert.equal(navigation.BUILD_TAG, "wealth-recon-20261027f");
  assert.equal(rowFiller.BUILD_TAG, "wealth-recon-20261027f");
  assert.equal(businessRows.BUILD_TAG, "wealth-recon-20261027f");
  assert.equal(wealthDriver.BUILD_TAG, "wealth-recon-20261027f");
  assert.equal(jobReport.BUILD_TAG, "wealth-recon-20261027f");

  const contractHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(root, "electron-connect/iris-services-contract.json")))
    .digest("hex");
  assert.equal(
    contractHash,
    "04c3dfc3b8a17f3298d15b31e020b98b8ff610448ff1b15ed6408d09e615b7c0",
  );

  const server = read("app/actions/fbr-jobs.ts");
  assert.match(server, /route: scope\.business\.route === "services_tax_deduction"/);
  assert.match(server, /"services_entered"/);
  assert.match(server, /save\.routePolicy === "services_no_save"/);

  const client = read("components/tax/fbr-connect-client.tsx");
  for (const needle of [
    "servicesRoute",
    "portal_state_confirmation",
    "portal_expense_retry",
    "automaticRetryPause",
    "Retry automatic filing",
    "Freelancer / Services — verified field entry",
  ]) {
    assert.ok(client.includes(needle), `FBR Connect client carries ${needle}`);
  }

  assert.match(mainSource, /routePolicy: "services_no_save"/);
  assert.match(mainSource, /if \(mode === "live" && !servicesRouteActive\) \{/);
  assert.match(mainSource, /portal_expense_retry/);
});
