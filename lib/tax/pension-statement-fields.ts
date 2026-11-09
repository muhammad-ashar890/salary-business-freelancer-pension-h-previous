import { parseTaxpayerDateOfBirth } from "./taxpayer-age";

/** Printed facts are distinct from conditional, human-only tax review decisions. */
export const PENSION_LABELS = {
  taxYear: "Tax Year",
  grossAnnual: "Gross Pension (Annual PKR)",
  approvedAnnual: "Approved Pension Amount for Tax (Annual PKR)",
  taxDeducted: "Pension Tax Deducted (Annual PKR)",
  taxAlreadyInLedger: "Pension Withholding Already in Tax Ledger (Annual PKR)",
  reviewNote: "Pension Tax Base Review Note",
  medicalAnnual: "Medical Allowance (Annual PKR)",
  netAnnual: "Net Pension Payable (Annual PKR)",
  dateOfBirth: "Date of Birth",
  cnic: "Pensioner CNIC",
  currency: "Currency",
} as const;
type Key = keyof typeof PENSION_LABELS;
export type PensionReviewDecisionKey = "approvedAnnual" | "taxAlreadyInLedger" | "reviewNote";
export type PensionField = {
  label?: unknown;
  value?: unknown;
  confidence?: unknown;
  /** A model quotation is not independent verification or human approval. */
  sourceEvidence?: unknown;
  reviewSuggestion?: boolean;
};
const reviewDecisionKeys: Key[] = ["approvedAnnual", "taxAlreadyInLedger", "reviewNote"];
// These are the only unconditional annual-statement requirements. Unknown
// withholding and conditional tax-basis review are checked separately at tax time.
const required: Key[] = ["taxYear", "grossAnnual"];
const norm = (v: unknown) =>
  String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const aliases: Partial<Record<Key, string[]>> = {
  grossAnnual: ["Gross Annual Pension", "Annual Gross Pension", "Gross Pension Annual"],
  medicalAnnual: ["Annual Medical Allowance"],
  netAnnual: ["Annual Net Pension Payable", "Net Annual Pension Payable"],
  taxDeducted: ["Tax Deducted on Pension (Annual PKR)", "Pension Tax Withheld (Annual PKR)"],
  dateOfBirth: ["DOB", "Birth Date"],
  cnic: ["CNIC Number", "CNIC No", "CNIC"],
};
export function pensionFieldKey(label: unknown): Key | null {
  const n = norm(label);
  // Monthly/net pension is never an alias for annual gross or the tax basis.
  return (Object.keys(PENSION_LABELS) as Key[]).find((key) =>
    [PENSION_LABELS[key], ...(aliases[key] ?? [])].some((value) => norm(value) === n),
  ) ?? null;
}
export function pensionFieldValue(fields: PensionField[] | undefined, key: Key) {
  return (fields ?? []).find((field) => pensionFieldKey(field.label) === key)?.value;
}
const isBlank = (value: unknown) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");

/** Material source ambiguity must be reviewed, never resolved from net receipts. */
export function pensionTaxBasisNeedsReview(fields: PensionField[] | undefined) {
  const gross = parsePensionAmount(pensionFieldValue(fields, "grossAnnual"));
  const medical = parsePensionAmount(pensionFieldValue(fields, "medicalAnnual"));
  const net = parsePensionAmount(pensionFieldValue(fields, "netAnnual"));
  const deducted = parsePensionAmount(pensionFieldValue(fields, "taxDeducted"));
  const exceedsStatedComponents = gross !== null && net !== null &&
    Math.round(net * 100) > Math.round((gross + (medical ?? 0) - (deducted ?? 0)) * 100);
  return (medical !== null && medical > 0) || exceedsStatedComponents;
}

export function pensionReviewNoteRequired(fields: PensionField[] | undefined) {
  const approved = pensionFieldValue(fields, "approvedAnnual");
  if (isBlank(approved)) return false;
  const gross = parsePensionAmount(pensionFieldValue(fields, "grossAnnual"));
  // An ordinary confirmed gross basis needs no essay. A changed basis or an
  // explicit decision involving a non-zero allowance still needs an audit reason.
  return parsePensionAmount(approved) !== gross || pensionTaxBasisNeedsReview(fields);
}
export function isPensionStatementRequiredField(label: unknown, fields?: PensionField[]) {
  const key = pensionFieldKey(label);
  return key !== null && (required.includes(key) || (key === "reviewNote" && pensionReviewNoteRequired(fields)));
}
export function isPensionReviewDecisionField(label: unknown) {
  const key = pensionFieldKey(label);
  return key !== null && reviewDecisionKeys.includes(key);
}

