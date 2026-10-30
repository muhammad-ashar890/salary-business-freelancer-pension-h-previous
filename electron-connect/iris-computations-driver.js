"use strict";
/**
 * Phase 3b (fix51): the two Computations rows IRIS leaves to the taxpayer,
 *   923184  "Surcharge on high earning person u/s 4AB"
 *   9231822 "Tax on High Earning Persons u/s 4C" (super tax).
 * Phase 3c (fix52): first, the Section 113 turnover row when the packet plans
 * it (iris-turnover-driver.js adds it through "+ Turnover"; this driver
 * types the turnover in its "Total Income" cell with the row filler).
 *
 * Evidence (no guesswork):
 *  - capture 20 (~/iris-business-captures): both rows carry an ENABLED input
 *    in the first value column only (pattern E D D D); the computed rows
 *    (9201, 9210, 999905) are all disabled.
 *  - live census, 15-Oct-2026 (agent-run-logs/2026-10-15-p3a-run), view
 *    "Tax Chargeable / Payments > Computations", headings Total Income |
 *    Subject to Final Tax | Subject to Exemption | Subject to Normal Tax:
 *    3000 (Total Income column), 9000, 9100 and 920000 / 9200 ("Subject to
 *    Normal Tax"), 9231822 and 923184 editable in "Total Income".
 *
 * Rules:
 *  - Clicks only through the navigator (Data tab, panel header, the
 *    "Computations" left tab) and, for a TYPE turnover plan only, through
 *    iris-turnover-driver.js ("+ Turnover", the one planned card, ADD or
 *    Cancel). Never Calculate, "Prepare PSID", the return's Save or Submit.
 *  - The turnover is typed only into a blank "Total Income" cell of the
 *    planned row; the same figure counts as already correct, a different
 *    one is reported to the taxpayer and never overwritten.
 *  - The surcharge is typed only when IRIS's own Taxable Income (9100) and
 *    Normal Tax (920000) equal TaxRocket's AND rate x IRIS 920000 equals
 *    TaxRocket's surcharge (1 rupee rounding allowed). Otherwise nothing is
 *    typed and the taxpayer gets a plain message with both figures.
 *  - The super tax is typed only when IRIS's Income from Business (3000,
 *    Total Income column) equals TaxRocket's Section 4C base.
 *  - A row that already holds a figure is never overwritten: the same figure
 *    counts as already correct, a different one is reported to the taxpayer.
 *  - The row filler types into the "Total Income" cell (header verified) and
 *    reads it back; the census tour re-reads it after the tab switches.
 */

const navigation = require("./iris-navigation");
const rowFiller = require("./iris-row-filler");
const turnoverDriver = require("./iris-turnover-driver");

/** Must equal AGENT_BUILD_TAG in main.js. */
const BUILD_TAG = "pension-wht-64020004-base-20261030b";

const SECTION_ID = "computations";
/** Census view key (iris-tour-census.js: "<panel> > <left tab>"). */
const CENSUS_VIEW = "Tax Chargeable / Payments > Computations";
const TYPE_COLUMN = "Total Income";
/** Column indexes on the Computations tab (live census). */
const COLUMN = Object.freeze({ total: 0, normal: 3 });
const SURCHARGE_THRESHOLD = 10_000_000;
const SUPER_TAX_THRESHOLD = 150_000_000;

const SURCHARGE_CODE = "923184";
const SUPER_TAX_CODE = "9231822";

const DECISION = Object.freeze({
  TYPE: "type",
  ALREADY_CORRECT: "already_correct",
  LEAVE: "leave",
  TELL_USER: "tell_user",
});

const rupees = (value) => `Rs ${Math.round(Number(value) || 0).toLocaleString("en-US")}`;

/** IRIS amount text -> number; null when blank, NaN when not an amount. */
function parseAmount(value) {
  const text = String(value == null ? "" : value).replace(/[\s,]/g, "");
  if (text === "") return null;
  const negative = /^\(.*\)$/.test(text);
  const bare = negative ? text.slice(1, -1) : text;
  if (!/^-?\d+(\.\d+)?$/.test(bare)) return Number.NaN;
  const number = Number(bare);
  return negative ? -number : number;
}
const known = (value) => typeof value === "number" && Number.isFinite(value);

