import businessContract from "../../electron-connect/iris-business-contract.json";
import servicesCaptureContract from "../../electron-connect/iris-services-contract.json";

/**
 * Evidence-gated TY2026 Services → IRIS mapping registry.
 *
 * This module resolves exact candidates from reviewed source evidence and the
 * captured IRIS contracts. It never performs a portal write or changes tax
 * calculations. Phase 4 packet/agent adapters may queue only the candidates
 * that pass every gate below.
 */
export const SERVICES_TY2026_SUBCATEGORIES = [
  "1b-service-certain",
  "1b-service-it-ites",
  "1b-service-advertising-media",
  "1b-service-other",
  "2-services-to-exporter",
  "export-it-ites-pseb",
  "export-services-other",
] as const;

export type ServicesTy2026Subcategory =
  (typeof SERVICES_TY2026_SUBCATEGORIES)[number];
export type ServicesWithholdingSection = "153(1)(b)" | "153(2)" | "154A";
export type ServicesWithholdingCaptureGroup =
  | "adjustableTax"
  | "minimumTax"
  | "finalTax";
export type ServicesWithholdingPortalGroup =
  | "Adjustable Tax"
  | "Minimum Tax"
  | "Final Tax";
export type ServicesWithholdingPortalColumn =
  | "Tax Deducted"
  | "Tax Collected / Deducted";

/**
 * Where the Services withholding rows actually live in the TY2026 114(1) form.
 *
 * Captured evidence (business-income/10,34,35,56,66,67): the rate rows render on
 * the **Business** left panel, **Tax Deduction** tab, inside that tab's own
 * group accordions (Adjustable Tax / Minimum Tax / Final Tax). The earlier
 * "Tax Chargeable / Payments > Withholding Tax" route is a different view: it
 * renders only the locked summary rows 64000101-64000103, so every navigation
 * there ended in `row_not_found` / `unsupported_grid_rows` and nothing filled.
 *
 * Kept as named constants because this pair is asserted in three places:
 * the capture contract JSON, the cell resolver below, and the Electron
 * navigation allowlist.
 */
export const SERVICES_WITHHOLDING_PORTAL_AREA = "Business" as const;
export const SERVICES_WITHHOLDING_PORTAL_SECTION = "Tax Deduction" as const;
export type ServicesWithholdingPortalArea =
  typeof SERVICES_WITHHOLDING_PORTAL_AREA;
export type ServicesWithholdingPortalSection =
  typeof SERVICES_WITHHOLDING_PORTAL_SECTION;

/**
 * Section/subsection comes from the TY2026 Services rate-card catalog. It is
 * kept separate from the withholding amount and does not assign tax treatment.
 */
const APPROVED_SERVICES_MAPPING = (servicesCaptureContract as any)
  .approvedServicesMapping as {
    incomeRow3101: {
      incomeCharacter: ServicesIncomeCharacter;
      irisCode: "3101";
      portalArea: "Business";
      portalSection: "Other Revenues";
      column: "Total Amount";
      rowLabel: "Fee for Technical / Professional Services";
    };
    withholdingBySubcategory: Record<
      ServicesTy2026Subcategory,
      { statutorySection: ServicesWithholdingSection; irisCodes: string[] }
    >;
  };

export const SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY: Readonly<
  Record<ServicesTy2026Subcategory, ServicesWithholdingSection>
> = Object.fromEntries(
  Object.entries(APPROVED_SERVICES_MAPPING.withholdingBySubcategory).map(
    ([subcategory, mapping]) => [subcategory, mapping.statutorySection],
  ),
) as Record<ServicesTy2026Subcategory, ServicesWithholdingSection>;

/**
 * TY2026 FBR return-code candidates, reconciled with the user-supplied live
 * IRIS row capture. `officialReturnPage` is null for IRIS-only rows that do not
 * appear in the transcribed S.R.O. 1495(I)/2026 code list. `captureGroupId`,
 * `portalGroup`, `portalColumn`, and `inputIndex` come from the sanitized DOM
 * contract; none of them are inferred from a rate or from another tax schedule.
 *
 * Rows without an explicit category mapping below are recorded for visibility
 * but remain manual. In particular, a rate-only resemblance is not sufficient
 * to map an unlisted/special code to a Services category.
 */
