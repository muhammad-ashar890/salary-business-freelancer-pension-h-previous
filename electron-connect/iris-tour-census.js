"use strict";
/**
 * Phase 1 (fix46). READ-ONLY census tour of every IRIS tab.
 *
 * Visits every left tab (in every panel: Business, Tax Chargeable / Payments,
 * 116 - Wealth Statement, Employment, Property ... whatever IRIS shows for this
 * return) and every top tab (Data, Amortization, Depreciation, Business
 * Details, Payment, Attachment), and records for each view:
 *   - every row: code, description, each cell's value and editable/disabled,
 *     row icons (e.g. "Edit Property") and section "+ ..." buttons;
 *   - the Auto Calculate switch state (read only, never toggled);
 *   - open dialogs and loading state; time taken.
 *
 * The only clicks are navigation clicks on tab headers, panel headers and
 * left tab buttons (the same controls the section tour uses). It never types,
 * never clicks an amount cell, ADD, Save, Calculate, Submit or any dialog, and
 * stops (without clicking) if a dialog is open.
 *
 * The full census (values included) is written only to the LOCAL log folder by
 * main.js; the job result carries a compact summary.
 */
const navigation = require("./iris-navigation");
const BUILD_TAG = "services-picker-aliases-20261105d";

// IRIS computed totals read at the end of a run. Phase 2 (fix47) compares the
// business/computation rows with the packet's expected figures; the
// withholding and wealth rows are reported as IRIS-only information.
const TOTAL_CODES = Object.freeze([
  "3000", "3029", "3030", "3100", "3129", "3199", "3200", "3238", "3239",
  "3248", "3259", "3270", "3349", "3399", "9000", "9100", "920000", "9200", "9201",
  "9203", "999905", "9231822", "923184", "703000", "703001", "703002",
  "7003", "7019", "7029",
  // Phase 5b: the two halves of the Section 116 equation, so the agent can say
  // which side of a non-zero 703000 is short instead of only that it is short.
  "703003", "7049", "7099",
]);

