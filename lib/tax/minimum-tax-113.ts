// File: lib/tax/minimum-tax-113.ts
//
// Section 113 minimum tax for an individual filing for themselves (TY2026).
// Phase 3c, decisions D2 / D3 (16-Oct-2026).
//
// Law: Income Tax Ordinance 2001 as amended up to 31.07.2025
// (research/ito-2025.pdf, "p." = PDF page). FA 2026 changes start in TY2027.
//  - s.113(1), p.235-236. The section applies to an individual "having
//    turnover of hundred million rupees or above in the tax year 2017 or in
//    any subsequent tax year". It bites where the tax payable or paid is less
//    than the Division IX percentage of the turnover from all sources.
//    Explanation: "tax payable or paid" does not include
//      (a) final tax (s.169 or any other provision), or
//      (b) tax under s.4B or s.4C.
//  - s.113(2)(a)-(b): the person then pays the minimum tax "instead of the
//    actual tax payable".
//  - s.113(2)(c), p.237. The excess over the tax payable under clause (1) of
//    Division I is carried forward and adjusted in the next TWO tax years
//    (FA 2025; it was three before). The whole amount carries forward when
//    no tax is payable at all.
//  - s.113(3), p.237-238. Turnover is:
//      gross sales or receipts, excluding sales tax, federal excise and
//      trade discounts shown on invoices;
//      gross fees for services;
//      gross receipts from contracts;
//      minus amounts taxed as a final discharge.
//    The Explanation to (2)(a) says it covers receipts from all business
//    activities.
//  - First Schedule Part I Division IX, p.532-533: the TY2026 rates below.
//  - s.4AB, p.52: the surcharge is 10% (9% under the salary proviso) of "the
//    income tax imposed under Division I" above Rs 10 million of taxable
//    income.
//
// How the text is applied:
//  - Comparison: the surcharge is tax payable under the Ordinance (s.4AB),
//    and the Explanation leaves out only final tax and s.4B / 4C tax. So
//    the normal regime wins while Division I tax + surcharge is at least the
//    minimum tax. When the minimum tax wins it is paid "instead of the
//    actual tax payable under this Ordinance" (s.113(2)(b)), surcharge
//    included.
//  - Super tax (s.4C) stays payable on top: it is left out of the comparison,
//    and it is worked on income, not on turnover [LIKELY].
//  - Carry-forward: "the excess over the actual tax payable under clause (1)
//    of Division I" (s.113(2)(c)) = minimum tax - Division I tax (surcharge
//    not deducted). The whole amount when no tax is payable.
//
// D2: the earlier-year test is asked as a yes/no question. "Yes" applies
// s.113: the literal text "or in any subsequent tax year" [LIKELY], see
// business-income-work/phase-3/D2-D5-RESEARCH-2026-10-16.md.
// D3: one category question, default 1.25%. Cotton ginners have their own
// regime (Second Schedule Part III clause (17), p.646), so TaxRocket stops.
//
// IRIS: Computations > 999905 "Turnover Tax u/s 113" > "+ Turnover" opens
// the picker "Add Turnover Tax u/s 113" (capture 54). The rows it adds are
// in captures 57-61 (cells E E E D: Total Income / Subject to Final Tax /
// Subject to Exemption are editable, Subject to Normal Tax is computed).

export const SECTION_113_TURNOVER_THRESHOLD = 100_000_000;

/** Saved business-profit detail keys (lib/tax/rules/ty2026/subcategories.ts). */
export const TURNOVER_100M_EARLIER_YEAR_DETAIL_KEY = "businessTurnover100mEarlierYear";
export const MINIMUM_TAX_CATEGORY_DETAIL_KEY = "businessMinimumTaxCategory";

export type MinimumTaxCategoryId =
  | "standard"
  | "poultry"
  | "motorcycle_dealer"
  | "distributor_pharma_fmcg_cigarettes"
  | "petroleum_agent_distributor"
  | "rice_mill_dealer"
  | "tier1_fmcg_retailer"
  | "ecommerce"
  | "used_vehicle_dealer"
  | "flour_mill"
  | "cotton_ginner";

