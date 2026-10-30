"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import {
  removeSalesTaxManualInvoiceAction,
  saveSalesTaxManualInvoiceAction,
  type SalesTaxInvoiceState,
  type SalesTaxManualRow,
} from "@/app/actions/sales-tax";
import { Button } from "@/components/ui/button";
import { firstDayOfMonth, lastDayOfMonth } from "@/lib/sales-tax/dates";
import {
  emptyManualInvoice,
  isNote,
  manualOptions,
  needsReference,
  partyWord,
  rateChoices,
  rateLabel,
  suggestTax,
  treatmentOf,
  validateManualInvoice,
  type ManualInvoice,
  type ManualKind,
} from "@/lib/sales-tax/manual-invoices";
import { formatRupees, toPaisa } from "@/lib/sales-tax/money";

const fieldClass =
  "h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-colors focus:border-amanah focus:ring-2 focus:ring-amanah/20";

function Field({
  label,
  hint,
  required,
  missing,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  /** A starred box left empty after the person tried to save. */
  missing?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label
      className={`block space-y-1 text-sm font-medium text-foreground ${
        missing ? "[&_input]:border-red-500 [&_select]:border-red-500" : ""
      }`}
    >
      <span className="block">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-red-700">
            *
          </span>
        )}
      </span>
      {children}
      {missing ? (
        <span className="block text-xs font-normal text-red-700">
          This box is needed.
        </span>
      ) : (
        hint && (
          <span className="block text-xs font-normal text-muted-foreground">
            {hint}
          </span>
        )
      )}
    </label>
  );
}

/** The boxes an invoice cannot be saved without; the same rules as the server and the checks. */
function requiredFields(entry: ManualInvoice): Array<keyof ManualInvoice> {
  const keys: Array<keyof ManualInvoice> = [
    "partyType",
    "originProvince",
    "destinationProvince",
    "documentType",
    "documentNo",
    "documentDate",
    "tradeType",
    "rate",
    "value",
  ];
  if (entry.partyType === "Registered") keys.push("partyRegistrationNo");
  if (isNote(entry.documentType)) keys.push("invoiceRefNo", "reason");
  return keys;
}

/**
 * Invoices typed in by hand, next to the Excel upload of the same step. Each
 * one becomes a row of the same sheet the file is read into, so the checks and
 * the return figures treat them exactly like uploaded invoices.
 */
