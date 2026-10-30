/**
 * 28-Oct-2026: the salary test run reached the FBR window with
 * Unreconciled Amount (703000) = 1,550,000, and only then was it clear why — the
 * bank statement opened with 1,550,000, while the approved previous return
 * declared no bank account row at all (its cash in hand row was 280,554). IRIS
 * carried the previous year's own assets and then added this year's closing
 * balance as a brand-new asset row, so the whole opening balance became an
 * unexplained increase in wealth.
 *
 * Nothing caught that at the upload step, because every check there looks at one
 * document on its own: the statement is internally consistent (opening +
 * credits − debits = closing) no matter how large the opening balance is.
 *
 * This module adds the missing cross-document check, in the same spirit as the
 * business opening-wealth check: compare the opening balance of the year's bank
 * statements with what the approved previous return actually declared. It never
 * blocks and never guesses a figure; it only says how much of the opening
 * balance has no declared row behind it, so the gap is known before the FBR run.
 */

export type DeclaredWealthRow = {
  code: string;
  description: string;
  amount: number;
};

export type BankOpeningDeclaredInput = {
  /** Sum of the filing's bank statement opening balances. */
  openingBalance: number;
  /** The approved previous return's printed Wealth Statement rows. */
  previousReturnRows: DeclaredWealthRow[] | null;
  /** The approved previous return's Cash in hand (7012), when printed. */
  previousReturnCashInHand: number | null;
  /** True when the previous return carries a "Bank Account(s)" asset row. */
  previousReturnHasBankRow?: boolean;
};

export type BankOpeningDeclaredResult = {
  status: "unknown" | "ok" | "warning";
  /** Amount of the opening balance with no declared row behind it. */
  uncovered: number;
  /** What last year's return declares that could already hold this money. */
  declared: number;
  /** Screen-ready sentence; null unless status is "warning". */
  message: string | null;
};

const BANK_ROW = /bank\s*account/i;

export function previousReturnBankRowTotal(
  rows: DeclaredWealthRow[] | null,
): number {
  if (!rows?.length) return 0;
  // IRIS prints the aggregate "Bank Account(s)" row and its detail lines under
  // the same code, so only the aggregate (non-detail) rows are added here.
  return rows
    .filter((row) => BANK_ROW.test(row.description))
    .filter((row) => !/^\s*$/.test(row.description))
    .reduce((sum, row) => sum + (Number.isFinite(row.amount) ? row.amount : 0), 0);
}

export function bankOpeningDeclaredCheck(
  input: BankOpeningDeclaredInput,
): BankOpeningDeclaredResult {
  const opening = Number(input.openingBalance);
  if (!Number.isFinite(opening) || opening <= 0) {
    return { status: "unknown", uncovered: 0, declared: 0, message: null };
  }
  // No approved previous return means there is nothing to compare against; the
  // first-time-filer case must stay silent.
  if (!input.previousReturnRows?.length) {
    return { status: "unknown", uncovered: 0, declared: 0, message: null };
  }

  const cash =
    input.previousReturnCashInHand === null || input.previousReturnCashInHand === undefined
      ? 0
      : Number(input.previousReturnCashInHand);
  const declaredBank = input.previousReturnHasBankRow === false
    ? 0
    : previousReturnBankRowTotal(input.previousReturnRows);
  // Cash in hand is the only other printed row that can hold money sitting in a
  // bank account on the first day of the year.
  const declared = declaredBank + (Number.isFinite(cash) ? Math.max(cash, 0) : 0);

  const uncovered = round2(opening - declared);
  if (uncovered <= 0) {
    return { status: "ok", uncovered: 0, declared: round2(declared), message: null };
  }

  const fmt = (value: number) => Math.round(value).toLocaleString("en-PK");
  return {
    status: "warning",
    uncovered,
    declared: round2(declared),
    message:
      `Your bank statement opens with PKR ${fmt(opening)}, but the approved previous return declares ` +
      `${declared > 0 ? `PKR ${fmt(declared)} (cash in hand${declaredBank > 0 ? " and the bank account row" : ", no bank account row"})` : "no cash in hand and no bank account row"}. ` +
      `PKR ${fmt(uncovered)} of that opening balance has no declared row behind it, so when this year's ` +
      `closing balance is added IRIS will report an unreconciled amount of about that much (it may read ` +
      `this as over-declared assets). Nothing is blocked and no figure is guessed: fix the statement, ` +
      `declare the account in last year's wealth statement, or be ready to explain the difference before the FBR run.`,
  };
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}
