/**
 * Reading and checking one Annex-C sale, Annex-A purchase or Annex-D export
 * that the user typed or imported.
 *
 * The same functions run when a line is saved and again every time the month
 * is read, so a stored line can never slip past a rule that was added later.
 * Messages are plain English: what is wrong and what to do.
 */

import { firstDayOfMonth, isValidIso, lastDayOfMonth } from "../dates";
import { formatRupees, toPaisa, type Paisa } from "../money";
import {
  expectedTax,
  findCpc,
  findRateOption,
  normalizeCpcCode,
  rateOptionsForCpc,
  type SrbRateOption,
} from "../rules/srb-services";
import type { IsoDate, TaxPeriod } from "../types";
import type {
  SrbBuyerType,
  SrbExportEntry,
  SrbPurchaseDocType,
  SrbPurchaseEntry,
  SrbPurchaseKind,
  SrbSaleDocType,
  SrbSaleEntry,
  SrbSupplierType,
} from "./types";

/** Whole rupees of difference allowed between the tax on an invoice and the tax the rate gives. */
export const SRB_TAX_TOLERANCE_PAISA = 100;
/** Unregistered end consumers may be grouped on one line under this number (Annex-C notes). */
export const SRB_UNREGISTERED_BUYER_NTN = "99999981";
/** An input tax claim may be carried into this many tax periods after the invoice month (rule 22(1)). */
export const SRB_CLAIM_WINDOW_MONTHS = 6;

export type FieldErrors = Record<string, string>;
export type CheckResult<T> =
  | { ok: true; entry: T }
  | { ok: false; errors: FieldErrors; first: string };

/** What a form sends. Everything is text so a half-typed form can be checked. */
export type RawSale = Partial<Record<
  | "buyerNtn" | "buyerName" | "buyerType" | "docType" | "docNo" | "docDate" | "cpc"
  | "rateId" | "valueExclTax" | "salesTax" | "stWithheld" | "units" | "squareYards"
  | "squareFeet" | "originalDocNo" | "reason",
  unknown
>>;
export type RawPurchase = Partial<Record<
  | "supplierNtn" | "supplierName" | "supplierType" | "docType" | "docNo" | "docDate"
  | "kind" | "cpc" | "hsCode" | "rateId" | "goodsRatePercent" | "valueExclTax"
  | "salesTax" | "nonCreditable" | "nonCreditableReason" | "stWithheldAsAgent"
  | "originalDocNo" | "reason",
  unknown
>>;
export type RawExport = Partial<Record<
  "buyerName" | "country" | "cpc" | "docNo" | "docDate" | "amountPkr",
  unknown
>>;

