import { buildReviewedBusinessSchedules } from "./business-schedule-fields";
import type { Prisma } from "@prisma/client";
import contract from "@/electron-connect/iris-business-contract.json";
import { computeBusinessProfit } from "./business-profit";
import {
  buildDepreciationAgentFields,
  buildDepreciationExpectations,
  depreciationScheduleToEngineInput,
  sanitizeDepreciationSchedule,
  validateDepreciationSchedule,
} from "./business-depreciation-schedule";
import { buildExpectedIrisTotals } from "./business-iris-expectations";
import {
  DEFAULT_MINIMUM_TAX_CATEGORY,
  SECTION_113_TEXT,
  getMinimumTaxCategory,
  isMinimumTaxCategoryId,
  section113Applicability,
} from "./minimum-tax-113";
import {
  IRIS_BANK_ROW,
  IRIS_BUILDING_ROW,
  IRIS_LAND_ROW,
  IRIS_VEHICLE_ROW,
  buildBalanceDetailsPlan,
  compareWithBalanceSheet,
  fillBusinessBankBalancesFromStatements,
  sanitizeBusinessBankAccounts,
  sanitizeBusinessProperties,
  sanitizeBusinessVehicles,
  validateBusinessBankAccounts,
  validateBusinessProperties,
  validateBusinessVehicles,
  type BalanceDetailsPlan,
} from "./business-balance-details";
import {
  buildBusinessDetailsPlan,
  sanitizeBusinessIdentity,
  validateBusinessIdentity,
} from "./business-identity";
import {
  buildTaxDeductionsPlan,
  compareWithWithholdingTotal,
  sanitizeBusinessTaxDeductions,
  validateBusinessTaxDeductions,
} from "./business-tax-deductions";
import {
  buildAddBacksPlan,
  compareWithInadmissibleTotal,
  sanitizeBusinessAddBacks,
  validateBusinessAddBacks,
} from "./business-addbacks";
import {
  ASSET_SALE_TEXT,
  BOOK_GAIN_ON_ASSETS_ROW,
  TAX_GAIN_ON_ASSETS_ROW,
  TAX_LOSS_ON_ASSETS_ROW,
  readAssetSaleAnswers,
  validateAssetSaleAnswers,
} from "./business-asset-sales";
import {
  compareWithLossTotal,
  lossRowCode,
  sanitizeBusinessLossesByYear,
  unabsorbedAmbiguousMessage,
  validateBusinessLossesByYear,
} from "./business-loss-rules";
import { isSingleFreelancerServicesFiling } from "./business-bank-categories";
import type { PortalFieldMapEntry } from "./portal-field-map";
import type { Ty2026SelectionUserDetails } from "./rules/ty2026/subcategories";

export const BUSINESS_BALANCE_SHEET_TYPE = "business_balance_sheet";
export const BUSINESS_BALANCE_LABELS = {
  businessName: "Business Name",
  taxYear: "Tax Year",
  closingDate: "Balance Sheet Date",
  currency: "Currency",
  totalAssets: "Total Assets",
  totalEquityLiabilities: "Total Equity and Liabilities",
  plant: "Plant / Machinery / Equipment / Furniture",
  stock: "Stocks / Stores / Spares",
  advances: "Advances / Deposits / Prepayments",
  cash: "Business Cash in Hand",
  securities: "Bonds / Securities",
  otherAssets: "Other Business Assets",
  capital: "Owner Capital",
  loans: "Long Term Borrowings / Debt / Loan",
  payables: "Trade Creditors / Payables",
  otherLiabilities: "Other Business Liabilities",
  land: "Business Land",
  building: "Business Building",
  bank: "Business Bank Balance",
  vehicle: "Business Motor Vehicles",
} as const;
const scalarCodes = {
  plant: "3303",
  stock: "3315",
  advances: "3312",
  cash: "3319",
  securities: "3321",
  otherAssets: "3348",
  capital: "3352",
  loans: "3371",
  payables: "3384",
  otherLiabilities: "3398",
} as const;
const assetKeys = [
  "plant",
  "stock",
  "advances",
  "cash",
  "securities",
  "otherAssets",
  "land",
  "building",
  "bank",
  "vehicle",
] as const;
const liabilityKeys = [
  "capital",
  "loans",
  "payables",
  "otherLiabilities",
] as const;
const norm = (v: unknown) =>
  String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
