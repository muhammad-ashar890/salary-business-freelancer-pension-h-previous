import { createHash } from 'crypto';
import { prisma } from '@/lib/prisma';
import { checkBankOwnership, parseBankOwnershipDecisions } from './business-bank-ownership';
import { parsePersistedSelectionUserDetails, TY2026_BUSINESS_PROFIT_SUBCATEGORY } from './rules/ty2026/subcategories';

const message = 'Business bank ownership or reviewed evidence changed. Review each account, recalculate, and generate a fresh packet before continuing.';
export type BusinessOwnershipStamp = { version: 1; fingerprint: string };

/** Bound to current owned data, not client input. Includes financial evidence
 * relevant to the 3320/7030 decision, so a pinned packet cannot outlive it. */
export async function currentBusinessOwnershipStamp(draftId: string, userId: string): Promise<{ stamp: BusinessOwnershipStamp | null; error: string | null }> {
  const draft = await prisma.filingDraft.findFirst({where:{id:draftId,userId},select:{taxYear:true,filerType:true,incomeSources:true}});
  if (!draft) return {stamp:null,error:message};
  let sources: unknown;
  try { sources=JSON.parse(draft.incomeSources); } catch { return {stamp:null,error:message}; }
  if (!Array.isArray(sources)) return {stamp:null,error:message};
  if (draft.taxYear !== 2026 || draft.filerType !== 'myself' || !sources.includes('business')) return {stamp:null,error:null};
  const where={filingDraftId:draftId,userId};
  const [accounts,selection,documents,statements,entries]=await Promise.all([
    prisma.bankAccount.findMany({where,orderBy:{id:'asc'},select:{id:true,iban:true,bankName:true,accountLabel:true,currency:true}}),
    prisma.filingIncomeSelection.findFirst({where:{...where,source:'business',subcategory:TY2026_BUSINESS_PROFIT_SUBCATEGORY,status:'SELECTED'},select:{detailsJson:true}}),
    prisma.document.findMany({where:{...where,documentType:{in:['business_books','business_balance_sheet','business_support','bank_statement']}},orderBy:{id:'asc'},select:{id:true,documentType:true,bankAccountId:true,extractionStatus:true,extractedData:true}}),
    prisma.bankStatement.findMany({where,orderBy:{id:'asc'},select:{id:true,bankAccountId:true,openingBalance:true,closingBalance:true,periodStart:true,periodEnd:true,sourceDocumentId:true}}),
    prisma.ledgerEntry.findMany({where,orderBy:{id:'asc'},select:{id:true,entryType:true,category:true,bankAccountId:true,amount:true,source:true,sourceTransactionId:true}}),
  ]);
  if (!selection) return {stamp:null,error:message};
  let raw: any;
  try { raw = JSON.parse(selection.detailsJson); } catch { return {stamp:null,error:message}; }
  const userDetails = raw?.userDetails ?? raw;
  if (userDetails?.businessBankOwnershipDecisions !== undefined && !parseBankOwnershipDecisions(userDetails.businessBankOwnershipDecisions).ok) return {stamp:null,error:message};
  const details = parsePersistedSelectionUserDetails(selection.detailsJson);
  const review = checkBankOwnership({accounts,decisions:details?.businessBankOwnershipDecisions ?? []});
  if (!review.ready) return {stamp:null,error:message};
  const fingerprint=createHash('sha256').update(JSON.stringify({accounts,details,documents,statements,entries})).digest('hex');
  return {stamp:{version:1,fingerprint},error:null};
}

/** Gate both newly queued and previously queued jobs; old packets fail closed. */
export async function businessOwnershipPacketValidationError(snapshot: any, draftId:string,userId:string): Promise<string|null> {
  const current=await currentBusinessOwnershipStamp(draftId,userId);
  if (current.error) return current.error;
  const snapshotBusiness=snapshot?.filing?.taxYear===2026 && snapshot?.filing?.filerType==='myself' && Array.isArray(snapshot?.filing?.incomeSources) && snapshot.filing.incomeSources.includes('business');
  if (!current.stamp && !snapshotBusiness) return null;
  const saved=snapshot?.businessBankOwnershipStamp;
  if (!current.stamp || !saved || saved.version!==1 || saved.fingerprint!==current.stamp.fingerprint) return message;
  return null;
}
