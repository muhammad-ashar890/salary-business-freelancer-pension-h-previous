/**
 * Sindh services (SRB) rules: CPC list, rate table by date, due dates,
 * penalties and the dated rule rows.
 *
 * Every expected value below was read by hand from the SRB texts: the
 * consolidated Sindh Sales Tax on Services Act and Rules for 2026-27 (SRB,
 * 20 Aug 2026), the Sindh Finance Act 2026 Gazette and notification
 * SRB-3-4/28/2025 (CPC). None is taken from the code under test.
 */

const { load, createChecker } = require("./lib/sales-tax-test-kit.cjs");

const cpc = load("lib/sales-tax/rules/srb-services/cpc.ts");
const rates = load("lib/sales-tax/rules/srb-services/rates.ts");
const catalog = load("lib/sales-tax/rules/srb-services/catalog.ts");
const dueDates = load("lib/sales-tax/rules/srb-services/due-dates.ts");
const penalties = load("lib/sales-tax/rules/srb-services/penalties.ts");

const { check, finish } = createChecker("verify-srb-rules");

const OLD = "2026-06-30"; // last day of the old schedule
const NEW = "2026-07-01"; // first day of the Finance Act 2026 schedule

const idsFor = (code, day) => rates.rateOptionsForCpc(code, day).map((o) => o.id).sort();
const rateOf = (id, day) => rates.findRateOption(id, day).rate;

// ---------------------------------------------------------------------------
// 1. CPC list
// ---------------------------------------------------------------------------

const all = cpc.allCpcEntries();
check("1424 codes loaded (divisions, groups, classes, subclasses)", all.length, 1424);
check("31 divisions", all.filter((e) => e.level === 2).length, 31);
check("every code has its parent in the list", all.filter((e) => e.level > 2 && !cpc.findCpc(e.code.slice(0, -1))).length, 0);
check("no duplicate codes", new Set(all.map((e) => e.code)).size, all.length);
for (const [code, title] of [
  ["54540", "Concrete services"],
  ["83131", "IT consulting services"],
  ["71610", "Insurance brokerage and agency services"],
  ["972", "Beauty and physical well-being services"],
  ["9292", "Educational support services"],
  ["85931", "Telephone call centre services"],
  ["822", "Accounting, auditing and bookkeeping services"],
  ["62", "Retail trade services"],
]) {
  check(`title of ${code}`, cpc.findCpc(code).title, title);
}
check("normalize strips spaces and dashes", cpc.normalizeCpcCode(" 83-131 "), "83131");
check("unknown code is null", cpc.findCpc("99999"), null);
check("blank is null", cpc.findCpc(""), null);
check("cpcIsUnder child", cpc.cpcIsUnder("83131", "831"), true);
check("cpcIsUnder same", cpc.cpcIsUnder("83131", "83131"), true);
check("cpcIsUnder parent is not under child", cpc.cpcIsUnder("831", "83131"), false);
check("cpcIsUnder sibling", cpc.cpcIsUnder("83132", "83131"), false);
check("path of 83131", cpc.cpcPath("83131").map((e) => e.code), ["83", "831", "8313", "83131"]);
check("search by digits finds 5-digit first", cpc.searchCpc("8313")[0].code, "83131");
check("search by words", cpc.searchCpc("call centre")[0].code, "85931");
check("search with nothing", cpc.searchCpc("  "), []);
check("search honours the limit", cpc.searchCpc("services", 3).length, 3);
for (const note of cpc.CPC_CLARIFICATIONS) {
  check(`clarification code ${note.code} exists`, Boolean(cpc.findCpc(note.code)), true);
}

// ---------------------------------------------------------------------------
// 2. Rate table: structure
// ---------------------------------------------------------------------------

