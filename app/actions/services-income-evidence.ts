"use server";

import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidateBusinessBalancePackets } from "@/lib/tax/business-filing";
import { isSingleFreelancerServicesFiling } from "@/lib/tax/business-bank-categories";
import { getTy2026SubcategoryOptions } from "@/lib/tax/rules/ty2026/subcategories";
import {
  evaluateServicesIncomeEvidence,
  SERVICES_ACCOUNTING_METHODS,
  SERVICES_PAYMENT_STATUSES,
  type ServicesAccountingMethod,
  type ServicesPaymentStatus,
  type ServicesInvoiceForCalculation,
  type ServicesPaymentMatchForCalculation,
} from "@/lib/tax/services-income-evidence";
import { isServicesLedgerCategory, SERVICES_LEDGER_ALLOCATION_ORIGIN } from "@/lib/tax/services-income-allocation";
import {
  SERVICES_INCOME_CHARACTERS,
  type ServicesIncomeCharacter,
} from "@/lib/tax/services-iris-mapping";

// The upload flow has no dedicated certificate type yet. A source can be a
// mapped bank statement, generic income proof, or advance-tax/CPR evidence; an
// invoice summary alone is not accepted as a withholding certificate.
import { SERVICES_WITHHOLDING_DOCUMENT_TYPES } from "@/lib/tax/services-withholding-evidence";

export type ServicesInvoiceReviewInput = {
  id: string;
  subcategory: string;
  serviceCategoryHumanConfirmed: boolean;
  serviceCategoryEvidenceReference: string | null;
  incomeCharacter: ServicesIncomeCharacter;
  incomeCharacterHumanConfirmed: boolean;
  incomeCharacterEvidenceReference: string | null;
  dueDate: string | null;
  exchangeRateToPkr: number | null;
  fxEvidenceReference: string | null;
  paymentStatus: ServicesPaymentStatus | null;
};

export type ServicesPaymentMatchInput = {
  invoiceEvidenceId: string;
  ledgerEntryId: string;
  settlementCurrency: string;
  settlementAmount: number;
  settlementExchangeRateToPkr: number;
  invoiceCurrencyAmount: number;
  exchangeRateToPkr: number;
  grossServiceAmountPkr: number;
  netBankAmountPkr: number;
  withholdingTaxPkr: number;
  withholdingSection: string | null;
  withholdingIrisCode: string | null;
  withholdingEvidenceReference: string | null;
  withholdingEvidenceHumanConfirmed: boolean;
  withholdingEvidenceDocumentId: string | null;
  platformFeePkr: number;
  bankFeePkr: number;
  payoutReference: string | null;
  evidenceReference: string | null;
  evidenceDocumentId: string | null;
};

function invalid(message: string) {
  return { success: false as const, error: message };
}

function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return date;
}

function parseAmount(value: unknown, allowZero = false): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || (!allowZero && value === 0)) return null;
  return Math.round(value * 100) / 100;
}

function parseRate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return null;
  return Math.round(value * 100000000) / 100000000;
}

function parseText(value: unknown, maxLength = 250): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function dateInputToIso(date: Date | null | undefined) {
  return date ? date.toISOString().slice(0, 10) : null;
}

