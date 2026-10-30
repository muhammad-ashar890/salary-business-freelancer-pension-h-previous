import { redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";

import { getSalesTaxOverviewAction } from "@/app/actions/sales-tax";
import { SalesTaxWizard } from "@/components/tax/sales-tax/sales-tax-wizard";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function NewSalesTaxReturnPage({
  searchParams,
}: {
  searchParams?: { business?: string | string[] };
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) redirect("/login");

  const overview = await getSalesTaxOverviewAction();
  const now = new Date();
  // Step 1 starts from the business whose "New return" button was used,
  // otherwise from the one added last. Typing another number there is
  // another business.
  const asked =
    typeof searchParams?.business === "string" ? searchParams.business : null;
  const businesses = overview.businesses;
  const startBusiness =
    businesses.find((item) => item.id === asked) ??
    businesses[businesses.length - 1] ??
    null;

  return (
    <div className="mx-auto max-w-6xl">
      {!overview.success && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {overview.error}
        </p>
      )}
      <SalesTaxWizard
        savedBusiness={startBusiness}
        currentYear={now.getFullYear()}
        currentMonth={now.getMonth() + 1}
      />
    </div>
  );
}
