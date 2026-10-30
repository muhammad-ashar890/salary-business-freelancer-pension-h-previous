import { BUSINESS_BOOKS_FIGURE_LABELS_AFTER_SALES } from "./business-books-annual-labels";
import {
  BUSINESS_SCHEDULE_LABELS,
  businessPurchaseBasisRequired,
  isBusinessPurchaseBasisField,
  parseBusinessPurchaseBasis,
} from "./business-schedule-fields";
import { isSalaryCertificateRequiredField } from "./salary-certificate-fields";
import { ensurePensionStatementReviewFields, isPensionStatementRequiredField, getPensionStatementReviewErrors } from "./pension-statement-fields";
import { PREVIOUS_RETURN_LABELS, getPreviousReturnReviewErrors } from "./previous-return-fields";
import { parseTaxpayerDateOfBirth } from "./taxpayer-age";
import {
  isBankStatementIbanLabel,
  validateBankStatementIban,
} from "./bank-statement-fields";

type Field = { label?: unknown; value?: unknown; confidence?: unknown };
type Requirement = {
  label: string;
  aliases?: string[];
  kind?:
    | "amount"
    | "positive_amount"
    | "date"
    | "year"
    | "cnic"
    | "currency"
    | "boolean";
  /** A Business Balance Sheet row: 0 is a valid answer, a blank is not. */
  balanceRow?: boolean;
  /**
   * One of the 7 Business Books yearly totals after Sales (16-Oct): they fill
   * the Business profit step, so 0 is a valid answer and a blank is not.
   */
  booksFigure?: boolean;
};
const normalize = (value: unknown) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/**
 * Business Balance Sheet rows (16-Oct): every row is a required review field,
 * so a figure the PDF does not show is typed on the review screen. 0 is
 * allowed (the business has none); a blank is not. The labels are the
 * extraction labels of lib/tax/business-filing.ts (BUSINESS_BALANCE_LABELS);
 * scripts/verify-balance-sheet-required.cjs keeps the two lists equal.
 */
export const BALANCE_SHEET_ASSET_ROWS = [
  "Business Land",
  "Business Building",
  "Plant / Machinery / Equipment / Furniture",
  "Business Motor Vehicles",
  "Advances / Deposits / Prepayments",
  "Stocks / Stores / Spares",
  "Business Cash in Hand",
  "Business Bank Balance",
  "Bonds / Securities",
  "Other Business Assets",
] as const;
export const BALANCE_SHEET_LIABILITY_ROWS = [
  "Owner Capital",
  "Long Term Borrowings / Debt / Loan",
  "Trade Creditors / Payables",
  "Other Business Liabilities",
] as const;
const BALANCE_SHEET_TOTAL_ASSETS = "Total Assets";
const BALANCE_SHEET_TOTAL_EQUITY_LIABILITIES = "Total Equity and Liabilities";

