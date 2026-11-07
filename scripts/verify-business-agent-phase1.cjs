"use strict";
/**
 * Phase 1 (fix46): agent unblock + full tracking.
 *
 * Synthetic fixtures modelled on the structure of the live IRIS captures
 * (business 30/31/32/56/66/67 pickers, 11 tabs/top tabs) plus the repo's
 * sanitized live wealth fixtures. No taxpayer data, no requests to FBR; every
 * request is fulfilled locally. Never Save / Calculate / Submit.
 *
 * Covers:
 *  A1  checked+disabled picker options are IRIS state and are ignored
 *  A2  any failure presses the picker's own Cancel and confirms it closed;
 *      a leftover agent picker is recognised and closed (run start, readiness)
 *  A6/A7 read-only census tour of every tab + readback after tab switch
 *  logs: per-figure field log, report sections, local HTML snapshot script
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { chromium } = require("playwright");
const navigation = require("../electron-connect/iris-navigation");
const driver = require("../electron-connect/iris-business-row-driver");
const census = require("../electron-connect/iris-tour-census");
const report = require("../electron-connect/job-report");

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

// ── Business return fixture (same structure the navigation suite uses) ─────
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

const PERSONAL = "Add Backs u/s 21(h) Personal Expenditure";
const context = { mode: "live", taxYear: 2026, taxpayerIdentifier: "1234567890123", pickerWaitAttempts: 20, pickerWaitMs: 20 };
const personalField = { irisCode: "3212", sourceGroup: "businessFields", leftPanel: "Business", leftSection: "Inadmissible/Admissible Deductions", column: "Total Amount", value: "80000" };

/**
 * Picker modelled on captures 30/32/66: app-add-amount-code-row, h6 title with
 * a close icon, the search box, option cards, ADD and Cancel.
 *   cards: [{ label, checked, disabled }]  (target added unless listed)
 *   addAlwaysDisabled: ADD never becomes enabled
 *   autoTickExtra: IRIS ticks another enabled option when ours is ticked
 */
