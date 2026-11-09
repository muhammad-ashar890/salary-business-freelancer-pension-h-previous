"use strict";
/**
 * Phase 6 (Bug #5): Review step transparency for queued IRIS Business > Tax
 * Deduction rows (`adjustable` + `minimum`) and un-itemized Business WHT on
 * `Business` and `Salary + Business` filings, WITHOUT modifying
 * `calculateTaxAction` math.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithAlias(request, parent, isMain, options) {
  if (request.startsWith("@/")) {
    const base = path.join(root, request.slice(2));
    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      path.join(base, "index.ts"),
      path.join(base, "index.tsx"),
    ]) {
      if (fs.existsSync(candidate)) {
        return originalResolveFilename.call(this, candidate, parent, isMain, options);
      }
    }
    request = base;
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

for (const ext of [".ts", ".tsx"]) {
  require.extensions[ext] = (mod, filename) => {
    // Stub Next server-action modules if imported transitively by client panels.
    if (filename.includes(`${path.sep}app${path.sep}actions${path.sep}`)) {
      mod.exports = new Proxy(
        {},
        {
          get: () => async () => ({ success: false, error: "Stubbed in SSR unit test" }),
        },
      );
      return;
    }
    const source = fs.readFileSync(filename, "utf8");
    mod._compile(
      ts.transpileModule(source, {
        fileName: filename,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          jsx: ts.JsxEmit.ReactJSX,
          esModuleInterop: true,
          resolveJsonModule: true,
        },
      }).outputText,
      filename,
    );
  };
}

const {
  summarizeBusinessWithholding,
} = require("../lib/tax/business-withholding-summary.ts");
const {
  BUSINESS_BOOKS_ANNUAL_LABELS,
} = require("../lib/tax/business-books-annual-labels.ts");
const {
  WizardReviewStep,
} = require("../components/tax/filing/wizard-review-step.tsx");

function makeMappedBooksExtractedData(overrides = {}) {
  const defaults = {
    businessGrossSales: 8_000_000,
    businessOtherRevenue: 0,
    businessCostOfSales: 3_500_000,
    businessOperatingExpenses: 1_200_000,
    businessDepreciation: 0,
    businessInadmissibleExpenses: 0,
    businessLossBroughtForward: 0,
    businessWithholdingDeducted: 250_000,
    ...overrides,
  };
  const fields = [
    { label: "Business Name", value: "Al-Noor Traders" },
    ...Object.entries(BUSINESS_BOOKS_ANNUAL_LABELS).map(([key, label]) => ({
      label,
      value: defaults[key],
    })),
  ];
  return JSON.stringify({ fields });
}

function makeSelectionJson(userDetails) {
  return JSON.stringify({ userDetails });
}

function makeBaseSummary(overrides = {}) {
  return {
    income: 8_000_000,
    expenses: 4_700_000,
    assets: 3_000_000,
    liabilities: 0,
    ledgerEntryCount: 12,
    documentCount: 4,
    pendingDocumentCount: 0,
    documentsAwaitingMapping: [],
    reconciliationStatus: "BALANCED",
    reconciliationGap: 0,
    taxableIncome: 3_300_000,
    taxWithheld: 0,
    taxPayable: 465_000,
    refundDue: 0,
    taxCalculationStatus: "ESTIMATE",
    taxpayerListStatus: "ATL",
    withholdingWarning: null,
    taxBreakdown: [
      {
        source: "business",
        subcategoryLabel: "Business profit / normal return",
        section: "18",
        ruleId: "TY2026_BUSINESS_SLAB",
        income: 3_300_000,
        baseTax: 465_000,
        surcharge: 0,
        taxDue: 465_000,
        isFinalTax: false,
        rateShape: "PROGRESSIVE",
        combinedRoutes: [],
      },
    ],
    finalTaxDue: 0,
    assessableTaxDue: 465_000,
    mixedExcessWithholding: 0,
    collectionBreakdown: [],
    collectionTaxDue: 0,
    businessWithholding: null,
    ...overrides,
  };
}

function renderReviewHtml(summary, overrides = {}) {
  return renderToStaticMarkup(
    React.createElement(WizardReviewStep, {
      uploadedDocumentCount: 4,
      filingSummary: summary,
      filingSummaryError: null,
      taxCalculationError: null,
      taxCalculationNote: null,
      withholdingWarning: null,
      withholdingConfirmed: false,
      onWithholdingConfirmChange: () => {},
      filerStatus: "ATL",
      calculatingTaxFor: null,
      draftId: "draft-phase6-test",
      onCalculateTax: () => {},
      onServicesEvidenceSaved: () => {},
      ...overrides,
    }),
  );
}

test("1. Non-business routes and unsupported scope return null from summarizeBusinessWithholding", () => {
  for (const sources of [
    ["salary"],
    ["pension"],
    ["salary", "pension"],
    ["services"],
    ["salary", "services"],
    ["pension", "services"],
  ]) {
    assert.equal(
      summarizeBusinessWithholding({
        taxYear: 2026,
        filerType: "myself",
        incomeSources: sources,
        selectionDetailsJson: null,
        mappedBooksExtractedDataList: [],
      }),
      null,
    );
  }

  assert.equal(
    summarizeBusinessWithholding({
      taxYear: 2025,
      filerType: "myself",
      incomeSources: ["business"],
      selectionDetailsJson: null,
      mappedBooksExtractedDataList: [],
    }),
    null,
  );
  assert.equal(
    summarizeBusinessWithholding({
      taxYear: 2026,
      filerType: "company",
      incomeSources: ["business"],
      selectionDetailsJson: null,
      mappedBooksExtractedDataList: [],
    }),
    null,
  );
});

test("2. Salary + Business with mapped Books and DP-3 adjustable + minimum sections summarizes queued rows in IRIS order", () => {
  const booksJson = makeMappedBooksExtractedData({
    businessWithholdingDeducted: 250_000,
  });
  // Deliberately pass a stale total (10,000) in selectionJson to prove mapped
  // Business Books remain authoritative via withBusinessBooksValues, and pass
  // minimum before adjustable to prove IRIS portal ordering.
  const selectionJson = makeSelectionJson({
    businessWithholdingDeducted: 10_000,
    businessTaxDeductions: [
      {
        regime: "minimum",
        code: "64010052",
        taxableAmount: 15_000_000,
        taxDeducted: 150_000,
        attributableIncome: 1_800_000,
      },
      {
        regime: "adjustable",
        code: "64060116",
        taxableAmount: 1_250_000,
        taxDeducted: 100_000,
      },
    ],
  });

  const summary = summarizeBusinessWithholding({
    taxYear: 2026,
    filerType: "myself",
    incomeSources: ["salary", "business"],
    selectionDetailsJson: selectionJson,
    mappedBooksExtractedDataList: [booksJson],
  });

  assert.ok(summary);
  assert.equal(summary.booksMapped, true);
  assert.equal(summary.totalDeducted, 250_000);
  assert.equal(summary.queuedAdjustable, 100_000);
  assert.equal(summary.queuedMinimum, 150_000);
  assert.equal(summary.queuedTotal, 250_000);
  assert.equal(summary.manualRemainder, 0);
  assert.deepEqual(summary.problems, []);
  assert.equal(summary.entries.length, 2);
  // Adjustable panel (999913) precedes Minimum panel (999914) in IRIS order.
  assert.equal(summary.entries[0].regime, "adjustable");
  assert.equal(summary.entries[0].code, "64060116");
  assert.equal(summary.entries[0].attributableIncome, null);
  assert.equal(summary.entries[1].regime, "minimum");
  assert.equal(summary.entries[1].code, "64010052");
  assert.equal(summary.entries[1].attributableIncome, 1_800_000);

  // Render Review step for Salary + Business where Salary s.149 WHT = 420,000.
  const html = renderReviewHtml(
    makeBaseSummary({
      taxableIncome: 6_900_000,
      taxWithheld: 420_000,
      taxPayable: 1_095_000,
      refundDue: 0,
      businessWithholding: summary,
    }),
  );

  // Engine KPI values remain untouched while KPI subtitles + review panel explain queued Business WHT.
  assert.match(html, /PKR 420,000/);
  assert.match(
    html,
    /Excludes PKR 250,000 queued for IRIS Business &gt; Tax Deduction \(applied by IRIS per section\)\./,
  );
  assert.match(
    html,
    /Estimate only\. The amount to pay is the one IRIS shows \(before PKR 250,000 queued Business Tax Deduction credits\)\./,
  );
  assert.match(html, /data-testid="business-withholding-review-panel"/);
  assert.match(html, /IRIS 64060116 · Taxable amount PKR 1,250,000/);
  assert.match(
    html,
    /IRIS 64010052 · Taxable amount PKR 15,000,000 · Attributable income PKR 1,800,000/,
  );
  assert.match(
    html,
    /Adjustable tax: PKR 100,000 · Minimum tax: PKR 150,000/,
  );
  assert.doesNotMatch(html, /Not itemized by IRIS section/);
});

test("3. Partial itemization and un-itemized Books WHT surface exact manualRemainder on Review step", () => {
  const partialSummary = summarizeBusinessWithholding({
    taxYear: 2026,
    filerType: "myself",
    incomeSources: ["business"],
    selectionDetailsJson: makeSelectionJson({
      businessTaxDeductions: [
        {
          regime: "minimum",
          code: "64060053",
          taxableAmount: 12_000_000,
          taxDeducted: 180_000,
        },
      ],
    }),
    mappedBooksExtractedDataList: [
      makeMappedBooksExtractedData({ businessWithholdingDeducted: 300_000 }),
    ],
  });

  assert.ok(partialSummary);
  assert.equal(partialSummary.totalDeducted, 300_000);
  assert.equal(partialSummary.queuedTotal, 180_000);
  assert.equal(partialSummary.manualRemainder, 120_000);
  assert.deepEqual(partialSummary.problems, []);

  const partialHtml = renderReviewHtml(
    makeBaseSummary({ businessWithholding: partialSummary }),
  );
  assert.match(
    partialHtml,
    /Excludes PKR 300,000 Business WHT \(PKR 180,000 queued for IRIS; PKR 120,000 un-itemized\)\./,
  );
  assert.match(partialHtml, /Not itemized by IRIS section/);
  assert.match(partialHtml, /PKR 120,000/);

  // Un-itemized Books total (0 sections listed yet)
  const unitemizedSummary = summarizeBusinessWithholding({
    taxYear: 2026,
    filerType: "myself",
    incomeSources: ["business"],
    selectionDetailsJson: makeSelectionJson({}),
    mappedBooksExtractedDataList: [
      makeMappedBooksExtractedData({ businessWithholdingDeducted: 95_000 }),
    ],
  });
  assert.ok(unitemizedSummary);
  assert.equal(unitemizedSummary.queuedTotal, 0);
  assert.equal(unitemizedSummary.manualRemainder, 95_000);
  const unitemizedHtml = renderReviewHtml(
    makeBaseSummary({ businessWithholding: unitemizedSummary }),
  );
  assert.match(
    unitemizedHtml,
    /Excludes PKR 95,000 Business WHT in Books \(itemize by section in Business data review to queue for IRIS\)\./,
  );
});

test("4. Over-listed or incomplete businessTaxDeductions fail closed on Review and surface validation problems", () => {
  const invalidSummary = summarizeBusinessWithholding({
    taxYear: 2026,
    filerType: "myself",
    incomeSources: ["business"],
    selectionDetailsJson: makeSelectionJson({
      businessTaxDeductions: [
        {
          regime: "adjustable",
          code: "64150803",
          taxableAmount: 10_000_000,
          taxDeducted: 200_000,
        },
      ],
    }),
    mappedBooksExtractedDataList: [
      makeMappedBooksExtractedData({ businessWithholdingDeducted: 150_000 }),
    ],
  });

  assert.ok(invalidSummary);
  assert.equal(invalidSummary.queuedTotal, 0);
  assert.equal(invalidSummary.entries.length, 0);
  assert.equal(invalidSummary.manualRemainder, 150_000);
  assert.equal(invalidSummary.problems.length, 1);
  assert.match(invalidSummary.problems[0], /more than "Tax already deducted on business receipts"/);

  const html = renderReviewHtml(
    makeBaseSummary({ businessWithholding: invalidSummary }),
  );
  assert.match(
    html,
    /Excludes Business WHT — resolve the Business Tax Deduction issue below\./,
  );
  assert.match(html, /Fix in Business data review before generating the packet:/);
});

test("5. Zero Business WHT and non-business summaries render zero noise on Review step", () => {
  const zeroSummary = summarizeBusinessWithholding({
    taxYear: 2026,
    filerType: "myself",
    incomeSources: ["business"],
    selectionDetailsJson: makeSelectionJson({}),
    mappedBooksExtractedDataList: [
      makeMappedBooksExtractedData({ businessWithholdingDeducted: 0 }),
    ],
  });
  assert.ok(zeroSummary);
  assert.equal(zeroSummary.totalDeducted, 0);
  assert.equal(zeroSummary.queuedTotal, 0);
  assert.equal(zeroSummary.manualRemainder, 0);

  for (const bw of [zeroSummary, null]) {
    const html = renderReviewHtml(makeBaseSummary({ businessWithholding: bw }));
    assert.doesNotMatch(html, /business-withholding-review-panel/);
    assert.doesNotMatch(html, /Excludes .* Business/);
    assert.match(html, /Estimate only\. The amount to pay is the one IRIS shows\./);
  }
});

test("6. Server summary wiring, wizard step refresh, and untouched calculateTaxAction math", () => {
  const summaryActionSource = fs.readFileSync(
    path.join(root, "app/actions/filing-summary.ts"),
    "utf8",
  );
  const wizardSource = fs.readFileSync(
    path.join(root, "components/tax/filing/filing-wizard.tsx"),
    "utf8",
  );
  const taxCalcActionSource = fs.readFileSync(
    path.join(root, "app/actions/tax-calculation.ts"),
    "utf8",
  );

  assert.match(summaryActionSource, /summarizeBusinessWithholding\(/);
  assert.match(summaryActionSource, /businessWithholding,/);
  assert.match(wizardSource, /currentStepKey === "pipeline_review"/);
  // calculateTaxAction must NOT import or fold businessTaxDeductions / business-withholding-summary into engine math.
  assert.doesNotMatch(taxCalcActionSource, /business-withholding-summary/);
  assert.doesNotMatch(taxCalcActionSource, /businessTaxDeductions/);
});
