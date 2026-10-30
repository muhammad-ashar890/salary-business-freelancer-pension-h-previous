#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const ts = require("typescript");
const root = path.join(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return originalResolve.call(this, request.startsWith("@/") ? path.join(root, request.slice(2)) : request, ...rest);
};
require.extensions[".ts"] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, resolveJsonModule: true },
}).outputText, filename);
const source = require("../lib/tax/services-withholding-evidence.ts");
const { buildServicesPortalMappings } = require("../lib/tax/services-portal-map.ts");
const { buildServicesTaxDeductionPacket } = require("../lib/tax/business-filing.ts");
const field = (label, value) => ({ label, value });
const taxFields = (invoice = "INV-2026-003", amount = 2050, index = 1, overrides = {}) => {
  const values = {
    "Invoice Number": invoice, "Payout Reference": `PAYOUT-${invoice}`,
    "Withholding Tax (PKR)": amount, "Withholding Section": "153(1)(b)",
    "Withholding IRIS Code": "64060158", "Withholding Evidence Reference": `Certificate page 1 line ${index}`,
    ...overrides,
  };
  return Object.entries(values).map(([label, value]) => field(`${label} ${index}`, value));
};
const document = (fields = taxFields(), overrides = {}) => ({
  id: "mapped-tax-proof", fileName: "payer-withholding.pdf", documentType: "other_income_proof", extractionStatus: "MAPPED",
  withholdingRows: source.readServicesWithholdingSourceRows({ fields }), ...overrides,
});
const resolve = (overrides = {}) => source.resolveServicesWithholdingPrefill({
  invoiceNumber: "INV-2026-003", payoutReference: "PAYOUT-INV-2026-003", amountPkr: 2050,
  observedSection: "153(1)(b)", observedIrisCode: "64060158", documents: [document()], ...overrides,
});

test("source reader preserves numbered rows and exact printed facts, including PKR strings", () => {
  const rows = source.readServicesWithholdingSourceRows(JSON.stringify({ fields: [
    ...taxFields("INV-2026-003", "PKR 2,050.00", 1), ...taxFields("INV-2026-004", 800, 2),
  ] }));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.invoiceNumber, r.amountPkr, r.irisCode]), [["INV-2026-003", 2050, "64060158"], ["INV-2026-004", 800, "64060158"]]);
});

test("mapped certificate matches the invoice/payout and supplies its source reference without retyping", () => {
  const result = resolve({ observedSection: null, observedIrisCode: null });
  assert.equal(result.status, "MATCHED");
  assert.equal(result.documentId, "mapped-tax-proof");
  assert.equal(result.amountPkr, 2050);
  assert.equal(result.section, "153(1)(b)");
  assert.equal(result.irisCode, "64060158");
  assert.match(result.evidenceReference, /payer-withholding.pdf.*page 1 line 1/);
});

test("invoice-only evidence never becomes a withholding certificate, even with explicit-looking fields", () => {
  assert.equal(resolve({ documents: [document(taxFields(), { documentType: "invoice_summary" })] }).status, "MISSING");
});

test("ordinary net-credit bank statement is not auto-linked as tax evidence", () => {
  const bank = document([field("Opening Balance", 185000), field("Closing Balance", 236130)], { documentType: "bank_statement" });
  assert.equal(resolve({ documents: [bank] }).status, "MISSING");
});

test("unmapped, cross-reference-mismatched and missing source documents cannot enable prefill", () => {
  for (const documents of [[], [document(taxFields(), { extractionStatus: "EXTRACTED" })], [document(taxFields("INV-OTHER", 2050))]])
    assert.equal(resolve({ documents }).status, "MISSING");
});

test("equal amount alone does not select a certificate", () => {
  const fields = taxFields().filter((f) => !/Invoice Number|Payout Reference/.test(f.label));
  assert.equal(resolve({ documents: [document(fields)] }).status, "MISSING");
});

test("ambiguous certificates and duplicate labels fail closed", () => {
  assert.equal(resolve({ documents: [document(), document(taxFields(), { id: "second-proof" })] }).status, "AMBIGUOUS");
  assert.equal(resolve({ documents: [document([...taxFields(), field("Withholding Tax (PKR) 1", 2050)])] }).status, "CONFLICT");
});

test("a source amount, statutory-section or IRIS-code conflict does not overwrite the payout", () => {
  assert.equal(resolve({ amountPkr: 2000 }).status, "CONFLICT");
  assert.equal(resolve({ observedSection: "154A" }).status, "CONFLICT");
  assert.equal(resolve({ observedIrisCode: "64060116" }).status, "CONFLICT");
});

