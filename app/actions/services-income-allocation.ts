"use server";

import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isSingleFreelancerServicesFiling } from "@/lib/tax/business-bank-categories";
import { getTy2026SubcategoryOptions } from "@/lib/tax/rules/ty2026/subcategories";
import {
  SERVICES_LEDGER_ALLOCATION_ORIGIN,
  isServicesLedgerCategory,
} from "@/lib/tax/services-income-allocation";
import { sumMoney } from "@/lib/money";

export type ServicesIncomeAllocationInput = Readonly<{
  ledgerEntryId: string;
  subcategory: string;
}>;

function invalid(message: string) {
  return { success: false as const, error: message };
}

export async function saveServicesIncomeAllocationsAction(
  draftId: string,
  assignments: readonly ServicesIncomeAllocationInput[],
) {
  try {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    if (!email) return invalid("Unauthorized");

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) return invalid("User profile not found");

    return await prisma.$transaction(async (tx) => {
      const draft = await tx.filingDraft.findFirst({
        where: { id: draftId, userId: user.id },
        select: {
          id: true,
          userId: true,
          taxYear: true,
          filerType: true,
          incomeSources: true,
          incomeSelections: {
            where: { source: "services", status: "SELECTED" },
            select: { subcategory: true },
          },
        },
      });
      if (!draft) return invalid("Filing draft not found");
      if (!isSingleFreelancerServicesFiling(draft)) {
        return invalid(
          "Receipt allocation currently supports a TY2026 Myself filing whose only income source is Freelancer / Services.",
        );
      }

      const selectedSubcategories = Array.from(
        new Set(draft.incomeSelections.map((selection) => selection.subcategory)),
      );
      if (selectedSubcategories.length < 2) {
        return invalid(
          "Receipt allocations are only needed when multiple Services categories are selected.",
        );
      }

      const validSubcategories = new Set(
        getTy2026SubcategoryOptions("services").map(
          (option) => option.subcategory,
        ),
      );
      if (selectedSubcategories.some((subcategory) => !validSubcategories.has(subcategory))) {
        return invalid(
          "A selected Services category is not a valid TY2026 category. Review the filing setup.",
        );
      }

      const ledgerEntries = await tx.ledgerEntry.findMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          entryType: "INCOME",
        },
        select: {
          id: true,
          category: true,
          amount: true,
          description: true,
        },
      });
      const serviceEntries = ledgerEntries.filter((entry) =>
        isServicesLedgerCategory(entry.category),
      );
      if (serviceEntries.length === 0) {
        return invalid(
          "There are no approved Services ledger receipts to allocate. Review and approve the relevant receipts first.",
        );
      }

      if (!Array.isArray(assignments) || assignments.length !== serviceEntries.length) {
        return invalid(
          "Assign every current Services ledger receipt exactly once before saving.",
        );
      }

      const serviceEntryIds = new Set(serviceEntries.map((entry) => entry.id));
      const assignedIds = new Set<string>();
      const subcategoriesUsed = new Set<string>();
      const assignmentByEntryId = new Map<string, string>();
      for (const assignment of assignments) {
        const ledgerEntryId = String(assignment?.ledgerEntryId ?? "").trim();
        const subcategory = String(assignment?.subcategory ?? "").trim();
        if (!ledgerEntryId || !serviceEntryIds.has(ledgerEntryId)) {
          return invalid(
            "A receipt no longer matches this filing's Services ledger. Refresh and review the current entries.",
          );
        }
        if (assignedIds.has(ledgerEntryId)) {
          return invalid("Each Services receipt can be assigned only once.");
        }
        if (!selectedSubcategories.includes(subcategory)) {
          return invalid(
            "Choose one of the Services categories selected for this filing.",
          );
        }
        assignedIds.add(ledgerEntryId);
        subcategoriesUsed.add(subcategory);
        assignmentByEntryId.set(ledgerEntryId, subcategory);
      }

      if (assignedIds.size !== serviceEntries.length) {
        return invalid(
          "Assign every current Services ledger receipt exactly once before saving.",
        );
      }
      const uncoveredCategories = selectedSubcategories.filter(
        (subcategory) => !subcategoriesUsed.has(subcategory),
      );
      if (uncoveredCategories.length > 0) {
        return invalid(
          `Assign at least one receipt to every selected Services category. No receipt is assigned to: ${uncoveredCategories.join(", ")}.`,
        );
      }

      await tx.filingIncomeRecord.deleteMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          source: "services",
          origin: SERVICES_LEDGER_ALLOCATION_ORIGIN,
        },
      });
      await tx.filingIncomeRecord.createMany({
        data: serviceEntries.map((entry) => ({
          filingDraftId: draft.id,
          userId: draft.userId,
          source: "services",
          subcategory: assignmentByEntryId.get(entry.id)!,
          grossAmount: entry.amount,
          currency: "PKR",
          recordStatus: "CONFIRMED",
          origin: SERVICES_LEDGER_ALLOCATION_ORIGIN,
          detailsJson: JSON.stringify({ ledgerEntryId: entry.id }),
        })),
      });

      // Changing category attribution changes the tax calculation but not the
      // bank balance or wealth reconciliation. Revoke downstream artifacts
      // atomically while preserving the confirmed reconciliation.
      await tx.filingDraft.update({
        where: { id: draft.id },
        data: {
          status: "IN_PROGRESS",
          taxableIncome: null,
          taxPayable: null,
          refundDue: null,
          taxCalculationStatus: "NOT_CALCULATED",
          taxRuleSetVersion: null,
          taxCalculationRevision: null,
          packetApprovalConfirmed: false,
          packetApprovalAt: null,
          packetApprovalByUserId: null,
        },
      });
      await tx.filingPacket.updateMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          status: { not: "SUPERSEDED" },
        },
        data: { status: "SUPERSEDED", approvalStatus: "SUPERSEDED" },
      });
      await tx.fbrConnection.updateMany({
        where: { filingDraftId: draft.id, userId: draft.userId },
        data: {
          status: "NOT_STARTED",
          agentId: null,
          message: null,
          errorMessage: null,
          lastHeartbeat: null,
          startedAt: null,
          completedAt: null,
        },
      });

      return {
        success: true as const,
        receiptCount: serviceEntries.length,
        servicesIncome: sumMoney(serviceEntries.map((entry) => entry.amount)),
      };
    });
  } catch (error) {
    console.error("Error saving Services receipt allocations:", error);
    return invalid("Failed to save Services receipt allocations");
  }
}
