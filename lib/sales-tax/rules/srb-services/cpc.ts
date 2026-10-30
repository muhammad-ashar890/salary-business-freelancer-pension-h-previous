/**
 * Central Product Classification (CPC) codes for the Sindh Sales Tax on
 * Services.
 *
 * The list is the services part of UN CPC version 2.1 as prescribed by SRB
 * notification SRB-3-4/28/2025 (in force from 1 July 2025). The JSON file is
 * generated from the notification; nothing here is typed by hand except the
 * clarifications in Segment II of the notification.
 */

import data from "./cpc-data.json";

export interface CpcEntry {
  code: string;
  title: string;
  /** 2 = division, 3 = group, 4 = class, 5 = subclass. */
  level: 2 | 3 | 4 | 5;
}

const ENTRIES: CpcEntry[] = (data.codes as Array<[string, string]>).map(
  ([code, title]) => ({
    code,
    title,
    level: code.length as CpcEntry["level"],
  }),
);

const BY_CODE = new Map(ENTRIES.map((entry) => [entry.code, entry]));

export const CPC_SOURCE: string = data.source;

/** Segment II of the notification: services that sit under a given code. */
export const CPC_CLARIFICATIONS: ReadonlyArray<{ code: string; text: string }> = [
  { code: "54540", text: "Includes ready-mix concrete services." },
  { code: "61", text: "Includes ship chandlers, indenters and online marketplaces for trade in goods." },
  { code: "62", text: "Includes ship chandlers, indenters and online marketplaces for trade in goods." },
  { code: "63", text: "Includes related services provided by clubs." },
  { code: "64115", text: "Includes cab aggregator services." },
  { code: "85514", text: "Includes cab aggregator services." },
  { code: "675", text: "Includes services of port operators and terminal operators." },
  { code: "67910", text: "Includes customs agents and truck aggregators." },
  { code: "83919", text: "Includes fashion designers." },
  { code: "85961", text: "Includes marriage halls, marriage lawns and banquets." },
  { code: "85999", text: "Includes co-working space facilities and online marketplaces for transactions other than trade in goods." },
  { code: "8822", text: "Includes tailoring, sewing and stitching by tailors." },
];

export function allCpcEntries(): readonly CpcEntry[] {
  return ENTRIES;
}

/** Keeps digits only, so "8 3131" and "83131" are the same code. */
export function normalizeCpcCode(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

export function findCpc(code: unknown): CpcEntry | null {
  return BY_CODE.get(normalizeCpcCode(code)) ?? null;
}

/**
 * True when `code` is the same as, or sits below, `ancestor`. A code written
 * at a higher level covers every five-digit code under it (Segment II, note 1).
 */
export function cpcIsUnder(code: string, ancestor: string): boolean {
  const a = normalizeCpcCode(code);
  const b = normalizeCpcCode(ancestor);
  return a.length >= b.length && a.startsWith(b);
}

/** The parents of a code, from the division down to the code itself. */
export function cpcPath(code: string): CpcEntry[] {
  const clean = normalizeCpcCode(code);
  const path: CpcEntry[] = [];
  for (let length = 2; length <= clean.length; length += 1) {
    const entry = BY_CODE.get(clean.slice(0, length));
    if (entry) path.push(entry);
  }
  return path;
}

/**
 * Finds codes for a picker. A query of digits matches codes that start with
 * it; words match the title. Five-digit codes come first.
 */
export function searchCpc(query: string, limit = 20): CpcEntry[] {
  const text = String(query ?? "").trim().toLowerCase();
  if (!text) return [];
  const digits = text.replace(/\s/g, "");
  let found: CpcEntry[];
  if (/^\d+$/.test(digits)) {
    found = ENTRIES.filter((entry) => entry.code.startsWith(digits));
  } else {
    const words = text.split(/\s+/).filter(Boolean);
    found = ENTRIES.filter((entry) => {
      const title = entry.title.toLowerCase();
      return words.every((word) => title.includes(word));
    });
  }
  return found
    .sort(
      (a, b) =>
        Number(b.level === 5) - Number(a.level === 5) ||
        a.code.localeCompare(b.code),
    )
    .slice(0, Math.max(1, limit));
}
