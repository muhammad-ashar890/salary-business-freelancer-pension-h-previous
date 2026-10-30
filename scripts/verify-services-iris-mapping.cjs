const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  module._compile(output, filename);
};

const mapping = require("../lib/tax/services-iris-mapping.ts");
const businessContract = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../electron-connect/iris-business-contract.json"), "utf8"),
);
const servicesCapture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../electron-connect/iris-services-contract.json"), "utf8"),
);

const validInvoiceRoute = {
  subcategory: "1b-service-it-ites",
  serviceCategoryHumanConfirmed: true,
  serviceCategoryEvidenceReference: "Invoice page 1, TY2026 service category reviewed",
  invoiceEvidenceStatus: "CONFIRMED",
  sourceDocumentExtractionStatus: "MAPPED",
  sourceDocumentId: "synthetic-source-document",
  serviceDescription: "IT consultancy delivered under the attached invoice",
  incomeCharacter: "TECHNICAL_PROFESSIONAL_FEE",
  humanConfirmed: true,
  classificationEvidenceReference: "Invoice page 1, service description and signed scope clause",
};

function validWithholdingRoute(subcategory, code, amount = 250) {
  return {
    subcategory,
    serviceCategoryHumanConfirmed: true,
    serviceCategoryEvidenceReference: "Invoice page 1, service scope and contract clause reviewed by the taxpayer",
    withholdingAmountPkr: amount,
    observedSection: mapping.SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY[subcategory],
    observedIrisCode: code,
    sourceEvidenceMapped: true,
    withholdingEvidenceHumanConfirmed: true,
    evidenceReference: "Payout tax certificate, page 1, withholding line",
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("3101 is corroborated by both Business / Other Revenues captures and only its Total Amount cell is used", () => {
  const oldContract = businessContract.business_other_revenues;
  assert.equal(oldContract.group, "Business");
  assert.equal(oldContract.tab, "Other Revenues");
  assert.equal(oldContract.columns[0], "Total Amount");
  assert.equal(oldContract.rows["3101"].label, "Fee for Technical / Professional Services");
  assert.equal(oldContract.rows["3101"].disabled[0], false);
  assert.equal(oldContract.rows["3101"].disabled[3], true);

  const live = servicesCapture.businessOtherRevenues;
  assert.equal(live.portalArea, "Business");
  assert.equal(live.portalSection, "Other Revenues");
  assert.equal(live.columns[0], "Total Amount");
  assert.deepEqual(live.rows["3101"].writableInputIndexes, [0, 1, 2]);
  assert.deepEqual(live.rows["3101"].disabledInputIndexes, [3]);
  assert.equal(live.rows["3101"].label, "Fee for Technical / Professional Services");
  assert.equal(live.rows["3128"].label, "Others");

  const result = mapping.resolveServicesIncomeIrisMapping(validInvoiceRoute);
  assert.equal(result.status, "MAPPED_CANDIDATE");
  assert.equal(result.mapping.irisCode, "3101");
  assert.equal(result.mapping.irisSectionId, "business_other_revenues");
  assert.equal(result.mapping.irisGroup, "Business");
  assert.equal(result.mapping.irisSection, "Other Revenues");
  assert.equal(result.mapping.column, "Total Amount");
  assert.equal(result.mapping.columnIndex, 0);
  assert.equal(result.mapping.autoFillAllowed, true);
});

test("a service description or selected subcategory alone never guesses row 3101 or generic row 3128", () => {
  const genericServices = mapping.resolveServicesIncomeIrisMapping({
    ...validInvoiceRoute,
    incomeCharacter: "OTHER_SERVICES",
    humanConfirmed: false,
    classificationEvidenceReference: null,
  });
  assert.equal(genericServices.status, "MANUAL_REVIEW");
  assert.match(genericServices.reason, /only an explicitly reviewed technical\/professional-fee case/i);
  assert.doesNotMatch(JSON.stringify(genericServices), /3128/);

  const unclassified = mapping.resolveServicesIncomeIrisMapping({
    ...validInvoiceRoute,
    incomeCharacter: "UNCLASSIFIED",
    humanConfirmed: false,
    classificationEvidenceReference: null,
  });
  assert.equal(unclassified.status, "MANUAL_REVIEW");
});

test("technical/professional-fee routing fails closed without confirmed, mapped source evidence", () => {
  const unconfirmedCategory = mapping.resolveServicesIncomeIrisMapping({
    ...validInvoiceRoute,
    serviceCategoryHumanConfirmed: false,
  });
  assert.equal(unconfirmedCategory.status, "MANUAL_REVIEW");
  assert.match(unconfirmedCategory.reason, /human-reviewed Services subcategory/i);

  const missingCategoryReference = mapping.resolveServicesIncomeIrisMapping({
    ...validInvoiceRoute,
    serviceCategoryEvidenceReference: null,
  });
  assert.equal(missingCategoryReference.status, "MANUAL_REVIEW");
  assert.match(missingCategoryReference.reason, /human-reviewed Services subcategory/i);

  const unconfirmedInvoice = mapping.resolveServicesIncomeIrisMapping({
    ...validInvoiceRoute,
    invoiceEvidenceStatus: "DRAFT",
  });
  assert.equal(unconfirmedInvoice.status, "MANUAL_REVIEW");
  assert.match(unconfirmedInvoice.reason, /confirm the invoice evidence/i);

  const unmappedDocument = mapping.resolveServicesIncomeIrisMapping({
    ...validInvoiceRoute,
    sourceDocumentExtractionStatus: "PENDING",
  });
  assert.equal(unmappedDocument.status, "MANUAL_REVIEW");
  assert.match(unmappedDocument.reason, /mapped source invoice document/i);

  const noClassificationEvidence = mapping.resolveServicesIncomeIrisMapping({
    ...validInvoiceRoute,
    classificationEvidenceReference: "   ",
  });
  assert.equal(noClassificationEvidence.status, "MANUAL_REVIEW");
  assert.match(noClassificationEvidence.reason, /source reference/i);
});

test("all seven TY2026 Services categories have the expected statutory section metadata", () => {
  assert.deepEqual(Object.keys(mapping.SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY).sort(),
    [...mapping.SERVICES_TY2026_SUBCATEGORIES].sort());
  assert.equal(mapping.SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY["1b-service-certain"], "153(1)(b)");
  assert.equal(mapping.SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY["1b-service-it-ites"], "153(1)(b)");
  assert.equal(mapping.SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY["1b-service-advertising-media"], "153(1)(b)");
  assert.equal(mapping.SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY["1b-service-other"], "153(1)(b)");
  assert.equal(mapping.SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY["2-services-to-exporter"], "153(2)");
  assert.equal(mapping.SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY["export-it-ites-pseb"], "154A");
  assert.equal(mapping.SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY["export-services-other"], "154A");
});

test("the shared Services contract is the canonical category/code allowlist", () => {
  const approved = servicesCapture.approvedServicesMapping;
  assert.deepEqual(
    Object.keys(approved.withholdingBySubcategory).sort(),
    [...mapping.SERVICES_TY2026_SUBCATEGORIES].sort(),
  );
  for (const subcategory of mapping.SERVICES_TY2026_SUBCATEGORIES) {
    assert.equal(
      approved.withholdingBySubcategory[subcategory].statutorySection,
      mapping.SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY[subcategory],
    );
    assert.deepEqual(
      approved.withholdingBySubcategory[subcategory].irisCodes,
      mapping.SERVICES_WITHHOLDING_IRIS_CODES_BY_SUBCATEGORY[subcategory],
    );
  }
  assert.equal(approved.incomeRow3101.irisCode, "3101");
  assert.equal(approved.incomeRow3101.rowLabel, "Fee for Technical / Professional Services");
});

test("official TY2026 return candidates preserve their exact code, section and printed page", () => {
  const rows = new Map(mapping.SERVICES_WITHHOLDING_IRIS_ROW_CANDIDATES.map((row) => [row.irisCode, row]));
  for (const [code, section, page] of [
    ["64060151", "153(1)(b)", 104],
    ["64060152", "153(1)(b)", 104],
    ["64060153", "153(1)(b)", 104],
    ["64060158", "153(1)(b)", 104],
    ["64060162", "153(1)(b)", 104],
    ["64060180", "153(1)(b)", 105],
    ["64060352", "153(2)", 105],
    ["64060285", "154A", 100],
    ["64060290", "154A", 100],
  ]) {
    assert.equal(rows.get(code)?.statutorySection, section, `${code} must remain in ${section}`);
    assert.equal(rows.get(code)?.officialReturnPage, page, `${code} return-page provenance`);
    assert.equal(rows.get(code)?.evidenceSource, "TY2026_RETURN_AND_USER_IRIS_CAPTURE");
  }
});

test("newly surfaced IRIS codes are recorded as live evidence without inventing a TY2026 return-page match", () => {
  const rows = new Map(mapping.SERVICES_WITHHOLDING_IRIS_ROW_CANDIDATES.map((row) => [row.irisCode, row]));
  for (const [code, section, group, column] of [
    ["64060116", "153(1)(b)", "Adjustable Tax", "Tax Deducted"],
    ["64060156", "153(1)(b)", "Minimum Tax", "Tax Collected / Deducted"],
    ["64060555", "153(1)(b)", "Minimum Tax", "Tax Collected / Deducted"],
  ]) {
    const row = rows.get(code);
    assert.equal(row?.statutorySection, section);
    assert.equal(row?.officialReturnPage, null);
    assert.equal(row?.evidenceSource, "USER_IRIS_CAPTURE_ONLY");
    assert.equal(row?.portalGroup, group);
    assert.equal(row?.portalColumn, column);
  }
});

test("each captured Services row records its exact portal group, headers and editable input indexes", () => {
  const expected = [
    ["64060116", "Adjustable Tax", "Tax Deducted", [0, 1]],
    ["64060151", "Minimum Tax", "Tax Collected / Deducted", [0, 1]],
    ["64060152", "Minimum Tax", "Tax Collected / Deducted", [0, 1]],
    ["64060153", "Minimum Tax", "Tax Collected / Deducted", [0, 1]],
    ["64060156", "Minimum Tax", "Tax Collected / Deducted", [0, 1]],
    ["64060158", "Minimum Tax", "Tax Collected / Deducted", [0, 1]],
    ["64060162", "Minimum Tax", "Tax Collected / Deducted", [0, 1]],
    ["64060180", "Minimum Tax", "Tax Collected / Deducted", [0, 1]],
    ["64060352", "Minimum Tax", "Tax Collected / Deducted", [0, 1]],
    ["64060555", "Minimum Tax", "Tax Collected / Deducted", [0, 1]],
    ["64060285", "Final Tax", "Tax Deducted", [0, 1]],
    ["64060290", "Final Tax", "Tax Deducted", [0, 1]],
  ];
  const captureGroups = servicesCapture.taxDeductions.groups;
  for (const [code, groupLabel, column, editableIndexes] of expected) {
    const candidate = mapping.SERVICES_WITHHOLDING_IRIS_ROW_CANDIDATES.find((row) => row.irisCode === code);
    const grid = captureGroups[candidate.captureGroupId];
    const row = grid.rows[code];
    assert.equal(grid.label, groupLabel, `${code} portal group`);
    assert.equal(row.label, candidate.description, `${code} exact row label`);
    assert.deepEqual(row.writableInputIndexes, editableIndexes, `${code} writable input indexes`);
    assert.equal(grid.inputColumns[1], column, `${code} second editable column`);
    assert.deepEqual(row.disabledInputIndexes, code === "64060116" ? [] : code.startsWith("640602") ? [2] : [2, 3, 4, 5]);

    const cell = mapping.capturedServicesWithholdingCell(code);
    // The row cells must agree with the capture contract, which places them on
    // the Business panel's Tax Deduction tab (see the contract's
    // capturedRoute). Asserting against the JSON keeps the two in step.
    assert.equal(cell.portalArea, servicesCapture.taxDeductions.portalArea);
    assert.equal(cell.portalSection, servicesCapture.taxDeductions.portalSection);
    assert.equal(cell.portalArea, "Business");
    assert.equal(cell.portalSection, "Tax Deduction");
    assert.equal(cell.portalGroup, groupLabel);
    assert.equal(cell.column, column);
    assert.equal(cell.columnIndex, 1);
  }
});

test("a missing, disabled, mislabeled, or misordered Services capture fails closed", () => {
  const missingRow = clone(servicesCapture);
  delete missingRow.taxDeductions.groups.minimumTax.rows["64060158"];
  assert.equal(mapping.capturedServicesWithholdingCell("64060158", missingRow), null);

  const disabledColumn = clone(servicesCapture);
  disabledColumn.taxDeductions.groups.minimumTax.rows["64060158"].writableInputIndexes = [0];
  disabledColumn.taxDeductions.groups.minimumTax.rows["64060158"].disabledInputIndexes.push(1);
  assert.equal(mapping.capturedServicesWithholdingCell("64060158", disabledColumn), null);

  const wrongRowLabel = clone(servicesCapture);
  wrongRowLabel.taxDeductions.groups.minimumTax.rows["64060158"].label = "Different row";
  assert.equal(mapping.capturedServicesWithholdingCell("64060158", wrongRowLabel), null);

  const wrongHeaderOrder = clone(servicesCapture);
  wrongHeaderOrder.taxDeductions.groups.minimumTax.inputColumns[1] = "Tax Chargeable";
  assert.equal(mapping.capturedServicesWithholdingCell("64060158", wrongHeaderOrder), null);
});

test("withholding code and section must be evidenced; section alone never produces an IRIS field", () => {
  const result = mapping.resolveServicesWithholdingIrisMapping({
    subcategory: "export-it-ites-pseb",
    serviceCategoryHumanConfirmed: true,
    serviceCategoryEvidenceReference: "Invoice page 1, PSEB registration and service scope review",
    withholdingAmountPkr: 250,
    observedSection: "154A",
    observedIrisCode: null,
    sourceEvidenceMapped: true,
    withholdingEvidenceHumanConfirmed: true,
    evidenceReference: "Payout tax certificate, page 1",
  });
  assert.equal(result.status, "MANUAL_REVIEW");
  assert.match(result.reason, /evidenced IRIS code/i);
});

test("withholding is not queued until the human confirms amount, exact section and code", () => {
  const result = mapping.resolveServicesWithholdingIrisMapping({
    ...validWithholdingRoute("1b-service-it-ites", "64060158"),
    withholdingEvidenceHumanConfirmed: false,
  });
  assert.equal(result.status, "MANUAL_REVIEW");
  assert.match(result.reason, /human must confirm/i);
});

test("a documented code/section mismatch remains a manual review gap", () => {
  const result = mapping.resolveServicesWithholdingIrisMapping({
    ...validWithholdingRoute("export-it-ites-pseb", "64060158"),
    observedSection: "153(1)(b)",
  });
  assert.equal(result.status, "MANUAL_REVIEW");
  assert.match(result.reason, /statutory section 154A/i);
});

test("a Services withholding crosswalk needs human-confirmed category evidence as well as a tax-code certificate", () => {
  const unconfirmedCategory = mapping.resolveServicesWithholdingIrisMapping({
    ...validWithholdingRoute("1b-service-advertising-media", "64060153"),
    serviceCategoryHumanConfirmed: false,
  });
  assert.equal(unconfirmedCategory.status, "MANUAL_REVIEW");
  assert.match(unconfirmedCategory.reason, /human-reviewed Services category/i);

  const missingCategoryReference = mapping.resolveServicesWithholdingIrisMapping({
    ...validWithholdingRoute("export-it-ites-pseb", "64060290"),
    serviceCategoryEvidenceReference: null,
  });
  assert.equal(missingCategoryReference.status, "MANUAL_REVIEW");
  assert.match(missingCategoryReference.reason, /human-reviewed Services category/i);
});

test("row candidates cannot cross-map between service types within the same statutory section", () => {
  const wrong153Category = mapping.resolveServicesWithholdingIrisMapping(
    validWithholdingRoute("1b-service-other", "64060158"),
  );
  assert.equal(wrong153Category.status, "MANUAL_REVIEW");
  assert.match(wrong153Category.reason, /not a verified TY2026 row candidate/i);

  const wrong154ACategory = mapping.resolveServicesWithholdingIrisMapping(
    validWithholdingRoute("export-it-ites-pseb", "64060285"),
  );
  assert.equal(wrong154ACategory.status, "MANUAL_REVIEW");
  assert.match(wrong154ACategory.reason, /not a verified TY2026 row candidate/i);
});

test("the seven supported category candidates resolve to exact captured groups and editable columns", () => {
  const cases = [
    ["1b-service-certain", "64060162", "Minimum Tax", "Tax Collected / Deducted", "153(1)(b)"],
    ["1b-service-it-ites", "64060158", "Minimum Tax", "Tax Collected / Deducted", "153(1)(b)"],
    ["1b-service-advertising-media", "64060153", "Minimum Tax", "Tax Collected / Deducted", "153(1)(b)"],
    ["1b-service-other", "64060180", "Minimum Tax", "Tax Collected / Deducted", "153(1)(b)"],
    ["2-services-to-exporter", "64060352", "Minimum Tax", "Tax Collected / Deducted", "153(2)"],
    ["export-it-ites-pseb", "64060290", "Final Tax", "Tax Deducted", "154A"],
    ["export-services-other", "64060285", "Final Tax", "Tax Deducted", "154A"],
  ];
  assert.equal(cases.length, 7);
  for (const [subcategory, code, group, column, section] of cases) {
    const result = mapping.resolveServicesWithholdingIrisMapping(
      validWithholdingRoute(subcategory, code, 250.129),
    );
    assert.equal(result.status, "MAPPED_CANDIDATE", `${subcategory} ${code}`);
    assert.equal(result.expectedSection, section);
    assert.equal(result.mapping.irisCode, code);
    assert.equal(result.mapping.irisSectionId, "business_tax_deduction");
    assert.equal(result.mapping.portalArea, servicesCapture.taxDeductions.portalArea);
    assert.equal(result.mapping.portalSection, servicesCapture.taxDeductions.portalSection);
    assert.equal(result.mapping.portalArea, "Business");
    assert.equal(result.mapping.portalSection, "Tax Deduction");
    assert.equal(result.mapping.portalGroup, group);
    assert.equal(result.mapping.column, column);
    assert.equal(result.mapping.columnIndex, 1);
    assert.equal(result.mapping.withholdingAmountPkr, 250.13);
    assert.equal(result.mapping.evidenceReference, "Payout tax certificate, page 1, withholding line");
    assert.equal(result.mapping.autoFillAllowed, true);
  }
});

test("special, live-capture-only and unmatched rate rows stay manual rather than being rate-inferred", () => {
  const unassignedRows = [
    ["1b-service-it-ites", "64060116"],
    ["1b-service-certain", "64060151"],
    ["1b-service-certain", "64060152"],
    ["1b-service-advertising-media", "64060156"],
    ["1b-service-certain", "64060555"],
  ];
  for (const [subcategory, code] of unassignedRows) {
    const result = mapping.resolveServicesWithholdingIrisMapping(
      validWithholdingRoute(subcategory, code),
    );
    assert.equal(result.status, "MANUAL_REVIEW", `${code} must remain manual`);
    assert.match(result.reason, /not a verified TY2026 row candidate/i);
  }
});

test("zero withholding does not create a tax-row mapping", () => {
  const result = mapping.resolveServicesWithholdingIrisMapping({
    ...validWithholdingRoute("export-services-other", "64060285", 0),
    observedSection: null,
    observedIrisCode: null,
    sourceEvidenceMapped: false,
    evidenceReference: null,
  });
  assert.equal(result.status, "NO_WITHHOLDING");
});
