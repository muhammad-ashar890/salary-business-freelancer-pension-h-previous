/**
 * Diagnostic for the previous-return text parser (run on the PC, not by CI).
 *
 *   node scripts\diag-previous-return-parse.cjs "C:\path\to\return.pdf"
 *
 * Steps through exactly what app/actions/extraction.ts does for a
 * previous_return PDF and prints where it breaks:
 *   1. dynamic import("unpdf")           -> library loads?
 *   2. extractText(pdf)                  -> text layer readable?
 *   3. parseIrisPreviousReturnText(...)  -> printed codes found?
 * The extraction action swallows any of these failures silently and keeps the
 * model's values — this script never swallows.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.log("USAGE: node scripts\\diag-previous-return-parse.cjs \"<path-to-previous-return.pdf>\"");
    process.exit(2);
  }
  console.log("node:", process.version);
  console.log("project:", root);

  // Same TS bootstrap the verify suites use, so we can load lib/tax/*.ts.
  let ts;
  try {
    ts = require("typescript");
  } catch {
    console.log("FAIL: the `typescript` package is not installed here.");
    console.log("  -> run `npm install` in this folder first.");
    process.exit(1);
  }
  require.extensions[".ts"] = (m, f) =>
    m._compile(
      ts.transpileModule(fs.readFileSync(f, "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          esModuleInterop: true,
        },
      }).outputText,
      f,
    );
  const parser = require(path.join(root, "lib", "tax", "previous-return-text.ts"));
  console.log("step 3-ready: parser module loaded from lib\\tax\\previous-return-text.ts");

  let extractText;
  try {
    ({ extractText } = await import("unpdf"));
    console.log('step 1 OK: await import("unpdf") worked');
  } catch (e) {
    console.log('step 1 FAIL: await import("unpdf") threw:');
    console.log(" ", String(e && e.message ? e.message : e));
    console.log("  -> run `npm install` in this folder, then run this script again");
    process.exit(1);
  }

  const buffer = fs.readFileSync(pdfPath);
  console.log("pdf:", pdfPath, `(${buffer.length} bytes)`);
  let pages;
  try {
    const out = await extractText(new Uint8Array(buffer), { mergePages: false });
    pages = Array.isArray(out.text) ? out.text : [String(out.text ?? "")];
    console.log(`step 2 OK: text extracted from ${pages.length} page(s)`);
  } catch (e) {
    console.log("step 2 FAIL: extractText threw:");
    console.log(" ", String(e && e.message ? e.message : e));
    process.exit(1);
  }

  const joined = pages.join("\n");
  const probes = [
    "Wealth Statement",
    "Total Assets",
    "7019",
    "Net Assets Current Year",
    "703001",
    "Reconciliation of Net Assets",
  ];
  console.log("text probes:");
  for (const p of probes) console.log(`   ${joined.includes(p) ? "[x]" : "[ ]"} ${p}`);

  const parse = parser.parseIrisPreviousReturnText(joined, pages[0] ?? "");
  if (!parse) {
    console.log("step 3 FAIL: parseIrisPreviousReturnText returned null (printed totals not unambiguous).");
    console.log("first 12 non-empty lines of page 1:");
    const lines = (pages[0] ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const l of lines.slice(0, 12)) console.log("   |", l.slice(0, 110));
    process.exit(1);
  }
  console.log("step 3 OK: printed facts parsed:");
  console.log("   taxpayerName      :", parse.taxpayerName);
  console.log("   registrationNo    :", parse.registrationNo);
  console.log("   taxYear           :", parse.taxYear);
  console.log("   totalAssets (7019):", parse.totalAssets);
  console.log("   totalLiabilities  :", parse.totalLiabilities, parse.liabilitiesDerived ? "(derived 0)" : "(printed)");
  console.log("   netAssets (703001):", parse.netAssets);
  console.log("   cashInHand (7012) :", parse.cashInHand);
  console.log("   wealthRows        :", parse.wealthRows ? parse.wealthRows.length + " row(s)" : "(none / not tied out)");
  if (parse.wealthRowsNote) console.log("   wealthRowsNote    :", parse.wealthRowsNote);
  console.log("\nIf ALL steps are OK but the web review still shows old values:");
  console.log("  - the dev server must be RESTARTED from this folder (npm run dev)");
  console.log("  - the PDF must be Replaced/re-uploaded AFTER the restart");
  console.log("  - both the dev terminal AND this script must point at the same folder");
}

main().catch((e) => {
  console.log("unexpected diagnostic error:", e);
  process.exit(1);
});
