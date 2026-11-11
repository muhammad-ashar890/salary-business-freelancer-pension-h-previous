#!/usr/bin/env node
/**
 * Workspace sync check.
 *
 * The failure this exists for: code, tests and the agent drift apart when a download is
 * copied file-by-file. `verify:portal-field-map` then prints
 * "the action must read the gaps through the shared helper" — which reads like a broken
 * test but means one file in the tree is older than the others.
 *
 * So this checks presence, not behaviour: every file the current round touched must still
 * contain a string only the current version has. Exact bytes are deliberately not
 * compared — line endings and prettier reflows differ between machines, and a marker
 * survives both, while an old copy cannot fake it.
 *
 *   node scripts/check-workspace-sync.cjs
 *   node scripts/check-workspace-sync.cjs --self-test
 *   node scripts/check-workspace-sync.cjs --root "C:\path\to\other\checkout"
 *
 * Exit code is non-zero when anything is STALE or MISSING, so it can gate a deploy.
 */
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Round stamp: bump when a new round lands, so `STALE` output names which set to copy.
 * MARKERS: file → strings only the current version contains. Each was taken from the
 * shipped code, never invented; `--self-test` proves that against this tree, so a renamed
 * function has to be updated here in the same commit or this check cries wolf.
 */
const SYNC_STAMP = "phase7-merged-validation-20261020";
const MARKERS = [
  [
    "lib/tax/portal-field-map.ts",
    ["export function describeUnmappedPortalSources"],
    "the coverage gate's decision, wording and record all live here",
  ],
  [
    "app/actions/packet.ts",
    [
      "describeUnmappedPortalSources,",
      "describeUnmappedPortalSources(\n      portalFieldMap.mappingGaps",
      "unmappedPortalSources: coverageGate.blocked",
      "acceptUnmappedPortalSources?: boolean",
    ],
    "the gate refuses unless the operator accepted, and records the verdict",
  ],
  [
    "components/tax/filing/hooks/use-filing-finalization.ts",
    ["const accept = acceptUnmapped === true;", "packetUnmappedSources"],
    "strictly `true`, so a click event can never read as consent",
  ],
  [
    "components/tax/filing/wizard-packet-step.tsx",
    [
      "I have confirmed the FBR/IRIS field for these amounts",
      "packetUnmappedSources.length > 0 && acceptUnmapped",
    ],
    "the override checkbox and the button that sends an explicit boolean",
  ],
  [
    "components/tax/filing/filing-wizard.tsx",
    ["packetUnmappedSources={packetUnmappedSources}"],
    "the refused list has to reach the step",
  ],
  [
    "lib/tax/fbr-agent-config.ts",
    ["isLiveFilingEnabledByDeployment"],
    "the deployment half of the live-write switch",
  ],
  [
    "app/tax/fbr-connect/page.tsx",
    ["liveFilingEnabled={isLiveFilingEnabledByDeployment()}"],
    "the read-only default comes from the server, not the browser",
  ],
  [
    "components/tax/fbr-connect-client.tsx",
    [
      "Start filing",
      "Review and submit it yourself",
      "submit the return yourself in the FBR",
    ],
    "the flow distinguishes a finished agent task from a filed return",
  ],
  [
    "lib/tax/cnic-profile.ts",
    ["planCnicProfileUpdate"],
    "CNIC → profile plan (an expired card must refuse)",
  ],
  [
    "scripts/verify-portal-field-map.cjs",
    ["describeUnmappedPortalSources"],
    "the gate test; an old copy of this is what makes the code look broken",
  ],
  [
    "scripts/verify-iris-navigation.cjs",
    ["mappingGaps, coverage"],
    "asserts the success payload — stale here means a false failure",
  ],
  [
    "scripts/verify-fbr-contracts.cjs",
    ["TAXROCKET_ALLOW_LIVE_FILING"],
    "proves the env key is read, not hardcoded",
  ],
  [
    "scripts/verify-cnic-profile-plan.cjs",
    ["exactFieldValue"],
    "dashed-CNIC comparison",
  ],
  [
    "electron-connect/job-report.js",
    [
      "buildJobReport",
      "NEVER DONE BY THE AGENT",
      "buildAttentionMessage",
      "buildAttentionReport",
    ],
    "the plain-language job report",
  ],
  [
    "electron-connect/iris-employer-driver.js",
    ["runEmployerDriver", "pension-services-multifiling-20261106a"],
    "the employer driver (exact registered name only)",
  ],
  [
    "lib/tax/salary-certificate-fields.ts",
    [
      "extractSalaryCertificateEmployers",
      "hasRequiredSalaryCertificateEmployer",
    ],
    "the employer name is a required review field on the salary certificate",
  ],
  [
    "app/actions/packet.ts",
    ["extractMappedSalaryEmployers("],
    "the packet carries the reviewed employer names to the agent",
  ],
  [
    "electron-connect/main.js",
    [
      "pension-services-multifiling-20261106a",
      "collectAcknowledgedAutofillItems",
      "real_autofill_stopped",
      "checkTakenOverEntry",
      "runWealthDriverStepwise",
      "live_return_autofill",
      "Live entry entered and verified",
    ],
    "build stamp plus a truthful live-entry completion result",
  ],
  [
    "electron-connect/iris-navigation.js",
    ["salaryVerified", "This inspection did not enter values"],
    "the section gate and honest separation between inspection and entry",
  ],
  // Phase 1 (fix46): agent unblock + full tracking.
  [
    "electron-connect/iris-navigation.js",
    ["cancel-agent-picker", "KNOWN_AGENT_PICKER_TITLES", "business_section_readiness_blocked"],
    "leftover agent pickers are closed with their own Cancel; every wait is timed",
  ],
  [
    "electron-connect/iris-business-row-driver.js",
    ["pension-services-multifiling-20261106a", "personal_reason_already_present", "picker_cancel_clicked", "diffGridRows"],
    "checked+disabled options are IRIS state; any failure presses Cancel",
  ],
  [
    "electron-connect/iris-tour-census.js",
    ["pension-services-multifiling-20261106a", "runCensusTour", "compareTypedEntries"],
    "read-only tour of every tab and readback after tab switch",
  ],
  [
    "electron-connect/main.js",
    ["real_autofill_second_pass", "saveHtmlSnapshot", "writeCensusToDisk", "getCensusTourEnabled"],
    "continue-on-problem stop policy, second pass, local snapshots and census",
  ],
  // Phase 2 (fix47): IRIS totals check + one end-of-run Save.
  [
    "electron-connect/iris-save-draft.js",
    ["pension-services-multifiling-20261106a", "saveReturnDraft", "dismiss_success", "describeSaveOutcome"],
    "the one Save: lower-bar button only, never Submit; IRIS's answer is logged",
  ],
  [
    "electron-connect/iris-tour-census.js",
    ["collectTotalsDetailed", "compareIrisTotals", "pickTotalColumn"],
    "every column of a computed total is read (9100/9200 sit under Normal Tax)",
  ],
  [
    "electron-connect/main.js",
    ["iris_totals_check", "iris_save_start", "iris_save_readback", "TAXROCKET_AUTO_SAVE"],
    "totals check against the packet, Save only after a clean readback",
  ],
  [
    "electron-connect/job-report.js",
    ["describeTotalsCheck", "describeSave", "IRIS vs TAXROCKET (computed totals from the typed figures)"],
    "report sections for the totals check and the Save",
  ],
  // Phase 3a (p3a): tax depreciation engine; the estimate adds book
  // depreciation back like IRIS and deducts only schedule-based depreciation.
  [
    "lib/tax/tax-depreciation.ts",
    ["export function computeTaxDepreciation", "PASSENGER_VEHICLE_COST_CAP", "330308"],
    "tax depreciation at Third Schedule rates, row by row as on the IRIS Depreciation tab",
  ],
  // DP-1 (Data Push): the asset schedule typed on the IRIS Depreciation tab.
  [
    "lib/tax/business-depreciation-schedule.ts",
    ["export function buildDepreciationAgentFields", "DEPRECIATION_TYPED_COLUMNS", "headerOccurrence"],
    "asset schedule in the shape of the IRIS Depreciation tab (DP-1)",
  ],
  [
    "electron-connect/iris-depreciation-driver.js",
    ["pension-services-multifiling-20261106a", "depreciationProbe", "compareDepreciationComputed"],
    "agent driver for the IRIS Depreciation tab (DP-1)",
  ],
  [
    "lib/tax/business-filing.ts",
    ["business-entry-v3", "businessDisposalGainLoss", "buildDepreciationAgentFields"],
    "packet v3 carries the Depreciation-tab figures (DP-1)",
  ],
  [
    "lib/tax/business-iris-expectations.ts",
    ["depreciationDeduction", "incomeAfterDepreciation"],
    "expected 3248 and 3000 = 3270 - 3248 (DP-1)",
  ],
  [
    "lib/tax/rules/ty2026/subcategories.ts",
    ["businessDepreciationSchedule", "sanitizeDepreciationSchedule"],
    "the asset schedule is saved with the business details (DP-1)",
  ],
  [
    "app/actions/tax-calculation.ts",
    ["validateDepreciationSchedule"],
    "a broken asset schedule is never priced (DP-1)",
  ],
  [
    "components/tax/filing/wizard-business-profit-step.tsx",
    ["Assets for tax depreciation", "setScheduleValue"],
    "asset table on the Business profit step (DP-1)",
  ],
  [
    "scripts/verify-data-push-1.cjs",
    ["packet v3: Depreciation-tab fields", "computeBusinessProfit uses the saved schedule"],
    "DP-1 schedule / packet tests",
  ],
  [
    "scripts/verify-data-push-1-agent.cjs",
    ["verifies the capture-11 structure", "is not overwritten"],
    "DP-1 agent driver tests",
  ],
  // DP-2 (Data Push): business bank accounts (3320) and vehicles (3304).
  [
    "lib/tax/business-balance-details.ts",
    ["export function buildBalanceDetailsPlan", "export function isValidPakistanIban", "compareWithBalanceSheet"],
    "bank / vehicle lists in the shape of the IRIS Balance Sheet child rows (DP-2)",
  ],
  [
    "electron-connect/iris-balance-sheet-driver.js",
    ["pension-services-multifiling-20261106a", "add-balance-sheet-bank-account", "runBalanceSheetDriver"],
    "agent driver for the 3320 / 3304 dialogs and child rows (DP-2)",
  ],
  [
    "electron-connect/main.js",
    ["irisBalanceSheetDriver.runBalanceSheetDriver", "real_autofill_balance_done", "business-entry-v4"],
    "the agent runs the Balance Sheet driver and accepts packet v4 (DP-2)",
  ],
  [
    "lib/tax/business-filing.ts",
    ["business-entry-v4", "buildBalanceDetailsPlan", "balanceSheetDetails"],
    "packet v4 carries the bank / vehicle child rows (DP-2)",
  ],
  [
    "app/actions/packet.ts",
    ["declaredBusinessIbans", "ownershipStillOpen"],
    "a declared business account never becomes a personal Wealth 7030 row (DP-2)",
  ],
  [
    "lib/tax/rules/ty2026/subcategories.ts",
    ["businessBankAccounts", "sanitizeBusinessVehicles"],
    "the bank / vehicle lists are saved with the business details (DP-2)",
  ],
  [
    "components/tax/filing/wizard-business-profit-step.tsx",
    ["Business bank accounts (Balance Sheet 3320)", "setVehicleValue"],
    "bank / vehicle tables on the Business profit step (DP-2)",
  ],
  [
    "scripts/verify-data-push-2.cjs",
    ["packet v4: child rows planned", "lists must add up to the Balance Sheet"],
    "DP-2 list / packet tests",
  ],
  [
    "scripts/verify-data-push-2-agent.cjs",
    ["adds the bank account and the vehicle through their dialogs", "the click surface is closed"],
    "DP-2 agent driver tests",
  ],
  // Business Land / Building properties (3301 / 3302).
  [
    "lib/tax/business-balance-details.ts",
    ["sanitizeBusinessProperties", "validateBusinessProperties", "balance-details-v2"],
    "property rows in the shape of the IRIS Select Property / Property Information dialogs",
  ],
  [
    "electron-connect/iris-balance-sheet-driver.js",
    ["property_open_select", "property_choose_option", "PROPERTY_DIALOG_TITLES"],
    "agent driver for the 3301 / 3302 property dialogs and child rows",
  ],
  [
    "lib/tax/business-filing.ts",
    ["business-entry-v8", "propertyCheck", "validateBusinessProperties"],
    "packet v8 carries the land / building property child rows",
  ],
  [
    "electron-connect/main.js",
    ["business-entry-v8", "land/building property item(s)"],
    "the agent accepts packet v8 for every business feature gate",
  ],
  [
    "scripts/verify-data-push-2.cjs",
    ["packet v8: land / building properties planned", "property lists must add up"],
    "business property list / packet tests",
  ],
  [
    "scripts/verify-data-push-2-agent.cjs",
    ["adds land through Select Property", "unmatched IRIS city stops the item"],
    "business property agent driver tests",
  ],
  // DP-2: the IRIS "Business Details" tab.
  [
    "lib/tax/business-identity.ts",
    ["export function buildBusinessDetailsPlan", "IRIS_PRINCIPAL_ACTIVITIES", "irisTableDate"],
    "business name / activity / brand / dates as the IRIS Business Details tab takes them (DP-2)",
  ],
  [
    "electron-connect/iris-business-details-driver.js",
    ["pension-services-multifiling-20261106a", "businessDetailsProbe", "fillBusinessDetailsTab"],
    "agent driver for the Business Details tab (DP-2)",
  ],
  [
    "electron-connect/main.js",
    ["irisBusinessDetailsDriver.fillBusinessDetailsTab", "real_autofill_business_details_result"],
    "the agent runs the Business Details driver (DP-2)",
  ],
  [
    "lib/tax/business-filing.ts",
    ["buildBusinessDetailsPlan", "businessDetails,"],
    "packet v4 carries the Business Details entry (DP-2)",
  ],
  [
    "lib/tax/rules/ty2026/subcategories.ts",
    ["businessIdentity", "sanitizeBusinessIdentity"],
    "the Business Details entry is saved with the business details (DP-2)",
  ],
  [
    "components/tax/filing/wizard-business-profit-step.tsx",
    ["setIdentityValue", "IRIS_PRINCIPAL_ACTIVITIES"],
    "Business details fields on the Business profit step (DP-2)",
  ],
  [
    "scripts/verify-data-push-2-business-details.cjs",
    ["empty table: adds the business", "month-first"],
    "DP-2 Business Details driver tests",
  ],
  // DP-3: tax deducted by section (business Tax Deduction tab).
  [
    "lib/tax/business-tax-deductions.ts",
    ["export function buildTaxDeductionsPlan", "compareWithWithholdingTotal", "takesAttributableIncome"],
    "tax deducted by IRIS section, in the shape of the Tax Deduction tab (DP-3)",
  ],
  [
    "lib/tax/iris-tax-deduction-sections.ts",
    ["IRIS_TAX_DEDUCTION_CATALOG", "Add Attribute", "final_regime"],
    "the 93 IRIS Tax Deduction sections of captures 34 / 56 / 66 / 67 (DP-3)",
  ],
  [
    "electron-connect/iris-tax-deduction-driver.js",
    ["pension-services-multifiling-20261106a", "taxDeductionProbe", "irisFilledAfterAgent"],
    "agent driver for the Tax Deduction tab (DP-3)",
  ],
  [
    "electron-connect/main.js",
    ["irisTaxDeductionDriver.fillTaxDeductions", "real_autofill_tax_deduction_done", "business-entry-v5"],
    "the agent runs the Tax Deduction driver and accepts packet v5 (DP-3)",
  ],
  [
    "electron-connect/iris-tour-census.js",
    ["entry.censusView && view.key !== entry.censusView"],
    "a Tax Deduction figure is read back only on its own tab (DP-3)",
  ],
  // Phase 3b: surcharge (4AB) / super tax (4C) on the Computations tab.
  [
    "lib/tax/tax-calculation.ts",
    ["export function section4ABRatePercent", "export function assessSection4C", "SECTION_4C_TY2026_BANDS"],
    "4AB rate by table (D4) and Section 4C super tax in the estimate (Phase 3b)",
  ],
  [
    "lib/tax/business-iris-expectations.ts",
    ["computations-v1", "SURCHARGE_USER_MESSAGE", "SUPER_TAX_USER_MESSAGE"],
    "the agent's Computations plan in the packet (Phase 3b)",
  ],
  [
    "electron-connect/iris-computations-driver.js",
    ["pension-services-multifiling-20261106a", "decideComputations", "iris_base_differs"],
    "agent driver for Computations rows 923184 / 9231822 (Phase 3b)",
  ],
  [
    "electron-connect/main.js",
    ["irisComputationsDriver.fillComputations", "real_autofill_computations_done"],
    "the agent runs the Computations driver before the end readback (Phase 3b)",
  ],
  // Phase 3c: Section 113 minimum tax (D2 / D3) and the "+ Turnover" row.
  [
    "lib/tax/minimum-tax-113.ts",
    ["MINIMUM_TAX_CATEGORIES", "section113Applicability", "computeSection113"],
    "Division IX catalogue, who s.113 reaches, minimum tax and carry-forward (Phase 3c)",
  ],
  [
    "lib/tax/tax-calculation.ts",
    ['"minimum_tax"', "ITO-113-DIV-IX-TY2026"],
    "the minimum_tax top-up line in the estimate (Phase 3c)",
  ],
  [
    "app/actions/tax-calculation.ts",
    ["section113Applicability({", "SECTION_113_TEXT.cottonGinner"],
    "the estimate prices s.113 instead of stopping (Phase 3c)",
  ],
  [
    "lib/tax/rules/ty2026/subcategories.ts",
    ["businessTurnover100mEarlierYear", "MINIMUM_TAX_CATEGORY_DETAIL_KEY"],
    "the D2 answer and the D3 business type are saved (Phase 3c)",
  ],
  [
    "components/tax/filing/wizard-business-profit-step.tsx",
    ["Minimum tax on turnover (Section 113)", "business-turnover-100m-earlier-year"],
    "the D2 / D3 questions on the Business profit step (Phase 3c)",
  ],
  [
    "lib/tax/business-iris-expectations.ts",
    ["TurnoverEntry", "SURCHARGE_MINIMUM_TAX_MESSAGE", "minimumTaxRegime"],
    "the turnover row and the regime in the Computations plan (Phase 3c)",
  ],
  [
    "lib/tax/business-filing.ts",
    ["business-entry-v6", "section113Applicability"],
    "packet v6 carries the Section 113 turnover row (Phase 3c)",
  ],
  [
    "electron-connect/iris-turnover-driver.js",
    ["pension-services-multifiling-20261106a", "turnoverProbe", "other_turnover_row_present"],
    "agent driver for the + Turnover row (Phase 3c)",
  ],
  [
    "electron-connect/iris-computations-driver.js",
    ["ensureTurnover", "turnoverByHand"],
    "the Computations driver adds and types the turnover row first (Phase 3c)",
  ],
  [
    "electron-connect/main.js",
    ['["iris-turnover-driver.js", irisTurnoverDriver.BUILD_TAG]', "business-entry-v6"],
    "the agent checks the turnover driver's build and accepts packet v6 (Phase 3c)",
  ],
  [
    "lib/tax/business-filing.ts",
    ["business-entry-v5", "buildTaxDeductionsPlan", "deductionTotals.remainder"],
    "packet v5 carries the Tax Deduction sections (DP-3)",
  ],
  [
    "lib/tax/business-iris-expectations.ts",
    ["taxDeductionSections", "minimum-tax section(s) typed on the Tax Deduction tab"],
    "Tax Chargeable is not compared while IRIS adds the minimum-tax difference (DP-3)",
  ],
  [
    "lib/tax/rules/ty2026/subcategories.ts",
    ["businessTaxDeductions", "sanitizeBusinessTaxDeductions"],
    "the section list is saved with the business details (DP-3)",
  ],
  [
    "components/tax/filing/wizard-business-profit-step.tsx",
    ["Tax deducted from business receipts, by section", "setDeductionValue"],
    "the section table on the Business profit step (DP-3)",
  ],
  [
    "scripts/verify-data-push-3.cjs",
    ["packet v5, adjustable section = the full total", "the agent accepts every section the app can plan"],
    "DP-3 list / packet tests",
  ],
  [
    "scripts/verify-data-push-3-agent.cjs",
    ["adds both sections and types every figure", "IRIS computing Tax Deducted after Taxable Amount"],
    "DP-3 agent driver tests",
  ],
  // DP-4: add-backs by reason on the Inadmissible/Admissible Deductions tab.
  [
    "lib/tax/business-addbacks.ts",
    ["export function buildAddBacksPlan", "compareWithInadmissibleTotal", "UNABSORBED_DEPRECIATION_ROW"],
    "add-backs by IRIS reason; the 46 picker rows of captures 30 / 31 (DP-4)",
  ],
  [
    "lib/tax/business-filing.ts",
    ["business-entry-v7", "buildAddBacksPlan", "addBacksListed"],
    "packet v7 types deductions rows other than 3212 (DP-4)",
  ],
  [
    "lib/tax/business-schedule-fields.ts",
    ["addBacksListed", "Make them the same"],
    "with a reasons list the Books only confirm 3212; it is queued once (DP-4)",
  ],
  [
    "lib/tax/business-iris-expectations.ts",
    ["ADMISSIBLE_CODES", "accountingGains", "admissibleProven"],
    "3259 counts 3248 and IRIS's gain rows; 3000 = 3270 - 3248 - 3258 (DP-4)",
  ],
  [
    "lib/tax/rules/ty2026/subcategories.ts",
    ["businessAddBacks", "sanitizeBusinessAddBacks"],
    "the reasons list is saved with the business details (DP-4)",
  ],
  [
    "components/tax/filing/wizard-business-profit-step.tsx",
    ["Expenses that are not allowed, by reason", "setAddBackValue"],
    "the reasons table on the Business profit step (DP-4)",
  ],
  [
    "electron-connect/iris-business-row-driver.js",
    ["ensureDeductionRows", "ADMISSIBLE_CARD_CODES", "deduction_row_added_and_structure_verified"],
    "rows of both deduction pickers, one at a time, through the proven 3212 flow (DP-4)",
  ],
  [
    "electron-connect/main.js",
    ["irisBusinessRowDriver.ensureDeductionRows", "blockedDeductionRows", "business-entry-v7"],
    "the agent makes every deductions row ready before typing and accepts packet v7 (DP-4)",
  ],
  [
    "scripts/verify-data-push-4.cjs",
    ["packet v7: every listed reason is queued", "3259 counts tax depreciation"],
    "DP-4 list / packet / expectations tests",
  ],
  [
    "scripts/verify-data-push-4-agent.cjs",
    ["both pickers: three rows are created one at a time", "a leftover picker of the other type"],
    "DP-4 agent driver tests",
  ],
  [
    "scripts/verify-iris-navigation.cjs",
    ["fix53: a v7 packet adds rows of both deduction pickers"],
    "DP-4 end-to-end run through runRealIrisAutofill",
  ],
  // DP-4 item 2: tax gain / loss on business assets sold.
  [
    "lib/tax/business-asset-sales.ts",
    ["readAssetSaleAnswers", "validateAssetSaleAnswers", "TAX_LOSS_ON_ASSETS_ROW"],
    "the two answers on assets sold and the IRIS rows 3226 / 3256 / 3116 / 3196 (DP-4)",
  ],
  [
    "lib/tax/business-filing.ts",
    ["BUSINESS_TAX_GAIN_ON_ASSETS_SOLD", "businessAssetSaleBookLoss"],
    "the packet types the tax gain / loss on assets sold (DP-4)",
  ],
  [
    "lib/tax/business-profit.ts",
    ["assetSaleBookGain", "assetSaleBookLoss"],
    "the estimate counts a sale once, at its tax figure (DP-4)",
  ],
  [
    "components/tax/filing/wizard-business-profit-step.tsx",
    ["setAssetSaleAnswer", "ASSET_SALE_TEXT.question"],
    "the two answers on assets sold on the Business profit step (DP-4)",
  ],
  // DP-4 item 3 (3d): losses by year and unabsorbed depreciation.
  [
    "lib/tax/business-loss-rules.ts",
    ["export function setOffBroughtForward", "UNABSORBED_FULL_SETOFF_LIMIT", "unabsorbedAmbiguousMessage"],
    "s.57 loss rules: earliest year first, 50% / 100% unabsorbed depreciation (DP-4)",
  ],
  [
    "lib/tax/business-filing.ts",
    ["BUSINESS_LOSS_BROUGHT_FORWARD_", "BUSINESS_UNABSORBED_DEPRECIATION", "lossesListed"],
    "the packet types losses by year (327021-327025) and 3258 (DP-4)",
  ],
  [
    "lib/tax/business-profit.ts",
    ["lossSetOffByYear", "unabsorbedSetOff"],
    "the estimate applies s.57(3) / (4) (DP-4)",
  ],
  [
    "lib/tax/business-schedule-fields.ts",
    ["lossesListed", "losses by year on Business profit"],
    "with losses by year the Books only confirm their loss year (DP-4)",
  ],
  [
    "lib/tax/rules/ty2026/subcategories.ts",
    ["businessLossesByYear", "businessUnabsorbedDepreciation"],
    "the loss list and unabsorbed depreciation are saved (DP-4)",
  ],
  [
    "components/tax/filing/wizard-business-profit-step.tsx",
    ["Business losses of earlier years, by year", "setUnabsorbed"],
    "the loss-by-year table and unabsorbed depreciation on the Business profit step (DP-4)",
  ],
  [
    "lib/tax/business-iris-expectations.ts",
    ["superTaxBase", "3000 + 3258"],
    "super tax base adds unabsorbed depreciation back (s.4C(2)(ii), DP-4)",
  ],
  [
    "app/actions/tax-calculation.ts",
    ["otherIncomeHeads: incomeSources.some"],
    "the estimate knows whether other income heads exist for the s.57(4) test (DP-4)",
  ],
  // 16-Oct (live test A): the Business profit step waits for the answers the
  // estimate needs; Review shows why an estimate stopped.
  [
    "lib/tax/business-profit-step-check.ts",
    ["export function businessProfitStepProblems", "section113_unanswered"],
    "the answers the tax estimate needs, as one list (16-Oct)",
  ],
  [
    "components/tax/filing/filing-wizard.tsx",
    ["businessProfitStepProblems(selection?.details)", "taxCalculationNote={taxCalculationNote}"],
    "Continue on Business profit waits for them; Review gets the reason (16-Oct)",
  ],
  [
    "components/tax/filing/hooks/use-filing-finalization.ts",
    ["setTaxCalculationNote"],
    "the reason of a NEEDS_RULES result is kept (16-Oct)",
  ],
  [
    "components/tax/filing/wizard-review-step.tsx",
    ["`Reason: ${taxCalculationNote}`"],
    "Review shows why the estimate stopped (16-Oct)",
  ],
  [
    "app/actions/filing.ts",
    ["const stableText = (value: unknown): string => {"],
    "an edit inside a detail list resets the estimate and packet approval (16-Oct)",
  ],
  // 16-Oct: Business Balance Sheet required: uploaded and reviewed, every row
  // a required review field (0 allowed, blank not), rows add up to the totals.
  [
    "lib/tax/document-review-required.ts",
    ["export function balanceSheetTotalsErrors", "BALANCE_SHEET_ASSET_ROWS", "or 0 if the business has none."],
    "every Balance Sheet row is required on review and the rows must add up (16-Oct)",
  ],
  [
    "lib/tax/document-requirements.ts",
    ["Required for business income (FBR's business return includes it)."],
    "the Balance Sheet slot is required for business income (16-Oct)",
  ],
  [
    "lib/tax/filing-completeness.ts",
    ["// Required for business income (16-Oct); its reviewed figures enter FBR.", "it was mapped before every row had to be filled"],
    "the pre-filing gate requires the mapped, complete Balance Sheet (16-Oct)",
  ],
  [
    "lib/tax/business-filing.ts",
    ["if (value !== null && value !== 0)"],
    "a 0 Balance Sheet row is not typed into IRIS (16-Oct)",
  ],
  [
    "components/tax/filing/wizard-documents-step.tsx",
    ["Every Balance Sheet row is required: type the figure", "This Balance Sheet was mapped before every row had to"],
    "the review screen says how to fill the Balance Sheet rows (16-Oct)",
  ],
  [
    "components/tax/filing/filing-wizard.tsx",
    ["Save & Approve Map for the Business Balance Sheet before approving the filing"],
    "the client asks for the Balance Sheet map like the server gate (16-Oct)",
  ],
  [
    "components/tax/filing/wizard-business-profit-step.tsx",
    ["To continue, finish these:"],
    "the open answers on the Business profit step (16-Oct)",
  ],
  [
    "scripts/verify-business-step-required.cjs",
    ["the unanswered Section 113 question (the live-test-A stop) is open"],
    "16-Oct step-check / review / fingerprint tests",
  ],
  [
    "scripts/verify-balance-sheet-required.cjs",
    ["review: all 20 Balance Sheet fields are required, exactly the extraction labels"],
    "16-Oct Balance Sheet requirement tests",
  ],
  [
    "lib/tax/business-profit.ts",
    ["accountingDepreciationAddedBack", "taxDepreciationPending", "depreciationSchedule"],
    "book depreciation added back (IRIS 3238); tax depreciation only from an asset schedule",
  ],
  [
    "components/tax/filing/wizard-business-profit-step.tsx",
    ["taxDepreciationPending"],
    "the profit step says the book depreciation is added back",
  ],
  [
    "components/tax/filing/wizard-packet-step.tsx",
    ["pending.length > 0", "Business — items to review"],
    "packet page shows only actionable business pending items",
  ],
  [
    "components/tax/fbr-connect-client.tsx",
    ["The agent did not press Save in this run"],
    "FBR page wording matches the one end-of-run Save",
  ],
  [
    "lib/tax/business-iris-expectations.ts",
    ["export function buildExpectedIrisTotals", "iris-expect-v1", "LIVE_PROVEN_CODES"],
    "expected IRIS totals from exactly the typed business figures",
  ],
  [
    "lib/tax/business-filing.ts",
    ["buildExpectedIrisTotals({", "expectedIrisTotals,"],
    "the business packet carries the expected IRIS totals to the agent",
  ],
  [
    "lib/tax/tax-calculation.ts",
    ["export function divisionIClause1Tax"],
    "the IRIS check reads the same slab table as the estimate",
  ],
  [
    "app/actions/fbr-jobs.ts",
    ["readHandoffIrisCheck", "readHandoffSave"],
    "only checked, length-capped totals/Save fields reach the browser",
  ],
  [
    "components/tax/fbr-connect-client.tsx",
    ["Data entry finished", "Saved in your FBR draft"],
    "the FBR Connect completion card shows the entry result and Save, not an FBR totals review",
  ],
  [
    "electron-connect/job-report.js",
    ["buildFieldLog", "FIELD TABLE (one line per planned figure)"],
    "one report line per planned figure",
  ],
  [
    "electron-connect/iris-row-filler.js",
    ["readback_mismatch"],
    "every write is re-read before it counts",
  ],
  [
    "electron-connect/iris-row-filler.js",
    ["replaceOnlyIfExisting"],
    "Cash in hand: a cell may be replaced only when it holds the proven baseline",
  ],
  [
    "electron-connect/iris-wealth-driver.js",
    ["planCashTarget", "add_to_iris_value"],
    "Cash in hand (7012): baseline plus movement, never a bare overwrite",
  ],
  [
    "electron-connect/iris-wealth-driver.js",
    [
      "addGiftRow",
      "gift_donor_not_resolved",
      "Open pop-up(s) in IRIS",
      "TRANSIENT_NAVIGATION",
      "runWealthDriverStepwise",
      "misplacedGift",
    ],
    "7037 Gift: donor id, search, description, SAVE of the dialog, then the amount",
  ],
  [
    "electron-connect/cash-baseline-store.js",
    ["createCashBaselineStore"],
    "the saved Cash in hand baseline that stops a re-run adding the movement twice",
  ],
  [
    "lib/tax/cash-in-hand.ts",
    ["export function netCashMovement"],
    "net cash movement shared by Mizan and the packet",
  ],
  [
    "lib/tax/gift-income.ts",
    ["export function isGiftCategory"],
    "a gift is a Wealth Statement inflow, not income",
  ],
  [
    "lib/tax/bank-classification-rules.ts",
    ["GIFT_KEYWORDS", "export function classifyTransaction"],
    "Bank Intelligence rules (whole-word keywords, gift suggestion)",
  ],
  [
    "lib/tax/bank-transfer-matching.ts",
    ["bankDescriptionContainsPhrase", "findTransferLookalikePairs"],
    "whole-word keyword matching",
  ],
  [
    "lib/tax/reconciliation-calculation.ts",
    ["netCashMovement(transactions)"],
    "Mizan counts cash moved out of the bank as Cash in hand",
  ],
  [
    "app/actions/tax-calculation.ts",
    ["isGiftCategory(entry.category)"],
    "a gift never reaches a tax figure",
  ],
  [
    "app/actions/bank-classification.ts",
    ['from "@/lib/tax/bank-classification-rules"'],
    "the action uses the shared rules file",
  ],
  [
    "components/tax/filing/wizard-bank-intelligence-step.tsx",
    ['"GIFT",', "bankAccounts.length > 1"],
    "Gift in the category dropdown; transfer button only with two accounts",
  ],
  [
    "lib/tax/portal-field-map.ts",
    ["valueMode: VALUE_MODE_ADD_TO_IRIS", "isGiftCategory", "giftAgg"],
    "the 7012 movement field, the gift exclusion and the 7037 gift rows",
  ],
  [
    "prisma/schema.prisma",
    ["giftDonorId          String?"],
    "the gift donor column (run the migration after copying)",
  ],
  [
    "prisma/migrations/20261003120000_add_bank_transaction_gift_donor/migration.sql",
    ['"giftDonorId" TEXT'],
    "the migration that adds it",
  ],
  [
    "lib/tax/gift-income.ts",
    ["export function validateGiftDonorId"],
    "donor number rules for the IRIS Gift dialog",
  ],
  [
    "app/actions/packet.ts",
    ["giftDonorByTransaction", "date: e.entryDate"],
    "the packet carries each gift with its donor and booking date",
  ],
  [
    "lib/tax/filing-completeness.ts",
    ["findTransferLookalikePairs(transactions)"],
    "the Continue gate refuses an own-account transfer booked as income or an expense",
  ],
  [
    "scripts/contracts/iris-employer-contract.json",
    ["salary-employer-add-btn", "rawHtmlPersisted"],
    "permanent employer panel & dialog contract (raw HTML never needed)",
  ],
  [
    "scripts/contracts/iris-core-rows-contract.json",
    ["Subject to Normal Income", "rawHtmlPersisted"],
    "permanent core IRIS rows contract (Salary, Withholding, Computations, Assets, Reconciliation)",
  ],
  [
    "scripts/lib/fake-iris-employer.cjs",
    ["class FakeIrisEmployer"],
    "the fake IRIS employer page the driver tests run against",
  ],
  [
    "scripts/lib/fake-iris-wealth.cjs",
    ["class FakeIris {", "knownDonors"],
    "the fake IRIS Wealth Statement page the driver tests run against (with the Gift dialog)",
  ],
  [
    "lib/tax/bank-classification-rules.ts",
    ["isPlaceholderIncomeCategory", "PLACEHOLDER_INCOME_ERROR"],
    "an unexplained credit can never be approved as income",
  ],
  [
    "app/actions/bank-classification.ts",
    ["isPlaceholderIncomeCategory(transaction.suggestedCategory)"],
    "the approve click refuses an unexplained credit",
  ],
  [
    "lib/tax/filing-completeness.ts",
    ["isPlaceholderIncomeCategory(transaction.suggestedCategory)"],
    "the Continue gate names an unexplained credit approved as income",
  ],
  [
    "components/tax/fbr-attention-panel.tsx",
    ["FbrAttentionPanel", "What to do:{\" \"}"],
    "the review pause shown as a list: what happened, what to do (new file)",
  ],
  [
    "app/actions/fbr-jobs.ts",
    ["readJobAttention", 'requiredAction === "portal_autofill_review"'],
    "the job list passes the attention list to the page as plain text; the missing-items pause needs a ticked confirmation",
  ],
  [
    "scripts/verify-iris-wealth-driver.cjs",
    ["gift planning:"],
    "the 7037 Gift driver tests",
  ],
  [
    "scripts/verify-bank-classification.cjs",
    ["becomes a 7037 Wealth row"],
    "the packet test for gifts that carry a donor",
  ],
  [
    "scripts/contracts/iris-wealth-contract.json",
    ["app-nitr-gift-dialog", "Add Personal Expenses", "Bank Account"],
    "permanent 116 Wealth Statement section & modal contract (Expenses, Financial Assets, Outflow, Bank, Gift)",
  ],
  [
    "scripts/lib/iris-wealth-dom-from-contract.cjs",
    ["sub-child", "renderWealthModal"],
    "renders 116 Wealth Statement sections & modals directly from iris-wealth-contract.json",
  ],
  [
    "scripts/portal-coverage-inventory.cjs",
    ["mergeEvidence", "loadSavedEvidence"],
    "merge-safe evidence generator (never wipes existing PORTAL_ROW_EVIDENCE codes)",
  ],
  [
    "lib/sales-tax/types.ts",
    ["export interface ReturnResult"],
    "sales tax engine (Phase 1): shared types",
  ],
  [
    "lib/sales-tax/money.ts",
    ["export function toPaisa"],
    "sales tax engine: integer paisa helpers",
  ],
  [
    "lib/sales-tax/dates.ts",
    ["export function parseDateCell"],
    "sales tax engine: calendar helpers",
  ],
  [
    "lib/sales-tax/problems.ts",
    ["export function makeProblem"],
    "sales tax engine: plain-language messages",
  ],
  [
    "lib/sales-tax/template-reader.ts",
    ["export function readSalesSheet"],
    "sales tax engine: reads the official invoice templates",
  ],
  [
    "lib/sales-tax/invoice-checks.ts",
    ["export function checkSalesRows"],
    "sales tax engine: invoice row checks",
  ],
  [
    "lib/sales-tax/compute-return.ts",
    ["export function computeSalesTaxReturn"],
    "sales tax engine: return lines",
  ],
  [
    "lib/sales-tax/prepare-month.ts",
    ["export function prepareMonth"],
    "sales tax engine: templates to estimated return",
  ],
  [
    "lib/sales-tax/index.ts",
    ['export * from "./compute-return"'],
    "sales tax engine: public entry point",
  ],
  [
    "lib/sales-tax/rules/fbr-goods/catalog.ts",
    ["export const FBR_GOODS_RULES"],
    "sales tax rules catalog with sources and dates",
  ],
  [
    "lib/sales-tax/rules/fbr-goods/due-dates.ts",
    ["export function getDueDates"],
    "sales tax due dates",
  ],
  [
    "lib/sales-tax/rules/fbr-goods/penalties.ts",
    ["export function lateReturnPenalty"],
    "sales tax late filing penalty and surcharge",
  ],
  [
    "lib/sales-tax/rules/fbr-goods/validate-catalog.ts",
    ["export function validateCatalog"],
    "sales tax catalog validation",
  ],
  [
    "lib/sales-tax/rules/fbr-goods/reference.ts",
    ["export const SALES_TEMPLATE"],
    "typed access to the official template lists",
  ],
  [
    "lib/sales-tax/rules/fbr-goods/index.ts",
    ['export * from "./catalog"'],
    "sales tax rules entry point",
  ],
  [
    "lib/sales-tax/rules/fbr-goods/reference-data.json",
    ['"templateVersion": "1.0.44"'],
    "official FBR template lists (generated)",
  ],
  [
    "scripts/extract-iris-sales-references.cjs",
    ["function referenceColumn"],
    "regenerates the official template lists",
  ],
  [
    "scripts/lib/sales-tax-test-kit.cjs",
    ["function createChecker"],
    "shared helpers for the sales tax suites",
  ],
  [
    "scripts/verify-sales-tax-rules.cjs",
    ["verify-sales-tax-rules"],
    "sales tax rules suite",
  ],
  [
    "scripts/verify-sales-tax-intake.cjs",
    ["verify-sales-tax-intake"],
    "sales tax intake suite",
  ],
  [
    "scripts/verify-sales-tax-return.cjs",
    ["verify-sales-tax-return"],
    "sales tax hand-worked months suite",
  ],
  [
    "scripts/verify-sales-tax-dates.cjs",
    ["verify-sales-tax-dates"],
    "sales tax dates and penalties suite",
  ],
  [
    "scripts/lib/sales-tax-contract-months.cjs",
    ["month-2026-06", "month-2026-07", "month-2026-08", "SYNTHETIC"],
    "self-contained synthetic sales-tax month contracts (June, July, August 2026)",
  ],
  [
    "lib/tax/filing-draft-identity.ts",
    ["export function pickReusableDraft"],
    "several filings per tax year: which draft a save belongs to",
  ],
  [
    "prisma/migrations/20261007120000_allow_multiple_filings_per_tax_year/migration.sql",
    ['DROP INDEX "FilingDraft_userId_taxYear_key"'],
    "several filings per tax year: drops the one-draft-per-year unique index",
  ],
  [
    "scripts/verify-multiple-filings-per-year.cjs",
    ["Several filings for one tax year"],
    "the test that pins the several-filings-per-year behaviour",
  ],
  [
    "app/actions/filing.ts",
    ["function getRequestedDraftId", "resolveTargetDraftId"],
    "create and save target an explicit draft and never overwrite a protected one",
  ],
  [
    "components/tax/filing/filing-wizard.tsx",
    ["const currentDraftId = draftId ?? resumeDraftId ?? null"],
    "the wizard sends the draft id with every snapshot",
  ],
  [
    "app/tax/history/page.tsx",
    ["numberFilingsPerYear"],
    "history labels several filings of the same tax year",
  ],
  [
    "lib/sales-tax/profile.ts",
    [
      "export function validateProfile",
      "export function validateBusinessDetails",
    ],
    "sales tax module (Phase 2A): profile and month validation",
  ],
  [
    "app/actions/sales-tax.ts",
    [
      "export async function startSalesTaxMonthAction",
      "export async function uploadSalesTaxInvoicesAction",
    ],
    "sales tax module: server actions",
  ],
  [
    "app/tax/sales-tax/page.tsx",
    ["/tax/sales-tax/new"],
    "sales tax module: main screen",
  ],
  [
    "app/tax/sales-tax/new/page.tsx",
    ["SalesTaxWizard"],
    "sales tax module: wizard page",
  ],
  [
    "components/tax/sales-tax/sales-tax-wizard.tsx",
    ["validateAuthoritySelection", "setupValid"],
    "sales tax module: step-by-step wizard",
  ],
  [
    "app/tax/sales-tax/[id]/page.tsx",
    ["getSalesTaxFilingAction"],
    "sales tax module: month screen",
  ],
  [
    "prisma/migrations/20261008120000_add_sales_tax_module/migration.sql",
    ['CREATE TABLE "SalesTaxFiling"'],
    "sales tax module: tables",
  ],
  [
    "components/tax/dashboard-sidebar.tsx",
    ["/tax/sales-tax"],
    "the sidebar links to the Sales Tax module",
  ],
  [
    "components/tax/filing/wizard-setup-step.tsx",
    ["Sales Tax section"],
    "the income-tax wizard points to the Sales Tax module",
  ],
  [
    "lib/sales-tax/workbook.ts",
    ["export async function readInvoiceWorkbook", "MAX_DATA_ROWS"],
    "sales tax uploads (Phase 2B): reads the uploaded Excel file",
  ],
  [
    "lib/sales-tax/analyze-uploads.ts",
    ["export function analyzeUploads"],
    "sales tax uploads: totals and problem list for the uploaded files",
  ],
  [
    "components/tax/sales-tax/invoice-steps.tsx",
    ["uploadSalesTaxInvoicesAction", "export function CheckStep"],
    "sales tax uploads: the invoice steps of the wizard",
  ],
  [
    "prisma/migrations/20261008180000_add_sales_tax_uploads/migration.sql",
    ['CREATE TABLE "SalesTaxUpload"'],
    "sales tax uploads: table",
  ],
  [
    "scripts/verify-sales-tax-uploads.cjs",
    ["Sales Tax invoice upload (Phase 2B)"],
    "the test that pins the sales tax invoice upload",
  ],
  [
    "lib/sales-tax/figures.ts",
    [
      "export function validateFiguresForm",
      "export function parseStoredFigures",
    ],
    "sales tax review (Phase 3): the figures form and its checks",
  ],
  [
    "lib/sales-tax/estimate.ts",
    [
      "export function buildEstimate",
      "export function buildApprovalPacket",
      "export function isApprovalCurrent",
    ],
    "sales tax review: the estimate, the approval packet and its fingerprint",
  ],
  [
    "components/tax/sales-tax/review-step.tsx",
    ["IRIS calculates the final amounts", "export function ReviewStep"],
    "sales tax review: the estimate screen",
  ],
  [
    "components/tax/sales-tax/figures-step.tsx",
    ["export function FiguresStep"],
    "sales tax review: the figures step",
  ],
  [
    "app/actions/sales-tax.ts",
    [
      "export async function approveSalesTaxReturnAction",
      "export async function saveSalesTaxFiguresAction",
    ],
    "sales tax review: save figures and approve actions",
  ],
  [
    "prisma/migrations/20261009120000_add_sales_tax_review/migration.sql",
    ['"approvedPacket" JSONB'],
    "sales tax review: figures and approval columns",
  ],
  [
    "prisma/migrations/20261009180000_allow_several_sales_tax_businesses/migration.sql",
    ["SalesTaxProfile_userId_registrationNo_key"],
    "sales tax businesses: several businesses per user",
  ],
  [
    "scripts/verify-sales-tax-businesses.cjs",
    ["Businesses of one owner (Sales Tax)"],
    "the test that pins the businesses of one sales tax owner",
  ],
  [
    "scripts/verify-sales-tax-manual.cjs",
    ["Sales Tax: invoices typed in by hand"],
    "the test that pins typed invoices for sales tax",
  ],
  [
    "scripts/verify-sales-tax-review.cjs",
    ["Sales Tax review and approval (Phase 3)"],
    "the test that pins the sales tax review and approval",
  ],
  [
    "scripts/verify-sales-tax-module.cjs",
    ["Sales Tax module shell (Phase 2A)"],
    "the test that pins the Sales Tax module shell",
  ],
];