export type BusinessField = {
  label?: unknown;
  value?: unknown;
  confidence?: unknown;
};
function payload(raw: unknown): { fields: BusinessField[] } {
  const p = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (
    !p ||
    typeof p !== "object" ||
    !Array.isArray((p as { fields?: unknown }).fields)
  )
    throw new Error("Business Balance Sheet has no reviewed fields.");
  return p as { fields: BusinessField[] };
}
function get(fields: BusinessField[], label: string): unknown {
  const matches = fields.filter((f) => norm(f.label) === norm(label));
  if (matches.length > 1)
    throw new Error(`Duplicate Balance Sheet field: ${label}.`);
  return matches[0]?.value;
}
function amount(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n =
    typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  if (!Number.isFinite(n) || n < 0)
    throw new Error(
      "Balance Sheet amounts must be non-negative numbers; missing amounts must stay blank.",
    );
  return Math.round(n * 100) / 100;
}
export function ensureBusinessBalanceReviewFields(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const p = raw as Record<string, unknown>;
  const fields: BusinessField[] = Array.isArray(p.fields)
    ? p.fields.filter((f) => f && typeof f === "object")
    : [];
  for (const label of Object.values(BUSINESS_BALANCE_LABELS)) {
    if (!fields.some((f) => norm(f.label) === norm(label)))
      fields.push({ label, value: null, confidence: 0 });
  }
  return { ...p, fields };
}
export function readBusinessBalanceSheet(raw: unknown, taxYear: number) {
  const { fields } = payload(raw);
  const name = String(
    get(fields, BUSINESS_BALANCE_LABELS.businessName) ?? "",
  ).trim();
  const year = Number(get(fields, BUSINESS_BALANCE_LABELS.taxYear));
  const date = String(
    get(fields, BUSINESS_BALANCE_LABELS.closingDate) ?? "",
  ).trim();
  const currency = String(get(fields, BUSINESS_BALANCE_LABELS.currency) ?? "")
    .trim()
    .toUpperCase();
  if (!name) throw new Error("Enter the Business Name on the Balance Sheet.");
  if (year !== taxYear || date !== `${taxYear}-06-30`)
    throw new Error(
      `Balance Sheet must be for TY${taxYear}, closing ${taxYear}-06-30 (normal full-year individual return).`,
    );
  if (currency !== "PKR")
    throw new Error(
      "Only a PKR Business Balance Sheet is supported; do not silently convert currencies.",
    );
  const amounts: Record<string, number | null> = {};
  for (const [key, label] of Object.entries(BUSINESS_BALANCE_LABELS)) {
    if (!["businessName", "taxYear", "closingDate", "currency"].includes(key))
      amounts[key] = amount(get(fields, label));
  }
  const assets = amounts.totalAssets,
    liabilities = amounts.totalEquityLiabilities;
  if (
    assets === null ||
    liabilities === null ||
    Math.abs(assets - liabilities) > 0.01
  )
    throw new Error(
      "Enter matching Total Assets and Total Equity and Liabilities; no automatic balancing amount is created.",
    );
  const knownAssetTotal = assetKeys.reduce((s, k) => s + (amounts[k] ?? 0), 0);
  const knownLiabilityTotal = liabilityKeys.reduce(
    (s, k) => s + (amounts[k] ?? 0),
    0,
  );
  if (
    knownAssetTotal > assets + 0.01 ||
    knownLiabilityTotal > liabilities + 0.01
  )
    throw new Error(
      "Balance Sheet detail exceeds the declared total; review classifications and duplicates.",
    );
  const gaps: string[] = [];
  if (assetKeys.some((k) => amounts[k] === null))
    gaps.push(
      "Missing asset breakdown: blanks are not treated as confirmed zero.",
    );
  if (liabilityKeys.some((k) => amounts[k] === null))
    gaps.push(
      "Missing capital/liability breakdown: blanks are not treated as confirmed zero.",
    );
  if (Math.abs(knownAssetTotal - assets) > 0.01)
    gaps.push("Asset breakdown does not yet reconcile to Total Assets.");
  if (Math.abs(knownLiabilityTotal - liabilities) > 0.01)
    gaps.push(
      "Capital/liability breakdown does not yet reconcile to its total.",
    );
  return {
    version: "1.0",
    businessName: name,
    taxYear: year,
    closingDate: date,
    currency,
    amounts,
    gaps,
  };
}
export type BusinessPacket = ReturnType<typeof buildBusinessPacket>;
export function buildBusinessPacket(input: {
  taxYear: number;
  filerType: string | null;
  incomeSources: string[];
  selections: { source: string; subcategory: string; detailsJson: string }[];
  books?: {
    id: string;
    extractedData: string | null;
    extractionStatus: string;
  }[];
  balanceSheet?: {
    id: string;
    extractedData: string | null;
    extractionStatus: string;
  } | null;
  /**
   * 16-Oct: closing balance (30 June) of each mapped bank statement, by IBAN.
   * When given, every business bank account takes its balance from here
   * (app/actions/packet.ts passes the reconciliation's account balances).
   */
  bankStatementBalances?: readonly { iban: string; closingBalance: number }[];
}) {
  if (!input.incomeSources.includes("business")) return null;
  if (input.taxYear !== 2026 || input.filerType !== "myself")
    throw new Error(
      "Verified business entry currently supports Myself / TY2026 only.",
    );
  const selections = input.selections.filter(
    (s) => s.source === "business" && s.subcategory === "profit-return",
  );
  if (selections.length !== 1)
    throw new Error(
      "Business packet needs exactly one approved Business Profit selection.",
    );
  const parsed = JSON.parse(selections[0].detailsJson);
  const raw = parsed?.userDetails;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(
      "Business Profit details are missing; regenerate the packet after reviewing the business form.",
    );
  const keys = [
    "businessGrossSales",
    "businessOtherRevenue",
    "businessCostOfSales",
    "businessOperatingExpenses",
    "businessDepreciation",
    "businessInadmissibleExpenses",
    "businessLossBroughtForward",
    "businessWithholdingDeducted",
  ];
  const approvedInputs: Record<string, number | null> = {};
  for (const key of keys) approvedInputs[key] = amount(raw[key]);
  if (
    approvedInputs.businessGrossSales === null ||
    approvedInputs.businessGrossSales <= 0
  )
    throw new Error(
      "A reviewed positive annual Sales amount is required for the current business estimate.",
    );
  const excludesSalesTaxes = raw.businessSalesExcludeIndirectTax === true;
  // DP-1: the asset schedule (IRIS Depreciation tab). A schedule that breaks
  // an IRIS/law rule stops packet generation instead of being half-typed.
  const scheduleCheck = sanitizeDepreciationSchedule(
    (raw as Record<string, unknown>).businessDepreciationSchedule,
  );
  if (!scheduleCheck.ok)
    throw new Error(`Asset schedule: ${(scheduleCheck as { error: string }).error}`);
  const scheduleRows = scheduleCheck.rows;
  const scheduleProblems = validateDepreciationSchedule(scheduleRows);
  if (scheduleProblems.length)
    throw new Error(`Asset schedule: ${scheduleProblems.join(" ")}`);
  // DP-2: own PKR business bank accounts (Balance Sheet 3320) and vehicles
  // (3304). An incomplete or invalid list stops packet generation; it is
  // never half-typed.
  const bankCheck = sanitizeBusinessBankAccounts(
    (raw as Record<string, unknown>).businessBankAccounts,
  );
  if (!bankCheck.ok)
    throw new Error(`Business bank accounts: ${(bankCheck as { error: string }).error}`);
  if (input.bankStatementBalances) {
    // 16-Oct: the balance on 30 June comes from the account's bank statement,
    // never from a typed figure.
    const fromStatements = fillBusinessBankBalancesFromStatements(
      bankCheck.rows,
      input.bankStatementBalances,
    );
    if (fromStatements.problems.length) throw new Error(fromStatements.problems.join(" "));
    bankCheck.rows = fromStatements.rows;
  }
  const vehicleCheck = sanitizeBusinessVehicles(
    (raw as Record<string, unknown>).businessVehicles,
  );
  if (!vehicleCheck.ok)
    throw new Error(`Business vehicles: ${(vehicleCheck as { error: string }).error}`);
  const propertyCheck = sanitizeBusinessProperties(
    (raw as Record<string, unknown>).businessProperties,
  );
  if (!propertyCheck.ok)
    throw new Error(`Business properties: ${(propertyCheck as { error: string }).error}`);
  const listProblems = [
    ...validateBusinessBankAccounts(bankCheck.rows),
    ...validateBusinessVehicles(vehicleCheck.rows),
    ...validateBusinessProperties(propertyCheck.rows),
  ];
  if (listProblems.length) throw new Error(listProblems.join(" "));
  let balanceDetails: BalanceDetailsPlan | null = null;
  // DP-2: the IRIS "Business Details" tab (name, activity, brand, dates).
  const identityCheck = sanitizeBusinessIdentity(
    (raw as Record<string, unknown>).businessIdentity,
  );
  if (!identityCheck.ok)
    throw new Error((identityCheck as { error: string }).error);
  if (identityCheck.identity) {
    const identityProblems = validateBusinessIdentity(identityCheck.identity);
    if (identityProblems.length) throw new Error(identityProblems.join(" "));
  }
  const businessDetails = identityCheck.identity
    ? buildBusinessDetailsPlan(identityCheck.identity)
    : null;
  // DP-3: tax deducted from business receipts, by IRIS section (business
  // "Tax Deduction" tab). An invalid list, or one that adds up to more than
  // the reviewed total, stops packet generation; it is never half-typed.
  const deductionCheck = sanitizeBusinessTaxDeductions(
    (raw as Record<string, unknown>).businessTaxDeductions,
  );
  if (!deductionCheck.ok)
    throw new Error(`Tax deducted by section: ${(deductionCheck as { error: string }).error}`);
  const deductionProblems = validateBusinessTaxDeductions(deductionCheck.rows);
  if (deductionProblems.length)
    throw new Error(`Tax deducted by section: ${deductionProblems.join(" ")}`);
  const deductionTotals = compareWithWithholdingTotal(
    deductionCheck.rows,
    approvedInputs.businessWithholdingDeducted,
  );
  if (deductionTotals.problems.length)
    throw new Error(deductionTotals.problems.join(" "));
  const taxDeductions = deductionCheck.rows.length
    ? buildTaxDeductionsPlan(deductionCheck.rows)
    : null;
  // DP-4: "Expenses that are not allowed" by IRIS reason (business tab
  // "Inadmissible/Admissible Deductions"). Same rule: an invalid list, or one
  // that adds up to more than the reviewed total, stops packet generation.
  const addBackCheck = sanitizeBusinessAddBacks(
    (raw as Record<string, unknown>).businessAddBacks,
  );
  if (!addBackCheck.ok)
    throw new Error(
      `Expenses that are not allowed, by reason: ${(addBackCheck as { error: string }).error}`,
    );
  const addBackProblems = validateBusinessAddBacks(addBackCheck.rows);
  if (addBackProblems.length)
    throw new Error(`Expenses that are not allowed, by reason: ${addBackProblems.join(" ")}`);
  const addBackTotals = compareWithInadmissibleTotal(
    addBackCheck.rows,
    approvedInputs.businessInadmissibleExpenses,
  );
  if (addBackTotals.problems.length)
    throw new Error(addBackTotals.problems.join(" "));
  const addBacks = addBackCheck.rows.length
    ? buildAddBacksPlan(addBackCheck.rows)
    : null;
  // DP-4 item 3: business loss brought forward by tax year (IRIS Adjustments
  // 327021-327025). Same rule: invalid or above the reviewed total = stop.
  const lossCheck = sanitizeBusinessLossesByYear(
    (raw as Record<string, unknown>).businessLossesByYear,
  );
  if (!lossCheck.ok)
    throw new Error(`Business losses by year: ${(lossCheck as { error: string }).error}`);
  const lossProblems = validateBusinessLossesByYear(lossCheck.rows, input.taxYear);
  if (lossProblems.length)
    throw new Error(`Business losses by year: ${lossProblems.join(" ")}`);
  const lossTotals = compareWithLossTotal(
    lossCheck.rows,
    approvedInputs.businessLossBroughtForward,
  );
  if (lossTotals.problems.length) throw new Error(lossTotals.problems.join(" "));
  const lossesByYear = [...lossCheck.rows]
    .sort((a, b) => a.year - b.year)
    .map((row) => ({ year: row.year, amount: row.amount as number, code: lossRowCode(row.year) }));
  const fields: PortalFieldMapEntry[] = [];
  const pending: { key: string; amount: number | null; reason: string }[] = [];
  const queue = (
    code: string,
    value: number,
    sectionId: keyof typeof contract,
    source: string,
  ) => {
    const spec = contract[sectionId];
    const row = (
      spec.rows as Record<string, { label: string; disabled: boolean[] }>
    )[code];
    if (!row || row.disabled[0])
      throw new Error(
        `Business code ${code} has no proven first editable column.`,
      );
    fields.push({
      ourCategory: source,
      ourDescription: source,
      ourAmount: value,
      irisCode: code,
      irisDescription: row.label,
      portalArea: "Business",
      section: spec.tab,
      column:
        sectionId === "business_balance_sheet" ? "Amount" : "Total Amount",
      isTaxField: false,
      sourceEntryCount: 1,
    });
  };
  if (excludesSalesTaxes)
    queue(
      "3009",
      approvedInputs.businessGrossSales,
      "business_trading",
      "BUSINESS_GROSS_SALES",
    );
  else
    pending.push({
      key: "businessGrossSales",
      amount: approvedInputs.businessGrossSales,
      reason:
        "Confirm on Business Profit that sales exclude Sales Tax/FED before queuing IRIS 3009.",
    });
  const reasons: Record<string, string> = {
    businessOtherRevenue:
      "Other revenue needs its source breakdown; do not guess the aggregate into Others (3128).",
    businessCostOfSales:
      "Cost of sales is a computed total (3030); opening stock, purchases, direct costs and closing stock are required.",
    businessOperatingExpenses:
      "Admin expenses need head-wise breakdown; the total (3199) is computed.",
    businessDepreciation:
      "Book depreciation is added back (IRIS 3238). Tax depreciation / initial allowance (3248, Depreciation tab) needs the asset list; the estimate deducts nothing for it until then and no 3248 figure is assumed.",
    businessInadmissibleExpenses:
      "Add-backs require their specific reason/line; no guessed Other deduction.",
    businessLossBroughtForward:
      "Prior losses require origin-year/eligibility details.",
    businessWithholdingDeducted:
      "Business tax deducted needs section/regime/detail evidence, not a universal credit.",
  };
  for (const [key, reason] of Object.entries(reasons)) {
    if (approvedInputs[key] === null || approvedInputs[key]! > 0)
      pending.push({
        key,
        amount: approvedInputs[key],
        reason:
          approvedInputs[key] === null
            ? `Not provided (not confirmed zero). ${reason}`
            : reason,
      });
  }
  // DP-3: the agent types every listed section on the IRIS business Tax
  // Deduction tab. Only an unlisted remainder (final-tax or special sections)
  // stays manual.
  if (taxDeductions) {
    const index = pending.findIndex((item) => item.key === "businessWithholdingDeducted");
    if (index >= 0) {
      if (deductionTotals.remainder === 0) pending.splice(index, 1);
      else
        pending[index] = {
          key: "businessWithholdingDeducted",
          amount: deductionTotals.remainder,
          reason:
            "This part of the tax deducted is not listed by section (for example a final-tax or special section the agent does not type yet). Enter it in FBR under Business > Tax Deduction yourself.",
        };
    }
    // Client decision (19-Oct-2026): listed minimum-tax sections are typed
    // and read back by the agent, so their total is not a separate manual
    // item and must not block packet generation with a check-only warning.
  }
  // DP-4 item 3: the agent types each listed loss year in its own Adjustments
  // row (typed live for 327025 on 15-Oct-2026). Only an unlisted remainder
  // stays manual.
  if (lossesByYear.length) {
    for (const loss of lossesByYear)
      queue(loss.code, loss.amount, "business_adjustments", `BUSINESS_LOSS_BROUGHT_FORWARD_${loss.year}`);
    const index = pending.findIndex((item) => item.key === "businessLossBroughtForward");
    if (index >= 0) {
      if (lossTotals.remainder === 0) pending.splice(index, 1);
      else
        pending[index] = {
          key: "businessLossBroughtForward",
          amount: lossTotals.remainder,
          reason:
            "This part of the business loss brought forward is not listed by tax year. List it on Business profit, or enter it in FBR under Business > Adjustments in the row of its year yourself.",
        };
    }
  }
  // DP-4: the agent adds each listed reason with "+ Inadmissible" and types
  // its Total Amount (the flow proven live for 3212). Only an unlisted
  // remainder stays manual.
  if (addBacks) {
    for (const entry of addBacks.entries)
      queue(entry.code, entry.amount, "business_deductions", `BUSINESS_ADD_BACK_${entry.code}`);
    const index = pending.findIndex((item) => item.key === "businessInadmissibleExpenses");
    if (index >= 0) {
      if (addBackTotals.remainder === 0) pending.splice(index, 1);
      else
        pending[index] = {
          key: "businessInadmissibleExpenses",
          amount: addBackTotals.remainder,
          reason:
            "This part of the expenses that are not allowed is not listed by reason. List it on Business profit, or enter it in FBR under Business > Inadmissible/Admissible Deductions yourself.",
        };
    }
  }
  let balanceSheet: ReturnType<typeof readBusinessBalanceSheet> | null = null;
  if (input.balanceSheet) {
    if (input.balanceSheet.extractionStatus !== "MAPPED")
      throw new Error(
        "Review and map the uploaded Business Balance Sheet before generating a new packet.",
      );
    balanceSheet = readBusinessBalanceSheet(
      input.balanceSheet.extractedData,
      input.taxYear,
    );
    for (const [key, code] of Object.entries(scalarCodes)) {
      const value = balanceSheet.amounts[key];
      // Every row is required on review, with 0 where the business has none
      // (lib/tax/document-review-required.ts). A 0 is not typed: an untouched
      // IRIS Balance Sheet row is empty and IRIS counts it as 0 in 3349/3399
      // (live census 15-Oct), while how IRIS shows a typed 0 after a tab
      // switch is not proven, so typing it could stop the after-tab check.
      if (value !== null && value !== 0)
        queue(
          code,
          value,
          "business_balance_sheet",
          `BUSINESS_BALANCE_${key.toUpperCase()}`,
        );
    }
    // DP-2: the bank / vehicle lists must add up to the Balance Sheet's own
    // figures; then the agent creates one IRIS child row per item.
    const detailProblems = compareWithBalanceSheet({
      banks: bankCheck.rows,
      vehicles: vehicleCheck.rows,
      properties: propertyCheck.rows,
      sheetBank: balanceSheet.amounts.bank,
      sheetVehicle: balanceSheet.amounts.vehicle,
      sheetLand: balanceSheet.amounts.land,
      sheetBuilding: balanceSheet.amounts.building,
    });
    if (detailProblems.length) throw new Error(detailProblems.join(" "));
    if (bankCheck.rows.length || vehicleCheck.rows.length || propertyCheck.rows.length)
      balanceDetails = buildBalanceDetailsPlan(
        bankCheck.rows,
        vehicleCheck.rows,
        propertyCheck.rows,
      );
    for (const key of ["land", "building", "bank", "vehicle"]) {
      if (key === "bank" && bankCheck.rows.length) continue;
      if (key === "vehicle" && vehicleCheck.rows.length) continue;
      if (
        (key === "land" || key === "building") &&
        propertyCheck.rows.some((row) => row.balanceRow === key)
      )
        continue;
      if (balanceSheet.amounts[key] === null || balanceSheet.amounts[key]! > 0)
        pending.push({
          key: `balanceSheet.${key}`,
          amount: balanceSheet.amounts[key],
          reason:
            key === "land" || key === "building"
              ? `List each ${key} property with its IRIS Property Information detail (type, sub-type, area, province, district, city and address) on Business profit; the Balance Sheet total alone cannot be typed into the disabled ${key === "land" ? "3301" : "3302"} row.`
              : "Needs verified business asset/account detail flow; not routed to personal Wealth Statement.",
        });
    }
    for (const reason of balanceSheet.gaps)
      pending.push({ key: "balanceSheet.breakdown", amount: null, reason });
  } else {
    pending.push({
      key: "balanceSheet",
      amount: null,
      reason:
        "Business Balance Sheet not supplied; remaining asset/capital/liability review is manual.",
    });
    if (bankCheck.rows.length || vehicleCheck.rows.length || propertyCheck.rows.length)
      pending.push({
        key: "balanceSheetDetails",
        amount: null,
        reason:
          "Business bank accounts / vehicles / properties are listed, but they are typed into IRIS only together with a reviewed, mapped Business Balance Sheet (their totals must match it).",
      });
  }
  if ((input.books?.length ?? 0) > 1)
    throw new Error(
      "Keep one current approved Business Books document; duplicate schedules cannot be summed.",
    );
  const schedules = input.books?.[0]
    ? buildReviewedBusinessSchedules({
        taxYear: input.taxYear,
        approvedInputs,
        salesExcludeIndirectTax: excludesSalesTaxes,
        document: input.books[0],
        // DP-4: with a reasons list, the list types 3212; the Books only confirm it.
        addBacksListed: addBacks
          ? { personal: addBacks.entries.find((entry) => entry.code === "3212")?.amount ?? 0 }
          : undefined,
        // DP-4 item 3: with losses by year, the list types 327021-327025.
        lossesListed: lossesByYear.length
          ? { byYear: Object.fromEntries(lossesByYear.map((loss) => [loss.year, loss.amount])) }
          : undefined,
      })
    : null;
  if (schedules) {
    if (
      balanceSheet &&
      norm(balanceSheet.businessName) !== norm(schedules.businessName)
    )
      throw new Error(
        "Business Books and Balance Sheet have different business names; review identity before forwarding.",
      );
    fields.push(...schedules.fields);
    for (const key of schedules.completed) {
      const index = pending.findIndex((item) => item.key === key);
      if (index >= 0) pending.splice(index, 1);
    }
    if (schedules.fields.some((field) => field.irisCode === "3088")) {
      const depreciation = pending.find(
        (item) => item.key === "businessDepreciation",
      );
      if (depreciation)
        depreciation.reason =
          "Accounting depreciation is queued in 3088. Tax depreciation / initial allowance in computed 3248 still needs a verified asset schedule; it is not auto-copied from book depreciation.";
    }
    for (const reason of schedules.notes)
      pending.push({ key: "businessScheduleReview", amount: null, reason });
  }
  // DP-1: the agent types the asset schedule on the IRIS Depreciation tab.
  let depreciation: {
    version: "depreciation-v1";
    schedule: typeof scheduleRows;
    fields: ReturnType<typeof buildDepreciationAgentFields>;
    expectations: ReturnType<typeof buildDepreciationExpectations>;
  } | null = null;
  if (scheduleRows.length) {
    const expectations = buildDepreciationExpectations(scheduleRows);
    if (expectations.issues.length)
      throw new Error(`Asset schedule: ${expectations.issues.join(" ")}`);
    depreciation = {
      version: "depreciation-v1",
      schedule: scheduleRows,
      fields: buildDepreciationAgentFields(scheduleRows),
      expectations,
    };
    const index = pending.findIndex((item) => item.key === "businessDepreciation");
    if (index >= 0) {
      const bookQueued = fields.some((field) => field.irisCode === "3088");
      if (bookQueued || approvedInputs.businessDepreciation === 0) pending.splice(index, 1);
      else
        pending[index] = {
          ...pending[index],
          reason:
            "Tax depreciation (Depreciation tab) is typed by the agent from your asset list. Book depreciation (3088) still needs the Business Books schedule; IRIS adds it back by itself once 3088 is in.",
        };
    }
    // DP-4 item 2: the tax gain / loss on assets sold (s.22(8)) goes to 3226 /
    // 3256 on the Inadmissible/Admissible Deductions tab. The taxpayer first
    // says how much accounting profit / loss on these sales is already inside
    // the P&L figures (IRIS reverses it itself through 3246 / 3236).
    if (expectations.disposalGain > 0 || expectations.disposalLoss > 0) {
      const answers = readAssetSaleAnswers(raw as Record<string, unknown>);
      const answerProblems = validateAssetSaleAnswers(answers, {
        otherRevenue: approvedInputs.businessOtherRevenue,
        operatingExpenses: approvedInputs.businessOperatingExpenses,
      });
      if (answerProblems.length) throw new Error(answerProblems.join(" "));
      if (answers.bookGain === null || answers.bookLoss === null) {
        pending.push({
          key: "businessDisposalGainLoss",
          amount: expectations.disposalGain - expectations.disposalLoss,
          reason: ASSET_SALE_TEXT.missing,
        });
      } else {
        // With Business Books the agent types 3116 itself: it must be the
        // same accounting profit, or IRIS would take out a different figure.
        const typed3116 = fields
          .filter((field) => field.irisCode === BOOK_GAIN_ON_ASSETS_ROW)
          .reduce((total, field) => total + Number(field.ourAmount || 0), 0);
        const books3116 = fields.some((field) => field.irisCode === BOOK_GAIN_ON_ASSETS_ROW);
        if (books3116 && Math.abs(typed3116 - answers.bookGain) > 0.5)
          throw new Error(
            `Business Books show a gain on sale of assets of PKR ${typed3116.toLocaleString()} (IRIS 3116), but the profit on assets sold on Business profit is PKR ${answers.bookGain.toLocaleString()}. Make them the same.`,
          );
        if (expectations.disposalGain > 0)
          queue(TAX_GAIN_ON_ASSETS_ROW, expectations.disposalGain, "business_deductions", "BUSINESS_TAX_GAIN_ON_ASSETS_SOLD");
        if (expectations.disposalLoss > 0)
          queue(TAX_LOSS_ON_ASSETS_ROW, expectations.disposalLoss, "business_deductions", "BUSINESS_TAX_LOSS_ON_ASSETS_SOLD");
        if (answers.bookGain > 0 && !books3116)
          pending.push({
            key: "businessAssetSaleBookGain",
            amount: answers.bookGain,
            reason:
              "Your other business receipts include this profit on assets sold. In FBR, type it in Other Revenues row 3116 \"Accounting Gain on Sale of Assets\" (as part of other receipts); IRIS then takes it out again by itself (3246). The agent typed the tax gain / loss in 3226 / 3256.",
          });
        if (answers.bookLoss > 0)
          pending.push({
            key: "businessAssetSaleBookLoss",
            amount: answers.bookLoss,
            reason:
              "Your business expenses include this loss on assets sold. In FBR, Admin expenses, press \"+ Add Other Expenses\", tick \"Accounting (Loss) on Sale of Assets\" (3196) and type it there, not in another expense head; IRIS then adds it back by itself (3236). The agent typed the tax gain / loss in 3226 / 3256." +
              (fields.some((field) => field.section === contract.business_admin.tab)
                ? " The agent typed your Books' expense heads: lower the head that holds this loss by the same amount."
                : ""),
          });
      }
    }
  }
  // Partial by design until the business identity, full schedules and derived
  // profit/readback are verified. This is never a ready-to-submit certificate.
  pending.push({
    key: "businessFinalReview",
    amount: null,
    reason:
      "Verify the saved business identity and principal activity, remaining schedules, calculated profit/tax and final reconciliation in FBR yourself.",
  });
  const businessOnlyReturn =
    input.incomeSources.length === 1 && input.incomeSources[0] === "business";
  const computedEstimate = computeBusinessProfit(raw as Ty2026SelectionUserDetails, {
    depreciationSchedule: scheduleRows.length
      ? depreciationScheduleToEngineInput(scheduleRows)
      : null,
    otherIncomeHeads: !businessOnlyReturn,
  });
  // DP-4 item 3: unabsorbed tax depreciation of earlier years (s.57(4)) in
  // 3258 ("+ Admissible"), only when both readings of the 10-million test
  // give the same percentage; otherwise the taxpayer decides.
  const unabsorbed = computedEstimate.unabsorbedDepreciation;
  if (unabsorbed.broughtForward > 0) {
    if (unabsorbed.typable > 0)
      queue("3258", unabsorbed.typable, "business_deductions", "BUSINESS_UNABSORBED_DEPRECIATION");
    if (unabsorbed.ambiguous)
      pending.push({
        key: "businessUnabsorbedDepreciation",
        amount: unabsorbed.halfSetOff,
        reason: unabsorbedAmbiguousMessage(unabsorbed),
      });
    else if (unabsorbed.typable === 0)
      pending.push({
        key: "businessUnabsorbedDepreciationCarriedForward",
        amount: unabsorbed.broughtForward,
        reason:
          "Unabsorbed tax depreciation (s.57(4)): no business income is left after the brought-forward losses this year, so nothing is set off and nothing is typed in 3258. The whole balance carries forward to next year.",
      });
  }
  // Phase 3c: Section 113 minimum tax (D2 / D3). The turnover row is planned
  // whenever s.113 reaches the return; IRIS compares the two taxes itself.
  const storedCategory = (raw as Record<string, unknown>).businessMinimumTaxCategory;
  if (storedCategory !== undefined && storedCategory !== null && !isMinimumTaxCategoryId(storedCategory))
    throw new Error(
      "The business type for the minimum tax (Section 113) is not one of the listed types. Open the Business profit step, pick it again, and save.",
    );
  const storedEarlierYear = (raw as Record<string, unknown>).businessTurnover100mEarlierYear;
  const minimumTaxReach = section113Applicability({
    turnover: computedEstimate.turnover,
    turnover100mEarlierYear: typeof storedEarlierYear === "boolean" ? storedEarlierYear : undefined,
  });
  const minimumTaxCategory = getMinimumTaxCategory(storedCategory ?? DEFAULT_MINIMUM_TAX_CATEGORY);
  if (minimumTaxReach.applies && (!minimumTaxCategory || minimumTaxCategory.ratePercent === null))
    throw new Error(SECTION_113_TEXT.cottonGinner);
  if (minimumTaxReach.needsEarlierYearAnswer)
    pending.push({
      key: "businessTurnover100mEarlierYear",
      amount: null,
      reason: `${SECTION_113_TEXT.earlierYearMissing} Until then the agent does not prepare the minimum tax (Section 113) row.`,
    });
  const minimumTax =
    minimumTaxReach.applies &&
    minimumTaxCategory?.ratePercent &&
    minimumTaxCategory.irisCode &&
    minimumTaxCategory.irisPickerLabel
      ? {
          turnover: computedEstimate.turnover,
          ratePercent: minimumTaxCategory.ratePercent,
          irisCode: minimumTaxCategory.irisCode,
          irisLabel: minimumTaxCategory.irisPickerLabel,
          // The same basis 3009 needs: sales confirmed without Sales Tax / FED.
          turnoverTypable: excludesSalesTaxes,
        }
      : null;
  // Phase 2 (fix47): what IRIS should calculate from exactly these queued
  // figures; the agent compares IRIS's computed rows with it after typing.
  const expectedIrisTotals = buildExpectedIrisTotals({
    // DP-2: bank / vehicle child rows count towards 3349 like any typed asset.
    fields: [...fields, ...(balanceDetails?.fields ?? [])],
    incomeSources: input.incomeSources,
    // Land, building, bank and vehicle are typed only as DP-2 child rows
    // (3301 / 3302 / 3320 / 3304), never as scalar rows.
    assetCodes: [
      ...assetKeys.flatMap((key) =>
        key in scalarCodes ? [scalarCodes[key as keyof typeof scalarCodes]] : [],
      ),
      IRIS_BANK_ROW,
      IRIS_VEHICLE_ROW,
      IRIS_LAND_ROW,
      IRIS_BUILDING_ROW,
    ],
    liabilityCodes: liabilityKeys.map((key) => scalarCodes[key]),
    depreciationDeduction: depreciation?.expectations.deduction ?? 0,
    // DP-3: sections the agent types on the Tax Deduction tab.
    taxDeductionSections: {
      adjustable: taxDeductions?.entries.filter((e) => e.regime === "adjustable").length ?? 0,
      minimum: taxDeductions?.entries.filter((e) => e.regime === "minimum").length ?? 0,
    },
    minimumTax,
  });
  // DP-4 (fix53): rows of the Inadmissible/Admissible Deductions tab other than
  // 3212 need the generalized picker driver of a newer agent.
  const needsDeductionPickers = fields.some(
    (field) =>
      field.section === contract.business_deductions.tab && field.irisCode !== "3212",
  );
  return {
    // v8 = carries Business Land / Building property child rows (3301 / 3302);
    // v7 = types rows of the Inadmissible/Admissible Deductions tab other than
    // 3212 (DP-4, fix53); v6 = carries the Section 113 turnover row on the
    // Computations plan (Phase 3c, fix52); v5 = carries Tax Deduction sections (DP-3, fix50);
    // v4 = carries Balance Sheet child rows and/or the Business Details tab
    // (DP-2, fix49); v3 = carries Depreciation-tab entries (fix48). An older
    // agent refuses a newer version.
    version: balanceDetails?.version === "balance-details-v2"
      ? "business-entry-v8"
      : needsDeductionPickers
      ? "business-entry-v7"
      : expectedIrisTotals.computations?.turnover
      ? "business-entry-v6"
      : taxDeductions?.agentFields.length
      ? "business-entry-v5"
      : balanceDetails?.agentFields.length || businessDetails
      ? "business-entry-v4"
      : depreciation?.fields.length
        ? "business-entry-v3"
        : schedules?.fields.length
          ? "business-entry-v2"
          : "business-entry-v1",
    taxYear: input.taxYear,
    approvedInputs,
    computedEstimate,
    // Phase 3c: Section 113 for the packet view (null when it does not reach the return).
    minimumTax113: minimumTax
      ? {
          reason: minimumTaxReach.reason,
          categoryId: minimumTaxCategory?.id ?? null,
          categoryLabel: minimumTaxCategory?.label ?? null,
          ...minimumTax,
          minimumTax: Math.round((minimumTax.turnover * minimumTax.ratePercent) / 100),
        }
      : null,
    salesExcludeIndirectTax: excludesSalesTaxes,
    schedules,
    balanceSheet,
    balanceSheetDocumentId: input.balanceSheet?.id ?? null,
    fields,
    pending,
    expectedIrisTotals,
    depreciation,
    balanceDetails,
    businessDetails,
    taxDeductions,
    addBacks,
    coverage: "partial_manual_required" as const,
  };
}

