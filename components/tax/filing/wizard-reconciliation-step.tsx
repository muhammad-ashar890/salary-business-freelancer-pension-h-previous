"use client";

import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  PenLine,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  WorkflowKpiCard,
  WorkflowKpiStrip,
} from "@/components/tax/workflow-page-shell";
import { StepHeading } from "@/components/tax/wizard-ui";

export type ReconciliationPreview = {
  accountBalances?: Array<{
    bankName: string | null;
    accountLabel: string;
    openingBalance: number;
    closingBalance: number;
  }>;
  openingWealth: number;
  closingWealth: number;
  totalIncome: number;
  totalExpenses: number;
  /** Net cash moved out of (+) or into (-) the bank; carried by Cash in hand. */
  netCashMovement?: number;
  gap: number;
  /** Approved previous return's closing net assets (IRIS 703002 expectation). */
  previousYearNetAssets?: number | null;
  previousReturnTaxYear?: number | null;
  previousWealthContinuity?: {
    previousReturnTaxYear: number;
    items: Array<{
      code: string;
      description: string;
      previousAmount: number | null;
      currentAmount: number | null;
      status: "carried" | "missing" | "new";
    }>;
    carriedCodes: string[];
    note: string;
  } | null;
};

export type ReconciliationMethod = "auto" | "manual";

type WizardReconciliationStepProps = Readonly<{
  draftId?: string;
  reconciliationMethod: ReconciliationMethod | null;
  reconciliationNote: string;
  reconciliationResolved: {
    method: ReconciliationMethod;
    note?: string;
  } | null;
  reconciliationPreview: ReconciliationPreview | null;
  reconciliationError: string | null;
  saving: boolean;
  onMethodChange: (method: ReconciliationMethod) => void;
  onNoteChange: (note: string) => void;
  onConfirm: () => void;
}>;

