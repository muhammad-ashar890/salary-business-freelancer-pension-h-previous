"use strict";
/**
 * DP-1 (Data Push, fix48): types the taxpayer's asset schedule into the IRIS
 * 2.0 top tab "Depreciation".
 *
 * Evidence (no guesswork):
 *  - capture 11 (`iris-business-captures/11_...html`): the tab body is
 *    `app-depreciation > .body.interface_23`; ONE `.heading-bar` with
 *    Description, Code, then the nine labels below; rows are
 *    `.tableRows[id]` WITHOUT the `.dataRow` class used by the Data grids,
 *    and the description is the row's first column (no
 *    `.row-description-text`). Row 324802 (`.form-head`) is the total, all
 *    disabled. Each asset row has nine inputs: 0-5 editable, 6-8 disabled
 *    (computed by IRIS); row 330308 has only 4 and 5 editable.
 *  - live census, job cmv9f3gso002g13ldnhvodcvc: "Top: Depreciation", 13
 *    rows, 68 editable cells (11 x 6 + 2).
 *  - top tab titles: `app-nitr-wf-body .custom-tabs > .sticky-tabs-head >
 *    .head .title` (same selector as iris-navigation.js).
 *
 * Rules:
 *  - Types only the six typed columns, only into the VISIBLE Depreciation
 *    body, only after headings, rows and the editable pattern match the
 *    capture. Anything else stops BEFORE typing.
 *  - Never clicks Calculate, Save, Submit, the Auto Calculate switch, or any
 *    dialog button. The only clicks are the "Depreciation" and "Data" tab
 *    titles.
 *  - A cell that already holds a different non-zero figure is not
 *    overwritten; it is reported for the taxpayer to decide.
 *  - Typing is the same as iris-row-filler.js (value, input, change, blur)
 *    and every figure is read back at once; the census tour re-reads it after
 *    the tab switches.
 */

const navigation = require("./iris-navigation");

/** Must equal AGENT_BUILD_TAG in main.js. */
const BUILD_TAG = "services-picker-aliases-20261105d";

const HEADINGS = Object.freeze([
  "WDV (BF)",
  "Deletion",
  "Addition (Used in Pakistan)",
  "Extent of Use",
  "Addition (New)",
  "Extent of Use",
  "Initial Allowance",
  "Depreciation",
  "WDV (CF)",
]);

const TOTAL_CODE = "324802";

/** Asset rows in IRIS order with the editable pattern seen in capture 11. */
const ROWS = Object.freeze({
  "330205": "Building (all types)",
  "33020405": "Ramp for Disabled Persons",
  "33030105": "Plant / Machinery (not Otherwise specified)",
  "330308": "Plant / Machinery eligible for Initial Allowance",
  "33030205": "Computer Hardware / Allied Items / Equipment used in manufacture of IT products",
  "33030305": "Furniture (including fittings)",
  "33030405": "Technical / Professional Books",
  "33030605": "Offshore Installations of mineral Oil concerns",
  "3304105": "Motor Vehicle (not plying for hire)",
  "3304205": "Motor Vehicle (plying for hire)",
  "3304305": "Ships",
  "3304405": "Aircrafts / Aero Engines",
});

const EDITABLE = Object.freeze({
  default: [true, true, true, true, true, true, false, false, false],
  "330308": [false, false, false, false, true, true, false, false, false],
});

const STATUS = Object.freeze({
  FILLED: "filled",
  ALREADY_CORRECT: "already_correct",
  OVERWRITE_NEEDS_CONFIRMATION: "overwrite_needs_confirmation",
  READBACK_MISMATCH: "readback_mismatch",
  COLUMN_DISABLED: "column_disabled",
  COLUMN_NOT_FOUND: "column_not_found",
  ROW_NOT_FOUND: "row_not_found",
  EMPTY_VALUE: "empty_value",
  UNVERIFIED_TARGET: "unverified_target",
});

/**
 * Runs INSIDE the IRIS page (serialised with toString()), so it must be fully
 * self-contained.
 *   op "inspect": read-only state of the tab (never clicks or types)
 *   op "open":    click the unique "Depreciation" tab title
 *   op "back":    click the unique "Data" tab title
 *   op "fill":    type request.fields into the verified, visible grid
 */
