/**
 * Invoices typed in by hand instead of (or next to) the IRIS Excel template.
 *
 * Each typed invoice is turned into one row of the same cell grid the template
 * reader already understands, and appended to the uploaded file's rows (or to a
 * header built for this client and month when there is no file). Everything
 * after that, the reading, every row check, the return figures, is the same
 * code that handles a file, so typed invoices can never be checked by looser
 * rules than uploaded ones.
 *
 * Pure: no database, no browser.
 */

import { firstDayOfMonth, isValidIso, parseDateCell } from "./dates";
import { applyRate, toPaisa } from "./money";
import {
  findRuleNumber,
  saleTypeTreatment,
  SUPPORTED_SALE_TYPES,
  type SaleTypeTreatment,
} from "./rules/fbr-goods/catalog";
import {
  PURCHASE_TEMPLATE,
  SALES_TEMPLATE,
  type TemplateReference,
} from "./rules/fbr-goods/reference";
import {
  PURCHASE_COLUMNS,
  SALES_COLUMNS,
  type CellGrid,
} from "./template-reader";
import type { TaxPeriod } from "./types";

export type ManualKind = "SALES" | "PURCHASES";

/** Stored beside the uploaded file of the same month, under its own kind. */
export const MANUAL_KIND: Record<ManualKind, string> = {
  SALES: "SALES_MANUAL",
  PURCHASES: "PURCHASES_MANUAL",
};

/** More than this in one month is a job for the Excel template. */
export const MAX_MANUAL_INVOICES = 500;

/** Exactly what the person typed or chose, as text. */
export type ManualInvoice = {
  partyType: string;
  partyRegistrationNo: string;
  partyName: string;
  originProvince: string;
  destinationProvince: string;
  documentType: string;
  documentNo: string;
  /** YYYY-MM-DD */
  documentDate: string;
  /** Sale type (sales) or purchase type (purchases). */
  tradeType: string;
  /** "0.18", "0" or "Exempt": the same choices the template offers. */
  rate: string;
  /** Rupees excluding sales tax, two decimals. */
  value: string;
  salesTax: string;
  /** Sales only. */
  furtherTax: string;
  fixedValue: string;
  withheld: string;
  exemptionSroNo: string;
  exemptionItemSrNo: string;
  invoiceRefNo: string;
  reason: string;
};

const FIELD_ORDER: Array<keyof ManualInvoice> = [
  "partyType",
  "partyRegistrationNo",
  "partyName",
  "originProvince",
  "destinationProvince",
  "documentType",
  "documentNo",
  "documentDate",
  "tradeType",
  "rate",
  "value",
  "salesTax",
  "furtherTax",
  "fixedValue",
  "withheld",
  "exemptionSroNo",
  "exemptionItemSrNo",
  "invoiceRefNo",
  "reason",
];

const referenceFor = (kind: ManualKind): TemplateReference =>
  kind === "SALES" ? SALES_TEMPLATE : PURCHASE_TEMPLATE;

export interface ManualOptions {
  partyTypes: string[];
  documentTypes: string[];
  tradeTypes: string[];
  provinces: string[];
  sroNumbers: string[];
  itemSerials: string[];
  reasons: string[];
}

/** The choices the typing form offers; each is a value the template accepts. */
export function manualOptions(kind: ManualKind): ManualOptions {
  const reference = referenceFor(kind);
  return {
    partyTypes: reference.partyTypes,
    // Withholding documents (STWH) are refused by the estimate, so they are not offered.
    documentTypes: reference.documentTypes.filter((type) => type !== "STWH"),
    // Only the sale types the estimate can work out; the rest stay an Excel job.
    tradeTypes: SUPPORTED_SALE_TYPES.filter((type) => reference.saleTypes.includes(type)),
    provinces: reference.provinces,
    sroNumbers: reference.sroNumbers,
    itemSerials: reference.itemSerials,
    reasons: reference.reasons,
  };
}

export function partyWord(kind: ManualKind): string {
  return kind === "SALES" ? "buyer" : "seller";
}

