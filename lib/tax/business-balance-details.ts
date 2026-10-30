/**
 * DP-2 (Data Push, 16-Oct-2026): business bank accounts (IRIS Balance Sheet
 * row 3320), motor vehicles (row 3304), and business land / building
 * properties (rows 3301 / 3302), in the shape IRIS takes them.
 *
 * IRIS structure [PROVEN: captures "balance sheet visible fields", "3320
 * popup" and "3304 popup", IRIS 2.0, 15-Oct-2026]:
 * - 3320 "Bank Account" is a computed summary row. Each account is a child row
 *   created through the summary row's "Add Bank Account" icon -> dialog "Bank
 *   Account": IBAN* (max 24) + search; IRIS fills Account Title and Bank Name;
 *   checkboxes "Joint Account" and "Foreign Currency/Others"; ADD. The child
 *   row reads "Bank Account - <IBAN> - <title> - <bank> - Self" and takes the
 *   amount in its one editable cell.
 * - 3304 "Motor Vehicle(s)": "Add Motor Vehicle" icon -> dialog "Motor
 *   Vehicle": Vehicle Registration No.* (max 15), Chassis No. (max 20),
 *   Make* (max 50), Model* (max 50); ADD. The child row reads
 *   "Motor Vehicle(s) - <reg> - <chassis> - <make> - <model>".
 * - 3301 "Land (Business)" and 3302 "Building (Business)": "+ Property" ->
 *   dialog "Select Property" -> "Add Property" -> dialog "Property
 *   Information": Property type*, Property sub-type*, Date of Acquisition
 *   (DD/MM/YYYY), Land area unit*, Land area*, Acquisition cost/value,
 *   Province / Territory*, District* (form control divisionId), City*,
 *   Property/ Plot/ House/ Shop No.* and Sector / Mohalla / Block*; Save.
 *   A selected property becomes a child row such as "Building (Business) -
 *   Farm House, 213 Kanal, 456, 34, Fatah Jang, Attock, Punjab" and takes
 *   the Balance Sheet amount in its one editable cell. The acquisition
 *   date and acquisition cost/value are not marked required in the captured
 *   form; every other Property Information field above is required.
 *
 * Only own (non-joint) Pakistani-rupee accounts are pushed: what IRIS asks
 * after ticking "Joint Account" or "Foreign Currency/Others" has not been
 * captured, so those stay manual. Amounts are the Balance Sheet figures at
 * 30 June (whole rupees), and they must add up to the Balance Sheet's own
 * bank / vehicle figure; a difference is a data problem the app reports
 * before any packet is built.
 */
import type { PortalFieldMapEntry } from "@/lib/tax/portal-field-map";

export const BUSINESS_BANK_ACCOUNTS_DETAIL_KEY = "businessBankAccounts";
export const BUSINESS_VEHICLES_DETAIL_KEY = "businessVehicles";
export const BUSINESS_PROPERTIES_DETAIL_KEY = "businessProperties";

export const IRIS_BANK_ROW = "3320";
export const IRIS_VEHICLE_ROW = "3304";
export const IRIS_LAND_ROW = "3301";
export const IRIS_BUILDING_ROW = "3302";
export const IRIS_BANK_ROW_LABEL = "Bank Account";
export const IRIS_VEHICLE_ROW_LABEL = "Motor Vehicle(s)";
export const IRIS_LAND_ROW_LABEL = "Land (Business)";
export const IRIS_BUILDING_ROW_LABEL = "Building (Business)";

/** Exact option text captured from the IRIS Property Information dialog. */
export const IRIS_PROPERTY_TYPES = Object.freeze([
  "Agricultural Property",
  "Commercial Property",
  "Industrial Property",
  "Residential Property",
] as const);
export const IRIS_PROPERTY_SUB_TYPES = Object.freeze([
  "Constructed Property",
  "Farm House",
  "Flat",
  "Open Plot",
] as const);
export const IRIS_PROPERTY_AREA_UNITS = Object.freeze([
  "Acre",
  "Kanal",
  "Marla",
  "Square Foot",
  "Square Meter",
  "Square Yard",
] as const);
export const IRIS_PROPERTY_PROVINCES = Object.freeze([
  "Punjab",
  "Sindh",
  "Khyber Pakhtunkhwa",
  "Balochistan",
  "ICT",
  "AJK",
  "FATA",
  "Gilgit Baltistan",
] as const);

export type BusinessPropertyBalanceRow = "land" | "building";

/** Input limits of the IRIS dialogs (maxlength attributes in the captures). */
export const IRIS_LIMITS = Object.freeze({
  iban: 24,
  registrationNo: 15,
  chassisNo: 20,
  make: 50,
  model: 50,
});

