/**
 * Deterministic reader for a text-based FBR IRIS previous-return print.
 *
 * The generic Gemini pass reads a 7-page IRIS print as one dense document and
 * has been seen to leave Net Assets (703001) blank or to copy the neighbouring
 * Net Assets Previous Year (703002) row into Total Assets. IRIS prints are
 * generated PDFs with a real text layer, so the wealth codes can instead be
 * anchored exactly: a line ending "7019 <amount>" inside the Wealth Statement
 * is Total Assets, whatever the surrounding tables say. This module parses
 * that text (it never talks to a model); scanned prints have no text layer,
 * the parse returns null, and the model result stands untouched.
 *
 * The seven Previous Return review facts are read, plus (Phase 4a) the
 * printed Wealth Statement detail rows when they add up exactly to those
 * totals (see previous-return-fields.ts). A liabilities TOTAL row (7029) is
 * not printed
 * when the taxpayer has no liabilities; in that one case, when the printed
 * Assets equal the printed Net Assets and no 702x row exists at all, 0 is
 * supplied as a DERIVED value and flagged as such for the reviewer. Nothing
 * else is ever derived.
 */

import {
  PREVIOUS_RETURN_LABELS,
  isPreviousReturnAssetCode,
  previousReturnFieldKey,
} from "./previous-return-fields";
import type { PreviousReturnWealthRow } from "./previous-return-fields";

type Key = keyof typeof PREVIOUS_RETURN_LABELS;
type Field = { label?: unknown; value?: unknown; confidence?: unknown };

const CANONICAL_ORDER: Key[] = [
  "taxpayerName",
  "registrationNo",
  "taxYear",
  "totalAssets",
  "totalLiabilities",
  "netAssets",
  "cashInHand",
];

const AMOUNT = String.raw`\(?-?\d[\d,]*(?:\.\d+)?\)?`;

function parseAmountToken(token: string): number | null {
  const negative = token.startsWith("(") && token.endsWith(")");
  const cleaned = token.replace(/[(),]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(negative ? -Math.abs(value) : value);
}

/**
 * Every Wealth Statement line that ends "<code> <amount>". A code can repeat
 * (703001 is printed in the Wealth Statement and again in the Reconciliation);
 * identical repeats are one fact, conflicting repeats are ambiguous and yield
 * null rather than a silently picked value.
 */
function codedAmount(
  wealthText: string,
  code: string,
): { value: number; evidence: string } | null {
  // IRIS prints two layouts, and a single PDF can contain both:
  //   1. "Motor Vehicle (Non-Business) - AAU-408-Suzuki 7008 415,000"  (code last)
  //   2. "7008 415,000Motor Vehicle (Non-Business) - ..."              (code first,
  //      amount glued to the description — the form the live FBR print uses)
  const trailing = new RegExp(`\\b${code}\\s+(${AMOUNT})\\s*$`);
  const leading = new RegExp(`^${code}\\s+(${AMOUNT})`);
  const found = new Map<number, string>();
  for (const rawLine of wealthText.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/\s+/g, " ");
    const match = line.match(leading) ?? line.match(trailing);
    if (!match) continue;
    const value = parseAmountToken(match[1]);
    if (value !== null && !found.has(value)) found.set(value, line);
  }
  if (found.size !== 1) return null;
  const [value, evidence] = [...found.entries()][0];
  return { value, evidence };
}

function headerRegistrationNo(header: string): string | null {
  const dashed = header.match(/\b(\d{5})-(\d{7})-(\d)\b/);
  if (dashed) return `${dashed[1]}${dashed[2]}${dashed[3]}`;
  const plain = new Set(
    [...header.matchAll(/(?<!\d)(\d{13})(?!\d)/g)].map((m) => m[1]),
  );
  return plain.size === 1 ? [...plain][0] : null;
}

