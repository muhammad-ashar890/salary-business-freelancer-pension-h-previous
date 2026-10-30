#!/usr/bin/env node
/**
 * One income source, one filing per tax year (28-Oct-2026, operator rule).
 *
 * A Salary return is the same return whether it is started today or next week,
 * so a second draft for the same year and the same sources must never be
 * created. The existing filing is opened instead; if it is already approved or
 * filed it is not touched either, and the setup step explains why.
 *
 * Different sources (Salary + Business) and different years are unaffected.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");
const ts = require("typescript");
const Module = require("node:module");

const root = path.join(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  module._compile(output, filename);
};

const {
  findFilingForIncomeSources,
  pickReusableDraft,
  numberFilingsPerYear,
} = require("../lib/tax/filing-draft-identity.ts");

const day = (n) => new Date(Date.UTC(2026, 9, n));
const src = (list) => JSON.stringify(list);

const approvedSalary = {
  id: "salary-approved",
  taxYear: 2026,
  status: "APPROVED_FOR_FILING",
  updatedAt: day(20),
  incomeSources: src(["salary"]),
};
const openPension = {
  id: "pension-open",
  taxYear: 2026,
  status: "IN_PROGRESS",
  updatedAt: day(12),
  incomeSources: src(["pension"]),
};
const oldYearSalary = {
  id: "salary-2025",
  taxYear: 2025,
  status: "APPROVED_FOR_FILING",
  updatedAt: day(1),
  incomeSources: src(["salary"]),
};

test("an approved Salary filing is found, so no second Salary draft is created", () => {
  const found = findFilingForIncomeSources(
    [approvedSalary, openPension, oldYearSalary],
    2026,
    ["salary"],
  );
  assert.equal(found?.id, "salary-approved");
});

test("nothing blocks a source with no filing for that year", () => {
  assert.equal(
    findFilingForIncomeSources([approvedSalary, oldYearSalary], 2026, ["business"]),
    null,
  );
});

test("another year does not block this year", () => {
  assert.equal(
    findFilingForIncomeSources([oldYearSalary], 2026, ["salary"]),
    null,
  );
  assert.equal(
    findFilingForIncomeSources([oldYearSalary], 2025, ["salary"])?.id,
    "salary-2025",
  );
});

test("an unfinished filing of the same source is continued, not duplicated", () => {
  const openSalary = {
    id: "salary-open",
    taxYear: 2026,
    status: "IN_PROGRESS",
    updatedAt: day(21),
    incomeSources: src(["salary"]),
  };
  const drafts = [approvedSalary, openSalary];
  assert.equal(pickReusableDraft(drafts, ["salary"])?.id, "salary-open");
  // The guard only runs when nothing can be continued, so it never fires here.
  assert.equal(
    findFilingForIncomeSources([approvedSalary], 2026, ["salary"])?.id,
    "salary-approved",
  );
});

test("source order and duplicates do not change the answer", () => {
  const salaryBusiness = {
    id: "salary-business",
    taxYear: 2026,
    status: "APPROVED_FOR_FILING",
    updatedAt: day(9),
    incomeSources: src(["salary", "business"]),
  };
  assert.equal(
    findFilingForIncomeSources([salaryBusiness], 2026, ["business", "salary"])?.id,
    "salary-business",
  );
  // A combined filing does not block a single-source one, and must not be
  // reported as a duplicate of it either.
  assert.equal(
    findFilingForIncomeSources([salaryBusiness], 2026, ["salary"]),
    null,
  );
});

test("a draft with no income sources yet never blocks anything", () => {
  const empty = {
    id: "empty",
    taxYear: 2026,
    status: "IN_PROGRESS",
    updatedAt: day(3),
    incomeSources: src([]),
  };
  assert.equal(findFilingForIncomeSources([empty], 2026, ["salary"]), null);
});

test("the create path refuses instead of inserting a second draft", () => {
  const action = fs.readFileSync(path.join(root, "app/actions/filing.ts"), "utf8");
  const guard = action.indexOf("const existing = findFilingForIncomeSources(");
  const insert = action.indexOf("tx.filingDraft.create(");
  assert.ok(guard > 0, "the guard is missing from the save path");
  assert.ok(
    guard < insert || insert < 0,
    "the guard must run before a new draft can be created",
  );
  assert.match(action, /throw new DuplicateIncomeSourceFilingError\(/);
  assert.match(action, /Each income source is filed once per tax year\./);
  assert.match(action, /Open that filing from Filing History/);
});

test("the setup step shows the refusal instead of failing silently", () => {
  const wizard = fs.readFileSync(
    path.join(root, "components/tax/filing/filing-wizard.tsx"),
    "utf8",
  );
  assert.match(wizard, /setFilingActionError\(result\.error/);
});

test("two filings of one source that already exist stay visible and numbered", () => {
  const drafts = [
    { ...approvedSalary, createdAt: day(14) },
    { ...approvedSalary, id: "salary-second", createdAt: day(28) },
  ];
  const numbering = numberFilingsPerYear(drafts);
  assert.deepEqual(numbering.get("salary-approved"), { position: 1, total: 2 });
  assert.deepEqual(numbering.get("salary-second"), { position: 2, total: 2 });
});
