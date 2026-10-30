/**
 * Due dates for the Sindh services return (SST-03).
 *
 * Annex-C by the 10th, payment by the 15th and the return by the 18th of the
 * month after the tax period. SRB can move these dates by notification, so
 * every move is a dated override carrying its notification number. Weekend
 * and holiday shifts are applied only when an override says so.
 */

import { formatIso, isValidIso, lastDayOfMonth, nextMonth } from "../../dates";
import type { IsoDate, TaxPeriod } from "../../types";
import { findSrbRuleNumber } from "./catalog";

export type SrbDueDateTarget = "annex_c" | "payment" | "return";

export interface SrbDueDateOverride {
  period: TaxPeriod;
  target: SrbDueDateTarget;
  date: IsoDate;
  /** The notification that moved the date. */
  reference: string;
}

/**
 * Notified extensions. Empty on purpose: none has been checked against an SRB
 * notification for a supported period.
 */
export const SRB_DUE_DATE_OVERRIDES: SrbDueDateOverride[] = [];

export interface SrbDueDates {
  annexC: IsoDate;
  payment: IsoDate;
  returnFiling: IsoDate;
  overridesApplied: SrbDueDateOverride[];
}

export function getSrbDueDates(
  period: TaxPeriod,
  overrides: SrbDueDateOverride[] = SRB_DUE_DATE_OVERRIDES,
): SrbDueDates | null {
  const asOf = lastDayOfMonth(period);
  const annexCDay = findSrbRuleNumber("srb.due.annex_c_day", asOf);
  const paymentDay = findSrbRuleNumber("srb.due.payment_day", asOf);
  const returnDay = findSrbRuleNumber("srb.due.return_day", asOf);
  if (annexCDay === null || paymentDay === null || returnDay === null) return null;
  const following = nextMonth(period);
  const result: SrbDueDates = {
    annexC: formatIso(following.year, following.month, annexCDay),
    payment: formatIso(following.year, following.month, paymentDay),
    returnFiling: formatIso(following.year, following.month, returnDay),
    overridesApplied: [],
  };
  for (const override of overrides) {
    if (override.period.year !== period.year || override.period.month !== period.month) continue;
    if (!isValidIso(override.date) || !override.reference) continue;
    if (override.target === "annex_c") result.annexC = override.date;
    if (override.target === "payment") result.payment = override.date;
    if (override.target === "return") result.returnFiling = override.date;
    result.overridesApplied.push(override);
  }
  return result;
}
