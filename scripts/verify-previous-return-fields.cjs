// Previous-return carry-forward, Phase 2 (server): the review-field contract
// for an uploaded Previous Year Tax Return, its wealth tie-out, and the
// "uploaded but unapproved blocks the filing" gate wiring.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const oldResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return oldResolve.call(
    this,
    r.startsWith("@/") ? path.join(root, r.slice(2)) : r,
    ...a,
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

const review = require("../lib/tax/document-review-required.ts");
const prev = require("../lib/tax/previous-return-fields.ts");
const textParser = require("../lib/tax/previous-return-text.ts");
const fields = (o) =>
  Object.entries(o).map(([label, value]) => ({ label, value, confidence: 90 }));

// Synthetic TY2025 return, reviewed while filing TY2026. Wealth ties out:
// 8,780,220 assets - 0 liabilities = 8,780,220 net assets.
const good = {
  "Taxpayer Name": "SYNTHETIC TEST TAXPAYER",
  "Registration No": "42201-1234567-1",
  "Tax Year": 2025,
  "Total Assets (7019)": 8_780_220,
  "Total Liabilities (7029)": 0,
  "Net Assets (703001)": 8_780_220,
  "Cash in Hand (7012)": 280_554,
};

test("previous_return: complete TY2025 fixture passes while filing TY2026", () => {
  assert.deepEqual(
    review.getDocumentReviewRequiredErrors(
      "previous_return",
      fields(good),
      2026,
    ),
    [],
  );
});

for (const key of prev.PREVIOUS_RETURN_REQUIRED_KEYS) {
  const label = prev.PREVIOUS_RETURN_LABELS[key];
  // Total Liabilities is the one required figure the printed form lets us
  // derive: IRIS prints 7029 with an empty cell when the total is nil, and the
  // identity 7019 - 7029 = 703001 proves that zero. It is covered by its own
  // two tests below (derived when assets equal net assets, refused otherwise).
  if (key === "totalLiabilities") continue;
  test(`previous_return: missing ${label} is a review error`, () => {
    const copy = { ...good, [label]: null };
    const errs = review.getDocumentReviewRequiredErrors(
      "previous_return",
      fields(copy),
      2026,
    );
    assert.ok(
      errs.some((e) => e.startsWith(label)),
      JSON.stringify(errs),
    );
  });
}

test("previous_return: blank 7029 with assets equal to net assets derives nil liabilities", () => {
  for (const blank of [null, ""]) {
    const errs = review.getDocumentReviewRequiredErrors(
      "previous_return",
      fields({ ...good, "Total Liabilities (7029)": blank }),
      2026,
    );
    assert.deepEqual(errs, []);
    const snapshot = prev.parsePreviousReturnFields(
      fields({ ...good, "Total Liabilities (7029)": blank }),
      2026,
    );
    assert.equal(snapshot.totalLiabilities, 0);
  }
});

for (const badYear of [2026, 2027]) {
  test(`previous_return: Tax Year ${badYear} refused for a TY2026 filing (must be earlier)`, () => {
    const errs = review.getDocumentReviewRequiredErrors(
      "previous_return",
      fields({ ...good, "Tax Year": badYear }),
      2026,
    );
    assert.ok(
      errs.some((e) => e.includes("earlier than this filing")),
      JSON.stringify(errs),
    );
  });
}

test("previous_return: an older gap-year return (TY2024 for TY2026) is accepted", () => {
  assert.deepEqual(
    review.getDocumentReviewRequiredErrors(
      "previous_return",
      fields({ ...good, "Tax Year": 2024 }),
      2026,
    ),
    [],
  );
});

test("previous_return: wealth tie-out enforced (assets - liabilities = net assets)", () => {
  const errs = review.getDocumentReviewRequiredErrors(
    "previous_return",
    fields({ ...good, "Net Assets (703001)": 8_000_000 }),
    2026,
  );
  assert.ok(
    errs.some((e) => e.includes("do not tie out")),
    JSON.stringify(errs),
  );
});

test("previous_return: negative net assets allowed when liabilities exceed assets and tie out", () => {
  assert.deepEqual(
    review.getDocumentReviewRequiredErrors(
      "previous_return",
      fields({
        ...good,
        "Total Assets (7019)": 1_000_000,
        "Total Liabilities (7029)": 1_500_000,
        "Net Assets (703001)": -500_000,
      }),
      2026,
    ),
    [],
  );
});

test("previous_return: Registration No must be 13 digits (dashes forgiven)", () => {
  for (const bad of ["422011234567", "42201-1234567-12", "not-a-number"]) {
    const errs = review.getDocumentReviewRequiredErrors(
      "previous_return",
      fields({ ...good, "Registration No": bad }),
      2026,
    );
    assert.ok(
      errs.some((e) => e.includes("13-digit")),
      `${bad}: ${JSON.stringify(errs)}`,
    );
  }
});

test("previous_return: comma-formatted printed amounts parse; aliases resolve", () => {
  const { "Net Assets (703001)": _dropped, ...rest } = good;
  const errs = review.getDocumentReviewRequiredErrors(
    "previous_return",
    fields({
      ...rest,
      "Total Assets (7019)": "8,780,220",
      "Net Assets Current Year (703001)": "8,780,220",
    }),
    2026,
  );
  assert.deepEqual(errs, []);
});

