"use server";

import { getServerSession } from "next-auth/next";
import { revalidatePath } from "next/cache";

import type { Prisma } from "@prisma/client";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  analyzeUploads,
  isUploadKind,
  type UploadKind,
} from "@/lib/sales-tax/analyze-uploads";
import {
  buildApprovalPacket,
  buildEstimate,
  checkCapitalRows,
  fingerprintOf,
  isApprovalCurrent,
  type FileSummary,
} from "@/lib/sales-tax/estimate";
import {
  parseStoredFigures,
  validateFiguresForm,
  type ReturnFigures,
} from "@/lib/sales-tax/figures";
import {
  firstManualRow,
  MANUAL_KIND,
  MAX_MANUAL_INVOICES,
  mergeManualGrid,
  parseStoredManual,
  validateManualInvoice,
  type ManualInvoice,
} from "@/lib/sales-tax/manual-invoices";
import type { CellGrid } from "@/lib/sales-tax/template-reader";
import type { ReturnResult, SalesTaxProblem } from "@/lib/sales-tax/types";
import {
  MAX_UPLOAD_BYTES,
  readInvoiceWorkbook,
} from "@/lib/sales-tax/workbook";
import { getDueDates } from "@/lib/sales-tax/rules/fbr-goods/due-dates";
import { firstDayOfMonth, todayInPakistan } from "@/lib/sales-tax/dates";
import { buildSrbMonthState } from "@/lib/sales-tax/srb/state";
import {
  getSrbDueDates,
  SRB_FIRST_SUPPORTED_DATE,
} from "@/lib/sales-tax/rules/srb-services";
import {
  parseStoredAuthorities,
  validateProfile,
  validateRequestedPeriod,
  type AuthorityCode,
} from "@/lib/sales-tax/profile";

// The Sales Tax module is separate from the income-tax filing journey: it has
// its own tables (SalesTaxProfile, SalesTaxFiling) and never touches
// FilingDraft.

const STATUS_DRAFT = "DRAFT";

async function getCurrentUserId() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) throw new Error("Unauthorized");

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: session.user?.name ?? null,
      image: session.user?.image ?? null,
    },
    select: { id: true },
  });
  return user.id;
}

export type SalesTaxFilingSummary = {
  id: string;
  businessId: string;
  authority: string;
  periodYear: number;
  periodMonth: number;
  status: string;
  updatedAt: string;
  /** "current" = approved and nothing changed since; "stale" = approved, then a file or figure changed. */
  approval: "none" | "current" | "stale";
  dueDates: {
    annexC: string;
    payment: string;
    returnFiling: string;
  } | null;
};

function toSummary(
  row: {
    id: string;
    businessId: string;
    authority: string;
    periodYear: number;
    periodMonth: number;
    status: string;
    updatedAt: Date;
  },
  approval: SalesTaxFilingSummary["approval"] = "none",
): SalesTaxFilingSummary {
  // FBR and SRB due dates are known; the other authorities get theirs with
  // their own phases.
  const period = { year: row.periodYear, month: row.periodMonth };
  const due =
    row.authority === "FBR"
      ? getDueDates(period)
      : row.authority === "SRB"
        ? getSrbDueDates(period)
        : null;
  return {
    id: row.id,
    businessId: row.businessId,
    authority: row.authority,
    periodYear: row.periodYear,
    periodMonth: row.periodMonth,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
    approval,
    dueDates: due
      ? {
          annexC: due.annexC,
          payment: due.payment,
          returnFiling: due.returnFiling,
        }
      : null,
  };
}

export type SalesTaxBusiness = {
  id: string;
  businessName: string;
  registrationNo: string;
  authorities: AuthorityCode[];
};

function toBusiness(row: {
  id: string;
  businessName: string;
  registrationNo: string;
  authorities: string;
}): SalesTaxBusiness {
  return {
    id: row.id,
    businessName: row.businessName,
    registrationNo: row.registrationNo,
    authorities: parseStoredAuthorities(row.authorities),
  };
}

/** Registration numbers are compared by their digits, so 123-4567 and 1234567 are one business. */
const digitsOf = (value: string) => value.replace(/\D/g, "");

