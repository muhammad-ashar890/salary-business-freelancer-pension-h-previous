"use strict";

/**
 * Renders IRIS 2.0 116 Wealth Statement sections and modals directly from
 * `scripts/contracts/iris-wealth-contract.json` (`rawHtmlPersisted: false`).
 */

const WEALTH_CONTRACT = require("../contracts/iris-wealth-contract.json");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderRow(row) {
  const rowCls = row.subChild
    ? "tableRows dataRow sub-child"
    : "tableRows dataRow";
  const addBtn = row.sectionAddLabel
    ? `<button type="button" class="btn-section-add">${escapeHtml(row.sectionAddLabel)}</button>`
    : "";
  const delSectionBtn = row.sectionDeleteButton
    ? `<button type="button" class="btn-section-delete">Delete</button>`
    : "";
  const purpleIcon = row.purpleAddIcon
    ? `<mat-icon class="btn-purple">add</mat-icon>`
    : "";
  const childIcons = row.editDeleteIcons
    ? `<mat-icon class="btn-orange">edit</mat-icon><mat-icon class="btn-red">delete</mat-icon>`
    : "";
  const disabledAttr = row.editable ? "" : " disabled";
  return (
    `<div class="${rowCls}" id="${escapeHtml(row.id)}">` +
    `<div class="data-first-child">` +
    `<span class="row-description-text">${escapeHtml(row.description)}</span>` +
    `${addBtn}${delSectionBtn}${purpleIcon}${childIcons}` +
    `</div>` +
    `<div class="data-middle-child-wapper"><input type="text"${disabledAttr} value=""></div>` +
    `</div>`
  );
}

function renderDialogFromSpec(spec) {
  const titleHtml = `<h6 mat-dialog-title><span class="left">${escapeHtml(spec.title)}</span><mat-icon>close</mat-icon></h6>`;
  const buttonsHtml = (spec.buttons || [])
    .map(
      (b) =>
        `<button type="button"${b.disabledInitially ? " disabled" : ""}>${escapeHtml(b.label)}</button>`,
    )
    .join("");
  const footerHtml = `<div mat-dialog-actions class="dialog-footer">${buttonsHtml}</div>`;

  let bodyInner = "";
  if (spec.kind === "picker") {
    const labels = spec.optionsByCode
      ? Object.values(spec.optionsByCode)
      : spec.options || [];
    const cardsHtml = labels
      .map(
        (label) =>
          `<div class="source-card"><input type="checkbox"><p>${escapeHtml(label)}</p></div>`,
      )
      .join("");
    bodyInner =
      `${titleHtml}` +
      `<input type="text" placeholder="${escapeHtml(spec.searchPlaceholder || "Search Amount Code/Description")}">` +
      `${cardsHtml}` +
      `${footerHtml}`;
  } else {
    const fieldsHtml = (spec.fields || [])
      .map((f) => {
        const attrs = [
          f.type ? `type="${escapeHtml(f.type)}"` : "",
          f.placeholder ? `placeholder="${escapeHtml(f.placeholder)}"` : "",
          f.formcontrolname
            ? `formcontrolname="${escapeHtml(f.formcontrolname)}"`
            : "",
          f.disabled ? "disabled" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const control =
          f.tag === "textarea"
            ? `<textarea ${attrs}></textarea>`
            : `<input ${attrs}>`;
        const suffix = f.hasSearchSuffix
          ? `<div class="mat-mdc-form-field-icon-suffix"><button type="button">search</button></div>`
          : "";
        return `<div class="mat-mdc-form-field">${control}${suffix}</div>`;
      })
      .join("");
    const cardsHtml = (spec.checkboxCards || [])
      .map(
        (label) =>
          `<div class="source-card"><input type="checkbox"><p>${escapeHtml(label)}</p></div>`,
      )
      .join("");
    bodyInner = `${titleHtml}${fieldsHtml}${cardsHtml}${footerHtml}`;
  }

  const wrapped = spec.componentTag
    ? `<${spec.componentTag}>${bodyInner}</${spec.componentTag}>`
    : bodyInner;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><mat-dialog-container role="dialog">${wrapped}</mat-dialog-container></body></html>`;
}

function renderWealthModal(name) {
  const key = String(name || "")
    .replace(/\.html$/i, "")
    .replace(/^modal-/, "");
  const map = {
    expenses: "expenses",
    "financial-assets": "financialAssets",
    financialAssets: "financialAssets",
    outflow: "outflow",
    bank: "bank",
    gift: "gift",
  };
  const spec = WEALTH_CONTRACT.dialogs[map[key] || key];
  if (!spec) {
    throw new Error(`Unknown wealth modal contract "${name}"`);
  }
  return renderDialogFromSpec(spec);
}

function renderWealthSection(name) {
  const key = String(name || "").replace(/\.html$/i, "");
  let rows = [];
  if (key === "reconciliation-default") {
    rows = WEALTH_CONTRACT.sections.reconciliationDefault;
  } else if (key === "assets-default") {
    rows = WEALTH_CONTRACT.sections.assetsDefault;
  } else if (key === "reconciliation-with-expenses-and-outflow") {
    const expenseRows = Object.entries(
      WEALTH_CONTRACT.dialogs.expenses.optionsByCode,
    ).map(([code, label]) => ({
      id: code,
      description: label,
      editable: true,
      sectionDeleteButton: true,
    }));
    rows = [];
    for (const r of WEALTH_CONTRACT.sections.reconciliationDefault) {
      rows.push(r);
      if (r.id === "7089") rows.push(...expenseRows);
      if (r.id === "7098") {
        rows.push({
          id: "7098",
          description: "Adjustments in Outflows - Income tax deducted u/s 149",
          editable: true,
          subChild: true,
          editDeleteIcons: true,
        });
      }
    }
  } else if (key === "assets-with-bank") {
    rows = [];
    for (const r of WEALTH_CONTRACT.sections.assetsDefault) {
      rows.push(r);
      if (r.id === "999901") {
        rows.push({
          id: "7030",
          description: "Bank Account(s)",
          editable: false,
          purpleAddIcon: true,
          sectionDeleteButton: true,
        });
        rows.push({
          id: "7030",
          description:
            "Bank Account(s) - PK35HABB0000001234567801 - Ahmed - HBL",
          editable: true,
          subChild: true,
          editDeleteIcons: true,
        });
      }
    }
  } else if (key === "reconciliation-with-gift") {
    rows = [];
    for (const r of WEALTH_CONTRACT.sections.reconciliationDefault) {
      rows.push(r);
      if (r.id === "7037") {
        rows.push({
          id: "7037",
          description: "Gift - 4220100000000 - DONOR - Gift received",
          editable: true,
          subChild: true,
          editDeleteIcons: true,
        });
      }
    }
  } else {
    throw new Error(`Unknown wealth section contract "${name}"`);
  }

  return (
    `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
    `<div class="iris-data">${rows.map(renderRow).join("")}</div>` +
    `</body></html>`
  );
}

module.exports = {
  WEALTH_CONTRACT,
  renderWealthModal,
  renderWealthSection,
};
