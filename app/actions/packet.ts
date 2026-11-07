"use server";
import { mergeReviewedBusinessSchedules } from "@/lib/tax/business-reviewed-schedules";
import { currentBusinessOwnershipStamp, businessOwnershipPacketValidationError } from "@/lib/tax/business-ownership-packet-validation";
import { checkBankOwnership, businessBankAccountRoute } from "@/lib/tax/business-bank-ownership";
import { reviewedBusinessEvidenceProblems } from "@/lib/tax/business-document-intake";
import { parsePersistedSelectionUserDetails, TY2026_PENSION_FORMER_EMPLOYER_SUBCATEGORY, resolvePensionFormerEmployerAnswer } from "@/lib/tax/rules/ty2026/subcategories";
import { resolveApprovedPensionSource, type PensionSource } from "@/lib/tax/pension-source";
import { pensionPacketValidationError } from "@/lib/tax/pension-packet-validation";

import {
  isBusinessBankCategory,
  isMyselfBusinessBankFlow,
  isSingleFreelancerServicesFiling,
} from "@/lib/tax/business-bank-categories";
import {
  buildBusinessPacket,
  readBusinessBalanceSheet,
  buildServicesTaxDeductionPacket,
  businessCoverageSummary,
  visibleBusinessPendingItems,
  type BusinessPacket,
  type ServicesTaxDeductionPacket,
} from "@/lib/tax/business-filing";
import { normalizeIban } from "@/lib/tax/business-balance-details";
import { totalDepreciationAdditions } from "@/lib/tax/business-depreciation-schedule";
import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import PDFDocument from "pdfkit";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateFilingCompleteness } from "@/lib/tax/filing-completeness";
import { isGiftCategory } from "@/lib/tax/gift-income";
import { validateAuthoritativeReconciliation } from "@/lib/tax/reconciliation-calculation";
import { approvedPreviousReturnFromDocuments } from "@/lib/tax/previous-return-fields";
import { createNotification } from "@/app/actions/notifications";
import { serializePacketMoney, sumMoney } from "@/lib/money";
import { toMoneyAmount, toMoneyNumber, type MoneyInput } from "@/lib/money";
import { isServicesLedgerCategory } from "@/lib/tax/services-income-allocation";
import { evaluateServicesIncomeEvidence } from "@/lib/tax/services-income-evidence";
import { buildServicesPortalMappings } from "@/lib/tax/services-portal-map";
import {
  buildPacketRouteMetadata,
  buildPortalFieldMap,
  describeUnmappedPortalSources,
  type PortalFieldMap,
} from "@/lib/tax/portal-field-map";
import {
  extractMappedSalaryEmployers,
  extractMappedSalaryGross,
  extractMappedSalaryWithholding,
  normalizeLedgerCategory,
} from "@/lib/tax/withholding-sources";

async function getOwnedDraft(draftId: string) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;

  if (!email) throw new Error("Unauthorized");

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, dateOfBirth: true, cnic: true },
  });

  if (!user) throw new Error("User profile not found");

  const draft = await prisma.filingDraft.findFirst({
    where: { id: draftId, userId: user.id },
    select: { id: true, userId: true },
  });

  if (!draft) throw new Error("Filing draft not found");

  return { ...draft, taxpayerDateOfBirth: user.dateOfBirth, taxpayerCnic: user.cnic };
}

