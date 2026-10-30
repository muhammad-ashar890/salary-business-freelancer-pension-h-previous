"use client";

import type { ReactNode } from "react";

import {
  businessListFieldDefinition,
  parseBusinessListField,
  readBusinessListRows,
  type BusinessListRow,
} from "@/lib/tax/business-list-fields";
import { TAX_DEPRECIATION_ROWS } from "@/lib/tax/tax-depreciation";
import {
  TAX_DEDUCTION_UNSUPPORTED_TEXT,
  findTaxDeductionSection,
  supportedTaxDeductionSections,
  takesAttributableIncome,
  type TaxDeductionRegime,
} from "@/lib/tax/business-tax-deductions";
import {
  ADD_BACK_UNSUPPORTED_TEXT,
  addBackReasons,
  findDeductionRow,
} from "@/lib/tax/business-addbacks";
import { irisLossYears } from "@/lib/tax/business-loss-rules";
import {
  IRIS_PROPERTY_AREA_UNITS,
  IRIS_PROPERTY_LIMITS,
  IRIS_PROPERTY_PROVINCES,
  IRIS_PROPERTY_SUB_TYPES,
  IRIS_PROPERTY_TYPES,
} from "@/lib/tax/business-balance-details";

type BusinessListFieldEditorProps = Readonly<{
  label: string;
  value: unknown;
  confidence?: number;
  readOnly?: boolean;
  taxYear: number;
  onChange: (value: BusinessListRow[] | null) => void;
}>;

const inputClass =
  "h-9 w-full rounded-lg border bg-background px-3 text-sm disabled:opacity-50";
const labelClass = "grid gap-1 text-xs font-medium text-muted-foreground";

