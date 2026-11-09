"use server";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getRequiredTaxDocumentTypesForCurrentFlow } from "@/lib/tax/document-requirements";
import { moneyEquals, sumMoney, toMoneyNumberOrNull } from "@/lib/money";
import { getWithholdingDuplicateWarning } from "@/lib/tax/withholding-sources";
import {
  TY2026_BUSINESS_PROFIT_SUBCATEGORY,
  getTy2026SubcategoryOptions,
} from "@/lib/tax/rules/ty2026/subcategories";
import { summarizeBusinessWithholding } from "@/lib/tax/business-withholding-summary";
import { isSingleFreelancerServicesFiling } from "@/lib/tax/business-bank-categories";
import {
  SERVICES_LEDGER_ALLOCATION_ORIGIN,
  isServicesLedgerCategory,
  parseServicesLedgerEntryId,
} from "@/lib/tax/services-income-allocation";
import {
  BANK_TRANSACTION_EXCLUDED_EVENT_TYPE,
  latestBankExclusionReasons,
} from "@/lib/tax/bank-exclusion-review";
import { parseServicesDerivedPayout } from "@/lib/tax/services-income-evidence";
import { readServicesWithholdingSourceRows } from "@/lib/tax/services-withholding-evidence";

async function getOwnedDraft(draftId: string) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;

  if (!email) throw new Error("Unauthorized");

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (!user) throw new Error("User profile not found");

  const draft = await prisma.filingDraft.findFirst({
    where: { id: draftId, userId: user.id },
    select: {
      id: true,
      userId: true,
      taxYear: true,
      filerType: true,
      incomeSources: true,
      servicesAccountingMethod: true,
      incomeSelections: {
        where: { source: "services", status: "SELECTED" },
        select: { subcategory: true },
      },
    },
  });

  if (!draft) throw new Error("Filing draft not found");

  return draft;
}

