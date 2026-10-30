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

Module._load = function loadWithActionMocks(request, parent, isMain) {
  if (request === "@/lib/prisma") {
    if (!activeMock) throw new Error("No active Prisma test fixture");
    return { prisma: activeMock.prisma };
  }
  if (request === "@/lib/auth") return { authOptions: {} };
  if (request === "next-auth/next") {
    return { getServerSession: async () => ({ user: { email: "synthetic@example.test" } }) };
  }
  if (request === "@/lib/tax/business-bank-categories") {
    return {
      isSingleFreelancerServicesFiling: (draft) =>
        draft.taxYear === 2026 &&
        draft.filerType === "myself" &&
        JSON.stringify(JSON.parse(draft.incomeSources)) === '["services"]',
    };
  }
  if (request === "@/lib/tax/rules/ty2026/subcategories") {
    return {
      getTy2026SubcategoryOptions: () => [
        { subcategory: "1b-service-it-ites", label: "IT and IT-enabled services" },
      ],
    };
  }
  if (request === "@/lib/tax/services-income-allocation") {
    return {
      SERVICES_LEDGER_ALLOCATION_ORIGIN: "LEDGER_ALLOCATION",
      isServicesLedgerCategory: (category) => String(category).toUpperCase() === "SERVICES",
    };
  }
  if (request === "@/lib/tax/business-filing") {
    return { invalidateBusinessBalancePackets: async () => undefined };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const actionPath = path.join(root, "app", "actions", "services-income-evidence.ts");
const ledgerDate = new Date("2026-04-30T00:00:00.000Z");

function invoiceRecord(overrides = {}) {
  return {
    id: "invoice-1",
    filingDraftId: "draft-1",
    userId: "user-1",
    sourceDocumentId: "document-1",
    invoiceKey: "row-1",
    invoiceNumber: "INV-1",
    invoiceDate: new Date("2026-01-15T00:00:00.000Z"),
    dueDate: null,
    clientName: "Synthetic Client",
    serviceDescription: "Software development",
    invoiceAmount: 100,
    currency: "USD",
    exchangeRateToPkr: null,
    fxEvidenceReference: null,
    subcategory: null,
    paymentStatus: null,
    evidenceStatus: "DRAFT",
    paymentMatches: [],
    ...overrides,
  };
}

function validInput(overrides = {}) {
  return {
    draftId: "draft-1",
    accountingMethod: "CASH",
    invoices: [
      {
        id: "invoice-1",
        subcategory: "1b-service-it-ites",
        dueDate: null,
        exchangeRateToPkr: null,
        fxEvidenceReference: null,
        paymentStatus: "FULL_TY",
      },
    ],
    paymentMatches: [
      {
        invoiceEvidenceId: "invoice-1",
        ledgerEntryId: "ledger-1",
        settlementCurrency: "USD",
        settlementAmount: 90,
        settlementExchangeRateToPkr: 280,
        invoiceCurrencyAmount: 100,
        exchangeRateToPkr: 280,
        grossServiceAmountPkr: 28000,
        netBankAmountPkr: 25000,
        withholdingTaxPkr: 2000,
        platformFeePkr: 800,
        bankFeePkr: 200,
        payoutReference: "PAYOUT-1",
        evidenceReference: "Platform payout report, page 2",
        evidenceDocumentId: null,
      },
    ],
    ...overrides,
  };
}

async function runSave({ input = validInput(), invoice = invoiceRecord(), ledger = { id: "ledger-1", category: "SERVICES", entryType: "INCOME", amount: 25000, entryDate: ledgerDate } } = {}) {
  const writes = [];
  const record = (model, method, result = { count: 1 }) => async (arg) => {
    writes.push({ model, method, arg });
    return result;
  };
  const draft = {
    id: "draft-1",
    userId: "user-1",
    taxYear: 2026,
    filerType: "myself",
    incomeSources: '["services"]',
    incomeSelections: [{ subcategory: "1b-service-it-ites" }],
  };
  const tx = {
    filingDraft: {
      findFirst: async () => draft,
      update: record("filingDraft", "update"),
    },
    servicesInvoiceEvidence: {
      findMany: async () => [invoice],
      updateMany: record("servicesInvoiceEvidence", "updateMany"),
      update: record("servicesInvoiceEvidence", "update"),
    },
    ledgerEntry: { findMany: async () => [ledger] },
    servicesInvoicePaymentMatch: {
      deleteMany: record("servicesInvoicePaymentMatch", "deleteMany"),
      createMany: record("servicesInvoicePaymentMatch", "createMany"),
    },
    filingIncomeRecord: { deleteMany: record("filingIncomeRecord", "deleteMany") },
    filingPacket: { updateMany: record("filingPacket", "updateMany") },
    fbrConnection: { updateMany: record("fbrConnection", "updateMany") },
    document: { findFirst: async () => null },
  };
  const prisma = {
    user: { findUnique: async () => ({ id: "user-1" }) },
    $transaction: async (callback) => callback(tx),
  };
  activeMock = { prisma };
  delete require.cache[actionPath];
  try {
    const action = require(actionPath);
    const output = await action.saveServicesIncomeEvidenceAction(input);
    return { output, writes };
  } finally {
    activeMock = null;
    delete require.cache[actionPath];
  }
}

test("saving reviewed cash-basis evidence reconciles gross, fees, payout and bank credit", async () => {
  const { output, writes } = await runSave();
  assert.equal(output.success, true, JSON.stringify(output));
  assert.equal(output.accountingMethod, "CASH");
  assert.equal(output.incomeTotal, 28000);
  assert.equal(output.payoutMatchCount, 1);
  const createdMatches = writes.find((write) => write.model === "servicesInvoicePaymentMatch" && write.method === "createMany");
  assert.equal(createdMatches.arg.data[0].grossServiceAmountPkr, 28000);
  assert.equal(createdMatches.arg.data[0].netBankAmountPkr, 25000);
  assert.equal(createdMatches.arg.data[0].withholdingTaxPkr, 2000);
  const draftUpdate = writes.find((write) => write.model === "filingDraft" && write.method === "update");
  assert.equal(draftUpdate.arg.data.servicesAccountingMethod, "CASH");
});

test("missing a Services bank-credit match blocks saving before any evidence writes", async () => {
  const { output, writes } = await runSave({ input: validInput({ paymentMatches: [] }) });
  assert.equal(output.success, false);
  assert.match(output.error, /allocated exactly once/);
  assert.equal(writes.some((write) => write.model === "servicesInvoicePaymentMatch" && write.method === "createMany"), false);
  assert.equal(writes.some((write) => write.model === "filingDraft" && write.method === "update"), false);
});

test("a mismatched gross/withholding/fee equation blocks evidence confirmation", async () => {
  const input = validInput();
  input.paymentMatches[0].platformFeePkr = 700;
  const { output, writes } = await runSave({ input });
  assert.equal(output.success, false);
  assert.match(output.error, /Gross service amount.*must equal net bank credit/);
  assert.equal(writes.some((write) => write.model === "servicesInvoicePaymentMatch" && write.method === "createMany"), false);
});

test("accrual basis requires due date and invoice-date FX evidence", async () => {
  const input = validInput({
    accountingMethod: "ACCRUAL",
    invoices: [{
      id: "invoice-1",
      subcategory: "1b-service-it-ites",
      dueDate: null,
      exchangeRateToPkr: null,
      fxEvidenceReference: null,
      paymentStatus: null,
    }],
    paymentMatches: [],
  });
  const { output } = await runSave({ input, ledger: { id: "ledger-1", category: "OTHER_INCOME", entryType: "INCOME", amount: 25000, entryDate: ledgerDate } });
  assert.equal(output.success, false);
  assert.match(output.error, /income-due date/);
  assert.match(output.error, /invoice-date PKR exchange rate/);
});
