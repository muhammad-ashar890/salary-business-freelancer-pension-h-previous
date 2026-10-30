/**
 * The plain-text worksheet the user keeps beside the SRB portal while typing
 * the return. It lists SST-03 row by row and the Annex-C and Annex-A lines in
 * the order the portal asks for them. Nothing here is sent anywhere.
 */

import { lastDayOfMonth } from "../dates";
import { formatRupees } from "../money";
import { findCpc, findRateOption } from "../rules/srb-services";
import type { TaxPeriod } from "../types";
import { SRB_NON_CREDITABLE_REASONS } from "./entries";
import type { SrbPurchaseEntry, SrbReturnResult, SrbSaleEntry } from "./types";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const pad = (text: string, width: number) => (text.length >= width ? text : text + " ".repeat(width - text.length));
const padLeft = (text: string, width: number) => (text.length >= width ? text : " ".repeat(width - text.length) + text);
const amount = (value: number | null) => (value === null ? "" : formatRupees(value));
const signedLabel = (docType: string) => (docType === "CN" ? " (credit note, subtract)" : docType === "DN" ? " (debit note)" : "");

export function buildSrbWorksheet(input: {
  businessName: string;
  registrationNo: string;
  period: TaxPeriod;
  result: SrbReturnResult;
  sales: SrbSaleEntry[];
  purchases: SrbPurchaseEntry[];
}): string {
  const { result, period } = input;
  const out: string[] = [];
  out.push(`SRB sales tax on services - worksheet for form SST-03`);
  out.push(`${input.businessName} (registration ${input.registrationNo})`);
  out.push(`Tax period: ${MONTHS[period.month - 1]} ${period.year}`);
  out.push("This is an estimate to help you fill the portal. Check every figure against the portal before you submit.");
  out.push("");
  if (!result.canEstimate) {
    out.push("The return cannot be worked out yet. Fix the problems listed in the app first.");
    return out.join("\n");
  }

  out.push("RETURN ROWS");
  out.push(`${pad("Row", 5)}${pad("Description", 74)}${padLeft("Value", 18)}${padLeft("Tax / amount", 18)}  Note`);
  for (const line of result.lines) {
    const flag = line.status === "provisional" ? "PENDING CONFIRMATION" : line.status === "input" ? "entered by you" : "";
    out.push(`${pad(line.sr, 5)}${pad(line.description.slice(0, 72), 74)}${padLeft(amount(line.value), 18)}${padLeft(line.sr === "10" ? "" : amount(line.amount), 18)}  ${flag}`.trimEnd());
  }
  out.push("");
  out.push(`Balance payable (row 26): ${formatRupees(result.balancePayable ?? 0)}  - PENDING CONFIRMATION`);
  out.push("Rows 13, 15, 17, 18, 19, 24 and 26 are not yet confirmed against a real portal return. Work them out on the portal and compare.");
  out.push("");
  out.push("CROSS-CHECK AFTER YOU ENTER THE ANNEXES ON THE PORTAL");
  out.push("The portal fills these rows from the annexes. They should match the figures above:");
  for (const sr of ["1", "5", "9a", "9b", "11", "14a"]) {
    const line = result.bySr[sr];
    if (line) out.push(`  Row ${pad(sr, 3)} ${amount(line.amount)}`);
  }
  out.push("");

  out.push("ANNEX-C: SALES");
  if (input.sales.length === 0) out.push("  (none)");
  for (const entry of input.sales) {
    const rate = findRateOption(entry.rateId, lastDayOfMonth(period));
    const cpc = findCpc(entry.cpc);
    out.push(`  ${entry.docDate}  ${entry.docType} ${entry.docNo}${signedLabel(entry.docType)}`);
    out.push(`    Buyer: ${entry.buyerName} (${entry.buyerNtn}, ${entry.buyerType === "INTERMEDIARY" ? "registered / intermediary" : "end consumer"})`);
    out.push(`    Service: ${entry.cpc}${cpc ? ` ${cpc.title}` : ""}`);
    out.push(`    Rate: ${rate ? rate.label : entry.rateId}  (portal row ${rate ? rate.row : "?"})`);
    out.push(`    Value ${formatRupees(entry.valueExclTax)}  Tax ${formatRupees(entry.salesTax)}  Withheld by buyer ${formatRupees(entry.stWithheld)}`);
    if (entry.originalDocNo) out.push(`    Corrects ${entry.originalDocNo}: ${entry.reason}`);
  }
  out.push("");
  out.push("ANNEX-A: PURCHASES");
  if (input.purchases.length === 0) out.push("  (none)");
  for (const entry of input.purchases) {
    out.push(`  ${entry.docDate}  ${entry.docType} ${entry.docNo}${signedLabel(entry.docType)}`);
    out.push(`    Supplier: ${entry.supplierName} (${entry.supplierNtn || "unregistered"})`);
    out.push(entry.kind === "GOODS"
      ? `    Goods: HS ${entry.hsCode} at ${((entry.goodsRate ?? 0) * 100).toFixed(2).replace(/\.?0+$/, "")}%`
      : `    Service: ${entry.cpc}`);
    out.push(`    Value ${formatRupees(entry.valueExclTax)}  Tax ${formatRupees(entry.salesTax)}`);
    if (entry.nonCreditable > 0) {
      const reason = SRB_NON_CREDITABLE_REASONS.find((item) => item.code === entry.nonCreditableReason);
      out.push(`    Not creditable ${formatRupees(entry.nonCreditable)}: ${reason ? reason.label : entry.nonCreditableReason}`);
    }
    if (entry.stWithheldAsAgent > 0) out.push(`    Withheld by you ${formatRupees(entry.stWithheldAsAgent)}`);
    if (entry.originalDocNo) out.push(`    Corrects ${entry.originalDocNo}: ${entry.reason}`);
  }
  return out.join("\n");
}
