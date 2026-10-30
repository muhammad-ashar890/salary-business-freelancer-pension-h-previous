// Exercise the real server action, not a mirror of its pension-answer lookup.
// Only session/database/reconciliation/notification services are stubbed.
// No PostgreSQL, Gemini, browser, or live FBR connection is required.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { Prisma } = require("@prisma/client");

const root = path.resolve(__dirname, "..");
const compiled = new Map();
const FORMER_EMPLOYER = "former-employer-or-associate";
const FORMER_EMPLOYER_RULE = "TY2026-149IA-PENSION-FORMER-EMPLOYER-OR-ASSOCIATE";
const EXEMPT_PENSION_RULE = "TY2026-149IA-PENSION-UP-TO-10M";
const BELOW_70_PENSION_RULE = "TY2026-149IA-PENSION-ABOVE-10M-BELOW-AGE-70";

// Isolate each action's module cache and service doubles. The calculator,
// persisted-details parser, age rules, withholding, and Decimal helpers stay real.
function moduleLoader(mocks) {
  const cache = new Map();
  function load(name, parent = root) {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    const absolute = name.startsWith("@/")
      ? path.join(root, name.slice(2))
      : name.startsWith(".")
        ? path.resolve(parent, name)
        : path.isAbsolute(name)
          ? name
          : null;
    if (!absolute) return require(name);
    const file =
      fs.existsSync(absolute) && fs.statSync(absolute).isFile()
        ? absolute
        : `${absolute}.ts`;
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    if (!compiled.has(file)) {
      compiled.set(
        file,
        ts.transpileModule(fs.readFileSync(file, "utf8"), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            esModuleInterop: true,
          },
          fileName: file,
        }).outputText,
      );
    }
    const context = vm.createContext({
      console,
      Date,
      exports: module.exports,
      module,
      require: (child) => load(child, path.dirname(file)),
    });
    vm.runInContext(compiled.get(file), context, { filename: file });
    return module.exports;
  }
  return (name) => load(path.join(root, name));
}

