const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const packet = fs.readFileSync(path.join(root, "app/actions/packet.ts"), "utf8");

// The packet builder is exercised directly: a Freelancer/Services draft has no
// Business Profit selection, and that is the exact case that produced packets
// with `business: null` and held every Services run before entry.
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  module._compile(
    ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    filename,
  );
};
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithAlias(request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolveFilename.call(this, request, ...rest);
};
const businessFiling = require(path.join(root, "lib/tax/business-filing.ts"));
Module._resolveFilename = originalResolveFilename;

const servicesIncomeRow = {
  irisCode: "3101",
  portalArea: "Business",
  section: "Other Revenues",
  column: "Total Amount",
  isTaxField: false,
};
const servicesWithholdingRow = {
  irisCode: "64060158",
  portalArea: "Business",
  section: "Tax Deduction",
  portalGroup: "Minimum Tax",
  column: "Tax Deducted",
  isTaxField: true,
};
const portalMap = fs.readFileSync(path.join(root, "lib/tax/portal-field-map.ts"), "utf8");
const servicesPortalMap = fs.readFileSync(path.join(root, "lib/tax/services-portal-map.ts"), "utf8");

test("packet generation fails closed on unconfirmed or stale Services invoices", () => {
  assert.match(packet, /invoice\.evidenceStatus !== "CONFIRMED"/);
  assert.match(packet, /invoice\.sourceDocument\.extractionStatus !== "MAPPED"/);
  assert.match(packet, /servicesResult\.ok === false/);
  assert.match(packet, /Services income evidence is incomplete/);
});

test("packet snapshot preserves separate invoice, payout, fee, withholding and bank-credit evidence", () => {
  for (const field of [
    "accountingMethod",
    "incomeBySubcategory",
    "grossServiceAmountPkr",
    "netBankAmountPkr",
    "withholdingTaxPkr",
    "platformFeePkr",
    "bankFeePkr",
    "linkedBankCredit",
    "invoiceAndPayoutDataIsEvidenceNotAdditionalIncome",
  ]) assert.ok(packet.includes(field), `packet source should preserve ${field}`);
  assert.match(packet, /servicesIncomeEvidence:\s*servicesIncomeEvidenceSnapshot/);
});

