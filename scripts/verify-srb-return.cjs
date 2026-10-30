/**
 * Sindh services (SRB) return: line checks, SST-03 arithmetic, figures,
 * late-return warnings and the approval fingerprint.
 *
 * Every expected number was worked out by hand from the form's formulas (SST-03
 * in the 2026-27 Rules and the SRB e-filing guide) and is written next to the
 * data. The tests never ask the code under test to calculate an expectation.
 */

const { load, R, createChecker } = require("./lib/sales-tax-test-kit.cjs");

const entries = load("lib/sales-tax/srb/entries.ts");
const figuresLib = load("lib/sales-tax/srb/figures.ts");
const checksLib = load("lib/sales-tax/srb/checks.ts");
const compute = load("lib/sales-tax/srb/compute.ts");
const estimate = load("lib/sales-tax/srb/estimate.ts");
const problemsLib = load("lib/sales-tax/srb/problems.ts");
const datesLib = load("lib/sales-tax/dates.ts");

const { check, finish } = createChecker("verify-srb-return");

const SEP = { year: 2026, month: 9 };
const rs = (n) => R(n).toString();
const asRupees = (n) => (R(n) / 100).toFixed(2);

function saleRaw(over = {}) {
  return {
    buyerNtn: "1234567-8", buyerName: "Buyer Co", buyerType: "INTERMEDIARY", docType: "SI",
    docNo: "S-1", docDate: "2026-09-10", cpc: "83211", rateId: "standard",
    valueExclTax: asRupees(1000000), salesTax: asRupees(150000), stWithheld: "", ...over,
  };
}
function purchaseRaw(over = {}) {
  return {
    supplierNtn: "7654321-0", supplierName: "Supplier Co", supplierType: "REGISTERED", docType: "PI",
    docNo: "P-1", docDate: "2026-09-05", kind: "SERVICES", cpc: "83131", rateId: "standard",
    valueExclTax: asRupees(400000), salesTax: asRupees(60000), ...over,
  };
}
const okSale = (raw, period = SEP) => {
  const r = entries.checkSale(raw, period);
  if (!r.ok) throw new Error(`test data rejected: ${r.first}`);
  return r.entry;
};
const okPurchase = (raw, period = SEP) => {
  const r = entries.checkPurchase(raw, period);
  if (!r.ok) throw new Error(`test data rejected: ${r.first}`);
  return r.entry;
};
const errorOf = (r) => (r.ok ? null : r.errors);

// ---------------------------------------------------------------------------
// 1. A valid sale and what the checker stores
// ---------------------------------------------------------------------------

{
  const r = entries.checkSale(saleRaw({ stWithheld: asRupees(30000) }), SEP);
  check("a valid standard sale is accepted", r.ok, true);
  check("registration number stored as digits", r.entry.buyerNtn, "12345678");
  check("value in paisa", r.entry.valueExclTax, R(1000000));
  check("tax in paisa", r.entry.salesTax, R(150000));
  check("withheld in paisa", r.entry.stWithheld, R(30000));
  check("an invoice has no original document", r.entry.originalDocNo, "");
  check("typed origin by default", r.entry.origin, "typed");
}
{
  // 15% of Rs 333.33 = 49.9995, so Rs 50.00; Rs 49.01 is more than Rs 1 away.
  check("tax within Rs 1 of the rate is accepted", entries.checkSale(saleRaw({ valueExclTax: "333.33", salesTax: "50.00" }), SEP).ok, true);
  check("tax Rs 1 under is accepted", entries.checkSale(saleRaw({ valueExclTax: "1000.00", salesTax: "149.00" }), SEP).ok, true);
  const bad = errorOf(entries.checkSale(saleRaw({ valueExclTax: "1000.00", salesTax: "148.99" }), SEP));
  check("tax more than Rs 1 away is refused", Object.keys(bad), ["salesTax"]);
  check("the message names the expected tax", bad.salesTax.includes("Rs 150.00") && bad.salesTax.includes("15%"), true);
}
check("empty form lists every required field",
  Object.keys(errorOf(entries.checkSale({}, SEP))).sort(),
  ["buyerName", "buyerNtn", "buyerType", "cpc", "docDate", "docNo", "docType", "rateId", "salesTax", "valueExclTax"]);
