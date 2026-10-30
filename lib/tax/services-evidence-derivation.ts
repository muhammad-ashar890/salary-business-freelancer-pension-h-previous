import type { ServicesDerivedPayout } from "./services-income-evidence";
import type { ServicesIncomeCharacter } from "./services-iris-mapping";

/**
 * Document-driven derivation of the Services "income basis and payout
 * evidence" step.
 *
 * The rule this module enforces: nothing is asked from the taxpayer that the
 * uploaded documents already answer. Every proposal below is computed from
 * (a) the invoice rows extracted from the invoice/contract document, including
 * the payout block that document prints, and (b) the Services bank credits that
 * came out of the bank statement. When the documents do not prove a value it is
 * left out and reported as an issue — never guessed.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type DerivationInvoice = Readonly<{
  id: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  clientName: string | null;
  serviceDescription: string | null;
  invoiceAmount: number | null;
  currency: string | null;
  exchangeRateToPkr: number | null;
  subcategory: string | null;
  sourceDocumentFileName: string;
  derivedPayout: ServicesDerivedPayout | null;
}>;

export type DerivationReceipt = Readonly<{
  id: string;
  date: string | null;
  description: string;
  amount: number;
}>;

export type DerivedInvoiceReview = Readonly<{
  invoiceId: string;
  subcategory: string;
  serviceCategoryHumanConfirmed: boolean;
  serviceCategoryEvidenceReference: string;
  incomeCharacter: ServicesIncomeCharacter;
  incomeCharacterHumanConfirmed: boolean;
  incomeCharacterEvidenceReference: string;
  dueDate: string | null;
  exchangeRateToPkr: number | null;
  fxEvidenceReference: string | null;
  paymentStatus: "NO_RECEIPT_TY" | "PARTIAL_TY" | "FULL_TY" | "";
}>;

export type DerivedPaymentMatch = Readonly<{
  invoiceEvidenceId: string;
  ledgerEntryId: string;
  settlementDate: string;
  settlementCurrency: "PKR";
  settlementAmount: number;
  settlementExchangeRateToPkr: 1;
  invoiceCurrencyAmount: number;
  exchangeRateToPkr: number;
  grossServiceAmountPkr: number;
  netBankAmountPkr: number;
  withholdingTaxPkr: number;
  withholdingSection: string | null;
  withholdingIrisCode: string | null;
  withholdingEvidenceReference: string | null;
  withholdingEvidenceHumanConfirmed: boolean;
  withholdingEvidenceDocumentId: null;
  platformFeePkr: number;
  bankFeePkr: number;
  payoutReference: string | null;
  evidenceReference: string;
  /** Why this pair was proposed, for the Review-step explanation. */
  confidence: "document_reference" | "exact_amount" | "amount_and_date" | "grouped_payout";
}>;

export type DerivationIssue = Readonly<{
  code:
    | "invoice_without_credit"
    | "credit_without_invoice"
    | "ambiguous_match"
    | "subcategory_unresolved"
    | "income_character_unresolved"
    | "amount_mismatch";
  message: string;
  invoiceId?: string;
  ledgerEntryId?: string;
}>;

export type ServicesEvidenceDerivation = Readonly<{
  ok: boolean;
  invoiceReviews: DerivedInvoiceReview[];
  matches: DerivedPaymentMatch[];
  assumptions: string[];
  issues: DerivationIssue[];
  coverage: Readonly<{
    credits: number;
    matchedCredits: number;
    unmatchedCreditIds: string[];
    unmatchedInvoiceIds: string[];
    allocatedPkr: number;
    ledgerPkr: number;
  }>;
}>;

