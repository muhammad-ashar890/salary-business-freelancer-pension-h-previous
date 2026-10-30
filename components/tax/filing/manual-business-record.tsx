"use client";

import { useState } from "react";

import { saveManualBusinessRecordAction } from "@/app/actions/manual-business-record";
import {
  ensureRequiredDocumentReviewFields,
  documentReviewFieldRequirement,
  getDocumentReviewRequiredErrors,
} from "@/lib/tax/document-review-required";
import { BUSINESS_FACT_LABELS } from "@/lib/tax/business-document-intake";
import { BUSINESS_SCHEDULE_LABELS } from "@/lib/tax/business-schedule-fields";
import { isBusinessListFieldLabel } from "@/lib/tax/business-list-fields";

type ManualBusinessRecordProps = Readonly<{
  draftId: string;
  documentType: string;
  taxYear: number;
  onSaved: () => void;
}>;

/**
 * A user-declared business source. Only ordinary scalar values are asked for
 * here: detail lists are edited later as normal rows, never as JSON text.
 */
export function ManualBusinessRecord({
  draftId,
  documentType,
  taxYear,
  onSaved,
}: ManualBusinessRecordProps) {
  const required = (
    ensureRequiredDocumentReviewFields(documentType, { fields: [] }) as {
      fields: { label: string }[];
    }
  ).fields;
  const extras =
    documentType === "business_books"
      ? [
          ...Object.values(BUSINESS_SCHEDULE_LABELS),
          ...Object.values(BUSINESS_FACT_LABELS),
        ]
      : Object.values(BUSINESS_FACT_LABELS);
  const labels = [...new Set([...required.map((field) => field.label), ...extras])]
    // JSON is a server storage detail. It is never a field the taxpayer types.
    .filter((label) => !isBusinessListFieldLabel(label));
  const requiredSet = new Set(required.map((field) => field.label));

  const [values, setValues] = useState<Record<string, string>>({
    "Tax Year": String(taxYear),
    Currency: "PKR",
    "Reporting Period Start": `${taxYear - 1}-07-01`,
    "Reporting Period End": `${taxYear}-06-30`,
    "Balance Sheet Date": `${taxYear}-06-30`,
  });
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const fieldObjects = labels.map((label) => ({
    label,
    value: values[label] ?? null,
  }));
  const requiredErrors = getDocumentReviewRequiredErrors(
    documentType,
    fieldObjects,
    taxYear,
  );
  // Business support has no single compulsory fact, but an empty declared
  // record proves nothing. Require at least one value the taxpayer knows.
  const hasDeclaredFact = labels.some(
    (label) => (values[label] ?? "").trim() !== "",
  );

  function input(label: string) {
    const requirement = documentReviewFieldRequirement(documentType, label);
    const isRequired = requiredSet.has(label);
    const isBoolean =
      label === "Purchases Exclude Sales Tax and FED" ||
      label === "Sales Exclude Sales Tax and FED" ||
      label === "Turnover 100 Million in Earlier Year";
    const commonProps = {
      required: isRequired,
      "aria-required": isRequired,
    } as const;

    return (
      <label key={label} className="block space-y-1 text-xs">
        <span>
          {label}
          {isRequired ? <span className="text-destructive"> *</span> : null}
        </span>
        {isBoolean ? (
          <select
            {...commonProps}
            className="w-full rounded border p-2"
            value={values[label] ?? ""}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                [label]: event.target.value,
              }))
            }
          >
            <option value="">Unknown / not provided</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        ) : (
          <input
            {...commonProps}
            className="w-full rounded border p-2"
            type={
              requirement?.kind === "date"
                ? "date"
                : ["amount", "positive_amount"].includes(
                      requirement?.kind ?? "",
                    )
                  ? "number"
                  : "text"
            }
            min={requirement?.kind === "positive_amount" ? 1 : 0}
            step="0.01"
            value={values[label] ?? ""}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                [label]: event.target.value,
              }))
            }
            placeholder={
              isRequired
                ? "Required — enter the figure/value (0 only where allowed)"
                : "Leave unknown optional facts blank"
            }
          />
        )}
      </label>
    );
  }

  return (
    <details className="m-3 rounded-lg border bg-background p-3">
      <summary className="cursor-pointer font-medium">
        No document? Enter a user-declared record
      </summary>
      <p className="my-3 text-xs text-muted-foreground">
        This creates your own declared source, not third-party evidence. No
        figure defaults to zero. Fields marked * are required for this record.
        Detail lists (bank accounts, vehicles, depreciation, tax sections,
        add-backs and losses) are entered after saving as normal rows during
        review; you never need to type JSON. Existing documents are never
        overwritten.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        {labels.filter((label) => requiredSet.has(label)).map(input)}
      </div>

      <details className="my-3">
        <summary className="cursor-pointer text-sm">
          Optional supporting detail (only if known)
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {labels.filter((label) => !requiredSet.has(label)).map(input)}
        </div>
      </details>

      {requiredErrors.length || !hasDeclaredFact ? (
        <div
          role="alert"
          className="my-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive"
        >
          <p className="font-medium">Required information is still missing:</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {!hasDeclaredFact ? (
              <li>Enter at least one fact you know for this record.</li>
            ) : null}
            {requiredErrors.map((requiredError) => (
              <li key={requiredError}>{requiredError}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <label className="my-3 flex gap-2 text-xs">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        I confirm these are my declared figures for this business and tax year,
        not guessed values.
      </label>

      {error ? (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        disabled={
          busy || !confirmed || requiredErrors.length > 0 || !hasDeclaredFact
        }
        className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
        onClick={async () => {
          setBusy(true);
          setError("");
          const fields = labels
            .filter((label) => (values[label] ?? "").trim() !== "")
            .map((label) => ({
              label,
              value:
                values[label] === "true"
                  ? true
                  : values[label] === "false"
                    ? false
                    : values[label],
            }));
          try {
            const result = await saveManualBusinessRecordAction(
              draftId,
              documentType,
              fields,
              confirmed,
            );
            if (!result.success) setError(result.error ?? "Save failed");
            else onSaved();
          } catch {
            setError("Save failed; please try again.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Saving..." : "Save declared record for review"}
      </button>
    </details>
  );
}
