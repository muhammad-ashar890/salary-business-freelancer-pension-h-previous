"use strict";

/**
 * Business Balance Sheet driver (DP-2, fix49; properties fix55): bank
 * accounts (row 3320), motor vehicles (row 3304), and business land /
 * building properties (rows 3301 / 3302).
 *
 * All four are computed summary rows in IRIS. Each account / vehicle /
 * property is a CHILD row that only exists after its dialog:
 *
 *   3320 "Bank Account"     purple icon #add-balance-sheet-bank-account
 *                           -> dialog "Bank Account": IBAN -> search -> IRIS
 *                              fills Account Title + Bank Name -> ADD
 *                           -> child row "Bank Account - <IBAN> - <title> - <bank> - Self"
 *   3304 "Motor Vehicle(s)" purple icon #add-balance-sheet-motor-vehicle
 *                           -> dialog "Motor Vehicle": Registration*, Chassis,
 *                              Make*, Model* -> ADD
 *                           -> child row "Motor Vehicle(s) - <reg> - <chassis> - <make> - <model>"
 *   3301 "Land (Business)" / 3302 "Building (Business)"
 *                           -> "+ Property" (title "Select Property")
 *                           -> dialog "Select Property": an exact existing
 *                              `.property-card` is chosen when present;
 *                              otherwise "Add Property"
 *                           -> dialog "Property Information": type*, sub-type*,
 *                              acquisition date, area unit*, land area*,
 *                              acquisition cost, province*, district*, city*,
 *                              property no.*, sector/mohalla/block* -> Save
 *                           -> after Save the driver accepts either the child
 *                              row appearing directly or the Select Property
 *                              dialog returning with the exact new card, which
 *                              it then chooses once
 *                           -> child row "<Land|Building> (Business) -
 *                              <sub-type>, <area> <unit>, <property no>,
 *                              <sector>, <city>, <district>, <province>"
 *
 * The amount is then typed into the child row's one editable cell by the
 * verified row filler (single-column match, readback, overwrite guard).
 *
 * Evidence [PROVEN]: IRIS 2.0 captures of 15-Oct-2026 in
 * ~/iris-balance-sheet-popups ("balance sheet visible fields", "3320 popup",
 * "3304 popup"): row ids/classes, icon ids and titles, dialog titles,
 * placeholders, maxlengths, button labels, and the child-row texts after ADD.
 * Property evidence: Balance Sheet captures 62 / 63 / 65 and the Land /
 * Building Property Information captures supplied 19-Oct-2026 (summary rows
 * 3301 / 3302 with "+ Property", both dialog titles, every form-control name,
 * the captured type / sub-type / area-unit / province option text, searchable
 * district panels, and the two existing 3302 child rows). The Select Property
 * CSS in those captures proves `.property-card` is the clickable candidate;
 * no capture shows the instant after Save, so the driver accepts only the
 * two outcomes above and reports anything else instead of guessing.
 *
 * HARD LIMITS:
 *   - Page operations can click ONLY: the purple add icon with one of the two
 *     ids above on the 3320 / 3304 summary row, the search icon inside the
 *     "Bank Account" dialog, that dialog's ADD / CLOSE button; and for
 *     properties the exact "+ Property" button on 3301 / 3302, one exact
 *     `.property-card`, "Add Property", the six captured Property Information
 *     selects and one exact option in each, that dialog's Save button, and
 *     the two property dialogs' title close icons. Never the orange edit or
 *     red delete icon, a property swap icon, the "Joint Account" / "Foreign
 *     Currency/Others" checkboxes, or the return's Save / Submit / Calculate.
 *   - A dialog that opens with a box already ticked (or, for Property
 *     Information, with any value already present), an IBAN IRIS cannot
 *     resolve, a field that does not read back, or a child row that does not
 *     appear STOPS that item; the dialog is closed. Nothing is guessed and a
 *     click that was dispatched is never repeated blindly: dropdown search
 *     may be re-read only while no option click has happened.
 *   - An existing child row for the same IBAN / registration / property
 *     description is reused (the row filler then confirms or refuses to
 *     overwrite its amount); two such rows are reported as ambiguous and
 *     left alone.
 *   - Dry mode never clicks inside the page; it only reads and reports.
 */

const BUILD_TAG = "pension-wht-64020004-base-20261030b";

const SECTION_ID = "business_balance_sheet";

const KINDS = Object.freeze({
  bank: Object.freeze({
    rowId: "3320",
    iconId: "add-balance-sheet-bank-account",
    title: "Bank Account",
  }),
  vehicle: Object.freeze({
    rowId: "3304",
    iconId: "add-balance-sheet-motor-vehicle",
    title: "Motor Vehicle",
  }),
});

const PROPERTY_ROWS = Object.freeze({
  land: Object.freeze({ rowId: "3301", label: "Land (Business)" }),
  building: Object.freeze({ rowId: "3302", label: "Building (Business)" }),
});

/** Property Information mat-select form controls [PROVEN from the captures]. */
const PROPERTY_SELECT_FIELDS = Object.freeze({
  propertyType: "propertyId",
  propertySubType: "propertySubTypeId",
  areaUnit: "measurementUnit",
  province: "provinceId",
  district: "divisionId",
  city: "cityId",
});

/** Property Information text inputs by form control; land area is by label. */
const PROPERTY_INPUT_FIELDS = Object.freeze({
  acquisitionDate: "dateOfPurchase",
  acquisitionCost: "declaredCost",
  propertyNo: "address",
  sectorMohallaBlock: "areaId",
  landArea: null,
});

const PROPERTY_FIELD_LIMITS = Object.freeze({
  propertyType: 80,
  propertySubType: 80,
  areaUnit: 40,
  province: 80,
  district: 80,
  city: 80,
  acquisitionDate: 10,
  landArea: 8,
  acquisitionCost: 16,
  propertyNo: 200,
  sectorMohallaBlock: 200,
});

const PROPERTY_DIALOG_TITLES = Object.freeze([
  "Select Property",
  "Property Information",
]);

/** Dialog inputs by placeholder [PROVEN, popups 3320 / 3304]. */
const FIELD_PLACEHOLDERS = Object.freeze({
  bank: Object.freeze({ iban: Object.freeze(["IBAN", "IBAN/Mobile Wallet No. *"]) }),
  vehicle: Object.freeze({
    registrationNo: "Vehicle Registration No.",
    chassisNo: "Chassis No",
    make: "Make",
    model: "Model",
  }),
});

const FIELD_LIMITS = Object.freeze({
  iban: 24,
  registrationNo: 15,
  chassisNo: 20,
  make: 50,
  model: 50,
});

/** The only page operations that exist. Anything else is refused in Node. */
const PAGE_OPS = Object.freeze([
  "inspect",
  "open_add",
  "dialog_set",
  "dialog_search",
  "dialog_state",
  "dialog_click",
  "property_open_select",
  "property_select_state",
  "property_choose_card",
  "property_click_add",
  "property_form_state",
  "property_open_dropdown",
  "property_choose_option",
  "property_set_input",
  "property_click_save",
  "property_close_dialog",
]);

