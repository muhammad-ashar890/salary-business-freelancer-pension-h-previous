/**
 * Sales Tax: invoices typed in by hand.
 *
 *   1. The form rules: what is offered, what is refused, how the tax boxes
 *      are suggested.
 *   2. Typed invoices become template rows, placed after the uploaded file.
 *   3. PARITY: the synthetic August 2026 month, converted to typed invoices,
 *      gives exactly the same return as the Excel file (and the same hand
 *      worked balance), alone or mixed with a file.
 *   4. Typed rows are held to the same row checks as file rows and are
 *      reported under their real sheet row.
 *   5. The REAL server actions against a REAL PostgreSQL database (skipped
 *      cleanly when none is reachable): add, edit, remove, file plus typed,
 *      removing the file keeps typed rows, approval staleness, draft-only,
 *      ownership, the 500 limit, simultaneous saves.
 *   6. The screen and the actions are wired to the same code.
 *
 * All data is synthetic. It proves the code only.
 */

const path = require("path");
const fs = require("fs");
const Module = require("module");
const ExcelJS = require("exceljs");

const kit = require("./lib/sales-tax-test-kit.cjs");
const { check, finish } = kit.createChecker("verify-sales-tax-manual");
const root = kit.projectRoot;
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const R = kit.R;

let sessionEmail = null;
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "next/cache") return { revalidatePath() {} };
  if (request === "next-auth/next") {
    return {
      getServerSession: async () =>
        sessionEmail ? { user: { email: sessionEmail, name: "Test" } } : null,
    };
  }
  if (request === "server-only") return {};
  if (request === "@/lib/auth" || request === path.join(root, "lib/auth")) {
    return { authOptions: {} };
  }
  return originalLoad.call(this, request, ...rest);
};

const manual = kit.load("lib/sales-tax/manual-invoices.ts");
const reader = kit.load("lib/sales-tax/template-reader.ts");
const { prepareMonth } = kit.load("lib/sales-tax/prepare-month.ts");
const { analyzeUploads } = kit.load("lib/sales-tax/analyze-uploads.ts");
const { SALES_COLUMNS, PURCHASE_COLUMNS } = reader;

const august = require(path.join(root, "test-fixtures/sales-tax/month-2026-08.json"));
const period = august.period;
const registrationNo = august.registrationNo;

// ---------------------------------------------------------------- helpers

const text = (value) => (value === null || value === undefined ? "" : String(value));
const money = (value) => (value === null || value === undefined ? "" : Number(value).toFixed(2));

/** A fixture row turned back into what a person would have typed. */
function rowToEntry(kind, row) {
  const c = kind === "SALES" ? SALES_COLUMNS : PURCHASE_COLUMNS;
  return {
    partyType: text(row[c.partyType]),
    partyRegistrationNo: text(row[c.partyRegistrationNo]),
    partyName: text(row[c.partyName]),
    originProvince: text(row[c.originProvince]),
    destinationProvince: text(row[c.destinationProvince]),
    documentType: text(row[c.documentType]),
    documentNo: text(row[c.documentNo]),
    documentDate: text(row[c.documentDate]),
    tradeType: text(row[kind === "SALES" ? c.saleType : c.purchaseType]),
    rate: text(row[c.rate]),
    value: money(row[c.value]),
    salesTax: money(row[c.salesTax]),
    furtherTax: kind === "SALES" ? money(row[c.furtherTax]) : "",
    fixedValue: money(row[kind === "SALES" ? c.fixedOrRetailValue : c.fixedRetailValue]),
    withheld: money(row[c.stWithheld]),
    exemptionSroNo: text(row[c.exemptionSroNo]),
    exemptionItemSrNo: text(row[c.exemptionItemSrNo]),
    invoiceRefNo: text(row[c.invoiceRefNo]),
    reason: text(row[c.reason]),
  };
}
const dataRows = (grid) => grid.slice(5).filter((row) => row.some((cell) => cell !== null && cell !== ""));
const typedSales = dataRows(august.salesGrid).map((row) => rowToEntry("SALES", row));
const typedPurchases = dataRows(august.purchaseGrid).map((row) => rowToEntry("PURCHASES", row));

const good = (overrides = {}) => ({
  partyType: "Registered",
  partyRegistrationNo: "1234567",
  partyName: "Al-Noor Traders",
  originProvince: "SINDH",
  destinationProvince: "SINDH",
  documentType: "Sale Invoice",
  documentNo: "INV-900",
  documentDate: "2026-08-05",
  tradeType: "Goods at standard rate (default)",
  rate: "0.18",
  value: "1000",
  salesTax: "180",
  furtherTax: "",
  fixedValue: "",
  withheld: "",
  exemptionSroNo: "",
  exemptionItemSrNo: "",
  invoiceRefNo: "",
  reason: "",
  ...overrides,
});
const goodPurchase = (overrides = {}) =>
  good({ documentType: "Purchase Invoice", documentNo: "PI-900", ...overrides });

const sameResult = (a, b) => JSON.stringify(a.lines) === JSON.stringify(b.lines);

// ------------------------------------------------------------ 1. the form

