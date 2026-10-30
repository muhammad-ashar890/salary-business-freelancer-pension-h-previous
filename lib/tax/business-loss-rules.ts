/**
 * DP-4 item 3 (Phase 3d, 16-Oct-2026): business losses brought forward by
 * tax year and unabsorbed tax depreciation of earlier years.
 *
 * Law (ITO 2001 as amended to 31.07.2025, research/ito-2025.txt, s.57):
 * - (1)/(2) a business loss not set off is carried forward and set off only
 *   against income from business, for at most six tax years after the year
 *   it was first computed;
 * - (3) the loss of the earliest tax year is set off first;
 * - (4) the loss that comes from tax depreciation / initial allowance /
 *   amortization (s.22, 23, 23B, 24) is set off against 50% of the business
 *   income left after the (1) losses, year after year until fully set off
 *   (no time limit); proviso: 100% "if the taxable income for the year is
 *   less than ten million Rupees";
 * - (5) when a loss year is worked out, those deductions count last.
 * Speculation business losses (s.58) are not covered here.
 *
 * IRIS 2.0, tax year 2026 (business contract, capture 07): Business >
 * Adjustments rows 327021 ... 327025 "Unadjusted (Loss) from Business for
 * 2021" ... "2025" (Total Amount typable). There is no row for 2020 although
 * a 2020 loss is still within the six years. Live run of 15-Oct-2026: 327025
 * typed, IRIS set it off in Total Income (9000, Subject to Normal Tax).
 * Unabsorbed depreciation: row 3258 "Unabsorbed Tax Depreciation for Previous
 * Years" on the "+ Admissible" picker (capture 31/32, cells E E E D).
 *
 * The 10-million test can be read on taxable income before or after this
 * set-off. TaxRocket types 3258 only when both readings give the same
 * percentage; otherwise the taxpayer decides (USER message) and the estimate
 * uses 50%.
 */

export const BUSINESS_LOSSES_BY_YEAR_DETAIL_KEY = "businessLossesByYear";
export const UNABSORBED_DEPRECIATION_DETAIL_KEY = "businessUnabsorbedDepreciation";

/** s.57(2): years a loss may be carried forward. */
export const LOSS_CARRY_FORWARD_YEARS = 6;
/** s.57(4) proviso. */
export const UNABSORBED_FULL_SETOFF_LIMIT = 10_000_000;

/** Loss years IRIS lists on the Adjustments tab, by return tax year. */
const IRIS_LOSS_YEARS: Readonly<Record<number, readonly number[]>> = Object.freeze({
  2026: Object.freeze([2021, 2022, 2023, 2024, 2025]),
});

export function irisLossYears(taxYear: number): readonly number[] {
  return IRIS_LOSS_YEARS[taxYear] ?? [];
}

/** IRIS row of a loss year: 2021 -> 327021. */
export function lossRowCode(year: number): string {
  return String(327000 + (year - 2000));
}

export type BusinessLossByYear = {
  year: number;
  amount?: number;
};

const money = (value: number) => Math.round(value).toLocaleString("en-PK");

/** Shape check for the stored list; malformed input is an error, never "fixed". */
export function sanitizeBusinessLossesByYear(
  value: unknown,
): { ok: true; rows: BusinessLossByYear[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, rows: [] };
  if (!Array.isArray(value))
    return { ok: false, error: "Business losses by year must be a list." };
  if (value.length > LOSS_CARRY_FORWARD_YEARS)
    return { ok: false, error: `List at most ${LOSS_CARRY_FORWARD_YEARS} loss years.` };
  const rows: BusinessLossByYear[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return { ok: false, error: "Each loss year must be an object." };
    const record = entry as Record<string, unknown>;
    const year = record.year;
    if (typeof year !== "number" || !Number.isInteger(year) || year < 2000 || year > 2100)
      return { ok: false, error: "The tax year of a loss must be a year such as 2024." };
    const raw = record.amount;
    let amount: number | undefined;
    if (raw !== undefined && raw !== null && raw !== "") {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)
        return { ok: false, error: "A loss amount must be a positive number." };
      if (!Number.isInteger(raw))
        return { ok: false, error: "A loss amount must be in whole rupees." };
      amount = raw;
    }
    rows.push(amount === undefined ? { year } : { year, amount });
  }
  return { ok: true, rows };
}

/** Plain-language problems; empty means every line can be typed. */
export function validateBusinessLossesByYear(
  rows: readonly BusinessLossByYear[],
  taxYear: number,
): string[] {
  const problems: string[] = [];
  const allowed = irisLossYears(taxYear);
  const seen = new Set<number>();
  for (const row of rows) {
    const where = `Loss of tax year ${row.year}`;
    if (row.year >= taxYear) problems.push(`${where}: only losses of earlier tax years are brought forward.`);
    else if (row.year < taxYear - LOSS_CARRY_FORWARD_YEARS)
      problems.push(`${where}: a loss can be carried forward for six tax years only (s.57(2)); it has expired.`);
    else if (!allowed.includes(row.year))
      problems.push(
        `${where}: IRIS for tax year ${taxYear} has no row for this year (it lists ${allowed.join(", ") || "none"}). Leave it out here and ask FBR how to claim it.`,
      );
    if (seen.has(row.year)) problems.push(`${where} is listed twice. Put the whole unused loss of that year in one line.`);
    seen.add(row.year);
    if (row.amount === undefined) problems.push(`${where}: enter the unused loss.`);
    else if (row.amount <= 0) problems.push(`${where}: the amount must be more than zero.`);
  }
  return problems;
}