/** Required for the supported app flow, not a claim that every document is legally compulsory. */
const REQUIREMENTS: Record<string, Requirement[]> = {
  // Previous-return carry-forward (Phase 2): the scalars a reviewer must
  // confirm on an uploaded IRIS print. Placeholder/required marking is the
  // generic path; the semantic checks (earlier tax year, wealth tie-out)
  // live in getPreviousReturnReviewErrors via the special-case below.
  previous_return: [
    { label: PREVIOUS_RETURN_LABELS.taxpayerName },
    { label: PREVIOUS_RETURN_LABELS.registrationNo, kind: "cnic" },
    { label: PREVIOUS_RETURN_LABELS.taxYear, kind: "year" },
    { label: PREVIOUS_RETURN_LABELS.totalAssets, kind: "amount" },
    { label: PREVIOUS_RETURN_LABELS.totalLiabilities, kind: "amount" },
    { label: PREVIOUS_RETURN_LABELS.netAssets, kind: "amount" },
  ],
  cnic: [
    {
      label: "CNIC Number",
      aliases: ["cnic", "identity number"],
      kind: "cnic",
    },
    { label: "Date of Birth", aliases: ["dob", "birth date"], kind: "date" },
  ],
  bank_statement: [
    { label: "IBAN", aliases: ["account iban", "iban number"] },
    {
      label: "Opening Balance",
      aliases: ["balance at 1 february"],
      kind: "amount",
    },
    {
      label: "Closing Balance",
      aliases: ["balance at 1 march"],
      kind: "amount",
    },
    {
      label: "Statement Period Start",
      aliases: ["from date", "period start", "statement start date"],
      kind: "date",
    },
    {
      label: "Statement Period End",
      aliases: ["to date", "period end", "statement end date"],
      kind: "date",
    },
    { label: "Currency", kind: "currency" },
  ],
  business_books: [
    { label: "Business Name" },
    { label: "Tax Year", kind: "year" },
    { label: "Currency", kind: "currency" },
    {
      label: "Reporting Period Start",
      aliases: [
        "reporting period from",
        "period start",
        "from date",
        "statement period start",
      ],
      kind: "date",
    },
    {
      label: "Reporting Period End",
      aliases: [
        "reporting period to",
        "period end",
        "to date",
        "statement period end",
      ],
      kind: "date",
    },
    {
      label: "Sales for the year",
      aliases: [
        "sales",
        "annual sales",
        "gross sales",
        "gross annual sales",
        "gross sales annual pkr",
        "gross revenue",
        "gross revenue annual pkr",
        "total sales",
        "sales for the year pkr",
      ],
      kind: "positive_amount",
    },
    // 16-Oct: the Business profit step takes these from the Books (see
    // lib/tax/business-books-figures.ts), so the review must give each one.
    ...BUSINESS_BOOKS_FIGURE_LABELS_AFTER_SALES.map(
      (label): Requirement => ({ label, kind: "amount", booksFigure: true }),
    ),
  ],
  business_balance_sheet: [
    { label: "Business Name" },
    { label: "Tax Year", kind: "year" },
    { label: "Balance Sheet Date", kind: "date" },
    { label: "Currency", kind: "currency" },
    { label: BALANCE_SHEET_TOTAL_ASSETS, kind: "amount" },
    { label: BALANCE_SHEET_TOTAL_EQUITY_LIABILITIES, kind: "amount" },
    ...[...BALANCE_SHEET_ASSET_ROWS, ...BALANCE_SHEET_LIABILITY_ROWS].map(
      (label): Requirement => ({ label, kind: "amount", balanceRow: true }),
    ),
  ],
};

/** A Balance Sheet amount in paisa, or null when it is not one valid amount. */
function balanceSheetPaisa(fields: Field[] | undefined, label: string) {
  const found = (fields ?? []).filter(
    (field) => normalize(field.label) === normalize(label),
  );
  if (found.length !== 1) return null;
  const value = found[0].value;
  if (value === null || value === undefined || typeof value === "boolean")
    return null;
  const text = String(value).trim().replace(/,/g, "");
  if (!text) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100);
}

