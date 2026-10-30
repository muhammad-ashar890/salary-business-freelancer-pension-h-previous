// Decides which filing draft a "create" or "save" request belongs to.
//
// A taxpayer can have more than one filing for the same tax year: for example
// the salary return is filed first and a business return is prepared later.
// The database no longer forces one draft per user per year, so the code that
// saves a draft must choose between UPDATING an existing draft and CREATING a
// new one. A wrong choice silently overwrites a return that was already
// approved or filed, so the rule lives here, in one pure and tested place.

import { FILING_STATUS } from "@/lib/tax/filing-status";

/** FbrConnection states that mean a filing job is running right now. */
const ACTIVE_FBR_CONNECTION_STATUSES = [
  "WAITING_FOR_AGENT",
  "CONNECTED",
  "SUBMITTING",
] as const;

/** FbrConnection state written when the desktop agent finished a real filing. */
const FILING_COMPLETED_STATUS = "FILING_COMPLETED";

export type ProtectionCandidate = {
  status?: string | null;
  packetApprovalConfirmed?: boolean | null;
  filingPackets?: ReadonlyArray<{ approvalStatus?: string | null }> | null;
  fbrConnections?: ReadonlyArray<{ status?: string | null }> | null;
};

/**
 * A draft is protected when it holds work that a new filing must never
 * overwrite: it was approved, an approved packet exists, the desktop agent
 * finished or is running a real filing for it, or it is marked filed.
 *
 * A dry run (DRY_RUN_COMPLETED) does not protect a draft: nothing was filed.
 */
export function isProtectedFilingDraft(draft: ProtectionCandidate): boolean {
  if (
    draft.status === FILING_STATUS.FILED ||
    draft.status === FILING_STATUS.APPROVED_FOR_FILING
  ) {
    return true;
  }
  if (draft.packetApprovalConfirmed === true) return true;
  if (
    (draft.filingPackets ?? []).some(
      (packet) => packet.approvalStatus === "APPROVED",
    )
  ) {
    return true;
  }
  return (draft.fbrConnections ?? []).some(
    (connection) =>
      connection.status === FILING_COMPLETED_STATUS ||
      (ACTIVE_FBR_CONNECTION_STATUSES as readonly string[]).includes(
        connection.status ?? "",
      ),
  );
}

export type ReuseCandidate = ProtectionCandidate & {
  id: string;
  updatedAt: Date | string | number;
  /** Stored JSON array of income sources, as on FilingDraft. */
  incomeSources?: string | null;
};

/** The stored income sources of a draft; null when the value cannot be read. */
export function draftIncomeSources(
  stored: string | null | undefined,
): string[] | null {
  if (stored === null || stored === undefined) return [];
  try {
    const parsed = JSON.parse(String(stored));
    if (!Array.isArray(parsed)) return null;
    return parsed.map(String);
  } catch {
    return null;
  }
}

/** Same set of sources, order and duplicates ignored. */
function sameSourceSet(a: readonly string[], b: readonly string[]) {
  const norm = (list: readonly string[]) =>
    [...new Set(list.map((item) => String(item).trim().toLowerCase()))]
      .filter(Boolean)
      .sort()
      .join(",");
  return norm(a) === norm(b);
}

/**
 * True when a save carrying `incomingIncomeSources` may continue this draft.
 *
 * A filing belongs to an income source. A draft that already holds sources may
 * only be continued by the same sources: otherwise starting a Salary filing
 * would quietly turn an unfinished Pension draft into a Salary one, and the
 * Pension filing would disappear from History with its documents still on it.
 * A draft that has chosen no source yet can be continued by anything.
 */
export function draftAcceptsIncomeSources(
  candidate: Pick<ReuseCandidate, "incomeSources">,
  incomingIncomeSources: readonly string[],
): boolean {
  const stored = draftIncomeSources(candidate.incomeSources);
  // Unreadable: never overwrite work we cannot understand.
  if (stored === null) return false;
  if (!stored.length) return true;
  if (!incomingIncomeSources.length) return false;
  return sameSourceSet(stored, incomingIncomeSources);
}

/**
 * Picks the draft a request without an explicit draft id may reuse: the most
 * recently updated draft for that user and year that is NOT protected, and —
 * when the caller says which income sources it is about to save — that also
 * belongs to those same sources.
 * Returns null when every same-year draft is protected or belongs to another
 * income source, which means a new draft must be created beside them.
 */
