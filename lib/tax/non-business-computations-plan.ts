import {
  SUPER_TAX_USER_MESSAGE,
  SURCHARGE_USER_MESSAGE,
  type ComputationsPlan,
} from "./business-iris-expectations";
import { section4ABRatePercent } from "./tax-calculation";

type MoneyLike = number | string | { toString(): string } | null | undefined;

export type CalculationLineForComputations = {
  source: string;
  taxBase?: MoneyLike;
  baseTax?: MoneyLike;
  surcharge?: MoneyLike;
  calculatedTax?: MoneyLike;
  detailsJson?: string | null;
};

export const SURCHARGE_SERVICES_OR_MIXED_USER_MESSAGE =
  "Surcharge (row 923184): Services or manual portal income may join Taxable Income (9100) or interact with minimum/final tax in IRIS, so TaxRocket did not type this figure automatically. If IRIS leaves row 923184 blank while Taxable Income (9100) is above PKR 10 million, check Normal Tax (920000): the surcharge is 9% when salary exceeds 75% of taxable income, otherwise 10%.";

const SECTION_4AB_THRESHOLD = 10_000_000;
const SURCHARGE_LABEL = "Surcharge on high earning person u/s 4AB";
const SUPER_TAX_LABEL = "Tax on High Earning Persons u/s 4C";

function toMoney(value: MoneyLike): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value.toString());
  return Number.isFinite(parsed) ? parsed : 0;
}

type ParsedLineDetails = {
  rateShape?: string;
  isFinalTax?: boolean;
  combinedRoutes?: Array<{ route?: string; income?: number }>;
};

