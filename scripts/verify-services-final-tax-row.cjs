#!/usr/bin/env node
/**
 * Services row 3101 "Subject to Final Tax" (PENDING_IMPORTANT_FIXES.md #1).
 *
 * Section 154A export services are Final-Tax-Regime income. Live IRIS (run
 * job-cmw8w6yzr0157kr84ao1959a9, Computations screenshot image-13.png) showed
 * 9100 = 6,400,000 for a taxpayer whose 154A receipt of 2,800,000 was already
 * taxed at source: leaving column "Subject to Final Tax" empty makes IRIS count
 * the same money as normal-slab income again, which cost PKR 1,504,000.
 *
 * These tests run the REAL boundary — packet map builder -> server flattening ->
 * the Electron Services allowlist — because the fix is only safe if the extra
 * row is (a) emitted from 154A money alone, (b) accepted by the independent
 * Electron gate, (c) addressed at the real column, and (d) never counted twice
 * into the computations.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithAlias(request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolveFilename.call(this, request, ...rest);
};
Module._extensions[".ts"] = function loadTypeScript(module, filename) {
  const output = ts.transpileModule(read(path.relative(root, filename)), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { buildServicesPortalMappings } = require(
  path.join(root, "lib/tax/services-portal-map.ts"),
);
const { flattenPortalFieldMap } = require(
  path.join(root, "lib/tax/portal-field-map.ts"),
);
Module._resolveFilename = originalResolveFilename;

const rowFiller = require("../electron-connect/iris-row-filler.js");
const CONTRACT = require("../electron-connect/iris-services-contract.json");

const FINAL_TAX_COLUMN =
  CONTRACT.approvedServicesMapping.incomeRow3101.finalTaxColumn;
const TOTAL_COLUMN = CONTRACT.approvedServicesMapping.incomeRow3101.column;

/**
 * One invoice. `subcategory` decides the statutory section, so the withholding
 * on its payment match must be worded the way the certificate words it.
 */
const SECTION_OF_SUBCATEGORY = Object.fromEntries(
  Object.entries(CONTRACT.approvedServicesMapping.withholdingBySubcategory).map(
    ([subcategory, mapping]) => [subcategory, mapping],
  ),
);

function invoice(overrides = {}) {
  const subcategory = String(overrides.subcategory ?? "export-it-ites-pseb");
  const approved = SECTION_OF_SUBCATEGORY[subcategory];
  const match = {
    id: `match-${subcategory}`,
    withholdingTaxPkr: 7000,
    withholdingSection: approved.statutorySection,
    withholdingIrisCode: approved.irisCodes[0],
    withholdingEvidenceReference: "Withholding certificate page 1, line 2",
    withholdingEvidenceHumanConfirmed: true,
    withholdingEvidenceDocumentId: `cert-${subcategory}`,
    withholdingEvidenceDocumentExtractionStatus: "MAPPED",
    // Only these document types may evidence a withholding row; anything else is
    // demoted to a gap, so 7098 must not pick it up either.
    withholdingEvidenceDocumentType: "other_income_proof",
    ...(overrides.payment || {}),
  };
  const { payment, ...invoiceFields } = overrides;
  return {
    id: `invoice-${subcategory}`,
    subcategory,
    evidenceStatus: "CONFIRMED",
    sourceDocumentId: `doc-${subcategory}`,
    sourceDocumentExtractionStatus: "MAPPED",
    serviceDescription: "Export of IT-enabled services under the signed contract",
    serviceCategoryHumanConfirmed: true,
    serviceCategoryEvidenceReference: "Invoice page 1, service category and scope",
    incomeCharacter: "TECHNICAL_PROFESSIONAL_FEE",
    incomeCharacterHumanConfirmed: true,
    incomeCharacterEvidenceReference: "Invoice page 1, technical scope clause",
    recognizedIncomePkr: 2800000,
    paymentMatches: [match],
    ...invoiceFields,
  };
}

function mappingsFor(invoices, existingBusinessFields = []) {
  return buildServicesPortalMappings({
    invoices,
    incomeBySubcategory: invoices.reduce((acc, entry) => {
      acc[entry.subcategory] =
        (acc[entry.subcategory] ?? 0) + entry.recognizedIncomePkr;
      return acc;
    }, {}),
    existingBusinessFields,
    taxCredits: [],
  });
}

