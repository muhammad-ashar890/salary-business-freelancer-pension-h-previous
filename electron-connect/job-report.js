"use strict";

/**
 * Plain-language report for one agent run, written at the top of the job log
 * file. It answers, without reading raw JSON: which screens the agent visited
 * and in what order, where and why it stopped, which TaxRocket buttons were
 * pressed, what value went into which field and who put it there, how
 * employers and the income-source page were handled, and what the agent never
 * does (Calculate, Save, Submit, payment).
 *
 * Pure: no Electron, no file system. Everything comes from the run's own
 * outcome, so the report can never claim something the run did not record.
 */

const { isRetryableExpenseResult } = require("./iris-wealth-driver.js");

const BUILD_TAG = "pension-services-multifiling-20261106a";
const NOISY_STEPS = new Set(["readiness_evidence"]);

function clip(value, max = 300) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clock(iso) {
  const match = /T(\d\d:\d\d:\d\d)/.exec(String(iso || ""));
  return match ? `${match[1]}Z` : "";
}

function money(value) {
  const digits = String(value ?? "").replace(/[^0-9.-]/g, "");
  if (!digits || !Number.isFinite(Number(digits))) return String(value ?? "");
  return Number(digits).toLocaleString("en-US");
}

function describeConfirmations(confirmations) {
  const list = Array.isArray(confirmations) ? confirmations : [];
  if (!list.length) {
    return ["  - none (no TaxRocket button was pressed before this run)"];
  }
  return list.map((entry) => {
    const when = entry?.acknowledgedAt || entry?.confirmedAt || "";
    const text = entry?.acknowledgementText
      ? ` · box ticked: "${clip(entry.acknowledgementText, 400)}"`
      : "";
    return `  - ${entry?.action || "continue"} · Continue pressed ${when}${text}`;
  });
}

function describeIncomeSourcePage(executionLog) {
  const steps = executionLog.filter((entry) =>
    /^(economic_|new_return_setup)/.test(String(entry?.step || "")),
  );
  if (!steps.length) {
    const alreadyOpen = executionLog.some((entry) =>
      /^(real_autofill_workspace_confirmed|document_verified)$/.test(
        String(entry?.step || ""),
      ),
    );
    return [
      alreadyOpen
        ? "  Not shown in this run: the return was already open, so the agent selected no income source and answered no residency question."
        : "  No income-source page step was recorded in this run.",
    ];
  }
  const lines = [];
  for (const entry of steps) {
    const step = String(entry.step);
    let verdict = "";
    if (step === "economic_transactions_setup")
      verdict =
        "AGENT answered the income-source / residency questions from the approved packet. ";
    else if (step === "economic_transactions_start")
      verdict = "AGENT pressed Start Return Filling. ";
    else if (step === "economic_transactions_gate")
      verdict = "AGENT STOPPED and left the page untouched: ";
    else if (step === "economic_gate_wait")
      verdict = "Waited for the page to render: ";
    lines.push(
      `  ${clock(entry.at)} ${step} — ${verdict}${clip(entry.detail)}`,
    );
  }
  return lines;
}

function describeEmployers(autofill) {
  const employers = autofill?.employers;
  if (!employers) return ["  No employer information in this run."];
  const names = Array.isArray(employers.prepared) ? employers.prepared : [];
  if (!names.length)
    return ["  No employer names were in the approved packet; nothing to add."];
  if (employers.confirmedByTaxpayer) {
    return [
      `  ADDED BY YOU in FBR (you pressed Continue in TaxRocket). The agent did not search or check: ${names.join("; ")}`,
    ];
  }
  if (!employers.enabled) {
    return [
      `  NOT added: the agent's employer switch was off or this was a dry run. Names in the packet: ${names.join("; ")}`,
    ];
  }
  const lines = [];
  for (const entry of employers.results || []) {
    const who =
      entry.status === "added"
        ? `ADDED BY THE AGENT${
            entry.registeredName
              ? ` as \"${entry.registeredName}\"${entry.regNo ? ` (registration ${entry.regNo})` : ""}`
              : ""
          }`
        : entry.status === "already_listed"
          ? "ALREADY LISTED in IRIS (agent did nothing)"
          : `NOT ADDED by the agent (${entry.status})`;
    const extra =
      Array.isArray(entry.candidates) && entry.candidates.length
        ? ` · IRIS offered: ${entry.candidates.join(" / ")}`
        : "";
    lines.push(`  ${entry.name} → ${who}${extra}`);
  }
  return lines.length
    ? lines
    : [`  Names: ${names.join("; ")} (no result recorded)`];
}

function describeFields(autofill) {
  const results = Array.isArray(autofill?.results) ? autofill.results : [];
  const taken = (
    Array.isArray(autofill?.takenOver) ? autofill.takenOver : []
  ).map((item) =>
    item.checked
      ? `  ENTERED BY YOU in FBR (confirmed in TaxRocket): ${item.name} - the agent read it back (read-only) and it matches the approved figure`
      : `  ENTERED BY YOU in FBR (confirmed in TaxRocket): ${item.name} - the agent could not check it`,
  );
  // Phase 1 (fix46): the agent only stops for SAFETY/HUMAN reasons; otherwise
  // it carries on and every problem is listed on its own figure.
  const stoppedNote = autofill?.stopped
    ? [
        `  The agent STOPPED (safety) at ${autofill.stopReason?.where || "?"}: ${autofill.stopReason?.status || "?"}. Figures after that point were not attempted in this run.`,
      ]
    : autofill?.reviewRequired &&
        Array.isArray(autofill?.pendingItems) &&
        autofill.pendingItems.length
      ? [
          `  The agent did NOT stop at problems: it carried on and ${autofill.pendingItems.length} item(s) need attention (see FIELD TABLE below).`,
        ]
      : [];
  if (!results.length && !taken.length)
    return ["  No field was attempted in this run."];
  return [
    ...taken,
    ...stoppedNote,
    ...results.map((r) => {
      const planned = money(r.plannedValue ?? r.value);
      const isCash = r.cashDelta !== undefined && r.cashDelta !== null;
      const had =
        isCash && r.baselineValue !== undefined
          ? r.baselineValue
          : r.existingValue;
      const hadText =
        had === null || had === undefined || had === ""
          ? "IRIS cell was empty"
          : `IRIS cell had ${money(had)}`;
      const cashText = isCash
        ? ` · cash movement ${Number(r.cashDelta) >= 0 ? "+" : "-"}${money(Math.abs(Number(r.cashDelta)))} added to IRIS's own figure`
        : "";
      let who;
      if (r.status === "filled") who = "TYPED BY THE AGENT";
      else if (r.status === "already_correct")
        who =
          "ALREADY THERE — the agent typed nothing (entered by you or by an earlier run)";
      else if (r.status === "overwrite_needs_confirmation")
        who =
          "NOT TYPED — IRIS holds a different figure and it is never overwritten";
      else who = `NOT TYPED (${r.status})`;
      const label = r.rowDescription || r.label || "";
      return `  [${r.sectionId || "?"}] ${r.irisCode} ${label} · ${r.requestedColumn || ""} · planned ${planned} · ${hadText}${cashText} → ${who}`;
    }),
  ];
}

