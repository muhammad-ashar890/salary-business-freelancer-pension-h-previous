// File: lib/tax/tax-depreciation.ts
//
// Tax depreciation and initial allowance on business assets (TY2026), row by
// row exactly as the IRIS 2.0 "Depreciation" tab lists them. Pure function: no
// database, no wizard state.
//
// Why it exists: accounting (book) depreciation is NOT the tax deduction. IRIS
// adds book depreciation back (3238 = 3088) and deducts depreciation worked
// out at Third Schedule rates on the Depreciation tab (Phase 3a, 15-Oct-2026).
//
// Law: Income Tax Ordinance 2001 as amended up to 31.07.2025 (FA 2025),
// research/ito-2025.pdf ("p." = PDF page):
//   s.22(2)  rate in Part I of the Third Schedule x written-down value (WDV)
//            at the beginning of the year (p.88)
//   s.22(5)  asset acquired in the year: WDV = cost - initial allowance, so
//            it gets a full year; the "50% in the first year" proviso was
//            omitted by FA 2022 (p.89)
//   s.22(3)  partly business use: the deduction is the fair proportion;
//   s.22(6)  the WDV is still computed as if wholly used (p.88-89)
//   s.22(7)  depreciation + initial allowance never exceed the cost (p.89)
//   s.22(8)  year of disposal: no depreciation; consideration above WDV is
//            business income, below WDV a deduction (p.90)
//   s.22(10), s.22(13)(a)  passenger vehicle not plying for hire: cost
//            capped at Rs 7.5 million (FA 2022); consideration scaled (p.90-91)
//   s.22(13)(b)  land is never part of the cost (p.91)
//   s.23 + Third Schedule Part II  initial allowance 25% of cost, for plant
//            and machinery only, placed in service for the first time; never
//            for road vehicles not plying for hire, furniture, plant or
//            machinery used before in Pakistan, or immovable property
//            (p.92-93, 719)
//   Third Schedule Part I rates (p.718): building 10%; furniture, plant and
//            machinery, motor vehicles, ships, books 15%; computers / IT
//            manufacturing equipment / aircraft 30%; offshore installations
//            20%; ramp for persons with disabilities (<= Rs 250,000 each) 100%.
//
// IRIS (live census, job cmv9f3gso002g13ldnhvodcvc): columns WDV (BF),
// Deletion, Addition (Used in Pakistan), Extent of Use, Addition (New), Extent
// of Use, then computed Initial Allowance, Depreciation, WDV (CF). Row
// 330308 only accepts new additions.
//
// [CHECK-LIVE] Not yet seen in IRIS, so not assumed to match: how IRIS reads
// "Deletion" (WDV or sale price), whether its Extent of Use also scales the
// initial allowance (s.23 has no proportion rule; this module does not scale
// it), and its rounding (this module rounds each row to whole rupees).

export type TaxDepreciationRowCode =
  | "330205"
  | "33020405"
  | "33030105"
  | "330308"
  | "33030205"
  | "33030305"
  | "33030405"
  | "33030605"
  | "3304105"
  | "3304205"
  | "3304305"
  | "3304405";

export type TaxDepreciationRowRule = Readonly<{
  code: TaxDepreciationRowCode;
  /** Label as IRIS shows it. */
  label: string;
  /** Third Schedule Part I rate. */
  ratePercent: number;
  /** Third Schedule Part II rate (25 only for new plant and machinery). */
  initialAllowancePercent: number;
  /** False for 330308, which takes only this year's new additions. */
  acceptsBroughtForward: boolean;
  acceptsUsedAdditions: boolean;
  /** s.22(13)(a): cost ceiling per vehicle. */
  costCapPerItem: number | null;
  /** Part I item V: only ramps up to this cost belong in the row. */
  maxCostPerItem: number | null;
  law: string;
}>;

/** s.22(13)(a), FA 2022: passenger transport vehicle not plying for hire. */
export const PASSENGER_VEHICLE_COST_CAP = 7_500_000;
/** Third Schedule Part I item V. */
export const DISABILITY_RAMP_MAX_COST = 250_000;

