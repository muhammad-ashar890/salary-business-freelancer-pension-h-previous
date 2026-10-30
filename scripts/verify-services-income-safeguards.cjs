const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const originalResolveFilename = Module._resolveFilename;
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

const { validateFilingCompleteness } = require(
  path.join(root, "lib", "tax", "filing-completeness.ts"),
);
const {
  BANK_TRANSACTION_EXCLUDED_EVENT_TYPE,
  buildBankExclusionEventData,
  latestBankExclusionReasons,
} = require(path.join(root, "lib", "tax", "bank-exclusion-review.ts"));
const { classifyTransaction } = require(
  path.join(root, "lib", "tax", "bank-classification-rules.ts"),
);
const {
  applySafeBankAiSuggestion,
  isFreelancerIncomeSelected,
  isSingleFreelancerServicesFiling,
} = require(path.join(root, "lib", "tax", "business-bank-categories.ts"));

function bankTransaction({
  id = "synthetic-credit",
  description,
  classificationStatus = "REJECTED",
  suggestedEntryType = null,
  suggestedCategory = null,
  credit = 100000,
}) {
  return {
    id,
    bankAccountId: "synthetic-account",
    bankStatementId: "synthetic-statement",
    transactionDate: new Date("2026-03-05T00:00:00Z"),
    description,
    debit: 0,
    credit,
    classificationStatus,
    suggestedEntryType,
    suggestedCategory,
    giftDonorId: null,
  };
}

async function validate({ transactions, events = [], draftOverrides = {} }) {
  const draft = {
    id: "synthetic-draft",
    userId: "synthetic-user",
    taxYear: 2026,
    incomeSources: '["services"]',
    filerType: "myself",
    ...draftOverrides,
  };
  const database = {
    filingDraft: { findFirst: async () => draft },
    bankAccount: { findMany: async () => [] },
    document: { findMany: async () => [] },
    bankStatement: { findMany: async () => [] },
    bankTransaction: { findMany: async () => transactions },
    taxAuditEvent: { findMany: async () => events },
  };
  return validateFilingCompleteness(
    { draftId: draft.id, userId: draft.userId },
    database,
  );
}

test("legacy excluded positive credits that resemble Services receipts block progression", async () => {
  const row = bankTransaction({ description: "UPWORK PAYMENT" });
  const result = await validate({ transactions: [row] });
  assert.equal(result.success, false);
  assert.ok(result.blockers.some((message) => /clearly matches Freelancer services income/.test(message)));
});

test("a clearly worded service receipt approved under another category is caught", async () => {
  const row = bankTransaction({
    description: "FREELANCE EXPORT PAYOUT - CLIENT A",
    classificationStatus: "APPROVED",
    suggestedEntryType: "INCOME",
    suggestedCategory: "OTHER_INCOME",
  });
  const result = await validate({ transactions: [row] });
  assert.ok(result.blockers.some((message) => /approved under another category/.test(message)));
});

test("a positive credit exclusion with no audit reason blocks a Freelancer filing", async () => {
  const row = bankTransaction({ description: "PAYMENT FROM PLATFORM XYZ" });
  const result = await validate({ transactions: [row] });
  assert.ok(result.blockers.some((message) => /excluded without a saved review reason/.test(message)));
});

test("an explicitly reasoned ambiguous credit remains visible without false Services classification", async () => {
  const row = bankTransaction({ description: "PAYMENT FROM PLATFORM XYZ" });
  const reason = "Reviewed as a duplicate payment";
  const events = [
    {
      eventDataJson: buildBankExclusionEventData(row.id, reason),
    },
  ];
  const result = await validate({ transactions: [row], events });
  assert.equal(
    result.blockers.some((message) => /excluded without a saved review reason/.test(message)),
    false,
  );
  assert.equal(
    result.blockers.some((message) => /clearly matches Freelancer services income/.test(message)),
    false,
  );
});

test("the latest audit reason is associated with the excluded transaction", () => {
  const events = [
    {
      eventDataJson: buildBankExclusionEventData("tx-1", "Latest reviewed reason"),
    },
    {
      eventDataJson: buildBankExclusionEventData("tx-1", "Older reason"),
    },
    { eventDataJson: "malformed historical event" },
  ];
  const reasons = latestBankExclusionReasons(events);
  assert.equal(reasons.get("tx-1"), "Latest reviewed reason");
  assert.equal(BANK_TRANSACTION_EXCLUDED_EVENT_TYPE, "BANK_TRANSACTION_EXCLUDED");
});