export const SERVICES_WITHHOLDING_IRIS_ROW_CANDIDATES = [
  {
    irisCode: "64060116",
    statutorySection: "153(1)(b)",
    description:
      "Payment for Services u/s 153(1)(b) @8% u/c (42) of Part IV of Second Schedule",
    officialReturnPage: null,
    evidenceSource: "USER_IRIS_CAPTURE_ONLY",
    captureGroupId: "adjustableTax",
    portalGroup: "Adjustable Tax",
    portalColumn: "Tax Deducted",
    inputIndex: 1,
  },
  {
    irisCode: "64060151",
    statutorySection: "153(1)(b)",
    description: "Payment for Services u/s 153(1)(b) @0.5%",
    officialReturnPage: 104,
    evidenceSource: "TY2026_RETURN_AND_USER_IRIS_CAPTURE",
    captureGroupId: "minimumTax",
    portalGroup: "Minimum Tax",
    portalColumn: "Tax Collected / Deducted",
    inputIndex: 1,
  },
  {
    irisCode: "64060152",
    statutorySection: "153(1)(b)",
    description: "Payment for Services u/s 153(1)(b) @1%",
    officialReturnPage: 104,
    evidenceSource: "TY2026_RETURN_AND_USER_IRIS_CAPTURE",
    captureGroupId: "minimumTax",
    portalGroup: "Minimum Tax",
    portalColumn: "Tax Collected / Deducted",
    inputIndex: 1,
  },
  {
    irisCode: "64060153",
    statutorySection: "153(1)(b)",
    description: "Payment for Services u/s 153(1)(b) @1.5%",
    officialReturnPage: 104,
    evidenceSource: "TY2026_RETURN_AND_USER_IRIS_CAPTURE",
    captureGroupId: "minimumTax",
    portalGroup: "Minimum Tax",
    portalColumn: "Tax Collected / Deducted",
    inputIndex: 1,
  },
  {
    irisCode: "64060156",
    statutorySection: "153(1)(b)",
    description: "Payment for Services u/s 153(1)(b) @3%",
    officialReturnPage: null,
    evidenceSource: "USER_IRIS_CAPTURE_ONLY",
    captureGroupId: "minimumTax",
    portalGroup: "Minimum Tax",
    portalColumn: "Tax Collected / Deducted",
    inputIndex: 1,
  },
  {
    irisCode: "64060158",
    statutorySection: "153(1)(b)",
    description: "Payment for IT/IT-enabled service u/s 153(1)(b) @4%",
    officialReturnPage: 104,
    evidenceSource: "TY2026_RETURN_AND_USER_IRIS_CAPTURE",
    captureGroupId: "minimumTax",
    portalGroup: "Minimum Tax",
    portalColumn: "Tax Collected / Deducted",
    inputIndex: 1,
  },
  {
    irisCode: "64060162",
    statutorySection: "153(1)(b)",
    description: "Payment for specified services u/s 153(1)(b) @6%",
    officialReturnPage: 104,
    evidenceSource: "TY2026_RETURN_AND_USER_IRIS_CAPTURE",
    captureGroupId: "minimumTax",
    portalGroup: "Minimum Tax",
    portalColumn: "Tax Collected / Deducted",
    inputIndex: 1,
  },
  {
    irisCode: "64060180",
    statutorySection: "153(1)(b)",
    description: "Payment for Services u/s 153(1)(b) @15%",
    officialReturnPage: 105,
    evidenceSource: "TY2026_RETURN_AND_USER_IRIS_CAPTURE",
    captureGroupId: "minimumTax",
    portalGroup: "Minimum Tax",
    portalColumn: "Tax Collected / Deducted",
    inputIndex: 1,
  },
  {
    irisCode: "64060352",
    statutorySection: "153(2)",
    description: "Fee for Export related Services u/s 153(2) @1%",
    officialReturnPage: 105,
    evidenceSource: "TY2026_RETURN_AND_USER_IRIS_CAPTURE",
    captureGroupId: "minimumTax",
    portalGroup: "Minimum Tax",
    portalColumn: "Tax Collected / Deducted",
    inputIndex: 1,
  },
  {
    irisCode: "64060555",
    statutorySection: "153(1)(b)",
    description: "Payment for Specified Services u/s 153(1)(b) @2%",
    officialReturnPage: null,
    evidenceSource: "USER_IRIS_CAPTURE_ONLY",
    captureGroupId: "minimumTax",
    portalGroup: "Minimum Tax",
    portalColumn: "Tax Collected / Deducted",
    inputIndex: 1,
  },
  {
    irisCode: "64060285",
    statutorySection: "154A",
    description: "Export of services u/s 154A @1%",
    officialReturnPage: 100,
    evidenceSource: "TY2026_RETURN_AND_USER_IRIS_CAPTURE",
    captureGroupId: "finalTax",
    portalGroup: "Final Tax",
    portalColumn: "Tax Deducted",
    inputIndex: 1,
  },
  {
    irisCode: "64060290",
    statutorySection: "154A",
    description: "Export of IT/ITeS Services u/s 154A @ 0.25%",
    officialReturnPage: 100,
    evidenceSource: "TY2026_RETURN_AND_USER_IRIS_CAPTURE",
    captureGroupId: "finalTax",
    portalGroup: "Final Tax",
    portalColumn: "Tax Deducted",
    inputIndex: 1,
  },
] as const;

