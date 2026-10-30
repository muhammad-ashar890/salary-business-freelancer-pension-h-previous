"use strict";
/**
 * Phase 2 (fix47): ONE explicit Save of the IRIS return draft, at the end of a
 * run whose typed figures all read back the same after the tab switch
 * (taxpayer decision Q1, 15-Oct-2026). Submit, Calculate, Print, Close and
 * Prepare PSID are never pressed.
 *
 * The Save control is the lower-bar button IRIS 2.0 shows next to Submit
 * (iris-business-captures 02-06, balance-sheet popups):
 *   <button class="... correspondance-lowermenu-bar-item ..."><i class="fa fa-save ..."></i>Save </button>
 * It is clicked only when it is the ONLY such button, visible, enabled and not
 * covered, no dialog is open and IRIS is not busy.
 *
 * What IRIS shows after the click (toast or dialog) is read and logged in
 * IRIS's own words (long digit runs masked). A success dialog with a single
 * OK/Close button is closed; anything else stays on screen for the taxpayer and
 * is reported. [CHECK-LIVE] No capture of the post-Save message exists yet;
 * the first live run records it.
 */
const navigation = require("./iris-navigation");

const BUILD_TAG = "pension-wht-64020004-base-20261030b";

const SAVE_STATUS = Object.freeze({
  /** IRIS showed a success message. */
  SAVED_CONFIRMED: "saved_confirmed",
  /** Save was pressed; IRIS went idle without any message. */
  SAVED_NO_MESSAGE: "saved_no_message",
  /** Save was pressed; IRIS showed a message that is neither success nor error. */
  SAVED_MESSAGE_UNCLASSIFIED: "saved_message_unclassified",
  /** IRIS said it could not save (validation or error wording). */
  SAVE_ERROR_MESSAGE: "save_error_message",
  /** A dialog appeared after Save and is left for the taxpayer. */
  SAVE_DIALOG_OPEN: "save_dialog_open",
  /** IRIS was still busy when the wait ended. */
  SAVE_BUSY_TIMEOUT: "save_busy_timeout",
  /** Save was not pressed (see `reason`). */
  NOT_CLICKED: "not_clicked",
});

/** Statuses after which the draft is treated as saved by the agent. */
const SAVED_STATUSES = new Set([
  SAVE_STATUS.SAVED_CONFIRMED,
  SAVE_STATUS.SAVED_NO_MESSAGE,
  SAVE_STATUS.SAVED_MESSAGE_UNCLASSIFIED,
]);

