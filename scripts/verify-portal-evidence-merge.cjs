"use strict";

/**
 * Verifies that `scripts/portal-coverage-inventory.cjs`:
 *   1. Works cleanly with ZERO raw HTML files on disk (reading the permanent
 *      saved contract in `lib/tax/portal-row-evidence.ts`),
 *   2. Merges new HTML captures ADDITIVELY without deleting or downgrading
 *      already-proven Salary / Wealth (116) / Withholding codes, and
 *   3. Keeps `scripts/contracts/iris-core-rows-contract.json` aligned with
 *      `lib/tax/portal-row-evidence.ts`.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const inventoryScript = path.join(root, "scripts", "portal-coverage-inventory.cjs");
const {
  loadSavedEvidence,
  readRowCells,
  mergeEvidence,
  renderEvidenceFile,
} = require("./portal-coverage-inventory.cjs");
const { CORE_CONTRACT } = require("./lib/iris-core-dom-from-contract.cjs");

test("inventory CLI succeeds with zero raw HTML captures on disk and reports saved permanent rows", () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-empty-captures-"));
  try {
    const run = spawnSync(
      process.execPath,
      [inventoryScript, "--captures", emptyDir],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /saved contract:\s+\d+ permanent row ids/);
    assert.match(run.stdout, /rows proven:\s+\d+ distinct row ids verified/);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("--emit-evidence merges a single new HTML page without deleting existing Wealth or Salary codes", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-merge-evidence-"));
  try {
    const evidenceCopy = path.join(tmpDir, "portal-row-evidence.ts");
    const captureDir = path.join(tmpDir, "captures");
    fs.mkdirSync(captureDir, { recursive: true });
    fs.copyFileSync(
      path.join(root, "lib", "tax", "portal-row-evidence.ts"),
      evidenceCopy,
    );

    // Simulate adding ONE brand-new page capture (code 500312) while NO old
    // Wealth (7031/7032/7033) or Salary (1008/1009) HTML files exist on disk.
    fs.writeFileSync(
      path.join(captureDir, "new-other-sources.html"),
      `<div class="tableRows dataRow" id="500312"><div class="data-middle-child-wapper"><input type="text"><input type="text" disabled></div></div>`,
      "utf8",
    );

    const run = spawnSync(
      process.execPath,
      [
        inventoryScript,
        "--captures",
        captureDir,
        "--evidence",
        evidenceCopy,
        "--emit-evidence",
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const updated = loadSavedEvidence(evidenceCopy);
    assert.deepEqual(updated["1009"].writeableInputIndexes, [0, 2]);
    assert.deepEqual(updated["1008"].writeableInputIndexes, [0, 1, 2]);
    assert.deepEqual(updated["7031"].writeableInputIndexes, [0]);
    assert.deepEqual(updated["7032"].writeableInputIndexes, [0]);
    assert.deepEqual(updated["7033"].writeableInputIndexes, [0]);
    assert.deepEqual(updated["500312"].writeableInputIndexes, [0]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("core rows contract aligns with lib/tax/portal-row-evidence.ts", () => {
  const saved = loadSavedEvidence(path.join(root, "lib", "tax", "portal-row-evidence.ts"));
  for (const [sectionKey, section] of Object.entries(CORE_CONTRACT.sections)) {
    for (const row of section.rows) {
      // 7030 is modal-created (tracked in wealth-rows.ts) and duplicate summary/child
      // rows share an id where the union of writeable indexes matches saved evidence.
      if (row.id === "7030") continue;
      assert.ok(
        saved[row.id],
        `section ${sectionKey} row ${row.id} must exist in PORTAL_ROW_EVIDENCE`,
      );
      for (const idx of row.writeableInputIndexes) {
        assert.ok(
          saved[row.id].writeableInputIndexes.includes(idx),
          `section ${sectionKey} row ${row.id} index ${idx} must be proven writeable`,
        );
      }
    }
  }
});