test("missing certificate amount/section/code and invalid numbers are not inferred", () => {
  for (const overrides of [
    { "Withholding Tax (PKR)": null }, { "Withholding Section": null }, { "Withholding IRIS Code": null },
    { "Withholding Tax (PKR)": "2,050 plus fee" }, { "Withholding Tax (PKR)": -1 },
  ]) assert.equal(resolve({ documents: [document(taxFields("INV-2026-003", 2050, 1, overrides))] }).status, "MISSING");
});

test("other partial payouts of the same invoice do not replace the exact payout row", () => {
  const exact = taxFields();
  const other = taxFields("INV-2026-003", 1000, 2, { "Payout Reference": "OTHER-PARTIAL-PAYOUT" });
  assert.equal(resolve({ documents: [document([...other, ...exact])] }).status, "MATCHED");
  assert.equal(resolve({ documents: [document(other)] }).status, "CONFLICT");
});

test("zero/no verified withholding does not fabricate a row, rate or deduction", () => {
  assert.equal(resolve({ amountPkr: 0 }).status, "NO_WITHHOLDING");
  for (const amountPkr of [null, NaN, -1]) assert.equal(resolve({ amountPkr }).status, "MISSING");
});

test("statutory spelling is formatting-only; 154A stays compatible with the exact gate", () => {
  const result = resolve({ observedSection: "154A", observedIrisCode: "64060290", documents: [document(taxFields("INV-2026-003", 2050, 1, {
    "Withholding Section": "154 a", "Withholding IRIS Code": "64060290",
  }))] });
  assert.equal(result.status, "MATCHED");
  assert.equal(result.section, "154A");
});

test("u/s section labels with printed rate annotations match only the explicit statutory section", () => {
  const annotatedSection = "u/s 153(1)(b) @ 4%";
  const sourceDocument = document(taxFields("INV-2026-003", 2050, 1, {
    "Withholding Section": annotatedSection,
  }));
  assert.equal(sourceDocument.withholdingRows[0].section, "153(1)(b)");

  const result = resolve({
    observedSection: annotatedSection,
    documents: [document()],
  });
  assert.equal(result.status, "MATCHED");
  assert.equal(result.section, "153(1)(b)");
  assert.equal(result.irisCode, "64060158");

  // A label naming multiple sections must still fail closed.
  assert.equal(
    resolve({ observedSection: "u/s 153(1)(b) and 154A" }).status,
    "CONFLICT",
  );
});

const portalInvoice = (id, proof, amount) => ({
  id, subcategory: "1b-service-it-ites", evidenceStatus: "CONFIRMED", sourceDocumentId: "mapped-invoices",
  sourceDocumentExtractionStatus: "MAPPED", serviceDescription: "Custom software development",
  serviceCategoryHumanConfirmed: true, serviceCategoryEvidenceReference: `invoice summary ${id}`,
  incomeCharacter: "TECHNICAL_PROFESSIONAL_FEE", incomeCharacterHumanConfirmed: true,
  incomeCharacterEvidenceReference: `invoice summary ${id}`, recognizedIncomePkr: 10000,
  paymentMatches: [{ id: `match-${id}`, withholdingTaxPkr: amount, withholdingSection: proof.section,
    withholdingIrisCode: proof.irisCode, withholdingEvidenceReference: proof.evidenceReference,
    withholdingEvidenceHumanConfirmed: true, withholdingEvidenceDocumentId: proof.documentId,
    withholdingEvidenceDocumentExtractionStatus: "MAPPED", withholdingEvidenceDocumentType: "other_income_proof" }],
});

test("three source-backed ATL withholdings aggregate once into Business > Tax Deduction 64060158 = 4,190", () => {
  const rows = [["INV-2026-003", 2050], ["INV-2026-004", 800], ["INV-2026-006", 1340]];
  const certificate = document(rows.flatMap(([invoice, amount], index) => taxFields(invoice, amount, index + 1)));
  const invoices = rows.map(([invoice, amount]) => {
    const proof = resolve({ invoiceNumber: invoice, payoutReference: `PAYOUT-${invoice}`, amountPkr: amount, documents: [certificate] });
    assert.equal(proof.status, "MATCHED");
    return portalInvoice(invoice, proof, amount);
  });
  const map = buildServicesPortalMappings({ invoices, incomeBySubcategory: { "1b-service-it-ites": 30000 } });
  assert.equal(map.withholdingFields.length, 1);
  const row = map.withholdingFields[0];
  assert.equal(row.ourAmount, 4190);
  assert.equal(row.sourceEntryCount, 3);
  assert.deepEqual([row.irisCode, row.portalArea, row.section, row.portalGroup, row.column],
    ["64060158", "Business", "Tax Deduction", "Minimum Tax", "Tax Collected / Deducted"]);
  assert.equal(map.withholdingGaps.length, 0);
});

