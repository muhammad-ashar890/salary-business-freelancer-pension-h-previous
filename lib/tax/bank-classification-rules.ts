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

/**
 * Revenue heads a business account's own narration states outright. They are
 * deliberately not inferred from customer wording: 11-Nov-2026, four
 * "other business receipt" lines on the F+B test run were called sales because
 * the counterparty name contained "Traders".
 */
export const BUSINESS_OTHER_RECEIPT_KEYWORDS = [
  "other business receipt",
  "business other receipt",
  "business scrap sale",
] as const;

/**
 * A credit that says it is a service fee is a services receipt. It is listed
 * separately from NON_SALES_CREDIT_KEYWORDS because the answer depends on the
 * account: the same phrase on the declared business account is still read by the
 * explicit businessRules, and only a personal or undeclared account treats it as
 * freelance income. The matcher tolerates a trailing plural, so "services fee"
 * covers "services fees" too.
 */
export const SERVICE_FEE_CREDIT_KEYWORDS = [
  "services fee",
  "service fee",
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
 * Recurring costs a business account pays in its own name. The narration of a
 * real bank line says "ELECTRICITY BILL PAYMENT", not "business utilities", and
 * without this list the debit falls to the household rules in CLASSIFICATION_RULES
 * (UTILITIES_OR_RENT, TRANSPORT) — personal Wealth rows 7051/7055/7058/7061 that the
 * reconciliation then treats as spending the taxpayer has to explain, while 3199
 * loses the deduction. Reported 11-Nov-2026 on six rows of the operator's own F+B
 * test run. Consulted only for a debit on an account explicitly confirmed as a
 * business account, so a personal or mixed account keeps its household row.
 */
export const BUSINESS_RUNNING_COST_KEYWORDS = [
  "electricity",
  "gas bill",
  "water bill",
  "utility",
  "utilities",
  "internet",
  "broadband",
  "telephone",
  "phone bill",
  "mobile bill",
  "fuel",
  "petrol",
  "diesel",
  "vehicle maintenance",
  "rent",
] as const;

/**
 * Business head read straight from the narration. A suggestion only: the
 * reviewer still approves it, and a refund, gift, own-capital movement or a
 * matched internal transfer has already been decided before this runs.
 */
export function businessNarrationSuggestion(
  description: string,
  direction: BankDirection,
  options?: { accountConfirmedBusiness?: boolean },
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

  // A credit that names its own revenue head is not a sale, however many customer
  // words are written around it. "OTHER BUSINESS RECEIPT OBR-01 TECHNICAL
  // PROFESSIONAL FEE INVOICE ACME TRADERS" is the other-revenue head; the
  // named-counterparty inference below read it as business sales and moved
  // 8,000,000 from IRIS 3101 (other income) into 3009 (gross revenue), which
  // both broke the Books tie-out and removed the figure the fold is tested on.
  // Returning null hands the row to the explicit-head rules, which do know it.
  if (has(BUSINESS_OTHER_RECEIPT_KEYWORDS)) return null;

  // "CREDIT Meridian Textiles (Pvt) Ltd INV-2026-101 SERVICES FEE" names a client and
  // a service fee. The client half is what used to decide it: "(Pvt) Ltd" is a
  // named-counterparty keyword, so the row was returned as BUSINESS_SALES at 0.75 and
  // the function exited before the SERVICES rule, and before the matched invoice in the
  // evidence documents, were ever consulted. On the account that the Business Profile
  // declared, that reading stands (businessRules below re-derive it explicitly). On any
  // other account a services fee is a services receipt - say so and let the services
  // rules answer for it. 11-Nov-2026: this moved 370,000 of the taxpayer's own freelance
  // income into Gross Revenue and left 1 of 4 invoices to fold into 3101.
  //
  // An explicit sales phrase in the same narration still decides the row (the 0.9
  // branch below this guard is untouched) - only the named-counterparty inference
  // needs the account to be the business one.
  if (
    !options?.accountConfirmedBusiness &&
    has(SERVICE_FEE_CREDIT_KEYWORDS) &&
    !has(BUSINESS_SALES_NARRATION_KEYWORDS)
  )
    return null;

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
      // The import path already resolves this per row from the account the statement
      // was imported into (app/actions/bank-classification.ts:625).
      { accountConfirmedBusiness: options?.businessAccountConfirmed === true },
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

  // A services fee that landed on an account the Business Profile did not declare is
  // freelance income on this filing. 0.85, so an explicit sales phrase in the same
  // narration still wins: businessNarrationSuggestion above only lets this far through,
  // and a declared business account never reaches it (the business rules below keep
  // their reading there). This is a suggestion - the reviewer still ticks it.
  if (
    options?.freelancerEnabled &&
    !options?.businessAccountConfirmed &&
    direction === "credit" &&
    SERVICE_FEE_CREDIT_KEYWORDS.some((keyword) =>
      matchesKeyword(normalized, keyword),
    )
  ) {
    return {
      status: "SUGGESTED",
      entryType: "INCOME",
      category: "SERVICES",
      confidence: 0.85,
    };
  }

  // Strongly worded freelance/service receipts map to the existing SERVICES
  // tax category only on the exact Services-only, Salary+Services or Pension+Services route. Keep them as
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
  // A confirmed business account's recurring bills are business running costs,
  // not household spending. Placed after the explicit-head rules above (a line that
  // already names cost of sales or an operating expense stays on that stronger
  // suggestion) and before the household buckets in CLASSIFICATION_RULES, which are
  // what produced 7051/7055/7058 wealth rows out of electricity, phone and fuel on
  // a business account. Gated on the same explicit account confirmation the import
  // path uses (app/actions/bank-classification.ts:625) — selecting business income
  // is deliberately not enough, so a personal or mixed account is untouched.
  if (
    options?.businessEnabled &&
    options?.businessAccountConfirmed &&
    direction === "debit" &&
    BUSINESS_RUNNING_COST_KEYWORDS.some((keyword) =>
      matchesKeyword(normalized, keyword),
    )
  ) {
    return {
      status: "SUGGESTED",
      entryType: "EXPENSE",
      category: "BUSINESS_OPERATING_EXPENSE",
      confidence: 0.8,
    };
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
