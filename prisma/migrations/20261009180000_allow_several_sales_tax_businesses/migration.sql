-- A user can now look after several businesses. Each business has its own
-- registration number and its own monthly returns.

-- A filing needs a business. The app never creates a filing without a
-- profile, so this only guards a hand-edited database.
INSERT INTO "SalesTaxProfile" ("id", "userId", "businessName", "registrationNo", "authorities", "createdAt", "updatedAt")
SELECT md5(random()::text || clock_timestamp()::text || f."userId"), f."userId", 'My business', '0000000', '["FBR"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "userId" FROM "SalesTaxFiling") f
WHERE NOT EXISTS (SELECT 1 FROM "SalesTaxProfile" p WHERE p."userId" = f."userId");

-- DropIndex
DROP INDEX "SalesTaxProfile_userId_key";

-- DropIndex
DROP INDEX "SalesTaxFiling_userId_authority_periodYear_periodMonth_key";

-- AlterTable
ALTER TABLE "SalesTaxFiling" ADD COLUMN "businessId" TEXT;

-- Existing returns belong to the one business each user had.
UPDATE "SalesTaxFiling" f
SET "businessId" = p."id"
FROM "SalesTaxProfile" p
WHERE p."userId" = f."userId";

-- AlterTable
ALTER TABLE "SalesTaxFiling" ALTER COLUMN "businessId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "SalesTaxProfile_userId_idx" ON "SalesTaxProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesTaxProfile_userId_registrationNo_key" ON "SalesTaxProfile"("userId", "registrationNo");

-- CreateIndex
CREATE INDEX "SalesTaxFiling_businessId_idx" ON "SalesTaxFiling"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesTaxFiling_businessId_authority_periodYear_periodMonth_key" ON "SalesTaxFiling"("businessId", "authority", "periodYear", "periodMonth");

-- AddForeignKey
ALTER TABLE "SalesTaxFiling" ADD CONSTRAINT "SalesTaxFiling_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "SalesTaxProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
