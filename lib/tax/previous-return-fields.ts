/**
 * Previous Year Tax Return (optional upload) — review-field contract.
 *
 * Phase 2 of previous-return carry-forward: the taxpayer may upload last
 * year's filed return exactly as printed from FBR IRIS (114(1) including the
 * 116(2) Wealth Statement). This module defines the scalar facts the reviewer
 * must confirm before that document can be approved/mapped:
 *
 *   identity (name + 13-digit Registration No), the return's own tax year,
 *   and the Wealth Statement closing totals (7019 assets, 7029 liabilities,
 *   703001 net assets) that must tie out: assets - liabilities = net assets.
 *
 * The return's closing Net Assets (703001) is the figure that becomes the
 * current year's Net Assets Previous Year (703002). The detailed Wealth
 * Statement rows (Phase 4a) ride along as read-only evidence on the
 * extraction payload — they are only ever trusted after
 * parsePreviousReturnWealthRows re-proves that they add up to these totals.
 * Nothing here writes to IRIS — an approved previous return is evidence only.
 */

export const PREVIOUS_RETURN_LABELS = {
  taxpayerName: "Taxpayer Name",
  registrationNo: "Registration No",
  taxYear: "Tax Year",
  totalAssets: "Total Assets (7019)",
  totalLiabilities: "Total Liabilities (7029)",
  netAssets: "Net Assets (703001)",
  cashInHand: "Cash in Hand (7012)",
} as const;

type Key = keyof typeof PREVIOUS_RETURN_LABELS;

export type PreviousReturnField = {
  label?: unknown;
  value?: unknown;
  confidence?: unknown;
};

/** Labels that must hold a reviewed value before the document can be mapped. */
export const PREVIOUS_RETURN_REQUIRED_KEYS: Key[] = [
  "taxpayerName",
  "registrationNo",
  "taxYear",
  "totalAssets",
  "totalLiabilities",
  "netAssets",
];

const norm = (v: unknown) =>
  String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

const aliases: Partial<Record<Key, string[]>> = {
  taxpayerName: ["Name"],
  registrationNo: ["Registration Number", "CNIC", "CNIC Number", "NTN"],
  taxYear: ["Return Tax Year"],
  totalAssets: ["Total Assets"],
  totalLiabilities: ["Total Liabilities"],
  netAssets: ["Net Assets Current Year (703001)", "Net Assets Current Year", "Net Assets"],
  cashInHand: ["Cash in hand"],
};

export function previousReturnFieldKey(label: unknown): Key | null {
  const n = norm(label);
  return (
    (Object.keys(PREVIOUS_RETURN_LABELS) as Key[]).find((key) =>
      [PREVIOUS_RETURN_LABELS[key], ...(aliases[key] ?? [])].some(
        (value) => norm(value) === n,
      ),
    ) ?? null
  );
}

export function previousReturnFieldValues(
  fields: PreviousReturnField[] | undefined,
  key: Key,
): unknown[] {
  return (fields ?? [])
    .filter((field) => previousReturnFieldKey(field.label) === key)
    .map((field) => field.value);
}

export function previousReturnFieldValue(
  fields: PreviousReturnField[] | undefined,
  key: Key,
) {
  return previousReturnFieldValues(fields, key)[0];
}

const isBlank = (value: unknown) =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && value.trim() === "");

