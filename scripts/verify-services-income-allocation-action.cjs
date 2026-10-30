const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;
let activeMock = null;

Module._resolveFilename = function resolveWithAlias(request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolveFilename.call(this, request, ...rest);
};

Module._extensions[".ts"] = function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

Module._load = function loadWithActionMocks(request, parent, isMain) {
  if (request === "@/lib/prisma") {
    if (!activeMock) throw new Error("No active Prisma test fixture");
    return { prisma: activeMock.prisma };
  }
  if (request === "@/lib/auth") return { authOptions: {} };
  if (request === "next-auth/next") {
    return {
      getServerSession: async () => ({ user: { email: "synthetic@example.test" } }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const actionPath = path.join(
  root,
  "app",
  "actions",
  "services-income-allocation.ts",
);

const selections = [
  { subcategory: "1b-service-it-ites" },
  { subcategory: "1b-service-advertising-media" },
];
const ledger = [
  {
    id: "receipt-it",
    category: "SERVICES",
    amount: 125000.25,
    description: "Synthetic IT receipt",
  },
  {
    id: "receipt-advertising",
    category: "PROFESSIONAL SERVICES",
    amount: 75000.10,
    description: "Synthetic advertising receipt",
  },
];
const assignments = [
  { ledgerEntryId: "receipt-it", subcategory: "1b-service-it-ites" },
  {
    ledgerEntryId: "receipt-advertising",
    subcategory: "1b-service-advertising-media",
  },
];

async function runSave({
  incomeSources = ["services"],
  incomeSelections = selections,
  ledgerEntries = ledger,
  input = assignments,
} = {}) {
  const writes = [];
  const draft = {
    id: "synthetic-draft",
    userId: "synthetic-user",
    taxYear: 2026,
    filerType: "myself",
    incomeSources: JSON.stringify(incomeSources),
    incomeSelections,
  };
  const record = (model, method) => async (args) => {
    writes.push({ model, method, args });
    return { count: 1 };
  };
  const tx = {
    filingDraft: {
      findFirst: async () => draft,
      update: record("filingDraft", "update"),
    },
    ledgerEntry: { findMany: async () => ledgerEntries },
    filingIncomeRecord: {
      deleteMany: record("filingIncomeRecord", "deleteMany"),
      createMany: record("filingIncomeRecord", "createMany"),
    },
    filingPacket: { updateMany: record("filingPacket", "updateMany") },
    fbrConnection: { updateMany: record("fbrConnection", "updateMany") },
  };
  const prisma = {
    user: { findUnique: async () => ({ id: draft.userId }) },
    $transaction: async (callback) => callback(tx),
  };

  activeMock = { prisma };
  delete require.cache[actionPath];
  try {
    const action = require(actionPath);
    const result = await action.saveServicesIncomeAllocationsAction(
      draft.id,
      input,
    );
    return { result, writes };
  } finally {
    activeMock = null;
    delete require.cache[actionPath];
  }
}

test("save persists each current receipt once with its selected subcategory", async () => {
  const { result, writes } = await runSave();
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.receiptCount, 2);
  assert.equal(result.servicesIncome, 200000.35);

  const create = writes.find(
    (write) =>
      write.model === "filingIncomeRecord" && write.method === "createMany",
  );
  assert.ok(create);
  assert.equal(create.args.data.length, 2);
  assert.deepEqual(
    create.args.data.map((row) => ({
      subcategory: row.subcategory,
      amount: Number(row.grossAmount),
      origin: row.origin,
      details: JSON.parse(row.detailsJson),
    })),
    [
      {
        subcategory: "1b-service-it-ites",
        amount: 125000.25,
        origin: "LEDGER_ALLOCATION",
        details: { ledgerEntryId: "receipt-it" },
      },
      {
        subcategory: "1b-service-advertising-media",
        amount: 75000.1,
        origin: "LEDGER_ALLOCATION",
        details: { ledgerEntryId: "receipt-advertising" },
      },
    ],
  );

  const draftUpdate = writes.find(
    (write) => write.model === "filingDraft" && write.method === "update",
  );
  assert.equal(draftUpdate.args.data.taxCalculationStatus, "NOT_CALCULATED");
  assert.equal(draftUpdate.args.data.taxCalculationRevision, null);
  assert.equal("reconciliationStatus" in draftUpdate.args.data, false);
  assert.ok(
    writes.some((write) => write.model === "filingPacket"),
    "a packet based on old allocations is superseded",
  );
  assert.ok(
    writes.some((write) => write.model === "fbrConnection"),
    "FBR progress based on old allocations is reset",
  );
});

test("save refuses missing receipt assignments without writing records", async () => {
  const { result, writes } = await runSave({ input: assignments.slice(0, 1) });
  assert.equal(result.success, false);
  assert.match(result.error, /Assign every current Services ledger receipt/);
  assert.equal(
    writes.some((write) => write.model === "filingIncomeRecord"),
    false,
  );
});

test("save refuses duplicate receipt IDs without writing records", async () => {
  const { result, writes } = await runSave({
    input: [assignments[0], assignments[0]],
  });
  assert.equal(result.success, false);
  assert.match(result.error, /only once/);
  assert.equal(
    writes.some((write) => write.model === "filingIncomeRecord"),
    false,
  );
});

test("save refuses unselected categories and requires every selected category to be used", async () => {
  const invalid = await runSave({
    input: [
      assignments[0],
      { ledgerEntryId: "receipt-advertising", subcategory: "1b-service-other" },
    ],
  });
  assert.equal(invalid.result.success, false);
  assert.match(invalid.result.error, /selected for this filing/);
  assert.equal(
    invalid.writes.some((write) => write.model === "filingIncomeRecord"),
    false,
  );

  const uncovered = await runSave({
    input: [
      assignments[0],
      { ledgerEntryId: "receipt-advertising", subcategory: "1b-service-it-ites" },
    ],
  });
  assert.equal(uncovered.result.success, false);
  assert.match(uncovered.result.error, /at least one receipt to every selected Services category/);
});

test("save is Freelancer-only and does not alter tax rules or other income sources", async () => {
  const { result, writes } = await runSave({ incomeSources: ["salary"] });
  assert.equal(result.success, false);
  assert.match(result.error, /only income source is Freelancer \/ Services/);
  assert.equal(writes.length, 0);
});

process.once("exit", () => {
  Module._load = originalLoad;
  Module._resolveFilename = originalResolveFilename;
});
