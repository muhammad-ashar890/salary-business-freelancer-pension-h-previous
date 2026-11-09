#!/usr/bin/env node
/**
 * Pension taxed as salary: its Section 149 withholding has a verified IRIS home
 * (30-Oct-2026).
 *
 * When the pensioner still works for the former employer, the pension is
 * charged on the salary slabs and the payer withholds tax under section 149.
 * 64020004 — "Salary of Employees u/s 149" in Tax Deductions > Adjustable Tax —
 * is the portal row for exactly that deduction, and its editable
 * `Tax Deducted` cell is proven by two captures
 * (lib/tax/portal-row-evidence.ts). So the credit is placed automatically,
 * once, instead of being reported as an unmapped amount the taxpayer must key.
 *
 * The same row also needs its `Taxable Amount`: the ordinary salary route is fed
 * by row 1009 and IRIS derives that cell, but a pension charged as salary is
 * written to row 1008, so the base has to be stated or the portal answers
 * "Tax Deducted on Salary cannot be greater than the Total Amount"
 * (live, 30-Oct-2026, job cmvum5bkr001613b2jplmf5km).
 *
 * The final-tax pension (149(IA), above PKR 10 million) keeps its own row
 * 64020007 and is never converted into a 149 salary credit. An exempt pension
 * carrying withholding still needs a human decision.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const assert = require("node:assert/strict");
const test = require("node:test");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(output, filename);
};

const { buildPortalFieldMap, flattenPortalFieldMap } = require("../lib/tax/portal-field-map.ts");

const PENSION = 12_000_000;
const TAX = 3_685_290;

/** A reviewed pension source; only the fields this rule reads are set. */
function pensionSource(treatment, overrides = {}) {
  return {
    version: "pension-source-v3",
    documentId: "doc-pension",
    fingerprint: "fp-1",
    annualPension: PENSION,
    grossAnnual: PENSION,
    medicalAnnual: 0,
    netAnnual: PENSION - TAX,
    reviewNote: "",
    ledgerPension: PENSION,
    taxDeducted: TAX,
    taxAlreadyInLedger: 0,
    overlapNote: null,
    creditToAdd: TAX,
    treatment,
    ageBracket: "BELOW_70",
    baseTax: 3_381_000,
    surcharge: 304_290,
    taxDue: TAX,
    ...overrides,
  };
}

function build({ treatment = "salary", taxCredits = [], certificate = null, source } = {}) {
  return buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: [
      { id: "p1", entryType: "INCOME", category: "PENSION", description: "Pension", amount: PENSION },
    ],
    taxCredits,
    salaryCertificateTaxWithheld: certificate,
    pensionSource: source ?? pensionSource(treatment),
  });
}

function fields(map) {
  return flattenPortalFieldMap(map).map((field) => ({
    code: field.irisCode,
    column: field.column,
    value: field.value,
  }));
}

// The Tax Deductions grid prints the adjustable row's cell as
// "Tax Collected / Deducted" (64020004) and the final-tax cell as
// "Tax Deducted" (64020007); both are the credit column of their row.
const taxableAmountOn = (list, code) =>
  list.filter(
    (field) => field.code === code && field.column === "Taxable Amount",
  );

const taxDeductedOn = (list, code) =>
  list.filter(
    (field) =>
      field.code === code && /Deducted/i.test(String(field.column ?? "")),
  );

test("a pension taxed as salary places its section 149 credit on 64020004", () => {
  const list = fields(build({ treatment: "salary" }));
  const credited = taxDeductedOn(list, "64020004");
  assert.equal(credited.length, 1, "exactly one 149 credit is queued");
  assert.equal(credited[0].value, String(TAX));
  // The final-tax row belongs to the other treatment only.
  assert.equal(taxDeductedOn(list, "64020007").length, 0);
});

test("the 149 row also carries the salary base, so IRIS accepts the credit", () => {
  const list = fields(build({ treatment: "salary" }));
  const base = taxableAmountOn(list, "64020004");
  assert.equal(base.length, 1, "the base is written exactly once");
  assert.equal(base[0].value, String(PENSION));
});

