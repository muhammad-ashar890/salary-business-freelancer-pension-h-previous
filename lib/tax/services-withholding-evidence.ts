/**
 * Document-driven Services withholding prefill. Routing authority stays in
 * services-iris-mapping.ts; this module never picks a rate/regime or changes
 * income, fees, bank balances or reconciliation calculations.
 */
export const SERVICES_WITHHOLDING_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "bank_statement",
  "other_income_proof",
  "advance_tax_evidence",
  "pseb_certificate",
]);

export type ServicesWithholdingSourceRow = {
  rowNumber: number;
  invoiceNumber: string | null;
  payoutReference: string | null;
  amountPkr: number | null;
  section: string | null;
  irisCode: string | null;
  evidenceReference: string | null;
  /** Conflicting duplicate labels cannot silently choose a value. */
  conflicting: boolean;
};

export type ServicesWithholdingSourceDocument = {
  id: string;
  fileName: string;
  documentType: string;
  extractionStatus?: string;
  withholdingRows?: readonly ServicesWithholdingSourceRow[];
};

const FIELD_KEYS: Readonly<Record<string, string>> = {
  invoice_number: "invoiceNumber",
  invoice_no: "invoiceNumber",
  payout_reference: "payoutReference",
  transaction_reference: "payoutReference",
  withholding_tax_pkr: "amountPkr",
  withholding_amount_pkr: "amountPkr",
  tax_deducted_pkr: "amountPkr",
  tax_withheld_pkr: "amountPkr",
  withholding_section: "section",
  statutory_section: "section",
  withholding_iris_code: "irisCode",
  iris_code: "irisCode",
  withholding_evidence_reference: "evidenceReference",
  withholding_certificate_reference: "evidenceReference",
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null;

function label(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
    : "";
}

function money(value: unknown): number | null {
  if (typeof value === "number")
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
  if (typeof value !== "string") return null;
  const clean = value.trim().replace(/^(?:PKR|Rs\.?)\s*/i, "").replace(/,/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean)) return null;
  const amount = Number(clean);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null;
}

/**
 * Canonicalise one explicit statutory section token from a section label.
 * Prefixes such as "u/s" and a printed rate suffix are presentation text, not
 * part of the statutory section; the exact IRIS code is checked separately.
 * If the label names multiple sections, keep it non-canonical so matching
 * fails closed instead of selecting one arbitrarily. No rate/code is inferred.
 */