function headerTaxpayerName(header: string): string | null {
  // Jasper prints interleave the header columns; the taxpayer's name ends up
  // on the same extracted line as the "Registration No" label.
  for (const line of header.split(/\r?\n/)) {
    const match = line.match(/^(.+?)\s+Registration No\b/i);
    const candidate = match?.[1]?.replace(/Name:\s*/i, "").trim();
    if (candidate && /[A-Za-z]/.test(candidate) && candidate.length >= 3)
      return candidate;
  }
  const labelled = header.match(/Name:\s*([A-Za-z][A-Za-z .'-]{2,})/);
  return labelled ? labelled[1].trim() : null;
}

function headerTaxYear(header: string): number | null {
  const candidates = new Set<number>();
  const direct = header.match(/Tax Year\s*:?\s*(20\d{2})\b/i);
  if (direct) candidates.add(Number(direct[1]));
  const labelAt = header.search(/Tax Year/i);
  if (labelAt >= 0) {
    const windowText = header.slice(
      Math.max(0, labelAt - 350),
      labelAt + 350,
    );
    for (const m of windowText.matchAll(/(?:^|\n)\s*(20\d{2})\s*(?:\n|$)/g))
      candidates.add(Number(m[1]));
  }
  // A normal period "01-Jul-2025 - 30-Jun-2026" belongs to Tax Year 2026.
  const period = header.match(
    /(?:\d{1,2}-[A-Za-z]{3}-(\d{4}))\s*-\s*(?:\d{1,2}-[A-Za-z]{3}-(\d{4}))/,
  );
  if (period) candidates.add(Number(period[2]));
  return candidates.size === 1 ? [...candidates][0] : null;
}

const ROW_CODE = String.raw`70(?:0[1-9]|1[0-8]|2[0-8])`;
const NON_ROW_LINES = [
  /^Wealth Statement$/i,
  /^Personal Assets and Liabilities$/i,
  /^Description Code( Amount)?$/i,
  /^Page \d+ of/i,
  /Print Date/i,
  /^Copyright/i,
  /^Federal Board of Revenue/i,
  /^Revenue Division/i,
  /Inland Revenue/i,
  /^FBR/i,
];

/**
 * The printed Wealth Statement rows (Phase 4a): every line in the wealth
 * region (up to the Reconciliation heading) ending "<70xx code> <amount>".
 * For each code the aggregate is the row equalling the sum of its sibling
 * rows (IRIS prints the aggregate first, then one child row per asset); a
 * code with a single row is its own aggregate. The set is kept ONLY when
 * asset aggregates add up to Total Assets and liability aggregates to Total
 * Liabilities — anything else yields rows: null and the scalars stand alone.
 */
export function parseWealthRows(
  wealthText: string,
  totals: { totalAssets: number; totalLiabilities: number | null },
): { rows: PreviousReturnWealthRow[] | null; found: number } {
  const endAt = wealthText.search(/Reconciliation of Net Assets/i);
  const region = endAt >= 0 ? wealthText.slice(0, endAt) : wealthText;

  // Two printed layouts (see codedAmount):
  //   code first:  "7008 415,000Motor Vehicle (Non-Business) - AAU-408-Suzuki"
  //   code last:   "Motor Vehicle (Non-Business) - AAU-408-Suzuki 7008 415,000"
  // In the code-first layout the description may wrap onto the FOLLOWING lines
  // ("7013 2,210,000" then "Any Other Asset - AL- AMEEN ..." then "FUND"), and a
  // page break can sit in the middle of it, so a row's trailing text is collected
  // until the next coded row and cleaned of page furniture.
  const codeFirst = new RegExp(`^(\\d{4,6})\\s+(${AMOUNT})\\s*(.*)$`);
  const codeLast = new RegExp(`^(.*?)\\s+(\\d{4,6})\\s+(${AMOUNT})\\s*$`);
  // 7015 is "Total Assets inside Pakistan": a printed total, not an asset row.
  const TOTAL_ONLY_CODES = new Set(["7015", "7016"]);
  const isRowCode = (code: string) =>
    new RegExp(`^${ROW_CODE}$`).test(code) && !TOTAL_ONLY_CODES.has(code);

  type RawRow = { code: string; description: string; amount: number };
  const raw: RawRow[] = [];
  let invalid = false;
  let pendingTrailing: string[] = [];

  const flushTrailing = () => {
    // Attach the collected trailing text to the row that was just read.
    if (!pendingTrailing.length) return;
    const last = raw[raw.length - 1];
    if (last && !last.description) last.description = pendingTrailing.join(" ");
    else if (last && last.description) {
      const merged = `${last.description} ${pendingTrailing.join(" ")}`.trim();
      if (merged.length > last.description.length) last.description = merged;
    }
    pendingTrailing = [];
  };

  for (const rawLine of region.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/\s+/g, " ");
    if (!line) continue;

    const first = line.match(codeFirst);
    if (first && isRowCode(first[1])) {
      flushTrailing();
      const amount = parseAmountToken(first[2]);
      if (amount === null || amount < 0) invalid = true;
      else
        raw.push({
          code: first[1],
          description: first[3].trim().slice(0, 200),
          amount,
        });
      continue;
    }

    const last = line.match(codeLast);
    if (last && isRowCode(last[2])) {
      flushTrailing();
      const amount = parseAmountToken(last[3]);
      const description = last[1].trim();
      if (amount === null || amount < 0 || !description) invalid = true;
      else raw.push({ code: last[2], description: description.slice(0, 200), amount });
      continue;
    }

    // Any other line belongs to the description of the row just read, unless it
    // is page furniture ("Page 2 ofTue, ...", "Code AmountDescription", the
    // section heading again, print date, FBR banners).
    if (NON_ROW_LINES.some((re) => re.test(line))) continue;
    if (/^Page \d+/i.test(line) || /Print Date/i.test(line)) continue;
    if (/^Code\s*Amount\s*Description$/i.test(line)) continue;
    if (/^Personal Assets\s*\/\s*Liabilities$/i.test(line)) continue;
    if (/^Attributes?$/i.test(line) || /^Attribute Value$/i.test(line)) continue;
    if (raw.length) {
      pendingTrailing.push(line);
      if (pendingTrailing.join(" ").length > 200) pendingTrailing = [pendingTrailing.join(" ").slice(0, 200)];
      if (pendingTrailing.length > 4) pendingTrailing.shift();
    }
  }
  flushTrailing();

  if (invalid || raw.length === 0) return { rows: null, found: raw.length };

  // Give a description-less row a readable label so the reviewer is never shown
  // an empty row (IRIS sometimes prints only "7013 2,210,000" for details).
  for (const row of raw) if (!row.description) row.description = `IRIS code ${row.code}`;

  // When a printed row's description wraps onto the next page, IRIS repeats the
  // whole row ("7006 1,119,666" appears again before the continuation text), so
  // the same code+amount can legitimately appear twice in the text stream. Try
  // the de-duplicated reading first and fall back to the literal one: an asset
  // list where two different items happen to share code and amount must still be
  // honoured, so nothing is dropped unless the totals then tie out.
  const attempt = (candidate: RawRow[]): PreviousReturnWealthRow[] | null => {
    const byCode = new Map<string, RawRow[]>();
    for (const row of candidate) {
      const list = byCode.get(row.code) ?? [];
      list.push(row);
      byCode.set(row.code, list);
    }
    const rows: PreviousReturnWealthRow[] = [];
    let assetTotal = 0;
    let liabilityTotal = 0;
    for (const [code, list] of byCode) {
      let aggregateIndex = 0;
      if (list.length > 1) {
        aggregateIndex = list.findIndex(
          (row, i) =>
            Math.abs(
              row.amount -
                list.reduce((sum, other, j) => (j === i ? sum : sum + other.amount), 0),
            ) <= 1,
        );
        if (aggregateIndex < 0) return null;
      }
      list.forEach((row, i) =>
        rows.push({
          code,
          description: row.description,
          amount: row.amount,
          detail: i !== aggregateIndex,
        }),
      );
      if (isPreviousReturnAssetCode(code)) assetTotal += list[aggregateIndex].amount;
      else liabilityTotal += list[aggregateIndex].amount;
    }
    if (Math.abs(assetTotal - totals.totalAssets) > 1) return null;
    if (
      totals.totalLiabilities === null ||
      Math.abs(liabilityTotal - totals.totalLiabilities) > 1
    )
      return null;
    return rows;
  };

  const seen = new Set<string>();
  const deduped: RawRow[] = [];
  for (const row of raw) {
    const key = `${row.code}:${row.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  const rows = attempt(deduped) ?? attempt(raw);
  if (!rows) return { rows: null, found: raw.length };
  return { rows, found: raw.length };
}

export type PreviousReturnTextParse = {
  taxpayerName: string | null;
  registrationNo: string | null;
  taxYear: number | null;
  totalAssets: number;
  totalLiabilities: number | null;
  /** True when 0 was derived (no liabilities rows printed, assets = net). */
  liabilitiesDerived: boolean;
  netAssets: number;
  cashInHand: number | null;
  /** Printed Wealth Statement rows, kept only when they tie to the totals. */
  wealthRows: PreviousReturnWealthRow[] | null;
  /** Reviewer note when printed rows were found but did not tie out. */
  wealthRowsNote: string | null;
  /** The printed line each amount came from, for audit. */
  evidence: Partial<Record<Key, string>>;
};

/**
 * Parse the seven Previous Return facts from extracted IRIS print text.
 * Returns null unless the Wealth Statement's printed Total Assets (7019) and
 * Net Assets Current Year (703001) are both anchored unambiguously.
 */
export function parseIrisPreviousReturnText(
  fullText: string,
  firstPageText?: string,
): PreviousReturnTextParse | null {
  if (typeof fullText !== "string" || !fullText.trim()) return null;
  // The live FBR print titles the section "Personal Assets / Liabilities" and
  // never prints the words "Wealth Statement"; older captures do print it. Take
  // whichever appears first, and fall back to the whole text so a layout change
  // cannot silently disable extraction.
  const anchors = [
    fullText.search(/Personal Assets\s*\/\s*Liabilities/i),
    fullText.search(/Wealth Statement/i),
  ].filter((index) => index >= 0);
  const wealthAt = anchors.length ? Math.min(...anchors) : 0;
  const wealthText = fullText.slice(wealthAt);

  const assets = codedAmount(wealthText, "7019");
  const net = codedAmount(wealthText, "703001");
  if (!assets || !net) return null;

  const liabilities = codedAmount(wealthText, "7029");
  const cash = codedAmount(wealthText, "7012");

  let totalLiabilities: number | null = liabilities?.value ?? null;
  let liabilitiesDerived = false;
  if (totalLiabilities === null && assets.value === net.value) {
    // IRIS prints the 7021 / 7029 rows with an EMPTY amount cell when the
    // taxpayer has no liabilities, so "no printable value" is the normal
    // appearance of a nil total — not evidence that the section is missing.
    // The printed identity 7019 - 7029 = 703001 then proves the value: assets
    // equal net assets, so liabilities can only be zero. (Live case,
    // 2026-10-27: a filed return printed 7021 and 7029 blank, 7019 = 703001 =
    // 8,780,220 — the old condition, which skipped derivation whenever ANY
    // "702x" code appeared, left the required 7029 field empty and blocked
    // Save & Approve Map.) Confidence is marked down and the reviewer still
    // confirms the figure before approving.
    totalLiabilities = 0;
    liabilitiesDerived = true;
  }

  const header = firstPageText ?? fullText.slice(0, 2000);
  const evidence: Partial<Record<Key, string>> = {
    totalAssets: assets.evidence,
    netAssets: net.evidence,
  };
  if (liabilities) evidence.totalLiabilities = liabilities.evidence;
  if (cash) evidence.cashInHand = cash.evidence;

  const wealth = parseWealthRows(wealthText, {
    totalAssets: assets.value,
    totalLiabilities,
  });

  return {
    taxpayerName: headerTaxpayerName(header),
    registrationNo: headerRegistrationNo(header),
    taxYear: headerTaxYear(header),
    totalAssets: assets.value,
    totalLiabilities,
    liabilitiesDerived,
    netAssets: net.value,
    cashInHand: cash?.value ?? null,
    wealthRows: wealth.rows,
    wealthRowsNote:
      !wealth.rows && wealth.found > 0
        ? "Wealth detail rows were found in the printed Wealth Statement but did not add up to the printed totals, so only the totals were kept."
        : null,
    evidence,
  };
}

const parsedValues = (parse: PreviousReturnTextParse) =>
  ({
    taxpayerName: parse.taxpayerName,
    registrationNo: parse.registrationNo,
    taxYear: parse.taxYear,
    totalAssets: parse.totalAssets,
    totalLiabilities: parse.totalLiabilities,
    netAssets: parse.netAssets,
    cashInHand: parse.cashInHand,
  }) as Record<Key, string | number | null>;

/**
 * Merge a text parse into a model extraction payload: each printed fact wins
 * over the model's read of the same row (canonical label, duplicates folded),
 * facts the text could not anchor keep the model's field, and unrelated model
 * fields pass through untouched. Provenance and reviewer notes are recorded
 * on the payload.
 */
export function applyPreviousReturnTextParse(
  payload: unknown,
  parse: PreviousReturnTextParse,
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return payload;
  const raw = payload as { fields?: Field[]; notes?: unknown };
  const existing = Array.isArray(raw.fields) ? raw.fields : [];

  const existingByKey = new Map<Key, Field>();
  const unrelated: Field[] = [];
  for (const field of existing) {
    const key = previousReturnFieldKey(field?.label);
    if (key) {
      if (!existingByKey.has(key)) existingByKey.set(key, field);
    } else unrelated.push(field);
  }

  const values = parsedValues(parse);
  const fields: Field[] = [];
  for (const key of CANONICAL_ORDER) {
    const value = values[key];
    if (value !== null && value !== undefined) {
      fields.push({
        label: PREVIOUS_RETURN_LABELS[key],
        value,
        confidence:
          key === "totalLiabilities" && parse.liabilitiesDerived ? 0.9 : 1,
      });
    } else if (existingByKey.has(key)) {
      fields.push({
        ...existingByKey.get(key),
        label: PREVIOUS_RETURN_LABELS[key],
      });
    }
  }
  fields.push(...unrelated);

  const notes = Array.isArray(raw.notes)
    ? raw.notes.filter((n): n is string => typeof n === "string")
    : [];
  notes.push(
    "Previous-return figures were read from the printed IRIS codes in the PDF text (7019/7029/703001/7012); confirm them against the printed return before approving.",
  );
  if (parse.liabilitiesDerived)
    notes.push(
      "Total Liabilities is shown as 0 because the printed Wealth Statement has no liabilities rows and Total Assets equals Net Assets; confirm this while reviewing.",
    );
  if (parse.wealthRows?.length)
    notes.push(
      `Wealth detail: ${parse.wealthRows.length} printed asset/liability row(s) were read from the Wealth Statement and add up to the printed totals; they are shown for review and carried as evidence.`,
    );
  else if (parse.wealthRowsNote) notes.push(parse.wealthRowsNote);

  return {
    ...raw,
    fields,
    notes,
    ...(parse.wealthRows
      ? { previousReturnWealthRows: parse.wealthRows }
      : {}),
    previousReturnTextParse: {
      source: "iris-pdf-text",
      liabilitiesDerived: parse.liabilitiesDerived,
      wealthRowCount: parse.wealthRows?.length ?? 0,
      evidence: parse.evidence,
    },
  };
}
