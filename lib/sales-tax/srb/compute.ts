/**
 * Works out form SST-03 from the stored Annex-C and Annex-A lines, the
 * exports and the figures the user typed.
 *
 * Rows 1 to 10 follow the form directly. Rows 11 to 17 follow the formulas
 * printed in the Rules and the official SRB e-filing guide, with ONE open
 * question: row 13 starts from row 11, which the form defines as 9a + 9b,
 * while row 15 adds 9b again. Reduced-rate output cannot be offset by input
 * tax, so the engine works row 13 on the standard-rate output (9a) only and
 * marks every row that depends on it as provisional. The first real portal
 * return settles it; until then the payable figure is labelled unconfirmed.
 */

import { lastDayOfMonth } from "../dates";
import { formatRupees, sumPaisa, type Paisa } from "../money";
import {
  SRB_FIRST_SUPPORTED_DATE,
  SRB_REQUIRED_RULE_IDS,
  findRateOption,
  findSrbRuleNumber,
  getSrbDueDates,
} from "../rules/srb-services";
import type { SalesTaxProblem } from "../types";
import { checkSrbInvoices, lateReturnProblems } from "./checks";
import { makeSrbProblem } from "./problems";
import type {
  SrbLineStatus,
  SrbPurchaseEntry,
  SrbReturnInput,
  SrbReturnLine,
  SrbReturnResult,
  SrbSaleEntry,
} from "./types";

const sign = (docType: string): 1 | -1 => (docType === "CN" ? -1 : 1);

const UNCONFIRMED_NOTE =
  "Provisional: row 13 is worked out on the standard-rate output only. The portal's exact treatment of reduced-rate output is not yet confirmed.";

