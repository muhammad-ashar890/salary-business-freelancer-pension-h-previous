const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');const guard=require('../electron-connect/iris-bank-cross-section-guard');
const iban='PK36SCBL0000001123456702',other='PK35HABB0018067900476803';const fixture=name=>fs.readFileSync(path.join(__dirname,'../test-fixtures/bank-cross-section',name),'utf8');
let browser;before(async()=>{browser=await chromium.launch({headless:true,args:['--no-sandbox']})});after(async()=>{if(browser)await browser.close()});
async function run({personal=fixture('personal.html'),business=fixture('business.html'),personalIbans=[],businessIbans=[],navigateOk=true,mutate=null,angularStable=null}={}){
 const page=await browser.newPage();let count=0;const win={webContents:{executeJavaScript:script=>page.evaluate(script)}};
 try{return await guard.checkBankCrossSection({windowInstance:win,personalIbans,businessIbans,sleep:async()=>{},beforeStep:async()=>{},navigate:async section=>{count++;if(!navigateOk)return {ok:false};await page.setContent(section==='wealth_assets'?personal:business);if(angularStable!==null)await page.evaluate(stable=>{window.getAllAngularTestabilities=()=>[{isStable:()=>stable}]},angularStable);return {ok:true}},...(mutate?{sleep:()=>mutate(page)}:{})})}finally{await page.close()}
}
const removeChild=(html,code)=>html.replace(new RegExp(`<div(?=[^>]*\\bid=["']${code}["'])[^>]*>(?:(?!<div class="row).)*PK36SCBL0000001123456702[\\s\\S]*`, 'i'),'');
test('actual sanitized IRIS captures: same IBAN in 7030 and 3320 blocks either direction',async()=>{for(const options of [{personalIbans:[iban]},{businessIbans:[iban]}]){const r=await run(options);assert.equal(r.ok,false,JSON.stringify(r));assert.match(r.reason,/opposite IRIS section/i)}});
test('unrelated account is permitted only after both stable, recognizable sections are read',async()=>{const r=await run({personalIbans:[other]});assert.equal(r.ok,true,JSON.stringify(r));});
test('missing or unready sections, unexpected dialogs and wrong IBAN hold closed',async()=>{for(const opts of [{personal:''},{business:''},{navigateOk:false},{personalIbans:['not-an-iban']},{business:'<mat-dialog-container role="dialog"><h6>Open</h6></mat-dialog-container>'+fixture('business.html')}]){const r=await run({personalIbans:[other],...opts});assert.equal(r.ok,false,JSON.stringify(r));}});
test('conflicting packet destinations and unreadable rows are held',async()=>{for(const opts of [{personalIbans:[iban],businessIbans:[iban]},{personalIbans:[iban,iban]},{personalIbans:[other],business:fixture('business.html').replace(iban,'MISSING-IBAN')}]){const r=await run(opts);assert.equal(r.ok,false,JSON.stringify(r));}});
test('no planned bank writes requires no navigation',async()=>{const r=await guard.checkBankCrossSection({windowInstance:null,navigate:()=>{throw Error('unexpected')},personalIbans:[],businessIbans:[]});assert.equal(r.ok,true)});
test('business-entry-v9 requires the updated guarded desktop and guard ships in agent package',()=>{const main=fs.readFileSync(path.join(__dirname,'../electron-connect/main.js'),'utf8'),p=JSON.parse(fs.readFileSync(path.join(__dirname,'../electron-connect/package.json')));assert.ok(main.includes('checkBankCrossSection'));assert.ok(main.includes('business-entry-v9'));assert.ok(p.build.files.includes('iris-bank-cross-section-guard.js'));});
test('actual desktop autofill entry point holds BEFORE any write for both cross-section conflicts',async()=>{
 const ts=require('typescript'),vm=require('node:vm');const source=fs.readFileSync(path.join(__dirname,'../electron-connect/main.js'),'utf8');const ast=ts.createSourceFile('main.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='runRealIrisAutofill');assert.ok(fn);
 for(const ownership of ['personal','business']){
  const page=await browser.newPage();let writes=0;const win={webContents:{executeJavaScript:async script=>script==='PROBE'?{returnWorkspace:true,inputs:3}:page.evaluate(script)}};
  try{const ctx=vm.createContext({console,Promise,Date,setTimeout,clearTimeout,Error,activeJobExecutionLog:null,lastSectionTour:null,launchState:{accountReference:'0000000000000'},pensionEntryHold:()=>null,getServicesPacketRoute:()=>({active:false,selected:false,incomeSources:['business']}),getServicesAutofillFields:()=>{throw Error('unexpected Services')},ensureWorkerWindow:async()=>win,pushStatus:()=>{},getWealthAutofillEnabled:()=>true,irisBankCrossSectionGuard:guard,ensureNavigationJobActive:async()=>{},irisNavigation:{RETURN_WORKSPACE_PROBE:'PROBE',planSectionFills:()=>[],navigateToSection:async(_win,{sectionId})=>{await page.setContent(fixture(sectionId==='wealth_assets'?'personal.html':'business.html'));return {ok:true}}},irisRowFiller:{fillIrisRows:async()=>{writes++;throw Error('write forbidden')}}});
  vm.runInContext(fn.getText(ast),ctx);const fields=[{irisCode:'3101',sourceGroup:'businessFields',value:'100'}];if(ownership==='personal')fields.push({irisCode:'7030',sourceGroup:'wealthFields',value:'100',rowDescriptionIncludes:iban});
  const result=await ctx.runRealIrisAutofill({filingPacket:{taxYear:2026,snapshot:{filing:{taxYear:2026,filerType:'myself',incomeSources:['business']},businessBankOwnershipStamp:{version:1,fingerprint:'fixture'},business:{version:'business-entry-v9',balanceDetails:{agentFields:ownership==='business'?[{kind:'bank',irisCode:'3320',iban}]:[]}},portalFieldMap:fields}}},{id:'job'},'live');
  assert.equal(result.paused,true);assert.match(result.pauseMessage,/opposite IRIS section/i);assert.equal(writes,0);assert.equal(result.result.summary.filled,0);
  }finally{await page.close()}
 }
});

// A fresh TY2026 return has NO 7030 row at all, and the business Balance Sheet
// may be briefly empty right after a section switch. Both are legitimate, but
// only when the tab is demonstrably settled. The 2026-11-03 live captures showed
// the old single getAllAngularTestabilities() probe holding a normal return.
test('empty bank sections pass only with positive settle evidence',async()=>{
 const emptyPersonal=fixture('personal.html').replace(/id="7030"/g,'id="not7030"');
 const anchor=(id,label)=>`<div class="row v-padding-5 tableRows dataRow" id="${id}"><span class="row-description-text">${label}</span><input disabled></div>`;
 const emptyBusiness=anchor('3349','Total Assets')+anchor('3399','Total Equity / Liabilities');
 // DOM fallback: production IRIS builds do not always expose the Angular API.
 const fallback=await run({personal:emptyPersonal,businessIbans:[other]});assert.equal(fallback.ok,true,JSON.stringify(fallback));
 // Positive Angular stability still passes.
 const stable=await run({personal:emptyPersonal,businessIbans:[other],angularStable:true});assert.equal(stable.ok,true,JSON.stringify(stable));
 // Explicitly BUSY Angular, a visible loader, or an unpainted page must hold.
 assert.equal((await run({personal:emptyPersonal,businessIbans:[other],angularStable:false})).ok,false);
 assert.equal((await run({personal:emptyPersonal+'<div class="loading-overlay">loading</div>',businessIbans:[other],angularStable:true})).ok,false);
 assert.equal((await run({personal:'',businessIbans:[other]})).ok,false);
 // The same evidence is required before accepting an empty 3320 section.
 const bsFallback=await run({business:emptyBusiness,personalIbans:[other]});assert.equal(bsFallback.ok,true,JSON.stringify(bsFallback));
 assert.equal((await run({business:emptyBusiness,personalIbans:[other],angularStable:false})).ok,false);
 assert.equal((await run({business:'',personalIbans:[other]})).ok,false);
});
