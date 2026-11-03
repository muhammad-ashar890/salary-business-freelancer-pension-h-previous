import { parseBankOwnershipDecisions, type BankOwnershipDecision } from "@/lib/tax/business-bank-ownership";
import { sanitizeBusinessActivities, type BusinessActivity } from "@/lib/tax/business-activity";
import { TY2026_RATE_CARD_RULES } from "./catalog";
import type { RateCardRule } from "../rate-card-types";
import {
  DEPRECIATION_SCHEDULE_DETAIL_KEY,
  sanitizeDepreciationSchedule,
  type DepreciationScheduleRow,
} from "../../business-depreciation-schedule";
import {
  BUSINESS_BANK_ACCOUNTS_DETAIL_KEY,
  BUSINESS_PROPERTIES_DETAIL_KEY,
  BUSINESS_VEHICLES_DETAIL_KEY,
  sanitizeBusinessBankAccounts,
  sanitizeBusinessProperties,
  sanitizeBusinessVehicles,
  type BusinessBankAccount,
  type BusinessProperty,
  type BusinessVehicle,
} from "../../business-balance-details";
import {
  BUSINESS_IDENTITY_DETAIL_KEY,
  sanitizeBusinessIdentity,
  type BusinessIdentity,
} from "../../business-identity";
import {
  BUSINESS_TAX_DEDUCTIONS_DETAIL_KEY,
  sanitizeBusinessTaxDeductions,
  type BusinessTaxDeduction,
} from "../../business-tax-deductions";
import {
  MINIMUM_TAX_CATEGORY_DETAIL_KEY,
  isMinimumTaxCategoryId,
  type MinimumTaxCategoryId,
} from "../../minimum-tax-113";
import {
  BUSINESS_ADD_BACKS_DETAIL_KEY,
  sanitizeBusinessAddBacks,
  type BusinessAddBack,
} from "../../business-addbacks";
import {
  BUSINESS_LOSSES_BY_YEAR_DETAIL_KEY,
  sanitizeBusinessLossesByYear,
  type BusinessLossByYear,
} from "../../business-loss-rules";

export type Ty2026CatalogSource =
  | "imports"
  | "salary"
  | "pension"
  | "dividend"
  | "bank_profit"
  | "capital_gains"
  | "foreign_income_assets"
  | "business"
  | "services"
  | "property_rent"
  | "other_income"
  | "advance_tax";

export type Ty2026SubcategoryStepKey =
  | "subcategory_imports"
  | "subcategory_pension"
  | "subcategory_property_rent"
  | "subcategory_services"
  | "subcategory_bank_profit"
  | "subcategory_dividend"
  | "subcategory_business"
  | "subcategory_foreign_income_assets"
  | "subcategory_other_income"
  | "subcategory_advance_tax";

export type Ty2026IncomeSelectionInput = Readonly<{
  source: string;
  subcategory: string;
  details?: Ty2026SelectionUserDetails;
}>;

/**
 * Figures the taxpayer declares on a subcategory card. Income routes read
 * their amounts from the ledger, but activity routes (imports, advance tax)
 * and the composite dividend row need transaction-level inputs — a bill, a
 * vehicle value, an engine capacity, a debt/equity split — that no ledger
 * row carries. Those inputs travel here, are persisted on
 * FilingIncomeSelection.detailsJson beside the rule metadata, and are
 * validated again by the tax-calculation action before pricing.
 */
export type Ty2026SelectionUserDetails = {
  businessActivities?: BusinessActivity[];
  /** Keys populated from reviewed documents; used to withdraw stale source facts. */
  businessDocumentFactKeys?: string[];
  /** Declared transaction base in PKR (bill, value, consideration, ...). */
  amount?: number;
  /** Engine capacity in cc, used to pick vehicle bands. */
  engineCapacityCc?: number;
  /** Seat/person count, used by the per-seat passenger rows. */
  seatCount?: number;
  /** Laden weight in kg, used by the goods-transport rows. */
  ladenWeightKg?: number;
  /** Unit count for per-unit rows (workers, episodes, seconds). */
  unitQuantity?: number;
  /** Completed years since first registration (non-cc transfer taper). */
  vehicleAgeYears?: number;
  /** Customs C&F value in USD, banding mobile-phone imports. */
  cfValueUsd?: number;
  /** Whether an imported handset is a smartphone (matters at $30 or less). */
  isSmartphone?: boolean;
  businessSalesExcludeIndirectTax?: boolean;
  /**
   * The pension Yes/No answer: the taxpayer still works for their former
   * employer (or its associate). Stored explicitly on the
   * former-employer-or-associate selection so a confirmed "No" is
   * distinguishable from a question nobody asked. Section 149(IA) pricing
   * reads this — see pensionTaxAsSalary in app/actions/tax-calculation.ts.
   */
  worksForFormerEmployerOrAssociate?: boolean;
  /** Debt-derived portion of a composite mutual-fund dividend. */
  debtPortion?: number;
  /** Equity-derived portion of a composite mutual-fund dividend. */
  equityPortion?: number;
  /**
   * Business profit figures (Myself filing, "Business profit" step). Yearly
   * PKR amounts; see lib/tax/business-profit.ts for how they combine.
   */
  businessGrossSales?: number;
  businessOtherRevenue?: number;
  businessCostOfSales?: number;
  businessOperatingExpenses?: number;
  businessDepreciation?: number;
  businessInadmissibleExpenses?: number;
  businessLossBroughtForward?: number;
  businessWithholdingDeducted?: number;
  /**
   * DP-4 item 2: accounting profit / loss on the assets sold this year that
   * is already inside "Other business receipts" / "Business expenses"; see
   * lib/tax/business-asset-sales.ts.
   */
  businessAssetSaleBookGain?: number;
  businessAssetSaleBookLoss?: number;
  /**
   * DP-4 item 3: unused business loss by tax year (IRIS Adjustments rows
   * 327021-327025) and unabsorbed tax depreciation of earlier years (3258);
   * see lib/tax/business-loss-rules.ts.
   */
  businessLossesByYear?: BusinessLossByYear[];
  businessUnabsorbedDepreciation?: number;
  /**
   * DP-1: asset schedule as the IRIS "Depreciation" tab takes it (one entry
   * per IRIS row); see lib/tax/business-depreciation-schedule.ts.
   */
  businessDepreciationSchedule?: DepreciationScheduleRow[];
  /**
   * DP-2: own PKR business bank accounts (IRIS Balance Sheet 3320 child rows)
   * and business vehicles (3304); see lib/tax/business-balance-details.ts.
   */
  businessBankAccounts?: BusinessBankAccount[];
  businessBankOwnershipDecisions?: BankOwnershipDecision[];
  businessVehicles?: BusinessVehicle[];
  /** Business land / building properties (IRIS Balance Sheet 3301 / 3302). */
  businessProperties?: BusinessProperty[];
  /** DP-2: the IRIS "Business Details" tab; see lib/tax/business-identity.ts. */
  businessIdentity?: BusinessIdentity;
  /**
   * DP-3: tax deducted from business receipts by IRIS section (business "Tax
   * Deduction" tab); see lib/tax/business-tax-deductions.ts.
   */
  businessTaxDeductions?: BusinessTaxDeduction[];
  /**
   * DP-4: "Expenses that are not allowed" by IRIS reason (business tab
   * "Inadmissible/Admissible Deductions"); see lib/tax/business-addbacks.ts.
   */
  businessAddBacks?: BusinessAddBack[];
  /**
   * Phase 3c (D2): the business turnover was PKR 100 million or more in tax
   * year 2017 or a later year before this one (Section 113(1)). Asked only
   * when this year's turnover is below PKR 100 million.
   */
  businessTurnover100mEarlierYear?: boolean;
  /**
   * Phase 3c (D3): the Division IX business type that sets the Section 113
   * rate; see lib/tax/minimum-tax-113.ts.
   */
  businessMinimumTaxCategory?: MinimumTaxCategoryId;
};

