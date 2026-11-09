"use strict";

/**
 * Self-contained Sales Tax monthly contract fixtures (`month-2026-06`,
 * `month-2026-07`, `month-2026-08`), built directly from `lib/sales-tax/rules/fbr-goods/reference.ts`
 * so the 5 sales-tax verification suites run with zero external files in `test-fixtures/`.
 */

const { load } = require("./sales-tax-test-kit.cjs");
const { SALES_TEMPLATE, PURCHASE_TEMPLATE } = load(
  "lib/sales-tax/rules/fbr-goods/reference.ts",
);
const { SALES_COLUMNS, PURCHASE_COLUMNS } = load(
  "lib/sales-tax/template-reader.ts",
);

const REGISTRATION_NO = "1000000000000";
const SALES_VERSION = "1.0.44";
const PURCHASE_VERSION = "1.0.29";

function buildGrid(template, kind, version, period, dataRows) {
  const mm = String(period.month).padStart(2, "0");
  const headerRows = template.headerRows.map((row) => row.slice());
  headerRows[1][2] = REGISTRATION_NO;
  headerRows[1][5] = `${period.year}-${mm}-01`;
  headerRows[2][1] = `${REGISTRATION_NO}-01/${mm}/${period.year}_~_${kind}_~_${version}`;
  headerRows[2][9] = 0;
  return [...headerRows, ...dataRows];
}

function saleRow(sr, overrides) {
  const r = new Array(31).fill(null);
  r[SALES_COLUMNS.sr] = sr;
  r[SALES_COLUMNS.partyRegistrationNo] = "1234567";
  r[SALES_COLUMNS.partyName] = "Al-Noor Traders";
  r[SALES_COLUMNS.partyType] = "Registered";
  r[SALES_COLUMNS.originProvince] = "SINDH";
  r[SALES_COLUMNS.destinationProvince] = "SINDH";
  r[SALES_COLUMNS.documentType] = "Sale Invoice";
  r[SALES_COLUMNS.documentNo] = `INV-${sr}`;
  r[SALES_COLUMNS.documentDate] = "2026-08-10";
  r[SALES_COLUMNS.saleType] = "Goods at standard rate (default)";
  r[SALES_COLUMNS.rate] = 0.18;
  for (const [k, v] of Object.entries(overrides || {})) {
    r[SALES_COLUMNS[k]] = v;
  }
  return r;
}

function purchaseRow(sr, overrides) {
  const r = new Array(31).fill(null);
  r[PURCHASE_COLUMNS.sr] = sr;
  r[PURCHASE_COLUMNS.partyRegistrationNo] = "9988776";
  r[PURCHASE_COLUMNS.partyName] = "Sindh Wholesale";
  r[PURCHASE_COLUMNS.partyType] = "Registered";
  r[PURCHASE_COLUMNS.originProvince] = "SINDH";
  r[PURCHASE_COLUMNS.destinationProvince] = "SINDH";
  r[PURCHASE_COLUMNS.documentType] = "Purchase Invoice";
  r[PURCHASE_COLUMNS.documentNo] = `PI-${sr}`;
  r[PURCHASE_COLUMNS.documentDate] = "2026-08-05";
  r[PURCHASE_COLUMNS.purchaseType] = "Goods at standard rate (default)";
  r[PURCHASE_COLUMNS.rate] = 0.18;
  for (const [k, v] of Object.entries(overrides || {})) {
    r[PURCHASE_COLUMNS[k]] = v;
  }
  return r;
}

