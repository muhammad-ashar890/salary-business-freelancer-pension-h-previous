/**
 * Plain-language problem messages for the Sindh services return.
 *
 * Every message says what happened, why it matters and what to do. Nothing
 * shown to the user is a technical code; the code only identifies the message
 * for tests and logs.
 */

import type { ProblemSeverity, ProblemSheet, SalesTaxProblem } from "../types";

type Params = Record<string, string | number>;

interface Definition {
  severity: ProblemSeverity;
  message: (p: Params) => string;
  action: (p: Params) => string;
}

const DEFINITIONS: Record<string, Definition> = {
  srb_period_unsupported: {
    severity: "refuse",
    message: () => "Sindh services returns are supported from July 2025 onwards.",
    action: () => "Choose a month from July 2025 or later.",
  },
  srb_line_invalid: {
    severity: "error",
    message: (p) => `Line ${p.row}: ${p.detail}`,
    action: (p) => `Open line ${p.row} and correct it.`,
  },
  srb_duplicate_invoice: {
    severity: "error",
    message: (p) => `Lines ${p.first} and ${p.row} have the same document number (${p.docNo}). Each invoice is listed once.`,
    action: (p) => `Remove line ${p.row} or correct its number.`,
  },
  srb_note_original_missing: {
    severity: "warning",
    message: (p) => `Line ${p.row}: the ${p.noteType} refers to invoice ${p.original}, which is not in this month's list.`,
    action: () => "This is fine when the invoice belongs to an earlier month. Otherwise check the invoice number.",
  },
  srb_option_condition: {
    severity: "warning",
    message: (p) => `You chose "${p.label}" (${p.reference}). ${p.condition}`,
    action: (p) => p.optionRequired
      ? "Use this rate only if you have e-filed the reduced-rate option with SRB. Input tax credit is not allowed on these services."
      : "Use this rate only if you meet the condition above. Input tax credit is not allowed on these services.",
  },
  srb_reduced_rate_inputs: {
    severity: "warning",
    message: () => "You have sales at a reduced rate. Input tax on purchases used for them cannot be claimed (rule 22), and no amount is entered for it.",
    action: () => "If some of your purchases were used for reduced-rate services, work out that input tax and enter it as \"Other non-creditable input tax\" on the figures step.",
  },
  srb_unregistered_supplier_tax: {
    severity: "warning",
    message: (p) => `Line ${p.row}: an unregistered supplier shows sales tax on the invoice. No input tax can be claimed on it.`,
    action: () => "We treated the whole tax as non-creditable. Check whether the supplier is really unregistered.",
  },
  srb_cpc_not_full: {
    severity: "warning",
    message: (p) => `Line ${p.row}: the service code ${p.cpc} is not a full five-digit code.`,
    action: () => "The portal may ask for the full five-digit code. Pick the most specific code for the service.",
  },
  srb_evidence_needed: {
    severity: "warning",
    message: () => "Your input tax is more than 20% of your output tax. Rule 16 then requires scanned copies of the purchase invoices to be attached to the return.",
    action: () => "Scan the purchase invoices and keep them ready to attach on the portal.",
  },
  srb_no_invoices: {
    severity: "warning",
    message: () => "There are no invoices for this month.",
    action: () => "If you had no business activity, file a nil return on the portal instead. Otherwise add your invoices.",
  },
  srb_output_negative: {
    severity: "warning",
    message: (p) => `Credit notes are larger than the sales in row ${p.row}, which makes the output tax negative.`,
    action: () => "Check the credit notes and the months they belong to.",
  },
  srb_late_return: {
    severity: "warning",
    message: (p) => `The return was due on ${p.due}. Each day of delay costs Rs 100 as penalty, about ${p.penalty} so far (${p.days} days).`,
    action: () => "File as soon as you can. The Board decides the real penalty.",
  },
  srb_late_needs_approval: {
    severity: "warning",
    message: (p) => `More than ${p.months} months have passed since the due date. A late return then needs the approval of the Commissioner before it can be e-filed (rule 12).`,
    action: () => "Contact your SRB tax office before filing.",
  },
  srb_credit_forward: {
    severity: "warning",
    message: () => "Your input tax is more than your output tax, so a credit will be carried forward.",
    action: (p) => p.june
      ? "This is the June return: the credit shows as an end-of-year refund claim in row 18."
      : "The credit moves to next month's return as row 6.",
  },
};

export function makeSrbProblem(
  code: string,
  sheet: ProblemSheet,
  row: number | null,
  params: Params = {},
): SalesTaxProblem {
  const definition = DEFINITIONS[code];
  if (!definition) throw new Error(`Unknown problem code ${code}.`);
  const merged: Params = { sheet, ...params, ...(row === null ? {} : { row }) };
  return {
    code,
    severity: definition.severity,
    sheet,
    row,
    message: definition.message(merged),
    action: definition.action(merged),
  };
}

export const SRB_PROBLEM_CODES = Object.keys(DEFINITIONS);
