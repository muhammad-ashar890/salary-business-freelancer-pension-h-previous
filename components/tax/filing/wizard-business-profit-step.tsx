"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Info } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { StepHeading } from "@/components/tax/wizard-ui";
import { BusinessListFieldEditor } from "@/components/tax/filing/business-list-field-editor";
import {
  BUSINESS_MINIMUM_TAX_TURNOVER_THRESHOLD,
  computeBusinessProfit,
  hasBusinessSalesFigure,
} from "@/lib/tax/business-profit";
import {
  DEPRECIATION_ROW_HINTS,
  computeScheduleDepreciation,
  validateDepreciationSchedule,
  type DepreciationScheduleField,
  type DepreciationScheduleRow,
} from "@/lib/tax/business-depreciation-schedule";
import { TAX_DEPRECIATION_ROWS } from "@/lib/tax/tax-depreciation";
import {
  IRIS_LIMITS,
  BUSINESS_BANK_TEXT,
  normalizeIban,
  validateBusinessBankAccounts,
  validateBusinessVehicles,
  type BusinessBankAccount,
  type BusinessProperty,
  type BusinessVehicle,
} from "@/lib/tax/business-balance-details";
import {
  IRIS_BUSINESS_LIMITS,
  IRIS_PRINCIPAL_ACTIVITIES,
  TY2026_LAST_DAY,
  validateBusinessIdentity,
  type BusinessIdentity,
  type IrisPrincipalActivity,
} from "@/lib/tax/business-identity";
import {
  TAX_DEDUCTION_UNSUPPORTED_TEXT,
  compareWithWithholdingTotal,
  findTaxDeductionSection,
  supportedTaxDeductionSections,
  takesAttributableIncome,
  totalTaxDeducted,
  validateBusinessTaxDeductions,
  type BusinessTaxDeduction,
  type TaxDeductionRegime,
} from "@/lib/tax/business-tax-deductions";
import {
  ASSET_SALE_BOOK_GAIN_KEY,
  ASSET_SALE_BOOK_LOSS_KEY,
  ASSET_SALE_TEXT,
  scheduleHasSale,
  validateAssetSaleAnswers,
  readAssetSaleAnswers,
} from "@/lib/tax/business-asset-sales";
import {
  UNABSORBED_DEPRECIATION_DETAIL_KEY,
  compareWithLossTotal,
  irisLossYears,
  totalLossesByYear,
  validateBusinessLossesByYear,
  type BusinessLossByYear,
} from "@/lib/tax/business-loss-rules";
import {
  ADD_BACK_UNSUPPORTED_TEXT,
  addBackReasons,
  compareWithInadmissibleTotal,
  findDeductionRow,
  totalAddBacks,
  validateBusinessAddBacks,
  type BusinessAddBack,
} from "@/lib/tax/business-addbacks";
import {
  DEFAULT_MINIMUM_TAX_CATEGORY,
  MINIMUM_TAX_CATEGORIES,
  SECTION_113_TEXT,
  getMinimumTaxCategory,
  isMinimumTaxCategoryId,
  section113Applicability,
} from "@/lib/tax/minimum-tax-113";
import { businessProfitStepProblems } from "@/lib/tax/business-profit-step-check";
import { emptyBusinessBooksFigures } from "@/lib/tax/business-books-annual-labels";
import {
  BUSINESS_BOOKS_TEXT,
  businessBooksNameForIris,
  withBusinessBooksValues,
  type BusinessBooksValues,
} from "@/lib/tax/business-books-figures";
import {
  getBankStatementBalancesAction,
  getBusinessBooksValuesAction,
} from "@/app/actions/filing";
import { BUSINESS_FACT_LABELS } from "@/lib/tax/business-document-intake";
import {
  TY2026_BUSINESS_PROFIT_FIELDS,
  TY2026_BUSINESS_PROFIT_SUBCATEGORY,
  type Ty2026IncomeSelectionInput,
  type Ty2026SelectionUserDetails,
} from "@/lib/tax/rules/ty2026/subcategories";

type WizardBusinessProfitStepProps = Readonly<{
  intakeIssues?: { key: string; text: string }[] | null;
  selections: readonly Ty2026IncomeSelectionInput[];
  onToggle: (selection: Ty2026IncomeSelectionInput) => void;
  onDetailsChange: (selection: Ty2026IncomeSelectionInput) => void;
  /** The saved filing, to read its mapped Business Books (none before Create). */
  draftId?: string | null;
  /** The filing's bank accounts (Bank accounts step), to tick the business ones. */
  bankAccounts?: readonly { iban: string; bankName: string; accountLabel: string }[];
}>;

/** No mapped Books: the 8 yearly figures are unknown on this step. */
const NO_BOOKS: BusinessBooksValues = {
  figures: emptyBusinessBooksFigures(),
  businessName: null,
};

const rupees = (value: number) =>
  `Rs ${Math.round(value).toLocaleString("en-PK")}`;

/** The typed IRIS Depreciation-tab columns, plus the sale price IRIS has no column for. */
const SCHEDULE_COLUMNS: readonly Readonly<{
  field: DepreciationScheduleField;
  label: string;
  percent?: boolean;
  /** Row 330308 takes only new additions (s.23); IRIS disables the rest. */
  newOnly?: boolean;
}>[] = [
  { field: "wdvBroughtForward", label: "Tax WDV at start of year" },
  { field: "deletion", label: "Deletion (tax WDV of assets sold)" },
  { field: "deletionSalePrice", label: "Sale price of those assets" },
  { field: "additionUsed", label: "Bought this year: used before in Pakistan" },
  { field: "additionUsedExtent", label: "Business use % (opening WDV + used additions)", percent: true },
  { field: "additionNew", label: "Bought this year: new", newOnly: true },
  { field: "additionNewExtent", label: "Business use %", percent: true, newOnly: true },
];

/**
 * "Business profit" step of a filing for yourself (Myself).
 *
 * The figures are saved as ONE selection on the `business` source, so the
 * wizard's existing draft saving, resume and "a changed figure resets the
 * steps after it" rules apply without any special handling. The selection is
 * created when the first figure is typed and removed when the form is emptied,
 * which keeps Continue disabled until something has been entered.
 */