export type ServicesWithholdingIrisCode =
  (typeof SERVICES_WITHHOLDING_IRIS_ROW_CANDIDATES)[number]["irisCode"];
type ServicesWithholdingIrisRowCandidate =
  (typeof SERVICES_WITHHOLDING_IRIS_ROW_CANDIDATES)[number];

/**
 * Conservative category-to-row crosswalk against the TY2026 rate catalog and
 * S.R.O. 1495(I)/2026 return rows. Every route still requires the exact code in
 * source withholding evidence; neither ATL status nor a tax rate is inferred.
 *
 * - 153(1)(b) certain services (6% ATL) → 64060162; the return says
 *   "specified services", so the category still requires human confirmation.
 * - IT/ITeS (4% ATL) → 64060158 (the return label names IT/IT-enabled).
 * - advertising/media (1.5% ATL) → 64060153. The live-only 3% row 64060156
 *   resembles the catalog's 3% non-ATL advertising rate, but its generic label
 *   and absence from the printed TY2026 code pages keep it manual.
 * - residual other services (15% ATL) → 64060180.
 * - services to exporters/export houses (1% ATL, 153(2)) → 64060352.
 * - PSEB export IT/ITeS (0.25%, 154A) → 64060290; other export services
 *   (1%, 154A) → 64060285.
 *
 * The 8% special-clause row 64060116, 2% specified-services row 64060555,
 * and 0.5%/1% service rows 64060151/64060152 remain manual: a matching rate
 * alone does not prove a supported category or statutory treatment.
 */
export const SERVICES_WITHHOLDING_IRIS_CODES_BY_SUBCATEGORY: Readonly<
  Record<ServicesTy2026Subcategory, readonly ServicesWithholdingIrisCode[]>
> = Object.fromEntries(
  Object.entries(APPROVED_SERVICES_MAPPING.withholdingBySubcategory).map(
    ([subcategory, mapping]) => [subcategory, mapping.irisCodes],
  ),
  ) as unknown as Record<ServicesTy2026Subcategory, readonly ServicesWithholdingIrisCode[]>;

export const SERVICES_INCOME_CHARACTERS = [
  "TECHNICAL_PROFESSIONAL_FEE",
  "OTHER_SERVICES",
  "UNCLASSIFIED",
] as const;
export type ServicesIncomeCharacter =
  (typeof SERVICES_INCOME_CHARACTERS)[number];

export type ServicesIncomeIrisMappingResult =
  | {
      status: "MAPPED_CANDIDATE";
      mapping: {
        irisCode: "3101";
        rowDescription: "Fee for Technical / Professional Services";
        irisGroup: "Business";
        irisSectionId: "business_other_revenues";
        irisSection: "Other Revenues";
        column: "Total Amount";
        columnIndex: 0;
        incomeCharacter: "TECHNICAL_PROFESSIONAL_FEE";
        evidenceReference: string;
        /** Packet may queue the exact candidate; the agent still verifies target and readback. */
        autoFillAllowed: true;
      };
    }
  | { status: "MANUAL_REVIEW"; reason: string };

type BusinessOtherRevenuesContract = {
  group?: string;
  tab?: string;
  columns?: string[];
  rows?: Record<string, { label?: string; disabled?: boolean[] }>;
};

const BUSINESS_OTHER_REVENUES = (businessContract as any)
  .business_other_revenues as BusinessOtherRevenuesContract | undefined;

type ServicesCaptureRow = {
  label?: string;
  writableInputIndexes?: number[];
  disabledInputIndexes?: number[];
};

type ServicesCaptureGrid = {
  label?: string;
  columns?: string[];
  inputColumns?: string[];
  rows?: Record<string, ServicesCaptureRow>;
};