/**
 * Property Information limits. Land area (Acre) and acquisition cost carry
 * maxlength 8 and 16 in the captures; the remaining text limits are safe
 * storage bounds because IRIS does not publish a maxlength for the selects
 * or the two address fields.
 */
export const IRIS_PROPERTY_LIMITS = Object.freeze({
  propertyType: 80,
  propertySubType: 80,
  areaUnit: 40,
  landAreaText: 8,
  acquisitionCostText: 16,
  province: 80,
  district: 80,
  city: 80,
  propertyNo: 200,
  sectorMohallaBlock: 200,
});

const MAX_ROWS = 25;

/** What the wizard stores; a row may be incomplete while it is being typed. */
export type BusinessBankAccount = {
  iban: string;
  balance?: number;
};

export type BusinessVehicle = {
  registrationNo: string;
  chassisNo?: string;
  make: string;
  model: string;
  value?: number;
};

/**
 * One business land/building property as IRIS's Property Information dialog
 * takes it. `value` is different from `acquisitionCost`: it is the amount
 * typed into the Balance Sheet child row at 30 June, while acquisition cost
 * is the optional historic cost/value on the property record itself.
 */
export type BusinessProperty = {
  balanceRow: BusinessPropertyBalanceRow | "";
  propertyType: string;
  propertySubType: string;
  acquisitionDate?: string;
  areaUnit: string;
  landArea?: number;
  acquisitionCost?: number;
  province: string;
  district: string;
  city: string;
  propertyNo: string;
  sectorMohallaBlock: string;
  value?: number;
};

export type BalanceDetailAgentField = {
  key: string;
  kind: "bank" | "vehicle" | "property";
  irisCode:
    | typeof IRIS_BANK_ROW
    | typeof IRIS_VEHICLE_ROW
    | typeof IRIS_LAND_ROW
    | typeof IRIS_BUILDING_ROW;
  label: string;
  column: "Amount";
  value: string;
  /** Text IRIS prints in the child row; tells the rows apart. */
  rowDescriptionIncludes: string;
  iban?: string;
  registrationNo?: string;
  chassisNo?: string;
  make?: string;
  model?: string;
  balanceRow?: BusinessPropertyBalanceRow;
  propertyType?: string;
  propertySubType?: string;
  acquisitionDate?: string;
  /** Date exactly as typed into IRIS (DD/MM/YYYY). */
  acquisitionDateIris?: string;
  areaUnit?: string;
  landArea?: number;
  /** Land area exactly as typed and as printed in the IRIS child row. */
  landAreaText?: string;
  acquisitionCost?: number;
  province?: string;
  district?: string;
  city?: string;
  propertyNo?: string;
  sectorMohallaBlock?: string;
};

export type BalanceDetailsPlan = {
  /** v1 = bank / vehicle child rows only; v2 adds 3301 / 3302 properties. */
  version: "balance-details-v1" | "balance-details-v2";
  banks: { iban: string; amount: number }[];
  vehicles: {
    registrationNo: string;
    chassisNo: string;
    make: string;
    model: string;
    amount: number;
  }[];
  properties: {
    balanceRow: BusinessPropertyBalanceRow;
    propertyType: string;
    propertySubType: string;
    acquisitionDate: string;
    areaUnit: string;
    landArea: number;
    landAreaText: string;
    acquisitionCost: number | null;
    province: string;
    district: string;
    city: string;
    propertyNo: string;
    sectorMohallaBlock: string;
    amount: number;
  }[];
  /** The child-row amounts as packet fields (Balance Sheet, column Amount). */
  fields: PortalFieldMapEntry[];
  /** What the agent needs per child row: dialog values + the amount. */
  agentFields: BalanceDetailAgentField[];
  totals: { bank: number; vehicle: number; land: number; building: number };
};

const money = (value: number) => Math.round(value).toLocaleString("en-US");

/** Spaces / dashes removed, upper case: the form IRIS shows in the child row. */
export function normalizeIban(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[\s-]/g, "")
    .toUpperCase();
}

/**
 * Pakistani IBAN: "PK", 2 check digits, 4-letter bank code, 16 characters,
 * and the ISO 13616 mod-97 check (remainder 1). IRIS still has the last word:
 * it only resolves accounts it knows.
 */
export function isValidPakistanIban(iban: string): boolean {
  if (!/^PK\d{2}[A-Z]{4}[0-9A-Z]{16}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const cleanText = (raw: unknown) =>
  String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();

function readAmount(
  raw: unknown,
  what: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true };
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)
    return { ok: false, error: `${what} must be a number of zero or more.` };
  if (!Number.isInteger(raw))
    return { ok: false, error: `${what}: IRIS takes whole rupees only.` };
  return { ok: true, value: raw };
}

