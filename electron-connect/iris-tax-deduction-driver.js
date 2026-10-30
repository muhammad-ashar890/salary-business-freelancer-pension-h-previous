"use strict";
/**
 * DP-3 (Data Push, fix50): types tax deducted from business receipts, by
 * section, on the IRIS 2.0 business left tab "Tax Deduction".
 *
 * Evidence (no guesswork), ~/iris-business-captures, 15-Oct-2026:
 *  - capture 10: Business navigation panel (left tabs ... "Tax Deduction",
 *    "Balance Sheet"); the tab body holds three grid panels
 *    (`mat-expansion-panel`, header titles "Adjustable Tax", "Final Tax",
 *    "Minimum Tax"), which can be collapsed. Each panel has one
 *    `.heading-bar` (Description | Code | value columns) and a header row
 *    999913 / 999915 / 999914 with disabled cells and
 *    `button.btn-section-add` "+ Section".
 *  - capture 34: added sections are `.tableRows.dataRow[id=<64xxxxxx>]`
 *    with `.row-description-text` = the section name, `span.data-first-child`
 *    = the code, one `.data-middle-child-wapper` per value column (empty when
 *    IRIS shows no input) and a Delete button.
 *  - captures 56 / 66 / 67: "+ Section" opens `mat-dialog-container` >
 *    `app-add-amount-code-row` titled "Add Minimum Tax" / "Add Adjustable
 *    Tax" / "Add Final Tax" (`h6 .left`): one `.source-card` per section
 *    (`p` = name, a checkbox; checked + disabled = already added), a search
 *    box, ADD (disabled until a tick) and Cancel.
 *
 * Rules:
 *  - Clicks only: the "Data" tab title, the "Business" panel header, the
 *    "Tax Deduction" left tab, a grid panel header (to open it), "+ Section",
 *    one section checkbox, ADD and the picker's own Cancel. Never Delete,
 *    "Offer this receipt under Normal Tax regime", "+ Attribute", Calculate,
 *    the return's Save or Submit.
 *  - Before anything is clicked inside the tab, the three panels, their
 *    headings, header rows and "+ Section" buttons are verified twice.
 *  - A section row already present is reused (never added twice); its name
 *    and cell pattern must equal the packet's. A newly-added row that first
 *    renders all-disabled is polled until IRIS enables that exact pattern
 *    (live 19-Oct-2026: 64060116 DD at first read, EE in the review HTML).
 *  - A cell holding a different figure is never overwritten, except a figure
 *    IRIS itself put there after the agent typed an earlier cell of the same
 *    (blank) row in this run [CHECK-LIVE: IRIS may compute Tax Deducted from
 *    Taxable Amount]; the taxpayer's certificate figure then replaces it and
 *    the report says so.
 *  - Every typed cell is read back at once and again after IRIS settles; the
 *    census tour re-reads it after the tab switches (main.js).
 *  - A picker the agent opened is closed with its own Cancel whenever a step
 *    fails; any other dialog stops the driver without a click.
 */

const navigation = require("./iris-navigation");

/** Must equal AGENT_BUILD_TAG in main.js. */
const BUILD_TAG = "pension-wht-64020004-base-20261030b";

const SECTION_ID = "business_tax_deduction";
/** Census view key of this tab (iris-tour-census.js: "<panel> > <left tab>"). */
const CENSUS_VIEW = "Business > Tax Deduction";

const STATUS = Object.freeze({
  FILLED: "filled",
  ALREADY_CORRECT: "already_correct",
  OVERWRITE_NEEDS_CONFIRMATION: "overwrite_needs_confirmation",
  READBACK_MISMATCH: "readback_mismatch",
  ROW_NOT_FOUND: "row_not_found",
  COLUMN_NOT_FOUND: "column_not_found",
  COLUMN_DISABLED: "column_disabled",
  UNVERIFIED_TARGET: "unverified_target",
  EMPTY_VALUE: "empty_value",
});
const SUCCESS = new Set([STATUS.FILLED, STATUS.ALREADY_CORRECT]);

const REGIMES = Object.freeze({
  adjustable: Object.freeze({
    panelTitle: "Adjustable Tax",
    headerRowId: "999913",
    pickerTitle: "Add Adjustable Tax",
    headers: Object.freeze(["Taxable Amount", "Tax Deducted"]),
  }),
  final: Object.freeze({
    panelTitle: "Final Tax",
    headerRowId: "999915",
    pickerTitle: "Add Final Tax",
    headers: Object.freeze(["Taxable Amount", "Tax Deducted", "Tax Chargeable"]),
  }),
  minimum: Object.freeze({
    panelTitle: "Minimum Tax",
    headerRowId: "999914",
    pickerTitle: "Add Minimum Tax",
    headers: Object.freeze([
      "Taxable Amount",
      "Tax Collected / Deducted",
      "Tax Chargeable",
      "Attributable Taxable Income",
      "Tax on Attributable Taxable Income",
      "Difference of Minimum Tax Chargeable",
    ]),
  }),
});
/** Regimes whose sections this build types (final-tax needs the P&L split first). */
const TYPED_REGIMES = new Set(["adjustable", "minimum"]);
/** Cell patterns this build types (capture 34). */
const TYPED_CELLS = Object.freeze({ adjustable: ["EE"], minimum: ["EEDDDD", "EEDEDD"] });
/**
 * Minimum-tax sections with standard cells that are still NOT typed
 * (lib/tax/iris-tax-deduction-sections.ts): IRIS asks a count (mobile
 * phones u/s 148, s.236CA) or extra "+ Attribute" details (ADTT, 64050098).
 */