const ERROR_WORDS =
  /(not\s+saved|error|fail|invalid|required|mandatory|unable|cannot|can't|please\s+(enter|fill|select|provide|add))/i;
const SUCCESS_WORDS = /(saved|success)/i;

function classifySaveMessage(text) {
  const value = String(text || "");
  if (ERROR_WORDS.test(value)) return "error";
  if (SUCCESS_WORDS.test(value)) return "success";
  return "other";
}

/**
 * In-page probe (serialized into the IRIS frame).
 *   op "inspect" | "after": state only, nothing is clicked
 *   op "click": presses Save when every precondition holds
 *   op "dismiss_success": closes ONE success dialog through its single OK/Close
 */
function saveProbe(request) {
  const op = (request && request.op) || "inspect";
  const normalize = (s) =>
    String(s == null ? "" : s)
      .replace(/\s+/g, " ")
      .trim();
  // Long digit runs (CNIC, NTN, IBAN parts) never leave the page.
  const clean = (s) =>
    normalize(s)
      .replace(/\d{5,}/g, (m) => "#".repeat(m.length))
      .slice(0, 300);
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const textOf = (el) => normalize(el.innerText || el.textContent);
  const dialogNodes = Array.from(
    document.querySelectorAll(
      'mat-dialog-container, [role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal.show, .swal2-popup',
    ),
  ).filter(visible);
  const dialogs = dialogNodes.filter(
    (el) => !dialogNodes.some((other) => other !== el && el.contains(other)),
  );
  const buttonsIn = (el) =>
    Array.from(el.querySelectorAll('button, [role="button"]')).filter(visible);
  const dialogInfo = (el) => ({
    text: clean(el.innerText || el.textContent),
    buttons: buttonsIn(el)
      .map(textOf)
      .filter(Boolean)
      .slice(0, 6),
  });
  const toastNodes = Array.from(
    document.querySelectorAll(
      "#toast-container .toast, .toast-message, .ngx-toastr, mat-snack-bar-container, .mat-mdc-snack-bar-container, .p-toast-message, .alert, [role=\"alert\"], [role=\"status\"]",
    ),
  ).filter(visible);
  const toasts = Array.from(
    new Set(
      toastNodes
        .filter((el) => !toastNodes.some((other) => other !== el && other.contains(el)))
        .map((el) => clean(el.innerText || el.textContent))
        .filter(Boolean),
    ),
  ).slice(0, 5);
  const busy = Array.from(
    document.querySelectorAll(
      '[aria-busy="true"], app-global-loader [role="progressbar"], .loading-overlay',
    ),
  ).some(visible);
  const workflow = Boolean(document.querySelector("app-nitr-wf-body"));
  const lowerButtons = Array.from(
    document.querySelectorAll("button.correspondance-lowermenu-bar-item"),
  ).filter(visible);
  const saveButtons = lowerButtons.filter(
    (b) => textOf(b) === "Save" && b.querySelector("i.fa-save"),
  );
  const submitButtons = lowerButtons.filter((b) => textOf(b) === "Submit");
  const reachOf = (el) => {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight)
      return "outside_visible_area";
    const top = document.elementFromPoint(x, y);
    return top && (top === el || el.contains(top)) ? "interactable" : "obstructed";
  };
  const state = () => {
    const save = saveButtons.length === 1 ? saveButtons[0] : null;
    let reach = save ? reachOf(save) : null;
    if (save && reach === "outside_visible_area" && request && request.scroll) {
      // IRIS pages set `scroll-behavior: smooth` (Bootstrap reboot, seen in
      // capture 02): a default scrollIntoView only STARTS an animation, so the
      // button would still read as off-screen. "instant" moves it now.
      save.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      reach = reachOf(save);
    }
    return {
      ok: true,
      workflow,
      busy,
      dialogs: dialogs.map(dialogInfo),
      toasts,
      saveButtons: saveButtons.length,
      submitButtons: submitButtons.length,
      lowerBar: lowerButtons.map(textOf).slice(0, 8),
      save: save
        ? {
            enabled: !save.disabled && save.getAttribute("aria-disabled") !== "true",
            reach,
          }
        : null,
    };
  };
  if (op === "inspect" || op === "after") return state();
  if (op === "click") {
    const s = state();
    if (!s.workflow) return { ...s, clicked: false, reason: "workflow_not_found" };
    if (s.dialogs.length) return { ...s, clicked: false, reason: "dialog_open_before_save" };
    if (s.busy) return { ...s, clicked: false, reason: "busy_before_save" };
    if (s.saveButtons !== 1)
      return {
        ...s,
        clicked: false,
        reason: s.saveButtons ? "save_button_not_unique" : "save_button_not_found",
      };
    if (!s.save.enabled) return { ...s, clicked: false, reason: "save_button_disabled" };
    if (s.save.reach !== "interactable")
      return { ...s, clicked: false, reason: `save_button_${s.save.reach}` };
    saveButtons[0].click();
    return { ...s, clicked: true, reason: "save_clicked" };
  }
  if (op === "dismiss_success") {
    const s = state();
    if (dialogs.length !== 1) return { ...s, dismissed: false, reason: "not_one_dialog" };
    const text = s.dialogs[0].text;
    const errorWords =
      /(not\s+saved|error|fail|invalid|required|mandatory|unable|cannot|can't|please\s+(enter|fill|select|provide|add))/i;
    if (errorWords.test(text) || !/(saved|success)/i.test(text))
      return { ...s, dismissed: false, reason: "not_a_success_message" };
    const buttons = buttonsIn(dialogs[0]);
    if (buttons.length !== 1 || !/^(ok|okay|close|done)$/i.test(textOf(buttons[0])))
      return { ...s, dismissed: false, reason: "not_a_single_ok_button" };
    buttons[0].click();
    return { ...s, dismissed: true, reason: "success_dialog_closed" };
  }
  return { ok: false, status: "unknown_op" };
}

/** One plain sentence for the log and the taxpayer. */
function describeSaveOutcome(outcome) {
  const o = outcome || {};
  if (!o.clicked) return `Save was not pressed: ${o.reason || "no reason recorded"}.`;
  const onScreen = o.dialog && !o.dialog.closed ? " The message is left on screen for you." : "";
  switch (o.status) {
    case SAVE_STATUS.SAVED_CONFIRMED:
      return `IRIS confirmed the Save: "${o.message}"${o.dialog ? (o.dialog.closed ? " (its OK button was pressed)." : ".") : "."}`;
    case SAVE_STATUS.SAVED_NO_MESSAGE:
      return "Save was pressed; IRIS showed no message and is idle. Check that the return is listed under Draft in FBR.";
    case SAVE_STATUS.SAVED_MESSAGE_UNCLASSIFIED:
      return `Save was pressed; IRIS said: "${o.message}".`;
    case SAVE_STATUS.SAVE_ERROR_MESSAGE:
      return `Save was pressed, but IRIS answered: "${o.message}".${onScreen}`;
    case SAVE_STATUS.SAVE_DIALOG_OPEN:
      return `Save was pressed and IRIS opened a dialog: "${o.message}".${onScreen}`;
    case SAVE_STATUS.SAVE_BUSY_TIMEOUT:
      return "Save was pressed, but IRIS was still busy 30 seconds later. Check the FBR window.";
    default:
      return `Save: ${o.status || "unknown"}.`;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Presses Save once and reports what IRIS showed.
 * Returns { status, clicked, reason, message, messages, dialog, at, ms, build }.
 */
async function saveReturnDraft(windowInstance, options = {}) {
  const {
    onStep = () => {},
    hosts = navigation.DEFAULT_HOSTS,
    timeoutMs = 30000,
    pollMs = 250,
    quietMs = 1500,
    busyWaitMs = 10000,
  } = options;
  const started = Date.now();
  const outcome = {
    status: SAVE_STATUS.NOT_CLICKED,
    clicked: false,
    reason: null,
    message: "",
    messages: [],
    dialog: null,
    at: null,
    build: BUILD_TAG,
  };
  const finish = (patch = {}) => ({ ...outcome, ...patch, ms: Date.now() - started });
  const win = typeof windowInstance === "function" ? windowInstance() : windowInstance;
  if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed()))
    return finish({ reason: "window_closed" });
  const wc = win.webContents;
  const frames = wc.mainFrame
    ? Array.from(wc.mainFrame.framesInSubtree || [wc.mainFrame])
    : [wc];
  const run = async (frame, request, gesture = false) => {
    try {
      return await frame.executeJavaScript(
        `(${saveProbe.toString()})(${JSON.stringify(request)})`,
        gesture,
      );
    } catch {
      return { ok: false, status: "frame_unavailable" };
    }
  };
  const candidates = [];
  for (const frame of frames.slice(0, 12)) {
    const url = frame === wc ? wc.getURL() : frame.url;
    if (!navigation.isAllowedPortalUrl(url, hosts)) continue;
    const state = await run(frame, { op: "inspect" });
    if (state && state.ok && state.workflow && state.saveButtons > 0)
      candidates.push({ frame, state });
  }
  if (candidates.length !== 1)
    return finish({
      reason: candidates.length ? "workflow_frame_not_unique" : "save_button_not_found",
    });
  const { frame } = candidates[0];
  let state = candidates[0].state;
  // Let IRIS finish loading/calculating before the click (bounded).
  const busyUntil = Date.now() + busyWaitMs;
  while (state && state.busy && Date.now() < busyUntil) {
    await sleep(pollMs);
    state = await run(frame, { op: "inspect" });
  }
  const baseline = new Set((state && state.toasts) || []);
  const click = await run(frame, { op: "click", scroll: true }, true);
  if (!click || !click.clicked)
    return finish({
      reason: (click && click.reason) || "save_not_clicked",
      lowerBar: (click && click.lowerBar) || (state && state.lowerBar) || [],
    });
  outcome.clicked = true;
  outcome.at = new Date().toISOString();
  onStep(
    "iris_save_clicked",
    "The agent pressed Save in IRIS (the lower-bar Save button). Submit, Calculate and payment were not touched.",
  );
  // Toasts can vanish quickly: every poll is kept.
  const seen = [];
  let dialog = null;
  let sawBusy = false;
  let quietSince = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const after = await run(frame, { op: "after" });
    if (!after || !after.ok) continue;
    for (const text of after.toasts || [])
      if (!baseline.has(text) && !seen.includes(text)) seen.push(text);
    if ((after.dialogs || []).length) {
      dialog = after.dialogs[0];
      break;
    }
    if (after.busy) {
      sawBusy = true;
      quietSince = null;
      continue;
    }
    if (quietSince === null) quietSince = Date.now();
    const quietFor = Date.now() - quietSince;
    if (seen.length && quietFor >= 500) break;
    if (!seen.length && quietFor >= quietMs * 2) break;
  }
  if (dialog) {
    const kind = classifySaveMessage(dialog.text);
    const messages = [...seen, dialog.text];
    if (kind === "success") {
      const dismissed = await run(frame, { op: "dismiss_success" }, true);
      return finish({
        status: SAVE_STATUS.SAVED_CONFIRMED,
        message: dialog.text,
        messages,
        dialog: { ...dialog, closed: Boolean(dismissed && dismissed.dismissed) },
      });
    }
    return finish({
      status: kind === "error" ? SAVE_STATUS.SAVE_ERROR_MESSAGE : SAVE_STATUS.SAVE_DIALOG_OPEN,
      message: dialog.text,
      messages,
      dialog: { ...dialog, closed: false },
    });
  }
  if (seen.length) {
    const kinds = seen.map(classifySaveMessage);
    return finish({
      status: kinds.includes("error")
        ? SAVE_STATUS.SAVE_ERROR_MESSAGE
        : kinds.includes("success")
          ? SAVE_STATUS.SAVED_CONFIRMED
          : SAVE_STATUS.SAVED_MESSAGE_UNCLASSIFIED,
      message: seen.join(" | "),
      messages: seen,
    });
  }
  const last = await run(frame, { op: "after" });
  if (last && last.busy)
    return finish({ status: SAVE_STATUS.SAVE_BUSY_TIMEOUT, reason: "still_busy_after_save" });
  return finish({
    status: SAVE_STATUS.SAVED_NO_MESSAGE,
    reason: sawBusy ? "busy_then_idle_no_message" : "no_message",
  });
}

module.exports = {
  BUILD_TAG,
  SAVE_STATUS,
  SAVED_STATUSES,
  classifySaveMessage,
  describeSaveOutcome,
  saveProbe,
  saveReturnDraft,
};