export type ServicesIrisCaptureContract = {
  taxDeductions?: {
    portalArea?: string;
    portalSection?: string;
    groups?: Partial<Record<ServicesWithholdingCaptureGroup, ServicesCaptureGrid>>;
  };
  businessOtherRevenues?: {
    portalArea?: string;
    portalSection?: string;
    columns?: string[];
    rows?: Record<string, ServicesCaptureRow>;
  };
};

const SERVICES_IRIS_CAPTURE = servicesCaptureContract as ServicesIrisCaptureContract;

/**
 * Return the exact captured Tax Deducted input for a code, only if its row
 * label, portal group, full headers, input header, and enabled input position
 * still agree with the sanitized live-IRIS contract. This is read-only evidence;
 * it is not a portal writer.
 */
export function capturedServicesWithholdingCell(
  code: string,
  capture: ServicesIrisCaptureContract = SERVICES_IRIS_CAPTURE,
): {
  portalArea: ServicesWithholdingPortalArea;
  portalSection: ServicesWithholdingPortalSection;
  portalGroup: ServicesWithholdingPortalGroup;
  column: ServicesWithholdingPortalColumn;
  columnIndex: 1;
} | null {
  const candidate = SERVICES_WITHHOLDING_IRIS_ROW_CANDIDATES.find(
    (row) => row.irisCode === code,
  );
  if (!candidate) return null;

  const taxDeductions = capture.taxDeductions;
  if (
    taxDeductions?.portalArea !== SERVICES_WITHHOLDING_PORTAL_AREA ||
    taxDeductions.portalSection !== SERVICES_WITHHOLDING_PORTAL_SECTION
  )
    return null;

  const grid = taxDeductions.groups?.[candidate.captureGroupId];
  if (!grid || grid.label !== candidate.portalGroup) return null;
  const inputColumns = grid.inputColumns ?? [];
  if (JSON.stringify(grid.columns?.slice(2) ?? []) !== JSON.stringify(inputColumns))
    return null;
  const columnIndex = inputColumns.indexOf(candidate.portalColumn);
  if (columnIndex !== candidate.inputIndex) return null;

  const row = grid.rows?.[candidate.irisCode];
  if (
    row?.label !== candidate.description ||
    !row.writableInputIndexes?.includes(columnIndex) ||
    row.disabledInputIndexes?.includes(columnIndex)
  )
    return null;

  return {
    portalArea: SERVICES_WITHHOLDING_PORTAL_AREA,
    portalSection: SERVICES_WITHHOLDING_PORTAL_SECTION,
    portalGroup: candidate.portalGroup,
    column: candidate.portalColumn,
    columnIndex: 1,
  };
}

function businessTechnicalFeeRow3101IsCapturedEditable() {
  const incomeRow = APPROVED_SERVICES_MAPPING.incomeRow3101;
  const columnIndex = BUSINESS_OTHER_REVENUES?.columns?.indexOf(incomeRow.column);
  const oldRow = BUSINESS_OTHER_REVENUES?.rows?.[incomeRow.irisCode];
  const liveCapture = SERVICES_IRIS_CAPTURE.businessOtherRevenues;
  const liveColumnIndex = liveCapture?.columns?.indexOf(incomeRow.column);
  const liveRow = liveCapture?.rows?.[incomeRow.irisCode];

  return Boolean(
    BUSINESS_OTHER_REVENUES?.group === incomeRow.portalArea &&
      BUSINESS_OTHER_REVENUES?.tab === incomeRow.portalSection &&
      columnIndex === 0 &&
      oldRow?.label === incomeRow.rowLabel &&
      oldRow.disabled?.[columnIndex] === false &&
      liveCapture?.portalArea === incomeRow.portalArea &&
      liveCapture.portalSection === incomeRow.portalSection &&
      liveColumnIndex === 0 &&
      liveRow?.label === incomeRow.rowLabel &&
      liveRow.writableInputIndexes?.includes(0) &&
      !liveRow.disabledInputIndexes?.includes(0),
  );
}

function cleanEvidenceReference(value: unknown): string | null {
  const reference = String(value ?? "").trim();
  return reference && reference.length <= 500 ? reference : null;
}

/**
 * Row 3101 is only a candidate where a person has reviewed the invoice and
 * explicitly confirmed that the documented service is a technical/professional
 * fee. A selected tax subcategory, AI description, or generic Services label is
 * not enough by itself.
 */
