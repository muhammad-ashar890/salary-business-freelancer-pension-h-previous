#!/usr/bin/env node
"use strict";
// Offline React/DOM checks: real Review component, pure document derivation,
// mocked save endpoint. No server, browser network or IRIS session is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const React = require("react");
const { act } = React;
const root = path.join(__dirname, "..");
let lastSave = null;
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
Module._resolveFilename = function (request, ...rest) {
  return originalResolve.call(this, request.startsWith("@/") ? path.join(root, request.slice(2)) : request, ...rest);
};
for (const ext of [".ts", ".tsx"]) require.extensions[ext] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText, filename);
Module._load = function (request, parent, isMain) {
  if (request === "@/app/actions/services-income-evidence") return {
    saveServicesIncomeEvidenceAction: async (input) => {
      lastSave = input;
      return { success: true, invoiceCount: input.invoices.length, payoutMatchCount: input.paymentMatches.length, incomeTotal: 51250 };
    },
  };
  return originalLoad.call(this, request, parent, isMain);
};
const { WizardServicesIncomeEvidencePanel } = require("../components/tax/filing/wizard-services-income-evidence-panel.tsx");
const { readServicesWithholdingSourceRows } = require("../lib/tax/services-withholding-evidence.ts");

const invoice = (extra = {}) => ({
  id: "invoice-3", invoiceNumber: "INV-2026-003", invoiceDate: "2025-09-05", dueDate: null,
  clientName: "SYNTHETIC CLIENT", serviceDescription: "Custom software development and IT services",
  sourceDocumentFileName: "qa-invoices.pdf", sourceDocumentExtractionStatus: "MAPPED",
  quantity: 1, unitRate: 51250, invoiceAmount: 51250, currency: "PKR", exchangeRateToPkr: null, fxEvidenceReference: null,
  subcategory: "1b-service-it-ites", serviceCategoryHumanConfirmed: true, serviceCategoryEvidenceReference: "qa-invoices.pdf page 1",
  incomeCharacter: "TECHNICAL_PROFESSIONAL_FEE", incomeCharacterHumanConfirmed: true, incomeCharacterEvidenceReference: "qa-invoices.pdf page 1",
  paymentStatus: "FULL_TY", evidenceStatus: "DRAFT", paymentMatches: [],
  derivedPayout: {
    paymentStatus: "FULL_TY", settlementDate: "2025-09-09", settlementCurrency: "PKR", settlementAmount: 48750,
    settlementExchangeRateToPkr: 1, grossServiceAmountPkr: 51250, withholdingTaxPkr: 2050,
    withholdingSection: "153(1)(b)", withholdingIrisCode: "64060158", withholdingEvidenceReference: "Client certificate INV-2026-003",
    platformFeePkr: 450, bankFeePkr: 0, netPayoutPkr: 48750, payoutReference: "PAYOUT-3", evidenceReference: "qa-invoices.pdf page 1",
    incomeCharacter: "TECHNICAL_PROFESSIONAL_FEE",
  }, ...extra,
});
const savedPayout = () => ({
  id: "saved-match-3", invoiceEvidenceId: "invoice-3", ledgerEntryId: "credit-3", settlementDate: "2025-09-09",
  settlementCurrency: "PKR", settlementAmount: 48750, settlementExchangeRateToPkr: 1, invoiceCurrencyAmount: 51250,
  exchangeRateToPkr: 1, grossServiceAmountPkr: 51250, netBankAmountPkr: 48750, withholdingTaxPkr: 2050,
  withholdingSection: "153(1)(b)", withholdingIrisCode: "64060158", withholdingEvidenceReference: "Client certificate INV-2026-003",
  withholdingEvidenceHumanConfirmed: false, withholdingEvidenceDocumentId: null, evidenceDocumentId: null,
  platformFeePkr: 450, bankFeePkr: 0, payoutReference: "PAYOUT-3", evidenceReference: "qa-invoices.pdf page 1", recordStatus: "ACTIVE",
});
const bank = { id: "net-bank-statement", fileName: "qa-bank.pdf", documentType: "bank_statement", extractionStatus: "MAPPED", withholdingRows: [] };
const certificate = {
  id: "actual-payer-proof", fileName: "payer-tax-proof.pdf", documentType: "other_income_proof", extractionStatus: "MAPPED",
  withholdingRows: readServicesWithholdingSourceRows({ fields: [
    ["Invoice Number 1", "INV-2026-003"], ["Payout Reference 1", "PAYOUT-3"], ["Withholding Tax (PKR) 1", 2050],
    ["Withholding Section 1", "153(1)(b)"], ["Withholding IRIS Code 1", "64060158"], ["Withholding Evidence Reference 1", "page 1 line 3"],
  ].map(([label, value]) => ({ label, value })) }),
};
const props = (extra = {}) => ({
  draftId: "draft-qa", accountingMethod: "CASH", categories: [{ subcategory: "1b-service-it-ites", label: "IT services" }],
  invoices: [invoice()], receipts: [{ id: "credit-3", date: "2025-09-09", description: "PAYOUT-3 SYNTHETIC CLIENT", amount: 48750, sourceDocumentId: bank.id }],
  evidenceDocuments: [bank], onSaved: async () => undefined, ...extra,
});

