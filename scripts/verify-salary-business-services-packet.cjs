"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { harness } = require("./helpers/pension-harness.cjs");

const money = (value) => Math.round(Number(value));
const findRow = (rows, code, column) =>
  rows.find(
    (row) =>
      String(row.irisCode || row.code) === String(code) &&
      (!column || row.column === column),
  );

function businessBalanceFields(labels) {
  const values = {
    businessName: "SYNTHETIC TRADER",
    taxYear: 2026,
    closingDate: "2026-06-30",
    currency: "PKR",
    totalAssets: 1_000_000,
    totalEquityLiabilities: 1_000_000,
    advances: 250_000,
    stock: 600_000,
    cash: 150_000,
    capital: 800_000,
    payables: 200_000,
  };
  return Object.entries(labels).map(([key, label]) => ({
    label,
    value: values[key] ?? 0,
  }));
}

function businessBooksExtracted() {
  return JSON.stringify({
    fields: Object.entries({
      "Business Name": "SYNTHETIC TRADER",
      "Tax Year": 2026,
      Currency: "PKR",
      "Reporting Period Start": "2025-07-01",
      "Reporting Period End": "2026-06-30",
      "Sales for the year": 2_000_000,
      "Other business receipts": 500_000,
      "Other Revenue - Technical and Professional Fees": 500_000,
      "Cost of sales": 0,
      "Business expenses": 0,
      Depreciation: 0,
      "Expenses that are not allowed": 0,
      "Business loss brought forward": 0,
      "Tax already deducted on business receipts": 0,
    }).map(([label, value]) => ({ label, value, confidence: 1 })),
  });
}

