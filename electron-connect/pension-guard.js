// Defense in depth: the server validates source freshness before handing out a
// pinned context. The desktop repeats the narrow packet contract because it is
// the last process allowed to type into a live IRIS return.
const PENSION_GUARD_BUILD_TAG = "services-picker-aliases-20261105d";

function pensionEntryHold(snapshot) {
  const hasPension =
    Array.isArray(snapshot?.filing?.incomeSources) &&
    snapshot.filing.incomeSources.includes("pension");
  if (!hasPension && !snapshot?.pension) return null;

  const source = snapshot?.pension;
  let message;
  if (
    source?.version !== "pension-source-v1" ||
    !/^[a-f0-9]{64}$/.test(source?.fingerprint || "")
  ) {
    message =
      "This old pension packet has no approved annual-source contract. Recalculate, regenerate and approve a new packet. Nothing was changed in FBR.";
  } else if (
    !["exempt", "exempt_age70", "salary", "final_above_10m"].includes(
      source.treatment,
    ) ||
    !Number.isFinite(source.taxDeducted) ||
    source.taxDeducted < 0 ||
    // A pension charged on the salary slabs ("still working for the former
    // employer") is a section 149 deduction like any other salary withholding,
    // so a positive figure is expected there and must land on 64020004 (see
    // the column check below). Every other treatment may not carry one.
    (source.treatment !== "final_above_10m" &&
      source.treatment !== "salary" &&
      source.taxDeducted > 0)
  ) {
    message =
      "Pension treatment or actual withholding is not verified by the approved source. Recalculate and approve a fresh pension packet before portal entry. Nothing was changed in FBR.";
  } else {
    const detailed =
      snapshot.portalFieldMapDetailed ||
      (!Array.isArray(snapshot.portalFieldMap)
        ? snapshot.portalFieldMap
        : null);
    const fields = Array.isArray(snapshot.portalFieldMap)
      ? snapshot.portalFieldMap
      : [
          ...(Array.isArray(detailed?.incomeFields)
            ? detailed.incomeFields
            : []),
          ...(Array.isArray(detailed?.adjustableTaxFields)
            ? detailed.adjustableTaxFields
            : []),
        ];
    const match = (irisCode, column, value) => {
      const rows = Array.isArray(fields)
        ? fields.filter(
            (field) =>
              String(field.irisCode) === irisCode && field.column === column,
          )
        : [];
      return (
        rows.length === 1 &&
        Number(rows[0].value ?? rows[0].ourAmount) === value
      );
    };
    const annual = Number(source.annualPension);
    const fingerprintMatches =
      detailed?.computationHints?.pensionSourceFingerprint === source.fingerprint;

    if (source.treatment === "final_above_10m") {
      const excess = Math.max(0, annual - 10_000_000);
      const baseTax = Math.round(excess * 0.05);
      const surcharge = Math.round(baseTax * 0.1);
      if (
        !(annual > 10_000_000) ||
        !fingerprintMatches ||
        source.baseTax !== baseTax ||
        source.surcharge !== surcharge ||
        source.taxDue !== baseTax + surcharge ||
        !match("1008", "Total Amount", annual) ||
        !match("1008", "Subject to Final Tax", excess) ||
        !match("1008", "Subject to Exemption", 10_000_000) ||
        !match("64020007", "Taxable Amount", excess) ||
        !match("64020007", "Tax Deducted", Number(source.taxDeducted)) ||
        !match("923184", "Total Income", surcharge) ||
        detailed?.mappingGaps?.pensionManualReview
      ) {
        message =
          "Pension final-tax autofill contract is incomplete. Regenerate a reviewed packet with the PKR 10 million exemption, excess-only Final/64020007 base and Section 4AB surcharge. Nothing was changed in FBR.";
      }
    } else {
      const expectedExempt = source.treatment === "salary" ? 0 : annual;
      // Salary treatment: the payer withheld section 149 tax, and its portal home
      // is the adjustable-tax row the salary certificate already uses. The
      // packet must carry that credit, exactly once, and must not mix in the
      // final-tax row that belongs to the 149(IA) treatment.
      //
      // The same row must also state a Taxable Amount at least equal to the
      // credit. IRIS refuses the cell pair otherwise, live: "Tax Deducted on
      // Salary cannot be greater than the Total Amount" (30-Oct-2026). The
      // ordinary salary route is fed by row 1009 and the portal derives that
      // cell itself; a pension charged as salary arrives on row 1008, so the
      // packet has to carry the base explicitly.
      const salaryBase = (() => {
        const rows = fields.filter(
          (field) =>
            String(field.irisCode) === "64020004" &&
            field.column === "Taxable Amount",
        );
        if (rows.length !== 1) return null;
        return Number(rows[0].value ?? rows[0].ourAmount);
      })();
      const salaryCreditOk =
        source.treatment !== "salary" ||
        (Number(source.taxDeducted) > 0
          ? match(
              "64020004",
              "Tax Collected / Deducted",
              Number(source.taxDeducted),
            ) &&
            salaryBase !== null &&
            Number.isFinite(salaryBase) &&
            salaryBase >= Number(source.taxDeducted) &&
            fields.filter((field) => String(field.irisCode) === "64020007")
              .length === 0
          : fields.filter((field) => String(field.irisCode) === "64020004")
              .length === 0);
      if (
        !(annual > 0) ||
        !fingerprintMatches ||
        !match("1008", "Total Amount", annual) ||
        !match("1008", "Subject to Exemption", expectedExempt) ||
        !match("1008", "Subject to Final Tax", 0) ||
        !salaryCreditOk
      ) {
        message =
          source.treatment === "salary" && Number(source.taxDeducted) > 0
            ? "Pension worked as salary: the packet must carry the section 149 credit on 64020004 (Tax Collected / Deducted) for the exact amount withheld, its Taxable Amount on the same row, and no final-tax row. Regenerate the approved packet, then start filing again. Nothing was changed in FBR."
            : "Pension source/column contract is incomplete. Regenerate a reviewed packet with verified Total, Exemption and Final columns before portal entry. Nothing was changed in FBR.";
      }
    }
  }

  if (!message) return null;
  return {
    paused: true,
    pauseAction: "portal_state_confirmation",
    pauseMessage: message,
    executionLog: [],
    result: {
      mode: "pension_contract_review",
      requiredAction: "portal_state_confirmation",
      message,
      pensionCoverage: "contract_incomplete",
      reviewRequired: true,
      readyToSubmit: false,
      submitted: false,
      pension: source
        ? {
            annualPension: source.annualPension,
            treatment: source.treatment,
            baseTax: source.baseTax,
            surcharge: source.surcharge,
            taxDeducted: source.taxDeducted,
            taxDue: source.taxDue,
          }
        : null,
      summary: { total: 0, entered: 0, skipped: 0, failed: 0 },
    },
  };
}
module.exports = { PENSION_GUARD_BUILD_TAG, pensionEntryHold };