check("first supported day", rates.SRB_FIRST_SUPPORTED_DATE, "2025-07-01");
check("Part I has five codes", rates.SRB_PART_I_CODES, ["83159", "841", "842", "85230", "87340"]);
for (const day of ["2025-07-01", OLD, NEW, "2027-01-15"]) {
  const inForce = rates.rateOptionsInForce(day);
  const ids = inForce.map((o) => o.id);
  check(`no duplicate rate ids on ${day}`, new Set(ids).size, ids.length);
  for (const option of inForce) {
    for (const code of [...option.covers, ...option.except]) {
      if (!cpc.findCpc(code)) check(`code ${code} of ${option.id} is a real CPC code`, false, true);
    }
    if (option.basis === "percent") check(`${option.id} has a rate`, typeof option.rate === "number", true);
  }
  check(`no gap or overlap: findRateOption works for every id on ${day}`, ids.every((id) => rates.findRateOption(id, day)?.id === id), true);
}
check("rates before the supported day are not loaded", rates.rateOptionsInForce("2025-06-30").length, 0);
check("Part I options: 5", rates.rateOptionsInForce(NEW).filter((o) => o.part === "I").length, 5);
// S.Nos 1 to 46 is 46 entries; after FA2026 add 1A, 1B, 16b, 38b, 38c and the split rows 3b and 28b: 53.
check("Part II options on 2026-07-01: 53", rates.rateOptionsInForce(NEW).filter((o) => o.part === "II").length, 53);
// Before FA2026: 46 entries plus the split rows 3b, 28b and 45b: 49.
check("Part II options on 2026-06-30: 49", rates.rateOptionsInForce(OLD).filter((o) => o.part === "II").length, 49);

// ---------------------------------------------------------------------------
// 3. Rate table: what a user is offered for a code
// ---------------------------------------------------------------------------

// Standard only
check("accounting 822 after FA2026: only the standard rate", idsFor("822", NEW), ["standard"]);
check("accounting 822 before FA2026: legal and accounting 8%", idsFor("822", OLD), ["p2-22", "standard"]);
check("legal 821 after FA2026", idsFor("821", NEW), ["p2-22", "standard"]);
check("tax consultancy 823 after FA2026", idsFor("823", NEW), ["p2-22", "standard"]);
check("insolvency 824 after FA2026", idsFor("824", NEW), ["p2-22", "standard"]);
check("repair 871 after FA2026: standard only", idsFor("871", NEW), ["standard"]);
check("repair 871 before FA2026: 8%", idsFor("871", OLD), ["p2-34", "standard"]);
check("repair 872 after FA2026", idsFor("872", NEW), ["p2-34", "standard"]);
check("ordinary 83211 (architecture) is standard only", idsFor("83211", NEW), ["standard"]);

// Part I replaces the standard rate
check("telephony 841 has only the 19.5% rate", idsFor("841", NEW), ["p1-2"]);
check("internet 842", idsFor("842", NEW), ["p1-3"]);
check("85230 tracking", idsFor("85230", OLD), ["p1-4"]);
check("hosting 83159 only 19.5% (and not the 3% IT entry)", idsFor("83159", NEW), ["p1-1"]);
check("87340 installation", idsFor("87340", NEW), ["p1-5"]);
check("Part I rate is 19.5%", rateOf("p1-2", NEW), 0.195);
check("standard rate is 15%", rateOf("standard", NEW), 0.15);

// Construction
check("construction 54111 after FA2026", idsFor("54111", NEW), ["p2-1b", "p2-2", "standard"]);
check("construction 54111 before FA2026", idsFor("54111", OLD), ["p2-1", "p2-2", "standard"]);
check("ready-mix 54540 after FA2026", idsFor("54540", NEW), ["p2-1", "p2-1b", "p2-2", "standard"]);
check("dredging 54232 after FA2026", idsFor("54232", NEW), ["p2-1a", "p2-1b", "p2-2", "standard"]);
check("ready-mix is 8%", rateOf("p2-1", NEW), 0.08);
check("old general construction is 8%", rateOf("p2-1", OLD), 0.08);
check("government works 5%", rateOf("p2-2", NEW), 0.05);

