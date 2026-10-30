/**
 * 28-Oct-2026: the Wealth Statement gap was found only at the very end, inside
 * IRIS, after the agent had already filled the return.
 *
 * The operator's pack declared the business opening on 01-Jul-2025 with capital
 * 14,500,000, bank 14,300,000 and stock 200,000, while the filed Tax Year 2025
 * return proved net assets of 8,780,220 and no business capital at all. Nothing
 * in the pack or in the return explained where that 14,500,000 came from, so
 * Net Assets rose by 15,200,000 against inflows minus outflows of 740,000 and
 * IRIS reported Unreconciled Amount (703000) 14,460,000. TaxRocket was right to
 * report it and right not to plug it; the pack was wrong.
 *
 * This check moves that discovery to Business data review, where the documents
 * can still be corrected, and it never invents a figure:
 *
 *   closing business capital  (Balance Sheet, code 3352)
 *     − this year's accounting profit   = implied opening capital (a floor:
 *                                          drawings during the year only raise it)
 *
 * The implied opening capital can only be covered by wealth that a filed return
 * already proves (the approved previous return's net assets) plus anything the
 * taxpayer declares as a fresh inflow. The pack's business module declares no
 * such inflow, so when the implied opening capital is larger than the previous
 * return's net assets, Section 116 cannot reach zero and the filing is stopped
 * before an agent run, instead of after one.
 *
 * Deliberately silent (status "unknown") when either side is missing: a missing
 * previous return or a Balance Sheet without a capital figure is not evidence of
 * a gap.
 */

export type BusinessOpeningWealthInput = {
  /** Owner capital at 30 June of the filing year (Balance Sheet code 3352). */
  closingBusinessCapital: number | null;
  /** Accounting profit of the year from the reviewed yearly figures. */
  accountingProfit: number | null;
  /** Net assets (703001) of the taxpayer's APPROVED previous-year return. */
  previousReturnNetAssets: number | null;
  previousReturnTaxYear?: number | null;
  /** The year being filed, for the message. */
  taxYear: number;
};

export type BusinessOpeningWealthVerdict =
  | { status: "unknown"; reason: string }
  | { status: "ok"; impliedOpeningCapital: number; previousReturnNetAssets: number }
  | {
      status: "impossible";
      impliedOpeningCapital: number;
      previousReturnNetAssets: number;
      excess: number;
      message: string;
    };

const money = (value: number) => Math.round(value).toLocaleString("en-US");

/** Whole rupees, so a stray paisa cannot trip the check. */
const round = (value: number) => Math.round(value);

export function businessOpeningWealthCheck(
  input: BusinessOpeningWealthInput,
): BusinessOpeningWealthVerdict {
  const capital = input.closingBusinessCapital;
  const profit = input.accountingProfit;
  const previous = input.previousReturnNetAssets;

  if (previous === null || previous === undefined)
    return {
      status: "unknown",
      reason:
        "No approved previous-year return, so the opening wealth cannot be compared.",
    };
  if (capital === null || capital === undefined)
    return {
      status: "unknown",
      reason:
        "The Balance Sheet does not state owner capital, so the opening position cannot be checked.",
    };
  if (profit === null || profit === undefined)
    return {
      status: "unknown",
      reason:
        "The yearly figures do not give an accounting profit, so the opening position cannot be checked.",
    };

  const impliedOpeningCapital = round(capital) - round(profit);
  const excess = impliedOpeningCapital - round(previous);
  if (excess <= 0)
    return {
      status: "ok",
      impliedOpeningCapital,
      previousReturnNetAssets: round(previous),
    };

  const previousYear = input.previousReturnTaxYear
    ? `Tax Year ${input.previousReturnTaxYear}`
    : "the previous year";
  return {
    status: "impossible",
    impliedOpeningCapital,
    previousReturnNetAssets: round(previous),
    excess,
    message:
      `The business opening in these documents is not covered by any filed return. The Balance Sheet puts owner capital at ` +
      `PKR ${money(capital)} at 30 June ${input.taxYear}, which means opening capital of at least ` +
      `PKR ${money(impliedOpeningCapital)} on 1 July ${input.taxYear - 1} once this year's profit of PKR ${money(profit)} is ` +
      `taken out (any drawings would make that opening figure higher still). The approved ${previousYear} return ` +
      `proves net assets of only PKR ${money(previous)}, so at least PKR ${money(excess)} exists in the documents but in no ` +
      `filed record. ` +
      `The Wealth Statement (section 116) cannot then reach an unreconciled amount of 0. Correct the source documents so the ` +
      `business opens with the capital the filed return proves, or declare on the Wealth Statement where that capital came from. ` +
      `No value was guessed.`,
  };
}

/**
 * Accounting profit from the reviewed yearly figures. Book depreciation is a
 * real expense for the capital account even though it is added back for tax.
 */
export function businessAccountingProfit(figures: {
  businessGrossSales?: number | null;
  businessOtherRevenue?: number | null;
  businessCostOfSales?: number | null;
  businessOperatingExpenses?: number | null;
  businessDepreciation?: number | null;
}): number | null {
  const values = [
    figures.businessGrossSales,
    figures.businessOtherRevenue,
    figures.businessCostOfSales,
    figures.businessOperatingExpenses,
    figures.businessDepreciation,
  ];
  if (values.some((value) => value === null || value === undefined)) return null;
  return (
    Number(figures.businessGrossSales) +
    Number(figures.businessOtherRevenue) -
    Number(figures.businessCostOfSales) -
    Number(figures.businessOperatingExpenses) -
    Number(figures.businessDepreciation)
  );
}
