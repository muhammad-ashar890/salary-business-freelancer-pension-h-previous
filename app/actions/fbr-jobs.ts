"use server";

import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createNotification } from "@/app/actions/notifications";
import { getNextFbrPilotPhase } from "@/lib/tax/fbr-job-resume";
import { JOB_STATUSES, JOB_TYPES } from "@/lib/tax/fbr-desktop";
import { businessOwnershipPacketValidationError } from "@/lib/tax/business-ownership-packet-validation";
import { visibleBusinessPendingLabels } from "@/lib/tax/business-filing";

async function getOwnedDraft(draftId: string) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) throw new Error("Unauthorized");
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!user) throw new Error("User profile not found");
  const draft = await prisma.filingDraft.findFirst({
    where: { id: draftId, userId: user.id },
    select: { id: true, userId: true, taxYear: true },
  });
  if (!draft) throw new Error("Filing draft not found");
  return draft;
}

export async function queueDryRunJobAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);

    const latestPacket = await prisma.filingPacket.findFirst({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: { not: "SUPERSEDED" },
        approvalStatus: "APPROVED",
      },
      orderBy: { version: "desc" },
    });

    if (!latestPacket) {
      return {
        success: false,
        error: "No approved packet. Generate packet first.",
      };
    }

    let ownershipSnapshot: unknown;
    try { ownershipSnapshot = JSON.parse(latestPacket.snapshotJson); } catch { return {success:false,error:"Invalid packet snapshot. Generate a fresh packet."}; }
    const ownershipError = await businessOwnershipPacketValidationError(ownershipSnapshot,draft.id,draft.userId);
    if (ownershipError) return {success:false,error:ownershipError};

    // Check if there's already a running job
    const existingRunning = await prisma.localAgentJob.findFirst({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: {
          in: [
            JOB_STATUSES.CREATED,
            JOB_STATUSES.OFFERED_TO_DEVICE,
            JOB_STATUSES.ACCEPTED_BY_DEVICE,
            JOB_STATUSES.RUNNING,
            JOB_STATUSES.AWAITING_USER_ACTION,
          ],
        },
      },
    });

    if (existingRunning) {
      return {
        success: false,
        error: `Already have a ${existingRunning.jobType} job in ${existingRunning.status} status. Complete or cancel it first.`,
      };
    }

    const job = await prisma.localAgentJob.create({
      data: {
        filingDraftId: draft.id,
        userId: draft.userId,
        jobType: JOB_TYPES.TAX_DRY_RUN,
        status: JOB_STATUSES.CREATED,
        payloadJson: JSON.stringify({
          packetId: latestPacket.id,
          packetVersion: latestPacket.version,
          packetHash: latestPacket.packetHash,
          taxYear: draft.taxYear,
          createdAt: new Date().toISOString(),
          dryRun: true,
          stopAtReviewGate: true,
        }),
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours
      },
    });

    await prisma.fbrConnection.upsert({
      where: { filingDraftId: draft.id },
      update: {
        status: "DRY_RUN_QUEUED",
        message: `Dry run job queued (packet v${latestPacket.version})`,
        lastHeartbeat: new Date(),
      },
      create: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: "DRY_RUN_QUEUED",
        message: `Dry run job queued (packet v${latestPacket.version})`,
        startedAt: new Date(),
      },
    });

    await prisma.taxAuditEvent.create({
      data: {
        userId: draft.userId,
        filingDraftId: draft.id,
        jobId: job.id,
        eventType: "DRY_RUN_QUEUED",
        eventDataJson: JSON.stringify({ packetVersion: latestPacket.version }),
      },
    });

    await createNotification({
      userId: draft.userId,
      type: "FBR_STATUS",
      title: "Dry run queued",
      message: `Dry run for TY${draft.taxYear} packet v${latestPacket.version} is queued. Open Desktop Agent to run it.`,
      link: `/tax/fbr-connect?draftId=${draft.id}`,
    });

    return {
      success: true,
      job: { id: job.id, jobType: job.jobType, status: job.status },
    };
  } catch (error) {
    console.error("Error queueing dry run:", error);
    return { success: false, error: "Failed to queue dry run job" };
  }
}