function describeWealthSetup(autofill) {
  const setup = Array.isArray(autofill?.wealth?.setup)
    ? autofill.wealth.setup
    : [];
  return setup.map((s) => `  ${s.step}: ${clip(s.detail, 200)}`);
}

function describeReview(autofill, pauseAction) {
  if (pauseAction === "portal_handoff_review")
    return [
      "  The agent opened Personal Assets, the Payment tab and Computations (read-only) and is WAITING for you to review them and press Continue in TaxRocket.",
    ];
  if (autofill?.handoffReviewConfirmed)
    return [
      "  Confirmed by you in TaxRocket (box ticked and Continue pressed). The agent filled none of Property, Payments or Computations.",
    ];
  return ["  Not reached in this run."];
}

// ── Phase 1 (fix46): one line per planned figure ───────────────────────────
// outcome: TYPED / ALREADY_CORRECT / DRY_RUN / CONFLICT / DID_NOT_STAY /
//          REJECTED / INVALID_VALUE / LOCKED / SECTION_NOT_OPENED / NOT_FOUND /
//          NOT_SUPPORTED_YET / CHECK_FAILED / NOT_TYPED_SAFETY / FAILED
// category: OK / DATA (the figure or IRIS's figure needs a decision) /
//           PORTAL (IRIS did not let the agent type; retried) / STRUCTURE (row
//           or column not on the IRIS page) / SCOPE (not automated yet) /
//           SAFETY (wrong or no return/taxpayer, session ended)
const SAFETY_REASONS = new Set([
  "business_session_unavailable",
  "business_document_mismatch",
  "business_document_not_unique",
  "document_not_open",
]);
const SCOPE_REASONS = new Set([
  "unsupported_tax_deduction_scope",
  "code_not_seen_in_section_tour",
  "unsupported_business_reason",
]);

function classifyFieldResult(r) {
  const status = String(r?.status || "");
  const reason = String(r?.sectionStatus || r?.setupStatus || r?.reason || "");
  if (status === "filled")
    return r?.dryRun
      ? { outcome: "DRY_RUN", category: "OK" }
      : { outcome: "TYPED", category: "OK" };
  if (status === "already_correct")
    return { outcome: "ALREADY_CORRECT", category: "OK" };
  if (SAFETY_REASONS.has(reason))
    return { outcome: "NOT_TYPED_SAFETY", category: "SAFETY" };
  if (status === "services_mapping_unverified" || SCOPE_REASONS.has(reason))
    return { outcome: "NOT_SUPPORTED_YET", category: "SCOPE" };
  if (status === "overwrite_needs_confirmation")
    return { outcome: "CONFLICT", category: "DATA" };
  if (status === "readback_mismatch")
    return r?.readbackStage === "after_tab_switch"
      ? { outcome: "DID_NOT_STAY", category: "DATA" }
      : { outcome: "REJECTED", category: "DATA" };
  if (status === "empty_value" || status === "unparseable_amount")
    return { outcome: "INVALID_VALUE", category: "DATA" };
  if (status === "takeover_unconfirmed")
    return { outcome: "CHECK_FAILED", category: "DATA" };
  if (["unverified_target", "no_editable_cell", "column_disabled"].includes(status))
    return { outcome: "LOCKED", category: "PORTAL" };
  if (status === "row_not_found" && reason)
    return { outcome: "SECTION_NOT_OPENED", category: "PORTAL" };
  if (["row_not_found", "row_description_mismatch", "row_group_mismatch", "column_not_found", "ambiguous_row", "missing_code"].includes(status))
    return { outcome: "NOT_FOUND", category: "STRUCTURE" };
  return { outcome: "FAILED", category: reason ? "PORTAL" : "STRUCTURE" };
}

