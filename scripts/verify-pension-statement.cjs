const { test } = require("node:test");
const assert = require("node:assert/strict");
const { harness, pensionFields } = require("./helpers/pension-harness.cjs");

test("approved >10M statement replaces old bank pension for tax, without writing duplicate cash income", async () => {
  const h = harness();
  const r = await h.calculate();
  assert.equal(r.success, true, r.error);
  assert.equal(r.result.baseTax, 49_600);
  assert.equal(r.result.surcharge, 4_960);
  assert.equal(r.result.taxDue, 54_560);
  assert.equal(h.state.entries[0].amount.toNumber(), 1_989_000);
  assert.equal(h.state.ledgerWrites.length, 0);
});

test("pension approval is implemented and invalidates previous tax/packet/job state", async () => {
  const h = harness({ status: "COMPLETED" });
  const r = await h.approve();
  assert.equal(r.success, true, r.error);
  assert.equal(r.mapping, "PENSION");
  assert.equal(h.state.documents[0].extractionStatus, "MAPPED");
  assert.equal(h.state.draft.taxCalculationStatus, "NOT_CALCULATED");
  assert.equal(h.state.draft.packetApprovalConfirmed, false);
  assert.ok(h.state.cancelledJobs > 0);
  assert.equal(h.state.ledgerWrites.length, 0);
});

test("latest unmapped pension statement is not filing-complete", async () => {
  const h = harness({ status: "COMPLETED" });
  const r = await h.completeness();
  assert.equal(r.success, false);
  assert.match(r.blockers.join(" "), /pension/i);
});

test("high pension classifies the exempt limit separately from the final-tax excess", async () => {
  const h = harness();
  const calc = await h.calculate();
  assert.equal(calc.success, true, calc.error);
  const r = await h.generate();
  assert.equal(r.success, true, r.error);
  const snapshot = JSON.parse(h.state.packets.at(-1).snapshotJson);
  const income = snapshot.portalFieldMap.incomeFields;
  const tax = snapshot.portalFieldMap.adjustableTaxFields;
  assert.equal(income.find((f) => f.irisCode === "1008" && f.column === "Total Amount").ourAmount, 10_992_000);
  assert.equal(income.find((f) => f.irisCode === "1008" && f.column === "Subject to Final Tax").ourAmount, 992_000);
  assert.equal(income.find((f) => f.irisCode === "1008" && f.column === "Subject to Exemption").ourAmount, 10_000_000);
  assert.equal(tax.find((f) => f.irisCode === "64020007" && f.column === "Taxable Amount").ourAmount, 992_000);
  assert.equal(tax.find((f) => f.irisCode === "64020007" && f.column === "Tax Deducted").ourAmount, 0);
  assert.equal(tax.find((f) => f.irisCode === "923184").ourAmount, 4_960);
});

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { Prisma } = require("@prisma/client");
const { root } = require("./helpers/pension-harness.cjs");
const { pensionEntryHold } = require("../electron-connect/pension-guard.js");
const approvedLabel = "Approved Pension Amount for Tax (Annual PKR)";
const deductedLabel = "Pension Tax Deducted (Annual PKR)";
const coveredLabel = "Pension Withholding Already in Tax Ledger (Annual PKR)";
const plain = (v) => JSON.parse(JSON.stringify(v));
const snapshotOf = (h) => JSON.parse(h.state.packets.at(-1).snapshotJson);
const pensionRows = (snapshot) =>
  snapshot.portalFieldMap.incomeFields.filter((f) => f.irisCode === "1008");
const flatSnapshot = (h, snapshot) => ({
  ...snapshot,
  portalFieldMapDetailed: snapshot.portalFieldMap,
  portalFieldMap: h
    .load("lib/tax/portal-field-map.ts")
    .flattenPortalFieldMap(snapshot.portalFieldMap),
});
async function calculated(h) {
  const r = await h.calculate();
  assert.equal(r.success, true, r.error);
  return r;
}
async function generated(h, manual = false) {
  await calculated(h);
  const r = await h.generate(
    manual ? { acceptUnmappedPortalSources: true } : undefined,
  );
  assert.equal(r.success, true, r.error);
  return snapshotOf(h);
}
const validation = (h, snapshot) =>
  h
    .load("lib/tax/pension-packet-validation.ts")
    .pensionPacketValidationError(snapshot, "qa-draft", "qa-user");

