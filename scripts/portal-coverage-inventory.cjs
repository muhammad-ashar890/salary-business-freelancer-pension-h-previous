#!/usr/bin/env node
/**
 * Portal coverage inventory — what this codebase can prove about IRIS's real DOM,
 * and which genuinely UNSEEN pages would close remaining gaps.
 *
 *   npm run inventory:portal-coverage
 *   CAPTURE_DIR=/path/to/new-captures npm run inventory:portal-coverage -- --emit-evidence
 *
 * IMPORTANT CONTRACT RULE:
 *   Once an IRIS row's render & writeability has been proven and recorded in
 *   `lib/tax/portal-row-evidence.ts`, that evidence is PERMANENT. Raw HTML captures
 *   are transient inspection inputs (`rawHtmlPersisted: false`) and NEVER need to
 *   be kept on disk or re-requested for already-recorded codes.
 *
 *   `--emit-evidence` therefore MERGES newly scanned captures additively onto the
 *   existing `PORTAL_ROW_EVIDENCE` baseline by default. Pass `--replace-evidence`
 *   only when intentionally rebuilding the entire table from a full archive.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");
const ts = require("typescript");

const projectRoot = path.join(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(projectRoot, request.slice(2));
  return originalResolve.call(this, request, ...rest);
};
require.extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  module._compile(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText,
    filename,
  );
};

const { IRIS_CODES, CATEGORY_TO_IRIS_MAP } = require(path.join(
  projectRoot,
  "lib/tax/iris-field-codes.ts",
));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const EVIDENCE_PATH = path.resolve(
  arg("evidence", path.join(projectRoot, "lib", "tax", "portal-row-evidence.ts")),
);
const CAPTURE_DIR = arg("captures", process.env.CAPTURE_DIR || path.join(os.homedir(), "uploads"));
const REPLACE_EVIDENCE = process.argv.includes("--replace-evidence");

const CSV_CANDIDATES = [
  arg("csv", ""),
  path.join(CAPTURE_DIR, "IRIS_System_Field_Codes_Extracted.csv"),
  path.join(projectRoot, "IRIS_System_Field_Codes_Extracted.csv"),
].filter(Boolean);
const CSV = CSV_CANDIDATES.find((file) => fs.existsSync(file)) || CSV_CANDIDATES[0];

const ROW_RE = /(?:class="([^"]*)"[^>]*id="(\d+)"|id="(\d+)"[^>]*class="([^"]*)")/g;
function rowMatchCode(match) {
  const className = match[1] || match[4] || "";
  return /(?:^|\s)tableRows(?:\s|$)/.test(className) &&
    /(?:^|\s)dataRow(?:\s|$)/.test(className)
    ? match[2] || match[3]
    : null;
}

function loadSavedEvidence(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    delete require.cache[require.resolve(filePath)];
    const mod = require(filePath);
    return mod.PORTAL_ROW_EVIDENCE || {};
  } catch {
    return {};
  }
}

function readCaptures(dir) {
  const byFile = new Map();
  const all = new Set();
  if (!dir || !fs.existsSync(dir)) return { byFile, seen: all, dirExists: false };
  for (const file of fs.readdirSync(dir).filter((f) => /\.html$/i.test(f))) {
    const html = fs.readFileSync(path.join(dir, file), "utf8");
    const codes = new Set(
      [...html.matchAll(ROW_RE)].map(rowMatchCode).filter(Boolean),
    );
    if (codes.size) {
      byFile.set(file, codes);
      for (const code of codes) all.add(code);
    }
  }
  return { byFile, seen: all, dirExists: true };
}

function readCsvCodes(file) {
  if (!file || !fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const codes = new Set();
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length);
  if (!lines.length) return null;
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const header = lines[0].split(delimiter).map((cell) =>
    cell.trim().replace(/^"|"$/g, "").toLowerCase(),
  );
  const index = header.findIndex(
    (cell) => cell === "system_code" || cell === "code" || cell === "iris_code",
  );
  if (index < 0) return null;
  for (const line of lines.slice(1)) {
    const cells = line.split(delimiter);
    const value = String(cells[index] || "").trim().replace(/^"|"$/g, "");
    if (/^\d{3,10}$/.test(value)) codes.add(value);
  }
  return codes.size ? codes : null;
}

function readRowCells(dir) {
  const rows = new Map();
  if (!dir || !fs.existsSync(dir)) return rows;
  for (const file of fs.readdirSync(dir).filter((f) => /\.html$/i.test(f))) {
    const html = fs.readFileSync(path.join(dir, file), "utf8");
    const rowMatches = [...html.matchAll(ROW_RE)];
    for (const [matchIndex, match] of rowMatches.entries()) {
      const code = rowMatchCode(match);
      if (!code) continue;
      const rowEnd = match.index + match[0].length;
      const nextRow = rowMatches
        .slice(matchIndex + 1)
        .find((candidate) => rowMatchCode(candidate));
      const rowLimit = nextRow?.index ?? rowEnd + 3000;
      const segment = html.slice(rowEnd, rowLimit);
      const inputs = [...segment.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
      const writeable = inputs
        .map((tag, index) =>
          !/disabled/.test(tag) && !/type="hidden"/.test(tag) ? index : null,
        )
        .filter((index) => index !== null);
      const cells = (segment.match(/data-middle-child-wapper/g) || []).length;
      const entry = rows.get(code) || {
        captureCount: 0,
        captures: new Set(),
        inputs: 0,
        writeable: new Set(),
        cells: 0,
      };
      entry.captures.add(file);
      entry.captureCount = entry.captures.size;
      entry.inputs = Math.max(entry.inputs, inputs.length);
      entry.cells = Math.max(entry.cells, cells);
      for (const index of writeable) entry.writeable.add(index);
      rows.set(code, entry);
    }
  }
  return rows;
}

function mergeEvidence(savedEvidence, scannedRows, replace = false) {
  const merged = new Map();
  if (!replace) {
    for (const [code, ev] of Object.entries(savedEvidence || {})) {
      merged.set(String(code), {
        writeable: new Set(
          Array.isArray(ev?.writeableInputIndexes) ? ev.writeableInputIndexes : [],
        ),
        captureCount: Math.max(1, Number(ev?.captureCount) || 1),
      });
    }
  }
  for (const [code, scanned] of scannedRows.entries()) {
    const prev = merged.get(String(code));
    if (!prev) {
      merged.set(String(code), {
        writeable: new Set(scanned.writeable),
        captureCount: Math.max(1, scanned.captureCount || scanned.captures?.size || 1),
      });
    } else {
      const writeable = new Set([...prev.writeable, ...scanned.writeable]);
      merged.set(String(code), {
        writeable,
        captureCount: Math.max(
          prev.captureCount,
          scanned.captureCount || scanned.captures?.size || 1,
        ),
      });
    }
  }
  return merged;
}

function renderEvidenceFile(rows) {
  const lines = [];
  for (const code of [...rows.keys()].sort((a, b) => Number(a) - Number(b))) {
    const entry = rows.get(code);
    lines.push(
      `  "${code}": { writeableInputIndexes: [${[...entry.writeable]
        .sort((a, b) => a - b)
        .join(", ")}], captureCount: ${entry.captureCount} },`,
    );
  }
  return `// GENERATED / MERGE-SAFE EVIDENCE CONTRACT — see scripts/portal-coverage-inventory.cjs.
// Proven IRIS row codes saved here are PERMANENT across sessions (raw HTML captures
// do NOT need to be kept or re-requested once a row's writeability is recorded here).
// Running \`npm run inventory:portal-coverage -- --emit-evidence\` merges new captures
// additively onto this baseline without deleting previously proven codes.

/** What a captured IRIS grid row allowed a human to do. */
export type PortalRowEvidence = {
  /**
   * Indexes of the row's <input> elements that were NOT disabled — the cells a
   * person could actually type into. Empty means the row renders but IRIS
   * computes it, so nothing may be entered there.
   */
  writeableInputIndexes: number[];
  /** How many capture files showed this row (1 = single sighting). */
  captureCount: number;
};

