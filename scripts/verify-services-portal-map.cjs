"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const root = path.join(__dirname, "..");
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
// Phase 5 covers the portal metadata/packet contract only. The Electron
// row-filler's independent Services validation is deliberately Phase 6.

const serviceInvoice = (overrides = {}) => ({
  id: "invoice-1",
  subcategory: "1b-service-it-ites",
  evidenceStatus: "CONFIRMED",
  sourceDocumentId: "invoice-doc-1",
  sourceDocumentExtractionStatus: "MAPPED",
  serviceDescription: "IT consultancy delivered under the signed work order",
  serviceCategoryHumanConfirmed: true,
  serviceCategoryEvidenceReference: "Invoice page 1, service category and scope reviewed",
  incomeCharacter: "TECHNICAL_PROFESSIONAL_FEE",
  incomeCharacterHumanConfirmed: true,
  incomeCharacterEvidenceReference: "Invoice page 1, technical scope clause",
  recognizedIncomePkr: 1000,
  paymentMatches: [servicePayment()],
  ...overrides,
});

const servicePayment = (overrides = {}) => ({
  id: "match-1",
  withholdingTaxPkr: 50,
  withholdingSection: "153(1)(b)",
  withholdingIrisCode: "64060158",
  withholdingEvidenceReference: "Tax certificate page 1, line 3",
  withholdingEvidenceHumanConfirmed: true,
  withholdingEvidenceDocumentId: "tax-doc-1",
  withholdingEvidenceDocumentExtractionStatus: "MAPPED",
  withholdingEvidenceDocumentType: "other_income_proof",
  ...overrides,
});

function build(input = {}) {
  const invoice = input.invoice ?? serviceInvoice();
  return buildServicesPortalMappings({
    invoices: [invoice],
    incomeBySubcategory: input.incomeBySubcategory ?? {
      [invoice.subcategory]: invoice.recognizedIncomePkr,
    },
    existingBusinessFields: input.existingBusinessFields ?? [],
    taxCredits: input.taxCredits ?? [],
  });
}

function flatten(result) {
  return flattenPortalFieldMap({
    version: "test",
    generatedAt: new Date(0).toISOString(),
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    totalFields: result.businessFields.length + result.withholdingFields.length,
    businessFields: result.businessFields,
    incomeFields: [],
    adjustableTaxFields: result.withholdingFields,
    wealthFields: [],
    computationHints: {
      totalIncome: 0,
      taxableIncome: 0,
      totalTaxWithheld: 0,
    },
    selectorBundle: { version: "test", portalType: "IRIS_2_0" },
  });
}

test("only human-confirmed, evidence-backed technical fees and supported withholding reach exact IRIS fields", () => {
  const result = build();
  assert.equal(result.businessFields.length, 1);
  assert.equal(result.businessFields[0].irisCode, "3101");
  assert.equal(result.businessFields[0].column, "Total Amount");
  assert.equal(result.businessFields[0].ourAmount, 1000);
  assert.deepEqual(result.businessFields[0].servicesInvoiceEvidenceIds, ["invoice-1"]);
  assert.deepEqual(result.businessFields[0].servicesEvidenceDocumentIds, ["invoice-doc-1"]);
  assert.equal(result.businessFields[0].servicesHumanReviewConfirmed, true);
  assert.deepEqual(result.incomeGaps, []);

  assert.equal(result.withholdingFields.length, 1);
  const withholding = result.withholdingFields[0];
  assert.equal(withholding.irisCode, "64060158");
  assert.equal(withholding.portalGroup, "Minimum Tax");
  assert.equal(withholding.column, "Tax Collected / Deducted");
  assert.equal(withholding.ourAmount, 50);
  assert.deepEqual(withholding.servicesEvidenceDocumentIds, ["tax-doc-1"]);
  assert.deepEqual(withholding.servicesPaymentMatchIds, ["match-1"]);
  assert.equal(withholding.servicesStatutorySection, "153(1)(b)");
  assert.equal(withholding.servicesObservedIrisCode, "64060158");
  assert.deepEqual(result.withholdingGaps, []);

  const fields = flatten(result);
  const incomeField = fields.find((field) => field.servicesMappingKind === "SERVICES_INCOME");
  const withholdingField = fields.find((field) => field.servicesMappingKind === "SERVICES_WITHHOLDING");
  assert.ok(incomeField);
  assert.equal(incomeField.sourceGroup, "businessFields");
  assert.equal(incomeField.leftPanel, "Business");
  assert.equal(incomeField.leftSection, "Other Revenues");
  assert.deepEqual(incomeField.servicesInvoiceEvidenceIds, ["invoice-1"]);
  assert.ok(withholdingField);
  assert.equal(withholdingField.sourceGroup, "adjustableTaxFields");
  // Services withholding renders on the Business panel's Tax Deduction tab; the
  // Tax Chargeable / Payments > Withholding Tax tab only carries the locked
  // 64000101-64000103 summary rows (capture 21).
  assert.equal(withholdingField.leftPanel, "Business");
  assert.equal(withholdingField.leftSection, "Tax Deduction");
  assert.equal(withholdingField.portalArea, "Business");
  assert.equal(withholdingField.portalGroup, "Minimum Tax");
  assert.deepEqual(withholdingField.servicesPaymentMatchIds, ["match-1"]);
});