check("date before the month is refused", Object.keys(errorOf(entries.checkSale(saleRaw({ docDate: "2026-08-31" }), SEP))), ["docDate"]);
check("date after the month is refused", Object.keys(errorOf(entries.checkSale(saleRaw({ docDate: "2026-10-01" }), SEP))), ["docDate"]);
check("first day of the month is accepted", entries.checkSale(saleRaw({ docDate: "2026-09-01" }), SEP).ok, true);
check("30 February is not a date", Object.keys(errorOf(entries.checkSale(saleRaw({ docDate: "2026-02-30" }), SEP))), ["docDate"]);
check("unknown CPC code", Object.keys(errorOf(entries.checkSale(saleRaw({ cpc: "99999" }), SEP))).includes("cpc"), true);
check("CPC typed with spaces is accepted", entries.checkSale(saleRaw({ cpc: "832 11" }), SEP).ok, true);
check("a rate that does not cover the code is refused", errorOf(entries.checkSale(saleRaw({ cpc: "83211", rateId: "p2-22" }), SEP)).rateId.length > 0, true);
check("an unknown rate id is refused", errorOf(entries.checkSale(saleRaw({ rateId: "p2-999" }), SEP)).rateId.length > 0, true);
check("the standard rate is not allowed for Part I services", errorOf(entries.checkSale(saleRaw({ cpc: "841", rateId: "standard" }), SEP)).rateId.length > 0, true);
check("Part I rate is accepted at 19.5%", entries.checkSale(saleRaw({ cpc: "84110", rateId: "p1-2", valueExclTax: asRupees(200000), salesTax: asRupees(39000) }), SEP).ok, true);
check("zero value refused", Object.keys(errorOf(entries.checkSale(saleRaw({ valueExclTax: "0", salesTax: "0" }), SEP))), ["valueExclTax"]);
check("negative value refused", Object.keys(errorOf(entries.checkSale(saleRaw({ valueExclTax: "-5", salesTax: "0" }), SEP))).includes("valueExclTax"), true);
check("text in the value is refused", Object.keys(errorOf(entries.checkSale(saleRaw({ valueExclTax: "abc" }), SEP))).includes("valueExclTax"), true);
check("withheld more than the tax is refused", Object.keys(errorOf(entries.checkSale(saleRaw({ stWithheld: asRupees(150001) }), SEP))), ["stWithheld"]);
check("withheld equal to the tax is accepted", entries.checkSale(saleRaw({ stWithheld: asRupees(150000) }), SEP).ok, true);
check("NTN too short", Object.keys(errorOf(entries.checkSale(saleRaw({ buyerNtn: "12345" }), SEP))), ["buyerNtn"]);
check("NTN too long", Object.keys(errorOf(entries.checkSale(saleRaw({ buyerNtn: "1234567890123456" }), SEP))), ["buyerNtn"]);
check("pooled unregistered buyer number is accepted", entries.checkSale(saleRaw({ buyerNtn: "9999998-1" }), SEP).entry.buyerNtn, entries.SRB_UNREGISTERED_BUYER_NTN);
check("buyer type must be one of two", Object.keys(errorOf(entries.checkSale(saleRaw({ buyerType: "OTHER" }), SEP))), ["buyerType"]);

// Credit and debit notes
check("a credit note needs the original invoice and a reason",
  Object.keys(errorOf(entries.checkSale(saleRaw({ docType: "CN" }), SEP))).sort(), ["originalDocNo", "reason"]);
{
  const r = entries.checkSale(saleRaw({ docType: "CN", originalDocNo: "S-1", reason: "Discount" }), SEP);
  check("a complete credit note is accepted", r.ok, true);
  check("its amounts stay positive", [r.entry.valueExclTax > 0, r.entry.salesTax > 0], [true, true]);
}
check("a debit note needs the same", Object.keys(errorOf(entries.checkSale(saleRaw({ docType: "DN" }), SEP))).sort(), ["originalDocNo", "reason"]);

