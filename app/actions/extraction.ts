"use server";
import { BUSINESS_BOOKS_ANNUAL_LABELS } from "@/lib/tax/business-books-annual-labels";
import { hasStructuredBusinessBooksEvidence, missingBusinessAnnualLabels, recoverMissingBusinessAnnualFields, businessAnnualRecoveryPrompt } from "@/lib/tax/business-books-extraction";
import { BUSINESS_EVIDENCE_PROMPT } from "@/lib/tax/business-extraction-prompt";

import {
  isMyselfBusinessBankFlow,
  isSingleFreelancerServicesFiling,
} from "@/lib/tax/business-bank-categories";
import { parseServicesInvoiceSummaryFields } from "@/lib/tax/services-income-evidence";
import { ensurePensionStatementReviewFields, readPensionStatementFacts, pensionProfileErrors } from "@/lib/tax/pension-statement-fields";
import { invalidatePensionCalculation, invalidatePensionProfileFilings } from "@/lib/tax/pension-invalidation";
import { sumMoney } from "@/lib/money";
import { normalizeLedgerCategory } from "@/lib/tax/withholding-sources";
import {
  ensureBusinessScheduleReviewFields,
  BUSINESS_SCHEDULE_LABELS,
  businessPurchaseBasisRequired,
  isBusinessPurchaseBasisField,
  parseBusinessPurchaseBasis,
  readBusinessPurchaseBasisEvidence,
  applyBusinessPurchaseBasisEvidence,
  readBusinessBooksAnnual,
} from "@/lib/tax/business-schedule-fields";
import {
  businessDetailsMatchBooks,
  withBusinessBooksValues,
} from "@/lib/tax/business-books-figures";
import {
  TY2026_BUSINESS_PROFIT_SUBCATEGORY,
  parsePersistedSelectionUserDetails,
} from "@/lib/tax/rules/ty2026/subcategories";

import {
  ensureBusinessBalanceReviewFields,
  readBusinessBalanceSheet,
  BUSINESS_BALANCE_LABELS,
  invalidateBusinessBalancePackets,
} from "@/lib/tax/business-filing";
import {
  ensureRequiredDocumentReviewFields,
  getDocumentReviewRequiredErrors,
  storedDocumentReviewRequiredErrors,
} from "@/lib/tax/document-review-required";
import {
  parsePreviousReturnFields,
  previousReturnCnicMismatch,
} from "@/lib/tax/previous-return-fields";
import {
  applyPreviousReturnTextParse,
  parseIrisPreviousReturnText,
} from "@/lib/tax/previous-return-text";
import { readFile } from "fs/promises";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getServerSession } from "next-auth/next";
import { revalidatePath } from "next/cache";

import { authOptions } from "@/lib/auth";
import { extractStructuredBankDocumentAction } from "@/app/actions/bank-parser";
import { createNotification } from "@/app/actions/notifications";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";
import { parseTaxpayerDateOfBirth } from "@/lib/tax/taxpayer-age";
import {
  CARRY_FORWARD_DOCUMENT_TYPES,
  formatCnicInput,
  formatCnicNumber,
  normalizeIdentityName,
  planCnicProfileUpdate,
  planIdentityCarryForward,
  readCnicValidity,
} from "@/lib/tax/cnic-profile";
import { validateTaxYearStatement } from "@/lib/tax/tax-year-period";
import {
  DOCUMENT_EXTRACTION_LEASE_MS,
  isDocumentExtractionLeaseStale,
} from "@/lib/tax/document-extraction-state";
import {
  bankStatementIbanValue,
  ensureBankStatementReviewFields,
} from "@/lib/tax/bank-statement-fields";
import { validatePakistaniIban } from "@/lib/tax/iban";
import {
  ensureSalaryCertificateReviewFields,
  extractSalaryCertificateEmployers,
  parseSalaryCertificateAmount,
  planSalaryCertificateEmployerUpdate,
  salaryCertificateFieldValue,
  checkSalaryCertificateTaxYear,
} from "@/lib/tax/salary-certificate-fields";
import {
  businessListFieldErrors,
  ensureBusinessFactReviewFields,
  normalizeBusinessListFieldsForStorage,
  presentBusinessListFields,
} from "@/lib/tax/business-list-fields";

/** Adds the visible blank placeholders a document type must have for review. */
function ensureReviewFields(documentType: string, extracted: unknown): unknown {
  let review = extracted;
  if (documentType === "pension_statement")
    review = ensurePensionStatementReviewFields(extracted);
  if (documentType === "salary_certificate")
    review = ensureSalaryCertificateReviewFields(extracted);
  if (documentType === "bank_statement")
    review = ensureBankStatementReviewFields(extracted);
  if (documentType === "business_balance_sheet")
    review = ensureBusinessBalanceReviewFields(extracted);
  if (documentType === "business_books")
    review = ensureBusinessScheduleReviewFields(extracted);
  if (documentType === "business_support")
    review = ensureBusinessFactReviewFields(review);
  return ensureRequiredDocumentReviewFields(documentType, review);
}

const GEMINI_SUPPORTED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

const EXTRACTION_PROMPT = `You are extracting structured data from a Pakistani tax document.
Return only valid JSON. Do not include markdown fences or commentary.
Use this exact shape. Only the pension review-field instructions below may add the sourceEvidence property to the three specified field objects:
{
  "documentType": "string",
  "fields": [
    {
      "label": "string",
      "value": "string or number or boolean or null",
      "confidence": "number between 0 and 1"
    }
  ],
  "transactions": [
    {
      "date": "string or null",
      "description": "string",
      "debit": "number or null",
      "credit": "number or null",
      "balance": "number or null",
      "confidence": "number between 0 and 1"
    }
  ],
  "notes": ["string"]
}
For a bank statement, always return separate fields labelled exactly "Bank Name", "Account Label", "Account Number", "Currency", "IBAN", "Opening Balance", "Closing Balance", "Statement Period Start", and "Statement Period End". "IBAN" is the account's 24-character Pakistani IBAN (starts with PK) exactly as printed, often in the statement header; if no IBAN is printed return null, and never build one from the account number. Never combine the statement dates into one field: read the start and end dates from the statement header and return each as ISO YYYY-MM-DD. Extract every visible transaction row from the statement table. Do not include opening-balance or closing-balance marker rows as transactions; those balances belong in fields. Do not invent rows. Return transaction dates as ISO YYYY-MM-DD whenever possible. Keep descriptions and currency amounts exactly as shown in the document.
For a CNIC, always return separate fields labelled exactly "CNIC Number", "Name", "Father Name", "Date of Birth" and "Expiry Date", plus "Address" when the card prints one. Return "Date of Birth" and "Expiry Date" as ISO YYYY-MM-DD. Read the date of birth from the "Date of Birth" line only: never use the issue date or the expiry date for it, and never guess a date of birth that is not printed on the card. For "Expiry Date" return the card's own validity/expiry line ("Valid Upto", "Expiry", "Date of Expiry"), or null when the card prints none — never infer one from the issue date.
For a business balance sheet, use these exact separate field labels: ${Object.values(BUSINESS_BALANCE_LABELS).join(", ")}. Use PKR closing balances only when printed. Balance Sheet Date must be YYYY-MM-DD; do not infer Tax Year, currency, business identity, zero amounts, totals, or missing categories. Keep unknown values null. Never classify business bank balance as business cash. Never combine total assets with individual asset amounts. For other details preserve additional optional fields and notes.
For a pension statement, extract printed facts only: annual gross pension, annual medical allowance, annual net pension payable, actual annual pension tax deducted, Tax Year, Date of Birth and Pensioner CNIC as separate facts. Use exact labels "Gross Pension (Annual PKR)", "Medical Allowance (Annual PKR)", "Net Pension Payable (Annual PKR)", "Pension Tax Deducted (Annual PKR)", "Tax Year", "Date of Birth" and "Pensioner CNIC". Preserve other printed details as optional fields, including monthly pension, pensioner name, PPO number and reporting period. Use printed PKR amounts only; never convert foreign currency. If another currency is printed, preserve a separate Currency field and leave PKR amounts null for review. Never confuse monthly and annual columns, gross and net, or deductions with tax chargeable. Never annualize a monthly number when no annual total is printed. Return each canonical annual fact once; repeated identical totals are not separate fields. If printed totals conflict, return null and describe the conflict for human review rather than picking an amount. Never infer missing tax deducted as zero: return null with confidence 0 when it is not stated. Do not request, generate or add "Approved Pension Amount for Tax (Annual PKR)", "Pension Withholding Already in Tax Ledger (Annual PKR)" or "Pension Tax Base Review Note" as normal statement fields: they are conditional HUMAN/app decisions, not required PDF facts. For backward compatibility only, if the original file explicitly prints one of those separately labelled review values, it may be copied as unapproved suggestions with an extra string property "sourceEvidence" containing the exact printed label and exact printed value, including the entire printed review-note paragraph. Never infer, calculate or invent the approved tax base, allowance treatment, ledger overlap or review note from gross/net amounts or bank receipts. If no exact labelled review value is printed, omit that reviewer field; if it is unclear or conflicting, return null with confidence 0 and no sourceEvidence. An explicit printed 0 may be copied; missing is never 0. Quoted text does not verify any real TAX_PAYMENT ledger or prove human approval. Do not treat medical allowance as automatically taxable or exempt. Return printed dates as ISO YYYY-MM-DD; never overwrite the taxpayer profile from this document.
For a salary certificate, always return separate required fields labelled exactly "Gross Salary (Annual PKR)", "Tax Deducted u/s 149 (Annual PKR)", "Employer Name (as registered with FBR)" and "Tax Year". "Tax Year" is the four-digit tax year the certificate is for (for example 2026 for July 2025 to June 2026); when only the salary period is printed, the tax year is the year in which that period ends; return null when neither is printed. The employer name is the company's full legal name exactly as printed on the certificate letterhead or body (for example "ACME (PRIVATE) LIMITED"); return null when it is not printed. Return the employer NTN, when printed, as a separate optional field labelled "Employer NTN". Use annual amounts explicitly stated on the certificate. If a value is not stated or cannot be read, return null; never infer gross salary from net bank deposits and never assume missing tax withheld is zero. Also preserve other tax-relevant details as separate optional fields when printed, including employee name/ID, salary period, basic pay, allowances, bonuses, benefits/perquisites, exempt or taxable components, and net pay. Do not invent missing details, combine separate components, or annualize monthly amounts unless the certificate explicitly states the annual total.`;

type DocumentSlotRule = {
  label: string;
  aliases: string[];
  fieldSignals: string[];
  minimumSignals: number;
};

