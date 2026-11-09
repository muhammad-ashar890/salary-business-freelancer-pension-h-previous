import { isBusinessBankCategory } from "./business-bank-categories";
import type { PensionSource } from "./pension-source";
/**
 * Portal Field Map Builder
 * Converts our ledgerEntries + taxCredits into IRIS field mappings
 * Used in filing packet snapshot for Electron agent
 */

import {
  IRIS_CODES,
  CATEGORY_TO_IRIS_MAP,
  TAX_SECTION_TO_IRIS_CODE,
} from "./iris-field-codes";
import type { IrisRouteFamily } from "./fbr-agent-config";
import {
  PORTAL_ROW_EVIDENCE,
  PORTAL_WRITEABLE_CODES,
} from "./portal-row-evidence";
import { SALARY_CERTIFICATE_TAX_ROW } from "./iris-employment-capture";
import { CASH_IN_HAND_CODE, VALUE_MODE_ADD_TO_IRIS } from "./cash-in-hand";
import { isGiftCategory } from "./gift-income";
import {
  WEALTH_BANK_ACCOUNT_CODE,
  WEALTH_OTHER_EXPENSE_CODE,
  WEALTH_EXPENSE_ROWS,
  WEALTH_TAX_OUTFLOW_CODE,
  WEALTH_TAX_OUTFLOW_DESCRIPTION,
  classifyExpenseToWealthCode,
} from "./wealth-rows";

export type PortalFieldMapEntry = {
  ledgerEntryId?: string;
  taxCreditId?: string;
  incomeRecordId?: string;
  ourCategory: string;
  ourDescription: string;
  ourAmount: number;
  taxableAmount?: number;
  irisCode: string;
  irisDescription: string;
  portalArea: string;
  section: string;
  column:
    | "Total Amount"
    | "Total Income"
    | "Subject to Exemption"
    | "Subject to Final Tax"
    | "Taxable Amount"
    | "Amount Exempt from Tax / Subject to Fixed / Final Tax"
    | "Amount Subject to Normal Tax"
    | "Tax Collected / Deducted"
    | "Tax Deducted"
    | "Amount";
  isTaxField: boolean;
  filerStatus?: string;
  /** Exact collapsible IRIS grid, e.g. Minimum Tax or Final Tax. */
  portalGroup?: string;
  /** Services-only mapping purpose; never substitutes for evidence checks. */
  servicesMappingKind?: "SERVICES_INCOME" | "SERVICES_WITHHOLDING";
  servicesInvoiceEvidenceIds?: string[];
  servicesPaymentMatchIds?: string[];
  servicesEvidenceDocumentIds?: string[];
  servicesSubcategory?: string;
  servicesSubcategories?: string[];
  servicesIncomeCharacter?: string;
  servicesStatutorySection?: string;
  servicesObservedIrisCode?: string;
  servicesHumanReviewConfirmed?: boolean;
  sourceEvidenceReferences?: string[];
  propertyValue?: number;
  /**
   * Several IRIS rows can share one code (every bank account is a `7030` row).
   * When set, only a row whose visible description contains this text is a
   * valid target — for a bank account, its IBAN.
   */
  rowDescriptionIncludes?: string;
  /**
   * Deterministic repair baseline: the agent may overwrite the portal value
   * only when it exactly equals this approved baseline.
   */
  replaceOnlyIfExisting?: string;
  /**
   * Packet v1.1.0: how many ledger rows were summed into this one IRIS cell.
   * A single IRIS row is one figure, so N ledger entries must collapse into one
   * field — see the aggregation note in buildPortalFieldMap.
   */
  sourceEntryCount?: number;
  /**
   * Bank rows only: the closing balance on the approved statement, when the
   * amount to enter differs from it because the reconciliation auto-adjustment
   * was applied to the declared balance.
   */
  statementClosingBalance?: number;
  /**
   * Cash in hand (7012) only: `ourAmount` is a MOVEMENT, not a balance. The
   * agent adds it to the figure IRIS already holds on the row.
   */
  valueMode?: "add_to_iris_value";
  /**
   * Gift received (7037) only: the donor's CNIC / NTN / passport number that
   * the IRIS Gift dialog asks for, and the description typed into that dialog.
   * IRIS words the created row "Gift - <id> - <name> - <description>", so the
   * description (which holds the donor id and date) is also the row hint.
   */
  giftDonorId?: string;
  giftDescription?: string;
};

/**
 * Categories the engine produces that have NO verified IRIS line-item code.
 * Surfaced on the packet instead of being guessed into "Other Receipts": a
 * wrong number on a government return is worse than an unfilled one.
 */
export type PortalMappingGaps = {
  /**
   * Expense categories that are not a personal expense IRIS has a row for.
   * They are NOT in the Wealth Statement outflows, so the reconciliation will
   * not balance until a human places them. Informational (never gates).
   */
  wealthUnmappedExpenses?: {
    category: string;
    totalAmount: number;
  }[];
  /** Net bank cash evidence, already represented by approved annual business figures. */
  businessBankRecords?: { entryCount: number; receipts: number; costsAndExpenses: number };
  /** Ledger categories with no IRIS code — nothing was queued for these. */
  unmappedCategories: {
    category: string;
    entryIds: string[];
    totalAmount: number;
    reason: string;
  }[];
  /**
   * Entries whose amount is already on another IRIS sheet (a Services invoice
   * payment match carries the credit through the Services rows). Recorded so
   * the packet can prove why the amount does not appear twice; never gates
   * and never entered again.
   */
  coveredLedgerEntries?: {
    entryId: string;
    category: string;
    totalAmount: number;
  }[];
  /**
   * Amountless review instructions. They are a checklist, not money to key in,
   * so they must never appear as a PKR 0 manual-entry gap.
   */
  reviewChecklist?: { key: string; reason: string }[];
  /**
   * The reconciliation auto-adjustment was applied to the bank closing balance
   * that is entered in IRIS (7030) instead of being left as an unmapped
   * "Other" entry. `signedAmount` is the TaxRocket adjustment (inflow
   * positive); the declared balance is the statement balance minus it.
   */
  reconciliationAdjustment?: {
    signedAmount: number;
    iban: string;
    statementClosing: number;
    declaredClosing: number;
  };
  /** Client-directed Auto Adjust outflow placement; not a business deduction. */
  reconciliationOtherOutflow?: { code: "7087"; amount: number; entryIds: string[] };
  /** IRIS codes deliberately skipped because the row is computed, not entered. */
  skippedComputedCodes: { code: string; description: string; amount: number }[];
  /**
   * Codes whose IRIS row has NEVER been seen rendered with a writeable cell in a
   * real portal capture. They look right (every one exists in the client's
   * field-code extract) but the packet cannot prove the portal exposes an
   * enterable line for them, so they are reported for manual entry instead of
   * queued and burned as `row_not_found` / `column_disabled` at fill time.
   */
  captureUnverified?: {
    code: string;
    description: string;
    category: string;
    amount: number;
    reason: string;
  }[];
  /** Approved pension needing unverified final-tax/withholding portal placement. */
  pensionManualReview?: {
    annualPension: number;
    baseTax: number | null;
    surcharge: number | null;
    taxDue: number | null;
    taxDeducted: number;
    reason: string;
  };
  /**
   * Pension exempt/taxable split from the engine that does not add up to the
   * ledger row it belongs to. One IRIS line (1008) carries the whole figure, so
   * a disagreement is surfaced rather than silently resolved.
   */
  pensionSplitMismatch?: {
    entryId: string;
    ledgerAmount: number;
    engineSplitTotal: number;
  }[];
};

export type PortalFieldMap = {
  version: string;
  generatedAt: string;
  taxYear: number;
  filerType: string | null;
  taxpayerListStatus: string | null;
  totalFields: number;
  businessFields?: PortalFieldMapEntry[];
  incomeFields: PortalFieldMapEntry[];
  adjustableTaxFields: PortalFieldMapEntry[];
  wealthFields: PortalFieldMapEntry[];
  /**
   * Employer names to add on the IRIS Salary page (Employer Details). Names
   * only: IRIS fills the registration number when the exact registered name is
   * chosen from its list, so the agent never types a registration number.
   */
  employers?: string[];
  /** Codes with no verified IRIS target, reported rather than guessed. */
  mappingGaps?: PortalMappingGaps;
  computationHints: {
    totalIncome: number;
    taxableIncome: number;
    totalTaxWithheld: number;
    salaryCertificateTaxWithheld?: number;
    normalSlabSurcharge?: number;
    pensionExemptLimit?: number;
    pensionExemptAmount?: number;
    pensionTaxableAmount?: number;
    pensionSourceFingerprint?: string;
    pensionTreatment?: string;
  };
  selectorBundle: {
    version: string;
    portalType: "IRIS_2_0" | "CLASSIC" | "AUTO";
  };
};

export type PortalAutofillField = {
  key: string;
  value: string;
  label: string;
  irisCode: string;
  irisSection: string;
  portalArea: string;
  column: PortalFieldMapEntry["column"];
  isTaxField: boolean;
  taxableAmount?: number;
  replaceOnlyIfExisting?: string;
  selector: string;
  rowSelector: string;
  topTab: "Data";
  leftPanel: string | null;
  leftSection: string | null;
  sourceGroup: "incomeFields" | "adjustableTaxFields" | "wealthFields" | "businessFields";
  /** See PortalFieldMapEntry.rowDescriptionIncludes. */
  rowDescriptionIncludes?: string;
  /** Exact collapsible grid target, checked by navigation and the row filler. */
  portalGroup?: string;
  /** Evidence-gated Services mapping metadata used by Electron policy checks. */
  servicesMappingKind?: "SERVICES_INCOME" | "SERVICES_WITHHOLDING";
  servicesInvoiceEvidenceIds?: string[];
  servicesPaymentMatchIds?: string[];
  servicesEvidenceDocumentIds?: string[];
  servicesSubcategory?: string;
  servicesSubcategories?: string[];
  servicesIncomeCharacter?: string;
  servicesStatutorySection?: string;
  servicesObservedIrisCode?: string;
  servicesHumanReviewConfirmed?: boolean;
  sourceEvidenceReferences?: string[];
  /** See PortalFieldMapEntry.valueMode. `value` is then the amount to ADD. */
  valueMode?: "add_to_iris_value";
  /** See PortalFieldMapEntry.giftDonorId / giftDescription (7037 only). */
  giftDonorId?: string;
  giftDescription?: string;
  ledgerEntryId?: string;
  taxCreditId?: string;
  incomeRecordId?: string;
  ourCategory: string;
  ourDescription: string;
};