function censusProbe(request) {
  const op = (request && request.op) || "read";
  const MAX_ROWS = 400;
  const normalize = (s) =>
    String(s == null ? "" : s)
      .replace(/\s+/g, " ")
      .trim();
  const visible = (el) => {
    if (!el || el.closest('[hidden], [inert], [aria-hidden="true"]'))
      return false;
    const content = el.closest(".mat-expansion-panel-content");
    const owningPanel = content && content.closest("mat-expansion-panel");
    const owningHeader =
      owningPanel &&
      owningPanel.querySelector(":scope > mat-expansion-panel-header");
    if (
      owningHeader &&
      !owningHeader.classList.contains("mat-expanded") &&
      owningHeader.getAttribute("aria-expanded") !== "true"
    )
      return false;
    const tab = el.closest(".custom-tabs .body");
    if (
      tab &&
      Array.from(tab.classList).some((name) => /^interface_\d+$/.test(name)) &&
      !tab.classList.contains("active")
    )
      return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.display !== "none" &&
      s.visibility !== "hidden" &&
      Number(s.opacity) !== 0
    );
  };
  const label = (el) => {
    const copy = el.cloneNode(true);
    copy
      .querySelectorAll(
        'mat-icon, .mat-icon, i, svg, input, select, textarea, [aria-hidden="true"]',
      )
      .forEach((n) => n.remove());
    return normalize(copy.textContent || "");
  };
  const dialogNodes = Array.from(
    document.querySelectorAll(
      'mat-dialog-container, [role="dialog"], [aria-modal="true"], .modal.show',
    ),
  ).filter(visible);
  const dialogs = dialogNodes.filter(
    (el) => !dialogNodes.some((other) => other !== el && el.contains(other)),
  );
  const busy = Array.from(
    document.querySelectorAll(
      '[aria-busy="true"], app-global-loader [role="progressbar"], .loading-overlay',
    ),
  ).some(visible);
  const topNodes = Array.from(
    document.querySelectorAll(
      "app-nitr-wf-body .custom-tabs > .sticky-tabs-head > .head .title",
    ),
  ).filter(visible);
  const topTabs = topNodes.map((el) => ({
    label: label(el),
    active: el.classList.contains("active"),
  }));
  const dataBody = document.querySelector(
    "app-nitr-wf-body .body.interface_21.active",
  );
  // Navigation panels are the ones holding left tab buttons (Business, Tax
  // Chargeable / Payments, 116 - Wealth Statement, Employment, Property).
  // Panels inside a view (e.g. Adjustable / Final / Minimum Tax grids on the
  // business Tax Deduction tab, capture 10) are grid panels, not navigation.
  const panelNodes = dataBody
    ? Array.from(dataBody.querySelectorAll("mat-expansion-panel")).filter(
        (panel) => {
          const header = panel.querySelector(":scope > mat-expansion-panel-header");
          return (
            header &&
            visible(header) &&
            panel.querySelector("button.data-tab-left-btn")
          );
        },
      )
    : [];
  const headerOf = (panel) =>
    panel.querySelector(":scope > mat-expansion-panel-header");
  const expanded = (header) =>
    header.classList.contains("mat-expanded") ||
    header.getAttribute("aria-expanded") === "true";
  // Labels are read even inside collapsed panels (presence only); clicking
  // still requires the button to be visible.
  const panels = panelNodes.map((panel) => ({
    label: label(headerOf(panel)),
    expanded: expanded(headerOf(panel)),
    tabs: Array.from(panel.querySelectorAll("button.data-tab-left-btn")).map(
      (b) => ({ label: label(b), active: b.classList.contains("active") }),
    ),
  }));
  const activeTop = (topTabs.find((t) => t.active) || {}).label || null;
  const activeLeftNodes = dataBody
    ? Array.from(
        dataBody.querySelectorAll("button.data-tab-left-btn.active"),
      ).filter(visible)
    : [];
  const activeLeft =
    activeLeftNodes.length === 1 ? label(activeLeftNodes[0]) : null;
  const state = {
    ok: true,
    dialogs: dialogs.map((d) => ({
      agentPicker: Boolean(d.querySelector("app-add-amount-code-row")),
    })),
    busy,
    topTabs,
    panels,
    activeTop,
    activeLeft,
  };

  const viewCensus = () => {
    const bodies = Array.from(
      document.querySelectorAll("app-nitr-wf-body .custom-tabs .body.active"),
    ).filter(visible);
    if (bodies.length !== 1) return { present: false, bodies: bodies.length };
    const body = bodies[0];
    // The switch is styled hidden in IRIS; read its state without visibility.
    const toggles = Array.from(body.querySelectorAll("mat-slide-toggle")).filter(
      (t) => /auto\s*calculat/i.test(t.textContent || "") ||
        /auto\s*calculat/i.test(
          (document.getElementById(
            (t.querySelector('button[role="switch"]') || {}).getAttribute?.(
              "aria-labelledby",
            ) || "",
          ) || {}).textContent || "",
        ),
    );
    const switchEl = toggles.length
      ? toggles[0].querySelector('button[role="switch"]')
      : null;
    const autoCalculate = switchEl
      ? switchEl.getAttribute("aria-checked") === "true"
      : null;
    // Rows of the active view, including rows inside a COLLAPSED grid panel
    // (IRIS keeps only the active view's grid in the DOM; a collapsed panel
    // just hides it). Rows hidden by [hidden] are not part of the view.
    const inCollapsedPanel = (el) => {
      let panel = el.closest("mat-expansion-panel");
      while (panel && body.contains(panel)) {
        const header = panel.querySelector(":scope > mat-expansion-panel-header");
        if (
          header &&
          !header.classList.contains("mat-expanded") &&
          header.getAttribute("aria-expanded") !== "true"
        )
          return true;
        panel = panel.parentElement && panel.parentElement.closest("mat-expansion-panel");
      }
      return false;
    };
    const gridPanels = Array.from(body.querySelectorAll("mat-expansion-panel"))
      .filter((panel) => !panel.querySelector("button.data-tab-left-btn"))
      .map((panel) => {
        const header = panel.querySelector(":scope > mat-expansion-panel-header");
        return {
          label: header ? label(header).slice(0, 120) : "",
          expanded: Boolean(
            header &&
              (header.classList.contains("mat-expanded") ||
                header.getAttribute("aria-expanded") === "true"),
          ),
          rows: panel.querySelectorAll(".tableRows[id]").length,
        };
      });
    const rows = Array.from(body.querySelectorAll(".tableRows[id]"))
      .filter(
        (row) =>
          !row.closest('[hidden], [inert]') &&
          (visible(row) || inCollapsedPanel(row)),
      )
      .slice(0, MAX_ROWS)
      .map((row) => {
        const desc = row.querySelector(".row-description-text");
        // Same cell model as the row filler (one cell per
        // .data-middle-child-wapper, null when a wrapper has no input), so a
        // typed entry's columnIndex points at the same cell here.
        const wrappers = Array.from(
          row.querySelectorAll(".data-middle-child-wapper"),
        );
        const cellOf = (el) =>
          el
            ? { value: normalize(el.value), editable: !el.disabled && !el.readOnly }
            : null;
        const cells = wrappers.length
          ? wrappers.map((w) =>
              cellOf(w.querySelector('input:not([type="hidden"]), select, textarea')),
            )
          : Array.from(
              row.querySelectorAll(
                'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea',
              ),
            )
              .filter((el) => visible(el) || inCollapsedPanel(el))
              .map(cellOf);
        const icons = Array.from(
          new Set(
            Array.from(row.querySelectorAll("[title], [mattooltip]"))
              .map((n) =>
                normalize(n.getAttribute("title") || n.getAttribute("mattooltip")),
              )
              .filter(Boolean),
          ),
        );
        const buttons = Array.from(row.querySelectorAll("button"))
          .filter(visible)
          .map(label)
          .filter(Boolean);
        return {
          code: row.id,
          ...(inCollapsedPanel(row) ? { inCollapsedPanel: true } : {}),
          description: desc
            ? label(desc).slice(0, 200)
            : label(row).slice(0, 120),
          // Exactly what the row filler records as rowDescription.
          descriptionRaw: desc ? normalize(desc.textContent).slice(0, 200) : "",
          cells,
          icons,
          buttons,
        };
      });
    const sectionButtons = Array.from(body.querySelectorAll("button"))
      .filter(visible)
      .map(label)
      .filter((t) => /^\+\s?\S/.test(t));
    const headings = Array.from(
      body.querySelectorAll("h5, h6, th, .wf-col-header, .heading-bar strong"),
    )
      .filter(visible)
      .map(label)
      .filter(Boolean)
      .slice(0, 40);
    const isBlank = (v) => {
      const digits = String(v || "").replace(/[\s,]/g, "");
      return digits === "" || /^0+(\.0+)?$/.test(digits);
    };
    const allCells = rows.flatMap((r) => r.cells).filter(Boolean);
    return {
      present: true,
      bodyClass: Array.from(body.classList)
        .filter((c) => /^interface_\d+$/.test(c))
        .join(" "),
      autoCalculate,
      gridPanels,
      rows,
      sectionButtons,
      headings,
      counts: {
        rows: rows.length,
        cells: allCells.length,
        editable: allCells.filter((c) => c.editable).length,
        prefilled: allCells.filter((c) => !isBlank(c.value)).length,
      },
    };
  };

  if (op === "read") {
    if (request && request.withView) state.view = viewCensus();
    return state;
  }
  // Navigation clicks only, never behind a dialog.
  if (dialogs.length) return { ...state, ok: false, status: "dialog_open" };
  if (op === "click_top") {
    const matches = topNodes.filter((el) => label(el) === request.label);
    if (matches.length !== 1)
      return { ...state, ok: false, status: "top_tab_not_unique" };
    if (matches[0].classList.contains("active"))
      return { ...state, status: "already_active" };
    matches[0].click();
    return { ...state, status: "clicked" };
  }
  if (op === "click_panel") {
    const matches = panelNodes.filter(
      (panel) => label(headerOf(panel)) === request.label,
    );
    if (matches.length !== 1)
      return { ...state, ok: false, status: "panel_not_unique" };
    const header = headerOf(matches[0]);
    if (expanded(header)) return { ...state, status: "already_active" };
    header.click();
    return { ...state, status: "clicked" };
  }
  if (op === "click_left") {
    const panel = panelNodes.filter(
      (p) => label(headerOf(p)) === request.panel,
    );
    if (panel.length !== 1)
      return { ...state, ok: false, status: "panel_not_unique" };
    const matches = Array.from(
      panel[0].querySelectorAll("button.data-tab-left-btn"),
    ).filter((b) => visible(b) && label(b) === request.label);
    if (matches.length !== 1)
      return { ...state, ok: false, status: "left_tab_not_unique" };
    if (matches[0].classList.contains("active"))
      return { ...state, status: "already_active" };
    matches[0].click();
    return { ...state, status: "clicked" };
  }
  return { ...state, ok: false, status: "unsupported_op" };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function digitsOf(value) {
  const raw = String(value == null ? "" : value).replace(/[\s,]/g, "");
  if (raw === "") return "";
  const m = raw.match(/^(-?\d+)(?:\.0+)?$/);
  return m ? String(Number(m[1])) : raw;
}