function buildPacketPdf(snapshotJson: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({ margin: 48 });
    const chunks: Buffer[] = [];

    document.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);

    const snapshot = JSON.parse(snapshotJson) as {
      filing: {
        taxYear: number;
        filerType: string | null;
        businessStructure: string | null;
        residencyStatus?: string | null;
        taxpayerListStatus?: string | null;
        taxpayerListStatusSource?: string | null;
        taxRuleSetVersion?: string | null;
        taxCalculationRevision?: string | null;
        taxableIncome?: MoneyInput;
        taxPayable?: MoneyInput;
        refundDue?: MoneyInput;
        taxCalculationStatus?: string;
        reconciliationGap?: MoneyInput;
      };
      business?: BusinessPacket | ServicesTaxDeductionPacket;
      documents: { documentType: string; fileName: string }[];
      ledgerEntries: {
        entryType: string;
        category: string | null;
        description: string;
        amount: number;
      }[];
      pension?: PensionSource;
      wealthExpectations?: {
        previousYearNetAssets: {
          irisCode: string;
          expected: number;
          previousReturnTaxYear: number;
        };
      };
      /**
       * Phase 5a: the approved previous return's printed Wealth Statement rows,
       * which the agent enters as the OPENING position of IRIS 116 asset and
       * liability rows. IRIS carries forward only the 703002 figure, never the
       * rows, so without this block the operator retypes them by hand and the
       * reconciliation almost never ties out.
       *
       * Rows are the validated set (see `parsePreviousReturnWealthRows`); they
       * are balances at the previous year's closing date, NOT this year's
       * movement. `rows` is omitted when the extraction carried no rows, and
       * the agent then does nothing on this front.
       */
      wealthCarryForward?: {
        previousReturnTaxYear: number;
        totalAssets: number;
        totalLiabilities: number;
        netAssets: number;
        cashInHand: number | null;
        rows: {
          code: string;
          description: string;
          amount: number;
          detail: boolean;
        }[];
      };
      portalFieldMap?: PortalFieldMap;
      servicesIncomeEvidence?: {
        accountingMethod: "CASH" | "ACCRUAL";
        taxYear: number;
        incomeTotal: number;
        incomeBySubcategory: Record<string, number>;
        invoices: {
          invoiceNumber: string | null;
          invoiceDate: string | null;
          dueDate: string | null;
          clientName: string | null;
          serviceDescription: string | null;
          invoiceAmount: number | null;
          currency: string | null;
          subcategory: string | null;
          paymentMatches: {
            settlementDate: string | null;
            settlementCurrency: string | null;
            settlementAmount: number | null;
            grossServiceAmountPkr: number | null;
            netBankAmountPkr: number | null;
            withholdingTaxPkr: number | null;
            platformFeePkr: number | null;
            bankFeePkr: number | null;
            linkedBankCredit: { amountPkr: number };
          }[];
        }[];
      } | null;
    };

    document.fontSize(20).text("TaxRocket Filing Packet", { underline: true });
    document.moveDown();
    document.fontSize(11).text(`Tax Year: ${snapshot.filing.taxYear}`);
    document.text(`Filer: ${snapshot.filing.filerType ?? "Not specified"}`);
    document.text(
      `Business structure: ${snapshot.filing.businessStructure ?? "Not specified"}`,
    );
    document.text(
      `Residency: ${snapshot.filing.residencyStatus === "non_resident" ? "Non-Resident" : snapshot.filing.residencyStatus === "resident" ? "Resident" : "Not selected"}`,
    );
    document.text(
      `Taxpayer-list status: ${
        snapshot.filing.taxpayerListStatus === "ATL"
          ? "Filer"
          : snapshot.filing.taxpayerListStatus === "LATE_FILER"
            ? "Late Filer"
            : snapshot.filing.taxpayerListStatus === "NON_ATL"
              ? "Non-Filer"
              : "Not selected"
      }`,
    );
    document.text(
      `Status source: ${snapshot.filing.taxpayerListStatusSource ?? "Not selected"}`,
    );
    document.text(
      `Tax rule set: ${snapshot.filing.taxRuleSetVersion ?? "Not selected"}`,
    );

    document.moveDown();
    document.fontSize(14).text("Tax Summary");
    const taxCalculationReady =
      snapshot.filing.taxCalculationStatus === "ESTIMATE";
    // Converted before formatting. These come straight off the draft, where
    // they are Decimal columns, and `Decimal.toLocaleString()` does not group
    // thousands: the final packet would print "PKR 3685290" instead of
    // "PKR 3,685,290" on the document that goes to the FBR.
    const taxValue = (value?: MoneyInput) =>
      taxCalculationReady && value !== null && value !== undefined
        ? `PKR ${toMoneyNumber(value).toLocaleString()}`
        : "Pending — route-specific tax rules required";
    document
      .fontSize(11)
      .text(`Taxable income: ${taxValue(snapshot.filing.taxableIncome)}`);
    document.text(`Tax payable: ${taxValue(snapshot.filing.taxPayable)}`);
    document.text(`Refund due: ${taxValue(snapshot.filing.refundDue)}`);
    document.text(
      `Reconciliation gap: PKR ${Math.abs(
        toMoneyAmount(snapshot.filing.reconciliationGap),
      ).toLocaleString()}`,
    );
    if (snapshot.wealthExpectations?.previousYearNetAssets) {
      const pw = snapshot.wealthExpectations.previousYearNetAssets;
      document.text(
        `Previous year net assets (approved TY${pw.previousReturnTaxYear} return): PKR ${toMoneyNumber(pw.expected).toLocaleString()} — in IRIS this should appear as Net Assets Previous Year (703002); the agent only checks it and never changes it.`,
      );
    }

    if (snapshot.wealthCarryForward?.rows?.length) {
      const carry = snapshot.wealthCarryForward;
      const money = (value: number) =>
        `PKR ${toMoneyNumber(value).toLocaleString()}`;
      document.moveDown();
      document.fontSize(14).text("Previous Return Wealth Carried Forward");
      document.fontSize(10);
      document.text(
        `Source: approved Tax Year ${carry.previousReturnTaxYear} return — the position at that year's closing date, not this year's movement.`,
      );
      document.text(
        `Approved totals: assets ${money(carry.totalAssets)}, liabilities ${money(carry.totalLiabilities)}, net assets ${money(carry.netAssets)}.`,
      );
      for (const row of carry.rows) {
        document.text(
          `${row.detail ? "    " : ""}${row.code} ${row.description}: ${money(row.amount)}`,
        );
      }
      document.text(
        "How the agent uses this: every row is entered as the opening balance of the same IRIS 116 row. Cash in hand and bank balances are then updated with this year's movement, so the closing position stays continuous with last year's. Net Assets Previous Year (703002) is IRIS's own figure and is never changed.",
      );
      if (carry.cashInHand === null) {
        document.text(
          "Cash in hand was not stated in the printed return, so only the rows above are carried forward.",
        );
      }
    }

    if (snapshot.pension) {
      const pension = snapshot.pension;
      document.moveDown();
      document.fontSize(14).text("Reviewed Annual Pension Source");
      document.fontSize(10);
      const money = (value: number | null) => value === null ? "Not stated" : `PKR ${toMoneyNumber(value).toLocaleString()}`;
      document.text(`Statement gross (annual): ${money(pension.grossAnnual)}`);
      document.text(`Medical allowance (annual, no automatic tax classification): ${money(pension.medicalAnnual)}`);
      document.text(`Net payable (annual): ${money(pension.netAnnual)}`);
      document.text(`APPROVED pension tax base: ${money(pension.annualPension)}`);
      document.text(`Bank pension receipts (cash evidence only, not added again): ${money(pension.ledgerPension)}`);
      document.text(`Actual pension tax deducted: ${money(pension.taxDeducted)}; already in tax ledger: ${money(pension.taxAlreadyInLedger)}`);
      if (pension.overlapNote) {
        document.text(`Ledger overlap: ${pension.overlapNote}`);
      }
      document.text(`Treatment: ${pension.treatment}; profile age bracket: ${pension.ageBracket}`);
      document.text(pension.reviewNote ? `Reviewer decision: ${pension.reviewNote}` : "Basis: reviewed annual gross pension; no manual tax-base override.");
      if (pension.treatment === "final_above_10m") {
        document.text(`Existing app rules, before withholding/credits: base tax ${money(pension.baseTax)} + surcharge ${money(pension.surcharge)} = ${money(pension.taxDue)}. This is not independent legal certification.`);
        document.text(`IRIS packet route: 1008 classifies the annual pension as final-tax income; 64020007 carries the amount above PKR 10M and actual withholding; 923184 carries the Section 4AB surcharge.`);
      }
      const manual = snapshot.portalFieldMap?.mappingGaps?.pensionManualReview;
      if (manual) {
        document.moveDown(0.5);
        document.font("Helvetica-Bold").text("PENSION PORTAL ENTRY: MANUAL REVIEW REQUIRED");
        document.font("Helvetica").text(manual.reason);
        document.text("Verify whether 64020007 requires the full pension or the excess; do not deduct 10M twice. Tax Deducted means actual withholding, never calculated liability. Verify the portal surcharge separately. No automatic pension entry is queued and this packet cannot start desktop autofill.");
      }
    }

    if (snapshot.servicesIncomeEvidence) {
      const evidence = snapshot.servicesIncomeEvidence;
      const ensureEvidenceSpace = () => {
        if (document.y > document.page.height - 88) document.addPage();
      };
      const writeEvidenceLine = (text: string) => {
        ensureEvidenceSpace();
        document.fontSize(9).text(text);
      };
      const pkr = (value: number | null) =>
        value === null ? "not recorded" : `PKR ${toMoneyNumber(value).toLocaleString()}`;

      document.moveDown();
      document.fontSize(14).text("Services Income — Evidence Review");
      writeEvidenceLine(`Accounting method: ${evidence.accountingMethod}`);
      writeEvidenceLine(
        `Verified Services gross income for TY${evidence.taxYear}: ${pkr(evidence.incomeTotal)}`,
      );
      writeEvidenceLine(
        "Invoice and payout records support this income; they are not additional income on top of linked bank credits. Withholding is shown separately, and no tax-credit treatment is implied.",
      );
      for (const [subcategory, amount] of Object.entries(evidence.incomeBySubcategory)) {
        writeEvidenceLine(`${subcategory}: ${pkr(amount)}`);
      }
      for (const invoice of evidence.invoices) {
        ensureEvidenceSpace();
        document.moveDown(0.35);
        writeEvidenceLine(
          `Invoice ${invoice.invoiceNumber ?? "—"} | date ${invoice.invoiceDate ?? "—"} | due ${invoice.dueDate ?? "—"}`,
        );
        if (invoice.clientName) writeEvidenceLine(`Client: ${invoice.clientName}`);
        if (invoice.serviceDescription) writeEvidenceLine(`Service: ${invoice.serviceDescription}`);
        writeEvidenceLine(
          `Invoice amount: ${invoice.invoiceAmount === null ? "not recorded" : `${invoice.currency ?? "—"} ${invoice.invoiceAmount.toLocaleString()}`} | category: ${invoice.subcategory ?? "—"}`,
        );
        for (const match of invoice.paymentMatches) {
          writeEvidenceLine(
            `Payout ${match.settlementDate ?? "—"}: ${match.settlementCurrency ?? "—"} ${match.settlementAmount === null ? "not recorded" : match.settlementAmount.toLocaleString()} | linked bank credit ${pkr(match.linkedBankCredit.amountPkr)}`,
          );
          writeEvidenceLine(
            `Separate evidence — gross service: ${pkr(match.grossServiceAmountPkr)}; net bank: ${pkr(match.netBankAmountPkr)}; withholding: ${pkr(match.withholdingTaxPkr)}; platform fee: ${pkr(match.platformFeePkr)}; bank fee: ${pkr(match.bankFeePkr)}`,
          );
        }
      }
    }

    document.moveDown();
    document.fontSize(14).text("Ledger Entries");
    document.fontSize(10);
    if (snapshot.ledgerEntries.length === 0) {
      document.text("No ledger entries recorded.");
    } else {
      for (const entry of snapshot.ledgerEntries) {
        document.text(
          `${entry.entryType} | ${entry.category ?? "—"} | ${entry.description} | PKR ${toMoneyNumber(
            entry.amount,
          ).toLocaleString()}`,
        );
      }
    }

    document.moveDown();
    if (snapshot.business) {
      document.fontSize(14).text("Business");
      document.fontSize(10);
      for (const [key, value] of Object.entries(
        snapshot.business.approvedInputs,
      )) {
        document.text(
          `${key}: ${value === null ? "Not provided" : value.toLocaleString("en-PK")}`,
        );
      }
      document.text(
        `Queued verified business fields: ${snapshot.business.fields.length}`,
      );
      for (const item of visibleBusinessPendingItems(snapshot.business.pending))
        document.text(`Manual / pending: ${item.key} — ${item.reason}`);
      document.moveDown();
    }
    document.fontSize(14).text("Attached Documents");
    document.fontSize(10);
    if (snapshot.documents.length === 0) {
      document.text("No documents attached.");
    } else {
      for (const file of snapshot.documents) {
        document.text(`${file.documentType}: ${file.fileName}`);
      }
    }

    document.moveDown();
    document
      .fontSize(9)
      .fillColor("#666666")
      .text(
        "Generated by TaxRocket. This packet is a snapshot for user review.",
      );
    document.end();
  });
}