function runFormChecks() {
  const sales = manual.manualOptions("SALES");
  const purchases = manual.manualOptions("PURCHASES");
  check("sales offers exactly the supported sale types", sales.tradeTypes.length, 5);
  check("purchases offer only supported types the purchase template knows", purchases.tradeTypes.every((t) => sales.tradeTypes.includes(t)) && purchases.tradeTypes.length > 0, true);
  check("withholding documents are not offered", [sales.documentTypes.includes("STWH"), purchases.documentTypes.includes("STWH")], [false, false]);
  check("sales offers four buyer types and purchases two seller types", [sales.partyTypes.length, purchases.partyTypes.length], [4, 2]);
  check("the 8 provinces are offered", sales.provinces.length, 8);
  check("the first choices are real options", [sales.tradeTypes.includes(manual.emptyManualInvoice("SALES").tradeType), sales.documentTypes.includes(manual.emptyManualInvoice("SALES").documentType)], [true, true]);

  const standard = "Goods at standard rate (default)";
  check("a standard sale can only use the current standard rate", manual.rateChoices("SALES", standard, period), ["0.18"]);
  const byTreatment = (treatment) => sales.tradeTypes.find((t) => manual.treatmentOf(t) === treatment);
  const zero = byTreatment("zero_rated");
  const exempt = byTreatment("exempt");
  const reduced = byTreatment("reduced");
  const third = byTreatment("third_schedule");
  check("all five treatments are offered", [zero, exempt, reduced, third].every(Boolean), true);
  check("a zero-rated sale can only be 0", manual.rateChoices("SALES", zero, period), ["0"]);
  check("an exempt sale can only be Exempt", manual.rateChoices("SALES", exempt, period), ["Exempt"]);
  check("a reduced sale offers rates above 0 and below standard", manual.rateChoices("SALES", reduced, period).every((r) => Number(r) > 0 && Number(r) < 0.18) && manual.rateChoices("SALES", reduced, period).length > 0, true);
  check("a Third Schedule sale offers rates above 0 up to standard", manual.rateChoices("SALES", third, period).every((r) => Number(r) > 0 && Number(r) <= 0.18) && manual.rateChoices("SALES", third, period).length > 0, true);
  check("an unknown sale type has no rate choices", manual.rateChoices("SALES", "Services", period), []);
  check("rates are labelled for people", [manual.rateLabel("0.18"), manual.rateLabel("0.125"), manual.rateLabel("0"), manual.rateLabel("Exempt")], ["18%", "12.5%", "0%", "Exempt"]);
  check("only reduced, zero-rated and exempt types need an SRO", [manual.needsReference(standard), manual.needsReference(zero), manual.needsReference(exempt), manual.needsReference(reduced), manual.needsReference(third)], [false, true, true, true, false]);
  check("only notes are notes", [manual.isNote("Credit Note"), manual.isNote("Debit Note"), manual.isNote("Sale Invoice")], [true, true, false]);
  check("the buyer/seller word follows the side", [manual.partyWord("SALES"), manual.partyWord("PURCHASES")], ["buyer", "seller"]);

  // --- Suggested tax. ---
  const suggest = (kind, over) => manual.suggestTax(kind, { partyType: "Registered", tradeType: standard, rate: "0.18", value: "450000", fixedValue: "", ...over }, period);
  check("a registered buyer gets sales tax and no further tax", suggest("SALES", {}), { salesTax: "81000.00", furtherTax: "" });
  check("an unregistered buyer also gets 4% further tax", suggest("SALES", { partyType: "Unregistered" }), { salesTax: "81000.00", furtherTax: "18000.00" });
  check("an unregistered distributor also gets further tax", suggest("SALES", { partyType: "Unregistered Distributor" }).furtherTax, "18000.00");
  check("a purchase never gets further tax", suggest("PURCHASES", { partyType: "Unregistered" }).furtherTax, "");
  check("a zero-rated sale suggests zero tax", suggest("SALES", { tradeType: zero, rate: "0" }).salesTax, "0.00");
  check("an exempt sale suggests zero tax", suggest("SALES", { tradeType: exempt, rate: "Exempt" }).salesTax, "0.00");
  check("nothing is suggested before the value is typed", suggest("SALES", { value: "" }), { salesTax: "", furtherTax: "" });
  check("nothing is suggested for a value that is not a number", suggest("SALES", { value: "abc" }), { salesTax: "", furtherTax: "" });
  check("nothing is suggested before a rate is chosen", suggest("SALES", { rate: "" }), { salesTax: "", furtherTax: "" });
  check("paisa are rounded the way the engine rounds", suggest("SALES", { value: "124250.50" }).salesTax, "22365.09");
  check("a Third Schedule sale is taxed on the fixed or retail value", suggest("SALES", { tradeType: third, rate: manual.rateChoices("SALES", third, period)[0], fixedValue: "1000", value: "5" }).salesTax, (Number(manual.rateChoices("SALES", third, period)[0]) * 1000).toFixed(2));

  // --- Validation. ---
  const ok = manual.validateManualInvoice("SALES", good(), period);
  check("a good invoice is accepted and written in canonical form", [ok.ok, ok.value && ok.value.value, ok.value && ok.value.salesTax, ok.value && ok.value.documentDate], [true, "1000.00", "180.00", "2026-08-05"]);
  check("a good purchase is accepted", manual.validateManualInvoice("PURCHASES", goodPurchase(), period).ok, true);
  const refused = (kind, over, pattern, label) => {
    const result = manual.validateManualInvoice(kind, kind === "SALES" ? good(over) : goodPurchase(over), period);
    check(`refused: ${label}`, [result.ok, result.ok === false && pattern.test(result.error)], [false, true]);
  };
  refused("SALES", { partyType: "Nobody" }, /buyer type/, "a buyer type that is not offered");
  refused("PURCHASES", { partyType: "Unregistered Distributor" }, /seller type/, "a seller type the purchase template does not have");
  refused("SALES", { originProvince: "MARS" }, /starts from/, "an origin province not on the list");
  refused("SALES", { destinationProvince: "" }, /goes to/, "no destination province");
  refused("SALES", { documentType: "STWH" }, /invoice type/, "a withholding document");
  refused("SALES", { documentNo: "  " }, /invoice number/, "no invoice number");
  refused("SALES", { documentNo: "x".repeat(51) }, /too long/, "an invoice number over 50 characters");
  refused("SALES", { documentDate: "" }, /date/, "no date");
  refused("SALES", { documentDate: "2026-02-30" }, /date/, "an impossible date");
  refused("SALES", { documentDate: "yesterday" }, /date/, "a date that is not a date");
  refused("SALES", { tradeType: "Services" }, /sale type/, "a sale type that is not supported");
  refused("PURCHASES", { tradeType: "Services" }, /purchase type/, "a purchase type that is not supported");
  refused("SALES", { rate: "0.17" }, /rate/, "a rate that does not belong to the sale type");
  refused("SALES", { rate: "" }, /rate/, "no rate");
  refused("SALES", { value: "" }, /value/, "no value");
  refused("SALES", { value: "abc" }, /number/, "a value that is not a number");
  refused("SALES", { value: "-5" }, /negative/, "a negative value");
  refused("SALES", { salesTax: "1e5" }, /number/, "a tax in exponent form");
  refused("SALES", { furtherTax: "x" }, /further tax/, "a further tax that is not a number");
  refused("SALES", { value: "99999999999999999" }, /number|too large/, "an absurdly large value");
  refused("SALES", { partyName: "n".repeat(121) }, /too long/, "a name over 120 characters");
  refused("SALES", { partyRegistrationNo: "1".repeat(31) }, /too long/, "a registration number over 30 characters");
  refused("SALES", { exemptionSroNo: "NOT-AN-SRO" }, /SRO/, "an SRO not on the list");
  refused("SALES", { exemptionItemSrNo: "NOPE" }, /item serial/, "an item serial not on the list");
  refused("SALES", { reason: "Because" }, /reason/, "a reason not on the list");
  refused("SALES", { documentType: "Credit Note" }, /original invoice number and a reason/, "a credit note without reference and reason");
  refused("SALES", { documentType: "Debit Note", invoiceRefNo: "INV-1" }, /original invoice number and a reason/, "a debit note without a reason");
  const noteReason = sales.reasons[0];
  check("a credit note with reference and reason is accepted", manual.validateManualInvoice("SALES", good({ documentType: "Credit Note", invoiceRefNo: "INV-1", reason: noteReason }), period).ok, true);
  check("a non-object is refused", [manual.validateManualInvoice("SALES", null, period).ok, manual.validateManualInvoice("SALES", "x", period).ok, manual.validateManualInvoice("SALES", undefined, period).ok], [false, false, false]);
  check("amounts with commas are refused or read, never guessed", manual.validateManualInvoice("SALES", good({ value: "1,000.50" }), period).value?.value ?? "refused", "1000.50");
  check("numbers typed as numbers are read", manual.validateManualInvoice("SALES", good({ value: 1000, salesTax: 180 }), period).value.value, "1000.00");
  check("a rule question (tax that does not match the rate) is NOT refused here", manual.validateManualInvoice("SALES", good({ salesTax: "5" }), period).ok, true);
  check("a registered buyer with no number is NOT refused here (the row checks decide)", manual.validateManualInvoice("SALES", good({ partyRegistrationNo: "" }), period).ok, true);

  // --- Stored entries. ---
  check("nothing stored means no entries", [manual.parseStoredManual(null), manual.parseStoredManual("x"), manual.parseStoredManual({})], [[], [], []]);
  const damaged = manual.parseStoredManual([null, 5, "x", { partyName: 7, value: "12.00", documentNo: "A" }]);
  check("a damaged stored list keeps only objects, with text fields", [damaged.length, damaged[0].partyName, damaged[0].value, damaged[0].documentNo], [1, "", "12.00", "A"]);
  const roundTrip = manual.validateManualInvoice("SALES", ok.value, period);
  check("a stored entry passes validation again unchanged", roundTrip.value, ok.value);
}

