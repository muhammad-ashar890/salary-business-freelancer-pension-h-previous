#!/usr/bin/env node
/**
 * Freelancer + Business combined return: the ONE IRIS cell both sources share.
 *
 * Research (FB_UNLOCK_PLAN.md, P4 + P7) established, from the files and from a
 * live 114(1) test return, that IRIS has no Freelancer section: the Business
 * packet writes `Other Revenues / 3101 / Total Amount` for technical and
 * professional fees and the Services packet writes THE SAME cell for approved
 * Services income. `3129` (Other Revenues) and `3000` (Income/(Loss) from
 * Business) are all-disabled auto-totals. So a combined return must produce
 * exactly one figure per shared cell — the sum — and any second row for the
 * same cell is a double count or a dropped figure, not an extra row.
 *
 * These tests run the real boundary (Services mapper -> fold -> the Electron
 * gate that decides what may be typed), because a fold that only exists in a
 * helper would still let a packet ship two rows for one cell.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (relative) =>
  fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithAlias(request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolveFilename.call(this, request, ...rest);
};
Module._extensions[".ts"] = function loadTypeScript(module, filename) {
  const output = ts.transpileModule(read(path.relative(root, filename)), {
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
  mergeBusinessAndServicesFields,
  sharedBusinessFieldKey,
} = require(path.join(root, "lib/tax/business-services-shared-fields.ts"));
const { flattenPortalFieldMap } = require(
  path.join(root, "lib/tax/portal-field-map.ts"),
);
Module._resolveFilename = originalResolveFilename;

const CONTRACT = require("../electron-connect/iris-business-contract.json");

// ---------------------------------------------------------------- fixtures

/** A Business > Other Revenues row, shaped like business-schedule-fields.ts. */
const businessRow = (code, amount, extra = {}) => ({
  ourCategory:
    code === "3101" ? "BUSINESS_REVENUE_TECHNICALFEES" : "BUSINESS_OTHER_REVENUE_SPECIFIED",
  ourDescription: "Other Revenue - Technical and Professional Fees",
  ourAmount: amount,
  irisCode: code,
  irisDescription:
    extra.irisDescription ??
    (CONTRACT.business_other_revenues.rows[code] || { label: `row ${code}` }).label,
  portalArea: "Business",
  section: "Other Revenues",
  column: "Total Amount",
  isTaxField: false,
  sourceEntryCount: 1,
  ...extra,
});

const SECTION_OF_SUBCATEGORY = Object.fromEntries(
  Object.entries(
    require("../electron-connect/iris-services-contract.json").approvedServicesMapping
      .withholdingBySubcategory,
  ).map(([subcategory, mapping]) => [subcategory, mapping]),
);

function invoice(overrides = {}) {
  const subcategory = String(overrides.subcategory ?? "1b-service-it-ites");
  const approved = SECTION_OF_SUBCATEGORY[subcategory];
  const match = {
    id: `match-${subcategory}`,
    withholdingTaxPkr: 7000,
    withholdingSection: approved.statutorySection,
    withholdingIrisCode: approved.irisCodes[0],
    withholdingEvidenceReference: "Withholding certificate page 1, line 2",
    withholdingEvidenceHumanConfirmed: true,
    withholdingEvidenceDocumentId: `cert-${subcategory}`,
    withholdingEvidenceDocumentExtractionStatus: "MAPPED",
    withholdingEvidenceDocumentType: "other_income_proof",
    ...(overrides.payment || {}),
  };
  const { payment, ...invoiceFields } = overrides;
  return {
    id: `invoice-${subcategory}`,
    subcategory,
    evidenceStatus: "CONFIRMED",
    sourceDocumentId: `doc-${subcategory}`,
    sourceDocumentExtractionStatus: "MAPPED",
    serviceDescription: "Export of IT-enabled services under the signed contract",
    serviceCategoryHumanConfirmed: true,
    serviceCategoryEvidenceReference: "Invoice page 1, service category and scope",
    incomeCharacter: "TECHNICAL_PROFESSIONAL_FEE",
    incomeCharacterHumanConfirmed: true,
    incomeCharacterEvidenceReference: "Invoice page 1, technical scope clause",
    recognizedIncomePkr: 8000000,
    paymentMatches: [match],
    ...invoiceFields,
  };
}

