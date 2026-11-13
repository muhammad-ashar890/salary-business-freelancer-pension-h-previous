"use strict";

/**
 * TY2026 Salary + Business + Pension synthetic statement regression.
 * Suggestions only: the reviewer still approves every row. These tests protect
 * the three exact narration/order failures without broadening generic credits,
 * transfers, cash movements, refunds or business running-cost inference.
 */
const test = require("node:test");
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
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );

const { classifyTransaction } = require("../lib/tax/bank-classification-rules.ts");
const options = { businessEnabled: true, businessAccountConfirmed: true };
const tx = (description, debit = 0, credit = 0) => ({
  id: "synthetic-row",
  bankAccountId: "synthetic-hbl",
  transactionDate: new Date("2026-01-15"),
  description,
  debit,
  credit,
});
const classify = (description, debit = 0, credit = 0, route = options) =>
  classifyTransaction(tx(description, debit, credit), [], route);
const expect = (description, category, debit = 0, credit = 0, route = options) => {
  const result = classify(description, debit, credit, route);
  assert.equal(result.status, "SUGGESTED", `${description}: ${JSON.stringify(result)}`);
  assert.equal(result.category, category, `${description}: ${JSON.stringify(result)}`);
  return result;
};

test("all 12 Pension payroll credits are Pension, while Salary payroll stays Salary", () => {
  for (let month = 1; month <= 12; month += 1) {
    expect(
      `Pension payroll SYNTHETIC TEST PENSION FUND month ${String(month).padStart(2, "0")}`,
      "PENSION",
      0,
      100_000,
    );
    expect(
      `Salary payroll SYNTHETIC TEST EMPLOYER (PVT) LTD month ${String(month).padStart(2, "0")}`,
      "SALARY",
      0,
      200_000,
    );
  }
});

test("singular Business sale receipt credits are Business sales in a business filing", () => {
  for (const invoice of ["SYN-TRADE-001", "SYN-TRADE-002"]) {
    expect(
      `Business sale receipt ${invoice} net of PKR 10000 withholding`,
      "BUSINESS_SALES",
      0,
      990_000,
    );
  }
  expect("Business sales receipt SYN-TRADE-003", "BUSINESS_SALES", 0, 990_000);
});

test("Business sale wording does not make an unexplained non-business credit taxable sales", () => {
  const result = classify(
    "Business sale receipt SYN-TRADE-001 net of PKR 10000 withholding",
    0,
    990_000,
    { businessEnabled: false, businessAccountConfirmed: false },
  );
  assert.equal(result.status, "POTENTIAL_INCOME");
  assert.equal(result.category, "POTENTIAL_INCOME");
});

test("explicit Personal utility stays personal on a confirmed business account", () => {
  expect("Personal utility payments SYNTHETIC TEST", "UTILITIES_OR_RENT", 100_000, 0);
  expect("Personal utilities payment", "UTILITIES_OR_RENT", 100_000, 0);
});

test("ordinary business running costs and existing personal expenses are unchanged", () => {
  expect("Business utilities payment", "BUSINESS_OPERATING_EXPENSE", 100_000, 0);
  expect("Electricity bill for shop", "BUSINESS_OPERATING_EXPENSE", 100_000, 0);
  expect("Personal household expense SYNTHETIC TEST", "PERSONAL_EXPENSE", 300_000, 0);
  assert.equal(classify("Personal travel expense SYNTHETIC TEST", 200_000, 0).status, "UNREVIEWED");
});

test("whole 31-row fixture gets the intended categories and economic totals", () => {
  const rows = [];
  for (let month = 1; month <= 12; month += 1) {
    const mm = String(month).padStart(2, "0");
    rows.push([`Pension payroll SYNTHETIC TEST PENSION FUND month ${mm}`, 0, 100_000, "PENSION"]);
    rows.push([`Salary payroll SYNTHETIC TEST EMPLOYER (PVT) LTD month ${mm}`, 0, 200_000, "SALARY"]);
  }
  rows.push(
    ["Personal utility payments SYNTHETIC TEST", 100_000, 0, "UTILITIES_OR_RENT"],
    ["Business sale receipt SYN-TRADE-001 net of PKR 10000 withholding", 0, 990_000, "BUSINESS_SALES"],
    ["Business supplier payment for cost of sales SYN-TRADE", 800_000, 0, "BUSINESS_COST_OF_SALES"],
    ["Personal household expense SYNTHETIC TEST", 300_000, 0, "PERSONAL_EXPENSE"],
    ["Business sale receipt SYN-TRADE-002 net of PKR 10000 withholding", 0, 990_000, "BUSINESS_SALES"],
    ["Business rent expense payment SYN-TRADE", 400_000, 0, "BUSINESS_OPERATING_EXPENSE"],
    ["Personal travel expense SYNTHETIC TEST", 200_000, 0, null],
  );
  const counts = {};
  let credits = 0;
  let debits = 0;
  for (const [description, debit, credit, category] of rows) {
    if (category) expect(description, category, debit, credit);
    else assert.equal(classify(description, debit, credit).status, "UNREVIEWED");
    const countKey = category || "UNREVIEWED";
    counts[countKey] = (counts[countKey] || 0) + 1;
    credits += credit;
    debits += debit;
  }
  assert.equal(rows.length, 31);
  assert.deepEqual(counts, {
    PENSION: 12,
    SALARY: 12,
    UTILITIES_OR_RENT: 1,
    BUSINESS_SALES: 2,
    BUSINESS_COST_OF_SALES: 1,
    PERSONAL_EXPENSE: 1,
    BUSINESS_OPERATING_EXPENSE: 1,
    UNREVIEWED: 1,
  });
  assert.equal(credits, 5_580_000); // Net salary 2.3m + pension 1.2m + net sales 1.98m.
  assert.equal(debits, 1_800_000); // Business 1.2m + personal 0.6m.
});

test("safety guards remain fail-closed", () => {
  assert.equal(classify("Deposit 9931", 0, 45_000).status, "POTENTIAL_INCOME");
  assert.equal(classify("Cash deposit at counter", 0, 45_000).status, "POTENTIAL_CASH_MOVEMENT");
  assert.equal(classify("Transfer from business sales account", 0, 45_000).status, "POTENTIAL_TRANSFER");
  assert.equal(classify("Business sale receipt refund", 0, 45_000).status, "UNREVIEWED");
  assert.equal(classify("Business utilities payment equipment purchase", 45_000, 0).status, "UNREVIEWED");
});
