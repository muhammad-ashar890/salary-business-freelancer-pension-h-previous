"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  saveServicesIncomeEvidenceAction,
  type ServicesInvoiceReviewInput,
  type ServicesPaymentMatchInput,
} from "@/app/actions/services-income-evidence";
import type {
  SelectedServicesSubcategory,
  ServicesEvidenceDocumentSummary,
  ServicesIncomeLedgerReceipt,
  ServicesInvoiceEvidenceSummary,
} from "@/components/tax/filing/config/filing-wizard-config";
import {
  SERVICES_INCOME_CHARACTERS,
  SERVICES_WITHHOLDING_IRIS_CODES_BY_SUBCATEGORY,
  SERVICES_WITHHOLDING_IRIS_ROW_CANDIDATES,
  SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY,
  type ServicesIncomeCharacter,
} from "@/lib/tax/services-iris-mapping";
import { deriveServicesEvidence } from "@/lib/tax/services-evidence-derivation";
import { Button } from "@/components/ui/button";

import {
  SERVICES_WITHHOLDING_DOCUMENT_TYPES as WITHHOLDING_EVIDENCE_DOCUMENT_TYPES,
  resolveServicesWithholdingPrefill,
} from "@/lib/tax/services-withholding-evidence";
import { recordServicesEvidenceSave, recordServicesPanelSnapshot } from "@/lib/tax/withholding-diagnostic-log";

const PAYMENT_STATUS_OPTIONS = [
  { value: "NO_RECEIPT_TY", label: "No receipt during TY2026" },
  { value: "PARTIAL_TY", label: "Partially received during TY2026" },
  { value: "FULL_TY", label: "Fully received during TY2026" },
] as const;

const INCOME_CHARACTER_LABELS: Record<ServicesIncomeCharacter, string> = {
  TECHNICAL_PROFESSIONAL_FEE: "Technical / professional fee",
  OTHER_SERVICES: "Other services — keep income manual",
  UNCLASSIFIED: "Unclassified — keep income manual",
};

type AccountingMethod = "CASH" | "ACCRUAL" | "";
type InvoiceReviewDraft = {
  subcategory: string;
  serviceCategoryHumanConfirmed: boolean;
  serviceCategoryEvidenceReference: string;
  incomeCharacter: ServicesIncomeCharacter;
  incomeCharacterHumanConfirmed: boolean;
  incomeCharacterEvidenceReference: string;
  dueDate: string;
  exchangeRateToPkr: string;
  fxEvidenceReference: string;
  paymentStatus: string;
};
type MatchDraft = {
  clientKey: string;
  invoiceEvidenceId: string;
  ledgerEntryId: string;
  settlementCurrency: string;
  settlementAmount: string;
  settlementExchangeRateToPkr: string;
  invoiceCurrencyAmount: string;
  exchangeRateToPkr: string;
  netBankAmountPkr: string;
  withholdingTaxPkr: string;
  withholdingSection: string;
  withholdingIrisCode: string;
  withholdingEvidenceReference: string;
  withholdingEvidenceHumanConfirmed: boolean;
  withholdingEvidenceDocumentId: string;
  evidenceDocumentId: string;
  platformFeePkr: string;
  bankFeePkr: string;
  payoutReference: string;
  evidenceReference: string;
};

type WizardServicesIncomeEvidencePanelProps = Readonly<{
  draftId?: string;
  accountingMethod?: "CASH" | "ACCRUAL" | null;
  categories: readonly SelectedServicesSubcategory[];
  invoices: readonly ServicesInvoiceEvidenceSummary[];
  receipts: readonly ServicesIncomeLedgerReceipt[];
  evidenceDocuments: readonly ServicesEvidenceDocumentSummary[];
  onSaved: () => Promise<void> | void;
}>;

const formatPkr = (value: number) =>
  `PKR ${value.toLocaleString("en-PK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const moneyInput = (value: number | null | undefined) =>
  value === null || value === undefined ? "" : String(value);

const parseOptionalNumber = (value: string) => {
  if (!value.trim()) return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
};

function newMatch(invoice: ServicesInvoiceEvidenceSummary): MatchDraft {
  const isPkrInvoice = invoice.currency?.toUpperCase() === "PKR";
  return {
    clientKey: `${invoice.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    invoiceEvidenceId: invoice.id,
    ledgerEntryId: "",
    settlementCurrency: "",
    settlementAmount: "",
    settlementExchangeRateToPkr: "",
    invoiceCurrencyAmount: "",
    exchangeRateToPkr: isPkrInvoice ? "1" : "",
    netBankAmountPkr: "",
    withholdingTaxPkr: "",
    withholdingSection: "",
    withholdingIrisCode: "",
    withholdingEvidenceReference: "",
    withholdingEvidenceHumanConfirmed: false,
    withholdingEvidenceDocumentId: "",
    evidenceDocumentId: "",
    platformFeePkr: "",
    bankFeePkr: "",
    payoutReference: "",
    evidenceReference: "",
  };
}

function savedMatch(invoiceId: string, match: ServicesInvoiceEvidenceSummary["paymentMatches"][number]): MatchDraft {
  return {
    clientKey: match.id,
    invoiceEvidenceId: invoiceId,
    ledgerEntryId: match.ledgerEntryId,
    settlementCurrency: match.settlementCurrency ?? "",
    settlementAmount: moneyInput(match.settlementAmount),
    settlementExchangeRateToPkr: moneyInput(match.settlementExchangeRateToPkr),
    invoiceCurrencyAmount: moneyInput(match.invoiceCurrencyAmount),
    exchangeRateToPkr: moneyInput(match.exchangeRateToPkr),
    netBankAmountPkr: moneyInput(match.netBankAmountPkr),
    withholdingTaxPkr: moneyInput(match.withholdingTaxPkr),
    withholdingSection: match.withholdingSection ?? "",
    withholdingIrisCode: match.withholdingIrisCode ?? "",
    withholdingEvidenceReference: match.withholdingEvidenceReference ?? "",
    withholdingEvidenceHumanConfirmed: match.withholdingEvidenceHumanConfirmed,
    withholdingEvidenceDocumentId: match.withholdingEvidenceDocumentId ?? "",
    evidenceDocumentId: match.evidenceDocumentId ?? "",
    platformFeePkr: moneyInput(match.platformFeePkr),
    bankFeePkr: moneyInput(match.bankFeePkr),
    payoutReference: match.payoutReference ?? "",
    evidenceReference: match.evidenceReference ?? "",
  };
}