export type Ty2026DetailFieldKey =
  | "amount"
  | "engineCapacityCc"
  | "seatCount"
  | "ladenWeightKg"
  | "unitQuantity"
  | "vehicleAgeYears"
  | "cfValueUsd"
  | "businessSalesExcludeIndirectTax"
  | "businessTurnover100mEarlierYear"
  | "isSmartphone"
  | "worksForFormerEmployerOrAssociate"
  | "debtPortion"
  | "equityPortion"
  | "businessGrossSales"
  | "businessOtherRevenue"
  | "businessCostOfSales"
  | "businessOperatingExpenses"
  | "businessDepreciation"
  | "businessInadmissibleExpenses"
  | "businessLossBroughtForward"
  | "businessWithholdingDeducted"
  | "businessAssetSaleBookGain"
  | "businessAssetSaleBookLoss"
  | "businessUnabsorbedDepreciation";

/**
 * One declared figure a subcategory card asks for. The wizard renders these
 * inputs; the tax-calculation action enforces the required ones. Keeping the
 * metadata here means the UI and the server validate the same contract.
 */
export type Ty2026DetailField = Readonly<{
  key: Ty2026DetailFieldKey;
  label: string;
  hint: string;
  required: boolean;
  /** Inclusive floor; values below it are rejected at calculation. */
  min: number;
  /** Whole-number input (counts, cc, seats) versus a money input. */
  wholeNumber: boolean;
  /**
   * Renders a yes/no checkbox instead of a number input. Only isSmartphone
   * uses this today; required still means "must be answered".
   */
  checkbox?: boolean;
}>;

export type Ty2026SubcategoryOption = Readonly<{
  source: Ty2026CatalogSource;
  subcategory: string;
  label: string;
  sections: readonly string[];
  ruleIds: readonly string[];
  ruleCount: number;
  implementationStatus: "CATALOGUED" | "NEEDS_EXTERNAL_DETAIL";
}>;

export type Ty2026SubcategoryStepDefinition = Readonly<{
  key: Ty2026SubcategoryStepKey;
  source: Ty2026CatalogSource;
  title: string;
  railLabel: string;
  description: string;
}>;

export const TY2026_SUBCATEGORY_STEPS: readonly Ty2026SubcategoryStepDefinition[] =
  [
    {
      key: "subcategory_imports",
      source: "imports",
      title: "Which import categories apply?",
      railLabel: "Import categories",
      description:
        "Select every TY2026 import category that applies. You can choose more than one.",
    },
    {
      key: "subcategory_pension",
      source: "pension",
      title: "Which pension situations apply?",
      railLabel: "Pension categories",
      description:
        "Optional - skip if none apply. Amount and age bands are calculated automatically from your pension records and date of birth.",
    },
    {
      key: "subcategory_property_rent",
      source: "property_rent",
      title: "Who received the rental income?",
      railLabel: "Rental categories",
      description: "Select the recipient type used by the TY2026 rental rules.",
    },
    {
      key: "subcategory_services",
      source: "services",
      title: "What type of services income was received?",
      railLabel: "Services categories",
      description:
        "Select all local, IT, advertising, exporter or export-service categories that apply.",
    },
    {
      key: "subcategory_bank_profit",
      source: "bank_profit",
      title: "What type of profit on debt was received?",
      railLabel: "Bank-profit categories",
      description:
        "Select every bank deposit, security, other profit-on-debt or Sukuk category that applies.",
    },
    {
      key: "subcategory_dividend",
      source: "dividend",
      title: "What type of dividend was received?",
      railLabel: "Dividend categories",
      description:
        "Select each dividend payer or fund category shown on the supporting documents.",
    },
    {
      key: "subcategory_business",
      source: "business",
      title: "Which business transaction categories apply?",
      railLabel: "Business categories",
      description:
        "Select all supply, contract, e-commerce, export and distribution categories that apply.",
    },
    {
      key: "subcategory_foreign_income_assets",
      source: "foreign_income_assets",
      title: "Which non-resident payment categories apply?",
      railLabel: "Non-resident categories",
      description:
        "Select every Section 152 payment or service category relevant to the filing.",
    },
    {
      key: "subcategory_other_income",
      source: "other_income",
      title: "What type of other income was received?",
      railLabel: "Other-income categories",
      description:
        "Select all prize, brokerage or commission categories that apply.",
    },
    {
      key: "subcategory_advance_tax",
      source: "advance_tax",
      title: "Which advance-tax transactions apply?",
      railLabel: "Advance-tax categories",
      description:
        "Select all vehicle, utility, property, auction, remittance or other advance-tax categories that apply.",
    },
  ] as const;

