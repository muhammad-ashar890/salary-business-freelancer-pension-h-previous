/**
 * Section 116 reconciliation — read-only checks (previous-return Phase 5).
 *
 * Two questions the operator cannot answer by eye at the end of a live run:
 *
 *  1. Does the Wealth Statement reconcile?  IRIS blocks submission while
 *     Unreconciled Amount (703000) is not zero, and FBR treats a figure typed
 *     in merely to force the balance as a false declaration (s.111 / s.182
 *     exposure). So this module only READS 703000 and, when it is not zero,
 *     says which side is short.
 *
 *  2. Did IRIS really carry the approved previous return forward?  IRIS 2.0
 *     prefills the 116 asset rows from the last filed return by itself
 *     (confirmed on the live portal 2026-10-27: rows, detail children and
 *     totals appeared on a brand-new draft that nobody had filled, and the
 *     "Import Previous Return" button changed nothing). That means the agent
 *     must never retype those rows — the only useful action is to notice when
 *     the carried position is SHORT of the approved return, which happens when
 *     IRIS carried a different year (e.g. the returning-resident case the tax
 *     bars raised with FBR in October 2026).
 *
 * Everything here is a read-back: no figure is ever written, and a gap is
 * reported with the exact amount and the side it belongs to.
 */

const WEALTH_CODES = Object.freeze({
  /** Net Assets Current Year (computed by IRIS from the asset rows — NOT editable). */
  current: "703001",
  /**
   * Net Assets Previous Year. IRIS prefills it from the filed record and the
   * agent treats it as READ-ONLY, but the field IS editable in IRIS 2.0
   * (confirmed on the live portal 2026-10-27; the "non-editable" claim in the
   * October 2026 press coverage is wrong). Typing a figure there to force the
   * balance is a false declaration, so the agent never writes it and only
   * reports a difference.
   */
  previous: "703002",
  /** Increase / (Decrease) in Assets (auto) = 703001 - 703002. */
  change: "703003",
  /** Total Inflows (auto sum of 7031..7049 children). */
  inflows: "7049",
  /** Total Outflows (auto sum of 7089/7091/7098/7099 children). */
  outflows: "7099",
  /** Unreconciled Amount — must be zero before IRIS accepts the return. */
  unreconciled: "703000",
  /** Total Assets / Total Liabilities on the 116 asset page. */
  totalAssets: "7019",
  totalLiabilities: "7029",
  /** Business Capital, populated from the Balance Sheet, never typed by hand. */
  businessCapital: "7003",
});

const money = (value) => Math.round(value).toLocaleString("en-US");

