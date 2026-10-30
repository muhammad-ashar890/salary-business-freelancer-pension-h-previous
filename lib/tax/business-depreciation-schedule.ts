// File: lib/tax/business-depreciation-schedule.ts
//
// DP-1 (Data Push, 15-Oct-2026): the taxpayer's asset schedule exactly as the
// IRIS 2.0 "Depreciation" tab takes it: one entry per IRIS row, the six
// columns IRIS lets a taxpayer type. IRIS itself then works out Initial
// Allowance, Depreciation and WDV (CF); TaxRocket works out the same figures
// with lib/tax/tax-depreciation.ts (Phase 3a) so the agent can compare them.
//
// IRIS evidence: capture 11 (Depreciation tab HTML) and the live census of job
// cmv9f3gso002g13ldnhvodcvc: 12 asset rows + total 324802, 68 editable cells.
// Columns, in order: WDV (BF), Deletion, Addition (Used in Pakistan), Extent
// of Use, Addition (New), Extent of Use; then computed Initial Allowance,
// Depreciation, WDV (CF). Row 330308 accepts only Addition (New) + its Extent.
// The inputs take digits only (onkeypress blocks anything above "9"), so
// every figure here is a whole number.
//
// Law: see lib/tax/tax-depreciation.ts (ITO 2001 s.22, s.23, Third Schedule).
//
// [CHECK-LIVE] Not yet seen in IRIS, so reported, never assumed:
//   - Deletion: this module types the tax WDV of the assets disposed of.
//   - A disposal's gain or loss (sale price vs WDV, s.22(8)): the Depreciation
//     tab has no sale-price column. DP-4 item 2 types it in 3226 / 3256 on the
//     Inadmissible/Admissible Deductions tab (lib/tax/business-asset-sales.ts).
//   - Rounding of IRIS's computed cells.

import {
  DISABILITY_RAMP_MAX_COST,
  PASSENGER_VEHICLE_COST_CAP,
  TAX_DEPRECIATION_ROWS,
  computeTaxDepreciation,
  type TaxDepreciationAddition,
  type TaxDepreciationInput,
  type TaxDepreciationResult,
  type TaxDepreciationRowCode,
} from "./tax-depreciation";

/** Key of the schedule inside the business selection's details. */
export const DEPRECIATION_SCHEDULE_DETAIL_KEY = "businessDepreciationSchedule";

export type DepreciationScheduleRow = {
  code: TaxDepreciationRowCode;
  /** Tax WDV at the start of the year. */
  wdvBroughtForward?: number;
  /** Tax WDV of the assets of this row disposed of during the year. */
  deletion?: number;
  /** What was received for those assets (needed whenever there is a deletion). */
  deletionSalePrice?: number;
  /** Cost of assets bought this year that were used in Pakistan before. */
  additionUsed?: number;
  /**
   * IRIS's first "Extent of Use" cell, 1-100 %. Live IRIS applies this one
   * percentage to the opening pool (WDV brought forward after deletions, plus
   * used additions), not only to the used addition printed before it. The
   * stored key keeps its historical name for saved schedules.
   */
  additionUsedExtent?: number;
  /** Cost of new assets bought this year. */
  additionNew?: number;
  /** Business use of those assets, 1-100 %. */
  additionNewExtent?: number;
};

export type DepreciationScheduleField = Exclude<
  keyof DepreciationScheduleRow,
  "code"
>;

/** The typed IRIS columns, in IRIS order. "Extent of Use" appears twice. */
export const DEPRECIATION_TYPED_COLUMNS: readonly Readonly<{
  field: DepreciationScheduleField;
  column:
    | "WDV (BF)"
    | "Deletion"
    | "Addition (Used in Pakistan)"
    | "Extent of Use"
    | "Addition (New)";
  /** 1 = first column with this heading, 2 = the second one. */
  headerOccurrence: number;
  /** Position among the row's nine cells (0-based). */
  cellIndex: number;
}>[] = [
  { field: "wdvBroughtForward", column: "WDV (BF)", headerOccurrence: 1, cellIndex: 0 },
  { field: "deletion", column: "Deletion", headerOccurrence: 1, cellIndex: 1 },
  { field: "additionUsed", column: "Addition (Used in Pakistan)", headerOccurrence: 1, cellIndex: 2 },
  { field: "additionUsedExtent", column: "Extent of Use", headerOccurrence: 1, cellIndex: 3 },
  { field: "additionNew", column: "Addition (New)", headerOccurrence: 1, cellIndex: 4 },
  { field: "additionNewExtent", column: "Extent of Use", headerOccurrence: 2, cellIndex: 5 },
];

