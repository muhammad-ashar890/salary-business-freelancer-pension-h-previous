import { withBusinessBooksValues } from "./business-books-figures";
import { readBusinessBooksAnnual } from "./business-schedule-fields";
import {
  buildTaxDeductionsPlan,
  compareWithWithholdingTotal,
  sanitizeBusinessTaxDeductions,
  validateBusinessTaxDeductions,
  type TaxDeductionRegime,
} from "./business-tax-deductions";
import { parsePersistedSelectionUserDetails } from "./rules/ty2026/subcategories";

export type BusinessWithholdingSummaryEntry = {
  regime: TaxDeductionRegime;
  code: string;
  label: string;
  taxableAmount: number;
  taxDeducted: number;
  attributableIncome: number | null;
};

export type BusinessWithholdingSummary = {
  /** True when exactly one mapped Business Books record supplies the annual business totals. */
  booksMapped: boolean;
  /** Authoritative "Tax already deducted on business receipts" total (PKR), or null if unset. */
  totalDeducted: number | null;
  /** Validated DP-3 Business > Tax Deduction total queued for the desktop agent (adjustable + minimum). */
  queuedTotal: number;
  /** Validated Adjustable Tax (IRIS 999913) total queued for Business > Tax Deduction. */
  queuedAdjustable: number;
  /** Validated Minimum Tax (IRIS 999914) total queued for Business > Tax Deduction. */
  queuedMinimum: number;
  /** Un-itemized / unsupported remainder (totalDeducted - queuedTotal) left for manual FBR entry if not listed. */
  manualRemainder: number;
  /** Validated per-section rows queued for IRIS Business > Tax Deduction in portal order. */
  entries: BusinessWithholdingSummaryEntry[];
  /** Validation issues on the saved section list or total comparison that block queuing until fixed. */
  problems: string[];
};

export function summarizeBusinessWithholding(input: {
  taxYear: number;
  filerType: string | null;
  incomeSources: readonly string[];
  selectionDetailsJson: string | null;
  mappedBooksExtractedDataList: readonly (string | null)[];
}): BusinessWithholdingSummary | null {
  if (
    input.taxYear !== 2026 ||
    input.filerType !== "myself" ||
    !input.incomeSources.includes("business")
  ) {
    return null;
  }

  const savedDetails =
    parsePersistedSelectionUserDetails(input.selectionDetailsJson) ?? {};

  let booksMapped = false;
  let effectiveDetails = savedDetails;
  if (input.mappedBooksExtractedDataList.length === 1) {
    try {
      const booksValues = readBusinessBooksAnnual(
        input.mappedBooksExtractedDataList[0],
      );
      booksMapped = true;
      effectiveDetails = withBusinessBooksValues(savedDetails, booksValues);
    } catch {
      booksMapped = false;
    }
  }

  const rawTotal = effectiveDetails.businessWithholdingDeducted;
  const totalDeducted =
    typeof rawTotal === "number" && Number.isFinite(rawTotal) && rawTotal >= 0
      ? Math.round(rawTotal)
      : null;
  const fallbackRemainder =
    totalDeducted !== null && totalDeducted > 0 ? totalDeducted : 0;

  const sanitized = sanitizeBusinessTaxDeductions(
    (effectiveDetails as Record<string, unknown>).businessTaxDeductions,
  );
  if (!sanitized.ok) {
    return {
      booksMapped,
      totalDeducted,
      queuedTotal: 0,
      queuedAdjustable: 0,
      queuedMinimum: 0,
      manualRemainder: fallbackRemainder,
      entries: [],
      problems: [(sanitized as { error: string }).error],
    };
  }

  const rowProblems = validateBusinessTaxDeductions(sanitized.rows);
  const comparison = compareWithWithholdingTotal(sanitized.rows, totalDeducted);
  const problems = [...rowProblems, ...comparison.problems];

  if (problems.length > 0) {
    return {
      booksMapped,
      totalDeducted,
      queuedTotal: 0,
      queuedAdjustable: 0,
      queuedMinimum: 0,
      manualRemainder: fallbackRemainder,
      entries: [],
      problems,
    };
  }

  if (sanitized.rows.length === 0) {
    return {
      booksMapped,
      totalDeducted,
      queuedTotal: 0,
      queuedAdjustable: 0,
      queuedMinimum: 0,
      manualRemainder: fallbackRemainder,
      entries: [],
      problems: [],
    };
  }

  const plan = buildTaxDeductionsPlan(sanitized.rows);
  return {
    booksMapped,
    totalDeducted,
    queuedTotal: plan.totals.taxDeducted,
    queuedAdjustable: plan.totals.adjustable,
    queuedMinimum: plan.totals.minimum,
    manualRemainder: comparison.remainder,
    entries: plan.entries,
    problems: [],
  };
}