/** Refuse a plan the agent does not understand; returns the problems. */
function validatePlan(plan) {
  const problems = [];
  if (!plan || plan.version !== "computations-v1") return ["version"];
  for (const [key, code] of [
    ["surcharge", SURCHARGE_CODE],
    ["superTax", SUPER_TAX_CODE],
  ]) {
    const entry = plan[key];
    if (!entry || entry.code !== code) {
      problems.push(`${key}_code`);
      continue;
    }
    if (!["TYPE", "NONE", "USER"].includes(entry.action)) problems.push(`${key}_action`);
    if (entry.action === "TYPE" && !(Number.isInteger(entry.value) && entry.value > 0))
      problems.push(`${key}_value`);
  }
  if (plan.surcharge && plan.surcharge.action === "TYPE") {
    if (!known(plan.expectedTaxableIncome) || !known(plan.expectedNormalTax))
      problems.push("surcharge_basis");
    if (![9, 10].includes(plan.surcharge.ratePercent)) problems.push("surcharge_rate");
  }
  if (plan.superTax && plan.superTax.action === "TYPE" && !known(plan.expectedBusinessIncome))
    problems.push("super_tax_basis");
  // Phase 3c: the optional Section 113 turnover row.
  if (plan.turnover !== undefined)
    for (const problem of turnoverDriver.validateTurnoverEntry(plan.turnover)) problems.push(`turnover_${problem}`);
  return problems;
}

/**
 * Pure decision from the rows read on the Computations tab
 * (`rowFiller.snapshotIrisRows` shape: { code, description, cells }).
 */