export function treatmentOf(tradeType: string): SaleTypeTreatment {
  return saleTypeTreatment(tradeType);
}

/** True for sale types that must name an SRO or schedule entry. */
export function needsReference(tradeType: string): boolean {
  const treatment = treatmentOf(tradeType);
  return treatment === "reduced" || treatment === "zero_rated" || treatment === "exempt";
}

export function isNote(documentType: string): boolean {
  return documentType === "Credit Note" || documentType === "Debit Note";
}

const standardRateOn = (period: TaxPeriod): number | null =>
  findRuleNumber("fbr.rate.standard", firstDayOfMonth(period));

const furtherRateOn = (period: TaxPeriod): number | null =>
  findRuleNumber("fbr.rate.further_tax", firstDayOfMonth(period));

/** Text of a rate choice: "0.18" for a number, the label itself for text. */
const rateKey = (rate: number | string): string => String(rate);

/** The rates a typed invoice of this sale type may use. */
export function rateChoices(
  kind: ManualKind,
  tradeType: string,
  period: TaxPeriod,
): string[] {
  const treatment = treatmentOf(tradeType);
  const standard = standardRateOn(period);
  const numeric = referenceFor(kind).rates.filter(
    (rate): rate is number => typeof rate === "number",
  );
  switch (treatment) {
    case "standard":
      return standard === null ? [] : [rateKey(standard)];
    case "reduced":
      return numeric
        .filter((rate) => rate > 0 && standard !== null && rate < standard)
        .map(rateKey);
    case "zero_rated":
      return ["0"];
    case "exempt":
      return ["Exempt"];
    case "third_schedule":
      return numeric
        .filter((rate) => rate > 0 && standard !== null && rate <= standard)
        .map(rateKey);
    default:
      return [];
  }
}

/** "0.18" shown as "18%"; text such as "Exempt" is shown as it is. */
export function rateLabel(rate: string): string {
  if (/^\d*\.?\d+$/.test(rate)) return `${Number((Number(rate) * 100).toFixed(4))}%`;
  return rate;
}

export function emptyManualInvoice(kind: ManualKind): ManualInvoice {
  const options = manualOptions(kind);
  const tradeType = options.tradeTypes[0] ?? "";
  return {
    partyType: "",
    partyRegistrationNo: "",
    partyName: "",
    originProvince: "",
    destinationProvince: "",
    documentType: options.documentTypes[0] ?? "",
    documentNo: "",
    documentDate: "",
    tradeType,
    rate: "",
    value: "",
    salesTax: "",
    furtherTax: "",
    fixedValue: "",
    withheld: "",
    exemptionSroNo: "",
    exemptionItemSrNo: "",
    invoiceRefNo: "",
    reason: "",
  };
}