export function WizardBusinessProfitStep({
  intakeIssues,
  selections,
  onToggle,
  onDetailsChange,
  draftId,
  bankAccounts = [],
}: WizardBusinessProfitStepProps) {
  const existing = selections.find(
    (selection) =>
      selection.source === "business" &&
      selection.subcategory === TY2026_BUSINESS_PROFIT_SUBCATEGORY,
  );
  const details = existing?.details;
  // 16-Oct: the 8 yearly figures come from the mapped Business Books
  // (lib/tax/business-books-figures.ts). They are shown read-only, and every
  // figure this step works out uses them, never a typed or stale copy. Edits
  // below still save `details`; the server puts the Books' figures back.
  const [books, setBooks] = useState<BusinessBooksValues | null>(null);
  useEffect(() => {
    let alive = true;
    if (!draftId) {
      setBooks(null);
      return;
    }
    getBusinessBooksValuesAction(draftId).then((result) => {
      if (!alive) return;
      setBooks(
        result.success && result.mapped
          ? { figures: result.figures, businessName: result.businessName }
          : null,
      );
    });
    return () => {
      alive = false;
    };
  }, [draftId]);
  // 16-Oct (part 2): a business bank account's balance on 30 June comes from
  // its bank statement; shown here, never typed.
  const [statementBalances, setStatementBalances] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    if (!draftId) {
      setStatementBalances({});
      return;
    }
    getBankStatementBalancesAction(draftId).then((result) => {
      if (!alive) return;
      setStatementBalances(
        result.success
          ? Object.fromEntries(result.balances.map((entry) => [entry.iban, entry.closingBalance]))
          : {},
      );
    });
    return () => {
      alive = false;
    };
  }, [draftId]);
  const view = withBusinessBooksValues(details, books ?? NO_BOOKS);
  const booksName = businessBooksNameForIris(books);
  const schedule = details?.businessDepreciationSchedule ?? [];
  const scheduleProblems = validateDepreciationSchedule(schedule);
  const scheduleResult = schedule.length ? computeScheduleDepreciation(schedule) : null;
  const profit = computeBusinessProfit(view);
  const hasSales = hasBusinessSalesFigure(view);
  // DP-2: Balance Sheet detail the agent types as IRIS child rows (3320 / 3304).
  const banks = details?.businessBankAccounts ?? [];
  const vehicles = details?.businessVehicles ?? [];
  const properties = details?.businessProperties ?? [];
  const bankProblems = validateBusinessBankAccounts(banks, { balanceFromStatement: true });
  const accountChoices = bankAccounts
    .map((account) => ({ ...account, iban: normalizeIban(account.iban) }))
    .filter((account) => account.iban);
  const isBusinessIban = (iban: string) => banks.some((row) => normalizeIban(row.iban) === iban);
  const otherBankRows = banks.filter(
    (row) => !accountChoices.some((account) => account.iban === normalizeIban(row.iban)),
  );
  const vehicleProblems = validateBusinessVehicles(vehicles);
  const identity = details?.businessIdentity;
  const identityProblems = identity ? validateBusinessIdentity(identity) : [];
  const bankBalances = banks.map((row) => statementBalances[normalizeIban(row.iban)]);
  const bankBalancesKnown = bankBalances.every((value) => typeof value === "number");
  const bankTotal = bankBalances.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const vehicleTotal = vehicles.reduce((sum, row) => sum + (row.value ?? 0), 0);
  const landPropertyTotal = properties
    .filter((row) => row.balanceRow === "land")
    .reduce((sum, row) => sum + (row.value ?? 0), 0);
  const buildingPropertyTotal = properties
    .filter((row) => row.balanceRow === "building")
    .reduce((sum, row) => sum + (row.value ?? 0), 0);
  // DP-3: tax deducted by IRIS section (business Tax Deduction tab).
  const deductions = details?.businessTaxDeductions ?? [];
  const deductionProblems = validateBusinessTaxDeductions(deductions);
  const deductionTotal = totalTaxDeducted(deductions);
  const withholdingTotal =
    typeof view.businessWithholdingDeducted === "number"
      ? view.businessWithholdingDeducted
      : null;
  const deductionTotals = compareWithWithholdingTotal(deductions, withholdingTotal);
  // DP-4: "Expenses that are not allowed" by IRIS reason (business tab
  // Inadmissible/Admissible Deductions).
  const addBacks = details?.businessAddBacks ?? [];
  const addBackProblems = validateBusinessAddBacks(addBacks);
  const addBackTotal = totalAddBacks(addBacks);
  const inadmissibleTotal =
    typeof view.businessInadmissibleExpenses === "number"
      ? view.businessInadmissibleExpenses
      : null;
  const addBackTotals = compareWithInadmissibleTotal(addBacks, inadmissibleTotal);
  // DP-4 item 3: business loss brought forward by tax year + unabsorbed
  // tax depreciation of earlier years (s.57).
  const LOSS_TAX_YEAR = 2026;
  const lossYears = irisLossYears(LOSS_TAX_YEAR);
  const lossRows = details?.businessLossesByYear ?? [];
  const lossProblems = validateBusinessLossesByYear(lossRows, LOSS_TAX_YEAR);
  const lossListed = totalLossesByYear(lossRows);
  const lossBroughtForward =
    typeof view.businessLossBroughtForward === "number"
      ? view.businessLossBroughtForward
      : null;
  const lossTotals = compareWithLossTotal(lossRows, lossBroughtForward);
  const unabsorbedInput =
    typeof details?.businessUnabsorbedDepreciation === "number"
      ? details.businessUnabsorbedDepreciation
      : null;
  // DP-4 item 2: accounting profit / loss on assets sold, asked only with a sale.
  const hasAssetSale = scheduleHasSale(schedule);
  const assetSaleAnswers = readAssetSaleAnswers(details as Record<string, unknown> | undefined);
  const assetSaleProblems = hasAssetSale
    ? validateAssetSaleAnswers(assetSaleAnswers, {
        otherRevenue: typeof view.businessOtherRevenue === "number" ? view.businessOtherRevenue : null,
        operatingExpenses: typeof view.businessOperatingExpenses === "number" ? view.businessOperatingExpenses : null,
      })
    : [];
  // Phase 3c: Section 113 minimum tax on turnover (D2 question, D3 type).
  const earlierYearAnswer = details?.businessTurnover100mEarlierYear;
  const minimumTaxReach = section113Applicability({
    turnover: profit.turnover,
    turnover100mEarlierYear: earlierYearAnswer,
  });
  const minimumTaxCategory =
    getMinimumTaxCategory(details?.businessMinimumTaxCategory ?? DEFAULT_MINIMUM_TAX_CATEGORY) ??
    getMinimumTaxCategory(DEFAULT_MINIMUM_TAX_CATEGORY);
  // Answers the tax estimate needs; Continue stays disabled until they are given.
  // Shown even before the selection exists: answering the Section 113
  // question is what creates it.
  const stepProblems = businessProfitStepProblems(details);
  const minimumTaxPreview =
    minimumTaxCategory && minimumTaxCategory.ratePercent !== null
      ? Math.round((profit.turnover * minimumTaxCategory.ratePercent) / 100)
      : null;

  function saveDetails(next: Ty2026SelectionUserDetails) {
    const selection: Ty2026IncomeSelectionInput = {
      source: "business",
      subcategory: TY2026_BUSINESS_PROFIT_SUBCATEGORY,
      details: next,
    };
    const hasAnyFigure = Object.keys(next).length > 0;
    if (!existing) {
      if (hasAnyFigure) onToggle(selection);
      return;
    }
    if (!hasAnyFigure) {
      onToggle({ source: "business", subcategory: TY2026_BUSINESS_PROFIT_SUBCATEGORY });
      return;
    }
    onDetailsChange(selection);
  }

  /** One cell of the asset schedule (whole rupees / whole percent, as IRIS takes them). */
  function setScheduleValue(
    code: DepreciationScheduleRow["code"],
    field: DepreciationScheduleField,
    raw: string,
  ) {
    const parsed = raw === "" ? undefined : Number(raw);
    const rows = schedule.map((row) => ({ ...row }));
    let row = rows.find((entry) => entry.code === code);
    if (!row) {
      row = { code };
      rows.push(row);
    }
    if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) delete row[field];
    else row[field] = Math.round(parsed);
    const kept = rows
      .filter((entry) =>
        SCHEDULE_COLUMNS.some((column) => (entry[column.field] ?? 0) > 0),
      )
      .sort(
        (a, b) =>
          TAX_DEPRECIATION_ROWS.findIndex((rule) => rule.code === a.code) -
          TAX_DEPRECIATION_ROWS.findIndex((rule) => rule.code === b.code),
      );
    const next: Ty2026SelectionUserDetails = { ...(details ?? {}) };
    if (kept.length) next.businessDepreciationSchedule = kept;
    else delete next.businessDepreciationSchedule;
    saveDetails(next);
  }

  /** One field of the IRIS Business Details entry (dates as YYYY-MM-DD). */
  function setIdentityValue(
    field: "businessName" | "principalActivity" | "brandName" | "startDate" | "endDate",
    raw: string,
  ) {
    const nextIdentity: BusinessIdentity = {
      // Starting the entry with the name empty takes the Books' name; it can
      // be changed (the IRIS name may differ from the books).
      businessName: identity?.businessName || booksName,
      brandName: identity?.brandName ?? "",
      ...(identity?.principalActivity ? { principalActivity: identity.principalActivity } : {}),
      ...(identity?.startDate ? { startDate: identity.startDate } : {}),
      ...(identity?.endDate ? { endDate: identity.endDate } : {}),
    };
    if (field === "businessName") nextIdentity.businessName = raw.slice(0, IRIS_BUSINESS_LIMITS.businessName);
    else if (field === "brandName") nextIdentity.brandName = raw.slice(0, IRIS_BUSINESS_LIMITS.brandName);
    else if (field === "principalActivity") {
      if ((IRIS_PRINCIPAL_ACTIVITIES as readonly string[]).includes(raw))
        nextIdentity.principalActivity = raw as IrisPrincipalActivity;
      else delete nextIdentity.principalActivity;
    } else if (raw) nextIdentity[field] = raw;
    else delete nextIdentity[field];
    const next: Ty2026SelectionUserDetails = { ...(details ?? {}) };
    const empty =
      !nextIdentity.businessName &&
      !nextIdentity.brandName &&
      !nextIdentity.principalActivity &&
      !nextIdentity.startDate &&
      !nextIdentity.endDate;
    if (empty) delete next.businessIdentity;
    else next.businessIdentity = nextIdentity;
    saveDetails(next);
  }

  function saveLists(
    nextBanks: BusinessBankAccount[],
    nextVehicles: BusinessVehicle[],
    nextProperties: BusinessProperty[] = properties,
  ) {
    const next: Ty2026SelectionUserDetails = { ...(details ?? {}) };
    if (nextBanks.length) next.businessBankAccounts = nextBanks;
    else delete next.businessBankAccounts;
    if (nextVehicles.length) next.businessVehicles = nextVehicles;
    else delete next.businessVehicles;
    if (nextProperties.length) next.businessProperties = nextProperties;
    else delete next.businessProperties;
    saveDetails(next);
  }

  /** Rows from the shared document-review editor, in stored property shape. */
  function savePropertyRows(rows: Record<string, unknown>[] | null) {
    const text = (row: Record<string, unknown>, key: string) =>
      typeof row[key] === "string" ? row[key] : "";
    const number = (row: Record<string, unknown>, key: string): number | undefined => {
      const value = row[key];
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    };
    const nextProperties: BusinessProperty[] = (rows ?? []).map((row) => {
      const property: BusinessProperty = {
        balanceRow:
          text(row, "balanceRow") === "land" ||
          text(row, "balanceRow") === "building"
            ? (text(row, "balanceRow") as BusinessProperty["balanceRow"])
            : "",
        propertyType: text(row, "propertyType"),
        propertySubType: text(row, "propertySubType"),
        areaUnit: text(row, "areaUnit"),
        province: text(row, "province"),
        district: text(row, "district"),
        city: text(row, "city"),
        propertyNo: text(row, "propertyNo"),
        sectorMohallaBlock: text(row, "sectorMohallaBlock"),
      };
      if (text(row, "acquisitionDate")) property.acquisitionDate = text(row, "acquisitionDate");
      if (number(row, "landArea") !== undefined) property.landArea = number(row, "landArea");
      if (number(row, "acquisitionCost") !== undefined)
        property.acquisitionCost = number(row, "acquisitionCost");
      if (number(row, "value") !== undefined) property.value = number(row, "value");
      return property;
    });
    saveLists(banks, vehicles, nextProperties);
  }

  /** Tick or untick one of the filing's bank accounts as a business account. */
  function toggleBusinessBank(iban: string, checked: boolean) {
    const others = banks.filter((row) => normalizeIban(row.iban) !== iban);
    saveLists(checked ? [...others, { iban }] : others, vehicles);
  }

  /** One cell of the vehicle list; index === vehicles.length is the "new" line. */
  function setVehicleValue(
    index: number,
    field: "registrationNo" | "chassisNo" | "make" | "model" | "value",
    raw: string,
  ) {
    const rows = vehicles.map((row) => ({ ...row }));
    if (index >= rows.length) rows.push({ registrationNo: "", make: "", model: "" });
    const row = rows[index];
    if (field === "value") {
      const parsed = raw === "" ? undefined : Number(raw);
      if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) delete row.value;
      else row.value = Math.round(parsed);
    } else if (field === "chassisNo") {
      if (raw) row.chassisNo = raw.slice(0, IRIS_LIMITS.chassisNo);
      else delete row.chassisNo;
    } else {
      row[field] = raw.slice(0, IRIS_LIMITS[field]);
    }
    saveLists(
      banks,
      rows.filter(
        (entry) =>
          entry.registrationNo ||
          entry.chassisNo ||
          entry.make ||
          entry.model ||
          entry.value !== undefined,
      ),
    );
  }

  function saveDeductions(nextRows: BusinessTaxDeduction[]) {
    const next: Ty2026SelectionUserDetails = { ...(details ?? {}) };
    if (nextRows.length) next.businessTaxDeductions = nextRows;
    else delete next.businessTaxDeductions;
    saveDetails(next);
  }

  /** One cell of the tax deduction list; index === deductions.length is the "new" line. */
  function setDeductionValue(
    index: number,
    field: "regime" | "code" | "taxableAmount" | "taxDeducted" | "attributableIncome",
    raw: string,
  ) {
    const rows = deductions.map((row) => ({ ...row }));
    if (index >= rows.length) rows.push({ regime: "minimum", code: "" });
    const row = rows[index];
    if (field === "regime") {
      row.regime = raw === "adjustable" ? "adjustable" : "minimum";
      row.code = "";
      delete row.attributableIncome;
    } else if (field === "code") {
      row.code = raw;
      const section = findTaxDeductionSection(row.regime, raw);
      if (!section || !takesAttributableIncome(section)) delete row.attributableIncome;
    } else {
      const parsed = raw === "" ? undefined : Number(raw);
      if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) delete row[field];
      else row[field] = Math.round(parsed);
    }
    saveDeductions(
      rows.filter(
        (entry) =>
          entry.code ||
          entry.taxableAmount !== undefined ||
          entry.taxDeducted !== undefined ||
          entry.attributableIncome !== undefined,
      ),
    );
  }

  function setAssetSaleAnswer(
    key: typeof ASSET_SALE_BOOK_GAIN_KEY | typeof ASSET_SALE_BOOK_LOSS_KEY,
    raw: string,
  ) {
    const parsed = raw === "" ? undefined : Number(raw);
    const next: Ty2026SelectionUserDetails = { ...(details ?? {}) };
    if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) delete next[key];
    else next[key] = Math.round(parsed);
    saveDetails(next);
  }

  function saveLosses(nextRows: BusinessLossByYear[]) {
    const next: Ty2026SelectionUserDetails = { ...(details ?? {}) };
    if (nextRows.length) next.businessLossesByYear = nextRows;
    else delete next.businessLossesByYear;
    saveDetails(next);
  }

  /** One cell of the loss list; index === lossRows.length is the "new" line. */
  function setLossValue(index: number, field: "year" | "amount", raw: string) {
    const rows = lossRows.map((row) => ({ ...row }));
    if (field === "year") {
      const year = Number(raw);
      if (!Number.isInteger(year) || !lossYears.includes(year)) {
        if (index < rows.length) rows.splice(index, 1);
      } else if (index >= rows.length) rows.push({ year });
      else rows[index].year = year;
    } else {
      if (index >= rows.length) return; // choose the year first
      const parsed = raw === "" ? undefined : Number(raw);
      if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) delete rows[index].amount;
      else rows[index].amount = Math.round(parsed);
    }
    saveLosses(rows);
  }

  function setUnabsorbed(raw: string) {
    const parsed = raw === "" ? undefined : Number(raw);
    const next: Ty2026SelectionUserDetails = { ...(details ?? {}) };
    if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0)
      delete next[UNABSORBED_DEPRECIATION_DETAIL_KEY];
    else next[UNABSORBED_DEPRECIATION_DETAIL_KEY] = Math.round(parsed);
    saveDetails(next);
  }

  function saveAddBacks(nextRows: BusinessAddBack[]) {
    const next: Ty2026SelectionUserDetails = { ...(details ?? {}) };
    if (nextRows.length) next.businessAddBacks = nextRows;
    else delete next.businessAddBacks;
    saveDetails(next);
  }

  /** One cell of the add-back list; index === addBacks.length is the "new" line. */
  function setAddBackValue(index: number, field: "code" | "amount", raw: string) {
    const rows = addBacks.map((row) => ({ ...row }));
    if (index >= rows.length) rows.push({ code: "" });
    const row = rows[index];
    if (field === "code") row.code = raw;
    else {
      const parsed = raw === "" ? undefined : Number(raw);
      if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) delete row.amount;
      else row.amount = Math.round(parsed);
    }
    saveAddBacks(rows.filter((entry) => entry.code || entry.amount !== undefined));
  }

  function confirmSalesBasis(checked: boolean) {
    const selection: Ty2026IncomeSelectionInput = {
      source: "business",
      subcategory: TY2026_BUSINESS_PROFIT_SUBCATEGORY,
      details: { ...(details ?? {}), businessSalesExcludeIndirectTax: checked },
    };
    if (existing) onDetailsChange(selection);
    else onToggle(selection);
  }

  const missing = (keys: string[]) => !intakeIssues || intakeIssues.some(issue => keys.some(key => issue.key === key || issue.key.startsWith(key + ".")));

  return (
    <div className="space-y-6">
      <StepHeading
        title="Review your business documents"
        description="Your yearly figures come from reviewed Business Books. Check extracted values below, resolve missing evidence and confirm only details the documents do not establish. Do not guess tax treatment or replace missing evidence with zero."
      />

      {intakeIssues && intakeIssues.length > 0 && <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm" role="status">
        <p className="font-medium">Only missing or conflicting business information needs attention</p>
        <ul className="mt-2 list-disc pl-5">{intakeIssues.map((issue,index) => <li key={index}>{issue.text}</li>)}</ul>
        <p className="mt-2">Facts already available from reviewed documents are not asked again. For a source conflict or missing financial breakdown, go back to Upload documents and correct/complete its review. No separate business-profile certificate is compulsory.</p>
      </div>}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary">Tax Year 2026</Badge>
        <span>All amounts are in PKR for the full tax year</span>
      </div>

      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            Yearly figures from your Business Books
          </h3>
          <p className="text-xs leading-snug text-muted-foreground">
            {books ? BUSINESS_BOOKS_TEXT.fromBooks : BUSINESS_BOOKS_TEXT.waitingForBooks}
          </p>
        </div>
        {books ? (
          <dl className="grid gap-2 sm:grid-cols-2">
            {TY2026_BUSINESS_PROFIT_FIELDS.map((field) => {
              const value = view[field.key];
              return (
                <div
                  key={field.key}
                  className="flex items-baseline justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                >
                  <dt className="text-xs text-muted-foreground">
                    {field.label.replace(/ \(PKR\)$/, "")}
                  </dt>
                  <dd className="text-sm font-semibold text-foreground">
                    {typeof value === "number" ? rupees(value) : "-"}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : null}
      </section>

      {missing(["businessSalesExcludeIndirectTax"]) && <label className="flex items-start gap-3 rounded-xl border p-4 text-sm">
        <input
          type="checkbox"
          checked={details?.businessSalesExcludeIndirectTax === true}
          onChange={(event) => confirmSalesBasis(event.target.checked)}
        />
        <span>
          I confirm Sales for the year excludes Sales Tax and Federal Excise.
          Only this approved basis can be entered as Gross Revenue (3009) in
          FBR. Other business totals stay manual until their detailed schedules
          are available.
        </span>
      </label>}

      {missing(["businessTurnover100mEarlierYear"]) && (
        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground">
              Minimum tax on turnover (Section 113)
            </h3>
            <p className="text-xs leading-snug text-muted-foreground">
              {hasSales
                ? `Your turnover this year (sales plus other business receipts) is ${rupees(profit.turnover)}.`
                : "Your turnover this year (sales plus other business receipts) comes from your Business Books."}{" "}
              A business with a turnover of{" "}
              {rupees(BUSINESS_MINIMUM_TAX_TURNOVER_THRESHOLD)} or more in any
              year since 2017 pays at least a small percentage of its turnover
              as tax. If that is more than the normal tax, the minimum tax is
              paid instead.
            </p>
          </div>
          {(
            <fieldset className="space-y-2">
              <legend className="text-sm text-foreground">
                {SECTION_113_TEXT.earlierYearQuestion} *
              </legend>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="business-turnover-100m-earlier-year"
                    checked={earlierYearAnswer === true}
                    onChange={() =>
                      saveDetails({ ...(details ?? {}), businessTurnover100mEarlierYear: true })
                    }
                  />
                  Yes
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="business-turnover-100m-earlier-year"
                    checked={earlierYearAnswer === false}
                    onChange={() =>
                      saveDetails({ ...(details ?? {}), businessTurnover100mEarlierYear: false })
                    }
                  />
                  No
                </label>
              </div>
              {earlierYearAnswer === undefined ? (
                <p className="text-xs font-medium text-destructive" aria-live="polite">
                  Required: answer Yes or No to continue. The tax estimate needs it.
                </p>
              ) : null}
              {profit.needsMinimumTaxRules ? (
                <p className="text-xs text-muted-foreground">
                  Your turnover this year is already{" "}
                  {rupees(BUSINESS_MINIMUM_TAX_TURNOVER_THRESHOLD)} or more, so
                  Section 113 applies whatever you answer here.
                </p>
              ) : null}
            </fieldset>
          )}
          {minimumTaxReach.applies ? (
            <div className="space-y-2">
              <label className="block text-sm text-foreground">
                What type of business is this?
                <select
                  value={details?.businessMinimumTaxCategory ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (isMinimumTaxCategoryId(value))
                      saveDetails({ ...(details ?? {}), businessMinimumTaxCategory: value });
                  }}
                  className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Choose the applicable supported category</option>
                  {MINIMUM_TAX_CATEGORIES.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              {minimumTaxCategory && minimumTaxCategory.ratePercent === null ? (
                <p className="text-xs text-destructive">{SECTION_113_TEXT.cottonGinner}</p>
              ) : minimumTaxPreview !== null && minimumTaxCategory ? (
                <p className="text-xs text-muted-foreground">
                  Minimum tax: {minimumTaxCategory.ratePercent}% of{" "}
                  {rupees(profit.turnover)} = {rupees(minimumTaxPreview)}. The
                  tax estimate compares it with your normal tax and keeps the
                  higher one. The desktop agent adds the matching turnover row
                  in FBR (Computations) and types your turnover there.
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      )}

      {missing(["businessDepreciation", "businessDisposalGainLoss", "businessAssetSaleBookGain", "businessAssetSaleBookLoss"]) && (
      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            Assets for tax depreciation (IRIS &quot;Depreciation&quot; tab)
          </h3>
          <p className="text-xs leading-snug text-muted-foreground">
            Fill only the rows you have. Use tax written-down values (cost less
            the tax depreciation already claimed), not book values. The desktop
            agent types these figures into the same rows in FBR, and FBR works
            out the initial allowance and depreciation itself. Leave this empty
            if your business has no such assets.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[960px] w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="p-2 font-medium">IRIS row</th>
                {SCHEDULE_COLUMNS.map((column) => (
                  <th key={column.field} className="p-2 font-medium">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TAX_DEPRECIATION_ROWS.map((rule) => {
                const row = schedule.find((entry) => entry.code === rule.code);
                const hint = DEPRECIATION_ROW_HINTS[rule.code];
                return (
                  <tr key={rule.code} className="border-t border-border align-top">
                    <td className="p-2">
                      <span className="block font-medium text-foreground">
                        {rule.label}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {rule.code} - {rule.ratePercent}% a year
                        {rule.initialAllowancePercent
                          ? ` + ${rule.initialAllowancePercent}% initial allowance`
                          : ""}
                      </span>
                      {hint ? (
                        <span className="mt-1 block text-[11px] text-muted-foreground">
                          {hint}
                        </span>
                      ) : null}
                    </td>
                    {SCHEDULE_COLUMNS.map((column) => {
                      const disabled = !rule.acceptsBroughtForward && !column.newOnly;
                      const value = row?.[column.field];
                      return (
                        <td key={column.field} className="p-2">
                          <input
                            type="number"
                            min={0}
                            max={column.percent ? 100 : undefined}
                            step={1}
                            inputMode="numeric"
                            aria-label={`${rule.label}: ${column.label}`}
                            disabled={disabled}
                            placeholder={disabled ? "-" : column.percent ? "%" : "0"}
                            value={typeof value === "number" ? value : ""}
                            onChange={(event) =>
                              setScheduleValue(rule.code, column.field, event.target.value)
                            }
                            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {scheduleProblems.length ? (
          <ul className="list-disc space-y-1 pl-5 text-xs text-destructive" aria-live="polite">
            {scheduleProblems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : scheduleResult ? (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            Tax depreciation for the year: {rupees(scheduleResult.totals.depreciation)}
            {scheduleResult.totals.initialAllowance
              ? `, initial allowance ${rupees(scheduleResult.totals.initialAllowance)}`
              : ""}
            . Deducted from your business profit: {rupees(scheduleResult.totals.deduction)}.
            {scheduleResult.totals.disposalGain || scheduleResult.totals.disposalLoss
              ? ` Tax gain on assets sold: ${rupees(scheduleResult.totals.disposalGain)}, tax loss: ${rupees(scheduleResult.totals.disposalLoss)} (sale price minus tax WDV, s.22(8)). The desktop agent types them in FBR (Inadmissible/Admissible Deductions, rows 3226 / 3256).`
              : ""}
          </p>
        ) : null}
        {hasAssetSale ? (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-xs leading-snug text-muted-foreground">{ASSET_SALE_TEXT.question}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {([
                [ASSET_SALE_BOOK_GAIN_KEY, ASSET_SALE_TEXT.gainLabel, assetSaleAnswers.bookGain],
                [ASSET_SALE_BOOK_LOSS_KEY, ASSET_SALE_TEXT.lossLabel, assetSaleAnswers.bookLoss],
              ] as const).map(([key, text, value]) => (
                <label key={key} className="space-y-1 text-xs">
                  <span className="font-medium text-foreground">{text} *</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    placeholder="0"
                    value={value === null ? "" : value}
                    onChange={(event) => setAssetSaleAnswer(key, event.target.value)}
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
              ))}
            </div>
            {assetSaleAnswers.bookGain === null || assetSaleAnswers.bookLoss === null ? (
              <p className="text-xs text-destructive" aria-live="polite">{ASSET_SALE_TEXT.missing}</p>
            ) : null}
            {assetSaleProblems.length ? (
              <ul className="list-disc space-y-1 pl-5 text-xs text-destructive" aria-live="polite">
                {assetSaleProblems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>
      )}

      {missing(["businessIdentity"]) && (
      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            Business details (IRIS &quot;Business Details&quot; tab)
          </h3>
          <p className="text-xs leading-snug text-muted-foreground">
            The desktop agent adds your business on the Business Details tab in
            FBR with exactly these entries. IRIS requires every field except the
            end date.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label hidden={(details?.businessDocumentFactKeys ?? []).includes("businessIdentity.businessName")} className="space-y-1 text-xs">
            <span className="font-medium text-foreground">Business name</span>
            <input
              type="text"
              autoComplete="off"
              maxLength={IRIS_BUSINESS_LIMITS.businessName}
              placeholder={booksName || undefined}
              value={identity?.businessName ?? ""}
              onChange={(event) => setIdentityValue("businessName", event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label hidden={(details?.businessDocumentFactKeys ?? []).includes("businessIdentity.principalActivity")} className="space-y-1 text-xs">
            <span className="font-medium text-foreground">Principal activity</span>
            <select
              value={identity?.principalActivity ?? ""}
              onChange={(event) => setIdentityValue("principalActivity", event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Choose</option>
              {IRIS_PRINCIPAL_ACTIVITIES.map((activity) => (
                <option key={activity} value={activity}>
                  {activity}
                </option>
              ))}
            </select>
          </label>
          <label hidden={(details?.businessDocumentFactKeys ?? []).includes("businessIdentity.brandName")} className="space-y-1 text-xs">
            <span className="font-medium text-foreground">Brand name</span>
            <input
              type="text"
              autoComplete="off"
              maxLength={IRIS_BUSINESS_LIMITS.brandName}
              value={identity?.brandName ?? ""}
              onChange={(event) => setIdentityValue("brandName", event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span className="block text-[11px] text-muted-foreground">
              No separate brand? Write the business name. Separate several
              brands with commas, as IRIS asks.
            </span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label hidden={(details?.businessDocumentFactKeys ?? []).includes("businessIdentity.startDate")} className="space-y-1 text-xs">
              <span className="font-medium text-foreground">Start date</span>
              <input
                type="date"
                max={TY2026_LAST_DAY}
                value={identity?.startDate ?? ""}
                onChange={(event) => setIdentityValue("startDate", event.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <label hidden={(details?.businessDocumentFactKeys ?? []).includes("businessIdentity.endDate")} className="space-y-1 text-xs">
              <span className="font-medium text-foreground">End date (only if closed)</span>
              <input
                type="date"
                max={TY2026_LAST_DAY}
                value={identity?.endDate ?? ""}
                onChange={(event) => setIdentityValue("endDate", event.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </div>
        </div>
        {identityProblems.length ? (
          <ul className="list-disc space-y-1 pl-5 text-xs text-destructive" aria-live="polite">
            {identityProblems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
      </section>
      )}

      {missing(["balanceSheet.bank", "balanceSheet.vehicle", "balanceSheet.land", "balanceSheet.building", "businessBankAccounts", "businessVehicles", "businessProperties"]) && (
      <section className="space-y-4 rounded-xl border border-border bg-card p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            Business bank accounts, vehicles and properties (IRIS Balance Sheet)
          </h3>
          <p className="text-xs leading-snug text-muted-foreground">
            Mark the bank accounts of the business and list its vehicles and
            land/building properties with their value on 30 June, as in your
            Balance Sheet. The desktop agent adds each one in FBR (Balance Sheet
            rows 3320, 3304, 3301 and 3302) and types its amount. The totals must
            match the bank, vehicle, land and building figures of your Balance
            Sheet. Only accounts in your own name and in Pakistani rupees are
            added here; enter a joint or foreign-currency account in FBR yourself.
          </p>
        </div>

        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-foreground">
            Business bank accounts (Balance Sheet 3320)
          </h4>
          <p className="text-xs leading-snug text-muted-foreground">
            {BUSINESS_BANK_TEXT.choose}
          </p>
          {accountChoices.length ? (
            <ul className="space-y-2">
              {accountChoices.map((account) => {
                const balance = statementBalances[account.iban];
                return (
                  <li
                    key={account.iban}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2"
                  >
                    <label className="flex items-center gap-2 text-xs text-foreground">
                      <input
                        type="checkbox"
                        checked={isBusinessIban(account.iban)}
                        onChange={(event) => toggleBusinessBank(account.iban, event.target.checked)}
                      />
                      <span>
                        {account.bankName} - {account.accountLabel}{" "}
                        <span className="font-mono">{account.iban}</span>
                      </span>
                    </label>
                    <span className="text-xs text-muted-foreground">
                      {typeof balance === "number"
                        ? `Balance on 30 June: ${rupees(balance)} (from the statement)`
                        : BUSINESS_BANK_TEXT.balanceAfterStatement}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{BUSINESS_BANK_TEXT.noAccounts}</p>
          )}
          {otherBankRows.map((row) => (
            <div
              key={`other-${row.iban}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-xs"
            >
              <span>
                <span className="font-mono">{row.iban}</span>: {BUSINESS_BANK_TEXT.notYourAccount}
              </span>
              <button
                type="button"
                onClick={() =>
                  saveLists(banks.filter((entry) => normalizeIban(entry.iban) !== normalizeIban(row.iban)), vehicles)
                }
                className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Remove
              </button>
            </div>
          ))}
          {banks.length && bankBalancesKnown ? (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              Total of these accounts: {rupees(bankTotal)}. It must equal the
              bank figure in your Balance Sheet.
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-foreground">
            Business vehicles (Balance Sheet 3304)
          </h4>
          <div className="overflow-x-auto">
            <table className="min-w-[860px] w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="p-2 font-medium">Registration no.</th>
                  <th className="p-2 font-medium">Chassis no. (optional)</th>
                  <th className="p-2 font-medium">Make</th>
                  <th className="p-2 font-medium">Model</th>
                  <th className="p-2 font-medium">Value on 30 June (Rs)</th>
                  <th className="p-2 font-medium">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...vehicles, null].map((row, index) => (
                  <tr key={`vehicle-${index}`} className="border-t border-border">
                    {(
                      [
                        ["registrationNo", "Registration no.", IRIS_LIMITS.registrationNo, "LEA-1234"],
                        ["chassisNo", "Chassis no.", IRIS_LIMITS.chassisNo, ""],
                        ["make", "Make", IRIS_LIMITS.make, "Suzuki"],
                        ["model", "Model", IRIS_LIMITS.model, "Cultus 2020"],
                      ] as const
                    ).map(([field, label, limit, example]) => (
                      <td key={field} className="p-2">
                        <input
                          type="text"
                          autoComplete="off"
                          maxLength={limit}
                          aria-label={row ? `${label} of vehicle ${index + 1}` : `${label} of a new vehicle`}
                          placeholder={example}
                          value={row?.[field] ?? ""}
                          onChange={(event) => setVehicleValue(index, field, event.target.value)}
                          className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      </td>
                    ))}
                    <td className="p-2">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        inputMode="numeric"
                        aria-label={row ? `Value of vehicle ${index + 1}` : "Value of a new vehicle"}
                        placeholder="0"
                        value={typeof row?.value === "number" ? row.value : ""}
                        onChange={(event) => setVehicleValue(index, "value", event.target.value)}
                        className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </td>
                    <td className="p-2 text-right">
                      {row ? (
                        <button
                          type="button"
                          onClick={() => saveLists(banks, vehicles.filter((_, i) => i !== index))}
                          className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          Remove
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {vehicles.length ? (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              Total of these vehicles: {rupees(vehicleTotal)}. It must equal the
              vehicle figure in your Balance Sheet.
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-foreground">
            Business land and building properties (Balance Sheet 3301 / 3302)
          </h4>
          <p className="text-xs leading-snug text-muted-foreground">
            Add each property once, under Land or Building, with the detail
            FBR asks for. District and city must use the exact spelling FBR
            offers after the province and district are chosen. Date of
            acquisition and acquisition cost/value may be left blank when the
            record does not show them; the Balance Sheet value is separate.
          </p>
          <BusinessListFieldEditor
            label={BUSINESS_FACT_LABELS.businessProperties}
            value={properties}
            taxYear={2026}
            onChange={savePropertyRows}
          />
          {properties.length ? (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              Land total: {rupees(landPropertyTotal)}; building total: {rupees(buildingPropertyTotal)}.
              Each total must equal the matching figure in your Balance Sheet.
            </p>
          ) : null}
        </div>

        {bankProblems.length || vehicleProblems.length ? (
          <ul className="list-disc space-y-1 pl-5 text-xs text-destructive" aria-live="polite">
            {[...bankProblems, ...vehicleProblems].map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
      </section>
      )}

      {missing(["businessWithholdingDeducted", "businessTaxDeductions"]) && (
      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            Tax deducted from business receipts, by section (IRIS Tax Deduction)
          </h3>
          <p className="text-xs leading-snug text-muted-foreground">
            List each withholding section from your tax deduction certificates:
            the amount the tax was deducted on and the tax deducted. The
            desktop agent adds each section in FBR (Business &gt; Tax
            Deduction) and types these figures; IRIS works out the rest. The
            list must not add up to more than &quot;Tax already deducted on
            business receipts&quot; above. Final-tax sections, imported mobile
            phones, s.236CA and ADTT sections are not typed by the agent yet:
            leave them out and enter them in FBR yourself.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[860px] w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="p-2 font-medium">Type in IRIS</th>
                <th className="p-2 font-medium">Section</th>
                <th className="p-2 font-medium">Taxable amount (Rs)</th>
                <th className="p-2 font-medium">Tax deducted (Rs)</th>
                <th className="p-2 font-medium">Attributable taxable income (Rs)</th>
                <th className="p-2 font-medium">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {[...deductions, null].map((row, index) => {
                const regime: TaxDeductionRegime = row?.regime ?? "minimum";
                const section = row?.code ? findTaxDeductionSection(regime, row.code) : null;
                const attributable = section ? takesAttributableIncome(section) : false;
                return (
                  <tr key={`deduction-${index}`} className="border-t border-border align-top">
                    <td className="p-2">
                      <select
                        aria-label={row ? `IRIS type of tax deduction ${index + 1}` : "IRIS type of a new tax deduction"}
                        value={regime}
                        onChange={(event) => setDeductionValue(index, "regime", event.target.value)}
                        className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <option value="minimum">Minimum tax</option>
                        <option value="adjustable">Adjustable tax</option>
                      </select>
                    </td>
                    <td className="p-2">
                      <select
                        aria-label={row ? `Section of tax deduction ${index + 1}` : "Section of a new tax deduction"}
                        value={row?.code ?? ""}
                        onChange={(event) => setDeductionValue(index, "code", event.target.value)}
                        className="w-full max-w-[340px] rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <option value="">Choose the section</option>
                        {supportedTaxDeductionSections(regime).map((option) => (
                          <option key={option.code} value={option.code}>
                            {option.label} ({option.code})
                          </option>
                        ))}
                        {section?.unsupported ? (
                          <option value={section.code}>{section.label} ({section.code})</option>
                        ) : null}
                      </select>
                      {section?.unsupported ? (
                        <p className="mt-1 text-xs text-destructive">
                          {TAX_DEDUCTION_UNSUPPORTED_TEXT[section.unsupported]}
                        </p>
                      ) : null}
                    </td>
                    {(["taxableAmount", "taxDeducted"] as const).map((key) => (
                      <td key={key} className="p-2">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          aria-label={`${key === "taxableAmount" ? "Taxable amount" : "Tax deducted"} of ${row ? `tax deduction ${index + 1}` : "a new tax deduction"}`}
                          placeholder="0"
                          value={typeof row?.[key] === "number" ? row[key] : ""}
                          onChange={(event) => setDeductionValue(index, key, event.target.value)}
                          className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      </td>
                    ))}
                    <td className="p-2">
                      {attributable ? (
                        <input
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          aria-label={`Attributable taxable income of tax deduction ${index + 1}`}
                          placeholder="Optional"
                          value={typeof row?.attributableIncome === "number" ? row.attributableIncome : ""}
                          onChange={(event) => setDeductionValue(index, "attributableIncome", event.target.value)}
                          className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      ) : (
                        <span className="text-muted-foreground">IRIS works it out</span>
                      )}
                    </td>
                    <td className="p-2 text-right">
                      {row ? (
                        <button
                          type="button"
                          onClick={() => saveDeductions(deductions.filter((_, i) => i !== index))}
                          className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          Remove
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {deductions.length ? (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            Tax deducted in this list: {rupees(deductionTotal)}
            {withholdingTotal !== null && !deductionTotals.problems.length && deductionTotals.remainder > 0
              ? `. Not listed by section: ${rupees(deductionTotals.remainder)} (it stays a manual item for FBR).`
              : "."}
            {deductions.some((row) => row.regime === "minimum")
              ? " Minimum tax: IRIS compares it with the normal tax itself; check Tax Chargeable in FBR."
              : null}
          </p>
        ) : null}
        {deductionProblems.length || deductionTotals.problems.length ? (
          <ul className="list-disc space-y-1 pl-5 text-xs text-destructive" aria-live="polite">
            {[...deductionProblems, ...deductionTotals.problems].map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
      </section>
      )}

      {missing(["businessInadmissibleExpenses", "businessAddBacks"]) && (
      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            Expenses that are not allowed, by reason (IRIS Inadmissible Deductions)
          </h3>
          <p className="text-xs leading-snug text-muted-foreground">
            Split &quot;Expenses that are not allowed&quot; above by the reason
            the law does not allow them, for example Rs 80,000 of personal
            expenses and Rs 20,000 of fines. The desktop agent adds each reason
            in FBR (Business &gt; Inadmissible/Admissible Deductions &gt;
            &quot;+ Inadmissible&quot;) and types its amount. The list must not
            add up to more than &quot;Expenses that are not allowed&quot;;
            anything not listed stays a manual item for FBR. A gain on business
            assets sold comes from your asset list, not from here.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[640px] w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="p-2 font-medium">Reason (as IRIS names it)</th>
                <th className="p-2 font-medium">Amount (Rs)</th>
                <th className="p-2 font-medium">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {[...addBacks, null].map((row, index) => {
                const reason = row?.code ? findDeductionRow(row.code) : null;
                return (
                  <tr key={`add-back-${index}`} className="border-t border-border align-top">
                    <td className="p-2">
                      <select
                        aria-label={row ? `Reason of add-back ${index + 1}` : "Reason of a new add-back"}
                        value={row?.code ?? ""}
                        onChange={(event) => setAddBackValue(index, "code", event.target.value)}
                        className="w-full max-w-[460px] rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <option value="">Choose the reason</option>
                        {addBackReasons().map((option) => (
                          <option key={option.code} value={option.code}>
                            {option.label} ({option.code})
                          </option>
                        ))}
                        {reason?.unsupported ? (
                          <option value={reason.code}>{reason.label} ({reason.code})</option>
                        ) : null}
                      </select>
                      {reason?.unsupported ? (
                        <p className="mt-1 text-xs text-destructive">
                          {ADD_BACK_UNSUPPORTED_TEXT[reason.unsupported]}
                        </p>
                      ) : null}
                    </td>
                    <td className="p-2">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        inputMode="numeric"
                        aria-label={`Amount of ${row ? `add-back ${index + 1}` : "a new add-back"}`}
                        placeholder="0"
                        value={typeof row?.amount === "number" ? row.amount : ""}
                        onChange={(event) => setAddBackValue(index, "amount", event.target.value)}
                        className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </td>
                    <td className="p-2 text-right">
                      {row ? (
                        <button
                          type="button"
                          onClick={() => saveAddBacks(addBacks.filter((_, i) => i !== index))}
                          className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          Remove
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {addBacks.length ? (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            Listed by reason: {rupees(addBackTotal)}
            {inadmissibleTotal !== null && !addBackTotals.problems.length && addBackTotals.remainder > 0
              ? `. Not listed by reason: ${rupees(addBackTotals.remainder)} (it stays a manual item for FBR).`
              : "."}
          </p>
        ) : null}
        {addBackProblems.length || addBackTotals.problems.length ? (
          <ul className="list-disc space-y-1 pl-5 text-xs text-destructive" aria-live="polite">
            {[...addBackProblems, ...addBackTotals.problems].map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
      </section>
      )}

      {missing(["businessLossBroughtForward", "businessLossesByYear", "businessUnabsorbedDepreciation"]) && (
      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            Business losses of earlier years, by year (IRIS Adjustments)
          </h3>
          <p className="text-xs leading-snug text-muted-foreground">
            Split &quot;Business loss brought forward&quot; by the tax year the
            loss was made, for example Rs 300,000 from 2023 and Rs 200,000 from
            2024. The oldest loss is used first (s.57(3)). The desktop agent
            types each year in its own row in FBR (Business &gt; Adjustments).
            IRIS for tax year 2026 takes losses of {lossYears.join(", ")}; a
            loss is kept for six years only. The list must not add up to more
            than &quot;Business loss brought forward&quot;; anything not listed
            stays a manual item for FBR.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[520px] w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="p-2 font-medium">Tax year of the loss</th>
                <th className="p-2 font-medium">Unused loss (Rs)</th>
                <th className="p-2 font-medium">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {[...lossRows, null].map((row, index) => (
                <tr key={`loss-${index}`} className="border-t border-border align-top">
                  <td className="p-2">
                    <select
                      aria-label={row ? `Tax year of loss ${index + 1}` : "Tax year of a new loss"}
                      value={row ? String(row.year) : ""}
                      onChange={(event) => setLossValue(index, "year", event.target.value)}
                      className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="">Choose the year</option>
                      {lossYears.map((year) => (
                        <option key={year} value={String(year)}>
                          {year}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="p-2">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      aria-label={row ? `Unused loss of ${row.year}` : "Unused loss of a new year"}
                      placeholder={row ? "0" : "Choose the year first"}
                      disabled={!row}
                      value={typeof row?.amount === "number" ? row.amount : ""}
                      onChange={(event) => setLossValue(index, "amount", event.target.value)}
                      className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </td>
                  <td className="p-2 text-right">
                    {row ? (
                      <button
                        type="button"
                        onClick={() => saveLosses(lossRows.filter((_, i) => i !== index))}
                        className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        Remove
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {lossRows.length ? (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            Listed by year: {rupees(lossListed)}
            {lossBroughtForward !== null && !lossTotals.problems.length && lossTotals.remainder > 0
              ? `. Not listed by year: ${rupees(lossTotals.remainder)} (it stays a manual item for FBR).`
              : "."}
          </p>
        ) : null}
        {lossProblems.length || lossTotals.problems.length ? (
          <ul className="list-disc space-y-1 pl-5 text-xs text-destructive" aria-live="polite">
            {[...lossProblems, ...lossTotals.problems].map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
        <label className="block space-y-1 text-xs">
          <span className="font-medium text-foreground">
            Unabsorbed tax depreciation from earlier years (Rs)
          </span>
          <span className="block text-muted-foreground">
            Tax depreciation or initial allowance of earlier years that could
            not be used because there was no profit. It is not part of the
            loss above. It is used against 50% of this year&apos;s business
            income left after the losses, or 100% if your taxable income is
            below Rs 10 million (s.57(4)), and it never expires.
          </span>
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            placeholder="0"
            value={unabsorbedInput === null ? "" : unabsorbedInput}
            onChange={(event) => setUnabsorbed(event.target.value)}
            className="w-full max-w-[240px] rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        {profit.unabsorbedDepreciation.broughtForward > 0 ? (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {profit.unabsorbedDepreciation.estimateSetOff === 0 && !profit.unabsorbedDepreciation.ambiguous
              ? "Nothing is used this year (no business income is left after the losses); all of it carries forward."
              : profit.unabsorbedDepreciation.ambiguous
              ? `Used this year: ${rupees(profit.unabsorbedDepreciation.estimateSetOff)} (50%) in the estimate. Your figures sit where the Rs 10 million test can be read two ways (100% would be ${rupees(profit.unabsorbedDepreciation.fullSetOff)}), so you type this row in FBR yourself.`
              : `Used this year: ${rupees(profit.unabsorbedDepreciation.estimateSetOff)}${profit.unabsorbedDepreciation.rate === 1 ? " (100%)" : profit.unabsorbedDepreciation.rate === 0.5 ? " (50%)" : ""}; left for later years: ${rupees(profit.unabsorbedDepreciation.remaining)}. The desktop agent types it in FBR (row 3258).`}
          </p>
        ) : null}
      </section>
      )}

      <div
        className={`rounded-xl border p-4 ${
          hasSales ? "border-amanah bg-amanah/5" : "border-border bg-muted/30"
        }`}
        aria-live="polite"
      >
        <div className="flex items-start gap-3">
          {hasSales ? (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-amanah" />
          ) : (
            <Info className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          )}
          <div className="space-y-1 text-sm">
            {!hasSales ? (
              <p className="text-muted-foreground">
                {BUSINESS_BOOKS_TEXT.estimateAfterBooks}
              </p>
            ) : profit.profitBeforeLossRelief < 0 ? (
              <>
                <p className="font-semibold text-foreground">
                  Business loss for the year:{" "}
                  {rupees(profit.lossCarriedForward)}
                </p>
                <p className="text-muted-foreground">
                  {minimumTaxReach.applies
                    ? "The minimum tax on turnover still applies in a loss year (see the box above)."
                    : "No tax is estimated on a loss."}{" "}
                  The loss can be carried forward to the next six years.
                </p>
              </>
            ) : (
              <>
                <p className="font-semibold text-foreground">
                  Estimated taxable business profit:{" "}
                  {rupees(profit.taxableIncome)}
                </p>
                {profit.lossSetOff > 0 ? (
                  <p className="text-muted-foreground">
                    After setting off {rupees(profit.lossSetOff)} of
                    brought-forward loss.
                  </p>
                ) : null}
              </>
            )}
            {hasSales && minimumTaxReach.applies && profit.profitBeforeLossRelief >= 0 ? (
              <p className="text-muted-foreground">
                The minimum tax on turnover (Section 113) is compared with this
                in the tax estimate; see the box above.
              </p>
            ) : null}
            {hasSales && profit.taxDepreciationPending ? (
              <p className="text-muted-foreground">
                Your book depreciation of{" "}
                {rupees(profit.accountingDepreciationAddedBack)} is added back,
                as IRIS does: the law allows only tax depreciation at Third
                Schedule rates. Fill the asset table above to have it deducted;
                until then nothing is deducted for it here.
              </p>
            ) : null}
            {hasSales && profit.taxDepreciationDetail ? (
              <p className="text-muted-foreground">
                Your book depreciation of{" "}
                {rupees(profit.accountingDepreciationAddedBack)} is added back,
                as IRIS does, and tax depreciation of{" "}
                {rupees(profit.taxDepreciation)} from your asset list is
                deducted.
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              This is an estimate from the figures you typed. We do not check
              which expenses the law allows; IRIS gives the final tax.
            </p>
          </div>
        </div>
      </div>

      {stepProblems.length ? (
        <div
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4"
          aria-live="polite"
        >
          <p className="text-sm font-semibold text-destructive">
            To continue, finish these:
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-destructive">
            {stepProblems.map((problem) => (
              <li key={problem.id}>{problem.text}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
