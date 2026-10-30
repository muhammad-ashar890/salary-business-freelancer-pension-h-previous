"use strict";
/**
 * Phase 3c (fix52): the Section 113 turnover row on IRIS's Computations tab.
 *
 * Evidence (no guesswork), ~/iris-business-captures:
 *  - capture 54: row 999905 "Turnover Tax u/s 113" (all cells disabled)
 *    carries one button.btn-section-add "+ Turnover". It opens
 *    mat-dialog-container > app-add-amount-code-row with h6 .left
 *    "Add Turnover Tax u/s 113", a search box, five .source-card cards (text
 *    in <p>, one checkbox each), ADD (disabled until a tick) and Cancel. This
 *    is the same picker component as the Tax Deduction tab (DP-3).
 *  - captures 57-61: the added rows, each with cells E E E D (Total Income /
 *    Subject to Final Tax / Subject to Exemption editable, Subject to
 *    Normal Tax computed) and a trash button:
 *      923152 @0.25%   923206 @0.50%   923168 @0.75%   923161 @1.25%
 *      9012 cotton ginners.
 *    The row text is the card text.
 *  - The Computations tab has no expansion panel around its rows. Its one
 *    heading bar reads Description | Code | Total Income | Subject to Final
 *    Tax | Subject to Exemption | Subject to Normal Tax.
 *
 * Rules:
 *  - Never navigates: the computations driver has already put IRIS on the
 *    tab through the navigator.
 *  - One probe call = one operation = at most one click. The only clicks are
 *    "+ Turnover", the one planned card's checkbox, ADD, and Cancel. Never
 *    the trash button, another card, Calculate, Prepare PSID, Save or
 *    Submit.
 *  - An existing row with the planned code is reused. A turnover row at
 *    ANOTHER rate (or cotton ginners) already on the tab stops the step: a
 *    second rate could tax the turnover twice, so the taxpayer is told.
 *  - Typing is not done here. The computations driver types the turnover
 *    with the row filler ("Total Income", header verified, read back).
 */

const navigation = require("./iris-navigation");

/** Must equal AGENT_BUILD_TAG in main.js. */
const BUILD_TAG = "pension-wht-64020004-base-20261030b";

const SPEC = Object.freeze({
  leftTab: "Computations",
  headerRowId: "999905",
  headerLabel: "Turnover Tax u/s 113",
  addLabel: "+ Turnover",
  pickerTitle: "Add Turnover Tax u/s 113",
  headings: Object.freeze([
    "Total Income",
    "Subject to Final Tax",
    "Subject to Exemption",
    "Subject to Normal Tax",
  ]),
  cells: "EEED",
  /** Row code -> row / card text (captures 54, 57-61). */
  rows: Object.freeze({
    "923152": "Turnover / Tax Chargeable u/s 113 @0.25%",
    "923206": "Turnover / Tax Chargeable u/s 113 @ 0.50%",
    "923168": "Turnover / Tax Chargeable u/s 113 @0.75%",
    "923161": "Turnover / Tax Chargeable u/s 113 @ 1.25%",
    "9012": "Turnover/Tax on Income of Cotton Ginners",
  }),
});
/** The rows the agent may add (cotton ginners: never). */
const TYPED_CODES = Object.freeze(["923152", "923206", "923168", "923161"]);

/**
 * Runs INSIDE the IRIS page (stringified). One call = one operation = at most
 * one click.
 */
