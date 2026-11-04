'use strict';
// Read-only IRIS preflight. Never moves, deletes, clicks or edits a bank row.
const BUILD_TAG='pension-wht-64020004-base-20261030b';
// v3: diagnostic build. The guard itself stays read-only and fail-closed; it now
// reports WHICH settle condition failed, so a live hold can be diagnosed from
// latest-job.txt without guessing.
const PATCH_TAG='bank-hold-fix-v4-20261103';
// v4: IRIS 2.0 keeps NgZone "unstable" forever (polling timers), so Angular's
// isStable() is NOT a usable settle signal here. Real 2026-11-03 live evidence:
// 6/6 probes angular=unstable, readyState=complete, busy=false, dialogs=0,
// paintedRows=23, inspectStatus=ok, head999901=1. Accept an empty section only
// after repeated, IDENTICAL DOM settle evidence; a changing/unready DOM holds.
const DOM_STABLE_PROBES=3;
const wealth=require('./iris-wealth-driver');
const balance=require('./iris-balance-sheet-driver');
const normalize=v=>String(v||'').replace(/\s+/g,'').toUpperCase();
const exactIban=v=>{const s=normalize(v);return /^PK\d{2}[A-Z]{4}[A-Z0-9]{16}$/.test(s)?s:null};

// A brand-new return legitimately has NO 7030 / 3320 rows at all: IRIS 2.0 only
// paints the "Bank Account(s)" summary after "+ Assets" has been ticked, and the
// business Balance Sheet may still be settling right after a section switch.
// Verified against real IRIS 2.0 captures on 2026-11-03: Personal Assets tab has
// 23 painted rows and NO 7030 when fresh; Balance Sheet has 16 rows and one
// non-editable 3320 "Bank Account" summary.
//
// An empty section may be accepted, but ONLY with positive evidence that the
// surrounding tab has finished painting. A single getAllAngularTestabilities()
// probe is not enough: production Angular builds do not always expose it, and a
// transient loader made the 2026-11-03 run hold on an otherwise normal return.
const SETTLE_ATTEMPTS=6;
const SETTLE_DELAY_MS=250;
const MIN_PAINTED_ROWS=2;

// Diagnostics go to the Electron terminal AND to a file the operator can attach.
// Nothing here touches the IRIS page.
const nodeFs=require('fs'),nodeOs=require('os'),nodePath=require('path');
function diag(event,payload){
 const line=`[bank-guard ${PATCH_TAG}] ${event} ${JSON.stringify(payload)}`;
 try{console.log(line);}catch{}
 try{
  const dir=nodePath.join(nodeOs.homedir(),'TaxRocketAgentLogs');
  nodeFs.mkdirSync(dir,{recursive:true});
  nodeFs.appendFileSync(nodePath.join(dir,'bank-guard-diagnostic.log'),`${new Date().toISOString()} ${line}\n`);
 }catch{}
}

/**
 * Runs INSIDE the IRIS page (stringified into executeJavaScript). Reports
 * evidence, never a guess:
 *   angular 'stable'      -> testabilities exist and all report stable
 *            'unstable'    -> they exist but at least one is busy (NEVER accept)
 *            'unsupported' -> API absent/empty (production builds) or probe failed
 * 'unsupported' falls back to DOM evidence instead of failing the hold.
 */
function bankSectionSettleProbe(minRows){
 const visible=el=>{for(let n=el;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(n.hidden||s.display==='none'||s.visibility==='hidden')return false;}return true;};
 try{
  const paintedRows=document.querySelectorAll('.tableRows.dataRow[id]').length;
  const busy=Array.from(document.querySelectorAll('[aria-busy="true"], app-global-loader [role="progressbar"], .loading-overlay, mat-progress-spinner, mat-progress-bar, .ngx-spinner-overlay')).some(visible);
  // Match the drivers: only VISIBLE dialog containers count. Angular can
  // leave a hidden container in the DOM after a dialog is closed.
  const dialogs=Array.from(document.querySelectorAll('mat-dialog-container')).filter(visible).length;
  let angular='unsupported';
  if(typeof window.getAllAngularTestabilities==='function'){
   const ts=window.getAllAngularTestabilities();
   if(Array.isArray(ts)&&ts.length>0){
    angular=ts.every(t=>typeof t.isStable==='function'&&t.isStable())?'stable':'unstable';
   }
  }
  const domReady=document.readyState==='complete'&&!busy&&!dialogs&&paintedRows>=minRows;
  return {
   // strict: keep the original behaviour for supported/stable Angular builds
   ready:domReady&&angular!=='unstable',
   // DOM-only evidence, used by the repeated-probe fallback below
   domReady,
   angular,busy,dialogs,paintedRows,readyState:document.readyState,
  };
 }catch{return {ready:false,angular:'error',busy:true,dialogs:0,paintedRows:0};}
}

