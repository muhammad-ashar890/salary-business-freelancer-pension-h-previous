"use strict";
/**
 * DP-4 (fix53): the generalized row driver of the IRIS business tab
 * "Inadmissible/Admissible Deductions" (electron-connect/iris-business-row-
 * driver.js) -- rows of both pickers are created one at a time through the
 * flow proven live for 3212 (15-Oct-2026).
 *
 * Synthetic fixture modelled on captures 30 / 31 / 32: "+ Inadmissible" opens
 * "Add Inadmissible Deductions" (36 cards), "+ Admissible" opens "Add
 * Admissible Deductions" (10 cards); a row already in the grid shows checked +
 * disabled; ADD adds every ticked enabled card and closes the dialog. No
 * taxpayer data, no requests to FBR. Never Save / Calculate / Submit.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const navigation = require("../electron-connect/iris-navigation");
const driver = require("../electron-connect/iris-business-row-driver");
const filler = require("../electron-connect/iris-row-filler");

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
after(async () => {
  await browser?.close();
});

async function withPage(html, run, pagePath = "/nitr/workflow") {
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.route("**/*", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: html }),
  );
  await page.goto(`https://iris.fbr.gov.pk${pagePath}`);
  const mainFrame = {
    get url() {
      return page.url();
    },
    executeJavaScript: (source) => page.evaluate(source),
  };
  mainFrame.framesInSubtree = [mainFrame];
  const win = {
    isDestroyed: () => false,
    webContents: {
      mainFrame,
      getURL: () => page.url(),
      executeJavaScript: mainFrame.executeJavaScript,
    },
  };
  try {
    await run(page, win);
  } finally {
    await context.close();
  }
}