function depreciationProbe(request) {
  const op = (request && request.op) || "inspect";
  const spec = request.spec;
  const clean = (value) =>
    String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  const digits = (value) => String(value == null ? "" : value).replace(/[\s,]/g, "");
  const visible = (el) =>
    Boolean(
      el &&
        el.getClientRects().length &&
        getComputedStyle(el).display !== "none" &&
        getComputedStyle(el).visibility !== "hidden",
    );
  const dialogs = Array.from(
    document.querySelectorAll("mat-dialog-container"),
  ).filter(visible);
  const titles = Array.from(
    document.querySelectorAll("app-nitr-wf-body .custom-tabs > .sticky-tabs-head > .head .title"),
  ).filter(visible);
  const titleNamed = (label) => titles.filter((el) => clean(el.textContent) === label);
  const activeTitles = titles.filter((el) => el.classList.contains("active"));
  const busy = Array.from(
    document.querySelectorAll(
      '[aria-busy="true"], app-global-loader [role="progressbar"], .loading-overlay',
    ),
  ).some(visible);
  const activeBodies = Array.from(
    document.querySelectorAll("app-nitr-wf-body .custom-tabs .body.active"),
  ).filter(visible);
  const bodies = Array.from(document.querySelectorAll(".body.interface_23")).filter(visible);
  const base = {
    scope: titles.length > 0,
    dialogCount: dialogs.length,
    busy,
    activeTitle: activeTitles.length === 1 ? clean(activeTitles[0].textContent) : null,
    activeBodyInterfaces: activeBodies.flatMap((el) =>
      Array.from(el.classList).filter((name) => /^interface_\d+$/.test(name)),
    ),
    depreciationTitleCount: titleNamed("Depreciation").length,
    dataTitleCount: titleNamed("Data").length,
    shown: bodies.length === 1,
    bodyActiveClass: bodies.length === 1 ? bodies[0].classList.contains("active") : null,
  };
  if (op === "open" || op === "back") {
    if (dialogs.length) return { ...base, ok: false, reason: "dialog_open_not_touched" };
    const label = op === "open" ? "Depreciation" : "Data";
    const matches = titleNamed(label);
    if (matches.length !== 1) return { ...base, ok: false, reason: `${op}_tab_title_not_unique` };
    try { matches[0].scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) {}
    matches[0].click();
    return { ...base, ok: true, reason: `${op}_tab_clicked` };
  }
  if (!base.shown) return { ...base, ok: false, reason: bodies.length ? "depreciation_body_not_unique" : "depreciation_tab_not_shown" };
  const body = bodies[0];
  const bars = Array.from(body.querySelectorAll(".heading-bar")).filter(visible);
  const problems = [];
  let headings = [];
  if (bars.length !== 1) problems.push(`heading_bar_count_${bars.length}`);
  else {
    const strongs = Array.from(bars[0].querySelectorAll("strong")).map((el) => clean(el.textContent));
    headings = strongs.filter((label) => !["Description", "Code", "Action"].includes(label));
    if (JSON.stringify(headings) !== JSON.stringify(spec.headings)) problems.push("headings_differ");
  }
  const rowsOf = (code) =>
    Array.from(body.querySelectorAll('.tableRows[id="' + code + '"]')).filter(visible);
  const cellsOf = (row) =>
    Array.from(row.querySelectorAll(":scope > .columns-parent > .data-middle-child-wapper")).map(
      (wrapper) => {
        const inputs = Array.from(wrapper.querySelectorAll("input")).filter(visible);
        return inputs.length === 1 ? inputs[0] : null;
      },
    );
  const descriptionOf = (row) => {
    const first = row.querySelector(":scope > div");
    return first ? clean(first.textContent) : "";
  };
  const rows = [];
  for (const code of [spec.totalCode, ...Object.keys(spec.rows)]) {
    const found = rowsOf(code);
    if (found.length !== 1) {
      problems.push(`row_${code}_count_${found.length}`);
      continue;
    }
    const cells = cellsOf(found[0]);
    const pattern = code === spec.totalCode
      ? spec.headings.map(() => false)
      : spec.editable[code] || spec.editable.default;
    if (cells.length !== spec.headings.length || cells.some((cell) => !cell)) {
      problems.push(`row_${code}_cells_${cells.length}`);
      continue;
    }
    const editable = cells.map((cell) => !cell.disabled && !cell.readOnly);
    if (JSON.stringify(editable) !== JSON.stringify(pattern)) problems.push(`row_${code}_editable_pattern_differs`);
    const description = descriptionOf(found[0]);
    if (code !== spec.totalCode && description !== spec.rows[code]) problems.push(`row_${code}_label_differs`);
    rows.push({
      code,
      description,
      cells: cells.map((cell) => ({ value: cell.value || "", editable: !cell.disabled && !cell.readOnly })),
    });
  }
  const structureOk = !dialogs.length && problems.length === 0;
  if (op === "inspect")
    return { ...base, ok: structureOk, reason: structureOk ? "structure_verified" : dialogs.length ? "dialog_open" : "structure_differs", problems, headings, rows };
  if (op !== "fill") return { ...base, ok: false, reason: "unknown_op" };
  if (!structureOk)
    return { ...base, ok: false, reason: dialogs.length ? "dialog_open" : "structure_differs", problems, results: [] };
  const S = spec.status;
  const results = [];
  for (const field of request.fields || []) {
    const out = {
      key: field.key,
      irisCode: String(field.irisCode),
      label: field.label,
      requestedColumn: field.column,
      columnIndex: field.cellIndex,
      value: field.value,
      sectionId: "business_depreciation",
    };
    const target = digits(field.value);
    if (!/^\d+$/.test(target)) {
      results.push({ ...out, status: S.EMPTY_VALUE });
      continue;
    }
    const found = rowsOf(field.irisCode);
    if (found.length !== 1 || !Object.prototype.hasOwnProperty.call(spec.rows, String(field.irisCode))) {
      results.push({ ...out, status: S.ROW_NOT_FOUND });
      continue;
    }
    const row = found[0];
    out.rowDescription = descriptionOf(row);
    // The heading at this position must be the requested column, and its
    // occurrence (the 2nd "Extent of Use") must be the requested one.
    const index = field.cellIndex;
    const occurrence = headings.slice(0, index + 1).filter((label) => label === field.column).length;
    if (headings[index] !== field.column || occurrence !== field.headerOccurrence) {
      results.push({ ...out, status: S.COLUMN_NOT_FOUND });
      continue;
    }
    const input = cellsOf(row)[index];
    if (!input || input.disabled || input.readOnly) {
      results.push({ ...out, status: S.COLUMN_DISABLED });
      continue;
    }
    const existing = digits(input.value);
    if (existing !== "" && !/^0+$/.test(existing)) {
      if (existing === target) {
        results.push({ ...out, status: S.ALREADY_CORRECT, existingValue: input.value, plannedValue: target, readback: input.value });
        continue;
      }
      results.push({ ...out, status: S.OVERWRITE_NEEDS_CONFIRMATION, existingValue: input.value, plannedValue: target });
      continue;
    }
    const previousValue = input.value || "";
    try { input.scrollIntoView({ block: "center", behavior: "instant" }); } catch (e) {}
    try { input.focus(); } catch (e) {}
    if (input.disabled || input.readOnly) {
      results.push({ ...out, status: S.COLUMN_DISABLED, previousValue });
      continue;
    }
    input.value = target;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    try { input.blur(); } catch (e) {}
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    const readback = digits(input.value);
    if (readback !== target) {
      results.push({ ...out, status: S.READBACK_MISMATCH, previousValue, readback: input.value, typedValue: target });
      continue;
    }
    results.push({ ...out, status: S.FILLED, previousValue, readback: input.value, typedValue: target, plannedValue: target, matchedBy: "header_exact" });
  }
  return { ...base, ok: true, reason: "fill_done", results };
}