function computedGrossPkr(match: MatchDraft) {
  const invoiceAmount = parseOptionalNumber(match.invoiceCurrencyAmount);
  const rate = parseOptionalNumber(match.exchangeRateToPkr);
  if (invoiceAmount === null || rate === null || invoiceAmount <= 0 || rate <= 0)
    return null;
  return Math.round(invoiceAmount * rate * 100) / 100;
}

export function WizardServicesIncomeEvidencePanel({
  draftId,
  accountingMethod,
  categories,
  invoices,
  receipts,
  evidenceDocuments,
  onSaved,
}: WizardServicesIncomeEvidencePanelProps) {
  const [method, setMethod] = useState<AccountingMethod>(accountingMethod ?? "");
  const [invoiceReviews, setInvoiceReviews] = useState<Record<string, InvoiceReviewDraft>>({});
  const [matches, setMatches] = useState<MatchDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [derivationNotes, setDerivationNotes] = useState<{
    source: "documents";
    matchedCredits: number;
    credits: number;
    allocatedPkr: number;
    ledgerPkr: number;
    invoiceCount: number;
    assumptions: string[];
    issues: string[];
  } | null>(null);
  const autoDerivedRef = useRef(false);
  const loadedReviewRevision = useRef<string | null>(null);
  const persistedReviewRevision = useMemo(
    () => JSON.stringify({ accountingMethod: accountingMethod ?? null, invoices }),
    [accountingMethod, invoices],
  );

  useEffect(() => {
    // Summary refreshes create new array identities. Do not erase the filled
    // document data (or the user's unsaved review) when its persisted contents
    // did not change, e.g. while a withholding source finishes mapping.
    if (loadedReviewRevision.current === persistedReviewRevision) return;
    loadedReviewRevision.current = persistedReviewRevision;
    autoDerivedRef.current = false;
    setMethod(accountingMethod ?? "");
    setInvoiceReviews(
      Object.fromEntries(
        invoices.map((invoice) => [
          invoice.id,
          {
            subcategory: invoice.subcategory ?? "",
            serviceCategoryHumanConfirmed: invoice.serviceCategoryHumanConfirmed,
            serviceCategoryEvidenceReference: invoice.serviceCategoryEvidenceReference ?? "",
            incomeCharacter: (invoice.incomeCharacter ?? "UNCLASSIFIED") as ServicesIncomeCharacter,
            incomeCharacterHumanConfirmed: invoice.incomeCharacterHumanConfirmed,
            incomeCharacterEvidenceReference: invoice.incomeCharacterEvidenceReference ?? "",
            dueDate: invoice.dueDate ?? "",
            exchangeRateToPkr: moneyInput(invoice.exchangeRateToPkr),
            fxEvidenceReference: invoice.fxEvidenceReference ?? "",
            paymentStatus: invoice.paymentStatus ?? "",
          } satisfies InvoiceReviewDraft,
        ]),
      ),
    );
    setMatches(
      invoices.flatMap((invoice) =>
        invoice.paymentMatches.map((match) => savedMatch(invoice.id, match)),
      ),
    );
    setError(null);
    setSavedMessage(null);
  }, [accountingMethod, invoices, persistedReviewRevision]);

  // The derivation runs in the browser from the filing summary that is already
  // on screen — no server round trip and no silent failure. Everything it needs
  // (invoice rows, their printed payout block, the approved bank credits and
  // the mapped documents) arrives with the summary.
  const prefillWithholdingSource = useCallback((match: MatchDraft): MatchDraft => {
    // Keep an explicit saved/manual source decision; never overwrite it merely
    // because another document arrived. Unconfirmed, empty-source matches can
    // be completed from a uniquely matching approved certificate/statement.
    if (match.withholdingEvidenceDocumentId) return match;
    const invoice = invoices.find((item) => item.id === match.invoiceEvidenceId);
    const source = resolveServicesWithholdingPrefill({
      invoiceNumber: invoice?.invoiceNumber ?? null,
      payoutReference: match.payoutReference || null,
      amountPkr: parseOptionalNumber(match.withholdingTaxPkr),
      observedSection: match.withholdingSection || null,
      observedIrisCode: match.withholdingIrisCode || null,
      documents: evidenceDocuments,
    });
    if (source.status !== "MATCHED") return match;
    return {
      ...match,
      withholdingSection: source.section,
      withholdingIrisCode: source.irisCode,
      withholdingEvidenceReference: source.evidenceReference,
      withholdingEvidenceDocumentId: source.documentId,
      // These exact mapped facts are shown in Review; saving the step is the
      // user's single confirmation. No portal write follows from prefill alone.
      withholdingEvidenceHumanConfirmed: true,
    };
  }, [evidenceDocuments, invoices]);

  const derivation = useMemo(() => {
    if (invoices.length === 0 || categories.length === 0) return null;
    if (invoices.every((invoice) => invoice.evidenceStatus === "CONFIRMED")) return null;
    try {
      return deriveServicesEvidence({
        selectedSubcategories: categories.map((category) => category.subcategory),
        invoices: invoices.map((invoice) => ({
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          invoiceDate: invoice.invoiceDate,
          clientName: invoice.clientName,
          serviceDescription: invoice.serviceDescription,
          invoiceAmount: invoice.invoiceAmount,
          currency: invoice.currency,
          exchangeRateToPkr: invoice.exchangeRateToPkr,
          subcategory: invoice.subcategory,
          sourceDocumentFileName: invoice.sourceDocumentFileName,
          derivedPayout: invoice.derivedPayout ?? null,
        })),
        receipts: receipts.map((receipt) => ({
          id: receipt.id,
          date: receipt.date,
          description: receipt.description,
          amount: receipt.amount,
        })),
      });
    } catch {
      return null;
    }
  }, [categories, invoices, receipts]);

  const persistedInvoiceIds = useMemo(() => new Set(
    invoices
      .filter((invoice) => invoice.evidenceStatus === "CONFIRMED" || invoice.paymentMatches.length > 0)
      .map((invoice) => invoice.id),
  ), [invoices]);

  const applyDerivation = useCallback(() => {
    if (!derivation) return;
    setMethod((current) => current || (accountingMethod ?? "CASH"));
    // A refreshed batch may contain both saved and newly mapped invoices.
    // Fill the new document data without replacing saved matches, fees or an
    // explicitly approved withholding source with a new derivation.
    setInvoiceReviews((current) => ({
      ...current,
      ...Object.fromEntries(
        derivation.invoiceReviews.filter((review) => !persistedInvoiceIds.has(review.invoiceId)).map((review) => [
          review.invoiceId,
          {
            subcategory: review.subcategory,
            serviceCategoryHumanConfirmed: review.serviceCategoryHumanConfirmed,
            serviceCategoryEvidenceReference: review.serviceCategoryEvidenceReference,
            incomeCharacter: review.incomeCharacter,
            incomeCharacterHumanConfirmed: review.incomeCharacterHumanConfirmed,
            incomeCharacterEvidenceReference: review.incomeCharacterEvidenceReference,
            dueDate: review.dueDate ?? "",
            exchangeRateToPkr:
              review.exchangeRateToPkr === null ? "" : String(review.exchangeRateToPkr),
            fxEvidenceReference: review.fxEvidenceReference ?? "",
            paymentStatus: review.paymentStatus,
          } satisfies InvoiceReviewDraft,
        ]),
      ),
    }));
    setMatches((current) => [
      ...current.filter((match) => persistedInvoiceIds.has(match.invoiceEvidenceId)),
      ...derivation.matches.filter((match) => !persistedInvoiceIds.has(match.invoiceEvidenceId)).map((match, index) => prefillWithholdingSource({
        clientKey: `derived-${match.invoiceEvidenceId}-${match.ledgerEntryId}-${index}`,
        invoiceEvidenceId: match.invoiceEvidenceId,
        ledgerEntryId: match.ledgerEntryId,
        settlementCurrency: match.settlementCurrency,
        settlementAmount: String(match.settlementAmount),
        settlementExchangeRateToPkr: String(match.settlementExchangeRateToPkr),
        invoiceCurrencyAmount: String(match.invoiceCurrencyAmount),
        exchangeRateToPkr: String(match.exchangeRateToPkr),
        netBankAmountPkr: String(match.netBankAmountPkr),
        withholdingTaxPkr: String(match.withholdingTaxPkr),
        withholdingSection: match.withholdingSection ?? "",
        withholdingIrisCode: match.withholdingIrisCode ?? "",
        withholdingEvidenceReference: match.withholdingEvidenceReference ?? "",
        withholdingEvidenceHumanConfirmed: match.withholdingEvidenceHumanConfirmed,
        withholdingEvidenceDocumentId: "",
        evidenceDocumentId: "",
        platformFeePkr: String(match.platformFeePkr),
        bankFeePkr: String(match.bankFeePkr),
        payoutReference: match.payoutReference ?? "",
        evidenceReference: match.evidenceReference,
      })),
    ]);
    setDerivationNotes({
      source: "documents",
      matchedCredits: derivation.coverage.matchedCredits,
      credits: derivation.coverage.credits,
      allocatedPkr: derivation.coverage.allocatedPkr,
      ledgerPkr: derivation.coverage.ledgerPkr,
      invoiceCount: derivation.invoiceReviews.length,
      assumptions: [...derivation.assumptions],
      issues: derivation.issues.map((issue) => issue.message),
    });
    setSavedMessage(null);
    setError(null);
  }, [accountingMethod, derivation, persistedInvoiceIds, prefillWithholdingSource]);

  // Fill the step as soon as the summary is on screen, so the taxpayer only
  // confirms what the documents already say. Never overrides a saved step.
  useEffect(() => {
    if (autoDerivedRef.current || !derivation) return;
    if (invoices.every((invoice) => persistedInvoiceIds.has(invoice.id))) return;
    autoDerivedRef.current = true;
    applyDerivation();
  }, [applyDerivation, derivation, invoices, persistedInvoiceIds]);

  // A certificate uploaded after the income review can complete its missing
  // withholding source without asking the user to retype three payout rows.
  useEffect(() => {
    setMatches((current) => {
      const next = current.map(prefillWithholdingSource);
      return next.some((match, index) => match !== current[index]) ? next : current;
    });
  }, [prefillWithholdingSource]);

  const unresolvedWithholding = useMemo(() => matches.flatMap((match) => {
    const amount = parseOptionalNumber(match.withholdingTaxPkr);
    if (amount === null || amount <= 0 ||
        (match.withholdingEvidenceHumanConfirmed && match.withholdingEvidenceDocumentId)) return [];
    const invoice = invoices.find((item) => item.id === match.invoiceEvidenceId);
    const result = resolveServicesWithholdingPrefill({
      invoiceNumber: invoice?.invoiceNumber ?? null,
      payoutReference: match.payoutReference || null,
      amountPkr: amount,
      observedSection: match.withholdingSection || null,
      observedIrisCode: match.withholdingIrisCode || null,
      documents: evidenceDocuments,
    });
    return [{ key: match.clientKey, name: invoice?.invoiceNumber || "Services payout", amount,
      reason: result.status === "MATCHED" ? "Review and confirm the mapped withholding source below." : result.reason }];
  }), [evidenceDocuments, invoices, matches]);

  useEffect(() => {
    void recordServicesPanelSnapshot({
      draftId,
      accountingMethod: method,
      categories,
      invoices,
      matches,
      evidenceDocuments,
      unresolvedCount: unresolvedWithholding.length,
      unresolvedTotalPkr: unresolvedWithholding.reduce((sum, item) => sum + item.amount, 0),
    });
  }, [draftId, method, categories, invoices, matches, evidenceDocuments, unresolvedWithholding]);

  const receiptById = useMemo(
    () => new Map(receipts.map((receipt) => [receipt.id, receipt])),
    [receipts],
  );
  const withholdingEvidenceDocuments = useMemo(
    () => evidenceDocuments.filter((document) =>
      WITHHOLDING_EVIDENCE_DOCUMENT_TYPES.has(document.documentType),
    ),
    [evidenceDocuments],
  );
  const matchesByInvoice = useMemo(() => {
    const grouped = new Map<string, MatchDraft[]>();
    for (const match of matches) {
      const rows = grouped.get(match.invoiceEvidenceId) ?? [];
      rows.push(match);
      grouped.set(match.invoiceEvidenceId, rows);
    }
    return grouped;
  }, [matches]);

  if (categories.length === 0) return null;

  function updateInvoice(id: string, patch: Partial<InvoiceReviewDraft>) {
    setInvoiceReviews((previous) => ({
      ...previous,
      [id]: {
        ...(previous[id] ?? {
          subcategory: "",
          serviceCategoryHumanConfirmed: false,
          serviceCategoryEvidenceReference: "",
          incomeCharacter: "UNCLASSIFIED",
          incomeCharacterHumanConfirmed: false,
          incomeCharacterEvidenceReference: "",
          dueDate: "",
          exchangeRateToPkr: "",
          fxEvidenceReference: "",
          paymentStatus: "",
        }),
        ...patch,
        ...(Object.prototype.hasOwnProperty.call(patch, "subcategory") || Object.prototype.hasOwnProperty.call(patch, "serviceCategoryEvidenceReference")
          ? { serviceCategoryHumanConfirmed: false }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(patch, "incomeCharacter") || Object.prototype.hasOwnProperty.call(patch, "incomeCharacterEvidenceReference")
          ? { incomeCharacterHumanConfirmed: false }
          : {}),
      },
    }));
    setSavedMessage(null);
    setError(null);
  }

  function updateMatch(clientKey: string, patch: Partial<MatchDraft>) {
    setMatches((previous) =>
      previous.map((match) =>
        match.clientKey === clientKey
          ? {
              ...match,
              ...patch,
              ...(Object.keys(patch).some((key) =>
                [
                  "withholdingTaxPkr",
                  "withholdingSection",
                  "withholdingIrisCode",
                  "withholdingEvidenceReference",
                  "withholdingEvidenceDocumentId",
                  "evidenceDocumentId",
                ].includes(key),
              )
                ? { withholdingEvidenceHumanConfirmed: false }
                : {}),
            }
          : match,
      ),
    );
    setSavedMessage(null);
    setError(null);
  }

  function addMatch(invoice: ServicesInvoiceEvidenceSummary) {
    setMatches((previous) => [...previous, newMatch(invoice)]);
    setSavedMessage(null);
    setError(null);
  }

  function removeMatch(clientKey: string) {
    setMatches((previous) => previous.filter((match) => match.clientKey !== clientKey));
    setSavedMessage(null);
    setError(null);
  }

  function canSave() {
    if (!draftId || !method || invoices.length === 0) return false;
    const invoiceReviewsComplete = invoices.every((invoice) => {
      const review = invoiceReviews[invoice.id];
      if (!review?.subcategory) return false;
      if (method === "CASH" && !review.paymentStatus) return false;
      if (
        review.serviceCategoryHumanConfirmed &&
        !review.serviceCategoryEvidenceReference.trim()
      ) return false;
      if (
        review.incomeCharacterHumanConfirmed &&
        !review.incomeCharacterEvidenceReference.trim()
      ) return false;
      return true;
    });
    if (!invoiceReviewsComplete) return false;
    return matches.every((match) => {
      if (!match.withholdingEvidenceHumanConfirmed) return true;
      const amount = parseOptionalNumber(match.withholdingTaxPkr);
      return Boolean(
        amount !== null &&
          amount > 0 &&
          match.withholdingSection.trim() &&
          match.withholdingIrisCode.trim() &&
          match.withholdingEvidenceReference.trim() &&
          withholdingEvidenceDocuments.some((document) => document.id === match.withholdingEvidenceDocumentId),
      );
    });
  }

  async function saveEvidence() {
    if (!draftId || !canSave()) return;
    setSaving(true);
    setError(null);
    setSavedMessage(null);

    const invoicePayload: ServicesInvoiceReviewInput[] = invoices.map((invoice) => {
      const review = invoiceReviews[invoice.id];
      return {
        id: invoice.id,
        subcategory: review.subcategory,
        serviceCategoryHumanConfirmed: review.serviceCategoryHumanConfirmed,
        serviceCategoryEvidenceReference: review.serviceCategoryEvidenceReference.trim() || null,
        incomeCharacter: review.incomeCharacter,
        incomeCharacterHumanConfirmed: review.incomeCharacterHumanConfirmed,
        incomeCharacterEvidenceReference: review.incomeCharacterEvidenceReference.trim() || null,
        dueDate: review.dueDate || null,
        exchangeRateToPkr: parseOptionalNumber(review.exchangeRateToPkr),
        fxEvidenceReference: review.fxEvidenceReference.trim() || null,
        paymentStatus: (review.paymentStatus || null) as ServicesInvoiceReviewInput["paymentStatus"],
      };
    });
    const paymentPayload: ServicesPaymentMatchInput[] = matches.map((match) => ({
      invoiceEvidenceId: match.invoiceEvidenceId,
      ledgerEntryId: match.ledgerEntryId,
      settlementCurrency: match.settlementCurrency.trim().toUpperCase(),
      settlementAmount: parseOptionalNumber(match.settlementAmount) ?? 0,
      settlementExchangeRateToPkr: parseOptionalNumber(match.settlementExchangeRateToPkr) ?? 0,
      invoiceCurrencyAmount: parseOptionalNumber(match.invoiceCurrencyAmount) ?? 0,
      exchangeRateToPkr: parseOptionalNumber(match.exchangeRateToPkr) ?? 0,
      grossServiceAmountPkr: computedGrossPkr(match) ?? 0,
      netBankAmountPkr: parseOptionalNumber(match.netBankAmountPkr) ?? 0,
      withholdingTaxPkr: parseOptionalNumber(match.withholdingTaxPkr) ?? -1,
      withholdingSection: match.withholdingSection.trim() || null,
      withholdingIrisCode: match.withholdingIrisCode.trim() || null,
      withholdingEvidenceReference: match.withholdingEvidenceReference.trim() || null,
      withholdingEvidenceHumanConfirmed: match.withholdingEvidenceHumanConfirmed,
      withholdingEvidenceDocumentId: match.withholdingEvidenceDocumentId.trim() || null,
      platformFeePkr: parseOptionalNumber(match.platformFeePkr) ?? -1,
      bankFeePkr: parseOptionalNumber(match.bankFeePkr) ?? -1,
      payoutReference: match.payoutReference.trim() || null,
      evidenceReference: match.evidenceReference.trim() || null,
      evidenceDocumentId: match.evidenceDocumentId.trim() || null,
    }));

    const result = await saveServicesIncomeEvidenceAction({
      draftId,
      accountingMethod: method,
      invoices: invoicePayload,
      paymentMatches: paymentPayload,
    });
    setSaving(false);
    void recordServicesEvidenceSave({
      draftId,
      success: result.success,
      invoiceCount: result.success ? result.invoiceCount : invoicePayload.length,
      paymentMatchCount: result.success ? result.payoutMatchCount : paymentPayload.length,
    });
    if (result.success === false) {
      setError(result.error ?? "Could not save Freelancer income evidence.");
      return;
    }

    try {
      await onSaved();
      setSavedMessage(
        `Verified ${result.invoiceCount} invoice${result.invoiceCount === 1 ? "" : "s"} and ${result.payoutMatchCount} payout match${result.payoutMatchCount === 1 ? "" : "es"}. Only the ${result.accountingMethod.toLowerCase()}-basis amount is used for Services income; bank credits are not added a second time.`,
      );
    } catch {
      setError("Evidence was saved, but the filing summary did not refresh. Reload Review to confirm the saved data.");
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-amanah/25 bg-card p-4 sm:p-5" aria-busy={saving}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">Freelancer income basis and payout evidence</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Keep the invoice gross, withholding, platform fees, receiving-bank fees, FX and net payout separate. Use the accounting method regularly employed for the business; do not switch methods to change this estimate. An invoice and its bank credit are linked evidence, not two amounts of income.
        </p>
      </div>
      <datalist id="services-withholding-iris-codes">
        {SERVICES_WITHHOLDING_IRIS_ROW_CANDIDATES.map((candidate) => (
          <option key={candidate.irisCode} value={candidate.irisCode} label={candidate.description} />
        ))}
      </datalist>
      {unresolvedWithholding.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-900" role="status">
          <p className="font-semibold">Withholding source needed — {formatPkr(unresolvedWithholding.reduce((sum, item) => sum + item.amount, 0))}</p>
          <p className="mt-1">The payout amounts are already filled. Upload/map the matching payer tax evidence; supported section/code facts will be linked automatically. Do not retype income or change reconciliation to clear this warning.</p>
          <ul className="mt-2 space-y-1">
            {unresolvedWithholding.map((item) => <li key={item.key}>{item.name}: {formatPkr(item.amount)} — {item.reason}</li>)}
          </ul>
        </div>
      )}

      <div className="grid gap-2 rounded-lg border bg-muted/20 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(220px,340px)] sm:items-center">
        <div>
          <label htmlFor="services-accounting-method" className="text-xs font-semibold">Accounting method regularly used</label>
          <p className="mt-1 text-[11px] text-muted-foreground">Select the method reflected in the taxpayer’s books/regular practice.</p>
        </div>
        <select
          id="services-accounting-method"
          data-testid="services-accounting-method"
          value={method}
          onChange={(event) => {
            setMethod(event.target.value as AccountingMethod);
            setSavedMessage(null);
            setError(null);
          }}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="">Choose accounting method</option>
          <option value="CASH">Cash basis — when income is received</option>
          <option value="ACCRUAL">Accrual basis — when income becomes due</option>
        </select>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed p-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold">Filled from your documents</p>
          <p className="text-[11px] text-muted-foreground">
            {derivationNotes
              ? `${derivationNotes.invoiceCount} invoice${derivationNotes.invoiceCount === 1 ? "" : "s"} · ${derivationNotes.matchedCredits}/${derivationNotes.credits} bank credits matched · ${formatPkr(derivationNotes.allocatedPkr)} of ${formatPkr(derivationNotes.ledgerPkr)} allocated`
              : "Invoice fields, payout amounts, fees and bank-credit matches are read from the uploaded documents, not typed."}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={() => applyDerivation()}
          disabled={!derivation}
        >
          Fill from documents
        </Button>
      </div>

      {derivationNotes &&
        (derivationNotes.assumptions.length > 0 || derivationNotes.issues.length > 0) && (
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3 text-[11px]">
            {derivationNotes.assumptions.length > 0 && (
              <div>
                <p className="font-semibold">Taken from the documents</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                  {derivationNotes.assumptions.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
            {derivationNotes.issues.length > 0 && (
              <div>
                <p className="font-semibold text-amber-700">Documents do not prove yet</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-700">
                  {derivationNotes.issues.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

      {invoices.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-xs leading-relaxed text-muted-foreground">
          No mapped invoice rows yet. Upload the invoice/service-income document in Documents, wait for extraction, then press “Review &amp; map data” and “Save &amp; Approve Map” — the invoice rows are created by that step, not by the upload. Come back here afterwards; calculation stays blocked until invoice and payout evidence is complete.
        </div>
      ) : (
        <div className="space-y-3">
          {invoices.map((invoice, invoiceIndex) => {
            const review = invoiceReviews[invoice.id] ?? {
              subcategory: "",
              serviceCategoryHumanConfirmed: false,
              serviceCategoryEvidenceReference: "",
              incomeCharacter: "UNCLASSIFIED" as const,
              incomeCharacterHumanConfirmed: false,
              incomeCharacterEvidenceReference: "",
              dueDate: "",
              exchangeRateToPkr: "",
              fxEvidenceReference: "",
              paymentStatus: "",
            };
            const invoiceMatches = matchesByInvoice.get(invoice.id) ?? [];
            const isForeignCurrency = Boolean(invoice.currency && invoice.currency !== "PKR");
            const expectedWithholdingSection = review.subcategory
              ? SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY[
                  review.subcategory as keyof typeof SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY
                ]
              : null;
            return (
              <article key={invoice.id} className="space-y-3 rounded-lg border p-3 sm:p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold">
                      {invoice.invoiceNumber ? `Invoice ${invoice.invoiceNumber}` : `Invoice row ${invoiceIndex + 1}`}
                      <span className="ml-2 font-normal text-muted-foreground">{invoice.invoiceDate ?? "Date missing"}</span>
                    </p>
                    <p className="mt-1 break-words text-xs text-muted-foreground">
                      {invoice.clientName || "Client missing"} · {invoice.serviceDescription || "Service description missing"}
                    </p>
                    <p className="mt-1 text-xs font-medium tabular-nums">
                      Invoice gross: {invoice.invoiceAmount === null ? "Pending" : `${invoice.currency ?? "Currency missing"} ${invoice.invoiceAmount.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    </p>
                  </div>
                  <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${invoice.evidenceStatus === "CONFIRMED" ? "bg-amanah/10 text-amanah" : derivation ? "bg-blue-500/10 text-blue-800" : "bg-amber-500/10 text-amber-800"}`}>
                    {invoice.evidenceStatus === "CONFIRMED"
                      ? "Evidence confirmed"
                      : derivation
                        ? "Auto-filled from documents"
                        : "Needs review"}
                  </span>
                </div>
                {derivation && invoice.evidenceStatus !== "CONFIRMED" && (
                  <p className="text-[11px] text-muted-foreground">
                    Read from {invoice.sourceDocumentFileName}
                    {invoice.sourceDocumentExtractionStatus === "MAPPED" ? "" : " (mapping pending)"}.
                    Nothing to type — check the values and press “Confirm Services evidence” once at the bottom.
                  </p>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-[11px] font-medium">
                    <span>TY2026 Services tax category</span>
                    <select
                      data-testid={`services-invoice-subcategory-${invoiceIndex}`}
                      value={review.subcategory}
                      onChange={(event) => updateInvoice(invoice.id, { subcategory: event.target.value })}
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal"
                    >
                      <option value="">Choose selected Services category</option>
                      {categories.map((category) => (
                        <option key={category.subcategory} value={category.subcategory}>{category.label}</option>
                      ))}
                    </select>
                  </label>
                  {method === "ACCRUAL" && (
                    <label className="space-y-1 text-[11px] font-medium">
                      <span>Income-due date (from contract/invoice evidence)</span>
                      <input
                        type="date"
                        value={review.dueDate}
                        onChange={(event) => updateInvoice(invoice.id, { dueDate: event.target.value })}
                        className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal"
                      />
                    </label>
                  )}
                  {method === "CASH" && (
                    <label className="space-y-1 text-[11px] font-medium">
                      <span>Receipt status during TY2026</span>
                      <select
                        value={review.paymentStatus}
                        onChange={(event) => updateInvoice(invoice.id, { paymentStatus: event.target.value })}
                        className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal"
                      >
                        <option value="">Choose receipt status</option>
                        {PAYMENT_STATUS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {method === "ACCRUAL" && isForeignCurrency && (
                    <>
                      <label className="space-y-1 text-[11px] font-medium">
                        <span>Invoice-date FX rate to PKR</span>
                        <input
                          type="number"
                          min="0"
                          step="0.00000001"
                          value={review.exchangeRateToPkr}
                          onChange={(event) => updateInvoice(invoice.id, { exchangeRateToPkr: event.target.value })}
                          className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal"
                          placeholder="Evidence-backed rate"
                        />
                      </label>
                      <label className="space-y-1 text-[11px] font-medium">
                        <span>Invoice-date FX evidence reference</span>
                        <input
                          value={review.fxEvidenceReference}
                          onChange={(event) => updateInvoice(invoice.id, { fxEvidenceReference: event.target.value })}
                          className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal"
                          placeholder="Document/page/source"
                        />
                      </label>
                    </>
                  )}
                </div>

                <div className="space-y-3 rounded-lg border bg-muted/10 p-3">
                  <div>
                    <p className="text-xs font-semibold">Human evidence classification for IRIS routing</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      These confirmations do not change tax calculations. Only a source-backed technical/professional fee may be considered for Business row 3101; other Services stay manual. The selected Services category is also checked against any withholding-certificate section.
                    </p>
                    {expectedWithholdingSection && (
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        Section cross-check for this category: {expectedWithholdingSection}. Use only the section actually shown by the mapped withholding evidence; any mismatch remains manual.
                      </p>
                    )}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-[11px] font-medium">
                      <span>Income character (from human review)</span>
                      <select
                        value={review.incomeCharacter}
                        onChange={(event) => updateInvoice(invoice.id, { incomeCharacter: event.target.value as ServicesIncomeCharacter })}
                        className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal"
                      >
                        {SERVICES_INCOME_CHARACTERS.map((character) => (
                          <option key={character} value={character}>{INCOME_CHARACTER_LABELS[character]}</option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1 text-[11px] font-medium">
                      <span>Income-character evidence reference</span>
                      <input
                        value={review.incomeCharacterEvidenceReference}
                        onChange={(event) => updateInvoice(invoice.id, { incomeCharacterEvidenceReference: event.target.value })}
                        className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal"
                        placeholder="Invoice/contract filename, page, clause"
                      />
                    </label>
                    <label className="space-y-1 text-[11px] font-medium sm:col-span-2">
                      <span>Services-category evidence reference</span>
                      <input
                        value={review.serviceCategoryEvidenceReference}
                        onChange={(event) => updateInvoice(invoice.id, { serviceCategoryEvidenceReference: event.target.value })}
                        className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal"
                        placeholder="Invoice/contract filename, page, service scope"
                      />
                    </label>
                    <div className="flex flex-col gap-2 text-[11px] sm:col-span-2">
                      <label className="flex items-start gap-2 font-normal">
                        <input
                          type="checkbox"
                          checked={review.serviceCategoryHumanConfirmed}
                          onChange={(event) => updateInvoice(invoice.id, { serviceCategoryHumanConfirmed: event.target.checked })}
                          className="mt-0.5"
                        />
                        <span>I reviewed the selected Services category against the invoice/contract evidence above.</span>
                      </label>
                      <label className="flex items-start gap-2 font-normal">
                        <input
                          type="checkbox"
                          checked={review.incomeCharacterHumanConfirmed}
                          onChange={(event) => updateInvoice(invoice.id, { incomeCharacterHumanConfirmed: event.target.checked })}
                          className="mt-0.5"
                        />
                        <span>I reviewed the income character above against the invoice/contract evidence above.</span>
                      </label>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 border-t pt-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-xs font-semibold">Payout and bank-credit matches</p>
                      <p className="text-[11px] text-muted-foreground">Link each Services ledger credit to the invoice(s) it settles. Gross = net credit + withholding + platform fee + receiving-bank fee.</p>
                    </div>
                    <Button type="button" size="sm" variant="outline" onClick={() => addMatch(invoice)} className="h-8 text-xs">Add payout match</Button>
                  </div>

                  {invoiceMatches.length === 0 ? (
                    <p className="rounded-md border border-dashed p-3 text-[11px] text-muted-foreground">
                      No payout linked. For cash basis, mark “No receipt during TY2026” only if the evidence confirms no Services receipt this year. Any Services bank credit must be matched before calculation.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {invoiceMatches.map((match, matchIndex) => {
                        const selectedReceipt = receiptById.get(match.ledgerEntryId);
                        const gross = computedGrossPkr(match);
                        return (
                          <div key={match.clientKey} className="space-y-3 rounded-md bg-muted/20 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-[11px] font-semibold">Payout match {matchIndex + 1}</p>
                              <button type="button" onClick={() => removeMatch(match.clientKey)} className="text-[11px] text-destructive underline">Remove match</button>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <label className="space-y-1 text-[11px] font-medium sm:col-span-2">
                                <span>Services bank-ledger credit</span>
                                <select
                                  value={match.ledgerEntryId}
                                  onChange={(event) => updateMatch(match.clientKey, { ledgerEntryId: event.target.value })}
                                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal"
                                >
                                  <option value="">Choose the matching Services credit</option>
                                  {receipts.map((receipt) => (
                                    <option key={receipt.id} value={receipt.id}>
                                      {receipt.date ?? "Date missing"} · {formatPkr(receipt.amount)} · {receipt.description}
                                    </option>
                                  ))}
                                </select>
                                {selectedReceipt && <span className="block font-normal text-muted-foreground">Current ledger credit: {formatPkr(selectedReceipt.amount)}. Allocate its net amount across all invoice matches exactly once.</span>}
                              </label>
                              <label className="space-y-1 text-[11px] font-medium">
                                <span>Gross service amount in invoice currency</span>
                                <input type="number" min="0" step="0.01" value={match.invoiceCurrencyAmount} onChange={(event) => updateMatch(match.clientKey, { invoiceCurrencyAmount: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal" />
                              </label>
                              <label className="space-y-1 text-[11px] font-medium">
                                <span>Invoice-currency FX to PKR</span>
                                <input type="number" min="0" step="0.00000001" value={match.exchangeRateToPkr} onChange={(event) => updateMatch(match.clientKey, { exchangeRateToPkr: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal" />
                              </label>
                              <div className="space-y-1 text-[11px] font-medium">
                                <span>Gross service amount (PKR, calculated)</span>
                                <div className="flex h-9 items-center rounded-md border bg-background px-2 text-xs tabular-nums">{gross === null ? "Enter amount and FX rate" : formatPkr(gross)}</div>
                              </div>
                              <label className="space-y-1 text-[11px] font-medium">
                                <span>Net bank credit allocated (PKR)</span>
                                <input type="number" min="0" step="0.01" value={match.netBankAmountPkr} onChange={(event) => updateMatch(match.clientKey, { netBankAmountPkr: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal" />
                              </label>
                              <label className="space-y-1 text-[11px] font-medium">
                                <span>Withholding tax (PKR; enter 0 only if evidenced)</span>
                                <input type="number" min="0" step="0.01" value={match.withholdingTaxPkr} onChange={(event) => updateMatch(match.clientKey, { withholdingTaxPkr: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal" />
                              </label>
                              <label className="space-y-1 text-[11px] font-medium sm:col-span-2">
                                <span>Mapped withholding certificate / tax evidence document</span>
                                <select
                                  value={match.withholdingEvidenceDocumentId}
                                  onChange={(event) => {
                                    const docId = event.target.value;
                                    const selectedDoc = withholdingEvidenceDocuments.find((d) => d.id === docId);
                                    const subcat = (review.subcategory || invoice.subcategory) as keyof typeof SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY;
                                    const defaultSection = subcat ? SERVICES_WITHHOLDING_SECTION_BY_SUBCATEGORY[subcat] : "";
                                    const defaultCodes = subcat ? (SERVICES_WITHHOLDING_IRIS_CODES_BY_SUBCATEGORY[subcat] ?? []) : [];
                                    const firstRow = selectedDoc?.withholdingRows?.[0];

                                    updateMatch(match.clientKey, {
                                      withholdingEvidenceDocumentId: docId,
                                      withholdingSection: match.withholdingSection || firstRow?.section || defaultSection || "",
                                      withholdingIrisCode: match.withholdingIrisCode || firstRow?.irisCode || (defaultCodes[0] ?? ""),
                                      withholdingEvidenceReference: match.withholdingEvidenceReference || firstRow?.evidenceReference || (selectedDoc ? `${selectedDoc.fileName} · Page 1` : ""),
                                      withholdingEvidenceHumanConfirmed: Boolean(docId),
                                    });
                                  }}
                                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal"
                                >
                                  <option value="">Choose a mapped withholding document</option>
                                  {withholdingEvidenceDocuments.map((document) => (
                                    <option key={document.id} value={document.id}>
                                      {document.fileName} · {document.documentType.replaceAll("_", " ")}
                                    </option>
                                  ))}
                                </select>
                                <span className="block font-normal text-muted-foreground">Allowed sources: mapped bank statement, other-income proof, or advance-tax/CPR evidence. An invoice alone is not a withholding certificate. If no source is mapped, leave it unselected and keep the amount manual.</span>
                              </label>
                              <label className="space-y-1 text-[11px] font-medium">
                                <span>Statutory section shown on withholding evidence</span>
                                <input
                                  maxLength={100}
                                  value={match.withholdingSection}
                                  onChange={(event) => updateMatch(match.clientKey, { withholdingSection: event.target.value })}
                                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal"
                                  placeholder="Exact wording, e.g. 153(1)(b)"
                                />
                              </label>
                              <label className="space-y-1 text-[11px] font-medium">
                                <span>IRIS code shown by the source evidence</span>
                                <input
                                  list="services-withholding-iris-codes"
                                  maxLength={30}
                                  value={match.withholdingIrisCode}
                                  onChange={(event) => updateMatch(match.clientKey, { withholdingIrisCode: event.target.value })}
                                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal"
                                  placeholder="Enter exact code; unsupported stays manual"
                                />
                              </label>
                              <label className="space-y-1 text-[11px] font-medium sm:col-span-2">
                                <span>Withholding certificate page / line reference</span>
                                <input
                                  maxLength={500}
                                  value={match.withholdingEvidenceReference}
                                  onChange={(event) => updateMatch(match.clientKey, { withholdingEvidenceReference: event.target.value })}
                                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal"
                                  placeholder="Mapped filename, page and withholding line"
                                />
                              </label>
                              <div className="text-[11px] sm:col-span-2">
                                <label className="flex items-start gap-2 font-normal">
                                  <input
                                    type="checkbox"
                                    checked={match.withholdingEvidenceHumanConfirmed}
                                    onChange={(event) => updateMatch(match.clientKey, { withholdingEvidenceHumanConfirmed: event.target.checked })}
                                    className="mt-0.5"
                                  />
                                  <span>I reviewed the withholding amount, exact statutory section, and IRIS code against the mapped document above. Unsupported or ambiguous codes stay manual.</span>
                                </label>
                              </div>
                              <label className="space-y-1 text-[11px] font-medium">
                                <span>Platform fee (PKR; enter 0 only if evidenced)</span>
                                <input type="number" min="0" step="0.01" value={match.platformFeePkr} onChange={(event) => updateMatch(match.clientKey, { platformFeePkr: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal" />
                              </label>
                              <label className="space-y-1 text-[11px] font-medium">
                                <span>Receiving-bank fee (PKR; enter 0 only if evidenced)</span>
                                <input type="number" min="0" step="0.01" value={match.bankFeePkr} onChange={(event) => updateMatch(match.clientKey, { bankFeePkr: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal" />
                              </label>
                              <label className="space-y-1 text-[11px] font-medium">
                                <span>Settlement currency</span>
                                <input maxLength={3} value={match.settlementCurrency} onChange={(event) => {
                                  const currency = event.target.value.toUpperCase();
                                  updateMatch(match.clientKey, { settlementCurrency: currency, settlementExchangeRateToPkr: currency === "PKR" ? "1" : match.settlementExchangeRateToPkr });
                                }} className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal uppercase" placeholder="PKR / USD" />
                              </label>
                              <label className="space-y-1 text-[11px] font-medium">
                                <span>Settlement amount in that currency</span>
                                <input type="number" min="0" step="0.01" value={match.settlementAmount} onChange={(event) => updateMatch(match.clientKey, { settlementAmount: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal" />
                              </label>
                              <label className="space-y-1 text-[11px] font-medium">
                                <span>Settlement FX rate to PKR</span>
                                <input type="number" min="0" step="0.00000001" value={match.settlementExchangeRateToPkr} onChange={(event) => updateMatch(match.clientKey, { settlementExchangeRateToPkr: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal" />
                              </label>
                              <label className="space-y-1 text-[11px] font-medium">
                                <span>Payout ID (if available)</span>
                                <input value={match.payoutReference} onChange={(event) => updateMatch(match.clientKey, { payoutReference: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal" />
                              </label>
                              <label className="space-y-1 text-[11px] font-medium">
                                <span>Statement/page or FX evidence reference</span>
                                <input value={match.evidenceReference} onChange={(event) => updateMatch(match.clientKey, { evidenceReference: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs font-normal" placeholder="Filename, page, payout report" />
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {receipts.length > 0 && (
        <div className="rounded-lg border bg-muted/20 p-3">
          <p className="text-xs font-semibold">Services ledger credits to reconcile</p>
          <ul className="mt-2 space-y-1">
            {receipts.map((receipt) => {
              const allocated = matches
                .filter((match) => match.ledgerEntryId === receipt.id)
                .reduce((sum, match) => sum + (parseOptionalNumber(match.netBankAmountPkr) ?? 0), 0);
              return (
                <li key={receipt.id} className="flex flex-wrap justify-between gap-2 text-[11px]">
                  <span className="min-w-0">{receipt.date ?? "Date missing"} · {receipt.description}</span>
                  <span className={Math.round(allocated * 100) === Math.round(receipt.amount * 100) ? "font-semibold text-amanah" : "font-semibold text-amber-700"}>
                    {formatPkr(allocated)} allocated / {formatPkr(receipt.amount)} credit
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[10px] text-muted-foreground">A payout split across invoices is supported. Every Services bank credit must be allocated exactly to its net PKR amount.</p>
        </div>
      )}

      {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">{error}</p>}
      {savedMessage && <p role="status" className="rounded-lg bg-amanah/5 p-3 text-xs text-amanah">{savedMessage}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={saveEvidence} disabled={saving || !canSave()} className="h-9">
          {saving ? "Saving verified evidence…" : "Confirm Services evidence"}
        </Button>
        <span className="text-[11px] text-muted-foreground">Calculation blocks until missing, unmatched or ambiguous evidence is resolved.</span>
      </div>
    </section>
  );
}