/** Preserve legacy, exactly quoted suggestions, but never infer reviewer decisions. */
function hasPrintedPensionReviewSuggestion(field: PensionField, key: Key) {
  if (typeof field.sourceEvidence !== "string") return false;
  const squash = (value: string) => value.replace(/\s+/g, " ").trim();
  const quote = squash(field.sourceEvidence);
  const label = PENSION_LABELS[key];
  if (!quote.toLowerCase().startsWith(label.toLowerCase())) return false;
  const printed = quote.slice(label.length).replace(/^\s*[:|]\s*/, "").trim();
  if (key === "reviewNote") {
    return typeof field.value === "string" && field.value.trim().length >= 5 && squash(field.value) === printed;
  }
  const amount = parsePensionAmount(field.value);
  const printedAmount = parsePensionAmount(printed);
  return amount !== null && printedAmount !== null && (key !== "approvedAnnual" || amount > 0) && amount === printedAmount;
}

export function ensurePensionStatementReviewFields(raw: unknown, fromModel = false): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const p = raw as Record<string, unknown>;
  const fields: PensionField[] = Array.isArray(p.fields)
    ? p.fields.filter((f) => f && typeof f === "object" && !Array.isArray(f)).map((f) => ({ ...f }))
    : [];
  // A missing deduction gets an optional, explicitly unknown fact so the user
  // can supply separately verified withholding. No app-only blank fields added.
  for (const key of [...required, "taxDeducted"] as Key[]) {
    if (!fields.some((f) => pensionFieldKey(f.label) === key)) {
      fields.push({ label: PENSION_LABELS[key], value: null, confidence: 0 });
    }
  }
  for (const field of fields) {
    if (isBlank(field.value)) field.confidence = 0;
    const key = pensionFieldKey(field.label);
    if (key === null || !reviewDecisionKeys.includes(key)) continue;
    const suggestion = fields.filter((candidate) => pensionFieldKey(candidate.label) === key).length === 1 && hasPrintedPensionReviewSuggestion(field, key);
    if (fromModel) {
      field.reviewSuggestion = suggestion;
      if (!suggestion) {
        field.value = null;
        field.confidence = 0;
        delete field.sourceEvidence;
      }
    } else if (field.reviewSuggestion === true && !suggestion) {
      field.reviewSuggestion = false;
      field.confidence = 0;
      delete field.sourceEvidence;
    }
  }
  return { ...p, fields };
}
export function parsePensionAmount(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value).trim().replace(/^(PKR|Rs\.?)\s*/i, "");
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return null;
  const number = Number(text.replace(/,/g, ""));
  return Number.isFinite(number) && number >= 0 && Number.isSafeInteger(Math.round(number * 100)) ? number : null;
}

/** Document approval validates printed facts, not an invented tax/ledger decision. */
export function getPensionStatementReviewErrors(fields: PensionField[] | undefined, taxYear?: number): string[] {
  const all = fields ?? [];
  const errors: string[] = [];
  for (const key of Object.keys(PENSION_LABELS) as Key[]) {
    const matches = all.filter((f) => pensionFieldKey(f.label) === key);
    if (matches.length > 1) {
      errors.push(`${PENSION_LABELS[key]}: duplicate fields; review the extraction.`);
      continue;
    }
    const v = matches[0]?.value;
    if (isBlank(v)) {
      if (required.includes(key)) {
        errors.push(`${PENSION_LABELS[key]} is required. Review the original annual statement.`);
      }
      continue;
    }
    if (key === "taxYear") {
      if (!/^\d{4}$/.test(String(v).trim()) || (taxYear !== undefined && Number(v) !== taxYear)) {
        errors.push(`Pension Tax Year must be ${taxYear ?? "a four-digit year"}.`);
      }
    } else if (key === "reviewNote") {
      if (typeof v !== "string") errors.push("Pension Tax Base Review Note must be text.");
    } else if (key === "currency") {
      if (typeof v !== "string" || v.trim().toUpperCase() !== "PKR") {
        errors.push("Pension statement currency must be PKR; foreign amounts must not be relabelled or converted automatically.");
      }
    } else if (key === "dateOfBirth") {
      if (!parseTaxpayerDateOfBirth(v)) errors.push("Pension Date of Birth must be a valid date.");
    } else if (key === "cnic") {
      if (!/^[\d\s-]+$/.test(String(v)) || String(v).replace(/\D/g, "").length !== 13) {
        errors.push("Pensioner CNIC must contain exactly 13 digits.");
      }
    } else {
      const n = parsePensionAmount(v);
      if (n === null || (["grossAnnual", "approvedAnnual"].includes(key) && n <= 0)) {
        errors.push(`${PENSION_LABELS[key]}: enter a valid ${["grossAnnual", "approvedAnnual"].includes(key) ? "positive " : "non-negative "}annual PKR amount (at most two decimal places).`);
      }
    }
  }
  if (pensionReviewNoteRequired(all)) {
    const note = pensionFieldValue(all, "reviewNote");
    if (typeof note !== "string" || note.trim().length < 5) {
      errors.push("Pension Tax Base Review Note is required only for this manual tax-base override, allowance decision or source discrepancy. Explain the reviewed treatment (at least five characters).");
    }
  }
  const deducted = parsePensionAmount(pensionFieldValue(all, "taxDeducted"));
  const covered = parsePensionAmount(pensionFieldValue(all, "taxAlreadyInLedger"));
  if (deducted !== null && covered !== null && covered > deducted) {
    errors.push("Pension withholding already in the tax ledger cannot exceed pension tax deducted.");
  }
  return errors;
}

