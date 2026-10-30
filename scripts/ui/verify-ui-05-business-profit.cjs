// UI Test 5 -- Business profit step (Myself + Business Income).
//
// Walks the real wizard: the Myself business filer gets the small profit form
// (not the 16 withholding cards), the figures are gated, saved, restored on
// resume and survive an auto-save of the resumed draft. My Business must still
// show its 16 categories.
const h = require("./_harness.cjs");
const EMAIL = "ui-business-profit@taxrocket.test";
async function clickTile(page, label) {
  const el = page.locator(`button:has-text("${label}"), [role="button"]:has-text("${label}"), label:has-text("${label}")`).last();
  await el.waitFor({ state: "visible" }); await el.click(); await page.waitForTimeout(500);
}
async function cont(page){ const b=page.locator('button:has-text("Continue")').first(); await b.waitFor({state:"visible"}); await b.click(); await page.waitForTimeout(800);}
const num = (page, idx, v) => page.locator('input[type="number"]').nth(idx).fill(String(v));
(async () => {
  const user = await h.createTestUser(EMAIL);
  const { browser, page, consoleErrors } = await h.openBrowser(user);
  await page.goto("/tax/new", { waitUntil: "networkidle" });
  await clickTile(page, "Myself"); await cont(page);
  await clickTile(page, "Business Income"); await cont(page);
  await page.fill('input[placeholder="HBL, Meezan Bank"]', "HBL"); await page.waitForTimeout(300);
  await cont(page); await cont(page);
  await clickTile(page, "I am a tax resident"); await cont(page);
  h.section("Business profit step (Myself)");
  let body=(await page.textContent("body"))||"";
  h.checkTrue("shows the profit form", /Tell us about your business/.test(body));
  h.checkTrue("does NOT show the 16 withholding cards", !/Supply of goods|categories available/i.test(body));
  h.check("8 figure inputs", await page.locator('input[type="number"]').count(), 8);
  h.check("Continue disabled while empty", await page.locator('button:has-text("Continue")').first().isDisabled(), true);
  h.checkTrue("action item names the step", /Complete Business profit/.test(body));
  await page.screenshot({ path: "/tmp/walk/05-empty.png", fullPage: true });
  await num(page,0,5000000); await num(page,2,3000000); await num(page,3,800000); await num(page,4,100000); await num(page,5,50000);
  await page.waitForTimeout(500);
  body=(await page.textContent("body"))||"";
  h.checkTrue("live profit shown (5m-3m-0.8m+0.05m = 1,250,000; book depreciation 0.1m added back, s.22)", /1,250,000/.test(body), body.match(/Estimated taxable[^.]*/)?.[0]);
  h.check("Continue enabled once sales entered", await page.locator('button:has-text("Continue")').first().isDisabled(), false);
  await page.screenshot({ path: "/tmp/walk/06-filled.png", fullPage: true });
  // loss display
  await num(page,0,1000000); await page.waitForTimeout(300);
  body=(await page.textContent("body"))||"";
  h.checkTrue("loss message", /Business loss for the year/.test(body));
  await num(page,0,150000000); await page.waitForTimeout(300);
  body=(await page.textContent("body"))||"";
  h.checkTrue("100m: minimum tax box with the business type (Phase 3c)", /Minimum tax on turnover \(Section 113\)/.test(body) && /What type of business is this\?/.test(body));
  await num(page,0,5000000); await page.waitForTimeout(300);
  // save
  await page.locator('button:has-text("Save draft")').first().click(); await page.waitForTimeout(2000);
  const draft = await h.prisma.filingDraft.findFirst({ where:{userId:user.id}, include:{incomeSelections:true}});
  h.checkTrue("draft saved", !!draft);
  const sel = draft?.incomeSelections ?? [];
  h.check("exactly one business selection", sel.length, 1);
  h.check("subcategory profit-return", sel[0]?.subcategory, "profit-return");
  const det = JSON.parse(sel[0]?.detailsJson||"{}").userDetails||{};
  h.check("sales saved", det.businessGrossSales, 5000000);
  h.check("cost saved", det.businessCostOfSales, 3000000);
  h.check("depr saved", det.businessDepreciation, 100000);
  console.log("DRAFT", draft?.id, "step", draft?.currentStep);
  // resume + autosave
  await page.goto(`/tax/new?draftId=${draft.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  body=(await page.textContent("body"))||"";
  console.log("resumed heading:", (await page.locator("h1,h2").allTextContents()).join("|"));
  // navigate to the profit step if not already there
  for (let i=0;i<6 && !/Tell us about your business/.test((await page.textContent("body"))||"");i++){ await cont(page); }
  body=(await page.textContent("body"))||"";
  h.checkTrue("resume shows the profit step again", /Tell us about your business/.test(body));
  h.check("sales still in the form after resume", await page.locator('input[type="number"]').nth(0).inputValue(), "5000000");
  await page.waitForTimeout(4000); // let auto-save run
  const after = await h.prisma.filingIncomeSelection.findMany({ where:{filingDraftId:draft.id}});
  const det2 = JSON.parse(after[0]?.detailsJson||"{}").userDetails||{};
  h.check("figures survive an auto-save of the resumed draft (sales)", det2.businessGrossSales, 5000000);
  h.check("figures survive auto-save (cost)", det2.businessCostOfSales, 3000000);
  h.section("My Business is unchanged");
  await page.goto("/tax/new", { waitUntil: "networkidle" });
  await clickTile(page, "My Business"); await cont(page);
  await clickTile(page, "Company"); await cont(page);
  await clickTile(page, "Business Income"); await cont(page);
  for (let i = 0; i < 8; i++) {
    const t = ((await page.textContent("body")) || "").replace(/\s+/g, " ");
    if (/categories available/.test(t)) break;
    const r = page.locator('button:has-text("I am a tax resident")'); if (await r.count()) await r.last().click();
    const bk = page.locator('input[placeholder="HBL, Meezan Bank"]'); if (await bk.count()) await bk.fill("HBL");
    await cont(page);
  }
  const mb = ((await page.textContent("body")) || "").replace(/\s+/g, " ");
  h.checkTrue("My Business still lists 16 categories", /16 categories available/.test(mb));
  h.checkTrue("My Business does not show the profit form", !/Tell us about your business/.test(mb));
  const fatal = consoleErrors.filter((e) => !/favicon|404|Download the React/i.test(e));
  h.check("no console errors", fatal.length, 0); if (fatal.length) console.log(fatal.slice(0,3));
  await browser.close(); await h.deleteTestUser(EMAIL); h.finish("Business profit walk"); await h.prisma.$disconnect();
})().catch(async e=>{console.error(e); await h.prisma.$disconnect(); process.exit(1);});
