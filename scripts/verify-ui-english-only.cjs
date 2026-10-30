#!/usr/bin/env node
/**
 * Every string a taxpayer can read, and every code comment, is English
 * (28-Oct-2026, operator rule: "sirf hm communicate kreingy bs urdu mn baqi sb
 * english hoga code comments bhi english hongy").
 *
 * The scan covers components/, app/, lib/ and electron-connect/. It looks for
 * Roman-Urdu function words, which do not occur in English prose. A word list
 * rather than a dictionary keeps it honest: an English sentence cannot contain
 * "nahi", "chahiye" or "ke liye".
 *
 * The sales-tax suite already had the same idea for its own copy; this covers
 * the whole app so a Roman-Urdu line cannot ship again.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");

const root = path.join(__dirname, "..");

const WORDS = [
  "hai", "nahi", "nahin", "kya", "kro", "krdo", "krna", "krne", "karein",
  "karen", "mujhe", "apna", "aap", "yeh", "woh", "bina", "puchy", "abhi",
  "lekin", "matlab", "matlb", "chahiye", "hoga", "hogi", "jayega", "jaye",
  "liye", "sirf", "baqi", "dono", "sahi", "bhi", "phir", "raha", "rahi",
  "warna", "humein", "lagta", "batayein", "dikhayein", "theek", "thik",
  "zaroor", "lazmi", "mojood", "pohanch", "hogya", "banaya", "banti", "karna",
  "karne", "karta", "karti", "kiya", "jata", "jati", "karke", "rahe", "hua",
  "hui", "aisa", "jaise", "wala", "wali", "kaam", "batata", "poore", "poora",
];
const PATTERN = new RegExp(
  `(?<![A-Za-z])(${[...WORDS].sort((a, b) => b.length - a.length).join("|")})(?![A-Za-z])`,
  "i",
);

const DIRS = ["components", "app", "lib", "electron-connect"];
const SKIP_DIRS = new Set(["node_modules", ".next", "out", "dist", "build"]);
const SKIP_FILES = new Set(["verify-ui-english-only.cjs", "verify-sales-tax-rules.cjs"]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry.name) && !SKIP_FILES.has(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function offencesIn(file) {
  const text = fs.readFileSync(file, "utf8");
  const offences = [];
  for (const line of text.split(/\r?\n/)) {
    const at = PATTERN.exec(line);
    if (at) offences.push({ word: at[1].toLowerCase(), line: line.trim().slice(0, 140) });
  }
  return offences;
}

test("no Roman Urdu in the app's screens, comments or desktop agent", () => {
  const files = DIRS.flatMap((dir) => walk(path.join(root, dir)));
  assert.ok(files.length > 50, `expected to scan the app sources, got ${files.length} files`);

  const offenders = [];
  for (const file of files) {
    const offences = offencesIn(file);
    if (!offences.length) continue;
    offenders.push({
      file: path.relative(root, file),
      words: [...new Set(offences.map((o) => o.word))],
      first: offences[0].line,
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Roman Urdu found in the app:\n${offenders
      .map((o) => `  ${o.file} (${o.words.join(", ")}): ${o.first}`)
      .join("\n")}`,
  );
});

test("the scanner really detects Roman Urdu", () => {
  const sample = "// ye line ghalat hai, is liye fix karein";
  assert.ok(PATTERN.test(sample), "the word list must catch a Roman Urdu line");
  assert.equal(PATTERN.test("The tax is calculated from the filer status."), false);
  assert.equal(PATTERN.test("Share the hardware inventory with the supplier."), false);
});

test("the History card speaks English", () => {
  const list = fs.readFileSync(
    path.join(root, "components/tax/filing-history-list.tsx"),
    "utf8",
  );
  // JSX wraps the sentence across lines and splits it around the amount, so
  // compare on a flattened copy with the interpolation collapsed.
  const flat = list.replace(/\s+/g, " ");
  for (const sentence of [
    "They are separate returns: nothing was deleted or overwritten.",
    "Already deducted at source: PKR",
    "That is why the amount still payable is lower, or zero.",
  ]) {
    assert.ok(flat.includes(sentence), `History card is missing: ${sentence}`);
  }
});
