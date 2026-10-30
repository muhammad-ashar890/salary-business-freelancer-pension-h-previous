/** Source-only annual recovery and structured recognition; never derives totals or supplies absent zero. */
import { BUSINESS_BOOKS_ANNUAL_LABELS } from './business-books-annual-labels';
import { BUSINESS_SCHEDULE_LABELS } from './business-schedule-fields';
const norm=(v:unknown)=>String(v??'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');
type Field={label:string;value:unknown;[key:string]:unknown};
type Payload={fields?:Field[];[key:string]:unknown};
const provided=(v:unknown)=>v!==null && v!==undefined && String(v).trim()!=='';
function money(v:unknown):number|null {
  if(typeof v==='boolean' || !provided(v))return null;
  const text=String(v).trim();
  if(!/^\d[\d,]*(?:\.\d+)?$/.test(text))return null;
  const n=Number(text.replace(/,/g,''));return Number.isFinite(n)&&n>=0?n:null;
}
export function missingBusinessAnnualLabels(raw:unknown):string[] {
  const p=raw as Payload | null;
  const fields=Array.isArray(p?.fields)?p.fields:[];
  return Object.values(BUSINESS_BOOKS_ANNUAL_LABELS).filter(label=>!fields.some(f=>norm(f.label)===norm(label)&&provided(f.value)));
}
/** The source may label actual expense heads Rent/Salaries/Utilities, without using the word expense. */
export function hasStructuredBusinessBooksEvidence(raw:unknown):boolean {
  if(!raw || typeof raw!=='object')return false;
  const p=raw as Payload;
  const type=norm(p.documentType);
  if(!['businessbooks','salesrecords','businessrecord'].some(alias=>type.includes(alias)))return false;
  const fields=Array.isArray(p.fields)?p.fields:[];
  const get=(label:string)=>fields.find(f=>norm(f.label)===norm(label)&&provided(f.value))?.value;
  const year=Number(get('Tax Year'));
  if(!Number.isInteger(year)||year<2000||year>2100 || !String(get('Business Name')??'').trim())return false;
  if(get('Reporting Period Start')!==`${year-1}-07-01` || get('Reporting Period End')!==`${year}-06-30`)return false;
  if((money(get(BUSINESS_BOOKS_ANNUAL_LABELS.businessGrossSales))??0)<=0)return false;
  const nonAnnualHeads=Object.entries(BUSINESS_SCHEDULE_LABELS).filter(([key])=>!['purchaseBasis','lossYear','ordinaryLoss','unallocatedDirect'].includes(key));
  return nonAnnualHeads.filter(([,label])=>money(get(label))!==null).length>=3;
}
export function recoverMissingBusinessAnnualFields(input:unknown,recovery:unknown):unknown {
  if(!input || typeof input!=="object" || Array.isArray(input))return input;
  const raw=input as Payload;
  const records=(recovery as {annualFacts?:unknown})?.annualFacts;
  if(!Array.isArray(records))return raw;
  const missing=new Set(missingBusinessAnnualLabels(raw));
  const fields=(raw.fields??[]).map(f=>({...f}));
  const accepted:{label:string;value:number;evidence:string}[]=[];
  for(const label of missing) {
    const matches=records.filter(r=>r&&typeof r==='object'&&r.label===label);
    if(matches.length!==1)continue; // ambiguous duplicate model answers are not chosen silently.
    const r=matches[0];
    if(r.explicitlyStated!==true || typeof r.evidence!=='string' || r.evidence.length<3 || r.evidence.length>2500)continue;
    const value=money(r.value);if(value===null)continue;
    if(!norm(r.evidence).includes(norm(label)))continue;
    // Require the exact stated amount in a source quotation; never calculate an expense total from heads.
    const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const rowPattern=new RegExp('\\b'+label.split(/\s+/).map(escape).join('\\s+')+'\\s*(?:[:|=\\-]\\s*)?(?:(?:PKR|Rs\\.?)\\s*)?(\\d[\\d,]*(?:\\.\\d+)?)\\b','i');
    const row=r.evidence.match(rowPattern);
    if(!row || money(row[1])!==value)continue;
    const existing=fields.findIndex(f=>norm(f.label)===norm(label));
    const field={label,value,confidence:0.9};
    if(existing>=0)fields[existing]={...fields[existing],...field};else fields.push(field);
    accepted.push({label,value,evidence:r.evidence});
  }
  if(!accepted.length)return raw;
  return {...raw,fields,businessAnnualSourceEvidence:accepted};
}
export function businessAnnualRecoveryPrompt(labels:string[]):string {
  return `Re-read the SAME original Business Books PDF attached to this request. Extract ONLY these missing explicitly printed annual rows: ${labels.join('; ')}. Return JSON only: {"annualFacts":[{"label":"one exact requested label","value":123,"explicitlyStated":true,"evidence":"verbatim source quotation containing the row label and printed numeric amount"}]}. Use each exact requested label once. Read the annual profit-input table, including explicit numeric zero rows; do not stop after extracting the detailed expense schedule. Return null value and explicitlyStated false if the annual amount is absent or ambiguous. Do NOT sum rent/salaries/etc to invent an aggregate, subtract figures, infer zero, copy sales into receipts, or infer tax/legal eligibility. Never change any previously extracted value. Leave unsupported facts unknown for ordinary required-field review. This is source extraction, not tax calculation.`;
}
