// UI Test 6 -- The manual category panel in Bank Intelligence stays on screen.
//
// The panel opens next to its pencil button. Near the bottom of the window (and
// in Full View) it used to run off the screen, so the last rows could not be
// classified. The transactions are seeded straight into the database so the
// test does not depend on a statement upload.
const h = require("./_harness.cjs");

const EMAIL = "ui-bank-panel@taxrocket.test";
const VIEWPORT_HEIGHT = 720;

(async () => {
  const user = await h.createTestUser(EMAIL);
  const p = h.prisma;
  const draft = await p.filingDraft.create({
    data: {
      userId: user.id,
      taxYear: 2026,
      filerType: "myself",
      incomeSources: JSON.stringify(["business"]),
      residencyStatus: "resident",
      // Myself + Business combined steps: ... documents (8),
      // business_review (9), bank_intelligence (10).
      currentStep: 10,
      wizardCompletionStep: 10,
    },
  });
  await p.filingIncomeSelection.create({
    data: {
      filingDraftId: draft.id,
      userId: user.id,
      source: "business",
      subcategory: "profit-return",
      detailsJson: JSON.stringify({
        businessDocumentFlowVersion: 2,
        userDetails: { businessGrossSales: 6000000 },
      }),
    },
  });
  const account = await p.bankAccount.create({
    data: {
      filingDraftId: draft.id,
      userId: user.id,
      bankName: "HBL",
      accountLabel: "Account 1",
      iban: "PK35HABB0018067900476803",
    },
  });
  const statement = await p.bankStatement.create({
    data: {
      filingDraftId: draft.id,
      userId: user.id,
      accountLabel: "Account 1",
      bankAccountId: account.id,
      openingBalance: 800000,
      closingBalance: 800000,
      periodStart: new Date("2025-07-01"),
      periodEnd: new Date("2026-06-30"),
    },
  });
  let balance = 800000;
  for (let i = 0; i < 40; i++) {
    const credit = i % 3 === 0;
    const amount = 10000 + i;
    balance += credit ? amount : -amount;
    await p.bankTransaction.create({
      data: {
        filingDraftId: draft.id,
        userId: user.id,
        bankStatementId: statement.id,
        bankAccountId: account.id,
        transactionDate: new Date(`2025-${String((i % 9) + 1).padStart(2, "0")}-15`),
        description: credit ? `CUSTOMER RECEIPT ${i}` : `PAYMENT TO SUPPLIER ${i}`,
        debit: credit ? null : amount,
        credit: credit ? amount : null,
        balance,
        source: "STATEMENT",
        classificationStatus: credit ? "POTENTIAL_INCOME" : "UNREVIEWED",
        suggestedEntryType: credit ? "INCOME" : null,
        suggestedCategory: credit ? "POTENTIAL_INCOME" : null,
      },
    });
  }

  const { browser, page } = await h.openBrowser(user);
  await page.setViewportSize({ width: 1280, height: VIEWPORT_HEIGHT });
  await page.goto(`/tax/new?draftId=${draft.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(4000);

  h.section("Manual category panel stays inside the window");
  const pencils = page.locator('button[title="Choose a category manually"]');
  const count = await pencils.count();
  h.check("all 40 rows offer a manual category button", count, 40);

  async function panelFits(label, button) {
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await page.waitForTimeout(400);
    const box = await page.locator("[data-manual-review-panel]").boundingBox();
    h.checkTrue(
      `${label}: panel is fully visible`,
      Boolean(box) && box.y >= 0 && box.y + box.height <= VIEWPORT_HEIGHT + 0.5,
      box ? `y ${Math.round(box.y)}, height ${Math.round(box.height)}` : "no panel",
    );
  }

  await panelFits("last row", pencils.nth(count - 1));
  const panelSelects = page.locator("[data-manual-review-panel] select");
  await panelSelects.nth(0).selectOption("INCOME");
  await panelSelects.nth(1).selectOption("GIFT");
  await page.waitForTimeout(300);
  const gift = await page.locator("[data-manual-review-panel]").boundingBox();
  h.checkTrue(
    "last row: panel with the gift field is fully visible",
    Boolean(gift) && gift.y >= 0 && gift.y + gift.height <= VIEWPORT_HEIGHT + 0.5,
  );
  await page.mouse.click(10, 10);
  await page.waitForTimeout(300);

  await pencils.nth(0).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -250));
  await panelFits("first row near the bottom of the window", pencils.nth(0));
  await page.mouse.click(10, 10);
  await page.waitForTimeout(300);

  await page.locator('button:has-text("Open Full View")').click();
  await page.waitForTimeout(600);
  const inFull = page.locator('button[title="Choose a category manually"]');
  await panelFits("Full View, last row", inFull.nth((await inFull.count()) - 1));

  await browser.close();
  await h.deleteTestUser(EMAIL);
  h.finish("Bank panel position");
  await p.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await h.deleteTestUser(EMAIL).catch(() => {});
  await h.prisma.$disconnect();
  process.exit(1);
});