export function resolveServicesIncomeIrisMapping(input: {
  subcategory: string;
  serviceCategoryHumanConfirmed: boolean;
  serviceCategoryEvidenceReference: string | null;
  invoiceEvidenceStatus: string;
  sourceDocumentExtractionStatus: string;
  sourceDocumentId: string | null;
  serviceDescription: string | null;
  incomeCharacter: ServicesIncomeCharacter;
  humanConfirmed: boolean;
  classificationEvidenceReference: string | null;
}): ServicesIncomeIrisMappingResult {
  if (!SERVICES_TY2026_SUBCATEGORIES.includes(input.subcategory as ServicesTy2026Subcategory))
    return { status: "MANUAL_REVIEW", reason: "Choose a supported TY2026 Services category before mapping an IRIS income row." };
  if (
    !input.serviceCategoryHumanConfirmed ||
    !cleanEvidenceReference(input.serviceCategoryEvidenceReference)
  )
    return { status: "MANUAL_REVIEW", reason: "A human-reviewed Services subcategory and invoice/contract reference are required before mapping an IRIS income row." };
  if (input.invoiceEvidenceStatus !== "CONFIRMED")
    return { status: "MANUAL_REVIEW", reason: "Confirm the invoice evidence before considering an IRIS income-row mapping." };
  if (input.sourceDocumentExtractionStatus !== "MAPPED" || !input.sourceDocumentId?.trim())
    return { status: "MANUAL_REVIEW", reason: "A mapped source invoice document is required for an IRIS income-row mapping." };
  if (!input.serviceDescription?.trim())
    return { status: "MANUAL_REVIEW", reason: "The invoice service description is missing; do not infer an IRIS income row." };
  if (input.incomeCharacter !== "TECHNICAL_PROFESSIONAL_FEE")
    return { status: "MANUAL_REVIEW", reason: "Only an explicitly reviewed technical/professional-fee case is a candidate for IRIS row 3101; other Services remain manual." };
  if (!input.humanConfirmed)
    return { status: "MANUAL_REVIEW", reason: "A human must confirm the technical/professional-fee classification from the source evidence." };
  const evidenceReference = cleanEvidenceReference(input.classificationEvidenceReference);
  if (!evidenceReference)
    return { status: "MANUAL_REVIEW", reason: "Record the invoice page, contract clause, or other source reference supporting the technical/professional-fee classification." };
  if (!businessTechnicalFeeRow3101IsCapturedEditable())
    return { status: "MANUAL_REVIEW", reason: "The saved IRIS Business / Other Revenues captures no longer prove row 3101's Total Amount cell is editable." };

  return {
    status: "MAPPED_CANDIDATE",
    mapping: {
      irisCode: "3101",
      rowDescription: "Fee for Technical / Professional Services",
      irisGroup: "Business",
      irisSectionId: "business_other_revenues",
      irisSection: "Other Revenues",
      column: "Total Amount",
      columnIndex: 0,
      incomeCharacter: "TECHNICAL_PROFESSIONAL_FEE",
      evidenceReference,
      autoFillAllowed: true,
    },
  };
}

export type ServicesWithholdingIrisMappingResult =
  | { status: "NO_WITHHOLDING"; reason: string }
  | { status: "MANUAL_REVIEW"; reason: string }
  | {
      status: "CAPTURE_REQUIRED";
      expectedSection: ServicesWithholdingSection;
      candidate: ServicesWithholdingIrisRowCandidate & {
        expectedPortalGroup: ServicesWithholdingPortalGroup;
        expectedColumn: ServicesWithholdingPortalColumn;
        expectedInputIndex: 1;
      };
      reason: string;
    }
  | {
      status: "MAPPED_CANDIDATE";
      expectedSection: ServicesWithholdingSection;
      mapping: {
        irisCode: ServicesWithholdingIrisCode;
        irisSectionId: "business_tax_deduction";
        portalArea: ServicesWithholdingPortalArea;
        portalSection: ServicesWithholdingPortalSection;
        portalGroup: ServicesWithholdingPortalGroup;
        column: ServicesWithholdingPortalColumn;
        columnIndex: 1;
        withholdingAmountPkr: number;
        evidenceReference: string;
        /** Packet may queue the exact candidate; the agent still verifies target and readback. */
        autoFillAllowed: true;
      };
    };

