"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import {
  removeSrbEntryAction,
  saveSrbEntryAction,
} from "@/app/actions/sales-tax-srb";
import { StepHeading } from "@/components/tax/wizard-ui";
import { Button } from "@/components/ui/button";
import { firstDayOfMonth, lastDayOfMonth } from "@/lib/sales-tax/dates";
import { formatRupees, toPaisa } from "@/lib/sales-tax/money";
import {
  expectedTax,
  findCpc,
  findRateOption,
  rateOptionsForCpc,
  searchCpc,
} from "@/lib/sales-tax/rules/srb-services";
import {
  earliestClaimDate,
  purchaseToRaw,
  saleToRaw,
  SRB_NON_CREDITABLE_REASONS,
  type SrbMonthState,
  type SrbPurchaseEntry,
  type SrbSaleEntry,
} from "@/lib/sales-tax/srb";
import type { SrbEntryKind } from "@/lib/sales-tax/srb/state";
import { cn } from "@/lib/utils";

const fieldClass =
  "h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-colors focus:border-amanah focus:ring-2 focus:ring-amanah/20";

type Raw = Record<string, string>;
type Period = { year: number; month: number };

function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1 text-sm font-medium text-foreground">
      <span className="block">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-destructive">
            *
          </span>
        )}
      </span>
      {children}
      {hint && !error && (
        <span className="block text-xs font-normal text-muted-foreground">
          {hint}
        </span>
      )}
      {error && (
        <span className="block text-xs font-normal text-destructive">
          {error}
        </span>
      )}
    </label>
  );
}

/** Rupees as the plain text a form box holds, for example "150000.00". */
const rupeeText = (paisa: number) => (paisa / 100).toFixed(2);

const emptySale = (period: Period): Raw => ({
  docType: "SI",
  docNo: "",
  docDate: firstDayOfMonth(period),
  buyerType: "INTERMEDIARY",
  buyerNtn: "",
  buyerName: "",
  cpc: "",
  rateId: "",
  valueExclTax: "",
  salesTax: "",
  stWithheld: "",
  units: "",
  squareYards: "",
  squareFeet: "",
  originalDocNo: "",
  reason: "",
});

const emptyPurchase = (period: Period): Raw => ({
  docType: "PI",
  docNo: "",
  docDate: firstDayOfMonth(period),
  supplierType: "REGISTERED",
  supplierNtn: "",
  supplierName: "",
  kind: "SERVICES",
  cpc: "",
  rateId: "",
  hsCode: "",
  goodsRatePercent: "",
  valueExclTax: "",
  salesTax: "",
  nonCreditable: "",
  nonCreditableReason: "",
  stWithheldAsAgent: "",
  originalDocNo: "",
  reason: "",
});

const stringsOf = (raw: Record<string, unknown>): Raw =>
  Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      value === null || value === undefined ? "" : String(value),
    ]),
  );

/**
 * The boxes this line cannot be saved without. It follows the same rules the
 * server applies, so a star always means "needed" and a blank starred box is
 * stopped before anything is sent.
 */
function requiredKeys(kind: SrbEntryKind, raw: Raw, date: string): string[] {
  const keys = ["docType", "docNo", "docDate", "valueExclTax", "salesTax"];
  if (kind === "SALES") {
    keys.push("buyerType", "buyerNtn", "buyerName");
  } else {
    keys.push("supplierType", "supplierName", "kind");
    if (raw.supplierType !== "UNREGISTERED") keys.push("supplierNtn");
  }
  if (kind === "PURCHASES" && raw.kind === "GOODS") {
    keys.push("hsCode", "goodsRatePercent");
  } else {
    keys.push("cpc", "rateId");
    const option = raw.rateId ? findRateOption(raw.rateId, date) : null;
    if (
      option &&
      (option.basis === "per_bill" || option.basis === "per_person")
    )
      keys.push("units");
    if (option && option.basis === "property_developer")
      keys.push("squareYards", "squareFeet");
  }
  if (
    kind === "PURCHASES" &&
    raw.supplierType !== "UNREGISTERED" &&
    (raw.nonCreditable ?? "") !== ""
  ) {
    keys.push("nonCreditableReason");
  }
  if (raw.docType === "CN" || raw.docType === "DN")
    keys.push("originalDocNo", "reason");
  return keys;
}

