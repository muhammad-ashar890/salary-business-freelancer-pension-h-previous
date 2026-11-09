import type { PrismaClient } from "@prisma/client";

import { storedDocumentReviewRequiredErrors } from "@/lib/tax/document-review-required";
import {
  approvedPreviousReturnFromDocuments,
  previousReturnCnicMismatch,
} from "@/lib/tax/previous-return-fields";
import {
  bankEntryDirectionError,
  businessBankDecisionError,
  freelancerBankDecisionError,
  unselectedIncomeSourceBankError,
  isMyselfBusinessBankFlow,
  isSingleFreelancerServicesFiling,
  normalizeBankCategory,
} from "@/lib/tax/business-bank-categories";
import { prisma } from "@/lib/prisma";
import {
  findLikelyInternalTransferPairs,
  findTransferLookalikePairs,
} from "@/lib/tax/bank-transfer-matching";
import { getRequiredTaxDocumentTypesForCurrentFlow } from "@/lib/tax/document-requirements";
import {
  classifyTransaction,
  isPlaceholderIncomeCategory,
} from "@/lib/tax/bank-classification-rules";
import { toMoneyAmount } from "@/lib/money";
import {
  BANK_TRANSACTION_EXCLUDED_EVENT_TYPE,
  latestBankExclusionReasons,
} from "@/lib/tax/bank-exclusion-review";
import { isGiftCategory, validateGiftDonorId } from "@/lib/tax/gift-income";
import { validatePakistaniIban } from "@/lib/tax/iban";
import type { TaxIncomeSource } from "@/lib/tax/filing-drafts";
import { validateTaxYearStatement } from "@/lib/tax/tax-year-period";

const FINAL_TRANSACTION_STATUSES = new Set([
  "APPROVED",
  "REJECTED",
  "TRANSFER",
  "CASH_MOVEMENT",
]);

const READY_DOCUMENT_STATUSES = new Set(["COMPLETED", "MAPPED"]);
const DOCUMENT_TYPES_REQUIRING_MAPPING = new Set([
  "business_books",
  // Required for business income (16-Oct); its reviewed figures enter FBR.
  "business_balance_sheet",
  "bank_statement",
  "salary_certificate",
  "pension_statement",
  // Optional to upload, but once uploaded it must be reviewed and mapped:
  // an unapproved previous return would otherwise ride along as evidence
  // nobody confirmed (see the dedicated blocker below).
  "previous_return",
  // An extracted invoice summary only becomes Services income evidence once it
  // is mapped: invoice rows are created by the map action, not extraction.
  "invoice_summary",
]);

type FilingCompletenessInput = {
  draftId: string;
  userId: string;
};

type FilingCompletenessDatabase = Pick<
  PrismaClient,
  | "filingDraft"
  | "bankAccount"
  | "document"
  | "bankStatement"
  | "bankTransaction"
> &
  Partial<Pick<PrismaClient, "taxAuditEvent" | "user">>;

export type FilingCompletenessResult = {
  success: boolean;
  blockers: string[];
};

function parseIncomeSources(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? (parsed.map(String) as TaxIncomeSource[])
      : [];
  } catch {
    return [];
  }
}

function accountName(account: { bankName: string; accountLabel: string }) {
  return `${account.bankName} — ${account.accountLabel}`;
}

function uniqueMessages(messages: string[]) {
  return Array.from(new Set(messages));
}

/**
 * Authoritative pre-filing integrity gate.
 *
 * This validates slot-based required documents and every configured bank
 * account from persisted rows. It deliberately does not trust wizard-local
 * completion flags. The same function is used by Bank Intelligence,
 * pre-packet approval, packet generation, final approval, and FBR start.
 */