const DIALOG_BUTTONS = Object.freeze(["ADD", "CLOSE"]);

/** Statuses this module adds on top of the row filler's. None is a success. */
const BALANCE_STATUS = Object.freeze({
  SETUP_FAILED: "balance_setup_failed",
  SECTION_UNAVAILABLE: "balance_section_unavailable",
  /** Dry run: the dialog step that would create this child row was not done. */
  DRY_ROW_MISSING: "balance_row_missing_dry_run",
  /** Two child rows already carry this IBAN / registration. */
  AMBIGUOUS_ROW: "balance_row_ambiguous",
  /** IRIS did not resolve the IBAN: a data problem for the taxpayer. */
  IBAN_NOT_RESOLVED: "balance_iban_not_resolved",
  UNSUPPORTED: "balance_unsupported_item",
});

const TRANSIENT_NAVIGATION = new Set([
  "document_not_open",
  "section_not_settled",
  "page_busy",
]);
const NAVIGATION_ATTEMPTS = 4;
const NAVIGATION_RETRY_MS = 1500;

const PAGE_CFG = Object.freeze({
  rowSelector: ".tableRows.dataRow[id]",
  cellSelector: ".data-middle-child-wapper",
  descriptionSelector: ".row-description-text",
  kinds: KINDS,
  placeholders: FIELD_PLACEHOLDERS,
  propertyRows: PROPERTY_ROWS,
  propertySelectFields: PROPERTY_SELECT_FIELDS,
  propertyInputFields: PROPERTY_INPUT_FIELDS,
  propertyDialogTitles: PROPERTY_DIALOG_TITLES,
});

/**
 * Runs INSIDE the IRIS page (stringified and sent through executeJavaScript),
 * so it must not touch any Node-side variable. One call = one operation = at
 * most one click.
 */