test("a certificate credit keeps the same single 149 row and base", () => {
  const list = fields(build({ treatment: "salary", certificate: 500_000 }));
  const base = taxableAmountOn(list, "64020004");
  assert.equal(base.length, 1, "one row, one base - never two copies");
  assert.equal(base[0].value, String(PENSION));
});

test("the base is queued before the credit, because IRIS clears a baseless row", () => {
  const list = fields(build({ treatment: "salary" }));
  const baseIndex = list.findIndex(
    (field) => field.code === "64020004" && field.column === "Taxable Amount",
  );
  const creditIndex = list.findIndex(
    (field) =>
      field.code === "64020004" && /Deducted/i.test(String(field.column ?? "")),
  );
  assert.ok(baseIndex >= 0 && creditIndex >= 0);
  assert.ok(
    baseIndex < creditIndex,
    "the row's base must be typed before its deduction",
  );
});

test("the same withholding is never queued twice", () => {
  // An explicit 149 credit already exists (for example a salary certificate
  // entered by hand): the pension statement must not add a second copy.
  const list = fields(
    build({
      treatment: "salary",
      taxCredits: [{ id: "credit-1", section: "149", subcategory: "Salary", amount: TAX }],
    }),
  );
  assert.equal(taxDeductedOn(list, "64020004").length, 1);
  assert.equal(taxDeductedOn(list, "64020004")[0].value, String(TAX));
});

test("a salary certificate keeps its own credit and the pension adds none", () => {
  const list = fields(build({ treatment: "salary", certificate: 500_000 }));
  const credited = taxDeductedOn(list, "64020004");
  assert.equal(credited.length, 1);
  assert.equal(credited[0].value, "500000");
});

test("no unmapped pension withholding gap is reported on the salary route", () => {
  const map = build({ treatment: "salary" });
  const gap = (map.mappingGaps.unmappedCategories ?? []).find(
    (item) => item.category === "PENSION_WITHHOLDING_UNMAPPED",
  );
  assert.equal(gap, undefined, "the credit now has a verified home, so it is not a gap");
});

test("the final-tax pension still uses 64020007 and never a 149 salary credit", () => {
  const list = fields(build({ treatment: "final_above_10m" }));
  const finalRow = taxDeductedOn(list, "64020007");
  assert.equal(finalRow.length, 1);
  assert.equal(finalRow[0].value, String(TAX));
  assert.equal(taxDeductedOn(list, "64020004").length, 0);
  // Row 1008 carries the exemption/final split in this treatment.
  const income = list.filter((field) => field.code === "1008");
  assert.ok(income.some((field) => field.column === "Subject to Exemption" && field.value === "10000000"));
  assert.ok(income.some((field) => field.column === "Subject to Final Tax" && field.value === "2000000"));
});

test("an exempt pension carrying real withholding still needs a human decision", () => {
  const map = build({ treatment: "exempt", source: pensionSource("exempt") });
  const gap = (map.mappingGaps.unmappedCategories ?? []).find(
    (item) => item.category === "PENSION_WITHHOLDING_UNMAPPED",
  );
  assert.ok(gap, "the amount is reported instead of being placed by guesswork");
  assert.equal(gap.totalAmount, TAX);
  assert.equal(taxDeductedOn(fields(map), "64020004").length, 0);
});

test("the salary route writes the pension into row 1008 with no exemption", () => {
  const income = fields(build({ treatment: "salary" })).filter((field) => field.code === "1008");
  assert.ok(income.some((field) => field.column === "Total Amount" && field.value === String(PENSION)));
  assert.ok(income.some((field) => field.column === "Subject to Exemption" && field.value === "0"));
  assert.ok(income.some((field) => field.column === "Subject to Final Tax" && field.value === "0"));
});

