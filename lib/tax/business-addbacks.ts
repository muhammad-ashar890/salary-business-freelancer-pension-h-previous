/**
 * DP-4 (Data Push, 16-Oct-2026): the IRIS 2.0 business tab
 * "Inadmissible/Admissible Deductions" -- add-backs by reason (s.21 and the
 * other reasons IRIS lists), the tax gain / loss on business assets sold
 * (s.22(8)) and unabsorbed tax depreciation of earlier years (s.57(4)).
 *
 * IRIS structure [PROVEN: captures 30 / 31 / 32 of 15-Oct-2026,
 * ~/iris-business-captures; live run of 15-Oct-2026 for 3212 and 3238]:
 * - Two header rows whose cells IRIS fills itself: 3239 "Inadmissible
 *   Deductions" and 3259 "Admissible Deductions".
 * - "+ Inadmissible" opens the picker "Add Inadmissible Deductions" (36
 *   cards); "+ Admissible" opens "Add Admissible Deductions" (10 cards). One
 *   checkbox card per row, ADD / Cancel, search "Search Amount
 *   Code/Description". A row already in the grid shows checked + disabled.
 * - An added row has id = the IRIS code and the card text as its description.
 *   Typable rows have the cells E E E D (Total Amount, Subject to Final Tax,
 *   Subject to Exemption editable; Subject to Normal Tax computed). The agent
 *   types Total Amount only, as it does for 3212 since the live run.
 * - Rows IRIS fills itself (D D D D or D E E D) are never typed: 3235-3238
 *   (accounting loss on sale / amortization / depreciation added back; live:
 *   3238 = 3088), 3245 / 3246 (accounting gains taken out), 3247 / 3248 (tax
 *   amortization / depreciation of the year; 3248 comes from the
 *   Depreciation tab).
 *
 * Which rows TaxRocket fills:
 * - Add-backs the taxpayer lists by reason (this module's "reasons"). They
 *   must add up to no more than "Expenses that are not allowed" on the
 *   Business profit step; equal = that manual item is gone, less = the rest
 *   stays manual.
 * - 3226 "Add Backs Tax Gain on Sale of Assets" / 3256 "Tax (Loss) on Sale of
 *   Assets": from the asset list (DP-1), never chosen by the taxpayer here.
 * - 3258 "Unabsorbed Tax Depreciation for Previous Years": from the loss
 *   rules (s.57(4)), never chosen by the taxpayer here.
 * Reasons that cannot apply to an individual's own business, or that need
 * figures TaxRocket does not collect yet, are not offered (see
 * ADD_BACK_UNSUPPORTED_TEXT).
 *
 * Law: ITO 2001 as amended to 31.07.2025 (TY2026): s.21 (deductions not
 * allowed; 21(j) is about an association of persons paying its member),
 * s.106A (foreign-controlled resident companies only), s.22(8), s.25
 * (pre-commencement expenditure), s.24 (intangibles), s.57(4).
 */

export const BUSINESS_ADD_BACKS_DETAIL_KEY = "businessAddBacks";

export type DeductionPicker = "inadmissible" | "admissible";

/** The two pickers of the tab (captures 30 / 31). */
export const IRIS_DEDUCTION_PICKERS = Object.freeze({
  inadmissible: Object.freeze({
    button: "+ Inadmissible",
    title: "Add Inadmissible Deductions",
    totalRow: "3239",
    totalLabel: "Inadmissible Deductions",
  }),
  admissible: Object.freeze({
    button: "+ Admissible",
    title: "Add Admissible Deductions",
    totalRow: "3259",
    totalLabel: "Admissible Deductions",
  }),
});

/** Tax gain on business assets sold (s.22(8)(a)), from the asset list. */
export const DISPOSAL_GAIN_ROW = "3226";
/** Tax loss on business assets sold (s.22(8)(b)), from the asset list. */
export const DISPOSAL_LOSS_ROW = "3256";
/** Unabsorbed tax depreciation of earlier years (s.57(4)). */
export const UNABSORBED_DEPRECIATION_ROW = "3258";

export type AddBackUnsupportedReason =
  | "aop_only"
  | "company_only"
  | "intangibles"
  | "pre_commencement"
  | "asset_schedule"
  | "computed";