function readAmount(parseAmount, raw) {
  const parsed =
    typeof parseAmount === "function"
      ? parseAmount(raw == null ? "" : raw)
      : Number(String(raw == null ? "" : raw).replace(/[,\s]/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

/**
 * Read the reconciliation equation off the census.
 *
 * `irisTotals` is the code -> cell-text map the end-of-run census collects;
 * `parseAmount` is that module's own parser (passed in so this file stays
 * testable without Electron).
 */
function buildWealthReconciliationCheck({ irisTotals, parseAmount } = {}) {
  const read = (code) => readAmount(parseAmount, irisTotals?.[code]);
  const unreconciled = read(WEALTH_CODES.unreconciled);
  const result = {
    code: WEALTH_CODES.unreconciled,
    unreconciled,
    netAssetsCurrent: read(WEALTH_CODES.current),
    netAssetsPrevious: read(WEALTH_CODES.previous),
    changeInAssets: read(WEALTH_CODES.change),
    inflows: read(WEALTH_CODES.inflows),
    outflows: read(WEALTH_CODES.outflows),
    status: "not_seen",
    gapSide: null,
    message: "",
  };

  if (unreconciled === null) {
    result.message =
      "Unreconciled Amount (703000) was not seen on the final tour, so the Section 116 reconciliation could not be checked. Nothing was added or changed.";
    return result;
  }

  // IRIS states the gap as an absolute amount; the equation below it tells the
  // direction, so recompute the sign rather than trusting the row's wording.
  const change = result.changeInAssets;
  const inflows = result.inflows;
  const outflows = result.outflows;
  const canDerive = inflows !== null && outflows !== null && change !== null;
  const signedGap = canDerive ? change - (inflows - outflows) : unreconciled;

  if (unreconciled === 0) {
    result.status = "reconciled";
    result.message = canDerive
      ? `Wealth statement reconciles: Net Assets rose by ${money(change)} and IRIS's own inflows minus outflows come to ${money(inflows - outflows)}, so Unreconciled Amount (703000) is 0.`
      : "Wealth statement reconciles: IRIS shows Unreconciled Amount (703000) as 0.";
    return result;
  }

  result.gapSide = signedGap > 0 ? "missing_inflow" : "missing_outflow";
  result.status = "gap";
  result.message =
    signedGap > 0
      ? `Wealth reconciliation does NOT balance: Unreconciled Amount (703000) is PKR ${money(unreconciled)} — net assets grew more than the declared inflows explain, so an inflow is missing (gift, inheritance, loan, foreign remittance) or an asset is overstated.`
      : `Wealth reconciliation does NOT balance: Unreconciled Amount (703000) is PKR ${money(unreconciled)} — declared inflows exceed the growth in net assets, so an outflow is missing (personal expenses, tax already paid, gift given, loan repaid) or an asset was disposed of.`;
  result.message +=
    " The agent did not add or change any figure to force it to zero: FBR treats such a plug as a false declaration. Confirm the missing item with the client, enter it in the correct row, and IRIS will recalculate 703000 itself.";
  return result;
}

/**
 * Compare IRIS's own carried-forward asset position with the approved previous
 * return. `carryForward` is the packet's `wealthCarryForward` block (previous
 * year's closing figures and validated rows).
 *
 * Statuses:
 *  - `not_provided` — the packet carried no approved previous return rows.
 *  - `not_seen`     — 7019 was not on the final tour.
 *  - `carried`      — IRIS's Total Assets already cover the previous close.
 *  - `short`        — the page holds LESS than the approved return closed at,
 *                     so part of the previous position never arrived.
 */
function buildWealthCarryForwardCheck({
  irisTotals,
  parseAmount,
  carryForward,
} = {}) {
  const rows = Array.isArray(carryForward?.rows) ? carryForward.rows : [];
  if (!carryForward || rows.length === 0) {
    return {
      status: "not_provided",
      previousReturnTaxYear: carryForward?.previousReturnTaxYear ?? null,
      message:
        "No approved previous-return Wealth Statement rows are in the packet, so IRIS's carried-forward asset position was not compared.",
    };
  }

  const previousTaxYear = Number(carryForward.previousReturnTaxYear) || null;
  const expectedAssets = Math.round(Number(carryForward.totalAssets) || 0);
  const irisAssets = readAmount(parseAmount, irisTotals?.[WEALTH_CODES.totalAssets]);
  const irisLiabilities = readAmount(
    parseAmount,
    irisTotals?.[WEALTH_CODES.totalLiabilities],
  );
  const result = {
    status: "not_seen",
    previousReturnTaxYear: previousTaxYear,
    expectedAssets,
    irisAssets,
    irisLiabilities,
    businessCapital: readAmount(
      parseAmount,
      irisTotals?.[WEALTH_CODES.businessCapital],
    ),
    rowCount: rows.length,
    message: "",
  };

  if (irisAssets === null) {
    result.message =
      "Total Assets (7019) was not seen on the final tour, so IRIS's carried-forward position could not be compared with the approved previous return. Nothing was typed over.";
    return result;
  }

  const shortfall = expectedAssets - irisAssets;
  if (shortfall <= 1) {
    result.status = "carried";
    result.message =
      irisAssets === expectedAssets
        ? `IRIS carried the approved ${previousTaxYear ? `Tax Year ${previousTaxYear} ` : ""}position forward itself: Total Assets (7019) ${money(irisAssets)}, exactly the ${rows.length} rows the approved return closed at. Nothing was retyped.`
        : `IRIS's Total Assets (7019) ${money(irisAssets)} already include the approved ${previousTaxYear ? `Tax Year ${previousTaxYear} ` : ""}close of ${money(expectedAssets)} plus this year's additions, so nothing was retyped.`;
    return result;
  }

  result.status = "short";
  result.message = `IRIS's Total Assets (7019) are ${money(irisAssets)}, which is ${money(shortfall)} LESS than the approved ${previousTaxYear ? `Tax Year ${previousTaxYear} ` : ""}return closed at (${money(expectedAssets)}). IRIS is meant to carry those rows itself, so check the personal-assets list in FBR and add whatever is missing by hand; the agent typed nothing over what IRIS showed.`;
  return result;
}

module.exports = {
  WEALTH_CODES,
  buildWealthReconciliationCheck,
  buildWealthCarryForwardCheck,
};
