// File: lib/tax/business-iris-expectations.ts
//
// Phase 2 (fix47): the totals IRIS 2.0 should calculate after the desktop
// agent types the queued business figures. The agent reads IRIS's computed
// rows at the end of a run and compares them with these numbers, so a figure
// in the wrong row, a row IRIS did not keep, or an IRIS rule TaxRocket does
// not know shows up as a difference instead of passing silently.
//
// Evidence. Every formula was read off a live IRIS 2.0 return on 15-Oct-2026
// (job cmv9aoyuy001udgqzwqbey1hi): the agent typed 25 figures and IRIS showed
//   3029 6,000,000   3030 2,150,000   3100 3,850,000   3129 120,000
//   3199 1,000,000   3200 2,970,000   3238 150,000     3239 230,000
//   3270 (normal) 3,200,000           3000 3,200,000
//   9000 (normal) 3,150,000           9100 3,150,000
//   920000 635,000   9200 635,000     3349 1,300,000   3399 7,300,000
// A row whose formula uses a code that was not part of that run is marked
// `proven: false`: a difference there reads "not yet confirmed live", never
// "TaxRocket is wrong".
//
// Only TYPED figures count. Manual items (land, building, bank, vehicle, tax
// depreciation 3248, business withholding) are not in IRIS until the taxpayer
// enters them, so they are not in these numbers either. The app's full
// estimate (which includes them) is reported separately.

import type { PortalFieldMapEntry } from "./portal-field-map";
import { divisionIClause1Tax, section4CSuperTax } from "./tax-calculation";
import {
  DISPOSAL_GAIN_ROW,
  DISPOSAL_LOSS_ROW,
  UNABSORBED_DEPRECIATION_ROW,
  addBackReasons,
} from "./business-addbacks";

export const IRIS_EXPECTATIONS_VERSION = "iris-expect-v1";

/** Which IRIS column carries the figure: "Total Amount/Income" or "Subject to Normal Tax". */
export type IrisColumn = "total" | "normal";

export type ExpectedIrisRow = {
  code: string;
  label: string;
  column: IrisColumn;
  expected: number;
  formula: string;
  /** True when every code in the formula was part of the live run above. */
  proven: boolean;
};

export type ExpectedIrisTotals = {
  version: typeof IRIS_EXPECTATIONS_VERSION;
  basis: "typed_business_fields";
  rows: ExpectedIrisRow[];
  skipped: { code: string; reason: string }[];
  /** Phase 3b: what the agent types on the Computations tab (4AB / 4C). */
  computations?: ComputationsPlan;
};

/**
 * Phase 3b (fix51): the two Computations rows IRIS leaves to the taxpayer
 * (input enabled in the "Total Income" column; live census 15-Oct-2026).
 *   TYPE  the agent types `value`, after checking IRIS's own base figures;
 *   NONE  TaxRocket expects nothing there, so the row stays empty;
 *   USER  TaxRocket cannot work it out: the agent only shows `message`
 *         when IRIS's own figures cross the threshold.
 */
export type ComputationsAction = "TYPE" | "NONE" | "USER";
export type ComputationsEntry = {
  code: "923184" | "9231822";
  label: string;
  action: ComputationsAction;
  /** Rounded rupees; 0 unless action is TYPE. */
  value: number;
  ratePercent: number | null;
  basis: string;
  /** Shown to the taxpayer when the agent leaves the row to them. */
  message: string;
};
/**
 * Phase 3c (fix52): the Section 113 turnover row. "+ Turnover" on row 999905
 * opens the picker "Add Turnover Tax u/s 113" (capture 54); the row it adds
 * has cells E E E D (captures 57-60). The agent types the turnover in
 * "Total Income" only.
 *   TYPE  add the row (or reuse it) and type `value`;
 *   USER  TaxRocket cannot type it: the agent only shows `message`.
 */
