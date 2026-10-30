// File: lib/tax/business-profit.ts
//
// Business profit for an individual filing for themselves (TY2026).
//
// The taxpayer declares a handful of yearly figures on the "Business profit"
// step. This module turns them into the taxable business income that joins the
// individual slab (see `computeCombinedSlabRoute` in tax-calculation.ts).
//
// It is a pure function: no database, no wizard state. The rules it encodes:
//
//   taxable business income =
//       sales + other business receipts
//       - cost of sales - operating expenses - book depreciation
//       + book depreciation again (added back: s.22 allows only tax
//         depreciation; IRIS 3238 = 3088)
//       + inadmissible expenses (added back; Section 21)
//       - tax depreciation and initial allowance (s.22/s.23, Third Schedule;
//         IRIS Depreciation tab), only when an asset schedule is given
//       +/- gain or loss on disposed assets from that schedule (s.22(8))
//       - accounting profit / + accounting loss on assets sold that is already
//         inside the figures above (DP-4 item 2; the tax figure counts instead)
//       - business loss brought forward (Section 57, only against a profit;
//         by year, earliest first, DP-4 item 3)
//       - unabsorbed tax depreciation of earlier years against 50% / 100% of
//         the balance (s.57(4), DP-4 item 3)
//
// Phase 3a (15-Oct-2026), plan decision D1 = (a) (PHASE-3-PLAN.md; the
// taxpayer said "start" on that plan): until the app collects
// the asset schedule, NOTHING is deducted for tax depreciation and the result
// says so (taxDepreciationPending). That is what IRIS computes too while its
// Depreciation tab is empty, so the estimate and IRIS agree.
//
// What it deliberately does NOT do (the estimate says so):
//   - It does not test whether an expense is admissible. The taxpayer enters
//     the inadmissible total; Section 21 (for example 21(h) personal
//     expenses, 21(l) cash payments above Rs 250,000, 21(r) the 8% cap on
//     non-integrated sales) is a hint on screen, not a check.
//   - It does not use book depreciation as the tax deduction. Tax
//     depreciation comes from `computeTaxDepreciation` (tax-depreciation.ts)
//     when an asset schedule is passed in; the wizard does not collect one yet.
//   - It does not credit tax already deducted on business receipts. That
//     amount is shown for information only; the Section 153 minimum-tax and
//     refund interaction is not modelled yet.
//   - It does not apply Section 113 minimum tax. At or above the turnover
//     threshold below the estimate stops instead of showing a wrong figure.
//
// Law source: Income Tax Ordinance 2001 as amended to 31.07.2025 (TY2026).

import type { Ty2026SelectionUserDetails } from "./rules/ty2026/subcategories";
import {
  computeTaxDepreciation,
  type TaxDepreciationInput,
  type TaxDepreciationResult,
} from "./tax-depreciation";
import { depreciationScheduleToEngineInput } from "./business-depreciation-schedule";
import {
  sanitizeBusinessLossesByYear,
  setOffBroughtForward,
  type UnabsorbedDepreciationDecision,
} from "./business-loss-rules";
import { SECTION_113_TURNOVER_THRESHOLD } from "./minimum-tax-113";

/**
 * Section 113(1): minimum tax reaches an individual whose turnover is
 * Rs 100 million or more in the tax year (or was in an earlier year from
 * TY2017, asked separately: minimum-tax-113.ts).
 */
export const BUSINESS_MINIMUM_TAX_TURNOVER_THRESHOLD = SECTION_113_TURNOVER_THRESHOLD;

export type BusinessProfitFigures = Readonly<{
  grossSales: number;
  otherBusinessRevenue: number;
  costOfSales: number;
  operatingExpenses: number;
  /** Book (accounting) depreciation as typed; added back, never the tax deduction. */
  depreciation: number;
  inadmissibleExpenses: number;
  lossBroughtForward: number;
  withholdingDeducted: number;
}>;

