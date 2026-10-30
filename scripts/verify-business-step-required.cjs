"use strict";
/**
 * Live test A (16-Oct-2026): the Review step showed "Confirmed rules
 * required" because the Section 113 earlier-year question was never answered
 * on an older draft, and the reason was not shown anywhere.
 *
 * Checks:
 *   1. lib/tax/business-profit-step-check.ts lists the open answers the tax
 *      estimate needs from this step (the stops of
 *      app/actions/tax-calculation.ts except the sales figure, which comes
 *      from the mapped Business Books since 16-Oct);
 *   2. the wizard keeps Continue disabled on the Business profit step while
 *      one is open, and says what to finish;
 *   3. Review shows the reason of a NEEDS_RULES result;
 *   4. an edit inside a detail list (asset list, bank accounts, vehicles,
 *      losses, ...) changes the draft fingerprint, so the old estimate and
 *      packet approval are reset like for any other changed figure.
 * Synthetic data only.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(
    this,
    request.startsWith("@/") ? path.join(root, request.slice(2)) : request,
    ...rest,
  );
};
require.extensions[".ts"] = (m, file) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    file,
  );

const check = require(path.join(root, "lib/tax/business-profit-step-check.ts"));
const minimum = require(path.join(root, "lib/tax/minimum-tax-113.ts"));
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const ids = (details) => check.businessProfitStepProblems(details).map((p) => p.id);

// Scenario A of the live test (business only, turnover below Rs 100 million).
const A = {
  businessGrossSales: 12000000,
  businessOtherRevenue: 250000,
  businessCostOfSales: 8050000,
  businessOperatingExpenses: 2120000,
  businessSalesExcludeIndirectTax: true,
};

// ---------------------------------------------------------------------------
// 1. The open answers
// ---------------------------------------------------------------------------
test("step check: scenario A with the Section 113 answer has nothing open", () => {
  assert.deepEqual(ids({ ...A, businessTurnover100mEarlierYear: false }), []);
  assert.deepEqual(ids({ ...A, businessTurnover100mEarlierYear: true }), []);
});

test("step check: the unanswered Section 113 question (the live-test-A stop) is open", () => {
  const problems = check.businessProfitStepProblems(A);
  assert.deepEqual(problems.map((p) => p.id), ["section113_unanswered"]);
  assert.match(problems[0].text, /Section 113 question \(Yes or No\)/);
});

test("step check (16-Oct): sales come from the Books, so the step never asks for them; the 113 question is asked without sales", () => {
  assert.deepEqual(ids({ businessOtherRevenue: 1000 }), ["section113_unanswered"]);
  assert.deepEqual(ids({ ...A, businessGrossSales: 0 }), ["section113_unanswered"]);
  assert.deepEqual(ids(undefined), ["section113_unanswered"]);
  assert.deepEqual(ids({ businessTurnover100mEarlierYear: false }), []);
  assert.ok(!check.BUSINESS_STEP_TEXT.salesMissing, "no sales text on this step");
});

test("step check (16-Oct): the turnover is not used on this step; a big turnover still answers the question", () => {
  assert.deepEqual(ids({ ...A, businessGrossSales: 172000000 }), ["section113_unanswered"]);
  assert.deepEqual(ids({ ...A, businessGrossSales: 172000000, businessTurnover100mEarlierYear: false }), []);
});

test("step check: a cotton ginner reached by Section 113 stops; not when 113 does not reach", () => {
  assert.deepEqual(
    ids({ ...A, businessTurnover100mEarlierYear: true, businessMinimumTaxCategory: "cotton_ginner" }),
    ["cotton_ginner"],
  );
  assert.deepEqual(
    ids({ ...A, businessTurnover100mEarlierYear: false, businessMinimumTaxCategory: "cotton_ginner" }),
    [],
  );
  assert.equal(check.BUSINESS_STEP_TEXT.cottonGinner, minimum.SECTION_113_TEXT.cottonGinner);
});

test("step check: an asset list that breaks a rule is open, next to other open answers", () => {
  const badSchedule = [{ code: "33030105", wdvBroughtForward: 100, deletion: 200, deletionSalePrice: 50 }];
  assert.deepEqual(
    ids({ ...A, businessTurnover100mEarlierYear: false, businessDepreciationSchedule: badSchedule }),
    ["asset_list_invalid"],
  );
  assert.deepEqual(ids({ ...A, businessDepreciationSchedule: badSchedule }), [
    "asset_list_invalid",
    "section113_unanswered",
  ]);
});

test("step check: the estimate action still stops on the same four conditions", () => {
  const action = read("app/actions/tax-calculation.ts");
  for (const piece of [
    "if (!hasBusinessSalesFigure(profitDetails)) {",
    "validateDepreciationSchedule(profitDetails?.businessDepreciationSchedule ?? []).length",
    "if (minimumTaxReach.needsEarlierYearAnswer) {",
    "businessProfitProblem = SECTION_113_TEXT.earlierYearMissing;",
    "(!minimumTaxCategory || minimumTaxCategory.ratePercent === null)",
    "businessProfitProblem = SECTION_113_TEXT.cottonGinner;",
  ])
    assert.ok(action.includes(piece), `tax-calculation.ts: ${piece}`);
  const helper = read("lib/tax/business-profit-step-check.ts");
  for (const piece of [
    "validateDepreciationSchedule(details?.businessDepreciationSchedule ?? []).length",
    "turnover: 0,",
    "reach.needsEarlierYearAnswer",
    "(!category || category.ratePercent === null)",
  ])
    assert.ok(helper.includes(piece), `step check: ${piece}`);
  assert.ok(!helper.includes("hasBusinessSalesFigure"), "the step check does not use a sales figure");
  assert.ok(action.includes("Sales and the other yearly business figures come from your Business Books"), "the estimate stop names the Books");
});

// ---------------------------------------------------------------------------
// 2. The wizard
// ---------------------------------------------------------------------------
test("wizard: activity setup does not ask duplicate tax details; post-upload Continue validates reviewed evidence", () => {
  const wizard = read("components/tax/filing/filing-wizard.tsx");
  assert.match(
    wizard,
    /if \(source === "business" && isMyself\) \{[\s\S]{0,400}businessActivities\?\.length/,
  );
  assert.match(wizard, /const canGoNext = useMemo\([\s\S]*?\}, \[\s*currentStepKey,\s*filerType,\s*isMyself,/);
  assert.match(wizard, /navigationStepKey === "business_review" && !intake.ready/);
  const intakeAction = read("app/actions/business-intake.ts");
  assert.match(intakeAction, /businessProfitStepProblems\(details\)/);
  const step = read("components/tax/filing/wizard-business-profit-step.tsx");
  assert.ok(step.includes("const stepProblems = businessProfitStepProblems(details);"));
  assert.ok(step.includes("To continue, finish these:"));
  assert.ok(step.includes("Required: answer Yes or No to continue."));
  assert.ok(/^[\x00-\x7F]*$/.test(step), "wizard file stays ASCII");
});

// ---------------------------------------------------------------------------
// 3. Review shows the reason
// ---------------------------------------------------------------------------
test("review: a NEEDS_RULES result shows its reason; the old dead-end text is gone", () => {
  const hook = read("components/tax/filing/hooks/use-filing-finalization.ts");
  assert.ok(hook.includes("setTaxCalculationNote(null);"), "cleared on every press");
  assert.ok(
    hook.includes('result.result?.status === "NEEDS_RULES" ? result.result.note || null : null'),
    "taken from the action result",
  );
  assert.match(hook, /return \{[\s\S]*taxCalculationNote,[\s\S]*\};/);
  const wizard = read("components/tax/filing/filing-wizard.tsx");
  assert.ok(wizard.includes("taxCalculationNote={taxCalculationNote}"));
  const review = read("components/tax/filing/wizard-review-step.tsx");
  assert.ok(review.includes("taxCalculationNote?: string | null;"));
  assert.ok(review.includes("`Reason: ${taxCalculationNote}`"));
  assert.ok(!review.includes("Open the calculation details"), "no pointer to a panel that does not exist");
  assert.ok(review.includes("NEEDS_RULES"));
});

// ---------------------------------------------------------------------------
// 4. Fingerprint of the saved details
// ---------------------------------------------------------------------------
function loadStableText() {
  const source = read("app/actions/filing.ts");
  const start = source.indexOf("const stableText = (value: unknown): string => {");
  const end = source.indexOf("const fingerprintDetails = ", start);
  assert.ok(start > 0 && end > start, "stableText is defined before fingerprintDetails");
  const js = ts.transpileModule(`${source.slice(start, end)}\nmodule.exports = stableText;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const box = { exports: {} };
  new Function("module", "exports", js)(box, box.exports);
  return box.exports;
}

test("fingerprint: lists and objects compare by content, keys in any order", () => {
  const stableText = loadStableText();
  // Same content, other key order (database read-back vs. the wizard).
  assert.equal(
    stableText([{ code: "33030105", wdvBroughtForward: 100 }]),
    stableText([{ wdvBroughtForward: 100, code: "33030105" }]),
  );
  assert.equal(stableText({ cash: 1, stock: 2 }), stableText({ stock: 2, cash: 1 }));
  assert.equal(stableText({ cash: 1, stock: undefined }), stableText({ cash: 1 }));
  // An edited value inside a list or an object is a change.
  assert.notEqual(stableText([{ iban: "X", balance: 1 }]), stableText([{ iban: "X", balance: 2 }]));
  assert.notEqual(stableText({ cash: 1 }), stableText({ cash: 2 }));
  assert.notEqual(stableText([{ a: 1 }, { a: 2 }]), stableText([{ a: 2 }, { a: 1 }]));
  // Plain values keep the old text, so existing drafts do not reset by themselves.
  assert.equal(stableText(1250000), "1250000");
  assert.equal(stableText(true), "true");
  assert.equal(stableText(false), "false");
  assert.equal(stableText("standard"), "standard");
  assert.equal(stableText(undefined), "undefined");
});

test("fingerprint: the selection key uses it for every detail", () => {
  const source = read("app/actions/filing.ts");
  assert.ok(
    source.includes("`${key}=${stableText(details[key as keyof Ty2026SelectionUserDetails])}`"),
  );
  assert.ok(!source.includes("`${key}=${details[key as keyof Ty2026SelectionUserDetails]}`"));
});
