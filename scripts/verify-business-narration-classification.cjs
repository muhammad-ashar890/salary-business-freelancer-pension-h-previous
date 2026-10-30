"use strict";
/**
 * 27-Oct-2026, from the operator's own HBL statement (Filing-5): Bank
 * Intelligence asked the reviewer to re-type 9 rows the narration already
 * described, and 2 more it left as "Unreviewed":
 *
 *   "Standing instruction — shop rent (Q1..Q4)"   60,000 x4  -> Utilities or rent   (personal Wealth 7051!)
 *   "Cash deposit — sales proceeds"         1,500,000 etc x3 -> Potential cash movement
 *   "IBFT credit — M/s Al-Noor Traders"     1,200,000        -> Potential transfer
 *   "IBFT credit — M/s Sunrise Enterprises"   800,000        -> Potential transfer
 *   "Household / family transfer"             100,000 x2     -> Unreviewed
 *
 * Shop rent on the personal side hid PKR 240,000 of business expense and left
 * 7051 Rent 60,000 in the Wealth Statement; the credit rows hid the whole
 * PKR 6,000,000 of sales from the business ledger.
 *
 * Every case below is one of those rows, a neighbour that must NOT change, or
 * the same row in a non-business filing. A suggestion is not an approval: the
 * reviewer still presses the tick.
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

const rules = require("../lib/tax/bank-classification-rules.ts");
const categories = require("../lib/tax/business-bank-categories.ts");

const tx = (description, debit = 0, credit = 0) => ({
  id: "synthetic-row",
  bankAccountId: "synthetic-hbl",
  transactionDate: new Date("2025-07-05"),
  description,
  debit,
  credit,
});
const classify = (description, options = { businessEnabled: true }, debit = 0, credit = 0) =>
  rules.classifyTransaction(tx(description, debit, credit), [], options);

const expectSuggestion = (description, entryType, category, debit, credit) => {
  const result = classify(description, { businessEnabled: true }, debit, credit);
  assert.equal(result.status, "SUGGESTED", `${description} -> ${JSON.stringify(result)}`);
  assert.equal(result.entryType, entryType, description);
  assert.equal(result.category, category, description);
  // The suggestion must pass the same guards a manual decision goes through.
  assert.equal(
    categories.bankEntryDirectionError({ debit, credit }, result.entryType),
    null,
    description,
  );
  assert.equal(categories.businessBankDecisionError(result.entryType, result.category, true), null);
  return result;
};

// ---- 1. shop rent is a business expense, not a personal one ---------------
for (const quarter of ["Q1", "Q2", "Q3", "Q4"]) {
  test(`shop rent ${quarter} is suggested as Business operating expense`, () => {
    expectSuggestion(
      `Standing instruction — shop rent (${quarter})`,
      "EXPENSE",
      "BUSINESS_OPERATING_EXPENSE",
      60_000,
      0,
    );
  });
}

// ---- 2. the three cash deposits and two IBFT credits are sales ------------
for (const [amount, index] of [[1_500_000, 1], [1_300_000, 2], [1_200_000, 3]]) {
  test(`cash deposit ${index} (${amount}) is suggested as Business sales, not a cash movement`, () => {
    const result = expectSuggestion(
      "Cash deposit — sales proceeds",
      "INCOME",
      "BUSINESS_SALES",
      0,
      amount,
    );
    assert.notEqual(result.status, "POTENTIAL_CASH_MOVEMENT");
  });
}

for (const [narration, amount] of [
  ["IBFT credit — M/s Al-Noor Traders", 1_200_000],
  ["IBFT credit — M/s Sunrise Enterprises", 800_000],
]) {
  test(`${narration} is suggested as Business sales, not an internal transfer`, () => {
    const result = expectSuggestion(narration, "INCOME", "BUSINESS_SALES", 0, amount);
    assert.notEqual(result.status, "POTENTIAL_TRANSFER");
  });
}

// ---- 3. the rows that were already right stay right -----------------------
test("stock purchase cheques are cost of sales", () => {
  for (const [cheque, amount] of [
    ["Cheque 100234 — stock purchases", 1_200_000],
    ["Cheque 100235 — stock purchases", 900_000],
    ["Cheque 100236 — stock purchases", 1_000_000],
    ["Cheque 100237 — stock purchases", 700_000],
  ]) {
    expectSuggestion(cheque, "EXPENSE", "BUSINESS_COST_OF_SALES", amount, 0);
  }
});

test("salary transfers are business operating expenses on the debit side", () => {
  for (const month of ["Jul", "Oct", "Jan", "Apr"]) {
    expectSuggestion(
      `Salary transfer — staff (${month})`,
      "EXPENSE",
      "BUSINESS_OPERATING_EXPENSE",
      40_000,
      0,
    );
  }
});

test("household utility bills keep the personal utilities category", () => {
  const result = classify("Utility bills — K-Electric / SSGC", { businessEnabled: true }, 125_000, 0);
  assert.equal(result.category, "UTILITIES_OR_RENT");
  assert.equal(categories.isBusinessBankCategory(result.category), false);
});

// ---- 4. the two rows that were left Unreviewed ----------------------------
test("household / family transfer is personal expense, not Unreviewed", () => {
  for (const amount of [100_000, 100_000]) {
    expectSuggestion("Household / family transfer", "EXPENSE", "PERSONAL_EXPENSE", amount, 0);
  }
});

test("education and medical debits are personal expense", () => {
  expectSuggestion("Fee transfer — education (instalment 1)", "EXPENSE", "PERSONAL_EXPENSE", 150_000, 0);
  expectSuggestion("Fee transfer — education (instalment 2)", "EXPENSE", "PERSONAL_EXPENSE", 150_000, 0);
  expectSuggestion("Medical — hospital payment", "EXPENSE", "PERSONAL_EXPENSE", 100_000, 0);
});

// ---- 5. nothing changes outside a business filing --------------------------
test("a salary-only or pension filing keeps the old, safer reading", () => {
  const options = { businessEnabled: false };
  assert.equal(classify("Standing instruction — shop rent (Q1)", options, 60_000, 0).category, "UTILITIES_OR_RENT");
  assert.equal(classify("Cash deposit — sales proceeds", options, 0, 1_500_000).status, "POTENTIAL_CASH_MOVEMENT");
  assert.equal(classify("IBFT credit — M/s Al-Noor Traders", options, 0, 1_200_000).status, "POTENTIAL_TRANSFER");
  assert.notEqual(classify("Household / family transfer", options, 100_000, 0).category, "BUSINESS_OPERATING_EXPENSE");
});

// ---- 6. the guards that must still win -------------------------------------
test("salary, pension, gift and profit credits are never called business sales", () => {
  for (const narration of [
    "Salary credit — M/s Al-Noor Traders",
    "Pension credit — M/s Sunrise Enterprises",
    "Gift received — M/s Al-Noor Traders",
    "Profit on deposit — M/s Bank Ltd",
    "IBFT credit — self transfer from own account",
  ]) {
    const result = classify(narration, { businessEnabled: true }, 0, 500_000);
    assert.notEqual(result.category, "BUSINESS_SALES", narration);
  }
});

test("account-to-account transfer wording still wins over sales wording", () => {
  assert.equal(
    classify("Transfer from business sales account", { businessEnabled: true }, 0, 2_000_000).status,
    "POTENTIAL_TRANSFER",
  );
});

test("a plain cash deposit with no sales wording stays a cash movement", () => {
  assert.equal(
    classify("Cash deposit at counter", { businessEnabled: true }, 0, 500_000).status,
    "POTENTIAL_CASH_MOVEMENT",
  );
});

test("a matched pair of owned accounts is still an internal transfer", () => {
  // Same amount, same day, opposite direction, two owned accounts: the pair is
  // real transfer evidence and outranks the sales narration.
  const out = rules.classifyTransaction(
    tx("IBFT credit — M/s Al-Noor Traders", 0, 1_200_000),
    [
      {
        id: "other-side",
        bankAccountId: "synthetic-other-account",
        transactionDate: new Date("2025-07-05"),
        description: "IBFT transfer to business account",
        debit: 1_200_000,
        credit: 0,
      },
    ],
    { businessEnabled: true },
  );
  assert.equal(out.status, "POTENTIAL_TRANSFER", JSON.stringify(out));
});

test("equipment purchase wording is still refused, not turned into an expense", () => {
  assert.equal(
    classify("Business operating expenses - equipment purchase", { businessEnabled: true }, 2_000, 0).status,
    "UNREVIEWED",
  );
});

test("an unexplained credit is still a question, not business sales", () => {
  const result = classify("Deposit 9931", { businessEnabled: true }, 0, 45_000);
  assert.equal(result.status, "POTENTIAL_INCOME");
  assert.equal(result.category, "POTENTIAL_INCOME");
});

// ---- 7. whole statement: 29 rows, correct business/personal split ---------
test("the operator's 29 rows produce 6,000,000 sales, 3,800,000 cost, 400,000 expenses", () => {
  const rows = [
    ["Standing instruction — shop rent (Q1)", 60_000, 0],
    ["Cash deposit — sales proceeds", 0, 1_500_000],
    ["Salary transfer — staff (Jul)", 40_000, 0],
    ["Cheque 100234 — stock purchases", 1_200_000, 0],
    ["Fee transfer — education (instalment 1)", 150_000, 0],
    ["Utility bills — K-Electric / SSGC", 125_000, 0],
    ["Medical — hospital payment", 100_000, 0],
    ["IBFT credit — M/s Al-Noor Traders", 0, 1_200_000],
    ["Standing instruction — shop rent (Q2)", 60_000, 0],
    ["Cheque 100235 — stock purchases", 900_000, 0],
    ["Salary transfer — staff (Oct)", 40_000, 0],
    ["Utility bills — K-Electric / SSGC", 125_000, 0],
    ["Household / family transfer", 100_000, 0],
    ["Cash deposit — sales proceeds", 0, 1_300_000],
    ["Standing instruction — shop rent (Q3)", 60_000, 0],
    ["Fee transfer — education (instalment 2)", 150_000, 0],
    ["Cheque 100236 — stock purchases", 1_000_000, 0],
    ["Salary transfer — staff (Jan)", 40_000, 0],
    ["Utility bills — K-Electric / SSGC", 125_000, 0],
    ["Medical — hospital payment", 100_000, 0],
    ["Cash deposit — sales proceeds", 0, 1_200_000],
    ["Standing instruction — shop rent (Q4)", 60_000, 0],
    ["Cheque 100237 — stock purchases", 700_000, 0],
    ["Salary transfer — staff (Apr)", 40_000, 0],
    ["Utility bills — K-Electric / SSGC", 125_000, 0],
    ["IBFT credit — M/s Sunrise Enterprises", 0, 800_000],
    ["Household / family transfer", 100_000, 0],
  ];
  const totals = { sales: 0, cost: 0, businessExpenses: 0, personal: 0 };
  for (const [description, debit, credit] of rows) {
    const result = classify(description, { businessEnabled: true }, debit, credit);
    assert.equal(result.status, "SUGGESTED", `${description} -> ${JSON.stringify(result)}`);
    const amount = result.entryType === "INCOME" ? credit : debit;
    if (result.category === "BUSINESS_SALES") totals.sales += amount;
    else if (result.category === "BUSINESS_COST_OF_SALES") totals.cost += amount;
    else if (result.category === "BUSINESS_OPERATING_EXPENSE") totals.businessExpenses += amount;
    else totals.personal += amount;
  }
  assert.deepEqual(totals, {
    sales: 6_000_000,
    cost: 3_800_000,
    businessExpenses: 400_000,
    personal: 1_200_000,
  });
});
