"use strict";
/**
 * Business Balance Sheet required (16-Oct-2026). FBR's business return for an
 * individual includes Annex-B with the "Statement of Affairs / Balance Sheet"
 * (Income Tax Rules 2002, Second Schedule Part-II-F, SRO 841(I)/2015), so a
 * business filing needs the uploaded Balance Sheet, reviewed and mapped. The
 * figures come from the document: every row is a required review field (a
 * figure the PDF does not show is typed on the review screen; 0 is allowed, a
 * blank is not), and the rows must add up to the totals before Save & Approve
 * Map. There is no typed Balance Sheet on the Business profit step.
 *
 * Checks lib/tax/document-review-required.ts (the 20 required fields and the
 * totals check), the review screen (wizard-documents-step.tsx), the document
 * slot, the pre-filing gate (filing-completeness.ts), the business packet
 * (a 0 row is not typed) and the wizard wiring. Synthetic data only.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(
    this,
    request.startsWith("@/") ? path.join(root, request.slice(2)) : request,
    ...rest,
  );
};
const compile = (jsx) => (m, file) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
        ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
      },
    }).outputText,
    file,
  );
require.extensions[".ts"] = compile(false);
require.extensions[".tsx"] = compile(true);

const req = require(path.join(root, "lib/tax/document-review-required.ts"));
const business = require(path.join(root, "lib/tax/business-filing.ts"));
const docs = require(path.join(root, "lib/tax/document-requirements.ts"));
const { validateFilingCompleteness } = require(path.join(root, "lib/tax/filing-completeness.ts"));
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const TYPE = "business_balance_sheet";

// The live-test Scenario A Balance Sheet (synthetic): assets 8,825,000 =
// capital 6,775,000 + liabilities 2,050,000.
const A = {
  businessName: "AL-NOOR TRADERS (TEST)", taxYear: 2026, closingDate: "2026-06-30", currency: "PKR",
  totalAssets: 8825000, totalEquityLiabilities: 8825000,
  land: 2000000, building: 1800000, plant: 1500000, vehicle: 700000, advances: 150000,
  stock: 1200000, cash: 75000, bank: 1250000, securities: 100000, otherAssets: 50000,
  capital: 6775000, loans: 1000000, payables: 900000, otherLiabilities: 150000,
};
// A small trader whose PDF shows no land, building, vehicle, securities or loans.
const SMALL = {
  businessName: "SYNTHETIC TRADER", taxYear: 2026, closingDate: "2026-06-30", currency: "PKR",
  totalAssets: 1000000, totalEquityLiabilities: 1000000,
  land: 0, building: 0, plant: 0, vehicle: 0, advances: 250000, stock: 600000, cash: 150000,
  bank: 0, securities: 0, otherAssets: 0, capital: 800000, loans: 0, payables: 200000, otherLiabilities: 0,
};
const L = business.BUSINESS_BALANCE_LABELS;
const fieldsOf = (values, overrides = {}) =>
  Object.entries(L).map(([key, label]) => ({
    label,
    value: key in overrides ? overrides[key] : values[key],
  }));
const errorsOf = (values, overrides) =>
  req.getDocumentReviewRequiredErrors(TYPE, fieldsOf(values, overrides), 2026);

// ---------------------------------------------------------------------------
// The 20 required review fields
// ---------------------------------------------------------------------------
test("review: all 20 Balance Sheet fields are required, exactly the extraction labels", () => {
  const placeholders = req.ensureRequiredDocumentReviewFields(TYPE, { fields: [] }).fields;
  assert.equal(placeholders.length, 20);
  assert.ok(placeholders.every((field) => field.value === null), "blank placeholders, never an inferred 0");
  assert.deepEqual(
    placeholders.map((field) => field.label).sort(),
    Object.values(L).slice().sort(),
    "the required labels are the labels the extraction and the packet use",
  );
  for (const label of Object.values(L))
    assert.equal(req.isDocumentReviewRequiredField(TYPE, label), true, label);
  // The 14 rows: 10 asset rows and Owner Capital + 3 liability rows.
  assert.equal(req.BALANCE_SHEET_ASSET_ROWS.length, 10);
  assert.equal(req.BALANCE_SHEET_LIABILITY_ROWS.length, 4);
  const assetLabels = ["land", "building", "plant", "vehicle", "advances", "stock", "cash", "bank", "securities", "otherAssets"].map((k) => L[k]);
  const liabilityLabels = ["capital", "loans", "payables", "otherLiabilities"].map((k) => L[k]);
  assert.deepEqual([...req.BALANCE_SHEET_ASSET_ROWS].sort(), assetLabels.sort());
  assert.deepEqual([...req.BALANCE_SHEET_LIABILITY_ROWS].sort(), liabilityLabels.sort());
  // The review screen gets the same 20 placeholders from the server side.
  assert.equal(business.ensureBusinessBalanceReviewFields({ fields: [] }).fields.length, 20);
});

test("review: a complete sheet passes; 0 is a valid answer, a blank is not", () => {
  assert.deepEqual(errorsOf(A), []);
  assert.deepEqual(errorsOf(SMALL), [], "rows of 0 are fine");
  assert.deepEqual(errorsOf(SMALL, { securities: "0" }), [], "0 typed as text is fine");
  for (const blank of [null, undefined, "", "   "]) {
    const errors = errorsOf(SMALL, { securities: blank });
    assert.ok(
      errors.includes("Bonds / Securities is required: type the figure from your Balance Sheet, or 0 if the business has none."),
      JSON.stringify({ blank, errors }),
    );
    assert.ok(!errors.some((error) => /do not add up/.test(error)), "no sum error while a row is still blank");
  }
  assert.ok(errorsOf(SMALL, { cash: -5 }).includes("Business Cash in Hand: enter a valid amount."));
  assert.ok(errorsOf(SMALL, { cash: "abc" }).includes("Business Cash in Hand: enter a valid amount."));
  // The 6 fields that were already required keep their old messages.
  assert.ok(errorsOf(SMALL, { currency: null }).includes("Currency is required. Enter it manually from your records if it was not extracted."));
  assert.ok(errorsOf(SMALL, { closingDate: "2026-06-29" }).includes("Balance Sheet Date must be 2026-06-30."));
});

test("review: the rows must add up to the totals, and the two totals must be equal", () => {
  assert.deepEqual(errorsOf(A, { cash: 70000 }), [
    "Balance Sheet assets do not add up: the 10 asset rows add up to Rs 8,820,000, but Total Assets is Rs 8,825,000 (difference Rs 5,000). Correct the rows or the total.",
  ]);
  assert.deepEqual(errorsOf(A, { payables: 950000 }), [
    "Balance Sheet capital and liabilities do not add up: Owner Capital and the 3 liability rows add up to Rs 8,875,000, but Total Equity and Liabilities is Rs 8,825,000 (difference Rs 50,000). Correct the rows or the total.",
  ]);
  // Each side adds up, but the totals differ.
  assert.deepEqual(errorsOf(A, { totalEquityLiabilities: 8800000, capital: 6750000 }), [
    "Total Assets (Rs 8,825,000) and Total Equity and Liabilities (Rs 8,800,000) must be equal on a Balance Sheet.",
  ]);
  // A row left out of the PDF but counted in its total is caught.
  assert.equal(errorsOf(A, { otherAssets: 0 }).length, 1);
  // Commas and paisa are read exactly (no floating-point drift).
  assert.deepEqual(
    errorsOf(SMALL, { totalAssets: "1,000,000.30", totalEquityLiabilities: "1,000,000.30", cash: "150,000.10", stock: "600000.20", capital: "800,000.30" }),
    [],
  );
});

test("map: Save & Approve Map runs the same required check before reading the sheet", () => {
  const action = read("app/actions/extraction.ts");
  const start = action.indexOf("export async function approveAndMapExtractedDocumentAction");
  assert.ok(start > 0);
  const body = action.slice(start, action.indexOf('if (document.documentType === "bank_statement")', start));
  assert.match(body, /"business_balance_sheet",/);
  assert.match(body, /getDocumentReviewRequiredErrors\(\s*document\.documentType,\s*fields,\s*reviewDraft\.taxYear,?\s*\)/);
  assert.match(body, /if \(requiredErrors\.length\)\s*return \{ success: false, error: requiredErrors\.join\(" "\) \}/);
  // The reviewed sheet then reads without pending breakdown gaps.
  const sheet = business.readBusinessBalanceSheet({ fields: fieldsOf(A) }, 2026);
  assert.deepEqual(sheet.gaps, []);
  assert.equal(sheet.amounts.totalAssets, 8825000);
});

// ---------------------------------------------------------------------------
// The review screen
// ---------------------------------------------------------------------------
function renderReview(fields, extractionStatus = "COMPLETED") {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { JSDOM } = require("jsdom");
  const { WizardDocumentsStep } = require(path.join(root, "components/tax/filing/wizard-documents-step.tsx"));
  const noop = () => {};
  const props = {
    taxYear: 2026,
    documentSlots: [{ documentType: TYPE, label: "Business Balance Sheet", reason: "Review", required: true }],
    uploadedDocuments: { [TYPE]: "fixture.pdf" },
    documentRecords: { [TYPE]: { id: "fixture-document", fileName: "fixture.pdf", extractionStatus, extractionProvider: "synthetic", extractedAt: null, extractionError: null } },
    extractedByDocumentId: { "fixture-document": { fields } },
    uploadingDocumentType: null, extractingDocumentId: null, reviewingDocumentId: "fixture-document",
    savingDocumentReviewId: null, mappingDocumentId: null, documentUploadError: null, profileSyncNote: null,
    uploadFileInputsRef: { current: {} },
    triggerDocumentUpload: noop, handleDocumentFileSelected: noop, handleExtractDocument: noop,
    handleReviewDocument: noop, handleExtractedFieldChange: noop, handleExtractedTransactionChange: noop,
    handleSaveDocumentReview: noop, handleMapDocument: noop, handleSaveStatementIban: noop,
    handleSaveSalaryEmployers: noop, isSalaryEmployerDirty: () => false,
  };
  const html = renderToStaticMarkup(React.createElement(WizardDocumentsStep, props));
  return { html, doc: new JSDOM(html).window.document };
}
const mapButton = (doc) => [...doc.querySelectorAll("button")].find((b) => b.textContent === "Save & Approve Map");

test("review screen: 20 Required rows, the sum error is shown and Save & Approve Map stays disabled", () => {
  const { html, doc } = renderReview(fieldsOf(A, { cash: 70000 }));
  assert.equal(doc.querySelectorAll("input[required]").length, 20);
  const alert = doc.querySelector('[role="alert"]');
  assert.ok(alert && alert.textContent.includes("Balance Sheet assets do not add up"), html.slice(0, 200));
  assert.ok(alert.textContent.includes("(difference Rs 5,000)"));
  assert.equal(mapButton(doc).disabled, true);
  assert.ok(html.includes("Every Balance Sheet row is required: type the figure"));
  assert.ok(html.includes("or 0 if the business has none"));
  assert.ok(html.includes(">Required<"), "the slot shows the Required badge");
});

test("review screen: a blank row is named and blocks the map; a complete sheet can be mapped", () => {
  const blank = renderReview(fieldsOf(SMALL, { land: null }));
  assert.ok(blank.doc.querySelector('[role="alert"]').textContent.includes("Business Land is required: type the figure from your Balance Sheet, or 0 if the business has none."));
  assert.equal(mapButton(blank.doc).disabled, true);
  const done = renderReview(fieldsOf(SMALL));
  assert.equal(done.doc.querySelector('[role="alert"]'), null);
  assert.equal(mapButton(done.doc).disabled, false);
  // After mapping the note is gone (the values are read-only).
  const mapped = renderReview(fieldsOf(SMALL), "MAPPED");
  assert.ok(!mapped.html.includes("Every Balance Sheet row is required: type the figure"));
  assert.ok(!mapped.html.includes("This Balance Sheet was mapped before every row had to"));
  // A sheet mapped before the rule, with a blank row: the way out is Replace.
  const old = renderReview(fieldsOf(SMALL, { land: null }), "MAPPED");
  assert.ok(old.html.includes("This Balance Sheet was mapped before every row had to"));
  assert.ok(old.html.includes("Press Replace, upload it again"));
});

// ---------------------------------------------------------------------------
// Document slot and the pre-filing gate
// ---------------------------------------------------------------------------
test("document slot: required for business income only", () => {
  const slots = docs.buildTaxDocumentSlotsPreview({ incomeSources: ["business"], readinessCompleted: [] });
  const slot = slots.find((s) => s.documentType === TYPE);
  assert.equal(slot.label, "Business Balance Sheet");
  assert.equal(slot.required, true);
  assert.match(slot.reason, /^Required for business income/);
  assert.match(slot.reason, /fill every row \(0 if the business has none\)/);
  assert.ok(docs.getRequiredTaxDocumentTypesForCurrentFlow({ incomeSources: ["business"] }).includes(TYPE));
  assert.ok(!docs.getRequiredTaxDocumentTypesForCurrentFlow({ incomeSources: ["salary"] }).includes(TYPE));
});

function gateDb({ incomeSources = ["business"], documents = [] } = {}) {
  return {
    filingDraft: {
      findFirst: async () => ({
        id: "synthetic-draft",
        userId: "synthetic-user",
        taxYear: 2026,
        incomeSources: JSON.stringify(incomeSources),
        filerType: "myself",
      }),
    },
    bankAccount: { findMany: async () => [] },
    document: { findMany: async () => documents },
    bankStatement: { findMany: async () => [] },
    bankTransaction: { findMany: async () => [] },
  };
}
const sheetBlockers = async (db) =>
  (await validateFilingCompleteness({ draftId: "synthetic-draft", userId: "synthetic-user" }, db)).blockers.filter(
    (b) => b.includes(TYPE) || b.startsWith("Business Balance Sheet"),
  );
const bsDocument = (extractionStatus, values, overrides) => ({
  id: "bs1", documentType: TYPE, bankAccountId: null, extractionStatus,
  extractedData: JSON.stringify({ fields: fieldsOf(values, overrides) }),
});

test("gate: no Balance Sheet, or one not mapped yet, blocks a business filing", async () => {
  assert.deepEqual(await sheetBlockers(gateDb()), ["Upload the required business_balance_sheet document"]);
  assert.deepEqual(await sheetBlockers(gateDb({ documents: [bsDocument("COMPLETED", A)] })), [
    "Review and approve/map the required business_balance_sheet document",
  ]);
  assert.deepEqual(await sheetBlockers(gateDb({ incomeSources: ["salary"] })), [], "no business income: not required");
});

test("gate: a mapped, complete Balance Sheet passes; one mapped before the rule must be uploaded again", async () => {
  assert.deepEqual(await sheetBlockers(gateDb({ documents: [bsDocument("MAPPED", A)] })), []);
  assert.deepEqual(await sheetBlockers(gateDb({ documents: [bsDocument("MAPPED", SMALL)] })), []);
  const old = await sheetBlockers(gateDb({ documents: [bsDocument("MAPPED", SMALL, { land: null, building: null })] }));
  assert.deepEqual(old, [
    "Business Balance Sheet: Business Land is required: type the figure from your Balance Sheet, or 0 if the business has none.",
    "Business Balance Sheet: Business Building is required: type the figure from your Balance Sheet, or 0 if the business has none.",
    "Business Balance Sheet: it was mapped before every row had to be filled and add up to the totals. On Upload documents press Replace, upload it again, fill every row (0 if the business has none) and press Save & Approve Map.",
  ]);
  const short = await sheetBlockers(gateDb({ documents: [bsDocument("MAPPED", A, { otherAssets: 0 })] }));
  assert.equal(short.length, 2);
  assert.match(short[0], /^Business Balance Sheet: Balance Sheet assets do not add up/);
});

// ---------------------------------------------------------------------------
// Packet and wizard
// ---------------------------------------------------------------------------
const values = {
  businessGrossSales: 1000000, businessOtherRevenue: 30000, businessCostOfSales: 600000,
  businessOperatingExpenses: 100000, businessDepreciation: 20000, businessInadmissibleExpenses: 5000,
  businessLossBroughtForward: 10000, businessWithholdingDeducted: 15000, businessSalesExcludeIndirectTax: true,
};
const packetInput = (sheetValues) => ({
  taxYear: 2026,
  filerType: "myself",
  incomeSources: ["business"],
  selections: [{ source: "business", subcategory: "profit-return", detailsJson: JSON.stringify({ userDetails: values }) }],
  balanceSheet: { id: "synthetic-document", extractionStatus: "MAPPED", extractedData: JSON.stringify({ fields: fieldsOf(sheetValues) }) },
});

test("packet: rows above 0 are typed, a 0 row is not (an empty IRIS row counts as 0)", () => {
  const small = business.buildBusinessPacket(packetInput(SMALL));
  const codes = small.fields.map((f) => f.irisCode).filter((c) => c !== "3009").sort();
  assert.deepEqual(codes, ["3312", "3315", "3319", "3352", "3384"]);
  assert.ok(!small.pending.some((i) => i.key === "balanceSheet.breakdown"), "a complete sheet has no breakdown gaps");
  for (const key of ["land", "building", "bank", "vehicle"])
    assert.ok(!small.pending.some((i) => i.key === `balanceSheet.${key}`), `${key} is 0: nothing manual`);
  // Scenario A: all ten scalar rows are above 0 and all ten are typed (as before).
  const a = business.buildBusinessPacket(packetInput(A));
  assert.equal(a.fields.filter((f) => f.irisCode !== "3009").length, 10);
  assert.ok(a.pending.some((i) => i.key === "balanceSheet.land"), "land stays a manual item");
  assert.ok(a.pending.some((i) => i.key === "balanceSheet.building"), "building stays a manual item");
});

test("wizard: no typed Balance Sheet on Business profit; the client asks for the map like the server", () => {
  assert.equal(fs.existsSync(path.join(root, "lib/tax/business-balance-typed.ts")), false);
  const step = read("components/tax/filing/wizard-business-profit-step.tsx");
  for (const gone of ["businessBalanceSheetTyped", "I do not have a Balance Sheet", "business-balance-typed", "setTypedSheetValue"])
    assert.ok(!step.includes(gone), gone);
  assert.ok(step.includes("To continue, finish these:"), "the open-answers box stays");
  assert.ok(/^[\x00-\x7F]*$/.test(step), "wizard file stays ASCII");
  assert.ok(!read("lib/tax/rules/ty2026/subcategories.ts").includes("businessBalanceSheetTyped"));
  assert.ok(!read("components/tax/filing/wizard-documents-step.tsx").includes("type it on Business profit"));
  const wizard = read("components/tax/filing/filing-wizard.tsx");
  assert.ok(wizard.includes("Save & Approve Map for the Business Balance Sheet before approving the filing"));
  assert.match(
    wizard,
    /"business_books",\s*"business_balance_sheet",[\s\S]{0,120}?\]\.includes\(slot\.documentType\)/,
  );
  const gate = read("lib/tax/filing-completeness.ts");
  assert.match(gate, /DOCUMENT_TYPES_REQUIRING_MAPPING = new Set\(\[[^\]]*"business_balance_sheet",/);
  assert.ok(!gate.includes("incomeSelections"), "the gate no longer reads typed figures");
});