export const ADD_BACK_UNSUPPORTED_TEXT: Record<AddBackUnsupportedReason, string> = {
  aop_only:
    "This reason is about an association of persons paying its own member (s.21(j)); it does not apply to your own business.",
  company_only:
    "This reason applies only to a foreign-controlled resident company (s.106A); it does not apply to your own business.",
  intangibles:
    "Intangibles need the IRIS Amortization tab, which TaxRocket does not fill yet. Enter it in FBR yourself.",
  pre_commencement:
    "Pre-commencement expenditure also needs its amortization (s.25) on the IRIS Amortization tab, which TaxRocket does not fill yet. Enter it in FBR yourself.",
  asset_schedule:
    "TaxRocket fills this row from your list of business assets (gain or loss on assets sold); do not list it here.",
  computed: "IRIS fills this row by itself.",
};

export type DeductionRowSpec = Readonly<{
  code: string;
  /** Exact IRIS text: the picker card and the added row's description. */
  label: string;
  picker: DeductionPicker;
  /** IRIS lets the taxpayer type Total Amount (cells E E E D). */
  typable: boolean;
  /** Set when the taxpayer cannot pick this reason on the Business profit step. */
  unsupported: AddBackUnsupportedReason | null;
}>;

// Card order and text as captured (30: 36 inadmissible cards, 31: 10
// admissible cards); typable from the cell pattern in capture 32.
const ROWS: readonly DeductionRowSpec[] = Object.freeze(
  (
    [
      ["3201", "inadmissible", "Add Backs u/s 29(2) Provision for Doubtful Debts", true, null],
      ["3202", "inadmissible", "Add Backs Provision for Obsolete Stocks / Stores / Spares / Fixed Assets", true, null],
      ["3203", "inadmissible", "Add Backs Provision for Diminution in Value of Investment", true, null],
      ["3204", "inadmissible", "Add Backs u/s 21(i) Provision for Reserves / Funds / Amount carried to Reserves / Funds or Capitalized", true, null],
      ["3205", "inadmissible", "Add Backs u/s 21(a) Cess / Rate / Tax levied on Profits / Gains", true, null],
      ["3206", "inadmissible", "Add Backs u/s 21(b) Amount of Tax Deducted at Source", true, null],
      ["3207", "inadmissible", "Add Backs u/s 21(c) Payments liable to Deduction of Tax at Source but Tax not Deducted / Paid", true, null],
      ["3208", "inadmissible", "Add Backs u/s 21(d) Entertainment Expenditure above prescribed limit", true, null],
      ["3209", "inadmissible", "Add Backs u/s 21(e) Contributions to Unrecognized / Unapproved Funds", true, null],
      ["320901", "inadmissible", "Add Backs u/s 21(ea) Excess of 50% of Contribution to an Approved gratuity fund / Pension Fund / Superannuation Fund", true, null],
      ["3210", "inadmissible", "Add Backs u/s 21(f) Contributions to Funds not under effective arrangement for deduction of Tax at source", true, null],
      ["3211", "inadmissible", "Add Backs u/s 21(g) Fine / Penalty for violation of any law / rule / regulation", true, null],
      ["3212", "inadmissible", "Add Backs u/s 21(h) Personal Expenditure", true, null],
      ["3213", "inadmissible", "Add Backs u/s 21(j) Profit on Debt / brokerage / Commission / salary / remuneration Paid by an AOP to its member", true, "aop_only"],
      ["3215", "inadmissible", "Add Backs u/s 21(l) Expenditure under a single Account head exceeding prescribed amount not paid through prescribed mode", true, null],
      ["3216", "inadmissible", "Add Backs u/s 21(m) Salary exceeding prescribed amount not paid through prescribed mode", true, null],
      ["3217", "inadmissible", "Add Backs u/s 21(n) Capital Expenditure", true, null],
      ["3218", "inadmissible", "Add Backs u/s 67(1) Expenditure attributable to Non-Business Income", true, null],
      ["3219", "inadmissible", "Add Backs u/s 34(5) Liabilities allowed Previously as deduction not Paid within three Years", true, null],
      ["3220", "inadmissible", "Add Backs u/s 28(1)(b) Lease Rental not admissible", true, null],
      ["3224", "inadmissible", "Add Backs u/s 21(o) Sales promotion, advertisement and publicity expenses of pharmaceutical manufacturers exceeding prescribed limit", true, null],
      ["3225", "inadmissible", "Add Backs Tax Gain on Sale of Intangibles", true, "intangibles"],
      ["3226", "inadmissible", "Add Backs Tax Gain on Sale of Assets", true, "asset_schedule"],
      ["3227", "inadmissible", "Add backs u/s 21(ca) Commission in excess of 0.2% of gross amount of supplies to a person not appearing in ATL in Third Schedule of Sales Tax Act", true, null],
      ["322901", "inadmissible", "Add Backs u/s 28(1)(b) Lease Rental not admissible on account of cost of Passenger transport vehicle exceeding 2.5 Million Rupees", true, null],
      ["322902", "inadmissible", "Add Backs u/s 21(p) Utility Bills exceeding prescribed amount not paid through prescribed mode", true, null],
      ["322903", "inadmissible", "Add Backs u/s 21(q) Expenditure attributable to sale to person required to be registered under Sales Tax but not registered", true, null],
      ["322904", "inadmissible", "Deduction on profit on debit inadmissible u/s 106A", true, "company_only"],
      ["322905", "inadmissible", "Add Backs u/s 21(r) Expenditure Attributable to sales for non-integration of business with FBR system", true, null],
      ["3230", "inadmissible", "Add Backs Pre-Commencement Expenditure / Deferred Cost", true, "pre_commencement"],
      ["3231", "inadmissible", "7.50% of sales dealers of products listed in the 3rd Sch to the Sales Tax Act, 1990 who are not registered under the STA 1990 and not appearing in the active taxpayers\u2019 list under the ITO 2001", true, null],
      ["3234", "inadmissible", "Other Inadmissible Deductions", true, null],
      ["3235", "inadmissible", "Add Backs Accounting (Loss) on Sale of Intangibles", false, "computed"],
      ["3236", "inadmissible", "Add Backs Accounting (Loss) on Sale of Assets", false, "computed"],
      ["3237", "inadmissible", "Add Backs Accounting Amortization", false, "computed"],
      ["3238", "inadmissible", "Add Backs Accounting Depreciation", false, "computed"],
      ["3245", "admissible", "Accounting Gain on Sale of Intangibles", false, "computed"],
      ["3246", "admissible", "Accounting Gain on Sale of Assets", false, "computed"],
      ["3247", "admissible", "Tax Amortization for Current Year", false, "computed"],
      ["3248", "admissible", "Tax Depreciation / Initial Allowance for Current Year", false, "computed"],
      ["3250", "admissible", "Pre-Commencement Expenditure / Deferred Cost", true, "pre_commencement"],
      ["3254", "admissible", "Other Admissible Deductions", true, null],
      ["3255", "admissible", "Tax (Loss) on Sale of Intangibles", true, "intangibles"],
      ["3256", "admissible", "Tax (Loss) on Sale of Assets", true, "asset_schedule"],
      ["3257", "admissible", "Unabsorbed Tax Amortization for Previous Years", true, "intangibles"],
      ["3258", "admissible", "Unabsorbed Tax Depreciation for Previous Years", true, null],
    ] as const
  ).map(([code, picker, label, typable, unsupported]) =>
    Object.freeze({ code, picker, label, typable, unsupported }),
  ),
);