export async function getSalesTaxOverviewAction() {
  try {
    const userId = await getCurrentUserId();
    const [businessRows, filings] = await Promise.all([
      prisma.salesTaxProfile.findMany({
        where: { userId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      prisma.salesTaxFiling.findMany({
        where: { userId },
        orderBy: [
          { periodYear: "desc" },
          { periodMonth: "desc" },
          { authority: "asc" },
        ],
      }),
    ]);
    // Whether an approval still holds depends on the files and figures, so
    // only the approved months are loaded in full.
    const approvedIds = filings
      .filter((row) => row.approvedAt)
      .map((row) => row.id);
    const approvedMonths = approvedIds.length
      ? await prisma.salesTaxFiling.findMany({
          where: { id: { in: approvedIds }, userId },
          include: {
            uploads: {
              select: {
                kind: true,
                fileName: true,
                fileSize: true,
                updatedAt: true,
                grid: true,
              },
            },
          },
        })
      : [];
    const approvalById = new Map<string, SalesTaxFilingSummary["approval"]>();
    const registrationById = new Map(
      businessRows.map((row) => [row.id, row.registrationNo]),
    );
    const businessById = new Map(businessRows.map((row) => [row.id, row]));
    for (const month of approvedMonths) {
      if (month.authority === "SRB") {
        const owner = businessById.get(month.businessId);
        const state = buildSrbMonthState({
          period: { year: month.periodYear, month: month.periodMonth },
          businessName: owner?.businessName ?? "",
          registrationNo: owner?.registrationNo ?? "",
          uploads: month.uploads,
          figures: month.figures,
          approvedAt: month.approvedAt,
          approvedPacket: month.approvedPacket,
          today: todayInPakistan(),
        });
        approvalById.set(
          month.id,
          state.review.approval?.current ? "current" : "stale",
        );
        continue;
      }
      const { review } = computeReview(
        month,
        parseStoredFigures(month.figures),
        registrationById.get(month.businessId) ?? "",
      );
      approvalById.set(
        month.id,
        review.approval?.current ? "current" : "stale",
      );
    }
    return {
      success: true as const,
      businesses: businessRows.map(toBusiness),
      filings: filings.map((row) =>
        toSummary(row, approvalById.get(row.id) ?? "none"),
      ),
    };
  } catch (error) {
    console.error("Error loading the sales tax overview:", error);
    return {
      success: false as const,
      error: "Could not load your sales tax details. Please refresh the page.",
      businesses: [] as SalesTaxBusiness[],
      filings: [] as SalesTaxFilingSummary[],
    };
  }
}

export async function saveSalesTaxProfileAction(input: {
  /** Set to change a business that is already saved; leave out to add one. */
  businessId?: string | null;
  businessName: string;
  registrationNo: string;
  authorities: string[];
}) {
  try {
    const checked = validateProfile(input);
    if (checked.ok === false)
      return { success: false as const, error: checked.error };

    const userId = await getCurrentUserId();
    const { businessName, registrationNo, authorities } = checked.value;
    const data = {
      businessName,
      registrationNo,
      authorities: JSON.stringify(authorities),
    };

    const mine = await prisma.salesTaxProfile.findMany({ where: { userId } });
    const sameNumber = mine.find(
      (row) => digitsOf(row.registrationNo) === digitsOf(registrationNo),
    );

    let target: { id: string } | undefined;
    if (input.businessId) {
      target = mine.find((row) => row.id === String(input.businessId));
      if (!target) {
        return {
          success: false as const,
          error: "This business was not found.",
        };
      }
      if (sameNumber && sameNumber.id !== target.id) {
        return {
          success: false as const,
          error: `Another business of yours already uses this registration number (${sameNumber.businessName}). Check the number or choose that business.`,
        };
      }
    } else {
      // A number you already saved opens that business again instead of
      // making a second copy; a new number is a new business.
      target = sameNumber;
    }

    const saved = target
      ? await prisma.salesTaxProfile.update({ where: { id: target.id }, data })
      : await prisma.salesTaxProfile.create({ data: { userId, ...data } });
    revalidatePath("/tax/sales-tax");
    return { success: true as const, businessId: saved.id };
  } catch (error) {
    console.error("Error saving the sales tax profile:", error);
    return {
      success: false as const,
      error: "Could not save your business details. Please try again.",
    };
  }
}

/** Removes a business that has no returns. A business with returns is kept. */
export async function deleteSalesTaxBusinessAction(businessId: string) {
  try {
    const userId = await getCurrentUserId();
    const business = await prisma.salesTaxProfile.findFirst({
      where: { id: String(businessId ?? ""), userId },
      select: { id: true, _count: { select: { filings: true } } },
    });
    if (!business) {
      return { success: false as const, error: "This business was not found." };
    }
    if (business._count.filings > 0) {
      return {
        success: false as const,
        error:
          "This business still has returns. Delete its draft returns first.",
      };
    }
    await prisma.salesTaxProfile.delete({ where: { id: business.id } });
    revalidatePath("/tax/sales-tax");
    return { success: true as const };
  } catch (error) {
    console.error("Error deleting the sales tax business:", error);
    return {
      success: false as const,
      error: "Could not delete this business. Please try again.",
    };
  }
}

export async function startSalesTaxMonthAction(input: {
  /** Which business the return is for. Optional only when the user has one business. */
  businessId?: string | null;
  authority: string;
  year: number;
  month: number;
}) {
  try {
    const userId = await getCurrentUserId();
    const businesses = await prisma.salesTaxProfile.findMany({
      where: { userId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (businesses.length === 0) {
      return {
        success: false as const,
        error: "Save your business details first, then start a month.",
      };
    }
    let profile = businesses[0];
    if (input.businessId) {
      const chosen = businesses.find(
        (row) => row.id === String(input.businessId),
      );
      if (!chosen)
        return {
          success: false as const,
          error: "This business was not found.",
        };
      profile = chosen;
    } else if (businesses.length > 1) {
      return {
        success: false as const,
        error: "Choose which business this return is for.",
      };
    }

    const authority = String(input.authority ?? "");
    const allowed = parseStoredAuthorities(profile.authorities);
    if (!allowed.includes(authority as AuthorityCode)) {
      return {
        success: false as const,
        error: "Choose one of the authorities saved in your business details.",
      };
    }

    const period = validateRequestedPeriod(input.year, input.month);
    if (period.ok === false)
      return { success: false as const, error: period.error };
    if (
      authority === "SRB" &&
      firstDayOfMonth(period.value) < SRB_FIRST_SUPPORTED_DATE
    ) {
      return {
        success: false as const,
        error:
          "Sindh services returns are supported from July 2025 onwards. Choose a later month.",
      };
    }

    // One return per business, authority and month: starting it again opens the same one.
    const where = {
      businessId_authority_periodYear_periodMonth: {
        businessId: profile.id,
        authority,
        periodYear: period.value.year,
        periodMonth: period.value.month,
      },
    };
    const existing = await prisma.salesTaxFiling.findUnique({ where });
    if (existing) {
      return { success: true as const, id: existing.id, alreadyExisted: true };
    }

    try {
      const created = await prisma.salesTaxFiling.create({
        data: {
          userId,
          businessId: profile.id,
          authority,
          periodYear: period.value.year,
          periodMonth: period.value.month,
          status: STATUS_DRAFT,
        },
      });
      revalidatePath("/tax/sales-tax");
      return { success: true as const, id: created.id, alreadyExisted: false };
    } catch (error) {
      // Two clicks at once: the unique key stops the second insert. Return the
      // row the first click created.
      const winner = await prisma.salesTaxFiling.findUnique({ where });
      if (winner) {
        return { success: true as const, id: winner.id, alreadyExisted: true };
      }
      throw error;
    }
  } catch (error) {
    console.error("Error starting the sales tax month:", error);
    return {
      success: false as const,
      error: "Could not start this month. Please try again.",
    };
  }
}

export async function deleteSalesTaxMonthAction(filingId: string) {
  try {
    const userId = await getCurrentUserId();
    const filing = await prisma.salesTaxFiling.findFirst({
      where: { id: String(filingId ?? ""), userId },
      select: { id: true, status: true },
    });
    if (!filing) {
      return { success: false as const, error: "This month was not found." };
    }
    if (filing.status !== STATUS_DRAFT) {
      return {
        success: false as const,
        error: "Only a draft month can be deleted.",
      };
    }
    await prisma.salesTaxFiling.delete({ where: { id: filing.id } });
    revalidatePath("/tax/sales-tax");
    return { success: true as const };
  } catch (error) {
    console.error("Error deleting the sales tax month:", error);
    return {
      success: false as const,
      error: "Could not delete this month. Please try again.",
    };
  }
}

export type SalesTaxUploadInfo = {
  /** The uploaded file's name, or "Entered by hand" when there is no file. */
  fileName: string;
  fileSize: number;
  /** True when an Excel file was uploaded; false when every invoice was typed in. */
  hasFile: boolean;
  /** How many of the invoices were typed in by hand. */
  manualCount: number;
  uploadedAt: string;
  /** Invoices from the file and the typed ones together. */
  invoiceCount: number;
  /** Totals in paisa. */
  valuePaisa: number;
  taxPaisa: number;
};

/** An invoice typed in by hand, with the sheet row the checks call it. */
export type SalesTaxManualRow = {
  index: number;
  sourceRow: number;
  invoice: ManualInvoice;
};

export type SalesTaxInvoiceState = {
  sales: SalesTaxUploadInfo | null;
  purchases: SalesTaxUploadInfo | null;
  problems: SalesTaxProblem[];
  salesManual: SalesTaxManualRow[];
  purchasesManual: SalesTaxManualRow[];
};

type StoredUpload = {
  kind: string;
  fileName: string;
  fileSize: number;
  updatedAt: Date;
  grid: unknown;
};

type Side = {
  file: StoredUpload | undefined;
  manual: StoredUpload | undefined;
  entries: ManualInvoice[];
  fileGrid: CellGrid | null;
  /** The file's cells with the typed invoices after them; what every check reads. */
  grid: CellGrid | null;
};

/** The sheet each side's checks read: the uploaded file plus typed invoices. */
function gridsOf(
  period: { year: number; month: number },
  registrationNo: string,
  uploads: StoredUpload[],
): { sales: Side; purchases: Side } {
  const side = (kind: "SALES" | "PURCHASES"): Side => {
    const file = uploads.find((upload) => upload.kind === kind);
    const manual = uploads.find((upload) => upload.kind === MANUAL_KIND[kind]);
    const entries = manual ? parseStoredManual(manual.grid) : [];
    const fileGrid = file ? (file.grid as CellGrid) : null;
    return {
      file,
      manual,
      entries,
      fileGrid,
      grid: mergeManualGrid({
        kind,
        fileGrid,
        entries,
        registrationNo,
        period,
      }),
    };
  };
  return { sales: side("SALES"), purchases: side("PURCHASES") };
}

/** Reads the stored files and typed invoices and runs every file check on them again. */
function buildInvoiceState(
  period: { year: number; month: number },
  registrationNo: string,
  uploads: StoredUpload[],
): SalesTaxInvoiceState {
  const grids = gridsOf(period, registrationNo, uploads);
  const analysis = analyzeUploads({
    registrationNo,
    period,
    salesGrid: grids.sales.grid,
    purchaseGrid: grids.purchases.grid,
  });
  const info = (
    part: Side,
    stats: typeof analysis.sales,
  ): SalesTaxUploadInfo | null => {
    if (!stats || (!part.file && part.entries.length === 0)) return null;
    const stamps = [part.file, part.manual]
      .filter((upload): upload is StoredUpload => Boolean(upload))
      .map((upload) => upload.updatedAt.getTime());
    return {
      fileName: part.file ? part.file.fileName : "Entered by hand",
      fileSize: part.file ? part.file.fileSize : 0,
      hasFile: Boolean(part.file),
      manualCount: part.entries.length,
      uploadedAt: new Date(Math.max(...stamps)).toISOString(),
      invoiceCount: stats.invoiceCount,
      valuePaisa: stats.valuePaisa,
      taxPaisa: stats.taxPaisa,
    };
  };
  const rowsOf = (part: Side): SalesTaxManualRow[] =>
    part.entries.map((invoice, index) => ({
      index,
      sourceRow: firstManualRow(part.fileGrid) + index,
      invoice,
    }));
  return {
    sales: info(grids.sales, analysis.sales),
    purchases: info(grids.purchases, analysis.purchases),
    problems: analysis.problems,
    salesManual: rowsOf(grids.sales),
    purchasesManual: rowsOf(grids.purchases),
  };
}

export type SalesTaxReview = {
  figures: ReturnFigures;
  /** The estimate. Its problems are the return-level ones; file problems are in `invoices`. */
  estimate: ReturnResult;
  /** How many must-fix problems in the invoice files stop the estimate. */
  fileProblemsBlocking: number;
  approval: { approvedAt: string; current: boolean } | null;
};

const FILE_SHEETS = new Set(["sales", "purchases", "template"]);

type FilingForReview = {
  authority: string;
  periodYear: number;
  periodMonth: number;
  figures: unknown;
  approvedAt: Date | null;
  approvedPacket: unknown;
  uploads: StoredUpload[];
};

function fileSummary(info: SalesTaxUploadInfo | null): FileSummary | null {
  return info
    ? {
        fileName: info.fileName,
        invoiceCount: info.invoiceCount,
        valuePaisa: info.valuePaisa,
        taxPaisa: info.taxPaisa,
      }
    : null;
}

/** Estimate, approval state and the approval fingerprint for one month. */
function computeReview(
  filing: FilingForReview,
  figures: ReturnFigures,
  registrationNo: string,
) {
  const period = { year: filing.periodYear, month: filing.periodMonth };
  const grids = gridsOf(period, registrationNo, filing.uploads);
  const result = buildEstimate({
    registrationNo,
    period,
    salesGrid: grids.sales.grid,
    purchaseGrid: grids.purchases.grid,
    figures,
  });
  const invoices = buildInvoiceState(period, registrationNo, filing.uploads);
  const files = {
    sales: fileSummary(invoices.sales),
    purchases: fileSummary(invoices.purchases),
  };
  const fingerprint = fingerprintOf({
    period,
    registrationNo,
    figures,
    files,
    result,
  });
  const review: SalesTaxReview = {
    figures,
    estimate: {
      ...result,
      problems: result.problems.filter(
        (problem) => !FILE_SHEETS.has(problem.sheet),
      ),
    },
    fileProblemsBlocking: result.problems.filter(
      (problem) =>
        FILE_SHEETS.has(problem.sheet) && problem.severity !== "warning",
    ).length,
    approval: filing.approvedAt
      ? {
          approvedAt: filing.approvedAt.toISOString(),
          current: isApprovalCurrent(filing.approvedPacket, { fingerprint }),
        }
      : null,
  };
  return { review, result, files, fingerprint, period };
}

export async function getSalesTaxFilingAction(filingId: string) {
  try {
    const userId = await getCurrentUserId();
    const filing = await prisma.salesTaxFiling.findFirst({
      where: { id: String(filingId ?? ""), userId, authority: "FBR" },
      include: {
        business: true,
        uploads: {
          select: {
            kind: true,
            fileName: true,
            fileSize: true,
            updatedAt: true,
            grid: true,
          },
        },
      },
    });
    if (!filing)
      return { success: false as const, error: "This month was not found." };
    const profile = filing.business;
    return {
      success: true as const,
      filing: toSummary(filing),
      profile: toBusiness(profile),
      invoices: buildInvoiceState(
        { year: filing.periodYear, month: filing.periodMonth },
        profile?.registrationNo ?? "",
        filing.uploads,
      ),
      review: computeReview(
        filing,
        parseStoredFigures(filing.figures),
        profile?.registrationNo ?? "",
      ).review,
    };
  } catch (error) {
    console.error("Error loading the sales tax month:", error);
    return {
      success: false as const,
      error: "Could not load this month. Please try again.",
    };
  }
}

const ALLOWED_EXTENSION = /\.(xlsx|xlsm)$/i;

/**
 * Saves one invoice file (sales or purchases) for a month. A file that cannot
 * be read safely is refused and nothing is stored, so the file already saved
 * for that month stays as it was.
 */
export async function uploadSalesTaxInvoicesAction(formData: FormData) {
  try {
    const userId = await getCurrentUserId();
    const filingId = String(formData.get("filingId") ?? "");
    const kind = formData.get("kind");
    const file = formData.get("file");

    if (!isUploadKind(kind)) {
      return {
        success: false as const,
        error: "Choose whether this is the sales or the purchases file.",
      };
    }
    if (!(file instanceof File) || file.size === 0) {
      return {
        success: false as const,
        error: "Choose an Excel file to upload.",
      };
    }
    if (!ALLOWED_EXTENSION.test(file.name)) {
      return {
        success: false as const,
        error: "Upload the invoice template as an Excel file (.xlsx or .xlsm).",
      };
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return {
        success: false as const,
        error: `This file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB. Remove empty rows or split the month into smaller files.`,
      };
    }

    const filing = await prisma.salesTaxFiling.findFirst({
      where: { id: filingId, userId, authority: "FBR" },
      select: {
        id: true,
        status: true,
        periodYear: true,
        periodMonth: true,
        business: true,
      },
    });
    const profile = filing?.business ?? null;
    if (!filing)
      return { success: false as const, error: "This month was not found." };
    if (filing.status !== STATUS_DRAFT) {
      return {
        success: false as const,
        error: "Files can only be changed while the month is a draft.",
      };
    }
    if (!profile) {
      return {
        success: false as const,
        error: "Save your business details first, then upload your invoices.",
      };
    }

    const opened = await readInvoiceWorkbook(
      new Uint8Array(await file.arrayBuffer()),
    );
    if (opened.ok === false)
      return { success: false as const, error: opened.error };

    const period = { year: filing.periodYear, month: filing.periodMonth };
    const check = analyzeUploads({
      registrationNo: profile.registrationNo,
      period,
      salesGrid: kind === "SALES" ? opened.grid : null,
      purchaseGrid: kind === "PURCHASES" ? opened.grid : null,
    });
    const stats = kind === "SALES" ? check.sales : check.purchases;
    if (!stats || !stats.readable) {
      const first = check.problems[0];
      return {
        success: false as const,
        error: first
          ? `${first.message} ${first.action}`
          : "This file could not be read. Use the invoice template from IRIS.",
      };
    }

    const data = {
      fileName: file.name.slice(0, 200),
      fileSize: file.size,
      rowCount: stats.invoiceCount,
      grid: opened.grid as unknown as Prisma.InputJsonValue,
    };
    await prisma.$transaction(async (tx) => {
      const before =
        kind === "PURCHASES"
          ? await tx.salesTaxUpload.findUnique({
              where: { filingId_kind: { filingId: filing.id, kind } },
              select: { grid: true },
            })
          : null;
      await tx.salesTaxUpload.upsert({
        where: { filingId_kind: { filingId: filing.id, kind } },
        update: data,
        create: { filingId: filing.id, kind, ...data },
      });
      if (kind === "PURCHASES") {
        await followPurchaseFileChange(
          tx,
          filing.id,
          before ? (before.grid as CellGrid) : null,
          opened.grid as CellGrid,
        );
      }
    });
    revalidatePath(`/tax/sales-tax/${filing.id}`);

    const uploads = await prisma.salesTaxUpload.findMany({
      where: { filingId: filing.id },
      select: {
        kind: true,
        fileName: true,
        fileSize: true,
        updatedAt: true,
        grid: true,
      },
    });
    return {
      success: true as const,
      invoices: buildInvoiceState(period, profile.registrationNo, uploads),
    };
  } catch (error) {
    console.error("Error saving the sales tax invoice file:", error);
    return {
      success: false as const,
      error: "Could not save this file. Please try again.",
    };
  }
}

export async function removeSalesTaxUploadAction(
  filingId: string,
  kind: UploadKind,
) {
  try {
    const userId = await getCurrentUserId();
    if (!isUploadKind(kind)) {
      return {
        success: false as const,
        error: "Choose whether this is the sales or the purchases file.",
      };
    }
    const filing = await prisma.salesTaxFiling.findFirst({
      where: { id: String(filingId ?? ""), userId, authority: "FBR" },
      select: {
        id: true,
        status: true,
        periodYear: true,
        periodMonth: true,
        business: true,
      },
    });
    const profile = filing?.business ?? null;
    if (!filing)
      return { success: false as const, error: "This month was not found." };
    if (filing.status !== STATUS_DRAFT) {
      return {
        success: false as const,
        error: "Files can only be changed while the month is a draft.",
      };
    }
    await prisma.$transaction(async (tx) => {
      const before =
        kind === "PURCHASES"
          ? await tx.salesTaxUpload.findUnique({
              where: { filingId_kind: { filingId: filing.id, kind } },
              select: { grid: true },
            })
          : null;
      await tx.salesTaxUpload.deleteMany({
        where: { filingId: filing.id, kind },
      });
      if (kind === "PURCHASES" && before) {
        await followPurchaseFileChange(
          tx,
          filing.id,
          before.grid as CellGrid,
          null,
        );
      }
    });
    revalidatePath(`/tax/sales-tax/${filing.id}`);

    const uploads = await prisma.salesTaxUpload.findMany({
      where: { filingId: filing.id },
      select: {
        kind: true,
        fileName: true,
        fileSize: true,
        updatedAt: true,
        grid: true,
      },
    });
    return {
      success: true as const,
      invoices: buildInvoiceState(
        { year: filing.periodYear, month: filing.periodMonth },
        profile?.registrationNo ?? "",
        uploads,
      ),
    };
  } catch (error) {
    console.error("Error removing the sales tax invoice file:", error);
    return {
      success: false as const,
      error: "Could not remove this file. Please try again.",
    };
  }
}

/**
 * Fixed-asset rows are purchase row numbers. Typed purchases come after the
 * uploaded file, so removing a typed purchase or changing the file moves them;
 * the saved numbers are moved with them so they never point at another invoice.
 * `remap` returns the new number, or null when that row is gone.
 */
async function remapCapitalRows(
  tx: Prisma.TransactionClient,
  filingId: string,
  remap: (row: number) => number | null,
) {
  const row = await tx.salesTaxFiling.findUnique({
    where: { id: filingId },
    select: { figures: true },
  });
  const stored = row?.figures;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
  const current = (stored as Record<string, unknown>).capitalGoodsRows;
  if (!Array.isArray(current) || current.length === 0) return;
  const next = Array.from(
    new Set(
      current
        .map((value) => remap(Number(value)))
        .filter((value): value is number => value !== null),
    ),
  ).sort((a, b) => a - b);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  await tx.salesTaxFiling.update({
    where: { id: filingId },
    data: {
      figures: { ...stored, capitalGoodsRows: next } as Prisma.InputJsonValue,
    },
  });
}

/** Moves the saved fixed-asset rows that are typed purchases when the file above them changes. */
async function followPurchaseFileChange(
  tx: Prisma.TransactionClient,
  filingId: string,
  oldFileGrid: CellGrid | null,
  newFileGrid: CellGrid | null,
) {
  const manual = await tx.salesTaxUpload.findUnique({
    where: { filingId_kind: { filingId, kind: MANUAL_KIND.PURCHASES } },
    select: { grid: true },
  });
  const count = manual ? parseStoredManual(manual.grid).length : 0;
  if (count === 0) return;
  const oldFirst = firstManualRow(oldFileGrid);
  const delta = firstManualRow(newFileGrid) - oldFirst;
  if (delta === 0) return;
  await remapCapitalRows(tx, filingId, (row) =>
    row >= oldFirst && row < oldFirst + count ? row + delta : row,
  );
}

const UPLOAD_SELECT = {
  kind: true,
  fileName: true,
  fileSize: true,
  updatedAt: true,
  grid: true,
} as const;

/**
 * Adds an invoice typed in by hand, or replaces one (by its position in the
 * typed list). Typed invoices sit beside the uploaded file; both count.
 */
export async function saveSalesTaxManualInvoiceAction(input: {
  filingId: string;
  kind: UploadKind;
  /** Position of the invoice to replace; leave out to add a new one. */
  index?: number | null;
  invoice: unknown;
}) {
  try {
    const userId = await getCurrentUserId();
    if (!isUploadKind(input.kind)) {
      return {
        success: false as const,
        error: "Choose whether this is a sales or a purchase invoice.",
      };
    }
    const kind = input.kind;
    const filing = await prisma.salesTaxFiling.findFirst({
      where: { id: String(input.filingId ?? ""), userId, authority: "FBR" },
      select: {
        id: true,
        status: true,
        periodYear: true,
        periodMonth: true,
        business: true,
      },
    });
    if (!filing)
      return { success: false as const, error: "This month was not found." };
    if (filing.status !== STATUS_DRAFT) {
      return {
        success: false as const,
        error: "Invoices can only be changed while the month is a draft.",
      };
    }
    const profile = filing.business;
    if (!profile) {
      return {
        success: false as const,
        error: "Save your business details first, then add your invoices.",
      };
    }
    const period = { year: filing.periodYear, month: filing.periodMonth };
    const checked = validateManualInvoice(kind, input.invoice, period);
    if (checked.ok === false)
      return { success: false as const, error: checked.error };

    const outcome = await prisma.$transaction(async (tx) => {
      // Two saves at once must not overwrite each other's list.
      await tx.$queryRaw`SELECT id FROM "SalesTaxFiling" WHERE id = ${filing.id} FOR UPDATE`;
      const stored = await tx.salesTaxUpload.findUnique({
        where: {
          filingId_kind: { filingId: filing.id, kind: MANUAL_KIND[kind] },
        },
      });
      const entries = stored ? parseStoredManual(stored.grid) : [];
      if (input.index === null || input.index === undefined) {
        if (entries.length >= MAX_MANUAL_INVOICES) {
          return {
            ok: false as const,
            error: `You can type in up to ${MAX_MANUAL_INVOICES} invoices a month. Use the Excel template for more.`,
          };
        }
        entries.push(checked.value);
      } else {
        const position = Number(input.index);
        if (
          !Number.isInteger(position) ||
          position < 0 ||
          position >= entries.length
        ) {
          return {
            ok: false as const,
            error:
              "This invoice was not found. Refresh the page and try again.",
          };
        }
        entries[position] = checked.value;
      }
      const data = {
        fileName: "Entered by hand",
        fileSize: 0,
        rowCount: entries.length,
        grid: entries as unknown as Prisma.InputJsonValue,
      };
      await tx.salesTaxUpload.upsert({
        where: {
          filingId_kind: { filingId: filing.id, kind: MANUAL_KIND[kind] },
        },
        update: data,
        create: { filingId: filing.id, kind: MANUAL_KIND[kind], ...data },
      });
      return { ok: true as const };
    });
    if (outcome.ok === false)
      return { success: false as const, error: outcome.error };
    revalidatePath(`/tax/sales-tax/${filing.id}`);

    const uploads = await prisma.salesTaxUpload.findMany({
      where: { filingId: filing.id },
      select: UPLOAD_SELECT,
    });
    return {
      success: true as const,
      invoices: buildInvoiceState(period, profile.registrationNo, uploads),
    };
  } catch (error) {
    console.error("Error saving a typed sales tax invoice:", error);
    return {
      success: false as const,
      error: "Could not save this invoice. Please try again.",
    };
  }
}

/** Removes one typed invoice (by its position in the typed list). */
export async function removeSalesTaxManualInvoiceAction(
  filingId: string,
  kind: UploadKind,
  index: number,
) {
  try {
    const userId = await getCurrentUserId();
    if (!isUploadKind(kind)) {
      return {
        success: false as const,
        error: "Choose whether this is a sales or a purchase invoice.",
      };
    }
    const filing = await prisma.salesTaxFiling.findFirst({
      where: { id: String(filingId ?? ""), userId, authority: "FBR" },
      select: {
        id: true,
        status: true,
        periodYear: true,
        periodMonth: true,
        business: true,
      },
    });
    if (!filing)
      return { success: false as const, error: "This month was not found." };
    if (filing.status !== STATUS_DRAFT) {
      return {
        success: false as const,
        error: "Invoices can only be changed while the month is a draft.",
      };
    }

    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SalesTaxFiling" WHERE id = ${filing.id} FOR UPDATE`;
      const stored = await tx.salesTaxUpload.findUnique({
        where: {
          filingId_kind: { filingId: filing.id, kind: MANUAL_KIND[kind] },
        },
      });
      const entries = stored ? parseStoredManual(stored.grid) : [];
      const position = Number(index);
      if (
        !Number.isInteger(position) ||
        position < 0 ||
        position >= entries.length
      ) {
        return { ok: false as const };
      }
      entries.splice(position, 1);
      if (kind === "PURCHASES") {
        const file = await tx.salesTaxUpload.findUnique({
          where: { filingId_kind: { filingId: filing.id, kind } },
          select: { grid: true },
        });
        const removedRow =
          firstManualRow(file ? (file.grid as CellGrid) : null) + position;
        await remapCapitalRows(tx, filing.id, (row) =>
          row === removedRow ? null : row > removedRow ? row - 1 : row,
        );
      }
      if (entries.length === 0) {
        await tx.salesTaxUpload.deleteMany({
          where: { filingId: filing.id, kind: MANUAL_KIND[kind] },
        });
      } else {
        await tx.salesTaxUpload.update({
          where: {
            filingId_kind: { filingId: filing.id, kind: MANUAL_KIND[kind] },
          },
          data: {
            rowCount: entries.length,
            grid: entries as unknown as Prisma.InputJsonValue,
          },
        });
      }
      return { ok: true as const };
    });
    if (outcome.ok === false) {
      return {
        success: false as const,
        error: "This invoice was not found. Refresh the page and try again.",
      };
    }
    revalidatePath(`/tax/sales-tax/${filing.id}`);

    const uploads = await prisma.salesTaxUpload.findMany({
      where: { filingId: filing.id },
      select: UPLOAD_SELECT,
    });
    return {
      success: true as const,
      invoices: buildInvoiceState(
        { year: filing.periodYear, month: filing.periodMonth },
        filing.business?.registrationNo ?? "",
        uploads,
      ),
    };
  } catch (error) {
    console.error("Error removing a typed sales tax invoice:", error);
    return {
      success: false as const,
      error: "Could not remove this invoice. Please try again.",
    };
  }
}

/** Loads one of the user's months with its files and the business profile. */
async function loadMonthForReview(userId: string, filingId: string) {
  const filing = await prisma.salesTaxFiling.findFirst({
    where: { id: String(filingId ?? ""), userId, authority: "FBR" },
    include: {
      business: true,
      uploads: {
        select: {
          kind: true,
          fileName: true,
          fileSize: true,
          updatedAt: true,
          grid: true,
        },
      },
    },
  });
  return { filing, profile: filing?.business ?? null };
}

/**
 * Saves the figures that are not in the invoice files and returns the fresh
 * estimate. Invalid figures are refused and nothing is stored.
 */
export async function saveSalesTaxFiguresAction(
  filingId: string,
  form: unknown,
) {
  try {
    const userId = await getCurrentUserId();
    const { filing, profile } = await loadMonthForReview(userId, filingId);
    if (!filing)
      return { success: false as const, error: "This month was not found." };
    if (filing.status !== STATUS_DRAFT) {
      return {
        success: false as const,
        error: "Figures can only be changed while the month is a draft.",
      };
    }
    if (!profile) {
      return {
        success: false as const,
        error: "Save your business details first.",
      };
    }
    const checked = validateFiguresForm(form);
    if (checked.ok === false)
      return { success: false as const, error: checked.error };

    const purchaseGrid = gridsOf(
      { year: filing.periodYear, month: filing.periodMonth },
      profile.registrationNo,
      filing.uploads,
    ).purchases.grid;
    const capitalProblem = checkCapitalRows(
      purchaseGrid,
      checked.value.capitalGoodsRows,
    );
    if (capitalProblem)
      return { success: false as const, error: capitalProblem };

    await prisma.salesTaxFiling.update({
      where: { id: filing.id },
      data: { figures: checked.value as unknown as Prisma.InputJsonValue },
    });
    revalidatePath(`/tax/sales-tax/${filing.id}`);

    const { review } = computeReview(
      filing,
      checked.value,
      profile.registrationNo,
    );
    return { success: true as const, review };
  } catch (error) {
    console.error("Error saving the sales tax figures:", error);
    return {
      success: false as const,
      error: "Could not save your figures. Please try again.",
    };
  }
}

/**
 * Approves the estimate the user has just reviewed. The estimate is worked
 * out again here, so only what the server computes can be approved. Nothing
 * is sent to FBR.
 */
export async function approveSalesTaxReturnAction(
  filingId: string,
  confirmed: boolean,
) {
  try {
    if (confirmed !== true) {
      return {
        success: false as const,
        error: "Tick the box to confirm that you have reviewed the return.",
      };
    }
    const userId = await getCurrentUserId();
    const { filing, profile } = await loadMonthForReview(userId, filingId);
    if (!filing)
      return { success: false as const, error: "This month was not found." };
    if (filing.status !== STATUS_DRAFT) {
      return {
        success: false as const,
        error: "Only a draft return can be approved.",
      };
    }
    if (!profile) {
      return {
        success: false as const,
        error: "Save your business details first.",
      };
    }
    const figures = parseStoredFigures(filing.figures);
    const now = computeReview(filing, figures, profile.registrationNo);
    const built = buildApprovalPacket({
      approvedAt: new Date(),
      authority: filing.authority,
      period: now.period,
      businessName: profile.businessName,
      registrationNo: profile.registrationNo,
      figures,
      files: now.files,
      result: now.result,
    });
    if (built.ok === false)
      return { success: false as const, error: built.error };

    const updated = await prisma.salesTaxFiling.update({
      where: { id: filing.id },
      data: {
        approvedAt: new Date(built.packet.approvedAt),
        approvedPacket: built.packet as unknown as Prisma.InputJsonValue,
      },
    });
    revalidatePath(`/tax/sales-tax/${filing.id}`);

    const { review } = computeReview(
      {
        ...filing,
        approvedAt: updated.approvedAt,
        approvedPacket: updated.approvedPacket,
      },
      figures,
      profile.registrationNo,
    );
    return { success: true as const, review };
  } catch (error) {
    console.error("Error approving the sales tax return:", error);
    return {
      success: false as const,
      error: "Could not approve this return. Please try again.",
    };
  }
}
