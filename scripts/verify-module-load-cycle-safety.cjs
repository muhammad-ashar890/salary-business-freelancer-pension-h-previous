"use strict";
/**
 * 16-Oct: the Next.js dev server stopped with
 *   lib/tax/document-review-required.ts (18:76) @ values
 *   Error: Cannot convert undefined or null to object
 * because the review screen built its list of required Business Books figures
 * with Object.values() on an imported object, while the module it came from
 * was still being evaluated (a module cycle). The same pattern existed in
 * lib/tax/business-books-figures.ts and in the Business profit step.
 *
 * Fix: lib/tax/business-books-annual-labels.ts holds those names and derives
 * them once. It imports nothing, so no cycle can pass through it and it is
 * always finished before any module that reads it starts.
 *
 * These checks keep it that way. Synthetic data only.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const PURE = "lib/tax/business-books-annual-labels.ts";

test("the labels module imports nothing (a cycle cannot run through it)", () => {
  const source = read(PURE);
  assert.ok(!/^\s*import\s/m.test(source), "no import statement");
  assert.ok(!/require\(/.test(source), "no require call");
  assert.ok(!/from\s+"@?\//m.test(source.replace(/^import[\s\S]*?from\s+"[^"]*";/gm, "")), "no re-export of other modules");
  for (const name of [
    "BUSINESS_BOOKS_ANNUAL_LABELS",
    "BUSINESS_BOOKS_FIGURE_KEYS",
    "BUSINESS_BOOKS_FIGURE_LABELS_AFTER_SALES",
    "emptyBusinessBooksFigures",
  ])
    assert.match(source, new RegExp(`export (const|function) ${name}\\b`), name);
});

test("the modules that read the names at module load take them from the labels module", () => {
  const files = [
    "lib/tax/document-review-required.ts",
    "lib/tax/business-books-figures.ts",
    "lib/tax/business-schedule-fields.ts",
    "components/tax/filing/wizard-business-profit-step.tsx",
  ];
  for (const file of files) {
    const source = read(file);
    assert.match(source, /business-books-annual-labels/, `${file}: imports the labels module`);
    assert.ok(
      !/^\s*(?:export\s+)?const\s+\w+\s*(?::[^=]+)?=\s*Object\.(?:values|keys|fromEntries|entries)\(\s*(?:BUSINESS_BOOKS_|[\s\S]{0,60}?BUSINESS_BOOKS_)/m.test(source),
      `${file}: no module-load Object.* on an imported Books name`,
    );
  }
  const review = read("lib/tax/document-review-required.ts");
  assert.ok(review.includes("...BUSINESS_BOOKS_FIGURE_LABELS_AFTER_SALES.map("), "the 7 figures are required review fields");
});

test("the content is what the callers expect (8 keys, 7 labels after Sales)", () => {
  const Module = require("node:module");
  const ts = require(path.join(root, "node_modules/typescript"));
  const old = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    return old.call(this, request.startsWith("@/") ? path.join(root, request.slice(2)) : request, ...rest);
  };
  require.extensions[".ts"] = (m, file) =>
    m._compile(
      ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
      }).outputText,
      file,
    );
  try {
    const pure = require(path.join(root, PURE));
    assert.deepEqual(pure.BUSINESS_BOOKS_FIGURE_KEYS, [
      "businessGrossSales",
      "businessOtherRevenue",
      "businessCostOfSales",
      "businessOperatingExpenses",
      "businessDepreciation",
      "businessInadmissibleExpenses",
      "businessLossBroughtForward",
      "businessWithholdingDeducted",
    ]);
    assert.equal(pure.BUSINESS_BOOKS_FIGURE_KEYS.length, 8);
    assert.deepEqual(pure.BUSINESS_BOOKS_FIGURE_LABELS_AFTER_SALES, [
      "Other business receipts",
      "Cost of sales",
      "Business expenses",
      "Depreciation",
      "Expenses that are not allowed",
      "Business loss brought forward",
      "Tax already deducted on business receipts",
    ]);
    assert.deepEqual(pure.emptyBusinessBooksFigures(), Object.fromEntries(pure.BUSINESS_BOOKS_FIGURE_KEYS.map((key) => [key, null])));
    // The re-exports the existing callers use still give the same objects.
    const schedule = require(path.join(root, "lib/tax/business-schedule-fields.ts"));
    assert.equal(schedule.BUSINESS_BOOKS_ANNUAL_LABELS, pure.BUSINESS_BOOKS_ANNUAL_LABELS);
    assert.equal(schedule.BUSINESS_BOOKS_FIGURE_KEYS, pure.BUSINESS_BOOKS_FIGURE_KEYS);
    const figures = require(path.join(root, "lib/tax/business-books-figures.ts"));
    assert.equal(figures.BUSINESS_BOOKS_FIGURE_KEYS, pure.BUSINESS_BOOKS_FIGURE_KEYS);
    assert.equal(figures.BUSINESS_BOOKS_FIGURE_KEYS.length, 8);
    // The review screen builds its requirement list at module load: loading it
    // directly is the case that used to throw.
    const review = require(path.join(root, "lib/tax/document-review-required.ts"));
    const fields = pure.BUSINESS_BOOKS_FIGURE_KEYS.map((key) => ({ label: pure.BUSINESS_BOOKS_ANNUAL_LABELS[key], value: 0 }));
    assert.ok(Array.isArray(review.getDocumentReviewRequiredErrors("business_books", fields, 2026)));
  } finally {
    Module._resolveFilename = old;
  }
});
