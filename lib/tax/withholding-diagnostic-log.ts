"use client";

import { getFilingSummaryAction } from "@/app/actions/filing-summary";
import type {
  FilingSummary,
  ServicesEvidenceDocumentSummary,
  ServicesInvoiceEvidenceSummary,
} from "@/components/tax/filing/config/filing-wizard-config";
import {
  SERVICES_WITHHOLDING_DOCUMENT_TYPES,
  resolveServicesWithholdingPrefill,
  type ServicesWithholdingSourceDocument,
} from "@/lib/tax/services-withholding-evidence";

const STORE_KEY = "taxrocket.withholding-diagnostic.v1";
const SALT_KEY = "taxrocket.withholding-diagnostic.salt.v1";
const UPDATE_EVENT = "taxrocket-withholding-diagnostic-update";
const IS_DEVELOPMENT_BUILD = process.env.NODE_ENV === "development";
const MAX_EVENTS = 300;
const MAX_STORE_CHARS = 1_500_000;

type DiagnosticEvent = {
  seq: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
};

type DiagnosticStore = {
  version: 1;
  sessionId: string;
  startedAt: string;
  stoppedAt: string | null;
  active: boolean;
  truncated: boolean;
  events: DiagnosticEvent[];
};

export type WithholdingDiagnosticStatus = {
  active: boolean;
  eventCount: number;
  startedAt: string | null;
  truncated: boolean;
};

const hasWindow = () => typeof window !== "undefined";

