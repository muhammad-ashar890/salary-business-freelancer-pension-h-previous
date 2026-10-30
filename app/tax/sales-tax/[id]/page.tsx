import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getServerSession } from "next-auth/next";

import { getSalesTaxFilingAction } from "@/app/actions/sales-tax";
import { getSrbFilingAction } from "@/app/actions/sales-tax-srb";
import { SalesTaxWizard } from "@/components/tax/sales-tax/sales-tax-wizard";
import { SrbFlow } from "@/components/tax/sales-tax/srb/srb-flow";
import { formatPeriod } from "@/lib/sales-tax/profile";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SalesTaxMonthPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) redirect("/login");

  const result = await getSalesTaxFilingAction(params.id);

  // A Sindh services month has its own steps.
  if (!result.success) {
    const srb = await getSrbFilingAction(params.id);
    if (srb.success) {
      return (
        <div className="mx-auto max-w-6xl">
          <SrbFlow
            data={srb.data}
            title={`Sales tax return · ${formatPeriod({ year: srb.data.filing.periodYear, month: srb.data.filing.periodMonth })}`}
          />
        </div>
      );
    }
  }

  if (!result.success) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <Link
          href="/tax/sales-tax"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Sales Tax
        </Link>
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {result.error}
        </p>
      </div>
    );
  }

  const now = new Date();
  return (
    <div className="mx-auto max-w-6xl">
      <SalesTaxWizard
        savedBusiness={{
          ...result.profile,
          authorities: [
            ,
            result.filing.authority,
          ] as typeof result.profile.authorities,
        }}
        currentYear={now.getFullYear()}
        currentMonth={now.getMonth() + 1}
        existing={{
          filingId: result.filing.id,
          businessId: result.profile.id,
          authority: result.filing.authority,
          year: result.filing.periodYear,
          month: result.filing.periodMonth,
          dueDates: result.filing.dueDates,
          invoices: result.invoices,
          review: result.review,
        }}
      />
    </div>
  );
}
