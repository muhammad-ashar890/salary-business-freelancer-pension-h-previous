"use strict";

/**
 * Renders the IRIS Bank Cross-Section (7030 vs 3320) and Economic Transactions
 * Start Gate DOM states directly from `scripts/contracts/iris-bank-and-econ-contract.json`
 * (`rawHtmlPersisted: false`).
 */

const CONTRACT = require("../contracts/iris-bank-and-econ-contract.json");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderBankCrossSection(name) {
  const key = String(name || "").replace(/\.html$/i, "");
  const spec = CONTRACT.bankCrossSection;
  if (key === "personal") {
    const h = spec.personal.sectionHeader;
    const s = spec.personal.summaryRow;
    const c = spec.personal.childRow;
    return (
      `<!doctype html><html><body>` +
      `<div class="row v-padding-5 tableRows dataRow form-head" id="${escapeHtml(h.id)}">` +
      `<span class="row-description-text">${escapeHtml(h.description)} </span>` +
      `<div class="columns-parent"><div class="data-middle-child-wapper"><input disabled="" type="text"/></div></div>` +
      `<div class="full-width actions"><button class="btn-section-add" type="button"> ${escapeHtml(h.addLabel)} </button></div>` +
      `</div>` +
      `<div class="row v-padding-5 tableRows dataRow" id="${escapeHtml(s.id)}">` +
      `<span class="row-description-text">${escapeHtml(s.description)} </span>` +
      `<span class="data-first-child">${escapeHtml(s.id)}</span>` +
      `<div class="columns-parent"><div class="data-middle-child-wapper"><input disabled="" type="text"/></div></div>` +
      `<div class="full-width actions"><button class="btn-section-delete" type="button"></button><mat-icon class="btn-purple" id="add-balance-sheet-bank-account"></mat-icon></div>` +
      `</div>` +
      `<div class="row v-padding-5 tableRows dataRow" id="${escapeHtml(c.id)}">` +
      `<div class="sub-child"><span class="row-description-text">${escapeHtml(c.description)}</span></div>` +
      `<span class="data-first-child">${escapeHtml(c.id)}</span>` +
      `<div class="columns-parent"><div class="data-middle-child-wapper"><input type="text"/></div></div>` +
      `<div class="full-width actions"><button class="btn-section-delete" type="button"></button><mat-icon class="btn-orange" id="update-balance-sheet-bank-account"></mat-icon></div>` +
      `</div>` +
      `</body></html>`
    );
  }
  if (key === "business") {
    const s = spec.business.summaryRow;
    const c = spec.business.childRow;
    return (
      `<!doctype html><html><body>` +
      `<div class="row v-padding-5 tableRows dataRow" id="${escapeHtml(s.id)}">` +
      `<span class="row-description-text">${escapeHtml(s.description)} </span>` +
      `<span class="data-first-child">${escapeHtml(s.id)}</span>` +
      `<div class="columns-parent"><div class="data-middle-child-wapper"><input disabled="" type="text"/></div></div>` +
      `<div class="full-width actions"><mat-icon class="btn-purple" id="add-balance-sheet-bank-account"></mat-icon></div>` +
      `</div>` +
      `<div class="row v-padding-5 tableRows dataRow" id="${escapeHtml(c.id)}">` +
      `<div class="sub-child"><span class="row-description-text">${escapeHtml(c.description)}</span></div>` +
      `<span class="data-first-child">${escapeHtml(c.id)}</span>` +
      `<div class="columns-parent"><div class="data-middle-child-wapper"><input type="text"/></div></div>` +
      `<div class="full-width actions"><mat-icon class="btn-orange" id="update-balance-sheet-bank-account"></mat-icon><mat-icon class="btn-red" id="showUtilityEditButton1b"></mat-icon></div>` +
      `</div>` +
      `</body></html>`
    );
  }
  throw new Error(`Unknown bank cross-section contract "${name}"`);
}

function renderEconomicTransactionsGate() {
  const g = CONTRACT.economicTransactionsGate;
  const disabledAttr = g.startButton.disabled ? " disabled" : "";
  return (
    `<!doctype html><html><body>` +
    `<main><h6>${escapeHtml(g.heading)}</h6>` +
    `<button type="button" class="${escapeHtml(g.startButton.className)}"${disabledAttr}>${escapeHtml(g.startButton.label)}</button>` +
    `</main></body></html>`
  );
}

module.exports = {
  CONTRACT,
  renderBankCrossSection,
  renderEconomicTransactionsGate,
};
