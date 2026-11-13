"use server";

// File: app/actions/tax-calculation.ts
import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { calculateTaxEstimate } from "@/lib/tax/tax-calculation";
import {
  computeBusinessProfit,
  hasBusinessSalesFigure,
} from "@/lib/tax/business-profit";
import { validateDepreciationSchedule } from "@/lib/tax/business-depreciation-schedule";
import {
  DEFAULT_MINIMUM_TAX_CATEGORY,
  SECTION_113_TEXT,
  getMinimumTaxCategory,
  section113Applicability,
} from "@/lib/tax/minimum-tax-113";
import type {
  TaxCalculationResult,
  TaxIncomeSource,
} from "@/lib/tax/tax-calculation";
import {
  TY2026_RULE_SET_VERSION,
  parseManualTaxpayerListStatus,
} from "@/lib/tax/tax-data-model";
import type { TaxpayerListStatus } from "@/lib/tax/tax-data-model";
import { assessPensionerAge } from "@/lib/tax/taxpayer-age";
import { isTaxActivitySource } from "@/lib/tax/filing-drafts";
import { getTy2026RateCardRule, TY2026_PENSION_RULES } from "@/lib/tax/rules/ty2026";
import {
  TY2026_BUSINESS_PROFIT_SUBCATEGORY,
  TY2026_PENSION_FORMER_EMPLOYER_SUBCATEGORY,
  getTy2026SubcategoryDetailFields,
  parsePersistedSelectionUserDetails,
  resolvePensionFormerEmployerAnswer,
} from "@/lib/tax/rules/ty2026/subcategories";
import { resolveApprovedPensionSource, type PensionSource } from "@/lib/tax/pension-source";
import { cancelActivePensionJobs } from "@/lib/tax/pension-invalidation";
import { pensionProfileErrors, readPensionStatementFacts } from "@/lib/tax/pension-statement-fields";
import type { Ty2026SelectionUserDetails } from "@/lib/tax/rules/ty2026/subcategories";
import { validateAuthoritativeReconciliation } from "@/lib/tax/reconciliation-calculation";
import {
  extractMappedSalaryGross,
  extractMappedSalaryWithholding,
  normalizeLedgerCategory,
  resolveTaxWithheld,
} from "@/lib/tax/withholding-sources";
import {
  BUSINESS_BANK_INCOME_CATEGORIES,
  isBusinessBankCategory,
  isMyselfBusinessBankFlow,
  isSingleFreelancerServicesFiling,
} from "@/lib/tax/business-bank-categories";
import { isGiftCategory } from "@/lib/tax/gift-income";
import { resolveSalaryTaxableIncome } from "@/lib/tax/salary-certificate-fields";
import { createNotification } from "@/app/actions/notifications";
import { sumMoney, toMoneyAmount } from "@/lib/money";
import {
  SERVICES_LEDGER_CATEGORY_ALIASES,
  isServicesLedgerCategory,
} from "@/lib/tax/services-income-allocation";
import { evaluateServicesIncomeEvidence } from "@/lib/tax/services-income-evidence";
import { SERVICES_WITHHOLDING_DOCUMENT_TYPES } from "@/lib/tax/services-withholding-evidence";

async function getOwnedDraft(draftId: string) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;

  if (!email) throw new Error("Unauthorized");

  const user = await prisma.user.findUnique({
    where: { email },
    // Date of birth drives the Section 149(IA) pension age condition. It is
    // populated from the taxpayer profile or from an approved CNIC upload.
    select: { id: true, dateOfBirth: true, cnic: true },
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
      salaryPercentage: true,
      taxWithheld: true,
      incomeSelections: {
        where: { status: "SELECTED" },
        select: { source: true, subcategory: true, detailsJson: true },
      },
    },
  });

  if (!draft) throw new Error("Filing draft not found");

  return { ...draft, taxpayerDateOfBirth: user.dateOfBirth, taxpayerCnic: user.cnic };
}