export type MinimumTaxCategory = Readonly<{
  id: MinimumTaxCategoryId;
  /** Plain words for the dropdown (ASCII only). */
  label: string;
  /** Short words for notes ("1.25% (all other businesses)"). */
  shortLabel: string;
  /** null = not handled by TaxRocket (cotton ginners: own regime). */
  ratePercent: number | null;
  /** Division IX entry (TY2026). */
  law: string;
  /** IRIS row the "+ Turnover" picker adds (captures 57-61). */
  irisCode: string | null;
  /** The picker card text exactly as captured (capture 54). */
  irisPickerLabel: string | null;
}>;

const IRIS_ROW = Object.freeze({
  "0.25": { code: "923152", picker: "Turnover / Tax Chargeable u/s 113 @0.25%" },
  "0.5": { code: "923206", picker: "Turnover / Tax Chargeable u/s 113 @ 0.50%" },
  "0.75": { code: "923168", picker: "Turnover / Tax Chargeable u/s 113 @0.75%" },
  "1.25": { code: "923161", picker: "Turnover / Tax Chargeable u/s 113 @ 1.25%" },
});

const category = (
  id: MinimumTaxCategoryId,
  label: string,
  shortLabel: string,
  ratePercent: 0.25 | 0.5 | 0.75 | 1.25,
  law: string,
): MinimumTaxCategory => ({
  id,
  label,
  shortLabel,
  ratePercent,
  law,
  irisCode: IRIS_ROW[String(ratePercent) as keyof typeof IRIS_ROW].code,
  irisPickerLabel: IRIS_ROW[String(ratePercent) as keyof typeof IRIS_ROW].picker,
});

/** The Division IX persons an individual can be, in dropdown order. */
export const MINIMUM_TAX_CATEGORIES: readonly MinimumTaxCategory[] = [
  category("standard", "None of these (all other businesses) - 1.25%", "all other businesses", 1.25, "Division IX S.No.4: in all other cases"),
  category("poultry", "Poultry: breeding, broiler, eggs or poultry feed - 0.75%", "poultry", 0.75, "Division IX S.No.1(c): poultry industry"),
  category("motorcycle_dealer", "Motorcycle dealer registered for sales tax - 0.5%", "motorcycle dealer", 0.5, "Division IX S.No.2(b): motorcycle dealers registered under the Sales Tax Act, 1990"),
  category("distributor_pharma_fmcg_cigarettes", "Distributor of medicines, FMCG goods or cigarettes - 0.25%", "distributor", 0.25, "Division IX S.No.3(a): distributors of pharmaceutical products, fast moving consumer goods and cigarettes"),
  category("petroleum_agent_distributor", "Petroleum agent or distributor registered for sales tax - 0.25%", "petroleum agent or distributor", 0.25, "Division IX S.No.3(b): petroleum agents and distributors registered under the Sales Tax Act, 1990"),
  category("rice_mill_dealer", "Rice mill or rice dealer - 0.25%", "rice mill or dealer", 0.25, "Division IX S.No.3(c): rice mills and dealers"),
  category("tier1_fmcg_retailer", "Tier-1 FMCG retailer integrated with FBR for real-time sales - 0.25%", "Tier-1 FMCG retailer", 0.25, "Division IX S.No.3(d): Tier-1 retailers of fast moving consumer goods integrated with the Board"),
  category("ecommerce", "All of my turnover is from e-commerce or an online marketplace - 0.25%", "e-commerce", 0.25, "Division IX S.No.3(e): turnover from supplies through e-commerce including an online marketplace"),
  category("used_vehicle_dealer", "Buying and selling used vehicles - 0.25%", "used vehicle dealer", 0.25, "Division IX S.No.3(f): persons engaged in the sale and purchase of used vehicles"),
  category("flour_mill", "Flour mill - 0.25%", "flour mill", 0.25, "Division IX S.No.3(g): flour mills"),
  {
    id: "cotton_ginner",
    label: "Cotton ginner (special tax regime - not handled by TaxRocket)",
    shortLabel: "cotton ginner",
    ratePercent: null,
    law: "Second Schedule Part III clause (17): cotton ginners",
    irisCode: "9012",
    irisPickerLabel: "Turnover/Tax on Income of Cotton Ginners",
  },
];

