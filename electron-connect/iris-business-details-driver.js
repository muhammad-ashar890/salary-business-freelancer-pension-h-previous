"use strict";
/**
 * DP-2 (Data Push, fix49): adds the taxpayer's business on the IRIS 2.0 top
 * tab "Business Details".
 *
 * Evidence (no guesswork), ~/iris-business-captures, 15-Oct-2026:
 *  - capture 41 / 70: top tab title "Business Details"; body
 *    `app-business-details > .body.business-details-container`; one
 *    `table.business-table` with the headers below; first row "Add Business
 *    Details" with `button.btn-section-add[title="Add Business"]`
 *    ("+ Business"); empty state "No businesses available."; a saved business
 *    is a `tr.business-row` with `td.sr-col`, then name, activity, start date
 *    ("19-Jul-2013"), end date, brand badges (`.brand-badge-label`), edit icon.
 *  - capture 41 / 71: dialog `mat-dialog-container` > `app-add-business-
 *    details`, title "Business Details"; inputs by formcontrolname
 *    businessName (max 100), name = Brand Name (max 100), startDate /
 *    endDate (date pickers); `mat-select[formcontrolname=principalActivity]`;
 *    buttons CLOSE and SAVE (UPDATE when editing).
 *  - capture 55: the Principal Activity panel lists exactly Manufacturing,
 *    Services, Trading, Other (`mat-option` in a `.cdk-overlay-pane`).
 *
 * Rules:
 *  - Clicks only: the "Business Details" and "Data" tab titles, "+ Business",
 *    the Principal Activity list and one of its options, and the dialog's
 *    CLOSE / SAVE. Never the edit icon, a brand "remove" button, Calculate,
 *    the return's Save or Submit.
 *  - Adds a business only when the table is empty. The same business already
 *    listed with the same details = already correct; listed with other
 *    details, or another business listed = reported, nothing changed.
 *  - Dates are typed with an explicit month name to avoid NativeDateAdapter
 *    silently swapping a numeric day and month. Every entry is read back before SAVE.
 *    A typed date is accepted only when
 *    IRIS shows the same date back and the field is valid [CHECK-LIVE: how
 *    IRIS parses a typed date]; after SAVE the table row (month-name dates)
 *    is compared with the plan.
 *  - Anything unexpected closes the dialog with CLOSE; nothing is retried
 *    after a click.
 */

const navigation = require("./iris-navigation");

/** Must equal AGENT_BUILD_TAG in main.js. */
const BUILD_TAG = "pension-wht-64020004-base-20261030b";

const FIX_VERSION = "business-details-unambiguous-v1";

const PRINCIPAL_ACTIVITIES = Object.freeze(["Manufacturing", "Services", "Trading", "Other"]);