/** Whole paisa as "1234.50". */
function paisaText(paisa: number): string {
  const sign = paisa < 0 ? "-" : "";
  const absolute = Math.abs(paisa);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

/**
 * The tax the template rules expect for what has been typed so far, so the
 * form can fill the two tax boxes. They stay editable: the row checks still
 * compare whatever ends up stored with value times rate.
 */
export function suggestTax(
  kind: ManualKind,
  entry: Pick<
    ManualInvoice,
    "partyType" | "tradeType" | "rate" | "value" | "fixedValue"
  >,
  period: TaxPeriod,
): { salesTax: string; furtherTax: string } {
  const none = { salesTax: "", furtherTax: "" };
  const treatment = treatmentOf(entry.tradeType);
  const value = toPaisa(entry.value);
  if (treatment === "zero_rated" || treatment === "exempt") {
    return { salesTax: value === null ? "" : "0.00", furtherTax: "" };
  }
  if (!/^\d*\.?\d+$/.test(entry.rate)) return none;
  const base = treatment === "third_schedule" ? toPaisa(entry.fixedValue) : value;
  if (base === null || base < 0) return none;
  const salesTax = paisaText(applyRate(base, Number(entry.rate)));

  let furtherTax = "";
  const further = furtherRateOn(period);
  const unregisteredBuyer =
    kind === "SALES" &&
    (entry.partyType === "Unregistered" || entry.partyType === "Unregistered Distributor");
  if (unregisteredBuyer && further !== null) {
    furtherTax = paisaText(applyRate(base, further));
  }
  return { salesTax, furtherTax };
}

export type ManualCheck =
  | { ok: true; value: ManualInvoice }
  | { ok: false; error: string };

const TEXT_LIMITS = { name: 120, id: 30, number: 50 };
const MAX_PAISA = 1e13;

function textOf(input: Record<string, unknown>, field: keyof ManualInvoice): string {
  const raw = input[field];
  if (raw === null || raw === undefined) return "";
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  return String(raw).trim();
}

/** Reads an optional money field; returns its canonical text or an error. */
function money(label: string, raw: string, required = false): { ok: true; text: string } | { ok: false; error: string } {
  if (raw === "") {
    return required
      ? { ok: false, error: `Enter ${label}.` }
      : { ok: true, text: "" };
  }
  const paisa = toPaisa(raw);
  if (paisa === null) return { ok: false, error: `${label[0].toUpperCase()}${label.slice(1)} must be a number, for example 12500.50.` };
  if (paisa < 0) return { ok: false, error: `${label[0].toUpperCase()}${label.slice(1)} cannot be negative.` };
  if (paisa > MAX_PAISA) return { ok: false, error: `${label[0].toUpperCase()}${label.slice(1)} is too large.` };
  return { ok: true, text: paisaText(paisa) };
}

/**
 * Checks one typed invoice. Only what the form itself can get wrong is
 * refused here (a choice the template does not offer, an amount that is not a
 * number). Rule questions such as "does the tax match the rate" are left to
 * the row checks, which show them next to the invoice.
 */
export function validateManualInvoice(
  kind: ManualKind,
  input: unknown,
  period: TaxPeriod,
): ManualCheck {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Fill in the invoice details." };
  }
  const source = input as Record<string, unknown>;
  const text = (field: keyof ManualInvoice) => textOf(source, field);
  const options = manualOptions(kind);
  const word = partyWord(kind);

  const partyType = text("partyType");
  if (!options.partyTypes.includes(partyType)) {
    return { ok: false, error: `Choose the ${word} type.` };
  }
  const partyRegistrationNo = text("partyRegistrationNo");
  if (partyRegistrationNo.length > TEXT_LIMITS.id) {
    return { ok: false, error: `The ${word} registration number is too long.` };
  }
  const partyName = text("partyName");
  if (partyName.length > TEXT_LIMITS.name) {
    return { ok: false, error: `The ${word} name is too long.` };
  }
  const originProvince = text("originProvince");
  if (!options.provinces.includes(originProvince)) {
    return { ok: false, error: "Choose the province the supply starts from." };
  }
  const destinationProvince = text("destinationProvince");
  if (!options.provinces.includes(destinationProvince)) {
    return { ok: false, error: "Choose the province the supply goes to." };
  }
  const documentType = text("documentType");
  if (!options.documentTypes.includes(documentType)) {
    return { ok: false, error: "Choose the invoice type." };
  }
  const documentNo = text("documentNo");
  if (documentNo === "") return { ok: false, error: "Enter the invoice number." };
  if (documentNo.length > TEXT_LIMITS.number) {
    return { ok: false, error: "The invoice number is too long." };
  }
  const rawDate = text("documentDate");
  const parsedDate = rawDate === "" ? null : parseDateCell(rawDate);
  if (!parsedDate || !isValidIso(parsedDate)) {
    return { ok: false, error: "Enter the invoice date." };
  }
  const tradeType = text("tradeType");
  if (!options.tradeTypes.includes(tradeType)) {
    return { ok: false, error: kind === "SALES" ? "Choose the sale type." : "Choose the purchase type." };
  }
  const rate = text("rate");
  if (!rateChoices(kind, tradeType, period).includes(rate)) {
    return { ok: false, error: "Choose the rate." };
  }

  const value = money("the value excluding sales tax", text("value"), true);
  if (value.ok === false) return value;
  const salesTax = money("the sales tax", text("salesTax"));
  if (salesTax.ok === false) return salesTax;
  const furtherTax = kind === "SALES" ? money("the further tax", text("furtherTax")) : { ok: true as const, text: "" };
  if (furtherTax.ok === false) return furtherTax;
  const fixedValue = money("the fixed or retail value", text("fixedValue"));
  if (fixedValue.ok === false) return fixedValue;
  const withheld = money("the tax withheld", text("withheld"));
  if (withheld.ok === false) return withheld;

  const exemptionSroNo = text("exemptionSroNo");
  if (exemptionSroNo !== "" && !options.sroNumbers.includes(exemptionSroNo)) {
    return { ok: false, error: "Choose the SRO or schedule number from the list." };
  }
  const exemptionItemSrNo = text("exemptionItemSrNo");
  if (exemptionItemSrNo !== "" && !options.itemSerials.includes(exemptionItemSrNo)) {
    return { ok: false, error: "Choose the item serial number from the list." };
  }
  const invoiceRefNo = text("invoiceRefNo");
  if (invoiceRefNo.length > TEXT_LIMITS.number) {
    return { ok: false, error: "The original invoice number is too long." };
  }
  const reason = text("reason");
  if (reason !== "" && !options.reasons.includes(reason)) {
    return { ok: false, error: "Choose the reason from the list." };
  }
  if (isNote(documentType) && (invoiceRefNo === "" || reason === "")) {
    return {
      ok: false,
      error: "A credit or debit note needs the original invoice number and a reason.",
    };
  }

  return {
    ok: true,
    value: {
      partyType,
      partyRegistrationNo,
      partyName,
      originProvince,
      destinationProvince,
      documentType,
      documentNo,
      documentDate: parsedDate,
      tradeType,
      rate,
      value: value.text,
      salesTax: salesTax.text,
      furtherTax: furtherTax.text,
      fixedValue: fixedValue.text,
      withheld: withheld.text,
      exemptionSroNo,
      exemptionItemSrNo,
      invoiceRefNo,
      reason,
    },
  };
}

