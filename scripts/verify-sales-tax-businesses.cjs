/**
 * Businesses of one owner (Sales Tax).
 *
 *   1. The REAL server actions against a REAL PostgreSQL database (skipped
 *      cleanly when none is reachable): a registration number is one
 *      business, a different number is another business with its own returns,
 *      the same month can exist for two businesses, the checks use the right
 *      business's number, nothing leaks between businesses or users, removing
 *      a business that has no returns.
 *   2. Source facts: step 1 is a plain form (no cards, no add-another flow), a
 *      business is chosen by its own "New return" button or by typing its
 *      number, and the migration moves existing returns to their business.
 *
 * All data is synthetic.
 */

const path = require("path");
const fs = require("fs");
const Module = require("module");
const ExcelJS = require("exceljs");

const kit = require("./lib/sales-tax-test-kit.cjs");
const { check, finish } = kit.createChecker("verify-sales-tax-businesses");
const root = kit.projectRoot;
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

let sessionEmail = null;
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "next/cache") return { revalidatePath() {} };
  if (request === "next-auth/next") {
    return {
      getServerSession: async () =>
        sessionEmail ? { user: { email: sessionEmail, name: "Test" } } : null,
    };
  }
  if (request === "server-only") return {};
  if (request === "@/lib/auth" || request === path.join(root, "lib/auth")) {
    return { authOptions: {} };
  }
  return originalLoad.call(this, request, ...rest);
};

const august = require(
  path.join(root, "test-fixtures/sales-tax/month-2026-08.json"),
);

async function gridToWorkbook(grid) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("SALES_INVOICES");
  grid.forEach((row, i) =>
    row.forEach((value, j) => {
      if (value === "" || value == null) return;
      ws.getCell(i + 1, j + 1).value =
        typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
          ? new Date(`${value}T00:00:00Z`)
          : value;
    }),
  );
  for (const range of [
    "A4:A5",
    "B4:D4",
    "E4:E5",
    "F4:F5",
    "G4:J4",
    "K4:K5",
    "L4:L5",
    "W4:X4",
  ])
    ws.mergeCells(range);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

