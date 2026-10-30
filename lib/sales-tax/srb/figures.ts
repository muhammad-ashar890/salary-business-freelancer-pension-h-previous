/**
 * The figures an SST-03 needs that are not in the invoice lists: carried
 * forward and system-supplied rows, the Annex-E amounts, the penalty rows,
 * the amended-return answer and the exports (Annex-D).
 *
 * The form holds text exactly as typed; validation turns it into paisa.
 * A blank amount is zero; anything unreadable is an error the user can fix.
 */

import { isValidIso } from "../dates";
import { MAX_FIGURE_PAISA, paisaToInput } from "../figures";
import { toPaisa, type Paisa } from "../money";
import type { TaxPeriod } from "../types";
import { checkExport, type RawExport } from "./entries";
import type { SrbExportEntry, SrbFigures } from "./types";

export type SrbAmountKey =
  | "creditBroughtForward6"
  | "annexECredit3"
  | "otherNonCreditable4"
  | "disallowed7a"
  | "allowed7b"
  | "annexEBalance14"
  | "additionalTax21"
  | "arrears22"
  | "penalty23"
  | "taxPaidPrevious25";

export const SRB_FIGURE_FIELDS: {
  key: SrbAmountKey;
  sr: string;
  label: string;
  hint: string;
  group: "credit" | "capital" | "penalty" | "amended";
}[] = [
  {
    key: "creditBroughtForward6",
    sr: "6",
    label: "Credit brought forward",
    hint: "Row 19 (net credit carried forward) of last month's return.",
    group: "credit",
  },
  {
    key: "otherNonCreditable4",
    sr: "4",
    label: "Other non-creditable input tax",
    hint: "Input tax on purchases used for reduced-rate, exempt or out-of-Sindh services, worked out under rule 22. Do not repeat the amounts you marked non-creditable on purchase lines.",
    group: "credit",
  },
  {
    key: "disallowed7a",
    sr: "7a",
    label: "Disallowed credit and output tax reduction",
    hint: "The amount the portal shows in row 7a, when suppliers or buyers have not declared your invoices (section 15A).",
    group: "credit",
  },
  {
    key: "allowed7b",
    sr: "7b",
    label: "Allowed credit and output tax reduction",
    hint: "The amount the portal shows in row 7b, carried over from the previous return's column 7c.",
    group: "credit",
  },
  {
    key: "annexECredit3",
    sr: "3",
    label: "Input tax credit on capital goods (Annex-E), this month",
    hint: "Only if you bought capital goods or fixed assets. Use the amount from your Annex-E working.",
    group: "capital",
  },
  {
    key: "annexEBalance14",
    sr: "14",
    label: "Capital goods input tax still available (Annex-E)",
    hint: "The balance of Annex-E credit you have not yet claimed.",
    group: "capital",
  },
  {
    key: "additionalTax21",
    sr: "21",
    label: "Additional tax, default surcharge and others",
    hint: "Only if you are paying these with this return.",
    group: "penalty",
  },
  {
    key: "arrears22",
    sr: "22",
    label: "Arrears",
    hint: "Short-paid tax of earlier returns that you are paying now.",
    group: "penalty",
  },
  {
    key: "penalty23",
    sr: "23",
    label: "Penalty or fine",
    hint: "A penalty or fine you are paying with this return.",
    group: "penalty",
  },
  {
    key: "taxPaidPrevious25",
    sr: "25",
    label: "Tax paid on the normal or previous return",
    hint: "Only for an amended return: what you paid on the first return of this month.",
    group: "amended",
  },
];

export const MAX_SRB_EXPORTS = 200;

export interface SrbExportForm {
  buyerName: string;
  country: string;
  cpc: string;
  docNo: string;
  docDate: string;
  amountPkr: string;
}

export interface SrbFiguresForm {
  amounts: Record<SrbAmountKey, string>;
  amended: boolean;
  exports: SrbExportForm[];
}

export function emptySrbFigures(): SrbFigures {
  return {
    creditBroughtForward6: 0,
    annexECredit3: 0,
    otherNonCreditable4: 0,
    disallowed7a: 0,
    allowed7b: 0,
    annexEBalance14: 0,
    additionalTax21: 0,
    arrears22: 0,
    penalty23: 0,
    amended: false,
    taxPaidPrevious25: 0,
    exports: [],
  };
}

