"use strict";
/**
 * 28-Oct-2026 (operator request): the wizard must ASK whether the taxpayer is a
 * filer or a non-filer, price the return on that answer, and require the previous
 * year's return when the answer is "filer".
 *
 * Before this, the only filer question in the whole flow was three buttons on the
 * last screen ("Calculate for ATL / Late Filer / Non-ATL"), so a non-filer walked
 * the entire filing before anyone noticed, and a filer was never asked for the
 * return that proves ATL status.
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

const filer = require("../lib/tax/filer-status.ts");
const { filerStatusGate, filerStatusRequiresPreviousReturn, normalizeTaxpayerListStatus } = filer;

// ---- 1. the three answers -------------------------------------------------
test("only the three supported answers are accepted, in any case", () => {
  assert.equal(normalizeTaxpayerListStatus("ATL"), "ATL");
  assert.equal(normalizeTaxpayerListStatus(" non_atl "), "NON_ATL");
  assert.equal(normalizeTaxpayerListStatus("late_filer"), "LATE_FILER");
  for (const bad of ["", null, undefined, "FILER", "atlx", 3]) {
    assert.equal(normalizeTaxpayerListStatus(bad), null, String(bad));
  }
});

test("every answer has a screen label", () => {
  for (const status of filer.TAXPAYER_LIST_STATUSES) {
    assert.ok(filer.TAXPAYER_LIST_STATUS_LABEL[status]);
  }
});

// ---- 2. which answers need the previous return ----------------------------
test("filer and late-filer require the previous return; non-filer does not", () => {
  assert.equal(filerStatusRequiresPreviousReturn("ATL"), true);
  assert.equal(filerStatusRequiresPreviousReturn("LATE_FILER"), true);
  assert.equal(filerStatusRequiresPreviousReturn("NON_ATL"), false);
  assert.equal(filerStatusRequiresPreviousReturn(null), false);
});

// ---- 3. the gate ----------------------------------------------------------
test("a filer without the approved previous return is stopped with a readable reason", () => {
  const result = filerStatusGate({
    status: "ATL",
    taxYear: 2026,
    previousReturn: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.blockers.length, 1);
  assert.match(result.blockers[0], /Filer \(ATL\)/);
  assert.match(result.blockers[0], /Tax Year 2025 return must be uploaded and approved/);
  assert.match(result.blockers[0], /change the answer to Non-filer/);
});

test("a late filer is treated exactly like a filer", () => {
  const result = filerStatusGate({
    status: "LATE_FILER",
    taxYear: 2026,
    previousReturn: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.blockers[0], /filed late/i);
});

test("a filer with the right year's return passes", () => {
  assert.deepEqual(
    filerStatusGate({ status: "ATL", taxYear: 2026, previousReturn: { taxYear: 2025 } }),
    { ok: true, blockers: [] },
  );
});

test("the wrong year's return does not support a filer answer", () => {
  const result = filerStatusGate({
    status: "ATL",
    taxYear: 2026,
    previousReturn: { taxYear: 2024 },
  });
  assert.equal(result.ok, false);
  assert.match(result.blockers[0], /Tax Year 2024/);
  assert.match(result.blockers[0], /Tax Year 2025 is needed/);
});

test("a non-filer is never asked for a previous return", () => {
  assert.deepEqual(
    filerStatusGate({ status: "NON_ATL", taxYear: 2026, previousReturn: null }),
    { ok: true, blockers: [] },
  );
});

test("no answer yet is not an error here (the step owns that question)", () => {
  assert.deepEqual(
    filerStatusGate({ status: null, taxYear: 2026, previousReturn: null }),
    { ok: true, blockers: [] },
  );
});

// ---- 4. wiring in the wizard ---------------------------------------------
const wizard = fs.readFileSync(path.join(root, "components/tax/filing/filing-wizard.tsx"), "utf8");
const setup = fs.readFileSync(path.join(root, "components/tax/filing/wizard-setup-step.tsx"), "utf8");
const config = fs.readFileSync(path.join(root, "components/tax/filing/config/filing-wizard-config.ts"), "utf8");
const action = fs.readFileSync(path.join(root, "app/actions/filer-status.ts"), "utf8");

test("the step sits right after Tax year, before residency", () => {
  assert.match(wizard, /"tax_year",\s*"filer_status",\s*"residency",/);
  assert.match(config, /filer_status: "Filer status"/);
});

test("Continue is blocked until the question is answered", () => {
  assert.match(wizard, /currentStepKey === "filer_status"\) return Boolean\(filerStatus\)/);
});

test("the answer is saved to the draft as the user's own declaration", () => {
  assert.match(wizard, /saveTaxpayerListStatusAction\(draftId, value\)/);
  assert.match(action, /taxpayerListStatusSource: "USER_DECLARED"/);
  assert.match(action, /taxpayerListStatusCheckedAt: new Date\(\)/);
});

test("the answer is restored when the draft is resumed", () => {
  assert.match(wizard, /existing\.taxpayerListStatus === "ATL" \|\|/);
  assert.match(wizard, /existing\.taxpayerListStatus === "NON_ATL"/);
});

test("Documents and Review cannot pass without the return a filer answer needs", () => {
  assert.match(wizard, /getFilerStatusGateAction\(draftId\)/);
  assert.match(wizard, /\["documents", "pipeline_review"\]\.includes\(navigationStepKey\)/);
});

test("the step offers the three cards and warns a filer about the return", () => {
  assert.match(setup, /title="Are you a filer or a non-filer\?"/);
  // Short, single-line titles: the wide two-column cards wrapped "Filer — filed
  // late" onto two lines and left ragged card bottoms in a three-column row.
  for (const label of ["Filer (ATL)", "Filer — late", "Non-filer"]) {
    assert.ok(setup.includes(`title: "${label}"`), label);
  }
  assert.match(setup, /must be uploaded and approved on the Documents step/);
});

test("the three cards are one compact, equal-height row", () => {
  assert.match(setup, /grid items-stretch gap-3 sm:grid-cols-3/);
  assert.match(setup, /flex h-full flex-col items-start gap-3 rounded-xl border-2 p-4/);
  // each card: icon, one-line title, short hint
  assert.match(setup, /text-sm font-semibold leading-tight/);
  assert.match(setup, /text-xs leading-snug text-muted-foreground/);
  // a non-filer reads that the return is not asked for
  assert.match(setup, /Non-filer rates apply/);
});

test("the calculation step prices the answer by itself (buttons removed 28-Oct)", () => {
  const review = fs.readFileSync(path.join(root, "components/tax/filing/wizard-review-step.tsx"), "utf8");
  // The saved answer is what calculateFilingTax writes back; the Review step
  // now prices that same answer without a per-status button.
  assert.match(action, /taxpayerListStatus: normalized/);
  assert.match(review, /if \(filingSummary\?\.taxpayerListStatus === filerStatus\) return;/);
  assert.match(review, /onCalculateTax\(filerStatus\);/);
  assert.equal(/\(\["ATL", "LATE_FILER", "NON_ATL"\] as const\)\.map\(/.test(review), false);
});

// ---- 5. the previous return is never required by the document list --------
test("the upload slot stays optional: nothing in the list makes it required", () => {
  const { buildTaxDocumentSlotsPreview, getRequiredTaxDocumentTypesForCurrentFlow } =
    require("../lib/tax/document-requirements.ts");
  const slots = buildTaxDocumentSlotsPreview({
    incomeSources: ["salary", "business"],
    readinessCompleted: ["core_documents_ready"],
  });
  const previous = slots.find((slot) => slot.documentType === "previous_return");
  assert.ok(previous, "previous return slot exists");
  assert.equal(previous.required, false);
  assert.match(previous.label, /Optional/);
  assert.equal(
    getRequiredTaxDocumentTypesForCurrentFlow({ incomeSources: ["salary", "business"] }).includes(
      "previous_return",
    ),
    false,
  );
});

test("the readiness checklist no longer forces a previous-return claim", () => {
  const config = fs.readFileSync(
    path.join(root, "components/tax/filing/config/filing-wizard-config.ts"),
    "utf8",
  );
  const block = config.slice(
    config.indexOf("export const readinessOptions"),
    config.indexOf("export function computeDocumentSlots"),
  );
  assert.equal(block.includes("previous_return_available"), false);
  assert.match(block, /core_documents_ready/);
  assert.equal(setup.includes('value: "previous_return_available"'), false);
});

test("only the filer answer can make the slot required, and the screen says so", () => {
  const documents = fs.readFileSync(
    path.join(root, "components/tax/filing/wizard-documents-step.tsx"),
    "utf8",
  );
  assert.match(
    documents,
    /slot\.required \|\|\s*\(slot\.documentType === "previous_return" &&\s*previousReturnRequiredByFiler\)/,
  );
  assert.match(documents, /Required — you answered Filer/);
  assert.match(documents, /Skip it if you do not have last year's return/);
  assert.match(documents, /must be reviewed and Save & Approve Map'd/);
  assert.match(
    wizard,
    /previousReturnRequiredByFiler=\{\s*filerStatus === "ATL" \|\| filerStatus === "LATE_FILER"\s*\}/,
  );
});

test("a non-filer answer leaves the previous return unrequired end to end", () => {
  assert.deepEqual(
    filerStatusGate({ status: "NON_ATL", taxYear: 2026, previousReturn: null }),
    { ok: true, blockers: [] },
  );
});

test("Filing Summary separates who is filing from the taxpayer-list answer", () => {
  assert.match(wizard, /label: "Filing for"/);
  assert.match(wizard, /label: "Filer status"/);
  assert.equal(/label: "Filer", value: filerType/.test(wizard), false);
});

// ---- 6. regression: the Continue button must re-enable on selection -------
test("the Continue gate recomputes when the filer answer changes", () => {
  // Real bug seen on the user's screen: a card was tapped, the answer was set,
  // yet Continue stayed grey. The step's branch was right; the memo's
  // dependency list was missing filerStatus, so it never recomputed.
  const start = wizard.indexOf("const canGoNext = useMemo");
  assert.ok(start > 0, "canGoNext memo exists");
  const end = wizard.indexOf("]);", start);
  const block = wizard.slice(start, end);
  assert.match(block, /currentStepKey === "filer_status"\) return Boolean\(filerStatus\)/);
  assert.match(block, /\n    filerStatus,/, "filerStatus is a dependency of canGoNext");

  const submitStart = wizard.indexOf("const canSubmit = useMemo");
  const submitBlock = wizard.slice(submitStart, wizard.indexOf("]);", submitStart));
  assert.match(submitBlock, /if \(!filerStatus\) return false;/);
  assert.match(submitBlock, /\n    filerStatus,/, "filerStatus is a dependency of canSubmit");
});

// ---- 7. no contradictory wording on the slot ------------------------------
test("the title stops saying Optional once the Filer answer makes it required", () => {
  // Reported on screen 28-Oct: the slot read "Previous Year Tax Return
  // (Optional)" next to a "Required — you answered Filer" badge.
  const documents = fs.readFileSync(
    path.join(root, "components/tax/filing/wizard-documents-step.tsx"),
    "utf8",
  );
  assert.match(
    documents,
    /slotRequired && slot\.documentType === "previous_return"\s*\? slot\.label\.replace\(/,
  );
  assert.match(documents, /\{\{slotLabel\}\}|\{slotLabel\}/);
  // the base label keeps "(Optional)" so a non-filer still reads it as optional
  const requirements = fs.readFileSync(
    path.join(root, "lib/tax/document-requirements.ts"),
    "utf8",
  );
  assert.match(requirements, /Previous Year Tax Return \(Optional\)/);
});