// ── Business return fixture (same structure as verify-business-agent-phase1) ──
const readinessHeader = `<app-wf-header><h6>Year 2026</h6><p><span>114(1) (Return of Income filed voluntarily for complete year)</span></p><p id="ready-registration">Registration No: 1234567890123</p></app-wf-header>`;
const readinessStyle = `<style>.body{min-height:80px}app-nitr-workflow,app-wf-header,app-nitr-wf-body,.body,mat-expansion-panel,mat-expansion-panel-header,.mat-expansion-panel-content{display:block}button,mat-expansion-panel-header{padding:12px;margin:4px;cursor:pointer}mat-expansion-panel-header[aria-expanded="false"]+.mat-expansion-panel-content{display:none}[hidden]{display:none!important}mat-dialog-container{display:block;position:fixed;top:10%;left:20%;width:480px;background:#fff;border:2px solid #888;z-index:20;padding:12px}.cdk-overlay-backdrop{position:fixed;inset:0;background:#0003;z-index:10}</style>`;
function businessFixture() {
  const specs = navigation.BUSINESS_CONTRACT;
  const tabs = Object.entries(specs)
    .map(
      ([id, s]) =>
        `<button class="data-tab-left-btn" onclick="actions.push('${id}');document.querySelectorAll('.data-tab-left-btn').forEach(b=>b.classList.remove('active'));this.classList.add('active');document.querySelectorAll('.business-grid').forEach(g=>g.hidden=true);document.getElementById('${id}').hidden=false">${s.tab}</button>`,
    )
    .join("");
  const grids = Object.entries(specs)
    .map(
      ([id, s]) =>
        `<div class="business-grid" id="${id}" hidden><div class="wf-sticky-toolbar"><div class="heading-bar"><strong>Description</strong><strong>Code</strong>${s.columns.map((c) => `<strong>${c}</strong>`).join("")}</div></div>${Object.entries(
          s.rows,
        )
          .map(
            ([code, r]) =>
              `<div class="tableRows dataRow" id="${code}"><div class="row-description-text">${r.label}</div><div class="columns-parent">${r.disabled.map((d) => `<div class="data-middle-child-wapper"><input type="text" ${d ? "disabled" : ""}></div>`).join("")}</div></div>`,
          )
          .join("")}</div>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8">${readinessStyle}<style>.business-grid{min-height:80px}.heading-bar strong{display:inline-block;margin:8px}.dataRow{display:flex;padding:5px}.columns-parent{display:flex}input{width:100px}button{display:inline-block}</style></head><body><a id="homeLink">Home</a><app-nitr-workflow>${readinessHeader}<app-nitr-wf-body><div class="custom-tabs"><div class="sticky-tabs-head"><div class="head"><div class="title active">Data</div></div></div><div class="body interface_21 active"><mat-expansion-panel><mat-expansion-panel-header aria-expanded="false" onclick="actions.push('BUSINESS_PANEL');this.setAttribute('aria-expanded','true');this.classList.add('mat-expanded')">Business</mat-expansion-panel-header><div class="mat-expansion-panel-content">${tabs}${grids}</div></mat-expansion-panel></div></div></app-nitr-wf-body></app-nitr-workflow><button onclick="actions.push('SAVE')">Save</button><button onclick="actions.push('CALCULATE')">Calculate</button><button onclick="actions.push('SUBMIT')">Submit</button><script>window.actions=[]</script></body></html>`;
}

const ROWS = navigation.BUSINESS_CONTRACT.business_deductions.rows;
const OPTIONAL = Object.entries(ROWS).filter(([, s]) => s.optional).map(([code]) => code);
const ADMISSIBLE = ["3245", "3246", "3247", "3248", "3250", "3254", "3255", "3256", "3257", "3258"];
const INADMISSIBLE = OPTIONAL.filter((code) => !ADMISSIBLE.includes(code));
const label = (code) => ROWS[code].label;

/**
 * Deductions grid with only the given optional rows present (plus the two
 * totals), and IRIS-like pickers behind "+ Inadmissible" / "+ Admissible".
 *   present: optional rows already in the grid
 *   missingCards: cards left out of a picker (a changed IRIS list)
 */
async function installDeductionPickers(page, { present = [], missingCards = [] } = {}) {
  await page.evaluate(
    ({ rows, optional, inadmissible, admissible, present, missingCards }) => {
      const grid = document.getElementById("business_deductions");
      for (const code of optional) if (!present.includes(code)) grid.querySelector(`[id="${code}"]`)?.remove();
      const rowHtml = (code) =>
        `<div class="tableRows dataRow" id="${code}"><div class="row-description-text">${rows[code].label}</div><div class="columns-parent">${rows[code].disabled
          .map((d) => `<div class="data-middle-child-wapper"><input type="text" ${d ? "disabled" : ""}></div>`)
          .join("")}</div></div>`;
      const open = (kind) => {
        const codes = (kind === "admissible" ? admissible : inadmissible).filter((c) => !missingCards.includes(c));
        actions.push(kind === "admissible" ? "OPEN_ADMISSIBLE" : "OPEN_INADMISSIBLE");
        const cards = codes
          .map((code, i) => {
            const inGrid = Boolean(grid.querySelector(`[id="${code}"]`));
            return `<div class="source-card" data-code="${code}"><mat-checkbox><input id="${kind}-${i}" type="checkbox" ${inGrid ? "checked disabled" : ""}></mat-checkbox><p>${rows[code].label}</p></div>`;
          })
          .join("");
        const title = kind === "admissible" ? "Add Admissible Deductions" : "Add Inadmissible Deductions";
        document.body.insertAdjacentHTML(
          "beforeend",
          `<div class="cdk-overlay-backdrop cdk-overlay-backdrop-showing"></div><mat-dialog-container role="dialog"><app-add-amount-code-row><h6>${title}<mat-icon>close</mat-icon></h6><input type="text" placeholder="Search Amount Code/Description">${cards}<button onclick="addRows()">ADD</button><button onclick="cancelPicker()">Cancel</button></app-add-amount-code-row></mat-dialog-container>`,
        );
      };
      window.openPicker = open;
      window.cancelPicker = () => {
        actions.push("CANCEL_PICKER");
        document.querySelector("mat-dialog-container")?.remove();
        document.querySelector(".cdk-overlay-backdrop")?.remove();
      };
      window.addRows = () => {
        const dialog = document.querySelector("mat-dialog-container");
        for (const box of dialog.querySelectorAll('input[type="checkbox"]:checked:not(:disabled)')) {
          const code = box.closest(".source-card").dataset.code;
          actions.push(`ADD_${code}`);
          grid.insertAdjacentHTML("beforeend", rowHtml(code));
        }
        dialog.remove();
        document.querySelector(".cdk-overlay-backdrop")?.remove();
      };
      grid.insertAdjacentHTML(
        "beforeend",
        '<button class="btn-section-add" onclick="openPicker(\'inadmissible\')">+ Inadmissible</button><button class="btn-section-add" onclick="openPicker(\'admissible\')">+ Admissible</button>',
      );
    },
    { rows: ROWS, optional: OPTIONAL, inadmissible: INADMISSIBLE, admissible: ADMISSIBLE, present, missingCards },
  );
}

const context = { mode: "live", taxYear: 2026, taxpayerIdentifier: "1234567890123", pickerWaitAttempts: 20, pickerWaitMs: 20 };
const field = (irisCode, value, extra = {}) => ({
  irisCode, value: String(value), sourceGroup: "businessFields", leftPanel: "Business",
  leftSection: "Inadmissible/Admissible Deductions", column: "Total Amount",
  irisDescription: label(irisCode), ...extra,
});
const actionsOf = (page) => page.evaluate("actions");
// Picker clicks only (opening the Business panel / tab is navigation).
const pickerActions = async (page) =>
  (await actionsOf(page)).filter((a) => /^(?:OPEN_|ADD_|CANCEL_PICKER)/.test(a));
const noCommit = async (page) =>
  assert.ok(!(await actionsOf(page)).some((a) => ["SAVE", "CALCULATE", "SUBMIT"].includes(a)));
const cellValue = (page, code) => page.locator(`[id="${code}"] input`).first().inputValue();

test("picker lists: 36 + 10 cards = the 46 optional rows; computed rows are never a target", () => {
  assert.equal(INADMISSIBLE.length, 36);
  assert.equal(ADMISSIBLE.length, 10);
  assert.deepEqual([...driver.ADMISSIBLE_CARD_CODES], ADMISSIBLE);
  for (const code of OPTIONAL) {
    const target = driver.deductionTarget(code);
    const typable = ROWS[code].disabled[0] === false;
    assert.equal(Boolean(target), typable, code);
    if (target) {
      assert.equal(target.label, label(code));
      assert.equal(target.pickerTitle, ADMISSIBLE.includes(code) ? "Add Admissible Deductions" : "Add Inadmissible Deductions");
      assert.equal(target.button, ADMISSIBLE.includes(code) ? "+ Admissible" : "+ Inadmissible");
    }
  }
  assert.equal(OPTIONAL.filter((code) => driver.deductionTarget(code)).length, 38, "38 typable rows (EEED) in capture 32");
  for (const code of ["3238", "3248", "3239", "3259", "9999", ""]) assert.equal(driver.deductionTarget(code), null, code);
  assert.equal(driver.deductionTarget("3212").reasons.added, "personal_reason_added_and_structure_verified");
  assert.equal(driver.deductionTarget("3211").reasons.added, "deduction_row_added_and_structure_verified");
});

test("both pickers: three rows are created one at a time (only our card ticked each time) and typed", async () => {
  await withPage(businessFixture(), async (page, win) => {
    await installDeductionPickers(page, { present: ["3238"] });
    const fields = [field("3211", 30000), field("3212", 50000), field("3256", 20000)];
    const out = await driver.ensureDeductionRows(win, fields, context);
    assert.equal(out.ok, true, JSON.stringify(out).slice(0, 2000));
    assert.equal(out.reason, "deduction_rows_ready");
    assert.deepEqual(out.rows.map((r) => [r.code, r.reason]), [
      ["3211", "deduction_row_added_and_structure_verified"],
      ["3212", "personal_reason_added_and_structure_verified"],
      ["3256", "deduction_row_added_and_structure_verified"],
    ]);
    assert.deepEqual(out.rows.map((r) => r.diagnostics.picker), [
      "Add Inadmissible Deductions", "Add Inadmissible Deductions", "Add Admissible Deductions",
    ]);
    for (const row of out.rows) {
      assert.deepEqual(row.diagnostics.changedOptions, [label(row.code)], row.code);
      assert.deepEqual(row.diagnostics.rowsAdded.map((r) => r.code), [row.code]);
      assert.deepEqual(row.diagnostics.rowsRemoved, []);
    }
    // 3238 (IRIS state, checked+disabled) was ignored, never re-added.
    assert.ok(out.rows[0].diagnostics.optionsBefore.checkedDisabled.includes(label("3238")));
    assert.deepEqual(await pickerActions(page), [
      "OPEN_INADMISSIBLE", "ADD_3211", "OPEN_INADMISSIBLE", "ADD_3212", "OPEN_ADMISSIBLE", "ADD_3256",
    ]);
    assert.equal(await page.locator("mat-dialog-container").count(), 0);
    const filled = await filler.fillIrisRows(win, fields, { sectionVerified: true });
    assert.equal(filled.summary.filled, 3, JSON.stringify(filled.results.map((r) => [r.irisCode, r.status])));
    assert.equal(await cellValue(page, "3211"), "30000");
    assert.equal(await cellValue(page, "3212"), "50000");
    assert.equal(await cellValue(page, "3256"), "20000");
    // A second run finds every row and clicks nothing.
    const again = await driver.ensureDeductionRows(win, fields, context);
    assert.equal(again.ok, true);
    assert.deepEqual(again.rows.map((r) => r.reason), ["existing_row_checked", "existing_row_checked", "existing_row_checked"]);
    assert.equal((await pickerActions(page)).length, 6);
    await noCommit(page);
  });
});

test("a row already in the grid is checked, not added again; duplicate fields of one code create it once", async () => {
  await withPage(businessFixture(), async (page, win) => {
    await installDeductionPickers(page, { present: ["3211"] });
    const out = await driver.ensureDeductionRows(win, [field("3211", 1), field("3258", 2), field("3258", 3)], context);
    assert.equal(out.ok, true, JSON.stringify(out).slice(0, 1500));
    assert.deepEqual(out.rows.map((r) => [r.code, r.reason]), [
      ["3211", "existing_row_checked"],
      ["3258", "deduction_row_added_and_structure_verified"],
    ]);
    assert.deepEqual(await pickerActions(page), ["OPEN_ADMISSIBLE", "ADD_3258"]);
  });
});

test("refused before any click: dry mode, a computed row, a wrong label, a non-business field", async () => {
  await withPage(businessFixture(), async (page, win) => {
    await installDeductionPickers(page);
    const dry = await driver.ensureDeductionRows(win, [field("3211", 1)], { ...context, mode: "dry" });
    assert.equal(dry.reason, "dry_run_no_row_creation");
    const computed = await driver.ensureDeductionRows(win, [field("3211", 1), field("3238", 1)], context);
    assert.deepEqual([computed.ok, computed.reason, computed.code], [false, "deduction_row_not_creatable", "3238"]);
    const wrongLabel = await driver.ensureDeductionRows(win, [field("3211", 1, { irisDescription: "Add Backs u/s 21(g) Fine" })], context);
    assert.deepEqual([wrongLabel.ok, wrongLabel.reason], [false, "deduction_label_mismatch"]);
    const salary = await driver.ensureDeductionRows(win, [field("3211", 1, { sourceGroup: "salary" })], context);
    assert.equal(salary.reason, "unsupported_business_reason");
    const none = await driver.ensureDeductionRows(win, [], context);
    assert.equal(none.reason, "no_deduction_rows_requested");
    assert.deepEqual(await actionsOf(page), []);
  });
});

test("a card missing from the picker: Cancel is pressed, the picker closes, later rows are not attempted; the first row stays", async () => {
  await withPage(businessFixture(), async (page, win) => {
    await installDeductionPickers(page, { missingCards: ["3256"] });
    const out = await driver.ensureDeductionRows(win, [field("3211", 1), field("3256", 2), field("3258", 3)], context);
    assert.equal(out.ok, false);
    assert.equal(out.failedCode, "3256");
    assert.equal(out.reason, "deduction_reason_not_unique");
    assert.deepEqual(out.notAttempted, ["3258"]);
    assert.equal(out.rows[0].ok, true);
    assert.deepEqual(out.rows[1].cleanup, { clicked: true, closed: true, reason: "picker_cancel_clicked" });
    assert.deepEqual(await pickerActions(page), ["OPEN_INADMISSIBLE", "ADD_3211", "OPEN_ADMISSIBLE", "CANCEL_PICKER"]);
    assert.equal(await page.locator("mat-dialog-container").count(), 0);
    assert.equal(await page.locator('[id="3258"]').count(), 0);
    await noCommit(page);
  });
});

test("an unrequested tick in the picker is never touched or added; the picker is cancelled", async () => {
  await withPage(businessFixture(), async (page, win) => {
    await installDeductionPickers(page);
    await page.evaluate(() => {
      const original = window.openPicker;
      window.openPicker = (kind) => {
        original(kind);
        document.querySelector('.source-card[data-code="3201"] input').checked = true; // someone else's tick
      };
    });
    const out = await driver.ensureDeductionRows(win, [field("3211", 1)], context);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "unrelated_picker_selection_not_touched");
    assert.deepEqual(out.rows[0].diagnostics.unrelated, [label("3201")]);
    assert.equal(out.rows[0].cleanup.closed, true);
    assert.equal(await page.locator('[id="3201"]').count(), 0);
    assert.equal(await page.locator('[id="3211"]').count(), 0);
  });
});

