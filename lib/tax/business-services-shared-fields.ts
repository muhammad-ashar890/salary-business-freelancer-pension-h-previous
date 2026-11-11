/**
 * Freelancer (Services) + Business on one return: which IRIS cell each figure
 * travels to, and what happens when both sources answer to the same cell.
 *
 * Live IRIS gives a combined return ONE row for both kinds of receipt. The
 * Business packet writes `3101 / Total Amount` for technical and professional
 * fees (`lib/tax/business-schedule-fields.ts`, `add()` hard-codes the column)
 * and the Services packet writes the very same `3101 / Total Amount` for the
 * human-confirmed Services income (`lib/tax/services-portal-map.ts`). `3128 /
 * Total Amount` ("Others") is shared the same way. Both flattened field maps
 * are one-row-per-code-and-column by construction, so a second row for the same
 * cell is not a second figure — it is a dropped figure. Nothing in the portal
 * map, the agent or the expectation tests caught that, which is why this module
 * exists: it folds the two rows into one sum BEFORE the map is flattened, and
 * reports anything it could not fold instead of letting it through.
 *
 * Only the shared `Total Amount` column is folded. A Services `Subject to Final
 * Tax` row (`services-portal-map.ts`, section 154A) has no Business
 * counterpart, so it travels untouched: dropping it is what double-taxes 154A
 * revenue under the normal slabs.
 */

import type { PortalFieldMapEntry } from "./portal-field-map";

/** One IRIS cell. Two entries with the same key are the same input box. */
export function sharedBusinessFieldKey(
  field: Pick<
    PortalFieldMapEntry,
    "portalArea" | "section" | "irisCode" | "column"
  >,
): string {
  return [
    String(field.portalArea ?? ""),
    String(field.section ?? ""),
    String(field.irisCode ?? ""),
    String(field.column ?? ""),
  ].join(":");
}

/** The Business rows that the Services route is allowed to share a cell with. */
const SHARED_INCOME_CODES = new Set(["3101", "3128"]);

const isShareableServicesIncome = (field: PortalFieldMapEntry) =>
  field.servicesMappingKind === "SERVICES_INCOME" &&
  field.portalArea === "Business" &&
  SHARED_INCOME_CODES.has(String(field.irisCode));

/** Amounts are whole rupees; a rounding of a cent must not split a row. */
const roundPkr = (value: number) => Math.round(value * 100) / 100;

const uniqueSorted = (values: readonly (string | undefined)[]) =>
  Array.from(
    new Set(
      values.map((value) => String(value ?? "").trim()).filter(Boolean),
    ),
  ).sort();

/**
 * Evidence ids are carried through a fold so the agent's Services cross-check
 * (`getServicesAutofillFields` in `electron-connect/main.js`) still finds the
 * invoice set behind a figure it is about to type.
 */
const evidence = (
  fields: readonly PortalFieldMapEntry[],
  key: string,
): string[] =>
  uniqueSorted(
    fields.flatMap(
      (field) =>
        ((field as unknown as Record<string, unknown>)[key] as
          | string[]
          | undefined) ?? [],
    ),
  );

export type BusinessServicesMergeResult = {
  /** What `portalFieldMap.businessFields` becomes. */
  fields: PortalFieldMapEntry[];
  /** Services income folded into a Business row, one entry per folded pair. */
  merged: {
    irisCode: string;
    column: PortalFieldMapEntry["column"];
    businessAmount: number;
    servicesAmount: number;
    totalAmount: number;
    businessOurCategory: string;
    servicesOurCategory: string;
  }[];
  /**
   * Services income rows that could not be folded and were therefore NOT added
   * to the Business grid. Surfaced as a manual-entry gap; never typed, because
   * a second write to a shared cell either overwrites the Business figure or is
   * counted twice.
   */
  unmapped: {
    irisCode: string;
    column: PortalFieldMapEntry["column"];
    amount: number;
    reason: string;
  }[];
  /** True when at least one row came from each side and the fold was needed. */
  combined: boolean;
};