const SOURCE_BY_STEP = new Map<Ty2026SubcategoryStepKey, Ty2026CatalogSource>(
  TY2026_SUBCATEGORY_STEPS.map((step) => [step.key, step.source]),
);

const STEP_BY_SOURCE = new Map<
  Ty2026CatalogSource,
  Ty2026SubcategoryStepDefinition
>(TY2026_SUBCATEGORY_STEPS.map((step) => [step.source, step]));

const LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  "property_rent:individual-aop": "Rent received by an individual or AOP",
  "property_rent:company": "Rent received by a company",
  "advance_tax:motor-vehicle-value":
    "Motor vehicle purchase/registration",
  "advance_tax:motor-vehicle-section-231b-2":
    "Motor vehicle transfer",
  "advance_tax:motor-vehicle-section-231b-2a":
    "Motor vehicle lease",
  "advance_tax:passenger-transport-per-seat":
    "Passenger transport vehicle — per-seat tax",
  "advance_tax:motor-vehicle-annual": "Annual motor-vehicle tax",
  "advance_tax:motor-vehicle-lump-sum": "Lump-sum motor-vehicle tax",
  "advance_tax:electricity-commercial-industrial":
    "Commercial/industrial electricity bill up to PKR 20,000",
  "advance_tax:electricity-domestic-non-atl":
    "Domestic electricity bill — Non-ATL",
  "advance_tax:immovable-property-transfer":
    "Transfer/sale of immovable property",
  "advance_tax:immovable-property-purchase": "Purchase of immovable property",
};

const AUTOMATIC_SUBCATEGORIES: Readonly<
  Partial<Record<Ty2026CatalogSource, readonly string[]>>
> = {
  salary: ["salary", "salary-surcharge"],
  capital_gains: ["certain-debt-securities"],
};

const pkrAmount = (label: string, hint: string): Ty2026DetailField => ({
  key: "amount",
  label,
  hint,
  required: true,
  min: 0,
  wholeNumber: false,
});

const ENGINE_CC_FIELD: Ty2026DetailField = {
  key: "engineCapacityCc",
  label: "Engine capacity (cc)",
  hint: "As on the registration book. Non-cc/electric vehicles use the non-cc card.",
  required: true,
  min: 1,
  wholeNumber: true,
};

const VEHICLE_AGE_YEARS_FIELD: Ty2026DetailField = {
  key: "vehicleAgeYears",
  label: "Completed years since first registration",
  hint: "Whole years from first registration in Pakistan. Enter 0 for the first year; the charge falls 10% per year.",
  required: true,
  min: 0,
  wholeNumber: true,
};

/**
 * Declared figures per selectable card, keyed by `source:subcategory`. Cards
 * absent here need no figures: income-route cards read the ledger, the
 * single-episode TV-play row is a fixed charge, and the intentionally
 * unpriced rows stop with NEEDS_RULES however much is declared.
 */
const DETAIL_FIELDS_BY_SELECTION: Readonly<
  Record<string, readonly Ty2026DetailField[]>
