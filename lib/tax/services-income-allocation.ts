import { moneyEquals, sumMoney, toMoneyAmount, type MoneyInput } from "@/lib/money";

/** Origin used only for receipt-to-subcategory allocation records. */
export const SERVICES_LEDGER_ALLOCATION_ORIGIN = "LEDGER_ALLOCATION";

export const SERVICES_LEDGER_CATEGORY_ALIASES = [
  "SERVICES",
  "SERVICE",
  "PROFESSIONAL_SERVICES",
  "CONSULTANCY",
] as const;

export type ServicesLedgerEntryForAllocation = Readonly<{
  id: string;
  amount: MoneyInput;
  description: string;
}>;

export type ServicesLedgerAllocationRecord = Readonly<{
  subcategory: string;
  grossAmount: MoneyInput;
  detailsJson: string;
}>;

export type ResolvedServicesAllocation = Readonly<{
  subcategory: string;
  income: number;
}>;

export type ResolveServicesAllocationsResult =
  | Readonly<{
      success: true;
      allocations: ResolvedServicesAllocation[];
      total: number;
    }>
  | Readonly<{ success: false; reason: string }>;

export function isServicesLedgerCategory(category: unknown): boolean {
  const normalized = String(category ?? "")
    .trim()
    .toUpperCase()
    .replaceAll(" ", "_")
    .replaceAll("-", "_");
  return (SERVICES_LEDGER_CATEGORY_ALIASES as readonly string[]).includes(
    normalized,
  );
}

export function parseServicesLedgerEntryId(detailsJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(detailsJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const ledgerEntryId = (parsed as { ledgerEntryId?: unknown }).ledgerEntryId;
    return typeof ledgerEntryId === "string" && ledgerEntryId.trim()
      ? ledgerEntryId.trim()
      : null;
  } catch {
    return null;
  }
}

function formatExactMoney(value: MoneyInput): string {
  const numeric = toMoneyAmount(value);
  return Number.isFinite(numeric)
    ? numeric.toLocaleString("en-PK", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : String(value ?? "0.00");
}

/**
 * Resolves a multi-category Services allocation from persisted receipt links.
 *
 * Every currently approved Services ledger line must occur once, link to a
 * selected TY2026 subcategory, and still match its saved Decimal amount. The
 * final tax base for each subcategory is re-summed from the live ledger lines,
 * never from user-entered aggregate figures.
 */
export function resolveServicesLedgerAllocations(input: {
  ledgerEntries: readonly ServicesLedgerEntryForAllocation[];
  allocationRecords: readonly ServicesLedgerAllocationRecord[];
  selectedSubcategories: readonly string[];
}): ResolveServicesAllocationsResult {
  const { ledgerEntries, allocationRecords } = input;
  const selectedSubcategories = Array.from(new Set(input.selectedSubcategories));

  if (ledgerEntries.length === 0) {
    return {
      success: false,
      reason:
        "Multiple Services categories are selected, but no approved Services ledger receipts are available. Review and approve the receipts before allocating them.",
    };
  }

  if (selectedSubcategories.length < 2) {
    return {
      success: false,
      reason:
        "Receipt-level allocation is only needed when multiple Services subcategories are selected.",
    };
  }

  const ledgerEntryById = new Map<string, ServicesLedgerEntryForAllocation>();
  for (const entry of ledgerEntries) {
    if (!entry.id || ledgerEntryById.has(entry.id)) {
      return {
        success: false,
        reason:
          "Services ledger receipt IDs are missing or duplicated. Review the ledger before calculating.",
      };
    }
    ledgerEntryById.set(entry.id, entry);
  }

  const selected = new Set(selectedSubcategories);
  const assignedEntryIds = new Set<string>();
  const amountsBySubcategory = new Map<string, MoneyInput[]>();

  for (const record of allocationRecords) {
    const ledgerEntryId = parseServicesLedgerEntryId(record.detailsJson);
    if (!ledgerEntryId) {
      return {
        success: false,
        reason:
          "A saved Services allocation is missing its receipt link. Re-open the Review step and save the receipt allocations again.",
      };
    }
    if (assignedEntryIds.has(ledgerEntryId)) {
      return {
        success: false,
        reason:
          "A Services ledger receipt is assigned more than once. Re-open the Review step and save one category for each receipt.",
      };
    }

    const entry = ledgerEntryById.get(ledgerEntryId);
    if (!entry) {
      return {
        success: false,
        reason:
          "A saved Services allocation no longer matches a current Services ledger receipt. Re-open the Review step and save the current receipts.",
      };
    }
    if (!selected.has(record.subcategory)) {
      return {
        success: false,
        reason:
          "A Services receipt is assigned to a category that is no longer selected. Re-open the Review step and update its allocation.",
      };
    }
    if (!moneyEquals(record.grossAmount, entry.amount)) {
      return {
        success: false,
        reason:
          `The saved allocation for “${entry.description || "Services receipt"}” is PKR ${formatExactMoney(record.grossAmount)}, but the current ledger receipt is PKR ${formatExactMoney(entry.amount)}. Re-open the Review step and save the current receipt allocation.`,
      };
    }

    assignedEntryIds.add(ledgerEntryId);
    const amounts = amountsBySubcategory.get(record.subcategory) ?? [];
    amounts.push(entry.amount);
    amountsBySubcategory.set(record.subcategory, amounts);
  }

  if (assignedEntryIds.size !== ledgerEntries.length) {
    const missingCount = ledgerEntries.length - assignedEntryIds.size;
    return {
      success: false,
      reason:
        `${missingCount} approved Services receipt${missingCount === 1 ? " is" : "s are"} not allocated. Assign every receipt to exactly one selected category in the Review step, then save allocations before calculating.`,
    };
  }

  const unrepresented = selectedSubcategories.filter(
    (subcategory) => !(amountsBySubcategory.get(subcategory)?.length),
  );
  if (unrepresented.length > 0) {
    return {
      success: false,
      reason:
        `Assign at least one approved Services receipt to each selected category. No receipt is assigned to: ${unrepresented.join(", ")}. Remove any category that does not apply, or allocate a supporting receipt to it.`,
    };
  }

  const allocations = selectedSubcategories.map((subcategory) => ({
    subcategory,
    income: sumMoney(amountsBySubcategory.get(subcategory) ?? []),
  }));
  const total = sumMoney(ledgerEntries.map((entry) => entry.amount));

  // Every receipt is accounted for once, and the category bases are derived
  // from those same exact Decimal values; no separate manual total is involved.
  return { success: true, allocations, total };
}
