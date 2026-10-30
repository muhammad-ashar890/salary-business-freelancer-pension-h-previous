export const SERVICES_ACCOUNTING_METHODS = ["CASH", "ACCRUAL"] as const;
export type ServicesAccountingMethod = (typeof SERVICES_ACCOUNTING_METHODS)[number];

export const SERVICES_PAYMENT_STATUSES = [
  "NO_RECEIPT_TY",
  "PARTIAL_TY",
  "FULL_TY",
] as const;
export type ServicesPaymentStatus = (typeof SERVICES_PAYMENT_STATUSES)[number];

type ExtractedField = { label?: unknown; value?: unknown };

/**
 * Payout facts an invoice (or its attached payout statement) actually prints.
 * They are extracted, persisted in ServicesInvoiceEvidence.detailsJson and then
 * used to derive the Review-step payout match without any manual typing.
 * Every value stays null when the document does not state it.
 */
export type ServicesDerivedPayout = {
  settlementDate: string | null;
  settlementCurrency: string | null;
  settlementAmount: number | null;
  settlementExchangeRateToPkr: number | null;
  grossServiceAmountPkr: number | null;
  withholdingTaxPkr: number | null;
  withholdingSection: string | null;
  withholdingIrisCode: string | null;
  withholdingEvidenceReference: string | null;
  platformFeePkr: number | null;
  bankFeePkr: number | null;
  netPayoutPkr: number | null;
  payoutReference: string | null;
  evidenceReference: string | null;
  /** Only when the document itself classifies the service (never inferred here). */
  incomeCharacter: string | null;
};

export type ParsedServicesInvoice = {
  invoiceKey: string;
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  dueDate: Date | null;
  clientName: string | null;
  serviceDescription: string | null;
  quantity: number | null;
  unitRate: number | null;
  invoiceAmount: number | null;
  currency: string | null;
  exchangeRateToPkr: number | null;
  fxEvidenceReference: string | null;
  subcategory: string | null;
  paymentStatus: ServicesPaymentStatus | null;
  payout: ServicesDerivedPayout;
  issues: string[];
};

type MoneyLike = number | string | { toString(): string } | null | undefined;
type DateLike = Date | string | null | undefined;

export type ServicesPaymentMatchForCalculation = {
  id?: string;
  invoiceEvidenceId?: string;
  ledgerEntryId: string;
  settlementDate: DateLike;
  settlementCurrency: string | null;
  settlementAmount: MoneyLike;
  settlementExchangeRateToPkr: MoneyLike;
  invoiceCurrencyAmount: MoneyLike;
  exchangeRateToPkr: MoneyLike;
  grossServiceAmountPkr: MoneyLike;
  netBankAmountPkr: MoneyLike;
  withholdingTaxPkr: MoneyLike;
  platformFeePkr: MoneyLike;
  bankFeePkr: MoneyLike;
  payoutReference: string | null;
  evidenceReference: string | null;
  recordStatus: string;
};

export type ServicesInvoiceForCalculation = {
  id: string;
  invoiceNumber: string | null;
  invoiceDate: DateLike;
  dueDate: DateLike;
  clientName: string | null;
  serviceDescription: string | null;
  invoiceAmount: MoneyLike;
  currency: string | null;
  exchangeRateToPkr: MoneyLike;
  fxEvidenceReference: string | null;
  subcategory: string | null;
  paymentStatus: string | null;
  evidenceStatus: string;
  paymentMatches: ServicesPaymentMatchForCalculation[];
};

export type ServicesLedgerCreditForCalculation = {
  id: string;
  amount: MoneyLike;
  entryDate: DateLike;
};

export type ServicesIncomeEvidenceResult =
  | {
      ok: true;
      accountingMethod: ServicesAccountingMethod;
      incomeBySubcategory: Record<string, number>;
      /** Recognized gross income by invoice evidence ID; never includes the bank credit twice. */
      incomeByInvoice: Record<string, number>;
      incomeTotal: number;
    }
  | { ok: false; errors: string[] };