function readText(
  raw: unknown,
  limit: number,
  what: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (raw !== undefined && raw !== null && typeof raw !== "string")
    return { ok: false, error: `${what} must be text.` };
  const value = cleanText(raw);
  if (value.length > limit)
    return { ok: false, error: `${what} is longer than IRIS accepts (${limit} characters).` };
  return { ok: true, value };
}

/** Case-insensitive exact match against a captured IRIS option list. */
function canonicalOption(value: string, options: readonly string[]): string {
  return options.find((option) => option.toLowerCase() === value.toLowerCase()) ?? value;
}

function readDecimal(
  raw: unknown,
  what: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true };
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)
    return { ok: false, error: `${what} must be a number of zero or more.` };
  return { ok: true, value: raw };
}

/** ISO date exactly as typed into IRIS's DD/MM/YYYY acquisition field. */
export function irisPropertyDate(isoDate: string | undefined): string {
  if (!isoDate) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "";
}

function isRealIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** The area as IRIS prints it in the child row: no trailing zeroes. */
export function formatPropertyArea(value: number): string {
  if (!Number.isFinite(value)) return "";
  const fixed = value.toFixed(4).replace(/\.?0+$/, "");
  return fixed === "-0" ? "0" : fixed;
}

export const propertyBalanceRowCode = (
  balanceRow: BusinessPropertyBalanceRow,
): typeof IRIS_LAND_ROW | typeof IRIS_BUILDING_ROW =>
  balanceRow === "land" ? IRIS_LAND_ROW : IRIS_BUILDING_ROW;

export const propertyBalanceRowLabel = (
  balanceRow: BusinessPropertyBalanceRow,
): string => (balanceRow === "land" ? IRIS_LAND_ROW_LABEL : IRIS_BUILDING_ROW_LABEL);

/**
 * The identifying part of the IRIS child-row description, after
 * "Land (Business) - " / "Building (Business) - " [PROVEN: the two existing
 * 3302 child rows in capture "balance sheet visible fields"].
 */
export function propertyRowDescription(row: {
  propertySubType: string;
  landArea?: number;
  areaUnit: string;
  propertyNo: string;
  sectorMohallaBlock: string;
  city: string;
  district: string;
  province: string;
}): string {
  return [
    row.propertySubType,
    `${formatPropertyArea(row.landArea ?? Number.NaN)} ${row.areaUnit}`.trim(),
    row.propertyNo,
    row.sectorMohallaBlock,
    row.city,
    row.district,
    row.province,
  ].join(", ");
}

export const propertyRowText = (row: BusinessProperty): string =>
  row.balanceRow
    ? `${propertyBalanceRowLabel(row.balanceRow)} - ${propertyRowDescription(row)}`
    : propertyRowDescription(row);

/**
 * Shape check for the stored bank-account list. Rows with nothing in them are
 * dropped; anything malformed is an error (never silently "fixed").
 */
export function sanitizeBusinessBankAccounts(
  value: unknown,
): { ok: true; rows: BusinessBankAccount[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, rows: [] };
  if (!Array.isArray(value))
    return { ok: false, error: "Business bank accounts must be a list." };
  if (value.length > MAX_ROWS)
    return { ok: false, error: `List at most ${MAX_ROWS} business bank accounts.` };
  const rows: BusinessBankAccount[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return { ok: false, error: "Each business bank account must be an object." };
    const record = entry as Record<string, unknown>;
    if (record.iban !== undefined && record.iban !== null && typeof record.iban !== "string")
      return { ok: false, error: "IBAN must be text." };
    const iban = normalizeIban(record.iban);
    if (iban.length > IRIS_LIMITS.iban)
      return { ok: false, error: `IBAN ${iban} is longer than ${IRIS_LIMITS.iban} characters.` };
    const balance = readAmount(record.balance, `Balance of ${iban || "a bank account"}`);
    if (!balance.ok) return { ok: false, error: (balance as { error: string }).error };
    if (!iban && balance.value === undefined) continue;
    const row: BusinessBankAccount = { iban };
    if (balance.value !== undefined) row.balance = balance.value;
    rows.push(row);
  }
  return { ok: true, rows };
}