/** Tax readiness is stricter than statement review: no missing-as-zero credits. */
export function getPensionTaxReadinessErrors(
  fields: PensionField[] | undefined,
  ledgerTaxWithheld?: number,
  options?: { hasOtherIncomeSources?: boolean },
): string[] {
  const errors: string[] = [];
  const medical = parsePensionAmount(pensionFieldValue(fields, "medicalAnnual"));
  if (isBlank(pensionFieldValue(fields, "approvedAnnual")) && pensionTaxBasisNeedsReview(fields)) {
    errors.push(medical !== null && medical > 0
      ? "Review the Approved Pension Amount for Tax and allowance treatment before calculating: a non-zero medical allowance is printed. It is not automatically included or excluded; net receipts are not the tax basis."
      : "Review the Approved Pension Amount for Tax: net receipts exceed the stated gross/allowance/withholding components. Verify the source discrepancy and explain the basis; do not guess from net receipts.");
  }
  const deducted = parsePensionAmount(pensionFieldValue(fields, "taxDeducted"));
  if (deducted === null) {
    errors.push("Pension Tax Deducted (Annual PKR) is not stated. Confirm the actual deduction before final tax calculation; enter 0 only after verification. Unknown withholding is not zero.");
  } else if (deducted > 0 && isBlank(pensionFieldValue(fields, "taxAlreadyInLedger"))) {
    // No question when nothing can overlap: an empty tax ledger cannot overlap,
    // and on a pension-only filing a ledger total equal to the certificate's
    // deduction is the same money. When other income sources are also selected,
    // equal-sized TAX_PAYMENT entries may belong to another source, so the
    // overlap must be explicitly confirmed instead of assumed.
    const hasOtherIncomeSources = options?.hasOtherIncomeSources === true;
    if (ledgerTaxWithheld === undefined) {
      errors.push("Confirm Pension Withholding Already in Tax Ledger before calculating when existing tax entries may overlap. Link/review the actual pension deduction; do not allocate unrelated TAX_PAYMENT entries by guessing.");
    } else if (
      ledgerTaxWithheld !== 0 &&
      (hasOtherIncomeSources || ledgerTaxWithheld !== deducted)
    ) {
      errors.push(
        `Pension tax deducted is ${formatPkr(deducted)} and the bank ledger holds tax payments totalling ${formatPkr(ledgerTaxWithheld)}. ` +
          "Enter how much of the deduction is already among those ledger payments (0 if they are separate payments), then calculate again. " +
          "Do not allocate unrelated tax payments by guessing.",
      );
    }
  }
  return errors;
}
export type PensionStatementFacts = {
  taxYear: number;
  grossAnnual: number;
  medicalAnnual: number | null;
  netAnnual: number | null;
  approvedAnnual: number | null;
  taxDeducted: number | null;
  taxAlreadyInLedger: number | null;
  reviewNote: string;
  dateOfBirth: string | null;
  cnic: string | null;
};
export type ReviewedPensionStatement = Omit<PensionStatementFacts, "approvedAnnual" | "taxDeducted" | "taxAlreadyInLedger"> & {
  approvedAnnual: number;
  taxDeducted: number;
  taxAlreadyInLedger: number;
  /**
   * Set when the ledger overlap was recognised without asking, because the
   * certificate's deduction and the ledger's tax payments are the same amount.
   * The packet prints it so the nil extra credit is explained, not mysterious.
   */
  overlapNote: string | null;
};