const SUBCATEGORY_KEYWORDS: Record<string, readonly string[]> = {
  "1b-service-it-ites": [
    "it",
    "information technology",
    "software",
    "web",
    "website",
    "application",
    "app",
    "development",
    "developer",
    "programming",
    "design",
    "ui",
    "ux",
    "data",
    "database",
    "cloud",
    "devops",
    "qa",
    "testing",
    "cyber",
    "network",
    "api",
    "backend",
    "frontend",
  ],
  "1b-service-certain": [
    "legal",
    "advocate",
    "law",
    "accounting",
    "accountant",
    "audit",
    "tax",
    "consult",
    "consulting",
    "consultant",
    "advisory",
    "engineering",
    "engineer",
    "architect",
    "medical",
    "doctor",
    "professional",
    "technical",
    "management",
  ],
  "1b-service-advertising-media": [
    "advertising",
    "advertisement",
    "marketing",
    "media",
    "brand",
    "campaign",
    "content",
    "seo",
    "social media",
    "graphic",
    "video",
    "photography",
  ],
  "1b-service-other": ["other", "miscellaneous", "residual"],
  "2-services-to-exporter": ["exporter", "export house", "export"],
  "export-it-ites-pseb": ["pseb", "export software", "export it", "exported software"],
  "export-services-other": ["export services", "exported services", "export"],
};

const TECHNICAL_FEE_KEYWORDS = [
  "technical",
  "professional",
  "consult",
  "consulting",
  "consultancy",
  "advisory",
  "legal",
  "audit",
  "accounting",
  "tax",
  "engineering",
  "architect",
  "software",
  "development",
  "developer",
  "programming",
  "design",
  "data",
  "information technology",
  "it services",
  "marketing",
  "content",
  "freelance",
  "service fee",
  "services rendered",
];

function cents(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function pkr(value: number): number {
  return Math.round(value * 100) / 100;
}

function isoDateOnly(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return date;
}

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPhrase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function dayDistance(left: Date | null, right: Date | null): number {
  if (!left || !right) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(left.getTime() - right.getTime()) / DAY_MS);
}

/** PKR value of the invoice itself, using the document's own FX rate. */
function invoicePkrAmount(invoice: DerivationInvoice): number | null {
  const amount = invoice.invoiceAmount;
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return null;
  const currency = (invoice.currency ?? "").toUpperCase();
  if (!currency || currency === "PKR") return pkr(amount);
  if (typeof invoice.exchangeRateToPkr !== "number" || invoice.exchangeRateToPkr <= 0)
    return null;
  return pkr(amount * invoice.exchangeRateToPkr);
}

function expectedNet(invoice: DerivationInvoice): number | null {
  const printed = invoice.derivedPayout?.netPayoutPkr;
  if (typeof printed === "number" && printed > 0) return pkr(printed);
  const settlement = invoice.derivedPayout?.settlementAmount;
  const settlementCurrency = (invoice.derivedPayout?.settlementCurrency ?? "").toUpperCase();
  const settlementRate = invoice.derivedPayout?.settlementExchangeRateToPkr;
  // A settlement amount is the payout BEFORE the receiving bank takes its fee,
  // so the credit that lands in the bank is settlement minus that fee. The
  // validator enforces `settlement = net credit + receiving-bank fee`; matching
  // on the raw settlement would look for a credit that is larger than the one
  // the statement proves.
  const bankFee =
    typeof invoice.derivedPayout?.bankFeePkr === "number" &&
    Number.isFinite(invoice.derivedPayout.bankFeePkr)
      ? Math.max(0, invoice.derivedPayout.bankFeePkr)
      : 0;
  if (
    typeof settlement === "number" &&
    settlement > 0 &&
    settlementCurrency === "PKR"
  )
    return pkr(settlement - bankFee);
  if (
    typeof settlement === "number" &&
    settlement > 0 &&
    typeof settlementRate === "number" &&
    settlementRate > 0
  )
    return pkr(settlement * settlementRate - bankFee);
  return invoicePkrAmount(invoice);
}

type Pair = {
  invoice: DerivationInvoice;
  receipt: DerivationReceipt;
  score: number;
  distance: number;
  confidence: DerivedPaymentMatch["confidence"];
};