/** Shape check for the stored vehicle list (same rules as the bank list). */
export function sanitizeBusinessVehicles(
  value: unknown,
): { ok: true; rows: BusinessVehicle[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, rows: [] };
  if (!Array.isArray(value))
    return { ok: false, error: "Business vehicles must be a list." };
  if (value.length > MAX_ROWS)
    return { ok: false, error: `List at most ${MAX_ROWS} business vehicles.` };
  const rows: BusinessVehicle[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return { ok: false, error: "Each business vehicle must be an object." };
    const record = entry as Record<string, unknown>;
    const registrationNo = readText(record.registrationNo, IRIS_LIMITS.registrationNo, "Registration number");
    if (!registrationNo.ok) return { ok: false, error: (registrationNo as { error: string }).error };
    const chassisNo = readText(record.chassisNo, IRIS_LIMITS.chassisNo, "Chassis number");
    if (!chassisNo.ok) return { ok: false, error: (chassisNo as { error: string }).error };
    const make = readText(record.make, IRIS_LIMITS.make, "Make");
    if (!make.ok) return { ok: false, error: (make as { error: string }).error };
    const model = readText(record.model, IRIS_LIMITS.model, "Model");
    if (!model.ok) return { ok: false, error: (model as { error: string }).error };
    const amount = readAmount(record.value, `Value of vehicle ${registrationNo.value || ""}`.trim());
    if (!amount.ok) return { ok: false, error: (amount as { error: string }).error };
    if (
      !registrationNo.value &&
      !chassisNo.value &&
      !make.value &&
      !model.value &&
      amount.value === undefined
    )
      continue;
    const row: BusinessVehicle = {
      registrationNo: registrationNo.value,
      make: make.value,
      model: model.value,
    };
    if (chassisNo.value) row.chassisNo = chassisNo.value;
    if (amount.value !== undefined) row.value = amount.value;
    rows.push(row);
  }
  return { ok: true, rows };
}

/**
 * Shape check for the stored property list. Captured IRIS option spellings
 * are canonicalized case-insensitively (including a bare "Commercial" for
 * "Commercial Property"); an unknown district/city/sub-type spelling is kept
 * as written so the driver can try the exact text and stop safely if IRIS
 * does not offer it.
 */
export function sanitizeBusinessProperties(
  value: unknown,
): { ok: true; rows: BusinessProperty[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, rows: [] };
  if (!Array.isArray(value))
    return { ok: false, error: "Business properties must be a list." };
  if (value.length > MAX_ROWS)
    return { ok: false, error: `List at most ${MAX_ROWS} business properties.` };
  const rows: BusinessProperty[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return { ok: false, error: "Each business property must be an object." };
    const record = entry as Record<string, unknown>;
    const balanceRowText = readText(record.balanceRow, 20, "Balance Sheet row");
    if (!balanceRowText.ok) return { ok: false, error: (balanceRowText as { error: string }).error };
    const balanceRowLower = balanceRowText.value.toLowerCase();
    if (balanceRowLower && balanceRowLower !== "land" && balanceRowLower !== "building")
      return { ok: false, error: "Balance Sheet row must be land or building." };
    const texts: Record<string, string> = {};
    for (const [field, limit, what] of [
      ["propertyType", IRIS_PROPERTY_LIMITS.propertyType, "Property type"],
      ["propertySubType", IRIS_PROPERTY_LIMITS.propertySubType, "Property sub-type"],
      ["areaUnit", IRIS_PROPERTY_LIMITS.areaUnit, "Land area unit"],
      ["province", IRIS_PROPERTY_LIMITS.province, "Province / Territory"],
      ["district", IRIS_PROPERTY_LIMITS.district, "District"],
      ["city", IRIS_PROPERTY_LIMITS.city, "City"],
      ["propertyNo", IRIS_PROPERTY_LIMITS.propertyNo, "Property/ Plot/ House/ Shop No."],
      ["sectorMohallaBlock", IRIS_PROPERTY_LIMITS.sectorMohallaBlock, "Sector / Mohalla / Block"],
    ] as const) {
      const read = readText(record[field], limit, what);
      if (!read.ok) return { ok: false, error: (read as { error: string }).error };
      texts[field] = read.value;
    }
    const propertyTypeCandidate = / property$/i.test(texts.propertyType)
      ? texts.propertyType
      : `${texts.propertyType} Property`;
    const canonicalPropertyType = canonicalOption(propertyTypeCandidate, IRIS_PROPERTY_TYPES);
    texts.propertyType = (IRIS_PROPERTY_TYPES as readonly string[]).includes(canonicalPropertyType)
      ? canonicalPropertyType
      : texts.propertyType;
    if (!record.propertyType || !cleanText(record.propertyType)) texts.propertyType = "";
    texts.propertySubType = canonicalOption(texts.propertySubType, IRIS_PROPERTY_SUB_TYPES);
    texts.areaUnit = canonicalOption(texts.areaUnit, IRIS_PROPERTY_AREA_UNITS);
    texts.province = canonicalOption(texts.province, IRIS_PROPERTY_PROVINCES);
    const acquisitionDate = readText(record.acquisitionDate, 10, "Date of Acquisition");
    if (!acquisitionDate.ok) return { ok: false, error: (acquisitionDate as { error: string }).error };
    if (acquisitionDate.value && !isRealIsoDate(acquisitionDate.value))
      return { ok: false, error: "Date of Acquisition must be a real date as YYYY-MM-DD." };
    const landArea = readDecimal(record.landArea, "Land area");
    if (!landArea.ok) return { ok: false, error: (landArea as { error: string }).error };
    if (
      landArea.value !== undefined &&
      formatPropertyArea(landArea.value).length > IRIS_PROPERTY_LIMITS.landAreaText
    )
      return {
        ok: false,
        error: `Land area is longer than IRIS accepts (${IRIS_PROPERTY_LIMITS.landAreaText} characters).`,
      };
    const acquisitionCost = readAmount(record.acquisitionCost, "Acquisition cost/value");
    if (!acquisitionCost.ok) return { ok: false, error: (acquisitionCost as { error: string }).error };
    if (
      acquisitionCost.value !== undefined &&
      String(acquisitionCost.value).length > IRIS_PROPERTY_LIMITS.acquisitionCostText
    )
      return {
        ok: false,
        error: `Acquisition cost/value is longer than IRIS accepts (${IRIS_PROPERTY_LIMITS.acquisitionCostText} digits).`,
      };
    const amount = readAmount(record.value, "Balance Sheet value of a business property");
    if (!amount.ok) return { ok: false, error: (amount as { error: string }).error };
    if (
      !balanceRowLower &&
      !texts.propertyType &&
      !texts.propertySubType &&
      !acquisitionDate.value &&
      !texts.areaUnit &&
      landArea.value === undefined &&
      acquisitionCost.value === undefined &&
      !texts.province &&
      !texts.district &&
      !texts.city &&
      !texts.propertyNo &&
      !texts.sectorMohallaBlock &&
      amount.value === undefined
    )
      continue;
    const row: BusinessProperty = {
      balanceRow: (balanceRowLower || "") as BusinessProperty["balanceRow"],
      propertyType: texts.propertyType,
      propertySubType: texts.propertySubType,
      areaUnit: texts.areaUnit,
      province: texts.province,
      district: texts.district,
      city: texts.city,
      propertyNo: texts.propertyNo,
      sectorMohallaBlock: texts.sectorMohallaBlock,
    };
    if (acquisitionDate.value) row.acquisitionDate = acquisitionDate.value;
    if (landArea.value !== undefined) row.landArea = landArea.value;
    if (acquisitionCost.value !== undefined) row.acquisitionCost = acquisitionCost.value;
    if (amount.value !== undefined) row.value = amount.value;
    rows.push(row);
  }
  return { ok: true, rows };
}

