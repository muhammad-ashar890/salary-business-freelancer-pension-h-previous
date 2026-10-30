/** Deterministic bridge from reviewed evidence into business selection details. */
import { isMinimumTaxCategoryId } from './minimum-tax-113';
import { sanitizeBusinessIdentity } from './business-identity';
import { sanitizeBusinessBankAccounts, sanitizeBusinessProperties, sanitizeBusinessVehicles } from './business-balance-details';
import { sanitizeDepreciationSchedule } from './business-depreciation-schedule';
import { sanitizeBusinessTaxDeductions } from './business-tax-deductions';
import { sanitizeBusinessAddBacks } from './business-addbacks';
import { sanitizeBusinessLossesByYear } from './business-loss-rules';
import type { Ty2026SelectionUserDetails } from './rules/ty2026/subcategories';

export const BUSINESS_SUPPORT_TYPE = 'business_support';
export const BUSINESS_FACT_LABELS = {
  businessName: 'Business Name', brandName: 'Brand Name', principalActivity: 'Principal Activity',
  startDate: 'Business Start Date', endDate: 'Business End Date',
  businessSalesExcludeIndirectTax: 'Sales Exclude Sales Tax and FED',
  businessTurnover100mEarlierYear: 'Turnover 100 Million in Earlier Year',
  businessMinimumTaxCategory: 'Section 113 Category',
  businessBankAccounts: 'Business Bank Accounts JSON', businessVehicles: 'Business Vehicles JSON', businessProperties: 'Business Properties JSON',
  businessDepreciationSchedule: 'Tax Depreciation Schedule JSON', businessTaxDeductions: 'Business Tax Deductions JSON',
  businessAddBacks: 'Business Add Backs JSON', businessLossesByYear: 'Business Losses By Year JSON',
  businessUnabsorbedDepreciation: 'Unabsorbed Tax Depreciation', businessAssetSaleBookGain: 'Book Gain on Disposed Assets', businessAssetSaleBookLoss: 'Book Loss on Disposed Assets',
} as const;
export type EvidenceDocument = { id: string; documentType: string; extractionStatus: string; extractedData: string | null };
export type IntakeIssue = { key: string; text: string };
const norm = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const same = (a: unknown,b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function readReviewedBusinessFacts(documents: EvidenceDocument[], saved: Ty2026SelectionUserDetails = {}) {
  const details: Ty2026SelectionUserDetails = { ...saved, businessIdentity: saved.businessIdentity ? { ...saved.businessIdentity } : undefined };
  // Withdraw previously document-derived facts when evidence is replaced or no longer mapped.
  for (const key of saved.businessDocumentFactKeys ?? []) {
    if (key.startsWith('businessIdentity.')) { if(details.businessIdentity) delete (details.businessIdentity as unknown as Record<string,unknown>)[key.split('.')[1]]; }
    else delete (details as Record<string,unknown>)[key];
  }
  const issues: IntakeIssue[] = [];
  const provenance: Record<string, string[]> = {};
  const values = new Map<string, {value: unknown; id: string}[]>();
  for (const doc of documents) {
    if (doc.extractionStatus !== 'MAPPED') continue;
    let payload;
    try { payload = JSON.parse(doc.extractedData ?? '{}'); } catch { issues.push({key:'documents',text:'Reviewed business extraction is unreadable; re-review the document.'}); continue; }
    for (const field of Array.isArray(payload.fields) ? payload.fields : []) {
      if (field?.value === null || field?.value === undefined || String(field.value).trim() === '') continue;
      const label = norm(field.label);
      const list = values.get(label) ?? []; list.push({value:field.value,id:doc.id}); values.set(label,list);
    }
  }
  /**
   * Rows of the two business lists that are keyed by an identifier (an account by
   * its IBAN, a vehicle by its registration number) are merged field by field
   * instead of compared as one JSON string.
   *
   * Reported 27 Oct 2026: the Balance Sheet and the Business Profile both said
   * [{"iban":"PK35...","balance":15000000}] while the P&L said [{"iban":"PK35..."}]
   * — it printed the account without a balance. A missing field is not a
   * disagreement, so the string comparison raised "Conflicting Business Bank
   * Accounts JSON" on a set of documents that agreed. Two DIFFERENT balances for
   * the same account still conflict, and no value is guessed: a field only one
   * document states is taken from that document.
   */
  function mergeKeyedRows(
    rows: unknown[][],
    idField: string,
    keyOf: (row: Record<string, unknown>) => string,
  ) {
    const state = new Map<string, Record<string, unknown>>();
    const problems: string[] = [];
    for (const list of rows)
      for (const raw of list) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push('a row is not an object'); continue; }
        const row = raw as Record<string, unknown>;
        const id = keyOf(row);
        if (!id) { problems.push('a row has no identifier'); continue; }
        const target = state.get(id) ?? {};
        for (const [field, value] of Object.entries(row)) {
          if (value === null || value === undefined || String(value).trim() === '') continue;
          const canonicalValue = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
          if (!(field in target)) { target[field] = canonicalValue; continue; }
          // The identifier itself only differs in spelling ("ABC-123" vs
          // "abc 123"); those rows are the same row, so it is not compared.
          if (norm(field) === idField) continue;
          if (JSON.stringify(target[field]) !== JSON.stringify(canonicalValue))
            problems.push(`${field} for ${id}: ${JSON.stringify(target[field])} vs ${JSON.stringify(canonicalValue)}`);
        }
        state.set(id, target);
      }
    const merged = [...state.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, row]) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
    return { merged, problems };
  }

  /**
   * The identifier each keyed business list uses, or null for a free-form list.
   * The field name is matched case-insensitively, so an extraction that writes
   * "IBAN" instead of "iban" still identifies its row.
   */
  const KEYED_LISTS: Record<
    string,
    { field: string; keyOf: (row: Record<string, unknown>) => string }
  > = {
    businessBankAccounts: { field: "iban", keyOf: (row) => norm(row.iban ?? row.IBAN ?? row.Iban) },
    businessVehicles: { field: "registrationno", keyOf: (row) => norm(row.registrationNo ?? row["Registration No"] ?? row.registration) },
  };

  function take(label: string, key: string): unknown {
    const entries = values.get(norm(label)) ?? [];
    if (!entries.length) return undefined;
    // Numeric/string representation and whitespace should not create a conflict.
    const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,stable(x)])) : v;
    const canonical = (v:unknown, boolean=false): unknown => { if(typeof v !== 'string') return v; const t=v.trim().replace(/\s+/g,' '); if(boolean && /^(true|yes)$/i.test(t))return true; if(boolean && /^(false|no)$/i.test(t))return false;
      if(label.endsWith('JSON')) { try {return JSON.stringify(stable(JSON.parse(t)));} catch {return t;} }
      if(['businessUnabsorbedDepreciation','businessAssetSaleBookGain','businessAssetSaleBookLoss'].includes(key)) {const n=Number(t.replace(/,/g,''));if(Number.isFinite(n))return n;}
      return t; };
    const isBoolean = key === "businessSalesExcludeIndirectTax" || key === "businessTurnover100mEarlierYear";
    // A keyed list (bank accounts by IBAN, vehicles by registration) is merged
    // field by field: a field one document does not print is not a conflict.
    const keyed = KEYED_LISTS[key];
    if (keyed) {
      const lists: unknown[][] = [];
      const unreadable: string[] = [];
      for (const entry of entries) {
        let parsed: unknown = entry.value;
        // An unreadable list is not "an empty list": it has its own error, the
        // same as before the merge existed.
        if (typeof parsed === 'string') {
          try { parsed = JSON.parse(parsed); } catch { unreadable.push('a list is not valid JSON'); continue; }
        }
        if (!Array.isArray(parsed)) { unreadable.push('a list is not an array'); continue; }
        lists.push(parsed);
      }
      const { merged, problems } = mergeKeyedRows(lists, keyed.field, keyed.keyOf);
      problems.unshift(...unreadable);
      if (problems.length) {
        issues.push({key,text:`Conflicting ${label} in reviewed documents (${problems.join('; ')}). Correct the source reviews; no value was guessed.`}); return undefined;
      }
      provenance[key] = [...new Set(entries.map(e=>e.id))];
      return JSON.stringify(merged);
    }
    const first = canonical(entries[0].value, isBoolean);
    if (entries.some(e => !same(canonical(e.value, isBoolean),first))) {
      issues.push({key:key.startsWith('businessIdentity.')?'businessIdentity':key,text:`Conflicting ${label} in reviewed documents. Correct the source reviews; no value was guessed.`}); return undefined;
    }
    provenance[key] = [...new Set(entries.map(e=>e.id))]; return first;
  }
  const identity: Record<string,unknown> = { ...details.businessIdentity };
  let identityPresent = false;
  for (const key of ['businessName','brandName','principalActivity','startDate','endDate'] as const) {
    const v = take(BUSINESS_FACT_LABELS[key],`businessIdentity.${key}`);
    if (v !== undefined) { identityPresent = true; identity[key] = v; }
  }
  if (identityPresent) {
    // IRIS requires a brand name and the app's own rule is "if the business has
    // no separate brand, write the business name" (validateBusinessIdentity).
    // A printed brand always wins; this only fills the empty case so the
    // reviewer is not asked for a value the documents cannot contain.
    if (!String(identity.brandName ?? '').trim() && String(identity.businessName ?? '').trim())
      identity.brandName = String(identity.businessName).trim();
    const result = sanitizeBusinessIdentity(identity);
    if (result.ok && result.identity) details.businessIdentity = result.identity;
    else if (result.ok === false) issues.push({key:'businessIdentity',text:result.error});
  }
  for (const key of ['businessSalesExcludeIndirectTax','businessTurnover100mEarlierYear'] as const) {
    const v = take(BUSINESS_FACT_LABELS[key],key);
    if (v === undefined) continue;
    if (typeof v === 'boolean') details[key] = v;
    else if (typeof v === 'string' && /^(yes|no|true|false)$/i.test(v)) details[key] = /^(yes|true)$/i.test(v);
    else issues.push({key,text:`${BUSINESS_FACT_LABELS[key]} must be an explicit Yes/No fact.`});
  }
  const sanitizers = {
    businessBankAccounts:sanitizeBusinessBankAccounts, businessVehicles:sanitizeBusinessVehicles, businessProperties:sanitizeBusinessProperties,
    businessDepreciationSchedule:sanitizeDepreciationSchedule, businessTaxDeductions:sanitizeBusinessTaxDeductions,
    businessAddBacks:sanitizeBusinessAddBacks, businessLossesByYear:sanitizeBusinessLossesByYear,
  };
  for (const key of Object.keys(sanitizers) as (keyof typeof sanitizers)[]) {
    let v = take(BUSINESS_FACT_LABELS[key],key); if (v === undefined) continue;
    try { if (typeof v === 'string') v = JSON.parse(v); } catch { issues.push({key,text:`${BUSINESS_FACT_LABELS[key]} must contain a valid reviewed JSON list.`}); continue; }
    if (!Array.isArray(v)) { issues.push({key,text:`${BUSINESS_FACT_LABELS[key]} must be a list.`}); continue; }
    const result = sanitizers[key](v);
    if (!result.ok) issues.push({key,text:'error' in result ? result.error : `Invalid ${key}`});
    else (details as Record<string,unknown>)[key] = result.rows;
  }
  for (const key of ['businessUnabsorbedDepreciation','businessAssetSaleBookGain','businessAssetSaleBookLoss'] as const) {
    const v = take(BUSINESS_FACT_LABELS[key],key); if (v === undefined) continue;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g,''));
    if (!Number.isFinite(n) || n < 0 || typeof v === 'boolean') issues.push({key,text:`Invalid ${BUSINESS_FACT_LABELS[key]}.`}); else details[key] = n;
  }
  const category=take(BUSINESS_FACT_LABELS.businessMinimumTaxCategory,'businessMinimumTaxCategory');
  if (category !== undefined) {
    if (isMinimumTaxCategoryId(category)) details.businessMinimumTaxCategory = category;
    else issues.push({key:'businessTurnover100mEarlierYear',text:'Unrecognized Section 113 category; choose a supported category.'});
  }
  details.businessDocumentFactKeys = Object.keys(provenance);
  return {details,issues,provenance};
}

/** Prevent a stale tab/old estimate from packaging facts that no longer match current reviewed evidence. */
export function reviewedBusinessEvidenceProblems(documents: EvidenceDocument[], saved: Ty2026SelectionUserDetails) {
  const current=readReviewedBusinessFacts(documents,saved);
  const issues=[...current.issues];
  const read=(details:Ty2026SelectionUserDetails,key:string):unknown=>key.startsWith('businessIdentity.') ? (details.businessIdentity as unknown as Record<string,unknown> | undefined)?.[key.split('.')[1]] : (details as Record<string,unknown>)[key];
  const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value && typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,stable(v)])):value;
  for(const key of new Set([...(saved.businessDocumentFactKeys ?? []),...(current.details.businessDocumentFactKeys ?? [])])) {
    if(JSON.stringify(stable(read(saved,key)))!==JSON.stringify(stable(read(current.details,key)))) issues.push({key,text:'Reviewed business evidence has changed. Continue from Upload documents to synchronize the missing/conflicting facts, then recalculate before creating a packet.'});
  }
  return issues;
}
