/**
 * DP-3 (Data Push, 16-Oct-2026): tax deducted / collected from business
 * receipts, by IRIS section, in the shape the IRIS 2.0 business "Tax
 * Deduction" tab takes it.
 *
 * IRIS structure [PROVEN: captures 10 / 34 / 56 / 66 / 67, IRIS 2.0,
 * 15-Oct-2026, ~/iris-business-captures]:
 * - Business > left tab "Tax Deduction" holds three grid panels: "Adjustable
 *   Tax" (header row 999913), "Final Tax" (999915) and "Minimum Tax"
 *   (999914). Each header row has a "+ Section" button that opens the picker
 *   "Add Adjustable Tax" / "Add Final Tax" / "Add Minimum Tax" (one checkbox
 *   card per section, ADD / Cancel). An added section is a row whose id is
 *   the 64xxxxxx code and whose description is the section name.
 * - Columns: Adjustable [Taxable Amount, Tax Deducted]; Final [Taxable
 *   Amount, Tax Deducted, Tax Chargeable]; Minimum [Taxable Amount, Tax
 *   Collected / Deducted, Tax Chargeable, Attributable Taxable Income, Tax on
 *   Attributable Taxable Income, Difference of Minimum Tax Chargeable]. IRIS
 *   computes the disabled cells itself.
 * - The full section list (93 rows, exact codes and names) is
 *   lib/tax/iris-tax-deduction-sections.ts.
 *
 * What the agent types (DP-3):
 * - Adjustable sections (all 14) and Minimum sections whose cells are the
 *   standard amount cells (48 of 60): Taxable Amount and Tax Deducted, plus
 *   Attributable Taxable Income where IRIS leaves that cell editable (the six
 *   import sections u/s 148).
 * - NOT typed (the taxpayer enters these in FBR):
 *   - Final-tax sections: final-tax receipts also need the "Subject to Final
 *     Tax" split of the business accounts (IRIS P&L columns), which is not
 *     automated yet.
 *   - Count-based sections (imported mobile phones, s.236CA): IRIS asks a
 *     number there, not an amount [LIKELY from the section names].
 *   - Sections with "+ Attribute" (ADTT): IRIS asks extra details there.
 * Minimum tax: IRIS compares the minimum tax with the normal tax and adds any
 * difference to Tax Chargeable itself; TaxRocket's own estimate does not do
 * that comparison yet (Phase 3e), so the agent's end check skips Tax
 * Chargeable (9200) when a minimum-tax section is typed.
 */
import { IRIS_TAX_DEDUCTION_CATALOG } from "./iris-tax-deduction-sections";

export const BUSINESS_TAX_DEDUCTIONS_DETAIL_KEY = "businessTaxDeductions";

export type TaxDeductionRegime = "adjustable" | "minimum" | "final";

/** The IRIS panels of the business Tax Deduction tab (captures 10 / 34 / 56 / 66 / 67). */
export const IRIS_TAX_DEDUCTION_REGIMES = Object.freeze({
  adjustable: Object.freeze({
    label: "Adjustable tax",
    panelTitle: "Adjustable Tax",
    headerRowId: "999913",
    pickerTitle: "Add Adjustable Tax",
    headers: Object.freeze(["Taxable Amount", "Tax Deducted"]),
  }),
  minimum: Object.freeze({
    label: "Minimum tax",
    panelTitle: "Minimum Tax",
    headerRowId: "999914",
    pickerTitle: "Add Minimum Tax",
    headers: Object.freeze([
      "Taxable Amount",
      "Tax Collected / Deducted",
      "Tax Chargeable",
      "Attributable Taxable Income",
      "Tax on Attributable Taxable Income",
      "Difference of Minimum Tax Chargeable",
    ]),
  }),
  final: Object.freeze({
    label: "Final tax",
    panelTitle: "Final Tax",
    headerRowId: "999915",
    pickerTitle: "Add Final Tax",
    headers: Object.freeze(["Taxable Amount", "Tax Deducted", "Tax Chargeable"]),
  }),
});

