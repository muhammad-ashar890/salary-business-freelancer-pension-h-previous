"use strict";
/**
 * DP-2 (fix49): the Business Details driver against a page built with the
 * structure of captures 41 / 55 / 70 / 71 (~/iris-business-captures):
 * top tab titles; `app-business-details > .body.business-details-container`;
 * `table.business-table` (Sr No. | Business Name | Principal Activity |
 * Start Date | End Date | Brand Name | Action); "+ Business"
 * (`button.btn-section-add[title="Add Business"]`); dialog
 * `app-add-business-details` titled "Business Details" with inputs by
 * formcontrolname (businessName, name, startDate, endDate), the
 * `mat-select[formcontrolname=principalActivity]` whose panel lists
 * Manufacturing / Services / Trading / Other, CLOSE / SAVE; saved rows
 * `tr.business-row` with `td.sr-col`, dates "19-Jul-2013" and brand badges.
 * How IRIS parses a typed date is [CHECK-LIVE]; the page can accept
 * DD/MM/YYYY, refuse it, or read it month-first, so each guard is exercised.
 * Synthetic data only.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const driver = require("../electron-connect/iris-business-details-driver.js");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function page({ records = "", headers = driver.SPEC.headers, dateMode = "dmy", dialogOpen = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>.body{display:none}.body.active{display:block}</style></head><body>
<app-nitr-workflow><app-nitr-wf-body>
<div class="custom-tabs"><div class="sticky-tabs-head"><div class="head">
<div class="font-15 title active" onclick="show('data')">Data</div><div class="font-15 title" onclick="show('amort')">Amortization</div><div class="font-15 title" onclick="show('dep')">Depreciation</div><div class="font-15 title" onclick="show('bd')">Business Details</div><div class="font-15 title">Payment</div><div class="font-15 title">Attachment</div>
</div></div></div>
<div class="body interface_21 active" id="data">Data grid</div>
<app-amortization><div class="body interface_22" id="amort">A</div></app-amortization>
<app-depreciation><div class="body interface_23" id="dep">D</div></app-depreciation>
<app-business-details><div class="body business-details-container interface_85" id="bd">
<div class="custom-panel purple-border"><h5 class="text-purple">Business Details</h5></div>
<div class="custom-panel green-border mb-3"><div class="panel-header"><h5 class="text-green">Businesses</h5></div>
<div class="table-responsive px-0"><table class="business-table m-0 pl-10px"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
<tbody id="rows"><tr class="business-row"><td><strong>Add Business Details</strong></td><td class="text-right"><button class="btn-section-add" title="Add Business" onclick="openAdd()">+ Business</button></td></tr>
${records || '<tr id="empty"><td class="text-center p-4 text-muted">No businesses available.</td></tr>'}
</tbody></table></div></div></div></app-business-details>
</app-nitr-wf-body></app-nitr-workflow>
<div class="cdk-overlay-container" id="overlay">${dialogOpen ? '<mat-dialog-container role="dialog"><h6 class="mat-mdc-dialog-title"><span class="left">Notice</span></h6></mat-dialog-container>' : ""}</div>
<script>
window.clicks = [];
const MONTHS = ${JSON.stringify(MONTHS)};
const DATE_MODE = ${JSON.stringify(dateMode)};
document.addEventListener("click", (e) => {
  const t = e.target.closest(".title, button, mat-option, .mat-mdc-select-trigger, mat-icon");
  if (t) window.clicks.push(t.getAttribute("data-k") || t.textContent.trim());
}, true);
function show(which) {
  for (const b of document.querySelectorAll(".body")) b.classList.toggle("active", b.id === which);
}
function field(label, name, extra) {
  return '<mat-form-field class="mat-mdc-form-field"><mat-label>' + label + '</mat-label><input class="mat-mdc-input-element ng-untouched ng-pristine" formcontrolname="' + name + '" ' + (extra || "") + ' type="text"/></mat-form-field>';
}
function parse(text) {
  if (DATE_MODE === "reject") return null;
  const named = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\\d{1,2}), (\\d{4})$/.exec(text);
  if (named) {
    const native = new Date(text);
    const dt = new Date(Date.UTC(native.getFullYear(), native.getMonth(), native.getDate()));
    if (DATE_MODE === "corrupt") dt.setUTCDate(dt.getUTCDate() + 1);
    return dt;
  }
  const m = /^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/.exec(text);
  if (!m || DATE_MODE === "reject") return null;
  const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [d, mo] = DATE_MODE === "mdy" ? [b, a] : [a, b];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt : null;
}
const p2 = (n) => String(n).padStart(2, "0");
function openAdd() {
  const dlg = document.createElement("mat-dialog-container");
  dlg.setAttribute("role", "dialog");
  dlg.innerHTML = '<app-add-business-details><h6 class="mat-mdc-dialog-title dialog-header"><span class="left v-padding-top-5">Business Details</span><span class="right"><mat-icon class="mat-icon" data-k="x">close</mat-icon></span></h6><mat-dialog-content>' +
    field("Business Name", "businessName", 'maxlength="100" required') +
    '<mat-form-field class="mat-mdc-form-field"><mat-label>Principal Activity</mat-label><mat-select formcontrolname="principalActivity" role="combobox"><div class="mat-mdc-select-trigger" data-k="activity-list"><div class="mat-mdc-select-value"><span class="mat-mdc-select-placeholder">Principal Activity</span></div></div></mat-select></mat-form-field>' +
    field("Brand Name", "name", 'maxlength="100" required') +
    field("Start Date", "startDate", 'required') + field("End Date", "endDate", "") +
    '<div class="errors"></div></mat-dialog-content><mat-dialog-actions><button class="btn clear-btn-color" type="button"> CLOSE </button><button class="btn active-btn-color" type="button"> SAVE </button></mat-dialog-actions></app-add-business-details>';
  document.getElementById("overlay").appendChild(dlg);
  const q = (n) => dlg.querySelector('input[formcontrolname="' + n + '"]');
  const parsed = {};
  for (const name of ["startDate", "endDate"]) {
    const el = q(name);
    el.classList.add("mat-datepicker-input");
    el.addEventListener("input", () => { parsed[name] = parse(el.value); });
    el.addEventListener("blur", () => {
      const ff = el.closest("mat-form-field");
      el.classList.remove("ng-untouched"); el.classList.add("ng-touched");
      const dt = parsed[name];
      if (el.value && !dt) { el.classList.add("ng-invalid"); ff.classList.add("mat-form-field-invalid"); return; }
      el.classList.remove("ng-invalid"); ff.classList.remove("mat-form-field-invalid");
      if (dt) el.value = p2(dt.getUTCDate()) + "/" + p2(dt.getUTCMonth() + 1) + "/" + dt.getUTCFullYear();
    });
  }
  const select = dlg.querySelector("mat-select");
  dlg.querySelector(".mat-mdc-select-trigger").addEventListener("click", () => {
    const pane = document.createElement("div");
    pane.className = "cdk-overlay-pane custom-dialog-panel";
    pane.innerHTML = '<div role="listbox" class="mat-mdc-select-panel">' + ["Manufacturing", "Services", "Trading", "Other"].map((o, i) => '<mat-option role="option" id="mat-option-' + i + '" aria-disabled="false" class="mat-mdc-option"><span class="mdc-list-item__primary-text">' + o + '</span></mat-option>').join("") + '</div>';
    document.getElementById("overlay").appendChild(pane);
    for (const opt of pane.querySelectorAll("mat-option")) opt.addEventListener("click", () => {
      select.querySelector(".mat-mdc-select-value").innerHTML = '<span class="mat-mdc-select-value-text"><span class="mat-mdc-select-min-line">' + opt.textContent.trim() + '</span></span>';
      select.dataset.value = opt.textContent.trim();
      pane.remove();
    });
  });
  const [closeBtn, saveBtn] = dlg.querySelectorAll("mat-dialog-actions button");
  closeBtn.addEventListener("click", () => dlg.remove());
  saveBtn.addEventListener("click", () => {
    const start = parsed.startDate, end = parsed.endDate;
    if (!q("businessName").value || !select.dataset.value || !q("name").value || !start || (q("endDate").value && !end)) {
      dlg.querySelector(".errors").innerHTML = "<mat-error>Please fill all required fields</mat-error>";
      return;
    }
    const fmt = (dt) => p2(dt.getUTCDate() + (DATE_MODE === "wrong_saved" ? 1 : 0)) + "-" + MONTHS[dt.getUTCMonth()] + "-" + dt.getUTCFullYear();
    const badges = q("name").value.split(",").map((b) => b.trim()).filter(Boolean).map((b) => '<span class="brand-badge"><span class="brand-badge-label"> ' + b + ' </span><button class="badge-remove-btn" title="Remove brand" type="button">x</button></span>').join("");
    const empty = document.getElementById("empty"); if (empty) empty.remove();
    const tr = document.createElement("tr");
    tr.className = "business-row";
    tr.innerHTML = '<td class="sr-col">1</td><td>' + q("businessName").value + '</td><td>' + select.dataset.value + '</td><td>' + fmt(start) + '</td><td>' + (end ? fmt(end) : "") + '</td><td>' + badges + '</td><td class="text-right"><mat-icon title="Edit">edit_square</mat-icon></td>';
    document.getElementById("rows").appendChild(tr);
    dlg.remove();
  });
}
</script></body></html>`;
}

const record = ({ name = "SYNTHETIC TEST BUSINESS", activity = "Trading", start = "19-Jul-2013", end = "", brands = ["Synthetic", "Test Brand"] } = {}) =>
  `<tr class="business-row"><td class="sr-col">1</td><td>${name}</td><td>${activity}</td><td>${start}</td><td>${end}</td><td>${brands.map((b) => `<span class="brand-badge"><span class="brand-badge-label"> ${b} </span><button class="badge-remove-btn" title="Remove brand" type="button">x</button></span>`).join("")}</td><td class="text-right"><mat-icon title="Edit">edit_square</mat-icon></td></tr>`;

// Same shape as lib/tax/business-identity.ts buildBusinessDetailsPlan().
const PLAN = {
  version: "business-details-v1",
  businessName: "SYNTHETIC TEST BUSINESS",
  principalActivity: "Trading",
  brandName: "Synthetic, Test Brand",
  brands: ["Synthetic", "Test Brand"],
  startDate: "2013-07-19",
  endDate: null,
  typed: { startDate: "19/07/2013", endDate: null },
  table: { startDate: "19-Jul-2013", endDate: null },
};
const EARLY_DAY = { ...PLAN, startDate: "2013-07-05", typed: { startDate: "05/07/2013", endDate: null }, table: { startDate: "05-Jul-2013", endDate: null } };

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
const live = { mode: "live", intervalMs: 10, attempts: 30 };
// Cell texts as a person reads them (brand badges without their remove buttons).
const rows = (pg) => pg.evaluate(() => Array.from(document.querySelectorAll("tr.business-row")).filter((tr) => tr.querySelector(".sr-col")).map((tr) => Array.from(tr.children).slice(1, 6).map((td) => { const c = td.cloneNode(true); c.querySelectorAll("button").forEach((b) => b.remove()); return c.textContent.replace(/\s+/g, " ").trim(); })));
const shown = (pg) => pg.evaluate(() => Array.from(document.querySelectorAll(".body.active")).map((b) => b.id));
const dialogs = (pg) => pg.evaluate(() => document.querySelectorAll("mat-dialog-container").length);

test("empty table: adds the business, reads it back from the table, returns to Data", async () => {
  await withPage(page(), async (pg, win) => {
    const steps = [];
    const out = await driver.fillBusinessDetailsTab(win, PLAN, { ...live, onStep: (s, d) => steps.push([s, d]) });
    assert.equal(out.status, "filled", JSON.stringify(out));
    assert.equal(out.ok, true);
    assert.deepEqual(await rows(pg), [["SYNTHETIC TEST BUSINESS", "Trading", "19-Jul-2013", "", "Synthetic Test Brand"]]);
    assert.deepEqual(await page_clicks(pg), ["Business Details", "+ Business", "activity-list", "Trading", "SAVE", "Data"]);
    assert.deepEqual(await shown(pg), ["data"]);
    assert.equal(await dialogs(pg), 0);
    assert.ok(steps.some(([s]) => s === "real_autofill_business_details_done"));
  });
});

const page_clicks = (pg) => pg.evaluate(() => window.clicks);

test("same business with the same details: already correct, only the tab titles clicked", async () => {
  await withPage(page({ records: record() }), async (pg, win) => {
    const out = await driver.fillBusinessDetailsTab(win, PLAN, live);
    assert.equal(out.status, "already_correct");
    assert.deepEqual(await page_clicks(pg), ["Business Details", "Data"]);
  });
});

test("same business with another activity: reported, never edited", async () => {
  await withPage(page({ records: record({ activity: "Services" }) }), async (pg, win) => {
    const out = await driver.fillBusinessDetailsTab(win, PLAN, live);
    assert.equal(out.status, "differs_not_changed");
    assert.deepEqual(out.differences, ["principalActivity"]);
    assert.deepEqual(await page_clicks(pg), ["Business Details", "Data"]);
  });
});

test("another business already listed: nothing added", async () => {
  await withPage(page({ records: record({ name: "OTHER TRADERS" }) }), async (pg, win) => {
    const out = await driver.fillBusinessDetailsTab(win, PLAN, live);
    assert.equal(out.status, "other_business_present");
    assert.equal((await rows(pg)).length, 1);
    assert.deepEqual(await page_clicks(pg), ["Business Details", "Data"]);
  });
});

test("IRIS refuses the typed date: dialog closed with CLOSE, nothing saved", async () => {
  await withPage(page({ dateMode: "reject" }), async (pg, win) => {
    const out = await driver.fillBusinessDetailsTab(win, PLAN, live);
    assert.equal(out.status, "not_entered");
    assert.equal(out.reason, "start_date_not_accepted_by_iris");
    assert.deepEqual(await rows(pg), []);
    assert.equal(await dialogs(pg), 0);
    const clicks = await page_clicks(pg);
    assert.ok(clicks.includes("CLOSE") && !clicks.includes("SAVE"));
  });
});

test("month-first DateAdapter receives an unambiguous month-name input, not 05/07", async () => {
  await withPage(page({ dateMode: "mdy" }), async (pg, win) => {
    const out = await driver.fillBusinessDetailsTab(win, EARLY_DAY, live);
    assert.equal(out.status, "filled", JSON.stringify(out));
    assert.equal(out.seen.startDate, "05-Jul-2013");
    assert.equal((await rows(pg))[0][2], "05-Jul-2013");
  });
});

test("table headers that differ from the capture: nothing clicked except the tabs", async () => {
  const changed = [...driver.SPEC.headers];
  changed[2] = "Activity";
  await withPage(page({ headers: changed }), async (pg, win) => {
    const out = await driver.fillBusinessDetailsTab(win, PLAN, { ...live, attempts: 5 });
    assert.equal(out.status, "unverified_target");
    assert.ok(out.problems.includes("headers_differ"));
    assert.deepEqual(await page_clicks(pg), ["Business Details", "Data"]);
  });
});

test("a dialog already open, dry mode, incomplete plan: nothing clicked", async () => {
  await withPage(page({ dialogOpen: true }), async (pg, win) => {
    const out = await driver.fillBusinessDetailsTab(win, PLAN, live);
    assert.equal(out.status, "unverified_target");
    assert.equal(out.reason, "dialog_open");
    assert.deepEqual(await page_clicks(pg), []);
  });
  await withPage(page(), async (pg, win) => {
    assert.equal((await driver.fillBusinessDetailsTab(win, PLAN, { mode: "dry" })).status, "dry_run");
    const bad = await driver.fillBusinessDetailsTab(win, { ...PLAN, principalActivity: "Retail" }, live);
    assert.equal(bad.status, "unverified_target");
    assert.deepEqual(bad.problems, ["principal_activity"]);
    assert.deepEqual(await page_clicks(pg), []);
  });
});

test("click surface: the page code never touches edit / remove-brand controls", () => {
  const source = driver.businessDetailsProbe.toString();
  assert.ok(!/edit_square|badge-remove-btn|Remove brand|UPDATE/.test(source));
  assert.deepEqual(driver.SPEC.buttons, ["CLOSE", "SAVE"]);
  assert.ok(driver.acceptedDateDisplays("2013-07-05").includes("05/07/2013"));
  assert.ok(!driver.acceptedDateDisplays("2013-07-05").includes("07/05/2013"));
});

for (const [iso, table] of [["2024-07-01","01-Jul-2024"],["2024-07-05","05-Jul-2024"],["2024-02-29","29-Feb-2024"],["2024-12-31","31-Dec-2024"]]) {
 test(`unambiguous calendar date ${iso} survives dialog SAVE and saved-row readback`,async()=>{
  const plan={...PLAN,startDate:iso,typed:{startDate:iso.slice(8)+"/"+iso.slice(5,7)+"/"+iso.slice(0,4),endDate:null},table:{startDate:table,endDate:null}};
  await withPage(page({dateMode:"mdy"}),async(pg,win)=>{const out=await driver.fillBusinessDetailsTab(win,plan,live);assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.seen.startDate,table);const again=await driver.fillBusinessDetailsTab(win,plan,{...live,verifyOnly:true});assert.equal(again.status,"already_correct");assert.equal((await rows(pg)).length,1)});
 });
}
test("a truly changed calendar date is refused before SAVE",async()=>{
 await withPage(page({dateMode:"corrupt"}),async(pg,win)=>{const out=await driver.fillBusinessDetailsTab(win,PLAN,live);assert.equal(out.reason,"start_date_shown_differently");assert.equal(out.ok,false);assert.deepEqual(await rows(pg),[]);assert.ok(!(await page_clicks(pg)).includes("SAVE"))});
});
test("read-only verification never adds an absent business",async()=>{
 await withPage(page(),async(pg,win)=>{const out=await driver.fillBusinessDetailsTab(win,PLAN,{...live,verifyOnly:true});assert.equal(out.reason,"business_not_listed_on_readback");assert.deepEqual(await page_clicks(pg),["Business Details","Data"]);assert.deepEqual(await rows(pg),[])});
});
test("an impossible calendar date is rejected before any page action",async()=>{
 await withPage(page(),async(pg,win)=>{const out=await driver.fillBusinessDetailsTab(win,{...PLAN,startDate:"2023-02-29"},live);assert.equal(out.ok,false);assert.ok(out.problems.includes("start_date_iso"));assert.deepEqual(await page_clicks(pg),[])});
});
test("optional end date is also month-name typed and saved-row verified",async()=>{
 const plan={...PLAN,endDate:"2024-07-05",typed:{...PLAN.typed,endDate:"05/07/2024"},table:{...PLAN.table,endDate:"05-Jul-2024"}};
 await withPage(page({dateMode:"mdy"}),async(pg,win)=>{const out=await driver.fillBusinessDetailsTab(win,plan,live);assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.seen.endDate,"05-Jul-2024")});
});

test("a different date in the SAVED table is not counted as verified and is never auto-edited",async()=>{
 await withPage(page({dateMode:"wrong_saved"}),async(pg,win)=>{const out=await driver.fillBusinessDetailsTab(win,PLAN,live);assert.equal(out.status,"saved_differently");assert.equal(out.ok,false);assert.deepEqual(out.differences,["startDate"]);const read=await driver.fillBusinessDetailsTab(win,PLAN,{...live,verifyOnly:true});assert.equal(read.status,"differs_not_changed");assert.ok(!(await page_clicks(pg)).some(x=>x.includes("edit")))});
});
