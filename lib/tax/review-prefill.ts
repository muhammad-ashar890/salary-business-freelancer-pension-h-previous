/**
 * The review payload the reviewer actually sees, with the figures a document
 * PROVES nil proposed as 0.
 *
 * Three prefills exist, each with its own proof and its own rules:
 *  - withDerivedPreviousReturnFields: a previous return's blank 7029 whose
 *    printed assets equal its printed net assets;
 *  - withDerivedNilBusinessBooksFigures: the seven Business Books yearly
 *    figures after Sales (Sales itself is never invented);
 *  - withDerivedNilBalanceSheetRows: a blank Balance Sheet row on a side whose
 *    printed rows already add up to that side's printed total.
 *
 * This module is the one place that decides which of them may run, and the
 * decision is made on the SLOT the reviewer uploaded into, never on
 * payload.documentType: that field is only what the model said the file was,
 * and a model that mislabels a P&L can otherwise silently skip a document's
 * zeros (seen 27 Oct 2026 — the Balance Sheet's three nil rows stayed red).
 *
 * Every helper is a proposal at confidence 0.9 that the reviewer can overwrite,
 * never overwrites a stated value, and does nothing at all when the document
 * does not prove the zero.
 */
import { withDerivedPreviousReturnFields } from "./previous-return-fields";
import { withDerivedNilBusinessBooksFigures } from "./business-books-annual-labels";
import { withDerivedNilBalanceSheetRows } from "./document-review-required";

export function withDerivedNilReviewFields<
  T extends {
    label?: unknown;
    value?: unknown;
    confidence?: unknown;
    derived?: unknown;
  },
>(documentType: string | undefined, fields: T[] | undefined): T[] {
  const previousReturn = withDerivedPreviousReturnFields(fields);
  if (documentType === "business_books")
    return withDerivedNilBusinessBooksFigures(previousReturn);
  if (documentType === "business_balance_sheet")
    return withDerivedNilBalanceSheetRows(previousReturn);
  return previousReturn;
}

type PayloadLike = {
  documentType?: string;
  fields?: Array<{
    label?: unknown;
    value?: unknown;
    confidence?: unknown;
    derived?: unknown;
  }>;
};

/**
 * Same as withDerivedNilReviewFields, but on a whole review payload, so the
 * display path and the SAVE path can call one function.
 *
 * This matters: on 27 Oct 2026 the prefilled zeros reached the screen but not
 * the server. Save & Approve Map sent the stored payload (see
 * use-filing-documents.ts), the server re-checked it with
 * getDocumentReviewRequiredErrors, and the same three "is required" bullets came
 * back as the step's red banner. A prefill that the reviewer sees but the save
 * path does not send is not an approval, it is a screen.
 */
export function withDerivedNilReviewPayload<P extends PayloadLike | undefined>(
  documentType: string | undefined,
  payload: P,
): P {
  if (!payload || !Array.isArray(payload.fields)) return payload;
  return {
    ...payload,
    fields: withDerivedNilReviewFields(documentType, payload.fields),
  } as P;
}