export function allDeductionRows(): readonly DeductionRowSpec[] {
  return ROWS;
}

export function findDeductionRow(code: string): DeductionRowSpec | null {
  return ROWS.find((row) => row.code === String(code ?? "").trim()) ?? null;
}

/**
 * Reasons the taxpayer can list on the Business profit step: typable rows of
 * the "+ Inadmissible" picker that apply to an individual's own business and
 * need no other IRIS tab. IRIS order.
 */
export function addBackReasons(): readonly DeductionRowSpec[] {
  return ROWS.filter((row) => row.picker === "inadmissible" && row.typable && row.unsupported === null);
}

export function isSelectableAddBack(code: string): boolean {
  return addBackReasons().some((row) => row.code === String(code ?? "").trim());
}

const MAX_ROWS = addBackReasons().length;

/** What the wizard stores; a line may be incomplete while it is being typed. */
export type BusinessAddBack = {
  code: string;
  amount?: number;
};

export type AddBacksPlan = {
  version: "add-backs-v1";
  entries: { code: string; label: string; amount: number }[];
  total: number;
};

const money = (value: number) => Math.round(value).toLocaleString("en-PK");

/**
 * Shape check for the stored list. Empty lines are dropped; anything
 * malformed is an error (never silently "fixed").
 */
export function sanitizeBusinessAddBacks(
  value: unknown,
): { ok: true; rows: BusinessAddBack[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, rows: [] };
  if (!Array.isArray(value))
    return { ok: false, error: "Expenses that are not allowed, by reason, must be a list." };
  if (value.length > MAX_ROWS)
    return { ok: false, error: `List at most ${MAX_ROWS} reasons (each IRIS reason once).` };
  const rows: BusinessAddBack[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return { ok: false, error: "Each reason line must be an object." };
    const record = entry as Record<string, unknown>;
    if (record.code !== undefined && record.code !== null && typeof record.code !== "string")
      return { ok: false, error: "The IRIS reason code must be text." };
    const code = String(record.code ?? "").trim();
    if (code && !/^\d{4,6}$/.test(code))
      return { ok: false, error: `"${code}" is not an IRIS reason code.` };
    const raw = record.amount;
    let amount: number | undefined;
    if (raw !== undefined && raw !== null && raw !== "") {
      const parsed = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0)
        return { ok: false, error: "The amount of a reason must be a positive number." };
      if (!Number.isInteger(parsed))
        return { ok: false, error: "The amount of a reason must be in whole rupees." };
      amount = parsed;
    }
    if (!code && amount === undefined) continue;
    rows.push(amount === undefined ? { code } : { code, amount });
  }
  return { ok: true, rows };
}