export async function getFilingSummaryAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    let parsedIncomeSources: string[] = [];
    try {
      const parsed = JSON.parse(draft.incomeSources);
      parsedIncomeSources = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      parsedIncomeSources = [];
    }
    const freelancerEnabled = isSingleFreelancerServicesFiling(draft);
    const businessSummaryEnabled =
      draft.taxYear === 2026 &&
      draft.filerType === "myself" &&
      parsedIncomeSources.includes("business");
    const [
      entries,
      documents,
      currentDraft,
      calculationLines,
      servicesAllocationRecords,
      servicesInvoiceRecords,
      excludedCreditRows,
      exclusionEvents,
      servicesEvidenceDocumentRows,
      businessProfitSelections,
      mappedBusinessBooksRows,
    ] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
        },
        select: {
          id: true,
          entryType: true,
          category: true,
          amount: true,
          entryDate: true,
          description: true,
          sourceDocumentId: true,
        },
      }),
      prisma.document.findMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          fileName: true,
          documentType: true,
          bankAccountId: true,
          extractionStatus: true,
        },
      }),
      prisma.filingDraft.findUnique({
        where: { id: draft.id },
        select: {
          servicesAccountingMethod: true,
          reconciliationStatus: true,
          reconciliationGap: true,
          taxableIncome: true,
          taxWithheld: true,
          taxPayable: true,
          refundDue: true,
          taxCalculationStatus: true,
          taxpayerListStatus: true,
        },
      }),
      // Per-source breakdown from the most recent calculation, so the wizard
      // can show which income produced which part of the liability.
      prisma.filingTaxCalculationLine.findMany({
        where: { filingDraftId: draft.id, userId: draft.userId },
        orderBy: { createdAt: "asc" },
        select: {
          source: true,
          subcategory: true,
          section: true,
          ruleId: true,
          taxBase: true,
          baseTax: true,
          surcharge: true,
          calculatedTax: true,
          detailsJson: true,
        },
      }),
      freelancerEnabled
        ? prisma.filingIncomeRecord.findMany({
            where: {
              filingDraftId: draft.id,
              userId: draft.userId,
              source: "services",
              origin: SERVICES_LEDGER_ALLOCATION_ORIGIN,
              recordStatus: "CONFIRMED",
            },
            select: {
              subcategory: true,
              detailsJson: true,
              grossAmount: true,
            },
          })
        : Promise.resolve([]),
      freelancerEnabled
        ? prisma.servicesInvoiceEvidence.findMany({
            where: { filingDraftId: draft.id, userId: draft.userId },
            orderBy: [{ invoiceDate: "asc" }, { invoiceKey: "asc" }],
            include: {
              sourceDocument: {
                select: { fileName: true, extractionStatus: true },
              },
              paymentMatches: {
                orderBy: { createdAt: "asc" },
                include: {
                  ledgerEntry: {
                    select: { id: true, entryDate: true, description: true, amount: true },
                  },
                  evidenceDocument: {
                    select: { fileName: true, documentType: true, extractionStatus: true },
                  },
                  withholdingEvidenceDocument: {
                    select: { id: true, fileName: true, documentType: true, extractionStatus: true },
                  },
                },
              },
            },
          })
        : Promise.resolve([]),
      freelancerEnabled
        ? prisma.bankTransaction.findMany({
            where: {
              filingDraftId: draft.id,
              userId: draft.userId,
              classificationStatus: "REJECTED",
              credit: { gt: 0 },
            },
            orderBy: [{ transactionDate: "asc" }, { id: "asc" }],
            select: { id: true, description: true, credit: true },
          })
        : Promise.resolve([]),
      freelancerEnabled
        ? prisma.taxAuditEvent.findMany({
            where: {
              filingDraftId: draft.id,
              userId: draft.userId,
              eventType: BANK_TRANSACTION_EXCLUDED_EVENT_TYPE,
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { eventDataJson: true },
          })
        : Promise.resolve([]),
      freelancerEnabled
        ? prisma.document.findMany({
            where: {
              filingDraftId: draft.id,
              userId: draft.userId,
              extractionStatus: "MAPPED",
            },
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              fileName: true,
              documentType: true,
              extractionStatus: true,
              extractedData: true,
            },
          })
        : Promise.resolve([]),
      businessSummaryEnabled
        ? prisma.filingIncomeSelection.findMany({
            where: {
              filingDraftId: draft.id,
              userId: draft.userId,
              source: "business",
              subcategory: TY2026_BUSINESS_PROFIT_SUBCATEGORY,
              status: "SELECTED",
            },
            select: { detailsJson: true },
          })
        : Promise.resolve([]),
      businessSummaryEnabled
        ? prisma.document.findMany({
            where: {
              filingDraftId: draft.id,
              userId: draft.userId,
              documentType: "business_books",
              extractionStatus: "MAPPED",
            },
            select: { extractedData: true },
          })
        : Promise.resolve([]),
    ]);

    // Decimal columns arrive as Prisma Decimal instances; the wizard needs
    // plain numbers.
    const allBreakdown = calculationLines.map((line) => {
      let details: {
        rateShape?: string;
        isFinalTax?: boolean;
        combinedRoutes?: { route: string; income: number }[];
      } = {};
      try {
        details = JSON.parse(line.detailsJson);
      } catch {
        details = {};
      }

      const subcategoryLabel =
        getTy2026SubcategoryOptions(line.source).find(
          (option) => option.subcategory === line.subcategory,
        )?.label ?? null;

      return {
        source: line.source,
        subcategoryLabel,
        section: line.section,
        ruleId: line.ruleId,
        income: Number(line.taxBase),
        baseTax: Number(line.baseTax),
        surcharge: Number(line.surcharge),
        taxDue: Number(line.calculatedTax),
        isFinalTax: details.isFinalTax === true,
        rateShape: details.rateShape ?? "PROGRESSIVE",
        combinedRoutes: details.combinedRoutes ?? [],
      };
    });

    // Collection lines (imports, advance tax) price tax already collected at
    // source. They are reported in their own section with their own subtotal
    // so the income-tax totals stay exactly what the engine computed.
    const COLLECTION_SOURCES = new Set(["imports", "advance_tax"]);
    const taxBreakdown = allBreakdown.filter(
      (line) => !COLLECTION_SOURCES.has(line.source),
    );
    const collectionBreakdown = allBreakdown.filter((line) =>
      COLLECTION_SOURCES.has(line.source),
    );
    const collectionTaxDue = collectionBreakdown.reduce(
      (total, line) => total + line.taxDue,
      0,
    );

    const finalTaxDue = taxBreakdown
      .filter((line) => line.isFinalTax)
      .reduce((total, line) => total + line.taxDue, 0);
    const assessableTaxDue = taxBreakdown
      .filter((line) => !line.isFinalTax)
      .reduce((total, line) => total + line.taxDue, 0);
    // Mirror of the engine's mixed-regime excess flag (section 29). Derived
    // from stored lines + scalars so no new DB column is needed.
    const storedWithheld = toMoneyNumberOrNull(currentDraft?.taxWithheld) ?? 0;
    const storedDue = finalTaxDue + assessableTaxDue;
    const everyStoredLineFinal =
      taxBreakdown.length > 0 && taxBreakdown.every((line) => line.isFinalTax);
    const mixedExcessWithholding =
      !everyStoredLineFinal && finalTaxDue > 0 && storedWithheld - storedDue > 0
        ? storedWithheld - storedDue
        : 0;

    let incomeSources: string[] = [];
    try {
      const parsed = JSON.parse(draft.incomeSources);
      incomeSources = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      incomeSources = [];
    }

    const selectedServicesSubcategories = freelancerEnabled
      ? draft.incomeSelections.map((selection) => ({
          subcategory: selection.subcategory,
          label:
            getTy2026SubcategoryOptions("services").find(
              (option) => option.subcategory === selection.subcategory,
            )?.label ?? selection.subcategory,
        }))
      : [];
    const selectedServicesKeys = new Set(
      selectedServicesSubcategories.map((selection) => selection.subcategory),
    );
    const allocationRecordByEntryId = new Map<
      string,
      (typeof servicesAllocationRecords)[number]
    >();
    const duplicateAllocationEntryIds = new Set<string>();
    for (const record of servicesAllocationRecords) {
      const entryId = parseServicesLedgerEntryId(record.detailsJson);
      if (!entryId) continue;
      if (allocationRecordByEntryId.has(entryId)) {
        duplicateAllocationEntryIds.add(entryId);
      } else {
        allocationRecordByEntryId.set(entryId, record);
      }
    }

    const serviceLedgerRows = freelancerEnabled
      ? entries.filter(
          (entry) =>
            entry.entryType === "INCOME" && isServicesLedgerCategory(entry.category),
        )
      : [];
    const servicesIncomeEntries = serviceLedgerRows.map((entry) => {
      const savedAllocation = allocationRecordByEntryId.get(entry.id);
      return {
        id: entry.id,
        date: entry.entryDate?.toISOString().slice(0, 10) ?? null,
        description: entry.description ?? "Services receipt",
        amount: Number(entry.amount),
        // The Review step matches a credit to the statement document that
        // produced it, so a withholding certificate can be linked without the
        // user choosing a file by hand.
        sourceDocumentId: entry.sourceDocumentId ?? null,
        allocatedSubcategory:
          !duplicateAllocationEntryIds.has(entry.id) &&
          savedAllocation &&
          moneyEquals(savedAllocation.grossAmount, entry.amount) &&
          selectedServicesKeys.has(savedAllocation.subcategory)
            ? savedAllocation.subcategory
            : null,
      };
    });
    const servicesInvoiceEvidence = servicesInvoiceRecords.map((invoice) => ({
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate?.toISOString().slice(0, 10) ?? null,
      dueDate: invoice.dueDate?.toISOString().slice(0, 10) ?? null,
      clientName: invoice.clientName,
      serviceDescription: invoice.serviceDescription,
      sourceDocumentFileName: invoice.sourceDocument.fileName,
      sourceDocumentExtractionStatus: invoice.sourceDocument.extractionStatus,
      quantity: toMoneyNumberOrNull(invoice.quantity),
      unitRate: toMoneyNumberOrNull(invoice.unitRate),
      invoiceAmount: toMoneyNumberOrNull(invoice.invoiceAmount),
      currency: invoice.currency,
      exchangeRateToPkr: toMoneyNumberOrNull(invoice.exchangeRateToPkr),
      fxEvidenceReference: invoice.fxEvidenceReference,
      subcategory: invoice.subcategory,
      serviceCategoryHumanConfirmed: invoice.serviceCategoryHumanConfirmed,
      serviceCategoryEvidenceReference: invoice.serviceCategoryEvidenceReference,
      incomeCharacter: invoice.incomeCharacter,
      incomeCharacterHumanConfirmed: invoice.incomeCharacterHumanConfirmed,
      incomeCharacterEvidenceReference: invoice.incomeCharacterEvidenceReference,
      paymentStatus: invoice.paymentStatus,
      derivedPayout: parseServicesDerivedPayout(invoice.detailsJson),
      evidenceStatus: invoice.evidenceStatus,
      paymentMatches: invoice.paymentMatches.map((match) => ({
        id: match.id,
        invoiceEvidenceId: match.invoiceEvidenceId,
        ledgerEntryId: match.ledgerEntryId,
        ledgerEntryDate: match.ledgerEntry.entryDate?.toISOString().slice(0, 10) ?? null,
        ledgerEntryDescription: match.ledgerEntry.description,
        ledgerEntryAmount: toMoneyNumberOrNull(match.ledgerEntry.amount),
        settlementDate: match.settlementDate?.toISOString().slice(0, 10) ?? null,
        settlementCurrency: match.settlementCurrency,
        settlementAmount: toMoneyNumberOrNull(match.settlementAmount),
        settlementExchangeRateToPkr: toMoneyNumberOrNull(match.settlementExchangeRateToPkr),
        invoiceCurrencyAmount: toMoneyNumberOrNull(match.invoiceCurrencyAmount),
        exchangeRateToPkr: toMoneyNumberOrNull(match.exchangeRateToPkr),
        grossServiceAmountPkr: toMoneyNumberOrNull(match.grossServiceAmountPkr),
        netBankAmountPkr: toMoneyNumberOrNull(match.netBankAmountPkr),
        withholdingTaxPkr: toMoneyNumberOrNull(match.withholdingTaxPkr),
        withholdingSection: match.withholdingSection,
        withholdingIrisCode: match.withholdingIrisCode,
        withholdingEvidenceReference: match.withholdingEvidenceReference,
        withholdingEvidenceHumanConfirmed: match.withholdingEvidenceHumanConfirmed,
        withholdingEvidenceDocumentId: match.withholdingEvidenceDocumentId,
        withholdingEvidenceDocumentFileName: match.withholdingEvidenceDocument?.fileName ?? null,
        withholdingEvidenceDocumentType: match.withholdingEvidenceDocument?.documentType ?? null,
        platformFeePkr: toMoneyNumberOrNull(match.platformFeePkr),
        bankFeePkr: toMoneyNumberOrNull(match.bankFeePkr),
        payoutReference: match.payoutReference,
        evidenceReference: match.evidenceReference,
        evidenceDocumentId: match.evidenceDocumentId,
        evidenceDocumentFileName: match.evidenceDocument?.fileName ?? null,
        recordStatus: match.recordStatus,
      })),
    }));

    const exclusionReasons = latestBankExclusionReasons(exclusionEvents);
    const excludedPositiveCredits = freelancerEnabled
      ? excludedCreditRows.map((row) => ({
          id: row.id,
          description: row.description,
          amount: Number(row.credit),
          reason: exclusionReasons.get(row.id) ?? null,
        }))
      : [];

    const requiredDocumentTypes = new Set(
      getRequiredTaxDocumentTypesForCurrentFlow({
        incomeSources: incomeSources as any,
      }),
    );
    const hasAccountLinkedBankStatement = documents.some(
      (document) =>
        document.documentType === "bank_statement" &&
        Boolean(document.bankAccountId),
    );
    const latestRequiredDocuments = Array.from(
      new Map<string, (typeof documents)[number]>(
        documents
          .filter((document) =>
            requiredDocumentTypes.has(document.documentType),
          )
          .filter(
            (document) =>
              !hasAccountLinkedBankStatement ||
              document.documentType !== "bank_statement" ||
              Boolean(document.bankAccountId),
          )
          .map((document) => [
            `${document.documentType}:${document.bankAccountId ?? ""}`,
            document,
          ]),
      ).values(),
    );

    // `result.x += entry.amount` is the compound form of the same hazard as
    // `total + entry.amount`: on a Decimal column it appends digits to a
    // string instead of adding, and it is not visible to the type checker.
    const totalFor = (entryType: string) =>
      sumMoney(
        entries
          .filter((entry) => entry.entryType === entryType)
          .map((entry) => entry.amount),
      );

    const totals = {
      income: totalFor("INCOME"),
      expenses: totalFor("EXPENSE"),
      assets: totalFor("ASSET"),
      liabilities: totalFor("LIABILITY"),
    };

    // Fresh on every summary load (mount, ledger change, recalculation) so a
    // page reload can never strand the wizard: the duplicate confirmation
    // follows the current warning, not session memory.
    const duplicateWarning = await getWithholdingDuplicateWarning(
      draft.id,
      draft.userId,
    );
    const businessWithholding = summarizeBusinessWithholding({
      taxYear: draft.taxYear,
      filerType: draft.filerType,
      incomeSources: parsedIncomeSources,
      selectionDetailsJson:
        businessProfitSelections.length === 1
          ? businessProfitSelections[0].detailsJson
          : null,
      mappedBooksExtractedDataList: mappedBusinessBooksRows.map(
        (row) => row.extractedData,
      ),
    });

    return {
      success: true,
      summary: {
        ...totals,
        servicesAccountingMethod: currentDraft?.servicesAccountingMethod ?? null,
        servicesInvoices: servicesInvoiceEvidence,
        servicesEvidenceDocuments: servicesEvidenceDocumentRows.map((document) => ({
          id: document.id,
          fileName: document.fileName,
          documentType: document.documentType,
          extractionStatus: document.extractionStatus,
          withholdingRows: readServicesWithholdingSourceRows(document.extractedData),
        })),
        servicesIncomeEntries,
        servicesIncomeTotal: sumMoney(serviceLedgerRows.map((entry) => entry.amount)),
        selectedServicesSubcategories,
        excludedPositiveCredits,
        ledgerEntryCount: entries.length,
        documentCount: latestRequiredDocuments.length,
        pendingDocumentCount: latestRequiredDocuments.filter((document) =>
          ["PENDING", "PROCESSING", "FAILED"].includes(
            document.extractionStatus,
          ),
        ).length,
        // Extraction finishing is not the same as being mapped: an invoice
        // summary only creates invoice rows after explicit approval/mapping.
        documentsAwaitingMapping: latestRequiredDocuments
          .filter((document) => document.extractionStatus === "COMPLETED")
          .map((document) => ({
            fileName: document.fileName,
            documentType: document.documentType,
          })),
        reconciliationStatus:
          currentDraft?.reconciliationStatus ?? "UNRESOLVED",
        // These are Decimal columns. The filing wizard compares them against
        // preview numbers and formats them for display, so they are converted
        // here, at the one point where they leave the server.
        reconciliationGap: toMoneyNumberOrNull(currentDraft?.reconciliationGap),
        taxableIncome: toMoneyNumberOrNull(currentDraft?.taxableIncome),
        taxWithheld: toMoneyNumberOrNull(currentDraft?.taxWithheld),
        taxPayable: toMoneyNumberOrNull(currentDraft?.taxPayable),
        refundDue: toMoneyNumberOrNull(currentDraft?.refundDue),
        taxCalculationStatus:
          currentDraft?.taxCalculationStatus ?? "NOT_CALCULATED",
        taxpayerListStatus: currentDraft?.taxpayerListStatus ?? null,
        withholdingWarning: duplicateWarning,
        taxBreakdown,
        finalTaxDue,
        assessableTaxDue,
        mixedExcessWithholding,
        collectionBreakdown,
        collectionTaxDue,
        businessWithholding,
      },
    };
  } catch (error) {
    console.error("Error fetching filing summary:", error);
    return { success: false, error: "Failed to fetch filing summary" };
  }
}
