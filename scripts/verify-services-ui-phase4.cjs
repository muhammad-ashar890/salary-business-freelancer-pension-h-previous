const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

const config = read(
  "components",
  "tax",
  "filing",
  "config",
  "filing-wizard-config.ts",
);
const wizard = read("components", "tax", "filing", "filing-wizard.tsx");
const documents = read(
  "components",
  "tax",
  "filing",
  "wizard-documents-step.tsx",
);
const bank = read(
  "components",
  "tax",
  "filing",
  "wizard-bank-intelligence-step.tsx",
);
const review = read("components", "tax", "filing", "wizard-review-step.tsx");
const extraction = read("app", "actions", "extraction.ts");

test("shared filing summary carries the Services evidence read model", () => {
  for (const name of [
    "ServicesIncomeLedgerReceipt",
    "SelectedServicesSubcategory",
    "ServicesInvoicePaymentMatchSummary",
    "ServicesInvoiceEvidenceSummary",
    "ServicesEvidenceDocumentSummary",
    "ExcludedPositiveCredit",
  ]) {
    assert.match(config, new RegExp(`export type ${name} =`));
  }
  assert.match(config, /documentsAwaitingMapping\?:/);
  assert.match(config, /servicesInvoices\?: ServicesInvoiceEvidenceSummary\[\]/);
  assert.match(config, /excludedPositiveCredits\?: ExcludedPositiveCredit\[\]/);
  assert.match(config, /business_review: "Business data review"/);
});

test("Documents make only the Services evidence slots newly mappable and keep final Mapped state", () => {
  assert.match(documents, /slot\.documentType === "invoice_summary"/);
  assert.match(documents, /slot\.documentType === "other_income_proof"/);
  assert.match(documents, /slot\.documentType === "advance_tax_evidence"/);
  assert.match(documents, /slot\.documentType === "business_support"/);
  assert.match(documents, /<ManualBusinessRecord/);
  assert.match(documents, /<Button type="button" size="sm" variant="outline" disabled>[\s\S]*?Mapped/);
  assert.match(extraction, /mapping:\s*document\.documentType === "advance_tax_evidence"[\s\S]*?"OTHER_INCOME_PROOF"/);
});

test("Bank Intelligence exposes Services only for the exact single-Freelancer route", () => {
  assert.match(bank, /freelancerEnabled\?: boolean/);
  assert.match(bank, /\.\.\.\(freelancerEnabled \? \["SERVICES"\] : \[\]\)/);
  assert.doesNotMatch(bank, /"DIVIDEND",\s*"SERVICES",/);
  assert.match(bank, /formatBankCategory\(row\.suggestedCategory, freelancerEnabled\)/);
  assert.match(bank, /Potential freelancer income · Services/);
  assert.match(bank, /hasOwnerCapitalMovementDescription\(row\.description\)/);
});

test("Bank exclusions require and display an audited reason", () => {
  assert.match(bank, /exclusionReason\?: string \| null/);
  assert.match(bank, /manualExclusionReason\.trim\(\)/);
  assert.match(bank, /exclusionReason\.length < 3/);
  assert.match(bank, /window\.prompt\(/);
  assert.match(bank, /Excluded · reason missing/);
  assert.match(bank, /reviewBankTransactionClassificationAction\([\s\S]*?exclusionReason,/);
  assert.match(bank, /manuallyClassifyBankTransactionAction\([\s\S]*?exclusionReason,/);
});

test("Review renders the evidence panel and excluded credits, and blocks incomplete Services calculation", () => {
  assert.match(review, /WizardServicesIncomeEvidencePanel/);
  assert.match(review, /onSaved=\{onServicesEvidenceSaved\}/);
  assert.match(review, /Excluded positive bank credits — review before calculating/);
  assert.match(review, /const servicesEvidenceComplete = \(\(\) =>/);
  assert.match(review, /!servicesEvidenceComplete/);
  assert.match(review, /documentsAwaitingMapping/);
  assert.match(review, /Save &amp; Approve Map/);
  assert.match(review, /super_tax: "Super tax \(section 4C\)"/);
  assert.match(review, /minimum_tax: "Minimum tax \(section 113\)"/);
});

test("Filing Wizard uses the exact gate, requires invoice mapping and refreshes after evidence save", () => {
  assert.match(wizard, /isSingleFreelancerServicesFiling\(\{\s*taxYear,\s*filerType,\s*incomeSources,\s*\}\)/);
  assert.doesNotMatch(wizard, /isFreelancerIncomeSelected/);
  assert.match(wizard, /"business_balance_sheet",\s*"invoice_summary",/);
  assert.match(wizard, /async function handleServicesEvidenceSaved\(\)/);
  assert.match(wizard, /taxCalculationInvalidatedRef\.current = true/);
  assert.match(wizard, /setFilingPacket\(null\)/);
  assert.match(wizard, /getFilingSummaryWithDiagnostics\(\s*draftId,\s*"wizard\.services_evidence_saved"/);
  assert.match(wizard, /onServicesEvidenceSaved=\{handleServicesEvidenceSaved\}/);
  assert.match(wizard, /awaiting mapping/);
  assert.match(wizard, /Freelancer \/ Services evidence is single-source only for now/);
  assert.match(wizard, /selectedIncomeSources\.length > 1/);
  assert.match(wizard, /WizardBusinessActivityStep/);
});

test("the evidence panel is wired, while the unused allocation panel is not invented", () => {
  const panelPath = path.join(
    root,
    "components",
    "tax",
    "filing",
    "wizard-services-income-evidence-panel.tsx",
  );
  assert.equal(fs.existsSync(panelPath), true);
  const panel = fs.readFileSync(panelPath, "utf8");
  assert.match(panel, /saveServicesIncomeEvidenceAction/);
  assert.match(panel, /deriveServicesEvidence/);
  assert.match(panel, /if \(categories\.length === 0\) return null/);

  const allocationPath = path.join(
    root,
    "components",
    "tax",
    "filing",
    "wizard-services-allocation-panel.tsx",
  );
  assert.equal(fs.existsSync(allocationPath), false);
  assert.doesNotMatch(wizard + review + documents + bank, /WizardServicesAllocationPanel/);
});

test("Services UI copy uses normal controls and does not ask the user for JSON", () => {
  const panel = read(
    "components",
    "tax",
    "filing",
    "wizard-services-income-evidence-panel.tsx",
  );
  assert.doesNotMatch(panel + review + documents, /enter (?:the )?JSON|paste (?:the )?JSON/i);
  assert.match(panel, /<select/);
  assert.match(panel, /<input/);
  assert.match(panel, /Save/);
});