test("previous_return: duplicate canonical fields refuse instead of picking one", () => {
  const list = fields(good);
  list.push({ label: "Net Assets", value: 1 });
  const errs = review.getDocumentReviewRequiredErrors(
    "previous_return",
    list,
    2026,
  );
  assert.ok(
    errs.some((e) => e.includes("duplicate")),
    JSON.stringify(errs),
  );
});

test("previous_return: absent required fields get blank placeholders, never inferred values (optional Cash is not created)", () => {
  const payload = { fields: [] };
  const got = review.ensureRequiredDocumentReviewFields(
    "previous_return",
    payload,
  );
  assert.equal(got.fields.length, prev.PREVIOUS_RETURN_REQUIRED_KEYS.length);
  assert.ok(got.fields.every((f) => f.value === null));
  assert.ok(
    !got.fields.some((f) => f.label === prev.PREVIOUS_RETURN_LABELS.cashInHand),
  );
  assert.equal(payload.fields.length, 0);
});

test("previous_return: required flag shows on the six required labels only", () => {
  for (const key of prev.PREVIOUS_RETURN_REQUIRED_KEYS)
    assert.equal(
      review.isDocumentReviewRequiredField(
        "previous_return",
        prev.PREVIOUS_RETURN_LABELS[key],
      ),
      true,
    );
  assert.equal(
    review.isDocumentReviewRequiredField(
      "previous_return",
      prev.PREVIOUS_RETURN_LABELS.cashInHand,
    ),
    false,
  );
});

test("previous_return: stored-extraction errors surface; malformed JSON refuses", () => {
  assert.deepEqual(
    review.storedDocumentReviewRequiredErrors(
      "previous_return",
      JSON.stringify({ fields: fields(good) }),
      2026,
    ),
    [],
  );
  assert.ok(
    review.storedDocumentReviewRequiredErrors(
      "previous_return",
      "invalid JSON",
      2026,
    ).length,
  );
  assert.ok(
    review
      .storedDocumentReviewRequiredErrors(
        "previous_return",
        JSON.stringify({ fields: fields({ ...good, "Tax Year": 2026 }) }),
        2026,
      )
      .some((e) => e.includes("earlier than this filing")),
  );
});

test("previous_return: parser returns the typed carry-forward snapshot, else null", () => {
  const parsed = prev.parsePreviousReturnFields(fields(good), 2026);
  assert.deepEqual(parsed, {
    taxpayerName: "SYNTHETIC TEST TAXPAYER",
    registrationNo: "4220112345671",
    taxYear: 2025,
    totalAssets: 8_780_220,
    totalLiabilities: 0,
    netAssets: 8_780_220,
    cashInHand: 280_554,
    wealthRows: [],
  });
  assert.equal(
    prev.parsePreviousReturnFields(
      fields({ ...good, "Net Assets (703001)": 5 }),
      2026,
    ),
    null,
  );
});

test("previous_return: missing liabilities AND same-year show together (no one-by-one fixing)", () => {
  // Liabilities are only treated as missing when the printed identity does not
  // prove them nil, so this fixture has assets above net assets.
  const errs = review.getDocumentReviewRequiredErrors(
    "previous_return",
    fields({
      ...good,
      "Total Assets (7019)": 8_780_220,
      "Net Assets (703001)": 8_000_000,
      "Total Liabilities (7029)": null,
      "Tax Year": 2026,
    }),
    2026,
  );
  assert.ok(
    errs.some((e) => e.startsWith("Total Liabilities (7029)")),
    JSON.stringify(errs),
  );
  assert.ok(
    errs.some((e) => e.includes("earlier than this filing")),
    JSON.stringify(errs),
  );
});

test("previous_return: Save & Approve Map is reachable (UI mappable + server branch + server-side error enforcement)", () => {
  const ui = fs.readFileSync(
    path.join(root, "components/tax/filing/wizard-documents-step.tsx"),
    "utf8",
  );
  assert.match(ui, /slot\.documentType === "previous_return" \|\|/);
  const action = fs.readFileSync(
    path.join(root, "app/actions/extraction.ts"),
    "utf8",
  );
  assert.match(action, /document\.documentType === "previous_return"/);
  assert.match(action, /"PREVIOUS_RETURN"/);
  assert.match(
    action,
    /"business_books",\s+"previous_return",\s+\]\.includes\(document\.documentType\)/,
  );
});

// Jasper-style extracted text (header columns interleave; Balance Sheet has
// its own decoy "Total Assets 3349"; 703001 prints twice; 703002 neighbours).
const irisHeader = [
  "Name:",
  "Address: SOMEWHERE",
  "SYNTHETIC TEST TAXPAYER Registration No :",
  "Medium :",
  "01-Jul-2024 - 30-Jun-2025",
  "31-Oct-2025",
  "Period :",
  "2025",
  "Due Date :",
  "Tax Year :",
  "4220112345671",
  "114(1) (Return of Income filed voluntarily for complete year)",
].join("\n");
const irisWealth = [
  "Total Assets 3349 22,450,000",
  "Cash in hand 3319 250,000",
  "Wealth Statement",
  "Personal Assets and Liabilities",
  "Description Code Amount",
  "Investments 7006 1,119,666",
  "Cash in hand 7012 280,554",
  "Total Assets 7019 8,780,220",
  "Net Assets Current Year 703001 8,780,220",
  "Reconciliation of Net Assets",
  "Net Assets Current Year 703001 8,780,220",
  "Net Assets Previous Year 703002 7,000,000",
  "Unreconciled Amount 703000 0",
].join("\n");

