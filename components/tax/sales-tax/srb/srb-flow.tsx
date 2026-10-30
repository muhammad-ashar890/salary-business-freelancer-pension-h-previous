"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";

import {
  approveSrbReturnAction,
  getSrbFilingAction,
  saveSrbFiguresAction,
  type SrbFilingData,
} from "@/app/actions/sales-tax-srb";
import { WizardShellLayout } from "@/components/tax/filing/wizard-shell-layout";
import { TaxRocketLogo } from "@/components/tax/taxrocket-logo";
import type { StepsRailItem } from "@/components/tax/wizard-ui";
import { Button } from "@/components/ui/button";
import { formatPeriod, getAuthorityName } from "@/lib/sales-tax/profile";
import { formatRupees } from "@/lib/sales-tax/money";
import {
  emptySrbFiguresForm,
  srbFiguresToForm,
  type SrbFiguresForm,
} from "@/lib/sales-tax/srb";
import type { SrbMonthState } from "@/lib/sales-tax/srb/state";

import { formatIsoDate } from "../format";
import { SrbEntriesStep } from "./srb-entries";
import { SrbFiguresStep } from "./srb-figures-step";
import {
  SrbCheckStep,
  SrbReviewStep,
  srbProblemCounts,
} from "./srb-review-steps";

// The same nine steps as the FBR wizard, so the rail looks the same before and
// after "Create return". The first four are the setup steps and stay ticked.
const SETUP_STEPS = [
  "Business details",
  "Authorities",
  "Return month",
  "Review",
] as const;
const LINE_STEPS = [
  "Sales invoices",
  "Purchase invoices",
  "Check problems",
] as const;
const FINAL_STEPS = ["Your figures", "Review return"] as const;
const SALES_STEP = SETUP_STEPS.length;
const PURCHASES_STEP = SALES_STEP + 1;
const CHECK_STEP = SALES_STEP + 2;
const FIGURES_STEP = SETUP_STEPS.length + LINE_STEPS.length;
const APPROVE_STEP = FIGURES_STEP + 1;

function resumeStep(state: SrbMonthState): number {
  if (state.review.approval) return APPROVE_STEP;
  if (state.purchases.length > 0) return CHECK_STEP;
  if (state.sales.length > 0) return PURCHASES_STEP;
  return SALES_STEP;
}

