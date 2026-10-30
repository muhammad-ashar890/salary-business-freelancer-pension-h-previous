"use strict";
/**
 * DP-1 (fix48): the Depreciation-tab driver against a page built with the
 * structure of capture 11 (iris-business-captures/11_...html): top tab
 * titles, `.body.interface_23`, one `.heading-bar` (Description, Code, nine
 * labels, hidden Action), rows `.tableRows[id]` WITHOUT `.dataRow`, total row
 * 324802 (`.form-head`, all disabled), nine inputs per row (0-5 editable,
 * 330308 only 4-5). The page recalculates the grey cells like the engine so
 * the driver's read-back of computed cells can be checked; how IRIS itself
 * computes them is [CHECK-LIVE]. Synthetic figures only.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const driver = require("../electron-connect/iris-depreciation-driver.js");

const RATES = { "330205": 10, "33020405": 100, "33030105": 15, "330308": 15, "33030205": 30, "33030305": 15, "33030405": 15, "33030605": 20, "3304105": 15, "3304205": 15, "3304305": 15, "3304405": 30 };

function depreciationPage({ headings = driver.HEADINGS, prefill = {}, dialog = false, extraRow = false, ignoreFirstDepClick = false } = {}) {
  const cell = (disabled, value = "") =>
    `<div class="left h-padding-0 data-middle-child-wapper"><div><span><span class="hide"></span><input onkeypress="if (event.which > 57) return false;" type="text" class="font-13 data-middle-child form-control text-right"${disabled ? " disabled" : ""} value="${value}"></span></div></div>`;
  const rows = Object.entries(driver.ROWS).map(([code, label]) => {
    const pattern = driver.EDITABLE[code] || driver.EDITABLE.default;
    return `<div class="h-padding-5 row tableRows v-padding-5" id="${code}"><div class="col-lg-2"> ${label} </div><div class="col-lg-1"><span class="data-first-child font-13">${code}</span></div><div class="col-lg-9 columns-parent">${pattern.map((editable, i) => cell(!editable, (prefill[code] || {})[i] || "")).join("")}</div></div>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>.hide{display:none}.body{display:none}.body.active{display:block}</style></head><body>
<app-nitr-workflow><app-nitr-wf-body>
<div class="custom-tabs"><div class="sticky-tabs-head"><div class="head">
<div class="title active" onclick="show('data')">Data</div><div class="title" onclick="show('amort')">Amortization</div><div class="title" onclick="show('dep')">Depreciation</div><div class="title">Business Details</div>
</div></div></div>
<div class="body interface_21 active" id="data">Data grid</div>
<app-amortization><div class="body interface_22" id="amort">Amortization</div></app-amortization>
<app-depreciation><div class="body interface_23" id="dep"><div class="sticky bg-white">
<div class="row heading-bar"><div><strong>Description</strong></div><div><strong>Code</strong></div><div class="col-lg-9">${headings.map((h) => `<div class="left"><strong>${h} </strong></div>`).join("")}</div><div class="hide"><strong>Action</strong></div></div></div>
<div class="content"><div class="form-head h-padding-5 row tableRows v-padding-5" id="324802"><div> Depreciation </div><div><span>324802</span></div><div class="columns-parent">${headings.map(() => cell(true)).join("")}</div></div>${rows}${extraRow ? rows.split("</div></div></div>")[0] : ""}</div>
</div></app-depreciation>
</app-nitr-wf-body></app-nitr-workflow>
${dialog ? '<mat-dialog-container role="dialog">Notice</mat-dialog-container>' : ""}
<script>
window.clicks = [];
let depClickCount = 0;
function show(which) {
  window.clicks.push(which);
  if (which === "dep") {
    depClickCount += 1;
    if (${ignoreFirstDepClick} && depClickCount === 1) return;
  }
  for (const b of document.querySelectorAll(".body")) b.classList.toggle("active", b.id === which);
  for (const t of document.querySelectorAll(".title")) t.classList.toggle("active", t.getAttribute("onclick") === "show('" + which + "')");
}
const RATES = ${JSON.stringify(RATES)};
const num = (input) => Number(String(input.value || "").replace(/,/g, "")) || 0;
function recalc() {
  const totals = [0, 0, 0];
  for (const row of document.querySelectorAll("#dep .tableRows[id]")) {
    if (row.id === "324802") continue;
    const c = row.querySelectorAll("input");
    const r = RATES[row.id] / 100, ia = row.id === "330308" ? 0.25 : 0;
    const base = num(c[0]) - num(c[1]), used = num(c[2]), nw = num(c[4]);
    const extU = c[3].value === "" ? 0 : num(c[3]) / 100, extN = c[5].value === "" ? 0 : num(c[5]) / 100;
    const allowance = nw * ia;
    const dep = r * base + r * used * extU + r * (nw - allowance) * extN;
    const cf = (base + used + nw - allowance) * (1 - r);
    const out = [allowance, dep, cf].map(Math.round);
    out.forEach((v, i) => { c[6 + i].value = v ? v.toLocaleString("en-US") : ""; totals[i] += v; });
  }
  const t = document.querySelectorAll("#dep [id='324802'] input");
  totals.forEach((v, i) => { t[6 + i].value = v ? v.toLocaleString("en-US") : ""; });
}
document.addEventListener("input", recalc, true);
</script></body></html>`;
}

let browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });

async function withPage(html, run) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
  await page.goto("https://iris.fbr.gov.pk/nitr/workflow");
  const mainFrame = { get url() { return page.url(); }, executeJavaScript: (source) => page.evaluate(source) };
  mainFrame.framesInSubtree = [mainFrame];
  const win = { isDestroyed: () => false, webContents: { mainFrame, getURL: () => page.url(), executeJavaScript: mainFrame.executeJavaScript } };
  try { await run(page, win); } finally { await context.close(); }
}

// Same rows as scripts/verify-data-push-1.cjs (buildDepreciationAgentFields).
const FIELDS = [
  { key: "depreciation.330205.wdvBroughtForward", irisCode: "330205", irisDescription: "Building (all types)", column: "WDV (BF)", headerOccurrence: 1, cellIndex: 0, ourAmount: 1200000 },
  { key: "depreciation.330205.deletion", irisCode: "330205", irisDescription: "Building (all types)", column: "Deletion", headerOccurrence: 1, cellIndex: 1, ourAmount: 200000 },
  { key: "depreciation.33030105.wdvBroughtForward", irisCode: "33030105", irisDescription: "Plant", column: "WDV (BF)", headerOccurrence: 1, cellIndex: 0, ourAmount: 1000000 },
  { key: "depreciation.330308.additionNew", irisCode: "330308", irisDescription: "Plant IA", column: "Addition (New)", headerOccurrence: 1, cellIndex: 4, ourAmount: 400000 },
  { key: "depreciation.330308.additionNewExtent", irisCode: "330308", irisDescription: "Plant IA", column: "Extent of Use", headerOccurrence: 2, cellIndex: 5, ourAmount: 100 },
];
const cellValues = (page, code) => page.evaluate((c) => Array.from(document.querySelectorAll(`#dep [id="${c}"] input`)).map((i) => i.value), code);
const shownBody = (page) => page.evaluate(() => Array.from(document.querySelectorAll(".body")).filter((b) => b.classList.contains("active")).map((b) => b.id));

test("opens Depreciation, verifies the capture-11 structure, types only the six columns, returns to Data", async () => {
  await withPage(depreciationPage(), async (page, win) => {
    const steps = [];
    const out = await driver.fillDepreciationTab(win, FIELDS, { mode: "live", intervalMs: 20, onStep: (s, d) => steps.push([s, d]) });
    assert.equal(out.ok, true, out.reason);
    assert.deepEqual(out.results.map((r) => r.status), ["filled", "filled", "filled", "filled", "filled"]);
    assert.ok(out.results.every((r) => r.sectionId === "business_depreciation" && Number.isInteger(r.columnIndex)));
    const building = await cellValues(page, "330205");
    assert.deepEqual(building.slice(0, 6), ["1200000", "200000", "", "", "", ""]);
    const ia = await cellValues(page, "330308");
    assert.deepEqual(ia.slice(0, 6), ["", "", "", "", "400000", "100"]);
    // Grey cells as recalculated by the page: IA 100,000; 45,000; WDV CF 255,000.
    const computed = Object.fromEntries(out.computed.map((row) => [row.code, row]));
    assert.equal(computed["330308"].initialAllowance, "100,000");
    assert.equal(computed["330308"].depreciation, "45,000");
    assert.equal(computed["330205"].depreciation, "100,000");
    assert.equal(computed["324802"].depreciation, "295,000");
    assert.deepEqual(await shownBody(page), ["data"]);
    assert.deepEqual(await page.evaluate(() => window.clicks), ["dep", "data"]);
    assert.ok(steps.some(([s]) => s === "real_autofill_depreciation_done"));
  });
});

test("a lost first Depreciation title click is safely retried BEFORE typing", async () => {
  await withPage(depreciationPage({ ignoreFirstDepClick: true }), async (page, win) => {
    const out = await driver.fillDepreciationTab(win, FIELDS, {
      mode: "live",
      intervalMs: 5,
      attempts: 30,
      openAttempts: 3,
      openRetryAfter: 2,
    });
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.diagnostics.openClicks, 2);
    assert.deepEqual(await page.evaluate(() => window.clicks), ["dep", "dep", "data"]);
    assert.deepEqual(out.results.map((r) => r.status), ["filled", "filled", "filled", "filled", "filled"]);
  });
});

test("a heading that differs from capture 11 stops BEFORE typing", async () => {
  const changed = [...driver.HEADINGS];
  changed[1] = "Deletions";
  await withPage(depreciationPage({ headings: changed }), async (page, win) => {
    const out = await driver.fillDepreciationTab(win, FIELDS, { mode: "live", intervalMs: 5, attempts: 6 });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "structure_differs");
    assert.ok(out.problems.includes("headings_differ"));
    assert.ok(out.results.every((r) => r.status === "unverified_target"));
    assert.deepEqual((await cellValues(page, "330205")).slice(0, 6), ["", "", "", "", "", ""]);
    assert.deepEqual(await shownBody(page), ["data"]);
  });
});

test("a different figure already in IRIS is not overwritten; the rest is typed", async () => {
  await withPage(depreciationPage({ prefill: { "330205": { 0: "5" } } }), async (page, win) => {
    const out = await driver.fillDepreciationTab(win, FIELDS, { mode: "live", intervalMs: 20 });
    const byKey = Object.fromEntries(out.results.map((r) => [r.key, r]));
    assert.equal(byKey["depreciation.330205.wdvBroughtForward"].status, "overwrite_needs_confirmation");
    assert.equal(byKey["depreciation.330205.deletion"].status, "filled");
    assert.equal(out.ok, false);
    assert.equal((await cellValues(page, "330205"))[0], "5");
  });
});

test("an open dialog, a dry run or a field outside the six columns types nothing", async () => {
  await withPage(depreciationPage({ dialog: true }), async (page, win) => {
    const out = await driver.fillDepreciationTab(win, FIELDS, { mode: "live", intervalMs: 5 });
    assert.equal(out.reason, "dialog_open");
    assert.deepEqual(await page.evaluate(() => window.clicks), []);
  });
  await withPage(depreciationPage(), async (page, win) => {
    const dry = await driver.fillDepreciationTab(win, FIELDS, { mode: "dry" });
    assert.equal(dry.reason, "dry_run_nothing_typed");
    const grey = await driver.fillDepreciationTab(win, [{ ...FIELDS[0], cellIndex: 7, column: "Depreciation" }], { mode: "live" });
    assert.equal(grey.reason, "packet_field_not_a_typed_depreciation_cell");
    const wrongOccurrence = await driver.fillDepreciationTab(win, [{ ...FIELDS[4], headerOccurrence: 1 }], { mode: "live" });
    assert.equal(wrongOccurrence.reason, "packet_field_not_a_typed_depreciation_cell");
    assert.deepEqual(await page.evaluate(() => window.clicks), []);
  });
});

test("computed cells after the tab switch are compared with TaxRocket's figures", () => {
  const tour = { views: [{ key: "top:Depreciation", rows: [
    { code: "330308", cells: ["", "", "", "", "400,000", "100", "100,000", "45,000", "255,000"].map((value) => ({ value })) },
    { code: "330205", cells: ["1,200,000", "200,000", "", "", "", "", "", "90,000", "900,000"].map((value) => ({ value })) },
  ] }] };
  const checks = driver.compareDepreciationComputed(tour, {
    rows: [
      { code: "330308", label: "Plant IA", initialAllowance: 100000, depreciation: 45000, writtenDownValueCarriedForward: 255000 },
      { code: "330205", label: "Building", initialAllowance: 0, depreciation: 100000, writtenDownValueCarriedForward: 900000 },
    ],
    total: { code: "324802", label: "Depreciation", initialAllowance: 100000, depreciation: 145000, writtenDownValueCarriedForward: 1155000 },
  });
  assert.deepEqual(checks.map((c) => [c.code, c.status]), [["330308", "match"], ["330205", "differs"], ["324802", "not_seen"]]);
  assert.equal(checks[1].checks.find((c) => c.name === "depreciation").iris, "90,000");
  assert.equal(driver.cellNumber("(1,000)"), -1000);
  assert.equal(driver.cellNumber(""), 0);
});
