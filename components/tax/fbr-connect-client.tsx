"use client";

import { useEffect, useState } from "react";
import {
  ExternalLink,
  Loader2,
  ShieldCheck,
  Download,
  Play,
  CheckCircle,
  Monitor,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getFbrConnectionAction,
  startFbrConnectionAction,
  type FbrConnectionView,
} from "@/app/actions/fbr";
import {
  queueAssistedFilingJobAction,
  getLocalAgentJobsAction,
  cancelJobAction,
  resumeJobAfterPauseAction,
  getTrustedDevicesAction,
  type JobAttention,
} from "@/app/actions/fbr-jobs";
import { FbrAttentionPanel } from "@/components/tax/fbr-attention-panel";

type Props = Readonly<{
  draftId?: string;
  initialConnection: FbrConnectionView | null;
  onConnectionStatusChange?: (status: string) => void;
  /** Key figures shown on the final submit gate, when known. */
  taxPayable?: number | null;
  refundDue?: number | null;
  packetVersion?: number;
  /** Exact TY2026 Myself packet whose only source is Freelancer / Services. */
  servicesRoute?: boolean;
  /** Filing whose only source is Pension: no employer details ever apply. */
  pensionRoute?: boolean;
  /**
   * The deployment's own consent for entering approved Salary data (server env
   * TAXROCKET_ALLOW_LIVE_FILING). Shown verbatim rather than hidden, because an
   * operator must never discover after the fact that amounts were entered.
   */
  liveFilingEnabled?: boolean;
}>;

type DesktopSession = {
  launchToken: string;
  partitionKey: string;
  deepLink: string;
  localhostUrl: string;
  expiresAt: string;
};

type JobView = {
  id: string;
  jobType: string;
  status: string;
  pauseAction: string | null;
  pauseMessage: string | null;
  errorMessage: string | null;
  /** What the agent could not enter, as a list (review pause only). */
  attention?: JobAttention | null;
  createdAt: string | Date;
  startedAt: string | Date | null;
  completedAt: string | Date | null;
  handoffScope?: {
    businessDetails?: { required: boolean; verified: boolean; readback?: { reason?: string } | null; afterSaveVerification?: { reason?: string } | null };
    business?: {
      preparedFields: number;
      filledFields: number;
      status: string;
      pendingItems: string[];
      route?: string;
    };
    salary: string | null;
    salaryFields?: { total: number; filled: number; skipped: number };
    wealthStatement: string | null;
    wealthRows: number;
    employers: string | null;
    propertyPaymentsComputations: string | null;
    manualItems?: string[];
    /** Items the taxpayer entered that the agent could not read back. */
    manualUnchecked?: string[];
    /** Phase 2 (fix47): IRIS's computed totals against the packet. */
    irisCheck?:
      | {
          available: true;
          matched: number;
          differs: number;
          notSeen: number;
          rows: {
            code: string;
            label: string;
            iris: string | null;
            expected: number;
            status: "match" | "differs" | "not_seen";
            proven: boolean;
          }[];
          appTaxableIncome: number | null;
          irisTaxableIncome: number | null;
        }
      | { available: false };
    /** Previous-return Phase 3b: IRIS 703002 vs the approved previous return. */
    previousWealthCheck?: {
      status: "match" | "differs" | "not_seen";
      expected: number;
      iris: number | null;
      previousReturnTaxYear: number | null;
    };
    /** Phase 2 (fix47): one draft Save, only after every entered field passes post-tab readback. */
    save?: {
      status: string;
      clicked: boolean;
      at: string | null;
      message: string;
      reason: string;
      routePolicy?: string | null;
      afterSave: { complete: boolean; stoppedReason: string | null; match: number; mismatch: number; notSeen: number } | null;
    };
  } | null;
};

type DeviceView = {
  id: string;
  deviceName: string | null;
  partitionKey: string;
  status: string;
  localFbrConnectedAt: string | Date | null;
  lastSeenAt: string | Date | null;
  createdAt: string | Date;
};

type Phase = "connect" | "connecting" | "start" | "working" | "resume" | "done";
type FlowStep = "connect" | "start" | "resume";

const PAUSE_LABELS: Record<string, string> = {
  portal_inspection: "Preparing your FBR return",
  portal_readiness_unverified: "Waiting for FBR to be ready",
  portal_identity_required: "Confirm the taxpayer in the FBR window",
  portal_taxpayer_mismatch: "Taxpayer verification needs attention",
  portal_document_mismatch: "Return details need attention",
  portal_draft_ambiguous: "Select the return you want to file",
  portal_draft_list_incomplete: "Checking your FBR returns",
  portal_new_return_setup: "Complete the FBR return setup",
  portal_sections_inspected: "Return prepared — no submission",
  portal_autofill_off: "Autofill is switched off in the desktop agent",
  portal_section_navigation: "Return preparation needs attention",
  portal_section_capture: "Preparing the current return section",
  portal_autofill_review: "Review fields that could not be placed safely",
  portal_business_retry: "Business grid not ready — retry automatic filing",
  portal_expense_retry: "Personal expenses not ready — retry automatic filing",
  portal_handoff_review: "Review the rest of your return in the FBR window",
  portal_employer_review: "Add your employer in the FBR window",
  portal_identity_changed: "Taxpayer target changed — recheck required",
  portal_job_check_unavailable: "Check your TaxRocket connection",
  portal_fields_verified: "Return opened — Salary details verified",
  portal_fields_unverified: "Review the opened return",
  portal_navigation: "FBR window needs attention",
  portal_unsupported_route: "This return type is not available yet",
  portal_popup: "FBR window needs attention",
  portal_economic_transactions_gate:
    "Confirm income and residency in the FBR window",
  portal_reconciliation_review: "Resolve the outstanding reconciliation amount",
  session_reconnect: "Complete FBR sign-in",
  selector_bundle_update: "Retry preparing your return",
  password_reset: "Password reset",
  otp_captcha_pin: "OTP / CAPTCHA / PIN",
  otp_required: "OTP",
  captcha_required: "CAPTCHA",
  pin_required: "PIN",
  payment_psid: "PSID payment",
  psid_payment: "PSID payment",
  final_submit_confirmation: "Final review",
  final_review: "Final review",
  portal_state_confirmation:
    "Return payload needs your confirmation before FBR entry",
};

