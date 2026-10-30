/**
 * What the Sindh services screens show for one month, built from the stored
 * lines and figures. Pure: the server action loads the rows, this builds the
 * state, and the same function runs after every change so a screen can never
 * show something the engine would not compute.
 */

import { getSrbDueDates } from "../rules/srb-services";
import type { IsoDate, SalesTaxProblem, TaxPeriod } from "../types";
import { computeSrbReturn } from "./compute";
import { srbFingerprintOf, isApprovalCurrent } from "./estimate";
import { parseStoredSrbFigures } from "./figures";
import type {
  SrbFigures,
  SrbPurchaseEntry,
  SrbReturnLine,
  SrbSaleEntry,
} from "./types";
import { buildSrbWorksheet } from "./worksheet";

export type SrbEntryKind = "SALES" | "PURCHASES";

/** Stored in SalesTaxUpload.kind; the grid column holds the entries. */
export const SRB_UPLOAD_KIND: Record<SrbEntryKind, string> = {
  SALES: "SRB_SALES",
  PURCHASES: "SRB_PURCHASES",
};

export const MAX_SRB_ENTRIES = 500;

export function isSrbEntryKind(value: unknown): value is SrbEntryKind {
  return value === "SALES" || value === "PURCHASES";
}

/** Keeps the stored objects that can be lines at all; the checks judge the rest. */
export function parseStoredSrbEntries<T extends { id: string }>(stored: unknown): T[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (item): item is T =>
      !!item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string",
  );
}

export interface SrbReview {
  canEstimate: boolean;
  problems: SalesTaxProblem[];
  lines: SrbReturnLine[];
  balancePayable: number | null;
  reducedRateOutput: number;
  payableUnconfirmed: true;
  /** Text the user copies and keeps beside the portal. */
  worksheet: string;
  approval: { approvedAt: string; current: boolean } | null;
}

export interface SrbMonthState {
  sales: SrbSaleEntry[];
  purchases: SrbPurchaseEntry[];
  figures: SrbFigures;
  review: SrbReview;
  dueDates: { annexC: string; payment: string; returnFiling: string } | null;
}

export function srbDueDatesOf(period: TaxPeriod) {
  const due = getSrbDueDates(period);
  return due ? { annexC: due.annexC, payment: due.payment, returnFiling: due.returnFiling } : null;
}

export function buildSrbMonthState(input: {
  period: TaxPeriod;
  businessName: string;
  registrationNo: string;
  uploads: { kind: string; grid: unknown }[];
  figures: unknown;
  approvedAt: Date | null;
  approvedPacket: unknown;
  today: IsoDate;
}): SrbMonthState {
  const gridOf = (kind: SrbEntryKind) => input.uploads.find((row) => row.kind === SRB_UPLOAD_KIND[kind])?.grid;
  const sales = parseStoredSrbEntries<SrbSaleEntry>(gridOf("SALES"));
  const purchases = parseStoredSrbEntries<SrbPurchaseEntry>(gridOf("PURCHASES"));
  const figures = parseStoredSrbFigures(input.figures);
  const result = computeSrbReturn({ period: input.period, sales, purchases, figures, today: input.today });
  const fingerprint = srbFingerprintOf({
    period: input.period,
    registrationNo: input.registrationNo,
    figures,
    sales,
    purchases,
    result,
  });
  return {
    sales,
    purchases,
    figures,
    dueDates: srbDueDatesOf(input.period),
    review: {
      canEstimate: result.canEstimate,
      problems: result.problems,
      lines: result.lines,
      balancePayable: result.balancePayable,
      reducedRateOutput: result.reducedRateOutput,
      payableUnconfirmed: true,
      worksheet: buildSrbWorksheet({
        businessName: input.businessName,
        registrationNo: input.registrationNo,
        period: input.period,
        result,
        sales,
        purchases,
      }),
      approval: input.approvedAt
        ? {
            approvedAt: input.approvedAt.toISOString(),
            current: isApprovalCurrent(input.approvedPacket, { fingerprint }),
          }
        : null,
    },
  };
}