// Freight
check("road freight after FA2026", idsFor("65110", NEW).length > 0 && idsFor("65110", NEW), ["p2-7", "p2-8", "standard"]);
check("road freight before FA2026", idsFor("65110", OLD), ["p2-7", "p2-8", "standard"]);
check("pipeline", idsFor("6513", NEW), ["p2-9", "standard"]);
check("freight agency 67910", idsFor("67910", NEW), ["p2-13", "standard"]);

// Insurance
check("insurance 71610 after FA2026", idsFor("71610", NEW), ["p2-16a", "p2-16b", "standard"]);
check("agents 2%", rateOf("p2-16a", NEW), 0.02);
check("brokers 3%", rateOf("p2-16b", NEW), 0.03);
check("insurance 71610 before FA2026", idsFor("71610", OLD), ["p2-16", "standard"]);
check("old insurance 5%", rateOf("p2-16", OLD), 0.05);

// Education
check("fee-based education 921 after FA2026", idsFor("92110", NEW), ["p2-38a", "standard"]);
check("other education 929 after FA2026", idsFor("92919", NEW), ["p2-38b", "standard"]);
check("educational support 9292 after FA2026", idsFor("92920", NEW).includes("p2-38c") && idsFor("92920", NEW).includes("p2-38b"), false);
check("educational support 9292 offers 5%", idsFor("9292", NEW), ["p2-38c", "standard"]);
check("educational support is 5%", rateOf("p2-38c", NEW), 0.05);
check("education before FA2026", idsFor("92110", OLD), ["p2-38", "standard"]);
check("division 92 typed alone offers every education entry", idsFor("92", NEW), ["p2-38a", "p2-38b", "p2-38c", "standard"]);

// Beauty
check("beauty after FA2026: 8% only", idsFor("97210", NEW), ["p2-45", "standard"]);
check("beauty before FA2026: 8% and 5% with POS", idsFor("97210", OLD), ["p2-45a", "p2-45b", "standard"]);
check("old POS beauty rate 5%", rateOf("p2-45b", OLD), 0.05);

// Others
check("restaurants 633", idsFor("63310", NEW), ["p2-4", "standard"]);
check("trade 612 offers auctioneer and indenter rates", idsFor("612", NEW), ["p2-3a", "p2-3b", "standard"]);
check("sports 96520 offers race club, 8% and standard", idsFor("96520", NEW), ["p2-41", "p2-42", "standard"]);
check("stand-alone cable operators 84632", idsFor("84632", NEW), ["p2-28a", "p2-28b", "standard"]);
check("broadcasting 84631 is excluded from the 8% entry", idsFor("84631", NEW), ["p2-28b", "standard"]);
check("real estate 72240 (appraisal) not in the 8% entry", idsFor("72240", NEW), ["standard"]);
check("real estate 72211 is in the 8% entry", idsFor("72211", NEW), ["p2-18", "standard"]);
check("software licence 73311 gets 3% entry, not the 8% IP entry", idsFor("73311", NEW), ["p2-20", "standard"]);
check("IT consulting 83131", idsFor("83131", NEW), ["p2-20", "standard"]);
check("trademarks 83960 8% IP entry", idsFor("83960", NEW), ["p2-19", "standard"]);
check("call centre 85931", idsFor("85931", NEW), ["p2-32", "standard"]);
check("health 93110", idsFor("93110", NEW), ["p2-39", "standard"]);
check("miscellaneous 97990 is 5%", rateOf("p2-46", NEW), 0.05);
check("an unlisted code gets the standard rate only", idsFor("83310", NEW), ["standard"]);