/** All nine IRIS headings of the Depreciation grid after Description / Code. */
export const DEPRECIATION_GRID_HEADINGS = [
  "WDV (BF)",
  "Deletion",
  "Addition (Used in Pakistan)",
  "Extent of Use",
  "Addition (New)",
  "Extent of Use",
  "Initial Allowance",
  "Depreciation",
  "WDV (CF)",
] as const;

/** IRIS total row of the Depreciation tab; it feeds 3248. */
export const DEPRECIATION_TOTAL_CODE = "324802";

const FIELDS: readonly DepreciationScheduleField[] = [
  "wdvBroughtForward",
  "deletion",
  "deletionSalePrice",
  "additionUsed",
  "additionUsedExtent",
  "additionNew",
  "additionNewExtent",
];

const RULES = new Map(TAX_DEPRECIATION_ROWS.map((rule) => [rule.code, rule]));

const money = (value: number) => Math.round(value).toLocaleString("en-US");

/**
 * Shape check for what the wizard saves. Rows without any figure are dropped;
 * anything malformed is an error (never silently "fixed").
 */
export function sanitizeDepreciationSchedule(
  value: unknown,
): { ok: true; rows: DepreciationScheduleRow[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, rows: [] };
  if (!Array.isArray(value))
    return { ok: false, error: "The asset schedule must be a list of IRIS rows." };
  if (value.length > TAX_DEPRECIATION_ROWS.length)
    return { ok: false, error: "The asset schedule has more rows than the IRIS Depreciation tab." };
  const rows: DepreciationScheduleRow[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return { ok: false, error: "Each asset schedule row must be an object." };
    const record = entry as Record<string, unknown>;
    const code = String(record.code ?? "");
    const rule = RULES.get(code as TaxDepreciationRowCode);
    if (!rule)
      return { ok: false, error: `Row ${code || "(empty)"} is not an IRIS Depreciation row.` };
    if (seen.has(code))
      return { ok: false, error: `Row ${code} (${rule.label}) is listed twice.` };
    seen.add(code);
    const row: DepreciationScheduleRow = { code: rule.code };
    for (const field of FIELDS) {
      const raw = record[field];
      if (raw === undefined || raw === null || raw === "") continue;
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)
        return { ok: false, error: `${rule.label}: ${field} must be a number of zero or more.` };
      if (!Number.isInteger(raw))
        return { ok: false, error: `${rule.label}: IRIS takes whole rupees and whole percentages only.` };
      row[field] = raw;
    }
    if (FIELDS.some((field) => (row[field] ?? 0) > 0)) rows.push(row);
  }
  rows.sort(
    (a, b) =>
      TAX_DEPRECIATION_ROWS.findIndex((rule) => rule.code === a.code) -
      TAX_DEPRECIATION_ROWS.findIndex((rule) => rule.code === b.code),
  );
  return { ok: true, rows };
}

/**
 * Total current-year asset additions in a reviewed schedule. Bank-ledger
 * equipment purchases are cash evidence for these additions; they are not a
 * second amount to type in IRIS.
 */
export function totalDepreciationAdditions(
  rows: readonly DepreciationScheduleRow[],
): number {
  return rows.reduce(
    (sum, row) => sum + (row.additionUsed ?? 0) + (row.additionNew ?? 0),
    0,
  );
}

/**
 * Law and IRIS rules a complete schedule must meet before it is priced or
 * typed. Returns plain-language problems; empty means usable.
 */