test("summary clears an allocation whose receipt amount changed by even one paisa", () => {
  const summary = fs.readFileSync(
    path.join(root, "app/actions/filing-summary.ts"),
    "utf8",
  );
  assert.match(summary, /grossAmount:\s*true/);
  assert.match(summary, /moneyEquals\(savedAllocation\.grossAmount, entry\.amount\)/);
});

test("the merged Services route is exact single-source TY2026 Myself only", async () => {
  assert.equal(isFreelancerIncomeSelected({ incomeSources: '["services"]' }), true);
  assert.equal(
    isFreelancerIncomeSelected({ incomeSources: '["salary","services"]' }),
    false,
  );
  assert.equal(
    isSingleFreelancerServicesFiling({
      taxYear: 2026,
      filerType: "myself",
      incomeSources: '["services"]',
    }),
    true,
  );
  assert.equal(
    isSingleFreelancerServicesFiling({
      taxYear: 2026,
      filerType: "myself",
      incomeSources: '["salary","services"]',
    }),
    false,
  );

  const row = bankTransaction({ description: "PAYMENT FROM PLATFORM XYZ" });
  const combined = await validate({
    transactions: [row],
    draftOverrides: { incomeSources: '["salary","services"]' },
  });
  assert.equal(
    combined.blockers.some((message) =>
      /excluded without a saved review reason/.test(message),
    ),
    false,
  );
});

test("deterministic bank rules scope Services and never treat refunds as income", () => {
  const receipt = {
    id: "receipt-1",
    bankAccountId: "account-1",
    transactionDate: new Date("2026-03-05T00:00:00Z"),
    description: "UPWORK PAYMENT FOR CLIENT WORK",
    debit: 0,
    credit: 100000,
  };
  assert.deepEqual(classifyTransaction(receipt, [], { freelancerEnabled: true }), {
    status: "SUGGESTED",
    entryType: "INCOME",
    category: "SERVICES",
    confidence: 0.9,
  });
  assert.notEqual(
    classifyTransaction(receipt, [], { freelancerEnabled: false }).category,
    "SERVICES",
  );

  const fee = classifyTransaction(
    { ...receipt, description: "UPWORK FEE", debit: 2500, credit: 0 },
    [],
    { freelancerEnabled: true },
  );
  assert.equal(fee.entryType, "EXPENSE");
  assert.equal(fee.category, "OTHER_EXPENSE");

  const refund = classifyTransaction(
    { ...receipt, description: "PAYMENT REVERSAL FROM CLIENT" },
    [],
    { freelancerEnabled: true },
  );
  assert.equal(refund.status, "UNREVIEWED");
  assert.equal(refund.entryType, null);
  assert.equal(refund.category, null);
});

test("invoice extraction creates evidence rows only through the exact single-Services map", () => {
  const extraction = fs.readFileSync(
    path.join(root, "app/actions/extraction.ts"),
    "utf8",
  );
  const documents = fs.readFileSync(
    path.join(root, "app/actions/documents.ts"),
    "utf8",
  );
  assert.match(extraction, /documentType === "invoice_summary"/);
  assert.match(extraction, /isSingleFreelancerServicesFiling\(draft\)/);
  assert.match(extraction, /parseServicesInvoiceSummaryFields\(fields\)/);
  assert.match(extraction, /servicesInvoiceEvidence\.createMany/);
  assert.match(extraction, /transactions: \[\]/);
  assert.match(documents, /documentType === "invoice_summary"/);
  assert.match(documents, /servicesInvoiceEvidence\.deleteMany/);
});

test("AI may propose SERVICES only on the exact Freelancer route", () => {
  const suggestion = {
    classification: "income",
    category: "SERVICES",
    confidence: 0.9,
  };
  const amounts = { debit: 0, credit: 50000, description: "Client payment" };
  assert.equal(
    applySafeBankAiSuggestion(suggestion, amounts, false, false).category,
    null,
  );
  assert.equal(
    applySafeBankAiSuggestion(suggestion, amounts, false, true).category,
    "SERVICES",
  );
});

process.once("exit", () => {
  Module._resolveFilename = originalResolveFilename;
});