function scorePair(
  invoice: DerivationInvoice,
  receipt: DerivationReceipt,
  windowDays: number,
): Pair | null {
  const payout = invoice.derivedPayout;
  const receiptDate = parseIsoDate(receipt.date);
  const invoiceDate = parseIsoDate(invoice.invoiceDate);
  const distance = dayDistance(invoiceDate, receiptDate);
  const receiptCents = cents(receipt.amount);
  if (receiptCents === null || receiptCents <= 0) return null;

  const reference = normalizeText(payout?.payoutReference);
  if (reference && containsPhrase(normalizeText(receipt.description), reference)) {
    return { invoice, receipt, score: 100, distance, confidence: "document_reference" };
  }

  const net = expectedNet(invoice);
  if (net !== null && receiptCents === cents(net) && distance <= windowDays)
    return { invoice, receipt, score: 90, distance, confidence: "exact_amount" };
  if (net !== null && receiptCents === cents(net))
    return { invoice, receipt, score: 70, distance, confidence: "exact_amount" };

  const gross = payout?.grossServiceAmountPkr ?? null;
  if (typeof gross === "number" && receiptCents === cents(gross) && distance <= windowDays)
    return { invoice, receipt, score: 80, distance, confidence: "exact_amount" };

  const invoicePkr = invoicePkrAmount(invoice);
  if (invoicePkr !== null && receiptCents === cents(invoicePkr) && distance <= windowDays)
    return { invoice, receipt, score: 75, distance, confidence: "amount_and_date" };

  // A part-payment: the credit is smaller than the invoice and dated after it.
  if (
    net !== null &&
    receiptCents < cents(net)! &&
    distance <= windowDays &&
    receiptDate &&
    invoiceDate &&
    receiptDate.getTime() >= invoiceDate.getTime() - 3 * DAY_MS
  )
    return { invoice, receipt, score: 50, distance, confidence: "amount_and_date" };

  return null;
}

function resolveFees(
  invoice: DerivationInvoice,
  receipt: DerivationReceipt,
  assumptions: string[],
  issues: DerivationIssue[],
): {
  gross: number;
  withholding: number;
  platformFee: number;
  bankFee: number;
} | null {
  const payout = invoice.derivedPayout;
  const net = pkr(receipt.amount);
  const platformFee = pkr(payout?.platformFeePkr ?? 0);
  const bankFee = pkr(payout?.bankFeePkr ?? 0);
  const printedGross =
    typeof payout?.grossServiceAmountPkr === "number" && payout.grossServiceAmountPkr > 0
      ? pkr(payout.grossServiceAmountPkr)
      : null;
  const printedWithholding =
    typeof payout?.withholdingTaxPkr === "number" && payout.withholdingTaxPkr >= 0
      ? pkr(payout.withholdingTaxPkr)
      : null;

  let gross: number;
  let withholding: number;
  if (printedGross !== null) {
    gross = printedGross;
    withholding =
      printedWithholding !== null
        ? printedWithholding
        : pkr(Math.max(0, Math.round((gross - net - platformFee - bankFee) * 100) / 100));
    if (printedWithholding === null && withholding > 0)
      assumptions.push(
        `Invoice ${label(invoice)}: withholding is the printed gross minus the bank credit and fees (PKR ${withholding.toFixed(2)}).`,
      );
  } else if (printedWithholding !== null) {
    gross = pkr(net + printedWithholding + platformFee + bankFee);
    withholding = printedWithholding;
  } else {
    gross = net;
    withholding = 0;
    assumptions.push(
      `Invoice ${label(invoice)}: neither withholding nor gross is printed, so the bank credit is taken as the full service amount and withholding as 0.`,
    );
  }

  if (gross <= 0) return null;
  if (cents(gross)! < cents(net)!) {
    issues.push({
      code: "amount_mismatch",
      invoiceId: invoice.id,
      message: `Invoice ${label(invoice)}: the printed gross service amount is lower than the bank credit, so this payout cannot be confirmed automatically.`,
    });
    return null;
  }
  return { gross, withholding, platformFee, bankFee };
}

function label(invoice: DerivationInvoice): string {
  return invoice.invoiceNumber?.trim() || invoice.id;
}