const FIELD_ALIASES: Record<string, string> = {
  invoice_number: "invoiceNumber",
  invoice_no: "invoiceNumber",
  invoice_date: "invoiceDate",
  date_of_invoice: "invoiceDate",
  due_date: "dueDate",
  invoice_due_date: "dueDate",
  payment_due_date: "dueDate",
  income_due_date: "dueDate",
  amount_due_date: "dueDate",
  client: "clientName",
  client_name: "clientName",
  customer: "clientName",
  service: "serviceDescription",
  service_description: "serviceDescription",
  description_of_services: "serviceDescription",
  quantity: "quantity",
  unit_rate: "unitRate",
  rate_per_unit: "unitRate",
  invoice_amount: "invoiceAmount",
  invoice_amount_original_currency: "invoiceAmount",
  amount_in_original_currency: "invoiceAmount",
  invoice_amount_pkr: "invoiceAmountPkr",
  currency: "currency",
  invoice_currency: "currency",
  exchange_rate_to_pkr: "exchangeRateToPkr",
  invoice_exchange_rate_to_pkr: "exchangeRateToPkr",
  pkr_exchange_rate: "exchangeRateToPkr",
  fx_evidence_reference: "fxEvidenceReference",
  exchange_rate_evidence: "fxEvidenceReference",
  ty2026_subcategory: "subcategory",
  freelancer_subcategory: "subcategory",
  service_subcategory: "subcategory",
  payment_status: "paymentStatus",
  // Payout facts printed on the invoice / payout statement. These were already
  // requested from extraction but were being dropped before the Review step,
  // which is why every payout amount had to be typed by hand.
  settlement_date: "settlementDate",
  payout_date: "settlementDate",
  settlement_currency: "settlementCurrency",
  payout_currency: "settlementCurrency",
  settlement_amount: "settlementAmount",
  // A summary sheet often prints the currency suffix. Without these two aliases
  // "Settlement Amount (PKR)" fell through to null, the payout block then had no
  // pre-fee amount, and Review rejected every fee-bearing invoice.
  settlement_amount_pkr: "settlementAmount",
  payout_settlement_amount: "settlementAmount",
  payout_settlement_amount_pkr: "settlementAmount",
  settlement_exchange_rate_to_pkr: "settlementExchangeRateToPkr",
  settlement_fx_rate_to_pkr: "settlementExchangeRateToPkr",
  gross_service_amount_pkr: "grossServiceAmountPkr",
  gross_service_amount: "grossServiceAmountPkr",
  withholding_tax_pkr: "withholdingTaxPkr",
  withholding_amount_pkr: "withholdingTaxPkr",
  withholding_section: "withholdingSection",
  statutory_section: "withholdingSection",
  withholding_iris_code: "withholdingIrisCode",
  iris_code: "withholdingIrisCode",
  withholding_evidence_reference: "withholdingEvidenceReference",
  withholding_certificate_reference: "withholdingEvidenceReference",
  platform_fee_pkr: "platformFeePkr",
  platform_fee: "platformFeePkr",
  receiving_bank_fee_pkr: "bankFeePkr",
  bank_fee_pkr: "bankFeePkr",
  receiving_bank_fee: "bankFeePkr",
  net_payout_pkr: "netPayoutPkr",
  net_bank_credit_pkr: "netPayoutPkr",
  net_payout: "netPayoutPkr",
  payout_reference: "payoutReference",
  payout_id: "payoutReference",
  transaction_reference: "payoutReference",
  payout_evidence_reference: "evidenceReference",
  payment_evidence_reference: "evidenceReference",
  income_character: "incomeCharacter",
  income_character_pkr: "incomeCharacter",
};

function normalizeLabel(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "")
    .trim()
    .replace(/[\s\u00a0]/g, "")
    .replace(/PKR|USD|EUR|GBP|AED|SAR/gi, "")
    .replace(/[₨$€£]/g, "")
    .replace(/,/g, "");
  if (!text || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : null;
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value ?? "").trim();
  if (!text) return null;
  // Extraction must normalize invoice dates to ISO; locale dates are ambiguous.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  )
    return null;
  return parsed;
}

