#!/usr/bin/env node
/**
 * Previous-return Phase 5b: the Section 116 reconciliation read-back and the
 * carried-forward asset-position check must stay read-only and must say which
 * side of a non-zero 703000 is short. Unit-tests the pure module, then checks
 * the agent/job-report wiring statically.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const {
  WEALTH_CODES,
  buildWealthReconciliationCheck,
  buildWealthCarryForwardCheck,
} = require(path.join(root, "electron-connect/wealth-reconciliation-check.js"));
const { parseIrisAmount } = require(
  path.join(root, "electron-connect/iris-tour-census.js"),
);

const read = (totals) =>
  buildWealthReconciliationCheck({ irisTotals: totals, parseAmount: parseIrisAmount });

test("phase 5b: code map matches IRIS 2.0 (703000/703001/703002/703003/7049/7099)", () => {
  assert.equal(WEALTH_CODES.unreconciled, "703000");
  assert.equal(WEALTH_CODES.current, "703001");
  assert.equal(WEALTH_CODES.previous, "703002");
  assert.equal(WEALTH_CODES.change, "703003");
  assert.equal(WEALTH_CODES.inflows, "7049");
  assert.equal(WEALTH_CODES.outflows, "7099");
  assert.equal(WEALTH_CODES.totalAssets, "7019");
  assert.equal(WEALTH_CODES.businessCapital, "7003");
});

test("phase 5b: zero unreconciled amount is reported as reconciled, with the equation", () => {
  const check = read({
    "703001": "23,280,220",
    "703002": "8,780,220",
    "703003": "14,500,000",
    "7049": "18,000,000",
    "7099": "3,500,000",
    "703000": "0",
  });
  assert.equal(check.status, "reconciled");
  assert.equal(check.unreconciled, 0);
  assert.equal(check.changeInAssets, 14500000);
  assert.equal(check.inflows, 18000000);
  assert.equal(check.outflows, 3500000);
  assert.match(check.message, /reconciles/);
  assert.match(check.message, /Unreconciled Amount \(703000\) is 0/);
});

test("phase 5b: a positive gap names the missing INFLOW side (the user's 14.5M case)", () => {
  const check = read({
    "703001": "23,280,220",
    "703002": "8,780,220",
    "703003": "14,500,000",
    "7049": "0",
    "7099": "0",
    "703000": "14,500,000",
  });
  assert.equal(check.status, "gap");
  assert.equal(check.gapSide, "missing_inflow");
  assert.match(check.message, /14,500,000/);
  assert.match(check.message, /an inflow is missing/);
  // The whole point: no plug, and the reason is spelled out.
  assert.match(check.message, /false declaration/);
  assert.match(check.message, /did not add or change any figure/);
});

test("phase 5b: a negative gap names the missing OUTFLOW side", () => {
  const check = read({
    "703001": "9,000,000",
    "703002": "8,780,220",
    "703003": "219,780",
    "7049": "3,000,000",
    "7099": "1,000,000",
    "703000": "1,780,220",
  });
  assert.equal(check.status, "gap");
  assert.equal(check.gapSide, "missing_outflow");
  assert.match(check.message, /an outflow is missing/);
});

test("phase 5b: 703000 not on the tour is 'not_seen', never a guess", () => {
  const check = read({ "703001": "23,280,220" });
  assert.equal(check.status, "not_seen");
  assert.equal(check.unreconciled, null);
  assert.match(check.message, /not seen on the final tour/);
});

test("phase 5a': IRIS carrying the approved position forward is confirmed, not retyped", () => {
  const carryForward = {
    previousReturnTaxYear: 2025,
    totalAssets: 23280220,
    totalLiabilities: 0,
    netAssets: 23280220,
    cashInHand: 280554,
    rows: [
      { code: "7006", description: "Investments", amount: 1119666, detail: false },
      { code: "7003", description: "Business Capital", amount: 14500000, detail: false },
    ],
  };
  const equal = buildWealthCarryForwardCheck({
    irisTotals: { "7019": "23,280,220", "7029": "0", "7003": "14,500,000" },
    parseAmount: parseIrisAmount,
    carryForward,
  });
  assert.equal(equal.status, "carried");
  assert.equal(equal.expectedAssets, 23280220);
  assert.equal(equal.irisAssets, 23280220);
  assert.match(equal.message, /carried the approved Tax Year 2025 position forward/);
  assert.match(equal.message, /Nothing was retyped/);

  const above = buildWealthCarryForwardCheck({
    irisTotals: { "7019": "25,000,000", "7029": "0" },
    parseAmount: parseIrisAmount,
    carryForward,
  });
  assert.equal(above.status, "carried");
  assert.match(above.message, /this year's additions/);
});

test("phase 5a': a SHORT carried position is flagged (returning-resident case)", () => {
  const check = buildWealthCarryForwardCheck({
    irisTotals: { "7019": "8,780,220", "7029": "0" },
    parseAmount: parseIrisAmount,
    carryForward: {
      previousReturnTaxYear: 2025,
      totalAssets: 23280220,
      rows: [{ code: "7003", description: "Business Capital", amount: 14500000, detail: false }],
    },
  });
  assert.equal(check.status, "short");
  assert.match(check.message, /14,500,000 LESS/);
  assert.match(check.message, /add whatever is missing by hand/);
  assert.match(check.message, /typed nothing over/);
});

test("phase 5a': no approved rows in the packet means no comparison at all", () => {
  const check = buildWealthCarryForwardCheck({
    irisTotals: { "7019": "8,780,220" },
    parseAmount: parseIrisAmount,
    carryForward: null,
  });
  assert.equal(check.status, "not_provided");
  const empty = buildWealthCarryForwardCheck({
    irisTotals: { "7019": "8,780,220" },
    parseAmount: parseIrisAmount,
    carryForward: { previousReturnTaxYear: 2025, totalAssets: 23280220, rows: [] },
  });
  assert.equal(empty.status, "not_provided");
});

test("phase 5a'/5b wiring: census reads the equation, agent reports both checks read-only", () => {
  const census = fs.readFileSync(
    path.join(root, "electron-connect/iris-tour-census.js"),
    "utf8",
  );
  assert.match(census, /"703003", "7049", "7099",/);

  const main = fs.readFileSync(path.join(root, "electron-connect/main.js"), "utf8");
  assert.match(main, /require\("\.\/wealth-reconciliation-check"\)/);
  const agentPkg = JSON.parse(
    fs.readFileSync(path.join(root, "electron-connect/package.json"), "utf8"),
  );
  assert.ok(
    agentPkg.build.files.includes("wealth-reconciliation-check.js"),
    "wealth-reconciliation-check.js must ship in the packaged agent",
  );
  assert.match(main, /wealthReconciliation\.buildWealthReconciliationCheck\(/);
  assert.match(main, /wealthReconciliation\.buildWealthCarryForwardCheck\(/);
  assert.match(main, /carryForward: snapshot\?\.wealthCarryForward \|\| null/);
  assert.match(main, /"wealth_reconciliation_reconciled"/);
  assert.match(main, /"wealth_reconciliation_gap"/);
  assert.match(main, /"wealth_carry_forward_short"/);
  // Both ride out in the job result and in the census file.
  assert.match(main, /wealthReconciliationCheck,\s+wealthCarryForwardCheck,/);
  assert.match(main, /wealthReconciliationCheck,\s*\n\s+wealthCarryForwardCheck,\s*\n\s+afterSave/);

  const report = fs.readFileSync(path.join(root, "electron-connect/job-report.js"), "utf8");
  assert.match(report, /function describeWealthReconciliation\(autofill\)/);
  assert.match(report, /WEALTH STATEMENT RECONCILIATION \(Section 116, read-only\)/);
  assert.match(report, /NOT RECONCILED: Unreconciled Amount \(703000\)/);
  assert.match(report, /Nothing was plugged/);
});

test("phase 5b job report: the gap line carries the amount, the side and no plug", () => {
  const { describeWealthReconciliation } = require(
    path.join(root, "electron-connect/job-report.js"),
  );
  const lines = describeWealthReconciliation({
    wealthReconciliationCheck: {
      status: "gap",
      unreconciled: 14500000,
      changeInAssets: 14500000,
      inflows: 0,
      outflows: 0,
      gapSide: "missing_inflow",
    },
    wealthCarryForwardCheck: {
      status: "short",
      irisAssets: 8780220,
      expectedAssets: 23280220,
      previousReturnTaxYear: 2025,
      rowCount: 15,
    },
  });
  const text = lines.join("\n");
  assert.match(text, /NOT RECONCILED: Unreconciled Amount \(703000\) is 14,500,000/);
  assert.match(text, /an INFLOW is missing/);
  assert.match(text, /Nothing was plugged/);
  assert.match(text, /CARRY-FORWARD SHORT/);
  assert.match(text, /TY2025/);
});

test("Phase 4 (Bug #3): Services / Salary+Services / Pension+Services scoped readback runs read-only Section 116 checks (703002, 703000, 7019)", () => {
  const main = fs.readFileSync(
    path.join(root, "electron-connect/main.js"),
    "utf8",
  );
  assert.match(main, /116 - Wealth Statement > Reconciliation of Net Assets/);
  assert.match(main, /116 - Wealth Statement > Personal Assets \/ Liabilities/);
  assert.match(
    main,
    /const wealthTour =\s*censusEnd \|\|\s*scopedServicesReadback\?\.wealthTotalsTour/,
  );
  assert.match(main, /if \(\s*wealthTour &&\s*previousWealthExpectation/);
  assert.match(main, /if \(\s*wealthTour &&\s*typeof wealthReconciliation/);

  const { collectTotals } = require(
    path.join(root, "electron-connect/iris-tour-census.js"),
  );
  const scopedSection116Tour = {
    complete: true,
    views: [
      {
        key: "116 - Wealth Statement > Personal Assets / Liabilities",
        headings: ["Description", "Code", "Amount"],
        rows: [
          { code: "7019", description: "Total Assets", cells: [{ value: "25,000,000" }] },
          { code: "7029", description: "Total Liabilities", cells: [{ value: "0" }] },
        ],
      },
      {
        key: "116 - Wealth Statement > Reconciliation of Net Assets",
        headings: ["Description", "Code", "Amount"],
        rows: [
          { code: "703001", description: "Net Assets Current Year", cells: [{ value: "25,000,000" }] },
          { code: "703002", description: "Net Assets Previous Year", cells: [{ value: "23,280,220" }] },
          { code: "703003", description: "Increase / (Decrease) in Assets", cells: [{ value: "1,719,780" }] },
          { code: "7049", description: "Total Inflows", cells: [{ value: "3,850,550" }] },
          { code: "7099", description: "Total Outflows", cells: [{ value: "2,130,770" }] },
          { code: "703000", description: "Unreconciled Amount", cells: [{ value: "0" }] },
        ],
      },
    ],
  };
  const irisTotals = collectTotals(scopedSection116Tour);
  assert.equal(parseIrisAmount(irisTotals["703002"]), 23280220);

  const reconciliation = buildWealthReconciliationCheck({
    irisTotals,
    parseAmount: parseIrisAmount,
  });
  assert.equal(reconciliation.status, "reconciled");
  assert.equal(reconciliation.unreconciled, 0);

  const carryForward = buildWealthCarryForwardCheck({
    irisTotals,
    parseAmount: parseIrisAmount,
    carryForward: {
      previousReturnTaxYear: 2025,
      totalAssets: 23280220,
      rows: [{ code: "7006", description: "Investments", amount: 23280220, detail: false }],
    },
  });
  assert.equal(carryForward.status, "carried");
});