function actionHarness({
  answer = false,
  pension = 1_989_000,
  dateOfBirth = "1970-01-01",
  salary = 0,
} = {}) {
  const calls = { draftUpdates: [], calculationLines: [] };
  const draft = {
    id: "pension-test-draft",
    userId: "pension-test-user",
    taxYear: 2026,
    filerType: "myself",
    salaryPercentage: null,
    taxWithheld: new Prisma.Decimal(0),
    incomeSources: JSON.stringify(salary > 0 ? ["salary", "pension"] : ["pension"]),
    incomeSelections: [],
  };
  function setAnswer(nextAnswer) {
    draft.incomeSelections = [
      {
        source: "pension",
        subcategory:
          pension <= 10_000_000
            ? "pension-up-to-10m"
            : "pension-above-10m-below-age-70",
        detailsJson: "{}",
      },
      ...(nextAnswer === "unanswered"
        ? []
        : [{
            source: "pension",
            subcategory: FORMER_EMPLOYER,
            // This is the same envelope persisted by replaceIncomeSelections.
            detailsJson: nextAnswer === "legacy"
              ? "{}"
              : JSON.stringify({
                  userDetails: { worksForFormerEmployerOrAssociate: nextAnswer },
                }),
          }]),
      ...(salary > 0
        ? [{ source: "salary", subcategory: "salary", detailsJson: "{}" }]
        : []),
    ];
  }
  setAnswer(answer);
  const entries = [
    { entryType: "INCOME", category: "PENSION", amount: new Prisma.Decimal(pension), description: "Synthetic annual pension" },
    ...(salary > 0
      ? [{ entryType: "INCOME", category: "SALARY", amount: new Prisma.Decimal(salary), description: "Synthetic salary cash movement" }]
      : []),
  ];
  const prisma = {
    user: {
      findUnique: async ({ where }) => {
        assert.equal(where.email, "pension-test@example.invalid");
        return {
          id: draft.userId,
          dateOfBirth: dateOfBirth === null ? null : new Date(`${dateOfBirth}T00:00:00.000Z`),
        };
      },
    },
    filingDraft: {
      findFirst: async ({ where }) => {
        assert.equal(where.id, draft.id);
        assert.equal(where.userId, draft.userId);
        return draft;
      },
      update: async ({ where, data }) => {
        assert.equal(where.id, draft.id);
        calls.draftUpdates.push(data);
        Object.assign(draft, data);
        return draft;
      },
    },
    ledgerEntry: { findMany: async () => entries },
    document: {
      // v2: pension pricing comes from a reviewed annual statement, not the
      // ledger. The mock serves a MAPPED gross-only statement so these tests
      // keep exercising Yes/No slab routing under the shipped source rules.
      findFirst: async ({ where } = {}) => where?.documentType === "pension_statement" ? {
        id: "pension-doc",
        extractionStatus: "MAPPED",
        extractedData: JSON.stringify({ fields: [
          { label: "Tax Year", value: 2026 },
          { label: "Gross Pension (Annual PKR)", value: pension },
          { label: "Pension Tax Deducted (Annual PKR)", value: 0 },
        ] }),
      } : salary > 0 ? {
        extractedData: JSON.stringify({ fields: [
          { label: "Gross Salary", value: salary },
          { label: "Tax Deducted u/s 149", value: 0 },
          { label: "Tax Year", value: 2026 },
          { label: "Employer Name (as registered with FBR)", value: "Synthetic employer" },
        ] }),
      } : null,
    },
    filingTaxCalculationLine: {
      deleteMany: async () => { calls.calculationLines = []; return { count: 0 }; },
      createMany: async ({ data }) => { calls.calculationLines = data; return { count: data.length }; },
    },
    filingPacket: { updateMany: async () => ({ count: 0 }) },
    localAgentJob: { updateMany: async () => ({ count: 0 }) },
    fbrConnection: { updateMany: async () => ({ count: 0 }) },
    $transaction: async (callback) => callback(prisma),
  };
  const load = moduleLoader({
    "next-auth/next": {
      getServerSession: async () => ({ user: { email: "pension-test@example.invalid" } }),
    },
    "@/lib/auth": { authOptions: {} },
    "@/lib/prisma": { prisma },
    "@/lib/tax/reconciliation-calculation": {
      validateAuthoritativeReconciliation: async () => ({ success: true, preview: {} }),
    },
    "@/app/actions/notifications": { createNotification: async () => {} },
  });
  const { calculateTaxAction } = load("app/actions/tax-calculation.ts");
  return {
    calls,
    setAnswer,
    run: (filerStatus = "ATL") => calculateTaxAction(draft.id, filerStatus),
  };
}

async function estimate(harness, expectedTax, filerStatus = "ATL") {
  const response = await harness.run(filerStatus);
  assert.equal(response.success, true, response.error);
  assert.equal(response.result.status, "ESTIMATE", response.result.note);
  assert.equal(response.result.taxDue, expectedTax);
  assert.equal(response.result.taxPayable, expectedTax);
  assert.equal(response.result.refundDue, 0);
  const persisted = harness.calls.draftUpdates.at(-1);
  assert.equal(persisted.taxCalculationStatus, "ESTIMATE");
  assert.equal(persisted.taxPayable, expectedTax);
  assert.equal(persisted.taxCalculationRevision, response.calculationRevision);
  assert.equal(
    harness.calls.calculationLines.reduce((sum, line) => sum + line.calculatedTax, 0),
    expectedTax,
  );
  return response.result;
}

for (const filerStatus of ["ATL", "LATE_FILER", "NON_ATL"]) {
  test(`saved No uses pension exemption, not salary slabs (${filerStatus})`, async () => {
    const result = await estimate(actionHarness({ answer: false }), 0, filerStatus);
    assert.ok(result.appliedRuleIds.includes(EXEMPT_PENSION_RULE));
    assert.ok(!result.appliedRuleIds.includes(FORMER_EMPLOYER_RULE));
    assert.equal(result.isFinalTax, true);
  });
}

