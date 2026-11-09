"use client";
import { ManualBusinessRecord } from "./manual-business-record";

import { useEffect, useRef, useState } from "react";
import type React from "react";
import {
  CheckCircle2,
  FileText,
  Loader2,
  Sparkles,
  Upload,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StepHeading } from "@/components/tax/wizard-ui";
import { OtherEmployerNamesField } from "@/components/tax/filing/other-employer-names-field";
import { formatCnicInput, normalizeIdentityName } from "@/lib/tax/cnic-profile";
import {
  businessPurchaseBasisRequired,
  isBusinessPurchaseBasisField,
  parseBusinessPurchaseBasis,
} from "@/lib/tax/business-schedule-fields";
import {
  isDocumentReviewRequiredField,
  getDocumentReviewRequiredErrors,
  documentReviewFieldRequirement,
} from "@/lib/tax/document-review-required";
import { isPensionReviewDecisionField, pensionFieldKey, type PensionReviewDecisionKey } from "@/lib/tax/pension-statement-fields";
import { PensionTaxReviewPanel } from "./pension-tax-review-panel";
import { getTaxYearDateInputBounds } from "@/lib/tax/tax-year-period";
import { isDocumentExtractionLeaseStale } from "@/lib/tax/document-extraction-state";
import {
  getSalaryCertificateFieldKind,
  isSalaryCertificateRequiredField,
  hasRequiredSalaryCertificateAmounts,
  hasRequiredSalaryCertificateEmployer,
  checkSalaryCertificateTaxYear,
} from "@/lib/tax/salary-certificate-fields";
import {
  hasRequiredBankStatementIban,
  isBankStatementIbanLabel,
  validateBankStatementIban,
} from "@/lib/tax/bank-statement-fields";
import { BusinessListFieldEditor } from "@/components/tax/filing/business-list-field-editor";
import {
  businessListFieldDefinition,
  businessListFieldErrors,
  type BusinessListRow,
} from "@/lib/tax/business-list-fields";
import { IRIS_PRINCIPAL_ACTIVITIES } from "@/lib/tax/business-identity";
import { MINIMUM_TAX_CATEGORIES } from "@/lib/tax/minimum-tax-113";

export type ExtractedTransaction = {
  date?: string | null;
  description: string;
  debit?: string | number | null;
  credit?: string | number | null;
  balance?: string | number | null;
  confidence?: number;
};

export type ExtractedPayload = {
  documentType?: string;
  fields?: Array<{
    label: string;
    /**
     * Scalar fields use the primitive values below. Business detail lists
     * arrive from the server as structured row arrays; raw JSON is never an
     * editable browser field.
     */
    value: string | number | boolean | null | BusinessListRow[];
    confidence?: number;
    /** Pension review suggestions only: quoted PDF text, never approval. */
    sourceEvidence?: string;
    reviewSuggestion?: boolean;
  }>;
  transactions?: ExtractedTransaction[];
  notes?: string[];
  purchaseBasisSourceEvidence?: string;
  /** Previous return only: printed Wealth Statement rows (read-only evidence). */
  previousReturnWealthRows?: Array<{
    code: string;
    description: string;
    amount: number;
    detail: boolean;
  }>;
};

export type FilingDocumentRecord = {
  id: string;
  fileName: string;
  extractionStatus: string;
  extractionProvider: string | null;
  extractionStartedAt?: string | null;
  extractionError?: string | null;
  extractedAt: string | null;
};

export type WizardDocumentSlot = {
  documentType: string;
  slotKey?: string;
  bankAccountId?: string;
  label: string;
  reason: string;
  required: boolean;
};

type WizardDocumentsStepProps = Readonly<{
  draftId?: string | null;
  onManualRecordSaved?: () => void;
  taxYear: number;
  /**
   * 28-Oct-2026: a Filer answer is the taxpayer's own choice to rely on the
   * previous year's return, so the slot becomes required by that answer alone —
   * never by the document list itself. Non-filer (or no answer) leaves it
   * optional, and an uploaded one must still be approved before continuing.
   */
  previousReturnRequiredByFiler?: boolean;
  /**
   * 28-Oct-2026: money in the bank on day one that last year's approved wealth
   * statement never declared. Read-only warning shown above the slots; it never
   * blocks Continue.
   */
  openingBalanceWarning?: string | null;
  documentSlots: WizardDocumentSlot[];
  uploadedDocuments: Record<string, string>;
  documentRecords: Record<string, FilingDocumentRecord>;
  extractedByDocumentId: Record<string, ExtractedPayload>;
  uploadingDocumentType: string | null;
  extractingDocumentId: string | null;
  reviewingDocumentId: string | null;
  savingDocumentReviewId: string | null;
  mappingDocumentId: string | null;
  documentUploadError: string | null;
  profileSyncNote: string | null;
  uploadFileInputsRef: React.MutableRefObject<
    Record<string, HTMLInputElement | null>
  >;
  triggerDocumentUpload: (documentType: string) => void;
  handleDocumentFileSelected: (
    documentType: string,
    fileList: FileList | null,
  ) => void;
  handleExtractDocument: (documentType: string) => void;
  handleReviewDocument: (documentType: string) => void;
  handleExtractedFieldChange: (
    documentType: string,
    fieldIndex: number,
    value: string,
  ) => void;
  handlePensionReviewFieldChange: (
    documentType: string,
    key: PensionReviewDecisionKey,
    value: string,
  ) => void;
  handleExtractedListFieldChange?: (
    documentType: string,
    fieldIndex: number,
    value: BusinessListRow[] | null,
  ) => void;
  handleExtractedTransactionChange: (
    documentType: string,
    transactionIndex: number,
    patch: Partial<ExtractedTransaction>,
  ) => void;
  handleSaveDocumentReview: (documentType: string) => void;
  handleMapDocument: (documentType: string) => void;
  handleRemoveDocument: (documentType: string) => void;
  handleRecoverBusinessPurchaseBasis?: (documentType: string) => void;
  handleSaveStatementIban: (documentType: string) => void;
  handleSaveSalaryEmployers: (documentType: string) => void;
  isSalaryEmployerDirty: (documentType: string) => boolean;
}>;