// ------------------------------------------------- 2. cells and merging

function runCellChecks() {
  const sale = manual.validateManualInvoice("SALES", good({ partyType: "Unregistered", furtherTax: "40", withheld: "1.5" }), period).value;
  const cells = manual.entryToCells("SALES", sale);
  check("a sales row has 30 cells", cells.length, 30);
  check("the sales cells sit in the template columns", [cells[SALES_COLUMNS.partyRegistrationNo], cells[SALES_COLUMNS.partyName], cells[SALES_COLUMNS.partyType], cells[SALES_COLUMNS.documentNo], cells[SALES_COLUMNS.documentDate], cells[SALES_COLUMNS.saleType], cells[SALES_COLUMNS.rate], cells[SALES_COLUMNS.value], cells[SALES_COLUMNS.salesTax], cells[SALES_COLUMNS.furtherTax], cells[SALES_COLUMNS.stWithheld]], ["1234567", "Al-Noor Traders", "Unregistered", "INV-900", "2026-08-05", "Goods at standard rate (default)", 0.18, 1000, 180, 40, 1.5]);
  check("blank boxes are empty cells, not zeros", [cells[SALES_COLUMNS.fixedOrRetailValue], cells[SALES_COLUMNS.exemptionSroNo], cells[SALES_COLUMNS.invoiceRefNo], cells[SALES_COLUMNS.reason]], [null, null, null, null]);
  check("the serial number column is left empty", cells[0], null);
  const exemptType = manual.manualOptions("SALES").tradeTypes.find((t) => manual.treatmentOf(t) === "exempt");
  check("a text rate stays text and a number rate becomes a number", [manual.entryToCells("SALES", { ...sale, rate: "Exempt", tradeType: exemptType })[SALES_COLUMNS.rate], cells[SALES_COLUMNS.rate]], ["Exempt", 0.18]);
  const purchase = manual.validateManualInvoice("PURCHASES", goodPurchase({ furtherTax: "99" }), period).value;
  const pcells = manual.entryToCells("PURCHASES", purchase);
  check("a purchase row uses the purchase columns and has no further tax", [pcells[PURCHASE_COLUMNS.documentNo], pcells[PURCHASE_COLUMNS.purchaseType], pcells[PURCHASE_COLUMNS.value], pcells[PURCHASE_COLUMNS.salesTax], pcells.includes(99)], ["PI-900", "Goods at standard rate (default)", 1000, 180, false]);

  // --- Merging. ---
  const entries = [good(), good({ documentNo: "INV-901" })].map((e) => manual.validateManualInvoice("SALES", e, period).value);
  check("with nothing typed the file is returned as it is", manual.mergeManualGrid({ kind: "SALES", fileGrid: august.salesGrid, entries: [], registrationNo, period }), august.salesGrid);
  check("with no file and nothing typed there is no grid", manual.mergeManualGrid({ kind: "SALES", fileGrid: null, entries: [], registrationNo, period }), null);
  const merged = manual.mergeManualGrid({ kind: "SALES", fileGrid: august.salesGrid, entries, registrationNo, period });
  check("typed rows come straight after the last file row", [merged.length, merged[9][SALES_COLUMNS.documentNo], merged[10][SALES_COLUMNS.documentNo]], [11, "INV-900", "INV-901"]);
  check("the file's own rows are untouched", JSON.stringify(merged.slice(0, 9)), JSON.stringify(august.salesGrid));
  check("the first typed row number is the real sheet row", manual.firstManualRow(august.salesGrid), 10);
  check("with no file the first typed row is 6", manual.firstManualRow(null), 6);
  const padded = [...august.salesGrid, new Array(31).fill(null), new Array(31).fill("")];
  check("empty rows at the end of a file are not counted", [manual.firstManualRow(padded), manual.mergeManualGrid({ kind: "SALES", fileGrid: padded, entries, registrationNo, period }).length], [10, 11]);
  const alone = manual.mergeManualGrid({ kind: "SALES", fileGrid: null, entries, registrationNo, period });
  check("with no file a header is built and the rows start at row 6", [alone.length, alone[5][SALES_COLUMNS.documentNo], alone[6][SALES_COLUMNS.documentNo]], [7, "INV-900", "INV-901"]);
  check("the built header carries the client, month and template marker", [alone[1][2], alone[1][5], alone[2][1]], [registrationNo, "2026-08-01", `${registrationNo}-01/08/2026_~_DSI_~_1.0.44`]);
  const pAlone = manual.mergeManualGrid({ kind: "PURCHASES", fileGrid: null, entries: [manual.validateManualInvoice("PURCHASES", goodPurchase(), period).value], registrationNo, period });
  check("the purchase header names the purchase template", pAlone[2][1], `${registrationNo}-01/08/2026_~_DPI_~_1.0.29`);
  check("the built header is readable by the template reader", reader.readSalesSheet(alone).readable, true);
  check("merging does not change the stored file grid", JSON.stringify(august.salesGrid.length), "9");
}