const rupeesFromPaisa = (paisa: number) =>
  `Rs ${(paisa / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/**
 * The rows must add up to the totals (16-Oct): the 10 asset rows to Total
 * Assets, Owner Capital and the 3 liability rows to Total Equity and
 * Liabilities, and the two totals must be equal. Checked once every one of
 * these amounts is a valid number (a blank or wrong one has its own error).
 */
export function balanceSheetTotalsErrors(fields: Field[] | undefined): string[] {
  const assetRows = BALANCE_SHEET_ASSET_ROWS.map((label) =>
    balanceSheetPaisa(fields, label),
  );
  const liabilityRows = BALANCE_SHEET_LIABILITY_ROWS.map((label) =>
    balanceSheetPaisa(fields, label),
  );
  const totalAssets = balanceSheetPaisa(fields, BALANCE_SHEET_TOTAL_ASSETS);
  const totalEquityLiabilities = balanceSheetPaisa(
    fields,
    BALANCE_SHEET_TOTAL_EQUITY_LIABILITIES,
  );
  if (totalAssets === null || totalEquityLiabilities === null) return [];
  if ([...assetRows, ...liabilityRows].some((value) => value === null))
    return [];
  const add = (values: Array<number | null>) =>
    values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const assets = add(assetRows);
  const liabilities = add(liabilityRows);
  const errors: string[] = [];
  if (assets !== totalAssets)
    errors.push(
      `Balance Sheet assets do not add up: the ${BALANCE_SHEET_ASSET_ROWS.length} asset rows add up to ${rupeesFromPaisa(assets)}, but Total Assets is ${rupeesFromPaisa(totalAssets)} (difference ${rupeesFromPaisa(Math.abs(assets - totalAssets))}). Correct the rows or the total.`,
    );
  if (liabilities !== totalEquityLiabilities)
    errors.push(
      `Balance Sheet capital and liabilities do not add up: Owner Capital and the ${BALANCE_SHEET_LIABILITY_ROWS.length - 1} liability rows add up to ${rupeesFromPaisa(liabilities)}, but Total Equity and Liabilities is ${rupeesFromPaisa(totalEquityLiabilities)} (difference ${rupeesFromPaisa(Math.abs(liabilities - totalEquityLiabilities))}). Correct the rows or the total.`,
    );
  if (totalAssets !== totalEquityLiabilities)
    errors.push(
      `Total Assets (${rupeesFromPaisa(totalAssets)}) and Total Equity and Liabilities (${rupeesFromPaisa(totalEquityLiabilities)}) must be equal on a Balance Sheet.`,
    );
  return errors;
}

/** A value the reviewer has not entered: null, undefined or an empty string. */
const isBlankReviewValue = (value: unknown) =>
  value === null || value === undefined || String(value).trim() === "";

/**
 * Review fields with the balance-sheet rows that the printed totals PROVE nil
 * filled in as 0.
 *
 * Reported 27 Oct 2026: a Balance Sheet whose whole business capital sat in the
 * bank still opened with three red rows ("Business Motor Vehicles is required:
 * ... or 0 if the business has none") and the reviewer had to type three zeros
 * to reach Save & Approve Map. Same class as the derived nil 7029 and the nil
 * Business Books figures: the zeros are provable, not guesses.
 *
 * The proof is the sheet's own arithmetic, and nothing weaker:
 *  - both totals are present, valid and EQUAL (a Balance Sheet balances);
 *  - the rows the document DID print, on a side, already add up to that side's
 *    total. Only then is a blank row on that side necessarily 0.
 * If a side does not add up, nothing on it is filled and the existing
 * required/do-not-add-up errors stay exactly as they were.
 *
 * Deliberately conservative: a stated figure is never overwritten (a reviewed
 * 0 keeps its own provenance), a duplicated label or a value that is present
 * but unreadable is left alone (it has its own error), each filled row carries
 * confidence 0.9 and `derived: true`, a row the extraction omitted entirely
 * still gets a box, and any other payload is returned untouched.
 */
export function withDerivedNilBalanceSheetRows<
  T extends { label?: unknown; value?: unknown; confidence?: unknown },
>(fields: T[] | undefined): T[] {
  const list = Array.isArray(fields) ? fields : [];
  const copies = (label: string) =>
    list.filter((field) => normalize(field.label) === normalize(label));
  if (copies(BALANCE_SHEET_TOTAL_ASSETS).length !== 1) return list;
  if (copies(BALANCE_SHEET_TOTAL_EQUITY_LIABILITIES).length !== 1) return list;
  const totals = list as Field[];
  const totalAssets = balanceSheetPaisa(totals, BALANCE_SHEET_TOTAL_ASSETS);
  const totalEquityLiabilities = balanceSheetPaisa(
    totals,
    BALANCE_SHEET_TOTAL_EQUITY_LIABILITIES,
  );
  if (totalAssets === null || totalEquityLiabilities === null) return list;
  if (totalAssets !== totalEquityLiabilities) return list;

  const fill = new Set<string>();
  const sides: Array<[readonly string[], number]> = [
    [BALANCE_SHEET_ASSET_ROWS, totalAssets],
    [BALANCE_SHEET_LIABILITY_ROWS, totalEquityLiabilities],
  ];
  for (const [labels, total] of sides) {
    // A duplicated row is its own error; never derive around it.
    if (labels.some((label) => copies(label).length > 1)) continue;
    const blank = labels.filter((label) => {
      const found = copies(label);
      return found.length === 0 || isBlankReviewValue(found[0].value);
    });
    if (!blank.length) continue;
    const printed = labels.reduce(
      (sum, label) => sum + (balanceSheetPaisa(totals, label) ?? 0),
      0,
    );
    if (printed !== total) continue;
    for (const label of blank) fill.add(normalize(label));
  }
  if (!fill.size) return list;

  const out: T[] = list.map((field) => {
    const key = normalize(field.label);
    if (!fill.has(key) || !isBlankReviewValue(field.value)) return field;
    return { ...field, value: 0, confidence: 0.9, derived: true } as T;
  });
  for (const [labels] of sides)
    for (const label of labels) {
      if (!fill.has(normalize(label))) continue;
      if (out.some((field) => normalize(field.label) === normalize(label)))
        continue;
      out.push({ label, value: 0, confidence: 0.9, derived: true } as unknown as T);
    }
  return out;
}

function matches(requirement: Requirement, label: unknown) {
  if (requirement.label === "IBAN") return isBankStatementIbanLabel(label);
  return [requirement.label, ...(requirement.aliases ?? [])].some(
    (alias) => normalize(alias) === normalize(label),
  );
}
export function documentReviewFieldRequirement(
  documentType: string,
  label: unknown,
) {
  return REQUIREMENTS[documentType]?.find((requirement) =>
    matches(requirement, label),
  );
}
export function isDocumentReviewRequiredField(
  documentType: string,
  label: unknown,
  fields?: Field[],
) {
  if (
    documentType === "business_books" &&
    isBusinessPurchaseBasisField(label) &&
    businessPurchaseBasisRequired(fields)
  )
    return true;
  if (documentType === "pension_statement") return isPensionStatementRequiredField(label, fields);
  return documentType === "salary_certificate"
    ? isSalaryCertificateRequiredField(String(label ?? ""))
    : Boolean(documentReviewFieldRequirement(documentType, label));
}
export function ensureRequiredDocumentReviewFields(
  documentType: string,
  raw: unknown,
): unknown {
  if (documentType === "pension_statement") return ensurePensionStatementReviewFields(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const payload = raw as Record<string, unknown>;
  const fields: Field[] = Array.isArray(payload.fields)
    ? payload.fields
        .filter(
          (field) =>
            field && typeof field === "object" && !Array.isArray(field),
        )
        .map((field) => ({ ...field }))
    : [];
  for (const requirement of REQUIREMENTS[documentType] ?? []) {
    if (!fields.some((field) => matches(requirement, field.label)))
      fields.push({ label: requirement.label, value: null, confidence: 0 });
  }
  return { ...payload, fields };
}
export function getDocumentReviewRequiredErrors(
  documentType: string,
  fields: Field[] | undefined,
  taxYear?: number,
): string[] {
  if (documentType === "pension_statement") return getPensionStatementReviewErrors(fields, taxYear);
  if (documentType === "previous_return") return getPreviousReturnReviewErrors(fields, taxYear);
  const errors: string[] = [];
  const requirements: Requirement[] = [...(REQUIREMENTS[documentType] ?? [])];
  if (
    documentType === "business_books" &&
    businessPurchaseBasisRequired(fields)
  )
    requirements.push({
      label: BUSINESS_SCHEDULE_LABELS.purchaseBasis,
      kind: "boolean",
    });
  for (const requirement of requirements) {
    const found = (fields ?? []).filter((field) =>
      matches(requirement, field.label),
    );
    if (found.length > 1) {
      errors.push(
        `${requirement.label}: duplicate fields; review the extraction.`,
      );
      continue;
    }
    const value = found[0]?.value;
    if (value === null || value === undefined || String(value).trim() === "") {
      errors.push(
        requirement.balanceRow
          ? `${requirement.label} is required: type the figure from your Balance Sheet, or 0 if the business has none.`
          : requirement.booksFigure
            ? `${requirement.label} is required: type the figure from your Business Books, or 0 if the business has none.`
            : `${requirement.label} is required. Enter it manually from your records if it was not extracted.`,
      );
      continue;
    }
    const text = String(value).trim();
    if (requirement.kind === "boolean") {
      if (parseBusinessPurchaseBasis(value) === null)
        errors.push(
          `${requirement.label}: choose Yes or No from the purchase-specific source; do not use the sales tax basis.`,
        );
    } else if (requirement.label === "IBAN") {
      const result = validateBankStatementIban(found);
      if (!result.valid) errors.push(`IBAN: ${result.error}`);
    } else if (
      requirement.kind === "amount" ||
      requirement.kind === "positive_amount"
    ) {
      const amount = Number(text.replace(/,/g, ""));
      if (
        typeof value === "boolean" ||
        !Number.isFinite(amount) ||
        (documentType !== "bank_statement" && amount < 0) ||
        (requirement.kind === "positive_amount" && amount <= 0)
      )
        errors.push(
          `${requirement.label}: enter a valid ${requirement.kind === "positive_amount" ? "positive " : ""}amount.`,
        );
    } else if (requirement.kind === "date") {
      const parsed = parseTaxpayerDateOfBirth(value);
      if (!parsed) errors.push(`${requirement.label}: enter a valid date.`);
      else if (
        documentType === "business_books" &&
        taxYear &&
        parsed.toISOString().slice(0, 10) !==
          (requirement.label.endsWith("Start")
            ? `${taxYear - 1}-07-01`
            : `${taxYear}-06-30`)
      )
        errors.push(
          `${requirement.label} must cover the full normal TY${taxYear}.`,
        );
      else if (
        documentType === "business_balance_sheet" &&
        taxYear &&
        parsed.toISOString().slice(0, 10) !== `${taxYear}-06-30`
      )
        errors.push(`Balance Sheet Date must be ${taxYear}-06-30.`);
    } else if (
      requirement.kind === "cnic" &&
      text.replace(/[^0-9]/g, "").length !== 13
    ) {
      errors.push("CNIC Number must contain exactly 13 digits.");
    } else if (
      requirement.kind === "year" &&
      (!/^\d{4}$/.test(text) ||
        (taxYear !== undefined && Number(text) !== taxYear))
    ) {
      errors.push(`Tax Year must be ${taxYear ?? "a four-digit year"}.`);
    } else if (
      requirement.kind === "currency" &&
      (!/^[A-Za-z]{3}$/.test(text) ||
        (documentType.startsWith("business_") && text.toUpperCase() !== "PKR"))
    ) {
      errors.push(
        `Currency must be ${documentType.startsWith("business_") ? "PKR" : "a three-letter currency code"}.`,
      );
    }
  }
  if (documentType === "business_balance_sheet")
    errors.push(...balanceSheetTotalsErrors(fields));
  return errors;
}

export function storedDocumentReviewRequiredErrors(
  documentType: string,
  extractedData: string | null | undefined,
  taxYear?: number,
) {
  if (!REQUIREMENTS[documentType] && documentType !== "pension_statement") return [];
  try {
    const payload = extractedData ? JSON.parse(extractedData) : null;
    return getDocumentReviewRequiredErrors(
      documentType,
      Array.isArray(payload?.fields) ? payload.fields : [],
      taxYear,
    );
  } catch {
    return [
      "Saved extraction is unreadable. Re-extract or replace this document.",
    ];
  }
}