// Review policy v2 (shipped): document approval validates printed facts only
// (Tax Year + annual Gross). A blank Approved amount is therefore mappable,
// but tax calculation must refuse it while a non-zero medical allowance makes
// the tax basis a human decision — blank is never silently the gross here.
// (JSON storage turns Infinity into null, i.e. blank; the save action rejects
// non-finite numbers before they can ever be stored.)
for (const [name, value] of [
  ["blank", ""],
  ["null", null],
  ["undefined", undefined],
  ["infinite", Infinity],
]) {
  test(`v2: ${name} approved annual pension maps as printed facts but cannot calculate`, async () => {
    const h = harness({
      status: "COMPLETED",
      fields: pensionFields(10_992_000, { [approvedLabel]: value }),
    });
    const r = await h.approve();
    assert.equal(r.success, true, r.error);
    assert.equal(h.state.documents[0].extractionStatus, "MAPPED");
    // A blocked pension calculation persists as NEEDS_RULES, never ESTIMATE.
    const calc = await h.calculate();
    assert.equal(calc.pensionSource, null);
    assert.equal(calc.result.status, "NEEDS_RULES");
    assert.match(calc.result.note, /Approved Pension Amount/i);
  });
}
for (const [name, value] of [
  ["negative", -1],
  ["zero", 0],
  ["nonnumeric", "tax free"],
  ["exponent", "1e7"],
  ["malformed commas", "10,99,000"],
  ["boolean", true],
  ["object", {}],
  ["array", []],
  ["unsafe magnitude", "99999999999999999999999"],
]) {
  test(`approval rejects ${name} approved annual pension without writes`, async () => {
    const h = harness({
      status: "COMPLETED",
      fields: pensionFields(10_992_000, { [approvedLabel]: value }),
    });
    const r = await h.approve();
    assert.equal(r.success, false);
    assert.match(r.error, /approved pension/i);
    assert.equal(h.state.documents[0].extractionStatus, "COMPLETED");
    assert.equal(h.state.updates.length, 0);
    assert.equal(h.state.ledgerWrites.length, 0);
  });
}
// v2: blank Tax Deducted still maps (printed facts), but calculation refuses
// it — unknown withholding is never zero. Blank "already in ledger" with a
// stated nil deduction safely reads as 0 (no overlap is possible).
for (const value of [null, ""]) {
  test(`${deductedLabel} ${JSON.stringify(value)} is not silently treated as zero`, async () => {
    const h = harness({
      status: "COMPLETED",
      fields: pensionFields(10_992_000, { [deductedLabel]: value }),
    });
    const r = await h.approve();
    assert.equal(r.success, true, r.error);
    const calc = await h.calculate();
    assert.equal(calc.pensionSource, null);
    assert.equal(calc.result.status, "NEEDS_RULES");
    assert.match(calc.result.note, /not stated|Unknown withholding/i);
  });
  test(`${coveredLabel} ${JSON.stringify(value)} with nil deduction reads as zero already-ledgered`, async () => {
    const h = harness({
      status: "COMPLETED",
      fields: pensionFields(10_992_000, { [coveredLabel]: value }),
    });
    const r = await h.approve();
    assert.equal(r.success, true, r.error);
    const calc = await h.calculate();
    assert.equal(calc.success, true, calc.error);
    assert.equal(calc.pensionSource.taxAlreadyInLedger, 0);
  });
}
for (const label of [deductedLabel, coveredLabel]) {
  for (const value of [-1, "unknown"]) {
    test(`${label} ${JSON.stringify(value)} is not silently treated as zero`, async () => {
      const h = harness({
        status: "COMPLETED",
        fields: pensionFields(10_992_000, { [label]: value }),
      });
      const r = await h.approve();
      assert.equal(r.success, false);
      assert.match(r.error, /withholding|tax deducted|valid/i);
    });
  }
}

test("wrong tax year, missing human rationale and duplicate annual fields fail approval", async () => {
  for (const fields of [
    pensionFields(10_992_000, { "Tax Year": 2025 }),
    pensionFields(10_992_000, { "Pension Tax Base Review Note": "" }),
    [...pensionFields(), { label: approvedLabel, value: 1_989_000 }],
  ]) {
    const h = harness({ status: "COMPLETED", fields });
    assert.equal((await h.approve()).success, false);
    assert.equal(h.state.ledgerWrites.length, 0);
  }
});

test("monthly/net totals never supply missing annual gross or approved tax base", async () => {
  const fields = [
    { label: "Gross Pension (Monthly PKR)", value: 874_000 },
    { label: "Net Pension Payable (Annual PKR)", value: 10_992_000 },
    { label: "Tax Year", value: 2026 },
  ];
  const h = harness({ status: "COMPLETED", fields });
  const helper = h.load("lib/tax/pension-statement-fields.ts");
  const normalized = helper.ensurePensionStatementReviewFields(
    { fields },
    true,
  );
  for (const label of [
    "Gross Pension (Annual PKR)",
    approvedLabel,
    deductedLabel,
    coveredLabel,
  ])
    assert.equal(normalized.fields.find((f) => f.label === label)?.value ?? null, null);
  const r = await h.approve();
  assert.equal(r.success, false);
  assert.match(r.error, /gross|approved/i);
});

test("extraction cannot pre-approve an AI-guessed tax base, rationale or duplicate-credit allocation", () => {
  const h = harness();
  const helper = h.load("lib/tax/pension-statement-fields.ts");
  const raw = { fields: pensionFields(10_992_000, { [coveredLabel]: 100 }) };
  const normalized = helper.ensurePensionStatementReviewFields(raw, true);
  for (const label of [
    approvedLabel,
    coveredLabel,
    "Pension Tax Base Review Note",
  ])
    assert.equal(normalized.fields.find((f) => f.label === label).value, null);
  assert.equal(
    normalized.fields.find((f) => f.label === "Gross Pension (Annual PKR)")
      .value,
    10_488_000,
  );
});

test("blank model deduction remains unknown; canonical annual currency values are accepted", () => {
  const helper = harness().load("lib/tax/pension-statement-fields.ts");
  assert.equal(helper.parsePensionAmount("PKR 10,992,000.00"), 10_992_000);
  assert.equal(helper.parsePensionAmount("Rs. 0.00"), 0);
  assert.equal(helper.parsePensionAmount(""), null);
  assert.equal(helper.parsePensionAmount(null), null);
});

for (const [amount, expected] of [
  [10_992_000, 54_560],
  [10_488_000, 26_840],
  [12_000_000, 110_000],
  [10_000_000, 0],
  [1_989_000, 0],
]) {
  test(`reviewer-approved pension ${amount} follows existing rules: ${expected}; medical is not inferred`, async () => {
    const h = harness({ pension: amount });
    const r = await calculated(h);
    assert.equal(r.result.taxDue, expected);
    assert.equal(r.pensionSource.annualPension, amount);
    assert.equal(r.pensionSource.grossAnnual, 10_488_000);
    assert.equal(r.pensionSource.medicalAnnual, 504_000);
  });
}
for (const [dob, expected, treatment] of [
  ["1955-07-01", 0, "exempt_age70"],
  ["1955-07-02", 54_560, "final_above_10m"],
  ["1950-03-15", 0, "exempt_age70"],
  ["1962-03-15", 54_560, "final_above_10m"],
]) {
  test(`first-day profile DOB ${dob} controls high-pension treatment`, async () => {
    const h = harness({ dob });
    const r = await calculated(h);
    assert.equal(r.result.taxDue, expected);
    assert.equal(r.pensionSource.treatment, treatment);
  });
}

test("printed DOB/profile mismatch blocks approval and tax instead of overwriting identity", async () => {
  const h = harness({
    dob: "1950-03-15",
    status: "COMPLETED",
    fields: pensionFields(10_992_000, { "Date of Birth": "1962-03-15" }),
  });
  const r = await h.approve();
  assert.equal(r.success, false);
  assert.match(r.error, /DOB differs/i);
  h.state.documents[0].extractionStatus = "MAPPED";
  const c = await calculated(h);
  assert.equal(c.result.status, "NEEDS_RULES");
  assert.equal(c.result.taxDue, null);
  assert.equal(
    h.state.user.dateOfBirth.toISOString().slice(0, 10),
    "1950-03-15",
  );
});

