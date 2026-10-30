/**
 * Sindh services (SRB) months: the REAL server actions against a REAL
 * PostgreSQL database (skipped cleanly when none is reachable).
 *
 * Covers starting an SRB month, saving, editing and removing lines, figures,
 * approval and its staleness, the overview, the 500-line limit, two saves at
 * once, other users, and that the FBR actions refuse an SRB month. Expected
 * amounts are worked out by hand and written next to the data. All data is
 * synthetic.
 */

const path = require("path");
const Module = require("module");

const kit = require("./lib/sales-tax-test-kit.cjs");
const { check, finish } = kit.createChecker("verify-srb-module");
const R = kit.R;
const root = kit.projectRoot;

let sessionEmail = null;
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "next/cache") return { revalidatePath() {} };
  if (request === "next-auth/next") {
    return { getServerSession: async () => (sessionEmail ? { user: { email: sessionEmail, name: "Test" } } : null) };
  }
  if (request === "server-only") return {};
  if (request === "@/lib/auth" || request === path.join(root, "lib/auth")) return { authOptions: {} };
  return originalLoad.call(this, request, ...rest);
};

const SEP = { year: 2026, month: 9 };
const sale = (over = {}) => ({
  buyerNtn: "1234567-8", buyerName: "Buyer Co", buyerType: "INTERMEDIARY", docType: "SI", docNo: "S-1",
  docDate: "2026-09-10", cpc: "83211", rateId: "standard", valueExclTax: "1000000.00", salesTax: "150000.00", ...over,
});
const purchase = (over = {}) => ({
  supplierNtn: "7654321-0", supplierName: "Supplier Co", supplierType: "REGISTERED", docType: "PI", docNo: "P-1",
  docDate: "2026-09-05", kind: "SERVICES", cpc: "83131", rateId: "standard", valueExclTax: "400000.00", salesTax: "60000.00", ...over,
});
const row = (state, sr) => state.review.lines.find((line) => line.sr === sr);