/** Plain-language problems; empty means every account can be pushed. */
/** Plain words for the Business profit step (ASCII only). */
export const BUSINESS_BANK_TEXT = Object.freeze({
  choose:
    "Tick each of your bank accounts that belongs to the business. Its balance on 30 June comes from the bank statement of that account (Upload documents step); nothing is typed here.",
  balanceAfterStatement: "Balance on 30 June: shows after the statement of this account is mapped",
  noAccounts:
    "Your bank accounts show here once they are added on the Bank accounts step.",
  notYourAccount:
    "This IBAN is not one of the bank accounts of this filing. Remove it, or add the account on the Bank accounts step and upload its statement.",
});

/**
 * 16-Oct (document auto-fill, part 2): the 30 June balance of each business
 * bank account is the closing balance of that account's mapped 12-month bank
 * statement. Rows keep their IBAN; the balance is filled from the statement.
 */
export function fillBusinessBankBalancesFromStatements(
  rows: readonly BusinessBankAccount[],
  statements: readonly { iban: string; closingBalance: number }[],
): { rows: BusinessBankAccount[]; problems: string[] } {
  const problems: string[] = [];
  const filled = rows.map((row) => {
    const iban = normalizeIban(row.iban);
    const found = statements.filter((statement) => normalizeIban(statement.iban) === iban);
    if (found.length !== 1) {
      problems.push(
        found.length
          ? `Business bank account ${iban}: more than one bank statement has this IBAN; keep one account per IBAN.`
          : `Business bank account ${iban}: its balance on 30 June comes from the bank statement of that account. Add the account on the Bank accounts step and upload and map its 12-month statement.`,
      );
      return { iban };
    }
    return { iban, balance: Math.round(found[0].closingBalance) };
  });
  return { rows: filled, problems };
}