function balancePageOp(step) {
  const CFG = step.cfg;
  const norm = (v) =>
    String(v == null ? "" : v)
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hidden) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  };
  const rowsById = (id) =>
    Array.from(document.querySelectorAll(CFG.rowSelector)).filter(
      (row) => row.id === String(id),
    );
  const descOf = (row) => {
    const el = row.querySelector(CFG.descriptionSelector);
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  };
  const inputsOf = (row) =>
    Array.from(
      row.querySelectorAll(CFG.cellSelector + ' input:not([type="hidden"])'),
    );
  const isEditable = (el) => Boolean(el) && !el.disabled && !el.readOnly;
  const rowEditable = (row) => inputsOf(row).some(isEditable);
  const dialogs = () =>
    Array.from(document.querySelectorAll("mat-dialog-container")).filter(visible);
  const dialogTitle = (dialog) => {
    const span = dialog.querySelector(
      "[mat-dialog-title] .left, .mat-mdc-dialog-title .left, h6 .left",
    );
    if (span) return norm(span.textContent);
    const head = dialog.querySelector("[mat-dialog-title], h6");
    return head ? norm(head.textContent.replace(/close\s*$/i, "")) : "";
  };
  const kind = step.kind ? CFG.kinds[step.kind] : null;
  const findDialog = () => {
    if (!kind) return null;
    const matches = dialogs().filter((dialog) => dialogTitle(dialog) === norm(kind.title));
    return matches.length === 1 ? matches[0] : null;
  };
  const buttonsOf = (dialog) =>
    Array.from(dialog.querySelectorAll("mat-dialog-actions button, .dialog-footer button"));
  const buttonLabel = (button) => norm(button.textContent);
  const inputByPlaceholder = (dialog, placeholder) => {
    const allowed = Array.isArray(placeholder) ? placeholder : [placeholder];
    return Array.from(dialog.querySelectorAll("input")).filter(
      (input) => allowed.includes(input.getAttribute("placeholder") || ""),
    );
  };
  const checkboxState = (dialog, label) => {
    const labels = (Array.isArray(label) ? label : [label]).map(norm);
    const boxes = Array.from(dialog.querySelectorAll("mat-checkbox")).filter(
      (box) => labels.includes(norm(box.textContent)),
    );
    if (boxes.length !== 1) return boxes.length ? "ambiguous" : "absent";
    const input = boxes[0].querySelector('input[type="checkbox"]');
    if (!input) return "absent";
    return input.checked ? "checked" : "unchecked";
  };
  const setNative = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    try {
      el.focus();
    } catch (e) {}
    setter.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
    el.dispatchEvent(new window.Event("change", { bubbles: true }));
    try {
      el.blur();
    } catch (e) {}
  };
  const addEnabled = (dialog) => {
    const add = buttonsOf(dialog).filter((b) => buttonLabel(b) === "add");
    return add.length === 1 && !add[0].disabled;
  };
  const compact = (v) => norm(v).replace(/[^a-z0-9]+/g, "");
  const sameOption = (a, b) => norm(a) === norm(b) || compact(a) === compact(b);
  const dialogByTitle = (title) => {
    const matches = dialogs().filter((dialog) => dialogTitle(dialog) === norm(title));
    return matches.length === 1 ? matches[0] : null;
  };
  const allButtonsOf = (dialog) => Array.from(dialog.querySelectorAll("button"));
  const propertyRow = step.balanceRow ? CFG.propertyRows[step.balanceRow] : null;
  const selectByField = (dialog, field) => {
    const control = (CFG.propertySelectFields || {})[field];
    if (!control) return [];
    return Array.from(
      dialog.querySelectorAll(`mat-select[formcontrolname="${control}"]`),
    );
  };
  const selectText = (select) => {
    const text = select.querySelector(
      ".mat-mdc-select-value-text, .mat-select-value-text",
    );
    return text ? text.textContent.replace(/\s+/g, " ").trim() : "";
  };
  const inputByControl = (dialog, control) =>
    Array.from(dialog.querySelectorAll(`input[formcontrolname="${control}"]`));
  const landAreaInputs = (dialog) => {
    const fields = Array.from(dialog.querySelectorAll("mat-form-field")).filter(
      (field) => {
        const label = field.querySelector("mat-label");
        return label && norm(label.textContent) === "land area";
      },
    );
    return fields.flatMap((field) => Array.from(field.querySelectorAll("input")));
  };
  const propertyInput = (dialog, field) => {
    if (field === "landArea") return landAreaInputs(dialog);
    const control = (CFG.propertyInputFields || {})[field];
    return control ? inputByControl(dialog, control) : [];
  };
  const propertyCards = (dialog) =>
    Array.from(dialog.querySelectorAll(".property-card")).filter(visible);
  const cardState = (card) => {
    const checkbox = card.querySelector('input[type="checkbox"]');
    return {
      text: card.textContent.replace(/\s+/g, " ").trim(),
      checked: Boolean(
        card.classList.contains("property-card--checked") ||
          (checkbox && checkbox.checked),
      ),
      disabled: Boolean(
        card.classList.contains("property-card--disabled") ||
          (checkbox && checkbox.disabled),
      ),
      warn: card.classList.contains("property-card--warn"),
    };
  };
  const cardMatches = (card) => {
    const text = norm(card.textContent);
    const tokens = Array.isArray(step.matchTokens) ? step.matchTokens : [];
    return tokens.length > 0 && tokens.every((token) => text.includes(norm(token)));
  };

  const op = step.op;

  if (op === "inspect") {
    const rows = {};
    for (const code of step.codes || []) {
      rows[code] = rowsById(code).map((row) => {
        const inputs = inputsOf(row);
        const first = inputs[0];
        const purple = Array.from(row.querySelectorAll("mat-icon.btn-purple"));
        const propertyButtons = Array.from(
          row.querySelectorAll('button.btn-section-add[title="Select Property"]'),
        ).filter((button) => norm(button.textContent) === "+ property");
        return {
          description: descOf(row),
          editable: rowEditable(row),
          value: first ? String(first.value || "") : "",
          addIconIds: purple.map((icon) => icon.id || ""),
          propertyButtons: propertyButtons.length,
        };
      });
    }
    return { status: "ok", dialogs: dialogs().map(dialogTitle), rows };
  }

  if (op.startsWith("property_")) {
    if (op === "property_open_select") {
      if (!propertyRow) return { status: "unknown_property_row" };
      if (dialogs().length) return { status: "dialog_already_open" };
      const buttons = [];
      for (const row of rowsById(propertyRow.rowId)) {
        if (rowEditable(row) || norm(descOf(row)) !== norm(propertyRow.label)) continue;
        for (const button of row.querySelectorAll(
          'button.btn-section-add[title="Select Property"]',
        )) {
          if (norm(button.textContent) === "+ property") buttons.push(button);
        }
      }
      if (buttons.length !== 1)
        return {
          status: buttons.length ? "ambiguous_property_button" : "property_button_not_found",
        };
      if (!visible(buttons[0]) || buttons[0].disabled)
        return { status: "property_button_not_clickable" };
      buttons[0].click();
      return { status: "clicked" };
    }

    if (op === "property_close_dialog") {
      if (!CFG.propertyDialogTitles.includes(step.dialogTitle))
        return { status: "unsupported_dialog" };
      const dialog = dialogByTitle(step.dialogTitle);
      if (!dialog) return { status: "dialog_not_open" };
      const icons = Array.from(
        dialog.querySelectorAll(
          "[mat-dialog-title] .right mat-icon, .mat-mdc-dialog-title .right mat-icon, h6 .right mat-icon",
        ),
      ).filter((icon) => norm(icon.textContent) === "close");
      if (icons.length !== 1)
        return { status: icons.length ? "ambiguous_close_icon" : "close_icon_not_found" };
      if (!visible(icons[0])) return { status: "close_icon_hidden" };
      icons[0].click();
      return { status: "clicked" };
    }

    if (op === "property_select_state" || op === "property_choose_card" || op === "property_click_add") {
      const dialog = dialogByTitle("Select Property");
      if (!dialog) return { status: "dialog_not_open" };
      const cards = propertyCards(dialog);
      if (op === "property_select_state") {
        return {
          status: "ok",
          cards: cards.map(cardState),
          buttons: allButtonsOf(dialog).map(buttonLabel).filter(Boolean),
          emptyState: Boolean(dialog.querySelector(".empty-state")),
        };
      }
      if (op === "property_click_add") {
        const buttons = allButtonsOf(dialog).filter(
          (button) => buttonLabel(button) === "add property",
        );
        if (buttons.length !== 1)
          return { status: buttons.length ? "ambiguous_button" : "button_not_found" };
        if (!visible(buttons[0]) || buttons[0].disabled)
          return { status: "button_not_clickable" };
        buttons[0].click();
        return { status: "clicked" };
      }
      const matches = cards.filter(cardMatches);
      if (matches.length !== 1)
        return {
          status: matches.length ? "ambiguous_property_card" : "property_card_not_found",
          cards: cards.map(cardState),
        };
      const state = cardState(matches[0]);
      if (state.warn) return { status: "property_card_incomplete", card: state };
      if (state.checked || state.disabled)
        return { status: "already_selected", card: state };
      matches[0].click();
      return { status: "clicked", card: state };
    }

    const dialog = dialogByTitle("Property Information");
    if (!dialog) return { status: "dialog_not_open" };

    if (op === "property_form_state") {
      const selects = {};
      for (const field of Object.keys(CFG.propertySelectFields)) {
        const found = selectByField(dialog, field);
        selects[field] =
          found.length === 1
            ? {
                present: true,
                text: selectText(found[0]),
                disabled:
                  found[0].getAttribute("aria-disabled") === "true" ||
                  found[0].classList.contains("mat-mdc-select-disabled"),
              }
            : { present: false, count: found.length };
      }
      const inputs = {};
      for (const field of Object.keys(CFG.propertyInputFields)) {
        const found = propertyInput(dialog, field);
        inputs[field] =
          found.length === 1
            ? {
                present: true,
                value: String(found[0].value || ""),
                disabled: Boolean(found[0].disabled || found[0].readOnly),
              }
            : { present: false, count: found.length };
      }
      const saves = allButtonsOf(dialog).filter((button) => buttonLabel(button) === "save");
      return {
        status: "ok",
        selects,
        inputs,
        saveEnabled: saves.length === 1 && !saves[0].disabled,
        saveCount: saves.length,
        errors: Array.from(dialog.querySelectorAll("mat-error"))
          .filter(visible)
          .map((el) => el.textContent.replace(/\s+/g, " ").trim())
          .filter(Boolean),
      };
    }

    if (op === "property_open_dropdown") {
      const found = selectByField(dialog, step.field);
      if (found.length !== 1)
        return { status: found.length ? "ambiguous_select" : "select_not_found" };
      const select = found[0];
      if (
        select.getAttribute("aria-expanded") === "true" &&
        document.querySelector(`#${select.id}-panel`)
      )
        return { status: "already_open" };
      if (
        select.getAttribute("aria-disabled") === "true" ||
        select.classList.contains("mat-mdc-select-disabled")
      )
        return { status: "select_disabled" };
      const trigger =
        select.querySelector(".mat-mdc-select-trigger, .mat-select-trigger") || select;
      trigger.click();
      return { status: "clicked" };
    }

    if (op === "property_choose_option") {
      const found = selectByField(dialog, step.field);
      if (found.length !== 1)
        return { status: found.length ? "ambiguous_select" : "select_not_found" };
      const panel = document.querySelector(`#${found[0].id}-panel`);
      if (!panel || !visible(panel)) return { status: "options_not_open" };
      const enabledOptions = () =>
        Array.from(panel.querySelectorAll('mat-option, [role="option"]')).filter(
          (option) =>
            visible(option) &&
            option.getAttribute("aria-disabled") !== "true" &&
            !option.classList.contains("mdc-list-item--disabled"),
        );
      let options = enabledOptions();
      let matches = options.filter((option) => sameOption(option.textContent, step.value));
      if (matches.length !== 1) {
        const search = panel.querySelector("input.specialSearchSelectField");
        if (search && norm(search.value) !== norm(step.value)) {
          setNative(search, String(step.value));
          return {
            status: "search_set",
            options: options.map((option) => option.textContent.replace(/\s+/g, " ").trim()),
          };
        }
        options = enabledOptions();
        matches = options.filter((option) => sameOption(option.textContent, step.value));
      }
      if (matches.length !== 1)
        return {
          status: matches.length ? "ambiguous_option" : "option_not_found",
          options: options.map((option) => option.textContent.replace(/\s+/g, " ").trim()),
        };
      matches[0].click();
      return { status: "clicked" };
    }

    if (op === "property_set_input") {
      const found = propertyInput(dialog, step.field);
      if (found.length !== 1)
        return { status: found.length ? "ambiguous_field" : "field_not_found" };
      const el = found[0];
      if (el.disabled || el.readOnly) return { status: "field_disabled" };
      setNative(el, String(step.value));
      return { status: "set", readback: String(el.value || "") };
    }

    if (op === "property_click_save") {
      const saves = allButtonsOf(dialog).filter((button) => buttonLabel(button) === "save");
      if (saves.length !== 1)
        return { status: saves.length ? "ambiguous_button" : "button_not_found" };
      if (saves[0].disabled) return { status: "button_disabled" };
      saves[0].click();
      return { status: "clicked" };
    }

    return { status: "unsupported_op" };
  }

  if (!kind) return { status: "unknown_kind" };

  if (op === "open_add") {
    if (dialogs().length) return { status: "dialog_already_open" };
    // The summary row has no editable cell; only it carries the purple add
    // icon. Orange (edit) and red (delete) icons are never touched.
    const icons = [];
    for (const row of rowsById(kind.rowId)) {
      if (rowEditable(row)) continue;
      for (const icon of row.querySelectorAll("mat-icon.btn-purple")) {
        if (icon.id === kind.iconId) icons.push(icon);
      }
    }
    if (icons.length !== 1)
      return { status: icons.length ? "ambiguous_icon" : "add_icon_not_found" };
    if (!visible(icons[0])) return { status: "add_icon_hidden" };
    icons[0].click();
    return { status: "clicked" };
  }

  const dialog = findDialog();
  if (!dialog) return { status: "dialog_not_open" };

  if (op === "dialog_set") {
    const placeholder = (CFG.placeholders[step.kind] || {})[step.field];
    if (!placeholder) return { status: "unsupported_field" };
    const inputs = inputByPlaceholder(dialog, placeholder);
    if (inputs.length !== 1)
      return { status: inputs.length ? "ambiguous_field" : "field_not_found" };
    const el = inputs[0];
    if (el.disabled || el.readOnly) return { status: "field_disabled" };
    setNative(el, String(step.value));
    return { status: "set", readback: String(el.value || "") };
  }

  if (op === "dialog_search") {
    if (step.kind !== "bank") return { status: "unsupported_op" };
    const buttons = Array.from(
      dialog.querySelectorAll(".mat-mdc-form-field-icon-suffix button"),
    ).filter((button) => /search/i.test(button.textContent));
    if (buttons.length !== 1)
      return { status: buttons.length ? "ambiguous_button" : "button_not_found" };
    if (buttons[0].disabled) return { status: "button_disabled" };
    buttons[0].click();
    return { status: "clicked" };
  }

  if (op === "dialog_state") {
    const valueOf = (placeholder) => {
      const inputs = inputByPlaceholder(dialog, placeholder);
      return inputs.length === 1 ? String(inputs[0].value || "") : "";
    };
    const state = { status: "ok", addEnabled: addEnabled(dialog) };
    if (step.kind === "bank") {
      state.iban = valueOf(CFG.placeholders.bank.iban);
      state.accountTitle = valueOf("Account Title");
      state.bankName = valueOf("Bank Name");
      state.joint = checkboxState(dialog, "Joint Account");
      state.foreignCurrency = checkboxState(dialog, ["Foreign Currency/Others", "Foreign Currency Account"]);
    } else {
      const fields = CFG.placeholders.vehicle;
      state.registrationNo = valueOf(fields.registrationNo);
      state.chassisNo = valueOf(fields.chassisNo);
      state.make = valueOf(fields.make);
      state.model = valueOf(fields.model);
    }
    return state;
  }

  if (op === "dialog_click") {
    const wanted = norm(step.button);
    const matches = buttonsOf(dialog).filter((button) => buttonLabel(button) === wanted);
    if (matches.length !== 1)
      return { status: matches.length ? "ambiguous_button" : "button_not_found" };
    if (matches[0].disabled) return { status: "button_disabled" };
    matches[0].click();
    return { status: "clicked" };
  }

  return { status: "unsupported_op" };
}