function turnoverProbe(request) {
  const op = (request && request.op) || "inspect";
  const spec = request.spec;
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
  // Only our own picker's title is reported; any other dialog stays anonymous.
  const dialogList = dialogs.map((dialog) =>
    pickerTitleOf(dialog) === spec.pickerTitle
      ? { ours: true, title: spec.pickerTitle }
      : { ours: false, title: "[other dialog]" },
  );

  // ---- the Computations tab ----------------------------------------------
  const bodies = Array.from(
    document.querySelectorAll("app-nitr-wf-body .body.interface_21.active"),
  ).filter(visible);
  const body = bodies.length === 1 ? bodies[0] : null;
  const activeLeft = body
    ? Array.from(body.querySelectorAll("button.data-tab-left-btn.active")).filter(visible)
    : [];
  const onTab = activeLeft.length === 1 && textOf(activeLeft[0]) === spec.leftTab;
  const bars = body && onTab ? Array.from(body.querySelectorAll(".heading-bar")).filter(visible) : [];
  const headings =
    bars.length === 1
      ? Array.from(bars[0].querySelectorAll("strong"))
          .map(textOf)
          .filter((label) => label && label !== "Description" && label !== "Code")
      : null;
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
  const rowNodes = body && onTab ? Array.from(body.querySelectorAll(".tableRows[id]")) : [];
  const headerRows = rowNodes.filter((row) => row.id === spec.headerRowId);
  const turnoverCodes = Object.keys(spec.rows);
  const turnoverRows = rowNodes.filter((row) => turnoverCodes.includes(row.id)).map(rowInfo);
  const codes = turnoverRows.map((row) => row.code);
  const duplicateCodes = codes.filter((code, index) => codes.indexOf(code) !== index);
  const problems = [];
  if (!body) problems.push("body_not_unique");
  if (body && !onTab) problems.push("not_on_computations");
  if (onTab && JSON.stringify(headings) !== JSON.stringify(spec.headings)) problems.push("headings");
  let addButtons = [];
  if (onTab) {
    if (headerRows.length !== 1) problems.push("header_row");
    else {
      const info = rowInfo(headerRows[0]);
      if (info.description !== spec.headerLabel) problems.push("header_row_name");
      addButtons = Array.from(headerRows[0].querySelectorAll("button.btn-section-add")).filter(
        (button) => textOf(button) === spec.addLabel,
      );
      if (addButtons.length !== 1) problems.push("add_button");
    }
  }
  if (duplicateCodes.length) problems.push("turnover_row_twice");
  const structureOk = problems.length === 0;
  const base = {
    scope: Boolean(document.querySelector("app-nitr-wf-body")),
    dialogs: dialogList,
    onTab,
    headings,
    turnoverRows,
    duplicateCodes,
    problems,
    structureOk,
  };
  if (op === "inspect") return { ...base, ok: structureOk && dialogs.length === 0, reason: "inspected" };

  const click = (el, reason) => {
    el.click();
    return { ...base, ok: true, reason };
  };
  // ---- picker operations (only with exactly our picker open) -------------
  const ourPicker = () => (dialogs.length === 1 && dialogList[0].ours ? dialogs[0] : null);
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
    const dialog = ourPicker();
    if (!dialog) return { ...base, ok: false, reason: "picker_not_unique" };
    const options = optionStates(dialog);
    if (op === "picker") return { ...base, ok: true, reason: "picker_options_read", options };
    const cards = Array.from(dialog.querySelectorAll(".source-card")).filter(
      (card) => textOf(card.querySelector("p") || card) === request.label,
    );
    if (cards.length !== 1) return { ...base, ok: false, reason: "turnover_option_not_unique", options };
    const box = cards[0].querySelector('input[type="checkbox"]');
    if (!box) return { ...base, ok: false, reason: "turnover_checkbox_missing", options };
    if (box.disabled && box.checked) return { ...base, ok: false, reason: "turnover_already_present", options };
    if (box.disabled) return { ...base, ok: false, reason: "turnover_checkbox_disabled", options };
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
        reason: box.checked ? "turnover_selected" : "turnover_tick_failed",
        options: optionStates(dialog),
      };
    }
    if (!box.checked) return { ...base, ok: false, reason: "turnover_not_selected", options };
    const adds = Array.from(dialog.querySelectorAll("button")).filter(
      (b) => visible(b) && !b.disabled && textOf(b) === "ADD",
    );
    if (adds.length !== 1) return { ...base, ok: false, reason: "picker_add_not_ready", options };
    return click(adds[0], "picker_add_clicked");
  }

  // ---- everything below needs a clean, verified page -----------------------
  if (dialogs.length) return { ...base, ok: false, reason: "dialog_open" };
  if (!structureOk) return { ...base, ok: false, reason: "structure_unverified" };
  if (op === "open_picker") {
    const ready = addButtons.filter((button) => visible(button) && !button.disabled);
    if (ready.length !== 1) return { ...base, ok: false, reason: "add_button_not_ready" };
    return click(ready[0], "picker_open_clicked");
  }
  return { ...base, ok: false, reason: "unsupported_operation" };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The one IRIS frame that runs the probe (same rule as the Tax Deduction driver). */
