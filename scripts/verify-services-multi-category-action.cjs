const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;
let activeMock = null;

Module._resolveFilename = function resolveWithAlias(request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolveFilename.call(this, request, ...rest);
};

Module._extensions[".ts"] = function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

// Exercise the real TY2026 calculation action and the pure evidence evaluator
// without a database connection. All amounts and dates are synthetic.
Module._load = function loadWithActionMocks(request, parent, isMain) {
  if (request === "@/lib/prisma") {
    if (!activeMock) throw new Error("No active Prisma test fixture");
    return { prisma: activeMock.prisma };
  }
  if (request === "@/lib/auth") return { authOptions: {} };
  if (request === "next-auth/next") {
    return {
      getServerSession: async () => ({ user: { email: "synthetic@example.test" } }),
    };
  }
  if (request === "@/lib/tax/reconciliation-calculation") {
    return { validateAuthoritativeReconciliation: async () => ({ success: true }) };
  }
  if (request === "@/app/actions/notifications") {
    return { createNotification: async () => undefined };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const actionPath = path.join(root, "app", "actions", "tax-calculation.ts");
const tyDate = new Date("2026-03-15T00:00:00.000Z");

function selection(source, subcategory) {
  return { source, subcategory, detailsJson: "{}" };
}

function ledgerReceipt(id, amount, category = "SERVICES") {
  return {
    id,
    entryType: "INCOME",
    category,
    amount,
    entryDate: tyDate,
    description: `Synthetic Services receipt ${id}`,
  };
}

function invoiceForReceipt(entry, subcategory, options = {}) {
  const id = `invoice-${entry.id}`;
  const amount = Number(entry.amount);
  return {
    id,
    invoiceNumber: `INV-${entry.id}`,
    invoiceDate: new Date("2026-02-01T00:00:00.000Z"),
    dueDate: new Date("2026-02-10T00:00:00.000Z"),
    clientName: "Synthetic Client",
    serviceDescription: `Synthetic ${subcategory} service`,
    invoiceAmount: amount,
    currency: "PKR",
    exchangeRateToPkr: null,
    fxEvidenceReference: null,
    subcategory,
    paymentStatus: "FULL_TY",
    evidenceStatus: "CONFIRMED",
    sourceDocument: { extractionStatus: "MAPPED" },
    paymentMatches: [
      {
        id: `match-${entry.id}`,
        invoiceEvidenceId: id,
        ledgerEntryId: entry.id,
        settlementDate: entry.entryDate,
        settlementCurrency: "PKR",
        settlementAmount: amount,
        settlementExchangeRateToPkr: 1,
        invoiceCurrencyAmount: amount,
        exchangeRateToPkr: 1,
        grossServiceAmountPkr: amount,
        netBankAmountPkr: amount,
        withholdingTaxPkr: 0,
        platformFeePkr: 0,
        bankFeePkr: 0,
        payoutReference: `PAYOUT-${entry.id}`,
        evidenceReference: "Synthetic payout/bank evidence",
        recordStatus: "CONFIRMED",
        ...options.matchOverrides,
      },
    ],
    ...options.invoiceOverrides,
  };
}

async function runCalculation({
  sources = ["services"],
  selections = [],
  ledger = [],
  invoices = [],
  accountingMethod = "CASH",
  filerType = "myself",
}) {
  const writes = [];
  const draft = {
    id: "synthetic-draft",
    userId: "synthetic-user",
    taxYear: 2026,
    filerType,
    incomeSources: JSON.stringify(sources),
    servicesAccountingMethod: accountingMethod,
    salaryPercentage: 0,
    taxWithheld: 0,
    incomeSelections: selections,
  };
  const record = (model, method) => async (arg) => {
    writes.push({ model, method, arg });
    return { count: 1 };
  };
  const tx = {
    filingDraft: { update: record("filingDraft", "update") },
    filingTaxCalculationLine: {
      deleteMany: record("filingTaxCalculationLine", "deleteMany"),
      createMany: record("filingTaxCalculationLine", "createMany"),
    },
    filingPacket: { updateMany: record("filingPacket", "updateMany") },
    fbrConnection: { updateMany: record("fbrConnection", "updateMany") },
  };
  const prisma = {
    user: {
      findUnique: async () => ({ id: draft.userId, dateOfBirth: null }),
    },
    filingDraft: { findFirst: async () => draft },
    ledgerEntry: { findMany: async () => ledger },
    servicesInvoiceEvidence: { findMany: async () => invoices },
    document: { findFirst: async () => null },
    $transaction: async (callback) => callback(tx),
  };

  activeMock = { prisma };
  delete require.cache[actionPath];
  try {
    const action = require(actionPath);
    const output = await action.calculateTaxAction(draft.id, "LATE_FILER");
    return { output, writes };
  } finally {
    activeMock = null;
    delete require.cache[actionPath];
  }
}

const serviceLedger = [
  ledgerReceipt("receipt-it", 400_000),
  ledgerReceipt("receipt-advertising", 600_000),
];
const twoServiceSelections = [
  selection("services", "1b-service-it-ites"),
  selection("services", "1b-service-advertising-media"),
];
const verifiedInvoices = [
  invoiceForReceipt(serviceLedger[0], "1b-service-it-ites"),
  invoiceForReceipt(serviceLedger[1], "1b-service-advertising-media"),
];

test("multi-category Services bases derive from confirmed invoice/payout evidence", async () => {
  const { output, writes } = await runCalculation({
    selections: twoServiceSelections,
    ledger: serviceLedger,
    invoices: verifiedInvoices,
  });

  assert.equal(output.success, true, JSON.stringify(output));
  assert.equal(output.filerStatus, "LATE_FILER");
  assert.equal(output.result.status, "ESTIMATE");
  assert.equal(output.result.taxableIncome, 1_000_000);
  assert.equal(output.result.taxDue, 25_000);
  assert.equal(output.result.taxPayable, 25_000);
  assert.deepEqual(
    output.result.breakdown
      .map((line) => ({ income: line.income, taxDue: line.taxDue, rule: line.appliedRuleIds[0] }))
      .sort((left, right) => left.rule.localeCompare(right.rule)),
    [
      { income: 600_000, taxDue: 9_000, rule: "TY2026-153-1B-SERVICE-ADVERTISING-MEDIA" },
      { income: 400_000, taxDue: 16_000, rule: "TY2026-153-1B-SERVICE-IT-ITES" },
    ],
  );

  const lineWrite = writes.find((write) => write.model === "filingTaxCalculationLine" && write.method === "createMany");
  assert.ok(lineWrite, "The priced categories should be saved to the audit trail");
  assert.deepEqual(
    lineWrite.arg.data
      .map((line) => ({ subcategory: line.subcategory, taxBase: line.taxBase }))
      .sort((left, right) => left.subcategory.localeCompare(right.subcategory)),
    [
      { subcategory: "1b-service-advertising-media", taxBase: 600_000 },
      { subcategory: "1b-service-it-ites", taxBase: 400_000 },
    ],
  );
});

test("an unmatched Services bank credit stops calculation rather than being omitted", async () => {
  const { output, writes } = await runCalculation({
    selections: twoServiceSelections,
    ledger: serviceLedger,
    invoices: [invoiceForReceipt(serviceLedger[0], "1b-service-it-ites")],
  });
  assert.equal(output.success, true, JSON.stringify(output));
  assert.equal(output.result.status, "NEEDS_RULES");
  assert.equal(output.result.taxableIncome, null);
  assert.match(output.result.note, /allocated exactly once/);
  assert.equal(output.result.breakdown.length, 0);
  assert.equal(writes.some((write) => write.model === "filingTaxCalculationLine" && write.method === "createMany"), false);
});

test("selected Services categories need no invented receipt when evidence yields zero for a category", async () => {
  const oneIncome = invoiceForReceipt(serviceLedger[0], "1b-service-it-ites");
  const { output } = await runCalculation({
    selections: twoServiceSelections,
    ledger: [serviceLedger[0]],
    invoices: [oneIncome],
  });
  assert.equal(output.success, true, JSON.stringify(output));
  assert.equal(output.result.status, "ESTIMATE");
  assert.equal(output.result.taxableIncome, 400_000);
  assert.equal(output.result.breakdown.length, 1);
});

test("a one-paisa bank-credit mismatch blocks the entire Services estimate", async () => {
  const { output } = await runCalculation({
    selections: twoServiceSelections,
    ledger: serviceLedger,
    invoices: [
      verifiedInvoices[0],
      invoiceForReceipt(serviceLedger[1], "1b-service-advertising-media", {
        matchOverrides: { netBankAmountPkr: 599_999.99 },
      }),
    ],
  });
  assert.equal(output.success, true, JSON.stringify(output));
  assert.equal(output.result.status, "NEEDS_RULES");
  assert.match(output.result.note, /bank credit 600000 PKR; allocated 599999\.99 PKR/);
});

test("duplicate invoice-to-ledger links cannot double-count a bank credit", async () => {
  const duplicatedInvoice = invoiceForReceipt(serviceLedger[0], "1b-service-it-ites");
  duplicatedInvoice.paymentMatches.push({
    ...duplicatedInvoice.paymentMatches[0],
    id: "duplicate-match",
  });
  const { output } = await runCalculation({
    selections: twoServiceSelections,
    ledger: serviceLedger,
    invoices: [duplicatedInvoice, verifiedInvoices[1]],
  });
  assert.equal(output.success, true, JSON.stringify(output));
  assert.equal(output.result.status, "NEEDS_RULES");
  assert.match(output.result.note, /duplicate link to the same bank credit/);
});

test("a stale payout link is rejected when its bank credit leaves the Services ledger", async () => {
  const { output } = await runCalculation({
    selections: twoServiceSelections,
    ledger: [serviceLedger[0]],
    invoices: verifiedInvoices,
  });
  assert.equal(output.success, true, JSON.stringify(output));
  assert.equal(output.result.status, "NEEDS_RULES");
  assert.match(output.result.note, /does not point to a Services bank-ledger credit/);
});

test("all seven TY2026 Services categories price when each has confirmed evidence", async () => {
  const categories = [
    "1b-service-certain",
    "1b-service-it-ites",
    "1b-service-advertising-media",
    "1b-service-other",
    "2-services-to-exporter",
    "export-it-ites-pseb",
    "export-services-other",
  ];
  const ledger = categories.map((subcategory, index) =>
    ledgerReceipt(`receipt-${index + 1}`, (index + 1) * 10_000),
  );
  const selections = categories.map((subcategory) => selection("services", subcategory));
  const invoices = ledger.map((entry, index) => invoiceForReceipt(entry, categories[index]));
  const { output } = await runCalculation({ selections, ledger, invoices });
  assert.equal(output.success, true, JSON.stringify(output));
  assert.equal(output.result.status, "ESTIMATE");
  assert.equal(output.result.breakdown.length, categories.length);
  assert.equal(output.result.breakdown.reduce((total, line) => total + line.income, 0), 280_000);
  assert.ok(output.result.breakdown.every((line) => line.appliedRuleIds.length > 0));
});

test("one Services category uses the verified basis rather than raw ledger fallback", async () => {
  const ledger = [ledgerReceipt("single-a", 300_000), ledgerReceipt("single-b", 200_000)];
  const invoices = [
    invoiceForReceipt(ledger[0], "1b-service-it-ites"),
    invoiceForReceipt(ledger[1], "1b-service-it-ites"),
  ];
  const { output } = await runCalculation({
    selections: [selection("services", "1b-service-it-ites")],
    ledger,
    invoices,
  });
  assert.equal(output.success, true, JSON.stringify(output));
  assert.equal(output.result.status, "ESTIMATE");
  assert.equal(output.result.taxableIncome, 500_000);
  assert.equal(output.result.taxDue, 20_000);
  assert.equal(output.result.breakdown.length, 1);
});

test("a Services invoice from a document that is no longer mapped blocks calculation", async () => {
  const { output } = await runCalculation({
    selections: [selection("services", "1b-service-it-ites")],
    ledger: [serviceLedger[0]],
    invoices: [
      invoiceForReceipt(serviceLedger[0], "1b-service-it-ites", {
        invoiceOverrides: { sourceDocument: { extractionStatus: "COMPLETED" } },
      }),
    ],
  });
  assert.equal(output.success, true, JSON.stringify(output));
  assert.equal(output.result.status, "NEEDS_RULES");
  assert.match(output.result.note, /changed since it was mapped/);
});

test("Services ledger entries are not silently dropped when Freelancer is not selected", async () => {
  const { output } = await runCalculation({
    sources: ["salary"],
    selections: [],
    ledger: serviceLedger,
  });
  assert.equal(output.success, false);
  assert.match(output.error, /Freelancer to be selected as an income source/);
});

test("the merged evidence route stays closed for combined sources and non-Myself filings", async () => {
  for (const input of [
    { sources: ["services", "salary"], filerType: "myself" },
    { sources: ["services"], filerType: "my_business" },
  ]) {
    const { output, writes } = await runCalculation({
      ...input,
      selections: twoServiceSelections,
      ledger: serviceLedger,
      invoices: verifiedInvoices,
    });
    assert.equal(output.success, true, JSON.stringify(output));
    assert.equal(output.result.status, "NEEDS_RULES");
    assert.match(output.result.note, /only income source is Freelancer \/ Services/);
    assert.equal(output.result.breakdown.length, 0);
    assert.equal(
      writes.some((write) => write.model === "filingTaxCalculationLine" && write.method === "createMany"),
      false,
    );
  }
});

test("only mapped, human-confirmed Services withholding evidence enters tax withheld", async () => {
  const ledger = [ledgerReceipt("withholding-receipt", 1_000)];
  const invoiceWithWithholding = (verified) =>
    invoiceForReceipt(ledger[0], "1b-service-it-ites", {
      invoiceOverrides: { invoiceAmount: 1_050 },
      matchOverrides: {
        invoiceCurrencyAmount: 1_050,
        grossServiceAmountPkr: 1_050,
        netBankAmountPkr: 1_000,
        withholdingTaxPkr: 50,
        withholdingSection: "153(1)(b)",
        withholdingIrisCode: "64060158",
        withholdingEvidenceReference: "Certificate page 1 line 3",
        withholdingEvidenceHumanConfirmed: verified,
        withholdingEvidenceDocumentId: verified ? "tax-doc-1" : null,
        withholdingEvidenceDocument: verified
          ? { documentType: "other_income_proof", extractionStatus: "MAPPED" }
          : null,
      },
    });

  const verified = await runCalculation({
    selections: [selection("services", "1b-service-it-ites")],
    ledger,
    invoices: [invoiceWithWithholding(true)],
  });
  assert.equal(verified.output.success, true, JSON.stringify(verified.output));
  assert.equal(verified.output.result.status, "ESTIMATE");
  assert.equal(verified.output.result.taxableIncome, 1_050);
  assert.equal(verified.output.result.taxWithheld, 50);

  const unverified = await runCalculation({
    selections: [selection("services", "1b-service-it-ites")],
    ledger,
    invoices: [invoiceWithWithholding(false)],
  });
  assert.equal(unverified.output.success, true, JSON.stringify(unverified.output));
  assert.equal(unverified.output.result.status, "ESTIMATE");
  assert.equal(unverified.output.result.taxWithheld, 0);
});

test("non-Services multi-category safeguards remain unchanged", async () => {
  const { output } = await runCalculation({
    sources: ["other_income"],
    selections: [
      selection("other_income", "prize-bond-crossword"),
      selection("other_income", "raffle-lottery-quiz-sales-promotion"),
    ],
    ledger: [
      {
        id: "other-income-1",
        entryDate: tyDate,
        entryType: "INCOME",
        category: "OTHER_INCOME",
        amount: 1_000_000,
        description: "Synthetic other income",
      },
    ],
  });
  assert.equal(output.success, true, JSON.stringify(output));
  assert.equal(output.result.status, "NEEDS_RULES");
  assert.match(output.result.note, /more than one category/);
});
