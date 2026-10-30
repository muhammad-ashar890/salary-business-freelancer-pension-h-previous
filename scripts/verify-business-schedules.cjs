const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path"),
  Module = require("module"),
  ts = require("typescript");
const root = path.join(__dirname, ".."),
  old = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return old.call(
    this,
    r.startsWith("@/") ? path.join(root, r.slice(2)) : r,
    ...a,
  );
};
require.extensions[".ts"] = (m, f) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(f, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    f,
  );
const b = require("../lib/tax/business-filing.ts"),
  s = require("../lib/tax/business-schedule-fields.ts"),
  map = require("../lib/tax/portal-field-map.ts"),
  contract = require("../electron-connect/iris-business-contract.json");
const values = {
  businessGrossSales: 6000000,
  businessOtherRevenue: 120000,
  businessCostOfSales: 2000000,
  businessOperatingExpenses: 1000000,
  businessDepreciation: 150000,
  businessInadmissibleExpenses: 80000,
  businessLossBroughtForward: 50000,
  businessWithholdingDeducted: 120000,
  businessSalesExcludeIndirectTax: true,
};
const annual = {
  "Business Name": "SYNTHETIC TEST BUSINESS",
  "Tax Year": 2026,
  Currency: "PKR",
  "Reporting Period Start": "2025-07-01",
  "Reporting Period End": "2026-06-30",
  "Sales for the year": 6000000,
  "Other business receipts": 120000,
  "Cost of sales": 2000000,
  "Business expenses": 1000000,
  Depreciation: 150000,
  "Expenses that are not allowed": 80000,
  "Business loss brought forward": 50000,
  "Tax already deducted on business receipts": 120000,
};
const components = {
  openingStock: 300000,
  purchases: 1850000,
  closingStock: 300000,
  otherDirect: 150000,
  purchaseBasis: true,
  rent: 240000,
  salaries: 360000,
  utilities: 120000,
  transport: 100000,
  marketing: 80000,
  bankCharges: 100000,
  scrap: 120000,
  accountingDepreciation: 150000,
  lossYear: 2025,
  ordinaryLoss: 50000,
};
function doc(overrides = {}, meta = {}) {
  const data = { ...annual, ...meta };
  for (const [k, v] of Object.entries({ ...components, ...overrides }))
    data[s.BUSINESS_SCHEDULE_LABELS[k]] = v;
  return {
    id: "synthetic-books",
    extractionStatus: "MAPPED",
    extractedData: JSON.stringify({
      fields: Object.entries(data).map(([label, value]) => ({
        label,
        value,
        confidence: 1,
      })),
    }),
  };
}
const input = (books = [doc()]) => ({
  taxYear: 2026,
  filerType: "myself",
  incomeSources: ["business"],
  selections: [
    {
      source: "business",
      subcategory: "profit-return",
      detailsJson: JSON.stringify({ userDetails: values }),
    },
  ],
  books,
});
function payload(d) {
  return JSON.parse(d.extractedData);
}
function update(d, fn) {
  let p = payload(d);
  fn(p);
  return { ...d, extractedData: JSON.stringify(p) };
}
test("all known component amounts queue to exact source-proven editable rows, not aggregate totals", () => {
  const p = b.buildBusinessPacket(input());
  assert.equal(p.version, "business-entry-v2");
  assert.equal(p.fields.length, 14);
  const amounts = Object.fromEntries(
    p.fields.map((f) => [f.irisCode, f.ourAmount]),
  );
  assert.deepEqual(amounts, {
    3009: 6000000,
    3039: 300000,
    3059: 1850000,
    3099: 300000,
    3083: 150000,
    3151: 240000,
    3154: 360000,
    3155: 100000,
    3158: 120000,
    3168: 80000,
    3180: 100000,
    3128: 120000,
    3088: 150000,
    327025: 50000,
  });
  for (const key of [
    "businessCostOfSales",
    "businessOperatingExpenses",
    "businessOtherRevenue",
    "businessLossBroughtForward",
  ])
    assert.ok(!p.pending.some((x) => x.key === key));
  for (const key of [
    "businessDepreciation",
    "businessInadmissibleExpenses",
    "businessWithholdingDeducted",
  ])
    assert.ok(p.pending.some((x) => x.key === key));
});
test("flattened packet routes new amounts into correct three separate tabs", () => {
  const p = b.buildBusinessPacket(input());
  const m = map.buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: [],
  });
  m.businessFields = p.fields;
  const f = map.flattenPortalFieldMap(m);
  assert.equal(
    f.find((x) => x.irisCode === "3128").leftSection,
    "Other Revenues",
  );
  assert.equal(
    f.find((x) => x.irisCode === "3151").leftSection,
    "Admin, Selling & Financial Expenses",
  );
  assert.equal(
    f.find((x) => x.irisCode === "327025").leftSection,
    "Adjustments",
  );
  assert.ok(
    f.every((x) => x.leftPanel === "Business" && x.column === "Total Amount"),
  );
});
test("each queue entry is backed by captured row label, header, editable column contract", () => {
  const p = b.buildBusinessPacket(input());
  for (const field of p.fields) {
    const spec = Object.values(contract).find((c) => c.tab === field.section);
    assert.ok(spec);
    assert.equal(spec.rows[field.irisCode].disabled[0], false);
    assert.equal(spec.rows[field.irisCode].label, field.irisDescription);
    assert.equal(spec.columns[0], "Total Amount");
  }
});
test("aggregate-only legacy books never acquire guessed component values", () => {
  const d = {
    ...doc(),
    extractedData: JSON.stringify({
      fields: Object.entries(annual).map(([label, value]) => ({
        label,
        value,
      })),
    }),
  };
  const p = b.buildBusinessPacket(input([d]));
  assert.deepEqual(
    p.fields.map((x) => x.irisCode),
    ["3009"],
  );
  assert.equal(p.version, "business-entry-v1");
  assert.ok(p.pending.some((x) => x.key === "businessOperatingExpenses"));
});
test("new optional review fields stay blank, with no inferred zeros or overwritten existing values", () => {
  const out = s.ensureBusinessScheduleReviewFields({
    fields: [{ label: "Business Rent", value: 240000 }],
  });
  assert.equal(
    out.fields.find((x) => x.label === "Business Rent").value,
    240000,
  );
  assert.ok(
    out.fields
      .filter((x) => x.label !== "Business Rent")
      .every((x) => x.value === null),
  );
  assert.equal(
    s.ensureBusinessScheduleReviewFields(out).fields.length,
    out.fields.length,
  );
});
test("ambiguous direct manufacturing expense stays explicit remainder, not mapped to Others", () => {
  const p = b.buildBusinessPacket(
    input([doc({ otherDirect: null, unallocatedDirect: 150000 })]),
  );
  assert.ok(!p.fields.some((x) => x.irisCode === "3083"));
  assert.ok(p.fields.some((x) => x.irisCode === "3059"));
  assert.ok(p.pending.some((x) => x.key === "businessCostOfSales"));
  assert.match(p.schedules.notes.join(" "), /150,000/);
});
test("sales-only indirect-tax exclusion never confirms purchase-tax basis", () => {
  const p = b.buildBusinessPacket(input([doc({ purchaseBasis: null })]));
  assert.ok(!p.fields.some((x) => x.irisCode === "3059"));
  assert.ok(p.pending.some((x) => x.key === "businessCostOfSales"));
});
test("short operating breakdown is not added or reinterpreted as an aggregate Others amount", () => {
  const p = b.buildBusinessPacket(input([doc({ bankCharges: null })]));
  assert.ok(
    !p.fields.some((x) => x.section === "Admin, Selling & Financial Expenses"),
  );
  assert.ok(p.pending.some((x) => x.key === "businessOperatingExpenses"));
});
test("unknown other revenue category remains manual even when aggregate is present", () => {
  const p = b.buildBusinessPacket(input([doc({ scrap: null })]));
  assert.ok(!p.fields.some((x) => x.irisCode === "3128"));
  assert.ok(p.pending.some((x) => x.key === "businessOtherRevenue"));
});
test("book depreciation is not a tax allowance or a universal tax credit", () => {
  const p = b.buildBusinessPacket(input());
  assert.ok(p.fields.some((x) => x.irisCode === "3088"));
  assert.ok(
    !p.fields.some((x) =>
      ["3248", "640000", "3238", "3030", "3199", "3200", "3129"].includes(
        x.irisCode,
      ),
    ),
  );
  // Phase 3a: book depreciation 150,000 is added back (IRIS 3238); no asset
  // schedule yet, so the estimate equals live IRIS 9100 (3,150,000).
  assert.equal(p.computedEstimate.taxableIncome, 3150000);
  assert.ok(p.schedules.notes.some((x) => x.includes("tax depreciation")));
});
for (const delta of [
  { purchaseBasis: true, otherDirect: 200000 },
  { bankCharges: 200000 },
  { scrap: 200000 },
  { ordinaryLoss: 55000 },
  { lossYear: 2026 },
  { lossYear: 2019 },
  { lossYear: 2025.5 },
  { accountingDepreciation: 100000 },
  { rent: -1 },
  { rent: "Infinity" },
  { selling: 1 },
])
  test(
    "rejects inconsistent/unsafe reviewed detail " + JSON.stringify(delta),
    () => assert.throws(() => b.buildBusinessPacket(input([doc(delta)]))),
  );
