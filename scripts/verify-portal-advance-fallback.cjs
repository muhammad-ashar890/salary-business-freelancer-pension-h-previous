#!/usr/bin/env node
/**
 * "Start Return Filling" — the setup advance that the hit-test called
 * unreachable.
 *
 * Live evidence (30-Oct-2026, job cmvun5e5f001411nddet19h62): the agent
 * answered Income from Salary + Resident, then stopped with
 * `economic_transactions_start — Start Return Filling: not_interactable`.
 * The diagnostics were explicit:
 *   bounds         top 901, bottom 941
 *   viewport       height 831
 *   visibleBounds  height -70
 *   reason         outside_visible_area
 * i.e. the button was painted BELOW the return frame's visible slice; the frame
 * document does not scroll on its own, so scrollIntoView moved nothing and the
 * hit-test never reached the button. The operator could see and press it,
 * because the outer window scrolls.
 *
 * Two things are pinned here:
 *   1. the agent now scrolls every scrollable ancestor and the document before
 *      declaring a target unreachable;
 *   2. if that still leaves the button outside the visible slice, a DOM click is
 *      allowed for this one allowlisted advance - and for nothing else.
 *
 * The live path itself needs IRIS, like every other navigation suite on this
 * machine, so this file pins the shipped code and the captured page.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(
  path.join(root, "electron-connect/iris-navigation.js"),
  "utf8",
);

test("a target outside the visible slice is scrolled into view before it is called unreachable", () => {
  assert.match(
    source,
    /const measure = \(\) => \{\n\s*const rect = el\.getBoundingClientRect\(\);/,
    "the visible area is measured in one place so it can be re-measured",
  );
  assert.match(source, /interaction\.scrollMode = "ancestors";/);
  assert.match(source, /node\.scrollTop \+=/, "scrollable ancestors are scrolled");
  assert.match(source, /scroller\.scrollTop \+= delta;/);
  // The measurement is taken again after scrolling, not before.
  const block = source.slice(
    source.indexOf('if (area.width < 2 || area.height < 2) {'),
  );
  const retry = block.slice(0, block.indexOf("interaction.reason"));
  assert.match(retry, /node\.scrollTop \+=/);
  assert.match(retry, /\(\{ rect, area \} = measure\(\)\);/);
});

test("the DOM click fallback covers exactly two allowlisted advances", () => {
  const block = source.slice(source.indexOf("const advanceClickFallback"));
  const condition = block.slice(0, block.indexOf("if (!hitTestPassed"));
  // One: the setup dialog's own backdrop over Continue (pre-existing rule).
  assert.match(condition, /setupAdvanceAction && interaction\?\.reason === "obstructed"/);
  // Two: this page's action bar below the frame.
  assert.match(
    condition,
    /options\.action === "economic-transactions-start" &&\s*interaction\?\.reason === "outside_visible_area"/,
  );
  // Nothing else: exactly two clauses, joined by one "||".
  assert.equal(condition.split("||").length, 2);
  assert.doesNotMatch(condition, /pointer_events_none|disabled|not_visible/);
});

test("the refusal is unchanged where the fallback does not apply", () => {
  assert.match(source, /if \(!hitTestPassed && !advanceClickFallback\)\s*actionResult\.status = "not_interactable";/);
  // The narrow allowance must not leak into the other allowlisted actions.
  const block = source.slice(source.indexOf("const advanceClickFallback"));
  const condition = block.slice(0, block.indexOf("if (!hitTestPassed"));
  for (const action of [
    "new-return-form",
    "new-return-category",
    "economic-transactions-setup",
    "salary-tab",
    "section-panel",
    "data-tab",
    "declaration-hover",
  ]) {
    assert.ok(
      !condition.includes(action),
      `${action} must still need a real hit-test`,
    );
  }
});

test("a page that is still painting is re-read and pressed again, not a stop", () => {
  // Live 30-Oct-2026, job cmvunoa4i001dc3eau9s1bvo0: the residency answer made
  // IRIS re-render; the probe landed inside the re-render, the frame came back
  // "frame_navigating" with no gate, and the action reported "not_found" even
  // though the saved snapshot of that same stop holds the enabled button.
  const block = source.slice(
    source.indexOf('const START_RETRY = Object.freeze(['),
  );
  assert.ok(block, "the start action has no retry list");
  const retryList = block.slice(0, block.indexOf("]);") + 3);
  for (const status of [
    "not_found",
    "page_busy",
    "not_interactable",
    "document_not_open",
  ]) {
    assert.match(retryList, new RegExp(`"${status}"`));
  }
  assert.match(block.slice(0, 2000), /startAttempt < 6/);
  assert.match(block.slice(0, 2000), /await delay\(1200\)/);
  // A real refusal still stops the run: the retry list is the only tolerance.
  assert.match(block.slice(0, 2500), /if \(!START_RETRY\.includes\(startStatus\)\) break;/);
});

test("the gate is given time to finish painting before it is read or pressed", () => {
  assert.match(source, /const settleGate = async \(attempts = 8, gapMs = 800\)/);
  // Settled once on entry...
  const entry = source.slice(source.indexOf("const settleGate"));
  assert.match(entry.slice(0, 900), /await settleGate\(\);/);
  // ...and again immediately before every press.
  const press = source.slice(source.indexOf("const START_RETRY"));
  assert.match(press.slice(0, 900), /await settleGate\(4, 700\);/);
});

test("the captured page that produced the stop is kept as the contract", () => {
  const {
    renderEconomicTransactionsGate,
  } = require("./lib/iris-bank-and-econ-dom-from-contract.cjs");
  const html = renderEconomicTransactionsGate();
  const dom = new JSDOM(html);
  const buttons = [...dom.window.document.querySelectorAll("button")].filter(
    (button) => /start return filling/i.test(button.textContent || ""),
  );
  assert.equal(buttons.length, 1, "one Start Return Filling button");
  assert.equal(
    buttons[0].disabled,
    false,
    "the portal had already enabled it - the stop was layout, not readiness",
  );
  assert.match(buttons[0].className, /btn-start/);
});
