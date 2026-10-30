import { SERVICES_WITHHOLDING_DOCUMENT_TYPES } from "./services-withholding-evidence";
import type { PortalFieldMapEntry } from "./portal-field-map";
import {
  SERVICES_WITHHOLDING_IRIS_ROW_CANDIDATES,
  resolveServicesIncomeIrisMapping,
  resolveServicesWithholdingIrisMapping,
} from "./services-iris-mapping";

type MoneyLike = number | string | { toString(): string } | null | undefined;

type ServicesPortalPaymentMatch = {
  id: string;
  withholdingTaxPkr: MoneyLike;
  withholdingSection: string | null;
  withholdingIrisCode: string | null;
  withholdingEvidenceReference: string | null;
  withholdingEvidenceHumanConfirmed: boolean;
  withholdingEvidenceDocumentId: string | null;
  withholdingEvidenceDocumentExtractionStatus: string | null;
  withholdingEvidenceDocumentType: string | null;
};

export type ServicesPortalInvoice = {
  id: string;
  subcategory: string | null;
  evidenceStatus: string;
  sourceDocumentId: string | null;
  sourceDocumentExtractionStatus: string;
  serviceDescription: string | null;
  serviceCategoryHumanConfirmed: boolean;
  serviceCategoryEvidenceReference: string | null;
  incomeCharacter: string | null;
  incomeCharacterHumanConfirmed: boolean;
  incomeCharacterEvidenceReference: string | null;
  recognizedIncomePkr: number;
  paymentMatches: ServicesPortalPaymentMatch[];
};

type ServicesPortalTaxCredit = {
  id: string;
  section: string;
  amount: MoneyLike;
  sourceDocumentId?: string | null;
};

type UnmappedServiceAmount = {
  category: string;
  entryIds: string[];
  totalAmount: number;
  reason: string;
};

const SERVICES_WITHHOLDING_EVIDENCE_TYPES = SERVICES_WITHHOLDING_DOCUMENT_TYPES;

function cents(value: MoneyLike): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value.toString());
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function pkr(centsValue: number): number {
  return Math.round(centsValue) / 100;
}

function normaliseSection(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, "").toUpperCase();
}