export function emptySrbFiguresForm(): SrbFiguresForm {
  return srbFiguresToForm(emptySrbFigures());
}

export function srbFiguresToForm(figures: SrbFigures): SrbFiguresForm {
  const amounts = {} as Record<SrbAmountKey, string>;
  for (const field of SRB_FIGURE_FIELDS) amounts[field.key] = paisaToInput(figures[field.key]);
  return {
    amounts,
    amended: figures.amended,
    exports: figures.exports.map((row) => ({
      buyerName: row.buyerName,
      country: row.country,
      cpc: row.cpc,
      docNo: row.docNo,
      docDate: row.docDate,
      amountPkr: paisaToInput(row.amountPkr, true),
    })),
  };
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export type SrbFiguresResult =
  | { ok: true; value: SrbFigures }
  | { ok: false; error: string };

export function validateSrbFiguresForm(input: unknown, period: TaxPeriod): SrbFiguresResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Your figures could not be read. Please try again." };
  }
  const form = input as Partial<SrbFiguresForm>;
  const figures = emptySrbFigures();
  const typed = (form.amounts && typeof form.amounts === "object" ? form.amounts : {}) as Record<string, unknown>;
  for (const field of SRB_FIGURE_FIELDS) {
    const raw = typed[field.key];
    const label = `Row ${field.sr} (${field.label})`;
    if (text(raw) === "") continue;
    if (typeof raw !== "string" && typeof raw !== "number") {
      return { ok: false, error: `${label}: enter an amount in rupees, for example 12,500.50.` };
    }
    const paisa = toPaisa(raw);
    if (paisa === null) {
      return { ok: false, error: `${label}: "${String(raw).trim().slice(0, 30)}" is not an amount. Use digits only, for example 12,500.50.` };
    }
    if (paisa < 0) return { ok: false, error: `${label}: the amount cannot be negative.` };
    if (paisa > MAX_FIGURE_PAISA) return { ok: false, error: `${label}: this amount is too large. Check the digits.` };
    figures[field.key] = paisa as Paisa;
  }
  figures.amended = form.amended === true;
  if (!figures.amended && figures.taxPaidPrevious25 > 0) {
    return { ok: false, error: "Row 25 (tax paid on the previous return) is only for an amended return. Tick \"This is an amended return\" or clear the amount." };
  }

  const rows = Array.isArray(form.exports) ? form.exports : [];
  let number = 0;
  const exportsOut: SrbExportEntry[] = [];
  for (const raw of rows) {
    const row = (raw && typeof raw === "object" ? raw : {}) as Partial<SrbExportForm>;
    if (Object.values(row).every((value) => text(value) === "")) continue;
    number += 1;
    if (number > MAX_SRB_EXPORTS) return { ok: false, error: `Exports: list at most ${MAX_SRB_EXPORTS} export invoices.` };
    // A fixed id per position keeps the approval fingerprint stable when the same figures are saved again.
    const checked = checkExport(row as RawExport, period, { id: `export-${number}` });
    if (checked.ok === false) return { ok: false, error: `Export ${number}: ${checked.first}` };
    exportsOut.push(checked.entry);
  }
  figures.exports = exportsOut;
  return { ok: true, value: figures };
}

/** Reads figures back from the database; anything damaged falls back to "nothing entered". */
export function parseStoredSrbFigures(stored: unknown): SrbFigures {
  const fallback = emptySrbFigures();
  if (!stored || typeof stored !== "object") return fallback;
  const value = stored as Record<string, unknown>;
  const safe = (n: unknown): Paisa =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
  for (const field of SRB_FIGURE_FIELDS) fallback[field.key] = safe(value[field.key]);
  fallback.amended = value.amended === true;
  const rows = Array.isArray(value.exports) ? value.exports : [];
  fallback.exports = rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .slice(0, MAX_SRB_EXPORTS)
    .map((row) => ({
      id: typeof row.id === "string" ? row.id : "",
      buyerName: typeof row.buyerName === "string" ? row.buyerName : "",
      country: typeof row.country === "string" ? row.country : "",
      cpc: typeof row.cpc === "string" ? row.cpc : "",
      docNo: typeof row.docNo === "string" ? row.docNo : "",
      docDate: typeof row.docDate === "string" && isValidIso(row.docDate) ? row.docDate : "",
      amountPkr: safe(row.amountPkr),
    }));
  return fallback;
}