export async function validateFilingCompleteness(
  input: FilingCompletenessInput,
  database: FilingCompletenessDatabase = prisma,
): Promise<FilingCompletenessResult> {
  const draft = await database.filingDraft.findFirst({
    where: { id: input.draftId, userId: input.userId },
    select: {
      id: true,
      userId: true,
      taxYear: true,
      incomeSources: true,
      filerType: true,
    },
  });

  if (!draft) {
    return { success: false, blockers: ["Filing draft not found"] };
  }

  const [accounts, documents, statements, transactions] = await Promise.all([
    database.bankAccount.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        bankName: true,
        accountLabel: true,
        iban: true,
        currency: true,
      },
    }),
    database.document.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        documentType: true,
        bankAccountId: true,
        extractionStatus: true,
        extractedData: true,
      },
    }),
    database.bankStatement.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        bankAccountId: true,
        sourceDocumentId: true,
        currency: true,
        periodStart: true,
        periodEnd: true,
      },
    }),
    database.bankTransaction.findMany({
      where: { filingDraftId: draft.id, userId: draft.userId },
      select: {
        id: true,
        bankAccountId: true,
        bankStatementId: true,
        transactionDate: true,
        description: true,
        debit: true,
        credit: true,
        classificationStatus: true,
        suggestedEntryType: true,
        suggestedCategory: true,
        giftDonorId: true,
      },
    }),
  ]);

  const blockers: string[] = [];
  const incomeSources = parseIncomeSources(draft.incomeSources);
  const requiredDocumentTypes = getRequiredTaxDocumentTypesForCurrentFlow({
    incomeSources,
  });

  // Non-bank requirements are keyed by their document type. Because rows are
  // newest-first, only assign a slot once; this avoids the historical bug
  // where Map construction silently let the oldest upload win.
  for (const documentType of requiredDocumentTypes) {
    if (documentType === "bank_statement") continue;

    const latestDocument = documents.find(
      (document) => document.documentType === documentType,
    );
    if (!latestDocument) {
      blockers.push(`Upload the required ${documentType} document`);
      continue;
    }

    if (documentType === "pension_statement") {
      for (const error of storedDocumentReviewRequiredErrors(documentType, latestDocument.extractedData, draft.taxYear)) {
        blockers.push(`Pension Statement: ${error}`);
      }
    }
    if (documentType === "business_books") {
      for (const error of storedDocumentReviewRequiredErrors(
        documentType,
        latestDocument.extractedData,
        draft.taxYear,
      )) {
        blockers.push(`Business Books: ${error}`);
      }
    }

    // Business Balance Sheet (16-Oct): every row is required (0 allowed) and
    // the rows must add up to the totals. A sheet mapped before that rule is
    // read-only, so the way out is a new upload.
    if (documentType === "business_balance_sheet") {
      const sheetErrors = storedDocumentReviewRequiredErrors(
        documentType,
        latestDocument.extractedData,
        draft.taxYear,
      );
      for (const error of sheetErrors) {
        blockers.push(`Business Balance Sheet: ${error}`);
      }
      if (sheetErrors.length && latestDocument.extractionStatus === "MAPPED") {
        blockers.push(
          "Business Balance Sheet: it was mapped before every row had to be filled and add up to the totals. On Upload documents press Replace, upload it again, fill every row (0 if the business has none) and press Save & Approve Map.",
        );
      }
    }

    const requiresMapping = DOCUMENT_TYPES_REQUIRING_MAPPING.has(documentType);
    const ready = requiresMapping
      ? latestDocument.extractionStatus === "MAPPED"
      : READY_DOCUMENT_STATUSES.has(latestDocument.extractionStatus);
    if (!ready) {
      blockers.push(
        `Review and approve/map the required ${documentType} document`,
      );
    }
  }

  // Previous Year Tax Return (optional upload, carry-forward evidence): the
  // slot never gates a filing by its absence, but a taxpayer who DID upload
  // one must review and approve/map it before the filing can proceed.
  const previousReturnDocument = documents.find(
    (document) => document.documentType === "previous_return",
  );
  if (previousReturnDocument) {
    for (const error of storedDocumentReviewRequiredErrors(
      "previous_return",
      previousReturnDocument.extractedData,
      draft.taxYear,
    )) {
      blockers.push(`Previous Year Tax Return: ${error}`);
    }
    if (previousReturnDocument.extractionStatus !== "MAPPED") {
      blockers.push(
        "Previous Year Tax Return: you uploaded a previous return, so review and approve/map it before this filing can proceed (or replace it with the correct previous-year return).",
      );
    } else if (database.user) {
      // An approved previous return must be THIS taxpayer's return: its
      // printed Registration No has to match the profile CNIC (when the
      // profile carries one). Checked here, at the final gate, so the order
      // in which the CNIC and the previous return were approved never
      // matters.
      const snapshot = approvedPreviousReturnFromDocuments(
        documents,
        draft.taxYear,
      );
      if (snapshot) {
        const profile = await database.user.findUnique({
          where: { id: draft.userId },
          select: { cnic: true },
        });
        if (previousReturnCnicMismatch(snapshot, profile?.cnic)) {
          blockers.push(
            "Previous Year Tax Return: its Registration No does not match this taxpayer's CNIC on the profile; replace it with this taxpayer's own previous-year return.",
          );
        }
      }
    }
  }

  if (requiredDocumentTypes.includes("bank_statement")) {
    if (accounts.length === 0) {
      blockers.push(
        "Configure at least one bank account and map its statement",
      );
    }

    const configuredAccountIds = new Set(accounts.map((account) => account.id));
    const statementByAccount = new Map<string, (typeof statements)[number]>();

    for (const account of accounts) {
      const label = accountName(account);
      if (account.currency.trim().toUpperCase() !== "PKR") {
        blockers.push(`${label}: bank account currency must be PKR`);
      }
      // IRIS lists a bank in the Wealth Statement by IBAN; without a valid one
      // the account cannot be declared there, so the filing cannot proceed.
      const ibanCheck = validatePakistaniIban(account.iban);
      if (!ibanCheck.valid) {
        blockers.push(`${label}: ${ibanCheck.error}`);
      }

      const accountDocuments = documents.filter(
        (document) =>
          document.documentType === "bank_statement" &&
          document.bankAccountId === account.id,
      );
      const accountStatements = statements.filter(
        (statement) => statement.bankAccountId === account.id,
      );

      if (accountDocuments.length === 0) {
        blockers.push(`${label}: upload and map a bank statement`);
      } else if (accountDocuments.length > 1) {
        blockers.push(
          `${label}: multiple current bank statement documents exist; replace them with one current mapped statement`,
        );
      }

      const currentDocument = accountDocuments[0];
      if (currentDocument && currentDocument.extractionStatus !== "MAPPED") {
        blockers.push(`${label}: bank statement document must be mapped`);
      }

      if (accountStatements.length === 0) {
        blockers.push(`${label}: save a valid bank statement record`);
        continue;
      }
      if (accountStatements.length > 1) {
        blockers.push(
          `${label}: multiple bank statement records exist; keep one current statement`,
        );
        continue;
      }

      const statement = accountStatements[0];
      statementByAccount.set(account.id, statement);

      if (
        !currentDocument ||
        statement.sourceDocumentId !== currentDocument.id
      ) {
        blockers.push(
          `${label}: saved statement must come from the current mapped account document`,
        );
      }

      // A statement with no transactions cannot be reconciled or classified,
      // so each account must carry the transactions it was filed from.
      if (
        !transactions.some(
          (transaction) => transaction.bankStatementId === statement.id,
        )
      ) {
        blockers.push(
          `${label}: import the transactions from this bank statement`,
        );
      }

      const statementValidation = validateTaxYearStatement({
        taxYear: draft.taxYear,
        periodStart: statement.periodStart,
        periodEnd: statement.periodEnd,
        currency: statement.currency || account.currency,
      });
      if (!statementValidation.valid) {
        blockers.push(`${label}: ${statementValidation.error}`);
      }
    }

    // Legacy unassigned document rows do not satisfy an account slot, but are
    // ignored once every configured account has its own current document.
    // Orphan statement/transaction rows are still unsafe because they feed
    // balances and ledgers, so those must block progression.
    const invalidStatement = statements.find(
      (statement) =>
        !statement.bankAccountId ||
        !configuredAccountIds.has(statement.bankAccountId),
    );
    if (invalidStatement) {
      blockers.push(
        "Every bank statement record must belong to a configured account",
      );
    }

    const incorrectlyLinkedTransaction = transactions.find((transaction) => {
      if (
        !transaction.bankAccountId ||
        !configuredAccountIds.has(transaction.bankAccountId)
      ) {
        return true;
      }
      const statement = statementByAccount.get(transaction.bankAccountId);
      return !statement || transaction.bankStatementId !== statement.id;
    });
    if (incorrectlyLinkedTransaction) {
      blockers.push(
        "Every bank transaction must be linked to its configured account's current statement",
      );
    }
  }

  if (
    transactions.some(
      (transaction) =>
        !FINAL_TRANSACTION_STATUSES.has(transaction.classificationStatus),
    )
  ) {
    blockers.push("Review every bank transaction before approval or filing");
  }

  const freelancerEnabled = isSingleFreelancerServicesFiling(draft);
  if (freelancerEnabled) {
    const rejectedPositiveCredits = transactions.filter(
      (transaction) =>
        transaction.classificationStatus === "REJECTED" &&
        toMoneyAmount(transaction.credit) > 0,
    );
    const exclusionEvents =
      rejectedPositiveCredits.length > 0 && database.taxAuditEvent
        ? await database.taxAuditEvent.findMany({
            where: {
              filingDraftId: draft.id,
              userId: draft.userId,
              eventType: BANK_TRANSACTION_EXCLUDED_EVENT_TYPE,
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { eventDataJson: true },
          })
        : [];
    const exclusionReasons = latestBankExclusionReasons(exclusionEvents);
    const businessEnabled = isMyselfBusinessBankFlow(draft);

    for (const transaction of rejectedPositiveCredits) {
      if (!exclusionReasons.has(transaction.id)) {
        blockers.push(
          `Positive bank credit was excluded without a saved review reason: ${transaction.description}. Undo the exclusion, review the credit, and record why it is not income.`,
        );
      }

      const deterministicSuggestion = classifyTransaction(
        transaction,
        transactions,
        { businessEnabled, freelancerEnabled: true },
      );
      if (
        deterministicSuggestion.entryType === "INCOME" &&
        deterministicSuggestion.category === "SERVICES"
      ) {
        blockers.push(
          `This excluded credit clearly matches Freelancer services income: ${transaction.description}. Undo the exclusion and review it as Income > Services, or choose another supported category if the bank record is genuinely different.`,
        );
      }
    }

    // Catch legacy decisions and wrong-category approvals too: a deterministic,
    // clearly worded Services receipt must not disappear into another income
    // category or be left excluded without a fresh review.
    for (const transaction of transactions) {
      if (transaction.classificationStatus !== "APPROVED") continue;
      const deterministicSuggestion = classifyTransaction(
        transaction,
        transactions,
        { businessEnabled, freelancerEnabled: true },
      );
      if (
        deterministicSuggestion.entryType === "INCOME" &&
        deterministicSuggestion.category === "SERVICES" &&
        (transaction.suggestedEntryType !== "INCOME" ||
          normalizeBankCategory(transaction.suggestedCategory) !== "SERVICES")
      ) {
        blockers.push(
          `This bank credit clearly matches Freelancer services income but was approved under another category: ${transaction.description}. Undo and review the correct income category before calculating.`,
        );
      }
    }
  }

  for (const transaction of transactions) {
    if (transaction.classificationStatus !== "TRANSFER") continue;

    const counterparts = findLikelyInternalTransferPairs(
      transaction,
      transactions,
    );
    if (counterparts.length === 0) {
      blockers.push(
        `Internal transfer has no matching opposite account entry: ${transaction.description}`,
      );
      continue;
    }
    if (counterparts.length > 1) {
      blockers.push(
        `Internal transfer has multiple possible matches and needs manual review: ${transaction.description}`,
      );
      continue;
    }
    if (counterparts[0].classificationStatus !== "TRANSFER") {
      blockers.push(
        "Both sides of an internal transfer must have the Internal Transfer decision",
      );
    }
  }

  // Old approved decisions are not silently rewritten. A changed setup or a
  // wrong-direction legacy approval must be undone and reviewed by the owner.
  for (const transaction of transactions) {
    if (transaction.classificationStatus !== "APPROVED") continue;
    const error =
      bankEntryDirectionError(transaction, transaction.suggestedEntryType) ||
      businessBankDecisionError(
        transaction.suggestedEntryType ?? "",
        transaction.suggestedCategory,
        isMyselfBusinessBankFlow(draft),
      ) ||
      freelancerBankDecisionError(
        transaction.suggestedEntryType ?? "",
        transaction.suggestedCategory,
        freelancerEnabled,
      ) ||
      unselectedIncomeSourceBankError(
        transaction.suggestedEntryType,
        transaction.suggestedCategory,
        incomeSources,
      );
    if (error)
      blockers.push(`${error} Undo and review: ${transaction.description}`);
  }

  // An unexplained credit approved "as income" was booked under the placeholder
  // category: it has no IRIS row and would be taxed. Name the row.
  for (const transaction of transactions) {
    if (
      transaction.classificationStatus === "APPROVED" &&
      isPlaceholderIncomeCategory(transaction.suggestedCategory)
    ) {
      blockers.push(
        `A credit was approved as income without saying what it is: ${transaction.description}. Undo it, then use the pencil icon to choose Salary, Gift, Other income, or another decision.`,
      );
    }
  }

  // IRIS asks who gave a gift, so an approved gift without the donor's number
  // cannot be entered; stop here and name the row.
  for (const transaction of transactions) {
    if (
      transaction.classificationStatus === "APPROVED" &&
      transaction.suggestedEntryType === "INCOME" &&
      isGiftCategory(transaction.suggestedCategory) &&
      !validateGiftDonorId(transaction.giftDonorId).valid
    ) {
      blockers.push(
        `Gift needs the donor's CNIC or registration number: ${transaction.description}`,
      );
    }
  }

  // An own-account transfer booked as income or an expense is counted as earned
  // or spent. The two sides cancel in the reconciliation gap, so nothing later
  // would notice; stop it here and say which rows.
  const accountLabelById = new Map(
    accounts.map((account) => [account.id, accountName(account)]),
  );
  for (const { first, second } of findTransferLookalikePairs(transactions)) {
    const describe = (row: (typeof transactions)[number]) =>
      `"${row.description}" (${
        accountLabelById.get(row.bankAccountId ?? "") ?? "unknown account"
      })`;
    blockers.push(
      `These look like one internal transfer but were booked as income or an expense: ${describe(first)} and ${describe(second)}. Undo both and mark each side as Internal transfer.`,
    );
  }

  const uniqueBlockers = uniqueMessages(blockers);
  return {
    success: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
  };
}
