"use client";

import {
  PENSION_LABELS,
  getPensionTaxReadinessErrors,
  pensionFieldKey,
  pensionReviewNoteRequired,
  pensionTaxBasisNeedsReview,
  type PensionField,
  type PensionReviewDecisionKey,
} from "@/lib/tax/pension-statement-fields";

type Props = {
  fields: PensionField[];
  approved?: boolean;
  onChange: (key: PensionReviewDecisionKey, value: string) => void;
};

/** App/reviewer decisions are not printed pension-statement requirements. */
export function PensionTaxReviewPanel({ fields, approved = false, onChange }: Props) {
  const noteRequired = pensionReviewNoteRequired(fields);
  const warnings = getPensionTaxReadinessErrors(fields);
  const hasReviewValues = fields.some((field) =>
    ["approvedAnnual", "taxAlreadyInLedger", "reviewNote"].includes(pensionFieldKey(field.label) ?? "") &&
    field.value !== null && field.value !== undefined && String(field.value).trim() !== "",
  );
  const keys: PensionReviewDecisionKey[] = ["approvedAnnual", "taxAlreadyInLedger", "reviewNote"];
  return (
    <section className="my-3 space-y-3 rounded-lg border border-amber-200 bg-amber-50/50 p-3 text-xs">
      <div>
        <h4 className="font-semibold text-foreground">Pension tax readiness — separate from printed facts</h4>
        <p className="mt-1 text-muted-foreground">
          Only Tax Year and annual Gross Pension are always required to approve the statement facts.
          A standard statement uses its reviewed annual gross pension without a duplicate approved-amount entry or review note.
          Non-zero medical allowance or a material source mismatch needs an explicit reviewed basis; no allowance treatment is guessed.
        </p>
      </div>
      {warnings.length > 0 ? (
        <div role="status" className="space-y-1 text-amber-900">
          <p className="font-medium">The statement facts can be approved; these items must be resolved before final tax calculation:</p>
          <ul className="list-disc space-y-1 pl-4">
            {warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
          <p>Blank tax deducted means not stated, not zero. For positive deductions, an empty current tax ledger needs no overlap entry; possible duplicates require confirmation.</p>
        </div>
      ) : (
        <p className="text-muted-foreground">Final tax still checks the verified profile, current tax ledger and approved source. This panel does not approve or submit a return.</p>
      )}
      <details open={noteRequired || pensionTaxBasisNeedsReview(fields) || hasReviewValues}>
        <summary className="cursor-pointer font-medium text-foreground">Conditional tax-basis / withholding review (not PDF fields)</summary>
        <p className="my-2 text-muted-foreground">
          Leave these blank for a standard gross-only statement with verified nil withholding.
          Enter an approved basis only after reviewing the relevant treatment. A changed basis, allowance decision or material source mismatch requires a reason.
          Ledger overlap is an app reconciliation decision, never an amount inferred from the PDF.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {keys.map((key) => {
            const field = fields.find((candidate) => pensionFieldKey(candidate.label) === key);
            const value = String(field?.value ?? "");
            const required = key === "reviewNote" && noteRequired;
            const suggestion = !approved && field?.reviewSuggestion === true;
            return (
              <label key={key} className={key === "reviewNote" ? "grid gap-1 sm:col-span-2" : "grid gap-1"}>
                <span className="font-medium text-muted-foreground">
                  {PENSION_LABELS[key]}
                  {required && <span className="ml-1 text-destructive">· Required for this override</span>}
                  {!required && <span className="ml-1">· Optional / conditional</span>}
                  {suggestion && <span className="ml-1 text-amber-700">· PDF suggestion — approval required</span>}
                </span>
                {key === "reviewNote" ? (
                  <textarea rows={3} required={required} aria-required={required} value={value}
                    onChange={(event) => onChange(key, event.target.value)}
                    placeholder="Only needed for an override, allowance decision or material source mismatch; not a printed statement requirement."
                    className="min-h-24 rounded-lg border bg-background px-3 py-2 text-sm" />
                ) : (
                  <input type="text" inputMode="decimal" value={value}
                    onChange={(event) => onChange(key, event.target.value)}
                    placeholder={key === "approvedAnnual" ? "Blank = reviewed gross, unless allowance review is needed" : "Only enter a verified pension withholding overlap"}
                    className="h-9 rounded-lg border bg-background px-3 text-sm" />
                )}
                {suggestion && typeof field?.sourceEvidence === "string" && (
                  <details className="text-muted-foreground">
                    <summary className="cursor-pointer">Quoted PDF text — verify against the original</summary>
                    <p className="mt-1 whitespace-pre-wrap break-words">{field.sourceEvidence}</p>
                  </details>
                )}
              </label>
            );
          })}
        </div>
      </details>
    </section>
  );
}
