const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { JSDOM } = require("jsdom");
const { harness, root } = require("./helpers/pension-harness.cjs");
const { pensionEntryHold } = require("../electron-connect/pension-guard.js");
const fixture = require("../test-fixtures/pension/above-10m-ty2026.json");
const labels = {
  gross: "Gross Pension (Annual PKR)",
  medical: "Medical Allowance (Annual PKR)",
  net: "Net Pension Payable (Annual PKR)",
  deducted: "Pension Tax Deducted (Annual PKR)",
  approved: "Approved Pension Amount for Tax (Annual PKR)",
  overlap: "Pension Withholding Already in Tax Ledger (Annual PKR)",
  note: "Pension Tax Base Review Note",
};
const reviewLabels = [labels.approved, labels.overlap, labels.note];
const plain = (v) => JSON.parse(JSON.stringify(v));
function facts(changes = {}, removed = []) {
  const fields = plain(fixture.expectedExtraction.fields).filter((f) => !removed.includes(f.label));
  for (const [label, value] of Object.entries(changes)) {
    const field = fields.find((f) => f.label === label);
    if (field) field.value = value;
    else fields.push({ label, value });
  }
  return fields;
}
function qa(options = {}) {
  return harness({ pension: 12_000_000, ledgerPension: 12_000_000, status: "COMPLETED", fields: facts(), ...options });
}
function parser(h = qa()) { return h.load("lib/tax/pension-statement-fields.ts"); }
function render(fields, status = "COMPLETED") {
  const h = qa({ fields, status });
  const { WizardDocumentsStep } = h.load("components/tax/filing/wizard-documents-step.tsx");
  const noop = () => {};
  const html = renderToStaticMarkup(React.createElement(WizardDocumentsStep, {
    taxYear: 2026,
    documentSlots: [{ documentType: "pension_statement", label: "Pension Statement", reason: "QA", required: true }],
    uploadedDocuments: { pension_statement: "SYNTHETIC-Pension-12M-TY2026.pdf" },
    documentRecords: { pension_statement: { id: "qa-pension-doc", fileName: "qa.pdf", extractionStatus: status, extractionProvider: "synthetic", extractedAt: null } },
    extractedByDocumentId: { "qa-pension-doc": { fields } },
    reviewingDocumentId: "qa-pension-doc", uploadFileInputsRef: { current: {} },
    triggerDocumentUpload: noop, handleDocumentFileSelected: noop, handleExtractDocument: noop,
    handleReviewDocument: noop, handleExtractedFieldChange: noop, handlePensionReviewFieldChange: noop,
    handleExtractedTransactionChange: noop, handleSaveDocumentReview: noop, handleMapDocument: noop,
    handleSaveStatementIban: noop, handleSaveSalaryEmployers: noop, isSalaryEmployerDirty: () => false,
  }));
  return new JSDOM(html).window.document;
}
const labelElement = (doc, label) => [...doc.querySelectorAll("label")].find((node) => node.textContent.includes(label));
const approveButton = (doc) => [...doc.querySelectorAll("button")].find((node) => node.textContent === "Save & Approve Map");
function assertTaxHeld(result) {
  assert.equal(result.status, "NEEDS_USER_INPUT");
  for (const key of ["taxableIncome", "baseTax", "surcharge", "taxDue", "taxPayable", "refundDue"]) assert.equal(result[key], null, key);
}

// The new fixture has no app-only field printed to make an old validator pass.
test("ordinary PDF facts do not acquire three artificial reviewer requirements", () => {
  const h = qa(); const p = parser(h);
  const raw = { fields: facts() };
  const normalized = p.ensurePensionStatementReviewFields(raw, true);
  assert.equal(normalized.fields.some((f) => reviewLabels.includes(f.label)), false);
  assert.equal(p.getPensionStatementReviewErrors(normalized.fields, 2026).length, 0);
  const req = h.load("lib/tax/document-review-required.ts");
  const required = normalized.fields.filter((f) => req.isDocumentReviewRequiredField("pension_statement", f.label, normalized.fields)).map((f) => f.label);
  assert.deepEqual(plain(required), ["Tax Year", labels.gross]);
});