const text = (value: unknown, max: number): string =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Digits only; registration numbers are compared and stored without dashes. */
export function cleanRegistration(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

export function newEntryId(): string {
  // A random id is enough: it only tells two lines of one month apart.
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function money(raw: unknown): Paisa | null {
  if (raw === "" || raw === null || raw === undefined) return null;
  return toPaisa(raw);
}

function count(raw: unknown): number | null {
  if (raw === "" || raw === null || raw === undefined) return null;
  const n = Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}

/** The first day an input tax claim made in `period` may reach back to. */
export function earliestClaimDate(period: TaxPeriod): IsoDate {
  let year = period.year;
  let month = period.month - SRB_CLAIM_WINDOW_MONTHS;
  while (month < 1) {
    month += 12;
    year -= 1;
  }
  return firstDayOfMonth({ year, month });
}

function result<T>(errors: FieldErrors, entry: T): CheckResult<T> {
  const keys = Object.keys(errors);
  if (keys.length === 0) return { ok: true, entry };
  return { ok: false, errors, first: errors[keys[0]] };
}

function checkNtn(label: string, value: string, errors: FieldErrors, field: string) {
  if (!value) {
    errors[field] = `${label} is empty. Enter the NTN or CNIC (digits only).`;
  } else if (value.length < 7 || value.length > 15) {
    errors[field] = `${label} should be 7 to 15 digits. Check the number.`;
  }
}

function checkCpc(
  cpcRaw: unknown,
  errors: FieldErrors,
  field = "cpc",
): string {
  const code = normalizeCpcCode(cpcRaw);
  if (!code) {
    errors[field] = "The service code (CPC) is empty. Search for the service and pick its code.";
  } else if (!findCpc(code)) {
    errors[field] = `${code} is not a service code in the SRB list (CPC version 2.1). Search for the service and pick its code.`;
  }
  return code;
}

function checkRate(
  cpc: string,
  rateIdRaw: unknown,
  asOf: IsoDate,
  errors: FieldErrors,
): SrbRateOption | null {
  const rateId = text(rateIdRaw, 40);
  if (!rateId) {
    errors.rateId = "Choose the rate that applies to this service.";
    return null;
  }
  const option = findRateOption(rateId, asOf);
  if (!option) {
    errors.rateId = "This rate is not in force for the month of this return. Choose the rate again.";
    return null;
  }
  if (cpc && !rateOptionsForCpc(cpc, asOf).some((o) => o.id === option.id)) {
    errors.rateId = "This rate does not apply to the service code you chose. Choose the rate again.";
    return null;
  }
  return option;
}

function taxMismatchMessage(option: SrbRateOption, expected: Paisa, value: Paisa): string {
  if (option.basis === "percent") {
    const percent = Math.round((option.rate ?? 0) * 10000) / 100;
    return `The tax should be ${formatRupees(expected)} (${percent}% of ${formatRupees(value)}). Check the rate or the amounts.`;
  }
  return `The tax should be ${formatRupees(expected)} for the bills, persons or area you entered. Check the amounts.`;
}

// ---------------------------------------------------------------------------
// Annex-C: sales
// ---------------------------------------------------------------------------

const SALE_DOC_TYPES: SrbSaleDocType[] = ["SI", "CN", "DN"];
const BUYER_TYPES: SrbBuyerType[] = ["END_CONSUMER", "INTERMEDIARY"];

export function checkSale(
  raw: RawSale,
  period: TaxPeriod,
  keep: { id?: string; origin?: "typed" | "file" } = {},
): CheckResult<SrbSaleEntry> {
  const errors: FieldErrors = {};
  const asOf = lastDayOfMonth(period);

  const docType = text(raw.docType, 4) as SrbSaleDocType;
  if (!SALE_DOC_TYPES.includes(docType)) errors.docType = "Choose sale invoice, credit note or debit note.";

  const buyerType = text(raw.buyerType, 20) as SrbBuyerType;
  if (!BUYER_TYPES.includes(buyerType)) errors.buyerType = "Choose whether the buyer is an end consumer or an intermediary.";

  const buyerNtn = cleanRegistration(raw.buyerNtn);
  checkNtn("The buyer's NTN or CNIC", buyerNtn, errors, "buyerNtn");
  const buyerName = text(raw.buyerName, 120);
  if (!buyerName) errors.buyerName = "The buyer's name is empty.";

  const docNo = text(raw.docNo, 40);
  if (!docNo) errors.docNo = "The invoice number is empty.";

  const docDate = text(raw.docDate, 10);
  if (!isValidIso(docDate)) {
    errors.docDate = "Enter the invoice date as a real date.";
  } else if (docDate < firstDayOfMonth(period) || docDate > lastDayOfMonth(period)) {
    errors.docDate = "This date is outside the month of the return. Annex-C lists only the sales of the return month.";
  }

  const cpc = checkCpc(raw.cpc, errors);
  const option = checkRate(cpc, raw.rateId, asOf, errors);

  const value = money(raw.valueExclTax);
  if (value === null) errors.valueExclTax = "The value excluding tax is empty or not an amount.";
  else if (value <= 0) errors.valueExclTax = "The value excluding tax must be more than zero. For a credit note, enter the amount as a positive number.";

  const units = count(raw.units);
  const squareYards = count(raw.squareYards);
  const squareFeet = count(raw.squareFeet);
  for (const [field, n, label] of [
    ["units", units, "The number of bills or persons"],
    ["squareYards", squareYards, "The land area in square yards"],
    ["squareFeet", squareFeet, "The covered area in square feet"],
  ] as const) {
    if (Number.isNaN(n)) errors[field] = `${label} is not a valid number.`;
  }
  if (option && !errors.units && !errors.squareYards && !errors.squareFeet) {
    if ((option.basis === "per_bill" || option.basis === "per_person") && (units === null || units <= 0)) {
      errors.units = option.basis === "per_bill"
        ? "Enter the number of bills. This rate is charged for each bill."
        : "Enter the number of persons. This rate is charged for each person.";
    }
    if (option.basis === "property_developer" && (squareYards === null || squareFeet === null)) {
      errors.squareYards = "Enter the land area in square yards and the covered area in square feet. Enter 0 where there is none.";
    }
  }

  const salesTax = money(raw.salesTax);
  if (salesTax === null) errors.salesTax = "The sales tax is empty or not an amount. Enter 0 if there is none.";
  else if (salesTax < 0) errors.salesTax = "The sales tax cannot be negative. For a credit note, enter the amount as a positive number.";
  if (option && value !== null && salesTax !== null && !errors.salesTax && !errors.units && !errors.squareYards) {
    const expected = expectedTax(option, value, {
      units: units ?? undefined,
      squareYards: squareYards ?? undefined,
      squareFeet: squareFeet ?? undefined,
    });
    if (expected !== null && Math.abs(salesTax - expected) > SRB_TAX_TOLERANCE_PAISA) {
      errors.salesTax = taxMismatchMessage(option, expected, value);
    }
  }

  const stWithheld = money(raw.stWithheld) ?? 0;
  if (money(raw.stWithheld) === null && String(raw.stWithheld ?? "").trim() !== "") {
    errors.stWithheld = "The tax withheld by the buyer is not an amount.";
  } else if (stWithheld < 0) {
    errors.stWithheld = "The tax withheld by the buyer cannot be negative.";
  } else if (salesTax !== null && stWithheld > salesTax) {
    errors.stWithheld = "The tax withheld by the buyer is more than the sales tax on the invoice.";
  }

  const originalDocNo = text(raw.originalDocNo, 40);
  const reason = text(raw.reason, 200);
  if (docType === "CN" || docType === "DN") {
    if (!originalDocNo) errors.originalDocNo = "Enter the number of the invoice this note corrects.";
    if (!reason) errors.reason = "Enter the reason for the note.";
  }

  const entry: SrbSaleEntry = {
    id: keep.id ?? newEntryId(),
    origin: keep.origin ?? "typed",
    buyerNtn,
    buyerName,
    buyerType,
    docType,
    docNo,
    docDate: docDate as IsoDate,
    cpc,
    rateId: option?.id ?? text(raw.rateId, 40),
    valueExclTax: value ?? 0,
    salesTax: salesTax ?? 0,
    stWithheld,
    units,
    squareYards,
    squareFeet,
    originalDocNo: docType === "SI" ? "" : originalDocNo,
    reason: docType === "SI" ? "" : reason,
  };
  return result(errors, entry);
}

// ---------------------------------------------------------------------------
// Annex-A: purchases
// ---------------------------------------------------------------------------

const PURCHASE_DOC_TYPES: SrbPurchaseDocType[] = ["PI", "CN", "DN"];
const SUPPLIER_TYPES: SrbSupplierType[] = ["REGISTERED", "UNREGISTERED"];
const PURCHASE_KINDS: SrbPurchaseKind[] = ["SERVICES", "GOODS"];

export function checkPurchase(
  raw: RawPurchase,
  period: TaxPeriod,
  keep: { id?: string; origin?: "typed" | "file" } = {},
): CheckResult<SrbPurchaseEntry> {
  const errors: FieldErrors = {};
  const asOf = lastDayOfMonth(period);

  const docType = text(raw.docType, 4) as SrbPurchaseDocType;
  if (!PURCHASE_DOC_TYPES.includes(docType)) errors.docType = "Choose purchase invoice, credit note or debit note.";

  const supplierType = text(raw.supplierType, 20) as SrbSupplierType;
  if (!SUPPLIER_TYPES.includes(supplierType)) errors.supplierType = "Choose whether the supplier is registered or unregistered.";

  const supplierNtn = cleanRegistration(raw.supplierNtn);
  if (supplierType === "REGISTERED" || supplierNtn) {
    checkNtn("The supplier's NTN or CNIC", supplierNtn, errors, "supplierNtn");
  }
  const supplierName = text(raw.supplierName, 120);
  if (!supplierName) errors.supplierName = "The supplier's name is empty.";

  const docNo = text(raw.docNo, 40);
  if (!docNo) errors.docNo = "The invoice number is empty.";

  const docDate = text(raw.docDate, 10);
  if (!isValidIso(docDate)) {
    errors.docDate = "Enter the invoice date as a real date.";
  } else if (docDate > lastDayOfMonth(period)) {
    errors.docDate = "This invoice is dated after the return month, so it cannot be claimed in this return.";
  } else if (docDate < earliestClaimDate(period)) {
    errors.docDate = `This invoice is more than ${SRB_CLAIM_WINDOW_MONTHS} months older than the return month. Input tax can be claimed only in the invoice month or the ${SRB_CLAIM_WINDOW_MONTHS} months after it.`;
  }

  const kind = text(raw.kind, 10) as SrbPurchaseKind;
  if (!PURCHASE_KINDS.includes(kind)) errors.kind = "Choose whether you bought services or goods.";

  let cpc = "";
  let hsCode = "";
  let option: SrbRateOption | null = null;
  let goodsRate: number | null = null;
  if (kind === "SERVICES") {
    cpc = checkCpc(raw.cpc, errors);
    option = checkRate(cpc, raw.rateId, asOf, errors);
  } else if (kind === "GOODS") {
    hsCode = text(raw.hsCode, 20).replace(/[^0-9.]/g, "");
    if (!hsCode) errors.hsCode = "The HS code of the goods is empty.";
    const percent = count(raw.goodsRatePercent);
    if (percent === null || Number.isNaN(percent)) {
      errors.goodsRatePercent = "Enter the sales tax rate on the supplier's invoice, for example 18.";
    } else if (percent > 50) {
      errors.goodsRatePercent = "This rate is too high. Enter the percentage shown on the invoice, for example 18.";
    } else {
      goodsRate = Math.round(percent * 100) / 10000;
    }
  }

  const value = money(raw.valueExclTax);
  if (value === null) errors.valueExclTax = "The value excluding tax is empty or not an amount.";
  else if (value <= 0) errors.valueExclTax = "The value excluding tax must be more than zero. For a credit note, enter the amount as a positive number.";

  const salesTax = money(raw.salesTax);
  if (salesTax === null) errors.salesTax = "The sales tax is empty or not an amount. Enter 0 if there is none.";
  else if (salesTax < 0) errors.salesTax = "The sales tax cannot be negative. For a credit note, enter the amount as a positive number.";
  if (value !== null && salesTax !== null && !errors.salesTax) {
    let expected: Paisa | null = null;
    if (option && option.basis === "percent") expected = expectedTax(option, value);
    if (goodsRate !== null) expected = expectedTax({ basis: "percent", rate: goodsRate } as SrbRateOption, value);
    if (expected !== null && Math.abs(salesTax - expected) > SRB_TAX_TOLERANCE_PAISA) {
      errors.salesTax = `The tax should be ${formatRupees(expected)} for this rate and value. Check the rate or the amounts.`;
    }
  }

  let nonCreditable = money(raw.nonCreditable) ?? 0;
  let nonCreditableReason = text(raw.nonCreditableReason, 2) as SrbPurchaseEntry["nonCreditableReason"];
  if (String(raw.nonCreditable ?? "").trim() !== "" && money(raw.nonCreditable) === null) {
    errors.nonCreditable = "The non-creditable tax is not an amount.";
  } else if (nonCreditable < 0) {
    errors.nonCreditable = "The non-creditable tax cannot be negative.";
  } else if (salesTax !== null && nonCreditable > salesTax) {
    errors.nonCreditable = "The non-creditable tax is more than the sales tax on the invoice.";
  }
  if (supplierType === "UNREGISTERED" && salesTax !== null) {
    // No credit can be claimed on tax shown by an unregistered supplier.
    nonCreditable = salesTax;
    nonCreditableReason = salesTax > 0 ? "3" : "";
    delete errors.nonCreditable;
  } else if (!errors.nonCreditable) {
    if (nonCreditable > 0 && !["1", "2", "3", "4"].includes(nonCreditableReason)) {
      errors.nonCreditableReason = "Choose the reason the tax cannot be claimed.";
    }
    if (nonCreditable === 0) nonCreditableReason = "";
  }

  const stWithheldAsAgent = money(raw.stWithheldAsAgent) ?? 0;
  if (String(raw.stWithheldAsAgent ?? "").trim() !== "" && money(raw.stWithheldAsAgent) === null) {
    errors.stWithheldAsAgent = "The tax you withheld is not an amount.";
  } else if (stWithheldAsAgent < 0) {
    errors.stWithheldAsAgent = "The tax you withheld cannot be negative.";
  } else if (salesTax !== null && stWithheldAsAgent > salesTax) {
    errors.stWithheldAsAgent = "The tax you withheld is more than the sales tax on the invoice.";
  }

  const originalDocNo = text(raw.originalDocNo, 40);
  const reason = text(raw.reason, 200);
  if (docType === "CN" || docType === "DN") {
    if (!originalDocNo) errors.originalDocNo = "Enter the number of the invoice this note corrects.";
    if (!reason) errors.reason = "Enter the reason for the note.";
  }

  const entry: SrbPurchaseEntry = {
    id: keep.id ?? newEntryId(),
    origin: keep.origin ?? "typed",
    supplierNtn,
    supplierName,
    supplierType,
    docType,
    docNo,
    docDate: docDate as IsoDate,
    kind,
    cpc,
    hsCode,
    rateId: option?.id ?? "",
    goodsRate,
    valueExclTax: value ?? 0,
    salesTax: salesTax ?? 0,
    nonCreditable,
    nonCreditableReason,
    stWithheldAsAgent,
    originalDocNo: docType === "PI" ? "" : originalDocNo,
    reason: docType === "PI" ? "" : reason,
  };
  return result(errors, entry);
}

// ---------------------------------------------------------------------------
// Annex-D: exports
// ---------------------------------------------------------------------------

export function checkExport(
  raw: RawExport,
  period: TaxPeriod,
  keep: { id?: string } = {},
): CheckResult<SrbExportEntry> {
  const errors: FieldErrors = {};
  const buyerName = text(raw.buyerName, 120);
  if (!buyerName) errors.buyerName = "The foreign buyer's name is empty.";
  const country = text(raw.country, 60);
  if (!country) errors.country = "The buyer's country is empty.";
  const cpc = checkCpc(raw.cpc, errors);
  const docNo = text(raw.docNo, 40);
  if (!docNo) errors.docNo = "The invoice number is empty.";
  const docDate = text(raw.docDate, 10);
  if (!isValidIso(docDate)) {
    errors.docDate = "Enter the invoice date as a real date.";
  } else if (docDate < firstDayOfMonth(period) || docDate > lastDayOfMonth(period)) {
    errors.docDate = "This date is outside the month of the return.";
  }
  const amount = money(raw.amountPkr);
  if (amount === null) errors.amountPkr = "The amount in rupees is empty or not an amount.";
  else if (amount <= 0) errors.amountPkr = "The amount must be more than zero.";
  const entry: SrbExportEntry = {
    id: keep.id ?? newEntryId(),
    buyerName,
    country,
    cpc,
    docNo,
    docDate: docDate as IsoDate,
    amountPkr: amount ?? 0,
  };
  return result(errors, entry);
}

/** The reason codes as printed in the notes of Annex-A. */
export const SRB_NON_CREDITABLE_REASONS: ReadonlyArray<{ code: "1" | "2" | "3" | "4"; label: string }> = [
  { code: "1", label: "Reduced-rate credit disallowed" },
  { code: "2", label: "\"Up to 15%\" credit allowed" },
  { code: "3", label: "Unregistered supplier, credit disallowed" },
  { code: "4", label: "\"Up to 19.5%\" credit allowed" },
];
