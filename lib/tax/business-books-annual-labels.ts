/**
 * The 8 yearly totals of the Business profit step (Myself filing), by their
 * Business Books label. Since 16-Oct they come from the reviewed, mapped
 * Business Books (lib/tax/business-books-figures.ts); the packet check in
 * lib/tax/business-schedule-fields.ts still compares them with the saved
 * Business Profit as a safety net.
 *
 * This module deliberately imports NOTHING: the review screen and the wizard
 * read these names while their own module bodies run, and reading them
 * through a module that could be mid-evaluation gives
 * "Cannot convert undefined or null to object" (seen in Next.js dev, 16-Oct).
 * A cycle cannot run through a module with no imports.
 */
export const BUSINESS_BOOKS_ANNUAL_LABELS = {
  businessGrossSales: "Sales for the year",
  businessOtherRevenue: "Other business receipts",
  businessCostOfSales: "Cost of sales",
  businessOperatingExpenses: "Business expenses",
  businessDepreciation: "Depreciation",
  businessInadmissibleExpenses: "Expenses that are not allowed",
  businessLossBroughtForward: "Business loss brought forward",
  businessWithholdingDeducted: "Tax already deducted on business receipts",
} as const;

export type BusinessBooksAnnualKey = keyof typeof BUSINESS_BOOKS_ANNUAL_LABELS;

/** The 8 keys, in the order the Business profit step shows them. */
export const BUSINESS_BOOKS_FIGURE_KEYS: readonly BusinessBooksAnnualKey[] = [
  "businessGrossSales",
  "businessOtherRevenue",
  "businessCostOfSales",
  "businessOperatingExpenses",
  "businessDepreciation",
  "businessInadmissibleExpenses",
  "businessLossBroughtForward",
  "businessWithholdingDeducted",
];

/**
 * The 7 labels after Sales: Sales has its own "positive amount" requirement,
 * these 7 accept 0 (a blank stops Save & Approve Map).
 */
export const BUSINESS_BOOKS_FIGURE_LABELS_AFTER_SALES: readonly string[] =
  BUSINESS_BOOKS_FIGURE_KEYS.filter(
    (key) => key !== "businessGrossSales",
  ).map((key) => BUSINESS_BOOKS_ANNUAL_LABELS[key]);

/** Every yearly figure blank: the state before the Books are mapped. */
export function emptyBusinessBooksFigures(): Record<
  BusinessBooksAnnualKey,
  null
> {
  const out = {} as Record<BusinessBooksAnnualKey, null>;
  for (const key of BUSINESS_BOOKS_FIGURE_KEYS) out[key] = null;
  return out;
}

/**
 * Review-screen prefill for the seven yearly figures after Sales.
 *
 * A blank box reads as "not known" and stops Save & Approve Map, yet most small
 * businesses genuinely have nil other receipts / depreciation / add-backs /
 * brought-forward loss / withholding. The reviewer used to type five zeros by
 * hand on every filing (reported 27 Oct 2026). This proposes 0 for those blanks
 * so the reviewer confirms instead of retyping, exactly as the nil 7029 on a
 * previous return is proposed.
 *
 * Deliberately conservative:
 *  - only the seven figures AFTER Sales are filled; Sales must be a real
 *    positive amount and is never invented;
 *  - a figure that is already stated is never overwritten;
 *  - a filled figure carries confidence 0.9 and `derived: true`, so it is
 *    visibly a proposal rather than something read off the document;
 *  - the stored payload is what the reviewer sees (display == save), and the
 *    value stays editable.
 *
 * Extraction itself keeps its rule of never supplying an absent zero: this runs
 * on the review payload, not inside lib/tax/business-books-extraction.ts.
 */
export function withDerivedNilBusinessBooksFigures<
  T extends { label?: unknown; value?: unknown; confidence?: unknown; derived?: unknown },
>(fields: T[] | undefined): T[] {
  const list = Array.isArray(fields) ? fields : [];
  const norm = (value: unknown) =>
    String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const targetLabels = new Map(
    BUSINESS_BOOKS_FIGURE_LABELS_AFTER_SALES.map((label) => [norm(label), label]),
  );
  if (!list.some((field) => targetLabels.has(norm(field.label)))) return list;

  const stated = new Set<string>();
  for (const field of list) {
    const key = norm(field.label);
    if (!targetLabels.has(key)) continue;
    const blank =
      field.value === null ||
      field.value === undefined ||
      String(field.value).trim() === "";
    if (!blank) stated.add(key);
  }

  const out = list.map((field) => {
    const key = norm(field.label);
    if (!targetLabels.has(key) || stated.has(key)) return field;
    return { ...field, value: 0, confidence: 0.9, derived: true } as T;
  });
  // A figure the extraction omitted entirely still gets a box to confirm.
  for (const [key, label] of targetLabels) {
    if (stated.has(key)) continue;
    if (out.some((field) => norm(field.label) === key)) continue;
    out.push({ label, value: 0, confidence: 0.9, derived: true } as T);
  }
  return out;
}
