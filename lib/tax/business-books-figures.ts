/**
 * Business profit figures from the Business Books (16-Oct, user: "document se
 * fill in the books").
 *
 * The 8 yearly totals of the Business profit step (Sales for the year ...
 * Tax already deducted on business receipts) are printed in the Business
 * Books, which every business filing uploads and maps. They are no longer
 * typed on the Business profit step:
 *   - Save & Approve Map on the Books copies them into the Business Profit
 *     selection (app/actions/extraction.ts);
 *   - every wizard save puts the mapped Books' figures back in place of
 *     whatever the browser sent (app/actions/filing.ts), so an old or stale
 *     typed figure can never replace them;
 *   - the Business profit step shows them read-only.
 * The Books' business name is only offered on the Business details entry
 * (filled in when the taxpayer starts that entry with the name empty); it is
 * never written here, because a half-filled Business details entry would stop
 * the packet, and the IRIS name may differ from the books.
 *
 * Pure functions only; the database read lives in
 * lib/tax/business-books-load.ts.
 */
import {
  BUSINESS_BOOKS_ANNUAL_LABELS,
  BUSINESS_BOOKS_FIGURE_KEYS,
  type BusinessBooksAnnualKey,
} from "./business-books-annual-labels";
import { IRIS_BUSINESS_LIMITS } from "./business-identity";
import {
  TY2026_BUSINESS_PROFIT_SUBCATEGORY,
  type Ty2026IncomeSelectionInput,
  type Ty2026SelectionUserDetails,
} from "./rules/ty2026/subcategories";

export {
  BUSINESS_BOOKS_ANNUAL_LABELS,
  BUSINESS_BOOKS_FIGURE_KEYS,
};
export type { BusinessBooksAnnualKey };

export type BusinessBooksValues = Readonly<{
  figures: Readonly<Record<BusinessBooksAnnualKey, number | null>>;
  businessName: string | null;
}>;

/** Plain words for the Business profit step (ASCII only). */
export const BUSINESS_BOOKS_TEXT = Object.freeze({
  fromBooks:
    "These figures come from your Business Books. To change one, fix it on the Books review (Upload documents step) and press Save & Approve Map again.",
  waitingForBooks:
    "These figures come from your Business Books. Upload the Books on the Upload documents step, check the figures there and press Save & Approve Map; they then show here.",
  estimateAfterBooks:
    "The estimate of your business profit shows here after your Business Books are mapped.",
});

/**
 * Business Profit details with the Books' 8 figures in place of the saved
 * ones (a blank Books figure removes the saved one). Nothing else changes.
 */
export function withBusinessBooksValues(
  details: Ty2026SelectionUserDetails | undefined | null,
  books: BusinessBooksValues,
): Ty2026SelectionUserDetails {
  const next: Ty2026SelectionUserDetails = { ...(details ?? {}) };
  for (const key of BUSINESS_BOOKS_FIGURE_KEYS) {
    const value = books.figures[key];
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

/** The Books' business name when IRIS can take it, to offer on Business details. */
export function businessBooksNameForIris(books: BusinessBooksValues | null): string {
  const name = (books?.businessName ?? "").trim();
  return name && name.length <= IRIS_BUSINESS_LIMITS.businessName ? name : "";
}

/**
 * The selections with the Business Profit selection's figures taken from the
 * Books. Only an existing Business Profit selection is changed (it is created
 * on the Business profit step); nothing is added.
 */
export function applyBusinessBooksValues(
  selections: readonly Ty2026IncomeSelectionInput[],
  books: BusinessBooksValues,
): Ty2026IncomeSelectionInput[] {
  return selections.map((selection) =>
    selection.source === "business" &&
    selection.subcategory === TY2026_BUSINESS_PROFIT_SUBCATEGORY
      ? { ...selection, details: withBusinessBooksValues(selection.details, books) }
      : selection,
  );
}

/** True when the saved details already hold exactly the Books' 8 figures. */
export function businessDetailsMatchBooks(
  details: Ty2026SelectionUserDetails | undefined | null,
  books: BusinessBooksValues,
): boolean {
  return BUSINESS_BOOKS_FIGURE_KEYS.every((key) => {
    const saved = details?.[key];
    const value = books.figures[key];
    if (value === null || value === undefined) return saved === undefined || saved === null;
    return typeof saved === "number" && Math.abs(saved - value) <= 0.01;
  });
}
