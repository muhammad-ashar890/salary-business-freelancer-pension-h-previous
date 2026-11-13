"use strict";
// P2 drift guard for the Freelancer / Services gate list.
//
// The supported-source-set rule is written by hand in three places (the packet
// gate, the packet builder and the desktop agent). This test pins that all three
// accept the same five sets, so widening one without the others fails here
// instead of producing a packet the agent refuses to open.
//
// It reads the source files only; it never imports the app.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (relative) =>
  fs.readFileSync(path.join(root, ...relative.split("/")), "utf8");

const GATE_FILES = [
  "lib/tax/business-bank-categories.ts",
  "lib/tax/business-filing.ts",
  "electron-connect/main.js",
];

/** Every gate file must name the newly supported set, in code or in its message. */
const REQUIRED_MENTIONS = [
  "Services alone",
  "Salary + Services",
  "Pension + Services",
  "Business + Services",
  "Salary + Business + Services",
  "Salary + Pension + Services",
];

test("every Freelancer / Services gate names the same six source sets", () => {
  for (const file of GATE_FILES) {
    const source = read(file);
    for (const label of REQUIRED_MENTIONS) {
      assert.ok(
        source.includes(label),
        `${file} must mention "${label}" -- the gate lists are drifting apart.`,
      );
    }
  }
});

test("the packet gate and the desktop agent accept Business + Services", () => {
  const packetGate = read("lib/tax/business-bank-categories.ts");
  assert.match(
    packetGate,
    /normalized\[0\] === "business" &&\s*\n?\s*normalized\[1\] === "services"/,
    "isFreelancerIncomeSelected must accept the exact Business + Services set",
  );

  const agent = read("electron-connect/main.js");
  assert.match(
    agent,
    /const businessAndServices =\s*\n\s*uniqueSources\.length === 2 &&\s*\n\s*uniqueSources\[0\] === "business" &&\s*\n\s*uniqueSources\[1\] === "services";/,
    "getServicesPacketRoute must derive businessAndServices the same way",
  );
  assert.match(
    agent,
    /servicesOnly \|\| salaryAndServices \|\| pensionAndServices \|\| businessAndServices/,
    "the agent's `exact` check must include businessAndServices",
  );
  assert.match(
    agent,
    /businessIncluded: businessAndServices/,
    "the agent must report businessIncluded so downstream phases can branch on it",
  );
});

test("Business + Services is named by every gate file, code or message", () => {
  // A gate that recognises the set but never tells the taxpayer about it is how
  // this combination got stuck before: the packet gate, the packet builder and
  // the desktop agent each carried their own copy of the list.
  for (const file of [...GATE_FILES, "app/actions/packet.ts", "app/actions/bank-classification.ts"]) {
    const source = read(file);
    assert.ok(
      source.includes("Business + Services"),
      `${file} still does not name Business + Services anywhere`,
    );
  }
});

test("setup names every supported route and retains the unsupported-combination block", () => {
  const wizard = read("components/tax/filing/filing-wizard.tsx");
  assert.ok(
    wizard.includes("unsupportedServicesSelection"),
    "filing-wizard.tsx must retain the unsupportedServicesSelection block",
  );
  for (const file of ["components/tax/filing/filing-wizard.tsx",
                      "components/tax/filing/wizard-setup-step.tsx"]) {
    const source = read(file);
    assert.ok(source.includes("Business + Services"), `${file} must name Business + Services`);
    assert.ok(source.includes("Salary + Business + Services"), `${file} must name Salary + Business + Services`);
  }
});

test("the contract that pins Services rows is untouched by the gate change", () => {
  // verify-services-phase6-electron.cjs hashes this file; widening a gate must
  // never edit the captured IRIS contract as a side effect.
  const contract = read("electron-connect/iris-services-contract.json");
  for (const code of ["3101", "3128"]) {
    assert.ok(
      contract.includes(`"${code}"`),
      `the Services contract must still pin row ${code}`,
    );
  }
  assert.match(contract, /"businessOtherRevenues"/);
});