export function WizardDocumentsStep({
  draftId, onManualRecordSaved,
  taxYear,
  previousReturnRequiredByFiler = false,
  openingBalanceWarning = null,
  documentSlots,
  uploadedDocuments,
  documentRecords,
  extractedByDocumentId,
  uploadingDocumentType,
  extractingDocumentId,
  reviewingDocumentId,
  savingDocumentReviewId,
  mappingDocumentId,
  documentUploadError,
  profileSyncNote,
  uploadFileInputsRef,
  triggerDocumentUpload,
  handleDocumentFileSelected,
  handleExtractDocument,
  handleReviewDocument,
  handleExtractedFieldChange,
  handlePensionReviewFieldChange,
  handleExtractedListFieldChange,
  handleExtractedTransactionChange,
  handleSaveDocumentReview,
  handleMapDocument,
  handleRemoveDocument,
  handleRecoverBusinessPurchaseBasis,
  handleSaveStatementIban,
  handleSaveSalaryEmployers,
  isSalaryEmployerDirty,
}: WizardDocumentsStepProps) {
  const [now, setNow] = useState(() => Date.now());
  const hasProcessingDocument = Object.values(documentRecords).some(
    (document) => document.extractionStatus === "PROCESSING",
  );

  useEffect(() => {
    if (!hasProcessingDocument) return;
    const interval = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(interval);
  }, [hasProcessingDocument]);

  const taxYearBounds = getTaxYearDateInputBounds(taxYear);
  const documentErrorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!documentUploadError) return;
    documentErrorRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [documentUploadError]);

  return (
    <div className="space-y-6">
      <StepHeading
        title="Upload your documents"
        description="Upload each document one at a time, then review Gemini's extracted data before mapping it."
      />

      {profileSyncNote && (
        <div
          role="status"
          className="rounded-lg border border-amanah/25 bg-amanah/5 p-3 text-sm text-amanah"
        >
          {profileSyncNote}
        </div>
      )}

      {documentUploadError && (
        <div
          ref={documentErrorRef}
          role="alert"
          className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {documentUploadError}
        </div>
      )}

      <div className="rounded-xl border border-amanah/20 bg-amanah/5 p-4">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-amanah" />
          <p className="text-sm text-amanah">
            AI will extract salary, tax deducted, account balances, and more
            directly from what you upload. You can review and correct the
            extracted fields before approving the mapping.
          </p>
        </div>
      </div>

      {openingBalanceWarning && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">
            Check the bank statement&apos;s opening balance before you go further
          </p>
          <p className="mt-1 text-xs leading-relaxed text-amber-900">
            {openingBalanceWarning}
          </p>
        </div>
      )}

      <div className="grid gap-3">
        <h3 className="text-sm font-medium text-muted-foreground">Documents</h3>

        {documentSlots.map((slot) => {
          const slotKey = slot.slotKey ?? slot.documentType;
          // The list never makes the previous return required; only the
          // taxpayer's own Filer answer does.
          const slotRequired =
            slot.required ||
            (slot.documentType === "previous_return" &&
              previousReturnRequiredByFiler);
          // The slot's own label says "(Optional)". When the Filer answer makes
          // it required, that word contradicts the "Required" badge, so it is
          // dropped from the title (the reason is printed underneath).
          const slotLabel =
            slotRequired && slot.documentType === "previous_return"
              ? slot.label.replace(/\s*\(optional\)\s*$/i, "")
              : slot.label;
          const uploadedFileName = uploadedDocuments[slotKey];
          const documentRecord = documentRecords[slotKey];
          const extracted = documentRecord
            ? extractedByDocumentId[documentRecord.id]
            : undefined;
          const isUploading = uploadingDocumentType === slotKey;
          const isExtracting = extractingDocumentId === documentRecord?.id;
          const isProcessing =
            documentRecord?.extractionStatus === "PROCESSING";
          const extractionLeaseStale = isDocumentExtractionLeaseStale(
            documentRecord?.extractionStatus ?? "",
            documentRecord?.extractionStartedAt,
            now,
          );
          const isReviewing = reviewingDocumentId === documentRecord?.id;
          const isSavingReview = savingDocumentReviewId === documentRecord?.id;
          const isMapping = mappingDocumentId === documentRecord?.id;
          const hasExtraction =
            documentRecord?.extractionStatus === "COMPLETED" ||
            documentRecord?.extractionStatus === "MAPPED" ||
            (documentRecord?.extractionStatus === "FAILED" &&
              Boolean(extracted));
          const isMapped = documentRecord?.extractionStatus === "MAPPED";
          const isCnicDocument = slot.documentType === "cnic";
          const isSalaryCertificate =
            slot.documentType === "salary_certificate";
          const isPensionStatement =
            slot.documentType === "pension_statement";
          const isMappableDocument =
            isCnicDocument ||
            slot.documentType === "bank_statement" ||
            isSalaryCertificate ||
            slot.documentType === "business_balance_sheet" ||
            slot.documentType === "business_books" ||
            slot.documentType === "business_support" ||
            isPensionStatement ||
            slot.documentType === "invoice_summary" ||
            slot.documentType === "other_income_proof" ||
            slot.documentType === "advance_tax_evidence" ||
            slot.documentType === "previous_return" ||
            slot.documentType === "pseb_certificate";
          const hasFields = Boolean(extracted?.fields?.length);
          const isBankStatement = slot.documentType === "bank_statement";
          const purchaseBasisNeeded =
            slot.documentType === "business_books" &&
            businessPurchaseBasisRequired(extracted?.fields);
          const purchaseBasisValue = extracted?.fields?.find((field) =>
            isBusinessPurchaseBasisField(field.label),
          )?.value;
          const purchaseBasisMissing =
            purchaseBasisNeeded &&
            parseBusinessPurchaseBasis(purchaseBasisValue) === null;
          const reviewRequiredErrors = getDocumentReviewRequiredErrors(
            slot.documentType,
            extracted?.fields,
            taxYear,
          );
          const inlineRequiredErrors = reviewRequiredErrors.filter(
            (error) => !isBankStatement || !/^IBAN\b/.test(error),
          );
          // Detail lists are edited as rows below. Only an unreadable or
          // malformed stored list blocks mapping here; incomplete rows are
          // completed on Business data review and checked again for FBR.
          const businessListErrors = businessListFieldErrors(
            extracted?.fields,
            taxYear,
          );
          const requiredSalaryAmountsReady =
            !isSalaryCertificate ||
            hasRequiredSalaryCertificateAmounts(extracted?.fields);
          // IRIS needs the employer added by its registered name.
          const requiredSalaryEmployerReady =
            !isSalaryCertificate ||
            hasRequiredSalaryCertificateEmployer(extracted?.fields);
          // The certificate must be for THIS return's tax year.
          const salaryTaxYearCheck = isSalaryCertificate
            ? checkSalaryCertificateTaxYear(extracted?.fields, taxYear)
            : { ok: true, error: undefined, certificateTaxYear: null };
          const requiredSalaryTaxYearReady = salaryTaxYearCheck.ok;
          const employerEditsUnsaved =
            isSalaryCertificate && isSalaryEmployerDirty(slotKey);
          // The IBAN is read from the statement; when it is not on it the
          // review shows a blank required field, like the salary amounts.
          const requiredIbanReady =
            !isBankStatement || hasRequiredBankStatementIban(extracted?.fields);
          // A statement mapped before the IBAN was required stays mapped; only
          // the IBAN is editable, with its own save (no re-mapping).
          const ibanEditableAfterMap =
            isMapped && isBankStatement && !requiredIbanReady;
          // The employer names stay editable after mapping (own save, no
          // re-extraction): the taxpayer may only learn the exact IRIS name
          // when the FBR list is open.
          const employersEditableAfterMap = isMapped && isSalaryCertificate;
          const ibanProblem =
            isBankStatement && extracted?.fields
              ? validateBankStatementIban(extracted.fields).error
              : "";

          return (
            <div
              key={slotKey}
              className={`overflow-hidden rounded-lg border text-sm ${
                slotRequired
                  ? "border-amanah/20 bg-amanah/5"
                  : "border-dashed opacity-90"
              }`}
            >
              {!documentRecord && draftId && ["business_books", "business_balance_sheet", "business_support"].includes(slot.documentType) && <ManualBusinessRecord draftId={draftId} documentType={slot.documentType} taxYear={taxYear} onSaved={() => onManualRecordSaved?.()} />}
              <div className="flex min-w-0 flex-col gap-3 p-3 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
                      uploadedFileName
                        ? "bg-amanah/15 text-amanah"
                        : slotRequired
                          ? "bg-amanah/10 text-amanah"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {uploadedFileName ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <FileText className="h-4 w-4" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`font-medium ${slotRequired ? "text-foreground" : "text-muted-foreground"}`}
                      >
                        {slotLabel}
                      </span>
                      {slotRequired ? (
                        <Badge
                          variant="outline"
                          className="border-amanah/25 bg-amanah/10 px-1.5 py-0 text-[10px] text-amanah"
                        >
                          {slot.documentType === "previous_return"
                            ? "Required — you answered Filer"
                            : "Required"}
                        </Badge>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">
                          Optional
                        </span>
                      )}
                      {isMapped && (
                        <Badge
                          variant="outline"
                          className="border-emerald-300 bg-emerald-50 px-1.5 py-0 text-[10px] text-emerald-700"
                        >
                          Mapped
                        </Badge>
                      )}
                      {documentRecord?.extractionProvider === "USER_DECLARED" && <Badge variant="outline">User-declared · not third-party evidence</Badge>}
                      {hasExtraction && !isMapped && (
                        <Badge
                          variant="outline"
                          className="border-blue-200 bg-blue-50 px-1.5 py-0 text-[10px] text-blue-700"
                        >
                          {isMappableDocument
                            ? "Review & map"
                            : "Extraction complete"}
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {uploadedFileName
                        ? `Uploaded: ${uploadedFileName}`
                        : slot.reason}
                    </p>
                    {isProcessing && !extractionLeaseStale && (
                      <p role="status" className="mt-1 text-xs text-blue-700">
                        Extraction is running. This status and the result will
                        be restored if you refresh.
                      </p>
                    )}
                    {isProcessing && extractionLeaseStale && (
                      <p role="status" className="mt-1 text-xs text-amber-700">
                        This attempt looks stuck. Choose Retry extraction; you
                        do not need to replace the document.
                      </p>
                    )}
                    {documentRecord?.extractionStatus === "FAILED" &&
                      documentRecord.extractionError && (
                        <p
                          role="alert"
                          className="mt-1 text-xs text-destructive"
                        >
                          {documentRecord.extractionError}
                        </p>
                      )}
                  </div>
                </div>

                <input
                  ref={(element) => {
                    uploadFileInputsRef.current[slotKey] = element;
                  }}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.csv,.xls,.xlsx"
                  className="hidden"
                  onChange={(event) => {
                    handleDocumentFileSelected(slotKey, event.target.files);
                    event.currentTarget.value = "";
                  }}
                />

                <div className="flex w-full shrink-0 gap-2 sm:w-auto">
                  <Button
                    type="button"
                    variant={uploadedFileName ? "outline" : "default"}
                    size="sm"
                    className="min-w-0 flex-1 gap-1.5 sm:w-auto"
                    onClick={() => triggerDocumentUpload(slotKey)}
                    disabled={isUploading}
                  >
                    {isUploading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" />
                    )}
                    {isUploading
                      ? "Uploading..."
                      : uploadedFileName
                        ? "Replace"
                        : "Upload"}
                  </Button>

                  {uploadedFileName &&
                    (!slotRequired ||
                      (slot.documentType === "previous_return" &&
                        previousReturnRequiredByFiler)) && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-w-0 flex-1 gap-1.5 sm:w-auto"
                        title={
                          slot.documentType === "previous_return"
                            ? "Remove this document. Filing can continue without it."
                            : "Remove this document and the figures it fed. The tax calculation must be run again."
                        }
                        onClick={() => {
                          // An approved document has numbers in the packet, so
                          // the destructive click is confirmed first.
                          if (isMapped) {
                            const confirmed = window.confirm(
                              `Remove "${slotLabel}"? It is approved and mapped. The amounts it fed are dropped too, and Recalculate has to be run again.`,
                            );
                            if (!confirmed) return;
                          }
                          handleRemoveDocument(slotKey);
                        }}
                        disabled={isUploading || isExtracting || isMapping}
                      >
                        Remove
                      </Button>
                    )}

                  {uploadedFileName && documentRecord && (!hasExtraction || documentRecord.extractionStatus === "FAILED") && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-w-0 flex-1 gap-1.5 sm:w-auto"
                      onClick={() => handleExtractDocument(slotKey)}
                      disabled={
                        isExtracting || (isProcessing && !extractionLeaseStale)
                      }
                    >
                      {isExtracting ||
                      (isProcessing && !extractionLeaseStale) ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      {isExtracting
                        ? "Extracting..."
                        : isProcessing
                          ? extractionLeaseStale
                            ? "Retry extraction"
                            : "Extracting..."
                          : documentRecord.extractionStatus === "FAILED" ? "Retry extraction" : "Extract"}
                    </Button>
                  )}

                  {uploadedFileName &&
                    documentRecord &&
                    hasExtraction &&
                    !extracted && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-w-0 flex-1 gap-1.5 sm:w-auto"
                        onClick={() => handleReviewDocument(slotKey)}
                        disabled={isReviewing}
                      >
                        {isReviewing ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : isMapped ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" />
                        ) : (
                          <FileText className="h-3.5 w-3.5" />
                        )}
                        {isReviewing
                          ? "Loading..."
                          : isMapped
                            ? "View mapped data"
                            : isMappableDocument
                              ? "Review & map data"
                              : "Review extracted data"}
                      </Button>
                    )}

                  {uploadedFileName && documentRecord && extracted && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-w-0 flex-1 gap-1.5 sm:w-auto"
                      disabled
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {isMapped ? "Mapped" : isPensionStatement ? "Awaiting approval" : "Reviewed"}
                    </Button>
                  )}
                </div>
              </div>

              {extracted && (
                <div className="border-t bg-background/70 p-4">
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        {isMapped
                          ? "Mapped extracted data"
                          : "Review extracted data"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {isMapped
                          ? isPensionStatement
                            ? "Pension source is approved. Editing requires Save & Approve Map again, then a new tax calculation and packet. Changes are not applied until saved."
                            : employersEditableAfterMap
                            ? "This document is already mapped. The values below are read-only, except the employer names: change them and press Save employer."
                            : purchaseBasisMissing
                              ? "Books are mapped, but the purchase tax basis still needs to be confirmed and re-approved; other persisted amounts remain read-only."
                              : purchaseBasisNeeded
                                ? "Books are mapped. If you change the purchase tax basis below, Save & Approve Map will appear again; other persisted amounts remain read-only."
                                : "This document is already mapped. The persisted values below are read-only."
                          : "Check the values below before approving and mapping this document."}
                      </p>
                    </div>

                    {ibanEditableAfterMap && (
                      <div className="flex flex-wrap gap-2 sm:justify-end">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => handleSaveStatementIban(slotKey)}
                          disabled={isSavingReview}
                        >
                          {isSavingReview ? "Saving IBAN..." : "Save IBAN"}
                        </Button>
                      </div>
                    )}

                    {employersEditableAfterMap && (
                      <div className="flex flex-wrap gap-2 sm:justify-end">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => handleSaveSalaryEmployers(slotKey)}
                          disabled={
                            isSavingReview ||
                            !requiredSalaryEmployerReady ||
                            !employerEditsUnsaved
                          }
                        >
                          {isSavingReview
                            ? "Saving employer..."
                            : employerEditsUnsaved
                              ? "Save employer"
                              : "Employer saved"}
                        </Button>
                      </div>
                    )}

                    {purchaseBasisMissing &&
                      handleRecoverBusinessPurchaseBasis && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={isSavingReview || isMapping}
                          onClick={() =>
                            handleRecoverBusinessPurchaseBasis(slotKey)
                          }
                        >
                          {isSavingReview
                            ? "Re-reading original Books..."
                            : "Re-read purchase basis from document"}
                        </Button>
                      )}
                    {isMapped &&
                    isMappableDocument &&
                    !ibanEditableAfterMap &&
                    !employersEditableAfterMap &&
                    !purchaseBasisMissing ? (
                      <div className="flex flex-wrap gap-2 sm:justify-end">
                        <Button type="button" size="sm" variant="outline" disabled>
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" />
                          Mapped
                        </Button>
                      </div>
                    ) : (
                      (!isMapped || purchaseBasisMissing) && (
                        <div className="flex flex-wrap gap-2 sm:justify-end">
                          {isMappableDocument ? (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => handleMapDocument(slotKey)}
                              disabled={
                                isMapping ||
                                isSavingReview ||
                                !hasFields ||
                                !requiredSalaryAmountsReady ||
                                !requiredSalaryEmployerReady ||
                                !requiredSalaryTaxYearReady ||
                                !requiredIbanReady ||
                                reviewRequiredErrors.length > 0 ||
                                businessListErrors.length > 0
                              }
                            >
                              {isMapping
                                ? isCnicDocument
                                  ? "Saving & updating profile..."
                                  : "Saving & mapping..."
                                : isCnicDocument
                                  ? "Approve & update profile"
                                  : "Save & Approve Map"}
                            </Button>
                          ) : (
                            <span className="self-center text-xs text-muted-foreground">
                              Mapping for this document type is not available yet.
                            </span>
                          )}
                        </div>
                      )
                    )}
                  </div>

                  {isPensionStatement && (
                    <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                      {!isMapped && (
                        <strong className="mb-1 block">
                          PDF values are suggestions, not approval. Check the printed review values and current tax ledger, then confirm with Save & Approve Map.
                        </strong>
                      )}
                      Review annual gross pension separately from net receipts and medical allowances.
                      Enter the approved annual pension tax base and explain allowance treatment/differences from bank receipts.
                      Confirm actual pension tax deducted (0 only after verification), and how much of it is already in TAX_PAYMENT ledger rows (0 if none).
                      This approval updates the tax source, not cash income or profile DOB. Changes require a new calculation and packet.
                      A reviewed above-10M, below-age-70 pension is mapped to IRIS 1008, 64020007 and 923184; missing age or unsupported withholding cases remain manual.
                    </p>
                  )}
                  {isPensionStatement && hasExtraction && (
                    <PensionTaxReviewPanel
                      fields={extracted?.fields ?? []}
                      approved={isMapped}
                      onChange={(key, value) =>
                        handlePensionReviewFieldChange(slot.documentType, key, value)
                      }
                    />
                  )}

                  {isSalaryCertificate && (
                    <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                      Annual gross salary and annual tax deducted under Section
                      149 are required. Verify both against the certificate;
                      enter 0 only if the certificate confirms that no salary
                      tax was withheld.
                    </p>
                  )}

                  {slot.documentType === "previous_return" &&
                    !uploadedFileName && (
                      <p className="mb-3 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                        {previousReturnRequiredByFiler
                          ? `You answered Filer, so this return is required. Upload the Tax Year ${taxYear - 1} return printed from IRIS, then press Save & Approve Map — this step will not pass without both.`
                          : `Optional. Skip it if you do not have last year's return — the filing continues without it. If you do upload it, it must be the Tax Year ${taxYear - 1} return and it must be reviewed and Save & Approve Map'd before this step can pass.`}
                      </p>
                    )}

                  {slot.documentType === "previous_return" &&
                    (extracted?.previousReturnWealthRows?.length ?? 0) > 0 && (
                      <div className="mb-3 rounded-lg border bg-card p-3">
                        <p className="mb-2 text-xs font-semibold">
                          Wealth detail in this return{" "}
                          <span className="font-normal text-muted-foreground">
                            (read from the printed Wealth Statement — read-only)
                          </span>
                        </p>
                        <ul className="divide-y text-xs">
                          {extracted.previousReturnWealthRows.map((row, index) => (
                            <li
                              key={`${row.code}-${index}`}
                              className={`flex items-baseline justify-between gap-3 py-1 ${row.detail ? "pl-4 text-muted-foreground" : "font-medium"}`}
                            >
                              <span>
                                {row.description}{" "}
                                <span className="text-muted-foreground">
                                  ({row.code})
                                </span>
                              </span>
                              <span>{Number(row.amount).toLocaleString()}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2 text-[11px] text-muted-foreground">
                          These rows add up to the Total Assets / Total
                          Liabilities above; the totals are what you approve.
                        </p>
                      </div>
                    )}

                  {slot.documentType === "business_balance_sheet" && !isMapped && (
                    <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                      Every Balance Sheet row is required: type the figure
                      from your Balance Sheet, or 0 if the business has none
                      (do not leave a box empty). The 10 asset rows must add
                      up to Total Assets, Owner Capital and the 3 liability
                      rows must add up to Total Equity and Liabilities, and
                      the two totals must be equal.
                    </p>
                  )}

                  {slot.documentType === "business_balance_sheet" &&
                    isMapped &&
                    reviewRequiredErrors.length > 0 && (
                      <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                        This Balance Sheet was mapped before every row had to
                        be filled and add up to the totals, and mapped values
                        cannot be edited. Press Replace, upload it again, fill
                        every row (0 if the business has none) and press Save
                        &amp; Approve Map.
                      </p>
                    )}

                  {hasFields ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {extracted.fields?.map((field, fieldIndex) => {
                        const isPensionReviewNote =
                          isPensionStatement && pensionFieldKey(field.label) === "reviewNote";
                        const isPdfReviewSuggestion =
                          isPensionStatement && !isMapped &&
                          isPensionReviewDecisionField(field.label) &&
                          field.reviewSuggestion === true;
                        const normalizedFieldLabel = field.label
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, "_");
                        const isStatementDateField =
                          /statement|from_date|to_date|transaction|value_date/.test(
                            normalizedFieldLabel,
                          );
                        const isIdentityDateField = [
                          "date_of_birth",
                          "dob",
                          "birth_date",
                          "expiry_date",
                          "expiry",
                          "valid_upto",
                          "valid_until",
                          "date_of_expiry",
                        ].includes(normalizedFieldLabel);
                        const isCnicField = [
                          "cnic_number",
                          "cnic",
                          "identity_number",
                        ].includes(normalizedFieldLabel);
                        const isNameField = [
                          "name",
                          "full_name",
                          "taxpayer_name",
                        ].includes(normalizedFieldLabel);
                        const fieldRequirement =
                          documentReviewFieldRequirement(
                            slot.documentType,
                            field.label,
                          );
                        const requiredField = isDocumentReviewRequiredField(
                          slot.documentType,
                          field.label,
                          extracted?.fields,
                        );
                        const salaryFieldKind = getSalaryCertificateFieldKind(
                          field.label,
                        );
                        const isBusinessDateField = [
                          "business_start_date",
                          "business_end_date",
                          "Balance_sheet_date",
                        ].includes(normalizedFieldLabel);
                        const isDateField =
                          isStatementDateField ||
                          isIdentityDateField ||
                          isBusinessDateField ||
                          fieldRequirement?.kind === "date";
                        const isAmountField =
                          fieldRequirement?.kind === "amount" ||
                          fieldRequirement?.kind === "positive_amount" ||
                          salaryFieldKind === "gross_salary" ||
                          salaryFieldKind === "tax_withheld";
                        const isYearField =
                          fieldRequirement?.kind === "year" ||
                          salaryFieldKind === "tax_year";
                        const listDefinition = businessListFieldDefinition(
                          field.label,
                        );

                        if (listDefinition) {
                          return (
                            <div
                              key={`${field.label}-${fieldIndex}`}
                              className="sm:col-span-2"
                            >
                              <BusinessListFieldEditor
                                label={field.label}
                                value={field.value}
                                confidence={field.confidence}
                                readOnly={
                                  isMapped || isSavingReview || isMapping
                                }
                                taxYear={taxYear}
                                onChange={(next) =>
                                  handleExtractedListFieldChange?.(
                                    slotKey,
                                    fieldIndex,
                                    next,
                                  )
                                }
                              />
                            </div>
                          );
                        }

                        const booleanBusinessFact = [
                          "sales_exclude_sales_tax_and_fed",
                          "turnover_100_million_in_earlier_year",
                        ].includes(normalizedFieldLabel);
                        if (booleanBusinessFact) {
                          const parsed = parseBusinessPurchaseBasis(
                            field.value,
                          );
                          return (
                            <label
                              key={`${field.label}-${fieldIndex}`}
                              className="grid gap-1"
                            >
                              <span className="text-xs font-medium text-muted-foreground">
                                {field.label}
                                {typeof field.confidence === "number" &&
                                  field.confidence > 0 &&
                                  ` · ${Math.round(field.confidence * 100)}% confidence`}
                              </span>
                              <select
                                className="h-9 rounded-lg border bg-background px-3 text-sm"
                                value={parsed === null ? "" : String(parsed)}
                                disabled={isMapped || isSavingReview || isMapping}
                                onChange={(event) =>
                                  handleExtractedFieldChange(
                                    slotKey,
                                    fieldIndex,
                                    event.target.value,
                                  )
                                }
                              >
                                <option value="">
                                  Not extracted / unknown
                                </option>
                                <option value="true">Yes</option>
                                <option value="false">No</option>
                              </select>
                            </label>
                          );
                        }

                        if (normalizedFieldLabel === "principal_activity") {
                          const currentActivity = String(field.value ?? "");
                          const unsupportedActivity =
                            currentActivity &&
                            !(
                              IRIS_PRINCIPAL_ACTIVITIES as readonly string[]
                            ).includes(currentActivity);
                          return (
                            <label
                              key={`${field.label}-${fieldIndex}`}
                              className="grid gap-1"
                            >
                              <span className="text-xs font-medium text-muted-foreground">
                                {field.label}
                                {typeof field.confidence === "number" &&
                                  field.confidence > 0 &&
                                  ` · ${Math.round(field.confidence * 100)}% confidence`}
                              </span>
                              <select
                                className="h-9 rounded-lg border bg-background px-3 text-sm"
                                value={currentActivity}
                                disabled={isMapped || isSavingReview || isMapping}
                                onChange={(event) =>
                                  handleExtractedFieldChange(
                                    slotKey,
                                    fieldIndex,
                                    event.target.value,
                                  )
                                }
                              >
                                <option value="">
                                  Not extracted / unknown
                                </option>
                                {unsupportedActivity ? (
                                  <option value={currentActivity}>
                                    {currentActivity} (extracted — choose a
                                    supported activity)
                                  </option>
                                ) : null}
                                {IRIS_PRINCIPAL_ACTIVITIES.map((activity) => (
                                  <option key={activity} value={activity}>
                                    {activity}
                                  </option>
                                ))}
                              </select>
                            </label>
                          );
                        }

                        if (normalizedFieldLabel === "section_113_category") {
                          const currentCategory = String(field.value ?? "");
                          const unsupportedCategory =
                            currentCategory &&
                            !MINIMUM_TAX_CATEGORIES.some(
                              (category) => category.id === currentCategory,
                            );
                          return (
                            <label
                              key={`${field.label}-${fieldIndex}`}
                              className="grid gap-1"
                            >
                              <span className="text-xs font-medium text-muted-foreground">
                                {field.label}
                                {typeof field.confidence === "number" &&
                                  field.confidence > 0 &&
                                  ` · ${Math.round(field.confidence * 100)}% confidence`}
                              </span>
                              <select
                                className="h-9 rounded-lg border bg-background px-3 text-sm"
                                value={currentCategory}
                                disabled={isMapped || isSavingReview || isMapping}
                                onChange={(event) =>
                                  handleExtractedFieldChange(
                                    slotKey,
                                    fieldIndex,
                                    event.target.value,
                                  )
                                }
                              >
                                <option value="">
                                  Not extracted / unknown
                                </option>
                                {unsupportedCategory ? (
                                  <option value={currentCategory}>
                                    {currentCategory} (extracted — choose a
                                    supported category)
                                  </option>
                                ) : null}
                                {MINIMUM_TAX_CATEGORIES.map((category) => (
                                  <option key={category.id} value={category.id}>
                                    {category.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                          );
                        }

                        const displayValue = isCnicField
                          ? formatCnicInput(field.value)
                          : isNameField
                            ? normalizeIdentityName(field.value)
                            : isAmountField || isYearField
                              ? // Number inputs cannot display comma-grouped
                                // extraction strings such as "80,000,000".
                                String(field.value ?? "").replace(/,/g, "")
                              : String(field.value ?? "");

                        if (
                          isSalaryCertificate &&
                          getSalaryCertificateFieldKind(field.label) ===
                            "other_employers"
                        ) {
                          return (
                            <OtherEmployerNamesField
                              key={`${field.label}-${fieldIndex}`}
                              value={String(field.value ?? "")}
                              readOnly={isMapped && !employersEditableAfterMap}
                              onChange={(next) =>
                                handleExtractedFieldChange(
                                  slotKey,
                                  fieldIndex,
                                  next,
                                )
                              }
                            />
                          );
                        }

                        if (
                          slot.documentType === "business_books" &&
                          isBusinessPurchaseBasisField(field.label)
                        ) {
                          const value = parseBusinessPurchaseBasis(field.value);
                          return (
                            <label
                              key={`${field.label}-${fieldIndex}`}
                              className="grid gap-1"
                            >
                              <span className="text-xs font-medium text-muted-foreground">
                                {field.label}
                                {purchaseBasisNeeded && (
                                  <span className="ml-1 text-destructive">
                                    · Required
                                  </span>
                                )}
                              </span>
                              <select
                                className="h-9 rounded-lg border bg-background px-3 text-sm"
                                value={value === null ? "" : String(value)}
                                disabled={isSavingReview || isMapping}
                                required={purchaseBasisNeeded}
                                aria-required={purchaseBasisNeeded}
                                aria-invalid={purchaseBasisMissing}
                                onChange={(event) =>
                                  handleExtractedFieldChange(
                                    slotKey,
                                    fieldIndex,
                                    event.target.value,
                                  )
                                }
                              >
                                <option value="">
                                  Not extracted / unknown
                                </option>
                                <option value="true">
                                  Yes — purchases exclude Sales Tax and FED
                                </option>
                                <option value="false">
                                  No — purchases do not exclude Sales Tax and
                                  FED
                                </option>
                              </select>
                              <span className="text-xs text-muted-foreground">
                                Purchase-specific fact only. Re-read the
                                original document, or select what your purchase
                                records explicitly state, then Save & Approve
                                Map.
                              </span>
                              {typeof extracted?.purchaseBasisSourceEvidence ===
                                "string" && (
                                <span className="text-xs text-amanah">
                                  Recovered quotation:{" "}
                                  {extracted.purchaseBasisSourceEvidence}
                                </span>
                              )}
                            </label>
                          );
                        }
                        return (
                          <label
                            key={`${field.label}-${fieldIndex}`}
                            className={
                              isPensionReviewNote ? "grid gap-1 sm:col-span-2" : "grid gap-1"
                            }
                          >
                            <span className="text-xs font-medium text-muted-foreground">
                              {field.label}
                              {requiredField && (
                                <span className="ml-1 text-destructive">
                                  · Required
                                </span>
                              )}
                              {isPdfReviewSuggestion && (
                                <span className="ml-1 text-amber-700">
                                  · PDF suggestion — approval required
                                </span>
                              )}
                              {typeof field.confidence === "number" &&
                                field.confidence > 0 &&
                                // A missing pension fact has no confidence to
                                // show: a stale extraction score must not make
                                // an unstated amount look verified.
                                !(
                                  isPensionStatement &&
                                  (field.value === null ||
                                    field.value === undefined ||
                                    String(field.value).trim() === "")
                                ) &&
                                ` · ${Math.round(field.confidence * 100)}% confidence`}
                            </span>
                            {isPdfReviewSuggestion && typeof field.sourceEvidence === "string" && (
                              <span className="text-xs text-muted-foreground">
                                Quoted PDF text — verify against the original: {field.sourceEvidence}
                              </span>
                            )}
                            <input
                              type={
                                isDateField
                                  ? "date"
                                  : isAmountField || isYearField
                                    ? "number"
                                    : "text"
                              }
                              min={
                                isStatementDateField
                                  ? taxYearBounds.min
                                  : isAmountField
                                    ? 0
                                    : isYearField
                                      ? 2000
                                      : undefined
                              }
                              max={
                                isStatementDateField
                                  ? taxYearBounds.max
                                  : isYearField
                                    ? 2100
                                    : undefined
                              }
                              step={
                                isAmountField
                                  ? "0.01"
                                  : isYearField
                                    ? 1
                                    : undefined
                              }
                              inputMode={
                                isCnicField || isYearField
                                  ? "numeric"
                                  : isAmountField
                                    ? "decimal"
                                    : undefined
                              }
                              required={requiredField}
                              aria-required={requiredField}
                              aria-invalid={Boolean(
                                isBankStatement &&
                                isBankStatementIbanLabel(field.label) &&
                                ibanProblem,
                              )}
                              placeholder={
                                isBankStatement &&
                                isBankStatementIbanLabel(field.label)
                                  ? "PK36SCBL0000001123456702"
                                  : undefined
                              }
                              maxLength={
                                isBankStatement &&
                                isBankStatementIbanLabel(field.label)
                                  ? 24
                                  : isCnicField
                                    ? 15
                                    : undefined
                              }
                              value={displayValue}
                              onChange={(event) =>
                                handleExtractedFieldChange(
                                  slotKey,
                                  fieldIndex,
                                  event.target.value,
                                )
                              }
                              readOnly={
                                isMapped &&
                                !(
                                  ibanEditableAfterMap &&
                                  isBankStatementIbanLabel(field.label)
                                ) &&
                                !(
                                  employersEditableAfterMap &&
                                  ["employer_name", "other_employers"].includes(
                                    getSalaryCertificateFieldKind(
                                      field.label,
                                    ) ?? "",
                                  )
                                )
                              }
                              className="h-9 rounded-lg border bg-background px-3 text-sm"
                            />
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
                      Gemini did not return any reviewable fields. Do not map
                      this document until extraction is corrected.
                    </p>
                  )}

                  {hasFields && inlineRequiredErrors.length > 0 && (
                    <div
                      role="alert"
                      className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive"
                    >
                      <ul className="list-disc space-y-1 pl-4">
                        {inlineRequiredErrors.map((error) => (
                          <li key={error}>{error}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {isBankStatement && hasFields && !requiredIbanReady && (
                    <p
                      role="alert"
                      className="mt-3 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"
                    >
                      IBAN: {ibanProblem}. Enter the IBAN printed on this bank
                      statement before mapping it.
                    </p>
                  )}

                  {isSalaryCertificate &&
                    hasFields &&
                    !requiredSalaryAmountsReady && (
                      <p
                        role="alert"
                        className="mt-3 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"
                      >
                        Enter a positive annual gross salary and the annual tax
                        deducted amount. Use 0 only after confirming no tax was
                        withheld.
                      </p>
                    )}

                  {isSalaryCertificate &&
                    hasFields &&
                    requiredSalaryAmountsReady &&
                    !requiredSalaryEmployerReady && (
                      <p
                        role="alert"
                        className="mt-3 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"
                      >
                        Enter the employer name exactly as it is registered with
                        FBR. The agent adds it on IRIS by name, and the name
                        must match IRIS&apos;s list. If you had more than one
                        employer this year, add each one under &quot;Other
                        employers&quot; with the Add employer button.
                      </p>
                    )}

                  {isSalaryCertificate &&
                    hasFields &&
                    !isMapped &&
                    requiredSalaryAmountsReady &&
                    requiredSalaryEmployerReady &&
                    !requiredSalaryTaxYearReady && (
                      <p
                        role="alert"
                        className="mt-3 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"
                      >
                        {salaryTaxYearCheck.error}
                      </p>
                    )}

                  {employerEditsUnsaved && (
                    <p
                      role="alert"
                      className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
                    >
                      The employer names were changed but not saved yet. Press
                      Save employer before you continue.
                    </p>
                  )}

                  {extracted.transactions &&
                    extracted.transactions.length > 0 && (
                      <div className="mt-5 space-y-2">
                        <div>
                          <p className="text-sm font-semibold text-foreground">
                            Extracted transactions
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Review transaction rows before mapping them into
                            Bank Intelligence.
                          </p>
                        </div>
                        <div className="overflow-x-auto rounded-lg border">
                          <table className="min-w-[720px] w-full text-left text-xs">
                            <thead className="border-b bg-muted/20 text-muted-foreground">
                              <tr>
                                <th className="px-2 py-2">Date</th>
                                <th className="px-2 py-2">Description</th>
                                <th className="px-2 py-2">Debit</th>
                                <th className="px-2 py-2">Credit</th>
                                <th className="px-2 py-2">Balance</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y">
                              {extracted.transactions.map(
                                (transaction, transactionIndex) => (
                                  <tr
                                    key={`${transaction.description}-${transactionIndex}`}
                                  >
                                    <td className="px-2 py-2">
                                      <input
                                        value={String(transaction.date ?? "")}
                                        onChange={(event) =>
                                          handleExtractedTransactionChange(
                                            slotKey,
                                            transactionIndex,
                                            { date: event.target.value },
                                          )
                                        }
                                        readOnly={isMapped}
                                        className="h-8 w-32 rounded border bg-background px-2"
                                      />
                                    </td>
                                    <td className="px-2 py-2">
                                      <input
                                        value={transaction.description}
                                        onChange={(event) =>
                                          handleExtractedTransactionChange(
                                            slotKey,
                                            transactionIndex,
                                            { description: event.target.value },
                                          )
                                        }
                                        readOnly={isMapped}
                                        className="h-8 w-56 rounded border bg-background px-2"
                                      />
                                    </td>
                                    {(
                                      ["debit", "credit", "balance"] as const
                                    ).map((key) => (
                                      <td key={key} className="px-2 py-2">
                                        <input
                                          value={String(transaction[key] ?? "")}
                                          onChange={(event) =>
                                            handleExtractedTransactionChange(
                                              slot.documentType,
                                              transactionIndex,
                                              { [key]: event.target.value },
                                            )
                                          }
                                          readOnly={isMapped}
                                          className="h-8 w-28 rounded border bg-background px-2"
                                        />
                                      </td>
                                    ))}
                                  </tr>
                                ),
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                  {extracted.transactions &&
                    extracted.transactions.length === 0 &&
                    slot.documentType === "bank_statement" && (
                      <p className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                        No transaction rows were found in this statement. You
                        can add missing rows manually in Bank Intelligence after
                        mapping.
                      </p>
                    )}

                  {extracted.notes && extracted.notes.length > 0 && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {extracted.notes.join(" ")}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
