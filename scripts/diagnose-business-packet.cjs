// Read-only diagnostic. Never prints values, identifiers, filenames or document text.
const path = require('path'), fs = require('fs'), Module = require('module'), ts = require('typescript');
const root = path.resolve(__dirname, '..');
require('@next/env').loadEnvConfig(root);
const resolve = Module._resolveFilename;
Module._resolveFilename = function(r, ...rest) { return resolve.call(this, r.startsWith('@/') ? path.join(root, r.slice(2)) : r, ...rest); };
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText, f);
const { PrismaClient } = require('@prisma/client');
const {readReviewedBusinessFacts, reviewedBusinessEvidenceProblems} = require('../lib/tax/business-document-intake.ts');
const {parsePersistedSelectionUserDetails} = require('../lib/tax/rules/ty2026/subcategories.ts');
const prisma = new PrismaClient();
function read(details, key) { return key.startsWith('businessIdentity.') ? details.businessIdentity?.[key.split('.')[1]] : details[key]; }
function shape(v) { if (v === undefined || v === null) return 'missing'; if (Array.isArray(v)) return v.length === 0 ? 'empty list' : 'non-empty list'; if (typeof v === 'boolean') return 'boolean'; if (typeof v === 'number') return 'number'; if (typeof v === 'string') return 'text'; return 'object'; }
(async()=>{
 const selections = await prisma.filingIncomeSelection.findMany({where:{source:'business',subcategory:'profit-return',status:'SELECTED',filingDraft:{taxYear:2026}},orderBy:{updatedAt:'desc'},take:8,select:{filingDraftId:true,userId:true,detailsJson:true,updatedAt:true,filingDraft:{select:{status:true}}}});
 if (!selections.length) { console.log('No TY2026 active business selection found in this database.'); return; }
 for (const [i,sel] of selections.entries()) {
  const documents=await prisma.document.findMany({where:{filingDraftId:sel.filingDraftId,userId:sel.userId,documentType:{in:['business_books','business_balance_sheet','business_support','bank_statement']}},select:{id:true,documentType:true,extractionStatus:true,extractedData:true}});
  const saved=parsePersistedSelectionUserDetails(sel.detailsJson) ?? {};
  const current=readReviewedBusinessFacts(documents,saved);
  const issues=reviewedBusinessEvidenceProblems(documents,saved);
  console.log(`\nDRAFT ${i+1} (most recently updated first) | selection updated: ${sel.updatedAt.toISOString()} | status: ${sel.filingDraft.status}`);
  console.log(`Evidence docs: ${documents.length}; mapped: ${documents.filter(d=>d.extractionStatus==='MAPPED').length}; packet guard issues: ${issues.length}`);
  for(const issue of issues) {
    const kind=issue.text.startsWith('Reviewed business evidence has changed.')?'freshness mismatch':'source conflict or invalid fact';
    console.log(`- ${issue.key}: ${kind}; saved=${shape(read(saved,issue.key))}; reviewed=${shape(read(current.details,issue.key))}`);
  }
  if(!issues.length) console.log('- No business-evidence freshness issues in this draft now.');
 }
 console.log('\nNo values, taxpayer identifiers, file names or document text printed.');
})().catch(()=>{console.error('Could not read the database. Check the app database configuration and run this from the project folder.');process.exitCode=1;}).finally(()=>prisma.$disconnect());