/**
 * Every row id ever observed as a rendered IRIS grid row. ${rows.size} rows from
 * the captures folder as of generation time.
 */
export const PORTAL_ROW_EVIDENCE: Record<string, PortalRowEvidence> = {
${lines.join("\n")}
};

/** Row ids proven writeable — the packet map may only target these. */
export const PORTAL_WRITEABLE_CODES: ReadonlySet<string> = new Set(
  Object.entries(PORTAL_ROW_EVIDENCE)
    .filter(([, evidence]) => evidence.writeableInputIndexes.length > 0)
    .map(([code]) => code),
);

/** Row ids that render but are computed by IRIS: present, never enterable. */
export const PORTAL_DISABLED_CODES: ReadonlySet<string> = new Set(
  Object.entries(PORTAL_ROW_EVIDENCE)
    .filter(([, evidence]) => evidence.writeableInputIndexes.length === 0)
    .map(([code]) => code),
);

export function portalCodeHasCaptureEvidence(code: string): boolean {
  return PORTAL_WRITEABLE_CODES.has(String(code));
}
`;
}

if (require.main === module) {
  const savedEvidence = loadSavedEvidence(EVIDENCE_PATH);
  const savedCodes = new Set(Object.keys(savedEvidence));
  const captures = readCaptures(CAPTURE_DIR);

  if (process.argv.includes("--emit-evidence")) {
    const scannedRows = readRowCells(CAPTURE_DIR);
    if (REPLACE_EVIDENCE && scannedRows.size === 0) {
      console.error(
        `no rendered grid rows under ${CAPTURE_DIR} — refusing --replace-evidence with an empty capture folder`,
      );
      process.exit(1);
    }
    const mergedRows = mergeEvidence(savedEvidence, scannedRows, REPLACE_EVIDENCE);
    if (mergedRows.size === 0) {
      console.error(
        `no saved evidence at ${EVIDENCE_PATH} and no rendered grid rows under ${CAPTURE_DIR}`,
      );
      process.exit(1);
    }
    const before = fs.existsSync(EVIDENCE_PATH)
      ? fs.readFileSync(EVIDENCE_PATH, "utf8")
      : "";
    const after = renderEvidenceFile(mergedRows);
    if (before === after) {
      console.log(
        `\nevidence: unchanged (${mergedRows.size} permanent rows) at ${path.relative(projectRoot, EVIDENCE_PATH)}`,
      );
    } else {
      fs.writeFileSync(EVIDENCE_PATH, after);
      const writeable = [...mergedRows.values()].filter((r) => r.writeable.size).length;
      console.log(
        `\nevidence: wrote ${path.relative(projectRoot, EVIDENCE_PATH)} — ${mergedRows.size} permanent rows ` +
          `(${scannedRows.size} scanned in this run), ${writeable} writeable, ${mergedRows.size - writeable} computed/read-only`,
      );
    }
  }

  const effectiveEvidence = loadSavedEvidence(EVIDENCE_PATH);
  const allProvenCodes = new Set([
    ...Object.keys(effectiveEvidence),
    ...captures.seen,
  ]);

  const catalog = readCsvCodes(CSV);
  const mapped = Object.values(IRIS_CODES);
  const mappedCodes = new Set(mapped.map((c) => c.code));

  const areas = new Map();
  for (const entry of mapped) {
    const area = entry.portalArea || "(unlabelled)";
    if (!areas.has(area)) areas.set(area, { have: [], missing: [], summary: [] });
    const bucket = areas.get(area);
    if (entry.rowLevel === "Summary") bucket.summary.push(entry);
    if (allProvenCodes.has(entry.code)) bucket.have.push(entry);
    else bucket.missing.push(entry);
  }

  console.log("=== IRIS coverage inventory ===");
  console.log(
    `saved contract: ${savedCodes.size} permanent row ids in ${path.relative(projectRoot, EVIDENCE_PATH)}`,
  );
  console.log(
    `live captures:  ${captures.dirExists ? `${CAPTURE_DIR} (${captures.byFile.size} HTML page(s))` : "none needed (using permanent saved contract)"}`,
  );
  console.log(`rows proven:    ${allProvenCodes.size} distinct row ids verified`);
  if (catalog) {
    const unseen = [...catalog].filter((code) => !allProvenCodes.has(code));
    console.log(
      `client csv:     ${catalog.size} codes; ${unseen.length} not yet verified (${((unseen.length / catalog.size) * 100).toFixed(0)}% unverified)`,
    );
    const unmapped = [...catalog].filter((code) => !mappedCodes.has(code));
    console.log(
      `                ${unmapped.length} codes exist in portal extract with no IRIS_CODES entry`,
    );
  }
  console.log(`this map:       ${mapped.length} codes the agent is allowed to write`);

  const writeableCount = mapped.filter(
    (c) => (effectiveEvidence[c.code]?.writeableInputIndexes || []).length > 0,
  ).length;
  const computedCount = mapped.filter(
    (c) =>
      effectiveEvidence[c.code] &&
      (effectiveEvidence[c.code].writeableInputIndexes || []).length === 0,
  ).length;
  const unseenCount = mapped.filter((c) => !effectiveEvidence[c.code]).length;
  console.log(
    `evidence:       ${writeableCount} codes proven enterable (targeted), ` +
      `${unseenCount} never rendered (held as manual-entry), ` +
      `${computedCount} rendered but read-only`,
  );
  console.log("");
  console.log("area                              written-where  verified  deliberately-skipped");
  for (const [area, bucket] of [...areas.entries()].sort()) {
    const skippedSummary = bucket.summary
      .filter((entry) => !allProvenCodes.has(entry.code))
      .map((entry) => entry.code);
    console.log(
      area.padEnd(32) +
        `${String(bucket.have.length).padStart(3)}/${String(bucket.have.length + bucket.missing.length).padEnd(3)}` +
        `          ${(bucket.missing.length === 0 ? "complete" : `${bucket.missing.length} gap(s)`).padEnd(12)}` +
        `${skippedSummary.length ? `summary rows never rendered: ${skippedSummary.join(", ")}` : "—"}`,
    );
  }

  const NEEDS = [
    {
      page: "Property receipts / deductions (Income from Property)",
      unlocks: ["2001", "2031"],
      note: "rent receipts and the 1/5th repair deduction; 2000/2029/2099 are computed and must stay unwritten",
    },
    {
      page: "Other Sources receipts (bank profit, dividends, annuity)",
      unlocks: ["500312", "5003041", "5005", "5007", "5028"],
      note: "this is what today turns BANK_PROFIT/DIVIDEND into a reported gap instead of a fill",
    },
    {
      page: "Capital Gain (securities held long term and short term)",
      unlocks: ["4006", "4016", "4017", "4026", "4036", "4037"],
      note: "net-gain rows are derived — the capture shows which of the six are enterable",
    },
    {
      page: "Adjustable Tax grid: bank profit / imports / 231AB / 236C / 236K / 236Y rows",
      unlocks: [
        "64040002",
        "64040001",
        "64080001",
        "64010002",
        "64100101",
        "64150301",
        "64151101",
      ],
      note: "tax-deduction credits other than already-captured rows stay manual until seen",
    },
    {
      page: "116 Wealth Statement non-bank asset modals (immovable property / investments / vehicles)",
      unlocks: ["7001", "7002", "7006", "7008"],
      note: "core 116 reconciliation, expenses, 7098 outflow, 7037 gift & 7030 bank modals are ALREADY captured; only non-bank asset modals remain",
    },
  ];

  const unresolved = NEEDS.filter((item) =>
    item.unlocks.some((code) => !allProvenCodes.has(code)),
  );
  if (unresolved.length) {
    console.log("");
    console.log("=== genuinely uncaptured pages (already-saved codes NEVER need re-capture) ===");
    for (const item of unresolved) {
      const stillMissing = item.unlocks.filter((code) => !allProvenCodes.has(code));
      console.log(`\n${item.page}`);
      console.log(`  missing codes: ${stillMissing.join(", ")}`);
      console.log(`  why:           ${item.note}`);
    }
  }
}

module.exports = {
  loadSavedEvidence,
  readCaptures,
  readRowCells,
  mergeEvidence,
  renderEvidenceFile,
};