export function validateDepreciationSchedule(
  rows: readonly DepreciationScheduleRow[],
): string[] {
  const problems: string[] = [];
  for (const row of rows) {
    const rule = RULES.get(row.code);
    if (!rule) {
      problems.push(`Row ${row.code} is not an IRIS Depreciation row.`);
      continue;
    }
    const where = `${rule.label} (${rule.code})`;
    const wdv = row.wdvBroughtForward ?? 0;
    const deletion = row.deletion ?? 0;
    if (!rule.acceptsBroughtForward && (wdv > 0 || deletion > 0))
      problems.push(`${where}: IRIS takes only this year's new additions in this row (s.23); move older assets to 33030105.`);
    if (!rule.acceptsUsedAdditions && (row.additionUsed ?? 0) > 0)
      problems.push(`${where}: machinery used before in Pakistan gets no initial allowance (s.23(5)(c)); enter it under 33030105.`);
    if (deletion > 0 && row.deletionSalePrice === undefined)
      problems.push(`${where}: enter what was received for the assets disposed of (s.22(8)).`);
    if (deletion === 0 && (row.deletionSalePrice ?? 0) > 0)
      problems.push(`${where}: a sale price needs the WDV of the assets disposed of (Deletion).`);
    if (deletion > wdv)
      problems.push(`${where}: Deletion (${money(deletion)}) is more than WDV (BF) (${money(wdv)}).`);
    // IRIS has ONE first Extent cell for the whole opening pool: brought-
    // forward WDV after deletions plus used additions. A legacy BF-only row
    // without that percentage keeps the engine's long-standing 100% default
    // when the agent field is built; a used addition still needs it stated.
    const openingPool = wdv - deletion + (row.additionUsed ?? 0);
    const openingExtent = row.additionUsedExtent;
    if (
      (row.additionUsed ?? 0) > 0 &&
      (openingExtent === undefined || openingExtent < 1 || openingExtent > 100)
    )
      problems.push(`${where}: enter the business use (1-100 %) of the opening WDV and used additions.`);
    if (
      (row.additionUsed ?? 0) === 0 &&
      openingPool > 0 &&
      openingExtent !== undefined &&
      (openingExtent < 1 || openingExtent > 100)
    )
      problems.push(`${where}: enter the business use (1-100 %) of the opening WDV and used additions.`);
    if (openingPool <= 0 && openingExtent !== undefined && openingExtent > 0)
      problems.push(`${where}: business use is given for an opening WDV / used-addition pool of 0.`);

    const newAmount = row.additionNew ?? 0;
    const newExtent = row.additionNewExtent;
    if (newAmount > 0 && (newExtent === undefined || newExtent < 1 || newExtent > 100))
      problems.push(`${where}: enter the business use (1-100 %) of the new addition.`);
    if (newAmount === 0 && newExtent !== undefined && newExtent > 0)
      problems.push(`${where}: business use is given for a new addition of 0.`);
  }
  return problems;
}

/**
 * Pieces of at most `limit` that add up to `total`. The IRIS row takes one
 * total per column, so a row holding several vehicles (each already capped at
 * Rs 7.5 million, s.22(13)(a)) or several ramps (each up to Rs 250,000) is
 * handed to the engine in pieces: its per-item rule then never cuts a total
 * that the taxpayer has already built item by item.
 */
function pieces(total: number, limit: number | null): number[] {
  if (!(total > 0)) return [];
  if (limit === null || total <= limit) return [total];
  const out: number[] = [];
  let left = total;
  while (left > 0) {
    const piece = Math.min(limit, left);
    out.push(piece);
    left -= piece;
  }
  return out;
}

/** The schedule in the shape the Phase 3a engine takes. */
export function depreciationScheduleToEngineInput(
  rows: readonly DepreciationScheduleRow[],
): TaxDepreciationInput {
  return {
    rows: rows.map((row) => {
      const rule = RULES.get(row.code);
      const limit = rule?.costCapPerItem ?? rule?.maxCostPerItem ?? null;
      const additions = (amount: number | undefined, extent: number | undefined) =>
        pieces(amount ?? 0, limit).map(
          (cost): TaxDepreciationAddition => ({ cost, businessUsePercent: extent }),
        );
      return {
        code: row.code,
        writtenDownValueBroughtForward: row.wdvBroughtForward,
        // The same first IRIS Extent cell scales BF and used additions.
        broughtForwardBusinessUsePercent: row.additionUsedExtent,
        disposals:
          (row.deletion ?? 0) > 0
            ? [
                {
                  writtenDownValue: row.deletion ?? 0,
                  consideration: row.deletionSalePrice ?? 0,
                },
              ]
            : [],
        additionsUsedInPakistan: additions(row.additionUsed, row.additionUsedExtent),
        additionsNew: additions(row.additionNew, row.additionNewExtent),
      };
    }),
  };
}

export function computeScheduleDepreciation(
  rows: readonly DepreciationScheduleRow[],
): TaxDepreciationResult {
  return computeTaxDepreciation(depreciationScheduleToEngineInput(rows));
}

export type DepreciationAgentField = Readonly<{
  key: string;
  irisCode: TaxDepreciationRowCode;
  irisDescription: string;
  column: (typeof DEPRECIATION_TYPED_COLUMNS)[number]["column"];
  headerOccurrence: number;
  cellIndex: number;
  ourAmount: number;
}>;