/** Read-only scan: each result is OK / STALE / MISSING for `markers` under `root`. */
function scan(root, markers) {
  return markers.map(([rel, strings, why]) => {
    const file = path.join(root, rel);
    let raw = null;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return { status: "MISSING", rel, why, missing: strings.slice() };
    }
    // Markers are written in LF, so fold CRLF before comparing; without this a
    // Windows checkout calls any multi-line needle stale.
    const text = raw.replace(/\r\n/g, "\n");
    const missing = strings.filter((needle) => !text.includes(needle));
    return {
      status: missing.length ? "STALE" : "OK",
      rel,
      why,
      missing,
      bytes: Buffer.byteLength(raw),
    };
  });
}

function selfTest() {
  const assert = require("assert");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-selftest-"));
  try {
    fs.mkdirSync(path.join(dir, "a"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "a", "current.ts"),
      "export const keep = 1;\n",
    );
    fs.writeFileSync(path.join(dir, "a", "old.ts"), "// an older revision\n");
    // A CRLF copy must not read as staleness — Windows checkouts reflow line endings.
    fs.writeFileSync(
      path.join(dir, "a", "crlf.ts"),
      "export const keep = 1;\r\n",
    );

    const fake = [
      ["a/current.ts", ["export const keep"], "present"],
      ["a/old.ts", ["export const keep"], "removed again by a stale copy"],
      ["a/crlf.ts", ["export const keep"], "CRLF must still match"],
      ["a/gone.ts", ["whatever"], "never copied at all"],
    ];
    const out = scan(dir, fake);
    assert.strictEqual(out[0].status, "OK", "a current file passes");
    assert.strictEqual(out[1].status, "STALE", "a stale file is named");
    assert.deepStrictEqual(
      out[1].missing,
      ["export const keep"],
      "with the string it wanted",
    );
    assert.strictEqual(out[2].status, "OK", "a CRLF file is not called stale");
    assert.strictEqual(
      out[3].status,
      "MISSING",
      "an absent file is MISSING, not STALE",
    );

    // And the real tree has to satisfy its own list, or the markers are invented.
    const here = scan(path.join(__dirname, ".."), MARKERS);
    const wrong = here
      .filter((r) => r.status !== "OK")
      .map((r) => `${r.status} ${r.rel}`);
    assert.deepStrictEqual(
      wrong,
      [],
      "this check would lie about a healthy tree",
    );
    console.log(
      `self-test ok — ${out.length} fake cases, ${here.length} real files matched`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    selfTest();
    return 0;
  }

  let root = path.join(__dirname, "..");
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--root" && args[i + 1]) {
      root = path.resolve(args[i + 1]);
      i += 1; // consume the value, or it reads as an unknown flag
    } else if (args[i].startsWith("--root=")) {
      root = path.resolve(args[i].slice("--root=".length));
    } else {
      console.error(
        "usage: node scripts/check-workspace-sync.cjs [--root <dir>] [--self-test]",
      );
      return 2;
    }
  }

  const results = scan(root, MARKERS);
  const bad = results.filter((r) => r.status !== "OK");
  console.log(`workspace sync check — round ${SYNC_STAMP}`);
  console.log(`root: ${root}\n`);
  for (const r of results) {
    const size =
      r.bytes === undefined ? "        -" : `${String(r.bytes).padStart(8)}B`;
    console.log(
      `${r.status === "OK" ? " " : "!"} ${r.status.padEnd(8)}${size}  ${r.rel}`,
    );
    if (r.status !== "OK") {
      console.log(`             why it matters: ${r.why}`);
      console.log(
        `             not found: ${r.missing.map((m) => JSON.stringify(m)).join(", ")}`,
      );
    }
  }
  console.log(
    `\n${results.length - bad.length}/${results.length} files match round ${SYNC_STAMP}` +
      (bad.length
        ? ` — ${bad.length} to copy from the matching download`
        : " — tree is consistent"),
  );
  if (bad.length) {
    console.log(
      "\nCopy these, then re-run this check before the test suites:\n" +
        bad.map((r) => `  ${r.rel}`).join("\n") +
        "\n\nA stale file here is not a failing test: the test is right and the code next to it is old.",
    );
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { scan, MARKERS, SYNC_STAMP };