export type PacketRouteMetadata = {
  routeFamily: IrisRouteFamily | null;
  routeLabel: string | null;
  filingIntent: "original";
  requiresIdentification: boolean;
  source: "packet_builder";
  notes?: string[];
};

const SUPPORTED_IRIS_ROUTE_LABEL =
  "114(1) (Return of Income filed voluntarily for complete year)";

function buildPortalFieldRowSelector(irisCode: string) {
  return `[id="${irisCode}"]`;
}

function buildPortalFieldInputSelector(irisCode: string) {
  const rowSelector = buildPortalFieldRowSelector(irisCode);
  return [
    `${rowSelector} input:not([type=\"hidden\"]):not([disabled]):not([readonly])`,
    `${rowSelector} textarea:not([disabled]):not([readonly])`,
    `${rowSelector} select:not([disabled]):not([readonly])`,
  ].join(", ");
}

function getPortalNavigationHints(entry: PortalFieldMapEntry) {
  const portalArea = entry.portalArea.trim().toLowerCase();
  const section = entry.section.trim().toLowerCase();

  if (portalArea === "business") {
    return { topTab: "Data" as const, leftPanel: "Business", leftSection: entry.section };
  }
  if (portalArea === "employment" || section === "salary") {
    return {
      topTab: "Data" as const,
      leftPanel: "Employment",
      leftSection: "Salary",
    };
  }

  if (portalArea === "property" || section === "tax deductions") {
    return {
      topTab: "Data" as const,
      leftPanel: "Property",
      leftSection:
        section === "tax deductions" ? "Tax Deductions" : "Receipts/Deductions",
    };
  }

  if (
    portalArea === "tax chargeable / payments" ||
    section === "adjustable tax" ||
    section === "withholding tax" ||
    section === "final tax" ||
    section === "minimum tax"
  ) {
    return {
      topTab: "Data" as const,
      leftPanel: "Tax Chargeable / Payments",
      leftSection:
        section === "computations" ? "Computations" : "Withholding Tax",
    };
  }

  if (portalArea === "116 - wealth statement") {
    return {
      topTab: "Data" as const,
      leftPanel: "116 - Wealth Statement",
      leftSection:
        section === "reconciliation of net assets"
          ? "Reconciliation of Net Assets"
          : "Personal Assets / Liabilities",
    };
  }

  return {
    topTab: "Data" as const,
    leftPanel: null,
    leftSection: null,
  };
}

/**
 * Which IRIS column a figure may legally be written into.
 *
 * Encoded from the portal capture in the operator's live run
 * (`TaxRocketAgentLogs/latest-portal-inspection.json`, job cmttt19vj000mo8c80v6916tw,
 * build fix16-new-return-setup-20260908). Salary renders
 * `Total Income | Subject to Final Tax | Subject to Exemption | Subject to Normal Income`
 * and only columns 1 and 3 are enterable — the agent's own log recorded every one of its
 * 24 attempted writes as `column_disabled col=3 (header_exact)`, because the packet asked
 * for "Amount Subject to Normal Tax" on a column IRIS derives as
 * `Total − Final − Exemption`. So the packet must target the entered column, never the
 * derived one. (`scripts/verify-iris-row-filler.cjs:121` already asserts the same rule:
 * "salary: writes into the editable Total column of row #1009".)
 */
const TOTAL_AMOUNT_COLUMN: PortalFieldMapEntry["column"] = "Total Amount";

/**
 * IRIS codes that are computed by the portal (rowLevel "Summary" in the CSV catalog, or a
 * derived group header). They render `[D D D D]`, so filling them is always a refusal — and
 * worse, an unmapped tax section used to be pointed at `640000` "Adjustable Tax", the summary
 * row of the whole withholding schedule. Those rows are skipped and reported instead.
 */
/** IRIS 7037, Reconciliation of Net Assets > Inflows > Gift. */
const WEALTH_GIFT_CODE = "7037";

/** YYYY-MM-DD of a booking date, or null when there is none. */
function giftDateText(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

const COMPUTED_IRIS_CODES = new Set(
  Object.values(IRIS_CODES)
    .filter((def: any) => def.rowLevel === "Summary")
    .map((def: any) => def.code as string),
);

/** Categories that carry no verified IRIS line-item code — gap, never a guess. */
const GAP_ONLY_INCOME_CATEGORIES: Record<string, string> = {
  BANK_PROFIT:
    "Final-tax route: belongs in Other Sources → 'Subject to Final Tax', which has no live capture yet.",
  PROFIT_ON_DEBT:
    "Final-tax route: belongs in Other Sources → 'Subject to Final Tax', which has no live capture yet.",
  DIVIDEND:
    "Final-tax route @15/20%: needs the Other Sources line-item code (5016/5004) confirmed from a live capture.",
  BUSINESS:
    "Business income is filed on the Business schedules (3xxx); which line carries the engine total is unconfirmed.",
  SERVICES:
    "Services income has no verified IRIS line-item code on the 114(1) income sheets.",
  GIFT:
    "Gift received is not income. It is an inflow of the Wealth Statement (Reconciliation of Net Assets, Inflows, Gift, IRIS 7037). The agent enters it only when the donor's CNIC / NTN / passport number is recorded; without it, add it by hand with the donor's details.",
  OTHER_INCOME:
    "'Other income' has no single IRIS line; 'Other Receipts' (5028) is not a substitute for an unknown source.",
  CAPITAL_GAIN:
    "Capital gains need the Capital Gain sheet (4006/4016 long term, 4026/4036 short term), not captured live.",
  FOREIGN:
    "Foreign income needs the Foreign Sources sheet (6011 etc), not captured live.",
};

/**
 * The entered column for an income line item. Every income schedule IRIS 2.0
 * renders in the Data tab takes the gross figure in column 1 and derives the
 * Final-Exemption-Normal split (verified on Salary, and the assumption recorded
 * as UNVERIFIED for Property in `scripts/verify-portal-field-map.cjs`); the
 * engine's exempt/final/normal breakdown therefore never becomes a portal write.
 * Final-tax categories are not routed at all — see GAP_ONLY_INCOME_CATEGORIES.
 */
function incomeColumnForIrisCode(
  _irisCode: string,
): PortalFieldMapEntry["column"] {
  return TOTAL_AMOUNT_COLUMN;
}

function toPortalAutofillField(
  entry: PortalFieldMapEntry,
  sourceGroup: PortalAutofillField["sourceGroup"],
): PortalAutofillField {
  const rowSelector = buildPortalFieldRowSelector(entry.irisCode);
  const hints = getPortalNavigationHints(entry);
  return {
    key: `${entry.irisCode}:${sourceGroup}:${entry.column}${
      entry.rowDescriptionIncludes ? `:${entry.rowDescriptionIncludes}` : ""
    }`,
    value: String(entry.ourAmount),
    label: entry.irisDescription,
    irisCode: entry.irisCode,
    irisSection: entry.section,
    portalArea: entry.portalArea,
    column: entry.column,
    isTaxField: entry.isTaxField,
    selector: buildPortalFieldInputSelector(entry.irisCode),
    rowSelector,
    ...hints,
    sourceGroup,
    ...(entry.taxableAmount !== undefined ? { taxableAmount: entry.taxableAmount } : {}),
    ...(entry.replaceOnlyIfExisting !== undefined
      ? { replaceOnlyIfExisting: entry.replaceOnlyIfExisting }
      : {}),
    ...(entry.portalGroup ? { portalGroup: entry.portalGroup } : {}),
    ...(entry.servicesMappingKind
      ? { servicesMappingKind: entry.servicesMappingKind }
      : {}),
    ...(entry.servicesInvoiceEvidenceIds
      ? { servicesInvoiceEvidenceIds: [...entry.servicesInvoiceEvidenceIds] }
      : {}),
    ...(entry.servicesPaymentMatchIds
      ? { servicesPaymentMatchIds: [...entry.servicesPaymentMatchIds] }
      : {}),
    ...(entry.servicesEvidenceDocumentIds
      ? { servicesEvidenceDocumentIds: [...entry.servicesEvidenceDocumentIds] }
      : {}),
    ...(entry.servicesSubcategory
      ? { servicesSubcategory: entry.servicesSubcategory }
      : {}),
    ...(entry.servicesSubcategories
      ? { servicesSubcategories: [...entry.servicesSubcategories] }
      : {}),
    ...(entry.servicesIncomeCharacter
      ? { servicesIncomeCharacter: entry.servicesIncomeCharacter }
      : {}),
    ...(entry.servicesStatutorySection
      ? { servicesStatutorySection: entry.servicesStatutorySection }
      : {}),
    ...(entry.servicesObservedIrisCode
      ? { servicesObservedIrisCode: entry.servicesObservedIrisCode }
      : {}),
    ...(entry.servicesHumanReviewConfirmed !== undefined
      ? { servicesHumanReviewConfirmed: entry.servicesHumanReviewConfirmed }
      : {}),
    ...(entry.sourceEvidenceReferences
      ? { sourceEvidenceReferences: [...entry.sourceEvidenceReferences] }
      : {}),
    ...(entry.rowDescriptionIncludes
      ? { rowDescriptionIncludes: entry.rowDescriptionIncludes }
      : {}),
    ...(entry.valueMode ? { valueMode: entry.valueMode } : {}),
    ...(entry.giftDonorId ? { giftDonorId: entry.giftDonorId } : {}),
    ...(entry.giftDescription
      ? { giftDescription: entry.giftDescription }
      : {}),
    ledgerEntryId: entry.ledgerEntryId,
    taxCreditId: entry.taxCreditId,
    incomeRecordId: entry.incomeRecordId,
    ourCategory: entry.ourCategory,
    ourDescription: entry.ourDescription,
  };
}

export function flattenPortalFieldMap(
  portalFieldMap: PortalFieldMap | null | undefined,
): PortalAutofillField[] {
  if (!portalFieldMap || typeof portalFieldMap !== "object") {
    return [];
  }

  const incomeFields = Array.isArray(portalFieldMap.incomeFields)
    ? portalFieldMap.incomeFields
    : [];
  const adjustableTaxFields = Array.isArray(portalFieldMap.adjustableTaxFields)
    ? portalFieldMap.adjustableTaxFields
    : [];
  const wealthFields = Array.isArray(portalFieldMap.wealthFields)
    ? portalFieldMap.wealthFields
    : [];

  return [
    ...(Array.isArray(portalFieldMap.businessFields) ? portalFieldMap.businessFields : []).map((entry) => toPortalAutofillField(entry, "businessFields")),
    ...incomeFields.map((entry) =>
      toPortalAutofillField(entry, "incomeFields"),
    ),
    ...adjustableTaxFields.map((entry) =>
      toPortalAutofillField(entry, "adjustableTaxFields"),
    ),
    ...wealthFields.map((entry) =>
      toPortalAutofillField(entry, "wealthFields"),
    ),
  ];
}

export function buildPacketRouteMetadata(params: {
  taxYear: number;
  filerType: string | null;
  businessStructure: string | null;
  incomeSources?: readonly string[];
}): PacketRouteMetadata {
  const incomeSources = params.incomeSources ?? [];
  const businessStructure =
    params.businessStructure?.trim().toLowerCase() ?? null;
  const isSupportedIndividualRoute =
    params.taxYear === 2026 &&
    (params.filerType === "myself" ||
      (params.filerType === "my_business" &&
        (!businessStructure || businessStructure === "sole_proprietor")));

  if (!isSupportedIndividualRoute) {
    return {
      routeFamily: null,
      routeLabel: null,
      filingIntent: "original",
      requiresIdentification: true,
      source: "packet_builder",
      notes: [
        incomeSources.length > 0
          ? `No supported original individual IRIS route was inferred for filer profile (${params.filerType ?? "unknown"})`
          : "No supported original individual IRIS route was inferred from the packet profile",
      ],
    };
  }

  return {
    routeFamily: "normal_individual_114",
    routeLabel: SUPPORTED_IRIS_ROUTE_LABEL,
    filingIntent: "original",
    requiresIdentification: false,
    source: "packet_builder",
    notes:
      incomeSources.length > 0
        ? [`Income sources: ${incomeSources.join(", ")}`]
        : undefined,
  };
}

type LedgerEntryInput = {
  id?: string;
  entryType: string;
  category: string | null;
  description: string;
  amount: number | { toString(): string } | string;
  /** Donor number of a gift, taken from the bank transaction it came from. */
  giftDonorId?: string | null;
  /** Booking date of the entry; used to word a gift's IRIS description. */
  date?: Date | string | null;
};

type TaxCreditInput = {
  id?: string;
  section: string;
  subcategory: string;
  amount: number | { toString(): string } | string;
  source: string;
  sourceDocumentId?: string | null;
};

/**
 * When a reviewed MAPPED Salary Certificate is present for a Salary filing, it
 * is the single authoritative Section 149 salary withholding source (matching
 * `calculateTaxAction`). Suppress generic Section 149 `FilingTaxCredit` rows so
 * they cannot override the reviewed certificate amount or emit a non-certificate
 * `64020004` description that breaks the `Salary + Services` desktop allowlist.
 */
export function filterCoveredSalary149TaxCredits<
  T extends { id?: string; section: string },
>(
  taxCredits: readonly T[],
  options: { hasMappedSalaryCertificate: boolean },
): T[] {
  if (!options.hasMappedSalaryCertificate) return [...taxCredits];
  return taxCredits.filter(
    (credit) => String(credit.section ?? "").trim().toUpperCase() !== "149",
  );
}

function toNumber(val: any): number {
  if (typeof val === "number") return val;
  if (val === null || val === undefined) return 0;
  if (typeof val === "string") return parseFloat(val) || 0;
  if (typeof val === "object" && "toString" in val)
    return parseFloat(val.toString()) || 0;
  return 0;
}

function addMoney2(a: number, b: number): number {
  return Math.round((a + b) * 100) / 100;
}

function normalizeCategory(cat: string | null | undefined): string {
  if (!cat) return "OTHER_INCOME";
  return cat
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9_]/g, "_");
}