test("other Services income and incomplete classification remain visible manual gaps, never row 3128", () => {
  const otherServices = build({
    invoice: serviceInvoice({
      incomeCharacter: "OTHER_SERVICES",
      incomeCharacterHumanConfirmed: true,
      recognizedIncomePkr: 725,
      paymentMatches: [],
    }),
    incomeBySubcategory: { "1b-service-it-ites": 725 },
  });
  assert.equal(otherServices.businessFields.length, 0);
  assert.equal(otherServices.incomeGaps.length, 1);
  assert.equal(otherServices.incomeGaps[0].totalAmount, 725);
  assert.match(otherServices.incomeGaps[0].reason, /only evidenced, human-confirmed technical\/professional fees/i);

  const unconfirmedCategory = build({
    invoice: serviceInvoice({
      serviceCategoryHumanConfirmed: false,
      serviceCategoryEvidenceReference: null,
      paymentMatches: [],
    }),
  });
  assert.equal(unconfirmedCategory.businessFields.length, 0);
  assert.equal(unconfirmedCategory.incomeGaps[0].totalAmount, 1000);
  assert.doesNotMatch(JSON.stringify(unconfirmedCategory), /3128/);
});

test("a separate row-3101 packet value blocks Services overwrite and leaves all Services gross income manual", () => {
  const result = build({
    existingBusinessFields: [{
      irisCode: "3101",
      column: "Total Amount",
      ourAmount: 250,
    }],
  });
  assert.equal(result.businessFields.length, 0);
  assert.equal(result.incomeGaps.length, 1);
  assert.equal(result.incomeGaps[0].totalAmount, 1000);
  assert.match(result.incomeGaps[0].reason, /already has a separate packet value/i);
});

test("exact same-document, same-section, same-amount tax credits alone are suppressed", () => {
  const exact = build({
    taxCredits: [{
      id: "credit-exact",
      section: "153 (1) (b)",
      amount: 50,
      sourceDocumentId: "tax-doc-1",
    }],
  });
  assert.deepEqual(exact.taxCreditIdsToSuppress, ["credit-exact"]);
  assert.deepEqual(exact.duplicateTaxCreditIds, ["credit-exact"]);
  assert.equal(exact.withholdingFields.length, 1);
  assert.deepEqual(exact.withholdingGaps, []);

  const amountMismatch = build({
    taxCredits: [{
      id: "credit-mismatch",
      section: "153(1)(b)",
      amount: 49.99,
      sourceDocumentId: "tax-doc-1",
    }],
  });
  assert.deepEqual(amountMismatch.taxCreditIdsToSuppress, []);
  assert.deepEqual(amountMismatch.duplicateTaxCreditIds, []);
  assert.equal(amountMismatch.withholdingFields.length, 0);
  assert.equal(amountMismatch.withholdingGaps[0].totalAmount, 50);
  assert.match(amountMismatch.withholdingGaps[0].reason, /overlaps this statutory section/i);

  const differentDocument = build({
    taxCredits: [{
      id: "credit-other-document",
      section: "153(1)(b)",
      amount: 50,
      sourceDocumentId: "another-tax-doc",
    }],
  });
  assert.deepEqual(differentDocument.taxCreditIdsToSuppress, []);
  assert.equal(differentDocument.withholdingFields.length, 0);
  assert.equal(differentDocument.withholdingGaps[0].totalAmount, 50);
});

test("unsupported code, missing human confirmation, or unsuitable mapped document stays manual", () => {
  for (const overrides of [
    { withholdingIrisCode: "64060156" },
    { withholdingEvidenceHumanConfirmed: false },
    { withholdingEvidenceDocumentType: "invoice_summary" },
    { withholdingEvidenceDocumentExtractionStatus: "PENDING" },
    { withholdingEvidenceDocumentId: null },
    { withholdingSection: "154A" },
  ]) {
    const result = build({ invoice: serviceInvoice({
      recognizedIncomePkr: 0,
      paymentMatches: [servicePayment(overrides)],
    }), incomeBySubcategory: {} });
    assert.equal(result.withholdingFields.length, 0, JSON.stringify(overrides));
    assert.equal(result.withholdingGaps.length, 1, JSON.stringify(overrides));
    assert.equal(result.withholdingGaps[0].totalAmount, 50);
  }
});

test("Phase 5 flattening preserves the exact Services evidence metadata for the later agent union", () => {
  const fields = flatten(build());
  assert.deepEqual(
    fields.map((field) => [field.irisCode, field.servicesMappingKind, field.portalGroup ?? null]),
    [
      ["3101", "SERVICES_INCOME", null],
      ["64060158", "SERVICES_WITHHOLDING", "Minimum Tax"],
    ],
  );
  assert.ok(fields.every((field) => field.servicesHumanReviewConfirmed === true));
  assert.ok(fields.every((field) => field.sourceEvidenceReferences.length > 0));
});