/** An optional Business Balance Sheet change must never leave old figures approved. */
export async function invalidateBusinessBalancePackets(
  tx: Pick<Prisma.TransactionClient, "filingPacket" | "filingDraft">,
  filingDraftId: string,
  userId: string,
) {
  await tx.filingPacket.updateMany({
    where: { filingDraftId, userId, status: { not: "SUPERSEDED" } },
    data: { status: "SUPERSEDED", approvalStatus: "SUPERSEDED" },
  });
  await tx.filingDraft.update({
    where: { id: filingDraftId },
    data: {
      packetApprovalConfirmed: false,
      packetApprovalAt: null,
      packetApprovalByUserId: null,
      status: "IN_PROGRESS",
    },
  });
}

/**
 * Business pending items that need a taxpayer action on packet-facing
 * summaries. The generic schedule/final-review reminders stay in the packet
 * internals, but they are not shown as another packet-page warning. A
 * schedule note about missing direct-expense heads is actionable, so it
 * remains visible.
 */
export function visibleBusinessPendingItems<T extends { key: string; reason: string }>(
  pending: readonly T[],
): T[] {
  return pending.filter((item) => {
    if (item.key === "businessFinalReview" || item.key === "servicesFinalReview") return false;
    if (
      item.key === "businessScheduleReview" &&
      !/still needs explicit direct-expense heads/i.test(item.reason)
    )
      return false;
    return true;
  });
}