test("previous_return text: printed IRIS codes parse exactly (3349/703002 decoys ignored)", () => {
  const got = textParser.parseIrisPreviousReturnText(
    `${irisHeader}\n${irisWealth}`,
    irisHeader,
  );
  assert.ok(got);
  assert.equal(got.taxpayerName, "SYNTHETIC TEST TAXPAYER");
  assert.equal(got.registrationNo, "4220112345671");
  assert.equal(got.taxYear, 2025);
  assert.equal(got.totalAssets, 8_780_220);
  assert.equal(got.netAssets, 8_780_220);
  assert.equal(got.cashInHand, 280_554);
  assert.equal(got.evidence.totalAssets, "Total Assets 7019 8,780,220");
});

test("previous_return text: absent liabilities derive 0 only when no 702x rows and assets = net", () => {
  const got = textParser.parseIrisPreviousReturnText(irisWealth, irisHeader);
  assert.equal(got.totalLiabilities, 0);
  assert.equal(got.liabilitiesDerived, true);
  const explicit = textParser.parseIrisPreviousReturnText(
    irisWealth.replace(
      "Total Assets 7019 8,780,220",
      "Total Assets 7019 9,780,220\nTotal Liabilities 7029 1,000,000",
    ),
    irisHeader,
  );
  assert.equal(explicit.totalLiabilities, 1_000_000);
  assert.equal(explicit.liabilitiesDerived, false);
  const unequal = textParser.parseIrisPreviousReturnText(
    irisWealth.replaceAll("703001 8,780,220", "703001 7,780,220"),
    irisHeader,
  );
  assert.equal(unequal.totalLiabilities, null);
  assert.equal(unequal.liabilitiesDerived, false);
});

test("previous_return text: conflicting 703001 or missing Wealth Statement refuse the parse", () => {
  const conflict = irisWealth.replace(
    "Reconciliation of Net Assets\nNet Assets Current Year 703001 8,780,220",
    "Reconciliation of Net Assets\nNet Assets Current Year 703001 8,000,000",
  );
  assert.equal(
    textParser.parseIrisPreviousReturnText(conflict, irisHeader),
    null,
  );
  assert.equal(
    textParser.parseIrisPreviousReturnText("no wealth here", irisHeader),
    null,
  );
  assert.equal(textParser.parseIrisPreviousReturnText("", ""), null);
});

test("previous_return text: merge corrects the model (wrong 7019, blank 703001, alias folded)", () => {
  const parse = textParser.parseIrisPreviousReturnText(
    `${irisHeader}\n${irisWealth}`,
    irisHeader,
  );
  const merged = textParser.applyPreviousReturnTextParse(
    {
      documentType: "previous_return",
      fields: [
        { label: "Total Assets (7019)", value: 7_000_000, confidence: 1 },
        { label: "Net Assets Current Year", value: null, confidence: 1 },
        { label: "Some Other Note", value: "keep me" },
      ],
      notes: [],
    },
    parse,
  );
  assert.deepEqual(
    review.getDocumentReviewRequiredErrors(
      "previous_return",
      merged.fields,
      2026,
    ),
    [],
  );
  assert.equal(
    merged.fields.filter((f) => f.label === "Net Assets (703001)").length,
    1,
  );
  assert.equal(merged.fields.at(-1).label, "Some Other Note");
  assert.equal(merged.previousReturnTextParse.source, "iris-pdf-text");
  assert.equal(merged.previousReturnTextParse.liabilitiesDerived, true);
  assert.ok(merged.notes.some((n) => n.includes("printed IRIS codes")));
});

test("previous_return text: extraction action runs the text parser for previous_return PDFs (unpdf)", () => {
  const action = fs.readFileSync(
    path.join(root, "app/actions/extraction.ts"),
    "utf8",
  );
  assert.match(action, /from "@\/lib\/tax\/previous-return-text"/);
  assert.match(
    action,
    /document\.documentType === "previous_return" &&\s+document\.mimeType === "application\/pdf"/,
  );
  assert.match(action, /await import\("unpdf"\)/);
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  assert.ok(pkg.dependencies.unpdf);
});

test("previous_return Phase 3a: approved snapshot comes only from the newest MAPPED document", () => {
  const doc = (status, data) => ({
    documentType: "previous_return",
    extractionStatus: status,
    extractedData:
      typeof data === "string"
        ? data
        : JSON.stringify({ fields: fields(data) }),
  });
  const approved = prev.approvedPreviousReturnFromDocuments(
    [doc("MAPPED", good)],
    2026,
  );
  assert.equal(approved.netAssets, 8_780_220);
  // Newest governs: a newer unapproved upload shadows the older approved one.
  assert.equal(
    prev.approvedPreviousReturnFromDocuments(
      [doc("COMPLETED", good), doc("MAPPED", good)],
      2026,
    ),
    null,
  );
  assert.equal(
    prev.approvedPreviousReturnFromDocuments([doc("MAPPED", "broken{")], 2026),
    null,
  );
  assert.equal(
    prev.approvedPreviousReturnFromDocuments(
      [{ documentType: "cnic", extractionStatus: "MAPPED" }],
      2026,
    ),
    null,
  );
  assert.equal(prev.approvedPreviousReturnFromDocuments(undefined, 2026), null);
});