/**
 * Walk every tab and return { views, complete, stoppedReason, ms, ... }.
 * `options.onStep(step, detail)` logs progress; `options.beforeStep()` runs
 * before every click (job/target guard); a throw aborts the tour safely.
 */
async function runCensusTour(windowInstance, options = {}) {
  const {
    label = "census",
    onStep = () => {},
    beforeStep = async () => {},
    hosts = navigation.DEFAULT_HOSTS,
    settleTimeoutMs = 8000,
    pollMs = 250,
    // Optional narrow readback mode. When supplied, visit only these exact
    // Data-tab views and do not inspect unrelated IRIS sections or top tabs.
    onlyViews = null,
  } = options;
  const requestedViews = Array.isArray(onlyViews)
    ? Array.from(new Set(onlyViews.map((view) => String(view || "").trim()).filter(Boolean)))
    : null;
  const started = Date.now();
  const tour = {
    label,
    build: BUILD_TAG,
    requestedViews,
    startedAt: new Date(started).toISOString(),
    views: [],
    complete: false,
    stoppedReason: null,
    restored: false,
  };
  const finish = () => ({ ...tour, ms: Date.now() - started });
  const win =
    typeof windowInstance === "function" ? windowInstance() : windowInstance;
  if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) {
    tour.stoppedReason = "window_closed";
    return finish();
  }
  const wc = win.webContents;
  const frames = wc.mainFrame
    ? Array.from(wc.mainFrame.framesInSubtree || [wc.mainFrame])
    : [wc];
  const run = async (frame, request) => {
    try {
      return await frame.executeJavaScript(
        `(${censusProbe.toString()})(${JSON.stringify(request)})`,
        request.op !== "read",
      );
    } catch {
      return { ok: false, status: "frame_unavailable" };
    }
  };
  // The IRIS application frame is the one showing the workflow tabs.
  const candidates = [];
  for (const frame of frames.slice(0, 12)) {
    const url = frame === wc ? wc.getURL() : frame.url;
    if (!navigation.isAllowedPortalUrl(url, hosts)) continue;
    const state = await run(frame, { op: "read" });
    if (state && state.ok && (state.topTabs || []).length) candidates.push(frame);
  }
  if (candidates.length !== 1) {
    tour.stoppedReason = candidates.length
      ? "workflow_frame_not_unique"
      : "workflow_tabs_not_found";
    onStep("census_tour_skipped", `${label}: ${tour.stoppedReason}; nothing was clicked.`);
    return finish();
  }
  const frame = candidates[0];
  let state = await run(frame, { op: "read" });
  tour.start = { activeTop: state.activeTop, activeLeft: state.activeLeft };
  if ((state.dialogs || []).length) {
    tour.stoppedReason = "dialog_open";
    onStep("census_tour_skipped", `${label}: a dialog is open; nothing was clicked.`);
    return finish();
  }
  const settle = async (isTarget) => {
    const t0 = Date.now();
    let last = null;
    let stable = 0;
    let previousRows = -1;
    while (Date.now() - t0 <= settleTimeoutMs) {
      last = await run(frame, { op: "read", withView: true });
      if (last && last.ok && !last.busy && isTarget(last) && last.view?.present) {
        const rows = last.view.counts ? last.view.counts.rows : 0;
        stable = rows === previousRows ? stable + 1 : 1;
        previousRows = rows;
        if (stable >= 2) return { ok: true, state: last, ms: Date.now() - t0 };
      } else {
        stable = 0;
        previousRows = -1;
      }
      await delay(pollMs);
    }
    return {
      ok: false,
      state: last,
      ms: Date.now() - t0,
      reason: last?.busy ? "still_loading" : "view_not_confirmed",
    };
  };
  const record = (key, kind, meta, settled, clickStatus) => {
    const view = settled.state?.view || {};
    const entry = {
      key,
      kind,
      ...meta,
      ok: settled.ok,
      reason: settled.ok ? null : settled.reason || clickStatus,
      ms: settled.ms,
      autoCalculate: view.autoCalculate ?? null,
      counts: view.counts || null,
      bodyClass: view.bodyClass || null,
      sectionButtons: view.sectionButtons || [],
      gridPanels: view.gridPanels || [],
      headings: view.headings || [],
      rows: view.rows || [],
      dialogsOpen: (settled.state?.dialogs || []).length,
    };
    tour.views.push(entry);
    onStep(
      "census_view",
      `${label} | ${key}: ${entry.ok ? "read" : `NOT confirmed (${entry.reason})`} in ${entry.ms} ms; ` +
        `${entry.counts ? `${entry.counts.rows} rows, ${entry.counts.editable} editable cells, ${entry.counts.prefilled} cells with a value` : "no grid"}; ` +
        `Auto Calculate ${entry.autoCalculate === null ? "not shown" : entry.autoCalculate ? "ON" : "OFF"}` +
        `${entry.sectionButtons.length ? `; buttons: ${entry.sectionButtons.join(", ")}` : ""}.`,
    );
    return entry;
  };
  const click = async (request) => {
    await beforeStep();
    const out = await run(frame, request);
    return out?.status || "no_result";
  };
  try {
    // 1) Data tab and every left tab in every panel.
    const dataTab = (state.topTabs || []).find((t) => t.label === "Data");
    if (dataTab) {
      const status = await click({ op: "click_top", label: "Data" });
      if (!["clicked", "already_active"].includes(status)) {
        tour.stoppedReason = `data_tab_${status}`;
        return finish();
      }
      await settle((s) => s.activeTop === "Data");
      state = await run(frame, { op: "read" });
    }
    for (const panel of state.panels || []) {
      const tabsToVisit = (panel.tabs || []).filter((tab) => {
        const key = `${panel.label} > ${tab.label}`;
        return !requestedViews || requestedViews.includes(key);
      });
      if (requestedViews && !tabsToVisit.length) continue;
      const opened = await click({ op: "click_panel", label: panel.label });
      if (!["clicked", "already_active"].includes(opened)) {
        tour.views.push({ key: panel.label, kind: "panel", ok: false, reason: `panel_${opened}` });
        onStep("census_view", `${label} | ${panel.label}: panel could not be opened (${opened}).`);
        if (opened === "dialog_open") {
          tour.stoppedReason = "dialog_open";
          return finish();
        }
        continue;
      }
      if (opened === "clicked") await delay(300);
      for (const tab of tabsToVisit) {
        const status = await click({ op: "click_left", panel: panel.label, label: tab.label });
        if (status === "dialog_open") {
          tour.stoppedReason = "dialog_open";
          return finish();
        }
        const settled = ["clicked", "already_active"].includes(status)
          ? await settle((s) => s.activeTop === "Data" && s.activeLeft === tab.label)
          : { ok: false, reason: `left_tab_${status}`, ms: 0, state: null };
        record(`${panel.label} > ${tab.label}`, "left", { panel: panel.label, tab: tab.label }, settled, status);
      }
    }
    // 2) In scoped mode the caller asked for exact Data views only. The broad
    // census continues to visit every other top tab as before.
    for (const top of state.topTabs || []) {
      if (top.label === "Data" || requestedViews) continue;
      const status = await click({ op: "click_top", label: top.label });
      if (status === "dialog_open") {
        tour.stoppedReason = "dialog_open";
        return finish();
      }
      const settled = ["clicked", "already_active"].includes(status)
        ? await settle((s) => s.activeTop === top.label)
        : { ok: false, reason: `top_tab_${status}`, ms: 0, state: null };
      record(`Top: ${top.label}`, "top", { tab: top.label }, settled, status);
    }
    if (requestedViews) {
      const confirmed = new Set(
        tour.views.filter((view) => view.ok).map((view) => view.key),
      );
      const missing = requestedViews.filter((view) => !confirmed.has(view));
      tour.complete = missing.length === 0;
      if (missing.length) tour.stoppedReason = `required_views_not_confirmed: ${missing.join(", ")}`;
    } else {
      tour.complete = true;
    }
  } catch (error) {
    tour.stoppedReason = `aborted: ${error && error.message ? error.message : String(error)}`;
    onStep("census_tour_aborted", `${label}: ${tour.stoppedReason}. Nothing further was clicked.`);
    return finish();
  }
  // 3) Back to where the run was (Data + the starting left tab).
  try {
    if (tour.start.activeTop) await click({ op: "click_top", label: tour.start.activeTop });
    if (tour.start.activeTop === "Data" && tour.start.activeLeft) {
      const panel = (state.panels || []).find((p) =>
        (p.tabs || []).some((t) => t.label === tour.start.activeLeft),
      );
      if (panel) {
        await click({ op: "click_panel", label: panel.label });
        await click({ op: "click_left", panel: panel.label, label: tour.start.activeLeft });
      }
    }
    tour.restored = true;
  } catch {
    tour.restored = false;
  }
  const out = finish();
  onStep(
    "census_tour_done",
    `${label}: ${out.views.length} view(s) read in ${out.ms} ms (${out.views.filter((v) => v.ok).length} confirmed). Nothing was typed, saved, calculated or submitted.`,
  );
  return out;
}