// ------------------------------------------------------------ 3. parity

function runParityChecks() {
  const file = prepareMonth({ registrationNo, period, salesGrid: august.salesGrid, purchaseGrid: august.purchaseGrid });
  check("the file result is the hand-worked balance", [file.canEstimate, file.lines.find((l) => l.sr === "37").salesTax], [true, 8408309]);

  check("the fixture converts to 4 sales and 3 purchase entries", [typedSales.length, typedPurchases.length], [4, 3]);
  for (const entry of typedSales) {
    const result = manual.validateManualInvoice("SALES", entry, period);
    check(`fixture sale ${entry.documentNo} passes the form rules unchanged`, [result.ok, result.ok && JSON.stringify(result.value) === JSON.stringify(entry)], [true, true]);
  }
  for (const entry of typedPurchases) {
    const result = manual.validateManualInvoice("PURCHASES", entry, period);
    check(`fixture purchase ${entry.documentNo} passes the form rules unchanged`, [result.ok, result.ok && JSON.stringify(result.value) === JSON.stringify(entry)], [true, true]);
  }

  const salesAlone = manual.mergeManualGrid({ kind: "SALES", fileGrid: null, entries: typedSales, registrationNo, period });
  const purchasesAlone = manual.mergeManualGrid({ kind: "PURCHASES", fileGrid: null, entries: typedPurchases, registrationNo, period });
  const typedOnly = prepareMonth({ registrationNo, period, salesGrid: salesAlone, purchaseGrid: purchasesAlone });
  check("PARITY: typed-only gives the file's lines exactly", sameResult(typedOnly, file), true);
  check("PARITY: typed-only gives the same balance, 8,408,309 paisa", [typedOnly.canEstimate, typedOnly.lines.find((l) => l.sr === "37").salesTax], [true, 8408309]);
  check("PARITY: typed-only raises the same problems as the file", JSON.stringify(typedOnly.problems.map((p) => [p.code, p.severity])), JSON.stringify(file.problems.map((p) => [p.code, p.severity])));

  // Split the same month: first rows from a file, the rest typed.
  const keep = (grid, count) => [...grid.slice(0, 5 + count)];
  for (const count of [1, 2, 3]) {
    const mixedSales = manual.mergeManualGrid({ kind: "SALES", fileGrid: keep(august.salesGrid, count), entries: typedSales.slice(count), registrationNo, period });
    const mixedPurchases = manual.mergeManualGrid({ kind: "PURCHASES", fileGrid: keep(august.purchaseGrid, Math.min(count, 2)), entries: typedPurchases.slice(Math.min(count, 2)), registrationNo, period });
    const mixed = prepareMonth({ registrationNo, period, salesGrid: mixedSales, purchaseGrid: mixedPurchases });
    check(`PARITY: ${count} file row(s) plus the rest typed gives the file's lines`, sameResult(mixed, file), true);
  }
  const stats = analyzeUploads({ registrationNo, period, salesGrid: salesAlone, purchaseGrid: purchasesAlone });
  const fileStats = analyzeUploads({ registrationNo, period, salesGrid: august.salesGrid, purchaseGrid: august.purchaseGrid });
  check("PARITY: invoice counts and totals match the file", JSON.stringify([stats.sales, stats.purchases]), JSON.stringify([fileStats.sales, fileStats.purchases]));

  // The fixed-asset marker works on typed purchase rows (row numbers are real).
  const withAsset = prepareMonth({ registrationNo, period, salesGrid: salesAlone, purchaseGrid: purchasesAlone, capitalGoodsRows: [6] });
  const assetFile = prepareMonth({ registrationNo, period, salesGrid: august.salesGrid, purchaseGrid: august.purchaseGrid, capitalGoodsRows: [6] });
  check("PARITY: marking typed purchase row 6 as a fixed asset equals marking file row 6", sameResult(withAsset, assetFile), true);

  // --- Typed rows face the same row checks, under their real row. ---
  const wrongTax = manual.mergeManualGrid({ kind: "SALES", fileGrid: august.salesGrid, entries: [manual.validateManualInvoice("SALES", good({ salesTax: "5" }), period).value], registrationNo, period });
  const wrong = analyzeUploads({ registrationNo, period, salesGrid: wrongTax, purchaseGrid: null });
  const taxProblem = wrong.problems.find((p) => p.row === 10);
  check("a typed row with the wrong tax is reported at its real sheet row", [Boolean(taxProblem), taxProblem && taxProblem.sheet], [true, "sales"]);
  const noFurther = manual.mergeManualGrid({ kind: "SALES", fileGrid: null, entries: [manual.validateManualInvoice("SALES", good({ partyType: "Unregistered", partyRegistrationNo: "", partyName: "Walk-in" }), period).value], registrationNo, period });
  const noFurtherResult = analyzeUploads({ registrationNo, period, salesGrid: noFurther, purchaseGrid: null });
  check("a typed unregistered sale with no further tax is flagged like a file row", noFurtherResult.problems.some((p) => p.row === 6 && /further/i.test(p.message)), true);
  const duplicate = manual.mergeManualGrid({ kind: "SALES", fileGrid: august.salesGrid, entries: [typedSales[0]], registrationNo, period });
  const dupResult = analyzeUploads({ registrationNo, period, salesGrid: duplicate, purchaseGrid: null });
  check("a typed copy of a file invoice is flagged as a duplicate", dupResult.problems.some((p) => /duplicate|twice|already/i.test(p.message)), true);
  const stwh = manual.mergeManualGrid({ kind: "SALES", fileGrid: null, entries: [{ ...good(), documentType: "STWH" }], registrationNo, period });
  check("a hand-made STWH row is still refused by the row checks", analyzeUploads({ registrationNo, period, salesGrid: stwh, purchaseGrid: null }).problems.length > 0, true);
}

