"use strict";

/**
 * Renders IRIS 2.0 core section markup directly from the permanent JSON contract
 * (`scripts/contracts/iris-core-rows-contract.json`) so row-filler and field-map
 * suites never depend on external `.html` capture files on disk.
 */

const CORE_CONTRACT = require("../contracts/iris-core-rows-contract.json");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeSectionKey(nameOrFile) {
  return String(nameOrFile || "")
    .trim()
    .replace(/\.html$/i, "");
}

function renderIrisCoreSection(nameOrFile) {
  const key = normalizeSectionKey(nameOrFile);
  const section = CORE_CONTRACT.sections[key];
  if (!section) {
    throw new Error(
      `Unknown IRIS core section contract "${nameOrFile}". Available: ${Object.keys(CORE_CONTRACT.sections).join(", ")}`,
    );
  }

  const navButtons = (section.leftNav || [])
    .map((tab) => {
      const cls = tab === section.activeTab ? "data-tab-left-btn active" : "data-tab-left-btn";
      return `<button class="${cls}">${escapeHtml(tab)}</button>`;
    })
    .join("");

  const headingCols = (section.columns || [])
    .map((col) => `<div>${escapeHtml(col)}</div>`)
    .join("");

  const rowsHtml = (section.rows || [])
    .map((row) => {
      const writeable = new Set(row.writeableInputIndexes || []);
      const cells = Array.from({ length: row.cellCount }, (_, idx) => {
        const disabledAttr = writeable.has(idx) ? "" : " disabled";
        return `<div class="data-middle-child-wapper"><input type="text"${disabledAttr} value=""></div>`;
      }).join("");
      return (
        `<div class="tableRows dataRow" id="${escapeHtml(row.id)}">` +
        `<div class="data-first-child"><span class="row-description-text">${escapeHtml(row.description)}</span></div>` +
        `${cells}` +
        `</div>`
      );
    })
    .join("\n    ");

  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>IRIS contract: ${escapeHtml(section.title)}</title></head><body>\n` +
    `  <div class="left-nav">${navButtons}</div>\n` +
    `  <div class="iris-data">\n` +
    `    <div class="heading-bar"><div class="columns-parent">${headingCols}</div></div>\n` +
    `    ${rowsHtml}\n` +
    `  </div>\n` +
    `</body></html>\n`
  );
}

module.exports = {
  CORE_CONTRACT,
  renderIrisCoreSection,
};