export type TurnoverEntry = {
  code: string;
  /** The row text in IRIS, the same as the picker card text. */
  label: string;
  action: "TYPE" | "USER";
  /** Turnover in rounded rupees; 0 unless action is TYPE. */
  value: number;
  ratePercent: number;
  /** Rounded rupees: ratePercent of the turnover. */
  minimumTax: number;
  basis: string;
  message: string;
};
export type ComputationsPlan = {
  version: "computations-v1";
  /** IRIS 9100 / 920000 TaxRocket expects (null when not worked out). */
  expectedTaxableIncome: number | null;
  expectedNormalTax: number | null;
  /** IRIS 3000 "Total Income" column TaxRocket expects for the 4C base. */
  expectedBusinessIncome: number | null;
  surcharge: ComputationsEntry;
  superTax: ComputationsEntry;
  /** Phase 3c: present only when Section 113 reaches the return. */
  turnover?: TurnoverEntry;
  /**
   * Phase 3c: which tax TaxRocket expects IRIS to charge. "unknown" when
   * Normal Tax (920000) is not worked out for this return.
   */
  minimumTaxRegime?: "normal" | "minimum" | "unknown";
};

/** Phase 3c: what the packet knows about Section 113 (lib/tax/minimum-tax-113.ts). */
export type MinimumTaxPacketInput = {
  turnover: number;
  ratePercent: number;
  irisCode: string;
  irisLabel: string;
  /** False while sales are not confirmed as excluding Sales Tax / FED. */
  turnoverTypable: boolean;
};

export const SURCHARGE_USER_MESSAGE =
  "Surcharge (row 923184): TaxRocket could not work out this figure for your return, so please type it yourself in IRIS if Taxable Income (9100) is above PKR 10 million: 10% of Normal Tax (920000), or 9% only if your salary is more than 75% of taxable income.";
export const SURCHARGE_MINIMUM_TAX_MESSAGE =
  "Surcharge (row 923184): your minimum tax on turnover (Section 113) is higher than Normal Tax plus surcharge, so the minimum tax is paid instead of both (s.113(2)(b)) and TaxRocket left this row empty. If your tax adviser reads the law differently and you want to put the surcharge, type it yourself in IRIS: 10% of Normal Tax (920000).";
export const SURCHARGE_WITH_MINIMUM_TAX_USER_MESSAGE =
  "Surcharge (row 923184): TaxRocket could not work out this figure for your return. If Taxable Income (9100) is above PKR 10 million it is 10% of Normal Tax (920000), or 9% only if your salary is more than 75% of taxable income. Leave it empty if your minimum tax on turnover (Section 113) is higher than Normal Tax plus that surcharge: the minimum tax is then paid instead.";
export const turnoverUserMessage = (label: string) =>
  `Minimum tax (Section 113): TaxRocket did not type your turnover because your sales are not confirmed as excluding Sales Tax and Federal Excise. On the Computations tab press "+ Turnover", tick "${label}" and type your turnover (sales without Sales Tax / FED plus other business receipts) in Total Income.`;
export const SUPER_TAX_USER_MESSAGE =
  "Super tax (row 9231822): TaxRocket could not work out this figure for your return, so please type it yourself in IRIS if your income for super tax is above PKR 150 million (1% to 10% of the whole income, Division IIB).";

/** Codes whose part in an IRIS total was seen on the live run of 15-Oct-2026. */
const LIVE_PROVEN_CODES = new Set([
  "3009", "3039", "3059", "3083", "3088", "3099", "3128",
  "3151", "3154", "3155", "3158", "3168", "3180", "3212", "327025",
  "3303", "3312", "3315", "3319", "3321", "3348",
  "3352", "3371", "3384", "3398",
]);

/** IRIS row labels (live census, 15-Oct-2026). */
const LABELS: Record<string, string> = {
  "3029": "Net Revenue",
  "3030": "Cost of Sales / Services",
  "3100": "Gross Profit / (Loss)",
  "3129": "Other Revenues",
  "3199": "Management, Administrative, Selling & Financial Expenses",
  "3200": "Accounting Profit / (Loss)",
  "3238": "Add Backs Accounting Depreciation",
  "3239": "Inadmissible Deductions",
  "3259": "Admissible Deductions",
  "3270": "Income / (Loss) from Business before adjustment of admissible depreciation",
  "3000": "Income / (Loss) from Business",
  "9000": "Total Income",
  "9100": "Taxable Income",
  "920000": "Normal Tax",
  "923184": "Surcharge on high earning person u/s 4AB",
  "9231822": "Tax on High Earning Persons u/s 4C",
  "9200": "Tax Chargeable",
  // Phase 3c: rows "+ Turnover" adds (captures 57-60).
  "923152": "Turnover / Tax Chargeable u/s 113 @0.25%",
  "923206": "Turnover / Tax Chargeable u/s 113 @ 0.50%",
  "923168": "Turnover / Tax Chargeable u/s 113 @0.75%",
  "923161": "Turnover / Tax Chargeable u/s 113 @ 1.25%",
  "3349": "Total Assets",
  "3399": "Total Equity / Liabilities",
};