export async function queueAssistedFilingJobAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);

    const latestPacket = await prisma.filingPacket.findFirst({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: { not: "SUPERSEDED" },
        approvalStatus: "APPROVED",
      },
      orderBy: { version: "desc" },
    });

    if (!latestPacket) {
      return {
        success: false,
        error: "No approved packet. Generate packet first.",
      };
    }

    let ownershipSnapshot: unknown;
    try { ownershipSnapshot = JSON.parse(latestPacket.snapshotJson); } catch { return {success:false,error:"Invalid packet snapshot. Generate a fresh packet."}; }
    const ownershipError = await businessOwnershipPacketValidationError(ownershipSnapshot,draft.id,draft.userId);
    if (ownershipError) return {success:false,error:ownershipError};

    // Check for existing running job
    const existingRunning = await prisma.localAgentJob.findFirst({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: {
          in: [
            JOB_STATUSES.CREATED,
            JOB_STATUSES.OFFERED_TO_DEVICE,
            JOB_STATUSES.ACCEPTED_BY_DEVICE,
            JOB_STATUSES.RUNNING,
            JOB_STATUSES.AWAITING_USER_ACTION,
          ],
        },
      },
    });

    if (existingRunning) {
      return {
        success: false,
        error: `Already have a ${existingRunning.jobType} job in ${existingRunning.status} status.`,
      };
    }

    // Dry-run prerequisite removed per client decision (2026-09-05): the
    // pilot moves to real FBR IRIS testing, so assisted filing no longer
    // requires a completed tax_dry_run job first. Field validation now
    // happens live against the portal during the supervised run.

    const job = await prisma.localAgentJob.create({
      data: {
        filingDraftId: draft.id,
        userId: draft.userId,
        jobType: JOB_TYPES.TAX_ASSISTED_FILING,
        status: JOB_STATUSES.CREATED,
        payloadJson: JSON.stringify({
          packetId: latestPacket.id,
          packetVersion: latestPacket.version,
          packetHash: latestPacket.packetHash,
          taxYear: draft.taxYear,
          createdAt: new Date().toISOString(),
          dryRun: false,
          requiresHumanConfirmation: true,
          pausePoints: [
            "password_reset",
            "otp_captcha_pin",
            "payment_psid",
            "final_submit_confirmation",
          ],
          livePilotState: {
            phase: "start",
            confirmations: [],
          },
        }),
        expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000), // 4 hours
      },
    });

    await prisma.fbrConnection.upsert({
      where: { filingDraftId: draft.id },
      update: {
        status: "FILING_QUEUED",
        message: `Assisted filing job queued (packet v${latestPacket.version})`,
        lastHeartbeat: new Date(),
      },
      create: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: "FILING_QUEUED",
        message: `Assisted filing job queued (packet v${latestPacket.version})`,
        startedAt: new Date(),
      },
    });

    await prisma.taxAuditEvent.create({
      data: {
        userId: draft.userId,
        filingDraftId: draft.id,
        jobId: job.id,
        eventType: "ASSISTED_FILING_QUEUED",
        eventDataJson: JSON.stringify({ packetVersion: latestPacket.version }),
      },
    });

    await createNotification({
      userId: draft.userId,
      type: "FBR_STATUS",
      title: "Assisted filing queued",
      message: `Assisted filing for TY${draft.taxYear} is queued. Agent will pause for OTP/PIN/Final Review.`,
      link: `/tax/fbr-connect?draftId=${draft.id}`,
    });

    return {
      success: true,
      job: { id: job.id, jobType: job.jobType, status: job.status },
    };
  } catch (error) {
    console.error("Error queueing assisted filing:", error);
    return { success: false, error: "Failed to queue assisted filing job" };
  }
}

export type JobAttentionItem = {
  kind: "problem" | "conflict" | "prefill";
  lines: { name: string; amount: string | null }[];
  what: string;
  todo: string;
};
export type JobAttention = {
  done: number;
  total: number;
  /** Figures the agent has not reached yet because it stopped at this item. */
  remaining: number;
  items: JobAttentionItem[];
};