test("source-backed special-clause 8% is still rejected by the independent Services category gate", () => {
  const proof = resolve({ observedIrisCode: "64060116", documents: [document(taxFields("INV-2026-003", 2050, 1, { "Withholding IRIS Code": "64060116" }))] });
  assert.equal(proof.status, "MATCHED", "source fact is preserved, not reclassified");
  const map = buildServicesPortalMappings({ invoices: [portalInvoice("INV-2026-003", proof, 2050)], incomeBySubcategory: { "1b-service-it-ites": 10000 } });
  assert.equal(map.withholdingFields.length, 0);
  assert.equal(map.withholdingGaps[0].totalAmount, 2050);
});

test("no-withholding Services case has only final review, not a phantom missing withholding prompt", () => {
  const payload = buildServicesTaxDeductionPacket({ taxYear: 2026, filerType: "myself", incomeSources: ["services"],
    businessFields: [{ irisCode: "3101" }], withholdingFields: [], withholdingGaps: [] });
  assert.deepEqual(payload.pending.map((p) => p.key), ["servicesFinalReview"]);
});

test("partial/missing withholding retains the exact source reason without duplicating its money gap", () => {
  const payload = buildServicesTaxDeductionPacket({ taxYear: 2026, filerType: "myself", incomeSources: ["services"],
    businessFields: [{ irisCode: "3101" }], withholdingFields: [{ irisCode: "64060158" }],
    withholdingGaps: [{ totalAmount: 4190, reason: "Mapped withholding certificate missing." }] });
  const pending = payload.pending.find((p) => p.key === "servicesWithholdingRows");
  assert.match(pending.reason, /4,190.*certificate missing/);
  assert.equal(pending.amount, null, "adapter already owns the actual amount gap");
});

// Exercise the actual private extraction prompt without loading server actions,
// an extraction provider, session, Prisma or any external service.
function loadExtractionPrompt() {
  const file = path.join(root, "app/actions/extraction.ts");
  const text = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "buildExtractionPrompt");
  const rules = ast.statements.filter(ts.isVariableStatement).flatMap((node) => [...node.declarationList.declarations])
    .find((node) => node.name.getText(ast) === "DOCUMENT_SLOT_RULES");
  assert.ok(fn && rules?.initializer, "load the actual prompt and slot rules, not a duplicate implementation");
  const isolated = `const EXTRACTION_PROMPT = "Common extraction policy"; const BUSINESS_SCHEDULE_LABELS = {}; const BUSINESS_EVIDENCE_PROMPT = "";
    const DOCUMENT_SLOT_RULES = ${rules.initializer.getText(ast)}; ${fn.getText(ast)}; module.exports = buildExtractionPrompt;`;
  const compiled = ts.transpileModule(isolated, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  const output = { exports: {} };
  new Function("module", compiled)(output);
  return output.exports;
}

test("extraction prompt keeps row-linked printed withholding facts for bank, payer proof and CPR, including the no-slot-rule fallback", () => {
  const prompt = loadExtractionPrompt();
  for (const type of ["bank_statement", "other_income_proof", "advance_tax_evidence"]) {
    const text = prompt(type);
    for (const label of ["Invoice Number", "Payout Reference", "Withholding Tax (PKR)", "Withholding Section", "Withholding IRIS Code", "Withholding Evidence Reference"])
      assert.ok(text.includes(label), `${type}: ${label}`);
    assert.match(text, /SAME numeric row suffix/);
    assert.match(text, /missing section, code, amount, invoice\/payout reference or certificate reference stays null/);
    assert.match(text, /net bank credit, gross-minus-net difference.*does NOT prove withholding or an IRIS code/);
    assert.match(text, /Ordinary bank statement lines without explicit withholding facts must not create withholding fields/);
  }
});

test("extraction prompt keeps invoice payout facts separate from certificate authority", () => {
  const text = loadExtractionPrompt()("invoice_summary");
  assert.match(text, /Gross Service Amount \(PKR\)/);
  assert.match(text, /Net Payout \(PKR\)/);
  assert.match(text, /Do not infer missing values/);
  assert.match(text, /Invoice lines are not bank transactions/);
  assert.doesNotMatch(text, /If this source explicitly contains Services withholding certificate\/statement lines/);
});
