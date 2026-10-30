import { prisma } from "@/lib/prisma";
import { sumMoney } from "@/lib/money";
import { normalizeLedgerCategory } from "./withholding-sources";
import {
  PENSION_SOURCE_VERSION,
  resolveApprovedPensionSource,
} from "./pension-source";
import {
  TY2026_PENSION_FORMER_EMPLOYER_SUBCATEGORY,
  parsePersistedSelectionUserDetails,
  resolvePensionFormerEmployerAnswer,
} from "./rules/ty2026/subcategories";

/** Read-only check immediately before dispatch/acceptance. Never repair a pinned packet. */
export async function pensionPacketValidationError(
  snapshot: any,
  filingDraftId: string,
  userId: string,
  options: { allowManual?: boolean } = {},
): Promise<string | null> {
  const sources = snapshot?.filing?.incomeSources;
  const includesPension = Array.isArray(sources) && sources.includes("pension");
  if (!includesPension && !snapshot?.pension) return null;
  if (
    snapshot?.pension?.version !== PENSION_SOURCE_VERSION ||
    !snapshot.pension.fingerprint
  )
    return "This pension packet predates reviewed annual sources. Recalculate, regenerate and approve a new pension packet; no portal entry is permitted.";
  const [draft, profile, document, entries] = await Promise.all([
    prisma.filingDraft.findFirst({
      where: { id: filingDraftId, userId },
      select: {
        taxYear: true,
        taxCalculationRevision: true,
        incomeSources: true,
        incomeSelections: {
          where: { source: "pension", status: "SELECTED" },
          select: {
            source: true,
            status: true,
            subcategory: true,
            detailsJson: true,
          },
        },
      },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { dateOfBirth: true, cnic: true },
    }),
    prisma.document.findFirst({
      where: { filingDraftId, userId, documentType: "pension_statement" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, extractionStatus: true, extractedData: true },
    }),
    prisma.ledgerEntry.findMany({
      where: { filingDraftId, userId },
      select: { category: true, entryType: true, amount: true },
    }),
  ]);
  if (
    !draft ||
    draft.taxCalculationRevision !== snapshot.filing?.taxCalculationRevision
  )
    return "The pension calculation revision changed. Recalculate and approve a fresh packet before desktop entry.";
  let liveSources: unknown;
  try {
    liveSources = JSON.parse(draft.incomeSources);
  } catch {
    return "Invalid current income selections. Recalculate the pension packet.";
  }
  if (!Array.isArray(liveSources) || !liveSources.includes("pension"))
    return "Pension was removed from current income selections. Regenerate the packet before desktop entry.";
  const selection = draft.incomeSelections.find(
    (s) =>
      s.source === "pension" &&
      s.status === "SELECTED" &&
      s.subcategory === TY2026_PENSION_FORMER_EMPLOYER_SUBCATEGORY,
  );
  const taxAsSalary = selection
    ? resolvePensionFormerEmployerAnswer({
        details:
          parsePersistedSelectionUserDetails(selection.detailsJson) ??
          undefined,
      }) === "yes"
    : false;
  const category = normalizeLedgerCategory;
  try {
    const current = resolveApprovedPensionSource({
      document,
      taxYear: draft.taxYear,
      profile: profile ?? {},
      taxAsSalary,
      ledgerPension: sumMoney(
        entries
          .filter(
            (e) =>
              e.entryType === "INCOME" && category(e.category) === "PENSION",
          )
          .map((e) => e.amount),
      ),
      ledgerTaxWithheld: sumMoney(
        entries
          .filter(
            (e) =>
              e.entryType === "EXPENSE" &&
              category(e.category) === "TAX_PAYMENT",
          )
          .map((e) => e.amount),
      ),
    });
    if (current.fingerprint !== snapshot.pension.fingerprint)
      return "Pension evidence, withholding, profile DOB/CNIC or former-employer answer changed. Recalculate and approve a new pension packet; the pinned packet cannot be reused.";
    if (
      Object.entries(current).some(
        ([key, value]) => snapshot.pension[key] !== value,
      )
    )
      return "Pension packet metadata does not match the current reviewed source. Regenerate the packet.";
    const detailed = snapshot.portalFieldMapDetailed ?? snapshot.portalFieldMap;
    if (
      detailed?.computationHints?.pensionSourceFingerprint !==
      current.fingerprint
    )
      return "Pension packet field map is not bound to its reviewed source. Regenerate the packet.";
    const fields = Array.isArray(snapshot.portalFieldMap)
      ? snapshot.portalFieldMap
      : [
          ...(Array.isArray(detailed?.incomeFields) ? detailed.incomeFields : []),
          ...(Array.isArray(detailed?.adjustableTaxFields)
            ? detailed.adjustableTaxFields
            : []),
        ];
    const match = (irisCode: string, column: string, amount: number) => {
      const rows = Array.isArray(fields)
        ? fields.filter(
            (f: any) =>
              String(f.irisCode) === irisCode && f.column === column,
          )
        : [];
      return (
        rows.length === 1 &&
        Number(rows[0].value ?? rows[0].ourAmount) === amount
      );
    };
    const treatment = current.treatment;
    if (detailed?.mappingGaps?.pensionManualReview && !options.allowManual)
      return "Manual pension portal review required: the approved source has withholding without a verified IRIS placement for this treatment.";
    if (treatment === "final_above_10m") {
      const excess = Math.max(0, current.annualPension - 10_000_000);
      const baseTax = Math.round(excess * 0.05);
      const surcharge = Math.round(baseTax * 0.1);
      if (
        current.baseTax !== baseTax ||
        current.surcharge !== surcharge ||
        current.taxDue !== baseTax + surcharge ||
        !match("1008", "Total Amount", current.annualPension) ||
        !match("1008", "Subject to Final Tax", excess) ||
        !match("1008", "Subject to Exemption", 10_000_000) ||
        !match("64020007", "Taxable Amount", excess) ||
        !match("64020007", "Tax Deducted", current.taxDeducted) ||
        !match("923184", "Total Income", surcharge)
      )
        return "Pension final-tax autofill contract is incomplete. Regenerate a reviewed packet with the PKR 10 million exemption, excess-only Final/64020007 base and Section 4AB surcharge.";
      if (detailed?.mappingGaps?.pensionManualReview && !options.allowManual)
        return "Pension final-tax packet still carries a stale manual-review gap. Regenerate the packet.";
      return null;
    }
    const expectedExempt = treatment === "salary" ? 0 : current.annualPension;
    if (
      !match("1008", "Total Amount", current.annualPension) ||
      !match("1008", "Subject to Exemption", expectedExempt) ||
      !match("1008", "Subject to Final Tax", 0)
    )
      return "Pension Total/Exemption/Final zero-clear columns are incomplete. Regenerate the packet.";
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "Review and approve the latest pension statement before desktop entry.";
  }
  return null;
}
