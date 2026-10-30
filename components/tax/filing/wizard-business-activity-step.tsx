"use client";
import { BUSINESS_ACTIVITIES } from "@/lib/tax/business-activity";
import { StepHeading } from "@/components/tax/wizard-ui";
import { TY2026_BUSINESS_PROFIT_SUBCATEGORY, type Ty2026IncomeSelectionInput } from "@/lib/tax/rules/ty2026/subcategories";
export function WizardBusinessActivityStep({ selections, onToggle, onDetailsChange }: {
  selections: Ty2026IncomeSelectionInput[];
  onToggle: (selection: Ty2026IncomeSelectionInput) => void;
  onDetailsChange: (selection: Ty2026IncomeSelectionInput) => void;
}) {
  const current = selections.find(s => s.source === "business" && s.subcategory === TY2026_BUSINESS_PROFIT_SUBCATEGORY);
  const selected = current?.details?.businessActivities ?? [];
  return <div className="space-y-5">
    <StepHeading title="About your business" description="Select every activity that applies. Upload your records next; yearly figures come from reviewed documents, not a second manual form." />
    <div className="space-y-2">{BUSINESS_ACTIVITIES.map(activity => <label key={activity.id} className="flex cursor-pointer items-start gap-3 rounded-xl border p-4">
      <input type="checkbox" checked={selected.includes(activity.id)} onChange={() => {
        const businessActivities = selected.includes(activity.id) ? selected.filter(v => v !== activity.id) : [...selected, activity.id];
        const next: Ty2026IncomeSelectionInput = { source: "business", subcategory: TY2026_BUSINESS_PROFIT_SUBCATEGORY, details: { ...current?.details, businessActivities } };
        if (current) onDetailsChange(next); else onToggle(next);
      }} /><span><strong>{activity.label}</strong><span className="mt-1 block text-sm text-muted-foreground">{activity.documents}</span></span>
    </label>)}</div>
    <div className="rounded-xl border bg-muted/30 p-4 text-sm">
      <p className="font-medium">Your document plan</p>
      <p>Upload business books / income and expense records, the relevant year-end balance sheet, and statements for declared business bank accounts. A detailed accounting pack can cover several requirements.</p>
      <ul className="mt-2 list-disc pl-5">{BUSINESS_ACTIVITIES.filter(a => selected.includes(a.id)).map(a => <li key={a.id}>{a.documents}</li>)}</ul>
      <p className="mt-2">Only when applicable: withholding certificates, asset/depreciation schedules, vehicle records and previous loss workings. Missing or conflicting facts will need evidence or confirmation after upload. This selection does not determine your tax regime or FBR principal-activity code.</p>
    </div>
  </div>;
}