test("real actions build a non-duplicated triple packet and a fold-aware computations envelope", async () => {
  const h = harness({
    pension: 0,
    ledgerPension: 0,
    salary: 13_000_000,
    mockCompleteness: true,
  });
  h.state.draft.incomeSources = JSON.stringify([
    "salary",
    "business",
    "services",
  ]);
  h.state.draft.servicesAccountingMethod = "CASH";
  h.state.draft.incomeSelections = h.state.draft.incomeSelections.filter(
    (selection) => selection.source !== "pension",
  );
  h.state.documents = h.state.documents.filter(
    (document) => document.documentType !== "pension_statement",
  );
  h.state.entries = h.state.entries.filter(
    (entry) => entry.category !== "PENSION",
  );

  const { BUSINESS_BALANCE_LABELS } = h.load("lib/tax/business-filing.ts");
  const { readReviewedBusinessFacts } = h.load(
    "lib/tax/business-document-intake.ts",
  );
  h.state.documents.push(
    {
      id: "qa-sbs-business-books",
      filingDraftId: "qa-draft",
      userId: "qa-user",
      documentType: "business_books",
      extractionStatus: "MAPPED",
      extractedData: businessBooksExtracted(),
      createdAt: new Date("2026-10-20T00:00:00Z"),
    },
    {
      id: "qa-sbs-balance-sheet",
      filingDraftId: "qa-draft",
      userId: "qa-user",
      documentType: "business_balance_sheet",
      extractionStatus: "MAPPED",
      extractedData: JSON.stringify({
        fields: businessBalanceFields(BUSINESS_BALANCE_LABELS),
      }),
      createdAt: new Date("2026-10-20T00:00:00Z"),
    },
    {
      id: "qa-sbs-invoice-document",
      filingDraftId: "qa-draft",
      userId: "qa-user",
      documentType: "invoice_summary",
      fileName: "synthetic-services.pdf",
      extractionStatus: "MAPPED",
      extractedData: "{}",
      createdAt: new Date("2026-10-20T00:00:00Z"),
    },
  );

  const businessDetails = readReviewedBusinessFacts(h.state.documents, {
    businessName: "SYNTHETIC TRADER",
    businessIdentity: {
      businessName: "SYNTHETIC TRADER",
      brandName: "SYNTHETIC TRADER",
      principalActivity: "Trading",
      startDate: "2020-07-01",
    },
    businessActivities: ["620200"],
    businessGrossSales: 2_000_000,
    businessOtherRevenue: 500_000,
    businessCostOfSales: 0,
    businessOperatingExpenses: 0,
    businessDepreciation: 0,
    businessInadmissibleExpenses: 0,
    businessLossBroughtForward: 0,
    businessWithholdingDeducted: 0,
    businessSalesExcludeIndirectTax: true,
    businessTurnover100mEarlierYear: false,
    businessBankOwnershipDecisions: [
      {
        bankAccountId: "qa-bank",
        iban: "PK36SCBL0000001123456702",
        ownership: "personal",
        confirmed: true,
      },
    ],
  }).details;
  h.state.draft.incomeSelections.push(
    {
      id: "qa-sbs-business-selection",
      filingDraftId: "qa-draft",
      userId: "qa-user",
      source: "business",
      subcategory: "profit-return",
      status: "SELECTED",
      detailsJson: JSON.stringify({ userDetails: businessDetails }),
    },
    {
      id: "qa-sbs-services-selection",
      filingDraftId: "qa-draft",
      userId: "qa-user",
      source: "services",
      subcategory: "export-it-ites-pseb",
      status: "SELECTED",
      detailsJson: "{}",
    },
  );

  h.state.entries.push({
    id: "qa-sbs-services-bank-credit",
    filingDraftId: "qa-draft",
    userId: "qa-user",
    bankAccountId: "qa-bank",
    entryType: "INCOME",
    category: "SERVICES",
    amount: new Prisma.Decimal(8_000_000),
    description: "Synthetic approved IT export receipt",
    entryDate: new Date("2026-04-30T00:00:00Z"),
    sourceDocumentId: "qa-sbs-invoice-document",
  });
  h.state.servicesInvoices.push({
    id: "qa-sbs-invoice",
    filingDraftId: "qa-draft",
    userId: "qa-user",
    invoiceNumber: "SBS-1",
    invoiceDate: new Date("2026-01-15T00:00:00Z"),
    dueDate: new Date("2026-02-15T00:00:00Z"),
    clientName: "Synthetic Client",
    serviceDescription: "Human-confirmed software development services",
    invoiceAmount: new Prisma.Decimal(8_000_000),
    currency: "PKR",
    exchangeRateToPkr: new Prisma.Decimal(1),
    fxEvidenceReference: "PKR invoice; FX 1",
    subcategory: "export-it-ites-pseb",
    paymentStatus: "FULL_TY",
    evidenceStatus: "CONFIRMED",
    serviceCategoryHumanConfirmed: true,
    serviceCategoryEvidenceReference: "Invoice page 1, service scope",
    incomeCharacter: "TECHNICAL_PROFESSIONAL_FEE",
    incomeCharacterHumanConfirmed: true,
    incomeCharacterEvidenceReference: "Invoice page 1, technical scope",
    sourceDocument: {
      id: "qa-sbs-invoice-document",
      documentType: "invoice_summary",
      fileName: "synthetic-services.pdf",
      extractionStatus: "MAPPED",
    },
    paymentMatches: [
      {
        id: "qa-sbs-payment-match",
        ledgerEntryId: "qa-sbs-services-bank-credit",
        settlementDate: new Date("2026-04-30T00:00:00Z"),
        settlementCurrency: "PKR",
        settlementAmount: new Prisma.Decimal(8_000_000),
        settlementExchangeRateToPkr: new Prisma.Decimal(1),
        invoiceCurrencyAmount: new Prisma.Decimal(8_000_000),
        exchangeRateToPkr: new Prisma.Decimal(1),
        grossServiceAmountPkr: new Prisma.Decimal(8_000_000),
        netBankAmountPkr: new Prisma.Decimal(8_000_000),
        withholdingTaxPkr: new Prisma.Decimal(0),
        platformFeePkr: new Prisma.Decimal(0),
        bankFeePkr: new Prisma.Decimal(0),
        payoutReference: "synthetic-payout-1",
        evidenceReference: "Synthetic payout statement page 1",
        recordStatus: "CONFIRMED",
        ledgerEntry: {
          id: "qa-sbs-services-bank-credit",
          entryDate: new Date("2026-04-30T00:00:00Z"),
          description: "Synthetic approved IT export receipt",
          amount: new Prisma.Decimal(8_000_000),
        },
        evidenceDocument: null,
        withholdingEvidenceDocument: null,
        withholdingSection: "154A",
        withholdingIrisCode: "64060290",
        withholdingEvidenceReference: null,
        withholdingEvidenceHumanConfirmed: false,
        withholdingEvidenceDocumentId: null,
      },
    ],
  });

  const calculated = await h.calculate();
  assert.equal(calculated.success, true, calculated.error);
  const combinedLine = h.state.lines.find(
    (line) => line.source === "combined_slab",
  );
  assert.ok(
    combinedLine,
    `Salary + Business retain their authoritative combined slab line: ${JSON.stringify(calculated.result.breakdown)}`,
  );
  assert.equal(money(combinedLine.taxBase), 15_500_000);

  const generated = await h.generate();
  assert.equal(generated.success, true, generated.error);
  const snapshot = JSON.parse(h.state.packets.at(-1).snapshotJson);
  assert.equal(snapshot.business.version, "business-entry-v9");
  assert.equal(snapshot.services.version, "services-tax-deduction-v1");
  assert.equal(
    findRow(snapshot.portalFieldMap.incomeFields, "1009", "Total Amount").ourAmount,
    13_000_000,
  );
  const folded = findRow(
    snapshot.portalFieldMap.businessFields,
    "3101",
    "Total Amount",
  );
  assert.ok(
    folded,
    `folded 3101 row exists: ${JSON.stringify({ fields: snapshot.portalFieldMap.businessFields, gaps: snapshot.portalFieldMap.mappingGaps })}`,
  );
  assert.equal(folded.ourAmount, 8_500_000);
  assert.equal(folded.fbSharedCell.businessAmount, 500_000);
  assert.equal(folded.fbSharedCell.servicesAmount, 8_000_000);
  assert.equal(
    findRow(
      snapshot.portalFieldMap.businessFields,
      "3101",
      "Subject to Final Tax",
    ).ourAmount,
    8_000_000,
  );

  const plan = snapshot.salaryBusinessServices;
  assert.ok(plan, "triple packet carries an explicit fold-aware plan");
  assert.equal(plan.version, "salary-business-services-v1");
  assert.equal(plan.totalServicesIncome, 8_000_000);
  assert.equal(plan.normalServicesIncome, 0);
  assert.equal(plan.finalServicesIncome, 8_000_000);
  assert.equal(plan.expectedTaxableIncome, money(combinedLine.taxBase));
  assert.equal(plan.expectedNormalTax, money(combinedLine.baseTax));
  assert.equal(plan.expectedTotalIncome, 23_500_000);
  assert.equal(plan.computations.expectedBusinessIncome, 10_500_000);
  assert.equal(plan.computations.expectedTaxableIncome, money(combinedLine.taxBase));
  assert.equal(plan.computations.expectedNormalTax, money(combinedLine.baseTax));
  assert.equal(plan.computations.surcharge.value, money(combinedLine.surcharge));
  const computationsDriver = require("../electron-connect/iris-computations-driver.js");
  assert.deepEqual(computationsDriver.validatePlan(plan.computations), []);

  const { buildSalaryBusinessServicesPlan } = h.load(
    "lib/tax/salary-business-services-plan.ts",
  );
  const normalServicesFields = snapshot.services.fields.filter(
    (field) => field.column !== "Subject to Final Tax",
  );
  const normalPlan = buildSalaryBusinessServicesPlan({
    taxYear: 2026,
    filerType: "myself",
    incomeSources: ["salary", "business", "services"],
    businessExpectedIrisTotals: snapshot.business.expectedIrisTotals,
    servicesFields: normalServicesFields,
    hasUnmappedPortalIncome: false,
  });
  assert.equal(normalPlan.normalServicesIncome, 8_000_000);
  assert.equal(normalPlan.finalServicesIncome, 0);
  assert.equal(normalPlan.expectedTaxableIncome, 23_500_000);
  assert.equal(normalPlan.expectedNormalTax, null);
  assert.equal(normalPlan.computations.expectedNormalTax, null);
  assert.equal(normalPlan.computations.surcharge.action, "USER");
  assert.equal(normalPlan.computations.surcharge.value, 0);
  assert.equal(normalPlan.computations.superTax.action, "USER");
  assert.equal(
    normalPlan.expectedIrisTotals.rows.some((row) => row.code === "920000"),
    false,
    "an unproven Normal Tax expectation is not carried into readback",
  );
  assert.deepEqual(computationsDriver.validatePlan(normalPlan.computations), []);

  const gapPlan = buildSalaryBusinessServicesPlan({
    taxYear: 2026,
    filerType: "myself",
    incomeSources: ["salary", "business", "services"],
    businessExpectedIrisTotals: snapshot.business.expectedIrisTotals,
    servicesFields: snapshot.services.fields,
    hasUnmappedPortalIncome: true,
  });
  assert.equal(gapPlan.expectedTaxableIncome, null);
  assert.equal(gapPlan.expectedTotalIncome, null);
  assert.equal(gapPlan.computations.surcharge.action, "USER");
  assert.equal(gapPlan.computations.surcharge.value, 0);
});