test("plain gross-only statement approves and prices 12M without a duplicate base, overlap entry or note", async () => {
  const h = qa();
  const result = await h.approve();
  assert.equal(result.success, true, result.error);
  assert.equal(result.annualPension, 12_000_000);
  const calc = await h.calculate();
  for (const key of ["status", "baseTax", "surcharge", "taxDue", "taxWithheld", "taxPayable", "refundDue"]) {
    assert.equal(calc.result[key], fixture.expectedCurrentEngine[key], key);
  }
  assert.equal(calc.pensionSource.annualPension, 12_000_000);
  assert.equal(calc.pensionSource.taxAlreadyInLedger, 0);
  assert.equal(calc.pensionSource.reviewNote, "");
  assert.equal(h.state.entries.length, 1);
  assert.equal(h.state.ledgerWrites.length, 0);
  assert.equal(h.state.user.dateOfBirth.toISOString().slice(0, 10), "1962-03-15");
});

for (const value of [undefined, null, ""]) {
  test(`missing/blank optional basis ${String(value)} uses unambiguous gross, not net or an invented scalar`, () => {
    const fields = value === undefined ? facts() : facts({ [labels.approved]: value });
    const source = parser().readReviewedPensionStatement({ fields }, 2026);
    assert.equal(source.approvedAnnual, 12_000_000);
    assert.equal(source.reviewNote, "");
  });
}

for (const value of [undefined, null, ""]) {
  test(`missing/blank withholding ${String(value)} may save facts but cannot price or produce a packet`, async () => {
    const fields = value === undefined ? facts({}, [labels.deducted]) : facts({ [labels.deducted]: value });
    const h = qa({ fields });
    assert.equal((await h.approve()).success, true);
    assert.equal(parser(h).readPensionStatementFacts(h.state.documents[0].extractedData, 2026).taxDeducted, null);
    const calc = await h.calculate();
    assertTaxHeld(calc.result);
    assert.match(calc.result.note, /unknown withholding is not zero/i);
    assert.equal((await h.generate({ acceptUnmappedPortalSources: true })).success, false);
    assert.equal(h.state.ledgerWrites.length, 0);
  });
}

test("normalizer and UI cannot show positive confidence for a missing fact", () => {
  const fields = facts({ [labels.deducted]: null });
  fields.find((f) => f.label === labels.deducted).confidence = 0.99;
  const normalized = parser().ensurePensionStatementReviewFields({ fields }, true);
  assert.equal(normalized.fields.find((f) => f.label === labels.deducted).confidence, 0);
  const doc = render(fields);
  assert.doesNotMatch(labelElement(doc, labels.deducted).textContent, /confidence/);
  assert.equal(approveButton(doc).disabled, false);
  assert.match(doc.querySelector('[role="status"]').textContent, /unknown withholding is not zero/i);
});

test("rendered ordinary facts require only year/gross; the note textarea is optional", () => {
  const doc = render(facts());
  assert.equal(doc.querySelectorAll("input[required]").length, 2);
  assert.equal(labelElement(doc, labels.note).querySelector("textarea").required, false);
  assert.equal(labelElement(doc, labels.note).querySelector("textarea").getAttribute("aria-required"), "false");
  assert.equal(labelElement(doc, labels.approved).querySelector("input").value, "");
  assert.equal(approveButton(doc).disabled, false);
});

for (const value of [null, "", "ok"]) {
  test(`manual tax-base override still needs a substantive reason (${JSON.stringify(value)})`, async () => {
    const fields = facts({ [labels.approved]: 11_000_000, [labels.note]: value });
    const h = qa({ fields });
    const req = h.load("lib/tax/document-review-required.ts");
    assert.equal(req.isDocumentReviewRequiredField("pension_statement", labels.note, fields), true);
    const result = await h.approve();
    assert.equal(result.success, false);
    assert.match(result.error, /Review Note.*required.*manual tax-base override/);
    assert.equal(h.state.updates.length, 0);
    const doc = render(fields);
    assert.equal(labelElement(doc, labels.note).querySelector("textarea").required, true);
    assert.equal(approveButton(doc).disabled, true);
  });
}

test("re-entering the identical unambiguous gross is not a tax-base override", async () => {
  const fields = facts({ [labels.approved]: "12,000,000", [labels.note]: "" });
  assert.equal(parser().pensionReviewNoteRequired(fields), false);
  const h = qa({ fields });
  assert.equal((await h.approve()).success, true);
  assert.equal((await h.calculate()).pensionSource.annualPension, 12_000_000);
});

