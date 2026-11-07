"use server";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { getServerSession } from "next-auth/next";

import { createNotification } from "@/app/actions/notifications";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";
import {
  findLikelyInternalTransferPairs,
  hasInternalTransferLanguage,
  isTransferLookalike,
  type TransferCandidate,
} from "@/lib/tax/bank-transfer-matching";
import {
  PLACEHOLDER_INCOME_ERROR,
  classifyTransaction,
  isPlaceholderIncomeCategory,
  isRefundOrReversalDescription,
} from "@/lib/tax/bank-classification-rules";
import {
  isMyselfBusinessBankFlow,
  isSingleFreelancerServicesFiling,
  isBusinessBankCategory,
  normalizeBankCategory,
  businessBankDecisionError,
  freelancerBankDecisionError,
  bankEntryDirectionError,
  applySafeBankAiSuggestion,
  hasOwnerCapitalMovementDescription,
  OWNER_CAPITAL_REVIEW_ERROR,
} from "@/lib/tax/business-bank-categories";
import {
  BANK_TRANSACTION_EXCLUDED_EVENT_TYPE,
  buildBankExclusionEventData,
  normalizeBankExclusionReason,
} from "@/lib/tax/bank-exclusion-review";
import { isGiftCategory, validateGiftDonorId } from "@/lib/tax/gift-income";
import { validateFilingCompleteness } from "@/lib/tax/filing-completeness";
import { validateTaxYearStatement } from "@/lib/tax/tax-year-period";
import {
  toMoneyAmount,
  toMoneyNumber,
  type MoneyInput,
  toMoneyNumberOrNull,
} from "@/lib/money";

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
      incomeSelections: {where:{source:"business",subcategory:"profit-return",status:"SELECTED"},select:{detailsJson:true}},
    },
  });

  if (!draft) throw new Error("Filing draft not found");

  return draft;
}

function declaredBusinessIbans(draft: {incomeSelections?: {detailsJson:string}[]}) {
  const ibans=new Set<string>();
  for(const selection of draft.incomeSelections ?? []) {
    try {const accounts=JSON.parse(selection.detailsJson)?.userDetails?.businessBankAccounts;
      if(Array.isArray(accounts))for(const account of accounts)if(typeof account?.iban==='string')ibans.add(account.iban.replace(/\s/g,'').toUpperCase());
    }catch{/* Missing/invalid context never authorizes generic personal account costs as business. */}
  }
  return ibans;
}
function isConfirmedBusinessAccount(draft: {incomeSelections?: {detailsJson:string}[]}, iban:unknown) {
  return typeof iban==='string' && declaredBusinessIbans(draft).has(iban.replace(/\s/g,'').toUpperCase());
}

async function invalidateDerivedFilingState(draft: {
  id: string;
  userId: string;
}) {
  await prisma.$transaction(async (tx) => {
    await tx.ledgerEntry.deleteMany({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        source: "RECONCILIATION_AUTO_ADJUSTMENT",
      },
    });

    await tx.filingDraft.update({
      where: { id: draft.id },
      data: {
        reconciliationStatus: "UNRESOLVED",
        reconciliationMethod: null,
        reconciliationNote: null,
        reconciliationGap: null,
        openingWealth: null,
        closingWealth: null,
        taxableIncome: null,
        taxWithheld: null,
        taxPayable: null,
        refundDue: null,
        taxCalculationStatus: "NOT_CALCULATED",
        packetApprovalConfirmed: false,
        packetApprovalAt: null,
        packetApprovalByUserId: null,
        status: "IN_PROGRESS",
      },
    });

    await tx.filingPacket.updateMany({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        status: { not: "SUPERSEDED" },
      },
      data: { status: "SUPERSEDED", approvalStatus: "SUPERSEDED" },
    });

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
  });
}

type TransferDecisionCandidate = TransferCandidate & {
  classificationStatus: string;
  suggestedEntryType: string | null;
  suggestedCategory: string | null;
};

async function getTransferCounterparts(
  draft: { id: string; userId: string },
  transaction: TransferCandidate,
) {
  const candidates = await prisma.bankTransaction.findMany({
    where: {
      filingDraftId: draft.id,
      userId: draft.userId,
      id: { not: transaction.id },
      bankAccountId: { not: null },
    },
    select: {
      id: true,
      bankAccountId: true,
      transactionDate: true,
      description: true,
      debit: true,
      credit: true,
      classificationStatus: true,
      suggestedEntryType: true,
      suggestedCategory: true,
    },
  });

  return findLikelyInternalTransferPairs<TransferDecisionCandidate>(
    transaction,
    candidates,
  );
}

const TRANSFER_LOOKALIKE_ERROR =
  "This reads like a transfer between your own accounts, so it cannot be booked as income or an expense. Mark it as an Internal transfer on both sides instead.";

function isDeterministicServicesCredit(
  transaction: TransferCandidate,
  draft: { incomeSources: string; taxYear: number; filerType: string | null },
  transferCandidates: TransferCandidate[] = [],
) {
  if (
    !isSingleFreelancerServicesFiling(draft) ||
    toMoneyAmount(transaction.credit) <= 0
  ) {
    return false;
  }
  const suggestion = classifyTransaction(transaction, transferCandidates, {
    businessEnabled: isMyselfBusinessBankFlow(draft),
    freelancerEnabled: true,
  });
  return suggestion.entryType === "INCOME" && suggestion.category === "SERVICES";
}