function flatten(result) {
  return flattenPortalFieldMap({
    version: "test",
    generatedAt: new Date(0).toISOString(),
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    totalFields: result.businessFields.length + result.withholdingFields.length,
    businessFields: result.businessFields,
    incomeFields: [],
    adjustableTaxFields: result.withholdingFields,
    wealthFields: [],
    computationHints: {
      totalIncome: 0,
      taxableIncome: 0,
      totalTaxWithheld: 0,
    },
    selectorBundle: { version: "test", portalType: "IRIS_2_0" },
  });
}

const rows = (fields, code) =>
  fields
    .filter((field) => field.irisCode === code)
    .map((field) => [field.column, field.value]);

test("contract: 3101 names the final-tax column and the grid says it is writable", () => {
  assert.equal(FINAL_TAX_COLUMN, "Subject to Final Tax");
  const revenues = CONTRACT.businessOtherRevenues;
  assert.deepEqual(revenues.columns, [
    "Total Amount",
    "Subject to Final Tax",
    "Subject to Exemption",
    "Subject to Normal Tax",
  ]);
  const row = revenues.rows[CONTRACT.approvedServicesMapping.incomeRow3101.irisCode];
  const finalTaxIndex = revenues.columns.indexOf(FINAL_TAX_COLUMN);
  assert.ok(row.writableInputIndexes.includes(finalTaxIndex));
  assert.ok(!row.disabledInputIndexes.includes(finalTaxIndex));
  // The derived column stays read-only: writing it would fight IRIS.
  assert.deepEqual(row.disabledInputIndexes, [
    revenues.columns.indexOf("Subject to Normal Tax"),
  ]);
});

test("Section 154A Services income emits the gross row AND the final-tax row", () => {
  const result = mappingsFor([invoice()]);
  const fields = flatten(result);

  assert.deepEqual(rows(fields, "3101"), [
    ["Total Amount", "2800000"],
    ["Subject to Final Tax", "2800000"],
  ]);
  assert.deepEqual(result.incomeGaps, []);

  // One IRIS row, two columns: the key must differ or the second write would be
  // treated as the same target and skipped/deduplicated downstream.
  const keys = fields.filter((field) => field.irisCode === "3101").map((f) => f.key);
  assert.equal(new Set(keys).size, 2, `keys must be distinct: ${keys.join(" | ")}`);
  assert.equal(
    fields.filter((field) => field.irisCode === "3101").every(
      (field) =>
        field.sourceGroup === "businessFields" &&
        field.rowDescriptionIncludes ===
          CONTRACT.approvedServicesMapping.incomeRow3101.rowLabel,
    ),
    true,
    "both entries address the same row label",
  );
});

test("the Electron allowlist accepts both 3101 entries, and only 154A money qualifies", () => {
  const fields = flatten(mappingsFor([invoice()]));
  const income = fields.filter((field) => field.irisCode === "3101");
  for (const field of income) {
    const check = rowFiller.validateServicesAutofillField(field);
    assert.equal(check.isServices, true, "the row stays inside the Services gate");
    assert.equal(check.ok, true, `${field.column}: ${check.reason || "accepted"}`);
  }
  // The withholding row of the same invoice is still accepted (the final-tax
  // column must not knock the tax-deduction row out of the same packet).
  const withholding = fields.find((field) => field.irisCode === "64060290");
  assert.equal(
    rowFiller.validateServicesAutofillField(withholding).ok,
    true,
  );
  assert.equal(withholding.portalGroup, "Final Tax");
});

test("a minimum-tax service (153(1)(b)) gets NO final-tax row", () => {
  const result = mappingsFor([
    invoice({
      subcategory: "1b-service-it-ites",
      recognizedIncomePkr: 3600000,
    }),
  ]);
  const fields = flatten(result);
  assert.deepEqual(rows(fields, "3101"), [["Total Amount", "3600000"]]);
  assert.equal(
    fields.filter((field) => field.column === FINAL_TAX_COLUMN).length,
    0,
    "normal-slab income must never be reclassified as final-tax income",
  );
});

test("mixed book: gross covers both sections, final tax only the 154A part", () => {
  const result = mappingsFor([
    invoice({ subcategory: "export-it-ites-pseb", recognizedIncomePkr: 2800000 }),
    invoice({
      subcategory: "1b-service-it-ites",
      recognizedIncomePkr: 3600000,
      payment: {
        withholdingTaxPkr: 360000,
        withholdingSection: "153(1)(b)",
        withholdingIrisCode: "64060158",
        id: "match-153",
        withholdingEvidenceDocumentId: "cert-153",
      },
    }),
  ]);
  const fields = flatten(result);
  assert.deepEqual(rows(fields, "3101"), [
    ["Total Amount", "6400000"],
    ["Subject to Final Tax", "2800000"],
  ]);
  for (const field of fields.filter((f) => f.irisCode === "3101"))
    assert.equal(rowFiller.validateServicesAutofillField(field).ok, true);
});

