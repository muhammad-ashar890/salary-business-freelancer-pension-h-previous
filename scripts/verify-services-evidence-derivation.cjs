const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const root = path.join(__dirname, "..");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  module._compile(
    ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    filename,
  );
};
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithAlias(request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolveFilename.call(this, request, ...rest);
};
const derivation = require(path.join(root, "lib/tax/services-evidence-derivation.ts"));
const evidence = require(path.join(root, "lib/tax/services-income-evidence.ts"));
Module._resolveFilename = originalResolveFilename;

const panel = fs.readFileSync(
  path.join(root, "components/tax/filing/wizard-services-income-evidence-panel.tsx"),
  "utf8",
);

const extraction = fs.readFileSync(path.join(root, "app/actions/extraction.ts"), "utf8");
const summary = fs.readFileSync(path.join(root, "app/actions/filing-summary.ts"), "utf8");

function invoice(overrides = {}) {
  return {
    id: "inv-1",
    invoiceNumber: "INV-1",
    invoiceDate: "2025-09-01",
    clientName: "Acme (Pvt) Ltd",
    serviceDescription: "Software development services for the mobile application",
    invoiceAmount: 50000,
    currency: "PKR",
    exchangeRateToPkr: 1,
    subcategory: null,
    sourceDocumentFileName: "invoices-aug.pdf",
    derivedPayout: null,
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    id: "led-1",
    date: "2025-09-05",
    description: "SERVICES PAYMENT ACME INV-1",
    amount: 50000,
    ...overrides,
  };
}

test("an invoice is settled by the bank credit with the same net amount, and the review is derived from the document", () => {
  const result = derivation.deriveServicesEvidence({
    selectedSubcategories: ["1b-service-it-ites"],
    invoices: [invoice()],
    receipts: [receipt()],
  });
  assert.equal(result.matches.length, 1);
  const match = result.matches[0];
  assert.equal(match.ledgerEntryId, "led-1");
  assert.equal(match.netBankAmountPkr, 50000);
  assert.equal(match.grossServiceAmountPkr, 50000);
  assert.equal(match.withholdingTaxPkr, 0);
  assert.equal(match.settlementDate, "2025-09-05");
  assert.equal(match.settlementCurrency, "PKR");
  const review = result.invoiceReviews[0];
  assert.equal(review.subcategory, "1b-service-it-ites");
  assert.equal(review.serviceCategoryHumanConfirmed, true);
  assert.match(review.serviceCategoryEvidenceReference, /invoices-aug\.pdf/);
  assert.equal(review.incomeCharacter, "TECHNICAL_PROFESSIONAL_FEE");
  assert.equal(review.incomeCharacterHumanConfirmed, true);
  assert.equal(review.paymentStatus, "FULL_TY");
  assert.equal(result.coverage.matchedCredits, 1);
  assert.equal(result.coverage.allocatedPkr, 50000);
  assert.equal(result.ok, true);
});

test("the payout block printed on the invoice supplies gross, withholding and fees instead of asking for them", () => {
  const result = derivation.deriveServicesEvidence({
    selectedSubcategories: ["1b-service-certain"],
    invoices: [
      invoice({
        invoiceAmount: 60000,
        serviceDescription: "Professional consultancy services",
        derivedPayout: {
          settlementDate: "2025-09-05",
          settlementCurrency: "PKR",
          settlementAmount: 55100,
          settlementExchangeRateToPkr: 1,
          grossServiceAmountPkr: 60000,
          withholdingTaxPkr: 4000,
          withholdingSection: "153(1)(b)",
          withholdingIrisCode: "64060158",
          withholdingEvidenceReference: "withholding-1.pdf page 1",
          platformFeePkr: 500,
          bankFeePkr: 400,
          netPayoutPkr: 55100,
          payoutReference: "PO-99881",
          evidenceReference: "payout-report.pdf page 2",
          incomeCharacter: "Technical / professional fee",
        },
      }),
    ],
    receipts: [receipt({ amount: 55100, description: "RAAST CREDIT PO-99881" })],
  });
  assert.equal(result.matches.length, 1);
  const match = result.matches[0];
  assert.equal(match.grossServiceAmountPkr, 60000);
  assert.equal(match.netBankAmountPkr, 55100);
  assert.equal(match.withholdingTaxPkr, 4000);
  assert.equal(match.withholdingSection, "153(1)(b)");
  assert.equal(match.withholdingIrisCode, "64060158");
  assert.equal(match.platformFeePkr, 500);
  assert.equal(match.bankFeePkr, 400);
  assert.equal(match.payoutReference, "PO-99881");
  assert.equal(match.evidenceReference, "payout-report.pdf page 2");
  assert.equal(result.invoiceReviews[0].incomeCharacter, "TECHNICAL_PROFESSIONAL_FEE");
});

