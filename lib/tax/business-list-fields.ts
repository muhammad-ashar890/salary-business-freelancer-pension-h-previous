import { BUSINESS_FACT_LABELS } from "./business-document-intake";
import {
  sanitizeBusinessBankAccounts,
  sanitizeBusinessProperties,
  sanitizeBusinessVehicles,
  validateBusinessBankAccounts,
  validateBusinessProperties,
  validateBusinessVehicles,
  type BusinessBankAccount,
  type BusinessProperty,
  type BusinessVehicle,
} from "./business-balance-details";
import {
  sanitizeDepreciationSchedule,
  validateDepreciationSchedule,
  type DepreciationScheduleRow,
} from "./business-depreciation-schedule";
import {
  sanitizeBusinessTaxDeductions,
  validateBusinessTaxDeductions,
  type BusinessTaxDeduction,
} from "./business-tax-deductions";
import {
  sanitizeBusinessAddBacks,
  validateBusinessAddBacks,
  type BusinessAddBack,
} from "./business-addbacks";
import {
  sanitizeBusinessLossesByYear,
  validateBusinessLossesByYear,
  type BusinessLossByYear,
} from "./business-loss-rules";

/**
 * Business detail lists are collected from Gemini as JSON-encoded field
 * values because the generic document-extraction payload is label/value
 * based. That storage detail belongs on the server: API responses expose
 * structured rows, the review screen edits ordinary row fields, and this
 * module converts the reviewed rows back to the canonical stored JSON.
 */
export type BusinessListFieldKey =
  | "businessBankAccounts"
  | "businessVehicles"
  | "businessProperties"
  | "businessDepreciationSchedule"
  | "businessTaxDeductions"
  | "businessAddBacks"
  | "businessLossesByYear";

export type BusinessListRow = Record<string, unknown>;

export type BusinessListFieldDefinition = Readonly<{
  key: BusinessListFieldKey;
  /** Canonical extraction/storage label (never shown as an editable JSON box). */
  label: string;
  /** Human label for the review screen. */
  displayLabel: string;
  description: string;
}>;

export const BUSINESS_LIST_FIELD_DEFINITIONS: readonly BusinessListFieldDefinition[] = [
  {
    key: "businessBankAccounts",
    label: BUSINESS_FACT_LABELS.businessBankAccounts,
    displayLabel: "Business bank accounts",
    description:
      "Own sole PKR business accounts and their Balance Sheet balance at 30 June.",
  },
  {
    key: "businessVehicles",
    label: BUSINESS_FACT_LABELS.businessVehicles,
    displayLabel: "Business motor vehicles",
    description:
      "Vehicles included in the Balance Sheet motor-vehicle figure.",
  },
  {
    key: "businessProperties",
    label: BUSINESS_FACT_LABELS.businessProperties,
    displayLabel: "Business land and building properties",
    description:
      "Land/building detail as IRIS asks for it; values must add up to the Balance Sheet land and building figures.",
  },
  {
    key: "businessDepreciationSchedule",
    label: BUSINESS_FACT_LABELS.businessDepreciationSchedule,
    displayLabel: "Tax depreciation schedule",
    description:
      "Tax written-down values by IRIS asset class. Use tax values, not book values.",
  },
  {
    key: "businessTaxDeductions",
    label: BUSINESS_FACT_LABELS.businessTaxDeductions,
    displayLabel: "Tax deducted by IRIS section",
    description:
      "Adjustable/minimum-tax sections from withholding certificates or schedules.",
  },
  {
    key: "businessAddBacks",
    label: BUSINESS_FACT_LABELS.businessAddBacks,
    displayLabel: "Expenses not allowed, by reason",
    description:
      "Split inadmissible expenses by the IRIS reason shown in the source record.",
  },
  {
    key: "businessLossesByYear",
    label: BUSINESS_FACT_LABELS.businessLossesByYear,
    displayLabel: "Business losses by tax year",
    description:
      "Unused ordinary business losses, split by the year in which each loss arose.",
  },
];

type FieldLike = {
  label?: unknown;
  value?: unknown;
  confidence?: unknown;
  [key: string]: unknown;
};

const normalizeLabel = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const asRows = (rows: readonly object[]): BusinessListRow[] =>
  rows as unknown as BusinessListRow[];

export function businessListFieldDefinition(
  label: unknown,
): BusinessListFieldDefinition | null {
  const wanted = normalizeLabel(label);
  return (
    BUSINESS_LIST_FIELD_DEFINITIONS.find(
      (definition) => normalizeLabel(definition.label) === wanted,
    ) ?? null
  );
}

export function isBusinessListFieldLabel(label: unknown): boolean {
  return businessListFieldDefinition(label) !== null;
}