/** Whole-PKR amount: numbers and comma-formatted print text both parse. */
export function parsePreviousReturnAmount(value: unknown): number | null {
  if (isBlank(value)) return null;
  if (typeof value === "number")
    return Number.isFinite(value) ? Math.round(value) : null;
  const text = String(value).replace(/[,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

/**
 * One printed Wealth Statement row of the previous return (Phase 4a).
 * `detail: false` is the code's printed aggregate (e.g. Motor Vehicle(s)
 * 7008); `detail: true` rows are its printed children (each vehicle), which
 * must add up to that aggregate. Asset codes are 7001-7018, liability codes
 * 7020-7028; the totals themselves (7019/7029/703001) are the scalar fields
 * above, never rows.
 */
export type PreviousReturnWealthRow = {
  code: string;
  description: string;
  amount: number;
  detail: boolean;
};

const ASSET_CODE = /^70(?:0[1-9]|1[0-8])$/;
const LIABILITY_CODE = /^702[0-8]$/;
export const isPreviousReturnAssetCode = (code: string) => ASSET_CODE.test(code);
export const isPreviousReturnLiabilityCode = (code: string) =>
  LIABILITY_CODE.test(code);

/**
 * Validate stored wealth rows against the approved totals. Rows are evidence
 * written by the deterministic text parser, but an extraction payload can be
 * re-saved from the browser, so the tie-out is re-proven on every read:
 * per code exactly one aggregate, details add up to it, asset aggregates add
 * up to Total Assets and liability aggregates to Total Liabilities (±1 for
 * print rounding). Any doubt yields [] — the scalar snapshot stands alone.
 */
export function parsePreviousReturnWealthRows(
  raw: unknown,
  totals: { totalAssets: number; totalLiabilities: number },
): PreviousReturnWealthRow[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const rows: PreviousReturnWealthRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const code = String(row.code ?? "");
    if (!isPreviousReturnAssetCode(code) && !isPreviousReturnLiabilityCode(code))
      return [];
    const amount = parsePreviousReturnAmount(row.amount);
    if (amount === null || amount < 0) return [];
    const description = String(row.description ?? "").trim().slice(0, 200);
    if (!description || typeof row.detail !== "boolean") return [];
    rows.push({ code, description, amount, detail: row.detail });
  }

  const byCode = new Map<string, PreviousReturnWealthRow[]>();
  for (const row of rows) {
    const list = byCode.get(row.code) ?? [];
    list.push(row);
    byCode.set(row.code, list);
  }
  let assetTotal = 0;
  let liabilityTotal = 0;
  for (const [code, list] of byCode) {
    const aggregates = list.filter((row) => !row.detail);
    if (aggregates.length !== 1) return [];
    const detailSum = list
      .filter((row) => row.detail)
      .reduce((sum, row) => sum + row.amount, 0);
    if (detailSum > 0 && Math.abs(detailSum - aggregates[0].amount) > 1)
      return [];
    if (isPreviousReturnAssetCode(code)) assetTotal += aggregates[0].amount;
    else liabilityTotal += aggregates[0].amount;
  }
  if (Math.abs(assetTotal - totals.totalAssets) > 1) return [];
  if (Math.abs(liabilityTotal - totals.totalLiabilities) > 1) return [];
  return rows;
}

/**
 * Wealth Statement totals with the only derivation the printed form allows:
 * 7019 - 7029 = 703001. IRIS prints the liabilities row with an EMPTY amount
 * cell when the taxpayer has no liabilities, so a missing 7029 is normal for a
 * nil total. When assets and net assets are known and agree, liabilities follow
 * arithmetically (and only then — an inconsistent asset/net pair yields null
 * instead of a guess).
 */
export function resolvePreviousReturnTotals(
  fields: PreviousReturnField[] | undefined,
): {
  totalAssets: number | null;
  totalLiabilities: number | null;
  netAssets: number | null;
  cashInHand: number | null;
  liabilitiesDerived: boolean;
} {
  const totalAssets = parsePreviousReturnAmount(
    previousReturnFieldValue(fields, "totalAssets"),
  );
  const netAssets = parsePreviousReturnAmount(
    previousReturnFieldValue(fields, "netAssets"),
  );
  const liabilitiesRaw = parsePreviousReturnAmount(
    previousReturnFieldValue(fields, "totalLiabilities"),
  );
  const blank = isBlank(previousReturnFieldValue(fields, "totalLiabilities"));
  let totalLiabilities = liabilitiesRaw;
  let liabilitiesDerived = false;
  if (
    blank &&
    totalAssets !== null &&
    netAssets !== null &&
    totalAssets >= 0 &&
    totalAssets === netAssets
  ) {
    totalLiabilities = 0;
    liabilitiesDerived = true;
  } else if (
    blank &&
    totalAssets !== null &&
    netAssets !== null &&
    totalAssets > netAssets
  ) {
    // Assets exceed net assets, so liabilities cannot be nil: the printed
    // figure exists but was not read. Leave it to the reviewer.
    totalLiabilities = null;
  }
  return {
    totalAssets,
    totalLiabilities,
    netAssets,
    cashInHand: parsePreviousReturnAmount(
      previousReturnFieldValue(fields, "cashInHand"),
    ),
    liabilitiesDerived,
  };
}

/**
 * Review fields with the derivable nil-liability figure filled in.
 *
 * The reviewer sees the printed figures as editable cells. When IRIS printed a
 * blank 7029 (nil liabilities) the cell used to stay empty even though the
 * identity proved the value, which reads as "extraction failed" and leaves the
 * stored mapping without a 7029 row. This fills that one cell with 0 (marked as
 * derived, confidence 0.9) so what the reviewer sees is what gets saved.
 * Everything else is returned untouched, and any other payload is passed
 * through unchanged.
 */
export function withDerivedPreviousReturnFields<
  T extends { label?: unknown; value?: unknown; confidence?: unknown },
>(fields: T[] | undefined): T[] {
  const list = Array.isArray(fields) ? fields : [];
  const hasPreviousReturnLabels = list.some(
    (field) => previousReturnFieldKey(field.label) !== null,
  );
  if (!hasPreviousReturnLabels) return list;
  const totals = resolvePreviousReturnTotals(list as PreviousReturnField[]);
  if (!totals.liabilitiesDerived || totals.totalLiabilities !== 0) return list;

  const label = PREVIOUS_RETURN_LABELS.totalLiabilities;
  let replaced = false;
  const out = list.map((field) => {
    if (previousReturnFieldKey(field.label) !== "totalLiabilities") return field;
    replaced = true;
    const blank = isBlank(field.value);
    return {
      ...field,
      label: field.label ?? label,
      value: blank ? 0 : field.value,
      confidence: blank ? 0.9 : field.confidence,
    } as T;
  });
  if (!replaced) {
    out.push({ label, value: 0, confidence: 0.9 } as T);
  }
  return out;
}

export type ParsedPreviousReturn = {
  taxpayerName: string;
  registrationNo: string;
  taxYear: number;
  totalAssets: number;
  totalLiabilities: number;
  /** The filed return's closing Net Assets (703001) — the next year's 703002. */
  netAssets: number;
  cashInHand: number | null;
  /** Validated printed Wealth Statement detail rows (Phase 4a); [] if none. */
  wealthRows: PreviousReturnWealthRow[];
};

/** Typed snapshot of an error-free reviewed previous return (else null). */
export function parsePreviousReturnFields(
  fields: PreviousReturnField[] | undefined,
  filingTaxYear?: number,
): ParsedPreviousReturn | null {
  if (getPreviousReturnReviewErrors(fields, filingTaxYear).length) return null;
  const digits = String(previousReturnFieldValue(fields, "registrationNo") ?? "").replace(/\D/g, "");
  const totals = resolvePreviousReturnTotals(fields);
  if (totals.totalLiabilities === null) return null;
  return {
    taxpayerName: String(previousReturnFieldValue(fields, "taxpayerName")).trim(),
    registrationNo: digits,
    taxYear: parsePreviousReturnAmount(previousReturnFieldValue(fields, "taxYear"))!,
    totalAssets: totals.totalAssets!,
    totalLiabilities: totals.totalLiabilities,
    netAssets: totals.netAssets!,
    cashInHand: totals.cashInHand,
    // Rows live on the extraction PAYLOAD, not in fields; the document-level
    // reader below attaches the validated set.
    wealthRows: [],
  };
}

/**
 * The approved previous return among a filing's documents, as a typed
 * snapshot (else null). Callers pass documents newest-first: the newest
 * previous_return governs, and only a MAPPED one counts — an approved
 * snapshot is the sole previous-return input later phases may use.
 */
export function approvedPreviousReturnFromDocuments(
  documents:
    | Array<{
        documentType?: unknown;
        extractionStatus?: unknown;
        extractedData?: unknown;
      }>
    | undefined,
  filingTaxYear?: number,
): ParsedPreviousReturn | null {
  const document = (documents ?? []).find(
    (entry) => entry?.documentType === "previous_return",
  );
  if (!document || document.extractionStatus !== "MAPPED") return null;
  try {
    const payload =
      typeof document.extractedData === "string"
        ? (JSON.parse(document.extractedData) as {
            fields?: unknown;
            previousReturnWealthRows?: unknown;
          })
        : null;
    const snapshot = parsePreviousReturnFields(
      Array.isArray(payload?.fields)
        ? (payload.fields as PreviousReturnField[])
        : undefined,
      filingTaxYear,
    );
    if (!snapshot) return null;
    return {
      ...snapshot,
      wealthRows: parsePreviousReturnWealthRows(
        payload?.previousReturnWealthRows,
        snapshot,
      ),
    };
  } catch {
    return null;
  }
}

/**
 * True only when BOTH the approved return and the taxpayer profile carry a
 * 13-digit registration/CNIC and they differ — i.e. somebody else's return
 * was uploaded. A profile without a CNIC yet cannot mismatch.
 */
export function previousReturnCnicMismatch(
  snapshot: ParsedPreviousReturn | null,
  profileCnic: unknown,
): boolean {
  if (!snapshot) return false;
  const profileDigits = String(profileCnic ?? "").replace(/\D/g, "");
  if (!/^\d{13}$/.test(profileDigits)) return false;
  return profileDigits !== snapshot.registrationNo;
}

/**
 * Review errors for a Previous Year Tax Return upload. `filingTaxYear` is the
 * CURRENT filing's year: the uploaded return must belong to an earlier year,
 * otherwise it is not a previous return at all.
 */
export function getPreviousReturnReviewErrors(
  fields: PreviousReturnField[] | undefined,
  filingTaxYear?: number,
): string[] {
  const errors: string[] = [];
  const list = fields ?? [];

  const duplicated = new Set<Key>();
  for (const key of PREVIOUS_RETURN_REQUIRED_KEYS) {
    const found = previousReturnFieldValues(list, key);
    const label = PREVIOUS_RETURN_LABELS[key];
    if (found.length > 1) {
      duplicated.add(key);
      errors.push(`${label}: duplicate fields; review the extraction.`);
      continue;
    }
    if (found.length === 0 || isBlank(found[0])) {
      // A blank 7029 on a return whose printed assets equal its net assets is
      // IRIS's way of printing nil liabilities; the identity 7019 - 7029 =
      // 703001 proves the zero, so it is not a missing required field.
      const derivedNilLiabilities =
        key === "totalLiabilities" &&
        resolvePreviousReturnTotals(list).liabilitiesDerived;
      if (!derivedNilLiabilities)
        errors.push(
          `${label} is required: type the figure from your previous return.`,
        );
    }
  }

  // Semantic checks run for every field that IS present, so the reviewer sees
  // all problems at once instead of fixing them one save at a time.
  const registrationRaw = previousReturnFieldValue(list, "registrationNo");
  if (!isBlank(registrationRaw) && !duplicated.has("registrationNo")) {
    const registrationNo = String(registrationRaw).replace(/\D/g, "");
    if (!/^\d{13}$/.test(registrationNo))
      errors.push("Registration No must be the 13-digit number printed on the return.");
  }

  const taxYearRaw = previousReturnFieldValue(list, "taxYear");
  const taxYear = parsePreviousReturnAmount(taxYearRaw);
  if (!isBlank(taxYearRaw) && !duplicated.has("taxYear")) {
    if (taxYear === null || taxYear < 2000 || taxYear > 2100) {
      errors.push("Tax Year must be the four-digit tax year printed on the return.");
    } else if (filingTaxYear !== undefined && taxYear >= filingTaxYear) {
      errors.push(
        `Tax Year must be earlier than this filing's Tax Year ${filingTaxYear}: upload a return filed for a previous year.`,
      );
    }
  }

  const {
    totalAssets,
    totalLiabilities,
    netAssets,
    cashInHand,
    liabilitiesDerived,
  } = resolvePreviousReturnTotals(list);
  const cashRaw = previousReturnFieldValue(list, "cashInHand");

  if (!isBlank(previousReturnFieldValue(list, "totalAssets")) && (totalAssets === null || totalAssets < 0))
    errors.push("Total Assets (7019) must be a whole PKR amount (0 or more).");
  if (!liabilitiesDerived && !isBlank(previousReturnFieldValue(list, "totalLiabilities")) && (totalLiabilities === null || totalLiabilities < 0))
    errors.push("Total Liabilities (7029) must be a whole PKR amount (0 if the return shows none).");
  if (!isBlank(previousReturnFieldValue(list, "netAssets")) && netAssets === null)
    errors.push("Net Assets (703001) must be a whole PKR amount.");
  if (!isBlank(cashRaw) && (cashInHand === null || cashInHand < 0))
    errors.push("Cash in Hand (7012) must be a whole PKR amount (0 or more).");

  if (
    totalAssets !== null &&
    totalLiabilities !== null &&
    netAssets !== null &&
    Math.abs(totalAssets - totalLiabilities - netAssets) > 1
  ) {
    errors.push(
      "Wealth figures do not tie out: Total Assets (7019) minus Total Liabilities (7029) must equal Net Assets (703001). Re-check them against the Wealth Statement in the printed return.",
    );
  }

  return errors;
}
