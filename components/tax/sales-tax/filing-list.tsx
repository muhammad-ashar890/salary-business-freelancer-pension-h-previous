"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, Plus, Trash2 } from "lucide-react";

import {
  deleteSalesTaxBusinessAction,
  deleteSalesTaxMonthAction,
  type SalesTaxBusiness,
  type SalesTaxFilingSummary,
} from "@/app/actions/sales-tax";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatPeriod, getAuthorityName } from "@/lib/sales-tax/profile";

import { formatIsoDate, statusLabel } from "./format";

export function SalesTaxFilingList({
  businesses,
  filings,
}: {
  businesses: SalesTaxBusiness[];
  filings: SalesTaxFilingSummary[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this draft month? Nothing has been filed."))
      return;
    setBusyId(id);
    setError(null);
    try {
      const result = await deleteSalesTaxMonthAction(id);
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    } catch {
      setError("Could not delete this month. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDeleteBusiness(business: SalesTaxBusiness) {
    if (!window.confirm(`Remove ${business.businessName}? It has no returns.`))
      return;
    setBusyId(business.id);
    setError(null);
    try {
      const result = await deleteSalesTaxBusinessAction(business.id);
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    } catch {
      setError("Could not remove this business. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  if (businesses.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <p className="font-medium text-foreground">No returns started yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose &ldquo;New sales tax return&rdquo; to start your first one.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {businesses.map((business) => {
        const own = filings.filter(
          (filing) => filing.businessId === business.id,
        );
        return (
          <section
            key={business.id}
            aria-label={business.businessName}
            data-testid="business-section"
            className="space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-semibold text-foreground">
                  {business.businessName}
                </h3>
                <p className="text-xs text-muted-foreground">
                  STRN {business.registrationNo}
                </p>
              </div>
              <div className="flex gap-2">
                <Button asChild size="sm" variant="outline" className="gap-1.5">
                  <Link href={`/tax/sales-tax/new?business=${business.id}`}>
                    <Plus className="h-3.5 w-3.5" />
                    New return
                  </Link>
                </Button>
                {own.length === 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 text-red-700"
                    disabled={busyId === business.id}
                    onClick={() => handleDeleteBusiness(business)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove business
                  </Button>
                )}
              </div>
            </div>
            {own.length === 0 && (
              <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                No returns for this business yet.
              </p>
            )}
            {own.map((filing) => (
              <article
                key={filing.id}
                className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="font-semibold text-foreground">
                      {formatPeriod({
                        year: filing.periodYear,
                        month: filing.periodMonth,
                      })}
                    </h4>
                    <Badge variant="outline">
                      {getAuthorityName(filing.authority)}
                    </Badge>
                    <Badge variant="outline" className="text-muted-foreground">
                      {statusLabel(filing.status)}
                    </Badge>
                    {filing.approval === "current" && (
                      <Badge
                        variant="outline"
                        className="border-emerald-300 bg-emerald-50 text-emerald-800"
                      >
                        Approved
                      </Badge>
                    )}
                    {filing.approval === "stale" && (
                      <Badge
                        variant="outline"
                        className="border-amber-300 bg-amber-50 text-amber-800"
                      >
                        Changed after approval
                      </Badge>
                    )}
                  </div>
                  {filing.dueDates && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Payment due {formatIsoDate(filing.dueDates.payment)} ·
                      Return due {formatIsoDate(filing.dueDates.returnFiling)}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    asChild
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                  >
                    <Link href={`/tax/sales-tax/${filing.id}`}>
                      <ExternalLink className="h-3.5 w-3.5" />
                      Open
                    </Link>
                  </Button>
                  {filing.status === "DRAFT" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1.5 text-red-700"
                      disabled={busyId === filing.id}
                      onClick={() => handleDelete(filing.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </section>
        );
      })}
    </div>
  );
}