export function validateBusinessBankAccounts(
  rows: readonly BusinessBankAccount[],
  options: { balanceFromStatement?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const where = row.iban ? `Bank account ${row.iban}` : `Bank account ${index + 1}`;
    if (!row.iban) problems.push(`${where}: enter the IBAN.`);
    else if (!isValidPakistanIban(row.iban))
      problems.push(
        `${where}: this is not a valid Pakistani IBAN (PK + 2 digits + 4-letter bank code + 16 characters, with a correct check number). Copy it from the bank statement.`,
      );
    else if (seen.has(row.iban)) problems.push(`${where} is listed twice.`);
    if (row.iban) seen.add(row.iban);
    // On the Business profit step the balance is not typed: it comes from the
    // account's bank statement when the packet is built.
    if (options.balanceFromStatement) return;
    if (row.balance === undefined)
      problems.push(`${where}: enter the balance on 30 June (as in the Balance Sheet).`);
    else if (row.balance <= 0)
      problems.push(
        `${where}: the balance must be more than zero. Leave out accounts with no balance; an overdrawn account is a liability, not a bank asset.`,
      );
  });
  return problems;
}

export function validateBusinessVehicles(rows: readonly BusinessVehicle[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const where = row.registrationNo
      ? `Vehicle ${row.registrationNo}`
      : `Vehicle ${index + 1}`;
    if (!row.registrationNo) problems.push(`${where}: enter the registration number.`);
    else if (row.registrationNo.includes(" - "))
      problems.push(`${where}: write the registration number without " - " (for example LEA-1234).`);
    else {
      const key = row.registrationNo.toLowerCase();
      if (seen.has(key)) problems.push(`${where} is listed twice.`);
      seen.add(key);
    }
    if (!row.make) problems.push(`${where}: enter the make (for example Suzuki).`);
    if (!row.model) problems.push(`${where}: enter the model.`);
    if (row.value === undefined)
      problems.push(`${where}: enter its value in the Balance Sheet on 30 June.`);
    else if (row.value <= 0) problems.push(`${where}: the value must be more than zero.`);
  });
  return problems;
}

export function validateBusinessProperties(rows: readonly BusinessProperty[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const label = row.balanceRow
      ? propertyBalanceRowLabel(row.balanceRow)
      : "Business property";
    const where = row.propertyNo
      ? `${label} at ${row.propertyNo}${row.city ? `, ${row.city}` : ""}`
      : `${label} ${index + 1}`;
    if (!row.balanceRow)
      problems.push(`${where}: choose whether this property belongs to Land (Business) 3301 or Building (Business) 3302.`);
    if (!row.propertyType) problems.push(`${where}: choose the property type.`);
    else if (!(IRIS_PROPERTY_TYPES as readonly string[]).includes(row.propertyType))
      problems.push(
        `${where}: property type must be one of ${IRIS_PROPERTY_TYPES.join(", ")} (the choices IRIS offers).`,
      );
    if (!row.propertySubType) problems.push(`${where}: choose the property sub-type.`);
    if (row.acquisitionDate && !isRealIsoDate(row.acquisitionDate))
      problems.push(`${where}: enter the date of acquisition as a real date, or leave it blank.`);
    if (!row.areaUnit) problems.push(`${where}: choose the land area unit.`);
    else if (!(IRIS_PROPERTY_AREA_UNITS as readonly string[]).includes(row.areaUnit))
      problems.push(
        `${where}: land area unit must be one of ${IRIS_PROPERTY_AREA_UNITS.join(", ")} (the choices IRIS offers).`,
      );
    if (row.landArea === undefined) problems.push(`${where}: enter the land area.`);
    else if (row.landArea <= 0) problems.push(`${where}: the land area must be more than zero.`);
    else if (formatPropertyArea(row.landArea).length > IRIS_PROPERTY_LIMITS.landAreaText)
      problems.push(`${where}: the land area is longer than IRIS accepts (${IRIS_PROPERTY_LIMITS.landAreaText} characters).`);
    if (row.acquisitionCost !== undefined && row.acquisitionCost <= 0)
      problems.push(`${where}: the acquisition cost/value must be more than zero, or leave it blank.`);
    if (!row.province) problems.push(`${where}: choose the province / territory.`);
    else if (!(IRIS_PROPERTY_PROVINCES as readonly string[]).includes(row.province))
      problems.push(
        `${where}: province / territory must be one of ${IRIS_PROPERTY_PROVINCES.join(", ")} (the choices IRIS offers).`,
      );
    if (!row.district) problems.push(`${where}: enter the district exactly as IRIS lists it for the province.`);
    if (!row.city) problems.push(`${where}: enter the city exactly as IRIS lists it for the district.`);
    if (!row.propertyNo)
      problems.push(`${where}: enter the Property/ Plot/ House/ Shop No.`);
    if (!row.sectorMohallaBlock)
      problems.push(`${where}: enter the Sector / Mohalla / Block.`);
    if (row.value === undefined)
      problems.push(`${where}: enter its value in the Balance Sheet on 30 June.`);
    else if (row.value <= 0) problems.push(`${where}: the Balance Sheet value must be more than zero.`);
    if (
      row.balanceRow &&
      row.propertySubType &&
      row.landArea !== undefined &&
      row.areaUnit &&
      row.propertyNo &&
      row.sectorMohallaBlock &&
      row.city &&
      row.district &&
      row.province
    ) {
      const key = propertyRowText(row).toLowerCase();
      if (seen.has(key))
        problems.push(
          `${where}: another listed property would print the same IRIS row text, so the two cannot be told apart in FBR. Correct the duplicate detail.`,
        );
      seen.add(key);
    }
  });
  return problems;
}

