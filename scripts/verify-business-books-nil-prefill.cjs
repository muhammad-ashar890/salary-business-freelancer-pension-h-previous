"use strict";
/**
 * 27-Oct (operator asked for this behaviour: a 0 prefill is fine):
 * the seven yearly Business Books figures after Sales are proposed as 0 on the
 * review screen instead of stopping Save & Approve Map as red-required blanks.
 *
 * Checks:
 *   1. withDerivedNilBusinessBooksFigures fills only the 7 labels after Sales,
 *      never overwrites a stated figure (a reviewed 0 included), never invents
 *      Sales, gives every proposal 0 / confidence 0.9 / derived true, and adds
 *      a box for a label the extraction omitted;
 *   2. it touches only payloads that carry those labels, and the review hook
 *      applies it to business_books documents only;
 *   3. extraction itself still never supplies an absent zero;
 *   4. the packet check no longer blocks on a figure the Business Profit form
 *      has not saved yet, but a real disagreement still throws;
 *   5. end to end: a prefilled Books reading puts 0 into the Business profit
 *      figures instead of leaving the key absent.
 * Synthetic data only.
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
require.extensions[".ts"] = (m, file) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    file,
  );

const labels = require("../lib/tax/business-books-annual-labels.ts");
const schedule = require("../lib/tax/business-schedule-fields.ts");
const figures = require("../lib/tax/business-books-figures.ts");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const AFTER_SALES = [
  "Other business receipts",
  "Cost of sales",
  "Business expenses",
  "Depreciation",
  "Expenses that are not allowed",
  "Business loss brought forward",
  "Tax already deducted on business receipts",
];
const prefill = labels.withDerivedNilBusinessBooksFigures;
const byLabel = (fields, label) => fields.find((f) => f.label === label);

// The review payload of a Books screenshot that only stated Sales and Cost of
// sales; the other six figures were not visible on the page.
const screenshot = () => [
  { label: "Business Name", value: "SYNTHETIC TRADERS", confidence: 0.95 },
  { label: "Tax Year", value: 2026, confidence: 0.95 },
  { label: "Sales for the year", value: 12000000, confidence: 0.95 },
  { label: "Cost of sales", value: 7200000, confidence: 0.9 },
  { label: "Other business receipts", value: null, confidence: 0 },
  { label: "Business expenses", value: "", confidence: 0 },
];

// ---------------------------------------------------------------------------
// 1. What the review screen proposes
// ---------------------------------------------------------------------------

test("review: every blank figure after Sales is proposed as 0, derived, confidence 0.9", () => {
  const out = prefill(screenshot());
  for (const label of AFTER_SALES.filter((label) => label !== "Cost of sales")) {
    const field = byLabel(out, label);
    assert.ok(field, `${label} has a box`);
    assert.equal(field.value, 0, label);
    assert.equal(field.confidence, 0.9, label);
    assert.equal(field.derived, true, label);
  }
  const costOfSales = byLabel(out, "Cost of sales");
  assert.equal(costOfSales.value, 7200000, "the stated Cost of sales is left alone");
  assert.equal(costOfSales.derived, undefined);
  assert.equal(out.length, screenshot().length + 4, "the 4 omitted labels are appended");
});

test("review: a stated figure is never overwritten, a reviewed 0 included", () => {
  const stated = [
    { label: "Sales for the year", value: 12000000, confidence: 0.95 },
    { label: "Cost of sales", value: 7200000, confidence: 0.9, sourceEvidence: "Cost of sales 7,200,000" },
    { label: "Depreciation", value: 0, confidence: 0.95 },
    { label: "Other business receipts", value: 120000, confidence: 0.88 },
  ];
  const out = prefill(stated);
  assert.equal(byLabel(out, "Sales for the year").value, 12000000);
  assert.equal(byLabel(out, "Cost of sales").value, 7200000);
  assert.equal(byLabel(out, "Cost of sales").confidence, 0.9);
  assert.equal(byLabel(out, "Cost of sales").sourceEvidence, "Cost of sales 7,200,000");
  assert.equal(byLabel(out, "Cost of sales").derived, undefined);
  assert.equal(byLabel(out, "Depreciation").confidence, 0.95, "a reviewed 0 keeps its own provenance");
  assert.equal(byLabel(out, "Depreciation").derived, undefined);
  assert.equal(byLabel(out, "Other business receipts").value, 120000);
  assert.equal(byLabel(out, "Business expenses").value, 0);
});

test("review: Sales is never invented and never appended", () => {
  const out = prefill([{ label: "Cost of sales", value: 100 }]);
  assert.equal(byLabel(out, "Sales for the year"), undefined);
  const blankSales = prefill([{ label: "Sales for the year", value: null }]);
  assert.equal(byLabel(blankSales, "Sales for the year").value, null);
  assert.equal(byLabel(blankSales, "Sales for the year").derived, undefined);
});

test("review: labels match regardless of case, spacing or trailing punctuation", () => {
  const out = prefill([
    { label: "business  expenses", value: null },
    { label: "Depreciation.", value: "" },
  ]);
  assert.equal(byLabel(out, "business  expenses").value, 0);
  assert.equal(byLabel(out, "Depreciation.").value, 0);
  assert.equal(out.filter((f) => /^depreciation/i.test(String(f.label))).length, 1, "no duplicate box");
});

test("review: a payload without any of the seven labels is passed through untouched", () => {
  const previousReturn = [
    { label: "Taxpayer Name", value: "SYNTHETIC", confidence: 0.9 },
    { label: "703002 Net assets as at 30 June 2025", value: 8780220, confidence: 0.9 },
  ];
  const out = prefill(previousReturn);
  assert.equal(out.length, 2);
  assert.deepEqual(out, previousReturn);
  assert.deepEqual(prefill(undefined), []);
  assert.deepEqual(prefill([]), []);
});

test("review: the input payload is not mutated", () => {
  const input = screenshot();
  const copy = JSON.parse(JSON.stringify(input));
  prefill(input);
  assert.deepEqual(input, copy);
});

// ---------------------------------------------------------------------------
// 2. Where it runs
// ---------------------------------------------------------------------------

test("wiring: the review hook composes the Books prefill for the uploaded slot type", () => {
  const hook = read("components/tax/filing/hooks/use-filing-documents.ts");
  assert.ok(hook.includes('import { withDerivedNilReviewPayload } from "@/lib/tax/review-prefill";'));
  assert.match(hook, /withDerivedNilReviewPayload\(documentType, payload\)/);
  assert.match(hook, /const payload = reviewPayload\(record\.id\);|const extracted = reviewPayload\(record\.id\);/);
  assert.ok(hook.includes("slotTypeByDocumentId[documentId] ?? payload.documentType"));
  assert.ok(
    hook.includes("extractedByDocumentId: reviewExtractedByDocumentId"),
    "the reviewer's payload is what Save & Approve Map sends",
  );
  const compose = require("../lib/tax/review-prefill.ts").withDerivedNilReviewFields;
  const filled = compose("business_books", [
    { label: "Sales for the year", value: 12000000 },
    { label: "Depreciation", value: null },
    { label: "Business loss brought forward", value: null },
  ]);
  assert.equal(byLabel(filled, "Depreciation").value, 0);
  assert.equal(byLabel(filled, "Business loss brought forward").value, 0);
  assert.equal(byLabel(filled, "Sales for the year").value, 12000000);
  assert.equal(byLabel(compose("business_support", [{ label: "Depreciation", value: null }]), "Depreciation").derived, undefined);
});

// The exact screen the user reported (27 Oct): eight yearly figures as red
// required boxes, five of them nil, which stopped Save & Approve Map.
const fullBooks = () =>
  [
    ["Business Name", "SYNTHETIC TRADERS"],
    ["Tax Year", 2026],
    ["Currency", "PKR"],
    ["Reporting Period Start", "2025-07-01"],
    ["Reporting Period End", "2026-06-30"],
    ["Sales for the year", 12000000],
    ["Cost of sales", 7200000],
    ["Other business receipts", null],
    ["Business expenses", null],
    ["Depreciation", null],
    ["Expenses that are not allowed", null],
    ["Business loss brought forward", null],
    ["Tax already deducted on business receipts", null],
  ].map(([label, value]) => ({ label, value }));

test("review: the seven red required figures become confirmable boxes, no required error left", () => {
  const review = require("../lib/tax/document-review-required.ts");
  const before = review.getDocumentReviewRequiredErrors("business_books", fullBooks(), 2026);
  assert.ok(before.length > 0);
  assert.ok(before.every((text) => /is required/.test(text)), "the screen was red-required, not invalid");
  const after = review.getDocumentReviewRequiredErrors(
    "business_books",
    prefill(fullBooks()),
    2026,
  );
  assert.deepEqual(after, []);
});

test("review: Sales is still required when it was not read, even after the prefill", () => {
  const review = require("../lib/tax/document-review-required.ts");
  const fields = fullBooks().map((f) =>
    f.label === "Sales for the year" ? { ...f, value: null } : f,
  );
  const errors = review.getDocumentReviewRequiredErrors("business_books", prefill(fields), 2026);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Sales for the year is required/);
});

test("wiring: the helper lives in the module with no imports and adds no cycle", () => {
  const source = read("lib/tax/business-books-annual-labels.ts");
  assert.equal(/^\s*import\s/m.test(source), false, "no imports");
  assert.ok(source.includes("export function withDerivedNilBusinessBooksFigures"));
  assert.ok(source.includes("export const BUSINESS_BOOKS_FIGURE_LABELS_AFTER_SALES"));
});

test("extraction: the never-supply-an-absent-zero rule is untouched", () => {
  const extraction = read("lib/tax/business-books-extraction.ts");
  assert.equal(
    extraction.includes("withDerivedNilBusinessBooksFigures"),
    false,
    "the prefill is not part of extraction",
  );
  const suite = read("scripts/verify-business-books-extraction.cjs");
  assert.ok(
    suite.includes("seven annual rows missed in screenshot are detected, not supplied as assumed zeros"),
    "that rule still has its own test",
  );
});

// ---------------------------------------------------------------------------
// 3. The packet check
// ---------------------------------------------------------------------------

const BOOKS = {
  "Business Name": "SYNTHETIC TEST BUSINESS",
  "Tax Year": 2026,
  Currency: "PKR",
  "Reporting Period Start": "2025-07-01",
  "Reporting Period End": "2026-06-30",
  "Sales for the year": 6000000,
  "Other business receipts": 0,
  "Cost of sales": 2000000,
  "Business expenses": 1000000,
  Depreciation: 0,
  "Expenses that are not allowed": 0,
  "Business loss brought forward": 0,
  "Tax already deducted on business receipts": 0,
};
const booksDocument = (data = BOOKS) => ({
  id: "synthetic-books",
  extractionStatus: "MAPPED",
  extractedData: JSON.stringify({
    fields: Object.entries(data).map(([label, value]) => ({ label, value })),
  }),
});
// The Business Profit form as it stands right after the Books are mapped: the
// nil figures have never been saved there.
const approved = (overrides = {}) => ({
  businessGrossSales: 6000000,
  businessOtherRevenue: null,
  businessCostOfSales: 2000000,
  businessOperatingExpenses: 1000000,
  businessDepreciation: null,
  businessInadmissibleExpenses: null,
  businessLossBroughtForward: null,
  businessWithholdingDeducted: null,
  ...overrides,
});
const build = (approvedInputs, document = booksDocument()) =>
  schedule.buildReviewedBusinessSchedules({
    taxYear: 2026,
    approvedInputs,
    salesExcludeIndirectTax: true,
    document,
  });

test("packet: a proposed 0 is not blocked by a form figure that is not saved yet", () => {
  const result = build(approved());
  assert.equal(result.businessName, "SYNTHETIC TEST BUSINESS");
  assert.ok(Array.isArray(result.fields));
});

test("packet: a real disagreement still throws", () => {
  for (const [key, label] of [
    ["businessOtherRevenue", "Other business receipts"],
    ["businessDepreciation", "Depreciation"],
    ["businessWithholdingDeducted", "Tax already deducted on business receipts"],
    ["businessGrossSales", "Sales for the year"],
  ])
    assert.throws(
      () => build(approved({ [key]: 5 })),
      new RegExp(`Business Books and saved Business Profit disagree for ${label}`),
      label,
    );
});

test("packet: a blank Books figure is still never compared with the saved one", () => {
  const blankDepreciation = { ...BOOKS, Depreciation: "" };
  assert.doesNotThrow(() => build(approved({ businessDepreciation: 150000 }), booksDocument(blankDepreciation)));
});

// ---------------------------------------------------------------------------
// 4. End to end on the review payload
// ---------------------------------------------------------------------------

test("end to end: a prefilled Books reading puts 0 into the Business profit figures", () => {
  const reviewed = prefill(screenshot());
  const document = {
    id: "synthetic-books",
    extractionStatus: "MAPPED",
    extractedData: JSON.stringify({ fields: reviewed }),
  };
  const reading = schedule.readBusinessBooksAnnual(document.extractedData);
  assert.equal(reading.figures.businessGrossSales, 12000000);
  assert.equal(reading.figures.businessCostOfSales, 7200000);
  for (const key of [
    "businessOtherRevenue",
    "businessOperatingExpenses",
    "businessDepreciation",
    "businessInadmissibleExpenses",
    "businessLossBroughtForward",
    "businessWithholdingDeducted",
  ])
    assert.equal(reading.figures[key], 0, key);

  const profitDetails = figures.withBusinessBooksValues({}, reading);
  assert.equal(profitDetails.businessGrossSales, 12000000);
  assert.equal(profitDetails.businessDepreciation, 0, "a 0 is a figure, not an absent key");
  assert.equal(
    Object.values(profitDetails).some((v) => v === null || v === undefined),
    false,
  );
});