/** Same filter for handoff labels already stored as `key: reason`. */
export function visibleBusinessPendingLabels(
  labels: readonly string[],
): string[] {
  return labels.filter((label) => {
    const separator = label.indexOf(":");
    if (separator < 0) return true;
    const key = label.slice(0, separator).trim();
    const reason = label.slice(separator + 1).trim();
    return visibleBusinessPendingItems([{ key, reason }]).length === 1;
  });
}

export function businessCoverageSummary(
  business?: BusinessPacket | ServicesTaxDeductionPacket | null,
) {
  return business
    ? {
        status: business.coverage,
        queuedFields: business.fields.length,
        pending: visibleBusinessPendingItems(business.pending).map(
          (item) => `${item.key}: ${item.reason}`,
        ),
      }
    : null;
}

/**
 * The Business-side payload of a single-source Freelancer / Services packet.
 *
 * A Services filing has no Business Profit selection, so `buildBusinessPacket`
 * returns null for it. The Services rows themselves are already evidence-gated
 * upstream (`buildServicesPortalMappings`): the Other Revenues income row and
 * the Business > Tax Deduction withholding rows only exist here when a
 * human-confirmed invoice/payment match produced them. This function adds no
 * new mapping authority — it packages those approved rows in a versioned
 * envelope for the later agent union.
 */