test("previous_return Phase 3a: CNIC mismatch only when both sides are 13 digits and differ", () => {
  const snap = prev.parsePreviousReturnFields(fields(good), 2026);
  assert.equal(prev.previousReturnCnicMismatch(snap, "4220112345671"), false);
  assert.equal(prev.previousReturnCnicMismatch(snap, "42201-1234567-1"), false);
  assert.equal(prev.previousReturnCnicMismatch(snap, "3520112345671"), true);
  assert.equal(prev.previousReturnCnicMismatch(snap, null), false);
  assert.equal(prev.previousReturnCnicMismatch(snap, "12345"), false);
  assert.equal(prev.previousReturnCnicMismatch(null, "3520112345671"), false);
});

test("previous_return Phase 3a wiring: CNIC blocker in completeness; preview carries previous net assets; UI shows it", () => {
  const gate = fs.readFileSync(
    path.join(root, "lib/tax/filing-completeness.ts"),
    "utf8",
  );
  assert.match(gate, /"taxAuditEvent" \| "user"/);
  assert.match(gate, /previousReturnCnicMismatch\(snapshot, profile\?\.cnic\)/);
  assert.match(gate, /its Registration No does not match this taxpayer's CNIC/);

  const calc = fs.readFileSync(
    path.join(root, "lib/tax/reconciliation-calculation.ts"),
    "utf8",
  );
  assert.match(calc, /previousYearNetAssets: number \| null/);
  assert.match(calc, /documentType: "previous_return"/);
  assert.match(
    calc,
    /approvedPreviousReturnFromDocuments\(\s+previousReturnDocuments,/,
  );

  const ui = fs.readFileSync(
    path.join(root, "components/tax/filing/wizard-reconciliation-step.tsx"),
    "utf8",
  );
  assert.match(ui, /Previous year net assets/);
  assert.match(ui, /Net Assets Previous\s+Year \(703002\)/);
});

test("previous_return Phase 3b wiring: packet carries 703002 expectation; agent compares read-only; card surfaces it", () => {
  const packet = fs.readFileSync(
    path.join(root, "app/actions/packet.ts"),
    "utf8",
  );
  assert.match(
    packet,
    /wealthExpectations: \{\s+previousYearNetAssets: \{\s+irisCode: "703002",/,
  );
  assert.match(
    packet,
    /approvedPreviousReturnFromDocuments\(\s+previousReturnDocuments,/,
  );
  assert.match(packet, /source: "approved_previous_return_703001"/);

  const main = fs.readFileSync(
    path.join(root, "electron-connect/main.js"),
    "utf8",
  );
  assert.match(main, /snapshot\?\.wealthExpectations\?\.previousYearNetAssets/);
  assert.match(main, /previous_wealth_check_differs/);
  assert.match(main, /The agent left IRIS exactly as it is/);
  assert.match(
    main,
    /const AGENT_BUILD_TAG = "pension-services-multifiling-20261106a"/,
  );

  const report = fs.readFileSync(
    path.join(root, "electron-connect/job-report.js"),
    "utf8",
  );
  assert.match(report, /describePreviousWealthCheck/);
  assert.match(report, /PREVIOUS YEAR NET ASSETS/);

  const jobs = fs.readFileSync(
    path.join(root, "app/actions/fbr-jobs.ts"),
    "utf8",
  );
  assert.match(jobs, /readHandoffPreviousWealthCheck/);
  const client = fs.readFileSync(
    path.join(root, "components/tax/fbr-connect-client.tsx"),
    "utf8",
  );
  assert.match(client, /Previous year net assets \(703002\) — differs in IRIS/);
});

const irisWealthDetailed = [
  "Wealth Statement",
  "Personal Assets and Liabilities",
  "Description Code Amount",
  "Investments / Stocks / Bonds / etc. 7006 1,119,666",
  "Investments / Stocks / Bonds / etc.- FUND A 7006 235,588",
  "Investments / Stocks / Bonds / etc.- FUND B 7006 884,078",
  "Cash in hand 7012 280,554",
  "Motor Vehicle(s) 7008 2,220,000",
  "Motor Vehicle(s) - AAA-111-Car 7008 1,470,000",
  "Motor Vehicle(s) - BBB-222-Car 7008 750,000",
  "Household Effects 7010 250,000",
  "Business Capital 7003 3,910,000",
  "Total Assets 7019 7,780,220",
  "Credit Cards 7021 500,000",
  "Other Liabilities 7028 500,000",
  "Total Liabilities 7029 1,000,000",
  "Net Assets Current Year 703001 6,780,220",
  "Reconciliation of Net Assets",
  "Net Assets Current Year 703001 6,780,220",
].join("\n");

test("previous_return Phase 4a: printed wealth rows parse with aggregates/details and tie out", () => {
  const got = textParser.parseIrisPreviousReturnText(
    irisWealthDetailed,
    irisHeader,
  );
  assert.ok(got.wealthRows);
  assert.equal(got.wealthRows.length, 11);
  const agg = got.wealthRows.filter((r) => !r.detail);
  assert.equal(
    agg.reduce((s, r) => s + r.amount, 0),
    7_780_220 + 1_000_000,
  );
  const vAgg = got.wealthRows.find((r) => r.code === "7008" && !r.detail);
  assert.equal(vAgg.amount, 2_220_000);
  assert.equal(
    got.wealthRows.filter((r) => r.code === "7008" && r.detail).length,
    2,
  );
  assert.equal(got.wealthRows.find((r) => r.code === "7021").amount, 500_000);
  assert.equal(got.wealthRowsNote, null);
});

test("previous_return Phase 4a: rows that do not tie to the totals are dropped with a note, scalars stand", () => {
  const broken = textParser.parseIrisPreviousReturnText(
    irisWealthDetailed.replace(
      "Household Effects 7010 250,000",
      "Household Effects 7010 999,000",
    ),
    irisHeader,
  );
  assert.equal(broken.wealthRows, null);
  assert.match(broken.wealthRowsNote, /did not add up to the printed totals/);
  assert.equal(broken.totalAssets, 7_780_220);
  const merged = textParser.applyPreviousReturnTextParse(
    { fields: [], notes: [] },
    broken,
  );
  assert.equal(merged.previousReturnWealthRows, undefined);
  assert.ok(merged.notes.some((n) => n.includes("did not add up")));
});

test("previous_return Phase 4a: snapshot carries only rows that still validate against the totals", () => {
  const parse = textParser.parseIrisPreviousReturnText(
    irisWealthDetailed,
    irisHeader,
  );
  const docWith = (rows) => [
    {
      documentType: "previous_return",
      extractionStatus: "MAPPED",
      extractedData: JSON.stringify({
        fields: fields({
          ...good,
          "Tax Year": 2025,
          "Total Assets (7019)": 7_780_220,
          "Total Liabilities (7029)": 1_000_000,
          "Net Assets (703001)": 6_780_220,
        }),
        previousReturnWealthRows: rows,
      }),
    },
  ];
  const snap = prev.approvedPreviousReturnFromDocuments(
    docWith(parse.wealthRows),
    2026,
  );
  assert.equal(snap.wealthRows.length, 11);
  const tampered = parse.wealthRows.map((r) =>
    r.code === "7010" ? { ...r, amount: 5 } : r,
  );
  assert.deepEqual(
    prev.approvedPreviousReturnFromDocuments(docWith(tampered), 2026)
      .wealthRows,
    [],
  );
  assert.deepEqual(
    prev.approvedPreviousReturnFromDocuments(docWith("nope"), 2026).wealthRows,
    [],
  );
  const merged = textParser.applyPreviousReturnTextParse(
    { fields: [], notes: [] },
    parse,
  );
  assert.equal(merged.previousReturnWealthRows.length, 11);
  assert.equal(merged.previousReturnTextParse.wealthRowCount, 11);
});

test("previous_return Phase 4b: continuity flags missing/new/carried codes and never blocks", () => {
  const cont = require(path.join(root, "lib/tax/wealth-continuity.ts"));
  const parse = textParser.parseIrisPreviousReturnText(
    irisWealthDetailed,
    irisHeader,
  );
  const got = cont.buildWealthContinuity(
    parse.wealthRows,
    2025,
    cont.currentFilingWealthRows({
      bankClosingTotal: 2_000_000,
      cashMovement: 100_000,
    }),
  );
  assert.equal(got.previousReturnTaxYear, 2025);
  const byCode = Object.fromEntries(got.items.map((i) => [i.code, i]));
  assert.equal(byCode["7012"].status, "carried");
  assert.equal(byCode["7012"].previousAmount, 280_554);
  assert.equal(byCode["7012"].currentAmount, 100_000);
  assert.equal(byCode["7030"].status, "new");
  assert.equal(byCode["7003"].status, "missing");
  assert.equal(byCode["7003"].previousAmount, 3_910_000);
  assert.equal(byCode["7021"].status, "missing");
  assert.deepEqual(got.carriedCodes, ["7012"]);
  assert.match(got.note, /never blocks filing and nothing is written to IRIS/);
  assert.match(got.note, /7003/);
  // Detail children never match on their own.
  assert.ok(
    !got.items.some(
      (i) =>
        i.code === "7006" &&
        i.status === "carried" &&
        i.previousAmount !== 1_119_666,
    ),
  );
  assert.equal(cont.buildWealthContinuity([], 2025, []), null);
  const noBanks = cont.currentFilingWealthRows({
    bankClosingTotal: null,
    cashMovement: 500,
  });
  assert.deepEqual(
    noBanks.map((r) => r.code),
    ["7012"],
  );
});

test("previous_return gate: uploaded-but-unapproved blocks Continue; Remove is the escape hatch", () => {
  const wizard = fs.readFileSync(
    path.join(root, "components/tax/filing/filing-wizard.tsx"),
    "utf8",
  );
  assert.match(wizard, /previousReturnDocument/);
  assert.match(wizard, /must be reviewed and approved before continuing/);
  assert.match(wizard, /previousReturnDocument\.extractionStatus !== "MAPPED"/);
  const docs = fs.readFileSync(
    path.join(root, "app/actions/documents.ts"),
    "utf8",
  );
  assert.match(docs, /export async function removeFilingDocumentAction/);
  assert.match(docs, /Only the Previous Year Tax Return can be removed here/);
  const step = fs.readFileSync(
    path.join(root, "components/tax/filing/wizard-documents-step.tsx"),
    "utf8",
  );
  assert.match(step, /handleRemoveDocument/);
  assert.match(step, /slot\.documentType === "previous_return" &&/);
  const hook = fs.readFileSync(
    path.join(root, "components/tax/filing/hooks/use-filing-documents.ts"),
    "utf8",
  );
  assert.match(hook, /removeFilingDocumentAction/);
  assert.match(hook, /Previous Year Tax Return removed/);
});

test("previous_return Phase 4b wiring: Mizan preview carries the continuity guidance", () => {
  const calc = fs.readFileSync(
    path.join(root, "lib/tax/reconciliation-calculation.ts"),
    "utf8",
  );
  assert.match(calc, /previousWealthContinuity: WealthContinuity \| null/);
  assert.match(calc, /buildWealthContinuity\(/);
  assert.match(calc, /currentFilingWealthRows\(/);
  const hook = fs.readFileSync(
    path.join(root, "components/tax/filing/hooks/use-filing-reconciliation.ts"),
    "utf8",
  );
  assert.match(hook, /previousWealthContinuity\?:/);
  const step = fs.readFileSync(
    path.join(root, "components/tax/filing/wizard-reconciliation-step.tsx"),
    "utf8",
  );
  assert.match(step, /Wealth continuity — Tax Year/);
  assert.match(
    step,
    /Not in this filing&#x27;s Wealth Statement|Not in this filing&apos;s Wealth Statement|Not in this filing.s Wealth Statement/,
  );
  assert.match(step, /previousWealthContinuity\.items/);
});

test("previous_return Phase 4a wiring: documents step shows the read-only wealth detail", () => {
  const ui = fs.readFileSync(
    path.join(root, "components/tax/filing/wizard-documents-step.tsx"),
    "utf8",
  );
  assert.match(ui, /previousReturnWealthRows\?:/);
  assert.match(ui, /Wealth detail in this return/);
  assert.match(
    ui,
    /slot\.documentType === "previous_return" &&\s+\(extracted\?\.previousReturnWealthRows\?\.length/,
  );
});

test("previous_return: uploaded-but-unapproved blocks filing; extraction prompt/slot wired", () => {
  const gate = fs.readFileSync(
    path.join(root, "lib/tax/filing-completeness.ts"),
    "utf8",
  );
  assert.match(
    gate,
    /DOCUMENT_TYPES_REQUIRING_MAPPING = new Set\(\[[\s\S]*?"previous_return",/,
  );
  assert.match(gate, /previousReturnDocument\.extractionStatus !== "MAPPED"/);
  assert.match(
    gate,
    /you uploaded a previous return, so review and approve\/map it/,
  );
  assert.match(
    gate,
    /storedDocumentReviewRequiredErrors\(\s+"previous_return",/,
  );

  const action = fs.readFileSync(
    path.join(root, "app/actions/extraction.ts"),
    "utf8",
  );
  assert.match(
    action,
    /previous_return: \{\r?\n\s+label: "previous year tax return printed from FBR IRIS"/,
  );
  assert.match(action, /previousReturnInstruction/);
  assert.match(action, /"Net Assets \(703001\)"/);
  assert.match(action, /never add up the detail lines/);

  // Phase 1 contract still holds: the slot itself stays OPTIONAL.
  const reqs = fs.readFileSync(
    path.join(root, "lib/tax/document-requirements.ts"),
    "utf8",
  );
  assert.match(reqs, /documentType: "previous_return"[\s\S]*?required: false/);
});

test("previous_return Phase 5a wiring: packet carries validated wealth rows + packet PDF prints them", () => {
  const packet = fs.readFileSync(
    path.join(root, "app/actions/packet.ts"),
    "utf8",
  );

  // The snapshot contract: rows travel only inside wealthCarryForward.
  assert.match(
    packet,
    /wealthCarryForward\?: \{\s+previousReturnTaxYear: number;\s+totalAssets: number;\s+totalLiabilities: number;\s+netAssets: number;\s+cashInHand: number \| null;\s+rows: \{/,
  );

  // Only an approved previous return with a validated row set fills the block:
  // the tie-out to 7019/7029 was already re-proven by
  // parsePreviousReturnWealthRows, so an empty array must not reach the agent.
  assert.match(
    packet,
    /approvedPreviousReturn && approvedPreviousReturn\.wealthRows\.length > 0/,
  );
  assert.match(
    packet,
    /wealthCarryForward: \{\s+previousReturnTaxYear: approvedPreviousReturn\.taxYear,/,
  );
  assert.match(
    packet,
    /rows: approvedPreviousReturn\.wealthRows\.map\(\(row\) => \(\{/,
  );

  // 703002 keeps its own read-only contract; the carry-forward block never
  // claims to write it.
  assert.match(packet, /irisCode: "703002"/);

  // Packet PDF evidences the rows and states how they are used.
  assert.match(
    packet,
    /document\.fontSize\(14\)\.text\("Previous Return Wealth Carried Forward"\)/,
  );
  assert.match(
    packet,
    /the position at that year's closing date, not this year's movement/,
  );
  assert.match(
    packet,
    /entered as the opening balance of the same IRIS 116 row/,
  );
  assert.match(
    packet,
    /Net Assets Previous Year \(703002\) is IRIS's own figure and is never changed/,
  );
  assert.match(packet, /Cash in hand was not stated in the printed return/);
});

test("previous_return: a printed return with NIL liabilities still approves (7029 blank, 7019 = 703001)", () => {
  // Live case 2026-10-27: the filed return prints 7021 / 7029 with EMPTY amount
  // cells because the taxpayer has no liabilities. Extraction must read that as
  // zero, not as "missing", otherwise Save & Approve Map is blocked by a
  // required-field error on a figure that is genuinely nil.
  const textParser = require(
    path.join(root, "lib/tax/previous-return-text.ts"),
  );
  const fields = require(path.join(root, "lib/tax/previous-return-fields.ts"));

  const header = [
    "RETURN OF TOTAL INCOME / STATEMENT OF FINAL TAXATION",
    "NAVEED-UR-REHMAN",
    "4220106970933",
    "Tax Year 2025",
  ].join("\n");
  const wealth = [
    "Wealth Statement",
    "Cash in hand 7012 280,554",
    "Total Assets 7019 8,780,220",
    "Payables ( Borrowing / Loan / Credits. etc.) 7021",
    "Total Liabilities 7029",
    "Net Assets Current Year 703001 8,780,220",
  ].join("\n");

  const parsed = textParser.parseIrisPreviousReturnText(
    `${header}\n${wealth}`,
    header,
  );
  assert.ok(
    parsed,
    "the parser must anchor a printed return even with nil liabilities",
  );
  assert.equal(parsed.totalAssets, 8780220);
  assert.equal(parsed.totalLiabilities, 0);
  assert.equal(parsed.liabilitiesDerived, true);
  assert.equal(parsed.netAssets, 8780220);

  // And the review layer agrees: no required-field error for the nil total.
  const mapped = fields.previousReturnFieldsFromTextParse
    ? fields.previousReturnFieldsFromTextParse(parsed)
    : null;
  const reviewFields = mapped ?? [
    { label: "Taxpayer Name", value: "NAVEED-UR-REHMAN" },
    { label: "Registration No", value: "4220106970933" },
    { label: "Tax Year", value: 2025 },
    { label: "Total Assets (7019)", value: 8780220 },
    { label: "Total Liabilities (7029)", value: parsed.totalLiabilities },
    { label: "Net Assets (703001)", value: 8780220 },
    { label: "Cash in Hand (7012)", value: 280554 },
  ];
  const errors = fields.getPreviousReturnReviewErrors(reviewFields, 2026);
  assert.deepEqual(errors, []);
  const snapshot = fields.parsePreviousReturnFields(reviewFields, 2026);
  assert.ok(snapshot);
  assert.equal(snapshot.totalLiabilities, 0);
  assert.equal(snapshot.netAssets, 8780220);
});

test("previous_return: derivation never guesses when assets exceed net assets", () => {
  const fields = require(path.join(root, "lib/tax/previous-return-fields.ts"));
  const list = [
    { label: "Taxpayer Name", value: "NAVEED-UR-REHMAN" },
    { label: "Registration No", value: "4220106970933" },
    { label: "Tax Year", value: 2025 },
    { label: "Total Assets (7019)", value: 8780220 },
    { label: "Total Liabilities (7029)", value: "" },
    { label: "Net Assets (703001)", value: 8000000 },
  ];
  const resolved = fields.resolvePreviousReturnTotals(list);
  assert.equal(resolved.totalLiabilities, null);
  assert.equal(resolved.liabilitiesDerived, false);
  const errors = fields.getPreviousReturnReviewErrors(list, 2026);
  assert.ok(
    errors.some((e) => /Total Liabilities \(7029\) is required/.test(e)),
  );
});

test("previous_return: the review cell itself is filled with the derived 0 (see == save)", () => {
  const fields = require(path.join(root, "lib/tax/previous-return-fields.ts"));
  const blank = [
    { label: "Taxpayer Name", value: "NAVEED-UR-REHMAN", confidence: 1 },
    { label: "Registration No", value: "4220106970933", confidence: 1 },
    { label: "Tax Year", value: 2025, confidence: 1 },
    { label: "Total Assets (7019)", value: 8780220, confidence: 1 },
    { label: "Total Liabilities (7029)", value: "", confidence: 1 },
    { label: "Net Assets (703001)", value: 8780220, confidence: 1 },
    { label: "Cash in Hand (7012)", value: 280554, confidence: 1 },
  ];
  const shown = fields.withDerivedPreviousReturnFields(blank);
  const liability = shown.find((f) => f.label === "Total Liabilities (7029)");
  assert.equal(liability.value, 0);
  assert.equal(liability.confidence, 0.9, "a derived figure is marked down");
  // Everything else is untouched, and the input array is not mutated.
  assert.equal(shown.length, blank.length);
  assert.equal(blank[4].value, "");
  assert.equal(
    shown.find((f) => f.label === "Total Assets (7019)").value,
    8780220,
  );

  // A row that is missing entirely is added, so the reviewer can see and map it.
  const withoutRow = blank.filter(
    (f) => f.label !== "Total Liabilities (7029)",
  );
  const added = fields.withDerivedPreviousReturnFields(withoutRow);
  assert.equal(
    added.find((f) => f.label === "Total Liabilities (7029)").value,
    0,
  );

  // A real liability figure is never overwritten, and other documents pass through.
  const stated = blank.map((f) =>
    f.label === "Total Liabilities (7029)" ? { ...f, value: 500000 } : f,
  );
  assert.equal(
    fields
      .withDerivedPreviousReturnFields(stated)
      .find((f) => f.label === "Total Liabilities (7029)").value,
    500000,
  );
  const bank = [
    { label: "Account Title", value: "NAVEED-UR-REHMAN" },
    { label: "IBAN", value: "PK35HABB0018067900476803" },
  ];
  assert.deepEqual(fields.withDerivedPreviousReturnFields(bank), bank);
});

test("previous_return: the documents hook shows the derived figure (display == save)", () => {
  const hook = fs.readFileSync(
    path.join(root, "components/tax/filing/hooks/use-filing-documents.ts"),
    "utf8",
  );
  assert.match(hook, /withDerivedNilReviewPayload/);
  assert.match(hook, /const reviewExtractedByDocumentId = useMemo\(/);
  assert.match(hook, /out\[documentId\] = reviewPayload\(documentId\)/);
  assert.match(hook, /extractedByDocumentId: reviewExtractedByDocumentId,/);
  const composer = fs.readFileSync(
    path.join(root, "lib/tax/review-prefill.ts"),
    "utf8",
  );
  assert.match(composer, /withDerivedPreviousReturnFields\(fields\)/);
  assert.match(
    composer,
    /withDerivedNilBusinessBooksFigures\(previousReturn\)/,
  );
  assert.match(composer, /withDerivedNilBalanceSheetRows\(previousReturn\)/);
});

test("previous_return: the LIVE FBR print layout parses (code first, 4-digit codes, page-break repeats)", () => {
  // Text copied from a real IRIS print (27 Oct 2026): the section is titled
  // "Personal Assets / Liabilities" (never "Wealth Statement"), each row is
  // "code amountDescription", the code is FOUR digits, a row whose description
  // wraps onto the next page is printed twice, "7015 Total Assets inside
  // Pakistan" is a printed total rather than an asset row, and the
  // liabilities rows carry no amount at all (nil).
  const textParser = require(
    path.join(root, "lib/tax/previous-return-text.ts"),
  );
  const live = [
    "NAVEED-UR-REHMAN",
    "4220106970933",
    "Tax Year 2025",
    "Code AmountDescription",
    "Personal Assets / Liabilities",
    "7006 1,119,666",
    "Investment (Non-Business) (Account / Annuity / Bond /",
    "Certificate / Debenture / Deposit / Fund / Instrument /",
    "Page 2 ofTue, 27 Oct 2026 12:40:02 4Tue, 27 Oct 2026 12:40:02 +0500Print Date:",
    "Code AmountDescription",
    "Personal Assets / Liabilities",
    "7006 1,119,666Policy / Share / Stock / Unit, etc.)",
    "7006 235,588",
    "7006 884,078",
    "7008 2,220,000Motor Vehicle (Non-Business)",
    "7008 415,000Motor Vehicle (Non-Business) - AAU-408-Suzuki",
    "7008 55,000Motor Vehicle (Non-Business) - KEF-173-Other",
    "7008 1,750,000Motor Vehicle (Non-Business) - BDQ-435 - CAR",
    "7010 250,000Household Effect",
    "7012 280,554Cash (Non-Business)",
    "7013 3,910,000Any Other Asset",
    "7013 2,210,000",
    "Any Other Asset - AL- AMEEN ISLAMIC SOVEREIGN",
    "7013 1,700,000Any Other Asset - PRIZE BOND",
    "7014 1,000,000",
    "Assets held on others name (including non-filer",
    "Spouse/Dependents)",
    "7015 8,780,220Total Assets inside Pakistan",
    "7019 8,780,220Total Assets",
    "703001 8,780,220Net Assets Current Year",
    "Code AmountDescription",
    "Reconciliation of Net Assets",
    "703001 8,780,220Net Assets Current Year",
    "703002 8,636,237Net Assets Previous Year",
    "703003 143,983Increase / Decrease in Assets",
    "7049 180,606Inflows",
    "7033 180,606",
    "Income Attributable to Receipts, etc. Declared as per",
    "Return for the year subject to Final / Fixed Tax",
    "7099 36,623Outflows",
    "7098 36,623Adjustments in Outflows - Tax Paid",
    "703000 0Unreconciled Amount",
  ].join("\n");

  const parsed = textParser.parseIrisPreviousReturnText(
    live,
    live.slice(0, 200),
  );
  assert.ok(
    parsed,
    "the live print must parse without the 'Wealth Statement' heading",
  );
  // (The name comes from the acknowledgement-slip header, which this fixture
  // does not reproduce; the real PDF parses it — checked by the diag script.)
  assert.equal(parsed.registrationNo, "4220106970933");
  assert.equal(parsed.taxYear, 2025);
  assert.equal(parsed.totalAssets, 8780220);
  assert.equal(parsed.totalLiabilities, 0);
  assert.equal(parsed.liabilitiesDerived, true);
  assert.equal(parsed.netAssets, 8780220);
  assert.equal(parsed.cashInHand, 280554);

  // 13 rows: 7006 (agg + 2 details), 7008 (agg + 3), 7010, 7012, 7013 (agg + 2), 7014 (agg).
  assert.ok(parsed.wealthRows, "rows must tie out to the printed totals");
  assert.equal(parsed.wealthRows.length, 13);
  const agg = parsed.wealthRows.filter((r) => !r.detail);
  assert.deepEqual(
    agg.map((r) => [r.code, r.amount]),
    [
      ["7006", 1119666],
      ["7008", 2220000],
      ["7010", 250000],
      ["7012", 280554],
      ["7013", 3910000],
      ["7014", 1000000],
    ],
  );
  // The page-break repeat of 7006 must not become a second aggregate, and the
  // "Total Assets inside Pakistan" line must not be counted as an asset row.
  assert.equal(
    parsed.wealthRows.filter((r) => r.code === "7006" && !r.detail).length,
    1,
  );
  assert.equal(
    parsed.wealthRows.some((r) => r.code === "7015"),
    false,
  );
  // Detail rows carry readable descriptions even when IRIS printed none inline.
  const vehicleDetail = parsed.wealthRows.find(
    (r) => r.code === "7008" && r.detail,
  );
  assert.match(vehicleDetail.description, /AAU-408-Suzuki/);
  for (const row of parsed.wealthRows) assert.ok(row.description.length > 0);
});