type GeminiClassification = {
  transactionId: string;
  classification:
    | "income"
    | "expense"
    | "asset"
    | "liability"
    | "internal_transfer"
    | "cash_movement"
    | "unknown";
  category?: string;
  confidence?: number;
  reason?: string;
};

function maskSensitiveDescription(description: string) {
  return description.slice(0, 240).replace(/\b\d{8,}\b/g, "[redacted]");
}

function parseGeminiClassifications(text: string) {
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned) as GeminiClassification[];
  } catch {
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start < 0 || end <= start) return [];
    try {
      return JSON.parse(
        cleaned.slice(start, end + 1),
      ) as GeminiClassification[];
    } catch {
      return [];
    }
  }
}

type OwnedAccountContext = {
  id: string;
  bankName: string;
  accountLabel: string;
  accountNumberMasked: string | null;
};

function safeMaskedAccountNumber(value: string | null) {
  if (!value) return null;
  const compact = value.replace(/\s+/g, "");
  const suffix = compact.slice(-4);
  return suffix ? `****${suffix}` : null;
}

/**
 * Rows sent to Gemini in a single request.
 *
 * This is a prompt-size limit, NOT a limit on how much of a statement gets
 * classified. A very long prompt is truncated or refused by the model, so the
 * work is split into chunks of this size and every chunk is sent. A full tax
 * year of transactions is classified in full.
 */
const GEMINI_CLASSIFICATION_CHUNK_SIZE = 100;

/**
 * How many chunks are sent in parallel. Keeps a large statement fast without
 * opening hundreds of simultaneous connections to the model.
 */
const GEMINI_CLASSIFICATION_CONCURRENCY = 3;

/**
 * Per-user budget on chunks, over a ten minute window.
 *
 * Sized so that a legitimate run is never blocked: one full tax year of bank
 * activity is on the order of a few thousand rows, of which only the ambiguous
 * ones reach Gemini. At 100 rows per chunk this budget covers 12,000 ambiguous
 * rows every ten minutes, which is several complete statements. It exists to
 * stop a runaway loop or a scripted abuse of a paid endpoint, not to ration
 * normal use.
 */
const GEMINI_CLASSIFICATION_CHUNK_BUDGET = 120;
const GEMINI_CLASSIFICATION_WINDOW_MS = 10 * 60 * 1000;

type ClassifiableTransaction = {
  id: string;
  bankAccountId: string | null;
  transactionDate: Date | null;
  description: string;
  debit: MoneyInput;
  credit: MoneyInput;
  balance: MoneyInput;
};

async function classifyChunkWithGemini(
  batch: ClassifiableTransaction[],
  ownedAccounts: OwnedAccountContext[],
  apiKey: string,
  businessEnabled = false,
  freelancerEnabled = false,
) {
  try {
    const modelName = process.env.GEMINI_MODEL || "gemini-3.5-flash";
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: modelName,
    });
    const prompt = `You are reviewing ambiguous Pakistani bank transactions for a tax ledger.
Return only a JSON array. Do not invent facts.
For each row choose exactly one classification:
- income: only when the description strongly indicates earned income
- expense: only when the description strongly indicates a personal/business expense
- asset: an identifiable asset purchase
- liability: loan/financing proceeds
- internal_transfer: likely movement between the taxpayer's own accounts
- cash_movement: ATM/cash movement that is not automatically an expense
- unknown: insufficient evidence
Generic credits must not be automatically treated as income unless evidence supports it. A refund, reversal, chargeback, or returned payment is not new earned income; return unknown unless a linked original transaction supports a specific adjustment.
Debit/credit direction is mandatory: income/liability require a positive credit and zero debit; expense/asset require a positive debit and zero credit. A mention of withholding in a net customer credit is not a tax-payment debit.
Allowed income categories: SALARY, PENSION, BANK_PROFIT, PROPERTY_RENT, DIVIDEND, GIFT, OTHER_INCOME${freelancerEnabled ? ", SERVICES" : ""}.
Allowed expense categories: PERSONAL_EXPENSE, UTILITIES_OR_RENT, TRANSPORT, BANK_CHARGES, TAX_PAYMENT, OTHER_EXPENSE.
Allowed asset categories: PROPERTY, VEHICLE, EQUIPMENT, INVESTMENT, OTHER_ASSET. Allowed liability categories: LOAN_PROCEEDS, CREDIT_CARD, OTHER_LIABILITY.
${freelancerEnabled ? "This is an exact supported TY2026 Myself Freelancer / Services route (Services alone, exactly Salary + Services, or exactly Pension + Services). For a credit whose description clearly identifies a freelance client-service invoice, freelance payout, or export-of-services receipt, use income category SERVICES and explain that this is a review suggestion, not a final tax determination. A platform or wallet name alone is not enough. Do not classify refunds/reversals, gifts, cash deposits, or own-account transfers as freelancer income. Explicit platform fees, software subscriptions, domain or hosting charges may be suggested as OTHER_EXPENSE for review only; do not infer deductibility from a bank narration. Mixed-use internet, mobile, rent, and household costs need allocation and should not be assumed fully business-related." : "The exact supported Freelancer / Services source set is not enabled; do not use SERVICES for bank transactions."}
${businessEnabled ? "This is a Myself / Business Income / TY2026 filing. For explicitly business-linked records also use BUSINESS_SALES or BUSINESS_OTHER_RECEIPTS for incoming receipts, and BUSINESS_COST_OF_SALES or BUSINESS_OPERATING_EXPENSE for outgoing costs. Owner drawings, proprietor withdrawals, capital contributions and descriptions saying not business expense must remain unknown/manual; never map them to income or an expense, or assume cash/internal transfer without evidence. These are bank cash records, not additional taxable profit. Do not label business receipts OTHER_INCOME. Selecting business income does not make every personal bank transaction business." : "Business-specific categories are not enabled for this filing."}
When the description cannot establish a category, return unknown rather than inventing one.
A description such as "transfer from HBL Salary Account" refers to an account, not necessarily salary income.
Use the owned-account context below to identify likely movements between the taxpayer's own accounts.
Each item must have this shape:
{"transactionId":"string","classification":"income|expense|asset|liability|internal_transfer|cash_movement|unknown","category":"string","confidence":0.0,"reason":"short explanation"}

Owned accounts (masked):
${JSON.stringify(
  ownedAccounts.map((account) => ({
    bankName: account.bankName,
    accountLabel: account.accountLabel,
    accountNumberMasked: safeMaskedAccountNumber(account.accountNumberMasked),
  })),
)}

Rows:
${JSON.stringify(
  batch.map((transaction) => {
    const account = ownedAccounts.find(
      (candidate) => candidate.id === transaction.bankAccountId,
    );
    return {
      transactionId: transaction.id,
      account: account
        ? {
            bankName: account.bankName,
            accountLabel: account.accountLabel,
            accountNumberMasked: safeMaskedAccountNumber(
              account.accountNumberMasked,
            ),
          }
        : null,
      date: transaction.transactionDate?.toISOString().slice(0, 10) ?? null,
      description: maskSensitiveDescription(transaction.description),
      // Decimal is not JSON-serialisable as a number; it would reach the
      // browser as a string. Converted here, at the boundary.
      debit: toMoneyNumberOrNull(transaction.debit),
      credit: toMoneyNumberOrNull(transaction.credit),
      balance: toMoneyNumberOrNull(transaction.balance),
    };
  }),
)}`;

    const result = await model.generateContent([{ text: prompt }]);
    const parsed = parseGeminiClassifications(result.response.text());
    return new Map(
      parsed
        .filter((item) => item && typeof item.transactionId === "string")
        .map((item) => [item.transactionId, item]),
    );
  } catch (error) {
    // One failed chunk must not lose the chunks that succeeded. The rows in
    // this chunk simply keep their rule-based suggestion.
    console.error("Gemini bank classification chunk failed:", error);
    return new Map<string, GeminiClassification>();
  }
}

