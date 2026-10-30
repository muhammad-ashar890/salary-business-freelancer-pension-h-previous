/**
 * DP-2 (Data Push, 16-Oct-2026): the IRIS "Business Details" top tab.
 *
 * IRIS structure [PROVEN: captures 41, 55, 70 and 71 in
 * ~/iris-business-captures, IRIS 2.0, 15-Oct-2026]:
 * - Top tab "Business Details" -> table "Businesses" with the columns
 *   Sr No. | Business Name | Principal Activity | Start Date | End Date |
 *   Brand Name | Action, and a "+ Business" button (title "Add Business").
 * - "+ Business" opens the dialog "Business Details": Business Name*
 *   (max 100), Principal Activity* (Manufacturing / Services / Trading /
 *   Other), Brand Name* (max 100; IRIS hint: "Add multiple brands separating
 *   with a comma"), Start Date* (date picker), End Date (date picker);
 *   CLOSE / SAVE.
 * - A saved business shows its dates as "19-Jul-2013" and each brand as a
 *   separate badge.
 *
 * How IRIS parses a TYPED date has not been seen yet [CHECK-LIVE]. The agent
 * types DD/MM/YYYY (the format IRIS prints as placeholder on its other date
 * fields, captures 63 / 65) and only accepts the entry after IRIS shows the
 * same date back; after SAVE it checks the table, whose month-name format
 * cannot be misread.
 */

export const BUSINESS_IDENTITY_DETAIL_KEY = "businessIdentity";

/** Options of the IRIS "Principal Activity" list, exactly as IRIS shows them. */
export const IRIS_PRINCIPAL_ACTIVITIES = [
  "Manufacturing",
  "Services",
  "Trading",
  "Other",
] as const;
export type IrisPrincipalActivity = (typeof IRIS_PRINCIPAL_ACTIVITIES)[number];

export const IRIS_BUSINESS_LIMITS = Object.freeze({
  businessName: 100,
  brandName: 100,
});

/** Last day of the tax year the business details belong to (TY2026). */
export const TY2026_LAST_DAY = "2026-06-30";

/** What the wizard stores; may be incomplete while it is being typed. */
export type BusinessIdentity = {
  businessName: string;
  principalActivity?: IrisPrincipalActivity;
  brandName: string;
  /** ISO date (YYYY-MM-DD). */
  startDate?: string;
  /** ISO date; only when the business closed. */
  endDate?: string;
};

export type BusinessDetailsPlan = {
  version: "business-details-v1";
  businessName: string;
  principalActivity: IrisPrincipalActivity;
  brandName: string;
  /** Brands as IRIS lists them (split at commas). */
  brands: string[];
  startDate: string;
  endDate: string | null;
  /** What the agent types into the date pickers. */
  typed: { startDate: string; endDate: string | null };
  /** How the IRIS table shows the saved dates. */
  table: { startDate: string; endDate: string | null };
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const cleanText = (raw: unknown) =>
  String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();

/** A real calendar date in ISO form, or null. */
export function parseIsoDate(value: unknown): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  )
    return null;
  return { y, m, d };
}

/**
 * The IRIS "Principal Activity" printed in a business record's own words.
 *
 * Reported 27 Oct 2026: the step asked the reviewer to choose the activity by
 * hand although the uploaded Business Profile printed
 * "Nature of business: Trading - general order supplier / wholesale". IRIS only
 * accepts the four options, so the printed wording can never be entered as-is;
 * the mapping is deterministic, and nothing is guessed when the printed wording
 * names no supported activity (null -> the reviewer chooses).
 */
export function parsePrincipalActivity(
  raw: unknown,
): IrisPrincipalActivity | null {
  const text = cleanText(raw).toLowerCase();
  if (!text) return null;
  const words = text.split(/[^a-z]+/).filter(Boolean);
  const exact: Record<string, IrisPrincipalActivity> = {
    manufacturing: "Manufacturing",
    manufacture: "Manufacturing",
    manufacturer: "Manufacturing",
    factory: "Manufacturing",
    production: "Manufacturing",
    services: "Services",
    service: "Services",
    servicing: "Services",
    consultancy: "Services",
    consultant: "Services",
    trading: "Trading",
    trade: "Trading",
    trader: "Trading",
    traders: "Trading",
    wholesale: "Trading",
    retail: "Trading",
    supplier: "Trading",
    distribution: "Trading",
    other: "Other",
  };
  // The first word wins: "Trading - general order supplier" is Trading.
  if (words.length && exact[words[0]]) return exact[words[0]];
  // Otherwise a single unambiguous business-form word anywhere in the text.
  for (const word of words) if (exact[word]) return exact[word];
  return null;
}

/**
 * A printed business date as ISO, or null.
 *
 * IRIS and printed accounts both use "01-Jul-2015"; the wizard stores ISO. Only
 * unambiguous day-first forms are read (the app's own review dates are day
 * first too); anything else returns null so the existing "must be a date" error
 * stays with the reviewer instead of a guessed day and month.
 */