const SPEC = Object.freeze({
  headings: HEADINGS,
  totalCode: TOTAL_CODE,
  rows: ROWS,
  editable: EDITABLE,
  status: STATUS,
});

/** Agent-side copy of a packet field; refuses anything outside the six typed columns. */
function prepareDepreciationField(field) {
  const index = Number(field && field.cellIndex);
  const typed = [0, 1, 2, 3, 4, 5].includes(index);
  const expected = typed ? HEADINGS[index] : null;
  const occurrence = typed
    ? HEADINGS.slice(0, index + 1).filter((label) => label === expected).length
    : null;
  const valid =
    typed &&
    Object.prototype.hasOwnProperty.call(ROWS, String(field && field.irisCode)) &&
    field.column === expected &&
    Number(field.headerOccurrence) === occurrence &&
    Number.isInteger(Number(field.ourAmount)) &&
    Number(field.ourAmount) > 0;
  return {
    key: String(field && field.key),
    irisCode: String(field && field.irisCode),
    label: String((field && field.irisDescription) || ""),
    column: field && field.column,
    headerOccurrence: Number(field && field.headerOccurrence),
    cellIndex: index,
    value: valid ? String(Math.round(Number(field.ourAmount))) : "",
    valid,
  };
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
        `(${depreciationProbe.toString()})(${JSON.stringify({ op: "inspect", spec: SPEC })})`,
      );
      if (state && state.scope) found.push(frame);
    } catch {
      // A frame that cannot run the probe is not the IRIS return.
    }
  }
  return found.length === 1 ? found[0] : null;
}

