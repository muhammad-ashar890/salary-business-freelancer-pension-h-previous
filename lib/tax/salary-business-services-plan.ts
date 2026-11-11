import {
  SURCHARGE_SERVICES_OR_MIXED_USER_MESSAGE,
} from "./non-business-computations-plan";
import {
  SUPER_TAX_USER_MESSAGE,
  type ComputationsPlan,
  type ExpectedIrisTotals,
} from "./business-iris-expectations";
import { isSalaryBusinessServicesFiling } from "./business-bank-categories";
import type { PortalFieldMapEntry } from "./portal-field-map";

export type SalaryBusinessServicesPlan = {
  version: "salary-business-services-v1";
  totalServicesIncome: number;
  normalServicesIncome: number;
  finalServicesIncome: number;
  expectedTotalIncome: number | null;
  expectedTaxableIncome: number | null;
  expectedNormalTax: number | null;
  normalTaxStatus: "verified_from_business_companion" | "user_review_required";
  expectedIrisTotals: ExpectedIrisTotals & { computations: ComputationsPlan };
  computations: ComputationsPlan;
};

const money = (value: unknown) => Math.round(Number(value) || 0);

/**
 * Adds the already-approved Services envelope to the Salary + Business IRIS
 * expectations. The Business packet is built before the shared-cell fold, so
 * using its expectations unchanged would compare IRIS against a Business-only
 * total. This builder runs after the Services map exists and changes only the
 * exact TY2026 Myself Salary + Business + Services route.
 *
 * No new tax treatment is inferred here. Automatic Normal Tax / surcharge
 * entry is retained only when every Services rupee is explicitly classified
 * as final-tax and no unmapped portal income exists. Any normal-tax Services
 * amount or mapping gap makes those computations USER, while the arithmetic
 * business-income expectation remains available for readback.
 */
export function buildSalaryBusinessServicesPlan(input: {
  taxYear: number;
  filerType: string | null;
  incomeSources: string[];
  businessExpectedIrisTotals: ExpectedIrisTotals;
  servicesFields: readonly PortalFieldMapEntry[];
  hasUnmappedPortalIncome: boolean;
}): SalaryBusinessServicesPlan | null {
  if (
    !isSalaryBusinessServicesFiling({
      taxYear: input.taxYear,
      filerType: input.filerType,
      incomeSources: input.incomeSources,
    })
  ) {
    return null;
  }
  const original = input.businessExpectedIrisTotals;
  if (!original.computations) return null;

  const servicesRows = input.servicesFields.filter(
    (field) => field.servicesMappingKind === "SERVICES_INCOME",
  );
  const totalServicesIncome = servicesRows
    .filter((field) => field.column === "Total Amount")
    .reduce((sum, field) => sum + money(field.ourAmount), 0);
  const finalServicesIncome = servicesRows
    .filter((field) => field.column === "Subject to Final Tax")
    .reduce((sum, field) => sum + money(field.ourAmount), 0);
  if (
    totalServicesIncome < 0 ||
    finalServicesIncome < 0 ||
    finalServicesIncome > totalServicesIncome
  ) {
    return null;
  }
  const normalServicesIncome = totalServicesIncome - finalServicesIncome;
  const exactNormalTax =
    normalServicesIncome === 0 &&
    !input.hasUnmappedPortalIncome &&
    Number.isFinite(original.computations.expectedTaxableIncome) &&
    Number.isFinite(original.computations.expectedNormalTax) &&
    Number(original.computations.expectedTaxableIncome) > 0 &&
    Number(original.computations.expectedNormalTax) > 0;

  const rows = original.rows.map((row) => ({ ...row }));
  const addToRow = (
    code: string,
    column: "normal" | "total",
    amount: number,
    label: string,
  ) => {
    if (amount === 0) return;
    const row = rows.find(
      (candidate) => candidate.code === code && candidate.column === column,
    );
    if (!row) return;
    row.expected = money(row.expected + amount);
    row.formula = `${row.formula} + ${label} (${amount.toLocaleString("en-US")})`;
    // The Services portion has not been certified by the old Business-only
    // live-run inventory. Keep the arithmetic visible without marking it live-proven.
    row.proven = false;
  };

  for (const code of ["3129", "3200", "3000"]) {
    addToRow(code, "total", totalServicesIncome, "mapped Services income");
  }
  for (const code of ["3270", "9000", "9100"]) {
    addToRow(code, "normal", normalServicesIncome, "normal-tax Services income");
  }

  const computations: ComputationsPlan = {
    ...original.computations,
    expectedBusinessIncome:
      original.computations.expectedBusinessIncome === null
        ? null
        : money(
            original.computations.expectedBusinessIncome + totalServicesIncome,
          ),
    surcharge: { ...original.computations.surcharge },
    superTax: { ...original.computations.superTax },
    ...(original.computations.turnover
      ? { turnover: { ...original.computations.turnover } }
      : {}),
  };

  const skipped = original.skipped.map((item) => ({ ...item }));
  if (!exactNormalTax) {
    computations.expectedTaxableIncome = null;
    computations.expectedNormalTax = null;
    computations.surcharge = {
      ...computations.surcharge,
      action: "USER",
      value: 0,
      basis: "normal-tax Services or unmapped portal income needs an IRIS/tax review",
      message: SURCHARGE_SERVICES_OR_MIXED_USER_MESSAGE,
    };
    computations.superTax = {
      ...computations.superTax,
      action: "USER",
      value: 0,
      basis: "combined Salary + Business + Services super-tax base is not automatically typed",
      message: SUPER_TAX_USER_MESSAGE,
    };
    computations.minimumTaxRegime = "unknown";
    const uncertainCodes = new Set(["920000", "9200", "923184", "9231822"]);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (uncertainCodes.has(rows[index].code)) rows.splice(index, 1);
    }
    skipped.push({
      code: "920000",
      reason:
        "Normal-tax Services or unmapped portal income is present; TaxRocket did not infer a combined Normal Tax figure.",
    });
  }

  const baseTaxableIncome = exactNormalTax
    ? original.computations.expectedTaxableIncome
    : original.rows.find((row) => row.code === "9100" && row.column === "normal")
        ?.expected ?? null;
  const expectedTaxableIncome =
    input.hasUnmappedPortalIncome || baseTaxableIncome === null
      ? null
      : money(baseTaxableIncome + normalServicesIncome);
  const expectedTotalIncome =
    expectedTaxableIncome === null
      ? null
      : money(expectedTaxableIncome + finalServicesIncome);
  const expectedNormalTax = exactNormalTax
    ? original.computations.expectedNormalTax
    : null;

  return {
    version: "salary-business-services-v1",
    totalServicesIncome,
    normalServicesIncome,
    finalServicesIncome,
    expectedTotalIncome,
    expectedTaxableIncome,
    expectedNormalTax,
    normalTaxStatus: exactNormalTax
      ? "verified_from_business_companion"
      : "user_review_required",
    expectedIrisTotals: {
      ...original,
      rows,
      skipped,
      computations,
    },
    computations,
  };
}
