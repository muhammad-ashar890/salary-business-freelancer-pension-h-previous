/** Activity guides document intake, never determines a tax regime or legal structure. */
export const BUSINESS_ACTIVITIES = [
  { id: "trading", label: "Trading / retail / wholesale", documents: "Sales and purchase registers; opening/closing stock; expense records." },
  { id: "manufacturing", label: "Manufacturing", documents: "Sales, raw-material and production-cost schedules; inventory; expense records." },
  { id: "services", label: "Services / professional practice", documents: "Client invoices or fee register; receipt and expense records." },
  { id: "exports", label: "Freelancing / IT / exports", documents: "Client/platform statements, invoices and relevant remittance/export evidence." },
  { id: "contracting", label: "Construction / contracts", documents: "Contracts, billing/payment certificates and project-cost records." },
  { id: "development", label: "Property building / development", documents: "Project, land/construction and sales/receipt schedules; specialist regime review may be needed." },
  { id: "other", label: "Other / unsure", documents: "Upload available business records; confirm the activity during document review." },
] as const;
export type BusinessActivity = typeof BUSINESS_ACTIVITIES[number]["id"];
export function sanitizeBusinessActivities(value: unknown): BusinessActivity[] | null {
  if (!Array.isArray(value) || value.length > BUSINESS_ACTIVITIES.length || value.some(v => !BUSINESS_ACTIVITIES.some(a => a.id === v))) return null;
  return [...new Set(value)] as BusinessActivity[];
}