/**
 * Types the Depreciation fields. Returns
 *   { ok, reason, results, computed, diagnostics }
 * `results` use the filler's status names so main.js, the census readback and
 * the job report treat them like every other typed figure.
 */
async function fillDepreciationTab(windowInstance, fields, context = {}) {
  const started = Date.now();
  const onStep = typeof context.onStep === "function" ? context.onStep : () => {};
  const attempts = Math.max(1, Number(context.attempts) || 40);
  const interval = Math.max(1, Number(context.intervalMs) || 250);
  const openAttempts = Math.max(1, Math.min(5, Number(context.openAttempts) || 3));
  const openRetryAfter = Math.max(1, Math.min(20, Number(context.openRetryAfter) || 8));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const diagnostics = { steps: [] };
  const step = (action, result) =>
    diagnostics.steps.push({
      action,
      ok: Boolean(result && result.ok),
      reason: (result && result.reason) || null,
      atMs: Date.now() - started,
    });
  const prepared = (fields || []).map(prepareDepreciationField);
  const refused = prepared.filter((field) => !field.valid);
  const finish = (result) => ({ ...result, diagnostics: { ...diagnostics, ms: Date.now() - started } });
  const untouched = (status) =>
    prepared.map((field) => ({
      key: field.key,
      irisCode: field.irisCode,
      label: field.label,
      requestedColumn: field.column,
      columnIndex: field.cellIndex,
      value: field.value,
      sectionId: "business_depreciation",
      status,
    }));
  if (!prepared.length) return finish({ ok: true, reason: "nothing_to_type", results: [], computed: null });
  if (refused.length)
    return finish({ ok: false, reason: "packet_field_not_a_typed_depreciation_cell", results: untouched(STATUS.UNVERIFIED_TARGET), computed: null });
  if (context.mode !== "live")
    return finish({ ok: false, reason: "dry_run_nothing_typed", results: [], computed: null });

  const frame = await findFrame(windowInstance);
  if (!frame)
    return finish({ ok: false, reason: "depreciation_frame_not_unique", results: untouched(STATUS.UNVERIFIED_TARGET), computed: null });
  const run = async (op, extra = {}) => {
    try {
      return await frame.executeJavaScript(
        `(${depreciationProbe.toString()})(${JSON.stringify({ op, spec: SPEC, ...extra })})`,
        true,
      );
    } catch {
      return { ok: false, reason: "frame_unavailable" };
    }
  };

  let state = await run("inspect");
  step("inspect", state);
  if (state.dialogCount)
    return finish({ ok: false, reason: "dialog_open", results: untouched(STATUS.UNVERIFIED_TARGET), computed: null });

  // The caller may still be switching the previous top-level tab back to
  // Data. Clicking during that Angular transition can be ignored, as seen in
  // the live fix55 run, so wait for one stable non-busy top-tab reading.
  if (!state.shown) {
    const settleAttempts = Math.min(attempts, 8);
    for (
      let i = 0;
      i < settleAttempts &&
      !state.shown &&
      !(!state.busy && (state.activeTitle === "Data" || state.activeTitle === "Depreciation"));
      i += 1
    ) {
      await sleep(interval);
      state = await run("inspect");
    }
    step("top_tab_settled", state);
  }

  let opened = null;
  let openCount = 0;
  let hiddenPollCount = 0;
  if (!state.shown) {
    opened = await run("open");
    openCount += 1;
    step("open", opened);
    if (!opened.ok)
      return finish({ ok: false, reason: opened.reason, results: untouched(STATUS.UNVERIFIED_TARGET), computed: null });
  }

  // Structure verified twice in a row before anything is typed. Only a tab
  // which remains specifically not shown may be re-clicked; a visible but
  // differing grid is never retried or forced.
  let stable = 0;
  for (let i = 0; i < attempts && stable < 2; i += 1) {
    state = await run("inspect");
    stable = state.ok ? stable + 1 : 0;
    hiddenPollCount = state.reason === "depreciation_tab_not_shown" ? hiddenPollCount + 1 : 0;
    diagnostics.openClicks = openCount;
    if (stable >= 2) break;
    await sleep(interval);
    if (
      hiddenPollCount >= openRetryAfter &&
      openCount < openAttempts &&
      !state.dialogCount &&
      state.depreciationTitleCount === 1
    ) {
      opened = await run("open");
      openCount += 1;
      hiddenPollCount = 0;
      diagnostics.openClicks = openCount;
      step(`open_retry_${openCount}`, opened);
      if (!opened.ok)
        return finish({ ok: false, reason: opened.reason, results: untouched(STATUS.UNVERIFIED_TARGET), computed: null });
    }
  }
  step("verify", state);
  diagnostics.openClicks = openCount;
  diagnostics.activeTitle = state.activeTitle || null;
  diagnostics.activeBodyInterfaces = state.activeBodyInterfaces || [];
  diagnostics.pageBusy = state.busy === true;
  diagnostics.bodyActiveClass = state.bodyActiveClass;
  if (stable < 2) {
    onStep(
      "real_autofill_depreciation_unverified",
      `Depreciation tab: ${state.reason}${state.problems && state.problems.length ? ` (${state.problems.slice(0, 6).join(", ")})` : ""}; ${prepared.length} figure(s) left untouched BEFORE typing.`,
    );
    const back = await run("back");
    step("back", back);
    return finish({ ok: false, reason: state.reason || "structure_unverified", problems: state.problems || [], results: untouched(STATUS.UNVERIFIED_TARGET), computed: null });
  }
  diagnostics.before = state.rows;
  const filled = await run("fill", { fields: prepared });
  step("fill", filled);
  const results = Array.isArray(filled.results) && filled.results.length
    ? filled.results
    : untouched(STATUS.UNVERIFIED_TARGET);
  // IRIS recalculates the grey cells itself; give it a moment, then read them.
  await sleep(Math.max(interval, 500));
  const after = await run("inspect");
  step("inspect_after", after);
  const computed = after && Array.isArray(after.rows)
    ? after.rows.map((row) => ({
        code: row.code,
        initialAllowance: row.cells[6] ? row.cells[6].value : null,
        depreciation: row.cells[7] ? row.cells[7].value : null,
        writtenDownValueCarriedForward: row.cells[8] ? row.cells[8].value : null,
      }))
    : null;
  const back = await run("back");
  step("back", back);
  const success = new Set([STATUS.FILLED, STATUS.ALREADY_CORRECT]);
  const ok = filled.ok === true && results.every((entry) => success.has(entry.status));
  onStep(
    "real_autofill_depreciation_done",
    `Depreciation tab: ${results.filter((entry) => success.has(entry.status)).length}/${results.length} figure(s) typed or already correct; IRIS computes Initial Allowance, Depreciation and WDV (CF) itself. Returned to the Data tab (${back.reason || "no_result"}).`,
  );
  return finish({ ok, reason: ok ? "depreciation_typed" : filled.reason || "some_figures_not_entered", results, computed });
}

