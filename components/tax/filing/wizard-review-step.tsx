"use client";

import { useEffect, useRef } from "react";
import { FileText, Scale, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  WorkflowKpiCard,
  WorkflowKpiStrip,
} from "@/components/tax/workflow-page-shell";
import { StepHeading } from "@/components/tax/wizard-ui";
import { WizardServicesIncomeEvidencePanel } from "@/components/tax/filing/wizard-services-income-evidence-panel";
import type { FilingSummary } from "@/components/tax/filing/config/filing-wizard-config";
import { filerStatusScreenLabel } from "@/lib/tax/filer-status";

const SOURCE_LABELS: Record<string, string> = {
  salary: "Salary",
  pension: "Pension",
  property_rent: "Rental income",
  bank_profit: "Profit on debt",
  services: "Services income",
  other_income: "Other income",
  capital_gains: "Capital gains",
  business: "Business income",
  business_profit: "Business profit",
  dividend: "Dividend",
  foreign_income_assets: "Non-Resident",
  imports: "Imports",
  advance_tax: "Advance tax",
  combined_slab: "Combined slab",
  super_tax: "Super tax (section 4C)",
  minimum_tax: "Minimum tax (section 113)",
};

function sourceLabel(source: string) {
  return SOURCE_LABELS[source] ?? source.replaceAll("_", " ");
}

type WizardReviewStepProps = Readonly<{
  uploadedDocumentCount: number;
  filingSummary: FilingSummary | null;
  filingSummaryError: string | null;
  taxCalculationError: string | null;
  /** Why the latest calculation stopped (NEEDS_RULES / NEEDS_USER_INPUT); null when not known. */
  taxCalculationNote?: string | null;
  withholdingWarning: string | null;
  withholdingConfirmed: boolean;
  onWithholdingConfirmChange: (checked: boolean) => void;
  calculatingTaxFor: "ATL" | "NON_ATL" | "LATE_FILER" | null;
  reconciliationResolved: boolean;
  draftId?: string;
  /**
   * 28-Oct-2026 (operator): the wizard now asks Filer / Non-filer up front, so
   * the estimate must be priced on that answer by itself. The three
   * "Calculate for ATL / Late Filer / Non-ATL" buttons are gone; this is the
   * answer that decides the rates.
   */
  filerStatus?: "ATL" | "NON_ATL" | "LATE_FILER" | null;
  onCalculateTax: (status: "ATL" | "NON_ATL" | "LATE_FILER") => void;
  onServicesEvidenceSaved: () => Promise<void> | void;
}>;

