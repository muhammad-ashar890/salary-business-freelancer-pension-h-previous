-- Store invoice-level freelancer income evidence separately from bank credits.
-- The accounting method and all financial evidence remain nullable/draft until
-- explicitly reviewed; calculation and packet guards enforce completeness.
ALTER TABLE "FilingDraft" ADD COLUMN "servicesAccountingMethod" TEXT;

CREATE TABLE "ServicesInvoiceEvidence" (
    "id" TEXT NOT NULL,
    "filingDraftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "invoiceKey" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "invoiceDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "clientName" TEXT,
    "serviceDescription" TEXT,
    "quantity" DECIMAL(18,4),
    "unitRate" DECIMAL(18,4),
    "invoiceAmount" DECIMAL(18,2),
    "currency" TEXT,
    "exchangeRateToPkr" DECIMAL(18,8),
    "fxEvidenceReference" TEXT,
    "subcategory" TEXT,
    "paymentStatus" TEXT,
    "evidenceStatus" TEXT NOT NULL DEFAULT 'DRAFT',
    "detailsJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ServicesInvoiceEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ServicesInvoicePaymentMatch" (
    "id" TEXT NOT NULL,
    "filingDraftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "invoiceEvidenceId" TEXT NOT NULL,
    "ledgerEntryId" TEXT NOT NULL,
    "evidenceDocumentId" TEXT,
    "settlementDate" TIMESTAMP(3),
    "settlementCurrency" TEXT,
    "settlementAmount" DECIMAL(18,2),
    "settlementExchangeRateToPkr" DECIMAL(18,8),
    "invoiceCurrencyAmount" DECIMAL(18,2),
    "exchangeRateToPkr" DECIMAL(18,8),
    "grossServiceAmountPkr" DECIMAL(18,2),
    "netBankAmountPkr" DECIMAL(18,2),
    "withholdingTaxPkr" DECIMAL(18,2),
    "platformFeePkr" DECIMAL(18,2),
    "bankFeePkr" DECIMAL(18,2),
    "payoutReference" TEXT,
    "evidenceReference" TEXT,
    "recordStatus" TEXT NOT NULL DEFAULT 'DRAFT',
    "detailsJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ServicesInvoicePaymentMatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ServicesInvoiceEvidence_filingDraftId_sourceDocumentId_invoiceKey_key"
ON "ServicesInvoiceEvidence"("filingDraftId", "sourceDocumentId", "invoiceKey");
CREATE INDEX "ServicesInvoiceEvidence_filingDraftId_evidenceStatus_idx"
ON "ServicesInvoiceEvidence"("filingDraftId", "evidenceStatus");
CREATE INDEX "ServicesInvoiceEvidence_userId_idx" ON "ServicesInvoiceEvidence"("userId");
CREATE INDEX "ServicesInvoiceEvidence_sourceDocumentId_idx" ON "ServicesInvoiceEvidence"("sourceDocumentId");
CREATE INDEX "ServicesInvoiceEvidence_subcategory_idx" ON "ServicesInvoiceEvidence"("subcategory");

CREATE UNIQUE INDEX "ServicesInvoicePaymentMatch_invoiceEvidenceId_ledgerEntryId_key"
ON "ServicesInvoicePaymentMatch"("invoiceEvidenceId", "ledgerEntryId");
CREATE INDEX "ServicesInvoicePaymentMatch_filingDraftId_ledgerEntryId_idx"
ON "ServicesInvoicePaymentMatch"("filingDraftId", "ledgerEntryId");
CREATE INDEX "ServicesInvoicePaymentMatch_userId_idx" ON "ServicesInvoicePaymentMatch"("userId");
CREATE INDEX "ServicesInvoicePaymentMatch_invoiceEvidenceId_recordStatus_idx"
ON "ServicesInvoicePaymentMatch"("invoiceEvidenceId", "recordStatus");

ALTER TABLE "ServicesInvoiceEvidence"
ADD CONSTRAINT "ServicesInvoiceEvidence_filingDraftId_fkey"
FOREIGN KEY ("filingDraftId") REFERENCES "FilingDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServicesInvoiceEvidence"
ADD CONSTRAINT "ServicesInvoiceEvidence_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServicesInvoiceEvidence"
ADD CONSTRAINT "ServicesInvoiceEvidence_sourceDocumentId_fkey"
FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ServicesInvoicePaymentMatch"
ADD CONSTRAINT "ServicesInvoicePaymentMatch_filingDraftId_fkey"
FOREIGN KEY ("filingDraftId") REFERENCES "FilingDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServicesInvoicePaymentMatch"
ADD CONSTRAINT "ServicesInvoicePaymentMatch_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServicesInvoicePaymentMatch"
ADD CONSTRAINT "ServicesInvoicePaymentMatch_invoiceEvidenceId_fkey"
FOREIGN KEY ("invoiceEvidenceId") REFERENCES "ServicesInvoiceEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServicesInvoicePaymentMatch"
ADD CONSTRAINT "ServicesInvoicePaymentMatch_ledgerEntryId_fkey"
FOREIGN KEY ("ledgerEntryId") REFERENCES "LedgerEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServicesInvoicePaymentMatch"
ADD CONSTRAINT "ServicesInvoicePaymentMatch_evidenceDocumentId_fkey"
FOREIGN KEY ("evidenceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