// ------------------------------------------------------ 5. the database

async function gridToWorkbook(grid) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("SALES_INVOICES");
  grid.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      if (value === "" || value === null || value === undefined) return;
      let written = value;
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) written = new Date(`${value}T00:00:00.000Z`);
      sheet.getCell(rowIndex + 1, columnIndex + 1).value = written;
    });
  });
  sheet.mergeCells("A4:A5"); sheet.mergeCells("B4:D4"); sheet.mergeCells("E4:E5"); sheet.mergeCells("F4:F5");
  sheet.mergeCells("G4:J4"); sheet.mergeCells("K4:K5"); sheet.mergeCells("L4:L5"); sheet.mergeCells("W4:X4");
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

async function runDatabaseChecks() {
  let PrismaClient;
  try {
    ({ PrismaClient } = require("@prisma/client"));
  } catch {
    console.log("Sales tax manual database checks skipped: Prisma client is not generated.");
    return;
  }
  const probe = new PrismaClient();
  try {
    await probe.$queryRawUnsafe("SELECT 1");
  } catch {
    await probe.$disconnect().catch(() => {});
    console.log("Sales tax manual database checks skipped (no database reachable).");
    return;
  }
  const columns = await probe.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name = 'SalesTaxUpload'`);
  await probe.$disconnect();
  if (columns.length === 0) {
    check("the database has the uploads table: run `npx prisma migrate deploy`", columns.length > 0, true);
    return;
  }

  const { prisma } = kit.load("lib/prisma.ts");
  const actions = kit.load("app/actions/sales-tax.ts");
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const emails = [];
  const newEmail = (tag) => {
    const email = `sales-tax-mn-${tag}-${suffix}@example.invalid`;
    emails.push(email);
    return email;
  };
  const upload = (filingId, kind, bytes, name) => {
    const data = new FormData();
    data.set("filingId", filingId);
    data.set("kind", kind);
    data.set("file", new File([bytes], name, { type: "application/octet-stream" }));
    return actions.uploadSalesTaxInvoicesAction(data);
  };
  const profile = { businessName: "Acme Traders", registrationNo, authorities: ["FBR"] };
  const stored = (filingId, kind) => prisma.salesTaxUpload.findUnique({ where: { filingId_kind: { filingId, kind } } });
  const save = (filingId, kind, invoice, index) => actions.saveSalesTaxManualInvoiceAction({ filingId, kind, invoice, index });
  const open = async (filingId) => (await actions.getSalesTaxFilingAction(filingId));

  try {
    sessionEmail = newEmail("owner");
    await actions.saveSalesTaxProfileAction(profile);
    const started = await actions.startSalesTaxMonthAction({ authority: "FBR", ...august.period });
    const filingId = started.id;

    // --- Add. ---
    const first = await save(filingId, "SALES", typedSales[0]);
    check("a typed sale is saved", first.success, true);
    check("the state shows typed rows and no file", [first.invoices.sales.hasFile, first.invoices.sales.manualCount, first.invoices.sales.invoiceCount, first.invoices.sales.fileName, first.invoices.sales.fileSize], [false, 1, 1, "Entered by hand", 0]);
    check("the typed row carries the real sheet row 6", [first.invoices.salesManual[0].index, first.invoices.salesManual[0].sourceRow], [0, 6]);
    check("the purchases side is still empty", [first.invoices.purchases, first.invoices.purchasesManual], [null, []]);
    check("the typed sale is stored as its own record, not as a file", [(await stored(filingId, "SALES")) === null, (await stored(filingId, "SALES_MANUAL")).rowCount], [true, 1]);
    for (const entry of typedSales.slice(1)) await save(filingId, "SALES", entry);
    for (const entry of typedPurchases) await save(filingId, "PURCHASES", entry);
    const typed = await open(filingId);
    check("typed invoices alone give the hand-worked balance", [typed.review.estimate.canEstimate, typed.review.estimate.balancePayable], [true, 8408309]);
    check("the invoice counts add up", [typed.invoices.sales.invoiceCount, typed.invoices.purchases.invoiceCount], [4, 3]);
    check("the typed rows are numbered 6 to 9", typed.invoices.salesManual.map((r) => r.sourceRow), [6, 7, 8, 9]);

    // --- Refusals store nothing. ---
    const bad = await save(filingId, "SALES", { ...typedSales[0], value: "abc" });
    check("a bad invoice is refused with a message", [bad.success, /number/.test(bad.error)], [false, true]);
    check("a refused invoice stores nothing", (await stored(filingId, "SALES_MANUAL")).rowCount, 4);
    check("a wrong kind is refused", (await actions.saveSalesTaxManualInvoiceAction({ filingId, kind: "SALES_MANUAL", invoice: typedSales[0] })).success, false);
    check("a missing month is refused", (await save("no-such-id", "SALES", typedSales[0])).success, false);
    check("an edit of a position that does not exist is refused", [(await save(filingId, "SALES", typedSales[0], 9)).success, (await save(filingId, "SALES", typedSales[0], -1)).success, (await save(filingId, "SALES", typedSales[0], 1.5)).success], [false, false, false]);
    check("the refused edits changed nothing", (await stored(filingId, "SALES_MANUAL")).rowCount, 4);

    // --- Edit. ---
    const edited = await save(filingId, "SALES", { ...typedSales[1], documentNo: "INV-002-EDITED" }, 1);
    check("an edit replaces that position only", [edited.success, edited.invoices.salesManual.map((r) => r.invoice.documentNo)], [true, ["INV-001", "INV-002-EDITED", "INV-003", "INV-004"]]);
    await save(filingId, "SALES", typedSales[1], 1);

    // --- Remove. ---
    const removedMiddle = await actions.removeSalesTaxManualInvoiceAction(filingId, "SALES", 1);
    check("removing one typed invoice renumbers the rest", [removedMiddle.success, removedMiddle.invoices.salesManual.map((r) => [r.index, r.sourceRow, r.invoice.documentNo])], [true, [[0, 6, "INV-001"], [1, 7, "INV-003"], [2, 8, "INV-004"]]]);
    check("removing a position that does not exist is refused", [(await actions.removeSalesTaxManualInvoiceAction(filingId, "SALES", 7)).success, (await actions.removeSalesTaxManualInvoiceAction(filingId, "SALES", -1)).success, (await actions.removeSalesTaxManualInvoiceAction(filingId, "NOPE", 0)).success], [false, false, false]);
    await save(filingId, "SALES", typedSales[1], 0);
    for (let i = 0; i < 3; i += 1) await actions.removeSalesTaxManualInvoiceAction(filingId, "SALES", 0);
    check("removing the last typed invoice deletes the record", [(await stored(filingId, "SALES_MANUAL")) === null, (await open(filingId)).invoices.sales], [true, null]);

    // --- File plus typed. ---
    const upSales = await upload(filingId, "SALES", await gridToWorkbook(august.salesGrid), "august-sales.xlsx");
    const upPurchases = await upload(filingId, "PURCHASES", await gridToWorkbook(august.purchaseGrid), "august-purchases.xlsx");
    check("both Excel files are accepted", [upSales.success, upPurchases.success], [true, true]);
    const fileOnly = await open(filingId);
    check("with the file and typed purchases both counted, the balance is not doubled", fileOnly.review.estimate.problems.some((p) => /duplicate|twice|already/i.test(p.message)) || fileOnly.review.estimate.balancePayable !== 8408309, true);
    for (let i = 0; i < 3; i += 1) await actions.removeSalesTaxManualInvoiceAction(filingId, "PURCHASES", 0);
    const filesOnly = await open(filingId);
    check("with only the two files the balance is the hand-worked one", filesOnly.review.estimate.balancePayable, 8408309);

    const extra = good({ documentNo: "INV-900", value: "10000", salesTax: "1800", partyRegistrationNo: "1234567" });
    const mixed = await save(filingId, "SALES", extra);
    check("a typed sale next to the file is counted with it", [mixed.success, mixed.invoices.sales.hasFile, mixed.invoices.sales.manualCount, mixed.invoices.sales.invoiceCount], [true, true, 1, 5]);
    check("its sheet row follows the file's last row", mixed.invoices.salesManual[0].sourceRow, 10);
    check("the file keeps its own name", mixed.invoices.sales.fileName, "august-sales.xlsx");
    const mixedOpen = await open(filingId);
    check("the return counts the typed sale: output tax rises by exactly its tax", mixedOpen.review.estimate.balancePayable, 8408309 + 180000);
    check("the total tax of the file plus the typed row is right", mixed.invoices.sales.taxPaisa, 16735509 + 180000);

    // --- The file and the typed rows are separate records. ---
    const replaced = await upload(filingId, "SALES", await gridToWorkbook(august.salesGrid), "august-sales-v2.xlsx");
    check("replacing the file keeps the typed invoices", [replaced.success, replaced.invoices.sales.fileName, replaced.invoices.sales.manualCount], [true, "august-sales-v2.xlsx", 1]);
    const noFile = await actions.removeSalesTaxUploadAction(filingId, "SALES");
    check("removing the file keeps the typed invoices", [noFile.success, noFile.invoices.sales.hasFile, noFile.invoices.sales.manualCount, noFile.invoices.sales.fileName], [true, false, 1, "Entered by hand"]);
    check("the typed row moves up to row 6 when the file is gone", noFile.invoices.salesManual[0].sourceRow, 6);
    check("the typed record is still stored", (await stored(filingId, "SALES_MANUAL")).rowCount, 1);
    await actions.removeSalesTaxManualInvoiceAction(filingId, "SALES", 0);
    check("with the file and the typed invoices both gone the side is empty", (await open(filingId)).invoices.sales, null);
    await upload(filingId, "SALES", await gridToWorkbook(august.salesGrid), "august-sales.xlsx");

    // --- Fixed assets point at the merged purchase rows, and follow them. ---
    const cap = (n, extra = {}) => goodPurchase({ documentNo: `PI-CAP-${n}`, partyRegistrationNo: "9988776", value: "20000", salesTax: "3600", ...extra });
    const figuresWith = (rows) => ({ adjustments: {}, excludedFrom8B: false, capitalGoodsRows: rows, imports: [], exports: [] });
    const savedRows = async () => (await prisma.salesTaxFiling.findUnique({ where: { id: filingId } })).figures?.capitalGoodsRows ?? [];
    await save(filingId, "PURCHASES", cap(1));
    const capital = await save(filingId, "PURCHASES", cap(2));
    check("the typed purchases follow the purchase file, at rows 9 and 10", capital.invoices.purchasesManual.map((r) => r.sourceRow), [9, 10]);
    check("a typed purchase from a registered seller can be marked as a fixed asset", (await actions.saveSalesTaxFiguresAction(filingId, figuresWith("10"))).success, true);
    const unregTyped = await save(filingId, "PURCHASES", goodPurchase({ documentNo: "PI-UNREG", partyType: "Unregistered", partyRegistrationNo: "", partyName: "Walk-in", salesTax: "0" }));
    check("a typed purchase from an unregistered seller cannot be a fixed asset", [unregTyped.success, (await actions.saveSalesTaxFiguresAction(filingId, figuresWith("11"))).success], [true, false]);
    await actions.removeSalesTaxManualInvoiceAction(filingId, "PURCHASES", 2);
    await actions.removeSalesTaxManualInvoiceAction(filingId, "PURCHASES", 0);
    check("removing a typed purchase above the marked one moves the mark with it", [await savedRows(), (await open(filingId)).invoices.purchasesManual[0].invoice.documentNo], [[9], "PI-CAP-2"]);
    check("the moved mark still passes the fixed-asset check", (await actions.saveSalesTaxFiguresAction(filingId, figuresWith("9"))).success, true);
    await save(filingId, "PURCHASES", cap(3));
    await actions.removeSalesTaxManualInvoiceAction(filingId, "PURCHASES", 0);
    check("removing the marked typed purchase itself drops its mark", await savedRows(), []);
    await actions.saveSalesTaxFiguresAction(filingId, figuresWith("9"));
    const shorter = await upload(filingId, "PURCHASES", await gridToWorkbook(august.purchaseGrid.slice(0, 7)), "august-purchases-short.xlsx");
    check("a shorter purchase file moves the typed row up", [shorter.success, shorter.invoices.purchasesManual[0].sourceRow], [true, 8]);
    check("and the fixed-asset mark moves with it", await savedRows(), [8]);
    const longer = await upload(filingId, "PURCHASES", await gridToWorkbook(august.purchaseGrid), "august-purchases.xlsx");
    check("the full file moves the typed row back and the mark follows", [longer.invoices.purchasesManual[0].sourceRow, await savedRows()], [9, [9]]);
    await actions.saveSalesTaxFiguresAction(filingId, figuresWith("6, 9"));
    const noPurchaseFile = await actions.removeSalesTaxUploadAction(filingId, "PURCHASES");
    check("without the purchase file the typed row is row 6 and its mark moved there", [noPurchaseFile.invoices.purchasesManual[0].sourceRow, (await savedRows()).includes(6)], [6, true]);
    await actions.removeSalesTaxManualInvoiceAction(filingId, "PURCHASES", 0);
    await actions.saveSalesTaxFiguresAction(filingId, figuresWith(""));
    await upload(filingId, "PURCHASES", await gridToWorkbook(august.purchaseGrid), "august-purchases.xlsx");
    check("back to the two files: the hand-worked balance again", (await open(filingId)).review.estimate.balancePayable, 8408309);
    const purchaseExtra = cap(9);

    // --- Approval. ---
    await actions.removeSalesTaxManualInvoiceAction(filingId, "SALES", 0).catch(() => {});
    const approved = await actions.approveSalesTaxReturnAction(filingId, true);
    check("the return is approved", [approved.success, approved.review.approval.current], [true, true]);
    await save(filingId, "SALES", extra);
    check("typing another invoice makes the approval stale", (await open(filingId)).review.approval.current, false);
    await actions.removeSalesTaxManualInvoiceAction(filingId, "SALES", 0);
    check("removing it again makes the same packet current again", (await open(filingId)).review.approval.current, true);
    const overview = await actions.getSalesTaxOverviewAction();
    check("the list shows the approval as current again", overview.filings.find((f) => f.id === filingId).approval, "current");
    await save(filingId, "PURCHASES", purchaseExtra);
    check("the list shows the approval as stale after a typed purchase", (await actions.getSalesTaxOverviewAction()).filings.find((f) => f.id === filingId).approval, "stale");
    await actions.removeSalesTaxManualInvoiceAction(filingId, "PURCHASES", 0);

    // --- Simultaneous saves. ---
    await Promise.all([save(filingId, "SALES", good({ documentNo: "RACE-1" })), save(filingId, "SALES", good({ documentNo: "RACE-2" })), save(filingId, "SALES", good({ documentNo: "RACE-3" }))]);
    check("three simultaneous saves all land", (await stored(filingId, "SALES_MANUAL")).rowCount, 3);
    for (let i = 0; i < 3; i += 1) await actions.removeSalesTaxManualInvoiceAction(filingId, "SALES", 0);

    // --- The 500 limit. ---
    const filler = Array.from({ length: 500 }, (_, i) => ({ ...good({ documentNo: `L-${i}` }) }));
    await prisma.salesTaxUpload.create({ data: { filingId, kind: "SALES_MANUAL", fileName: "Entered by hand", fileSize: 0, rowCount: 500, grid: filler } });
    const over = await save(filingId, "SALES", good({ documentNo: "L-500" }));
    check("the 501st typed invoice is refused", [over.success, /500/.test(over.error)], [false, true]);
    check("an existing one can still be edited at the limit", (await save(filingId, "SALES", good({ documentNo: "L-EDIT" }), 499)).success, true);
    await prisma.salesTaxUpload.deleteMany({ where: { filingId, kind: "SALES_MANUAL" } });

    // --- Other people, other states. ---
    sessionEmail = newEmail("other");
    await actions.saveSalesTaxProfileAction({ businessName: "Other Co", registrationNo: "9999999999999", authorities: ["FBR"] });
    check("another user cannot add to this month", (await save(filingId, "SALES", typedSales[0])).success, false);
    await prisma.salesTaxUpload.create({ data: { filingId, kind: "SALES_MANUAL", fileName: "Entered by hand", fileSize: 0, rowCount: 1, grid: [typedSales[0]] } });
    check("another user cannot remove from this month", (await actions.removeSalesTaxManualInvoiceAction(filingId, "SALES", 0)).success, false);
    check("nothing was removed by the refusal", (await stored(filingId, "SALES_MANUAL")).rowCount, 1);
    sessionEmail = null;
    check("without a login nothing is saved", (await save(filingId, "SALES", typedSales[0])).success, false);
    sessionEmail = emails[0];
    await prisma.salesTaxFiling.update({ where: { id: filingId }, data: { status: "FILED" } });
    check("a month that is not a draft cannot get typed invoices", (await save(filingId, "SALES", typedSales[1])).success, false);
    check("a month that is not a draft cannot lose typed invoices", (await actions.removeSalesTaxManualInvoiceAction(filingId, "SALES", 0)).success, false);
    check("the refusals left the typed invoice alone", (await stored(filingId, "SALES_MANUAL")).rowCount, 1);
    await prisma.salesTaxFiling.update({ where: { id: filingId }, data: { status: "DRAFT" } });

    // --- Deleting the month removes the typed rows. ---
    await actions.deleteSalesTaxMonthAction(filingId);
    check("deleting the month deletes the typed invoices", await prisma.salesTaxUpload.count({ where: { filingId } }), 0);
  } finally {
    sessionEmail = null;
    await prisma.user.deleteMany({ where: { email: { in: emails } } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

// ------------------------------------------------------------ 6. wiring

function runWiringChecks() {
  const strip = (source) => source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  const actionsSource = strip(read("app/actions/sales-tax.ts"));
  const body = (name) => {
    const start = actionsSource.indexOf(`function ${name}(`);
    const next = actionsSource.slice(start + 10).search(/\n(export )?(async )?function /);
    return actionsSource.slice(start, next === -1 ? undefined : start + 10 + next);
  };
  check("the new actions are exported", /export async function saveSalesTaxManualInvoiceAction/.test(actionsSource) && /export async function removeSalesTaxManualInvoiceAction/.test(actionsSource), true);
  check("the stored file kind is only looked up inside gridsOf", (actionsSource.match(/upload\.kind === /g) || []).length, 2);
  check("the state, the review and the figures all read the merged grid", [/gridsOf\(/.test(body("buildInvoiceState")), /gridsOf\(/.test(body("computeReview")), /gridsOf\(/.test(body("saveSalesTaxFiguresAction"))], [true, true, true]);
  check("no check reads a bare file grid any more", /upload\.grid|\.file\.grid|file\?\.grid/.test(body("computeReview")), false);
  check("removing a file deletes only the exact file kind", /deleteMany\(\{\s*where: \{\s*filingId: filing\.id,\s*kind\s*\}/.test(body("removeSalesTaxUploadAction")), true);
  check("both typed actions lock the month and run in a transaction", [/\$transaction/.test(body("saveSalesTaxManualInvoiceAction")) && /FOR UPDATE/.test(body("saveSalesTaxManualInvoiceAction")), /\$transaction/.test(body("removeSalesTaxManualInvoiceAction")) && /FOR UPDATE/.test(body("removeSalesTaxManualInvoiceAction"))], [true, true]);
  check("both typed actions are draft-only and owner-checked", [body("saveSalesTaxManualInvoiceAction"), body("removeSalesTaxManualInvoiceAction")].every((b) => /userId/.test(b) && /STATUS_DRAFT/.test(b)), true);
  check("the typed action validates on the server", /validateManualInvoice\(/.test(body("saveSalesTaxManualInvoiceAction")), true);

  const form = strip(read("components/tax/sales-tax/manual-invoices.tsx"));
  check("the form checks the same rules before it calls the server", /validateManualInvoice\(/.test(form), true);
  check("the form calls both actions", /saveSalesTaxManualInvoiceAction/.test(form) && /removeSalesTaxManualInvoiceAction/.test(form), true);
  check("a tax box the person typed in is not overwritten by the suggestion", /!salesTaxTyped && !\("salesTax" in patch\)/.test(form) && /!furtherTyped && !\("furtherTax" in patch\)/.test(form), true);
  check("the form offers only the template's choices", /manualOptions\(/.test(form) && /rateChoices\(/.test(form), true);
  check("the section can be found by tests", /data-testid=\{`manual-/.test(form) || /data-testid="manual-/.test(form), true);

  const steps = strip(read("components/tax/sales-tax/invoice-steps.tsx"));
  check("the upload step shows the typed invoices on both sales and purchases", /<ManualInvoices/.test(steps) && /salesManual/.test(steps) && /purchasesManual/.test(steps), true);
  check("typed rows are labelled in the problem list", /\(typed in\)/.test(steps), true);
  check("the blockers say typed invoices count too", /Add at least one invoice file or typed invoice\./.test(steps), true);
  check("the wizard gives the step the month", /period=\{\{ year, month \}\}/.test(read("components/tax/sales-tax/sales-tax-wizard.tsx")), true);
  const schema = read("prisma/schema.prisma");
  check("the schema comment names both typed kinds", /SALES_MANUAL/.test(schema) && /PURCHASES_MANUAL/.test(schema), true);
}

(async () => {
  runFormChecks();
  runCellChecks();
  runParityChecks();
  runWiringChecks();
  await runDatabaseChecks();
  finish();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
