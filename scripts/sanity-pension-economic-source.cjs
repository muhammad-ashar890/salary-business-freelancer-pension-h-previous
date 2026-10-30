// Regression guard: pension must gate into Employment/Salary (row 1008 lives there).
// Live-run evidence (2026-10-17): pension gated as "Income from Other Sources" built a
// return WITHOUT the Employment panel -> salary navigation could never verify 1008.
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
let pass = 0;
for (const rel of ["electron-connect/main.js", "electron-connect/iris-navigation.js"]) {
  const src = fs.readFileSync(path.join(root, rel), "utf8");
  if (!/pension:\s*"Income from Salary"/.test(src)) throw new Error(`${rel}: pension not mapped to Income from Salary`);
  if (/pension:\s*"Income from Other Sources"/.test(src)) throw new Error(`${rel}: stale Other Sources mapping remains`);
  pass += 1;
  console.log(`  ok - ${rel}: pension -> Income from Salary`);
}
const codes = fs.readFileSync(path.join(root, "lib/tax/iris-field-codes.ts"), "utf8");
if (!codes.includes('SALARY_PENSION_ANNUITY: { code: "1008"')) throw new Error("pension 1008 rail missing");
if (!codes.includes('portalArea: "Employment", section: "Salary"')) throw new Error("1008 not in Employment/Salary");
pass += 1;
console.log("  ok - iris-field-codes: PENSION -> 1008 Employment/Salary intact");
console.log(`\npension economic-source sanity: ${pass} assertions passed`);