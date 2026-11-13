"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const vm = require("node:vm");

// Render the actual completion-card functions with an inert JSX renderer.
// No browser, server, live account or network is involved.
function renderHandoffCompletion(overrides = {}) {
  const source = fs.readFileSync(
    path.join(__dirname, "../components/tax/fbr-connect-client.tsx"),
    "utf8",
  );
  const parsed = ts.createSourceFile(
    "completion.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const functions = parsed.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      ["HandoffRow", "HandoffCompleteCard"].includes(node.name?.text),
  );
  assert.equal(functions.length, 2);
  const code = ts.transpileModule(
    functions.map((node) => node.getText(parsed)).join("\n"),
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } },
  ).outputText;
  const context = {
    React: {
      createElement: (type, props, ...children) =>
        typeof type === "function"
          ? type({ ...props, children })
          : { type, props, children },
    },
    Card: "card",
    CardHeader: "header",
    CardTitle: "title",
    CardContent: "content",
    CheckCircle: "icon",
    Button: "button",
    scope: {
      salary: "filled",
      employers: "listed",
      wealthStatement: "entered_not_calculated",
      wealthRows: 4,
      propertyPaymentsComputations: "pending",
      readyToSubmit: false,
      manualItems: [],
      manualUnchecked: [],
      ...overrides,
    },
  };
  vm.createContext(context);
  const tree = vm.runInContext(
    `${code}\nHandoffCompleteCard({scope, finishedAt: null, onStartOver: () => {}})`,
    context,
  );
  const text = [];
  const icons = [];
  const blockTexts = [];
  const nodeText = (node) => {
    if (Array.isArray(node)) return node.map(nodeText).join(" ");
    if (node && typeof node === "object") return nodeText(node.children);
    return typeof node === "string" ? node : "";
  };
  function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      if (node.type === "icon") icons.push(node.props);
      if (node.type === "span" && /\bblock\b/.test(node.props?.className || "")) {
        blockTexts.push(nodeText(node));
      }
      walk(node.children);
    } else if (typeof node === "string") text.push(node);
  }
  walk(tree);
  return { text: text.join(" "), icons, blockTexts };
}

const tripleScope = {
  route: {
    id: "salary_business_services",
    label: "Salary + Business + Freelancer / Services",
    incomeSources: ["salary", "business", "services"],
  },
  business: {
    route: "business",
    status: "partial_manual_required",
    preparedFields: 32,
    filledFields: 32,
    pendingItems: [],
  },
  businessDetails: { required: true, verified: true },
  salaryFields: { total: 2, filled: 2, skipped: 0 },
  services: { preparedFields: 3, filledFields: 3, skippedFields: 0 },
  save: {
    clicked: true,
    status: "saved_no_message",
    afterSave: { complete: true, match: 39, mismatch: 0, notSeen: 0 },
  },
  wealthReconciliationCheck: { status: "reconciled", unreconciled: 0 },
};

test("triple-route field entry is green and full-sized while manual FBR review remains", () => {
  const { text, icons, blockTexts } = renderHandoffCompletion(tripleScope);
  assert.match(text, /Salary \+ Business \+ Freelancer \/ Services approved field entry completed/);
  assert.deepEqual(blockTexts.slice(0, 2), [
    "Salary + Business + Freelancer / Services approved field entry completed.",
    "Final review remains in FBR.",
  ]);
  assert.doesNotMatch(text, /Resolve the items below; this is not submission-ready/);
  assert.match(text, /Business — manual return review remains/);
  assert.match(text, /Review in FBR/);
  assert.match(icons[0].className, /text-emerald-600/);
  assert.match(icons[0].className, /h-5 w-5 shrink-0/);
});

test("an actual Wealth gap still blocks green completion", () => {
  const { text, icons } = renderHandoffCompletion({
    ...tripleScope,
    wealthReconciliationCheck: {
      status: "gap",
      unreconciled: -20000,
      gapSide: "missing_outflow",
    },
  });
  assert.match(text, /Resolve the items below; this is not submission-ready/);
  assert.match(icons[0].className, /text-amber-600/);
});

test("route wording remains source-derived for Salary + Services", () => {
  const { text } = renderHandoffCompletion({
    route: {
      id: "salary_services",
      label: "Salary + Freelancer / Services",
      incomeSources: ["salary", "services"],
    },
    business: {
      route: "services_tax_deduction",
      status: "complete",
      preparedFields: 8,
      filledFields: 8,
      pendingItems: [],
    },
    salaryFields: { total: 2, filled: 2, skipped: 0 },
  });
  assert.match(text, /Salary \+ Freelancer \/ Services approved field entry completed/);
  assert.doesNotMatch(text, /Business \+ Freelancer/);
});