const MONTHS = {
  "month-2026-08": {
    _note: "SYNTHETIC contract fixture — August 2026 FBR Goods return",
    registrationNo: REGISTRATION_NO,
    period: { year: 2026, month: 8 },
    salesGrid: buildGrid(SALES_TEMPLATE, "DSI", SALES_VERSION, { year: 2026, month: 8 }, [
      saleRow(1, {
        partyRegistrationNo: "1234567",
        partyName: "Al-Noor Traders",
        documentNo: "INV-801",
        documentDate: "2026-08-04",
        value: 450000,
        salesTax: 81000,
      }),
      saleRow(2, {
        partyRegistrationNo: "2345678",
        partyName: "Karachi Industrial Supply",
        documentNo: "INV-802",
        documentDate: "2026-08-11",
        value: 275500,
        salesTax: 49590,
      }),
      saleRow(3, {
        partyRegistrationNo: "3456789",
        partyName: "Mehran Packaging",
        documentNo: "INV-803",
        documentDate: "2026-08-18",
        value: 124250.5,
        salesTax: 22365.09,
      }),
      saleRow(4, {
        partyRegistrationNo: "4210112345671",
        partyName: "Tariq General Store",
        partyType: "Unregistered",
        documentNo: "INV-804",
        documentDate: "2026-08-24",
        value: 80000,
        salesTax: 14400,
        furtherTax: 3200,
      }),
    ]),
    purchaseGrid: buildGrid(PURCHASE_TEMPLATE, "DPI", PURCHASE_VERSION, { year: 2026, month: 8 }, [
      purchaseRow(1, {
        partyRegistrationNo: "9988776",
        partyName: "Sindh Wholesale",
        documentNo: "PI-801",
        documentDate: "2026-08-03",
        value: 300000,
        salesTax: 54000,
      }),
      purchaseRow(2, {
        partyRegistrationNo: "8877665",
        partyName: "Indus Raw Materials",
        documentNo: "PI-802",
        documentDate: "2026-08-14",
        value: 180400,
        salesTax: 32472,
      }),
      purchaseRow(3, {
        partyRegistrationNo: "4220198765431",
        partyName: "Local Packing Vendor",
        partyType: "Unregistered",
        documentNo: "PI-803",
        documentDate: "2026-08-20",
        rate: 0.18,
        value: 50000,
        salesTax: 0,
      }),
    ]),
    imports: [],
    exports: [],
    adjustments: {},
    capitalGoodsRows: [],
  },

  "month-2026-07": {
    _note: "SYNTHETIC contract fixture — July 2026 FBR Goods return (withholding + capital goods + carry-forward)",
    registrationNo: REGISTRATION_NO,
    period: { year: 2026, month: 7 },
    salesGrid: buildGrid(SALES_TEMPLATE, "DSI", SALES_VERSION, { year: 2026, month: 7 }, [
      saleRow(1, {
        partyRegistrationNo: "1234567",
        partyName: "Al-Noor Traders",
        documentNo: "INV-701",
        documentDate: "2026-07-06",
        value: 2000000,
        salesTax: 360000,
      }),
      saleRow(2, {
        partyRegistrationNo: "2345678",
        partyName: "Karachi Industrial Supply",
        documentNo: "INV-702",
        documentDate: "2026-07-15",
        value: 1500000,
        salesTax: 270000,
        stWithheld: 40000,
      }),
      saleRow(3, {
        partyRegistrationNo: "1234567",
        partyName: "Al-Noor Traders",
        documentType: "Credit Note",
        documentNo: "CN-701",
        documentDate: "2026-07-25",
        value: 100000,
        salesTax: 18000,
        invoiceRefNo: "INV-701",
        reason: "Return of goods",
      }),
    ]),
    purchaseGrid: buildGrid(PURCHASE_TEMPLATE, "DPI", PURCHASE_VERSION, { year: 2026, month: 7 }, [
      purchaseRow(1, {
        partyRegistrationNo: "9988776",
        partyName: "Sindh Wholesale",
        documentNo: "PI-701",
        documentDate: "2026-07-08",
        value: 2500000,
        salesTax: 450000,
      }),
      purchaseRow(2, {
        partyRegistrationNo: "7766554",
        partyName: "Precision Machinery Ltd",
        documentNo: "PI-702",
        documentDate: "2026-07-19",
        value: 1000000,
        salesTax: 180000,
      }),
    ]),
    imports: [],
    exports: [],
    adjustments: {
      creditBroughtForwardRupees: 25000,
    },
    capitalGoodsRows: [7],
  },

  "month-2026-06": {
    _note: "SYNTHETIC contract fixture — June 2026 FBR Goods return (exports + imports + refund claim)",
    registrationNo: REGISTRATION_NO,
    period: { year: 2026, month: 6 },
    salesGrid: buildGrid(SALES_TEMPLATE, "DSI", SALES_VERSION, { year: 2026, month: 6 }, [
      saleRow(1, {
        partyRegistrationNo: "1234567",
        partyName: "Al-Noor Traders",
        documentNo: "INV-601",
        documentDate: "2026-06-12",
        value: 200000,
        salesTax: 36000,
      }),
    ]),
    purchaseGrid: buildGrid(PURCHASE_TEMPLATE, "DPI", PURCHASE_VERSION, { year: 2026, month: 6 }, [
      purchaseRow(1, {
        partyRegistrationNo: "9988776",
        partyName: "Sindh Wholesale",
        documentNo: "PI-601",
        documentDate: "2026-06-09",
        value: 900000,
        salesTax: 162000,
      }),
    ]),
    imports: [
      {
        gdNo: "KAPE-HC-10234-2026",
        gdDate: "2026-06-10",
        taxableValueRupees: 500000,
        salesTaxPaidRupees: 90000,
        valueAdditionTaxPaidRupees: 0,
      },
    ],
    exports: [
      {
        documentNo: "KPEX-SB-88901-2026",
        documentDate: "2026-06-18",
        valueRupees: 600000,
      },
    ],
    adjustments: {
      creditBroughtForwardRupees: 10000,
      refundClaimed29Rupees: 100000,
    },
    capitalGoodsRows: [],
  },
};

function getSalesTaxMonthContract(name) {
  const key = String(name || "").replace(/\.json$/i, "");
  const found = MONTHS[key];
  if (!found) {
    throw new Error(`Unknown sales-tax month contract "${name}"`);
  }
  return JSON.parse(JSON.stringify(found));
}

module.exports = {
  MONTHS,
  getSalesTaxMonthContract,
};
