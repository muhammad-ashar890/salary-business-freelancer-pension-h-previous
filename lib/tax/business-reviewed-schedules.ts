/** Combine approved head-wise schedules without changing either original document. */
import { BUSINESS_SCHEDULE_LABELS, parseBusinessPurchaseBasis } from './business-schedule-fields';
import { BUSINESS_BOOKS_ANNUAL_LABELS } from './business-books-annual-labels';
import type { EvidenceDocument, IntakeIssue } from './business-document-intake';
const norm=(value:unknown)=>String(value??'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');
export function mergeReviewedBusinessSchedules(books: EvidenceDocument[], evidence: EvidenceDocument[]) {
  const issues:IntakeIssue[]=[],provenance:Record<string,string[]>={};
  if(books.length!==1)return {books,issues,provenance};
  const primary=books[0];
  let payload: {fields?:{label:string;value:unknown}[];[key:string]:unknown};
  try {payload=JSON.parse(primary.extractedData??'{}');}catch{return{books,issues:[{key:'documents',text:'Business Books are unreadable.'}],provenance};}
  const combined=[...(payload.fields??[])];
  const optional=Object.entries(BUSINESS_SCHEDULE_LABELS).map(([key,label])=>({key:`schedule.${key}`,label}));
  const annual=Object.entries(BUSINESS_BOOKS_ANNUAL_LABELS).map(([key,label])=>({key,label}));
  for(const {key,label} of [...annual,...optional]) {
    const occurrences:{id:string;value:unknown}[]=[];
    for(const source of evidence.filter(d=>d.extractionStatus==='MAPPED')) {
      try {const p=JSON.parse(source.extractedData??'{}');for(const field of Array.isArray(p.fields)?p.fields:[])if(norm(field.label)===norm(label) && field.value!==null && field.value!==undefined && String(field.value).trim()!=='')occurrences.push({id:source.id,value:field.value});}catch{issues.push({key:'documents',text:'A reviewed schedule is unreadable.'});}
    }
    if(!occurrences.length)continue;
    const canonical=(value:unknown)=>{if(label===BUSINESS_SCHEDULE_LABELS.purchaseBasis)return parseBusinessPurchaseBasis(value) ?? value;if(typeof value==='number')return value;const n=Number(String(value).trim().replace(/,/g,''));return Number.isFinite(n)?n:value;};
    const value=canonical(occurrences[0].value);
    if(occurrences.some(row=>JSON.stringify(canonical(row.value))!==JSON.stringify(value))){issues.push({key:'documents',text:`Conflicting ${label} in approved business evidence. Correct the source reviews before continuing.`});continue;}
    provenance[key]=[...new Set(occurrences.map(row=>row.id))];
    // Financial totals remain authoritative in Books; supporting records only add optional heads.
    if(key.startsWith('schedule.') && !combined.some(field=>norm(field.label)===norm(label) && field.value!==null && field.value!==undefined && String(field.value).trim()!=='')) {
      const blank=combined.findIndex(field=>norm(field.label)===norm(label));
      if(blank>=0)combined[blank]={...combined[blank],value};else combined.push({label,value});
    }
  }
  const sourceDocumentIds=[...new Set([primary.id,...Object.values(provenance).flat()])];
  return {books:[{...primary,extractedData:JSON.stringify({...payload,fields:combined,reviewedScheduleSourceDocumentIds:sourceDocumentIds})}],issues,provenance};
}