/**
 * Classifies every ambiguous transaction, splitting the work into
 * prompt-sized chunks rather than discarding the overflow.
 */
async function classifyAmbiguousTransactionsWithGemini(
  transactions: ClassifiableTransaction[],
  ownedAccounts: OwnedAccountContext[],
  userId: string,
  businessEnabled = false,
  freelancerEnabled = false,
) {
  const merged = new Map<string, GeminiClassification>();

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || transactions.length === 0) return merged;

  const chunks: ClassifiableTransaction[][] = [];
  for (
    let index = 0;
    index < transactions.length;
    index += GEMINI_CLASSIFICATION_CHUNK_SIZE
  ) {
    chunks.push(
      transactions.slice(index, index + GEMINI_CLASSIFICATION_CHUNK_SIZE),
    );
  }

  for (
    let cursor = 0;
    cursor < chunks.length;
    cursor += GEMINI_CLASSIFICATION_CONCURRENCY
  ) {
    const wave = chunks.slice(
      cursor,
      cursor + GEMINI_CLASSIFICATION_CONCURRENCY,
    );

    // The budget is charged per chunk, so cost tracks actual model usage
    // rather than the number of times the user pressed the button. Running
    // out is not an error: classification is an assist over the rule-based
    // result, so remaining rows keep that result and the user still sees a
    // fully classified statement.
    const affordable: ClassifiableTransaction[][] = [];
    for (const chunk of wave) {
      const budget = consumeRateLimit(
        `gemini-classification:${userId}`,
        GEMINI_CLASSIFICATION_CHUNK_BUDGET,
        GEMINI_CLASSIFICATION_WINDOW_MS,
      );
      if (!budget.allowed) break;
      affordable.push(chunk);
    }

    if (affordable.length === 0) {
      console.warn(
        `Gemini classification budget exhausted for user ${userId}; ${
          chunks.length - cursor
        } chunk(s) fall back to rule-based classification.`,
      );
      break;
    }

    const results = await Promise.all(
      affordable.map((chunk) =>
        classifyChunkWithGemini(
          chunk,
          ownedAccounts,
          apiKey,
          businessEnabled,
          freelancerEnabled,
        ),
      ),
    );
    for (const result of results) {
      for (const [id, classification] of result) merged.set(id, classification);
    }

    if (affordable.length < wave.length) break;
  }

  return merged;
}

function applyGeminiClassification(
  suggestion: GeminiClassification | undefined,
  transaction: ClassifiableTransaction,
  businessEnabled = false,
  freelancerEnabled = false,
) {
  return applySafeBankAiSuggestion(
    suggestion,
    transaction,
    businessEnabled,
    freelancerEnabled,
  );
}