function buildFieldLog(results, options = {}) {
  // Duck-typed (not instanceof): the caller may build its Map in another realm.
  const isMapLike = (m) => Boolean(m) && typeof m.get === "function";
  const fieldsByKey = isMapLike(options.fieldsByKey) ? options.fieldsByKey : new Map();
  const attempts = isMapLike(options.attempts) ? options.attempts : new Map();
  const keyOf =
    typeof options.keyOf === "function"
      ? options.keyOf
      : (entry) => String(entry?.key || `${entry?.irisCode || ""}|${entry?.rowDescriptionIncludes || ""}`);
  return (Array.isArray(results) ? results : []).map((r, index) => {
    const key = keyOf(r);
    const field = fieldsByKey.get(key) || {};
    const { outcome, category } = classifyFieldResult(r);
    const blank = (v) => v === undefined || v === null || v === "";
    const before = !blank(r.existingValue)
      ? r.existingValue
      : !blank(r.previousValue)
        ? r.previousValue
        : !blank(r.baselineValue)
          ? r.baselineValue
          : "";
    return {
      n: index + 1,
      key,
      section: r.sectionId || null,
      code: r.irisCode || field.irisCode || null,
      label: r.rowDescription || r.label || field.label || "",
      column: r.requestedColumn || r.column || field.column || null,
      appValue: field.value ?? r.value ?? r.plannedValue ?? null,
      source:
        [field.ourCategory, field.ourDescription].filter(Boolean).join(" / ") ||
        null,
      irisBefore: before,
      typed: outcome === "TYPED" ? (r.readback ?? r.plannedValue ?? r.value ?? null) : null,
      readbackNow: r.readback ?? null,
      readbackAfterTab: r.afterTabReadback
        ? {
            status: r.afterTabReadback.status,
            value: r.afterTabReadback.afterTabValue ?? null,
            view: r.afterTabReadback.view || null,
          }
        : null,
      outcome,
      category,
      rawStatus: r.status || null,
      reason: r.sectionStatus || r.setupStatus || r.reason || null,
      attempts: attempts.get(key) || 0,
      pass: r.firstPass ? 2 : 1,
      firstPass: r.firstPass || null,
    };
  });
}

function describeFieldTable(autofill) {
  const log = Array.isArray(autofill?.fieldLog) ? autofill.fieldLog : [];
  if (!log.length) return ["  (no per-figure log in this run)"];
  const show = (v) => (v === null || v === undefined || v === "" ? "empty" : money(v));
  return log.map((f) => {
    const after = f.readbackAfterTab
      ? `after tab: ${String(f.readbackAfterTab.status).toUpperCase()}${f.readbackAfterTab.value !== null && f.readbackAfterTab.value !== undefined ? ` (${f.readbackAfterTab.value})` : ""}`
      : "after tab: not checked";
    return (
      `  ${f.n}. [${f.section || "?"}] ${f.code} ${clip(f.label, 70)} · ${f.column || "-"}` +
      ` · app ${show(f.appValue)}${f.source ? ` (${clip(f.source, 60)})` : ""}` +
      ` · IRIS before: ${show(f.irisBefore)}` +
      ` · typed: ${f.typed === null ? "-" : show(f.typed)}` +
      ` · readback: ${f.readbackNow === null ? "-" : show(f.readbackNow)}` +
      ` · ${after}` +
      ` → ${f.outcome} [${f.category}]` +
      ` · attempts ${f.attempts}, pass ${f.pass}` +
      `${f.firstPass ? ` (first pass: ${f.firstPass.status}${f.firstPass.sectionStatus ? `/${f.firstPass.sectionStatus}` : ""})` : ""}` +
      `${f.reason ? ` · reason: ${f.reason}` : ""}`
    );
  });
}

function describeSectionSummary(autofill) {
  const log = Array.isArray(autofill?.fieldLog) ? autofill.fieldLog : [];
  if (!log.length) return [];
  const bySection = new Map();
  for (const f of log) {
    const key = f.section || "(no section)";
    const row = bySection.get(key) || { total: 0, OK: 0, DATA: 0, PORTAL: 0, STRUCTURE: 0, SCOPE: 0, SAFETY: 0 };
    row.total += 1;
    row[f.category] = (row[f.category] || 0) + 1;
    bySection.set(key, row);
  }
  return Array.from(bySection.entries()).map(
    ([section, c]) =>
      `  ${section}: ${c.OK}/${c.total} in IRIS` +
      `${c.DATA ? ` · data ${c.DATA}` : ""}${c.PORTAL ? ` · portal/locked ${c.PORTAL}` : ""}` +
      `${c.STRUCTURE ? ` · row not on page ${c.STRUCTURE}` : ""}${c.SCOPE ? ` · not automated yet ${c.SCOPE}` : ""}` +
      `${c.SAFETY ? ` · safety ${c.SAFETY}` : ""}`,
  );
}

function describeWaits(autofill) {
  const waits = Array.isArray(autofill?.waits) ? autofill.waits : [];
  if (!waits.length) return [];
  const total = waits.reduce((sum, w) => sum + (w.waitedMs || 0), 0);
  return [
    `  ${waits.length} readiness check(s), ${Math.round(total / 100) / 10} s in total:`,
    ...waits.map(
      (w) =>
        `  [${w.sectionId}] pass ${w.pass} ${w.phase}: ${w.ok ? "ready" : `NOT ready (${w.status})`} after ${w.waitedMs} ms` +
        `${(w.trace || []).length ? ` · ${w.trace.map((t) => `${t.reason}@${t.atMs}ms`).join(" > ")}` : ""}`,
    ),
  ];
}

function describePickers(autofill) {
  const pickers = Array.isArray(autofill?.pickers) ? autofill.pickers : [];
  return pickers.map((p) => {
    const d = p.diagnostics || {};
    const o = d.optionsBefore;
    const parts = [
      `  [${p.sectionId}] pass ${p.pass} "${d.picker || "picker"}" → ${p.ok ? "OK" : "NOT OK"}: ${p.reason}`,
    ];
    if (o)
      parts.push(
        `options ${o.total} (already in IRIS, checked+disabled: ${o.checkedDisabled.length}${o.checkedDisabled.length ? ` = ${clip(o.checkedDisabled.join("; "), 160)}` : ""}; ticked but enabled: ${o.checkedEnabled.length})`,
      );
    if (Array.isArray(d.changedOptions))
      parts.push(`changed by agent: ${d.changedOptions.join(", ") || "none"}`);
    if (Array.isArray(d.unrelated) && d.unrelated.length)
      parts.push(`unrequested ticks left alone: ${clip(d.unrelated.join("; "), 160)}`);
    if (Array.isArray(d.rowsAdded))
      parts.push(
        `grid rows added: ${d.rowsAdded.map((r) => r.code).join(", ") || "none"}; removed: ${(d.rowsRemoved || []).map((r) => r.code).join(", ") || "none"}`,
      );
    if (p.cleanup || d.cleanup) {
      const c = p.cleanup || d.cleanup;
      parts.push(`Cancel pressed: ${c.clicked ? "yes" : "no"}, picker closed: ${c.closed ? "yes" : "NO"}`);
    }
    if (Array.isArray(d.steps) && d.steps.length)
      parts.push(`steps: ${d.steps.map((st) => `${st.action}:${st.reason || (st.ok ? "ok" : "?")}@${st.atMs}ms`).join(" > ")}`);
    return parts.join(" · ");
  });
}

