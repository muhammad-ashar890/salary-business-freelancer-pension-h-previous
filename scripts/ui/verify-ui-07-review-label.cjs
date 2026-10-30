// UI Test 7 -- Review and packet steps name a single-income combined line after that income.
//
// A combined slab line made of one income type reads "Business profit", not
// "Combined slab". With two or more income types it stays "Combined slab" and
// lists the parts. The filing is seeded straight into the database at the end
// of the pipeline so the test does not depend on uploads.
const h = require("./_harness.cjs");
const EMAIL = "ui-review-label@taxrocket.test";
async function seed(user, routes, sources) {
  const p = h.prisma;
  const income = routes.reduce((t, r) => t + r.income, 0);
  const draft = await p.filingDraft.create({
    data: {
      userId: user.id,
      taxYear: 2026,
      filerType: "myself",
      incomeSources: JSON.stringify(sources),
      residencyStatus: "resident",
      // Myself + Business combined steps: reconciliation (12),
      // pipeline_review (13), approval (14), filing_packet (15).
      currentStep: 13,
      wizardCompletionStep: 13,
      reconciliationStatus: "RESOLVED",
      reconciliationMethod: "NO_ADJUSTMENT_REQUIRED",
      reconciliationGap: 0,
      openingWealth: 800000,
      closingWealth: 3194000,
      taxableIncome: income,
      taxPayable: 150000,
      taxWithheld: 0,
      refundDue: 0,
      taxCalculationStatus: "ESTIMATE",
      taxpayerListStatus: "ATL",
      packetApprovalConfirmed: true,
    },
  });
  for (const s of sources)
    await p.filingIncomeSelection.create({
      data: {
        filingDraftId: draft.id,
        userId: user.id,
        source: s === "business" ? "business" : s,
        subcategory: s === "business" ? "profit-return" : "salary",
        detailsJson:
          s === "business"
            ? JSON.stringify({ businessDocumentFlowVersion: 2, userDetails: {} })
            : "{}",
      },
    });
  const acct = await p.bankAccount.create({
    data: {
      filingDraftId: draft.id,
      userId: user.id,
      bankName: "HBL",
      accountLabel: "Account 1",
      iban: "PK35HABB0018067900476803",
    },
  });
  await p.bankStatement.create({
    data: {
      filingDraftId: draft.id,
      userId: user.id,
      accountLabel: "Account 1",
      bankAccountId: acct.id,
      openingBalance: 800000,
      closingBalance: 3194000,
      periodStart: new Date("2025-07-01"),
      periodEnd: new Date("2026-06-30"),
    },
  });
  const st = await p.bankStatement.findFirst({
    where: { filingDraftId: draft.id },
  });
  const mk = (documentType, extra = {}) =>
    p.document.create({
      data: {
        filingDraftId: draft.id,
        userId: user.id,
        documentType,
        fileName: documentType + ".pdf",
        fileUrl: "/tmp/x.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        extractionStatus: "COMPLETED",
        ...extra,
      },
    });
  const fields = (values) =>
    Object.entries(values).map(([label, value]) => ({ label, value, confidence: 1 }));
  const booksFields = {
    "Business Name": "SYNTHETIC TRADER",
    "Tax Year": 2026,
    Currency: "PKR",
    "Reporting Period Start": "2025-07-01",
    "Reporting Period End": "2026-06-30",
    "Sales for the year": 2394000,
    "Other business receipts": 0,
    "Cost of sales": 0,
    "Business expenses": 0,
    Depreciation: 0,
    "Expenses that are not allowed": 0,
    "Business loss brought forward": 0,
    "Tax already deducted on business receipts": 0,
  };
  const balanceFields = {
    "Business Name": "SYNTHETIC TRADER",
    "Tax Year": 2026,
    "Balance Sheet Date": "2026-06-30",
    Currency: "PKR",
    "Total Assets": 4194000,
    "Total Equity and Liabilities": 4194000,
    "Business Land": 0,
    "Business Building": 0,
    "Plant / Machinery / Equipment / Furniture": 0,
    "Business Motor Vehicles": 0,
    "Advances / Deposits / Prepayments": 250000,
    "Stocks / Stores / Spares": 600000,
    "Business Cash in Hand": 150000,
    "Business Bank Balance": 3194000,
    "Bonds / Securities": 0,
    "Other Business Assets": 0,
    "Owner Capital": 3994000,
    "Long Term Borrowings / Debt / Loan": 0,
    "Trade Creditors / Payables": 200000,
    "Other Business Liabilities": 0,
  };
  await mk("cnic");
  await mk("business_books", {
    extractionStatus: "MAPPED",
    extractedData: JSON.stringify({ fields: fields(booksFields) }),
  });
  await mk("business_balance_sheet", {
    extractionStatus: "MAPPED",
    extractedData: JSON.stringify({ fields: fields(balanceFields) }),
  });
  const bankDoc = await mk("bank_statement", {
    bankAccountId: acct.id,
    extractionStatus: "MAPPED",
  });
  await p.bankStatement.update({
    where: { id: st.id },
    data: { sourceDocumentId: bankDoc.id },
  });
  const tx = await p.bankTransaction.create({
    data: {
      filingDraftId: draft.id,
      userId: user.id,
      bankStatementId: st.id,
      bankAccountId: acct.id,
      transactionDate: new Date("2025-08-01"),
      description: "CUSTOMER RECEIPTS",
      credit: 2394000,
      balance: 3194000,
      source: "STATEMENT",
      classificationStatus: "APPROVED",
      suggestedEntryType: "INCOME",
      suggestedCategory: "OTHER_INCOME",
    },
  });
  await p.ledgerEntry.create({
    data: {
      filingDraftId: draft.id,
      userId: user.id,
      entryType: "INCOME",
      category: "OTHER_INCOME",
      description: "x",
      amount: 2394000,
      source: "BANK_TRANSACTION",
      sourceTransactionId: tx.id,
      bankAccountId: acct.id,
    },
  });
  await p.filingTaxCalculationLine.create({
    data: {
      filingDraftId: draft.id,
      userId: user.id,
      calculationRevision: "r1",
      ruleSetVersion: "x",
      ruleId: "UNKNOWN",
      section: "",
      source: "combined_slab",
      subcategory: "",
      filerStatusUsed: "ATL",
      taxBase: income,
      baseTax: 150000,
      surcharge: 0,
      calculatedTax: 150000,
      detailsJson: JSON.stringify({
        rateShape: "PROGRESSIVE",
        isFinalTax: false,
        appliedRuleIds: [],
        combinedRoutes: routes,
      }),
    },
  });
  return draft;
}
(async () => {
  const user = await h.createTestUser(EMAIL);
  const { browser, page } = await h.openBrowser(user);
  for (const [name, routes, sources] of [
    [
      "one route",
      [{ route: "business_profit", income: 1500000 }],
      ["business"],
    ],
    [
      "two routes",
      [
        { route: "salary", income: 1000000 },
        { route: "business_profit", income: 2000000 },
      ],
      ["business"],
    ],
  ]) {
    const draft = await seed(user, routes, sources);
    await page.goto(`/tax/new?draftId=${draft.id}`, {
      waitUntil: "networkidle",
    });
    await page.waitForTimeout(4000);
    for (let k = 0; k < 5; k++) {
      if (
        ((await page.textContent("body")) || "").includes(
          "Tax by income source",
        )
      )
        break;
      const b = page.locator('button:has-text("Continue")').first();
      if (!(await b.count()) || (await b.isDisabled())) break;
      await b.click();
      await page.waitForTimeout(2500);
    }
    const body = ((await page.textContent("body")) || "").replace(/\s+/g, " ");
    const i = body.indexOf("Tax by income source");
    const section = i >= 0 ? body.slice(i, i + 220) : "";
    h.section(name);
    h.checkTrue("review shows the tax breakdown", i >= 0, section);
    if (routes.length === 1) {
      h.checkTrue(
        "single income type is named after the income",
        /Tax by income source\s*Business profit/.test(section),
      );
      h.checkTrue("no 'Combined slab' wording", !/Combined slab/.test(section));
    } else {
      h.checkTrue(
        "several income types stay 'Combined slab'",
        /Combined slab/.test(section),
      );
      h.checkTrue(
        "the parts are listed",
        /Salary PKR 1,000,000 \+ Business profit PKR 2,000,000/.test(section),
      );
    }
    // The same breakdown appears again on the filing packet step.
    for (let k = 0; k < 4; k++) {
      if (
        ((await page.textContent("body")) || "").includes("Your filing packet")
      )
        break;
      const approve = page.locator('input[type="checkbox"]').first();
      if ((await approve.count()) && !(await approve.isChecked()))
        await approve.check();
      const b = page.locator('button:has-text("Continue")').first();
      if (!(await b.count()) || (await b.isDisabled())) break;
      await b.click();
      await page.waitForTimeout(2500);
    }
    const packetBody = ((await page.textContent("body")) || "").replace(
      /\s+/g,
      " ",
    );
    h.checkTrue(
      "filing packet step is reached",
      packetBody.includes("Your filing packet"),
    );
    const j = packetBody.indexOf("Tax by income source");
    const packetSection = j >= 0 ? packetBody.slice(j, j + 400) : "";
    h.checkTrue("filing packet shows the tax breakdown", j >= 0);
    if (routes.length === 1) {
      h.checkTrue(
        "packet: single income type is named after the income",
        /Business profit/.test(packetSection),
      );
      h.checkTrue(
        "packet: no 'combined slab' wording",
        !/combined slab/i.test(packetSection),
      );
    } else {
      h.checkTrue(
        "packet: several income types stay 'Combined slab'",
        /Combined slab/.test(packetSection),
      );
      h.checkTrue(
        "packet: the parts are listed",
        /Salary PKR 1,000,000 \+ Business profit PKR 2,000,000/.test(
          packetSection,
        ),
      );
    }
  }
  await browser.close();
  await h.deleteTestUser(EMAIL);
  h.finish("Review label");
  await h.prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await h.deleteTestUser(EMAIL).catch(() => {});
  await h.prisma.$disconnect();
  process.exit(1);
});