test("a payout reference printed on the invoice beats an equal-amount credit", () => {
  const result = derivation.deriveServicesEvidence({
    selectedSubcategories: ["1b-service-it-ites"],
    invoices: [
      invoice({
        invoiceDate: "2025-09-01",
        derivedPayout: {
          settlementDate: null,
          settlementCurrency: null,
          settlementAmount: null,
          settlementExchangeRateToPkr: null,
          grossServiceAmountPkr: null,
          withholdingTaxPkr: null,
          withholdingSection: null,
          withholdingIrisCode: null,
          withholdingEvidenceReference: null,
          platformFeePkr: null,
          bankFeePkr: null,
          netPayoutPkr: null,
          payoutReference: "PO-778",
          evidenceReference: null,
          incomeCharacter: null,
        },
      }),
    ],
    receipts: [
      receipt({ id: "led-a", amount: 50000, description: "SERVICES CREDIT A" }),
      receipt({ id: "led-b", amount: 50000, description: "RAAST PO-778 SETTLEMENT" }),
    ],
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].ledgerEntryId, "led-b");
  assert.equal(result.matches[0].confidence, "document_reference");
  assert.equal(result.coverage.unmatchedCreditIds.length, 1);
});

test("one payout covering two invoices is split exactly, not guessed", () => {
  const result = derivation.deriveServicesEvidence({
    selectedSubcategories: ["1b-service-it-ites"],
    invoices: [
      invoice({ id: "inv-1", invoiceNumber: "INV-1", invoiceAmount: 30000 }),
      invoice({
        id: "inv-2",
        invoiceNumber: "INV-2",
        invoiceDate: "2025-09-02",
        invoiceAmount: 20000,
      }),
    ],
    receipts: [receipt({ amount: 50000, description: "SERVICES PAYMENT COMBINED" })],
  });
  assert.equal(result.matches.length, 2);
  assert.deepEqual(
    result.matches.map((match) => match.netBankAmountPkr).sort((a, b) => a - b),
    [20000, 30000],
  );
  assert.ok(result.matches.every((match) => match.confidence !== undefined));
  assert.equal(result.coverage.allocatedPkr, 50000);
});

test("an unmatched bank credit is reported, never quietly allocated", () => {
  const result = derivation.deriveServicesEvidence({
    selectedSubcategories: ["1b-service-it-ites"],
    invoices: [invoice()],
    receipts: [receipt(), receipt({ id: "led-2", amount: 12500, description: "OTHER CREDIT" })],
  });
  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.coverage.unmatchedCreditIds, ["led-2"]);
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "credit_without_invoice" && issue.ledgerEntryId === "led-2",
    ),
  );
});

test("a credit is never used twice, even when two invoices carry the same amount", () => {
  const result = derivation.deriveServicesEvidence({
    selectedSubcategories: ["1b-service-it-ites"],
    invoices: [
      invoice({ id: "inv-1", invoiceNumber: "INV-1" }),
      invoice({ id: "inv-2", invoiceNumber: "INV-2", invoiceDate: "2025-09-03" }),
    ],
    receipts: [receipt({ id: "led-1", amount: 50000 })],
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].ledgerEntryId, "led-1");
  assert.equal(result.coverage.matchedCredits, 1);
});