/** PKR amount in plain words for a message a taxpayer reads. */
function formatPkr(value: number) {
  return `PKR ${Math.round(value).toLocaleString("en-PK")}`;
}
function pensionFieldsFromPayload(raw: unknown): PensionField[] {
  let p: unknown;
  try {
    p = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("Pension statement has invalid extracted data; review and approve it again.");
  }
  return p && typeof p === "object" && Array.isArray((p as { fields?: unknown }).fields)
    ? (p as { fields: PensionField[] }).fields.filter((f) => f && typeof f === "object")
    : [];
}
export function readPensionStatementFacts(raw: unknown, taxYear: number): PensionStatementFacts {
  const fields = pensionFieldsFromPayload(raw);
  const errors = getPensionStatementReviewErrors(fields, taxYear);
  if (errors.length) throw new Error(errors.join(" · "));
  const gross = parsePensionAmount(pensionFieldValue(fields, "grossAnnual"))!;
  const medical = parsePensionAmount(pensionFieldValue(fields, "medicalAnnual"));
  const explicitAnnual = parsePensionAmount(pensionFieldValue(fields, "approvedAnnual"));
  const deducted = parsePensionAmount(pensionFieldValue(fields, "taxDeducted"));
  const covered = parsePensionAmount(pensionFieldValue(fields, "taxAlreadyInLedger"));
  const dob = parseTaxpayerDateOfBirth(pensionFieldValue(fields, "dateOfBirth"));
  const cnic = String(pensionFieldValue(fields, "cnic") ?? "").replace(/\D/g, "");
  return {
    taxYear,
    grossAnnual: gross,
    medicalAnnual: medical,
    netAnnual: parsePensionAmount(pensionFieldValue(fields, "netAnnual")),
    // A plain reviewed gross-pension statement needs no duplicate amount entry.
    // A separate nonzero allowance/material mismatch needs a human decision instead.
    approvedAnnual: explicitAnnual ?? (pensionTaxBasisNeedsReview(fields) ? null : gross),
    taxDeducted: deducted,
    taxAlreadyInLedger: covered ?? (deducted === 0 ? 0 : null),
    reviewNote: String(pensionFieldValue(fields, "reviewNote") ?? "").trim(),
    dateOfBirth: dob?.toISOString().slice(0, 10) ?? null,
    cnic: cnic || null,
  };
}
/** Only this stricter reader may supply a calculation/packet source. */
export function readReviewedPensionStatement(
  raw: unknown,
  taxYear: number,
  context: { ledgerTaxWithheld?: number; hasOtherIncomeSources?: boolean } = {},
): ReviewedPensionStatement {
  const facts = readPensionStatementFacts(raw, taxYear);
  const hasOtherIncomeSources = context.hasOtherIncomeSources === true;
  const errors = getPensionTaxReadinessErrors(
    pensionFieldsFromPayload(raw),
    context.ledgerTaxWithheld,
    { hasOtherIncomeSources },
  );
  if (errors.length) throw new Error(errors.join(" · "));

  // On a pension-only filing, the certificate's deduction and the ledger's tax
  // payments are the same money when the two totals are equal: the payer's
  // deduction is the only tax the bank ever saw. On a multi-source filing,
  // auto-overlap is disabled so equal-sized TAX_PAYMENT rows from another
  // income source never silently zero out the pension credit.
  const ledger = context.ledgerTaxWithheld;
  const autoOverlap =
    !hasOtherIncomeSources &&
    facts.taxAlreadyInLedger === null &&
    typeof ledger === "number" &&
    ledger > 0 &&
    ledger === facts.taxDeducted
      ? ledger
      : null;

  return {
    ...facts,
    approvedAnnual: facts.approvedAnnual!,
    taxDeducted: facts.taxDeducted!,
    // Safe only because known nil deduction or a checked empty current tax ledger
    // cannot overlap. Otherwise readiness requires a reviewed allocation.
    taxAlreadyInLedger: facts.taxAlreadyInLedger ?? autoOverlap ?? 0,
    overlapNote:
      autoOverlap === null
        ? null
        : `The bank ledger tax payments total ${formatPkr(autoOverlap)}, exactly the deduction on the pension certificate, so the same tax is counted once: the credit added from the certificate is nil.`,
  };
}
export function pensionProfileErrors(
  statement: Pick<PensionStatementFacts, "dateOfBirth" | "cnic">,
  profile: { dateOfBirth?: Date | null; cnic?: string | null },
) {
  const errors: string[] = [];
  if (statement.dateOfBirth && profile.dateOfBirth && statement.dateOfBirth !== profile.dateOfBirth.toISOString().slice(0, 10)) {
    errors.push("Pension statement DOB differs from the taxpayer profile/CNIC. Correct the source/profile before calculating; the statement must not overwrite identity automatically.");
  }
  const profileCnic = String(profile.cnic ?? "").replace(/\D/g, "");
  if (statement.cnic && profileCnic && statement.cnic !== profileCnic) {
    errors.push("Pension statement CNIC differs from the taxpayer profile. Use a statement for this taxpayer.");
  }
  return errors;
}
