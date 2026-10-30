"use strict";
/**
 * 16-Oct (user: "document se bhrne wala kam kro"): the 8 yearly figures of
 * the Business profit step come from the mapped Business Books.
 *
 * Checks:
 *   1. lib/tax/business-schedule-fields.ts reads the Books' 8 figures and
 *      business name with the packet's own rules;
 *   2. lib/tax/business-books-figures.ts puts them in place of typed ones
 *      (a blank Books figure removes the typed one; the business name is
 *      filled only when empty);
 *   3. lib/tax/business-books-load.ts takes exactly one MAPPED Books;
 *   4. the server keeps the Books' figures on every save and copies them on
 *      Save & Approve Map; the step shows them read-only;
 *   5. the packet built from copied figures passes the Books check.
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
for (const ext of [".ts", ".tsx"])
  require.extensions[ext] = (m, file) =>
    m._compile(
      ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          jsx: ts.JsxEmit.ReactJSX,
          esModuleInterop: true,
          resolveJsonModule: true,
        },
      }).outputText,
      file,
    );
// The step imports a server action; the static render never calls it.
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@/app/actions/filing")
    return { getBusinessBooksValuesAction: async () => ({ success: true, mapped: false }) };
  return load.call(this, request, ...rest);
};

const schedule = require(path.join(root, "lib/tax/business-schedule-fields.ts"));
const figures = require(path.join(root, "lib/tax/business-books-figures.ts"));
const loader = require(path.join(root, "lib/tax/business-books-load.ts"));
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const fields = (o) => Object.entries(o).map(([label, value]) => ({ label, value, confidence: 1 }));

// Scenario A of the live test (synthetic).
const BOOKS = {
  "Business Name": "SYNTHETIC TRADERS (TEST)",
  "Tax Year": 2026,
  Currency: "PKR",
  "Reporting Period Start": "2025-07-01",
  "Reporting Period End": "2026-06-30",
  "Sales for the year": 12000000,
  "Other business receipts": 250000,
  "Cost of sales": 8050000,
  "Business expenses": "2,120,000",
  Depreciation: 300000,
  "Expenses that are not allowed": 100000,
  "Business loss brought forward": 200000,
  "Tax already deducted on business receipts": 125000,
};
const A_FIGURES = {
  businessGrossSales: 12000000,
  businessOtherRevenue: 250000,
  businessCostOfSales: 8050000,
  businessOperatingExpenses: 2120000,
  businessDepreciation: 300000,
  businessInadmissibleExpenses: 100000,
  businessLossBroughtForward: 200000,
  businessWithholdingDeducted: 125000,
};
const booksData = (o = BOOKS) => JSON.stringify({ fields: fields(o) });

// ---------------------------------------------------------------------------
// 1. Reading the Books
// ---------------------------------------------------------------------------
test("read: the 8 figures and the business name, as the packet reads them", () => {
  const got = schedule.readBusinessBooksAnnual(booksData());
  assert.deepEqual(got.figures, A_FIGURES);
  assert.equal(got.businessName, "SYNTHETIC TRADERS (TEST)");
  assert.deepEqual(Object.keys(schedule.BUSINESS_BOOKS_ANNUAL_LABELS), Object.keys(A_FIGURES));
});

test("read: a blank figure is null; a duplicate or negative figure is refused", () => {
  const blank = schedule.readBusinessBooksAnnual(booksData({ ...BOOKS, Depreciation: "" }));
  assert.equal(blank.figures.businessDepreciation, null);
  assert.equal(schedule.readBusinessBooksAnnual(booksData({ ...BOOKS, Depreciation: 0 })).figures.businessDepreciation, 0);
  const dup = JSON.stringify({ fields: [...fields(BOOKS), { label: "cost of sales", value: 1 }] });
  assert.throws(() => schedule.readBusinessBooksAnnual(dup), /Duplicate business source field: Cost of sales/);
  assert.throws(() => schedule.readBusinessBooksAnnual(booksData({ ...BOOKS, "Cost of sales": -1 })), /non-negative/);
  assert.throws(() => schedule.readBusinessBooksAnnual("null"), /no reviewed fields/);
});

test("read: the packet check uses the same 8 labels", () => {
  const source = read("lib/tax/business-schedule-fields.ts");
  assert.ok(source.includes("const annual = BUSINESS_BOOKS_ANNUAL_LABELS;"));
  assert.ok(source.includes("Business Books and saved Business Profit disagree for ${label}"));
});

// ---------------------------------------------------------------------------
// 2. Putting them in place of the typed figures
// ---------------------------------------------------------------------------
const values = (o = BOOKS) => schedule.readBusinessBooksAnnual(booksData(o));

test("apply: the Books replace typed figures; other answers stay; a blank Books figure removes the typed one", () => {
  const typed = {
    businessGrossSales: 6000000,
    businessDepreciation: 150000,
    businessTurnover100mEarlierYear: false,
    businessAddBacks: [{ code: "3212", amount: 60000 }],
  };
  const next = figures.withBusinessBooksValues(typed, values({ ...BOOKS, Depreciation: null }));
  assert.equal(next.businessGrossSales, 12000000);
  assert.equal("businessDepreciation" in next, false, "blank in the Books = no figure");
  assert.equal(next.businessTurnover100mEarlierYear, false);
  assert.deepEqual(next.businessAddBacks, [{ code: "3212", amount: 60000 }]);
  assert.equal(typed.businessGrossSales, 6000000, "input not changed");
});

test("apply: Business details are never written; the Books name is only offered when IRIS takes its length", () => {
  const next = figures.withBusinessBooksValues({}, values());
  assert.equal(next.businessIdentity, undefined, "no half-filled Business details");
  const kept = figures.withBusinessBooksValues({ businessIdentity: { businessName: "", brandName: "" } }, values());
  assert.deepEqual(kept.businessIdentity, { businessName: "", brandName: "" });
  assert.equal(figures.businessBooksNameForIris(values()), "SYNTHETIC TRADERS (TEST)");
  assert.equal(figures.businessBooksNameForIris(values({ ...BOOKS, "Business Name": "X".repeat(500) })), "");
  assert.equal(figures.businessBooksNameForIris(null), "");
  const step = read("components/tax/filing/wizard-business-profit-step.tsx");
  assert.ok(step.includes("businessName: identity?.businessName || booksName,"), "starting Business details takes the Books name");
  assert.ok(step.includes("placeholder={booksName || undefined}"));
});

test("apply: only the Business Profit selection changes and none is added", () => {
  const salary = { source: "salary", subcategory: "employee", details: { amount: 5 } };
  const profit = { source: "business", subcategory: "profit-return", details: { businessGrossSales: 1 } };
  const next = figures.applyBusinessBooksValues([salary, profit], values());
  assert.equal(next[0], salary);
  assert.equal(next[1].details.businessGrossSales, 12000000);
  assert.equal(figures.applyBusinessBooksValues([salary], values()).length, 1);
});

test("apply: businessDetailsMatchBooks compares the 8 figures (blank = absent)", () => {
  assert.equal(figures.businessDetailsMatchBooks(A_FIGURES, values()), true);
  assert.equal(figures.businessDetailsMatchBooks({ ...A_FIGURES, businessCostOfSales: 1 }, values()), false);
  const noDep = { ...A_FIGURES };
  delete noDep.businessDepreciation;
  assert.equal(figures.businessDetailsMatchBooks(noDep, values({ ...BOOKS, Depreciation: null })), true);
  assert.equal(figures.businessDetailsMatchBooks(A_FIGURES, values({ ...BOOKS, Depreciation: null })), false);
});

// ---------------------------------------------------------------------------
// 3. The database read
// ---------------------------------------------------------------------------
const fakeDb = (docs) => ({
  document: {
    findMany: async (args) => {
      assert.deepEqual(args.where, {
        filingDraftId: "d1",
        userId: "u1",
        documentType: "business_books",
        extractionStatus: "MAPPED",
      });
      return docs;
    },
  },
});

test("load: exactly one MAPPED Books gives its figures; none, two or unreadable gives null", async () => {
  const one = await loader.loadMappedBusinessBooksValues(fakeDb([{ extractedData: booksData(), extractionStatus: "MAPPED" }]), "d1", "u1");
  assert.deepEqual(one.figures, A_FIGURES);
  assert.equal(await loader.loadMappedBusinessBooksValues(fakeDb([]), "d1", "u1"), null);
  const two = [{ extractedData: booksData(), extractionStatus: "MAPPED" }, { extractedData: booksData(), extractionStatus: "MAPPED" }];
  assert.equal(await loader.loadMappedBusinessBooksValues(fakeDb(two), "d1", "u1"), null);
  assert.equal(await loader.loadMappedBusinessBooksValues(fakeDb([{ extractedData: "{}", extractionStatus: "MAPPED" }]), "d1", "u1"), null);
});

// ---------------------------------------------------------------------------
// 4. Server and step wiring
// ---------------------------------------------------------------------------
test("server: every save keeps the Books' figures, before the change check; the step can read them", () => {
  const filing = read("app/actions/filing.ts");
  const replace = filing.slice(filing.indexOf("async function replaceIncomeSelections("), filing.indexOf("function getRequestedDraftId("));
  assert.match(replace, /const books = await loadMappedBusinessBooksValues\(\s*tx,\s*input\.draftId,\s*input\.userId,\s*\);/);
  assert.match(replace, /data: selections\.map\(\(selection\) => \(\{/);
  const update = filing.slice(filing.indexOf("export async function updateFilingDraftAction("));
  const apply = update.indexOf("resolvedSelections = applyBusinessBooksValues(resolvedSelections, books);");
  assert.ok(apply > 0, "the update path applies the Books");
  assert.ok(apply < update.indexOf("const previousSelectionKeys = selectionKeys(previousSelections);"), "before the comparison");
  assert.ok(filing.includes("export async function getBusinessBooksValuesAction(draftId: string)"));
});

test("server: Save & Approve Map on the Books copies the figures and resets the estimate when one changed", () => {
  const extraction = read("app/actions/extraction.ts");
  const branch = extraction.slice(extraction.indexOf('if (document.documentType === "business_books") {\n      const draft'));
  for (const piece of [
    "booksValues = readBusinessBooksAnnual(document.extractedData);",
    "const next = withBusinessBooksValues(saved, booksValues);",
    'taxCalculationStatus: "NOT_CALCULATED",',
    'source: "RECONCILIATION_AUTO_ADJUSTMENT",',
    "businessFiguresChanged,",
  ])
    assert.ok(branch.includes(piece), piece);
});

test("step: the 8 figures are read-only from the Books; no typed figure input is left", () => {
  const step = read("components/tax/filing/wizard-business-profit-step.tsx");
  for (const piece of [
    "Yearly figures from your Business Books",
    "BUSINESS_BOOKS_TEXT.fromBooks : BUSINESS_BOOKS_TEXT.waitingForBooks",
    "const view = withBusinessBooksValues(details, books ?? NO_BOOKS);",
    "const profit = computeBusinessProfit(view);",
    "getBusinessBooksValuesAction(draftId)",
  ])
    assert.ok(step.includes(piece), piece);
  for (const gone of ["function setFigure(", "onChange={(event) => setFigure(", "Enter your sales for the year to see"])
    assert.ok(!step.includes(gone), gone);
  assert.ok(/^[\x00-\x7F]*$/.test(step), "ASCII only");
  const wizard = read("components/tax/filing/filing-wizard.tsx");
  assert.ok(wizard.includes("draftId={draftId ?? resumeDraftId ?? null}"));
});

test("step: rendered before the Books are mapped, it says where the figures come from and asks the Section 113 question", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { JSDOM } = require("jsdom");
  const { WizardBusinessProfitStep } = require(path.join(root, "components/tax/filing/wizard-business-profit-step.tsx"));
  const html = renderToStaticMarkup(
    React.createElement(WizardBusinessProfitStep, {
      selections: [],
      onToggle: () => {},
      onDetailsChange: () => {},
      draftId: "synthetic-draft",
    }),
  );
  const doc = new JSDOM(html).window.document;
  const text = doc.body.textContent;
  assert.ok(text.includes(figures.BUSINESS_BOOKS_TEXT.waitingForBooks));
  assert.ok(text.includes(figures.BUSINESS_BOOKS_TEXT.estimateAfterBooks));
  assert.ok(text.includes("comes from your Business Books."), "turnover not known yet");
  assert.equal(doc.querySelectorAll('input[name="business-turnover-100m-earlier-year"]').length, 2, "Section 113 Yes/No shown");
  assert.ok(text.includes("To continue, finish these:"), "the open answer is listed before any figure exists");
  assert.ok(!text.includes("Sales for the year (PKR)"), "no typed Sales box");
});

// ---------------------------------------------------------------------------
// 5. The packet accepts the copied figures
// ---------------------------------------------------------------------------
test("packet: details copied from the Books pass the Books check", () => {
  const business = require(path.join(root, "lib/tax/business-filing.ts"));
  const copied = figures.withBusinessBooksValues({ businessSalesExcludeIndirectTax: true, businessTurnover100mEarlierYear: false }, values());
  const packet = business.buildBusinessPacket({
    taxYear: 2026,
    filerType: "myself",
    incomeSources: ["business"],
    selections: [{ source: "business", subcategory: "profit-return", detailsJson: JSON.stringify({ userDetails: copied }) }],
    books: [{ id: "synthetic-books", extractedData: booksData(), extractionStatus: "MAPPED" }],
  });
  assert.ok(Array.isArray(packet.fields) && packet.fields.length > 0, "the packet is built");
  const typedOld = figures.withBusinessBooksValues({ businessSalesExcludeIndirectTax: true }, values());
  typedOld.businessCostOfSales = 1;
  assert.throws(
    () =>
      business.buildBusinessPacket({
        taxYear: 2026,
        filerType: "myself",
        incomeSources: ["business"],
        selections: [{ source: "business", subcategory: "profit-return", detailsJson: JSON.stringify({ userDetails: typedOld }) }],
        books: [{ id: "synthetic-books", extractedData: booksData(), extractionStatus: "MAPPED" }],
      }),
    /Business Books and saved Business Profit disagree for Cost of sales/,
    "the safety net still stops a figure that differs",
  );
});
