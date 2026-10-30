"use strict";
/**
 * 28-Oct-2026 (operator): the upload step must not raise an error when the
 * statement balance does not match. The salary run went all the way to the FBR
 * window before the
 * 1,550,000 unreconciled amount appeared, because every upload-step check looks
 * at one document on its own. The bank statement is internally consistent however
 * large its opening balance is; what was missing is the cross-check against the
 * previous return's declared wealth.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const oldResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return oldResolve.call(
    this,
    request.startsWith("@/") ? path.join(root, request.slice(2)) : request,
    ...rest,
  );
};
require.extensions[".ts"] = (m, f) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(f, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    f,
  );

const { bankOpeningDeclaredCheck, previousReturnBankRowTotal } = require(
  "../lib/tax/bank-opening-declared.ts",
);

// The operator's real approved TY2025 return, as IRIS carries it.
const REAL_RETURN_ROWS = [
  { code: "7006", description: "Investments / Stocks / Bonds / etc.", amount: 1_119_666, detail: false },
  { code: "7006", description: "Investments / Stocks / Bonds / etc. - AL AMEEN - SHARIAH STOCK FUND", amount: 235_588, detail: true },
  { code: "7006", description: "Investments / Stocks / Bonds / etc. - AL AMEEN - ISLAMIC RETIREMENT FUND", amount: 884_078, detail: true },
  { code: "7012", description: "Cash in hand", amount: 280_554, detail: false },
  { code: "7008", description: "Motor Vehicle(s)", amount: 2_220_000, detail: false },
  { code: "7010", description: "Household Effects", amount: 250_000, detail: false },
  { code: "7013", description: "Any Other Asset(s)", amount: 3_910_000, detail: false },
  { code: "7014", description: "Assets held on others name", amount: 1_000_000, detail: false },
];

test("the case that failed is caught: 1,550,000 opening with only 280,554 declared", () => {
  const result = bankOpeningDeclaredCheck({
    openingBalance: 1_550_000,
    previousReturnRows: REAL_RETURN_ROWS,
    previousReturnCashInHand: 280_554,
    previousReturnHasBankRow: false,
  });
  assert.equal(result.status, "warning");
  assert.equal(result.uncovered, 1_269_446);
  assert.equal(result.declared, 280_554);
  assert.match(result.message, /PKR 1,550,000/);
  assert.match(result.message, /PKR 1,269,446 of that opening balance has no declared row/);
  assert.match(result.message, /unreconciled amount/);
  assert.match(result.message, /Nothing is blocked and no figure is guessed/);
});

test("the corrected statement (opening 0) is silent", () => {
  for (const opening of [0, -1, null, undefined]) {
    assert.deepEqual(
      bankOpeningDeclaredCheck({
        openingBalance: opening,
        previousReturnRows: REAL_RETURN_ROWS,
        previousReturnCashInHand: 280_554,
      }),
      { status: "unknown", uncovered: 0, declared: 0, message: null },
      String(opening),
    );
  }
});

test("a first-time filer (no approved previous return) is never warned", () => {
  assert.equal(
    bankOpeningDeclaredCheck({
      openingBalance: 9_000_000,
      previousReturnRows: null,
      previousReturnCashInHand: null,
    }).status,
    "unknown",
  );
  assert.equal(
    bankOpeningDeclaredCheck({
      openingBalance: 9_000_000,
      previousReturnRows: [],
      previousReturnCashInHand: null,
    }).status,
    "unknown",
  );
});

test("an opening balance the return already declares passes quietly", () => {
  const rows = [
    { code: "7012", description: "Cash in hand", amount: 300_000 },
    { code: "7009", description: "Bank Account(s)", amount: 1_250_000 },
  ];
  const result = bankOpeningDeclaredCheck({
    openingBalance: 1_500_000,
    previousReturnRows: rows,
    previousReturnCashInHand: 300_000,
    previousReturnHasBankRow: true,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.uncovered, 0);
  assert.equal(result.message, null);
});

test("the bank account row is counted, and its detail lines are not double counted", () => {
  const rows = [
    { code: "7009", description: "Bank Account(s)", amount: 1_000_000, detail: false },
    { code: "7009", description: "Bank Account(s) - PK35HABB0018067900476803 - Self", amount: 1_000_000, detail: true },
  ];
  assert.equal(previousReturnBankRowTotal(rows), 2_000_000);
  // The check only reads the printed rows it is given; the caller passes the
  // aggregate. A 1,000,000 opening against a 1,000,000 bank row is covered.
  assert.equal(
    bankOpeningDeclaredCheck({
      openingBalance: 1_000_000,
      previousReturnRows: rows,
      previousReturnCashInHand: 0,
      previousReturnHasBankRow: true,
    }).status,
    "ok",
  );
});

test("exactly-covered and one-rupee-over behave as expected", () => {
  const rows = [{ code: "7012", description: "Cash in hand", amount: 500_000 }];
  assert.equal(
    bankOpeningDeclaredCheck({
      openingBalance: 500_000,
      previousReturnRows: rows,
      previousReturnCashInHand: 500_000,
    }).status,
    "ok",
  );
  const over = bankOpeningDeclaredCheck({
    openingBalance: 500_001,
    previousReturnRows: rows,
    previousReturnCashInHand: 500_000,
  });
  assert.equal(over.status, "warning");
  assert.equal(over.uncovered, 1);
});

// ---- wiring ---------------------------------------------------------------
const wizard = fs.readFileSync(path.join(root, "components/tax/filing/filing-wizard.tsx"), "utf8");
const documents = fs.readFileSync(path.join(root, "components/tax/filing/wizard-documents-step.tsx"), "utf8");
const action = fs.readFileSync(path.join(root, "app/actions/bank-opening-check.ts"), "utf8");

test("the warning is shown on the Documents step and never blocks Continue", () => {
  assert.match(wizard, /getBankOpeningDeclaredCheckAction\(draftId\)/);
  assert.match(wizard, /openingBalanceWarning=\{bankOpeningWarning\}/);
  assert.match(documents, /Check the bank statement&apos;s opening balance before you go further/);
  assert.match(documents, /openingBalanceWarning && \(/);
  // it must not appear in any blocking branch
  assert.equal(/setFilingActionError\([^)]*bankOpening/i.test(wizard), false);
});

test("the check reads the approved previous return and the newest statement per account", () => {
  assert.match(action, /approvedPreviousReturnFromDocuments/);
  assert.match(action, /latestPerAccount/);
  assert.match(action, /documentType: "previous_return"/);
  assert.match(action, /toMoneyNumber\(statement\.openingBalance\)/);
});