export type ClassificationStatementInput = Readonly<{
  bankAccountId: string;
  openingBalance: number;
  closingBalance: number;
  periodStart: string;
  periodEnd: string;
}>;

export async function classifyBankTransactionsAction(
  draftId: string,
  statementInput: ClassificationStatementInput,
) {
  try {
    const draft = await getOwnedDraft(draftId);
    const businessEnabled = isMyselfBusinessBankFlow(draft);
    const freelancerEnabled = isSingleFreelancerServicesFiling(draft);
    const bankAccountId = statementInput.bankAccountId.trim();
    const statement = await prisma.bankStatement.findFirst({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        bankAccountId,
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        bankAccountId: true,
        currency: true,
        openingBalance: true,
        closingBalance: true,
        periodStart: true,
        periodEnd: true,
      },
    });

    if (!statement) {
      return {
        success: false,
        error: "Save statement balances before classifying transactions",
      };
    }

    const statementValidation = validateTaxYearStatement({
      taxYear: draft.taxYear,
      periodStart: statement.periodStart,
      periodEnd: statement.periodEnd,
      currency: statement.currency,
    });

    if (!statementValidation.valid) {
      return { success: false, error: statementValidation.error };
    }

    // The server cannot rely only on the button's disabled state: a client
    // may call this action directly or may have stale browser JavaScript.
    // Require the selected account's current form values to match its exact
    // persisted statement before classifying that account's transactions.
    const persistedStart =
      statement.periodStart?.toISOString().slice(0, 10) ?? "";
    const persistedEnd = statement.periodEnd?.toISOString().slice(0, 10) ?? "";
    const valuesMatch =
      statement.bankAccountId === bankAccountId &&
      // Money is stored as Decimal, and `===` against a number is always
      // false for a Decimal instance. Comparing the converted values keeps
      // this an equality check rather than an unconditional "changed".
      toMoneyNumber(statement.openingBalance) ===
        statementInput.openingBalance &&
      toMoneyNumber(statement.closingBalance) ===
        statementInput.closingBalance &&
      persistedStart === statementInput.periodStart &&
      persistedEnd === statementInput.periodEnd;

    if (!valuesMatch) {
      return {
        success: false,
        error: "Save statement balances before classifying transactions",
      };
    }

    const [transactions, transferCandidates, ownedAccounts] = await Promise.all(
      [
        prisma.bankTransaction.findMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            OR: [
              { bankAccountId },
              { bankAccountId: null, bankStatementId: statement.id },
            ],
          },
          orderBy: { createdAt: "asc" },
        }),
        prisma.bankTransaction.findMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            bankAccountId: { not: null },
          },
          select: {
            id: true,
            bankAccountId: true,
            transactionDate: true,
            description: true,
            debit: true,
            credit: true,
          },
        }),
        prisma.bankAccount.findMany({
          where: { filingDraftId: draft.id, userId: draft.userId },
          select: {
            id: true,
            bankName: true,
            accountLabel: true,
            accountNumberMasked: true,
            iban: true,
          },
          orderBy: { createdAt: "asc" },
        }),
      ],
    );

    const finalStatuses = new Set([
      "APPROVED",
      "REJECTED",
      "TRANSFER",
      "CASH_MOVEMENT",
    ]);
    const ruleSuggestions = transactions.map((transaction) => ({
      transaction,
      suggestion: finalStatuses.has(transaction.classificationStatus)
        ? {
            status: transaction.classificationStatus,
            entryType: transaction.suggestedEntryType,
            category: transaction.suggestedCategory,
            confidence: 1,
          }
        : classifyTransaction(transaction, transferCandidates, {
            businessEnabled,
            businessAccountConfirmed: isConfirmedBusinessAccount(draft,ownedAccounts.find(account=>account.id===transaction.bankAccountId)?.iban),
            freelancerEnabled,
          }),
    }));

    const ambiguous = ruleSuggestions
      .filter(item => !(businessEnabled && hasOwnerCapitalMovementDescription(item.transaction.description)))
      .filter(
        (item) =>
          (item.suggestion.status === "UNREVIEWED" ||
            item.suggestion.status === "POTENTIAL_INCOME") &&
          !isRefundOrReversalDescription(item.transaction.description),
      )
      .map((item) => item.transaction);
    const aiSuggestions = await classifyAmbiguousTransactionsWithGemini(
      ambiguous,
      ownedAccounts,
      draft.userId,
      businessEnabled,
      freelancerEnabled,
    );

    const suggestions = ruleSuggestions.map(({ transaction, suggestion }) => {
      const useAiFallback =
        !(businessEnabled && hasOwnerCapitalMovementDescription(transaction.description)) &&
        !isRefundOrReversalDescription(transaction.description) &&
        (suggestion.status === "UNREVIEWED" || suggestion.status === "POTENTIAL_INCOME");
      const aiResult = useAiFallback
        ? aiSuggestions.get(transaction.id)
        : undefined;
      const aiSuggestion =
        aiResult && aiResult.classification !== "unknown"
          ? applyGeminiClassification(
              aiResult,
              transaction,
              businessEnabled,
              freelancerEnabled,
            )
          : suggestion;

      return { id: transaction.id, ...aiSuggestion };
    });

    await prisma.$transaction(
      suggestions.map((suggestion) =>
        prisma.bankTransaction.update({
          where: { id: suggestion.id },
          data: {
            classificationStatus: suggestion.status,
            suggestedEntryType: suggestion.entryType,
            suggestedCategory: suggestion.category,
          },
        }),
      ),
    );

    const reviewStatuses = new Set([
      "UNREVIEWED",
      "POTENTIAL_INCOME",
      "POTENTIAL_ASSET",
      "POTENTIAL_LIABILITY",
      "POTENTIAL_TRANSFER",
      "POTENTIAL_CASH_MOVEMENT",
    ]);
    const riskCount = suggestions.filter((suggestion) =>
      reviewStatuses.has(suggestion.status),
    ).length;

    if (riskCount > 0) {
      await createNotification({
        userId: draft.userId,
        type: "RISK_FLAG",
        title: `${riskCount} bank transaction(s) need review`,
        message:
          "Classification found transactions that need an explicit income, asset, liability, transfer or cash decision.",
        link: `/tax/new?draftId=${draft.id}`,
      });
    }

    await invalidateDerivedFilingState(draft);
    return { success: true, suggestions };
  } catch (error) {
    console.error("Error classifying bank transactions:", error);
    return { success: false, error: "Failed to classify bank transactions" };
  }
}