test("printed CNIC mismatch blocks approval without changing profile", async () => {
  const h = harness({
    status: "COMPLETED",
    fields: pensionFields(10_992_000, { "Pensioner CNIC": "11111-1111111-1" }),
  });
  h.state.user.cnic = "22222-2222222-2";
  const r = await h.approve();
  assert.equal(r.success, false);
  assert.match(r.error, /CNIC differs/i);
  assert.equal(h.state.user.cnic, "22222-2222222-2");
});

test("a printed DOB does not silently fill an unknown profile DOB", async () => {
  const h = harness({
    dob: null,
    status: "COMPLETED",
    fields: pensionFields(10_992_000, { "Date of Birth": "1962-03-15" }),
  });
  assert.equal((await h.approve()).success, true);
  const r = await calculated(h);
  assert.equal(r.result.status, "NEEDS_RULES");
  assert.equal(r.result.taxDue, null);
  assert.equal(h.state.user.dateOfBirth, null);
  assert.equal((await h.generate()).success, false);
});

for (const status of ["PENDING", "PROCESSING", "FAILED", "COMPLETED"]) {
  test(`newest ${status} pension cannot fall back to an older MAPPED pension`, async () => {
    const h = harness();
    h.state.documents.push({
      ...h.state.documents[0],
      id: "qa-newer",
      createdAt: new Date("2026-10-19T01:00:00Z"),
      extractionStatus: status,
    });
    const r = await calculated(h);
    assert.equal(r.result.status, "NEEDS_RULES");
    assert.equal(r.result.taxDue, null);
    assert.equal((await h.completeness()).success, false);
    assert.equal((await h.approve()).success, false);
  });
}

test("missing or malformed mapped statement blocks tax even when old bank credits exist", async () => {
  for (const raw of [
    null,
    "broken JSON",
    "{}",
    JSON.stringify({ fields: [] }),
  ]) {
    const h = harness();
    h.state.documents[0].extractedData = raw;
    const r = await calculated(h);
    assert.equal(r.result.status, "NEEDS_RULES");
    assert.equal(r.result.taxDue, null);
  }
  const h = harness();
  h.state.documents = h.state.documents.filter(
    (d) => d.documentType !== "pension_statement",
  );
  assert.equal((await calculated(h)).result.status, "NEEDS_RULES");
});

for (const [answer, expectedExemption] of [
  [false, 1_989_000],
  [true, 0],
  ["legacy", 0],
]) {
  test(`packet answer ${answer}: canonical annual pension once, explicit exemption/final resets`, async () => {
    const h = harness({ pension: 1_989_000, answer });
    if (answer === "legacy")
      h.state.draft.incomeSelections[0].detailsJson = "{}";
    const snapshot = await generated(h);
    const rows = pensionRows(snapshot);
    assert.equal(rows.length, 3);
    assert.equal(
      rows.find((f) => f.column === "Total Amount").ourAmount,
      1_989_000,
    );
    assert.equal(
      rows.find((f) => f.column === "Subject to Exemption").ourAmount,
      expectedExemption,
    );
    assert.equal(
      rows.find((f) => f.column === "Subject to Final Tax").ourAmount,
      0,
    );
    assert.equal(snapshot.coverage.mode, "complete");
    assert.equal(await validation(h, snapshot), null);
    assert.equal(pensionEntryHold(flatSnapshot(h, snapshot)), null);
  });
}

test("70+ high pension gets reviewed annual Total/Exemption, not the old bank amount", async () => {
  const h = harness({ dob: "1955-07-01" });
  const snapshot = await generated(h);
  assert.equal(snapshot.pension.annualPension, 10_992_000);
  assert.equal(
    pensionRows(snapshot).find((f) => f.column === "Subject to Exemption")
      .ourAmount,
    10_992_000,
  );
  assert.equal(snapshot.coverage.mode, "complete");
  assert.equal(await validation(h, snapshot), null);
});

test("reviewed high pension produces a complete final-tax and surcharge contract", async () => {
  const h = harness();
  const snapshot = await generated(h);
  assert.equal(snapshot.coverage.mode, "complete");
  assert.equal(snapshot.portalFieldMap.mappingGaps.pensionManualReview, undefined);
  const flat = h
    .load("lib/tax/portal-field-map.ts")
    .flattenPortalFieldMap(snapshot.portalFieldMap);
  const finalTax = flat.filter((f) => ["64020007", "923184"].includes(f.irisCode));
  assert.deepEqual(
    plain(finalTax.map((f) => [f.irisCode, f.column, f.value])),
    [["64020007", "Taxable Amount", "992000"], ["64020007", "Tax Deducted", "0"], ["923184", "Total Income", "4960"]],
  );
  assert.equal(
    finalTax.find((f) => f.column === "Taxable Amount").replaceOnlyIfExisting,
    "10992000",
  );
  assert.equal(
    flat.find((f) => f.irisCode === "1008" && f.column === "Subject to Final Tax").replaceOnlyIfExisting,
    "10992000",
  );
  assert.equal(await validation(h, snapshot), null);
  assert.equal(pensionEntryHold(flatSnapshot(h, snapshot)), null);
  const pdf = await h
    .load("app/actions/packet.ts")
    .generateFilingPacketPdfAction("qa-draft");
  assert.equal(pdf.success, true, pdf.error);
  assert.equal(h.state.pdfBuffer.subarray(0, 5).toString(), "%PDF-");
});

for (const [deducted, covered, ledger, expectedCredit] of [
  [10_000, 0, 0, 10_000],
  [10_000, 10_000, 10_000, 10_000],
  [12_000, 10_000, 20_000, 22_000],
  [0, 0, 10_000, 10_000],
]) {
  test(`actual WHT ${deducted}, covered ${covered}, ledger ${ledger}: one credit ${expectedCredit}, stable on repeat`, async () => {
    const h = harness({
      ledgerTax: ledger,
      fields: pensionFields(10_992_000, {
        [deductedLabel]: deducted,
        [coveredLabel]: covered,
      }),
    });
    for (let i = 0; i < 2; i++) {
      const r = await calculated(h);
      assert.equal(r.result.taxWithheld, expectedCredit);
      assert.equal(r.result.taxPayable, 54_560 - expectedCredit);
    }
  });
}

