"use strict";
const navigation = require("./iris-navigation");
const SERVICES_CONTRACT = require("./iris-services-contract.json");
const BUILD_TAG = "pension-services-multifiling-20261106a";

// Captures 30/31/32: rows of the business tab "Inadmissible/Admissible
// Deductions" are created through IRIS's own pickers -- "+ Inadmissible"
// opens "Add Inadmissible Deductions" (36 cards), "+ Admissible" opens "Add
// Admissible Deductions" (10 cards). This driver creates such a row; it never
// writes money, saves or submits (iris-row-filler types the figure after).
// Proven live on 15-Oct-2026 for 3212 (Personal Expenditure); DP-4 (fix53)
// uses the same flow, one row at a time, for every row the packet queues.
//
// Phase 1 (fix46):
// - IRIS shows the option of a row that is ALREADY in the grid as checked AND
//   disabled (captures 56/66/67, wealth fixture modal-financial-assets.html).
//   Such options are IRIS state, not a selection, so they are ignored (the
//   wealth driver calls the same state "already_present").
// - An option that is checked but still ENABLED (an unrequested selection) is
//   never touched and never added.
// - Every option's state is recorded when the picker opens and after the tick;
//   only our own option may change before ADD.
// - Any failure after the picker opened presses the picker's own Cancel and
//   confirms the dialog is gone, so no later step meets a leftover picker.
// - The grid rows are compared before/after ADD.
const PERSONAL_CODE = "3212";
const PERSONAL_LABEL = "Add Backs u/s 21(h) Personal Expenditure";
const PICKER_TITLE = "Add Inadmissible Deductions";
const DEDUCTIONS_TAB = "Inadmissible/Admissible Deductions";

/** The two pickers of the tab (captures 30 / 31): exact title and button text. */
const DEDUCTION_PICKERS = Object.freeze({
  inadmissible: Object.freeze({
    title: "Add Inadmissible Deductions",
    button: "+ Inadmissible",
    buttonReason: "add_inadmissible_not_unique",
  }),
  admissible: Object.freeze({
    title: "Add Admissible Deductions",
    button: "+ Admissible",
    buttonReason: "add_admissible_not_unique",
  }),
});
/**
 * Capture 31: the 10 cards of "Add Admissible Deductions". Every other
 * optional row of the tab is a card of "Add Inadmissible Deductions"
 * (capture 30); both lists add up to the 46 optional rows of the contract.
 */
const ADMISSIBLE_CARD_CODES = Object.freeze([
  "3245", "3246", "3247", "3248", "3250", "3254", "3255", "3256", "3257", "3258",
]);

// Result names. 3212 keeps the names of the live-proven driver (logs, job
// report, tests); every other row uses the deduction_* names.
const PERSONAL_REASONS = Object.freeze({
  duplicateRow: "duplicate_personal_addback_row",
  notUnique: "personal_reason_not_unique",
  checkboxMissing: "personal_reason_checkbox_missing",
  alreadyPresent: "personal_reason_already_present",
  checkboxDisabled: "personal_reason_checkbox_disabled",
  selected: "personal_reason_selected",
  tickFailed: "personal_reason_tick_failed",
  notSelected: "personal_reason_not_selected",
  addRequested: "personal_reason_add_requested",
  alreadyPresentInIris: "personal_reason_already_present_in_iris",
  markedPresentNotVisible: "personal_reason_marked_present_but_row_not_visible",
  added: "personal_reason_added_and_structure_verified",
});
const ROW_REASONS = Object.freeze({
  duplicateRow: "duplicate_deduction_row",
  notUnique: "deduction_reason_not_unique",
  checkboxMissing: "deduction_reason_checkbox_missing",
  alreadyPresent: "deduction_reason_already_present",
  checkboxDisabled: "deduction_reason_checkbox_disabled",
  selected: "deduction_reason_selected",
  tickFailed: "deduction_reason_tick_failed",
  notSelected: "deduction_reason_not_selected",
  addRequested: "deduction_reason_add_requested",
  alreadyPresentInIris: "deduction_reason_already_present_in_iris",
  markedPresentNotVisible: "deduction_reason_marked_present_but_row_not_visible",
  added: "deduction_row_added_and_structure_verified",
});

/**
 * What the probe needs for one row: exact label (contract = capture text),
 * picker and result names. Null when the row is not a typable picker row of
 * the tab (computed rows such as 3238 / 3248 are never created by the agent).
 */
function deductionTarget(code) {
  const id = String(code == null ? "" : code).trim();
  const spec = navigation.BUSINESS_CONTRACT.business_deductions?.rows?.[id];
  if (!spec || spec.optional !== true || !Array.isArray(spec.disabled) || spec.disabled[0] !== false)
    return null;
  const picker = ADMISSIBLE_CARD_CODES.includes(id)
    ? DEDUCTION_PICKERS.admissible
    : DEDUCTION_PICKERS.inadmissible;
  return {
    code: id,
    label: spec.label,
    pickerTitle: picker.title,
    button: picker.button,
    buttonReason: picker.buttonReason,
    ownPickerTitles: [DEDUCTION_PICKERS.inadmissible.title, DEDUCTION_PICKERS.admissible.title],
    reasons: id === PERSONAL_CODE ? PERSONAL_REASONS : ROW_REASONS,
  };
}

