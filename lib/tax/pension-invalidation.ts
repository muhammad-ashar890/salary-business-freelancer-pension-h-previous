import type { Prisma } from "@prisma/client";
import {
  TY2026_PENSION_FORMER_EMPLOYER_SUBCATEGORY,
  resolvePensionFormerEmployerAnswer,
  parsePersistedSelectionUserDetails,
  type Ty2026SelectionUserDetails,
} from "./rules/ty2026/subcategories";

export function pensionInputKey(input: {
  taxYear: number;
  incomeSources: readonly string[];
  selections: readonly {
    source: string;
    subcategory: string;
    details?: Ty2026SelectionUserDetails;
    detailsJson?: string | null;
  }[];
}) {
  if (!input.incomeSources.includes("pension")) return "no-pension";
  const s = input.selections.find(
    (s) =>
      s.source === "pension" &&
      s.subcategory === TY2026_PENSION_FORMER_EMPLOYER_SUBCATEGORY,
  );
  const details =
    s?.details ?? parsePersistedSelectionUserDetails(s?.detailsJson);
  const asSalary = s
    ? resolvePensionFormerEmployerAnswer({ details: details ?? undefined }) ===
      "yes"
    : false;
  return JSON.stringify([input.taxYear, "pension", asSalary]);
}

/** Pension-source changes only. Do not change generic ledger/withholding product behavior. */
export async function invalidatePensionCalculation(
  tx: Pick<
    Prisma.TransactionClient,
    "filingDraft" | "filingPacket" | "fbrConnection" | "localAgentJob"
  >,
  filingDraftId: string,
  userId: string,
) {
  await tx.filingDraft.update({
    where: { id: filingDraftId },
    data: {
      status: "IN_PROGRESS",
      taxCalculationStatus: "NOT_CALCULATED",
      taxableIncome: null,
      taxPayable: null,
      refundDue: null,
      taxCalculationRevision: null,
      packetApprovalConfirmed: false,
      packetApprovalAt: null,
      packetApprovalByUserId: null,
    },
  });
  await tx.filingPacket.updateMany({
    where: { filingDraftId, userId, status: { not: "SUPERSEDED" } },
    data: { status: "SUPERSEDED", approvalStatus: "SUPERSEDED" },
  });
  await tx.fbrConnection.updateMany({
    where: { filingDraftId, userId },
    data: {
      status: "NOT_STARTED",
      agentId: null,
      message: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      lastHeartbeat: null,
    },
  });
  await cancelActivePensionJobs(tx, filingDraftId, userId);
}

export async function cancelActivePensionJobs(
  tx: Pick<Prisma.TransactionClient, "localAgentJob">,
  filingDraftId: string,
  userId: string,
) {
  // A worker checks job liveness before portal steps. Superseding a packet alone
  // does not stop a worker that already fetched it.
  await tx.localAgentJob.updateMany({
    where: {
      filingDraftId,
      userId,
      status: {
        in: [
          "created",
          "offered_to_device",
          "accepted_by_device",
          "running",
          "awaiting_user_action",
        ],
      },
    },
    data: { status: "cancelled", completedAt: new Date() },
  });
}

/** A DOB/CNIC update only resets active filings that actually include pension. */
export async function invalidatePensionProfileFilings(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  const drafts = await tx.filingDraft.findMany({
    where: {
      userId,
      status: { not: "FILED" },
      incomeSources: { contains: "pension" },
    },
    select: { id: true, incomeSources: true },
  });
  for (const draft of drafts) {
    let sources: unknown;
    try {
      sources = JSON.parse(draft.incomeSources);
    } catch {
      continue;
    }
    if (Array.isArray(sources) && sources.includes("pension"))
      await invalidatePensionCalculation(tx, draft.id, userId);
  }
}
