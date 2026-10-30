/**
 * Dated rule rows for the Sindh Sales Tax on Services (SRB).
 *
 * Each row carries its legal section, the source it was read from, the dates
 * it applies and the day it was last compared with that source. The engine
 * reads rows by date, so a change of law is a new row, not an engine edit.
 * Blogs and news sites never supply a number here.
 */

import { findRule, findRuleNumber, type SalesTaxRule } from "../fbr-goods/catalog";
import { SRB_FIRST_SUPPORTED_DATE } from "./rates";

const ACT = "Sindh Sales Tax on Services Act 2011, consolidated text for 2026-27 (SRB, 20 Aug 2026)";
const RULES = "Sindh Sales Tax on Services Rules 2011, consolidated text for 2026-27 (SRB, 20 Aug 2026)";
const CHECKED = "2026-10-12";
const FROM = SRB_FIRST_SUPPORTED_DATE;

export const SRB_SERVICES_RULES: SalesTaxRule[] = [
  {
    id: "srb.due.annex_c_day",
    title: "Annex-C (sales annexure) due day of the following month",
    section: "Rule 13A",
    source: `${RULES}, rule 13A: Annex-C by the 10th day of the month`,
    effectiveFrom: FROM, effectiveTo: null, verifiedOn: CHECKED,
    unit: "day_of_month", value: 10,
  },
  {
    id: "srb.due.payment_day",
    title: "Payment of tax due day of the following month",
    section: "Act s.2(36) and Rule 14",
    source: `${RULES}, rule 14: due date for payment is the 15th day of the month following the tax period`,
    effectiveFrom: FROM, effectiveTo: null, verifiedOn: CHECKED,
    unit: "day_of_month", value: 15,
  },
  {
    id: "srb.due.return_day",
    title: "E-filing of the return, day of the following month",
    section: "Rule 14 and its history note",
    source: `${RULES}, rule 14: return within three days of the payment due date (the 18th). The e.SRB portal banner has been seen showing the 20th; that is not confirmed.`,
    effectiveFrom: FROM, effectiveTo: null, verifiedOn: CHECKED,
    unit: "day_of_month", value: 18,
    notes: "SRB can move dates under section 81; add such a move as an override in due-dates.ts with its notification number.",
  },
  {
    id: "srb.penalty.late_return.per_day",
    title: "Penalty for each day of default in filing the return",
    section: "Act s.43 Table, S.No 2",
    source: `${ACT}: Rs 100 for each day of default beyond the due date (substituted by the Sindh Finance Act 2025)`,
    effectiveFrom: FROM, effectiveTo: null, verifiedOn: CHECKED,
    unit: "rupees", value: 100,
  },
  {
    id: "srb.default_surcharge.margin",
    title: "Default surcharge, margin added to the Inter-Bank Rate",
    section: "Act s.44(1)(a)",
    source: `${ACT}: Inter-Bank Rate plus three per cent per annum of the tax due`,
    effectiveFrom: FROM, effectiveTo: null, verifiedOn: CHECKED,
    unit: "percent", value: 3,
  },
  {
    id: "srb.input.evidence_threshold_percent",
    title: "Input tax above this share of output tax needs scanned invoices",
    section: "Rule 16",
    source: `${RULES}, rule 16: input tax exceeding 20% of output tax`,
    effectiveFrom: FROM, effectiveTo: null, verifiedOn: CHECKED,
    unit: "percent", value: 20,
  },
  {
    id: "srb.input.carry_periods",
    title: "Tax periods an input tax claim may be carried into",
    section: "Rule 22(1)",
    source: `${RULES}, rule 22: six succeeding tax periods`,
    effectiveFrom: FROM, effectiveTo: null, verifiedOn: CHECKED,
    unit: "days", value: 6,
    notes: "Counted in tax periods (months), not days.",
  },
  {
    id: "srb.filing.late_months_without_approval",
    title: "Months after the due date within which a late return can still be e-filed without the Commissioner's approval",
    section: "Rule 12(2)",
    source: `${RULES}, rule 12(2), as amended by SRB-3-4/27/2026 (six months from 1 July 2026)`,
    effectiveFrom: "2026-07-01", effectiveTo: null, verifiedOn: CHECKED,
    unit: "days", value: 6,
    notes: "Counted in months. Four months applied before 1 July 2026 (see the next row).",
  },
  {
    id: "srb.filing.late_months_without_approval",
    title: "Months after the due date within which a late return can still be e-filed without the Commissioner's approval (before 1 July 2026)",
    section: "Rule 12(2)",
    source: `Sindh Sales Tax on Services Rules 2011, rule 12(2) before SRB-3-4/27/2026: four months`,
    effectiveFrom: FROM, effectiveTo: "2026-06-30", verifiedOn: CHECKED,
    unit: "days", value: 4,
    notes: "Counted in months.",
  },
];

/** Rule ids the engine reads. The validation test checks each exists for every supported period. */
export const SRB_REQUIRED_RULE_IDS = [
  "srb.due.annex_c_day",
  "srb.due.payment_day",
  "srb.due.return_day",
  "srb.penalty.late_return.per_day",
  "srb.default_surcharge.margin",
  "srb.input.evidence_threshold_percent",
  "srb.input.carry_periods",
  "srb.filing.late_months_without_approval",
];

export function findSrbRule(id: string, asOf: string): SalesTaxRule | null {
  return findRule(id, asOf, SRB_SERVICES_RULES);
}

export function findSrbRuleNumber(id: string, asOf: string): number | null {
  return findRuleNumber(id, asOf, SRB_SERVICES_RULES);
}