export const TAX_DEDUCTION_PANEL_ORDER: readonly TaxDeductionRegime[] = [
  "adjustable",
  "final",
  "minimum",
];

export type TaxDeductionUnsupportedReason =
  | "final_regime"
  | "count_based"
  | "attribute_dialog"
  | "cell_pattern";

export const TAX_DEDUCTION_UNSUPPORTED_TEXT: Record<TaxDeductionUnsupportedReason, string> = {
  final_regime:
    "Final-tax receipts also need the \"Subject to Final Tax\" split of your business accounts in IRIS; that part is not automated yet. Enter this section in FBR yourself.",
  count_based:
    "For this section IRIS asks a number (phones, episodes or seconds), not an amount; it is not automated yet. Enter it in FBR yourself.",
  attribute_dialog:
    "IRIS asks extra details for this section (+ Attribute); it is not automated yet. Enter it in FBR yourself.",
  cell_pattern:
    "This section has a different set of IRIS cells; it is not automated yet. Enter it in FBR yourself.",
};

export type TaxDeductionSection = {
  regime: TaxDeductionRegime;
  code: string;
  label: string;
  /** One letter per IRIS value column: E editable, D computed, - no input. */
  cells: string;
  unsupported?: TaxDeductionUnsupportedReason;
};

const SECTIONS: readonly TaxDeductionSection[] = Object.freeze(
  TAX_DEDUCTION_PANEL_ORDER.flatMap((regime) =>
    IRIS_TAX_DEDUCTION_CATALOG[regime].map(
      (entry): TaxDeductionSection => ({
        regime,
        code: entry.code,
        label: entry.label,
        cells: entry.cells,
        ...(entry.unsupported ? { unsupported: entry.unsupported } : {}),
      }),
    ),
  ),
);

export function allTaxDeductionSections(): readonly TaxDeductionSection[] {
  return SECTIONS;
}

export function findTaxDeductionSection(
  regime: unknown,
  code: unknown,
): TaxDeductionSection | null {
  return (
    SECTIONS.find((section) => section.regime === regime && section.code === String(code ?? "")) ??
    null
  );
}

/** Sections the agent can type, in IRIS order, for the wizard's list. */
export function supportedTaxDeductionSections(
  regime: TaxDeductionRegime,
): readonly TaxDeductionSection[] {
  return SECTIONS.filter((section) => section.regime === regime && !section.unsupported);
}

/** True when IRIS leaves "Attributable Taxable Income" editable for this section. */
export function takesAttributableIncome(section: TaxDeductionSection): boolean {
  return section.regime === "minimum" && section.cells[3] === "E";
}

const MAX_ROWS = 30;

/** What the wizard stores; a row may be incomplete while it is being typed. */
export type BusinessTaxDeduction = {
  regime: TaxDeductionRegime;
  code: string;
  taxableAmount?: number;
  taxDeducted?: number;
  /** Only for minimum-tax import sections where IRIS asks for it. */
  attributableIncome?: number;
};

export type TaxDeductionAgentValue = {
  columnIndex: number;
  column: string;
  value: string;
};

export type TaxDeductionAgentField = {
  key: string;
  regime: TaxDeductionRegime;
  irisCode: string;
  label: string;
  panelTitle: string;
  pickerTitle: string;
  headerRowId: string;
  headers: string[];
  cells: string;
  values: TaxDeductionAgentValue[];
};

export type TaxDeductionsPlan = {
  version: "tax-deductions-v1";
  entries: {
    regime: TaxDeductionRegime;
    code: string;
    label: string;
    taxableAmount: number;
    taxDeducted: number;
    attributableIncome: number | null;
  }[];
  agentFields: TaxDeductionAgentField[];
  totals: { taxDeducted: number; adjustable: number; minimum: number };
};