function servicesMappings(invoices, options = {}) {
  return buildServicesPortalMappings({
    invoices,
    incomeBySubcategory: invoices.reduce((acc, entry) => {
      acc[entry.subcategory] =
        (acc[entry.subcategory] ?? 0) + entry.recognizedIncomePkr;
      return acc;
    }, {}),
    existingBusinessFields: options.existingBusinessFields ?? [],
    sharedBusinessTargetCodes: options.sharedBusinessTargetCodes,
    taxCredits: [],
  });
}

const cellCounts = (fields) => {
  const counts = new Map();
  for (const field of fields) {
    const key = sharedBusinessFieldKey(field);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

// ------------------------------------------------- 1: the Services mapper fold

test("Services income is MAPPED, not left manual, when the Business row is declared foldable", () => {
  const businessFields = [businessRow("3101", 500000)];

  const withoutFold = servicesMappings([invoice()], {
    existingBusinessFields: businessFields,
  });
  assert.equal(
    withoutFold.businessFields.filter((field) => field.servicesMappingKind === "SERVICES_INCOME")
      .length,
    0,
    "the untouched route must still keep the figure manual",
  );
  assert.match(
    JSON.stringify(withoutFold.incomeGaps),
    /Business row 3101 already has a separate packet value/,
    "the fail-closed reason must stay worded as before",
  );

  const withFold = servicesMappings([invoice()], {
    existingBusinessFields: businessFields,
    sharedBusinessTargetCodes: ["3101", "3128"],
  });
  const income = withFold.businessFields.filter(
    (field) => field.servicesMappingKind === "SERVICES_INCOME",
  );
  assert.ok(
    income.some((field) => field.column === "Total Amount" && String(field.irisCode) === "3101"),
    "the shared income row is emitted instead of being kept manual",
  );
  const total = income.find((field) => field.column === "Total Amount");
  assert.equal(total.irisCode, "3101");
  assert.equal(total.ourAmount, 8000000);
  assert.deepEqual(withFold.incomeGaps, [], "no Services income may be dropped");
});

test("a declared fold keeps every evidence gate: an unconfirmed invoice stays manual", () => {
  const result = servicesMappings(
    [invoice({ incomeCharacterHumanConfirmed: false })],
    {
      existingBusinessFields: [businessRow("3101", 500000)],
      sharedBusinessTargetCodes: ["3101", "3128"],
    },
  );
  assert.equal(
    result.businessFields.filter((field) => field.servicesMappingKind === "SERVICES_INCOME")
      .length,
    0,
    "a fold must not become a way to type unreviewed income",
  );
});

// ------------------------------------------------------- 2: the fold arithmetic

const SERVICES_FIXTURE = servicesMappings([invoice()], {
  existingBusinessFields: [businessRow("3101", 500000)],
  sharedBusinessTargetCodes: ["3101", "3128"],
}).businessFields;

test("the two Business-grid figures fold into one summed row, per cell", () => {
  const services = SERVICES_FIXTURE;
  const merged = mergeBusinessAndServicesFields({
    businessFields: [
      businessRow("3101", 500000, {
        sourceEvidenceReferences: ["Business Books row: Other Revenue - Technical and Professional Fees"],
      }),
      businessRow("3039", 100000, { section: "Manufacturing/ Trading Items", column: "Total Amount", irisDescription: "Opening Stock" }),
    ],
    servicesFields: services,
    incomeSources: ["business", "services"],
  });

  const shared = merged.fields.filter(
    (field) => String(field.irisCode) === "3101" && field.column === "Total Amount",
  );
  assert.equal(shared.length, 1, "IRIS has one 3101 Total Amount input box");
  assert.equal(shared[0].ourAmount, 8500000, "500,000 Business + 8,000,000 Services");
  assert.equal(shared[0].sourceEntryCount, 2, "one Business head + one invoice");
  assert.deepEqual(
    merged.merged,
    [
      {
        irisCode: "3101",
        column: "Total Amount",
        businessAmount: 500000,
        servicesAmount: 8000000,
        totalAmount: 8500000,
        businessOurCategory: "BUSINESS_REVENUE_TECHNICALFEES",
        servicesOurCategory: "SERVICES_TECHNICAL_PROFESSIONAL_FEE",
      },
    ],
  );
  assert.deepEqual(
    shared[0].sourceEvidenceReferences,
    [
      "Business Books row: Other Revenue - Technical and Professional Fees",
      ...new Set(
        services
          .filter((field) => field.column === "Total Amount")
          .flatMap((field) => field.sourceEvidenceReferences ?? []),
      ),
    ].sort(),
    "both sides' evidence travels with the figure",
  );
  assert.equal(shared[0].fbSharedCell.businessAmount, 500000);
  assert.equal(shared[0].fbSharedCell.servicesAmount, 8000000);
  assert.equal(
    merged.fields.filter((field) => String(field.irisCode) === "3039").length,
    1,
    "a Business-only row travels unchanged",
  );
});

test("the 154A 'Subject to Final Tax' row is never folded away", () => {
  const services = servicesMappings([invoice({ subcategory: "export-it-ites-pseb" })], {
    existingBusinessFields: [businessRow("3101", 500000)],
    sharedBusinessTargetCodes: ["3101", "3128"],
  }).businessFields;
  const finalTax = services.filter((field) => field.column === "Subject to Final Tax");
  assert.equal(
    finalTax.length,
    services.filter(
      (field) => String(field.irisCode) === "3101" && field.column === "Total Amount",
    ).length,
    "a 154A receipt that fills Total Amount must also fill Subject to Final Tax",
  );
  assert.equal(finalTax.length, 1, "the 154A subcategory emits the final-tax split");
  const merged = mergeBusinessAndServicesFields({
    businessFields: [businessRow("3101", 500000)],
    servicesFields: services,
    incomeSources: ["business", "services"],
  });
  const kept = merged.fields.filter(
    (field) => String(field.irisCode) === "3101" && field.column === "Subject to Final Tax",
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].ourAmount, finalTax[0].ourAmount);
  assert.equal(kept[0].fbSharedCell, undefined, "no Business figure shares that cell");
});

// ------------------------------------------- 3: the no-double-count invariants

test("invariant: a combined map never holds two rows for the same IRIS cell", () => {
  const services = servicesMappings(
    [invoice(), invoice({ id: "invoice-second", recognizedIncomePkr: 1250000 })],
    {
      existingBusinessFields: [businessRow("3101", 500000), businessRow("3128", 250000)],
      sharedBusinessTargetCodes: ["3101", "3128"],
    },
  ).businessFields;
  const merged = mergeBusinessAndServicesFields({
    businessFields: [businessRow("3101", 500000), businessRow("3128", 250000)],
    servicesFields: services,
    incomeSources: ["business", "services"],
  });
  for (const [, count] of cellCounts(merged.fields)) {
    assert.equal(count, 1, "each IRIS cell is typed exactly once");
  }
  const total3101 = merged.fields.find(
    (field) => String(field.irisCode) === "3101" && field.column === "Total Amount",
  );
  assert.equal(total3101.ourAmount, 500000 + 8000000 + 1250000);
  const sumOfServices = services
    .filter(
      (field) =>
        field.servicesMappingKind === "SERVICES_INCOME" &&
        field.column === "Total Amount",
    )
    .reduce((sum, field) => sum + field.ourAmount, 0);
  assert.equal(
    total3101.ourAmount - 500000,
    sumOfServices,
    "every Services rupee is inside the folded row exactly once",
  );
});

test("an ambiguous shared cell stays manual instead of guessing a target", () => {
  const merged = mergeBusinessAndServicesFields({
    businessFields: [
      businessRow("3101", 500000),
      businessRow("3101", 400000, { rowDescriptionIncludes: "second head" }),
    ],
    servicesFields: [
      {
        ...businessRow("3101", 800000),
        ourCategory: "SERVICES_TECHNICAL_PROFESSIONAL_FEE",
        servicesMappingKind: "SERVICES_INCOME",
      },
    ],
    incomeSources: ["business", "services"],
  });
  assert.equal(
    merged.fields.filter((field) => String(field.irisCode) === "3101").length,
    0,
    "neither Business row absorbs the Services figure",
  );
  assert.equal(merged.unmapped.length, 1);
  assert.equal(merged.unmapped[0].irisCode, "3101");
  assert.equal(merged.unmapped[0].amount, 800000);
  assert.match(merged.unmapped[0].reason, /2 Business rows already claim that single cell/);
});

test("a Services-only return keeps its own row and gains nothing", () => {
  const services = servicesMappings([invoice()]).businessFields;
  const merged = mergeBusinessAndServicesFields({
    businessFields: [],
    servicesFields: services,
    incomeSources: ["services"],
  });
  assert.deepEqual(merged.merged, []);
  assert.equal(merged.combined, false);
  assert.deepEqual(
    merged.fields.map((field) => [field.irisCode, field.column, field.ourAmount]),
    services.map((field) => [field.irisCode, field.column, field.ourAmount]),
  );
});

// ------------------------------------- 4: the Electron gate reads the new slot

const mainAst = ts.createSourceFile(
  "main.js",
  read("electron-connect/main.js"),
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
const main = (() => {
  const context = vm.createContext({
    console,
    Date,
    Promise,
    autofillItemKey: (field) =>
      String(field.key || `${field.irisCode}:${field.column || ""}`),
  });
  // Exactly the two host functions, as the Phase 6 harness does: the combined
  // checks are locals inside them, so nothing else may be required.
  for (const name of ["getServicesPacketRoute", "getServicesAutofillFields"]) {
    vm.runInContext(functionSource(name), context);
  }
  return context;
})();
const plain = (value) => JSON.parse(JSON.stringify(value));

const servicesPayloadForGate = (rows) => ({
  version: "services-tax-deduction-v1",
  route: "services_tax_deduction",
  taxYear: 2026,
  coverage: "services_tax_deduction_only",
  fields: rows,
});

test("a combined route activates from snapshot.services, and a Business-only one still does not", () => {
  const folded = mergeBusinessAndServicesFields({
    businessFields: [businessRow("3101", 500000)],
    servicesFields: servicesMappings([invoice()], {
      existingBusinessFields: [businessRow("3101", 500000)],
      sharedBusinessTargetCodes: ["3101", "3128"],
    }).businessFields,
    incomeSources: ["business", "services"],
  });
  const servicesRows = servicesMappings([invoice()], {
    existingBusinessFields: [businessRow("3101", 500000)],
    sharedBusinessTargetCodes: ["3101", "3128"],
  }).businessFields.map((field) => ({
    ...field,
    fbSharedCell:
      field.column === "Total Amount"
        ? { businessAmount: 500000, businessOurCategory: "BUSINESS_REVENUE_TECHNICALFEES" }
        : undefined,
  }));

  // Flattened by the real builder, so this asserts the production row shape.
  const flat = flattenPortalFieldMap({
    version: "test",
    generatedAt: new Date(0).toISOString(),
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    totalFields: folded.fields.length,
    businessFields: folded.fields,
    incomeFields: [],
    adjustableTaxFields: [],
    wealthFields: [],
    computationHints: { totalIncome: 0, taxableIncome: 0, totalTaxWithheld: 0 },
    selectorBundle: { version: "test", portalType: "IRIS_2_0" },
  });
  const combined = {
    filing: { taxYear: 2026, filerType: "myself", incomeSources: ["business", "services"] },
    business: {
      version: "business-entry-v9",
      fields: [businessRow("3101", 500000), businessRow("3039", 100000)],
    },
    services: servicesPayloadForGate(servicesRows),
    portalFieldMap: flat,
  };

  const route = main.getServicesPacketRoute(combined);
  assert.equal(route.businessIncluded, true);
  assert.equal(route.payloadValid, true, "the Services slot, not the Business packet, is validated");
  assert.equal(route.active, true, "a combined packet must not be paused for lacking a Business payload");

  const resolved = main.getServicesAutofillFields(
    combined,
    combined.portalFieldMap,
  );
  assert.deepEqual(plain(resolved.unmatched), [], "the folded row must satisfy the cross-check");
  assert.deepEqual(plain(resolved.ambiguous), []);
  const typed3101 = resolved.fields.filter((field) => String(field.irisCode) === "3101");
  assert.equal(
    typed3101.length,
    servicesRows.filter((row) => String(row.irisCode) === "3101").length,
    "every approved Services row for 3101 stays typed",
  );
  assert.ok(typed3101.length >= 1);
  assert.equal(
    typed3101.find((field) => field.column === "Total Amount").value,
    "8500000",
    "the figure typed into IRIS is the sum",
  );

  // A tampered cell amount (Business half missing) must fail closed.
  const tampered = {
    ...combined,
    portalFieldMap: combined.portalFieldMap.map((field) =>
      field.column === "Total Amount" && String(field.irisCode) === "3101"
        ? { ...field, value: "500000" }
        : field,
    ),
  };
  assert.ok(
    main.getServicesAutofillFields(tampered, tampered.portalFieldMap).unmatched.length > 0,
    "typing only the Business half while the packet promises a fold must pause",
  );

  // The old (pre-fold) snapshot shape keeps working: Services IS snapshot.business.
  const servicesOnly = {
    filing: { taxYear: 2026, filerType: "myself", incomeSources: ["services"] },
    business: servicesPayloadForGate(servicesRows.map((row) => ({ ...row, fbSharedCell: undefined }))),
    portalFieldMap: [],
  };
  assert.equal(main.getServicesPacketRoute(servicesOnly).active, true);

  const businessOnly = {
    filing: { taxYear: 2026, filerType: "myself", incomeSources: ["business"] },
    business: { version: "business-entry-v9", fields: [businessRow("3101", 500000)] },
    portalFieldMap: [],
  };
  const businessRoute = main.getServicesPacketRoute(businessOnly);
  assert.equal(businessRoute.selected, false);
  assert.equal(businessRoute.active, false, "a Business-only return stays on its own path");
});

// ------------------------------------------------- 5: the wiring is not optional

test("packet builder and agent are wired for the combined slot", () => {
  const packet = read("app/actions/packet.ts");
  assert.match(
    packet,
    /const servicesBusinessPayload = buildServicesTaxDeductionPacket\(/,
    "the Services envelope must be built even when Business is present",
  );
  assert.doesNotMatch(
    packet,
    /servicesBusinessPayload = business\n?\s*\?\s*null\n?\s*:/,
    "the old `business ? null :` short-circuit must be gone",
  );
  assert.match(
    packet,
    /services:\s*\{\s*\.\.\.servicesSnapshot,\s*version: "services-tax-deduction-v1"/,
    "the Services envelope must travel in its own snapshot slot",
  );
  assert.match(packet, /sharedBusinessTargetCodes: business \? \["3101", "3128"\] : \[\]/);
  assert.match(packet, /portalFieldMap\.businessFields = combined\.fields/);
  assert.match(packet, /BUSINESS_SERVICES_SHARED_ROW_/);

  const mainSource = read("electron-connect/main.js");
  assert.match(
    mainSource,
    /const getServicesPayload = \(value\) =>/,
    "the route must resolve the Services envelope (a local, not a module global)",
  );
  assert.match(
    mainSource,
    /const servicesPayload =\n\s+snapshot\?\.services\?\.version === "services-tax-deduction-v1"/,
    "the cross-check must read snapshot.services",
  );
  assert.equal(
    (mainSource.match(/const isCombinedBusinessServicesRun = Boolean\(/g) || []).length,
    2,
    "both host functions of a combined run must know about the fold",
  );
  assert.match(
    mainSource,
    /\.\.\.\(isCombinedBusinessServicesRun/,
    "a combined run must keep typing the Business grid, not only the Services rows",
  );
  assert.doesNotMatch(
    mainSource,
    /^function getServicesPayload\(/m,
    "no new module-level helper: the Phase 6 harness loads single functions",
  );

  // The Services mapper must not lose its old guard: the fold is opt-in.
  const mapper = read("lib/tax/services-portal-map.ts");
  assert.match(mapper, /sharedBusinessTargetCodes\?: readonly string\[\]/);
  assert.match(mapper, /\.filter\(\(code\) => businessTargetOccupiedCodes\.has\(code\)\)/);
});

test("the Business approved-base rule keeps its own semantics (no silent widening)", () => {
  // Decision 2 of the plan: the Services figure must NOT be added to
  // `businessOtherRevenue`, the Business Profit "Other business receipts" base.
  // The tie-out in the Business books therefore stays untouched, and the only
  // place the two figures meet is the single shared IRIS row.
  const books = read("lib/tax/business-schedule-fields.ts");
  assert.match(
    books,
    /Other-revenue breakdown exceeds the saved revenue\./,
    "the exact-match rule on the Business base must still fire",
  );
  assert.match(books, /const revenues:\[Key,string\]\[\]=\[\["technicalFees","3101"\]/);
  assert.doesNotMatch(
    books,
    /services/i,
    "the Business schedule must not learn about Services; the fold lives in the packet builder",
  );
});

test("the shared cell really is one row in the captured contract", () => {
  const spec = CONTRACT.business_other_revenues;
  assert.deepEqual(spec.columns, [
    "Total Amount",
    "Subject to Final Tax",
    "Subject to Exemption",
    "Subject to Normal Tax",
  ]);
  assert.deepEqual(spec.rows["3101"].disabled, [false, false, false, true]);
  assert.deepEqual(spec.rows["3128"].disabled, [false, false, false, true]);
  assert.deepEqual(
    spec.rows["3129"].disabled,
    [true, true, true, true],
    "3129 is IRIS's own total: nobody may type it",
  );
  assert.deepEqual(
    CONTRACT.business_trading.rows["3000"].disabled,
    [true, true, true, true],
    "3000 Income/(Loss) from Business is IRIS's own total too",
  );
});