function runSourceChecks() {
  const schema = read("prisma/schema.prisma");
  const actions = read("app/actions/sales-tax.ts");
  const wizard = read("components/tax/sales-tax/sales-tax-wizard.tsx");
  const list = read("components/tax/sales-tax/filing-list.tsx");
  const migrations = fs.readdirSync(path.join(root, "prisma/migrations"));
  const migration = migrations.find((name) =>
    /several_sales_tax_businesses/.test(name),
  );
  const sql = migration
    ? read(`prisma/migrations/${migration}/migration.sql`)
    : "";

  check("a migration for several businesses exists", Boolean(migration), true);
  check(
    "the migration gives existing returns the business of their user",
    /UPDATE "SalesTaxFiling"[\s\S]*SET "businessId" = p\."id"[\s\S]*WHERE p\."userId" = f\."userId"/.test(
      sql,
    ),
    true,
  );
  check(
    "the migration fills the business before it becomes required",
    sql.indexOf('SET "businessId"') < sql.indexOf("SET NOT NULL"),
    true,
  );
  check(
    "the migration drops the one-profile-per-user key",
    /DROP INDEX "SalesTaxProfile_userId_key"/.test(sql),
    true,
  );
  check(
    "the migration makes a registration number one business per user",
    /CREATE UNIQUE INDEX "SalesTaxProfile_userId_registrationNo_key"/.test(sql),
    true,
  );
  check(
    "the migration makes a month unique per business",
    /CREATE UNIQUE INDEX "SalesTaxFiling_businessId_authority_periodYear_periodMonth_key"/.test(
      sql,
    ),
    true,
  );
  check(
    "a return is removed with its business",
    /"SalesTaxFiling_businessId_fkey"[\s\S]*ON DELETE CASCADE/.test(sql),
    true,
  );
  check(
    "the schema says a return belongs to a business",
    /model SalesTaxFiling \{[\s\S]*businessId String[\s\S]*business\s+SalesTaxProfile/.test(
      schema,
    ),
    true,
  );
  const wizardCode = wizard
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  const newPage = read("app/tax/sales-tax/new/page.tsx");
  check(
    "a month is unique per business, authority and month",
    /@@unique\(\[businessId, authority, periodYear, periodMonth\]\)/.test(
      schema,
    ),
    true,
  );
  check(
    "step 1 is a plain form without cards or an add-another flow",
    !/Add another business/.test(wizard) &&
      !/Save this business/.test(wizard) &&
      !/handleAddBusiness/.test(wizard) &&
      !/chooseBusiness/.test(wizard) &&
      !/businessList/.test(wizard) &&
      !/Which business is this return for/.test(wizard),
    true,
  );
  check(
    "step 1 keeps the name and number fields",
    /Business name/.test(wizard) &&
      /Sales tax registration number \(STRN\)/.test(wizard),
    true,
  );
  check(
    "step 1 starts from the business it is given",
    /savedBusiness = null/.test(wizard) &&
      /const startBusiness = savedBusiness;/.test(wizard),
    true,
  );
  check(
    "the saved business is changed only while its number stays the same",
    /startBusiness !== null &&\s*digitsOnly\(startBusiness\.registrationNo\) ===\s*digitsOnly\(business\.value\.registrationNo\)/.test(
      wizardCode,
    ) &&
      /businessId: sameBusiness \? startBusiness\.id : null/.test(wizardCode),
    true,
  );
  check(
    "the wizard sends the business when it starts a month",
    /startSalesTaxMonthAction\(\{\s*businessId: saved\.businessId/.test(
      wizardCode,
    ),
    true,
  );
  check(
    "the new-return page starts from the chosen business, else the last one",
    /searchParams\?\.business/.test(newPage) &&
      /item\.id === asked\) \?\?\s*businesses\[businesses\.length - 1\]/.test(
        newPage,
      ) &&
      /savedBusiness=\{startBusiness\}/.test(newPage),
    true,
  );
  check(
    "the list groups returns by business",
    /businesses\.map\(\(business\)/.test(list) &&
      /filing\.businessId === business\.id/.test(list),
    true,
  );
  check(
    "each business has its own new-return button",
    /\/tax\/sales-tax\/new\?business=\$\{business\.id\}/.test(list),
    true,
  );
  check(
    "a business with returns has no remove button",
    /own\.length === 0 && \(/.test(list) &&
      /deleteSalesTaxBusinessAction/.test(list),
    true,
  );
  check(
    "the same number opens the same business",
    /target = sameNumber;/.test(actions) &&
      /digitsOf\(row\.registrationNo\) === digitsOf\(registrationNo\)/.test(
        actions,
      ),
    true,
  );
  check(
    "a month for two businesses needs a choice",
    /Choose which business this return is for\./.test(actions),
    true,
  );
  check(
    "every month action finds the business through the month",
    !/salesTaxProfile\.findUnique\(\{ where: \{ userId \} \}\)/.test(actions),
    true,
  );
  check(
    "the module still never touches income-tax drafts",
    /FilingDraft/.test(
      actions
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n"),
    ),
    false,
  );
}

async function runDatabaseChecks() {
  let PrismaClient;
  try {
    ({ PrismaClient } = require("@prisma/client"));
  } catch {
    console.log(
      "Sales tax business checks skipped: Prisma client is not generated.",
    );
    return;
  }
  const probe = new PrismaClient();
  try {
    await probe.$queryRawUnsafe("SELECT 1");
  } catch {
    await probe.$disconnect().catch(() => {});
    console.log("Sales tax business checks skipped (no database reachable).");
    return;
  }
  const columns = await probe.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'SalesTaxFiling' AND column_name = 'businessId'`,
  );
  await probe.$disconnect();
  if (columns.length !== 1) {
    check(
      "the database has SalesTaxFiling.businessId: run `npx prisma migrate deploy`",
      columns.length,
      1,
    );
    return;
  }

  const { prisma } = kit.load("lib/prisma.ts");
  const actions = kit.load("app/actions/sales-tax.ts");
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const emails = [];
  const newEmail = (tag) => {
    const email = `sales-tax-biz-${tag}-${suffix}@example.invalid`;
    emails.push(email);
    return email;
  };
  const upload = (filingId, kind, bytes, name) => {
    const data = new FormData();
    data.set("filingId", filingId);
    data.set("kind", kind);
    data.set(
      "file",
      new File([bytes], name, { type: "application/octet-stream" }),
    );
    return actions.uploadSalesTaxInvoicesAction(data);
  };
  const acme = {
    businessName: "Acme Traders",
    registrationNo: august.registrationNo,
    authorities: ["FBR"],
  };
  const bolan = {
    businessName: "Bolan Foods",
    registrationNo: "7654321",
    authorities: ["FBR"],
  };
  const overview = async () => actions.getSalesTaxOverviewAction();
  try {
    sessionEmail = newEmail("owner");

    // Adding businesses.
    const first = await actions.saveSalesTaxProfileAction(acme);
    check(
      "the first business is saved and its id comes back",
      [first.success, typeof first.businessId],
      [true, "string"],
    );
    const second = await actions.saveSalesTaxProfileAction(bolan);
    check(
      "a different registration number is a second business",
      [second.success, second.businessId !== first.businessId],
      [true, true],
    );
    check(
      "both businesses are listed, oldest first",
      (await overview()).businesses.map((b) => b.businessName),
      ["Acme Traders", "Bolan Foods"],
    );

    // One registration number is one business.
    const typedAgain = await actions.saveSalesTaxProfileAction({
      ...acme,
      registrationNo: ` ${august.registrationNo.slice(0, 4)}-${august.registrationNo.slice(4)} `,
      businessName: "Acme Traders Ltd",
    });
    check(
      "the same number typed with dashes opens the same business",
      [typedAgain.success, typedAgain.businessId],
      [true, first.businessId],
    );
    check(
      "it did not become a third business",
      (await overview()).businesses.length,
      2,
    );
    check(
      "its name was updated",
      (await overview()).businesses.find((b) => b.id === first.businessId)
        .businessName,
      "Acme Traders Ltd",
    );

    // Changing a saved business.
    const clash = await actions.saveSalesTaxProfileAction({
      ...bolan,
      businessId: first.businessId,
    });
    check(
      "a business cannot take another business's number",
      [
        clash.success,
        /already uses this registration number/.test(clash.error),
      ],
      [false, true],
    );
    check(
      "the refusal changed nothing",
      (await overview()).businesses
        .find((b) => b.id === first.businessId)
        .registrationNo.replace(/\D/g, ""),
      august.registrationNo,
    );
    const missing = await actions.saveSalesTaxProfileAction({
      ...acme,
      businessId: "does-not-exist",
    });
    check(
      "an unknown business is refused",
      [missing.success, missing.error],
      [false, "This business was not found."],
    );

    // Starting months.
    const noChoice = await actions.startSalesTaxMonthAction({
      authority: "FBR",
      ...august.period,
    });
    check(
      "with two businesses the month needs a choice",
      [noChoice.success, noChoice.error],
      [false, "Choose which business this return is for."],
    );
    const acmeAug = await actions.startSalesTaxMonthAction({
      businessId: first.businessId,
      authority: "FBR",
      ...august.period,
    });
    const bolanAug = await actions.startSalesTaxMonthAction({
      businessId: second.businessId,
      authority: "FBR",
      ...august.period,
    });
    check(
      "the same month is started for both businesses",
      [acmeAug.success, bolanAug.success, acmeAug.id !== bolanAug.id],
      [true, true, true],
    );
    check(
      "neither was already there",
      [acmeAug.alreadyExisted, bolanAug.alreadyExisted],
      [false, false],
    );
    const acmeAgain = await actions.startSalesTaxMonthAction({
      businessId: first.businessId,
      authority: "FBR",
      ...august.period,
    });
    check(
      "starting it again for the same business opens the same return",
      [acmeAgain.id, acmeAgain.alreadyExisted],
      [acmeAug.id, true],
    );
    const stored = await prisma.salesTaxFiling.findUnique({
      where: { id: bolanAug.id },
    });
    check(
      "the return is stored with its business",
      stored.businessId,
      second.businessId,
    );
    check(
      "a business that is not yours is refused",
      (
        await actions.startSalesTaxMonthAction({
          businessId: "nope",
          authority: "FBR",
          ...august.period,
        })
      ).success,
      false,
    );

    // The overview ties each return to its business.
    const view = await overview();
    check(
      "the overview carries the business of each return",
      view.filings.map((f) => f.businessId).sort(),
      [first.businessId, second.businessId].sort(),
    );

    // The checks use the number of the business the return belongs to.
    const salesFile = await gridToWorkbook(august.salesGrid);
    const purchaseFile = await gridToWorkbook(august.purchaseGrid);
    const okUpload = await upload(
      acmeAug.id,
      "SALES",
      salesFile,
      "acme-sales.xlsx",
    );
    check("the file for Acme matches Acme's number", okUpload.success, true);
    await upload(acmeAug.id, "PURCHASES", purchaseFile, "acme-purchases.xlsx");
    const wrongBusiness = await upload(
      bolanAug.id,
      "SALES",
      salesFile,
      "acme-sales-in-bolan.xlsx",
    );
    check(
      "the same file for Bolan is checked against Bolan's number",
      wrongBusiness.success === false ||
        wrongBusiness.invoices.problems.some(
          (p) => p.code === "template_registration_mismatch",
        ),
      true,
    );
    const acmeDetail = await actions.getSalesTaxFilingAction(acmeAug.id);
    check(
      "opening a return gives its own business",
      [acmeDetail.profile.id, acmeDetail.profile.businessName],
      [first.businessId, "Acme Traders Ltd"],
    );
    check(
      "Acme's files are untouched by Bolan's return",
      [
        acmeDetail.invoices.sales.fileName,
        acmeDetail.invoices.problems.some(
          (p) => p.code === "template_registration_mismatch",
        ),
      ],
      ["acme-sales.xlsx", false],
    );
    const bolanDetail = await actions.getSalesTaxFilingAction(bolanAug.id);
    check(
      "Bolan's return has no Acme files",
      bolanDetail.invoices.purchases,
      null,
    );

    // Approval stays with its own return.
    const approved = await actions.approveSalesTaxReturnAction(
      acmeAug.id,
      true,
    );
    check("Acme's return is approved", approved.success, true);
    const afterApprove = await overview();
    check(
      "only Acme's return shows as approved in the list",
      afterApprove.filings
        .map((f) => [f.id === acmeAug.id, f.approval])
        .sort()
        .map(([isAcme, a]) => `${isAcme}:${a}`),
      ["false:none", "true:current"],
    );
    await actions.saveSalesTaxProfileAction({
      ...acme,
      businessId: first.businessId,
      registrationNo: "9999999",
    });
    const afterChange = await overview();
    check(
      "changing Acme's number stales Acme's approval only",
      afterChange.filings
        .map((f) => `${f.id === acmeAug.id}:${f.approval}`)
        .sort(),
      ["false:none", "true:stale"],
    );
    await actions.saveSalesTaxProfileAction({
      ...acme,
      businessId: first.businessId,
    });

    // Another user.
    const owner = sessionEmail;
    sessionEmail = newEmail("stranger");
    check(
      "another user sees no businesses and no returns",
      [(await overview()).businesses.length, (await overview()).filings.length],
      [0, 0],
    );
    const theirs = await actions.saveSalesTaxProfileAction(acme);
    check(
      "another user can save the same number as their own business",
      [theirs.success, theirs.businessId !== first.businessId],
      [true, true],
    );
    check(
      "another user cannot change your business",
      (
        await actions.saveSalesTaxProfileAction({
          ...bolan,
          businessId: first.businessId,
        })
      ).success,
      false,
    );
    check(
      "another user cannot start a return for your business",
      (
        await actions.startSalesTaxMonthAction({
          businessId: first.businessId,
          authority: "FBR",
          ...august.period,
        })
      ).success,
      false,
    );
    check(
      "another user cannot remove your business",
      (await actions.deleteSalesTaxBusinessAction(first.businessId)).success,
      false,
    );
    check(
      "your business is still there",
      await prisma.salesTaxProfile.count({ where: { id: first.businessId } }),
      1,
    );
    check(
      "with one business a month needs no choice",
      (
        await actions.startSalesTaxMonthAction({
          authority: "FBR",
          ...august.period,
        })
      ).success,
      true,
    );
    sessionEmail = owner;

    // Removing a business.
    const withReturns = await actions.deleteSalesTaxBusinessAction(
      second.businessId,
    );
    check(
      "a business with returns cannot be removed",
      [withReturns.success, withReturns.error],
      [
        false,
        "This business still has returns. Delete its draft returns first.",
      ],
    );
    check(
      "deleting its return first works",
      (await actions.deleteSalesTaxMonthAction(bolanAug.id)).success,
      true,
    );
    const removed = await actions.deleteSalesTaxBusinessAction(
      second.businessId,
    );
    check("then the business can be removed", removed.success, true);
    check(
      "the other business and its return stay",
      [(await overview()).businesses.length, (await overview()).filings.length],
      [1, 1],
    );
    check(
      "removing an unknown business is refused",
      (await actions.deleteSalesTaxBusinessAction("nope")).success,
      false,
    );

    // Deleting the user removes everything.
    const ownerRow = await prisma.user.findUnique({ where: { email: owner } });
    await prisma.user.delete({ where: { id: ownerRow.id } });
    check(
      "businesses and returns go with the user",
      [
        await prisma.salesTaxProfile.count({ where: { userId: ownerRow.id } }),
        await prisma.salesTaxFiling.count({ where: { userId: ownerRow.id } }),
      ],
      [0, 0],
    );

    sessionEmail = null;
    check(
      "without a login nothing can be removed",
      (await actions.deleteSalesTaxBusinessAction("x")).success,
      false,
    );
  } finally {
    sessionEmail = null;
    await prisma.user
      .deleteMany({ where: { email: { in: emails } } })
      .catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

async function main() {
  runSourceChecks();
  await runDatabaseChecks();
  finish();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