async function findFrame(windowInstance) {
  const wc = windowInstance.webContents;
  const frames = wc.mainFrame ? [...(wc.mainFrame.framesInSubtree || [wc.mainFrame])] : [wc];
  const found = [];
  for (const frame of frames) {
    const url = frame.url || (wc.getURL && wc.getURL());
    if (!navigation.isAllowedPortalUrl(url)) continue;
    try {
      const state = await frame.executeJavaScript(
        `(${turnoverProbe.toString()})(${JSON.stringify({ op: "inspect", spec: SPEC })})`,
      );
      if (state && state.scope) found.push(frame);
    } catch {
      // A frame that cannot run the probe is not the IRIS return.
    }
  }
  return found.length === 1 ? found[0] : null;
}

/** Turnover entry from the packet -> problems (empty when the agent may use it). */
function validateTurnoverEntry(entry) {
  const problems = [];
  if (!entry || typeof entry !== "object") return ["missing"];
  if (!TYPED_CODES.includes(entry.code)) problems.push("code");
  else if (entry.label !== SPEC.rows[entry.code]) problems.push("label");
  if (!["TYPE", "USER"].includes(entry.action)) problems.push("action");
  if (entry.action === "TYPE" && !(Number.isInteger(entry.value) && entry.value > 0)) problems.push("value");
  if (entry.action === "USER" && !(typeof entry.message === "string" && entry.message.trim())) problems.push("message");
  return problems;
}

/**
 * Makes sure the planned turnover row is on the Computations tab: reuses it,
 * or adds it through "+ Turnover". Never types.
 * Returns { ok, reason, added, row, message? }.
 */
