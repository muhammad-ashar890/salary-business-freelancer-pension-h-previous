-- Add human-confirmed Services classification and tax-certificate identifiers
-- required for evidence-gated IRIS mapping. Existing records default to manual.
ALTER TABLE "ServicesInvoiceEvidence"
  ADD COLUMN "serviceCategoryHumanConfirmed" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "serviceCategoryEvidenceReference" TEXT,
  ADD COLUMN "incomeCharacter" TEXT,
  ADD COLUMN "incomeCharacterHumanConfirmed" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "incomeCharacterEvidenceReference" TEXT;

ALTER TABLE "ServicesInvoicePaymentMatch"
  ADD COLUMN "withholdingSection" TEXT,
  ADD COLUMN "withholdingIrisCode" TEXT,
  ADD COLUMN "withholdingEvidenceReference" TEXT,
  ADD COLUMN "withholdingEvidenceHumanConfirmed" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "withholdingEvidenceDocumentId" TEXT;

ALTER TABLE "ServicesInvoicePaymentMatch"
  ADD CONSTRAINT "ServicesInvoicePaymentMatch_withholdingEvidenceDocumentId_fkey"
  FOREIGN KEY ("withholdingEvidenceDocumentId") REFERENCES "Document"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