function parseDetails(detailsJson: string | null | undefined): ParsedLineDetails {
  if (!detailsJson) return {};
  try {
    const parsed = JSON.parse(detailsJson);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * When a pension above PKR 10M is taxed under the 5% final regime
 * (`final_above_10m`), row 923184 is already emitted by `portalFieldMap`
 * (`PENSION_SURCHARGE`). If the same return also has a mapped, standalone
 * Salary > PKR 10M (`source === "salary"`, no unmapped/combined progressive
 * sources), its 9% Section 4AB surcharge joins row 923184 so the single IRIS
 * surcharge cell carries the full Section 4AB surcharge.
 */
export function resolveFinalPensionAdditionalNormalSurcharge(input: {
  incomeSources: readonly string[];
  pensionTreatment?: string | null;
  calculationLines: readonly CalculationLineForComputations[];
  mappedServicesIncomePkr?: number;
  hasServicesIncomeGaps?: boolean;
  hasUnmappedPortalIncome?: boolean;
  businessExpectedComputations?: {
    version?: string | null;
    expectedTaxableIncome?: number | null;
    expectedNormalTax?: number | null;
    minimumTaxRegime?: string | null;
    surcharge?: {
      action?: string | null;
      value?: number | null;
      ratePercent?: number | null;
    } | null;
  } | null;
}): number {
  const sources = (input.incomeSources ?? []).map((s) =>
    String(s).trim().toLowerCase(),
  );
  if (input.pensionTreatment !== "final_above_10m") return 0;
  if (
    Math.max(0, Math.round(toMoney(input.mappedServicesIncomePkr))) > 0 ||
    input.hasServicesIncomeGaps ||
    input.hasUnmappedPortalIncome
  ) {
    return 0;
  }

  if (sources.includes("business")) {
    if (
      !sources.every(
        (s) => s === "business" || s === "salary" || s === "pension",
      )
    ) {
      return 0;
    }
    const bc = input.businessExpectedComputations;
    if (
      bc?.version === "computations-v1" &&
      bc.minimumTaxRegime !== "minimum" &&
      bc.surcharge?.action === "TYPE" &&
      typeof bc.surcharge.value === "number" &&
      Number.isInteger(bc.surcharge.value) &&
      bc.surcharge.value > 0 &&
      typeof bc.expectedTaxableIncome === "number" &&
      bc.expectedTaxableIncome > 10_000_000 &&
      typeof bc.expectedNormalTax === "number" &&
      bc.expectedNormalTax > 0 &&
      (bc.surcharge.ratePercent === 9 || bc.surcharge.ratePercent === 10) &&
      Math.abs(
        Math.round((bc.expectedNormalTax * bc.surcharge.ratePercent) / 100) -
          bc.surcharge.value,
      ) <= 1
    ) {
      return bc.surcharge.value;
    }
    return 0;
  }

  if (!sources.includes("salary")) return 0;

  const nonFinalLines = (input.calculationLines ?? []).filter((line) => {
    const src = String(line.source ?? "").trim();
    if (src === "super_tax") return false;
    const details = parseDetails(line.detailsJson);
    return details.isFinalTax !== true && src !== "pension";
  });
  const salaryLines = nonFinalLines.filter(
    (line) => String(line.source ?? "").trim() === "salary",
  );
  if (salaryLines.length !== 1) return 0;
  if (
    nonFinalLines.some(
      (line) =>
        ["combined_slab", "property_rent", "business_profit"].includes(
          String(line.source ?? "").trim(),
        ),
    )
  ) {
    return 0;
  }

  const surcharge = Math.max(0, Math.round(toMoney(salaryLines[0].surcharge)));
  return surcharge > 0 ? surcharge : 0;
}

/**
 * Builds a `computations-v1` plan (`iris-computations-driver.js`) for
 * non-business filings (`Salary`, `Pension`, `Salary + Pension`, `Services`,
 * `Salary + Services`, `Pension + Services`) whenever Section 4AB surcharge
 * (row 923184) or Section 4C super tax (row 9231822) is relevant.
 *
 * - Business filings (`incomeSources` includes `"business"`) return `null` so
 *   `business-iris-expectations.ts` stays the sole owner of business
 *   `computations-v1` plans.
 * - `final_above_10m` pension filings return `null` because `portalFieldMap`
 *   and `pension-guard.js` already own `923184` (`PENSION_SURCHARGE`).
 * - Pure mapped normal/combined slab filings (`Salary`, `Pension` as salary,
 *   `Salary + Pension`) above PKR 10M emit `surcharge.action = "TYPE"` with
 *   exact `expectedTaxableIncome`, `expectedNormalTax`, and `ratePercent`
 *   (`9` or `10`), so `iris-computations-driver.js` verifies IRIS 9100/920000
 *   (and respects IRIS's own `Subject to Normal Tax` auto-computation without
 *   double-typing).
 * - High-income Services / mixed-regime / partial-manual filings emit
 *   `surcharge.action = "USER"` so the desktop driver leaves IRIS-computed
 *   surcharge untouched when already present, stays silent when IRIS 9100 <=
 *   10M, and shows IRIS's exact 9%/10% calculation when IRIS 9100 > 10M with
 *   row 923184 blank.
 */
export function buildNonBusinessComputationsPlan(input: {
  incomeSources: readonly string[];
  calculationLines: readonly CalculationLineForComputations[];
  pensionTreatment?: string | null;
  mappedServicesIncomePkr?: number;
  unmappedServicesIncomePkr?: number;
  hasServicesIncomeGaps?: boolean;
  hasUnmappedPortalIncome?: boolean;
}): ComputationsPlan | null {
  const sources = (input.incomeSources ?? []).map((s) =>
    String(s).trim().toLowerCase(),
  );
  if (sources.includes("business")) return null;
  if (input.pensionTreatment === "final_above_10m") return null;

  const lines = input.calculationLines ?? [];
  const superTaxLine = lines.find(
    (line) => String(line.source ?? "").trim() === "super_tax",
  );
  const superTaxAmount = superTaxLine
    ? Math.max(
        0,
        Math.round(
          toMoney(superTaxLine.calculatedTax ?? superTaxLine.baseTax ?? 0),
        ),
      )
    : 0;
  const superTaxEntry: ComputationsPlan["superTax"] =
    superTaxAmount > 0
      ? {
          code: "9231822",
          label: SUPER_TAX_LABEL,
          action: "USER",
          value: 0,
          ratePercent: null,
          basis: "Total Income for Section 4C super tax exceeds PKR 150 million",
          message: SUPER_TAX_USER_MESSAGE,
        }
      : {
          code: "9231822",
          label: SUPER_TAX_LABEL,
          action: "NONE",
          value: 0,
          ratePercent: 0,
          basis: "income for super tax is PKR 150 million or less (0%)",
          message: "",
        };

  const combinedLine = lines.find(
    (line) => String(line.source ?? "").trim() === "combined_slab",
  );
  const progressiveLines = combinedLine
    ? [combinedLine]
    : lines.filter((line) => {
        const src = String(line.source ?? "").trim();
        if (!["salary", "pension", "property_rent"].includes(src)) return false;
        const details = parseDetails(line.detailsJson);
        return details.isFinalTax !== true && details.rateShape === "PROGRESSIVE";
      });

  const normalTaxableIncome = Math.max(
    0,
    Math.round(
      progressiveLines.reduce((sum, line) => sum + toMoney(line.taxBase), 0),
    ),
  );
  const normalBaseTax = Math.max(
    0,
    Math.round(
      progressiveLines.reduce((sum, line) => sum + toMoney(line.baseTax), 0),
    ),
  );
  const normalSurcharge = Math.max(
    0,
    Math.round(
      progressiveLines.reduce((sum, line) => sum + toMoney(line.surcharge), 0),
    ),
  );

  const mappedServices = Math.max(
    0,
    Math.round(toMoney(input.mappedServicesIncomePkr)),
  );
  const unmappedServices = Math.max(
    0,
    Math.round(toMoney(input.unmappedServicesIncomePkr)),
  );
  const servicesIncomeTotal = mappedServices + unmappedServices;

  const hasNonSalaryOrPensionProgressiveRoute = progressiveLines.some((line) => {
    const src = String(line.source ?? "").trim();
    if (src === "property_rent") return true;
    if (src === "combined_slab") {
      const details = parseDetails(line.detailsJson);
      return (details.combinedRoutes ?? []).some(
        (route) => !["salary", "pension"].includes(String(route.route ?? "")),
      );
    }
    return false;
  });

  const mixedOrManualPortalBase =
    servicesIncomeTotal > 0 ||
    Boolean(input.hasServicesIncomeGaps) ||
    Boolean(input.hasUnmappedPortalIncome) ||
    hasNonSalaryOrPensionProgressiveRoute;

  // Pure mapped normal/combined slab (Salary, working Pension, Salary + Pension):
  if (!mixedOrManualPortalBase) {
    if (normalSurcharge <= 0 && superTaxAmount <= 0) return null;

    if (normalSurcharge > 0) {
      const salaryHeadIncome = combinedLine
        ? (parseDetails(combinedLine.detailsJson).combinedRoutes ?? [])
            .filter((r) => ["salary", "pension"].includes(String(r.route ?? "")))
            .reduce((sum, r) => sum + Math.max(0, Math.round(toMoney(r.income))), 0)
        : normalTaxableIncome;
      const ratePercent = section4ABRatePercent({
        taxableIncome: normalTaxableIncome,
        salaryHeadIncome,
      });
      const expectedFromRate = Math.round((normalBaseTax * ratePercent) / 100);
      const basisConsistent =
        normalTaxableIncome > SECTION_4AB_THRESHOLD &&
        normalBaseTax > 0 &&
        (ratePercent === 9 || ratePercent === 10) &&
        Math.abs(expectedFromRate - normalSurcharge) <= 1;

      if (basisConsistent) {
        return {
          version: "computations-v1",
          expectedTaxableIncome: normalTaxableIncome,
          expectedNormalTax: normalBaseTax,
          expectedBusinessIncome: null,
          surcharge: {
            code: "923184",
            label: SURCHARGE_LABEL,
            action: "TYPE",
            value: normalSurcharge,
            ratePercent,
            basis: `${ratePercent}% of Normal Tax ${normalBaseTax.toLocaleString("en-US")} (920000), because Taxable Income ${normalTaxableIncome.toLocaleString("en-US")} (9100) is above PKR 10 million`,
            message: "",
          },
          superTax: superTaxEntry,
        };
      }

      return {
        version: "computations-v1",
        expectedTaxableIncome: null,
        expectedNormalTax: null,
        expectedBusinessIncome: null,
        surcharge: {
          code: "923184",
          label: SURCHARGE_LABEL,
          action: "USER",
          value: 0,
          ratePercent: null,
          basis: "Taxable income exceeds PKR 10 million, but the normal-tax surcharge basis could not be reconciled automatically",
          message: SURCHARGE_USER_MESSAGE,
        },
        superTax: superTaxEntry,
      };
    }

    return {
      version: "computations-v1",
      expectedTaxableIncome: normalTaxableIncome,
      expectedNormalTax: normalBaseTax,
      expectedBusinessIncome: null,
      surcharge: {
        code: "923184",
        label: SURCHARGE_LABEL,
        action: "NONE",
        value: 0,
        ratePercent: 10,
        basis: "Taxable Income (9100) is PKR 10 million or less: no surcharge",
        message: "",
      },
      superTax: superTaxEntry,
    };
  }

  // Services / mixed / manual-portal-income branch: emit USER only when total
  // normal + Services income can cross PKR 10M (or normalSurcharge / superTax
  // is already > 0), keeping <= 10M returns completely untouched.
  const potentialPortalTaxableIncome = normalTaxableIncome + servicesIncomeTotal;
  if (
    normalSurcharge <= 0 &&
    potentialPortalTaxableIncome <= SECTION_4AB_THRESHOLD &&
    superTaxAmount <= 0
  ) {
    return null;
  }

  const userMessage =
    servicesIncomeTotal > 0 || input.hasServicesIncomeGaps
      ? SURCHARGE_SERVICES_OR_MIXED_USER_MESSAGE
      : SURCHARGE_USER_MESSAGE;

  return {
    version: "computations-v1",
    expectedTaxableIncome: null,
    expectedNormalTax: null,
    expectedBusinessIncome: null,
    surcharge: {
      code: "923184",
      label: SURCHARGE_LABEL,
      action: "USER",
      value: 0,
      ratePercent: null,
      basis:
        servicesIncomeTotal > 0 || input.hasServicesIncomeGaps
          ? "Services income (row 3101/3128) or minimum/final withholding may affect IRIS Taxable Income (9100), Normal Tax (920000), and the 75% salary test"
          : "Other income heads or manual portal figures are part of this return",
      message: userMessage,
    },
    superTax: superTaxEntry,
  };
}