export async function getLatestFilingPacketAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const packet = await prisma.filingPacket.findFirst({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: { not: "SUPERSEDED" },
      },
      orderBy: { version: "desc" },
      select: {
        id: true,
        version: true,
        packetHash: true,
        status: true,
        approvalStatus: true,
        taxPayable: true,
        refundDue: true,
        fileUrl: true,
        createdAt: true,
        snapshotJson: true,
      },
    });

    // The mapping gaps live INSIDE the snapshot; re-reading them on fetch means the
    // practitioner sees the same "manual entry required" list on the packet step
    // whether the packet was just generated or was loaded from a previous session.
    let mappingGaps: unknown = null;
    let businessCoverage: ReturnType<typeof businessCoverageSummary> = null;
    if (packet) {
      let snapshot: {portalFieldMap?: {mappingGaps?:unknown}; business?: BusinessPacket | ServicesTaxDeductionPacket};
      try { snapshot = JSON.parse(packet.snapshotJson); }
      catch { return {success:false,error:"Invalid packet snapshot. Generate a fresh packet."}; }
      const ownershipError = await businessOwnershipPacketValidationError(snapshot,draft.id,draft.userId);
      if (ownershipError) return {success:false,error:ownershipError};
      const pensionError = await pensionPacketValidationError(snapshot, draft.id, draft.userId, { allowManual: true });
      if (pensionError) return { success: false, error: pensionError };
      businessCoverage = businessCoverageSummary(snapshot.business);
      mappingGaps = snapshot.portalFieldMap?.mappingGaps ?? null;
    }

    return {
      success: true,
      // Money leaves the database layer as a plain number: Decimal is not
      // JSON-serialisable to the client and misbehaves with `+` and `if`.
      packet: packet
        ? {
            ...serializePacketMoney(packet),
            pdfUrl: packet.fileUrl ? `/api/packets/${packet.id}` : null,
            mappingGaps,
            businessCoverage,
          }
        : null,
    };
  } catch (error) {
    console.error("Error fetching filing packet:", error);
    return { success: false, error: "Failed to fetch filing packet" };
  }
}

/**
 * `acceptUnmappedPortalSources` is the practitioner's explicit override of the
 * coverage gate: the packet is generated, the amounts that IRIS will not be filled
 * for stay listed in the snapshot, and the wizard says so. Without it the gate
 * refuses, because a packet that quietly omits priced income is worse than no
 * packet.
 */
