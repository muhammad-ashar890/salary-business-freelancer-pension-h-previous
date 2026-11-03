import {
  bankTransactionDirection,
  hasOwnerCapitalMovementDescription,
  ownerCapitalReviewSuggestion,
  unreviewedBankSuggestion,
  type BankDirection,
} from "./business-bank-categories";
import { toMoneyAmount } from "@/lib/money";

/**
 * Category carried by an unexplained credit. It is a question, not an answer:
 * it has no IRIS row and would be counted as taxable income, so a transaction
 * can never be approved under it. The user must say what the credit is.
 */
export const PLACEHOLDER_INCOME_CATEGORY = "POTENTIAL_INCOME";

export function isPlaceholderIncomeCategory(
  category: string | null | undefined,
) {
  return (
    String(category ?? "")
      .trim()
      .toUpperCase() === PLACEHOLDER_INCOME_CATEGORY
  );
}

export const PLACEHOLDER_INCOME_ERROR =
  "This credit has not been explained yet. Use the pencil icon and choose what it is (for example Salary, Gift, or Other income), or mark it Internal transfer, Cash movement, or Exclude.";
import {
  bankDescriptionMatchesKeyword as matchesKeyword,
  findLikelyInternalTransferPairs,
  hasInternalTransferLanguage as hasTransferLanguage,
  normalizeBankDescription as normalizeDescription,
  type TransferCandidate,
} from "@/lib/tax/bank-transfer-matching";

/** Words that mark an incoming credit as a gift (whole words, see the matcher). */
export const GIFT_KEYWORDS = ["gift", "gifted", "hiba", "hibah"] as const;

/** Credits that reverse or return an earlier payment are not new earnings. */
export const REFUND_REVERSAL_KEYWORDS = [
  "refund",
  "refunded",
  "reversal",
  "reversed",
  "chargeback",
  "returned payment",
  "payment returned",
] as const;

/** Strong narration signals for service receipts, used only for Freelancer filings. */
export const FREELANCER_SERVICE_RECEIPT_KEYWORDS = [
  "freelance payout",
  "freelancer payout",
  "freelance export payout",
  "freelance payment",
  "freelance invoice",
  "freelance export proceeds",
  "freelance services",
  "client service payment",
  "client services payment",
  "client service receipt",
  "service invoice payment",
  "services invoice payment",
  "export of services",
  "upwork payout",
  "upwork payment",
  "fiverr payout",
  "fiverr payment",
  "freelancer.com payout",
  "toptal payout",
  "peopleperhour payout",
] as const;

/** Expense narrations that are plausible freelancer costs, never auto-approved. */
export const FREELANCER_EXPENSE_KEYWORDS = [
  "platform service fee",
  "freelance platform fee",
  "platform fee",
  "payment processor fee",
  "upwork fee",
  "fiverr fee",
  "software subscription",
  "domain registration",
  "web hosting",
  "cloud hosting",
] as const;

/**
 * A business account's own narration often says what a row is. These lists let
 * the rule engine suggest the business head without the reviewer choosing it,
 * and they are consulted only when the filing is a business filing, so no other
 * income source changes behaviour.
 *
 * Reported 27-Oct-2026 on the operator's own HBL statement: four "Standing
 * instruction — shop rent" debits were suggested as UTILITIES_OR_RENT (a
 * personal Wealth row, code 7051) and five customer credits as "cash movement"
 * or "internal transfer", which hid PKR 6,000,000 of sales and put one quarter's
 * shop rent on the personal side of the Wealth Statement.
 */
export const BUSINESS_SALES_NARRATION_KEYWORDS = [
  "sales proceeds",
  "sale proceeds",
  "cash sale",
  "cash sales",
  "sales deposit",
  "sale deposit",
  "sales receipt",
  "sales collection",
  "daily sales",
  "till deposit",
  "counter sales",
  "customer sales receipt",
  "business sales",
] as const;

/** A named commercial counterparty on a credit into the business account. */
export const BUSINESS_CUSTOMER_NARRATION_KEYWORDS = [
  "m/s",
  "customer",
  "client",
  "traders",
  "trader",
  "enterprises",
  "enterprise",
  "industries",
  "distributors",
  "distributor",
  "suppliers",
  "supplier",
  "wholesale",
  "trading co",
  "pvt ltd",
  "private limited",
] as const;