const ACTIVE_JOB_STATUSES = new Set([
  "created",
  "offered_to_device",
  "accepted_by_device",
  "running",
  "awaiting_user_action",
]);

// The desktop worker polls /api/local-agent/jobs/next every ~10s, which
// refreshes TrustedDevice.lastSeenAt. A device only counts as connected
// while that heartbeat is fresh; otherwise closing the agent left the flow
// stuck on "Start filing" with no way back to Step 1 to reconnect.
const AGENT_HEARTBEAT_FRESH_MS = 45_000;
// A just-created session shows a WAITING phase, never an authenticated-ready
// state (session expiry is creation time + 10 minutes).
const SESSION_GRACE_MS = 2 * 60_000;
const SESSION_TTL_MS = 10 * 60_000;

const FLOW_STEPS: ReadonlyArray<{ id: FlowStep; n: string; label: string }> = [
  { id: "connect", n: "1", label: "Connect to FBR" },
  { id: "start", n: "2", label: "Start filing" },
  { id: "resume", n: "3", label: "Review & continue" },
];

const FLOW_ORDER: FlowStep[] = ["connect", "start", "resume"];

function formatWhen(value: string | Date | null | undefined) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function flowStepForPhase(phase: Phase): FlowStep {
  if (phase === "connect" || phase === "connecting") return "connect";
  if (phase === "start" || phase === "working") return "start";
  return "resume";
}

// Pauses where the taxpayer must tick a written confirmation before Continue.
// The exact wording is stored with the confirmation (audit trail).
const ACKNOWLEDGEMENT_TEXT: Record<string, string> = {
  portal_handoff_review:
    "I confirm that I have personally reviewed Personal Assets / Liabilities (including every property), the Payment tab and Computations in the FBR window, that the information there is complete and correct, and that I am responsible for it.",
  portal_employer_review:
    "I confirm that I have added my employer(s) in the FBR window and that the employer details are correct.",
  portal_autofill_review:
    "I confirm that I have dealt with the items listed above in the FBR window myself (entered them). I understand that the agent only reads them back where it can, and that I am responsible for them.",
};

function isFinalSubmitPause(pauseAction: string | null) {
  const action = (pauseAction || "").toLowerCase();
  return (
    action.includes("final_submit") ||
    action.includes("final_review") ||
    action.includes("classic_final")
  );
}

function chipClass(isDone: boolean, isCurrent: boolean) {
  if (isDone) return "border-green-200 bg-green-50 text-green-800";
  if (isCurrent) return "border-amanah/30 bg-amanah/5 text-foreground";
  return "text-muted-foreground";
}