export async function validateBankTransactionReviewAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const validation = await validateFilingCompleteness({
      draftId: draft.id,
      userId: draft.userId,
    });

    if (!validation.success) {
      return {
        success: false,
        error: validation.blockers.join(" · "),
      };
    }

    return { success: true };
  } catch (error) {
    console.error("Error validating filing completeness:", error);
    return {
      success: false,
      error: "Failed to validate filing completeness",
    };
  }
}

export async function autoReviewSafeBankTransactionsAction(
  draftId: string,
  bankAccountId: string,
) {
  try {
    const draft = await getOwnedDraft(draftId);
    const freelancerEnabled = isSingleFreelancerServicesFiling(draft);
    const account = await prisma.bankAccount.findFirst({
      where: {
        id: bankAccountId.trim(),
        filingDraftId: draft.id,
        userId: draft.userId,
      },
      select: { id: true, iban: true },
    });
    if (!account) {
      return { success: false, error: "Select a valid bank account" };
    }

    const safeExpenseCategories = [
      "UTILITIES_OR_RENT",
      "PERSONAL_EXPENSE",
      "TRANSPORT",
      "BANK_CHARGES",
    ];
    const safeTransactions = await prisma.bankTransaction.findMany({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        bankAccountId: account.id,
        classificationStatus: "SUGGESTED",
        suggestedEntryType: { not: null },
        suggestedCategory: { not: null },
      },
      select: {
        id: true,
        bankAccountId: true,
        transactionDate: true,
        description: true,
        debit: true,
        credit: true,
        suggestedEntryType: true,
        suggestedCategory: true,
      },
    });

    // A row that reads like an own-account transfer is never "safe": it waits
    // for an explicit Internal transfer decision.
    const heldBackAsTransfers = new Set<string>();
    for (const transaction of safeTransactions) {
      if (!hasInternalTransferLanguage(transaction.description)) continue;
      const counterparts = await getTransferCounterparts(draft, transaction);
      if (isTransferLookalike(transaction, counterparts)) {
        heldBackAsTransfers.add(transaction.id);
      }
    }

    const confirmedBusinessAccount = isConfirmedBusinessAccount(draft,account.iban);
    const autoApproveIds = safeTransactions
      .filter(transaction => !(isMyselfBusinessBankFlow(draft) && hasOwnerCapitalMovementDescription(transaction.description)))
      .filter((transaction) => !heldBackAsTransfers.has(transaction.id))
      .filter(
        (transaction) =>
          !bankEntryDirectionError(transaction, transaction.suggestedEntryType),
      )
      .filter(
        (transaction) =>
          (transaction.suggestedEntryType === "EXPENSE" &&
            safeExpenseCategories.includes(
              transaction.suggestedCategory ?? "",
            )) ||
          (transaction.suggestedEntryType === "INCOME" &&
            // Pension payouts are as recognisable as payroll (same keyword
            // rule family), so a rule-matched PENSION suggestion is bulk-safe
            // exactly like SALARY. All other income stays manual.
            ["SALARY", "PENSION"].includes(
              transaction.suggestedCategory ?? "",
            )) ||
          (isMyselfBusinessBankFlow(draft) &&
            isBusinessBankCategory(transaction.suggestedCategory) &&
            !businessBankDecisionError(
              transaction.suggestedEntryType!,
              transaction.suggestedCategory,
              true,
            ) &&
            classifyTransaction(transaction, [], { businessEnabled: true, businessAccountConfirmed: confirmedBusinessAccount })
              .category === transaction.suggestedCategory) ||
          (freelancerEnabled &&
            transaction.suggestedEntryType === "INCOME" &&
            transaction.suggestedCategory === "SERVICES" &&
            !freelancerBankDecisionError(
              transaction.suggestedEntryType,
              transaction.suggestedCategory,
              freelancerEnabled,
            ) &&
            classifyTransaction(transaction, [], { freelancerEnabled })
              .category === transaction.suggestedCategory),
      )
      .map((transaction) => transaction.id);
    const affectedIds = autoApproveIds;

    await prisma.$transaction(async (tx) => {
      if (affectedIds.length > 0) {
        await tx.ledgerEntry.deleteMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            sourceTransactionId: { in: affectedIds },
          },
        });
      }
      if (autoApproveIds.length > 0) {
        await tx.bankTransaction.updateMany({
          where: { id: { in: autoApproveIds } },
          data: { classificationStatus: "APPROVED" },
        });
      }
    });

    await invalidateDerivedFilingState(draft);

    return {
      success: true,
      approvedCount: autoApproveIds.length,
    };
  } catch (error) {
    console.error("Error auto-reviewing safe bank transactions:", error);
    return { success: false, error: "Failed to auto-review safe transactions" };
  }
}