const DOCUMENT_SLOT_RULES: Record<string, DocumentSlotRule> = {
  cnic: {
    label: "CNIC copy",
    aliases: ["cnic", "identity card", "national identity card"],
    fieldSignals: ["cnic", "identity number", "father name", "date of birth"],
    minimumSignals: 2,
  },
  bank_statement: {
    label: "bank statement",
    aliases: ["bank statement", "account statement"],
    fieldSignals: [
      "bank name",
      "account title",
      "account number",
      "iban",
      "opening balance",
      "closing balance",
      "transaction",
    ],
    minimumSignals: 2,
  },
  salary_certificate: {
    label: "salary certificate",
    aliases: ["salary certificate", "salary slip", "pay slip", "payslip"],
    fieldSignals: ["salary", "gross salary", "tax deducted", "employer"],
    minimumSignals: 2,
  },
  bank_certificate: {
    label: "bank profit certificate",
    aliases: [
      "bank profit certificate",
      "profit certificate",
      "profit statement",
    ],
    fieldSignals: ["bank profit", "profit", "profit rate", "tax deducted"],
    minimumSignals: 2,
  },
  previous_return: {
    label: "previous year tax return printed from FBR IRIS",
    aliases: ["previous return", "previous year return", "return of income", "114(1)", "wealth statement", "116(2)"],
    fieldSignals: ["net assets", "total assets", "wealth statement", "registration no", "tax year"],
    minimumSignals: 2,
  },
  pension_statement: {
    label: "pension statement",
    aliases: ["pension statement", "pension certificate"],
    fieldSignals: ["pension", "pensioner", "monthly pension"],
    minimumSignals: 1,
  },
  rent_agreement: {
    label: "rent agreement or receipts",
    aliases: ["rent agreement", "rental receipt", "lease agreement"],
    fieldSignals: ["rent", "landlord", "tenant", "property"],
    minimumSignals: 2,
  },
  invoice_summary: {
    label: "invoices or service income summary",
    aliases: ["invoice", "service income summary", "freelance invoice"],
    fieldSignals: ["invoice", "client", "service", "quantity"],
    minimumSignals: 2,
  },
  dividend_certificate: {
    label: "dividend certificate",
    aliases: ["dividend certificate", "dividend statement"],
    fieldSignals: ["dividend", "shares", "withholding"],
    minimumSignals: 2,
  },
  cgt_statement: {
    label: "capital gains statement",
    aliases: ["capital gains statement", "cgt statement"],
    fieldSignals: ["capital gain", "sale price", "purchase price", "shares"],
    minimumSignals: 2,
  },
  business_support: { label: "business supporting profile or schedule", aliases: ["business_support", "business profile", "business support", "business registration", "supporting schedule"], fieldSignals: ["business", "activity", "brand", "bank", "depreciation", "tax"], minimumSignals: 1 },
  business_balance_sheet: {
    label: "business balance sheet",
    aliases: ["balance sheet", "statement of financial position"],
    fieldSignals: ["assets", "liabilities", "capital", "equity"],
    minimumSignals: 2,
  },
  business_books: {
    label: "business books or sales records",
    aliases: ["business books", "sales records", "business record"],
    fieldSignals: ["sales", "revenue", "expense", "profit"],
    minimumSignals: 2,
  },
  agri_record: {
    label: "agriculture income record",
    aliases: ["agriculture record", "farm income record", "agri record"],
    fieldSignals: ["agriculture", "crop", "farm", "land"],
    minimumSignals: 2,
  },
  foreign_asset_statement: {
    label: "foreign asset or income statement",
    aliases: [
      "foreign asset statement",
      "foreign income statement",
      "overseas asset",
    ],
    fieldSignals: ["foreign", "overseas", "country", "asset"],
    minimumSignals: 2,
  },
  aop_company_proof: {
    label: "AOP or company proof",
    aliases: ["aop proof", "company proof", "partnership proof"],
    fieldSignals: ["aop", "partnership", "company", "shareholding"],
    minimumSignals: 2,
  },
  sales_tax_return: {
    label: "sales tax or FED return",
    aliases: ["sales tax return", "fed return", "gst return"],
    fieldSignals: ["sales tax", "fed", "gst", "output tax"],
    minimumSignals: 2,
  },
  other_income_proof: {
    label: "other income proof",
    aliases: ["other income proof", "income receipt", "income proof", "withholding certificate", "tax deduction certificate"],
    fieldSignals: ["income", "receipt", "payer", "amount", "withholding", "statutory section"],
    minimumSignals: 2,
  },
  pseb_certificate: {
    label: "PSEB registration certificate",
    aliases: [
      "pseb certificate",
      "pseb registration certificate",
      "pakistan software export board certificate",
      "pseb registration",
    ],
    fieldSignals: ["pseb", "registration", "software export", "validity", "call center", "it exporter"],
    minimumSignals: 2,
  },
};

function normalizeDocumentText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildExtractionPrompt(documentType: string) {
  const withholdingInstruction = ["bank_statement", "other_income_proof", "advance_tax_evidence", "pseb_certificate"].includes(documentType)
    ? `If this source explicitly contains Services withholding certificate/statement lines, preserve every line in fields using canonical labels "Invoice Number", "Payout Reference", "Withholding Tax (PKR)", "Withholding Section", "Withholding IRIS Code", and "Withholding Evidence Reference" with the SAME numeric row suffix. The evidence reference should identify the printed certificate/page/line. Also preserve printed Payer Name and Income Amount. Extract only facts explicitly printed in this source; missing section, code, amount, invoice/payout reference or certificate reference stays null. A net bank credit, gross-minus-net difference, selected Services category, ATL status or a rate does NOT prove withholding or an IRIS code. Never invent a certificate, copy withholding facts from a separate invoice, or assign tax treatment. Ordinary bank statement lines without explicit withholding facts must not create withholding fields.`
    : "";
  const psebInstruction = documentType === "pseb_certificate"
    ? `For a PSEB (Pakistan Software Export Board) Registration Certificate, extract fields using exact labels "Company / Freelancer Name", "Registration Number", "Issue Date", "Expiry Date", "Category", and "PSEB Registration Status". Date values should be ISO YYYY-MM-DD when printed.`
    : "";
  const rule = DOCUMENT_SLOT_RULES[documentType];
  if (!rule) return `${EXTRACTION_PROMPT}\n${withholdingInstruction}\n${psebInstruction}`;

  const invoiceSummaryInstruction =
    documentType === "invoice_summary"
      ? `For an invoice or Freelancer service-income summary, classify a matching document as documentType "invoice_summary". Extract every invoice row into the "fields" array using these exact labels (add the same row number suffix to all fields for multiple invoices): "Invoice Number", "Invoice Date", "Income Due Date" (only when printed), "Client", "Service Description", "Quantity", "Unit Rate", "Invoice Amount", "Invoice Currency" (ISO 4217 code), "Invoice Exchange Rate to PKR" (only when printed), "FX Evidence Reference" (only when printed), and "TY2026 Subcategory" (only when explicitly stated). If the invoice explicitly prints a PKR amount, use "Invoice Amount (PKR)" and preserve it as PKR; for a foreign-currency invoice preserve its original-currency amount and currency, never convert it yourself. When the document also contains payout evidence, extract separate fields "Payment Status", "Settlement Date", "Settlement Currency", "Settlement Amount", "Settlement Exchange Rate to PKR", "Gross Service Amount (PKR)", "Withholding Tax (PKR)", "Withholding Section", "Withholding IRIS Code", "Platform Fee (PKR)", "Receiving Bank Fee (PKR)", "Net Payout (PKR)", "Payout Reference", and "Payout Evidence Reference" only when printed; also extract "Income Character" only when the document itself states the classification wording. Do not omit a printed platform fee or receiving-bank fee, including a printed zero: preserve the explicit numeric value and the same row-number suffix used for that invoice. Do not infer missing values, accounting method, payment status, FX, fees, withholding, settlement, or receipt date; use null. A summary total may use "Total Invoice Amount" and "Tax Year". Keep the key words Invoice, Client, Service, and Quantity in field labels so the application can validate the slot. Invoice lines are not bank transactions: return an empty "transactions" array for this document type. Do not label an invoice/service summary as a bank statement.`
      : "";

  const previousReturnInstruction =
    documentType === "previous_return"
      ? `For a previous year's filed return printed from FBR IRIS (114(1) Return of Income including the 116(2) Wealth Statement), classify a matching document as documentType "previous_return" and extract these exact labels ONCE each: "Taxpayer Name", "Registration No", "Tax Year", "Total Assets (7019)", "Total Liabilities (7029)", "Net Assets (703001)", and (only when printed) "Cash in Hand (7012)". Taxpayer Name, Registration No and Tax Year come from the return header (Tax Year is four digits, not the due date or the print date). The wealth totals come from the Wealth Statement and Reconciliation of Net Assets sections by their printed codes: take the PRINTED TOTAL rows (7019 / 7029 / 703001) exactly as printed and never add up the detail lines underneath them; if a liabilities total row is absent (the return has none) leave "Total Liabilities (7029)" null. Amounts are whole PKR without commas. Do not use any business Balance Sheet totals (3349/3399) as wealth figures, and do not extract the previous return's own "Net Assets Previous Year" (703002) row. If the wealth sections are not in the document, leave the wealth labels null; the reviewer types them.`
      : "";

  return `${EXTRACTION_PROMPT}

Expected upload slot: ${rule.label}.
${previousReturnInstruction}
${invoiceSummaryInstruction}
${withholdingInstruction}
${psebInstruction}
${["business_books", "business_balance_sheet", "business_support", "bank_statement"].includes(documentType) ? BUSINESS_EVIDENCE_PROMPT : ""}
${documentType === "business_books" ? `For business books / sales records, FIRST extract ALL EIGHT annual profit-input rows using these exact labels: ${Object.values(BUSINESS_BOOKS_ANNUAL_LABELS).join("; ")}. Explicit printed numeric 0 rows must be extracted as 0, but unprinted amounts stay null. Extracting rent/salaries/etc does NOT replace extracting the separately printed aggregate Business expenses row. Then preserve annual sales, other receipts, cost of sales, operating expenses, depreciation, add-backs, prior-year loss and withholding as separate fields when printed. Use separate exact labels "Business Name", "Tax Year", "Currency", "Reporting Period Start", "Reporting Period End", and "Sales for the year". Date values must be ISO YYYY-MM-DD. Keep unprinted values null; the user will review required missing fields. Also extract printed head-wise stock, purchases, direct-cost, operating-expense and other-revenue schedules as separate optional fields, using these canonical labels: ${Object.values(BUSINESS_SCHEDULE_LABELS).join(", ")}. Only populate a label when the source states that fact. Generic Direct Manufacturing Expenses must be Unallocated Direct Expenses, NEVER guessed into fuel/wages/Other Direct Expenses. Generic depreciation must not be labelled tax depreciation. Accounting Depreciation requires explicit accounting/book context. Loss Origin Tax Year must be the explicitly printed loss origin, not this return year. Other Revenue - Scrap Sales requires explicit scrap revenue. Purchases Exclude Sales Tax and FED is a BOOLEAN fact, not a money amount: emit true or false (JSON boolean), including when the document literally prints "Purchases Exclude Sales Tax and FED: true". It must stay null unless separately explicit for purchases; sales-only exclusion is not purchase evidence. Leave missing components null, not zero. Never repeat an aggregate as a component: Other Revenue - Other Receipts Excluding Scrap Sales excludes the separately extracted scrap amount, and Other Indirect Expenses Excluding Bank Charges excludes the separately extracted bank charges. Emit each canonical label once even if its amount is repeated in the document. Personal Expenditure Add-back requires an explicit personal-use/personal-expense reason; do not infer it from the generic disallowed-expense total. An annual sales/expense/profit statement is business_books; do not turn it into a balance sheet merely because it contains inventory cost details.` : ""}
Verify the actual document content against this slot. Do not label a bank statement as a CNIC, or a CNIC as a bank statement. If the uploaded document does not match the expected slot, still return its actual documentType so the application can reject it.`;
}