/**
 * Fold a combined return's Business and Services Business-grid rows into the
 * one IRIS row per cell that the portal actually has.
 *
 * Fail-closed by design: an unresolvable collision is reported in `unmapped`
 * (which the caller turns into a `mappingGaps` entry and a review item) rather
 * than written twice, and the folded figure is only produced when exactly one
 * Business row owns the cell.
 */
export function mergeBusinessAndServicesFields(input: {
  businessFields: readonly PortalFieldMapEntry[];
  servicesFields: readonly PortalFieldMapEntry[];
  /** Wording only: which sources the operator selected. */
  incomeSources?: readonly string[];
}): BusinessServicesMergeResult {
  const incomeSources = input.incomeSources ?? ["business", "services"];
  const names = incomeSources.includes("business")
    ? "Business Profit and Freelancer / Services"
    : "Business and Services";
  const fields: PortalFieldMapEntry[] = [];
  const merged: BusinessServicesMergeResult["merged"] = [];
  const unmapped: BusinessServicesMergeResult["unmapped"] = [];

  // Index the Business side by cell. A duplicated Business row for one cell is
  // already an upstream fault: refuse to fold anything onto it.
  const businessByCell = new Map<string, PortalFieldMapEntry[]>();
  for (const field of input.businessFields) {
    const key = sharedBusinessFieldKey(field);
    const list = businessByCell.get(key);
    if (list) list.push(field);
    else businessByCell.set(key, [field]);
  }

  // Group the Services income by cell, so N invoices of the same head fold once.
  const servicesByCell = new Map<string, PortalFieldMapEntry[]>();
  for (const field of input.servicesFields) {
    if (!isShareableServicesIncome(field)) continue;
    const key = sharedBusinessFieldKey(field);
    const list = servicesByCell.get(key);
    if (list) list.push(field);
    else servicesByCell.set(key, [field]);
  }

  const foldedServicesCells = new Set<string>();
  const unmappedKeys = new Set<string>();

  for (const field of input.businessFields) {
    const key = sharedBusinessFieldKey(field);
    const siblings = businessByCell.get(key) ?? [];
    const servicesHere = servicesByCell.get(key);
    if (!servicesHere) {
      fields.push(field);
      continue;
    }
    if (siblings.length > 1) {
      // Two Business rows claim one IRIS cell AND Services wants it too: the
      // figure stays manual rather than guessing which Business row wins.
      // One gap per cell, whatever the number of Business rows claiming it.
      if (!unmappedKeys.has(`${key}:ambiguous`)) {
        unmappedKeys.add(`${key}:ambiguous`);
        unmapped.push({
          irisCode: String(field.irisCode),
          column: field.column,
          amount: roundPkr(
            servicesHere.reduce((sum, entry) => sum + entry.ourAmount, 0),
          ),
          reason: `${names} both point at IRIS row ${field.irisCode} "${field.column}"; ${siblings.length} Business rows already claim that single cell, so the Services figure was not added to it. Review the Business breakdown and enter the combined figure yourself.`,
        });
      }
      foldedServicesCells.add(key);
      continue;
    }
    const businessRow = siblings[0];
    const servicesAmount = servicesHere.reduce(
      (sum, entry) => sum + entry.ourAmount,
      0,
    );
    const totalAmount = roundPkr(businessRow.ourAmount + servicesAmount);
    const sourceCount =
      (businessRow.sourceEntryCount ?? 1) +
      servicesHere.reduce(
        (sum, entry) => sum + (entry.sourceEntryCount ?? 1),
        0,
      );
    // The Services row keeps its own description and category: the agent's
    // cross-check compares those with the payload, and only the amount of a
    // folded row may differ (by exactly the Business figure).
    fields.push({
      ...businessRow,
      ourCategory: servicesHere[0].ourCategory,
      ourAmount: totalAmount,
      ourDescription: servicesHere[0].ourDescription,
      sourceEntryCount: sourceCount,
      sourceEvidenceReferences: uniqueSorted([
        ...(businessRow.sourceEvidenceReferences ?? []),
        ...servicesHere.flatMap(
          (entry) => entry.sourceEvidenceReferences ?? [],
        ),
      ]),
      servicesMappingKind: "SERVICES_INCOME",
      // The flattened row must still address the SAME IRIS input the Services
      // row would have: a Business entry carries no `rowDescriptionIncludes`
      // (its contract rows only hold `label` / `disabled`) while the Services
      // mapper sets one. Inherit it, or the agent's cross-check cannot match.
      rowDescriptionIncludes:
        servicesHere[0].rowDescriptionIncludes ??
        businessRow.rowDescriptionIncludes,
      portalGroup: servicesHere[0].portalGroup ?? businessRow.portalGroup,
      servicesInvoiceEvidenceIds: evidence(
        [businessRow, ...servicesHere],
        "servicesInvoiceEvidenceIds",
      ),
      servicesPaymentMatchIds: evidence(
        [businessRow, ...servicesHere],
        "servicesPaymentMatchIds",
      ),
      servicesEvidenceDocumentIds: evidence(
        [businessRow, ...servicesHere],
        "servicesEvidenceDocumentIds",
      ),
      servicesSubcategories: evidence(
        [businessRow, ...servicesHere],
        "servicesSubcategories",
      ),
      servicesIncomeCharacter:
        servicesHere.find((entry) => entry.servicesIncomeCharacter)
          ?.servicesIncomeCharacter ?? businessRow.servicesIncomeCharacter,
      servicesSubcategory:
        servicesHere.length === 1
          ? (servicesHere[0].servicesSubcategory ??
            businessRow.servicesSubcategory)
          : undefined,
      servicesStatutorySection:
        servicesHere.find((entry) => entry.servicesStatutorySection)
          ?.servicesStatutorySection ?? businessRow.servicesStatutorySection,
      servicesObservedIrisCode:
        servicesHere.find((entry) => entry.servicesObservedIrisCode)
          ?.servicesObservedIrisCode ?? businessRow.servicesObservedIrisCode,
      servicesHumanReviewConfirmed: servicesHere.every(
        (entry) => entry.servicesHumanReviewConfirmed === true,
      ),
      fbSharedCell: {
        businessAmount: roundPkr(businessRow.ourAmount),
        servicesAmount: roundPkr(servicesAmount),
        businessOurCategory: businessRow.ourCategory,
      },
    } as PortalFieldMapEntry);
    merged.push({
      irisCode: String(field.irisCode),
      column: field.column,
      businessAmount: roundPkr(businessRow.ourAmount),
      servicesAmount: roundPkr(servicesAmount),
      totalAmount,
      businessOurCategory: businessRow.ourCategory,
      servicesOurCategory: servicesHere[0].ourCategory,
    });
    foldedServicesCells.add(key);
  }

  // Services rows that never met a Business row travel as their own row; the
  // 154A "Subject to Final Tax" row is in that group by design.
  for (const field of input.servicesFields) {
    if (isShareableServicesIncome(field)) {
      if (foldedServicesCells.has(sharedBusinessFieldKey(field))) continue;
      fields.push(field);
      continue;
    }
    fields.push(field);
  }

  // Invariant: one row per IRIS cell. A violation would be a double write, so
  // it is reported through `unmapped` and the figure is dropped from the grid.
  const seen = new Map<string, number>();
  for (const field of fields) {
    const key = sharedBusinessFieldKey(field);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1);
  if (duplicated.length) {
    const keep: PortalFieldMapEntry[] = [];
    const taken = new Set<string>();
    for (const field of fields) {
      const key = sharedBusinessFieldKey(field);
      if ((seen.get(key) ?? 0) > 1) {
        if (taken.has(key)) continue;
        taken.add(key);
      }
      keep.push(field);
    }
    for (const [key, count] of duplicated) {
      if (unmappedKeys.has(`${key}:collision`)) continue;
      unmappedKeys.add(`${key}:collision`);
      unmapped.push({
        irisCode: key.split(":")[2] ?? "",
        column: (key.split(":")[3] ?? "Total Amount") as PortalFieldMapEntry["column"],
        amount: 0,
        reason: `IRIS cell ${key} had ${count} approved rows at once. Only one may be typed; the figure is left for manual review. Regenerate the packet.`,
      });
    }
    return { fields: keep, merged, unmapped, combined: merged.length > 0 };
  }

  return {
    fields,
    merged,
    unmapped,
    combined: merged.length > 0,
  };
}