/** Compact per-view summary for the job result (no cell values). */
function summariseTour(tour) {
  if (!tour) return null;
  return {
    label: tour.label,
    complete: Boolean(tour.complete),
    stoppedReason: tour.stoppedReason || null,
    ms: tour.ms || 0,
    views: (tour.views || []).map((v) => ({
      key: v.key,
      ok: Boolean(v.ok),
      reason: v.reason || null,
      ms: v.ms || 0,
      autoCalculate: v.autoCalculate ?? null,
      counts: v.counts || null,
      sectionButtons: v.sectionButtons || [],
      gridPanels: (v.gridPanels || []).map((g) => ({ label: g.label, expanded: g.expanded, rows: g.rows })),
    })),
  };
}

/**
 * IRIS computed totals seen in a tour, every column kept (Phase 2, fix47):
 *   { code: { code, label, view, headings, cells, value } }
 * `headings` are the column titles of the cells (Description/Code dropped);
 * `value` is the first cell IRIS filled. Phase 1 took the first cell even when
 * it was blank, so 9100/9200/920000 (filled only under "Subject to Normal
 * Tax") were logged as blank on the live run of 15-Oct-2026.
 */
function collectTotalsDetailed(tour) {
  const out = {};
  for (const view of tour?.views || []) {
    const cellHeadings = Array.isArray(view.headings) ? view.headings.slice(2) : [];
    for (const row of view.rows || []) {
      const code = String(row.code);
      if (!TOTAL_CODES.includes(code) || Object.hasOwn(out, code)) continue;
      const cells = (row.cells || []).map((cell) => String(cell?.value ?? ""));
      const filled = cells.find((value) => value.trim() !== "");
      out[code] = {
        code,
        label: String(row.description || ""),
        view: view.key || "",
        headings: cellHeadings.slice(0, cells.length),
        cells,
        value: filled ?? "",
      };
    }
  }
  return out;
}

