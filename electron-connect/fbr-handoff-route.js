"use strict";

/**
 * Source-of-truth route identity for Electron logs, the TXT report and the
 * browser handoff. Save policy and IRIS section names are deliberately not
 * inputs: neither one defines which approved income sources were filed.
 */
const SOURCE_ORDER = Object.freeze(["salary", "business", "pension", "services"]);
const SOURCE_LABELS = Object.freeze({
  salary: "Salary",
  business: "Business",
  pension: "Pension",
  services: "Freelancer / Services",
});

function buildFbrHandoffRoute(incomeSources) {
  const selected = new Set(
    (Array.isArray(incomeSources) ? incomeSources : [])
      .map((source) => String(source || "").trim().toLowerCase())
      .filter((source) => Object.hasOwn(SOURCE_LABELS, source)),
  );
  const sources = SOURCE_ORDER.filter((source) => selected.has(source));
  return {
    id: sources.length ? sources.join("_") : "unscoped",
    label: sources.length
      ? sources.map((source) => SOURCE_LABELS[source]).join(" + ")
      : "FBR return",
    incomeSources: sources,
  };
}

module.exports = { buildFbrHandoffRoute };