function validateExtractedDocument(documentType: string, extracted: unknown) {
  const rule = DOCUMENT_SLOT_RULES[documentType];
  if (!rule) return { valid: true as const };

  const payload = extracted as {
    documentType?: unknown;
    fields?: Array<{ label?: unknown }>;
    transactions?: unknown[];
  };
  const declaredType = normalizeDocumentText(payload.documentType);
  const fieldLabels = (payload.fields ?? [])
    .map((field) => normalizeDocumentText(field.label))
    .join(" ");
  const hasTransactions =
    Array.isArray(payload.transactions) && payload.transactions.length > 0;

  const declaredTypeMatches = rule.aliases.some((alias) =>
    declaredType.includes(normalizeDocumentText(alias)),
  );

  // Specific approved-looking P&L structure is meaningful evidence even when
  // its detailed heads are named Rent/Salaries/Utilities rather than "expense".
  // Required annual figures and review/map checks still apply separately.
  if (documentType === "business_books" && hasStructuredBusinessBooksEvidence(extracted)) return {valid:true as const};

  // Count how many expected signals are present in extracted field labels
  const matchingSignals = rule.fieldSignals.filter((signal) =>
    fieldLabels.includes(normalizeDocumentText(signal)),
  ).length;

  // Strict check: field signals must meet minimum, regardless of declared type
  // This prevents uploading a dashboard screenshot as CNIC, etc.
  if (matchingSignals < rule.minimumSignals) {
    // Special case: bank_statement can be validated via transactions presence
    if (documentType === "bank_statement" && hasTransactions) {
      // If we have transactions, allow even if few field signals, as long as declared type matches or signals >=1
      if (declaredTypeMatches || matchingSignals >= 1) {
        return { valid: true as const };
      }
    }

    // If declared type is clearly wrong (e.g., user uploaded bank statement into CNIC slot),
    // we fail even if some signals accidentally match
    const clearlyWrongType =
      declaredType && !declaredTypeMatches && matchingSignals === 0;
    if (clearlyWrongType) {
      return {
        valid: false as const,
        error: `This file looks like a ${String(payload.documentType || "different document")}, not a ${rule.label}. Please upload the correct ${rule.label} for this slot.`,
      };
    }

    return {
      valid: false as const,
      error: `This file does not appear to be a ${rule.label}. Found only ${matchingSignals}/${rule.minimumSignals} expected fields (${rule.fieldSignals.join(", ")}). Upload the correct document for this slot.`,
    };
  }

  // If signals are enough, we pass, but if declared type is explicitly different document, warn
  // e.g., declared as "bank_statement" when expecting "cnic" — still fail if signals just barely meet minimum
  if (!declaredTypeMatches && declaredType) {
    // Check if declared type belongs to another known slot
    const otherSlot = Object.entries(DOCUMENT_SLOT_RULES).find(
      ([key, otherRule]) =>
        key !== documentType &&
        otherRule.aliases.some((a) =>
          declaredType.includes(normalizeDocumentText(a)),
        ),
    );
    if (otherSlot && matchingSignals < rule.minimumSignals + 1) {
      return {
        valid: false as const,
        error: `This file appears to be a ${otherSlot[1].label}, not a ${rule.label}. Upload the correct ${rule.label}.`,
      };
    }
  }

  return { valid: true as const };
}

async function getCurrentUserId() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) throw new Error("Unauthorized");

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!user) throw new Error("User profile not found");
  return user.id;
}

async function getOwnedDraft(draftId: string) {
  const userId = await getCurrentUserId();
  const draft = await prisma.filingDraft.findFirst({
    where: { id: draftId, userId },
    select: { id: true, userId: true, taxYear: true },
  });
  if (!draft) throw new Error("Filing draft not found");
  return draft;
}

async function getOwnedDocument(documentId: string) {
  const userId = await getCurrentUserId();
  const document = await prisma.document.findFirst({
    where: { id: documentId, userId },
  });
  if (!document) throw new Error("Document not found");
  return document;
}

function parseModelJson(text: string) {
  const withoutFence = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new TypeError("Gemini did not return valid JSON");
    }
    return JSON.parse(withoutFence.slice(start, end + 1));
  }
}

/**
 * Identity documents (currently the CNIC) belong to the person, not to a tax year,
 * so a card approved for one filing must not have to be uploaded again for the
 * next one. This copies the already-approved record onto the new draft — the draft
 * keeps its own audit row (packets and evidence refer to a document per filing),
 * while the human does the upload exactly once.
 *
 * It never invents verification: the copy only happens when the profile still
 * carries the CNIC and date of birth that the earlier approval wrote.
 */
/**
 * Read one field back out of a stored extraction payload. Defensive by design: a
 * payload saved by an older version of the extractor simply yields no value, which
 * means "could not check", never "expired".
 */
function extractFieldFromPayload(
  payload: string | null | undefined,
  labels: string[],
): unknown {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as {
      fields?: Array<{ label: string; value: unknown }>;
    };
    return exactFieldValue(parsed?.fields ?? [], labels);
  } catch {
    return null;
  }
}

export async function carryForwardIdentityDocumentsAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const results = [] as {
      documentType: string;
      copied: boolean;
      reason: string;
      sourceTaxYear?: number | null;
      sourceExpiry?: string | null;
    }[];

    for (const documentType of CARRY_FORWARD_DOCUMENT_TYPES) {
      const present = await prisma.document.findFirst({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          documentType,
          extractionStatus: "MAPPED",
        },
        select: { id: true },
      });
      const profile = await prisma.user.findUnique({
        where: { id: draft.userId },
        select: { cnic: true, dateOfBirth: true },
      });
      // Only a card that an operator already approved counts as a source; a file
      // that was uploaded and left unreviewed proves nothing.
      const prior = await prisma.document.findFirst({
        where: {
          userId: draft.userId,
          documentType,
          extractionStatus: "MAPPED",
          filingDraftId: { not: draft.id },
        },
        orderBy: { extractedAt: "desc" },
        include: { filingDraft: { select: { taxYear: true } } },
      });

      // The card is only reusable while it is still valid: one approved in a
      // previous year may have lapsed since, and reusing a lapsed card would carry
      // an invalid identity into a new return.
      const priorValidity = readCnicValidity({
        expiryDate: extractFieldFromPayload(prior?.extractedData, [
          "expiry_date",
          "expiry",
          "valid_upto",
          "valid_until",
          "date_of_expiry",
        ]),
      });

      const plan = planIdentityCarryForward({
        documentType,
        draftAlreadyHasIt: Boolean(present),
        profileVerified: Boolean(profile?.cnic && profile?.dateOfBirth),
        hasPriorUpload: Boolean(prior),
        priorTaxYear: prior?.filingDraft?.taxYear ?? null,
        priorExpired: priorValidity.status === "expired",
        priorExpiry: priorValidity.expiry,
      });

      if (!plan.copy) {
        results.push({
          documentType,
          copied: false,
          reason: plan.reason,
          sourceExpiry: plan.sourceExpiry ?? null,
        });
        continue;
      }

      await prisma.document.create({
        data: {
          filingDraftId: draft.id,
          userId: draft.userId,
          documentType,
          fileName: prior.fileName,
          fileUrl: prior.fileUrl,
          mimeType: prior.mimeType,
          sizeBytes: prior.sizeBytes,
          extractionStatus: "MAPPED",
          extractionProvider: prior.extractionProvider,
          extractedData: prior.extractedData,
          extractedAt: prior.extractedAt,
        },
      });

      results.push({
        documentType,
        copied: true,
        reason: plan.reason,
        sourceTaxYear: plan.sourceTaxYear,
        sourceExpiry: priorValidity.expiry,
      });
    }

    revalidatePath("/tax/new");
    return { success: true, results };
  } catch (error) {
    console.error("Error carrying forward identity documents:", error);
    // Reuse is an optimisation: on any failure the ordinary upload path still works,
    // so this must never block the documents step.
    return { success: false, error: "carry_forward_failed", results: [] };
  }
}

export async function getFilingDocumentsAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const documents = await prisma.document.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        documentType: true,
        fileName: true,
        extractionStatus: true,
        extractionProvider: true,
        extractionStartedAt: true,
        extractionError: true,
        extractedAt: true,
        bankAccountId: true,
        extractedData: true,
      },
    });

    return {
      success: true,
      documents: documents.map(({ extractedData, ...document }) => ({
        ...document,
        reviewRequiredErrors: storedDocumentReviewRequiredErrors(
          document.documentType,
          extractedData,
          draft.taxYear,
        ),
        documentType: document.bankAccountId
          ? `bank_statement:${document.bankAccountId}`
          : document.documentType,
        extractionStartedAt: document.extractionStartedAt
          ? String(document.extractionStartedAt)
          : null,
        extractedAt: document.extractedAt ? String(document.extractedAt) : null,
      })),
    };
  } catch (error) {
    console.error("Error fetching filing documents:", error);
    return { success: false, error: "Failed to fetch filing documents" };
  }
}

export async function getDocumentExtractionAction(documentId: string) {
  try {
    const document = await getOwnedDocument(documentId);
    const extracted = document.extractedData
      ? JSON.parse(document.extractedData)
      : null;
    const reviewReadyExtraction = ensureReviewFields(
      document.documentType,
      extracted,
    );

    return {
      success: true,
      // The browser receives structured business rows, never editable JSON.
      extraction: presentBusinessListFields(reviewReadyExtraction),
      status: document.extractionStatus,
      extractionStartedAt: document.extractionStartedAt
        ? String(document.extractionStartedAt)
        : null,
      extractionError: document.extractionError,
    };
  } catch (error) {
    console.error("Error fetching document extraction:", error);
    return { success: false, error: "Failed to fetch extracted data" };
  }
}

export async function updateDocumentExtractionAction(
  documentId: string,
  extracted: unknown,
) {
  try {
    const document = await getOwnedDocument(documentId);
    const reviewReadyExtraction = ensureReviewFields(
      document.documentType,
      extracted,
    );
    const normalized = normalizeIdentityExtractionPayload(
      document.documentType,
      reviewReadyExtraction,
    );
    if (normalized.error) {
      return { success: false, error: normalized.error };
    }

    const reviewDraft = document.filingDraftId
      ? await prisma.filingDraft.findFirst({
          where: { id: document.filingDraftId, userId: document.userId },
          select: { taxYear: true },
        })
      : null;
    if (document.documentType === "business_books" && !reviewDraft)
      return { success: false, error: "Filing draft not found" };

    // Structured business rows from the browser are canonicalized here, on
    // the server, into the JSON form used by stored reviewed evidence.
    const storage = normalizeBusinessListFieldsForStorage(
      normalized.payload,
      reviewDraft?.taxYear ?? 2026,
    );
    if (storage.errors.length)
      return { success: false, error: storage.errors.join(" ") };
    const normalizedPayload = storage.payload;

    // Required review fields are enforced on the server for every document
    // type that defines them, not only by disabling the browser button.
    const fields = (
      normalizedPayload as {
        fields?: Array<{ label?: unknown; value?: unknown }>;
      }
    )?.fields;
    // Pension statements keep incomplete drafts on save (facts vs tax
    // decisions are validated at approval/calculation instead), matching the
    // pension review policy; every other type enforces required fields here.
    const requiredErrors =
      document.documentType === "pension_statement"
        ? []
        : getDocumentReviewRequiredErrors(
            document.documentType,
            fields,
            reviewDraft?.taxYear,
          );
    if (requiredErrors.length)
      return { success: false, error: requiredErrors.join(" ") };

    if (document.documentType === "pension_statement") {
      if (Array.isArray(fields) && fields.some((field) => typeof field.value === "number" && !Number.isFinite(field.value))) {
        // JSON would turn NaN/Infinity into null and could erase an invalid
        // optional override. Keep incomplete drafts, but never silently coerce it.
        return { success: false, error: "Pension fields cannot contain non-finite numbers. Correct the supplied amount before saving." };
      }
    }

    const businessBankDraft = document.documentType === "bank_statement" && document.filingDraftId ? await prisma.filingDraft.findFirst({where:{id:document.filingDraftId,userId:document.userId},select:{taxYear:true,filerType:true,incomeSources:true}}) : null;
    const declaredPayload = document.extractionProvider === "USER_DECLARED" ? {...(normalizedPayload as Record<string,unknown>),sourceMode:"USER_DECLARED",notes:["Manual declaration; no original source uploaded."]} : normalizedPayload;
    const data = {
      extractedData: JSON.stringify(declaredPayload),
      extractionStatus: "COMPLETED",
      extractionStartedAt: null,
      extractionError: null,
      extractedAt: new Date(),
    };
    if (document.documentType === "pension_statement" && document.filingDraftId) {
      await prisma.$transaction(async (tx) => {
        await tx.document.update({ where: { id: documentId }, data });
        await invalidatePensionCalculation(tx, document.filingDraftId!, document.userId);
      });
    } else if (document.documentType === "invoice_summary" && document.filingDraftId) {
      await prisma.$transaction(async (tx) => {
        await tx.document.update({ where: { id: documentId }, data });
        // Any edited extraction invalidates its old invoice rows and payout links;
        // the user must explicitly approve a fresh map before calculation.
        await tx.servicesInvoiceEvidence.deleteMany({
          where: {
            filingDraftId: document.filingDraftId!,
            userId: document.userId,
            sourceDocumentId: document.id,
          },
        });
        await tx.filingDraft.update({
          where: { id: document.filingDraftId! },
          data: {
            taxableIncome: null,
            taxPayable: null,
            refundDue: null,
            taxCalculationStatus: "NOT_CALCULATED",
            taxRuleSetVersion: null,
            taxCalculationRevision: null,
            packetApprovalConfirmed: false,
            packetApprovalAt: null,
            packetApprovalByUserId: null,
            status: "IN_PROGRESS",
          },
        });
        await invalidateBusinessBalancePackets(
          tx,
          document.filingDraftId!,
          document.userId,
        );
        await tx.fbrConnection.updateMany({
          where: { filingDraftId: document.filingDraftId!, userId: document.userId },
          data: {
            status: "NOT_STARTED",
            agentId: null,
            message: null,
            errorMessage: null,
            lastHeartbeat: null,
            startedAt: null,
            completedAt: null,
          },
        });
      });
      revalidatePath("/tax/new");
    } else if (
      (["business_balance_sheet", "business_books", "business_support"].includes(
        document.documentType,
      ) || (businessBankDraft && isMyselfBusinessBankFlow(businessBankDraft))) &&
      document.filingDraftId
    ) {
      await prisma.$transaction(async (tx) => {
        await tx.document.update({ where: { id: documentId }, data });
        await invalidateBusinessBalancePackets(
          tx,
          document.filingDraftId!,
          document.userId,
        );
      });
    } else {
      await prisma.document.update({ where: { id: documentId }, data });
    }

    return { success: true };
  } catch (error) {
    console.error("Error updating document extraction:", error);
    return { success: false, error: "Failed to save extracted data" };
  }
}