/** Heads a credit may name without being a business sale, plus own-account wording. */
export const NON_SALES_CREDIT_KEYWORDS = [
  "salary",
  "payroll",
  "pension",
  "gift",
  "profit",
  "interest",
  "refund",
  "reversal",
  "loan",
  "dividend",
  "rent received",
  "zakat",
  "self",
  "own account",
  "own a/c",
] as const;

export const BUSINESS_PREMISES_RENT_KEYWORDS = [
  "shop rent",
  "office rent",
  "warehouse rent",
  "factory rent",
  "premises rent",
  "rent for shop",
  "rent for office",
  "business premises",
] as const;

export const BUSINESS_STOCK_PURCHASE_KEYWORDS = [
  "stock purchase",
  "stock purchases",
  "purchase of stock",
  "goods purchase",
  "inventory purchase",
  "supplier bill",
  "purchase for resale",
] as const;

export const BUSINESS_PAYROLL_KEYWORDS = [
  "salary transfer",
  "salaries transfer",
  "staff salary",
  "wages",
  "payroll",
] as const;

/**
 * Business head read straight from the narration. A suggestion only: the
 * reviewer still approves it, and a refund, gift, own-capital movement or a
 * matched internal transfer has already been decided before this runs.
 */
export function businessNarrationSuggestion(
  description: string,
  direction: BankDirection,
): {
  status: string;
  entryType: string;
  category: string;
  confidence: number;
} | null {
  const normalized = normalizeDescription(description);
  const has = (list: readonly string[]) =>
    list.some((keyword) => matchesKeyword(normalized, keyword));

  if (direction === "debit") {
    if (has(BUSINESS_PREMISES_RENT_KEYWORDS))
      return { status: "SUGGESTED", entryType: "EXPENSE", category: "BUSINESS_OPERATING_EXPENSE", confidence: 0.9 };
    if (has(BUSINESS_STOCK_PURCHASE_KEYWORDS))
      return { status: "SUGGESTED", entryType: "EXPENSE", category: "BUSINESS_COST_OF_SALES", confidence: 0.85 };
    if (has(BUSINESS_PAYROLL_KEYWORDS))
      return { status: "SUGGESTED", entryType: "EXPENSE", category: "BUSINESS_OPERATING_EXPENSE", confidence: 0.8 };
    return null;
  }
  if (direction !== "credit") return null;

  // A credit that names salary, pension, gift, profit, a refund or the
  // taxpayer's own account is not a sale, whatever else it says.
  if (has(NON_SALES_CREDIT_KEYWORDS)) return null;

  const salesWording = has(BUSINESS_SALES_NARRATION_KEYWORDS);
  const customerNamed = has(BUSINESS_CUSTOMER_NARRATION_KEYWORDS);
  // "Transfer from business sales account" is account-to-account wording and
  // stays an internal transfer. A named commercial counterparty is what turns
  // bank jargon such as "IBFT" into a customer receipt.
  if (hasTransferLanguage(description) && !customerNamed) return null;

  if (salesWording)
    return { status: "SUGGESTED", entryType: "INCOME", category: "BUSINESS_SALES", confidence: 0.9 };
  if (customerNamed)
    return { status: "SUGGESTED", entryType: "INCOME", category: "BUSINESS_SALES", confidence: 0.75 };
  return null;
}

export function isRefundOrReversalDescription(description: string) {
  const normalized = normalizeDescription(description);
  return REFUND_REVERSAL_KEYWORDS.some((keyword) =>
    matchesKeyword(normalized, keyword),
  );
}