export function parseBusinessDate(raw: unknown): string | null {
  const text = cleanText(raw);
  if (!text) return null;
  const iso = parseIsoDate(text);
  if (iso) return `${iso.y}-${pad(iso.m)}-${pad(iso.d)}`;
  const named = /^(\d{1,2})[\s-\/]([A-Za-z]{3,9})[\s-\/](\d{4})$/.exec(text);
  if (named) {
    const month = MONTHS.findIndex(
      (name) => name.toLowerCase() === named[2].slice(0, 3).toLowerCase(),
    );
    if (month >= 0) {
      const candidate = `${named[3]}-${pad(month + 1)}-${pad(Number(named[1]))}`;
      if (parseIsoDate(candidate)) return candidate;
    }
    return null;
  }
  const numeric = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/.exec(text);
  if (numeric) {
    const candidate = `${numeric[3]}-${pad(Number(numeric[2]))}-${pad(Number(numeric[1]))}`;
    if (parseIsoDate(candidate)) return candidate;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2013-07-19" -> "19/07/2013" (typed into the IRIS date picker). */
export function irisTypedDate(iso: string): string {
  const date = parseIsoDate(iso);
  if (!date) throw new Error(`Not a date: ${iso}`);
  return `${pad(date.d)}/${pad(date.m)}/${date.y}`;
}

/** "2013-07-19" -> "19-Jul-2013" (how the IRIS Businesses table shows it). */
export function irisTableDate(iso: string): string {
  const date = parseIsoDate(iso);
  if (!date) throw new Error(`Not a date: ${iso}`);
  return `${pad(date.d)}-${MONTHS[date.m - 1]}-${date.y}`;
}

/** Brands as separate badges: split at commas, blanks dropped. */
export function splitBrands(brandName: string): string[] {
  return brandName
    .split(",")
    .map((brand) => cleanText(brand))
    .filter(Boolean);
}

/**
 * Shape check for what the wizard stores. An object with nothing in it is
 * dropped; anything malformed is an error (never silently "fixed").
 */
export function sanitizeBusinessIdentity(
  value: unknown,
): { ok: true; identity: BusinessIdentity | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, identity: null };
  if (typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: "Business details must be an object." };
  const record = value as Record<string, unknown>;
  for (const key of ["businessName", "brandName", "principalActivity", "startDate", "endDate"]) {
    const entry = record[key];
    if (entry !== undefined && entry !== null && typeof entry !== "string")
      return { ok: false, error: `Business details: ${key} must be text.` };
  }
  const businessName = cleanText(record.businessName);
  const brandName = cleanText(record.brandName);
  if (businessName.length > IRIS_BUSINESS_LIMITS.businessName)
    return { ok: false, error: `Business name is longer than IRIS accepts (${IRIS_BUSINESS_LIMITS.businessName} characters).` };
  if (brandName.length > IRIS_BUSINESS_LIMITS.brandName)
    return { ok: false, error: `Brand name is longer than IRIS accepts (${IRIS_BUSINESS_LIMITS.brandName} characters).` };
  // A printed wording ("Trading - general order supplier") is mapped to the one
  // IRIS option it names; an unrecognised wording keeps its own error.
  const activityRaw = cleanText(record.principalActivity);
  const activity = activityRaw
    ? (parsePrincipalActivity(activityRaw) ?? activityRaw)
    : "";
  if (activity && !(IRIS_PRINCIPAL_ACTIVITIES as readonly string[]).includes(activity))
    return { ok: false, error: `Principal activity must be one of: ${IRIS_PRINCIPAL_ACTIVITIES.join(", ")}.` };
  // "01-Jul-2015" and "01/07/2015" are the same date as 2015-07-01; the ISO
  // form is what the wizard stores.
  const startDate = parseBusinessDate(record.startDate) ?? cleanText(record.startDate);
  const endDate = parseBusinessDate(record.endDate) ?? cleanText(record.endDate);
  for (const [label, date] of [["Start date", startDate], ["End date", endDate]] as const)
    if (date && !parseIsoDate(date))
      return { ok: false, error: `${label} must be a date (YYYY-MM-DD).` };
  if (!businessName && !brandName && !activity && !startDate && !endDate)
    return { ok: true, identity: null };
  const identity: BusinessIdentity = { businessName, brandName };
  if (activity) identity.principalActivity = activity as IrisPrincipalActivity;
  if (startDate) identity.startDate = startDate;
  if (endDate) identity.endDate = endDate;
  return { ok: true, identity };
}

/** Plain-language problems; empty means the agent can enter it. */
export function validateBusinessIdentity(
  identity: BusinessIdentity,
  lastDay: string = TY2026_LAST_DAY,
): string[] {
  const problems: string[] = [];
  if (!identity.businessName) problems.push("Business details: enter the business name.");
  if (!identity.principalActivity)
    problems.push("Business details: choose the principal activity (Manufacturing, Services, Trading or Other).");
  if (!identity.brandName)
    problems.push(
      "Business details: IRIS requires a brand name. If the business has no separate brand, write the business name.",
    );
  if (!identity.startDate) problems.push("Business details: enter the date the business started.");
  else if (identity.startDate > lastDay)
    problems.push(`Business details: the start date is after the end of the tax year (${lastDay}).`);
  if (identity.endDate) {
    if (identity.startDate && identity.endDate < identity.startDate)
      problems.push("Business details: the end date is before the start date.");
    if (identity.endDate > lastDay)
      problems.push(
        `Business details: the end date is after the end of the tax year (${lastDay}). Leave it empty if the business is still running.`,
      );
  }
  return problems;
}

/** Packet entry for a complete identity; refuses (throws) instead of half-building. */
export function buildBusinessDetailsPlan(identity: BusinessIdentity): BusinessDetailsPlan {
  const problems = validateBusinessIdentity(identity);
  if (problems.length) throw new Error(problems.join(" "));
  const startDate = identity.startDate as string;
  const endDate = identity.endDate ?? null;
  return {
    version: "business-details-v1",
    businessName: identity.businessName,
    principalActivity: identity.principalActivity as IrisPrincipalActivity,
    brandName: identity.brandName,
    brands: splitBrands(identity.brandName),
    startDate,
    endDate,
    typed: {
      startDate: irisTypedDate(startDate),
      endDate: endDate ? irisTypedDate(endDate) : null,
    },
    table: {
      startDate: irisTableDate(startDate),
      endDate: endDate ? irisTableDate(endDate) : null,
    },
  };
}
