/**
 * Types for the Sindh services (SRB) return, form SST-03.
 *
 * Amounts are whole paisa. Credit notes are stored as positive amounts with
 * their document type; the engine applies the sign.
 */

import type { Paisa } from "../money";
import type { IsoDate, SalesTaxProblem, TaxPeriod } from "../types";

export type SrbBuyerType = "END_CONSUMER" | "INTERMEDIARY";
/** SI sale invoice, CN credit note, DN debit note (Annex-C). */
export type SrbSaleDocType = "SI" | "CN" | "DN";
/** PI purchase invoice, CN credit note, DN debit note (Annex-A). */
export type SrbPurchaseDocType = "PI" | "CN" | "DN";
export type SrbSupplierType = "REGISTERED" | "UNREGISTERED";
/** Services are classified by CPC code; goods bought for the business by HS code. */
export type SrbPurchaseKind = "SERVICES" | "GOODS";

/** Where an entry came from: typed in the form or read from the Excel template. */
export type SrbEntryOrigin = "typed" | "file";

/** One line of Annex-C: a sale of services. */
export interface SrbSaleEntry {
  id: string;
  origin: SrbEntryOrigin;
  buyerNtn: string;
  buyerName: string;
  buyerType: SrbBuyerType;
  docType: SrbSaleDocType;
  docNo: string;
  docDate: IsoDate;
  cpc: string;
  /** The rate option chosen for the line (see rules/srb-services/rates.ts). */
  rateId: string;
  valueExclTax: Paisa;
  salesTax: Paisa;
  /** Sales tax withheld by the buyer as withholding agent. */
  stWithheld: Paisa;
  /** Bills or persons, for specific-rate entries. */
  units: number | null;
  squareYards: number | null;
  squareFeet: number | null;
  /** Credit and debit notes: the invoice they correct, and why. */
  originalDocNo: string;
  reason: string;
}

/** One line of Annex-A: a purchase. */
export interface SrbPurchaseEntry {
  id: string;
  origin: SrbEntryOrigin;
  supplierNtn: string;
  supplierName: string;
  supplierType: SrbSupplierType;
  docType: SrbPurchaseDocType;
  docNo: string;
  docDate: IsoDate;
  kind: SrbPurchaseKind;
  /** CPC code for services. Empty for goods. */
  cpc: string;
  /** HS code for goods. Empty for services. */
  hsCode: string;
  /** Rate option for services. Empty for goods. */
  rateId: string;
  /** Goods: the rate on the supplier's invoice, as a fraction such as 0.18. */
  goodsRate: number | null;
  valueExclTax: Paisa;
  salesTax: Paisa;
  /** The part of the tax that cannot be claimed as input tax. */
  nonCreditable: Paisa;
  /** Annex-A reason code, "1" to "4". Empty when nothing is non-creditable. */
  nonCreditableReason: "" | "1" | "2" | "3" | "4";
  /** Tax withheld by this business as a withholding agent. */
  stWithheldAsAgent: Paisa;
  originalDocNo: string;
  reason: string;
}

/** One line of Annex-D: an export of services. */
export interface SrbExportEntry {
  id: string;
  buyerName: string;
  country: string;
  cpc: string;
  docNo: string;
  docDate: IsoDate;
  /** Value in rupees (paisa) after conversion. */
  amountPkr: Paisa;
}

/** Amounts the user types; every field is paisa and defaults to zero. */
export interface SrbFigures {
  /** Row 6: credit carried forward from the previous period. */
  creditBroughtForward6: Paisa;
  /** Row 3: input tax credit from Annex-E (capital goods) for this month. */
  annexECredit3: Paisa;
  /** Row 4, the part not taken from Annex-A: for example apportionment for reduced-rate or exempt sales. */
  otherNonCreditable4: Paisa;
  /** Row 7a: disallowed input credit and disallowed reduction of output tax (system figure on the portal). */
  disallowed7a: Paisa;
  /** Row 7b: allowance of input credit and reduction of output tax (system figure on the portal). */
  allowed7b: Paisa;
  /** Row 14: input tax still available for capital goods (Annex-E). */
  annexEBalance14: Paisa;
  /** Row 21: additional tax, default surcharge and others. */
  additionalTax21: Paisa;
  /** Row 22: arrears. */
  arrears22: Paisa;
  /** Row 23: penalty or fine. */
  penalty23: Paisa;
  /** True when this is an amended (revised) return. */
  amended: boolean;
  /** Row 25: tax paid on the normal or previous return. Amended returns only. */
  taxPaidPrevious25: Paisa;
  exports: SrbExportEntry[];
}

export type SrbLineStatus = "computed" | "input" | "fixed_zero" | "provisional";

export interface SrbReturnLine {
  /** The row number printed on SST-03, for example "9a". */
  sr: string;
  description: string;
  /** Value of supplies (excluding tax) where the row has one. */
  value: Paisa | null;
  /** The amount of the row. */
  amount: Paisa | null;
  status: SrbLineStatus;
  note: string | null;
}

export interface SrbReturnInput {
  period: TaxPeriod;
  sales: SrbSaleEntry[];
  purchases: SrbPurchaseEntry[];
  figures: SrbFigures;
  /** Today as YYYY-MM-DD, to warn about a late return. Left out in tests. */
  today?: IsoDate;
}

export interface SrbReturnResult {
  /** Always true: every figure is an estimate. */
  isEstimate: true;
  canEstimate: boolean;
  period: TaxPeriod;
  problems: SalesTaxProblem[];
  lines: SrbReturnLine[];
  bySr: Record<string, SrbReturnLine>;
  /**
   * Row 26, the balance payable (positive) or refundable (negative). It rests
   * on rows 11 to 17, which are provisional until one real portal return
   * confirms how row 13 treats reduced-rate output.
   */
  balancePayable: Paisa | null;
  /** True while rows 11 to 17 are not confirmed against the portal. */
  payableUnconfirmed: true;
  /** Reduced-rate output tax (row 9b) that the confirmation question turns on. */
  reducedRateOutput: Paisa;
  rulesUsed: string[];
}
