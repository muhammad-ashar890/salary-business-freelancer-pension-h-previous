"use strict";
/**
 * DP-3 (fix50): the business Tax Deduction driver against a page built with
 * the structure of captures 10 / 34 / 56 / 66 / 67 (~/iris-business-captures):
 * top tab titles; `.body.interface_21.active`; navigation panels
 * (`mat-expansion-panel` with `button.data-tab-left-btn`: Business ... "Tax
 * Deduction", "Balance Sheet"; Tax Chargeable / Payments); three grid panels
 * "Adjustable Tax" / "Final Tax" / "Minimum Tax" that can be collapsed, each
 * with one `.heading-bar` (Description | Code | value columns), a header row
 * 999913 / 999915 / 999914 (disabled cells, `button.btn-section-add`
 * "+ Section") and section rows `.tableRows.dataRow[id]` with one
 * `.data-middle-child-wapper` per value column; pickers
 * `mat-dialog-container > app-add-amount-code-row` titled "Add Adjustable Tax"
 * / "Add Minimum Tax" (`h6 .left` + close icon), `.source-card` (`p` name +
 * checkbox; checked + disabled = present), search box, ADD (disabled until a
 * tick) and Cancel. IRIS reactions (computing Tax Deducted, reverting a
 * figure) are [CHECK-LIVE]; each guard is exercised. Synthetic data only.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const driver = require("../electron-connect/iris-tax-deduction-driver.js");
const census = require("../electron-connect/iris-tour-census.js");

const ADJ = { code: "64060116", label: "Payment for Services u/s 153(1)(b) @8% u/c (42) of Part IV of Second Schedule" };
const ADJ_OTHER = { code: "64151305", label: "Purchase of Goods by Distributors, Dealers & Wholesalers u/s 236G @0.1%" };
const MIN_GOODS = { code: "64060052", label: "Payment for Goods u/s 153(1)(a) @1%" };
const MIN_IMPORT = { code: "64010052", label: "Import u/s 148 @1%" };
const MIN_OTHER = { code: "64060051", label: "Payment for Goods u/s 153(1)(a) @5%" };
const CATALOG = {
  adjustable: [ADJ_OTHER, ADJ].map((s) => ({ ...s, cells: "EE" })),
  final: [{ code: "64060285", label: "Export of services u/s 154A @1%", cells: "EED" }],
  minimum: [
    { ...MIN_IMPORT, cells: "EEDEDD" },
    { ...MIN_OTHER, cells: "EEDDDD" },
    { ...MIN_GOODS, cells: "EEDDDD" },
  ],
};
const HEADERS = {
  adjustable: ["Taxable Amount", "Tax Deducted"],
  final: ["Taxable Amount", "Tax Deducted", "Tax Chargeable"],
  minimum: ["Taxable Amount", "Tax Collected / Deducted", "Tax Chargeable", "Attributable Taxable Income", "Tax on Attributable Taxable Income", "Difference of Minimum Tax Chargeable"],
};
const TITLES = { adjustable: "Adjustable Tax", final: "Final Tax", minimum: "Minimum Tax" };
const HEADER_ROWS = { adjustable: "999913", final: "999915", minimum: "999914" };

// Same shape as lib/tax/business-tax-deductions.ts buildTaxDeductionsPlan().agentFields.
const field = (regime, section, values) => ({
  key: `${section.code}:taxDeduction`,
  regime,
  irisCode: section.code,
  label: section.label,
  panelTitle: TITLES[regime],
  pickerTitle: `Add ${TITLES[regime]}`,
  headerRowId: HEADER_ROWS[regime],
  headers: HEADERS[regime],
  cells: CATALOG[regime].find((s) => s.code === section.code).cells,
  values: values.map(([columnIndex, value]) => ({ columnIndex, column: HEADERS[regime][columnIndex], value: String(value) })),
});
const ADJ_FIELD = field("adjustable", ADJ, [[0, 1500000], [1, 120000]]);
const IMPORT_FIELD = field("minimum", MIN_IMPORT, [[0, 1000000], [1, 10000], [3, 150000]]);
const GOODS_FIELD = field("minimum", MIN_GOODS, [[0, 2000000], [1, 20000]]);

function page({
  onTab = false,
  businessOpen = false,
  panelsOpen = false,
  rows = {},
  dialog = "",
  headersOverride = null,
  presentInPickerOnly = [],
  irisComputesTax = false,
  revertLater = null,
  delayedEnableCodes = [],
} = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
.closed > .mat-expansion-panel-content{display:none}.view{display:none}.view.shown{display:block}
</style></head><body>
<app-nitr-workflow><app-nitr-wf-body>
<div class="custom-tabs"><div class="sticky-tabs-head"><div class="head">
<div class="font-15 title active">Data</div><div class="font-15 title">Amortization</div><div class="font-15 title">Depreciation</div><div class="font-15 title">Business Details</div><div class="font-15 title">Payment</div><div class="font-15 title">Attachment</div>
</div></div></div>
<div class="body interface_21 active" id="data"><div class="row">
<div class="col-md-3"><mat-accordion>
<mat-expansion-panel id="nav-business" class="${businessOpen ? "" : "closed"}"><mat-expansion-panel-header aria-expanded="${businessOpen}" class="${businessOpen ? "mat-expanded" : ""}" onclick="toggle(this)"><span class="mat-content"><mat-panel-title>Business</mat-panel-title></span></mat-expansion-panel-header>
<div class="mat-expansion-panel-content"><div class="mat-expansion-panel-body">
<button class="data-tab-left-btn" onclick="left(this)">Manufacturing/ Trading Items</button>
<button class="data-tab-left-btn" onclick="left(this)">Adjustments</button>
<button class="data-tab-left-btn ${onTab ? "active" : ""}" onclick="left(this)">Tax Deduction</button>
<button class="data-tab-left-btn ${onTab ? "" : "active"}" onclick="left(this)">Balance Sheet</button>
</div></div></mat-expansion-panel>
<mat-expansion-panel id="nav-tcp" class="closed"><mat-expansion-panel-header aria-expanded="false" onclick="toggle(this)"><span class="mat-content"><mat-panel-title>Tax Chargeable / Payments</mat-panel-title></span></mat-expansion-panel-header>
<div class="mat-expansion-panel-content"><div class="mat-expansion-panel-body"><button class="data-tab-left-btn" onclick="left(this)">Withholding Tax</button></div></div></mat-expansion-panel>
</mat-accordion></div>
<div class="col-md-9">
<div class="view ${onTab ? "" : "shown"}" id="view-other"><div class="row tableRows dataRow" id="3319"><span class="row-description-text">Cash in hand</span><div class="data-middle-child-wapper"><input type="text"/></div></div></div>
<div class="view ${onTab ? "shown" : ""}" id="view-td"><mat-accordion class="wf-section-modal-accordion" id="grids"></mat-accordion></div>
</div></div></div>
</app-nitr-wf-body></app-nitr-workflow>
<div class="cdk-overlay-container" id="overlay">${dialog}</div>
<script>
window.clicks = [];
const CATALOG = ${JSON.stringify(CATALOG)};
const HEADERS = ${JSON.stringify(headersOverride || HEADERS)};
const TITLES = ${JSON.stringify(TITLES)};
const HEADER_ROWS = ${JSON.stringify(HEADER_ROWS)};
const START_ROWS = ${JSON.stringify(rows)};
const PICKER_ONLY = ${JSON.stringify(presentInPickerOnly)};
const IRIS_COMPUTES_TAX = ${JSON.stringify(irisComputesTax)};
const REVERT_LATER = ${JSON.stringify(revertLater)};
const DELAYED_ENABLE_CODES = ${JSON.stringify(delayedEnableCodes)};
document.addEventListener("click", (e) => {
  const t = e.target.closest("button, .title, mat-expansion-panel-header, input[type=checkbox]");
  if (!t) return;
  const label = t.matches("input[type=checkbox]") ? "tick:" + t.closest(".source-card").querySelector("p").textContent.trim() : t.textContent.replace(/\\s+/g, " ").trim();
  window.clicks.push(label);
}, true);
function toggle(header) {
  const panel = header.parentElement;
  const open = header.getAttribute("aria-expanded") !== "true";
  header.setAttribute("aria-expanded", String(open));
  header.classList.toggle("mat-expanded", open);
  panel.classList.toggle("closed", !open);
}
function left(button) {
  for (const b of document.querySelectorAll("button.data-tab-left-btn")) b.classList.toggle("active", b === button);
  const td = button.textContent.trim() === "Tax Deduction";
  document.getElementById("view-td").classList.toggle("shown", td);
  document.getElementById("view-other").classList.toggle("shown", !td);
}
function cellsHtml(cells, values, header) {
  return Array.from(cells).map((c, i) => '<div class="left h-padding-0 data-middle-child-wapper">' + (c === "-" ? "" : '<div><input class="data-middle-child form-control text-right amount-cell-input" type="text"' + (c === "D" ? " disabled" : "") + ' value="' + ((values && values[i]) || "") + '"/></div>') + "</div>").join("");
}
function rowHtml(id, label, cells, values, header) {
  return '<div class="dataRow ' + (header ? "form-head " : "") + 'row tableRows v-padding-5" id="' + id + '"><div class="col-lg-5"><div class="font-14 h-padding-20"><span class="row-description-text">' + label + ' </span></div></div><div class="col-lg-1">' + (header ? "" : '<span class="data-first-child font-14">' + id + "</span>") + '</div><div class="col-lg-5 columns-parent h-padding-0">' + cellsHtml(cells, values, header) + '</div><div class="col-lg-1"><div class="full-width actions">' + (header ? '<button class="btn-section-add h-margin-5" type="button" onclick="openPicker(\\'' + header + '\\')"> + Section </button>' : '<button aria-label="Delete" class="btn-section-delete" title="Delete" type="button"><i class="fa fa-trash"></i></button>') + "</div></div></div>";
}
function wire(row) {
  const inputs = row.querySelectorAll("input");
  if (IRIS_COMPUTES_TAX && inputs.length >= 2) {
    inputs[0].addEventListener("input", () => {
      const rate = /@(\\d+(?:\\.\\d+)?)%/.exec(row.querySelector(".row-description-text").textContent);
      if (rate && !inputs[1].value) inputs[1].value = String(Math.round(Number(inputs[0].value) * Number(rate[1]) / 100));
    });
  }
  if (REVERT_LATER && row.id === REVERT_LATER.code) {
    inputs[REVERT_LATER.index].addEventListener("blur", () => setTimeout(() => { inputs[REVERT_LATER.index].value = ""; }, 30));
  }
}
function addRow(regime, code, values) {
  const section = CATALOG[regime].find((s) => s.code === code);
  const body = document.querySelector('[data-regime="' + regime + '"] .mat-expansion-panel-body');
  const holder = document.createElement("div");
  const delayed = DELAYED_ENABLE_CODES.includes(code);
  holder.innerHTML = rowHtml(code, section.label, delayed ? "D".repeat(section.cells.length) : section.cells, values, null);
  const row = holder.firstElementChild;
  // Catalog order, after the header row.
  const order = CATALOG[regime].map((s) => s.code);
  const later = Array.from(body.querySelectorAll(".tableRows[id]")).find((r) => order.indexOf(r.id) > order.indexOf(code));
  if (later) later.before(row); else body.appendChild(row);
  wire(row);
  if (delayed) setTimeout(() => {
    Array.from(row.querySelectorAll("input")).forEach((input, i) => { if (section.cells[i] === "E") input.removeAttribute("disabled"); });
  }, 150);
}
function build() {
  const grids = document.getElementById("grids");
  grids.innerHTML = ["adjustable", "final", "minimum"].map((regime) =>
    '<mat-expansion-panel data-regime="' + regime + '" class="' + (${JSON.stringify(panelsOpen)} ? "" : "closed") + '"><mat-expansion-panel-header aria-expanded="' + ${JSON.stringify(panelsOpen)} + '" class="' + (${JSON.stringify(panelsOpen)} ? "mat-expanded" : "") + '" onclick="toggle(this)"><span class="mat-content"><mat-panel-title>' + TITLES[regime] + '</mat-panel-title></span><span class="mat-expansion-indicator"></span></mat-expansion-panel-header>' +
    '<div class="mat-expansion-panel-content"><div class="mat-expansion-panel-body"><div class="row heading-bar padding-10"><div class="col-lg-5"><strong>Description</strong></div><div class="col-lg-1 text-center"><strong>Code</strong></div><div class="col-lg-5 h-padding-0">' +
    HEADERS[regime].map((h) => '<div class="left text-center"><strong>' + h + ' </strong></div>').join("") + '</div><div aria-label="Actions" class="col-lg-1 text-center"></div></div>' +
    '<div class="h-padding-10">' + rowHtml(HEADER_ROWS[regime], TITLES[regime], "D".repeat(HEADERS[regime].length), null, regime) + "</div></div></div></mat-expansion-panel>"
  ).join("");
  for (const [code, spec] of Object.entries(START_ROWS)) addRow(spec.regime, code, spec.values || []);
}
build();
function openPicker(regime) {
  const present = new Set(Array.from(document.querySelectorAll('[data-regime="' + regime + '"] .tableRows[id]')).map((r) => r.id).concat(PICKER_ONLY));
  const dlg = document.createElement("mat-dialog-container");
  dlg.setAttribute("role", "dialog");
  dlg.innerHTML = '<app-add-amount-code-row><h6 class="mat-mdc-dialog-title dialog-title"><span class="left v-padding-top-5">Add ' + TITLES[regime] + '</span><span class="right pointer"><mat-icon class="mat-icon">close</mat-icon></span></h6><mat-dialog-content><input placeholder="Search Amount Code/Description" type="text"/>' +
    CATALOG[regime].map((s) => '<div class="source-card mb-2"><div class="checkbox-container"><mat-checkbox class="mat-mdc-checkbox"><input class="mdc-checkbox__native-control" type="checkbox"' + (present.has(s.code) ? " checked disabled" : "") + ' data-code="' + s.code + '"/></mat-checkbox></div><div class="ms-3"><p class="mb-0">' + s.label + "</p></div></div>").join("") +
    '</mat-dialog-content><mat-dialog-actions><button class="btn" type="button" disabled>ADD</button><button class="btn" type="button">Cancel</button></mat-dialog-actions></app-add-amount-code-row>';
  document.getElementById("overlay").appendChild(dlg);
  const [add, cancel] = dlg.querySelectorAll("mat-dialog-actions button");
  dlg.addEventListener("change", () => { add.disabled = !Array.from(dlg.querySelectorAll("input[type=checkbox]")).some((b) => b.checked && !b.disabled); });
  add.addEventListener("click", () => {
    for (const box of dlg.querySelectorAll("input[type=checkbox]")) if (box.checked && !box.disabled && !PICKER_ONLY.includes(box.dataset.code)) addRow(regime, box.dataset.code, []);
    dlg.remove();
  });
  cancel.addEventListener("click", () => dlg.remove());
}
</script></body></html>`;
}

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
const options = (extra = {}) => ({
  mode: "live",
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 15))),
  attempts: 30,
  intervalMs: 10,
  settleMs: 60,
  ...extra,
});
const rowValues = (pg, code) => pg.evaluate((c) => { const r = document.querySelector('.tableRows[id="' + c + '"]'); return r ? Array.from(r.querySelectorAll(".data-middle-child-wapper")).map((w) => { const i = w.querySelector("input"); return i ? i.value : null; }) : null; }, code);
const clicks = (pg) => pg.evaluate(() => window.clicks);
const byKey = (out) => Object.fromEntries(out.results.map((r) => [`${r.irisCode}:${r.columnIndex}`, r]));
const FORBIDDEN = /Delete|Calculate|Save|Submit|Attribute|Normal Tax regime/i;

test("live: opens Business > Tax Deduction, opens the panels, adds both sections and types every figure", async () => {
  await withPage(page(), async (pg, win) => {
    const steps = [];
    const out = await driver.fillTaxDeductions(win, [ADJ_FIELD, IMPORT_FIELD], options({ onStep: (s, d) => steps.push([s, d]) }));
    assert.equal(out.ok, true, JSON.stringify(out.results.map((r) => [r.irisCode, r.status, r.setupStatus, r.detail])));
    assert.equal(out.results.length, 5);
    assert.ok(out.results.every((r) => r.status === "filled" && r.setupStatus === "row_added_by_agent"));
    assert.deepEqual(await rowValues(pg, ADJ.code), ["1500000", "120000"]);
    assert.deepEqual(await rowValues(pg, MIN_IMPORT.code), ["1000000", "10000", "", "150000", "", ""]);
    const seen = await clicks(pg);
    assert.deepEqual(seen, [
      "Business", "Tax Deduction",
      "Adjustable Tax", "+ Section", `tick:${ADJ.label}`, "ADD",
      "Minimum Tax", "+ Section", `tick:${MIN_IMPORT.label}`, "ADD",
    ]);
    assert.ok(!seen.some((c) => FORBIDDEN.test(c)));
    const r = byKey(out)[`${MIN_IMPORT.code}:3`];
    assert.equal(r.requestedColumn, "Attributable Taxable Income");
    assert.equal(r.censusView, "Business > Tax Deduction");
    assert.equal(r.rowDescription, MIN_IMPORT.label);
    assert.equal(r.sectionId, "business_tax_deduction");
    assert.ok(steps.some(([s]) => s === "tax_deduction_section_added"));
    assert.match(driver.describeTaxDeductionOutcome(out), /5 of 5 figure\(s\) in 2 section\(s\)/);
  });
});

test("a newly-added row that first renders all-disabled is waited for, then typed (live 64060116 timing)", async () => {
  await withPage(page({ onTab: true, businessOpen: true, panelsOpen: true, delayedEnableCodes: [ADJ.code] }), async (pg, win) => {
    const steps = [];
    const out = await driver.fillTaxDeductions(win, [ADJ_FIELD], options({ onStep: (s, d) => steps.push([s, d]) }));
    assert.equal(out.ok, true, JSON.stringify(out.results.map((r) => [r.status, r.setupStatus, r.detail])));
    assert.ok(out.results.every((r) => r.status === "filled"));
    assert.deepEqual(await rowValues(pg, ADJ.code), ["1500000", "120000"]);
    assert.ok(steps.some(([s]) => s === "tax_deduction_row_cells_enabled_after_wait"));
  });
});

test("a section row already there is reused: same figures -> already_correct, no picker", async () => {
  const rows = { [ADJ.code]: { regime: "adjustable", values: ["1,500,000", "120,000"] } };
  await withPage(page({ onTab: true, businessOpen: true, panelsOpen: true, rows }), async (pg, win) => {
    const out = await driver.fillTaxDeductions(win, [ADJ_FIELD], options());
    assert.equal(out.ok, true);
    assert.ok(out.results.every((r) => r.status === "already_correct" && r.setupStatus === "row_already_present"));
    assert.deepEqual(await clicks(pg), []);
  });
});

test("a different figure already in a cell is never overwritten", async () => {
  const rows = { [MIN_GOODS.code]: { regime: "minimum", values: ["1999999", ""] } };
  await withPage(page({ onTab: true, businessOpen: true, panelsOpen: true, rows }), async (pg, win) => {
    const out = await driver.fillTaxDeductions(win, [GOODS_FIELD], options());
    const r = byKey(out);
    assert.equal(r[`${MIN_GOODS.code}:0`].status, "overwrite_needs_confirmation");
    assert.equal(r[`${MIN_GOODS.code}:0`].existingValue, "1999999");
    assert.equal(r[`${MIN_GOODS.code}:1`].status, "filled", "the blank cell of the same row is still typed");
    assert.deepEqual((await rowValues(pg, MIN_GOODS.code)).slice(0, 2), ["1999999", "20000"]);
    assert.equal(out.ok, false);
  });
});

test("IRIS computing Tax Deducted after Taxable Amount: the approved certificate figure replaces it, and it is reported", async () => {
  await withPage(page({ onTab: true, businessOpen: true, panelsOpen: true, irisComputesTax: true }), async (pg, win) => {
    const goods = field("minimum", MIN_GOODS, [[0, 2000000], [1, 15000]]);
    const steps = [];
    const out = await driver.fillTaxDeductions(win, [goods], options({ onStep: (s, d) => steps.push([s, d]) }));
    assert.equal(out.ok, true, JSON.stringify(out.results.map((r) => [r.status, r.detail])));
    const r = byKey(out)[`${MIN_GOODS.code}:1`];
    assert.equal(r.status, "filled");
    assert.equal(r.replacedIrisValue, "20000");
    assert.deepEqual((await rowValues(pg, MIN_GOODS.code)).slice(0, 2), ["2000000", "15000"]);
    assert.ok(steps.some(([s, d]) => s === "tax_deduction_iris_value_replaced" && /20000/.test(d)));
  });
});

test("a figure IRIS clears after typing is caught when the row is read again", async () => {
  await withPage(page({ onTab: true, businessOpen: true, panelsOpen: true, revertLater: { code: ADJ.code, index: 1 } }), async (pg, win) => {
    // DP-4: the fixture clears the cell 30 ms after blur; the default test
    // sleep (capped at 15 ms) made the two settle waits race that timer.
    // Here the settle waits really last settleMs (60 ms each).
    const out = await driver.fillTaxDeductions(win, [ADJ_FIELD], options({ sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 60))) }));
    const r = byKey(out);
    assert.equal(r[`${ADJ.code}:0`].status, "filled");
    assert.equal(r[`${ADJ.code}:1`].status, "readback_mismatch");
    assert.equal(r[`${ADJ.code}:1`].readbackStage, "after_settle");
    assert.equal(out.ok, false);
  });
});

test("another dialog on screen: nothing is clicked", async () => {
  const dialog = '<mat-dialog-container role="dialog"><h6 class="mat-mdc-dialog-title"><span class="left">Notice</span></h6></mat-dialog-container>';
  await withPage(page({ dialog }), async (pg, win) => {
    const out = await driver.fillTaxDeductions(win, [ADJ_FIELD], options());
    assert.equal(out.ok, false);
    assert.equal(out.reason, "unexpected_dialog_open");
    assert.ok(out.results.every((r) => r.status === "unverified_target"));
    assert.deepEqual(await clicks(pg), []);
  });
});

test("a layout that differs from the captures (headings): no click inside the tab", async () => {
  const headersOverride = { ...HEADERS, minimum: ["Taxable Amount", "Tax Deducted", "Tax Chargeable", "Attributable Taxable Income", "Tax on Attributable Taxable Income", "Difference of Minimum Tax Chargeable"] };
  await withPage(page({ onTab: true, businessOpen: true, headersOverride }), async (pg, win) => {
    const out = await driver.fillTaxDeductions(win, [ADJ_FIELD], options());
    assert.equal(out.reason, "structure_unverified");
    assert.deepEqual(await clicks(pg), []);
  });
});

test("picker says the section is present but the tab has no row: Cancel is pressed, nothing added", async () => {
  await withPage(page({ onTab: true, businessOpen: true, panelsOpen: true, presentInPickerOnly: [ADJ.code] }), async (pg, win) => {
    const out = await driver.fillTaxDeductions(win, [ADJ_FIELD], options());
    assert.ok(out.results.every((r) => r.status === "row_not_found" && r.setupStatus === "picker_says_section_present_but_row_not_on_tab"));
    assert.deepEqual(await clicks(pg), ["+ Section", "Cancel"]);
    assert.equal(await pg.evaluate(() => document.querySelectorAll("mat-dialog-container").length), 0);
  });
});

test("a leftover picker of ours is closed with its own Cancel before anything else", async () => {
  await withPage(page({ onTab: true, businessOpen: true, panelsOpen: true }), async (pg, win) => {
    await pg.evaluate(() => openPicker("minimum"));
    const out = await driver.fillTaxDeductions(win, [ADJ_FIELD], options());
    assert.equal(out.ok, true);
    assert.deepEqual((await clicks(pg)).slice(0, 1), ["Cancel"]);
  });
});

test("dry run and refused packet entries: nothing is clicked", async () => {
  await withPage(page(), async (pg, win) => {
    const dry = await driver.fillTaxDeductions(win, [ADJ_FIELD], options({ mode: "dry" }));
    assert.equal(dry.reason, "dry_run_nothing_clicked");
    assert.equal(dry.planned, 1);
    assert.match(driver.describeTaxDeductionOutcome(dry), /would be added/);
    const finalTax = field("final", CATALOG.final[0], [[0, 100], [1, 1]]);
    const computedCell = { ...GOODS_FIELD, values: [...GOODS_FIELD.values, { columnIndex: 2, column: "Tax Chargeable", value: "5" }] };
    const wrongHeaders = { ...ADJ_FIELD, headers: ["Taxable Amount", "Tax Collected / Deducted"] };
    const out = await driver.fillTaxDeductions(win, [finalTax, computedCell, wrongHeaders], options());
    assert.equal(out.reason, "packet_entries_refused");
    assert.ok(out.results.every((r) => r.status === "unverified_target"));
    assert.match(out.results[0].setupStatus, /regime_not_typed_in_this_build/);
    assert.ok(out.results.some((r) => /column_2_not_editable/.test(r.setupStatus)));
    assert.ok(out.results.some((r) => /headings/.test(r.setupStatus)));
    assert.deepEqual(await clicks(pg), []);
  });
});

test("the open return must be confirmed first", async () => {
  await withPage(page(), async (pg, win) => {
    const out = await driver.fillTaxDeductions(win, [ADJ_FIELD], options({ verifyDocument: async () => ({ ok: false, status: "document_mismatch_ty2025" }) }));
    assert.equal(out.reason, "document_unverified");
    assert.deepEqual(await clicks(pg), []);
  });
});

test("census readback looks for a Tax Deduction figure only on that tab", () => {
  const entry = { key: "k", irisCode: ADJ.code, status: "filled", readback: "120,000", columnIndex: 1, rowDescription: ADJ.label, censusView: "Business > Tax Deduction" };
  const rowOf = (value) => ({ code: ADJ.code, description: ADJ.label, descriptionRaw: `${ADJ.label} `, cells: [{ value: "1500000" }, { value }] });
  const tour = { views: [
    { key: "Tax Chargeable / Payments > Withholding Tax", rows: [rowOf("999")] },
    { key: "Business > Tax Deduction", rows: [rowOf("120000")] },
  ] };
  const [check] = census.compareTypedEntries(tour, [entry]);
  assert.equal(check.status, "match");
  assert.equal(check.view, "Business > Tax Deduction");
  const [without] = census.compareTypedEntries(tour, [{ ...entry, censusView: undefined }]);
  assert.equal(without.status, "not_seen", "without the view name the code is not unique");
});