test("64020004 really is the proven editable row in the shipping evidence file", () => {
  const evidence = fs.readFileSync(path.join(root, "lib/tax/portal-row-evidence.ts"), "utf8");
  const row = evidence.match(/"64020004":\{[^}]*\}|"64020004": \{[\s\S]*?\}/);
  assert.ok(row, "64020004 is not in the portal row evidence");
  assert.match(row[0], /writeableInputIndexes: \[0, 1\]/);
  assert.match(row[0], /captureCount: 2/);
});

// ── The desktop agent must accept the packet this placement produces ──
const { pensionEntryHold } = require("../electron-connect/pension-guard.js");

function snapshotFor(treatment, taxDeducted, extraFields = []) {
  const fields = [
    { irisCode: "1008", column: "Total Amount", value: String(PENSION) },
    { irisCode: "1008", column: "Subject to Exemption", value: treatment === "salary" ? "0" : String(PENSION) },
    { irisCode: "1008", column: "Subject to Final Tax", value: "0" },
    ...extraFields,
  ];
  return {
    filing: { incomeSources: ["pension"] },
    pension: {
      version: "pension-source-v1",
      fingerprint: "a".repeat(64),
      treatment,
      annualPension: PENSION,
      taxDeducted,
      baseTax: 0,
      surcharge: 0,
      taxDue: 0,
    },
    portalFieldMapDetailed: {
      incomeFields: fields,
      adjustableTaxFields: [],
      computationHints: { pensionSourceFingerprint: "a".repeat(64) },
      mappingGaps: {},
    },
    portalFieldMap: fields,
  };
}

const salaryCells = (taxDeducted = TAX, base = PENSION) => [
  { irisCode: "64020004", column: "Taxable Amount", value: String(base) },
  { irisCode: "64020004", column: "Tax Collected / Deducted", value: String(taxDeducted) },
];

test("the desktop agent starts a salary-treatment packet with both 64020004 cells", () => {
  const hold = pensionEntryHold(snapshotFor("salary", TAX, salaryCells()));
  assert.equal(hold, null, hold?.pauseMessage);
});

test("the desktop agent refuses a credit whose row has no salary base", () => {
  // Live IRIS refusal: "Tax Deducted on Salary cannot be greater than the
  // Total Amount". The agent must stop before typing rather than reach it.
  const hold = pensionEntryHold(
    snapshotFor("salary", TAX, [
      { irisCode: "64020004", column: "Tax Collected / Deducted", value: String(TAX) },
    ]),
  );
  assert.ok(hold, "an empty Taxable Amount must stop the agent before IRIS");
  assert.match(hold.pauseMessage, /64020004/);
  assert.match(hold.pauseMessage, /Nothing was changed in FBR/);
});

test("the desktop agent refuses a base smaller than the credit", () => {
  // IRIS refuses the pair when the deduction exceeds its base, so the agent
  // stops before typing instead of discovering it in the portal.
  const hold = pensionEntryHold(snapshotFor("salary", TAX, salaryCells(TAX, 1_000)));
  assert.ok(hold, "a base below the credit must stop the agent");
});

test("the real packet the field map builds passes the agent contract", () => {
  // End to end: what the app queues is exactly what the desktop accepts.
  const map = build({ treatment: "salary" });
  const flatten = (group) =>
    (map[group] ?? []).map((entry) => ({
      irisCode: entry.irisCode,
      column: entry.column,
      value: String(entry.ourAmount),
    }));
  const snapshot = {
    filing: { incomeSources: ["pension"] },
    pension: {
      version: "pension-source-v1",
      fingerprint: "a".repeat(64),
      treatment: "salary",
      annualPension: PENSION,
      taxDeducted: TAX,
      baseTax: 3_381_000,
      surcharge: 304_290,
      taxDue: TAX,
    },
    portalFieldMapDetailed: {
      incomeFields: flatten("incomeFields"),
      adjustableTaxFields: flatten("adjustableTaxFields"),
      computationHints: { pensionSourceFingerprint: "a".repeat(64) },
      mappingGaps: map.mappingGaps,
    },
    portalFieldMap: [
      ...flatten("incomeFields"),
      ...flatten("adjustableTaxFields"),
    ],
  };
  const hold = pensionEntryHold(snapshot);
  assert.equal(hold, null, hold?.pauseMessage);
});

