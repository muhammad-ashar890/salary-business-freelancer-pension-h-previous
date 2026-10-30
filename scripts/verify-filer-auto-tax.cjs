"use strict";
/**
 * 28-Oct-2026 (operator): the tax must be calculated from the filer status
 * answer itself, so the three separate Calculate buttons were removed.
 *
 * The Filer / Filer-late / Non-filer answer is given in the setup, so the tax
 * estimate must follow it on its own. The three "Calculate for ATL / Late Filer
 * / Non-ATL" buttons no longer have a job: they are removed, replaced by a
 * read-out of the answer that priced the estimate plus one Recalculate button
 * used only when the saved estimate does not match the answer.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const oldResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return oldResolve.call(
    this,
    request.startsWith("@/") ? path.join(root, request.slice(2)) : request,
    ...rest,
  );
};
require.extensions[".ts"] = (m, f) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(f, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    f,
  );

const review = fs.readFileSync(
  path.join(root, "components/tax/filing/wizard-review-step.tsx"),
  "utf8",
);
const wizard = fs.readFileSync(
  path.join(root, "components/tax/filing/filing-wizard.tsx"),
  "utf8",
);

test("the three calculate buttons are gone", () => {
  // The trio rendered one button per status by mapping over the three answers.
  assert.equal(
    /\(\["ATL", "LATE_FILER", "NON_ATL"\] as const\)\.map\(/.test(review),
    false,
    "no per-status button trio",
  );
  assert.equal(
    /onClick=\{\(\) => onCalculateTax\(status\)\}/.test(review),
    false,
    "nothing calculates a status the user did not answer",
  );
  // exactly one calculate entry point remains: onCalculateTax(filerStatus)
  const calls = review.match(/onCalculateTax\(/g) ?? [];
  assert.equal(calls.length, 2, `expected the effect + the Recalculate button, saw ${calls.length}`);
});

test("the estimate is priced from the saved answer automatically", () => {
  const start = review.indexOf("AUTO-CALCULATE ON THE WIZARD'S OWN ANSWER");
  assert.ok(start > 0, "the effect exists");
  const block = review.slice(start, review.indexOf("// The breakdown is only meaningful", start));
  // guards: no draft, no answer, already calculating, evidence incomplete
  assert.match(block, /if \(!draftId \|\| !filerStatus\) return;/);
  assert.match(block, /if \(calculatingTaxFor !== null\) return;/);
  assert.match(block, /if \(!servicesEvidenceCompleteForAuto\) return;/);
  // only when the saved estimate was priced on a different answer
  assert.match(
    block,
    /if \(filingSummary\?\.taxpayerListStatus === filerStatus\) return;/,
  );
  // one attempt per (draft, answer, saved status) pair, so a failure cannot loop
  assert.match(block, /autoCalculatedFor\.current === key\) return;/);
  assert.match(block, /onCalculateTax\(filerStatus\);/);
});

test("the review step is told which answer to price", () => {
  assert.match(review, /filerStatus\?: "ATL" \| "NON_ATL" \| "LATE_FILER" \| null;/);
  assert.match(wizard, /<WizardReviewStep[\s\S]{0,1200}filerStatus=\{filerStatus\}/);
});

test("a Recalculate button exists only when the estimate does not match the answer", () => {
  assert.match(
    review,
    /\{\(filingSummary\?\.taxpayerListStatus !== filerStatus \|\| !filerStatus\) && \(/,
  );
  assert.match(review, /Recalculate for \$\{/);
  assert.match(review, /Priced on your answer:/);
  assert.match(review, /estimate is re-priced automatically/);
});

test("no answer yet asks for the answer instead of pricing", () => {
  assert.match(review, /Answer the Filer status step first/);
  assert.match(review, /disabled=\{\s*calculatingTaxFor !== null \|\|\s*!draftId \|\|\s*!filerStatus \|\|/);
});

// ---- the salary band is no longer misnamed -------------------------------
test("the salary route label no longer names the first slab", () => {
  const { getTy2026SubcategoryOptions } = require("../lib/tax/rules/ty2026/subcategories.ts");
  const labels = getTy2026SubcategoryOptions("salary").map((o) => o.label);
  assert.ok(labels.includes("Salary taxable-income band"), labels.join(" | "));
  assert.equal(
    labels.some((label) => /up-to-\d|above-\d/i.test(label)),
    false,
    "no slab name leaks into the route label",
  );
  // other sources keep their own wording
  assert.ok(
    getTy2026SubcategoryOptions("pension").some((o) =>
      o.label.startsWith("Pension not exceeding"),
    ),
  );
});

// ---- plain words on every screen (28-Oct) ---------------------------------
test("screens say Filer / Late Filer / Non-Filer, not the ATL codes", () => {
  const { filerStatusScreenLabel, TAXPAYER_LIST_STATUS_SCREEN_LABEL } = require(
    "../lib/tax/filer-status.ts",
  );
  assert.deepEqual(TAXPAYER_LIST_STATUS_SCREEN_LABEL, {
    ATL: "Filer",
    LATE_FILER: "Late Filer",
    NON_ATL: "Non-Filer",
  });
  assert.equal(filerStatusScreenLabel("ATL"), "Filer");
  assert.equal(filerStatusScreenLabel("LATE_FILER"), "Late Filer");
  assert.equal(filerStatusScreenLabel("NON_ATL"), "Non-Filer");
  assert.equal(filerStatusScreenLabel(null), "Not answered");
  // unknown values must not leak the raw code onto the screen
  assert.equal(filerStatusScreenLabel("SOMETHING"), "Not answered");
});

test("the Review badge and the recalculate button use those words", () => {
  assert.match(review, /Calculated for \{filerStatusScreenLabel\(filingSummary\.taxpayerListStatus\)\}/);
  assert.match(review, /Recalculate for \$\{filerStatusScreenLabel\(filerStatus\)\}/);
  assert.equal(/Calculated for \{filingSummary\.taxpayerListStatus\}/.test(review), false);
  assert.equal(review.includes('"Non-ATL"'), false);
});

test("the setup cards and the summary row use the same three words", () => {
  const setup = fs.readFileSync(
    path.join(root, "components/tax/filing/wizard-setup-step.tsx"),
    "utf8",
  );
  for (const label of ['title: "Filer"', 'title: "Late Filer"', 'title: "Non-Filer"']) {
    assert.ok(setup.includes(label), label);
  }
  assert.equal(/title: "Filer \(ATL\)"/.test(setup), false);
  assert.match(wizard, /\? "Filer"\s*:\s*filerStatus === "LATE_FILER"\s*\? "Late Filer"/);
});

test("server-side blockers and the filer gate use the same words", () => {
  const filing = fs.readFileSync(path.join(root, "app/actions/filing.ts"), "utf8");
  const packet = fs.readFileSync(path.join(root, "app/actions/packet.ts"), "utf8");
  const gate = fs.readFileSync(path.join(root, "lib/tax/filer-status.ts"), "utf8");
  for (const src of [filing, packet]) {
    assert.match(src, /Filer \/ Late Filer \/ Non-Filer answer/);
    assert.equal(src.includes("ATL, Late Filer or Non-ATL"), false);
  }
  assert.match(gate, /const label = TAXPAYER_LIST_STATUS_SCREEN_LABEL\[status\];/);
  assert.match(gate, /change the answer to Non-Filer/);
});
