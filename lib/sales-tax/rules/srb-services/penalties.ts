/**
 * Late return penalty (s.43) and default surcharge (s.44) for the Sindh
 * services return. The amounts are estimates for the user to see the cost of
 * filing late; the Board decides the real figure.
 */

import { daysBetween } from "../../dates";
import { type Paisa } from "../../money";
import type { IsoDate } from "../../types";
import { findSrbRuleNumber } from "./catalog";

export type SrbLatePenaltyResult =
  | { status: "on_time"; daysLate: 0; penalty: 0 }
  | { status: "late"; daysLate: number; penalty: Paisa }
  | { status: "rule_not_loaded" };

/** Rs 100 for each day of default beyond the due date. */
export function srbLateReturnPenalty(dueDate: IsoDate, filedDate: IsoDate): SrbLatePenaltyResult {
  const perDay = findSrbRuleNumber("srb.penalty.late_return.per_day", dueDate);
  if (perDay === null) return { status: "rule_not_loaded" };
  const daysLate = daysBetween(dueDate, filedDate);
  if (daysLate <= 0) return { status: "on_time", daysLate: 0, penalty: 0 };
  return { status: "late", daysLate, penalty: perDay * daysLate * 100 };
}

export interface SrbDefaultSurchargeInput {
  taxDue: Paisa;
  /** Days from the day after the due date to the day before payment. */
  daysLate: number;
  /** The Inter-Bank Rate in percent per annum, entered by the user. */
  interBankPercent: number;
  dueDate: IsoDate;
}

/** Default surcharge: Inter-Bank Rate plus 3% a year on the unpaid tax. A 365-day year is assumed. */
export function srbDefaultSurcharge(input: SrbDefaultSurchargeInput): Paisa | null {
  const margin = findSrbRuleNumber("srb.default_surcharge.margin", input.dueDate);
  if (margin === null) return null;
  if (
    !Number.isFinite(input.interBankPercent) ||
    input.interBankPercent < 0 ||
    input.taxDue <= 0 ||
    input.daysLate <= 0
  ) {
    return 0;
  }
  const annualPercent = input.interBankPercent + margin;
  return Math.round((input.taxDue * annualPercent * input.daysLate) / (100 * 365));
}
