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

const {
  evaluateServicesIncomeEvidence,
  parseServicesInvoiceSummaryFields,
} = require(path.join(root, "lib", "tax", "services-income-evidence.ts"));

const subcategory = "1b-service-it-ites";
const tyDate = (value) => new Date(`${value}T00:00:00.000Z`);

function payout(overrides = {}) {
  return {
    id: "match-1",
    invoiceEvidenceId: "invoice-1",
    ledgerEntryId: "bank-1",
    settlementDate: tyDate("2026-04-30"),
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
    payoutReference: "payout-123",
    evidenceReference: "platform statement, page 2",
    recordStatus: "CONFIRMED",
    ...overrides,
  };
}

function invoice(overrides = {}) {
  return {
    id: "invoice-1",
    invoiceNumber: "INV-1",
    invoiceDate: tyDate("2026-01-15"),
    dueDate: tyDate("2026-02-15"),
    clientName: "Synthetic Client",
    serviceDescription: "Software development",
    invoiceAmount: 100,
    currency: "USD",
    exchangeRateToPkr: null,
    fxEvidenceReference: null,
    subcategory,
    paymentStatus: "FULL_TY",
    evidenceStatus: "CONFIRMED",
    paymentMatches: [payout()],
    ...overrides,
  };
}

function ledger(amount = 25000, overrides = {}) {
  return {
    id: "bank-1",
    amount,
    entryDate: tyDate("2026-04-30"),
    ...overrides,
  };
}

function evaluate(overrides = {}) {
  return evaluateServicesIncomeEvidence({
    taxYear: 2026,
    accountingMethod: "CASH",
    selectedSubcategories: [subcategory],
    invoices: [invoice()],
    ledgerCredits: [ledger()],
    ...overrides,
  });
}

test("cash basis uses verified gross income, not net bank credit plus invoice", () => {
  const result = evaluate();
  assert.equal(result.ok, true);
  assert.equal(result.incomeTotal, 28000);
  assert.equal(result.incomeBySubcategory[subcategory], 28000);
  assert.deepEqual(result.incomeByInvoice, { "invoice-1": 28000 });
  assert.equal(
    Object.values(result.incomeByInvoice).reduce((sum, amount) => sum + amount, 0),
    result.incomeTotal,
  );
  assert.notEqual(result.incomeTotal, 25000 + 100 * 280);
});

