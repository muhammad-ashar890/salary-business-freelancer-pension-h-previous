"use strict";
/**
 * Diagnostic (27-Oct-2026): "why does Business data review still say Conflicting
 * <label> in reviewed documents?".
 *
 * The browser diagnostic log deliberately does NOT include extraction payloads
 * (rawDocumentContentsIncluded: false), so this script reads them from your own
 * database and prints, for the newest draft:
 *
 *   - every document with its slot type and status;
 *   - every reviewed label that appears in MORE THAN ONE mapped document, with
 *     each document's value side by side (that is the conflict);
 *   - the exact issue texts the Business data review step would build, using the
 *     application's own function (lib/tax/business-document-intake.ts);
 *   - which labels are missing altogether.
 *
 * Change nothing. Read-only.
 *
 *   node scripts/diag-reviewed-business-conflicts.cjs
 *   node scripts/diag-reviewed-business-conflicts.cjs <draftId>
 */
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(
    this,
    request.startsWith("@/") ? path.join(root, request.slice(2)) : request,
    ...rest,
  );
};
require.extensions[".ts"] = (m, file) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    file,
  );

const intake = require("../lib/tax/business-document-intake.ts");
let PrismaClient;
try {
  ({ PrismaClient } = require("@prisma/client"));
} catch {
  console.error("Run this from the project root after `npx prisma generate`.");
  process.exit(1);
}

const norm = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
const isBlank = (value) =>
  value === null || value === undefined || String(value).trim() === "";
const show = (value) => {
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 90 ? `${text.slice(0, 90)}...` : text;
};

(async () => {
  const prisma = new PrismaClient();
  try {
    const draftId = process.argv[2];
    const draft = draftId
      ? await prisma.filingDraft.findFirst({ where: { id: draftId } })
      : await prisma.filingDraft.findFirst({ orderBy: { updatedAt: "desc" } });
    if (!draft) {
      console.log("No filing draft found.");
      return;
    }
    console.log(`Draft ${draft.id} (TY${draft.taxYear}, updated ${draft.updatedAt.toISOString()})`);

    const documents = await prisma.document.findMany({
      where: { filingDraftId: draft.id },
      orderBy: { createdAt: "asc" },
    });
    console.log(`\n${documents.length} document(s):`);
    for (const doc of documents)
      console.log(
        `  ${doc.documentType.padEnd(28)} ${String(doc.extractionStatus).padEnd(11)} ${doc.id}  ${doc.fileName ?? ""}`,
      );

    const mapped = documents.filter((doc) => doc.extractionStatus === "MAPPED");
    console.log(`\nMAPPED: ${mapped.length}`);

    // Every (label -> values) across the mapped documents.
    const byLabel = new Map();
    for (const doc of mapped) {
      let payload;
      try {
        payload = JSON.parse(doc.extractedData ?? "{}");
      } catch {
        console.log(`  ! ${doc.id} (${doc.documentType}) payload is not valid JSON`);
        continue;
      }
      for (const field of Array.isArray(payload.fields) ? payload.fields : []) {
        if (isBlank(field?.value)) continue;
        const key = norm(field.label);
        if (!key) continue;
        const list = byLabel.get(key) ?? [];
        list.push({ label: String(field.label), value: field.value, doc });
        byLabel.set(key, list);
      }
    }

    const shared = [...byLabel.values()].filter((entries) => entries.length > 1);
    console.log(`\nLabels carried by more than one mapped document: ${shared.length}`);
    let conflicts = 0;
    for (const entries of shared) {
      const texts = entries.map((entry) =>
        typeof entry.value === "string" ? entry.value.trim().replace(/\s+/g, " ") : JSON.stringify(entry.value),
      );
      const same = texts.every((text) => text === texts[0]);
      if (same) continue;
      conflicts += 1;
      console.log(`\n  CONFLICT: ${entries[0].label}`);
      for (const entry of entries)
        console.log(`    ${entry.doc.documentType.padEnd(24)} ${entry.doc.id}  = ${show(entry.value)}`);
    }
    console.log(`\nConflicting labels: ${conflicts}`);

    // The application's own verdict, so the fix is aimed at the real cause.
    const selections = await prisma.filingIncomeSelection.findMany({
      where: { filingDraftId: draft.id },
    });
    let saved = {};
    for (const selection of selections) {
      if (selection.source !== "business" || !selection.detailsJson) continue;
      try {
        const parsed = JSON.parse(selection.detailsJson);
        saved = parsed.userDetails ?? parsed;
      } catch {
        console.log(`  ! selection ${selection.id} detailsJson is not valid JSON`);
      }
    }
    const result = intake.readReviewedBusinessFacts(
      mapped.map((doc) => ({
        id: doc.id,
        documentType: doc.documentType,
        extractionStatus: doc.extractionStatus,
        extractedData: doc.extractedData,
      })),
      saved,
    );
    console.log("\nBusiness data review issues (the step's own function):");
    if (!result.issues.length) console.log("  none");
    for (const issue of result.issues) console.log(`  [${issue.key}] ${issue.text}`);
    console.log("\nLabels the saved details say came from documents:");
    console.log(`  ${(result.details.businessDocumentFactKeys ?? []).join(", ") || "(none)"}`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