function decideComputations(plan, rows) {
  const byCode = new Map();
  for (const row of rows || []) {
    const code = String(row && row.code);
    byCode.set(code, byCode.has(code) ? null : row); // null = not unique
  }
  const cellOf = (code, index) => {
    const row = byCode.get(code);
    return row && Array.isArray(row.cells) ? row.cells[index] || null : null;
  };
  const amountOf = (code, index) => {
    const cell = cellOf(code, index);
    return cell ? parseAmount(cell.value) : null;
  };
  const iris = {
    taxableIncome: amountOf("9100", COLUMN.normal),
    normalTax: amountOf("920000", COLUMN.normal),
    businessIncome: amountOf("3000", COLUMN.total),
    totalIncome: amountOf("9000", COLUMN.total),
    surchargeTotal: amountOf(SURCHARGE_CODE, COLUMN.total),
    surchargeNormal: amountOf(SURCHARGE_CODE, COLUMN.normal),
    superTaxTotal: amountOf(SUPER_TAX_CODE, COLUMN.total),
    superTaxNormal: amountOf(SUPER_TAX_CODE, COLUMN.normal),
    taxChargeable: amountOf("9200", COLUMN.normal),
  };

  const target = (code) => {
    const row = byCode.get(code);
    const cell = cellOf(code, COLUMN.total);
    if (!row) return { ok: false, reason: byCode.has(code) ? "row_not_unique" : "row_not_seen" };
    if (!cell) return { ok: false, reason: "cell_not_seen" };
    if (!cell.editable) return { ok: false, reason: "cell_not_editable" };
    const current = parseAmount(cell.value);
    if (Number.isNaN(current)) return { ok: false, reason: "cell_not_an_amount" };
    return { ok: true, current, description: row.description || "" };
  };

  const decide = (entry, check) => {
    const code = entry.code;
    const where = target(code);
    const base = { code, label: entry.label || code, value: entry.action === "TYPE" ? entry.value : 0 };
    const holds = where.ok && known(where.current) && where.current !== 0 ? where.current : null;
    const tell = (reason, message) => ({ ...base, decision: DECISION.TELL_USER, reason, message });
    if (entry.action === "TYPE") {
      if (!where.ok)
        return tell(where.reason, `${entry.label} (row ${code}): the agent could not use this IRIS row (${where.reason}), so please type ${rupees(entry.value)} yourself (${entry.basis}).`);
      const problem = check();
      if (problem) return tell(problem.reason, problem.message);
      if (holds !== null) {
        if (Math.abs(holds - entry.value) <= 1)
          return { ...base, decision: DECISION.ALREADY_CORRECT, reason: "already_holds_value", current: holds, description: where.description };
        return tell(
          "row_holds_other_figure",
          `${entry.label} (row ${code}): IRIS already holds ${rupees(holds)}, TaxRocket worked out ${rupees(entry.value)} (${entry.basis}). The agent does not overwrite a figure; please check it yourself.`,
        );
      }
      return { ...base, decision: DECISION.TYPE, reason: "verified", description: where.description };
    }
    // NONE / USER: nothing is typed; the taxpayer is told only when IRIS's own
    // figures cross the threshold, or the row already holds a figure.
    const crossing = check();
    if (crossing) return tell(crossing.reason, crossing.message);
    if (holds !== null && entry.action === "NONE")
      return tell(
        "row_holds_figure_not_expected",
        `${entry.label} (row ${code}): IRIS already holds ${rupees(holds)}, but TaxRocket expects nothing here (${entry.basis}). Left as it is; please check it yourself.`,
      );
    return { ...base, decision: DECISION.LEAVE, reason: entry.action === "NONE" ? "not_due" : "below_threshold" };
  };

  const s = plan.surcharge;
  // Live 19-Oct-2026: on this business return IRIS itself computed the
  // Section 4AB surcharge in "Subject to Normal Tax" (463,400 = 10% of its
  // 4,634,000 Normal Tax) and included it in Tax Chargeable, while the Total
  // Income input stayed blank. When exactly that arithmetic is already on
  // the tab, there is no manual item: typing TaxRocket's older figure into
  // Total would be wrong, and telling the taxpayer to type 463,400 would
  // duplicate IRIS's own result. Totals checks still report any app-vs-IRIS
  // difference in taxable income / normal tax.
  const irisComputedSurcharge = (() => {
    if (plan.minimumTaxRegime === "minimum") return null;
    if (!known(iris.taxableIncome) || !(iris.taxableIncome > SURCHARGE_THRESHOLD)) return null;
    if (!known(iris.normalTax) || !(iris.normalTax > 0)) return null;
    const computed = iris.surchargeNormal;
    if (!known(computed) || !(computed > 0)) return null;
    if (Number.isNaN(iris.surchargeTotal)) return null;
    if (known(iris.surchargeTotal) && iris.surchargeTotal !== 0 && Math.abs(iris.surchargeTotal - computed) > 1) return null;
    const rates = s.action === "TYPE" && [9, 10].includes(s.ratePercent) ? [s.ratePercent] : [10, 9];
    const ratePercent = rates.find((rate) => Math.abs(computed - Math.round((iris.normalTax * rate) / 100)) <= 1);
    if (!ratePercent) return null;
    const superTax = known(iris.superTaxTotal) && iris.superTaxTotal > 0
      ? iris.superTaxTotal
      : known(iris.superTaxNormal) && iris.superTaxNormal > 0
        ? iris.superTaxNormal
        : 0;
    if (!known(iris.taxChargeable)) return null;
    if (Math.abs(iris.taxChargeable - (iris.normalTax + computed + superTax)) > 1) return null;
    return { value: computed, ratePercent };
  })();
  const surcharge = irisComputedSurcharge
    ? {
        code: SURCHARGE_CODE,
        label: s.label || SURCHARGE_CODE,
        value: s.action === "TYPE" ? s.value : irisComputedSurcharge.value,
        decision: DECISION.LEAVE,
        reason: "iris_computed_in_normal_column",
        current: irisComputedSurcharge.value,
      }
    : decide(s, () => {
    if (!known(iris.taxableIncome) || !known(iris.normalTax)) {
      if (s.action === "NONE") return null;
      return {
        reason: "iris_base_unreadable",
        message:
          s.action === "TYPE"
            ? `Surcharge (row 923184): IRIS's Taxable Income (9100) / Normal Tax (920000) could not be read, so the agent did not type the surcharge. Please type ${rupees(s.value)} yourself (${s.basis}).`
            : s.message,
      };
    }
    const above = iris.taxableIncome > SURCHARGE_THRESHOLD;
    const hint = `10% of IRIS's Normal Tax ${rupees(iris.normalTax)} is ${rupees(iris.normalTax * 0.1)}; 9% (only when salary is more than 75% of taxable income) is ${rupees(iris.normalTax * 0.09)}.`;
    if (s.action === "TYPE") {
      if (!above)
        return {
          reason: "iris_taxable_not_above_10m",
          message: `Surcharge (row 923184): TaxRocket worked out ${rupees(s.value)}, but IRIS's Taxable Income (9100) is ${rupees(iris.taxableIncome)}, not above PKR 10 million. Nothing was typed; please check the return.`,
        };
      const fromIris = Math.round((iris.normalTax * s.ratePercent) / 100);
      if (iris.taxableIncome !== plan.expectedTaxableIncome || iris.normalTax !== plan.expectedNormalTax || Math.abs(fromIris - s.value) > 1)
        return {
          reason: "iris_base_differs",
          message: `Surcharge (row 923184): IRIS shows Taxable Income ${rupees(iris.taxableIncome)} and Normal Tax ${rupees(iris.normalTax)}; TaxRocket expected ${rupees(plan.expectedTaxableIncome)} and ${rupees(plan.expectedNormalTax)}. The agent did not type the surcharge; please type it yourself: ${s.ratePercent}% of IRIS's Normal Tax is ${rupees(fromIris)}.`,
        };
      return null;
    }
    if (!above) return null;
    if (s.action === "NONE")
      return {
        reason: "iris_taxable_above_10m",
        message: `Surcharge (row 923184): IRIS's Taxable Income (9100) is ${rupees(iris.taxableIncome)}, above PKR 10 million, but TaxRocket expected no surcharge. Nothing was typed; please check the return and type the surcharge yourself. ${hint}`,
      };
    return { reason: "taxpayer_types_it", message: `${s.message} ${hint}` };
  });

  const t = plan.superTax;
  const superTax = decide(t, () => {
    if (t.action === "TYPE") {
      if (!known(iris.businessIncome) || iris.businessIncome !== plan.expectedBusinessIncome)
        return {
          reason: "iris_base_differs",
          message: `Super tax (row 9231822): IRIS's Income from Business (3000) is ${known(iris.businessIncome) ? rupees(iris.businessIncome) : "unreadable"}; TaxRocket worked out super tax on ${rupees(plan.expectedBusinessIncome)}. The agent did not type it; please type the super tax yourself (TaxRocket's figure: ${rupees(t.value)}, ${t.basis}).`,
        };
      return null;
    }
    if (known(iris.totalIncome) && iris.totalIncome > SUPER_TAX_THRESHOLD)
      return {
        reason: t.action === "NONE" ? "iris_total_above_150m" : "taxpayer_types_it",
        message:
          t.action === "NONE"
            ? `Super tax (row 9231822): IRIS's Total Income (9000) is ${rupees(iris.totalIncome)}, above PKR 150 million, but TaxRocket expected no super tax (${t.basis}). Nothing was typed; please check it and type the super tax yourself if it applies.`
            : `${t.message} IRIS's Total Income (9000) is ${rupees(iris.totalIncome)}.`,
      };
    return null;
  });

  return { iris, entries: [surcharge, superTax] };
}