export function SrbFlow({
  data,
  title,
  alreadyStarted = false,
}: {
  data: SrbFilingData;
  title: string;
  alreadyStarted?: boolean;
}) {
  const filingId = data.filing.id;
  const period = {
    year: data.filing.periodYear,
    month: data.filing.periodMonth,
  };
  const [state, setState] = useState<SrbMonthState>(data.state);
  const [step, setStep] = useState(() => resumeStep(data.state));
  const [furthest, setFurthest] = useState(step);
  const [figuresForm, setFiguresForm] = useState<SrbFiguresForm>(() =>
    data.state ? srbFiguresToForm(data.state.figures) : emptySrbFiguresForm(),
  );
  const [reviewed, setReviewed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // A line typed into the open form but not saved yet, and the "I had none" confirmations.
  const [entryDirty, setEntryDirty] = useState(false);
  const [nilConfirmed, setNilConfirmed] = useState({
    SALES: false,
    PURCHASES: false,
  });
  const onEntryDirty = useCallback(
    (dirty: boolean) => setEntryDirty(dirty),
    [],
  );

  const approvedNow = state.review.approval?.current === true;
  const { mustFix, toCheck } = srbProblemCounts(state);
  const dueDates = state.dueDates;

  const allSteps = [...SETUP_STEPS, ...LINE_STEPS, ...FINAL_STEPS];
  const railItems: StepsRailItem[] = allSteps.map((label, index) => ({
    label,
    current: index === step,
    completed: index !== step && index < Math.max(step, furthest),
  }));

  const summaryRows = [
    { label: "Business", value: data.profile.businessName },
    { label: "STRN", value: data.profile.registrationNo },
    { label: "Authority", value: getAuthorityName("SRB") },
    { label: "Return month", value: formatPeriod(period) },
    ...(dueDates
      ? [
          { label: "Annex-C due", value: formatIsoDate(dueDates.annexC) },
          { label: "Payment due", value: formatIsoDate(dueDates.payment) },
          { label: "Return due", value: formatIsoDate(dueDates.returnFiling) },
        ]
      : []),
    { label: "Sales lines", value: String(state.sales.length) },
    { label: "Purchase lines", value: String(state.purchases.length) },
    ...(step >= APPROVE_STEP && state.review.canEstimate
      ? [
          {
            label: "Estimated payable",
            value: formatRupees(state.review.balancePayable ?? 0),
          },
          { label: "Approved", value: approvedNow ? "Yes" : "Not yet" },
        ]
      : []),
  ];

  /** Why the person cannot leave the given step yet, or null when the step is complete. */
  function stepBlock(from: number): string | null {
    if (from === SALES_STEP || from === PURCHASES_STEP) {
      const sales = from === SALES_STEP;
      if (entryDirty) {
        return `You have a ${sales ? "sale" : "purchase"} that is not saved yet. Save it, or press Cancel, before you go on.`;
      }
      const count = sales ? state.sales.length : state.purchases.length;
      if (count === 0 && !nilConfirmed[sales ? "SALES" : "PURCHASES"]) {
        return sales
          ? "Add your sales, or tick the box to confirm that you had none this month."
          : "Add your purchases, or tick the box to confirm that you had none with sales tax this month.";
      }
      return null;
    }
    if (from === CHECK_STEP && mustFix > 0) {
      return `${mustFix} problem${mustFix === 1 ? "" : "s"} still to fix. Go back, correct the lines, and come back here.`;
    }
    return null;
  }

  /** Why a move from the current step to `target` is not allowed, or null. */
  function moveBlock(target: number): string | null {
    if (target === step) return null;
    // Unsaved typing is lost by leaving in any direction.
    if ((step === SALES_STEP || step === PURCHASES_STEP) && entryDirty)
      return stepBlock(step);
    if (target < step) return null;
    for (let from = step; from < target; from += 1) {
      const reason = stepBlock(from);
      if (reason) return reason;
    }
    return null;
  }

  function blockersFor(): string[] {
    if (step === SALES_STEP || step === PURCHASES_STEP) {
      const reason = stepBlock(step);
      return reason ? [reason] : [];
    }
    if (step === CHECK_STEP) {
      if (mustFix > 0)
        return [
          `${mustFix} to fix${toCheck > 0 ? ` and ${toCheck} to check` : ""}. Go back and correct the lines.`,
        ];
      if (toCheck > 0)
        return [
          `${toCheck} reminder${toCheck === 1 ? "" : "s"} to read. Nothing here needs a change.`,
        ];
      return [];
    }
    if (step === FIGURES_STEP)
      return [
        "Fill in what applies to you, then continue to see your worksheet.",
      ];
    if (!state.review.canEstimate)
      return [
        "The worksheet cannot be prepared yet. Read the message on this step.",
      ];
    if (approvedNow) return [];
    return reviewed
      ? []
      : ["Tick the box to confirm that you have reviewed the return."];
  }

  function moveTo(next: number) {
    setStep(next);
    setFurthest((value) => Math.max(value, next));
  }

  async function refresh() {
    setReviewLoading(true);
    try {
      const loaded = await getSrbFilingAction(filingId);
      if (loaded.success) setState(loaded.data.state);
      else setActionError(loaded.error);
    } catch {
      setActionError("Could not prepare your worksheet. Please try again.");
    } finally {
      setReviewLoading(false);
    }
  }

  async function handleSaveFigures() {
    if (submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const saved = await saveSrbFiguresAction(filingId, figuresForm);
      if (saved.success === false) {
        setActionError(saved.error);
        return;
      }
      setState(saved.state);
      setReviewed(false);
      moveTo(APPROVE_STEP);
    } catch {
      setActionError("Could not save your figures. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleApprove() {
    if (submitting || !reviewed) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const approved = await approveSrbReturnAction(filingId, reviewed);
      if (approved.success === false) {
        setActionError(approved.error);
        return;
      }
      setState(approved.state);
      setReviewed(false);
    } catch {
      setActionError("Could not approve this return. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function goNext() {
    setActionError(null);
    if (step === FIGURES_STEP) {
      void handleSaveFigures();
      return;
    }
    const blocked = moveBlock(step + 1);
    if (blocked) {
      setActionError(blocked);
      return;
    }
    moveTo(Math.min(step + 1, APPROVE_STEP));
  }

  function goBack() {
    setActionError(null);
    const blocked = moveBlock(step - 1);
    if (blocked) {
      setActionError(blocked);
      return;
    }
    setStep((value) => Math.max(value - 1, SALES_STEP));
  }

  function renderStep() {
    if (step === SALES_STEP || step === PURCHASES_STEP) {
      const kind = step === SALES_STEP ? "SALES" : "PURCHASES";
      return (
        <SrbEntriesStep
          key={kind}
          stepNumber={step + 1}
          filingId={filingId}
          kind={kind}
          period={period}
          state={state}
          onState={setState}
          onError={setActionError}
          onDirtyChange={onEntryDirty}
          nilConfirmed={nilConfirmed[kind]}
          onNilConfirmedChange={(confirmed) =>
            setNilConfirmed((current) => ({ ...current, [kind]: confirmed }))
          }
        />
      );
    }
    if (step === CHECK_STEP)
      return <SrbCheckStep stepNumber={step + 1} state={state} />;
    if (step === FIGURES_STEP) {
      return (
        <SrbFiguresStep
          stepNumber={step + 1}
          form={figuresForm}
          onChange={setFiguresForm}
          period={period}
        />
      );
    }
    return (
      <SrbReviewStep
        stepNumber={step + 1}
        state={state}
        loading={reviewLoading}
        paymentDue={dueDates?.payment ?? null}
        reviewed={reviewed}
        onReviewed={setReviewed}
      />
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <TaxRocketLogo showWordmark={false} />
          <div>
            <h1 className="text-lg font-semibold text-foreground">{title}</h1>
            <p className="text-xs text-muted-foreground">
              One simple question at a time.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
          >
            <Link href="/tax/sales-tax">All returns</Link>
          </Button>
        </div>
      </div>

      <WizardShellLayout
        showRail
        railItems={railItems}
        summaryRows={summaryRows}
        blockers={blockersFor()}
        onRailItemClick={(index) => {
          setActionError(null);
          // The month and authority are fixed once the return exists.
          if (index < SALES_STEP) return;
          if (index >= FIGURES_STEP && index > furthest) return;
          const blocked = moveBlock(index);
          if (blocked) {
            setActionError(blocked);
            return;
          }
          setStep(index);
          if (index === APPROVE_STEP) void refresh();
        }}
      >
        {alreadyStarted && step < FIGURES_STEP && (
          <p className="mb-6 rounded-lg border border-amanah/20 bg-amanah/5 p-3 text-sm text-foreground">
            You had already started this month, so we opened it instead of
            creating a second one.
          </p>
        )}
        {actionError && (
          <div
            role="alert"
            className="mb-6 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {actionError}
          </div>
        )}

        <div
          key={step}
          className="animate-in fade-in slide-in-from-right-2 duration-300"
        >
          {renderStep()}
        </div>

        <div className="sticky bottom-0 z-10 mt-8 flex items-center justify-between gap-3 border-t border-border bg-background/95 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <Button
            type="button"
            variant="ghost"
            onClick={goBack}
            disabled={step === SALES_STEP || submitting}
            className="gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          {step === APPROVE_STEP ? (
            approvedNow ? (
              <Button asChild variant="outline">
                <Link href="/tax/sales-tax">Back to your returns</Link>
              </Button>
            ) : (
              <Button
                type="button"
                onClick={handleApprove}
                disabled={
                  submitting ||
                  reviewLoading ||
                  !reviewed ||
                  !state.review.canEstimate
                }
                className="gap-2"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Approve return
              </Button>
            )
          ) : (
            <Button
              type="button"
              onClick={goNext}
              disabled={submitting}
              className="gap-2"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {step === FIGURES_STEP ? "See my worksheet" : "Continue"}
              {!submitting && <ArrowRight className="h-4 w-4" />}
            </Button>
          )}
        </div>
      </WizardShellLayout>
    </div>
  );
}