export const CLASSIFICATION_RULES = [
  {
    // Property tax (& rates) is a provincial levy, NOT federal income tax
    // withheld at source: it is an expense (IRIS wealth 7087) and must never
    // become a TAX_PAYMENT, which the withholding total counts as tax
    // already deducted. This rule sits first so the generic "tax" rule
    // below cannot capture it.
    keywords: ["property tax"],
    entryType: "EXPENSE",
    category: "OTHER_EXPENSE",
    confidence: 0.9,
  },
  {
    keywords: ["tax", "withholding", "fbr", "fed", "federal excise"],
    entryType: "EXPENSE",
    category: "TAX_PAYMENT",
    confidence: 0.9,
  },
  {
    keywords: [
      "bank profit",
      "profit credited",
      "profit payment",
      "profit on savings deposit",
      "profit on deposit",
      "savings profit",
      "savings account profit",
      "interest credited",
      "interest income",
      "deposit profit",
      "profit on debt",
      "markup",
    ],
    entryType: "INCOME",
    category: "BANK_PROFIT",
    confidence: 0.88,
  },
  {
    keywords: [
      "bank charge",
      "bank charges",
      "bank fee",
      "bank fees",
      "service charge",
      "annual fee",
      "account maintenance",
      "maintenance fee",
    ],
    entryType: "EXPENSE",
    category: "BANK_CHARGES",
    confidence: 0.92,
  },
  {
    keywords: ["rent received", "rental income", "rent credited"],
    entryType: "INCOME",
    category: "PROPERTY_RENT",
    confidence: 0.92,
  },
  {
    keywords: [
      "rent",
      "k-electric",
      "k electric",
      "electricity",
      "gas bill",
      "utility",
      " ke ",
    ],
    entryType: "EXPENSE",
    category: "UTILITIES_OR_RENT",
    confidence: 0.9,
  },
  {
    keywords: ["fuel", "petrol", "pso", "psos", "shell", "total"],
    entryType: "EXPENSE",
    category: "TRANSPORT",
    confidence: 0.88,
  },
  {
    keywords: ["salary", "payroll", "wages", "compensation"],
    entryType: "INCOME",
    category: "SALARY",
    confidence: 0.95,
  },
  {
    // Pension credits (AG/PPO/HBL PPS treasury disbursements) are as
    // recognisable as payroll, so they get the same SUGGESTED treatment as
    // salary: the chip says what it is and Approve All Safe can confirm it,
    // exactly like the salary rule above. Generic credits still fall through
    // to the POTENTIAL_INCOME placeholder — nothing else changes.
    keywords: ["pension"],
    entryType: "INCOME",
    category: "PENSION",
    confidence: 0.95,
  },
  {
    keywords: [
      "grocery",
      "groceries",
      "mart",
      "superstore",
      "restaurant",
      "food",
    ],
    entryType: "EXPENSE",
    category: "PERSONAL_EXPENSE",
    confidence: 0.8,
  },
  // Household, education and medical debits are personal spending in every
  // income source, and they used to stay "Unreviewed", forcing the reviewer to
  // type what the narration already said.
  {
    keywords: [
      "household",
      "family transfer",
      "home expenses",
      "house expenses",
      "domestic expenses",
    ],
    entryType: "EXPENSE",
    category: "PERSONAL_EXPENSE",
    confidence: 0.8,
  },
  {
    keywords: [
      "school fee",
      "tuition fee",
      "education fee",
      "college fee",
      "university fee",
      "fee transfer",
    ],
    entryType: "EXPENSE",
    category: "PERSONAL_EXPENSE",
    confidence: 0.82,
  },
  {
    keywords: [
      "medical",
      "hospital",
      "clinic",
      "doctor",
      "pharmacy",
      "treatment",
    ],
    entryType: "EXPENSE",
    category: "PERSONAL_EXPENSE",
    confidence: 0.82,
  },
] as const;

export function classifyDescription(
  description: string,
  direction?: BankDirection,
) {
  const normalized = normalizeDescription(description);

  // Cash deposits/withdrawals are movements, not automatically income or
  // expenses. Surface them for an explicit cash decision before merchant or
  // payroll keywords can override that safer interpretation.
  if (
    normalized.includes("cash withdrawal") ||
    normalized.includes("cash deposit") ||
    normalized.includes("atm withdrawal") ||
    normalized.includes("atm cash") ||
    normalized.includes("visa atm") ||
    normalized.includes("counter cash")
  ) {
    return {
      status: "POTENTIAL_CASH_MOVEMENT",
      entryType: null,
      category: "CASH_MOVEMENT",
      confidence: 0.85,
    };
  }

  // Transfer language must win over words such as "salary" in an account
  // label. "Transfer from HBL Salary Account" is a reviewable transfer, not
  // earned salary merely because the source account contains that word.
  if (hasTransferLanguage(description)) {
    return {
      status: "POTENTIAL_TRANSFER",
      entryType: null,
      category: "INTERNAL_TRANSFER",
      confidence: 0.8,
    };
  }

  const rule = CLASSIFICATION_RULES.find(
    (candidate) =>
      (!direction ||
        (direction === "credit"
          ? candidate.entryType === "INCOME"
          : direction === "debit"
            ? candidate.entryType === "EXPENSE"
            : false)) &&
      candidate.keywords.some((keyword) => matchesKeyword(normalized, keyword)),
  );

  if (!rule) {
    return {
      status: "UNREVIEWED",
      entryType: null,
      category: null,
      confidence: 0,
    };
  }

  return {
    status: "SUGGESTED",
    entryType: rule.entryType,
    category: rule.category,
    confidence: rule.confidence,
  };
}