function subcategoryFromText(
  invoice: DerivationInvoice,
  selected: readonly string[],
): { subcategory: string; confident: boolean } | null {
  if (invoice.subcategory && selected.includes(invoice.subcategory))
    return { subcategory: invoice.subcategory, confident: true };
  if (selected.length === 1) return { subcategory: selected[0], confident: true };

  const text = normalizeText(
    `${invoice.serviceDescription ?? ""} ${invoice.clientName ?? ""}`,
  );
  if (!text) return null;

  const scores = selected.map((subcategory) => {
    const keywords = SUBCATEGORY_KEYWORDS[subcategory] ?? [];
    let score = 0;
    for (const keyword of keywords) {
      if (containsPhrase(text, keyword)) score += keyword.includes(" ") ? 2 : 1;
    }
    return { subcategory, score };
  });
  scores.sort((left, right) => right.score - left.score);
  if (!scores.length || scores[0].score === 0) return null;
  const tied = scores.filter((row) => row.score === scores[0].score);
  if (tied.length > 1) return null;
  return {
    subcategory: scores[0].subcategory,
    confident: scores[0].score >= (scores[1]?.score ?? 0) + 2,
  };
}

function incomeCharacterFromText(
  invoice: DerivationInvoice,
): { character: ServicesIncomeCharacter; confident: boolean } {
  const printed = normalizeText(invoice.derivedPayout?.incomeCharacter);
  if (printed) {
    if (printed.includes("technical") || printed.includes("professional"))
      return { character: "TECHNICAL_PROFESSIONAL_FEE", confident: true };
    if (printed.includes("other")) return { character: "OTHER_SERVICES", confident: true };
  }
  const text = normalizeText(
    `${invoice.serviceDescription ?? ""}`,
  );
  let hits = 0;
  for (const keyword of TECHNICAL_FEE_KEYWORDS) {
    if (containsPhrase(text, keyword)) hits += 1;
  }
  if (hits > 0)
    return { character: "TECHNICAL_PROFESSIONAL_FEE", confident: true };
  return { character: "UNCLASSIFIED", confident: false };
}

function evidenceReference(invoice: DerivationInvoice): string {
  const parts = [invoice.sourceDocumentFileName];
  if (invoice.serviceDescription?.trim()) parts.push(invoice.serviceDescription.trim());
  if (invoice.invoiceNumber?.trim()) parts.push(`invoice ${invoice.invoiceNumber.trim()}`);
  return parts.join(" · ").slice(0, 500);
}

/**
 * Greedy-but-deterministic invoice ↔ bank-credit assignment. A credit is used
 * once, an invoice is settled by one credit, and exact document references win
 * over amount matches. Remaining credits are then tried as a grouped payout of
 * two or three same-client invoices whose net amounts sum exactly to the credit.
 */