export async function undoBankTransactionClassificationAction(
  draftId: string,
  transactionId: string,
) {
  try {
    const draft = await getOwnedDraft(draftId);
    const transaction = await prisma.bankTransaction.findFirst({
      where: {
        id: transactionId,
        filingDraftId: draft.id,
        userId: draft.userId,
      },
      select: {
        id: true,
        bankAccountId: true,
        transactionDate: true,
        description: true,
        debit: true,
        credit: true,
        classificationStatus: true,
        suggestedEntryType: true,
        suggestedCategory: true,
      },
    });
    if (!transaction)
      return { success: false, error: "Bank transaction not found" };

    const counterparts =
      transaction.classificationStatus === "TRANSFER"
        ? await getTransferCounterparts(draft, transaction)
        : [];
    const pairedTransferCounterparts = counterparts.filter(
      (counterpart) => counterpart.classificationStatus === "TRANSFER",
    );
    if (pairedTransferCounterparts.length > 1) {
      return {
        success: false,
        error: "Multiple transfer matches found; review the account data first",
      };
    }

    const affectedTransactions = [transaction, ...pairedTransferCounterparts];
    const affectedIds = affectedTransactions.map((item) => item.id);

    // Undo returns each row to what the rules say about it today. Keeping the
    // old suggestion would hand back the taxpayer's own earlier manual choice
    // (for example Income / Property rent on a transfer) as if it were advice.
    const transferCandidates = await prisma.bankTransaction.findMany({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
        bankAccountId: { not: null },
      },
      select: {
        id: true,
        bankAccountId: true,
        transactionDate: true,
        description: true,
        debit: true,
        credit: true,
      },
    });

    await prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.deleteMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          sourceTransactionId: { in: affectedIds },
        },
      });
      for (const affected of affectedTransactions) {
        const fresh = classifyTransaction(affected, transferCandidates, {
          businessEnabled: isMyselfBusinessBankFlow(draft),
          freelancerEnabled: isSingleFreelancerServicesFiling(draft),
        });
        await tx.bankTransaction.update({
          where: { id: affected.id },
          data: {
            classificationStatus: fresh.status,
            suggestedEntryType: fresh.entryType,
            suggestedCategory: fresh.category,
          },
        });
      }
    });
    await invalidateDerivedFilingState(draft);
    return { success: true };
  } catch (error) {
    console.error("Error undoing bank classification:", error);
    return { success: false, error: "Failed to undo bank classification" };
  }
}

