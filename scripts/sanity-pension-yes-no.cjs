// Sanity check for the pension Yes/No (Option A) implementation.
// Simulates the full lifecycle: wizard answer -> save validation -> detailsJson
// persistence -> calculator's pensionTaxAsSalary read.
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithAlias(request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolveFilename.call(this, request, ...rest);
};
Module._extensions[".ts"] = function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const {
  resolvePensionFormerEmployerAnswer,
  resolveTy2026IncomeSelections,
  parsePersistedSelectionUserDetails,
  TY2026_PENSION_FORMER_EMPLOYER_SUBCATEGORY,
} = require("../lib/tax/rules/ty2026/subcategories.ts");

let passed = 0;
function ok(value, label) {
  if (!value) throw new Error(`FAIL: ${label}`);
  passed += 1;
  console.log(`  ok - ${label}`);
}

// ── 1. Answer resolver semantics ──
ok(resolvePensionFormerEmployerAnswer(undefined) === null, "unanswered -> null");
ok(
  resolvePensionFormerEmployerAnswer({ details: { worksForFormerEmployerOrAssociate: true } }) === "yes",
  "explicit true -> yes",
);
ok(
  resolvePensionFormerEmployerAnswer({ details: { worksForFormerEmployerOrAssociate: false } }) === "no",
  "explicit false -> no",
);
ok(
  resolvePensionFormerEmployerAnswer({}) === "yes",
  "legacy selection (no details) -> yes (backwards compatible)",
);

// ── 2. Wizard "No" answer survives server-side save validation ──
const noAnswer = {
  source: "pension",
  subcategory: TY2026_PENSION_FORMER_EMPLOYER_SUBCATEGORY,
  details: { worksForFormerEmployerOrAssociate: false },
};
const resolved = resolveTy2026IncomeSelections({
  incomeSources: ["pension"],
  selections: [noAnswer],
  requireComplete: true,
});
ok(resolved.success === true, "explicit-No selection passes save validation");
const savedSelection = resolved.selections.find(
  (s) => s.subcategory === TY2026_PENSION_FORMER_EMPLOYER_SUBCATEGORY,
);
ok(
  savedSelection?.details?.worksForFormerEmployerOrAssociate === false,
  "false marker survives sanitizeSelectionDetails (not stripped/dropped)",
);

// ── 3. detailsJson persistence round-trip (what filing.ts replaceIncomeSelections writes) ──
const detailsJson = JSON.stringify({
  ...(savedSelection ? {} : {}),
  userDetails: savedSelection.details,
});
const hydrated = parsePersistedSelectionUserDetails(detailsJson);
ok(
  hydrated?.worksForFormerEmployerOrAssociate === false,
  "false marker round-trips through detailsJson persistence",
);
ok(
  resolvePensionFormerEmployerAnswer({ details: hydrated }) === "no",
  "hydrated selection still resolves to no",
);

// ── 4. Calculator semantics (mirror of app/actions/tax-calculation.ts) ──
function pensionTaxAsSalary(hasSelection, details) {
  const answer = hasSelection
    ? resolvePensionFormerEmployerAnswer({ details })
    : null;
  return answer === "yes";
}
ok(
  pensionTaxAsSalary(true, { worksForFormerEmployerOrAssociate: false }) === false,
  "confirmed No -> pension priced on PENSION bands (not salary slabs)",
);
ok(
  pensionTaxAsSalary(true, { worksForFormerEmployerOrAssociate: true }) === true,
  "confirmed Yes -> pension priced on SALARY slabs (Section 149)",
);
ok(
  pensionTaxAsSalary(true, undefined) === true,
  "legacy yes (no details) -> salary slabs, unchanged from before",
);
ok(
  pensionTaxAsSalary(false, undefined) === false,
  "never answered -> pension bands (identical to old silent-skip behavior)",
);