export const TAX_DEPRECIATION_ROWS: readonly TaxDepreciationRowRule[] = [
  row("330205", "Building (all types)", 10, "Third Schedule Part I item I; no initial allowance (s.23(5)(e))"),
  {
    ...row("33020405", "Ramp for Disabled Persons", 100, "Third Schedule Part I item V"),
    maxCostPerItem: DISABILITY_RAMP_MAX_COST,
  },
  row("33030105", "Plant / Machinery (not Otherwise specified)", 15, "Third Schedule Part I item II"),
  {
    ...row("330308", "Plant / Machinery eligible for Initial Allowance", 15, "s.23 + Third Schedule Part II(1): 25% initial allowance; depreciation 15% on cost less the allowance (s.22(5)(a))"),
    initialAllowancePercent: 25,
    acceptsBroughtForward: false,
    acceptsUsedAdditions: false,
  },
  row("33030205", "Computer Hardware / Allied Items / Equipment used in manufacture of IT products", 30, "Third Schedule Part I item III"),
  row("33030305", "Furniture (including fittings)", 15, "Third Schedule Part I item II; no initial allowance (s.23(5)(b))"),
  row("33030405", "Technical / Professional Books", 15, "Third Schedule Part I item II"),
  row("33030605", "Offshore Installations of mineral Oil concerns", 20, "Third Schedule Part I item IV(b)"),
  {
    ...row("3304105", "Motor Vehicle (not plying for hire)", 15, "Third Schedule Part I item II; cost capped at Rs 7.5 million (s.22(13)(a)); no initial allowance (s.23(5)(a))"),
    costCapPerItem: PASSENGER_VEHICLE_COST_CAP,
  },
  row("3304205", "Motor Vehicle (plying for hire)", 15, "Third Schedule Part I item II"),
  row("3304305", "Ships", 15, "Third Schedule Part I item II"),
  row("3304405", "Aircrafts / Aero Engines", 30, "Third Schedule Part I item III"),
];

function row(
  code: TaxDepreciationRowCode,
  label: string,
  ratePercent: number,
  law: string,
): TaxDepreciationRowRule {
  return {
    code,
    label,
    ratePercent,
    initialAllowancePercent: 0,
    acceptsBroughtForward: true,
    acceptsUsedAdditions: true,
    costCapPerItem: null,
    maxCostPerItem: null,
    law,
  };
}

export type TaxDepreciationAddition = Readonly<{
  /** Cost to the taxpayer, without land (s.22(13)(b)). */
  cost: number;
  /** Business use, 0-100; empty means wholly business. */
  businessUsePercent?: number;
}>;

export type TaxDepreciationDisposal = Readonly<{
  /** Tax WDV of the asset when it was disposed of. */
  writtenDownValue: number;
  /** What was received for it. */
  consideration: number;
  /** Actual cost; only used for a capped vehicle (s.22(10)). */
  actualCost?: number;
}>;

export type TaxDepreciationRowInput = Readonly<{
  code: TaxDepreciationRowCode;
  /** Tax WDV at the start of the year (cost less all earlier tax deductions). */
  writtenDownValueBroughtForward?: number;
  /** Business use of the brought-forward assets, 0-100; empty means 100. */
  broughtForwardBusinessUsePercent?: number;
  disposals?: readonly TaxDepreciationDisposal[];
  additionsUsedInPakistan?: readonly TaxDepreciationAddition[];
  additionsNew?: readonly TaxDepreciationAddition[];
}>;

export type TaxDepreciationInput = Readonly<{
  rows: readonly TaxDepreciationRowInput[];
}>;

export type TaxDepreciationRowResult = Readonly<{
  code: TaxDepreciationRowCode;
  label: string;
  ratePercent: number;
  writtenDownValueBroughtForward: number;
  /** WDV of the assets disposed of (taken out before the rate is applied). */
  deletion: number;
  /** Cost after any cap. */
  additionsUsedInPakistan: number;
  /** Cost after any cap. */
  additionsNew: number;
  initialAllowance: number;
  /** The deduction, after the business-use proportion. */
  depreciation: number;
  /** As if wholly used (s.22(6)). */
  writtenDownValueCarriedForward: number;
  disposalGain: number;
  disposalLoss: number;
}>;

export type TaxDepreciationResult = Readonly<{
  rows: readonly TaxDepreciationRowResult[];
  totals: Readonly<{
    initialAllowance: number;
    depreciation: number;
    /** Initial allowance + depreciation: what reduces business income. */
    deduction: number;
    disposalGain: number;
    disposalLoss: number;
    writtenDownValueCarriedForward: number;
  }>;
  /** Input that could not be used as given, in plain words. */
  issues: readonly string[];
}>;

const RULES = new Map(TAX_DEPRECIATION_ROWS.map((rule) => [rule.code, rule]));

export function getTaxDepreciationRow(
  code: string,
): TaxDepreciationRowRule | null {
  return RULES.get(code as TaxDepreciationRowCode) ?? null;
}

function amount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** Business-use share 0..1. Empty = 1. Invalid = 0 with an issue (never over-deduct). */
function share(
  value: unknown,
  where: string,
  issues: string[],
): number {
  if (value === undefined || value === null) return 1;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    issues.push(`${where}: business use must be between 0 and 100; nothing is deducted for it.`);
    return 0;
  }
  return value / 100;
}

function rupees(value: number): number {
  return Math.round(value);
}

