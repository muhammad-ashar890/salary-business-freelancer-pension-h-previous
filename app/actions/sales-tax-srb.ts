"use server";

import { getServerSession } from "next-auth/next";
import { revalidatePath } from "next/cache";

import type { Prisma } from "@prisma/client";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  buildSrbApprovalPacket,
  buildSrbMonthState,
  checkPurchase,
  checkSale,
  computeSrbReturn,
  isSrbEntryKind,
  MAX_SRB_ENTRIES,
  parseStoredSrbEntries,
  SRB_UPLOAD_KIND,
  validateSrbFiguresForm,
  parseStoredSrbFigures,
  type SrbEntryKind,
  type SrbMonthState,
  type SrbPurchaseEntry,
  type SrbSaleEntry,
} from "@/lib/sales-tax/srb";
import { todayInPakistan } from "@/lib/sales-tax/dates";
import { parseStoredAuthorities } from "@/lib/sales-tax/profile";

// The Sindh services (SRB) return keeps its lines in SalesTaxUpload rows of
// kind SRB_SALES and SRB_PURCHASES (the grid column holds the lines) and its
// figures in SalesTaxFiling.figures. The FBR actions never see these months.

const STATUS_DRAFT = "DRAFT";

async function getCurrentUserId() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) throw new Error("Unauthorized");
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: session.user?.name ?? null, image: session.user?.image ?? null },
    select: { id: true },
  });
  return user.id;
}

const SELECT_MONTH = {
  id: true,
  status: true,
  periodYear: true,
  periodMonth: true,
  figures: true,
  approvedAt: true,
  approvedPacket: true,
  authority: true,
  business: true,
  uploads: { select: { kind: true, grid: true } },
} as const;

async function loadSrbMonth(userId: string, filingId: string) {
  return prisma.salesTaxFiling.findFirst({
    where: { id: String(filingId ?? ""), userId, authority: "SRB" },
    select: SELECT_MONTH,
  });
}

type LoadedMonth = NonNullable<Awaited<ReturnType<typeof loadSrbMonth>>>;

function stateOf(filing: LoadedMonth, overrides: Partial<Pick<LoadedMonth, "figures" | "approvedAt" | "approvedPacket" | "uploads">> = {}): SrbMonthState {
  const merged = { ...filing, ...overrides };
  return buildSrbMonthState({
    period: { year: merged.periodYear, month: merged.periodMonth },
    businessName: merged.business.businessName,
    registrationNo: merged.business.registrationNo,
    uploads: merged.uploads,
    figures: merged.figures,
    approvedAt: merged.approvedAt,
    approvedPacket: merged.approvedPacket,
    today: todayInPakistan(),
  });
}

export type SrbFilingData = {
  filing: {
    id: string;
    businessId: string;
    authority: "SRB";
    periodYear: number;
    periodMonth: number;
    status: string;
  };
  profile: { id: string; businessName: string; registrationNo: string; authorities: string[] };
  state: SrbMonthState;
};

export async function getSrbFilingAction(filingId: string) {
  try {
    const userId = await getCurrentUserId();
    const filing = await loadSrbMonth(userId, filingId);
    if (!filing) return { success: false as const, error: "This month was not found." };
    const data: SrbFilingData = {
      filing: {
        id: filing.id,
        businessId: filing.business.id,
        authority: "SRB",
        periodYear: filing.periodYear,
        periodMonth: filing.periodMonth,
        status: filing.status,
      },
      profile: {
        id: filing.business.id,
        businessName: filing.business.businessName,
        registrationNo: filing.business.registrationNo,
        authorities: parseStoredAuthorities(filing.business.authorities),
      },
      state: stateOf(filing),
    };
    return { success: true as const, data };
  } catch (error) {
    console.error("Error loading the SRB month:", error);
    return { success: false as const, error: "Could not load this month. Please try again." };
  }
}

/**
 * Saves one line (adds it, or replaces the line with `entryId`). A line that
 * fails its checks is refused with the plain-English reason for each field, and
 * nothing is stored.
 */