> = {
  // Section 148 — every priced import row is a percentage of import value.
  "imports:part-i": [
    pkrAmount(
      "Import value (PKR)",
      "Customs-assessed value including duties and taxes paid at import.",
    ),
  ],
  "imports:part-ii": [
    pkrAmount(
      "Import value (PKR)",
      "Customs-assessed value including duties and taxes paid at import.",
    ),
  ],
  "imports:part-ii-commercial": [
    pkrAmount(
      "Import value (PKR)",
      "Customs-assessed value including duties and taxes paid at import.",
    ),
  ],
  "imports:part-iii": [
    pkrAmount(
      "Import value (PKR)",
      "Customs-assessed value including duties and taxes paid at import.",
    ),
  ],
  "imports:part-iii-commercial": [
    pkrAmount(
      "Import value (PKR)",
      "Customs-assessed value including duties and taxes paid at import.",
    ),
  ],
  "imports:sro-1125-manufacturer": [
    pkrAmount(
      "Import value (PKR)",
      "Customs-assessed value including duties and taxes paid at import.",
    ),
  ],
  "imports:pharma": [
    pkrAmount(
      "Import value (PKR)",
      "Customs-assessed value including duties and taxes paid at import.",
    ),
  ],
  "imports:ev-ckd": [
    pkrAmount(
      "Import value (PKR)",
      "Customs-assessed value including duties and taxes paid at import.",
    ),
  ],
  // Section 148 mobiles — fixed charge by C&F value band (Ordinance
  // First Schedule Part-II). The PKR base is irrelevant to the charge, so
  // only the banding inputs are collected.
  "imports:mobile-pct-8517-1219": [
    {
      key: "cfValueUsd",
      label: "C&F value (USD)",
      hint: "Customs cost-and-freight value in US dollars, from the goods declaration.",
      required: true,
      min: 0,
      wholeNumber: false,
    },
    {
      key: "isSmartphone",
      label: "Smartphone?",
      hint: "Needed only when the C&F value is $30 or less on this code.",
      required: false,
      min: 0,
      wholeNumber: false,
      checkbox: true,
    },
  ],
  "imports:mobile-pct-8517-1211": [
    {
      key: "cfValueUsd",
      label: "C&F value (USD)",
      hint: "Customs cost-and-freight value in US dollars, from the goods declaration.",
      required: true,
      min: 0,
      wholeNumber: false,
    },
    {
      key: "isSmartphone",
      label: "Smartphone?",
      hint: "CKD kits pay nothing up to $350, so this rarely matters here.",
      required: false,
      min: 0,
      wholeNumber: false,
      checkbox: true,
    },
  ],
  // Section 231AB — cash withdrawal while not on ATL.
  "advance_tax:cash-withdrawal": [
    pkrAmount("Cash withdrawn (PKR)", "Total cash withdrawn while not on ATL."),
  ],
  // Section 231B — vehicle value bands need the value plus engine capacity;
  // the transfer/lease rows are fixed per cc band.
  "advance_tax:motor-vehicle-value": [
    pkrAmount(
      "Vehicle value (PKR)",
      "Import, invoice or auction value per rate-card endnote 1.",
    ),
    ENGINE_CC_FIELD,
  ],
  "advance_tax:motor-vehicle-section-231b-2": [ENGINE_CC_FIELD],
  "advance_tax:motor-vehicle-section-231b-2a": [ENGINE_CC_FIELD],
  // Section 231B endnotes — non-cc rows need the vehicle value (the Rs 5m
  // threshold); the fixed transfer row also needs completed years since
  // first registration for the 10%-per-year reduction.
  "advance_tax:motor-vehicle-non-cc-value-5m-or-more": [
    pkrAmount(
      "Vehicle value (PKR)",
      "Import, invoice or auction value. The 3% rate applies at Rs 5,000,000 or more.",
    ),
  ],
  "advance_tax:motor-vehicle-non-cc-fixed": [
    pkrAmount(
      "Vehicle value (PKR)",
      "Import, invoice or auction value. The fixed charge applies at Rs 5,000,000 or more.",
    ),
    VEHICLE_AGE_YEARS_FIELD,
  ],
  // Section 231C — fixed per worker.
  "advance_tax:foreign-domestic-worker": [
    {
      key: "unitQuantity",
      label: "Number of workers",
      hint: "The fixed charge applies per foreign domestic worker.",
      required: true,
      min: 1,
      wholeNumber: true,
    },
  ],
  // Section 234 — goods transport by laden weight, passengers per seat,
  // private vehicles by cc band.
  "advance_tax:goods-transport-vehicle": [
    {
      key: "ladenWeightKg",
      label: "Laden weight (kg)",
      hint: "Charged at Rs 2.50 per kg up to 8,120 kg.",
      required: true,
      min: 0,
      wholeNumber: false,
    },
  ],
  "advance_tax:goods-transport-vehicle-above-8120kg": [
    {
      key: "ladenWeightKg",
      label: "Laden weight (kg)",
      hint: "Must exceed 8,120 kg for the fixed Rs 1,200 row.",
      required: true,
      min: 0,
      wholeNumber: false,
    },
  ],
  "advance_tax:passenger-transport-per-seat": [
    {
      key: "seatCount",
      label: "Seats / persons",
      hint: "The per-seat rows start at 4 persons.",
      required: true,
      min: 1,
      wholeNumber: true,
    },
  ],
  "advance_tax:motor-vehicle-annual": [ENGINE_CC_FIELD],
  "advance_tax:motor-vehicle-lump-sum": [ENGINE_CC_FIELD],
  // Section 235 — electricity bills.
  "advance_tax:electricity-commercial-industrial": [
    pkrAmount("Bill amount (PKR)", "Gross commercial/industrial bill."),
  ],
  "advance_tax:electricity-commercial": [
    pkrAmount("Bill amount (PKR)", "Gross commercial bill."),
  ],
  "advance_tax:electricity-industrial": [
    pkrAmount("Bill amount (PKR)", "Gross industrial bill."),
  ],
  "advance_tax:electricity-domestic-non-atl": [
    pkrAmount("Monthly bill (PKR)", "Gross domestic bill."),
  ],
  // Section 236 — telephone and internet.
  "advance_tax:landline-telephone": [
    pkrAmount("Monthly bill (PKR)", "Charged on the amount above Rs 1,000."),
  ],
  "advance_tax:internet-mobile-prepaid": [
    pkrAmount(
      "Bill / sale price (PKR)",
      "Bill amount or prepaid card/unit sale price.",
    ),
  ],
  // Sections 236A, 236C, 236K — auction and property transactions.
  "advance_tax:public-auction-movable-or-other": [
    pkrAmount("Gross sale price (PKR)", "Auction sale price."),
  ],
  "advance_tax:public-auction-immovable-or-railways": [
    pkrAmount("Gross sale price (PKR)", "Auction sale price."),
  ],
  "advance_tax:immovable-property-transfer": [
    pkrAmount(
      "Consideration received (PKR)",
      "Gross amount of consideration received.",
    ),
  ],
  "advance_tax:immovable-property-purchase": [
    pkrAmount("Fair market value (PKR)", "Fair market value of the property."),
  ],
  // Section 236CA — foreign TV content is fixed per episode/second.
  "advance_tax:foreign-tv-serial": [
    {
      key: "unitQuantity",
      label: "Number of episodes",
      hint: "Rs 1,000,000 is charged per episode.",
      required: true,
      min: 1,
      wholeNumber: true,
    },
  ],
  "advance_tax:advertisement-foreign-actor": [
    {
      key: "unitQuantity",
      label: "Duration (seconds)",
      hint: "Rs 100,000 is charged per second.",
      required: true,
      min: 1,
      wholeNumber: true,
    },
  ],
  // Sections 236CB, 236Y — function bills and card remittances.
  "advance_tax:function-gathering": [
    pkrAmount("Total bill (PKR)", "Bill for arranging/holding the function."),
  ],
  "advance_tax:card-remittance-abroad": [
    pkrAmount("Amount remitted (PKR)", "Amount remitted abroad by card."),
  ],
  // Section 150 — the composite mutual-fund row needs the debt/equity split
  // because each portion is charged at its own percentage.
  "dividend:mutual-fund-proportional": [
    {
      key: "debtPortion",
      label: "Debt-derived portion (PKR)",
      hint: "Must add up with the equity portion to the dividend income.",
      required: true,
      min: 0,
      wholeNumber: false,
    },
    {
      key: "equityPortion",
      label: "Equity-derived portion (PKR)",
      hint: "Must add up with the debt portion to the dividend income.",
      required: true,
      min: 0,
      wholeNumber: false,
    },
  ],
};