test("accrual basis uses invoice amount due in the tax year and does not add a bank receipt", () => {
  const result = evaluate({
    accountingMethod: "ACCRUAL",
    invoices: [
      invoice({
        exchangeRateToPkr: 280,
        fxEvidenceReference: "invoice-date FX evidence, page 1",
        paymentMatches: [payout()],
      }),
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.incomeTotal, 28000);
  assert.deepEqual(result.incomeByInvoice, { "invoice-1": 28000 });
  assert.equal(
    Object.values(result.incomeByInvoice).reduce((sum, amount) => sum + amount, 0),
    result.incomeTotal,
  );
});

test("invoice-level recognized gross preserves cents and sums to the subcategory and total", () => {
  const makeInvoice = (id, amount, gross, bankId) => invoice({
    id,
    invoiceNumber: id,
    invoiceAmount: amount,
    currency: "USD",
    paymentStatus: "FULL_TY",
    paymentMatches: [payout({
      id: `match-${id}`,
      invoiceEvidenceId: id,
      ledgerEntryId: bankId,
      settlementCurrency: "PKR",
      settlementAmount: gross,
      settlementExchangeRateToPkr: 1,
      invoiceCurrencyAmount: amount,
      exchangeRateToPkr: 280.005,
      grossServiceAmountPkr: gross,
      netBankAmountPkr: gross,
      withholdingTaxPkr: 0,
      platformFeePkr: 0,
      bankFeePkr: 0,
    })],
  });
  const result = evaluate({
    invoices: [makeInvoice("invoice-small", 0.1, 28, "bank-small"), makeInvoice("invoice-large", 0.2, 56, "bank-large")],
    ledgerCredits: [ledger(28, { id: "bank-small" }), ledger(56, { id: "bank-large" })],
  });
  assert.equal(result.ok, true, result.ok ? undefined : result.errors.join(" "));
  assert.deepEqual(result.incomeByInvoice, {
    "invoice-small": 28,
    "invoice-large": 56,
  });
  assert.equal(result.incomeBySubcategory[subcategory], 84);
  assert.equal(
    Object.values(result.incomeByInvoice).reduce((sum, amount) => sum + amount, 0),
    result.incomeBySubcategory[subcategory],
  );
  assert.equal(result.incomeTotal, 84);
});

test("accrual basis requires a due date and FX evidence for foreign invoices", () => {
  const result = evaluate({
    accountingMethod: "ACCRUAL",
    invoices: [
      invoice({
        dueDate: null,
        exchangeRateToPkr: null,
        fxEvidenceReference: null,
      }),
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /income-due date/);
  assert.match(result.errors.join(" "), /invoice-date PKR exchange rate/);
  assert.match(result.errors.join(" "), /invoice-date FX evidence/);
});

test("an unmatched Services ledger credit blocks both omission and double counting", () => {
  const result = evaluate({
    invoices: [invoice({ paymentMatches: [] })],
    ledgerCredits: [ledger()],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /allocated exactly once/);
});

test("missing fee/withholding evidence fails closed instead of assuming zero", () => {
  const result = evaluate({
    invoices: [invoice({ paymentMatches: [payout({ platformFeePkr: null })] })],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /explicit non-negative platform-fee amount/);
});

test("payout FX and bank credit must reconcile to the separately recorded net settlement", () => {
  const result = evaluate({
    invoices: [invoice({ paymentMatches: [payout({ settlementAmount: 89 })] })],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /does not reconcile to the bank credit/);
});

test("cash basis excludes an invoice with no receipt during TY2026", () => {
  const result = evaluate({
    invoices: [invoice({ paymentStatus: "NO_RECEIPT_TY", paymentMatches: [] })],
    ledgerCredits: [],
  });
  assert.equal(result.ok, true);
  assert.equal(result.incomeTotal, 0);
});

test("invoice extraction groups numbered rows without treating a PKR bank credit as income", () => {
  const rows = parseServicesInvoiceSummaryFields([
    { label: "Invoice Number 1", value: "INV-USD-1" },
    { label: "Invoice Date 1", value: "2026-01-15" },
    { label: "Client 1", value: "Synthetic Client One" },
    { label: "Service Description 1", value: "Software development" },
    { label: "Invoice Amount 1", value: "100.00" },
    { label: "Invoice Currency 1", value: "USD" },
    { label: "Invoice Number 2", value: "INV-PKR-2" },
    { label: "Invoice Date 2", value: "2026-03-01" },
    { label: "Client 2", value: "Synthetic Client Two" },
    { label: "Service Description 2", value: "Design work" },
    { label: "Invoice Amount (PKR) 2", value: "1,500.00" },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].invoiceAmount, 100);
  assert.equal(rows[0].currency, "USD");
  assert.equal(rows[1].invoiceAmount, 1500);
  assert.equal(rows[1].currency, "PKR");
  assert.deepEqual(rows.map((row) => row.issues), [[], []]);
});

test("ambiguous unnumbered duplicate invoice fields are reported rather than paired by guess", () => {
  const rows = parseServicesInvoiceSummaryFields([
    { label: "Invoice Number", value: "INV-A" },
    { label: "Invoice Number", value: "INV-B" },
    { label: "Invoice Date", value: "2026-01-15" },
    { label: "Client", value: "Client" },
    { label: "Service Description", value: "Services" },
    { label: "Invoice Amount (PKR)", value: 1000 },
  ]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].issues.some((issue) => /more than one invoiceNumber/.test(issue)));
});