/**
 * A tax category alone never chooses a withholding row. The exact section, code
 * and evidence reference must be reviewed from the payer/bank tax document.
 * The captured portal group and exact editable column are then returned from
 * the Services-specific DOM contract. No adjustable/minimum/final-tax treatment
 * or ATL status is inferred.
 */
export function resolveServicesWithholdingIrisMapping(input: {
  subcategory: string;
  serviceCategoryHumanConfirmed: boolean;
  serviceCategoryEvidenceReference: string | null;
  withholdingAmountPkr: number;
  observedSection: string | null;
  observedIrisCode: string | null;
  sourceEvidenceMapped: boolean;
  withholdingEvidenceHumanConfirmed: boolean;
  evidenceReference: string | null;
}): ServicesWithholdingIrisMappingResult {
  if (typeof input.withholdingAmountPkr !== "number" || !Number.isFinite(input.withholdingAmountPkr) || input.withholdingAmountPkr < 0)
    return { status: "MANUAL_REVIEW", reason: "Withholding amount must be a verified non-negative PKR amount." };
  if (input.withholdingAmountPkr === 0)
    return { status: "NO_WITHHOLDING", reason: "No positive Services withholding amount was recorded; no IRIS withholding row is created." };
  if (!SERVICES_TY2026_SUBCATEGORIES.includes(input.subcategory as ServicesTy2026Subcategory))
    return { status: "MANUAL_REVIEW", reason: "Choose a supported TY2026 Services category before mapping withholding." };
  if (
    !input.serviceCategoryHumanConfirmed ||
    !cleanEvidenceReference(input.serviceCategoryEvidenceReference)
  )
    return { status: "MANUAL_REVIEW", reason: "A human-reviewed Services category and invoice/contract reference are required before crosswalking a withholding code." };
  const expectedSection = SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY[input.subcategory as ServicesTy2026Subcategory];
  if (String(input.observedSection ?? "").trim() !== expectedSection)
    return { status: "MANUAL_REVIEW", reason: `The source document must explicitly support statutory section ${expectedSection}; do not infer it from a bank credit or invoice category.` };
  if (!input.sourceEvidenceMapped || !cleanEvidenceReference(input.evidenceReference))
    return { status: "MANUAL_REVIEW", reason: "A mapped withholding certificate/statement and a page or line reference are required." };
  if (!input.withholdingEvidenceHumanConfirmed)
    return { status: "MANUAL_REVIEW", reason: "A human must confirm the withholding amount, statutory section, and IRIS code against the mapped withholding evidence." };

  const subcategory = input.subcategory as ServicesTy2026Subcategory;
  const eligibleCodes = SERVICES_WITHHOLDING_IRIS_CODES_BY_SUBCATEGORY[subcategory];
  const candidate = SERVICES_WITHHOLDING_IRIS_ROW_CANDIDATES.find(
    (row) =>
      row.irisCode === String(input.observedIrisCode ?? "").trim() &&
      row.statutorySection === expectedSection &&
      eligibleCodes.includes(row.irisCode),
  );
  if (!candidate)
    return { status: "MANUAL_REVIEW", reason: `The evidenced IRIS code is not a verified TY2026 row candidate for category ${subcategory} under section ${expectedSection}; keep unmatched, special-rate, and live-capture-only codes manual.` };

  const capturedCell = capturedServicesWithholdingCell(candidate.irisCode);
  if (!capturedCell)
    return {
      status: "CAPTURE_REQUIRED",
      expectedSection,
      candidate: {
        ...candidate,
        expectedPortalGroup: candidate.portalGroup,
        expectedColumn: candidate.portalColumn,
        expectedInputIndex: candidate.inputIndex,
      },
      reason: `The TY2026 candidate code ${candidate.irisCode} has no matching Services-specific live capture proving its ${candidate.portalGroup} row and editable ${candidate.portalColumn} input. Keep this withholding manual until that exact row is recaptured.`,
    };

  const evidenceReference = cleanEvidenceReference(input.evidenceReference)!;
  return {
    status: "MAPPED_CANDIDATE",
    expectedSection,
    mapping: {
      irisCode: candidate.irisCode,
      irisSectionId: "business_tax_deduction",
      portalArea: capturedCell.portalArea,
      portalSection: capturedCell.portalSection,
      portalGroup: capturedCell.portalGroup,
      column: capturedCell.column,
      columnIndex: capturedCell.columnIndex,
      withholdingAmountPkr: Math.round(input.withholdingAmountPkr * 100) / 100,
      evidenceReference,
      autoFillAllowed: true,
    },
  };
}