export function computeTaxDepreciation(
  input: TaxDepreciationInput | null | undefined,
): TaxDepreciationResult {
  const issues: string[] = [];
  const results: TaxDepreciationRowResult[] = [];
  const seen = new Set<string>();

  for (const entry of input?.rows ?? []) {
    const rule = RULES.get(entry?.code);
    if (!rule) {
      issues.push(`Row ${String(entry?.code)} is not an IRIS Depreciation row; it was left out.`);
      continue;
    }
    if (seen.has(rule.code)) {
      issues.push(`Row ${rule.code} was given twice; only the first one is used.`);
      continue;
    }
    seen.add(rule.code);
    const rate = rule.ratePercent / 100;
    const where = `${rule.code} ${rule.label}`;

    // Brought forward, less what was disposed of (s.22(8): no depreciation).
    let broughtForward = amount(entry.writtenDownValueBroughtForward);
    if (broughtForward > 0 && !rule.acceptsBroughtForward) {
      issues.push(`${where}: this row takes only new additions; the brought-forward value was left out.`);
      broughtForward = 0;
    }
    let deletion = 0;
    let disposalGain = 0;
    let disposalLoss = 0;
    for (const disposal of entry.disposals ?? []) {
      const wdv = amount(disposal?.writtenDownValue);
      let consideration = amount(disposal?.consideration);
      const actualCost = amount(disposal?.actualCost);
      if (rule.costCapPerItem !== null && actualCost > rule.costCapPerItem)
        consideration = (consideration * rule.costCapPerItem) / actualCost; // s.22(10)
      deletion += wdv;
      const result = consideration - wdv;
      if (result > 0) disposalGain += result;
      else disposalLoss += -result;
    }
    if (deletion > broughtForward) {
      issues.push(`${where}: disposals (${rupees(deletion).toLocaleString("en-US")}) are more than the brought-forward value; only ${rupees(broughtForward).toLocaleString("en-US")} was taken out.`);
      deletion = broughtForward;
    }
    const base = broughtForward - deletion;
    const baseShare = share(entry.broughtForwardBusinessUsePercent, `${where} (brought forward)`, issues);

    // Additions: cost after the vehicle cap; ramps above the limit belong elsewhere.
    const takeCost = (item: TaxDepreciationAddition, kind: string): number | null => {
      const cost = amount(item?.cost);
      if (rule.maxCostPerItem !== null && cost > rule.maxCostPerItem) {
        issues.push(`${where}: a ${kind} addition of ${rupees(cost).toLocaleString("en-US")} is above Rs ${rule.maxCostPerItem.toLocaleString("en-US")}, so it does not belong in this row; it was left out.`);
        return null;
      }
      return rule.costCapPerItem !== null ? Math.min(cost, rule.costCapPerItem) : cost;
    };

    let usedCost = 0;
    let usedDeduction = 0;
    let usedWdv = 0;
    const used = entry.additionsUsedInPakistan ?? [];
    if (used.length && !rule.acceptsUsedAdditions) {
      issues.push(`${where}: plant or machinery used before in Pakistan gets no initial allowance (s.23(5)(c)); enter it under 33030105 instead. It was left out here.`);
    } else {
      for (const item of used) {
        const cost = takeCost(item, "used");
        if (cost === null) continue;
        usedCost += cost;
        usedDeduction += rate * cost * share(item?.businessUsePercent, `${where} (used addition)`, issues);
        usedWdv += cost;
      }
    }

    let newCost = 0;
    let initialAllowance = 0;
    let newDeduction = 0;
    let newWdv = 0;
    for (const item of entry.additionsNew ?? []) {
      const cost = takeCost(item, "new");
      if (cost === null) continue;
      const allowance = (cost * rule.initialAllowancePercent) / 100;
      newCost += cost;
      initialAllowance += allowance;
      newDeduction += rate * (cost - allowance) * share(item?.businessUsePercent, `${where} (new addition)`, issues);
      newWdv += cost - allowance;
    }

    const depreciation = rate * base * baseShare + usedDeduction + newDeduction;
    // s.22(6): the WDV falls by the full-rate depreciation whatever the use.
    const startWdv = base + usedWdv + newWdv;
    const carriedForward = startWdv - rate * startWdv;

    results.push({
      code: rule.code,
      label: rule.label,
      ratePercent: rule.ratePercent,
      writtenDownValueBroughtForward: rupees(broughtForward),
      deletion: rupees(deletion),
      additionsUsedInPakistan: rupees(usedCost),
      additionsNew: rupees(newCost),
      initialAllowance: rupees(initialAllowance),
      depreciation: rupees(depreciation),
      writtenDownValueCarriedForward: rupees(Math.max(0, carriedForward)),
      disposalGain: rupees(disposalGain),
      disposalLoss: rupees(disposalLoss),
    });
  }

  const sum = (key: keyof TaxDepreciationRowResult) =>
    results.reduce((total, item) => total + (item[key] as number), 0);
  const initialAllowance = sum("initialAllowance");
  const depreciation = sum("depreciation");
  return {
    rows: results,
    totals: {
      initialAllowance,
      depreciation,
      deduction: initialAllowance + depreciation,
      disposalGain: sum("disposalGain"),
      disposalLoss: sum("disposalLoss"),
      writtenDownValueCarriedForward: sum("writtenDownValueCarriedForward"),
    },
    issues,
  };
}