export async function saveSrbEntryAction(input: {
  filingId: string;
  kind: SrbEntryKind;
  entryId?: string | null;
  raw: unknown;
}) {
  try {
    const userId = await getCurrentUserId();
    if (!isSrbEntryKind(input.kind)) {
      return { success: false as const, error: "Choose whether this is a sale or a purchase.", fieldErrors: {} as Record<string, string> };
    }
    const kind = input.kind;
    const filing = await loadSrbMonth(userId, input.filingId);
    if (!filing) return { success: false as const, error: "This month was not found.", fieldErrors: {} as Record<string, string> };
    if (filing.status !== STATUS_DRAFT) {
      return { success: false as const, error: "Lines can only be changed while the month is a draft.", fieldErrors: {} as Record<string, string> };
    }
    const period = { year: filing.periodYear, month: filing.periodMonth };
    const raw = (input.raw && typeof input.raw === "object" ? input.raw : {}) as Record<string, unknown>;
    const editing = input.entryId ? String(input.entryId) : undefined;

    const checked =
      kind === "SALES"
        ? checkSale(raw, period, { id: editing, origin: "typed" })
        : checkPurchase(raw, period, { id: editing, origin: "typed" });
    if (checked.ok === false) {
      return { success: false as const, error: checked.first, fieldErrors: checked.errors };
    }

    const outcome = await prisma.$transaction(async (tx) => {
      // Two saves at once must not overwrite each other's list.
      await tx.$queryRaw`SELECT id FROM "SalesTaxFiling" WHERE id = ${filing.id} FOR UPDATE`;
      const stored = await tx.salesTaxUpload.findUnique({
        where: { filingId_kind: { filingId: filing.id, kind: SRB_UPLOAD_KIND[kind] } },
      });
      const entries = parseStoredSrbEntries<{ id: string }>(stored?.grid);
      if (editing) {
        const position = entries.findIndex((entry) => entry.id === editing);
        if (position < 0) {
          return { ok: false as const, error: "This line was not found. Refresh the page and try again." };
        }
        entries[position] = checked.entry;
      } else {
        if (entries.length >= MAX_SRB_ENTRIES) {
          return { ok: false as const, error: `You can enter up to ${MAX_SRB_ENTRIES} lines a month here.` };
        }
        entries.push(checked.entry);
      }
      const data = {
        fileName: "Entered by hand",
        fileSize: 0,
        rowCount: entries.length,
        grid: entries as unknown as Prisma.InputJsonValue,
      };
      const row = await tx.salesTaxUpload.upsert({
        where: { filingId_kind: { filingId: filing.id, kind: SRB_UPLOAD_KIND[kind] } },
        update: data,
        create: { filingId: filing.id, kind: SRB_UPLOAD_KIND[kind], ...data },
        select: { kind: true, grid: true },
      });
      return { ok: true as const, row };
    });
    if (outcome.ok === false) {
      return { success: false as const, error: outcome.error, fieldErrors: {} as Record<string, string> };
    }
    revalidatePath(`/tax/sales-tax/${filing.id}`);
    const uploads = [...filing.uploads.filter((row) => row.kind !== outcome.row.kind), outcome.row];
    return { success: true as const, state: stateOf(filing, { uploads }) };
  } catch (error) {
    console.error("Error saving an SRB line:", error);
    return { success: false as const, error: "Could not save this line. Please try again.", fieldErrors: {} as Record<string, string> };
  }
}

export async function removeSrbEntryAction(filingId: string, kind: SrbEntryKind, entryId: string) {
  try {
    const userId = await getCurrentUserId();
    if (!isSrbEntryKind(kind)) {
      return { success: false as const, error: "Choose whether this is a sale or a purchase." };
    }
    const filing = await loadSrbMonth(userId, filingId);
    if (!filing) return { success: false as const, error: "This month was not found." };
    if (filing.status !== STATUS_DRAFT) {
      return { success: false as const, error: "Lines can only be changed while the month is a draft." };
    }
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SalesTaxFiling" WHERE id = ${filing.id} FOR UPDATE`;
      const stored = await tx.salesTaxUpload.findUnique({
        where: { filingId_kind: { filingId: filing.id, kind: SRB_UPLOAD_KIND[kind] } },
      });
      const entries = parseStoredSrbEntries<{ id: string }>(stored?.grid);
      const position = entries.findIndex((entry) => entry.id === String(entryId));
      if (position < 0) return { ok: false as const };
      entries.splice(position, 1);
      if (entries.length === 0) {
        await tx.salesTaxUpload.deleteMany({ where: { filingId: filing.id, kind: SRB_UPLOAD_KIND[kind] } });
        return { ok: true as const, row: null };
      }
      const row = await tx.salesTaxUpload.update({
        where: { filingId_kind: { filingId: filing.id, kind: SRB_UPLOAD_KIND[kind] } },
        data: { rowCount: entries.length, grid: entries as unknown as Prisma.InputJsonValue },
        select: { kind: true, grid: true },
      });
      return { ok: true as const, row };
    });
    if (outcome.ok === false) {
      return { success: false as const, error: "This line was not found. Refresh the page and try again." };
    }
    revalidatePath(`/tax/sales-tax/${filing.id}`);
    const others = filing.uploads.filter((row) => row.kind !== SRB_UPLOAD_KIND[kind]);
    const uploads = outcome.row ? [...others, outcome.row] : others;
    return { success: true as const, state: stateOf(filing, { uploads }) };
  } catch (error) {
    console.error("Error removing an SRB line:", error);
    return { success: false as const, error: "Could not remove this line. Please try again." };
  }
}