function describeCensus(autofill) {
  const census = autofill?.census;
  if (!census) return [];
  const lines = [];
  for (const [name, tour] of [["start", census.start], ["end", census.end]]) {
    if (!tour) continue;
    lines.push(
      `  ${name}: ${tour.views.length} view(s), ${tour.complete ? "complete" : `INCOMPLETE (${tour.stoppedReason || "?"})`}, ${Math.round((tour.ms || 0) / 100) / 10} s`,
    );
    for (const v of tour.views) {
      lines.push(
        `    ${v.key}: ${v.ok ? "read" : `NOT confirmed (${v.reason})`}` +
          `${v.counts ? ` · ${v.counts.rows} rows, ${v.counts.editable} editable, ${v.counts.prefilled} with a value` : ""}` +
          ` · Auto Calculate ${v.autoCalculate === null || v.autoCalculate === undefined ? "n/a" : v.autoCalculate ? "ON" : "OFF"}` +
          ` · ${v.ms} ms${(v.sectionButtons || []).length ? ` · buttons: ${v.sectionButtons.join(", ")}` : ""}`,
      );
    }
  }
  if (census.file) lines.push(`  Full census (values included, local only): ${census.file}`);
  return lines;
}

/**
 * Previous-return Phase 3b: IRIS's Net Assets Previous Year (703002) against
 * the closing net assets (703001) of the approved previous-year return the
 * packet carried. The agent never types 703002; a difference is listed here
 * for the taxpayer to check in FBR.
 */
function describePreviousWealthCheck(autofill) {
  const check = autofill?.previousWealthCheck;
  if (!check) return [];
  const money = (value) =>
    value === null || value === undefined
      ? "not seen"
      : Number.isFinite(Number(value))
        ? Number(value).toLocaleString("en-US")
        : String(value);
  const source = check.previousReturnTaxYear
    ? `approved Tax Year ${check.previousReturnTaxYear} return (its 703001)`
    : "approved previous-year return (its 703001)";
  if (check.status === "match")
    return [
      `  MATCH: IRIS Net Assets Previous Year (703002) is ${money(check.iris)}, the same as the ${source}. The agent did not change it (703002 is editable in IRIS, but it is the filed return's own figure and is treated as read-only).`,
    ];
  if (check.status === "not_seen")
    return [
      `  NOT CHECKED: IRIS row 703002 was not seen on the final tour. The ${source} is ${money(check.expected)}; compare it with IRIS yourself before submitting.`,
    ];
  return [
    `  DIFFERS: IRIS Net Assets Previous Year (703002) is ${money(check.iris)}, but the ${source} is ${money(check.expected)}. The agent left IRIS exactly as it is; check this in FBR before submitting. 703002 is editable in IRIS 2.0, so it can be corrected by hand — but only to the closing net assets of the return actually filed for that year, never to a figure chosen to make the reconciliation balance.`,
  ];
}

/**
 * Previous-return Phase 5: does Section 116 reconcile, and did IRIS carry the
 * approved previous return's asset position forward by itself. Both are
 * read-backs — the agent never types a figure to force 703000 to zero.
 */
function describeWealthReconciliation(autofill) {
  const reconciliation = autofill?.wealthReconciliationCheck;
  const carryForward = autofill?.wealthCarryForwardCheck;
  const lines = [];
  const money = (value) =>
    value === null || value === undefined
      ? "not seen"
      : Number.isFinite(Number(value))
        ? Number(value).toLocaleString("en-US")
        : String(value);
  if (reconciliation) {
    const equation =
      reconciliation.changeInAssets === null ||
      reconciliation.inflows === null ||
      reconciliation.outflows === null
        ? null
        : `net assets change ${money(reconciliation.changeInAssets)}; inflows ${money(reconciliation.inflows)}; outflows ${money(reconciliation.outflows)}`;
    if (reconciliation.status === "reconciled")
      lines.push(
        `  RECONCILED: Unreconciled Amount (703000) is ${money(reconciliation.unreconciled)}${equation ? ` (${equation})` : ""}. Section 116 balances.`,
      );
    else if (reconciliation.status === "gap")
      lines.push(
        `  NOT RECONCILED: Unreconciled Amount (703000) is ${money(reconciliation.unreconciled)}${equation ? ` (${equation})` : ""} — ${reconciliation.gapSide === "missing_inflow" ? "an INFLOW is missing (gift, inheritance, loan, foreign remittance) or an asset is overstated" : "an OUTFLOW is missing (personal expenses, tax already paid, gift given, loan repaid) or an asset was disposed of"}. Nothing was plugged: FBR treats a typed-in balancing figure as a false declaration.`,
      );
    else
      lines.push(
        "  NOT CHECKED: IRIS row 703000 was not seen on the final tour. Open 116 - Wealth Statement > Reconciliation of Net Assets in FBR and read Unreconciled Amount yourself before submitting.",
      );
  }
  if (carryForward && carryForward.status !== "not_provided") {
    if (carryForward.status === "carried")
      lines.push(
        `  Previous return carried by IRIS: Total Assets (7019) ${money(carryForward.irisAssets)} vs the approved ${carryForward.previousReturnTaxYear ? `TY${carryForward.previousReturnTaxYear} ` : ""}close of ${money(carryForward.expectedAssets)} (${carryForward.rowCount} rows). Nothing was retyped.`,
      );
    else if (carryForward.status === "short")
      lines.push(
        `  CARRY-FORWARD SHORT: IRIS Total Assets (7019) ${money(carryForward.irisAssets)} is below the approved ${carryForward.previousReturnTaxYear ? `TY${carryForward.previousReturnTaxYear} ` : ""}close of ${money(carryForward.expectedAssets)}. Check the personal-assets list in FBR; the agent typed nothing over it.`,
      );
    else
      lines.push(
        "  Carry-forward not compared: IRIS row 7019 was not seen on the final tour.",
      );
  }
  return lines;
}