/** Refuses anything outside the documented click surface BEFORE it reaches the page. */
function assertAllowedStep(step) {
  if (!step || !PAGE_OPS.includes(step.op))
    throw new Error(`balance-sheet driver: operation "${step && step.op}" is not allowed`);
  if (step.op === "inspect") {
    for (const code of step.codes || [])
      if (
        ![
          KINDS.bank.rowId,
          KINDS.vehicle.rowId,
          PROPERTY_ROWS.land.rowId,
          PROPERTY_ROWS.building.rowId,
        ].includes(String(code))
      )
        throw new Error(`balance-sheet driver: row ${code} is not a DP-2 row`);
    return;
  }
  if (String(step.op).startsWith("property_")) {
    if (
      step.op === "property_open_select" &&
      !Object.prototype.hasOwnProperty.call(PROPERTY_ROWS, step.balanceRow)
    )
      throw new Error(`balance-sheet driver: property row "${step.balanceRow}" is not allowed`);
    if (
      step.op === "property_close_dialog" &&
      !PROPERTY_DIALOG_TITLES.includes(String(step.dialogTitle))
    )
      throw new Error(`balance-sheet driver: dialog "${step.dialogTitle}" cannot be closed`);
    if (step.op === "property_choose_card") {
      if (!Array.isArray(step.matchTokens) || !step.matchTokens.length || step.matchTokens.length > 10)
        throw new Error("balance-sheet driver: property card match needs 1-10 text tokens");
      for (const token of step.matchTokens)
        if (typeof token !== "string" || !token.trim() || token.length > 250)
          throw new Error("balance-sheet driver: property card match token is not usable text");
    }
    if (step.op === "property_open_dropdown" || step.op === "property_choose_option") {
      if (!Object.prototype.hasOwnProperty.call(PROPERTY_SELECT_FIELDS, step.field))
        throw new Error(`balance-sheet driver: property select "${step.field}" is not allowed`);
      if (step.op === "property_choose_option") {
        const value = String(step.value == null ? "" : step.value);
        if (!value || value.length > PROPERTY_FIELD_LIMITS[step.field])
          throw new Error(
            `balance-sheet driver: ${step.field} must be 1-${PROPERTY_FIELD_LIMITS[step.field]} characters`,
          );
      }
    }
    if (step.op === "property_set_input") {
      if (!Object.prototype.hasOwnProperty.call(PROPERTY_INPUT_FIELDS, step.field))
        throw new Error(`balance-sheet driver: property field "${step.field}" is not allowed`);
      const value = String(step.value == null ? "" : step.value);
      if (!value || value.length > PROPERTY_FIELD_LIMITS[step.field])
        throw new Error(
          `balance-sheet driver: ${step.field} must be 1-${PROPERTY_FIELD_LIMITS[step.field]} characters`,
        );
      if (step.field === "acquisitionDate" && !/^\d{2}\/\d{2}\/\d{4}$/.test(value))
        throw new Error("balance-sheet driver: acquisitionDate must be DD/MM/YYYY");
      if (step.field === "landArea" && !/^\d+(?:\.\d+)?$/.test(value))
        throw new Error("balance-sheet driver: landArea must be a positive number");
      if (step.field === "acquisitionCost" && !/^\d+$/.test(value))
        throw new Error("balance-sheet driver: acquisitionCost must be whole rupees");
    }
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(KINDS, step.kind))
    throw new Error(`balance-sheet driver: kind "${step.kind}" is not allowed`);
  if (step.op === "dialog_set") {
    if (!Object.prototype.hasOwnProperty.call(FIELD_PLACEHOLDERS[step.kind], step.field))
      throw new Error(`balance-sheet driver: field "${step.field}" is not allowed for ${step.kind}`);
    const value = String(step.value == null ? "" : step.value);
    if (!value || value.length > FIELD_LIMITS[step.field])
      throw new Error(`balance-sheet driver: ${step.field} must be 1-${FIELD_LIMITS[step.field]} characters`);
  }
  if (step.op === "dialog_search" && step.kind !== "bank")
    throw new Error("balance-sheet driver: search exists only in the Bank Account dialog");
  if (step.op === "dialog_click" && !DIALOG_BUTTONS.includes(String(step.button)))
    throw new Error(`balance-sheet driver: button "${step.button}" is not allowed`);
}