function sanitizeRows(
  key: BusinessListFieldKey,
  value: unknown,
): { ok: true; rows: BusinessListRow[] } | { ok: false; error: string } {
  switch (key) {
    case "businessBankAccounts": {
      const result = sanitizeBusinessBankAccounts(value);
      if (result.ok === true) return { ok: true, rows: asRows(result.rows) };
      return { ok: false, error: result.error };
    }
    case "businessVehicles": {
      const result = sanitizeBusinessVehicles(value);
      if (result.ok === true) return { ok: true, rows: asRows(result.rows) };
      return { ok: false, error: result.error };
    }
    case "businessProperties": {
      const result = sanitizeBusinessProperties(value);
      if (result.ok === true) return { ok: true, rows: asRows(result.rows) };
      return { ok: false, error: result.error };
    }
    case "businessDepreciationSchedule": {
      const result = sanitizeDepreciationSchedule(value);
      if (result.ok === true) return { ok: true, rows: asRows(result.rows) };
      return { ok: false, error: result.error };
    }
    case "businessTaxDeductions": {
      const result = sanitizeBusinessTaxDeductions(value);
      if (result.ok === true) return { ok: true, rows: asRows(result.rows) };
      return { ok: false, error: result.error };
    }
    case "businessAddBacks": {
      const result = sanitizeBusinessAddBacks(value);
      if (result.ok === true) return { ok: true, rows: asRows(result.rows) };
      return { ok: false, error: result.error };
    }
    case "businessLossesByYear": {
      const result = sanitizeBusinessLossesByYear(value);
      if (result.ok === true) return { ok: true, rows: asRows(result.rows) };
      return { ok: false, error: result.error };
    }
  }
}

function validateRows(
  key: BusinessListFieldKey,
  rows: readonly BusinessListRow[],
  taxYear: number,
): string[] {
  switch (key) {
    case "businessBankAccounts":
      return validateBusinessBankAccounts(rows as BusinessBankAccount[]);
    case "businessVehicles":
      return validateBusinessVehicles(rows as BusinessVehicle[]);
    case "businessProperties":
      return validateBusinessProperties(rows as BusinessProperty[]);
    case "businessDepreciationSchedule":
      return validateDepreciationSchedule(rows as DepreciationScheduleRow[]);
    case "businessTaxDeductions":
      return validateBusinessTaxDeductions(rows as BusinessTaxDeduction[]);
    case "businessAddBacks":
      return validateBusinessAddBacks(rows as BusinessAddBack[]);
    case "businessLossesByYear":
      return validateBusinessLossesByYear(
        rows as BusinessLossByYear[],
        taxYear,
      );
  }
}

function decodeRows(
  value: unknown,
): { ok: true; value: unknown } | { ok: false } {
  if (typeof value !== "string") return { ok: true, value };
  const text = value.trim();
  if (!text) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function isBlank(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  );
}

export type ParsedBusinessListField = Readonly<{
  definition: BusinessListFieldDefinition;
  /** Sanitized rows, safe for summaries and for canonical storage. */
  rows: BusinessListRow[];
  /** True only when the source explicitly supplied an empty list. */
  explicitEmpty: boolean;
  /** Unreadable/invalid stored shape. These block Save & Approve Map. */
  errors: string[];
  /** Incomplete or presently unsupported rows. These are resolved later. */
  warnings: string[];
}>;

/** Parse one stored/received list field without exposing raw JSON to the UI. */
export function parseBusinessListField(
  label: unknown,
  value: unknown,
  taxYear = 2026,
): ParsedBusinessListField | null {
  const definition = businessListFieldDefinition(label);
  if (!definition) return null;
  if (isBlank(value)) {
    return {
      definition,
      rows: [],
      explicitEmpty: false,
      errors: [],
      warnings: [],
    };
  }

  const decoded = decodeRows(value);
  if (!decoded.ok || !Array.isArray(decoded.value)) {
    return {
      definition,
      rows: [],
      explicitEmpty: false,
      errors: [
        `${definition.displayLabel}: the extracted rows could not be read. Enter the rows in the fields provided or re-run extraction.`,
      ],
      warnings: [],
    };
  }

  const sanitized = sanitizeRows(definition.key, decoded.value);
  if (sanitized.ok === false) {
    return {
      definition,
      rows: [],
      explicitEmpty: false,
      errors: [`${definition.displayLabel}: ${sanitized.error}`],
      warnings: [],
    };
  }

  return {
    definition,
    rows: sanitized.rows,
    explicitEmpty: decoded.value.length === 0,
    errors: [],
    warnings: validateRows(definition.key, sanitized.rows, taxYear),
  };
}

/**
 * Rows exactly as an editor should hold them. Unlike `parseBusinessListField`
 * this does not sanitize away a half-typed row while the taxpayer is typing.
 */
export function readBusinessListRows(
  label: unknown,
  value: unknown,
): { rows: BusinessListRow[]; readable: boolean } {
  if (!isBusinessListFieldLabel(label) || isBlank(value)) {
    return { rows: [], readable: true };
  }
  const decoded = decodeRows(value);
  if (!decoded.ok || !Array.isArray(decoded.value)) {
    return { rows: [], readable: false };
  }
  const rows: BusinessListRow[] = [];
  for (const entry of decoded.value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { rows: [], readable: false };
    }
    rows.push({ ...(entry as Record<string, unknown>) });
  }
  return { rows, readable: true };
}