test("a leftover picker of the other type is closed with its own Cancel first; any other dialog is never touched", async () => {
  await withPage(businessFixture(), async (page, win) => {
    await installDeductionPickers(page);
    const moved = await navigation.navigateToSection(win, { sectionId: "business_deductions", taxYear: 2026, taxpayerIdentifier: "1234567890123" });
    assert.ok(moved.ok);
    await page.evaluate(() => {
      window.openPicker("admissible");
      actions.length = 0;
    });
    const out = await driver.ensureDeductionRows(win, [field("3211", 1)], context);
    assert.equal(out.ok, true, JSON.stringify(out).slice(0, 1500));
    assert.equal(out.rows[0].diagnostics.leftoverCleanup.closed, true);
    assert.deepEqual(await actionsOf(page), ["CANCEL_PICKER", "OPEN_INADMISSIBLE", "ADD_3211"]);
  });
  await withPage(businessFixture(), async (page, win) => {
    await installDeductionPickers(page);
    const moved = await navigation.navigateToSection(win, { sectionId: "business_deductions", taxYear: 2026, taxpayerIdentifier: "1234567890123" });
    assert.ok(moved.ok);
    await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", '<mat-dialog-container role="dialog"><h6>Verify</h6><input type="text" name="otp"><button onclick="actions.push(\'OTHER_CANCEL\')">Cancel</button></mat-dialog-container>');
      actions.length = 0;
    });
    const out = await driver.ensureDeductionRows(win, [field("3211", 1)], context);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "dialog_present");
    assert.deepEqual(await actionsOf(page), []);
  });
});

