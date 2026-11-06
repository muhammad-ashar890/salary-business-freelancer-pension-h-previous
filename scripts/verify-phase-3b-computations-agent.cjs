"use strict";
/**
 * Phase 3b (fix51): the agent's Computations step (923184 surcharge /
 * 9231822 super tax). Rows are shaped like the live census of 15-Oct-2026
 * (Tax Chargeable / Payments > Computations) and capture 20 (E D D D inputs on
 * the two taxpayer rows). Synthetic figures only; no browser needed.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const driver = require("../electron-connect/iris-computations-driver.js");
const census = require("../electron-connect/iris-tour-census.js");
const filler = require("../electron-connect/iris-row-filler.js");

// 20m business-only: 920000 = 1,610,000 + 45% x 14.4m = 8,090,000; 10% = 809,000.
const plan = (over = {}) => ({
  version: "computations-v1",
  expectedTaxableIncome: 20_000_000,
  expectedNormalTax: 8_090_000,
  expectedBusinessIncome: 20_000_000,
  surcharge: {
    code: "923184",
    label: "Surcharge on high earning person u/s 4AB",
    action: "TYPE",
    value: 809_000,
    ratePercent: 10,
    basis: "10% of Normal Tax 8,090,000 (920000)",
    message: "",
  },
  superTax: {
    code: "9231822",
    label: "Tax on High Earning Persons u/s 4C",
    action: "NONE",
    value: 0,
    ratePercent: 0,
    basis: "income for super tax is PKR 150 million or less (0%)",
    message: "",
  },
  ...over,
});

const cell = (value, editable = false) => ({ value, editable });
const irisRows = ({ taxable = "20,000,000", normal = "8,090,000", business = "20,000,000", total = "20,000,000", surcharge = "", surchargeNormal = "", taxChargeable = null, superTax = "", surchargeEditable = true } = {}) => [
  { code: "3000", description: "Income / (Loss) from Business", cells: [cell(business), cell("0"), cell("0"), cell(business)] },
  { code: "9000", description: "Total Income", cells: [cell(total), cell("0"), cell("0"), cell(taxable)] },
  { code: "9100", description: "Taxable Income", cells: [cell(""), cell(""), cell(""), cell(taxable)] },
  { code: "920000", description: "Normal Tax", cells: [cell(""), cell(""), cell(""), cell(normal)] },
  { code: "9231822", description: "Tax on High Earning Persons u/s 4C", cells: [cell(superTax, true), cell(""), cell(""), cell("")] },
  { code: "923184", description: "Surcharge on high earning person u/s 4AB", cells: [cell(surcharge, surchargeEditable), cell(""), cell(""), cell(surchargeNormal)] },
  { code: "9200", description: "Tax Chargeable", cells: [cell(""), cell(""), cell(""), cell(taxChargeable ?? normal)] },
];

function harness(rows, { navigateOk = true, fillStatus = "filled" } = {}) {
  const calls = { navigate: [], fill: [] };
  return {
    calls,
    options: {
      mode: "live",
      taxYear: 2026,
      taxpayerIdentifier: "0000000000000",
      sleep: async () => {},
      navigate: async (_w, request) => {
        calls.navigate.push(request);
        return navigateOk ? { ok: true, status: "switched" } : { ok: false, status: "tab_not_found" };
      },
      snapshot: async () => rows,
      fill: async (_w, fields, options) => {
        calls.fill.push({ fields, options });
        return { results: fields.map((f) => ({ key: f.key, irisCode: f.irisCode, status: fillStatus, readback: f.value })) };
      },
    },
  };
}

test("the plan is refused unless it is exactly what the agent understands", () => {
  assert.deepEqual(driver.validatePlan(null), ["version"]);
  assert.deepEqual(driver.validatePlan(plan()), []);
  assert.ok(driver.validatePlan(plan({ surcharge: { ...plan().surcharge, value: 0 } })).includes("surcharge_value"));
  assert.ok(driver.validatePlan(plan({ surcharge: { ...plan().surcharge, ratePercent: 8 } })).includes("surcharge_rate"));
  assert.ok(driver.validatePlan(plan({ expectedNormalTax: null })).includes("surcharge_basis"));
  assert.ok(driver.validatePlan(plan({ surcharge: { ...plan().surcharge, code: "9200" } })).includes("surcharge_code"));
});

test("IRIS's own base equals TaxRocket's: the surcharge is typed in 'Total Income' and read back", async () => {
  const h = harness(irisRows());
  const out = await driver.fillComputations({}, plan(), h.options);
  assert.deepEqual(h.calls.navigate[0].sectionId, "computations");
  assert.equal(h.calls.fill.length, 1);
  assert.deepEqual(h.calls.fill[0].fields[0], {
    key: "computations:923184",
    irisCode: "923184",
    label: "Surcharge on high earning person u/s 4AB",
    column: "Total Income",
    value: "809000",
  });
  assert.equal(h.calls.fill[0].options.dryRun, false);
  assert.equal(out.ok, true);
  assert.equal(out.reason, "typed");
  assert.equal(out.messages.length, 0);
  const typed = out.results[0];
  assert.equal(typed.status, "filled");
  assert.equal(typed.columnIndex, 0);
  assert.equal(typed.censusView, "Tax Chargeable / Payments > Computations");
  assert.equal(typed.plannedValue, "809000");
  // The census readback after the tab switch finds exactly this cell.
  const tour = {
    views: [
      {
        key: "Tax Chargeable / Payments > Computations",
        rows: [{ code: "923184", description: "Surcharge on high earning person u/s 4AB", cells: [{ value: "809,000" }, { value: "" }, { value: "" }, { value: "" }] }],
      },
    ],
  };
  const [check] = census.compareTypedEntries(tour, out.results);
  assert.equal(check.status, "match");
});

test("IRIS's Normal Tax differs: nothing is typed; the taxpayer gets both figures and IRIS's 10%", async () => {
  const h = harness(irisRows({ normal: "8,100,000" }));
  const out = await driver.fillComputations({}, plan(), h.options);
  assert.equal(h.calls.fill.length, 0);
  assert.equal(out.results.length, 0);
  assert.equal(out.reason, "left_for_taxpayer");
  assert.match(out.messages[0], /Rs 8,100,000/);
  assert.match(out.messages[0], /Rs 8,090,000/);
  assert.match(out.messages[0], /10% of IRIS's Normal Tax is Rs 810,000/);
});

test("IRIS already computed the surcharge in Subject to Normal Tax: no manual surcharge item", async () => {
  const h = harness(irisRows({
    normal: "8,100,000",
    surchargeNormal: "810,000",
    taxChargeable: "8,910,000",
  }));
  const out = await driver.fillComputations({}, plan(), h.options);
  assert.equal(h.calls.fill.length, 0);
  assert.equal(out.ok, true);
  assert.equal(out.messages.length, 0);
  assert.equal(out.decisions[0].decision, "leave");
  assert.equal(out.decisions[0].reason, "iris_computed_in_normal_column");
  assert.match(driver.describeComputationsOutcome(out), /already computed by IRIS/);

  // The same Normal-column figure does not count when Tax Chargeable does
  // not include it: that inconsistent state is still left for review.
  const inconsistent = harness(irisRows({ normal: "8,100,000", surchargeNormal: "810,000" }));
  const other = await driver.fillComputations({}, plan(), inconsistent.options);
  assert.equal(inconsistent.calls.fill.length, 0);
  assert.equal(other.decisions[0].reason, "iris_base_differs");
  assert.equal(other.messages.length, 1);
});

test("IRIS's Taxable Income is not above 10m: the surcharge TaxRocket expected is not typed", async () => {
  const h = harness(irisRows({ taxable: "9,000,000" }));
  const out = await driver.fillComputations({}, plan(), h.options);
  assert.equal(h.calls.fill.length, 0);
  assert.equal(out.decisions[0].reason, "iris_taxable_not_above_10m");
});

test("a row already holding the same figure is already correct; a different figure is never overwritten", async () => {
  const same = harness(irisRows({ surcharge: "809,000" }));
  const a = await driver.fillComputations({}, plan(), same.options);
  assert.equal(same.calls.fill.length, 0);
  assert.equal(a.results[0].status, "already_correct");
  const other = harness(irisRows({ surcharge: "500,000" }));
  const b = await driver.fillComputations({}, plan(), other.options);
  assert.equal(other.calls.fill.length, 0);
  assert.equal(b.decisions[0].reason, "row_holds_other_figure");
  assert.match(b.messages[0], /does not overwrite/);
});

test("a disabled surcharge cell is never typed into", async () => {
  const h = harness(irisRows({ surchargeEditable: false }));
  const out = await driver.fillComputations({}, plan(), h.options);
  assert.equal(h.calls.fill.length, 0);
  assert.equal(out.decisions[0].reason, "cell_not_editable");
});

test("NONE: IRIS above 10m anyway -> the taxpayer is told; at or below 10m nothing happens", async () => {
  const none = plan({ surcharge: { ...plan().surcharge, action: "NONE", value: 0 } });
  const up = harness(irisRows());
  const a = await driver.fillComputations({}, none, up.options);
  assert.equal(up.calls.fill.length, 0);
  assert.equal(a.decisions[0].reason, "iris_taxable_above_10m");
  const low = harness(irisRows({ taxable: "3,150,000", normal: "635,000" }));
  const b = await driver.fillComputations({}, none, low.options);
  assert.equal(b.ok, true);
  assert.equal(b.reason, "nothing_due");
  assert.equal(b.messages.length, 0);
});

test("USER: the message appears only when IRIS's Taxable Income is above 10m, with 10% / 9% worked out", async () => {
  const user = plan({
    expectedTaxableIncome: null,
    expectedNormalTax: null,
    surcharge: { ...plan().surcharge, action: "USER", value: 0, ratePercent: null, message: "Surcharge (row 923184): please type it yourself." },
  });
  const up = harness(irisRows());
  const a = await driver.fillComputations({}, user, up.options);
  assert.equal(up.calls.fill.length, 0);
  assert.match(a.messages[0], /please type it yourself/);
  assert.match(a.messages[0], /Rs 809,000/);
  assert.match(a.messages[0], /Rs 728,100/);
  const low = harness(irisRows({ taxable: "3,150,000", normal: "635,000" }));
  const b = await driver.fillComputations({}, user, low.options);
  assert.equal(b.messages.length, 0);
});

test("super tax is typed only when IRIS's Income from Business equals TaxRocket's base", async () => {
  // 160m business: 1% = 1,600,000; surcharge left NONE here for clarity.
  const st = plan({
    expectedBusinessIncome: 160_000_000,
    surcharge: { ...plan().surcharge, action: "NONE", value: 0 },
    superTax: { ...plan().superTax, action: "TYPE", value: 1_600_000, ratePercent: 1, basis: "1% of 160,000,000" },
  });
  const ok = harness(irisRows({ business: "160,000,000", total: "160,000,000", taxable: "9,000,000", normal: "2,000,000" }));
  const a = await driver.fillComputations({}, st, ok.options);
  assert.equal(ok.calls.fill.length, 1);
  assert.equal(ok.calls.fill[0].fields[0].irisCode, "9231822");
  assert.equal(ok.calls.fill[0].fields[0].value, "1600000");
  assert.equal(a.results[0].irisCode, "9231822");
  const off = harness(irisRows({ business: "159,000,000", total: "159,000,000", taxable: "9,000,000", normal: "2,000,000" }));
  const b = await driver.fillComputations({}, st, off.options);
  assert.equal(off.calls.fill.length, 0);
  assert.equal(b.decisions[1].reason, "iris_base_differs");
});

test("the tab will not open: nothing typed, the taxpayer is told what to type", async () => {
  const h = harness(irisRows(), { navigateOk: false });
  const out = await driver.fillComputations({}, plan(), h.options);
  assert.equal(h.calls.fill.length, 0);
  assert.equal(out.ok, false);
  assert.match(out.reason, /^navigation_/);
  assert.match(out.messages[0], /Rs 809,000/);
});

test("typing that does not read back is reported and handed to the taxpayer", async () => {
  const h = harness(irisRows(), { fillStatus: filler.FILL_STATUS.READBACK_MISMATCH });
  const out = await driver.fillComputations({}, plan(), h.options);
  assert.equal(out.ok, false);
  assert.match(out.messages[0], /typing did not succeed/);
});

test("a dry run clicks nothing", async () => {
  const h = harness(irisRows());
  const out = await driver.fillComputations({}, plan(), { ...h.options, mode: "dry" });
  assert.equal(h.calls.navigate.length, 0);
  assert.equal(out.reason, "dry_run_nothing_clicked");
});

test("source contract: no clicks in the driver; main.js runs it before the end readback; build tags agree", () => {
  const src = fs.readFileSync(path.join(root, "electron-connect/iris-computations-driver.js"), "utf8");
  assert.doesNotMatch(src, /\.click\(/);
  assert.equal(driver.BUILD_TAG, "services-picker-aliases-20261105d");
  const main = fs.readFileSync(path.join(root, "electron-connect/main.js"), "utf8");
  const step = main.indexOf("irisComputationsDriver.fillComputations(");
  const end = main.indexOf('label: "end (readback after tab switch)"');
  const depreciation = main.indexOf("irisDepreciationDriver.fillDepreciationTab(");
  assert.ok(step > depreciation && step < end, "after the last data step, before the end census");
  assert.match(main, /\["iris-computations-driver\.js", irisComputationsDriver\.BUILD_TAG\]/);
  assert.match(main, /const AGENT_BUILD_TAG = "services-picker-aliases-20261105d"/);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "electron-connect/package.json"), "utf8"));
  for (const file of ["iris-computations-driver.js", "iris-tax-deduction-driver.js", "iris-tour-census.js", "iris-save-draft.js"])
    assert.ok(pkg.build.files.includes(file), `${file} ships in the packaged agent`);
});

test("amount parsing: blanks, commas, brackets", () => {
  assert.equal(driver.parseAmount(""), null);
  assert.equal(driver.parseAmount("8,090,000"), 8_090_000);
  assert.equal(driver.parseAmount("(1,000)"), -1000);
  assert.ok(Number.isNaN(driver.parseAmount("abc")));
});
