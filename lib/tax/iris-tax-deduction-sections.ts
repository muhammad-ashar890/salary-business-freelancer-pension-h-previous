// File: lib/tax/iris-tax-deduction-sections.ts
//
// DP-3: every section of the IRIS 2.0 business "Tax Deduction" tab, exactly
// as IRIS shows it (captures 10 / 34 / 56 / 66 / 67 of 15-Oct-2026,
// ~/iris-business-captures): code (row id), name (row description and picker
// card text) and cells, one letter per value column in IRIS's column order
// (E editable, D computed, - no input). Picker order = IRIS row order.
// `unsupported` names why the agent does not type a section yet (see
// lib/tax/business-tax-deductions.ts). A TypeScript module, not JSON, so every
// loader (Next.js, tsc, the verify scripts) reads it the same way.

export type IrisTaxDeductionCatalogEntry = {
  code: string;
  label: string;
  cells: string;
  actions?: readonly string[];
  unsupported?: "final_regime" | "count_based" | "attribute_dialog" | "cell_pattern";
};

export const IRIS_TAX_DEDUCTION_CATALOG: Readonly<
  Record<"adjustable" | "final" | "minimum", readonly IrisTaxDeductionCatalogEntry[]>
> = {
  adjustable: [
    { code: "64010002", label: "Import u/s 148 @1%", cells: "EE" },
    { code: "64010004", label: "Import u/s 148 @2%", cells: "EE" },
    { code: "64010006", label: "Import u/s 148 @3%", cells: "EE" },
    { code: "64010008", label: "Import u/s 148 @4%", cells: "EE" },
    { code: "64010009", label: "Import u/s 148 @4.5%", cells: "EE" },
    { code: "64010011", label: "Import u/s 148 @5.5%", cells: "EE" },
    { code: "64050007", label: "Payment to a Non-Resident u/s 152(2) @20%", cells: "EE" },
    { code: "64060116", label: "Payment for Services u/s 153(1)(b) @8% u/c (42) of Part IV of Second Schedule", cells: "EE" },
    { code: "64150701", label: "Purchase of other Commodities by Distributors / Dealers / Wholesalers u/s 236G", cells: "EE" },
    { code: "64150702", label: "Purchase of Fertilizer by Distributors / Dealers / Wholesalers u/s 236G", cells: "EE" },
    { code: "64150803", label: "Purchase by Retailers u/s 236H", cells: "EE" },
    { code: "64310010", label: "Adjustments under 236A for Builders/Developers", cells: "EE" },
    { code: "64310011", label: "Adjustments under 236K for Builders/Developers", cells: "EE" },
    { code: "64010037", label: "Export Proceeds u/s 147 (6C) @1%", cells: "EE" },
  ],
  final: [
    { code: "64310065", label: "Receipts from Shipping Business of a Non-Resident Person u/s 7", cells: "EED", unsupported: "final_regime" },
    { code: "64310067", label: "Income from projects u/s 100D @ 20%", cells: "EED", unsupported: "final_regime" },
    { code: "64310066", label: "Tax Liability u/s 100D Read with Rule 10 of Eleventh Schedule for Builders/Developers", cells: "--E", actions: ["icon:add-adjustable-tax-generic:Add"], unsupported: "final_regime" },
    { code: "64120031", label: "Attributable income from controlled foreign company u/s 109A @ 15%", cells: "EED", unsupported: "final_regime" },
    { code: "64050051", label: "Royalty / Fee for Technical Services to a Non-Resident u/s 152(1) / Division IV, Part I, 1st Schedule", cells: "EED", unsupported: "final_regime" },
    { code: "64050100", label: "Payment for foreign produced commercials to a Non-Resident u/s 152(1BA) @ 20%", cells: "EED", unsupported: "final_regime" },
    { code: "64050057", label: "Fee for offshore digital services u/s 152 (1C) @ 15%", cells: "EED", unsupported: "final_regime" },
    { code: "64210057", label: "Tax deduction on payments to persons engaged in international money transfer or cross border remittances u/s 152(1DC) / Division IV, Part I, 1st Schedule @ 10%", cells: "EED", unsupported: "final_regime" },
    { code: "64210058", label: "Tax deduction on payment to persons to card network company/payment gateway or any other persons/interbank financial telecommunication services u/s 152(1DD) / Division IV, Part I, 1st Schedule @ 10%", cells: "EED", unsupported: "final_regime" },
    { code: "64310055", label: "Receipts from Shipping Business of a resident person u/s 7A", cells: "EEE", unsupported: "final_regime" },
    { code: "64310072", label: "Tax on business income of builders u/s 7C (advance tax installments paid under Rule 13S)", cells: "DEE", unsupported: "final_regime" },
    { code: "64310073", label: "Tax on business income of developers u/s 7D (advance tax installments paid under Rule 13S)", cells: "DEE", unsupported: "final_regime" },
    { code: "64050097", label: "Royalty / Fee for Technical Services to a Non-Resident covered under ADTT", cells: "EED", actions: ["Add Attribute"], unsupported: "final_regime" },
    { code: "64330060", label: "Tax on Income of Cotton Ginners u/c 17, Part III, 2nd Schedule (Cotton ginning and oil milling activity only)", cells: "EED", unsupported: "final_regime" },
    { code: "64090151", label: "Commission / Discount on Petroleum Products u/s 156A @12%", cells: "EED", actions: ["icon::Offer this receipt under Normal Tax regime"], unsupported: "final_regime" },
    { code: "64060290", label: "Export of IT/ITeS Services u/s 154A @ 0.25%", cells: "EED", actions: ["icon::Offer this receipt under Normal Tax regime"], unsupported: "final_regime" },
    { code: "64070151", label: "Foreign Indenting Commission u/s 154A(1)(da) / Division IVA, Part III, First Schedule", cells: "EED", actions: ["icon::Offer this receipt under Normal Tax regime"], unsupported: "final_regime" },
    { code: "64060285", label: "Export of services u/s 154A @1%", cells: "EED", actions: ["icon::Offer this receipt under Normal Tax regime"], unsupported: "final_regime" },
    { code: "64050013", label: "Payment to Non-Resident Sports Person u/s 152(2A)(c) / Division II, Part III, 1st Schedule (ATL @ 15% / Non-ATL @ 30%)", cells: "EED", unsupported: "final_regime" },
  ],
  minimum: [
    { code: "64010052", label: "Import u/s 148 @1%", cells: "EEDEDD" },
    { code: "64010054", label: "Import u/s 148 @2%", cells: "EEDEDD" },
    { code: "64010084", label: "Import u/s 148 @3.5%", cells: "EEDEDD" },
    { code: "64010058", label: "Import u/s 148 @4%", cells: "EEDEDD" },
    { code: "64010061", label: "Import u/s 148 @5.5%", cells: "EEDEDD" },
    { code: "64010062", label: "Import u/s 148 @6%", cells: "EEDEDD" },
    { code: "64120047", label: "No. of Imported Mobile Phones u/s 148 exceeding 100$ up to 200$ @ Rs. 930", cells: "EEDEDD", unsupported: "count_based" },
    { code: "64120046", label: "No. of Imported Mobile Phones u/s 148 exceeding 30$ up to 100$ @ Rs. 100", cells: "EEDEDD", unsupported: "count_based" },
    { code: "64120048", label: "No. of imported mobile phones u/s 148 exceeding 200$ up to 350$ @ Rs. 970", cells: "EEDEDD", unsupported: "count_based" },
    { code: "64120045", label: "No. of imported mobile phones u/s 148 up to 30$ @ Rs. 70", cells: "EEDEDD", unsupported: "count_based" },
    { code: "64120087", label: "No. of imported mobile phones under CBU category u/s 148 exceeding 350$ up to 500$ @ Rs. 5000", cells: "EEDEDD", unsupported: "count_based" },
    { code: "64120088", label: "No. of imported mobile phones under CBU category u/s 148 exceeding 500$ @ Rs. 11500", cells: "EEDEDD", unsupported: "count_based" },
    { code: "64120049", label: "No. of imported mobile phones under CKD/SKD category u/s 148 exceeding 350$ up to 500$ @ Rs. 3000", cells: "EEDEDD", unsupported: "count_based" },
    { code: "64120050", label: "No. of imported mobile phones under CKD/SKD category u/s 148 exceeding 500$ @ Rs. 5200", cells: "EEDEDD", unsupported: "count_based" },
    { code: "64050052", label: "Payment for Contracts for Construction, Assembly or Installation to a Non-Resident u/s 152(1A)(a) / Division II, Part III, 1st Schedule", cells: "EEDDDD" },
    { code: "64050053", label: "Payment for Services, Contracts to a Non-Resident u/s 152(1A)(b) / Division II, Part III, 1st Schedule", cells: "EEDDDD" },
    { code: "64050054", label: "Fee for Advertisement Services to a Non-Resident u/s 152(1A)(c) / Division II, Part III, 1st Schedule", cells: "EEDDDD" },
    { code: "64060084", label: "Payment for Goods u/s 153(1)(a) @11% - for Toll manufacturers.", cells: "EEDDDD" },
    { code: "64050055", label: "Insurance / Reinsurance Premium to a Non-Resident u/s 152(1AA) / Division II, Part III, 1st Schedule", cells: "EEDDDD" },
    { code: "64050056", label: "Fee for Advertisement Services to a Non-Resident u/s 152(1AAA) / Division II, Part III, 1st Schedule", cells: "EEDDDD" },
    { code: "64340210", label: "Payment for Specified Services to a PE of a Non-Resident u/s 152(2A)(b) / Division II, Part III, 1st Schedule", cells: "EEDDDD" },
    { code: "64050009", label: "Payment for Goods to a PE of a Non-Resident u/s 152(2A)(a) / Division II, Part III, 1st Schedule", cells: "EEDDDD" },
    { code: "64050098", label: "Payment for Goods, Services, Contracts, Rent, Capital Gains, etc. to a Non-Resident covered under ADTT", cells: "EEDDDD", actions: ["Add Attribute"], unsupported: "attribute_dialog" },
    { code: "64050012", label: "Payment for Contracts to a PE of a Non-Resident u/s 152(2A)(c) / Division II, Part III, 1st Schedule", cells: "EEDDDD" },
    { code: "64060051", label: "Payment for Goods u/s 153(1)(a) @0.5%", cells: "EEDDDD" },
    { code: "64060052", label: "Payment for Goods u/s 153(1)(a) @1%", cells: "EEDDDD" },
    { code: "64060053", label: "Payment for Goods u/s 153(1)(a) @1.5%", cells: "EEDDDD" },
    { code: "64060055", label: "Payment for Goods u/s 153(1)(a) @2.5%", cells: "EEDDDD" },
    { code: "64060082", label: "Payment for Goods u/s 153(1)(a) @0.25%", cells: "EEDDDD" },
    { code: "64060083", label: "Payment for Goods u/s 153(1)(a) @5.5%", cells: "EEDDDD" },
    { code: "64060151", label: "Payment for Services u/s 153(1)(b) @0.5%", cells: "EEDDDD" },
    { code: "64060152", label: "Payment for Services u/s 153(1)(b) @1%", cells: "EEDDDD" },
    { code: "64060153", label: "Payment for Services u/s 153(1)(b) @1.5%", cells: "EEDDDD" },
    { code: "64060555", label: "Payment for Specified Services u/s 153(1)(b) @2%", cells: "EEDDDD" },
    { code: "64060158", label: "Payment for IT/IT-enabled service u/s 153(1)(b) @4%", cells: "EEDDDD" },
    { code: "64340211", label: "Fee for Oil Tanker contractor services u/c (28F), Part II, 2nd Schedule", cells: "EEDDDD" },
    { code: "64060266", label: "Receipts from Contracts u/s 153(1)(c) @8%", cells: "EEDDDD" },
    { code: "64060352", label: "Fee for Export related Services u/s 153(2) @1%", cells: "EEDDDD" },
    { code: "64070054", label: "Export Proceeds u/s 154(1) @1%", cells: "EEDDDD" },
    { code: "64070152", label: "Sale Proceeds of Goods to Exporter u/s 154(3)", cells: "EEDDDD" },
    { code: "64070153", label: "Sale Proceeds of Goods by Industrial undertaking u/s 154(3A)", cells: "EEDDDD" },
    { code: "64070154", label: "Contract Payments to Indirect Exporter u/s 154(3B)", cells: "EEDDDD" },
    { code: "64070155", label: "Export Proceeds u/s 154(3C)", cells: "EEDDDD" },
    { code: "64120060", label: "Brokerage / Commission u/s 233 @5%", cells: "EEDDDD" },
    { code: "64120066", label: "Brokerage / Commission u/s 233 @8%", cells: "EEDDDD" },
    { code: "64120070", label: "Brokerage / Commission u/s 233 @10%", cells: "EEDDDD" },
    { code: "64120074", label: "Brokerage / Commission u/s 233 @12%", cells: "EEDDDD" },
    { code: "64320051", label: "Fee for Carriage Services by Oil Tanker u/c (43D), Part IV, 2nd Schedule", cells: "EEDDDD" },
    { code: "64320053", label: "Fee for Goods Transport Contractor u/c (43E), Part IV, 2nd Schedule", cells: "EEDDDD" },
    { code: "64150507", label: "No. of Episodes of Foreign produced TV Drama Serial or Play u/s 236CA (1)", cells: "EEDDDD", unsupported: "count_based" },
    { code: "64150509", label: "Foreign produced TV play (single episode) u/s 236CA (2)", cells: "EEDDDD", unsupported: "count_based" },
    { code: "64150510", label: "Total Duration (in seconds) for Advertisements Starring Foreign Actor u/s 236CA (3)", cells: "EEDDDD", unsupported: "count_based" },
    { code: "64340212", label: "Payment for Specified Services u/s 152(2A)(b) / Division II, Part III, 1st Schedule (ATL @ 8% / Non-ATL @ 16%)", cells: "EEDDDD" },
    { code: "64060162", label: "Payment for specified services u/s 153(1)(b) @6%", cells: "EEDDDD" },
    { code: "64060180", label: "Payment for Services u/s 153(1)(b) @15%", cells: "EEDDDD" },
    { code: "64060156", label: "Payment for Services u/s 153(1)(b) @3%", cells: "EEDDDD" },
    { code: "64060280", label: "Receipts from Contracts u/s 153(1)(c) @ 15%", cells: "EEDDDD" },
    { code: "64050080", label: "Payment for IT/IT-enabled service u/s 152(2A)(b) / Division II, Part III, 1st Schedule (ATL @ 4% / Non-ATL @ 8)", cells: "EEDDDD" },
    { code: "64050095", label: "Payment for Other Services to a PE of a Non-Resident u/s 152(2A)(b) / Division II, Part III, 1st Schedule", cells: "EEDDDD" },
    { code: "64050065", label: "Payment for Other Services to a PE of a Non-Resident u/s 152(2A)(b) / Division II, Part III, 1st Schedule (ATL @ 15% / Non-ATL @ 30%)", cells: "EEDDDD" },
  ],
};