const NOT_TYPED_CODES = new Set([
  "64120045", "64120046", "64120047", "64120048", "64120049", "64120050",
  "64120087", "64120088", "64050098", "64150507", "64150509", "64150510",
]);

const SPEC = Object.freeze({
  dataTab: "Data",
  navPanel: "Business",
  leftTab: "Tax Deduction",
  addLabel: "+ Section",
  regimes: REGIMES,
  status: STATUS,
});

/**
 * Runs INSIDE the IRIS page (stringified). One call = one operation = at most
 * one click.
 */
function taxDeductionProbe(request) {
  const op = (request && request.op) || "inspect";
  const spec = request.spec;
  const S = spec.status;
  const clean = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  const textOf = (el) => {
    if (!el) return "";
    const copy = el.cloneNode(true);
    copy.querySelectorAll("mat-icon, .mat-icon, script, style").forEach((n) => n.remove());
    return clean(copy.textContent);
  };
  const visible = (el) =>
    Boolean(
      el &&
        el.getClientRects().length &&
        getComputedStyle(el).display !== "none" &&
        getComputedStyle(el).visibility !== "hidden",
    );
  const digits = (value) => String(value == null ? "" : value).replace(/[\s,]/g, "");
  const blank = (value) => {
    const d = digits(value);
    return d === "" || /^0+(\.0+)?$/.test(d);
  };
  const regimeIds = Object.keys(spec.regimes);
  const pickerTitles = regimeIds.map((id) => spec.regimes[id].pickerTitle);

  // ---- dialogs -----------------------------------------------------------
  const dialogNodes = Array.from(
    document.querySelectorAll('mat-dialog-container, [role="dialog"]'),
  ).filter(visible);
  const dialogs = dialogNodes.filter(
    (el) => !dialogNodes.some((other) => other !== el && el.contains(other)),
  );
  const pickerTitleOf = (dialog) => {
    if (!dialog.querySelector("app-add-amount-code-row")) return null;
    const heads = Array.from(dialog.querySelectorAll("h6")).filter(visible);
    if (heads.length !== 1) return null;
    return textOf(heads[0].querySelector(".left") || heads[0]);
  };
  // Only our own pickers' titles are reported; any other dialog stays anonymous.
  const dialogList = dialogs.map((dialog) => {
    const title = pickerTitleOf(dialog);
    return pickerTitles.includes(title)
      ? { ours: true, title }
      : { ours: false, title: "[other dialog]" };
  });

  // ---- navigation --------------------------------------------------------
  const topTitles = Array.from(
    document.querySelectorAll("app-nitr-wf-body .custom-tabs > .sticky-tabs-head > .head .title"),
  ).filter(visible);
  const dataTitles = topTitles.filter((el) => textOf(el) === spec.dataTab);
  const dataActive = dataTitles.length === 1 && dataTitles[0].classList.contains("active");
  const bodies = Array.from(
    document.querySelectorAll("app-nitr-wf-body .body.interface_21.active"),
  ).filter(visible);
  const body = bodies.length === 1 ? bodies[0] : null;
  const headerOf = (panel) => panel.querySelector(":scope > mat-expansion-panel-header");
  const expanded = (header) =>
    Boolean(
      header &&
        (header.classList.contains("mat-expanded") ||
          header.getAttribute("aria-expanded") === "true"),
    );
  const navPanels = body
    ? Array.from(body.querySelectorAll("mat-expansion-panel")).filter((panel) => {
        const header = headerOf(panel);
        return (
          header &&
          visible(header) &&
          textOf(header) === spec.navPanel &&
          panel.querySelector("button.data-tab-left-btn")
        );
      })
    : [];
  const navPanel = navPanels.length === 1 ? navPanels[0] : null;
  const navExpanded = navPanel ? expanded(headerOf(navPanel)) : false;
  const tabButtons =
    navPanel && navExpanded
      ? Array.from(navPanel.querySelectorAll("button.data-tab-left-btn")).filter(
          (button) => visible(button) && textOf(button) === spec.leftTab,
        )
      : [];
  const activeLeft = body
    ? Array.from(body.querySelectorAll("button.data-tab-left-btn.active")).filter(visible)
    : [];
  const onTab = Boolean(
    navPanel &&
      activeLeft.length === 1 &&
      textOf(activeLeft[0]) === spec.leftTab &&
      navPanel.contains(activeLeft[0]),
  );

  // ---- grid panels -------------------------------------------------------
  const gridPanels = body && onTab
    ? Array.from(body.querySelectorAll("mat-expansion-panel")).filter(
        (panel) => !panel.querySelector("button.data-tab-left-btn"),
      )
    : [];
  const wrappersOf = (row) => Array.from(row.querySelectorAll(".data-middle-child-wapper"));
  const inputOf = (wrapper) => (wrapper ? wrapper.querySelector('input:not([type="hidden"])') : null);
  const rowInfo = (row) => {
    const cells = wrappersOf(row).map((wrapper) => {
      const input = inputOf(wrapper);
      return input ? { value: input.value || "", editable: !input.disabled && !input.readOnly } : null;
    });
    const description = row.querySelector(".row-description-text");
    return {
      code: row.id,
      description: description ? textOf(description) : "",
      cells: cells.map((cell) => (cell ? (cell.editable ? "E" : "D") : "-")).join(""),
      values: cells.map((cell) => (cell ? cell.value : null)),
    };
  };
  const panelOf = (id) => {
    const regime = spec.regimes[id];
    const matches = gridPanels.filter((panel) => {
      const header = headerOf(panel);
      return header && visible(header) && textOf(header) === regime.panelTitle;
    });
    return matches.length === 1 ? matches[0] : null;
  };
  const panelState = (id) => {
    const regime = spec.regimes[id];
    const panel = panelOf(id);
    if (!panel) return { id, ok: false, problems: ["panel_not_unique"], expanded: false, rows: [] };
    const bars = Array.from(panel.querySelectorAll(".heading-bar"));
    const headers =
      bars.length === 1
        ? Array.from(bars[0].querySelectorAll("strong"))
            .map(textOf)
            .filter((label) => label && label !== "Description" && label !== "Code")
        : null;
    const rowNodes = Array.from(panel.querySelectorAll(".tableRows[id]"));
    const headerRows = rowNodes.filter((row) => row.id === regime.headerRowId);
    const problems = [];
    if (!headers || JSON.stringify(headers) !== JSON.stringify(regime.headers)) problems.push("headings");
    if (headerRows.length !== 1) problems.push("header_row");
    else {
      const info = rowInfo(headerRows[0]);
      if (info.description !== regime.panelTitle) problems.push("header_row_name");
      if (info.cells !== "D".repeat(regime.headers.length)) problems.push("header_row_cells");
      const add = Array.from(headerRows[0].querySelectorAll("button.btn-section-add")).filter(
        (button) => textOf(button) === spec.addLabel,
      );
      if (add.length !== 1) problems.push("add_button");
    }
    return {
      id,
      ok: problems.length === 0,
      problems,
      expanded: expanded(headerOf(panel)),
      rows: rowNodes.filter((row) => row.id !== regime.headerRowId).map(rowInfo),
    };
  };
  const panels = onTab ? regimeIds.map(panelState) : [];
  const allCodes = panels.flatMap((panel) => panel.rows.map((row) => row.code));
  const duplicateCodes = allCodes.filter((code, index) => allCodes.indexOf(code) !== index);
  const structureOk =
    Boolean(body) &&
    dataActive &&
    onTab &&
    panels.length === regimeIds.length &&
    panels.every((panel) => panel.ok) &&
    duplicateCodes.length === 0;
  const base = {
    scope: Boolean(document.querySelector("app-nitr-wf-body")),
    dialogs: dialogList,
    dataActive,
    dataTabCount: dataTitles.length,
    bodyCount: bodies.length,
    navPanelCount: navPanels.length,
    navExpanded,
    tabButtonCount: tabButtons.length,
    onTab,
    panels,
    duplicateCodes,
    structureOk,
  };
  if (op === "inspect") return { ...base, ok: structureOk && dialogs.length === 0, reason: "inspected" };

  const click = (el, reason) => {
    el.click();
    return { ...base, ok: true, reason };
  };
  // ---- picker operations (only with exactly our picker open) -------------
  const ourPicker = () =>
    dialogs.length === 1 && dialogList[0].ours ? dialogs[0] : null;
  const optionStates = (dialog) =>
    Array.from(dialog.querySelectorAll(".source-card")).map((card) => {
      const box = card.querySelector('input[type="checkbox"]');
      const name = card.querySelector("p");
      return {
        label: textOf(name || card),
        checked: Boolean(box && box.checked),
        disabled: Boolean(box && box.disabled),
        missing: !box,
      };
    });
  if (op === "cancel") {
    if (!dialogs.length) return { ...base, ok: true, reason: "picker_not_open" };
    const dialog = ourPicker();
    if (!dialog) return { ...base, ok: false, reason: "cancel_target_not_unique" };
    const cancels = Array.from(dialog.querySelectorAll("button")).filter(
      (b) => visible(b) && !b.disabled && /^cancel$/i.test(textOf(b)),
    );
    if (cancels.length !== 1) return { ...base, ok: false, reason: "picker_cancel_not_found" };
    return click(cancels[0], "picker_cancel_clicked");
  }
  if (op === "picker" || op === "select" || op === "add") {
    const regime = spec.regimes[request.regime];
    const dialog = ourPicker();
    if (!regime || !dialog) return { ...base, ok: false, reason: "picker_not_unique" };
    if (dialogList[0].title !== regime.pickerTitle) return { ...base, ok: false, reason: "wrong_picker_title" };
    const options = optionStates(dialog);
    if (op === "picker") return { ...base, ok: true, reason: "picker_options_read", options };
    const cards = Array.from(dialog.querySelectorAll(".source-card")).filter(
      (card) => textOf(card.querySelector("p") || card) === request.label,
    );
    if (cards.length !== 1) return { ...base, ok: false, reason: "section_option_not_unique", options };
    const box = cards[0].querySelector('input[type="checkbox"]');
    if (!box) return { ...base, ok: false, reason: "section_checkbox_missing", options };
    if (box.disabled && box.checked) return { ...base, ok: false, reason: "section_already_present", options };
    if (box.disabled) return { ...base, ok: false, reason: "section_checkbox_disabled", options };
    const unrelated = Array.from(dialog.querySelectorAll('input[type="checkbox"]')).filter(
      (other) => other !== box && other.checked && !other.disabled,
    );
    if (unrelated.length)
      return { ...base, ok: false, reason: "unrelated_picker_selection_not_touched", options };
    if (op === "select") {
      if (!box.checked) box.click();
      return {
        ...base,
        ok: box.checked,
        reason: box.checked ? "section_selected" : "section_tick_failed",
        options: optionStates(dialog),
      };
    }
    if (!box.checked) return { ...base, ok: false, reason: "section_not_selected", options };
    const adds = Array.from(dialog.querySelectorAll("button")).filter(
      (b) => visible(b) && !b.disabled && textOf(b) === "ADD",
    );
    if (adds.length !== 1) return { ...base, ok: false, reason: "picker_add_not_ready", options };
    return click(adds[0], "picker_add_clicked");
  }

  // ---- everything below needs a clean page --------------------------------
  if (dialogs.length) return { ...base, ok: false, reason: "dialog_open" };
  if (op === "nav_data") {
    if (dataTitles.length !== 1) return { ...base, ok: false, reason: "data_tab_not_unique" };
    if (dataActive) return { ...base, ok: true, reason: "already_active" };
    return click(dataTitles[0], "clicked");
  }
  if (op === "nav_panel") {
    if (!navPanel) return { ...base, ok: false, reason: "business_panel_not_unique" };
    if (navExpanded) return { ...base, ok: true, reason: "already_active" };
    return click(headerOf(navPanel), "clicked");
  }
  if (op === "nav_tab") {
    if (onTab) return { ...base, ok: true, reason: "already_active" };
    if (tabButtons.length !== 1) return { ...base, ok: false, reason: "tax_deduction_tab_not_unique" };
    return click(tabButtons[0], "clicked");
  }
  if (!structureOk) return { ...base, ok: false, reason: "structure_unverified" };
  const regime = spec.regimes[request.regime];
  const panel = regime ? panelOf(request.regime) : null;
  if (!panel) return { ...base, ok: false, reason: "panel_not_unique" };
  const panelIsOpen = expanded(headerOf(panel));
  if (op === "expand") {
    if (panelIsOpen) return { ...base, ok: true, reason: "already_active" };
    return click(headerOf(panel), "clicked");
  }
  if (!panelIsOpen) return { ...base, ok: false, reason: "panel_collapsed" };
  if (op === "open_picker") {
    const headerRow = panel.querySelector(`.tableRows[id="${regime.headerRowId}"]`);
    const buttons = headerRow
      ? Array.from(headerRow.querySelectorAll("button.btn-section-add")).filter(
          (b) => visible(b) && !b.disabled && textOf(b) === spec.addLabel,
        )
      : [];
    if (buttons.length !== 1) return { ...base, ok: false, reason: "add_button_not_ready" };
    return click(buttons[0], "picker_open_clicked");
  }
  // Row operations: the row must be the only one with this code on the tab.
  const code = String(request.code || "");
  const rowNodes = Array.from(body.querySelectorAll(".tableRows[id]")).filter((row) => row.id === code);
  if (rowNodes.length !== 1 || !panel.contains(rowNodes[0]))
    return { ...base, ok: false, reason: rowNodes.length ? "row_not_unique" : "row_missing", status: S.ROW_NOT_FOUND };
  const row = rowNodes[0];
  const info = rowInfo(row);
  if (op === "read_row") return { ...base, ok: true, reason: "row_read", row: info };
  if (op !== "type") return { ...base, ok: false, reason: "unsupported_operation" };
  if (info.description !== request.label)
    return { ...base, ok: false, reason: "row_name_differs", status: S.ROW_NOT_FOUND, row: info };
  if (info.cells !== request.cells)
    return { ...base, ok: false, reason: "cell_pattern_differs", status: S.COLUMN_NOT_FOUND, row: info };
  const input = inputOf(wrappersOf(row)[request.index]);
  if (!input || input.disabled || input.readOnly)
    return { ...base, ok: false, reason: "cell_not_editable", status: S.COLUMN_DISABLED, row: info };
  if (!visible(input))
    return { ...base, ok: false, reason: "cell_not_visible", status: S.UNVERIFIED_TARGET, row: info };
  const target = digits(request.value);
  if (!/^\d+$/.test(target)) return { ...base, ok: false, reason: "empty_value", status: S.EMPTY_VALUE };
  const existing = digits(input.value);
  let replaced = null;
  if (!blank(existing)) {
    if (existing === target)
      return { ...base, ok: true, reason: "already_correct", status: S.ALREADY_CORRECT, existingValue: input.value, readback: input.value };
    // Only a figure IRIS produced in THIS run, after the agent typed an
    // earlier cell of the same row that was blank before, may be replaced.
    if (request.irisFilledAfterAgent !== true)
      return { ...base, ok: false, reason: "cell_holds_other_figure", status: S.OVERWRITE_NEEDS_CONFIRMATION, existingValue: input.value };
    replaced = input.value;
  }
  const previousValue = input.value || "";
  try { input.scrollIntoView({ block: "center" }); } catch (e) {}
  try { input.focus(); } catch (e) {}
  if (input.disabled || input.readOnly)
    return { ...base, ok: false, reason: "cell_locked_on_focus", status: S.COLUMN_DISABLED };
  input.value = target;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  try { input.blur(); } catch (e) {}
  input.dispatchEvent(new Event("blur", { bubbles: true }));
  const readback = digits(input.value);
  if (readback !== target)
    return { ...base, ok: false, reason: "readback_mismatch", status: S.READBACK_MISMATCH, previousValue, readback: input.value };
  return {
    ...base,
    ok: true,
    reason: "typed",
    status: S.FILLED,
    previousValue,
    readback: input.value,
    ...(replaced !== null ? { replacedIrisValue: replaced } : {}),
  };
}