test("packet generation passes invoice-level gross and withholding-only proof into the shared adapter", () => {
  assert.match(packet, /buildServicesPortalMappings\(/);
  assert.match(packet, /invoices:\s*servicesInvoiceEvidence\.map/);
  assert.match(packet, /recognizedIncomePkr:\s*verifiedServicesIncome\.incomeByInvoice\[invoice\.id\]/);
  assert.match(packet, /withholdingEvidenceDocumentId:\s*match\.withholdingEvidenceDocumentId/);
  assert.match(packet, /withholdingEvidenceDocumentType:\s*match\.withholdingEvidenceDocument\?\.documentType/);
  assert.match(packet, /existingBusinessFields:\s*business\?\.fields\s*\?\?\s*\[\]/);
});

test("a Freelancer/Services snapshot carries a Business payload built from the approved Services rows", () => {
  const payload = businessFiling.buildServicesTaxDeductionPacket({
    taxYear: 2026,
    filerType: "myself",
    incomeSources: ["services"],
    businessFields: [servicesIncomeRow],
    withholdingFields: [servicesWithholdingRow],
  });
  assert.equal(payload.version, "services-tax-deduction-v1");
  assert.equal(payload.route, "services_tax_deduction");
  assert.equal(payload.coverage, "services_tax_deduction_only");
  assert.deepEqual(
    payload.fields.map((field) => field.irisCode),
    ["3101", "64060158"],
  );
  assert.deepEqual(
    payload.fields.map((field) => field.section),
    ["Other Revenues", "Tax Deduction"],
  );
  assert.deepEqual(
    payload.pending.map((item) => item.key),
    ["servicesFinalReview"],
  );

  // Phase 6 consumes this packet only through the exact Services route: the
  // stored packet rows select their exact flattened counterparts, invalid or
  // combined packets fail closed, and Save remains hard-blocked on this route.
  assert.match(packet, /buildServicesTaxDeductionPacket\(/);
  assert.match(packet, /isSingleFreelancerServicesFiling\(/);
  assert.match(packet, /business: businessSnapshot/);
  const desktopAgent = fs.readFileSync(
    path.join(root, "electron-connect/main.js"),
    "utf8",
  );
  assert.match(desktopAgent, /snapshot\.business\?\.version === "services-tax-deduction-v1"/);
  assert.match(desktopAgent, /function getServicesPacketRoute\(snapshot\)/);
  assert.match(desktopAgent, /function getServicesAutofillFields\(snapshot, allCoded\)/);
  assert.match(desktopAgent, /routePolicy: "services_no_save"/);
  assert.doesNotMatch(desktopAgent, /FBR agent route is not enabled in this agent build yet/);
});

test("the Services Business payload stays empty rather than guessing at a row", () => {
  const build = (overrides) =>
    businessFiling.buildServicesTaxDeductionPacket({
      taxYear: 2026,
      filerType: "myself",
      incomeSources: ["services"],
      businessFields: [],
      withholdingFields: [],
      ...overrides,
    });
  assert.equal(
    build({}),
    null,
    "no approved row may be invented for the portal",
  );
  assert.equal(
    build({ incomeSources: ["salary"] }),
    null,
    "a non-Services draft gets no Services payload",
  );
  assert.throws(
    () => build({ taxYear: 2025 }),
    /Myself \/ TY2026 only/,
    "the verified Services entry route is TY2026 / Myself only",
  );
  assert.throws(
    () => build({ incomeSources: ["services", "salary"], withholdingFields: [servicesWithholdingRow] }),
    /only income source/,
    "combined-source Services packets stay deferred and fail closed",
  );
  const withholdingOnly = build({ withholdingFields: [servicesWithholdingRow] });
  assert.deepEqual(
    withholdingOnly.pending.map((item) => item.key),
    ["servicesIncomeRow", "servicesFinalReview"],
    "a missing income row is reported as manual work, not silently dropped",
  );
});

test("packet writes only approved Services fields into IRIS maps and keeps adapter gaps visible", () => {
  assert.match(packet, /portalFieldMap\.businessFields = business\.fields/);
  assert.match(packet, /portalFieldMap\.businessFields = \[\.\.\.servicesBusinessFields\]/);
  assert.match(packet, /portalFieldMap\.adjustableTaxFields\.push\([\s\S]*?\.\.\.servicesPortalMappings\.withholdingFields/);
  assert.match(packet, /manualIncomeGaps:\s*servicesPortalMappings\.incomeGaps/);
  assert.match(packet, /manualWithholdingGaps:\s*servicesPortalMappings\.withholdingGaps/);
  assert.match(packet, /taxCreditIdsToSuppress/);
  assert.match(packet, /const taxCreditsForPortalMap = taxCredits\.filter/);
  assert.match(packet, /\.\.\.verifiedServiceGaps,\s*\.\.\.servicesWithholdingGaps/);
});

test("packet PDF presents the Services evidence without implying withholding credit treatment", () => {
  for (const field of [
    "Services Income — Evidence Review",
    "Verified Services gross income",
    "linked bank credit",
    "withholding:",
    "platform fee:",
    "bank fee:",
    "no tax-credit treatment is implied",
  ]) assert.ok(packet.includes(field), `packet PDF should present ${field}`);
});

test("no unverified Services portal row is fabricated", () => {
  assert.match(portalMap, /Services income has no verified IRIS line-item code/);
  assert.match(portalMap, /SERVICES:\s*\n\s*"Services income has no verified/);
});

test("desktop handoff keeps Services gaps as manual detail, outside the writable field list", () => {
  const contextRoute = fs.readFileSync(
    path.join(root, "app/api/local-agent/jobs/[jobId]/context/route.ts"),
    "utf8",
  );
  assert.match(contextRoute, /const selectedMap = normalizedRealPortalFieldMap/);
  assert.match(contextRoute, /portalFieldMap:\s*selectedMap/);
  assert.match(contextRoute, /portalFieldMapDetailed:\s*portalMapDetailed/);

  const desktopAgent = fs.readFileSync(
    path.join(root, "electron-connect/main.js"),
    "utf8",
  );
  assert.match(
    desktopAgent,
    /const portalFieldMap = Array\.isArray\(snapshot\.portalFieldMap\)\s*\? snapshot\.portalFieldMap\s*:\s*\[\]/,
  );
  assert.match(
    desktopAgent,
    /Treat portalFieldMap\.mappingGaps entries as manual-entry work, not as a selector problem/,
  );
  assert.match(servicesPortalMap, /Verified gross Services income has no supported IRIS income row for this service subtype; human entry\/review is required/);
});
