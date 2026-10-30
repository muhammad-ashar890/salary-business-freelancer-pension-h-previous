"use strict";
/**
 * 27-Oct (user: "ye to doc se hi aa sakta tha"): the Business details the step
 * asked the reviewer to type are in the uploaded Business Profile - the printed
 * wording just is not what IRIS accepts.
 *
 * Printed by Filing-1 (Business Profile, TY2026):
 *   Business name        Naveed Traders
 *   Nature of business   "Trading - general order supplier / wholesale"
 *   Commencement date    01-Jul-2015
 *   Brand                (not printed anywhere - the business has no brand)
 *
 * Checks:
 *   1. the printed activity wording maps to the one IRIS option it names, and an
 *      unrelated wording maps to nothing (the reviewer still chooses);
 *   2. printed dates (01-Jul-2015, 01/07/2015, 1.7.2015, ISO) become ISO, and a
 *      half-printed or impossible date is refused rather than guessed;
 *   3. sanitizeBusinessIdentity applies both, and still keeps its own errors for
 *      a wording or date it cannot read;
 *   4. the document intake fills the brand from the business name - only when no
 *      brand was printed - because IRIS requires a brand and the app's own rule
 *      says to write the business name when there is no separate brand;
 *   5. end to end: the Filing-1 fields the model returns leave no manual field.
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

const identity = require("../lib/tax/business-identity.ts");
const intake = require("../lib/tax/business-document-intake.ts");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// ---------------------------------------------------------------------------
// 1. Principal activity
// ---------------------------------------------------------------------------

test("activity: the printed nature of business maps to the IRIS option it names", () => {
  const cases = [
    ["Trading - general order supplier / wholesale", "Trading"],
    ["Trading — general order supplier / wholesale", "Trading"],
    ["Wholesale and retail of general order goods", "Trading"],
    ["Manufacturing of garments", "Manufacturing"],
    ["Services - consultancy", "Services"],
    ["Other", "Other"],
    ["Supplier of packaging material", "Trading"],
  ];
  for (const [printed, expected] of cases)
    assert.equal(identity.parsePrincipalActivity(printed), expected, printed);
});

test("activity: a description that names no supported activity maps to nothing", () => {
  for (const printed of ["", "   ", null, undefined, "Freelance", "Agricultural farming", "Rental of property"])
    assert.equal(identity.parsePrincipalActivity(printed), null, String(printed));
  // A form word anywhere in the printed text is still read, never invented.
  assert.equal(identity.parsePrincipalActivity("General order supplier of goods"), "Trading");
  assert.equal(identity.parsePrincipalActivity("Import, export and trading"), "Trading");
});

// ---------------------------------------------------------------------------
// 2. Printed dates
// ---------------------------------------------------------------------------

test("date: the forms a Pakistani business record prints become ISO", () => {
  const cases = [
    ["01-Jul-2015", "2015-07-01"],
    ["1-Jul-2015", "2015-07-01"],
    ["01 July 2015", "2015-07-01"],
    ["01/07/2015", "2015-07-01"],
    ["1/7/2015", "2015-07-01"],
    ["01.07.2015", "2015-07-01"],
    ["01-07-2015", "2015-07-01"],
    ["2015-07-01", "2015-07-01"],
    [" 01-Jul-2015 ", "2015-07-01"],
  ];
  for (const [printed, expected] of cases)
    assert.equal(identity.parseBusinessDate(printed), expected, printed);
});

test("date: an impossible or unreadable date is refused, never guessed", () => {
  for (const printed of [
    "31-Feb-2015",
    "32-Jul-2015",
    "2015-13-01",
    "Jul-2015",
    "2015",
    "01-Jul",
    "",
    null,
    undefined,
    "unknown",
  ])
    assert.equal(identity.parseBusinessDate(printed), null, String(printed));
});

// ---------------------------------------------------------------------------
// 3. The shape check applies them
// ---------------------------------------------------------------------------

test("sanitize: the printed wording and date are accepted as the IRIS values", () => {
  const result = identity.sanitizeBusinessIdentity({
    businessName: "Naveed Traders",
    principalActivity: "Trading - general order supplier / wholesale",
    brandName: "Naveed Traders",
    startDate: "01-Jul-2015",
  });
  assert.equal(result.ok, true);
  assert.equal(result.identity.principalActivity, "Trading");
  assert.equal(result.identity.startDate, "2015-07-01");
  assert.deepEqual(identity.validateBusinessIdentity(result.identity), []);
});

test("sanitize: a wording and a date it cannot read still carry their own errors", () => {
  const badActivity = identity.sanitizeBusinessIdentity({
    businessName: "X",
    principalActivity: "Freelance",
    brandName: "X",
    startDate: "2015-07-01",
  });
  assert.equal(badActivity.ok, false);
  assert.match(badActivity.error, /Principal activity must be one of/);
  const badDate = identity.sanitizeBusinessIdentity({
    businessName: "X",
    principalActivity: "Trading",
    brandName: "X",
    startDate: "31-Feb-2015",
  });
  assert.equal(badDate.ok, false);
  assert.match(badDate.error, /Start date must be a date/);
});

// ---------------------------------------------------------------------------
// 4. The brand fallback (documents path only)
// ---------------------------------------------------------------------------

const profile = (fields) => ({
  id: "doc-profile",
  documentType: "business_support",
  extractionStatus: "MAPPED",
  extractedData: JSON.stringify({
    fields: Object.entries(fields).map(([label, value]) => ({ label, value, confidence: 0.95 })),
  }),
});

test("intake: the brand is filled from the business name only when nothing printed one", () => {
  const printed = intake.readReviewedBusinessFacts([
    profile({
      "Business Name": "Naveed Traders",
      "Principal Activity": "Trading - general order supplier / wholesale",
      "Business Start Date": "2015-07-01",
    }),
  ]);
  assert.equal(printed.details.businessIdentity.businessName, "Naveed Traders");
  assert.equal(printed.details.businessIdentity.brandName, "Naveed Traders");
  assert.equal(printed.details.businessIdentity.principalActivity, "Trading");
  assert.equal(printed.details.businessIdentity.startDate, "2015-07-01");
  assert.deepEqual(printed.issues, []);

  const withBrand = intake.readReviewedBusinessFacts([
    profile({
      "Business Name": "Naveed Traders",
      "Brand Name": "NT General Store",
      "Principal Activity": "Trading",
      "Business Start Date": "2015-07-01",
    }),
  ]);
  assert.equal(withBrand.details.businessIdentity.brandName, "NT General Store", "a printed brand always wins");
});

// ---------------------------------------------------------------------------
// 5. End to end on what the model returns for Filing-1
// ---------------------------------------------------------------------------

test("end to end: Filing-1 alone leaves no Business details field for the reviewer to type", () => {
  const facts = intake.readReviewedBusinessFacts([
    profile({
      "Business Name": "Naveed Traders",
      "Principal Activity": "Trading",
      "Business Start Date": "01-Jul-2015",
    }),
  ]);
  assert.equal(facts.details.businessIdentity.brandName, "Naveed Traders");
  assert.equal(facts.details.businessIdentity.principalActivity, "Trading");
  assert.equal(facts.details.businessIdentity.startDate, "2015-07-01");
  assert.deepEqual(identity.validateBusinessIdentity(facts.details.businessIdentity), []);
});

test("prompt: the extraction asks for the printed labels in the document's own words", () => {
  const prompt = read("lib/tax/business-extraction-prompt.ts");
  assert.ok(prompt.includes('"Nature of business" / "Nature of trade" / "Principal activity" -> Principal Activity'));
  assert.ok(prompt.includes('"Commencement date" / "Date of commencement" / "Business start date" / "Started on" -> Business Start Date'));
  assert.ok(prompt.includes("convert 01-Jul-2015 to 2015-07-01; never guess a day or month"));
  assert.ok(prompt.includes("never the business name"), "a brand is never invented from the name at extraction");
});