// Specific rates
check("per-bill rate needs the number of bills", Object.keys(errorOf(entries.checkSale(saleRaw({ cpc: "67910", rateId: "p2-13", valueExclTax: "10000", salesTax: "3000" }), SEP))), ["units"]);
check("per-bill rate with 3 bills = Rs 3,000", entries.checkSale(saleRaw({ cpc: "67910", rateId: "p2-13", valueExclTax: "10000", salesTax: "3000", units: "3" }), SEP).ok, true);
check("per-bill rate with the wrong tax", Object.keys(errorOf(entries.checkSale(saleRaw({ cpc: "67910", rateId: "p2-13", valueExclTax: "10000", salesTax: "2000", units: "3" }), SEP))), ["salesTax"]);
check("zero bills refused", Object.keys(errorOf(entries.checkSale(saleRaw({ cpc: "67910", rateId: "p2-13", valueExclTax: "10000", salesTax: "0", units: "0" }), SEP))), ["units"]);
check("race club Rs 200 per person x 5 = Rs 1,000", entries.checkSale(saleRaw({ cpc: "96520", rateId: "p2-41", valueExclTax: "5000", salesTax: "1000", units: "5" }), SEP).ok, true);
check("developer needs both areas", Object.keys(errorOf(entries.checkSale(saleRaw({ cpc: "54111", rateId: "p2-1b", valueExclTax: "1", salesTax: "0" }), SEP))).includes("squareYards"), true);
check("developer 100 sq yd + 1,000 sq ft = Rs 10,000 + Rs 50,000", entries.checkSale(saleRaw({ cpc: "54111", rateId: "p2-1b", valueExclTax: "9000000", salesTax: "60000", squareYards: "100", squareFeet: "1000" }), SEP).ok, true);
check("a rate of the old schedule is not valid in September 2026", errorOf(entries.checkSale(saleRaw({ cpc: "97210", rateId: "p2-45b", valueExclTax: "1000", salesTax: "50" }), SEP)).rateId.length > 0, true);
check("the old schedule's rate is valid in June 2026", entries.checkSale(saleRaw({ cpc: "97210", rateId: "p2-45b", valueExclTax: "1000", salesTax: "50", docDate: "2026-06-10" }), { year: 2026, month: 6 }).ok, true);

// ---------------------------------------------------------------------------
// 2. Purchases
// ---------------------------------------------------------------------------

check("a valid services purchase", entries.checkPurchase(purchaseRaw(), SEP).ok, true);
check("a valid goods purchase at 18%", entries.checkPurchase(purchaseRaw({ kind: "GOODS", cpc: "", rateId: "", hsCode: "8471.3000", goodsRatePercent: "18", valueExclTax: "100000", salesTax: "18000" }), SEP).ok, true);
check("goods tax that does not match the rate", Object.keys(errorOf(entries.checkPurchase(purchaseRaw({ kind: "GOODS", cpc: "", rateId: "", hsCode: "8471.3000", goodsRatePercent: "18", valueExclTax: "100000", salesTax: "15000" }), SEP))), ["salesTax"]);
check("goods need an HS code and a rate", Object.keys(errorOf(entries.checkPurchase(purchaseRaw({ kind: "GOODS", cpc: "", rateId: "" }), SEP))).sort(), ["goodsRatePercent", "hsCode"]);
check("goods rate over 50 refused", Object.keys(errorOf(entries.checkPurchase(purchaseRaw({ kind: "GOODS", cpc: "", rateId: "", hsCode: "8471", goodsRatePercent: "180" }), SEP))).includes("goodsRatePercent"), true);
{
  const r = entries.checkPurchase(purchaseRaw({ supplierType: "UNREGISTERED", supplierNtn: "", valueExclTax: "50000", salesTax: "7500" }), SEP);
  check("unregistered supplier is accepted without a number", r.ok, true);
  check("its whole tax becomes non-creditable", r.entry.nonCreditable, R(7500));
  check("with reason 3", r.entry.nonCreditableReason, "3");
}
check("registered supplier needs a number", Object.keys(errorOf(entries.checkPurchase(purchaseRaw({ supplierNtn: "" }), SEP))), ["supplierNtn"]);
{
  const r = entries.checkPurchase(purchaseRaw({ nonCreditable: "5000", nonCreditableReason: "2" }), SEP);
  check("partly non-creditable with a reason", [r.ok, r.entry.nonCreditable, r.entry.nonCreditableReason], [true, R(5000), "2"]);
  check("non-creditable needs a reason", Object.keys(errorOf(entries.checkPurchase(purchaseRaw({ nonCreditable: "5000" }), SEP))), ["nonCreditableReason"]);
  check("non-creditable more than the tax", Object.keys(errorOf(entries.checkPurchase(purchaseRaw({ nonCreditable: "60001", nonCreditableReason: "1" }), SEP))), ["nonCreditable"]);
  check("a stale reason is dropped when nothing is non-creditable", entries.checkPurchase(purchaseRaw({ nonCreditableReason: "2" }), SEP).entry.nonCreditableReason, "");
}
check("withheld by me more than the tax", Object.keys(errorOf(entries.checkPurchase(purchaseRaw({ stWithheldAsAgent: "60001" }), SEP))), ["stWithheldAsAgent"]);
// Claim window: September 2026 reaches back to 1 March 2026 (six months before).
check("earliest claim date for September 2026", entries.earliestClaimDate(SEP), "2026-03-01");
check("earliest claim date wraps over the year", entries.earliestClaimDate({ year: 2026, month: 2 }), "2025-08-01");
check("invoice on the first day of the window", entries.checkPurchase(purchaseRaw({ docDate: "2026-03-01" }), SEP).ok, true);
check("invoice one day too old", Object.keys(errorOf(entries.checkPurchase(purchaseRaw({ docDate: "2026-02-28" }), SEP))), ["docDate"]);
check("invoice dated after the month", Object.keys(errorOf(entries.checkPurchase(purchaseRaw({ docDate: "2026-10-02" }), SEP))), ["docDate"]);
check("purchase credit note needs the original", Object.keys(errorOf(entries.checkPurchase(purchaseRaw({ docType: "CN" }), SEP))).sort(), ["originalDocNo", "reason"]);