export type ServicesTaxDeductionPacket = {
  version: "services-tax-deduction-v1";
  route: "services_tax_deduction";
  taxYear: number;
  approvedInputs: Record<string, number | null>;
  computedEstimate: null;
  salesExcludeIndirectTax: null;
  schedules: null;
  balanceSheet: null;
  balanceSheetDocumentId: null;
  fields: PortalFieldMapEntry[];
  pending: { key: string; amount: number | null; reason: string }[];
  coverage: "services_tax_deduction_only";
};

export function buildServicesTaxDeductionPacket(input: {
  taxYear: number;
  filerType: string | null;
  incomeSources: string[];
  /** Approved Business > Other Revenues rows (Services income). */
  businessFields: PortalFieldMapEntry[];
  /** Approved Business > Tax Deduction rows (Services withholding). */
  withholdingFields: PortalFieldMapEntry[];
  /** Exact adapter gaps, including an empty list when no tax remains to place. */
  withholdingGaps?: readonly { totalAmount: number; reason: string }[];
}): ServicesTaxDeductionPacket | null {
  if (!input.incomeSources.includes("services")) return null;
  if (
    !isSingleFreelancerServicesFiling({
      taxYear: input.taxYear,
      filerType: input.filerType,
      incomeSources: input.incomeSources,
    })
  )
    throw new Error(
      "Verified Services entry currently supports Myself / TY2026 only, with Freelancer / Services as the only income source.",
    );
  const fields = [...input.businessFields, ...input.withholdingFields];
  // No approved row means nothing may be entered: stay null rather than
  // creating an empty packet payload that looks like a verified target.
  if (!fields.length) return null;

  const pending: { key: string; amount: number | null; reason: string }[] = [];
  if (!input.businessFields.length)
    pending.push({
      key: "servicesIncomeRow",
      amount: null,
      reason:
        "No Services income row passed the evidence gate, so no Business > Other Revenues figure was queued for entry.",
    });
  const withholdingGaps = input.withholdingGaps?.filter((gap) => gap.totalAmount > 0);
  if (withholdingGaps?.length || (withholdingGaps === undefined && !input.withholdingFields.length)) {
    const missingAmount = (withholdingGaps ?? []).reduce((sum, gap) => sum + gap.totalAmount, 0);
    const reasons = [...new Set((withholdingGaps ?? []).map((gap) => gap.reason))];
    pending.push({
      key: "servicesWithholdingRows",
      // The adapter already carries the actual money gap. This is descriptive
      // pending detail only, not a second amount to add to packet totals.
      amount: null,
      reason: reasons.length
        ? `Services withholding PKR ${missingAmount.toLocaleString("en-US")}: ${reasons.join(" ")}`
        : "No Services withholding row passed the evidence gate (statutory section, IRIS code and the exact captured row/column must all match), so no Business > Tax Deduction figure was queued for entry.",
    });
  }
  pending.push({
    key: "servicesFinalReview",
    amount: null,
    reason:
      "Verify the entered Services figures, the remaining Business schedules, Personal Assets / Liabilities, Payment tab and Computations in FBR yourself; the agent never saves or submits.",
  });

  return {
    version: "services-tax-deduction-v1",
    route: "services_tax_deduction",
    taxYear: input.taxYear,
    approvedInputs: {},
    computedEstimate: null,
    salesExcludeIndirectTax: null,
    schedules: null,
    balanceSheet: null,
    balanceSheetDocumentId: null,
    fields,
    pending,
    coverage: "services_tax_deduction_only",
  };
}