test("saved Yes still uses salary slabs for the pension", async () => {
  const result = await estimate(actionHarness({ answer: true }), 92_790);
  assert.ok(result.appliedRuleIds.includes(FORMER_EMPLOYER_RULE));
  assert.equal(result.isFinalTax, false);
});

test("legacy former-employer selection without a marker retains Yes behavior", async () => {
  const result = await estimate(actionHarness({ answer: "legacy" }), 92_790);
  assert.ok(result.appliedRuleIds.includes(FORMER_EMPLOYER_RULE));
});

test("no former-employer selection does not invent a Yes answer", async () => {
  const result = await estimate(actionHarness({ answer: "unanswered" }), 0);
  assert.ok(result.appliedRuleIds.includes(EXEMPT_PENSION_RULE));
});

test("saved No keeps an up-to-limit pension exempt even when age is unknown", async () => {
  await estimate(actionHarness({ answer: false, dateOfBirth: null }), 0);
});

test("saved No preserves exemption at exactly PKR 10 million", async () => {
  const result = await estimate(actionHarness({ answer: false, pension: 10_000_000 }), 0);
  assert.ok(result.appliedRuleIds.includes(EXEMPT_PENSION_RULE));
});

test("saved No above PKR 10 million uses below-70 pension tax plus its existing surcharge", async () => {
  const result = await estimate(actionHarness({ answer: false, pension: 12_000_000 }), 110_000);
  assert.equal(result.baseTax, 100_000);
  assert.equal(result.surcharge, 10_000);
  assert.ok(result.appliedRuleIds.includes(BELOW_70_PENSION_RULE));
  assert.ok(!result.appliedRuleIds.includes(FORMER_EMPLOYER_RULE));
});

test("saved No above PKR 10 million retains the existing age-70-plus exemption", async () => {
  const result = await estimate(actionHarness({ answer: false, pension: 12_000_000, dateOfBirth: "1950-01-01" }), 0);
  assert.ok(!result.appliedRuleIds.includes(FORMER_EMPLOYER_RULE));
});

test("saved No above PKR 10 million with unknown age still requests rules instead of salary tax", async () => {
  const harness = actionHarness({ answer: false, pension: 12_000_000, dateOfBirth: null });
  const response = await harness.run();
  assert.equal(response.success, true, response.error);
  assert.equal(response.result.status, "NEEDS_RULES");
  assert.equal(response.result.taxDue, null);
  assert.equal(response.result.taxPayable, null);
  assert.match(response.result.note, /date of birth/i);
  assert.equal(harness.calls.draftUpdates.at(-1).taxCalculationStatus, "NEEDS_RULES");
});

test("saved No keeps exempt pension out of the combined salary slab", async () => {
  const result = await estimate(actionHarness({ answer: false, salary: 2_000_000 }), 94_000);
  assert.equal(result.breakdown.length, 2);
  assert.equal(result.breakdown.find((line) => line.route === "pension").taxDue, 0);
  assert.equal(result.breakdown.find((line) => line.route === "salary").taxDue, 94_000);
  assert.ok(!result.breakdown.some((line) => line.route === "combined_slab"));
});

test("saved Yes still combines working pension with salary", async () => {
  const result = await estimate(actionHarness({ answer: true, salary: 2_000_000 }), 582_700);
  assert.equal(result.breakdown.length, 1);
  assert.equal(result.breakdown[0].route, "combined_slab");
  assert.ok(result.appliedRuleIds.includes(FORMER_EMPLOYER_RULE));
});

test("recalculating after Yes → No → Yes reads the latest persisted answer", async () => {
  const harness = actionHarness({ answer: true });
  await estimate(harness, 92_790);
  harness.setAnswer(false);
  await estimate(harness, 0);
  harness.setAnswer(true);
  await estimate(harness, 92_790);
  assert.equal(new Set(harness.calls.draftUpdates.map((update) => update.taxCalculationRevision)).size, 3);
});