// ---------------------------------------------------------------------------
// 3. Exports
// ---------------------------------------------------------------------------

check("a valid export", entries.checkExport({ buyerName: "Acme Ltd", country: "UK", cpc: "83131", docNo: "E-1", docDate: "2026-09-12", amountPkr: "300000" }, SEP).ok, true);
check("an empty export lists every field", Object.keys(errorOf(entries.checkExport({}, SEP))).sort(), ["amountPkr", "buyerName", "country", "cpc", "docDate", "docNo"]);
check("zero export amount", Object.keys(errorOf(entries.checkExport({ buyerName: "A", country: "UK", cpc: "83131", docNo: "E-1", docDate: "2026-09-12", amountPkr: "0" }, SEP))), ["amountPkr"]);

// ---------------------------------------------------------------------------
// 4. The full September 2026 return, worked by hand
// ---------------------------------------------------------------------------
//
// Sales
//   S-1  standard 15%        value 1,000,000  tax 150,000  withheld by buyer 30,000
//   S-2  legal 8%            value   500,000  tax  40,000
//   S-3  telephony 19.5%     value   200,000  tax  39,000
//   S-4  freight agency      3 bills x Rs 1,000: value 10,000 tax 3,000
//   CN-1 credit note on S-1  value   100,000  tax  15,000 (15%)
//   9a: tax 150,000 + 39,000 - 15,000 = 174,000; value 1,000,000 + 200,000 - 100,000 = 1,100,000
//   9b: tax 40,000 + 3,000 = 43,000; value 510,000
//   7 : 30,000
// Purchases
//   P-1  services 15%        value 400,000 tax 60,000, withheld by me 12,000
//   P-2  goods 18%           value 100,000 tax 18,000, non-creditable 5,000 (reason 2)
//   P-3  unregistered        value  50,000 tax  7,500 (whole tax non-creditable, reason 3)
//   1 = 60,000 + 18,000 + 7,500 = 85,500
//   4 = 5,000 + 7,500 + other 10,000 = 22,500
//   5 = 85,500 - 22,500 = 63,000
// Figures: 6 = 20,000; 7a = 1,000; 7b = 500; 21 = 2,000; 23 = 500
//   8  = 63,000 + 20,000 + 30,000 - 1,000 + 500 = 112,500
//   11 = 174,000 + 43,000 = 217,000
//   12 = 0 + 20,000 + 85,500 - 22,500 - 1,000 + 500 = 82,500
//   13 = 174,000 - (30,000 + 82,500) = 61,500
//   14a = 12,000
//   15 = 61,500 + 12,000 + 0 + 43,000 = 116,500
//   20 = 2,000 + 0 + 500 = 2,500;  24 = 119,000;  26 = 119,000
// Export: 300,000

const sales = [
  okSale(saleRaw({ docNo: "S-1", stWithheld: asRupees(30000) })),
  okSale(saleRaw({ docNo: "S-2", cpc: "82110", rateId: "p2-22", valueExclTax: asRupees(500000), salesTax: asRupees(40000), buyerType: "END_CONSUMER" })),
  okSale(saleRaw({ docNo: "S-3", cpc: "84110", rateId: "p1-2", valueExclTax: asRupees(200000), salesTax: asRupees(39000) })),
  okSale(saleRaw({ docNo: "S-4", cpc: "67910", rateId: "p2-13", valueExclTax: "10000", salesTax: "3000", units: "3" })),
  okSale(saleRaw({ docNo: "CN-1", docType: "CN", originalDocNo: "S-1", reason: "Discount", valueExclTax: asRupees(100000), salesTax: asRupees(15000) })),
];
const purchases = [
  okPurchase(purchaseRaw({ docNo: "P-1", stWithheldAsAgent: asRupees(12000) })),
  okPurchase(purchaseRaw({ docNo: "P-2", kind: "GOODS", cpc: "", rateId: "", hsCode: "8471.3000", goodsRatePercent: "18", valueExclTax: asRupees(100000), salesTax: asRupees(18000), nonCreditable: asRupees(5000), nonCreditableReason: "2" })),
  okPurchase(purchaseRaw({ docNo: "P-3", supplierType: "UNREGISTERED", supplierNtn: "", valueExclTax: asRupees(50000), salesTax: asRupees(7500) })),
];
const figuresForm = figuresLib.emptySrbFiguresForm();
figuresForm.amounts.creditBroughtForward6 = "20000";
figuresForm.amounts.otherNonCreditable4 = "10000";
figuresForm.amounts.disallowed7a = "1000";
figuresForm.amounts.allowed7b = "500";
figuresForm.amounts.additionalTax21 = "2000";
figuresForm.amounts.penalty23 = "500";
figuresForm.exports = [{ buyerName: "Acme Ltd", country: "UK", cpc: "83131", docNo: "E-1", docDate: "2026-09-12", amountPkr: "300000" }];
const figuresResult = figuresLib.validateSrbFiguresForm(figuresForm, SEP);
check("the figures form is accepted", figuresResult.ok, true);
const figures = figuresResult.value;