/** Keep only plain strings and numbers from the agent's list (never raw JSON). */
function readJobAttention(value: unknown): JobAttention | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { done?: unknown; total?: unknown; items?: unknown };
  if (!Array.isArray(raw.items)) return null;
  const text = (v: unknown, max = 400) =>
    typeof v === "string" ? v.slice(0, max) : "";
  const items: JobAttentionItem[] = [];
  for (const entry of raw.items.slice(0, 30)) {
    const item = entry as Record<string, unknown>;
    const kind =
      item.kind === "conflict" || item.kind === "prefill"
        ? item.kind
        : "problem";
    const lines = (Array.isArray(item.lines) ? item.lines : [])
      .slice(0, 30)
      .map((line) => {
        const l = line as Record<string, unknown>;
        return {
          name: text(l.name, 200),
          amount: typeof l.amount === "string" ? l.amount.slice(0, 60) : null,
        };
      })
      .filter((line) => line.name);
    if (!lines.length) continue;
    items.push({ kind, lines, what: text(item.what), todo: text(item.todo) });
  }
  if (!items.length) return null;
  return {
    done: Number(raw.done) || 0,
    total: Number(raw.total) || 0,
    remaining: Number((raw as { remaining?: unknown }).remaining) || 0,
    items,
  };
}

// Phase 2 (fix47): only these fields of the agent's IRIS check and Save reach
// the browser, each one type-checked and length-capped.
type HandoffIrisCheckRow = {
  code: string;
  label: string;
  iris: string | null;
  expected: number;
  status: "match" | "differs" | "not_seen";
  proven: boolean;
};
type HandoffIrisCheck =
  | {
      available: true;
      matched: number;
      differs: number;
      notSeen: number;
      rows: HandoffIrisCheckRow[];
      appTaxableIncome: number | null;
      irisTaxableIncome: number | null;
    }
  | { available: false };
// Previous-return Phase 3b: IRIS 703002 vs the approved previous return.
type HandoffPreviousWealthCheck = {
  status: "match" | "differs" | "not_seen";
  expected: number;
  iris: number | null;
  previousReturnTaxYear: number | null;
};
type HandoffSaveState = {
  status: string;
  clicked: boolean;
  at: string | null;
  message: string;
  reason: string;
  routePolicy: "services_save_once" | null;
  afterSave: { complete: boolean; stoppedReason: string | null; match: number; mismatch: number; notSeen: number } | null;
};

const finiteOrNull = (value: unknown) =>
  value !== null && value !== undefined && Number.isFinite(Number(value))
    ? Math.round(Number(value))
    : null;
const count = (value: unknown) =>
  Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;

function readHandoffIrisCheck(raw: unknown): { irisCheck?: HandoffIrisCheck } {
  if (!raw || typeof raw !== "object") return {};
  const check = raw as Record<string, unknown>;
  if (check.available !== true) return { irisCheck: { available: false } };
  const rows = (Array.isArray(check.rows) ? check.rows : [])
    .slice(0, 24)
    .flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      const status = ["match", "differs", "not_seen"].includes(String(row.status))
        ? (String(row.status) as HandoffIrisCheckRow["status"])
        : null;
      if (!status) return [];
      return [
        {
          code: String(row.code ?? "").slice(0, 12),
          label: String(row.label ?? "").slice(0, 90),
          iris: typeof row.iris === "string" ? row.iris.slice(0, 20) : null,
          expected: finiteOrNull(row.expected) ?? 0,
          status,
          proven: row.proven === true,
        },
      ];
    });
  return {
    irisCheck: {
      available: true,
      matched: count(check.matched),
      differs: count(check.differs),
      notSeen: count(check.notSeen),
      rows,
      appTaxableIncome: finiteOrNull(check.appTaxableIncome),
      irisTaxableIncome: finiteOrNull(check.irisTaxableIncome),
    },
  };
}