/** IRIS computed totals seen in a tour: { code: first filled value }. */
function collectTotals(tour) {
  const totals = {};
  for (const [code, entry] of Object.entries(collectTotalsDetailed(tour)))
    totals[code] = entry.value;
  return totals;
}

/** "3,200,000" -> 3200000, "(1,000)" or "-1,000" -> -1000, blank -> null. */
function parseIrisAmount(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return /^\(.*\)$/.test(raw) || raw.startsWith("-") ? -value : value;
}

/** The cell of a total that holds `column` ("total" or "normal"). */
function pickTotalColumn(entry, column) {
  const cells = entry?.cells || [];
  const headings = entry?.headings || [];
  if (cells.length <= 1) return cells[0] ?? "";
  if (column === "normal") {
    const index = headings.findIndex((heading) => /normal tax/i.test(heading));
    return cells[index >= 0 ? index : cells.length - 1] ?? "";
  }
  const index = headings.findIndex((heading) => /^total/i.test(String(heading).trim()));
  return cells[index >= 0 ? index : 0] ?? "";
}

/**
 * Phase 2 (fix47): IRIS's computed rows against the packet's expected rows
 * (`snapshot.business.expectedIrisTotals`). A blank IRIS cell counts as 0.
 * Returns { available, version, rows, matched, differs, notSeen, skipped }.
 */