function pickerProbe(action, target) {
  if (!target || !target.code || !target.label || !target.reasons)
    return { scope: false, ok: false, reason: "probe_target_missing" };
  const label = target.label;
  const pickerTitle = target.pickerTitle;
  const reasons = target.reasons;
  const ownTitles = Array.isArray(target.ownPickerTitles) ? target.ownPickerTitles : [pickerTitle];
  const clean = (node) => {
    const clone = node.cloneNode(true);
    clone.querySelectorAll("mat-icon,script,style").forEach((n) => n.remove());
    return String(clone.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
  };
  const visible = (node) =>
    Boolean(
      node &&
      node.getClientRects().length &&
      getComputedStyle(node).display !== "none" &&
      getComputedStyle(node).visibility !== "hidden",
    );
  const dialogs = [
    ...document.querySelectorAll('mat-dialog-container[role="dialog"]'),
  ].filter(visible);
  const dialogTitle = (dialog) => {
    const titles = [...dialog.querySelectorAll("h6")];
    return titles.length === 1 ? clean(titles[0]) : null;
  };
  // One of the two deduction pickers (the agent opens them; a leftover one is
  // closed with its own Cancel). Only the target's picker is used to add.
  const ownPicker = (dialog) =>
    Boolean(dialog.querySelector("app-add-amount-code-row")) &&
    ownTitles.includes(dialogTitle(dialog));
  // Only our own pickers' titles are reported; any other dialog stays anonymous.
  const dialogList = dialogs.map((dialog) =>
    ownPicker(dialog)
      ? { title: dialogTitle(dialog), ours: true }
      : { title: "[other dialog]", ours: false },
  );
  const optionStates = (dialog) =>
    [...dialog.querySelectorAll(".source-card")].filter(visible).map((card) => {
      const box = card.querySelector('input[type="checkbox"]');
      return {
        label: clean(card),
        checked: Boolean(box && box.checked),
        disabled: Boolean(box && box.disabled),
        missing: !box,
      };
    });
  const bodies = [
    ...document.querySelectorAll("app-nitr-wf-body .body.interface_21.active"),
  ].filter(visible);
  if (bodies.length !== 1)
    return {
      scope: false,
      ok: false,
      reason: "business_body_not_unique",
      dialogs: dialogList,
    };
  const active = [
    ...bodies[0].querySelectorAll("button.data-tab-left-btn.active"),
  ].filter(visible);
  if (
    active.length !== 1 ||
    clean(active[0]) !== "Inadmissible/Admissible Deductions"
  )
    return {
      scope: false,
      ok: false,
      reason: "wrong_business_tab",
      dialogs: dialogList,
    };
  const gridRows = [...bodies[0].querySelectorAll(".tableRows.dataRow[id]")]
    .filter(visible)
    .map((row) => {
      const description = row.querySelector(".row-description-text");
      return { code: row.id, description: description ? clean(description) : "" };
    });
  const base = { scope: true, dialogs: dialogList, gridRows };
  const rows = [
    ...bodies[0].querySelectorAll(".tableRows.dataRow[id]"),
  ].filter((row) => visible(row) && row.id === target.code);
  if (action === "cancel") {
    if (!dialogs.length)
      return { ...base, ok: true, reason: "picker_not_open" };
    if (dialogs.length !== 1 || !ownPicker(dialogs[0]))
      return { ...base, ok: false, reason: "cancel_target_not_unique" };
    const cancels = [...dialogs[0].querySelectorAll("button")].filter(
      (b) => visible(b) && !b.disabled && /^cancel$/i.test(clean(b)),
    );
    if (cancels.length !== 1)
      return { ...base, ok: false, reason: "picker_cancel_not_found" };
    cancels[0].click();
    return { ...base, ok: true, reason: "picker_cancel_clicked" };
  }
  if (rows.length > 1)
    return { ...base, ok: false, reason: reasons.duplicateRow };
  if (rows.length === 1 && dialogs.length === 0) {
    const description = rows[0].querySelector(".row-description-text"),
      cells = [...rows[0].querySelectorAll(".data-middle-child-wapper input")];
    return {
      ...base,
      ok: Boolean(
        description &&
        clean(description) === label &&
        cells.length === 4 &&
        !cells[0].disabled &&
        !cells[0].readOnly,
      ),
      reason: "existing_row_checked",
    };
  }
  if (action === "inspect")
    return {
      ...base,
      ok: false,
      reason: dialogs.length ? "dialog_present" : "row_missing",
      ourPickerOpen: dialogs.length === 1 && ownPicker(dialogs[0]),
    };
  if (action === "open") {
    if (dialogs.length)
      return { ...base, ok: false, reason: "existing_dialog_not_touched" };
    const buttons = [
      ...bodies[0].querySelectorAll("button.btn-section-add"),
    ].filter((b) => visible(b) && !b.disabled && clean(b) === target.button);
    if (buttons.length !== 1)
      return { ...base, ok: false, reason: target.buttonReason };
    buttons[0].click();
    return { ...base, ok: true, reason: "picker_open_requested" };
  }
  if (
    dialogs.length !== 1 ||
    !dialogs[0].querySelector("app-add-amount-code-row")
  )
    return { ...base, ok: false, reason: "picker_not_unique" };
  if (dialogTitle(dialogs[0]) !== pickerTitle)
    return { ...base, ok: false, reason: "wrong_picker_title" };
  const options = optionStates(dialogs[0]);
  if (action === "options")
    return { ...base, ok: true, reason: "picker_options_read", options };
  const cards = [...dialogs[0].querySelectorAll(".source-card")].filter(
    (n) => visible(n) && clean(n) === label,
  );
  if (cards.length !== 1)
    return { ...base, ok: false, reason: reasons.notUnique, options };
  const checkbox = cards[0].querySelector('input[type="checkbox"]');
  if (!checkbox)
    return {
      ...base,
      ok: false,
      reason: reasons.checkboxMissing,
      options,
    };
  // IRIS state: the row already exists in the grid.
  if (checkbox.disabled && checkbox.checked)
    return {
      ...base,
      ok: false,
      reason: reasons.alreadyPresent,
      options,
    };
  if (checkbox.disabled)
    return {
      ...base,
      ok: false,
      reason: reasons.checkboxDisabled,
      options,
    };
  const boxes = [...dialogs[0].querySelectorAll('input[type="checkbox"]')];
  // Checked + disabled = rows IRIS already has: ignored, only reported.
  const alreadyPresent = options
    .filter((o) => o.checked && o.disabled && o.label !== label)
    .map((o) => o.label);
  const unrelated = boxes.filter(
    (n) => n !== checkbox && n.checked && !n.disabled,
  );
  if (unrelated.length)
    return {
      ...base,
      ok: false,
      reason: "unrelated_picker_selection_not_touched",
      options,
      alreadyPresent,
      unrelated: unrelated.map((n) => {
        const card = n.closest(".source-card");
        return card ? clean(card) : "[unlabelled option]";
      }),
    };
  if (action === "select") {
    if (!checkbox.checked) checkbox.click();
    return {
      ...base,
      ok: checkbox.checked,
      reason: checkbox.checked
        ? reasons.selected
        : reasons.tickFailed,
      options: optionStates(dialogs[0]),
      alreadyPresent,
    };
  }
  if (action === "add") {
    if (!checkbox.checked)
      return { ...base, ok: false, reason: reasons.notSelected, options };
    const buttons = [...dialogs[0].querySelectorAll("button")].filter(
      (b) => visible(b) && !b.disabled && clean(b) === "ADD",
    );
    if (buttons.length !== 1)
      return { ...base, ok: false, reason: "picker_add_not_ready", options };
    buttons[0].click();
    return {
      ...base,
      ok: true,
      reason: reasons.addRequested,
      options,
      alreadyPresent,
    };
  }
  return { ...base, ok: false, reason: "unsupported_picker_action" };
}

/** Compact, log-friendly view of every option's state. */
function summariseOptions(options) {
  const list = Array.isArray(options) ? options : [];
  return {
    total: list.length,
    checkedDisabled: list.filter((o) => o.checked && o.disabled).map((o) => o.label),
    checkedEnabled: list.filter((o) => o.checked && !o.disabled).map((o) => o.label),
    disabledOnly: list.filter((o) => !o.checked && o.disabled).map((o) => o.label),
    free: list.filter((o) => !o.checked && !o.disabled).length,
  };
}

/** Labels whose checked state differs between two reads of the same picker. */
function changedOptions(before, after) {
  const a = Array.isArray(before) ? before : [];
  const b = Array.isArray(after) ? after : [];
  if (a.length !== b.length || a.some((o, i) => o.label !== b[i].label))
    return null; // the picker itself changed: not comparable
  return b.filter((o, i) => o.checked !== a[i].checked).map((o) => o.label);
}

/** Rows that appeared or disappeared in the grid (code + description). */
function diffGridRows(before, after) {
  const key = (row) => `${row.code}|${row.description}`;
  const a = new Set((before || []).map(key));
  const b = new Set((after || []).map(key));
  return {
    added: (after || []).filter((row) => !a.has(key(row))),
    removed: (before || []).filter((row) => !b.has(key(row))),
  };
}

const TRANSIENT = {
  options: new Set(["picker_not_unique", "wrong_picker_title", "frame_unavailable"]),
  select: new Set([
    "picker_not_unique",
    "wrong_picker_title",
    ...[PERSONAL_REASONS, ROW_REASONS].flatMap((r) => [r.notUnique, r.checkboxMissing, r.tickFailed]),
    "frame_unavailable",
  ]),
  add: new Set(["picker_add_not_ready", "picker_not_unique", "frame_unavailable"]),
  inspect: new Set(["dialog_present", "row_missing", "frame_unavailable"]),
};

/**
 * Makes sure ONE typable row of the tab exists (creates it through its picker
 * when missing) and that the grid is still the verified business grid.
 */
async function ensureDeductionRow(windowInstance, code, context = {}) {
  if (context.mode !== "live")
    return { ok: false, reason: "dry_run_no_row_creation" };
  const target = deductionTarget(code);
  if (!target) return { ok: false, reason: "deduction_row_not_creatable" };
  const R = target.reasons;
  const started = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const attempts = Math.max(1, Number(context.pickerWaitAttempts) || 50);
  const interval = Math.max(1, Number(context.pickerWaitMs) || 100);
  const diagnostics = { picker: target.pickerTitle, target: target.label, code: target.code, steps: [] };
  const finish = (result) => ({
    ...result,
    diagnostics: { ...diagnostics, ms: Date.now() - started },
  });
  const step = (action, result) =>
    diagnostics.steps.push({
      action,
      ok: Boolean(result && result.ok),
      reason: (result && result.reason) || null,
      atMs: Date.now() - started,
    });
  const moved = await navigation.navigateToSection(windowInstance, {
    sectionId: "business_deductions",
    taxYear: context.taxYear,
    taxpayerIdentifier: context.taxpayerIdentifier,
  });
  if (!moved.ok)
    return finish({ ok: false, reason: "business_identity_or_structure_not_verified" });
  const verifyStructure = async () => {
    const structure = await navigation.probeFrames(windowInstance, {
      taxYear: context.taxYear,
    });
    return (
      structure.frames.filter(
        (frame) =>
          frame.section?.id === "business_deductions" &&
          frame.section?.business?.verified === true,
      ).length === 1
    );
  };
  const wc = windowInstance.webContents,
    frames = wc.mainFrame
      ? [...(wc.mainFrame.framesInSubtree || [wc.mainFrame])]
      : [wc];
  const run = async (frame, action) => {
    try {
      return await frame.executeJavaScript(
        `(${pickerProbe.toString()})(${JSON.stringify(action)}, ${JSON.stringify(target)})`,
      );
    } catch {
      return { scope: false, ok: false, reason: "frame_unavailable" };
    }
  };
  const allowed = [];
  for (const frame of frames) {
    const url = frame.url || wc.getURL?.();
    if (!navigation.isAllowedPortalUrl(url)) continue;
    const state = await run(frame, "inspect");
    if (state.scope) allowed.push({ frame, state });
  }
  if (allowed.length !== 1)
    return finish({ ok: false, reason: "business_action_frame_not_unique" });
  const frame = allowed[0].frame;
  let state = allowed[0].state;
  const wait = async (action, transient) => {
    let result;
    for (let i = 0; i < attempts; i++) {
      result = await run(frame, action);
      if (result.ok || !transient.has(result.reason)) return result;
      await sleep(interval);
    }
    return result;
  };
  // Press our picker's own Cancel and confirm it is really gone.
  const cleanup = async () => {
    const out = { clicked: false, closed: false, reason: null };
    const cancel = await run(frame, "cancel");
    out.reason = cancel.reason;
    if (cancel.reason === "picker_not_open") {
      out.closed = true;
      return out;
    }
    if (!cancel.ok) return out;
    out.clicked = true;
    for (let i = 0; i < attempts; i++) {
      const after = await run(frame, "inspect");
      if (Array.isArray(after.dialogs) && after.dialogs.length === 0) {
        out.closed = true;
        return out;
      }
      await sleep(interval);
    }
    return out;
  };
  const fail = async (result) => {
    const cleaned = await cleanup();
    diagnostics.cleanup = cleaned;
    step("cancel", { ok: cleaned.closed, reason: cleaned.reason });
    return finish({ ...result, ok: false, cleanup: cleaned });
  };

  step("inspect", state);
  diagnostics.gridRowsBefore = state.gridRows || [];
  // A picker of ours left open (e.g. by an earlier interrupted run) is closed
  // first; any other dialog is never touched. This comes BEFORE the structure
  // check, because any open dialog makes the grid unverifiable.
  if (state.reason === "dialog_present") {
    if (!state.ourPickerOpen) return finish(state);
    const cleaned = await cleanup();
    diagnostics.leftoverCleanup = cleaned;
    step("cancel_leftover", { ok: cleaned.closed, reason: cleaned.reason });
    if (!cleaned.closed)
      return finish({ ok: false, reason: "leftover_picker_not_closed", cleanup: cleaned });
    state = await run(frame, "inspect");
    step("inspect", state);
    diagnostics.gridRowsBefore = state.gridRows || [];
  }
  if (!(await verifyStructure()))
    return finish({ ok: false, reason: "business_structure_not_verified" });
  if (state.ok) return finish(state);
  if (state.reason !== "row_missing") return finish(state);
  const opened = await run(frame, "open");
  step("open", opened);
  if (!opened.ok) return finish(opened);
  const shown = await wait("options", TRANSIENT.options);
  step("options", shown);
  if (!shown.ok) return fail(shown);
  diagnostics.optionsBefore = summariseOptions(shown.options);
  const selected = await wait("select", TRANSIENT.select);
  step("select", selected);
  diagnostics.optionsAfterSelect = summariseOptions(selected.options);
  if (selected.alreadyPresent) diagnostics.alreadyPresent = selected.alreadyPresent;
  if (selected.unrelated) diagnostics.unrelated = selected.unrelated;
  if (!selected.ok) {
    if (selected.reason === R.alreadyPresent) {
      // IRIS says the row exists: close the picker and look again.
      const cleaned = await cleanup();
      diagnostics.cleanup = cleaned;
      step("cancel", { ok: cleaned.closed, reason: cleaned.reason });
      const again = cleaned.closed ? await wait("inspect", new Set(["frame_unavailable"])) : null;
      if (again) step("inspect", again);
      if (again && again.ok)
        return finish({ ok: true, reason: R.alreadyPresentInIris });
      return finish({
        ok: false,
        reason: R.markedPresentNotVisible,
        cleanup: cleaned,
      });
    }
    return fail(selected);
  }
  const changed = changedOptions(shown.options, selected.options);
  diagnostics.changedOptions = changed;
  if (!changed || changed.length !== 1 || changed[0] !== target.label)
    return fail({ ok: false, reason: "picker_changed_unexpectedly", changed });
  const added = await wait("add", TRANSIENT.add);
  step("add", added);
  if (!added.ok) return fail(added);
  const checked = await wait("inspect", TRANSIENT.inspect);
  step("inspect_after_add", checked);
  diagnostics.gridRowsAfter = checked.gridRows || [];
  const diff = diffGridRows(diagnostics.gridRowsBefore, diagnostics.gridRowsAfter);
  diagnostics.rowsAdded = diff.added;
  diagnostics.rowsRemoved = diff.removed;
  if (!checked.ok) {
    if (Array.isArray(checked.dialogs) && checked.dialogs.some((d) => d.ours))
      return fail({ ok: false, reason: "added_row_not_confirmed", detail: checked.reason });
    return finish({ ok: false, reason: "added_row_not_confirmed", detail: checked.reason });
  }
  if (diff.removed.length)
    return finish({ ok: false, reason: "grid_rows_removed_after_add" });
  const final = await navigation.navigateToSection(windowInstance, {
    sectionId: "business_deductions",
    taxYear: context.taxYear,
    taxpayerIdentifier: context.taxpayerIdentifier,
  });
  if (!final.ok)
    return finish({ ok: false, reason: "added_reason_structure_unverified" });
  const readback = await navigation.probeFrames(windowInstance, {
    taxYear: context.taxYear,
  });
  return readback.frames.filter(
    (frame) =>
      frame.section?.id === "business_deductions" &&
      frame.section?.business?.verified === true,
  ).length === 1
    ? finish({ ok: true, reason: R.added })
    : finish({ ok: false, reason: "added_reason_structure_unverified" });
}

/**
 * The live-proven 3212 entry point (fix44): only Personal Expenditure fields.
 * Result names unchanged ("personal_reason_*").
 */
async function ensurePersonalAddbackRow(windowInstance, fields, context = {}) {
  if (context.mode !== "live")
    return { ok: false, reason: "dry_run_no_row_creation" };
  if (
    !fields?.length ||
    fields.some(
      (f) =>
        String(f.irisCode) !== PERSONAL_CODE || f.sourceGroup !== "businessFields",
    )
  )
    return { ok: false, reason: "unsupported_business_reason" };
  return ensureDeductionRow(windowInstance, PERSONAL_CODE, context);
}

const normalizeText = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();

/**
 * DP-4 (fix53): every row of the Inadmissible/Admissible Deductions group,
 * one at a time in packet order, each through the proven single-row flow.
 * The whole group is refused before any click when a field is not a typable
 * picker row or its packet label is not the IRIS text. The first row that
 * cannot be made ready stops the loop; rows already made ready stay usable.
 */
async function ensureDeductionRows(windowInstance, fields, context = {}) {
  if (context.mode !== "live")
    return { ok: false, reason: "dry_run_no_row_creation", rows: [], notAttempted: [] };
  const list = Array.isArray(fields) ? fields : [];
  if (!list.length)
    return { ok: false, reason: "no_deduction_rows_requested", rows: [], notAttempted: [] };
  const codes = [];
  for (const field of list) {
    const code = String(field?.irisCode == null ? "" : field.irisCode).trim();
    if (field?.sourceGroup !== "businessFields")
      return { ok: false, reason: "unsupported_business_reason", code, rows: [], notAttempted: [] };
    const target = deductionTarget(code);
    if (!target)
      return { ok: false, reason: "deduction_row_not_creatable", code, rows: [], notAttempted: [] };
    if (field.irisDescription && normalizeText(field.irisDescription) !== normalizeText(target.label))
      return { ok: false, reason: "deduction_label_mismatch", code, rows: [], notAttempted: [] };
    if (!codes.includes(code)) codes.push(code);
  }
  const rows = [];
  for (let index = 0; index < codes.length; index++) {
    const out = await ensureDeductionRow(windowInstance, codes[index], context);
    rows.push({ code: codes[index], ...out });
    if (!out.ok)
      return {
        ok: false,
        reason: out.reason,
        failedCode: codes[index],
        rows,
        notAttempted: codes.slice(index + 1),
      };
  }
  return { ok: true, reason: "deduction_rows_ready", rows, notAttempted: [] };
}

/**
 * Services withholding rows live on Business > Tax Deduction and are created
 * through that tab's own "+ Section" pickers. This branch is deliberately
 * separate from the Business deductions driver above: it only accepts the
 * exact evidence-gated Services fields and one contract row at a time.
 */
function servicesTaxDeductionTarget(field) {
  if (field?.servicesMappingKind !== "SERVICES_WITHHOLDING") return null;
  const code = String(field.irisCode == null ? "" : field.irisCode).trim();
  const subcategory = String(field.servicesSubcategory || "").trim();
  const approvedForCategory =
    SERVICES_CONTRACT.approvedServicesMapping?.withholdingBySubcategory?.[subcategory];
  if (!code || !approvedForCategory?.irisCodes?.includes(code)) return null;
  const group = Object.values(SERVICES_CONTRACT.taxDeductions?.groups || {}).find(
    (definition) => definition?.rows?.[code],
  );
  const row = group?.rows?.[code];
  if (!group || !row) return null;
  if (field.portalGroup !== group.label) return null;
  if (field.rowDescriptionIncludes !== row.label) return null;
  if (field.label && normalizeText(field.label) !== normalizeText(row.label)) return null;
  // Picker card text can differ from the persisted IRIS grid-row description.
  // These aliases are capture-backed per-code; the row itself is still verified
  // against `label` after addition, so picker tolerance cannot weaken fill checks.
  const pickerLabels = Array.from(
    new Set([
      row.label,
      ...(Array.isArray(row.pickerLabels) ? row.pickerLabels : []),
    ].map(normalizeText).filter(Boolean)),
  );
  const rowDescriptionLabels = Array.from(
    new Set([
      row.label,
      ...(Array.isArray(row.rowDescriptionAliases) ? row.rowDescriptionAliases : []),
    ].map(normalizeText).filter(Boolean)),
  );
  if (!pickerLabels.length || !rowDescriptionLabels.length) return null;
  return {
    code,
    label: row.label,
    pickerLabels,
    rowDescriptionLabels,
    groupLabel: group.label,
    dialogTitle: `Add ${group.label}`,
    writableInputIndexes: Array.isArray(row.writableInputIndexes)
      ? [...row.writableInputIndexes]
      : [],
  };
}

function pickerProbeTaxDeduction(action, target) {
  if (
    !target ||
    !target.code ||
    !target.label ||
    !Array.isArray(target.pickerLabels) ||
    !target.pickerLabels.length ||
    !Array.isArray(target.rowDescriptionLabels) ||
    !target.rowDescriptionLabels.length ||
    !target.groupLabel ||
    !target.dialogTitle
  )
    return { scope: false, ok: false, reason: "probe_target_missing" };
  const clean = (node) => {
    if (!node) return "";
    const clone = node.cloneNode(true);
    clone.querySelectorAll("mat-icon,script,style").forEach((n) => n.remove());
    return String(clone.textContent || "").replace(/\s+/g, " ").trim();
  };
  const visible = (node) =>
    Boolean(
      node &&
      node.getClientRects().length &&
      getComputedStyle(node).display !== "none" &&
      getComputedStyle(node).visibility !== "hidden",
    );

  const bodies = [
    ...document.querySelectorAll(
      "app-nitr-wf-body .body.interface_21.active, app-nitr-wf-body .active.body",
    ),
  ].filter(visible);
  if (bodies.length !== 1)
    return { scope: false, ok: false, reason: "tax_deduction_body_not_unique" };
  const active = [
    ...bodies[0].querySelectorAll("button.data-tab-left-btn.active"),
  ].filter(visible);
  if (active.length !== 1 || clean(active[0]) !== "Tax Deduction")
    return { scope: false, ok: false, reason: "wrong_business_tab" };

  const dialogs = [
    ...document.querySelectorAll('mat-dialog-container[role="dialog"], mat-dialog-container'),
  ].filter(visible);
  const isOwnPicker = (dialog) => {
    if (!dialog.querySelector("app-add-amount-code-row")) return false;
    const titles = [
      ...dialog.querySelectorAll("h6, .mat-mdc-dialog-title, [mat-dialog-title]"),
    ];
    return titles.some((title) => clean(title) === target.dialogTitle);
  };

  if (action === "cancel") {
    if (!dialogs.length) return { scope: true, ok: true, reason: "picker_not_open" };
    if (dialogs.length !== 1 || !isOwnPicker(dialogs[0]))
      return { scope: true, ok: false, reason: "cancel_target_not_unique" };
    const cancels = [...dialogs[0].querySelectorAll("button")].filter(
      (button) => visible(button) && !button.disabled && /^cancel$/i.test(clean(button)),
    );
    if (cancels.length !== 1)
      return { scope: true, ok: false, reason: "picker_cancel_not_found" };
    cancels[0].click();
    return { scope: true, ok: true, reason: "picker_cancel_clicked" };
  }

  const existingRows = [...bodies[0].querySelectorAll(".tableRows.dataRow[id]")].filter(
    (row) => row.id === target.code,
  );
  if (existingRows.length > 1)
    return { scope: true, ok: false, reason: "duplicate_tax_deduction_row" };

  if (existingRows.length === 1) {
    if (dialogs.length) return { scope: true, ok: false, reason: "dialog_present" };
    const row = existingRows[0];
    const description = row.querySelector(".row-description-text");
    const panel = row.closest("mat-expansion-panel, .mat-expansion-panel");
    const header = panel?.querySelector(
      "mat-expansion-panel-header, .mat-expansion-panel-header",
    );
    const title = header?.querySelector(
      "mat-panel-title, .mat-expansion-panel-header-title",
    );
    if (
      !description ||
      !target.rowDescriptionLabels.includes(clean(description)) ||
      clean(title || header) !== target.groupLabel
    )
      return { scope: true, ok: false, reason: "existing_row_mismatch" };
    const expanded =
      !panel ||
      panel.classList.contains("mat-expanded") ||
      header?.getAttribute("aria-expanded") === "true";
    if (!expanded) {
      header?.click();
      return { scope: true, ok: false, reason: "expanding_existing_row_panel" };
    }
    const inputs = [...row.querySelectorAll(".data-middle-child-wapper")].map((cell) =>
      cell.querySelector('input:not([type="hidden"]), select, textarea'),
    );
    const writable = Array.isArray(target.writableInputIndexes)
      ? target.writableInputIndexes
      : [];
    return {
      scope: true,
      ok:
        writable.length > 0 &&
        writable.every((index) => {
          const input = inputs[index];
          return Boolean(input && !input.disabled && !input.readOnly);
        }),
      reason: "existing_row_checked",
    };
  }

  if (action === "inspect")
    return {
      scope: true,
      ok: false,
      reason: dialogs.length ? "dialog_present" : "row_missing",
    };

  if (action === "open") {
    if (dialogs.length)
      return { scope: true, ok: false, reason: "existing_dialog_not_touched" };
    const panels = [...bodies[0].querySelectorAll("mat-expansion-panel, .mat-expansion-panel")]
      .filter((panel) => {
        const header = panel.querySelector(
          "mat-expansion-panel-header, .mat-expansion-panel-header",
        );
        const title = header?.querySelector(
          "mat-panel-title, .mat-expansion-panel-header-title",
        );
        return clean(title || header) === target.groupLabel;
      });
    if (panels.length !== 1)
      return { scope: true, ok: false, reason: "target_panel_not_unique" };
    const panel = panels[0];
    const header = panel.querySelector(
      "mat-expansion-panel-header, .mat-expansion-panel-header",
    );
    const expanded =
      panel.classList.contains("mat-expanded") ||
      header?.getAttribute("aria-expanded") === "true";
    if (!expanded) {
      header?.click();
      return { scope: true, ok: false, reason: "expanding_target_panel" };
    }
    const buttons = [...panel.querySelectorAll("button")].filter(
      (button) => visible(button) && !button.disabled && clean(button) === "+ Section",
    );
    if (buttons.length !== 1)
      return { scope: true, ok: false, reason: "add_section_button_not_unique" };
    buttons[0].click();
    return { scope: true, ok: true, reason: "picker_open_requested" };
  }

  if (dialogs.length !== 1 || !isOwnPicker(dialogs[0]))
    return { scope: true, ok: false, reason: "picker_not_unique" };

  const cards = [...dialogs[0].querySelectorAll(".source-card")].filter(visible);
  const cardState = (card) => {
    const checkbox = card.querySelector('input[type="checkbox"]');
    return {
      card,
      checkbox,
      label: clean(card),
      checked: Boolean(
        checkbox?.checked || card.classList.contains("source-card--checked"),
      ),
      disabled: Boolean(checkbox?.disabled),
    };
  };
  const states = cards.map(cardState);
  const targets = states.filter((state) => target.pickerLabels.includes(state.label));
  if (targets.length === 0)
    return {
      scope: true,
      ok: false,
      reason: "target_card_label_not_found",
      expectedPickerLabels: target.pickerLabels,
    };
  if (targets.length !== 1)
    return { scope: true, ok: false, reason: "target_card_not_unique" };
  const targetState = targets[0];
  if (!targetState.checkbox)
    return { scope: true, ok: false, reason: "target_card_checkbox_missing" };
  if (targetState.disabled)
    return {
      scope: true,
      ok: false,
      reason: targetState.checked
        ? "target_card_already_present"
        : "target_card_checkbox_disabled",
    };
  if (states.some((state) => state !== targetState && state.checked && !state.disabled))
    return { scope: true, ok: false, reason: "unrelated_card_selected" };

  if (action === "select") {
    const { card: targetCard, checkbox } = targetState;
    if (!targetState.checked) {
      targetCard.scrollIntoView?.({ block: "center" });
      targetCard.click();
      if (!checkbox.checked && !targetCard.classList.contains("source-card--checked")) {
        checkbox.click();
      }
      if (!checkbox.checked && !targetCard.classList.contains("source-card--checked")) {
        const touchTarget =
          targetCard.querySelector(".mat-mdc-checkbox-touch-target") ||
          targetCard.querySelector("label") ||
          targetCard.querySelector("mat-checkbox");
        touchTarget?.click();
      }
      const EventCtor = (document.defaultView && document.defaultView.Event) || Event;
      checkbox.dispatchEvent(new EventCtor("change", { bubbles: true }));
      checkbox.dispatchEvent(new EventCtor("input", { bubbles: true }));
    }
    return checkbox.checked || targetCard.classList.contains("source-card--checked")
      ? {
          scope: true,
          ok: true,
          reason: "target_card_selected",
          selectedPickerLabel: targetState.label,
        }
      : { scope: true, ok: false, reason: "target_card_tick_failed" };
  }

  if (action === "add") {
    if (!targetState.checked)
      return { scope: true, ok: false, reason: "target_card_not_selected" };
    const buttons = [...dialogs[0].querySelectorAll("button")].filter(
      (button) => visible(button) && !button.disabled && clean(button) === "ADD",
    );
    if (buttons.length !== 1)
      return { scope: true, ok: false, reason: "picker_add_not_ready" };
    buttons[0].click();
    return { scope: true, ok: true, reason: "target_card_add_requested" };
  }

  return { scope: true, ok: false, reason: "unsupported_picker_action" };
}

async function ensureTaxDeductionRows(windowInstance, fields, context = {}) {
  if (context.mode !== "live")
    return { ok: false, reason: "dry_run_no_row_creation" };
  const servicesFields = (Array.isArray(fields) ? fields : []).filter(
    (field) => field?.servicesMappingKind === "SERVICES_WITHHOLDING",
  );
  if (!servicesFields.length) return { ok: true, reason: "no_services_fields_to_add" };

  const targetsByCode = new Map();
  for (const field of servicesFields) {
    const target = servicesTaxDeductionTarget(field);
    if (!target)
      return {
        ok: false,
        reason: "services_tax_deduction_target_unverified",
        code: String(field?.irisCode || ""),
      };
    const previous = targetsByCode.get(target.code);
    if (
      previous &&
      (previous.label !== target.label || previous.groupLabel !== target.groupLabel)
    )
      return { ok: false, reason: "services_tax_deduction_target_conflict", code: target.code };
    targetsByCode.set(target.code, target);
  }

  const moved = await navigation.navigateToSection(windowInstance, {
    sectionId: "business_tax_deduction",
    taxYear: context.taxYear,
    taxpayerIdentifier: context.taxpayerIdentifier,
    onStep: context.onStep || (() => {}),
  });
  if (!moved.ok)
    return {
      ok: false,
      reason: `tax_deduction_tab_navigation_failed: ${moved.status || "unknown"}`,
    };

  const wc = windowInstance.webContents;
  const frames = wc.mainFrame
    ? [...(wc.mainFrame.framesInSubtree || [wc.mainFrame])]
    : [wc];
  const attempts = Math.max(1, Number(context.pickerWaitAttempts) || 30);
  const interval = Math.max(1, Number(context.pickerWaitMs) || 150);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (const target of targetsByCode.values()) {
    const run = async (frame, action) => {
      try {
        return await frame.executeJavaScript(
          `(${pickerProbeTaxDeduction.toString()})(${JSON.stringify(action)}, ${JSON.stringify(target)})`,
        );
      } catch {
        return { scope: false, ok: false, reason: "frame_unavailable" };
      }
    };
    const allowed = [];
    for (const frame of frames) {
      const url = frame.url || wc.getURL?.();
      if (!navigation.isAllowedPortalUrl(url)) continue;
      const state = await run(frame, "inspect");
      if (state.scope) allowed.push({ frame, state });
    }
    if (allowed.length !== 1)
      return { ok: false, reason: "tax_deduction_action_frame_not_unique", code: target.code };

    const { frame } = allowed[0];
    let state = allowed[0].state;
    const wait = async (action, transient) => {
      let result;
      for (let i = 0; i < attempts; i++) {
        result = await run(frame, action);
        if (result.ok || !transient.has(result.reason)) return result;
        await sleep(interval);
      }
      return result;
    };
    const cleanup = async () => {
      const cancel = await run(frame, "cancel");
      if (cancel.reason === "picker_not_open")
        return { clicked: false, closed: true, reason: cancel.reason };
      if (!cancel.ok) return { clicked: false, closed: false, reason: cancel.reason };
      for (let i = 0; i < attempts; i++) {
        const after = await run(frame, "inspect");
        if (after.reason !== "dialog_present")
          return { clicked: true, closed: true, reason: cancel.reason };
        await sleep(interval);
      }
      return { clicked: true, closed: false, reason: cancel.reason };
    };
    const fail = async (result) => {
      const cleaned = await cleanup();
      return { ...result, ok: false, code: target.code, cleanup: cleaned };
    };

    if (["expanding_existing_row_panel", "existing_row_checked"].includes(state.reason))
      state = await wait(
        "inspect",
        new Set([
          "expanding_existing_row_panel",
          // IRIS paints the newly added/existing row before enabling its captured
          // amount cells. The row's presence is not proof that it is writable.
          "existing_row_checked",
          "frame_unavailable",
        ]),
      );
    if (state.ok) continue;
    if (state.reason !== "row_missing") return { ...state, code: target.code };

    context.onStep?.(
      "tax_deduction_row_addition_started",
      `Adding row ${target.code} (${target.label}) via ${target.dialogTitle} popup.`,
    );
    const opened = await wait(
      "open",
      new Set(["expanding_target_panel", "frame_unavailable"]),
    );
    if (!opened.ok) return { ...opened, code: target.code };

    const selected = await wait(
      "select",
      new Set([
        "picker_not_unique",
        "target_card_not_unique",
        "target_card_label_not_found",
        "target_card_checkbox_missing",
        "target_card_tick_failed",
        "frame_unavailable",
      ]),
    );
    if (selected.reason === "target_card_already_present") {
      const cleaned = await cleanup();
      const again = cleaned.closed
        ? await wait(
            "inspect",
            new Set([
              "expanding_existing_row_panel",
              "existing_row_checked",
              "frame_unavailable",
            ]),
          )
        : null;
      if (again?.ok) continue;
      return {
        ok: false,
        reason: "target_card_marked_present_but_row_not_visible",
        code: target.code,
        cleanup: cleaned,
      };
    }
    if (!selected.ok) return fail(selected);

    const added = await wait(
      "add",
      new Set(["picker_add_not_ready", "picker_not_unique", "frame_unavailable"]),
    );
    if (!added.ok) return fail(added);

    const checked = await wait(
      "inspect",
      new Set([
        "dialog_present",
        "row_missing",
        "expanding_existing_row_panel",
        // A successfully added row can remain read-only briefly while IRIS
        // recalculates. Wait for the exact captured cells, never bypass them.
        "existing_row_checked",
        "frame_unavailable",
      ]),
    );
    if (!checked.ok) return fail({ ...checked, reason: "added_row_not_confirmed", detail: checked.reason });

    context.onStep?.(
      "tax_deduction_row_added",
      `Row ${target.code} (${target.label}) added successfully to ${target.groupLabel}.`,
    );
  }

  return { ok: true, reason: "tax_deduction_rows_verified" };
}

module.exports = {
  BUILD_TAG,
  PERSONAL_LABEL,
  PICKER_TITLE,
  DEDUCTIONS_TAB,
  DEDUCTION_PICKERS,
  ADMISSIBLE_CARD_CODES,
  deductionTarget,
  ensureDeductionRow,
  ensureDeductionRows,
  ensurePersonalAddbackRow,
  pickerProbe,
  servicesTaxDeductionTarget,
  pickerProbeTaxDeduction,
  ensureTaxDeductionRows,
  summariseOptions,
  changedOptions,
  diffGridRows,
};