test("the desktop agent still refuses a salary packet without that credit", () => {
  const hold = pensionEntryHold(snapshotFor("salary", TAX));
  assert.ok(hold, "a missing 149 credit must stop the agent before IRIS");
  assert.match(hold.pauseMessage, /64020004/);
  assert.match(hold.pauseMessage, /Nothing was changed in FBR/);
});

test("the desktop agent refuses a salary packet that also carries a final-tax row", () => {
  const hold = pensionEntryHold(
    snapshotFor("salary", TAX, [
      ...salaryCells(),
      { irisCode: "64020007", column: "Tax Deducted", value: String(TAX) },
    ]),
  );
  assert.ok(hold, "the two treatments must not be mixed in one packet");
});

test("an exempt pension with withholding is still refused by the desktop agent", () => {
  const hold = pensionEntryHold(snapshotFor("exempt", TAX));
  assert.ok(hold);
  assert.match(hold.pauseMessage, /not verified by the approved source/);
});

test("a plain exempt pension with no withholding is still accepted", () => {
  assert.equal(pensionEntryHold(snapshotFor("exempt", 0)), null);
});

test("combined Salary + Pension sums both Section 149 credits on 64020004 and passes the desktop guard", () => {
  const certGross = 4_000_000;
  const certWht = 500_000;
  const map = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: [
      { id: "p1", entryType: "INCOME", category: "PENSION", description: "Pension", amount: PENSION },
    ],
    taxCredits: [],
    salaryCertificateGrossSalary: certGross,
    salaryCertificateTaxWithheld: certWht,
    pensionSource: pensionSource("salary"),
  });
  const list = fields(map);
  const base = taxableAmountOn(list, "64020004");
  const credited = taxDeductedOn(list, "64020004");
  assert.equal(base.length, 1);
  assert.equal(base[0].value, String(certGross + PENSION));
  assert.equal(credited.length, 1);
  assert.equal(credited[0].value, String(certWht + TAX));

  const flattened = flattenPortalFieldMap(map);
  const snapshot = {
    filing: { incomeSources: ["salary", "pension"] },
    pension: {
      version: "pension-source-v1",
      fingerprint: "a".repeat(64),
      treatment: "salary",
      annualPension: PENSION,
      taxDeducted: TAX,
      baseTax: 3_381_000,
      surcharge: 304_290,
      taxDue: TAX,
    },
    portalFieldMapDetailed: {
      ...map,
      computationHints: {
        ...map.computationHints,
        pensionSourceFingerprint: "a".repeat(64),
      },
    },
    portalFieldMap: flattened,
  };
  assert.equal(pensionEntryHold(snapshot), null);

  // Tampering 64020004 down to certificate-only WHT (dropping pension WHT) is caught.
  const tampered = structuredClone(snapshot);
  tampered.portalFieldMap.find(
    (f) => f.irisCode === "64020004" && f.column === "Tax Collected / Deducted",
  ).value = String(certWht);
  assert.ok(pensionEntryHold(tampered)?.paused);
});

test("combined Salary + Pension with salary-treatment zero pension WHT keeps certificate 64020004 credit", () => {
  const certGross = 2_000_000;
  const certWht = 50_000;
  const zeroPensionSource = pensionSource("salary", {
    taxDeducted: 0,
    creditToAdd: 0,
  });
  const map = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: [
      { id: "p1", entryType: "INCOME", category: "PENSION", description: "Pension", amount: PENSION },
    ],
    taxCredits: [],
    salaryCertificateGrossSalary: certGross,
    salaryCertificateTaxWithheld: certWht,
    pensionSource: zeroPensionSource,
  });
  const flattened = flattenPortalFieldMap(map);
  const credited = flattened.filter(
    (f) => f.irisCode === "64020004" && f.column === "Tax Collected / Deducted",
  );
  assert.equal(credited.length, 1);
  assert.equal(credited[0].value, String(certWht));

  const snapshot = {
    filing: { incomeSources: ["salary", "pension"] },
    pension: {
      version: "pension-source-v1",
      fingerprint: "a".repeat(64),
      treatment: "salary",
      annualPension: PENSION,
      taxDeducted: 0,
      baseTax: 0,
      surcharge: 0,
      taxDue: 0,
    },
    portalFieldMapDetailed: {
      ...map,
      computationHints: {
        ...map.computationHints,
        pensionSourceFingerprint: "a".repeat(64),
      },
    },
    portalFieldMap: flattened,
  };
  assert.equal(pensionEntryHold(snapshot), null);
});