function readAmount(
  raw: unknown,
  what: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0)
    return { ok: false, error: `${what} must be a positive number.` };
  if (!Number.isInteger(value))
    return { ok: false, error: `${what} must be in whole rupees.` };
  return { ok: true, value };
}

const money = (value: number) => Math.round(value).toLocaleString("en-PK");

/**
 * Shape check for the stored list. Empty rows are dropped; anything malformed
 * is an error (never silently "fixed").
 */
export function sanitizeBusinessTaxDeductions(
  value: unknown,
): { ok: true; rows: BusinessTaxDeduction[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, rows: [] };
  if (!Array.isArray(value))
    return { ok: false, error: "Tax deducted by section must be a list." };
  if (value.length > MAX_ROWS)
    return { ok: false, error: `List at most ${MAX_ROWS} tax deduction sections.` };
  const rows: BusinessTaxDeduction[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return { ok: false, error: "Each tax deduction line must be an object." };
    const record = entry as Record<string, unknown>;
    const regime = record.regime;
    if (regime !== "adjustable" && regime !== "minimum" && regime !== "final")
      return { ok: false, error: "Each tax deduction line needs its IRIS type (adjustable, minimum or final)." };
    if (record.code !== undefined && record.code !== null && typeof record.code !== "string")
      return { ok: false, error: "The IRIS section code must be text." };
    const code = String(record.code ?? "").trim();
    if (code && !/^\d{8}$/.test(code))
      return { ok: false, error: `"${code}" is not an IRIS tax section code.` };
    const amounts: Partial<Record<"taxableAmount" | "taxDeducted" | "attributableIncome", number>> = {};
    for (const [key, what] of [
      ["taxableAmount", "Taxable amount"],
      ["taxDeducted", "Tax deducted"],
      ["attributableIncome", "Attributable taxable income"],
    ] as const) {
      const read = readAmount(record[key], what);
      if (!read.ok) return { ok: false, error: (read as { error: string }).error };
      if (read.value !== undefined) amounts[key] = read.value;
    }
    if (!code && Object.keys(amounts).length === 0) continue;
    rows.push({ regime, code, ...amounts });
  }
  return { ok: true, rows };
}

/** Plain-language problems; empty means every line can be typed by the agent. */
export function validateBusinessTaxDeductions(
  rows: readonly BusinessTaxDeduction[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const section = row.code ? findTaxDeductionSection(row.regime, row.code) : null;
    const where = section ? `${section.label} (${section.code})` : `Tax deduction line ${index + 1}`;
    if (!row.code) {
      problems.push(`${where}: choose the IRIS section.`);
      return;
    }
    if (!section) {
      problems.push(`${where}: ${row.code} is not an IRIS ${row.regime} tax section.`);
      return;
    }
    if (section.unsupported) {
      problems.push(`${where}: ${TAX_DEDUCTION_UNSUPPORTED_TEXT[section.unsupported]} Leave it out of this list.`);
      return;
    }
    if (seen.has(section.code))
      problems.push(`${where} is listed twice. Add the amounts together in one line.`);
    seen.add(section.code);
    if (row.taxableAmount === undefined)
      problems.push(`${where}: enter the taxable amount (the gross receipts or value the tax was deducted on).`);
    else if (row.taxableAmount <= 0) problems.push(`${where}: the taxable amount must be more than zero.`);
    if (row.taxDeducted === undefined)
      problems.push(`${where}: enter the tax deducted (as in the withholding certificate).`);
    else if (row.taxDeducted <= 0) problems.push(`${where}: the tax deducted must be more than zero.`);
    if (
      row.taxableAmount !== undefined &&
      row.taxDeducted !== undefined &&
      row.taxDeducted > row.taxableAmount
    )
      problems.push(`${where}: the tax deducted (Rs ${money(row.taxDeducted)}) is more than the taxable amount (Rs ${money(row.taxableAmount)}).`);
    if (row.attributableIncome !== undefined && !takesAttributableIncome(section))
      problems.push(`${where}: IRIS does not take "Attributable Taxable Income" for this section; leave it empty.`);
  });
  return problems;
}