/**
 * "Business profit" selection. A filing for yourself (Myself) that includes
 * Business Income does not pick withholding-rate cards. It declares one set of
 * yearly figures, saved as a single selection on the `business` source. The
 * subcategory is intentionally NOT a catalog row: it carries no rate, so it is
 * not part of the option list and the 16 withholding cards stay unchanged for
 * every other flow.
 */
export const TY2026_BUSINESS_PROFIT_SUBCATEGORY = "profit-return";

export const TY2026_BUSINESS_PROFIT_LABEL = "Business profit";

/** True for the single Business-profit selection of a Myself filing. */
export function isTy2026BusinessProfitSelection(selection: {
  source: string;
  subcategory: string;
}): boolean {
  return (
    selection.source === "business" &&
    selection.subcategory === TY2026_BUSINESS_PROFIT_SUBCATEGORY
  );
}

const businessAmount = (
  key: Ty2026DetailFieldKey,
  label: string,
  hint: string,
  required = false,
): Ty2026DetailField => ({
  key,
  label,
  hint,
  required,
  min: 0,
  wholeNumber: false,
});

/** Fields of the Business profit form, in the order they are shown. */
export const TY2026_BUSINESS_PROFIT_FIELDS: readonly Ty2026DetailField[] = [
  businessAmount(
    "businessGrossSales",
    "Sales for the year (PKR)",
    "Total sales or turnover of the business for the tax year, before any expenses.",
    true,
  ),
  businessAmount(
    "businessOtherRevenue",
    "Other business receipts (PKR)",
    "Any other income of the business, such as commission or scrap sales. Leave empty if none.",
  ),
  businessAmount(
    "businessCostOfSales",
    "Cost of sales (PKR)",
    "What the goods you sold cost you (purchases and direct costs), or the direct cost of your services.",
  ),
  businessAmount(
    "businessOperatingExpenses",
    "Business expenses (PKR)",
    "Rent, salaries, utilities, transport, marketing, bank charges and other running costs of the business.",
  ),
  businessAmount(
    "businessDepreciation",
    "Depreciation (PKR)",
    "Book (accounting) depreciation on business assets for the year, from your accounts. IRIS adds it back: for tax, depreciation is worked out at Third Schedule rates from your list of assets instead.",
  ),
  businessAmount(
    "businessInadmissibleExpenses",
    "Expenses that are not allowed (PKR)",
    "Part of the expenses above that the law does not allow, for example personal expenses, entertainment, or cash payments above Rs 250,000 in one day. It is added back to your profit.",
  ),
  businessAmount(
    "businessLossBroughtForward",
    "Business loss brought forward (PKR)",
    "Unused business loss from earlier years (up to six years back). Leave empty if none.",
  ),
  businessAmount(
    "businessWithholdingDeducted",
    "Tax already deducted on your business receipts (PKR)",
    "Tax that customers deducted from your payments during the year. It is shown for your records and is not subtracted in the estimate.",
  ),
];

export function getTy2026SubcategoryDetailFields(
  source: string,
  subcategory: string,
): readonly Ty2026DetailField[] {
  if (
    source === "business" &&
    subcategory === TY2026_BUSINESS_PROFIT_SUBCATEGORY
  ) {
    return TY2026_BUSINESS_PROFIT_FIELDS;
  }
  return DETAIL_FIELDS_BY_SELECTION[`${source}:${subcategory}`] ?? [];
}

const DETAIL_KEYS: readonly Ty2026DetailFieldKey[] = [
  "amount",
  "engineCapacityCc",
  "seatCount",
  "ladenWeightKg",
  "unitQuantity",
  "vehicleAgeYears",
  "cfValueUsd",
  "debtPortion",
  "equityPortion",
  "businessGrossSales",
  "businessOtherRevenue",
  "businessCostOfSales",
  "businessOperatingExpenses",
  "businessDepreciation",
  "businessInadmissibleExpenses",
  "businessLossBroughtForward",
  "businessWithholdingDeducted",
  // DP-4 item 2: accounting profit / loss on assets sold already inside the
  // figures above (asked only when the asset list has a sale).
  "businessAssetSaleBookGain",
  "businessAssetSaleBookLoss",
  // DP-4 item 3: unabsorbed tax depreciation of earlier years (s.57(4)).
  "businessUnabsorbedDepreciation",
];

/** Detail keys that carry a yes/no answer rather than a number. */
const BOOLEAN_DETAIL_KEYS: readonly Ty2026DetailFieldKey[] = [
  "isSmartphone",
  "businessSalesExcludeIndirectTax",
  "businessTurnover100mEarlierYear",
  "worksForFormerEmployerOrAssociate",
];

/**
 * Shape-validates declared figures. Unknown keys are dropped so older
 * payloads keep working; known keys must be finite numbers of zero or more.
 * Required-field enforcement stays with the tax-calculation action, so draft
 * navigation can save an incomplete card and calculation refuses to price it.
 */
