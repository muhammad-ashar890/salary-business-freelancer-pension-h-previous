"use strict";
/**
 * 16-Oct (document auto-fill, part 2): a business bank account's balance on
 * 30 June comes from that account's mapped bank statement; on the Business
 * profit step the taxpayer only ticks which of the filing's bank accounts
 * belong to the business.
 *
 * Checks:
 *   1. lib/tax/business-balance-details.ts fills each business account's
 *      balance from the statement with the same IBAN (none / two -> a clear
 *      problem) and the step's check does not ask for a balance;
 *   2. buildBusinessPacket takes the statement balance (a typed one is
 *      ignored), stops without a statement, and still compares with the
 *      Balance Sheet;
 *   3. app/actions/packet.ts passes the reconciliation's account balances;
 *   4. the step lists the filing's accounts with a tick box and the statement
 *      balance; no balance box is left.
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
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@/app/actions/filing")
    return {
      getBusinessBooksValuesAction: async () => ({ success: true, mapped: false }),
      getBankStatementBalancesAction: async () => ({ success: true, balances: [] }),
    };
  return load.call(this, request, ...rest);
};

const details = require(path.join(root, "lib/tax/business-balance-details.ts"));
const business = require(path.join(root, "lib/tax/business-filing.ts"));
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const fields = (o) => Object.entries(o).map(([label, value]) => ({ label, value, confidence: 1 }));

const HBL = "PK35HABB0018067900476803";
const OTHER = "PK38TEST0000000000000001";

// ---------------------------------------------------------------------------
// 1. Balances from the statements
// ---------------------------------------------------------------------------
test("fill: the balance is the closing balance of the statement with the same IBAN", () => {
  const got = details.fillBusinessBankBalancesFromStatements(
    [{ iban: HBL, balance: 1250000 }],
    [
      { iban: "pk35 habb 0018 0679 0047 6803", closingBalance: 3500000 },
      { iban: OTHER, closingBalance: 10 },
    ],
  );
  assert.deepEqual(got, { rows: [{ iban: HBL, balance: 3500000 }], problems: [] }, "a typed balance is replaced");
});

test("fill: no statement or two statements for the IBAN is a clear problem", () => {
  const none = details.fillBusinessBankBalancesFromStatements([{ iban: HBL }], [{ iban: OTHER, closingBalance: 5 }]);
  assert.deepEqual(none.rows, [{ iban: HBL }]);
  assert.match(none.problems[0], /comes from the bank statement of that account\. Add the account on the Bank accounts step and upload and map its 12-month statement\./);
  const two = details.fillBusinessBankBalancesFromStatements(
    [{ iban: HBL }],
    [{ iban: HBL, closingBalance: 1 }, { iban: HBL, closingBalance: 2 }],
  );
  assert.match(two.problems[0], /more than one bank statement has this IBAN/);
});

test("step check: no balance is asked on the step; the IBAN is still checked", () => {
  assert.deepEqual(details.validateBusinessBankAccounts([{ iban: HBL }], { balanceFromStatement: true }), []);
  assert.match(details.validateBusinessBankAccounts([{ iban: HBL }]).join(" "), /enter the balance on 30 June/);
  assert.match(
    details.validateBusinessBankAccounts([{ iban: "PK00XXXX" }], { balanceFromStatement: true }).join(" "),
    /not a valid Pakistani IBAN/,
  );
});

// ---------------------------------------------------------------------------
// 2. The packet
// ---------------------------------------------------------------------------
const sheet = (bank) => ({
  id: "synthetic-sheet",
  extractionStatus: "MAPPED",
  extractedData: JSON.stringify({
    fields: fields({
      "Business Name": "SYNTHETIC TRADERS (TEST)",
      "Tax Year": 2026,
      "Balance Sheet Date": "2026-06-30",
      Currency: "PKR",
      "Business Land": 0,
      "Business Building": 0,
      "Business Bank Balance": bank,
      "Plant / Machinery / Equipment / Furniture": 0,
      "Stocks / Stores / Spares": 0,
      "Business Motor Vehicles": 0,
      "Advances / Deposits / Prepayments": 0,
      "Business Cash in Hand": 0,
      "Bonds / Securities": 0,
      "Other Business Assets": 0,
      "Total Assets": bank,
      "Owner Capital": bank,
      "Long Term Borrowings / Debt / Loan": 0,
      "Trade Creditors / Payables": 0,
      "Other Business Liabilities": 0,
      "Total Equity and Liabilities": bank,
    }),
  }),
});
const packet = (bankRows, balances, bank = 3500000) =>
  business.buildBusinessPacket({
    taxYear: 2026,
    filerType: "myself",
    incomeSources: ["business"],
    selections: [
      {
        source: "business",
        subcategory: "profit-return",
        detailsJson: JSON.stringify({
          userDetails: {
            businessGrossSales: 12000000,
            businessSalesExcludeIndirectTax: true,
            businessTurnover100mEarlierYear: false,
            businessBankAccounts: bankRows,
          },
        }),
      },
    ],
    balanceSheet: sheet(bank),
    ...(balances ? { bankStatementBalances: balances } : {}),
  });

test("packet: the 3320 row takes the statement balance; a typed balance is ignored", () => {
  const p = packet([{ iban: HBL, balance: 1250000 }], [{ iban: HBL, closingBalance: 3500000 }]);
  const bank = p.balanceDetails.agentFields.filter((f) => f.kind === "bank");
  assert.equal(bank.length, 1);
  assert.equal(bank[0].iban, HBL);
  assert.equal(bank[0].value, "3500000");
  assert.ok(!p.pending.some((item) => item.key === "balanceSheet.bank"));
});

test("packet: a business account without a mapped statement stops the packet with the reason", () => {
  assert.throws(() => packet([{ iban: HBL }], [{ iban: OTHER, closingBalance: 3500000 }]), /upload and map its 12-month statement/);
});

test("packet: the statement balance must still equal the Balance Sheet bank figure", () => {
  assert.throws(
    () => packet([{ iban: HBL }], [{ iban: HBL, closingBalance: 3500000 }], 1250000),
    /Business bank accounts add up to Rs 3,500,000, but the Balance Sheet bank figure is Rs 1,250,000/,
  );
});

test("packet: callers that pass no statement balances keep the old typed list (tests, older callers)", () => {
  const p = packet([{ iban: HBL, balance: 3500000 }], undefined);
  assert.equal(p.balanceDetails.agentFields.find((f) => f.kind === "bank").value, "3500000");
});

// ---------------------------------------------------------------------------
// 3. Server wiring
// ---------------------------------------------------------------------------
test("server: the packet action passes the reconciliation's account balances by IBAN", () => {
  const action = read("app/actions/packet.ts");
  assert.match(action, /const bankStatementBalances =\s*"preview" in reconciliation && reconciliation\.preview\s*\? reconciliation\.preview\.accountBalances\.flatMap/);
  assert.match(action, /books: reviewedBusinessBooks,\s*bankStatementBalances,\s*\}\);/);
  const filing = read("app/actions/filing.ts");
  assert.ok(filing.includes("export async function getBankStatementBalancesAction(draftId: string)"));
  assert.ok(filing.includes("const iban = normalizeIban(statement.bankAccount?.iban);"));
});

// ---------------------------------------------------------------------------
// 4. The step
// ---------------------------------------------------------------------------
test("step: the filing's accounts are ticked, the balance is shown from the statement, nothing is typed", () => {
  const step = read("components/tax/filing/wizard-business-profit-step.tsx");
  for (const piece of [
    "BUSINESS_BANK_TEXT.choose",
    "toggleBusinessBank(account.iban, event.target.checked)",
    "(from the statement)",
    "validateBusinessBankAccounts(banks, { balanceFromStatement: true })",
    "getBankStatementBalancesAction(draftId)",
  ])
    assert.ok(step.includes(piece), piece);
  for (const gone of ["function setBankValue(", "Balance of bank account", "IBAN (from the bank statement)"])
    assert.ok(!step.includes(gone), gone);
  assert.ok(/^[\x00-\x7F]*$/.test(step), "ASCII only");
  const wizard = read("components/tax/filing/filing-wizard.tsx");
  assert.match(wizard, /bankAccounts=\{bankAccounts\.map\(\(account\) => \(\{\s*iban: account\.iban,/);
});

test("step: rendered with the filing's accounts, each has a tick box; an IBAN that is not an account is flagged", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { JSDOM } = require("jsdom");
  const { WizardBusinessProfitStep } = require(path.join(root, "components/tax/filing/wizard-business-profit-step.tsx"));
  const html = renderToStaticMarkup(
    React.createElement(WizardBusinessProfitStep, {
      selections: [
        {
          source: "business",
          subcategory: "profit-return",
          details: { businessTurnover100mEarlierYear: false, businessBankAccounts: [{ iban: HBL }, { iban: "PK36SCBL0000001123456702" }] },
        },
      ],
      onToggle: () => {},
      onDetailsChange: () => {},
      draftId: "synthetic-draft",
      bankAccounts: [
        { iban: HBL, bankName: "HBL", accountLabel: "Business current" },
        { iban: OTHER, bankName: "TEST BANK", accountLabel: "Personal" },
      ],
    }),
  );
  const doc = new JSDOM(html).window.document;
  const boxes = [...doc.querySelectorAll('input[type="checkbox"]')].filter((box) => box.closest("li"));
  assert.equal(boxes.length, 2, "one tick box per bank account of the filing");
  assert.equal(boxes[0].checked, true, "the HBL account is ticked");
  assert.equal(boxes[1].checked, false);
  const text = doc.body.textContent;
  assert.ok(text.includes(details.BUSINESS_BANK_TEXT.balanceAfterStatement));
  assert.ok(text.includes(details.BUSINESS_BANK_TEXT.notYourAccount), "the IBAN that is not an account is flagged");
});