export async function manuallyClassifyBankTransactionAction(
  draftId: string,
  transactionId: string,
  entryType: "INCOME" | "EXPENSE" | "ASSET" | "LIABILITY" | "EXCLUDE",
  category: string,
  giftDonorId?: string,
  exclusionReasonInput?: string,
) {
  try {
    const draft = await getOwnedDraft(draftId);
    const transaction = await prisma.bankTransaction.findFirst({
      where: {
        id: transactionId,
        filingDraftId: draft.id,
        userId: draft.userId,
      },
    });
    if (!transaction)
      return { success: false, error: "Bank transaction not found" };

    if (transaction.classificationStatus === "TRANSFER") {
      const pairedTransfers = (
        await getTransferCounterparts(draft, transaction)
      ).filter(
        (counterpart) => counterpart.classificationStatus === "TRANSFER",
      );
      if (pairedTransfers.length > 0) {
        return {
          success: false,
          error:
            "This is a paired internal transfer. Use Undo first; both sides will be reopened together.",
        };
      }
    }

    if (entryType === "EXCLUDE") {
      const freelancerEnabled = isSingleFreelancerServicesFiling(draft);
      const exclusionReason = normalizeBankExclusionReason(exclusionReasonInput);
      // The reason is mandatory on the Services route (and whenever a newer
      // client explicitly sends the field). Existing non-Services screens that
      // have not yet been updated may omit it during this phased merge.
      if ((freelancerEnabled || exclusionReasonInput !== undefined) && !exclusionReason) {
        return {
          success: false,
          error: "Enter a short reason for excluding this transaction (at least 3 characters).",
        };
      }
      const transferCandidates = await getTransferCounterparts(draft, transaction);
      if (isDeterministicServicesCredit(transaction, draft, transferCandidates)) {
        return {
          success: false,
          error:
            "This credit clearly matches Freelancer services income. Do not exclude it; review it as Income > Services, or choose another supported category if the bank record is genuinely different.",
        };
      }

      await prisma.$transaction(async (tx) => {
        await tx.ledgerEntry.deleteMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            sourceTransactionId: transaction.id,
          },
        });
        await tx.bankTransaction.update({
          where: { id: transaction.id },
          data: {
            classificationStatus: "REJECTED",
            suggestedEntryType: null,
            suggestedCategory: freelancerEnabled ? "EXCLUDED" : category || "EXCLUDED",
            giftDonorId: null,
          },
        });
        if (exclusionReason) {
          await tx.taxAuditEvent.create({
            data: {
              userId: draft.userId,
              filingDraftId: draft.id,
              eventType: BANK_TRANSACTION_EXCLUDED_EVENT_TYPE,
              eventDataJson: buildBankExclusionEventData(
                transaction.id,
                exclusionReason,
              ),
            },
          });
        }
      });
      await invalidateDerivedFilingState(draft);
      return { success: true };
    }

    if(isMyselfBusinessBankFlow(draft) && hasOwnerCapitalMovementDescription(transaction.description)) return {success:false,error:OWNER_CAPITAL_REVIEW_ERROR};

    if (
      isTransferLookalike(
        transaction,
        await getTransferCounterparts(draft, transaction),
      )
    ) {
      return { success: false, error: TRANSFER_LOOKALIKE_ERROR };
    }

    const amount = toMoneyAmount(
      entryType === "INCOME" || entryType === "LIABILITY"
        ? transaction.credit
        : transaction.debit,
    );
    if (amount <= 0) {
      return {
        success: false,
        error: "Choose a transaction type matching the debit/credit amount",
      };
    }
    const directionError = bankEntryDirectionError(transaction, entryType);
    const businessError = businessBankDecisionError(
      entryType,
      category,
      isMyselfBusinessBankFlow(draft),
    );
    const freelancerError = freelancerBankDecisionError(
      entryType,
      category,
      isSingleFreelancerServicesFiling(draft),
    );
    if (directionError || businessError || freelancerError)
      return {
        success: false,
        error: directionError || businessError || freelancerError,
      };
    if (!category.trim())
      return { success: false, error: "Category is required" };
    if (isPlaceholderIncomeCategory(category))
      return { success: false, error: PLACEHOLDER_INCOME_ERROR };

    // A gift needs the donor's number: IRIS asks for it in the Gift dialog.
    // Any other decision clears a donor number left over from an earlier one.
    let donorId: string | null = null;
    if (entryType === "INCOME" && isGiftCategory(category)) {
      const donorCheck = validateGiftDonorId(giftDonorId);
      if (!donorCheck.valid) {
        return { success: false, error: donorCheck.error };
      }
      donorId = donorCheck.id;
    }

    await prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.deleteMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          sourceTransactionId: transaction.id,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          filingDraftId: draft.id,
          userId: draft.userId,
          entryDate: transaction.transactionDate,
          entryType,
          category: isBusinessBankCategory(category)
            ? normalizeBankCategory(category)
            : category.trim(),
          description: transaction.description,
          amount: Math.abs(amount),
          source: "BANK_CLASSIFIED",
          sourceDocumentId: transaction.sourceDocumentId,
          sourceTransactionId: transaction.id,
          bankAccountId: transaction.bankAccountId,
        },
      });
      await tx.bankTransaction.update({
        where: { id: transaction.id },
        data: {
          classificationStatus: "APPROVED",
          suggestedEntryType: entryType,
          suggestedCategory: isBusinessBankCategory(category)
            ? normalizeBankCategory(category)
            : category.trim(),
          giftDonorId: donorId,
        },
      });
    });
    await invalidateDerivedFilingState(draft);
    return { success: true };
  } catch (error) {
    console.error("Error manually classifying bank transaction:", error);
    return { success: false, error: "Failed to save manual classification" };
  }
}