test("reviewed zero pension WHT does not reuse prior pension calculation output as a credit", async () => {
  const h = harness();
  h.state.draft.taxWithheld = new Prisma.Decimal(25_000);
  const r = await calculated(h);
  assert.equal(r.result.taxWithheld, 0);
  assert.equal(r.result.taxPayable, 54_560);
});

test("non-pension stored-credit fallback remains unchanged", async () => {
  const h = harness({ salary: 2_000_000 });
  h.state.draft.incomeSources = '["salary"]';
  h.state.draft.incomeSelections = h.state.draft.incomeSelections.filter(
    (s) => s.source === "salary",
  );
  h.state.draft.taxWithheld = new Prisma.Decimal(25_000);
  const r = await calculated(h);
  assert.equal(r.result.taxWithheld, 25_000);
  assert.equal(r.result.taxPayable, 69_000);
});

for (const [deducted, covered, ledger] of [
  [1_000, 1_001, 2_000],
  [10_000, 8_000, 7_000],
]) {
  test(`invalid pension WHT allocation ${deducted}/${covered}/${ledger} fails approval and calculation`, async () => {
    const h = harness({
      status: "COMPLETED",
      ledgerTax: ledger,
      fields: pensionFields(10_992_000, {
        [deductedLabel]: deducted,
        [coveredLabel]: covered,
      }),
    });
    assert.equal((await h.approve()).success, false);
    h.state.documents[0].extractionStatus = "MAPPED";
    assert.equal((await calculated(h)).result.status, "NEEDS_RULES");
  });
}

test("actual final-pension WHT is automated to 64020007 only, never converted to liability or salary 64020004", async () => {
  const h = harness({
    fields: pensionFields(10_992_000, { [deductedLabel]: 10_000 }),
  });
  const snapshot = await generated(h);
  const finalTax = snapshot.portalFieldMap.adjustableTaxFields.filter(
    (f) => f.irisCode === "64020007",
  );
  assert.deepEqual(
    finalTax.map((f) => [f.column, f.ourAmount]),
    [["Taxable Amount", 992_000], ["Tax Deducted", 10_000]],
  );
  assert.equal(
    snapshot.portalFieldMap.adjustableTaxFields.find((f) => f.irisCode === "923184").ourAmount,
    4_960,
  );
  assert.equal(
    snapshot.portalFieldMap.adjustableTaxFields.some(
      (f) => f.irisCode === "64020004",
    ),
    false,
  );
  assert.equal(await validation(h, snapshot), null);
});

test("even an exempt pension with actual WHT is an explicit manual portal case", async () => {
  const h = harness({
    pension: 1_989_000,
    fields: pensionFields(1_989_000, { [deductedLabel]: 1_000 }),
  });
  const snapshot = await generated(h, true);
  assert.equal(snapshot.coverage.mode, "partial_manual_entry_required");
  assert.match(await validation(h, snapshot), /manual pension/i);
  assert.equal(pensionRows(snapshot).length, 0);
});

for (const [name, edit] of [
  [
    "approved annual base",
    (h) => {
      const p = JSON.parse(h.state.documents[0].extractedData);
      p.fields.find((f) => f.label === approvedLabel).value = 2_100_000;
      h.state.documents[0].extractedData = JSON.stringify(p);
    },
  ],
  [
    "former-employer answer",
    (h) => {
      h.state.draft.incomeSelections[0].detailsJson = JSON.stringify({
        userDetails: { worksForFormerEmployerOrAssociate: true },
      });
    },
  ],
  [
    "profile DOB",
    (h) => {
      h.state.user.dateOfBirth = new Date("1950-03-15T00:00:00Z");
    },
  ],
  [
    "profile CNIC",
    (h) => {
      h.state.user.cnic = "11111-1111111-1";
    },
  ],
  [
    "bank pension cash evidence",
    (h) => {
      h.state.entries[0].amount = new Prisma.Decimal(1_990_000);
    },
  ],
  [
    "tax ledger evidence",
    (h) => {
      h.state.entries.push({
        entryType: "EXPENSE",
        category: "TAX_PAYMENT",
        amount: new Prisma.Decimal(100),
      });
    },
  ],
  [
    "replacement document identity",
    (h) => {
      h.state.documents[0].id = "qa-replacement";
    },
  ],
]) {
  test(`changed ${name}: old calculation cannot generate a new packet and pinned context is rejected`, async () => {
    const h = harness({ pension: 1_989_000 });
    const snapshot = await generated(h);
    edit(h);
    const r = await h.generate();
    assert.equal(r.success, false);
    assert.match(r.error, /pension|recalculate/i);
    const error = await validation(h, snapshot);
    assert.ok(error);
    assert.match(error, /pension|recalculate|changed/i);
  });
}

test("edited pension review supersedes prior packets, clears tax approval and cancels active agent jobs", async () => {
  const h = harness({ pension: 1_989_000 });
  await generated(h);
  h.state.draft.packetApprovalConfirmed = true;
  const r = await h.edit({ fields: pensionFields(2_100_000) });
  assert.equal(r.success, true, r.error);
  assert.equal(h.state.documents[0].extractionStatus, "COMPLETED");
  assert.equal(h.state.draft.taxCalculationStatus, "NOT_CALCULATED");
  assert.equal(h.state.draft.taxCalculationRevision, null);
  assert.equal(h.state.draft.packetApprovalConfirmed, false);
  assert.equal(h.state.draft.taxPayable, null);
  assert.equal(h.state.packets[0].status, "SUPERSEDED");
  assert.equal(h.state.packets[0].approvalStatus, "SUPERSEDED");
  assert.ok(h.state.cancelledJobs > 0);
  assert.equal(h.state.entries[0].amount.toNumber(), 1_989_000);
});