function buildPageScript(step) {
  assertAllowedStep(step);
  const payload = JSON.stringify({ ...step, cfg: PAGE_CFG });
  return `(${balancePageOp.toString()})(${payload})`;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normText = (value) =>
  String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** IRIS option text may differ only by spacing/punctuation (Jam Shoro). */
const sameLooseText = (a, b) =>
  normText(a) === normText(b) ||
  normText(a).replace(/[^a-z0-9]+/g, "") ===
    normText(b).replace(/[^a-z0-9]+/g, "");

const irisPropertyDate = (field) => {
  if (field.acquisitionDateIris) return String(field.acquisitionDateIris);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(field.acquisitionDate || ""));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "";
};

/** Child rows of this item: editable rows whose text starts with the planned text. */
function matchingChildRows(rows, field) {
  const needle = normText(field.rowDescriptionIncludes);
  return (rows || []).filter(
    (row) => row.editable && normText(row.description).includes(needle),
  );
}

/** Splits packet entries into what this driver can push and what it cannot. */
function planBalanceWork(fields) {
  const banks = [];
  const vehicles = [];
  const properties = [];
  const unsupported = [];
  for (const field of fields || []) {
    const kind = field && field.kind;
    const textOk =
      typeof field?.rowDescriptionIncludes === "string" &&
      field.rowDescriptionIncludes.trim().length > 0;
    if (kind === "bank" && String(field.irisCode) === KINDS.bank.rowId && textOk && field.iban)
      banks.push(field);
    else if (
      kind === "vehicle" &&
      String(field.irisCode) === KINDS.vehicle.rowId &&
      textOk &&
      field.registrationNo &&
      field.make &&
      field.model
    )
      vehicles.push(field);
    else if (
      kind === "property" &&
      Object.prototype.hasOwnProperty.call(PROPERTY_ROWS, field.balanceRow) &&
      String(field.irisCode) === PROPERTY_ROWS[field.balanceRow].rowId &&
      textOk &&
      field.propertyType &&
      field.propertySubType &&
      field.areaUnit &&
      field.landAreaText &&
      field.province &&
      field.district &&
      field.city &&
      field.propertyNo &&
      field.sectorMohallaBlock
    )
      properties.push(field);
    else unsupported.push(field);
  }
  return { banks, vehicles, properties, unsupported };
}

/**
 * Creates the missing child rows (live) and types the amounts through the
 * row filler. Returns { results, setup }; every packet entry gets exactly one
 * result.
 */