// Section names exactly as the packet carries them (`spec.tab` in the
// business contract).
const TRADING = "Manufacturing/ Trading Items";
const OTHER_REVENUES = "Other Revenues";
const ADMIN = "Admin, Selling & Financial Expenses";
const DEDUCTIONS = "Inadmissible/Admissible Deductions";
const ADJUSTMENTS = "Adjustments";
const BALANCE_SHEET = "Balance Sheet";

/**
 * Rows of the Inadmissible/Admissible Deductions tab the packet can queue
 * (DP-4, lib/tax/business-addbacks.ts): add-back reasons and the tax gain on
 * assets sold count in 3239; the tax loss on assets sold and unabsorbed
 * depreciation of earlier years in 3259. Any other code there is unknown.
 */
const INADMISSIBLE_CODES = new Set([
  ...addBackReasons().map((row) => row.code),
  DISPOSAL_GAIN_ROW,
]);
const ADMISSIBLE_CODES = new Set([DISPOSAL_LOSS_ROW, UNABSORBED_DEPRECIATION_ROW]);
/**
 * Without a Section 113 plan from the packet (an older caller), a turnover
 * at this level stops the 920000 / 9200 check.
 */
const SECTION_113_TURNOVER = 100_000_000;
/** Above this taxable income the Section 4AB surcharge applies (not seen live). */
const SECTION_4AB_THRESHOLD = 10_000_000;

const MINUS = "\u2212";

