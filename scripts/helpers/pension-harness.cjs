// Shared real-action pension fixtures. Database/session/reconciliation are doubles;
// the pension parser, source resolver, calculator, completeness, packet and map stay real.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { Prisma } = require("@prisma/client");
const root = path.resolve(__dirname, "../..");
const compiled = new Map();
function loader(mocks) {
  const cache = new Map();
  function load(name, parent = root) {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    const absolute = name.startsWith("@/")
      ? path.join(root, name.slice(2))
      : name.startsWith(".")
        ? path.resolve(parent, name)
        : path.isAbsolute(name)
          ? name
          : null;
    if (!absolute) return require(name);
    const file = [
      absolute,
      `${absolute}.ts`,
      `${absolute}.tsx`,
      `${absolute}.js`,
    ].find(
      (candidate) =>
        fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
    );
    if (!file) throw new Error(`Fixture module not found: ${absolute}`);
    if (cache.has(file)) return cache.get(file).exports;
    if (file.endsWith(".json"))
      return JSON.parse(fs.readFileSync(file, "utf8"));
    const module = { exports: {} };
    cache.set(file, module);
    if (!compiled.has(file))
      compiled.set(
        file,
        ts.transpileModule(fs.readFileSync(file, "utf8"), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            esModuleInterop: true,
            jsx: ts.JsxEmit.ReactJSX,
          },
          fileName: file,
        }).outputText,
      );
    vm.runInNewContext(
      compiled.get(file),
      {
        console,
        Date,
        Error,
        TypeError,
        SyntaxError,
        Buffer,
        TextEncoder,
        TextDecoder,
        process,
        URL,
        FormData,
        File: require("node:buffer").File,
        module,
        exports: module.exports,
        require: (child) => load(child, path.dirname(file)),
      },
      { filename: file },
    );
    return module.exports;
  }
  return (name) => load(path.join(root, name));
}
function pensionFields(amount = 10_992_000, changes = {}) {
  const values = {
    "Tax Year": 2026,
    "Gross Pension (Annual PKR)": 10_488_000,
    "Medical Allowance (Annual PKR)": 504_000,
    "Net Pension Payable (Annual PKR)": 10_992_000,
    "Approved Pension Amount for Tax (Annual PKR)": amount,
    "Pension Tax Deducted (Annual PKR)": 0,
    "Pension Withholding Already in Tax Ledger (Annual PKR)": 0,
    "Pension Tax Base Review Note":
      "QA: reviewed annual pension and allowance treatment; bank receipts remain cash evidence.",
    ...changes,
  };
  return Object.entries(values).map(([label, value]) => ({ label, value }));
}
const match = (row, where = {}) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object") {
      if (Object.hasOwn(v, "not")) return row[k] !== v.not;
      if (Object.hasOwn(v, "in")) return v.in.includes(row[k]);
      return true;
    }
    return row[k] === v;
  });