/** Phase 2 (fix47): IRIS's computed totals against the packet's expected rows. */
function describeTotalsCheck(autofill) {
  const check = autofill?.totalsCheck;
  if (!check) return [];
  if (!check.available)
    return [
      "  Not checked: this packet has no expected IRIS totals (generated before fix47). Generate a new packet version.",
    ];
  const money = (value) =>
    value === null || value === undefined || value === ""
      ? "blank"
      : Number.isFinite(Number(value))
        ? Number(value).toLocaleString("en-US")
        : String(value);
  const lines = [
    `  ${check.matched} match, ${check.differs} differ, ${check.notSeen} not seen (expected values come from exactly the figures the agent typed).`,
  ];
  for (const row of check.rows || []) {
    const verdict =
      row.status === "match" ? "MATCH" : row.status === "not_seen" ? "NOT SEEN" : "DIFFERS";
    lines.push(
      `  ${row.code} ${row.label}: IRIS ${row.status === "not_seen" ? "row not seen" : row.iris || "blank"} · expected ${money(row.expected)} (${row.formula}) -> ${verdict}${row.proven ? "" : " [formula not yet confirmed live]"}`,
    );
  }
  for (const entry of check.skipped || [])
    lines.push(`  ${entry.code}: not checked (${entry.reason})`);
  const estimate = autofill?.appEstimate;
  if (estimate) {
    lines.push(
      `  TaxRocket's full estimate (with the manual items): taxable income ${money(estimate.taxableIncome)}; IRIS now: ${money(estimate.irisTaxableIncome)}${estimate.difference ? ` (difference ${money(estimate.difference)})` : ""}.`,
    );
    if ((estimate.manualItems || []).length)
      lines.push(
        `  Not in IRIS yet (manual items): ${estimate.manualItems
          .map((item) => `${item.key} ${money(item.amount)}`)
          .join(", ")}.`,
      );
  }
  const detailed = autofill?.irisTotalsDetailed || {};
  const info = ["9201", "9203", "703000"]
    .filter((code) => detailed[code])
    .map((code) => `${code} ${detailed[code].label || ""} ${detailed[code].value || "blank"}`.replace(/\s+/g, " "));
  if (info.length) lines.push(`  IRIS-only figures (not from the packet): ${info.join("; ")}.`);
  return lines;
}

/** Phase 2 (fix47): what happened to the one end-of-run Save. */
function describeSave(autofill) {
  const save = autofill?.save;
  if (!save) return [];
  if (!save.clicked) return [`  Not pressed: ${save.reason || "not attempted"}.`];
  const lines = [
    `  Pressed at ${save.at || "?"} · result: ${save.status}${save.message ? ` · IRIS said: "${save.message}"` : " · IRIS showed no message"}.`,
  ];
  if (save.dialog)
    lines.push(
      `  Dialog after Save: "${save.dialog.text || ""}" · buttons: ${(save.dialog.buttons || []).join(", ") || "none"} · ${save.dialog.closed ? "closed by its OK" : "left on screen for you"}.`,
    );
  if (save.afterSave)
    lines.push(
      save.afterSave.complete
        ? `  Readback after Save: ${save.afterSave.match} match, ${save.afterSave.mismatch} mismatch, ${save.afterSave.notSeen} not seen.`
        : `  Readback after Save not possible (${save.afterSave.stoppedReason || "tour not complete"}).`,
    );
  return lines;
}

