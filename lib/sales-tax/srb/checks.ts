/**
 * Checks across the stored Annex-C and Annex-A lines of one month.
 *
 * Every line is checked again with the same rules used when it was saved,
 * then the checks that need the whole list (duplicates, notes, rate
 * conditions) run.
 */

import { addMonthsIso, lastDayOfMonth } from "../dates";
import { formatRupees } from "../money";
import {
  findCpc,
  findRateOption,
  findSrbRuleNumber,
  getSrbDueDates,
  srbLateReturnPenalty,
} from "../rules/srb-services";
import type { IsoDate, SalesTaxProblem, TaxPeriod } from "../types";
import { checkPurchase, checkSale, type RawPurchase, type RawSale } from "./entries";
import { makeSrbProblem } from "./problems";
import type { SrbPurchaseEntry, SrbSaleEntry } from "./types";

function rawFrom<T extends object>(entry: T, map: Record<string, unknown> = {}): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) raw[key] = value === null ? "" : value;
  return { ...raw, ...map };
}

/** Stored paisa back to the rupee text the entry checks read. */
function rupees(paisa: number): string {
  const sign = paisa < 0 ? "-" : "";
  const abs = Math.abs(paisa);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function saleToRaw(entry: SrbSaleEntry): RawSale {
  return rawFrom(entry, {
    valueExclTax: rupees(entry.valueExclTax),
    salesTax: rupees(entry.salesTax),
    stWithheld: rupees(entry.stWithheld),
  }) as RawSale;
}

export function purchaseToRaw(entry: SrbPurchaseEntry): RawPurchase {
  return rawFrom(entry, {
    valueExclTax: rupees(entry.valueExclTax),
    salesTax: rupees(entry.salesTax),
    nonCreditable: rupees(entry.nonCreditable),
    stWithheldAsAgent: rupees(entry.stWithheldAsAgent),
    goodsRatePercent: entry.goodsRate === null ? "" : String(Math.round(entry.goodsRate * 10000) / 100),
  }) as RawPurchase;
}

export interface SrbInvoiceChecks {
  problems: SalesTaxProblem[];
  /** Line ids that failed the entry checks. */
  invalidSales: string[];
  invalidPurchases: string[];
}

export function checkSrbInvoices(input: {
  period: TaxPeriod;
  sales: SrbSaleEntry[];
  purchases: SrbPurchaseEntry[];
}): SrbInvoiceChecks {
  const { period } = input;
  const asOf = lastDayOfMonth(period);
  const problems: SalesTaxProblem[] = [];
  const invalidSales: string[] = [];
  const invalidPurchases: string[] = [];
  const optionsSeen = new Set<string>();

  const noteOption = (rateId: string) => {
    if (!rateId || optionsSeen.has(rateId)) return;
    optionsSeen.add(rateId);
    const option = findRateOption(rateId, asOf);
    if (!option || option.part !== "II") return;
    problems.push(
      makeSrbProblem("srb_option_condition", "return", null, {
        label: option.label,
        reference: option.reference,
        condition: option.condition ? `It applies only to: ${option.condition}` : "It applies only to the services named in the entry.",
        optionRequired: option.optionRequired ? 1 : 0,
      }),
    );
  };

  const seenSales = new Map<string, number>();
  input.sales.forEach((entry, index) => {
    const row = index + 1;
    const checked = checkSale(saleToRaw(entry), period, { id: entry.id, origin: entry.origin });
    if (checked.ok === false) {
      invalidSales.push(entry.id);
      problems.push(makeSrbProblem("srb_line_invalid", "sales", row, { detail: checked.first }));
      return;
    }
    const key = `${entry.docType}|${entry.docNo.toLowerCase()}`;
    const first = seenSales.get(key);
    if (first) {
      problems.push(makeSrbProblem("srb_duplicate_invoice", "sales", row, { first, docNo: entry.docNo }));
    } else {
      seenSales.set(key, row);
    }
    if ((entry.docType === "CN" || entry.docType === "DN") && entry.originalDocNo) {
      const found = input.sales.some(
        (other) => other.docType === "SI" && other.docNo.toLowerCase() === entry.originalDocNo.toLowerCase(),
      );
      if (!found) {
        problems.push(
          makeSrbProblem("srb_note_original_missing", "sales", row, {
            noteType: entry.docType === "CN" ? "credit note" : "debit note",
            original: entry.originalDocNo,
          }),
        );
      }
    }
    if (entry.cpc.length < 5 && findCpc(entry.cpc)) {
      problems.push(makeSrbProblem("srb_cpc_not_full", "sales", row, { cpc: entry.cpc }));
    }
    noteOption(entry.rateId);
  });

  const seenPurchases = new Map<string, number>();
  input.purchases.forEach((entry, index) => {
    const row = index + 1;
    const checked = checkPurchase(purchaseToRaw(entry), period, { id: entry.id, origin: entry.origin });
    if (checked.ok === false) {
      invalidPurchases.push(entry.id);
      problems.push(makeSrbProblem("srb_line_invalid", "purchases", row, { detail: checked.first }));
      return;
    }
    const key = `${entry.supplierNtn}|${entry.docType}|${entry.docNo.toLowerCase()}`;
    const first = seenPurchases.get(key);
    if (first) {
      problems.push(makeSrbProblem("srb_duplicate_invoice", "purchases", row, { first, docNo: entry.docNo }));
    } else {
      seenPurchases.set(key, row);
    }
    if (entry.supplierType === "UNREGISTERED" && entry.salesTax > 0) {
      problems.push(makeSrbProblem("srb_unregistered_supplier_tax", "purchases", row));
    }
    if (entry.kind === "SERVICES" && entry.cpc.length < 5 && findCpc(entry.cpc)) {
      problems.push(makeSrbProblem("srb_cpc_not_full", "purchases", row, { cpc: entry.cpc }));
    }
  });

  return { problems, invalidSales, invalidPurchases };
}

/** Warnings about filing late. `today` is a calendar day; nothing is checked without it. */
export function lateReturnProblems(period: TaxPeriod, today: IsoDate | undefined): SalesTaxProblem[] {
  if (!today) return [];
  const due = getSrbDueDates(period);
  if (!due) return [];
  const penalty = srbLateReturnPenalty(due.returnFiling, today);
  if (penalty.status !== "late") return [];
  const problems = [
    makeSrbProblem("srb_late_return", "return", null, {
      due: due.returnFiling,
      days: penalty.daysLate,
      penalty: formatRupees(penalty.penalty),
    }),
  ];
  const months = findSrbRuleNumber("srb.filing.late_months_without_approval", due.returnFiling);
  if (months !== null && today > addMonthsIso(due.returnFiling, months)) {
    problems.push(makeSrbProblem("srb_late_needs_approval", "return", null, { months }));
  }
  return problems;
}
