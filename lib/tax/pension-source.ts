import { createHash } from "node:crypto";
import { netMoney } from "@/lib/money";
import {
  readReviewedPensionStatement,
  pensionProfileErrors,
} from "./pension-statement-fields";
import { assessPensionerAge } from "./taxpayer-age";
import { calculateTaxEstimate } from "./tax-calculation";

export const PENSION_SOURCE_VERSION = "pension-source-v1";
export type PensionTreatment =
  | "exempt"
  | "exempt_age70"
  | "salary"
  | "final_above_10m"
  | "unknown_age";
export type PensionSource = {
  version: typeof PENSION_SOURCE_VERSION;
  documentId: string;
  fingerprint: string;
  annualPension: number;
  grossAnnual: number;
  medicalAnnual: number | null;
  netAnnual: number | null;
  reviewNote: string;
  ledgerPension: number;
  taxDeducted: number;
  taxAlreadyInLedger: number;
  /** Plain words when the ledger overlap was recognised without asking. */
  overlapNote: string | null;
  creditToAdd: number;
  treatment: PensionTreatment;
  ageBracket: string;
  baseTax: number | null;
  surcharge: number | null;
  taxDue: number | null;
};
export function resolveApprovedPensionSource(input: {
  document: {
    id: string;
    extractionStatus: string;
    extractedData: string | null;
  } | null;
  taxYear: number;
  profile: { dateOfBirth?: Date | null; cnic?: string | null };
  taxAsSalary: boolean;
  ledgerPension: number;
  ledgerTaxWithheld: number;
  hasOtherIncomeSources?: boolean;
}): PensionSource {
  const doc = input.document;
  if (!doc || doc.extractionStatus !== "MAPPED")
    throw new Error(
      "Review and approve/map the latest Pension Statement before calculating. An uploaded or extracted statement is not an approved annual pension tax base.",
    );
  const hasOtherIncomeSources = input.hasOtherIncomeSources === true;
  const statement = readReviewedPensionStatement(
    doc.extractedData,
    input.taxYear,
    {
      ledgerTaxWithheld: input.ledgerTaxWithheld,
      hasOtherIncomeSources,
    },
  );
  const errors = pensionProfileErrors(statement, input.profile);
  if (statement.taxAlreadyInLedger > input.ledgerTaxWithheld)
    errors.push(
      "The pension withholding marked as already in the tax ledger exceeds current TAX_PAYMENT entries. Review the pension withholding allocation.",
    );
  if (errors.length) throw new Error(errors.join(" · "));
  const age = assessPensionerAge({
    taxYear: input.taxYear,
    dateOfBirth: input.profile.dateOfBirth ?? null,
  });
  const treatment: PensionTreatment = input.taxAsSalary
    ? "salary"
    : statement.approvedAnnual <= 10_000_000
      ? "exempt"
      : age.bracket === "SEVENTY_OR_ABOVE"
        ? "exempt_age70"
        : age.isBelow70
          ? "final_above_10m"
          : "unknown_age";
  const estimate = calculateTaxEstimate({
    taxYear: input.taxYear,
    filerStatus: "ATL",
    totalIncome: statement.approvedAnnual,
    totalExpenses: 0,
    taxWithheld: 0,
    isSalariedRoute: false,
    isBankProfitRoute: false,
    incomeSources: [{ route: "pension", income: statement.approvedAnnual }],
    pensionTaxAsSalary: input.taxAsSalary,
    pensionerAgeBelow70: age.isBelow70,
    pensionerAge70OrAbove: age.bracket === "SEVENTY_OR_ABOVE",
    pensionerAgeReason: age.reason,
  });
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        version: PENSION_SOURCE_VERSION,
        reviewPolicy: "pension-review-v2-conditional-note",
        documentId: doc.id,
        extractedData: doc.extractedData,
        taxYear: input.taxYear,
        profileDOB:
          input.profile.dateOfBirth?.toISOString().slice(0, 10) ?? null,
        profileCnic: input.profile.cnic ?? null,
        taxAsSalary: input.taxAsSalary,
        ledgerPension: input.ledgerPension,
        ledgerTaxWithheld: input.ledgerTaxWithheld,
        ...(hasOtherIncomeSources ? { hasOtherIncomeSources: true } : {}),
      }),
    )
    .digest("hex");
  return {
    version: PENSION_SOURCE_VERSION,
    documentId: doc.id,
    fingerprint,
    annualPension: statement.approvedAnnual,
    grossAnnual: statement.grossAnnual,
    medicalAnnual: statement.medicalAnnual,
    netAnnual: statement.netAnnual,
    reviewNote: statement.reviewNote,
    ledgerPension: input.ledgerPension,
    taxDeducted: statement.taxDeducted,
    taxAlreadyInLedger: statement.taxAlreadyInLedger,
    overlapNote: statement.overlapNote,
    creditToAdd: netMoney([
      { value: statement.taxDeducted },
      { value: statement.taxAlreadyInLedger, subtract: true },
    ]),
    treatment,
    ageBracket: age.bracket,
    baseTax: estimate.baseTax,
    surcharge: estimate.surcharge,
    taxDue: estimate.taxDue,
  };
}