export async function calculateTaxAction(
  draftId: string,
  requestedFilerStatus: TaxpayerListStatus | string,
) {
  try {
    const filerStatus = parseManualTaxpayerListStatus(requestedFilerStatus);
    if (!filerStatus) {
      return {
        success: false,
        error: "Answer the Filer status step (Filer / Late Filer / Non-Filer) before calculating tax",
      };
    }

    const draft = await getOwnedDraft(draftId);
    const reconciliation = await validateAuthoritativeReconciliation({
      draftId: draft.id,
      userId: draft.userId,
    });
    if ("blockers" in reconciliation) {
      return {
        success: false,
        error: reconciliation.blockers.join(" · "),
      };
    }

    const entries = await prisma.ledgerEntry.findMany({
      where: {
        filingDraftId: draft.id,
        userId: draft.userId,
      },
      select: {
        id: true,
        entryType: true,
        category: true,
        entryDate: true,
        amount: true,
        // Needed to name the suspect rows when salary withholding appears to
        // have been counted twice; see resolveTaxWithheld below.
        description: true,
      },
    });

    // These feed the tax engine, so they are summed in Decimal: `+` on a
    // Decimal column concatenates, and converting first reintroduces the
    // floating-point residue the migration exists to remove.
    // A gift received is a Wealth Statement inflow, not income: it is in the
    // ledger so Mizan balances, and it never reaches a tax figure.
    const totalIncome = sumMoney(
      entries
        .filter(
          (entry) =>
            entry.entryType === "INCOME" && !isGiftCategory(entry.category),
        )
        .map((entry) => entry.amount),
    );
    const totalExpenses = sumMoney(
      entries
        .filter((entry) => entry.entryType === "EXPENSE")
        .map((entry) => entry.amount),
    );
    const normalizeCategory = normalizeLedgerCategory;

    const incomeByCategory = (...categories: readonly string[]) =>
      sumMoney(
        entries
          .filter(
            (entry) =>
              entry.entryType === "INCOME" &&
              categories.includes(normalizeCategory(entry.category)),
          )
          .map((entry) => entry.amount),
      );

    const bankProfitIncome = incomeByCategory("BANK_PROFIT");
    const pensionIncome = incomeByCategory("PENSION");
    const rentalIncome = incomeByCategory("RENT", "RENTAL", "PROPERTY_RENT");
    // Each separately routed category must be recognised here. Anything not
    // listed falls into the salary remainder below, which would tax it under
    // Section 149 slabs instead of its own flat rate.
    const servicesLedgerIncome = incomeByCategory(
      ...SERVICES_LEDGER_CATEGORY_ALIASES,
    );
    const otherIncomeAmount = incomeByCategory(
      "OTHER_INCOME",
      "PRIZE",
      "PRIZE_MONEY",
      "WINNINGS",
      "COMMISSION",
      "BROKERAGE",
    );
    const capitalGainsIncome = incomeByCategory(
      "CAPITAL_GAINS",
      "CAPITAL_GAIN",
    );
    const dividendIncome = incomeByCategory("DIVIDEND", "DIVIDENDS");
    const nonResidentIncome = incomeByCategory(
      "NON_RESIDENT",
      "NON_RESIDENT_PAYMENT",
      "FOREIGN_INCOME_ASSETS",
      "FOREIGN_INCOME",
      "FOREIGN_ASSETS",
    );
    if (
      entries.some((entry) => isBusinessBankCategory(entry.category)) &&
      !isMyselfBusinessBankFlow(draft)
    ) {
      return {
        success: false,
        error:
          "Business bank records require the supported Myself / Business Income / TY2026 setup; review their classification before calculating.",
      };
    }
    const businessIncome = incomeByCategory(
      ...BUSINESS_BANK_INCOME_CATEGORIES,
      "BUSINESS",
      "BUSINESS_INCOME",
      "SUPPLY",
      "SUPPLIES",
      "CONTRACT",
      "CONTRACTS",
      "ECOMMERCE",
      "E_COMMERCE",
      "EXPORT",
      "EXPORTS",
      "TRADING",
    );
    // Salary is whatever ordinary income remains once the separately routed
    // categories are removed, so an uncategorised income entry is still taxed
    // rather than silently dropped from the return.
    const salaryIncomeFromLedger = Math.max(
      0,
      totalIncome -
        bankProfitIncome -
        pensionIncome -
        rentalIncome -
        servicesLedgerIncome -
        otherIncomeAmount -
        capitalGainsIncome -
        businessIncome -
        dividendIncome -
        nonResidentIncome,
    );
    const bankSalaryIncome = incomeByCategory(
      "SALARY",
      "SALARIES",
      "SALARY_INCOME",
      "PAY_WAGES",
      "WAGES",
    );

    let incomeSources: string[] = [];
    try {
      const parsedIncomeSources = JSON.parse(draft.incomeSources);
      incomeSources = Array.isArray(parsedIncomeSources)
        ? parsedIncomeSources.map(String)
        : [];
    } catch {
      return {
        success: false,
        error: "Filing income sources are invalid; please review setup",
      };
    }

    if (servicesLedgerIncome > 0 && !incomeSources.includes("services")) {
      return {
        success: false,
        error:
          "Freelancer Services ledger receipts require Freelancer to be selected as an income source. Review those entries or update the filing setup before calculating.",
      };
    }

    // Phase 2 persists the exact PDF subcategory. Keep the pilot calculator
    // limited to the specific routes it actually implements; selecting a
    // different or additional subcategory must return NEEDS_RULES rather than
    // silently applying a bank-deposit/rental/salary formula to the wrong row.
    const selectedSubcategories = new Map<string, Set<string>>();
    const selectionDetails = new Map<string, Ty2026SelectionUserDetails>();
    for (const selection of draft.incomeSelections) {
      const sourceSelections =
        selectedSubcategories.get(selection.source) ?? new Set<string>();
      sourceSelections.add(selection.subcategory);
      selectedSubcategories.set(selection.source, sourceSelections);
      const details = parsePersistedSelectionUserDetails(selection.detailsJson);
      if (details) {
        selectionDetails.set(
          `${selection.source}\u0000${selection.subcategory}`,
          details,
        );
      }
    }
    const freelancerEnabled = isSingleFreelancerServicesFiling(draft);
    const selectedServicesSubcategories = Array.from(
      selectedSubcategories.get("services") ?? new Set<string>(),
    );
    const serviceLedgerCredits = entries
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
    const servicesInvoiceEvidence = freelancerEnabled
      ? await prisma.servicesInvoiceEvidence.findMany({
          where: { filingDraftId: draft.id, userId: draft.userId },
          include: {
            paymentMatches: {
              include: {
                withholdingEvidenceDocument: {
                  select: { documentType: true, extractionStatus: true },
                },
              },
            },
            sourceDocument: { select: { extractionStatus: true } },
          },
          orderBy: [{ invoiceDate: "asc" }, { invoiceKey: "asc" }],
        })
      : [];
    const servicesEvidenceResult = freelancerEnabled
      ? evaluateServicesIncomeEvidence({
          taxYear: draft.taxYear,
          accountingMethod: draft.servicesAccountingMethod,
          selectedSubcategories: selectedServicesSubcategories,
          invoices: servicesInvoiceEvidence,
          ledgerCredits: serviceLedgerCredits,
        })
      : null;
    const invoiceSourceMapProblem =
      freelancerEnabled &&
      servicesInvoiceEvidence.some(
        (invoice) => invoice.sourceDocument.extractionStatus !== "MAPPED",
      )
        ? "A Services invoice document has changed since it was mapped. Review and approve its current invoice fields before calculating."
        : null;
    const servicesRouteProblem = incomeSources.includes("services") && !freelancerEnabled
      ? "Freelancer / Services evidence supports only TY2026 Myself filings with Services alone, exactly Salary + Services, exactly Pension + Services, exactly Business + Services, or exactly Salary + Business + Services, or exactly Salary + Pension + Services. Other source combinations remain unsupported, so no Services tax estimate was made."
      : null;
    const servicesEvidenceProblem =
      servicesRouteProblem ??
      invoiceSourceMapProblem ??
      (servicesEvidenceResult && servicesEvidenceResult.ok === false
        ? servicesEvidenceResult.errors.join(" ")
        : null);
    const servicesIncomeBySubcategory =
      !servicesEvidenceProblem && servicesEvidenceResult?.ok === true
        ? servicesEvidenceResult.incomeBySubcategory
        : {};
    const servicesIncome =
      !servicesEvidenceProblem && servicesEvidenceResult?.ok === true
        ? servicesEvidenceResult.incomeTotal
        : 0;

    const hasOnlySubcategories = (
      source: string,
      allowed: readonly string[],
    ) => {
      const selected = selectedSubcategories.get(source) ?? new Set<string>();
      return (
        selected.size > 0 &&
        Array.from(selected).every((subcategory) =>
          allowed.includes(subcategory),
        )
      );
    };

    // Each route is recognised on its own merits. A filing may select several
    // of them; the calculator prices every selected route and reports which
    // combinations still need a confirmed assessment rule.
    const isSalariedRoute =
      incomeSources.includes("salary") &&
      hasOnlySubcategories("salary", ["salary", "salary-surcharge"]);
    // Profit on debt is priced through the flat-route list below, which
    // resolves the selected Section 151 row. This flag only tells the
    // calculator which single-route legacy path to use when no per-route
    // income list is supplied.
    const isBankProfitRoute = incomeSources.includes("bank_profit");
    // Section 149(IA) catalogues the exempt band and the above-10m band for a
    // pensioner below 70. Both are routed; the calculator itself reports
    // NEEDS_RULES when an above-10m case has no confirmed age.
    const isPensionRoute =
      incomeSources.includes("pension") &&
      hasOnlySubcategories("pension", [
        "pension-up-to-10m",
        "pension-above-10m-below-age-70",
        "former-employer-or-associate",
      ]);
    // The former-employer row references Section 149, so a confirmed "yes"
    // prices the whole pension on the salary slabs. The wizard now stores an
    // explicit Yes/No marker on the selection's details: a confirmed "no"
    // (worksForFormerEmployerOrAssociate === false) keeps the pension bands,
    // and a selection without the marker (legacy drafts saved before the
    // Yes/No step) still reads as "yes" — same pricing as before.
    const pensionFormerEmployerAnswer = (
      selectedSubcategories.get("pension") ?? new Set<string>()
    ).has(TY2026_PENSION_FORMER_EMPLOYER_SUBCATEGORY)
      ? resolvePensionFormerEmployerAnswer({
          details: selectionDetails.get(
            `pension\u0000${TY2026_PENSION_FORMER_EMPLOYER_SUBCATEGORY}`,
          ),
        })
      : null;
    const pensionTaxAsSalary = pensionFormerEmployerAnswer === "yes";

    // Age is derived from the taxpayer's recorded date of birth rather than
    // from the selected subcategory, so the age condition is evidence-based.
    // An approved CNIC upload writes this date onto the profile.
    const pensionerAge = assessPensionerAge({
      taxYear: draft.taxYear,
      dateOfBirth: draft.taxpayerDateOfBirth,
    });

    let pensionSource: PensionSource | null = null;
    let pensionExemptCalculationAmount: number | null = null;
    let pensionSourceProblem: string | null = null;
    if (isPensionRoute) {
      const latestPensionStatement = await prisma.document.findFirst({
        where: { filingDraftId: draft.id, userId: draft.userId, documentType: "pension_statement" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, extractionStatus: true, extractedData: true },
      });
      try {
        pensionSource = resolveApprovedPensionSource({
          document: latestPensionStatement, taxYear: draft.taxYear,
          profile: { dateOfBirth: draft.taxpayerDateOfBirth, cnic: draft.taxpayerCnic },
          taxAsSalary: pensionTaxAsSalary, ledgerPension: pensionIncome,
          ledgerTaxWithheld: sumMoney(entries.filter(e => e.entryType === "EXPENSE" && normalizeCategory(e.category) === "TAX_PAYMENT").map(e => e.amount)),
          hasOtherIncomeSources: incomeSources.some(source => source !== "pension"),
        });
      } catch (error) {
        pensionSourceProblem = error instanceof Error ? error.message : "Review and approve the latest Pension Statement.";
        if (pensionFormerEmployerAnswer === "no" && latestPensionStatement?.extractionStatus === "MAPPED") {
          try {
            const facts = readPensionStatementFacts(latestPensionStatement.extractedData, draft.taxYear);
            const profileErrors = pensionProfileErrors(facts, {
              dateOfBirth: draft.taxpayerDateOfBirth,
              cnic: draft.taxpayerCnic,
            });
            const maximumPlausiblePension = Math.max(
              facts.grossAnnual,
              facts.netAnnual ?? 0,
              facts.approvedAnnual ?? 0,
              sumMoney([facts.grossAnnual, facts.medicalAnnual ?? 0]),
              pensionIncome,
            );
            if (profileErrors.length === 0 && maximumPlausiblePension <= TY2026_PENSION_RULES.exemptUpTo) {
              pensionExemptCalculationAmount = maximumPlausiblePension;
              pensionSourceProblem = null;
            }
          } catch {
            // Keep the stricter source error when even the exemption ceiling is uncertain.
          }
        }
      }
    }

    // Section 155 charges an individual/AOP by slab and a company at a flat
    // rate, so the selected subcategory decides which formula is used.
    const isRentalRoute =
      incomeSources.includes("property_rent") &&
      (hasOnlySubcategories("property_rent", ["individual-aop"]) ||
        hasOnlySubcategories("property_rent", ["company"]));
    const rentalRecipientKind = hasOnlySubcategories("property_rent", [
      "company",
    ])
      ? ("COMPANY" as const)
      : ("INDIVIDUAL_OR_AOP" as const);

    /**
     * Flat routes: the rate depends on which catalog row the filing selected,
     * so each selected subcategory becomes its own breakdown line. On the exact
     * single-Services route, Services tax bases come from confirmed
     * invoice/settlement evidence under the chosen accounting method; the bank
     * ledger is only a reconciliation check, never a second tax base. Other
     * multi-category flat routes still stop until separately evidenced.
     */
    const flatRouteInputs = [
      {
        source: "services",
        route: "services" as const,
        income: servicesIncome,
      },
      {
        source: "other_income",
        route: "other_income" as const,
        income: otherIncomeAmount,
      },
      {
        source: "capital_gains",
        route: "capital_gains" as const,
        income: capitalGainsIncome,
      },
      {
        source: "business",
        route: "business" as const,
        income: businessIncome,
      },
      {
        source: "dividend",
        route: "dividend" as const,
        income: dividendIncome,
      },
      {
        source: "foreign_income_assets",
        route: "foreign_income_assets" as const,
        income: nonResidentIncome,
      },
      // Section 151 has six catalogued rows from 10% to 25%, so profit on debt
      // is resolved from the selected subcategory like every other multi-rate
      // route rather than being pinned to the bank-deposit row.
      {
        source: "bank_profit",
        route: "bank_profit" as const,
        income: bankProfitIncome,
      },
    ];

    const flatRouteSources: TaxIncomeSource[] = [];
    const flatRoutesNeedingSplit: string[] = [];
    let servicesAllocationProblem: string | null = incomeSources.includes("services")
      ? servicesEvidenceProblem
      : null;
    const routedFlatSourceNames = new Set<string>();

    // A filing for yourself prices business income from the declared profit
    // (see the business-profit block below), never from the withholding-rate
    // cards, so the flat business route is skipped for it. Any card selection
    // saved on an older draft is ignored here for the same reason.
    const isMyselfBusiness =
      draft.filerType !== "my_business" && incomeSources.includes("business");

    for (const entry of flatRouteInputs) {
      if (!incomeSources.includes(entry.source)) continue;
      if (entry.source === "business" && isMyselfBusiness) continue;

      const selected = Array.from(
        selectedSubcategories.get(entry.source) ?? new Set<string>(),
      );
      if (selected.length === 0) continue;

      if (entry.source === "services") {
        if (servicesEvidenceProblem) {
          servicesAllocationProblem = servicesEvidenceProblem;
          continue;
        }
        for (const subcategory of selected) {
          const income = servicesIncomeBySubcategory[subcategory] ?? 0;
          if (income > 0) {
            flatRouteSources.push({
              route: entry.route,
              income,
              subcategory,
            });
          }
        }
        // Even when the selected accounting method yields no income in this
        // tax year, the source is covered by confirmed evidence—not salary.
        routedFlatSourceNames.add(entry.source);
        continue;
      }

      if (selected.length > 1) {
        flatRoutesNeedingSplit.push(entry.source);
        continue;
      }

      const details = selectionDetails.get(
        `${entry.source}\u0000${selected[0]}`,
      );
      flatRouteSources.push({
        route: entry.route,
        income: entry.income,
        subcategory: selected[0],
        // The composite mutual-fund row prices its declared debt/equity
        // split; every other flat row prices from the ledger amount alone.
        ...(entry.source === "dividend" &&
        selected[0] === "mutual-fund-proportional"
          ? {
              attributes: {
                debtPortion: details?.debtPortion,
                equityPortion: details?.equityPortion,
              },
            }
          : {}),
      });
      routedFlatSourceNames.add(entry.source);
    }

    /**
     * Business profit (filing for yourself). The taxpayer declares sales and
     * expenses on the Business profit step; the taxable profit joins the
     * individual slab. Anything that cannot be priced honestly stops the
     * estimate with a plain message instead of showing a wrong number.
     */
    const businessProfitSources: TaxIncomeSource[] = [];
    let businessProfitProblem: string | null = null;
    let minimumTax113Input: Parameters<typeof calculateTaxEstimate>[0]["minimumTax113"];
    if (isMyselfBusiness) {
      const profitDetails = selectionDetails.get(
        `business\u0000${TY2026_BUSINESS_PROFIT_SUBCATEGORY}`,
      );
      if (!hasBusinessSalesFigure(profitDetails)) {
        businessProfitProblem =
          "Business income is selected, but there is no sales figure yet. Sales and the other yearly business figures come from your Business Books: upload them on the Upload documents step, check the figures, press Save & Approve Map, and recalculate.";
      } else if (
        validateDepreciationSchedule(profitDetails?.businessDepreciationSchedule ?? []).length
      ) {
        // DP-1: an asset schedule that breaks an IRIS/law rule is never priced.
        businessProfitProblem = `Your asset list for tax depreciation needs a fix: ${validateDepreciationSchedule(
          profitDetails?.businessDepreciationSchedule ?? [],
        ).join(" ")} Open the Business profit step, correct it, save, and recalculate.`;
      } else {
        // DP-4 item 3: with other income heads the s.57(4) 10-million test
        // cannot be read from the business figures alone.
        const profit = computeBusinessProfit(profitDetails, {
          otherIncomeHeads: incomeSources.some((source) => source !== "business"),
        });
        // Phase 3c: Section 113 minimum tax. It reaches the return when the
        // turnover is Rs 100 million or more this year, or the taxpayer said
        // yes to an earlier year (D2). The rate comes from the business type
        // (D3, default 1.25%); cotton ginners stop (own regime).
        const minimumTaxReach = section113Applicability({
          turnover: profit.turnover,
          turnover100mEarlierYear: profitDetails?.businessTurnover100mEarlierYear,
        });
        const minimumTaxCategory = getMinimumTaxCategory(
          profitDetails?.businessMinimumTaxCategory ?? DEFAULT_MINIMUM_TAX_CATEGORY,
        );
        if (minimumTaxReach.needsEarlierYearAnswer) {
          businessProfitProblem = SECTION_113_TEXT.earlierYearMissing;
        } else if (
          minimumTaxReach.applies &&
          (!minimumTaxCategory || minimumTaxCategory.ratePercent === null)
        ) {
          businessProfitProblem = SECTION_113_TEXT.cottonGinner;
        } else {
          businessProfitSources.push({
            route: "business_profit",
            income: profit.taxableIncome,
          });
          if (minimumTaxReach.applies && minimumTaxReach.reason && minimumTaxCategory?.ratePercent) {
            minimumTax113Input = {
              reason: minimumTaxReach.reason,
              turnover: profit.turnover,
              ratePercent: minimumTaxCategory.ratePercent,
              categoryLabel: minimumTaxCategory.shortLabel,
            };
          }
        }
      }
    }

    /**
     * Activity routes: imports and advance tax. Unlike income routes, each
     * selection carries its own declared figures, so several categories
     * under one source never need a ledger split — every card prices its
     * own transaction. Required figures are enforced here against the same
     * field contract the wizard renders.
     */
    const activitySources: TaxIncomeSource[] = [];
    const activityDetailProblems: string[] = [];
    const routedActivitySourceNames = new Set<string>();

    for (const source of incomeSources.filter(isTaxActivitySource)) {
      const selected = Array.from(
        selectedSubcategories.get(source) ?? new Set<string>(),
      );
      if (selected.length === 0) continue;
      routedActivitySourceNames.add(source);

      for (const subcategory of selected) {
        const details =
          selectionDetails.get(`${source}\u0000${subcategory}`) ?? {};
        const missing = getTy2026SubcategoryDetailFields(source, subcategory)
          .filter((field) => {
            if (!field.required) return false;
            const value = details[field.key];
            // A yes/no answer counts once given, either way; numbers must
            // additionally clear the field floor.
            if (field.checkbox === true) return value === undefined;
            return (
              value === undefined ||
              typeof value !== "number" ||
              value < field.min
            );
          })
          .map((field) =>
            details[field.key] === undefined
              ? field.label
              : `${field.label} (minimum ${field.min})`,
          );
        if (missing.length > 0) {
          activityDetailProblems.push(
            `${source}/${subcategory}: enter ${missing.join(", ")}`,
          );
          continue;
        }
        activitySources.push({
          route: source,
          income: details.amount ?? 0,
          subcategory,
          attributes: {
            engineCapacityCc: details.engineCapacityCc,
            seatCount: details.seatCount,
            ladenWeightKg: details.ladenWeightKg,
            unitQuantity: details.unitQuantity,
            cfValueUsd: details.cfValueUsd,
            isSmartphone: details.isSmartphone,
            vehicleAgeYears: details.vehicleAgeYears,
          },
        });
      }
    }

    // Section 149 withholding, read from the mapped salary certificate. The
    // stored column is not consulted here: it is this action's own output, so
    // reading it back would make the result depend on how many times the user
    // has pressed Calculate.
    let certificateTaxWithheld = 0;
    let certificateGrossSalary: number | null = null;
    if (isSalariedRoute) {
      const salaryCertificate = await prisma.document.findFirst({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          documentType: "salary_certificate",
          extractionStatus: "MAPPED",
        },
        select: { extractedData: true },
      });
      certificateGrossSalary = extractMappedSalaryGross(
        salaryCertificate?.extractedData ?? null,
      );
      certificateTaxWithheld =
        extractMappedSalaryWithholding(
          salaryCertificate?.extractedData ?? null,
        ) ?? 0;
    }

    const salaryIncomeForTax = resolveSalaryTaxableIncome({
      ledgerSalaryRemainder: salaryIncomeFromLedger,
      bankSalaryIncome,
      certificateGrossSalary,
    });

    // Section 149 (certificate), Section 151 (ledger) and verified Services
    // withholding are added, and the combination is flagged rather than
    // silently adjusted when the same deduction may appear on both sides. A
    // Services amount enters this total only when its payment match is
    // confirmed and its exact withholding section/code/reference are backed by
    // a mapped, human-confirmed withholding document; payout arithmetic alone
    // is not treated as a tax certificate.
    const servicesTaxWithheld =
      freelancerEnabled &&
      !servicesEvidenceProblem &&
      servicesEvidenceResult?.ok === true
        ? servicesInvoiceEvidence.reduce((sum, invoice) => {
            const matchesSum = (invoice.paymentMatches ?? []).reduce(
              (matchSum, match) => {
                const verified =
                  match.recordStatus === "CONFIRMED" &&
                  match.withholdingEvidenceHumanConfirmed &&
                  Boolean(match.withholdingSection?.trim()) &&
                  Boolean(match.withholdingIrisCode?.trim()) &&
                  Boolean(match.withholdingEvidenceReference?.trim()) &&
                  Boolean(match.withholdingEvidenceDocumentId) &&
                  match.withholdingEvidenceDocument?.extractionStatus === "MAPPED" &&
                  SERVICES_WITHHOLDING_DOCUMENT_TYPES.has(
                    match.withholdingEvidenceDocument.documentType,
                  );
                return verified
                  ? matchSum + toMoneyAmount(match.withholdingTaxPkr)
                  : matchSum;
              },
              0,
            );
            return sum + matchesSum;
          }, 0)
        : 0;

    const withholding = resolveTaxWithheld({
      certificateTaxWithheld,
      entries,
      // A reviewed pension explicitly supplies its credit (including confirmed
      // zero); do not feed a previous pension calculation's output back as credit.
      // The general non-pension stored-credit product behavior is unchanged.
      storedTaxWithheld: pensionSource ? 0 : toMoneyAmount(draft.taxWithheld),
      servicesTaxWithheld,
    });
    const taxWithheld = pensionSource ? sumMoney([withholding.taxWithheld, pensionSource.creditToAdd]) : withholding.taxWithheld;

    // Build the per-route income list the calculator prices. The order here is
    // irrelevant; the calculator sorts the breakdown into a stable order.
    const routedIncomeSources: TaxIncomeSource[] = [];
    if (isSalariedRoute) {
      routedIncomeSources.push({
        route: "salary",
        income: salaryIncomeForTax,
      });
    }
    if (isPensionRoute) {
      routedIncomeSources.push({
        route: "pension",
        income: pensionSource?.annualPension ?? pensionExemptCalculationAmount ?? 0,
      });
    }
    if (isRentalRoute) {
      routedIncomeSources.push({
        route: "property_rent",
        income: rentalIncome,
      });
    }
    routedIncomeSources.push(...flatRouteSources);
    routedIncomeSources.push(...businessProfitSources);
    routedIncomeSources.push(...activitySources);

    // A selected source with no implemented route must stop the estimate. If
    // it were ignored, its income would be absorbed into the salary remainder
    // and taxed under the wrong section.
    const routedSourceNames = new Set<string>();
    if (isSalariedRoute) routedSourceNames.add("salary");
    if (isPensionRoute) routedSourceNames.add("pension");
    if (isRentalRoute) routedSourceNames.add("property_rent");
    for (const source of routedFlatSourceNames) routedSourceNames.add(source);
    if (businessProfitSources.length > 0) routedSourceNames.add("business");
    for (const source of routedActivitySourceNames) {
      routedSourceNames.add(source);
    }

    const unroutedSources = incomeSources.filter(
      (source) => !routedSourceNames.has(source),
    );

    const estimate = calculateTaxEstimate({
      taxYear: draft.taxYear,
      filerStatus,
      totalIncome: pensionSource || pensionExemptCalculationAmount !== null
        ? sumMoney([totalIncome, -pensionIncome, pensionSource?.annualPension ?? pensionExemptCalculationAmount ?? 0])
        : totalIncome,
      totalExpenses,
      bankProfitIncome,
      incomeSources: routedIncomeSources,
      // Use withholding extracted from the filing documents instead of
      // resetting it to zero during every recalculation.
      taxWithheld,
      isSalariedRoute,
      isPensionRoute,
      isRentalRoute,
      isBankProfitRoute,
      pensionerAgeBelow70: pensionerAge.isBelow70,
      pensionerAgeReason: pensionerAge.reason,
      // isBelow70 is false for 70+ and unknown alike (turns-70 counts as
      // below-70 under the confirmed first-day rule), so the exemption
      // needs its own confirmed signal: 70 for the whole year.
      pensionerAge70OrAbove: pensionerAge.bracket === "SEVENTY_OR_ABOVE",
      pensionTaxAsSalary,
      rentalRecipientKind,
      ...(minimumTax113Input ? { minimumTax113: minimumTax113Input } : {}),
    });

    const blockedNote = pensionSourceProblem ?? (
      businessProfitProblem !== null
        ? businessProfitProblem
        : servicesAllocationProblem !== null
          ? servicesAllocationProblem
          : activityDetailProblems.length > 0
          ? `This filing is missing figures for ${activityDetailProblems.join(" · ")}. Open the category step, enter the missing figures, save, and recalculate.`
          : flatRoutesNeedingSplit.length > 0
            ? `This filing selects more than one category under ${flatRoutesNeedingSplit.join(", ")}, and each category is charged at its own rate. The ledger records a single amount per source, so there is no evidence for how the income divides between those categories. Record the income as separate ledger entries per category, or select a single category, and recalculate.`
            : unroutedSources.length > 0
              ? `This filing selects ${unroutedSources.join(", ")}, for which no TY2026 route is implemented yet. Confirmed rules are required before those sources can be included in an estimate.`
              : null);

    // A stop the taxpayer can clear themselves (a missing answer, figure,
    // evidence or reviewed decision) is NOT a missing rule. Only sources
    // with no implemented TY2026 route keep NEEDS_RULES; everything else
    // reports NEEDS_USER_INPUT so the taxpayer is asked for their homework
    // instead of being told the rules do not exist.
    const blockedByUserInput =
      pensionSourceProblem !== null ||
      activityDetailProblems.length > 0 ||
      flatRoutesNeedingSplit.length > 0 ||
      servicesAllocationProblem !== null ||
      (businessProfitProblem !== null &&
        businessProfitProblem !== SECTION_113_TEXT.cottonGinner);
    const result: TaxCalculationResult = blockedNote
      ? {
          ...estimate,
          status: blockedByUserInput ? "NEEDS_USER_INPUT" : "NEEDS_RULES",
          taxableIncome: null,
          baseTax: null,
          surcharge: null,
          taxDue: null,
          taxPayable: null,
          refundDue: null,
          appliedRuleIds: [],
          breakdown: [],
          finalTaxDue: 0,
          assessableTaxDue: 0,
          collectionBreakdown: [],
          collectionTaxDue: 0,
          note: blockedNote,
        }
      : estimate;

    const calculatedAt = new Date();
    const calculationRevision = randomUUID();

    // Persist the per-route breakdown as an audit trail. Each recalculation
    // writes a new revision, so an approved packet can always be re-read
    // against the exact lines that produced its totals.
    // Both income lines and collection lines persist to the audit table; the
    // filing summary splits them back apart for display.
    const pricedLines = [...result.breakdown, ...result.collectionBreakdown];
    const calculationLines = pricedLines.map((line) => {
      const primaryRule = line.appliedRuleIds[0]
        ? getTy2026RateCardRule(line.appliedRuleIds[0])
        : null;

      return {
        filingDraftId: draft.id,
        userId: draft.userId,
        calculationRevision: calculationRevision,
        ruleSetVersion: TY2026_RULE_SET_VERSION,
        ruleId: line.appliedRuleIds[0] ?? "UNKNOWN",
        section: primaryRule?.section ?? "",
        source: line.route,
        subcategory: primaryRule?.subcategory ?? "",
        filerStatusUsed: filerStatus,
        taxBase: line.income,
        baseTax: line.baseTax,
        surcharge: line.surcharge,
        calculatedTax: line.taxDue,
        detailsJson: JSON.stringify({
          rateShape: line.rateShape,
          isFinalTax: line.isFinalTax,
          appliedRuleIds: line.appliedRuleIds,
          note: line.note,
          combinedRoutes: line.combinedRoutes ?? [],
          ...(pensionSource && (line.route === "pension" || line.combinedRoutes?.some(route => route.route === "pension")) ? { pensionSource } : {}),
        }),
      };
    });

    await prisma.$transaction(async (tx) => {
      await tx.filingDraft.update({
        where: { id: draft.id },
        data: {
          status: "IN_PROGRESS",
          taxableIncome: result.taxableIncome,
          taxWithheld: result.taxWithheld,
          taxPayable: result.taxPayable,
          refundDue: result.refundDue,
          taxCalculationStatus: result.status,
          taxpayerListStatus: filerStatus,
          taxpayerListStatusSource: "MANUAL",
          taxpayerListStatusCheckedAt: calculatedAt,
          taxRuleSetVersion: TY2026_RULE_SET_VERSION,
          taxCalculationRevision: calculationRevision,
          packetApprovalConfirmed: false,
          packetApprovalAt: null,
          packetApprovalByUserId: null,
        },
      });

      // Replace the previous revision's lines. Keeping only the current
      // revision avoids a draft accumulating stale breakdowns that no longer
      // match the totals stored on the draft itself.
      await tx.filingTaxCalculationLine.deleteMany({
        where: { filingDraftId: draft.id, userId: draft.userId },
      });
      if (calculationLines.length > 0) {
        await tx.filingTaxCalculationLine.createMany({
          data: calculationLines,
        });
      }

      // A calculation under a selected filer status is a new authoritative
      // result. Any packet/PDF/approval generated for an older result must not
      // survive an ATL/Late Filer/Non-ATL switch or recalculation.
      await tx.filingPacket.updateMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
          status: { not: "SUPERSEDED" },
        },
        data: {
          status: "SUPERSEDED",
          approvalStatus: "SUPERSEDED",
        },
      });

      if (isPensionRoute) await cancelActivePensionJobs(tx, draft.id, draft.userId);
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

    await createNotification({
      userId: draft.userId,
      type: "FILING_STATUS",
      title: `${filerStatus} tax estimate updated — Tax Year ${draft.taxYear}`,
      message:
        result.status === "ESTIMATE"
          ? `${filerStatus} estimate · Tax payable: PKR ${(result.taxPayable ?? 0).toLocaleString()} · Refund due: PKR ${(result.refundDue ?? 0).toLocaleString()}.`
          : "Tax calculation needs a route-specific rule set before a final estimate is available.",
      link: `/tax/new?draftId=${draft.id}`,
    });

    return {
      success: true,
      result,
      filerStatus,
      calculationRevision,
      pensionSource,
      // Non-blocking: the estimate is valid, but the same deduction may have
      // been counted from both the certificate and the ledger. Surfaced so the
      // user resolves it before filing rather than after an FBR notice.
      withholdingWarning: withholding.duplicateWarning,
    };
  } catch (error) {
    console.error("Error calculating tax:", error);
    return { success: false, error: "Failed to calculate tax" };
  }
}