function isoDateOnly(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/** Reads the payout block persisted on an invoice row (detailsJson). */
export function parseServicesDerivedPayout(
  detailsJson: string | null | undefined,
): ServicesDerivedPayout | null {
  if (!detailsJson) return null;
  try {
    const parsed: unknown = JSON.parse(detailsJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const payout = (parsed as { derivedPayout?: unknown }).derivedPayout;
    if (!payout || typeof payout !== "object" || Array.isArray(payout)) return null;
    const empty = Object.values(payout as Record<string, unknown>).every(
      (value) => value === null || value === undefined || value === "",
    );
    return empty ? null : (payout as ServicesDerivedPayout);
  } catch {
    return null;
  }
}

function parsePaymentStatus(value: unknown): ServicesPaymentStatus | null {
  const normalized = normalizeLabel(value);
  if (["no_receipt_ty", "no_receipt_this_tax_year", "no_receipt_during_ty2026", "unpaid"].includes(normalized))
    return "NO_RECEIPT_TY";
  if (["partial_ty", "partially_received", "partially_received_during_ty2026", "part_paid"].includes(normalized))
    return "PARTIAL_TY";
  if (["full_ty", "fully_received", "fully_received_during_ty2026", "paid_in_full"].includes(normalized))
    return "FULL_TY";
  return null;
}

/**
 * Converts the extraction provider's label/value fields to stable invoice rows.
 * Numeric row suffixes are respected; duplicate unnumbered fields are reported
 * instead of guessed into an invoice-to-value pairing.
 */
export function parseServicesInvoiceSummaryFields(
  fields: ExtractedField[] | null | undefined,
): ParsedServicesInvoice[] {
  const rows = new Map<number, Record<string, unknown>>();
  const duplicates = new Map<number, Set<string>>();

  for (const field of fields ?? []) {
    const normalized = normalizeLabel(field.label);
    if (!normalized) continue;
    const suffixMatch = normalized.match(/^(.*?)(?:_row)?_(\d+)$/);
    const baseLabel = suffixMatch ? suffixMatch[1] : normalized;
    const rowNumber = suffixMatch ? Number(suffixMatch[2]) : 1;
    const fieldName = FIELD_ALIASES[baseLabel];
    if (!fieldName) continue;

    const row = rows.get(rowNumber) ?? {};
    if (Object.prototype.hasOwnProperty.call(row, fieldName)) {
      const seen = duplicates.get(rowNumber) ?? new Set<string>();
      seen.add(fieldName);
      duplicates.set(rowNumber, seen);
    }
    if (!Object.prototype.hasOwnProperty.call(row, fieldName) || row[fieldName] == null)
      row[fieldName] = field.value;
    rows.set(rowNumber, row);
  }

  return Array.from(rows.entries())
    .sort(([left], [right]) => left - right)
    .map(([rowNumber, row]) => {
      const issues: string[] = [];
      for (const duplicate of duplicates.get(rowNumber) ?? [])
        issues.push(`Invoice row ${rowNumber} has more than one ${duplicate} value.`);

      const explicitPkrAmount = parseNumber(row.invoiceAmountPkr);
      const explicitCurrency = normalizeText(row.currency)?.toUpperCase() ?? null;
      const currency = explicitCurrency ?? (explicitPkrAmount !== null ? "PKR" : null);
      const invoiceAmount =
        explicitCurrency && explicitCurrency !== "PKR"
          ? parseNumber(row.invoiceAmount)
          : (parseNumber(row.invoiceAmount) ?? explicitPkrAmount);
      const currencyCode = currency && /^[A-Z]{3}$/.test(currency) ? currency : null;
      const rate = parseNumber(row.exchangeRateToPkr);
      const invoiceNumber = normalizeText(row.invoiceNumber);
      const payout: ServicesDerivedPayout = {
        settlementDate: isoDateOnly(parseDate(row.settlementDate)),
        settlementCurrency:
          (normalizeText(row.settlementCurrency) ?? "").toUpperCase().length === 3
            ? (normalizeText(row.settlementCurrency) ?? "").toUpperCase()
            : null,
        settlementAmount: parseNumber(row.settlementAmount),
        settlementExchangeRateToPkr: parseNumber(row.settlementExchangeRateToPkr),
        grossServiceAmountPkr: parseNumber(row.grossServiceAmountPkr),
        withholdingTaxPkr: parseNumber(row.withholdingTaxPkr),
        withholdingSection: normalizeText(row.withholdingSection),
        withholdingIrisCode: normalizeText(row.withholdingIrisCode),
        withholdingEvidenceReference: normalizeText(row.withholdingEvidenceReference),
        platformFeePkr: parseNumber(row.platformFeePkr),
        bankFeePkr: parseNumber(row.bankFeePkr),
        netPayoutPkr: parseNumber(row.netPayoutPkr),
        payoutReference: normalizeText(row.payoutReference),
        evidenceReference: normalizeText(row.evidenceReference),
        incomeCharacter: normalizeText(row.incomeCharacter),
      };
      const parsed = {
        invoiceKey: `row-${rowNumber}`,
        invoiceNumber,
        invoiceDate: parseDate(row.invoiceDate),
        dueDate: parseDate(row.dueDate),
        clientName: normalizeText(row.clientName),
        serviceDescription: normalizeText(row.serviceDescription),
        quantity: parseNumber(row.quantity),
        unitRate: parseNumber(row.unitRate),
        invoiceAmount,
        currency: currencyCode,
        exchangeRateToPkr: rate,
        fxEvidenceReference: normalizeText(row.fxEvidenceReference),
        subcategory: normalizeText(row.subcategory),
        paymentStatus: parsePaymentStatus(row.paymentStatus),
        payout,
        issues,
      };
      if (explicitCurrency && !currencyCode)
        issues.push(`Invoice row ${rowNumber} has an invalid currency code.`);
      if (invoiceAmount === null)
        issues.push(`Invoice row ${rowNumber} is missing a valid invoice amount.`);
      if (!currencyCode)
        issues.push(`Invoice row ${rowNumber} is missing a valid currency code.`);
      if (!parsed.invoiceDate)
        issues.push(`Invoice row ${rowNumber} is missing an ISO invoice date.`);
      if (!parsed.clientName)
        issues.push(`Invoice row ${rowNumber} is missing a client name.`);
      if (!parsed.serviceDescription)
        issues.push(`Invoice row ${rowNumber} is missing a service description.`);
      if (explicitCurrency && explicitCurrency !== "PKR" && explicitPkrAmount !== null && invoiceAmount === null)
        issues.push(`Invoice row ${rowNumber} must include the amount in its original currency.`);
      return parsed;
    });
}

function asNumber(value: MoneyLike): number | null {
  if (value == null) return null;
  const number = typeof value === "number" ? value : Number(value.toString());
  return Number.isFinite(number) ? number : null;
}

function cents(value: MoneyLike): number | null {
  const number = asNumber(value);
  if (number === null || Math.abs(number) > Number.MAX_SAFE_INTEGER / 100)
    return null;
  return Math.round(number * 100);
}

function roundCents(value: number): number | null {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER / 100)
    return null;
  return Math.round(value * 100);
}

function toDate(value: DateLike): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isInTaxYear(date: Date, taxYear: number) {
  const start = Date.UTC(taxYear - 1, 6, 1, 0, 0, 0, 0);
  const end = Date.UTC(taxYear, 5, 30, 23, 59, 59, 999);
  return date.getTime() >= start && date.getTime() <= end;
}

function roundPkr(centsValue: number) {
  return Math.round(centsValue) / 100;
}

function validCurrency(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

function addError(errors: string[], message: string) {
  if (!errors.includes(message)) errors.push(message);
}

/**
 * Fail-closed Services income calculation. Cash basis uses verified gross
 * service amounts on dated payout matches; accrual basis uses verified invoice
 * amounts due in the tax year. Bank receipts are only reconciliation evidence,
 * never a second income amount.
 */
export function evaluateServicesIncomeEvidence(input: {
  taxYear: number;
  accountingMethod: string | null | undefined;
  selectedSubcategories: string[];
  invoices: ServicesInvoiceForCalculation[];
  ledgerCredits: ServicesLedgerCreditForCalculation[];
}): ServicesIncomeEvidenceResult {
  const errors: string[] = [];
  if (
    !input.accountingMethod ||
    !SERVICES_ACCOUNTING_METHODS.includes(
      input.accountingMethod as ServicesAccountingMethod,
    )
  )
    addError(errors, "Select the accounting method regularly used for Services income.");
  if (!input.selectedSubcategories.length)
    addError(errors, "Select at least one TY2026 Services subcategory.");
  if (!input.invoices.length)
    addError(errors, "Review and confirm at least one Services invoice before calculation.");

  const method = input.accountingMethod as ServicesAccountingMethod;
  const selected = new Set(input.selectedSubcategories);
  const ledgerById = new Map<string, { cents: number; date: Date | null }>();
  for (const ledgerCredit of input.ledgerCredits) {
    const amountCents = cents(ledgerCredit.amount);
    if (amountCents === null || amountCents <= 0) {
      addError(errors, "A Services bank-ledger credit has an invalid or non-positive amount.");
      continue;
    }
    const entryDate = toDate(ledgerCredit.entryDate);
    if (!entryDate || !isInTaxYear(entryDate, input.taxYear))
      addError(errors, "A Services bank-ledger credit is missing a valid date within the tax year.");
    ledgerById.set(ledgerCredit.id, { cents: amountCents, date: entryDate });
  }

  const allocatedNetByLedger = new Map<string, number>();
  const recognizedBySubcategory = new Map<string, number>();
  const recognizedByInvoice = new Map<string, number>();
  const usedInvoiceLedgerPairs = new Set<string>();

  for (const invoice of input.invoices) {
    const label = invoice.invoiceNumber?.trim() || invoice.id;
    if (invoice.evidenceStatus !== "CONFIRMED")
      addError(errors, `Invoice ${label} has not been reviewed and confirmed.`);
    if (!toDate(invoice.invoiceDate))
      addError(errors, `Invoice ${label} is missing a valid invoice date.`);
    if (!invoice.clientName?.trim())
      addError(errors, `Invoice ${label} is missing its client name.`);
    if (!invoice.serviceDescription?.trim())
      addError(errors, `Invoice ${label} is missing its service description.`);
    if (!invoice.subcategory || !selected.has(invoice.subcategory))
      addError(errors, `Invoice ${label} must be assigned to a selected TY2026 Services subcategory.`);

    const invoiceAmountCents = cents(invoice.invoiceAmount);
    const currency = invoice.currency?.trim().toUpperCase() ?? "";
    if (invoiceAmountCents === null || invoiceAmountCents <= 0)
      addError(errors, `Invoice ${label} is missing a valid positive invoice amount.`);
    if (!validCurrency(currency))
      addError(errors, `Invoice ${label} is missing a valid three-letter currency code.`);

    let invoiceFxRate = asNumber(invoice.exchangeRateToPkr);
    if (currency === "PKR") {
      if (invoiceFxRate != null && Math.abs(invoiceFxRate - 1) > 0.0000001)
        addError(errors, `Invoice ${label} uses PKR and must have a PKR exchange rate of 1.`);
      invoiceFxRate = 1;
    } else if (method === "ACCRUAL") {
      if (invoiceFxRate === null || invoiceFxRate <= 0)
        addError(errors, `Invoice ${label} needs a verified invoice-date PKR exchange rate for accrual accounting.`);
      if (!invoice.fxEvidenceReference?.trim())
        addError(errors, `Invoice ${label} needs a reference for its invoice-date FX evidence.`);
    }

    if (method === "ACCRUAL") {
      const dueDate = toDate(invoice.dueDate);
      if (!dueDate)
        addError(errors, `Invoice ${label} needs an evidenced income-due date for accrual accounting.`);
      else if (
        isInTaxYear(dueDate, input.taxYear) &&
        invoiceAmountCents !== null &&
        invoiceFxRate !== null &&
        invoiceFxRate > 0 &&
        invoice.subcategory &&
        selected.has(invoice.subcategory)
      ) {
        const baseCents = roundCents((invoiceAmountCents / 100) * invoiceFxRate);
        if (baseCents === null || baseCents <= 0)
          addError(errors, `Invoice ${label} produces an invalid PKR tax base.`);
        else {
          recognizedBySubcategory.set(
            invoice.subcategory,
            (recognizedBySubcategory.get(invoice.subcategory) ?? 0) + baseCents,
          );
          recognizedByInvoice.set(
            invoice.id,
            (recognizedByInvoice.get(invoice.id) ?? 0) + baseCents,
          );
        }
      }
    }

    let invoiceCurrencyCents = 0;
    for (const match of invoice.paymentMatches ?? []) {
      if (match.recordStatus !== "CONFIRMED")
        addError(errors, `A payout match for invoice ${label} has not been reviewed and confirmed.`);
      const pairKey = `${invoice.id}:${match.ledgerEntryId}`;
      if (usedInvoiceLedgerPairs.has(pairKey))
        addError(errors, `Invoice ${label} has a duplicate link to the same bank credit.`);
      usedInvoiceLedgerPairs.add(pairKey);

      const ledger = ledgerById.get(match.ledgerEntryId);
      if (!ledger)
        addError(errors, `A payout match for invoice ${label} does not point to a Services bank-ledger credit in this tax year.`);
      const settlementDate = toDate(match.settlementDate);
      if (!settlementDate || !isInTaxYear(settlementDate, input.taxYear))
        addError(errors, `A payout match for invoice ${label} is missing a settlement date within the tax year.`);
      if (
        settlementDate &&
        ledger?.date &&
        settlementDate.toISOString().slice(0, 10) !== ledger.date.toISOString().slice(0, 10)
      )
        addError(errors, `The payout date for invoice ${label} does not match the linked bank credit date.`);

      const invoicePaidCents = cents(match.invoiceCurrencyAmount);
      const rate = asNumber(match.exchangeRateToPkr);
      const grossCents = cents(match.grossServiceAmountPkr);
      const netCents = cents(match.netBankAmountPkr);
      const withholdingCents = cents(match.withholdingTaxPkr);
      const platformFeeCents = cents(match.platformFeePkr);
      const bankFeeCents = cents(match.bankFeePkr);
      const matchCurrency = currency;
      if (invoicePaidCents === null || invoicePaidCents <= 0)
        addError(errors, `A payout match for invoice ${label} needs a positive amount in the invoice currency.`);
      else invoiceCurrencyCents += invoicePaidCents;
      if (rate === null || rate <= 0)
        addError(errors, `A payout match for invoice ${label} needs a positive verified PKR exchange rate.`);
      if (matchCurrency === "PKR" && rate !== null && Math.abs(rate - 1) > 0.0000001)
        addError(errors, `A PKR invoice payout for ${label} must use an exchange rate of 1.`);
      if (
        matchCurrency !== "PKR" &&
        !match.evidenceReference?.trim() &&
        !match.payoutReference?.trim()
      )
        addError(errors, `A foreign-currency payout match for invoice ${label} needs an FX/payout evidence reference.`);
      if (grossCents === null || grossCents <= 0)
        addError(errors, `A payout match for invoice ${label} needs a positive gross service amount in PKR.`);
      if (netCents === null || netCents <= 0)
        addError(errors, `A payout match for invoice ${label} needs a positive net bank amount in PKR.`);
      if (withholdingCents === null || withholdingCents < 0)
        addError(errors, `A payout match for invoice ${label} needs an explicit non-negative withholding amount.`);
      if (platformFeeCents === null || platformFeeCents < 0)
        addError(errors, `A payout match for invoice ${label} needs an explicit non-negative platform-fee amount.`);
      if (bankFeeCents === null || bankFeeCents < 0)
        addError(errors, `A payout match for invoice ${label} needs an explicit non-negative receiving-bank fee.`);

      if (
        invoicePaidCents !== null &&
        rate !== null &&
        rate > 0 &&
        grossCents !== null
      ) {
        const expectedGrossCents = roundCents((invoicePaidCents / 100) * rate);
        if (expectedGrossCents === null || expectedGrossCents !== grossCents)
          addError(errors, `Gross PKR for a payout match on invoice ${label} does not reconcile to its invoice-currency amount and FX rate.`);
      }

      if (
        grossCents !== null &&
        netCents !== null &&
        withholdingCents !== null &&
        platformFeeCents !== null &&
        bankFeeCents !== null &&
        grossCents !== netCents + withholdingCents + platformFeeCents + bankFeeCents
      )
        addError(errors, `Gross service amount for invoice ${label} must equal net bank credit plus withholding, platform fees and bank fees.`);

      const settlementCurrency = match.settlementCurrency?.trim().toUpperCase() ?? "";
      const settlementAmountCents = cents(match.settlementAmount);
      const settlementRate = asNumber(match.settlementExchangeRateToPkr);
      if (!validCurrency(settlementCurrency))
        addError(errors, `A payout match for invoice ${label} needs a three-letter settlement currency.`);
      if (settlementAmountCents === null || settlementAmountCents <= 0)
        addError(errors, `A payout match for invoice ${label} needs a positive evidenced payout amount.`);
      if (settlementRate === null || settlementRate <= 0)
        addError(errors, `A payout match for invoice ${label} needs a positive payout-to-PKR exchange rate.`);
      if (settlementCurrency === "PKR" && settlementRate !== null && Math.abs(settlementRate - 1) > 0.0000001)
        addError(errors, `A PKR settlement for invoice ${label} must use an exchange rate of 1.`);
      if (!match.evidenceReference?.trim() && !match.payoutReference?.trim())
        addError(errors, `A payout match for invoice ${label} needs a payout statement/reference.`);
      if (
        settlementAmountCents !== null &&
        settlementRate !== null &&
        settlementRate > 0 &&
        netCents !== null &&
        bankFeeCents !== null
      ) {
        const payoutNetPkrCents = roundCents((settlementAmountCents / 100) * settlementRate);
        if (payoutNetPkrCents !== netCents + bankFeeCents)
          addError(errors, `The evidenced payout amount for invoice ${label} does not reconcile to the bank credit and receiving-bank fee.`);
      }

      if (ledger && netCents !== null && netCents > 0)
        allocatedNetByLedger.set(
          match.ledgerEntryId,
          (allocatedNetByLedger.get(match.ledgerEntryId) ?? 0) + netCents,
        );

      if (
        method === "CASH" &&
        settlementDate &&
        isInTaxYear(settlementDate, input.taxYear) &&
        grossCents !== null &&
        grossCents > 0 &&
        invoice.subcategory &&
        selected.has(invoice.subcategory)
      ) {
        recognizedBySubcategory.set(
          invoice.subcategory,
          (recognizedBySubcategory.get(invoice.subcategory) ?? 0) + grossCents,
        );
        recognizedByInvoice.set(
          invoice.id,
          (recognizedByInvoice.get(invoice.id) ?? 0) + grossCents,
        );
      }
    }

    if (method === "CASH") {
      const status = invoice.paymentStatus;
      if (!SERVICES_PAYMENT_STATUSES.includes(status as ServicesPaymentStatus))
        addError(errors, `Invoice ${label} must be marked as no receipt, partial receipt, or full receipt in this tax year.`);
      if (invoiceAmountCents !== null) {
        if (invoiceCurrencyCents > invoiceAmountCents)
          addError(errors, `Payout allocations linked to invoice ${label} exceed its invoiced amount.`);
        if (status === "NO_RECEIPT_TY" && invoiceCurrencyCents !== 0)
          addError(errors, `Invoice ${label} is marked no-receipt but has payout matches.`);
        if (status === "PARTIAL_TY" && (invoiceCurrencyCents <= 0 || invoiceCurrencyCents >= invoiceAmountCents))
          addError(errors, `Invoice ${label} is marked partial but its matched amount is not partial.`);
        if (status === "FULL_TY" && invoiceCurrencyCents !== invoiceAmountCents)
          addError(errors, `Invoice ${label} is marked fully received but matched invoice-currency amounts do not equal the invoice total.`);
      }
    }
  }

  for (const ledgerCredit of input.ledgerCredits) {
    const expected = cents(ledgerCredit.amount);
    if (expected === null) continue;
    const allocated = allocatedNetByLedger.get(ledgerCredit.id) ?? 0;
    if (allocated !== expected)
      addError(errors, `Services bank credit ${ledgerCredit.id} must be allocated exactly once across invoice payout matches (bank credit ${roundPkr(expected)} PKR; allocated ${roundPkr(allocated)} PKR).`);
  }

  if (errors.length) return { ok: false, errors };
  const incomeBySubcategory: Record<string, number> = {};
  for (const [subcategory, amountCents] of recognizedBySubcategory)
    incomeBySubcategory[subcategory] = roundPkr(amountCents);
  const incomeByInvoice: Record<string, number> = {};
  for (const [invoiceId, amountCents] of recognizedByInvoice)
    incomeByInvoice[invoiceId] = roundPkr(amountCents);
  const incomeTotal = roundPkr(
    Object.values(incomeBySubcategory).reduce((sum, amount) => sum + Math.round(amount * 100), 0),
  );
  return {
    ok: true,
    accountingMethod: method,
    incomeBySubcategory,
    incomeByInvoice,
    incomeTotal,
  };
}
