import { isBusinessPurchaseBasisField } from "@/lib/tax/business-schedule-fields";
import { PENSION_LABELS, pensionFieldKey, type PensionReviewDecisionKey } from "@/lib/tax/pension-statement-fields";
import { useEffect, useMemo, useRef, useState } from "react";
import { withDerivedNilReviewPayload } from "@/lib/tax/review-prefill";
import {
  describeCnicProfilePlan,
  formatCnicInput,
  normalizeIdentityName,
} from "@/lib/tax/cnic-profile";

import { salaryCertificateEmployerSignature } from "@/lib/tax/salary-certificate-fields";
import { removeFilingDocumentAction, uploadFilingDocumentAction } from "@/app/actions/documents";
import {
  approveAndMapExtractedDocumentAction,
  recoverBusinessPurchaseBasisAction,
  extractDocumentWithGeminiAction,
  getDocumentExtractionAction,
  getFilingDocumentsAction,
  saveBankStatementIbanAction,
  saveSalaryCertificateEmployersAction,
  updateDocumentExtractionAction,
} from "@/app/actions/extraction";
import { isDocumentExtractionLeaseStale } from "@/lib/tax/document-extraction-state";
import {
  getFilingSummaryWithDiagnostics,
  recordDocumentLifecycle,
  recordSummaryApplied,
} from "@/lib/tax/withholding-diagnostic-log";
import type { FilingSummary } from "@/components/tax/filing/config/filing-wizard-config";
import type {
  ExtractedPayload,
  ExtractedTransaction,
  FilingDocumentRecord,
} from "@/components/tax/filing/wizard-documents-step";
import type { BusinessListRow } from "@/lib/tax/business-list-fields";

type ResetDownstreamSteps = (
  resetStep: number,
  preserveReconciliation?: boolean,
) => void;

type UseFilingDocumentsInput = {
  draftId: string | null;
  step: number;
  resetDownstreamSteps: ResetDownstreamSteps;
  setFilingSummary: (summary: FilingSummary) => void;
  /** Called when a mapped statement changed a bank account (its IBAN). */
  onBankAccountsChanged?: () => void;
};