export function totalLossesByYear(rows: readonly BusinessLossByYear[]): number {
  return rows.reduce((sum, row) => sum + (row.amount ?? 0), 0);
}

/**
 * The listed years against "Business loss brought forward". More is a data
 * problem; less leaves the rest as a manual item.
 */
export function compareWithLossTotal(
  rows: readonly BusinessLossByYear[],
  total: number | null,
): { problems: string[]; remainder: number } {
  if (!rows.length) return { problems: [], remainder: total ?? 0 };
  const listed = totalLossesByYear(rows);
  if (total === null)
    return {
      problems: ["Losses are listed by year, but \"Business loss brought forward\" is empty. Enter the total there first."],
      remainder: 0,
    };
  if (listed > total)
    return {
      problems: [
        `The losses listed by year add up to Rs ${money(listed)}, which is more than "Business loss brought forward" (Rs ${money(total)}). Correct one of them.`,
      ],
      remainder: 0,
    };
  return { problems: [], remainder: total - listed };
}

export type UnabsorbedDepreciationDecision = {
  /** Balance of unabsorbed tax depreciation brought in. */
  broughtForward: number;
  /** 1 or 0.5 when both readings of the proviso agree; null when they differ or nothing to set off. */
  rate: 1 | 0.5 | null;
  /** True when the two readings of the 10-million test give different percentages. */
  ambiguous: boolean;
  /** Amount TaxRocket types in 3258 (0 when not typable). */
  typable: number;
  /** Amount the estimate deducts (50% when ambiguous). */
  estimateSetOff: number;
  /** 100% figure, shown to the taxpayer when ambiguous. */
  fullSetOff: number;
  /** 50% figure, shown to the taxpayer when ambiguous. */
  halfSetOff: number;
  /** Left for later years after the estimate's set-off. */
  remaining: number;
};

/**
 * s.57(3) / (4): set off brought-forward losses (earliest first) against the
 * year's business income, then unabsorbed depreciation against the balance.
 * `businessIncome` is after this year's tax depreciation. `otherIncomeHeads`
 * is true when the return has any income head besides business (then the
 * taxable income is not known here).
 */
export function setOffBroughtForward(input: {
  businessIncome: number;
  losses: readonly { year: number; amount: number }[];
  unlistedLoss?: number;
  unabsorbedDepreciation: number;
  otherIncomeHeads: boolean;
}): {
  lossSetOff: { year: number; amount: number; setOff: number; remaining: number }[];
  unlistedSetOff: number;
  totalLossSetOff: number;
  balanceAfterLosses: number;
  unabsorbed: UnabsorbedDepreciationDecision;
  taxableBusinessIncome: number;
} {
  const income = Math.max(0, Math.round(input.businessIncome || 0));
  let left = income;
  const lossSetOff = [...input.losses]
    .sort((a, b) => a.year - b.year)
    .map((loss) => {
      const amount = Math.max(0, Math.round(loss.amount || 0));
      const setOff = Math.min(amount, left);
      left -= setOff;
      return { year: loss.year, amount, setOff, remaining: amount - setOff };
    });
  // A part not listed by year has no known year; it is set off after the
  // listed years (the total set off is the same either way).
  const unlisted = Math.max(0, Math.round(input.unlistedLoss || 0));
  const unlistedSetOff = Math.min(unlisted, left);
  left -= unlistedSetOff;
  const totalLossSetOff = income - left;
  const balance = left;
  const U = Math.max(0, Math.round(input.unabsorbedDepreciation || 0));
  const fullSetOff = Math.min(U, balance);
  const halfSetOff = Math.min(U, Math.floor(balance / 2));
  let rate: 1 | 0.5 | null = null;
  let ambiguous = false;
  if (U > 0 && balance > 0) {
    if (!input.otherIncomeHeads && balance < UNABSORBED_FULL_SETOFF_LIMIT) rate = 1;
    else if (balance - fullSetOff >= UNABSORBED_FULL_SETOFF_LIMIT) rate = 0.5;
    else ambiguous = true;
  }
  const typable = rate === 1 ? fullSetOff : rate === 0.5 ? halfSetOff : 0;
  const estimateSetOff = rate === null ? (ambiguous ? halfSetOff : 0) : typable;
  return {
    lossSetOff,
    unlistedSetOff,
    totalLossSetOff,
    balanceAfterLosses: balance,
    unabsorbed: {
      broughtForward: U,
      rate,
      ambiguous,
      typable,
      estimateSetOff,
      fullSetOff,
      halfSetOff,
      remaining: U - estimateSetOff,
    },
    taxableBusinessIncome: balance - estimateSetOff,
  };
}

export const unabsorbedAmbiguousMessage = (d: UnabsorbedDepreciationDecision) =>
  `Unabsorbed tax depreciation (row 3258, s.57(4)): it is set off against 50% of your business income left after the brought-forward losses, or 100% if your taxable income for the year is less than Rs 10 million. Your figures sit where reading that test before or after this set-off gives a different answer, so TaxRocket did not type it. Type it yourself under Business > Inadmissible/Admissible Deductions > "+ Admissible" > "Unabsorbed Tax Depreciation for Previous Years": Rs ${money(d.halfSetOff)} (50%) or, if your adviser reads the test after the set-off, Rs ${money(d.fullSetOff)} (100%). The estimate uses the 50% figure.`;