/**
 * Every figure the agent types on the Depreciation tab. Zero figures are not
 * typed (an empty IRIS cell already means 0). The first Extent is typed for
 * the whole opening pool, including a brought-forward-only row: on the live
 * 19-Oct-2026 run IRIS gave no depreciation on BF rows while that cell was
 * blank. A legacy BF-only row with no percentage uses the engine's existing
 * 100% default; an explicit percentage is always preserved.
 */
export function buildDepreciationAgentFields(
  rows: readonly DepreciationScheduleRow[],
): DepreciationAgentField[] {
  const out: DepreciationAgentField[] = [];
  for (const row of rows) {
    const rule = RULES.get(row.code);
    if (!rule) continue;
    const openingPool =
      (row.wdvBroughtForward ?? 0) -
      (row.deletion ?? 0) +
      (row.additionUsed ?? 0);
    for (const column of DEPRECIATION_TYPED_COLUMNS) {
      let value = row[column.field];
      if (column.field === "additionUsedExtent") {
        if (!rule.acceptsBroughtForward && !rule.acceptsUsedAdditions) continue;
        if (!(openingPool > 0)) continue;
        if (value === undefined) {
          // A used addition must carry its stated percentage (validation
          // blocks the packet without one); only BF-only legacy rows default.
          if ((row.additionUsed ?? 0) > 0) continue;
          value = 100;
        }
      }
      if (value === undefined || !(value > 0)) continue;
      if (column.field === "additionNewExtent" && !((row.additionNew ?? 0) > 0)) continue;
      out.push({
        key: `depreciation.${row.code}.${column.field}`,
        irisCode: row.code,
        irisDescription: rule.label,
        column: column.column,
        headerOccurrence: column.headerOccurrence,
        cellIndex: column.cellIndex,
        ourAmount: value,
      });
    }
  }
  return out;
}

export type DepreciationComputedExpectation = Readonly<{
  code: string;
  label: string;
  initialAllowance: number;
  depreciation: number;
  writtenDownValueCarriedForward: number;
}>;

/**
 * What IRIS should show in its computed cells after the agent typed the
 * schedule: one entry per typed row plus the 324802 total. Used for the
 * end-of-run comparison; a difference is reported, never "fixed".
 */
export function buildDepreciationExpectations(
  rows: readonly DepreciationScheduleRow[],
): {
  rows: DepreciationComputedExpectation[];
  total: DepreciationComputedExpectation;
  deduction: number;
  disposalGain: number;
  disposalLoss: number;
  issues: readonly string[];
} {
  const result = computeScheduleDepreciation(rows);
  return {
    rows: result.rows.map((row) => ({
      code: row.code,
      label: row.label,
      initialAllowance: row.initialAllowance,
      depreciation: row.depreciation,
      writtenDownValueCarriedForward: row.writtenDownValueCarriedForward,
    })),
    total: {
      code: DEPRECIATION_TOTAL_CODE,
      label: "Depreciation",
      initialAllowance: result.totals.initialAllowance,
      depreciation: result.totals.depreciation,
      writtenDownValueCarriedForward: result.totals.writtenDownValueCarriedForward,
    },
    deduction: result.totals.deduction,
    disposalGain: result.totals.disposalGain,
    disposalLoss: result.totals.disposalLoss,
    issues: result.issues,
  };
}

/** Hints the wizard shows next to the rows with a per-item rule. */
export const DEPRECIATION_ROW_HINTS: Readonly<Partial<Record<TaxDepreciationRowCode, string>>> = {
  "3304105": `Add each vehicle at its cost, but at most Rs ${PASSENGER_VEHICLE_COST_CAP.toLocaleString("en-US")} per vehicle (s.22(13)(a)). Sold a vehicle that cost more? Its sale price counts as sale price x ${PASSENGER_VEHICLE_COST_CAP.toLocaleString("en-US")} / its cost (s.22(10)).`,
  // DP-4 item 2: per-asset rules on a sale (the row takes one total).
  "330205": "Building only, never the land (s.22(13)(b)). For a building sold, use the sale price of the building without the land, and at most what the building cost you (s.22(13)(d)).",
  "33020405": `Only ramps costing up to Rs ${DISABILITY_RAMP_MAX_COST.toLocaleString("en-US")} each belong here (Third Schedule Part I item V).`,
  "330308": "Only new plant or machinery placed in service for the first time this year (25% initial allowance, s.23).",
};
