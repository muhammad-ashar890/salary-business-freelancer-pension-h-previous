#!/usr/bin/env node
/**
 * "Tax payable 0" on the History card.
 *
 * Filing 4 (28-Oct, Salary) is approved with tax payable 0 while 162,000 was
 * deducted under section 149. That is CORRECT arithmetic — the tax on the income
 * is 162,000 and the employer already paid it, so nothing further is due — but
 * the card showed only the 0, which reads like a bug. It now shows the withheld
 * amount beside it.
 *
 * Nothing here changes the tax: the draft's payable stays exactly what the
 * engine computed.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");

const root = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(root, "app/tax/history/page.tsx"), "utf8");
const list = fs.readFileSync(
  path.join(root, "components/tax/filing-history-list.tsx"),
  "utf8",
);

test("the History card is given the withheld figure", () => {
  assert.match(page, /taxWithheld: toMoneyNumber\(draft\.taxWithheld\)/);
  assert.match(list, /taxWithheld\?: number \| null/);
});

test("a non-zero withheld amount is shown next to the payable", () => {
  const at = list.indexOf("Already deducted at source");
  assert.ok(at > 0, "the withheld line is missing from the card");
  const block = list.slice(at - 400, at + 200);
  assert.match(block, /taxWithheld > 0/, "the line must only appear when something was withheld");
  assert.match(block, /toLocaleString\(\)/, "the amount must be printed");
});

test("nothing about the tax itself changes: the payable is still the engine's", () => {
  assert.match(page, /useLegacy|toMoneyNumber\(packet\.taxPayable\)/);
  assert.doesNotMatch(list, /taxPayable\s*[-+*/]=/, "the card must not re-compute tax");
  assert.doesNotMatch(page, /taxWithheld\s*[-+*/]\s*/, "the page must not re-compute tax");
});