/** Saves the figures that are not on any line. Invalid figures are refused and nothing is stored. */
export async function saveSrbFiguresAction(filingId: string, form: unknown) {
  try {
    const userId = await getCurrentUserId();
    const filing = await loadSrbMonth(userId, filingId);
    if (!filing) return { success: false as const, error: "This month was not found." };
    if (filing.status !== STATUS_DRAFT) {
      return { success: false as const, error: "Figures can only be changed while the month is a draft." };
    }
    const checked = validateSrbFiguresForm(form, { year: filing.periodYear, month: filing.periodMonth });
    if (checked.ok === false) return { success: false as const, error: checked.error };
    await prisma.salesTaxFiling.update({
      where: { id: filing.id },
      data: { figures: checked.value as unknown as Prisma.InputJsonValue },
    });
    revalidatePath(`/tax/sales-tax/${filing.id}`);
    return { success: true as const, state: stateOf(filing, { figures: checked.value as unknown as Prisma.JsonValue }) };
  } catch (error) {
    console.error("Error saving the SRB figures:", error);
    return { success: false as const, error: "Could not save your figures. Please try again." };
  }
}

/**
 * Approves the estimate the user has just reviewed. It is worked out again
 * here, so only what the server computes can be approved. Nothing is sent to
 * SRB.
 */
export async function approveSrbReturnAction(filingId: string, confirmed: boolean) {
  try {
    if (confirmed !== true) {
      return { success: false as const, error: "Tick the box to confirm that you have reviewed the return." };
    }
    const userId = await getCurrentUserId();
    const filing = await loadSrbMonth(userId, filingId);
    if (!filing) return { success: false as const, error: "This month was not found." };
    if (filing.status !== STATUS_DRAFT) {
      return { success: false as const, error: "Only a draft return can be approved." };
    }
    const period = { year: filing.periodYear, month: filing.periodMonth };
    const gridOf = (kind: SrbEntryKind) => filing.uploads.find((row) => row.kind === SRB_UPLOAD_KIND[kind])?.grid;
    const sales = parseStoredSrbEntries<SrbSaleEntry>(gridOf("SALES"));
    const purchases = parseStoredSrbEntries<SrbPurchaseEntry>(gridOf("PURCHASES"));
    const figures = parseStoredSrbFigures(filing.figures);
    const result = computeSrbReturn({ period, sales, purchases, figures, today: todayInPakistan() });
    const built = buildSrbApprovalPacket({
      approvedAt: new Date(),
      period,
      businessName: filing.business.businessName,
      registrationNo: filing.business.registrationNo,
      figures,
      sales,
      purchases,
      result,
    });
    if (built.ok === false) return { success: false as const, error: built.error };

    const updated = await prisma.salesTaxFiling.update({
      where: { id: filing.id },
      data: {
        approvedAt: new Date(built.packet.approvedAt),
        approvedPacket: built.packet as unknown as Prisma.InputJsonValue,
      },
      select: { approvedAt: true, approvedPacket: true },
    });
    revalidatePath(`/tax/sales-tax/${filing.id}`);
    return { success: true as const, state: stateOf(filing, updated) };
  } catch (error) {
    console.error("Error approving the SRB return:", error);
    return { success: false as const, error: "Could not approve this return. Please try again." };
  }
}