function readHandoffPreviousWealthCheck(raw: unknown): {
  previousWealthCheck?: HandoffPreviousWealthCheck;
} {
  if (!raw || typeof raw !== "object") return {};
  const check = raw as Record<string, unknown>;
  const status = ["match", "differs", "not_seen"].includes(String(check.status))
    ? (String(check.status) as HandoffPreviousWealthCheck["status"])
    : null;
  const expected = finiteOrNull(check.expected);
  if (!status || expected === null) return {};
  return {
    previousWealthCheck: {
      status,
      expected,
      iris: finiteOrNull(check.iris),
      previousReturnTaxYear: finiteOrNull(check.previousReturnTaxYear),
    },
  };
}

function readHandoffSave(raw: unknown): { save?: HandoffSaveState } {
  if (!raw || typeof raw !== "object") return {};
  const save = raw as Record<string, unknown>;
  const after =
    save.afterSave && typeof save.afterSave === "object"
      ? (save.afterSave as Record<string, unknown>)
      : null;
  return {
    save: {
      status: String(save.status ?? "not_attempted").slice(0, 40),
      clicked: save.clicked === true,
      at: typeof save.at === "string" ? save.at.slice(0, 40) : null,
      message: String(save.message ?? "").slice(0, 200),
      reason: String(save.reason ?? "").slice(0, 200),
      routePolicy: save.routePolicy === "services_save_once" ? "services_save_once" : null,
      afterSave: after
        ? {
            complete: after.complete === true,
            stoppedReason: typeof after.stoppedReason === "string" ? after.stoppedReason.slice(0, 200) : null,
            match: count(after.match),
            mismatch: count(after.mismatch),
            notSeen: count(after.notSeen),
          }
        : null,
    },
  };
}

