/**
 * Previous-return wealth continuity (Phase 4b) — INFORMATIONAL ONLY.
 *
 * Compares the approved previous return's printed Wealth Statement rows
 * (aggregates per IRIS code, details folded in) against the wealth codes this
 * filing will declare. The comparison answers one question: if last year's
 * return showed a car, capital or liability and this filing's Wealth Statement
 * does not, the disposal/repayment must show up in the reconciliation — an
 * unexplained change in wealth is the classic FBR notice trigger (§116).
 *
 * TaxRocket only auto-declares bank account(s) (7030) and cash in hand (7012)
 * for the current filing; every other code is typed manually in IRIS, so a
 * "missing" status is guidance for the operator, never a filing blocker and
 * never an error. Nothing here writes anywhere.
 */

import type { PreviousReturnWealthRow } from "./previous-return-fields";

export type WealthContinuityItem = {
  code: string;
  description: string;
  /** Aggregate amount printed in the approved previous return, if any. */
  previousAmount: number | null;
  /** Amount this filing carries under the same code, if any. */
  currentAmount: number | null;
  /**
   * carried  — code exists on both sides (amounts may legitimately differ:
   *            values move year to year; only presence is compared).
   * missing  — previous return declares it, this filing does not.
   * new      — this filing declares it, the previous return does not.
   */
  status: "carried" | "missing" | "new";
};

export type WealthContinuity = {
  previousReturnTaxYear: number;
  items: WealthContinuityItem[];
  /** Codes present on both sides, for the summary line. */
  carriedCodes: string[];
  note: string;
};

/**
 * The wealth rows TaxRocket itself carries for the current filing: bank
 * closing balances as Bank Account(s) 7030 (when any account exists) and the
 * net cash movement as Cash in hand 7012. Business/other assets are entered
 * manually in IRIS and are therefore not part of "current" here.
 */
export function currentFilingWealthRows(input: {
  bankClosingTotal: number | null;
  cashMovement: number;
}): Array<{ code: string; description: string; amount: number }> {
  const rows: Array<{ code: string; description: string; amount: number }> = [];
  if (input.bankClosingTotal !== null)
    rows.push({
      code: "7030",
      description: "Bank Account(s)",
      amount: input.bankClosingTotal,
    });
  rows.push({
    code: "7012",
    description: "Cash in hand",
    amount: input.cashMovement,
  });
  return rows;
}

/**
 * Build the continuity comparison. Returns null when the previous return
 * carries no validated wealth rows (nothing to compare). Detail children are
 * folded into their aggregate; only aggregate rows take part in matching.
 */
export function buildWealthContinuity(
  previousRows: PreviousReturnWealthRow[],
  previousReturnTaxYear: number,
  currentRows: Array<{ code: string; description: string; amount: number }>,
): WealthContinuity | null {
  const previousByCode = new Map<
    string,
    { description: string; amount: number }
  >();
  for (const row of previousRows) {
    if (row.detail) continue;
    const existing = previousByCode.get(row.code);
    previousByCode.set(row.code, {
      description: row.description,
      amount: (existing?.amount ?? 0) + row.amount,
    });
  }
  if (previousByCode.size === 0) return null;

  const currentByCode = new Map<
    string,
    { description: string; amount: number }
  >();
  for (const row of currentRows)
    currentByCode.set(row.code, {
      description: row.description,
      amount: row.amount,
    });

  const items: WealthContinuityItem[] = [];
  const carriedCodes: string[] = [];
  for (const code of new Set([...previousByCode.keys(), ...currentByCode.keys()])) {
    const previous = previousByCode.get(code);
    const current = currentByCode.get(code);
    const status: WealthContinuityItem["status"] =
      previous && current ? "carried" : previous ? "missing" : "new";
    if (status === "carried") carriedCodes.push(code);
    items.push({
      code,
      description: previous?.description ?? current?.description ?? "",
      previousAmount: previous?.amount ?? null,
      currentAmount: current?.amount ?? null,
      status,
    });
  }
  items.sort((a, b) => a.code.localeCompare(b.code));

  const missing = items.filter((item) => item.status === "missing");
  const fresh = items.filter((item) => item.status === "new");
  const noteParts = [
    "TaxRocket declares bank account(s) and cash in hand for this filing automatically; any other asset or liability is entered in IRIS manually.",
  ];
  if (missing.length > 0)
    noteParts.push(
      `Declared in your Tax Year ${previousReturnTaxYear} return but not in this filing's Wealth Statement (${missing
        .map((item) => item.code)
        .join(", ")}): declare these in IRIS again, or make sure the disposal/repayment shows in your reconciliation — an unexplained wealth change is a common FBR notice trigger.`,
    );
  if (fresh.length > 0)
    noteParts.push(
      `New in this filing (${fresh
        .map((item) => item.code)
        .join(", ")}): their source should be traceable to your inflows.`,
    );
  noteParts.push(
    "This is guidance for review only; it never blocks filing and nothing is written to IRIS.",
  );

  return {
    previousReturnTaxYear,
    items,
    carriedCodes: carriedCodes.sort(),
    note: noteParts.join(" "),
  };
}