function buildJobReport(input = {}) {
  const executionLog = Array.isArray(input.executionLog)
    ? input.executionLog
    : [];
  const autofill = input.result?.autofill || input.result || {};
  const status = String(input.finalStatus || "unknown").toUpperCase();
  const lines = [];
  lines.push(
    `RUN ${status} · saved ${input.savedAt || ""} · job ${input.jobId || ""} · build ${input.build || ""}`,
  );
  if (input.pauseAction) {
    lines.push(`STOPPED HERE: ${input.pauseAction}`);
    lines.push(`WHY: ${clip(input.pauseMessage, 900)}`);
  }
  if (input.errorMessage) lines.push(`ERROR: ${clip(input.errorMessage, 900)}`);

  lines.push("", "TAXROCKET BUTTONS PRESSED BEFORE THIS RUN");
  lines.push(...describeConfirmations(input.confirmations));

  lines.push("", "INCOME-SOURCE PAGE (did the agent stop there, and why)");
  lines.push(...describeIncomeSourcePage(executionLog));

  lines.push("", "EMPLOYER DETAILS (manual or agent)");
  lines.push(...describeEmployers(autofill));

  if (autofill.businessDetails) {
    const details = autofill.businessDetails;
    lines.push("", "BUSINESS DETAILS (separate from numeric field counts)");
    lines.push(`  Saved-row verification: ${details.verified === true ? "VERIFIED" : "NOT VERIFIED"}.`);
    lines.push(`  Initial entry: ${details.outcome?.status || "not attempted"} (${details.outcome?.reason || "no outcome"}).`);
    if (details.readback) lines.push(`  Before return Save: ${details.readback.ok ? "match" : "NOT VERIFIED"} (${details.readback.reason}).`);
    if (details.afterSaveVerification) lines.push(`  After return Save: ${details.afterSaveVerification.ok ? "match" : "NOT VERIFIED"} (${details.afterSaveVerification.reason}).`);
    lines.push("  Numeric-field completion alone does not verify business identity, activity, brands or dates.");
  }

  lines.push("", "FIELDS (what value, which row, who put it there)");
  lines.push(...describeFields(autofill));
  // Phase 1 (fix46) tracking sections.
  if (Array.isArray(autofill?.fieldLog) && autofill.fieldLog.length) {
    lines.push("", "FIELD TABLE (one line per planned figure)");
    lines.push(...describeFieldTable(autofill));
    lines.push("", "SUMMARY BY SECTION");
    lines.push(...describeSectionSummary(autofill));
  }
  if (autofill?.secondPass?.attempted)
    lines.push(
      "",
      `SECOND PASS: ${autofill.secondPass.attempted} figure(s) retried automatically after the first pass.`,
    );
  const waitLines = describeWaits(autofill);
  if (waitLines.length) lines.push("", "WAITS (IRIS loading / locked grids)", ...waitLines);
  const pickerLines = describePickers(autofill);
  if (pickerLines.length) lines.push("", "PICKERS (IRIS 'Add ...' dialogs)", ...pickerLines);
  const censusLines = describeCensus(autofill);
  if (censusLines.length) lines.push("", "TOUR OF EVERY TAB (read only)", ...censusLines);
  if (autofill?.irisTotals && Object.keys(autofill.irisTotals).length)
    lines.push(
      "",
      "IRIS TOTALS AFTER TYPING (auto-calculated by IRIS)",
      `  ${Object.entries(autofill.irisTotals).map(([code, value]) => `${code}=${value || "(blank)"}`).join(", ")}`,
    );
  const checkLines = describeTotalsCheck(autofill);
  if (checkLines.length)
    lines.push("", "IRIS vs TAXROCKET (computed totals from the typed figures)", ...checkLines);
  const previousWealthLines = describePreviousWealthCheck(autofill);
  const wealthReconciliationLines = describeWealthReconciliation(autofill);
  if (previousWealthLines.length)
    lines.push("", "PREVIOUS YEAR NET ASSETS (IRIS 703002 vs your approved previous return)", ...previousWealthLines);
  if (wealthReconciliationLines.length)
    lines.push("", "WEALTH STATEMENT RECONCILIATION (Section 116, read-only)", ...wealthReconciliationLines);
  const saveLines = describeSave(autofill);
  const servicesSaveLabel = autofill?.pensionIncluded === true
    ? "Pension + Freelancer / Services"
    : autofill?.salaryIncluded === true
      ? "Salary + Freelancer / Services"
      : "Freelancer / Services";
  if (saveLines.length)
    lines.push(
      "",
      autofill?.save?.routePolicy === "services_save_once"
        ? `SAVE (${servicesSaveLabel} draft-save policy)`
        : "SAVE (pressed once at the end, only after every typed figure read back the same)",
      ...saveLines,
    );
  if (autofill?.htmlSnapshot)
    lines.push("", `PAGE SNAPSHOT (local only): ${autofill.htmlSnapshot}`);
  const setup = describeWealthSetup(autofill);
  if (setup.length) lines.push("  Wealth setup:", ...setup);
  const conflicts = Array.isArray(autofill?.overwriteConflicts)
    ? autofill.overwriteConflicts
    : [];
  if (conflicts.length)
    lines.push(
      `  Conflicts left for you (IRIS holds another figure): ${conflicts.length}`,
    );

  lines.push("", "PROPERTY / PAYMENTS / COMPUTATIONS REVIEW");
  lines.push(...describeReview(autofill, input.pauseAction));

  lines.push(
    "",
    "NEVER DONE BY THE AGENT",
    "  Calculate: not pressed by the agent. IRIS has an Auto Calculate switch that recalculates when you change tabs; the agent cannot see whether you pressed Calculate yourself.",
    "  Submit, Prepare PSID and payment: never pressed.",
    autofill?.save?.clicked
      ? `  Save: pressed once by the agent at ${autofill.save.at || "the end of the run"} (see SAVE above).`
      : autofill?.save?.routePolicy === "services_save_once"
        ? `  Save: not pressed by the agent (${servicesSaveLabel} route policy).`
        : `  Save: not pressed by the agent${autofill?.save?.reason ? ` (${autofill.save.reason})` : ""}.`,
  );

  lines.push("", "SCREENS VISITED AND STEPS, IN ORDER");
  for (const entry of executionLog) {
    if (NOISY_STEPS.has(String(entry?.step))) continue;
    lines.push(
      `  ${clock(entry?.at)} ${entry?.step} — ${clip(entry?.detail)}`.replace(
        /^ {2} /,
        "  ",
      ),
    );
  }
  return lines;
}

// ── Plain-language list of what needs the taxpayer (shown in TaxRocket) ──────
// The raw status codes stay in the log file and the report above. What the
// taxpayer reads must say what happened and what to do, in everyday words.

const DONE_STATUSES = new Set(["filled", "already_correct"]);

const GIFT_HELP =
  "add the gift yourself in IRIS under Reconciliation of Net Assets > Inflows > Gift.";

/** Stable identity of one planned figure (the same rule the agent uses to skip items the taxpayer entered). */
function itemKey(r) {
  return String(
    r.key ||
      `${String(r.irisCode || "")}|${String(r.rowDescriptionIncludes || "")}`,
  );
}

/** { key, name, amount } for one result; amount is a formatted number or null. */
function attentionLine(r) {
  const code = String(r.irisCode || "");
  const hint = String(r.rowDescriptionIncludes || "");
  const amount = r.plannedValue ?? r.value;
  const shown =
    amount === undefined || amount === null || amount === ""
      ? null
      : money(amount);
  let name;
  if (code === "7037") {
    const donor = r.giftDonorId || (/ from (\S+)$/.exec(hint) || [])[1] || "";
    const date = (/ on (\d{4}-\d{2}-\d{2}) from /.exec(hint) || [])[1] || "";
    name = `Gift received${donor ? ` from ${donor}` : ""}${date ? ` on ${date}` : ""}`;
  } else if (code === "7030") name = `Bank account ${hint || ""}`.trim();
  else if (code === "7012") name = "Cash in hand";
  else if (code === "7098") name = "Tax already paid (Adjustments in Outflows)";
  else if (code === "1009") name = "Salary";
  else if (code === "64020004") name = "Salary tax withheld";
  else {
    const label = String(r.rowDescription || r.label || "").trim();
    name = label ? `${label} (row ${code})` : `Row ${code}`;
  }
  return { key: itemKey(r), name, amount: shown };
}