export type BusinessProfitResult = Readonly<{
  figures: BusinessProfitFigures;
  /** Sales plus other business receipts. */
  turnover: number;
  /** Book depreciation added back (IRIS 3238). */
  accountingDepreciationAddedBack: number;
  /** Tax depreciation + initial allowance deducted (IRIS Depreciation tab). */
  taxDepreciation: number;
  /** Gain minus loss on disposed assets from the schedule (s.22(8)). */
  disposalResult: number;
  /**
   * DP-4 item 2: accounting profit / loss on those sales that the taxpayer
   * says is already inside other receipts / expenses; taken out so the sale
   * counts once, at its tax figure (IRIS reverses 3116 / 3196 the same way).
   * Zero when the asset list has no sale.
   */
  assetSaleBookGain: number;
  assetSaleBookLoss: number;
  /**
   * Book depreciation was typed but no asset schedule exists yet, so no tax
   * depreciation is deducted (plan decision D1 = a). Shown to the taxpayer.
   */
  taxDepreciationPending: boolean;
  /** Row-by-row result when a schedule was given. */
  taxDepreciationDetail: TaxDepreciationResult | null;
  /** Profit before any brought-forward loss; negative when the year is a loss. */
  profitBeforeLossRelief: number;
  /** Brought-forward loss actually set off this year. */
  lossSetOff: number;
  /** DP-4 item 3: the set-off by loss year, earliest first (s.57(3)). */
  lossSetOffByYear: readonly { year: number; amount: number; setOff: number; remaining: number }[];
  /** DP-4 item 3: unabsorbed tax depreciation of earlier years (s.57(4)). */
  unabsorbedDepreciation: UnabsorbedDepreciationDecision;
  /** Taxable business income, never below zero. */
  taxableIncome: number;
  /** Loss of this year available to carry forward (zero when there is a profit). */
  lossCarriedForward: number;
  /** Brought-forward loss left unused after this year. */
  broughtForwardLossRemaining: number;
  /**
   * This year's turnover is Rs 100 million or more, so Section 113 reaches
   * the return. Phase 3c prices it (minimum-tax-113.ts); before 3c the
   * estimate stopped here.
   */
  needsMinimumTaxRules: boolean;
}>;

function amount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** Rounds to paisa so repeated additions never leave floating-point residue. */
function money(value: number): number {
  return Math.round(value * 100) / 100;
}

export function readBusinessProfitFigures(
  details: Ty2026SelectionUserDetails | undefined | null,
): BusinessProfitFigures {
  return {
    grossSales: amount(details?.businessGrossSales),
    otherBusinessRevenue: amount(details?.businessOtherRevenue),
    costOfSales: amount(details?.businessCostOfSales),
    operatingExpenses: amount(details?.businessOperatingExpenses),
    depreciation: amount(details?.businessDepreciation),
    inadmissibleExpenses: amount(details?.businessInadmissibleExpenses),
    lossBroughtForward: amount(details?.businessLossBroughtForward),
    withholdingDeducted: amount(details?.businessWithholdingDeducted),
  };
}

/**
 * True once the taxpayer has declared sales. A business with no sales figure
 * has not been described yet, so calculation asks for it instead of treating
 * the empty form as a zero-profit business.
 */
export function hasBusinessSalesFigure(
  details: Ty2026SelectionUserDetails | undefined | null,
): boolean {
  return (
    typeof details?.businessGrossSales === "number" &&
    Number.isFinite(details.businessGrossSales) &&
    details.businessGrossSales > 0
  );
}