test("an invoice with no bank credit is dated in the tax year, so cash basis records no receipt", () => {
  const result = derivation.deriveServicesEvidence({
    selectedSubcategories: ["1b-service-it-ites"],
    invoices: [invoice({ invoiceDate: "2025-10-01", invoiceAmount: 70000 })],
    receipts: [],
  });
  const review = result.invoiceReviews[0];
  assert.equal(review.paymentStatus, "NO_RECEIPT_TY");
  assert.ok(result.assumptions.some((note) => /no receipt this year/.test(note)));
  assert.equal(result.ok, false, "the step still reports that nothing was matched");
  assert.ok(result.issues.some((issue) => issue.code === "invoice_without_credit"));
});

test("a foreign-currency invoice without a printed FX rate is never converted at 1", () => {
  const result = derivation.deriveServicesEvidence({
    selectedSubcategories: ["1b-service-it-ites"],
    invoices: [
      invoice({ invoiceAmount: 500, currency: "USD", exchangeRateToPkr: null }),
    ],
    receipts: [receipt({ amount: 500 })],
  });
  assert.equal(result.matches.length, 0);
  assert.ok(
    result.issues.some((issue) => /exchange rate/.test(issue.message)),
    "the missing FX rate is reported",
  );
});

test("the category comes from the document text when several categories are selected", () => {
  const result = derivation.deriveServicesEvidence({
    selectedSubcategories: ["1b-service-it-ites", "1b-service-advertising-media"],
    invoices: [invoice({ serviceDescription: "Social media marketing campaign and content" })],
    receipts: [receipt()],
  });
  assert.equal(result.invoiceReviews[0].subcategory, "1b-service-advertising-media");
});

test("a category the documents do not prove is reported instead of invented", () => {
  const result = derivation.deriveServicesEvidence({
    selectedSubcategories: ["1b-service-it-ites", "1b-service-advertising-media"],
    invoices: [invoice({ serviceDescription: "Monthly retainer" })],
    receipts: [receipt()],
  });
  assert.equal(result.invoiceReviews[0].subcategory, "");
  assert.equal(result.invoiceReviews[0].serviceCategoryHumanConfirmed, false);
  assert.ok(result.issues.some((issue) => issue.code === "subcategory_unresolved"));
  assert.equal(result.ok, false);
});

test("a non-professional service stays out of IRIS row 3101 and says so", () => {
  const result = derivation.deriveServicesEvidence({
    selectedSubcategories: ["1b-service-other"],
    invoices: [invoice({ serviceDescription: "Supply of office furniture and fittings" })],
    receipts: [receipt()],
  });
  assert.equal(result.invoiceReviews[0].incomeCharacter, "UNCLASSIFIED");
  assert.equal(result.invoiceReviews[0].incomeCharacterHumanConfirmed, false);
  assert.ok(result.issues.some((issue) => issue.code === "income_character_unresolved"));
  // Income-character limits do not block a payout confirmation; the invoice
  // simply stays outside the automatic IRIS income row.
  assert.equal(result.matches.length, 1);
});

test("a part payment is recorded as PARTIAL_TY from the documents alone", () => {
  const result = derivation.deriveServicesEvidence({
    selectedSubcategories: ["1b-service-it-ites"],
    invoices: [invoice({ invoiceAmount: 50000 })],
    receipts: [receipt({ amount: 20000, date: "2025-09-20" })],
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].netBankAmountPkr, 20000);
  assert.equal(result.invoiceReviews[0].paymentStatus, "PARTIAL_TY");
});

test("the live Review case: seven credits and seven invoices resolve with no typing", () => {
  const credits = [12500, 39500, 48750, 18400, 27300, 32100, 66000];
  const result = derivation.deriveServicesEvidence({
    taxYear: 2026,
    selectedSubcategories: ["1b-service-it-ites"],
    invoices: credits.map((amount, index) =>
      invoice({
        id: `inv-${index + 1}`,
        invoiceNumber: `INV-2026-${index + 1}`,
        invoiceDate: `2025-${String(7 + (index % 6)).padStart(2, "0")}-${String(3 + index).padStart(2, "0")}`,
        invoiceAmount: amount,
        serviceDescription: "Software development and technical services",
      }),
    ),
    receipts: credits.map((amount, index) =>
      receipt({
        id: `led-${index + 1}`,
        date: `2025-${String(7 + (index % 6)).padStart(2, "0")}-${String(6 + index).padStart(2, "0")}`,
        description: `SERVICES CREDIT ${index + 1}`,
        amount,
      }),
    ),
  });
  assert.equal(result.matches.length, 7);
  assert.equal(result.coverage.matchedCredits, 7);
  assert.equal(result.coverage.allocatedPkr, 244550);
  assert.equal(result.coverage.ledgerPkr, 244550);
  assert.deepEqual(result.coverage.unmatchedCreditIds, []);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(
    result.invoiceReviews.every(
      (review) =>
        review.subcategory === "1b-service-it-ites" &&
        review.serviceCategoryHumanConfirmed &&
        review.incomeCharacter === "TECHNICAL_PROFESSIONAL_FEE" &&
        review.incomeCharacterHumanConfirmed &&
        review.paymentStatus === "FULL_TY",
    ),
  );
});