async function mount(initialProps) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://qa.invalid" });
  const old = {};
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    old[key] = Object.getOwnPropertyDescriptor(global, key);
    Object.defineProperty(global, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = require("react-dom/client");
  const host = dom.window.document.getElementById("root");
  const view = createRoot(host);
  const render = async (p) => { await act(async () => view.render(React.createElement(WizardServicesIncomeEvidencePanel, p))); };
  await render(initialProps);
  return {
    host, render,
    control: (text) => [...host.querySelectorAll("label")].find((el) => el.textContent.includes(text))?.querySelector("input,select"),
    async save() {
      const button = [...host.querySelectorAll("button")].find((el) => el.textContent === "Confirm Services evidence");
      assert.ok(button, "review confirmation button exists");
      assert.equal(button.disabled, false, host.textContent);
      await act(async () => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    },
    async destroy() {
      await act(async () => view.unmount());
      dom.window.close();
      for (const [key, descriptor] of Object.entries(old)) {
        if (descriptor) Object.defineProperty(global, key, descriptor); else delete global[key];
      }
    },
  };
}

test("Review: invoice-only payout fills amounts but does not falsely confirm the net bank statement as a tax certificate", async () => {
  const h = await mount(props());
  try {
    assert.equal(h.control("Withholding tax (PKR").value, "2050");
    assert.equal(h.control("Mapped withholding certificate").value, "");
    assert.match(h.host.textContent, /Withholding source needed/);
    await h.save();
    assert.equal(lastSave.paymentMatches[0].withholdingTaxPkr, 2050);
    assert.equal(lastSave.paymentMatches[0].withholdingEvidenceDocumentId, null);
    assert.equal(lastSave.paymentMatches[0].withholdingEvidenceHumanConfirmed, false);
    assert.equal(lastSave.paymentMatches[0].netBankAmountPkr, 48750);
  } finally { await h.destroy(); }
});

test("Review: a mapped certificate auto-links section, exact code and reference in one confirmation", async () => {
  const h = await mount(props({ evidenceDocuments: [bank, certificate] }));
  try {
    assert.equal(h.control("Mapped withholding certificate").value, certificate.id);
    assert.equal(h.control("Statutory section shown").value, "153(1)(b)");
    assert.equal(h.control("IRIS code shown").value, "64060158");
    assert.doesNotMatch(h.host.textContent, /Withholding source needed/);
    await h.save();
    const match = lastSave.paymentMatches[0];
    assert.equal(match.withholdingEvidenceDocumentId, certificate.id);
    assert.equal(match.withholdingEvidenceHumanConfirmed, true);
    assert.match(match.withholdingEvidenceReference, /payer-tax-proof.pdf.*page 1 line 3/);
    assert.equal(match.grossServiceAmountPkr, 51250);
    assert.equal(match.netBankAmountPkr, 48750);
    assert.equal(match.platformFeePkr, 450);
  } finally { await h.destroy(); }
});

test("Review: same-content summary refresh plus a newly mapped certificate keeps all prefilled payouts", async () => {
  const p = props();
  const h = await mount(p);
  try {
    const refreshed = { ...p, invoices: JSON.parse(JSON.stringify(p.invoices)), evidenceDocuments: [bank, certificate] };
    await h.render(refreshed);
    assert.equal(h.control("Withholding tax (PKR").value, "2050");
    assert.equal(h.control("Mapped withholding certificate").value, certificate.id);
    await h.save();
    assert.equal(lastSave.paymentMatches.length, 1);
    assert.equal(lastSave.paymentMatches[0].netBankAmountPkr, 48750);
  } finally { await h.destroy(); }
});

test("Review: saved confirmed income can link a later withholding certificate without retyping/re-deriving income", async () => {
  const confirmedInvoice = invoice({ evidenceStatus: "CONFIRMED", paymentMatches: [savedPayout()] });
  const p = props({ invoices: [confirmedInvoice] });
  const h = await mount(p);
  try {
    assert.equal(h.control("Mapped withholding certificate").value, "");
    await h.render({ ...p, evidenceDocuments: [bank, certificate] });
    assert.equal(h.control("Mapped withholding certificate").value, certificate.id);
    await h.save();
    assert.equal(lastSave.paymentMatches[0].withholdingTaxPkr, 2050);
    assert.equal(lastSave.paymentMatches[0].withholdingEvidenceDocumentId, certificate.id);
    assert.equal(lastSave.invoices[0].subcategory, "1b-service-it-ites");
  } finally { await h.destroy(); }
});

test("Review: an unchanged summary refresh alone keeps unsaved document-prefilled income and the explicit missing-source warning", async () => {
  const p = props();
  const h = await mount(p);
  try {
    await h.render(JSON.parse(JSON.stringify({ ...p, onSaved: undefined })));
    assert.equal(h.control("Withholding tax (PKR").value, "2050");
    assert.match(h.host.textContent, /Withholding source needed/);
    await h.save();
    assert.equal(lastSave.paymentMatches.length, 1);
    assert.equal(lastSave.paymentMatches[0].netBankAmountPkr, 48750);
    assert.equal(lastSave.paymentMatches[0].withholdingEvidenceHumanConfirmed, false);
  } finally { await h.destroy(); }
});

test("Review: an already approved manual source choice is not replaced by a newly mapped alternative certificate", async () => {
  const approved = { ...savedPayout(), withholdingEvidenceDocumentId: bank.id, withholdingEvidenceHumanConfirmed: true,
    withholdingEvidenceReference: "Previously reviewed source page 7" };
  const confirmed = invoice({ evidenceStatus: "CONFIRMED", paymentMatches: [approved] });
  const printedBankProof = { ...bank, withholdingRows: certificate.withholdingRows };
  const p = props({ invoices: [confirmed], evidenceDocuments: [printedBankProof] });
  const h = await mount(p);
  try {
    await h.render({ ...p, invoices: JSON.parse(JSON.stringify(p.invoices)), evidenceDocuments: [printedBankProof, certificate] });
    assert.equal(h.control("Mapped withholding certificate").value, bank.id);
    assert.equal(h.control("Withholding certificate page / line reference").value, "Previously reviewed source page 7");
    await h.save();
    assert.equal(lastSave.paymentMatches[0].withholdingEvidenceDocumentId, bank.id);
    assert.equal(lastSave.paymentMatches[0].withholdingEvidenceHumanConfirmed, true);
  } finally { await h.destroy(); }
});

test("Review: a mixed saved/new invoice batch auto-fills only new data and preserves approved sources and fees on refill", async () => {
  const approved = { ...savedPayout(), withholdingEvidenceDocumentId: bank.id, withholdingEvidenceHumanConfirmed: true,
    withholdingEvidenceReference: "Previously reviewed source page 7" };
  const first = invoice({ evidenceStatus: "CONFIRMED", paymentMatches: [approved] });
  const second = invoice({ id: "invoice-4", invoiceNumber: "INV-2026-004", invoiceAmount: 20000, unitRate: 20000,
    paymentStatus: null, serviceCategoryHumanConfirmed: false, incomeCharacterHumanConfirmed: false,
    derivedPayout: { ...invoice().derivedPayout, grossServiceAmountPkr: 20000, withholdingTaxPkr: 800,
      platformFeePkr: 0, bankFeePkr: 0, settlementAmount: 19200, netPayoutPkr: 19200, payoutReference: "PAYOUT-4" } });
  const proof4 = { ...certificate, id: "proof-4", fileName: "payer-proof-4.pdf",
    withholdingRows: certificate.withholdingRows.map((row) => ({ ...row, invoiceNumber: "INV-2026-004", payoutReference: "PAYOUT-4", amountPkr: 800 })) };
  const p = props({ invoices: [first, second], evidenceDocuments: [{ ...bank, withholdingRows: certificate.withholdingRows }, certificate, proof4] });
  p.receipts.push({ id: "credit-4", date: "2025-09-09", description: "PAYOUT-4 SYNTHETIC CLIENT", amount: 19200, sourceDocumentId: bank.id });
  const h = await mount(p);
  try {
    const sources = () => [...h.host.querySelectorAll("label")].filter((el) => el.textContent.includes("Mapped withholding certificate")).map((el) => el.querySelector("select").value);
    assert.deepEqual(sources(), [bank.id, proof4.id]);
    await h.save();
    assert.equal(lastSave.paymentMatches.length, 2);
    assert.equal(lastSave.paymentMatches.find((m) => m.invoiceEvidenceId === first.id).platformFeePkr, 450);
    assert.equal(lastSave.paymentMatches.find((m) => m.invoiceEvidenceId === first.id).withholdingEvidenceReference, approved.withholdingEvidenceReference);
    assert.equal(lastSave.paymentMatches.find((m) => m.invoiceEvidenceId === second.id).withholdingEvidenceDocumentId, proof4.id);
    assert.equal(lastSave.invoices.find((row) => row.id === second.id).paymentStatus, "FULL_TY");
    const fill = [...h.host.querySelectorAll("button")].find((el) => el.textContent === "Fill from documents");
    assert.equal(fill.disabled, false);
    await act(async () => { fill.click(); });
    assert.deepEqual(sources(), [bank.id, proof4.id]);
    await h.save();
    assert.equal(lastSave.paymentMatches.length, 2, "refill must not duplicate saved/new payouts");
    assert.equal(lastSave.paymentMatches.find((m) => m.invoiceEvidenceId === first.id).platformFeePkr, 450);
    assert.equal(lastSave.paymentMatches.find((m) => m.invoiceEvidenceId === first.id).withholdingEvidenceDocumentId, bank.id);
  } finally { await h.destroy(); }
});