function readRows(result,code,allowAbsentSummary=false){
 if(!result || result.status!=='ok' || !Array.isArray(result.dialogs) || result.dialogs.length || !result.rows || !Array.isArray(result.rows[code])) throw new Error('IRIS bank section is not ready or has an open dialog.');
 const rows=result.rows[code];
 const summary=rows.filter(r=>!r.editable && String(r.description||'').trim().toLowerCase()===(code==='3320'?'bank account':'bank account(s)'));
 if (summary.length>1 || (summary.length===0 && (!allowAbsentSummary || rows.length!==0))) throw new Error('IRIS bank summary is missing or ambiguous.');
 const children=rows.filter(r=>!summary.includes(r));
 const seen=[];
 for(const row of children){
  const text=String(row.description||'');const matches=text.match(/\bPK\d{2}[A-Z]{4}[A-Z0-9]{16}\b/gi)||[];
  if(!row.editable || matches.length!==1 || !exactIban(matches[0])) throw new Error('An IRIS bank row has an ambiguous or unreadable IBAN.');
  seen.push(exactIban(matches[0]));
 }
 if(new Set(seen).size!==seen.length)throw new Error('Duplicate IBAN rows found in the same IRIS section.');
 return seen.sort();
}
function parseWealth(result,allowEmpty=false){
 if(!result?.rows || !Array.isArray(result.rows['999901']))throw new Error('Personal Assets section is not ready.');
 const head=result.rows['999901'].filter(r=>!r.editable && String(r.description||'').trim().toLowerCase()==='financial assets & investments (non-business)');
 if(head.length!==1 || !Array.isArray(result.sectionButtons) || !result.sectionButtons.some(b=>b.rowId==='999901' && String(b.label||'').trim().toLowerCase()==='+ assets'))throw new Error('Personal Assets section is not fully visible.');
 return readRows(result,'7030',allowEmpty);
}
/** An empty 3320 is now allowed too, but only under the same settle evidence. */
function parseBusiness(result,allowEmpty=false){return readRows(result,'3320',allowEmpty);}
async function inspectTwice({windowInstance,navigate,beforeStep,sleep,section,driver,codes,parse}){
 await beforeStep(); const moved=await navigate(section);if(!moved?.ok)throw new Error(`Could not verify ${section}.`);
 const code=section===wealth.SECTION_IDS.assets?'7030':'3320';
 const read=async()=>{
  let lastProbe=null,lastEvidence=null,attempt=0,domStreak=0,lastPainted=null;
  const attach=e=>{
   const p=lastProbe||{},v=lastEvidence||{};
   const tag=`[guard=${PATCH_TAG} section=${section} attempt=${attempt} angular=${p.angular} readyState=${p.readyState} busy=${p.busy} dialogs=${p.dialogs} paintedRows=${p.paintedRows} inspectStatus=${v.status} inspectDialogs=${v.dialogs} bankRows=${v.rows} summary=${v.summaryCount} head999901=${v.head}]`;
   try{e.message=`${e.message} ${tag}`;}catch{}
   diag('hold',{section,reason:String(e&&e.message),probe:lastProbe,evidence:lastEvidence});
   return e;
  };
  try{
   for(attempt=0;attempt<SETTLE_ATTEMPTS;attempt++){
    await beforeStep();
    const state=await windowInstance.webContents.executeJavaScript(driver.buildPageScript({op:'inspect',codes}));
    const rows=Array.isArray(state?.rows?.[code])?state.rows[code]:null;
    const summaryLabel=code==='3320'?'bank account':'bank account(s)';
    const summaryCount=rows?rows.filter(r=>!r.editable&&String(r.description||'').trim().toLowerCase()===summaryLabel).length:null;
    lastEvidence={status:state?.status,dialogs:state?.dialogs?.length,rows:rows?rows.length:null,summaryCount,
      head:Array.isArray(state?.rows?.['999901'])?state.rows['999901'].length:null,
      descriptions:rows?rows.slice(0,8).map(r=>String(r.description||'').slice(0,70)):null};
    if(rows&&rows.length>0){diag('rows-present',{section,attempt,...lastEvidence});return parse(state,true);}
    await beforeStep();
    const probe=await windowInstance.webContents.executeJavaScript(`(${bankSectionSettleProbe.toString()})(${MIN_PAINTED_ROWS})`);
    lastProbe=probe;
    diag('settle-probe',{section,attempt,...probe,...lastEvidence});
    if(probe?.ready===true){diag('settled',{section,attempt,angular:probe.angular,paintedRows:probe.paintedRows});return parse(state,true);}
    // Angular 'unstable' forever on IRIS 2.0: fall back to repeated, identical
    // DOM settle evidence. Any change (loader, dialog, row count, status) resets
    // the streak, so a still-painting page is never mistaken for an empty one.
    const domClean=probe?.domReady===true&&probe.angular==='unstable'&&state?.status==='ok'&&(state?.dialogs?.length||0)===0;
    if(domClean){
     if(lastPainted===probe.paintedRows)domStreak++;else{domStreak=1;lastPainted=probe.paintedRows;}
     diag('dom-streak',{section,attempt,streak:domStreak,paintedRows:probe.paintedRows,required:DOM_STABLE_PROBES});
     if(domStreak>=DOM_STABLE_PROBES){
      diag('settled-by-dom',{section,attempt,streak:domStreak,paintedRows:probe.paintedRows,angular:probe.angular});
      return parse(state,true);
     }
    }else{domStreak=0;lastPainted=null;}
    await sleep(SETTLE_DELAY_MS);
   }
   // Bounded wait exhausted without evidence: re-read with the strict flag so the
   // honest "missing or ambiguous" hold is returned instead of a guess.
   await beforeStep();
   const state=await windowInstance.webContents.executeJavaScript(driver.buildPageScript({op:'inspect',codes}));
   return parse(state,false);
  }catch(e){throw attach(e);}
 };
 const one=await read();await sleep(350);const two=await read();
 if(JSON.stringify(one)!==JSON.stringify(two))throw new Error(`${section} changed while being checked.`);
 return two;
}
async function checkBankCrossSection({windowInstance,navigate,beforeStep=async()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms)),personalIbans=[],businessIbans=[]}){
 try{
  const personal=personalIbans.map(exactIban),business=businessIbans.map(exactIban);
  if(personal.some(x=>!x)||business.some(x=>!x))throw new Error('A planned bank IBAN is missing or invalid.');
  if(new Set(personal).size!==personal.length||new Set(business).size!==business.length||personal.some(x=>business.includes(x)))throw new Error('The packet has duplicate or conflicting bank destinations.');
  if(!personal.length&&!business.length)return {ok:true};
  const existingPersonal=await inspectTwice({windowInstance,navigate,beforeStep,sleep,section:wealth.SECTION_IDS.assets,driver:wealth,codes:['999901','7030'],parse:parseWealth});
  const existingBusiness=await inspectTwice({windowInstance,navigate,beforeStep,sleep,section:balance.SECTION_ID,driver:balance,codes:['3320'],parse:parseBusiness});
  const conflicts=[...new Set([...personal.filter(i=>existingBusiness.includes(i)),...business.filter(i=>existingPersonal.includes(i))])];
  if(conflicts.length)return {ok:false,reason:'The same bank IBAN already exists in the opposite IRIS section (3320 or 7030). Review it manually before any automatic entry. No row was changed.',conflicts};
  return {ok:true};
 }catch(e){return {ok:false,reason:`Cannot safely verify both IRIS bank sections: ${e instanceof Error?e.message:String(e)} No bank row was changed.`};}
}
diag('loaded',{settleAttempts:SETTLE_ATTEMPTS,settleDelayMs:SETTLE_DELAY_MS,minPaintedRows:MIN_PAINTED_ROWS,domStableProbes:DOM_STABLE_PROBES});
module.exports={BUILD_TAG,PATCH_TAG,checkBankCrossSection,parseWealth,parseBusiness};