test("a final-tax row claiming non-154A subcategories is refused, not filled", async () => {
  const fields = flatten(mappingsFor([invoice()]));
  const finalTax = fields.find((field) => field.column === FINAL_TAX_COLUMN);
  const tampered = {
    ...finalTax,
    servicesSubcategories: ["1b-service-it-ites"],
  };
  const check = rowFiller.validateServicesAutofillField(tampered);
  assert.deepEqual(check, {
    isServices: true,
    ok: false,
    reason: "Services income does not match the human-confirmed row 3101 contract.",
  });

  // The refusal is enforced by the fill path itself, not only by the pre-check:
  // no in-page script is ever built for a row the gate rejected.
  const out = await rowFiller.fillIrisRows(null, [tampered], { dryRun: true });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].status, rowFiller.FILL_STATUS.SERVICES_MAPPING_UNVERIFIED);
  assert.equal(out.results[0].requestedColumn, FINAL_TAX_COLUMN);
  assert.equal(
    out.results[0].reason,
    "Services income does not match the human-confirmed row 3101 contract.",
  );
  assert.equal(out.summary.filled, 0, "nothing is claimed as filled");
});

test("a column the grid does not offer is refused even with a real header", () => {
  const fields = flatten(mappingsFor([invoice()]));
  const income = fields.find((field) => field.column === "Total Amount");
  for (const column of ["Subject to Exemption", "Subject to Normal Tax"]) {
    const check = rowFiller.validateServicesAutofillField({
      ...income,
      column,
      servicesSubcategories: ["export-it-ites-pseb"],
    });
    assert.equal(
      check.ok,
      false,
      `${column} must not be reachable by a Services income field`,
    );
  }
});

test("the filler targets the final-tax column by header, not by guessing", () => {
  const fields = flatten(mappingsFor([invoice()]));
  const finalTax = rowFiller.prepareField(
    fields.find((field) => field.column === FINAL_TAX_COLUMN),
  );
  const gross = rowFiller.prepareField(
    fields.find((field) => field.column === "Total Amount"),
  );
  assert.equal(finalTax.column, FINAL_TAX_COLUMN);
  assert.ok(
    finalTax.headerPatterns.includes("subject to final tax"),
    `header patterns carry the real column: ${finalTax.headerPatterns.join(" | ")}`,
  );
  assert.notEqual(finalTax.key, gross.key, "prepared fields stay addressable apart");
  assert.equal(finalTax.value, "2800000");
});

test("the final-tax row is never counted twice into the computations", () => {
  const result = mappingsFor([
    invoice({ subcategory: "export-it-ites-pseb", recognizedIncomePkr: 2800000 }),
    invoice({
      subcategory: "1b-service-it-ites",
      recognizedIncomePkr: 3600000,
      payment: {
        withholdingTaxPkr: 360000,
        withholdingSection: "153(1)(b)",
        withholdingIrisCode: "64060158",
        id: "match-153",
        withholdingEvidenceDocumentId: "cert-153",
      },
    }),
  ]);
  const sumAll = result.businessFields.reduce((s, f) => s + f.ourAmount, 0);
  // The map now carries the same money on two columns of one row, so an
  // unfiltered sum is exactly double. packet.ts must (and does) filter first.
  assert.equal(sumAll, 9200000, "without the filter the income would double");
  const totalOnly = result.businessFields
    .filter((field) => String(field.column ?? "") === TOTAL_COLUMN)
    .reduce((s, f) => s + f.ourAmount, 0);
  assert.equal(totalOnly, 6400000, "IRIS Computations 9100 must stay 6,400,000");

  const packet = read("app/actions/packet.ts");
  assert.match(
    packet,
    /mappedServicesIncomeForComputations[\s\S]{0,400}===\s*"Total Amount"/,
    "the packet sums only the gross column before the computations total",
  );
});

test("an unhuman-confirmed final-tax row is refused like any other Services row", () => {
  const fields = flatten(mappingsFor([invoice()]));
  const finalTax = fields.find((field) => field.column === FINAL_TAX_COLUMN);
  assert.equal(
    rowFiller.validateServicesAutofillField({
      ...finalTax,
      servicesHumanReviewConfirmed: false,
    }).reason,
    "Human-review confirmation is missing.",
  );
  assert.equal(
    rowFiller.validateServicesAutofillField({
      ...finalTax,
      value: "0",
    }).reason,
    "A positive verified amount is required.",
  );
});
