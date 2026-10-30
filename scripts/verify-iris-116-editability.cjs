#!/usr/bin/env node
/**
 * Locks in the operator-confirmed IRIS 116 row classes (live check 27 Oct 2026,
 * see docs/IRIS-116-editable-rows.md).
 *
 * Why a test: the agent types into IRIS rows by code. If a code is mistakenly
 * believed typeable, the agent fights a computed cell; if a typeable one is
 * believed modal, a value is silently skipped. The generated capture evidence
 * (lib/tax/portal-row-evidence.ts) is the primary source, and this test keeps
 * the hand-verified matrix from drifting away from it.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const doc = fs.readFileSync(
  path.join(root, "docs/IRIS-116-editable-rows.md"),
  "utf8",
);
const evidenceSource = fs.readFileSync(
  path.join(root, "lib/tax/portal-row-evidence.ts"),
  "utf8",
);

// Operator-verified classes.
const DIRECT = ["7010", "7012", "703002", "7031", "7032", "7033", "7088"];
const MODAL = [
  "7006", "7008", "7013", "7014", "7021", "700302",
  "7034", "7035", "7036", "7037", "7089", "7091", "7098",
];
const COMPUTED = [
  "7003", "7019", "7029", "703001", "703003",
  "7049", "7099", "703000",
];

const evidenceFor = (code) => {
  const match = evidenceSource.match(
    new RegExp(`"${code}": \\{ writeableInputIndexes: \\[([^\\]]*)\\]`),
  );
  return match ? match[1].trim() : null;
};

test("the verified matrix is written down, class by class", () => {
  for (const code of DIRECT) assert.match(doc, new RegExp(code));
  for (const code of MODAL) assert.match(doc, new RegExp(code));
  for (const code of COMPUTED) assert.match(doc, new RegExp(code));
  assert.match(doc, /27 October 2026/);
  assert.match(doc, /7010 \| \*\*Household Effects\*\* \| \*\*DIRECT\*\*/);
});

test("COMPUTED rows are the disabled rows in the capture evidence", () => {
  for (const code of COMPUTED) {
    // 7003 is captured as disabled too; the rest must agree exactly.
    const captured = evidenceFor(code);
    if (captured === null) continue;
    assert.equal(
      captured,
      "",
      `${code} is verified COMPUTED but the capture shows writeable indexes [${captured}]`,
    );
  }
});

test("DIRECT rows the captures know about are writeable there", () => {
  for (const code of ["7012", "703002", "7031", "7032", "7033", "7088"]) {
    assert.notEqual(
      evidenceFor(code),
      null,
      `${code} is verified DIRECT but missing from the capture evidence`,
    );
    assert.notEqual(
      evidenceFor(code),
      "",
      `${code} is verified DIRECT but the capture marks it disabled`,
    );
  }
});

test("703002 is documented as typeable-but-restored: no Phase 5c", () => {
  assert.match(doc, /DIRECT but restored/);
  assert.match(doc, /IRIS rewrites its own figure on CALCULATE/);
  assert.match(doc, /the opening cannot be changed from inside the return/);
  assert.match(doc, /no Phase 5c/);
});

test("7010 is the documented exception: DIRECT but never captured", () => {
  assert.equal(evidenceFor("7010"), null);
  assert.match(doc, /has no entry for `7010`/);
  assert.match(doc, /rely on this document, not on `PORTAL_WRITEABLE_CODES`/);
});

test("the agent never targets a COMPUTED row and never writes 703002", () => {
  const packetMap = fs.readFileSync(
    path.join(root, "lib/tax/portal-field-map.ts"),
    "utf8",
  );
  // Wealth rows the packet carries are either DIRECT, modal-created children
  // (7030/7066-7087/7098) or the two gift rows; never a computed total.
  for (const code of ["7019", "7029", "703001", "703003", "7049", "7099", "703000"]) {
    assert.doesNotMatch(
      packetMap,
      new RegExp(`irisCode: "${code}"`),
      `${code} is computed by IRIS and must not be a packet field`,
    );
  }
  const main = fs.readFileSync(path.join(root, "electron-connect/main.js"), "utf8");
  // 703002 is only compared (read-back), never a field to fill.
  assert.match(main, /code: "703002",\s+expected,/);
});
