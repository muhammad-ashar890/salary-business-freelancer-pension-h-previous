const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { JSDOM } = require("jsdom");
const {
  harness,
  pensionFields,
  root,
} = require("./helpers/pension-harness.cjs");

const approved = "Approved Pension Amount for Tax (Annual PKR)";
const covered = "Pension Withholding Already in Tax Ledger (Annual PKR)";
const note = "Pension Tax Base Review Note";
const deducted = "Pension Tax Deducted (Annual PKR)";
const reviewLabels = [approved, covered, note];
const qaNote =
  "SYNTHETIC QA ONLY. Approved annual pension PKR 1,989,000 includes gross PKR 1,896,000 and medical PKR 93,000 as a selected test treatment, not a legal classification. Net and source-fixture bank reference are PKR 1,989,000, difference PKR 0; no independent bank verification. Deducted tax and TAX_PAYMENT overlap are explicitly zero test assumptions, not verified real-world facts. This changes only the tax source, not cash income or profile DOB. Recalculate and create a fresh packet after approval.";
const fakeFile = Buffer.from(
  "%PDF-1.4\n% Synthetic QA pension fixture; provider output is mocked\n%%EOF\n",
);

function printedPayload(amount = 1_989_000) {
  const printedNote =
    amount === 1_989_000
      ? qaNote
      : "SYNTHETIC QA ONLY. Annual gross pension PKR 10,488,000 plus medical PKR 504,000 is included in an approved base of PKR 10,992,000 solely as the chosen test treatment. Annual net is PKR 10,992,000; the old bank-ledger reference is PKR 1,989,000, an intentional unreconciled QA difference of PKR 9,003,000, not a claim of verified receipts. Pension tax deducted and ledger overlap are explicitly zero QA assumptions. No legal medical classification or live record verification is claimed. Approval changes only the tax source, never cash income or profile DOB. Recalculate and create a fresh packet; above-10M final pension stays on manual portal hold.";
  return {
    documentType: "pension_statement",
    fields: pensionFields(amount, {
      "Gross Pension (Annual PKR)":
        amount === 1_989_000 ? 1_896_000 : 10_488_000,
      "Medical Allowance (Annual PKR)": amount === 1_989_000 ? 93_000 : 504_000,
      "Net Pension Payable (Annual PKR)": amount,
      [note]: printedNote,
    }).map((field) => ({
      ...field,
      confidence: 0.99,
      ...(reviewLabels.includes(field.label)
        ? {
            sourceEvidence: `${field.label}: ${typeof field.value === "number" ? field.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : field.value}`,
          }
        : {}),
    })),
    transactions: [],
    notes: ["Explicit synthetic QA assumptions; human review required."],
  };
}
function getField(payload, label) {
  return payload.fields.find((f) => f.label === label);
}
function normalize(raw, fromModel = true) {
  return harness()
    .load("lib/tax/pension-statement-fields.ts")
    .ensurePensionStatementReviewFields(raw, fromModel);
}
async function extractedHarness(payload = printedPayload()) {
  const h = harness({
    status: "PENDING",
    modelResponse: payload,
    extractionFileBuffer: fakeFile,
  });
  Object.assign(h.state.documents[0], {
    extractedData: null,
    mimeType: "application/pdf",
    fileUrl: "/uploads/synthetic-pension.pdf",
    extractionStartedAt: null,
  });
  const prior = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "offline-qa-key-never-sent-to-network";
  try {
    h.extractResult = await h.extract();
  } finally {
    if (prior === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prior;
  }
  return h;
}

test("explicitly quoted printed pension review values prefill as unapproved suggestions", () => {
  const raw = printedPayload();
  const before = JSON.stringify(raw);
  const out = normalize(raw);
  assert.equal(getField(out, approved).value, 1_989_000);
  assert.equal(getField(out, covered).value, 0);
  assert.equal(getField(out, note).value, qaNote);
  for (const label of reviewLabels)
    assert.equal(getField(out, label).reviewSuggestion, true);
  assert.equal(
    JSON.stringify(raw),
    before,
    "normalization must not mutate the provider payload",
  );
});

test("raw AI values without printed quotations still cannot guess a pension tax-base decision", () => {
  const out = normalize({ fields: pensionFields() });
  for (const label of reviewLabels) {
    assert.equal(getField(out, label).value, null);
    assert.notEqual(getField(out, label).reviewSuggestion, true);
  }
});

for (const value of [null, undefined, "", "   ", "not stated", false]) {
  test(`blank/invalid printed overlap ${JSON.stringify(value)} is not defaulted to zero`, () => {
    const raw = printedPayload();
    Object.assign(getField(raw, covered), {
      value,
      sourceEvidence: `${covered}: 0.00`,
    });
    assert.equal(getField(normalize(raw), covered).value, null);
  });
}

for (const value of [0, "0", "0.00", "PKR 0.00"]) {
  test(`literal printed zero overlap ${JSON.stringify(value)} remains an explicit suggestion`, () => {
    const raw = printedPayload();
    Object.assign(getField(raw, covered), {
      value,
      sourceEvidence: `${covered}\n0.00`,
    });
    assert.equal(getField(normalize(raw), covered).value, value);
    assert.equal(getField(normalize(raw), covered).reviewSuggestion, true);
  });
}

for (const evidence of [
  undefined,
  "",
  `${approved}: 2,000,000.00`,
  "Net Pension Payable (Annual PKR): 1,989,000.00",
  "Approved Pension Amount for Tax (Monthly PKR): 165,750.00",
  `${approved}: 1,989,000.00 inferred from gross plus medical`,
  `${approved}: -1,989,000.00`,
]) {
  test(`unquoted/wrong/derived annual-base evidence ${JSON.stringify(evidence)} is rejected`, () => {
    const raw = printedPayload();
    getField(raw, approved).sourceEvidence = evidence;
    const f = getField(normalize(raw), approved);
    assert.equal(f.value, null);
    assert.notEqual(f.reviewSuggestion, true);
  });
}

test("numeric source quotation accepts commas/currency but never derives a sum", () => {
  const raw = printedPayload();
  getField(raw, approved).sourceEvidence = `${approved}\nPKR 1,989,000.00`;
  assert.equal(getField(normalize(raw), approved).reviewSuggestion, true);
  getField(raw, approved).sourceEvidence = `${approved}: 1,896,000 + 93,000`;
  assert.equal(getField(normalize(raw), approved).value, null);
});

test("an explicitly printed zero approved annual base is still invalid, unlike zero withholding", () => {
  const raw = printedPayload();
  Object.assign(getField(raw, approved), {
    value: 0,
    sourceEvidence: `${approved}: 0.00`,
  });
  assert.equal(getField(normalize(raw), approved).value, null);
  assert.equal(getField(normalize(raw), covered).value, 0);
});

test("review-note suggestion must be copied from the printed note, not generated from amounts", () => {
  const raw = printedPayload();
  getField(raw, note).sourceEvidence = `${note}: Different medical treatment`;
  assert.equal(getField(normalize(raw), note).value, null);
  getField(raw, note).sourceEvidence =
    `${note}\n${qaNote.replaceAll(" ", "\n")}`;
  assert.equal(getField(normalize(raw), note).reviewSuggestion, true);
});

test("duplicate explicitly quoted annual-base fields still fail required review validation", async () => {
  const raw = printedPayload();
  raw.fields.push({ ...getField(raw, approved) });
  const out = normalize(raw);
  const h = harness({ status: "COMPLETED", fields: out.fields });
  assert.equal((await h.approve()).success, false);
  assert.equal(h.state.ledgerWrites.length, 0);
});

test("explicit printed gross-only decision is not changed to gross plus medical or net receipts", () => {
  const raw = printedPayload(10_992_000);
  Object.assign(getField(raw, approved), {
    value: 10_488_000,
    sourceEvidence: `${approved}: 10,488,000.00`,
  });
  const out = normalize(raw);
  assert.equal(getField(out, approved).value, 10_488_000);
  assert.equal(getField(out, "Medical Allowance (Annual PKR)").value, 504_000);
  assert.equal(
    getField(out, "Net Pension Payable (Annual PKR)").value,
    10_992_000,
  );
});

test("missing actual tax deducted remains unknown even when the three review suggestions are present", async () => {
  const raw = printedPayload();
  getField(raw, deducted).value = null;
  const h = await extractedHarness(raw);
  assert.equal(h.extractResult.success, true);
  assert.equal(getField(h.extractResult.extracted, deducted).value, null);
  // v2: the statement still maps on printed facts, but the missing deduction
  // stays explicitly unknown (null) so tax calculation must hold later —
  // it is never coerced to zero anywhere in the chain.
  const result = await h.approve();
  assert.equal(result.success, true, result.error);
  assert.equal(h.state.documents[0].extractionStatus, "MAPPED");
  const factsApi = h.load("lib/tax/pension-statement-fields.ts");
  assert.equal(
    factsApi.readPensionStatementFacts(h.state.documents[0].extractedData, 2026).taxDeducted,
    null,
  );
});

test("human-entered decision fields without source quotes survive review saves", () => {
  const raw = { fields: pensionFields(1_989_000) };
  const out = normalize(raw, false);
  assert.equal(getField(out, approved).value, 1_989_000);
  assert.equal(getField(out, note).value, getField(raw, note).value);
  assert.equal(getField(out, covered).value, 0);
});

test("human editing a suggestion preserves the edit but clears stale evidence/confidence", async () => {
  const out = normalize(printedPayload());
  getField(out, approved).value = 2_100_000;
  const saved = normalize(out, false);
  assert.equal(getField(saved, approved).value, 2_100_000);
  assert.notEqual(getField(saved, approved).reviewSuggestion, true);
  assert.equal(getField(saved, approved).confidence, 0);
  const h = harness({ pension: 1_989_000 });
  assert.equal((await h.edit(saved)).success, true);
  assert.equal(h.state.documents[0].extractionStatus, "COMPLETED");
  assert.equal(
    getField(JSON.parse(h.state.documents[0].extractedData), approved).value,
    2_100_000,
  );
});

test("actual extraction returns and persists printed suggestions, never MAPPED/approved", async () => {
  const raw = printedPayload();
  raw.extractionStatus = "MAPPED"; // Provider metadata must not change the DB contract.
  const h = await extractedHarness(raw);
  const r = h.extractResult;
  assert.equal(r.success, true, r.error);
  assert.equal(r.status, "COMPLETED");
  assert.equal(h.state.documents[0].extractionStatus, "COMPLETED");
  assert.equal(getField(r.extracted, approved).value, 1_989_000);
  assert.equal(getField(r.extracted, covered).reviewSuggestion, true);
  assert.equal(
    getField(JSON.parse(h.state.documents[0].extractedData), note).value,
    qaNote,
  );
  assert.equal(h.state.modelCalls.length, 1);
  assert.equal(
    h.state.modelCalls[0][1].inlineData.data,
    fakeFile.toString("base64"),
  );
  assert.equal(h.state.fileReads.length, 1);
  assert.equal(h.state.ledgerWrites.length, 0);
  assert.equal(
    h.state.user.dateOfBirth.toISOString().slice(0, 10),
    "1962-03-15",
  );
});

test("extraction prompt requests exact printed quotes, explicitly forbids guessed reviewer decisions", async () => {
  const h = await extractedHarness();
  const prompt = h.state.modelCalls[0][0].text;
  assert.match(prompt, /sourceEvidence/);
  assert.match(prompt, /unapproved suggestions/i);
  assert.match(prompt, /never (?:infer|calculate|invent)/i);
  assert.doesNotMatch(
    prompt,
    /Leave "Approved Pension Amount for Tax[^\n]+null: these require/,
  );
});

test("prefilled but unapproved pension still blocks completeness and tax calculation", async () => {
  const h = await extractedHarness();
  assert.equal(h.extractResult.success, true);
  const complete = await h.completeness();
  assert.equal(complete.success, false);
  assert.match(complete.blockers.join(" "), /pension/i);
  const result = await h.calculate();
  assert.equal(result.success, true, result.error);
  assert.equal(result.result.status, "NEEDS_RULES");
  assert.equal(result.result.taxDue, null);
  assert.equal(result.pensionSource, null);
  assert.equal((await h.generate()).success, false);
  assert.equal(h.state.ledgerWrites.length, 0);
});

test("only explicit review action maps a prefilled statement and enables a fresh calculation/packet", async () => {
  const h = await extractedHarness();
  const approval = await h.approve();
  assert.equal(approval.success, true, approval.error);
  assert.equal(h.state.documents[0].extractionStatus, "MAPPED");
  assert.equal(approval.annualPension, 1_989_000);
  assert.equal(h.state.ledgerWrites.length, 0);
  const result = await h.calculate();
  assert.equal(result.success, true, result.error);
  assert.equal(result.pensionSource.annualPension, 1_989_000);
  const packet = await h.generate();
  assert.equal(packet.success, true, packet.error);
  assert.equal(h.state.entries[0].amount.toNumber(), 1_989_000);
});

test("above-10M prefill produces the verified final-pension portal map after review", async () => {
  const h = await extractedHarness(printedPayload(10_992_000));
  assert.equal((await h.approve()).success, true);
  const calculated = await h.calculate();
  assert.equal(calculated.success, true, calculated.error);
  assert.equal(calculated.pensionSource.annualPension, 10_992_000);
  const packet = await h.generate();
  assert.equal(packet.success, true, packet.error);
  const snapshot = JSON.parse(h.state.packets.at(-1).snapshotJson);
  assert.equal(snapshot.coverage.mode, "complete");
  assert.equal(
    snapshot.portalFieldMap.adjustableTaxFields.find(
      (field) => field.irisCode === "64020007" && field.column === "Taxable Amount",
    ).ourAmount,
    992_000,
  );
});

test("fetching old completed blank decisions does not invent or default missing reviewer values", async () => {
  const h = harness({
    status: "COMPLETED",
    fields: pensionFields(1_989_000, {
      [approved]: null,
      [covered]: null,
      [note]: null,
    }),
  });
  const r = await h
    .load("app/actions/extraction.ts")
    .getDocumentExtractionAction("qa-pension-doc");
  assert.equal(r.success, true);
  for (const label of reviewLabels)
    assert.equal(getField(r.extraction, label).value, null);
});

function uiDocument(
  status = "COMPLETED",
  payload = normalize(printedPayload()),
) {
  const h = harness();
  const { WizardDocumentsStep } = h.load(
    "components/tax/filing/wizard-documents-step.tsx",
  );
  const noop = () => {};
  const html = renderToStaticMarkup(
    React.createElement(WizardDocumentsStep, {
      taxYear: 2026,
      documentSlots: [
        {
          documentType: "pension_statement",
          label: "Pension Statement",
          reason: "QA",
          required: true,
        },
      ],
      uploadedDocuments: { pension_statement: "qa-reviewed.pdf" },
      documentRecords: {
        pension_statement: {
          id: "qa-pension-doc",
          fileName: "qa-reviewed.pdf",
          extractionStatus: status,
          extractionProvider: "gemini",
          extractedAt: "2026-10-19T00:00:00Z",
        },
      },
      extractedByDocumentId: { "qa-pension-doc": payload },
      uploadingDocumentType: null,
      extractingDocumentId: null,
      reviewingDocumentId: null,
      savingDocumentReviewId: null,
      mappingDocumentId: null,
      documentUploadError: null,
      profileSyncNote: null,
      uploadFileInputsRef: { current: {} },
      triggerDocumentUpload: noop,
      handleDocumentFileSelected: noop,
      handleExtractDocument: noop,
      handleReviewDocument: noop,
      handleExtractedFieldChange: noop,
      handleExtractedTransactionChange: noop,
      handleSaveDocumentReview: noop,
      handleMapDocument: noop,
      handleSaveStatementIban: noop,
      handleSaveSalaryEmployers: noop,
      isSalaryEmployerDirty: () => false,
    }),
  );
  return new JSDOM(html).window.document;
}
function labelElement(doc, label) {
  return [...doc.querySelectorAll("label")].find((el) =>
    el.textContent.includes(label),
  );
}

test("actual review UI renders prefilled values as unapproved suggestions with an editable multiline note", () => {
  const doc = uiDocument();
  assert.match(doc.body.textContent, /suggestions, not approval/i);
  assert.match(doc.body.textContent, /Awaiting approval/);
  const annual = labelElement(doc, approved);
  assert.equal(annual.querySelector("input").value, "1989000");
  assert.match(annual.textContent, /PDF suggestion/i);
  assert.doesNotMatch(annual.textContent, /99% confidence/i);
  assert.equal(labelElement(doc, covered).querySelector("input").value, "0");
  const area = labelElement(doc, note).querySelector("textarea");
  assert.ok(area);
  assert.equal(area.value, qaNote);
  assert.equal(area.readOnly, false);
  const approveButton = [...doc.querySelectorAll("button")].find(
    (b) => b.textContent === "Save & Approve Map",
  );
  assert.equal(approveButton.disabled, false);
});

// v2: an unquoted basis suggestion is dropped, the input stays blank, and
// the printed facts can still be approved — the basis is a calculation-time
// readiness item, not a mapping requirement.
test("missing quote renders blank basis while facts remain approvable (v2 readiness)", () => {
  const raw = printedPayload();
  delete getField(raw, approved).sourceEvidence;
  const doc = uiDocument("COMPLETED", normalize(raw));
  assert.equal(labelElement(doc, approved).querySelector("input").value, "");
  assert.match(
    doc.body.textContent,
    /Review the Approved Pension Amount for Tax .* before calculating/,
  );
  const approveButton = [...doc.querySelectorAll("button")].find(
    (b) => b.textContent === "Save & Approve Map",
  );
  assert.equal(approveButton.disabled, false);
});

test("mapped pension UI shows the saved approval state without a redundant Save button", () => {
  const doc = uiDocument("MAPPED");
  assert.doesNotMatch(doc.body.textContent, /suggestions, not approval/i);
  assert.match(doc.body.textContent, /Pension source is approved/);
  assert.equal(
    labelElement(doc, note).querySelector("textarea").readOnly,
    false,
    "pension facts remain editable; any edit returns the document to pending approval",
  );
  assert.equal(
    [...doc.querySelectorAll("button")].some(
      (button) => button.textContent === "Save & Approve Map",
    ),
    false,
    "a successfully mapped pension should look saved, like other mapped documents",
  );
  const pending = uiDocument("COMPLETED");
  assert.ok(
    [...pending.querySelectorAll("button")].some(
      (button) => button.textContent === "Save & Approve Map",
    ),
    "pending or edited pension facts should show the approval action",
  );
});

test("editing pension review fields clears stale source-evidence badges in the real client handler", () => {
  const hook = fs.readFileSync(
    path.join(root, "components/tax/filing/hooks/use-filing-documents.ts"),
    "utf8",
  );
  assert.match(hook, /reviewSuggestion:\s*false/);
  assert.match(hook, /sourceEvidence:\s*undefined/);
  assert.match(hook, /confidence:\s*0/);
});

async function withClientHook(run, initialStatus = "COMPLETED") {
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
    { url: "https://qa.invalid" },
  );
  const names = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"];
  const prior = new Map(
    names.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  let reactRoot;
  try {
    const payload = normalize(printedPayload());
    const h = harness({
      pension: 1_989_000,
      status: initialStatus,
      fields: payload.fields,
    });
    const { useFilingDocuments } = h.load(
      "components/tax/filing/hooks/use-filing-documents.ts",
    );
    let current;
    function Host() {
      current = useFilingDocuments({
        draftId: null,
        step: 2,
        resetDownstreamSteps: () => {},
        setFilingSummary: () => {},
      });
      return null;
    }
    reactRoot = createRoot(dom.window.document.getElementById("root"));
    await act(async () => {
      reactRoot.render(React.createElement(Host));
    });
    await act(async () => {
      current.setDocumentRecords({
        pension_statement: {
          id: "qa-pension-doc",
          fileName: "qa-reviewed.pdf",
          extractionStatus: initialStatus,
          extractionProvider: "gemini",
          extractedAt: null,
        },
      });
    });
    await act(async () => {
      await current.handleReviewDocument("pension_statement");
    });
    await run({ h, act, current: () => current });
  } finally {
    if (reactRoot)
      await act(async () => {
        reactRoot.unmount();
      });
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("real React hook hydrates prefilled fields, keeps human edits and saves without approving", async () => {
  await withClientHook(async ({ h, act, current }) => {
    let payload = current().extractedByDocumentId["qa-pension-doc"];
    assert.equal(getField(payload, approved).value, 1_989_000);
    const index = payload.fields.findIndex((field) => field.label === approved);
    await act(async () => {
      current().handleExtractedFieldChange(
        "pension_statement",
        index,
        "2100000",
      );
    });
    payload = current().extractedByDocumentId["qa-pension-doc"];
    const edited = getField(payload, approved);
    assert.equal(edited.value, "2100000");
    assert.equal(edited.reviewSuggestion, false);
    assert.equal(edited.sourceEvidence, undefined);
    assert.equal(edited.confidence, 0);
    await act(async () => {
      await current().handleSaveDocumentReview("pension_statement");
    });
    assert.equal(current().documentUploadError, null);
    assert.equal(h.state.documents[0].extractionStatus, "COMPLETED");
    assert.equal(
      getField(JSON.parse(h.state.documents[0].extractedData), approved).value,
      "2100000",
    );
    assert.equal(h.state.ledgerWrites.length, 0);
    assert.equal((await h.calculate()).result.status, "NEEDS_RULES");
  });
});

test("real React Save & Approve Map explicitly approves prefilled values without adding cash or DOB", async () => {
  await withClientHook(async ({ h, act, current }) => {
    await act(async () => {
      await current().handleMapDocument("pension_statement");
    });
    assert.equal(current().documentUploadError, null);
    assert.equal(
      current().documentRecords.pension_statement.extractionStatus,
      "MAPPED",
    );
    assert.equal(h.state.documents[0].extractionStatus, "MAPPED");
    assert.equal(h.state.ledgerWrites.length, 0);
    assert.equal(
      h.state.user.dateOfBirth.toISOString().slice(0, 10),
      "1962-03-15",
    );
    assert.equal((await h.calculate()).pensionSource.annualPension, 1_989_000);
  });
});

test("editing an approved pension reopens approval, then saves and approves again", async () => {
  await withClientHook(async ({ h, act, current }) => {
    assert.equal(
      current().documentRecords.pension_statement.extractionStatus,
      "MAPPED",
    );
    const fields = current().extractedByDocumentId["qa-pension-doc"].fields;
    const approvedIndex = fields.findIndex((field) => field.label === approved);
    assert.ok(approvedIndex >= 0);

    await act(async () => {
      current().handleExtractedFieldChange(
        "pension_statement",
        approvedIndex,
        "2100000",
      );
    });
    assert.equal(
      current().documentRecords.pension_statement.extractionStatus,
      "COMPLETED",
      "editing invalidates the local approved state until re-approved",
    );
    assert.match(current().profileSyncNote, /Unsaved pension changes/);

    await act(async () => {
      await current().handleMapDocument("pension_statement");
    });
    assert.equal(current().documentUploadError, null);
    assert.equal(
      current().documentRecords.pension_statement.extractionStatus,
      "MAPPED",
    );
    assert.equal(h.state.documents[0].extractionStatus, "MAPPED");
    assert.equal(
      getField(JSON.parse(h.state.documents[0].extractedData), approved).value,
      "2100000",
    );
  }, "MAPPED");
});
