/**
 * Server side of lib/tax/business-books-figures.ts: the mapped Business
 * Books of a filing, read with the same rules as the packet
 * (app/actions/packet.ts takes the MAPPED business_books documents and
 * lib/tax/business-schedule-fields.ts reads them).
 */
import { readBusinessBooksAnnual } from "./business-schedule-fields";
import type { BusinessBooksValues } from "./business-books-figures";

type BooksDocument = { extractedData: string | null; extractionStatus: string };
type DocumentReader = {
  document: {
    findMany(args: {
      where: {
        filingDraftId: string;
        userId: string;
        documentType: "business_books";
        extractionStatus: "MAPPED";
      };
      select: { extractedData: true; extractionStatus: true };
    }): Promise<BooksDocument[]>;
  };
};

/**
 * The Books' 8 figures and business name when the filing has exactly one
 * mapped Business Books; otherwise null (no Books yet, a Books waiting for its
 * review, or Books the packet would refuse anyway).
 */
export async function loadMappedBusinessBooksValues(
  db: DocumentReader,
  filingDraftId: string,
  userId: string,
): Promise<BusinessBooksValues | null> {
  const documents = await db.document.findMany({
    where: {
      filingDraftId,
      userId,
      documentType: "business_books",
      extractionStatus: "MAPPED",
    },
    select: { extractedData: true, extractionStatus: true },
  });
  if (documents.length !== 1) return null;
  try {
    return readBusinessBooksAnnual(documents[0].extractedData);
  } catch {
    return null;
  }
}