export async function reviewBankTransactionClassificationAction(
  draftId: string,
  transactionId: string,
  decision: "APPROVE" | "REJECT" | "TRANSFER" | "CASH_MOVEMENT",
  exclusionReasonInput?: string,
) {
  try {
    const draft = await getOwnedDraft(draftId);
    const transaction = await prisma.bankTransaction.findFirst({
      where: {
        id: transactionId,
        filingDraftId: draft.id,
        userId: draft.userId,
      },
    });

    if (!transaction) {
      return { success: false, error: "Bank transaction not found" };
    }

    const transferCounterparts = await getTransferCounterparts(
      draft,
      transaction,
    );
    const pairedTransferCounterparts = transferCounterparts.filter(
      (counterpart) => counterpart.classificationStatus === "TRANSFER",
    );

    if (
      decision !== "TRANSFER" &&
      transaction.classificationStatus === "TRANSFER" &&
      pairedTransferCounterparts.length > 0
    ) {
      return {
        success: false,
        error:
          "This is a paired internal transfer. Use Undo first; both sides will be reopened together.",
      };
    }

    if (decision === "CASH_MOVEMENT") {
      await prisma.$transaction(async (tx) => {
        await tx.ledgerEntry.deleteMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            sourceTransactionId: transaction.id,
          },
        });
        await tx.bankTransaction.update({
          where: { id: transaction.id },
          data: {
            classificationStatus: "CASH_MOVEMENT",
            suggestedEntryType: null,
            suggestedCategory: "CASH_MOVEMENT",
          },
        });
      });
      await invalidateDerivedFilingState(draft);
      return { success: true, decision };
    }

    if (decision === "TRANSFER") {
      if (transferCounterparts.length === 0) {
        return {
          success: false,
          error:
            "No matching opposite transaction was found in another owned account",
        };
      }
      if (transferCounterparts.length > 1) {
        return {
          success: false,
          error:
            "Multiple possible transfer matches were found; review the account data first",
        };
      }

      const counterpart = transferCounterparts[0];
      const conflictingStatuses = new Set([
        "APPROVED",
        "REJECTED",
        "CASH_MOVEMENT",
      ]);
      if (conflictingStatuses.has(counterpart.classificationStatus)) {
        return {
          success: false,
          error:
            "The matching transfer side has a conflicting decision. Undo that decision first.",
        };
      }

      const transferIds = [transaction.id, counterpart.id];
      await prisma.$transaction(async (tx) => {
        await tx.ledgerEntry.deleteMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            sourceTransactionId: { in: transferIds },
          },
        });

        await tx.bankTransaction.updateMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            id: { in: transferIds },
          },
          data: {
            classificationStatus: "TRANSFER",
            suggestedEntryType: null,
            suggestedCategory: "INTERNAL_TRANSFER",
          },
        });
      });

      await invalidateDerivedFilingState(draft);
      return {
        success: true,
        decision,
        pairedTransactionId: counterpart.id,
      };
    }

    if (decision === "REJECT") {
      const freelancerEnabled = isSingleFreelancerServicesFiling(draft);
      const exclusionReason = normalizeBankExclusionReason(exclusionReasonInput);
      if ((freelancerEnabled || exclusionReasonInput !== undefined) && !exclusionReason) {
        return {
          success: false,
          error: "Enter a short reason for excluding this transaction (at least 3 characters).",
        };
      }
      if (isDeterministicServicesCredit(transaction, draft, transferCounterparts)) {
        return {
          success: false,
          error:
            "This credit clearly matches Freelancer services income. Do not exclude it; review it as Income > Services, or choose another supported category if the bank record is genuinely different.",
        };
      }

      await prisma.$transaction(async (tx) => {
        await tx.ledgerEntry.deleteMany({
          where: {
            filingDraftId: draft.id,
            userId: draft.userId,
            sourceTransactionId: transaction.id,
          },
        });

        await tx.bankTransaction.update({
          where: { id: transaction.id },
          data: freelancerEnabled
            ? {
                classificationStatus: "REJECTED",
                suggestedEntryType: null,
                suggestedCategory: "EXCLUDED",
              }
            : { classificationStatus: "REJECTED" },
        });
        if (exclusionReason) {
          await tx.taxAuditEvent.create({
            data: {
              userId: draft.userId,
              filingDraftId: draft.id,
              eventType: BANK_TRANSACTION_EXCLUDED_EVENT_TYPE,
              eventDataJson: buildBankExclusionEventData(
                transaction.id,
                exclusionReason,
              ),
            },
          });
        }
      });

      await invalidateDerivedFilingState(draft);
      return { success: true, decision };
    }

    if(isMyselfBusinessBankFlow(draft) && hasOwnerCapitalMovementDescription(transaction.description)) return {success:false,error:OWNER_CAPITAL_REVIEW_ERROR};

    if (!transaction.suggestedEntryType || !transaction.suggestedCategory) {
      return {
        success: false,
        error: "This transaction has no suggestion to approve",
      };
    }

    if (isTransferLookalike(transaction, transferCounterparts)) {
      return { success: false, error: TRANSFER_LOOKALIKE_ERROR };
    }

    if (isPlaceholderIncomeCategory(transaction.suggestedCategory)) {
      return { success: false, error: PLACEHOLDER_INCOME_ERROR };
    }

    if (
      transaction.suggestedEntryType === "INCOME" &&
      isGiftCategory(transaction.suggestedCategory) &&
      !validateGiftDonorId(transaction.giftDonorId).valid
    ) {
      return {
        success: false,
        error:
          "A gift needs the donor's CNIC or registration number. Use the pencil icon, choose Income > Gift and enter it.",
      };
    }

    const directionError = bankEntryDirectionError(
      transaction,
      transaction.suggestedEntryType,
    );
    const businessError = businessBankDecisionError(
      transaction.suggestedEntryType,
      transaction.suggestedCategory,
      isMyselfBusinessBankFlow(draft),
    );
    const freelancerError = freelancerBankDecisionError(
      transaction.suggestedEntryType,
      transaction.suggestedCategory,
      isSingleFreelancerServicesFiling(draft),
    );
    if (directionError || businessError || freelancerError)
      return {
        success: false,
        error: directionError || businessError || freelancerError,
      };

    const amount = toMoneyAmount(
      transaction.suggestedEntryType === "INCOME" ||
        transaction.suggestedEntryType === "LIABILITY"
        ? transaction.credit
        : transaction.debit,
    );

    if (amount <= 0) {
      return { success: false, error: "Transaction has no usable amount" };
    }

    await prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.deleteMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          sourceTransactionId: transaction.id,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          filingDraftId: draft.id,
          userId: draft.userId,
          entryDate: transaction.transactionDate,
          entryType: transaction.suggestedEntryType,
          category: transaction.suggestedCategory,
          description: transaction.description,
          amount: Math.abs(amount),
          source: "BANK_CLASSIFIED",
          sourceDocumentId: transaction.sourceDocumentId,
          sourceTransactionId: transaction.id,
          bankAccountId: transaction.bankAccountId,
        },
      });

      await tx.bankTransaction.update({
        where: { id: transaction.id },
        data: { classificationStatus: "APPROVED" },
      });
    });

    await invalidateDerivedFilingState(draft);
    return { success: true, decision };
  } catch (error) {
    console.error("Error reviewing bank classification:", error);
    return { success: false, error: "Failed to review bank classification" };
  }
}
