/**
 * Required answers on the Business profit step (filing for yourself).
 *
 * These are the conditions under which the tax-calculation action
 * (app/actions/tax-calculation.ts, business-profit block) stops with
 * NEEDS_RULES and that this step can answer: an asset list that breaks an
 * IRIS/law rule, the unanswered Section 113 earlier-year question, and a
 * cotton ginner reached by Section 113. The wizard keeps Continue disabled
 * while any of them is open, so a filing does not reach the Review step with
 * an estimate that cannot be made. scripts/verify-business-step-required.cjs
 * keeps the two lists in step.
 *
 * 16-Oct: Sales and the other 7 yearly totals come from the Business Books
 * (lib/tax/business-books-figures.ts), which are mapped on the Upload
 * documents step after this one; that step will not continue without them.
 * This step therefore never relies on a sales figure: the Section 113
 * earlier-year question is answered in every case (the answer does not matter
 * when this year's turnover is Rs 100 million or more), and a cotton ginner is
 * stopped here when the earlier-year answer is Yes (when only this year's
 * turnover brings Section 113, the Review step shows the reason).
 */
import { validateDepreciationSchedule } from "./business-depreciation-schedule";
import {
  DEFAULT_MINIMUM_TAX_CATEGORY,
  SECTION_113_TEXT,
  getMinimumTaxCategory,
  section113Applicability,
} from "./minimum-tax-113";
import type { Ty2026SelectionUserDetails } from "./rules/ty2026/subcategories";

export type BusinessStepProblemId =
  | "asset_list_invalid"
  | "section113_unanswered"
  | "cotton_ginner";

export type BusinessStepProblem = Readonly<{
  id: BusinessStepProblemId;
  /** Plain words shown on the Business profit step (ASCII only). */
  text: string;
}>;

export const BUSINESS_STEP_TEXT = Object.freeze({
  assetListInvalid:
    "Fix the asset list for tax depreciation: see the red notes under that table.",
  section113Unanswered:
    "Answer the Section 113 question (Yes or No) in the \"Minimum tax on turnover\" box.",
  cottonGinner: SECTION_113_TEXT.cottonGinner,
});

/**
 * Every open required answer, in the order the step shows them. An empty
 * list means the tax estimate can be made from what is saved.
 */
export function businessProfitStepProblems(
  details: Ty2026SelectionUserDetails | undefined | null,
): BusinessStepProblem[] {
  const problems: BusinessStepProblem[] = [];
  if (validateDepreciationSchedule(details?.businessDepreciationSchedule ?? []).length)
    problems.push({ id: "asset_list_invalid", text: BUSINESS_STEP_TEXT.assetListInvalid });
  // The turnover comes from the Books later, so it is never used here: the
  // question is always answered, and Section 113 is known to apply on this
  // step only when the earlier-year answer is Yes.
  const reach = section113Applicability({
    turnover: 0,
    turnover100mEarlierYear: details?.businessTurnover100mEarlierYear,
  });
  if (reach.needsEarlierYearAnswer)
    problems.push({ id: "section113_unanswered", text: BUSINESS_STEP_TEXT.section113Unanswered });
  const category = getMinimumTaxCategory(
    details?.businessMinimumTaxCategory ?? DEFAULT_MINIMUM_TAX_CATEGORY,
  );
  if (reach.applies && (!category || category.ratePercent === null))
    problems.push({ id: "cotton_ginner", text: BUSINESS_STEP_TEXT.cottonGinner });
  return problems;
}