test("edited annual pension can be re-approved/recalculated into a new consistent packet", async () => {
  const h = harness({ pension: 1_989_000 });
  const original = await generated(h);
  assert.equal(
    (await h.edit({ fields: pensionFields(2_100_000) })).success,
    true,
  );
  assert.equal((await h.approve()).success, true);
  const next = await generated(h);
  assert.notEqual(next.pension.fingerprint, original.pension.fingerprint);
  assert.equal(next.pension.annualPension, 2_100_000);
  assert.equal(
    pensionRows(next).find((f) => f.column === "Total Amount").ourAmount,
    2_100_000,
  );
  assert.equal(await validation(h, next), null);
});

test("profile DOB edit invalidates only active pension filings and cancels their jobs", async () => {
  const h = harness({ pension: 1_989_000 });
  await generated(h);
  const r = await h.load("app/actions/user.ts").updateUserProfile({
    fullName: "QA Pensioner",
    cnic: "",
    ntn: "",
    dateOfBirth: "1950-03-15",
    phone: "",
    address: "",
    city: "",
    taxYear: "2026",
  });
  assert.equal(r.success, true, r.error);
  assert.equal(h.state.draft.taxCalculationStatus, "NOT_CALCULATED");
  assert.equal(h.state.packets[0].status, "SUPERSEDED");
  assert.ok(h.state.cancelledJobs > 0);
  const nonPension = harness({ pension: 1_989_000 });
  nonPension.state.draft.incomeSources = '["salary"]';
  nonPension.state.draft.taxCalculationStatus = "ESTIMATE";
  const second = await nonPension
    .load("app/actions/user.ts")
    .updateUserProfile({
      fullName: "QA Other",
      cnic: "",
      ntn: "",
      dateOfBirth: "1950-03-15",
      phone: "",
      address: "",
      city: "",
      taxYear: "2026",
    });
  assert.equal(second.success, true, second.error);
  assert.equal(nonPension.state.draft.taxCalculationStatus, "ESTIMATE");
  assert.equal(nonPension.state.cancelledJobs, 0);
});

test("persisted No-to-Yes answer edit invalidates pension calculation, packet and local job", async () => {
  const h = harness({ pension: 1_989_000 });
  await generated(h);
  h.state.draft.wizardCompletionStep = 5;
  const r = await h
    .load("app/actions/filing.ts")
    .updateFilingDraftAction("qa-draft", {
      incomeSources: ["pension"],
      incomeSubcategorySelections: [
        {
          source: "pension",
          subcategory: "former-employer-or-associate",
          details: { worksForFormerEmployerOrAssociate: true },
        },
      ],
    });
  assert.equal(r.success, true, r.error);
  assert.equal(h.state.draft.taxCalculationStatus, "NOT_CALCULATED");
  assert.equal(h.state.draft.taxCalculationRevision, null);
  assert.equal(h.state.packets[0].status, "SUPERSEDED");
  assert.ok(h.state.cancelledJobs > 0);
  const calc = await calculated(h);
  assert.equal(calc.result.taxDue, 92_790);
});

test("legacy pension packet is rejected rather than silently trusting cached bank amounts", async () => {
  const h = harness({ pension: 1_989_000 });
  const snapshot = await generated(h);
  delete snapshot.pension;
  assert.match(
    await validation(h, snapshot),
    /predates reviewed annual sources/i,
  );
  assert.equal(pensionEntryHold(snapshot).paused, true);
});

test("server source-validation never changes a non-pension packet", async () => {
  const h = harness();
  const snapshot = {
    filing: { incomeSources: ["salary"] },
    portalFieldMap: [],
  };
  assert.equal(await validation(h, snapshot), null);
  assert.equal(pensionEntryHold(snapshot), null);
});

test("desktop independently rejects missing zero-clear columns and a mismatched map fingerprint", async () => {
  const h = harness({ pension: 1_989_000 });
  const snapshot = await generated(h);
  for (const mutate of [
    (s) => {
      s.portalFieldMap.incomeFields = s.portalFieldMap.incomeFields.filter(
        (f) => f.column !== "Subject to Final Tax",
      );
    },
    (s) => {
      s.portalFieldMap.computationHints.pensionSourceFingerprint = "wrong";
    },
  ]) {
    const broken = plain(snapshot);
    mutate(broken);
    assert.equal(pensionEntryHold(flatSnapshot(h, broken)).paused, true);
  }
});

test("both real desktop entry points stop a broken pension contract BEFORE creating/touching a portal window", async () => {
  const h = harness();
  const snapshot = await generated(h);
  snapshot.portalFieldMap.adjustableTaxFields = snapshot.portalFieldMap.adjustableTaxFields.filter(
    (field) => field.irisCode !== "64020007",
  );
  const source = fs.readFileSync(
    path.join(root, "electron-connect/main.js"),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "main.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  for (const name of ["runLocalIrisNavigationCheck", "runRealIrisAutofill"]) {
    const fn = ast.statements.find(
      (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
    );
    let windowsTouched = 0;
    const ctx = {
      module: { exports: {} },
      pensionEntryHold,
      assertNavigatorBuild() {},
      ensureWorkerWindow: async () => {
        windowsTouched++;
        throw new Error("Unsafe browser access");
      },
    };
    vm.runInNewContext(`${fn.getText(ast)}; module.exports = ${name};`, ctx);
    const result = await ctx.module.exports(
      { filingPacket: { snapshot: flatSnapshot(h, snapshot) } },
      { id: "qa-job" },
      "dry",
    );
    assert.equal(result.paused, true);
    assert.equal(result.result.readyToSubmit, false);
    assert.equal(result.result.submitted, false);
    assert.equal(windowsTouched, 0);
  }
});

test("new desktop runtime guard is included in installer file allowlist", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "electron-connect/package.json"), "utf8"),
  );
  assert.ok(pkg.build.files.includes("pension-guard.js"));
});

