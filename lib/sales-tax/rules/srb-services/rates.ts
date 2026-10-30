/**
 * Rates of the Sindh Sales Tax on Services, by service code and date.
 *
 * Source: Sindh Sales Tax on Services Act 2011, consolidated text for
 * 2026-27 (SRB, uploaded 20 August 2026), Second Schedule, and the Sindh
 * Finance Act 2026 (Gazette of 1 July 2026). The rows in force before
 * 1 July 2026 are read from the footnotes of that consolidated text, which
 * quote each entry as it stood before the Finance Act 2026.
 *
 * The first supported tax period is July 2025: the Finance Act 2025 replaced
 * the Second Schedule on 1 July 2025 and the earlier schedule is not loaded.
 *
 * Rates are chosen from this table, never typed by hand. Which entry applies
 * depends on legal conditions (for example "paid by card or QR") that only
 * the taxpayer can judge, so the user picks the entry for every invoice line.
 */

import { applyRate, type Paisa } from "../../money";
import type { IsoDate } from "../../types";
import { cpcIsUnder, normalizeCpcCode } from "./cpc";

export type SrbRatePart = "standard" | "I" | "II";
export type SrbRateBasis = "percent" | "per_bill" | "per_person" | "property_developer";
/** Row of the return the output tax of the line is shown in. */
export type SrbOutputRow = "9a" | "9b";

export interface SrbRateOption {
  /** Stable key stored on every invoice line, for example "p2-16b". */
  id: string;
  part: SrbRatePart;
  /** Entry of the Second Schedule, for example "Part II, S.No 16". */
  reference: string;
  label: string;
  basis: SrbRateBasis;
  /** A fraction such as 0.15, for the percent basis. */
  rate?: number;
  /** Rupees per bill or per person. */
  rupeesPerUnit?: number;
  /** Property developers: rupees per square yard of land and per square foot covered. */
  developerRupees?: { perSquareYard: number; perSquareFoot: number };
  /** CPC codes the entry covers (at any level). Empty means every code. */
  covers: readonly string[];
  /** Codes inside `covers` that the entry does not apply to. */
  except: readonly string[];
  /** The condition the taxpayer must meet, in plain words. Null when there is none. */
  condition: string | null;
  /** True when the reduced rate needs an option e-filed (general condition 2 of Part II). */
  optionRequired: boolean;
  row: SrbOutputRow;
  effectiveFrom: IsoDate;
  /** Null while in force. */
  effectiveTo: IsoDate | null;
}

/** The first tax period the engine supports (Finance Act 2025 regime). */
export const SRB_FIRST_SUPPORTED_DATE: IsoDate = "2025-07-01";
const FA2026_START: IsoDate = "2026-07-01";
const FA2026_END_OLD: IsoDate = "2026-06-30";

type Draft = Omit<SrbRateOption, "id" | "part" | "reference" | "row" | "effectiveFrom" | "effectiveTo" | "except" | "optionRequired" | "condition"> & {
  sNo: string;
  except?: readonly string[];
  condition?: string | null;
  option?: boolean;
};

function part2(
  drafts: Draft[],
  era: { from: IsoDate; to: IsoDate | null },
): SrbRateOption[] {
  return drafts.map((draft) => ({
    id: `p2-${draft.sNo.toLowerCase()}`,
    part: "II" as const,
    reference: `Second Schedule, Part II, S.No ${draft.sNo}`,
    label: draft.label,
    basis: draft.basis,
    rate: draft.rate,
    rupeesPerUnit: draft.rupeesPerUnit,
    developerRupees: draft.developerRupees,
    covers: draft.covers,
    except: draft.except ?? [],
    condition: draft.condition ?? null,
    optionRequired: draft.option ?? false,
    row: "9b" as const,
    effectiveFrom: era.from,
    effectiveTo: era.to,
  }));
}

const pct = (sNo: string, label: string, rate: number, covers: string[], more: Partial<Draft> = {}): Draft => ({
  sNo, label, basis: "percent", rate, covers, ...more,
});