/** A priced income source the portal map cannot carry on a verified IRIS line. */
export type UnmappedPortalSource = { category: string; totalAmount: number };

/**
 * What the packet says about its own coverage. `complete` means every priced
 * category has a verified IRIS line; `partial_manual_entry_required` means a human
 * explicitly accepted the listed gaps, and the amounts stay recorded so nobody can
 * later claim the return was silent about them.
 */
export type PacketCoverage =
  | { mode: "complete" }
  | {
      mode: "partial_manual_entry_required";
      acceptedByOperator: true;
      unmappedSources: UnmappedPortalSource[];
    };

/**
 * The packet gate in one function: which categories block, the sentence the
 * operator reads, and what the snapshot records. The refusal and the acceptance
 * have to come from the same numbers, or an override could quietly drop an income
 * source that the plain refusal promised to keep visible.
 */
export function describeUnmappedPortalSources(gaps: unknown): {
  blocked: UnmappedPortalSource[];
  refusal: string;
  coverage: PacketCoverage;
} {
  const raw = (gaps as { unmappedCategories?: unknown } | null | undefined)
    ?.unmappedCategories;
  const blocked = (Array.isArray(raw) ? raw : [])
    .map((entry) => ({
      category: String(
        (entry as Partial<UnmappedPortalSource> | null)?.category ?? "",
      ),
      totalAmount: Number(
        (entry as Partial<UnmappedPortalSource> | null)?.totalAmount ?? 0,
      ),
    }))
    .filter(
      (entry) =>
        entry.category.length > 0 &&
        Number.isFinite(entry.totalAmount) &&
        entry.totalAmount !== 0,
    )
    .sort((a, b) => a.category.localeCompare(b.category));

  if (blocked.length === 0) {
    return { blocked, refusal: "", coverage: { mode: "complete" } };
  }

  const userFacingCategory = (category: string) => {
    switch (category) {
      case "RECONCILIATION_ADJUSTMENT_INFLOW":
        return "Other reconciliation amount";
      case "RECONCILIATION_ADJUSTMENT_OUTFLOW":
        return "Reconciliation adjustment";
      default:
        return category.replaceAll("_", " ").toLowerCase();
    }
  };
  const listed = blocked
    .map(
      (gap) =>
        `${userFacingCategory(gap.category)} (PKR ${gap.totalAmount.toLocaleString()})`,
    )
    .join(", ");

  // The reconciliation amount is TaxRocket's own balancing entry, not income:
  // there is no IRIS field to "choose", so the wording differs.
  const onlyReconciliation = blocked.every((gap) =>
    gap.category.startsWith("RECONCILIATION_ADJUSTMENT"),
  );
  // A gift has a known home, so there is no field to "choose": say where it goes.
  const onlyGift = blocked.every((gap) => gap.category === "GIFT");
  const onlyPension = blocked.every(gap => gap.category.startsWith("PENSION_"));
  const instruction = onlyPension
    ? "Pension final-tax/withholding placement needs manual review. The app's approved pension amount and expected tax are in the packet. No Total-only pension write is queued. Generate a manual-review packet only if you will complete and verify the pension schedules yourself; automatic desktop entry is blocked until the final-tax portal contract is verified."
    : onlyGift
    ? "A gift received is not income, so it is kept out of your tax figures. " +
      "In IRIS it belongs in the Wealth Statement, under Reconciliation of Net " +
      "Assets > Inflows > Gift (7037), with the donor's details. The desktop " +
      "agent does not enter it. Before continuing, confirm that you will add " +
      "it yourself in IRIS, or that it should not be entered anywhere."
    : onlyReconciliation
    ? "This is a notice, not an error: the desktop agent does not enter this " +
      "item. The reconciliation amount is TaxRocket's own balancing entry. " +
      "IRIS has no field the agent may fill for it without declaring " +
      'something on your behalf (an "Other" inflow tells FBR where money ' +
      "came from), and IRIS works out its own reconciliation from the rows " +
      "entered. After the agent finishes, check the Unreconciled amount in " +
      "IRIS and enter or explain any difference yourself. Before continuing, " +
      "confirm that you will handle it yourself in IRIS or that it should not " +
      "be entered anywhere."
    : "The desktop agent cannot enter this item automatically. You can still " +
      "generate the packet and use the PDF as a guide, then enter or explain " +
      "this amount yourself in IRIS. Before continuing, please tell TaxRocket " +
      "which FBR/IRIS field should receive this amount, or confirm that it " +
      "should not be entered anywhere.";

  return {
    blocked,
    refusal: `Your filing packet needs a manual IRIS entry for ${listed}. ${instruction}`,
    coverage: {
      mode: "partial_manual_entry_required",
      acceptedByOperator: true,
      unmappedSources: blocked,
    },
  };
}

