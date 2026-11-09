#!/usr/bin/env node
/**
 * Services tax deducted at source on the Wealth Statement (PENDING_IMPORTANT_FIXES.md #2).
 *
 * Live IRIS run job-cmw8w6yzr0157kr84ao1959a9: every field matched and the
 * return saved, but section 116 closed at 703000 = -7,000 — exactly the Section
 * 154A withholding on the export invoice. The payer kept that money at source,
 * so it never left the bank as a debit and the ledger cannot report it; it also
 * cannot be conjured to make the statement balance (the no-jugaar rule). It is
 * filed because the certificate proves it, one row per statutory section, and it
 * is the same figure the 64060290 tax-deduction row carries.
 *
 * These tests pin the packet side: which rows appear, what they are worded, that
 * the employer's Section 149 row is untouched, and that an unproven withholding
 * gap produces no row at all.
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

const { buildPortalFieldMap, flattenPortalFieldMap } = require(
  path.join(root, "lib/tax/portal-field-map.ts"),
);
const {
  WEALTH_TAX_OUTFLOW_CODE,
  WEALTH_TAX_OUTFLOW_DESCRIPTION,
  servicesWithholdingOutflowDescription,
} = require(path.join(root, "lib/tax/wealth-rows.ts"));
const { buildServicesPortalMappings } = require(
  path.join(root, "lib/tax/services-portal-map.ts"),
);
Module._resolveFilename = originalResolveFilename;

const rowFiller = require("../electron-connect/iris-row-filler.js");

const map = (overrides = {}) =>
  buildPortalFieldMap({
    taxYear: 2026,
    filerType: "myself",
    taxpayerListStatus: "ATL",
    ledgerEntries: [],
    ...overrides,
  });

const outflows = (overrides) =>
  flattenPortalFieldMap(map(overrides)).filter(
    (field) => field.irisCode === WEALTH_TAX_OUTFLOW_CODE,
  );

test("description wording: one recognisable row per statutory section", () => {
  assert.equal(
    servicesWithholdingOutflowDescription("154A"),
    "Income tax deducted u/s 154A",
  );
  assert.equal(
    servicesWithholdingOutflowDescription(" 153(1)(b) "),
    "Income tax deducted u/s 153(1)(b)",
  );
  // The whole point of the wording: it must not be a substring of the employer's
  // 149 row, or the row filler would read one row as satisfying both.
  const normalise = (text) => String(text).toLowerCase().replace(/\s+/g, " ").trim();
  for (const section of ["154A", "153(1)(b)", "153(2)"])
    assert.equal(
      normalise(servicesWithholdingOutflowDescription(section)).includes(
        normalise(WEALTH_TAX_OUTFLOW_DESCRIPTION),
      ),
      false,
      `${section} must stay addressable apart from 149`,
    );
});

test("a gated Services withholding becomes its own 7098 outflow row", () => {
  const fields = outflows({
    servicesTaxDeductedAtSource: [
      { section: "154A", amount: 7000, sourceEntryCount: 2 },
    ],
  });
  assert.equal(fields.length, 1);
  const field = fields[0];
  assert.equal(field.value, "7000");
  assert.equal(field.rowDescriptionIncludes, "Income tax deducted u/s 154A");
  assert.equal(field.label, "Adjustments in Outflows - Income tax deducted u/s 154A");
  assert.equal(field.column, "Amount");
  assert.equal(field.portalArea, "116 - Wealth Statement");
  assert.equal(field.irisSection, "Reconciliation of Net Assets");
  assert.equal(field.sourceGroup, "wealthFields");
  assert.equal(field.isTaxField, false);
  // Not Services-coded: the Electron Services allowlist owns the income and tax
  // grids. A wealth row carrying those tags would be refused as an unknown kind.
  assert.equal(field.servicesMappingKind, undefined);
  assert.equal(
    rowFiller.validateServicesAutofillField(field).isServices,
    false,
    "the Services gate must not claim this row",
  );
  assert.equal(
    field.ourCategory.startsWith("SERVICES_"),
    false,
    "a SERVICES_ category alone would route it into the Services gate",
  );
});

test("the employer's Section 149 row is kept byte-identical and separate", () => {
  const fields = outflows({
    salaryCertificateTaxWithheld: 360000,
    servicesTaxDeductedAtSource: [{ section: "154A", amount: 7000 }],
  });
  assert.deepEqual(
    fields.map((field) => [field.rowDescriptionIncludes, field.value]),
    [
      ["Income tax deducted u/s 149", "360000"],
      ["Income tax deducted u/s 154A", "7000"],
    ],
    "no merging into one row: the saved draft must still verify as already-correct",
  );
  assert.equal(new Set(fields.map((field) => field.key)).size, 2, "distinct targets");
  assert.equal(
    fields[0].rowDescriptionIncludes,
    WEALTH_TAX_OUTFLOW_DESCRIPTION,
    "the 149 wording is exactly the constant the driver matches on",
  );
});

test("two withholding sections in one book become two rows, in evidence order", () => {
  const fields = outflows({
    servicesTaxDeductedAtSource: [
      { section: "154A", amount: 7000 },
      { section: "153(1)(b)", amount: 360000 },
      { section: "153(2)", amount: 12500 },
    ],
  });
  assert.deepEqual(
    fields.map((field) => [field.rowDescriptionIncludes, field.value]),
    [
      ["Income tax deducted u/s 154A", "7000"],
      ["Income tax deducted u/s 153(1)(b)", "360000"],
      ["Income tax deducted u/s 153(2)", "12500"],
    ],
  );
  assert.equal(
    map({
      servicesTaxDeductedAtSource: [
        { section: "154A", amount: 7000 },
        { section: "153(1)(b)", amount: 360000 },
      ],
    }).totalFields,
    2,
    "the extra rows are counted in totalFields, so the agent expects them",
  );
});

test("nothing is invented: zero, negative and unlabelled amounts emit no row", () => {
  for (const bad of [
    [{ section: "154A", amount: 0 }],
    [{ section: "154A", amount: -7000 }],
    [{ section: "154A", amount: Number.NaN }],
    [{ section: "", amount: 7000 }],
    [{ amount: 7000 }],
    [],
    undefined,
  ]) {
    assert.deepEqual(
      outflows({ servicesTaxDeductedAtSource: bad }),
      [],
      `${JSON.stringify(bad)} must not touch the return`,
    );
  }
  // Salary alone still produces exactly the one 149 row.
  assert.deepEqual(
    outflows({ salaryCertificateTaxWithheld: 360000 }).map((f) => f.value),
    ["360000"],
  );
});

// ── the packet's own input: only evidence-gated withholding may be summed ────
const SECTION_OF_SUBCATEGORY = Object.fromEntries(
  Object.entries(
    require("../electron-connect/iris-services-contract.json").approvedServicesMapping
      .withholdingBySubcategory,
  ).map(([subcategory, entry]) => [subcategory, entry]),
);

function serviceInvoice(overrides = {}) {
  const approved =
    SECTION_OF_SUBCATEGORY[String(overrides.subcategory ?? "export-it-ites-pseb")];
  const match = {
    id: "match-1",
    withholdingTaxPkr: 7000,
    withholdingSection: approved.statutorySection,
    withholdingIrisCode: approved.irisCodes[0],
    withholdingEvidenceReference: "Withholding certificate page 1, line 2",
    withholdingEvidenceHumanConfirmed: true,
    withholdingEvidenceDocumentId: "cert-1",
    withholdingEvidenceDocumentExtractionStatus: "MAPPED",
    withholdingEvidenceDocumentType: "other_income_proof",
    ...(overrides.payment || {}),
  };
  const { payment, ...rest } = overrides;
  return {
    id: "invoice-1",
    subcategory: "export-it-ites-pseb",
    evidenceStatus: "CONFIRMED",
    sourceDocumentId: "doc-1",
    sourceDocumentExtractionStatus: "MAPPED",
    serviceDescription: "Export of IT-enabled services under the signed contract",
    serviceCategoryHumanConfirmed: true,
    serviceCategoryEvidenceReference: "Invoice page 1, service category and scope",
    incomeCharacter: "TECHNICAL_PROFESSIONAL_FEE",
    incomeCharacterHumanConfirmed: true,
    incomeCharacterEvidenceReference: "Invoice page 1, technical scope clause",
    recognizedIncomePkr: 2800000,
    paymentMatches: [match],
    ...rest,
  };
}

/** The grouping `app/actions/packet.ts` performs, run on real map output. */
function groupBySection(withholdingFields) {
  const groups = new Map();
  for (const field of withholdingFields) {
    const section = String(field.servicesStatutorySection ?? "").trim();
    const amount = Math.round(Number(field.ourAmount ?? 0));
    if (!section || !Number.isFinite(amount) || amount <= 0) continue;
    const group = groups.get(section);
    if (group) group.amount += amount;
    else groups.set(section, { section, amount });
  }
  return Array.from(groups.values());
}