// ── 4. Exemption-column emission for fully-exempt pensions (92,790 fix) ──
// The field map must additionally write the "Subject to Exemption" column of
// IRIS row 1008 when a pension is fully exempt (149(IA): pension ≤ 10M). IRIS
// derives "Subject to Normal Tax" as Total − Final − Exemption; without the
// exemption write the whole pension lands in Normal Income and salary slabs
// fire (observed live: 92,790 charged on a 1,989,000 exempt pension).
{
  const { buildPortalFieldMap } = require("../lib/tax/portal-field-map.ts");
  const baseParams = { taxYear: 2026, filerType: "INDIVIDUAL", taxpayerListStatus: "FILER" };
  const pensionEntry = (amount, id) => ({
    id,
    entryType: "CREDIT",
    amount,
    description: "Pension received from ex-employer",
    category: "PENSION",
    subCategory: "pension",
    year: 2026,
  });

  // Fully exempt: Total + Exemption columns must BOTH be targeted on row 1008.
  const exemptMap = buildPortalFieldMap({
    ...baseParams,
    ledgerEntries: [pensionEntry(1_989_000, "p-ex1")],
    pensionDetails: {
      totalPension: 1_989_000,
      exemptLimit: 10_000_000,
      exemptAmount: 1_989_000,
      taxableAmount: 0,
      age: 71,
    },
  });
  const exemptFields = exemptMap.incomeFields.filter((f) => f.irisCode === "1008");
  ok(
    exemptFields.some((f) => f.column === "Total Amount" && f.ourAmount === 1_989_000),
    "fully-exempt pension still writes the Total column on 1008",
  );
  const exemptionTarget = exemptFields.find((f) => f.column === "Subject to Exemption");
  ok(
    !!exemptionTarget && exemptionTarget.ourAmount === 1_989_000,
    "fully-exempt pension emits 1008:Subject to Exemption = 1,989,000",
  );
  ok(
    !!exemptionTarget && exemptionTarget.isTaxField === false,
    "exemption entry is an income field, not a tax field",
  );

  // Partially taxed pension (>10M): NO exemption write (deferred gap).
  const mixedMap = buildPortalFieldMap({
    ...baseParams,
    ledgerEntries: [pensionEntry(12_000_000, "p-mix1")],
    pensionDetails: {
      totalPension: 12_000_000,
      exemptLimit: 10_000_000,
      exemptAmount: 10_000_000,
      taxableAmount: 2_000_000,
      age: 71,
    },
  });
  ok(
    !mixedMap.incomeFields.some(
      (f) => f.irisCode === "1008" && f.column === "Subject to Exemption",
    ),
    "partially-taxed pension (>10M) does NOT get an exemption write",
  );

  // The exempt amount is the ENGINE total, emitted once — twelve monthly
  // pension credits must NOT replicate it twelve times over.
  const monthlyMap = buildPortalFieldMap({
    ...baseParams,
    ledgerEntries: [
      pensionEntry(165_750, "p-m1"),
      pensionEntry(165_750, "p-m2"),
      pensionEntry(165_750, "p-m3"),
      pensionEntry(165_750, "p-m4"),
      pensionEntry(165_750, "p-m5"),
      pensionEntry(165_750, "p-m6"),
      pensionEntry(165_750, "p-m7"),
      pensionEntry(165_750, "p-m8"),
      pensionEntry(165_750, "p-m9"),
      pensionEntry(165_750, "p-m10"),
      pensionEntry(165_750, "p-m11"),
      pensionEntry(165_750, "p-m12"),
    ],
    pensionDetails: {
      totalPension: 1_989_000,
      exemptLimit: 10_000_000,
      exemptAmount: 1_989_000,
      taxableAmount: 0,
      age: 71,
    },
  });
  const monthlyExemption = monthlyMap.incomeFields.filter(
    (f) => f.irisCode === "1008" && f.column === "Subject to Exemption",
  );
  ok(
    monthlyExemption.length === 1 && monthlyExemption[0].ourAmount === 1_989_000,
    "12 monthly pension credits fold into ONE exemption write of 1,989,000",
  );
  ok(
    monthlyMap.incomeFields.some(
      (f) => f.irisCode === "1008" && f.column === "Total Amount" && f.ourAmount === 1_989_000,
    ),
    "12 monthly credits still aggregate into ONE Total write of 1,989,000",
  );

  // No pension details at all: no exemption leakage.
  const salaryOnlyMap = buildPortalFieldMap({
    ...baseParams,
    ledgerEntries: [
      {
        id: "s-1",
        entryType: "CREDIT",
        amount: 2_184_000,
        description: "Salary",
        category: "SALARY",
        subCategory: "salary",
        year: 2026,
      },
    ],
  });
  ok(
    !salaryOnlyMap.incomeFields.some((f) => f.column === "Subject to Exemption"),
    "no pensionDetails -> never an exemption entry",
  );
}

console.log(`\npension Yes/No sanity: ${passed} assertions passed`);