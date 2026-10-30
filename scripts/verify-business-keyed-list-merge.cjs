"use strict";
/**
 * 27-Oct (diagnosed from the operator's own database): the Business data review
 * step said "Conflicting Business Bank Accounts JSON in reviewed documents"
 * while the documents actually agreed. Values, from
 * scripts/diag-reviewed-business-conflicts.cjs:
 *
 *   business_balance_sheet  [{"iban":"PK35HABB0018067900476803","balance":15000000}]
 *   business_support        [{"iban":"PK35HABB0018067900476803","balance":15000000}]
 *   business_books          [{"iban":"PK35HABB0018067900476803"}]      <- no balance
 *
 * The comparison was one JSON string, so "this document did not print the
 * balance" read as "this document disagrees".
 *
 * Checks:
 *   1. a field only one document states is taken from it, and no conflict is
 *      raised (the reported case);
 *   2. a DIFFERENT balance for the same account still conflicts, and no value is
 *      guessed;
 *   3. amounts written as text and as numbers are the same balance;
 *   4. blank fields are ignored, a different set of accounts merges;
 *   5. vehicles merge by registration number on the same rules;
 *   6. a free-form list (add-backs) keeps the strict one-string comparison;
 *   7. the merged rows are what the sanitizer then accepts.
 * Synthetic IBANs and amounts only.
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
require.extensions[".ts"] = (m, file) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    file,
  );

const intake = require("../lib/tax/business-document-intake.ts");
const details = require("../lib/tax/business-balance-details.ts");

const IBAN = "PK36SCBL0000001123456702";
const OTHER = "PK24SCBL0000001234567890";

const doc = (id, fields) => ({
  id,
  documentType: "business_support",
  extractionStatus: "MAPPED",
  extractedData: JSON.stringify({
    fields: Object.entries(fields).map(([label, value]) => ({ label, value, confidence: 0.9 })),
  }),
});
const accounts = (rows) => ({ "Business Bank Accounts JSON": JSON.stringify(rows) });
const read = (...docs) => intake.readReviewedBusinessFacts(docs, {});

// ---------------------------------------------------------------------------
// 1. The reported documents
// ---------------------------------------------------------------------------

test("bank accounts: an account printed without a balance is not a conflict", () => {
  const result = read(
    doc("sheet", accounts([{ iban: IBAN, balance: 15000000 }])),
    doc("support", accounts([{ iban: IBAN, balance: 15000000 }])),
    doc("books", accounts([{ iban: IBAN }])),
  );
  assert.deepEqual(result.issues, [], "the documents agree");
  assert.deepEqual(result.details.businessBankAccounts, [{ balance: 15000000, iban: IBAN }]);
  assert.deepEqual(result.provenance.businessBankAccounts.sort(), ["books", "sheet", "support"]);
});

test("bank accounts: the balance comes from the document that prints it, never guessed", () => {
  const result = read(
    doc("books", accounts([{ iban: IBAN }])),
    doc("sheet", accounts([{ iban: IBAN, balance: 15000000 }])),
  );
  assert.deepEqual(result.details.businessBankAccounts, [{ balance: 15000000, iban: IBAN }]);
  const noBalanceAnywhere = read(
    doc("books", accounts([{ iban: IBAN }])),
    doc("sheet", accounts([{ iban: IBAN }])),
  );
  assert.deepEqual(noBalanceAnywhere.issues, []);
  assert.deepEqual(noBalanceAnywhere.details.businessBankAccounts, [{ iban: IBAN }], "no balance invented");
});

// ---------------------------------------------------------------------------
// 2. A real disagreement
// ---------------------------------------------------------------------------

test("bank accounts: two different balances for one account still conflict", () => {
  const result = read(
    doc("sheet", accounts([{ iban: IBAN, balance: 15000000 }])),
    doc("statement", accounts([{ iban: IBAN, balance: 700000 }])),
  );
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].key, "businessBankAccounts");
  assert.match(result.issues[0].text, /Conflicting Business Bank Accounts JSON/);
  assert.match(result.issues[0].text, /balance/);
  assert.match(result.issues[0].text, /15000000 vs 700000/);
  assert.equal(result.details.businessBankAccounts, undefined, "nothing is guessed");
});

test("bank accounts: a different IBAN is a different account, not a conflict", () => {
  const result = read(
    doc("a", accounts([{ iban: IBAN, balance: 15000000 }])),
    doc("b", accounts([{ iban: OTHER, balance: 250000 }])),
  );
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.details.businessBankAccounts, [
    { balance: 250000, iban: OTHER },
    { balance: 15000000, iban: IBAN },
  ]);
});

// ---------------------------------------------------------------------------
// 3. Shapes that mean the same thing
// ---------------------------------------------------------------------------

test("bank accounts: an amount written as text and as a number is the same balance", () => {
  const result = read(
    doc("sheet", accounts([{ iban: IBAN, balance: 15000000 }])),
    doc("support", accounts([{ iban: IBAN, balance: 15000000.0 }])),
  );
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.details.businessBankAccounts, [{ balance: 15000000, iban: IBAN }]);
});

test("bank accounts: blank fields are ignored, and the IBAN is matched generously", () => {
  const result = read(
    doc("sheet", accounts([{ iban: "PK36 SCBL 0000 0011 2345 6702", balance: null }])),
    doc("support", accounts([{ IBAN: "pk36scbl0000001123456702", balance: 15000000 }])),
  );
  assert.deepEqual(result.issues, [], "same account, one balance known");
  assert.equal(result.details.businessBankAccounts.length, 1);
  assert.equal(result.details.businessBankAccounts[0].balance, 15000000);
});

// ---------------------------------------------------------------------------
// 4. Vehicles use the same rule
// ---------------------------------------------------------------------------

test("vehicles: one document without a value is not a conflict, a different value is", () => {
  const ok = read(
    doc("register", { "Business Vehicles JSON": JSON.stringify([{ registrationNo: "ABC-123", value: 415000 }]) }),
    doc("tax", { "Business Vehicles JSON": JSON.stringify([{ registrationNo: "abc 123" }]) }),
  );
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.details.businessVehicles.length, 1);
  assert.equal(ok.details.businessVehicles[0].registrationNo, "ABC-123");
  assert.equal(ok.details.businessVehicles[0].value, 415000, "the printed value, not a guess");

  const bad = read(
    doc("register", { "Business Vehicles JSON": JSON.stringify([{ registrationNo: "ABC-123", value: 415000 }]) }),
    doc("tax", { "Business Vehicles JSON": JSON.stringify([{ registrationNo: "ABC-123", value: 500000 }]) }),
  );
  assert.equal(bad.issues.length, 1);
  assert.match(bad.issues[0].text, /Conflicting Business Vehicles JSON/);
});

// ---------------------------------------------------------------------------
// 5. Free-form lists keep the strict comparison
// ---------------------------------------------------------------------------

test("other lists: an add-back list still has to match exactly", () => {
  const result = read(
    doc("books", { "Business Add Backs JSON": JSON.stringify([{ code: "3212", amount: 60000 }]) }),
    doc("support", { "Business Add Backs JSON": JSON.stringify([{ code: "3212", amount: 0 }]) }),
  );
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0].text, /Conflicting Business Add Backs JSON/);
});

// ---------------------------------------------------------------------------
// 6. What the app then does with the merged rows
// ---------------------------------------------------------------------------

test("merged rows are exactly what the balance-detail check expects", () => {
  const result = read(
    doc("sheet", accounts([{ iban: IBAN, balance: 15000000 }])),
    doc("books", accounts([{ iban: IBAN }])),
  );
  const cleaned = details.sanitizeBusinessBankAccounts(result.details.businessBankAccounts);
  assert.equal(cleaned.ok, true);
  assert.deepEqual(cleaned.rows, [{ iban: IBAN, balance: 15000000 }]);
  const checked = details.validateBusinessBankAccounts(cleaned.rows, { balanceFromStatement: false });
  assert.deepEqual(checked, []);
});
