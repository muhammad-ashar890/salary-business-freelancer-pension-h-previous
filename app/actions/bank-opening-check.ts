"use server";
/**
 * 28-Oct-2026: early warning for money in the bank that last year's wealth
 * statement never declared. It is a read-only check: it never blocks a step and
 * never writes anything.
 */
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toMoneyNumber } from "@/lib/money";
import { approvedPreviousReturnFromDocuments } from "@/lib/tax/previous-return-fields";
import {
  bankOpeningDeclaredCheck,
  previousReturnBankRowTotal,
} from "@/lib/tax/bank-opening-declared";

export async function getBankOpeningDeclaredCheckAction(draftId: string) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) throw new Error("Unauthorized");
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { id: true },
    });
    if (!user) throw new Error("Unauthorized");

    const draft = await prisma.filingDraft.findFirst({
      where: { id: draftId, userId: user.id },
      select: { id: true, userId: true, taxYear: true },
    });
    if (!draft) throw new Error("Filing draft not found");

    const [statements, previousReturns] = await Promise.all([
      prisma.bankStatement.findMany({
        where: { filingDraftId: draft.id, userId: draft.userId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          bankAccountId: true,
          openingBalance: true,
          closingBalance: true,
          createdAt: true,
        },
      }),
      prisma.document.findMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          documentType: "previous_return",
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { documentType: true, extractionStatus: true, extractedData: true },
      }),
    ]);

    // One statement per account: the newest one is the current statement.
    const latestPerAccount = new Map<string, (typeof statements)[number]>();
    for (const statement of statements) {
      const key = statement.bankAccountId ?? "unlinked";
      if (!latestPerAccount.has(key)) latestPerAccount.set(key, statement);
    }
    const openingBalance = Array.from(latestPerAccount.values()).reduce(
      (sum, statement) => sum + toMoneyNumber(statement.openingBalance),
      0,
    );

    const previousReturn = approvedPreviousReturnFromDocuments(
      previousReturns,
      draft.taxYear,
    );
    const bankRowTotal = previousReturnBankRowTotal(previousReturn?.wealthRows ?? null);

    const result = bankOpeningDeclaredCheck({
      openingBalance,
      previousReturnRows: previousReturn?.wealthRows ?? null,
      previousReturnCashInHand: previousReturn?.cashInHand ?? null,
      previousReturnHasBankRow: previousReturn ? bankRowTotal > 0 : false,
    });

    return {
      success: true as const,
      status: result.status,
      warning: result.message,
      openingBalance,
      uncovered: result.uncovered,
    };
  } catch {
    return { success: false as const, error: "Could not check the opening balance." };
  }
}