test("desktop routes 64020007 only to the Final Tax grid, never Adjustable Tax", () => {
  const main = fs.readFileSync(path.join(root, "electron-connect/main.js"), "utf8");
  const navigation = fs.readFileSync(
    path.join(root, "electron-connect/iris-navigation.js"),
    "utf8",
  );
  assert.match(main, /"64020004": "Adjustable Tax"/);
  assert.match(main, /"64020007": "Final Tax"/);
  assert.match(navigation, /"final tax": \["64020007"\]/);
  assert.match(navigation, /"adjustable tax": \["64020004"\]/);
  assert.doesNotMatch(navigation, /"final tax": \["64020004"\]/);
  assert.match(
    navigation,
    /normalizedGridTitle === "final tax"[\s\S]{0,180}\["taxable amount", "tax deducted", "tax chargeable"\]/,
    "64020007 Final Tax rows have a third calculated Tax Chargeable cell; navigation must accept that verified shape",
  );
});

for (const answer of [true, "legacy"]) {
  test(`high-pension former-employer ${answer} keeps salary treatment with cleared exemption/final columns`, async () => {
    const h = harness({ answer });
    if (answer === "legacy")
      h.state.draft.incomeSelections[0].detailsJson = "{}";
    const snapshot = await generated(h);
    assert.equal(snapshot.pension.treatment, "salary");
    assert.equal(snapshot.coverage.mode, "complete");
    assert.equal(
      pensionRows(snapshot).find((f) => f.column === "Total Amount").ourAmount,
      10_992_000,
    );
    assert.equal(
      pensionRows(snapshot).find((f) => f.column === "Subject to Exemption")
        .ourAmount,
      0,
    );
    assert.equal(
      pensionRows(snapshot).find((f) => f.column === "Subject to Final Tax")
        .ourAmount,
      0,
    );
    assert.equal(await validation(h, snapshot), null);
  });
}

test("salary certificate WHT and reviewed pension WHT each contribute once on repeated calculations", async () => {
  const h = harness({
    pension: 1_989_000,
    salary: 2_000_000,
    fields: pensionFields(1_989_000, { [deductedLabel]: 10_000 }),
  });
  const doc = h.state.documents.find(
    (d) => d.documentType === "salary_certificate",
  );
  const parsed = JSON.parse(doc.extractedData);
  parsed.fields.find((f) => f.label === "Tax Deducted u/s 149").value = 5_000;
  doc.extractedData = JSON.stringify(parsed);
  for (let i = 0; i < 2; i++) {
    const r = await calculated(h);
    assert.equal(r.result.taxWithheld, 15_000);
    assert.equal(r.result.taxPayable, 79_000);
  }
});

test("reviewed high-pension packet is available for PDF and automatic dispatch", async () => {
  const h = harness();
  const snapshot = await generated(h);
  const fetched = await h
    .load("app/actions/packet.ts")
    .getLatestFilingPacketAction("qa-draft");
  assert.equal(fetched.success, true, fetched.error);
  assert.equal(fetched.packet.mappingGaps.pensionManualReview, undefined);
  assert.equal(await validation(h, snapshot), null);
  assert.equal(pensionEntryHold(flatSnapshot(h, snapshot)), null);
});

test("stale source is rejected by latest-packet fetch and PDF generation too", async () => {
  const h = harness({ pension: 1_989_000 });
  await generated(h);
  h.state.user.dateOfBirth = new Date("1950-03-15T00:00:00Z");
  const fetched = await h
    .load("app/actions/packet.ts")
    .getLatestFilingPacketAction("qa-draft");
  assert.equal(fetched.success, false);
  assert.match(fetched.error, /changed/i);
  const pdf = await h
    .load("app/actions/packet.ts")
    .generateFilingPacketPdfAction("qa-draft");
  assert.equal(pdf.success, false);
  assert.equal(h.state.pdfBuffer, undefined);
});

test("server rejects tampered pension metadata and absent zero-clear field despite a copied source hash", async () => {
  const h = harness({ pension: 1_989_000 });
  const snapshot = await generated(h);
  const wrongMetadata = plain(snapshot);
  wrongMetadata.pension.annualPension = 1;
  assert.match(await validation(h, wrongMetadata), /metadata does not match/i);
  const noClear = plain(snapshot);
  noClear.portalFieldMap.incomeFields =
    noClear.portalFieldMap.incomeFields.filter(
      (f) => f.column !== "Subject to Final Tax",
    );
  assert.match(await validation(h, noClear), /zero-clear columns/i);
});

test("missing/unknown desktop pension withholding metadata is a hold, not implicit zero", async () => {
  const h = harness({ pension: 1_989_000 });
  const snapshot = await generated(h);
  for (const value of [undefined, null, -1, "0", "unknown"]) {
    const broken = plain(snapshot);
    broken.pension.taxDeducted = value;
    assert.equal(pensionEntryHold(flatSnapshot(h, broken)).paused, true);
  }
});

async function queuedContext(h) {
  const packet = h.state.packets.at(-1);
  let accepted = 0;
  let audited = 0;
  h.prisma.trustedDevice = {
    findUnique: async () => ({
      id: "qa-device",
      userId: "qa-user",
      status: "ACTIVE",
    }),
  };
  h.prisma.localAgentJob.findFirst = async () => ({
    id: "qa-job",
    userId: "qa-user",
    filingDraftId: "qa-draft",
    trustedDeviceId: "qa-device",
    status: "offered_to_device",
    jobType: "tax_assisted_filing",
    filingDraft: { taxYear: 2026 },
    payloadJson: JSON.stringify({
      packetId: packet.id,
      packetVersion: packet.version,
      packetHash: packet.packetHash,
    }),
  });
  h.prisma.localAgentJob.update = async () => {
    accepted++;
    return {};
  };
  h.prisma.taxAuditEvent = {
    create: async () => {
      audited++;
      return {};
    },
  };
  const GET = h.load("app/api/local-agent/jobs/[jobId]/context/route.ts").GET;
  const result = await GET(
    {
      url: "https://app.example.invalid/api/local-agent/jobs/qa-job/context?deviceToken=qa-device-token",
      headers: { get: () => null },
    },
    { params: Promise.resolve({ jobId: "qa-job" }) },
  );
  return { result, accepted, audited };
}

