"use server";
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { mergeReviewedBusinessSchedules } from "@/lib/tax/business-reviewed-schedules";
import { checkBankOwnership } from '@/lib/tax/business-bank-ownership';
import { readReviewedBusinessFacts } from '@/lib/tax/business-document-intake';
import { resolveTy2026IncomeSelections, parsePersistedSelectionUserDetails, TY2026_BUSINESS_PROFIT_SUBCATEGORY } from '@/lib/tax/rules/ty2026/subcategories';
import { readBusinessBooksAnnual } from '@/lib/tax/business-schedule-fields';
import { withBusinessBooksValues } from '@/lib/tax/business-books-figures';
import { buildBusinessPacket, readBusinessBalanceSheet } from '@/lib/tax/business-filing';
import { businessAccountingProfit, businessOpeningWealthCheck } from '@/lib/tax/business-opening-wealth';
import { approvedPreviousReturnFromDocuments } from '@/lib/tax/previous-return-fields';
import { validateBusinessIdentity } from '@/lib/tax/business-identity';
import { businessProfitStepProblems } from '@/lib/tax/business-profit-step-check';
import { section113Applicability, isMinimumTaxCategoryId } from '@/lib/tax/minimum-tax-113';

async function owned(draftId: string) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) throw new Error('Unauthorized');
  const user = await prisma.user.findUnique({where:{email:session.user.email},select:{id:true}});
  if (!user) throw new Error('Unauthorized');
  const draft = await prisma.filingDraft.findFirst({where:{id:draftId,userId:user.id}});
  if (!draft || draft.filerType !== 'myself' || draft.taxYear !== 2026 || !JSON.parse(draft.incomeSources).includes('business')) throw new Error('Supported business filing not found');
  return draft;
}
/** Read-only: merge only approved evidence. The normal wizard save persists returned details. */
export async function getBusinessDocumentIntakeAction(draftId: string, candidate?: unknown) {
  try {
    const draft=await owned(draftId);
    const [documents,selection,statements,previousReturnDocuments,bankAccounts]=await Promise.all([
      prisma.document.findMany({where:{filingDraftId:draft.id,userId:draft.userId,documentType:{in:['business_books','business_balance_sheet','business_support','bank_statement']}},select:{id:true,documentType:true,extractionStatus:true,extractedData:true}}),
      prisma.filingIncomeSelection.findFirst({where:{filingDraftId:draft.id,userId:draft.userId,source:'business',subcategory:TY2026_BUSINESS_PROFIT_SUBCATEGORY,status:'SELECTED'},select:{detailsJson:true}}),
      prisma.bankStatement.findMany({where:{filingDraftId:draft.id,userId:draft.userId,bankAccountId:{not:null}},orderBy:{createdAt:'desc'},select:{closingBalance:true,bankAccount:{select:{iban:true}}}}),
      // Kept in its own query: the previous return must never be read as part of
      // the business evidence (its labels overlap: Tax Year, Total Assets ...).
      prisma.document.findMany({where:{filingDraftId:draft.id,userId:draft.userId,documentType:'previous_return'},orderBy:{createdAt:'desc'},select:{documentType:true,extractionStatus:true,extractedData:true}}),
      prisma.bankAccount.findMany({where:{filingDraftId:draft.id,userId:draft.userId},select:{id:true,iban:true}}),
    ]);
    let saved=parsePersistedSelectionUserDetails(selection?.detailsJson ?? '{}') ?? {};
    if(candidate !== undefined) {
      const checked=resolveTy2026IncomeSelections({incomeSources:['business'],selections:[{source:'business',subcategory:TY2026_BUSINESS_PROFIT_SUBCATEGORY,details:candidate as never}],requireComplete:false});
      if(!checked.success) return {success:false as const,error:'Invalid business review details.'};
      saved=checked.selections[0]?.details ?? {};
    }
    const intake=readReviewedBusinessFacts(documents,saved);
    const books=documents.filter(d=>d.documentType==='business_books' && d.extractionStatus==='MAPPED');
    const sheet=documents.filter(d=>d.documentType==='business_balance_sheet' && d.extractionStatus==='MAPPED');
    const schedules=mergeReviewedBusinessSchedules(books,documents);
    let details=intake.details;
    const issues=[...intake.issues,...schedules.issues];
    const ownership = checkBankOwnership({accounts:bankAccounts, decisions:details.businessBankOwnershipDecisions ?? [],
      reviewedBusinessIbans: Array.isArray(details.businessBankAccounts) ? details.businessBankAccounts.map(row=>row.iban) : undefined});
    if (!Array.isArray(details.businessBankAccounts) && ownership.decisions.some(row => row.ownership === 'business')) {
      issues.push({key:'businessBankOwnership',text:'A business account needs a reviewed Business bank account list before its 3320 placement can be confirmed.'});
    }
    for (const issue of ownership.issues) {
      const descriptions: Record<string,string> = {
        missing_confirmation:'Choose Personal, Business or Mixed for each bank account.',
        mixed_requires_review:'A mixed account needs manual ownership and IRIS placement review; automatic filing is held.',
        iban_changed:'A bank account IBAN changed; confirm its ownership again.',
        unknown_account:'A saved ownership answer refers to an account no longer in this filing; remove the stale answer.',
        business_evidence_unregistered:'A reviewed business bank account is not in this filing’s Bank Accounts. Add it there and confirm its ownership before continuing.',
        business_evidence_conflict:'Bank ownership conflicts with the reviewed business bank list. Correct the documents or your selection.',
        duplicate_decision:'A bank account has duplicate ownership answers; remove the duplicates.',
        duplicate_account:'A duplicate bank account was found; review the bank accounts.',
        duplicate_iban:'Multiple accounts have the same IBAN; review the bank accounts.',
        invalid_account:'A bank account needs a valid IBAN before ownership can be confirmed.',
        invalid_decision:'Bank ownership answers are invalid; review them again.',
      };
      issues.push({key:'businessBankOwnership',text:descriptions[issue.code] ?? 'Review bank ownership before continuing.'});
    }

    if (books.length !== 1) issues.push({key:'documents',text:'Provide one reviewed Business Books record (upload or manual declaration).'});
    else { try { details=withBusinessBooksValues(details,readBusinessBooksAnnual(books[0].extractedData)); } catch(e) {issues.push({key:'documents',text:e instanceof Error?e.message:'Review Business Books.'});} }
    if (sheet.length !== 1) issues.push({key:'documents',text:'Provide one reviewed business balance record (upload or manual declaration).'});
    const waiting=documents.filter(d=>d.documentType==='business_support' && d.extractionStatus!=='MAPPED');
    if(waiting.length) issues.push({key:'documents',text:'Review and approve the uploaded supporting document, or remove/replace it before continuing.'});
    for(const p of businessProfitStepProblems(details)) issues.push({key:p.id==='section113_unanswered'?'businessTurnover100mEarlierYear':'businessDepreciation',text:p.text});
    // 28-Oct-2026: the Wealth Statement gap (703000) was only discovered inside
    // IRIS, after an agent run. The documents' own capital movement is compared
    // with the filed previous return here, where they can still be corrected.
    if (sheet.length === 1) {
      try {
        const reviewed = readBusinessBalanceSheet(sheet[0].extractedData, draft.taxYear);
        const previous = approvedPreviousReturnFromDocuments(previousReturnDocuments, draft.taxYear);
        const openingCheck = businessOpeningWealthCheck({
          closingBusinessCapital: reviewed.amounts.capital ?? null,
          accountingProfit: businessAccountingProfit(details),
          previousReturnNetAssets: previous?.netAssets ?? null,
          previousReturnTaxYear: previous?.taxYear ?? null,
          taxYear: draft.taxYear,
        });
        if (openingCheck.status === 'impossible') issues.push({key:'businessOpeningWealth',text:openingCheck.message});
      } catch { /* A Balance Sheet that does not parse already raises its own issue. */ }
    }
    if(details.businessSalesExcludeIndirectTax!==true) issues.push({key:'businessSalesExcludeIndirectTax',text:'Confirm the annual sales basis excludes Sales Tax/FED using evidence or an explicit declaration.'});
    if(!details.businessIdentity) issues.push({key:'businessIdentity',text:'Business identity, principal activity, brand and start date are missing. Upload a profile/registration record or enter the missing facts.'});
    else for(const text of validateBusinessIdentity(details.businessIdentity)) issues.push({key:'businessIdentity',text});
    if(details.businessMinimumTaxCategory && !isMinimumTaxCategoryId(details.businessMinimumTaxCategory)) issues.push({key:'businessTurnover100mEarlierYear',text:'Confirm a supported Section 113 category.'});
    if(section113Applicability({turnover:details.businessGrossSales ?? 0,turnover100mEarlierYear:details.businessTurnover100mEarlierYear}).applies && !details.businessMinimumTaxCategory) issues.push({key:'businessTurnover100mEarlierYear',text:'Select the supported Section 113 category explicitly; the activity choice does not determine legal eligibility.'});
    const finalChecks: {key:string;text:string}[] = [];
    const unique=new Map<string,{iban:string;closingBalance:number}>();
    for(const row of statements) if(row.bankAccount?.iban && !unique.has(row.bankAccount.iban)) unique.set(row.bankAccount.iban,{iban:row.bankAccount.iban,closingBalance:Number(row.closingBalance)});
    let business=null;
    if(books.length===1 && sheet.length===1) {
      try {
        business=buildBusinessPacket({taxYear:draft.taxYear,filerType:draft.filerType,incomeSources:JSON.parse(draft.incomeSources),selections:[{source:'business',subcategory:TY2026_BUSINESS_PROFIT_SUBCATEGORY,detailsJson:JSON.stringify({userDetails:details})}],books:schedules.books,balanceSheet:sheet[0],bankStatementBalances:[...unique.values()]});
        for(const item of business?.pending ?? []) {
          if(['businessFinalReview','businessUnabsorbedDepreciationCarriedForward','businessUnabsorbedDepreciation'].includes(item.key) || (item.key==='businessScheduleReview' && !/still needs explicit direct-expense heads/i.test(item.reason))) {
            finalChecks.push({key:item.key,text:item.reason});
            continue; // Keep legal/IRIS human verification pending in packet; do not ask duplicate application inputs.
          }
          issues.push({key:item.key,text:item.reason});
        }
      } catch(e) { issues.push({key:'documents',text:e instanceof Error?e.message:'Business schedule validation failed.'}); }
    }
    const dedup=[...new Map(issues.map(i=>[i.key+':'+i.text,i])).values()];
    return {success:true as const,details,issues:dedup,provenance:{...intake.provenance,...schedules.provenance},finalChecks,ready:dedup.length===0,queuedFields:business?.fields.length ?? 0};
  } catch { return {success:false as const,error:'Could not load the owned business evidence. Refresh and sign in again if needed.'}; }
}