function sanitizeSelectionDetails(
  value: unknown,
):
  | { ok: true; details?: Ty2026SelectionUserDetails }
  | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Selection details must be an object" };
  }
  const details: Ty2026SelectionUserDetails = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "businessDocumentFactKeys") {
      const allowed = /^(businessIdentity\.(businessName|brandName|principalActivity|startDate|endDate)|business(SalesExcludeIndirectTax|Turnover100mEarlierYear|MinimumTaxCategory|BankAccounts|Vehicles|Properties|DepreciationSchedule|TaxDeductions|AddBacks|LossesByYear|UnabsorbedDepreciation|AssetSaleBookGain|AssetSaleBookLoss))$/;
      if (!Array.isArray(entry) || entry.length > 25 || entry.some(v => typeof v !== "string" || !allowed.test(v))) return { ok: false, error: "Invalid business source metadata" };
      details.businessDocumentFactKeys = [...new Set(entry)] as string[];
      continue;
    }
    if (key === "businessBankOwnershipDecisions") {
      const parsed = parseBankOwnershipDecisions(entry);
      if (!parsed.ok) return { ok: false, error: "Invalid bank ownership confirmations" };
      details.businessBankOwnershipDecisions = parsed.decisions;
      continue;
    }
    if (key === "businessActivities") {
      const activities = sanitizeBusinessActivities(entry);
      if (!activities) return { ok: false, error: "Invalid business activities" };
      details.businessActivities = activities;
      continue;
    }
    if (key === DEPRECIATION_SCHEDULE_DETAIL_KEY) {
      const schedule = sanitizeDepreciationSchedule(entry);
      if (!schedule.ok)
        return { ok: false, error: (schedule as { error: string }).error };
      details.businessDepreciationSchedule = schedule.rows;
      continue;
    }
    if (key === BUSINESS_BANK_ACCOUNTS_DETAIL_KEY) {
      const banks = sanitizeBusinessBankAccounts(entry);
      if (!banks.ok) return { ok: false, error: (banks as { error: string }).error };
      details.businessBankAccounts = banks.rows;
      continue;
    }
    if (key === BUSINESS_VEHICLES_DETAIL_KEY) {
      const vehicles = sanitizeBusinessVehicles(entry);
      if (!vehicles.ok) return { ok: false, error: (vehicles as { error: string }).error };
      details.businessVehicles = vehicles.rows;
      continue;
    }
    if (key === BUSINESS_PROPERTIES_DETAIL_KEY) {
      const properties = sanitizeBusinessProperties(entry);
      if (!properties.ok) return { ok: false, error: (properties as { error: string }).error };
      details.businessProperties = properties.rows;
      continue;
    }
    if (key === BUSINESS_IDENTITY_DETAIL_KEY) {
      const identity = sanitizeBusinessIdentity(entry);
      if (!identity.ok) return { ok: false, error: (identity as { error: string }).error };
      if (identity.identity) details.businessIdentity = identity.identity;
      continue;
    }
    if (key === BUSINESS_TAX_DEDUCTIONS_DETAIL_KEY) {
      const deductions = sanitizeBusinessTaxDeductions(entry);
      if (!deductions.ok) return { ok: false, error: (deductions as { error: string }).error };
      details.businessTaxDeductions = deductions.rows;
      continue;
    }
    if (key === BUSINESS_ADD_BACKS_DETAIL_KEY) {
      const addBacks = sanitizeBusinessAddBacks(entry);
      if (!addBacks.ok) return { ok: false, error: (addBacks as { error: string }).error };
      details.businessAddBacks = addBacks.rows;
      continue;
    }
    if (key === BUSINESS_LOSSES_BY_YEAR_DETAIL_KEY) {
      const losses = sanitizeBusinessLossesByYear(entry);
      if (!losses.ok) return { ok: false, error: (losses as { error: string }).error };
      details.businessLossesByYear = losses.rows;
      continue;
    }
    // Phase 3c (D3): the only text answer; it must be one of the listed ids.
    if (key === MINIMUM_TAX_CATEGORY_DETAIL_KEY) {
      if (entry === undefined || entry === null || entry === "") continue;
      if (!isMinimumTaxCategoryId(entry)) {
        return {
          ok: false,
          error: `Selection detail "${key}" must be one of the listed business types`,
        };
      }
      details.businessMinimumTaxCategory = entry;
      continue;
    }
    if (
      !(DETAIL_KEYS as readonly string[]).includes(key) &&
      !(BOOLEAN_DETAIL_KEYS as readonly string[]).includes(key)
    ) {
      continue;
    }
    if (entry === undefined || entry === null || entry === "") continue;
    if ((BOOLEAN_DETAIL_KEYS as readonly string[]).includes(key)) {
      if (typeof entry !== "boolean") {
        return {
          ok: false,
          error: `Selection detail "${key}" must be a yes/no answer`,
        };
      }
      // Indexed assignment into a mixed number/boolean record needs the
      // never cast; the key/typeof checks above keep it sound.
      details[key as Ty2026DetailFieldKey] = entry as never;
      continue;
    }
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
      return {
        ok: false,
        error: `Selection detail "${key}" must be a number of zero or more`,
      };
    }
    details[key as Ty2026DetailFieldKey] = entry as never;
  }
  return {
    ok: true,
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

function optionLabel(
  source: string,
  subcategory: string,
  rules: readonly RateCardRule[],
) {
  const override = LABEL_OVERRIDES[`${source}:${subcategory}`];
  if (override) return override;

  const first = rules[0]?.label ?? subcategory.replaceAll("-", " ");
  if (source === "foreign_income_assets") {
    return `Non-resident payment — ${first}`;
  }

  // Several amount-band rules share one subcategory. The amount/engine band
  // is derived from the later record, so a card represents the common route,
  // not one specific slab.
  //
  // 28-Oct-2026: the first salary slab is labelled
  // "Salary taxable-income band up-to-600k" with a space rather than a dash, so
  // the original pattern missed it and the Review step titled a PKR 2,400,000
  // salary as the "up-to-600k" band. Any trailing band name is dropped now.
  return first
    .replace(/\s+[—-]\s+(up-to|above|\d).*/i, "")
    .replace(/\s+band\s+(up-to|above)[-\s].*/i, " band");
}

const OPTIONS_BY_SOURCE = (() => {
  const grouped = new Map<string, RateCardRule[]>();
  for (const rule of TY2026_RATE_CARD_RULES) {
    const key = `${rule.source}\u0000${rule.subcategory}`;
    const existing = grouped.get(key) ?? [];
    existing.push(rule);
    grouped.set(key, existing);
  }

  const bySource = new Map<Ty2026CatalogSource, Ty2026SubcategoryOption[]>();
  for (const rules of grouped.values()) {
    const first = rules[0];
    const source = first.source as Ty2026CatalogSource;
    const option: Ty2026SubcategoryOption = {
      source,
      subcategory: first.subcategory,
      label: optionLabel(source, first.subcategory, rules),
      sections: Array.from(new Set(rules.map((rule) => rule.section))),
      ruleIds: rules.map((rule) => rule.id),
      ruleCount: rules.length,
      implementationStatus: rules.some(
        (rule) => rule.implementationStatus === "NEEDS_EXTERNAL_DETAIL",
      )
        ? "NEEDS_EXTERNAL_DETAIL"
        : "CATALOGUED",
    };
    const sourceOptions = bySource.get(source) ?? [];
    sourceOptions.push(option);
    bySource.set(source, sourceOptions);
  }

  return bySource;
})();

export function isTy2026SubcategoryStepKey(
  value: string,
): value is Ty2026SubcategoryStepKey {
  return SOURCE_BY_STEP.has(value as Ty2026SubcategoryStepKey);
}

export function getTy2026SourceForStep(
  key: Ty2026SubcategoryStepKey,
): Ty2026CatalogSource {
  return SOURCE_BY_STEP.get(key)!;
}

export function getTy2026SubcategoryStep(
  source: string,
): Ty2026SubcategoryStepDefinition | null {
  return STEP_BY_SOURCE.get(source as Ty2026CatalogSource) ?? null;
}

export function getTy2026SubcategoryOptions(
  source: string,
): readonly Ty2026SubcategoryOption[] {
  return OPTIONS_BY_SOURCE.get(source as Ty2026CatalogSource) ?? [];
}

export function getTy2026SubcategoryStepKeys(
  incomeSources: readonly string[],
  taxYear: number,
): Ty2026SubcategoryStepKey[] {
  if (taxYear !== 2026) return [];
  const selected = new Set(incomeSources);
  return TY2026_SUBCATEGORY_STEPS.filter((step) =>
    selected.has(step.source),
  ).map((step) => step.key);
}

/**
 * The one pension situation the wizard asks as an explicit Yes/No rather
 * than an optional card, because only the taxpayer knows it and the answer
 * flips the pension between the Section 149(IA) pension bands and the
 * Section 149 salary slabs.
 */
export const TY2026_PENSION_FORMER_EMPLOYER_SUBCATEGORY =
  "former-employer-or-associate" as const;

export type PensionFormerEmployerAnswer = "yes" | "no" | null;

/**
 * Reads the explicit Yes/No pension-situation answer off the
 * former-employer selection:
 *  - "yes" - selection row exists (details flag true, or absent from a
 *    legacy draft saved before the Yes/No step kept the explicit record)
 *  - "no"  - selection row exists with details.worksForFormerEmployerOrAssociate
 *            === false, so the confirmed negative is auditable in the packet
 *  - null  - no selection row, i.e. the question was never answered
 */
export function resolvePensionFormerEmployerAnswer(
  selection:
    | Pick<Ty2026IncomeSelectionInput, "details">
    | undefined
    | null,
): PensionFormerEmployerAnswer {
  if (!selection) return null;
  return selection.details?.worksForFormerEmployerOrAssociate === false
    ? "no"
    : "yes";
}

export function isTy2026AutomaticIncomeSelection(
  selection: Ty2026IncomeSelectionInput,
) {
  return (
    AUTOMATIC_SUBCATEGORIES[selection.source as Ty2026CatalogSource]?.includes(
      selection.subcategory,
    ) ?? false
  );
}

export function getTy2026AutomaticIncomeSelections(
  incomeSources: readonly string[],
): Ty2026IncomeSelectionInput[] {
  const selections: Ty2026IncomeSelectionInput[] = [];
  for (const source of incomeSources) {
    for (const subcategory of AUTOMATIC_SUBCATEGORIES[
      source as Ty2026CatalogSource
    ] ?? []) {
      selections.push({ source, subcategory });
    }
  }
  return selections;
}

export function resolveTy2026IncomeSelections(input: {
  incomeSources: readonly string[];
  selections: readonly Ty2026IncomeSelectionInput[];
  requireComplete?: boolean;
}) {
  const selectedSources = new Set(input.incomeSources);
  const normalized = new Map<string, Ty2026IncomeSelectionInput>();

  for (const selection of [
    ...input.selections,
    ...getTy2026AutomaticIncomeSelections(input.incomeSources),
  ]) {
    if (!selectedSources.has(selection.source)) {
      return {
        success: false as const,
        error: `Subcategory source ${selection.source} is not selected`,
      };
    }

    const validOption =
      isTy2026BusinessProfitSelection(selection) ||
      getTy2026SubcategoryOptions(selection.source).some(
        (option) => option.subcategory === selection.subcategory,
      );
    if (!validOption) {
      return {
        success: false as const,
        error: `Invalid TY2026 subcategory: ${selection.source}/${selection.subcategory}`,
      };
    }

    const sanitized = sanitizeSelectionDetails(selection.details);
    // NOTE: strict:false disables truthiness narrowing on the `ok`
    // discriminant, so compare explicitly (plain `!sanitized.ok` does not
    // narrow and leaves `.error` inaccessible).
    if (sanitized.ok === false) {
      return { success: false as const, error: sanitized.error };
    }

    normalized.set(`${selection.source}\u0000${selection.subcategory}`, {
      source: selection.source,
      subcategory: selection.subcategory,
      ...(sanitized.details ? { details: sanitized.details } : {}),
    });
  }

  if (input.requireComplete !== false) {
    for (const step of TY2026_SUBCATEGORY_STEPS) {
      if (!selectedSources.has(step.source)) continue;
      // Pension bands are auto-derived and the working question is optional.
      if (step.source === "pension") continue;
      const hasSelection = Array.from(normalized.values()).some(
        (selection) => selection.source === step.source,
      );
      if (!hasSelection) {
        return {
          success: false as const,
          error: `Select at least one option under ${step.railLabel}`,
        };
      }
    }
  }

  return {
    success: true as const,
    selections: Array.from(normalized.values()),
  };
}

/**
 * Reads back the taxpayer-declared figures stored on
 * FilingIncomeSelection.detailsJson beside the rule metadata. Defensive:
 * anything unreadable or out of shape yields undefined rather than a
 * half-parsed figure feeding the calculator.
 */
export function parsePersistedSelectionUserDetails(
  detailsJson: string | null,
): Ty2026SelectionUserDetails | undefined {
  if (!detailsJson) return undefined;
  try {
    const payload = JSON.parse(detailsJson) as {
      userDetails?: Record<string, unknown>;
    };
    const raw = payload?.userDetails;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return undefined;
    }
    const picked: Ty2026SelectionUserDetails = {};
    let found = false;
    if (Array.isArray(raw.businessDocumentFactKeys) && raw.businessDocumentFactKeys.every(v => typeof v === "string" && /^(businessIdentity\.(businessName|brandName|principalActivity|startDate|endDate)|business(SalesExcludeIndirectTax|Turnover100mEarlierYear|MinimumTaxCategory|BankAccounts|Vehicles|Properties|DepreciationSchedule|TaxDeductions|AddBacks|LossesByYear|UnabsorbedDepreciation|AssetSaleBookGain|AssetSaleBookLoss))$/.test(v))) { picked.businessDocumentFactKeys = raw.businessDocumentFactKeys; found = true; }
    if (Array.isArray(raw.businessBankOwnershipDecisions)) {
      const parsed = parseBankOwnershipDecisions(raw.businessBankOwnershipDecisions);
      if (parsed.ok) { picked.businessBankOwnershipDecisions = parsed.decisions; found = true; }
    }
    const activities = sanitizeBusinessActivities(raw.businessActivities);
    if (activities?.length) { picked.businessActivities = activities; found = true; }
    for (const key of DETAIL_KEYS) {
      const value = (raw as Record<string, unknown>)[key];
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0
      ) {
        picked[key] = value as never;
        found = true;
      }
    }
    for (const key of BOOLEAN_DETAIL_KEYS) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === "boolean") {
        picked[key] = value as never;
        found = true;
      }
    }
    // DP-1: a stored schedule that no longer passes the shape check is left
    // out (never half-read); the wizard then shows the rows as empty.
    const schedule = sanitizeDepreciationSchedule(
      (raw as Record<string, unknown>)[DEPRECIATION_SCHEDULE_DETAIL_KEY],
    );
    if (schedule.ok && Array.isArray(raw.businessDepreciationSchedule)) {
      picked.businessDepreciationSchedule = schedule.rows;
      found = true;
    }
    // DP-2: same rule for the bank-account and vehicle lists.
    const banks = sanitizeBusinessBankAccounts(
      (raw as Record<string, unknown>)[BUSINESS_BANK_ACCOUNTS_DETAIL_KEY],
    );
    if (banks.ok && Array.isArray(raw.businessBankAccounts)) {
      picked.businessBankAccounts = banks.rows;
      found = true;
    }
    const vehicles = sanitizeBusinessVehicles(
      (raw as Record<string, unknown>)[BUSINESS_VEHICLES_DETAIL_KEY],
    );
    if (vehicles.ok && Array.isArray(raw.businessVehicles)) {
      picked.businessVehicles = vehicles.rows;
      found = true;
    }
    const properties = sanitizeBusinessProperties(
      (raw as Record<string, unknown>)[BUSINESS_PROPERTIES_DETAIL_KEY],
    );
    if (properties.ok && Array.isArray(raw.businessProperties)) {
      picked.businessProperties = properties.rows;
      found = true;
    }
    const identity = sanitizeBusinessIdentity(
      (raw as Record<string, unknown>)[BUSINESS_IDENTITY_DETAIL_KEY],
    );
    if (identity.ok && identity.identity) {
      picked.businessIdentity = identity.identity;
      found = true;
    }
    // DP-3: same rule for the tax-deducted-by-section list.
    const deductions = sanitizeBusinessTaxDeductions(
      (raw as Record<string, unknown>)[BUSINESS_TAX_DEDUCTIONS_DETAIL_KEY],
    );
    if (deductions.ok && Array.isArray(raw.businessTaxDeductions)) {
      picked.businessTaxDeductions = deductions.rows;
      found = true;
    }
    // DP-4: same rule for the add-backs-by-reason list.
    const addBacks = sanitizeBusinessAddBacks(
      (raw as Record<string, unknown>)[BUSINESS_ADD_BACKS_DETAIL_KEY],
    );
    if (addBacks.ok && Array.isArray(raw.businessAddBacks)) {
      picked.businessAddBacks = addBacks.rows;
      found = true;
    }
    // DP-4 item 3: same rule for the losses-by-year list.
    const losses = sanitizeBusinessLossesByYear(
      (raw as Record<string, unknown>)[BUSINESS_LOSSES_BY_YEAR_DETAIL_KEY],
    );
    if (losses.ok && Array.isArray(raw.businessLossesByYear)) {
      picked.businessLossesByYear = losses.rows;
      found = true;
    }
    // Phase 3c (D3): a stored business type that is no longer listed is left out.
    const minimumTaxCategory = (raw as Record<string, unknown>)[MINIMUM_TAX_CATEGORY_DETAIL_KEY];
    if (isMinimumTaxCategoryId(minimumTaxCategory)) {
      picked.businessMinimumTaxCategory = minimumTaxCategory;
      found = true;
    }
    return found ? picked : undefined;
  } catch {
    return undefined;
  }
}

export function getTy2026SelectionDetails(source: string, subcategory: string) {
  const option = getTy2026SubcategoryOptions(source).find(
    (candidate) => candidate.subcategory === subcategory,
  );
  if (!option) return null;
  return {
    taxYear: 2026,
    ...(source === "business" && subcategory === TY2026_BUSINESS_PROFIT_SUBCATEGORY ? { businessDocumentFlowVersion: 2 } : {}),
    ruleIds: option.ruleIds,
    sections: option.sections,
    implementationStatus: option.implementationStatus,
  };
}
