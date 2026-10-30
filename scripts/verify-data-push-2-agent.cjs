"use strict";
/**
 * DP-2 (fix49): Business Balance Sheet driver (bank 3320, vehicle 3304)
 * against a page built with the structure of the IRIS 2.0 captures of
 * 15-Oct-2026 (~/iris-balance-sheet-popups: "balance sheet visible fields",
 * "3320 popup", "3304 popup"):
 *   rows `.row.tableRows.dataRow[id]`, description `.row-description-text`,
 *   one `.data-middle-child-wapper` cell; summary rows 3320 / 3304 with a
 *   disabled input and `mat-icon.btn-purple#add-balance-sheet-bank-account` /
 *   `#add-balance-sheet-motor-vehicle`; dialogs `mat-dialog-container` with
 *   `h6 .left` titles "Bank Account" / "Motor Vehicle", inputs by placeholder,
 *   `mat-checkbox` Joint Account / Foreign Currency/Others, the search icon
 *   button in `.mat-mdc-form-field-icon-suffix`, `mat-dialog-actions`
 *   CLOSE / ADD (ADD disabled until valid); child rows after ADD carry
 *   "Bank Account - <IBAN> - <title> - <bank> - Self" and
 *   "Motor Vehicle(s) - <reg> - <chassis> - <make> - <model>" with an
 *   editable input plus orange edit / red delete icons.
 * Synthetic data only (registry example IBAN, made-up vehicle).
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const driver = require("../electron-connect/iris-balance-sheet-driver.js");
const rowFiller = require("../electron-connect/iris-row-filler.js");

const IBAN = "PK36SCBL0000001123456702";
const UNKNOWN_IBAN = "PK93MEZN0000001234567890";

function balancePage({ childRows = "", jointChecked = false, openDialog = false, propertyMode = "direct", propertyCards = [] } = {}) {
  const cell = (disabled, value = "") =>
    `<div class="col-lg-4 columns-parent h-padding-0"><div class="left h-padding-0 data-middle-child-wapper"><div><span><span class="hide"></span><input class="font-14 data-middle-child form-control text-right amount-cell-input" type="text"${disabled ? " disabled" : ""} value="${value}"/></span></div></div></div>`;
  const row = (id, text, { disabled = false, icons = "", value = "", child = false } = {}) =>
    `<div class="row v-padding-5 tableRows dataRow" id="${id}"><div class="col-lg-6"><div class="${child ? "sub-child" : "font-14 h-padding-20"}"><span class="row-description-text">${text}</span></div></div><div class="col-lg-1"><span class="data-first-child font-14">${id}</span></div>${cell(disabled, value)}<div class="col-lg-1"><div class="full-width actions">${icons}</div></div></div>`;
  const purple = (id, title) => `<mat-icon class="mat-icon notranslate pointer left iconsfordlg material-icons btn-purple" id="${id}" title="${title}" onclick="openDlg('${id}')"></mat-icon>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>.hide{display:none}</style></head><body>
<div class="row heading-bar"><div><strong>Description</strong></div><div><strong>Code</strong></div><div><strong>Amount</strong></div><div><strong>Action</strong></div></div>
<div id="grid">
${row("3349", "Total Assets", { disabled: true })}
${row("3301", "Land (Business)", { disabled: true, icons: '<button class="btn-section-add" title="Select Property" type="button" onclick="openPropertySelect(\'3301\')"> + Property </button>' })}
${row("3302", "Building (Business)", { disabled: true, icons: '<button class="btn-section-add" title="Select Property" type="button" onclick="openPropertySelect(\'3302\')"> + Property </button>' })}
${row("3320", "Bank Account", { disabled: true, icons: purple("add-balance-sheet-bank-account", "Add Bank Account") })}
${childRows}
${row("3303", "Plant / Machinery / Equipment / Furniture (including fittings)")}
${row("3304", "Motor Vehicle(s)", { disabled: true, icons: purple("add-balance-sheet-motor-vehicle", "Add Motor Vehicle") })}
${row("3319", "Cash in hand")}
</div>
<div id="overlay">${openDialog ? '<mat-dialog-container role="dialog"><h6 class="mat-mdc-dialog-title"><span class="left">Notice</span></h6></mat-dialog-container>' : ""}</div>
<script>
window.clicks = [];
const KNOWN = { "${IBAN}": ["TEST TRADERS", "STANDARD CHARTERED BANK (PAKISTAN) LIMITED"] };
document.addEventListener("click", (e) => {
  const t = e.target.closest("mat-icon, button, mat-select, mat-option, .property-card, input[type=checkbox]");
  if (t) window.clicks.push(t.id || t.getAttribute("data-k") || t.textContent.trim() || t.type);
}, true);
function field(label, placeholder, max, disabled) {
  return '<mat-form-field class="mat-mdc-form-field"><mat-label>' + label + '</mat-label><input class="mat-mdc-input-element" placeholder="' + placeholder + '" maxlength="' + max + '" type="text"' + (disabled ? " disabled" : "") + '/></mat-form-field>';
}
function box(label, checked) {
  return '<mat-checkbox class="mat-mdc-checkbox account-option"><div class="mdc-form-field"><div class="mdc-checkbox"><input class="mdc-checkbox__native-control" data-k="box:' + label + '" type="checkbox"' + (checked ? " checked" : "") + '/></div><label>' + label + '</label></div></mat-checkbox>';
}
window.propertyMode = ${JSON.stringify(propertyMode)};
window.masterPropertyCards = ${JSON.stringify(propertyCards)};
function propertyLabel(code) { return code === "3301" ? "Land (Business)" : "Building (Business)"; }
function closeClosestDialog(el) { const d = el.closest("mat-dialog-container"); if (d) d.remove(); }
function addPropertyChild(code, text) {
  const exists = Array.from(document.querySelectorAll('.tableRows[id="' + code + '"]')).some((r) => r.querySelector(".row-description-text").textContent.trim() === text);
  if (!exists) addChild(code, text, code === "3301" ? "land-property" : "building-property");
}
function closeSelectDialog(el) {
  const d = el.closest("mat-dialog-container");
  if (!d) return;
  if (window.propertyMode === "checked-close") {
    const card = d.querySelector(".property-card--checked");
    if (card) addPropertyChild(d.dataset.code, card.dataset.description);
  }
  d.remove();
}
function choosePropertyCard(dlg, card) {
  if (window.propertyMode === "checked-close") {
    card.classList.add("property-card--checked");
    card.querySelector('input[type="checkbox"]').checked = true;
    return;
  }
  addPropertyChild(dlg.dataset.code, card.dataset.description);
  dlg.remove();
}
function renderPropertyCards(dlg) {
  const host = dlg.querySelector("#pre-existing-section");
  host.innerHTML = window.masterPropertyCards.map((text) => '<div class="property-card" data-description="' + text + '"><input type="checkbox"><span>' + text + '</span></div>').join("");
  host.querySelectorAll(".property-card").forEach((card) => card.addEventListener("click", () => choosePropertyCard(dlg, card)));
}
function openPropertySelect(code) {
  const dlg = document.createElement("mat-dialog-container");
  dlg.setAttribute("role", "dialog");
  dlg.dataset.code = code;
  dlg.innerHTML = '<app-select-property><h6 class="mat-mdc-dialog-title"><span class="left">Select Property</span><span class="right pointer" onclick="closeSelectDialog(this)"><mat-icon>close</mat-icon></span></h6><mat-dialog-content><input placeholder="Search Property" type="text"><div class="empty-state">Cannot find properties?</div><div id="pre-existing-section"></div></mat-dialog-content><mat-dialog-actions><button class="add-property-btn" type="button" onclick="openPropertyForm(\\'' + code + '\\')"> Add Property </button></mat-dialog-actions></app-select-property>';
  document.getElementById("overlay").appendChild(dlg);
  renderPropertyCards(dlg);
}
function propertySelectField(fieldName, label, control) {
  return '<mat-form-field class="mat-mdc-form-field"><mat-label>' + label + '</mat-label><mat-select id="mat-select-' + fieldName + '" data-field="' + fieldName + '" formcontrolname="' + control + '" aria-expanded="false"><div class="mat-mdc-select-trigger"><div class="mat-mdc-select-value"><span class="mat-mdc-select-value-text"></span></div></div></mat-select></mat-form-field>';
}
function propertyTextField(label, control, attrs) {
  return '<mat-form-field class="mat-mdc-form-field"><mat-label>' + label + '</mat-label><input class="mat-mdc-input-element" type="text" formcontrolname="' + control + '" placeholder="' + label + '"' + (attrs || "") + '></mat-form-field>';
}
function selectValue(dlg, control) {
  const el = dlg.querySelector('mat-select[formcontrolname="' + control + '"] .mat-mdc-select-value-text');
  return el ? el.textContent.trim() : "";
}
function inputValue(dlg, control) {
  const el = dlg.querySelector('input[formcontrolname="' + control + '"]');
  return el ? el.value.trim() : "";
}
function landAreaInput(dlg) {
  const field = Array.from(dlg.querySelectorAll("mat-form-field")).find((f) => f.querySelector("mat-label") && f.querySelector("mat-label").textContent.trim() === "Land area");
  return field ? field.querySelector("input") : null;
}
function validatePropertyForm(dlg) {
  const area = landAreaInput(dlg);
  const required = [selectValue(dlg, "propertyId"), selectValue(dlg, "propertySubTypeId"), selectValue(dlg, "measurementUnit"), area ? area.value.trim() : "", selectValue(dlg, "provinceId"), selectValue(dlg, "divisionId"), selectValue(dlg, "cityId"), inputValue(dlg, "address"), inputValue(dlg, "areaId")];
  dlg.querySelector('[data-k="property-save"]').disabled = !required.every(Boolean);
}
function currentPropertyOptions(dlg, fieldName) {
  if (fieldName === "propertyType") return ["Agricultural Property", "Commercial Property", "Industrial Property", "Residential Property"];
  if (fieldName === "propertySubType") return ["Constructed Property", "Farm House", "Flat", "Open Plot"];
  if (fieldName === "areaUnit") return ["Acre", "Kanal", "Marla", "Square Foot", "Square Meter", "Square Yard"];
  if (fieldName === "province") return ["Punjab", "Sindh", "Khyber Pakhtunkhwa", "Balochistan", "ICT", "AJK", "FATA", "Gilgit Baltistan"];
  if (fieldName === "district") return { Punjab: ["Attock", "Lahore"], Sindh: ["Badin", "Karachi East"] }[selectValue(dlg, "provinceId")] || [];
  if (fieldName === "city") return { Attock: ["Attock", "Fatah Jang"], Lahore: ["Gulberg Town", "Lahore"], Badin: ["Matli"], "Karachi East": ["Gulshan Town"] }[selectValue(dlg, "divisionId")] || [];
  return [];
}
function renderPropertyOptions(dlg, sel, filter) {
  const panel = document.getElementById(sel.id + "-panel");
  if (!panel) return;
  const fieldName = sel.dataset.field;
  const searchable = ["province", "district", "city"].includes(fieldName);
  let opts = currentPropertyOptions(dlg, fieldName);
  if (filter) opts = opts.filter((o) => o.toLowerCase().includes(filter.toLowerCase()));
  panel.innerHTML = (searchable ? '<div class="mat-select-search-sticky"><input class="specialSearchSelectField" placeholder="Search"></div>' : "") + opts.map((o) => '<mat-option role="option" aria-disabled="false"><span class="mdc-list-item__primary-text"> ' + o + ' </span></mat-option>').join("");
  const search = panel.querySelector(".specialSearchSelectField");
  if (search) { search.value = filter; search.addEventListener("input", () => renderPropertyOptions(dlg, sel, search.value)); }
  panel.querySelectorAll("mat-option").forEach((opt) => opt.addEventListener("click", () => {
    sel.querySelector(".mat-mdc-select-value-text").textContent = opt.textContent.trim();
    sel.setAttribute("aria-expanded", "false");
    panel.remove();
    if (fieldName === "areaUnit") { const area = landAreaInput(dlg); area.disabled = false; area.setAttribute("formcontrolname", opt.textContent.trim().toLowerCase()); }
    if (fieldName === "province") { dlg.querySelector('mat-select[formcontrolname="divisionId"] .mat-mdc-select-value-text').textContent = ""; dlg.querySelector('mat-select[formcontrolname="cityId"] .mat-mdc-select-value-text').textContent = ""; }
    if (fieldName === "district") { dlg.querySelector('mat-select[formcontrolname="cityId"] .mat-mdc-select-value-text').textContent = ""; }
    validatePropertyForm(dlg);
  }));
}
function openPropertyOptions(dlg, sel) {
  document.querySelectorAll(".cdk-overlay-pane").forEach((p) => p.remove());
  const pane = document.createElement("div");
  pane.className = "cdk-overlay-pane";
  pane.innerHTML = '<div class="mat-mdc-select-panel" id="' + sel.id + '-panel" role="listbox"></div>';
  document.body.appendChild(pane);
  sel.setAttribute("aria-expanded", "true");
  renderPropertyOptions(dlg, sel, "");
}
function savePropertyForm(code, dlg) {
  const core = [selectValue(dlg, "propertySubTypeId"), landAreaInput(dlg).value.trim() + " " + selectValue(dlg, "measurementUnit"), inputValue(dlg, "address"), inputValue(dlg, "areaId"), selectValue(dlg, "cityId"), selectValue(dlg, "divisionId"), selectValue(dlg, "provinceId")].join(", ");
  const full = propertyLabel(code) + " - " + core;
  if (!window.masterPropertyCards.includes(full)) window.masterPropertyCards.push(full);
  if (window.propertyMode === "direct") {
    addPropertyChild(code, full);
    document.querySelectorAll("mat-dialog-container").forEach((d) => d.remove());
    return;
  }
  dlg.remove();
  const selectDlg = Array.from(document.querySelectorAll("mat-dialog-container")).find((d) => d.querySelector("app-select-property"));
  if (selectDlg) renderPropertyCards(selectDlg);
}
function openPropertyForm(code) {
  const dlg = document.createElement("mat-dialog-container");
  dlg.setAttribute("role", "dialog");
  dlg.innerHTML = '<app-property-information><h6 class="mat-mdc-dialog-title"><span class="left">Property Information</span><span class="right pointer" onclick="closeClosestDialog(this)"><mat-icon>close</mat-icon></span></h6><mat-dialog-content>' +
    propertySelectField("propertyType", "Property type", "propertyId") +
    propertySelectField("propertySubType", "Property sub-type", "propertySubTypeId") +
    propertyTextField("Date of Acquisition", "dateOfPurchase", ' placeholder="DD/MM/YYYY"') +
    propertySelectField("areaUnit", "Land area unit", "measurementUnit") +
    '<mat-form-field class="mat-mdc-form-field"><mat-label>Land area</mat-label><input class="mat-mdc-input-element" type="text" disabled></mat-form-field>' +
    propertyTextField("Acquisition cost/value", "declaredCost", ' maxlength="16"') +
    '<div>Pakistan</div>' +
    propertySelectField("province", "Province / Territory", "provinceId") +
    propertySelectField("district", "District", "divisionId") +
    propertySelectField("city", "City", "cityId") +
    propertyTextField("Property/ Plot/ House/ Shop No.", "address") +
    propertyTextField("Sector / Mohalla / Block", "areaId") +
    '</mat-dialog-content><mat-dialog-actions><button type="button" data-k="property-save" disabled> Save </button></mat-dialog-actions></app-property-information>';
  document.getElementById("overlay").appendChild(dlg);
  dlg.querySelectorAll("mat-select").forEach((sel) => sel.querySelector(".mat-mdc-select-trigger").addEventListener("click", () => openPropertyOptions(dlg, sel)));
  dlg.addEventListener("input", () => validatePropertyForm(dlg), true);
  dlg.querySelector('[data-k="property-save"]').addEventListener("click", () => savePropertyForm(code, dlg));
}
function openDlg(id) {
  const bank = id === "add-balance-sheet-bank-account";
  const body = bank
    ? '<app-balance-sheet-bank-account-dialog><h6 class="mat-mdc-dialog-title dialog-header"><span class="left v-padding-top-5">Bank Account</span><span class="right"><mat-icon class="mat-icon">close</mat-icon></span></h6><mat-dialog-content><div class="account-options">' + box("Joint Account", ${jointChecked}) + box("Foreign Currency/Others", false) + '</div><mat-form-field class="mat-mdc-form-field"><mat-label>IBAN *</mat-label><input class="mat-mdc-input-element" placeholder="IBAN" maxlength="24" required type="text"/><div class="mat-mdc-form-field-icon-suffix"><button class="mdc-icon-button" data-k="search" type="button"><mat-icon class="mat-icon">search</mat-icon></button></div></mat-form-field>' + field("Account Title", "Account Title", 50, true) + field("Bank Name", "Bank Name", 50, true) + '</mat-dialog-content><mat-dialog-actions><button class="btn clear-btn-color" type="button"> CLOSE </button><button class="btn active-btn-color" type="button" disabled> ADD </button></mat-dialog-actions></app-balance-sheet-bank-account-dialog>'
    : '<app-balance-sheet-motor-vehicle-dialog><h6 class="mat-mdc-dialog-title dialog-header"><span class="left v-padding-top-5">Motor Vehicle</span><span class="right"><mat-icon class="mat-icon">close</mat-icon></span></h6><mat-dialog-content>' + field("Vehicle Registration No. *", "Vehicle Registration No.", 15) + field("Chassis No.", "Chassis No", 20) + field("Make *", "Make", 50) + field("Model *", "Model", 50) + '</mat-dialog-content><mat-dialog-actions><button class="btn clear-btn-color" type="button"> CLOSE </button><button class="btn active-btn-color" type="button" disabled> ADD </button></mat-dialog-actions></app-balance-sheet-motor-vehicle-dialog>';
  const dlg = document.createElement("mat-dialog-container");
  dlg.setAttribute("role", "dialog");
  dlg.innerHTML = body;
  document.getElementById("overlay").appendChild(dlg);
  const q = (p) => dlg.querySelector('input[placeholder="' + p + '"]');
  const [closeBtn, addBtn] = dlg.querySelectorAll("mat-dialog-actions button");
  closeBtn.addEventListener("click", () => dlg.remove());
  if (bank) {
    dlg.querySelector('[data-k="search"]').addEventListener("click", () => {
      const hit = KNOWN[q("IBAN").value];
      q("Account Title").value = hit ? hit[0] : "";
      q("Bank Name").value = hit ? hit[1] : "";
      addBtn.disabled = !hit;
    });
    addBtn.addEventListener("click", () => {
      const joint = dlg.querySelector('[data-k="box:Joint Account"]').checked;
      addChild("3320", "Bank Account - " + q("IBAN").value + " - " + q("Account Title").value + " - " + q("Bank Name").value + " - " + (joint ? "Joint" : "Self"), "bank-account");
      dlg.remove();
    });
  } else {
    const check = () => { addBtn.disabled = !(q("Vehicle Registration No.").value && q("Make").value && q("Model").value); };
    dlg.addEventListener("input", check, true);
    addBtn.addEventListener("click", () => {
      addChild("3304", "Motor Vehicle(s) - " + q("Vehicle Registration No.").value + " - " + q("Chassis No").value + " - " + q("Make").value + " - " + q("Model").value, "motor-vehicle");
      dlg.remove();
    });
  }
}
function addChild(code, text, slug) {
  const summary = Array.from(document.querySelectorAll('.tableRows[id="' + code + '"]')).pop();
  const div = document.createElement("div");
  div.innerHTML = ${JSON.stringify(row("CODE", "TEXT", { child: true, icons: '<mat-icon class="mat-icon btn-orange" id="update-balance-sheet-SLUG" title="Edit"></mat-icon><mat-icon class="mat-icon btn-red" id="showUtilityEditButton1b"></mat-icon>' }))}.replace(/CODE/g, code).replace("TEXT", text).replace("SLUG", slug);
  summary.after(div.firstElementChild);
}
</script></body></html>`;
}

const bankChild = (iban, value = "") =>
  `<div class="row v-padding-5 tableRows dataRow" id="3320"><div class="col-lg-6"><div class="sub-child"><span class="row-description-text">Bank Account - ${iban} - TEST TRADERS - STANDARD CHARTERED BANK (PAKISTAN) LIMITED - Self</span></div></div><div class="col-lg-1"><span class="data-first-child">3320</span></div><div class="col-lg-4 columns-parent"><div class="left data-middle-child-wapper"><div><span><input class="data-middle-child form-control text-right amount-cell-input" type="text" value="${value}"/></span></div></div></div><div class="col-lg-1"><div class="full-width actions"><mat-icon class="mat-icon btn-orange" id="update-balance-sheet-bank-account"></mat-icon><mat-icon class="mat-icon btn-red" id="showUtilityEditButton1b"></mat-icon></div></div></div>`;

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

// Same shape as lib/tax/business-balance-details.ts buildBalanceDetailsPlan().agentFields.
const BANK = {
  key: `3320:businessFields:Amount:Bank Account - ${IBAN} -`,
  kind: "bank", irisCode: "3320", label: `Bank Account ${IBAN}`, column: "Amount",
  value: "2500000", rowDescriptionIncludes: `Bank Account - ${IBAN} -`, iban: IBAN,
};
const VEHICLE = {
  key: "3304:businessFields:Amount:Motor Vehicle(s) - TST-123 -",
  kind: "vehicle", irisCode: "3304", label: "Motor Vehicle(s) TST-123", column: "Amount",
  value: "500000", rowDescriptionIncludes: "Motor Vehicle(s) - TST-123 -",
  registrationNo: "TST-123", chassisNo: "CH0001", make: "Suzuki", model: "Cultus 2020",
};
const LAND_PROPERTY_TEXT = "Land (Business) - Open Plot, 2 Kanal, Plot 12, Block A, Lahore, Lahore, Punjab";
const PROPERTY = {
  key: `3301:businessFields:Amount:${LAND_PROPERTY_TEXT}`,
  kind: "property", irisCode: "3301", balanceRow: "land",
  label: "Land (Business) Open Plot at Plot 12, Lahore", column: "Amount",
  value: "6000000", rowDescriptionIncludes: LAND_PROPERTY_TEXT,
  propertyType: "Commercial Property", propertySubType: "Open Plot",
  acquisitionDate: "2020-01-15", acquisitionDateIris: "15/01/2020",
  areaUnit: "Kanal", landArea: 2, landAreaText: "2", acquisitionCost: 4000000,
  province: "Punjab", district: "Lahore", city: "Lahore",
  propertyNo: "Plot 12", sectorMohallaBlock: "Block A",
};
const BUILDING_PROPERTY_TEXT = "Building (Business) - Farm House, 213 Kanal, 456, 34, Fatah Jang, Attock, Punjab";
const BUILDING_PROPERTY = {
  key: `3302:businessFields:Amount:${BUILDING_PROPERTY_TEXT}`,
  kind: "property", irisCode: "3302", balanceRow: "building",
  label: "Building (Business) Farm House at 456, Fatah Jang", column: "Amount",
  value: "9000000", rowDescriptionIncludes: BUILDING_PROPERTY_TEXT,
  propertyType: "Agricultural Property", propertySubType: "Farm House",
  areaUnit: "Kanal", landArea: 213, landAreaText: "213",
  province: "Punjab", district: "Attock", city: "Fatah Jang",
  propertyNo: "456", sectorMohallaBlock: "34",
};
const propertyChild = (text, code, value = "") =>
  `<div class="row v-padding-5 tableRows dataRow" id="${code}"><div class="col-lg-6"><div class="sub-child"><span class="row-description-text">${text}</span></div></div><div class="col-lg-1"><span class="data-first-child">${code}</span></div><div class="col-lg-4 columns-parent"><div class="left data-middle-child-wapper"><div><span><input class="data-middle-child form-control text-right amount-cell-input" type="text" value="${value}"/></span></div></div></div><div class="col-lg-1"><div class="full-width actions"><mat-icon class="mat-icon btn-orange" title="Edit Property"></mat-icon><mat-icon class="mat-icon btn-red" id="showUtilityEditButton1b"></mat-icon><mat-icon class="mat-icon btn-blue" id="propertyChildSwapBtn" title="Swap Property"></mat-icon></div></div></div>`;

const options = (win, extra = {}) => ({
  mode: "live",
  navigate: async () => ({ ok: true, status: "section_open" }),
  fillRows: (fields, opts) => rowFiller.fillIrisRows(win, fields, { dryRun: Boolean(opts && opts.dryRun) }),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
  timeoutMs: 1500,
  ...extra,
});
const rowsOf = (page, code) => page.evaluate((c) => Array.from(document.querySelectorAll(`.tableRows[id="${c}"]`)).map((r) => ({ text: r.querySelector(".row-description-text").textContent.trim(), value: r.querySelector("input").value, disabled: r.querySelector("input").disabled })), code);
const dialogCount = (page) => page.evaluate(() => document.querySelectorAll("mat-dialog-container").length);

test("live: adds the bank account and the vehicle through their dialogs, then types both amounts", async () => {
  await withPage(balancePage(), async (page, win) => {
    const steps = [];
    const out = await driver.runBalanceSheetDriver(win, [BANK, VEHICLE], options(win, { onStep: (s, d) => steps.push([s, d]) }));
    assert.deepEqual(out.results.map((r) => [r.key, r.status]), [[BANK.key, "filled"], [VEHICLE.key, "filled"]]);
    assert.ok(out.results.every((r) => r.sourceGroup === "businessFields" && r.sectionId === "business_balance_sheet"));
    assert.equal(out.results[0].bankTitleSeen, "TEST TRADERS");
    const banks = await rowsOf(page, "3320");
    assert.deepEqual(banks[1], { text: `Bank Account - ${IBAN} - TEST TRADERS - STANDARD CHARTERED BANK (PAKISTAN) LIMITED - Self`, value: "2500000", disabled: false });
    const vehicles = await rowsOf(page, "3304");
    assert.deepEqual(vehicles[1], { text: "Motor Vehicle(s) - TST-123 - CH0001 - Suzuki - Cultus 2020", value: "500000", disabled: false });
    assert.equal(await dialogCount(page), 0);
    // Only the two add icons, the search button and two ADD buttons were clicked.
    assert.deepEqual(await page.evaluate(() => window.clicks), ["add-balance-sheet-bank-account", "search", "ADD", "add-balance-sheet-motor-vehicle", "ADD"]);
    assert.ok(steps.some(([s]) => s === "balance_bank_added"));
    assert.ok(steps.some(([s]) => s === "balance_vehicle_added"));
  });
});

test("live property: adds land through Select Property + Property Information, then types the amount", async () => {
  await withPage(balancePage({ propertyMode: "direct" }), async (page, win) => {
    const steps = [];
    const out = await driver.runBalanceSheetDriver(win, [PROPERTY], options(win, { onStep: (s, d) => steps.push([s, d]) }));
    assert.deepEqual(out.results.map((r) => [r.key, r.status]), [[PROPERTY.key, "filled"]]);
    const land = (await rowsOf(page, "3301")).find((row) => row.text === LAND_PROPERTY_TEXT);
    assert.ok(land);
    assert.equal(land.value, "6000000");
    assert.equal(land.disabled, false);
    assert.equal(await dialogCount(page), 0);
    const clicks = await page.evaluate(() => window.clicks);
    assert.ok(clicks.includes("+ Property"));
    assert.ok(clicks.includes("Add Property"));
    assert.ok(clicks.includes("property-save"));
    assert.ok(!clicks.includes("Edit Property"));
    assert.ok(!clicks.includes("propertyChildSwapBtn"));
    assert.ok(steps.some(([s]) => s === "balance_property_added"));
  });
});

test("live property: when Save returns to Select Property, the exact new card is chosen once", async () => {
  await withPage(balancePage({ propertyMode: "card" }), async (page, win) => {
    const out = await driver.runBalanceSheetDriver(win, [BUILDING_PROPERTY], options(win));
    assert.equal(out.results[0].status, "filled");
    const building = (await rowsOf(page, "3302")).find((row) => row.text === BUILDING_PROPERTY_TEXT);
    assert.ok(building);
    assert.equal(building.value, "9000000");
    assert.equal(await dialogCount(page), 0);
  });
});

test("live property: a card checked in Select Property is applied only when closing creates the exact child row", async () => {
  await withPage(balancePage({ propertyMode: "checked-close" }), async (page, win) => {
    const out = await driver.runBalanceSheetDriver(win, [PROPERTY], options(win));
    assert.equal(out.results[0].status, "filled");
    assert.equal((await rowsOf(page, "3301")).find((row) => row.text === LAND_PROPERTY_TEXT).value, "6000000");
    assert.equal(await dialogCount(page), 0);
  });
});

test("live property: an existing exact property card is selected without opening Property Information", async () => {
  await withPage(balancePage({ propertyMode: "card", propertyCards: [LAND_PROPERTY_TEXT] }), async (page, win) => {
    const out = await driver.runBalanceSheetDriver(win, [PROPERTY], options(win));
    assert.equal(out.results[0].status, "filled");
    const clicks = await page.evaluate(() => window.clicks);
    assert.ok(clicks.includes("+ Property"));
    assert.ok(!clicks.includes("Add Property"));
    assert.ok(!clicks.includes("property-save"));
    assert.equal(await dialogCount(page), 0);
  });
});

test("live property: an unmatched IRIS city stops the item and both property dialogs are closed", async () => {
  await withPage(balancePage({ propertyMode: "direct" }), async (page, win) => {
    const bad = { ...PROPERTY, key: "3301:bad-city", city: "Nowhere" };
    const out = await driver.runBalanceSheetDriver(win, [bad], options(win));
    assert.equal(out.results[0].status, "balance_setup_failed");
    assert.match(out.results[0].setupStatus, /^property_city_/);
    assert.equal((await rowsOf(page, "3301")).some((row) => row.text === LAND_PROPERTY_TEXT), false);
    assert.equal(await dialogCount(page), 0);
  });
});

test("property: existing child row is reused and dry mode clicks nothing", async () => {
  await withPage(balancePage({ childRows: propertyChild(LAND_PROPERTY_TEXT, "3301", "6000000") }), async (page, win) => {
    const out = await driver.runBalanceSheetDriver(win, [PROPERTY], options(win));
    assert.equal(out.results[0].status, "already_correct");
    assert.deepEqual(await page.evaluate(() => window.clicks), []);
  });
  await withPage(balancePage(), async (page, win) => {
    const out = await driver.runBalanceSheetDriver(win, [PROPERTY], options(win, { mode: "dry" }));
    assert.equal(out.results[0].status, "balance_row_missing_dry_run");
    assert.deepEqual(await page.evaluate(() => window.clicks), []);
  });
});

test("an existing child row is reused: same amount = already correct, no dialog opened", async () => {
  await withPage(balancePage({ childRows: bankChild(IBAN, "2500000") }), async (page, win) => {
    const out = await driver.runBalanceSheetDriver(win, [BANK], options(win));
    assert.equal(out.results[0].status, "already_correct");
    assert.deepEqual(await page.evaluate(() => window.clicks), []);
    assert.equal((await rowsOf(page, "3320")).length, 2);
  });
});

test("an existing child row with a DIFFERENT amount is not overwritten", async () => {
  await withPage(balancePage({ childRows: bankChild(IBAN, "999") }), async (page, win) => {
    const out = await driver.runBalanceSheetDriver(win, [BANK], options(win));
    assert.equal(out.results[0].status, "overwrite_needs_confirmation");
    assert.equal((await rowsOf(page, "3320"))[1].value, "999");
    assert.deepEqual(await page.evaluate(() => window.clicks), []);
  });
});

test("IBAN that IRIS cannot resolve: dialog closed with CLOSE, nothing added; the vehicle still goes in", async () => {
  await withPage(balancePage(), async (page, win) => {
    const unknown = { ...BANK, key: `3320:x:${UNKNOWN_IBAN}`, iban: UNKNOWN_IBAN, rowDescriptionIncludes: `Bank Account - ${UNKNOWN_IBAN} -` };
    const out = await driver.runBalanceSheetDriver(win, [unknown, VEHICLE], options(win));
    const byKey = Object.fromEntries(out.results.map((r) => [r.key, r]));
    assert.equal(byKey[unknown.key].status, "balance_iban_not_resolved");
    assert.equal(byKey[VEHICLE.key].status, "filled");
    assert.equal((await rowsOf(page, "3320")).length, 1);
    assert.equal(await dialogCount(page), 0);
    const clicks = await page.evaluate(() => window.clicks);
    assert.deepEqual(clicks.slice(0, 3), ["add-balance-sheet-bank-account", "search", "CLOSE"]);
    assert.ok(!clicks.includes("ADD") || clicks.indexOf("ADD") > clicks.indexOf("add-balance-sheet-motor-vehicle"));
  });
});

test("Bank Account dialog that opens with Joint Account ticked is closed untouched", async () => {
  await withPage(balancePage({ jointChecked: true }), async (page, win) => {
    const out = await driver.runBalanceSheetDriver(win, [BANK], options(win));
    assert.equal(out.results[0].status, "balance_setup_failed");
    assert.equal(out.results[0].setupStatus, "bank_dialog_checkbox_state");
    assert.deepEqual(await page.evaluate(() => window.clicks), ["add-balance-sheet-bank-account", "CLOSE"]);
    assert.equal((await rowsOf(page, "3320")).length, 1);
  });
});

test("dry mode clicks nothing and reports the dialogs it would use", async () => {
  await withPage(balancePage(), async (page, win) => {
    const out = await driver.runBalanceSheetDriver(win, [BANK, VEHICLE], options(win, { mode: "dry" }));
    assert.deepEqual(out.results.map((r) => r.status), ["balance_row_missing_dry_run", "balance_row_missing_dry_run"]);
    assert.deepEqual(await page.evaluate(() => window.clicks), []);
  });
});

test("a dialog already open on the Balance Sheet: nothing is clicked", async () => {
  await withPage(balancePage({ openDialog: true }), async (page, win) => {
    const out = await driver.runBalanceSheetDriver(win, [BANK, VEHICLE], options(win));
    assert.ok(out.results.every((r) => r.status === "balance_setup_failed" && r.setupStatus === "unexpected_dialog_open"));
    assert.deepEqual(await page.evaluate(() => window.clicks), []);
  });
});

test("the click surface is closed: other ops, buttons, fields and rows are refused in Node", () => {
  assert.throws(() => driver.buildPageScript({ op: "click", kind: "bank" }), /not allowed/);
  assert.throws(() => driver.buildPageScript({ op: "dialog_click", kind: "bank", button: "SAVE" }), /not allowed/);
  assert.throws(() => driver.buildPageScript({ op: "dialog_click", kind: "bank", button: "Submit" }), /not allowed/);
  assert.throws(() => driver.buildPageScript({ op: "dialog_set", kind: "bank", field: "accountTitle", value: "X" }), /not allowed/);
  assert.throws(() => driver.buildPageScript({ op: "dialog_set", kind: "vehicle", field: "registrationNo", value: "X".repeat(16) }), /1-15/);
  assert.throws(() => driver.buildPageScript({ op: "dialog_search", kind: "vehicle" }), /only in the Bank Account/);
  assert.throws(() => driver.buildPageScript({ op: "inspect", codes: ["3303"] }), /not a DP-2 row/);
  assert.throws(() => driver.buildPageScript({ op: "open_add", kind: "land" }), /not allowed/);
  assert.doesNotThrow(() => driver.buildPageScript({ op: "inspect", codes: ["3301", "3302"] }));
  assert.doesNotThrow(() => driver.buildPageScript({ op: "property_open_select", balanceRow: "land" }));
  assert.doesNotThrow(() => driver.buildPageScript({ op: "property_set_input", field: "acquisitionDate", value: "15/01/2020" }));
  assert.throws(() => driver.buildPageScript({ op: "property_open_select", balanceRow: "house" }), /not allowed/);
  assert.throws(() => driver.buildPageScript({ op: "property_choose_option", field: "country", value: "Pakistan" }), /not allowed/);
  assert.throws(() => driver.buildPageScript({ op: "property_set_input", field: "declaredCost", value: "1" }), /not allowed/);
  assert.throws(() => driver.buildPageScript({ op: "property_set_input", field: "acquisitionDate", value: "2020-01-15" }), /DD\/MM\/YYYY/);
  assert.throws(() => driver.buildPageScript({ op: "property_close_dialog", dialogTitle: "Bank Account" }), /cannot be closed/);
  const source = driver.balancePageOp.toString();
  assert.ok(!/btn-red|btn-orange|showUtilityEditButton/.test(source), "page code never looks for edit/delete icons");
  assert.ok(!/\.click\(\)[^;]*checkbox/i.test(source), "page code never clicks a checkbox");
});

test("planBalanceWork refuses incomplete entries instead of guessing", () => {
  const plan = driver.planBalanceWork([BANK, VEHICLE, PROPERTY, { ...VEHICLE, key: "v2", make: "" }, { ...BANK, key: "b2", iban: "" }, { kind: "land", irisCode: "3301" }, { ...PROPERTY, key: "p2", city: "" }, { ...PROPERTY, key: "p3", irisCode: "3302" }]);
  assert.deepEqual(plan.banks.map((f) => f.key), [BANK.key]);
  assert.deepEqual(plan.vehicles.map((f) => f.key), [VEHICLE.key]);
  assert.deepEqual(plan.properties.map((f) => f.key), [PROPERTY.key]);
  assert.equal(plan.unsupported.length, 5);
});