/** Packet entry -> checked agent entry; anything outside the proven surface is refused. */
function prepareTaxDeductionField(field) {
  const regime = REGIMES[field && field.regime];
  const problems = [];
  if (!regime) problems.push("unknown_regime");
  if (regime && !TYPED_REGIMES.has(field.regime)) problems.push("regime_not_typed_in_this_build");
  if (!/^64\d{6}$/.test(String((field && field.irisCode) || ""))) problems.push("bad_code");
  if (NOT_TYPED_CODES.has(String((field && field.irisCode) || ""))) problems.push("section_not_typed_in_this_build");
  if (!field || typeof field.label !== "string" || !field.label.trim()) problems.push("no_section_name");
  const cells = String((field && field.cells) || "");
  if (regime && !(TYPED_CELLS[field.regime] || []).includes(cells)) problems.push("cells_not_typed_in_this_build");
  if (regime) {
    if (field.panelTitle !== regime.panelTitle) problems.push("panel_title");
    if (field.pickerTitle !== regime.pickerTitle) problems.push("picker_title");
    if (field.headerRowId !== regime.headerRowId) problems.push("header_row");
    if (JSON.stringify(field.headers || []) !== JSON.stringify(regime.headers)) problems.push("headings");
  }
  const values = Array.isArray(field && field.values) ? field.values : [];
  if (!values.length) problems.push("no_values");
  const seen = new Set();
  for (const value of values) {
    const index = value && value.columnIndex;
    if (!Number.isInteger(index) || cells[index] !== "E") problems.push(`column_${index}_not_editable`);
    else if (regime && value.column !== regime.headers[index]) problems.push(`column_${index}_name`);
    if (seen.has(index)) problems.push(`column_${index}_twice`);
    seen.add(index);
    if (!/^\d+$/.test(String(value && value.value))) problems.push(`column_${index}_amount`);
  }
  if (regime && !values.some((value) => value.columnIndex === 0)) problems.push("taxable_amount_missing");
  if (regime && !values.some((value) => value.columnIndex === 1)) problems.push("tax_deducted_missing");
  return {
    ...field,
    irisCode: String((field && field.irisCode) || ""),
    values: [...values].sort((a, b) => a.columnIndex - b.columnIndex),
    valid: problems.length === 0,
    problems,
  };
}