test("an explicit reviewed override with a reason remains supported without silently replacing cash", async () => {
  const fields = facts({ [labels.approved]: 11_000_000, [labels.note]: "QA override branch only: verified example basis difference, not a legal exemption claim." });
  const h = qa({ fields });
  assert.equal((await h.approve()).success, true);
  assert.equal((await h.calculate()).pensionSource.annualPension, 11_000_000);
  assert.equal(h.state.entries[0].amount.toNumber(), 12_000_000);
  assert.equal(h.state.ledgerWrites.length, 0);
});

for (const blank of [undefined, null, ""]) {
  test(`allowance ambiguity is not guessed when approved basis is ${String(blank)}`, async () => {
    const changes = { [labels.medical]: 600_000, [labels.net]: 12_600_000 };
    if (blank !== undefined) changes[labels.approved] = blank;
    const fields = facts(changes);
    const h = qa({ fields });
    assert.equal((await h.approve()).success, true);
    assert.equal(parser(h).readPensionStatementFacts({ fields }, 2026).approvedAnnual, null);
    const calc = await h.calculate();
    assertTaxHeld(calc.result);
    assert.match(calc.result.note, /allowance treatment/);
  });
}

test("choosing gross despite a stated allowance still needs a reviewed-treatment reason", async () => {
  const fields = facts({ [labels.medical]: 600_000, [labels.net]: 12_600_000, [labels.approved]: 12_000_000 });
  assert.equal(parser().pensionReviewNoteRequired(fields), true);
  const h = qa({ fields });
  assert.equal((await h.approve()).success, false);
  fields.push({ label: labels.note, value: "QA reviewed allowance treatment for this branch; not automatic medical exemption." });
  assert.equal((await h.edit({ fields })).success, true);
  assert.equal((await h.approve()).success, true);
  assert.equal((await h.calculate()).pensionSource.annualPension, 12_000_000);
});

test("net above stated pension components triggers review, never an automatic annual tax base", async () => {
  const fields = facts({ [labels.net]: 12_500_000 });
  const h = qa({ fields });
  assert.equal((await h.approve()).success, true);
  const calc = await h.calculate();
  assertTaxHeld(calc.result);
  assert.match(calc.result.note, /net receipts exceed/);
  const withDecision = [...fields, { label: labels.approved, value: 12_000_000 }];
  assert.equal(parser(h).pensionReviewNoteRequired(withDecision), true);
});

test("positive actual deduction with a checked empty tax ledger needs no artificial overlap entry", async () => {
  const fields = facts({ [labels.deducted]: 100_000, [labels.net]: 11_900_000 });
  const h = qa({ fields, ledgerPension: 11_900_000 });
  assert.equal((await h.approve()).success, true);
  const calc = await h.calculate();
  assert.equal(calc.result.status, "ESTIMATE");
  assert.equal(calc.pensionSource.taxAlreadyInLedger, 0);
  assert.equal(calc.pensionSource.creditToAdd, 100_000);
  assert.equal(calc.result.taxWithheld, 100_000);
  assert.equal(calc.result.taxPayable, 10_000);
  assert.equal(h.state.ledgerWrites.length, 0);
});

test("positive deduction with unknown ledger context cannot be treated as no overlap", () => {
  const fields = facts({ [labels.deducted]: 100_000, [labels.net]: 11_900_000 });
  assert.throws(() => parser().readReviewedPensionStatement({ fields }, 2026), /Confirm Pension Withholding Already/);
});

for (const ledgerTax of [50_000, 200_000]) {
  test(`positive deduction plus a different TAX_PAYMENT total ${ledgerTax} asks for the overlap in plain words`, async () => {
    const fields = facts({ [labels.deducted]: 100_000, [labels.net]: 11_900_000 });
    const h = qa({ fields, ledgerTax });
    assert.equal((await h.approve()).success, true);
    const calc = await h.calculate();
    assertTaxHeld(calc.result);
    // The question names both figures and says what to enter, so the taxpayer
    // is not asked to reason about app internals.
    assert.match(calc.result.note, /Pension tax deducted is PKR 100,000/);
    assert.match(calc.result.note, new RegExp(`PKR ${ledgerTax.toLocaleString("en-PK")}`));
    assert.match(calc.result.note, /Enter how much of the deduction is already among those ledger payments/);
    assert.match(calc.result.note, /do not allocate unrelated/i);
  });
}