function hasLikelyInternalTransferPair(
  transaction: TransferCandidate,
  candidates: TransferCandidate[],
) {
  return findLikelyInternalTransferPairs(transaction, candidates).length > 0;
}

export function classifyTransaction(
  transaction: TransferCandidate,
  transferCandidates: TransferCandidate[],
  options?: {
    businessEnabled?: boolean;
    businessAccountConfirmed?: boolean;
    freelancerEnabled?: boolean;
  },
) {
  const direction = bankTransactionDirection(transaction);
  if (direction === "invalid") return unreviewedBankSuggestion();
  const normalized = normalizeDescription(transaction.description);

  if (hasLikelyInternalTransferPair(transaction, transferCandidates)) {
    return {
      status: "POTENTIAL_TRANSFER",
      entryType: null,
      category: "INTERNAL_TRANSFER",
      confidence: 0.98,
    };
  }

  // Only an actual matching owned-account pair above can establish transfer evidence.
  // Otherwise explicit owner capital/drawings stay manual before any positive keyword/AI path.
  if (options?.businessEnabled && hasOwnerCapitalMovementDescription(transaction.description)) return ownerCapitalReviewSuggestion();

  // A refund/reversal changes an earlier transaction; it is not new earnings.
  // Keep it unresolved until it can be linked to the original payment.
  if (isRefundOrReversalDescription(transaction.description)) {
    return unreviewedBankSuggestion();
  }

  // A credit that says it is a gift is suggested as a gift received: an
  // inflow of the Wealth Statement, not taxable income. It is only a
  // suggestion; the taxpayer approves it (or picks another category).
  if (
    toMoneyAmount(transaction.credit) > 0 &&
    toMoneyAmount(transaction.debit) === 0 &&
    GIFT_KEYWORDS.some((keyword) => matchesKeyword(normalized, keyword))
  ) {
    return {
      status: "SUGGESTED",
      entryType: "INCOME",
      category: "GIFT",
      confidence: 0.75,
    };
  }

  // The narration itself can name the business head ("shop rent", "sales
  // proceeds", a named customer). This is checked before the generic
  // cash-movement and transfer wording, which otherwise swallowed both, but
  // after a matched owned-account pair, a gift, a refund and owner capital.
  if (options?.businessEnabled) {
    const businessNarration = businessNarrationSuggestion(
      transaction.description,
      direction,
    );
    if (businessNarration) return businessNarration;
  }

  // Movement/transfer wording has priority; selecting business never makes
  // every bank row a business transaction.
  const movementSuggestion = classifyDescription(
    transaction.description,
    direction,
  );
  if (
    ["POTENTIAL_TRANSFER", "POTENTIAL_CASH_MOVEMENT"].includes(
      movementSuggestion.status,
    )
  )
    return movementSuggestion;

  // Platform and work-tool charges can be freelancer costs, but remain
  // review-only because business use and deductibility need supporting proof.
  if (
    options?.freelancerEnabled &&
    direction === "debit" &&
    FREELANCER_EXPENSE_KEYWORDS.some((keyword) =>
      matchesKeyword(normalized, keyword),
    )
  ) {
    return {
      status: "SUGGESTED",
      entryType: "EXPENSE",
      category: "OTHER_EXPENSE",
      confidence: 0.78,
    };
  }

  // Strongly worded freelance/service receipts map to the existing SERVICES
  // tax category only on the exact single-Services route. Keep them as
  // suggestions, not automatic ledger approvals.
  if (
    options?.freelancerEnabled &&
    direction === "credit" &&
    FREELANCER_SERVICE_RECEIPT_KEYWORDS.some((keyword) =>
      matchesKeyword(normalized, keyword),
    )
  ) {
    return {
      status: "SUGGESTED",
      entryType: "INCOME",
      category: "SERVICES",
      confidence: 0.9,
    };
  }

  if (options?.businessEnabled) {
    const businessRules = [
      {
        direction: "credit",
        category: "BUSINESS_SALES",
        keywords: [
          "customer sales receipt",
          "business sales",
          "business sales receipt",
          "business service fee collected",
          ...(options.businessAccountConfirmed ? ["service fee collected", "service fees collected", "client fees received"] : []),
        ],
      },
      {
        direction: "credit",
        category: "BUSINESS_OTHER_RECEIPTS",
        keywords: [
          "other business receipt",
          "business other receipt",
          "business scrap sale",
        ],
      },
      {
        direction: "debit",
        category: "BUSINESS_COST_OF_SALES",
        keywords: [
          "cost of sales",
          "business purchase",
          "business direct cost",
          "purchase for resale",
        ],
      },
      {
        direction: "debit",
        category: "BUSINESS_OPERATING_EXPENSE",
        keywords: [
          "business operating expense",
          "business operating cost",
          "business running cost",
          "business expense",
          "business rent",
          "business utilities",
          "business communication",
          "business marketing",
          "business transport",
          ...(options.businessAccountConfirmed ? ["administrative salaries", "bank charges", "bank fees"] : []),
        ],
      },
    ];
    const businessRule = businessRules.find(
      (rule) =>
        rule.direction === direction &&
        rule.keywords.some((keyword) => matchesKeyword(normalized, keyword)),
    );
    if (businessRule) {
      // Conflicting asset/loan language needs a manual decision, not a guessed
      // operating expense or revenue classification.
      if (
        [
          "equipment purchase",
          "machinery purchase",
          "vehicle purchase",
          "property purchase",
          "loan proceeds",
          "loan disbursement",
          "refund",
          "reversal",
          "reversed",
          "chargeback",
        ].some((keyword) => matchesKeyword(normalized, keyword))
      )
        return unreviewedBankSuggestion();
      return {
        status: "SUGGESTED",
        entryType: direction === "credit" ? "INCOME" : "EXPENSE",
        category: businessRule.category,
        confidence: 0.9,
      };
    }
  }
  const descriptionSuggestion = movementSuggestion;

  if (descriptionSuggestion.status !== "UNREVIEWED") {
    return descriptionSuggestion;
  }

  // Both sides are converted before being compared. `Decimal(0)` is truthy,
  // so the previous `!(transaction.debit ?? 0)` form evaluated to false on a
  // zero Decimal and left every transaction unclassified in both directions.
  const debitAmount = toMoneyAmount(transaction.debit);
  const creditAmount = toMoneyAmount(transaction.credit);

  const hasCredit = creditAmount > 0 && debitAmount === 0;
  const hasDebit = debitAmount > 0 && creditAmount === 0;

  if (
    hasCredit &&
    [
      "loan",
      "financing",
      "credit facility",
      "loan proceeds",
      "loan disbursement",
    ].some((keyword) => matchesKeyword(normalized, keyword))
  ) {
    return {
      status: "POTENTIAL_LIABILITY",
      entryType: "LIABILITY",
      category: "LOAN_PROCEEDS",
      confidence: 0.7,
    };
  }

  if (
    hasDebit &&
    [
      "car purchase",
      "vehicle purchase",
      "property purchase",
      "land purchase",
      "equipment purchase",
      "laptop purchase",
      "machinery purchase",
    ].some((keyword) => matchesKeyword(normalized, keyword))
  ) {
    return {
      status: "POTENTIAL_ASSET",
      entryType: "ASSET",
      category: "ASSET_PURCHASE",
      confidence: 0.7,
    };
  }

  // A generic incoming credit is not automatically taxable income. Surface it
  // as a potential-income decision so the user can choose income, internal
  // transfer, or exclusion explicitly.
  if (hasCredit) {
    return {
      status: "POTENTIAL_INCOME",
      entryType: "INCOME",
      category: PLACEHOLDER_INCOME_CATEGORY,
      confidence: 0.55,
    };
  }

  return descriptionSuggestion;
}