test("the invoice parser keeps the payout labels extraction already asks for", () => {
  const rows = evidence.parseServicesInvoiceSummaryFields([
    { label: "Invoice Number", value: "INV-9" },
    { label: "Invoice Date", value: "2025-09-01" },
    { label: "Client", value: "Acme" },
    { label: "Service Description", value: "Software development" },
    { label: "Invoice Amount", value: "60000" },
    { label: "Invoice Currency", value: "PKR" },
    { label: "Net Payout (PKR)", value: "55100" },
    { label: "Gross Service Amount (PKR)", value: "60000" },
    { label: "Withholding Tax (PKR)", value: "4000" },
    { label: "Withholding Section", value: "153(1)(b)" },
    { label: "Withholding IRIS Code", value: "64060158" },
    { label: "Platform Fee (PKR)", value: "500" },
    { label: "Receiving Bank Fee (PKR)", value: "400" },
    { label: "Payout Reference", value: "PO-99881" },
    { label: "Settlement Date", value: "2025-09-05" },
    { label: "Payout Evidence Reference", value: "payout-report.pdf page 2" },
  ]);
  assert.equal(rows.length, 1);
  const payout = rows[0].payout;
  assert.equal(payout.netPayoutPkr, 55100);
  assert.equal(payout.grossServiceAmountPkr, 60000);
  assert.equal(payout.withholdingTaxPkr, 4000);
  assert.equal(payout.withholdingSection, "153(1)(b)");
  assert.equal(payout.withholdingIrisCode, "64060158");
  assert.equal(payout.platformFeePkr, 500);
  assert.equal(payout.bankFeePkr, 400);
  assert.equal(payout.payoutReference, "PO-99881");
  assert.equal(payout.settlementDate, "2025-09-05");
  assert.equal(payout.evidenceReference, "payout-report.pdf page 2");
});

test("payout facts survive the round trip through detailsJson", () => {
  const details = JSON.stringify({
    extractedInvoiceKey: "row-1",
    derivedPayout: { netPayoutPkr: 55100, payoutReference: "PO-99881" },
  });
  const parsed = evidence.parseServicesDerivedPayout(details);
  assert.equal(parsed.netPayoutPkr, 55100);
  assert.equal(parsed.payoutReference, "PO-99881");
  assert.equal(evidence.parseServicesDerivedPayout("{}"), null);
  assert.equal(evidence.parseServicesDerivedPayout(null), null);
  assert.equal(
    evidence.parseServicesDerivedPayout(
      JSON.stringify({ derivedPayout: { netPayoutPkr: null } }),
    ),
    null,
  );
});