/** { what, todo }: what happened, and what the taxpayer should do about it. */
function attentionReason(r) {
  if (isRetryableExpenseResult(r)) {
    return {
      what: "The agent could not finish this automatic personal-expense step; the amount is not confirmed as entered.",
      todo: "Close any open pop-up, let IRIS finish loading, then Retry automatic filing. The agent adds supported missing rows and fills approved empty amounts, including Rent; no manual-entry confirmation is needed.",
    };
  }

  const setup = String(r.setupStatus || "");
  const donor = r.giftDonorId ? ` ${r.giftDonorId}` : "";
  // A figure the taxpayer entered by hand is judged on what the read-back found,
  // not on the setup note of the dry pass that read it.
  if (r.status === "takeover_unconfirmed") {
    const planned = money(r.plannedValue ?? r.value);
    const gift = String(r.irisCode) === "7037";
    const bank = String(r.irisCode) === "7030";
    const where = gift
      ? "under Reconciliation of Net Assets > Inflows > Gift"
      : bank
        ? "under Personal Assets / Liabilities > Bank Account(s)"
        : "in the right row";
    if (r.takeoverReason === "value_differs")
      return {
        what: `You said you entered this yourself, but IRIS shows PKR ${money(r.seenValue)} and the approved figure is PKR ${planned}.`,
        todo: "Correct the amount in IRIS, then press Continue so the agent checks it again. If the approved figure itself is wrong, fix it in TaxRocket and start the filing again.",
      };
    if (r.takeoverReason === "empty")
      return {
        what: "You said you entered this yourself, but the amount in IRIS is still empty.",
        todo: `Type PKR ${planned} ${where}, then press Continue so the agent checks it again.`,
      };
    if (r.takeoverReason === "ambiguous")
      return {
        what: "You said you entered this yourself, but IRIS shows more than one matching row, so the agent cannot tell which one is yours.",
        todo: "Keep only one matching row in IRIS, then press Continue so the agent checks it again.",
      };
    if (r.takeoverReason === "row_missing") {
      const misplaced = r.misplacedGift
        ? ` There is a gift of PKR ${money(r.misplacedGift.value)} under Gift (row ${r.misplacedGift.code}), which is for gifts you GAVE (an outflow), not gifts you received.`
        : "";
      return {
        what: `You said you entered this yourself, but the agent cannot find ${gift ? `a gift of PKR ${planned} under Inflows > Gift` : bank ? `a bank account at this bank with PKR ${planned} under Bank Account(s)` : "it"} in IRIS.${misplaced}`,
        todo: r.misplacedGift
          ? `Delete that row in IRIS (the agent never deletes anything), add the gift ${where} with PKR ${planned} and the donor number shown above, then press Continue so the agent checks it again.`
          : `Add it ${where} with PKR ${planned}, then press Continue so the agent checks it again.`,
      };
    }
    return {
      what: "You said you entered this yourself, but the agent could not read it back from IRIS.",
      todo: "Check that it is in the right place with the right amount, then press Continue so the agent checks it again.",
    };
  }
  if (setup === "gift_donor_not_resolved")
    return {
      what: `IRIS did not recognise the donor number${donor}.`,
      todo: `IRIS only accepts donors it knows. Either correct the CNIC / NTN of this gift in Bank Intelligence (pencil icon) and start the filing again, or ${GIFT_HELP.replace(/\.$/, "")}, using a donor number IRIS accepts. The agent checks the place and the amount and reports the donor it finds.`,
    };
  if (setup === "gift_row_not_created")
    return {
      what: "The gift was saved in IRIS but the new row was not seen on the page.",
      todo: "Look under Gift in IRIS: if the row is there, type the amount in it; if it is not, add the gift yourself. Do not add it twice.",
    };
  if (setup.startsWith("gift_"))
    return {
      what: "IRIS would not accept the gift details.",
      todo: `Please ${GIFT_HELP}`,
    };
  if (setup === "bank_iban_not_resolved")
    return {
      what: "IRIS did not recognise this IBAN.",
      todo: "IRIS only accepts accounts it knows. Either correct the IBAN in TaxRocket (check it against your bank statement) and start the filing again, or add the account yourself under Personal Assets > Bank Account(s) with an IBAN IRIS accepts. The agent then checks the bank, the place and the amount, and reports the IBAN it finds.",
    };
  if (setup === "unexpected_dialog_open")
    return {
      what: "A pop-up was already open in IRIS.",
      todo: "Close it in IRIS and enter this figure yourself.",
    };
  switch (r.status) {
    case "wealth_section_unavailable":
      return {
        what: "The agent could not open this part of the IRIS Wealth Statement.",
        todo: "Close any pop-up that is open in IRIS, make sure Wealth Statement is set to Yes, then enter this figure yourself.",
      };
    case "wealth_setup_failed": {
      // The setup note says what actually failed. It is never "IRIS refused the
      // figure": the amount is not in the return yet, and the taxpayer may
      // already have entered it by hand, so both outcomes are offered.
      const detail = String(r.setupStatus || "");
      const amount = money(r.plannedValue ?? r.value);
      const amountText = amount ? `PKR ${amount}` : "this amount";
      if (/iban/i.test(detail))
        return {
          what: "The agent opened the add box for Bank Account(s) in IRIS but could not find the IBAN field inside it, so it typed nothing. The IBAN was not rejected: no figure was sent to IRIS.",
          todo: `Check Personal Assets / Liabilities > Bank Account(s): if a row with this IBAN is already there for ${amountText}, leave it and press Continue so the agent reads it back. If it is not there, add the account with this IBAN and ${amountText}, then press Continue.`,
        };
      return {
        what: "The agent could not finish adding this row in IRIS, so it typed nothing.",
        todo: `Look at the row in IRIS: if it is already there for ${amountText}, leave it and press Continue so the agent reads it back; if it is not there, add it yourself and type the amount, then press Continue.`,
      };
    }
    case "wealth_unsupported_row":
      return {
        what: "The agent does not enter this kind of row.",
        todo: "Please enter it yourself in IRIS.",
      };
    case "wealth_row_missing_dry_run":
      return {
        what: "This was a practice run, so the row was not created.",
        todo: "Run the live filing to create it.",
      };
    case "wealth_cash_would_be_negative":
      return {
        what: "Adding this would make Cash in hand negative.",
        todo: "Check the Cash in hand figure in IRIS.",
      };
    case "wealth_cash_unreadable":
      return {
        what: "Cash in hand in IRIS is not a plain number.",
        todo: "Check it and enter the right figure yourself.",
      };
    case "row_not_found":
      return {
        what: "IRIS does not show this row on the page.",
        todo: "Enter the amount yourself if the row exists.",
      };
    case "ambiguous_row":
      return {
        what: "IRIS shows more than one matching row, so the agent did not guess.",
        todo: "Enter the amount in the right row yourself.",
      };
    case "column_not_found":
    case "column_disabled":
    case "no_editable_cell":
      return {
        what: "No writable cell was available when the agent checked this row; it was not typed.",
        todo: "Check the row in IRIS.",
      };
    case "unverified_target":
      return {
        what: "The target or section could not be verified before typing; this amount was not entered.",
        todo: "Retry automatic filing once the correct IRIS section is ready.",
      };
    case "readback_mismatch":
      return {
        what: "The agent could not confirm that the number landed in the right cell.",
        todo: "Please check this row and enter the amount yourself.",
      };
    case "empty_value":
    case "missing_code":
      return {
        what: "This figure has no usable amount or row in your packet.",
        todo: "Check the packet and enter it yourself.",
      };
    default:
      return {
        what: "The agent could not enter this safely.",
        todo: "Please enter it yourself in IRIS.",
      };
  }
}