/** Blocking shape errors for every business detail list in a review payload. */
export function businessListFieldErrors(
  fields: readonly FieldLike[] | undefined,
  taxYear = 2026,
): string[] {
  const errors: string[] = [];
  const seen = new Set<BusinessListFieldKey>();
  for (const field of fields ?? []) {
    const definition = businessListFieldDefinition(field.label);
    if (!definition) continue;
    if (seen.has(definition.key)) {
      errors.push(
        `${definition.displayLabel}: duplicate extracted lists; review the document extraction.`,
      );
      continue;
    }
    seen.add(definition.key);
    errors.push(
      ...(parseBusinessListField(field.label, field.value, taxYear)?.errors ??
        []),
    );
  }
  return errors;
}

/** Non-blocking completeness/support warnings for all list fields. */
export function businessListFieldWarnings(
  fields: readonly FieldLike[] | undefined,
  taxYear = 2026,
): string[] {
  const warnings: string[] = [];
  for (const field of fields ?? []) {
    warnings.push(
      ...(parseBusinessListField(field.label, field.value, taxYear)
        ?.warnings ?? []),
    );
  }
  return warnings;
}

function extractFields(raw: unknown): FieldLike[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const payload = raw as Record<string, unknown>;
  if (!Array.isArray(payload.fields)) return null;
  return payload.fields.filter(
    (field): field is FieldLike =>
      Boolean(field) && typeof field === "object" && !Array.isArray(field),
  );
}

/**
 * Convert reviewed structured rows back to canonical stored JSON strings.
 * A blank remains null (unknown); only an explicitly empty list remains [].
 */
export function normalizeBusinessListFieldsForStorage(
  raw: unknown,
  taxYear = 2026,
): { payload: unknown; errors: string[] } {
  const fields = extractFields(raw);
  if (!fields) return { payload: raw, errors: [] };
  const errors: string[] = [];
  const seen = new Set<BusinessListFieldKey>();
  const nextFields = fields.map((field) => {
    const definition = businessListFieldDefinition(field.label);
    if (!definition) return field;
    if (seen.has(definition.key)) {
      errors.push(
        `${definition.displayLabel}: duplicate extracted lists; review the document extraction.`,
      );
      return field;
    }
    seen.add(definition.key);
    const parsed = parseBusinessListField(field.label, field.value, taxYear);
    if (!parsed || parsed.errors.length) {
      errors.push(...(parsed?.errors ?? []));
      return field;
    }
    if (parsed.rows.length) {
      return { ...field, value: JSON.stringify(parsed.rows) };
    }
    return { ...field, value: parsed.explicitEmpty ? "[]" : null };
  });
  return {
    payload: { ...(raw as Record<string, unknown>), fields: nextFields },
    errors,
  };
}

/**
 * Server-to-client presentation: valid stored JSON strings become structured
 * arrays, so browser code never has to display or ask the user to edit JSON.
 */
export function presentBusinessListFields(raw: unknown, taxYear = 2026): unknown {
  const fields = extractFields(raw);
  if (!fields) return raw;
  const nextFields = fields.map((field) => {
    const parsed = parseBusinessListField(field.label, field.value, taxYear);
    if (!parsed || parsed.errors.length) return field;
    return {
      ...field,
      value: parsed.rows.length
        ? parsed.rows
        : parsed.explicitEmpty
          ? []
          : null,
    };
  });
  return { ...(raw as Record<string, unknown>), fields: nextFields };
}

function ensureFields(raw: unknown, labels: readonly string[]): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const payload = raw as Record<string, unknown>;
  const fields: FieldLike[] = Array.isArray(payload.fields)
    ? payload.fields
        .filter(
          (field): field is FieldLike =>
            Boolean(field) &&
            typeof field === "object" &&
            !Array.isArray(field),
        )
        .map((field) => ({ ...field }))
    : [];
  for (const label of labels) {
    if (!fields.some((field) => normalizeLabel(field.label) === normalizeLabel(label))) {
      fields.push({ label, value: null, confidence: 0 });
    }
  }
  return { ...payload, fields };
}

/** Visible blank list editors when extraction missed a detail list. */
export function ensureBusinessListReviewFields(raw: unknown): unknown {
  return ensureFields(
    raw,
    BUSINESS_LIST_FIELD_DEFINITIONS.map((definition) => definition.label),
  );
}

/**
 * A business-support review should let the taxpayer type any missing simple
 * value directly, instead of depending on Gemini having returned a blank
 * placeholder for that exact label.
 */
export function ensureBusinessFactReviewFields(raw: unknown): unknown {
  return ensureFields(raw, Object.values(BUSINESS_FACT_LABELS));
}