export function computeBusinessProfit(
  details: Ty2026SelectionUserDetails | undefined | null,
  options: Readonly<{
    /**
     * Asset schedule (IRIS Depreciation tab rows). When left out, the schedule
     * saved with the business details (DP-1) is used; null means "none".
     */
    depreciationSchedule?: TaxDepreciationInput | null;
    /**
     * DP-4 item 3: the return has income heads besides business, so the
     * taxable income for the s.57(4) 10-million test is not known here.
     */
    otherIncomeHeads?: boolean;
  }> = {},
): BusinessProfitResult {
  const figures = readBusinessProfitFigures(details);

  const turnover = money(figures.grossSales + figures.otherBusinessRevenue);
  const scheduleInput =
    options.depreciationSchedule !== undefined
      ? options.depreciationSchedule
      : details?.businessDepreciationSchedule?.length
        ? depreciationScheduleToEngineInput(details.businessDepreciationSchedule)
        : null;
  const schedule = scheduleInput ? computeTaxDepreciation(scheduleInput) : null;
  // s.22: book depreciation is not deductible; it is added back in full.
  const accountingDepreciationAddedBack = figures.depreciation;
  const taxDepreciation = schedule ? schedule.totals.deduction : 0;
  const disposalResult = schedule
    ? schedule.totals.disposalGain - schedule.totals.disposalLoss
    : 0;
  const hasSale = Boolean(scheduleInput?.rows.some((row) => (row.disposals?.length ?? 0) > 0));
  const assetSaleBookGain = hasSale ? amount(details?.businessAssetSaleBookGain) : 0;
  const assetSaleBookLoss = hasSale ? amount(details?.businessAssetSaleBookLoss) : 0;
  const profitBeforeLossRelief = money(
    turnover -
      figures.costOfSales -
      figures.operatingExpenses -
      figures.depreciation +
      accountingDepreciationAddedBack +
      figures.inadmissibleExpenses -
      taxDepreciation +
      disposalResult -
      assetSaleBookGain +
      assetSaleBookLoss,
  );

  // A brought-forward loss is set off only against a profit. A loss year
  // leaves it untouched and adds its own loss to the carry-forward.
  const lossSetOff =
    profitBeforeLossRelief > 0
      ? money(Math.min(figures.lossBroughtForward, profitBeforeLossRelief))
      : 0;
  // DP-4 item 3 (s.57(3)/(4)): the losses listed by year are set off earliest
  // first (a part not listed by year after them; the total is the same), then
  // unabsorbed tax depreciation against the balance (50% / 100% rule).
  const lossList = sanitizeBusinessLossesByYear(details?.businessLossesByYear);
  const listedLosses = lossList.ok
    ? lossList.rows
        .filter((row) => (row.amount ?? 0) > 0)
        .map((row) => ({ year: row.year, amount: row.amount as number }))
    : [];
  const listedTotal = listedLosses.reduce((sum, row) => sum + row.amount, 0);
  const listUsable = listedTotal <= figures.lossBroughtForward;
  const lossRules = setOffBroughtForward({
    businessIncome: profitBeforeLossRelief > 0 ? profitBeforeLossRelief : 0,
    losses: listUsable ? listedLosses : [],
    unlistedLoss: listUsable ? figures.lossBroughtForward - listedTotal : figures.lossBroughtForward,
    unabsorbedDepreciation: amount(details?.businessUnabsorbedDepreciation),
    otherIncomeHeads: Boolean(options.otherIncomeHeads),
  });
  const unabsorbedSetOff = profitBeforeLossRelief > 0 ? lossRules.unabsorbed.estimateSetOff : 0;
  const taxableIncome =
    profitBeforeLossRelief > 0
      ? Math.max(0, money(profitBeforeLossRelief - lossSetOff - unabsorbedSetOff))
      : 0;
  const lossCarriedForward =
    profitBeforeLossRelief < 0 ? money(-profitBeforeLossRelief) : 0;

  return {
    figures,
    turnover,
    accountingDepreciationAddedBack,
    taxDepreciation,
    disposalResult,
    assetSaleBookGain,
    assetSaleBookLoss,
    taxDepreciationPending: !schedule && figures.depreciation > 0,
    taxDepreciationDetail: schedule,
    profitBeforeLossRelief,
    lossSetOff,
    lossSetOffByYear: lossRules.lossSetOff,
    unabsorbedDepreciation: lossRules.unabsorbed,
    taxableIncome,
    lossCarriedForward,
    broughtForwardLossRemaining: money(figures.lossBroughtForward - lossSetOff),
    needsMinimumTaxRules: turnover >= BUSINESS_MINIMUM_TAX_TURNOVER_THRESHOLD,
  };
}