const SPEC = Object.freeze({
  tabTitle: "Business Details",
  dialogTitle: "Business Details",
  headers: ["Sr No.", "Business Name", "Principal Activity", "Start Date", "End Date", "Brand Name", "Action"],
  addTitle: "Add Business",
  addLabel: "+ Business",
  inputs: ["businessName", "name", "startDate", "endDate"],
  buttons: ["CLOSE", "SAVE"],
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Runs INSIDE the IRIS page (stringified). One call = one operation = at most
 * one click.
 */
function businessDetailsProbe(request) {
  const op = (request && request.op) || "inspect";
  const spec = request.spec;
  const clean = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  const visible = (el) =>
    Boolean(
      el &&
        el.getClientRects().length &&
        getComputedStyle(el).display !== "none" &&
        getComputedStyle(el).visibility !== "hidden",
    );
  const dialogs = Array.from(document.querySelectorAll("mat-dialog-container")).filter(visible);
  const dialogTitle = (dialog) => {
    const span = dialog.querySelector("[mat-dialog-title] .left, .mat-mdc-dialog-title .left, h6 .left");
    return span ? clean(span.textContent) : "";
  };
  const titles = Array.from(
    document.querySelectorAll("app-nitr-wf-body .custom-tabs > .sticky-tabs-head > .head .title"),
  ).filter(visible);
  const titleNamed = (label) => titles.filter((el) => clean(el.textContent) === label);
  const bodies = Array.from(document.querySelectorAll(".body.business-details-container")).filter(visible);
  const base = {
    scope: titles.length > 0,
    dialogCount: dialogs.length,
    dialogs: dialogs.map(dialogTitle),
    tabTitleCount: titleNamed(spec.tabTitle).length,
    shown: bodies.length === 1,
  };

  if (op === "open" || op === "back") {
    if (dialogs.length) return { ...base, ok: false, reason: "dialog_open_not_touched" };
    const label = op === "open" ? spec.tabTitle : "Data";
    const matches = titleNamed(label);
    if (matches.length !== 1) return { ...base, ok: false, reason: `${op}_tab_title_not_unique` };
    matches[0].click();
    return { ...base, ok: true, reason: `${op}_tab_clicked` };
  }

  if (op === "inspect" || op === "add") {
    if (!base.shown)
      return { ...base, ok: false, reason: bodies.length ? "business_details_body_not_unique" : "business_details_tab_not_shown" };
    const body = bodies[0];
    const problems = [];
    const tables = Array.from(body.querySelectorAll("table.business-table")).filter(visible);
    let headers = [];
    let records = [];
    if (tables.length !== 1) problems.push(`table_count_${tables.length}`);
    else {
      headers = Array.from(tables[0].querySelectorAll("thead th")).map((th) => clean(th.textContent));
      if (JSON.stringify(headers) !== JSON.stringify(spec.headers)) problems.push("headers_differ");
      records = Array.from(tables[0].querySelectorAll("tbody tr.business-row"))
        .filter((tr) => tr.querySelector("td.sr-col"))
        .map((tr) => {
          const cells = Array.from(tr.querySelectorAll(":scope > td"));
          const badges = cells[5]
            ? Array.from(cells[5].querySelectorAll(".brand-badge-label")).map((el) => clean(el.textContent))
            : [];
          return {
            sr: cells[0] ? clean(cells[0].textContent) : "",
            businessName: cells[1] ? clean(cells[1].textContent) : "",
            principalActivity: cells[2] ? clean(cells[2].textContent) : "",
            startDate: cells[3] ? clean(cells[3].textContent) : "",
            endDate: cells[4] ? clean(cells[4].textContent) : "",
            brands: badges.length ? badges : cells[5] ? [clean(cells[5].textContent)].filter(Boolean) : [],
            cellCount: cells.length,
          };
        });
    }
    const addButtons = Array.from(body.querySelectorAll("button.btn-section-add")).filter(
      (button) => visible(button) && button.getAttribute("title") === spec.addTitle && clean(button.textContent) === spec.addLabel,
    );
    if (addButtons.length !== 1) problems.push(`add_button_count_${addButtons.length}`);
    const structureOk = !dialogs.length && problems.length === 0;
    const state = { ...base, ok: structureOk, reason: structureOk ? "structure_verified" : dialogs.length ? "dialog_open" : "structure_differs", problems, headers, records };
    if (op === "inspect") return state;
    if (!structureOk) return { ...state, ok: false };
    if (records.length) return { ...state, ok: false, reason: "table_not_empty" };
    addButtons[0].click();
    return { ...state, ok: true, reason: "add_clicked" };
  }

  // Dialog operations: exactly one visible "Business Details" dialog.
  const mine = dialogs.filter((dialog) => dialogTitle(dialog) === spec.dialogTitle && dialog.querySelector("app-add-business-details"));
  if (mine.length !== 1) return { ...base, ok: false, reason: mine.length ? "dialog_not_unique" : "dialog_not_open" };
  const dialog = mine[0];
  const input = (name) => {
    const found = Array.from(dialog.querySelectorAll(`input[formcontrolname="${name}"]`));
    return found.length === 1 ? found[0] : null;
  };
  const select = () => {
    const found = Array.from(dialog.querySelectorAll('mat-select[formcontrolname="principalActivity"]'));
    return found.length === 1 ? found[0] : null;
  };
  const invalid = (el) => {
    if (!el) return true;
    const field = el.closest("mat-form-field");
    return Boolean(
      (field && field.classList.contains("mat-form-field-invalid")) ||
        (el.classList.contains("ng-invalid") && el.classList.contains("ng-touched")),
    );
  };
  const buttons = Array.from(dialog.querySelectorAll("mat-dialog-actions button, .dialog-footer button"));
  const buttonLabels = buttons.map((button) => clean(button.textContent).toUpperCase());
  const options = () =>
    Array.from(document.querySelectorAll(".cdk-overlay-pane mat-option, .cdk-overlay-pane [role=\"option\"]")).filter(visible);
  const activityText = () => {
    const el = select();
    if (!el) return "";
    const text = el.querySelector(".mat-mdc-select-value-text, .mat-select-value-text");
    return text ? clean(text.textContent) : "";
  };

  if (op === "dialog_state") {
    const fields = {};
    for (const name of spec.inputs) {
      const el = input(name);
      fields[name] = el ? { present: true, value: String(el.value || ""), disabled: Boolean(el.disabled || el.readOnly), invalid: invalid(el) } : { present: false };
    }
    const activity = select();
    return {
      ...base,
      ok: true,
      reason: "dialog_read",
      fields,
      activity: activity ? { present: true, text: activityText(), invalid: invalid(activity) } : { present: false },
      buttons: buttonLabels,
      errors: Array.from(dialog.querySelectorAll("mat-error")).filter(visible).map((el) => clean(el.textContent)).filter(Boolean),
      options: options().map((el) => clean(el.textContent)),
    };
  }

  if (op === "dialog_set") {
    if (!spec.inputs.includes(request.field)) return { ...base, ok: false, reason: "field_not_allowed" };
    const el = input(request.field);
    if (!el) return { ...base, ok: false, reason: "field_not_found" };
    if (el.disabled || el.readOnly) return { ...base, ok: false, reason: "field_disabled" };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    try { el.focus(); } catch (e) {}
    setter.call(el, String(request.value));
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
    el.dispatchEvent(new window.Event("change", { bubbles: true }));
    try { el.blur(); } catch (e) {}
    return { ...base, ok: true, reason: "set", readback: String(el.value || ""), invalid: invalid(el) };
  }

  if (op === "open_activity") {
    const el = select();
    if (!el) return { ...base, ok: false, reason: "activity_list_not_found" };
    if (options().length) return { ...base, ok: false, reason: "a_list_is_already_open" };
    const trigger = el.querySelector(".mat-mdc-select-trigger, .mat-select-trigger") || el;
    trigger.click();
    return { ...base, ok: true, reason: "activity_list_clicked" };
  }

  if (op === "pick_activity") {
    const all = options();
    const texts = all.map((el) => clean(el.textContent));
    if (JSON.stringify([...texts].sort()) !== JSON.stringify([...spec.activities].sort()))
      return { ...base, ok: false, reason: "activity_options_differ", options: texts };
    const matches = all.filter((el) => clean(el.textContent) === request.value);
    if (matches.length !== 1) return { ...base, ok: false, reason: "activity_option_not_unique", options: texts };
    if (matches[0].getAttribute("aria-disabled") === "true") return { ...base, ok: false, reason: "activity_option_disabled" };
    matches[0].click();
    return { ...base, ok: true, reason: "activity_option_clicked", options: texts };
  }

  if (op === "dialog_click") {
    if (!spec.buttons.includes(request.button)) return { ...base, ok: false, reason: "button_not_allowed" };
    const matches = buttons.filter((button) => clean(button.textContent).toUpperCase() === request.button);
    if (matches.length !== 1) return { ...base, ok: false, reason: "button_not_unique" };
    if (matches[0].disabled) return { ...base, ok: false, reason: "button_disabled" };
    matches[0].click();
    return { ...base, ok: true, reason: `${request.button.toLowerCase()}_clicked` };
  }

  return { ...base, ok: false, reason: "unsupported_op" };
}

const PROBE_SPEC = { ...SPEC, activities: PRINCIPAL_ACTIVITIES };

async function findFrame(windowInstance) {
  const wc = windowInstance.webContents;
  const frames = wc.mainFrame ? [...(wc.mainFrame.framesInSubtree || [wc.mainFrame])] : [wc];
  const found = [];
  for (const frame of frames) {
    const url = frame.url || (wc.getURL && wc.getURL());
    if (!navigation.isAllowedPortalUrl(url)) continue;
    try {
      const state = await frame.executeJavaScript(
        `(${businessDetailsProbe.toString()})(${JSON.stringify({ op: "inspect", spec: PROBE_SPEC })})`,
      );
      if (state && state.scope) found.push(frame);
    } catch {
      // A frame that cannot run the probe is not the IRIS return.
    }
  }
  return found.length === 1 ? found[0] : null;
}

const clean = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
const lower = (value) => clean(value).toLowerCase();
const EMPTY_CELL = new Set(["", "-", "--", "n/a", "na"]);

/** Calendar-validated ISO -> unambiguous native DateAdapter input (never DD/MM). */
function unambiguousDateInput(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/** Every way IRIS may show the planned ISO date back; anything else is refused. */
function acceptedDateDisplays(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!match || !unambiguousDateInput(iso)) return [];
  const [y, m, d] = [match[1], Number(match[2]), Number(match[3])];
  const dd = String(d).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const mon = MONTHS[m - 1];
  const month = MONTHS_LONG[m - 1];
  return [
    `${dd}/${mm}/${y}`, `${d}/${m}/${y}`, `${dd}-${mon}-${y}`, `${d}-${mon}-${y}`,
    `${dd} ${mon} ${y}`, `${mon} ${d}, ${y}`, `${month} ${d}, ${y}`, `${y}-${mm}-${dd}`,
  ].map((text) => text.toLowerCase());
}

function planProblems(plan) {
  const problems = [];
  if (!plan || plan.version !== "business-details-v1") return ["no_business_details_plan"];
  if (!clean(plan.businessName) || clean(plan.businessName).length > 100) problems.push("business_name");
  if (!PRINCIPAL_ACTIVITIES.includes(plan.principalActivity)) problems.push("principal_activity");
  if (!clean(plan.brandName) || clean(plan.brandName).length > 100) problems.push("brand_name");
  if (!plan.typed || !/^\d{2}\/\d{2}\/\d{4}$/.test(plan.typed.startDate || "")) problems.push("start_date");
  if (!plan.table || !/^\d{2}-[A-Z][a-z]{2}-\d{4}$/.test(plan.table.startDate || "")) problems.push("start_date_table");
  if (!unambiguousDateInput(plan.startDate) || !acceptedDateDisplays(plan.startDate).includes(lower(plan.table?.startDate))) problems.push("start_date_iso");
  if (plan.endDate && (!unambiguousDateInput(plan.endDate) || !acceptedDateDisplays(plan.endDate).includes(lower(plan.table?.endDate)))) problems.push("end_date_iso");
  if (plan.endDate && !/^\d{2}\/\d{2}\/\d{4}$/.test((plan.typed && plan.typed.endDate) || "")) problems.push("end_date");
  return problems;
}

/** Differences between an IRIS table row and the plan; empty = same business. */
function compareRecord(record, plan) {
  const differences = [];
  if (lower(record.businessName) !== lower(plan.businessName)) differences.push("businessName");
  if (clean(record.principalActivity) !== plan.principalActivity) differences.push("principalActivity");
  if (lower(record.startDate) !== lower(plan.table.startDate)) differences.push("startDate");
  const end = lower(record.endDate);
  if (plan.table.endDate ? end !== lower(plan.table.endDate) : !EMPTY_CELL.has(end)) differences.push("endDate");
  const seenBrands = (record.brands || []).map(lower).sort();
  const plannedBrands = (plan.brands || []).map(lower).sort();
  if (JSON.stringify(seenBrands) !== JSON.stringify(plannedBrands)) differences.push("brands");
  return differences;
}

/**
 * Adds the business on the Business Details tab. Returns
 *   { ok, status, reason, planned, seen?, differences?, problems?, diagnostics }
 * status: filled | already_correct | differs_not_changed | other_business_present
 *         | not_entered | unverified_target | dry_run | saved_differently
 */
async function fillBusinessDetailsTab(windowInstance, plan, context = {}) {
  const started = Date.now();
  const onStep = typeof context.onStep === "function" ? context.onStep : () => {};
  const attempts = Math.max(1, Number(context.attempts) || 40);
  const interval = Math.max(1, Number(context.intervalMs) || 250);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const diagnostics = { fixVersion: FIX_VERSION, steps: [] };
  const step = (action, result) =>
    diagnostics.steps.push({ action, ok: Boolean(result && result.ok), reason: (result && result.reason) || null, atMs: Date.now() - started });
  const planned = plan
    ? {
        businessName: plan.businessName,
        principalActivity: plan.principalActivity,
        brandName: plan.brandName,
        startDate: plan.table && plan.table.startDate,
        endDate: plan.table ? plan.table.endDate : null,
      }
    : null;
  const finish = (status, reason, extra = {}) => ({
    ok: status === "filled" || status === "already_correct",
    status,
    reason,
    planned,
    ...extra,
    diagnostics: { ...diagnostics, ms: Date.now() - started },
  });

  const problems = planProblems(plan);
  if (problems.length) return finish("unverified_target", "plan_incomplete", { problems });
  if (context.mode !== "live") return finish("dry_run", "dry_run_nothing_entered");

  const frame = await findFrame(windowInstance);
  if (!frame) return finish("unverified_target", "business_details_frame_not_unique");
  const run = async (op, extra = {}) => {
    try {
      return await frame.executeJavaScript(
        `(${businessDetailsProbe.toString()})(${JSON.stringify({ op, spec: PROBE_SPEC, ...extra })})`,
      );
    } catch {
      return { ok: false, reason: "frame_unavailable" };
    }
  };
  const waitFor = async (op, accept, extra = {}) => {
    let last;
    for (let i = 0; i < attempts; i += 1) {
      last = await run(op, extra);
      if (accept(last)) return { ok: true, value: last };
      await sleep(interval);
    }
    return { ok: false, value: last };
  };
  const back = async () => {
    const result = await run("back");
    step("back", result);
    return result;
  };
  const abandon = async (reason, extra = {}) => {
    const closed = await run("dialog_click", { button: "CLOSE" });
    step("close", closed);
    const gone = await waitFor("inspect", (state) => !state.dialogCount);
    if (!gone.ok) {
      onStep("real_autofill_business_details_dialog_left_open", `Business Details: the dialog did not close after CLOSE (${reason}).`);
      return finish("not_entered", reason, { ...extra, dialogLeftOpen: true });
    }
    await back();
    onStep("real_autofill_business_details_not_entered", `Business Details: ${reason}; the dialog was closed and nothing was saved.`);
    return finish("not_entered", reason, extra);
  };

  let state = await run("inspect");
  step("inspect", state);
  if (state.dialogCount) return finish("unverified_target", "dialog_open");
  if (!state.shown) {
    const opened = await run("open");
    step("open", opened);
    if (!opened.ok) return finish("unverified_target", opened.reason);
  }
  // Structure verified twice in a row before anything is clicked.
  let stable = 0;
  for (let i = 0; i < attempts && stable < 2; i += 1) {
    state = await run("inspect");
    stable = state.ok ? stable + 1 : 0;
    if (stable < 2) await sleep(interval);
  }
  step("verify", state);
  if (stable < 2) {
    await back();
    return finish("unverified_target", state.reason || "structure_unverified", { problems: state.problems || [] });
  }
  const records = state.records || [];
  const same = records.filter((record) => lower(record.businessName) === lower(plan.businessName));
  if (same.length > 1) {
    await back();
    return finish("differs_not_changed", "business_listed_twice", { seen: same });
  }
  if (same.length === 1) {
    const differences = compareRecord(same[0], plan);
    await back();
    if (!differences.length) {
      onStep("real_autofill_business_details_done", `Business Details: "${plan.businessName}" is already listed with the same details; nothing clicked.`);
      return finish("already_correct", "business_already_listed", { seen: same[0] });
    }
    onStep("real_autofill_business_details_differs", `Business Details: "${plan.businessName}" is already listed with other ${differences.join(", ")}; nothing changed (the agent never edits a saved business).`);
    return finish("differs_not_changed", "business_listed_with_other_details", { seen: same[0], differences });
  }
  if (records.length) {
    await back();
    onStep("real_autofill_business_details_other", `Business Details: another business ("${records.map((record) => record.businessName).join('", "')}") is already listed; nothing added.`);
    return finish("other_business_present", "another_business_is_listed", { seen: records });
  }

  if (context.verifyOnly === true) {
    await back();
    return finish("not_entered", "business_not_listed_on_readback");
  }

  const added = await run("add");
  step("add", added);
  if (!added.ok) {
    await back();
    return finish("unverified_target", added.reason);
  }
  const shown = await waitFor("dialog_state", (s) => s.ok);
  if (!shown.ok) return finish("not_entered", "dialog_not_shown", { dialogLeftOpen: Boolean(shown.value && shown.value.dialogCount) });
  const form = shown.value;
  const missing = SPEC.inputs.filter((name) => !form.fields[name] || !form.fields[name].present);
  if (missing.length || !form.activity.present || JSON.stringify(form.buttons) !== JSON.stringify(SPEC.buttons))
    return abandon("dialog_differs_from_capture", { problems: [...missing, ...(form.activity.present ? [] : ["principalActivity"]), `buttons:${form.buttons.join("/")}`] });
  const prefilled = SPEC.inputs.filter((name) => form.fields[name].value);
  if (prefilled.length || form.activity.text)
    return abandon("dialog_opened_with_values", { problems: prefilled });

  const typeText = async (field, value) => {
    const set = await run("dialog_set", { field, value });
    step(`set_${field}`, set);
    if (!set.ok) return set.reason;
    if (clean(set.readback) !== clean(value)) return "readback_differs";
    return null;
  };
  let failure = await typeText("businessName", plan.businessName);
  if (failure) return abandon(`business_name_${failure}`);

  const listOpened = await run("open_activity");
  step("open_activity", listOpened);
  if (!listOpened.ok) return abandon(listOpened.reason);
  const listed = await waitFor("dialog_state", (s) => s.ok && s.options.length > 0);
  if (!listed.ok) return abandon("activity_list_did_not_open");
  const picked = await run("pick_activity", { value: plan.principalActivity });
  step("pick_activity", picked);
  if (!picked.ok) return abandon(picked.reason, { problems: picked.options || [] });
  const chosen = await waitFor("dialog_state", (s) => s.ok && s.activity.text === plan.principalActivity && !s.options.length);
  if (!chosen.ok) return abandon("activity_not_shown_after_pick");

  failure = await typeText("name", plan.brandName);
  if (failure) return abandon(`brand_name_${failure}`);

  const typeDate = async (field, iso) => {
    const value = unambiguousDateInput(iso);
    if (!value) return { failure: "invalid_iso_date" };
    const set = await run("dialog_set", { field, value });
    step(`set_${field}`, set);
    if (!set.ok) return { failure: set.reason };
    await sleep(Math.max(interval, 200));
    const read = await run("dialog_state");
    const seen = read.ok && read.fields[field] ? read.fields[field] : { value: "", invalid: true };
    if (seen.invalid) return { failure: "not_accepted_by_iris", seen: seen.value };
    if (!acceptedDateDisplays(iso).includes(lower(seen.value))) return { failure: "shown_differently", seen: seen.value };
    return { failure: null, seen: seen.value };
  };
  const start = await typeDate("startDate", plan.startDate);
  if (start.failure) return abandon(`start_date_${start.failure}`, { seen: { startDate: start.seen } });
  if (plan.endDate) {
    const end = await typeDate("endDate", plan.endDate);
    if (end.failure) return abandon(`end_date_${end.failure}`, { seen: { endDate: end.seen } });
  }

  const ready = await run("dialog_state");
  step("before_save", ready);
  const invalidFields = ready.ok
    ? [...SPEC.inputs.filter((name) => ready.fields[name].invalid && (name !== "endDate" || plan.endDate)), ...(ready.activity.invalid ? ["principalActivity"] : [])]
    : ["dialog"];
  if (!ready.ok || invalidFields.length || ready.errors.length)
    return abandon("form_not_valid_before_save", { problems: [...invalidFields, ...(ready.errors || [])] });
  if (
    clean(ready.fields.businessName.value) !== clean(plan.businessName) ||
    clean(ready.fields.name.value) !== clean(plan.brandName) ||
    ready.activity.text !== plan.principalActivity ||
    !acceptedDateDisplays(plan.startDate).includes(lower(ready.fields.startDate.value)) ||
    (plan.endDate && !acceptedDateDisplays(plan.endDate).includes(lower(ready.fields.endDate.value))) ||
    (!plan.endDate && ready.fields.endDate.value)
  )
    return abandon("form_changed_before_save");

  const saved = await run("dialog_click", { button: "SAVE" });
  step("save", saved);
  if (!saved.ok) return abandon(`save_${saved.reason}`);
  const closed = await waitFor("inspect", (s) => !s.dialogCount && s.shown);
  if (!closed.ok) {
    const after = await run("dialog_state");
    return abandon("save_not_accepted", { problems: (after && after.errors) || [] });
  }
  const listedAfter = await waitFor("inspect", (s) => s.ok && (s.records || []).some((record) => lower(record.businessName) === lower(plan.businessName)));
  const record = listedAfter.ok
    ? listedAfter.value.records.find((entry) => lower(entry.businessName) === lower(plan.businessName))
    : null;
  await back();
  if (!record) {
    onStep("real_autofill_business_details_problem", "Business Details: SAVE was pressed but the business is not in the table; check the tab in FBR.");
    return finish("saved_differently", "business_not_listed_after_save");
  }
  const differences = compareRecord(record, plan);
  if (differences.length) {
    onStep("real_autofill_business_details_problem", `Business Details: saved, but IRIS shows other ${differences.join(", ")} (start date "${record.startDate}"). Correct it in FBR; the agent never edits a saved business.`);
    return finish("saved_differently", "saved_with_other_details", { seen: record, differences });
  }
  onStep("real_autofill_business_details_done", `Business Details: added "${plan.businessName}" (${plan.principalActivity}, brand ${plan.brandName}, start ${record.startDate}); read back from the IRIS table.`);
  return finish("filled", "business_added", { seen: record });
}

/** One line for the log / report. */
function describeBusinessDetailsOutcome(outcome) {
  if (!outcome) return "Business Details: not attempted.";
  const text = {
    filled: "added and read back from the IRIS table",
    already_correct: "already listed with the same details (nothing clicked)",
    differs_not_changed: "already listed with other details; nothing changed",
    other_business_present: "another business is listed; nothing added",
    not_entered: "not entered (dialog closed, nothing saved)",
    unverified_target: "not entered (tab did not match the capture)",
    saved_differently: "saved, but IRIS shows other details; check the tab",
    dry_run: "dry run, nothing entered",
  }[outcome.status] || outcome.status;
  return `Business Details: ${text} [${outcome.reason}].`;
}

module.exports = {
  BUILD_TAG,
  FIX_VERSION,
  SPEC,
  PRINCIPAL_ACTIVITIES,
  businessDetailsProbe,
  acceptedDateDisplays,
  unambiguousDateInput,
  compareRecord,
  planProblems,
  fillBusinessDetailsTab,
  describeBusinessDetailsOutcome,
};
