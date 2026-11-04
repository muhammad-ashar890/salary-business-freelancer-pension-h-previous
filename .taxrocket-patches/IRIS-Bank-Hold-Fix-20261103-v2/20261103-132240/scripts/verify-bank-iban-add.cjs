#!/usr/bin/env node
/**
 * Why the valid IBAN PK35HABB0018067900476803 was not added
 * (real run cmvs00v330025t9l3ye5pcqj8, 2026-10-28 10:58Z).
 *
 * In that run the agent opened the Bank Account dialog, could not find the IBAN
 * box in it, closed it and typed nothing. IRIS never rejected the IBAN. This
 * file pins the three things that had to change:
 *
 *   1. the IBAN box is found by label, formcontrolname, aria-label or name —
 *      not only by placeholder="IBAN";
 *   2. a box that really is not there is still reported honestly, in words that
 *      do not read like "IRIS refused the IBAN";
 *   3. when the row is already in IRIS (as it was here, with the right amount),
 *      the driver re-reads the table before failing, types into the row it holds
 *      and never adds a second 7030;
 *   4. the taxpayer is told to press Continue when the row is already there,
 *      instead of "IRIS did not let the agent add this row".
 *
 * The page operations run against a small JSDOM stand-in, so this file needs no
 * IRIS captures and runs anywhere.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const assert = require("node:assert/strict");
const test = require("node:test");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  module._compile(output, filename);
};

const driver = require("../electron-connect/iris-wealth-driver.js");
const report = require("../electron-connect/job-report.js");

const IBAN = "PK35HABB0018067900476803";
const BANK_TITLE = driver.DIALOG_TITLES.bank;

/** A Bank Account dialog whose IBAN box is built the way the test asks. */
function bankDialog(inputAttrs, extra = "") {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <mat-dialog-container>
        <h6><span class="left">${BANK_TITLE}</span></h6>
        <div class="mat-mdc-form-field">
          ${extra}
          <input ${inputAttrs}>
        </div>
        <mat-dialog-actions><button>CLOSE</button><button>ADD</button></mat-dialog-actions>
      </mat-dialog-container>
    </body></html>`,
    { runScripts: "outside-only" },
  );
  return dom.window;
}

function typeIban(window, step = {}) {
  const script = driver.buildPageScript({
    op: "dialog_set",
    title: BANK_TITLE,
    field: "iban",
    value: IBAN,
    ...step,
  });
  return window.eval(script);
}

// ── 1. the IBAN box is found however IRIS labels it ────────────────────────
test("the shipped markup (placeholder=\"IBAN\") still works", () => {
  const window = bankDialog('placeholder="IBAN"');
  const out = typeIban(window);
  assert.equal(out.status, "set");
  assert.equal(out.readback, IBAN);
});

test("the IBAN box is found when the label is only an aria-label", () => {
  const window = bankDialog('aria-label="IBAN"');
  const out = typeIban(window);
  assert.equal(out.status, "set", JSON.stringify(out));
  assert.equal(out.readback, IBAN);
});

test("the IBAN box is found when the label is only the formcontrolname", () => {
  const window = bankDialog('formcontrolname="ibanNumber"');
  const out = typeIban(window);
  assert.equal(out.status, "set", JSON.stringify(out));
  assert.equal(out.readback, IBAN);
});

test("the IBAN box is found when the label is only the mat-label text", () => {
  const window = bankDialog("", "<mat-label>IBAN / Account Number</mat-label>");
  const out = typeIban(window);
  assert.equal(out.status, "set", JSON.stringify(out));
  assert.equal(out.readback, IBAN);
});

test("a dialog with no IBAN box reports field_not_found, so the agent stops instead of guessing", () => {
  const window = bankDialog('formcontrolname="acct"');
  const out = typeIban(window);
  assert.equal(out.status, "field_not_found");
});

test("the IBAN box of another dialog is never used", () => {
  assert.throws(
    () =>
      driver.buildPageScript({
        op: "dialog_set",
        title: "Gift",
        field: "iban",
        value: IBAN,
      }),
    /may not be set here/,
    "an IBAN may only be typed in the Bank Account dialog",
  );
});

// ── 2. the driver reuses a row IRIS already holds ──────────────────────────
const source = fs.readFileSync(
  path.join(root, "electron-connect/iris-wealth-driver.js"),
  "utf8",
);

test("the 7030 table is read again before an account is called missing", () => {
  const settle = source.indexOf("Personal Assets is still painting");
  const missing = source.indexOf("const missing = plan.banks.filter(");
  assert.ok(settle > 0, "the re-read note is missing");
  assert.ok(
    settle < missing,
    "the re-read must happen before the missing list is built",
  );
});

test("a failed add falls back to the row IRIS does hold", () => {
  const note = source.indexOf('"bank_row_already_present"');
  assert.ok(note > 0, "the already-present fallback is missing");
  const failedBranch = source.indexOf(
    "failAll([field], WEALTH_STATUS.SETUP_FAILED, failed);",
    source.indexOf("const failed = await addBankAccount("),
  );
  assert.ok(note < failedBranch, "the fallback must run before the field fails");
  assert.match(
    source.slice(note, failedBranch),
    /continue;/,
    "the fallback must keep the field in the group that gets typed",
  );
});

test("the IBAN typing is retried while the dialog is still painting", () => {
  const retry = source.indexOf("const typed = await waitFor(");
  assert.ok(retry > 0, "the retry around the IBAN field is missing");
  const slice = source.slice(retry, retry + 700);
  assert.match(slice, /plainIban/);
  assert.match(slice, /field_not_found/);
});

// ── 3. the words the taxpayer reads ────────────────────────────────────────
function itemFor(setupStatus) {
  const built = report.buildAttentionReport([
    {
      irisCode: "7030",
      rowDescriptionIncludes: IBAN,
      value: 1002000,
      status: driver.WEALTH_STATUS.SETUP_FAILED,
      setupStatus,
    },
  ]);
  assert.equal(built.items.length, 1, JSON.stringify(built));
  return built.items[0];
}

test("a missing IBAN box is never reported as 'IRIS did not let the agent add this row'", () => {
  const item = itemFor("bank_iban_field_not_found");
  assert.doesNotMatch(item.what, /IRIS did not let the agent add this row/i);
  assert.match(item.what, /could not find the IBAN field/i);
  assert.match(item.what, /was not rejected/i);
  assert.match(item.lines[0].name, /PK35HABB0018067900476803/);
  assert.equal(item.lines[0].amount, "1,002,000");
});

test("the taxpayer is told to press Continue when the row is already in IRIS", () => {
  const item = itemFor("bank_iban_field_not_found");
  assert.match(item.todo, /already there/i);
  assert.match(item.todo, /press Continue/i);
});

test("any other wealth add failure offers the same 'already there' check", () => {
  const item = itemFor("assets_add_click_failed");
  assert.doesNotMatch(item.what, /IRIS did not let the agent add this row/i);
  assert.match(item.what, /could not finish adding this row/i);
  assert.match(item.todo, /already there/i);
  assert.match(item.todo, /press Continue/i);
});

test("the pause message carries the same instruction", () => {
  const { text } = report.buildAttentionMessage([
    {
      irisCode: "7030",
      rowDescriptionIncludes: IBAN,
      value: 1002000,
      status: driver.WEALTH_STATUS.SETUP_FAILED,
      setupStatus: "bank_iban_field_not_found",
    },
  ]);
  assert.match(text, /press Continue/i);
  assert.doesNotMatch(text, /IRIS did not let the agent add this row/i);
});