test("a ledger total equal to the certificate deduction is recognised, not asked about", async () => {
  // The payer's section 149 deduction is the only tax the bank ever saw, so the
  // two totals being equal means the same money: asking would confuse, and
  // counting it twice would invent a refund.
  const fields = facts({ [labels.deducted]: 100_000, [labels.net]: 11_900_000 });
  const h = qa({ fields, ledgerTax: 100_000 });
  assert.equal((await h.approve()).success, true);
  const calc = await h.calculate();
  assert.equal(calc.result.status, "ESTIMATE");
  assert.equal(calc.pensionSource.taxAlreadyInLedger, 100_000);
  assert.equal(calc.pensionSource.creditToAdd, 0);
  assert.equal(calc.result.taxWithheld, 100_000);
  assert.equal(calc.result.taxPayable, 10_000);
  assert.match(calc.pensionSource.overlapNote, /exactly the deduction on the pension certificate/);
});

test("multi-source filing never auto-zeros pension WHT against an equal-sized non-pension TAX_PAYMENT row", async () => {
  // On Salary + Pension (or Pension + Services / Bank Profit), an equal-sized
  // bank TAX_PAYMENT row may belong to another income source. It must prompt
  // for explicit confirmation instead of silently dropping the pension credit.
  const unconfirmedFields = facts({ [labels.deducted]: 100_000, [labels.net]: 11_900_000 });
  const unconfirmed = qa({
    fields: unconfirmedFields,
    salary: 2_000_000,
    ledgerTax: 100_000,
  });
  assert.equal((await unconfirmed.approve()).success, true);
  const held = await unconfirmed.calculate();
  assertTaxHeld(held.result);
  assert.match(held.result.note, /Pension tax deducted is PKR 100,000/);
  assert.match(held.result.note, /Enter how much of the deduction is already among those ledger payments/);

  // Once the taxpayer confirms 0 overlap (separate non-pension payment), both
  // the 100,000 ledger tax payment and 100,000 pension WHT are preserved.
  const separateFields = facts({
    [labels.deducted]: 100_000,
    [labels.net]: 11_900_000,
    [labels.overlap]: 0,
  });
  const separate = qa({
    fields: separateFields,
    salary: 2_000_000,
    ledgerTax: 100_000,
  });
  assert.equal((await separate.approve()).success, true);
  const resolved = await separate.calculate();
  assert.equal(resolved.result.status, "ESTIMATE");
  assert.equal(resolved.pensionSource.taxAlreadyInLedger, 0);
  assert.equal(resolved.pensionSource.creditToAdd, 100_000);
  assert.equal(resolved.pensionSource.overlapNote, null);
  assert.equal(resolved.result.taxWithheld, 200_000);
});

test("reviewed overlap counts pension withholding once and does not require a tax-base note", async () => {
  const fields = facts({ [labels.deducted]: 100_000, [labels.net]: 11_900_000, [labels.overlap]: 100_000 });
  const h = qa({ fields, ledgerTax: 100_000 });
  assert.equal(parser(h).pensionReviewNoteRequired(fields), false);
  assert.equal((await h.approve()).success, true);
  for (let i = 0; i < 2; i++) {
    const calc = await h.calculate();
    assert.equal(calc.result.taxWithheld, 100_000);
    assert.equal(calc.pensionSource.creditToAdd, 0);
    assert.equal(calc.result.taxPayable, 10_000);
  }
});

test("known nil pension withholding cannot overlap unrelated existing tax payments", async () => {
  const h = qa({ ledgerTax: 100_000 });
  assert.equal((await h.approve()).success, true);
  const calc = await h.calculate();
  assert.equal(calc.result.status, "ESTIMATE");
  assert.equal(calc.pensionSource.taxDeducted, 0);
  assert.equal(calc.pensionSource.taxAlreadyInLedger, 0);
  assert.equal(calc.pensionSource.creditToAdd, 0);
});

for (const value of [Infinity, NaN, [], {}, false, 0, -1]) {
  test(`provided malformed override is not an optional blank: ${String(value)}`, () => {
    const errors = parser().getPensionStatementReviewErrors(facts({ [labels.approved]: value }), 2026);
    assert.ok(errors.some((error) => /Approved Pension Amount.*positive/.test(error)));
  });
}

for (const currency of ["USD", 0, true]) {
  test(`explicit non-PKR/malformed currency ${currency} cannot masquerade as annual PKR pension`, async () => {
    const h = qa({ fields: facts({ Currency: currency }) });
    const approved = await h.approve();
    assert.equal(approved.success, false);
    assert.match(approved.error, /currency must be PKR/);
    assert.equal(h.state.ledgerWrites.length, 0);
  });
}

