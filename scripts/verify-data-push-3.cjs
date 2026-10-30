"use strict";
/**
 * DP-3 (Data Push, 16-Oct-2026): tax deducted from business receipts by IRIS
 * section -- lib/tax/business-tax-deductions.ts, the section catalog
 * lib/tax/iris-tax-deduction-sections.ts, the wizard sanitizer
 * (subcategories.ts), the business packet (v5) and the IRIS expectations.
 *
 * IRIS facts used (captures 10 / 34 / 56 / 66 / 67 of 15-Oct-2026,
 * ~/iris-business-captures): panels Adjustable Tax (999913), Final Tax
 * (999915), Minimum Tax (999914); pickers "Add Adjustable Tax" (14 sections),
 * "Add Minimum Tax" (60), "Add Final Tax" (19); exact codes / names / cells.
 * Synthetic data only.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(
    this,
    request.startsWith("@/") ? path.join(root, request.slice(2)) : request,
    ...rest,
  );
};
require.extensions[".ts"] = (m, file) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    file,
  );

const td = require(path.join(root, "lib/tax/business-tax-deductions.ts"));
const filing = require(path.join(root, "lib/tax/business-filing.ts"));
const subs = require(path.join(root, "lib/tax/rules/ty2026/subcategories.ts"));
const plain = (value) => JSON.parse(JSON.stringify(value));

// Sections used below (exact IRIS strings, capture 34).
const ADJ_153B_42 = "64060116"; // Payment for Services u/s 153(1)(b) @8% u/c (42) of Part IV of Second Schedule
const MIN_GOODS_1 = "64060052"; // Payment for Goods u/s 153(1)(a) @1%
const MIN_IMPORT_1 = "64010052"; // Import u/s 148 @1% (Attributable Taxable Income editable)
const MIN_PHONES = "64120045"; // No. of imported mobile phones u/s 148 up to 30$ @ Rs. 70
const MIN_ADTT = "64050098"; // ... covered under ADTT (+ Attribute)
const FIN_154A = "64060285"; // Export of services u/s 154A @1%

test("catalog: the 93 IRIS sections of captures 34 / 56 / 66 / 67, codes unique, cells per regime", () => {
  const all = td.allTaxDeductionSections();
  assert.equal(all.length, 93);
  const count = (regime) => all.filter((s) => s.regime === regime).length;
  assert.deepEqual([count("adjustable"), count("minimum"), count("final")], [14, 60, 19]);
  assert.equal(new Set(all.map((s) => s.code)).size, 93);
  assert.ok(all.every((s) => /^\d{8}$/.test(s.code) && s.label === s.label.trim() && s.label.length > 5));
  // Exact strings / cells from capture 34.
  assert.deepEqual(plain(td.findTaxDeductionSection("adjustable", ADJ_153B_42)), {
    regime: "adjustable", code: ADJ_153B_42, cells: "EE",
    label: "Payment for Services u/s 153(1)(b) @8% u/c (42) of Part IV of Second Schedule",
  });
  assert.equal(td.findTaxDeductionSection("minimum", MIN_GOODS_1).label, "Payment for Goods u/s 153(1)(a) @1%");
  assert.equal(td.findTaxDeductionSection("minimum", MIN_GOODS_1).cells, "EEDDDD");
  assert.equal(td.findTaxDeductionSection("minimum", MIN_IMPORT_1).cells, "EEDEDD");
  assert.equal(td.findTaxDeductionSection("final", "64310066").cells, "--E", "single input in the Tax Chargeable column");
  assert.equal(td.findTaxDeductionSection("adjustable", MIN_GOODS_1), null, "a code belongs to one regime only");
  // Supported subset.
  assert.equal(td.supportedTaxDeductionSections("adjustable").length, 14);
  assert.equal(td.supportedTaxDeductionSections("minimum").length, 48);
  assert.equal(td.supportedTaxDeductionSections("final").length, 0);
  assert.equal(td.findTaxDeductionSection("minimum", MIN_PHONES).unsupported, "count_based");
  assert.equal(td.findTaxDeductionSection("minimum", "64150509").unsupported, "count_based", "s.236CA");
  assert.equal(td.findTaxDeductionSection("minimum", MIN_ADTT).unsupported, "attribute_dialog");
  assert.equal(td.findTaxDeductionSection("final", FIN_154A).unsupported, "final_regime");
  assert.ok(td.supportedTaxDeductionSections("minimum").every((s) => ["EEDDDD", "EEDEDD"].includes(s.cells)));
  assert.equal(td.supportedTaxDeductionSections("minimum").filter((s) => td.takesAttributableIncome(s)).length, 6);
  // Regime panels (captures 10 / 34) and pickers (56 / 66 / 67).
  assert.deepEqual(plain(td.IRIS_TAX_DEDUCTION_REGIMES.minimum.headers), [
    "Taxable Amount", "Tax Collected / Deducted", "Tax Chargeable", "Attributable Taxable Income",
    "Tax on Attributable Taxable Income", "Difference of Minimum Tax Chargeable",
  ]);
  assert.equal(td.IRIS_TAX_DEDUCTION_REGIMES.adjustable.headerRowId, "999913");
  assert.equal(td.IRIS_TAX_DEDUCTION_REGIMES.final.headerRowId, "999915");
  assert.equal(td.IRIS_TAX_DEDUCTION_REGIMES.minimum.headerRowId, "999914");
  assert.equal(td.IRIS_TAX_DEDUCTION_REGIMES.minimum.pickerTitle, "Add Minimum Tax");
});

test("sanitize: empty lines dropped, malformed input refused (never fixed)", () => {
  const ok = td.sanitizeBusinessTaxDeductions([
    { regime: "minimum", code: MIN_GOODS_1, taxableAmount: 2_000_000, taxDeducted: 20_000 },
    { regime: "adjustable", code: "" },
  ]);
  assert.equal(ok.ok, true);
  assert.deepEqual(plain(ok.rows), [{ regime: "minimum", code: MIN_GOODS_1, taxableAmount: 2_000_000, taxDeducted: 20_000 }]);
  assert.deepEqual(plain(td.sanitizeBusinessTaxDeductions(undefined)), { ok: true, rows: [] });
  for (const [bad, message] of [
    ["x", /must be a list/],
    [[{ regime: "other", code: MIN_GOODS_1 }], /IRIS type/],
    [[{ regime: "minimum", code: 64060052 }], /must be text/],
    [[{ regime: "minimum", code: "153(1)(a)" }], /not an IRIS tax section code/],
    [[{ regime: "minimum", code: MIN_GOODS_1, taxableAmount: -5 }], /positive number/],
    [[{ regime: "minimum", code: MIN_GOODS_1, taxDeducted: 10.5 }], /whole rupees/],
    [Array.from({ length: 31 }, () => ({ regime: "adjustable", code: ADJ_153B_42 })), /at most 30/],
  ]) {
    const out = td.sanitizeBusinessTaxDeductions(bad);
    assert.equal(out.ok, false, JSON.stringify(bad).slice(0, 60));
    assert.match(out.error, message);
  }
});

test("validate: section, amounts, duplicates, unsupported sections and the attributable cell", () => {
  const good = [
    { regime: "adjustable", code: ADJ_153B_42, taxableAmount: 500_000, taxDeducted: 40_000 },
    { regime: "minimum", code: MIN_IMPORT_1, taxableAmount: 1_000_000, taxDeducted: 10_000, attributableIncome: 150_000 },
  ];
  assert.deepEqual(td.validateBusinessTaxDeductions(good), []);
  const problems = (rows) => td.validateBusinessTaxDeductions(rows).join(" | ");
  assert.match(problems([{ regime: "minimum", code: "" }]), /choose the IRIS section/);
  assert.match(problems([{ regime: "adjustable", code: MIN_GOODS_1, taxableAmount: 1, taxDeducted: 1 }]), /not an IRIS adjustable tax section/);
  assert.match(problems([{ regime: "final", code: FIN_154A, taxableAmount: 9, taxDeducted: 1 }]), /Subject to Final Tax.*Leave it out/);
  assert.match(problems([{ regime: "minimum", code: MIN_PHONES, taxableAmount: 9, taxDeducted: 1 }]), /asks a number/);
  assert.match(problems([{ regime: "minimum", code: MIN_ADTT, taxableAmount: 9, taxDeducted: 1 }]), /\+ Attribute/);
  assert.match(problems([{ regime: "minimum", code: MIN_GOODS_1 }]), /enter the taxable amount.*enter the tax deducted/);
  assert.match(problems([{ regime: "minimum", code: MIN_GOODS_1, taxableAmount: 0, taxDeducted: 0 }]), /more than zero.*more than zero/);
  assert.match(problems([{ regime: "minimum", code: MIN_GOODS_1, taxableAmount: 100, taxDeducted: 200 }]), /more than the taxable amount/);
  assert.match(problems([good[0], good[0]]), /listed twice/);
  assert.match(
    problems([{ regime: "minimum", code: MIN_GOODS_1, taxableAmount: 100, taxDeducted: 1, attributableIncome: 5 }]),
    /does not take "Attributable Taxable Income"/,
  );
});

test("totals: more than the reviewed total is refused; less leaves a remainder", () => {
  const rows = [{ regime: "minimum", code: MIN_GOODS_1, taxableAmount: 2_000_000, taxDeducted: 100_000 }];
  assert.deepEqual(plain(td.compareWithWithholdingTotal(rows, 120_000)), { problems: [], remainder: 20_000 });
  assert.deepEqual(plain(td.compareWithWithholdingTotal(rows, 100_000)), { problems: [], remainder: 0 });
  assert.match(td.compareWithWithholdingTotal(rows, 90_000).problems[0], /more than "Tax already deducted/);
  assert.match(td.compareWithWithholdingTotal(rows, null).problems[0], /is empty/);
  assert.deepEqual(plain(td.compareWithWithholdingTotal([], 50)), { problems: [], remainder: 50 });
});

test("plan: IRIS order, one agent entry per section with exact column indexes", () => {
  const plan = plain(td.buildTaxDeductionsPlan([
    { regime: "minimum", code: MIN_IMPORT_1, taxableAmount: 1_000_000, taxDeducted: 10_000, attributableIncome: 150_000 },
    { regime: "minimum", code: MIN_GOODS_1, taxableAmount: 2_000_000, taxDeducted: 20_000 },
    { regime: "adjustable", code: ADJ_153B_42, taxableAmount: 500_000, taxDeducted: 40_000 },
  ]));
  assert.equal(plan.version, "tax-deductions-v1");
  assert.deepEqual(plan.agentFields.map((f) => f.irisCode), [ADJ_153B_42, MIN_IMPORT_1, MIN_GOODS_1], "panel order, then IRIS list order");
  assert.deepEqual(plan.totals, { taxDeducted: 70_000, adjustable: 40_000, minimum: 30_000 });
  const adj = plan.agentFields[0];
  assert.deepEqual(
    { panel: adj.panelTitle, picker: adj.pickerTitle, header: adj.headerRowId, cells: adj.cells, values: adj.values },
    {
      panel: "Adjustable Tax", picker: "Add Adjustable Tax", header: "999913", cells: "EE",
      values: [
        { columnIndex: 0, column: "Taxable Amount", value: "500000" },
        { columnIndex: 1, column: "Tax Deducted", value: "40000" },
      ],
    },
  );
  assert.deepEqual(plan.agentFields[1].values, [
    { columnIndex: 0, column: "Taxable Amount", value: "1000000" },
    { columnIndex: 1, column: "Tax Collected / Deducted", value: "10000" },
    { columnIndex: 3, column: "Attributable Taxable Income", value: "150000" },
  ]);
  assert.equal(plan.agentFields[2].values.length, 2, "attributable cell is computed for 153(1)(a): not typed");
  assert.equal(plan.agentFields[2].key, `${MIN_GOODS_1}:taxDeduction`);
  assert.throws(() => td.buildTaxDeductionsPlan([{ regime: "minimum", code: MIN_GOODS_1 }]), /enter the taxable amount/);
});

test("wizard sanitizer keeps the list; a broken stored list is left out", () => {
  const rows = [{ regime: "minimum", code: MIN_GOODS_1, taxableAmount: 2_000_000, taxDeducted: 20_000 }];
  const kept = subs.parsePersistedSelectionUserDetails(JSON.stringify({ userDetails: { businessGrossSales: 1, businessTaxDeductions: rows } }));
  assert.deepEqual(plain(kept.businessTaxDeductions), rows);
  const broken = subs.parsePersistedSelectionUserDetails(JSON.stringify({ userDetails: { businessGrossSales: 1, businessTaxDeductions: [{ regime: "x" }] } }));
  assert.equal(broken.businessTaxDeductions, undefined);
});

// Packet: same synthetic business figures as DP-1 / DP-2 (no Business Books,
// so the agent types only 3009 and IRIS's taxable income is 6,000,000).
const VALUES = {
  businessGrossSales: 6_000_000, businessOtherRevenue: 120_000, businessCostOfSales: 2_000_000,
  businessOperatingExpenses: 1_000_000, businessDepreciation: 150_000, businessInadmissibleExpenses: 80_000,
  businessLossBroughtForward: 50_000, businessWithholdingDeducted: 120_000, businessSalesExcludeIndirectTax: true,
};
const packetInput = (extra = {}) => ({
  taxYear: 2026,
  filerType: "myself",
  incomeSources: ["business"],
  selections: [{ source: "business", subcategory: "profit-return", detailsJson: JSON.stringify({ userDetails: { ...VALUES, ...extra } }) }],
});
const row = (p, code) => p.expectedIrisTotals.rows.find((r) => r.code === code);
const skipped = (p, code) => p.expectedIrisTotals.skipped.find((r) => r.code === code);

test("packet without a list is unchanged: the 120k stays a manual item, no taxDeductions", () => {
  const p = plain(filing.buildBusinessPacket(packetInput()));
  assert.equal(p.taxDeductions, null);
  assert.notEqual(p.version, "business-entry-v5");
  assert.ok(p.pending.some((i) => i.key === "businessWithholdingDeducted" && i.amount === 120_000));
  assert.equal(row(p, "9100").expected, 6_000_000);
  assert.equal(row(p, "9200").expected, row(p, "920000").expected);
  assert.equal(row(p, "9200").expected, 1_790_000, "Division I slab on 6,000,000");
});

test("packet v5, adjustable section = the full total: manual item gone, 9200 kept but not yet proven", () => {
  const p = plain(filing.buildBusinessPacket(packetInput({
    businessTaxDeductions: [{ regime: "adjustable", code: ADJ_153B_42, taxableAmount: 1_500_000, taxDeducted: 120_000 }],
  })));
  assert.equal(p.version, "business-entry-v5");
  assert.equal(p.taxDeductions.agentFields.length, 1);
  assert.ok(!p.pending.some((i) => i.key === "businessWithholdingDeducted"));
  assert.ok(!p.pending.some((i) => i.key === "businessMinimumTaxCheck"));
  assert.ok(!p.fields.some((f) => /^64/.test(f.irisCode)), "sections are never queued as ordinary fields");
  assert.equal(row(p, "9200").expected, 1_790_000);
  assert.equal(row(p, "9200").proven, false);
  assert.match(row(p, "9200").formula, /credit/);
  assert.equal(row(p, "9100").expected, 6_000_000, "withholding does not change taxable income");
});

test("packet v5, minimum section with a remainder: only the unlisted remainder stays manual", () => {
  const p = plain(filing.buildBusinessPacket(packetInput({
    businessTaxDeductions: [{ regime: "minimum", code: MIN_GOODS_1, taxableAmount: 6_000_000, taxDeducted: 60_000 }],
  })));
  assert.equal(p.version, "business-entry-v5");
  const rest = p.pending.find((i) => i.key === "businessWithholdingDeducted");
  assert.equal(rest.amount, 60_000);
  assert.match(rest.reason, /not listed by section/);
  assert.ok(!p.pending.some((i) => i.key === "businessMinimumTaxCheck"), "the listed minimum total is not a separate manual item");
  assert.equal(row(p, "9200"), undefined);
  assert.match(skipped(p, "9200").reason, /minimum-tax/);
  assert.equal(row(p, "920000").proven, false);
});

test("packet refuses a list above the total, an invalid list, or a list without the total", () => {
  const above = [{ regime: "adjustable", code: ADJ_153B_42, taxableAmount: 1_500_000, taxDeducted: 130_000 }];
  assert.throws(() => filing.buildBusinessPacket(packetInput({ businessTaxDeductions: above })), /more than "Tax already deducted/);
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessTaxDeductions: [{ regime: "final", code: FIN_154A, taxableAmount: 9, taxDeducted: 1 }] })),
    /Tax deducted by section: .*Subject to Final Tax/,
  );
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessWithholdingDeducted: undefined, businessTaxDeductions: [{ regime: "adjustable", code: ADJ_153B_42, taxableAmount: 10, taxDeducted: 1 }] })),
    /is empty/,
  );
});

test("the agent accepts every section the app can plan, and refuses the ones it does not type", () => {
  const driver = require(path.join(root, "electron-connect/iris-tax-deduction-driver.js"));
  for (const regime of ["adjustable", "final", "minimum"]) {
    const app = td.IRIS_TAX_DEDUCTION_REGIMES[regime];
    const agent = driver.REGIMES[regime];
    assert.deepEqual(
      { panelTitle: app.panelTitle, headerRowId: app.headerRowId, pickerTitle: app.pickerTitle, headers: [...app.headers] },
      { panelTitle: agent.panelTitle, headerRowId: agent.headerRowId, pickerTitle: agent.pickerTitle, headers: [...agent.headers] },
      regime,
    );
  }
  for (const regime of ["adjustable", "minimum"]) {
    for (const section of td.supportedTaxDeductionSections(regime)) {
      const row = { regime, code: section.code, taxableAmount: 100_000, taxDeducted: 1_000 };
      if (td.takesAttributableIncome(section)) row.attributableIncome = 5_000;
      const [agentField] = plain(td.buildTaxDeductionsPlan([row]).agentFields);
      const checked = driver.prepareTaxDeductionField(agentField);
      assert.equal(checked.valid, true, `${section.code}: ${checked.problems.join(", ")}`);
    }
  }
  const unsupported = td.allTaxDeductionSections().filter((s) => s.unsupported);
  assert.equal(unsupported.length, 31);
  for (const section of unsupported) {
    const fake = {
      key: `${section.code}:taxDeduction`, regime: section.regime, irisCode: section.code, label: section.label,
      panelTitle: td.IRIS_TAX_DEDUCTION_REGIMES[section.regime].panelTitle,
      pickerTitle: td.IRIS_TAX_DEDUCTION_REGIMES[section.regime].pickerTitle,
      headerRowId: td.IRIS_TAX_DEDUCTION_REGIMES[section.regime].headerRowId,
      headers: [...td.IRIS_TAX_DEDUCTION_REGIMES[section.regime].headers], cells: section.cells,
      values: [{ columnIndex: 0, column: "Taxable Amount", value: "1" }, { columnIndex: 1, column: td.IRIS_TAX_DEDUCTION_REGIMES[section.regime].headers[1], value: "1" }],
    };
    // Defence in depth: the agent refuses every section the app refuses.
    assert.equal(driver.prepareTaxDeductionField(fake).valid, false, section.code);
  }
});