export function pickReusableDraft<T extends ReuseCandidate>(
  sameYearDrafts: readonly T[],
  incomingIncomeSources?: readonly string[],
): T | null {
  const reusable = sameYearDrafts
    .filter((draft) => !isProtectedFilingDraft(draft))
    .filter(
      (draft) =>
        incomingIncomeSources === undefined ||
        draftAcceptsIncomeSources(draft, incomingIncomeSources),
    )
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  return reusable[0] ?? null;
}

/**
 * The filing that already covers these income sources in this tax year, if any.
 *
 * One income source is filed once per tax year: a Salary return is the same
 * return whether it is started today or next week. A second draft of the same
 * source is therefore never created; the existing one is opened instead.
 */
export function findFilingForIncomeSources<
  T extends {
    id: string;
    taxYear: number;
    updatedAt: Date | string | number;
    incomeSources?: string | null;
  },
>(
  drafts: readonly T[],
  taxYear: number,
  incomingIncomeSources: readonly string[],
): T | null {
  if (!incomingIncomeSources.length) return null;
  const matches = drafts
    .filter((draft) => draft.taxYear === taxYear)
    .filter((draft) => {
      const stored = draftIncomeSources(draft.incomeSources);
      return (
        stored !== null &&
        stored.length > 0 &&
        sameSourceSet(stored, incomingIncomeSources)
      );
    })
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  return matches[0] ?? null;
}

/**
 * The other filings of the same tax year that carry the same income sources,
 * oldest first. Empty when this is the only filing of its kind, which is the
 * normal case; two entries here mean the same return was started twice.
 */
export function sameSourceFilingIds(
  drafts: ReadonlyArray<{
    id: string;
    taxYear: number;
    createdAt: Date | string | number;
    incomeSources?: string | null;
  }>,
  draftId: string,
): string[] {
  const target = drafts.find((draft) => draft.id === draftId);
  if (!target) return [];
  const sources = draftIncomeSources(target.incomeSources);
  if (!sources || !sources.length) return [];
  return drafts
    .filter((draft) => draft.id !== draftId && draft.taxYear === target.taxYear)
    .filter((draft) => {
      const other = draftIncomeSources(draft.incomeSources);
      return other !== null && other.length > 0 && sameSourceSet(other, sources);
    })
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map((draft) => draft.id);
}

export type SameYearPosition = { position: number; total: number };

/**
 * Numbers the filings of each tax year in creation order, so two filings for
 * the same year can be told apart ("Filing 1 of 2"). Years with a single
 * filing get total = 1 and need no label.
 */
export function numberFilingsPerYear(
  drafts: ReadonlyArray<{
    id: string;
    taxYear: number;
    createdAt: Date | string | number;
  }>,
): Map<string, SameYearPosition> {
  const byYear = new Map<number, typeof drafts[number][]>();
  for (const draft of drafts) {
    const group = byYear.get(draft.taxYear) ?? [];
    group.push(draft);
    byYear.set(draft.taxYear, group);
  }

  const result = new Map<string, SameYearPosition>();
  for (const group of byYear.values()) {
    const ordered = [...group].sort((a, b) => {
      const diff =
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
    ordered.forEach((draft, index) =>
      result.set(draft.id, { position: index + 1, total: ordered.length }),
    );
  }
  return result;
}

const INCOME_SOURCE_LABELS: Record<string, string> = {
  salary: "Salary",
  pension: "Pension",
  property_rent: "Rental income",
  services: "Freelancer",
  bank_profit: "Bank profit",
  dividend: "Dividend",
  capital_gains: "Capital gains",
  business: "Business income",
  agriculture: "Agriculture",
  foreign_income_assets: "Non-resident",
  aop_company_links: "AOP / Company",
  sales_tax_fed_withholding: "Sales tax / FED",
  other_income: "Other income",
};

/**
 * Short human summary of a draft's income sources, for list screens. Accepts
 * the stored JSON string. Unknown or unreadable input gives an empty string.
 */
export function describeIncomeSources(stored: string | null | undefined) {
  if (!stored) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return "";
  }
  if (!Array.isArray(parsed)) return "";
  const labels: string[] = [];
  for (const source of parsed) {
    const label = INCOME_SOURCE_LABELS[String(source)];
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.join(", ");
}