test("3212 alone keeps the fix44 entry point and result names", async () => {
  await withPage(businessFixture(), async (page, win) => {
    await installDeductionPickers(page);
    const personal = field("3212", 80000);
    const out = await driver.ensurePersonalAddbackRow(win, [personal], context);
    assert.equal(out.ok, true, JSON.stringify(out).slice(0, 1500));
    assert.equal(out.reason, "personal_reason_added_and_structure_verified");
    assert.equal(out.diagnostics.picker, "Add Inadmissible Deductions");
    assert.equal(out.diagnostics.target, "Add Backs u/s 21(h) Personal Expenditure");
    const refused = await driver.ensurePersonalAddbackRow(win, [field("3211", 1)], context);
    assert.equal(refused.reason, "unsupported_business_reason");
  });
});

test("agent wiring: main.js makes every deductions row ready before typing and accepts packet v7", () => {
  const main = fs.readFileSync(path.join(__dirname, "../electron-connect/main.js"), "utf8");
  assert.match(main, /irisBusinessRowDriver\.ensureDeductionRows\(windowInstance, group\.fields/);
  assert.ok(!/irisBusinessRowDriver\.ensurePersonalAddbackRow\(/.test(main), "one entry point for the group");
  assert.match(main, /blockedDeductionRows\.has\(String\(field\.irisCode\)\)/);
  assert.match(main, /snapshot\.business\?\.version !== "business-entry-v7"/);
  for (const list of [
    '"business-entry-v4", "business-entry-v5", "business-entry-v6", "business-entry-v7"',
    '"business-entry-v5", "business-entry-v6", "business-entry-v7"',
    '"business-entry-v3", "business-entry-v4", "business-entry-v5", "business-entry-v6", "business-entry-v7"',
  ])
    assert.ok(main.includes(list), list);
  assert.match(main, /const AGENT_BUILD_TAG = "wealth-recon-20261027f"/);
  assert.equal(driver.BUILD_TAG, "wealth-recon-20261027f");
  const source = fs.readFileSync(path.join(__dirname, "../electron-connect/iris-business-row-driver.js"), "utf8");
  assert.ok(!/\b(?:Save|Submit|Calculate)\b['"]/.test(source), "the driver never looks for Save / Submit / Calculate");
});