function compareIrisTotals(detailed, expectations) {
  const empty = { available: false, version: null, rows: [], matched: 0, differs: 0, notSeen: 0, skipped: [] };
  if (!expectations || !Array.isArray(expectations.rows)) return empty;
  const rows = expectations.rows.map((expected) => {
    const code = String(expected.code);
    const base = {
      code,
      label: String(expected.label || code),
      column: expected.column === "normal" ? "normal" : "total",
      expected: Math.round(Number(expected.expected) || 0),
      formula: String(expected.formula || ""),
      proven: expected.proven === true,
    };
    const entry = detailed?.[code];
    if (!entry) return { ...base, iris: null, irisNumber: null, status: "not_seen" };
    const text = pickTotalColumn(entry, base.column);
    const parsed = parseIrisAmount(text);
    const status = Math.abs((parsed ?? 0) - base.expected) < 1 ? "match" : "differs";
    return { ...base, iris: text, irisNumber: parsed, status, view: entry.view };
  });
  const count = (status) => rows.filter((row) => row.status === status).length;
  return {
    available: true,
    version: expectations.version || null,
    rows,
    matched: count("match"),
    differs: count("differs"),
    notSeen: count("not_seen"),
    skipped: Array.isArray(expectations.skipped) ? expectations.skipped : [],
  };
}