for (const delta of [
  { "Tax Year": 2025 },
  { Currency: "USD" },
  { "Business Name": "" },
  { "Reporting Period Start": "2026-01-01" },
  { "Sales for the year": 1000000 },
  { "Business expenses": 100000 },
])
  test(
    "rejects stale annual form, business identity or document period " +
      JSON.stringify(delta),
    () => assert.throws(() => b.buildBusinessPacket(input([doc({}, delta)]))),
  );
test("no origin year: no assumed loss vintage", () => {
  const p = b.buildBusinessPacket(input([doc({ lossYear: null })]));
  assert.ok(!p.fields.some((x) => x.section === "Adjustments"));
  assert.ok(p.pending.some((x) => x.key === "businessLossBroughtForward"));
});
test("no accounting context: no generic depreciation write", () => {
  const p = b.buildBusinessPacket(
    input([doc({ accountingDepreciation: null })]),
  );
  assert.ok(!p.fields.some((x) => x.irisCode === "3088"));
});
test("duplicate nonblank aliases refuse rather than sum the same source twice", () => {
  const d = update(doc(), (p) =>
    p.fields.push({ label: "Purchases for the year", value: 1850000 }),
  );
  assert.throws(() => b.buildBusinessPacket(input([d])));
});
test("duplicate current books and unapproved source refuse", () => {
  assert.throws(() => b.buildBusinessPacket(input([doc(), doc()])));
  assert.throws(() =>
    b.buildBusinessPacket(input([{ ...doc(), extractionStatus: "COMPLETED" }])),
  );
});
test("new payload is deliberately rejected by old fix43 desktop guard; old payload stays compatible", () => {
  const p = b.buildBusinessPacket(input());
  assert.notEqual(p.version, "business-entry-v1");
  const main = fs.readFileSync(
    path.join(root, "electron-connect/main.js"),
    "utf8",
  );
  assert.match(main, /\["business-entry-v1", "business-entry-v2"\]\.includes/);
  assert.match(main, /"Other Revenues": "business_other_revenues"/);
  assert.match(main, /"Admin, Selling & Financial Expenses": "business_admin"/);
  assert.match(main, /"Adjustments": "business_adjustments"/);
});
test("packet loads approved books in owned draft and extraction exposes optional canonical fields", () => {
  const packet = fs.readFileSync(
      path.join(root, "app/actions/packet.ts"),
      "utf8",
    ),
    extraction = fs.readFileSync(
      path.join(root, "app/actions/extraction.ts"),
      "utf8",
    );
  assert.match(
    packet,
    /documentType: "business_books",\s*extractionStatus: "MAPPED"/,
  );
  assert.match(packet, /books: reviewedBusinessBooks/);
  assert.match(extraction, /ensureBusinessScheduleReviewFields\(extracted\)/);
  assert.match(extraction, /Object.values\(BUSINESS_SCHEDULE_LABELS\)/);
});
function balanceSheet(name = "SYNTHETIC TEST BUSINESS") {
  const v = {
    businessName: name,
    taxYear: 2026,
    closingDate: "2026-06-30",
    currency: "PKR",
    totalAssets: 7300000,
    totalEquityLiabilities: 7300000,
    plant: 600000,
    stock: 300000,
    advances: 150000,
    cash: 100000,
    securities: 100000,
    otherAssets: 50000,
    capital: 5700000,
    loans: 1000000,
    payables: 400000,
    otherLiabilities: 200000,
    land: 800000,
    building: 1200000,
    bank: 3500000,
    vehicle: 500000,
  };
  return {
    id: "synthetic-balance",
    extractionStatus: "MAPPED",
    extractedData: JSON.stringify({
      fields: Object.entries(b.BUSINESS_BALANCE_LABELS).map(([key, label]) => ({
        label,
        value: v[key],
      })),
    }),
  };
}
test("high-profit full typed fixture forwards 24 amounts and retains only actual manual remainder", () => {
  const p = b.buildBusinessPacket({ ...input(), balanceSheet: balanceSheet() });
  assert.equal(p.fields.length, 24);
  assert.equal(p.approvedInputs.businessGrossSales, 6000000);
  // Phase 3a: book depreciation 150,000 is added back (IRIS 3238); no asset
  // schedule yet, so the estimate equals live IRIS 9100 (3,150,000).
  assert.equal(p.computedEstimate.taxableIncome, 3150000);
  assert.equal(p.fields.find((x) => x.irisCode === "3352").ourAmount, 5700000);
  for (const key of [
    "businessCostOfSales",
    "businessOperatingExpenses",
    "businessOtherRevenue",
    "businessLossBroughtForward",
  ])
    assert.ok(!p.pending.some((x) => x.key === key));
  for (const key of [
    "balanceSheet.bank",
    "balanceSheet.land",
    "balanceSheet.building",
    "balanceSheet.vehicle",
    "businessDepreciation",
    "businessInadmissibleExpenses",
    "businessWithholdingDeducted",
  ])
    assert.ok(p.pending.some((x) => x.key === key));
  assert.match(
    p.pending.find((x) => x.key === "businessDepreciation").reason,
    /queued in 3088/,
  );
});
test("books and balance sheet for different businesses cannot be merged automatically", () =>
  assert.throws(() =>
    b.buildBusinessPacket({
      ...input(),
      balanceSheet: balanceSheet("DIFFERENT BUSINESS"),
    }),
  ));