// Option flags (general condition 2 of Part II: S.Nos 1, 7, 9, 19, 20 and 32)
for (const id of ["p2-1", "p2-7", "p2-9", "p2-19", "p2-20", "p2-32"]) {
  check(`${id} needs the option`, rates.findRateOption(id, NEW).optionRequired, true);
}
for (const id of ["p2-2", "p2-4", "p2-16a", "p2-22", "standard", "p1-2"]) {
  check(`${id} does not need the option`, rates.findRateOption(id, NEW).optionRequired, false);
}
// Output rows: standard and Part I are 9a, Part II is 9b
check("standard goes to row 9a", rates.findRateOption("standard", NEW).row, "9a");
check("Part I goes to row 9a", rates.findRateOption("p1-2", NEW).row, "9a");
check("Part II goes to row 9b", rates.findRateOption("p2-22", NEW).row, "9b");
check("specific rate goes to row 9b", rates.findRateOption("p2-13", NEW).row, "9b");

// ---------------------------------------------------------------------------
// 4. Tax from a line
// ---------------------------------------------------------------------------

const std = rates.findRateOption("standard", NEW);
check("15% of Rs 100,000", rates.expectedTax(std, 10000000), 1500000);
check("15% of Rs 333.33 rounds to Rs 50.00", rates.expectedTax(std, 33333), 5000);
check("19.5% of Rs 100,000", rates.expectedTax(rates.findRateOption("p1-2", NEW), 10000000), 1950000);
check("8% of Rs 12,500", rates.expectedTax(rates.findRateOption("p2-22", NEW), 1250000), 100000);
const perBill = rates.findRateOption("p2-13", NEW);
check("Rs 1,000 per bill for 3 bills", rates.expectedTax(perBill, 50000, { units: 3 }), 300000);
check("per bill without the bill count", rates.expectedTax(perBill, 50000), null);
check("per bill with zero bills", rates.expectedTax(perBill, 50000, { units: 0 }), 0);
check("Rs 200 per person for 10 persons", rates.expectedTax(rates.findRateOption("p2-41", NEW), 0, { units: 10 }), 200000);
const dev = rates.findRateOption("p2-1b", NEW);
check("developer: 500 sq yd and 2,000 sq ft = Rs 50,000 + Rs 100,000", rates.expectedTax(dev, 0, { squareYards: 500, squareFeet: 2000 }), 15000000);
check("developer without areas", rates.expectedTax(dev, 0, {}), null);
check("developer with one area missing", rates.expectedTax(dev, 0, { squareYards: 500 }), null);
check("negative units are refused", rates.expectedTax(perBill, 0, { units: -1 }), null);

// ---------------------------------------------------------------------------
// 5. Dated rule rows
// ---------------------------------------------------------------------------

for (const day of ["2025-07-01", OLD, NEW, "2027-03-31"]) {
  for (const id of catalog.SRB_REQUIRED_RULE_IDS) {
    check(`rule ${id} exists on ${day}`, catalog.findSrbRule(id, day) !== null, true);
  }
}
check("rule rows are not loaded before the first supported day", catalog.findSrbRule("srb.due.payment_day", "2025-06-30"), null);
check("Annex-C day", catalog.findSrbRuleNumber("srb.due.annex_c_day", NEW), 10);
check("payment day", catalog.findSrbRuleNumber("srb.due.payment_day", NEW), 15);
check("return day", catalog.findSrbRuleNumber("srb.due.return_day", NEW), 18);
check("penalty per day", catalog.findSrbRuleNumber("srb.penalty.late_return.per_day", NEW), 100);
check("surcharge margin", catalog.findSrbRuleNumber("srb.default_surcharge.margin", NEW), 3);
check("evidence threshold 20%", catalog.findSrbRuleNumber("srb.input.evidence_threshold_percent", NEW), 20);
check("six periods", catalog.findSrbRuleNumber("srb.input.carry_periods", NEW), 6);
check("late filing window before 1 Jul 2026 is four months", catalog.findSrbRuleNumber("srb.filing.late_months_without_approval", OLD), 4);
check("late filing window from 1 Jul 2026 is six months", catalog.findSrbRuleNumber("srb.filing.late_months_without_approval", NEW), 6);
for (const rule of catalog.SRB_SERVICES_RULES) {
  check(`rule row ${rule.id} names its source`, rule.source.length > 20 && rule.section.length > 0, true);
  check(`rule row ${rule.id} has a check date`, /^\d{4}-\d{2}-\d{2}$/.test(rule.verifiedOn), true);
}