function resultFor(entry, extra) {
  return {
    key: `computations:${entry.code}:${COLUMN.total}`,
    irisCode: entry.code,
    label: `${entry.label} - ${TYPE_COLUMN}`,
    requestedColumn: TYPE_COLUMN,
    columnIndex: COLUMN.total,
    value: String(entry.value),
    plannedValue: String(entry.value),
    rowDescription: entry.description || undefined,
    sectionId: SECTION_ID,
    sourceGroup: "computations",
    censusView: CENSUS_VIEW,
    ...extra,
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads the Computations tab and types the rows TaxRocket verified.
 * Returns { ok, reason, results, messages, decisions, iris }.
 * `results` only carries rows the agent typed or found already correct (or
 * failed to type); rows left to the taxpayer are in `messages`.
 */
async function fillComputations(windowInstance, plan, options = {}) {
  const {
    mode = "dry",
    onStep = () => {},
    beforeStep = async () => {},
    taxYear,
    taxpayerIdentifier,
    sleep = defaultSleep,
    settleMs = 800,
    navigate = navigation.navigateToSection,
    snapshot = rowFiller.snapshotIrisRows,
    fill = rowFiller.fillIrisRows,
    ensureTurnover = turnoverDriver.ensureTurnoverRow,
  } = options;
  const problems = validatePlan(plan);
  if (problems.length)
    return { ok: false, reason: `plan_refused: ${problems.join(", ")}`, results: [], messages: [], decisions: [] };
  const turnoverPlan = plan.turnover || null;
  const typing = [plan.surcharge, plan.superTax].filter((entry) => entry.action === "TYPE");
  const turnoverTyping = Boolean(turnoverPlan && turnoverPlan.action === "TYPE");
  if (mode !== "live")
    return {
      ok: true,
      reason: "dry_run_nothing_clicked",
      results: [],
      messages: [],
      decisions: [],
      planned: typing.length + (turnoverTyping ? 1 : 0),
    };

  const turnoverByHand = (entry, why) =>
    `Minimum tax (Section 113): ${why}, so please press "+ Turnover" on the Computations tab, tick "${entry.label}" and type ${rupees(entry.value)} in Total Income yourself (${entry.basis}).`;
  const fallbackMessages = () => [
    ...(turnoverPlan
      ? [turnoverPlan.action === "TYPE" ? turnoverByHand(turnoverPlan, "the agent could not open IRIS's Computations tab") : turnoverPlan.message]
      : []),
    ...[plan.surcharge, plan.superTax]
      .filter((entry) => entry.action !== "NONE")
      .map((entry) =>
        entry.action === "TYPE"
          ? `${entry.label} (row ${entry.code}): the agent could not open IRIS's Computations tab, so please type ${rupees(entry.value)} yourself (${entry.basis}).`
          : entry.message,
      ),
  ];

  await beforeStep();
  let moved;
  try {
    moved = await navigate(windowInstance, { sectionId: SECTION_ID, taxYear, taxpayerIdentifier });
  } catch (error) {
    moved = { ok: false, status: (error && error.message) || "error" };
  }
  if (!moved || !moved.ok)
    return {
      ok: false,
      reason: `navigation_${(moved && moved.status) || "failed"}`,
      results: [],
      messages: fallbackMessages(),
      decisions: [],
    };
  const results = [];
  const messages = [];
  // Phase 3c: the Section 113 turnover row first, so the IRIS figures read
  // below already include it.
  let turnover = null;
  if (turnoverPlan && turnoverPlan.action === "USER") messages.push(turnoverPlan.message);
  if (turnoverTyping) {
    let ensured;
    try {
      ensured = await ensureTurnover(windowInstance, turnoverPlan, { sleep, beforeStep });
    } catch (error) {
      ensured = { ok: false, reason: `error: ${(error && error.message) || error}`, added: false, row: null };
    }
    turnover = { code: turnoverPlan.code, planned: turnoverPlan.value, ensure: ensured.reason, added: Boolean(ensured.added), decision: null };
    if (!ensured.ok) {
      turnover.decision = DECISION.TELL_USER;
      messages.push(ensured.message || turnoverByHand(turnoverPlan, `the agent could not add the row (${ensured.reason})`));
    } else {
      const entry = { code: turnoverPlan.code, label: turnoverPlan.label, value: turnoverPlan.value, description: ensured.row.description };
      const current = parseAmount(ensured.row.values && ensured.row.values[COLUMN.total]);
      if (Number.isNaN(current)) {
        turnover.decision = DECISION.TELL_USER;
        messages.push(turnoverByHand(turnoverPlan, "IRIS's Total Income cell of the turnover row does not hold an amount"));
      } else if (known(current) && current !== 0) {
        if (current === turnoverPlan.value) {
          turnover.decision = DECISION.ALREADY_CORRECT;
          results.push(resultFor(entry, { status: rowFiller.FILL_STATUS.ALREADY_CORRECT || "already_correct", readback: String(current) }));
        } else {
          turnover.decision = DECISION.TELL_USER;
          messages.push(
            `Minimum tax (Section 113): the turnover row "${turnoverPlan.label}" already holds ${rupees(current)} in Total Income; TaxRocket worked out ${rupees(turnoverPlan.value)} (${turnoverPlan.basis}). The agent does not overwrite a figure; please check it yourself.`,
          );
        }
      } else {
        turnover.decision = DECISION.TYPE;
        await beforeStep();
        let filled;
        try {
          filled = await fill(
            windowInstance,
            [{ key: `computations:${entry.code}`, irisCode: entry.code, label: entry.label, column: TYPE_COLUMN, value: String(entry.value) }],
            { dryRun: false },
          );
        } catch (error) {
          filled = { results: [{ status: rowFiller.FILL_STATUS.UNVERIFIED_TARGET, error: (error && error.message) || "fill_error" }] };
        }
        const outcome = (filled && filled.results && filled.results[0]) || { status: rowFiller.FILL_STATUS.UNVERIFIED_TARGET };
        results.push(resultFor(entry, { ...outcome, key: `computations:${entry.code}:${COLUMN.total}`, irisCode: entry.code, columnIndex: COLUMN.total, censusView: CENSUS_VIEW, sectionId: SECTION_ID, sourceGroup: "computations", plannedValue: String(entry.value) }));
        if (outcome.status !== rowFiller.FILL_STATUS.FILLED)
          messages.push(turnoverByHand(turnoverPlan, `typing did not succeed (${outcome.status})`));
      }
    }
  }

  // IRIS recalculates on the tab change; read twice and require the same base.
  await sleep(settleMs);
  let rows = await snapshot(windowInstance);
  let decided = decideComputations(plan, rows);
  for (let i = 0; i < 3; i += 1) {
    await sleep(settleMs);
    const again = await snapshot(windowInstance);
    const next = decideComputations(plan, again);
    const same =
      JSON.stringify(next.iris) === JSON.stringify(decided.iris) &&
      next.entries.every((entry, index) => entry.decision === decided.entries[index].decision);
    rows = again;
    decided = next;
    if (same) break;
  }

  for (const entry of decided.entries) {
    if (entry.decision === DECISION.TELL_USER) {
      messages.push(entry.message);
      continue;
    }
    if (entry.decision === DECISION.ALREADY_CORRECT) {
      results.push(resultFor(entry, { status: rowFiller.FILL_STATUS.ALREADY_CORRECT || "already_correct", readback: String(entry.current) }));
      continue;
    }
    if (entry.decision !== DECISION.TYPE) continue;
    await beforeStep();
    let filled;
    try {
      filled = await fill(
        windowInstance,
        [{ key: `computations:${entry.code}`, irisCode: entry.code, label: entry.label, column: TYPE_COLUMN, value: String(entry.value) }],
        { dryRun: false },
      );
    } catch (error) {
      filled = { results: [{ status: rowFiller.FILL_STATUS.UNVERIFIED_TARGET, error: (error && error.message) || "fill_error" }] };
    }
    const outcome = (filled && filled.results && filled.results[0]) || { status: rowFiller.FILL_STATUS.UNVERIFIED_TARGET };
    results.push(resultFor(entry, { ...outcome, key: `computations:${entry.code}:${COLUMN.total}`, irisCode: entry.code, columnIndex: COLUMN.total, censusView: CENSUS_VIEW, sectionId: SECTION_ID, sourceGroup: "computations", plannedValue: String(entry.value) }));
    if (outcome.status !== rowFiller.FILL_STATUS.FILLED)
      messages.push(`${entry.label} (row ${entry.code}): typing did not succeed (${outcome.status}); please type ${rupees(entry.value)} yourself.`);
  }
  for (const message of messages) onStep("real_autofill_computations_for_taxpayer", message);
  const typedOk = results.every((r) => ["filled", "already_correct"].includes(r.status));
  return {
    ok: typedOk && messages.length === 0,
    reason: messages.length ? "left_for_taxpayer" : typing.length || turnoverTyping ? "typed" : "nothing_due",
    results,
    messages,
    decisions: [
      ...(turnover ? [{ code: turnover.code, decision: turnover.decision, reason: turnover.ensure }] : []),
      ...decided.entries.map(({ code, decision, reason }) => ({ code, decision, reason })),
    ],
    iris: decided.iris,
    ...(turnover ? { turnover } : {}),
  };
}

function describeComputationsOutcome(outcome) {
  if (!outcome) return "Computations: not attempted.";
  const typed = (outcome.results || []).filter((r) => r.status === "filled").map((r) => `${r.irisCode} ${rupees(r.plannedValue)}`);
  const already = (outcome.results || []).filter((r) => r.status === "already_correct").map((r) => r.irisCode);
  const parts = [];
  if (typed.length) parts.push(`typed ${typed.join(", ")} (read back)`);
  if (already.length) parts.push(`already correct: ${already.join(", ")}`);
  if ((outcome.decisions || []).some((d) => d.reason === "iris_computed_in_normal_column"))
    parts.push(`surcharge already computed by IRIS in Subject to Normal Tax${known(outcome.iris && outcome.iris.surchargeNormal) ? ` (${rupees(outcome.iris.surchargeNormal)})` : ""}; nothing typed`);
  if ((outcome.messages || []).length) parts.push(`${outcome.messages.length} item(s) left for you to type (see the messages)`);
  if (outcome.turnover && outcome.turnover.added) parts.unshift(`turnover row ${outcome.turnover.code} added through "+ Turnover"`);
  if (!parts.length) parts.push(outcome.reason === "nothing_due" ? "no surcharge or super tax is due on these figures; nothing typed" : outcome.reason);
  return `Computations (${outcome.turnover ? "turnover row / " : ""}surcharge 923184 / super tax 9231822): ${parts.join("; ")}.`;
}

module.exports = {
  BUILD_TAG,
  SECTION_ID,
  CENSUS_VIEW,
  DECISION,
  parseAmount,
  validatePlan,
  decideComputations,
  fillComputations,
  describeComputationsOutcome,
};