export const DEFAULT_MINIMUM_TAX_CATEGORY: MinimumTaxCategoryId = "standard";

/** Plain-word texts shared by the wizard, the estimate and the packet. */
export const SECTION_113_TEXT = Object.freeze({
  earlierYearQuestion:
    "Was your business turnover Rs 100 million (10 crore) or more in any tax year from 2017 to 2025?",
  earlierYearMissing:
    "On the Business profit step, answer whether your business turnover was Rs 100 million or more in any tax year from 2017 to 2025, then save and recalculate.",
  cottonGinner:
    "Cotton ginners pay tax under a special regime (Second Schedule Part III clause (17)) that TaxRocket does not handle. Please prepare this return in IRIS with your tax adviser.",
});

export function isMinimumTaxCategoryId(value: unknown): value is MinimumTaxCategoryId {
  return MINIMUM_TAX_CATEGORIES.some((entry) => entry.id === value);
}

export function getMinimumTaxCategory(id: unknown): MinimumTaxCategory | null {
  return MINIMUM_TAX_CATEGORIES.find((entry) => entry.id === id) ?? null;
}

export type Section113Applicability = Readonly<{
  applies: boolean;
  reason: "turnover_this_year" | "earlier_year" | null;
  /** This year's turnover is below 100M and the earlier-year question is unanswered. */
  needsEarlierYearAnswer: boolean;
}>;

/** Whether s.113 reaches this return (D2). */
export function section113Applicability(input: {
  turnover: number;
  turnover100mEarlierYear: boolean | null | undefined;
}): Section113Applicability {
  const turnover = Number(input.turnover) || 0;
  if (turnover >= SECTION_113_TURNOVER_THRESHOLD)
    return { applies: true, reason: "turnover_this_year", needsEarlierYearAnswer: false };
  if (input.turnover100mEarlierYear === true)
    return { applies: true, reason: "earlier_year", needsEarlierYearAnswer: false };
  return {
    applies: false,
    reason: null,
    needsEarlierYearAnswer: input.turnover100mEarlierYear !== false,
  };
}

export type Section113Result = Readonly<{
  turnover: number;
  ratePercent: number;
  /** Rounded rupees. */
  minimumTax: number;
  /** Division I tax + surcharge of the assessable lines (the comparison). */
  taxPayable: number;
  /** True when the minimum tax is higher, so it is paid instead. */
  applies: boolean;
  /** What is added on top of the normal tax so that the total = minimum tax. */
  topUp: number;
  /** s.113(2)(c): minimum tax - Division I tax, for the next two tax years. */
  carryForward: number;
}>;

/** Minimum tax and its comparison with the normal tax payable. */
export function computeSection113(input: {
  turnover: number;
  ratePercent: number;
  /** Division I tax + surcharge (final tax and s.4B / 4C left out). */
  taxPayable: number;
  /** Division I tax alone (the s.113(2)(c) carry-forward base). */
  divisionITax: number;
}): Section113Result {
  const turnover = Math.max(0, Math.round(Number(input.turnover) || 0));
  const ratePercent = Number(input.ratePercent) || 0;
  const taxPayable = Math.max(0, Math.round(Number(input.taxPayable) || 0));
  const divisionITax = Math.max(0, Math.round(Number(input.divisionITax) || 0));
  const minimumTax = Math.round((turnover * ratePercent) / 100);
  const applies = minimumTax > taxPayable;
  const topUp = applies ? minimumTax - taxPayable : 0;
  const carryForward = applies ? Math.max(0, minimumTax - divisionITax) : 0;
  return { turnover, ratePercent, minimumTax, taxPayable, applies, topUp, carryForward };
}