/**
 * Structured version, for the TaxRocket page.
 *   { done, total, items: [{ kind, lines: [{name, amount}], what, todo }] }
 * Items that failed for the same reason share one entry. kind is "problem",
 * "conflict" (IRIS holds another figure; never overwritten) or "prefill"
 * (IRIS holds a figure the packet does not cover).
 */
function buildAttentionReport(results, options = {}) {
  const list = Array.isArray(results) ? results : [];
  // Figures the taxpayer entered themselves count as done; figures the agent
  // has not reached yet (it stops at the first problem) are "remaining".
  const alreadyDone = Math.max(0, Number(options.alreadyDone) || 0);
  const remaining = Math.max(0, Number(options.remaining) || 0);
  const done =
    list.filter((r) => DONE_STATUSES.has(r.status)).length + alreadyDone;
  const groups = new Map();
  for (const r of list) {
    if (
      DONE_STATUSES.has(r.status) ||
      r.status === "overwrite_needs_confirmation"
    )
      continue;
    const reason = attentionReason(r);
    const key = `${reason.what}|${reason.todo}`;
    if (!groups.has(key))
      groups.set(key, { kind: "problem", lines: [], ...reason });
    groups.get(key).lines.push(attentionLine(r));
  }
  const items = [...groups.values()];
  for (const r of list) {
    if (r.status !== "overwrite_needs_confirmation") continue;
    items.push({
      kind: "conflict",
      lines: [
        attentionLine({ ...r, plannedValue: undefined, value: undefined }),
      ],
      what: `IRIS already shows PKR ${money(r.existingValue)}; your packet has PKR ${money(r.plannedValue ?? r.value)}.`,
      todo: "The agent never overwrites a figure in IRIS. Decide which figure is right and correct it in the FBR window.",
    });
  }
  for (const row of Array.isArray(options.unexpectedPrefill)
    ? options.unexpectedPrefill
    : []) {
    const values = (row.cells || [])
      .map((cell) => money(cell.value))
      .join(" / ");
    items.push({
      kind: "prefill",
      lines: [
        {
          key: `prefill|${row.code}`,
          name: `Row ${row.code}`,
          amount: values || null,
        },
      ],
      what: "IRIS already holds a figure that your packet does not cover.",
      todo: "The IRIS total will differ from the packet until you have checked it.",
    });
  }
  return {
    done,
    total: list.length + alreadyDone + remaining,
    remaining,
    items,
  };
}

/**
 * Plain-text version of the same list (older pages, logs). Overwrite conflicts
 * and pre-filled rows are NOT included: the caller words those.
 * Returns { text, itemCount }.
 */
function buildAttentionMessage(results, options = {}) {
  const report = buildAttentionReport(results, options);
  const problems = report.items.filter((item) => item.kind === "problem");
  if (!problems.length) return { text: "", itemCount: 0 };
  const count = problems.reduce((sum, item) => sum + item.lines.length, 0);
  const lines = [
    report.remaining > 0
      ? `${report.done} of ${report.total} figures are in IRIS. The agent stopped at the first one it could not enter (${report.remaining} more come after it):`
      : `${report.done} of ${report.total} figures are in IRIS. ${count} could not be entered by the agent:`,
  ];
  for (const item of problems) {
    const names = item.lines
      .map((line) =>
        line.amount ? `${line.name} (PKR ${line.amount})` : line.name,
      )
      .join("; ");
    lines.push(`\u2022 ${names}: ${item.what} ${item.todo}`);
  }
  lines.push(
    options.noRetryHint
      ? "Enter these in the FBR window yourself."
      : `Enter this in the FBR window yourself, tick the confirmation and press Continue. The agent then carries on from here.`,
  );
  return { text: lines.join("\n"), itemCount: count };
}

module.exports = {
  BUILD_TAG,
  classifyFieldResult,
  buildFieldLog,
  buildJobReport,
  buildAttentionMessage,
  buildAttentionReport,
  describeWealthReconciliation,
};
