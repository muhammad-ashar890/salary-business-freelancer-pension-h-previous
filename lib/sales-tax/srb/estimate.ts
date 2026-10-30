/**
 * From stored lines and typed figures to the estimate the user reviews, and
 * from an approved estimate to the packet a later phase works from.
 *
 * Pure: no database, no screens. An approval counts only while the lines and
 * figures still produce the same fingerprint, so a changed list can never
 * ride on an old approval.
 */

import { createHash } from "crypto";

import { isApprovalCurrent } from "../estimate";
import type { SalesTaxProblem, TaxPeriod } from "../types";
import { computeSrbReturn } from "./compute";
import type {
  SrbFigures,
  SrbPurchaseEntry,
  SrbReturnInput,
  SrbReturnResult,
  SrbSaleEntry,
} from "./types";

export { isApprovalCurrent };

export function buildSrbEstimate(input: SrbReturnInput): SrbReturnResult {
  return computeSrbReturn(input);
}

export interface SrbApprovalPacket {
  version: 1;
  approvedAt: string;
  authority: "SRB";
  period: TaxPeriod;
  businessName: string;
  registrationNo: string;
  figures: SrbFigures;
  sales: SrbSaleEntry[];
  purchases: SrbPurchaseEntry[];
  lines: {
    sr: string;
    description: string;
    value: number | null;
    amount: number | null;
    status: string;
  }[];
  balancePayable: number;
  /** True: rows 11 to 17 were not yet confirmed against a portal return when this was approved. */
  payableUnconfirmed: true;
  warnings: SalesTaxProblem[];
  rulesUsed: string[];
  fingerprint: string;
}

/** Warnings that depend on today's date are left out, so an approval does not go stale overnight. */
const isDateDependent = (problem: SalesTaxProblem) => problem.code.startsWith("srb_late");

export function srbFingerprintOf(input: {
  period: TaxPeriod;
  registrationNo: string;
  figures: SrbFigures;
  sales: SrbSaleEntry[];
  purchases: SrbPurchaseEntry[];
  result: SrbReturnResult;
}): string {
  const text = JSON.stringify({
    period: [input.period.year, input.period.month],
    registrationNo: input.registrationNo.replace(/\D/g, ""),
    figures: input.figures,
    sales: input.sales,
    purchases: input.purchases,
    canEstimate: input.result.canEstimate,
    lines: input.result.lines.map((line) => [line.sr, line.value, line.amount]),
    balance: input.result.balancePayable,
    problems: input.result.problems
      .filter((problem) => !isDateDependent(problem))
      .map((problem) => [problem.code, problem.row, problem.sheet]),
  });
  return createHash("sha256").update(text).digest("hex");
}

export type SrbPacketResult =
  | { ok: true; packet: SrbApprovalPacket }
  | { ok: false; error: string };

export function buildSrbApprovalPacket(input: {
  approvedAt: Date;
  period: TaxPeriod;
  businessName: string;
  registrationNo: string;
  figures: SrbFigures;
  sales: SrbSaleEntry[];
  purchases: SrbPurchaseEntry[];
  result: SrbReturnResult;
}): SrbPacketResult {
  if (!input.result.canEstimate || input.result.balancePayable === null) {
    return {
      ok: false,
      error: "This return cannot be approved yet. Fix the problems on the invoice check step first.",
    };
  }
  return {
    ok: true,
    packet: {
      version: 1,
      approvedAt: input.approvedAt.toISOString(),
      authority: "SRB",
      period: input.period,
      businessName: input.businessName,
      registrationNo: input.registrationNo,
      figures: input.figures,
      sales: input.sales,
      purchases: input.purchases,
      lines: input.result.lines.map((line) => ({
        sr: line.sr,
        description: line.description,
        value: line.value,
        amount: line.amount,
        status: line.status,
      })),
      balancePayable: input.result.balancePayable,
      payableUnconfirmed: true,
      warnings: input.result.problems.filter((problem) => !isDateDependent(problem)),
      rulesUsed: input.result.rulesUsed,
      fingerprint: srbFingerprintOf(input),
    },
  };
}