async function runBalanceSheetDriver(windowInstance, fields, options = {}) {
  const {
    mode = "dry",
    navigate,
    fillRows,
    beforeStep = async () => {},
    onStep = () => {},
    sleep = defaultSleep,
    timeoutMs = 10000,
  } = options;
  const live = mode === "live";
  const plan = planBalanceWork(fields);
  const results = [];
  const setup = [];
  const note = (step, detail) => {
    setup.push({ step, detail });
    onStep(`balance_${step}`, detail);
  };
  const tag = (field, extra) => ({
    ...field,
    sourceGroup: "businessFields",
    sectionId: SECTION_ID,
    ...extra,
  });
  const run = async (step) => {
    await beforeStep();
    return windowInstance.webContents.executeJavaScript(buildPageScript(step));
  };
  const waitFor = async (producer, accept) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    do {
      last = await producer();
      if (accept(last)) return { ok: true, value: last };
      await sleep(250);
    } while (Date.now() < deadline);
    return { ok: false, value: last };
  };

  for (const field of plan.unsupported)
    results.push(
      tag(field, { status: BALANCE_STATUS.UNSUPPORTED, setupStatus: "incomplete_packet_entry" }),
    );
  const todo = [...plan.banks, ...plan.vehicles, ...plan.properties];
  if (!todo.length) return { results, setup };

  // Open the Business > Balance Sheet section (bounded retry while IRIS settles).
  let moved;
  for (let attempt = 1; attempt <= NAVIGATION_ATTEMPTS; attempt++) {
    try {
      moved = await navigate(SECTION_ID);
    } catch (error) {
      moved = { ok: false, status: `navigation_error: ${error && error.message}` };
    }
    if (moved && moved.ok) break;
    if (!moved || !TRANSIENT_NAVIGATION.has(moved.status)) break;
    if (attempt < NAVIGATION_ATTEMPTS) await sleep(NAVIGATION_RETRY_MS);
  }
  if (!moved || !moved.ok) {
    note(
      "section_unavailable",
      `Business Balance Sheet could not be opened (${moved && moved.status}); ${todo.length} bank / vehicle / property item(s) left untouched.`,
    );
    for (const field of todo)
      results.push(
        tag(field, {
          status: BALANCE_STATUS.SECTION_UNAVAILABLE,
          setupStatus: moved && moved.status,
        }),
      );
    return { results, setup };
  }
  const codes = [
    KINDS.bank.rowId,
    KINDS.vehicle.rowId,
    PROPERTY_ROWS.land.rowId,
    PROPERTY_ROWS.building.rowId,
  ];
  let seen = await run({ op: "inspect", codes });
  if (seen.dialogs.length) {
    note(
      "unexpected_dialog",
      `A dialog ("${seen.dialogs.join('", "')}") is already open on the Balance Sheet; nothing was clicked.`,
    );
    for (const field of todo)
      results.push(
        tag(field, { status: BALANCE_STATUS.SETUP_FAILED, setupStatus: "unexpected_dialog_open" }),
      );
    return { results, setup };
  }

  // Close a dialog we opened but cannot complete, so the page is left clean.
  const abandon = async (kind) => {
    if (!live) return;
    let clicked;
    try {
      clicked = await run({ op: "dialog_click", kind, button: "CLOSE" });
    } catch (error) {
      note("abandon_failed", `${KINDS[kind].title}: could not be closed (${error && error.message}).`);
      return;
    }
    if (clicked.status !== "clicked") {
      note("abandon_failed", `${KINDS[kind].title}: CLOSE was not pressed (${clicked.status}).`);
      return;
    }
    const closed = await waitFor(
      () => run({ op: "inspect", codes: [] }),
      (state) => !state.dialogs.length,
    );
    if (!closed.ok)
      note("abandon_not_closed", `${KINDS[kind].title}: still showing after CLOSE was pressed.`);
  };

  const openDialog = async (kind) => {
    const opened = await run({ op: "open_add", kind });
    if (opened.status !== "clicked") return `${kind}_icon_${opened.status}`;
    const shown = await waitFor(
      () => run({ op: "dialog_state", kind }),
      (state) => state.status === "ok",
    );
    return shown.ok ? null : `${kind}_dialog_not_shown`;
  };

  const waitForChildRow = async (field) => {
    const appeared = await waitFor(
      () => run({ op: "inspect", codes }),
      (state) =>
        !state.dialogs.length &&
        matchingChildRows(state.rows[field.irisCode], field).length === 1,
    );
    return appeared.ok;
  };

  const propertyTokens = (field) => [
    field.propertySubType,
    `${field.landAreaText} ${field.areaUnit}`,
    field.propertyNo,
    field.sectorMohallaBlock,
    field.city,
    field.district,
    field.province,
  ];

  const closePropertyDialog = async (title) => {
    const clicked = await run({ op: "property_close_dialog", dialogTitle: title });
    if (clicked.status === "dialog_not_open") return true;
    if (clicked.status !== "clicked") {
      note(
        "property_abandon_failed",
        `${title}: its close icon was not pressed (${clicked.status}).`,
      );
      return false;
    }
    const closed = await waitFor(
      () => run({ op: "inspect", codes: [] }),
      (state) => !state.dialogs.includes(normText(title)),
    );
    if (!closed.ok)
      note("property_abandon_not_closed", `${title}: still showing after its close icon was pressed.`);
    return closed.ok;
  };

  const abandonProperty = async () => {
    if (!live) return;
    await closePropertyDialog("Property Information");
    await closePropertyDialog("Select Property");
  };

  async function chooseExistingProperty(field) {
    const state = await run({ op: "property_select_state" });
    if (state.status !== "ok") return { failure: `property_select_${state.status}` };
    const tokens = propertyTokens(field).map(normText);
    const matches = (state.cards || []).filter((card) =>
      tokens.every((token) => normText(card.text).includes(token)),
    );
    if (!matches.length) return { found: false };
    if (matches.length > 1) {
      await abandonProperty();
      return { failure: "property_card_ambiguous" };
    }
    if (matches[0].warn) {
      note(
        "property_card_incomplete",
        `Select Property already shows this property highlighted as incomplete; it was not chosen. Complete its mandatory fields in FBR or correct the property detail.`,
      );
      await abandonProperty();
      return { failure: "property_card_incomplete" };
    }
    const chosen = await run({
      op: "property_choose_card",
      matchTokens: propertyTokens(field),
    });
    if (chosen.status !== "clicked" && chosen.status !== "already_selected") {
      await abandonProperty();
      return { failure: `property_choose_${chosen.status}` };
    }
    if (await waitForChildRow(field)) return { found: true, failure: null };
    const after = await run({ op: "property_select_state" });
    const stillMatches =
      after.status === "ok"
        ? (after.cards || []).filter((card) =>
            tokens.every((token) => normText(card.text).includes(token)),
          )
        : [];
    if (
      stillMatches.length === 1 &&
      (stillMatches[0].checked || stillMatches[0].disabled)
    ) {
      // Some IRIS property pickers apply a checked card when the dialog is
      // closed. Closing is the abandon action in any case; only a child row
      // with the exact planned text counts as success afterwards.
      await closePropertyDialog("Select Property");
      if (await waitForChildRow(field)) return { found: true, failure: null };
    } else {
      await abandonProperty();
    }
    return { failure: "property_selection_not_confirmed" };
  }

  async function choosePropertyDropdown(field, fieldName, value) {
    const opened = await run({
      op: "property_open_dropdown",
      field: fieldName,
    });
    if (opened.status !== "clicked" && opened.status !== "already_open")
      return `property_${fieldName}_open_${opened.status}`;
    const chosen = await waitFor(
      () =>
        run({
          op: "property_choose_option",
          field: fieldName,
          value,
        }),
      (state) => state.status === "clicked",
    );
    if (!chosen.ok) {
      const last = chosen.value || {};
      return `property_${fieldName}_${last.status || "not_chosen"}`;
    }
    const shown = await waitFor(
      () => run({ op: "property_form_state" }),
      (state) =>
        state.status === "ok" &&
        state.selects[fieldName] &&
        sameLooseText(state.selects[fieldName].text, value),
    );
    return shown.ok ? null : `property_${fieldName}_readback_differs`;
  }

  async function setPropertyInput(fieldName, value) {
    if (value === undefined || value === null || String(value) === "") return null;
    const set = await run({
      op: "property_set_input",
      field: fieldName,
      value: String(value),
    });
    if (set.status !== "set") return `property_${fieldName}_${set.status}`;
    const comparable = (entry) =>
      fieldName === "acquisitionCost"
        ? String(entry || "").replace(/[^0-9]/g, "")
        : normText(entry);
    if (comparable(set.readback) !== comparable(value))
      return `property_${fieldName}_readback_differs`;
    const shown = await waitFor(
      () => run({ op: "property_form_state" }),
      (state) =>
        state.status === "ok" &&
        state.inputs[fieldName] &&
        comparable(state.inputs[fieldName].value) === comparable(value),
    );
    return shown.ok ? null : `property_${fieldName}_not_shown`;
  }

  async function addProperty(field) {
    const opened = await run({
      op: "property_open_select",
      balanceRow: field.balanceRow,
    });
    if (opened.status !== "clicked")
      return { failure: `property_open_${opened.status}` };
    const selectShown = await waitFor(
      () => run({ op: "property_select_state" }),
      (state) => state.status === "ok",
    );
    if (!selectShown.ok) return { failure: "property_select_not_shown" };

    const existing = await chooseExistingProperty(field);
    if (existing.failure) return { failure: existing.failure };
    if (existing.found) {
      note(
        "property_selected",
        `Selected existing business property ${field.propertySubType} at ${field.propertyNo}, ${field.city} for ${field.irisCode}.`,
      );
      return { failure: null };
    }

    const addClicked = await run({ op: "property_click_add" });
    if (addClicked.status !== "clicked") {
      await abandonProperty();
      return { failure: `property_add_${addClicked.status}` };
    }
    const formShown = await waitFor(
      () => run({ op: "property_form_state" }),
      (state) => state.status === "ok",
    );
    if (!formShown.ok) {
      await abandonProperty();
      return { failure: "property_form_not_shown" };
    }
    const initial = formShown.value;
    const prefilled = [
      ...Object.values(initial.selects || {}).filter((entry) => entry.text),
      ...Object.values(initial.inputs || {}).filter((entry) => entry.value),
    ];
    if (prefilled.length) {
      note(
        "property_form_prefilled",
        "Property Information opened with values already present; it was closed without overwriting them.",
      );
      await abandonProperty();
      return { failure: "property_form_prefilled" };
    }

    const steps = [
      () => choosePropertyDropdown(field, "propertyType", field.propertyType),
      () => choosePropertyDropdown(field, "propertySubType", field.propertySubType),
      () => setPropertyInput("acquisitionDate", irisPropertyDate(field)),
      () => choosePropertyDropdown(field, "areaUnit", field.areaUnit),
      () => setPropertyInput("landArea", field.landAreaText),
      () =>
        setPropertyInput(
          "acquisitionCost",
          field.acquisitionCost === undefined ? "" : String(field.acquisitionCost),
        ),
      () => choosePropertyDropdown(field, "province", field.province),
      () => choosePropertyDropdown(field, "district", field.district),
      () => choosePropertyDropdown(field, "city", field.city),
      () => setPropertyInput("propertyNo", field.propertyNo),
      () => setPropertyInput("sectorMohallaBlock", field.sectorMohallaBlock),
    ];
    for (const step of steps) {
      const failure = await step();
      if (failure) {
        await abandonProperty();
        return { failure };
      }
    }

    const ready = await waitFor(
      () => run({ op: "property_form_state" }),
      (state) => state.status === "ok" && state.saveEnabled,
    );
    if (!ready.ok) {
      const errors = (ready.value && ready.value.errors) || [];
      note(
        "property_save_disabled",
        `Property Information did not accept ${field.propertySubType} at ${field.propertyNo}, ${field.city} (Save stayed disabled${errors.length ? `: ${errors.join("; ")}` : ""}); closed without saving.`,
      );
      await abandonProperty();
      return { failure: "property_save_disabled" };
    }
    const finalState = ready.value;
    const selectChecks = [
      ["propertyType", field.propertyType],
      ["propertySubType", field.propertySubType],
      ["areaUnit", field.areaUnit],
      ["province", field.province],
      ["district", field.district],
      ["city", field.city],
    ];
    for (const [fieldName, value] of selectChecks) {
      if (!sameLooseText(finalState.selects[fieldName]?.text, value)) {
        await abandonProperty();
        return { failure: `property_${fieldName}_changed_before_save` };
      }
    }

    const saved = await run({ op: "property_click_save" });
    if (saved.status !== "clicked") {
      await abandonProperty();
      return { failure: `property_save_${saved.status}` };
    }
    const outcome = await waitFor(
      () => run({ op: "inspect", codes }),
      (state) => {
        const child =
          matchingChildRows(state.rows[field.irisCode], field).length === 1;
        return (
          (!state.dialogs.length && child) ||
          (state.dialogs.includes("select property") &&
            !state.dialogs.includes("property information"))
        );
      },
    );
    if (outcome.ok && !outcome.value.dialogs.length) {
      note(
        "property_added",
        `Added business property ${field.propertySubType} at ${field.propertyNo}, ${field.city} to ${field.irisCode}.`,
      );
      return { failure: null };
    }
    if (outcome.ok) {
      if (
        matchingChildRows(outcome.value.rows[field.irisCode], field).length === 1
      ) {
        await closePropertyDialog("Select Property");
        if (await waitForChildRow(field)) {
          note(
            "property_added",
            `Added business property ${field.propertySubType} at ${field.propertyNo}, ${field.city} to ${field.irisCode}.`,
          );
          return { failure: null };
        }
      }
      const selected = await chooseExistingProperty(field);
      if (selected.failure) return { failure: selected.failure };
      if (selected.found) {
        note(
          "property_added",
          `Added and selected business property ${field.propertySubType} at ${field.propertyNo}, ${field.city} for ${field.irisCode}.`,
        );
        return { failure: null };
      }
      await abandonProperty();
      return { failure: "property_card_not_found_after_save" };
    }
    const formAfterSave = await run({ op: "property_form_state" });
    const errors =
      formAfterSave.status === "ok" ? formAfterSave.errors || [] : [];
    if (errors.length)
      note(
        "property_save_rejected",
        `IRIS kept Property Information open after Save: ${errors.join("; ")}. The dialog was closed without typing an amount.`,
      );
    await abandonProperty();
    // If IRIS applied the property only as the dialog closed, the exact
    // child row is still the success proof.
    if (await waitForChildRow(field)) return { failure: null };
    return { failure: "property_row_not_created" };
  }

  async function addBank(field) {
    const failed = await openDialog("bank");
    if (failed) return { failure: failed };
    const before = await run({ op: "dialog_state", kind: "bank" });
    if (before.joint !== "unchecked" || before.foreignCurrency !== "unchecked") {
      note(
        "bank_dialog_unexpected",
        `Bank Account dialog opened with Joint Account = ${before.joint}, Foreign Currency = ${before.foreignCurrency}; closed without adding ${field.iban}.`,
      );
      await abandon("bank");
      return { failure: "bank_dialog_checkbox_state" };
    }
    const set = await run({ op: "dialog_set", kind: "bank", field: "iban", value: field.iban });
    if (set.status !== "set" || set.readback.toUpperCase() !== String(field.iban).toUpperCase()) {
      await abandon("bank");
      return { failure: `bank_iban_${set.status === "set" ? "readback_differs" : set.status}` };
    }
    const searched = await run({ op: "dialog_search", kind: "bank" });
    if (searched.status !== "clicked") {
      await abandon("bank");
      return { failure: `bank_search_${searched.status}` };
    }
    const resolved = await waitFor(
      () => run({ op: "dialog_state", kind: "bank" }),
      (state) =>
        state.status === "ok" && state.accountTitle && state.bankName && state.addEnabled,
    );
    if (!resolved.ok) {
      note(
        "bank_iban_unresolved",
        `IRIS did not return an account title for IBAN ${field.iban}; dialog closed, nothing added. Check the IBAN against the bank statement.`,
      );
      await abandon("bank");
      return { failure: "iban_not_resolved", status: BALANCE_STATUS.IBAN_NOT_RESOLVED };
    }
    const state = resolved.value;
    if (
      state.iban.toUpperCase() !== String(field.iban).toUpperCase() ||
      state.joint !== "unchecked" ||
      state.foreignCurrency !== "unchecked"
    ) {
      note(
        "bank_dialog_changed",
        `Bank Account dialog changed before ADD (IBAN "${state.iban}", Joint ${state.joint}, Foreign ${state.foreignCurrency}); closed without adding.`,
      );
      await abandon("bank");
      return { failure: "bank_dialog_changed" };
    }
    const added = await run({ op: "dialog_click", kind: "bank", button: "ADD" });
    if (added.status !== "clicked") {
      await abandon("bank");
      return { failure: `bank_add_${added.status}` };
    }
    if (!(await waitForChildRow(field))) return { failure: "bank_row_not_created" };
    note(
      "bank_added",
      `Added business bank account ${field.iban} (${state.accountTitle}, ${state.bankName}) to 3320.`,
    );
    return { failure: null, seenTitle: state.accountTitle, seenBank: state.bankName };
  }

  async function addVehicle(field) {
    const failed = await openDialog("vehicle");
    if (failed) return { failure: failed };
    const values = [
      ["registrationNo", field.registrationNo],
      ["chassisNo", field.chassisNo || ""],
      ["make", field.make],
      ["model", field.model],
    ].filter(([, value]) => String(value).length > 0);
    for (const [name, value] of values) {
      const set = await run({ op: "dialog_set", kind: "vehicle", field: name, value });
      if (set.status !== "set" || normText(set.readback) !== normText(value)) {
        await abandon("vehicle");
        return {
          failure: `vehicle_${name}_${set.status === "set" ? "readback_differs" : set.status}`,
        };
      }
    }
    const ready = await waitFor(
      () => run({ op: "dialog_state", kind: "vehicle" }),
      (state) => state.status === "ok" && state.addEnabled,
    );
    if (!ready.ok) {
      note(
        "vehicle_add_disabled",
        `Motor Vehicle dialog did not accept ${field.registrationNo} (ADD stayed disabled); closed without adding.`,
      );
      await abandon("vehicle");
      return { failure: "vehicle_add_disabled" };
    }
    const state = ready.value;
    for (const [name, value] of values) {
      if (normText(state[name]) !== normText(value)) {
        await abandon("vehicle");
        return { failure: `vehicle_${name}_changed` };
      }
    }
    const added = await run({ op: "dialog_click", kind: "vehicle", button: "ADD" });
    if (added.status !== "clicked") {
      await abandon("vehicle");
      return { failure: `vehicle_add_${added.status}` };
    }
    if (!(await waitForChildRow(field))) return { failure: "vehicle_row_not_created" };
    note(
      "vehicle_added",
      `Added business vehicle ${field.registrationNo} (${field.make} ${field.model}) to 3304.`,
    );
    return { failure: null };
  }

  const ready = [];
  const extras = new Map();
  let blocked = false;
  for (const field of todo) {
    const existing = matchingChildRows(seen.rows[field.irisCode], field);
    if (existing.length > 1) {
      note(
        "row_ambiguous",
        `${field.irisCode}: ${existing.length} rows already start with "${field.rowDescriptionIncludes}"; left alone.`,
      );
      results.push(tag(field, { status: BALANCE_STATUS.AMBIGUOUS_ROW, rowCount: existing.length }));
      continue;
    }
    if (existing.length === 1) {
      ready.push(field);
      continue;
    }
    if (!live) {
      note(
        "row_would_add",
        `DRY: would add ${field.kind === "bank" ? `bank account ${field.iban}` : field.kind === "vehicle" ? `vehicle ${field.registrationNo}` : `property ${field.propertySubType} at ${field.propertyNo}, ${field.city}`} through its IRIS dialog. Nothing clicked.`,
      );
      results.push(
        tag(field, { status: BALANCE_STATUS.DRY_ROW_MISSING, setupStatus: "child_row_needs_dialog" }),
      );
      continue;
    }
    let outcome;
    try {
      outcome =
        field.kind === "bank"
          ? await addBank(field)
          : field.kind === "vehicle"
            ? await addVehicle(field)
            : await addProperty(field);
    } catch (error) {
      outcome = { failure: `driver_error: ${error && error.message}` };
    }
    if (outcome.failure) {
      results.push(
        tag(field, {
          status: outcome.status || BALANCE_STATUS.SETUP_FAILED,
          setupStatus: outcome.failure,
        }),
      );
      // A failed ADD may have left a dialog behind; nothing else is clicked then.
      const probe = await run({ op: "inspect", codes });
      if (probe.dialogs.length) {
        note(
          "dialog_left_open",
          `A dialog ("${probe.dialogs.join('", "')}") is still open; nothing more is typed or clicked on the Balance Sheet.`,
        );
        blocked = true;
        const index = todo.indexOf(field);
        for (const rest of [...ready, ...todo.slice(index + 1)])
          results.push(
            tag(rest, { status: BALANCE_STATUS.SETUP_FAILED, setupStatus: "dialog_left_open" }),
          );
        ready.length = 0;
        break;
      }
      continue;
    }
    if (outcome.seenTitle)
      extras.set(field.key, { bankTitleSeen: outcome.seenTitle, bankNameSeen: outcome.seenBank });
    ready.push(field);
  }

  if (ready.length && !blocked) {
    const outcome = await fillRows(ready, { dryRun: !live });
    for (const entry of outcome.results || []) {
      const source = ready.find((field) => field.key === entry.key) || {};
      results.push(
        tag(
          { ...entry, kind: source.kind },
          extras.has(entry.key) ? extras.get(entry.key) : {},
        ),
      );
    }
  }
  return { results, setup };
}

module.exports = {
  BUILD_TAG,
  SECTION_ID,
  KINDS,
  PROPERTY_ROWS,
  PROPERTY_SELECT_FIELDS,
  PROPERTY_INPUT_FIELDS,
  FIELD_PLACEHOLDERS,
  PAGE_OPS,
  BALANCE_STATUS,
  assertAllowedStep,
  buildPageScript,
  balancePageOp,
  planBalanceWork,
  matchingChildRows,
  runBalanceSheetDriver,
};