const result = compute.computeSrbReturn({ period: SEP, sales, purchases, figures });
check("the return can be estimated", result.canEstimate, true);
const amountOf = (sr) => result.bySr[sr].amount;
for (const [sr, rupees] of [
  ["1", 85500], ["2", 0], ["3", 0], ["4", 22500], ["5", 63000], ["6", 20000], ["7", 30000], ["7a", 1000], ["7b", 500],
  ["8", 112500], ["9a", 174000], ["9b", 43000], ["11", 217000], ["12", 82500], ["13", 61500], ["14", 0], ["14a", 12000],
  ["14b", 0], ["15", 116500], ["17", 0], ["18", 0], ["19", 0], ["20", 2500], ["21", 2000], ["22", 0], ["23", 500],
  ["24", 119000], ["25", 0], ["26", 119000],
]) {
  check(`row ${sr}`, amountOf(sr), R(rupees));
}
check("row 9a value", result.bySr["9a"].value, R(1100000));
check("row 9b value", result.bySr["9b"].value, R(510000));
check("row 10 value", result.bySr["10"].value, R(300000));
check("row 1 value", result.bySr["1"].value, R(550000));
check("balance payable is row 26", result.balancePayable, R(119000));
check("reduced-rate output reported", result.reducedRateOutput, R(43000));
check("payable is flagged unconfirmed", result.payableUnconfirmed, true);
check("every row that depends on row 13 is provisional", ["13", "15", "17", "18", "19", "24", "26"].map((sr) => result.bySr[sr].status), Array(7).fill("provisional"));
check("rows 1 to 10 are never provisional", ["1", "4", "5", "7", "8", "9a", "9b", "10"].some((sr) => result.bySr[sr].status === "provisional"), false);
check("row 2, 14b and 27 are fixed", [result.bySr["2"].status, result.bySr["14b"].status, result.bySr["27"].status], ["fixed_zero", "fixed_zero", "fixed_zero"]);
check("row 16 is omitted like on the form", result.bySr["16"], undefined);
check("rows come in form order", result.lines.map((l) => l.sr),
  ["1", "2", "3", "4", "5", "6", "7", "7a", "7b", "8", "9a", "9b", "10", "11", "12", "13", "14", "14a", "14b", "15", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27"]);
// Row 12 must equal row 8 minus row 7 (both are built from the printed formulas).
check("row 12 equals row 8 minus row 7", amountOf("12"), amountOf("8") - amountOf("7"));
const codes = result.problems.map((p) => p.code);
check("the evidence warning appears (input 63,000 > 20% of 217,000)", codes.includes("srb_evidence_needed"), true);
check("the credit note original is found", codes.includes("srb_note_original_missing"), false);
check("no problem blocks the estimate", result.problems.filter((p) => p.severity !== "warning").length, 0);
check("one condition warning per reduced-rate option used",
  result.problems.filter((p) => p.code === "srb_option_condition").map((p) => p.message.split('"')[1]).sort(),
  ["Freight transport agency, Rs 1,000 per bill", "Legal, tax consultancy and insolvency services, 8%"]);
check("unregistered supplier warning", codes.includes("srb_unregistered_supplier_tax"), true);
check("no reduced-rate input warning when 'other' is entered", codes.includes("srb_reduced_rate_inputs"), false);
check("amounts sum: rulesUsed names the rates", result.rulesUsed.includes("srb.rate:p2-13"), true);

// Without the "other non-creditable" figure the reduced-rate warning appears.
{
  const f = { ...figures, otherNonCreditable4: 0 };
  const r = compute.computeSrbReturn({ period: SEP, sales, purchases, figures: f });
  check("reduced-rate warning without apportionment", r.problems.some((p) => p.code === "srb_reduced_rate_inputs"), true);
  check("row 4 then holds only the purchase lines: 12,500", r.bySr["4"].amount, R(12500));
}

// Amended return
{
  const f = { ...figures, amended: true, taxPaidPrevious25: R(100000) };
  const r = compute.computeSrbReturn({ period: SEP, sales, purchases, figures: f });
  check("amended: row 26 = 119,000 - 100,000", r.bySr["26"].amount, R(19000));
  const notAmended = { ...figures, amended: false, taxPaidPrevious25: R(100000) };
  const r2 = compute.computeSrbReturn({ period: SEP, sales, purchases, figures: notAmended });
  check("not amended: row 25 stays zero", r2.bySr["25"].amount, 0);
}

// ---------------------------------------------------------------------------
// 5. Credit carried forward and the June refund
// ---------------------------------------------------------------------------
// Sale 100,000 + 15,000; purchase 333,333.33 + 50,000. Row 13 = 15,000 - 50,000 = -35,000.

for (const [period, day, expected18, expected19] of [
  [{ year: 2026, month: 6 }, "2026-06-10", 35000, 0],
  [{ year: 2026, month: 8 }, "2026-08-10", 0, 35000],
]) {
  const s = [okSale(saleRaw({ docNo: "C-1", docDate: day, valueExclTax: "100000", salesTax: "15000" }), period)];
  const p = [okPurchase(purchaseRaw({ docNo: "C-P", docDate: day, valueExclTax: "333333.33", salesTax: "50000" }), period)];
  const r = compute.computeSrbReturn({ period, sales: s, purchases: p, figures: figuresLib.emptySrbFigures() });
  const label = `${period.year}-${period.month}`;
  check(`${label}: row 13`, r.bySr["13"].amount, R(-35000));
  check(`${label}: row 15 payable`, r.bySr["15"].amount, 0);
  check(`${label}: row 17 credit`, r.bySr["17"].amount, R(35000));
  check(`${label}: row 18 refund claim`, r.bySr["18"].amount, R(expected18));
  check(`${label}: row 19 carried forward`, r.bySr["19"].amount, R(expected19));
  check(`${label}: nothing to pay`, r.balancePayable, 0);
  check(`${label}: credit warning`, r.problems.some((x) => x.code === "srb_credit_forward"), true);
}

// Only reduced-rate sales: row 9b is paid in cash whatever the input tax.
{
  const s = [okSale(saleRaw({ docNo: "R-1", cpc: "82110", rateId: "p2-22", valueExclTax: "100000", salesTax: "8000" }))];
  const r = compute.computeSrbReturn({ period: SEP, sales: s, purchases: [], figures: figuresLib.emptySrbFigures() });
  check("reduced-rate only: payable is the 9b tax", r.bySr["15"].amount, R(8000));
  check("reduced-rate only: nothing carried", r.bySr["17"].amount, 0);
}

// ---------------------------------------------------------------------------
// 6. Problems that stop the estimate
// ---------------------------------------------------------------------------

{
  const damaged = { ...sales[0], salesTax: R(1) }; // stored tax no longer matches the rate
  const r = compute.computeSrbReturn({ period: SEP, sales: [damaged, ...sales.slice(1)], purchases, figures });
  check("a stored line that fails its checks stops the estimate", r.canEstimate, false);
  check("no figures are shown then", [r.lines.length, r.balancePayable], [0, null]);
  check("the problem names the line", r.problems.find((p) => p.code === "srb_line_invalid").row, 1);
}
{
  const dup = [sales[0], { ...sales[0], id: "other" }];
  const r = compute.computeSrbReturn({ period: SEP, sales: dup, purchases: [], figures });
  check("a duplicate invoice number stops the estimate", [r.canEstimate, r.problems.some((p) => p.code === "srb_duplicate_invoice")], [false, true]);
}
{
  const sameNumberOtherType = [sales[0], okSale(saleRaw({ docNo: "S-1", docType: "DN", originalDocNo: "S-1", reason: "Extra", valueExclTax: "1000", salesTax: "150" }))];
  const r = compute.computeSrbReturn({ period: SEP, sales: sameNumberOtherType, purchases: [], figures });
  check("the same number on a different document type is not a duplicate", r.problems.some((p) => p.code === "srb_duplicate_invoice"), false);
}
{
  const missing = okSale(saleRaw({ docNo: "CN-9", docType: "CN", originalDocNo: "NOPE", reason: "Return", valueExclTax: "1000", salesTax: "150" }));
  const r = compute.computeSrbReturn({ period: SEP, sales: [missing], purchases: [], figures });
  check("a credit note without its invoice is a warning only", [r.canEstimate, r.problems.some((p) => p.code === "srb_note_original_missing")], [true, true]);
}
{
  const dupPurchase = [purchases[0], { ...purchases[0], id: "dup" }];
  const r = compute.computeSrbReturn({ period: SEP, sales: [], purchases: dupPurchase, figures });
  check("duplicate purchase invoice", r.problems.some((p) => p.code === "srb_duplicate_invoice" && p.sheet === "purchases"), true);
}
{
  const r = compute.computeSrbReturn({ period: SEP, sales: [], purchases: [], figures: figuresLib.emptySrbFigures() });
  check("an empty month warns and gives zero", [r.canEstimate, r.problems.map((p) => p.code), r.balancePayable], [true, ["srb_no_invoices"], 0]);
}
{
  const r = compute.computeSrbReturn({ period: { year: 2025, month: 6 }, sales: [], purchases: [], figures: figuresLib.emptySrbFigures() });
  check("June 2025 is refused", [r.canEstimate, r.problems[0].code, r.problems[0].severity], [false, "srb_period_unsupported", "refuse"]);
}
{
  const r = compute.computeSrbReturn({ period: { year: 2025, month: 7 }, sales: [], purchases: [], figures: figuresLib.emptySrbFigures() });
  check("July 2025 is the first supported month", r.canEstimate, true);
}

// ---------------------------------------------------------------------------
// 7. Late return warnings (September 2026 return: due 18 October 2026)
// ---------------------------------------------------------------------------

const lateCodes = (today) => checksLib.lateReturnProblems(SEP, today).map((p) => p.code);
check("no warning without a date", lateCodes(undefined), []);
check("no warning on the due date", lateCodes("2026-10-18"), []);
check("late one day", lateCodes("2026-10-19"), ["srb_late_return"]);
check("10 days late mentions Rs 1,000.00", checksLib.lateReturnProblems(SEP, "2026-10-28")[0].message.includes("Rs 1,000.00"), true);
check("six months after the due date: still no approval warning", lateCodes("2027-04-18"), ["srb_late_return"]);
check("one day past six months asks for approval", lateCodes("2027-04-19"), ["srb_late_return", "srb_late_needs_approval"]);
// A return due before 1 July 2026 keeps the four-month window: May 2026 return due 18 Jun 2026 + 4 months = 18 Oct 2026.
check("four-month window for older returns", checksLib.lateReturnProblems({ year: 2026, month: 5 }, "2026-10-19").map((p) => p.code), ["srb_late_return", "srb_late_needs_approval"]);
check("four-month window: on the last day", checksLib.lateReturnProblems({ year: 2026, month: 5 }, "2026-10-18").map((p) => p.code), ["srb_late_return"]);
check("addMonthsIso clamps to the last day", datesLib.addMonthsIso("2026-01-31", 1), "2026-02-28");
check("addMonthsIso over a year end", datesLib.addMonthsIso("2026-10-18", 6), "2027-04-18");
check("addMonthsIso negative", datesLib.addMonthsIso("2026-03-15", -4), "2025-11-15");
{
  const withToday = compute.computeSrbReturn({ period: SEP, sales, purchases, figures, today: "2026-12-01" });
  check("late warnings reach the result", withToday.problems.some((p) => p.code === "srb_late_return"), true);
  check("a late return still estimates", withToday.canEstimate, true);
}

// ---------------------------------------------------------------------------
// 8. Figures form
// ---------------------------------------------------------------------------

check("a blank form is all zero", figuresLib.validateSrbFiguresForm(figuresLib.emptySrbFiguresForm(), SEP).value, figuresLib.emptySrbFigures());
check("amounts with commas", figuresLib.validateSrbFiguresForm({ amounts: { creditBroughtForward6: "1,234.50" }, exports: [] }, SEP).value.creditBroughtForward6, 123450);
check("a negative amount is refused", figuresLib.validateSrbFiguresForm({ amounts: { arrears22: "-1" }, exports: [] }, SEP).ok, false);
check("text is refused with the row named", figuresLib.validateSrbFiguresForm({ amounts: { disallowed7a: "abc" }, exports: [] }, SEP).error.startsWith("Row 7a"), true);
check("an absurd amount is refused", figuresLib.validateSrbFiguresForm({ amounts: { arrears22: "999999999999999" }, exports: [] }, SEP).ok, false);
check("row 25 without amended is refused", figuresLib.validateSrbFiguresForm({ amounts: { taxPaidPrevious25: "100" }, amended: false, exports: [] }, SEP).ok, false);
check("row 25 with amended is accepted", figuresLib.validateSrbFiguresForm({ amounts: { taxPaidPrevious25: "100" }, amended: true, exports: [] }, SEP).ok, true);
check("a bad export names its number", figuresLib.validateSrbFiguresForm({ amounts: {}, exports: [{ buyerName: "A" }] }, SEP).error.startsWith("Export 1:"), true);
check("blank export rows are skipped", figuresLib.validateSrbFiguresForm({ amounts: {}, exports: [{}, { buyerName: "", country: "" }] }, SEP).value.exports.length, 0);
check("the same figures save to the same export ids", JSON.stringify(figuresLib.validateSrbFiguresForm(figuresForm, SEP).value) === JSON.stringify(figuresLib.validateSrbFiguresForm(figuresForm, SEP).value), true);
check("form round trip", figuresLib.validateSrbFiguresForm(figuresLib.srbFiguresToForm(figures), SEP).value, figures);
check("stored figures that are damaged fall back to zero", figuresLib.parseStoredSrbFigures({ creditBroughtForward6: -5, arrears22: "x", exports: "no" }), figuresLib.emptySrbFigures());
check("stored figures keep valid amounts", figuresLib.parseStoredSrbFigures(figures), figures);
check("null stored figures", figuresLib.parseStoredSrbFigures(null), figuresLib.emptySrbFigures());

// ---------------------------------------------------------------------------
// 9. Approval packet and fingerprint
// ---------------------------------------------------------------------------

const fingerprintOf = (over = {}) => {
  const input = { period: SEP, registrationNo: "1234567-8", figures, sales, purchases, ...over };
  const res = compute.computeSrbReturn({ ...input, today: over.today });
  return estimate.srbFingerprintOf({ ...input, result: res });
};
const base = fingerprintOf();
check("the fingerprint is a sha256", /^[0-9a-f]{64}$/.test(base), true);
check("the fingerprint is stable", fingerprintOf(), base);
check("the registration number format does not matter", fingerprintOf({ registrationNo: "12345678" }), base);
check("a late warning does not change the fingerprint", fingerprintOf({ today: "2027-01-01" }), base);
check("a changed amount changes it", fingerprintOf({ figures: { ...figures, creditBroughtForward6: R(20001) } }) !== base, true);
check("a removed sale changes it", fingerprintOf({ sales: sales.slice(1) }) !== base, true);
check("a changed purchase changes it", fingerprintOf({ purchases: [{ ...purchases[0], stWithheldAsAgent: 0 }, ...purchases.slice(1)] }) !== base, true);
check("a changed month changes it", fingerprintOf({ period: { year: 2026, month: 10 } }) !== base, true);
{
  const packet = estimate.buildSrbApprovalPacket({
    approvedAt: new Date("2026-10-12T10:00:00Z"), period: SEP, businessName: "Test Co", registrationNo: "1234567-8",
    figures, sales, purchases, result,
  });
  check("an estimate can be approved", packet.ok, true);
  check("the packet says SRB", packet.packet.authority, "SRB");
  check("the packet carries the payable", packet.packet.balancePayable, R(119000));
  check("the packet records the open question", packet.packet.payableUnconfirmed, true);
  check("the packet holds every annex line", [packet.packet.sales.length, packet.packet.purchases.length], [5, 3]);
  check("the packet fingerprint matches", packet.packet.fingerprint, base);
  check("the approval is current", estimate.isApprovalCurrent(packet.packet, { fingerprint: base }), true);
  check("a changed list makes it stale", estimate.isApprovalCurrent(packet.packet, { fingerprint: fingerprintOf({ sales: sales.slice(1) }) }), false);
  check("no packet for an unusable return", estimate.buildSrbApprovalPacket({
    approvedAt: new Date(), period: SEP, businessName: "x", registrationNo: "1", figures, sales, purchases,
    result: compute.computeSrbReturn({ period: { year: 2025, month: 6 }, sales: [], purchases: [], figures }),
  }).ok, false);
}

// ---------------------------------------------------------------------------
// 10. Plain-language messages
// ---------------------------------------------------------------------------

check("every problem code makes a message", problemsLib.SRB_PROBLEM_CODES.every((code) => {
  const p = problemsLib.makeSrbProblem(code, "return", 1, { detail: "x", first: 1, docNo: "n", noteType: "credit note", original: "o", label: "l", reference: "r", condition: "c", optionRequired: 0, cpc: "1", due: "d", days: 1, penalty: "p", months: 6, june: 0, row: 1 });
  return p.message.length > 5 && p.action.length > 5 && !/undefined|\[object/.test(p.message + p.action);
}), true);
check("an unknown problem code throws", (() => { try { problemsLib.makeSrbProblem("nope", "return", null); return false; } catch { return true; } })(), true);

finish();
