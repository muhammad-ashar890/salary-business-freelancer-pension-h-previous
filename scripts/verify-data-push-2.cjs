"use strict";
/**
 * DP-2 (Data Push, 16-Oct-2026): business bank accounts (IRIS Balance Sheet
 * 3320) and vehicles (3304) -- lib/tax/business-balance-details.ts, the
 * wizard sanitizer (subcategories.ts) and the business packet (v4).
 *
 * IRIS facts used (captures of 15-Oct-2026, ~/iris-balance-sheet-popups):
 * IBAN max 24, registration max 15, chassis max 20, make / model max 50;
 * child rows "Bank Account - <IBAN> - ..." and "Motor Vehicle(s) - <reg> - ...".
 * IBAN check: ISO 13616 mod-97; the Pakistani registry example
 * PK36SCBL0000001123456702 is valid. Synthetic data only.
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

const details = require(path.join(root, "lib/tax/business-balance-details.ts"));
const filing = require(path.join(root, "lib/tax/business-filing.ts"));
const subs = require(path.join(root, "lib/tax/rules/ty2026/subcategories.ts"));
const plain = (value) => JSON.parse(JSON.stringify(value));

const IBAN = "PK36SCBL0000001123456702";
const IBAN_2 = "PK93MEZN0000001234567890";

test("IBAN: normalised like IRIS shows it; format and mod-97 check", () => {
  assert.equal(details.normalizeIban(" pk36 scbl-0000 0011 2345 6702 "), IBAN);
  assert.equal(details.isValidPakistanIban(IBAN), true);
  assert.equal(details.isValidPakistanIban(IBAN_2), true);
  assert.equal(details.isValidPakistanIban("PK36SCBL0000001123456703"), false, "one digit changed");
  assert.equal(details.isValidPakistanIban("PK36SCBL000000112345670"), false, "23 characters");
  assert.equal(details.isValidPakistanIban("GB82WEST12345698765432"), false, "not Pakistani");
  assert.equal(details.isValidPakistanIban("PK3SSCBL0000001123456702"), false, "letters in check digits");
});

test("bank list: empty rows dropped, malformed input refused (never fixed)", () => {
  const ok = details.sanitizeBusinessBankAccounts([
    { iban: "pk36 scbl 0000 0011 2345 6702", balance: 2_500_000 },
    { iban: "", balance: undefined },
    { iban: "PK24", balance: "" },
  ]);
  assert.equal(ok.ok, true);
  assert.deepEqual(plain(ok.rows), [{ iban: IBAN, balance: 2_500_000 }, { iban: "PK24" }]);
  assert.deepEqual(plain(details.sanitizeBusinessBankAccounts(undefined)), { ok: true, rows: [] });
  assert.match(details.sanitizeBusinessBankAccounts({}).error, /must be a list/);
  assert.match(details.sanitizeBusinessBankAccounts(["x"]).error, /must be an object/);
  assert.match(details.sanitizeBusinessBankAccounts([{ iban: IBAN, balance: "5" }]).error, /number of zero or more/);
  assert.match(details.sanitizeBusinessBankAccounts([{ iban: IBAN, balance: 10.5 }]).error, /whole rupees/);
  assert.match(details.sanitizeBusinessBankAccounts([{ iban: IBAN + "1", balance: 1 }]).error, /longer than 24/);
  assert.match(details.sanitizeBusinessBankAccounts([{ iban: 5 }]).error, /IBAN must be text/);
});

test("bank list: problems in plain words (missing / invalid / duplicate IBAN, missing or zero balance)", () => {
  assert.deepEqual(details.validateBusinessBankAccounts([{ iban: IBAN, balance: 1 }]), []);
  const problems = details.validateBusinessBankAccounts([
    { iban: "", balance: 5 },
    { iban: "PK36SCBL0000001123456703", balance: 5 },
    { iban: IBAN, balance: 5 },
    { iban: IBAN, balance: 5 },
    { iban: IBAN_2 },
    { iban: "PK93MEZN0000001234567890", balance: 0 },
  ]).join(" | ");
  assert.match(problems, /Bank account 1: enter the IBAN/);
  assert.match(problems, /PK36SCBL0000001123456703: this is not a valid Pakistani IBAN/);
  assert.match(problems, new RegExp(`${IBAN} is listed twice`));
  assert.match(problems, new RegExp(`${IBAN_2}: enter the balance on 30 June`));
  assert.match(problems, /balance must be more than zero/);
});

test("vehicle list: IRIS limits at sanitize time, required fields and duplicates at validation", () => {
  const ok = details.sanitizeBusinessVehicles([
    { registrationNo: "  TST-123 ", chassisNo: "", make: "Suzuki", model: "Cultus  2020", value: 500_000 },
    { registrationNo: "", make: "", model: "" },
  ]);
  assert.equal(ok.ok, true);
  assert.deepEqual(plain(ok.rows), [{ registrationNo: "TST-123", make: "Suzuki", model: "Cultus 2020", value: 500_000 }]);
  assert.match(details.sanitizeBusinessVehicles([{ registrationNo: "X".repeat(16), make: "A", model: "B" }]).error, /15 characters/);
  assert.match(details.sanitizeBusinessVehicles([{ registrationNo: "A", chassisNo: "C".repeat(21), make: "A", model: "B" }]).error, /20 characters/);
  assert.match(details.sanitizeBusinessVehicles([{ registrationNo: "A", make: "M".repeat(51), model: "B" }]).error, /50 characters/);
  assert.match(details.sanitizeBusinessVehicles([{ registrationNo: 7, make: "A", model: "B" }]).error, /must be text/);
  const problems = details.validateBusinessVehicles([
    { registrationNo: "", make: "A", model: "B", value: 1 },
    { registrationNo: "ABC - 1", make: "A", model: "B", value: 1 },
    { registrationNo: "TST-1", make: "", model: "", value: 0 },
    { registrationNo: "tst-1", make: "A", model: "B" },
  ]).join(" | ");
  assert.match(problems, /Vehicle 1: enter the registration number/);
  assert.match(problems, /without " - "/);
  assert.match(problems, /TST-1: enter the make/);
  assert.match(problems, /TST-1: enter the model/);
  assert.match(problems, /value must be more than zero/);
  assert.match(problems, /tst-1 is listed twice/);
  assert.match(problems, /tst-1: enter its value/);
});

const LAND_PROPERTY = {
  balanceRow: "land",
  propertyType: "Commercial Property",
  propertySubType: "Open Plot",
  acquisitionDate: "2020-01-15",
  areaUnit: "Kanal",
  landArea: 2,
  acquisitionCost: 4_000_000,
  province: "Punjab",
  district: "Lahore",
  city: "Lahore",
  propertyNo: "Plot 12",
  sectorMohallaBlock: "Block A",
  value: 6_000_000,
};
const BUILDING_PROPERTY = {
  balanceRow: "building",
  propertyType: "Commercial Property",
  propertySubType: "Constructed Property",
  areaUnit: "Square Foot",
  landArea: 1200,
  province: "Sindh",
  district: "Karachi East",
  city: "Gulshan Town",
  propertyNo: "Shop 4",
  sectorMohallaBlock: "Block 5",
  value: 9_000_000,
};

test("property list: captured IRIS spellings canonicalized, malformed rows refused", () => {
  const ok = details.sanitizeBusinessProperties([
    {
      ...LAND_PROPERTY,
      propertyType: "commercial",
      propertySubType: "open plot",
      areaUnit: "Kanal",
      province: "punjab",
    },
    { balanceRow: "", propertyType: "", propertySubType: "", areaUnit: "", province: "", district: "", city: "", propertyNo: "", sectorMohallaBlock: "" },
  ]);
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(plain(ok.rows), [LAND_PROPERTY]);
  assert.equal(details.irisPropertyDate("2020-01-15"), "15/01/2020");
  assert.equal(details.formatPropertyArea(2.5), "2.5");
  assert.match(details.sanitizeBusinessProperties({}).error, /must be a list/);
  assert.match(details.sanitizeBusinessProperties([{ ...LAND_PROPERTY, balanceRow: "house" }]).error, /land or building/);
  assert.match(details.sanitizeBusinessProperties([{ ...LAND_PROPERTY, acquisitionDate: "2025-02-29" }]).error, /real date/);
  assert.match(details.sanitizeBusinessProperties([{ ...LAND_PROPERTY, landArea: "2" }]).error, /number of zero or more/);
  assert.match(details.sanitizeBusinessProperties([{ ...LAND_PROPERTY, propertyNo: "x".repeat(201) }]).error, /200 characters/);
});

test("property list: every IRIS-required detail and duplicate row text is checked", () => {
  assert.deepEqual(details.validateBusinessProperties([LAND_PROPERTY, BUILDING_PROPERTY]), []);
  const problems = details.validateBusinessProperties([
    {
      ...LAND_PROPERTY,
      balanceRow: "",
      propertyType: "Warehouse Property",
      propertySubType: "",
      landArea: 0,
      city: "",
      propertyNo: "",
      value: undefined,
    },
    LAND_PROPERTY,
    LAND_PROPERTY,
  ]).join(" | ");
  assert.match(problems, /choose whether this property belongs to Land/);
  assert.match(problems, /property type must be one of/);
  assert.match(problems, /choose the property sub-type/);
  assert.match(problems, /land area must be more than zero/);
  assert.match(problems, /enter the city exactly as IRIS lists it/);
  assert.match(problems, /enter its value in the Balance Sheet/);
  assert.match(problems, /same IRIS row text/);
});

test("property plan: v2 child rows carry the exact IRIS description and typed date", () => {
  const plan = plain(details.buildBalanceDetailsPlan([], [], [LAND_PROPERTY, BUILDING_PROPERTY]));
  assert.equal(plan.version, "balance-details-v2");
  assert.deepEqual(plan.totals, { bank: 0, vehicle: 0, land: 6_000_000, building: 9_000_000 });
  assert.equal(plan.properties.length, 2);
  assert.deepEqual(plan.agentFields.map((field) => [field.kind, field.irisCode, field.value]), [
    ["property", "3301", "6000000"],
    ["property", "3302", "9000000"],
  ]);
  assert.equal(
    plan.agentFields[0].rowDescriptionIncludes,
    "Land (Business) - Open Plot, 2 Kanal, Plot 12, Block A, Lahore, Lahore, Punjab",
  );
  assert.equal(plan.agentFields[0].acquisitionDateIris, "15/01/2020");
  assert.equal(plan.agentFields[1].acquisitionCost, undefined);
  assert.throws(
    () => details.buildBalanceDetailsPlan([], [], [{ ...LAND_PROPERTY, city: "" }]),
    /enter the city/,
  );
});

test("lists must add up to the Balance Sheet's own bank / vehicle figures", () => {
  const banks = [{ iban: IBAN, balance: 2_000_000 }, { iban: IBAN_2, balance: 500_000 }];
  const vehicles = [{ registrationNo: "TST-123", make: "Suzuki", model: "Cultus", value: 500_000 }];
  assert.deepEqual(details.compareWithBalanceSheet({ banks, vehicles, sheetBank: 2_500_000, sheetVehicle: 500_000 }), []);
  const off = details.compareWithBalanceSheet({ banks, vehicles, sheetBank: 3_500_000, sheetVehicle: null }).join(" | ");
  assert.match(off, /add up to Rs 2,500,000, but the Balance Sheet bank figure is Rs 3,500,000/);
  assert.match(off, /no vehicle figure/);
  assert.deepEqual(details.compareWithBalanceSheet({ banks: [], vehicles: [], sheetBank: 9, sheetVehicle: 9 }), []);
});

test("property lists must add up to the Balance Sheet land / building figures", () => {
  assert.deepEqual(
    details.compareWithBalanceSheet({
      banks: [], vehicles: [], properties: [LAND_PROPERTY, BUILDING_PROPERTY],
      sheetBank: 0, sheetVehicle: 0, sheetLand: 6_000_000, sheetBuilding: 9_000_000,
    }),
    [],
  );
  const off = details.compareWithBalanceSheet({
    banks: [], vehicles: [], properties: [LAND_PROPERTY, BUILDING_PROPERTY],
    sheetBank: 0, sheetVehicle: 0, sheetLand: 5_000_000, sheetBuilding: null,
  }).join(" | ");
  assert.match(off, /under Land \(Business\) add up to Rs 6,000,000, but the Balance Sheet land figure is Rs 5,000,000/);
  assert.match(off, /under Building \(Business\), but the reviewed Balance Sheet has no building figure/);
});

test("plan: packet fields and agent fields carry the IRIS child-row text", () => {
  const plan = plain(details.buildBalanceDetailsPlan(
    [{ iban: IBAN, balance: 2_500_000 }],
    [{ registrationNo: "TST-123", chassisNo: "CH0001", make: "Suzuki", model: "Cultus", value: 500_000 }],
  ));
  assert.equal(plan.version, "balance-details-v1");
  assert.deepEqual(plan.totals, { bank: 2_500_000, vehicle: 500_000, land: 0, building: 0 });
  assert.deepEqual(plan.fields.map((f) => [f.irisCode, f.section, f.column, f.ourAmount, f.rowDescriptionIncludes]), [
    ["3320", "Balance Sheet", "Amount", 2_500_000, `Bank Account - ${IBAN} -`],
    ["3304", "Balance Sheet", "Amount", 500_000, "Motor Vehicle(s) - TST-123 -"],
  ]);
  assert.deepEqual(plan.agentFields[0], {
    key: `3320:businessFields:Amount:Bank Account - ${IBAN} -`, kind: "bank", irisCode: "3320",
    label: `Bank Account ${IBAN}`, column: "Amount", value: "2500000",
    rowDescriptionIncludes: `Bank Account - ${IBAN} -`, iban: IBAN,
  });
  assert.equal(plan.agentFields[1].chassisNo, "CH0001");
  assert.throws(() => details.buildBalanceDetailsPlan([{ iban: "PK00", balance: 1 }], []), /not a valid Pakistani IBAN/);
});

test("wizard storage: lists survive save + read-back; a malformed list is refused on save", () => {
  const banks = [{ iban: IBAN, balance: 2_500_000 }];
  const vehicles = [{ registrationNo: "TST-123", make: "Suzuki", model: "Cultus", value: 500_000 }];
  const saved = subs.resolveTy2026IncomeSelections({
    incomeSources: ["business"],
    selections: [{ source: "business", subcategory: "profit-return", details: { businessGrossSales: 100, businessBankAccounts: banks, businessVehicles: vehicles, businessProperties: [LAND_PROPERTY, BUILDING_PROPERTY] } }],
  });
  assert.equal(saved.success, true, saved.error);
  const stored = saved.selections.find((s) => s.source === "business").details;
  assert.deepEqual(plain(stored.businessBankAccounts), banks);
  assert.deepEqual(plain(stored.businessVehicles), vehicles);
  assert.deepEqual(plain(stored.businessProperties), [LAND_PROPERTY, BUILDING_PROPERTY]);
  const back = subs.parsePersistedSelectionUserDetails(JSON.stringify({ userDetails: stored }));
  assert.deepEqual(plain(back.businessBankAccounts), banks);
  assert.deepEqual(plain(back.businessVehicles), vehicles);
  assert.deepEqual(plain(back.businessProperties), [LAND_PROPERTY, BUILDING_PROPERTY]);
  const bad = subs.resolveTy2026IncomeSelections({
    incomeSources: ["business"],
    selections: [{ source: "business", subcategory: "profit-return", details: { businessGrossSales: 100, businessBankAccounts: "x" } }],
  });
  assert.equal(bad.success, false);
  assert.match(bad.error, /must be a list/);
  // A stored list that no longer passes the shape check is left out, never half-read.
  const broken = subs.parsePersistedSelectionUserDetails(JSON.stringify({ userDetails: { businessGrossSales: 1, businessVehicles: [{ registrationNo: 5 }], businessProperties: [{ balanceRow: 5 }] } }));
  assert.equal(broken.businessVehicles, undefined);
  assert.equal(broken.businessProperties, undefined);
});

// Packet: synthetic Balance Sheet with bank 2,500,000 and vehicle 500,000.
const VALUES = {
  businessGrossSales: 6_000_000, businessOtherRevenue: 120_000, businessCostOfSales: 2_000_000,
  businessOperatingExpenses: 1_000_000, businessDepreciation: 150_000, businessInadmissibleExpenses: 80_000,
  businessLossBroughtForward: 50_000, businessWithholdingDeducted: 120_000, businessSalesExcludeIndirectTax: true,
};
function sheet(overrides = {}) {
  const v = {
    businessName: "SYNTHETIC TEST BUSINESS", taxYear: 2026, closingDate: "2026-06-30", currency: "PKR",
    totalAssets: 4_300_000, totalEquityLiabilities: 4_300_000, plant: 600_000, stock: 300_000, advances: 150_000,
    cash: 100_000, securities: 100_000, otherAssets: 50_000, capital: 3_000_000, loans: 1_000_000,
    payables: 200_000, otherLiabilities: 100_000, land: 0, building: 0, bank: 2_500_000, vehicle: 500_000,
    ...overrides,
  };
  return {
    id: "synthetic-balance-sheet",
    extractionStatus: "MAPPED",
    extractedData: JSON.stringify({ fields: Object.entries(filing.BUSINESS_BALANCE_LABELS).map(([key, label]) => ({ label, value: v[key] })) }),
  };
}
const packetInput = (extra = {}, more = {}) => ({
  taxYear: 2026,
  filerType: "myself",
  incomeSources: ["business"],
  selections: [{ source: "business", subcategory: "profit-return", detailsJson: JSON.stringify({ userDetails: { ...VALUES, ...extra } }) }],
  balanceSheet: sheet(),
  ...more,
});
const BANKS = [{ iban: IBAN, balance: 2_000_000 }, { iban: IBAN_2, balance: 500_000 }];
const VEHICLES = [{ registrationNo: "TST-123", make: "Suzuki", model: "Cultus", value: 500_000 }];
const expectedRow = (p, code) => p.expectedIrisTotals.rows.find((row) => row.code === code);

test("packet without lists is unchanged: bank / vehicle stay manual, no balanceDetails", () => {
  const p = plain(filing.buildBusinessPacket(packetInput()));
  assert.equal(p.balanceDetails, null);
  assert.notEqual(p.version, "business-entry-v4");
  assert.ok(p.pending.some((i) => i.key === "balanceSheet.bank"));
  assert.ok(p.pending.some((i) => i.key === "balanceSheet.vehicle"));
  assert.equal(expectedRow(p, "3349").expected, 1_300_000);
});

test("packet v4: child rows planned, bank / vehicle manual items gone, 3349 includes them", () => {
  const p = plain(filing.buildBusinessPacket(packetInput({ businessBankAccounts: BANKS, businessVehicles: VEHICLES })));
  assert.equal(p.version, "business-entry-v4");
  assert.equal(p.balanceDetails.agentFields.length, 3);
  assert.deepEqual(p.balanceDetails.totals, { bank: 2_500_000, vehicle: 500_000, land: 0, building: 0 });
  assert.ok(!p.pending.some((i) => i.key === "balanceSheet.bank"));
  assert.ok(!p.pending.some((i) => i.key === "balanceSheet.vehicle"));
  // Child rows are never queued as ordinary fields (the agent's main loop would look for them too early).
  assert.ok(!p.fields.some((f) => ["3320", "3304"].includes(f.irisCode)));
  const assets = expectedRow(p, "3349");
  assert.equal(assets.expected, 1_300_000 + 2_500_000 + 500_000);
  assert.match(assets.formula, /3320/);
  assert.match(assets.formula, /3304/);
  assert.equal(assets.proven, false, "3320 / 3304 child rows were not part of a live run yet");
  assert.equal(expectedRow(p, "3399").expected, 4_300_000);
});

test("packet v8: land / building properties planned and included in expected 3349", () => {
  const propertySheet = sheet({
    land: 6_000_000,
    building: 9_000_000,
    totalAssets: 19_300_000,
    totalEquityLiabilities: 19_300_000,
    capital: 18_000_000,
  });
  const p = plain(filing.buildBusinessPacket(packetInput(
    {
      businessBankAccounts: BANKS,
      businessVehicles: VEHICLES,
      businessProperties: [LAND_PROPERTY, BUILDING_PROPERTY],
    },
    { balanceSheet: propertySheet },
  )));
  assert.equal(p.version, "business-entry-v8");
  assert.equal(p.balanceDetails.version, "balance-details-v2");
  assert.equal(p.balanceDetails.properties.length, 2);
  assert.deepEqual(p.balanceDetails.totals, { bank: 2_500_000, vehicle: 500_000, land: 6_000_000, building: 9_000_000 });
  assert.ok(!p.pending.some((i) => i.key === "balanceSheet.land"));
  assert.ok(!p.pending.some((i) => i.key === "balanceSheet.building"));
  assert.ok(!p.fields.some((f) => ["3301", "3302", "3320", "3304"].includes(f.irisCode)));
  assert.deepEqual(
    p.balanceDetails.agentFields.filter((f) => f.kind === "property").map((f) => f.irisCode),
    ["3301", "3302"],
  );
  const assets = expectedRow(p, "3349");
  assert.equal(assets.expected, 19_300_000);
  assert.match(assets.formula, /3301/);
  assert.match(assets.formula, /3302/);
  assert.equal(assets.proven, false, "property child rows are capture-proven but not live-run proven");
});

test("packet: only land property listed -> building stays manual with the missing detail named", () => {
  const propertySheet = sheet({
    land: 6_000_000,
    building: 9_000_000,
    totalAssets: 19_300_000,
    totalEquityLiabilities: 19_300_000,
    capital: 18_000_000,
  });
  const p = plain(filing.buildBusinessPacket(packetInput(
    { businessProperties: [LAND_PROPERTY] },
    { balanceSheet: propertySheet },
  )));
  assert.equal(p.version, "business-entry-v8");
  assert.ok(!p.pending.some((i) => i.key === "balanceSheet.land"));
  const building = p.pending.find((i) => i.key === "balanceSheet.building");
  assert.ok(building);
  assert.match(building.reason, /List each building property with its IRIS Property Information detail/);
});

test("packet: only one list given -> only that item leaves the manual list", () => {
  const p = plain(filing.buildBusinessPacket(packetInput({ businessVehicles: VEHICLES })));
  assert.equal(p.version, "business-entry-v4");
  assert.ok(p.pending.some((i) => i.key === "balanceSheet.bank"));
  assert.ok(!p.pending.some((i) => i.key === "balanceSheet.vehicle"));
});

test("packet refuses a list that does not match the Balance Sheet, or an invalid list", () => {
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessBankAccounts: [{ iban: IBAN, balance: 2_000_000 }] })),
    /add up to Rs 2,000,000, but the Balance Sheet bank figure is Rs 2,500,000/,
  );
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessBankAccounts: [{ iban: "PK36SCBL0000001123456703", balance: 2_500_000 }] })),
    /not a valid Pakistani IBAN/,
  );
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessVehicles: [{ registrationNo: "X".repeat(16), make: "A", model: "B", value: 1 }] })),
    /Business vehicles: Registration number is longer/,
  );
  assert.throws(
    () => filing.buildBusinessPacket(packetInput(
      { businessProperties: [LAND_PROPERTY] },
      { balanceSheet: sheet({ land: 5_000_000, totalAssets: 9_300_000, totalEquityLiabilities: 9_300_000, capital: 8_000_000 }) },
    )),
    /under Land \(Business\) add up to Rs 6,000,000, but the Balance Sheet land figure is Rs 5,000,000/,
  );
  assert.throws(
    () => filing.buildBusinessPacket(packetInput({ businessProperties: [{ ...LAND_PROPERTY, city: "" }] })),
    /enter the city exactly as IRIS lists it/,
  );
});

test("packet without a Balance Sheet: lists are kept back with a plain reason", () => {
  const p = plain(filing.buildBusinessPacket(packetInput({ businessBankAccounts: BANKS }, { balanceSheet: null })));
  assert.equal(p.balanceDetails, null);
  assert.notEqual(p.version, "business-entry-v4");
  assert.ok(p.pending.some((i) => i.key === "balanceSheetDetails" && /only together with a reviewed, mapped Business Balance Sheet/.test(i.reason)));
});

// ---------------------------------------------------------------------------
// Business Details tab (captures 41 / 55 / 70 / 71): lib/tax/business-identity.ts
const identityLib = require(path.join(root, "lib/tax/business-identity.ts"));
const IDENTITY = {
  businessName: "SYNTHETIC TEST BUSINESS",
  principalActivity: "Trading",
  brandName: "Synthetic, Test Brand",
  startDate: "2013-07-19",
};

test("business details: IRIS options, date formats (typed DD/MM/YYYY, table 19-Jul-2013)", () => {
  assert.deepEqual([...identityLib.IRIS_PRINCIPAL_ACTIVITIES], ["Manufacturing", "Services", "Trading", "Other"]);
  assert.equal(identityLib.irisTypedDate("2013-07-19"), "19/07/2013");
  assert.equal(identityLib.irisTableDate("2013-07-19"), "19-Jul-2013");
  assert.equal(identityLib.irisTableDate("2026-06-30"), "30-Jun-2026");
  assert.equal(identityLib.parseIsoDate("2025-02-29"), null, "not a real day");
  assert.equal(identityLib.parseIsoDate("19/07/2013"), null);
  assert.deepEqual(identityLib.splitBrands(" A ,, B  C ,"), ["A", "B C"]);
});

test("business details: shape check refuses malformed input, keeps partial entries", () => {
  assert.deepEqual(plain(identityLib.sanitizeBusinessIdentity(undefined)), { ok: true, identity: null });
  assert.deepEqual(plain(identityLib.sanitizeBusinessIdentity({ businessName: " ", brandName: "" })), { ok: true, identity: null });
  assert.deepEqual(plain(identityLib.sanitizeBusinessIdentity({ businessName: "  Abc   Traders " })), { ok: true, identity: { businessName: "Abc Traders", brandName: "" } });
  assert.match(identityLib.sanitizeBusinessIdentity([]).error, /must be an object/);
  assert.match(identityLib.sanitizeBusinessIdentity({ businessName: 5 }).error, /must be text/);
  assert.match(identityLib.sanitizeBusinessIdentity({ businessName: "X".repeat(101) }).error, /100 characters/);
  // 27-Oct: a PRINTED wording is mapped to the IRIS option it names ("Retail"
  // and "Trading - general order supplier" are both Trading) and a printed
  // day-first date is read as that date; what cannot be read still errors.
  assert.equal(identityLib.sanitizeBusinessIdentity({ businessName: "A", principalActivity: "Retail" }).identity.principalActivity, "Trading");
  assert.equal(identityLib.sanitizeBusinessIdentity({ businessName: "A", startDate: "19/07/2013" }).identity.startDate, "2013-07-19");
  assert.match(identityLib.sanitizeBusinessIdentity({ principalActivity: "Freelance" }).error, /one of: Manufacturing, Services, Trading, Other/);
  assert.match(identityLib.sanitizeBusinessIdentity({ businessName: "A", startDate: "19/13/2013" }).error, /YYYY-MM-DD/);
});

test("business details: every IRIS-required entry and the date order are checked", () => {
  assert.deepEqual(identityLib.validateBusinessIdentity(IDENTITY), []);
  const problems = identityLib.validateBusinessIdentity({ businessName: "", brandName: "", startDate: "2026-07-01", endDate: "2026-07-02" }).join(" | ");
  assert.match(problems, /enter the business name/);
  assert.match(problems, /choose the principal activity/);
  assert.match(problems, /IRIS requires a brand name/);
  assert.match(problems, /start date is after the end of the tax year \(2026-06-30\)/);
  assert.match(problems, /end date is after the end of the tax year/);
  assert.match(identityLib.validateBusinessIdentity({ ...IDENTITY, endDate: "2013-07-18" }).join(" "), /end date is before the start date/);
  assert.match(identityLib.validateBusinessIdentity({ ...IDENTITY, startDate: undefined }).join(" "), /date the business started/);
});

test("business details: plan carries typed and table dates and the brand badges", () => {
  const plan = plain(identityLib.buildBusinessDetailsPlan({ ...IDENTITY, endDate: "2026-06-30" }));
  assert.deepEqual(plan, {
    version: "business-details-v1",
    businessName: "SYNTHETIC TEST BUSINESS",
    principalActivity: "Trading",
    brandName: "Synthetic, Test Brand",
    brands: ["Synthetic", "Test Brand"],
    startDate: "2013-07-19",
    endDate: "2026-06-30",
    typed: { startDate: "19/07/2013", endDate: "30/06/2026" },
    table: { startDate: "19-Jul-2013", endDate: "30-Jun-2026" },
  });
  assert.throws(() => identityLib.buildBusinessDetailsPlan({ ...IDENTITY, brandName: "" }), /brand name/);
});

test("business details: saved with the wizard, read back, and carried by packet v4", () => {
  const saved = subs.resolveTy2026IncomeSelections({
    incomeSources: ["business"],
    selections: [{ source: "business", subcategory: "profit-return", details: { businessGrossSales: 100, businessIdentity: IDENTITY } }],
  });
  assert.equal(saved.success, true, saved.error);
  const stored = saved.selections.find((s) => s.source === "business").details;
  assert.deepEqual(plain(stored.businessIdentity), IDENTITY);
  assert.deepEqual(plain(subs.parsePersistedSelectionUserDetails(JSON.stringify({ userDetails: stored })).businessIdentity), IDENTITY);
  const p = plain(filing.buildBusinessPacket(packetInput({ businessIdentity: IDENTITY })));
  assert.equal(p.version, "business-entry-v4");
  assert.equal(p.businessDetails.table.startDate, "19-Jul-2013");
  assert.equal(p.balanceDetails, null);
  const none = plain(filing.buildBusinessPacket(packetInput()));
  assert.equal(none.businessDetails, null);
  assert.throws(() => filing.buildBusinessPacket(packetInput({ businessIdentity: { ...IDENTITY, principalActivity: undefined } })), /choose the principal activity/);
});