export async function generateFilingPacketAction(
  draftId: string,
  options?: { acceptUnmappedPortalSources?: boolean },
) {
  try {
    const draft = await getOwnedDraft(draftId);
    const initialOwnership = await currentBusinessOwnershipStamp(draft.id, draft.userId);
    if (initialOwnership.error) return { success: false, error: initialOwnership.error };
    const [
      draftData,
      documents,
      ledgerEntries,
      latestPacket,
      taxCredits,
      salaryCertificate,
      pensionSelections,
      businessSelections,
      businessBalanceSheet,
      businessBooks,
    ] = await Promise.all([
      prisma.filingDraft.findUnique({
        where: { id: draft.id },
        select: {
          taxYear: true,
          status: true,
          filerType: true,
          businessStructure: true,
          residencyStatus: true,
          incomeSources: true,
          servicesAccountingMethod: true,
          readinessChecks: true,
          openingWealth: true,
          closingWealth: true,
          reconciliationGap: true,
          reconciliationStatus: true,
          reconciliationMethod: true,
          reconciliationNote: true,
          taxableIncome: true,
          taxWithheld: true,
          taxPayable: true,
          refundDue: true,
          taxCalculationStatus: true,
          taxpayerListStatus: true,
          taxpayerListStatusSource: true,
          taxpayerListStatusCheckedAt: true,
          taxRuleSetVersion: true,
          taxCalculationRevision: true,
          packetApprovalConfirmed: true,
        },
      }),
      prisma.document.findMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
        },
        select: {
          documentType: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
          extractionStatus: true,
        },
      }),
      prisma.ledgerEntry.findMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
        },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          entryDate: true,
          entryType: true,
          category: true,
          description: true,
          amount: true,
          source: true,
          sourceTransactionId: true,
          bankAccountId: true,
        },
      }),
      prisma.filingPacket.findFirst({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
        },
        orderBy: { version: "desc" },
        select: { id: true, version: true, approvalStatus: true },
      }),
      prisma.filingTaxCredit.findMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
        },
        select: {
          id: true,
          section: true,
          subcategory: true,
          amount: true,
          source: true,
          sourceDocumentId: true,
        },
      }),
      prisma.document.findFirst({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          documentType: "salary_certificate",
          extractionStatus: "MAPPED",
        },
        select: { extractedData: true },
      }),
      prisma.filingIncomeSelection.findMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          source: "pension",
        },
        select: { source: true, subcategory: true, detailsJson: true },
      }),
      prisma.filingIncomeSelection.findMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          source: "business",
        },
        select: { source: true, subcategory: true, detailsJson: true },
      }),
      prisma.document.findFirst({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          documentType: "business_balance_sheet",
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, extractedData: true, extractionStatus: true },
      }),
      prisma.document.findMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          documentType: "business_books",
          extractionStatus: "MAPPED",
        },
        select: { id: true, extractedData: true, extractionStatus: true },
      }),
    ]);

    if (!draftData) {
      return { success: false, error: "Filing draft not found" };
    }

    if (
      draftData.residencyStatus !== "resident" &&
      draftData.residencyStatus !== "non_resident"
    ) {
      return {
        success: false,
        error:
          "Missing filing context: select Resident or Non-Resident before generating the packet",
      };
    }

    if (
      draftData.taxCalculationStatus !== "ESTIMATE" ||
      !["ATL", "NON_ATL", "LATE_FILER"].includes(
        draftData.taxpayerListStatus ?? "",
      ) ||
      !draftData.taxRuleSetVersion ||
      !draftData.taxCalculationRevision
    ) {
      return {
        success: false,
        error:
          "Calculate a current tax estimate for your Filer / Late Filer / Non-Filer answer first",
      };
    }

    // Re-read authoritative document/account/statement/transaction state at
    // packet-generation time. A stale approval checkbox must never be enough
    // to create a packet after account data becomes incomplete.
    const [completeness, reconciliation] = await Promise.all([
      validateFilingCompleteness({
        draftId: draft.id,
        userId: draft.userId,
      }),
      validateAuthoritativeReconciliation({
        draftId: draft.id,
        userId: draft.userId,
      }),
    ]);
    const integrityBlockers = Array.from(
      new Set([
        ...completeness.blockers,
        ...("blockers" in reconciliation ? reconciliation.blockers : []),
      ]),
    );
    if (integrityBlockers.length > 0) {
      return { success: false, error: integrityBlockers.join(" · ") };
    }

    if (!draftData.packetApprovalConfirmed) {
      return {
        success: false,
        error: "Approve the filing data before generating the final packet",
      };
    }

    const parsedIncomeSources = JSON.parse(draftData.incomeSources) as string[];
    const freelancerEnabled = isSingleFreelancerServicesFiling({
      taxYear: draftData.taxYear,
      filerType: draftData.filerType,
      incomeSources: parsedIncomeSources,
    });
    const servicesLedgerCredits = ledgerEntries
      .filter(
        (entry) =>
          entry.entryType === "INCOME" &&
          isServicesLedgerCategory(entry.category),
      )
      .map((entry) => ({
        id: entry.id,
        amount: entry.amount,
        entryDate: entry.entryDate,
      }));
    if (servicesLedgerCredits.length > 0 && !parsedIncomeSources.includes("services")) {
      return {
        success: false,
        error:
          "Services bank credits exist but Freelancer is not selected as an income source. Review the filing setup and transaction classifications before generating a packet.",
      };
    }
    if (parsedIncomeSources.includes("services") && !freelancerEnabled) {
      return {
        success: false,
        error:
          "Services income evidence supports only TY2026 Myself filings with Services alone, exactly Salary + Services, or exactly Pension + Services. Other source combinations are unsupported, so no Services packet was generated.",
      };
    }

    const servicesData = freelancerEnabled
      ? await Promise.all([
          prisma.filingIncomeSelection.findMany({
            where: {
              filingDraftId: draft.id,
              userId: draft.userId,
              source: "services",
              status: "SELECTED",
            },
            select: { subcategory: true },
          }),
          prisma.servicesInvoiceEvidence.findMany({
            where: { filingDraftId: draft.id, userId: draft.userId },
            orderBy: [{ invoiceDate: "asc" }, { invoiceKey: "asc" }],
            include: {
              sourceDocument: {
                select: { id: true, documentType: true, fileName: true, extractionStatus: true },
              },
              paymentMatches: {
                orderBy: { createdAt: "asc" },
                include: {
                  ledgerEntry: {
                    select: { id: true, entryDate: true, description: true, amount: true },
                  },
                  evidenceDocument: {
                    select: { id: true, documentType: true, fileName: true, extractionStatus: true },
                  },
                  withholdingEvidenceDocument: {
                    select: { id: true, documentType: true, fileName: true, extractionStatus: true },
                  },
                },
              },
            },
          }),
        ])
      : null;
    const servicesIncomeSelections = servicesData?.[0] ?? [];
    const servicesInvoiceEvidence = servicesData?.[1] ?? [];
    let verifiedServicesIncome: {
      accountingMethod: "CASH" | "ACCRUAL";
      incomeTotal: number;
      incomeBySubcategory: Record<string, number>;
      incomeByInvoice: Record<string, number>;
    } | null = null;
    let servicesIncomeEvidenceSnapshot: Record<string, unknown> | null = null;
    if (freelancerEnabled) {
      if (
        servicesInvoiceEvidence.some(
          (invoice) =>
            invoice.evidenceStatus !== "CONFIRMED" ||
            invoice.sourceDocument.extractionStatus !== "MAPPED",
        )
      ) {
        return {
          success: false,
          error:
            "Review and confirm the current Services invoice evidence before generating the filing packet.",
        };
      }
      const servicesResult = evaluateServicesIncomeEvidence({
        taxYear: draftData.taxYear,
        accountingMethod: draftData.servicesAccountingMethod,
        selectedSubcategories: servicesIncomeSelections.map((item) => item.subcategory),
        invoices: servicesInvoiceEvidence,
        ledgerCredits: servicesLedgerCredits,
      });
      if (servicesResult.ok === false) {
        return {
          success: false,
          error: `Services income evidence is incomplete: ${servicesResult.errors.join(" ")}`,
        };
      }
      verifiedServicesIncome = {
        accountingMethod: servicesResult.accountingMethod,
        incomeTotal: servicesResult.incomeTotal,
        incomeBySubcategory: servicesResult.incomeBySubcategory,
        incomeByInvoice: servicesResult.incomeByInvoice,
      };
      servicesIncomeEvidenceSnapshot = {
        accountingMethod: servicesResult.accountingMethod,
        taxYear: draftData.taxYear,
        incomeTotal: servicesResult.incomeTotal,
        incomeBySubcategory: servicesResult.incomeBySubcategory,
        incomeByInvoice: servicesResult.incomeByInvoice,
        invoiceAndPayoutDataIsEvidenceNotAdditionalIncome: true,
        withholdingTreatment:
          "Captured separately; not applied as a tax credit until its statutory section and treatment are verified.",
        invoices: servicesInvoiceEvidence.map((invoice) => ({
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          invoiceDate: invoice.invoiceDate?.toISOString().slice(0, 10) ?? null,
          dueDate: invoice.dueDate?.toISOString().slice(0, 10) ?? null,
          clientName: invoice.clientName,
          serviceDescription: invoice.serviceDescription,
          invoiceAmount: invoice.invoiceAmount === null ? null : Number(invoice.invoiceAmount),
          currency: invoice.currency,
          exchangeRateToPkr: invoice.exchangeRateToPkr === null ? null : Number(invoice.exchangeRateToPkr),
          fxEvidenceReference: invoice.fxEvidenceReference,
          subcategory: invoice.subcategory,
          serviceCategoryHumanConfirmed: invoice.serviceCategoryHumanConfirmed,
          serviceCategoryEvidenceReference: invoice.serviceCategoryEvidenceReference,
          incomeCharacter: invoice.incomeCharacter,
          incomeCharacterHumanConfirmed: invoice.incomeCharacterHumanConfirmed,
          incomeCharacterEvidenceReference: invoice.incomeCharacterEvidenceReference,
          paymentStatus: invoice.paymentStatus,
          evidenceStatus: invoice.evidenceStatus,
          sourceDocument: {
            id: invoice.sourceDocument.id,
            fileName: invoice.sourceDocument.fileName,
            extractionStatus: invoice.sourceDocument.extractionStatus,
          },
          paymentMatches: invoice.paymentMatches.map((match) => ({
            ledgerEntryId: match.ledgerEntryId,
            settlementDate: match.settlementDate?.toISOString().slice(0, 10) ?? null,
            settlementCurrency: match.settlementCurrency,
            settlementAmount: match.settlementAmount === null ? null : Number(match.settlementAmount),
            settlementExchangeRateToPkr: match.settlementExchangeRateToPkr === null ? null : Number(match.settlementExchangeRateToPkr),
            invoiceCurrencyAmount: match.invoiceCurrencyAmount === null ? null : Number(match.invoiceCurrencyAmount),
            exchangeRateToPkr: match.exchangeRateToPkr === null ? null : Number(match.exchangeRateToPkr),
            grossServiceAmountPkr: match.grossServiceAmountPkr === null ? null : Number(match.grossServiceAmountPkr),
            netBankAmountPkr: match.netBankAmountPkr === null ? null : Number(match.netBankAmountPkr),
            withholdingTaxPkr: match.withholdingTaxPkr === null ? null : Number(match.withholdingTaxPkr),
            withholdingSection: match.withholdingSection,
            withholdingIrisCode: match.withholdingIrisCode,
            withholdingEvidenceReference: match.withholdingEvidenceReference,
            withholdingEvidenceHumanConfirmed: match.withholdingEvidenceHumanConfirmed,
            withholdingEvidenceDocumentId: match.withholdingEvidenceDocumentId,
            withholdingEvidenceDocumentExtractionStatus: match.withholdingEvidenceDocument?.extractionStatus ?? null,
            withholdingEvidenceDocumentType: match.withholdingEvidenceDocument?.documentType ?? null,
            platformFeePkr: match.platformFeePkr === null ? null : Number(match.platformFeePkr),
            bankFeePkr: match.bankFeePkr === null ? null : Number(match.bankFeePkr),
            payoutReference: match.payoutReference,
            evidenceReference: match.evidenceReference,
            recordStatus: match.recordStatus,
            linkedBankCredit: {
              entryDate: match.ledgerEntry.entryDate?.toISOString().slice(0, 10) ?? null,
              description: match.ledgerEntry.description,
              amountPkr: Number(match.ledgerEntry.amount),
            },
            payoutEvidenceDocument: match.evidenceDocument
              ? { fileName: match.evidenceDocument.fileName, extractionStatus: match.evidenceDocument.extractionStatus }
              : null,
            withholdingEvidenceDocument: match.withholdingEvidenceDocument
              ? {
                  fileName: match.withholdingEvidenceDocument.fileName,
                  documentType: match.withholdingEvidenceDocument.documentType,
                  extractionStatus: match.withholdingEvidenceDocument.extractionStatus,
                }
              : null,
          })),
        })),
      };
    }

    const parsedReadinessChecks = JSON.parse(
      draftData.readinessChecks,
    ) as string[];
    const salaryCertificateTaxWithheld = extractMappedSalaryWithholding(
      salaryCertificate?.extractedData ?? null,
    );
    const salaryCertificateGrossSalary = extractMappedSalaryGross(
      salaryCertificate?.extractedData ?? null,
    );

    const bankAccountsForPacket = await prisma.bankAccount.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      select: { id: true, iban: true },
    });

    // A gift's donor number lives on the bank transaction it came from; the
    // ledger entry only points back at it.
    const giftSourceIds = ledgerEntries
      .filter((e) => isGiftCategory(e.category) && e.sourceTransactionId)
      .map((e) => e.sourceTransactionId as string);
    const giftDonorByTransaction = new Map<string, string | null>(
      giftSourceIds.length === 0
        ? []
        : (
            await prisma.bankTransaction.findMany({
              where: {
                id: { in: giftSourceIds },
                filingDraftId: draft.id,
                userId: draft.userId,
              },
              select: { id: true, giftDonorId: true },
            })
          ).map((t) => [t.id, t.giftDonorId] as [string, string | null]),
    );

    // 16-Oct: a business bank account's balance on 30 June is the closing
    // balance of its mapped statement - the same account balances the
    // reconciliation and the Wealth Statement rows use.
    const bankStatementBalances =
      "preview" in reconciliation && reconciliation.preview
        ? reconciliation.preview.accountBalances.flatMap((balance) => {
            const account = bankAccountsForPacket.find(
              (candidate) => candidate.id === balance.bankAccountId,
            );
            return account?.iban
              ? [{ iban: account.iban, closingBalance: Number(balance.closingBalance) }]
              : [];
          })
        : [];

    let reviewedBusinessBooks = businessBooks;
    if (draftData.taxYear === 2026 && draftData.filerType === "myself" && parsedIncomeSources.includes("business")) {
      const currentEvidence = await prisma.document.findMany({where:{filingDraftId:draft.id,userId:draft.userId,documentType:{in:["business_books","business_balance_sheet","business_support","bank_statement"]}},select:{id:true,documentType:true,extractionStatus:true,extractedData:true}});
      const combinedSchedules=mergeReviewedBusinessSchedules(businessBooks.map(book=>({...book,documentType:"business_books"})),currentEvidence);
      if(combinedSchedules.issues.length) return {success:false,error:combinedSchedules.issues.map(issue=>issue.text).join(" ")};
      reviewedBusinessBooks=combinedSchedules.books;
      const savedBusiness = businessSelections.find(selection => selection.source === "business" && selection.subcategory === "profit-return");
      const evidenceProblems = reviewedBusinessEvidenceProblems(currentEvidence,parsePersistedSelectionUserDetails(savedBusiness?.detailsJson ?? null) ?? {});
      if(evidenceProblems.length) return {success:false,error:evidenceProblems.map(problem=>problem.text).join(" ")};
    }

    let business: BusinessPacket;
    try {
      business = buildBusinessPacket({
        taxYear: draftData.taxYear,
        filerType: draftData.filerType,
        incomeSources: parsedIncomeSources,
        selections: businessSelections,
        balanceSheet: businessBalanceSheet,
        books: reviewedBusinessBooks,
        bankStatementBalances,
      });
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Review the business schedules before generating a new packet.",
      };
    }
    // Revalidate against authoritative owned accounts and current business evidence;
    // the browser's review screen alone must never authorize a packet.
    if (draftData.taxYear === 2026 && draftData.filerType === "myself" && parsedIncomeSources.includes("business")) {
      const selected = businessSelections.find(selection => selection.source === "business" && selection.subcategory === "profit-return");
      const details = parsePersistedSelectionUserDetails(selected?.detailsJson ?? null) ?? {};
      const review = checkBankOwnership({accounts:bankAccountsForPacket, decisions:details.businessBankOwnershipDecisions ?? [],
        reviewedBusinessIbans: (business?.balanceDetails?.banks ?? []).map(row=>row.iban)});
      if (!review.ready) return {success:false,error:"Confirm each bank account's ownership in Business data review and resolve mixed or conflicting accounts before generating a packet."};
    }
    const businessBankEntries = ledgerEntries.filter((entry) =>
      isBusinessBankCategory(entry.category),
    );
    const businessBankAccountIds = new Set(
      businessBankEntries.map((entry) => entry.bankAccountId).filter(Boolean),
    );
    const unscopedBusinessBankEntries = businessBankEntries.some(
      (entry) => !entry.bankAccountId,
    );
    let pensionSource: PensionSource | null = null;
    if (parsedIncomeSources.includes("pension")) {
      const latestPensionStatement = await prisma.document.findFirst({
        where: { filingDraftId: draft.id, userId: draft.userId, documentType: "pension_statement" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, extractionStatus: true, extractedData: true },
      });
      const formerEmployerSelection = pensionSelections.find(s => s.subcategory === TY2026_PENSION_FORMER_EMPLOYER_SUBCATEGORY);
      const taxAsSalary = formerEmployerSelection
        ? resolvePensionFormerEmployerAnswer({ details: parsePersistedSelectionUserDetails(formerEmployerSelection.detailsJson) ?? undefined }) === "yes"
        : false;
      const category = normalizeLedgerCategory;
      try {
        pensionSource = resolveApprovedPensionSource({
          document: latestPensionStatement, taxYear: draftData.taxYear,
          profile: { dateOfBirth: draft.taxpayerDateOfBirth, cnic: draft.taxpayerCnic },
          taxAsSalary,
          ledgerPension: sumMoney(ledgerEntries.filter(e => e.entryType === "INCOME" && category(e.category) === "PENSION").map(e => e.amount)),
          ledgerTaxWithheld: sumMoney(ledgerEntries.filter(e => e.entryType === "EXPENSE" && category(e.category) === "TAX_PAYMENT").map(e => e.amount)),
        });
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Review the latest Pension Statement." };
      }
      if (pensionSource.treatment === "unknown_age") return { success: false, error: "Confirm profile/CNIC date of birth and recalculate the above-10M pension before generating a packet." };
      // Bind the current source, Yes/No answer and profile age to the exact
      // calculation revision. Never generate a new map around old tax totals.
      const lines = await prisma.filingTaxCalculationLine.findMany({
        where: { filingDraftId: draft.id, userId: draft.userId, calculationRevision: draftData.taxCalculationRevision, source: { in: ["pension", "combined_slab"] } },
        select: { detailsJson: true },
      });
      const currentFingerprint = pensionSource.fingerprint;
      const matchesSource = lines.some(line => {
        try { return JSON.parse(line.detailsJson).pensionSource?.fingerprint === currentFingerprint; } catch { return false; }
      });
      if (!matchesSource) return { success: false, error: "Pension source, profile age or answer changed (or this is an older calculation). Recalculate Tax and approve a fresh pension packet." };
    }

    // DP-2: an IBAN declared as a business account is typed by the agent in
    // the Business Balance Sheet (3320). It is never also written as a
    // personal Wealth Statement bank row (7030 is "Non-Business").
    const declaredBusinessIbans = new Set(
      (business?.balanceDetails?.banks ?? []).map((row) => normalizeIban(row.iban)),
    );
    // A personal balance used for business payments is safe for 7030 only in
    // the narrow explicitly-confirmed, fully reviewed zero-business-bank case.
    // Anything less certain preserves the original hold, never a guessed split.
    const businessOwnershipDetails = parsePersistedSelectionUserDetails(
      businessSelections.find(selection => selection.source === "business" && selection.subcategory === "profit-return")?.detailsJson ?? null,
    );
    let businessSheetForOwnership: ReturnType<typeof readBusinessBalanceSheet> | null = null;
    if (businessBalanceSheet?.extractionStatus === "MAPPED") {
      try { businessSheetForOwnership = readBusinessBalanceSheet(businessBalanceSheet.extractedData, draftData.taxYear); } catch { /* keep hold */ }
    }
    const bankRoute = (account: {id:string;iban:string|null} | undefined) => account ? businessBankAccountRoute({
      account, declaredBusinessIbans:[...declaredBusinessIbans], linkedBusinessActivity:businessBankAccountIds.has(account.id),
      hasUnscopedBusinessEntries:unscopedBusinessBankEntries, decisions:businessOwnershipDetails?.businessBankOwnershipDecisions ?? [],
      businessSheetBank:businessSheetForOwnership?.amounts.bank ?? null, businessSheetGaps:businessSheetForOwnership?.gaps ?? ["unreviewed"],
    }) : "held";
    const ownershipStillOpen = unscopedBusinessBankEntries || [...businessBankAccountIds].some(id => bankRoute(bankAccountsForPacket.find(account => account.id === id)) === "held");
    const businessDepreciationAdditionsTotal = totalDepreciationAdditions(
      business?.depreciation?.schedule ?? [],
    );
    // Every bank credit claimed by a Services invoice payment match is already
    // carried by the Services evidence rows; its ledger row must not become a
    // second manual income gap.
    const servicesCoveredLedgerEntryIds = verifiedServicesIncome
      ? Array.from(
          new Set(
            servicesInvoiceEvidence.flatMap((invoice) =>
              invoice.paymentMatches.map((match) => match.ledgerEntryId),
            ),
          ),
        )
      : [];
    const servicesPortalMappings = verifiedServicesIncome
      ? buildServicesPortalMappings({
          invoices: servicesInvoiceEvidence.map((invoice) => ({
            id: invoice.id,
            subcategory: invoice.subcategory,
            evidenceStatus: invoice.evidenceStatus,
            sourceDocumentId: invoice.sourceDocument.id,
            sourceDocumentExtractionStatus: invoice.sourceDocument.extractionStatus,
            serviceDescription: invoice.serviceDescription,
            serviceCategoryHumanConfirmed: invoice.serviceCategoryHumanConfirmed,
            serviceCategoryEvidenceReference: invoice.serviceCategoryEvidenceReference,
            incomeCharacter: invoice.incomeCharacter,
            incomeCharacterHumanConfirmed: invoice.incomeCharacterHumanConfirmed,
            incomeCharacterEvidenceReference: invoice.incomeCharacterEvidenceReference,
            recognizedIncomePkr: verifiedServicesIncome.incomeByInvoice[invoice.id] ?? 0,
            paymentMatches: invoice.paymentMatches.map((match) => ({
              id: match.id,
              withholdingTaxPkr: match.withholdingTaxPkr,
              withholdingSection: match.withholdingSection,
              withholdingIrisCode: match.withholdingIrisCode,
              withholdingEvidenceReference: match.withholdingEvidenceReference,
              withholdingEvidenceHumanConfirmed: match.withholdingEvidenceHumanConfirmed,
              withholdingEvidenceDocumentId: match.withholdingEvidenceDocumentId,
              withholdingEvidenceDocumentExtractionStatus: match.withholdingEvidenceDocument?.extractionStatus ?? null,
              withholdingEvidenceDocumentType: match.withholdingEvidenceDocument?.documentType ?? null,
            })),
          })),
          incomeBySubcategory: verifiedServicesIncome.incomeBySubcategory,
          existingBusinessFields: business?.fields ?? [],
          taxCredits: taxCredits.map((credit) => ({
            id: credit.id,
            section: credit.section,
            amount: credit.amount,
            sourceDocumentId: credit.sourceDocumentId,
          })),
        })
      : null;
    if (servicesIncomeEvidenceSnapshot && servicesPortalMappings) {
      servicesIncomeEvidenceSnapshot.duplicateTaxCreditIds =
        servicesPortalMappings.duplicateTaxCreditIds;
      servicesIncomeEvidenceSnapshot.irisMappings = {
        businessFields: servicesPortalMappings.businessFields,
        withholdingFields: servicesPortalMappings.withholdingFields,
        manualIncomeGaps: servicesPortalMappings.incomeGaps,
        manualWithholdingGaps: servicesPortalMappings.withholdingGaps,
      };
    }
    const suppressedServicesTaxCreditIds = new Set(
      servicesPortalMappings?.taxCreditIdsToSuppress ?? [],
    );
    const taxCreditsForPortalMap = taxCredits.filter(
      (credit) => !suppressedServicesTaxCreditIds.has(credit.id),
    );

    // Build portalFieldMap using IRIS codes for Electron agent
    const portalFieldMap = buildPortalFieldMap({
      taxYear: draftData.taxYear,
      filerType: draftData.filerType,
      taxpayerListStatus: draftData.taxpayerListStatus,
      businessBankEntriesCoveredByDeclaredProfit:
        Boolean(business) && isMyselfBusinessBankFlow(draftData),
      businessDepreciationAdditionsTotal,
      ledgerEntries: ledgerEntries.map((e) => ({
        id: e.id,
        entryType: e.entryType,
        category: e.category,
        description: e.description,
        amount: e.amount as any,
        date: e.entryDate,
        giftDonorId: e.sourceTransactionId
          ? (giftDonorByTransaction.get(e.sourceTransactionId) ?? null)
          : null,
      })),
      coveredLedgerEntryIds: servicesCoveredLedgerEntryIds,
      taxCredits: taxCreditsForPortalMap.map((c) => ({
        id: c.id,
        section: c.section,
        subcategory: c.subcategory,
        amount: c.amount as any,
        source: c.source,
        sourceDocumentId: c.sourceDocumentId,
      })),
      taxableIncome: draftData.taxableIncome
        ? Number(draftData.taxableIncome)
        : 0,
      taxWithheld: draftData.taxWithheld ? Number(draftData.taxWithheld) : 0,
      pensionSource: pensionSource ?? undefined,
      salaryCertificateTaxWithheld,
      salaryCertificateGrossSalary,
      // Employers named on the reviewed salary certificate; the agent adds
      // each one by name on the IRIS Salary page.
      employers: extractMappedSalaryEmployers(
        salaryCertificate?.extractedData ?? null,
      ),
      // Net cash moved out of the bank; becomes a 7012 Cash in hand movement.
      netCashMovement:
        "preview" in reconciliation && reconciliation.preview
          ? reconciliation.preview.netCashMovement
          : null,
      // Wealth Statement bank rows (7030): IBAN + closing balance per account.
      bankAccounts:
        "preview" in reconciliation && reconciliation.preview
          ? reconciliation.preview.accountBalances.flatMap((balance) => {
              const account = bankAccountsForPacket.find(
                (candidate) => candidate.id === balance.bankAccountId,
              );
              return account?.iban && bankRoute(account) !== "business"
                ? [
                    {
                      iban: account.iban,
                      bankName: balance.bankName,
                      accountLabel: balance.accountLabel,
                      closingBalance: balance.closingBalance,
                      ownershipReviewRequired:
                        bankRoute(account) === "held",
                    },
                  ]
                : [];
            })
          : [],
    });
    if (servicesPortalMappings) {
      portalFieldMap.adjustableTaxFields.push(
        ...servicesPortalMappings.withholdingFields,
      );
      portalFieldMap.totalFields += servicesPortalMappings.withholdingFields.length;
    }
    if (verifiedServicesIncome && portalFieldMap.mappingGaps) {
      const servicesCategory = (category: string | null) =>
        isServicesLedgerCategory(category) || /^SERVICES_/i.test(String(category ?? ""));
      const nonServicesGaps = (portalFieldMap.mappingGaps.unmappedCategories ?? [])
        .filter((gap) => !servicesCategory(gap.category));
      const verifiedServiceGaps = servicesPortalMappings?.incomeGaps ?? [];
      const servicesWithholdingGaps = servicesPortalMappings?.withholdingGaps ?? [];
      portalFieldMap.mappingGaps.unmappedCategories = [
        ...nonServicesGaps,
        ...verifiedServiceGaps,
        ...servicesWithholdingGaps,
      ];
    }
    const servicesBusinessFields = servicesPortalMappings?.businessFields ?? [];
    if (business) {
      if (businessBankEntries.length && ownershipStillOpen)
        business.pending.push({
          key: "businessBankAccountOwnership",
          amount: null,
          reason:
            "Accounts with business cash records need business/personal/mixed ownership review. Their balances are not automatically written as personal Wealth bank rows; complete the appropriate business/account detail and reconciliation manually.",
        });
      portalFieldMap.businessFields = business.fields;
      portalFieldMap.totalFields += business.fields.length;
      for (const item of business.pending) {
        if (item.amount !== null && item.amount > 0) {
          portalFieldMap.mappingGaps.unmappedCategories.push({
            category: `BUSINESS_${item.key}`,
            entryIds: [],
            totalAmount: item.amount,
            reason: item.reason,
          });
        }
      }
    } else if (servicesBusinessFields.length) {
      // Services-only, Salary+Services and Pension+Services routes have no Business Profit
      // selection, so the approved 3101 row is the only Business-sheet field.
      portalFieldMap.businessFields = [...servicesBusinessFields];
      portalFieldMap.totalFields += portalFieldMap.businessFields.length;
    }
    const servicesBusinessPayload = business
      ? null
      : buildServicesTaxDeductionPacket({
          taxYear: draftData.taxYear,
          filerType: draftData.filerType,
          incomeSources: parsedIncomeSources,
          businessFields: servicesBusinessFields,
          withholdingFields: servicesPortalMappings?.withholdingFields ?? [],
          withholdingGaps: servicesPortalMappings?.withholdingGaps,
        });
    const businessSnapshot = business ?? servicesBusinessPayload;
    const servicesReviewChecklist: { key: string; reason: string }[] = [];
    for (const item of servicesBusinessPayload?.pending ?? []) {
      // An amountless pending item is a review instruction, not a figure to
      // key into IRIS. It must not become a PKR 0 manual-entry gap.
      if (item.amount !== null && item.amount > 0) {
        portalFieldMap.mappingGaps.unmappedCategories.push({
          category: `BUSINESS_${item.key}`,
          entryIds: [],
          totalAmount: item.amount,
          reason: item.reason,
        });
      } else {
        servicesReviewChecklist.push({ key: item.key, reason: item.reason });
      }
    }
    if (servicesReviewChecklist.length) {
      portalFieldMap.mappingGaps.reviewChecklist = [
        ...(portalFieldMap.mappingGaps.reviewChecklist ?? []),
        ...servicesReviewChecklist,
      ];
    }
    // Previous-return Phase 3b: carry the APPROVED previous return's closing
    // net assets as the figure IRIS should show at 703002. The agent compares
    // it after typing and reports; it never writes 703002.
    const previousReturnDocuments = await prisma.document.findMany({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        documentType: "previous_return",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        documentType: true,
        extractionStatus: true,
        extractedData: true,
      },
    });
    const approvedPreviousReturn = approvedPreviousReturnFromDocuments(
      previousReturnDocuments,
      draftData.taxYear,
    );
    const routeMetadata = buildPacketRouteMetadata({
      taxYear: draftData.taxYear,
      filerType: draftData.filerType,
      businessStructure: draftData.businessStructure,
      incomeSources: parsedIncomeSources,
    });

    // A packet whose income the portal cannot carry must not be filed as if it
    // were complete. `unmappedCategories` means the ENGINE priced that income (so
    // taxCalculationStatus is ESTIMATE and every money gate above passes) while
    // the PORTAL map has no verified IRIS line for it — a business/services/
    // capital-gains taxpayer would otherwise generate a salary-only packet, have
    // the agent fill it cleanly, and file a return that quietly omits income.
    const coverageGate = describeUnmappedPortalSources(
      portalFieldMap.mappingGaps,
    );
    if (
      coverageGate.blocked.length > 0 &&
      !options?.acceptUnmappedPortalSources
    ) {
      return {
        success: false,
        error: coverageGate.refusal,
        // The UI offers the override from these same numbers, never from its own
        // copy of them.
        unmappedPortalSources: coverageGate.blocked,
      };
    }
    const coverage = businessSnapshot
      ? {
          ...coverageGate.coverage,
          mode: "partial_manual_entry_required" as const,
          acceptedByOperator: options?.acceptUnmappedPortalSources === true,
          unmappedSources: coverageGate.blocked,
          businessCoverage: businessSnapshot.coverage,
          businessPending: businessSnapshot.pending,
        }
      : coverageGate.coverage;

    const latestOwnership = await currentBusinessOwnershipStamp(draft.id, draft.userId);
    if (latestOwnership.error || JSON.stringify(latestOwnership.stamp) !== JSON.stringify(initialOwnership.stamp))
      return { success: false, error: latestOwnership.error ?? "Business bank evidence changed during packet generation. Please try again." };
    const snapshot = {
      generatedAt: new Date().toISOString(),
      ...(initialOwnership.stamp ? { businessBankOwnershipStamp: initialOwnership.stamp } : {}),
      filing: {
        ...draftData,
        status:
          latestPacket?.approvalStatus === "APPROVED"
            ? "IN_PROGRESS"
            : draftData.status,
        incomeSources: parsedIncomeSources,
        readinessChecks: parsedReadinessChecks,
      },
      documents,
      ledgerEntries,
      taxCredits,
      servicesIncomeEvidence: servicesIncomeEvidenceSnapshot,
      routeMetadata,
      portalFieldMap,
      ...(pensionSource ? { pension: pensionSource } : {}),
      ...(approvedPreviousReturn
        ? {
            wealthExpectations: {
              previousYearNetAssets: {
                irisCode: "703002",
                expected: approvedPreviousReturn.netAssets,
                previousReturnTaxYear: approvedPreviousReturn.taxYear,
                source: "approved_previous_return_703001" as const,
              },
            },
          }
        : {}),
      // Phase 5a: rows only when the extraction produced a validated set. The
      // tie-out to 7019/7029 was re-proven by `parsePreviousReturnWealthRows`,
      // so an empty array here means "nothing trustworthy to carry forward",
      // and an absent block keeps older snapshots (and the agent) unchanged.
      ...(approvedPreviousReturn && approvedPreviousReturn.wealthRows.length > 0
        ? {
            wealthCarryForward: {
              previousReturnTaxYear: approvedPreviousReturn.taxYear,
              totalAssets: approvedPreviousReturn.totalAssets,
              totalLiabilities: approvedPreviousReturn.totalLiabilities,
              netAssets: approvedPreviousReturn.netAssets,
              cashInHand: approvedPreviousReturn.cashInHand,
              rows: approvedPreviousReturn.wealthRows.map((row) => ({
                code: row.code,
                description: row.description,
                amount: row.amount,
                detail: row.detail,
              })),
            },
          }
        : {}),
      // v9 means the desktop must perform a read-only 3320/7030 cross-check.
      // Older agents refuse unknown versions rather than skipping that guard.
      business: business ? { ...business, version: "business-entry-v9" as const } : businessSnapshot,
      coverage,
    };

    const snapshotJson = JSON.stringify(snapshot);
    const packetHash = createHash("sha256").update(snapshotJson).digest("hex");
    const version = (latestPacket?.version ?? 0) + 1;

    const packet = await prisma.$transaction(async (tx) => {
      if (latestPacket?.approvalStatus === "APPROVED") {
        await tx.filingPacket.update({
          where: { id: latestPacket.id },
          data: {
            approvalStatus: "SUPERSEDED",
            status: "SUPERSEDED",
          },
        });

        await tx.filingDraft.update({
          where: { id: draft.id },
          data: { status: "IN_PROGRESS" },
        });
      }

      return tx.filingPacket.create({
        data: {
          filingDraftId: draft.id,
          userId: draft.userId,
          version,
          packetHash,
          snapshotJson,
          status: "GENERATED",
          approvalStatus: "APPROVED",
          approvedAt: new Date(),
          approvedByUserId: draft.userId,
          taxPayable: draftData.taxPayable ?? 0,
          refundDue: draftData.refundDue ?? 0,
        },
        select: {
          id: true,
          version: true,
          packetHash: true,
          status: true,
          approvalStatus: true,
          taxPayable: true,
          refundDue: true,
          createdAt: true,
        },
      });
    });

    await prisma.filingDraft.update({
      where: { id: draft.id },
      data: { status: "APPROVED_FOR_FILING" },
    });

    await createNotification({
      userId: draft.userId,
      type: "FILING_STATUS",
      title: `Filing packet v${version} generated`,
      message: `Tax year ${draftData.taxYear} packet is ready for your review.`,
      link: `/tax/new?draftId=${draft.id}`,
    });

    // Same boundary as the fetch action: the client receives numbers.
    // The mapping gaps ride along so the practitioner sees, BEFORE approving,
    // which income the portal will not be filled for — the alternative is finding
    // out from an empty IRIS grid during a filing window.
    const mappingGaps =
      (snapshot.portalFieldMap && snapshot.portalFieldMap.mappingGaps) || null;
    return {
      success: true,
      packet: {
        ...serializePacketMoney(packet),
        mappingGaps,
        coverage,
        businessCoverage: businessCoverageSummary(businessSnapshot),
      },
    };
  } catch (error) {
    console.error("Error generating filing packet:", error);
    return { success: false, error: "Failed to generate filing packet" };
  }
}