/** The service picker: type a code or words, pick from the list. */
function CpcPicker({
  value,
  error,
  required,
  onPick,
}: {
  value: string;
  error?: string;
  required?: boolean;
  onPick: (code: string) => void;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const results = useMemo(
    () =>
      open
        ? searchCpc(query, 40)
            .filter((entry) => entry.code.length === 5)
            .slice(0, 8)
        : [],
    [open, query],
  );
  const chosen = findCpc(value);
  return (
    <div className="relative sm:col-span-2">
      <Field
        label="Service (CPC code)"
        required={required}
        hint={
          chosen
            ? `${chosen.code} · ${chosen.title}`
            : 'Type the five-digit code, or words such as "software", "legal" or "advertising".'
        }
        error={error}
      >
        <input
          className={fieldClass}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            const digits = event.target.value.replace(/\D/g, "");
            onPick(findCpc(digits) ? digits : "");
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          autoComplete="off"
          maxLength={80}
          aria-autocomplete="list"
        />
      </Field>
      {open && results.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border bg-popover text-sm shadow-lg">
          {results.map((entry) => (
            <li key={entry.code}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left hover:bg-muted"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setQuery(entry.code);
                  setOpen(false);
                  onPick(entry.code);
                }}
              >
                <span className="font-medium">{entry.code}</span> ·{" "}
                {entry.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Rate choice for a service, with what the entry needs. */
function RateFields({
  cpc,
  rateId,
  date,
  raw,
  errors,
  required,
  onChange,
}: {
  cpc: string;
  rateId: string;
  date: string;
  raw: Raw;
  errors: Record<string, string>;
  required: Set<string>;
  onChange: (patch: Partial<Raw>) => void;
}) {
  const options = cpc ? rateOptionsForCpc(cpc, date) : [];
  const option = rateId ? findRateOption(rateId, date) : null;
  return (
    <>
      <div className="sm:col-span-2">
        <Field
          label="Rate"
          required={required.has("rateId")}
          error={errors.rateId}
          hint={!cpc ? "Pick the service first." : undefined}
        >
          <select
            className={fieldClass}
            value={rateId}
            disabled={!cpc}
            onChange={(event) => onChange({ rateId: event.target.value })}
          >
            <option value="">Choose…</option>
            {options.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        {option && option.part === "II" && (
          <p className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-foreground">
            Reduced rate ({option.reference}).
            {option.condition ? ` ${option.condition}` : ""}
            {option.optionRequired
              ? " This rate needs the option to be filed with SRB."
              : ""}
          </p>
        )}
      </div>
      {option &&
        (option.basis === "per_bill" || option.basis === "per_person") && (
          <Field
            label={
              option.basis === "per_bill"
                ? "Number of bills"
                : "Number of persons"
            }
            error={errors.units}
            required={required.has("units")}
            hint={`Rs ${option.rupeesPerUnit} each.`}
          >
            <input
              className={fieldClass}
              inputMode="numeric"
              value={raw.units ?? ""}
              onChange={(event) => onChange({ units: event.target.value })}
            />
          </Field>
        )}
      {option && option.basis === "property_developer" && (
        <>
          <Field
            label="Square yards of land"
            required={required.has("squareYards")}
            error={errors.squareYards}
            hint={`Rs ${option.developerRupees?.perSquareYard} per square yard.`}
          >
            <input
              className={fieldClass}
              inputMode="decimal"
              value={raw.squareYards ?? ""}
              onChange={(event) =>
                onChange({ squareYards: event.target.value })
              }
            />
          </Field>
          <Field
            label="Square feet of covered area"
            required={required.has("squareFeet")}
            error={errors.squareFeet}
            hint={`Rs ${option.developerRupees?.perSquareFoot} per square foot.`}
          >
            <input
              className={fieldClass}
              inputMode="decimal"
              value={raw.squareFeet ?? ""}
              onChange={(event) => onChange({ squareFeet: event.target.value })}
            />
          </Field>
        </>
      )}
    </>
  );
}

/** The tax a rate gives, as form text, or "" when it cannot be worked out yet. */
function suggestServiceTax(raw: Raw, date: string): string {
  const option = raw.rateId ? findRateOption(raw.rateId, date) : null;
  if (!option) return "";
  const value = toPaisa(raw.valueExclTax);
  const quantities = {
    units: raw.units === "" ? undefined : Number(raw.units),
    squareYards: raw.squareYards === "" ? undefined : Number(raw.squareYards),
    squareFeet: raw.squareFeet === "" ? undefined : Number(raw.squareFeet),
  };
  if (option.basis === "percent") {
    if (value === null || value <= 0) return "";
    const tax = expectedTax(option, value, quantities);
    return tax === null ? "" : rupeeText(tax);
  }
  const tax = expectedTax(option, value ?? 0, quantities);
  return tax === null ? "" : rupeeText(tax);
}

const HEADINGS: Record<
  SrbEntryKind,
  {
    title: string;
    description: string;
    empty: string;
    nil: string;
    noun: string;
  }
> = {
  SALES: {
    title: "Your sales (Annex-C)",
    description:
      "Add one line for each sale invoice, credit note or debit note of the month. Services are listed with their CPC code and rate.",
    empty:
      "No sales yet. Add your sales, or confirm below that you had none this month.",
    nil: "I confirm that I had no sales this month.",
    noun: "sale",
  },
  PURCHASES: {
    title: "Your purchases (Annex-A)",
    description:
      "Add the purchases that carry sales tax, so the input tax can be claimed. Purchases without sales tax need no line.",
    empty:
      "No purchases yet. Add your purchases, or confirm below that you had none with sales tax this month.",
    nil: "I confirm that I had no purchases with sales tax this month.",
    noun: "purchase",
  },
};

export function SrbEntriesStep({
  stepNumber,
  filingId,
  kind,
  period,
  state,
  onState,
  onError,
  onDirtyChange,
  nilConfirmed,
  onNilConfirmedChange,
}: {
  stepNumber: number;
  filingId: string;
  kind: SrbEntryKind;
  period: Period;
  state: SrbMonthState;
  onState: (next: SrbMonthState) => void;
  onError: (message: string | null) => void;
  /** Tells the wizard whether the open form holds typed values that are not saved yet. */
  onDirtyChange: (dirty: boolean) => void;
  /** "I had none this month", needed to continue with no lines at all. */
  nilConfirmed: boolean;
  onNilConfirmedChange: (confirmed: boolean) => void;
}) {
  const heading = HEADINGS[kind];
  const rows: (SrbSaleEntry | SrbPurchaseEntry)[] =
    kind === "SALES" ? state.sales : state.purchases;
  const blank = () =>
    kind === "SALES" ? emptySale(period) : emptyPurchase(period);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [raw, setRaw] = useState<Raw>(blank);
  const [taxTyped, setTaxTyped] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What the form held when it was opened, to tell typed-but-unsaved values from an untouched form.
  const initialRaw = useRef<string>("");
  const dirty = open && JSON.stringify(raw) !== initialRaw.current;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  // Changing the kind remounts this step (the wizard keys it), so the state above never carries over.

  const isNote = raw.docType === "CN" || raw.docType === "DN";
  const dateForRates = /^\d{4}-\d{2}-\d{2}$/.test(raw.docDate ?? "")
    ? raw.docDate
    : lastDayOfMonth(period);
  const isGoods = kind === "PURCHASES" && raw.kind === "GOODS";

  function update(patch: Partial<Raw>) {
    setRaw((current) => {
      let next = { ...current, ...patch };
      if ("cpc" in patch && patch.cpc !== current.cpc) {
        const options = patch.cpc
          ? rateOptionsForCpc(
              patch.cpc,
              /^\d{4}-\d{2}-\d{2}$/.test(next.docDate)
                ? next.docDate
                : lastDayOfMonth(period),
            )
          : [];
        const standard = options.find((item) => item.part === "standard");
        next = {
          ...next,
          rateId: (standard ?? options[0])?.id ?? "",
          units: "",
          squareYards: "",
          squareFeet: "",
        };
      }
      if (
        !taxTyped &&
        !("salesTax" in patch) &&
        !(kind === "PURCHASES" && next.kind === "GOODS")
      ) {
        next = {
          ...next,
          salesTax: suggestServiceTax(
            next,
            /^\d{4}-\d{2}-\d{2}$/.test(next.docDate)
              ? next.docDate
              : lastDayOfMonth(period),
          ),
        };
      }
      if (
        !taxTyped &&
        !("salesTax" in patch) &&
        kind === "PURCHASES" &&
        next.kind === "GOODS"
      ) {
        const value = toPaisa(next.valueExclTax);
        const percent = Number(next.goodsRatePercent);
        next = {
          ...next,
          salesTax:
            value !== null &&
            value > 0 &&
            Number.isFinite(percent) &&
            percent > 0
              ? rupeeText(Math.round(value * percent) / 100)
              : "",
        };
      }
      return next;
    });
    setFormError(null);
    // Only the boxes that changed lose their message; the others keep theirs until they are fixed.
    setErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[key];
      delete next.salesTax;
      if ("cpc" in patch) delete next.rateId;
      return next;
    });
  }

  function openNew() {
    const fresh = blank();
    initialRaw.current = JSON.stringify(fresh);
    setRaw(fresh);
    setEditingId(null);
    setTaxTyped(false);
    setErrors({});
    setFormError(null);
    setOpen(true);
  }

  function openEdit(entry: SrbSaleEntry | SrbPurchaseEntry) {
    const loaded = stringsOf(
      kind === "SALES"
        ? saleToRaw(entry as SrbSaleEntry)
        : purchaseToRaw(entry as SrbPurchaseEntry),
    );
    initialRaw.current = JSON.stringify(loaded);
    setRaw(loaded);
    setEditingId(entry.id);
    setTaxTyped(true);
    setErrors({});
    setFormError(null);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setEditingId(null);
    setErrors({});
    setFormError(null);
  }

  async function save(addAnother: boolean) {
    if (busy) return;
    // Starred boxes that are still empty are stopped here, before anything is sent.
    const blanks = requiredKeys(kind, raw, dateForRates).filter(
      (key) => (raw[key] ?? "").trim() === "",
    );
    if (blanks.length > 0) {
      setErrors(
        Object.fromEntries(blanks.map((key) => [key, "This box is needed."])),
      );
      setFormError(
        `Fill in the boxes marked with * before you save (${blanks.length} still empty).`,
      );
      return;
    }
    setBusy(true);
    setFormError(null);
    onError(null);
    try {
      const outcome = await saveSrbEntryAction({
        filingId,
        kind,
        entryId: editingId,
        raw,
      });
      if (outcome.success === false) {
        setErrors(outcome.fieldErrors);
        setFormError(outcome.error);
        return;
      }
      onState(outcome.state);
      if (addAnother && editingId === null) {
        const carry: Partial<Raw> =
          kind === "SALES"
            ? { docType: raw.docType, buyerType: raw.buyerType }
            : {
                docType: raw.docType,
                kind: raw.kind,
                supplierType: raw.supplierType,
              };
        const nextRaw = { ...blank(), ...carry };
        initialRaw.current = JSON.stringify(nextRaw);
        setRaw(nextRaw);
        setTaxTyped(false);
        setErrors({});
      } else {
        close();
      }
    } catch {
      setFormError("Could not save this line. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry: SrbSaleEntry | SrbPurchaseEntry) {
    if (busy) return;
    if (!window.confirm(`Remove ${entry.docType} ${entry.docNo}?`)) return;
    setBusy(true);
    onError(null);
    try {
      const outcome = await removeSrbEntryAction(filingId, kind, entry.id);
      if (outcome.success === false) onError(outcome.error);
      else onState(outcome.state);
    } catch {
      onError("Could not remove this line. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const partyType = kind === "SALES" ? "buyer" : "supplier";
  const partyKey = (suffix: "Ntn" | "Name" | "Type") => `${partyType}${suffix}`;
  const docTypes =
    kind === "SALES"
      ? [
          ["SI", "Sale invoice"],
          ["CN", "Credit note"],
          ["DN", "Debit note"],
        ]
      : [
          ["PI", "Purchase invoice"],
          ["CN", "Credit note"],
          ["DN", "Debit note"],
        ];
  const dateMin =
    kind === "SALES" ? firstDayOfMonth(period) : earliestClaimDate(period);
  const required = new Set(requiredKeys(kind, raw, dateForRates));

  return (
    <div className="space-y-6">
      <StepHeading
        eyebrow={`Step ${stepNumber}`}
        title={heading.title}
        description={heading.description}
      />

      {rows.length === 0 && !open ? (
        <div className="space-y-3">
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            {heading.empty}
          </p>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border bg-card p-3 text-sm text-foreground">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-[hsl(var(--amanah))]"
              checked={nilConfirmed}
              onChange={(event) => onNilConfirmedChange(event.target.checked)}
            />
            <span>{heading.nil}</span>
          </label>
        </div>
      ) : (
        rows.length > 0 && (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Document</th>
                  <th className="px-3 py-2 font-medium">
                    {kind === "SALES" ? "Buyer" : "Supplier"}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">Value</th>
                  <th className="px-3 py-2 text-right font-medium">Tax</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => {
                  const party =
                    kind === "SALES"
                      ? (entry as SrbSaleEntry).buyerName
                      : (entry as SrbPurchaseEntry).supplierName;
                  const sign = entry.docType === "CN" ? -1 : 1;
                  return (
                    <tr key={entry.id} className="border-t">
                      <td className="whitespace-nowrap px-3 py-2 align-top text-muted-foreground">
                        {entry.docDate}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <span className="font-medium text-foreground">
                          {entry.docNo}
                        </span>
                        <span className="ml-2 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {entry.docType}
                        </span>
                      </td>
                      <td className="px-3 py-2 align-top">{party}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right align-top tabular-nums">
                        {formatRupees(sign * entry.valueExclTax)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right align-top tabular-nums">
                        {formatRupees(sign * entry.salesTax)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right align-top">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => openEdit(entry)}
                          aria-label={`Change ${entry.docNo}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => remove(entry)}
                          aria-label={`Remove ${entry.docNo}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {!open && (
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          onClick={openNew}
        >
          <Plus className="h-4 w-4" />
          Add a {heading.noun}
        </Button>
      )}

      {open && (
        <div className="space-y-4 rounded-xl border bg-background p-4">
          <p className="text-sm font-semibold text-foreground">
            {editingId ? `Change this ${heading.noun}` : `New ${heading.noun}`}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Document type"
              required={required.has("docType")}
              error={errors.docType}
            >
              <select
                className={fieldClass}
                value={raw.docType}
                onChange={(event) => update({ docType: event.target.value })}
              >
                {docTypes.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Document number"
              required={required.has("docNo")}
              error={errors.docNo}
            >
              <input
                className={fieldClass}
                value={raw.docNo}
                maxLength={40}
                onChange={(event) => update({ docNo: event.target.value })}
              />
            </Field>
            <Field
              label="Document date"
              required={required.has("docDate")}
              error={errors.docDate}
              hint={
                kind === "PURCHASES"
                  ? "Up to six months before the return month is accepted for input tax."
                  : undefined
              }
            >
              <input
                type="date"
                className={fieldClass}
                value={raw.docDate}
                min={dateMin}
                max={lastDayOfMonth(period)}
                onChange={(event) => update({ docDate: event.target.value })}
              />
            </Field>
            {kind === "SALES" ? (
              <Field
                label="Buyer type"
                required={required.has("buyerType")}
                error={errors.buyerType}
              >
                <select
                  className={fieldClass}
                  value={raw.buyerType}
                  onChange={(event) =>
                    update({ buyerType: event.target.value })
                  }
                >
                  <option value="INTERMEDIARY">
                    Registered or intermediary
                  </option>
                  <option value="END_CONSUMER">End consumer</option>
                </select>
              </Field>
            ) : (
              <Field
                label="Supplier type"
                required={required.has("supplierType")}
                error={errors.supplierType}
              >
                <select
                  className={fieldClass}
                  value={raw.supplierType}
                  onChange={(event) =>
                    update({ supplierType: event.target.value })
                  }
                >
                  <option value="REGISTERED">Registered</option>
                  <option value="UNREGISTERED">Unregistered</option>
                </select>
              </Field>
            )}
            <Field
              label={`${kind === "SALES" ? "Buyer" : "Supplier"} NTN or CNIC`}
              required={required.has(partyKey("Ntn"))}
              error={errors[partyKey("Ntn")]}
              hint={
                kind === "SALES"
                  ? "For buyers without a number, use 9999998-1."
                  : raw.supplierType === "UNREGISTERED"
                    ? "Optional for an unregistered supplier."
                    : undefined
              }
            >
              <input
                className={fieldClass}
                inputMode="numeric"
                value={raw[partyKey("Ntn")]}
                maxLength={30}
                onChange={(event) =>
                  update({ [partyKey("Ntn")]: event.target.value })
                }
              />
            </Field>
            <Field
              label={`${kind === "SALES" ? "Buyer" : "Supplier"} name`}
              required={required.has(partyKey("Name"))}
              error={errors[partyKey("Name")]}
            >
              <input
                className={fieldClass}
                value={raw[partyKey("Name")]}
                maxLength={120}
                onChange={(event) =>
                  update({ [partyKey("Name")]: event.target.value })
                }
              />
            </Field>

            {kind === "PURCHASES" && (
              <Field
                label="What was bought"
                required={required.has("kind")}
                error={errors.kind}
              >
                <select
                  className={fieldClass}
                  value={raw.kind}
                  onChange={(event) =>
                    update({
                      kind: event.target.value,
                      cpc: "",
                      rateId: "",
                      hsCode: "",
                      goodsRatePercent: "",
                      salesTax: "",
                    })
                  }
                >
                  <option value="SERVICES">Services</option>
                  <option value="GOODS">Goods</option>
                </select>
              </Field>
            )}

            {isGoods ? (
              <>
                <Field
                  label="HS code of the goods"
                  required={required.has("hsCode")}
                  error={errors.hsCode}
                >
                  <input
                    className={fieldClass}
                    value={raw.hsCode}
                    maxLength={20}
                    onChange={(event) => update({ hsCode: event.target.value })}
                  />
                </Field>
                <Field
                  label="Rate on the supplier's invoice (%)"
                  required={required.has("goodsRatePercent")}
                  error={errors.goodsRatePercent}
                >
                  <input
                    className={fieldClass}
                    inputMode="decimal"
                    value={raw.goodsRatePercent}
                    onChange={(event) =>
                      update({ goodsRatePercent: event.target.value })
                    }
                  />
                </Field>
              </>
            ) : (
              <>
                <CpcPicker
                  key={editingId ?? "new"}
                  value={raw.cpc}
                  error={errors.cpc}
                  required={required.has("cpc")}
                  onPick={(code) => update({ cpc: code })}
                />
                <RateFields
                  cpc={raw.cpc}
                  rateId={raw.rateId}
                  date={dateForRates}
                  raw={raw}
                  errors={errors}
                  required={required}
                  onChange={update}
                />
              </>
            )}

            <Field
              label="Value excluding sales tax (Rs)"
              required={required.has("valueExclTax")}
              error={errors.valueExclTax}
            >
              <input
                className={fieldClass}
                inputMode="decimal"
                value={raw.valueExclTax}
                placeholder="0.00"
                onChange={(event) =>
                  update({ valueExclTax: event.target.value })
                }
              />
            </Field>
            <Field
              label="Sales tax (Rs)"
              required={required.has("salesTax")}
              error={errors.salesTax}
              hint="Filled in from the rate. Change it if your invoice shows a different amount (within Rs 1 of the rate)."
            >
              <input
                className={fieldClass}
                inputMode="decimal"
                value={raw.salesTax}
                placeholder="0.00"
                onChange={(event) => {
                  setTaxTyped(true);
                  update({ salesTax: event.target.value });
                }}
              />
            </Field>

            {kind === "SALES" ? (
              <Field
                label="Tax withheld by the buyer (Rs)"
                error={errors.stWithheld}
                hint="Only when the buyer is a withholding agent and withheld part of the tax."
              >
                <input
                  className={fieldClass}
                  inputMode="decimal"
                  value={raw.stWithheld}
                  placeholder="0.00"
                  onChange={(event) =>
                    update({ stWithheld: event.target.value })
                  }
                />
              </Field>
            ) : (
              <>
                <Field
                  label="Tax that cannot be claimed (Rs)"
                  error={errors.nonCreditable}
                  hint="Leave blank when all the tax can be claimed."
                >
                  <input
                    className={fieldClass}
                    inputMode="decimal"
                    value={raw.nonCreditable}
                    placeholder="0.00"
                    onChange={(event) =>
                      update({ nonCreditable: event.target.value })
                    }
                  />
                </Field>
                {(raw.supplierType === "UNREGISTERED"
                  ? false
                  : raw.nonCreditable !== "") && (
                  <Field
                    label="Why it cannot be claimed"
                    required={required.has("nonCreditableReason")}
                    error={errors.nonCreditableReason}
                  >
                    <select
                      className={fieldClass}
                      value={raw.nonCreditableReason}
                      onChange={(event) =>
                        update({ nonCreditableReason: event.target.value })
                      }
                    >
                      <option value="">Choose…</option>
                      {SRB_NON_CREDITABLE_REASONS.map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field
                  label="Tax you withheld as withholding agent (Rs)"
                  error={errors.stWithheldAsAgent}
                  hint="Only when you withheld part of the tax when paying this supplier."
                >
                  <input
                    className={fieldClass}
                    inputMode="decimal"
                    value={raw.stWithheldAsAgent}
                    placeholder="0.00"
                    onChange={(event) =>
                      update({ stWithheldAsAgent: event.target.value })
                    }
                  />
                </Field>
              </>
            )}

            {isNote && (
              <>
                <Field
                  label="Original invoice number"
                  required={required.has("originalDocNo")}
                  error={errors.originalDocNo}
                >
                  <input
                    className={fieldClass}
                    value={raw.originalDocNo}
                    maxLength={40}
                    onChange={(event) =>
                      update({ originalDocNo: event.target.value })
                    }
                  />
                </Field>
                <Field
                  label="Reason"
                  required={required.has("reason")}
                  error={errors.reason}
                >
                  <input
                    className={fieldClass}
                    value={raw.reason}
                    maxLength={120}
                    onChange={(event) => update({ reason: event.target.value })}
                  />
                </Field>
              </>
            )}
          </div>

          {formError && (
            <p role="alert" className={cn("text-sm text-destructive")}>
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
              Save {heading.noun}
            </Button>
            {editingId === null && (
              <Button
                type="button"
                size="sm"
                variant="outline"
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
    </div>
  );
}