export function useFilingDocuments({
  draftId,
  step,
  resetDownstreamSteps,
  setFilingSummary,
  onBankAccountsChanged,
}: UseFilingDocumentsInput) {
  const [uploadedDocuments, setUploadedDocuments] = useState<
    Record<string, string>
  >({});
  const [documentRecords, setDocumentRecords] = useState<
    Record<string, FilingDocumentRecord>
  >({});
  const [extractedByDocumentId, setExtractedByDocumentId] = useState<
    Record<string, ExtractedPayload>
  >({});
  /**
   * What the reviewer sees, and therefore what Save & Approve Map sends: the
   * stored payloads with the figures a document PROVES nil filled in as 0 —
   * a previous return's 7029 (withDerivedPreviousReturnFields), the seven
   * Business Books yearly figures after Sales (withDerivedNilBusinessBooksFigures,
   * business_books only) and a Balance Sheet's blank rows on a side whose
   * printed rows already add up to the printed total
   * (withDerivedNilBalanceSheetRows, business_balance_sheet only). Each is a
   * proposal at confidence 0.9 that stays editable, and none is ever guessed
   * when the document does not prove the zero. Each prefill is scoped to its own
   * document type so one kind of document can never gain a nil figure that would
   * raise a false cross-document conflict (or a false balance-sheet tie-out).
   * Every other document passes through unchanged.
   */
  // The SLOT the reviewer uploaded into is authoritative for which prefill may
  // run. payload.documentType is only what the model said the file was
  // ("profit_and_loss_statement" for a P&L it could not place), so scoping on
  // it pointed at the wrong document type (reported 27 Oct).
  const slotTypeByDocumentId = useMemo(() => {
    const out: Record<string, string | undefined> = {};
    for (const [slotType, record] of Object.entries(documentRecords))
      if (record?.id) out[record.id] = slotType;
    return out;
  }, [documentRecords]);
  /**
   * The payload for one document with the figures it PROVES nil filled in.
   * Used by the screen AND by the two save paths below: the server re-checks
   * what it is given, so a zero the reviewer only sees on screen is not an
   * approval (reported 27 Oct: the red bullets came back on Save & Approve Map).
   * The slot type wins; the payload's own declaration is only a fallback.
   */
  function reviewPayload(documentId: string): ExtractedPayload | undefined {
    const payload = extractedByDocumentId[documentId];
    if (!payload) return payload;
    const documentType = slotTypeByDocumentId[documentId] ?? payload.documentType;
    return withDerivedNilReviewPayload(documentType, payload);
  }
  const reviewExtractedByDocumentId = useMemo(() => {
    const out: Record<string, ExtractedPayload> = {};
    for (const documentId of Object.keys(extractedByDocumentId))
      out[documentId] = reviewPayload(documentId) as ExtractedPayload;
    return out;
    // reviewPayload closes over exactly these two sources.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extractedByDocumentId, slotTypeByDocumentId]);
  // The employer fields as last saved, per document id. Employer names stay
  // editable after mapping; this tells whether the form still differs from
  // what is saved (the Save employer button and the Continue gate use it).
  const [savedEmployerSignatures, setSavedEmployerSignatures] = useState<
    Record<string, string>
  >({});
  const [extractingDocumentId, setExtractingDocumentId] = useState<
    string | null
  >(null);
  const [reviewingDocumentId, setReviewingDocumentId] = useState<string | null>(
    null,
  );
  const [savingDocumentReviewId, setSavingDocumentReviewId] = useState<
    string | null
  >(null);
  const [mappingDocumentId, setMappingDocumentId] = useState<string | null>(
    null,
  );
  const [selectedDocumentFiles, setSelectedDocumentFiles] = useState<
    Record<string, File>
  >({});
  const [uploadingDocumentType, setUploadingDocumentType] = useState<
    string | null
  >(null);
  const [documentUploadError, setDocumentUploadError] = useState<string | null>(
    null,
  );
  // What an approved CNIC actually changed on the profile. Not an error: when a
  // field is deliberately left alone (a name the human already typed) the operator
  // needs to know that, or the upload looks like it did nothing.
  const [profileSyncNote, setProfileSyncNote] = useState<string | null>(null);
  const uploadFileInputsRef = useRef<Record<string, HTMLInputElement | null>>(
    {},
  );
  const recoveringDocumentIds = useRef(new Set<string>());
  const latestActions = useRef({
    resetDownstreamSteps,
    setFilingSummary,
    step,
  });
  latestActions.current = { resetDownstreamSteps, setFilingSummary, step };
  const latestDraftIdRef = useRef(draftId);
  latestDraftIdRef.current = draftId;

  // Restore saved review/mapping payloads on refresh, not just the status badge.
  // The extractedData remains on the owned Document row; this only hydrates the
  // client review panel and never starts another extraction request.
  // The first time a mapped salary certificate's fields are available they ARE
  // the saved values, so that is the baseline later edits are compared with.
  useEffect(() => {
    const salary = documentRecords.salary_certificate;
    if (!salary || salary.extractionStatus !== "MAPPED") return;
    const payload = extractedByDocumentId[salary.id];
    if (!payload?.fields || salary.id in savedEmployerSignatures) return;
    setSavedEmployerSignatures((previous) => ({
      ...previous,
      [salary.id]: salaryCertificateEmployerSignature(payload.fields),
    }));
  }, [documentRecords, extractedByDocumentId, savedEmployerSignatures]);

  useEffect(() => {
    for (const record of Object.values(documentRecords)) {
      if (
        !["COMPLETED", "MAPPED", "FAILED"].includes(record.extractionStatus) ||
        extractedByDocumentId[record.id] ||
        recoveringDocumentIds.current.has(record.id)
      ) {
        continue;
      }

      recoveringDocumentIds.current.add(record.id);
      void getDocumentExtractionAction(record.id)
        .then((result) => {
          if (!result.success || !result.extraction) return;
          setExtractedByDocumentId((previous) => ({
            ...previous,
            [record.id]: (result.extraction ?? {
              fields: [],
              notes: [],
            }) as ExtractedPayload,
          }));
        })
        .catch(() => {
          // The status remains available; the existing Review button can retry.
        })
        .finally(() => recoveringDocumentIds.current.delete(record.id));
    }
  }, [documentRecords, extractedByDocumentId]);

  useEffect(() => {
    if (!draftId) return;
    const processingDocuments = Object.entries(documentRecords).filter(
      ([, document]) =>
        document.extractionStatus === "PROCESSING" &&
        !isDocumentExtractionLeaseStale(
          document.extractionStatus,
          document.extractionStartedAt,
        ),
    );
    if (processingDocuments.length === 0) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      await Promise.all(
        processingDocuments.map(async ([documentType, record]) => {
          let result: Awaited<ReturnType<typeof getDocumentExtractionAction>>;
          try {
            result = await getDocumentExtractionAction(record.id);
          } catch {
            void recordDocumentLifecycle({
              action: "extraction.poll.exception",
              draftId,
              documentType,
              documentId: record.id,
              fileName: record.fileName,
              status: "EXCEPTION",
            });
            return;
          }
          void recordDocumentLifecycle({
            action: "extraction.poll.response",
            draftId,
            documentType,
            documentId: record.id,
            fileName: record.fileName,
            status: result.success ? result.status ?? "UNKNOWN" : "FAILED",
            extractionPayload: result.success ? result.extraction : undefined,
          });
          if (cancelled || !result.success || result.status === "PROCESSING") {
            return;
          }

          const status = result.status ?? "FAILED";
          setDocumentRecords((previous) => {
            if (previous[documentType]?.id !== record.id) return previous;
            return {
              ...previous,
              [documentType]: {
                ...previous[documentType],
                extractionStatus: status,
                extractionStartedAt: result.extractionStartedAt ?? null,
                extractionError: result.extractionError ?? null,
                extractedAt:
                  status === "COMPLETED" || status === "MAPPED"
                    ? new Date().toISOString()
                    : previous[documentType].extractedAt,
              },
            };
          });

          if (
            (status === "COMPLETED" || status === "MAPPED") &&
            result.extraction
          ) {
            if (status === "COMPLETED") {
              latestActions.current.resetDownstreamSteps(
                latestActions.current.step,
              );
            }
            setExtractedByDocumentId((previous) => ({
              ...previous,
              [record.id]: result.extraction as ExtractedPayload,
            }));
            if (draftId) {
              const { result: refreshedSummary, requestId } =
                await getFilingSummaryWithDiagnostics(draftId, "documents.extraction_poll");
              const activeDraftId = latestDraftIdRef.current;
              recordSummaryApplied({
                requestId,
                source: "documents.extraction_poll",
                requestedDraftId: draftId,
                activeDraftId,
                applied: refreshedSummary.success,
                reason: refreshedSummary.success
                  ? activeDraftId === draftId ? undefined : "active_draft_changed_but_applied"
                  : "action_failure",
              });
              if (refreshedSummary.success) {
                latestActions.current.setFilingSummary(
                  refreshedSummary.summary as FilingSummary,
                );
              }
            }
          } else if (status === "FAILED") {
            if (result.extraction) {
              setExtractedByDocumentId((previous) => ({
                ...previous,
                [record.id]: result.extraction as ExtractedPayload,
              }));
            }
            setDocumentUploadError(
              result.extractionError ??
                "Document extraction failed. You can retry it.",
            );
          }
        }),
      );

      if (!cancelled) timer = setTimeout(poll, 2500);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [draftId, documentRecords]);

  function triggerDocumentUpload(documentType: string) {
    uploadFileInputsRef.current[documentType]?.click();
  }

  async function handleDocumentFileSelected(
    documentType: string,
    fileList: FileList | null,
  ) {
    const file = fileList?.[0];
    if (!file) return;

    setDocumentUploadError(null);
    setProfileSyncNote(null);
    setUploadedDocuments((prev) => ({ ...prev, [documentType]: file.name }));
    setSelectedDocumentFiles((prev) => ({ ...prev, [documentType]: file }));

    if (!draftId) return;

    setUploadingDocumentType(documentType);
    const uploadData = new FormData();
    uploadData.set("draftId", draftId);
    uploadData.set("documentType", documentType);
    uploadData.set("file", file);
    void recordDocumentLifecycle({
      action: "upload.requested",
      draftId,
      documentType,
      fileName: file.name,
    });

    const result = await uploadFilingDocumentAction(uploadData);
    void recordDocumentLifecycle({
      action: result.success ? "upload.completed" : "upload.failed",
      draftId,
      documentType,
      documentId: result.success ? result.document.id : null,
      fileName: file.name,
      status: result.success ? result.document.extractionStatus : "FAILED",
    });
    setUploadingDocumentType(null);
    setSelectedDocumentFiles((previous) => {
      const next = { ...previous };
      delete next[documentType];
      return next;
    });

    if (result.success) {
      setDocumentRecords((previous) => ({
        ...previous,
        [documentType]: {
          id: result.document.id,
          fileName: result.document.fileName,
          extractionStatus: result.document.extractionStatus,
          extractionProvider: null,
          extractionStartedAt: null,
          extractionError: null,
          extractedAt: null,
        },
      }));
      resetDownstreamSteps(step);
      return;
    }

    setDocumentUploadError(result.error ?? "Failed to upload document");
    setUploadedDocuments((prev) => {
      const next = { ...prev };
      delete next[documentType];
      return next;
    });
  }

  async function handleExtractDocument(documentType: string) {
    const record = documentRecords[documentType];
    if (!record) return;

    setExtractingDocumentId(record.id);
    setDocumentUploadError(null);
    setProfileSyncNote(null);
    void recordDocumentLifecycle({
      action: "extract.requested",
      draftId,
      documentType,
      documentId: record.id,
      fileName: record.fileName,
      status: record.extractionStatus,
    });
    const result = await extractDocumentWithGeminiAction(record.id);
    const resultStatus = result.success
      ? ("status" in result ? result.status ?? "COMPLETED" : "COMPLETED")
      : ("code" in result ? result.code : "FAILED");
    void recordDocumentLifecycle({
      action: "extract.response",
      draftId,
      documentType,
      documentId: record.id,
      fileName: record.fileName,
      status: resultStatus,
      extractionPayload:
        result.success && "extracted" in result ? result.extracted : undefined,
    });
    setExtractingDocumentId(null);

    if (!result.success) {
      const code = "code" in result ? result.code : undefined;
      if (code === "ALREADY_PROCESSING") {
        setDocumentRecords((previous) => ({
          ...previous,
          [documentType]: {
            ...record,
            extractionStatus: "PROCESSING",
            extractionStartedAt:
              "extractionStartedAt" in result
                ? (result.extractionStartedAt ??
                  record.extractionStartedAt ??
                  null)
                : (record.extractionStartedAt ?? null),
            extractionError: null,
          },
        }));
        // The status poll below will bring the saved extraction into the form.
        return;
      }

      if (code === "ALREADY_MAPPED" || code === "ALREADY_EXTRACTED") {
        const refreshed = await getDocumentExtractionAction(record.id);
        if (refreshed.success) {
          const status =
            refreshed.status ??
            (code === "ALREADY_MAPPED" ? "MAPPED" : "COMPLETED");
          setDocumentRecords((previous) => ({
            ...previous,
            [documentType]: {
              ...record,
              extractionStatus: status,
              extractionStartedAt: refreshed.extractionStartedAt ?? null,
              extractionError: refreshed.extractionError ?? null,
            },
          }));
          if (refreshed.extraction) {
            setExtractedByDocumentId((previous) => ({
              ...previous,
              [record.id]: refreshed.extraction as ExtractedPayload,
            }));
          }
          return;
        }
      }

      setDocumentUploadError(
        "error" in result ? result.error : "Document extraction failed",
      );
      // Do not guess the database state from a network/rate-limit error.
      const refreshed = await getDocumentExtractionAction(record.id);
      if (refreshed.success) {
        setDocumentRecords((previous) => ({
          ...previous,
          [documentType]: {
            ...record,
            extractionStatus: refreshed.status ?? record.extractionStatus,
            extractionStartedAt: refreshed.extractionStartedAt ?? null,
            extractionError: refreshed.extractionError ?? null,
          },
        }));
        if (refreshed.extraction) {
          setExtractedByDocumentId((previous) => ({
            ...previous,
            [record.id]: refreshed.extraction as ExtractedPayload,
          }));
        }
      }
      return;
    }

    setDocumentRecords((previous) => ({
      ...previous,
      [documentType]: {
        ...record,
        extractionStatus:
          "status" in result && result.status ? result.status : "COMPLETED",
        extractionStartedAt: null,
        extractionError: null,
        extractionProvider: result.provider ?? "gemini",
        extractedAt: new Date().toISOString(),
      },
    }));
    setExtractedByDocumentId((previous) => ({
      ...previous,
      [record.id]: (result.extracted ?? {
        fields: [],
        notes: [],
      }) as ExtractedPayload,
    }));
    resetDownstreamSteps(step);

    if (draftId) {
      const { result: refreshedSummary, requestId } =
        await getFilingSummaryWithDiagnostics(draftId, "documents.extract");
      const activeDraftId = latestDraftIdRef.current;
      recordSummaryApplied({
        requestId,
        source: "documents.extract",
        requestedDraftId: draftId,
        activeDraftId,
        applied: refreshedSummary.success,
        reason: refreshedSummary.success
          ? activeDraftId === draftId ? undefined : "active_draft_changed_but_applied"
          : "action_failure",
      });
      if (refreshedSummary.success) {
        setFilingSummary(refreshedSummary.summary as FilingSummary);
      }
    }
  }

  async function handleReviewDocument(documentType: string) {
    const record = documentRecords[documentType];
    if (!record || extractedByDocumentId[record.id]) return;

    setReviewingDocumentId(record.id);
    setDocumentUploadError(null);
    setProfileSyncNote(null);
    const result = await getDocumentExtractionAction(record.id);
    setReviewingDocumentId(null);

    if (!result.success) {
      setDocumentUploadError(result.error ?? "Failed to load extracted data");
      return;
    }

    setExtractedByDocumentId((previous) => ({
      ...previous,
      [record.id]: (result.extraction ?? {
        fields: [],
        notes: [],
      }) as ExtractedPayload,
    }));
  }

  function handleExtractedFieldChange(
    documentType: string,
    fieldIndex: number,
    value: string,
  ) {
    const record = documentRecords[documentType];
    if (!record) return;
    if (
      documentType === "pension_statement" &&
      record.extractionStatus === "MAPPED"
    ) {
      setDocumentRecords((previous) => ({
        ...previous,
        [documentType]: { ...record, extractionStatus: "COMPLETED" },
      }));
      setProfileSyncNote(
        "Unsaved pension changes: Save & Approve Map again before continuing. The previously approved source is not silently overwritten.",
      );
      resetDownstreamSteps(step, true);
    }
    if (
      documentType === "business_books" &&
      record.extractionStatus === "MAPPED" &&
      isBusinessPurchaseBasisField(
        extractedByDocumentId[record.id]?.fields?.[fieldIndex]?.label,
      )
    ) {
      // Unsaved basis changes must not look like approved mapped facts locally.
      setDocumentRecords((previous) => ({
        ...previous,
        [documentType]: { ...record, extractionStatus: "COMPLETED" },
      }));
      resetDownstreamSteps(step);
    }

    setExtractedByDocumentId((previous) => {
      const payload = previous[record.id];
      if (!payload?.fields) return previous;
      const field = payload.fields[fieldIndex];
      if (!field) return previous;

      const label = field.label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const nextValue = ["cnic_number", "cnic", "identity_number"].includes(
        label,
      )
        ? formatCnicInput(value)
        : ["name", "full_name", "taxpayer_name"].includes(label)
          ? normalizeIdentityName(value)
          : /(^|_)iban(_|$)/.test(label)
            ? value
                .toUpperCase()
                .replace(/[\s-]+/g, "")
                .slice(0, 24)
            : value;
      const fields = payload.fields.map((current, index) =>
        index === fieldIndex
          ? {
              ...current,
              value: nextValue,
              ...(documentType === "pension_statement"
                ? {
                    reviewSuggestion: false,
                    sourceEvidence: undefined,
                    confidence: 0,
                  }
                : {}),
            }
          : current,
      );
      return { ...previous, [record.id]: { ...payload, fields } };
    });
  }

  /**
   * Business detail rows are kept as structured arrays in browser state.
   * The server canonicalizes them to its stored JSON form on save; the user
   * never sees or types that JSON.
   */
  function handleExtractedListFieldChange(
    documentType: string,
    fieldIndex: number,
    value: BusinessListRow[] | null,
  ) {
    const record = documentRecords[documentType];
    if (!record || record.extractionStatus === "MAPPED") return;
    setExtractedByDocumentId((previous) => {
      const payload = previous[record.id];
      if (!payload?.fields?.[fieldIndex]) return previous;
      const fields = payload.fields.map((field, index) =>
        index === fieldIndex ? { ...field, value } : field,
      );
      return { ...previous, [record.id]: { ...payload, fields } };
    });
  }

  function handlePensionReviewFieldChange(
    documentType: string,
    key: PensionReviewDecisionKey,
    value: string,
  ) {
    if (documentType !== "pension_statement") return;
    const record = documentRecords[documentType];
    if (!record) return;
    const fields = extractedByDocumentId[record.id]?.fields ?? [];
    const index = fields.findIndex((field) => pensionFieldKey(field.label) === key);
    if (index >= 0) {
      handleExtractedFieldChange(documentType, index, value);
      return;
    }
    if (record.extractionStatus === "MAPPED") {
      setDocumentRecords(previous => ({ ...previous, [documentType]: { ...record, extractionStatus: "COMPLETED" } }));
      setProfileSyncNote("Unsaved pension changes: Save & Approve Map again before continuing.");
      resetDownstreamSteps(step, true);
    }
    setExtractedByDocumentId(previous => {
      const payload = previous[record.id];
      if (!payload) return previous;
      // Functional updates avoid losing a field when two optional edits arrive together.
      const current = payload.fields ?? [];
      const exists = current.some(field => pensionFieldKey(field.label) === key);
      const next = { label: PENSION_LABELS[key], value, confidence: 0, reviewSuggestion: false };
      return { ...previous, [record.id]: { ...payload, fields: exists
        ? current.map(field => pensionFieldKey(field.label) === key ? next : field)
        : [...current, next] } };
    });
  }

  function handleExtractedTransactionChange(
    documentType: string,
    transactionIndex: number,
    patch: Partial<ExtractedTransaction>,
  ) {
    const record = documentRecords[documentType];
    if (!record) return;

    setExtractedByDocumentId((previous) => {
      const payload = previous[record.id];
      if (!payload?.transactions) return previous;
      const transactions = payload.transactions.map((transaction, index) =>
        index === transactionIndex ? { ...transaction, ...patch } : transaction,
      );
      return { ...previous, [record.id]: { ...payload, transactions } };
    });
  }

  async function handleSaveDocumentReview(documentType: string) {
    const record = documentRecords[documentType];
    if (!record) return;
    // Send what the reviewer sees, zeros included (see reviewPayload).
    const payload = reviewPayload(record.id);
    if (!payload) return;

    setSavingDocumentReviewId(record.id);
    setDocumentUploadError(null);
    setProfileSyncNote(null);
    const result = await updateDocumentExtractionAction(record.id, payload);
    setSavingDocumentReviewId(null);

    if (!result.success) {
      setDocumentUploadError(result.error ?? "Failed to save extracted data");
      return;
    }

    setDocumentRecords((previous) => ({
      ...previous,
      [documentType]: { ...record, extractionStatus: "COMPLETED" },
    }));
  }

  async function handleRecoverBusinessPurchaseBasis(documentType: string) {
    const record = documentRecords[documentType];
    if (!record || documentType !== "business_books") return;
    setSavingDocumentReviewId(record.id);
    setDocumentUploadError(null);
    try {
      const result = await recoverBusinessPurchaseBasisAction(record.id);
      if (!result.success || !result.extraction) {
        setDocumentUploadError(
          result.error || "Purchase basis could not be recovered.",
        );
        return;
      }
      setExtractedByDocumentId((previous) => ({
        ...previous,
        [record.id]: result.extraction as ExtractedPayload,
      }));
      setDocumentRecords((previous) => ({
        ...previous,
        [documentType]: { ...record, extractionStatus: "COMPLETED" },
      }));
      resetDownstreamSteps(step);
      setProfileSyncNote(
        "Purchase basis re-read from your original Books. Review it, then Save & Approve Map; earlier amounts were preserved.",
      );
    } catch {
      setDocumentUploadError(
        "Could not contact document recovery. Refresh and check its saved status before retrying.",
      );
    } finally {
      setSavingDocumentReviewId(null);
    }
  }

  async function handleMapDocument(documentType: string) {
    const record = documentRecords[documentType];
    if (!record) return;

    setMappingDocumentId(record.id);
    setDocumentUploadError(null);
    setProfileSyncNote(null);
    // Send what the reviewer sees, zeros included (see reviewPayload).
    const extracted = reviewPayload(record.id);
    if (!extracted) {
      setMappingDocumentId(null);
      setDocumentUploadError("Review the extracted data before mapping");
      return;
    }

    void recordDocumentLifecycle({
      action: "map.started",
      draftId,
      documentType,
      documentId: record.id,
      fileName: record.fileName,
      status: record.extractionStatus,
      extractionPayload: extracted,
    });
    const saveResult = await updateDocumentExtractionAction(
      record.id,
      extracted,
    );
    void recordDocumentLifecycle({
      action: saveResult.success ? "map.review_saved" : "map.review_save_failed",
      draftId,
      documentType,
      documentId: record.id,
      fileName: record.fileName,
      status: saveResult.success ? "COMPLETED" : "FAILED",
      extractionPayload: extracted,
    });
    if (!saveResult.success) {
      setMappingDocumentId(null);
      setDocumentUploadError(saveResult.error ?? "Failed to save corrections");
      return;
    }

    const result = await approveAndMapExtractedDocumentAction(record.id);
    setMappingDocumentId(null);
    void recordDocumentLifecycle({
      action: result.success ? "map.completed" : "map.failed",
      draftId,
      documentType,
      documentId: record.id,
      fileName: record.fileName,
      status: result.success ? "MAPPED" : "FAILED",
      extractionPayload: extracted,
    });
    if (!result.success) {
      setDocumentUploadError(
        result.error ?? "Failed to map extracted document",
      );
      return;
    }

    setProfileSyncNote(
      describeCnicProfilePlan(
        (
          result as {
            profilePlan?: { filled?: string[]; skipped?: { field: string }[] };
          }
        ).profilePlan,
      ),
    );
    if (result.mapping === "CNIC" && typeof window !== "undefined") {
      window.dispatchEvent(new Event("taxrocket-profile-updated"));
    }

    setDocumentRecords((previous) => ({
      ...previous,
      [documentType]: { ...record, extractionStatus: "MAPPED" },
    }));
    // Mapping a bank statement stores its IBAN on the account.
    if (documentType.startsWith("bank_statement")) onBankAccountsChanged?.();

    if (draftId) {
      const { result: refreshedSummary, requestId } =
        await getFilingSummaryWithDiagnostics(draftId, "documents.map");
      const activeDraftId = latestDraftIdRef.current;
      recordSummaryApplied({
        requestId,
        source: "documents.map",
        requestedDraftId: draftId,
        activeDraftId,
        applied: refreshedSummary.success,
        reason: refreshedSummary.success
          ? activeDraftId === draftId ? undefined : "active_draft_changed_but_applied"
          : "action_failure",
      });
      if (refreshedSummary.success) {
        setFilingSummary(refreshedSummary.summary as FilingSummary);
      }
    }
  }

  /**
   * Enter the IBAN on a statement that is already mapped (it was mapped before
   * the IBAN was required). Does not re-map or touch transactions.
   */
  async function handleSaveStatementIban(documentType: string) {
    const record = documentRecords[documentType];
    if (!record) return;
    const payload = extractedByDocumentId[record.id];
    const ibanField = payload?.fields?.find((field) =>
      /(^|_)iban(_|$)/.test(
        field.label.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      ),
    );

    setSavingDocumentReviewId(record.id);
    setDocumentUploadError(null);
    const result = await saveBankStatementIbanAction(
      record.id,
      String(ibanField?.value ?? ""),
    );
    setSavingDocumentReviewId(null);
    if (!result.success) {
      setDocumentUploadError(result.error ?? "Failed to save the IBAN");
      return;
    }
    onBankAccountsChanged?.();
  }

  /**
   * Change the employer name(s) on a salary certificate that is already
   * mapped. No re-upload or re-extraction; the latest packet is superseded
   * on the server, so the summary is refreshed afterwards.
   */
  async function handleSaveSalaryEmployers(documentType: string) {
    const record = documentRecords[documentType];
    if (!record) return;
    const payload = extractedByDocumentId[record.id];
    const kindOf = (label: string) => {
      const normalized = label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (!/(^|_)employers?(_|$)/.test(normalized)) return null;
      if (
        /(^|_)(ntn|ftn|cnic|nic|id|no|number|address|reg|registration|phone|email)(_|$)/.test(
          normalized,
        )
      )
        return null;
      return /(^|_)(other|additional|more)(_|$)/.test(normalized)
        ? "other"
        : "main";
    };
    const valueOf = (kind: "main" | "other") =>
      String(
        payload?.fields?.find((field) => kindOf(field.label) === kind)?.value ??
          "",
      );

    setSavingDocumentReviewId(record.id);
    setDocumentUploadError(null);
    const result = await saveSalaryCertificateEmployersAction(record.id, {
      employerName: valueOf("main"),
      otherEmployerNames: valueOf("other"),
    });
    setSavingDocumentReviewId(null);
    if (!result.success) {
      setDocumentUploadError(
        result.error ?? "Failed to save the employer names",
      );
      return;
    }
    setSavedEmployerSignatures((previous) => ({
      ...previous,
      [record.id]: salaryCertificateEmployerSignature(payload?.fields),
    }));
    setProfileSyncNote(
      "Employer saved. Generate and approve the filing packet again so the new name reaches FBR.",
    );
    if (draftId) {
      const { result: refreshedSummary, requestId } =
        await getFilingSummaryWithDiagnostics(draftId, "documents.salary_employer_save");
      const activeDraftId = latestDraftIdRef.current;
      recordSummaryApplied({
        requestId,
        source: "documents.salary_employer_save",
        requestedDraftId: draftId,
        activeDraftId,
        applied: refreshedSummary.success,
        reason: refreshedSummary.success
          ? activeDraftId === draftId ? undefined : "active_draft_changed_but_applied"
          : "action_failure",
      });
      if (refreshedSummary.success) {
        setFilingSummary(refreshedSummary.summary as FilingSummary);
      }
    }
  }

  /** True when the employer fields differ from what was last saved. */
  function isSalaryEmployerDirty(documentType: string) {
    const record = documentRecords[documentType];
    if (!record || record.extractionStatus !== "MAPPED") return false;
    const baseline = savedEmployerSignatures[record.id];
    const payload = extractedByDocumentId[record.id];
    if (baseline === undefined || !payload?.fields) return false;
    return salaryCertificateEmployerSignature(payload.fields) !== baseline;
  }
  const hasUnsavedSalaryEmployers = isSalaryEmployerDirty("salary_certificate");

  async function handleRemoveDocument(documentType: string) {
    const record = documentRecords[documentType];
    if (!record) return;
    setDocumentUploadError(null);
    setProfileSyncNote(null);
    try {
      const result = await removeFilingDocumentAction(record.id);
      if (!result.success) {
        setDocumentUploadError(result.error ?? "Failed to remove the document");
        return;
      }
      setDocumentRecords((previous) => {
        const next = { ...previous };
        delete next[documentType];
        return next;
      });
      setUploadedDocuments((previous) => {
        const next = { ...previous };
        delete next[documentType];
        return next;
      });
      setProfileSyncNote(
        "Previous Year Tax Return removed. Filing can continue without it.",
      );
    } catch {
      setDocumentUploadError(
        "Could not remove the document. Refresh and try again.",
      );
    }
  }

  return {
    isSalaryEmployerDirty,
    hasUnsavedSalaryEmployers,
    uploadedDocuments,
    documentRecords,
    extractedByDocumentId: reviewExtractedByDocumentId,
    extractingDocumentId,
    reviewingDocumentId,
    savingDocumentReviewId,
    mappingDocumentId,
    selectedDocumentFiles,
    uploadingDocumentType,
    documentUploadError,
    profileSyncNote,
    setProfileSyncNote,
    uploadFileInputsRef,
    setUploadedDocuments,
    setDocumentRecords,
    setSelectedDocumentFiles,
    setUploadingDocumentType,
    setDocumentUploadError,
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
  };
}