export function computeSrbReturn(input: SrbReturnInput): SrbReturnResult {
  const { period, figures } = input;
  const asOf = lastDayOfMonth(period);
  const supported = asOf >= SRB_FIRST_SUPPORTED_DATE;
  const base = {
    isEstimate: true as const,
    period,
    payableUnconfirmed: true as const,
  };
  if (!supported) {
    return {
      ...base,
      canEstimate: false,
      problems: [makeSrbProblem("srb_period_unsupported", "return", null)],
      lines: [],
      bySr: {},
      balancePayable: null,
      reducedRateOutput: 0,
      rulesUsed: [],
    };
  }

  const checks = checkSrbInvoices({ period, sales: input.sales, purchases: input.purchases });
  const problems: SalesTaxProblem[] = [...checks.problems];

  // Lines that failed their own checks are left out of the figures; the
  // problem list already stops the estimate.
  const sales = input.sales.filter((entry) => !checks.invalidSales.includes(entry.id));
  const purchases = input.purchases.filter((entry) => !checks.invalidPurchases.includes(entry.id));

  const outputOf = (rows: SrbSaleEntry[], row: "9a" | "9b") => {
    const picked = rows.filter((entry) => findRateOption(entry.rateId, asOf)?.row === row);
    return {
      value: sumPaisa(picked.map((entry) => sign(entry.docType) * entry.valueExclTax)),
      tax: sumPaisa(picked.map((entry) => sign(entry.docType) * entry.salesTax)),
    };
  };
  const out9a = outputOf(sales, "9a");
  const out9b = outputOf(sales, "9b");

  const signedPurchase = (rows: SrbPurchaseEntry[], pick: (entry: SrbPurchaseEntry) => Paisa) =>
    sumPaisa(rows.map((entry) => sign(entry.docType) * pick(entry)));

  const r1 = signedPurchase(purchases, (entry) => entry.salesTax);
  const r1Value = signedPurchase(purchases, (entry) => entry.valueExclTax);
  const r2 = 0;
  const r3 = figures.annexECredit3;
  const annexANonCreditable = signedPurchase(purchases, (entry) => entry.nonCreditable);
  const r4 = annexANonCreditable + figures.otherNonCreditable4;
  const r5 = r1 + r2 + r3 - r4;
  const r6 = figures.creditBroughtForward6;
  const r7 = sumPaisa(sales.map((entry) => sign(entry.docType) * entry.stWithheld));
  const r7a = figures.disallowed7a;
  const r7b = figures.allowed7b;
  const r8 = r5 + r6 + r7 - r7a + r7b;
  const r10 = sumPaisa(figures.exports.map((entry) => entry.amountPkr));
  const r11 = out9a.tax + out9b.tax;
  // Row 12 = 3 + 6 + (admissible input of 1 and 2) - 4 - 7a + 7b.
  const r12 = r3 + r6 + (r1 + r2) - r4 - r7a + r7b;
  // Row 13, worked on the standard-rate output (see the note at the top).
  const r13 = out9a.tax - (r7 + r12);
  const r14 = figures.annexEBalance14;
  const r14a = signedPurchase(purchases, (entry) => entry.stWithheldAsAgent);
  const r14b = 0;
  const r15 = (r13 > 0 ? r13 : 0) + r14a + r14b + out9b.tax;
  const r17 = r13 < 0 ? -r13 : 0;
  const r18 = period.month === 6 && r17 > 0 ? r17 : 0;
  const r19 = period.month === 6 ? 0 : r17;
  const r20 = figures.additionalTax21 + figures.arrears22 + figures.penalty23;
  const r24 = r15 + r20;
  const r25 = figures.amended ? figures.taxPaidPrevious25 : 0;
  const r26 = r24 - r25;

  const line = (
    sr: string,
    description: string,
    amount: Paisa | null,
    status: SrbLineStatus,
    note: string | null = null,
    value: Paisa | null = null,
  ): SrbReturnLine => ({ sr, description, amount, status, note, value });

  const lines: SrbReturnLine[] = [
    line("1", "Domestic purchases (Annex-A): sales tax on the invoices", r1, "computed",
      annexANonCreditable !== 0 ? `Includes ${formatRupees(annexANonCreditable)} that the purchase lines mark non-creditable (shown again in row 4).` : null, r1Value),
    line("2", "Imports (Annex-B)", r2, "fixed_zero", "Imports through customs (Annex-B) are not supported here. If you have any, enter that tax on the portal."),
    line("3", "Capital goods and fixed assets (Annex-E), credit this month", r3, "input"),
    line("4", "Non-creditable input tax", r4, "computed",
      figures.otherNonCreditable4 ? "Purchase lines marked non-creditable plus the amount you entered." : "From the purchase lines marked non-creditable."),
    line("5", "Input tax for the month = (1 + 2 + 3) - 4", r5, "computed"),
    line("6", "Credit brought forward from the previous period", r6, "input"),
    line("7", "Sales tax withheld by the buyer as withholding agent", r7, "computed", "Total of the withheld column of the sales lines (Annex-C)."),
    line("7a", "Disallowed credit and output tax reduction", r7a, "input"),
    line("7b", "Allowed credit and output tax reduction", r7b, "input"),
    line("8", "Accumulated credit = 5 + 6 + 7 - 7a + 7b", r8, "computed"),
    line("9a", "Services at the standard rate (Annex-C)", out9a.tax, "computed",
      "Standard rate and Part I (19.5%) services.", out9a.value),
    line("9b", "Services at a reduced rate (Annex-C)", out9b.tax, "computed",
      "Part II services, including the specific rates. No input tax credit applies.", out9b.value),
    line("10", "Services exported (Annex-D)", null, "computed", "Exports carry no tax; only the value is reported.", r10),
    line("11", "Output tax for the month = 9a + 9b", r11, "computed", "As printed on the form."),
    line("12", "Input for the month (admissible) = 3 + 6 + (1 + 2) - 4 - 7a + 7b", r12, "computed"),
    line("13", "Available balance = output - (7 + 12)", r13, "provisional", UNCONFIRMED_NOTE),
    line("14", "Capital goods input tax still available (Annex-E)", r14, "input"),
    line("14a", "Sales tax withheld by you as withholding agent", r14a, "computed", "Total of the withheld column of the purchase lines (Annex-A)."),
    line("14b", "Collected as collection agent (Annex-C1)", r14b, "fixed_zero", "Collection agents are not supported here."),
    line("15", "Sales tax payable", r15, "provisional",
      out9b.tax !== 0 ? `${UNCONFIRMED_NOTE} Reduced-rate output tax (row 9b) is added once, in cash.` : UNCONFIRMED_NOTE),
    line("17", "Credit to be carried forward", r17, "provisional", UNCONFIRMED_NOTE),
    line("18", "End-of-year refund claim (June only)", r18, "provisional", period.month === 6 ? UNCONFIRMED_NOTE : "Only the June return can claim a refund."),
    line("19", "Net credit carried forward", r19, "provisional", period.month === 6 ? "June: nothing is carried forward." : UNCONFIRMED_NOTE),
    line("20", "Fine, penalty, additional tax and default surcharge = 21 + 22 + 23", r20, "computed"),
    line("21", "Additional tax, default surcharge and others", figures.additionalTax21, "input"),
    line("22", "Arrears", figures.arrears22, "input"),
    line("23", "Penalty or fine", figures.penalty23, "input"),
    line("24", "Total amount to be paid = 15 + 20", r24, "provisional", UNCONFIRMED_NOTE),
    line("25", "Tax paid on the normal or previous return", r25, "input", figures.amended ? null : "Only for an amended return."),
    line("26", "Balance tax payable or (refundable) = 24 - 25", r26, "provisional", UNCONFIRMED_NOTE),
    line("27", "Bank account for a refund", null, "fixed_zero", "Chosen on the portal."),
  ];

  if (sales.length === 0 && purchases.length === 0 && figures.exports.length === 0) {
    problems.push(makeSrbProblem("srb_no_invoices", "return", null));
  }
  if (out9b.tax > 0 && figures.otherNonCreditable4 === 0 && purchases.length > 0) {
    problems.push(makeSrbProblem("srb_reduced_rate_inputs", "return", null));
  }
  const evidencePercent = findSrbRuleNumber("srb.input.evidence_threshold_percent", asOf);
  if (evidencePercent !== null && r11 > 0 && r1 - r4 > 0 && (r1 - r4) * 100 > r11 * evidencePercent) {
    problems.push(makeSrbProblem("srb_evidence_needed", "return", null));
  }
  if (out9a.tax < 0) problems.push(makeSrbProblem("srb_output_negative", "return", null, { row: "9a" }));
  if (out9b.tax < 0) problems.push(makeSrbProblem("srb_output_negative", "return", null, { row: "9b" }));
  if (r17 > 0) {
    problems.push(makeSrbProblem("srb_credit_forward", "return", null, { june: period.month === 6 ? 1 : 0 }));
  }
  problems.push(...lateReturnProblems(period, input.today));

  const canEstimate = !problems.some((p) => p.severity === "refuse" || p.severity === "error");
  const bySr: Record<string, SrbReturnLine> = {};
  for (const item of lines) bySr[item.sr] = item;

  const usedRates = new Set<string>();
  for (const entry of sales) usedRates.add(`srb.rate:${entry.rateId}`);
  const due = getSrbDueDates(period);
  return {
    ...base,
    canEstimate,
    problems,
    lines: canEstimate ? lines : [],
    bySr: canEstimate ? bySr : {},
    balancePayable: canEstimate ? r26 : null,
    reducedRateOutput: out9b.tax,
    rulesUsed: [
      ...SRB_REQUIRED_RULE_IDS,
      ...(due ? [`srb.due:${due.annexC}/${due.payment}/${due.returnFiling}`] : []),
      ...Array.from(usedRates).sort(),
    ],
  };
}