async function installPicker(page, options = {}) {
  await page.evaluate((opts) => {
    document.querySelector('[id="3212"]')?.remove();
    const grid = document.getElementById("business_deductions");
    const personal = "Add Backs u/s 21(h) Personal Expenditure";
    const cards = opts.cards || [];
    if (!cards.some((c) => c.label === personal)) cards.unshift({ label: personal });
    window.openPersonalPicker = () => {
      actions.push("OPEN_PERSONAL_PICKER");
      const html = cards
        .map(
          (c, i) =>
            `<div class="source-card"><mat-checkbox class="${c.checked ? "mat-mdc-checkbox-checked" : ""} ${c.disabled ? "mat-mdc-checkbox-disabled" : ""}"><input id="opt-${i}" type="checkbox" ${c.checked ? "checked" : ""} ${c.disabled ? "disabled" : ""}></mat-checkbox><p>${c.label}</p></div>`,
        )
        .join("");
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div class="cdk-overlay-backdrop cdk-overlay-backdrop-showing"></div><mat-dialog-container role="dialog"><app-add-amount-code-row><h6>Add Inadmissible Deductions<mat-icon>close</mat-icon></h6><input type="text" placeholder="Search Amount Code/Description">${html}<button id="picker-add" disabled onclick="addPersonalReason()">ADD</button><button onclick="cancelPicker()">Cancel</button></app-add-amount-code-row></mat-dialog-container>`,
      );
      const dialog = document.querySelector("mat-dialog-container");
      dialog.addEventListener("change", (event) => {
        const target = event.target;
        if (!opts.addAlwaysDisabled)
          document.getElementById("picker-add").disabled = !dialog.querySelector(
            'input[type="checkbox"]:checked:not(:disabled)',
          );
        if (opts.autoTickExtra && target.id === "opt-0" && target.checked) {
          const extra = [...dialog.querySelectorAll('input[type="checkbox"]')].find(
            (b, i) => i > 0 && !b.checked && !b.disabled,
          );
          if (extra) extra.checked = true;
        }
      });
    };
    window.cancelPicker = () => {
      actions.push("CANCEL_PICKER");
      document.querySelector("mat-dialog-container")?.remove();
      document.querySelector(".cdk-overlay-backdrop")?.remove();
    };
    window.addPersonalReason = () => {
      actions.push("ADD_PERSONAL_REASON");
      grid.insertAdjacentHTML(
        "beforeend",
        `<div class="tableRows dataRow" id="3212"><div class="row-description-text">${personal}</div><div class="columns-parent"><div class="data-middle-child-wapper"><input type="text"></div><div class="data-middle-child-wapper"><input type="text"></div><div class="data-middle-child-wapper"><input type="text"></div><div class="data-middle-child-wapper"><input type="text" disabled></div></div></div>`,
      );
      window.cancelPicker();
      actions.pop(); // ADD closes the dialog; it is not a Cancel
    };
    grid.insertAdjacentHTML(
      "beforeend",
      '<button class="btn-section-add" onclick="openPersonalPicker()">+ Inadmissible</button>',
    );
  }, options);
}
const actionsOf = (page) => page.evaluate("actions");
const noCommit = async (page) =>
  assert.ok(!(await actionsOf(page)).some((a) => ["SAVE", "CALCULATE", "SUBMIT"].includes(a)));

// ── A1: checked + disabled options are IRIS state ─────────────────────────
test("A1: checked+disabled options (rows IRIS already has) are ignored; only our option is ticked and the row is created", async () => {
  await withPage(businessFixture(), async (page, win) => {
    await installPicker(page, {
      cards: [
        { label: PERSONAL },
        { label: "Add Backs Accounting Depreciation", checked: true, disabled: true },
        { label: "Add Backs u/s 21(i) Expenditure", checked: true, disabled: true },
        { label: "Other unrequested reason" },
      ],
    });
    const out = await driver.ensurePersonalAddbackRow(win, [personalField], context);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.reason, "personal_reason_added_and_structure_verified");
    const d = out.diagnostics;
    assert.equal(d.optionsBefore.total, 4);
    assert.deepEqual(d.optionsBefore.checkedDisabled, ["Add Backs Accounting Depreciation", "Add Backs u/s 21(i) Expenditure"]);
    assert.deepEqual(d.optionsBefore.checkedEnabled, []);
    assert.deepEqual(d.changedOptions, [PERSONAL]);
    assert.deepEqual(d.alreadyPresent, ["Add Backs Accounting Depreciation", "Add Backs u/s 21(i) Expenditure"]);
    assert.deepEqual(d.rowsAdded.map((r) => r.code), ["3212"]);
    assert.deepEqual(d.rowsRemoved, []);
    assert.equal(await page.locator('[id="3212"]').count(), 1);
    assert.equal(await page.locator("mat-dialog-container").count(), 0);
    const actions = await actionsOf(page);
    assert.equal(actions.filter((a) => a === "ADD_PERSONAL_REASON").length, 1);
    assert.ok(!actions.includes("CANCEL_PICKER"));
    await noCommit(page);
  });
});

test("A1: the live failure pattern (every other option checked+disabled, as in captures 56/66/67) no longer aborts", async () => {
  await withPage(businessFixture(), async (page, win) => {
    const cards = [{ label: PERSONAL }];
    for (let i = 0; i < 14; i++) cards.push({ label: `Existing row ${i + 1}`, checked: true, disabled: true });
    await installPicker(page, { cards });
    const out = await driver.ensurePersonalAddbackRow(win, [personalField], context);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.diagnostics.optionsBefore.checkedDisabled.length, 14);
  });
});

test("A1: our own option shown checked+disabled means IRIS has the row; if the row is not visible the picker is cancelled and it is reported", async () => {
  await withPage(businessFixture(), async (page, win) => {
    await installPicker(page, { cards: [{ label: PERSONAL, checked: true, disabled: true }] });
    const out = await driver.ensurePersonalAddbackRow(win, [personalField], context);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "personal_reason_marked_present_but_row_not_visible");
    assert.equal(out.cleanup.closed, true);
    assert.equal(await page.locator("mat-dialog-container").count(), 0);
    assert.ok(!(await actionsOf(page)).includes("ADD_PERSONAL_REASON"));
  });
});

// ── A2: Cancel on every failure, leftovers closed ─────────────────────────
test("A2: ADD that never becomes ready presses Cancel and confirms the picker closed; nothing is added", async () => {
  await withPage(businessFixture(), async (page, win) => {
    await installPicker(page, { addAlwaysDisabled: true });
    const out = await driver.ensurePersonalAddbackRow(win, [personalField], context);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "picker_add_not_ready");
    assert.deepEqual(out.cleanup, { clicked: true, closed: true, reason: "picker_cancel_clicked" });
    assert.equal(await page.locator("mat-dialog-container").count(), 0);
    assert.equal(await page.locator('[id="3212"]').count(), 0);
    const actions = await actionsOf(page);
    assert.ok(actions.includes("CANCEL_PICKER"));
    assert.ok(!actions.includes("ADD_PERSONAL_REASON"));
    await noCommit(page);
  });
});

test("A2: an option IRIS ticks by itself is caught before ADD; the picker is cancelled", async () => {
  await withPage(businessFixture(), async (page, win) => {
    await installPicker(page, { autoTickExtra: true, cards: [{ label: PERSONAL }, { label: "Other reason" }] });
    const out = await driver.ensurePersonalAddbackRow(win, [personalField], context);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "picker_changed_unexpectedly");
    assert.deepEqual(out.changed, [PERSONAL, "Other reason"]);
    assert.equal(out.cleanup.closed, true);
    assert.ok(!(await actionsOf(page)).includes("ADD_PERSONAL_REASON"));
  });
});

test("A2: a leftover picker of ours is closed first, then a fresh picker creates the row", async () => {
  await withPage(businessFixture(), async (page, win) => {
    await installPicker(page);
    const moved = await navigation.navigateToSection(win, { sectionId: "business_deductions", taxYear: 2026, taxpayerIdentifier: "1234567890123" });
    assert.ok(moved.ok);
    await page.evaluate(() => {
      window.openPersonalPicker();
      document.getElementById("opt-0").click();
      actions.length = 0;
    });
    const out = await driver.ensurePersonalAddbackRow(win, [personalField], context);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.diagnostics.leftoverCleanup.closed, true);
    assert.deepEqual(await actionsOf(page), ["CANCEL_PICKER", "OPEN_PERSONAL_PICKER", "ADD_PERSONAL_REASON"]);
  });
});

test("A2: a dialog that is not our picker is never touched", async () => {
  await withPage(businessFixture(), async (page, win) => {
    await installPicker(page);
    const moved = await navigation.navigateToSection(win, { sectionId: "business_deductions", taxYear: 2026, taxpayerIdentifier: "1234567890123" });
    assert.ok(moved.ok);
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        "beforeend",
        '<mat-dialog-container role="dialog"><h6>Verify</h6><input type="text" name="otp"><button onclick="actions.push(\'OTHER_CANCEL\')">Cancel</button></mat-dialog-container>',
      );
      actions.length = 0; // only what the driver does from here on counts
    });
    const out = await driver.ensurePersonalAddbackRow(win, [personalField], context);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "dialog_present");
    assert.equal(await page.locator("mat-dialog-container").count(), 1);
    assert.deepEqual(await actionsOf(page), []);
  });
});

// ── A2: recognising agent pickers in the navigator ────────────────────────
const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, "../test-fixtures/iris/wealth", name), "utf8");
async function dialogKinds(html) {
  let kinds;
  await withPage(html, async (_page, win) => {
    const out = await navigation.probeFrames(win, { taxYear: 2026 });
    kinds = out.frames[0].dialogs.map((d) => ({ kind: d.kind, pickerTitle: d.pickerTitle }));
  });
  return kinds;
}
test("A2: the live IRIS pickers in the sanitized wealth fixtures are recognised as agent pickers", async () => {
  assert.deepEqual(await dialogKinds(fixture("modal-expenses.html")), [{ kind: "agent_picker", pickerTitle: "Add Personal Expenses" }]);
  assert.deepEqual(await dialogKinds(fixture("modal-financial-assets.html")), [
    { kind: "agent_picker", pickerTitle: "Add Financial Assets & Investments (Non-Business)" },
  ]);
});
const pickerHtml = ({ title = "Add Minimum Tax", cards = ["153(1)(a) Payments for goods"], extra = "", buttons = "<button>ADD</button><button>Cancel</button>" } = {}) =>
  `<!doctype html><html><head>${readinessStyle}</head><body><mat-dialog-container role="dialog"><app-add-amount-code-row><h6>${title}<mat-icon>close</mat-icon></h6><input type="text" placeholder="Search Amount Code/Description">${extra}${cards.map((c) => `<div class="source-card"><input type="checkbox" checked disabled><p>${c}</p></div>`).join("")}${buttons}</app-add-amount-code-row></mat-dialog-container></body></html>`;
test("A2: option text such as 'payments' does not make a picker a verification dialog; unknown titles are not exported", async () => {
  assert.deepEqual(await dialogKinds(pickerHtml()), [{ kind: "agent_picker", pickerTitle: "Add Minimum Tax" }]);
  assert.deepEqual(await dialogKinds(pickerHtml({ title: "Add Something New" })), [{ kind: "agent_picker", pickerTitle: "[unrecognized picker]" }]);
});
test("A2: anything with a real entry box, OTP wording or a commit button stays protected", async () => {
  for (const html of [
    pickerHtml({ extra: '<input type="text" name="otp" placeholder="Enter OTP">' }),
    pickerHtml({ title: "Add OTP verification" }),
    pickerHtml({ buttons: "<button>ADD</button><button>Cancel</button><button>Submit</button>" }),
    pickerHtml({ extra: "<textarea></textarea>" }),
  ]) {
    const kinds = await dialogKinds(html);
    assert.equal(kinds.length, 1);
    assert.notEqual(kinds[0].kind, "agent_picker", html);
    assert.equal(kinds[0].pickerTitle, undefined);
  }
});

test("A2: at run start a leftover agent picker is closed with its own Cancel instead of pausing as 'portal_popup'", async () => {
  const page = `<!doctype html><html><head>${readinessStyle}</head><body><a id="homeLink" href="/dashboard">Home</a>
<a id="draft" onclick="actions.push('draft')">Draft (Unsubmitted Documents)</a>
<div class="cdk-overlay-backdrop cdk-overlay-backdrop-showing"></div><mat-dialog-container role="dialog"><app-add-amount-code-row><h6>Add Inadmissible Deductions<mat-icon>close</mat-icon></h6><input type="text" placeholder="Search Amount Code/Description"><div class="source-card"><input type="checkbox"><p>${PERSONAL}</p></div><button>ADD</button><button onclick="actions.push('CANCEL_PICKER');document.querySelector('mat-dialog-container').remove();document.querySelector('.cdk-overlay-backdrop').remove()">Cancel</button></app-add-amount-code-row></mat-dialog-container>
<script>window.actions=[]</script></body></html>`;
  await withPage(page, async (p, win) => {
    const steps = [];
    const out = await navigation.inspectNavigation(win, { taxYear: 2026, onStep: (step, detail) => steps.push([step, detail]) });
    assert.notEqual(out.requiredAction, "portal_popup");
    const cancelled = steps.find(([step]) => step === "agent_picker_cancelled");
    assert.ok(cancelled, JSON.stringify(steps));
    assert.match(cancelled[1], /Add Inadmissible Deductions/);
    assert.match(cancelled[1], /\(clicked\)/);
    assert.equal(await p.locator("mat-dialog-container").count(), 0);
    assert.equal((await actionsOf(p))[0], "CANCEL_PICKER");
  }, "/dashboard");
});

test("A2: a protected dialog at run start still pauses as before, with its kind in the log", async () => {
  const page = `<!doctype html><html><head>${readinessStyle}</head><body><a id="homeLink">Home</a><mat-dialog-container role="dialog"><h6>Verification</h6><input type="text" name="otp"><button onclick="actions.push('OTHER')">Close</button></mat-dialog-container><script>window.actions=[]</script></body></html>`;
  await withPage(page, async (p, win) => {
    const steps = [];
    const out = await navigation.inspectNavigation(win, { taxYear: 2026, onStep: (step, detail) => steps.push([step, detail]) });
    assert.equal(out.requiredAction, "portal_popup");
    assert.match(steps.find(([s]) => s === "portal_popup")[1], /protected/);
    assert.deepEqual(await actionsOf(p), []);
  }, "/dashboard");
});

test("A2/tracking: business readiness closes a leftover agent picker once, then reports the wait with reasons and time", async () => {
  await withPage(businessFixture(), async (page, win) => {
    await installPicker(page);
    const moved = await navigation.navigateToSection(win, { sectionId: "business_deductions", taxYear: 2026, taxpayerIdentifier: "1234567890123" });
    assert.ok(moved.ok);
    await page.evaluate(() => window.openPersonalPicker());
    const steps = [];
    const ready = await navigation.waitForBusinessSectionReady(win, {
      sectionId: "business_deductions", taxYear: 2026, taxpayerIdentifier: "1234567890123",
      timeoutMs: 3000, pollMs: 20, onStep: (step, detail) => steps.push([step, detail]),
    });
    assert.equal(ready.ok, true, JSON.stringify({ status: ready.status, trace: ready.trace }));
    assert.ok(ready.waitedMs >= 0);
    assert.equal(ready.trace[0].reason, "agent_picker_open");
    assert.ok(steps.some(([s, d]) => s === "agent_picker_cancelled" && /Add Inadmissible Deductions/.test(d)));
    assert.match(steps.find(([s]) => s === "business_section_ready")[1], /verified twice in \d+ ms/);
    assert.ok((await actionsOf(page)).includes("CANCEL_PICKER"));
  });
});

test("tracking: a locked grid times out with the reason sequence and duration in the log and the result", async () => {
  await withPage(businessFixture(), async (page, win) => {
    const moved = await navigation.navigateToSection(win, { sectionId: "business_admin", taxYear: 2026, taxpayerIdentifier: "1234567890123" });
    assert.ok(moved.ok);
    await page.evaluate(() => document.querySelectorAll("#business_admin input:not(:disabled)").forEach((i) => (i.readOnly = true)));
    const steps = [];
    const ready = await navigation.waitForBusinessSectionReady(win, {
      sectionId: "business_admin", taxYear: 2026, taxpayerIdentifier: "1234567890123",
      timeoutMs: 200, pollMs: 20, onStep: (step, detail) => steps.push([step, detail]),
    });
    assert.equal(ready.ok, false);
    assert.equal(ready.status, "business_inputs_read_only");
    assert.ok(ready.waitedMs >= 200);
    assert.deepEqual(ready.trace.map((t) => t.reason), ["business_inputs_read_only"]);
    assert.match(steps.find(([s]) => s === "business_section_readiness_timeout")[1], /after \d+ ms \(waits: business_inputs_read_only@\d+ms\)/);
  });
});

// ── A7: read-only census tour of every tab ────────────────────────────────
const censusPage = ({ dialog = false } = {}) => {
  const panels = [
    ["Business", ["Manufacturing/ Trading Items", "Other Revenues", "Admin, Selling & Financial Expenses", "Inadmissible/Admissible Deductions", "Adjustments", "7F Tax Builders and Developers", "Income from Social Media Content", "Tax Deduction", "Balance Sheet"]],
    ["Tax Chargeable / Payments", ["Allowances, Reductions and Credits", "Withholding Tax", "Computations"]],
    ["116 - Wealth Statement", ["Personal Assets / Liabilities", "Reconciliation of Net Assets"]],
  ];
  let n = 0;
  const grids = [];
  const panelHtml = panels
    .map(([name, tabs], pi) => {
      const buttons = tabs
        .map((tab) => {
          const id = `g${n++}`;
          const active = tab === "Balance Sheet";
          grids.push(
            `<div class="grid" id="${id}" ${active ? "" : "hidden"}><div class="heading-bar"><strong>${tab}</strong></div>` +
              `<div class="tableRows dataRow" id="${3000 + n}"><div class="row-description-text">Total ${tab}</div><div class="columns-parent"><div class="data-middle-child-wapper"><input type="text" disabled value="${n * 1000}"></div></div></div>` +
              `<div class="tableRows dataRow" id="${3500 + n}"><div class="row-description-text">Entry ${tab}</div><div class="columns-parent"><div class="data-middle-child-wapper"><input type="text" value=""></div></div></div>` +
              (tab === "Tax Deduction"
                ? `<mat-expansion-panel><mat-expansion-panel-header aria-expanded="false" onclick="actions.push('SUBPANEL')">Adjustable Tax</mat-expansion-panel-header><div class="mat-expansion-panel-content"><div class="tableRows dataRow" id="640001"><div class="row-description-text">Sale of goods</div><div class="columns-parent"><div class="data-middle-child-wapper"><input type="text" value="25000"></div><div class="data-middle-child-wapper"><input type="text" disabled value=""></div></div></div></div></mat-expansion-panel>`
                : "") +
              (tab === "Balance Sheet"
                ? `<button class="btn-section-add">+ Property</button><div class="tableRows dataRow" id="3302"><div class="row-description-text">Building (Business) - Flat, 10 Marla, 1, 2, City, District, Province</div><div class="columns-parent"><div class="data-middle-child-wapper"><input type="text" value="5000000"></div></div><mat-icon title="Edit Property"></mat-icon><mat-icon title="Swap Property"></mat-icon></div>`
                : "") +
              `</div>`,
          );
          return `<button class="data-tab-left-btn ${active ? "active" : ""}" onclick="leftTab(this,'${id}')">${tab}</button>`;
        })
        .join("");
      return `<mat-expansion-panel><mat-expansion-panel-header aria-expanded="${pi === 0}" class="${pi === 0 ? "mat-expanded" : ""}" onclick="actions.push('PANEL:${name}');this.setAttribute('aria-expanded','true');this.classList.add('mat-expanded')">${name}</mat-expansion-panel-header><div class="mat-expansion-panel-content">${buttons}</div></mat-expansion-panel>`;
    })
    .join("");
  const toggle = (id) =>
    `<mat-slide-toggle class="hide"><div class="mdc-form-field"><button role="switch" aria-checked="true" aria-labelledby="${id}"></button><label id="${id}">Auto Calculate</label></div></mat-slide-toggle>`;
  const tops = ["Data", "Amortization", "Depreciation", "Business Details", "Payment", "Attachment"];
  const bodies = [
    `<div class="body interface_21 active">${toggle("ac-data")}${panelHtml}${grids.join("")}</div>`,
    `<div class="body interface_22">${toggle("ac-amort")}<div class="tableRows" id="3305"><div class="row-description-text">Intangibles</div><input class="data-middle-child" value=""><input class="data-middle-child" disabled value="0"></div></div>`,
    `<div class="body interface_23">${toggle("ac-dep")}<div class="tableRows" id="330308"><div class="row-description-text">Plant</div><input class="data-middle-child" disabled value=""><input class="data-middle-child" value="600000"></div></div>`,
    `<div class="body business-details-container interface_85"><div class="custom-panel"><h6>Business Details</h6></div></div>`,
    `<div class="body interface_61"><h6>Payment</h6></div>`,
    `<div class="body interface_204"><h6>Attachment</h6></div>`,
  ];
  return `<!doctype html><html><head>${readinessStyle}<style>.hide{display:none}.grid{min-height:40px}input{width:90px}.custom-tabs .body{display:none}.custom-tabs .body.active{display:block}.title{display:inline-block;padding:8px;cursor:pointer}</style></head><body><app-nitr-workflow><app-nitr-wf-body><div class="custom-tabs"><div class="sticky-tabs-head"><div class="head">${tops
    .map((t, i) => `<div><span class="font-15 title ${i === 0 ? "active" : ""}" onclick="topTab(${i})">${t}</span></div>`)
    .join("")}</div></div>${bodies.join("")}</div></app-nitr-wf-body></app-nitr-workflow>
${dialog ? '<mat-dialog-container role="dialog"><h6>Something</h6><button>Close</button></mat-dialog-container>' : ""}
<button onclick="actions.push('SAVE')">Save</button><button onclick="actions.push('CALCULATE')">Calculate</button><button onclick="actions.push('SUBMIT')">Submit</button>
<script>window.actions=[];
function topTab(i){actions.push('TOP:'+i);document.querySelectorAll('.head .title').forEach((t,j)=>t.classList.toggle('active',j===i));document.querySelectorAll('.custom-tabs > .body').forEach((b,j)=>b.classList.toggle('active',j===i));}
function leftTab(btn,id){actions.push('LEFT:'+btn.textContent);document.querySelectorAll('.data-tab-left-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');document.querySelectorAll('.grid').forEach(g=>g.hidden=g.id!==id);}
</script></body></html>`;
};
const allValues = (page) => page.evaluate(() => [...document.querySelectorAll("input")].map((i) => i.value));

test("A7: the census tour reads every left tab and every top tab, read only, and returns to where it started", async () => {
  await withPage(censusPage(), async (page, win) => {
    const before = await allValues(page);
    const steps = [];
    const tour = await census.runCensusTour(win, { label: "test", settleTimeoutMs: 3000, pollMs: 30, onStep: (s, d) => steps.push([s, d]) });
    assert.equal(tour.complete, true, tour.stoppedReason);
    assert.equal(tour.views.length, 19, tour.views.map((v) => v.key).join(" | "));
    assert.ok(tour.views.every((v) => v.ok), JSON.stringify(tour.views.filter((v) => !v.ok)));
    assert.deepEqual(tour.views.filter((v) => v.kind === "left").map((v) => v.panel), [...Array(9).fill("Business"), ...Array(3).fill("Tax Chargeable / Payments"), ...Array(2).fill("116 - Wealth Statement")]);
    assert.deepEqual(tour.views.filter((v) => v.kind === "top").map((v) => v.tab), ["Amortization", "Depreciation", "Business Details", "Payment", "Attachment"]);
    const balance = tour.views.find((v) => v.key === "Business > Balance Sheet");
    assert.equal(balance.autoCalculate, true);
    assert.deepEqual(balance.sectionButtons, ["+ Property"]);
    const building = balance.rows.find((r) => r.code === "3302");
    assert.deepEqual(building.icons, ["Edit Property", "Swap Property"]);
    assert.deepEqual(building.cells, [{ value: "5000000", editable: true }]);
    assert.deepEqual(balance.counts, { rows: 3, cells: 3, editable: 2, prefilled: 2 });
    const depreciation = tour.views.find((v) => v.key === "Top: Depreciation");
    assert.equal(depreciation.autoCalculate, true);
    assert.deepEqual(depreciation.rows[0].cells, [{ value: "", editable: false }, { value: "600000", editable: true }]);
    assert.equal(tour.views.find((v) => v.key === "Top: Payment").autoCalculate, null);
    // grid panels inside a view are recorded (and read even when collapsed),
    // never treated as navigation panels or clicked
    const taxDeduction = tour.views.find((v) => v.key === "Business > Tax Deduction");
    assert.deepEqual(taxDeduction.gridPanels, [{ label: "Adjustable Tax", expanded: false, rows: 1 }]);
    const sale = taxDeduction.rows.find((r) => r.code === "640001");
    assert.equal(sale.inCollapsedPanel, true);
    assert.deepEqual(sale.cells, [{ value: "25000", editable: true }, { value: "", editable: false }]);
    assert.ok(!(await actionsOf(page)).includes("SUBPANEL"));
    // back to Data > Balance Sheet; nothing typed; no Save/Calculate/Submit
    assert.equal(tour.restored, true);
    const state = await page.evaluate(() => ({
      top: document.querySelector(".head .title.active").textContent,
      left: document.querySelector(".data-tab-left-btn.active").textContent,
    }));
    assert.deepEqual(state, { top: "Data", left: "Balance Sheet" });
    assert.deepEqual(await allValues(page), before);
    assert.ok((await actionsOf(page)).every((a) => /^(TOP|LEFT|PANEL):/.test(a)));
    assert.ok(steps.some(([s, d]) => s === "census_view" && /Business > Balance Sheet: read in \d+ ms; 3 rows, 2 editable cells, 2 cells with a value; Auto Calculate ON; buttons: \+ Property/.test(d)));
    // compact summary carries no cell values
    const summary = census.summariseTour(tour);
    assert.equal(summary.views.length, 19);
    assert.ok(!JSON.stringify(summary).includes("5000000"));
  });
});

test("A7: the census tour never clicks behind an open dialog", async () => {
  await withPage(censusPage({ dialog: true }), async (page, win) => {
    const tour = await census.runCensusTour(win, { label: "test", settleTimeoutMs: 500, pollMs: 30 });
    assert.equal(tour.complete, false);
    assert.equal(tour.stoppedReason, "dialog_open");
    assert.deepEqual(await actionsOf(page), []);
  });
});

// ── A6: readback after tab switch ─────────────────────────────────────────
test("A6: typed figures are compared with what IRIS shows after the tab switches", () => {
  const tour = {
    views: [
      { key: "Business > Admin", rows: [{ code: "3151", description: "Rent", descriptionRaw: "Rent", cells: [{ value: "240,000" }, { value: "" }, null, { value: "" }] }] },
      { key: "Business > Balance Sheet", rows: [
        { code: "3303", description: "Plant", descriptionRaw: "Plant", cells: [{ value: "" }] },
        { code: "3302", description: "Building (Business) - Flat", descriptionRaw: "Building (Business) - Flat", cells: [{ value: "5000000.00" }] },
        { code: "3302", description: "Building (Business) - House", descriptionRaw: "Building (Business) - House", cells: [{ value: "1" }] },
      ] },
    ],
  };
  const out = census.compareTypedEntries(tour, [
    { key: "a", irisCode: "3151", status: "filled", readback: "240000", rowDescription: "Rent", columnIndex: 0 },
    { key: "b", irisCode: "3303", status: "filled", readback: "600000", rowDescription: "Plant", columnIndex: 0 },
    { key: "c", irisCode: "3302", status: "already_correct", plannedValue: "5000000", rowDescription: "Building (Business) - Flat", columnIndex: 0 },
    { key: "d", irisCode: "9999", status: "filled", readback: "1", columnIndex: 0 },
    { key: "e", irisCode: "3151", status: "overwrite_needs_confirmation" },
    { key: "f", irisCode: "3151", status: "filled", dryRun: true },
  ]);
  assert.deepEqual(out.map((o) => [o.key, o.status]), [["a", "match"], ["b", "mismatch"], ["c", "match"], ["d", "not_seen"]]);
  assert.equal(out[1].afterTabValue, "");
  assert.equal(census.digitsOf("1,000.00"), "1000");
  assert.deepEqual(census.collectTotals({ views: [{ rows: [{ code: "3000", cells: [null, { value: "1,405,000" }] }, { code: "3009", cells: [{ value: "1" }] }] }] }), { 3000: "1,405,000" });
});

// ── Logs: per-figure field log and report sections ────────────────────────
test("logs: every result is classified and gets one field-log line with source, before/after values, attempts and pass", () => {
  const fields = new Map([["k1", { key: "k1", irisCode: "3151", value: "240000", ourCategory: "BUSINESS_RENT", ourDescription: "Shop rent", column: "Total Amount" }]]);
  const results = [
    { key: "k1", irisCode: "3151", status: "filled", rowDescription: "Rent", requestedColumn: "Total Amount", previousValue: "", readback: "240000", afterTabReadback: { status: "match", afterTabValue: "240,000", view: "Business > Admin" }, sectionId: "business_admin" },
    { key: "k2", irisCode: "3303", status: "unverified_target", sectionStatus: "business_inputs_read_only", firstPass: { status: "unverified_target", sectionStatus: "business_section_busy" }, sectionId: "business_balance_sheet" },
    { key: "k3", irisCode: "3009", status: "overwrite_needs_confirmation", existingValue: "5,000", plannedValue: "6000", sectionId: "business_trading" },
    { key: "k4", irisCode: "3088", status: "readback_mismatch", readbackStage: "after_tab_switch", sectionId: "business_trading" },
    { key: "k5", irisCode: "1", status: "row_not_found", sectionStatus: "business_document_mismatch" },
    { key: "k6", irisCode: "2", status: "row_not_found", sectionStatus: "code_not_seen_in_section_tour" },
    { key: "k7", irisCode: "3", status: "row_not_found", sectionStatus: "panel_blocked_by_dialog" },
    { key: "k8", irisCode: "4", status: "row_not_found" },
    { key: "k9", irisCode: "5", status: "filled", dryRun: true },
  ];
  const log = report.buildFieldLog(results, { fieldsByKey: fields, attempts: new Map([["k1", 1], ["k2", 2]]) });
  assert.deepEqual(log.map((f) => [f.outcome, f.category]), [
    ["TYPED", "OK"], ["LOCKED", "PORTAL"], ["CONFLICT", "DATA"], ["DID_NOT_STAY", "DATA"],
    ["NOT_TYPED_SAFETY", "SAFETY"], ["NOT_SUPPORTED_YET", "SCOPE"], ["SECTION_NOT_OPENED", "PORTAL"], ["NOT_FOUND", "STRUCTURE"], ["DRY_RUN", "OK"],
  ]);
  assert.deepEqual(
    { source: log[0].source, appValue: log[0].appValue, typed: log[0].typed, after: log[0].readbackAfterTab.status, attempts: log[0].attempts, pass: log[0].pass },
    { source: "BUSINESS_RENT / Shop rent", appValue: "240000", typed: "240000", after: "match", attempts: 1, pass: 1 },
  );
  assert.deepEqual({ pass: log[1].pass, attempts: log[1].attempts, reason: log[1].reason }, { pass: 2, attempts: 2, reason: "business_inputs_read_only" });
  assert.equal(log[2].irisBefore, "5,000");
  const lines = report.buildJobReport({
    finalStatus: "paused",
    result: { autofill: {
      reviewRequired: true, pendingItems: [{ key: "k2" }], results, fieldLog: log, secondPass: { attempted: 1 },
      waits: [{ sectionId: "business_balance_sheet", pass: 1, phase: "section", ok: false, status: "business_inputs_read_only", waitedMs: 15000, trace: [{ reason: "business_inputs_read_only", atMs: 0 }] }],
      pickers: [{ sectionId: "business_deductions", pass: 1, ok: true, reason: "personal_reason_added_and_structure_verified", diagnostics: { picker: "Add Inadmissible Deductions", optionsBefore: { total: 36, checkedDisabled: ["Add Backs Accounting Depreciation"], checkedEnabled: [] }, changedOptions: [PERSONAL], rowsAdded: [{ code: "3212" }], rowsRemoved: [], steps: [{ action: "inspect", reason: "row_missing", atMs: 3 }] } }],
      census: { start: { label: "start", complete: true, ms: 1200, views: [{ key: "Business > Balance Sheet", ok: true, ms: 300, autoCalculate: true, counts: { rows: 20, editable: 13, prefilled: 2 }, sectionButtons: ["+ Property"] }] }, end: null, file: "C:/logs/latest-census.json" },
      irisTotals: { 3000: "1,405,000" },
    } },
  });
  const text = lines.join("\n");
  for (const heading of ["FIELD TABLE (one line per planned figure)", "SUMMARY BY SECTION", "SECOND PASS: 1 figure(s)", "WAITS (IRIS loading / locked grids)", "PICKERS (IRIS 'Add ...' dialogs)", "TOUR OF EVERY TAB (read only)", "IRIS TOTALS AFTER TYPING"])
    assert.ok(text.includes(heading), heading);
  assert.match(text, /1\. \[business_admin\] 3151 Rent · Total Amount · app 240,000 \(BUSINESS_RENT \/ Shop rent\) · IRIS before: empty · typed: 240,000 · readback: 240,000 · after tab: MATCH \(240,000\) → TYPED \[OK\] · attempts 1, pass 1/);
  assert.match(text, /\[business_balance_sheet\] pass 1 section: NOT ready \(business_inputs_read_only\) after 15000 ms/);
  assert.match(text, /already in IRIS, checked\+disabled: 1/);
  assert.match(text, /grid rows added: 3212; removed: none/);
  assert.match(text, /The agent did NOT stop at problems/);
  assert.match(text, /business_admin: 1\/1 in IRIS/);
});

// ── Logs: local HTML snapshot of the exact screen ─────────────────────────
function snapshotScript() {
  const file = path.join(__dirname, "../electron-connect/main.js");
  const ast = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  for (const node of ast.statements) {
    if (!ts.isVariableStatement(node)) continue;
    for (const decl of node.declarationList.declarations)
      if (decl.name.getText(ast) === "HTML_SNAPSHOT_SCRIPT")
        return new Function(`return ${decl.initializer.getText(ast)};`)();
  }
  throw new Error("HTML_SNAPSHOT_SCRIPT not found in main.js");
}
test("logs: the HTML snapshot copies the values on screen into a clone, drops scripts and never writes password/hidden values", async () => {
  const html = `<!doctype html><html><body><input id="a" value=""><input id="pw" type="password"><input id="h" type="hidden" value="SECRET_HIDDEN"><input id="c" type="checkbox"><textarea id="t"></textarea><select id="s"><option>x</option><option>y</option></select><input id="ro" readonly value="5"><script>window.SECRET_SCRIPT=1</script></body></html>`;
  await withPage(html, async (page) => {
    await page.fill("#a", "240000");
    await page.fill("#pw", "SECRET_PW");
    await page.check("#c");
    await page.fill("#t", "note");
    await page.selectOption("#s", "y");
    const before = await page.evaluate(() => document.documentElement.outerHTML);
    const out = await page.evaluate(snapshotScript());
    assert.match(out, /^<!doctype html>/);
    assert.match(out, /id="a" value="240000"/);
    assert.match(out, /id="c" type="checkbox" checked=""/);
    assert.match(out, /<textarea id="t">note<\/textarea>/);
    assert.match(out, /<option selected="">y<\/option>/);
    assert.match(out, /id="ro" readonly="" value="5"|id="ro" value="5" readonly=""/);
    assert.doesNotMatch(out, /SECRET_PW|SECRET_HIDDEN|SECRET_SCRIPT|<script/);
    assert.equal(await page.evaluate(() => document.documentElement.outerHTML), before, "the live page is unchanged");
  }, "/nitr/workflow");
});

test("build: every Phase 1 module carries the same build tag as main.js", () => {
  const main = fs.readFileSync(path.join(__dirname, "../electron-connect/main.js"), "utf8");
  const tag = /const AGENT_BUILD_TAG = "([^"]+)"/.exec(main)[1];
  // Phase 2 (fix47) ships the same modules under one newer tag.
  assert.equal(tag, "pension-services-multifiling-20261106a");
  for (const mod of ["iris-navigation", "iris-row-filler", "iris-business-row-driver", "iris-tour-census", "iris-wealth-driver", "iris-employer-driver"])
    assert.equal(require(`../electron-connect/${mod}`).BUILD_TAG, tag, mod);
  assert.match(main, /\["iris-tour-census\.js", irisTourCensus\.BUILD_TAG\]/);
});