function harness({
  pension = 10_992_000,
  ledgerPension = 1_989_000,
  dob = "1962-03-15",
  answer = false,
  status = "MAPPED",
  fields = pensionFields(pension),
  salary = 0,
  ledgerTax = 0,
  modelResponse = null,
  extractionFileBuffer = null,
} = {}) {
  const common = { filingDraftId: "qa-draft", userId: "qa-user" };
  const state = {
    modelCalls: [],
    fileReads: [],
    user: {
      id: "qa-user",
      cnic: null,
      dateOfBirth: dob === null ? null : new Date(`${dob}T00:00:00Z`),
    },
    draft: {
      id: "qa-draft",
      userId: "qa-user",
      taxYear: 2026,
      filerType: "myself",
      residencyStatus: "resident",
      incomeSources: JSON.stringify(
        salary ? ["pension", "salary"] : ["pension"],
      ),
      readinessChecks: "[]",
      taxWithheld: new Prisma.Decimal(0),
      packetApprovalConfirmed: true,
      incomeSelections: [
        {
          ...common,
          source: "pension",
          subcategory: "former-employer-or-associate",
          status: "SELECTED",
          detailsJson: JSON.stringify({
            userDetails: { worksForFormerEmployerOrAssociate: answer },
          }),
        },
        ...(salary
          ? [
              {
                ...common,
                source: "salary",
                subcategory: "salary",
                status: "SELECTED",
                detailsJson: "{}",
              },
            ]
          : []),
      ],
    },
    documents: [
      {
        id: "qa-pension-doc",
        ...common,
        createdAt: new Date("2026-10-19T00:00:00Z"),
        documentType: "pension_statement",
        bankAccountId: null,
        extractionStatus: status,
        extractedData: JSON.stringify({ fields }),
        fileName: "synthetic-pension.pdf",
      },
      {
        id: "qa-cnic",
        ...common,
        documentType: "cnic",
        extractionStatus: "MAPPED",
        extractedData: "{}",
      },
      {
        id: "qa-bank-doc",
        ...common,
        documentType: "bank_statement",
        bankAccountId: "qa-bank",
        extractionStatus: "MAPPED",
        extractedData: "{}",
      },
      ...(salary
        ? [
            {
              id: "qa-salary",
              ...common,
              documentType: "salary_certificate",
              extractionStatus: "MAPPED",
              extractedData: JSON.stringify({
                fields: [
                  { label: "Gross Salary", value: salary },
                  { label: "Tax Deducted u/s 149", value: 0 },
                  { label: "Tax Year", value: 2026 },
                  {
                    label: "Employer Name (as registered with FBR)",
                    value: "QA employer",
                  },
                ],
              }),
            },
          ]
        : []),
    ],
    entries: [
      {
        id: "qa-income",
        ...common,
        entryType: "INCOME",
        category: "PENSION",
        amount: new Prisma.Decimal(ledgerPension),
        description: "QA pension cash credit",
        sourceDocumentId: null,
      },
      ...(salary
        ? [
            {
              id: "qa-salary-income",
              ...common,
              entryType: "INCOME",
              category: "SALARY",
              amount: new Prisma.Decimal(salary),
              description: "QA salary cash credit",
            },
          ]
        : []),
      ...(ledgerTax
        ? [
            {
              id: "qa-tax",
              ...common,
              entryType: "EXPENSE",
              category: "TAX_PAYMENT",
              amount: new Prisma.Decimal(ledgerTax),
              description: "QA actual deducted tax",
            },
          ]
        : []),
    ],
    lines: [],
    packets: [],
    updates: [],
    ledgerWrites: [],
    cancelledJobs: 0,
    accounts: [
      {
        id: "qa-bank",
        ...common,
        bankName: "QA",
        accountLabel: "QA",
        iban: "PK36SCBL0000001123456702",
        currency: "PKR",
      },
    ],
    statements: [
      {
        id: "qa-statement",
        ...common,
        bankAccountId: "qa-bank",
        sourceDocumentId: "qa-bank-doc",
        currency: "PKR",
        periodStart: new Date("2025-07-01T00:00:00Z"),
        periodEnd: new Date("2026-06-30T00:00:00Z"),
      },
    ],
    transactions: [
      {
        id: "qa-transaction",
        ...common,
        bankAccountId: "qa-bank",
        bankStatementId: "qa-statement",
        transactionDate: new Date("2026-06-30T00:00:00Z"),
        description: "QA pension",
        credit: new Prisma.Decimal(ledgerPension),
        debit: null,
        classificationStatus: "APPROVED",
        suggestedEntryType: "INCOME",
        suggestedCategory: "PENSION",
      },
    ],
  };
  const sortedDocs = (where) =>
    state.documents
      .filter((d) => match(d, where))
      .sort(
        (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
      );
  const prisma = {
    user: {
      upsert: async () => ({ ...state.user }),
      findUnique: async () => ({ ...state.user }),
      update: async ({ data }) => {
        Object.assign(state.user, data);
        return { ...state.user };
      },
    },
    filingDraft: {
      findMany: async ({ where = {} } = {}) =>
        state.draft.status === "FILED" ||
        (where.incomeSources?.contains &&
          !state.draft.incomeSources.includes(where.incomeSources.contains))
          ? []
          : [{ ...state.draft }],
      findFirst: async () => ({
        ...state.draft,
        incomeSelections: state.draft.incomeSelections.map((s) => ({ ...s })),
      }),
      findUnique: async () => ({
        ...state.draft,
        incomeSelections: state.draft.incomeSelections.map((s) => ({ ...s })),
      }),
      updateMany: async ({ data }) => {
        Object.assign(state.draft, data);
        return { count: 1 };
      },
      update: async ({ data }) => {
        state.updates.push(data);
        Object.assign(state.draft, data);
        return state.draft;
      },
    },
    document: {
      updateMany: async ({ where, data }) => {
        const accepts = (row, query) => {
          const { OR, ...rest } = query;
          return (
            match(row, rest) &&
            (!OR || OR.some((branch) => accepts(row, branch)))
          );
        };
        const rows = state.documents.filter((row) => accepts(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
      create: async ({ data }) => {
        const d = {
          id: "qa-upload-replacement",
          createdAt: new Date("2026-10-19T02:00:00Z"),
          extractedData: null,
          ...data,
        };
        state.documents.push(d);
        return { ...d };
      },
      delete: async ({ where }) => {
        state.documents = state.documents.filter((d) => d.id !== where.id);
        return {};
      },
      findFirst: async ({ where = {} } = {}) => {
        const d = sortedDocs(where)[0];
        return d ? { ...d } : null;
      },
      findMany: async ({ where = {} } = {}) => sortedDocs(where),
      update: async ({ where, data }) => {
        const d = state.documents.find((d) => d.id === where.id);
        if (!d) throw new Error("Missing fixture document");
        Object.assign(d, data);
        return d;
      },
    },
    ledgerEntry: {
      findMany: async () => state.entries,
      deleteMany: async ({ where }) => {
        state.ledgerWrites.push(where);
        state.entries = state.entries.filter((e) => !match(e, where));
        return { count: 0 };
      },
    },
    filingIncomeSelection: {
      findMany: async ({ where = {} } = {}) =>
        state.draft.incomeSelections.filter((s) => match(s, where)),
      deleteMany: async () => {
        state.draft.incomeSelections = [];
        return { count: 0 };
      },
      createMany: async ({ data }) => {
        state.draft.incomeSelections = data;
        return { count: data.length };
      },
    },
    bankAccount: { findMany: async () => state.accounts },
    bankStatement: { findMany: async () => state.statements },
    bankTransaction: { findMany: async () => state.transactions },
    filingTaxCalculationLine: {
      deleteMany: async () => {
        state.lines = [];
        return { count: 0 };
      },
      createMany: async ({ data }) => {
        state.lines = data;
        return { count: data.length };
      },
      findMany: async ({ where = {} } = {}) =>
        state.lines.filter((l) => match(l, where)),
    },
    filingTaxCredit: { findMany: async () => [] },
    filingPacket: {
      findFirst: async ({ where = {} } = {}) =>
        [...state.packets].reverse().find((p) => match(p, where)) ?? null,
      updateMany: async ({ where, data }) => {
        state.packets
          .filter((p) => match(p, where))
          .forEach((p) => Object.assign(p, data));
        return { count: 0 };
      },
      update: async ({ where, data }) => {
        const p = state.packets.find((p) => p.id === where.id);
        Object.assign(p, data);
        return p;
      },
      create: async ({ data }) => {
        const p = {
          id: `qa-packet-${state.packets.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
        state.packets.push(p);
        return p;
      },
    },
    fbrConnection: { updateMany: async () => ({ count: 0 }) },
    localAgentJob: {
      updateMany: async () => {
        state.cancelledJobs++;
        return { count: 1 };
      },
    },
    $executeRaw: async () => 0,
    $transaction: async (fn) => fn(prisma),
  };
  const load = loader({
    "fs/promises": {
      ...require("node:fs/promises"),
      mkdir: async () => {},
      readFile: async (file, ...args) => {
        if (
          extractionFileBuffer &&
          path.basename(String(file)) === "synthetic-pension.pdf"
        ) {
          state.fileReads.push(String(file));
          return Buffer.from(extractionFileBuffer);
        }
        return require("node:fs/promises").readFile(file, ...args);
      },
      writeFile: async (_path, bytes) => {
        state.pdfBuffer = Buffer.from(bytes);
      },
    },
    "@google/generative-ai": {
      GoogleGenerativeAI: class {
        getGenerativeModel() {
          return {
            generateContent: async (parts) => {
              if (!modelResponse)
                throw new Error("Unexpected Gemini call in offline fixture");
              state.modelCalls.push(parts);
              return {
                response: { text: () => JSON.stringify(modelResponse) },
              };
            },
          };
        }
      },
    },
    "next/server": {
      NextResponse: {
        json: (data, options = {}) => ({ data, status: options.status ?? 200 }),
      },
    },
    "next-auth/next": {
      getServerSession: async () => ({ user: { email: "qa@example.invalid" } }),
    },
    "next/cache": { revalidatePath: () => {} },
    "@/lib/auth": { authOptions: {} },
    "@/lib/prisma": { prisma },
    "@/app/actions/notifications": { createNotification: async () => {} },
    "@/app/actions/bank-parser": {
      extractStructuredBankDocumentAction: async () => {
        throw new Error("Unexpected bank parser");
      },
    },
    "@/lib/rate-limit": { consumeRateLimit: () => ({ allowed: true }) },
    "@/lib/tax/reconciliation-calculation": {
      validateAuthoritativeReconciliation: async () => ({
        success: true,
        preview: { accountBalances: [], netCashMovement: 0 },
      }),
    },
  });
  return {
    state,
    load,
    prisma,
    extract: () =>
      load("app/actions/extraction.ts").extractDocumentWithGeminiAction(
        "qa-pension-doc",
      ),
    calculate: () =>
      load("app/actions/tax-calculation.ts").calculateTaxAction(
        "qa-draft",
        "ATL",
      ),
    approve: () =>
      load("app/actions/extraction.ts").approveAndMapExtractedDocumentAction(
        "qa-pension-doc",
      ),
    edit: (raw) =>
      load("app/actions/extraction.ts").updateDocumentExtractionAction(
        "qa-pension-doc",
        raw,
      ),
    generate: async (options) => {
      state.draft.packetApprovalConfirmed = true;
      return load("app/actions/packet.ts").generateFilingPacketAction(
        "qa-draft",
        options,
      );
    },
    completeness: () =>
      load("lib/tax/filing-completeness.ts").validateFilingCompleteness({
        draftId: "qa-draft",
        userId: "qa-user",
      }),
  };
}
module.exports = { harness, pensionFields, root };