/**
 * The lists must add up to the Balance Sheet's own figures, otherwise IRIS
 * would end with different totals than the accounts the taxpayer approved.
 */
export function compareWithBalanceSheet(input: {
  banks: readonly BusinessBankAccount[];
  vehicles: readonly BusinessVehicle[];
  properties?: readonly BusinessProperty[];
  sheetBank: number | null;
  sheetVehicle: number | null;
  sheetLand?: number | null;
  sheetBuilding?: number | null;
}): string[] {
  const problems: string[] = [];
  const bankTotal = input.banks.reduce((sum, row) => sum + (row.balance ?? 0), 0);
  const vehicleTotal = input.vehicles.reduce((sum, row) => sum + (row.value ?? 0), 0);
  if (input.banks.length) {
    if (input.sheetBank === null)
      problems.push(
        "Business bank accounts are listed, but the reviewed Balance Sheet has no bank figure. Map the bank line on the Balance Sheet first.",
      );
    else if (bankTotal !== input.sheetBank)
      problems.push(
        `Business bank accounts add up to Rs ${money(bankTotal)}, but the Balance Sheet bank figure is Rs ${money(input.sheetBank)}. Correct the balances so they match.`,
      );
  }
  if (input.vehicles.length) {
    if (input.sheetVehicle === null)
      problems.push(
        "Business vehicles are listed, but the reviewed Balance Sheet has no vehicle figure. Map the vehicle line on the Balance Sheet first.",
      );
    else if (vehicleTotal !== input.sheetVehicle)
      problems.push(
        `Business vehicles add up to Rs ${money(vehicleTotal)}, but the Balance Sheet vehicle figure is Rs ${money(input.sheetVehicle)}. Correct the values so they match.`,
      );
  }
  for (const balanceRow of ["land", "building"] as const) {
    const rows = (input.properties ?? []).filter((row) => row.balanceRow === balanceRow);
    if (!rows.length) continue;
    const total = rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
    const sheet = balanceRow === "land" ? input.sheetLand : input.sheetBuilding;
    const label = propertyBalanceRowLabel(balanceRow);
    if (sheet === null || sheet === undefined)
      problems.push(
        `Business properties are listed under ${label}, but the reviewed Balance Sheet has no ${balanceRow} figure. Map the ${balanceRow} line on the Balance Sheet first.`,
      );
    else if (total !== sheet)
      problems.push(
        `Business properties under ${label} add up to Rs ${money(total)}, but the Balance Sheet ${balanceRow} figure is Rs ${money(sheet)}. Correct the values so they match.`,
      );
  }
  return problems;
}

export const bankRowText = (iban: string) => `${IRIS_BANK_ROW_LABEL} - ${iban} -`;
export const vehicleRowText = (registrationNo: string) =>
  `${IRIS_VEHICLE_ROW_LABEL} - ${registrationNo} -`;

/**
 * Packet entries for complete, validated lists. Callers validate first; this
 * refuses (throws) rather than building a partial plan.
 */
