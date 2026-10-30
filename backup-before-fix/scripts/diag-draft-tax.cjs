#!/usr/bin/env node
/**
 * Why is a filing approved with tax 0?
 *
 * Filing 4 (28-Oct, Salary) is APPROVED_FOR_FILING with packet tax 0, while the
 * salary certificate on it states PKR 2,400,000 gross and PKR 162,000 deducted.
 * Nothing here changes data: every step is a SELECT.
 *
 * It prints, for one filing (default: the newest one that is not the filed
 * return):
 *   - the draft's own figures and statuses
 *   - the income records the calculation is built from
 *   - the tax credits / withholding
 *   - the latest calculation revision, line by line
 *   - every packet and the figures inside its snapshot
 *   - the documents and the numbers extracted from them
 *
 * Run from the project folder:
 *   node scripts\diag-draft-tax.cjs                 (newest draft)
 *   node scripts\diag-draft-tax.cjs cmvrz1tse004o2   (a specific draft id)
 */
"use strict";

const fs = require("fs");
const path = require("path");

(function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
})();

const { PrismaClient } = require("@prisma/client");

const num = (v) => (v === null || v === undefined ? null : Number(v));
const show = (v) => (v === null || v === undefined ? "-" : typeof v === "number" ? v.toLocaleString("en-US") : String(v));
const when = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) : "-");

function json(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}

function printFieldMap(snapshot) {
  if (!snapshot) return;
  const map = snapshot.portalFieldMapDetailed || snapshot.portalFieldMap;
  if (!map) return;
  const groups = ["incomeFields", "adjustableTaxFields", "wealthFields"];
  for (const group of groups) {
    const list = map[group];
    if (!Array.isArray(list) || !list.length) continue;
    console.log(`    ${group}`);
    for (const field of list) {
      if (!/^(1009|1008|64020004|64020007|923184|7030|7019|703001|703002|703003|703000|9200|7049|7099)$/.test(String(field.irisCode))) continue;
      console.log(
        `      ${String(field.irisCode).padEnd(9)} ${String(field.column || "").padEnd(24)} our ${show(num(field.ourAmount))}${field.irisAmount !== undefined ? `  iris ${show(num(field.irisAmount))}` : ""}`,
      );
    }
  }
}

