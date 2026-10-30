#!/usr/bin/env node
/**
 * The Wealth "Bank Account" dialog: the agent must be able to READ what IRIS
 * resolved, and must wait long enough for FBR's IBAN lookup.
 *
 * Live evidence (30-Oct-2026, job cmvumoelk0013fciilvvzbaxd): the agent typed
 * the IBAN, pressed the search button, IRIS filled Account Title / Bank Name —
 * and the agent still reported "IRIS did not recognise this IBAN", closed the
 * dialog and added nothing. The operator then typed the same IBAN by hand and
 * the account came up. Cause: the reader looked only for
 * `input[placeholder="Account Title"]`, and IRIS paints those labels as
 * Material labels, so the input carries no placeholder at all.
 *
 * These tests pin the reader to the visible label and to the portal's own ADD
 * state, and pin the search to more than one attempt.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const driver = require(path.join(root, "electron-connect/iris-wealth-driver.js"));

/** Material-style bank dialog: labels on mat-label, no placeholder attributes. */
const MATERIAL_DIALOG = `
<html><body>
<mat-dialog-container id="dialog">
  <div mat-dialog-title><span class="left">Bank Account</span></div>
  <div class="mat-mdc-form-field">
    <mat-label>IBAN/Mobile Wallet No.</mat-label>
    <div class="mat-mdc-form-field-icon-suffix">
      <button type="button" aria-label="search"><mat-icon>search</mat-icon></button>
    </div>
    <input formcontrolname="iban" value="PK35HABB0018067900476803" />
  </div>
  <div class="mat-mdc-form-field">
    <mat-label>Account Title</mat-label>
    <input formcontrolname="title" value="NAWAZ TRADERS" disabled />
  </div>
  <div class="mat-mdc-form-field">
    <mat-label>Bank Name</mat-label>
    <input formcontrolname="bankName" value="HABIB BANK LIMITED" disabled />
  </div>
  <mat-dialog-actions>
    <button type="button">CLOSE</button>
    <button type="button">ADD</button>
  </mat-dialog-actions>
</mat-dialog-container>
</body></html>`;

/** The older shape the reader already handled: placeholder attributes present. */
const PLACEHOLDER_DIALOG = MATERIAL_DIALOG
  .replace('formcontrolname="iban"', 'placeholder="IBAN" formcontrolname="iban"')
  .replace('formcontrolname="title"', 'placeholder="Account Title" formcontrolname="title"')
  .replace('formcontrolname="bankName"', 'placeholder="Bank Name" formcontrolname="bankName"');

function readDialogState(html, { disableAdd = false } = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  if (disableAdd) {
    const add = [...dom.window.document.querySelectorAll("mat-dialog-actions button")].find(
      (button) => button.textContent.trim() === "ADD",
    );
    add.setAttribute("disabled", "");
  }
  const step = { op: "dialog_state", title: driver.DIALOG_TITLES.bank, cfg: driver.PAGE_CFG };
  const script = `(${driver.wealthPageOp.toString()})(${JSON.stringify(step)})`;
  return dom.window.eval(script);
}

test("the resolved Account Title and Bank Name are read even without placeholders", () => {
  const state = readDialogState(MATERIAL_DIALOG);
  assert.equal(state.status, "ok");
  assert.equal(state.accountTitle, "NAWAZ TRADERS");
  assert.equal(state.bankName, "HABIB BANK LIMITED");
  assert.equal(state.iban, "PK35HABB0018067900476803");
  assert.equal(state.addEnabled, true, "IRIS enables ADD once it resolved the IBAN");
});

test("the older placeholder dialog still reads the same way", () => {
  const state = readDialogState(PLACEHOLDER_DIALOG);
  assert.equal(state.accountTitle, "NAWAZ TRADERS");
  assert.equal(state.bankName, "HABIB BANK LIMITED");
});

test("an unresolved dialog reads empty and leaves ADD disabled", () => {
  const empty = MATERIAL_DIALOG
    .replace('value="NAWAZ TRADERS"', 'value=""')
    .replace('value="HABIB BANK LIMITED"', 'value=""');
  const state = readDialogState(empty, { disableAdd: true });
  assert.equal(state.accountTitle, "");
  assert.equal(state.bankName, "");
  assert.equal(state.addEnabled, false, "nothing resolved, nothing to add");
});

test("the driver treats the portal's own ADD state as proof the IBAN is known", () => {
  const source = fs.readFileSync(
    path.join(root, "electron-connect/iris-wealth-driver.js"),
    "utf8",
  );
  // The resolve condition must accept any of the three signals, not only a
  // title the reader happened to find.
  assert.match(
    source,
    /Boolean\(state\.accountTitle \|\| state\.bankName \|\| state\.addEnabled\)/,
  );
  // ...and it must search more than once before calling the IBAN unknown.
  assert.match(source, /searchAttempts = 3/);
  assert.match(source, /resolveMs = Math\.max\(timeoutMs, 20_000\)/);
  // The give-up message must not claim IRIS rejected the IBAN.
  assert.doesNotMatch(source, /IRIS did not return an account title for IBAN/);
  assert.match(source, /did not enable ADD for IBAN/);
});
