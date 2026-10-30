const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const oldResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  return oldResolve.call(
    this,
    request.startsWith('@/') ? path.join(root, request.slice(2)) : request,
    ...args,
  );
};
for (const extension of ['.ts', '.tsx']) {
  require.extensions[extension] = (module, filename) =>
    module._compile(
      ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          jsx: ts.JsxEmit.ReactJSX,
          esModuleInterop: true,
          resolveJsonModule: true,
        },
      }).outputText,
      filename,
    );
}

const lists = require('../lib/tax/business-list-fields.ts');
const { BUSINESS_FACT_LABELS: L } = require('../lib/tax/business-document-intake.ts');

const rows = {
  [L.businessBankAccounts]: [
    { iban: 'PK35HABB0018067900476803', balance: 3350000 },
  ],
  [L.businessVehicles]: [
    {
      registrationNo: 'LEA-26-1001',
      chassisNo: 'NZE260TEST2026',
      make: 'Toyota',
      model: 'Corolla',
      value: 2400000,
    },
  ],
  [L.businessProperties]: [
    {
      balanceRow: 'land',
      propertyType: 'Commercial Property',
      propertySubType: 'Open Plot',
      acquisitionDate: '2020-01-15',
      areaUnit: 'Kanal',
      landArea: 2,
      acquisitionCost: 4000000,
      province: 'Punjab',
      district: 'Lahore',
      city: 'Lahore',
      propertyNo: 'Plot 12',
      sectorMohallaBlock: 'Block A',
      value: 6000000,
    },
  ],
  [L.businessDepreciationSchedule]: [
    {
      code: '33030105',
      wdvBroughtForward: 5000000,
      additionNew: 1200000,
      additionNewExtent: 100,
    },
  ],
  [L.businessTaxDeductions]: [
    {
      regime: 'adjustable',
      code: '64060116',
      taxableAmount: 2500000,
      taxDeducted: 200000,
    },
  ],
  [L.businessAddBacks]: [
    { code: '3212', amount: 80000 },
  ],
  [L.businessLossesByYear]: [
    { year: 2025, amount: 400000 },
  ],
};
const field = (label, value) => ({ label, value, confidence: 1 });

test('server presentation turns stored JSON strings into structured rows for the browser', () => {
  const payload = {
    fields: Object.entries(rows).map(([label, value]) =>
      field(label, JSON.stringify(value)),
    ),
  };
  const presented = lists.presentBusinessListFields(payload, 2026);
  assert.equal(presented.fields.length, 7);
  for (const presentedField of presented.fields) {
    assert.equal(Array.isArray(presentedField.value), true, presentedField.label);
  }
  assert.equal(
    presented.fields.find((entry) => entry.label === L.businessBankAccounts)
      .value[0].balance,
    3350000,
  );
});

test('reviewed structured rows are canonicalized back to stored JSON on the server', () => {
  const payload = {
    fields: Object.entries(rows).map(([label, value]) => field(label, value)),
  };
  const stored = lists.normalizeBusinessListFieldsForStorage(payload, 2026);
  assert.deepEqual(stored.errors, []);
  for (const storedField of stored.payload.fields) {
    assert.equal(typeof storedField.value, 'string', storedField.label);
    assert.deepEqual(JSON.parse(storedField.value), rows[storedField.label]);
  }
});

test('unknown stays null while an explicitly empty source list stays empty', () => {
  const payload = {
    fields: [
      field(L.businessVehicles, null),
      field(L.businessBankAccounts, []),
    ],
  };
  const stored = lists.normalizeBusinessListFieldsForStorage(payload, 2026);
  assert.deepEqual(stored.errors, []);
  assert.equal(stored.payload.fields[0].value, null);
  assert.equal(stored.payload.fields[1].value, '[]');
});

test('unreadable JSON and duplicate lists are blocking, human-readable errors', () => {
  const bad = lists.businessListFieldErrors(
    [field(L.businessBankAccounts, 'not json')],
    2026,
  );
  assert.equal(bad.length, 1);
  assert.match(bad[0], /Business bank accounts/);
  assert.match(bad[0], /Enter the rows/);

  const duplicate = lists.businessListFieldErrors(
    [
      field(L.businessLossesByYear, []),
      field(L.businessLossesByYear, []),
    ],
    2026,
  );
  assert.match(duplicate.join(' '), /duplicate extracted lists/);
});

test('an incomplete but readable row is a completion warning, not unreadable JSON', () => {
  const parsed = lists.parseBusinessListField(L.businessVehicles, [
    { registrationNo: 'LEA-1', make: '', model: '', value: 100 },
  ], 2026);
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.warnings.some((warning) => /enter the make/.test(warning)));
  const property = lists.parseBusinessListField(L.businessProperties, [
    { balanceRow: 'land', propertyNo: 'Plot 12' },
  ], 2026);
  assert.deepEqual(property.errors, []);
  assert.ok(property.warnings.some((warning) => /enter the city exactly as IRIS lists it/.test(warning)));
});

test('the row editor keeps a half-typed row instead of sanitizing it away', () => {
  const partial = [{ regime: 'adjustable', code: '' }];
  const got = lists.readBusinessListRows(L.businessTaxDeductions, partial);
  assert.equal(got.readable, true);
  assert.deepEqual(got.rows, partial);
});

test('business-support review gets visible placeholders for every simple fact and list', () => {
  const got = lists.ensureBusinessFactReviewFields({ fields: [] });
  const labels = got.fields.map((entry) => entry.label);
  for (const label of Object.values(L)) assert.ok(labels.includes(label), label);
  assert.equal(lists.BUSINESS_LIST_FIELD_DEFINITIONS.length, 7);
  assert.ok(
    lists.BUSINESS_LIST_FIELD_DEFINITIONS.every(
      (definition) => !/JSON/.test(definition.displayLabel),
    ),
  );
});

test('the browser uses row editors and the mapped Books action becomes a disabled Mapped state', () => {
  const documentsStep = fs.readFileSync(
    path.join(root, 'components/tax/filing/wizard-documents-step.tsx'),
    'utf8',
  );
  const manual = fs.readFileSync(
    path.join(root, 'components/tax/filing/manual-business-record.tsx'),
    'utf8',
  );
  const action = fs.readFileSync(
    path.join(root, 'app/actions/extraction.ts'),
    'utf8',
  );

  assert.match(documentsStep, /<BusinessListFieldEditor/);
  assert.match(documentsStep, /businessListErrors\.length > 0/);
  assert.match(documentsStep, /reviewRequiredErrors\.length > 0/);
  assert.match(documentsStep, /!purchaseBasisMissing \? \(/);
  assert.match(documentsStep, /<CheckCircle2[^>]+>\s*Mapped/);
  assert.ok(!documentsStep.includes('{(!isMapped || purchaseBasisNeeded) && ('));
  assert.match(manual, /isBusinessListFieldLabel\(label\)/);
  assert.match(manual, /requiredErrors\.length > 0/);
  assert.ok(!manual.includes("label.endsWith('JSON')"));
  assert.match(action, /presentBusinessListFields\(reviewReadyExtraction\)/);
  assert.match(action, /normalizeBusinessListFieldsForStorage\(/);
  assert.match(action, /const listErrors = businessListFieldErrors\(fields\)/);
});
