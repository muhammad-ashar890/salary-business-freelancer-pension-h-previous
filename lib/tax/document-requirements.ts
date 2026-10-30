import type { TaxIncomeSource, TaxReadinessItem } from "./filing-drafts";

// Demo stand-in for your real `@/lib/tax/document-requirements` module.
// Real logic differs; this reproduces the shape/behaviour closely enough
// for the wizard's live document checklist to feel real.

const DOC_MAP: Record<
  TaxIncomeSource,
  { documentType: string; label: string; reason: string; required?: boolean }[]
> = {
  imports: [
    {
      documentType: "import_tax_document",
      label: "Import / Customs Tax Documents",
      reason: "Required for Section 148 import categories.",
    },
  ],
  salary: [
    {
      documentType: "salary_certificate",
      label: "Salary Certificate",
      reason:
        "Required to source annual gross salary and Section 149 withholding; gross pay feeds the salary tax base/IRIS salary row, and tax deducted feeds IRIS Tax Deductions row 64020004.",
    },
  ],
  pension: [
    {
      documentType: "pension_statement",
      label: "Pension Statement",
      reason: "Required for pension income.",
    },
  ],
  property_rent: [
    {
      documentType: "rent_agreement",
      label: "Rent Agreement / Receipts",
      reason: "Required for rental income.",
    },
  ],
  services: [
    {
      documentType: "invoice_summary",
      label: "Invoices / Service Income Summary",
      reason: "Required for freelance/services income.",
    },
    {
      documentType: "other_income_proof",
      label: "Freelancer Withholding Tax Certificate / Proof (Optional)",
      reason:
        "Upload client withholding tax certificate, bank tax statement, or CPR (Section 154A / 153(1)(b)) to support withholding tax deductions.",
      required: false,
    },
    {
      documentType: "pseb_certificate",
      label: "PSEB Registration Certificate (Optional)",
      reason:
        "Upload Pakistan Software Export Board (PSEB) registration certificate to claim the 0.25% concessional final tax rate on IT export remittances u/s 154A (otherwise 1.0%).",
      required: false,
    },
  ],
  bank_profit: [
    {
      documentType: "bank_certificate",
      label: "Bank Profit Certificate",
      reason: "Required for bank profit income.",
    },
  ],
  dividend: [
    {
      documentType: "dividend_certificate",
      label: "Dividend Certificate",
      reason: "Required for dividend income.",
    },
  ],
  capital_gains: [
    {
      documentType: "cgt_statement",
      label: "Capital Gains Statement",
      reason: "Required for capital gains.",
    },
  ],
  business: [
    { documentType: "business_support", label: "Business profile / supporting schedules (optional)", required: false, reason: "Optional registration/profile, asset or tax schedules. Available facts can also come from Books or Balance Sheet. No document? Enter only missing details after upload." },
    {
      documentType: "business_books",
      label: "Business Books / Sales Records",
      reason: "Required for business income.",
    },
    {
      // Required (16-Oct): FBR's business return includes the Balance Sheet
      // (Annex-B). Every row is a required review field (0 allowed, blank
      // not); see lib/tax/document-review-required.ts.
      documentType: "business_balance_sheet",
      label: "Business Balance Sheet",
      reason:
        "Required for business income (FBR's business return includes it). Upload PDF/JPG/PNG; on review fill every row (0 if the business has none) and press Save & Approve Map. Verified figures enter FBR; land and building stay manual.",
    },
  ],
  agriculture: [
    {
      documentType: "agri_record",
      label: "Agriculture Income Record",
      reason: "Required for agriculture income.",
    },
  ],
  foreign_income_assets: [
    {
      documentType: "foreign_asset_statement",
      label: "Foreign Asset / Income Statement",
      reason: "Required for foreign income or assets.",
    },
    {
      documentType: "pseb_certificate",
      label: "PSEB Registration Certificate (Optional)",
      reason:
        "Upload Pakistan Software Export Board (PSEB) registration certificate to claim the 0.25% concessional final tax rate on IT export remittances u/s 154A (otherwise 1.0%).",
      required: false,
    },
  ],
  aop_company_links: [
    {
      documentType: "aop_company_proof",
      label: "AOP / Company Membership Proof",
      reason: "Required for AOP or company links.",
    },
  ],
  sales_tax_fed_withholding: [
    {
      documentType: "sales_tax_return",
      label: "Sales Tax / FED Return",
      reason: "Required for indirect tax obligations.",
    },
  ],
  other_income: [
    {
      documentType: "other_income_proof",
      label: "Other Income Proof",
      reason: "Required for miscellaneous income.",
    },
  ],
  advance_tax: [
    {
      documentType: "advance_tax_evidence",
      label: "Advance Tax Evidence / CPR",
      reason: "Required for selected TY2026 advance-tax transactions.",
    },
  ],
};

const CORE_DOCS: {
  documentType: string;
  label: string;
  reason: string;
  required?: boolean;
}[] = [
  {
    documentType: "cnic",
    label: "CNIC Copy",
    reason: "Always required for identity verification.",
  },
  {
    documentType: "bank_statement",
    label: "Bank Statement (12 months)",
    reason: "Used for wealth reconciliation (Mizan).",
  },
  {
    // Optional for every filing (Phase 1 of previous-return carry-forward):
    // the slot only collects and stores the document for now. Extraction of
    // the previous wealth (opening net assets / asset list) and its use in
    // reconciliation come in a later phase, so the slot must never gate a
    // filing — first-time filers have no previous return to upload.
    documentType: "previous_return",
    label: "Previous Year Tax Return (Optional)",
    reason:
      "Upload last year's filed return as printed from FBR IRIS (PDF, including the Wealth Statement). It is kept with this filing so your previous wealth (opening net assets) can be carried into this year's wealth statement. Skip this if you are filing for the first time.",
    required: false,
  },
];

export function buildTaxDocumentSlotsPreview(input: {
  incomeSources: TaxIncomeSource[];
  readinessCompleted: TaxReadinessItem[];
}) {
  const requiredTypes = new Set(
    getRequiredTaxDocumentTypesForCurrentFlow({
      incomeSources: input.incomeSources,
    }),
  );

  const slots = [
    ...CORE_DOCS.map((d) => ({ ...d, required: d.required !== false })),
    ...input.incomeSources.flatMap(
      (source) =>
        DOC_MAP[source]?.map((d) => ({
          ...d,
          required: requiredTypes.has(d.documentType),
        })) ?? [],
    ),
  ];

  // De-duplicate by documentType
  const seen = new Set<string>();
  return slots.filter((slot) => {
    if (seen.has(slot.documentType)) return false;
    seen.add(slot.documentType);
    return true;
  });
}

export function getRequiredTaxDocumentTypesForCurrentFlow(input: {
  incomeSources: TaxIncomeSource[];
}) {
  const required = new Set<string>(
    CORE_DOCS.filter((d) => d.required !== false).map((d) => d.documentType),
  );
  for (const source of input.incomeSources) {
    for (const doc of DOC_MAP[source] ?? []) {
      if (doc.required !== false) required.add(doc.documentType);
    }
  }
  return Array.from(required);
}