export function deriveServicesEvidence(input: {
  selectedSubcategories: readonly string[];
  invoices: readonly DerivationInvoice[];
  receipts: readonly DerivationReceipt[];
  taxYear?: number;
  dateWindowDays?: number;
}): ServicesEvidenceDerivation {
  const windowDays = input.dateWindowDays ?? 30;
  const taxYear = input.taxYear ?? 2026;
  const inTaxYear = (iso: string | null) => {
    const date = parseIsoDate(iso);
    if (!date) return false;
    const start = Date.UTC(taxYear - 1, 6, 1);
    const end = Date.UTC(taxYear, 5, 30, 23, 59, 59, 999);
    return date.getTime() >= start && date.getTime() <= end;
  };
  const selected = Array.from(new Set(input.selectedSubcategories));
  const invoices = [...input.invoices].sort((left, right) => {
    const leftDate = left.invoiceDate ?? "";
    const rightDate = right.invoiceDate ?? "";
    return leftDate.localeCompare(rightDate) || left.id.localeCompare(right.id);
  });
  const receipts = [...input.receipts].sort((left, right) => {
    const leftDate = left.date ?? "";
    const rightDate = right.date ?? "";
    return leftDate.localeCompare(rightDate) || left.id.localeCompare(right.id);
  });

  const assumptions: string[] = [];
  const issues: DerivationIssue[] = [];

  const pairs: Pair[] = [];
  for (const invoice of invoices) {
    for (const receipt of receipts) {
      const pair = scorePair(invoice, receipt, windowDays);
      if (pair) pairs.push(pair);
    }
  }
  pairs.sort(
    (left, right) =>
      right.score - left.score ||
      left.distance - right.distance ||
      left.invoice.id.localeCompare(right.invoice.id) ||
      left.receipt.id.localeCompare(right.receipt.id),
  );

  const usedInvoices = new Set<string>();
  const usedReceipts = new Set<string>();
  const assigned: Pair[] = [];
  for (const pair of pairs) {
    if (usedInvoices.has(pair.invoice.id) || usedReceipts.has(pair.receipt.id)) continue;
    usedInvoices.add(pair.invoice.id);
    usedReceipts.add(pair.receipt.id);
    assigned.push(pair);
  }

  // Grouped payout: one credit settling several invoices of the same client.
  for (const receipt of receipts) {
    if (usedReceipts.has(receipt.id)) continue;
    const receiptCents = cents(receipt.amount);
    if (receiptCents === null || receiptCents <= 0) continue;
    const candidates = invoices.filter((invoice) => !usedInvoices.has(invoice.id));
    if (candidates.length < 2) continue;
    let grouped: DerivationInvoice[] | null = null;
    outer: for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const twoCents = cents(expectedNet(candidates[i]) ?? 0)! + cents(expectedNet(candidates[j]) ?? 0)!;
        if (twoCents === receiptCents) {
          grouped = [candidates[i], candidates[j]];
          break outer;
        }
        for (let k = j + 1; k < candidates.length; k += 1) {
          const threeCents = twoCents + cents(expectedNet(candidates[k]) ?? 0)!;
          if (threeCents === receiptCents) {
            grouped = [candidates[i], candidates[j], candidates[k]];
            break outer;
          }
        }
      }
    }
    if (!grouped) continue;
    usedReceipts.add(receipt.id);
    for (const invoice of grouped) {
      usedInvoices.add(invoice.id);
      assigned.push({
        invoice,
        receipt,
        score: 60,
        distance: 0,
        confidence: "grouped_payout",
      });
      assumptions.push(
        `Invoice ${label(invoice)}: settled as part of one grouped payout (${receipt.date ?? "date missing"}) whose net equals the sum of the grouped invoices.`,
      );
    }
  }

  // Split the credit across the invoices it settles.
  const perReceipt = new Map<string, Pair[]>();
  for (const pair of assigned) {
    const rows = perReceipt.get(pair.receipt.id) ?? [];
    rows.push(pair);
    perReceipt.set(pair.receipt.id, rows);
  }

  const matches: DerivedPaymentMatch[] = [];
  const matchedCentsByInvoice = new Map<string, number>();
  for (const rows of perReceipt.values()) {
    const receipt = rows[0].receipt;
    const totalExpected = rows.reduce((sum, pair) => sum + (cents(expectedNet(pair.invoice) ?? 0) ?? 0), 0);
    const receiptCents = cents(receipt.amount) ?? 0;
    for (const pair of rows) {
      const invoice = pair.invoice;
      const share =
        rows.length === 1 || totalExpected <= 0
          ? receiptCents
          : Math.round((receiptCents * (cents(expectedNet(invoice) ?? 0) ?? 0)) / totalExpected);
      const netAmount = pkr(share / 100);
      const fees = resolveFees(invoice, { ...receipt, amount: netAmount }, assumptions, issues);
      if (!fees) continue;

      const invoicePkr = invoicePkrAmount(invoice);
      const currency = (invoice.currency ?? "PKR").toUpperCase();
      const printedRate =
        typeof invoice.exchangeRateToPkr === "number" && invoice.exchangeRateToPkr > 0
          ? invoice.exchangeRateToPkr
          : null;
      if (currency !== "PKR" && printedRate === null) {
        // Converting a foreign-currency invoice at 1 would be a silent
        // misstatement, so no match is proposed until the document prints the
        // rate (or the payout block shows it).
        issues.push({
          code: "amount_mismatch",
          invoiceId: invoice.id,
          message: `Invoice ${label(invoice)}: the document does not print the ${currency}→PKR exchange rate, so its bank credit cannot be converted.`,
        });
        continue;
      }
      const rate = currency === "PKR" ? 1 : (printedRate as number);
      const invoiceCurrencyAmount =
        invoice.invoiceAmount !== null && invoice.invoiceAmount > 0
          ? pkr(
              rows.length === 1
                ? invoice.invoiceAmount
                : (invoice.invoiceAmount * netAmount) /
                    Math.max(invoicePkr ?? netAmount, netAmount),
            )
          : pkr(netAmount / rate);

      matches.push({
        invoiceEvidenceId: invoice.id,
        ledgerEntryId: receipt.id,
        settlementDate: receipt.date ?? isoDateOnly(parseIsoDate(invoice.invoiceDate)) ?? "",
        settlementCurrency: "PKR",
        // Pre-bank-fee payout: the statement proves `netAmount` was credited and
        // the payer's payout advice already had the receiving-bank fee removed.
        // `evaluateServicesIncomeEvidence` requires
        // settlement = net credit + receiving-bank fee, so a match built from the
        // credit alone failed its own validation for every fee-bearing invoice.
        settlementAmount: pkr(netAmount + fees.bankFee),
        settlementExchangeRateToPkr: 1,
        invoiceCurrencyAmount,
        exchangeRateToPkr: rate,
        grossServiceAmountPkr: fees.gross,
        netBankAmountPkr: netAmount,
        withholdingTaxPkr: fees.withholding,
        withholdingSection: invoice.derivedPayout?.withholdingSection ?? null,
        withholdingIrisCode: invoice.derivedPayout?.withholdingIrisCode ?? null,
        withholdingEvidenceReference:
          invoice.derivedPayout?.withholdingEvidenceReference ?? null,
        // Printed invoice facts prefill the numbers, not certificate authority.
        // Review attaches a uniquely matching mapped withholding source before
        // its single confirmation may enable an automatic IRIS tax row.
        withholdingEvidenceHumanConfirmed: false,
        withholdingEvidenceDocumentId: null,
        platformFeePkr: fees.platformFee,
        bankFeePkr: fees.bankFee,
        payoutReference:
          invoice.derivedPayout?.payoutReference ?? receipt.description.slice(0, 250),
        evidenceReference:
          invoice.derivedPayout?.evidenceReference ??
          `${invoice.sourceDocumentFileName} · ${receipt.date ?? "date missing"} bank credit`,
        confidence: pair.confidence,
      });
      matchedCentsByInvoice.set(
        invoice.id,
        (matchedCentsByInvoice.get(invoice.id) ?? 0) + cents(netAmount)!,
      );
    }
  }

  // Invoice reviews, now that every credit is known.
  const invoiceReviews: DerivedInvoiceReview[] = invoices.map((invoice) => {
    const resolution = subcategoryFromText(invoice, selected);
    const character = incomeCharacterFromText(invoice);
    const reference = evidenceReference(invoice);
    const matched = matches.filter((match) => match.invoiceEvidenceId === invoice.id);
    const grossCents = matched.reduce(
      (sum, match) => sum + (cents(match.grossServiceAmountPkr) ?? 0),
      0,
    );
    const netCents = matchedCentsByInvoice.get(invoice.id) ?? 0;
    // Receipt status is read from the money itself: the invoice total the
    // document prints versus everything the bank credits actually settled.
    // The settled gross service amount (invoice value the bank credits prove)
    // is compared with the invoice total — never the net credit, because
    // withholding and fees are part of the invoice but never reach the bank.
    const invoiceTotalCents = cents(invoicePkrAmount(invoice));
    const paymentStatus: DerivedInvoiceReview["paymentStatus"] =
      matched.length === 0
        ? inTaxYear(invoice.invoiceDate)
          ? "NO_RECEIPT_TY"
          : ""
        : invoiceTotalCents !== null && grossCents >= invoiceTotalCents
          ? "FULL_TY"
          : "PARTIAL_TY";

    const currency = (invoice.currency ?? "PKR").toUpperCase();
    if (
      currency !== "PKR" &&
      !(typeof invoice.exchangeRateToPkr === "number" && invoice.exchangeRateToPkr > 0)
    ) {
      issues.push({
        code: "amount_mismatch",
        invoiceId: invoice.id,
        message: `Invoice ${label(invoice)}: the document does not print the ${currency}→PKR exchange rate, so its bank credit cannot be converted.`,
      });
    }
    if (!resolution) {
      issues.push({
        code: "subcategory_unresolved",
        invoiceId: invoice.id,
        message: `Invoice ${label(invoice)}: the document does not state a TY2026 Services category and it matches no single selected category, so the category must be chosen.`,
      });
    }
    if (character.character !== "TECHNICAL_PROFESSIONAL_FEE") {
      issues.push({
        code: "income_character_unresolved",
        invoiceId: invoice.id,
        message: `Invoice ${label(invoice)}: the document does not describe a technical/professional fee, so IRIS row 3101 stays manual for it.`,
      });
    }
    if (matched.length === 0) {
      issues.push({
        code: "invoice_without_credit",
        invoiceId: invoice.id,
        message: `Invoice ${label(invoice)}: no Services bank credit matches this invoice's net amount or payout reference.`,
      });
      if (inTaxYear(invoice.invoiceDate))
        assumptions.push(
          `Invoice ${label(invoice)}: dated in TY${taxYear} with no matching bank credit, so cash basis records no receipt this year.`,
        );
    }

    return {
      invoiceId: invoice.id,
      subcategory: resolution?.subcategory ?? "",
      serviceCategoryHumanConfirmed:
        Boolean(resolution?.confident && resolution.subcategory) && Boolean(reference),
      serviceCategoryEvidenceReference: reference,
      incomeCharacter: character.character,
      incomeCharacterHumanConfirmed:
        character.confident && character.character === "TECHNICAL_PROFESSIONAL_FEE",
      incomeCharacterEvidenceReference: reference,
      dueDate: null,
      exchangeRateToPkr:
        (invoice.currency ?? "PKR").toUpperCase() === "PKR"
          ? 1
          : (invoice.exchangeRateToPkr ?? null),
      fxEvidenceReference: invoice.derivedPayout?.evidenceReference ?? null,
      paymentStatus,
    };
  });

  const unmatchedCreditIds = receipts
    .filter((receipt) => !usedReceipts.has(receipt.id))
    .map((receipt) => receipt.id);
  for (const receipt of receipts) {
    if (!unmatchedCreditIds.includes(receipt.id)) continue;
    issues.push({
      code: "credit_without_invoice",
      ledgerEntryId: receipt.id,
      message: `Bank credit ${receipt.date ?? "date missing"} · PKR ${receipt.amount.toFixed(2)} (${receipt.description.slice(0, 60)}) does not match any reviewed invoice.`,
    });
  }

  const allocatedPkr = pkr(
    matches.reduce((sum, match) => sum + match.netBankAmountPkr, 0),
  );
  const ledgerPkr = pkr(receipts.reduce((sum, receipt) => sum + receipt.amount, 0));
  const blocking = issues.filter(
    (issue) => issue.code !== "income_character_unresolved",
  );

  return {
    ok: blocking.length === 0 && matches.length > 0,
    invoiceReviews,
    matches,
    assumptions: Array.from(new Set(assumptions)),
    issues,
    coverage: {
      credits: receipts.length,
      matchedCredits: receipts.length - unmatchedCreditIds.length,
      unmatchedCreditIds,
      unmatchedInvoiceIds: invoices
        .filter((invoice) => !matches.some((match) => match.invoiceEvidenceId === invoice.id))
        .map((invoice) => invoice.id),
      allocatedPkr,
      ledgerPkr,
    },
  };
}
