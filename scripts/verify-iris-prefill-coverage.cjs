"use strict";
/**
 * 28-Oct-2026, from the operator's live run (job cmvrne2d9005c60tpaujaivjr):
 *
 *   "IRIS already holds a figure that your packet does not cover: 3320 600,000"
 *
 * The figure was the packet's own: the Balance Sheet child row
 * "Bank Account - PK35HABB0018067900476803 - ... - Self" (3320) is created and
 * typed by the bank driver, matched its packet amount 600,000, and still came
 * back as uncovered because the pre-fill snapshot was compared with the codes of
 * ONE section at a time — and the bank row belongs to the detail driver, not to
 * the scalar group being filled.
 *
 * These tests pin the corrected rule:
 *   1. a code the packet promises ANYWHERE is never reported as uncovered;
 *   2. a row the packet really does not cover is still reported (the warning
 *      must keep working);
 *   3. IRIS's own computed summary row (read-only cell) is never reported;
 *   4. bank / vehicle / property / deduction detail rows count as promised;
 *   5. an empty or zero cell is not a "figure".
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const filler = require(path.join(__dirname, "..", "electron-connect", "iris-row-filler.js"));

const row = (code, description, cells) => ({ code, description, cells });

const cell = (value, editable = true) => ({ value, editable });

// The real Balance Sheet snapshot, reduced to what matters: IRIS's computed
// summary row (read-only) above the child row the bank driver created.
const balanceSheetSnapshot = () => [
  row("3349", "Total Assets", [cell("800,000", false)]),
  row("3301", "Land (Business)", [cell("")]),
  row("3320", "Bank Account", [cell("600,000", false)]),
  row(
    "3320",
    "Bank Account - PK35HABB0018067900476803 - NAWAZ TRADERS - HABIB BANK LIMITED - Self",
    [cell("600,000")],
  ),
  row("3303", "Plant / Machinery / Equipment / Furniture (including fittings)", [cell("")]),
  row("3315", "Stocks in trade / Stores / Spares", [cell("200,000")]),
];

const scalarGroups = [{ sectionId: "business_balance_sheet", fields: [{ irisCode: "3315" }, { irisCode: "3352" }] }];
const balanceDetails = { agentFields: [{ irisCode: "3320", kind: "bank" }] };

test("the promised set spans the whole packet, including the detail drivers", () => {
  const promised = filler.packetPromisedIrisCodes({
    groups: scalarGroups,
    balanceDetails,
    taxDeductions: { agentFields: [{ irisCode: "64150701" }] },
  });
  assert.deepEqual([...promised].sort(), ["3315", "3320", "3352", "64150701"]);
});

test("the operator's 3320 bank row is no longer called uncovered (section-only set reproduced the bug)", () => {
  const snapshot = balanceSheetSnapshot();
  // Before the fix the comparison used this section's codes only.
  const sectionOnly = filler.findUnexpectedPrefill(snapshot, ["3315", "3352"]);
  assert.ok(
    sectionOnly.some((entry) => entry.code === "3320"),
    "section-only comparison still flags the bank row — this is the reported bug",
  );
  // After the fix the packet as a whole is the promise.
  const promised = filler.packetPromisedIrisCodes({ groups: scalarGroups, balanceDetails });
  const unexpected = filler.findUnexpectedPrefill(snapshot, promised);
  assert.deepEqual(unexpected, []);
});

test("a figure the packet really does not cover is still reported", () => {
  const snapshot = balanceSheetSnapshot().concat([
    row("3304", "Motor Vehicle(s)", [cell("1,500,000")]),
    row("3302", "Building (Business)", [cell("2,000,000")]),
  ]);
  const promised = filler.packetPromisedIrisCodes({ groups: scalarGroups, balanceDetails });
  const unexpected = filler.findUnexpectedPrefill(snapshot, promised);
  assert.deepEqual(
    unexpected.map((entry) => [entry.code, entry.cells.map((c) => c.value)]),
    [
      ["3304", ["1,500,000"]],
      ["3302", ["2,000,000"]],
    ],
  );
});

test("IRIS's own read-only totals are never reported, whatever they hold", () => {
  const snapshot = [row("3349", "Total Assets", [cell("800,000", false)])];
  assert.deepEqual(filler.findUnexpectedPrefill(snapshot, new Set()), []);
});

test("empty cells and zero placeholders are not figures", () => {
  const snapshot = [
    row("3304", "Motor Vehicle(s)", [cell("")]),
    row("3302", "Building (Business)", [cell("0")]),
    row("3301", "Land (Business)", [cell("0.00")]),
    row("3312", "Advances / Deposits / Prepayments", [cell("   ")]),
  ];
  assert.deepEqual(filler.findUnexpectedPrefill(snapshot, new Set()), []);
});

test("a Set or an array of promised codes both work", () => {
  const snapshot = [row("3320", "Bank Account - PK35...", [cell("600,000")])];
  assert.deepEqual(filler.findUnexpectedPrefill(snapshot, new Set(["3320"])), []);
  assert.deepEqual(filler.findUnexpectedPrefill(snapshot, ["3320"]), []);
  assert.equal(filler.findUnexpectedPrefill(snapshot, []).length, 1);
});

test("the section loop compares against the whole packet, not its own fields", () => {
  const fs = require("node:fs");
  const main = fs.readFileSync(path.join(__dirname, "..", "electron-connect", "main.js"), "utf8");
  assert.match(main, /const packetPromisedCodes = irisRowFiller\.packetPromisedIrisCodes\(\{/);
  assert.match(main, /findUnexpectedPrefill\(\s*rowsSeen,\s*packetPromisedCodes,?\s*\)/);
  assert.ok(
    !/findUnexpectedPrefill\(\s*rowsSeen,\s*group\.fields\.map/.test(main),
    "the per-section comparison must not come back",
  );
});