export async function getLocalAgentJobsAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const jobs = await prisma.localAgentJob.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        jobType: true,
        status: true,
        pauseAction: true,
        pauseMessage: true,
        errorMessage: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        resultJson: true,
      },
    });

    // Only the handoff scope summary is sent to the browser, never the whole
    // agent result.
    const views = jobs.map(({ resultJson, ...job }) => {
      const parsedResult = (() => {
        try {
          return JSON.parse(resultJson || "{}");
        } catch {
          return {};
        }
      })();
      const autofillResult = parsedResult?.autofill || {};
      let handoffScope: {
        route?: { id: string; label: string; incomeSources: string[] };
        businessDetails?: { required: boolean; verified: boolean; readback: { reason: string } | null; afterSaveVerification: { reason: string } | null };
        business?: { preparedFields: number; filledFields: number; route: string; status: string; pendingItems: string[] };
        services?: { preparedFields: number; filledFields: number; skippedFields: number };
        salary: string | null;
        salaryFields?: { total: number; filled: number; skipped: number };
        pension?: string | null;
        pensionFields?: { total: number; filled: number; skipped: number };
        wealthStatement: string | null;
        wealthRows: number;
        employers: string | null;
        propertyPaymentsComputations: string | null;
        manualItems: string[];
        manualUnchecked: string[];
        // Phase 2 (fix47): IRIS's computed totals vs the packet, and the one Save.
        irisCheck?: HandoffIrisCheck;
        previousWealthCheck?: HandoffPreviousWealthCheck;
        wealthReconciliationCheck?: {
          status: "reconciled" | "gap" | "not_seen";
          unreconciled: number | null;
          gapSide: "missing_inflow" | "missing_outflow" | null;
          message: string;
        };
        save?: HandoffSaveState;
      } | null = null;
      let attention: JobAttention | null = null;
      try {
        attention = readJobAttention(parsedResult?.attention);
      } catch {
        attention = null;
      }
      try {
        const scope = parsedResult?.handoffScope;
        if (scope && typeof scope === "object") {
          const salaryRows = Array.isArray(autofillResult?.results)
            ? autofillResult.results.filter((row: any) => ["1009", "64020004"].includes(String(row?.irisCode)))
            : [];
          const hasLegacySalaryRows = ["1009", "64020004"].every((code) =>
            salaryRows.some((row: any) => String(row?.irisCode) === code),
          );
          const inferredSalaryIncluded =
            autofillResult?.salaryIncluded === true || hasLegacySalaryRows;
          const salarySummary = autofillResult?.salarySummary || {};
          const count = (value: unknown) => {
            const number = Number(value);
            return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
          };
          const salaryTotal = count(salarySummary.total) || salaryRows.length;
          const salaryFields =
            scope.salaryFields &&
            typeof scope.salaryFields === "object" &&
            count(scope.salaryFields.total) > 0
              ? scope.salaryFields
              : inferredSalaryIncluded
                ? {
                    total: salaryTotal,
                    filled: Math.min(
                      salaryTotal,
                      count(salarySummary.filled) +
                        count(salarySummary.alreadyCorrect) ||
                        salaryRows.filter((row: any) =>
                          ["filled", "already_correct"].includes(String(row?.status)),
                        ).length,
                    ),
                    skipped: count(salarySummary.skipped),
                  }
                : null;
          handoffScope = {
            ...(scope.route && typeof scope.route === "object" && typeof scope.route.label === "string"
              ? {
                  route: {
                    id: String(scope.route.id || "unscoped").slice(0, 80),
                    label: scope.route.label.slice(0, 120),
                    incomeSources: (Array.isArray(scope.route.incomeSources) ? scope.route.incomeSources : [])
                      .filter((source: unknown) => ["salary", "business", "pension", "services"].includes(String(source)))
                      .map(String)
                      .slice(0, 8),
                  },
                }
              : {}),
            ...(scope.businessDetails?.required === true ? {
              businessDetails: {
                required: true,
                verified: scope.businessDetails.verified === true,
                readback: scope.businessDetails.readback && typeof scope.businessDetails.readback === "object" ? { reason: String(scope.businessDetails.readback.reason || "").slice(0, 200) } : null,
                afterSaveVerification: scope.businessDetails.afterSaveVerification && typeof scope.businessDetails.afterSaveVerification === "object" ? { reason: String(scope.businessDetails.afterSaveVerification.reason || "").slice(0, 200) } : null,
              },
            } : {}),
            ...(scope.business && typeof scope.business === "object" ? {
              business: {
                preparedFields: Number.isFinite(Number(scope.business.preparedFields)) ? Math.max(0, Math.floor(Number(scope.business.preparedFields))) : 0,
                filledFields: Number.isFinite(Number(scope.business.filledFields)) ? Math.max(0, Math.floor(Number(scope.business.filledFields))) : 0,
                route: scope.business.route === "services_tax_deduction" ? "services_tax_deduction" : "business",
                status: ["partial_manual_required", "needs_review", "dry_run_only", "services_entered"].includes(scope.business.status) ? scope.business.status : "needs_review",
                pendingItems: visibleBusinessPendingLabels(
                  (Array.isArray(scope.business.pendingItems) ? scope.business.pendingItems : [])
                    .filter((item: unknown) => typeof item === "string")
                    .slice(0, 40)
                    .map((item: string) => item.slice(0, 400)),
                ),
              },
            } : {}),
            ...(scope.services && typeof scope.services === "object"
              ? {
                  services: {
                    preparedFields: count(scope.services.preparedFields),
                    filledFields: Math.min(count(scope.services.preparedFields), count(scope.services.filledFields)),
                    skippedFields: count(scope.services.skippedFields),
                  },
                }
              : {}),
            salary: typeof scope.salary === "string" ? scope.salary : null,
            ...(salaryFields && count(salaryFields.total) > 0
              ? {
                  salaryFields: {
                    total: count(salaryFields.total),
                    filled: Math.min(count(salaryFields.total), count(salaryFields.filled)),
                    skipped: count(salaryFields.skipped),
                  },
                }
              : {}),
            pension: typeof scope.pension === "string" ? scope.pension : null,
            ...(scope.pensionFields && typeof scope.pensionFields === "object" && count(scope.pensionFields.total) > 0
              ? {
                  pensionFields: {
                    total: count(scope.pensionFields.total),
                    filled: Math.min(count(scope.pensionFields.total), count(scope.pensionFields.filled)),
                    skipped: count(scope.pensionFields.skipped),
                  },
                }
              : {}),
            wealthStatement:
              typeof scope.wealthStatement === "string"
                ? scope.wealthStatement
                : null,
            wealthRows: Number(scope.wealthPreparedRows) || 0,
            employers:
              typeof scope.employers === "string" ? scope.employers : null,
            propertyPaymentsComputations:
              typeof scope.propertyPaymentsComputations === "string"
                ? scope.propertyPaymentsComputations
                : null,
            manualItems: (Array.isArray(scope.manualItems)
              ? scope.manualItems
              : []
            )
              .filter((item: unknown) => typeof item === "string")
              .slice(0, 30)
              .map((item: string) => item.slice(0, 200)),
            manualUnchecked: (Array.isArray(scope.manualUnchecked)
              ? scope.manualUnchecked
              : []
            )
              .filter((item: unknown) => typeof item === "string")
              .slice(0, 30)
              .map((item: string) => item.slice(0, 200)),
            ...readHandoffIrisCheck(scope.irisCheck),
            ...readHandoffPreviousWealthCheck(scope.previousWealthCheck),
            ...(scope.wealthReconciliationCheck && typeof scope.wealthReconciliationCheck === "object"
              ? {
                  wealthReconciliationCheck: {
                    status: ["reconciled", "gap", "not_seen"].includes(String(scope.wealthReconciliationCheck.status))
                      ? scope.wealthReconciliationCheck.status
                      : "not_seen",
                    unreconciled: scope.wealthReconciliationCheck.unreconciled === null || scope.wealthReconciliationCheck.unreconciled === undefined
                      ? null
                      : Number(scope.wealthReconciliationCheck.unreconciled) || 0,
                    gapSide: ["missing_inflow", "missing_outflow"].includes(String(scope.wealthReconciliationCheck.gapSide))
                      ? scope.wealthReconciliationCheck.gapSide
                      : null,
                    message: String(scope.wealthReconciliationCheck.message || "").slice(0, 1200),
                  },
                }
              : {}),
            ...readHandoffSave(scope.save),
          };
        }
      } catch {
        handoffScope = null;
      }
      return { ...job, handoffScope, attention };
    });

    return { success: true, jobs: views };
  } catch (error) {
    console.error("Error fetching jobs:", error);
    return { success: false, error: "Failed to fetch jobs" };
  }
}

