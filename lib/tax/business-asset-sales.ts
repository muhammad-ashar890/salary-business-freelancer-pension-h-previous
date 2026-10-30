/**
 * DP-4 item 2 (16-Oct-2026): business assets sold during the year.
 *
 * Law (ITO 2001 as amended to 31.07.2025, research/ito-2025.txt):
 * - s.22(8): in the year of disposal no depreciation; (a) sale price above
 *   the tax written-down value (WDV) is business income, (b) below it is a
 *   deduction. TaxRocket works this out per Depreciation row from the asset
 *   list (lib/tax/tax-depreciation.ts).
 * - s.22(10) / s.22(13)(a): a vehicle not plying for hire that cost more than
 *   Rs 7.5 million counts its sale price x 7,500,000 / its cost.
 * - s.22(13)(d): for immovable property a sale price above the cost counts as
 *   the cost; s.22(13)(b): never the land.
 *   Both are per-asset rules; the asset list takes one total per IRIS row, so
 *   the taxpayer applies them per asset (row hints), as for additions.
 *
 * IRIS (captures 03 / 05 / 32): the tax gain is typed in 3226 "Add Backs Tax
 * Gain on Sale of Assets", the tax loss in 3256 "Tax (Loss) on Sale of
 * Assets" (Inadmissible/Admissible Deductions). The accounting profit on the
 * sale sits in Other Revenues 3116 "Accounting Gain on Sale of Assets" and IRIS takes it
 * out again itself (3246 "Accounting Gain on Sale of Assets", computed); an
 * accounting loss sits in Admin 3196 "Accounting (Loss) on Sale of Assets"
 * ("+ Add Other Expenses") and IRIS adds it back itself (3236, computed).
 *
 * So the taxpayer says how much accounting profit / loss on these sales is
 * already inside "Other business receipts" / "Business expenses"; the
 * estimate takes it out and uses the tax gain / loss instead.
 */
import type { DepreciationScheduleRow } from "./business-depreciation-schedule";

export const ASSET_SALE_BOOK_GAIN_KEY = "businessAssetSaleBookGain";
export const ASSET_SALE_BOOK_LOSS_KEY = "businessAssetSaleBookLoss";

/** IRIS rows (capture 32 / 03 / 05). */
export const TAX_GAIN_ON_ASSETS_ROW = "3226";
export const TAX_LOSS_ON_ASSETS_ROW = "3256";
export const BOOK_GAIN_ON_ASSETS_ROW = "3116";
export const BOOK_LOSS_ON_ASSETS_ROW = "3196";

export const ASSET_SALE_TEXT = Object.freeze({
  question:
    "Your accounts may already show a profit or loss on selling these assets. Enter it here (0 if none) so it is not counted twice. TaxRocket uses the tax gain or loss instead (sale price minus tax WDV), and the desktop agent types that in FBR.",
  gainLabel: "Profit on these sales already in \"Other business receipts\" (Rs)",
  lossLabel: "Loss on these sales already in \"Business expenses\" (Rs)",
  missing:
    "You sold business assets: answer how much profit or loss on these sales is already inside your other business receipts and business expenses (0 if none). Until then the agent does not type the tax gain (3226) / loss (3256).",
});

/** True when the asset list has a sale (a Deletion on any row). */
export function scheduleHasSale(rows: readonly DepreciationScheduleRow[] | null | undefined): boolean {
  return (rows ?? []).some((row) => (row.deletion ?? 0) > 0);
}

const answer = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

/** The two answers as stored (null = not answered). */
export function readAssetSaleAnswers(details: Record<string, unknown> | null | undefined): {
  bookGain: number | null;
  bookLoss: number | null;
} {
  return {
    bookGain: answer(details?.[ASSET_SALE_BOOK_GAIN_KEY]),
    bookLoss: answer(details?.[ASSET_SALE_BOOK_LOSS_KEY]),
  };
}

const money = (value: number) => Math.round(value).toLocaleString("en-PK");

/**
 * Plain-language problems with answers that were given: they cannot be more
 * than the figure they are part of. Missing answers are not a problem here
 * (the packet keeps the gain / loss manual and says why).
 */
export function validateAssetSaleAnswers(
  answers: { bookGain: number | null; bookLoss: number | null },
  totals: { otherRevenue: number | null; operatingExpenses: number | null },
): string[] {
  const problems: string[] = [];
  if (answers.bookGain !== null && answers.bookGain > (totals.otherRevenue ?? 0))
    problems.push(
      `The profit on assets sold (Rs ${money(answers.bookGain)}) is more than "Other business receipts" (Rs ${money(totals.otherRevenue ?? 0)}). It must be part of that figure.`,
    );
  if (answers.bookLoss !== null && answers.bookLoss > (totals.operatingExpenses ?? 0))
    problems.push(
      `The loss on assets sold (Rs ${money(answers.bookLoss)}) is more than "Business expenses" (Rs ${money(totals.operatingExpenses ?? 0)}). It must be part of that figure.`,
    );
  return problems;
}