export function buildPortalFieldMap(params: {
  taxYear: number;
  filerType: string | null;
  taxpayerListStatus: string | null;
  /** Only the validated Myself business packet may suppress separate bank-income writes. */
  businessBankEntriesCoveredByDeclaredProfit?: boolean;
  /**
   * Addition (Used) + Addition (New) in the reviewed Depreciation schedule.
   * EQUIPMENT bank purchases are covered up to this total; any excess stays
   * a manual-entry gap.
   */
  businessDepreciationAdditionsTotal?: number;
  ledgerEntries: LedgerEntryInput[];
  taxCredits?: TaxCreditInput[];
  /** Section 149 amount extracted from the approved salary certificate. */
  salaryCertificateTaxWithheld?: number | null;
  /** Annual gross pay is the salary tax base; bank deposits remain cash evidence. */
  salaryCertificateGrossSalary?: number | null;
  /** Employer names from the reviewed salary certificate. */
  employers?: string[];
  /**
   * Net cash moved out of the bank (withdrawals minus deposits) from the
   * confirmed CASH_MOVEMENT rows. Becomes a 7012 Cash in hand movement.
   */
  netCashMovement?: number | null;
  taxableIncome?: number;
  taxWithheld?: number;
  /**
   * One entry per configured bank account: its IBAN and the CLOSING balance of
   * its approved statement. Becomes a `7030` Bank Account(s) row each.
   */
  bankAccounts?: {
    iban: string;
    bankName: string;
    accountLabel: string;
    closingBalance: number | { toString(): string } | string;
    ownershipReviewRequired?: boolean;
  }[];
  pensionSource?: PensionSource;
  pensionDetails?: {
    totalPension: number;
    exemptLimit: number;
    exemptAmount: number;
    taxableAmount: number;
    age: number;
  };
  /**
   * Ledger entries whose amount is already carried by another sheet — today
   * the bank credits claimed by a Services invoice payment match. They must
   * not be reported again as an unmapped income gap.
   */
  coveredLedgerEntryIds?: readonly string[];
  /**
   * When a `final_above_10m` pension is combined with a mapped normal-slab
   * source above PKR 10M (such as Salary > PKR 10M), row 923184 carries the
   * combined Section 4AB surcharge so neither component is dropped.
   */
  additionalSection4ABSurcharge?: number;
}): PortalFieldMap {
  const {
    taxYear,
    filerType,
    taxpayerListStatus,
    ledgerEntries,
    taxCredits = [],
    coveredLedgerEntryIds = [],
    salaryCertificateTaxWithheld = null,
    salaryCertificateGrossSalary = null,
    taxableIncome = 0,
    taxWithheld = 0,
    bankAccounts = [],
    employers = [],
    netCashMovement: cashMovement = null,
    pensionDetails,
    pensionSource,
    additionalSection4ABSurcharge = 0,
  } = params;

  const incomeFields: PortalFieldMapEntry[] = [];
  const adjustableTaxFields: PortalFieldMapEntry[] = [];
  const wealthFields: PortalFieldMapEntry[] = [];

  /**
   * IRIS has ONE cell per (code, column); the engine has one row per ledger
   * entry. Without aggregation 13 SALARY rows emitted 13 fields onto row 1009
   * and the live run overwrote the same cell 13 times — the last write won, so
   * a taxpayer with several salary months got one month onto the return.
   * Accumulate here, emit once.
   */
  type Agg = { entry: PortalFieldMapEntry; ids: string[] };
  const incomeAgg = new Map<string, Agg>();
  const taxAgg = new Map<string, Agg>();
  const unmapped = new Map<
    string,
    {
      category: string;
      entryIds: string[];
      totalAmount: number;
      reason: string;
    }
  >();
  const skipped = new Map<
    string,
    { code: string; description: string; amount: number }
  >();
  const unproven = new Map<
    string,
    {
      code: string;
      description: string;
      category: string;
      amount: number;
      reason: string;
    }
  >();

  /**
   * Single choke point for "this IRIS line has never been proven enterable".
   * Returns true when the target must NOT be queued. Two failure shapes are
   * distinguished because they need different follow-up work:
   *  - the row id never rendered in any capture  → capture the sheet;
   *  - it rendered with every cell disabled       → the row is computed, so the
   *    code is wrong for entry even though it exists.
   */
  const holdUnprovenCode = (
    code: string,
    description: string,
    category: string,
    amount: number,
  ): boolean => {
    if (PORTAL_WRITEABLE_CODES.has(String(code))) return false;
    const evidence = PORTAL_ROW_EVIDENCE[String(code)];
    const reason = evidence
      ? `Captured ${evidence.captureCount} time(s) as a rendered row with no writeable cell — IRIS computes it, so nothing may be entered on "${description}".`
      : `"${description}" has never appeared as a rendered row in any captured IRIS page, so its existence as an enterable line is unproven.`;
    const bucket = unproven.get(String(code)) || {
      code: String(code),
      description,
      category,
      amount: 0,
      reason,
    };
    bucket.amount += amount;
    unproven.set(String(code), bucket);
    return true;
  };
  const pensionSplitMismatch: {
    entryId: string;
    ledgerAmount: number;
    engineSplitTotal: number;
  }[] = [];
  let pensionLedgerTotalForSplit = 0;
  const pensionLedgerEntryIds: string[] = [];

  const addIncome = (
    key: string,
    build: () => Omit<PortalFieldMapEntry, "sourceEntryCount">,
    ledgerEntryId?: string,
  ) => {
    const next = build();
    if (
      holdUnprovenCode(
        next.irisCode,
        next.irisDescription,
        next.ourCategory,
        next.ourAmount,
      )
    ) {
      return;
    }
    const existing = incomeAgg.get(key);
    if (existing) {
      existing.entry.ourAmount += next.ourAmount;
      if (ledgerEntryId) existing.ids.push(ledgerEntryId);
      existing.entry.sourceEntryCount = existing.ids.length;
      return;
    }
    incomeAgg.set(key, {
      entry: { ...next, sourceEntryCount: 1 } as PortalFieldMapEntry,
      ids: ledgerEntryId ? [ledgerEntryId] : [],
    });
  };

  let totalIncome = 0;
  // Gifts received that have a donor id: one 7037 row per donor and date.
  const giftAgg = new Map<
    string,
    { donorId: string; date: string | null; amount: number; count: number }
  >();
  const certificateGrossSalary =
    salaryCertificateGrossSalary === null ||
    salaryCertificateGrossSalary === undefined
      ? null
      : toNumber(salaryCertificateGrossSalary);
  const hasCertificateGrossSalary =
    certificateGrossSalary !== null && certificateGrossSalary > 0;

  const businessBankRecords = { entryCount: 0, receipts: 0, costsAndExpenses: 0 };
  let remainingBusinessEquipmentCoverage =
    params.businessBankEntriesCoveredByDeclaredProfit &&
    Number.isFinite(Number(params.businessDepreciationAdditionsTotal))
      ? Math.max(0, Math.round(Number(params.businessDepreciationAdditionsTotal)))
      : 0;
  const coveredEntryIds = new Set(coveredLedgerEntryIds.map(String));
  const coveredLedgerEntries: { entryId: string; category: string; totalAmount: number }[] = [];
  for (const entry of ledgerEntries) {
    let amount = toNumber(entry.amount);
    if (amount <= 0) continue;

    if (isBusinessBankCategory(entry.category)) {
      businessBankRecords.entryCount++;
      if (entry.entryType === "INCOME") businessBankRecords.receipts += amount;
      if (entry.entryType === "EXPENSE") businessBankRecords.costsAndExpenses += amount;
      if (!params.businessBankEntriesCoveredByDeclaredProfit) {
        const key = String(entry.category).toUpperCase();
        const bucket = unmapped.get(key) || { category: key, entryIds: [], totalAmount: 0, reason: "Business bank cash records need a validated annual business-profit packet; no separate salary, other-income or personal-expense write is permitted." };
        bucket.totalAmount += amount;
        if (entry.id) bucket.entryIds.push(entry.id);
        unmapped.set(key, bucket);
      }
      continue;
    }
    const normalizedCat = isGiftCategory(entry.category)
      ? "GIFT"
      : normalizeCategory(entry.category);
    // Bank pension receipts are cash/wealth evidence. An approved annual
    // pension source replaces them for income-sheet entry, exactly once.
    if (pensionSource && normalizedCat === "PENSION" && entry.entryType === "INCOME") continue;
    // Client decision (19-Oct-2026): in the validated Myself business flow a
    // ledger TAX_PAYMENT is tax-paid cash evidence already counted by the
    // withholding resolver. It has no separate amount-only IRIS line in the
    // packet and must not block generation merely because the supporting
    // documents do not carry a PSID/CPR number.
    if (
      params.businessBankEntriesCoveredByDeclaredProfit &&
      entry.entryType === "EXPENSE" &&
      normalizedCat === "TAX_PAYMENT"
    ) {
      continue;
    }
    // An EQUIPMENT bank debit is payment evidence for a capital asset. When
    // the reviewed Depreciation schedule contains current-year additions,
    // the agent types those additions on the Depreciation tab; typing the
    // bank row again would double-count it. Cover only up to the schedule
    // additions total and leave any excess as the manual-entry gap below.
    if (
      params.businessBankEntriesCoveredByDeclaredProfit &&
      entry.entryType === "ASSET" &&
      normalizedCat === "EQUIPMENT" &&
      remainingBusinessEquipmentCoverage > 0
    ) {
      const coveredAmount = Math.min(amount, remainingBusinessEquipmentCoverage);
      remainingBusinessEquipmentCoverage -= coveredAmount;
      amount -= coveredAmount;
      if (amount <= 0) continue;
    }
    if (
      entry.entryType === "INCOME" &&
      normalizedCat === "GIFT" &&
      entry.giftDonorId
    ) {
      const donorId = String(entry.giftDonorId).trim();
      const date = giftDateText(entry.date);
      const key = `${donorId}|${date ?? ""}`;
      const slot = giftAgg.get(key);
      if (slot) {
        slot.amount += amount;
        slot.count += 1;
      } else {
        giftAgg.set(key, { donorId, date, amount, count: 1 });
      }
      // Entered through the Gift dialog (wealth block below), not as income and
      // not as an unmapped gap.
      continue;
    }
    const mappings =
      CATEGORY_TO_IRIS_MAP[normalizedCat] ||
      CATEGORY_TO_IRIS_MAP[entry.category?.toUpperCase() || ""];
    const isSalaryLedgerIncome =
      entry.entryType === "INCOME" &&
      (normalizedCat === "SALARY" ||
        Boolean(
          mappings?.some(
            (mapping) =>
              mapping.incomeCode === IRIS_CODES.SALARY_PAY_WAGES.code,
          ),
        ));
    const replaceSalaryWithCertificate =
      hasCertificateGrossSalary && isSalaryLedgerIncome;

    // A gift received is a Wealth Statement inflow (IRIS 7037), never income.
    if (
      entry.entryType === "INCOME" &&
      !replaceSalaryWithCertificate &&
      !isGiftCategory(entry.category)
    ) {
      totalIncome += amount;
    }

    // Bank payroll credits are actual cash received (often net pay). If an
    // approved salary certificate is available, its annual gross amount is the
    // tax/IRIS source instead; do not send the bank credits to the salary row a
    // second time.
    if (replaceSalaryWithCertificate) continue;

    // A personal expense is not an income-sheet line, so it can never have an
    // entry in CATEGORY_TO_IRIS_MAP. It IS covered: the wealth block below
    // carries it on the `+ Expenses` rows (7051, 7055, 7058, 7087 ...). Without
    // this skip every expense category was reported as "needs a manual IRIS
    // entry" and the packet step demanded an acknowledgement for amounts the
    // agent enters itself. An expense that no wealth row can take still falls
    // through to the gap report below.
    if (entry.entryType === "EXPENSE") {
      const wealthCode = classifyExpenseToWealthCode(
        entry.category,
        entry.description,
      );
      if (wealthCode && WEALTH_EXPENSE_ROWS[wealthCode]) continue;
    }

    // Client-confirmed policy: Auto Adjust OUTFLOW belongs on Wealth 7087.
    // It stays an OTHER ledger item, not deductible business expenditure.
    // The wealth block aggregates it with any existing 7087 expenses.
    if (entry.entryType === "OTHER" && normalizedCat === "RECONCILIATION_ADJUSTMENT_OUTFLOW") continue;

    // No verified IRIS line for this category → report the gap. It used to fall
    // back to 5028 "Other Receipts", which produced the row_not_found entries the
    // operator saw for codes that are not rendered on this return at all.
    if (!mappings || mappings.length === 0) {
      // Already carried by the Services evidence rows. Record it for audit
      // instead of demanding the same bank credit be entered a second time.
      if (entry.id && coveredEntryIds.has(String(entry.id))) {
        coveredLedgerEntries.push({
          entryId: String(entry.id),
          category: normalizedCat,
          totalAmount: amount,
        });
        continue;
      }
      const reason =
        GAP_ONLY_INCOME_CATEGORIES[normalizedCat] ||
        `Category "${normalizedCat}" has no verified IRIS line-item code for the 114(1) income sheets.`;
      const bucket = unmapped.get(normalizedCat) || {
        category: normalizedCat,
        entryIds: [],
        totalAmount: 0,
        reason,
      };
      bucket.totalAmount += amount;
      if (entry.id) bucket.entryIds.push(entry.id);
      unmapped.set(normalizedCat, bucket);
      continue;
    }

    for (const mapping of mappings) {
      const irisDef = Object.values(IRIS_CODES).find(
        (c: any) => c.code === mapping.incomeCode,
      ) as any;

      // Computed rows (rowLevel "Summary") are derived by IRIS. Writing them is
      // always a refusal today, and will be a wrong figure the day IRIS allows it.
      if (
        irisDef?.rowLevel === "Summary" ||
        COMPUTED_IRIS_CODES.has(mapping.incomeCode)
      ) {
        const bucket = skipped.get(mapping.incomeCode) || {
          code: mapping.incomeCode,
          description: irisDef?.description || mapping.description,
          amount: 0,
        };
        bucket.amount += amount;
        skipped.set(mapping.incomeCode, bucket);
        continue;
      }

      // A category may legitimately map to more than one IRIS row (pension in
      // Salary and Annuity in Other Sources). It may NOT map to the same row
      // twice with different halves of one number — the pension split below.
      const column = incomeColumnForIrisCode(mapping.incomeCode);
      addIncome(
        `${mapping.incomeCode}:${column}`,
        () => ({
          ourCategory: normalizedCat,
          ourDescription: entry.description,
          ourAmount: amount,
          irisCode: mapping.incomeCode,
          irisDescription: irisDef?.description || mapping.description,
          portalArea: irisDef?.portalArea || "Other Sources",
          section: irisDef?.section || "Receipts / Deductions",
          column,
          isTaxField: false,
          filerStatus: taxpayerListStatus || undefined,
        }),
        entry.id,
      );
    }

    // Pension: our engine splits exempt/taxable. IRIS renders row 1008 with
    // editable Total, Final and Exemption columns; Normal is computed —
    // "Subject to Normal Tax" is derived by the portal as
    // Total − Final − Exemption. A fully-exempt pension (149(IA), e.g. a
    // pension at or under PKR 10M) must therefore additionally write the
    // Exemption column; if only Total were entered IRIS would push the whole
    // pension into Normal Income and charge salary slabs on an exempt amount
    // (observed live: 92,790 on a 1,989,000 exempt pension).
    // `pensionDetails` remains on computationHints for the review screen.
    if (normalizedCat === "PENSION") {
      // Aggregate only: the split reconciliation and the Exemption-column
      // write happen once after this loop (see the pension post-pass below),
      // so a pension booked as several ledger rows is never multiplied.
      pensionLedgerTotalForSplit += amount;
      pensionLedgerEntryIds.push(entry.id ?? "(unknown)");
    }

    // Property: the 1/5th repair deduction is its own IRIS line (2031), not a
    // column of the rent row. Keep it, on the entered column.
    if (["RENT", "RENTAL", "PROPERTY_RENT"].includes(normalizedCat)) {
      const repairDeduction = amount * 0.2; // 1/5th
      addIncome(
        `${IRIS_CODES.PROPERTY_REPAIR_1_5TH.code}:${TOTAL_AMOUNT_COLUMN}`,
        () => ({
          ourCategory: "PROPERTY_DEDUCTION_REPAIR",
          ourDescription: `1/5th Repair deduction for ${entry.description}`,
          ourAmount: repairDeduction,
          irisCode: IRIS_CODES.PROPERTY_REPAIR_1_5TH.code,
          irisDescription: IRIS_CODES.PROPERTY_REPAIR_1_5TH.description,
          portalArea: "Property",
          section: "Receipts / Deductions",
          column: TOTAL_AMOUNT_COLUMN,
          isTaxField: false,
        }),
        entry.id,
      );
    }
  }

  // Tax Deductions → Adjustable Tax is the portal destination for Section 149.
  // The supplied Tax Deductions DOM proves code 64020004 and its editable
  // `Tax Deducted` cell (index 1). The salary certificate is uploaded/reviewed
  // in TaxRocket's Documents step, not on the IRIS Tax Deductions page; its
  // mapped withholding is therefore added as a synthetic Section 149 credit
  // only when no explicit 149 credit already exists. Never add both copies.
  const hasExplicitSalary149Credit = taxCredits.some(
    (credit) =>
      String(credit.section).trim().toUpperCase() === "149" &&
      toNumber(credit.amount) > 0,
  );

  // A pension charged on the salary slabs ("still working for the former
  // employer") is a Section 149 salary deduction in the portal's eyes, so its
  // withholding belongs on the same row as any other 149 credit: 64020004,
  // whose editable `Tax Deducted` cell is proven by two captures
  // (lib/tax/portal-row-evidence.ts). The final-tax route (149(IA), pension
  // above PKR 10M) keeps its own row 64020007 and is never converted to 149.
  const certSalaryTaxWithheld =
    salaryCertificateTaxWithheld !== null &&
    salaryCertificateTaxWithheld !== undefined &&
    toNumber(salaryCertificateTaxWithheld) > 0
      ? toNumber(salaryCertificateTaxWithheld)
      : 0;
  const pensionSalaryTaxWithheld =
    pensionSource?.treatment === "salary" && toNumber(pensionSource.taxDeducted) > 0
      ? toNumber(pensionSource.taxDeducted)
      : 0;
  // On a combined Salary + Pension filing (`hasCertificateGrossSalary === true`),
  // row 1009 (employer salary) and row 1008 (pension taxed on salary slabs) are
  // separate income bases whose Section 149 deductions both contribute in
  // `calculateTaxAction`; both must therefore aggregate onto row 64020004. On a
  // pension-only filing (`hasCertificateGrossSalary === false`), a standalone
  // certificate credit keeps its own value without adding a duplicate pension copy.
  const salaryRoute149Credits: TaxCreditInput[] = [];
  if (certSalaryTaxWithheld > 0) {
    salaryRoute149Credits.push({
      section: "149",
      subcategory: "Salary certificate",
      amount: certSalaryTaxWithheld,
      source: "SALARY_CERTIFICATE",
    });
  }
  if (
    pensionSalaryTaxWithheld > 0 &&
    (hasCertificateGrossSalary || certSalaryTaxWithheld === 0)
  ) {
    salaryRoute149Credits.push({
      section: "149",
      subcategory: "Pension taxed as salary",
      amount: pensionSalaryTaxWithheld,
      source: "PENSION_SALARY_149",
    });
  }
  const effectiveTaxCredits =
    !hasExplicitSalary149Credit && salaryRoute149Credits.length > 0
      ? [...taxCredits, ...salaryRoute149Credits]
      : taxCredits;

  // A pension charged as salary is written to row 1008, not 1009, so IRIS does
  // not derive the Taxable Amount of the 64020004 row from the salary head: the
  // cell stays empty and the portal refuses the credit with "Tax Deducted on
  // Salary cannot be greater than the Total Amount" (live, 30-Oct-2026, job
  // cmvum5bkr001613b2jplmf5km). The row's first cell is proven writeable
  // (lib/tax/portal-row-evidence.ts: writeableInputIndexes [0, 1]), so the
  // packet states the base the deduction was made on: the salary-certificate
  // gross plus the pension taken as salary, which is exactly the salary head
  // the portal would otherwise have derived.
  // Written before the credit itself: the portal clears a deduction whose base
  // is still empty (same rule the Services withholding rows follow), so the
  // order of the queued fields matters, not just their final values.
  if (pensionSalaryTaxWithheld > 0) {
    const salaryRowDef = Object.values(IRIS_CODES).find(
      (definition: any) =>
        definition.code === IRIS_CODES.ADJ_SALARY_149.code,
    ) as any;
    const base = addMoney2(
      certificateGrossSalary ?? 0,
      toNumber(pensionSource?.annualPension),
    );
    if (base > 0 && !holdUnprovenCode(IRIS_CODES.ADJ_SALARY_149.code, IRIS_CODES.ADJ_SALARY_149.description, "PENSION", base)) {
      const key = `${IRIS_CODES.ADJ_SALARY_149.code}:Taxable Amount`;
      if (!taxAgg.has(key)) {
        taxAgg.set(key, {
          entry: {
            ourCategory: "PENSION_SALARY_149",
            ourDescription:
              "Salary base of the section 149 deduction: pension charged as salary, as row 1008 carries it.",
            ourAmount: base,
            irisCode: IRIS_CODES.ADJ_SALARY_149.code,
            irisDescription:
              salaryRowDef?.description || IRIS_CODES.ADJ_SALARY_149.description,
            portalArea: salaryRowDef?.portalArea || "Tax Chargeable / Payments",
            section: salaryRowDef?.section || "Adjustable Tax",
            portalGroup: salaryRowDef?.section || "Adjustable Tax",
            column: "Taxable Amount",
            isTaxField: true,
            filerStatus: taxpayerListStatus || undefined,
            sourceEntryCount: 1,
          },
          ids: [],
        });
      }
    }
  }


  // Process tax credits -> adjustable/final/average tax fields
  for (const credit of effectiveTaxCredits) {
    const amount = toNumber(credit.amount);
    if (amount <= 0) continue;

    // Try to map section to IRIS code
    const sectionUpper = credit.section.toUpperCase();
    let irisCode =
      TAX_SECTION_TO_IRIS_CODE[credit.section] ||
      TAX_SECTION_TO_IRIS_CODE[sectionUpper];

    // Handle 236C and 236K specially - check subcategory
    if (!irisCode) {
      if (
        sectionUpper.includes("236C") ||
        credit.subcategory.toLowerCase().includes("236c") ||
        credit.subcategory.toLowerCase().includes("transfer")
      ) {
        irisCode = IRIS_CODES.ADJ_PROPERTY_TRANSFER_236C.code;
      } else if (
        sectionUpper.includes("236K") ||
        credit.subcategory.toLowerCase().includes("236k") ||
        credit.subcategory.toLowerCase().includes("purchase")
      ) {
        irisCode = IRIS_CODES.ADJ_PROPERTY_PURCHASE_236K.code;
      }
    }

    if (!irisCode) {
      // Unmapped withholding section. It used to land on 640000 "Adjustable Tax",
      // which is the schedule's computed summary row (`column_disabled c1` on the
      // live capture) — i.e. a guaranteed refusal dressed up as a placement.
      const reason = `Withholding section "${credit.section}" has no verified IRIS code in TAX_SECTION_TO_IRIS_CODE.`;
      const bucket = unmapped.get(`TAX_${sectionUpper}`) || {
        category: `TAX_${sectionUpper}`,
        entryIds: [],
        totalAmount: 0,
        reason,
      };
      bucket.totalAmount += amount;
      if (credit.id) bucket.entryIds.push(credit.id);
      unmapped.set(`TAX_${sectionUpper}`, bucket);
      continue;
    }

    const irisDef = Object.values(IRIS_CODES).find(
      (c: any) => c.code === irisCode,
    ) as any;

    if (irisDef?.rowLevel === "Summary" || COMPUTED_IRIS_CODES.has(irisCode)) {
      const bucket = skipped.get(irisCode) || {
        code: irisCode,
        description:
          irisDef?.description || `${credit.section} ${credit.subcategory}`,
        amount: 0,
      };
      bucket.amount += amount;
      skipped.set(irisCode, bucket);
      continue;
    }

    if (
      holdUnprovenCode(
        irisCode,
        irisDef?.description || `${credit.section} ${credit.subcategory}`,
        `TAX_${sectionUpper}`,
        amount,
      )
    ) {
      continue;
    }

    const taxColumn: PortalFieldMapEntry["column"] =
      irisCode === IRIS_CODES.ADJ_RENT_155.code
        ? "Tax Deducted"
        : "Tax Collected / Deducted";
    const taxKey = `${irisCode}:${taxColumn}`;
    const existingTax = taxAgg.get(taxKey);
    if (existingTax) {
      existingTax.entry.ourAmount = addMoney2(existingTax.entry.ourAmount, amount);
      if (
        irisCode === SALARY_CERTIFICATE_TAX_ROW.code &&
        credit.source === "PENSION_SALARY_149" &&
        /salary withholding from mapped salary certificate/i.test(
          existingTax.entry.ourDescription,
        )
      ) {
        existingTax.entry.ourDescription = `Section 149 salary withholding from mapped salary certificate and reviewed pension statement → ${SALARY_CERTIFICATE_TAX_ROW.column}`;
      }
      if (credit.id) existingTax.ids.push(credit.id);
      existingTax.entry.sourceEntryCount = Math.max(
        existingTax.entry.sourceEntryCount + 1,
        existingTax.ids.length,
      );
    } else {
      taxAgg.set(taxKey, {
        entry: {
          ourCategory:
            credit.source === "PENSION_SALARY_149"
              ? "PENSION_SALARY_149"
              : `TAX_${sectionUpper}`,
          ourDescription:
            irisCode === SALARY_CERTIFICATE_TAX_ROW.code &&
            credit.source === "SALARY_CERTIFICATE"
              ? `Section 149 salary withholding from mapped salary certificate → ${SALARY_CERTIFICATE_TAX_ROW.column}`
              : `${credit.section} - ${credit.subcategory} (${credit.source})`,
          ourAmount: amount,
          irisCode,
          irisDescription:
            irisDef?.description || `${credit.section} ${credit.subcategory}`,
          portalArea: irisDef?.portalArea || "Tax Chargeable / Payments",
          section: irisDef?.section || "Adjustable Tax",
          portalGroup: irisDef?.section || "Adjustable Tax",
          column: taxColumn,
          isTaxField: true,
          filerStatus: taxpayerListStatus || undefined,
          sourceEntryCount: 1,
        },
        ids: credit.id ? [credit.id] : [],
      });
    }
  }

  if (hasCertificateGrossSalary && certificateGrossSalary !== null) {
    const salaryCode = IRIS_CODES.SALARY_PAY_WAGES.code;
    const salaryDef = Object.values(IRIS_CODES).find(
      (definition: any) => definition.code === salaryCode,
    ) as any;
    totalIncome += certificateGrossSalary;
    addIncome(
      `${salaryCode}:${TOTAL_AMOUNT_COLUMN}`,
      () => ({
        ourCategory: "SALARY_CERTIFICATE_GROSS",
        ourDescription: "Annual gross salary from mapped salary certificate",
        ourAmount: certificateGrossSalary,
        irisCode: salaryCode,
        irisDescription:
          salaryDef?.description || "Pay, Wages or Other Remuneration",
        portalArea: salaryDef?.portalArea || "Employment",
        section: salaryDef?.section || "Salary",
        column: TOTAL_AMOUNT_COLUMN,
        isTaxField: false,
        filerStatus: taxpayerListStatus || undefined,
      }),
      "salary-certificate",
    );
  }

  // A legacy caller may still supply an engine split rather than a reviewed
  // source. Never silently collapse a partially/final-taxed pension to Total.
  // Age/former-employer semantics cannot be inferred from bank receipts alone.
  const legacyPensionTotal = pensionLedgerTotalForSplit;
  const legacyPensionManual = !pensionSource && ((pensionDetails?.taxableAmount ?? 0) > 0 || legacyPensionTotal > 10_000_000);
  if (legacyPensionManual) {
    for (const [key, field] of incomeAgg) {
      if (field.entry.irisCode === "1008") incomeAgg.delete(key);
    }
    unmapped.set("PENSION_UNAPPROVED_SPLIT", {
      category: "PENSION_UNAPPROVED_SPLIT", totalAmount: legacyPensionTotal || pensionDetails?.totalPension || 0,
      entryIds: pensionLedgerEntryIds,
      reason: "This legacy partial/above-limit pension has no approved annual-source contract. Review/map the latest Pension Statement and regenerate the packet. No Total-only pension write is queued; final-tax basis, actual withholding and surcharge must not be guessed.",
    });
  }

  let pensionManualReview: PortalMappingGaps["pensionManualReview"];
  if (pensionSource) {
    totalIncome += pensionSource.annualPension;
    if (pensionSource.treatment === "unknown_age") {
      // Packet generation already refuses this treatment. Keep an explicit map
      // gap for direct/legacy callers rather than making an age assumption.
      const reason = "Pension above PKR 10 million has no verified age treatment. Confirm the pensioner's age and regenerate the approved packet before portal entry.";
      pensionManualReview = { annualPension: pensionSource.annualPension, baseTax: pensionSource.baseTax, surcharge: pensionSource.surcharge, taxDue: pensionSource.taxDue, taxDeducted: pensionSource.taxDeducted, reason };
      unmapped.set("PENSION_UNKNOWN_AGE", { category: "PENSION_UNKNOWN_AGE", totalAmount: pensionSource.annualPension, entryIds: [], reason });
    } else {
      const exempt = pensionSource.treatment === "exempt" || pensionSource.treatment === "exempt_age70";
      const isFinalAboveLimit = pensionSource.treatment === "final_above_10m";
      // A non-final pension with actual withholding still has no captured,
      // source-specific tax-credit placement. Do not drop that credit merely to
      // make the income cells automatic.
      // A salary-treatment pension with withholding now has a verified
      // placement (64020004, see the synthetic 149 credit below), so it is not
      // reported as an unmapped credit. The exempt treatment still is: an
      // exempt pension carrying real withholding needs a human decision.
      const salaryTreatmentUses149 =
        pensionSource.treatment === "salary" &&
        !hasExplicitSalary149Credit &&
        toNumber(pensionSource.taxDeducted) > 0;
      if (!isFinalAboveLimit && pensionSource.taxDeducted > 0 && !salaryTreatmentUses149) {
        const reason = "Actual pension withholding has no verified IRIS placement for this non-final pension treatment. Regenerate after the withholding route is mapped.";
        pensionManualReview = { annualPension: pensionSource.annualPension, baseTax: pensionSource.baseTax, surcharge: pensionSource.surcharge, taxDue: pensionSource.taxDue, taxDeducted: pensionSource.taxDeducted, reason };
        unmapped.set("PENSION_WITHHOLDING_UNMAPPED", { category: "PENSION_WITHHOLDING_UNMAPPED", totalAmount: pensionSource.taxDeducted, entryIds: [], reason });
      } else {
      // Row 1008 must split the exempt threshold from the final-tax excess;
      // IRIS then derives both Normal Income = 0 and 64020007 = the excess.
      const finalTaxExcess = isFinalAboveLimit
        ? Math.max(0, pensionSource.annualPension - 10_000_000)
        : 0;
      const annual = isFinalAboveLimit
        ? String(Math.round(pensionSource.annualPension))
        : undefined;
      const excess = isFinalAboveLimit
        ? String(Math.round(finalTaxExcess))
        : undefined;
      for (const [column, value] of [
        ["Total Amount", pensionSource.annualPension],
        ["Subject to Final Tax", isFinalAboveLimit ? finalTaxExcess : 0],
        ["Subject to Exemption", isFinalAboveLimit ? 10_000_000 : exempt ? pensionSource.annualPension : 0],
      ] as const) {
        addIncome(`1008:${column}`, () => ({
          ourCategory: "PENSION", ourDescription: isFinalAboveLimit
            ? "Reviewed pension split between the PKR 10 million exemption and the final-tax excess."
            : `Reviewed annual pension (${pensionSource.treatment}); zero columns clear stale treatment subject to the overwrite guard`,
          ourAmount: value, irisCode: "1008", irisDescription: IRIS_CODES.SALARY_PENSION_ANNUITY.description,
          portalArea: "Employment", section: "Salary", column, isTaxField: false,
          ...(column === "Subject to Final Tax" && annual
            ? { replaceOnlyIfExisting: annual }
            : {}),
        }), pensionSource.documentId);
      }
      if (isFinalAboveLimit) {
        const pensionTaxDef = IRIS_CODES.FINAL_PENSION_OVER_10M;
        const addPensionTaxField = (
          column: Extract<PortalFieldMapEntry["column"], "Taxable Amount" | "Tax Deducted">,
          amount: number,
          replaceOnlyIfExisting?: string,
        ) => {
          const key = `${pensionTaxDef.code}:${column}`;
          if (holdUnprovenCode(pensionTaxDef.code, pensionTaxDef.description, "PENSION", amount)) return;
          taxAgg.set(key, {
            entry: {
              ourCategory: "PENSION_FINAL_TAX",
              ourDescription: column === "Taxable Amount"
                ? "Pension amount exceeding PKR 10 million only; IRIS applies 5% to this entered base."
                : "Actual pension tax deducted from the reviewed annual pension statement; never a calculated liability.",
              ourAmount: amount,
              irisCode: pensionTaxDef.code,
              irisDescription: pensionTaxDef.description,
              portalArea: pensionTaxDef.portalArea,
              section: pensionTaxDef.section,
              column,
              isTaxField: true,
              ...(replaceOnlyIfExisting ? { replaceOnlyIfExisting } : {}),
              sourceEntryCount: 1,
            },
            ids: [],
          });
        };
        addPensionTaxField("Taxable Amount", finalTaxExcess, annual);
        // The source is reviewed and explicitly permits zero, so clearing an
        // old deduction is deterministic. This is actual withholding only.
        addPensionTaxField("Tax Deducted", pensionSource.taxDeducted);
        const surchargeDef = IRIS_CODES.COMP_SURCHARGE;
        const extraNormalSurcharge = Math.max(
          0,
          Math.round(toNumber(additionalSection4ABSurcharge)),
        );
        const surcharge =
          Math.round(
            ((pensionSource.surcharge ?? 0) + extraNormalSurcharge) * 100,
          ) / 100;
        if (!holdUnprovenCode(surchargeDef.code, surchargeDef.description, "PENSION", surcharge)) {
          taxAgg.set(`${surchargeDef.code}:Total Income`, {
            entry: {
              ourCategory: "PENSION_SURCHARGE",
              ourDescription:
                extraNormalSurcharge > 0
                  ? "Section 4AB surcharge on calculated pension final tax plus high-income normal-slab tax."
                  : "Section 4AB surcharge on calculated pension tax.",
              ourAmount: surcharge,
              irisCode: surchargeDef.code,
              irisDescription: surchargeDef.description,
              portalArea: surchargeDef.portalArea,
              section: surchargeDef.section,
              column: "Total Income",
              isTaxField: true,
              sourceEntryCount: extraNormalSurcharge > 0 ? 2 : 1,
            },
            ids: [],
          });
        }
      }
      }
    }
  }

  // Pension post-pass (runs once, after every ledger row is folded in):
  // IRIS renders row 1008 with four columns. Total, Final and Exemption
  // are editable; Normal is computed — "Subject to Normal Tax" is derived by the
  // portal as Total − Final − Exemption. A fully-exempt pension (Section
  // 149(IA): pension at or under PKR 10M, former employer NOT involved) must
  // therefore additionally write the Exemption column; if only Total were
  // entered IRIS would push the whole pension into Normal Income and charge
  // salary slabs on an exempt amount (observed live: PKR 92,790 charged on a
  // PKR 1,989,000 exempt pension). The Total-column write above is untouched,
  // so the portal derives Normal = 0.
  if (pensionDetails && pensionLedgerTotalForSplit > 0) {
    const exemptAmount = pensionDetails.exemptAmount || 0;
    const taxableAmount = pensionDetails.taxableAmount || 0;
    const engineTotal = exemptAmount + taxableAmount;
    if (engineTotal > 0 && Math.abs(engineTotal - pensionLedgerTotalForSplit) > 0.5) {
      pensionSplitMismatch.push({
        entryId: pensionLedgerEntryIds.join(","),
        ledgerAmount: pensionLedgerTotalForSplit,
        engineSplitTotal: engineTotal,
      });
    }
    // Only a legacy fully-exempt below-limit case may continue here. The
    // partial/above-limit legacy path was held out with an explicit gap above.
    if (!legacyPensionManual && exemptAmount > 0 && !(taxableAmount > 0)) {
      const exemptColumn: PortalFieldMapEntry["column"] =
        "Subject to Exemption";
      const pensionDef = Object.values(IRIS_CODES).find(
        (c: any) => c.code === IRIS_CODES.SALARY_PENSION_ANNUITY.code,
      ) as any;
      addIncome(
        `${IRIS_CODES.SALARY_PENSION_ANNUITY.code}:${exemptColumn}`,
        () => ({
          ourCategory: "PENSION",
          ourDescription: `Pension exempt u/s 149(IA) — do not charge slabs (engine split)`,
          ourAmount: exemptAmount,
          irisCode: IRIS_CODES.SALARY_PENSION_ANNUITY.code,
          irisDescription:
            pensionDef?.description || "Pension / Annuity u/s 12(2)(f)",
          portalArea: pensionDef?.portalArea || "Employment",
          section: pensionDef?.section || "Salary",
          column: exemptColumn,
          isTaxField: false,
          filerStatus: taxpayerListStatus || undefined,
        }),
        pensionLedgerEntryIds[0],
      );
    }
  }

  for (const { entry } of incomeAgg.values()) incomeFields.push(entry);
  for (const { entry } of taxAgg.values()) adjustableTaxFields.push(entry);

  // Wealth Statement (116): the data the Mizan already holds, as IRIS cells.
  //  - Personal expenses -> the child rows the `+ Expenses` modal creates.
  //  - Salary tax deducted -> the row the Adjustments in Outflows `+` creates.
  //  Bank balances are deliberately absent: they belong on 7030 Bank Account(s),
  //  one row per IBAN, and 7012 is Cash in hand (see lib/tax/wealth-rows.ts).
  // The agent decides whether/when to enter these; the packet only carries them.
  const wealthExpenseTotals = new Map<
    string,
    { amount: number; ids: string[] }
  >();
  const wealthUnmappedExpenses = new Map<string, number>();
  const reconciliationOtherOutflow = { code: "7087" as const, amount: 0, entryIds: [] as string[] };
  for (const entry of ledgerEntries) {
    const isOtherOutflow = entry.entryType === "OTHER" && normalizeCategory(entry.category) === "RECONCILIATION_ADJUSTMENT_OUTFLOW";
    if ((!isOtherOutflow && entry.entryType !== "EXPENSE") || isBusinessBankCategory(entry.category)) continue;
    // Same client decision as above: a covered business tax payment is not a
    // personal Wealth expense and is not reported as an unmapped expense.
    if (
      params.businessBankEntriesCoveredByDeclaredProfit &&
      entry.entryType === "EXPENSE" &&
      normalizeCategory(entry.category) === "TAX_PAYMENT"
    ) {
      continue;
    }
    const amount = toNumber(entry.amount);
    if (amount <= 0) continue;
    const code = isOtherOutflow ? WEALTH_OTHER_EXPENSE_CODE : classifyExpenseToWealthCode(entry.category, entry.description);
    if (isOtherOutflow) {
      reconciliationOtherOutflow.amount += amount;
      if (entry.id) reconciliationOtherOutflow.entryIds.push(entry.id);
    }
    if (!code || !WEALTH_EXPENSE_ROWS[code]) {
      const cat = normalizeCategory(entry.category);
      wealthUnmappedExpenses.set(
        cat,
        (wealthUnmappedExpenses.get(cat) || 0) + amount,
      );
      continue;
    }
    const bucket = wealthExpenseTotals.get(code) || { amount: 0, ids: [] };
    bucket.amount += amount;
    if (entry.id) bucket.ids.push(entry.id);
    wealthExpenseTotals.set(code, bucket);
  }
  for (const [code, bucket] of [...wealthExpenseTotals.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    wealthFields.push({
      ourCategory: "PERSONAL_EXPENSE_TOTAL",
      ourDescription: `Personal expenses placed on IRIS "${WEALTH_EXPENSE_ROWS[code].label}"${code === WEALTH_OTHER_EXPENSE_CODE && reconciliationOtherOutflow.amount > 0 ? `; includes Auto Adjust outflow PKR ${reconciliationOtherOutflow.amount.toLocaleString("en-US")} under client-directed Other placement` : ""}`,
      ourAmount: Math.round(bucket.amount),
      irisCode: code,
      irisDescription: WEALTH_EXPENSE_ROWS[code].label,
      portalArea: "116 - Wealth Statement",
      section: "Reconciliation of Net Assets",
      column: "Amount",
      isTaxField: false,
      filerStatus: taxpayerListStatus || undefined,
      sourceEntryCount: bucket.ids.length,
    });
  }

  // Bank balances: one 7030 row per account, matched in IRIS by IBAN. 7012 is
  // "Cash in hand" and is never used for bank money.
  //
  // The reconciliation auto-adjustment (TaxRocket's balancing entry) is carried
  // by the declared closing balance of ONE account, the one holding the most
  // money: inflow adjustment N -> declared balance = statement balance - N.
  // Outflows instead go to 7087 under the client-confirmed policy above.
  // The legacy inflow treatment is only applied when the result stays
  // positive; otherwise the adjustment stays an unmapped, manual notice.
  const adjustmentEntries = ledgerEntries.filter(
    (entry) =>
      entry.entryType === "OTHER" &&
      normalizeCategory(entry.category) === "RECONCILIATION_ADJUSTMENT_INFLOW",
  );
  const signedAdjustment = adjustmentEntries.reduce(
    (sum, entry) =>
      sum +
      (normalizeCategory(entry.category).endsWith("_OUTFLOW") ? -1 : 1) *
        toNumber(entry.amount),
    0,
  );
  const sortedBankAccounts = [...bankAccounts].sort((a, b) =>
    a.iban.localeCompare(b.iban),
  );
  let adjustedAccount: (typeof bankAccounts)[number] | null = null;
  if (signedAdjustment !== 0) {
    for (const account of sortedBankAccounts) {
      const closing = toNumber(account.closingBalance);
      if (!account.iban || closing <= 0) continue;
      if (
        !adjustedAccount ||
        closing > toNumber(adjustedAccount.closingBalance)
      ) {
        adjustedAccount = account;
      }
    }
    if (
      adjustedAccount &&
      Math.round(toNumber(adjustedAccount.closingBalance) - signedAdjustment) <=
        0
    ) {
      adjustedAccount = null;
    }
  }
  let reconciliationAdjustment: PortalMappingGaps["reconciliationAdjustment"];
  for (const account of sortedBankAccounts) {
    const closing = toNumber(account.closingBalance);
    if (!account.iban || closing <= 0) continue;
    if (account.ownershipReviewRequired) {
      const key = `BUSINESS_BANK_OWNERSHIP_${account.iban}`;
      unmapped.set(key, { category: key, entryIds: [], totalAmount: closing,
        reason: "This account has approved business cash records. Confirm business/personal/mixed ownership and the correct FBR placement manually; it is not automatically entered as a personal Wealth bank balance." });
      continue;
    }
    const adjusted = account === adjustedAccount;
    const declared = adjusted ? closing - signedAdjustment : closing;
    if (adjusted) {
      reconciliationAdjustment = {
        signedAmount: Math.round(signedAdjustment),
        iban: account.iban,
        statementClosing: Math.round(closing),
        declaredClosing: Math.round(declared),
      };
    }
    wealthFields.push({
      ourCategory: "BANK_CLOSING_BALANCE",
      ourDescription: adjusted
        ? `${account.bankName} — ${account.accountLabel} closing balance, adjusted by the reconciliation ${
            signedAdjustment > 0 ? "decrease" : "increase"
          } of PKR ${Math.abs(Math.round(signedAdjustment)).toLocaleString("en-US")} (statement balance PKR ${Math.round(closing).toLocaleString("en-US")})`
        : `${account.bankName} — ${account.accountLabel} closing balance`,
      ourAmount: Math.round(declared),
      ...(adjusted ? { statementClosingBalance: Math.round(closing) } : {}),
      irisCode: WEALTH_BANK_ACCOUNT_CODE,
      irisDescription: `Bank Account(s) - ${account.iban}`,
      portalArea: "116 - Wealth Statement",
      section: "Personal Assets / Liabilities",
      column: "Amount",
      isTaxField: false,
      filerStatus: taxpayerListStatus || undefined,
      rowDescriptionIncludes: account.iban,
      sourceEntryCount: 1,
    });
  }

  // Cash in hand (7012). The taxpayer's own cash taken out of (or put into)
  // the bank. IRIS owns the opening figure (prefilled from the previous year),
  // so the packet carries only the movement and the agent adds it to what IRIS
  // already shows. A negative movement (net deposits) lowers the figure.
  const cashDelta =
    cashMovement === null || cashMovement === undefined
      ? 0
      : Math.round(toNumber(cashMovement));
  if (cashDelta !== 0) {
    wealthFields.push({
      ourCategory: "CASH_MOVEMENT",
      ourDescription:
        cashDelta > 0
          ? `Cash taken out of the bank (net PKR ${cashDelta.toLocaleString("en-US")}), added to Cash in hand`
          : `Cash put into the bank (net PKR ${Math.abs(cashDelta).toLocaleString("en-US")}), deducted from Cash in hand`,
      ourAmount: cashDelta,
      irisCode: CASH_IN_HAND_CODE,
      irisDescription: "Cash (Non-Business)",
      portalArea: "116 - Wealth Statement",
      section: "Personal Assets / Liabilities",
      column: "Amount",
      isTaxField: false,
      filerStatus: taxpayerListStatus || undefined,
      sourceEntryCount: 1,
      valueMode: VALUE_MODE_ADD_TO_IRIS,
    });
  }

  // Gifts received (7037). IRIS wants the donor in a dialog first; the agent
  // creates one child row per donor and date, then types the amount on it.
  for (const gift of [...giftAgg.values()].sort((a, b) =>
    `${a.date ?? ""}${a.donorId}`.localeCompare(`${b.date ?? ""}${b.donorId}`),
  )) {
    const description = gift.date
      ? `Gift received on ${gift.date} from ${gift.donorId}`
      : `Gift received during the tax year from ${gift.donorId}`;
    wealthFields.push({
      ourCategory: "GIFT_RECEIVED",
      ourDescription: `Gift received from ${gift.donorId}${gift.date ? ` on ${gift.date}` : ""}`,
      ourAmount: Math.round(gift.amount),
      irisCode: WEALTH_GIFT_CODE,
      irisDescription: `Gift - ${gift.donorId}`,
      portalArea: "116 - Wealth Statement",
      section: "Reconciliation of Net Assets",
      column: "Amount",
      isTaxField: false,
      filerStatus: taxpayerListStatus || undefined,
      rowDescriptionIncludes: description,
      giftDonorId: gift.donorId,
      giftDescription: description,
      sourceEntryCount: gift.count,
    });
  }

  if (reconciliationAdjustment) {
    // The adjustment is entered (as part of the bank balance), so it is no
    // longer an item that needs a manual IRIS entry.
    unmapped.delete("RECONCILIATION_ADJUSTMENT_INFLOW");
  }

  const salaryTaxOutflow =
    salaryCertificateTaxWithheld === null ||
    salaryCertificateTaxWithheld === undefined
      ? 0
      : toNumber(salaryCertificateTaxWithheld);
  if (salaryTaxOutflow > 0) {
    wealthFields.push({
      ourCategory: "SALARY_TAX_OUTFLOW",
      ourDescription: WEALTH_TAX_OUTFLOW_DESCRIPTION,
      ourAmount: Math.round(salaryTaxOutflow),
      irisCode: WEALTH_TAX_OUTFLOW_CODE,
      irisDescription: `Adjustments in Outflows - ${WEALTH_TAX_OUTFLOW_DESCRIPTION}`,
      portalArea: "116 - Wealth Statement",
      section: "Reconciliation of Net Assets",
      column: "Amount",
      isTaxField: false,
      filerStatus: taxpayerListStatus || undefined,
      // IRIS words the created row "Adjustments in Outflows - <description>"
      // and every such row shares the id 7098; only ours may be written.
      rowDescriptionIncludes: WEALTH_TAX_OUTFLOW_DESCRIPTION,
      sourceEntryCount: 1,
    });
  }

  return {
    // 1.1.0 — one field per IRIS cell (aggregated), entered-column targeting,
    // computed rows and unverified categories reported instead of guessed.
    version: "1.1.0",
    generatedAt: new Date().toISOString(),
    taxYear,
    filerType,
    taxpayerListStatus,
    totalFields:
      incomeFields.length + adjustableTaxFields.length + wealthFields.length,
    incomeFields,
    adjustableTaxFields,
    wealthFields,
    ...(employers.length > 0 ? { employers } : {}),
    mappingGaps: {
      ...(businessBankRecords.entryCount ? { businessBankRecords } : {}),
      wealthUnmappedExpenses: [...wealthUnmappedExpenses.entries()]
        .map(([category, totalAmount]) => ({ category, totalAmount }))
        .sort((a, b) => a.category.localeCompare(b.category)),
      unmappedCategories: [...unmapped.values()].sort((a, b) =>
        a.category.localeCompare(b.category),
      ),
      ...(coveredLedgerEntries.length ? { coveredLedgerEntries } : {}),
      ...(reconciliationAdjustment ? { reconciliationAdjustment } : {}),
      ...(reconciliationOtherOutflow.amount > 0 ? { reconciliationOtherOutflow } : {}),
      skippedComputedCodes: [...skipped.values()].sort((a, b) =>
        a.code.localeCompare(b.code),
      ),
      captureUnverified: [...unproven.values()].sort((a, b) =>
        a.code.localeCompare(b.code),
      ),
      pensionSplitMismatch,
      ...(pensionManualReview ? { pensionManualReview } : {}),
    },
    computationHints: {
      totalIncome,
      taxableIncome,
      totalTaxWithheld: taxWithheld,
      ...(hasCertificateGrossSalary
        ? { salaryCertificateTaxWithheld: certSalaryTaxWithheld }
        : {}),
      ...(pensionSource?.treatment === "final_above_10m" &&
      Math.max(0, Math.round(toNumber(additionalSection4ABSurcharge))) > 0
        ? {
            normalSlabSurcharge: Math.max(
              0,
              Math.round(toNumber(additionalSection4ABSurcharge)),
            ),
          }
        : {}),
      pensionExemptLimit: pensionDetails?.exemptLimit,
      pensionExemptAmount: pensionDetails?.exemptAmount,
      pensionTaxableAmount: pensionDetails?.taxableAmount,
      pensionSourceFingerprint: pensionSource?.fingerprint,
      pensionTreatment: pensionSource?.treatment,
    },
    selectorBundle: {
      version: "v1.1-2026-09-09-iris2-capture",
      portalType: "AUTO",
    },
  };
}

/**
 * Helper to build a minimal portalFieldMap for testing
 */
export function buildTestPortalFieldMap(): PortalFieldMap {
  return buildPortalFieldMap({
    taxYear: 2026,
    filerType: "SALARIED",
    taxpayerListStatus: "ATL",
    ledgerEntries: [
      {
        id: "test-1",
        entryType: "INCOME",
        category: "SALARY",
        description: "Salary",
        amount: 3000000,
      },
      {
        id: "test-2",
        entryType: "INCOME",
        category: "BANK_PROFIT",
        description: "Bank profit",
        amount: 1000000,
      },
      {
        id: "test-3",
        entryType: "INCOME",
        category: "RENT",
        description: "Rent",
        amount: 1500000,
      },
    ],
    taxCredits: [
      {
        id: "tax-1",
        section: "149",
        subcategory: "salary",
        amount: 200000,
        source: "SALARY",
      },
      {
        id: "tax-2",
        section: "236C",
        subcategory: "immovable-property-transfer",
        amount: 2250000,
        source: "ADVANCE_TAX",
      },
    ],
    taxableIncome: 5500000,
    taxWithheld: 2450000,
  });
}