/** Entries that read the same before and after the Finance Act 2026. */
const COMMON: Draft[] = [
  pct("2", "Construction for government civil works, 5%", 0.05, ["54"], {
    condition: "Only construction for government civil works paid out of the budget of the Federal Government, a provincial or local government, or a cantonment board.",
  }),
  pct("3a", "Auctioneers and car or automobile dealers (wholesale on fee or contract), 8%", 0.08, ["612", "62"], {
    condition: "Only services of an auctioneer or a car or automobile dealer.",
  }),
  pct("3b", "Indenters earning foreign exchange (wholesale on fee or contract), 3%", 0.03, ["612", "62"], {
    condition: "Only an indenter working from a place of business in Sindh, paid from outside Pakistan in foreign exchange through banking channels into the business bank account.",
  }),
  pct("4", "Restaurants and beverage serving, 8%", 0.08, ["633", "634"], {
    condition: "Only when payment against the tax invoice is received by debit or credit card, mobile wallet or QR scanning.",
  }),
  pct("5", "Taxi services using cab aggregators, 5%", 0.05, ["64115"], {
    condition: "Only services of the owners or drivers of vehicles using cab aggregator services.",
  }),
  pct("6", "Rent-a-car, bus and coach charter, transport vehicles with operator, 8%", 0.08, ["64116", "64118", "660"], {
    condition: "Only services of rent-a-car and vehicle rental businesses.",
  }),
  pct("8", "Freight through truck adda, bus or wagon stand, 3%", 0.03, ["6511"], {
    condition: "Only services through truck addas or bus or wagon stands. It does not cover petroleum oils through oil tankers, automotive vehicles carried by specialised vehicle carriers, or goods carried by fleet logistic companies with at least 25 vehicles.",
  }),
  pct("9", "Pipeline transport, 8%", 0.08, ["6513"], { option: true }),
  pct("10", "Bus station services, 5%", 0.05, ["67410"]),
  pct("11", "Highway, bridge and travel operation, 5%", 0.05, ["6742"]),
  pct("12", "Parking and towing, 5%", 0.05, ["67430", "67440"]),
  {
    sNo: "13",
    label: "Freight transport agency, Rs 1,000 per bill",
    basis: "per_bill",
    rupeesPerUnit: 1000,
    covers: ["67910"],
    condition: "Only for each bill of lading, house bill of lading, airway bill or house airway bill issued.",
  },
  pct("14", "Motor vehicle third-party insurance, 5%", 0.05, ["71331"], {
    condition: "Only motor vehicle third-party insurance required under the Provincial Motor Vehicle Ordinance 1965.",
  }),
  pct("15", "Foreign exchange spread, 3%", 0.03, ["71592"], {
    condition: "Only the spread charges permitted by the State Bank on buying and selling foreign currency.",
  }),
  pct("17", "Rental or leasing of immovable property for business, 3%", 0.03, ["7211"], {
    condition: "Only renting, letting, leasing or licensing immovable property for use in the course or furtherance of business or commerce.",
  }),
  pct("18", "Real estate services on a fee or contract basis, 8%", 0.08, ["722"], { except: ["7224"] }),
  pct("19", "Licensing of intellectual property, trademarks and franchises, 8%", 0.08, ["733", "83960"], {
    except: ["7331", "7335"],
    option: true,
  }),
  pct("20", "Software licensing, IT services, hosting and online content, 3%", 0.03,
    ["7331", "83131", "83132", "8314", "8315", "8316", "843"], { except: ["83159"], option: true }),
  pct("21", "Research and development, 8%", 0.08, ["81"]),
  pct("23", "Supply chain and distribution of registered drugs, 5%", 0.05, ["83117"], {
    condition: "Only supply chain management and distribution services for drugs registered under the Drugs Act 1976.",
  }),
  pct("24", "Historical restoration architecture, 8%", 0.08, ["83214"]),
  pct("25", "Photography and photographic processing, 8%", 0.08, ["838"]),
  pct("26", "Fashion and specialty design, 5%", 0.05, ["83919", "83920"], {
    condition: "Only services of fashion designers.",
  }),
  pct("27", "Radio and television broadcast and programme production, 8%", 0.08,
    ["8461", "8462", "9612", "96139"]),
  pct("28a", "Broadcasting and programme distribution, 8%", 0.08, ["8463"], { except: ["84631"] }),
  pct("28b", "Stand-alone cable TV operators, 2%", 0.02, ["8463"], {
    condition: "Only a stand-alone cable TV operator: a person whose principal activity is cable TV operation and whose only other taxable activity is advertisement on the cable TV network.",
  }),
  pct("29", "Armoured car, guard and other security services, 8%", 0.08, ["85240", "85250", "85290"]),
  pct("30", "Cleaning services, 8%", 0.08, ["853"]),
  pct("31", "Travel arrangement and tour operators, 5%", 0.05, ["855"]),
  pct("32", "Call centres, 3%", 0.03, ["85931", "85991"], {
    condition: "Only services of call centres.",
    option: true,
  }),
  pct("33", "Other support services of auctioneers, 8%", 0.08, ["85999"], {
    condition: "Only services of an auctioneer.",
  }),
  pct("35", "Manufacturing services on physical inputs owned by others, 8%", 0.08, ["88"], {
    condition: "Only services to non-industrial consumers.",
  }),
  pct("36", "Publishing, printing and reproduction, 5%", 0.05, ["891"]),
  pct("37", "Moulding, pressing, casting and forging services, 8%", 0.08, ["892", "893"], {
    condition: "Only services to non-industrial consumers.",
  }),
  pct("39", "Human health services, 3%", 0.03, ["931"], {
    condition: "Only (1) doctors and consultants, other than cosmetic and plastic surgery, when the consultation fee exceeds Rs 3,000 per session or visit, and (2) hospital bed or room services when the daily charge, including all fixed charges, exceeds Rs 25,000 per bed or room.",
  }),
  pct("40", "Audio-visual and related services, 8%", 0.08, ["961"]),
  {
    sNo: "41",
    label: "Race club entry, Rs 200 per person",
    basis: "per_person",
    rupeesPerUnit: 200,
    covers: ["965"],
    condition: "Only entry to a race club to witness a race event.",
  },
  pct("42", "Sports and recreation, 8%", 0.08, ["965"]),
  pct("43", "Other amusement and recreation, 8%", 0.08, ["969"]),
  pct("44", "Washing, cleaning and dyeing, 5%", 0.05, ["971"]),
  pct("46", "Other miscellaneous services, 5%", 0.05, ["97990"]),
];