test("explicit personal reason forwards 3212 only when it fully matches the approved add-back total", () => {
  const p = b.buildBusinessPacket(input([doc({ personalAddback: 80000 })]));
  assert.equal(p.fields.find((x) => x.irisCode === "3212").ourAmount, 80000);
  assert.equal(
    p.fields.find((x) => x.irisCode === "3212").section,
    "Inadmissible/Admissible Deductions",
  );
  assert.ok(!p.pending.some((x) => x.key === "businessInadmissibleExpenses"));
  assert.throws(() =>
    b.buildBusinessPacket(input([doc({ personalAddback: 50000 })])),
  );
});
test("known personal zero does not create an unnecessary reason row", () => {
  const x = input([
    doc({ personalAddback: 0 }, { "Expenses that are not allowed": 0 }),
  ]);
  x.selections[0].detailsJson = JSON.stringify({
    userDetails: { ...values, businessInadmissibleExpenses: 0 },
  });
  const p = b.buildBusinessPacket(x);
  assert.ok(!p.fields.some((f) => f.irisCode === "3212"));
});
test("explicit full high-profit fixture now forwards 25 amounts including reason-wise personal add-back", () => {
  const p = b.buildBusinessPacket({
    ...input([doc({ personalAddback: 80000 })]),
    balanceSheet: balanceSheet(),
  });
  assert.equal(p.fields.length, 25);
  for (const key of [
    "businessCostOfSales",
    "businessOperatingExpenses",
    "businessOtherRevenue",
    "businessInadmissibleExpenses",
    "businessLossBroughtForward",
  ])
    assert.ok(!p.pending.some((x) => x.key === key));
  assert.equal(p.fields.find((x) => x.irisCode === "3212").ourAmount, 80000);
  // Phase 3a: book depreciation 150,000 is added back (IRIS 3238); no asset
  // schedule yet, so the estimate equals live IRIS 9100 (3,150,000).
  assert.equal(p.computedEstimate.taxableIncome, 3150000);
  assert.ok(p.pending.some((x) => x.key === "businessWithholdingDeducted"));
  assert.ok(p.pending.some((x) => x.key === "businessDepreciation"));
});
