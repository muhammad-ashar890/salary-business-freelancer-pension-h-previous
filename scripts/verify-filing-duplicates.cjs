#!/usr/bin/env node
/**
 * Duplicate filings in History (TY2026, 28-Oct-2026).
 *
 * The real database showed four TY2026 drafts for one user, two of them Salary,
 * and no Pension draft at all. Two rules are pinned here:
 *
 *   1. A save may only continue an unfinished draft of the SAME income source.
 *      Before this, starting a Salary filing could reuse an unfinished Pension
 *      draft and rename it, so the Pension filing vanished from History while
 *      its documents stayed on the draft.
 *   2. Two filings of one year with one income source are allowed (the older one
 *      is usually the filed return, which must never be overwritten), but they
 *      are labelled on screen as "Same income as Filing N".
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
  pickReusableDraft,
  draftAcceptsIncomeSources,
  draftIncomeSources,
  sameSourceFilingIds,
  numberFilingsPerYear,
} = require("../lib/tax/filing-draft-identity.ts");

const day = (n) => new Date(Date.UTC(2026, 9, n));
const sources = (list) => (list === null ? null : JSON.stringify(list));

// ── 1. a draft of another income source is never continued ─────────────────
test("an unfinished Pension draft is not continued by a Salary save", () => {
  const drafts = [
    {
      id: "pension",
      status: "IN_PROGRESS",
      updatedAt: day(9),
      incomeSources: sources(["pension"]),
    },
  ];
  assert.equal(pickReusableDraft(drafts, ["salary"]), null);
  assert.equal(pickReusableDraft(drafts, ["pension"])?.id, "pension");
});

test("a draft with no source chosen yet can still be continued", () => {
  const drafts = [
    { id: "empty", status: "IN_PROGRESS", updatedAt: day(2), incomeSources: sources([]) },
    { id: "null", status: "IN_PROGRESS", updatedAt: day(3), incomeSources: null },
  ];
  assert.equal(pickReusableDraft(drafts, ["salary"])?.id, "null");
  assert.equal(pickReusableDraft(drafts, ["business"])?.id, "null");
});

test("source order and duplicates do not matter", () => {
  assert.equal(
    draftAcceptsIncomeSources({ incomeSources: sources(["salary", "business"]) }, [
      "business",
      "salary",
      "salary",
    ]),
    true,
  );
  assert.equal(
    draftAcceptsIncomeSources({ incomeSources: sources(["salary"]) }, [
      "salary",
      "business",
    ]),
    false,
  );
});

test("an unreadable incomeSources value is never overwritten", () => {
  assert.equal(draftIncomeSources("not json"), null);
  assert.equal(draftIncomeSources('{"a":1}'), null);
  assert.equal(draftAcceptsIncomeSources({ incomeSources: "not json" }, ["salary"]), false);
});

test("a save that carries no source does not grab a sourced draft", () => {
  assert.equal(
    draftAcceptsIncomeSources({ incomeSources: sources(["business"]) }, []),
    false,
  );
});

test("an approved Salary filing is never reused, and a new Salary draft is created", () => {
  const drafts = [
    {
      id: "approved-salary",
      status: "APPROVED_FOR_FILING",
      updatedAt: day(9),
      incomeSources: sources(["salary"]),
    },
    {
      id: "open-business",
      status: "IN_PROGRESS",
      updatedAt: day(8),
      incomeSources: sources(["business"]),
    },
  ];
  // Nothing to continue for Salary: the approved return is protected.
  assert.equal(pickReusableDraft(drafts, ["salary"]), null);
  // Business still has its own unfinished draft.
  assert.equal(pickReusableDraft(drafts, ["business"])?.id, "open-business");
});

test("the caller that omits the sources keeps the old behaviour", () => {
  const drafts = [
    {
      id: "pension",
      status: "IN_PROGRESS",
      updatedAt: day(9),
      incomeSources: sources(["pension"]),
    },
  ];
  assert.equal(pickReusableDraft(drafts)?.id, "pension");
});

// ── 2. the duplicate is labelled, not hidden ───────────────────────────────
test("two Salary filings of one year point at each other", () => {
  const drafts = [
    {
      id: "filing-1",
      taxYear: 2026,
      createdAt: day(14),
      incomeSources: sources(["salary"]),
      status: "APPROVED_FOR_FILING",
    },
    {
      id: "filing-3b",
      taxYear: 2026,
      createdAt: day(26),
      incomeSources: sources(["business"]),
      status: "APPROVED_FOR_FILING",
    },
    {
      id: "filing-4",
      taxYear: 2026,
      createdAt: day(28),
      incomeSources: sources(["salary"]),
      status: "APPROVED_FOR_FILING",
    },
  ];
  const numbering = numberFilingsPerYear(drafts);
  const peers = sameSourceFilingIds(drafts, "filing-4");
  assert.deepEqual(peers, ["filing-1"]);
  assert.equal(numbering.get(peers[0]).position, 1);
  assert.deepEqual(sameSourceFilingIds(drafts, "filing-3b"), []);
  assert.deepEqual(sameSourceFilingIds(drafts, "filing-1"), ["filing-4"]);
});

test("a different tax year is not a duplicate", () => {
  const drafts = [
    { id: "a", taxYear: 2026, createdAt: day(1), incomeSources: sources(["salary"]) },
    { id: "b", taxYear: 2025, createdAt: day(2), incomeSources: sources(["salary"]) },
  ];
  assert.deepEqual(sameSourceFilingIds(drafts, "a"), []);
});

test("a draft with no income sources is never called a duplicate", () => {
  const drafts = [
    { id: "a", taxYear: 2026, createdAt: day(1), incomeSources: sources([]) },
    { id: "b", taxYear: 2026, createdAt: day(2), incomeSources: sources([]) },
  ];
  assert.deepEqual(sameSourceFilingIds(drafts, "a"), []);
  assert.deepEqual(sameSourceFilingIds(drafts, "b"), []);
});

// ── 3. the screens really use it ───────────────────────────────────────────
test("the save path passes the income sources into the reuse decision", () => {
  const action = fs.readFileSync(path.join(root, "app/actions/filing.ts"), "utf8");
  assert.match(
    action,
    /resolveTargetDraftId\(\s*tx,\s*userId,\s*input\.taxYear,\s*explicitDraftId,\s*input\.incomeSources,/,
    "resolveTargetDraftId must receive input.incomeSources",
  );
  assert.match(action, /pickReusableDraft\(sameYear, incomingIncomeSources\)/);
  assert.match(action, /incomeSources: true,\n\s+filingPackets: \{ select: \{ approvalStatus: true \} \}/);
});

test("the History screen labels same-income filings", () => {
  const page = fs.readFileSync(path.join(root, "app/tax/history/page.tsx"), "utf8");
  const list = fs.readFileSync(
    path.join(root, "components/tax/filing-history-list.tsx"),
    "utf8",
  );
  assert.match(page, /sameSourceFilingIds\(drafts, draftId\)/);
  assert.match(page, /sameIncome: sameSourceOf\(draft\.id\)/);
  assert.match(list, /Same income as Filing/);
  const flatList = list.replace(/\s+/g, " ");
  assert.ok(
    flatList.includes(
      "They are separate returns: nothing was deleted or overwritten.",
    ),
    "the History card must say the filings are separate returns, in English",
  );
});