/** Digits of an IRIS cell ("1,200,000" -> 1200000); empty cell -> 0. */
function cellNumber(value) {
  const text = String(value == null ? "" : value).replace(/[\s,]/g, "");
  if (text === "") return 0;
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  const number = Number(text.replace(/[()-]/g, ""));
  return Number.isFinite(number) ? (negative ? -number : number) : null;
}

/**
 * Compares IRIS's computed Depreciation cells (from the end census tour, i.e.
 * after the tab switches) with what TaxRocket expects. Read-only; a
 * difference is reported, never "fixed".
 */
function compareDepreciationComputed(tour, expectations) {
  const out = [];
  if (!expectations || !Array.isArray(expectations.rows)) return out;
  const wanted = [...expectations.rows, expectations.total].filter(Boolean);
  for (const expected of wanted) {
    const hits = [];
    for (const view of (tour && tour.views) || []) {
      for (const row of view.rows || []) if (String(row.code) === String(expected.code)) hits.push({ view: view.key, row });
    }
    if (hits.length !== 1) {
      out.push({ code: String(expected.code), status: "not_seen", detail: hits.length ? "row_not_unique" : "row_not_seen" });
      continue;
    }
    const cells = hits[0].row.cells || [];
    const pick = (index) => (cells[index] ? cells[index].value : null);
    const checks = [
      ["initialAllowance", 6],
      ["depreciation", 7],
      ["writtenDownValueCarriedForward", 8],
    ].map(([name, index]) => {
      const iris = cellNumber(pick(index));
      const want = Math.round(Number(expected[name]) || 0);
      return { name, iris: pick(index), expected: want, status: iris !== null && Math.abs(iris - want) < 1 ? "match" : "differs" };
    });
    out.push({
      code: String(expected.code),
      label: expected.label || "",
      status: checks.every((check) => check.status === "match") ? "match" : "differs",
      checks,
      view: hits[0].view,
    });
  }
  return out;
}

module.exports = {
  BUILD_TAG,
  HEADINGS,
  ROWS,
  EDITABLE,
  TOTAL_CODE,
  STATUS,
  SPEC,
  depreciationProbe,
  prepareDepreciationField,
  fillDepreciationTab,
  compareDepreciationComputed,
  cellNumber,
};