function sectionText(value: unknown): string | null {
  const source = text(value);
  if (!source) return null;
  const compact = source.replace(/\s+/g, "").toUpperCase();
  const tokens = source.toUpperCase().match(
    /(?<!\d)(?:\d{3}\s*\(\s*\d+\s*\)(?:\s*\(\s*[A-Z]\s*\))?|\d{3}\s*[A-Z]?)(?![\dA-Z(])/g,
  ) ?? [];
  const canonicalTokens = Array.from(new Set(tokens.map((token) =>
    token.replace(/\s+/g, "").replace(/\(([A-Z])\)$/, (_match, letter: string) => `(${letter.toLowerCase()})`),
  )));
  if (canonicalTokens.length === 1) return canonicalTokens[0];
  if (canonicalTokens.length > 1) {
    return `AMBIGUOUS:${canonicalTokens.sort().join("|")}`;
  }
  return compact;
}
const identity = (value: unknown) => text(value)?.replace(/\s+/g, "").toUpperCase() ?? "";

/**
 * Read only explicit, numbered label/value facts from an approved extraction.
 * Unnumbered duplicate facts and mismatched row suffixes are not stitched into
 * a certificate. No tax rate, invoice total or gross/net difference is used.
 */
export function readServicesWithholdingSourceRows(extractedData: unknown): ServicesWithholdingSourceRow[] {
  let payload = extractedData;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { return []; }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const fields = (payload as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return [];
  const groups = new Map<number, { values: Record<string, unknown>; conflicting: boolean }>();
  for (const candidate of fields.slice(0, 5000)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const field = candidate as { label?: unknown; value?: unknown };
    const normal = label(field.label);
    const suffix = normal.match(/^(.*?)(?:_row)?_(\d+)$/);
    const key = FIELD_KEYS[suffix ? suffix[1] : normal];
    if (!key) continue;
    const number = suffix ? Number(suffix[2]) : 0;
    const group = groups.get(number) ?? { values: {}, conflicting: false };
    if (key in group.values) {
      // Even equal duplicate labels may belong to different unnumbered rows.
      group.conflicting = true;
    } else {
      group.values[key] = field.value;
    }
    groups.set(number, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([rowNumber, group]) => ({
    rowNumber,
    invoiceNumber: text(group.values.invoiceNumber),
    payoutReference: text(group.values.payoutReference),
    amountPkr: money(group.values.amountPkr),
    section: sectionText(group.values.section),
    irisCode: /^\d{8}$/.test(String(group.values.irisCode ?? "").trim())
      ? String(group.values.irisCode).trim() : null,
    evidenceReference: text(group.values.evidenceReference),
    conflicting: group.conflicting,
  }));
}

export type ServicesWithholdingPrefillResult =
  | { status: "NO_WITHHOLDING"; reason: string }
  | { status: "MISSING" | "AMBIGUOUS" | "CONFLICT"; reason: string }
  | {
      status: "MATCHED";
      documentId: string;
      fileName: string;
      amountPkr: number;
      section: string;
      irisCode: string;
      evidenceReference: string;
    };

/**
 * Match the exact invoice/payout, not just an equal amount or the source of the
 * bank credit. Multiple certificates, conflicting facts and invoice-only
 * evidence stay unresolved. The Review button still confirms the source facts;
 * the existing server + packet + Electron allowlists still decide placement.
 */
export function resolveServicesWithholdingPrefill(input: {
  invoiceNumber: string | null;
  payoutReference: string | null;
  amountPkr: number | null;
  observedSection?: string | null;
  observedIrisCode?: string | null;
  documents: readonly ServicesWithholdingSourceDocument[];
}): ServicesWithholdingPrefillResult {
  if (input.amountPkr === 0)
    return { status: "NO_WITHHOLDING", reason: "The payout records zero withholding; no tax row is needed." };
  if (input.amountPkr === null || !Number.isFinite(input.amountPkr) || input.amountPkr < 0)
    return { status: "MISSING", reason: "The payout needs an evidenced non-negative withholding amount; do not derive tax from a rate or gross/net difference." };
  const invoice = identity(input.invoiceNumber);
  const payout = identity(input.payoutReference);
  if (!invoice && !payout)
    return { status: "MISSING", reason: "An invoice number or payout reference is needed to link the withholding source automatically." };
  const candidates: { document: ServicesWithholdingSourceDocument; row: ServicesWithholdingSourceRow }[] = [];
  let linkedReferenceConflict = false;
  for (const document of input.documents) {
    if (!document.id || document.extractionStatus !== "MAPPED" ||
        !SERVICES_WITHHOLDING_DOCUMENT_TYPES.has(document.documentType)) continue;
    for (const row of document.withholdingRows ?? []) {
      const rowInvoice = identity(row.invoiceNumber);
      const rowPayout = identity(row.payoutReference);
      const linked = Boolean((invoice && rowInvoice === invoice) || (payout && rowPayout === payout));
      if (!linked) continue;
      // A matching invoice must not excuse a conflicting payout, or vice versa.
      if ((invoice && rowInvoice && invoice !== rowInvoice) ||
          (payout && rowPayout && payout !== rowPayout)) {
        // Other partial payouts of the same invoice may legitimately exist.
        // Use an exact row if present; otherwise report the conflicting link.
        linkedReferenceConflict = true;
        continue;
      }
      candidates.push({ document, row });
    }
  }
  if (!candidates.length && linkedReferenceConflict)
    return { status: "CONFLICT", reason: "The withholding source has a conflicting invoice/payout reference. Review it before confirming." };
  if (!candidates.length)
    return { status: "MISSING", reason: "Map a payer withholding certificate/statement that identifies this invoice or payout and explicitly states the tax amount, statutory section and exact IRIS code. An invoice or an ordinary net bank credit alone is not enough." };

  // Prefer explicit certificates over generic bank statement records when both exist.
  const dedicated = candidates.filter((c) => c.document.documentType !== "bank_statement");
  const typePool = dedicated.length > 0 ? dedicated : candidates;

  // Complete statutory facts (amount, section, IRIS code) take precedence over partial summary rows.
  const complete = typePool.filter(
    (c) => c.row.amountPkr !== null && c.row.amountPkr > 0 && c.row.section && c.row.irisCode,
  );
  const factPool = complete.length > 0 ? complete : typePool;

  // Deduplicate identical candidate facts belonging to the same document.
  const deduplicated: typeof candidates = [];
  for (const candidate of factPool) {
    const key = `${candidate.document.id}|${candidate.row.amountPkr}|${candidate.row.section}|${candidate.row.irisCode}`;
    if (
      !deduplicated.some(
        (existing) =>
          `${existing.document.id}|${existing.row.amountPkr}|${existing.row.section}|${existing.row.irisCode}` ===
          key,
      )
    ) {
      deduplicated.push(candidate);
    }
  }

  if (deduplicated.length !== 1)
    return { status: "AMBIGUOUS", reason: "More than one mapped withholding source matches this invoice/payout. Choose and review the correct source; nothing was selected automatically." };
  const { document, row } = deduplicated[0];
  if (row.conflicting)
    return { status: "CONFLICT", reason: "The mapped withholding source has duplicate/conflicting row labels; correct its document map first." };
  if (row.amountPkr === null || row.amountPkr <= 0 || !row.section || !row.irisCode)
    return { status: "MISSING", reason: "The matching withholding source is missing a positive PKR tax amount, statutory section or exact IRIS code. Missing facts are not guessed." };
  if (Math.round(row.amountPkr * 100) !== Math.round(input.amountPkr * 100) ||
      (sectionText(input.observedSection) && sectionText(input.observedSection) !== row.section) ||
      (text(input.observedIrisCode) && text(input.observedIrisCode) !== row.irisCode))
    return { status: "CONFLICT", reason: "The withholding source disagrees with the payout amount, section or IRIS code. The existing values were not replaced." };
  return {
    status: "MATCHED",
    documentId: document.id,
    fileName: document.fileName,
    amountPkr: row.amountPkr,
    section: row.section,
    irisCode: row.irisCode,
    evidenceReference: `${document.fileName} · ${row.evidenceReference || `mapped withholding row ${row.rowNumber || 1}`}`.slice(0, 500),
  };
}
