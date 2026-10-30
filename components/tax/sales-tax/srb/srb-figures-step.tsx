"use client";

import { Plus, Trash2 } from "lucide-react";

import { StepHeading } from "@/components/tax/wizard-ui";
import { Button } from "@/components/ui/button";
import { firstDayOfMonth, lastDayOfMonth } from "@/lib/sales-tax/dates";
import {
  MAX_SRB_EXPORTS,
  SRB_FIGURE_FIELDS,
  type SrbExportForm,
  type SrbFiguresForm,
} from "@/lib/sales-tax/srb";

const inputClass =
  "h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-amanah focus:ring-2 focus:ring-amanah/20";

const EMPTY_EXPORT: SrbExportForm = { buyerName: "", country: "", cpc: "", docNo: "", docDate: "", amountPkr: "" };

const GROUPS: { group: (typeof SRB_FIGURE_FIELDS)[number]["group"]; title: string; description: string }[] = [
  { group: "credit", title: "Credit and adjustments", description: "Amounts in rupees. Blank means zero." },
  { group: "capital", title: "Capital goods (Annex-E)", description: "Only if you bought capital goods or fixed assets." },
  { group: "penalty", title: "Additional tax, arrears and penalty", description: "Only if you are paying these with this return." },
];

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function SrbFiguresStep({
  stepNumber,
  form,
  onChange,
  period,
}: {
  stepNumber: number;
  form: SrbFiguresForm;
  onChange: (next: SrbFiguresForm) => void;
  period: { year: number; month: number };
}) {
  const setExport = (index: number, patch: Partial<SrbExportForm>) =>
    onChange({ ...form, exports: form.exports.map((row, i) => (i === index ? { ...row, ...patch } : row)) });

  return (
    <div className="space-y-8">
      <StepHeading
        eyebrow={`Step ${stepNumber}`}
        title="Your other figures"
        description="Your invoice lines do not hold everything. Fill in what applies to you; leave the rest blank."
      />

      {GROUPS.map((group) => (
        <Section key={group.group} title={group.title} description={group.description}>
          <div className="grid gap-4 sm:grid-cols-2">
            {SRB_FIGURE_FIELDS.filter((field) => field.group === group.group).map((field) => (
              <label key={field.key} className="block space-y-1.5 text-sm font-medium text-foreground">
                <span>
                  <span className="text-muted-foreground">Row {field.sr} · </span>
                  {field.label}
                </span>
                <input
                  value={form.amounts[field.key]}
                  onChange={(event) => onChange({ ...form, amounts: { ...form.amounts, [field.key]: event.target.value } })}
                  placeholder="0.00"
                  inputMode="decimal"
                  maxLength={20}
                  className={inputClass}
                />
                <span className="block text-xs font-normal text-muted-foreground">{field.hint}</span>
              </label>
            ))}
          </div>
        </Section>
      ))}

      <Section title="Services you exported (Annex-D)" description="Services supplied to buyers outside Pakistan. Exports carry no tax; only the value is reported.">
        {form.exports.length === 0 && <p className="text-sm text-muted-foreground">No exports added.</p>}
        {form.exports.map((row, index) => (
          <div key={index} className="space-y-3 rounded-xl border bg-card p-3.5">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1 text-sm font-medium text-foreground">
                Buyer name
                <input className={inputClass} value={row.buyerName} maxLength={120} onChange={(event) => setExport(index, { buyerName: event.target.value })} />
              </label>
              <label className="block space-y-1 text-sm font-medium text-foreground">
                Country
                <input className={inputClass} value={row.country} maxLength={60} onChange={(event) => setExport(index, { country: event.target.value })} />
              </label>
              <label className="block space-y-1 text-sm font-medium text-foreground">
                Service code (CPC)
                <input className={inputClass} inputMode="numeric" value={row.cpc} maxLength={10} onChange={(event) => setExport(index, { cpc: event.target.value })} />
              </label>
              <label className="block space-y-1 text-sm font-medium text-foreground">
                Document number
                <input className={inputClass} value={row.docNo} maxLength={40} onChange={(event) => setExport(index, { docNo: event.target.value })} />
              </label>
              <label className="block space-y-1 text-sm font-medium text-foreground">
                Document date
                <input type="date" className={inputClass} value={row.docDate} min={firstDayOfMonth(period)} max={lastDayOfMonth(period)} onChange={(event) => setExport(index, { docDate: event.target.value })} />
              </label>
              <label className="block space-y-1 text-sm font-medium text-foreground">
                Amount in rupees
                <input className={inputClass} inputMode="decimal" value={row.amountPkr} placeholder="0.00" onChange={(event) => setExport(index, { amountPkr: event.target.value })} />
              </label>
            </div>
            <Button type="button" size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" onClick={() => onChange({ ...form, exports: form.exports.filter((_, i) => i !== index) })}>
              <Trash2 className="h-3.5 w-3.5" />
              Remove this export
            </Button>
          </div>
        ))}
        {form.exports.length < MAX_SRB_EXPORTS && (
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => onChange({ ...form, exports: [...form.exports, { ...EMPTY_EXPORT }] })}>
            <Plus className="h-3.5 w-3.5" />
            Add an export
          </Button>
        )}
      </Section>

      <Section title="Amended return" description="Choose this only if you are filing a revised return for a month you already filed.">
        <label className="flex items-start gap-3 rounded-xl border bg-card p-3.5 text-sm text-foreground">
          <input
            type="checkbox"
            checked={form.amended}
            onChange={(event) =>
              onChange({
                ...form,
                amended: event.target.checked,
                amounts: event.target.checked ? form.amounts : { ...form.amounts, taxPaidPrevious25: "" },
              })
            }
            className="mt-0.5 h-5 w-5 shrink-0 accent-[#376952]"
          />
          <span>This is an amended return.</span>
        </label>
        {form.amended &&
          SRB_FIGURE_FIELDS.filter((field) => field.group === "amended").map((field) => (
            <label key={field.key} className="block space-y-1.5 text-sm font-medium text-foreground">
              <span>
                <span className="text-muted-foreground">Row {field.sr} · </span>
                {field.label}
              </span>
              <input
                value={form.amounts[field.key]}
                onChange={(event) => onChange({ ...form, amounts: { ...form.amounts, [field.key]: event.target.value } })}
                placeholder="0.00"
                inputMode="decimal"
                maxLength={20}
                className={inputClass}
              />
              <span className="block text-xs font-normal text-muted-foreground">{field.hint}</span>
            </label>
          ))}
      </Section>
    </div>
  );
}