export async function generateFilingPacketPdfAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const [packet, completeness, reconciliation] = await Promise.all([
      prisma.filingPacket.findFirst({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          status: { not: "SUPERSEDED" },
        },
        orderBy: { version: "desc" },
      }),
      validateFilingCompleteness({
        draftId: draft.id,
        userId: draft.userId,
      }),
      validateAuthoritativeReconciliation({
        draftId: draft.id,
        userId: draft.userId,
      }),
    ]);

    const integrityBlockers = Array.from(
      new Set([
        ...completeness.blockers,
        ...("blockers" in reconciliation ? reconciliation.blockers : []),
      ]),
    );
    if (integrityBlockers.length > 0) {
      return { success: false, error: integrityBlockers.join(" · ") };
    }

    if (!packet) {
      return {
        success: false,
        error: "Generate a current packet snapshot first",
      };
    }
    { let ownershipSnapshot:any=null; try { ownershipSnapshot=JSON.parse(packet.snapshotJson); } catch {} const ownershipError=await businessOwnershipPacketValidationError(ownershipSnapshot,draft.id,draft.userId); if (ownershipError) return {success:false,error:ownershipError}; }
    { let parsedSnapshot:any=null; try{parsedSnapshot=JSON.parse(packet.snapshotJson)}catch{} const pensionError = await pensionPacketValidationError(parsedSnapshot, draft.id, draft.userId, { allowManual: true }); if (pensionError) return { success: false, error: pensionError }; }

    const pdfBuffer = await buildPacketPdf(packet.snapshotJson);
    const packetDirectory = path.join(process.cwd(), "uploads", "packets");
    await mkdir(packetDirectory, { recursive: true });

    const storedFileName = `${packet.id}.pdf`;
    await writeFile(path.join(packetDirectory, storedFileName), pdfBuffer);

    const fileUrl = `packets/${storedFileName}`;
    await prisma.filingPacket.update({
      where: { id: packet.id },
      data: { fileUrl },
    });

    return {
      success: true,
      pdfUrl: `/api/packets/${packet.id}`,
      version: packet.version,
    };
  } catch (error) {
    console.error("Error generating filing packet PDF:", error);
    return { success: false, error: "Failed to generate filing packet PDF" };
  }
}