test("the documents are the only source: extraction persists, the summary exposes, the panel auto-fills", () => {
  assert.match(extraction, /derivedPayout: row\.payout/);
  assert.match(extraction, /Withholding Section/);
  assert.match(extraction, /Income Character/);
  assert.match(summary, /derivedPayout: parseServicesDerivedPayout\(invoice\.detailsJson\)/);
  assert.match(summary, /sourceDocumentId: entry\.sourceDocumentId \?\? null/);
  assert.match(panel, /deriveServicesEvidence\(/);
  assert.match(panel, /autoDerivedRef/);
  assert.match(panel, /Fill from documents/);
  assert.match(panel, /Filled from your documents/);
  // The derivation must run from data already on the screen: a server action
  // round trip is what made an earlier build fail silently and show blank rows.
  assert.equal(/deriveServicesIncomeEvidenceAction/.test(panel), false);
  assert.match(panel, /useMemo\(\(\) => \{[\s\S]*deriveServicesEvidence\(/);
});

test("derivation is pure: the engine imports no database, session or server action", () => {
  const engine = fs.readFileSync(
    path.join(root, "lib/tax/services-evidence-derivation.ts"),
    "utf8",
  );
  assert.equal(/prisma|next-auth|"use server"|@\/app\/actions/.test(engine), false);
  assert.equal(/\.create\(|\.createMany\(|\.update\(|\.updateMany\(|\.delete\(|\.deleteMany\(/.test(engine), false);
});

// ── Receiving-bank fee (live QA regression, 2026-10-17) ─────────────────────
// The QA pack's INV-2026-006 credit is 32,100 after a 60 receiving-bank fee.
// The derivation used to copy the credit straight into `settlementAmount`, so
// the evidence validator — which requires
// `settlement = net bank credit + receiving-bank fee` — rejected a perfectly
// reconciling document with
// "The evidenced payout amount … does not reconcile to the bank credit".
test("a receiving-bank fee: the derived settlement is the pre-fee payout and the whole pack validates", () => {
  const payout = {
    settlementDate: "2025-09-05",
    settlementCurrency: "PKR",
    settlementAmount: 55100,
    settlementExchangeRateToPkr: 1,
    grossServiceAmountPkr: 60000,
    withholdingTaxPkr: 4000,
    withholdingSection: "153(1)(b)",
    withholdingIrisCode: "64060158",
    withholdingEvidenceReference: "withholding-1.pdf page 1",
    platformFeePkr: 500,
    bankFeePkr: 400,
    netPayoutPkr: 55100,
    payoutReference: "PO-99881",
    evidenceReference: "payout-report.pdf page 2",
    incomeCharacter: "Technical / professional fee",
  };
  const derived = derivation.deriveServicesEvidence({
    selectedSubcategories: ["1b-service-certain"],
    invoices: [
      invoice({
        invoiceAmount: 60000,
        serviceDescription: "Professional consultancy services",
        derivedPayout: payout,
      }),
    ],
    receipts: [receipt({ amount: 55100, description: "RAAST CREDIT PO-99881" })],
  });
  assert.equal(derived.matches.length, 1);
  const match = derived.matches[0];
  assert.equal(match.netBankAmountPkr, 55100);
  assert.equal(match.bankFeePkr, 400);
  assert.equal(
    match.settlementAmount,
    55500,
    "settlement must be the payout before the receiving bank took its fee",
  );

  const ledger = {
    id: "led-1",
    entryDate: "2025-09-05",
    amount: 55100,
    description: "RAAST CREDIT PO-99881",
  };
  const invoiceRow = {
    id: "inv-1",
    invoiceNumber: "INV-1",
    invoiceDate: new Date("2025-09-01T00:00:00.000Z"),
    dueDate: null,
    clientName: "Acme (Pvt) Ltd",
    serviceDescription: "Professional consultancy services",
    invoiceAmount: 60000,
    currency: "PKR",
    exchangeRateToPkr: null,
    fxEvidenceReference: null,
    subcategory: "1b-service-certain",
    paymentStatus: "FULL_TY",
    evidenceStatus: "CONFIRMED",
  };
  const validate = (settlementAmount) =>
    evidence.evaluateServicesIncomeEvidence({
      selectedSubcategories: ["1b-service-certain"],
      taxYear: 2026,
      accountingMethod: "CASH",
      invoices: [
        {
          ...invoiceRow,
          paymentMatches: [
            { ...match, id: "match-1", settlementAmount, recordStatus: "CONFIRMED" },
          ],
        },
      ],
      ledgerCredits: [ledger],
    });

  const ok = validate(match.settlementAmount);
  assert.equal(ok.ok, true, ok.ok ? undefined : ok.errors.join(" "));
  assert.equal(ok.incomeByInvoice["inv-1"], 60000);

  // The old behaviour (settlement = the credit) is still refused, so the guard
  // itself is not weakened by this fix.
  const refused = validate(55100);
  assert.equal(refused.ok, false);
  assert.match(
    refused.errors.join(" "),
    /does not reconcile to the bank credit and receiving-bank fee/,
  );
});
