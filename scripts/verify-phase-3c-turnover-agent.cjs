"use strict";
/**
 * Phase 3c (fix52): the Section 113 turnover row.
 *  - iris-turnover-driver.js against a page built with the structure of
 *    captures 54 / 57-61 (~/iris-business-captures):
 *      `.body.interface_21.active` with the navigation panels and the active
 *      left tab "Computations";
 *      one `.heading-bar` (Description | Code | Total Income | Subject to
 *      Final Tax | Subject to Exemption | Subject to Normal Tax);
 *      rows `.tableRows.dataRow[id]` with one `.data-middle-child-wapper`
 *      per column;
 *      row 999905 "Turnover Tax u/s 113" with button.btn-section-add
 *      "+ Turnover";
 *      the picker `mat-dialog-container > app-add-amount-code-row`
 *      ("Add Turnover Tax u/s 113", five `.source-card` cards in capture
 *      order, ADD disabled until a tick, Cancel);
 *      added rows E E E D right under 999905.
 *    What IRIS does with the typed turnover is [CHECK-LIVE].
 *  - iris-computations-driver.js: the turnover step runs first, with fake
 *    navigate / snapshot / fill / ensureTurnover.
 *  - the packet <-> agent contract (labels, codes, packet v6, build tags).
 * Synthetic data only.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { chromium } = require("playwright");

const root = path.join(__dirname, "..");
const turnoverDriver = require("../electron-connect/iris-turnover-driver.js");
const driver = require("../electron-connect/iris-computations-driver.js");

const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(this, request.startsWith("@/") ? path.join(root, request.slice(2)) : request, ...rest);
};
require.extensions[".ts"] = (m, file) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, resolveJsonModule: true },
    }).outputText,
    file,
  );
const minimum = require("../lib/tax/minimum-tax-113.ts");
const filing = require("../lib/tax/business-filing.ts");

const CARDS = [
  ["9012", "Turnover/Tax on Income of Cotton Ginners"],
  ["923152", "Turnover / Tax Chargeable u/s 113 @0.25%"],
  ["923168", "Turnover / Tax Chargeable u/s 113 @0.75%"],
  ["923206", "Turnover / Tax Chargeable u/s 113 @ 0.50%"],
  ["923161", "Turnover / Tax Chargeable u/s 113 @ 1.25%"],
];
const LABEL_125 = "Turnover / Tax Chargeable u/s 113 @ 1.25%";
const HEADINGS = ["Total Income", "Subject to Final Tax", "Subject to Exemption", "Subject to Normal Tax"];
const entry = (over = {}) => ({
  code: "923161",
  label: LABEL_125,
  action: "TYPE",
  value: 150_000_000,
  ratePercent: 1.25,
  minimumTax: 1_875_000,
  basis: "turnover 150,000,000 x 1.25% = minimum tax 1,875,000",
  message: "",
  ...over,
});

function page({ onTab = true, rows = {}, dialog = "", headings = HEADINGS, pickerOnly = [] } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<app-nitr-workflow><app-nitr-wf-body>
<div class="body interface_21 active"><div class="row">
<div class="col-md-3"><mat-accordion>
<mat-expansion-panel><mat-expansion-panel-header><mat-panel-title>Business</mat-panel-title></mat-expansion-panel-header><button class="data-tab-left-btn">Balance Sheet</button></mat-expansion-panel>
<mat-expansion-panel><mat-expansion-panel-header><mat-panel-title>Tax Chargeable / Payments</mat-panel-title></mat-expansion-panel-header>
<button class="data-tab-left-btn ${onTab ? "active" : ""}">Computations</button><button class="data-tab-left-btn ${onTab ? "" : "active"}">Withholding Tax</button></mat-expansion-panel>
</mat-accordion></div>
<div class="col-md-9"><div class="content h-padding-10 v-padding-10">
<div class="row heading-bar padding-10"><div class="col-lg-5"><strong>Description</strong></div><div class="col-lg-1"><strong>Code</strong></div><div class="col-lg-5">${headings.map((h) => `<div class="left"><strong>${h} </strong></div>`).join("")}</div></div>
<div class="h-padding-10" id="rows"></div>
</div></div></div></div>
</app-nitr-wf-body></app-nitr-workflow>
<div class="cdk-overlay-container" id="overlay">${dialog}</div>
<script>
window.clicks = [];
const CARDS = ${JSON.stringify(CARDS)};
const START = ${JSON.stringify(rows)};
const PICKER_ONLY = ${JSON.stringify(pickerOnly)};
document.addEventListener("click", (e) => {
  const t = e.target.closest("button, input[type=checkbox]");
  if (!t) return;
  window.clicks.push(t.matches("input[type=checkbox]") ? "tick:" + t.closest(".source-card").querySelector("p").textContent.trim() : t.textContent.replace(/\\s+/g, " ").trim());
}, true);
function cells(pattern, values) {
  return Array.from(pattern).map((c, i) => '<div class="left data-middle-child-wapper"><div><input class="data-middle-child amount-cell-input" type="text"' + (c === "D" ? " disabled" : "") + ' value="' + ((values && values[i]) || "") + '"/></div></div>').join("");
}
function row(id, label, pattern, values, extra) {
  return '<div class="row v-padding-5 tableRows dataRow" id="' + id + '"><div class="col-lg-5"><span class="row-description-text">' + label + ' </span></div><div class="col-lg-1">' + id + '</div><div class="col-lg-5 columns-parent">' + cells(pattern, values) + '</div><div class="col-lg-1">' + (extra || "") + "</div></div>";
}
function addTurnover(code, values) {
  const label = CARDS.find((c) => c[0] === code)[1];
  const holder = document.createElement("div");
  holder.innerHTML = row(code, label, "EEED", values, '<button class="btn-section-delete" type="button"><i class="fa fa-trash"></i></button>');
  document.getElementById("999905").after(holder.firstElementChild);
}
document.getElementById("rows").innerHTML =
  row("999905", "Turnover Tax u/s 113", "DDDD", [], '<button class="btn-section-add h-margin-5" type="button" onclick="openPicker()">+ Turnover</button>') +
  row("9231822", "Tax on High Earning Persons u/s 4C", "EDDD", []) +
  row("923184", "Surcharge on high earning person u/s 4AB", "EDDD", []) +
  row("923198", "Adjustment of Minimum Tax Paid u/s 113 in earlier Year(s)", "EEED", []);
for (const [code, values] of Object.entries(START)) addTurnover(code, values);
function openPicker() {
  const present = new Set(Array.from(document.querySelectorAll(".tableRows[id]")).map((r) => r.id).concat(PICKER_ONLY));
  const dlg = document.createElement("mat-dialog-container");
  dlg.setAttribute("role", "dialog");
  dlg.innerHTML = '<app-add-amount-code-row><h6 class="dialog-title"><span class="left v-padding-top-5">Add Turnover Tax u/s 113</span><span class="right pointer"><mat-icon class="mat-icon">close</mat-icon></span></h6><mat-dialog-content><input placeholder="Search Amount Code/Description" type="text"/>' +
    CARDS.map((c) => '<div class="source-card mb-2"><div class="checkbox-container"><mat-checkbox><input class="mdc-checkbox__native-control" type="checkbox"' + (present.has(c[0]) ? " checked disabled" : "") + ' data-code="' + c[0] + '"/></mat-checkbox></div><p class="mb-0">' + c[1] + " </p></div>").join("") +
    '</mat-dialog-content><mat-dialog-actions><button class="btn" type="button" disabled>ADD</button><button class="btn" type="button">Cancel</button></mat-dialog-actions></app-add-amount-code-row>';
  document.getElementById("overlay").appendChild(dlg);
  const [add, cancel] = dlg.querySelectorAll("mat-dialog-actions button");
  dlg.addEventListener("change", () => { add.disabled = !Array.from(dlg.querySelectorAll("input[type=checkbox]")).some((b) => b.checked && !b.disabled); });
  add.addEventListener("click", () => {
    for (const box of dlg.querySelectorAll("input[type=checkbox]")) if (box.checked && !box.disabled && !PICKER_ONLY.includes(box.dataset.code)) addTurnover(box.dataset.code, []);
    dlg.remove();
  });
  cancel.addEventListener("click", () => dlg.remove());
}
</script></body></html>`;
}
const OUR_PICKER_OPEN = `<mat-dialog-container role="dialog"><app-add-amount-code-row><h6><span class="left">Add Turnover Tax u/s 113</span><span class="right"><mat-icon class="mat-icon">close</mat-icon></span></h6><mat-dialog-actions><button class="btn" type="button" disabled>ADD</button><button class="btn" type="button" onclick="this.closest('mat-dialog-container').remove()">Cancel</button></mat-dialog-actions></app-add-amount-code-row></mat-dialog-container>`;
const OTHER_DIALOG = `<mat-dialog-container role="dialog"><div>Session expiring</div><button type="button">OK</button></mat-dialog-container>`;

let browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });

async function withPage(html, run) {
  const context = await browser.newContext();
  const pg = await context.newPage();
  await context.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
  await pg.goto("https://iris.fbr.gov.pk/nitr/workflow");
  const mainFrame = { get url() { return pg.url(); }, executeJavaScript: (source) => pg.evaluate(source) };
  mainFrame.framesInSubtree = [mainFrame];
  const win = { isDestroyed: () => false, webContents: { mainFrame, getURL: () => pg.url(), executeJavaScript: mainFrame.executeJavaScript } };
  try { await run(pg, win); } finally { await context.close(); }
}
const fast = { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 15))), settleMs: 20, attempts: 30 };
const clicks = (pg) => pg.evaluate(() => window.clicks);
const rowCodes = (pg) => pg.evaluate(() => Array.from(document.querySelectorAll(".tableRows[id]")).map((r) => r.id));
const FORBIDDEN = /Delete|Calculate|Save|Submit|PSID|OK/i;

test("entry check: only the four typed rates, with the captured row text", () => {
  assert.deepEqual(turnoverDriver.validateTurnoverEntry(entry()), []);
  assert.deepEqual(turnoverDriver.validateTurnoverEntry(entry({ label: "Turnover / Tax Chargeable u/s 113 @1.25%" })), ["label"]);
  assert.deepEqual(turnoverDriver.validateTurnoverEntry(entry({ code: "9012", label: CARDS[0][1] })), ["code"], "cotton ginners are never added");
  assert.deepEqual(turnoverDriver.validateTurnoverEntry(entry({ value: 0 })), ["value"]);
  assert.deepEqual(turnoverDriver.validateTurnoverEntry(entry({ action: "USER", value: 0, message: "" })), ["message"]);
  assert.deepEqual(turnoverDriver.TYPED_CODES, ["923152", "923206", "923168", "923161"]);
});

test("live: + Turnover, one tick, ADD - the 1.25% row appears right under 999905 (E E E D)", async () => {
  await withPage(page(), async (pg, win) => {
    const out = await turnoverDriver.ensureTurnoverRow(win, entry(), fast);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.added, true);
    assert.equal(out.reason, "row_added");
    assert.equal(out.row.code, "923161");
    assert.equal(out.row.description, LABEL_125);
    assert.equal(out.row.cells, "EEED");
    const seen = await clicks(pg);
    assert.deepEqual(seen, ["+ Turnover", `tick:${LABEL_125}`, "ADD"]);
    assert.ok(!seen.some((c) => FORBIDDEN.test(c)));
    assert.deepEqual((await rowCodes(pg)).slice(0, 2), ["999905", "923161"]);
  });
});

test("live: the planned row already there is reused without a click", async () => {
  await withPage(page({ rows: { "923161": ["", "", "", ""] } }), async (pg, win) => {
    const out = await turnoverDriver.ensureTurnoverRow(win, entry(), fast);
    assert.equal(out.ok, true);
    assert.equal(out.added, false);
    assert.equal(out.reason, "row_already_present");
    assert.deepEqual(await clicks(pg), []);
  });
});

test("live: a turnover row at another rate stops the step (no second rate, no click)", async () => {
  await withPage(page({ rows: { "923152": ["5000000", "", "", "5000000"] } }), async (pg, win) => {
    const out = await turnoverDriver.ensureTurnoverRow(win, entry(), fast);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "other_turnover_row_present");
    assert.match(out.message, /923152/);
    assert.match(out.message, /does not add a second rate/);
    assert.deepEqual(await clicks(pg), []);
  });
});

test("live: our own picker left open is closed with Cancel first", async () => {
  await withPage(page({ dialog: OUR_PICKER_OPEN }), async (pg, win) => {
    const out = await turnoverDriver.ensureTurnoverRow(win, entry(), fast);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(await clicks(pg), ["Cancel", "+ Turnover", `tick:${LABEL_125}`, "ADD"]);
  });
});

test("live: any other open dialog, a different tab or other headings: nothing is clicked", async () => {
  await withPage(page({ dialog: OTHER_DIALOG }), async (pg, win) => {
    const out = await turnoverDriver.ensureTurnoverRow(win, entry(), fast);
    assert.equal(out.reason, "dialog_open");
    assert.deepEqual(await clicks(pg), []);
  });
  await withPage(page({ onTab: false }), async (pg, win) => {
    const out = await turnoverDriver.ensureTurnoverRow(win, entry(), fast);
    assert.match(out.reason, /^structure_unverified \(.*not_on_computations/);
    assert.deepEqual(await clicks(pg), []);
  });
  await withPage(page({ headings: ["Total Income", "Subject to Normal Tax"] }), async (pg, win) => {
    const out = await turnoverDriver.ensureTurnoverRow(win, entry(), fast);
    assert.match(out.reason, /^structure_unverified \(.*headings/);
    assert.match(out.message, /type 150,000,000 in Total Income yourself/);
    assert.deepEqual(await clicks(pg), []);
  });
});

test("live: the picker says the row exists but the tab has none - Cancel, then stop", async () => {
  await withPage(page({ pickerOnly: ["923161"] }), async (pg, win) => {
    const out = await turnoverDriver.ensureTurnoverRow(win, entry(), fast);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "picker_says_row_present_but_not_on_tab");
    assert.deepEqual(await clicks(pg), ["+ Turnover", "Cancel"]);
  });
});

test("a USER entry is never clicked; its message is passed on", async () => {
  const out = await turnoverDriver.ensureTurnoverRow({}, entry({ action: "USER", value: 0, message: "type it yourself" }), fast);
  assert.deepEqual([out.ok, out.reason, out.message], [false, "not_planned", "type it yourself"]);
});

// ------------------------------------------------ the computations driver
const plan = (over = {}) => ({
  version: "computations-v1",
  expectedTaxableIncome: 3_000_000,
  expectedNormalTax: 590_000,
  expectedBusinessIncome: 3_000_000,
  surcharge: { code: "923184", label: "Surcharge on high earning person u/s 4AB", action: "NONE", value: 0, ratePercent: 10, basis: "Taxable Income (9100) is PKR 10 million or less: no surcharge", message: "" },
  superTax: { code: "9231822", label: "Tax on High Earning Persons u/s 4C", action: "NONE", value: 0, ratePercent: 0, basis: "income for super tax is PKR 150 million or less (0%)", message: "" },
  turnover: entry(),
  minimumTaxRegime: "minimum",
  ...over,
});
const cell = (value, editable = false) => ({ value, editable });
const irisRows = (turnoverValue = "150,000,000") => [
  { code: "3000", description: "Income / (Loss) from Business", cells: [cell("3,000,000"), cell("0"), cell("0"), cell("3,000,000")] },
  { code: "9000", description: "Total Income", cells: [cell("3,000,000"), cell("0"), cell("0"), cell("3,000,000")] },
  { code: "9100", description: "Taxable Income", cells: [cell(""), cell(""), cell(""), cell("3,000,000")] },
  { code: "920000", description: "Normal Tax", cells: [cell(""), cell(""), cell(""), cell("590,000")] },
  { code: "923161", description: LABEL_125, cells: [cell(turnoverValue, true), cell("", true), cell("", true), cell(turnoverValue)] },
  { code: "9231822", description: "Tax on High Earning Persons u/s 4C", cells: [cell("", true), cell(""), cell(""), cell("")] },
  { code: "923184", description: "Surcharge on high earning person u/s 4AB", cells: [cell("", true), cell(""), cell(""), cell("")] },
];
function harness({ ensure = { ok: true, reason: "row_added", added: true, row: { code: "923161", description: LABEL_125, cells: "EEED", values: ["", "", "", ""] } }, fillStatus = "filled", navigateOk = true } = {}) {
  const calls = { order: [], fill: [], ensure: [] };
  return {
    calls,
    options: {
      mode: "live",
      taxYear: 2026,
      taxpayerIdentifier: "0000000000000",
      sleep: async () => {},
      navigate: async () => { calls.order.push("navigate"); return navigateOk ? { ok: true, status: "switched" } : { ok: false, status: "tab_not_found" }; },
      ensureTurnover: async (_w, e) => { calls.order.push("ensure"); calls.ensure.push(e); return ensure; },
      snapshot: async () => { calls.order.push("snapshot"); return irisRows(); },
      fill: async (_w, fields, options) => {
        calls.order.push("fill");
        calls.fill.push({ fields, options });
        return { results: fields.map((f) => ({ key: f.key, irisCode: f.irisCode, status: fillStatus, readback: f.value })) };
      },
    },
  };
}

test("driver: the turnover row is added and typed first, then IRIS's figures are read", async () => {
  const h = harness();
  const out = await driver.fillComputations({}, plan(), h.options);
  assert.deepEqual(h.calls.order.slice(0, 4), ["navigate", "ensure", "fill", "snapshot"]);
  assert.deepEqual(h.calls.fill[0].fields, [
    { key: "computations:923161", irisCode: "923161", label: LABEL_125, column: "Total Income", value: "150000000" },
  ]);
  assert.equal(h.calls.fill.length, 1, "nothing else is typed (no surcharge / super tax due)");
  const typed = out.results.find((r) => r.irisCode === "923161");
  assert.equal(typed.key, "computations:923161:0");
  assert.equal(typed.status, "filled");
  assert.equal(typed.censusView, "Tax Chargeable / Payments > Computations");
  assert.equal(typed.rowDescription, LABEL_125);
  assert.equal(out.ok, true);
  assert.equal(out.reason, "typed");
  assert.deepEqual(out.decisions[0], { code: "923161", decision: "type", reason: "row_added" });
  assert.equal(out.turnover.added, true);
  assert.match(driver.describeComputationsOutcome(out), /turnover row 923161 added through "\+ Turnover"/);
});

test("driver: the same turnover already typed counts as correct; a different one is never overwritten", async () => {
  const same = harness({ ensure: { ok: true, reason: "row_already_present", added: false, row: { code: "923161", description: LABEL_125, cells: "EEED", values: ["150,000,000", "", "", "150,000,000"] } } });
  const a = await driver.fillComputations({}, plan(), same.options);
  assert.equal(same.calls.fill.length, 0);
  assert.equal(a.results.find((r) => r.irisCode === "923161").status, "already_correct");
  assert.equal(a.ok, true);
  const other = harness({ ensure: { ok: true, reason: "row_already_present", added: false, row: { code: "923161", description: LABEL_125, cells: "EEED", values: ["90,000,000", "", "", "90,000,000"] } } });
  const b = await driver.fillComputations({}, plan(), other.options);
  assert.equal(other.calls.fill.length, 0);
  assert.equal(b.ok, false);
  assert.match(b.messages[0], /already holds Rs 90,000,000/);
  assert.match(b.messages[0], /does not overwrite/);
});

test("driver: a failed + Turnover step leaves a message and the surcharge / super tax checks still run", async () => {
  const h = harness({ ensure: { ok: false, reason: "other_turnover_row_present", added: false, row: null, message: "IRIS already has another rate" } });
  const out = await driver.fillComputations({}, plan(), h.options);
  assert.equal(h.calls.fill.length, 0);
  assert.ok(h.calls.order.includes("snapshot"));
  assert.deepEqual(out.messages, ["IRIS already has another rate"]);
  assert.equal(out.reason, "left_for_taxpayer");
  assert.equal(out.decisions[0].decision, "tell_user");
});

test("driver: a USER turnover plan only shows its message; dry runs and a lost tab", async () => {
  const user = harness();
  const out = await driver.fillComputations({}, plan({ turnover: entry({ action: "USER", value: 0, message: "Please add the turnover row yourself." }) }), user.options);
  assert.equal(user.calls.ensure.length, 0);
  assert.ok(out.messages.includes("Please add the turnover row yourself."));
  const dry = await driver.fillComputations({}, plan(), { ...harness().options, mode: "dry" });
  assert.equal(dry.reason, "dry_run_nothing_clicked");
  assert.equal(dry.planned, 1);
  const lost = harness({ navigateOk: false });
  const gone = await driver.fillComputations({}, plan(), lost.options);
  assert.equal(lost.calls.ensure.length, 0);
  assert.match(gone.messages[0], /press "\+ Turnover" on the Computations tab, tick "Turnover \/ Tax Chargeable u\/s 113 @ 1.25%" and type Rs 150,000,000/);
});

test("driver: a plan with a wrong turnover row is refused as a whole", () => {
  assert.deepEqual(driver.validatePlan(plan()), []);
  assert.ok(driver.validatePlan(plan({ turnover: entry({ code: "9012", label: CARDS[0][1] }) })).includes("turnover_code"));
  assert.ok(driver.validatePlan(plan({ turnover: entry({ label: "x" }) })).includes("turnover_label"));
  const noTurnover = plan();
  delete noTurnover.turnover;
  assert.deepEqual(driver.validatePlan(noTurnover), [], "3b plans without a turnover row stay valid");
});

test("contract: the packet's row codes and labels are exactly the agent's (all four rates); packet v6", () => {
  for (const category of minimum.MINIMUM_TAX_CATEGORIES.filter((c) => c.ratePercent !== null))
    assert.equal(turnoverDriver.SPEC.rows[category.irisCode], category.irisPickerLabel, category.id);
  const p = JSON.parse(JSON.stringify(filing.buildBusinessPacket({
    taxYear: 2026,
    filerType: "myself",
    incomeSources: ["business"],
    selections: [{ source: "business", subcategory: "profit-return", detailsJson: JSON.stringify({ userDetails: { businessGrossSales: 150_000_000, businessSalesExcludeIndirectTax: true, businessMinimumTaxCategory: "rice_mill_dealer" } }) }],
  })));
  assert.equal(p.version, "business-entry-v6");
  const c = p.expectedIrisTotals.computations;
  assert.deepEqual(driver.validatePlan(c), [], JSON.stringify(c.turnover));
  assert.equal(c.turnover.code, "923152");
  assert.equal(c.turnover.value, 150_000_000);
});

test("source contract: clicks only inside the page probe; main.js, build tags and the packaged file list agree", () => {
  const computations = fs.readFileSync(path.join(root, "electron-connect/iris-computations-driver.js"), "utf8");
  assert.doesNotMatch(computations, /\.click\(/, "the computations driver itself never clicks");
  const src = fs.readFileSync(path.join(root, "electron-connect/iris-turnover-driver.js"), "utf8");
  const probe = turnoverDriver.turnoverProbe.toString();
  assert.equal((src.match(/\.click\(/g) || []).length, (probe.match(/\.click\(/g) || []).length, "every click is inside turnoverProbe");
  assert.doesNotMatch(probe, /btn-section-delete|Calculate|PSID|Submit|Save/, "the probe never touches delete / Calculate / PSID / Save / Submit");
  assert.equal(turnoverDriver.BUILD_TAG, "services-picker-aliases-20261105d");
  assert.equal(driver.BUILD_TAG, "services-picker-aliases-20261105d");
  const main = fs.readFileSync(path.join(root, "electron-connect/main.js"), "utf8");
  assert.match(main, /const AGENT_BUILD_TAG = "services-picker-aliases-20261105d"/);
  assert.match(main, /const irisTurnoverDriver = require\("\.\/iris-turnover-driver"\)/);
  assert.match(main, /\["iris-turnover-driver\.js", irisTurnoverDriver\.BUILD_TAG\]/);
  assert.match(main, /snapshot\.business\?\.version !== "business-entry-v6"/);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "electron-connect/package.json"), "utf8"));
  assert.ok(pkg.build.files.includes("iris-turnover-driver.js"), "the new driver ships in the packaged agent");
  for (const file of fs.readdirSync(path.join(root, "electron-connect")).filter((f) => /^iris-.*\.js$/.test(f))) {
    const text = fs.readFileSync(path.join(root, "electron-connect", file), "utf8");
    const tag = /const BUILD_TAG = "([^"]+)"/.exec(text);
    if (tag) assert.equal(tag[1], "services-picker-aliases-20261105d", `${file} build tag`);
  }
});