for (const kind of ["legacy packet", "changed answer"]) {
  test(`real context API refuses ${kind} BEFORE accepting a job or exposing a field map`, async () => {
    const h = harness({ pension: 1_989_000 });
    await generated(h);
    if (kind === "legacy packet") {
      const s = snapshotOf(h);
      delete s.pension;
      h.state.packets.at(-1).snapshotJson = JSON.stringify(s);
    }
    if (kind === "changed answer")
      h.state.draft.incomeSelections[0].detailsJson = JSON.stringify({
        userDetails: { worksForFormerEmployerOrAssociate: true },
      });
    const { result, accepted, audited } = await queuedContext(h);
    assert.equal(result.status, 409);
    assert.equal(result.data.code, "PENSION_REVIEW_REQUIRED");
    assert.equal(result.data.snapshot, undefined);
    assert.equal(accepted, 0);
    assert.equal(audited, 0);
  });
}

test("real context API accepts a complete reviewed high-pension contract", async () => {
  const h = harness();
  await generated(h);
  const { result, accepted, audited } = await queuedContext(h);
  assert.equal(result.status, 200);
  assert.equal(accepted, 1);
  assert.equal(audited, 1);
  assert.equal(result.data.snapshot.pension.treatment, "final_above_10m");
});

test("pension No/Yes/No transition refreshes both tax and 1008 treatment with no stale exemption", async () => {
  const h = harness({ pension: 1_989_000 });
  for (const [answer, tax, exemption] of [
    [false, 0, 1_989_000],
    [true, 92_790, 0],
    [false, 0, 1_989_000],
  ]) {
    h.state.draft.incomeSelections[0].detailsJson = JSON.stringify({
      userDetails: { worksForFormerEmployerOrAssociate: answer },
    });
    const r = await calculated(h);
    assert.equal(r.result.taxDue, tax);
    const packet = await h.generate();
    assert.equal(packet.success, true, packet.error);
    const snapshot = snapshotOf(h);
    assert.equal(
      pensionRows(snapshot).find((f) => f.column === "Subject to Exemption")
        .ourAmount,
      exemption,
    );
    assert.equal(
      pensionRows(snapshot).find((f) => f.column === "Subject to Final Tax")
        .ourAmount,
      0,
    );
    assert.equal(await validation(h, snapshot), null);
  }
});

test("confirmed No below 10M calculates zero while exact statement basis still awaits packet review", async () => {
  const h = harness({
    pension: 1_989_000,
    ledgerPension: 1_989_000,
    answer: false,
    fields: pensionFields(1_989_000, {
      "Gross Pension (Annual PKR)": 1_896_000,
      "Medical Allowance (Annual PKR)": 93_000,
      "Net Pension Payable (Annual PKR)": 1_989_000,
      [approvedLabel]: null,
      [deductedLabel]: null,
      [coveredLabel]: null,
      "Pension Tax Base Review Note": null,
    }),
  });

  const calculation = await calculated(h);
  assert.equal(calculation.result.status, "ESTIMATE");
  assert.equal(calculation.result.taxDue, 0);

  const packet = await h.generate();
  assert.equal(packet.success, false);
  assert.match(packet.error, /Approved Pension Amount|Tax Deducted/i);
});

test("unresolved pension statement cannot bypass review for Yes or any plausible amount above 10M", async () => {
  for (const options of [
    { answer: true, pension: 1_989_000, ledgerPension: 1_989_000 },
    { answer: false, pension: 10_000_001, ledgerPension: 10_000_001 },
  ]) {
    const h = harness({
      ...options,
      fields: pensionFields(options.pension, {
        "Gross Pension (Annual PKR)": options.pension,
        "Medical Allowance (Annual PKR)": 93_000,
        "Net Pension Payable (Annual PKR)": options.pension,
        [approvedLabel]: null,
        [deductedLabel]: null,
        [coveredLabel]: null,
        "Pension Tax Base Review Note": null,
      }),
    });
    const calculation = await calculated(h);
    assert.equal(calculation.result.status, "NEEDS_RULES");
    assert.equal(calculation.result.taxDue, null);
  }
});

test("UI exposes pension approval, blocks unmapped/unsaved pension, and labels manual packet truthfully", () => {
  const documents = fs.readFileSync(
    path.join(root, "components/tax/filing/wizard-documents-step.tsx"),
    "utf8",
  );
  const hook = fs.readFileSync(
    path.join(root, "components/tax/filing/hooks/use-filing-documents.ts"),
    "utf8",
  );
  const wizard = fs.readFileSync(
    path.join(root, "components/tax/filing/filing-wizard.tsx"),
    "utf8",
  );
  const packet = fs.readFileSync(
    path.join(root, "components/tax/filing/wizard-packet-step.tsx"),
    "utf8",
  );
  assert.match(documents, /isPensionStatement \|\|/);
  assert.match(
    documents,
    /!isMapped \|\| purchaseBasisMissing/,
  );
  assert.match(hook, /Unsaved pension changes/);
  assert.match(wizard, /Save & Approve Map for the Pension Statement/);
  assert.match(packet, /Desktop auto-entry is blocked/);
  assert.match(packet, /not completed pension entry/);
});

function savedDraftForm(answer) {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    draftId: "qa-draft",
    taxYear: "2026",
    filerType: "myself",
    residencyStatus: "resident",
    incomeSources: "pension",
    currentStep: "2",
    wizardCompletionStep: "2",
  }))
    form.set(key, value);
  form.append(
    "incomeSubcategorySelections",
    JSON.stringify({
      source: "pension",
      subcategory: "former-employer-or-associate",
      details: { worksForFormerEmployerOrAssociate: answer },
    }),
  );
  return form;
}

test("Save Draft path cannot bypass pension answer invalidation", async () => {
  const h = harness({ pension: 1_989_000 });
  await generated(h);
  const priorCancels = h.state.cancelledJobs;
  const r = await h
    .load("app/actions/filing.ts")
    .saveFilingDraftAction(savedDraftForm(true));
  assert.equal(r.success, true, r.error);
  assert.equal(h.state.draft.taxCalculationStatus, "NOT_CALCULATED");
  assert.equal(h.state.draft.taxCalculationRevision, null);
  assert.equal(h.state.packets[0].status, "SUPERSEDED");
  assert.ok(h.state.cancelledJobs > priorCancels);
});