export function buildBalanceDetailsPlan(
  banks: readonly BusinessBankAccount[],
  vehicles: readonly BusinessVehicle[],
  properties: readonly BusinessProperty[] = [],
): BalanceDetailsPlan {
  const problems = [
    ...validateBusinessBankAccounts(banks),
    ...validateBusinessVehicles(vehicles),
    ...validateBusinessProperties(properties),
  ];
  if (problems.length) throw new Error(problems.join(" "));
  const fields: PortalFieldMapEntry[] = [];
  const agentFields: BalanceDetailAgentField[] = [];
  const planBanks = banks.map((row) => ({ iban: row.iban, amount: row.balance as number }));
  const planVehicles = vehicles.map((row) => ({
    registrationNo: row.registrationNo,
    chassisNo: row.chassisNo ?? "",
    make: row.make,
    model: row.model,
    amount: row.value as number,
  }));
  const planProperties = properties.map((row) => ({
    balanceRow: row.balanceRow as BusinessPropertyBalanceRow,
    propertyType: row.propertyType,
    propertySubType: row.propertySubType,
    acquisitionDate: row.acquisitionDate ?? "",
    areaUnit: row.areaUnit,
    landArea: row.landArea as number,
    landAreaText: formatPropertyArea(row.landArea as number),
    acquisitionCost: row.acquisitionCost ?? null,
    province: row.province,
    district: row.district,
    city: row.city,
    propertyNo: row.propertyNo,
    sectorMohallaBlock: row.sectorMohallaBlock,
    amount: row.value as number,
  }));
  for (const row of planBanks) {
    const text = bankRowText(row.iban);
    fields.push({
      ourCategory: "BUSINESS_BALANCE_BANK_ACCOUNT",
      ourDescription: `Business bank account ${row.iban}`,
      ourAmount: row.amount,
      irisCode: IRIS_BANK_ROW,
      irisDescription: IRIS_BANK_ROW_LABEL,
      portalArea: "Business",
      section: "Balance Sheet",
      column: "Amount",
      isTaxField: false,
      sourceEntryCount: 1,
      rowDescriptionIncludes: text,
    });
    agentFields.push({
      key: `${IRIS_BANK_ROW}:businessFields:Amount:${text}`,
      kind: "bank",
      irisCode: IRIS_BANK_ROW,
      label: `${IRIS_BANK_ROW_LABEL} ${row.iban}`,
      column: "Amount",
      value: String(row.amount),
      rowDescriptionIncludes: text,
      iban: row.iban,
    });
  }
  for (const row of planVehicles) {
    const text = vehicleRowText(row.registrationNo);
    fields.push({
      ourCategory: "BUSINESS_BALANCE_VEHICLE",
      ourDescription: `Business vehicle ${row.registrationNo}`,
      ourAmount: row.amount,
      irisCode: IRIS_VEHICLE_ROW,
      irisDescription: IRIS_VEHICLE_ROW_LABEL,
      portalArea: "Business",
      section: "Balance Sheet",
      column: "Amount",
      isTaxField: false,
      sourceEntryCount: 1,
      rowDescriptionIncludes: text,
    });
    agentFields.push({
      key: `${IRIS_VEHICLE_ROW}:businessFields:Amount:${text}`,
      kind: "vehicle",
      irisCode: IRIS_VEHICLE_ROW,
      label: `${IRIS_VEHICLE_ROW_LABEL} ${row.registrationNo}`,
      column: "Amount",
      value: String(row.amount),
      rowDescriptionIncludes: text,
      registrationNo: row.registrationNo,
      chassisNo: row.chassisNo,
      make: row.make,
      model: row.model,
    });
  }
  for (const row of planProperties) {
    const text = propertyRowText(row);
    const code = propertyBalanceRowCode(row.balanceRow);
    const label = propertyBalanceRowLabel(row.balanceRow);
    fields.push({
      ourCategory: "BUSINESS_BALANCE_PROPERTY",
      ourDescription: `Business ${row.balanceRow} property ${row.propertySubType} at ${row.propertyNo}, ${row.city}`,
      ourAmount: row.amount,
      irisCode: code,
      irisDescription: label,
      portalArea: "Business",
      section: "Balance Sheet",
      column: "Amount",
      isTaxField: false,
      sourceEntryCount: 1,
      rowDescriptionIncludes: text,
    });
    agentFields.push({
      key: `${code}:businessFields:Amount:${text}`,
      kind: "property",
      irisCode: code,
      label: `${label} ${row.propertySubType} at ${row.propertyNo}, ${row.city}`,
      column: "Amount",
      value: String(row.amount),
      rowDescriptionIncludes: text,
      balanceRow: row.balanceRow,
      propertyType: row.propertyType,
      propertySubType: row.propertySubType,
      ...(row.acquisitionDate
        ? {
            acquisitionDate: row.acquisitionDate,
            acquisitionDateIris: irisPropertyDate(row.acquisitionDate),
          }
        : {}),
      areaUnit: row.areaUnit,
      landArea: row.landArea,
      landAreaText: row.landAreaText,
      ...(row.acquisitionCost !== null
        ? { acquisitionCost: row.acquisitionCost }
        : {}),
      province: row.province,
      district: row.district,
      city: row.city,
      propertyNo: row.propertyNo,
      sectorMohallaBlock: row.sectorMohallaBlock,
    });
  }
  return {
    version: planProperties.length ? "balance-details-v2" : "balance-details-v1",
    banks: planBanks,
    vehicles: planVehicles,
    properties: planProperties,
    fields,
    agentFields,
    totals: {
      bank: planBanks.reduce((sum, row) => sum + row.amount, 0),
      vehicle: planVehicles.reduce((sum, row) => sum + row.amount, 0),
      land: planProperties
        .filter((row) => row.balanceRow === "land")
        .reduce((sum, row) => sum + row.amount, 0),
      building: planProperties
        .filter((row) => row.balanceRow === "building")
        .reduce((sum, row) => sum + row.amount, 0),
    },
  };
}