/** Reads stored entries back; anything that is not an entry is dropped. */
export function parseStoredManual(stored: unknown): ManualInvoice[] {
  if (!Array.isArray(stored)) return [];
  const result: ManualInvoice[] = [];
  for (const item of stored) {
    if (!item || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;
    const entry = emptyManualInvoice("SALES");
    for (const field of FIELD_ORDER) {
      const raw = source[field];
      entry[field] = typeof raw === "string" ? raw : "";
    }
    result.push(entry);
  }
  return result;
}

const LAST_DATA_COLUMN = 29;
const FIRST_DATA_ROW_INDEX = 5;

function rowHasData(row: unknown[] | undefined): boolean {
  if (!row) return false;
  for (let column = 1; column <= LAST_DATA_COLUMN; column += 1) {
    const cell = row[column];
    if (cell !== null && cell !== undefined && String(cell).trim() !== "") return true;
  }
  return false;
}

/** Index just after the last row of the file that holds anything. */
function dataEnd(grid: CellGrid): number {
  for (let index = grid.length - 1; index >= FIRST_DATA_ROW_INDEX; index -= 1) {
    if (rowHasData(grid[index] as unknown[])) return index + 1;
  }
  return FIRST_DATA_ROW_INDEX;
}

/** One cell for a rate: a number when the choice is a number. */
function rateCell(rate: string): number | string {
  return /^\d*\.?\d+$/.test(rate) ? Number(rate) : rate;
}

const amountCell = (text: string): number | null => (text === "" ? null : Number(text));

/** The 30 cells of one template row for a typed invoice. */
export function entryToCells(kind: ManualKind, entry: ManualInvoice): unknown[] {
  const cells: unknown[] = new Array(LAST_DATA_COLUMN + 1).fill(null);
  const set = (column: number, value: unknown) => {
    cells[column] = value === "" ? null : value;
  };
  if (kind === "SALES") {
    const c = SALES_COLUMNS;
    set(c.partyRegistrationNo, entry.partyRegistrationNo);
    set(c.partyName, entry.partyName);
    set(c.partyType, entry.partyType);
    set(c.originProvince, entry.originProvince);
    set(c.destinationProvince, entry.destinationProvince);
    set(c.documentType, entry.documentType);
    set(c.documentNo, entry.documentNo);
    set(c.documentDate, entry.documentDate);
    set(c.saleType, entry.tradeType);
    set(c.rate, rateCell(entry.rate));
    set(c.value, amountCell(entry.value));
    set(c.salesTax, amountCell(entry.salesTax));
    set(c.fixedOrRetailValue, amountCell(entry.fixedValue));
    set(c.furtherTax, amountCell(entry.furtherTax));
    set(c.stWithheld, amountCell(entry.withheld));
    set(c.exemptionSroNo, entry.exemptionSroNo);
    set(c.exemptionItemSrNo, entry.exemptionItemSrNo);
    set(c.invoiceRefNo, entry.invoiceRefNo);
    set(c.reason, entry.reason);
  } else {
    const c = PURCHASE_COLUMNS;
    set(c.partyRegistrationNo, entry.partyRegistrationNo);
    set(c.partyName, entry.partyName);
    set(c.partyType, entry.partyType);
    set(c.originProvince, entry.originProvince);
    set(c.destinationProvince, entry.destinationProvince);
    set(c.documentType, entry.documentType);
    set(c.documentNo, entry.documentNo);
    set(c.documentDate, entry.documentDate);
    set(c.purchaseType, entry.tradeType);
    set(c.rate, rateCell(entry.rate));
    set(c.value, amountCell(entry.value));
    set(c.salesTax, amountCell(entry.salesTax));
    set(c.fixedRetailValue, amountCell(entry.fixedValue));
    set(c.stWithheld, amountCell(entry.withheld));
    set(c.exemptionSroNo, entry.exemptionSroNo);
    set(c.exemptionItemSrNo, entry.exemptionItemSrNo);
    set(c.invoiceRefNo, entry.invoiceRefNo);
    set(c.reason, entry.reason);
  }
  return cells;
}

/** The five header rows of a template for this client and month. */
function headerFor(
  kind: ManualKind,
  registrationNo: string,
  period: TaxPeriod,
  count: number,
): unknown[][] {
  const reference = referenceFor(kind);
  const rows = reference.headerRows.map((row) => [...row]) as unknown[][];
  const month = String(period.month).padStart(2, "0");
  rows[1][2] = registrationNo;
  rows[1][5] = firstDayOfMonth(period);
  rows[2][1] = `${registrationNo}-01/${month}/${period.year}_~_${reference.templateKind}_~_${reference.templateVersion}`;
  rows[2][6] = String(count);
  rows[2][9] = "0";
  return rows;
}

/**
 * Sheet row (1-based, as shown to the person) of the first typed invoice: the
 * typed rows come straight after the last row of the uploaded file, or from
 * row 6 when there is no file.
 */
export function firstManualRow(fileGrid: CellGrid | null): number {
  return (fileGrid ? dataEnd(fileGrid) : FIRST_DATA_ROW_INDEX) + 1;
}

/**
 * The uploaded file's cells with the typed invoices after them. With no file,
 * a header for this client and month is built, so the typed invoices read as a
 * template of their own. With nothing typed the file is returned unchanged.
 */
export function mergeManualGrid(input: {
  kind: ManualKind;
  fileGrid: CellGrid | null;
  entries: ManualInvoice[];
  registrationNo: string;
  period: TaxPeriod;
}): CellGrid | null {
  if (input.entries.length === 0) return input.fileGrid;
  const typed = input.entries.map((entry) => entryToCells(input.kind, entry));
  const base: CellGrid = input.fileGrid
    ? (input.fileGrid.slice(0, dataEnd(input.fileGrid)) as CellGrid)
    : headerFor(input.kind, input.registrationNo, input.period, typed.length);
  return [...base, ...typed];
}