export function ManualInvoices({
  filingId,
  kind,
  rows,
  period,
  onInvoices,
  onError,
  onDirtyChange,
}: {
  filingId: string;
  kind: ManualKind;
  rows: SalesTaxManualRow[];
  period: { year: number; month: number };
  onInvoices: (next: SalesTaxInvoiceState) => void;
  onError: (message: string | null) => void;
  /** Tells the wizard whether the open form holds typed values that are not saved yet. */
  onDirtyChange: (dirty: boolean) => void;
}) {
  const word = partyWord(kind);
  const partyLabel = word === "buyer" ? "Buyer" : "Seller";
  const options = useMemo(() => manualOptions(kind), [kind]);

  const [open, setOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [entry, setEntry] = useState<ManualInvoice>(() =>
    emptyManualInvoice(kind),
  );
  const [salesTaxTyped, setSalesTaxTyped] = useState(false);
  const [furtherTyped, setFurtherTyped] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRequired, setShowRequired] = useState(false);
  // What the form held when it was opened, to tell typed-but-unsaved values from an untouched form.
  const initialEntry = useRef<string>(JSON.stringify(entry));
  const dirty = open && JSON.stringify(entry) !== initialEntry.current;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const required = new Set<string>(requiredFields(entry));
  const isMissing = (key: keyof ManualInvoice) =>
    showRequired && required.has(key) && (entry[key] ?? "").trim() === "";

  const treatment = treatmentOf(entry.tradeType);
  const rates = rateChoices(kind, entry.tradeType, period);
  const askReference = needsReference(entry.tradeType);
  const askFixed = treatment === "third_schedule";
  const note = isNote(entry.documentType);

  /** Applies a change and refills the tax boxes the person has not typed in. */
  function update(patch: Partial<ManualInvoice>) {
    setEntry((current) => {
      let next = { ...current, ...patch };
      if ("tradeType" in patch) {
        const choices = rateChoices(kind, next.tradeType, period);
        if (!choices.includes(next.rate))
          next = { ...next, rate: choices.length === 1 ? choices[0] : "" };
        if (!needsReference(next.tradeType) && !showMore) {
          next = { ...next, exemptionSroNo: "", exemptionItemSrNo: "" };
        }
      }
      // A tax box the person is typing in, or has typed in, is left alone.
      const suggested = suggestTax(kind, next, period);
      if (!salesTaxTyped && !("salesTax" in patch))
        next = { ...next, salesTax: suggested.salesTax };
      if (!furtherTyped && !("furtherTax" in patch))
        next = { ...next, furtherTax: suggested.furtherTax };
      return next;
    });
    setFormError(null);
  }

  function openNew(carry?: ManualInvoice) {
    const fresh = emptyManualInvoice(kind);
    const next = carry
      ? {
          ...fresh,
          originProvince: carry.originProvince,
          destinationProvince: carry.destinationProvince,
          documentType: carry.documentType,
          tradeType: carry.tradeType,
          rate: carry.rate,
        }
      : fresh;
    const choices = rateChoices(kind, next.tradeType, period);
    const start = {
      ...next,
      rate: choices.length === 1 ? choices[0] : next.rate,
    };
    initialEntry.current = JSON.stringify(start);
    setEntry(start);
    setShowRequired(false);
    setEditingIndex(null);
    setSalesTaxTyped(false);
    setFurtherTyped(false);
    setShowMore(false);
    setFormError(null);
    setOpen(true);
  }

  function openEdit(row: SalesTaxManualRow) {
    initialEntry.current = JSON.stringify(row.invoice);
    setShowRequired(false);
    setEntry(row.invoice);
    setEditingIndex(row.index);
    // The stored tax is what the person confirmed; do not overwrite it.
    setSalesTaxTyped(true);
    setFurtherTyped(true);
    setShowMore(
      row.invoice.withheld !== "" ||
        (!needsReference(row.invoice.tradeType) &&
          (row.invoice.exemptionSroNo !== "" ||
            row.invoice.exemptionItemSrNo !== "")) ||
        (treatmentOf(row.invoice.tradeType) !== "third_schedule" &&
          row.invoice.fixedValue !== ""),
    );
    setFormError(null);
    onError(null);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setEditingIndex(null);
    setFormError(null);
  }

  async function save(andAnother: boolean) {
    if (busy) return;
    // Starred boxes that are still empty are stopped here, before anything is sent.
    const blanks = requiredFields(entry).filter(
      (key) => (entry[key] ?? "").trim() === "",
    );
    if (blanks.length > 0) {
      setShowRequired(true);
      setFormError(
        `Fill in the boxes marked with * before you save (${blanks.length} still empty).`,
      );
      return;
    }
    const checked = validateManualInvoice(kind, entry, period);
    if (checked.ok === false) {
      setFormError(checked.error);
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const result = await saveSalesTaxManualInvoiceAction({
        filingId,
        kind,
        index: editingIndex,
        invoice: checked.value,
      });
      if (result.success === false) {
        setFormError(result.error);
        return;
      }
      onInvoices(result.invoices);
      if (andAnother) openNew(checked.value);
      else close();
    } catch {
      setFormError(
        "Could not save this invoice. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: SalesTaxManualRow) {
    if (busy) return;
    if (!window.confirm("Remove this invoice?")) return;
    setBusy(true);
    onError(null);
    try {
      const result = await removeSalesTaxManualInvoiceAction(
        filingId,
        kind,
        row.index,
      );
      if (result.success === false) {
        onError(result.error);
        return;
      }
      onInvoices(result.invoices);
      if (editingIndex !== null) close();
    } catch {
      onError("Could not remove this invoice. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const referenceFields = (
    <>
      <Field label="SRO or schedule number">
        <select
          className={fieldClass}
          value={entry.exemptionSroNo}
          onChange={(event) => update({ exemptionSroNo: event.target.value })}
        >
          <option value="">None</option>
          {options.sroNumbers.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Item serial number">
        <input
          className={fieldClass}
          list={`item-serials-${kind}`}
          value={entry.exemptionItemSrNo}
          onChange={(event) =>
            update({ exemptionItemSrNo: event.target.value })
          }
          placeholder="Pick from the list"
          maxLength={30}
        />
        <datalist id={`item-serials-${kind}`}>
          {options.itemSerials.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </Field>
    </>
  );

  const fixedField = (
    <Field
      label="Fixed or retail value (Rs)"
      hint={
        askFixed
          ? "Third Schedule goods are taxed on the retail price."
          : undefined
      }
    >
      <input
        className={fieldClass}
        inputMode="decimal"
        value={entry.fixedValue}
        onChange={(event) => update({ fixedValue: event.target.value })}
        placeholder="0.00"
      />
    </Field>
  );

  return (
    <section
      aria-label="Invoices typed in by hand"
      data-testid={`manual-${kind.toLowerCase()}`}
      className="space-y-4 rounded-2xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-foreground">
            Type invoices in by hand
            {rows.length > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({rows.length} typed in)
              </span>
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            For invoices that are not in your Excel file. You can use the file,
            typed invoices, or both.
          </p>
        </div>
        {!open && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => openNew()}
          >
            <Plus className="h-3.5 w-3.5" />
            {rows.length > 0 ? "Add another invoice" : "Add an invoice"}
          </Button>
        )}
      </div>

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[26rem] text-left text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Row</th>
                <th className="px-3 py-2 font-medium">
                  {partyLabel} and invoice
                </th>
                <th className="px-3 py-2 text-right font-medium">Value</th>
                <th className="px-3 py-2 text-right font-medium">Sales tax</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const value = toPaisa(row.invoice.value);
                const tax = toPaisa(row.invoice.salesTax);
                return (
                  <tr key={row.index} className="border-t">
                    <td className="px-3 py-2 text-muted-foreground">
                      {row.sourceRow}
                    </td>
                    <td className="px-3 py-2">
                      <span className="block font-medium text-foreground">
                        {row.invoice.partyName ||
                          row.invoice.partyRegistrationNo ||
                          row.invoice.partyType}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {row.invoice.documentNo} · {row.invoice.documentDate}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {value === null ? "" : formatRupees(value)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {tax === null ? "" : formatRupees(tax)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1 px-2"
                          disabled={busy}
                          onClick={() => openEdit(row)}
                          aria-label={`Edit invoice ${row.invoice.documentNo}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1 px-2 text-red-700"
                          disabled={busy}
                          onClick={() => remove(row)}
                          aria-label={`Remove invoice ${row.invoice.documentNo}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div className="space-y-4 rounded-xl border bg-background p-4">
          <p className="text-sm font-semibold text-foreground">
            {editingIndex === null ? "New invoice" : "Change this invoice"}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={`${partyLabel} type`}
              required
              missing={isMissing("partyType")}
            >
              <select
                className={fieldClass}
                value={entry.partyType}
                onChange={(event) => update({ partyType: event.target.value })}
              >
                <option value="">Choose…</option>
                {options.partyTypes.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={`${partyLabel} registration no. (STRN, NTN or CNIC)`}
              required={required.has("partyRegistrationNo")}
              missing={isMissing("partyRegistrationNo")}
            >
              <input
                className={fieldClass}
                value={entry.partyRegistrationNo}
                onChange={(event) =>
                  update({ partyRegistrationNo: event.target.value })
                }
                inputMode="numeric"
                maxLength={30}
              />
            </Field>
            <Field label={`${partyLabel} name`}>
              <input
                className={fieldClass}
                value={entry.partyName}
                onChange={(event) => update({ partyName: event.target.value })}
                maxLength={120}
              />
            </Field>
            <Field
              label="Invoice type"
              required
              missing={isMissing("documentType")}
            >
              <select
                className={fieldClass}
                value={entry.documentType}
                onChange={(event) =>
                  update({ documentType: event.target.value })
                }
              >
                {options.documentTypes.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Invoice number"
              required
              missing={isMissing("documentNo")}
            >
              <input
                className={fieldClass}
                value={entry.documentNo}
                onChange={(event) => update({ documentNo: event.target.value })}
                maxLength={50}
              />
            </Field>
            <Field
              label="Invoice date"
              required
              missing={isMissing("documentDate")}
            >
              <input
                type="date"
                className={fieldClass}
                value={entry.documentDate}
                min={firstDayOfMonth(period)}
                max={lastDayOfMonth(period)}
                onChange={(event) =>
                  update({ documentDate: event.target.value })
                }
              />
            </Field>
            <Field
              label="Supply starts from"
              required
              missing={isMissing("originProvince")}
            >
              <select
                className={fieldClass}
                value={entry.originProvince}
                onChange={(event) =>
                  update({ originProvince: event.target.value })
                }
              >
                <option value="">Choose…</option>
                {options.provinces.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Supply goes to"
              required
              missing={isMissing("destinationProvince")}
            >
              <select
                className={fieldClass}
                value={entry.destinationProvince}
                onChange={(event) =>
                  update({ destinationProvince: event.target.value })
                }
              >
                <option value="">Choose…</option>
                {options.provinces.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={kind === "SALES" ? "Sale type" : "Purchase type"}
              required
              missing={isMissing("tradeType")}
            >
              <select
                className={fieldClass}
                value={entry.tradeType}
                onChange={(event) => update({ tradeType: event.target.value })}
              >
                {options.tradeTypes.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Rate" required missing={isMissing("rate")}>
              <select
                className={fieldClass}
                value={entry.rate}
                onChange={(event) => update({ rate: event.target.value })}
              >
                {rates.length !== 1 && <option value="">Choose…</option>}
                {rates.map((value) => (
                  <option key={value} value={value}>
                    {rateLabel(value)}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Value excluding sales tax (Rs)"
              required
              missing={isMissing("value")}
            >
              <input
                className={fieldClass}
                inputMode="decimal"
                value={entry.value}
                onChange={(event) => update({ value: event.target.value })}
                placeholder="0.00"
              />
            </Field>
            <Field
              label="Sales tax (Rs)"
              hint="Filled in from the rate; change it if your invoice shows a different amount."
            >
              <input
                className={fieldClass}
                inputMode="decimal"
                value={entry.salesTax}
                onChange={(event) => {
                  setSalesTaxTyped(true);
                  update({ salesTax: event.target.value });
                }}
                placeholder="0.00"
              />
            </Field>
            {kind === "SALES" && (
              <Field
                label="Further tax (Rs)"
                hint="Applies to sales to buyers who are not registered."
              >
                <input
                  className={fieldClass}
                  inputMode="decimal"
                  value={entry.furtherTax}
                  onChange={(event) => {
                    setFurtherTyped(true);
                    update({ furtherTax: event.target.value });
                  }}
                  placeholder="0.00"
                />
              </Field>
            )}
            {askFixed && fixedField}
            {askReference && referenceFields}
            {note && (
              <>
                <Field
                  label="Original invoice number"
                  required
                  missing={isMissing("invoiceRefNo")}
                >
                  <input
                    className={fieldClass}
                    value={entry.invoiceRefNo}
                    onChange={(event) =>
                      update({ invoiceRefNo: event.target.value })
                    }
                    maxLength={50}
                  />
                </Field>
                <Field label="Reason" required missing={isMissing("reason")}>
                  <select
                    className={fieldClass}
                    value={entry.reason}
                    onChange={(event) => update({ reason: event.target.value })}
                  >
                    <option value="">Choose…</option>
                    {options.reasons.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
          </div>

          <div>
            <button
              type="button"
              className="text-sm font-medium text-amanah underline-offset-2 hover:underline"
              onClick={() => setShowMore((value) => !value)}
              aria-expanded={showMore}
            >
              {showMore ? "Hide more details" : "More details"}
            </button>
            {showMore && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Tax withheld (Rs)">
                  <input
                    className={fieldClass}
                    inputMode="decimal"
                    value={entry.withheld}
                    onChange={(event) =>
                      update({ withheld: event.target.value })
                    }
                    placeholder="0.00"
                  />
                </Field>
                {!askFixed && fixedField}
                {!askReference && referenceFields}
                {!note && (
                  <>
                    <Field label="Original invoice number">
                      <input
                        className={fieldClass}
                        value={entry.invoiceRefNo}
                        onChange={(event) =>
                          update({ invoiceRefNo: event.target.value })
                        }
                        maxLength={50}
                      />
                    </Field>
                    <Field label="Reason">
                      <select
                        className={fieldClass}
                        value={entry.reason}
                        onChange={(event) =>
                          update({ reason: event.target.value })
                        }
                      >
                        <option value="">None</option>
                        {options.reasons.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </>
                )}
              </div>
            )}
          </div>

          {formError && (
            <p role="alert" className="text-sm text-red-700">
              {formError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              disabled={busy}
              onClick={() => save(false)}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save invoice
            </Button>
            {editingIndex === null && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={busy}
                onClick={() => save(true)}
              >
                Save and add another
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