/** Plain-language problems; empty means every line can be typed by the agent. */
export function validateBusinessAddBacks(rows: readonly BusinessAddBack[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const spec = row.code ? findDeductionRow(row.code) : null;
    const where = spec ? `${spec.label} (${spec.code})` : `Reason line ${index + 1}`;
    if (!row.code) {
      problems.push(`${where}: choose the IRIS reason.`);
      return;
    }
    if (!spec || spec.picker !== "inadmissible") {
      problems.push(`${where}: ${row.code} is not an IRIS add-back reason.`);
      return;
    }
    if (spec.unsupported) {
      problems.push(`${where}: ${ADD_BACK_UNSUPPORTED_TEXT[spec.unsupported]} Leave it out of this list.`);
      return;
    }
    if (seen.has(spec.code))
      problems.push(`${where} is listed twice. Add the amounts together in one line.`);
    seen.add(spec.code);
    if (row.amount === undefined) problems.push(`${where}: enter the amount.`);
    else if (row.amount <= 0) problems.push(`${where}: the amount must be more than zero.`);
  });
  return problems;
}

/** Sum over the listed lines (complete or not). */
export function totalAddBacks(rows: readonly BusinessAddBack[]): number {
  return rows.reduce((sum, row) => sum + (row.amount ?? 0), 0);
}

/**
 * The listed reasons against "Expenses that are not allowed" on the Business
 * profit step. More than that total is a data problem; less leaves the rest
 * as a manual item.
 */
export function compareWithInadmissibleTotal(
  rows: readonly BusinessAddBack[],
  total: number | null,
): { problems: string[]; remainder: number } {
  if (!rows.length) return { problems: [], remainder: total ?? 0 };
  const listed = totalAddBacks(rows);
  if (total === null)
    return {
      problems: [
        "Expenses that are not allowed are listed by reason, but \"Expenses that are not allowed\" is empty. Enter the total there first.",
      ],
      remainder: 0,
    };
  if (listed > total)
    return {
      problems: [
        `The reasons listed add up to Rs ${money(listed)}, which is more than "Expenses that are not allowed" (Rs ${money(total)}). Correct one of them.`,
      ],
      remainder: 0,
    };
  return { problems: [], remainder: total - listed };
}

/**
 * Packet entries for a complete, validated list, in IRIS order. Callers
 * validate first; this refuses (throws) rather than building a partial plan.
 */
export function buildAddBacksPlan(rows: readonly BusinessAddBack[]): AddBacksPlan {
  const problems = validateBusinessAddBacks(rows);
  if (problems.length) throw new Error(problems.join(" "));
  const order = (code: string) => ROWS.findIndex((row) => row.code === code);
  const entries = [...rows]
    .sort((a, b) => order(a.code) - order(b.code))
    .map((row) => {
      const spec = findDeductionRow(row.code) as DeductionRowSpec;
      return { code: spec.code, label: spec.label, amount: row.amount as number };
    });
  return {
    version: "add-backs-v1",
    entries,
    total: entries.reduce((sum, entry) => sum + entry.amount, 0),
  };
}