/** One report entry per value cell, in the row filler's format. */
function resultFor(field, value, extra) {
  return {
    key: `${field.key}:${value.columnIndex}`,
    irisCode: field.irisCode,
    label: `${field.label} - ${value.column}`,
    requestedColumn: value.column,
    columnIndex: value.columnIndex,
    value: value.value,
    plannedValue: value.value,
    regime: field.regime,
    rowDescription: field.label,
    sectionId: SECTION_ID,
    sourceGroup: "businessFields",
    censusView: CENSUS_VIEW,
    ...extra,
  };
}

function untouchedResults(fields, status, setupStatus) {
  return (fields || []).flatMap((field) =>
    (Array.isArray(field && field.values) ? field.values : []).map((value) =>
      resultFor(
        { ...field, irisCode: String((field && field.irisCode) || ""), label: String((field && field.label) || "") },
        value,
        { status, setupStatus },
      ),
    ),
  );
}

async function findFrame(windowInstance) {
  const wc = windowInstance.webContents;
  const frames = wc.mainFrame ? [...(wc.mainFrame.framesInSubtree || [wc.mainFrame])] : [wc];
  const found = [];
  for (const frame of frames) {
    const url = frame.url || (wc.getURL && wc.getURL());
    if (!navigation.isAllowedPortalUrl(url)) continue;
    try {
      const state = await frame.executeJavaScript(
        `(${taxDeductionProbe.toString()})(${JSON.stringify({ op: "inspect", spec: SPEC })})`,
      );
      if (state && state.scope) found.push(frame);
    } catch {
      // A frame that cannot run the probe is not the IRIS return.
    }
  }
  return found.length === 1 ? found[0] : null;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Adds the missing section rows (live) and types their amounts. Returns
 *   { ok, reason, results, setup, diagnostics }
 * Every value cell of every packet entry gets exactly one result.
 */
async function fillTaxDeductions(windowInstance, fields, options = {}) {
  const {
    mode = "dry",
    onStep = () => {},
    beforeStep = async () => {},
    verifyDocument = null,
    sleep = defaultSleep,
    attempts = 40,
    intervalMs = 250,
    settleMs = 400,
  } = options;
  const started = Date.now();
  const setup = [];
  const diagnostics = { steps: [] };
  const note = (step, detail) => {
    setup.push({ step, detail });
    onStep(`tax_deduction_${step}`, detail);
  };
  const step = (action, result) =>
    diagnostics.steps.push({
      action,
      ok: Boolean(result && result.ok),
      reason: (result && result.reason) || null,
      atMs: Date.now() - started,
    });
  const finish = (result) => ({ setup, ...result, diagnostics: { ...diagnostics, ms: Date.now() - started } });
  const prepared = (fields || []).map(prepareTaxDeductionField);
  const results = [];
  for (const field of prepared.filter((entry) => !entry.valid))
    for (const value of field.values)
      results.push(resultFor(field, value, { status: STATUS.UNVERIFIED_TARGET, setupStatus: `packet_entry_refused: ${field.problems.join(", ")}` }));
  const todo = prepared.filter((entry) => entry.valid);
  if (!todo.length)
    return finish({ ok: results.length === 0, reason: results.length ? "packet_entries_refused" : "nothing_to_type", results });
  if (mode !== "live")
    return finish({ ok: false, reason: "dry_run_nothing_clicked", results: [], planned: todo.length });

  const untouched = (reason) => {
    for (const field of todo)
      for (const value of field.values)
        results.push(resultFor(field, value, { status: STATUS.UNVERIFIED_TARGET, setupStatus: reason }));
    return finish({ ok: false, reason, results });
  };
  if (typeof verifyDocument === "function") {
    let doc;
    try {
      doc = await verifyDocument();
    } catch (error) {
      doc = { ok: false, status: `document_check_failed: ${error && error.message}` };
    }
    step("verify_document", { ok: doc && doc.ok, reason: doc && doc.status });
    if (!doc || !doc.ok) {
      note("document_unverified", `Tax Deduction: the open return could not be confirmed as this taxpayer's TY return (${(doc && doc.status) || "no_result"}); nothing was clicked.`);
      return untouched("document_unverified");
    }
  }
  const frame = await findFrame(windowInstance);
  if (!frame) return untouched("tax_deduction_frame_not_unique");
  const run = async (op, extra = {}) => {
    try {
      return await frame.executeJavaScript(
        `(${taxDeductionProbe.toString()})(${JSON.stringify({ op, spec: SPEC, ...extra })})`,
      );
    } catch {
      return { ok: false, reason: "frame_unavailable", dialogs: [], panels: [] };
    }
  };
  const act = async (op, extra = {}) => {
    await beforeStep();
    const out = await run(op, extra);
    step(op, out);
    return out;
  };
  const waitFor = async (op, extra, accept) => {
    let last;
    for (let i = 0; i < attempts; i += 1) {
      last = await run(op, extra);
      if (accept(last)) return { ok: true, value: last };
      await sleep(intervalMs);
    }
    return { ok: false, value: last };
  };
  // Press our picker's own Cancel and confirm it is gone.
  const cancelPicker = async () => {
    const out = { clicked: false, closed: false, reason: null };
    const cancel = await act("cancel");
    out.reason = cancel.reason;
    if (cancel.reason === "picker_not_open") {
      out.closed = true;
      return out;
    }
    if (!cancel.ok) return out;
    out.clicked = true;
    const gone = await waitFor("inspect", {}, (state) => Array.isArray(state.dialogs) && state.dialogs.length === 0);
    out.closed = gone.ok;
    return out;
  };

  // 1) A dialog already on screen: our leftover picker is cancelled once;
  //    anything else stops the driver without a click.
  let state = await run("inspect");
  step("inspect", state);
  if (Array.isArray(state.dialogs) && state.dialogs.length) {
    if (!(state.dialogs.length === 1 && state.dialogs[0].ours)) {
      note("unexpected_dialog", "Tax Deduction: a dialog is already open in IRIS; nothing was clicked.");
      return untouched("unexpected_dialog_open");
    }
    const cleaned = await cancelPicker();
    if (!cleaned.closed) {
      note("leftover_picker_not_closed", `Tax Deduction: a leftover "${state.dialogs[0].title}" picker could not be closed (${cleaned.reason}); nothing else was clicked.`);
      return untouched("leftover_picker_not_closed");
    }
    note("leftover_picker_closed", `Tax Deduction: a leftover "${state.dialogs[0].title}" picker was closed with its own Cancel; nothing was added.`);
  }

  // 2) Data tab > Business panel > Tax Deduction (navigation clicks only).
  for (const [op, ready] of [
    ["nav_data", (s) => s.dataActive],
    ["nav_panel", (s) => s.navExpanded],
    ["nav_tab", (s) => s.onTab],
  ]) {
    state = await run("inspect");
    if (ready(state)) continue;
    const clicked = await act(op);
    if (!clicked.ok) {
      note("navigation_failed", `Tax Deduction: could not open the tab (${op}: ${clicked.reason}); nothing was typed.`);
      return untouched(`navigation_${op}_${clicked.reason}`);
    }
    const settled = await waitFor("inspect", {}, ready);
    if (!settled.ok) {
      note("navigation_failed", `Tax Deduction: the tab did not open after ${op}; nothing was typed.`);
      return untouched(`navigation_${op}_not_settled`);
    }
  }

  // 3) Panels, headings, header rows and "+ Section" verified twice in a row.
  let stable = 0;
  for (let i = 0; i < attempts && stable < 2; i += 1) {
    state = await run("inspect");
    stable = state.ok ? stable + 1 : 0;
    if (stable < 2) await sleep(intervalMs);
  }
  step("verify_structure", state);
  if (stable < 2) {
    const problems = (state.panels || [])
      .filter((panel) => !panel.ok)
      .map((panel) => `${panel.id}: ${panel.problems.join("/")}`);
    note(
      "structure_unverified",
      `Tax Deduction: the tab does not look like the captured IRIS layout (${problems.join("; ") || (state.duplicateCodes && state.duplicateCodes.length ? `code(s) shown twice: ${state.duplicateCodes.join(", ")}` : state.reason || "not settled")}); nothing was clicked inside it.`,
    );
    return untouched("structure_unverified");
  }

  // 4) Each section: reuse its row or add it through the picker, then type.
  const panelOf = (s, regime) => (s.panels || []).find((panel) => panel.id === regime);
  const rowIn = (s, field) => {
    const panel = panelOf(s, field.regime);
    return panel ? panel.rows.filter((row) => row.code === field.irisCode) : [];
  };
  const readyRowIn = (s, field) => {
    const rows = rowIn(s, field);
    return rows.length === 1 &&
      rows[0].description === field.label &&
      rows[0].cells === field.cells
      ? rows[0]
      : null;
  };
  // Live 19-Oct-2026: a row added through the picker can first render with
  // every cell disabled (DD for an EE Adjustable row), then enable shortly
  // afterwards. The final review HTML showed EE. Poll read-only for that
  // exact captured pattern instead of handing the row to the taxpayer on the
  // first inspection.
  const waitForRowCells = (field) =>
    waitFor("inspect", {}, (s) => s.ok && Boolean(readyRowIn(s, field)));
  let halted = null;
  for (const field of todo) {
    const fail = (status, setupStatus) => {
      for (const value of field.values) results.push(resultFor(field, value, { status, setupStatus }));
    };
    if (halted) {
      fail(STATUS.UNVERIFIED_TARGET, `not_attempted_after: ${halted}`);
      continue;
    }
    // Open the regime panel (a navigation click) when it is collapsed.
    state = await run("inspect");
    if (!state.ok) {
      halted = `structure_lost (${state.reason})`;
      fail(STATUS.UNVERIFIED_TARGET, halted);
      continue;
    }
    if (!panelOf(state, field.regime).expanded) {
      const opened = await act("expand", { regime: field.regime });
      const shown = opened.ok
        ? await waitFor("inspect", {}, (s) => s.ok && panelOf(s, field.regime).expanded)
        : { ok: false };
      if (!shown.ok) {
        fail(STATUS.UNVERIFIED_TARGET, `panel_not_opened (${opened.reason})`);
        continue;
      }
      state = shown.value;
    }
    let rows = rowIn(state, field);
    let added = false;
    if (!rows.length) {
      const opened = await act("open_picker", { regime: field.regime });
      if (!opened.ok) {
        fail(STATUS.ROW_NOT_FOUND, `picker_not_opened (${opened.reason})`);
        continue;
      }
      const shown = await waitFor("picker", { regime: field.regime }, (s) => s.ok);
      const failInPicker = async (status, setupStatus) => {
        const cleaned = await cancelPicker();
        if (!cleaned.closed) {
          halted = `picker_not_closed (${cleaned.reason})`;
          note("picker_not_closed", `${field.label}: the "${field.pickerTitle}" picker could not be closed with Cancel (${cleaned.reason}); the driver stopped.`);
        }
        fail(status, setupStatus);
      };
      if (!shown.ok) {
        await failInPicker(STATUS.ROW_NOT_FOUND, `picker_not_shown (${shown.value && shown.value.reason})`);
        continue;
      }
      const before = shown.value.options || [];
      const selected = await act("select", { regime: field.regime, label: field.label });
      if (!selected.ok) {
        await failInPicker(
          STATUS.ROW_NOT_FOUND,
          selected.reason === "section_already_present"
            ? "picker_says_section_present_but_row_not_on_tab"
            : `section_not_selected (${selected.reason})`,
        );
        continue;
      }
      const after = selected.options || [];
      const changed =
        before.length === after.length && before.every((o, i) => o.label === after[i].label)
          ? after.filter((o, i) => o.checked !== before[i].checked).map((o) => o.label)
          : null;
      if (!changed || changed.length !== 1 || changed[0] !== field.label) {
        await failInPicker(STATUS.ROW_NOT_FOUND, "picker_changed_unexpectedly");
        continue;
      }
      const pressed = await act("add", { regime: field.regime, label: field.label });
      if (!pressed.ok) {
        await failInPicker(STATUS.ROW_NOT_FOUND, `add_not_pressed (${pressed.reason})`);
        continue;
      }
      const appeared = await waitFor(
        "inspect",
        {},
        (s) => s.ok && rowIn(s, field).length === 1,
      );
      if (!appeared.ok) {
        const last = appeared.value || {};
        if (Array.isArray(last.dialogs) && last.dialogs.some((d) => d.ours)) await failInPicker(STATUS.ROW_NOT_FOUND, "row_not_added");
        else fail(STATUS.ROW_NOT_FOUND, "row_not_added");
        continue;
      }
      state = appeared.value;
      rows = rowIn(state, field);
      added = true;
      note("section_added", `${field.label} (${field.irisCode}): added through "${field.pickerTitle}".`);
    }
    if (rows.length !== 1) {
      fail(STATUS.ROW_NOT_FOUND, "row_not_unique");
      continue;
    }
    let row = rows[0];
    if (row.description !== field.label) {
      fail(STATUS.ROW_NOT_FOUND, "row_name_differs");
      continue;
    }
    if (row.cells !== field.cells && /^D+$/.test(row.cells)) {
      const ready = await waitForRowCells(field);
      if (ready.ok) {
        state = ready.value;
        row = readyRowIn(state, field);
        note(
          "row_cells_enabled_after_wait",
          `${field.label} (${field.irisCode}): IRIS first showed the row disabled, then enabled the captured ${field.cells} cells; typing continued without a manual step.`,
        );
      } else if (ready.value) {
        const lastRows = rowIn(ready.value, field);
        if (lastRows.length === 1) row = lastRows[0];
      }
    }
    if (row.cells !== field.cells) {
      fail(STATUS.COLUMN_NOT_FOUND, `cell_pattern_differs (IRIS ${row.cells}, packet ${field.cells})`);
      continue;
    }
    // Type cell by cell; IRIS may react to each one, so wait between cells.
    const before = row.values.slice();
    const typedHere = [];
    let typedEarlier = false;
    for (const value of field.values) {
      const blankBefore = !/[1-9]/.test(String(before[value.columnIndex] || "").replace(/[\s,]/g, ""));
      const typeRequest = {
        regime: field.regime,
        code: field.irisCode,
        label: field.label,
        cells: field.cells,
        index: value.columnIndex,
        value: value.value,
        irisFilledAfterAgent: blankBefore && typedEarlier,
      };
      let typed = await act("type", typeRequest);
      if (typed.reason === "cell_pattern_differs") {
        // The probe returns this before typing, so one retry after the row
        // settles cannot duplicate a figure.
        const ready = await waitForRowCells(field);
        if (ready.ok) typed = await act("type", typeRequest);
      }
      const entry = resultFor(field, value, {
        status: typed.status || STATUS.UNVERIFIED_TARGET,
        setupStatus: added ? "row_added_by_agent" : "row_already_present",
        ...(typed.reason && !typed.ok ? { detail: typed.reason } : {}),
        ...(typed.previousValue !== undefined ? { previousValue: typed.previousValue } : {}),
        ...(typed.existingValue !== undefined ? { existingValue: typed.existingValue } : {}),
        ...(typed.readback !== undefined ? { readback: typed.readback } : {}),
        ...(typed.status === STATUS.FILLED ? { typedValue: value.value, matchedBy: "header_exact" } : {}),
        ...(typed.replacedIrisValue !== undefined ? { replacedIrisValue: typed.replacedIrisValue } : {}),
      });
      if (typed.status === STATUS.FILLED) typedEarlier = true;
      if (typed.replacedIrisValue !== undefined)
        note("iris_value_replaced", `${field.label}: IRIS filled "${value.column}" with ${typed.replacedIrisValue} after the agent typed the row; the approved figure ${value.value} was typed instead.`);
      results.push(entry);
      typedHere.push(entry);
      await sleep(settleMs);
    }
    // Read the row again once IRIS has settled: a typed cell must still hold it.
    await sleep(settleMs);
    const reread = await run("read_row", { regime: field.regime, code: field.irisCode });
    for (const entry of typedHere) {
      if (!SUCCESS.has(entry.status)) continue;
      const seen = reread.ok ? reread.row.values[entry.columnIndex] : null;
      const seenDigits = String(seen == null ? "" : seen).replace(/[\s,]/g, "");
      if (seenDigits !== String(entry.plannedValue)) {
        entry.statusBeforeSettle = entry.status;
        entry.status = STATUS.READBACK_MISMATCH;
        entry.readback = seen;
        entry.readbackStage = "after_settle";
      }
    }
  }
  const ok = results.length > 0 && results.every((entry) => SUCCESS.has(entry.status));
  return finish({ ok, reason: halted ? `halted: ${halted}` : ok ? "all_entered" : "some_not_entered", results });
}

/** One plain sentence for the run log. */
function describeTaxDeductionOutcome(outcome) {
  const results = (outcome && outcome.results) || [];
  const done = results.filter((entry) => SUCCESS.has(entry.status)).length;
  const sections = new Set(results.map((entry) => entry.irisCode)).size;
  if (outcome && outcome.reason === "dry_run_nothing_clicked")
    return `Tax Deduction: ${outcome.planned} section(s) would be added and typed in a live run; nothing was clicked.`;
  const problems = results
    .filter((entry) => !SUCCESS.has(entry.status))
    .map((entry) => `${entry.irisCode} ${entry.requestedColumn}: ${entry.status}${entry.setupStatus ? ` (${entry.setupStatus})` : ""}`);
  return `Tax Deduction: ${done} of ${results.length} figure(s) in ${sections} section(s) entered or already correct${problems.length ? `; not entered: ${problems.slice(0, 6).join("; ")}${problems.length > 6 ? "; ..." : ""}` : ""}. IRIS computes Tax Chargeable and the minimum-tax columns itself.`;
}

module.exports = {
  BUILD_TAG,
  SECTION_ID,
  CENSUS_VIEW,
  STATUS,
  REGIMES,
  SPEC,
  taxDeductionProbe,
  prepareTaxDeductionField,
  untouchedResults,
  fillTaxDeductions,
  describeTaxDeductionOutcome,
};
