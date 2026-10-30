#!/usr/bin/env node
/**
 * Why does History show two Salary filings for one tax year, and where did the
 * Pension filing go?
 *
 * The History page lists every draft of the logged-in user: no cap, no filter.
 * "Filing 4 of 4 for this year" is just an ordinal, not a limit. So a filing can
 * only be missing from that screen if its row is not in the database for this
 * user any more, or if its income sources were rewritten by a later save.
 *
 * This script prints, for every user and every draft on the database:
 *   - tax year, status, created/updated, current step
 *   - the stored income sources
 *   - the documents on the draft (a Pension statement sitting on a Salary draft
 *     is the fingerprint of a draft that was rewritten, not deleted)
 *   - the packets and their versions
 * and then groups the same-year drafts so a duplicate source is obvious.
 *
 * Run it from the project folder (the .env with DATABASE_URL must be there):
 *   node scripts\diag-filing-history.cjs
 */
"use strict";

const fs = require("fs");
const path = require("path");

// The Next.js app reads .env itself; a plain node script has to do it here.
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

const LABELS = {
  salary: "Salary",
  pension: "Pension",
  property_rent: "Rental income",
  services: "Freelancer",
  bank_profit: "Bank profit",
  dividend: "Dividend",
  capital_gains: "Capital gains",
  business: "Business income",
  agriculture: "Agriculture",
  foreign_income_assets: "Non-resident",
  aop_company_links: "AOP / Company",
  sales_tax_fed_withholding: "Sales tax / FED",
  other_income: "Other income",
};

function sources(stored) {
  try {
    const parsed = JSON.parse(stored || "[]");
    if (!Array.isArray(parsed)) return { raw: String(stored), labels: [] };
    return {
      raw: parsed.join(","),
      labels: parsed.map((s) => LABELS[String(s)] || String(s)),
    };
  } catch {
    return { raw: String(stored), labels: [] };
  }
}

const when = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) : "-");
const money = (v) => (v === null || v === undefined ? "-" : Number(v).toLocaleString("en-US"));

async function main() {
  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      select: { id: true, email: true },
      orderBy: { email: "asc" },
    });
    if (!users.length) {
      console.log("No users on this database.");
      return;
    }
    for (const user of users) {
      const drafts = await prisma.filingDraft.findMany({
        where: { userId: user.id },
        orderBy: [{ taxYear: "desc" }, { createdAt: "asc" }],
        include: {
          documents: {
            select: {
              documentType: true,
              fileName: true,
              extractionStatus: true,
              createdAt: true,
            },
          },
          filingPackets: {
            select: { version: true, approvalStatus: true, taxPayable: true, refundDue: true },
            orderBy: { version: "asc" },
          },
          fbrConnections: { select: { status: true } },
        },
      });

      console.log("");
      console.log("=".repeat(96));
      console.log(`USER ${user.email}`);
      console.log(`drafts on this database: ${drafts.length}`);
      console.log("=".repeat(96));

      if (!drafts.length) {
        console.log("  (none — this database has no filings for this user)");
        continue;
      }

      const byYear = new Map();
      for (const draft of drafts) {
        const group = byYear.get(draft.taxYear) || [];
        group.push(draft);
        byYear.set(draft.taxYear, group);
      }

      for (const [taxYear, group] of [...byYear.entries()].sort((a, b) => b[0] - a[0])) {
        console.log("");
        console.log(`TAX YEAR ${taxYear} — ${group.length} filing(s)`);
        group.forEach((draft, index) => {
          const src = sources(draft.incomeSources);
          console.log("");
          console.log(`  Filing ${index + 1} of ${group.length}`);
          console.log(`    id            ${draft.id}`);
          console.log(`    status        ${draft.status}   step ${draft.currentStep}/${draft.wizardCompletionStep}`);
          console.log(`    created       ${when(draft.createdAt)}     updated ${when(draft.updatedAt)}`);
          console.log(`    income        ${src.labels.join(", ") || "(empty)"}   [${src.raw}]`);
          console.log(`    filer         ${draft.filerType || "-"}   residency ${draft.residencyStatus || "-"}`);
          console.log(`    approval      packetApprovalConfirmed=${draft.packetApprovalConfirmed}   taxPayable=${money(draft.taxPayable)}`);
          console.log(
            `    packets       ${draft.filingPackets.length
              ? draft.filingPackets
                  .map((p) => `v${p.version}/${p.approvalStatus}/tax ${money(p.taxPayable)}`)
                  .join("  ")
              : "(none)"}`,
          );
          console.log(
            `    fbr           ${draft.fbrConnections.length
              ? [...new Set(draft.fbrConnections.map((c) => c.status))].join(", ")
              : "(none)"}`,
          );
          if (!draft.documents.length) {
            console.log("    documents     (none)");
          } else {
            console.log(`    documents     ${draft.documents.length}`);
            for (const doc of draft.documents) {
              console.log(
                `      - ${doc.documentType}  "${doc.fileName}"  ${doc.extractionStatus}  ${when(doc.createdAt)}`,
              );
            }
          }
        });

        // Duplicate source in one year, and documents that do not belong to the
        // income sources the draft now claims.
        const seen = new Map();
        for (const [index, draft] of group.entries()) {
          const key = sources(draft.incomeSources).labels.join("+") || "(empty)";
          if (!seen.has(key)) seen.set(key, []);
          seen.get(key).push(index + 1);
        }
        const dupes = [...seen.entries()].filter(([, list]) => list.length > 1);
        if (dupes.length) {
          console.log("");
          for (const [key, list] of dupes) {
            console.log(
              `  !! same income source twice in TY${taxYear}: "${key}" in Filing ${list.join(" and Filing ")}`,
            );
          }
        }

        for (const [index, draft] of group.entries()) {
          const src = sources(draft.incomeSources).labels.join(",").toLowerCase();
          const pensionDocs = draft.documents.filter(
            (d) => /pension/i.test(d.fileName) || /pension/i.test(d.documentType),
          );
          if (pensionDocs.length && !src.includes("pension")) {
            console.log(
              `  !! Filing ${index + 1} is "${src || "empty"}" but holds ${pensionDocs.length} pension document(s): ${pensionDocs
                .map((d) => d.fileName)
                .join(", ")}`,
            );
            console.log(
              "     → this draft was rewritten by a later save, it is not a new filing",
            );
          }
          if (src.includes("pension") && !pensionDocs.length) {
            console.log(
              `  ?? Filing ${index + 1} says Pension but has no pension document on it`,
            );
          }
        }
      }

      // Documents with no draft at all (orphans) are invisible on History.
      const orphans = await prisma.document.count({
        where: { userId: user.id, filingDraftId: null },
      });
      console.log("");
      console.log(`documents not attached to any filing: ${orphans}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("diag failed:", error && error.message ? error.message : error);
  process.exitCode = 1;
});