/** Entries as they read from 1 July 2026 (Finance Act 2026). */
const FROM_2026_07: Draft[] = [
  pct("1", "Ready-mix concrete, 8%", 0.08, ["54540"], { option: true }),
  pct("1a", "Dredging and rock and silt removal, 8%", 0.08, ["54232"]),
  {
    sNo: "1B",
    label: "Property developers and promoters, Rs 100 per sq yard of land plus Rs 50 per sq ft covered",
    basis: "property_developer",
    developerRupees: { perSquareYard: 100, perSquareFoot: 50 },
    covers: ["54"],
    condition: "Only services provided by property developers or promoters.",
  },
  pct("7", "Road freight, 8% (not petroleum oils through oil tankers)", 0.08, ["6511"], {
    condition: "Not for transportation of petroleum oils through oil tankers; those are at the standard rate.",
    option: true,
  }),
  pct("16a", "Insurance agents, 2%", 0.02, ["71610"], { condition: "Only services of insurance agents." }),
  pct("16b", "Insurance brokers, 3%", 0.03, ["71610"], { condition: "Only services of insurance brokers." }),
  pct("22", "Legal, tax consultancy and insolvency services, 8%", 0.08, ["821", "823", "824"]),
  pct("34", "Repair services of other goods, 8%", 0.08, ["872"]),
  pct("38a", "Education above Rs 500,000 fee per student per year, 3%", 0.03,
    ["921", "922", "923", "924", "925"], {
      condition: "Only when the fee for the services exceeds Rs 500,000 per student per year. Tax is charged on the fee above that amount.",
    }),
  pct("38b", "Other education and training services, 3%", 0.03, ["929"], { except: ["9292"] }),
  pct("38c", "Educational support services, 5%", 0.05, ["9292"]),
  pct("45", "Beauty and physical well-being services, 8%", 0.08, ["972"]),
];

/** Entries as they read from 1 July 2025 to 30 June 2026. */
const UP_TO_2026_06: Draft[] = [
  pct("1", "Construction services, 8%", 0.08, ["54"], { option: true }),
  pct("7", "Road freight, 8%", 0.08, ["6511"], { option: true }),
  pct("16", "Insurance brokerage and agency, 5%", 0.05, ["71610"]),
  pct("22", "Legal and accounting services, 8%", 0.08, ["82"]),
  pct("34", "Repair services (CPC 871 and 872), 8%", 0.08, ["871", "872"]),
  pct("38", "Education above Rs 500,000 fee per student per year, and training services, 3%", 0.03, ["92"], {
    condition: "Only (1) services where the fee exceeds Rs 500,000 per student per year, and (2) training services.",
  }),
  pct("45a", "Beauty and physical well-being services, 8%", 0.08, ["972"]),
  pct("45b", "Beauty and physical well-being services with POS integration, 5%", 0.05, ["972"], {
    condition: "Only when the person has integrated the POS with the SRB system for real-time reporting of each sale, and no service is given without an SRB invoice number printed with the SRB QR code.",
  }),
];

const PART_I: Array<{ code: string; label: string; sNo: number }> = [
  { sNo: 1, code: "83159", label: "Hosting and IT infrastructure (collocation), 19.5%" },
  { sNo: 2, code: "841", label: "Telephony and other telecommunications, 19.5%" },
  { sNo: 3, code: "842", label: "Internet telecommunications, 19.5%" },
  { sNo: 4, code: "85230", label: "Security systems and vehicle tracking, 19.5%" },
  { sNo: 5, code: "87340", label: "Installation of radio, TV and communications equipment by telephony, internet and security providers, 19.5%" },
];