test("unchanged pension Save Draft does not unnecessarily invalidate approved tax", async () => {
  const h = harness({ pension: 1_989_000 });
  await generated(h);
  const priorCancels = h.state.cancelledJobs;
  const r = await h
    .load("app/actions/filing.ts")
    .saveFilingDraftAction(savedDraftForm(false));
  assert.equal(r.success, true, r.error);
  assert.equal(h.state.draft.taxCalculationStatus, "ESTIMATE");
  assert.notEqual(h.state.packets[0].status, "SUPERSEDED");
  assert.equal(h.state.cancelledJobs, priorCancels);
});

test("actual replacement upload immediately invalidates pension even before extraction; bank rows survive", async () => {
  const h = harness({ pension: 1_989_000 });
  await generated(h);
  const priorCancels = h.state.cancelledJobs;
  const form = new FormData();
  form.set("draftId", "qa-draft");
  form.set("documentType", "pension_statement");
  form.set(
    "file",
    new (require("node:buffer").File)(
      [Buffer.from("%PDF-1.4\nSynthetic pension QA replacement\n%%EOF")],
      "qa-new-pension.pdf",
      { type: "application/pdf" },
    ),
  );
  const r = await h
    .load("app/actions/documents.ts")
    .uploadFilingDocumentAction(form);
  assert.equal(r.success, true, r.error);
  assert.equal(r.document.extractionStatus, "PENDING");
  assert.equal(h.state.draft.taxCalculationStatus, "NOT_CALCULATED");
  assert.equal(h.state.packets[0].status, "SUPERSEDED");
  assert.ok(h.state.cancelledJobs > priorCancels);
  assert.equal(h.state.entries[0].amount.toNumber(), 1_989_000);
  assert.equal(
    h.state.documents.some((d) => d.id === "qa-pension-doc"),
    false,
  );
  assert.equal((await calculated(h)).result.status, "NEEDS_RULES");
});

test("pension recalculation cancels already-running work pinned to its earlier revision", async () => {
  const h = harness({ pension: 1_989_000 });
  await generated(h);
  const priorCancels = h.state.cancelledJobs;
  await calculated(h);
  assert.ok(h.state.cancelledJobs > priorCancels);
  assert.equal(h.state.packets[0].status, "SUPERSEDED");
});

for (const [answer, expected] of [
  [false, 94_000],
  [true, 582_700],
]) {
  test(`mixed salary/pension answer ${answer}: packet fingerprint also follows combined calculation lines`, async () => {
    const h = harness({ pension: 1_989_000, salary: 2_000_000, answer });
    const snapshot = await generated(h);
    assert.equal(h.state.draft.taxPayable, expected);
    assert.equal(await validation(h, snapshot), null);
    const line = h.state.lines.find(
      (line) => JSON.parse(line.detailsJson).pensionSource,
    );
    assert.ok(line);
    assert.equal(
      JSON.parse(line.detailsJson).pensionSource.fingerprint,
      snapshot.pension.fingerprint,
    );
  });
}

test("pension withholding allocation uses exact money arithmetic before the existing engine", async () => {
  const h = harness({
    ledgerTax: 0.01,
    fields: pensionFields(10_992_000, {
      [deductedLabel]: 0.03,
      [coveredLabel]: 0.01,
    }),
  });
  const r = await calculated(h);
  assert.equal(r.pensionSource.creditToAdd, 0.02);
  assert.equal(r.result.taxWithheld, 0.03);
});

test("pension and withholding category normalization matches in calculator, packet and freshness checks", async () => {
  const h = harness({ pension: 1_989_000, ledgerTax: 1_000 });
  h.state.entries[0].category = "pension";
  h.state.entries[1].category = "Tax-Payment";
  const snapshot = await generated(h);
  assert.equal(snapshot.pension.ledgerPension, 1_989_000);
  assert.equal(await validation(h, snapshot), null);
});

test("legacy direct map callers also cannot silently collapse high/partial pension to Total-only", () => {
  const api = harness().load("lib/tax/portal-field-map.ts");
  for (const pensionDetails of [
    undefined,
    {
      totalPension: 10_992_000,
      exemptLimit: 10_000_000,
      exemptAmount: 10_000_000,
      taxableAmount: 992_000,
      age: 63,
    },
  ]) {
    const map = api.buildPortalFieldMap({
      taxYear: 2026,
      filerType: "myself",
      taxpayerListStatus: "ATL",
      ledgerEntries: [
        {
          id: "qa-legacy-bank-credit",
          entryType: "INCOME",
          category: "PENSION",
          amount: 10_992_000,
          description: "QA",
        },
      ],
      pensionDetails,
    });
    assert.equal(
      api.flattenPortalFieldMap(map).some((f) => f.irisCode === "1008"),
      false,
    );
    assert.equal(
      map.mappingGaps.unmappedCategories[0].category,
      "PENSION_UNAPPROVED_SPLIT",
    );
    assert.equal(
      api.describeUnmappedPortalSources(map.mappingGaps).coverage.mode,
      "partial_manual_entry_required",
    );
  }
});

test("unknown profile DOB does not block a No pension at or below 10M where age is immaterial", async () => {
  const h = harness({ pension: 10_000_000, dob: null });
  const snapshot = await generated(h);
  assert.equal(h.state.draft.taxPayable, 0);
  assert.equal(snapshot.pension.treatment, "exempt");
  assert.equal(await validation(h, snapshot), null);
});

test("pension cancellation is scoped to this user/draft and active jobs only", async () => {
  const h = harness();
  let cancellation;
  h.prisma.localAgentJob.updateMany = async (query) => {
    cancellation = query;
    return { count: 1 };
  };
  const r = await h.edit({ fields: pensionFields(10_488_000) });
  assert.equal(r.success, true, r.error);
  assert.equal(cancellation.where.filingDraftId, "qa-draft");
  assert.equal(cancellation.where.userId, "qa-user");
  assert.equal(cancellation.data.status, "cancelled");
  assert.ok(cancellation.where.status.in.includes("running"));
  assert.ok(cancellation.where.status.in.includes("awaiting_user_action"));
  assert.equal(
    cancellation.where.status.in.some((status) =>
      ["completed", "failed", "cancelled", "expired"].includes(status),
    ),
    false,
  );
});