export async function saveServicesIncomeEvidenceAction(input: {
  draftId: string;
  accountingMethod: string;
  invoices: ServicesInvoiceReviewInput[];
  paymentMatches: ServicesPaymentMatchInput[];
}) {
  try {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    if (!email) return invalid("Unauthorized");

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) return invalid("User profile not found");
    if (!input || typeof input !== "object" || !Array.isArray(input.invoices) || !Array.isArray(input.paymentMatches))
      return invalid("Services invoice and payout evidence is incomplete.");
    if (input.invoices.length > 250 || input.paymentMatches.length > 1000)
      return invalid("Too many Services invoice or payout rows were submitted.");
    if (!SERVICES_ACCOUNTING_METHODS.includes(input.accountingMethod as ServicesAccountingMethod))
      return invalid("Choose Cash or Accrual—the accounting method regularly used for Services income.");

    return await prisma.$transaction(async (tx) => {
      const draft = await tx.filingDraft.findFirst({
        where: { id: input.draftId, userId: user.id },
        select: {
          id: true,
          userId: true,
          taxYear: true,
          filerType: true,
          incomeSources: true,
          incomeSelections: {
            where: { source: "services", status: "SELECTED" },
            select: { subcategory: true },
          },
        },
      });
      if (!draft) return invalid("Filing draft not found");
      if (!isSingleFreelancerServicesFiling(draft))
        return invalid("Verified Services invoice evidence currently supports a TY2026 Myself filing whose only income source is Freelancer / Services.");

      const selectedSubcategories = Array.from(
        new Set(draft.incomeSelections.map((selection) => selection.subcategory)),
      );
      const validSubcategories = new Set(
        getTy2026SubcategoryOptions("services").map((option) => option.subcategory),
      );
      if (
        selectedSubcategories.length === 0 ||
        selectedSubcategories.some((subcategory) => !validSubcategories.has(subcategory))
      )
        return invalid("Select valid TY2026 Freelancer service categories before saving income evidence.");

      const invoiceRows = await tx.servicesInvoiceEvidence.findMany({
        where: { filingDraftId: draft.id, userId: draft.userId },
        include: { paymentMatches: true },
        orderBy: [{ invoiceDate: "asc" }, { invoiceKey: "asc" }],
      });
      if (!invoiceRows.length)
        return invalid("Map at least one reviewed invoice before saving Services income evidence.");
      if (input.invoices.length !== invoiceRows.length)
        return invalid("Refresh the Review step: every invoice row must be reviewed exactly once.");

      const invoiceById = new Map(invoiceRows.map((invoice) => [invoice.id, invoice]));
      const invoiceReviewById = new Map<string, ServicesInvoiceReviewInput>();
      for (const candidate of input.invoices) {
        const id = String(candidate?.id ?? "").trim();
        if (!id || !invoiceById.has(id) || invoiceReviewById.has(id))
          return invalid("An invoice row is missing, duplicated or no longer belongs to this filing.");
        const subcategory = String(candidate.subcategory ?? "").trim();
        if (!selectedSubcategories.includes(subcategory))
          return invalid("Assign every invoice to one of the Services categories selected for this filing.");
        const incomeCharacter = String(candidate.incomeCharacter ?? "UNCLASSIFIED").trim() as ServicesIncomeCharacter;
        if (!SERVICES_INCOME_CHARACTERS.includes(incomeCharacter))
          return invalid("Choose a valid Services income-character review value.");
        const serviceCategoryHumanConfirmed = candidate.serviceCategoryHumanConfirmed === true;
        const serviceCategoryEvidenceReference = parseText(candidate.serviceCategoryEvidenceReference, 500);
        if (serviceCategoryHumanConfirmed && !serviceCategoryEvidenceReference)
          return invalid("Add the invoice/contract page or clause supporting the human-confirmed Services category.");
        const incomeCharacterHumanConfirmed = candidate.incomeCharacterHumanConfirmed === true;
        const incomeCharacterEvidenceReference = parseText(candidate.incomeCharacterEvidenceReference, 500);
        if (incomeCharacterHumanConfirmed && !incomeCharacterEvidenceReference)
          return invalid("Add the invoice/contract page or clause supporting the human-confirmed income-character classification.");
        if (candidate.paymentStatus !== null && !SERVICES_PAYMENT_STATUSES.includes(candidate.paymentStatus))
          return invalid("Choose a valid receipt status for every invoice.");
        const dueDate = candidate.dueDate ? parseIsoDate(candidate.dueDate) : null;
        if (candidate.dueDate && !dueDate)
          return invalid("Income-due dates must be valid ISO dates (YYYY-MM-DD).");
        const rate = candidate.exchangeRateToPkr === null ? null : parseRate(candidate.exchangeRateToPkr);
        if (candidate.exchangeRateToPkr !== null && rate === null)
          return invalid("Enter a positive invoice-date exchange rate or leave it blank until verified.");
        invoiceReviewById.set(id, {
          id,
          subcategory,
          serviceCategoryHumanConfirmed,
          serviceCategoryEvidenceReference,
          incomeCharacter,
          incomeCharacterHumanConfirmed,
          incomeCharacterEvidenceReference,
          dueDate: dueDate ? dueDate.toISOString().slice(0, 10) : null,
          exchangeRateToPkr: rate,
          fxEvidenceReference: parseText(candidate.fxEvidenceReference, 500),
          paymentStatus: candidate.paymentStatus,
        });
      }
      if (invoiceReviewById.size !== invoiceRows.length)
        return invalid("Review every invoice row before saving evidence.");

      const ledgerEntries = await tx.ledgerEntry.findMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          entryType: "INCOME",
        },
        select: { id: true, category: true, amount: true, entryDate: true },
      });
      const serviceCredits = ledgerEntries.filter((entry) => isServicesLedgerCategory(entry.category));
      const serviceEntryById = new Map(serviceCredits.map((entry) => [entry.id, entry]));

      const payoutPairs = new Set<string>();
      const normalizedMatches: Array<{
        invoiceEvidenceId: string;
        ledgerEntryId: string;
        settlementDate: Date;
        settlementCurrency: string;
        settlementAmount: number;
        settlementExchangeRateToPkr: number;
        invoiceCurrencyAmount: number;
        exchangeRateToPkr: number;
        grossServiceAmountPkr: number;
        netBankAmountPkr: number;
        withholdingTaxPkr: number;
        withholdingSection: string | null;
        withholdingIrisCode: string | null;
        withholdingEvidenceReference: string | null;
        withholdingEvidenceHumanConfirmed: boolean;
        withholdingEvidenceDocumentId: string | null;
        platformFeePkr: number;
        bankFeePkr: number;
        payoutReference: string | null;
        evidenceReference: string | null;
        evidenceDocumentId: string | null;
      }> = [];

      for (const candidate of input.paymentMatches) {
        const invoiceEvidenceId = String(candidate?.invoiceEvidenceId ?? "").trim();
        const ledgerEntryId = String(candidate?.ledgerEntryId ?? "").trim();
        const invoice = invoiceById.get(invoiceEvidenceId);
        const ledgerEntry = serviceEntryById.get(ledgerEntryId);
        if (!invoice || !ledgerEntry)
          return invalid("A payout match must link an invoice to a current Services ledger credit in this filing.");
        if (!ledgerEntry.entryDate)
          return invalid("A linked Services bank credit is missing its transaction date.");
        const pairKey = `${invoiceEvidenceId}:${ledgerEntryId}`;
        if (payoutPairs.has(pairKey))
          return invalid("Do not link the same invoice to the same bank credit more than once.");
        payoutPairs.add(pairKey);

        const settlementCurrency = String(candidate.settlementCurrency ?? "").trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(settlementCurrency))
          return invalid("Enter a valid three-letter payout/settlement currency for each match.");
        const settlementAmount = parseAmount(candidate.settlementAmount);
        const settlementExchangeRateToPkr = parseRate(candidate.settlementExchangeRateToPkr);
        const invoiceCurrencyAmount = parseAmount(candidate.invoiceCurrencyAmount);
        const exchangeRateToPkr = parseRate(candidate.exchangeRateToPkr);
        const grossServiceAmountPkr = parseAmount(candidate.grossServiceAmountPkr);
        const netBankAmountPkr = parseAmount(candidate.netBankAmountPkr);
        const withholdingTaxPkr = parseAmount(candidate.withholdingTaxPkr, true);
        const withholdingSection = parseText(candidate.withholdingSection, 100);
        const withholdingIrisCode = parseText(candidate.withholdingIrisCode, 30);
        const withholdingEvidenceReference = parseText(candidate.withholdingEvidenceReference, 500);
        const withholdingEvidenceHumanConfirmed = candidate.withholdingEvidenceHumanConfirmed === true;
        const platformFeePkr = parseAmount(candidate.platformFeePkr, true);
        const bankFeePkr = parseAmount(candidate.bankFeePkr, true);
        if (
          settlementAmount === null ||
          settlementExchangeRateToPkr === null ||
          invoiceCurrencyAmount === null ||
          exchangeRateToPkr === null ||
          grossServiceAmountPkr === null ||
          netBankAmountPkr === null ||
          withholdingTaxPkr === null ||
          platformFeePkr === null ||
          bankFeePkr === null
        )
          return invalid("Enter verified payout, gross, net, withholding, platform-fee and bank-fee amounts for every payout match; use 0 only when evidence confirms zero.");

        const evidenceReference = parseText(candidate.evidenceReference, 500);
        const payoutReference = parseText(candidate.payoutReference, 250);
        if (!evidenceReference && !payoutReference)
          return invalid("Add a payout statement/page or payout reference for every linked bank credit.");

        let evidenceDocumentId: string | null = null;
        if (candidate.evidenceDocumentId) {
          evidenceDocumentId = String(candidate.evidenceDocumentId).trim();
          const evidenceDocument = await tx.document.findFirst({
            where: {
              id: evidenceDocumentId,
              filingDraftId: draft.id,
              userId: draft.userId,
              extractionStatus: "MAPPED",
            },
            select: { id: true },
          });
          if (!evidenceDocument)
            return invalid("A linked payout evidence document is not mapped in this filing.");
        }
        let withholdingEvidenceDocumentId: string | null = null;
        if (candidate.withholdingEvidenceDocumentId) {
          withholdingEvidenceDocumentId = String(candidate.withholdingEvidenceDocumentId).trim();
          const withholdingDocument = await tx.document.findFirst({
            where: {
              id: withholdingEvidenceDocumentId,
              filingDraftId: draft.id,
              userId: draft.userId,
              extractionStatus: "MAPPED",
            },
            select: { id: true, documentType: true },
          });
          if (!withholdingDocument)
            return invalid("The Services withholding certificate/statement must be a mapped document in this filing.");
          if (!SERVICES_WITHHOLDING_DOCUMENT_TYPES.has(withholdingDocument.documentType))
            return invalid("Select a mapped bank statement, other-income proof, or advance-tax/CPR document as Services withholding evidence; an invoice alone is not a withholding certificate.");
        }
        if (
          withholdingEvidenceHumanConfirmed &&
          (withholdingTaxPkr <= 0 ||
            !withholdingSection ||
            !withholdingIrisCode ||
            !withholdingEvidenceReference ||
            !withholdingEvidenceDocumentId)
        )
          return invalid("To confirm Services withholding for IRIS mapping, provide a positive amount, exact section and code, mapped certificate/statement document, and page/line reference.");

        normalizedMatches.push({
          invoiceEvidenceId,
          ledgerEntryId,
          settlementDate: ledgerEntry.entryDate,
          settlementCurrency,
          settlementAmount,
          settlementExchangeRateToPkr,
          invoiceCurrencyAmount,
          exchangeRateToPkr,
          grossServiceAmountPkr,
          netBankAmountPkr,
          withholdingTaxPkr,
          withholdingSection,
          withholdingIrisCode,
          withholdingEvidenceReference,
          withholdingEvidenceHumanConfirmed,
          withholdingEvidenceDocumentId,
          platformFeePkr,
          bankFeePkr,
          payoutReference,
          evidenceReference,
          evidenceDocumentId,
        });
      }

      const invoiceUpdates = invoiceRows.map((invoice) => {
        const review = invoiceReviewById.get(invoice.id)!;
        return {
          ...invoice,
          ...review,
          dueDate: review.dueDate ? parseIsoDate(review.dueDate) : null,
          exchangeRateToPkr: review.exchangeRateToPkr,
          evidenceStatus: "CONFIRMED",
          paymentStatus: review.paymentStatus,
          paymentMatches: normalizedMatches
            .filter((match) => match.invoiceEvidenceId === invoice.id)
            .map((match) => ({
              ledgerEntryId: match.ledgerEntryId,
              settlementDate: match.settlementDate,
              settlementCurrency: match.settlementCurrency,
              settlementAmount: match.settlementAmount,
              settlementExchangeRateToPkr: match.settlementExchangeRateToPkr,
              invoiceCurrencyAmount: match.invoiceCurrencyAmount,
              exchangeRateToPkr: match.exchangeRateToPkr,
              grossServiceAmountPkr: match.grossServiceAmountPkr,
              netBankAmountPkr: match.netBankAmountPkr,
              withholdingTaxPkr: match.withholdingTaxPkr,
              platformFeePkr: match.platformFeePkr,
              bankFeePkr: match.bankFeePkr,
              payoutReference: match.payoutReference,
              evidenceReference: match.evidenceReference,
              recordStatus: "CONFIRMED",
            })),
        } as ServicesInvoiceForCalculation;
      });
      const evidenceResult = evaluateServicesIncomeEvidence({
        taxYear: draft.taxYear,
        accountingMethod: input.accountingMethod,
        selectedSubcategories,
        invoices: invoiceUpdates,
        ledgerCredits: serviceCredits.map((entry) => ({
          id: entry.id,
          amount: entry.amount.toString(),
          entryDate: entry.entryDate,
        })),
      });
      if (evidenceResult.ok === false)
        return invalid(evidenceResult.errors.join(" "));

      const transactionResult = await tx.servicesInvoicePaymentMatch.deleteMany({
        where: { filingDraftId: draft.id, userId: draft.userId },
      });
      void transactionResult;

      await tx.servicesInvoiceEvidence.updateMany({
        where: { filingDraftId: draft.id, userId: draft.userId },
        data: { evidenceStatus: "CONFIRMED" },
      });
      if (normalizedMatches.length) {
        await tx.servicesInvoicePaymentMatch.createMany({
          data: normalizedMatches.map((match) => ({
            ...match,
            filingDraftId: draft.id,
            userId: draft.userId,
            recordStatus: "CONFIRMED",
          })),
        });
      }
      for (const invoice of invoiceRows) {
        const review = invoiceReviewById.get(invoice.id)!;
        await tx.servicesInvoiceEvidence.update({
          where: { id: invoice.id },
          data: {
            subcategory: review.subcategory,
            serviceCategoryHumanConfirmed: review.serviceCategoryHumanConfirmed,
            serviceCategoryEvidenceReference: review.serviceCategoryEvidenceReference,
            incomeCharacter: review.incomeCharacter,
            incomeCharacterHumanConfirmed: review.incomeCharacterHumanConfirmed,
            incomeCharacterEvidenceReference: review.incomeCharacterEvidenceReference,
            dueDate: review.dueDate ? parseIsoDate(review.dueDate) : null,
            exchangeRateToPkr: review.exchangeRateToPkr,
            fxEvidenceReference: review.fxEvidenceReference,
            paymentStatus: review.paymentStatus,
            evidenceStatus: "CONFIRMED",
          },
        });
      }

      await tx.filingIncomeRecord.deleteMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          source: "services",
          origin: SERVICES_LEDGER_ALLOCATION_ORIGIN,
        },
      });
      await tx.filingDraft.update({
        where: { id: draft.id },
        data: {
          servicesAccountingMethod: input.accountingMethod,
          status: "IN_PROGRESS",
          taxableIncome: null,
          taxPayable: null,
          refundDue: null,
          taxCalculationStatus: "NOT_CALCULATED",
          taxRuleSetVersion: null,
          taxCalculationRevision: null,
          packetApprovalConfirmed: false,
          packetApprovalAt: null,
          packetApprovalByUserId: null,
        },
      });
      await invalidateBusinessBalancePackets(tx, draft.id, draft.userId);
      await tx.fbrConnection.updateMany({
        where: { filingDraftId: draft.id, userId: draft.userId },
        data: {
          status: "NOT_STARTED",
          agentId: null,
          message: null,
          errorMessage: null,
          lastHeartbeat: null,
          startedAt: null,
          completedAt: null,
        },
      });

      return {
        success: true as const,
        accountingMethod: evidenceResult.accountingMethod,
        incomeTotal: evidenceResult.incomeTotal,
        incomeBySubcategory: evidenceResult.incomeBySubcategory,
        incomeByInvoice: evidenceResult.incomeByInvoice,
        invoiceCount: invoiceRows.length,
        payoutMatchCount: normalizedMatches.length,
      };
    });
  } catch (error) {
    console.error("Error saving verified Services income evidence:", error);
    return invalid("Could not save Services income evidence. Refresh the filing and try again.");
  }
}