function categoryKey(subcategory: string) {
  return `SERVICES_${subcategory.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function unique(values: (string | null | undefined)[]): string[] {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

/**
 * Build only the Services rows whose evidence gates pass. Generic/unmatched
 * Services income and withholding remain explicit manual gaps. No tax treatment
 * is inferred here; this is an IRIS-row routing adapter only.
 */
export function buildServicesPortalMappings(input: {
  invoices: ServicesPortalInvoice[];
  incomeBySubcategory: Record<string, number>;
  existingBusinessFields?: readonly PortalFieldMapEntry[];
  taxCredits?: readonly ServicesPortalTaxCredit[];
}): {
  businessFields: PortalFieldMapEntry[];
  withholdingFields: PortalFieldMapEntry[];
  incomeGaps: UnmappedServiceAmount[];
  withholdingGaps: UnmappedServiceAmount[];
  mappedIncomeBySubcategory: Record<string, number>;
  taxCreditIdsToSuppress: string[];
  duplicateTaxCreditIds: string[];
} {
  const businessFields: PortalFieldMapEntry[] = [];
  const incomeReasons = new Map<string, Set<string>>();
  const unmappedInvoiceIds = new Map<string, string[]>();
  const mappedIncomeCents = new Map<string, number>();
  const businessTargetAlreadyOccupied = (input.existingBusinessFields ?? []).some(
    (field) => field.irisCode === "3101" && field.column === "Total Amount",
  );

  const mappedIncomeRows: Array<{
    invoice: ServicesPortalInvoice;
    amountCents: number;
    evidenceReference: string;
  }> = [];

  for (const invoice of input.invoices) {
    const amountCents = Math.max(0, Math.round(invoice.recognizedIncomePkr * 100));
    if (amountCents <= 0) continue;
    const subcategory = String(invoice.subcategory ?? "");
    const resolution = resolveServicesIncomeIrisMapping({
      subcategory,
      serviceCategoryHumanConfirmed: invoice.serviceCategoryHumanConfirmed,
      serviceCategoryEvidenceReference: invoice.serviceCategoryEvidenceReference,
      invoiceEvidenceStatus: invoice.evidenceStatus,
      sourceDocumentExtractionStatus: invoice.sourceDocumentExtractionStatus,
      sourceDocumentId: invoice.sourceDocumentId,
      serviceDescription: invoice.serviceDescription,
      incomeCharacter: (invoice.incomeCharacter ?? "UNCLASSIFIED") as
        | "TECHNICAL_PROFESSIONAL_FEE"
        | "OTHER_SERVICES"
        | "UNCLASSIFIED",
      humanConfirmed: invoice.incomeCharacterHumanConfirmed,
      classificationEvidenceReference: invoice.incomeCharacterEvidenceReference,
    });

    if (
      resolution.status === "MAPPED_CANDIDATE" &&
      resolution.mapping.autoFillAllowed &&
      !businessTargetAlreadyOccupied
    ) {
      mappedIncomeRows.push({
        invoice,
        amountCents,
        evidenceReference: resolution.mapping.evidenceReference,
      });
      mappedIncomeCents.set(
        subcategory,
        (mappedIncomeCents.get(subcategory) ?? 0) + amountCents,
      );
      continue;
    }

    const reason = businessTargetAlreadyOccupied && resolution.status === "MAPPED_CANDIDATE"
      ? "Business row 3101 already has a separate packet value. Services income is left manual to prevent two sources from overwriting or being added to the same IRIS cell."
      : resolution.status === "MAPPED_CANDIDATE"
        ? "The Services mapping did not pass its packet autofill gate; keep this income manual."
        : resolution.reason;
    const reasons = incomeReasons.get(subcategory) ?? new Set<string>();
    reasons.add(reason);
    incomeReasons.set(subcategory, reasons);
    const ids = unmappedInvoiceIds.get(subcategory) ?? [];
    ids.push(invoice.id);
    unmappedInvoiceIds.set(subcategory, ids);
  }

  if (mappedIncomeRows.length > 0) {
    const amountCents = mappedIncomeRows.reduce((sum, row) => sum + row.amountCents, 0);
    businessFields.push({
      ourCategory: "SERVICES_TECHNICAL_PROFESSIONAL_FEE",
      ourDescription:
        "Human-confirmed technical/professional Services income, recognized under the selected accounting method",
      ourAmount: pkr(amountCents),
      irisCode: "3101",
      irisDescription: "Fee for Technical / Professional Services",
      portalArea: "Business",
      section: "Other Revenues",
      column: "Total Amount",
      isTaxField: false,
      rowDescriptionIncludes: "Fee for Technical / Professional Services",
      sourceEntryCount: mappedIncomeRows.length,
      servicesMappingKind: "SERVICES_INCOME",
      servicesInvoiceEvidenceIds: mappedIncomeRows.map((row) => row.invoice.id),
      servicesEvidenceDocumentIds: unique(
        mappedIncomeRows.map((row) => row.invoice.sourceDocumentId),
      ),
      servicesSubcategories: unique(
        mappedIncomeRows.map((row) => row.invoice.subcategory),
      ),
      servicesIncomeCharacter: "TECHNICAL_PROFESSIONAL_FEE",
      servicesHumanReviewConfirmed: true,
      sourceEvidenceReferences: unique(
        mappedIncomeRows.map((row) => row.evidenceReference),
      ),
    });
  }

  const incomeGaps: UnmappedServiceAmount[] = [];
  for (const [subcategory, total] of Object.entries(input.incomeBySubcategory)) {
    const totalCents = Math.max(0, Math.round(Number(total) * 100));
    const residualCents = Math.max(
      0,
      totalCents - (mappedIncomeCents.get(subcategory) ?? 0),
    );
    if (residualCents <= 0) continue;
    const reasons = Array.from(incomeReasons.get(subcategory) ?? []);
    incomeGaps.push({
      category: categoryKey(subcategory),
      entryIds: unique(unmappedInvoiceIds.get(subcategory) ?? []),
      totalAmount: pkr(residualCents),
      reason: reasons.length
        ? `Verified gross Services income; only evidenced, human-confirmed technical/professional fees can use row 3101. ${reasons.join(" ")}`
        : "Verified gross Services income has no supported IRIS income row for this service subtype; human entry/review is required.",
    });
  }

  const positiveMatches = input.invoices.flatMap((invoice) =>
    invoice.paymentMatches
      .map((match) => ({ invoice, match, amountCents: cents(match.withholdingTaxPkr) }))
      .filter(({ amountCents }) => amountCents > 0),
  );

  // A generic FilingTaxCredit may have been created from the same withholding
  // certificate. Suppress only an exact, same-document/same-section duplicate.
  // Any ambiguous or mismatched overlap is fail-closed and remains manual.
  const serviceTotalsByEvidence = new Map<string, { cents: number; section: string; documentId: string }>();
  for (const { match, amountCents } of positiveMatches) {
    const documentId = String(match.withholdingEvidenceDocumentId ?? "").trim();
    const section = normaliseSection(match.withholdingSection);
    if (!documentId || !section) continue;
    const key = `${documentId}|${section}`;
    const prior = serviceTotalsByEvidence.get(key) ?? { cents: 0, section, documentId };
    prior.cents += amountCents;
    serviceTotalsByEvidence.set(key, prior);
  }

  const taxCreditGroups = new Map<string, ServicesPortalTaxCredit[]>();
  for (const credit of input.taxCredits ?? []) {
    const section = normaliseSection(credit.section);
    if (!["153(1)(B)", "153(2)", "154A"].includes(section)) continue;
    const key = `${credit.sourceDocumentId ?? ""}|${section}`;
    const group = taxCreditGroups.get(key) ?? [];
    group.push(credit);
    taxCreditGroups.set(key, group);
  }

  const taxCreditIdsToSuppress = new Set<string>();
  const duplicateTaxCreditIds = new Set<string>();
  const conflictingWithholdingKeys = new Set<string>();
  for (const [key, serviceTotal] of serviceTotalsByEvidence) {
    const [documentId, section] = key.split("|");
    const exactGroup = taxCreditGroups.get(`${documentId}|${section}`) ?? [];
    const unknownDocumentGroup = taxCreditGroups.get(`|${section}`) ?? [];
    const allSameSectionCredits = Array.from(taxCreditGroups.entries())
      .filter(([creditKey]) => creditKey.endsWith(`|${section}`))
      .flatMap(([, credits]) => credits);
    if (!allSameSectionCredits.length) continue;

    const exactCreditCents = exactGroup.reduce(
      (sum, credit) => sum + cents(credit.amount),
      0,
    );
    const hasUnrelatedOrUnknownCredit = allSameSectionCredits.some(
      (credit) => credit.sourceDocumentId !== documentId,
    );
    const exactDuplicate =
      exactGroup.length > 0 &&
      exactCreditCents === serviceTotal.cents &&
      !hasUnrelatedOrUnknownCredit &&
      unknownDocumentGroup.length === 0 &&
      exactGroup.every((credit) => Boolean(credit.id));

    if (exactDuplicate) {
      for (const credit of exactGroup) {
        taxCreditIdsToSuppress.add(credit.id);
        duplicateTaxCreditIds.add(credit.id);
      }
    } else {
      conflictingWithholdingKeys.add(key);
    }
  }

  const withholdingAgg = new Map<string, PortalFieldMapEntry>();
  const withholdingReasons = new Set<string>();
  let withholdingConflictCents = 0;
  const withholdingConflictIds: string[] = [];

  for (const { invoice, match, amountCents } of positiveMatches) {
    const withholdingEvidenceDocumentId = String(match.withholdingEvidenceDocumentId ?? "").trim() || null;
    const observedSection = match.withholdingSection;
    const conflictKey = withholdingEvidenceDocumentId && observedSection
      ? `${withholdingEvidenceDocumentId}|${normaliseSection(observedSection)}`
      : "";
    const duplicateConflict = Boolean(conflictKey && conflictingWithholdingKeys.has(conflictKey));

    const resolution = resolveServicesWithholdingIrisMapping({
      subcategory: String(invoice.subcategory ?? ""),
      serviceCategoryHumanConfirmed: invoice.serviceCategoryHumanConfirmed,
      serviceCategoryEvidenceReference: invoice.serviceCategoryEvidenceReference,
      withholdingAmountPkr: pkr(amountCents),
      observedSection,
      observedIrisCode: match.withholdingIrisCode,
      sourceEvidenceMapped:
        Boolean(withholdingEvidenceDocumentId) &&
        match.withholdingEvidenceDocumentExtractionStatus === "MAPPED" &&
        SERVICES_WITHHOLDING_EVIDENCE_TYPES.has(
          String(match.withholdingEvidenceDocumentType ?? ""),
        ),
      withholdingEvidenceHumanConfirmed: match.withholdingEvidenceHumanConfirmed,
      evidenceReference: match.withholdingEvidenceReference,
    });

    if (duplicateConflict) {
      withholdingConflictCents += amountCents;
      withholdingConflictIds.push(match.id);
      withholdingReasons.add(
        "A tax-credit record overlaps this statutory section but does not prove an exact same-document duplicate. Reconcile the certificate and tax-credit record before either amount is entered; no Services withholding row is queued.",
      );
      continue;
    }

    if (
      resolution.status !== "MAPPED_CANDIDATE" ||
      resolution.mapping.autoFillAllowed !== true
    ) {
      withholdingConflictCents += amountCents;
      withholdingConflictIds.push(match.id);
      withholdingReasons.add(
        resolution.status === "MAPPED_CANDIDATE"
          ? "The Services row is not approved for autofill; keep the amount manual."
          : resolution.reason,
      );
      continue;
    }

    const candidate = SERVICES_WITHHOLDING_IRIS_ROW_CANDIDATES.find(
      (row) => row.irisCode === resolution.mapping.irisCode,
    );
    if (!candidate) {
      withholdingConflictCents += amountCents;
      withholdingConflictIds.push(match.id);
      withholdingReasons.add("The saved Services row contract no longer contains the resolved IRIS code; keep the amount manual.");
      continue;
    }

    const key = `${resolution.mapping.irisCode}:${resolution.mapping.column}:${resolution.mapping.portalGroup}`;
    const referenceList = unique([
      resolution.mapping.evidenceReference,
      invoice.serviceCategoryEvidenceReference,
    ]);
    const invoiceTaxableCents = Math.round(invoice.recognizedIncomePkr * 100);
    const existing = withholdingAgg.get(key);
    if (existing) {
      existing.ourAmount = pkr(Math.round(existing.ourAmount * 100) + amountCents);
      existing.taxableAmount = pkr(
        Math.round(((existing.taxableAmount ?? 0) * 100) + invoiceTaxableCents),
      );
      existing.sourceEntryCount = (existing.sourceEntryCount ?? 0) + 1;
      existing.servicesInvoiceEvidenceIds = unique([
        ...(existing.servicesInvoiceEvidenceIds ?? []),
        invoice.id,
      ]);
      existing.servicesPaymentMatchIds = unique([
        ...(existing.servicesPaymentMatchIds ?? []),
        match.id,
      ]);
      existing.servicesEvidenceDocumentIds = unique([
        ...(existing.servicesEvidenceDocumentIds ?? []),
        withholdingEvidenceDocumentId,
      ]);
      existing.sourceEvidenceReferences = unique([
        ...(existing.sourceEvidenceReferences ?? []),
        ...referenceList,
      ]);
    } else {
      withholdingAgg.set(key, {
        ourCategory: `SERVICES_WITHHOLDING_${String(invoice.subcategory ?? "UNKNOWN").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
        ourDescription: `Human-confirmed Services withholding, statutory section ${resolution.expectedSection}, certificate reference ${resolution.mapping.evidenceReference}`,
        ourAmount: pkr(amountCents),
        taxableAmount: pkr(invoiceTaxableCents),
        irisCode: resolution.mapping.irisCode,
        irisDescription: candidate.description,
        portalArea: resolution.mapping.portalArea,
        section: resolution.mapping.portalSection,
        portalGroup: resolution.mapping.portalGroup,
        column: resolution.mapping.column,
        isTaxField: true,
        rowDescriptionIncludes: candidate.description,
        sourceEntryCount: 1,
        servicesMappingKind: "SERVICES_WITHHOLDING",
        servicesInvoiceEvidenceIds: [invoice.id],
        servicesPaymentMatchIds: [match.id],
        servicesEvidenceDocumentIds: withholdingEvidenceDocumentId
          ? [withholdingEvidenceDocumentId]
          : [],
        servicesSubcategory: String(invoice.subcategory),
        servicesStatutorySection: resolution.expectedSection,
        servicesObservedIrisCode: resolution.mapping.irisCode,
        servicesHumanReviewConfirmed: true,
        sourceEvidenceReferences: referenceList,
      });
    }
  }

  const withholdingFields = Array.from(withholdingAgg.values());
  const withholdingGaps: UnmappedServiceAmount[] = withholdingConflictCents > 0
    ? [{
        category: withholdingReasons.size > 0 && Array.from(withholdingReasons).some((reason) => reason.includes("tax-credit record overlaps"))
          ? "SERVICES_WITHHOLDING_RECONCILIATION"
          : "SERVICES_WITHHOLDING",
        entryIds: unique(withholdingConflictIds),
        totalAmount: pkr(withholdingConflictCents),
        reason: Array.from(withholdingReasons).join(" ") || "Services withholding is not fully evidenced for an exact IRIS row; enter it manually after review.",
      }]
    : [];

  const mappedIncomeBySubcategory: Record<string, number> = {};
  for (const [subcategory, amountCents] of mappedIncomeCents)
    mappedIncomeBySubcategory[subcategory] = pkr(amountCents);

  return {
    businessFields,
    withholdingFields,
    incomeGaps,
    withholdingGaps,
    mappedIncomeBySubcategory,
    taxCreditIdsToSuppress: Array.from(taxCreditIdsToSuppress),
    duplicateTaxCreditIds: Array.from(duplicateTaxCreditIds),
  };
}