async function ensureTurnoverRow(windowInstance, entry, options = {}) {
  const { sleep = defaultSleep, settleMs = 600, attempts = 12, beforeStep = async () => {} } = options;
  let frame = null;
  const evaluate =
    options.evaluate ||
    ((request) => frame.executeJavaScript(`(${turnoverProbe.toString()})(${JSON.stringify(request)})`));
  const run = async (op, extra = {}) => {
    try {
      const out = await evaluate({ op, spec: SPEC, ...extra });
      return out && typeof out === "object" ? out : { ok: false, reason: "no_result" };
    } catch (error) {
      return { ok: false, reason: `probe_error: ${(error && error.message) || error}` };
    }
  };
  const act = async (op, extra = {}) => {
    await beforeStep();
    return run(op, extra);
  };
  const waitFor = async (op, extra, accept) => {
    let last = null;
    for (let i = 0; i < attempts; i += 1) {
      await sleep(settleMs);
      last = await run(op, extra);
      if (accept(last)) return { ok: true, value: last };
    }
    return { ok: false, value: last };
  };
  const label = entry && entry.label;
  const fail = (reason, message) => ({ ok: false, reason, added: false, row: null, message });
  const told = (detail) =>
    `Minimum tax (Section 113): the agent could not add the turnover row "${label}" on the Computations tab (${detail}). Please press "+ Turnover", tick "${label}" and type ${Number(entry && entry.value).toLocaleString("en-US")} in Total Income yourself.`;
  const problems = validateTurnoverEntry(entry);
  if (problems.length) return fail(`entry_refused: ${problems.join(", ")}`, told("the plan was not understood"));
  if (entry.action !== "TYPE") return fail("not_planned", entry.message);
  if (!options.evaluate) {
    try {
      frame = await findFrame(windowInstance);
    } catch {
      frame = null;
    }
    if (!frame) return fail("frame_not_found", told("the IRIS return page was not found"));
  }

  const cancelPicker = async () => {
    const pressed = await act("cancel");
    if (!pressed.ok) return { closed: false, reason: pressed.reason };
    if (pressed.reason === "picker_not_open") return { closed: true, reason: pressed.reason };
    const gone = await waitFor("inspect", {}, (s) => Array.isArray(s.dialogs) && s.dialogs.length === 0);
    return { closed: gone.ok, reason: gone.ok ? "closed" : "still_open" };
  };

  // 1) A clean, verified tab. Our own picker left open is closed with Cancel.
  let state = await run("inspect");
  if (Array.isArray(state.dialogs) && state.dialogs.length) {
    if (state.dialogs.length === 1 && state.dialogs[0].ours) {
      const cleaned = await cancelPicker();
      if (!cleaned.closed) return fail(`picker_not_closed (${cleaned.reason})`, told("an open turnover picker could not be closed"));
      state = await run("inspect");
    } else return fail("dialog_open", told("another IRIS window is open"));
  }
  if (!state.ok) {
    const detail = (state.problems && state.problems.length ? state.problems.join("/") : state.reason) || "not settled";
    return fail(`structure_unverified (${detail})`, told("the tab does not look like the captured IRIS layout"));
  }

  // 2) Rows already there: ours is reused; another rate stops the step.
  const others = (state.turnoverRows || []).filter((row) => row.code !== entry.code);
  if (others.length) {
    const names = others.map((row) => `"${row.description}" (${row.code})`).join(", ");
    return fail(
      "other_turnover_row_present",
      `Minimum tax (Section 113): IRIS already has the turnover row ${names}, but TaxRocket planned "${label}" (${entry.code}). The agent does not add a second rate; please check which rate is right for your business and type your turnover (${Number(entry.value).toLocaleString("en-US")}) in that row yourself.`,
    );
  }
  let rows = (state.turnoverRows || []).filter((row) => row.code === entry.code);
  let added = false;
  if (!rows.length) {
    // 3) "+ Turnover" -> tick the one card -> ADD -> the row appears.
    const opened = await act("open_picker");
    if (!opened.ok) return fail(`picker_not_opened (${opened.reason})`, told("the + Turnover button was not ready"));
    const shown = await waitFor("picker", {}, (s) => s.ok);
    const failInPicker = async (reason, detail) => {
      const cleaned = await cancelPicker();
      return fail(
        cleaned.closed ? reason : `${reason}; picker_not_closed (${cleaned.reason})`,
        told(cleaned.closed ? detail : `${detail}; the picker could not be closed with Cancel`),
      );
    };
    if (!shown.ok) return failInPicker(`picker_not_shown (${shown.value && shown.value.reason})`, "the picker did not open");
    const before = shown.value.options || [];
    const selected = await act("select", { label });
    if (!selected.ok)
      return failInPicker(
        selected.reason === "turnover_already_present"
          ? "picker_says_row_present_but_not_on_tab"
          : `turnover_not_selected (${selected.reason})`,
        "the planned rate could not be ticked",
      );
    const after = selected.options || [];
    const changed =
      before.length === after.length && before.every((o, i) => o.label === after[i].label)
        ? after.filter((o, i) => o.checked !== before[i].checked).map((o) => o.label)
        : null;
    if (!changed || changed.length !== 1 || changed[0] !== label)
      return failInPicker("picker_changed_unexpectedly", "the picker changed unexpectedly");
    const pressed = await act("add", { label });
    if (!pressed.ok) return failInPicker(`add_not_pressed (${pressed.reason})`, "ADD was not ready");
    const appeared = await waitFor(
      "inspect",
      {},
      (s) => s.ok && (s.turnoverRows || []).filter((row) => row.code === entry.code).length === 1,
    );
    if (!appeared.ok) {
      const last = appeared.value || {};
      if (Array.isArray(last.dialogs) && last.dialogs.some((d) => d.ours)) return failInPicker("row_not_added", "the row did not appear");
      return fail("row_not_added", told("the row did not appear"));
    }
    state = appeared.value;
    rows = (state.turnoverRows || []).filter((row) => row.code === entry.code);
    added = true;
    if ((state.turnoverRows || []).length !== 1)
      return fail("other_turnover_row_appeared", told("a second turnover row appeared"));
  }
  if (rows.length !== 1) return fail("row_not_unique", told("the row is shown twice"));
  const row = rows[0];
  if (row.description !== label) return fail("row_name_differs", told(`IRIS names the row "${row.description}"`));
  if (row.cells !== SPEC.cells) return fail(`cell_pattern_differs (IRIS ${row.cells})`, told("the row's cells differ from the captured layout"));
  return { ok: true, reason: added ? "row_added" : "row_already_present", added, row };
}

module.exports = {
  BUILD_TAG,
  SPEC,
  TYPED_CODES,
  turnoverProbe,
  validateTurnoverEntry,
  ensureTurnoverRow,
};