function FieldShell({
  label,
  children,
}: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <label className={labelClass}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/**
 * Human editor for the seven business detail lists. Gemini/storage use JSON
 * behind the server boundary, but the taxpayer only sees and edits ordinary
 * row values here.
 */
export function BusinessListFieldEditor({
  label,
  value,
  confidence,
  readOnly = false,
  taxYear,
  onChange,
}: BusinessListFieldEditorProps) {
  const definition = businessListFieldDefinition(label);
  if (!definition) return null;

  const parsed = parseBusinessListField(label, value, taxYear);
  const editorState = readBusinessListRows(label, value);
  const rows = editorState.rows;
  const shownRows: Array<BusinessListRow | null> = readOnly
    ? rows
    : [...rows, null];

  const blankRow = (): BusinessListRow =>
    definition.key === "businessTaxDeductions"
      ? { regime: "minimum", code: "" }
      : {};

  const emit = (nextRows: BusinessListRow[]) => {
    const kept = nextRows.filter((row) =>
      Object.values(row).some(
        (entry) =>
          entry !== undefined &&
          entry !== null &&
          !(typeof entry === "string" && entry.trim() === ""),
      ),
    );
    onChange(kept.length ? kept : null);
  };

  const update = (index: number, patch: BusinessListRow) => {
    const next = rows.map((row) => ({ ...row }));
    const row = index < next.length ? next[index] : blankRow();
    for (const [key, entry] of Object.entries(patch)) {
      if (entry === undefined) delete row[key];
      else row[key] = entry;
    }
    if (index < next.length) next[index] = row;
    else next.push(row);
    emit(next);
  };

  const remove = (index: number) =>
    emit(rows.filter((_, rowIndex) => rowIndex !== index));

  const text = (row: BusinessListRow | null, key: string) =>
    typeof row?.[key] === "string" ? String(row[key]) : "";
  const number = (row: BusinessListRow | null, key: string) => {
    const value = row?.[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value.replace(/,/g, ""));
      return Number.isFinite(parsed) ? parsed : "";
    }
    return "";
  };

  const setText = (
    index: number,
    key: string,
    raw: string,
    maxLength?: number,
  ) => {
    const next = maxLength ? raw.slice(0, maxLength) : raw;
    update(index, { [key]: next === "" ? undefined : next });
  };

  const setNumber = (index: number, key: string, raw: string) => {
    if (raw.trim() === "") {
      update(index, { [key]: undefined });
      return;
    }
    const parsedNumber = Number(raw);
    update(index, {
      [key]: Number.isFinite(parsedNumber)
        ? Math.round(parsedNumber)
        : undefined,
    });
  };

  const numberField = (
    index: number,
    row: BusinessListRow | null,
    key: string,
    fieldLabel: string,
    options: { percent?: boolean; disabled?: boolean; placeholder?: string } = {},
  ) => (
    <FieldShell key={key} label={fieldLabel}>
      <input
        type="number"
        min={0}
        max={options.percent ? 100 : undefined}
        step={1}
        inputMode="numeric"
        className={inputClass}
        disabled={readOnly || options.disabled}
        placeholder={options.placeholder ?? "0"}
        value={number(row, key)}
        onChange={(event) => setNumber(index, key, event.target.value)}
      />
    </FieldShell>
  );

  const textField = (
    index: number,
    row: BusinessListRow | null,
    key: string,
    fieldLabel: string,
    options: { maxLength?: number; placeholder?: string } = {},
  ) => (
    <FieldShell key={key} label={fieldLabel}>
      <input
        type="text"
        className={inputClass}
        disabled={readOnly}
        maxLength={options.maxLength}
        placeholder={options.placeholder}
        value={text(row, key)}
        onChange={(event) =>
          setText(index, key, event.target.value, options.maxLength)
        }
      />
    </FieldShell>
  );

  const selectField = (
    index: number,
    row: BusinessListRow | null,
    key: string,
    fieldLabel: string,
    values: readonly { value: string; label: string }[],
    placeholder = "Choose",
  ) => {
    const current = text(row, key);
    const options = values.some((entry) => entry.value === current)
      ? values
      : current
        ? [...values, { value: current, label: current }]
        : values;
    return (
      <FieldShell key={key} label={fieldLabel}>
        <select
          className={inputClass}
          disabled={readOnly}
          value={current}
          onChange={(event) =>
            update(index, { [key]: event.target.value || undefined })
          }
        >
          <option value="">{placeholder}</option>
          {options.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </FieldShell>
    );
  };

  const decimalField = (
    index: number,
    row: BusinessListRow | null,
    key: string,
    fieldLabel: string,
    maxLength?: number,
  ) => (
    <FieldShell key={key} label={fieldLabel}>
      <input
        type="number"
        min={0}
        step="any"
        inputMode="decimal"
        className={inputClass}
        disabled={readOnly}
        placeholder="0"
        value={number(row, key)}
        onChange={(event) => {
          const raw = maxLength
            ? event.target.value.slice(0, maxLength)
            : event.target.value;
          if (raw.trim() === "") {
            update(index, { [key]: undefined });
            return;
          }
          const parsedNumber = Number(raw);
          update(index, {
            [key]: Number.isFinite(parsedNumber) ? parsedNumber : undefined,
          });
        }}
      />
    </FieldShell>
  );

  const dateField = (
    index: number,
    row: BusinessListRow | null,
    key: string,
    fieldLabel: string,
  ) => (
    <FieldShell key={key} label={fieldLabel}>
      <input
        type="date"
        className={inputClass}
        disabled={readOnly}
        value={text(row, key)}
        onChange={(event) =>
          update(index, { [key]: event.target.value || undefined })
        }
      />
    </FieldShell>
  );

  const renderRow = (row: BusinessListRow | null, index: number) => {
    switch (definition.key) {
      case "businessBankAccounts":
        return (
          <div className="grid gap-2 sm:grid-cols-2">
            <FieldShell label="IBAN">
              <input
                type="text"
                className={inputClass}
                disabled={readOnly}
                maxLength={24}
                placeholder="PK..."
                value={text(row, "iban")}
                onChange={(event) =>
                  update(index, {
                    iban: event.target.value
                      .toUpperCase()
                      .replace(/[\s-]+/g, "")
                      .slice(0, 24),
                  })
                }
              />
            </FieldShell>
            {numberField(index, row, "balance", "Balance at 30 June (Rs)")}
          </div>
        );

      case "businessVehicles":
        return (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {textField(index, row, "registrationNo", "Registration No.", {
              maxLength: 15,
            })}
            {textField(index, row, "chassisNo", "Chassis No. (if shown)", {
              maxLength: 20,
            })}
            {numberField(index, row, "value", "Value at 30 June (Rs)")}
            {textField(index, row, "make", "Make", { maxLength: 50 })}
            {textField(index, row, "model", "Model", { maxLength: 50 })}
          </div>
        );

      case "businessProperties": {
        const option = (value: string) => ({ value, label: value });
        return (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {selectField(
              index,
              row,
              "balanceRow",
              "Balance Sheet row",
              [
                { value: "land", label: "Land (Business) — 3301" },
                { value: "building", label: "Building (Business) — 3302" },
              ],
              "Choose Land or Building",
            )}
            {selectField(
              index,
              row,
              "propertyType",
              "Property type",
              IRIS_PROPERTY_TYPES.map(option),
              "Choose the property type",
            )}
            {selectField(
              index,
              row,
              "propertySubType",
              "Property sub-type",
              IRIS_PROPERTY_SUB_TYPES.map(option),
              "Choose the property sub-type",
            )}
            {dateField(
              index,
              row,
              "acquisitionDate",
              "Date of Acquisition (if known)",
            )}
            {selectField(
              index,
              row,
              "areaUnit",
              "Land area unit",
              IRIS_PROPERTY_AREA_UNITS.map(option),
              "Choose the area unit",
            )}
            {decimalField(
              index,
              row,
              "landArea",
              "Land area",
              IRIS_PROPERTY_LIMITS.landAreaText,
            )}
            {numberField(
              index,
              row,
              "acquisitionCost",
              "Acquisition cost/value (Rs, if known)",
              { placeholder: "Leave blank if not shown" },
            )}
            {numberField(
              index,
              row,
              "value",
              "Balance Sheet value at 30 June (Rs)",
            )}
            {selectField(
              index,
              row,
              "province",
              "Province / Territory",
              IRIS_PROPERTY_PROVINCES.map(option),
              "Choose the province / territory",
            )}
            {textField(index, row, "district", "District (exact IRIS spelling)", {
              maxLength: IRIS_PROPERTY_LIMITS.district,
            })}
            {textField(index, row, "city", "City (exact IRIS spelling)", {
              maxLength: IRIS_PROPERTY_LIMITS.city,
            })}
            {textField(
              index,
              row,
              "propertyNo",
              "Property/ Plot/ House/ Shop No.",
              { maxLength: IRIS_PROPERTY_LIMITS.propertyNo },
            )}
            {textField(
              index,
              row,
              "sectorMohallaBlock",
              "Sector / Mohalla / Block",
              { maxLength: IRIS_PROPERTY_LIMITS.sectorMohallaBlock },
            )}
          </div>
        );
      }

      case "businessDepreciationSchedule": {
        const code = text(row, "code");
        const rule = TAX_DEPRECIATION_ROWS.find((entry) => entry.code === code);
        const setCode = (nextCode: string) => {
          const nextRule = TAX_DEPRECIATION_ROWS.find(
            (entry) => entry.code === nextCode,
          );
          const patch: BusinessListRow = {
            code: nextCode || undefined,
          };
          if (nextRule && !nextRule.acceptsBroughtForward) {
            patch.wdvBroughtForward = undefined;
            patch.deletion = undefined;
            patch.deletionSalePrice = undefined;
            patch.additionUsed = undefined;
            patch.additionUsedExtent = undefined;
          }
          if (nextRule && !nextRule.acceptsUsedAdditions) {
            patch.additionUsed = undefined;
            // The first Extent also serves WDV brought forward, so only clear
            // it when this row cannot hold either part of the opening pool.
            if (!nextRule.acceptsBroughtForward) {
              patch.additionUsedExtent = undefined;
            }
          }
          update(index, patch);
        };
        return (
          <div className="space-y-2">
            <FieldShell label="IRIS asset class">
              <select
                className={inputClass}
                disabled={readOnly}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              >
                <option value="">Choose the asset class</option>
                {TAX_DEPRECIATION_ROWS.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.label} ({entry.code}) — {entry.ratePercent}% a year
                  </option>
                ))}
              </select>
            </FieldShell>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {numberField(
                index,
                row,
                "wdvBroughtForward",
                "Tax WDV at start of year (Rs)",
                { disabled: !rule || !rule.acceptsBroughtForward },
              )}
              {numberField(
                index,
                row,
                "deletion",
                "Deletion — WDV of assets sold (Rs)",
                { disabled: !rule || !rule.acceptsBroughtForward },
              )}
              {numberField(
                index,
                row,
                "deletionSalePrice",
                "Sale price of those assets (Rs)",
                { disabled: !rule || !rule.acceptsBroughtForward },
              )}
              {numberField(
                index,
                row,
                "additionUsed",
                "Bought this year: used before in Pakistan (Rs)",
                { disabled: !rule || !rule.acceptsUsedAdditions },
              )}
              {numberField(
                index,
                row,
                "additionUsedExtent",
                "Business use: opening WDV + used additions (%)",
                {
                  percent: true,
                  disabled:
                    !rule ||
                    (!rule.acceptsBroughtForward && !rule.acceptsUsedAdditions),
                  placeholder: "%",
                },
              )}
              {numberField(index, row, "additionNew", "Bought this year: new (Rs)", {
                disabled: !rule,
              })}
              {numberField(
                index,
                row,
                "additionNewExtent",
                "Business use of new addition (%)",
                { percent: true, disabled: !rule, placeholder: "%" },
              )}
            </div>
          </div>
        );
      }

      case "businessTaxDeductions": {
        const regime = (text(row, "regime") || "minimum") as TaxDeductionRegime;
        const code = text(row, "code");
        const section = code ? findTaxDeductionSection(regime, code) : null;
        return (
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <FieldShell label="Type in IRIS">
                <select
                  className={inputClass}
                  disabled={readOnly}
                  value={regime}
                  onChange={(event) =>
                    update(index, {
                      regime: event.target.value,
                      code: "",
                      attributableIncome: undefined,
                    })
                  }
                >
                  <option value="minimum">Minimum tax</option>
                  <option value="adjustable">Adjustable tax</option>
                  <option value="final">Final tax (not automated yet)</option>
                </select>
              </FieldShell>
              <FieldShell label="IRIS section">
                <select
                  className={inputClass}
                  disabled={readOnly}
                  value={code}
                  onChange={(event) => {
                    const nextCode = event.target.value;
                    const nextSection = findTaxDeductionSection(
                      regime,
                      nextCode,
                    );
                    update(index, {
                      code: nextCode,
                      attributableIncome:
                        nextSection && takesAttributableIncome(nextSection)
                          ? row?.attributableIncome
                          : undefined,
                    });
                  }}
                >
                  <option value="">Choose the section</option>
                  {supportedTaxDeductionSections(regime).map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.label} ({option.code})
                    </option>
                  ))}
                  {section?.unsupported ? (
                    <option value={section.code}>
                      {section.label} ({section.code})
                    </option>
                  ) : null}
                </select>
              </FieldShell>
            </div>
            {section?.unsupported ? (
              <p className="text-xs text-destructive">
                {TAX_DEDUCTION_UNSUPPORTED_TEXT[section.unsupported]}
              </p>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {numberField(index, row, "taxableAmount", "Taxable amount (Rs)")}
              {numberField(index, row, "taxDeducted", "Tax deducted (Rs)")}
              {section && takesAttributableIncome(section)
                ? numberField(
                    index,
                    row,
                    "attributableIncome",
                    "Attributable taxable income (Rs)",
                    { placeholder: "If IRIS asks for it" },
                  )
                : null}
            </div>
          </div>
        );
      }

      case "businessAddBacks": {
        const code = text(row, "code");
        const reason = code ? findDeductionRow(code) : null;
        return (
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
              <FieldShell label="Reason (as IRIS names it)">
                <select
                  className={inputClass}
                  disabled={readOnly}
                  value={code}
                  onChange={(event) =>
                    update(index, { code: event.target.value })
                  }
                >
                  <option value="">Choose the reason</option>
                  {addBackReasons().map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.label} ({option.code})
                    </option>
                  ))}
                  {reason?.unsupported ? (
                    <option value={reason.code}>
                      {reason.label} ({reason.code})
                    </option>
                  ) : null}
                </select>
              </FieldShell>
              {numberField(index, row, "amount", "Amount (Rs)")}
            </div>
            {reason?.unsupported ? (
              <p className="text-xs text-destructive">
                {ADD_BACK_UNSUPPORTED_TEXT[reason.unsupported]}
              </p>
            ) : null}
          </div>
        );
      }

      case "businessLossesByYear": {
        const years = irisLossYears(taxYear);
        const parsedYear = number(row, "year");
        const year = parsedYear === "" ? null : parsedYear;
        return (
          <div className="grid gap-2 sm:grid-cols-2">
            <FieldShell label="Tax year of the loss">
              <select
                className={inputClass}
                disabled={readOnly}
                value={year ? String(year) : ""}
                onChange={(event) => {
                  if (!event.target.value) {
                    if (row) remove(index);
                    return;
                  }
                  update(index, { year: Number(event.target.value) });
                }}
              >
                <option value="">Choose the year</option>
                {years.map((entry) => (
                  <option key={entry} value={String(entry)}>
                    {entry}
                  </option>
                ))}
                {year && !years.includes(year) ? (
                  <option value={String(year)}>{year}</option>
                ) : null}
              </select>
            </FieldShell>
            {numberField(index, row, "amount", "Unused loss (Rs)", {
              disabled: !row,
              placeholder: row ? "0" : "Choose the year first",
            })}
          </div>
        );
      }
    }
  };

  return (
    <section className="space-y-3 rounded-lg border bg-background p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-foreground">
            {definition.displayLabel}
          </h4>
          <p className="text-xs text-muted-foreground">
            {definition.description}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          {rows.length} row{rows.length === 1 ? "" : "s"}
          {typeof confidence === "number" && confidence > 0
            ? ` · ${Math.round(confidence * 100)}% confidence`
            : ""}
        </span>
      </div>

      <p className="rounded-md bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
        Enter or correct values in these normal fields. The system saves the
        structured list automatically; no JSON entry is needed.
      </p>

      {!editorState.readable || parsed?.errors.length ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive"
        >
          <ul className="list-disc space-y-1 pl-4">
            {(parsed?.errors.length
              ? parsed.errors
              : [
                  `${definition.displayLabel}: the extracted rows could not be read. Enter the rows below or re-run extraction.`,
                ]
            ).map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
          {!editorState.readable && !readOnly ? (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="mt-2 rounded-md border border-destructive/30 bg-background px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/5"
            >
              Clear the unreadable rows
            </button>
          ) : null}
        </div>
      ) : null}

      {parsed?.warnings.length ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <p className="font-medium">
            Complete these rows before this detail can be used in FBR:
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {parsed.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {shownRows.length ? (
        <div className="space-y-3">
          {shownRows.map((row, index) => (
            <div
              key={`${definition.key}-${index}`}
              className="space-y-2 rounded-lg border border-border/70 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {row ? `Row ${index + 1}` : "Add a row (only if known)"}
                </span>
                {row && !readOnly ? (
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              {renderRow(row, index)}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No rows were extracted for this list.
        </p>
      )}
    </section>
  );
}