export function WizardReconciliationStep({
  draftId,
  reconciliationMethod,
  reconciliationNote,
  reconciliationResolved,
  reconciliationPreview,
  reconciliationError,
  saving,
  onMethodChange,
  onNoteChange,
  onConfirm,
}: WizardReconciliationStepProps) {
  const formatWealth = (value: number | undefined) =>
    value === undefined ? "Not available" : `PKR ${value.toLocaleString()}`;
  const gapLabel = reconciliationPreview
    ? `PKR ${Math.abs(reconciliationPreview.gap).toLocaleString()}`
    : "calculated data";
  const gapIsResolved =
    reconciliationPreview !== null && reconciliationPreview.gap === 0;
  const noAdjustmentRequired =
    reconciliationResolved?.method === "auto" &&
    reconciliationResolved.note?.startsWith(
      "No Other reconciliation adjustment",
    );

  return (
    <div className="space-y-6">
      <StepHeading
        title="Wealth reconciliation (Mizan)"
        description="There's a gap between your opening and closing wealth statements — let's resolve it before moving on."
      />

      {reconciliationError && (
        <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
          {reconciliationError}
        </div>
      )}

      <WorkflowKpiStrip maxColumns={2}>
        <WorkflowKpiCard
          label="Opening wealth"
          value={formatWealth(reconciliationPreview?.openingWealth)}
          accent="mizan"
        />
        <WorkflowKpiCard
          label="Closing wealth"
          value={formatWealth(reconciliationPreview?.closingWealth)}
          accent="mizan"
        />
        <WorkflowKpiCard
          label="Unexplained gap"
          value={
            reconciliationPreview
              ? `PKR ${Math.abs(reconciliationPreview.gap).toLocaleString()}`
              : "Not available"
          }
          accent="risk"
        />
        <WorkflowKpiCard
          label="Status"
          value={reconciliationResolved ? "Resolved" : "Needs attention"}
        />
      </WorkflowKpiStrip>

      {reconciliationPreview?.accountBalances &&
        reconciliationPreview.accountBalances.length > 0 && (
          <div className="rounded-xl border bg-card p-4">
            <p className="mb-3 text-sm font-semibold">
              Account balances included in Mizan
            </p>
            <div className="space-y-2">
              {reconciliationPreview.accountBalances.map((account, index) => (
                <div
                  key={`${account.accountLabel}-${index}`}
                  className="grid gap-2 rounded-lg border bg-muted/20 p-3 text-sm sm:grid-cols-[1.5fr_1fr_1fr]"
                >
                  <span className="font-medium">
                    {account.bankName
                      ? `${account.bankName} — ${account.accountLabel}`
                      : account.accountLabel}
                  </span>
                  <span>Opening: {formatWealth(account.openingBalance)}</span>
                  <span>Closing: {formatWealth(account.closingBalance)}</span>
                </div>
              ))}
              <div className="grid gap-2 border-t pt-3 text-sm font-semibold sm:grid-cols-[1.5fr_1fr_1fr]">
                <span>Combined total</span>
                <span>
                  Opening: {formatWealth(reconciliationPreview.openingWealth)}
                </span>
                <span>
                  Closing: {formatWealth(reconciliationPreview.closingWealth)}
                </span>
              </div>
            </div>
            {reconciliationPreview.netCashMovement ? (
              <p className="mt-3 text-sm text-muted-foreground">
                {reconciliationPreview.netCashMovement > 0
                  ? `Cash you took out of the bank: PKR ${reconciliationPreview.netCashMovement.toLocaleString()}. It is counted as Cash in hand, so it does not create a gap. In IRIS it is added to your Cash in hand figure.`
                  : `Cash you put into the bank: PKR ${Math.abs(reconciliationPreview.netCashMovement).toLocaleString()}. It is counted as Cash in hand, so it does not create a gap. In IRIS it is deducted from your Cash in hand figure.`}
              </p>
            ) : null}
          </div>
        )}

      {reconciliationPreview?.previousYearNetAssets !== null &&
        reconciliationPreview?.previousYearNetAssets !== undefined && (
          <div className="rounded-xl border bg-card p-4">
            <p className="mb-1 text-sm font-semibold">
              Previous year net assets
            </p>
            <p className="text-sm text-muted-foreground">
              {formatWealth(reconciliationPreview.previousYearNetAssets)}
              {reconciliationPreview.previousReturnTaxYear
                ? ` — from your approved Tax Year ${reconciliationPreview.previousReturnTaxYear} return.`
                : " — from your approved previous-year return."}{" "}
              In IRIS this same figure should appear as Net Assets Previous
              Year (703002); if IRIS shows a different amount there, check it
              before submitting. This Mizan only proves your bank balances, so
              the previous-year figure is shown for that IRIS check and does
              not change the gap above.
            </p>
          </div>
        )}

      {reconciliationPreview?.previousWealthContinuity ? (
        <div className="rounded-xl border border-muted bg-muted/30 p-4">
          <p className="text-sm font-medium">
            Wealth continuity — Tax Year{" "}
            {reconciliationPreview.previousWealthContinuity.previousReturnTaxYear}{" "}
            return vs this filing
          </p>
          {reconciliationPreview.previousWealthContinuity.carriedCodes.length > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">
              Declared both years:{" "}
              {reconciliationPreview.previousWealthContinuity.carriedCodes.join(", ")}.
            </p>
          )}
          {reconciliationPreview.previousWealthContinuity.items.some(
            (item) => item.status === "missing",
          ) && (
            <div className="mt-2">
              <p className="text-xs font-semibold">
                Not in this filing&apos;s Wealth Statement
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {reconciliationPreview.previousWealthContinuity.items
                  .filter((item) => item.status === "missing")
                  .map((item) => (
                    <li key={item.code}>
                      {item.description} ({item.code}) —{" "}
                      {formatWealth(item.previousAmount ?? 0)} in the previous
                      return
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {reconciliationPreview.previousWealthContinuity.items.some(
            (item) => item.status === "new",
          ) && (
            <div className="mt-2">
              <p className="text-xs font-semibold">New this filing</p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {reconciliationPreview.previousWealthContinuity.items
                  .filter((item) => item.status === "new")
                  .map((item) => (
                    <li key={item.code}>
                      {item.description} ({item.code}) —{" "}
                      {formatWealth(item.currentAmount ?? 0)}
                    </li>
                  ))}
              </ul>
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {reconciliationPreview.previousWealthContinuity.note}
          </p>
        </div>
      ) : null}

      {reconciliationResolved ? (
        <div className="flex items-start gap-3 rounded-xl border border-amanah/20 bg-amanah/5 p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-amanah" />
          <div>
            <p className="text-sm font-medium text-amanah">
              {noAdjustmentRequired
                ? "Reconciled — no adjustment required"
                : reconciliationResolved.method === "auto"
                  ? "Auto-adjustment recorded"
                  : "Manually acknowledged — gap remains"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {reconciliationResolved.method === "auto"
                ? (reconciliationResolved.note ??
                  "A non-taxable adjustment was recorded in the ledger. In IRIS it is carried by your bank closing balance in the Wealth Statement.")
                : reconciliationResolved.note}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-3 rounded-xl border border-[#B8872F]/30 bg-[#B8872F]/10 p-4">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#8A641F]" />
            <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-[#8A641F]">
                {gapIsResolved
                  ? "Your opening and closing wealth reconcile with no unexplained gap. Confirm to continue."
                  : reconciliationPreview
                    ? `Choose how you'd like to resolve the ${gapLabel} gap.`
                    : "Add bank transactions with balances to calculate the Mizan gap."}
              </p>
              {!reconciliationPreview && draftId && (
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-2"
                >
                  <Link href={`/tax/new?draftId=${draftId}`}>
                    Return to Filing Wizard
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              )}
            </div>
          </div>

          {gapIsResolved ? (
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={onConfirm}
                disabled={saving || !reconciliationPreview}
                className="gap-2"
              >
                <CheckCircle2 className="h-4 w-4" />
                {saving ? "Saving..." : "Confirm Reconciliation"}
              </Button>
            </div>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => onMethodChange("auto")}
                  className={`flex flex-col items-center gap-3 rounded-2xl border-2 p-6 text-center transition-all ${
                    reconciliationMethod === "auto"
                      ? "border-amanah bg-amanah/5 shadow-sm"
                      : "border-border hover:border-amanah/35"
                  }`}
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-amanah/25 bg-amanah/10 text-amanah">
                    <Sparkles className="h-6 w-6" />
                  </span>
                  <div>
                    <p className="font-semibold text-foreground">Auto-adjust</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Record the gap as a non-taxable adjustment and adjust your
                      bank closing balance in IRIS by the same amount.
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => onMethodChange("manual")}
                  className={`flex flex-col items-center gap-3 rounded-2xl border-2 p-6 text-center transition-all ${
                    reconciliationMethod === "manual"
                      ? "border-amanah bg-amanah/5 shadow-sm"
                      : "border-border hover:border-amanah/35"
                  }`}
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted/40 text-muted-foreground">
                    <PenLine className="h-6 w-6" />
                  </span>
                  <div>
                    <p className="font-semibold text-foreground">
                      Resolve manually
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Explain the source of the gap yourself.
                    </p>
                  </div>
                </button>
              </div>

              {reconciliationMethod === "manual" && (
                <textarea
                  value={reconciliationNote}
                  onChange={(event) => onNoteChange(event.target.value)}
                  rows={3}
                  placeholder="Explain the gap..."
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                />
              )}

              {reconciliationMethod && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    onClick={onConfirm}
                    disabled={
                      saving ||
                      !reconciliationPreview ||
                      (reconciliationMethod === "manual" &&
                        reconciliationNote.trim().length === 0)
                    }
                    className="gap-2"
                  >
                    {reconciliationMethod === "auto" ? (
                      <Sparkles className="h-4 w-4" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                    {saving ? "Saving..." : "Confirm Resolution"}
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