async function main() {
  const prisma = new PrismaClient();
  const wanted = (process.argv[2] || "").trim();
  try {
    const draft = wanted
      ? await prisma.filingDraft.findFirst({ where: { id: { startsWith: wanted } } })
      : await prisma.filingDraft.findFirst({ orderBy: { updatedAt: "desc" } });
    if (!draft) {
      console.log("No filing draft found.");
      return;
    }

    console.log("=".repeat(90));
    console.log(`DRAFT ${draft.id}`);
    console.log("=".repeat(90));
    console.log(`  tax year            ${draft.taxYear}`);
    console.log(`  status              ${draft.status}   step ${draft.currentStep}/${draft.wizardCompletionStep}`);
    console.log(`  created / updated   ${when(draft.createdAt)}  →  ${when(draft.updatedAt)}`);
    console.log(`  income sources      ${draft.incomeSources}`);
    console.log(`  filer / residency   ${show(draft.filerType)} / ${show(draft.residencyStatus)}`);
    console.log(`  taxpayer list       ${show(draft.taxpayerListStatus)} (${show(draft.taxpayerListStatusSource)})`);
    console.log("");
    console.log("  FIGURES ON THE DRAFT");
    console.log(`    taxable income      ${show(num(draft.taxableIncome))}`);
    console.log(`    tax withheld        ${show(num(draft.taxWithheld))}`);
    console.log(`    tax payable         ${show(num(draft.taxPayable))}`);
    console.log(`    refund due          ${show(num(draft.refundDue))}`);
    console.log(`    calc status         ${draft.taxCalculationStatus}`);
    console.log(`    rule set / revision ${show(draft.taxRuleSetVersion)} / ${show(draft.taxCalculationRevision)}`);
    console.log(`    packet approved     ${draft.packetApprovalConfirmed}  at ${when(draft.packetApprovalAt)}`);
    console.log(`    reconciliation      ${draft.reconciliationStatus}  gap ${show(num(draft.reconciliationGap))}`);

    const incomes = await prisma.filingIncomeRecord.findMany({
      where: { filingDraftId: draft.id },
      orderBy: { createdAt: "asc" },
    });
    console.log("");
    console.log(`  INCOME RECORDS (${incomes.length})`);
    for (const row of incomes) {
      console.log(
        `    ${row.source}/${row.subcategory}  gross ${show(num(row.grossAmount))}  taxable ${show(num(row.taxableAmount))}  ${row.recordStatus}  origin ${row.origin}`,
      );
      const details = json(row.detailsJson);
      if (details && Object.keys(details).length) {
        console.log(`      details ${JSON.stringify(details).slice(0, 300)}`);
      }
    }
    if (!incomes.length) {
      console.log("    (none — the calculation has no income to tax)");
    }

    const selections = await prisma.filingIncomeSelection.findMany({
      where: { filingDraftId: draft.id },
      orderBy: { createdAt: "asc" },
    });
    console.log("");
    console.log(`  INCOME SELECTIONS (${selections.length})`);
    for (const row of selections) {
      console.log(`    ${row.source}/${row.subcategory}  ${row.status}  ${String(row.detailsJson || "").slice(0, 160)}`);
    }

    const credits = await prisma.filingTaxCredit.findMany({
      where: { filingDraftId: draft.id },
      orderBy: { createdAt: "asc" },
    });
    console.log("");
    console.log(`  TAX CREDITS / WITHHOLDING (${credits.length})`);
    for (const row of credits) {
      console.log(
        `    ${row.section} ${row.source}/${row.subcategory}  ${show(num(row.amount))}  treatment ${row.treatment}  status ${row.creditStatus}  origin ${row.origin}`,
      );
    }

    const lines = await prisma.filingTaxCalculationLine.findMany({
      where: { filingDraftId: draft.id },
      orderBy: { createdAt: "asc" },
    });
    console.log("");
    console.log(`  CALCULATION LINES (${lines.length})`);
    for (const row of lines) {
      console.log(
        `    rev ${row.calculationRevision} ${row.ruleId} ${row.section} ${row.source}/${row.subcategory} filer ${row.filerStatusUsed}: base ${show(num(row.taxBase))} → calculated ${show(num(row.calculatedTax))} +surcharge ${show(num(row.surcharge))} -credit ${show(num(row.taxCreditApplied))} = payable ${show(num(row.taxPayable))}`,
      );
    }
    if (!lines.length) {
      console.log("    (none — tax was never calculated for this draft)");
    }

    const packets = await prisma.filingPacket.findMany({
      where: { filingDraftId: draft.id },
      orderBy: { version: "asc" },
    });
    console.log("");
    console.log(`  PACKETS (${packets.length})`);
    for (const packet of packets) {
      console.log(
        `    v${packet.version}  ${packet.approvalStatus}  tax ${show(num(packet.taxPayable))}  refund ${show(num(packet.refundDue))}  created ${when(packet.createdAt)}`,
      );
      const snapshot = json(packet.snapshotJson);
      if (snapshot) {
        const tf = snapshot.taxFigures || snapshot.tax || {};
        console.log(
          `      snapshot: totalIncome ${show(num(tf.totalIncome ?? snapshot.totalIncome))} taxableIncome ${show(num(tf.taxableIncome ?? snapshot.taxableIncome))} taxPayable ${show(num(tf.taxPayable ?? snapshot.taxPayable))} filerStatus ${show(tf.filerStatus ?? snapshot.filerStatus)}`,
        );
        printFieldMap(snapshot);
      }
    }

    const documents = await prisma.document.findMany({
      where: { filingDraftId: draft.id },
      orderBy: { createdAt: "asc" },
    });
    console.log("");
    console.log(`  DOCUMENTS (${documents.length})`);
    for (const doc of documents) {
      console.log(`    ${doc.documentType}  "${doc.fileName}"  ${doc.extractionStatus}`);
      const data = json(doc.extractedData);
      if (!data) continue;
      const flat = JSON.stringify(data);
      const interesting = [];
      for (const key of ["gross", "grossSalary", "salary", "taxDeducted", "tax", "amount", "total"]) {
        const at = flat.toLowerCase().indexOf(`"${key.toLowerCase()}"`);
        if (at >= 0) interesting.push(flat.slice(at, at + 90));
        if (interesting.length >= 4) break;
      }
      if (interesting.length) console.log(`      numbers ${interesting.join(" | ")}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("diag failed:", error && error.message ? error.message : error);
  process.exitCode = 1;
});