function normalizedLabel(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function fieldValue(
  fields: Array<{ label: string; value: unknown }>,
  labels: string[],
) {
  const wanted = labels.map(normalizedLabel);
  return fields.find((field) => {
    const actual = normalizedLabel(field.label);
    return wanted.some((label) => actual === label || actual.includes(label));
  })?.value;
}

/**
 * `fieldValue` matches on substrings, which is right for synonyms but wrong for
 * identity fields: "father name" CONTAINS "name", so the requested father's name
 * could be stored as the taxpayer's own legal name if the extraction listed them
 * in the other order. Labels the prompt pins exactly are compared exactly.
 */
function exactFieldValue(
  fields: Array<{ label: string; value: unknown }>,
  labels: string[],
) {
  const wanted = labels.map(normalizedLabel);
  return fields.find((field) => wanted.includes(normalizedLabel(field.label)))
    ?.value;
}

function parseExtractedAmount(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeIdentityExtractionPayload(
  documentType: string,
  extracted: unknown,
): { payload: unknown; error?: string } {
  if (documentType !== "cnic" || !extracted || typeof extracted !== "object") {
    return { payload: extracted };
  }

  const payload = extracted as {
    fields?: Array<{
      label?: unknown;
      value?: unknown;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  if (!Array.isArray(payload.fields)) return { payload: extracted };

  const fields = payload.fields.map((field) => {
    const label = normalizedLabel(String(field.label ?? ""));
    const value = field.value;

    if (["cnic_number", "cnic", "identity_number"].includes(label)) {
      const raw = String(value ?? "");
      const digitCount = (raw.match(/[0-9]/g) ?? []).length;
      if (digitCount > 13) {
        return {
          ...field,
          value,
          __validationError:
            "The CNIC number has more than 13 digits. Remove the extra digits and try again.",
        };
      }
      return { ...field, value: formatCnicInput(raw) };
    }

    if (["name", "full_name", "taxpayer_name"].includes(label)) {
      return { ...field, value: normalizeIdentityName(value) };
    }

    if (
      [
        "date_of_birth",
        "dob",
        "birth_date",
        "expiry_date",
        "expiry",
        "valid_upto",
        "valid_until",
        "date_of_expiry",
      ].includes(label)
    ) {
      const parsed = parseTaxpayerDateOfBirth(value);
      if (String(value ?? "").trim() && !parsed) {
        return {
          ...field,
          value,
          __validationError: `The ${String(field.label ?? "identity date")} must be a valid date in YYYY-MM-DD format.`,
        };
      }
      return {
        ...field,
        value: parsed ? parsed.toISOString().slice(0, 10) : "",
      };
    }

    return field;
  });

  const validationError = fields.find(
    (field) => typeof field.__validationError === "string",
  )?.__validationError;
  if (typeof validationError === "string") {
    return { payload: extracted, error: validationError };
  }

  return { payload: { ...payload, fields } };
}

function parseExtractedDate(value: unknown) {
  if (!value) return null;

  const text = String(value).trim();
  const slashDate = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);

  if (slashDate) {
    const first = Number(slashDate[1]);
    const second = Number(slashDate[2]);
    const rawYear = Number(slashDate[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;

    // Pakistani statements commonly use DD/MM/YY. If one side is
    // greater than 12, use the only unambiguous interpretation.
    const month = second > 12 ? first : first > 12 ? second : second;
    const day = second > 12 ? second : first > 12 ? first : first;
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      return date;
    }

    return null;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getTransactionDateRange(transactions: Array<{ date?: unknown }>) {
  const dates = transactions
    .map((transaction) => parseExtractedDate(transaction.date))
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => a.getTime() - b.getTime());

  return {
    start: dates[0] ?? null,
    end: dates[dates.length - 1] ?? null,
  };
}

function isStatementBoundaryRow(description: string) {
  const normalized = description
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();

  return (
    normalized.includes("opening balance") ||
    normalized.includes("closing balance") ||
    normalized.includes("balance brought forward") ||
    normalized.includes("balance carried forward")
  );
}

function normalizeExtractedPayload(
  extracted: unknown,
  expectedDocumentType?: string,
) {
  if (!extracted || typeof extracted !== "object") return extracted;

  const payload = extracted as {
    documentType?: unknown;
    transactions?: Array<{
      date?: unknown;
      description?: unknown;
      debit?: unknown;
      credit?: unknown;
      balance?: unknown;
      confidence?: unknown;
    }>;
  };

  const declaredType = normalizeDocumentText(payload.documentType);
  const invoiceSummaryAliases = [
    "invoice",
    "freelance_invoice",
    "service_income_summary",
  ];
  const declaredAsInvoiceSummary = invoiceSummaryAliases.some((alias) =>
    declaredType.includes(normalizeDocumentText(alias)),
  );

  // Invoice rows are evidence of income, not bank transactions. Some models
  // place summary rows in the generic transaction array; never expose those
  // rows in the document UI as items to map into Bank Intelligence.
  if (expectedDocumentType === "invoice_summary" && declaredAsInvoiceSummary) {
    return { ...payload, transactions: [] };
  }

  if (!Array.isArray(payload.transactions)) return extracted;

  return {
    ...payload,
    transactions: payload.transactions.flatMap((transaction) => {
      const description = String(transaction.description ?? "").trim();
      if (!description || isStatementBoundaryRow(description)) return [];

      const parsedDate = parseExtractedDate(transaction.date);
      return [
        {
          ...transaction,
          date: parsedDate ? parsedDate.toISOString().slice(0, 10) : null,
        },
      ];
    }),
  };
}

function parseExtractedTransactions(
  transactions: Array<{
    date?: unknown;
    description?: unknown;
    debit?: unknown;
    credit?: unknown;
    balance?: unknown;
  }>,
  document: {
    id: string;
    filingDraftId: string;
    userId: string;
    bankStatementId: string;
    bankAccountId: string | null;
  },
) {
  return transactions.flatMap((transaction) => {
    const description = String(transaction.description ?? "").trim();
    if (isStatementBoundaryRow(description)) return [];

    const debit = parseExtractedAmount(transaction.debit);
    const credit = parseExtractedAmount(transaction.credit);
    const balance = parseExtractedAmount(transaction.balance);

    if (!description || (debit === null && credit === null)) return [];

    return [
      {
        filingDraftId: document.filingDraftId,
        bankStatementId: document.bankStatementId,
        bankAccountId: document.bankAccountId,
        userId: document.userId,
        transactionDate: parseExtractedDate(transaction.date),
        description,
        debit,
        credit,
        balance,
        source: "DOCUMENT_EXTRACTION",
        sourceDocumentId: document.id,
      },
    ];
  });
}

/**
 * The statement's IBAN becomes the bank account's IBAN: that is what IRIS lists
 * the account by in the Wealth Statement. The statement is authoritative, so a
 * corrected IBAN replaces an older one; only a clash with ANOTHER account in
 * the same filing is refused (usually the wrong statement under the wrong slot).
 */
async function resolveStatementIban(params: {
  filingDraftId: string;
  userId: string;
  bankAccountId: string;
  value: unknown;
}): Promise<{ ok: boolean; iban: string; error: string }> {
  const validation = validatePakistaniIban(
    params.value as string | null | undefined,
  );
  if (!validation.valid) {
    return {
      ok: false,
      iban: "",
      error: `IBAN is required: ${validation.error}. Enter the IBAN printed on the statement.`,
    };
  }
  const accounts = await prisma.bankAccount.findMany({
    where: { filingDraftId: params.filingDraftId, userId: params.userId },
    select: { id: true, bankName: true, accountLabel: true, iban: true },
  });
  if (!accounts.some((account) => account.id === params.bankAccountId)) {
    return {
      ok: false,
      iban: "",
      error: "The bank account linked to this statement is no longer valid",
    };
  }
  const clash = accounts.find(
    (account) =>
      account.id !== params.bankAccountId &&
      account.iban &&
      validatePakistaniIban(account.iban).iban === validation.iban,
  );
  if (clash) {
    return {
      ok: false,
      iban: "",
      error: `This IBAN already belongs to ${clash.bankName} — ${clash.accountLabel}. Each account has its own IBAN; check that this statement is under the right account.`,
    };
  }
  return { ok: true, iban: validation.iban, error: "" };
}

export async function approveAndMapExtractedDocumentAction(documentId: string) {
  try {
    const document = await getOwnedDocument(documentId);
    if (!document.filingDraftId) {
      return { success: false, error: "Document is not attached to a filing" };
    }

    const extracted = document.extractedData
      ? (JSON.parse(document.extractedData) as {
          fields?: Array<{ label: string; value: unknown }>;
          transactions?: Array<{
            date?: unknown;
            description?: unknown;
            debit?: unknown;
            credit?: unknown;
            balance?: unknown;
          }>;
        })
      : null;
    const fields = extracted?.fields ?? [];
    if (
      [
        "cnic",
        "bank_statement",
        "business_balance_sheet",
        "business_books",
        "previous_return",
      ].includes(document.documentType)
    ) {
      const reviewDraft = await prisma.filingDraft.findFirst({
        where: { id: document.filingDraftId, userId: document.userId },
        select: { taxYear: true },
      });
      if (!reviewDraft)
        return { success: false, error: "Filing draft not found" };
      const requiredErrors = getDocumentReviewRequiredErrors(
        document.documentType,
        fields,
        reviewDraft.taxYear,
      );
      if (requiredErrors.length)
        return { success: false, error: requiredErrors.join(" ") };

      if (document.documentType === "previous_return") {
        // Catch a wrong taxpayer's return HERE, on the Documents step where
        // it is approved — not three steps later on Bank Intelligence. The
        // completeness gate keeps the same check as a backstop for the case
        // where the profile CNIC is only set after this approval.
        const profile = await prisma.user.findUnique({
          where: { id: document.userId },
          select: { cnic: true },
        });
        const snapshot = parsePreviousReturnFields(fields, reviewDraft.taxYear);
        if (previousReturnCnicMismatch(snapshot, profile?.cnic)) {
          return {
            success: false,
            error:
              "Previous Year Tax Return: its Registration No does not match this taxpayer's CNIC on the profile; replace it with this taxpayer's own previous-year return.",
          };
        }
      }
    }

    const listErrors = businessListFieldErrors(fields);
    if (listErrors.length)
      return { success: false, error: listErrors.join(" ") };

    if (document.documentType === "bank_statement") {
      if (!document.bankAccountId) {
        return {
          success: false,
          error:
            "This bank statement is not linked to a selected bank account. Replace it from an account-specific upload slot.",
        };
      }

      const openingBalance = parseExtractedAmount(
        fieldValue(fields, ["opening_balance", "balance_at_1_february"]),
      );
      const closingBalance = parseExtractedAmount(
        fieldValue(fields, ["closing_balance", "balance_at_1_march"]),
      );

      if (openingBalance === null || closingBalance === null) {
        return {
          success: false,
          error:
            "Opening and closing balances were not found in extracted data",
        };
      }

      const draft = await prisma.filingDraft.findUnique({
        where: { id: document.filingDraftId },
        select: { taxYear: true },
      });

      if (!draft) {
        return { success: false, error: "Filing draft not found" };
      }

      const userId = document.userId;
      const bankAccount = await prisma.bankAccount.findFirst({
        where: {
          id: document.bankAccountId,
          filingDraftId: document.filingDraftId,
          userId,
        },
        select: {
          id: true,
          bankName: true,
          accountLabel: true,
          accountNumberMasked: true,
          currency: true,
        },
      });
      if (!bankAccount) {
        return {
          success: false,
          error: "The bank account linked to this statement is no longer valid",
        };
      }

      const extractedBankName = String(
        fieldValue(fields, ["bank_name", "bank"]) ?? "",
      )
        .toLowerCase()
        .replace(/\bbank\b/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      const expectedBankName = bankAccount.bankName
        .toLowerCase()
        .replace(/\bbank\b/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

      if (
        extractedBankName &&
        expectedBankName &&
        !extractedBankName.includes(expectedBankName) &&
        !expectedBankName.includes(extractedBankName)
      ) {
        return {
          success: false,
          error: `This statement appears to be for ${String(fieldValue(fields, ["bank_name", "bank"]))}, but it was uploaded under ${bankAccount.bankName} — ${bankAccount.accountLabel}. Replace it with the correct statement.`,
        };
      }

      // IBAN is required, like the salary certificate's annual amounts.
      const ibanResolution = await resolveStatementIban({
        filingDraftId: document.filingDraftId,
        userId,
        bankAccountId: bankAccount.id,
        value: bankStatementIbanValue(fields),
      });
      if (!ibanResolution.ok) {
        return { success: false, error: ibanResolution.error };
      }

      const accountLabel = bankAccount.accountLabel;
      const existingStatement = await prisma.bankStatement.findFirst({
        where: {
          filingDraftId: document.filingDraftId,
          userId,
          bankAccountId: bankAccount.id,
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true, periodStart: true, periodEnd: true },
      });
      const transactionDateRange = getTransactionDateRange(
        extracted?.transactions ?? [],
      );
      const periodStart =
        parseExtractedDate(
          fieldValue(fields, ["from_date", "statement_period_start"]),
        ) ??
        existingStatement?.periodStart ??
        transactionDateRange.start;
      const periodEnd =
        parseExtractedDate(
          fieldValue(fields, ["to_date", "statement_period_end"]),
        ) ??
        existingStatement?.periodEnd ??
        transactionDateRange.end;
      const currency = bankAccount.currency.trim().toUpperCase();
      const periodValidation = validateTaxYearStatement({
        taxYear: draft.taxYear,
        periodStart,
        periodEnd,
        currency,
      });

      if (!periodValidation.valid) {
        return { success: false, error: periodValidation.error };
      }

      await prisma.bankAccount.update({
        where: { id: bankAccount.id },
        data: { iban: ibanResolution.iban },
      });

      const existing = await prisma.bankStatement.findFirst({
        where: {
          filingDraftId: document.filingDraftId,
          userId,
          bankAccountId: bankAccount.id,
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
      const data = {
        accountLabel,
        accountNumberMasked: bankAccount.accountNumberMasked,
        currency,
        periodStart,
        periodEnd,
        openingBalance,
        closingBalance,
        sourceDocumentId: document.id,
        bankAccountId: bankAccount.id,
      };

      const statement = existing
        ? await prisma.bankStatement.update({
            where: { id: existing.id },
            data,
          })
        : await prisma.bankStatement.create({
            data: {
              ...data,
              filingDraftId: document.filingDraftId,
              userId,
            },
          });

      const extractedTransactions = parseExtractedTransactions(
        extracted?.transactions ?? [],
        {
          id: document.id,
          filingDraftId: document.filingDraftId,
          userId,
          bankStatementId: statement.id,
          bankAccountId: bankAccount.id,
        },
      );

      const previousExtractedTransactions =
        await prisma.bankTransaction.findMany({
          where: {
            filingDraftId: document.filingDraftId,
            userId,
            OR: [
              {
                sourceDocumentId: document.id,
                bankAccountId: bankAccount.id,
              },
              {
                sourceDocumentId: document.id,
                bankAccountId: null,
              },
              {
                bankStatementId: statement.id,
                bankAccountId: bankAccount.id,
                source: "DOCUMENT_EXTRACTION",
              },
              {
                bankStatementId: statement.id,
                bankAccountId: null,
                source: "DOCUMENT_EXTRACTION",
              },
            ],
          },
          select: { id: true },
        });

      await prisma.$transaction(async (tx) => {
        if (previousExtractedTransactions.length > 0) {
          const previousIds = previousExtractedTransactions.map(
            (row) => row.id,
          );
          await tx.ledgerEntry.deleteMany({
            where: {
              filingDraftId: document.filingDraftId,
              userId,
              sourceTransactionId: { in: previousIds },
            },
          });
          await tx.bankTransaction.deleteMany({
            where: { id: { in: previousIds } },
          });
        }

        await tx.bankTransaction.updateMany({
          where: {
            filingDraftId: document.filingDraftId,
            userId,
            bankAccountId: bankAccount.id,
            sourceDocumentId: document.id,
            bankStatementId: null,
          },
          data: {
            bankAccountId: bankAccount.id,
            bankStatementId: statement.id,
          },
        });

        if (extractedTransactions.length > 0) {
          await tx.bankTransaction.createMany({ data: extractedTransactions });
        }

        await tx.document.update({
          where: { id: document.id },
          data: { extractionStatus: "MAPPED", extractionStartedAt: null },
        });
      });

      return {
        success: true,
        mapping: "BANK_STATEMENT",
        statementId: statement.id,
        transactionCount: extractedTransactions.length,
      };
    }

    if (document.documentType === "cnic") {
      // The CNIC is the authoritative source for date of birth, which the
      // Section 149(IA) pension rules need, and it carries the legal name and the
      // address too. What may be written where is decided by `planCnicProfileUpdate`
      // (pure, unit-tested); this branch only reads, applies and reports.
      const extractedDateOfBirth = parseTaxpayerDateOfBirth(
        fieldValue(fields, ["date_of_birth", "dob", "birth_date"]),
      );
      // Whole-label lookup again: "Date of Issue" must not satisfy "Expiry Date".
      const extractedExpiryDate = exactFieldValue(fields, [
        "expiry_date",
        "expiry",
        "valid_upto",
        "valid_until",
        "date_of_expiry",
      ]);

      const profile = await prisma.user.findUnique({
        where: { id: document.userId },
        select: { name: true, cnic: true, dateOfBirth: true, address: true },
      });
      const rawCardCnic = String(
        exactFieldValue(fields, ["cnic_number", "cnic", "identity_number"]) ??
          "",
      ).trim();
      const cardCnicDigits = rawCardCnic.replace(/[^0-9]/g, "");
      if (cardCnicDigits.length !== 13) {
        return {
          success: false,
          error:
            "The CNIC number must contain exactly 13 digits. Correct the extracted value before approving.",
        };
      }
      const formattedCardCnic = formatCnicNumber(cardCnicDigits);
      const cnicTakenByOtherAccount = Boolean(
        await prisma.user.findFirst({
          where: {
            id: { not: document.userId },
            cnic: { in: [cardCnicDigits, formattedCardCnic] },
          },
          select: { id: true },
        }),
      );

      const plan = planCnicProfileUpdate({
        profile: profile ?? {},
        extracted: {
          name: exactFieldValue(fields, ["name", "full_name", "taxpayer_name"]),
          cnic: cardCnicDigits,
          dateOfBirth: extractedDateOfBirth,
          address: exactFieldValue(fields, ["address"]),
          expiryDate: extractedExpiryDate,
        },
        cnicTakenByOtherAccount,
      });

      // A lapsed card is refused before any write, so it can never become the
      // identity of record for a filing.
      if (plan.expired) {
        return {
          success: false,
          error:
            plan.validity.message ??
            "This CNIC has expired, so it cannot be used. Upload the renewed card.",
        };
      }

      if (plan.missingDateOfBirth) {
        return {
          success: false,
          error:
            "Date of birth was not found on this CNIC. Re-run extraction or enter it manually in the taxpayer profile.",
        };
      }

      await prisma.$transaction(async (tx) => {
        if (Object.keys(plan.update).length > 0) {
          await tx.user.update({
            where: { id: document.userId },
            data: plan.update,
          });
          if ("dateOfBirth" in plan.update || "cnic" in plan.update) await invalidatePensionProfileFilings(tx, document.userId);
        }

        await tx.document.update({
          where: { id: document.id },
          data: { extractionStatus: "MAPPED", extractionStartedAt: null },
        });
      });

      revalidatePath("/tax/profile");
      revalidatePath("/tax/dashboard");

      return {
        success: true,
        mapping: "CNIC",
        dateOfBirth: extractedDateOfBirth!.toISOString().slice(0, 10),
        // Summary only: the raw profile row is never handed to the client.
        profilePlan: {
          filled: plan.filled,
          skipped: plan.skipped,
          overwritten: plan.overwritten,
          validity: plan.validity,
        },
      };
    }

    if (document.documentType === "invoice_summary") {
      const draft = await prisma.filingDraft.findFirst({
        where: { id: document.filingDraftId, userId: document.userId },
        select: { taxYear: true, filerType: true, incomeSources: true },
      });
      if (!draft || !isSingleFreelancerServicesFiling(draft)) {
        return {
          success: false,
          error:
            "Invoice mapping supports only TY2026 Myself filings with Services alone, exactly Salary + Services, exactly Pension + Services, exactly Business + Services, or exactly Salary + Business + Services.",
        };
      }
      if (!["COMPLETED", "MAPPED"].includes(document.extractionStatus)) {
        return {
          success: false,
          error:
            "Wait for invoice extraction to complete, then review and approve the invoice rows.",
        };
      }
      const invoiceRows = parseServicesInvoiceSummaryFields(fields);
      if (!invoiceRows.length) {
        return {
          success: false,
          error:
            "No invoice rows were found. Review the extracted labels and enter invoice amount, currency, date, client and service before mapping.",
        };
      }
      const invoiceRowIssues = invoiceRows.flatMap((row) => row.issues);
      if (invoiceRowIssues.length) {
        return { success: false, error: invoiceRowIssues.join(" ") };
      }
      await prisma.$transaction(async (tx) => {
        await tx.servicesInvoiceEvidence.deleteMany({
          where: {
            filingDraftId: document.filingDraftId!,
            userId: document.userId,
            sourceDocumentId: document.id,
          },
        });
        await tx.servicesInvoiceEvidence.createMany({
          data: invoiceRows.map((row) => ({
            filingDraftId: document.filingDraftId!,
            userId: document.userId,
            sourceDocumentId: document.id,
            invoiceKey: row.invoiceKey,
            invoiceNumber: row.invoiceNumber,
            invoiceDate: row.invoiceDate,
            dueDate: row.dueDate,
            clientName: row.clientName,
            serviceDescription: row.serviceDescription,
            quantity: row.quantity,
            unitRate: row.unitRate,
            invoiceAmount: row.invoiceAmount,
            currency: row.currency,
            exchangeRateToPkr: row.exchangeRateToPkr,
            fxEvidenceReference: row.fxEvidenceReference,
            subcategory: row.subcategory,
            paymentStatus: row.paymentStatus,
            evidenceStatus: "DRAFT",
            // The payout block the invoice/payout statement prints is kept with
            // the row, so the Review step can derive every match itself instead
            // of asking the taxpayer to re-type amounts the document already has.
            detailsJson: JSON.stringify({
              extractedInvoiceKey: row.invoiceKey,
              ...(Object.values(row.payout).some(
                (value) => value !== null && value !== undefined && value !== "",
              )
                ? { derivedPayout: row.payout }
                : {}),
            }),
          })),
        });
        await tx.document.update({
          where: { id: document.id },
          data: { extractionStatus: "MAPPED", extractionStartedAt: null },
        });
        await tx.filingDraft.update({
          where: { id: document.filingDraftId! },
          data: {
            taxableIncome: null,
            taxPayable: null,
            refundDue: null,
            taxCalculationStatus: "NOT_CALCULATED",
            taxCalculationRevision: null,
            packetApprovalConfirmed: false,
            packetApprovalAt: null,
            packetApprovalByUserId: null,
            status: "IN_PROGRESS",
          },
        });
        await invalidateBusinessBalancePackets(
          tx,
          document.filingDraftId!,
          document.userId,
        );
      });
      revalidatePath("/tax/new");
      return {
        success: true,
        mapping: "SERVICES_INVOICES",
        invoiceCount: invoiceRows.length,
      };
    }

    if (document.documentType === "business_support") {
      const supportDraft = await prisma.filingDraft.findFirst({where:{id:document.filingDraftId,userId:document.userId},select:{taxYear:true,filerType:true,incomeSources:true}});
      if(!supportDraft || supportDraft.taxYear!==2026 || !isMyselfBusinessBankFlow(supportDraft)) return {success:false,error:"Business supporting evidence currently supports Myself / Business / TY2026 only."};
      if (!["COMPLETED", "MAPPED"].includes(document.extractionStatus) || !fields.length)
        return { success: false, error: "Review the supporting facts before approving." };
      const hasSupportingFact = fields.some((field) =>
        Array.isArray(field.value)
          ? field.value.length > 0
          : field.value !== null &&
            field.value !== undefined &&
            String(field.value).trim() !== "",
      );
      if (!hasSupportingFact)
        return {
          success: false,
          error:
            "Enter or extract at least one supporting business fact before approving this document.",
        };
      await prisma.$transaction(async tx => {
        const claim = await tx.document.updateMany({ where: { id: document.id, userId:document.userId, extractedData:document.extractedData, extractionStatus:document.extractionStatus }, data: { extractionStatus: "MAPPED", extractionStartedAt: null } });
        if(claim.count !== 1) throw new Error("Supporting evidence changed while approving. Reload and review it again.");
        await invalidateBusinessBalancePackets(tx, document.filingDraftId!, document.userId);
      });
      return { success: true, mapping: "BUSINESS_SUPPORT" };
    }

    if (document.documentType === "business_books") {
      const draft = await prisma.filingDraft.findFirst({
        where: { id: document.filingDraftId, userId: document.userId },
        select: { taxYear: true, filerType: true, incomeSources: true },
      });
      if (!draft || !isMyselfBusinessBankFlow(draft)) {
        return {
          success: false,
          error:
            "Business Books mapping supports Myself / Business Income / TY2026 only.",
        };
      }
      if (!["COMPLETED", "MAPPED"].includes(document.extractionStatus)) {
        return {
          success: false,
          error:
            "Wait for Business Books extraction to complete, then review and approve the map.",
        };
      }
      // 16-Oct: the Books are the source of the 8 yearly business figures
      // (lib/tax/business-books-figures.ts). Read them before mapping so a
      // Books the packet could not read is not mapped.
      let booksValues: ReturnType<typeof readBusinessBooksAnnual>;
      try {
        booksValues = readBusinessBooksAnnual(document.extractedData);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      let businessFiguresChanged = false;
      await prisma.$transaction(async (tx) => {
        await tx.document.update({
          where: { id: document.id },
          data: { extractionStatus: "MAPPED", extractionStartedAt: null },
        });
        await invalidateBusinessBalancePackets(
          tx,
          document.filingDraftId!,
          document.userId,
        );
        // Copy the figures into the Business Profit selection. No second
        // income/expense ledger is added; the figures shown on the Business
        // profit step are these, read-only.
        const selection = await tx.filingIncomeSelection.findFirst({
          where: {
            filingDraftId: document.filingDraftId!,
            userId: document.userId,
            source: "business",
            subcategory: TY2026_BUSINESS_PROFIT_SUBCATEGORY,
            status: "SELECTED",
          },
          select: { id: true, detailsJson: true },
        });
        if (!selection) return;
        const saved = parsePersistedSelectionUserDetails(selection.detailsJson);
        if (businessDetailsMatchBooks(saved, booksValues)) return;
        const next = withBusinessBooksValues(saved, booksValues);
        let payload: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(selection.detailsJson);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            payload = parsed as Record<string, unknown>;
        } catch {
          payload = {};
        }
        await tx.filingIncomeSelection.update({
          where: { id: selection.id },
          data: { detailsJson: JSON.stringify({ ...payload, userDetails: next }) },
        });
        // A changed business figure resets the estimate and everything built
        // on it, as a figure edited on the Business profit step does
        // (app/actions/filing.ts updateFilingDraftAction).
        businessFiguresChanged = true;
        await tx.ledgerEntry.deleteMany({
          where: {
            filingDraftId: document.filingDraftId!,
            userId: document.userId,
            source: "RECONCILIATION_AUTO_ADJUSTMENT",
          },
        });
        await tx.filingDraft.update({
          where: { id: document.filingDraftId! },
          data: {
            status: "IN_PROGRESS",
            reconciliationStatus: "UNRESOLVED",
            reconciliationMethod: null,
            reconciliationNote: null,
            openingWealth: null,
            closingWealth: null,
            reconciliationGap: null,
            taxableIncome: null,
            taxPayable: null,
            refundDue: null,
            taxCalculationStatus: "NOT_CALCULATED",
          },
        });
        await tx.fbrConnection.updateMany({
          where: {
            filingDraftId: document.filingDraftId!,
            userId: document.userId,
          },
          data: {
            status: "NOT_STARTED",
            agentId: null,
            message: null,
            errorMessage: null,
            lastHeartbeat: null,
            startedAt: null,
            completedAt: null,
          },
        });
      });
      return {
        success: true,
        mapping: "BUSINESS_BOOKS",
        businessFiguresChanged,
      };
    }

    if (document.documentType === "business_balance_sheet") {
      const draft = await prisma.filingDraft.findFirst({
        where: { id: document.filingDraftId, userId: document.userId },
        select: { taxYear: true, filerType: true, incomeSources: true },
      });
      if (
        !draft ||
        draft.filerType !== "myself" ||
        draft.taxYear !== 2026 ||
        !JSON.parse(draft.incomeSources).includes("business")
      ) {
        return {
          success: false,
          error:
            "Business Balance Sheet mapping supports Myself / Business Income / TY2026 only.",
        };
      }
      let balanceSheet: ReturnType<typeof readBusinessBalanceSheet>;
      try {
        balanceSheet = readBusinessBalanceSheet({ fields }, draft.taxYear);
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Review the Business Balance Sheet amounts and period.",
        };
      }
      await prisma.$transaction(async (tx) => {
        await tx.document.update({
          where: { id: document.id },
          data: { extractionStatus: "MAPPED", extractionStartedAt: null },
        });
        await invalidateBusinessBalancePackets(
          tx,
          document.filingDraftId!,
          document.userId,
        );
      });
      return {
        success: true,
        mapping: "BUSINESS_BALANCE_SHEET",
        businessName: balanceSheet.businessName,
        pending: balanceSheet.gaps,
      };
    }

    if (document.documentType === "pension_statement") {
      try {
        const statement = await prisma.$transaction(async (tx) => {
          const latest = await tx.document.findFirst({
            where: { filingDraftId: document.filingDraftId, userId: document.userId, documentType: "pension_statement" },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          });
          if (!latest || latest.id !== document.id || latest.extractedData !== document.extractedData) throw new Error("Pension statement changed. Reload and review the latest statement before approval.");
          if (!["COMPLETED", "MAPPED"].includes(latest.extractionStatus)) throw new Error("Extract and review the pension statement before approval.");
          const draft = await tx.filingDraft.findUnique({ where: { id: document.filingDraftId! }, select: { taxYear: true } });
          if (!draft) throw new Error("Filing draft not found");
          const reviewed = readPensionStatementFacts(latest.extractedData, draft.taxYear);
          const profile = await tx.user.findUnique({ where: { id: document.userId }, select: { cnic: true, dateOfBirth: true } });
          const identityErrors = pensionProfileErrors(reviewed, profile ?? {});
          if (identityErrors.length) throw new Error(identityErrors.join(" · "));
          const taxEntries = await tx.ledgerEntry.findMany({ where: { filingDraftId: document.filingDraftId!, userId: document.userId }, select: { entryType: true, category: true, amount: true } });
          const taxLedger = sumMoney(taxEntries.filter(e => e.entryType === "EXPENSE" && normalizeLedgerCategory(e.category) === "TAX_PAYMENT").map(e => e.amount));
          if (reviewed.taxAlreadyInLedger !== null && reviewed.taxAlreadyInLedger > taxLedger) throw new Error("Pension withholding already in the tax ledger exceeds current TAX_PAYMENT entries.");
          await tx.document.update({ where: { id: document.id }, data: { extractionStatus: "MAPPED", extractionStartedAt: null } });
          // No new income/cash-ledger row: bank receipts remain wealth evidence.
          await invalidatePensionCalculation(tx, document.filingDraftId!, document.userId);
          return reviewed;
        }, { isolationLevel: "Serializable" });
        return { success: true, mapping: "PENSION", annualPension: statement.approvedAnnual, taxDeducted: statement.taxDeducted };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Review the pension statement before approval." };
      }
    }

    if (document.documentType === "salary_certificate") {
      const salaryFields = fields as Array<{ label: string; value: unknown }>;
      const grossSalary = parseSalaryCertificateAmount(
        salaryCertificateFieldValue(salaryFields, "gross_salary"),
      );
      const taxWithheld = parseSalaryCertificateAmount(
        salaryCertificateFieldValue(salaryFields, "tax_withheld"),
      );

      if (grossSalary === null || grossSalary <= 0) {
        return {
          success: false,
          error:
            "Enter the annual gross salary from the certificate before approving the map.",
        };
      }
      const certificateDraft = await prisma.filingDraft.findUnique({
        where: { id: document.filingDraftId },
        select: { taxYear: true },
      });
      if (!certificateDraft) {
        return { success: false, error: "Filing draft not found" };
      }
      const taxYearCheck = checkSalaryCertificateTaxYear(
        salaryFields,
        certificateDraft.taxYear,
      );
      if (!taxYearCheck.ok) {
        return { success: false, error: taxYearCheck.error };
      }
      if (
        extractSalaryCertificateEmployers(
          JSON.stringify({ fields: salaryFields }),
        ).length === 0
      ) {
        return {
          success: false,
          error:
            "Enter the employer name exactly as it is registered with FBR before approving the map.",
        };
      }
      if (taxWithheld === null || taxWithheld < 0) {
        return {
          success: false,
          error:
            "Enter annual tax deducted u/s 149, or enter 0 after confirming that no salary tax was withheld.",
        };
      }

      // Do not create a second cash-ledger salary row from the certificate.
      // Bank deposits stay in the ledger for wealth reconciliation; the tax
      // calculator and IRIS salary row read gross pay from this mapped document.
      await prisma.$transaction(async (tx) => {
        await tx.ledgerEntry.deleteMany({
          where: {
            filingDraftId: document.filingDraftId,
            userId: document.userId,
            sourceDocumentId: document.id,
          },
        });
        await tx.filingDraft.update({
          where: { id: document.filingDraftId },
          data: {
            taxWithheld,
            taxableIncome: null,
            taxPayable: null,
            refundDue: null,
            taxCalculationStatus: "NOT_CALCULATED",
            packetApprovalConfirmed: false,
            packetApprovalAt: null,
            packetApprovalByUserId: null,
            status: "IN_PROGRESS",
          },
        });
        await tx.document.update({
          where: { id: document.id },
          data: { extractionStatus: "MAPPED", extractionStartedAt: null },
        });
        await tx.filingPacket.updateMany({
          where: {
            filingDraftId: document.filingDraftId,
            userId: document.userId,
            status: { not: "SUPERSEDED" },
          },
          data: { status: "SUPERSEDED", approvalStatus: "SUPERSEDED" },
        });
      });

      return { success: true, mapping: "SALARY", grossSalary, taxWithheld };
    }

    if (
      document.documentType === "other_income_proof" ||
      document.documentType === "advance_tax_evidence" ||
      document.documentType === "pseb_certificate" ||
      document.documentType === "previous_return"
    ) {
      if (!["COMPLETED", "MAPPED"].includes(document.extractionStatus)) {
        return {
          success: false,
          error:
            "Wait for document extraction to complete before approving the map.",
        };
      }

      await prisma.$transaction(async (tx) => {
        await tx.document.update({
          where: { id: document.id },
          data: { extractionStatus: "MAPPED", extractionStartedAt: null },
        });
        if (document.filingDraftId) {
          await tx.filingDraft.update({
            where: { id: document.filingDraftId },
            data: {
              taxableIncome: null,
              taxPayable: null,
              refundDue: null,
              taxCalculationStatus: "NOT_CALCULATED",
              packetApprovalConfirmed: false,
              packetApprovalAt: null,
              packetApprovalByUserId: null,
              status: "IN_PROGRESS",
            },
          });
          await tx.filingPacket.updateMany({
            where: {
              filingDraftId: document.filingDraftId,
              userId: document.userId,
              status: { not: "SUPERSEDED" },
            },
            data: { status: "SUPERSEDED", approvalStatus: "SUPERSEDED" },
          });
          await invalidateBusinessBalancePackets(
            tx,
            document.filingDraftId,
            document.userId,
          );
        }
      });

      revalidatePath("/tax/new");
      return {
        success: true,
        mapping:
          document.documentType === "advance_tax_evidence"
            ? "ADVANCE_TAX_EVIDENCE"
            : document.documentType === "previous_return"
              ? "PREVIOUS_RETURN"
              : "OTHER_INCOME_PROOF",
      };
    }

    return {
      success: false,
      error: "No mapping rule exists for this document type yet",
    };
  } catch (error) {
    console.error("Error mapping extracted document:", error);
    return { success: false, error: "Failed to map extracted document" };
  }
}

async function readPurchaseBasisFromOriginalFile(
  model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>,
  fileBuffer: Buffer,
  mimeType: string,
) {
  const result = await model.generateContent([
    {
      text: 'Read only the printed purchase-specific tax-basis statement from this document. Return JSON {"value": true or false or null, "evidence": "verbatim printed statement"}. The recognized statement is "Purchases Exclude Sales Tax and FED: true/false/yes/no". Do not infer from the sales basis, a net-purchases column title, amounts, or other documents. If this statement is absent or unreadable, return null value and empty evidence. Never invent a quotation.',
    },
    { inlineData: { data: fileBuffer.toString("base64"), mimeType } },
  ]);
  return readBusinessPurchaseBasisEvidence(
    parseModelJson(result.response.text()),
  );
}

/** Repair only a missed, blank fact from the SAME owned original upload.
 * Existing amounts stay unchanged; the recovered fact requires a new Map approval.
 */
export async function recoverBusinessPurchaseBasisAction(documentId: string) {
  try {
    const document = await getOwnedDocument(documentId);
    if (
      document.documentType !== "business_books" ||
      !document.filingDraftId ||
      !["COMPLETED", "MAPPED"].includes(document.extractionStatus)
    )
      return {
        success: false,
        error: "Only extracted Business Books can recover purchase basis.",
      };
    const draft = await prisma.filingDraft.findFirst({
      where: { id: document.filingDraftId, userId: document.userId },
      select: { taxYear: true, filerType: true, incomeSources: true },
    });
    if (!draft || draft.taxYear !== 2026 || !isMyselfBusinessBankFlow(draft))
      return {
        success: false,
        error:
          "Purchase-basis recovery supports Myself / Business Income / TY2026 only.",
      };
    const extracted = ensureReviewFields(
      "business_books",
      JSON.parse(document.extractedData || "null"),
    ) as { fields?: Array<{ label: string; value: unknown }> };
    if (!businessPurchaseBasisRequired(extracted?.fields))
      return {
        success: false,
        error: "No reviewed purchase amount needs recovery.",
      };
    const matches =
      extracted.fields?.filter((field) =>
        isBusinessPurchaseBasisField(field.label),
      ) || [];
    if (
      matches.length !== 1 ||
      parseBusinessPurchaseBasis(matches[0].value) !== null
    )
      return {
        success: false,
        error:
          "Purchase basis is already provided or duplicated; it was not overwritten.",
      };
    const errors = getDocumentReviewRequiredErrors(
      "business_books",
      extracted.fields,
      draft.taxYear,
    ).filter(
      (error) => !error.startsWith(BUSINESS_SCHEDULE_LABELS.purchaseBasis),
    );
    if (errors.length) return { success: false, error: errors.join(" ") };
    if (!GEMINI_SUPPORTED_TYPES.has(document.mimeType))
      return {
        success: false,
        error:
          "Original file type is not supported for purchase-basis recovery.",
      };
    const key = process.env.GEMINI_API_KEY;
    if (!key)
      return {
        success: false,
        error:
          "GEMINI_API_KEY is not configured; no purchase basis was assumed.",
      };
    const limit = consumeRateLimit(
      `business-purchase-basis:${document.userId}`,
      5,
      60 * 1000,
    );
    if (!limit.allowed)
      return {
        success: false,
        error: "Please wait before re-reading the document again.",
      };
    const fileBuffer = await readFile(
      path.join(process.cwd(), "uploads", path.basename(document.fileUrl)),
    );
    const model = new GoogleGenerativeAI(key).getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-3.5-flash",
    });
    const evidence = await readPurchaseBasisFromOriginalFile(
      model,
      fileBuffer,
      document.mimeType,
    );
    if (!evidence)
      return {
        success: false,
        error:
          "No explicit purchase-specific true/false statement was recovered. The field remains unknown; review the original purchase records.",
      };
    const payload = applyBusinessPurchaseBasisEvidence(extracted, evidence);
    await prisma.$transaction(async (tx) => {
      const updated = await tx.document.updateMany({
        where: {
          id: document.id,
          userId: document.userId,
          extractedData: document.extractedData,
          extractionStatus: document.extractionStatus,
        },
        data: {
          extractedData: JSON.stringify(payload),
          extractionStatus: "COMPLETED",
          extractionStartedAt: null,
          extractionError: null,
        },
      });
      if (updated.count !== 1)
        throw new Error("Document changed during recovery; refresh and retry.");
      await invalidateBusinessBalancePackets(
        tx,
        document.filingDraftId!,
        document.userId,
      );
    });
    revalidatePath("/tax/new");
    return {
      success: true,
      extraction: presentBusinessListFields(payload, draft.taxYear),
      status: "COMPLETED",
    };
  } catch (error) {
    console.error("Purchase-basis recovery failed:", error);
    return {
      success: false,
      error:
        "Could not re-read the original Business Books; no purchase basis was assumed.",
    };
  }
}

export async function extractDocumentWithGeminiAction(documentId: string) {
  let documentIdForError: string | null = null;
  let userIdForError: string | null = null;
  let extractionAttemptStartedAt: Date | null = null;

  try {
    const document = await getOwnedDocument(documentId);
    documentIdForError = document.id;
    userIdForError = document.userId;

    if (document.extractionProvider === "USER_DECLARED") return {success:false,error:"User-declared records must be edited and reviewed, not re-extracted as third-party evidence."};
    const extension = path.extname(document.fileName).toLowerCase();
    if (extension === ".csv" || extension === ".xls" || extension === ".xlsx") {
      const parserResult =
        await extractStructuredBankDocumentAction(documentId);
      await createNotification({
        userId: document.userId,
        type: "DOCUMENT_PROCESSING",
        title: parserResult.success
          ? "Bank document processing completed"
          : "Bank document processing failed",
        message: parserResult.success
          ? `${document.fileName} was parsed and is ready for review.`
          : `${document.fileName}: ${parserResult.error ?? "Structured parsing failed"}`,
        link: document.filingDraftId
          ? `/tax/new?draftId=${document.filingDraftId}`
          : "/tax/new",
      });
      return parserResult;
    }

    if (!GEMINI_SUPPORTED_TYPES.has(document.mimeType)) {
      return {
        success: false,
        error:
          "Gemini extraction currently supports PDF, JPG, and PNG documents",
      };
    }

    if (document.extractionStatus === "MAPPED") {
      return {
        success: false,
        code: "ALREADY_MAPPED",
        status: "MAPPED",
        error:
          "This document is already mapped. Replace it to extract a different file.",
      };
    }

    if (document.extractionStatus === "COMPLETED" && document.extractedData) {
      return {
        success: false,
        code: "ALREADY_EXTRACTED",
        status: "COMPLETED",
        error:
          "This document already has saved extraction data. Open Review & map, or replace the file to extract again.",
      };
    }

    if (
      document.extractionStatus === "PROCESSING" &&
      !isDocumentExtractionLeaseStale(
        document.extractionStatus,
        document.extractionStartedAt,
      )
    ) {
      return {
        success: false,
        code: "ALREADY_PROCESSING",
        status: "PROCESSING",
        extractionStartedAt: document.extractionStartedAt
          ? String(document.extractionStartedAt)
          : null,
        error:
          "This document is still being processed. The result will appear here automatically.",
      };
    }

    const extractionLimit = consumeRateLimit(
      `gemini:${document.userId}`,
      10,
      10 * 60 * 1000,
    );
    // TEMP LOCAL-QA BYPASS: keep the extraction throttle in production, but let
    // localhost development repeatedly test parser changes without waiting.
    if (!extractionLimit.allowed && process.env.NODE_ENV === "production") {
      return {
        success: false,
        error: `Too many extraction requests. Try again in ${extractionLimit.retryAfterSeconds} seconds.`,
      };
    }

    // Claim pending/failed work, or take over a lease abandoned by a crashed
    // request. The conditional write keeps two tabs from starting Gemini twice.
    const attemptStartedAt = new Date();
    const staleBefore = new Date(
      attemptStartedAt.getTime() - DOCUMENT_EXTRACTION_LEASE_MS,
    );
    const processingClaim = await prisma.document.updateMany({
      where: {
        id: document.id,
        userId: document.userId,
        OR: [
          { extractionStatus: { in: ["PENDING", "FAILED"] } },
          {
            extractionStatus: "COMPLETED",
            extractedData: null,
          },
          {
            extractionStatus: "PROCESSING",
            extractionStartedAt: null,
          },
          {
            extractionStatus: "PROCESSING",
            extractionStartedAt: { lte: staleBefore },
          },
        ],
      },
      data: {
        extractionStatus: "PROCESSING",
        extractionStartedAt: attemptStartedAt,
        extractionProvider: "gemini",
        extractionError: null,
      },
    });

    if (processingClaim.count === 0) {
      const latest = await getOwnedDocument(document.id);
      if (
        latest.extractionStatus === "PROCESSING" &&
        !isDocumentExtractionLeaseStale(
          latest.extractionStatus,
          latest.extractionStartedAt,
        )
      ) {
        return {
          success: false,
          code: "ALREADY_PROCESSING",
          status: "PROCESSING",
          extractionStartedAt: latest.extractionStartedAt
            ? String(latest.extractionStartedAt)
            : null,
          error:
            "This document is still being processed. The result will appear here automatically.",
        };
      }
      if (latest.extractionStatus === "MAPPED") {
        return {
          success: false,
          code: "ALREADY_MAPPED",
          status: "MAPPED",
          error:
            "This document is already mapped. Replace it to extract a different file.",
        };
      }
      if (latest.extractionStatus === "COMPLETED" && latest.extractedData) {
        return {
          success: false,
          code: "ALREADY_EXTRACTED",
          status: "COMPLETED",
          error:
            "This document already has saved extraction data. Open Review & map, or replace the file to extract again.",
        };
      }
      return {
        success: false,
        error: "Could not start extraction. Please try again.",
      };
    }
    extractionAttemptStartedAt = attemptStartedAt;

    const updateThisAttempt = async (data: {
      extractionStatus: string;
      extractionProvider?: string;
      extractedData?: string;
      extractionError?: string | null;
      extractedAt?: Date | null;
    }) => {
      const update = await prisma.document.updateMany({
        where: {
          id: document.id,
          userId: document.userId,
          extractionStatus: "PROCESSING",
          extractionStartedAt: attemptStartedAt,
        },
        data: {
          ...data,
          extractionStartedAt: null,
        },
      });
      return update.count === 1;
    };

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const saved = await updateThisAttempt({
        extractionStatus: "FAILED",
        extractionProvider: "gemini",
        extractionError: "GEMINI_API_KEY is not configured",
      });
      if (saved) {
        await createNotification({
          userId: document.userId,
          type: "DOCUMENT_PROCESSING",
          title: "Document processing failed",
          message: `${document.fileName}: GEMINI_API_KEY is not configured.`,
          link: document.filingDraftId
            ? `/tax/new?draftId=${document.filingDraftId}`
            : "/tax/new",
        });
      }
      return {
        success: false,
        error: saved
          ? "GEMINI_API_KEY is not configured"
          : "A newer extraction attempt has taken over. Refresh to see its status.",
      };
    }

    const storedFileName = path.basename(document.fileUrl);
    const filePath = path.join(process.cwd(), "uploads", storedFileName);
    const fileBuffer = await readFile(filePath);
    const modelName = process.env.GEMINI_MODEL || "gemini-3.5-flash";
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: modelName,
    });

    const result = await model.generateContent([
      { text: buildExtractionPrompt(document.documentType) },
      {
        inlineData: {
          data: fileBuffer.toString("base64"),
          mimeType: document.mimeType,
        },
      },
    ]);

    let normalizedExtraction = normalizeExtractedPayload(
      parseModelJson(result.response.text()),
      document.documentType,
    );
    if (
      document.documentType === "previous_return" &&
      document.mimeType === "application/pdf"
    ) {
      // IRIS prints carry a real text layer: read the printed wealth codes
      // (7019/7029/703001/7012) deterministically from that text and let them
      // win over the model's read of the same rows (the generic pass has
      // picked the neighbouring 703002 row or left 703001 blank). A scanned
      // print has no text layer; its model result stands untouched.
      try {
        const { extractText } = await import("unpdf");
        const { text } = await extractText(new Uint8Array(fileBuffer), {
          mergePages: false,
        });
        const pages = Array.isArray(text) ? text : [String(text ?? "")];
        const textParse = parseIrisPreviousReturnText(
          pages.join("\n"),
          pages[0] ?? "",
        );
        if (textParse)
          normalizedExtraction = applyPreviousReturnTextParse(
            normalizedExtraction,
            textParse,
          ) as typeof normalizedExtraction;
      } catch {
        /* Keep the model result; review validation still applies. */
      }
    }
    if (document.documentType === "business_books") {
      const missingAnnual = missingBusinessAnnualLabels(normalizedExtraction);
      if (missingAnnual.length > 0) {
        try {
          const recoveryResult = await model.generateContent([
            {text:businessAnnualRecoveryPrompt(missingAnnual)},
            {inlineData:{data:fileBuffer.toString("base64"),mimeType:document.mimeType}},
          ]);
          normalizedExtraction = recoverMissingBusinessAnnualFields(normalizedExtraction,parseModelJson(recoveryResult.response.text())) as typeof normalizedExtraction;
        } catch {
          // A failed/ambiguous second read must stay blank and block review, never become zero.
        }
      }
      const review = ensureBusinessScheduleReviewFields(
        normalizedExtraction,
      ) as { fields?: Array<{ label: string; value: unknown }> };
      const basis =
        review?.fields?.filter((field) =>
          isBusinessPurchaseBasisField(field.label),
        ) || [];
      if (
        businessPurchaseBasisRequired(review?.fields) &&
        basis.length === 1 &&
        parseBusinessPurchaseBasis(basis[0].value) === null
      ) {
        try {
          const evidence = await readPurchaseBasisFromOriginalFile(
            model,
            fileBuffer,
            document.mimeType,
          );
          if (evidence)
            normalizedExtraction = applyBusinessPurchaseBasisEvidence(
              review,
              evidence,
            );
        } catch {
          /* Leave unknown. Required review validation blocks silent approval. */
        }
      }
    }
    const validation = validateExtractedDocument(
      document.documentType,
      normalizedExtraction,
    );
    const reviewExtraction =
      document.documentType === "pension_statement"
        ? ensurePensionStatementReviewFields(normalizedExtraction, true)
        : ensureReviewFields(document.documentType, normalizedExtraction);
    const storageExtraction = normalizeBusinessListFieldsForStorage(
      reviewExtraction,
    );
    // Valid detail lists are stored canonically. An unreadable list is kept
    // for the review screen's row editor instead of being silently dropped.
    const extracted = storageExtraction.errors.length
      ? reviewExtraction
      : storageExtraction.payload;

    if (!validation.valid) {
      const saved = await updateThisAttempt({
        extractionStatus: "FAILED",
        extractionProvider: "gemini",
        extractedData: JSON.stringify(extracted),
        extractionError: validation.error,
        extractedAt: null,
      });
      if (saved) {
        await createNotification({
          userId: document.userId,
          type: "DOCUMENT_PROCESSING",
          title: "Document processing failed",
          message: `${document.fileName}: ${validation.error}`,
          link: document.filingDraftId
            ? `/tax/new?draftId=${document.filingDraftId}`
            : "/tax/new",
        });
      }
      return {
        success: false,
        code: saved ? undefined : "EXTRACTION_ATTEMPT_EXPIRED",
        error: saved
          ? validation.error
          : "A newer extraction attempt has taken over. Refresh to see its status.",
      };
    }

    const saved = await updateThisAttempt({
      extractionStatus: "COMPLETED",
      extractionProvider: "gemini",
      extractedData: JSON.stringify(extracted),
      extractionError: null,
      extractedAt: new Date(),
    });
    if (!saved) {
      return {
        success: false,
        code: "EXTRACTION_ATTEMPT_EXPIRED",
        error:
          "A newer extraction attempt has taken over. Refresh to see its result.",
      };
    }

    await createNotification({
      userId: document.userId,
      type: "DOCUMENT_PROCESSING",
      title: "Document processing completed",
      message: `${document.fileName} was extracted and is ready for review.`,
      link: document.filingDraftId
        ? `/tax/new?draftId=${document.filingDraftId}`
        : "/tax/new",
    });

    return {
      success: true,
      documentId: document.id,
      provider: "gemini",
      status: "COMPLETED",
      extracted: presentBusinessListFields(extracted),
    };
  } catch (error) {
    if (documentIdForError && userIdForError && extractionAttemptStartedAt) {
      const message =
        error instanceof Error ? error.message : "Unknown extraction error";
      const failedUpdate = await prisma.document.updateMany({
        where: {
          id: documentIdForError,
          userId: userIdForError,
          extractionStatus: "PROCESSING",
          extractionStartedAt: extractionAttemptStartedAt,
        },
        data: {
          extractionStatus: "FAILED",
          extractionStartedAt: null,
          extractionProvider: "gemini",
          extractionError: message,
        },
      });

      if (failedUpdate.count > 0) {
        const failedDocument = await prisma.document.findUnique({
          where: { id: documentIdForError },
          select: { userId: true, filingDraftId: true, fileName: true },
        });
        if (failedDocument) {
          await createNotification({
            userId: failedDocument.userId,
            type: "DOCUMENT_PROCESSING",
            title: "Document processing failed",
            message: `${failedDocument.fileName}: ${message}`,
            link: failedDocument.filingDraftId
              ? `/tax/new?draftId=${failedDocument.filingDraftId}`
              : "/tax/new",
          });
        }
      }
    }

    console.error("Error extracting document with Gemini:", error);
    return {
      success: false,
      error:
        process.env.NODE_ENV === "development" && error instanceof Error
          ? error.message
          : "Document extraction failed",
    };
  }
}

/**
 * Change the employer name(s) on a salary certificate that is ALREADY mapped,
 * without re-uploading or re-extracting it. Only the two employer fields are
 * rewritten; amounts and everything else stay as mapped. Employers are carried
 * in the filing packet, so the latest packet is superseded and its approval is
 * cleared: the taxpayer must generate and approve a new one.
 */
export async function saveSalaryCertificateEmployersAction(
  documentId: string,
  input: { employerName: string; otherEmployerNames?: string },
) {
  try {
    const document = await getOwnedDocument(documentId);
    if (document.documentType !== "salary_certificate") {
      return { success: false, error: "This is not a salary certificate" };
    }
    if (document.extractionStatus !== "MAPPED") {
      return {
        success: false,
        error: "Only a mapped salary certificate is edited this way",
      };
    }
    const plan = planSalaryCertificateEmployerUpdate(
      document.extractedData,
      input,
    );
    if (!plan.ok) return { success: false, error: plan.error };

    await prisma.$transaction(async (tx) => {
      await tx.document.update({
        where: { id: documentId },
        data: { extractedData: plan.extractedData },
      });
      if (document.filingDraftId) {
        await tx.filingPacket.updateMany({
          where: {
            filingDraftId: document.filingDraftId,
            userId: document.userId,
            status: { not: "SUPERSEDED" },
          },
          data: { status: "SUPERSEDED", approvalStatus: "SUPERSEDED" },
        });
        await tx.filingDraft.update({
          where: { id: document.filingDraftId },
          data: {
            packetApprovalConfirmed: false,
            packetApprovalAt: null,
            packetApprovalByUserId: null,
          },
        });
      }
    });
    return { success: true, employers: plan.employers };
  } catch (error) {
    console.error("Error saving salary certificate employers:", error);
    return { success: false, error: "Failed to save the employer names" };
  }
}

/**
 * Enter the IBAN on a bank statement that is ALREADY mapped (mapped before the
 * IBAN became a required field). It updates the stored extraction and the
 * account only; transactions, balances and reviews are not touched.
 */
export async function saveBankStatementIbanAction(
  documentId: string,
  iban: string,
) {
  try {
    const document = await getOwnedDocument(documentId);
    if (document.documentType !== "bank_statement") {
      return { success: false, error: "This is not a bank statement" };
    }
    if (!document.filingDraftId || !document.bankAccountId) {
      return {
        success: false,
        error: "This statement is not linked to a bank account",
      };
    }
    const resolution = await resolveStatementIban({
      filingDraftId: document.filingDraftId,
      userId: document.userId,
      bankAccountId: document.bankAccountId,
      value: iban,
    });
    if (!resolution.ok) return { success: false, error: resolution.error };

    const extracted = document.extractedData
      ? (JSON.parse(document.extractedData) as {
          fields?: Array<{
            label: string;
            value: unknown;
            confidence?: number;
          }>;
        })
      : { fields: [] };
    const fields = (extracted.fields ?? []).filter(
      (field) => normalizedLabel(field.label) !== "iban",
    );
    fields.push({ label: "IBAN", value: resolution.iban, confidence: 1 });

    await prisma.$transaction([
      prisma.bankAccount.update({
        where: { id: document.bankAccountId },
        data: { iban: resolution.iban },
      }),
      prisma.document.update({
        where: { id: documentId },
        data: { extractedData: JSON.stringify({ ...extracted, fields }) },
      }),
    ]);
    return { success: true, iban: resolution.iban };
  } catch (error) {
    console.error("Error saving statement IBAN:", error);
    return { success: false, error: "Failed to save the IBAN" };
  }
}