async function main() {
  let PrismaClient;
  try {
    ({ PrismaClient } = require("@prisma/client"));
  } catch {
    console.log("SRB module checks skipped: Prisma client is not generated.");
    return;
  }
  const probe = new PrismaClient();
  try {
    await probe.$queryRawUnsafe("SELECT 1");
  } catch {
    await probe.$disconnect().catch(() => {});
    console.log("SRB module checks skipped (no database reachable).");
    return;
  }
  await probe.$disconnect();

  const { prisma } = kit.load("lib/prisma.ts");
  const fbr = kit.load("app/actions/sales-tax.ts");
  const srb = kit.load("app/actions/sales-tax-srb.ts");
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const emails = [];
  const newEmail = (tag) => {
    const email = `srb-${tag}-${suffix}@example.invalid`;
    emails.push(email);
    return email;
  };
  try {
    sessionEmail = newEmail("owner");
    const profile = await fbr.saveSalesTaxProfileAction({ businessName: "Indus Consulting", registrationNo: "3277876123456", authorities: ["FBR", "SRB"] });
    check("a business can choose SRB", profile.success, true);

    // Starting months
    const early = await fbr.startSalesTaxMonthAction({ authority: "SRB", year: 2025, month: 6 });
    check("June 2025 is refused for SRB", [early.success, early.error], [false, "Sindh services returns are supported from July 2025 onwards. Choose a later month."]);
    const fbrEarly = await fbr.startSalesTaxMonthAction({ authority: "FBR", year: 2025, month: 6 });
    check("the same month is fine for FBR", fbrEarly.success, true);
    const july = await fbr.startSalesTaxMonthAction({ authority: "SRB", year: 2025, month: 7 });
    check("July 2025 can be started for SRB", july.success, true);
    const started = await fbr.startSalesTaxMonthAction({ authority: "SRB", ...SEP });
    check("September 2026 can be started", [started.success, started.alreadyExisted], [true, false]);
    const again = await fbr.startSalesTaxMonthAction({ authority: "SRB", ...SEP });
    check("starting it again opens the same month", [again.id, again.alreadyExisted], [started.id, true]);
    const id = started.id;
    const fbrSameMonth = await fbr.startSalesTaxMonthAction({ authority: "FBR", ...SEP });
    check("FBR and SRB months of one period are separate returns", [fbrSameMonth.success, fbrSameMonth.id !== id], [true, true]);

    // An empty month
    const empty = await srb.getSrbFilingAction(id);
    check("the SRB month opens", empty.success, true);
    check("it knows its authority and business", [empty.data.filing.authority, empty.data.profile.businessName], ["SRB", "Indus Consulting"]);
    check("SRB due dates: 10th, 15th and 18th of the next month", empty.data.state.dueDates, { annexC: "2026-10-10", payment: "2026-10-15", returnFiling: "2026-10-18" });
    const expectedEmptyProblems = new Date() > new Date("2026-10-18T23:59:59.999Z")
      ? ["srb_no_invoices", "srb_late_return"]
      : ["srb_no_invoices"];
    check("an empty month gives zero and the expected warning(s)", [empty.data.state.review.canEstimate, empty.data.state.review.balancePayable, empty.data.state.review.problems.map((p) => p.code)], [true, 0, expectedEmptyProblems]);
    check("rows 11 to 17 are flagged pending", empty.data.state.review.payableUnconfirmed, true);

    // Saving lines
    const bad = await srb.saveSrbEntryAction({ filingId: id, kind: "SALES", raw: sale({ salesTax: "100.00" }) });
    check("a sale with the wrong tax is refused with the field named", [bad.success, Object.keys(bad.fieldErrors)], [false, ["salesTax"]]);
    check("nothing was stored", await prisma.salesTaxUpload.count({ where: { filingId: id } }), 0);
    const first = await srb.saveSrbEntryAction({ filingId: id, kind: "SALES", raw: sale() });
    check("a valid sale is saved", first.success, true);
    check("one sale in the state", first.state.sales.length, 1);
    check("row 9a is Rs 150,000", row(first.state, "9a").amount, R(150000));
    check("payable is Rs 150,000 (no input tax yet)", first.state.review.balancePayable, R(150000));
    const stored = await prisma.salesTaxUpload.findUnique({ where: { filingId_kind: { filingId: id, kind: "SRB_SALES" } } });
    check("it is stored as SRB_SALES with its line count", [stored.rowCount, Array.isArray(stored.grid)], [1, true]);
    const saleId = first.state.sales[0].id;

    const edited = await srb.saveSrbEntryAction({ filingId: id, kind: "SALES", entryId: saleId, raw: sale({ valueExclTax: "2000000.00", salesTax: "300000.00" }) });
    check("a sale can be edited in place", [edited.success, edited.state.sales.length, edited.state.sales[0].id], [true, 1, saleId]);
    check("the edit changed the figures", row(edited.state, "9a").amount, R(300000));
    const missing = await srb.saveSrbEntryAction({ filingId: id, kind: "SALES", entryId: "nope", raw: sale() });
    check("editing an unknown line is refused", missing.success, false);
    const badEdit = await srb.saveSrbEntryAction({ filingId: id, kind: "SALES", entryId: saleId, raw: sale({ docDate: "2026-08-01" }) });
    check("a bad edit changes nothing", [badEdit.success, (await srb.getSrbFilingAction(id)).data.state.sales[0].valueExclTax], [false, R(2000000)]);
    const restored = await srb.saveSrbEntryAction({ filingId: id, kind: "SALES", entryId: saleId, raw: sale() });
    check("put back to Rs 150,000", row(restored.state, "9a").amount, R(150000));

    const bought = await srb.saveSrbEntryAction({ filingId: id, kind: "PURCHASES", raw: purchase() });
    check("a purchase is saved", bought.success, true);
    check("row 1 is Rs 60,000", row(bought.state, "1").amount, R(60000));
    // 13 = 150,000 - (0 + 60,000) = 90,000
    check("payable is Rs 90,000", bought.state.review.balancePayable, R(90000));
    check("the 20% evidence warning (60,000 is more than 20% of 150,000)", bought.state.review.problems.some((p) => p.code === "srb_evidence_needed"), true);
    const purchaseId = bought.state.purchases[0].id;

    // Figures
    const badFigures = await srb.saveSrbFiguresAction(id, { amounts: { creditBroughtForward6: "abc" }, exports: [] });
    check("bad figures are refused", badFigures.success, false);
    check("nothing was stored for them", (await prisma.salesTaxFiling.findUnique({ where: { id } })).figures, null);
    const figs = await srb.saveSrbFiguresAction(id, { amounts: { creditBroughtForward6: "10000" }, exports: [] });
    // 12 = 10,000 + 60,000 = 70,000; 13 = 150,000 - 70,000 = 80,000
    check("figures are saved and used", [figs.success, figs.state.review.balancePayable], [true, R(80000)]);
    check("the figure is read back", (await srb.getSrbFilingAction(id)).data.state.figures.creditBroughtForward6, R(10000));

    // Approval
    check("approval needs the tick", (await srb.approveSrbReturnAction(id, false)).success, false);
    const approved = await srb.approveSrbReturnAction(id, true);
    check("the return is approved", [approved.success, approved.state.review.approval.current], [true, true]);
    const packet = (await prisma.salesTaxFiling.findUnique({ where: { id } })).approvedPacket;
    check("the packet holds the lines and says the payable is unconfirmed", [packet.authority, packet.sales.length, packet.purchases.length, packet.balancePayable, packet.payableUnconfirmed], ["SRB", 1, 1, R(80000), true]);
    const view = async () => (await fbr.getSalesTaxOverviewAction()).filings.find((f) => f.id === id);
    check("the list shows the approval as current", (await view()).approval, "current");
    check("the list shows SRB due dates", (await view()).dueDates.returnFiling, "2026-10-18");
    const changed = await srb.saveSrbEntryAction({ filingId: id, kind: "SALES", raw: sale({ docNo: "S-2" }) });
    check("a new line makes the approval stale", changed.state.review.approval.current, false);
    check("the list shows it as stale", (await view()).approval, "stale");
    const removedSale = await srb.removeSrbEntryAction(id, "SALES", changed.state.sales.find((s) => s.docNo === "S-2").id);
    check("removing the line makes the old approval current again", removedSale.state.review.approval.current, true);
    await srb.saveSrbFiguresAction(id, { amounts: { creditBroughtForward6: "10001" }, exports: [] });
    check("a changed figure makes it stale", (await srb.getSrbFilingAction(id)).data.state.review.approval.current, false);
    check("approving again works", (await srb.approveSrbReturnAction(id, true)).state.review.approval.current, true);

    // Removing lines
    const gone = await srb.removeSrbEntryAction(id, "PURCHASES", purchaseId);
    check("a purchase is removed", [gone.success, gone.state.purchases.length], [true, 0]);
    check("the last line removes the stored row", await prisma.salesTaxUpload.count({ where: { filingId: id, kind: "SRB_PURCHASES" } }), 0);
    check("removing an unknown line is refused", (await srb.removeSrbEntryAction(id, "PURCHASES", "nope")).success, false);
    check("an unknown kind is refused", (await srb.removeSrbEntryAction(id, "OTHER", "x")).success, false);

    // Two saves at once both survive
    const [a, b] = await Promise.all([
      srb.saveSrbEntryAction({ filingId: id, kind: "PURCHASES", raw: purchase({ docNo: "P-10" }) }),
      srb.saveSrbEntryAction({ filingId: id, kind: "PURCHASES", raw: purchase({ docNo: "P-11" }) }),
    ]);
    check("two simultaneous saves both succeed", [a.success, b.success], [true, true]);
    check("and both lines are stored", (await srb.getSrbFilingAction(id)).data.state.purchases.map((p) => p.docNo).sort(), ["P-10", "P-11"]);

    // The 500-line limit
    {
      const filler = Array.from({ length: 500 }, (_, i) => ({ ...first.state.sales[0], id: `fill-${i}`, docNo: `F-${i}` }));
      await prisma.salesTaxUpload.update({ where: { filingId_kind: { filingId: id, kind: "SRB_SALES" } }, data: { rowCount: 500, grid: filler } });
      const over = await srb.saveSrbEntryAction({ filingId: id, kind: "SALES", raw: sale({ docNo: "S-501" }) });
      check("the 501st line is refused", [over.success, /500 lines/.test(over.error)], [false, true]);
      await prisma.salesTaxUpload.deleteMany({ where: { filingId: id, kind: "SRB_SALES" } });
    }

    // Only drafts change
    await prisma.salesTaxFiling.update({ where: { id }, data: { status: "SUBMITTED" } });
    check("a month that is not a draft cannot get lines", (await srb.saveSrbEntryAction({ filingId: id, kind: "SALES", raw: sale() })).success, false);
    check("nor lose them", (await srb.removeSrbEntryAction(id, "PURCHASES", "x")).success, false);
    check("nor change figures", (await srb.saveSrbFiguresAction(id, { amounts: {}, exports: [] })).success, false);
    check("nor be approved", (await srb.approveSrbReturnAction(id, true)).success, false);
    await prisma.salesTaxFiling.update({ where: { id }, data: { status: "DRAFT" } });

    // The FBR actions never touch an SRB month
    const fbrView = await fbr.getSalesTaxFilingAction(id);
    check("the FBR loader does not open an SRB month", fbrView.success, false);
    check("FBR figures cannot be saved on it", (await fbr.saveSalesTaxFiguresAction(id, {})).success, false);
    check("FBR approval cannot be given on it", (await fbr.approveSalesTaxReturnAction(id, true)).success, false);
    check("a typed FBR invoice cannot be added to it", (await fbr.saveSalesTaxManualInvoiceAction({ filingId: id, kind: "SALES", invoice: {} })).success, false);
    const fbrId = fbrSameMonth.id;
    check("the SRB loader does not open an FBR month", (await srb.getSrbFilingAction(fbrId)).success, false);
    check("SRB lines cannot be saved on an FBR month", (await srb.saveSrbEntryAction({ filingId: fbrId, kind: "SALES", raw: sale() })).success, false);
    check("SRB figures cannot be saved on an FBR month", (await srb.saveSrbFiguresAction(fbrId, { amounts: {}, exports: [] })).success, false);
    check("SRB approval cannot be given on an FBR month", (await srb.approveSrbReturnAction(fbrId, true)).success, false);

    // Another user
    const owner = sessionEmail;
    sessionEmail = newEmail("stranger");
    check("another user cannot open it", (await srb.getSrbFilingAction(id)).success, false);
    check("nor add a line", (await srb.saveSrbEntryAction({ filingId: id, kind: "SALES", raw: sale({ docNo: "X" }) })).success, false);
    check("nor remove one", (await srb.removeSrbEntryAction(id, "PURCHASES", "x")).success, false);
    check("nor save figures", (await srb.saveSrbFiguresAction(id, { amounts: {}, exports: [] })).success, false);
    check("nor approve", (await srb.approveSrbReturnAction(id, true)).success, false);
    sessionEmail = null;
    check("without a login nothing opens", (await srb.getSrbFilingAction(id)).success, false);
    sessionEmail = owner;

    // Deleting the month removes its lines
    check("the month can be deleted", (await fbr.deleteSalesTaxMonthAction(id)).success, true);
    check("its lines went with it", await prisma.salesTaxUpload.count({ where: { filingId: id } }), 0);
  } finally {
    sessionEmail = null;
    await prisma.user.deleteMany({ where: { email: { in: emails } } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
  finish();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