export function WizardReviewStep({
  uploadedDocumentCount,
  filingSummary,
  filingSummaryError,
  taxCalculationError,
  taxCalculationNote = null,
  withholdingWarning,
  withholdingConfirmed,
  onWithholdingConfirmChange,
  calculatingTaxFor,
  reconciliationResolved,
  draftId,
  filerStatus = null,
  onCalculateTax,
  onServicesEvidenceSaved,
}: WizardReviewStepProps) {
  const money = (value: number | null | undefined) =>
    value === null || value === undefined
      ? "Pending"
      : `PKR ${value.toLocaleString()}`;

  const amount = (value: number) => `PKR ${Math.round(value).toLocaleString()}`;

  // The breakdown is only meaningful once an estimate exists; a NEEDS_RULES
  // result deliberately carries no lines.
  const breakdown =
    filingSummary?.taxCalculationStatus === "ESTIMATE"
      ? (filingSummary.taxBreakdown ?? [])
      : [];
  const collectionBreakdown =
    filingSummary?.taxCalculationStatus === "ESTIMATE"
      ? (filingSummary.collectionBreakdown ?? [])
      : [];
  const needsRules = filingSummary?.taxCalculationStatus === "NEEDS_RULES";
  const needsUserInput =
    filingSummary?.taxCalculationStatus === "NEEDS_USER_INPUT";
  const hasSalaryTaxLine = breakdown.some((line) => line.source === "salary");
  const selectedServicesCategories =
    filingSummary?.selectedServicesSubcategories ?? [];
  const servicesReceipts = filingSummary?.servicesIncomeEntries ?? [];
  const servicesInvoices = filingSummary?.servicesInvoices ?? [];
  const selectedServiceCategoryKeys = new Set(
    selectedServicesCategories.map((category) => category.subcategory),
  );
  const servicesAccountingMethod = filingSummary?.servicesAccountingMethod ?? null;
  const servicesEvidenceComplete = (() => {
    if (selectedServicesCategories.length === 0) return true;
    if (!servicesAccountingMethod || servicesInvoices.length === 0) return false;
    if (!servicesInvoices.every((invoice) =>
      invoice.evidenceStatus === "CONFIRMED" &&
      Boolean(invoice.subcategory) &&
      selectedServiceCategoryKeys.has(invoice.subcategory ?? "") &&
      (servicesAccountingMethod !== "CASH" ||
        ["NO_RECEIPT_TY", "PARTIAL_TY", "FULL_TY"].includes(invoice.paymentStatus ?? "")) &&
      (servicesAccountingMethod !== "ACCRUAL" ||
        Boolean(invoice.dueDate &&
          (invoice.currency === "PKR" ||
            (invoice.exchangeRateToPkr && invoice.exchangeRateToPkr > 0 && invoice.fxEvidenceReference)))) &&
      invoice.paymentMatches.every((match) => match.recordStatus === "CONFIRMED"),
    )) return false;
    const serviceCreditIds = new Set(servicesReceipts.map((receipt) => receipt.id));
    const allocatedNetByCredit = new Map<string, number>();
    for (const invoice of servicesInvoices) {
      for (const match of invoice.paymentMatches) {
        if (!serviceCreditIds.has(match.ledgerEntryId) || match.netBankAmountPkr === null)
          return false;
        allocatedNetByCredit.set(
          match.ledgerEntryId,
          (allocatedNetByCredit.get(match.ledgerEntryId) ?? 0) + match.netBankAmountPkr,
        );
      }
    }
    return servicesReceipts.every((receipt) =>
      Math.round((allocatedNetByCredit.get(receipt.id) ?? 0) * 100) ===
      Math.round(receipt.amount * 100),
    );
  })();

  // AUTO-CALCULATE ON THE WIZARD'S OWN ANSWER (28-Oct-2026).
  // The estimate used to be priced only when one of three buttons was pressed,
  // so a non-filer could sit on an ATL figure (or on none at all) until someone
  // clicked. Now the Filer / Filer-late / Non-filer answer given in the setup is
  // the pricing instruction: the estimate follows it, and it is re-priced by
  // itself whenever the saved answer and the saved estimate disagree (for
  // example after going back and changing the answer).
  const autoCalculatedFor = useRef<string | null>(null);
  const servicesEvidenceCompleteForAuto = (() => {
    const evidence = selectedServicesCategories;
    return evidence.length === 0 ? true : servicesEvidenceComplete;
  })();
  useEffect(() => {
    if (!draftId || !filerStatus) return;
    if (calculatingTaxFor !== null) return;
    if (!servicesEvidenceCompleteForAuto) return;
    if (
      filingSummary?.taxpayerListStatus === filerStatus &&
      filingSummary?.taxCalculationStatus === "ESTIMATE"
    )
      return;
    const key = `${draftId}:${filerStatus}:${filingSummary?.taxpayerListStatus ?? "none"}:${filingSummary?.taxCalculationStatus ?? "none"}`;
    if (autoCalculatedFor.current === key) return;
    autoCalculatedFor.current = key;
    onCalculateTax(filerStatus);
  }, [
    draftId,
    filerStatus,
    calculatingTaxFor,
    servicesEvidenceCompleteForAuto,
    filingSummary?.taxpayerListStatus,
    filingSummary?.taxCalculationStatus,
    onCalculateTax,
  ]);



  return (
    <div className="space-y-6">
      <StepHeading
        title="Review your filing"
        description="Review the totals saved against this filing before generating the packet."
      />

      {(filingSummaryError || taxCalculationError) && (
        <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
          {taxCalculationError ?? filingSummaryError}
        </div>
      )}

      {/* Amber, not red: the estimate is usable, but tax deducted at source
          may have been counted from both the salary certificate and the bank
          ledger. Overstated withholding produces a refund that does not
          exist, so this is shown before the packet is generated. */}
      {withholdingWarning && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
          <p className="font-semibold">Check tax deducted at source</p>
          <p className="mt-1">{withholdingWarning}</p>
          <label className="mt-3 flex cursor-pointer items-start gap-2 border-t border-amber-500/20 pt-3">
            <input
              type="checkbox"
              data-testid="withholding-duplicate-confirm"
              className="mt-0.5 h-4 w-4 accent-amber-600"
              checked={withholdingConfirmed}
              onChange={(e) => onWithholdingConfirmChange(e.target.checked)}
            />
            <span>
              I confirm these ledger rows are separate payments, not the same
              deduction as the salary certificate. Filing a double-counted
              figure produces a refund that does not exist.
            </span>
          </label>
        </div>
      )}

      {(filingSummary?.excludedPositiveCredits?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-sm text-amber-950 dark:text-amber-200">
          <p className="font-semibold">
            Excluded positive bank credits — review before calculating
          </p>
          <p className="mt-1 text-xs leading-relaxed">
            These credits are not included in Services income. Confirm each one
            is not a Freelancer receipt or other income payment. Clear, strongly
            worded Freelancer service receipts remain blocked until corrected.
          </p>
          <ul className="mt-3 divide-y divide-amber-500/20 border-t border-amber-500/20">
            {filingSummary?.excludedPositiveCredits?.map((credit) => (
              <li
                key={credit.id}
                className="flex flex-wrap items-start justify-between gap-2 py-2 text-xs"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{credit.description}</span>
                  <span className="mt-0.5 block text-amber-900/80 dark:text-amber-200/80">
                    Review reason: {credit.reason ?? "No reason saved — reopen this row in Bank Intelligence."}
                  </span>
                </span>
                <span className="shrink-0 font-semibold tabular-nums">
                  PKR {credit.amount.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <WorkflowKpiStrip maxColumns={2}>
        <WorkflowKpiCard
          label="Ledger income"
          value={money(filingSummary?.income)}
          sub={
            hasSalaryTaxLine
              ? "Ledger cash inflows; a mapped certificate replaces bank pay in the salary tax base."
              : "Approved income entries in the ledger."
          }
          accent="amanah"
        />
        <WorkflowKpiCard
          label="Expenses"
          value={money(filingSummary?.expenses)}
        />
        <WorkflowKpiCard
          label="Assets"
          value={money(filingSummary?.assets)}
          accent="mizan"
        />
        <WorkflowKpiCard
          label="Liabilities"
          value={money(filingSummary?.liabilities)}
        />
        <WorkflowKpiCard
          label="Taxable income"
          value={money(filingSummary?.taxableIncome)}
        />
        <WorkflowKpiCard
          label="Tax already withheld"
          value={money(filingSummary?.taxWithheld)}
          accent="mizan"
        />
        <WorkflowKpiCard
          label="Tax payable"
          value={money(filingSummary?.taxPayable)}
          sub="Estimate only. The amount to pay is the one IRIS shows."
          accent="amanah"
        />
        <WorkflowKpiCard
          label="Refund due"
          value={money(filingSummary?.refundDue)}
          accent="amanah"
        />
      </WorkflowKpiStrip>

      <WizardServicesIncomeEvidencePanel
        draftId={draftId}
        accountingMethod={filingSummary?.servicesAccountingMethod}
        categories={filingSummary?.selectedServicesSubcategories ?? []}
        invoices={filingSummary?.servicesInvoices ?? []}
        receipts={filingSummary?.servicesIncomeEntries ?? []}
        evidenceDocuments={filingSummary?.servicesEvidenceDocuments ?? []}
        onSaved={onServicesEvidenceSaved}
      />

      <div className="space-y-4 rounded-xl border bg-card p-4">
        {hasSalaryTaxLine && (
          <p className="rounded-lg border border-amanah/20 bg-amanah/5 p-3 text-xs text-muted-foreground">
            When a salary certificate is mapped, salary tax uses its annual
            gross amount. Bank payroll deposits stay in the ledger for cash and
            wealth reconciliation, and are not added to salary a second time.
          </p>
        )}
        <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm font-semibold text-foreground">
              Tax calculation
            </p>
            <p className="text-xs text-muted-foreground">
              Status:{" "}
              {filingSummary?.taxCalculationStatus === "NEEDS_USER_INPUT"
                ? "Waiting for your decision"
                : filingSummary?.taxCalculationStatus === "NEEDS_RULES"
                  ? "Cannot be calculated yet"
                  : filingSummary?.taxCalculationStatus === "ESTIMATE"
                    ? "Calculated"
                    : "Not calculated"}
            </p>
          </div>
          {filingSummary?.taxpayerListStatus && (
            <Badge
              variant="outline"
              className="w-fit border-amanah/25 bg-amanah/10 text-amanah"
            >
              Calculated for {filerStatusScreenLabel(filingSummary.taxpayerListStatus)}
            </Badge>
          )}
        </div>

        {breakdown.length > 0 && (
          <div className="rounded-lg border border-border/70 bg-muted/20">
            <div className="border-b border-border/70 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Tax by income source
              </p>
            </div>
            <ul className="divide-y divide-border/50">
              {breakdown.map((line) => {
                // A combined line made of one income type is just that income
                // type, so it takes that name instead of "Combined slab".
                const parts = line.combinedRoutes ?? [];
                const title =
                  line.source === "combined_slab" && parts.length === 1
                    ? sourceLabel(parts[0].route)
                    : (line.subcategoryLabel ?? sourceLabel(line.source));
                return (
                  <li
                    key={`${line.source}-${line.ruleId}`}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{title}</span>
                        {line.isFinalTax && (
                          <span className="rounded-full bg-amanah/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amanah">
                            Final tax
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {line.subcategoryLabel
                          ? `${sourceLabel(line.source)} · `
                          : ""}
                        {line.section ? `Section ${line.section} · ` : ""}
                        Income {amount(line.income)}
                        {line.surcharge > 0
                          ? ` · incl. surcharge ${amount(line.surcharge)}`
                          : ""}
                        {parts.length > 1 && (
                          <>
                            {" · "}
                            {parts
                              .map(
                                (part) =>
                                  `${sourceLabel(part.route)} ${amount(part.income)}`,
                              )
                              .join(" + ")}
                          </>
                        )}
                      </p>
                    </div>
                    <span className="text-sm font-semibold tabular-nums">
                      {amount(line.taxDue)}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-between border-t border-border/70 px-3 py-2.5">
              <span className="text-sm font-semibold">Total tax</span>
              <span className="text-sm font-semibold tabular-nums">
                {amount(
                  breakdown.reduce((total, line) => total + line.taxDue, 0),
                )}
              </span>
            </div>
            {(filingSummary?.finalTaxDue ?? 0) > 0 && (
              <p className="border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">
                {amount(filingSummary?.finalTaxDue ?? 0)} of this is final tax
                and is not refundable through the return. Assessable portion:{" "}
                {amount(filingSummary?.assessableTaxDue ?? 0)}.
              </p>
            )}
            {(filingSummary?.mixedExcessWithholding ?? 0) > 0 && (
              <p className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {amount(filingSummary?.mixedExcessWithholding ?? 0)} was
                withheld above the calculated liability on this mixed return.
                Confirm via CPRs that the excess sits on adjustable withholding
                before claiming it as refund — final-tax over-deduction is not
                refundable.
              </p>
            )}
          </div>
        )}

        {collectionBreakdown.length > 0 && (
          <div className="rounded-lg border border-border/70 bg-muted/20">
            <div className="border-b border-border/70 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Tax collected at source
              </p>
            </div>
            <ul className="divide-y divide-border/50">
              {collectionBreakdown.map((line) => (
                <li
                  key={`collection-${line.source}-${line.ruleId}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <span className="text-sm font-medium">
                      {sourceLabel(line.source)}
                    </span>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {line.section ? `Section ${line.section} · ` : ""}
                      {line.income > 0
                        ? `Base ${amount(line.income)}`
                        : "Fixed charge"}
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">
                    {amount(line.taxDue)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-border/70 px-3 py-2.5">
              <span className="text-sm font-semibold">
                Total collected at source
              </span>
              <span className="text-sm font-semibold tabular-nums">
                {amount(filingSummary?.collectionTaxDue ?? 0)}
              </span>
            </div>
            <p className="border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">
              Collected when the transaction happened. Not deducted from Tax
              payable automatically — claim it as credit with CPR,
              goods-declaration or bill evidence.
            </p>
          </div>
        )}

        {needsRules && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-500">
              The tax estimate cannot be made yet
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {taxCalculationNote
                ? `Reason: ${taxCalculationNote}`
                : "Press the Calculate button again to see the exact reason here."}
            </p>
          </div>
        )}

        {needsUserInput && (
          <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
            <p className="text-xs font-semibold text-blue-700 dark:text-blue-500">
              One decision from you is still needed
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {taxCalculationNote
                ? taxCalculationNote
                : "Press the Calculate button again to see exactly what is needed."}{" "}
              This is not a missing tax rule — the rates are ready. Complete
              the item above, then calculate again.
            </p>
          </div>
        )}

        {/*
          28-Oct-2026 (operator): the three "Calculate for ATL / Late Filer /
          Non-ATL" buttons are gone. The Filer / Non-filer answer given in the
          setup now decides the rates, so the estimate is priced from it
          automatically. What remains here is the state of that estimate and a
          single Recalculate button, used only when the saved estimate does not
          match the answer (or when nothing could be priced yet).
        */}
        {filerStatus && (
          <div className="rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed">
            <p className="font-medium text-foreground">
              Priced on your answer:{" "}
              <span className="font-semibold">{filerStatusScreenLabel(filerStatus)}</span>
              {filerStatus === "ATL" ? " (Active Taxpayer List)" : ""}
            </p>
            {filingSummary?.taxpayerListStatus === filerStatus ? (
              <p className="mt-1 text-muted-foreground">
                The estimate below uses this status. Change the answer on the{" "}
                <span className="font-medium">Filer status</span> step and the
                estimate is re-priced automatically.
              </p>
            ) : (
              <p className="mt-1 text-muted-foreground">
                {calculatingTaxFor !== null
                  ? "Calculating the estimate for this answer…"
                  : "The saved estimate was priced on a different answer. Press Recalculate to use the current answer."}
              </p>
            )}
          </div>
        )}

        {!filerStatus && (
          <p className="text-xs text-muted-foreground">
            Answer the Filer status step first — the rates cannot be chosen
            without it.
          </p>
        )}

        {(filingSummary?.taxCalculationStatus !== "ESTIMATE" ||
          filingSummary?.taxpayerListStatus !== filerStatus ||
          !filerStatus) && (
          <Button
            type="button"
            onClick={() => filerStatus && onCalculateTax(filerStatus)}
            disabled={
              calculatingTaxFor !== null ||
              !draftId ||
              !filerStatus ||
              !servicesEvidenceComplete
            }
            className="w-full gap-2 sm:w-auto"
          >
            {calculatingTaxFor !== null && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            {calculatingTaxFor !== null
              ? "Calculating..."
              : filingSummary?.taxpayerListStatus
                ? `Recalculate for ${filerStatusScreenLabel(filerStatus)}`
                : "Calculate tax"}
          </Button>
        )}

        {selectedServicesCategories.length > 0 && !servicesEvidenceComplete && (
          <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
            <p>
              Complete and confirm the Services accounting method, invoice basis,
              and every payout-to-bank-credit match above before calculating.
              Unverified or unmatched amounts are blocked; invoice and bank credit
              are not counted twice.
            </p>
            {servicesInvoices.length === 0 && (
              <p>
                <span className="font-semibold">
                  No invoice rows exist yet, so there is nothing to confirm.
                </span>{" "}
                {(filingSummary?.documentsAwaitingMapping ?? []).length > 0 ? (
                  <>
                    Uploaded but not mapped:{" "}
                    {(filingSummary?.documentsAwaitingMapping ?? [])
                      .map((document) => document.fileName)
                      .join(", ")}
                    . Open <span className="font-semibold">Documents</span>, press{" "}
                    <span className="font-semibold">Review &amp; map data</span> on the
                    invoice slot, check the rows, then{" "}
                    <span className="font-semibold">Save &amp; Approve Map</span>. The
                    invoice rows are created by that mapping, not by extraction.
                  </>
                ) : (
                  <>
                    Upload the invoice / service income summary in{" "}
                    <span className="font-semibold">Documents</span>, wait for
                    extraction, then press{" "}
                    <span className="font-semibold">Review &amp; map data</span> and{" "}
                    <span className="font-semibold">Save &amp; Approve Map</span>.
                  </>
                )}
              </p>
            )}
          </div>
        )}

      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border p-5">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-amanah/10 text-amanah">
            <FileText className="h-5 w-5" />
          </div>
          <p className="font-semibold text-foreground">Document extraction</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {uploadedDocumentCount} document(s) shown in the checklist for this
            filing.
          </p>
          <Badge
            variant="outline"
            className="mt-3 border-amanah/25 bg-amanah/10 text-amanah"
          >
            {filingSummary?.pendingDocumentCount ?? 0} required document(s) pending extraction
          </Badge>
        </div>

        <div className="rounded-xl border border-mizan/30 bg-mizan/5 p-5">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-mizan/20 text-mizan-foreground">
            <Scale className="h-5 w-5" />
          </div>
          <p className="font-semibold text-foreground">
            Wealth Reconciliation (Mizan)
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Status: {filingSummary?.reconciliationStatus ?? "UNRESOLVED"}
            {filingSummary?.reconciliationGap !== null &&
            filingSummary?.reconciliationGap !== undefined
              ? ` · Gap ${money(Math.abs(filingSummary.reconciliationGap))}`
              : ""}
          </p>
          <Badge
            variant="outline"
            className={
              reconciliationResolved
                ? "mt-3 border-amanah/25 bg-amanah/10 text-amanah"
                : "mt-3 border-[#B8872F]/35 bg-[#B8872F]/10 text-[#8A641F]"
            }
          >
            {reconciliationResolved ? "Resolved" : "Needs attention"}
          </Badge>
        </div>
      </div>
    </div>
  );
}