test("pension-only salary treatment tags both 64020004 cells as PENSION_SALARY_149 for Pension + Services", () => {
  const flattened = flattenPortalFieldMap(build({ treatment: "salary" }));
  const cells = flattened.filter((f) => f.irisCode === "64020004");
  assert.equal(cells.length, 2);
  assert.ok(cells.every((f) => f.ourCategory === "PENSION_SALARY_149"));
});

test("Fix D: final_above_10m pension with actual source-deducted WHT emits 7098 outflow; nil WHT or ledger-overlapped WHT never invents or duplicates 7098", () => {
  // 1) Actual source-deducted WHT = 100,000 (not in bank TAX_PAYMENT ledger) -> 7098 = 100,000
  const withSourceWht = build({
    treatment: "final_above_10m",
    source: pensionSource("final_above_10m", {
      taxDeducted: 100_000,
      taxAlreadyInLedger: 0,
      creditToAdd: 100_000,
      baseTax: 100_000,
      surcharge: 10_000,
      taxDue: 110_000,
    }),
  });
  const outflow1 = flattenPortalFieldMap(withSourceWht).filter((f) => f.irisCode === "7098");
  assert.equal(outflow1.length, 1);
  assert.equal(outflow1[0].value, "100000");
  assert.equal(outflow1[0].rowDescriptionIncludes, "Income tax deducted u/s 149");

  // 2) Nil WHT (taxDeducted = 0, even though calculated taxDue = 110,000) -> NO 7098 emitted
  const nilWht = build({
    treatment: "final_above_10m",
    source: pensionSource("final_above_10m", {
      taxDeducted: 0,
      taxAlreadyInLedger: 0,
      creditToAdd: 0,
      baseTax: 100_000,
      surcharge: 10_000,
      taxDue: 110_000,
    }),
  });
  assert.equal(flattenPortalFieldMap(nilWht).filter((f) => f.irisCode === "7098").length, 0);

  // 3) WHT already booked in bank ledger (taxAlreadyInLedger = 100,000 -> creditToAdd = 0) -> NO duplicate 7098
  const alreadyInLedger = build({
    treatment: "final_above_10m",
    source: pensionSource("final_above_10m", {
      taxDeducted: 100_000,
      taxAlreadyInLedger: 100_000,
      creditToAdd: 0,
      baseTax: 100_000,
      surcharge: 10_000,
      taxDue: 110_000,
    }),
  });
  assert.equal(flattenPortalFieldMap(alreadyInLedger).filter((f) => f.irisCode === "7098").length, 0);

  // 4) Combined Salary + Pension sums both genuine Section 149 source deductions into one 7098 row
  const combined = buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: [
      { id: "p1", entryType: "INCOME", category: "PENSION", description: "Pension", amount: PENSION },
    ],
    taxCredits: [],
    salaryCertificateGrossSalary: 4_000_000,
    salaryCertificateTaxWithheld: 500_000,
    pensionSource: pensionSource("salary", {
      taxDeducted: 100_000,
      taxAlreadyInLedger: 0,
      creditToAdd: 100_000,
    }),
  });
  const combinedOutflow = flattenPortalFieldMap(combined).filter((f) => f.irisCode === "7098");
  assert.equal(combinedOutflow.length, 1);
  assert.equal(combinedOutflow[0].value, "600000");
});