export default function FbrConnectClient({
  draftId,
  initialConnection,
  onConnectionStatusChange,
  taxPayable,
  refundDue,
  packetVersion,
  servicesRoute = false,
  pensionRoute = false,
  liveFilingEnabled = false,
}: Props) {
  const [connection, setConnection] = useState(initialConnection);
  const [session, setSession] = useState<DesktopSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [startOver, setStartOver] = useState(false);
  const [installedAck, setInstalledAck] = useState(false);
  const [submitGateOpen, setSubmitGateOpen] = useState(true);
  // Keyed by job AND pause kind: ticking the box at the employer pause must not
  // pre-tick it at the later review pause of the same job.
  const [ackedKey, setAckedKey] = useState<string | null>(null);

  useEffect(() => {
    setConnection(initialConnection);
  }, [initialConnection]);

  useEffect(() => {
    onConnectionStatusChange?.(connection?.status ?? "NOT_STARTED");
  }, [connection?.status, onConnectionStatusChange]);

  useEffect(() => {
    if (!draftId) return;
    let cancelled = false;

    const tick = async () => {
      const [conn, jobResult, deviceResult] = await Promise.all([
        getFbrConnectionAction(draftId),
        getLocalAgentJobsAction(draftId),
        getTrustedDevicesAction(draftId),
      ]);
      if (cancelled) return;
      if (conn.success) setConnection(conn.connection);
      if (jobResult.success && jobResult.jobs) {
        setJobs(jobResult.jobs as JobView[]);
      }
      if (deviceResult.success && deviceResult.devices) {
        setDevices(deviceResult.devices as DeviceView[]);
      }
    };

    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [draftId]);

  async function refreshJobs() {
    if (!draftId) return;
    const result = await getLocalAgentJobsAction(draftId);
    if (result.success && result.jobs) {
      setJobs(result.jobs as JobView[]);
    }
  }

  async function refreshConnection() {
    if (!draftId) return;
    const result = await getFbrConnectionAction(draftId);
    if (result.success) {
      setConnection(result.connection);
    }
  }

  async function refreshDevices() {
    const result = await getTrustedDevicesAction(draftId);
    if (result.success && result.devices) {
      setDevices(result.devices as DeviceView[]);
    }
  }

  async function handleCreateSession() {
    if (!draftId) return;
    setSessionLoading(true);
    setError(null);
    setDevices([]);
    try {
      await startFbrConnectionAction(draftId);
      const res = await fetch("/api/fbr-connect/desktop/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filingDraftId: draftId }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Could not open the FBR connection app");
      } else {
        setSession(data.session);
        // Use ONE transport. The old POST did not meet the bridge's nonce/
        // allowlist contract and also triggered the protocol unconditionally.
        // The installed/dev agent registers this Windows protocol on startup.
        window.location.href = data.session.deepLink;
      }
    } catch {
      setError("Could not open the FBR connection app");
    }
    setSessionLoading(false);
    void refreshDevices();
    void refreshConnection();
  }

  async function handleStartFiling() {
    if (!draftId) return;
    setActionLoading("assisted");
    setError(null);
    const result = await queueAssistedFilingJobAction(draftId);
    setActionLoading(null);
    if (!result.success) {
      setError(result.error || "Could not start filing");
    } else {
      setStartOver(false);
      void refreshJobs();
    }
  }

  async function handleCancelJob(jobId: string) {
    setActionLoading(jobId);
    const result = await cancelJobAction(jobId);
    setActionLoading(null);
    if (!result.success) {
      setError(result.error || "Could not cancel");
    } else {
      void refreshJobs();
    }
  }

  async function handleResumeJob(
    jobId: string,
    finalSubmitConfirmed = false,
    acknowledgementText?: string,
  ) {
    setActionLoading(jobId);
    const result = await resumeJobAfterPauseAction(jobId, {
      resumedAt: new Date().toISOString(),
      confirmedBy: "user",
      ...(acknowledgementText
        ? {
            acknowledged: true,
            acknowledgementText,
            acknowledgedAt: new Date().toISOString(),
          }
        : {}),
      ...(finalSubmitConfirmed ? { finalSubmitConfirmed: true } : {}),
    });
    setActionLoading(null);
    if (!result.success) {
      setError(result.error || "Could not continue");
    } else {
      void refreshJobs();
    }
  }

  const readyDevice = devices
    .filter(
      (d) =>
        d.status === "ACTIVE" &&
        d.localFbrConnectedAt &&
        (!session ||
          (d.partitionKey === session.partitionKey &&
            new Date(d.localFbrConnectedAt).getTime() >=
              new Date(session.expiresAt).getTime() - SESSION_TTL_MS)) &&
        d.lastSeenAt &&
        Date.now() - new Date(d.lastSeenAt).getTime() <
          AGENT_HEARTBEAT_FRESH_MS,
    )
    .sort((a, b) => {
      const at = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
      const bt = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
      return bt - at;
    })[0];
  const sessionFresh =
    Boolean(session) &&
    Date.now() - (new Date(session!.expiresAt).getTime() - SESSION_TTL_MS) <
      SESSION_GRACE_MS;
  const agentReady = Boolean(readyDevice);
  const activeJob = jobs.find((j) => ACTIVE_JOB_STATUSES.has(j.status));
  const completedAgentJob = jobs.find(
    (j) => j.jobType !== "tax_dry_run" && j.status === "completed",
  );

  let phase: Phase = "connect";
  if (activeJob?.status === "awaiting_user_action") phase = "resume";
  else if (activeJob) phase = "working";
  else if (completedAgentJob && agentReady && !startOver) phase = "done";
  else if (agentReady) phase = "start";
  else if (sessionFresh || sessionLoading) phase = "connecting";

  const inspectionPause = Boolean(
    activeJob?.pauseAction &&
    [
      "portal_inspection",
      "portal_popup",
      "portal_economic_transactions_gate",
      "portal_reconciliation_review",
      "selector_bundle_update",
      "session_reconnect",
      "portal_readiness_unverified",
      "portal_identity_required",
      "portal_taxpayer_mismatch",
      "portal_document_mismatch",
      "portal_draft_ambiguous",
      "portal_draft_list_incomplete",
      "portal_new_return_setup",
      "portal_fields_verified",
      "portal_fields_unverified",
      "portal_navigation",
      "portal_unsupported_route",
      "portal_sections_inspected",
      "portal_autofill_off",
      "portal_section_navigation",
      "portal_section_capture",
      "portal_autofill_review",
      "portal_business_retry",
      "portal_expense_retry",
      "portal_identity_changed",
      "portal_job_check_unavailable",
    ].includes(activeJob.pauseAction),
  );
  const automaticRetryPause = ["portal_business_retry", "portal_expense_retry"].includes(
    activeJob?.pauseAction || "",
  );
  const reconciliationPause =
    activeJob?.pauseAction === "portal_reconciliation_review";
  const activeFlowStep = flowStepForPhase(phase);
  const activeIndex = FLOW_ORDER.indexOf(activeFlowStep);

  // A fresh pause (or a fresh job) always reopens the gate: "Not now" must
  // never carry over to a later submit question.
  useEffect(() => {
    setSubmitGateOpen(true);
  }, [activeJob?.id, activeJob?.pauseAction]);

  return (
    <div className="space-y-5">
      <ol className="grid gap-2 text-xs sm:grid-cols-3">
        {FLOW_STEPS.map((step) => {
          const stepIndex = FLOW_ORDER.indexOf(step.id);
          const isDone = phase === "done" || stepIndex < activeIndex;
          const isCurrent = !isDone && step.id === activeFlowStep;
          return (
            <li
              key={step.id}
              className={`rounded-lg border px-3 py-2 ${chipClass(isDone, isCurrent)}`}
            >
              <span className="font-medium">
                {step.n}. {step.label}
              </span>
            </li>
          );
        })}
      </ol>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {phase === "connect" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Monitor className="h-4 w-4" /> Step 1 — Connect to FBR
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              Connect your TaxRocket account to FBR on this computer. Download
              and install the secure TaxRocket Portal Agent, then continue
              below.
            </p>
            <Button asChild size="sm" className="gap-2">
              <a href="/api/downloads/taxrocket-agent/windows">
                <Download className="h-3.5 w-3.5" /> Download for Windows
              </a>
            </Button>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-amanah"
                checked={installedAck}
                onChange={(event) => setInstalledAck(event.target.checked)}
              />
              <span>
                I installed the FBR connection app
                {installedAck ? (
                  <CheckCircle className="ml-1 inline h-3.5 w-3.5 text-green-600" />
                ) : null}
              </span>
            </label>
            <Button
              size="sm"
              disabled={!draftId || !installedAck || sessionLoading}
              onClick={handleCreateSession}
              className="gap-2"
            >
              {sessionLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Monitor className="h-3.5 w-3.5" />
              )}
              Continue to FBR
            </Button>
          </CardContent>
        </Card>
      )}

      {phase === "connecting" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Connect to FBR
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              Sign in to FBR in the window that opened. Keep that window open
              while TaxRocket prepares your filing.
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={sessionLoading}
              onClick={handleCreateSession}
            >
              Reopen FBR connection
            </Button>
          </CardContent>
        </Card>
      )}

      {phase === "start" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4" /> Step 2 — Start your filing
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Your secure FBR connection is ready
              {readyDevice?.deviceName ? ` on ${readyDevice.deviceName}` : ""}.
              Click Start filing to open your approved return in FBR. Complete
              sign-in, OTP, CAPTCHA, or PIN steps yourself in the FBR window.
              TaxRocket pauses whenever it needs you.{" "}
              {servicesRoute
                ? "On the Freelancer / Services route it enters only the approved Business > Other Revenues and Business > Tax Deduction figures, plus queued Wealth rows when Wealth entry is on. Save, Calculate, payment and Submit are not pressed."
                : "When every figure it typed reads back the same, it presses Save once at the end to keep them in your FBR draft; it never submits, calculates or pays."}
            </p>
            {liveFilingEnabled && (
              <div
                role="alert"
                className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
              >
                <span className="font-medium">
                  Your filing is ready for supervised entry.
                </span>{" "}
                {servicesRoute
                  ? "TaxRocket will enter only evidence-backed Services figures in Business > Other Revenues and Business > Tax Deduction. Wealth Statement rows are entered only if the agent's Wealth switch is on. Save, Calculate, payment and Submit are not pressed on this route."
                  : "TaxRocket will enter only the approved Salary and Salary withholding information that can be verified. Wealth Statement rows are entered only if the agent's Wealth switch is on. Property, Payments, and Computations remain outside this test. Nothing is saved or submitted."}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!draftId || !readyDevice || !!actionLoading}
                onClick={handleStartFiling}
                className="gap-2"
              >
                {actionLoading === "assisted" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Start filing
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={sessionLoading}
                onClick={handleCreateSession}
                className="gap-2"
              >
                {sessionLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Monitor className="h-3.5 w-3.5" />
                )}
                Reconnect securely
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              If the FBR window closes or pauses, choose &quot;Reconnect
              securely&quot; to open a fresh connection. Your sensitive OTP,
              CAPTCHA, and PIN stay in the FBR window and are never sent to
              TaxRocket.
            </p>
          </CardContent>
        </Card>
      )}

      {phase === "working" && activeJob && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Filing in progress
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Complete any sign-in, OTP, CAPTCHA, PIN, or payment step in the
              FBR window. TaxRocket will pause when your action is needed. Keep
              the FBR window open and do not start another filing at the same
              time.
            </p>
            <p className="text-xs text-muted-foreground">
              Assisted filing · started {formatWhen(activeJob.createdAt)}
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={actionLoading === activeJob.id}
              onClick={() => handleCancelJob(activeJob.id)}
            >
              Cancel this filing
            </Button>
          </CardContent>
        </Card>
      )}

      {phase === "resume" &&
        activeJob &&
        isFinalSubmitPause(activeJob.pauseAction) &&
        submitGateOpen && (
          <Card data-testid="final-submit-gate" className="border-red-200">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm text-red-800">
                <ShieldCheck className="h-4 w-4" /> Final gate — Submit this
                return to FBR?
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>
                Your return is ready for final review in FBR. Nothing is
                submitted until you explicitly choose to submit it.
              </p>
              {(taxPayable != null ||
                refundDue != null ||
                packetVersion != null) && (
                <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  {packetVersion != null && (
                    <p>Packet version: v{packetVersion}</p>
                  )}
                  {taxPayable != null && (
                    <p>
                      Tax payable (estimate; the amount to pay is the one IRIS
                      shows): PKR {Math.round(taxPayable).toLocaleString()}
                    </p>
                  )}
                  {refundDue != null && (
                    <p>
                      Refund due: PKR {Math.round(refundDue).toLocaleString()}
                    </p>
                  )}
                </div>
              )}
              <p className="text-xs font-medium text-red-800">
                Submitting is final in FBR. Choose only after reviewing the
                figures above.
              </p>
              {activeJob.pauseMessage && (
                <p className="whitespace-pre-line text-muted-foreground">
                  {activeJob.pauseMessage}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  data-testid="final-submit-yes"
                  disabled={actionLoading === activeJob.id}
                  onClick={() => handleResumeJob(activeJob.id, true)}
                  className="gap-2"
                >
                  {actionLoading === activeJob.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCircle className="h-3.5 w-3.5" />
                  )}
                  Yes, submit to FBR
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="final-submit-no"
                  disabled={actionLoading === activeJob.id}
                  onClick={() => setSubmitGateOpen(false)}
                >
                  Not now
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={actionLoading === activeJob.id}
                  onClick={() => handleCancelJob(activeJob.id)}
                >
                  Cancel this filing
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

      {phase === "resume" &&
        activeJob &&
        isFinalSubmitPause(activeJob.pauseAction) &&
        !submitGateOpen && (
          <Card className="border-amber-200">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm text-amber-800">
                <CheckCircle className="h-4 w-4" /> Submission waiting
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                The return is still waiting at the final submit step. Nothing
                has been submitted.
              </p>
              <Button size="sm" onClick={() => setSubmitGateOpen(true)}>
                Review before submission
              </Button>
            </CardContent>
          </Card>
        )}

      {phase === "resume" &&
        activeJob &&
        !isFinalSubmitPause(activeJob.pauseAction) && (
          <Card className="border-amber-200">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm text-amber-800">
                <CheckCircle className="h-4 w-4" /> Step 3 — Review & continue
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {activeJob.pauseAction === "portal_autofill_review" &&
              activeJob.attention ? (
                <>
                  <FbrAttentionPanel attention={activeJob.attention} />
                  <p className="text-xs text-muted-foreground">
                    Enter the item above in the FBR window yourself, tick the
                    box and press Continue. The agent reads it back (it never
                    types over it). If it is in the right place with the right
                    amount it carries on from the next figure; if not, it tells
                    you again.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    {PAUSE_LABELS[activeJob.pauseAction || ""] ??
                      "Action needed in the FBR window"}
                  </p>
                  {activeJob.pauseMessage && (
                    <p className="whitespace-pre-line text-muted-foreground">
                      {activeJob.pauseMessage}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {automaticRetryPause
                      ? "No manual amount entry or confirmation checkbox is required for this retry."
                      : "Waiting for your action in the FBR window."}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {automaticRetryPause
                      ? activeJob.pauseAction === "portal_expense_retry"
                        ? "Close any open pop-up and let IRIS finish loading, then retry. The agent will verify the section, add the supported missing expense row and enter the approved amount automatically when writable."
                        : "Let IRIS finish loading/calculating, then retry. The agent will verify the live grid and enter approved amounts automatically when it is writable."
                      : reconciliationPause
                        ? "Resolve the outstanding amount in TaxRocket, then press Continue here."
                        : inspectionPause
                          ? "Follow the instruction in the FBR window. When you finish, press Continue here."
                          : "Finish that step in the FBR window, then press Continue here."}
                  </p>
                </>
              )}
              {ACKNOWLEDGEMENT_TEXT[activeJob.pauseAction || ""] && (
                <label className="flex cursor-pointer items-start gap-2 rounded-md border border-amber-200 bg-amber-50/60 p-3 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0"
                    checked={
                      ackedKey === `${activeJob.id}:${activeJob.pauseAction}`
                    }
                    onChange={(e) =>
                      setAckedKey(
                        e.target.checked
                          ? `${activeJob.id}:${activeJob.pauseAction}`
                          : null,
                      )
                    }
                  />
                  <span>
                    {ACKNOWLEDGEMENT_TEXT[activeJob.pauseAction || ""]}
                  </span>
                </label>
              )}
              <Button
                size="sm"
                disabled={
                  actionLoading === activeJob.id ||
                  (Boolean(ACKNOWLEDGEMENT_TEXT[activeJob.pauseAction || ""]) &&
                    ackedKey !== `${activeJob.id}:${activeJob.pauseAction}`)
                }
                onClick={() =>
                  handleResumeJob(
                    activeJob.id,
                    false,
                    ACKNOWLEDGEMENT_TEXT[activeJob.pauseAction || ""],
                  )
                }
                className="gap-2"
              >
                {actionLoading === activeJob.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ExternalLink className="h-3.5 w-3.5" />
                )}
                {automaticRetryPause
                  ? "Retry automatic filing"
                  : activeJob.pauseAction === "portal_handoff_review"
                    ? "I have reviewed it in FBR — Continue"
                    : activeJob.pauseAction === "portal_employer_review"
                      ? "I have added the employer in FBR — Continue"
                      : activeJob.pauseAction === "portal_autofill_review"
                        ? "I have entered them in FBR — Continue"
                        : inspectionPause
                          ? "Continue filing"
                          : "Continue"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={actionLoading === activeJob.id}
                onClick={() => handleCancelJob(activeJob.id)}
              >
                Cancel this filing
              </Button>
              {inspectionPause && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={sessionLoading}
                  onClick={handleCreateSession}
                >
                  Reconnect to FBR
                </Button>
              )}
            </CardContent>
          </Card>
        )}

      {phase === "done" && (
        <HandoffCompleteCard
          scope={completedAgentJob?.handoffScope ?? null}
          pensionRoute={pensionRoute}
          finishedAt={
            completedAgentJob
              ? formatWhen(
                  completedAgentJob.completedAt || completedAgentJob.createdAt,
                )
              : null
          }
          onStartOver={() => {
            setStartOver(true);
            setError(null);
          }}
        />
      )}
    </div>
  );
}

type HandoffScope = NonNullable<JobView["handoffScope"]>;

type HandoffRowState = "done" | "attention" | "review";

function HandoffRow({
  title,
  detail,
  state,
}: Readonly<{ title: string; detail: string; state: HandoffRowState }>) {
  return (
    <li className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {detail}
        </p>
      </div>
      <span
        className={`mt-0.5 shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
          state === "done"
            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : state === "review"
              ? "border-slate-200 bg-slate-50 text-slate-600"
              : "border-amber-300 bg-amber-50 text-amber-800"
        }`}
      >
        {state === "done"
          ? "Completed"
          : state === "review"
            ? "Review in FBR"
            : "Needs your attention"}
      </span>
    </li>
  );
}

/**
 * What the desktop agent did and what the taxpayer does next. The agent never
 * saves, calculates, pays or submits: the final review and the submission are
 * the taxpayer's, in the FBR window.
 */
function HandoffCompleteCard({
  scope,
  pensionRoute = false,
  finishedAt,
  onStartOver,
}: Readonly<{
  scope: HandoffScope | null;
  pensionRoute?: boolean;
  finishedAt: string | null;
  onStartOver: () => void;
}>) {
  const rows: { title: string; detail: string; state: HandoffRowState }[] = [];

  const manualList = (scope?.manualItems ?? []).join("; ");
  const manualAllChecked = (scope?.manualUnchecked ?? []).length === 0;
  const manualSentence = manualAllChecked
    ? "You entered these in FBR yourself and the agent read them back: they match the approved figures."
    : "You entered these in FBR yourself; the agent could not check some of them.";
  const isServicesRoute =
    scope?.business?.route === "services_tax_deduction" ||
    scope?.save?.routePolicy === "services_save_once";
  const isCombinedSalaryServicesRoute =
    isServicesRoute && Number(scope?.salaryFields?.total || 0) > 0;
  const servicesRouteName = isCombinedSalaryServicesRoute
    ? "Salary + Freelancer / Services"
    : "Freelancer / Services";
  if (scope?.business) {
    const visibleBusinessPending = (scope.business.pendingItems ?? []).filter(
      (item) => {
        const separator = item.indexOf(":");
        if (separator < 0) return true;
        const key = item.slice(0, separator).trim();
        const reason = item.slice(separator + 1);
        if (key === "businessFinalReview" || key === "servicesFinalReview") return false;
        if (
          key === "businessScheduleReview" &&
          !/still needs explicit direct-expense heads/i.test(reason)
        )
          return false;
        return true;
      },
    );
    rows.push(
        isServicesRoute
        ? {
            title: `${servicesRouteName} — verified field entry`,
            detail: `${isCombinedSalaryServicesRoute ? `${scope.salaryFields?.filled}/${scope.salaryFields?.total} Salary fields + ` : ""}${scope.business.filledFields}/${scope.business.preparedFields} approved Services fields verified in ${isCombinedSalaryServicesRoute ? "Employment and " : ""}Business > Other Revenues / Tax Deduction. Only evidence-backed income and withholding are automated.`,
            state:
              scope.business.status === "dry_run_only" ||
              scope.business.status === "needs_review" ||
              (isCombinedSalaryServicesRoute && Number(scope.salaryFields?.skipped || 0) > 0)
                ? "attention"
                : "done",
          }
        : {
            title: "Business — numeric field entry",
            detail: `${scope.business.filledFields}/${scope.business.preparedFields} queued business fields entered by the agent; each one was read back from FBR before it counted.`,
            state:
              scope.business.status === "dry_run_only" ||
              scope.business.status === "needs_review"
                ? "attention"
                : "done",
          },
    );
    if (!isServicesRoute && scope.businessDetails?.required) {
      rows.push({
        title: "Business identity and principal activity",
        detail: scope.businessDetails.verified
          ? "Business name, principal activity, brands and dates match the saved Business Details row."
          : `Business Details is not verified (${scope.businessDetails.afterSaveVerification?.reason || scope.businessDetails.readback?.reason || "not reached"}). Numeric-field completion does not complete this entry.`,
        state: scope.businessDetails.verified ? "done" : "attention",
      });
    }
    if (visibleBusinessPending.length > 0) {
      rows.push({
        title: isServicesRoute
          ? "Services — missing source evidence / remaining inputs"
          : "Business — items to review",
        detail: visibleBusinessPending.join(" "),
        state: "attention",
      });
    }
  }
  if (scope?.previousWealthCheck) {
    const pw = scope.previousWealthCheck;
    const pkr = (value: number) => `PKR ${value.toLocaleString()}`;
    const sourceYear = pw.previousReturnTaxYear
      ? `Tax Year ${pw.previousReturnTaxYear}`
      : "previous-year";
    rows.push(
      pw.status === "match"
        ? {
            title: "Previous year net assets (703002)",
            detail: `IRIS shows Net Assets Previous Year of ${pkr(pw.iris ?? pw.expected)}, the same as your approved ${sourceYear} return's closing net assets. The agent did not change it.`,
            state: "done",
          }
        : pw.status === "not_seen"
          ? {
              title: "Previous year net assets (703002)",
              detail: `The agent could not see IRIS row 703002 on its final tour. Your approved ${sourceYear} return closed at ${pkr(pw.expected)} — compare it yourself in FBR before submitting.`,
              state: "review",
            }
          : {
              title: "Previous year net assets (703002) — differs in IRIS",
              detail: `IRIS shows Net Assets Previous Year of ${pw.iris === null ? "blank" : pkr(pw.iris)}, but your approved ${sourceYear} return closed at ${pkr(pw.expected)}. The agent left IRIS exactly as it is — check this in FBR before submitting.`,
              state: "attention",
            },
    );
  }
  const save = scope?.save;
  const savedByAgent = Boolean(
    save &&
      save.clicked &&
      ["saved_confirmed", "saved_no_message", "saved_message_unclassified"].includes(save.status),
  );
  const saveReadbackVerified = Boolean(
    savedByAgent &&
      save?.afterSave?.complete === true &&
      save.afterSave.mismatch === 0 &&
      save.afterSave.notSeen === 0,
  );
  if (save) {
    const at = save.at ? ` at ${new Date(save.at).toLocaleTimeString()}` : "";
    const saveTitle =
      save.status === "saved_confirmed"
        ? "Saved in your FBR draft"
        : savedByAgent
          ? "Draft Save pressed — verify in FBR"
          : "Draft Save not completed";
    const readback = save.afterSave
      ? save.afterSave.complete
        ? ` Re-read after Save: ${save.afterSave.match} match, ${save.afterSave.mismatch} differ, ${save.afterSave.notSeen} not seen.`
        : ` Re-read after Save could not be completed (${save.afterSave.stoppedReason || "not confirmed"}).`
      : "";
    rows.push(
      save.clicked && save.status === "saved_confirmed"
        ? {
            title: saveTitle,
            detail: `The agent pressed Save once${at}. FBR said: "${save.message}".${readback}`,
            state:
              save.afterSave &&
              (!save.afterSave.complete || save.afterSave.mismatch > 0 || save.afterSave.notSeen > 0)
                ? "attention"
                : "done",
          }
        : savedByAgent
          ? {
              title: saveTitle,
              detail: `The agent pressed Save once${at}. FBR ${save.message ? `said: "${save.message}"` : "showed no message"}. Check that the return is listed under Draft in FBR.${readback}`,
              state: "review",
            }
          : save.clicked
            ? {
                title: saveTitle,
                detail: `The agent pressed Save, but FBR answered: "${save.message || save.status}". Press Save yourself once that is resolved.`,
                state: "attention",
              }
            : {
                title: saveTitle,
                detail: `Not saved by the agent (${save.reason || "not attempted"}). Press Save in FBR to keep the figures.`,
                state: "attention",
              },
    );
  }
  if (!isServicesRoute && (!scope?.business || scope.salary !== "not_entered")) {
    rows.push(
      scope?.salary === "confirmed_by_taxpayer"
        ? {
            title: "Salary income and withholding",
            detail: manualAllChecked
              ? "Entered by you in FBR. The agent read it back and it matches the approved figure."
              : "Entered by you in FBR. You confirmed this; the agent could not check it.",
            state: "done",
          }
        : scope?.salary === "filled"
          ? {
              title: "Salary income and withholding",
              detail:
                "Salary income and tax deducted under section 149 were entered and read back from the FBR draft.",
              state: "done",
            }
          : {
              title: "Salary income and withholding",
              detail:
                "Some salary amounts could not be confirmed in the FBR draft. Open Employment in FBR and check Salary and Tax Deductions.",
              state: "attention",
            },
    );

    // Pension packets never carry employer names, so on a pension filing the
    // "none" employer state is the expected outcome, not an attention item;
    // a named outcome (added / confirmed / needs review) still gets its row.
    const employerOutcomeKnown = [
      "confirmed_by_taxpayer",
      "listed",
      "needs_review",
    ].includes(scope?.employers ?? "");
    if (!pensionRoute || employerOutcomeKnown) {
      rows.push(
        scope?.employers === "confirmed_by_taxpayer"
          ? {
              title: "Employer details",
              detail:
                "Added by you in FBR. You confirmed this; the agent did not check it.",
              state: "done",
            }
          : scope?.employers === "listed"
            ? {
                title: "Employer details",
                detail:
                  "Added by the agent by registered name; FBR filled in the registration number.",
                state: "done",
              }
            : scope?.employers === "needs_review"
              ? {
                  title: "Employer details",
                  detail:
                    "An employer could not be added safely. Check Employment, Salary, Employer Details in FBR.",
                  state: "attention",
                }
              : {
                  title: "Employer details",
                  detail:
                    "No employer was added by this run. If FBR asks for employer details, add them under Employment, Salary, Add Employer Details.",
                  state: "attention",
                },
      );
    }
  }

  rows.push(
    scope?.wealthStatement === "confirmed_by_taxpayer"
      ? {
          title: "Wealth Statement",
          detail: isServicesRoute
            ? `Some rows were entered by the agent. ${manualSentence}${manualList ? ` (${manualList})` : ""}`
            : `Some rows were entered by the agent. ${manualSentence}${manualList ? ` (${manualList})` : ""} Open Reconciliation of Net Assets in FBR and make sure the unreconciled amount is 0.`,
          state: "done",
        }
      : scope?.wealthStatement === "entered_not_calculated"
        ? {
            title: "Wealth Statement",
            detail: isServicesRoute
              ? `${scope.wealthRows} row(s) entered.`
              : `${scope.wealthRows} row(s) entered: personal expenses, tax paid and bank accounts. Open Reconciliation of Net Assets in FBR and make sure the unreconciled amount is 0.`,
            state: "done",
          }
        : scope?.wealthStatement === "needs_review"
          ? {
              title: "Wealth Statement",
              detail:
                "Some rows could not be entered safely. Review Personal Assets and Reconciliation in FBR.",
              state: "attention",
            }
          : {
              title: "Wealth Statement",
              detail:
                "Not entered by this run. Complete it in FBR and make sure the unreconciled amount is 0.",
              state: "attention",
            },
  );

  // Agent-owned work and remaining taxpayer review are different statuses.
  // A clean entry completes immediately; never fabricate a review confirmation.
  const agentEntryComplete =
    rows.every(
      (row) =>
        row.state === "done" ||
        (saveReadbackVerified && row.title === "Draft Save pressed — verify in FBR"),
    ) && manualAllChecked;

  if (!isServicesRoute) {
    rows.push(
      scope?.propertyPaymentsComputations === "reviewed_by_taxpayer"
        ? {
            title: "Property, Payments and Computations",
            detail:
              "Shown to you by the agent and confirmed by you as reviewed. The agent fills none of them.",
            state: "done",
          }
        : {
            title: "Property, Payments and Computations",
            detail:
              "Review property/assets, payments and computations in FBR before submitting. The agent does not fill or certify these sections.",
            state: "review",
          },
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b bg-muted/30 pb-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <CheckCircle
            className={`h-5 w-5 ${agentEntryComplete ? "text-emerald-600" : "text-amber-600"}`}
            aria-hidden="true"
          />
          {isServicesRoute
            ? agentEntryComplete
              ? `${servicesRouteName} figures entered in FBR.`
              : `${servicesRouteName} data entry finished. Check the items below.`
            : agentEntryComplete
              ? "Return prepared in FBR. Review and submit it yourself."
              : "Data entry finished. Check the items below, then submit it yourself."}
        </CardTitle>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The desktop agent finished entering your approved data
          {finishedAt ? ` at ${finishedAt}` : ""}.{" "}
          {isServicesRoute
            ? savedByAgent
              ? "It pressed the one draft Save only after scoped post-tab verification; Submit, Calculate, Prepare PSID and payment were not pressed."
              : `Draft Save was not pressed (${save?.reason || "post-tab verification was not complete"}); Submit, Calculate, Prepare PSID and payment were not pressed.`
            : savedByAgent
              ? "It pressed Save once in your FBR draft; Submit, Calculate, Prepare PSID and payment were not pressed."
              : "The agent did not press Save in this run; Submit, Calculate, Prepare PSID and payment were not pressed."}{" "}
          {!isServicesRoute &&
            "The final review and the submission are done by you in the FBR window."}
        </p>
      </CardHeader>
      <CardContent className="space-y-5 p-0">
        <div>
          <p className="px-4 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            What was done
          </p>
          <ul className="mt-2 divide-y border-y">
            {rows.map((row) => (
              <HandoffRow key={row.title} {...row} />
            ))}
          </ul>
        </div>

        {!isServicesRoute && (
        <div className="px-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Before you submit in FBR
          </p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              Check every section you filled, and make sure the Reconciliation
              of Net Assets shows an unreconciled amount of 0.
            </li>
            <li>
              Open Computations and confirm the tax figures. Any tax due is paid
              through FBR.
            </li>
            <li>
              When you are satisfied, submit the return yourself in the FBR
              window.
            </li>
          </ol>
        </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/20 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {isServicesRoute
              ? "Keep the FBR window open for your next step."
              : "Keep the FBR window open until you have submitted."}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onStartOver}
          >
            Start another FBR handoff
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
