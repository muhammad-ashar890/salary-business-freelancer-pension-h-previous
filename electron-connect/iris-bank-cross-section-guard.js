'use strict';
// Read-only IRIS preflight. Never moves, deletes, clicks or edits a bank row.
const BUILD_TAG='pension-wht-64020004-base-20261030b';
const wealth=require('./iris-wealth-driver');
const balance=require('./iris-balance-sheet-driver');
const normalize=v=>String(v||'').replace(/\s+/g,'').toUpperCase();
const exactIban=v=>{const s=normalize(v);return /^PK\d{2}[A-Z]{4}[A-Z0-9]{16}$/.test(s)?s:null};
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
function parseBusiness(result){return readRows(result,'3320');}
async function inspectTwice({windowInstance,navigate,beforeStep,sleep,section,driver,codes,parse}){
 await beforeStep(); const moved=await navigate(section);if(!moved?.ok)throw new Error(`Could not verify ${section}.`);
 const read=async()=>{
  await beforeStep();
  const state=await windowInstance.webContents.executeJavaScript(driver.buildPageScript({op:'inspect',codes}));
  // An absent 7030 summary may be a real empty section or a half-painted
  // Angular view. Accept absence only when Angular itself reports stability and
  // no visible loader exists; unsupported/uncertain probes always hold.
  let allowEmpty=false;
  if(section===wealth.SECTION_IDS.assets && Array.isArray(state?.rows?.['7030']) && state.rows['7030'].length===0){
   await beforeStep();
   const stable=await windowInstance.webContents.executeJavaScript(`(${function(){
    const visible=el=>{for(let n=el;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(n.hidden||s.display==='none'||s.visibility==='hidden')return false;}return true;};
    try {const ts=typeof window.getAllAngularTestabilities==='function'?window.getAllAngularTestabilities():[];
     const busy=Array.from(document.querySelectorAll('[aria-busy="true"], app-global-loader [role="progressbar"], .loading-overlay, mat-progress-spinner, mat-progress-bar, .ngx-spinner-overlay')).some(visible);
     return {ready:document.readyState==='complete' && !busy && Array.isArray(ts) && ts.length>0 && ts.every(t=>typeof t.isStable==='function' && t.isStable())};
    }catch{return {ready:false};}
   }.toString()})()`);
   allowEmpty=stable?.ready===true;
  }
  return parse(state,allowEmpty);
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
module.exports={BUILD_TAG,checkBankCrossSection,parseWealth,parseBusiness};