test("certificate-proved withholding feeds 7098 with the same figure as the tax row", () => {
  const result = buildServicesPortalMappings({
    invoices: [
      serviceInvoice(),
      serviceInvoice({
        id: "invoice-2",
        subcategory: "1b-service-it-ites",
        recognizedIncomePkr: 3600000,
        payment: {
          id: "match-2",
          withholdingTaxPkr: 360000,
          withholdingEvidenceDocumentId: "cert-2",
        },
      }),
    ],
    incomeBySubcategory: { "export-it-ites-pseb": 2800000, "1b-service-it-ites": 3600000 },
    existingBusinessFields: [],
    taxCredits: [],
  });
  assert.equal(result.withholdingGaps.length, 0);

  const groups = groupBySection(result.withholdingFields);
  assert.deepEqual(groups, [
    { section: "154A", amount: 7000 },
    { section: "153(1)(b)", amount: 360000 },
  ]);

  const fields = outflows({
    salaryCertificateTaxWithheld: 360000,
    servicesTaxDeductedAtSource: groups,
  });
  assert.deepEqual(
    fields.map((field) => [field.rowDescriptionIncludes, field.value]),
    [
      ["Income tax deducted u/s 149", "360000"],
      ["Income tax deducted u/s 154A", "7000"],
      ["Income tax deducted u/s 153(1)(b)", "360000"],
    ],
    "the live -7,000 gap closes without touching the 149 row",
  );
  // Every rupee written here is also on an evidenced tax-deduction row.
  const withheld = result.withholdingFields.reduce(
    (sum, field) => sum + Number(field.ourAmount),
    0,
  );
  assert.equal(
    fields
      .filter((field) => field.rowDescriptionIncludes !== WEALTH_TAX_OUTFLOW_DESCRIPTION)
      .reduce((sum, field) => sum + Number(field.value), 0),
    withheld,
    "7098 Services rows total exactly the withholding the certificates prove",
  );
});