function randomId() {
  if (hasWindow() && typeof window.crypto?.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `diag-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readStore(): DiagnosticStore | null {
  if (!hasWindow()) return null;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DiagnosticStore;
    if (
      parsed?.version !== 1 ||
      typeof parsed.sessionId !== "string" ||
      !Array.isArray(parsed.events)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function notifyControls() {
  if (!hasWindow()) return;
  window.dispatchEvent(new Event(UPDATE_EVENT));
}

function saveStore(store: DiagnosticStore) {
  if (!hasWindow()) return;
  try {
    while (store.events.length > MAX_EVENTS) {
      store.events.shift();
      store.truncated = true;
    }
    let serialized = JSON.stringify(store);
    while (serialized.length > MAX_STORE_CHARS && store.events.length > 10) {
      store.events.shift();
      store.truncated = true;
      serialized = JSON.stringify(store);
    }
    window.localStorage.setItem(STORE_KEY, serialized);
    notifyControls();
  } catch {
    // Diagnostics must never interfere with filing work if browser storage is full.
  }
}

function appendEvent(
  type: string,
  data: Record<string, unknown>,
  at = new Date().toISOString(),
  allowStopped = false,
) {
  const store = readStore();
  if (!store || (!store.active && !allowStopped)) return;
  store.events.push({
    seq: (store.events[store.events.length - 1]?.seq ?? 0) + 1,
    at,
    type,
    data,
  });
  saveStore(store);
}

function getOrCreateSalt() {
  if (!hasWindow()) return "server-only";
  try {
    const existing = window.localStorage.getItem(SALT_KEY);
    if (existing) return existing;
    const bytes = new Uint8Array(24);
    window.crypto.getRandomValues(bytes);
    const salt = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    window.localStorage.setItem(SALT_KEY, salt);
    return salt;
  } catch {
    return randomId();
  }
}

function fallbackDigest(value: string) {
  // Fallback for browsers without SubtleCrypto. The per-browser salt is not
  // exported with the diagnostic JSON, and the original value is never stored.
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function privateTag(scope: string, value: unknown): Promise<string | null> {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const normalized = String(value).normalize("NFKC").trim().toUpperCase();
  const input = `${getOrCreateSalt()}|${scope}|${normalized}`;
  try {
    if (hasWindow() && window.crypto?.subtle) {
      const digest = await window.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(input),
      );
      const hex = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      return `${scope}_${hex.slice(0, 12)}`;
    }
  } catch {
    // Use a salted non-cryptographic fallback below; no raw source is exported.
  }
  return `${scope}_${fallbackDigest(input)}`;
}

let recordingQueue: Promise<void> = Promise.resolve();
const loggedSummaryRequests = new Map<string, string>();

function recordAsync(work: () => Promise<void>, expectedSessionId?: string) {
  const scheduledSessionId = expectedSessionId ?? readStore()?.sessionId;
  if (!scheduledSessionId) return;
  // Preserve observation order in the exported event sequence without awaiting
  // diagnostic work in filing handlers. A cleared/restarted log cannot inherit
  // work that was queued by the previous session.
  recordingQueue = recordingQueue
    .then(async () => {
      if (readStore()?.sessionId !== scheduledSessionId) return;
      await work();
    })
    .catch(() => undefined);
}

export function getWithholdingDiagnosticStatus(): WithholdingDiagnosticStatus {
  const store = IS_DEVELOPMENT_BUILD ? readStore() : null;
  return {
    active: Boolean(store?.active),
    eventCount: store?.events.length ?? 0,
    startedAt: store?.startedAt ?? null,
    truncated: Boolean(store?.truncated),
  };
}

export function startWithholdingDiagnostics() {
  if (!hasWindow() || !IS_DEVELOPMENT_BUILD) return;
  const existing = readStore();
  const now = new Date().toISOString();
  const store: DiagnosticStore = existing
    ? { ...existing, active: true, stoppedAt: null }
    : {
        version: 1,
        sessionId: randomId(),
        startedAt: now,
        stoppedAt: null,
        active: true,
        truncated: false,
        events: [],
      };
  saveStore(store);
  recordAsync(async () => {
    appendEvent(
      existing ? "logging.resumed" : "logging.started",
      { mode: "development" },
      now,
      true,
    );
  });
}

export function stopWithholdingDiagnostics() {
  if (!hasWindow()) return;
  const store = readStore();
  if (!store) return;
  const now = new Date().toISOString();
  store.active = false;
  store.stoppedAt = now;
  saveStore(store);
  recordAsync(async () => {
    appendEvent("logging.stopped", {}, now, true);
  });
}

export function clearWithholdingDiagnostics() {
  if (!hasWindow()) return;
  loggedSummaryRequests.clear();
  try {
    window.localStorage.removeItem(STORE_KEY);
    window.localStorage.removeItem(SALT_KEY);
  } catch {
    // Nothing to do if storage is unavailable.
  }
  notifyControls();
}

export async function downloadWithholdingDiagnostics() {
  if (!hasWindow() || !IS_DEVELOPMENT_BUILD) return;
  await recordingQueue;
  const store = readStore();
  if (!store) return;
  const payload = {
    ...store,
    privacy: {
      rawDocumentContentsIncluded: false,
      rawFileNamesIncluded: false,
      rawInvoiceNumbersIncluded: false,
      rawPayoutReferencesIncluded: false,
      taxpayerOrBankIdentifiersIncluded: false,
      note: "Amounts, document types, withholding section/code, row numbers, statuses, and salted reference tags are included for diagnosis. The per-browser salt is not included.",
    },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `withholding-diagnostic-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function getFilingSummaryWithDiagnostics(
  draftId: string,
  source: string,
) {
  const requestId = randomId();
  const shouldLog = getWithholdingDiagnosticStatus().active;
  const requestSessionId = shouldLog ? readStore()?.sessionId ?? null : null;
  const requestedAt = new Date().toISOString();
  if (shouldLog && requestSessionId) {
    loggedSummaryRequests.set(requestId, requestSessionId);
    recordAsync(async () => {
      appendEvent(
        "summary.request",
        {
          requestId,
          source,
          draftTag: await privateTag("draft", draftId),
        },
        requestedAt,
        true,
      );
    }, requestSessionId);
  }

  try {
    const result = await getFilingSummaryAction(draftId);
    const receivedAt = new Date().toISOString();
    if (shouldLog && requestSessionId) {
      recordAsync(async () => {
        const safeSummary = result.success
          ? await safeSummarySnapshot(result.summary as FilingSummary)
          : null;
        appendEvent(
          "summary.response",
          {
            requestId,
            source,
            draftTag: await privateTag("draft", draftId),
            success: result.success,
            durationMs: Math.max(0, Date.parse(receivedAt) - Date.parse(requestedAt)),
            summary: safeSummary,
            errorReturned: !result.success,
          },
          receivedAt,
          true,
        );
      }, requestSessionId);
    }
    return { result, requestId };
  } catch (error) {
    loggedSummaryRequests.delete(requestId);
    const receivedAt = new Date().toISOString();
    if (shouldLog && requestSessionId) {
      recordAsync(async () => {
        appendEvent(
          "summary.exception",
          {
            requestId,
            source,
            draftTag: await privateTag("draft", draftId),
            errorName: error instanceof Error ? error.name : "unknown",
          },
          receivedAt,
          true,
        );
      }, requestSessionId);
    }
    throw error;
  }
}

export function recordSummaryApplied(input: {
  requestId: string;
  source: string;
  requestedDraftId: string;
  activeDraftId: string | null;
  applied: boolean;
  reason?: string;
}) {
  const requestSessionId = loggedSummaryRequests.get(input.requestId);
  const currentSessionId = readStore()?.sessionId;
  const sessionId = requestSessionId ?? (
    getWithholdingDiagnosticStatus().active ? currentSessionId : undefined
  );
  if (!sessionId) return;
  loggedSummaryRequests.delete(input.requestId);
  const at = new Date().toISOString();
  recordAsync(async () => {
    appendEvent(
      "summary.apply",
      {
        requestId: input.requestId,
        source: input.source,
        requestedDraftTag: await privateTag("draft", input.requestedDraftId),
        activeDraftTag: await privateTag("draft", input.activeDraftId),
        applied: input.applied,
        reason: input.reason ?? null,
      },
      at,
      true,
    );
  }, sessionId);
}

export function recordDraftLifecycle(input: {
  action: string;
  draftId: string;
  taxYear?: number;
  filerType?: string | null;
  incomeSources?: readonly string[];
  result?: "success" | "failure";
}) {
  if (!getWithholdingDiagnosticStatus().active) return;
  const at = new Date().toISOString();
  recordAsync(async () => {
    appendEvent(
      "draft.lifecycle",
      {
        action: input.action,
        draftTag: await privateTag("draft", input.draftId),
        taxYear: input.taxYear ?? null,
        filerType: input.filerType ?? null,
        incomeSources: input.incomeSources
          ? [...input.incomeSources].map((source) => String(source))
          : null,
        result: input.result ?? null,
      },
      at,
      true,
    );
  });
}

function extractionShape(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const data = payload as { fields?: unknown; transactions?: unknown; notes?: unknown };
  return {
    fieldCount: Array.isArray(data.fields) ? data.fields.length : null,
    transactionCount: Array.isArray(data.transactions) ? data.transactions.length : null,
    noteCount: Array.isArray(data.notes) ? data.notes.length : null,
  };
}

export function recordDocumentLifecycle(input: {
  action: string;
  draftId: string | null;
  documentType: string;
  documentId?: string | null;
  fileName?: string | null;
  status?: string | null;
  extractionPayload?: unknown;
}) {
  if (!getWithholdingDiagnosticStatus().active) return;
  const at = new Date().toISOString();
  const safeExtractionShape = input.extractionPayload === undefined
    ? null
    : extractionShape(input.extractionPayload);
  recordAsync(async () => {
    appendEvent(
      "document.lifecycle",
      {
        action: input.action,
        draftTag: await privateTag("draft", input.draftId),
        documentTag: await privateTag("document", input.documentId),
        fileTag: await privateTag("file", input.fileName),
        documentType: input.documentType,
        status: input.status ?? null,
        extractionShape: safeExtractionShape,
        extractionPayloadIncluded: false,
      },
      at,
      true,
    );
  });
}

function normalizeReference(value: string | null | undefined) {
  return value?.trim().replace(/\s+/g, "").toUpperCase() ?? "";
}

function amountFromText(value: string | null | undefined) {
  if (!value?.trim()) return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

async function safeSummarySnapshot(summary: FilingSummary) {
  const servicesInvoices = await Promise.all(
    (summary.servicesInvoices ?? []).map(async (invoice) => ({
      invoiceTag: await privateTag("invoice", invoice.id),
      invoiceReferenceTag: await privateTag("invoice-ref", invoice.invoiceNumber),
      invoiceReferencePresent: Boolean(invoice.invoiceNumber),
      evidenceStatus: invoice.evidenceStatus,
      sourceFileTag: await privateTag("file", invoice.sourceDocumentFileName),
      paymentMatches: await Promise.all(
        (invoice.paymentMatches ?? []).map(async (match) => ({
          matchTag: await privateTag("match", match.id),
          ledgerEntryTag: await privateTag("ledger", match.ledgerEntryId),
          payoutReferenceTag: await privateTag("payout-ref", match.payoutReference),
          withholdingTaxPkr: match.withholdingTaxPkr,
          withholdingSection: match.withholdingSection,
          withholdingIrisCode: match.withholdingIrisCode,
          withholdingEvidenceDocumentTag: await privateTag(
            "document",
            match.withholdingEvidenceDocumentId,
          ),
          withholdingEvidenceDocumentType: match.withholdingEvidenceDocumentType,
          withholdingEvidenceHumanConfirmed: match.withholdingEvidenceHumanConfirmed,
          withholdingEvidenceReferencePresent: Boolean(match.withholdingEvidenceReference),
          recordStatus: match.recordStatus,
        })),
      ),
    })),
  );
  const servicesEvidenceDocuments = await Promise.all(
    (summary.servicesEvidenceDocuments ?? []).map(async (document) => ({
      documentTag: await privateTag("document", document.id),
      fileTag: await privateTag("file", document.fileName),
      documentType: document.documentType,
      extractionStatus: document.extractionStatus ?? null,
      withholdingRows: await Promise.all(
        (document.withholdingRows ?? []).map(async (row) => ({
          rowNumber: row.rowNumber,
          invoiceReferenceTag: await privateTag("invoice-ref", row.invoiceNumber),
          invoiceReferencePresent: Boolean(row.invoiceNumber),
          payoutReferenceTag: await privateTag("payout-ref", row.payoutReference),
          payoutReferencePresent: Boolean(row.payoutReference),
          amountPkr: row.amountPkr,
          section: row.section,
          irisCode: row.irisCode,
          evidenceReferencePresent: Boolean(row.evidenceReference),
          conflicting: row.conflicting,
        })),
      ),
    })),
  );
  return {
    summaryWithholdingWarningPresent: Boolean(summary.withholdingWarning),
    servicesAccountingMethod: summary.servicesAccountingMethod ?? null,
    selectedServicesSubcategories: (summary.selectedServicesSubcategories ?? []).map(
      (category) => category.subcategory,
    ),
    invoiceCount: servicesInvoices.length,
    evidenceDocumentCount: servicesEvidenceDocuments.length,
    servicesInvoices,
    servicesEvidenceDocuments,
  };
}

type PanelMatch = {
  clientKey: string;
  invoiceEvidenceId: string;
  payoutReference: string;
  withholdingTaxPkr: string;
  withholdingSection: string;
  withholdingIrisCode: string;
  withholdingEvidenceDocumentId: string;
  withholdingEvidenceHumanConfirmed: boolean;
};

type PanelInvoice = Pick<
  ServicesInvoiceEvidenceSummary,
  "id" | "invoiceNumber"
>;

function traceResolverCandidates(input: {
  invoiceNumber: string | null;
  payoutReference: string | null;
  documents: readonly ServicesWithholdingSourceDocument[];
}) {
  const invoice = normalizeReference(input.invoiceNumber);
  const payout = normalizeReference(input.payoutReference);
  type TracedCandidate = {
    document: ServicesWithholdingSourceDocument;
    row: NonNullable<ServicesWithholdingSourceDocument["withholdingRows"]>[number];
    invoiceMatch: boolean;
    payoutMatch: boolean;
    referenceConflict: boolean;
  };
  const linkedCandidates: TracedCandidate[] = [];
  const candidates: TracedCandidate[] = [];
  let linkedReferenceConflictCount = 0;

  for (const document of input.documents) {
    if (
      !document.id ||
      document.extractionStatus !== "MAPPED" ||
      !SERVICES_WITHHOLDING_DOCUMENT_TYPES.has(document.documentType)
    ) continue;
    for (const row of document.withholdingRows ?? []) {
      const rowInvoice = normalizeReference(row.invoiceNumber);
      const rowPayout = normalizeReference(row.payoutReference);
      const invoiceMatch = Boolean(invoice && rowInvoice === invoice);
      const payoutMatch = Boolean(payout && rowPayout === payout);
      if (!invoiceMatch && !payoutMatch) continue;
      const referenceConflict = Boolean(
        (invoice && rowInvoice && invoice !== rowInvoice) ||
          (payout && rowPayout && payout !== rowPayout),
      );
      const candidate = {
        document,
        row,
        invoiceMatch,
        payoutMatch,
        referenceConflict,
      };
      linkedCandidates.push(candidate);
      if (referenceConflict) {
        linkedReferenceConflictCount += 1;
        continue;
      }
      candidates.push(candidate);
    }
  }

  const dedicated = candidates.filter(
    (candidate) => candidate.document.documentType !== "bank_statement",
  );
  const typePool = dedicated.length > 0 ? dedicated : candidates;
  const complete = typePool.filter(
    (candidate) =>
      candidate.row.amountPkr !== null &&
      candidate.row.amountPkr > 0 &&
      Boolean(candidate.row.section) &&
      Boolean(candidate.row.irisCode),
  );
  const factPool = complete.length > 0 ? complete : typePool;
  const deduplicated: typeof candidates = [];
  for (const candidate of factPool) {
    const key = `${candidate.document.id}|${candidate.row.amountPkr}|${candidate.row.section}|${candidate.row.irisCode}`;
    if (
      !deduplicated.some(
        (existing) =>
          `${existing.document.id}|${existing.row.amountPkr}|${existing.row.section}|${existing.row.irisCode}` === key,
      )
    ) deduplicated.push(candidate);
  }
  return { linkedCandidates, candidates, typePool, factPool, deduplicated, linkedReferenceConflictCount };
}

export function recordServicesPanelSnapshot(input: {
  draftId?: string;
  accountingMethod: string | null | undefined;
  categories: readonly { subcategory: string }[];
  invoices: readonly PanelInvoice[];
  matches: readonly PanelMatch[];
  evidenceDocuments: readonly ServicesEvidenceDocumentSummary[];
  unresolvedCount: number;
  unresolvedTotalPkr: number;
}) {
  if (!getWithholdingDiagnosticStatus().active) return;
  const at = new Date().toISOString();
  recordAsync(async () => {
    const serviceDocuments = input.evidenceDocuments.map((document) => ({
      ...document,
      withholdingRows: document.withholdingRows ?? [],
    }));
    const documents = serviceDocuments as readonly ServicesWithholdingSourceDocument[];
    const resolutions = await Promise.all(
      input.matches.map(async (match) => {
        const invoice = input.invoices.find(
          (item) => item.id === match.invoiceEvidenceId,
        );
        const amountPkr = amountFromText(match.withholdingTaxPkr);
        const resolverInput = {
          invoiceNumber: invoice?.invoiceNumber ?? null,
          payoutReference: match.payoutReference || null,
          amountPkr,
          observedSection: match.withholdingSection || null,
          observedIrisCode: match.withholdingIrisCode || null,
          documents,
        };
        const result = resolveServicesWithholdingPrefill(resolverInput);
        const trace = traceResolverCandidates({
          invoiceNumber: resolverInput.invoiceNumber,
          payoutReference: resolverInput.payoutReference,
          documents,
        });
        return {
          matchTag: await privateTag("match", match.clientKey),
          invoiceTag: await privateTag("invoice", match.invoiceEvidenceId),
          invoiceReferenceTag: await privateTag("invoice-ref", invoice?.invoiceNumber),
          payoutReferenceTag: await privateTag("payout-ref", match.payoutReference),
          withholdingTaxPkr: amountPkr,
          observedSection: match.withholdingSection || null,
          observedIrisCode: match.withholdingIrisCode || null,
          selectedEvidenceDocumentTag: await privateTag(
            "document",
            match.withholdingEvidenceDocumentId,
          ),
          humanConfirmed: match.withholdingEvidenceHumanConfirmed,
          resolverStatus: result.status,
          resolverReason: "reason" in result ? result.reason : null,
          resolvedDocumentTag: result.status === "MATCHED"
            ? await privateTag("document", result.documentId)
            : null,
          resolvedFileTag: result.status === "MATCHED"
            ? await privateTag("file", result.fileName)
            : null,
          linkedReferenceConflictCount: trace.linkedReferenceConflictCount,
          linkedCandidateCount: trace.linkedCandidates.length,
          resolverEligibleCandidateCount: trace.candidates.length,
          preferredTypeCandidateCount: trace.typePool.length,
          completeFactCandidateCount: trace.factPool.length,
          deduplicatedCandidateCount: trace.deduplicated.length,
          candidateRows: await Promise.all(
            trace.linkedCandidates.map(async (candidate) => ({
              documentTag: await privateTag("document", candidate.document.id),
              fileTag: await privateTag("file", candidate.document.fileName),
              documentType: candidate.document.documentType,
              extractionStatus: candidate.document.extractionStatus ?? null,
              rowNumber: candidate.row.rowNumber,
              invoiceMatch: candidate.invoiceMatch,
              payoutMatch: candidate.payoutMatch,
              referenceConflict: candidate.referenceConflict,
              amountPkr: candidate.row.amountPkr,
              section: candidate.row.section,
              irisCode: candidate.row.irisCode,
              evidenceReferencePresent: Boolean(candidate.row.evidenceReference),
              conflicting: candidate.row.conflicting,
            })),
          ),
          deduplicatedCandidates: await Promise.all(
            trace.deduplicated.map(async (candidate) => ({
              documentTag: await privateTag("document", candidate.document.id),
              documentType: candidate.document.documentType,
              rowNumber: candidate.row.rowNumber,
              amountPkr: candidate.row.amountPkr,
              section: candidate.row.section,
              irisCode: candidate.row.irisCode,
            })),
          ),
        };
      }),
    );
    appendEvent(
      "services.panel.snapshot",
      {
        draftTag: await privateTag("draft", input.draftId),
        accountingMethod: input.accountingMethod ?? null,
        selectedSubcategories: input.categories.map((category) => category.subcategory),
        invoiceCount: input.invoices.length,
        evidenceDocumentCount: serviceDocuments.length,
        mappedEvidenceDocuments: await Promise.all(
          serviceDocuments.map(async (document) => ({
            documentTag: await privateTag("document", document.id),
            fileTag: await privateTag("file", document.fileName),
            documentType: document.documentType,
            extractionStatus: document.extractionStatus ?? null,
            withholdingRowCount: document.withholdingRows?.length ?? 0,
          })),
        ),
        matchCount: input.matches.length,
        unresolvedCount: input.unresolvedCount,
        unresolvedTotalPkr: input.unresolvedTotalPkr,
        resolutions,
      },
      at,
      true,
    );
  });
}

export function recordServicesEvidenceSave(input: {
  draftId?: string;
  success: boolean;
  invoiceCount?: number;
  paymentMatchCount?: number;
}) {
  if (!getWithholdingDiagnosticStatus().active) return;
  const at = new Date().toISOString();
  recordAsync(async () => {
    appendEvent(
      "services.evidence.save",
      {
        draftTag: await privateTag("draft", input.draftId),
        success: input.success,
        invoiceCount: input.invoiceCount ?? null,
        paymentMatchCount: input.paymentMatchCount ?? null,
      },
      at,
      true,
    );
  });
}
