"use server";
/**
 * 28-Oct-2026: the filer / non-filer answer is now asked in the wizard, so it
 * needs its own save and its own gate. Both live here; the rule itself is in
 * lib/tax/filer-status.ts.
 */
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  filerStatusGate,
  normalizeTaxpayerListStatus,
  type TaxpayerListStatus,
} from "@/lib/tax/filer-status";
import { approvedPreviousReturnFromDocuments } from "@/lib/tax/previous-return-fields";

async function owned(draftId: string) {
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
  return draft;
}

/** The taxpayer's own answer, saved as USER_DECLARED; it is never inferred. */
export async function saveTaxpayerListStatusAction(
  draftId: string,
  status: string,
) {
  try {
    const draft = await owned(draftId);
    const normalized = normalizeTaxpayerListStatus(status);
    if (!normalized)
      return { success: false as const, error: "Choose Filer, Filer (late), or Non-filer." };
    await prisma.filingDraft.update({
      where: { id: draft.id },
      data: {
        taxpayerListStatus: normalized satisfies TaxpayerListStatus,
        // The wizard asked; this is not a portal reading.
        taxpayerListStatusSource: "USER_DECLARED",
        taxpayerListStatusCheckedAt: new Date(),
      },
    });
    return { success: true as const, status: normalized };
  } catch {
    return {
      success: false as const,
      error: "Could not save the filer answer. Refresh and sign in again if needed.",
    };
  }
}

/** Read-only: may this filing continue with the answer that is saved? */
export async function getFilerStatusGateAction(draftId: string) {
  try {
    const draft = await owned(draftId);
    const [saved, previousReturns] = await Promise.all([
      prisma.filingDraft.findFirst({
        where: { id: draft.id },
        select: { taxpayerListStatus: true },
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
    const approved = approvedPreviousReturnFromDocuments(
      previousReturns,
      draft.taxYear,
    );
    const gate = filerStatusGate({
      status: normalizeTaxpayerListStatus(saved?.taxpayerListStatus),
      taxYear: draft.taxYear,
      previousReturn: approved ? { taxYear: approved.taxYear } : null,
    });
    return {
      success: true as const,
      status: normalizeTaxpayerListStatus(saved?.taxpayerListStatus),
      ok: gate.ok,
      blockers: gate.blockers,
    };
  } catch {
    return { success: false as const, error: "Could not check the filer answer." };
  }
}