test("an unproved withholding is a gap only — no row, so no balancing figure", () => {
  const result = buildServicesPortalMappings({
    invoices: [
      serviceInvoice({
        // A document type outside the allowlist cannot evidence a withholding:
        // the map demotes the amount to a gap instead of writing a row.
        payment: { withholdingEvidenceDocumentType: "freelancer_withholding_certificate" },
      }),
    ],
    incomeBySubcategory: { "export-it-ites-pseb": 2800000 },
    existingBusinessFields: [],
    taxCredits: [],
  });
  assert.equal(result.withholdingFields.length, 0, "no gated withholding row");
  assert.ok(result.withholdingGaps.length > 0, "and the money is reported, not hidden");
  assert.deepEqual(groupBySection(result.withholdingFields), []);
  assert.deepEqual(outflows({ servicesTaxDeductedAtSource: [] }), []);
});

test("packet plumbing: 7098 is summed from the gated fields only", () => {
  const packet = read("app/actions/packet.ts");
  assert.match(
    packet,
    /servicesPortalMappings\?\.withholdingFields \?\? \[\]/,
    "the sum walks the gated withholding fields",
  );
  assert.match(
    packet,
    /field\.servicesStatutorySection/,
    "one group per statutory section",
  );
  assert.match(
    packet,
    /servicesTaxDeductedAtSource: Array\.from\(\s*servicesTaxDeductedBySection\.values\(\),?\s*\)/,
    "and that grouping is what the portal map is given",
  );
  const start = packet.indexOf("const servicesTaxDeductedBySection");
  const end = packet.indexOf("// Build portalFieldMap using IRIS codes for Electron agent");
  assert.ok(start > 0 && end > start, "the block sits before the map is built");
  assert.equal(
    packet.slice(start, end).includes("withholdingGaps"),
    false,
    "a gap amount must never reach the Wealth Statement",
  );
});
