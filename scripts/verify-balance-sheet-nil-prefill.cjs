"use strict";
/**
 * 27-Oct: a Balance Sheet whose printed totals prove a row is nil gets 0 there
 * on the review screen, instead of a red "type the figure ... or 0 if the
 * business has none" row the reviewer has to answer by hand.
 *
 * Reported screen: cash 15,000,000, Total Assets 15,000,000, capital
 * 15,000,000, Total Equity and Liabilities 15,000,000 - and three red rows
 * (Business Motor Vehicles, Bonds / Securities, Other Business Assets).
 *
 * Checks:
 *   1. the proof itself: both totals present, valid and equal, and the rows the
 *      document DID print on a side already add up to that side's total;
 *   2. a stated figure is never overwritten (a reviewed 0 keeps its own
 *      provenance); each fill is 0 / confidence 0.9 / derived true; an omitted
 *      row still gets a box;
 *   3. nothing is filled when the proof is missing: totals unequal, rows not
 *      adding up, a duplicate row, an unreadable value;
 *   4. the review hook applies it to business_balance_sheet only;
 *   5. end to end through getDocumentReviewRequiredErrors: the reported three
 *      required errors disappear, and reappear when the sheet does not prove it.
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

const review = require("../lib/tax/document-review-required.ts");
const prefill = review.withDerivedNilBalanceSheetRows;
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const ASSETS = review.BALANCE_SHEET_ASSET_ROWS;
const LIABILITIES = review.BALANCE_SHEET_LIABILITY_ROWS;
const byLabel = (fields, label) => fields.filter((f) => f.label === label);

// The reported sheet: the whole position sits in the bank, so every other row
// is nil, and both printed totals are 15,000,000.
function sheet(overrides = {}, meta = {}) {
  const data = {
    "Business Name": "SYNTHETIC TRADERS",
    "Tax Year": 2026,
    "Balance Sheet Date": "2026-06-30",
    Currency: "PKR",
    "Business Bank Balance": 15000000,
    "Owner Capital": 15000000,
    "Total Assets": 15000000,
    "Total Equity and Liabilities": 15000000,
    ...overrides,
  };
  const fields = Object.entries({ ...data, ...meta }).map(([label, value]) => ({
    label,
    value,
    confidence: label === "Business Bank Balance" ? 0.95 : 0.9,
  }));
  return fields;
}

// ---------------------------------------------------------------------------
// 1. The proof
// ---------------------------------------------------------------------------

test("proof: a side whose printed rows already equal the total has its blanks filled with 0", () => {
  const out = prefill(sheet());
  for (const label of ASSETS.filter((l) => l !== "Business Bank Balance"))
    assert.equal(byLabel(out, label)[0].value, 0, label);
  for (const label of LIABILITIES.filter((l) => l !== "Owner Capital"))
    assert.equal(byLabel(out, label)[0].value, 0, label);
  assert.equal(byLabel(out, "Business Bank Balance")[0].value, 15000000);
  assert.equal(byLabel(out, "Owner Capital")[0].value, 15000000);
});

test("proof: every filled row is 0 at confidence 0.9 and marked derived", () => {
  const out = prefill(sheet());
  for (const label of ["Business Motor Vehicles", "Bonds / Securities", "Other Business Assets"]) {
    const field = byLabel(out, label)[0];
    assert.equal(field.value, 0, label);
    assert.equal(field.confidence, 0.9, label);
    assert.equal(field.derived, true, label);
  }
});

test("proof: an omitted row still gets a box to confirm", () => {
  const fields = sheet().filter(
    (f) => f.label !== "Business Motor Vehicles" && f.label !== "Trade Creditors / Payables",
  );
  const out = prefill(fields);
  assert.equal(byLabel(out, "Business Motor Vehicles").length, 1);
  assert.equal(byLabel(out, "Business Motor Vehicles")[0].value, 0);
  assert.equal(byLabel(out, "Trade Creditors / Payables")[0].value, 0);
});

// ---------------------------------------------------------------------------
// 2. Never overwrite, never guess
// ---------------------------------------------------------------------------

test("stated figures stay: a printed row, a reviewed 0 and its own confidence", () => {
  const fields = sheet({ "Business Motor Vehicles": 415000, "Business Cash in Hand": 0 }, {
    "Total Assets": 15415000,
    "Total Equity and Liabilities": 15415000,
  });
  const out = prefill(fields);
  const vehicles = byLabel(out, "Business Motor Vehicles")[0];
  assert.equal(vehicles.value, 415000);
  assert.equal(vehicles.derived, undefined);
  const cash = byLabel(out, "Business Cash in Hand")[0];
  assert.equal(cash.value, 0);
  assert.equal(cash.derived, undefined, "a reviewed 0 keeps its own provenance");
  assert.equal(cash.confidence, 0.9);
  assert.equal(byLabel(out, "Bonds / Securities")[0].derived, true);
});

test("no proof: rows that do not add up to the total are left red-required, no 0 invented", () => {
  const short = sheet({ "Business Bank Balance": 14000000 });
  const out = prefill(short);
  for (const label of ASSETS.filter((l) => l !== "Business Bank Balance"))
    assert.equal(byLabel(out, label).length, 0, `${label} not filled`);
  assert.ok(
    review
      .getDocumentReviewRequiredErrors("business_balance_sheet", out, 2026)
      .some((text) => /Business Motor Vehicles is required/.test(text)),
  );
});

test("no proof: unequal totals fill nothing on either side", () => {
  const out = prefill(sheet({ "Total Equity and Liabilities": 14900000 }));
  assert.equal(out.length, sheet({ "Total Equity and Liabilities": 14900000 }).length);
  assert.equal(out.some((f) => f.derived === true), false);
});

test("no proof: a missing total fills nothing", () => {
  for (const label of ["Total Assets", "Total Equity and Liabilities"]) {
    const fields = sheet().filter((f) => f.label !== label);
    const out = prefill(fields);
    assert.equal(out.some((f) => f.derived === true), false, label);
  }
});

test("no proof: a duplicated row blocks that side only", () => {
  const fields = sheet();
  fields.push({ label: "Bonds / Securities", value: 250000, confidence: 0.8 });
  const out = prefill(fields);
  const filledAssetRows = ASSETS.filter(
    (label) => byLabel(out, label).some((f) => f.derived === true),
  );
  assert.deepEqual(filledAssetRows, [], "asset side untouched");
  assert.equal(
    byLabel(out, "Long Term Borrowings / Debt / Loan")[0].value,
    0,
    "liability side still proven",
  );
});

test("no proof: a value that is present but unreadable keeps its own error", () => {
  const out = prefill(sheet({ "Business Motor Vehicles": "n/a" }));
  const vehicles = byLabel(out, "Business Motor Vehicles")[0];
  assert.equal(vehicles.value, "n/a", "not replaced by 0");
  assert.equal(vehicles.derived, undefined);
  assert.ok(
    review
      .getDocumentReviewRequiredErrors("business_balance_sheet", out, 2026)
      .some((text) => /Business Motor Vehicles: enter a valid amount/.test(text)),
  );
});

test("other payloads pass through untouched and the input is not mutated", () => {
  const books = [
    { label: "Sales for the year", value: 12000000 },
    { label: "Depreciation", value: null },
  ];
  assert.deepEqual(prefill(books), books);
  assert.deepEqual(prefill(undefined), []);
  assert.deepEqual(prefill([]), []);
  const input = sheet();
  const copy = JSON.parse(JSON.stringify(input));
  prefill(input);
  assert.deepEqual(input, copy);
});

// ---------------------------------------------------------------------------
// 3. Wiring
// ---------------------------------------------------------------------------

test("wiring: the review hook composes the prefill from the SLOT type, not the model's declaration", () => {
  const hook = read("components/tax/filing/hooks/use-filing-documents.ts");
  assert.ok(hook.includes('import { withDerivedNilReviewPayload } from "@/lib/tax/review-prefill";'));
  assert.match(hook, /withDerivedNilReviewPayload\(documentType, payload\)/);
  assert.ok(hook.includes("out[record.id] = slotType"));
  assert.ok(
    hook.includes("slotTypeByDocumentId[documentId] ?? payload.documentType"),
    "the uploaded slot wins; the model's documentType is only a fallback",
  );
  assert.ok(
    !/payload\.documentType === "business_(books|balance_sheet)"/.test(hook),
    "no prefill is gated on what the model called the file",
  );
  assert.ok(hook.includes("extractedByDocumentId: reviewExtractedByDocumentId"));
});

test("composer: the slot decides, so a mislabelled payload still gets its proven zeros", () => {
  const compose = require("../lib/tax/review-prefill.ts").withDerivedNilReviewFields;
  const payloadTypeWrong = sheet();
  const filled = compose("business_balance_sheet", payloadTypeWrong);
  assert.equal(byLabel(filled, "Bonds / Securities")[0].value, 0);
  assert.equal(byLabel(filled, "Business Motor Vehicles")[0].value, 0);
  assert.equal(compose("profit_and_loss_statement", sheet()).some((f) => f.derived === true), false);
  assert.equal(compose(undefined, sheet()).some((f) => f.derived === true), false);
  // The Books and the previous return keep their own gates.
  const books = compose("business_books", [
    { label: "Sales for the year", value: 12000000 },
    { label: "Depreciation", value: null },
  ]);
  assert.equal(byLabel(books, "Depreciation")[0].value, 0);
  assert.equal(byLabel(books, "Sales for the year")[0].value, 12000000);
});

test("save path: Save & Approve Map sends the prefilled payload, not the stored one", () => {
  const hook = read("components/tax/filing/hooks/use-filing-documents.ts");
  const save = hook.slice(
    hook.indexOf("async function handleSaveDocumentReview("),
    hook.indexOf("async function handleRecoverBusinessPurchaseBasis("),
  );
  const map = hook.slice(
    hook.indexOf("async function handleMapDocument("),
    hook.indexOf("async function handleSaveStatementIban("),
  );
  assert.match(save, /const payload = reviewPayload\(record\.id\);/, "save sends the review payload");
  assert.match(map, /const extracted = reviewPayload\(record\.id\);/, "map sends the review payload");
  for (const [name, body] of [["save", save], ["map", map]])
    assert.equal(
      /(payload|extracted) = extractedByDocumentId\[record\.id\]/.test(body),
      false,
      `${name} must not send the raw stored payload`,
    );
  // The stored payload is what the server re-checks, so the two must agree:
  // the reviewer's screen and the payload sent are built by one function.
  assert.match(hook, /function reviewPayload\(documentId: string\)/);
  assert.match(hook, /withDerivedNilReviewPayload\(documentType, payload\)/);
  assert.match(hook, /out\[documentId\] = reviewPayload\(documentId\)/);
});

test("save path: the payload function fills the proven zeros and keeps everything else", () => {
  const { withDerivedNilReviewPayload } = require("../lib/tax/review-prefill.ts");
  const payload = {
    documentType: "profit_and_loss_statement",
    fields: sheet(),
    transactions: [{ date: "2026-06-30", amount: 1 }],
  };
  const out = withDerivedNilReviewPayload("business_balance_sheet", payload);
  assert.equal(out.fields.filter((f) => f.label === "Bonds / Securities")[0].value, 0);
  assert.deepEqual(out.transactions, payload.transactions, "other payload parts untouched");
  assert.equal(out.documentType, "profit_and_loss_statement", "the payload is not rewritten");
  assert.equal(
    withDerivedNilReviewPayload(undefined, payload).fields,
    payload.fields,
    "no document type = nothing filled",
  );
  assert.equal(withDerivedNilReviewPayload("business_balance_sheet", undefined), undefined);
  const noFields = { documentType: "business_balance_sheet" };
  assert.equal(withDerivedNilReviewPayload("business_balance_sheet", noFields), noFields);
});

test("wiring: the helper is exported from the module that owns the row labels and the tie-out", () => {
  const source = read("lib/tax/document-review-required.ts");
  assert.ok(source.includes("export function withDerivedNilBalanceSheetRows"));
  assert.ok(source.includes("export function balanceSheetTotalsErrors"));
  assert.ok(
    source.indexOf("export function withDerivedNilBalanceSheetRows") >
      source.indexOf("export const BALANCE_SHEET_ASSET_ROWS"),
    "the labels it fills are the same list the required check uses",
  );
});

// ---------------------------------------------------------------------------
// 4. End to end through the review errors
// ---------------------------------------------------------------------------

test("end to end: the reported three red rows become confirmable zeros, no error left", () => {
  const before = review.getDocumentReviewRequiredErrors(
    "business_balance_sheet",
    sheet(),
    2026,
  );
  for (const label of ["Business Motor Vehicles", "Bonds / Securities", "Other Business Assets"])
    assert.ok(
      before.some((text) => text.startsWith(`${label} is required`)),
      `${label} was red-required`,
    );
  assert.deepEqual(
    review.getDocumentReviewRequiredErrors("business_balance_sheet", prefill(sheet()), 2026),
    [],
  );
});

test("end to end: the filled rows still satisfy the Balance Sheet tie-out", () => {
  assert.deepEqual(review.balanceSheetTotalsErrors(prefill(sheet())), []);
  // A side that does not add up is left blank and keeps its required error;
  // the side that does add up is still filled, and no zero is invented to hide
  // the difference.
  const wrong = prefill(sheet({ "Business Bank Balance": 14000000 }));
  const filledAssets = ASSETS.filter(
    (label) => byLabel(wrong, label).some((f) => f.derived === true),
  );
  assert.deepEqual(filledAssets, [], "no asset row was guessed");
  assert.ok(
    review
      .getDocumentReviewRequiredErrors("business_balance_sheet", wrong, 2026)
      .some((text) => /Business Motor Vehicles is required/.test(text)),
    "the difference is still the reviewer's to answer",
  );
});