// ---------------------------------------------------------------------------
// 6. Due dates, penalty, surcharge
// ---------------------------------------------------------------------------

check("August 2026 due dates", (({ annexC, payment, returnFiling }) => ({ annexC, payment, returnFiling }))(dueDates.getSrbDueDates({ year: 2026, month: 8 })),
  { annexC: "2026-09-10", payment: "2026-09-15", returnFiling: "2026-09-18" });
check("December 2026 is due in January 2027", dueDates.getSrbDueDates({ year: 2026, month: 12 }).returnFiling, "2027-01-18");
check("July 2025 is the first supported month", dueDates.getSrbDueDates({ year: 2025, month: 7 }).payment, "2025-08-15");
check("June 2025 is not supported", dueDates.getSrbDueDates({ year: 2025, month: 6 }), null);
{
  const override = { period: { year: 2026, month: 8 }, target: "return", date: "2026-09-22", reference: "SRB notice test" };
  const moved = dueDates.getSrbDueDates({ year: 2026, month: 8 }, [override]);
  check("an override moves only its date", [moved.annexC, moved.payment, moved.returnFiling], ["2026-09-10", "2026-09-15", "2026-09-22"]);
  check("the override is reported", moved.overridesApplied.length, 1);
  const unnamed = dueDates.getSrbDueDates({ year: 2026, month: 8 }, [{ ...override, reference: "" }]);
  check("an override without a reference is ignored", unnamed.returnFiling, "2026-09-18");
  const other = dueDates.getSrbDueDates({ year: 2026, month: 9 }, [override]);
  check("an override for another month is ignored", other.returnFiling, "2026-10-18");
}
check("filed on the due date: on time", penalties.srbLateReturnPenalty("2026-09-18", "2026-09-18"), { status: "on_time", daysLate: 0, penalty: 0 });
check("filed early: on time", penalties.srbLateReturnPenalty("2026-09-18", "2026-09-10").status, "on_time");
check("10 days late = Rs 1,000", penalties.srbLateReturnPenalty("2026-09-18", "2026-09-28"), { status: "late", daysLate: 10, penalty: 100000 });
check("45 days late = Rs 4,500", penalties.srbLateReturnPenalty("2026-09-18", "2026-11-02").penalty, 450000);
check("penalty before the supported period", penalties.srbLateReturnPenalty("2025-06-18", "2025-07-18"), { status: "rule_not_loaded" });
// Rs 100,000 unpaid for 30 days at Inter-Bank 11% + 3% = 14% a year: 100,000 x 0.14 x 30 / 365 = Rs 1,150.68
check("default surcharge", penalties.srbDefaultSurcharge({ taxDue: 10000000, daysLate: 30, interBankPercent: 11, dueDate: "2026-09-15" }), 115068);
check("no surcharge when nothing is late", penalties.srbDefaultSurcharge({ taxDue: 10000000, daysLate: 0, interBankPercent: 11, dueDate: "2026-09-15" }), 0);
check("no surcharge without tax due", penalties.srbDefaultSurcharge({ taxDue: 0, daysLate: 30, interBankPercent: 11, dueDate: "2026-09-15" }), 0);
check("bad Inter-Bank rate gives zero", penalties.srbDefaultSurcharge({ taxDue: 10000000, daysLate: 30, interBankPercent: -1, dueDate: "2026-09-15" }), 0);
check("surcharge before the supported period", penalties.srbDefaultSurcharge({ taxDue: 10000000, daysLate: 30, interBankPercent: 11, dueDate: "2025-06-15" }), null);

finish();