test("optional missing currency does not create a third required PDF field for explicitly labelled PKR amounts", async () => {
  const h = qa({ fields: facts({}, ["Currency"]) });
  assert.equal((await h.approve()).success, true);
  assert.equal((await h.calculate()).pensionSource.annualPension, 12_000_000);
});

for (const value of [Infinity, -Infinity, NaN]) {
  test(`review-save rejects non-finite ${value} before JSON could erase an invalid optional override`, async () => {
    const h = qa();
    const before = h.state.documents[0].extractedData;
    const saved = await h.edit({ fields: facts({ [labels.approved]: value }) });
    assert.equal(saved.success, false);
    assert.match(saved.error, /non-finite/);
    assert.equal(h.state.documents[0].extractedData, before);
    assert.equal(h.state.updates.length, 0);
  });
}

test("monthly-only source never auto-annualizes to satisfy annual gross", async () => {
  const fields = facts({ "Gross Pension (Monthly PKR)": 1_000_000 }, [labels.gross]);
  const h = qa({ fields });
  assert.equal((await h.approve()).success, false);
  assert.equal(h.state.ledgerWrites.length, 0);
});

test("12M fixture covers PDF bytes -> approval/calculation/automated packet/PDF/desktop pass", async () => {
  const pdfBytes = fs.readFileSync(path.join(root, "test-fixtures/pension/SYNTHETIC-Pension-12M-TY2026.pdf"));
  const response = { documentType: "pension_statement", fields: facts().map((f) => ({ ...f, confidence: 0.99 })), transactions: [], notes: [] };
  const h = qa({ status: "PENDING", modelResponse: response, extractionFileBuffer: pdfBytes });
  Object.assign(h.state.documents[0], { extractedData: null, mimeType: "application/pdf", fileUrl: "/uploads/synthetic-pension.pdf", extractionStartedAt: null });
  const prior = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "offline-qa-key-never-sent-to-network";
  let extracted;
  try { extracted = await h.extract(); }
  finally { if (prior === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prior; }
  assert.equal(extracted.success, true, extracted.error);
  assert.equal(h.state.fileReads.length, 1);
  assert.equal(h.state.modelCalls.length, 1);
  const filePart = h.state.modelCalls[0].find((part) => part.inlineData);
  assert.equal(filePart.inlineData.data, pdfBytes.toString("base64"));
  assert.equal(extracted.extracted.fields.some((f) => reviewLabels.includes(f.label)), false);
  assert.equal((await h.calculate()).result.status, "NEEDS_USER_INPUT"); // Human approval still required.
  assert.equal((await h.approve()).success, true);
  const calc = await h.calculate();
  assert.equal(calc.result.taxDue, 110_000);
  assert.equal(calc.result.taxPayable, 110_000);
  assert.equal((await h.completeness()).success, true);
  const packet = await h.generate();
  assert.equal(packet.success, true, packet.error);
  const snapshot = JSON.parse(h.state.packets.at(-1).snapshotJson);
  assert.equal(snapshot.coverage.mode, "complete");
  assert.equal(snapshot.pension.annualPension, 12_000_000);
  assert.equal(snapshot.pension.reviewNote, "");
  const flat = h.load("lib/tax/portal-field-map.ts").flattenPortalFieldMap(snapshot.portalFieldMap);
  const pensionExcess = flat.find((f) => f.irisCode === "64020007" && f.column === "Taxable Amount");
  assert.equal(pensionExcess.value, "2000000");
  assert.equal(
    pensionExcess.replaceOnlyIfExisting,
    "12000000",
    "the agent may replace only the known stale full-pension figure with the amount above PKR 10M",
  );
  const pensionFinal = flat.find((f) => f.irisCode === "1008" && f.column === "Subject to Final Tax");
  assert.equal(pensionFinal.value, "2000000");
  assert.equal(pensionFinal.replaceOnlyIfExisting, "12000000");
  assert.equal(
    flat.find((f) => f.irisCode === "1008" && f.column === "Subject to Exemption").value,
    "10000000",
  );
  assert.equal(flat.find((f) => f.irisCode === "923184").value, "10000");
  const hold = pensionEntryHold({ ...snapshot, portalFieldMapDetailed: snapshot.portalFieldMap, portalFieldMap: flat });
  assert.equal(hold, null);
  const exported = await h.load("app/actions/packet.ts").generateFilingPacketPdfAction("qa-draft");
  assert.equal(exported.success, true, exported.error);
  assert.equal(h.state.pdfBuffer.subarray(0, 5).toString(), "%PDF-");
  assert.equal(h.state.ledgerWrites.length, 0);
});