/**
 * Re-read typed figures from a tour taken AFTER the tab switches (A6).
 * Returns one entry per input entry that was typed or found correct:
 *   { key, irisCode, status: "match" | "mismatch" | "not_seen", afterTabValue, view }
 */
function entryKey(entry) {
  return String(entry?.key || `${String(entry?.irisCode || "")}|${String(entry?.rowDescriptionIncludes || "")}`);
}

function compareTypedEntries(tour, entries) {
  const out = [];
  for (const entry of entries || []) {
    if (!["filled", "already_correct"].includes(entry?.status)) continue;
    if (entry.dryRun) continue;
    const code = String(entry.irisCode || "");
    const planned = digitsOf(entry.readback ?? entry.plannedValue ?? entry.value);
    const description = String(entry.rowDescription || "").replace(/\s+/g, " ").trim();
    const hits = [];
    for (const view of tour?.views || []) {
      // DP-3: an entry that names its census view (e.g. "Business > Tax
      // Deduction") is only looked for there, so the same section code on
      // another tab (Tax Chargeable / Payments > Withholding Tax) is not
      // mistaken for it.
      if (entry.censusView && view.key !== entry.censusView) continue;
      for (const row of view.rows || []) {
        if (String(row.code) !== code) continue;
        if (
          description &&
          (row.description || row.descriptionRaw) &&
          row.description !== description &&
          row.descriptionRaw !== description
        )
          continue;
        hits.push({ view: view.key, row });
      }
    }
    if (hits.length !== 1) {
      out.push({
        key: entryKey(entry),
        irisCode: code,
        status: "not_seen",
        detail: hits.length ? "row_not_unique" : "row_not_seen",
      });
      continue;
    }
    const cells = hits[0].row.cells || [];
    const index = Number.isInteger(entry.columnIndex)
      ? entry.columnIndex
      : cells.length === 1
        ? 0
        : -1;
    const cell = index >= 0 ? cells[index] : null;
    if (!cell) {
      out.push({ key: entryKey(entry), irisCode: code, status: "not_seen", detail: "cell_not_seen", view: hits[0].view });
      continue;
    }
    const seen = digitsOf(cell.value);
    out.push({
      key: entryKey(entry),
      irisCode: code,
      status: seen === planned ? "match" : "mismatch",
      afterTabValue: cell.value,
      expected: planned,
      view: hits[0].view,
    });
  }
  return out;
}

/** Save is eligible only when every entered figure has exactly one matching readback. */
function allEnteredEntriesReadBack(entries, checks) {
  const expected = (entries || []).filter(
    (entry) => ["filled", "already_correct"].includes(entry?.status) && !entry.dryRun,
  );
  const actual = Array.isArray(checks) ? checks : [];
  if (!expected.length || actual.length !== expected.length) return false;
  const expectedKeys = expected.map(entryKey);
  const checkKeys = actual.map((check) => String(check.key || ""));
  if (new Set(checkKeys).size !== checkKeys.length) return false;
  if (expectedKeys.some((key) => !checkKeys.includes(key))) return false;
  return actual.every((check) => check.status === "match");
}

module.exports = {
  BUILD_TAG,
  TOTAL_CODES,
  censusProbe,
  runCensusTour,
  summariseTour,
  collectTotals,
  collectTotalsDetailed,
  compareIrisTotals,
  parseIrisAmount,
  pickTotalColumn,
  compareTypedEntries,
  allEnteredEntriesReadBack,
  digitsOf,
};