export async function cancelJobAction(jobId: string) {
  try {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    if (!email) throw new Error("Unauthorized");
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) throw new Error("User not found");

    const job = await prisma.localAgentJob.findFirst({
      where: { id: jobId, userId: user.id },
    });

    if (!job) {
      return { success: false, error: "Job not found" };
    }

    if (
      [
        JOB_STATUSES.COMPLETED,
        JOB_STATUSES.FAILED,
        JOB_STATUSES.CANCELLED,
      ].includes(job.status as any)
    ) {
      return { success: false, error: `Job already ${job.status}` };
    }

    const updated = await prisma.localAgentJob.update({
      where: { id: jobId },
      data: { status: JOB_STATUSES.CANCELLED, completedAt: new Date() },
    });

    return { success: true, job: { id: updated.id, status: updated.status } };
  } catch (error) {
    console.error("Error cancelling job:", error);
    return { success: false, error: "Failed to cancel job" };
  }
}

export async function resumeJobAfterPauseAction(
  jobId: string,
  resumeData?: any,
) {
  try {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    if (!email) throw new Error("Unauthorized");
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) throw new Error("User not found");

    const job = await prisma.localAgentJob.findFirst({
      where: { id: jobId, userId: user.id },
    });

    if (!job) {
      return { success: false, error: "Job not found" };
    }

    if (job.status !== JOB_STATUSES.AWAITING_USER_ACTION) {
      return {
        success: false,
        error: `Job not awaiting action, current status: ${job.status}`,
      };
    }

    // Parse existing payload to advance pilot phase
    let payload: any = {};
    try {
      payload = JSON.parse(job.payloadJson || "{}");
    } catch {}

    const currentPhase = payload?.livePilotState?.phase || "start";
    const pauseAction = (job.pauseAction || "").toLowerCase();
    const resultJson = (() => {
      try {
        return JSON.parse(job.resultJson || "{}");
      } catch {
        return {};
      }
    })();
    const requiredAction = (
      resultJson.requiredAction ||
      job.pauseAction ||
      ""
    ).toLowerCase();

    // Final-submit gate: the agent pauses here before pressing Submit in
    // IRIS. A generic resume must never cross it — only the explicit gate
    // choice in the web UI carries finalSubmitConfirmed, so a direct action
    // call or a stale Continue button cannot submit the return.
    const awaitingFinalSubmit =
      requiredAction.includes("final_review") ||
      requiredAction.includes("final_submit") ||
      requiredAction.includes("classic_final");
    if (awaitingFinalSubmit && resumeData?.finalSubmitConfirmed !== true) {
      return {
        success: false,
        error:
          "This return is at the final submit gate. Choose Submit to FBR or Not now on the filing screen.",
      };
    }

    // Taxpayer-review pauses need an explicit, recorded confirmation. The UI
    // sends the exact text the user ticked; a direct call without it is refused.
    const needsAcknowledgement =
      requiredAction === "portal_handoff_review" ||
      requiredAction === "portal_employer_review" ||
      requiredAction === "portal_autofill_review";
    const acknowledgementText =
      typeof resumeData?.acknowledgementText === "string"
        ? resumeData.acknowledgementText.slice(0, 1000)
        : "";
    if (
      needsAcknowledgement &&
      (resumeData?.acknowledged !== true || !acknowledgementText)
    ) {
      return {
        success: false,
        error: "Please tick the confirmation box before continuing.",
      };
    }

    const nextPhase = getNextFbrPilotPhase(
      requiredAction || pauseAction,
      currentPhase,
    );

    const existingConfirmations = Array.isArray(
      payload?.livePilotState?.confirmations,
    )
      ? payload.livePilotState.confirmations
      : [];
    const updatedPayload = {
      ...payload,
      livePilotState: {
        phase: nextPhase,
        confirmations: [
          ...existingConfirmations,
          {
            action: requiredAction || pauseAction,
            confirmedAt: new Date().toISOString(),
            confirmedByUserId: user.id,
            ...(needsAcknowledgement
              ? {
                  acknowledgementText,
                  acknowledgedAt:
                    typeof resumeData?.acknowledgedAt === "string"
                      ? resumeData.acknowledgedAt
                      : new Date().toISOString(),
                }
              : {}),
          },
        ],
      },
    };

    const updated = await prisma.localAgentJob.update({
      where: { id: jobId },
      data: {
        status: JOB_STATUSES.OFFERED_TO_DEVICE, // offer again so device picks it up
        payloadJson: JSON.stringify(updatedPayload),
        resumeDataJson: resumeData ? JSON.stringify(resumeData) : null,
        pauseAction: null,
        pauseMessage: null,
        resultJson: null,
        startedAt: null, // reset so it will be picked again
      },
    });

    await prisma.taxAuditEvent.create({
      data: {
        userId: user.id,
        filingDraftId: job.filingDraftId,
        jobId: job.id,
        eventType: "JOB_RESUMED_BY_USER",
        eventDataJson: JSON.stringify({
          previousPause: job.pauseAction,
          nextPhase,
          ...(needsAcknowledgement ? { acknowledgementText } : {}),
        }),
      },
    });

    return { success: true, job: { id: updated.id, status: updated.status } };
  } catch (error) {
    console.error("Error resuming job:", error);
    return { success: false, error: "Failed to resume job" };
  }
}

export async function getTrustedDevicesAction(draftId?: string) {
  try {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    if (!email) throw new Error("Unauthorized");
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) throw new Error("User not found");

    const devices = await prisma.trustedDevice.findMany({
      where: { userId: user.id },
      orderBy: { lastSeenAt: "desc" },
      take: 5,
      select: {
        id: true,
        deviceName: true,
        partitionKey: true,
        status: true,
        localFbrConnectedAt: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });

    return { success: true, devices };
  } catch (error) {
    console.error("Error fetching devices:", error);
    return { success: false, error: "Failed to fetch devices" };
  }
}