/** Sum of tax deducted over the listed lines (complete or not). */
export function totalTaxDeducted(rows: readonly BusinessTaxDeduction[]): number {
  return rows.reduce((sum, row) => sum + (row.taxDeducted ?? 0), 0);
}

/**
 * The listed lines against the "Tax already deducted on business receipts"
 * total of the Business Profit form. More than the total is a data problem;
 * less leaves the rest as a manual item (final-tax or special sections).
 */
export function compareWithWithholdingTotal(
  rows: readonly BusinessTaxDeduction[],
  total: number | null,
): { problems: string[]; remainder: number } {
  if (!rows.length) return { problems: [], remainder: total ?? 0 };
  const listed = totalTaxDeducted(rows);
  if (total === null)
    return {
      problems: [
        "Tax deducted is listed by section, but \"Tax already deducted on business receipts\" is empty. Enter the total there first.",
      ],
      remainder: 0,
    };
  if (listed > total)
    return {
      problems: [
        `The tax deducted listed by section adds up to Rs ${money(listed)}, which is more than "Tax already deducted on business receipts" (Rs ${money(total)}). Correct one of them.`,
      ],
      remainder: 0,
    };
  return { problems: [], remainder: total - listed };
}

/**
 * Packet entries for a complete, validated list. Callers validate first; this
 * refuses (throws) rather than building a partial plan.
 */
export function buildTaxDeductionsPlan(rows: readonly BusinessTaxDeduction[]): TaxDeductionsPlan {
  const problems = validateBusinessTaxDeductions(rows);
  if (problems.length) throw new Error(problems.join(" "));
  const entries: TaxDeductionsPlan["entries"] = [];
  const agentFields: TaxDeductionAgentField[] = [];
  // IRIS order (panel, then section list) so the agent works top to bottom.
  const ordered = [...rows].sort((a, b) => {
    const ia = SECTIONS.findIndex((s) => s.regime === a.regime && s.code === a.code);
    const ib = SECTIONS.findIndex((s) => s.regime === b.regime && s.code === b.code);
    return ia - ib;
  });
  for (const row of ordered) {
    const section = findTaxDeductionSection(row.regime, row.code) as TaxDeductionSection;
    const spec = IRIS_TAX_DEDUCTION_REGIMES[section.regime];
    const taxableAmount = row.taxableAmount as number;
    const taxDeducted = row.taxDeducted as number;
    const attributable =
      takesAttributableIncome(section) && row.attributableIncome !== undefined
        ? row.attributableIncome
        : null;
    entries.push({
      regime: section.regime,
      code: section.code,
      label: section.label,
      taxableAmount,
      taxDeducted,
      attributableIncome: attributable,
    });
    const values: TaxDeductionAgentValue[] = [
      { columnIndex: 0, column: spec.headers[0], value: String(taxableAmount) },
      { columnIndex: 1, column: spec.headers[1], value: String(taxDeducted) },
    ];
    if (attributable !== null)
      values.push({ columnIndex: 3, column: spec.headers[3], value: String(attributable) });
    agentFields.push({
      key: `${section.code}:taxDeduction`,
      regime: section.regime,
      irisCode: section.code,
      label: section.label,
      panelTitle: spec.panelTitle,
      pickerTitle: spec.pickerTitle,
      headerRowId: spec.headerRowId,
      headers: [...spec.headers],
      cells: section.cells,
      values,
    });
  }
  const sumOf = (regime: TaxDeductionRegime) =>
    entries.filter((e) => e.regime === regime).reduce((sum, e) => sum + e.taxDeducted, 0);
  return {
    version: "tax-deductions-v1",
    entries,
    agentFields,
    totals: {
      taxDeducted: entries.reduce((sum, e) => sum + e.taxDeducted, 0),
      adjustable: sumOf("adjustable"),
      minimum: sumOf("minimum"),
    },
  };
}