/** Codes the standard rate does not apply to, because Part I sets a higher rate. */
export const SRB_PART_I_CODES: readonly string[] = PART_I.map((entry) => entry.code);

function standardOption(): SrbRateOption {
  return {
    id: "standard",
    part: "standard",
    reference: "Section 8(1)",
    label: "Standard rate, 15%",
    basis: "percent",
    rate: 0.15,
    covers: [],
    except: SRB_PART_I_CODES,
    condition: null,
    optionRequired: false,
    row: "9a",
    effectiveFrom: SRB_FIRST_SUPPORTED_DATE,
    effectiveTo: null,
  };
}

function partOneOptions(): SrbRateOption[] {
  return PART_I.map((entry) => ({
    id: `p1-${entry.sNo}`,
    part: "I" as const,
    reference: `Second Schedule, Part I, S.No ${entry.sNo}`,
    label: entry.label,
    basis: "percent" as const,
    rate: 0.195,
    covers: [entry.code],
    except: [],
    condition: null,
    optionRequired: false,
    row: "9a" as const,
    effectiveFrom: SRB_FIRST_SUPPORTED_DATE,
    effectiveTo: null,
  }));
}

export const SRB_RATE_OPTIONS: SrbRateOption[] = [
  standardOption(),
  ...partOneOptions(),
  ...part2(COMMON, { from: SRB_FIRST_SUPPORTED_DATE, to: null }),
  ...part2(UP_TO_2026_06, { from: SRB_FIRST_SUPPORTED_DATE, to: FA2026_END_OLD }),
  ...part2(FROM_2026_07, { from: FA2026_START, to: null }),
];

function inForce(option: SrbRateOption, asOf: IsoDate): boolean {
  return (
    option.effectiveFrom <= asOf &&
    (option.effectiveTo === null || option.effectiveTo >= asOf)
  );
}

function covers(option: SrbRateOption, cpc: string): boolean {
  const code = normalizeCpcCode(cpc);
  if (option.except.some((excluded) => cpcIsUnder(code, excluded))) return false;
  if (option.covers.length === 0) return true;
  // A code written at a higher level than the entry (for example "54" for
  // entry 54540) also reaches into it, so match in both directions.
  return option.covers.some(
    (entry) => cpcIsUnder(code, entry) || cpcIsUnder(entry, code),
  );
}

/** Every rate option in force on the day. */
export function rateOptionsInForce(
  asOf: IsoDate,
  options: SrbRateOption[] = SRB_RATE_OPTIONS,
): SrbRateOption[] {
  return options.filter((option) => inForce(option, asOf));
}

/**
 * The rate options a taxpayer can choose for a service code on a day: the
 * standard rate (unless Part I sets a higher rate for the code), the Part I
 * rate, and every Part II entry that covers the code. For a code written at
 * a higher level than an entry (for example a whole division), entries below
 * it are offered too, so the user is never left without the entry they need.
 */
export function rateOptionsForCpc(
  cpc: string,
  asOf: IsoDate,
  options: SrbRateOption[] = SRB_RATE_OPTIONS,
): SrbRateOption[] {
  return rateOptionsInForce(asOf, options).filter((option) => covers(option, cpc));
}

export function findRateOption(
  id: string,
  asOf: IsoDate,
  options: SrbRateOption[] = SRB_RATE_OPTIONS,
): SrbRateOption | null {
  const found = rateOptionsInForce(asOf, options).filter((option) => option.id === id);
  if (found.length > 1) {
    throw new Error(`Rate option ${id} has overlapping rows on ${asOf}.`);
  }
  return found[0] ?? null;
}

export interface LineQuantities {
  /** Bills (per_bill) or persons (per_person). */
  units?: number;
  /** Property developers: square yards of land. */
  squareYards?: number;
  /** Property developers: square feet of constructed covered area. */
  squareFeet?: number;
}

/**
 * The tax the option gives for a line, in paisa. Returns null when the line
 * lacks what the option needs (for example the number of bills).
 */
export function expectedTax(
  option: SrbRateOption,
  value: Paisa,
  quantities: LineQuantities = {},
): Paisa | null {
  const whole = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (option.basis === "percent") {
    return applyRate(value, option.rate ?? 0);
  }
  if (option.basis === "per_bill" || option.basis === "per_person") {
    if (!whole(quantities.units)) return null;
    return Math.round((quantities.units as number) * (option.rupeesPerUnit ?? 0) * 100);
  }
  if (!whole(quantities.squareYards) || !whole(quantities.squareFeet)) return null;
  const rupees = option.developerRupees;
  if (!rupees) return null;
  return Math.round(
    ((quantities.squareYards as number) * rupees.perSquareYard +
      (quantities.squareFeet as number) * rupees.perSquareFoot) * 100,
  );
}