export function buildExpectedIrisTotals(input: {
  fields: PortalFieldMapEntry[];
  incomeSources: string[];
  assetCodes: string[];
  liabilityCodes: string[];
  /**
   * DP-1: Initial Allowance + Depreciation the agent's Depreciation-tab entries
   * should produce (TaxRocket's own figure; IRIS computes 324802 -> 3248).
   */
  depreciationDeduction?: number;
  /**
   * DP-3: how many sections the agent types on the business Tax Deduction tab.
   * Adjustable tax is a credit against the tax, not part of Tax Chargeable;
   * minimum tax makes IRIS add a difference to Tax Chargeable by itself.
   */
  taxDeductionSections?: { adjustable: number; minimum: number };
  /** Phase 3c: Section 113 reaches the return (absent or null: it does not). */
  minimumTax?: MinimumTaxPacketInput | null;
}): ExpectedIrisTotals {
  const rows: ExpectedIrisRow[] = [];
  const skipped: { code: string; reason: string }[] = [];
  const amounts = new Map<string, number>();
  const sectionCodes = new Map<string, string[]>();
  for (const field of input.fields || []) {
    const code = String(field.irisCode);
    const amount = Math.round(Number(field.ourAmount) || 0);
    amounts.set(code, (amounts.get(code) ?? 0) + amount);
    const list = sectionCodes.get(field.section) ?? [];
    if (!list.includes(code)) list.push(code);
    sectionCodes.set(field.section, list);
  }
  const codesIn = (section: string) => sectionCodes.get(section) ?? [];
  const sum = (codes: string[]) =>
    codes.reduce((total, code) => total + (amounts.get(code) ?? 0), 0);
  const proven = (codes: string[]) =>
    codes.every((code) => LIVE_PROVEN_CODES.has(code));
  const join = (plus: string[], minus: string[] = []) => {
    const parts = [
      ...plus,
      ...minus.map((code) => `${MINUS} ${code}`),
    ];
    if (!parts.length) return "no typed rows (0)";
    return parts.join(" + ").replaceAll(`+ ${MINUS}`, MINUS);
  };
  const push = (
    code: string,
    column: IrisColumn,
    expected: number,
    formula: string,
    isProven: boolean,
  ) =>
    rows.push({
      code,
      label: LABELS[code] ?? code,
      column,
      expected: Math.round(expected),
      formula,
      proven: isProven,
    });
  const skip = (codes: string[], reason: string) => {
    for (const code of codes) skipped.push({ code, reason });
  };

  // Manufacturing/ Trading Items: 3009 Gross Revenue (+), 3019 selling
  // deductions (-); cost rows 3031-3098 (+) and 3099 Closing Stock (-).
  const trading = codesIn(TRADING);
  const revenuePlus = trading.filter((code) => code === "3009");
  const revenueMinus = trading.filter((code) => code === "3019");
  const costPlus = trading.filter((code) => {
    const n = Number(code);
    return n > 3030 && n < 3099;
  });
  const costMinus = trading.filter((code) => code === "3099");
  const unknownTrading = trading.filter(
    (code) =>
      ![...revenuePlus, ...revenueMinus, ...costPlus, ...costMinus].includes(code),
  );
  const otherRevenues = codesIn(OTHER_REVENUES);
  const unknownOther = otherRevenues.filter((code) => {
    const n = Number(code);
    return !(n > 3100 && n < 3129);
  });
  const admin = codesIn(ADMIN);
  const unknownAdmin = admin.filter((code) => {
    const n = Number(code);
    return !(n > 3130 && n < 3199);
  });
  const deductions = codesIn(DEDUCTIONS);
  const inadmissible = deductions.filter((code) => INADMISSIBLE_CODES.has(code));
  const admissible = deductions.filter((code) => ADMISSIBLE_CODES.has(code));
  const unknownDeductions = deductions.filter(
    (code) => !INADMISSIBLE_CODES.has(code) && !ADMISSIBLE_CODES.has(code),
  );
  const adjustments = codesIn(ADJUSTMENTS);
  const lossCodes = adjustments.filter((code) => /^3270\d{2}$/.test(code));
  const unknownAdjustments = adjustments.filter((code) => !lossCodes.includes(code));

  const profitChain = ["3029", "3030", "3100", "3200", "3270", "3000"];
  const incomeChain = ["9000", "9100", "920000", "9200"];
  let profitKnown = true;

  if (unknownTrading.length) {
    profitKnown = false;
    skip(
      profitChain,
      `trading code(s) ${unknownTrading.join(", ")} have no proven role in the IRIS totals`,
    );
  } else {
    push("3029", "total", sum(revenuePlus) - sum(revenueMinus), join(revenuePlus, revenueMinus), proven([...revenuePlus, ...revenueMinus]));
    push("3030", "total", sum(costPlus) - sum(costMinus), join(costPlus, costMinus), proven([...costPlus, ...costMinus]));
    push(
      "3100",
      "total",
      sum(revenuePlus) - sum(revenueMinus) - (sum(costPlus) - sum(costMinus)),
      `3029 ${MINUS} 3030`,
      proven(trading),
    );
  }
  if (unknownOther.length) {
    profitKnown = false;
    skip(["3129", ...profitChain.slice(3)], `other revenue code(s) ${unknownOther.join(", ")} have no proven role`);
  } else {
    push("3129", "total", sum(otherRevenues), join(otherRevenues), proven(otherRevenues));
  }
  if (unknownAdmin.length) {
    profitKnown = false;
    skip(["3199", ...profitChain.slice(3)], `admin code(s) ${unknownAdmin.join(", ")} have no proven role`);
  } else {
    push("3199", "total", sum(admin), join(admin), proven(admin));
  }

  const accountingProfit =
    sum(revenuePlus) - sum(revenueMinus) - (sum(costPlus) - sum(costMinus)) +
    sum(otherRevenues) - sum(admin);
  if (profitKnown) {
    push(
      "3200",
      "total",
      accountingProfit,
      `3100 + 3129 ${MINUS} 3199`,
      proven([...trading, ...otherRevenues, ...admin]),
    );
  }

  // IRIS adds 3238 by itself when 3088 Accounting Depreciation is typed
  // (seen live: 3238 = 3088 = 150,000, shown checked+disabled in the picker).
  const accountingDepreciation = amounts.get("3088") ?? 0;
  const addBack3238 = accountingDepreciation > 0 ? accountingDepreciation : 0;
  if (addBack3238 > 0) push("3238", "total", addBack3238, "= 3088 (IRIS adds it by itself)", true);

  // DP-1: tax depreciation typed on the Depreciation tab (IRIS computes
  // 324802 -> 3248, an admissible row it adds by itself).
  const depreciationDeduction = Math.max(0, Math.round(Number(input.depreciationDeduction) || 0));
  // DP-4: IRIS takes the accounting gain on assets / intangibles sold (Other
  // Revenues 3116 / 3115) out again as admissible rows 3246 / 3245 -- cells
  // D D D D in capture 32, the same pattern as 3238 = 3088. Not yet seen live.
  const accountingGains = (amounts.get("3116") ?? 0) + (amounts.get("3115") ?? 0);
  const unabsorbed = admissible.includes(UNABSORBED_DEPRECIATION_ROW)
    ? amounts.get(UNABSORBED_DEPRECIATION_ROW) ?? 0
    : 0;
  // Admissible rows that are not depreciation: they reduce 3270 itself.
  const admissibleOther = sum(admissible) - unabsorbed + accountingGains;
  const admissibleProven =
    admissible.length === 0 && depreciationDeduction === 0 && accountingGains === 0;

  let incomeKnown = profitKnown;
  if (unknownDeductions.length) {
    incomeKnown = false;
    skip(
      ["3239", "3259", "3270", "3000", ...incomeChain],
      `deduction code(s) ${unknownDeductions.join(", ")} are not known as inadmissible or admissible`,
    );
  } else {
    push(
      "3239",
      "total",
      sum(inadmissible) + addBack3238,
      addBack3238 > 0 ? `${join(inadmissible)} + 3238`.replace("no typed rows (0) + ", "") : join(inadmissible),
      proven(inadmissible),
    );
    const admissibleParts = [
      ...admissible,
      ...(depreciationDeduction > 0 ? ["3248"] : []),
      ...((amounts.get("3116") ?? 0) > 0 ? ["3246 (= 3116)"] : []),
      ...((amounts.get("3115") ?? 0) > 0 ? ["3245 (= 3115)"] : []),
    ];
    push(
      "3259",
      "total",
      sum(admissible) + depreciationDeduction + accountingGains,
      admissibleParts.length
        ? admissibleParts.join(" + ")
        : "no admissible deduction is typed by the agent (0)",
      admissibleProven,
    );
  }

  const businessIncome = accountingProfit + sum(inadmissible) + addBack3238 - admissibleOther;
  // IRIS's row 3270 is "before adjustment of admissible depreciation", so
  // 3000 = 3270 - 3248 - 3258 (depreciation of the year and unabsorbed
  // depreciation of earlier years). Not yet seen live, hence proven: false
  // (a difference reads "not yet confirmed", never "TaxRocket is wrong").
  const incomeAfterDepreciation = businessIncome - depreciationDeduction - unabsorbed;
  if (incomeKnown) {
    const chainProven =
      proven([...trading, ...otherRevenues, ...admin, ...inadmissible]) &&
      admissible.length === 0 &&
      accountingGains === 0;
    const depreciationRows = [
      ...(depreciationDeduction > 0 ? ["3248"] : []),
      ...(unabsorbed > 0 ? [UNABSORBED_DEPRECIATION_ROW] : []),
    ];
    push(
      "3270",
      "normal",
      businessIncome,
      depreciationRows.length
        ? `3200 + 3239 ${MINUS} (3259 ${MINUS} ${depreciationRows.join(` ${MINUS} `)})`
        : `3200 + 3239 ${MINUS} 3259`,
      chainProven,
    );
    if (depreciationDeduction > 0)
      push("3248", "total", depreciationDeduction, "Depreciation tab total 324802 (Initial Allowance + Depreciation)", false);
    if (depreciationRows.length) {
      push("3000", "total", incomeAfterDepreciation, `3270 ${MINUS} ${depreciationRows.join(` ${MINUS} `)}`, false);
    } else {
      push("3000", "total", businessIncome, `3270 (no Depreciation/Amortization tab entry by the agent)`, chainProven);
    }
  }

  // Phase 3b: Computations-tab plan. Starts as "the taxpayer types it" and is
  // replaced below only where TaxRocket can work the figure out.
  const userEntry = (code: "923184" | "9231822"): ComputationsEntry => ({
    code,
    label: LABELS[code],
    action: "USER",
    value: 0,
    ratePercent: null,
    basis: "not worked out by TaxRocket for this return",
    message: code === "923184" ? SURCHARGE_USER_MESSAGE : SUPER_TAX_USER_MESSAGE,
  });
  const computations: ComputationsPlan = {
    version: "computations-v1",
    expectedTaxableIncome: null,
    expectedNormalTax: null,
    expectedBusinessIncome: null,
    surcharge: userEntry("923184"),
    superTax: userEntry("9231822"),
  };

  // Phase 3c: the Section 113 turnover row. It is planned whenever s.113
  // reaches the return (profit or loss, any income heads): IRIS compares the
  // minimum tax with the normal tax itself. Until Normal Tax is worked out
  // below, the surcharge message also explains the minimum-tax case.
  const minimumTaxInput = input.minimumTax ?? null;
  let minimumTaxValue = 0;
  if (minimumTaxInput) {
    const turnover = Math.max(0, Math.round(Number(minimumTaxInput.turnover) || 0));
    minimumTaxValue = Math.round((turnover * minimumTaxInput.ratePercent) / 100);
    const typable = minimumTaxInput.turnoverTypable && turnover > 0;
    computations.turnover = {
      code: minimumTaxInput.irisCode,
      label: minimumTaxInput.irisLabel,
      action: typable ? "TYPE" : "USER",
      value: typable ? turnover : 0,
      ratePercent: minimumTaxInput.ratePercent,
      minimumTax: minimumTaxValue,
      basis: `turnover ${turnover.toLocaleString("en-US")} (sales without Sales Tax / FED plus other business receipts) x ${minimumTaxInput.ratePercent}% = minimum tax ${minimumTaxValue.toLocaleString("en-US")} (Section 113, Division IX)`,
      message: typable ? "" : turnoverUserMessage(minimumTaxInput.irisLabel),
    };
    computations.minimumTaxRegime = "unknown";
    computations.surcharge = { ...computations.surcharge, message: SURCHARGE_WITH_MINIMUM_TAX_USER_MESSAGE };
    if (typable)
      push(
        minimumTaxInput.irisCode,
        "normal",
        turnover,
        "= Total Income typed by the agent (Subject to Final Tax and Subject to Exemption left empty)",
        false,
      );
  }

  // Computations. Only a business-only return: any other income head joins
  // Total Income and is outside this packet.
  const sources = (input.incomeSources || []).map((source) => String(source).toLowerCase());
  const businessOnly = sources.length === 1 && sources[0] === "business";
  const loss = sum(lossCodes);
  const grossRevenue = amounts.get("3009") ?? 0;
  if (!incomeKnown) {
    skip(incomeChain, "business income could not be computed from the typed rows (see the reasons above)");
  } else if (unknownAdjustments.length) {
    skip(incomeChain, `adjustment code(s) ${unknownAdjustments.join(", ")} have no proven role`);
  } else if (!businessOnly) {
    skip(incomeChain, "other income heads are part of this return; Total Income is not business-only");
  } else if (incomeAfterDepreciation <= 0) {
    skip(incomeChain, "business income is not positive; IRIS loss handling has not been seen live");
  } else if (loss > incomeAfterDepreciation) {
    skip(incomeChain, "brought-forward loss is larger than business income; the IRIS set-off cap has not been seen live");
  } else {
    const taxable = incomeAfterDepreciation - loss;
    // Section 4C(2)(ii): taxable income other than brought-forward
    // depreciation and losses, i.e. business income before the loss set-off
    // and before unabsorbed depreciation of earlier years (3258, DP-4 item 3).
    // A business-only return has no clause (i) or imputable income.
    const superTaxBase = incomeAfterDepreciation + unabsorbed;
    const superTax = section4CSuperTax(superTaxBase);
    computations.expectedBusinessIncome = incomeAfterDepreciation;
    computations.superTax =
      superTax.ratePercent > 0
        ? {
            code: "9231822",
            label: LABELS["9231822"],
            action: "TYPE",
            value: Math.round(superTax.tax),
            ratePercent: superTax.ratePercent,
            basis: unabsorbed > 0
              ? `${superTax.ratePercent}% of the whole business income ${superTaxBase.toLocaleString("en-US")} (3000 + 3258: before brought-forward losses and unabsorbed depreciation, s.4C(2)(ii); Division IIB, tax year 2026)`
              : `${superTax.ratePercent}% of the whole business income ${incomeAfterDepreciation.toLocaleString("en-US")} (3000, before brought-forward losses; Division IIB, tax year 2026)`,
            message: "",
          }
        : {
            code: "9231822",
            label: LABELS["9231822"],
            action: "NONE",
            value: 0,
            ratePercent: 0,
            basis: "income for super tax is PKR 150 million or less (0%)",
            message: "",
          };
    const lossProven = proven(lossCodes);
    const chainProven =
      proven([...trading, ...otherRevenues, ...admin, ...inadmissible]) &&
      lossProven &&
      admissibleProven;
    push("9000", "normal", taxable, lossCodes.length ? `3000 ${MINUS} ${lossCodes.join(` ${MINUS} `)}` : "= 3000", chainProven);
    push("9100", "normal", taxable, "= 9000 (no allowance or deduction is typed by the agent)", chainProven);
    if (!minimumTaxInput && grossRevenue >= SECTION_113_TURNOVER) {
      skip(["920000", "9200"], "turnover is PKR 100 million or more: Section 113 minimum tax may apply");
    } else {
      const tax = Math.round(divisionIClause1Tax(taxable));
      // The slab itself is law; only the 30% band was seen on IRIS so far.
      const bandSeenLive = taxable > 1_600_000 && taxable <= 3_200_000;
      const adjustableSections = Math.max(0, Number(input.taxDeductionSections?.adjustable) || 0);
      const minimumSections = Math.max(0, Number(input.taxDeductionSections?.minimum) || 0);
      // Withholding rows have not been part of a live run yet: a difference
      // reads "not yet confirmed live", never "TaxRocket is wrong".
      const withholdingSeenLive = adjustableSections === 0 && minimumSections === 0;
      // Phase 3c: with a turnover row on the tab, nothing below has been
      // seen live yet.
      push(
        "920000",
        "normal",
        tax,
        "Division I clause (1) slab on 9100",
        chainProven && bandSeenLive && withholdingSeenLive && !minimumTaxInput,
      );
      // Phase 3b: Section 4AB, 10% of the Division I tax above PKR 10
      // million. A business-only return has no salary, so the 9% proviso
      // cannot apply (decision D4).
      const surcharge = taxable > SECTION_4AB_THRESHOLD ? Math.round(tax * 0.1) : 0;
      computations.expectedTaxableIncome = taxable;
      computations.expectedNormalTax = tax;
      computations.surcharge =
        surcharge > 0
          ? {
              code: "923184",
              label: LABELS["923184"],
              action: "TYPE",
              value: surcharge,
              ratePercent: 10,
              basis: `10% of Normal Tax ${tax.toLocaleString("en-US")} (920000), because Taxable Income ${taxable.toLocaleString("en-US")} (9100) is above PKR 10 million`,
              message: "",
            }
          : {
              code: "923184",
              label: LABELS["923184"],
              action: "NONE",
              value: 0,
              ratePercent: 10,
              basis: "Taxable Income (9100) is PKR 10 million or less: no surcharge",
              message: "",
            };
      // Phase 3c: Section 113. The minimum tax wins only when it is higher
      // than Normal Tax + surcharge, and is then paid instead of both
      // (s.113(2)(b)): the surcharge row is left empty with a message.
      const minimumWins = Boolean(minimumTaxInput) && minimumTaxValue > tax + surcharge;
      if (minimumTaxInput) {
        computations.minimumTaxRegime = minimumWins ? "minimum" : "normal";
        if (minimumWins)
          computations.surcharge =
            surcharge > 0
              ? {
                  code: "923184",
                  label: LABELS["923184"],
                  action: "USER",
                  value: 0,
                  ratePercent: 10,
                  basis: `minimum tax ${minimumTaxValue.toLocaleString("en-US")} is higher than Normal Tax ${tax.toLocaleString("en-US")} + surcharge ${surcharge.toLocaleString("en-US")}, so it is paid instead of both (s.113(2)(b))`,
                  message: SURCHARGE_MINIMUM_TAX_MESSAGE,
                }
              : {
                  code: "923184",
                  label: LABELS["923184"],
                  action: "NONE",
                  value: 0,
                  ratePercent: 10,
                  basis: "Taxable Income (9100) is PKR 10 million or less: no surcharge",
                  message: "",
                };
      }
      const superTaxValue = computations.superTax.action === "TYPE" ? computations.superTax.value : 0;
      if (surcharge > 0 || superTaxValue > 0) {
        push(
          "923184",
          // Live 19-Oct-2026: IRIS computed this in Subject to Normal Tax
          // (463,400) and left its Total Income input blank.
          "normal",
          minimumWins ? 0 : surcharge,
          minimumWins
            ? `left empty: ${computations.surcharge.basis}`
            : `${computations.surcharge.basis} (read from Subject to Normal Tax, where IRIS computes it; Total Income may stay blank)`,
          false,
        );
        if (superTaxValue > 0) push("9231822", "total", superTaxValue, computations.superTax.basis, false);
      }
      if (minimumSections > 0) {
        skip(["9200"], "minimum-tax section(s) typed on the Tax Deduction tab: IRIS compares the minimum tax with the normal tax and adds any difference itself; TaxRocket's regime engine (Phase 3e) is not built yet");
      } else if (minimumTaxInput && computations.turnover?.action !== "TYPE") {
        skip(["9200"], "Section 113 turnover row is left to the taxpayer, so Tax Chargeable is not checked");
      } else if (minimumTaxInput) {
        push(
          "9200",
          "normal",
          (minimumWins ? minimumTaxValue : tax + surcharge) + superTaxValue,
          minimumWins
            ? `minimum tax ${minimumTaxValue.toLocaleString("en-US")} (turnover row ${minimumTaxInput.irisCode}) instead of 920000 + 923184${superTaxValue > 0 ? ", + 9231822" : ""} (Section 113; not yet seen on IRIS)`
            : `920000${surcharge > 0 ? " + 923184" : ""}${superTaxValue > 0 ? " + 9231822" : ""}: the normal tax is higher than the minimum tax ${minimumTaxValue.toLocaleString("en-US")} (Section 113; not yet seen on IRIS)`,
          false,
        );
      } else {
        const addOns = surcharge + superTaxValue;
        push(
          "9200",
          "normal",
          tax + addOns,
          addOns > 0
            ? `920000 + 923184${superTaxValue > 0 ? " + 9231822" : ""} (the surcharge / super tax the agent types on the Computations tab; not yet seen on IRIS)`
            : adjustableSections > 0
              ? "= 920000 (adjustable tax deducted is a credit against the tax, not part of Tax Chargeable)"
              : "= 920000 (no surcharge or turnover tax at this income)",
          addOns > 0 ? false : chainProven && bandSeenLive && withholdingSeenLive,
        );
      }
    }
  }

  // Balance Sheet: typed asset rows and typed equity/liability rows.
  const balance = codesIn(BALANCE_SHEET);
  const assets = balance.filter((code) => input.assetCodes.includes(code));
  const liabilities = balance.filter((code) => input.liabilityCodes.includes(code));
  const unknownBalance = balance.filter(
    (code) => !assets.includes(code) && !liabilities.includes(code),
  );
  if (unknownBalance.length) {
    skip(["3349", "3399"], `balance sheet code(s) ${unknownBalance.join(", ")} are neither a known asset nor a liability`);
  } else if (balance.length) {
    push("3349", "total", sum(assets), join(assets), proven(assets));
    push("3399", "total", sum(liabilities), join(liabilities), proven(liabilities));
  }

  // One reason per skipped code (the first, most specific one).
  const seen = new Set<string>();
  const uniqueSkipped = skipped.filter((entry) => {
    if (seen.has(entry.code) || rows.some((row) => row.code === entry.code)) return false;
    seen.add(entry.code);
    return true;
  });
  return {
    version: IRIS_EXPECTATIONS_VERSION,
    basis: "typed_business_fields",
    rows,
    skipped: uniqueSkipped,
    computations,
  };
}
