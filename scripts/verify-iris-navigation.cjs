const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { chromium } = require("playwright");
const navigation = require("../electron-connect/iris-navigation");

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
after(async () => {
  await browser?.close();
});

// Synthetic fixture based only on the supplied log's menu LABELS. No customer
// identity, financial data, authentication or requests to FBR are used.
const dashboard = (dialog = "") => `<!doctype html><html><head><style>
body{font:16px sans-serif;margin:20px}a,button{display:inline-block;padding:9px;margin:4px;cursor:pointer}
a{background:#eee}th,td{padding:10px}[hidden]{display:none!important}
[role=dialog]{position:fixed;top:15%;left:20%;width:420px;padding:24px;background:#fff;border:2px solid #aaa;z-index:20}
.modal-backdrop{position:fixed;inset:0;background:#0004;z-index:10}
</style></head><body>
<nav><a id="homeLink" href="/dashboard">Home</a><a id="navbarDropdown1" onclick="actions.push('assets')">Assets Declaration</a>
<a id="navbarDropdown1" onclick="actions.push('declaration')">Declaration</a><button>person_pinarrow_drop_down</button>
<a>PRIVATE TEST TAXPAYER NAME</a></nav>
<a id="inbox" class="active">Inbox (Correspondence from FBR)</a>
<a id="draft" onclick="actions.push('draft');this.classList.add('active');document.querySelector('#inbox').classList.remove('active');setTimeout(()=>document.querySelector('#it').hidden=false,150)">Draft (Unsubmitted Documents)</a>
<a>Completed Tasks</a><button id="it" hidden onclick="actions.push('it');this.classList.add('active');setTimeout(()=>document.querySelector('#grid').hidden=false,200)">IT DECLARATION (2)</button>
<table id="grid" hidden><thead><tr><th>Task</th><th>Tax Period</th><th>Action</th></tr></thead><tbody>
<tr class="doubleclick" ondblclick="actions.push('OPEN_RETURN')"><td>114(1) (Return of Income filed voluntarily for complete year)</td><td>01-Jul-2025 - 30-Jun-2026</td><td><button class="edit" onclick="actions.push('EDIT_RETURN')">Edit</button></td></tr>
<tr class="doubleclick" ondblclick="actions.push('OPEN_WRONG_YEAR')"><td>114(1) (Return of Income filed voluntarily for complete year)</td><td>01-Jul-2024 - 30-Jun-2025</td><td><button onclick="actions.push('DELETE_RETURN')">Delete</button></td></tr>
</tbody></table>
<input id="search" value="PRIVATE_SEARCH_VALUE"><button onclick="actions.push('SUBMIT')">Submit</button>
<script>window.actions=[];localStorage.setItem('token','PRIVATE_STORAGE_TOKEN');</script>${dialog}</body></html>`;

async function withPage(html, run, { path: pagePath = "/dashboard" } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // No live network: every request, including the initial official-looking
  // fixture URL, is intercepted locally.
  await context.route("**/*", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: html }),
  );
  await page.goto(
    `https://iris.fbr.gov.pk${pagePath}?token=PRIVATE_URL_TOKEN#PRIVATE_HASH`,
  );
  const mainFrame = {
    get url() {
      return page.url();
    },
    executeJavaScript: (source) => page.evaluate(source),
  };
  mainFrame.framesInSubtree = [mainFrame];
  const windowInstance = {
    isDestroyed: () => false,
    webContents: {
      mainFrame,
      getURL: () => page.url(),
      executeJavaScript: mainFrame.executeJavaScript,
    },
  };
  try {
    await run(page, windowInstance);
  } finally {
    await context.close();
  }
}

const welcome = `<div class="modal-backdrop" id="backdrop"></div><section role="dialog" id="promo">
<h2>Submit Your Income Tax Return</h2><p>Tax year 2026 — Last Date</p>
<button aria-label="Close" onclick="actions.push('close_welcome');document.querySelector('#backdrop').remove();document.querySelector('#promo').remove()">×</button></section>`;

test("live inspection closes ONLY identified welcome and waits for Angular draft tabs/grid", async () => {
  await withPage(dashboard(welcome), async (page, windowInstance) => {
    const steps = [];
    const result = await navigation.inspectNavigation(windowInstance, {
      taxYear: 2026,
      onStep: (step) => steps.push(step),
    });
    assert.equal(result.requiredAction, "portal_inspection");
    assert.deepEqual(await page.evaluate("actions"), [
      "close_welcome",
      "draft",
      "it",
    ]);
    const frame = result.inspection.frames[0];
    assert.equal(frame.rows.length, 2);
    assert.deepEqual(frame.rows[0].form.codes, ["114(1)"]);
    assert.equal(frame.rows[0].requestedYearMentioned, true);
    assert.equal(frame.rows[1].requestedYearMentioned, false);
    assert.deepEqual(frame.rows[0].candidatePeriods, [
      "01-Jul-2025",
      "30-Jun-2026",
    ]);
    assert.ok(steps.includes("draft_inventory"));
    assert.equal(
      await page.locator("#search").inputValue(),
      "PRIVATE_SEARCH_VALUE",
    );
    const exported = JSON.stringify(result);
    for (const secret of [
      "PRIVATE TEST",
      "PRIVATE_SEARCH_VALUE",
      "PRIVATE_STORAGE_TOKEN",
      "PRIVATE_URL_TOKEN",
      "PRIVATE_HASH",
    ]) {
      assert.ok(!exported.includes(secret), `Must not export ${secret}`);
    }
  });
});

test("an unknown modal is not hidden, dismissed or bypassed", async () => {
  const unknown = `<div class="modal-backdrop"></div><div role="dialog" id="unknown"><img alt="" width="80" height="40"><button aria-label="Close" onclick="actions.push('unsafe_close')">×</button></div>`;
  await withPage(dashboard(unknown), async (page, win) => {
    const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
    assert.equal(result.requiredAction, "portal_popup");
    assert.deepEqual(await page.evaluate("actions"), []);
    assert.equal(await page.locator("#unknown").isVisible(), true);
  });
});

test("OTP / PIN dialogs are protected even if they also mention a welcome promotion", async () => {
  const verification = `<div class="modal-backdrop"></div><div role="dialog" id="otp"><p>Submit Your Income Tax Return for tax year 2026</p><label>OTP / PIN <input name="otp" value="PRIVATE_OTP_VALUE"></label><button aria-label="Close" onclick="actions.push('unsafe_close')">×</button></div>`;
  await withPage(dashboard(verification), async (page, win) => {
    const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
    assert.equal(result.requiredAction, "portal_popup");
    assert.equal(result.inspection.frames[0].dialogs[0].kind, "protected");
    assert.deepEqual(await page.evaluate("actions"), []);
    assert.ok(!JSON.stringify(result).includes("PRIVATE_OTP_VALUE"));
    assert.equal(await page.locator("#otp").isVisible(), true);
  });
});

test("a final-confirmation dialog cannot masquerade as an auto-dismissible welcome", async () => {
  const final = `<div role="dialog" id="final"><p>Submit Your Income Tax Return for tax year 2026</p><button onclick="actions.push('SUBMIT')">Submit</button><button aria-label="Close" onclick="actions.push('unsafe_close')">×</button></div>`;
  await withPage(dashboard(final), async (page, win) => {
    const result = await navigation.probeFrames(win, {
      action: "close-welcome",
    });
    assert.equal(result.frames[0].actionResult.status, "manual_close_required");
    assert.deepEqual(await page.evaluate("actions"), []);
  });
});

test("reappearing welcome popup retries are bounded and never navigate behind it", async () => {
  const recurring = welcome.replace(
    "document.querySelector('#promo').remove()",
    "document.querySelector('#promo').remove();setTimeout(()=>document.body.insertAdjacentHTML('beforeend',window.recurringMarkup),100)",
  );
  await withPage(dashboard(recurring), async (page, win) => {
    await page.evaluate(() => {
      window.recurringMarkup =
        document.querySelector("#backdrop").outerHTML +
        document.querySelector("#promo").outerHTML;
    });
    const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
    assert.equal(result.requiredAction, "portal_popup");
    assert.deepEqual(
      await page.evaluate("actions"),
      Array(4).fill("close_welcome"),
    );
    assert.equal(
      await page.evaluate("Boolean(window.__taxrocketPopupGuardTimer)"),
      false,
    );
  });
});

test("body/domain/search input do not prove login or return readiness", async () => {
  await withPage(
    `<body><input type="password" name="password" value="PRIVATE_PASSWORD"><button>Login</button></body>`,
    async (page, win) => {
      const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
      assert.equal(result.requiredAction, "session_reconnect");
      assert.equal(navigation.isAuthenticated(result.inspection), false);
      assert.ok(!JSON.stringify(result).includes("PRIVATE_PASSWORD"));
    },
  );
  // A bare search box is NOT a login prompt. Reporting session_reconnect here
  // would tell the user to sign in again when they may already be signed in;
  // the honest answer is that the screen could not be identified.
  await withPage(`<body><input id="search"></body>`, async (_page, win) => {
    const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
    assert.equal(result.requiredAction, "portal_readiness_unverified");
    assert.equal(navigation.isAuthenticated(result.inspection), false);
  });
});

test("duplicate navbar ids are resolved by exact semantic action, never first id match", async () => {
  await withPage(dashboard(), async (page, win) => {
    const result = await navigation.probeFrames(win, {
      action: "declaration-menu",
    });
    assert.equal(result.frames[0].actionResult.status, "clicked");
    assert.deepEqual(await page.evaluate("actions"), ["declaration"]);
    await page.evaluate(() => {
      const extra = document.querySelector("#navbarDropdown1").cloneNode(true);
      extra.textContent = "Declaration";
      document.querySelector("nav").appendChild(extra);
      window.actions = [];
    });
    const ambiguous = await navigation.probeFrames(win, {
      action: "declaration-menu",
    });
    assert.equal(ambiguous.frames[0].actionResult.status, "ambiguous");
    assert.deepEqual(await page.evaluate("actions"), []);
  });
});

test("only approved HTTPS hosts and actual Electron child-frame API are inspected", async () => {
  assert.equal(
    navigation.isAllowedPortalUrl("https://iris.fbr.gov.pk/dashboard"),
    true,
  );
  for (const url of [
    "https://iris.fbr.gov.pk.evil.example",
    "http://iris.fbr.gov.pk",
    "https://evil.example/?iris.fbr.gov.pk",
    "file:///mock.html",
  ]) {
    assert.equal(navigation.isAllowedPortalUrl(url), false);
  }
  const called = [];
  const main = {
    url: "https://iris.fbr.gov.pk/dashboard",
    executeJavaScript: async () => {
      called.push("main");
      return { authenticated: true };
    },
  };
  const child = {
    url: "https://iris.fbr.gov.pk/return",
    executeJavaScript: async () => {
      called.push("child");
      return {};
    },
  };
  const external = {
    url: "https://help.example",
    executeJavaScript: async () => {
      throw new Error("MUST NOT READ");
    },
  };
  main.framesInSubtree = [main, child, external];
  const result = await navigation.probeFrames({
    isDestroyed: () => false,
    webContents: { mainFrame: main },
  });
  assert.deepEqual(called, ["main", "child"]);
  assert.equal(result.frames[2].skipped, "unapproved_origin");
  assert.deepEqual(await navigation.probeFrames(null), {
    frames: [],
    unavailable: "window_closed",
  });
});

test("read-only action whitelist cannot be used to submit or click arbitrary selectors", async () => {
  await withPage(dashboard(), async (page, win) => {
    const result = await navigation.probeFrames(win, {
      action: "submit",
      selector: "button",
    });
    assert.equal(result.frames[0].actionResult.status, "unsupported_action");
    assert.deepEqual(await page.evaluate("actions"), []);
  });
});

const mainSource = fs.readFileSync(
  path.join(__dirname, "../electron-connect/main.js"),
  "utf8",
);
const ast = ts.createSourceFile(
  "main.js",
  mainSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
function functionSource(name) {
  const found = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(found, `Function ${name} exists`);
  return found.getText(ast);
}
function sandbox(names, extras = {}) {
  // The exact Services-only / Salary+Services / Pension+Services gate is shared by navigation and
  // real autofill entry point; extracted-function sandboxes need the shipped
  // helper itself, never a test-local copy of the route policy.
  if (
    (names.includes("runLocalIrisNavigationCheck") ||
      names.includes("runRealIrisAutofill")) &&
    !names.includes("getServicesPacketRoute")
  ) {
    names = [...names, "getServicesPacketRoute", "getServicesAutofillFields", "getSalaryFieldsForServicesRoute"];
  }
  // Both real-portal flows now read the effective autofill mode through one
  // resolver, so any test that exercises `getRealAutofillMode` must be given the
  // resolver too — otherwise the sandbox throws on a symbol the shipped code
  // defines at module scope.
  const autofillFlows = ["runLocalTaxAssistedFilingFlow", "runLocalTaxDryRunFlow"];
  if (
    autofillFlows.some((flow) => names.includes(flow)) &&
    !names.includes("resolveAutofillMode")
  ) {
    names = [...names, "resolveAutofillMode"];
  }
  // The flows merge autofill output into the navigation result through this
  // module-scope helper; the sandbox must be given it too.
  if (
    autofillFlows.some((flow) => names.includes(flow)) &&
    !names.includes("mergeNavigationAutofillOutcome")
  ) {
    names = [
      ...names,
      "mergeNavigationAutofillOutcome",
      "markAutofillOff",
      "buildHandoffScopeSummary",
      "hasConfirmedHandoffReview",
      "getHandoffReviewAction",
      "readSavedJobLog",
      "buildConfirmedHandoffCompletion",
      "getAutofillReviewAction",
      "hasConfirmedAutofillReview",
      "collectAcknowledgedAutofillItems",
      "autofillItemKey",
    ];
  }
  // runRealIrisAutofill decides whether the taxpayer review pause is due through
  // these module-scope helpers, so every sandbox that runs it needs them too.
  if (
    names.includes("runRealIrisAutofill") &&
    !names.includes("hasConfirmedHandoffReview")
  ) {
    names = [
      ...names,
      "getHandoffReviewAction",
      "hasConfirmedHandoffReview",
      "getEmployerReviewAction",
      "hasConfirmedEmployerReview",
      "runHandoffReviewTour",
      "buildHandoffReviewMessage",
      "autofillItemKey",
      "checkTakenOverEntry",
    ];
  }
  // The autofill and local-navigation functions read these module-scope
  // dependencies from main.js; extracted-function sandboxes must provide them.
  const needsAutofillGlobals =
    names.includes("runRealIrisAutofill") ||
    names.includes("runLocalIrisNavigationCheck");
  if (needsAutofillGlobals) {
    if (!("pensionEntryHold" in extras)) {
      extras = {
        ...extras,
        pensionEntryHold: require("../electron-connect/pension-guard").pensionEntryHold,
      };
    }
    if (!("TAX_DEDUCTION_GRID_BY_CODE" in extras)) {
      extras = {
        ...extras,
        TAX_DEDUCTION_GRID_BY_CODE: Object.freeze({
          "64020004": "Adjustable Tax",
          "64020007": "Final Tax",
        }),
      };
    }
  }
  // ...and the employer step: the shipped driver is pure for an empty employer
  // list, so it is given as is; the opt-in switch needs a `process` to read.
  const runsAutofill = names.includes("runRealIrisAutofill");
  if (runsAutofill && extras.irisRowFiller && typeof extras.irisRowFiller.packetPromisedIrisCodes !== "function") {
    // Older/handwritten filler stubs do not know about this optional packet
    // coverage helper. Keep those tests focused on their declared behavior.
    extras = {
      ...extras,
      irisRowFiller: { ...extras.irisRowFiller, packetPromisedIrisCodes: () => [] },
    };
  }
  if (
    runsAutofill &&
    !names.includes("getEmployerAutofillEnabled") &&
    !("getEmployerAutofillEnabled" in extras)
  ) {
    names = [...names, "getEmployerAutofillEnabled"];
  }
  const ctx = vm.createContext({
    AGENT_NAME: require("../electron-connect/branding.js").AGENT_NAME,
    brandWindow: require("../electron-connect/branding.js").brandWindow,
    console,
    Promise,
    Date,
    setTimeout,
    clearTimeout,
    ...(runsAutofill
      ? {
          irisEmployerDriver: require("../electron-connect/iris-employer-driver.js"),
          wealthReconciliation: require("../electron-connect/wealth-reconciliation-check.js"),
          // The Cash in hand baseline lives in the agent log folder; a test
          // run gets a throw-away one and may override any of these.
          cashBaselineStore: require("../electron-connect/cash-baseline-store.js"),
          getAgentLogDir: () =>
            require("node:fs").mkdtempSync(
              require("node:path").join(require("node:os").tmpdir(), "agent-logs-"),
            ),
          fs: require("node:fs"),
          path: require("node:path"),
          process: { env: {} },
        }
      : {}),
    ...extras,
  });
  for (const name of names) {
    // An explicit stand-in in `extras` is never replaced by the shipped function.
    if (name in extras) continue;
    vm.runInContext(functionSource(name), ctx);
  }
  return ctx;
}

test("main worker is single-flight even while the claim request is still pending", async () => {
  let release;
  let calls = 0;
  const ctx = sandbox(["runLocalWorkerCycle"], {
    localWorkerRunning: false,
    workerIdleAnnounced: false,
    launchState: { deviceAuthToken: "test-token" },
    getApiBaseUrl: () => "https://test.invalid",
    loadAgentState: () => ({}),
    pushStatus: () => {},
    claimNextLocalJob: () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const first = ctx.runLocalWorkerCycle();
  await ctx.runLocalWorkerCycle();
  assert.equal(calls, 1);
  assert.equal(ctx.localWorkerRunning, true);
  release(null);
  await first;
  assert.equal(ctx.localWorkerRunning, false);
});

test("main retains SAME live BrowserWindow on start/reconnect without loadURL", async () => {
  const calls = [];
  const win = {
    isDestroyed: () => false,
    taxRocketPartition: "persist:test",
    webContents: { getURL: () => "https://iris.fbr.gov.pk/dashboard" },
    loadURL: async () => calls.push("load"),
    show: () => {},
    focus: () => {},
    setTitle: () => {},
    close: () => calls.push("close"),
  };
  const ctx = sandbox(["createLoginWindow", "ensureWorkerWindow"], {
    loginWindowPromise: null,
    loginWindow: win,
    workerWindow: null,
    realPortalMode: true,
    AGENT_BUILD_TAG: "test",
    irisNavigation: navigation,
    launchState: {
      flow: "fbr",
      token: "test",
      apiBaseUrl: "https://test.invalid",
      deviceAuthToken: "registered",
      desktopAuthConfig: { useMockIris: false },
    },
    getWorkerPartition: () => "persist:test",
    resolveDesktopLoginUrl: () => "https://iris.fbr.gov.pk/",
    scheduleAutoCapture: () => {},
    startLocalWorkerLoop: () => {},
  });
  assert.equal(await ctx.createLoginWindow(true), win);
  assert.equal(await ctx.ensureWorkerWindow(), win);
  assert.deepEqual(calls, []);
});

test("real assisted AND dry-run dispatch to inspection before any legacy fill/submit code", async () => {
  // Phase 1 put real-portal autofill behind TAXROCKET_REAL_AUTOFILL. With the
  // flag off (the default) both flows must still behave exactly as before:
  // inspection only, and the legacy mock filler never reached.
  let called = 0;
  const ctx = sandbox(
    [
      "runLocalTaxAssistedFilingFlow",
      "runLocalTaxDryRunFlow",
      "finishNavigationOnly",
    ],
    {
      realPortalMode: true,
      getRealAutofillMode: () => "off",
      updateLocalJobStatus: async () => {},
      runLocalIrisNavigationCheck: async () => {
        called++;
        return { paused: true };
      },
      runRealIrisAutofill: () => {
        throw new Error("Autofill must not run while the flag is off");
      },
      ensureWorkerWindow: () => {
        throw new Error("Legacy filler must not run");
      },
    },
  );
  assert.equal((await ctx.runLocalTaxAssistedFilingFlow({}, {})).paused, true);
  assert.equal((await ctx.runLocalTaxDryRunFlow({ job: {} })).paused, true);
  assert.equal(called, 2);
});

test("a paused navigation checkpoint is never overridden by autofill", async () => {
  // Even with autofill enabled, a pause (OTP, PIN, unknown modal, wrong route)
  // must be returned untouched — filling a form the user has not been driven to
  // is how values land in the wrong return.
  let autofillCalls = 0;
  const ctx = sandbox(
    [
      "runLocalTaxAssistedFilingFlow",
      "runLocalTaxDryRunFlow",
      "finishNavigationOnly",
    ],
    {
      realPortalMode: true,
      getRealAutofillMode: () => "live",
      updateLocalJobStatus: async () => {},
      runLocalIrisNavigationCheck: async () => ({
        paused: true,
        pauseAction: "portal_popup",
      }),
      runRealIrisAutofill: async () => {
        autofillCalls++;
        return { executionLog: [], result: {} };
      },
      ensureWorkerWindow: () => {
        throw new Error("Legacy filler must not run");
      },
    },
  );
  assert.equal(
    (await ctx.runLocalTaxAssistedFilingFlow({}, {})).pauseAction,
    "portal_popup",
  );
  assert.equal(
    (await ctx.runLocalTaxDryRunFlow({ job: {} })).pauseAction,
    "portal_popup",
  );
  assert.equal(autofillCalls, 0, "autofill must not run behind a pause");
});

test("autofill runs only after an un-paused navigation check, and merges its log", async () => {
  let autofillCalls = 0;
  const ctx = sandbox(
    [
      "runLocalTaxAssistedFilingFlow",
      "runLocalTaxDryRunFlow",
      "finishNavigationOnly",
    ],
    {
      realPortalMode: true,
      getRealAutofillMode: () => "dry",
      updateLocalJobStatus: async () => {},
      runLocalIrisNavigationCheck: async () => ({
        paused: false,
        executionLog: [{ step: "nav" }],
        result: { navigated: true },
      }),
      runRealIrisAutofill: async (_ctx, _job, mode) => {
        autofillCalls++;
        return {
          executionLog: [{ step: "real_autofill_result" }],
          result: { mode, summary: { filled: 3 } },
        };
      },
      ensureWorkerWindow: () => {
        throw new Error("Legacy filler must not run");
      },
    },
  );

  const assisted = await ctx.runLocalTaxAssistedFilingFlow({}, {});
  assert.equal(assisted.paused, false);
  assert.equal(assisted.result.autofill.mode, "dry");
  assert.equal(
    assisted.result.navigated,
    true,
    "navigation result must be preserved",
  );
  // Arrays come back from the vm realm, so deepEqual's realm check would fail
  // on structurally identical values. Compare the joined steps instead.
  assert.equal(
    assisted.executionLog.map((e) => e.step).join(","),
    "nav,real_autofill_result",
  );

  const dryRun = await ctx.runLocalTaxDryRunFlow({ job: {} });
  assert.equal(dryRun.result.autofill.summary.filled, 3);
  assert.equal(autofillCalls, 2);
});

test("CSS timeout does not starve a valid text navigation fallback", async () => {
  await withPage(dashboard(), async (page, win) => {
    const ctx = sandbox([
      "splitSelectorAlternatives",
      "findAndClickByText",
      "clickSelectorWithTextSupport",
    ]);
    await ctx.clickSelectorWithTextSupport(
      win,
      "#absent-selector, text:Declaration",
      500,
    );
    assert.deepEqual(await page.evaluate("actions"), ["declaration"]);
  });
});

test("legacy menu helper clicks the successfully resolved selector", async () => {
  for (const [fn, key] of [
    ["navigateIrisTopMenu", "topMenuSelector"],
    ["navigateIrisLeftCategory", "leftCategorySelector"],
  ]) {
    const clicks = [];
    const ctx = sandbox([fn], {
      setTimeout: (callback) => {
        callback();
      },
      buildActionSelectorChain: () => ["#menu"],
      trySelectorsInPriority: async () => ({ selector: "#menu" }),
      clickSelector: async (_win, selector) => clicks.push(selector),
    });
    await ctx[fn]({}, { [key]: "#menu" });
    assert.deepEqual(clicks, ["#menu"]);
  }
});

test("context failures are reported and logged instead of leaving a job silently queued", async () => {
  const calls = [];
  const ctx = sandbox(["processLocalJob"], {
    buildPortalEvidenceDiagnostics: navigation.buildPortalEvidenceDiagnostics,
    loadLocalJobContext: async () => {
      throw new Error("Queued approved packet unavailable");
    },
    saveFailureDump: async () => null,
    captureDomEvidence: async () => ({ frames: [] }),
    workerWindow: null,
    lastSectionTour: null,
    activeJobExecutionLog: null,
    STANDARD_LOG_STEPS: { FAILURE: "failure" },
    classifyRecoverableAssistedIssue: () => null,
    // The REAL evidence builder, not a stub: a job that fails must still record
    // what the capture proved (here: nothing) instead of inventing drift.
    buildSelectorDriftDiagnostics: () => null,
    getSelectorBundleSignal: () => null,
    buildRecoveryActions: () => [],
    updateLocalJobStatus: async (_id, status) => calls.push(status),
    writeJobLogToDisk: async () => {
      calls.push("log");
      return null;
    },
    cleanupJobDocuments: async () => calls.push("cleanup"),
    pushStatus: () => {},
  });
  await ctx.processLocalJob({
    id: "job-test",
    type: "tax_assisted_filing",
    status: "created",
  });
  assert.deepEqual(calls, ["failed", "log", "cleanup"]);
});

// ─── Phase 1.5a: setup-dialog deadlock ──────────────────────────────────────
// The agent opens the "Normal Return (Ind/AOP/COY)" dialog itself, then its own
// sensitiveControl heuristic classified it as protected, so every retry paused
// on portal_popup and close-welcome (a no-op here) looped forever.

const setupDialog = (
  extra = "",
) => `<div class="modal-backdrop" id="backdrop" style="pointer-events:none"></div>
<section role="dialog" class="mat-mdc-dialog-container" id="setup">
<h3 role="heading">Normal Return (Ind/AOP/COY)</h3>
<label>Period</label>
<input type="radio" name="period" id="p1"><label for="p1">01-Jul-2025 - 30-Jun-2026</label>
${extra}
<button onclick="actions.push('setup_continue')">Continue</button>
</section>`;

async function dialogKinds(html) {
  let kinds;
  await withPage(dashboard(html), async (_page, win) => {
    const probe = await navigation.probeFrames(win, {
      action: "inspect",
      taxYear: 2026,
    });
    kinds = probe.frames[0];
  });
  return kinds;
}

test("Phase 1.5a: a recognised setup dialog is tagged 'setup' and does not block navigation", async () => {
  const frame = await dialogKinds(setupDialog());
  assert.equal(frame.dialogs.length, 1);
  assert.equal(frame.dialogs[0].kind, "setup");
  assert.equal(frame.setupDialogOnly, true);
  assert.equal(frame.hasBlockingOverlay, false);
});

test("Phase 1.5a: a setup dialog carrying an OTP field stays protected and blocking", async () => {
  const frame = await dialogKinds(
    setupDialog('<label>OTP</label><input type="text" name="otp">'),
  );
  assert.equal(frame.dialogs[0].kind, "protected");
  assert.equal(frame.setupDialogOnly, false);
  assert.equal(frame.hasBlockingOverlay, true);
});

test("Phase 1.5a: a setup dialog carrying a commit control stays blocking", async () => {
  const frame = await dialogKinds(setupDialog("<button>Submit</button>"));
  assert.notEqual(frame.dialogs[0].kind, "setup");
  assert.equal(frame.hasBlockingOverlay, true);
});

test("Phase 1.5a: an unrecognised dialog still blocks exactly as before", async () => {
  const frame = await dialogKinds(
    `<section role="dialog" id="mystery"><h3>Something unfamiliar</h3><button>Ok</button></section>`,
  );
  assert.equal(frame.dialogs[0].kind, "unknown");
  assert.equal(frame.setupDialogOnly, false);
  assert.equal(frame.hasBlockingOverlay, true);
});

test("Phase 1.5a: a live backdrop blocks even when the only dialog is setup", async () => {
  const frame = await dialogKinds(
    `<div class="modal-backdrop" id="live"></div>` + setupDialog(),
  );
  assert.equal(frame.dialogs[0].kind, "setup");
  assert.equal(frame.hasBlockingOverlay, true);
});

test("Phase 1.5a: the setup dialog reaches the stage machine instead of looping on close-welcome", async () => {
  await withPage(dashboard(setupDialog()), async (page, win) => {
    const steps = [];
    const result = await navigation.inspectNavigation(win, {
      taxYear: 2026,
      openReturn: true,
      taxpayerIdentifier: "1234567890123",
      state: { newEntryOpened: true },
      onStep: (step) => steps.push(String(step)),
    });
    // The deadlock signature was: portal_popup plus four no-op close_welcome clicks.
    assert.notEqual(result.requiredAction, "portal_popup");
    assert.equal(
      (await page.evaluate("actions")).filter((a) => a === "close_welcome")
        .length,
      0,
    );
    assert.ok(
      steps.some((s) => s.startsWith("new_return_setup")),
      `stage machine was reached, got: ${steps.join(", ")}`,
    );
  });
});

// ─── Phase 1.5b: economic-transactions gate ─────────────────────────────────
// Reached from the blue dashboard tile at /nitr/summary-economic-transactions.
// Read-only to the agent: residency (ITO s.82-84) and the income-source ticks
// are the taxpayer's own declarations.

const gate = ({ checked = false, residency = false, enabled = false } = {}) =>
  `<!doctype html><html><body><app-summary-economic-transactions>
<app-source-checkbox><mat-checkbox><input type="checkbox" ${checked ? "checked" : ""}></mat-checkbox>Income from Salary</app-source-checkbox>
<app-source-checkbox><mat-checkbox><input type="checkbox"></mat-checkbox>Income from Business</app-source-checkbox>
<mat-radio-group aria-label="Select Residential Status">
<mat-radio-button value="yes"><input type="radio" name="res" value="yes" ${residency ? "checked" : ""}></mat-radio-button>Yes
<mat-radio-button value="no"><input type="radio" name="res" value="no"></mat-radio-button>No
</mat-radio-group>
<div class="btn-start-wrapper">
<button class="btn btn-start" ${enabled ? "" : "disabled"}>Start Return Filling</button>
<button type="button" aria-label="Start Return Filling" class="btn-start-overlay"></button>
</div></app-summary-economic-transactions>
<script>window.actions=[]</script></body></html>`;

// ─── P3: what actually proves "the return is open" ───────────────────────────
// Structure taken from `IRIS 2.0 form3.html`: app-nitr-workflow > container-fluid
// > ... > app-wf-header, with Year / 114(1) / Registration No: inside the header.

const returnWorkspace = () =>
  `<!doctype html><html><body><app-nitr-workflow class="ng-star-inserted"><div class="container-fluid">
<div class="row"><div class="col-sm-12"><app-wf-header><div class="row">
<div class="col-9"><div class="col-12"><h6 class="font-purple margin-0">Year 2026</h6>
<p class="margin-0 font-13"><span> 114(1) (Return of Income filed voluntarily for complete year) </span></p></div></div>
<div class="col-6"><p class="margin-0"><b>Full Name:</b> PRIVATE TEST TAXPAYER NAME</p>
<p class="margin-0"><b>Registration No:</b> 4220144218163</p></div>
</div></app-wf-header></div></div>
<div class="tableRows dataRow" id="1009"><div class="data-middle-child-wapper"><input type="text" value="0"></div></div>
</div></app-nitr-workflow><script>window.actions=[]</script></body></html>`;

test("slow FBR: a return whose title and year render late is waited for, not reported as unverified", async () => {
  const late = returnWorkspace()
    .replace(
      /<app-wf-header>[\s\S]*<\/app-wf-header>/,
      '<app-wf-header id="hdr"></app-wf-header>',
    )
    .replace(
      "<script>window.actions=[]</script>",
      `<script>window.actions=[];setTimeout(function(){document.getElementById("hdr").innerHTML='<div class="row"><div class="col-9"><div class="col-12"><h6>Year 2026</h6><p><span> 114(1) (Return of Income filed voluntarily for complete year) </span></p></div></div><div class="col-6"><p><b>Registration No:</b> 1234567890123</p></div></div>';},6000);</script>`,
    );
  await withPage(late, async (_page, win) => {
    const result = await navigation.inspectNavigation(win, {
      taxYear: 2026,
      taxpayerIdentifier: "1234567890123",
    });
    assert.notEqual(result.requiredAction, "portal_readiness_unverified");
    assert.equal(result.inspection.frames[0].document.taxYear, 2026);
  });
});

// Synthetic TY2026 return structure for the narrowly scoped 64020004
// navigation test. It uses no FBR request, account, or real taxpayer data.
const taxDeductionsReturn = ({ shieldMs = 450 } = {}) =>
  `<!doctype html><html><head><style>
*{box-sizing:border-box}body{font:14px sans-serif;margin:12px}
app-nitr-workflow,app-nitr-wf-body,.body.interface_21{display:block}
app-wf-header{display:block;border-bottom:1px solid #bbb;margin-bottom:12px}
mat-expansion-panel{display:block;border:1px solid #aaa;margin:4px 0}
mat-expansion-panel-header{display:block;padding:10px;background:#eee;cursor:pointer}
.mat-expansion-panel-content{display:block;padding:8px}
button.data-tab-left-btn{padding:8px;margin:3px}.active{font-weight:bold}
.heading-bar>div{display:grid;grid-template-columns:2fr .6fr 1fr 1fr;gap:8px}
.tableRows.dataRow{display:block;padding:8px}.columns-parent{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.data-middle-child-wapper input{width:100%}[hidden]{display:none!important}
#nitr-calculate-click-shield{position:fixed;z-index:9999;background:rgba(0,0,0,.01);display:none;pointer-events:auto}
</style></head><body><app-nitr-workflow><div class="container-fluid">
<app-wf-header><h6>Year 2026</h6>
<p><span>114(1) (Return of Income filed voluntarily for complete year)</span></p>
<p>Registration No: 1234567890123</p></app-wf-header>
<app-nitr-wf-body><div class="custom-tabs"><div class="sticky-tabs-head"><div class="head"><button class="title active">Data</button></div></div></div>
<div class="body interface_21 active"><mat-expansion-panel id="employment-panel">
<mat-expansion-panel-header class="mat-expanded" aria-expanded="true">Employment</mat-expansion-panel-header>
<div class="mat-expansion-panel-content"><div class="mat-expansion-panel-body">
<button id="salary-tab" class="data-tab-left-btn active" onclick="setSection('salary')">Salary</button>
<button id="deductions-tab" class="data-tab-left-btn" onclick="setSection('tax_deductions')">Tax Deductions</button>
<div id="salary-pane"><div class="dataRow" id="1009"></div></div>
<div id="deductions-pane" hidden><div class="wf-section-modal-accordion">
<mat-expansion-panel id="adjustable-panel"><mat-expansion-panel-header id="adjustable-header" aria-expanded="false">Adjustable Tax</mat-expansion-panel-header>
<div class="mat-expansion-panel-content"><div class="mat-expansion-panel-body">
<div class="heading-bar"><div><strong>Description</strong><strong>Code</strong><strong>Taxable Amount</strong><strong>Tax Deducted</strong></div></div>
<div class="tableRows dataRow" id="64020004"><div class="row-description-text">Salary of Employees u/s 149</div>
<div class="columns-parent"><div class="data-middle-child-wapper"><input type="text" value=""></div>
<div class="data-middle-child-wapper"><input type="text" value=""></div></div></div>
</div></div></mat-expansion-panel>
<mat-expansion-panel id="final-panel"><mat-expansion-panel-header aria-expanded="false">Final Tax</mat-expansion-panel-header><div class="mat-expansion-panel-content"></div></mat-expansion-panel>
<mat-expansion-panel id="average-panel"><mat-expansion-panel-header aria-expanded="false">Average Tax</mat-expansion-panel-header><div class="mat-expansion-panel-content"></div></mat-expansion-panel>
</div></div>
</div></div></mat-expansion-panel></div></app-nitr-wf-body>
</div></app-nitr-workflow><div id="nitr-calculate-click-shield"></div>
<script>
window.actions=[];
const shield=document.getElementById('nitr-calculate-click-shield');
function setSection(id){
 document.getElementById('salary-tab').classList.toggle('active',id==='salary');
 document.getElementById('deductions-tab').classList.toggle('active',id==='tax_deductions');
 document.getElementById('salary-pane').hidden=id!=='salary';
 document.getElementById('deductions-pane').hidden=id!=='tax_deductions';
 window.actions.push('tab:'+id);
 if(id==='tax_deductions'){
  const r=document.getElementById('adjustable-header').getBoundingClientRect();
  Object.assign(shield.style,{display:'block',left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});
  setTimeout(()=>{shield.style.display='none'},${Math.max(0, Number(shieldMs) || 0)});
 }
}
document.getElementById('adjustable-header').addEventListener('click',()=>{
 const h=document.getElementById('adjustable-header');h.classList.add('mat-expanded');h.setAttribute('aria-expanded','true');window.actions.push('grid:Adjustable Tax');
});
</script></body></html>`;

test("P3: the return-workspace probe separates the gate from an open return", async () => {
  await withPage(returnWorkspace(), async (page, windowInstance) => {
    const out = await windowInstance.webContents.executeJavaScript(
      navigation.RETURN_WORKSPACE_PROBE,
    );
    assert.equal(out.returnWorkspace, true, JSON.stringify(out));
    assert.deepEqual(out.evidence, {
      year: true,
      returnDocument: true,
      registration: true,
    });
    assert.ok(out.inputs >= 1, "the entered cell is counted for context");
  });

  await withPage(gate(), async (page, windowInstance) => {
    const out = await windowInstance.webContents.executeJavaScript(
      navigation.RETURN_WORKSPACE_PROBE,
    );
    // This is the exact false positive the count-visible-inputs readiness had:
    // the gate is full of inputs but is NOT a return that can be filled.
    assert.equal(out.inputs > 0, true, "the gate does expose visible inputs");
    assert.equal(out.returnWorkspace, false, JSON.stringify(out));
    assert.equal(out.reason, "app-nitr-workflow-absent");
  });

  await withPage(dashboard(), async (page, windowInstance) => {
    const out = await windowInstance.webContents.executeJavaScript(
      navigation.RETURN_WORKSPACE_PROBE,
    );
    assert.equal(out.returnWorkspace, false, "the dashboard is not a return either");
    assert.equal(out.reason, "app-nitr-workflow-absent");
  });
});

test("TY2026 withholding revisit waits out a transient shield and opens only Adjustable Tax", async () => {
  await withPage(taxDeductionsReturn({ shieldMs: 450 }), async (page, win) => {
    const result = await navigation.navigateToSection(win, {
      sectionId: "tax_deductions",
      taxYear: 2026,
      taxpayerIdentifier: "1234567890123",
      requiredGridTitle: "Adjustable Tax",
      requiredRowCodes: ["64020004"],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "grid_ready");
    assert.equal(result.gridTitle, "Adjustable Tax");
    assert.deepEqual(await page.evaluate("actions"), [
      "tab:tax_deductions",
      "grid:Adjustable Tax",
    ]);
    const section = result.inspection.frames[0].section;
    assert.equal(section.id, "tax_deductions");
    assert.equal(
      section.structurePresent,
      false,
      "unrelated collapsed grids must not block the verified target row",
    );
    assert.equal(
      section.fieldGridPanels.find((panel) => panel.title === "Adjustable Tax")
        .expanded,
      true,
    );
    assert.equal(
      section.rows.find((row) => row.code === "64020004").gridTitle,
      "Adjustable Tax",
    );
    assert.equal(section.rows.find((row) => row.code === "64020004").cells[1].column, "Tax Deducted");
  });
});

test("a persistent shield is not bypassed when reopening the withholding grid", async () => {
  await withPage(taxDeductionsReturn({ shieldMs: 5000 }), async (page, win) => {
    const result = await navigation.navigateToSection(win, {
      sectionId: "tax_deductions",
      taxYear: 2026,
      taxpayerIdentifier: "1234567890123",
      requiredGridTitle: "Adjustable Tax",
      requiredRowCodes: ["64020004"],
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "grid_not_interactable");
    assert.deepEqual(await page.evaluate("actions"), ["tab:tax_deductions"]);
    assert.equal(
      result.inspection.frames[0].section.fieldGridPanels.find(
        (panel) => panel.title === "Adjustable Tax",
      ).expanded,
      false,
      "a blocked header must remain untouched rather than force-clicked",
    );
  });
});

test("Phase 1.5b: the unanswered gate is recognised, authenticated, and lists what is missing", async () => {
  await withPage(gate(), async (page, win) => {
    const steps = [];
    const result = await navigation.inspectNavigation(win, {
      taxYear: 2026,
      openReturn: true,
      taxpayerIdentifier: "1234567890123",
      onStep: (step) => steps.push(step),
    });
    assert.equal(result.requiredAction, "portal_economic_transactions_gate");
    assert.equal(result.economicTransactionsGate.ready, false);
    assert.deepEqual(result.economicTransactionsGate.missing, [
      "income sources",
      "tax residency",
    ]);
    assert.equal(navigation.isAuthenticated(result.inspection), true);
    assert.equal(
      result.inspection.frames[0].readiness.evidence,
      "economic_transactions_gate",
    );
    // The agent must never answer the gate on the taxpayer's behalf.
    assert.deepEqual(await page.evaluate("actions"), []);
    assert.equal(
      await page.evaluate("document.querySelectorAll('input:checked').length"),
      0,
    );
  });
});

test("Phase 1.5b: a partially answered gate reports only the outstanding half", async () => {
  await withPage(gate({ checked: true }), async (_page, win) => {
    const result = await navigation.inspectNavigation(win, {
      taxYear: 2026,
      openReturn: true,
      taxpayerIdentifier: "1234567890123",
    });
    assert.deepEqual(result.economicTransactionsGate.missing, [
      "tax residency",
    ]);
    assert.deepEqual(result.economicTransactionsGate.selectedSources, [
      "Income from Salary",
    ]);
  });
});

test("Phase 1.5b: an answered gate reports ready and still refuses to click Start", async () => {
  await withPage(
    gate({ checked: true, residency: true, enabled: true }),
    async (page, win) => {
      const result = await navigation.inspectNavigation(win, {
        taxYear: 2026,
        openReturn: true,
        taxpayerIdentifier: "1234567890123",
      });
      assert.equal(result.requiredAction, "portal_economic_transactions_gate");
      assert.equal(result.economicTransactionsGate.ready, true);
      assert.equal(result.economicTransactionsGate.residencySelected, true);
      assert.deepEqual(await page.evaluate("actions"), []);
    },
  );
});

test("Phase 1.5b: the gate snapshot never carries the opaque session token", async () => {
  await withPage(gate(), async (_page, win) => {
    const result = await navigation.inspectNavigation(win, {
      taxYear: 2026,
      openReturn: true,
      taxpayerIdentifier: "1234567890123",
    });
    assert.ok(!JSON.stringify(result).includes("PRIVATE_URL_TOKEN"));
    assert.ok(!JSON.stringify(result).includes("PRIVATE_HASH"));
  });
});

test("Phase 1.5: the in-page stage classifier mirror cannot drift from the module original", async () => {
  // portalProbe is serialized into the renderer, so it carries its own copy of
  // classifyNewReturnSetupStage. Both must agree on every stage.
  const cases = [
    { nodeLabels: ["Normal Return (Ind/AOP/COY)"], expected: "menu" },
    {
      prompts: ["Normal Return", "Simplified Return"],
      expected: "return_type",
    },
    { prompts: ["Resident"], expected: "residency" },
    { actions: ["Accept and Continue"], expected: "accept_continue" },
    { prompts: ["Period"], actions: ["Continue"], expected: "period" },
    // The live 2026-09-10 dialog. Its caption is "Tax Period", which is what the
    // agent used to miss, so it stopped at a dialog with nothing left to type.
    {
      prompts: ["Person", "Tax Period", "Normal Return (Ind/AOP/COY)"],
      actions: ["Cancel", "Continue"],
      expected: "period",
    },
    { prompts: ["Something else"], expected: null },
    {
      documentPresent: true,
      nodeLabels: ["Normal Return (Ind/AOP/COY)"],
      expected: null,
    },
  ];
  const source = navigation.portalProbe.toString();
  const mirror = source.slice(
    source.indexOf("const classifySetupStage"),
    source.indexOf("const isSafeAutoAdvanceStage"),
  );
  const classify = new Function(
    "input",
    `const setupLabel=(v)=>String(v||"").replace(/\\s+/g," ").trim().toLowerCase();${mirror}return classifySetupStage(input);`,
  );
  for (const { expected, ...input } of cases) {
    const descriptor = {
      documentPresent: false,
      prompts: [],
      actions: [],
      nodeLabels: [],
      ...input,
    };
    assert.equal(navigation.classifyNewReturnSetupStage(descriptor), expected);
    assert.equal(
      classify(descriptor),
      expected,
      `mirror disagrees for ${JSON.stringify(input)}`,
    );
  }
});

// ─── Phase 1.6: complete the tour, then let autofill run ────────────────────
// Dry-run 2026-09-09 reached Computations then paused on "Personal Assets /
// Liabilities: section panel not_found". The 116 Wealth Statement is a separate
// document, not a panel in the 114(1) workflow, so the tour could never finish
// and autofill was unreachable.

test("Phase 1.6: the section plan excludes the 116 Wealth Statement views", () => {
  assert.deepEqual(navigation.WEALTH_SECTION_IDS, [
    "wealth_assets",
    "wealth_reconciliation",
  ]);
  for (const id of navigation.WEALTH_SECTION_IDS)
    assert.ok(
      !navigation.INCOME_SECTION_IDS.includes(id),
      `${id} must not block the income tour`,
    );
  // Every section the live dry-run actually captured is still planned.
  for (const id of [
    "salary",
    "tax_deductions",
    "allowance_credits",
    "withholding",
    "computations",
  ])
    assert.ok(
      navigation.INCOME_SECTION_IDS.includes(id),
      `${id} must stay in the tour`,
    );
  // The plan must remain a valid subset in the original order, salary first.
  assert.equal(navigation.INCOME_SECTION_IDS[0], "salary");
  assert.deepEqual(
    navigation.INCOME_SECTION_IDS,
    navigation.ALL_SECTION_IDS.filter(
      (id) => !navigation.WEALTH_SECTION_IDS.includes(id),
    ),
  );
});

test("fix43: the agent keeps Salary default and adds only packet-backed verified business views", () => {
  const source = functionSource("runLocalIrisNavigationCheck");
  assert.ok(
    source.includes("sectionIds: handoffSectionIds") &&
      source.includes("salaryRequested ? irisNavigation.SALARY_WITHHOLDING_SECTION_IDS : []") &&
      source.includes('!["business-entry-v1", "business-entry-v2"].includes(snapshot.business?.version)'),
    "navigation must use the salary default or an explicitly versioned business payload",
  );
  assert.ok(
    !source.includes("sectionIds: irisNavigation.ALL_SECTION_IDS"),
    "the wealth-blocked plan must no longer be requested",
  );
});

test("fix55: packet v8 is accepted by the global and every business feature gate", () => {
  const versionLines = mainSource.split("\n").filter((line) => line.includes("business-entry-v7"));
  assert.ok(versionLines.length >= 5, "the global gate and feature gates are found");
  assert.ok(versionLines.every((line) => line.includes("business-entry-v8")), "no v7 gate may skip a v8 property packet");
  assert.ok(mainSource.includes("land/building property item(s)"));
});

test("Phase 1.6: a completed section tour is not reported as paused", async () => {
  // portal_sections_inspected is success. While it was returned as paused, both
  // filing flows short-circuited on `navigation?.paused` and autofill could
  // never run, no matter what TAXROCKET_REAL_AUTOFILL was set to.
  const statuses = [];
  const ctx = sandbox(["runLocalIrisNavigationCheck"], {
    assertNavigatorBuild: () => {},
    AGENT_BUILD_TAG: "test-build",
    normalizeExplicitResidencyStatus: (value) =>
      String(value || "").toLowerCase() === "resident" ? "Resident" : null,
    lastTourStateKey: null,
    lastNavigationOptions: {},
    ensureWorkerWindow: async () => ({ isDestroyed: () => false }),
    getLivePortalWindow: () => ({}),
    navigationStates: new Map(),
    irisNavigation: {
      ...navigation,
      inspectNavigation: async () => ({
        inspection: { frames: [{ document: { present: true } }] },
        requiredAction: "portal_sections_inspected",
      }),
    },
    writePortalInspectionToDisk: () => "C:/logs/inspection.json",
    getSelectorBundleSignal: () => null,
    ensureNavigationJobActive: async () => {},
    updateLocalJobStatus: async (_id, status) => statuses.push(status),
    pushStatus: () => {},
    launchState: { accountReference: "1234567890123" },
    realPortalMode: true,
    activeJobExecutionLog: null,
    buildNewReturnContext: () => ({}),
    captureWindowScreenshot: async () => null,
  });
  const outcome = await ctx.runLocalIrisNavigationCheck(
    {
      filingPacket: {
        taxYear: 2026,
        snapshot: {
          filing: {
            residencyStatus: "Resident",
            reconciliationStatus: "RESOLVED",
            reconciliationGap: 0,
          },
        },
      },
      taxAutomationConfig: {},
    },
    { id: "job-1" },
  );
  assert.equal(
    outcome.paused,
    false,
    "a completed tour must not block autofill",
  );
  assert.equal(outcome.pauseAction, "portal_sections_inspected");
  assert.equal(outcome.result.navigationVerified, true);
  assert.equal(outcome.result.sectionTourComplete, true);
  assert.equal(outcome.result.submitted, false);
  assert.ok(
    !statuses.includes("awaiting_user_action"),
    "a completed tour must not be recorded as awaiting the user",
  );
});

test("Phase 1.6: with autofill off, a completed tour still parks the job for review", async () => {
  // Navigation succeeded but nothing was filled, so the job is finished work
  // awaiting the user — it must not be left silently running or marked done.
  const statuses = [];
  const ctx = sandbox(["runLocalTaxDryRunFlow", "finishNavigationOnly"], {
    realPortalMode: true,
    getRealAutofillMode: () => "off",
    runLocalIrisNavigationCheck: async () => ({
      paused: false,
      pauseAction: "portal_sections_inspected",
      pauseMessage: "done",
      result: {},
      executionLog: [],
    }),
    runRealIrisAutofill: () => {
      throw new Error("Autofill must not run while the flag is off");
    },
    updateLocalJobStatus: async (_id, status) => statuses.push(status),
    ensureWorkerWindow: () => {
      throw new Error("Legacy filler must not run");
    },
  });
  const outcome = await ctx.runLocalTaxDryRunFlow({ job: { id: "job-1" } });
  assert.equal(outcome.paused, true);
  assert.deepEqual(statuses, ["awaiting_user_action"]);
});

test("Phase 1.6: dry-run completion says no values were entered or filed", async () => {
  let mode = null;
  const ctx = sandbox(["runLocalTaxDryRunFlow", "finishNavigationOnly"], {
    realPortalMode: true,
    getRealAutofillMode: () => "dry",
    runLocalIrisNavigationCheck: async () => ({
      paused: false,
      pauseAction: "portal_sections_inspected",
      pauseMessage: "done",
      result: {
        mode: "live_return_navigation_only",
        navigationVerified: true,
        submitted: false,
      },
      executionLog: [{ step: "nav" }],
    }),
    runRealIrisAutofill: async (_c, _j, m) => {
      mode = m;
      return {
        paused: false,
        executionLog: [{ step: "fill" }],
        result: {
          mode: m,
          summary: { total: 3, filled: 3, skipped: 0 },
        },
      };
    },
    updateLocalJobStatus: async () => {},
    ensureWorkerWindow: () => {
      throw new Error("Legacy filler must not run");
    },
  });
  const outcome = await ctx.runLocalTaxDryRunFlow({ job: { id: "job-1" } });
  assert.equal(mode, "dry", "autofill must receive the dry-run mode");
  assert.equal(outcome.paused, false);
  assert.equal(outcome.executionLog.map((s) => s.step).join(","), "nav,fill");
  assert.equal(outcome.result.mode, "live_return_dry_run");
  assert.equal(outcome.result.navigationMode, "live_return_navigation_only");
  assert.equal(outcome.result.autofill.summary.filled, 3);
  assert.match(outcome.result.message, /Dry run checked 3 approved fields/);
  assert.match(outcome.result.message, /did not enter or save values or submit/);
  assert.equal(outcome.result.submitted, false);
});

test("Phase 1.6: live autofill reports entered values but never claims the return was filed", async () => {
  const ctx = sandbox(["runLocalTaxDryRunFlow", "finishNavigationOnly"], {
    realPortalMode: true,
    getRealAutofillMode: () => "live",
    runLocalIrisNavigationCheck: async () => ({
      paused: false,
      pauseAction: "portal_sections_inspected",
      pauseMessage: "navigation complete",
      result: {
        mode: "live_return_navigation_only",
        navigationVerified: true,
        submitted: false,
      },
      executionLog: [{ step: "nav" }],
    }),
    runRealIrisAutofill: async () => ({
      paused: false,
      executionLog: [{ step: "real_autofill_result" }],
      result: {
        mode: "live",
        summary: { total: 2, filled: 2, skipped: 0 },
        message: "2/2 fields filled",
      },
    }),
    updateLocalJobStatus: async () => {},
    ensureWorkerWindow: () => {
      throw new Error("Legacy filler must not run");
    },
  });
  const outcome = await ctx.runLocalTaxDryRunFlow({ job: { id: "job-1" } });
  assert.equal(outcome.paused, false);
  assert.equal(outcome.pauseAction, null);
  assert.equal(outcome.result.mode, "live_return_autofill");
  assert.equal(outcome.result.navigationMode, "live_return_navigation_only");
  assert.equal(outcome.result.autofillMode, "live");
  assert.equal(outcome.result.autofillSummary.filled, 2);
  assert.match(outcome.result.message, /entered and verified 2\/2 approved fields/);
  assert.match(outcome.result.message, /not saved, calculated, paid, or submitted/);
  assert.equal(outcome.result.submitted, false);
});

test("Phase 1.6: skipped live fields stay paused for review, not silently completed", async () => {
  const ctx = sandbox(["runLocalTaxDryRunFlow", "finishNavigationOnly"], {
    realPortalMode: true,
    getRealAutofillMode: () => "live",
    runLocalIrisNavigationCheck: async () => ({
      paused: false,
      pauseAction: "portal_sections_inspected",
      pauseMessage: "navigation complete",
      result: { navigationVerified: true, submitted: false },
      executionLog: [{ step: "nav" }],
    }),
    runRealIrisAutofill: async () => ({
      paused: true,
      pauseAction: "portal_autofill_review",
      pauseMessage:
        "One approved field could not be placed safely. Nothing was saved, submitted, calculated, or paid.",
      executionLog: [{ step: "real_autofill_skip" }],
      result: {
        mode: "live",
        summary: { total: 2, filled: 1, skipped: 1 },
        message: "1/2 fields filled; skipped: unverified_target",
        reviewRequired: true,
      },
    }),
    updateLocalJobStatus: async () => {},
    ensureWorkerWindow: () => {
      throw new Error("Legacy filler must not run");
    },
  });
  const outcome = await ctx.runLocalTaxDryRunFlow({ job: { id: "job-1" } });
  assert.equal(outcome.paused, true);
  assert.equal(outcome.pauseAction, "portal_autofill_review");
  assert.match(outcome.pauseMessage, /could not be placed safely/);
  assert.equal(outcome.result.mode, "live_return_autofill");
  assert.equal(outcome.result.autofillSummary.skipped, 1);
});

test("Phase 1.6: a genuine checkpoint still pauses and is still recorded", async () => {
  const statuses = [];
  const ctx = sandbox(["runLocalTaxDryRunFlow", "finishNavigationOnly"], {
    realPortalMode: true,
    getRealAutofillMode: () => "dry",
    runLocalIrisNavigationCheck: async () => ({
      paused: true,
      pauseAction: "portal_section_navigation",
    }),
    runRealIrisAutofill: () => {
      throw new Error("Autofill must not run behind a pause");
    },
    updateLocalJobStatus: async (_id, status) => statuses.push(status),
    ensureWorkerWindow: () => {
      throw new Error("Legacy filler must not run");
    },
  });
  const outcome = await ctx.runLocalTaxDryRunFlow({ job: { id: "job-1" } });
  assert.equal(outcome.paused, true);
  assert.equal(outcome.pauseAction, "portal_section_navigation");
  // finishNavigationOnly must not re-record an already-paused checkpoint.
  assert.deepEqual(statuses, []);
});

// ─── Phase 2a: fill the section that owns each code ─────────────────────────
// Dry-run 2026-09-09 filled 0/27. The tour ends on Attachment (no data rows)
// and the filler only sees the section on screen, so codes that genuinely exist
// and are editable on Salary were reported row_not_found.

const tourFixture = {
  complete: true,
  sections: [
    {
      id: "salary",
      rows: [{ code: "1000" }, { code: "1009" }, { code: "1049" }],
    },
    { id: "withholding", rows: [{ code: "640000" }, { code: "64150002" }] },
    { id: "computations", rows: [{ code: "9201" }] },
    { id: "attachment", rows: [] },
  ],
};

test("Phase 2a: codes are grouped by the section that actually showed them", () => {
  const index = navigation.buildSectionCodeIndex(tourFixture);
  assert.equal(index.get("1000"), "salary");
  assert.equal(index.get("64150002"), "withholding");
  assert.equal(index.get("9201"), "computations");
  assert.equal(
    index.get("999999"),
    undefined,
    "an unseen code must not resolve",
  );

  const { groups, unlocated } = navigation.planSectionFills(
    [
      { irisCode: "9201" },
      { irisCode: "1000" },
      { irisCode: "640000" },
      { irisCode: "1009" },
      { irisCode: "999999" },
    ],
    tourFixture,
  );
  // Tour order, not packet order: navigation moves forward through the return.
  assert.equal(
    groups.map((g) => g.sectionId).join(","),
    "salary,withholding,computations",
  );
  assert.equal(groups[0].fields.map((f) => f.irisCode).join(","), "1000,1009");
  assert.equal(unlocated.map((f) => f.irisCode).join(","), "999999");
});

test("Phase 2a: an unseen code is never guessed into a section", () => {
  const { groups, unlocated } = navigation.planSectionFills(
    [{ irisCode: "5028" }, { irisCode: "" }, {}],
    tourFixture,
  );
  assert.equal(groups.length, 0);
  assert.equal(
    unlocated.length,
    3,
    "every unresolvable field must be reported, not dropped",
  );
});

test("Phase 2a: an empty or missing tour yields no targets rather than a wrong one", () => {
  for (const tour of [null, undefined, {}, { sections: [] }]) {
    const { groups, unlocated } = navigation.planSectionFills(
      [{ irisCode: "1000" }],
      tour,
    );
    assert.equal(groups.length, 0);
    assert.equal(unlocated.length, 1);
  }
});

test("Phase 2a: navigateToSection refuses an unknown section and never clicks", async () => {
  const result = await navigation.navigateToSection(
    {},
    { sectionId: "not_a_section" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "unsupported_section");
});

test("withholding grid readiness rejects any row except approved code 64020004", async () => {
  const result = await navigation.navigateToSection(
    {},
    {
      sectionId: "tax_deductions",
      requiredGridTitle: "Adjustable Tax",
      requiredRowCodes: ["64020005"],
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "unsupported_grid_rows");
});

test("Phase 2a: navigateToSection reports rather than filling the showing grid", async () => {
  await withPage(dashboard(), async (_page, win) => {
    // No return document is open, so there is nothing to switch.
    const result = await navigation.navigateToSection(win, {
      sectionId: "salary",
      taxYear: 2026,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "document_not_open");
  });
});

test("Phase 2a: autofill walks each owning section and never fills the last-viewed grid", async () => {
  const visited = [];
  const filled = [];
  const ctx = sandbox(["runRealIrisAutofill"], {
    ensureWorkerWindow: async () => ({
      isDestroyed: () => false,
      // Autofill now proves the return workspace is open before it touches a
      // section, so the stub window has to answer that probe.
      webContents: {
        executeJavaScript: async () => ({ returnWorkspace: true, inputs: 12 }),
      },
    }),
    launchState: { accountReference: "1234567890123" },
    activeJobExecutionLog: null,
    pushStatus: () => {},
    captureWindowScreenshot: async () => null,
    lastSectionTour: tourFixture,
    irisNavigation: navigation,
    irisRowFiller: {
      FILL_STATUS: { FILLED: "filled", ROW_NOT_FOUND: "row_not_found" },
      summarise: (results) => ({
        total: results.length,
        filled: 0,
        skipped: results.length,
      }),
      describeFillSummary: () => "summary",
      SUCCESS_STATUSES: new Set(["filled", "already_correct"]),
      snapshotIrisRows: async () => [],
      findUnexpectedPrefill: () => [],
      fillIrisRows: async (_win, fields) => {
        filled.push(fields.map((f) => f.irisCode).join(","));
        return {
          results: fields.map((f) => ({ ...f, status: "filled" })),
          summary: {},
        };
      },
    },
  });
  // navigateToSection is on the real module; stub only the movement.
  ctx.irisNavigation = {
    ...navigation,
    navigateToSection: async (_win, { sectionId }) => {
      visited.push(sectionId);
      return { ok: true, status: "switched" };
    },
  };
  const outcome = await ctx.runRealIrisAutofill(
    {
      filingPacket: {
        taxYear: 2026,
        snapshot: {
          portalFieldMap: [
            { irisCode: "9201", label: "c" },
            { irisCode: "1000", label: "a" },
            { irisCode: "1009", label: "b" },
            { irisCode: "5028", label: "unseen" },
          ],
        },
      },
    },
    { id: "job-1" },
    "dry",
  );
  assert.equal(
    visited.join(","),
    "salary,computations",
    "sections visited in tour order",
  );
  assert.equal(filled.join(" | "), "1000 | 1009 | 9201", "one figure at a time, in section order");
  // The unseen code is reported, never filled into whatever grid was showing.
  const unseen = outcome.result.results.find((r) => r.irisCode === "5028");
  assert.equal(unseen.status, "row_not_found");
  assert.equal(unseen.sectionId, null);
  assert.equal(
    outcome.result.results.length,
    4,
    "every packet field is accounted for",
  );
});

test("TY2026 autofill passes only code 64020004 to the Adjustable Tax readiness gate", async () => {
  const tour = {
    sections: [
      { id: "salary", rows: [{ code: "1009" }], mappingVerified: true },
      { id: "tax_deductions", rows: [{ code: "64020004" }], mappingVerified: true },
    ],
  };
  const navigationCalls = [];
  const filledCodes = [];
  const ctx = sandbox(["runRealIrisAutofill"], {
    ensureWorkerWindow: async () => ({
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: async () => ({ returnWorkspace: true, inputs: 12 }),
      },
    }),
    launchState: { accountReference: "1234567890123" },
    activeJobExecutionLog: null,
    pushStatus: () => {},
    captureWindowScreenshot: async () => null,
    lastSectionTour: tour,
    irisNavigation: {
      ...navigation,
      navigateToSection: async (_win, options) => {
        navigationCalls.push(options);
        return {
          ok: true,
          status: options.requiredGridTitle ? "grid_ready" : "switched",
          gridTitle: options.requiredGridTitle || undefined,
        };
      },
    },
    irisRowFiller: {
      FILL_STATUS: { FILLED: "filled", ROW_NOT_FOUND: "row_not_found" },
      summarise: (results) => ({ total: results.length, filled: results.length, skipped: 0 }),
      describeFillSummary: () => "summary",
      SUCCESS_STATUSES: new Set(["filled", "already_correct"]),
      packetPromisedIrisCodes: () => [],
      snapshotIrisRows: async () => [],
      findUnexpectedPrefill: () => [],
      fillIrisRows: async (_win, fields) => {
        const codes = fields.map((field) => field.irisCode);
        filledCodes.push(...codes);
        return { results: fields.map((field) => ({ ...field, status: "filled" })), summary: {} };
      },
    },
  });
  const outcome = await ctx.runRealIrisAutofill(
    {
      filingPacket: {
        taxYear: 2026,
        snapshot: {
          portalFieldMap: [
            { irisCode: "1009", value: "3420000" },
            { irisCode: "64020004", value: "210000" },
          ],
        },
      },
    },
    { id: "job-1" },
    "dry",
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        navigationCalls.map(({ sectionId, requiredGridTitle, requiredRowCodes }) => ({
          sectionId,
          requiredGridTitle,
          requiredRowCodes,
        })),
      ),
    ),
    [
      { sectionId: "salary", requiredGridTitle: null, requiredRowCodes: [] },
      {
        sectionId: "tax_deductions",
        requiredGridTitle: "Adjustable Tax",
        requiredRowCodes: ["64020004"],
      },
    ],
  );
  assert.deepEqual(filledCodes, ["1009", "64020004"]);
  assert.equal(outcome.paused, false);
  assert.equal(outcome.result.reviewRequired, false);
});

test("an unapproved extra tax-deduction code keeps the whole group untouched", async () => {
  let navigationCalls = 0;
  let fillCalls = 0;
  const tour = {
    sections: [
      {
        id: "tax_deductions",
        rows: [{ code: "64020004" }, { code: "64020005" }],
        mappingVerified: true,
      },
    ],
  };
  const ctx = sandbox(["runRealIrisAutofill"], {
    ensureWorkerWindow: async () => ({
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: async () => ({ returnWorkspace: true, inputs: 12 }),
      },
    }),
    launchState: { accountReference: "1234567890123" },
    activeJobExecutionLog: null,
    pushStatus: () => {},
    captureWindowScreenshot: async () => null,
    lastSectionTour: tour,
    irisNavigation: {
      ...navigation,
      navigateToSection: async () => {
        navigationCalls += 1;
        return { ok: true, status: "grid_ready" };
      },
    },
    irisRowFiller: {
      FILL_STATUS: { FILLED: "filled", ROW_NOT_FOUND: "row_not_found" },
      summarise: (results) => ({ total: results.length, filled: 0, skipped: results.length }),
      describeFillSummary: () => "summary",
      SUCCESS_STATUSES: new Set(["filled", "already_correct"]),
      packetPromisedIrisCodes: () => [],
      snapshotIrisRows: async () => [],
      findUnexpectedPrefill: () => [],
      fillIrisRows: async () => {
        fillCalls += 1;
        throw new Error("an unapproved code must not reach the filler");
      },
    },
  });
  const outcome = await ctx.runRealIrisAutofill(
    {
      filingPacket: {
        taxYear: 2026,
        snapshot: {
          portalFieldMap: [
            { irisCode: "64020004", value: "210000" },
            { irisCode: "64020005", value: "1000" },
          ],
        },
      },
    },
    { id: "job-1" },
    "dry",
  );
  assert.equal(navigationCalls, 0);
  assert.equal(fillCalls, 0);
  assert.ok(
    outcome.result.results.every(
      (field) => field.sectionStatus === "unsupported_tax_deduction_scope",
    ),
  );
});

// Combined Salary+Pension (31-Oct-2026, live job cmvw9kui5005v8mhhqm5cva8c):
// one tax_deductions group spans salary 64020004 ("Adjustable Tax") and
// pension 64020007 ("Final Tax"). Every field names its grid, so the filler
// fills one grid at a time — the path a single-source filing takes — instead
// of holding figures whose targets are known. The pension source below is
// the guard's final_above_10m contract for a PKR 12,000,000 pension.
const SPLIT_PENSION_SOURCE = {
  version: "pension-source-v1",
  documentId: "doc-pension",
  fingerprint: "a".repeat(64),
  annualPension: 12000000,
  grossAnnual: 12000000,
  medicalAnnual: 0,
  netAnnual: 11900000,
  reviewNote: "",
  ledgerPension: 11900000,
  taxDeducted: 100000,
  taxAlreadyInLedger: 0,
  overlapNote: null,
  creditToAdd: 100000,
  treatment: "final_above_10m",
  ageBracket: "BELOW_70",
  baseTax: 100000,
  surcharge: 10000,
  taxDue: 110000,
};
const SPLIT_COMBINED_FIELDS = [
  { irisCode: "1009", column: "Total Amount", value: 4800000 },
  { irisCode: "1008", column: "Total Amount", value: 12000000 },
  { irisCode: "1008", column: "Subject to Final Tax", value: 2000000 },
  { irisCode: "1008", column: "Subject to Exemption", value: 10000000 },
  { irisCode: "64020004", column: "Tax Collected / Deducted", value: 600000 },
  { irisCode: "64020007", column: "Taxable Amount", value: 2000000 },
  { irisCode: "64020007", column: "Tax Deducted", value: 100000 },
  // The pension guard's contract includes the 4AB surcharge row; a real
  // packet always carries it (its fill target is the Computations section,
  // which this tour deliberately does not offer, so it stays unfilled here).
  { irisCode: "923184", column: "Total Income", value: 10000 },
];
function splitRun(packetFields, taxDeductionTourRows) {
  const tour = {
    sections: [
      { id: "salary", rows: [{ code: "1009" }, { code: "1008" }], mappingVerified: true },
      {
        id: "tax_deductions",
        rows: taxDeductionTourRows || [{ code: "64020004" }, { code: "64020007" }],
        mappingVerified: true,
      },
    ],
  };
  const navigationCalls = [];
  const filledCodes = [];
  const ctx = sandbox(["runRealIrisAutofill"], {
    ensureWorkerWindow: async () => ({
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: async () => ({ returnWorkspace: true, inputs: 12 }),
      },
    }),
    launchState: { accountReference: "1234567890123" },
    activeJobExecutionLog: null,
    pushStatus: () => {},
    captureWindowScreenshot: async () => null,
    lastSectionTour: tour,
    irisNavigation: {
      ...navigation,
      navigateToSection: async (_win, options) => {
        navigationCalls.push(options);
        return {
          ok: true,
          status: options.requiredGridTitle ? "grid_ready" : "switched",
          gridTitle: options.requiredGridTitle || undefined,
        };
      },
    },
    irisRowFiller: {
      FILL_STATUS: { FILLED: "filled", ROW_NOT_FOUND: "row_not_found" },
      summarise: (results) => ({ total: results.length, filled: results.length, skipped: 0 }),
      describeFillSummary: () => "summary",
      SUCCESS_STATUSES: new Set(["filled", "already_correct"]),
      packetPromisedIrisCodes: () => [],
      snapshotIrisRows: async () => [],
      findUnexpectedPrefill: () => [],
      fillIrisRows: async (_win, fields) => {
        filledCodes.push(...fields.map((field) => field.irisCode));
        return { results: fields.map((field) => ({ ...field, status: "filled" })), summary: {} };
      },
    },
  });
  return ctx.runRealIrisAutofill(
    {
      filingPacket: {
        taxYear: 2026,
        snapshot: {
          filing: { incomeSources: ["salary", "pension"] },
          pension: SPLIT_PENSION_SOURCE,
          portalFieldMapDetailed: {
            computationHints: { pensionSourceFingerprint: SPLIT_PENSION_SOURCE.fingerprint },
            mappingGaps: {},
          },
          portalFieldMap: packetFields,
        },
      },
    },
    { id: "job-1" },
    "dry",
  ).then((outcome) => ({ outcome, navigationCalls, filledCodes }));
}

test("combined salary+pension fills Adjustable Tax and Final Tax one grid at a time", async () => {
  const { outcome, navigationCalls, filledCodes } = await splitRun(SPLIT_COMBINED_FIELDS);
  const tdCalls = navigationCalls
    .filter((call) => call.sectionId === "tax_deductions")
    .map((call) => ({ grid: call.requiredGridTitle, codes: call.requiredRowCodes }));
  assert.deepEqual(tdCalls, [
    { grid: "Adjustable Tax", codes: ["64020004"] },
    { grid: "Final Tax", codes: ["64020007", "64020007"] },
  ]);
  assert.deepEqual(filledCodes, ["1009", "1008", "1008", "1008", "64020004", "64020007", "64020007"]);
  assert.ok(
    outcome.result.results.every((field) => field.sectionStatus !== "unsupported_tax_deduction_scope"),
    "no figure may be held for scope on a fully mapped combined packet",
  );
});

test("a no-grid code beside known grids still holds the whole tax_deductions group", async () => {
  const fields = [...SPLIT_COMBINED_FIELDS, { irisCode: "64020005", column: "Tax Deducted", value: 1000 }];
  // The tour must SHOW 64020005 in this section, or the planner never puts
  // it in the group at all (unseen codes are reported, never grouped).
  const tourRows = [{ code: "64020004" }, { code: "64020007" }, { code: "64020005" }];
  const { outcome, navigationCalls, filledCodes } = await splitRun(fields, tourRows);
  assert.equal(navigationCalls.filter((call) => call.sectionId === "tax_deductions").length, 0);
  assert.ok(!filledCodes.includes("64020004") && !filledCodes.includes("64020007"));
  const held = outcome.result.results.filter((field) =>
    ["64020004", "64020007", "64020005"].includes(field.irisCode),
  );
  assert.ok(held.length === 4 && held.every((field) => field.sectionStatus === "unsupported_tax_deduction_scope"));
});

test("Phase 2a: a section that will not open leaves its fields untouched", async () => {
  const ctx = sandbox(["runRealIrisAutofill"], {
    ensureWorkerWindow: async () => ({
      isDestroyed: () => false,
      // Autofill now proves the return workspace is open before it touches a
      // section, so the stub window has to answer that probe.
      webContents: {
        executeJavaScript: async () => ({ returnWorkspace: true, inputs: 12 }),
      },
    }),
    launchState: { accountReference: "1234567890123" },
    activeJobExecutionLog: null,
    pushStatus: () => {},
    captureWindowScreenshot: async () => null,
    lastSectionTour: tourFixture,
    irisNavigation: {
      ...navigation,
      navigateToSection: async () => ({ ok: false, status: "tab_not_found" }),
    },
    irisRowFiller: {
      FILL_STATUS: { FILLED: "filled", ROW_NOT_FOUND: "row_not_found" },
      summarise: (results) => ({
        total: results.length,
        filled: 0,
        skipped: results.length,
      }),
      describeFillSummary: () => "summary",
      SUCCESS_STATUSES: new Set(["filled", "already_correct"]),
      snapshotIrisRows: async () => [],
      findUnexpectedPrefill: () => [],
      fillIrisRows: async () => {
        throw new Error("must not fill a section that did not open");
      },
    },
  });
  const outcome = await ctx.runRealIrisAutofill(
    {
      filingPacket: {
        taxYear: 2026,
        snapshot: { portalFieldMap: [{ irisCode: "1000" }] },
      },
    },
    { id: "job-1" },
    "dry",
  );
  assert.equal(outcome.result.results[0].status, "row_not_found");
  assert.equal(outcome.result.results[0].sectionStatus, "tab_not_found");
});

test("Phase 2a: navigateToSection unlocks the navigation allowlist (openReturn)", async () => {
  // Dry-run 2026-09-09 #4: every section click returned
  // "data_tab_navigation_not_enabled" because navigateToSection probed without
  // openReturn, and portalProbe gates the whole navigation action allowlist on
  // it. The plan was correct; the clicks were refused before they were tried.
  const seen = [];
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      getURL: () => "https://iris.fbr.gov.pk/nitr/workflow",
      executeJavaScript: async (source) => {
        const options = JSON.parse(
          source.slice(source.lastIndexOf("})(") + 3, -1),
        );
        seen.push(options);
        return {
          document: { present: true },
          section: { id: "attachment", dataViewActive: false, navigation: [] },
          actionResult: {
            action: options.action || "inspect",
            status: "read_only",
          },
        };
      },
    },
  };
  fakeWindow.webContents.mainFrame = {
    url: "https://iris.fbr.gov.pk/nitr/workflow",
    executeJavaScript: fakeWindow.webContents.executeJavaScript,
  };
  fakeWindow.webContents.mainFrame.framesInSubtree = [
    fakeWindow.webContents.mainFrame,
  ];

  await navigation.navigateToSection(fakeWindow, {
    sectionId: "salary",
    taxYear: 2026,
  });
  assert.ok(seen.length > 0, "the section switch must actually probe the page");
  for (const options of seen)
    assert.equal(
      options.openReturn,
      true,
      "every probe must carry openReturn or portalProbe refuses the click",
    );
});

test("generic Computations navigation retries a panel click that was not dispatched", async () => {
  let panelExpanded = false;
  let panelAttempts = 0;
  let active = false;
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      getURL: () => "https://iris.fbr.gov.pk/nitr/workflow",
      executeJavaScript: async (source) => {
        const options = JSON.parse(
          source.slice(source.lastIndexOf("})(") + 3, -1),
        );
        const actionResult = {
          action: options.action || "inspect",
          status: "read_only",
        };
        if (options.action === "section-panel") {
          panelAttempts += 1;
          if (panelAttempts === 1) {
            actionResult.status = "not_interactable";
            actionResult.interaction = { reason: "obstructed" };
          } else {
            panelExpanded = true;
            actionResult.status = "clicked";
          }
        }
        if (options.action === "section-tab") {
          active = true;
          actionResult.status = "clicked";
        }
        return {
          authenticated: true,
          document: { present: true },
          section: {
            id: active ? "computations" : "salary",
            dataViewActive: true,
            busy: false,
            structurePresent: active,
            navigation: [{ id: "computations", panelExpanded }],
          },
          actionResult,
        };
      },
    },
  };
  fakeWindow.webContents.mainFrame = {
    url: "https://iris.fbr.gov.pk/nitr/workflow",
    executeJavaScript: fakeWindow.webContents.executeJavaScript,
  };
  fakeWindow.webContents.mainFrame.framesInSubtree = [
    fakeWindow.webContents.mainFrame,
  ];

  const result = await navigation.navigateToSection(fakeWindow, {
    sectionId: "computations",
    taxYear: 2026,
  });
  assert.equal(panelAttempts, 2);
  assert.equal(result.ok, true);
  assert.equal(result.status, "switched");
});

// ─── P2: drift must be EVIDENCE, not a substring ────────────────────────────
// Shapes copied from the operator's live capture (latest-portal-inspection.json):
// every section "captured" with rows, six of seven `structure_changed`.

const liveTourSections = (overrides = {}) => ({
  sections: [
    { id: "salary", status: "captured", transition: "salary_verified", rows: new Array(8), grids: [{}], mappingVerified: true },
    { id: "tax_deductions", status: "captured", transition: "structure_changed", rows: new Array(9), grids: [{}, {}, {}], mappingVerified: false },
    { id: "allowance_credits", status: "captured", transition: "structure_changed", rows: new Array(3), grids: [{}, {}, {}], mappingVerified: false },
    { id: "withholding", status: "captured", transition: "structure_changed", rows: new Array(7), grids: [{}, {}, {}, {}], mappingVerified: false },
    { id: "computations", status: "captured", transition: "structure_changed", rows: new Array(7), grids: [{}], mappingVerified: false },
    { id: "payment", status: "captured", transition: "structure_changed", rows: [], grids: [], mappingVerified: false },
    { id: "attachment", status: "captured", transition: "structure_changed", rows: [], grids: [], mappingVerified: false },
    ...(overrides.extraSections || []),
  ],
});

test("P2: the live pilot's refusal run is NOT selector drift", () => {
  const build = navigation.buildPortalEvidenceDiagnostics;
  const ctx = sandbox([
    "buildSelectorDriftDiagnostics",
    "buildMappingRefusalDiagnostics",
    "classifyRecoverableAssistedIssue",
    "looksLikeSessionReconnectNeeded",
    "inferLikelySelectorGroup",
    "getSelectorBundleSignal",
  ]);

  const evidence = build(liveTourSections());
  assert.equal(evidence.state, "structure_unverified", JSON.stringify(evidence));
  assert.deepEqual(evidence.drifted, [], "rows were present everywhere → no drift");
  // payment/attachment render no grids by design: they must not count as drift.
  assert.ok(!evidence.sections.some((s) => s.id === "payment" && evidence.drifted.includes("payment")));

  const refusalLog = [
    { step: "real_autofill_skip", detail: '1000 "Total Income from Salary" -> column_disabled (column: Total Amount)' },
    { step: "real_autofill_skip", detail: '1009 "Pay, Wages" -> column_disabled (column: Total Amount)' },
    { step: "real_autofill_skip", detail: '5028 "Other Receipts" -> row_not_found' },
  ];
  const classified = ctx.classifyRecoverableAssistedIssue(
    'Field fill failed: selector "#1000 input" matched nothing.',
    refusalLog,
    {},
    evidence,
  );
  assert.equal(classified.requiredAction, "portal_mapping_review");
  assert.equal(classified.selectorDriftDiagnostics, null);
  assert.equal(classified.mappingRefusalDiagnostics.refusalCount, 3);

  // Even with no refusals, the mere word "selector" plus an intact structure
  // must not produce a drift verdict.
  const driftless = ctx.buildSelectorDriftDiagnostics(
    'selector "#1000 input" did not resolve',
    [],
    {},
    evidence,
  );
  assert.equal(driftless, null, "intact structure ⇒ not drift, whatever the message says");
});

test("P2: rows that must exist but are missing IS drift, and the message is specific", () => {
  const build = navigation.buildPortalEvidenceDiagnostics;
  const ctx = sandbox([
    "buildSelectorDriftDiagnostics",
    "buildMappingRefusalDiagnostics",
    "classifyRecoverableAssistedIssue",
    "looksLikeSessionReconnectNeeded",
    "inferLikelySelectorGroup",
    "getSelectorBundleSignal",
  ]);
  const collapsed = build(
    liveTourSections({
      extraSections: [
        { id: "salary", status: "captured", transition: "structure_changed", rows: [], grids: [], mappingVerified: false },
      ],
    }),
  );
  assert.equal(collapsed.state, "rows_missing");
  assert.deepEqual(collapsed.drifted, ["salary"]);

  const drift = ctx.buildSelectorDriftDiagnostics(
    "Timed out waiting for selector #1009",
    [],
    { job: { payload: { selectorBundle: { bundleId: "b1" } } } },
    collapsed,
  );
  assert.equal(drift.reasonCode, "selector_drift_confirmed_by_capture");
  assert.match(drift.recommendedActions.join(" "), /rendered zero rows/s);

  // No capture at all → honest "suspected", never "confirmed".
  const blind = ctx.buildSelectorDriftDiagnostics(
    "Timed out waiting for selector #1009",
    [],
    {},
    build(null),
  );
  assert.equal(blind.reasonCode, "selector_drift_suspected");
  // main.js must not grow its own copy of the section rules.
  assert.match(mainSource, /const buildPortalEvidenceDiagnostics =\s*irisNavigation\.buildPortalEvidenceDiagnostics;/);
  assert.ok(
    !/const ROW_BEARING_SECTION_IDS = \[/.test(mainSource),
    "row-bearing section rules live in iris-navigation.js only",
  );
});

// ─── P4/P3: the config flag is a kill switch, live needs verified structure ──

test("P4.2: livePilot.automaticFilingEnabled downgrades live to dry", () => {
  // The REAL getRealAutofillMode, fed by env — the resolver is worthless if its
  // own input is stubbed away.
  const env = { TAXROCKET_REAL_AUTOFILL: "live" };
  const ctx = sandbox(["resolveAutofillMode", "getRealAutofillMode"], {
    process: { env },
  });
  const blocked = ctx.resolveAutofillMode({
    taxAutomationConfig: { livePilot: { automaticFilingEnabled: false } },
  });
  assert.equal(blocked.mode, "dry");
  assert.equal(blocked.downgradedFrom, "live");
  assert.match(blocked.note, /automaticFilingEnabled=false/);

  const allowed = ctx.resolveAutofillMode({
    taxAutomationConfig: { livePilot: { automaticFilingEnabled: true } },
  });
  assert.equal(allowed.mode, "live", "the flag never enables writes on its own");
  assert.equal(allowed.downgradedFrom, null);

  // Absent/null must not block — the mock and older bundles omit the whole shape.
  for (const context of [
    {},
    { taxAutomationConfig: {} },
    { taxAutomationConfig: { livePilot: { automaticFilingEnabled: null } } },
  ]) {
    assert.equal(
      ctx.resolveAutofillMode(context).mode,
      "live",
      `${JSON.stringify(context)} must leave the env var authoritative`,
    );
  }

  // "off" is never upgraded, and dry is never downgraded further.
  env.TAXROCKET_REAL_AUTOFILL = "off";
  const off = sandbox(["resolveAutofillMode", "getRealAutofillMode"], {
    process: { env },
  }).resolveAutofillMode({
    taxAutomationConfig: { livePilot: { automaticFilingEnabled: true } },
  });
  assert.equal(off.mode, "off");
});

test("P1 gate: live refuses a section the tour could not verify, dry still reports it", async () => {
  const tour = {
    complete: true,
    sections: [
      {
        id: "salary",
        rows: [{ code: "1009" }],
        mappingVerified: false,
        status: "captured",
        transition: "structure_changed",
      },
    ],
  };
  const makeCtx = (fillerStub) =>
    sandbox(["runRealIrisAutofill"], {
      ensureWorkerWindow: async () => ({
        isDestroyed: () => false,
        webContents: {
          executeJavaScript: async () => ({ returnWorkspace: true, inputs: 12 }),
        },
      }),
      launchState: { accountReference: "1234567890123" },
      activeJobExecutionLog: null,
      pushStatus: () => {},
      captureWindowScreenshot: async () => null,
      lastSectionTour: tour,
      irisNavigation: {
        ...navigation,
        navigateToSection: async () => ({ ok: true, status: "switched" }),
      },
      irisRowFiller: {
        FILL_STATUS: {
          FILLED: "filled",
          ROW_NOT_FOUND: "row_not_found",
          UNVERIFIED_TARGET: "unverified_target",
        },
        summarise: (results) => ({
          total: results.length,
          filled: results.filter((r) => r.status === "filled").length,
          skipped: results.filter((r) => r.status !== "filled").length,
        }),
        describeFillSummary: () => "summary",
      SUCCESS_STATUSES: new Set(["filled", "already_correct"]),
      snapshotIrisRows: async () => [],
      findUnexpectedPrefill: () => [],
        ...fillerStub,
      },
    });
  const packet = () => ({
    filingPacket: {
      taxYear: 2026,
      snapshot: { portalFieldMap: [{ irisCode: "1009", column: "Total Amount", value: "1000" }] },
    },
  });

  let fillCalls = 0;
  const live = await makeCtx({
    fillIrisRows: async () => {
      fillCalls += 1;
      return { results: [], summary: {} };
    },
  }).runRealIrisAutofill(packet(), { id: "job-1" }, "live");
  assert.equal(fillCalls, 0, "live must not inject into an unverified section");
  assert.equal(live.result.results[0].status, "unverified_target");
  assert.equal(live.result.summary.filled, 0);

  let dryCalls = 0;
  await makeCtx({
    fillIrisRows: async () => {
      dryCalls += 1;
      return { results: [], summary: {} };
    },
  }).runRealIrisAutofill(packet(), { id: "job-1" }, "dry");
  assert.equal(dryCalls, 1, "a dry run exists precisely to inspect unverified targets");
});

test("overwrite guard surfaces IRIS-vs-packet conflicts and unexpected pre-filled rows, and pauses", async () => {
  const tour = {
    complete: true,
    sections: [
      {
        id: "salary",
        rows: [{ code: "1009" }],
        mappingVerified: true,
        status: "captured",
        transition: "structure_changed",
      },
    ],
  };
  const makeCtx = (fillerStub) =>
    sandbox(["runRealIrisAutofill"], {
      ensureWorkerWindow: async () => ({
        isDestroyed: () => false,
        webContents: {
          executeJavaScript: async () => ({ returnWorkspace: true, inputs: 12 }),
        },
      }),
      launchState: { accountReference: "1234567890123" },
      activeJobExecutionLog: null,
      pushStatus: () => {},
      captureWindowScreenshot: async () => null,
      lastSectionTour: tour,
      irisNavigation: {
        ...navigation,
        navigateToSection: async () => ({ ok: true, status: "switched" }),
      },
      irisRowFiller: {
        FILL_STATUS: {
          FILLED: "filled",
          ROW_NOT_FOUND: "row_not_found",
          UNVERIFIED_TARGET: "unverified_target",
          OVERWRITE_NEEDS_CONFIRMATION: "overwrite_needs_confirmation",
          ALREADY_CORRECT: "already_correct",
        },
        summarise: (results) => ({
          total: results.length,
          filled: results.filter((r) => ["filled","already_correct"].includes(r.status)).length,
          skipped: results.filter((r) => !["filled","already_correct"].includes(r.status)).length,
        }),
        describeFillSummary: () => "summary",
      SUCCESS_STATUSES: new Set(["filled", "already_correct"]),
      snapshotIrisRows: async () => [],
      findUnexpectedPrefill: () => [],
        ...fillerStub,
      },
    });
  const packet = () => ({
    filingPacket: {
      taxYear: 2026,
      snapshot: { portalFieldMap: [{ irisCode: "1009", column: "Total Amount", value: "1000" }] },
    },
  });
  const run = await makeCtx({
    snapshotIrisRows: async () => [{ code: "1049" }],
    findUnexpectedPrefill: () => [
      { code: "1049", description: "Allowances", cells: [{ columnIndex: 0, value: "1,049" }] },
    ],
    fillIrisRows: async (_win, fields) => ({
      results: fields.map((f) => ({
        ...f,
        status: "overwrite_needs_confirmation",
        existingValue: "3,420,000",
        plannedValue: "1000",
      })),
      summary: {},
    }),
  }).runRealIrisAutofill(packet(), { id: "job-1" }, "live");
  assert.equal(run.paused, true);
  assert.equal(run.pauseAction, "portal_autofill_review");
  assert.match(run.pauseMessage, /1009 \(IRIS 3,420,000, packet 1000\).*NOT overwritten/);
  assert.match(run.pauseMessage, /1049 1,049/);
  assert.equal(run.result.unexpectedPrefill.length, 1);
  assert.equal(run.result.overwriteConflicts[0].existingValue, "3,420,000");

  // A clean, already-correct draft is not a review case.
  const clean = await makeCtx({
    fillIrisRows: async (_win, fields) => ({
      results: fields.map((f) => ({ ...f, status: "already_correct" })),
      summary: {},
    }),
  }).runRealIrisAutofill(packet(), { id: "job-1" }, "live");
  assert.equal(clean.paused, false);
});

test("wealth figures in the packet are held out of the Salary fill and reported as prepared, not entered", async () => {
  const tour = {
    complete: true,
    sections: [
      {
        id: "salary",
        rows: [{ code: "1009" }],
        mappingVerified: true,
        status: "captured",
        transition: "structure_changed",
      },
    ],
  };
  const makeCtx = (fillerStub, extra = {}) =>
    sandbox(["runRealIrisAutofill"], {
      // Wealth entry is a separate opt-in; off unless a test turns it on.
      getWealthAutofillEnabled: () => false,
      irisWealthDriver: {
        WEALTH_STATUS: { SETUP_FAILED: "wealth_setup_failed" },
        runWealthDriverStepwise: async () => {
          throw new Error("the wealth driver must not run when the switch is off");
        },
      },
      ensureNavigationJobActive: async () => {},
      ...extra,
      ensureWorkerWindow: async () => ({
        isDestroyed: () => false,
        webContents: {
          executeJavaScript: async () => ({ returnWorkspace: true, inputs: 12 }),
        },
      }),
      launchState: { accountReference: "1234567890123" },
      activeJobExecutionLog: null,
      pushStatus: () => {},
      captureWindowScreenshot: async () => null,
      lastSectionTour: tour,
      irisNavigation: {
        ...navigation,
        navigateToSection: async () => ({ ok: true, status: "switched" }),
      },
      irisRowFiller: {
        FILL_STATUS: {
          FILLED: "filled",
          ROW_NOT_FOUND: "row_not_found",
          UNVERIFIED_TARGET: "unverified_target",
          OVERWRITE_NEEDS_CONFIRMATION: "overwrite_needs_confirmation",
          ALREADY_CORRECT: "already_correct",
        },
        summarise: (results) => ({
          total: results.length,
          filled: results.filter((r) => ["filled","already_correct"].includes(r.status)).length,
          skipped: results.filter((r) => !["filled","already_correct"].includes(r.status)).length,
        }),
        describeFillSummary: () => "summary",
      SUCCESS_STATUSES: new Set(["filled", "already_correct"]),
      snapshotIrisRows: async () => [],
      findUnexpectedPrefill: () => [],
        ...fillerStub,
      },
    });
  const packet = () => ({
    filingPacket: {
      taxYear: 2026,
      snapshot: {
        portalFieldMap: [
          { irisCode: "1009", column: "Total Amount", value: "1000", sourceGroup: "incomeFields" },
          { irisCode: "7012", column: "Amount", value: "2100000", label: "Cash (Non-Business)", sourceGroup: "wealthFields" },
          { irisCode: "7051", column: "Amount", value: "960000", label: "Rent", sourceGroup: "wealthFields" },
        ],
      },
    },
  });
  const filledCodes = [];
  const run = await makeCtx({
    fillIrisRows: async (_win, fields) => {
      filledCodes.push(...fields.map((f) => f.irisCode));
      return { results: fields.map((f) => ({ ...f, status: "filled" })), summary: {} };
    },
  }).runRealIrisAutofill(packet(), { id: "job-1" }, "live");
  assert.equal(filledCodes.join(","), "1009", "wealth codes must not reach the Salary filler");
  assert.equal(run.paused, false, "held-out wealth rows are not a skipped field");
  assert.equal(run.result.wealthPrepared.length, 2);
  assert.match(run.executionLog.map((e) => e.step).join(","), /real_autofill_wealth_prepared/);
  const scope = ctxMerge(run);
  assert.match(scope.label, /2 row\(s\) prepared, not entered/);
  assert.equal(scope.readyToSubmit, false);

  function ctxMerge(autofill) {
    const merged = sandbox([
      "mergeNavigationAutofillOutcome",
      "buildHandoffScopeSummary",
    ]).mergeNavigationAutofillOutcome(
      { paused: false, result: {}, executionLog: [] },
      autofill,
      "live",
    );
    return merged.result.handoffScope;
  }
});

test("wealth driver: with the switch on, only wealth figures reach it and its outcome is merged and labelled honestly", async () => {
  const wealthFields = [
    { key: "7051:wealthFields:Amount", irisCode: "7051", column: "Amount", value: "960000", label: "Rent", sourceGroup: "wealthFields" },
    { key: "7030:wealthFields:Amount:PK36SCBL0000001123456702", irisCode: "7030", column: "Amount", value: "2100000", label: "SCB", sourceGroup: "wealthFields", rowDescriptionIncludes: "PK36SCBL0000001123456702" },
  ];
  const packet = {
    filingPacket: {
      taxYear: 2026,
      snapshot: {
        portalFieldMap: [
          { irisCode: "1009", column: "Total Amount", value: "1000", sourceGroup: "incomeFields" },
          ...wealthFields,
        ],
      },
    },
  };
  const tour = {
    complete: true,
    sections: [{ id: "salary", rows: [{ code: "1009" }], mappingVerified: true, status: "captured", transition: "structure_changed" }],
  };
  const build = (driverResult, mode, { realGuard = false, reference = "1234567890123" } = {}) => {
    const seen = { driverFields: null, driverMode: null, salaryCodes: [], navigated: [] };
    const guardExtras = realGuard
      ? {
          // The REAL ensureNavigationJobActive, with only the network stubbed.
          getApiBaseUrl: () => "http://web.test",
          loadAgentState: () => ({ deviceAuthToken: "t" }),
          fetch: async () => ({ ok: true, json: async () => ({ ok: true, job: { status: "running", expired: false } }) }),
          AbortSignal: { timeout: () => undefined },
          encodeURIComponent,
          updateLocalJobStatus: async () => {},
        }
      : { ensureNavigationJobActive: async () => {} };
    const ctx = sandbox(realGuard ? ["runRealIrisAutofill", "ensureNavigationJobActive"] : ["runRealIrisAutofill"], {
      ...guardExtras,
      ensureWorkerWindow: async () => ({
        isDestroyed: () => false,
        webContents: { executeJavaScript: async () => ({ returnWorkspace: true, inputs: 12 }) },
      }),
      launchState: { accountReference: reference, deviceAuthToken: "t" },
      activeJobExecutionLog: null,
      pushStatus: () => {},
      captureWindowScreenshot: async () => null,
      lastSectionTour: tour,
      getWealthAutofillEnabled: () => true,
      irisNavigation: {
        ...navigation,
        navigateToSection: async (_win, opts) => {
          seen.navigated.push(opts.sectionId);
          return { ok: true, status: "switched" };
        },
      },
      irisWealthDriver: {
        WEALTH_STATUS: { SETUP_FAILED: "wealth_setup_failed" },
        runWealthDriverStepwise: async (_win, fields, options) => {
          seen.driverFields = fields.map((f) => f.irisCode);
          seen.driverMode = options.mode;
          seen.cashStoreKey = options.cashStore && options.cashStore.key;
          // The navigate hook must open wealth sections through the guarded navigator.
          await options.navigate("wealth_reconciliation");
          await options.beforeStep();
          return driverResult(fields);
        },
      },
      irisRowFiller: {
        FILL_STATUS: { FILLED: "filled", ROW_NOT_FOUND: "row_not_found", UNVERIFIED_TARGET: "unverified_target", OVERWRITE_NEEDS_CONFIRMATION: "overwrite_needs_confirmation", ALREADY_CORRECT: "already_correct" },
        summarise: (results) => ({
          total: results.length,
          filled: results.filter((r) => ["filled", "already_correct"].includes(r.status)).length,
          skipped: results.filter((r) => !["filled", "already_correct"].includes(r.status)).length,
        }),
        describeFillSummary: () => "summary",
        SUCCESS_STATUSES: new Set(["filled", "already_correct"]),
        snapshotIrisRows: async () => [],
        findUnexpectedPrefill: () => [],
        fillIrisRows: async (_win, fields) => {
          seen.salaryCodes.push(...fields.map((f) => f.irisCode));
          return { results: fields.map((f) => ({ ...f, status: "filled" })), summary: {} };
        },
      },
    });
    return { ctx, seen, run: () => ctx.runRealIrisAutofill(packet, { id: "job-1" }, mode) };
  };
  const merge = (autofill, mode) =>
    sandbox(["mergeNavigationAutofillOutcome", "buildHandoffScopeSummary"]).mergeNavigationAutofillOutcome(
      { paused: false, result: {}, executionLog: [] },
      autofill,
      mode,
    );

  // All rows entered.
  const ok = build((fields) => ({ results: fields.map((f) => ({ ...f, status: "filled" })), setup: [] }), "live");
  const okRun = await ok.run();
  assert.deepEqual(ok.seen.driverFields, ["7051", "7030"], "driver receives wealth fields only");
  assert.equal(ok.seen.driverMode, "live");
  assert.equal(ok.seen.cashStoreKey, "1234567890123:2026", "the Cash in hand baseline is keyed by taxpayer and tax year");
  assert.deepEqual(ok.seen.salaryCodes, ["1009"], "salary filler still gets salary only");
  assert.deepEqual(ok.seen.navigated.slice(-1), ["wealth_reconciliation"]);
  assert.equal(okRun.paused, false);
  assert.equal(okRun.result.summary.total, 3);
  const okScope = merge(okRun, "live").result.handoffScope;
  assert.equal(okScope.salary, "filled");
  assert.equal(okScope.wealthStatement, "entered_not_calculated");
  assert.match(okScope.label, /Wealth .* 2\/2 row\(s\) entered/);
  assert.match(okScope.label, /Calculate/);
  assert.equal(okScope.readyToSubmit, false);
  assert.match(okScope.label, /submit it yourself/);
  assert.equal(okScope.nextStep, "taxpayer_reviews_and_submits");

  // One wealth row could not be created: pause for review, Salary stays green.
  const bad = build(
    (fields) => ({
      results: fields.map((f, i) => (i === 0 ? { ...f, status: "filled" } : { ...f, status: "wealth_setup_failed", setupStatus: "bank_iban_not_resolved" })),
      setup: [],
    }),
    "live",
  );
  const badRun = await bad.run();
  assert.equal(badRun.paused, true);
  assert.equal(badRun.pauseAction, "portal_autofill_review");
  const badScope = merge(badRun, "live").result.handoffScope;
  assert.equal(badScope.salary, "filled", "a wealth failure must not repaint Salary");
  assert.equal(badScope.wealthStatement, "needs_review");
  const prepared = badRun.result.wealthPrepared.find((f) => f.irisCode === "7030");
  assert.equal(prepared.status, "wealth_setup_failed");
  assert.equal(prepared.setupStatus, "bank_iban_not_resolved");

  // Dry mode is passed through, and is labelled as not entered.
  const dry = build((fields) => ({ results: fields.map((f) => ({ ...f, status: "wealth_row_missing_dry_run" })), setup: [] }), "dry");
  const dryRun = await dry.run();
  assert.equal(dry.seen.driverMode, "dry");
  const dryScope = merge(dryRun, "dry").result.handoffScope;
  assert.equal(dryScope.wealthStatement, "dry_run_only");
  assert.match(dryScope.label, /nothing entered/);

  // A thrown driver error holds the rows and says so; it never crashes the handoff.
  const boom = build(() => { throw new Error("kaboom"); }, "live");
  const boomRun = await boom.run();
  assert.equal(boomRun.paused, true);
  assert.ok(boomRun.executionLog.some((e) => e.step === "real_autofill_wealth_error"));
  assert.ok(boomRun.result.wealthPrepared.every((f) => f.setupStatus === "driver_error"));
});

test("wealth driver: the job guard accepts a CNIC written with dashes/spaces (regression: 'target changed' stopped every wealth row)", async () => {
  const packet = {
    filingPacket: {
      taxYear: 2026,
      snapshot: { portalFieldMap: [{ irisCode: "1009", column: "Total Amount", value: "1000", sourceGroup: "incomeFields" }, { key: "7051:wealthFields:Amount", irisCode: "7051", column: "Amount", value: "960000", label: "Rent", sourceGroup: "wealthFields" }] },
    },
  };
  const tour = { complete: true, sections: [{ id: "salary", rows: [{ code: "1009" }], mappingVerified: true, status: "captured", transition: "structure_changed" }] };
  for (const reference of ["42201-1234567-1", " 42201 1234567 1 ", "4220112345671"]) {
    let guardCalls = 0;
    const ctx = sandbox(["runRealIrisAutofill", "ensureNavigationJobActive"], {
      getApiBaseUrl: () => "http://web.test",
      loadAgentState: () => ({ deviceAuthToken: "t" }),
      fetch: async () => ({ ok: true, json: async () => ({ ok: true, job: { status: "running", expired: false } }) }),
      AbortSignal: { timeout: () => undefined },
      encodeURIComponent,
      updateLocalJobStatus: async () => {},
      ensureWorkerWindow: async () => ({ isDestroyed: () => false, webContents: { executeJavaScript: async () => ({ returnWorkspace: true, inputs: 12 }) } }),
      launchState: { accountReference: reference, deviceAuthToken: "t" },
      activeJobExecutionLog: null,
      pushStatus: () => {},
      captureWindowScreenshot: async () => null,
      lastSectionTour: tour,
      getWealthAutofillEnabled: () => true,
      irisNavigation: { ...navigation, navigateToSection: async () => ({ ok: true, status: "switched" }) },
      irisWealthDriver: {
        WEALTH_STATUS: { SETUP_FAILED: "wealth_setup_failed" },
        runWealthDriverStepwise: async (_w, fields, options) => {
          await options.beforeStep(); // throws NAVIGATION_TARGET_CHANGED if the identifier is not normalised
          guardCalls += 1;
          return { results: fields.map((f) => ({ ...f, status: "filled" })), setup: [] };
        },
      },
      irisRowFiller: {
        FILL_STATUS: {}, SUCCESS_STATUSES: new Set(["filled", "already_correct"]),
        summarise: (r) => ({ total: r.length, filled: r.filter((x) => x.status === "filled").length, skipped: r.filter((x) => x.status !== "filled").length }),
        describeFillSummary: () => "summary", snapshotIrisRows: async () => [], findUnexpectedPrefill: () => [],
        fillIrisRows: async (_w, fields) => ({ results: fields.map((f) => ({ ...f, status: "filled" })), summary: {} }),
      },
    });
    const run = await ctx.runRealIrisAutofill(packet, { id: "job-1" }, "live");
    assert.equal(guardCalls, 1, `guard passed for ${JSON.stringify(reference)}`);
    assert.ok(!run.executionLog.some((e) => e.step === "real_autofill_wealth_error"), `no wealth error for ${JSON.stringify(reference)}`);
  }
});

test("wealth driver switch: only explicit on-values enable it", () => {
  const read = (value) =>
    sandbox(["getWealthAutofillEnabled"], { process: { env: { TAXROCKET_WEALTH_AUTOFILL: value } } }).getWealthAutofillEnabled();
  for (const on of ["on", "1", "true", "YES", " live "]) assert.equal(read(on), true, on);
  for (const off of ["", "off", "0", "dry", "maybe", undefined]) assert.equal(read(off), false, String(off));
});

test("wealth driver: every file the agent needs is packaged and the three stamps agree", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "electron-connect", "package.json"), "utf8"));
  assert.ok(pkg.build.files.includes("iris-wealth-driver.js"), "the driver must ship in the installer");
  const driverTag = require("../electron-connect/iris-wealth-driver.js").BUILD_TAG;
  assert.equal(driverTag, navigation.BUILD_TAG);
  assert.equal(driverTag, require("../electron-connect/iris-row-filler.js").BUILD_TAG);
  assert.ok(mainSource.includes(`AGENT_BUILD_TAG = "${driverTag}"`));
});

test("P3.2: real-portal readiness never falls through to the mock-era selector chain", () => {
  assert.match(
    mainSource,
    /if \(realPortalMode\) \{[\s\S]{0,700}?return \{\s*steps: iris2\.steps,\s*formReady: false,/,
    "the real-portal branch must return, not fall through",
  );
  assert.ok(
    !/Fall through to the legacy chain/.test(mainSource),
    "the old fall-through comment/behaviour is gone",
  );
});

test("P4.4: mapping gaps ride from the packet to the approval screen", () => {
  const action = fs
    .readFileSync(path.join(__dirname, "../app/actions/packet.ts"), "utf8")
    .replace(/\s+/g, " ");
  assert.match(
    action,
    /const mappingGaps = \(snapshot\.portalFieldMap && snapshot\.portalFieldMap\.mappingGaps\) \|\| null;/,
    "generate must read the gaps off the snapshot it just built",
  );
  assert.match(
    action,
    /packet: \{ \.\.\.serializePacketMoney\(packet\), mappingGaps, coverage, businessCoverage: businessCoverageSummary\(businessSnapshot\), \}/,
    "generate must return the gaps and the coverage verdict with them",
  );
  // The override only means anything if the record of it travels with the packet.
  assert.match(
    action,
    /const coverage = businessSnapshot \? \{ \.\.\.coverageGate\.coverage, mode: "partial_manual_entry_required" as const, acceptedByOperator: options\?\.acceptUnmappedPortalSources === true, unmappedSources: coverageGate\.blocked, businessCoverage: businessSnapshot\.coverage, businessPending: businessSnapshot\.pending, \} : coverageGate\.coverage;/,
    "nonbusiness retains the gate verdict, while business explicitly records partial coverage and the same blocked amounts",
  );
  assert.match(
    action,
    /mappingGaps = snapshot\.portalFieldMap\?\.mappingGaps \?\? null;/,
    "fetch must re-read them from the stored snapshot",
  );

  const config = fs
    .readFileSync(
      path.join(__dirname, "../components/tax/filing/config/filing-wizard-config.ts"),
      "utf8",
    )
    .replace(/\s+/g, " ");
  assert.match(config, /mappingGaps\?: PortalMappingGaps \| null;/, "summary type carries the gaps");

  const step = fs
    .readFileSync(path.join(__dirname, "../components/tax/filing/wizard-packet-step.tsx"), "utf8")
    .replace(/\s+/g, " ");
  assert.match(step, /<PortalMappingGapNotice gaps=\{filingPacket\?\.mappingGaps\} \/>/);
  assert.match(step, /Manual entry still required/);
});

test("P3.4: autofill holds when the return workspace cannot be proven", async () => {
  let fillCalls = 0;
  let sectionVisits = 0;
  const probes = [];
  const ctx = sandbox(["runRealIrisAutofill"], {
    ensureWorkerWindow: async () => ({
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: async (script) => {
          probes.push(String(script));
          return { returnWorkspace: false, reason: "app-nitr-workflow-absent" };
        },
      },
    }),
    launchState: { accountReference: "1234567890123" },
    activeJobExecutionLog: null,
    pushStatus: () => {},
    captureWindowScreenshot: async () => null,
    lastSectionTour: tourFixture,
    irisNavigation: {
      ...navigation,
      navigateToSection: async () => {
        sectionVisits += 1;
        return { ok: true, status: "switched" };
      },
    },
    irisRowFiller: {
      FILL_STATUS: { FILLED: "filled", ROW_NOT_FOUND: "row_not_found" },
      summarise: (results) => ({ total: results.length, filled: 0, skipped: results.length }),
      describeFillSummary: () => "summary",
      SUCCESS_STATUSES: new Set(["filled", "already_correct"]),
      snapshotIrisRows: async () => [],
      findUnexpectedPrefill: () => [],
      fillIrisRows: async () => {
        fillCalls += 1;
        return { results: [], summary: {} };
      },
    },
  });

  const held = await ctx.runRealIrisAutofill(
    {
      filingPacket: {
        taxYear: 2026,
        snapshot: {
          portalFieldMap: [
            { irisCode: "1009", column: "Total Amount", value: "1000" },
          ],
        },
      },
    },
    { id: "job-1" },
    "dry",
  );

  assert.equal(held.paused, true);
  assert.equal(held.pauseAction, "portal_state_confirmation");
  assert.equal(fillCalls, 0, "nothing may be written into an unproven page");
  assert.equal(sectionVisits, 0, "the section tour is pointless off the return");
  assert.ok(
    probes.length === 1 && /app-nitr-workflow/.test(probes[0]),
    "the shared RETURN_WORKSPACE_PROBE is what decided this",
  );
  assert.match(
    held.executionLog.map((entry) => entry.detail).join(" "),
    /nothing was filled and no section tour was attempted/,
  );

  // The flow must turn that hold into a job the operator can act on, not a
  // "completed" run that filled nothing.
  const statuses = [];
  const flowCtx = sandbox(
    [
      "runLocalTaxAssistedFilingFlow",
      "finishNavigationOnly",
      "resolveAutofillMode",
      "getRealAutofillMode",
    ],
    {
      process: { env: { TAXROCKET_REAL_AUTOFILL: "live" } },
      realPortalMode: true,
      updateLocalJobStatus: async (_id, status) => statuses.push(status),
      runLocalIrisNavigationCheck: async () => ({ paused: false, executionLog: [], result: {} }),
      runRealIrisAutofill: async () => ({
        paused: true,
        pauseAction: "portal_state_confirmation",
        pauseMessage: "Return workspace not proven.",
        executionLog: [],
        result: {},
      }),
    },
  );
  const flowOut = await flowCtx.runLocalTaxAssistedFilingFlow({}, { id: "job-1" });
  assert.equal(flowOut.paused, true);
  assert.deepEqual(statuses, ["awaiting_user_action"], "the hold is recorded, not swallowed");
});

// The dialog from the operator's screenshot, reproduced structurally: Material
// renders field captions as <mat-label> (never a bare <label>), the Person box is
// disabled, Tax Period is already filled by IRIS, and the dialog sits on its own
// overlay backdrop. Every one of those facts defeated a different guard.
const returnSetupDialog = ({ period = "2026", filled = true, extra = "" } = {}) =>
  `
<div class="modal-backdrop" id="backdrop"></div>
<section role="dialog" class="mat-mdc-dialog-container">
<h2 class="mdc-dialog__title">Normal Return (Ind/AOP/COY)</h2>
<div class="mat-mdc-form-field"><mat-label>Person</mat-label>
<input class="mdc-text-field__input" value="4220144218163" disabled></div>
<div class="mat-mdc-form-field"><mat-label>Tax Period</mat-label>
<input class="mdc-text-field__input" id="period" value="${filled ? period : ""}"></div>
${extra}
<button onclick="actions.push('CANCEL')">Cancel</button>
<button onclick="actions.push('CONTINUE')">Continue</button>
</section>`;

const setupProbeOptions = {
  taxYear: 2026,
  taxpayerIdentifier: "4220144218163",
  openReturn: true,
};

test("a prefilled TY2026 new-return dialog is recognised as a setup stage", async () => {
  await withPage(dashboard(returnSetupDialog()), async (page, win) => {
    const frame = (await navigation.probeFrames(win, { taxYear: 2026 })).frames[0];
    assert.equal(
      frame.newReturnSetup.prompts.includes("Tax Period"),
      true,
      "the caption must reach the classifier at all",
    );
    assert.equal(frame.setupDialogOnly, true, "one recognised setup dialog, nothing else");
    // Conservative for everyone else: the overlay is still reported as blocking.
    assert.equal(frame.hasBlockingOverlay, true);
  });
});

test("after the period Continue the agent waits for IRIS to finish loading instead of pausing", async () => {
  // Real run: right after the click IRIS swapped the routed page and the shell
  // read as unauthenticated for a moment, which paused the run with
  // "FBR is still loading".
  const gateBody = gate().split("<body>")[1].split("<script>")[0];
  const html = dashboard(returnSetupDialog())
    .replace("onclick=\"actions.push('CONTINUE')\"", "onclick=\"actions.push('CONTINUE');window.swap()\"")
    .replace(
      "</body>",
      `<script>window.swap=()=>{document.body.innerHTML='<p>Loading</p>';setTimeout(()=>{document.body.innerHTML=${JSON.stringify(gateBody)}},1500)}</script></body>`,
    );
  await withPage(html, async (page, win) => {
    const result = await navigation.inspectNavigation(win, {
      taxYear: 2026,
      openReturn: true,
      taxpayerIdentifier: "4220144218163",
      state: { newEntryOpened: true },
      onStep: () => {},
    });
    assert.deepEqual(await page.evaluate("actions"), ["CONTINUE"]);
    assert.equal(result.requiredAction, "portal_economic_transactions_gate");
  });
});

test("the agent advances the setup dialog by clicking Continue", async () => {
  await withPage(dashboard(returnSetupDialog()), async (page, win) => {
    const frame = (
      await navigation.probeFrames(win, {
        ...setupProbeOptions,
        action: "new-return-continue",
      })
    ).frames[0];
    assert.equal(
      frame.actionResult.status,
      "clicked",
      "the dialog's own backdrop must not deadlock its Continue button",
    );
    assert.deepEqual(await page.evaluate("actions"), ["CONTINUE"]);
  });
});

test("a period suggestion panel cannot block the recognised setup Continue", async () => {
  await withPage(
    dashboard(
      returnSetupDialog({
        extra: `<div style="position:fixed;inset:0;z-index:40;background:transparent"></div>`,
      }),
    ),
    async (page, win) => {
      const frame = (
        await navigation.probeFrames(win, {
          ...setupProbeOptions,
          action: "new-return-continue",
        })
      ).frames[0];
      assert.equal(frame.actionResult.status, "clicked");
      assert.deepEqual(await page.evaluate("actions"), ["CONTINUE"]);
    },
  );
});

test("a setup dialog with a box left empty is not advanced", async () => {
  await withPage(
    dashboard(returnSetupDialog({ filled: false })),
    async (page, win) => {
      const frame = (
        await navigation.probeFrames(win, {
          ...setupProbeOptions,
          action: "new-return-continue",
        })
      ).frames[0];
      assert.equal(frame.setupDialogOnly, false, "an empty field is a human question");
      assert.equal(frame.actionResult.status, "blocked_by_dialog");
      assert.deepEqual(await page.evaluate("actions"), []);
    },
  );
});

test("a setup dialog naming a different tax year is not advanced", async () => {
  await withPage(
    dashboard(returnSetupDialog({ period: "2025" })),
    async (page, win) => {
      const frame = (
        await navigation.probeFrames(win, {
          ...setupProbeOptions,
          action: "new-return-continue",
        })
      ).frames[0];
      assert.equal(
        frame.actionResult.status,
        "blocked_by_dialog",
        "opening 2025 instead of the packet's 2026 would file the wrong return",
      );
      assert.deepEqual(await page.evaluate("actions"), []);
    },
  );
});

test("verification dialogs keep blocking even beside a recognised setup caption", async () => {
  await withPage(
    dashboard(returnSetupDialog({ extra: `<input type="password" value="x">` })),
    async (page, win) => {
      const frame = (
        await navigation.probeFrames(win, {
          ...setupProbeOptions,
          action: "new-return-continue",
        })
      ).frames[0];
      assert.equal(frame.setupDialogOnly, false);
      assert.equal(frame.actionResult.status, "blocked_by_dialog");
      assert.deepEqual(await page.evaluate("actions"), []);
    },
  );
});

test("handoff scope never reports a Salary-only handoff as ready to submit", () => {
  const ctx = sandbox([
    "mergeNavigationAutofillOutcome",
    "buildHandoffScopeSummary",
  ]);
  const merged = ctx.mergeNavigationAutofillOutcome(
    { paused: false, result: {}, executionLog: [] },
    { paused: false, result: {}, executionLog: [], },
    "live",
  );
  assert.equal(merged.result.handoffScope.readyToSubmit, false);
  assert.equal(merged.result.handoffScope.wealthStatement, "pending");
  const ok = ctx.mergeNavigationAutofillOutcome(
    { paused: false, result: {}, executionLog: [] },
    { paused: false, result: { summary: { total: 5, filled: 5, skipped: 0 } }, executionLog: [] },
    "live",
  );
  assert.equal(ok.result.handoffScope.salary, "filled");
  assert.match(ok.result.handoffScope.label, /Wealth .* pending/);
  assert.match(ok.result.handoffScope.label, /submit it yourself/);
  const review = ctx.mergeNavigationAutofillOutcome(
    { paused: false, result: {}, executionLog: [] },
    { paused: true, result: { summary: { total: 5, filled: 4, skipped: 1 } }, executionLog: [] },
    "live",
  );
  assert.equal(review.result.handoffScope.salary, "needs_review");
});

// ───────────────────────────────────────────────────────────────
// Direct completion after a clean live fill; legacy review resume retained (2026-10-14)
// ───────────────────────────────────────────────────────────────

function handoffReviewCtx(visited, fillStatus = "filled", extras = {}) {
  const tour = {
    complete: true,
    sections: [
      {
        id: "salary",
        rows: [{ code: "1009" }],
        mappingVerified: true,
        status: "captured",
        transition: "structure_changed",
      },
    ],
  };
  return sandbox(["runRealIrisAutofill"], {
    ensureWorkerWindow: async () => ({
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: async () => ({ returnWorkspace: true, inputs: 12 }),
      },
    }),
    launchState: { accountReference: "1234567890123" },
    activeJobExecutionLog: null,
    pushStatus: () => {},
    captureWindowScreenshot: async () => null,
    lastSectionTour: tour,
    irisNavigation: {
      ...navigation,
      waitForBusinessSectionReady: async () => ({ ok: true, status: "business_section_ready" }),
      navigateToSection: async (_win, { sectionId }) => {
        visited.push(sectionId);
        return { ok: true, status: "switched" };
      },
    },
    irisRowFiller: {
      FILL_STATUS: {
        FILLED: "filled",
        ROW_NOT_FOUND: "row_not_found",
        OVERWRITE_NEEDS_CONFIRMATION: "overwrite_needs_confirmation",
        ALREADY_CORRECT: "already_correct",
      },
      summarise: (results) => ({
        total: results.length,
        filled: results.filter((r) => ["filled", "already_correct"].includes(r.status)).length,
        skipped: results.filter((r) => !["filled", "already_correct"].includes(r.status)).length,
      }),
      describeFillSummary: () => "summary",
      SUCCESS_STATUSES: new Set(["filled", "already_correct"]),
      snapshotIrisRows: async () => [],
      findUnexpectedPrefill: () => [],
      fillIrisRows: async (_win, fields) => {
        visited.push("fill_rows");
        return {
          results: fields.map((f) => ({ ...f, status: fillStatus })),
          summary: {},
        };
      },
    },
    ...extras,
  });
}

const handoffPacket = (extra = {}) => ({
  filingPacket: {
    taxYear: 2026,
    snapshot: { portalFieldMap: [{ irisCode: "1009", column: "Total Amount", value: "1000" }] },
  },
  ...extra,
});

test("handoff completion: clean live entry finishes without a checkbox, review tour or extra Continue", async () => {
  const visited = [];
  const outcome = await handoffReviewCtx(visited).runRealIrisAutofill(
    handoffPacket(),
    { id: "job-1", type: "tax_assisted_filing" },
    "live",
  );
  assert.ok(visited.includes("fill_rows"));
  assert.ok(!visited.some((step) => ["wealth_assets", "payment", "computations"].includes(step)));
  assert.equal(outcome.paused, false);
  assert.equal(outcome.pauseAction, null);
  assert.equal(outcome.pauseMessage, null);
  assert.equal(outcome.result.reviewRequired, false);
  assert.equal(outcome.result.handoffReviewConfirmed, false, "never invent a taxpayer review");
  assert.ok(outcome.executionLog.some((entry) => entry.step === "autofill_handoff_complete"));
  const merged = sandbox(["mergeNavigationAutofillOutcome", "buildHandoffScopeSummary"]).mergeNavigationAutofillOutcome(
    { paused: false, executionLog: [], result: {} }, outcome, "live",
  );
  assert.equal(merged.paused, false);
  assert.equal(merged.pauseAction, null);
  assert.equal(merged.result.submitted, false);
  assert.notEqual(merged.result.requiredAction, "portal_handoff_review");
  assert.equal(merged.result.handoffScope.propertyPaymentsComputations, "pending");
  assert.equal(merged.result.handoffScope.readyToSubmit, false);
});

test("handoff review: once the taxpayer confirmed, the resumed run finishes without touring or pausing again", async () => {
  const visited = [];
  const outcome = await handoffReviewCtx(visited).runRealIrisAutofill(
    handoffPacket({
      livePilotState: {
        phase: "start",
        confirmations: [{ action: "portal_handoff_review", confirmedAt: "2026-10-01T00:00:00Z" }],
      },
    }),
    { id: "job-1", type: "tax_assisted_filing" },
    "live",
  );
  assert.equal(outcome.paused, false);
  assert.equal(outcome.pauseAction, null);
  assert.equal(outcome.result.handoffReviewConfirmed, true);
  assert.ok(!visited.includes("payment"), "no review tour after confirmation");
});

test("handoff review: not raised for a dry run, a job that is not assisted filing, or a fill that needs review", async () => {
  for (const [type, mode, status] of [
    ["tax_assisted_filing", "dry", "filled"],
    ["tax_dry_run", "live", "filled"],
    ["tax_assisted_filing", "live", "overwrite_needs_confirmation"],
  ]) {
    const visited = [];
    const outcome = await handoffReviewCtx(visited, status).runRealIrisAutofill(
      handoffPacket(),
      { id: "job-1", type },
      mode,
    );
    assert.ok(!visited.includes("payment"), `${type}/${mode}/${status} must not tour`);
    assert.notEqual(outcome.pauseAction, "portal_handoff_review");
  }
});

test("handoff completion: missing Payment/Computations review tabs do not create a new gate", async () => {
  const visited = [];
  const ctx = handoffReviewCtx(visited);
  ctx.irisNavigation = {
    ...navigation,
    navigateToSection: async (_win, { sectionId }) => {
      visited.push(sectionId);
      if (["wealth_assets", "payment", "computations"].includes(sectionId)) {
        throw new Error("Clean completion must not attempt the old review tour");
      }
      return { ok: true, status: "switched" };
    },
  };
  const outcome = await ctx.runRealIrisAutofill(
    handoffPacket(), { id: "job-1", type: "tax_assisted_filing" }, "live",
  );
  assert.equal(outcome.paused, false);
  assert.equal(outcome.pauseAction, null);
  assert.equal(outcome.result.handoffReviewConfirmed, false);
  assert.ok(!outcome.executionLog.some((entry) => entry.step.startsWith("handoff_review_")));
});

test("handoff completion: invalid or conflicting fields still pause for actual correction", async () => {
  for (const status of ["row_not_found", "overwrite_needs_confirmation"]) {
    const visited = [];
    const outcome = await handoffReviewCtx(visited, status).runRealIrisAutofill(
      handoffPacket(), { id: "job-1", type: "tax_assisted_filing" }, "live",
    );
    assert.equal(outcome.paused, true, status);
    assert.equal(outcome.pauseAction, "portal_autofill_review", status);
    assert.ok(outcome.pauseMessage);
    assert.ok(!outcome.executionLog.some((entry) => entry.step === "autofill_handoff_complete"));
    assert.equal(outcome.result.handoffReviewConfirmed, false);
  }
});

test("handoff scope reports the taxpayer review only when it was confirmed, and never claims ready to submit", () => {
  const ctx = sandbox(["mergeNavigationAutofillOutcome", "buildHandoffScopeSummary"], {});
  const run = (confirmed) =>
    ctx.mergeNavigationAutofillOutcome(
      { executionLog: [], result: {} },
      {
        paused: false,
        executionLog: [],
        result: {
          summary: { total: 8, filled: 8, skipped: 0 },
          salarySummary: { total: 2, filled: 2, skipped: 0 },
          wealthPrepared: [{}, {}],
          wealth: { enabled: true, mode: "live", summary: { total: 6, filled: 6 } },
          handoffReviewConfirmed: confirmed,
        },
      },
      "live",
    ).result.handoffScope;
  assert.equal(run(true).propertyPaymentsComputations, "reviewed_by_taxpayer");
  assert.equal(run(false).propertyPaymentsComputations, "pending");
  assert.equal(run(true).readyToSubmit, false);
  assert.match(run(true).label, /reviewed by the taxpayer/);
  assert.doesNotMatch(run(false).label, /reviewed by the taxpayer/);
});

// ── Employer Details step ──────────────────────────────────────────────────
const employerPacket = (employers, extra = {}) => ({
  filingPacket: {
    taxYear: 2026,
    snapshot: {
      portalFieldMap: [{ irisCode: "1009", column: "Total Amount", value: "1000" }],
      portalFieldMapDetailed: { employers },
    },
  },
  ...extra,
});
const realEmployerDriver = require("../electron-connect/iris-employer-driver.js");
const employerCtx = (visited, runEmployerDriver, { enabled = true } = {}) =>
  handoffReviewCtx(visited, "filled", {
    getEmployerAutofillEnabled: () => enabled,
    ensureNavigationJobActive: async () => {},
    irisEmployerDriver: { ...realEmployerDriver, runEmployerDriver },
  });
const okEmployers = (visited) => async (_win, names, options) => {
  visited.push("employers");
  await options.navigate("salary");
  await options.beforeStep();
  return {
    results: names.map((name) => ({ name, status: "added" })),
    setup: [],
  };
};

test("employers: added through the driver BEFORE the salary figures, in live mode, by name", async () => {
  const visited = [];
  let seen = null;
  const ctx = employerCtx(visited, async (win, names, options) => {
    seen = { names, mode: options.mode };
    return okEmployers(visited)(win, names, options);
  });
  const outcome = await ctx.runRealIrisAutofill(
    employerPacket(["SYSTEMS LIMITED", " systems  limited ", "BETA CORP"]),
    { id: "job-1", type: "tax_assisted_filing" },
    "live",
  );
  assert.deepEqual(seen, { names: ["SYSTEMS LIMITED", "BETA CORP"], mode: "live" });
  assert.ok(visited.indexOf("employers") < visited.indexOf("fill_rows"), `order: ${visited}`);
  assert.equal(outcome.result.employers.summary.ok, 2);
  assert.equal(outcome.result.reviewRequired, false);
  // A clean employer + salary fill completes with no final checkbox/Continue.
  assert.equal(outcome.paused, false);
  assert.equal(outcome.pauseAction, null);
  assert.equal(outcome.result.handoffReviewConfirmed, false);
});

test("employers: one that cannot be added stops the run at once - nothing else is entered - and asks the taxpayer to add it", async () => {
  const visited = [];
  const ctx = employerCtx(visited, async (_win, names) => {
    visited.push("employers");
    return {
      results: names.map((name) => ({
        name,
        status: "employer_no_exact_match",
        candidates: ["SYSTEMS PVT | 1"],
      })),
      setup: [],
    };
  });
  const outcome = await ctx.runRealIrisAutofill(
    employerPacket(["SYSTEMS LIMITED"]),
    { id: "job-1", type: "tax_assisted_filing" },
    "live",
  );
  assert.ok(!visited.includes("fill_rows"), "no salary figure is entered before the employer is settled");
  assert.ok(!visited.includes("payment"), "no review tour while an employer is open");
  assert.equal(outcome.paused, true);
  assert.equal(outcome.pauseAction, "portal_employer_review");
  assert.match(outcome.pauseMessage, /Employer details need you/);
  assert.match(outcome.pauseMessage, /not an exact match/);
  assert.match(outcome.pauseMessage, /SYSTEMS PVT \| 1/);
  assert.match(outcome.pauseMessage, /I have added the employer in FBR/);
  assert.match(outcome.pauseMessage, /have not been entered yet/);
  assert.match(outcome.pauseMessage, /Nothing was saved, submitted, calculated, or paid/);
  assert.equal(outcome.result.reviewRequired, true);
  assert.equal(outcome.result.employers.summary.needsReview, 1);
  // The merged job result keeps the employer action so Continue records it.
  const merged = sandbox(["mergeNavigationAutofillOutcome", "buildHandoffScopeSummary"]).mergeNavigationAutofillOutcome(
    { paused: false, result: {}, executionLog: [] },
    outcome,
    "live",
  );
  assert.equal(merged.pauseAction, "portal_employer_review");
  assert.equal(merged.result.requiredAction, "portal_employer_review");
  assert.equal(merged.result.handoffScope.employers, "needs_review");
  assert.equal(merged.result.handoffScope.salary, "not_entered");
});

test("employers: after the taxpayer confirmed, the resumed run does not search or pause on employers again and enters the figures", async () => {
  const visited = [];
  const ctx = employerCtx(visited, okEmployers(visited));
  const outcome = await ctx.runRealIrisAutofill(
    employerPacket(["HASEEB KHAN"], {
      livePilotState: {
        phase: "start",
        confirmations: [{ action: "portal_employer_review", confirmedAt: "2026-10-02T05:00:00Z" }],
      },
    }),
    { id: "job-1", type: "tax_assisted_filing" },
    "live",
  );
  assert.ok(!visited.includes("employers"), "the employer driver is not run again");
  assert.ok(visited.includes("fill_rows"), "the figures are entered");
  assert.notEqual(outcome.pauseAction, "portal_employer_review");
  assert.equal(outcome.paused, false);
  assert.equal(outcome.pauseAction, null, "no redundant review gate after the employer problem is resolved");
  assert.equal(outcome.result.handoffReviewConfirmed, false);
  assert.equal(outcome.result.employers.confirmedByTaxpayer, true);
  assert.ok(outcome.executionLog.some((e) => e.step === "real_autofill_employer_confirmed"));
  const scope = sandbox(["mergeNavigationAutofillOutcome", "buildHandoffScopeSummary"]).mergeNavigationAutofillOutcome(
    { paused: false, result: {}, executionLog: [] },
    outcome,
    "live",
  ).result.handoffScope;
  assert.equal(scope.employers, "confirmed_by_taxpayer");
  assert.match(scope.label, /Employers .* added by the taxpayer in FBR/);
});

test("employers: a confirmation for another pause (the review hand-off) does not skip the employer step", async () => {
  const visited = [];
  const ctx = employerCtx(visited, okEmployers(visited));
  await ctx.runRealIrisAutofill(
    employerPacket(["SYSTEMS LIMITED"], {
      livePilotState: { phase: "start", confirmations: [{ action: "portal_handoff_review" }] },
    }),
    { id: "job-1", type: "tax_assisted_filing" },
    "live",
  );
  assert.ok(visited.includes("employers"));
});

test("employers: switched off, the driver is not run and the log says they were not added", async () => {
  const visited = [];
  const ctx = employerCtx(visited, okEmployers(visited), { enabled: false });
  const outcome = await ctx.runRealIrisAutofill(
    employerPacket(["SYSTEMS LIMITED"]),
    { id: "job-1", type: "tax_assisted_filing" },
    "live",
  );
  assert.ok(!visited.includes("employers"));
  assert.ok(
    outcome.executionLog.some(
      (entry) => entry.step === "real_autofill_employer_prepared" && /NOT added/.test(entry.detail),
    ),
  );
  assert.equal(outcome.result.employers.enabled, false);
  assert.deepEqual(outcome.result.employers.prepared, ["SYSTEMS LIMITED"]);
});

test("employers: a packet with none never touches the Salary page for them", async () => {
  const visited = [];
  const ctx = employerCtx(visited, okEmployers(visited));
  const outcome = await ctx.runRealIrisAutofill(
    employerPacket(undefined),
    { id: "job-1", type: "tax_assisted_filing" },
    "live",
  );
  assert.ok(!visited.includes("employers"));
  assert.equal(outcome.result.employers.summary, null);
});

test("employers: a driver crash pauses for review instead of failing the run", async () => {
  const visited = [];
  const ctx = employerCtx(visited, async () => {
    throw new Error("boom");
  });
  const outcome = await ctx.runRealIrisAutofill(
    employerPacket(["SYSTEMS LIMITED"]),
    { id: "job-1", type: "tax_assisted_filing" },
    "live",
  );
  assert.equal(outcome.pauseAction, "portal_employer_review");
  assert.match(outcome.pauseMessage, /driver_error/);
  assert.ok(outcome.executionLog.some((e) => e.step === "real_autofill_employer_error"));
});

test("employers: dry mode passes mode=dry and would-add is not a review item", async () => {
  const visited = [];
  let mode = null;
  const ctx = employerCtx(visited, async (_win, names, options) => {
    mode = options.mode;
    return { results: names.map((name) => ({ name, status: "would_add_dry_run" })), setup: [] };
  });
  const outcome = await ctx.runRealIrisAutofill(
    employerPacket(["SYSTEMS LIMITED"]),
    { id: "job-1", type: "tax_assisted_filing" },
    "dry",
  );
  assert.equal(mode, "dry");
  assert.equal(outcome.result.reviewRequired, false);
});

test("handoff scope reports employers truthfully and never claims ready to submit", () => {
  const ctx = sandbox(["mergeNavigationAutofillOutcome", "buildHandoffScopeSummary"], {});
  const scope = (employers) =>
    ctx.mergeNavigationAutofillOutcome(
      { paused: false, result: {}, executionLog: [] },
      { paused: false, result: { summary: { total: 1, filled: 1, skipped: 0 }, employers } },
      "live",
    ).result.handoffScope;
  const listed = scope({ enabled: true, mode: "live", prepared: ["A", "B"], summary: { total: 2, ok: 2, needsReview: 0 } });
  assert.equal(listed.employers, "listed");
  assert.match(listed.label, /Employers .* 2\/2 listed/);
  assert.equal(scope({ enabled: true, mode: "live", prepared: ["A"], summary: { total: 1, ok: 0, needsReview: 1 } }).employers, "needs_review");
  assert.equal(scope({ enabled: false, mode: "live", prepared: ["A"], summary: null }).employers, "pending");
  assert.equal(scope({ enabled: true, mode: "dry", prepared: ["A"], summary: { total: 1, ok: 1, needsReview: 0 } }).employers, "dry_run_only");
  const none = scope({ enabled: true, mode: "live", prepared: [], summary: null });
  assert.equal(none.employers, "none");
  assert.doesNotMatch(none.label, /Employers/);
  assert.equal(listed.readyToSubmit, false);
});

test("job log file keeps the earlier runs of a resumed job, so one file shows why it paused", async () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "joblog-"));
  const ctx = sandbox(["writeJobLogToDisk"], {
    fs,
    path,
    __filename: "main.js",
    realPortalMode: true,
    AGENT_BUILD_TAG: "test-build",
    irisNavigation: { BUILD_TAG: "test-nav" },
    getAgentLogDir: () => dir,
    activeJobConfirmations: [
      {
        action: "portal_handoff_review",
        acknowledgedAt: "2026-10-02T05:40:00.000Z",
        acknowledgementText: "I confirm that I reviewed it.",
      },
    ],
    buildJobReport: require("../electron-connect/job-report.js").buildJobReport,
  });
  const job = { id: "job-xyz", type: "tax_assisted_filing" };
  await ctx.writeJobLogToDisk(job, {
    finalStatus: "paused",
    pauseAction: "portal_employer_review",
    pauseMessage: "Employer details need you",
    result: { big: "x".repeat(1000) },
    executionLog: [{ step: "real_autofill_employer_pause", detail: "d".repeat(900) }],
  });
  await ctx.writeJobLogToDisk(job, {
    finalStatus: "completed",
    result: {},
    executionLog: [{ step: "real_autofill_result", detail: "8/8" }],
  });
  const file = JSON.parse(fs.readFileSync(path.join(dir, "job-job-xyz.json"), "utf8"));
  assert.equal(file.finalStatus, "completed");
  assert.ok(Array.isArray(file.report) && file.report[0].startsWith("RUN COMPLETED"));
  assert.ok(file.report.join("\n").includes("I confirm that I reviewed it."));
  assert.equal(Object.keys(file)[0], "report", "the readable report comes first");
  assert.equal(file.previousRuns.length, 1);
  assert.ok(file.previousRuns[0].report[0].startsWith("RUN PAUSED"), "earlier runs keep their report");
  assert.equal(file.previousRuns[0].finalStatus, "paused");
  assert.equal(file.previousRuns[0].pauseAction, "portal_employer_review");
  assert.equal(file.previousRuns[0].pauseMessage, "Employer details need you");
  assert.equal(file.previousRuns[0].executionLog[0].detail.length, 600, "details are capped");
  assert.ok(!("result" in file.previousRuns[0]), "the heavy result is not copied");
  for (let i = 0; i < 12; i++) {
    await ctx.writeJobLogToDisk(job, { finalStatus: "paused", executionLog: [] });
  }
  const capped = JSON.parse(fs.readFileSync(path.join(dir, "latest-job.json"), "utf8"));
  assert.equal(capped.previousRuns.length, 8, "history is capped");
});

test("Phase 1.5b: a gate that renders AFTER the IRIS shell is waited for, not skipped", async () => {
  const shell = `<a id="homeLink" href="/dashboard">Home</a><nav><a>Declaration</a>
<a>Draft (Unsubmitted Documents)</a></nav><div id="slot"></div>`;
  const delayedGate = gate()
    .replace("<!doctype html><html><body>", "<!doctype html><html><body>" + shell)
    .replace(
      "<app-summary-economic-transactions>",
      "<template id=\"g\"><app-summary-economic-transactions>",
    )
    .replace(
      "</app-summary-economic-transactions>",
      "</app-summary-economic-transactions></template>",
    )
    .replace(
      "<script>window.actions=[]</script>",
      "<script>window.actions=[];setTimeout(()=>{document.querySelector('#slot').append(document.querySelector('#g').content.cloneNode(true))},1500)</script>",
    );
  await withPage(
    delayedGate,
    async (_page, win) => {
      const steps = [];
      const result = await navigation.inspectNavigation(win, {
        taxYear: 2026,
        openReturn: true,
        taxpayerIdentifier: "1234567890123",
        onStep: (step) => steps.push(step),
      });
      assert.ok(steps.includes("economic_gate_wait"), "the agent waited for the gate");
      assert.equal(result.requiredAction, "portal_economic_transactions_gate");
      assert.equal(result.economicTransactionsGate.ready, false);
    },
    { path: "/nitr/summary-economic-transactions" },
  );
});

// ───────────────────────────────────────────────────────────────
// After the taxpayer confirmed the review, the agent does not touch IRIS again
// ───────────────────────────────────────────────────────────────

const pausedReviewLog = () => ({
  finalStatus: "paused",
  pauseAction: "portal_handoff_review",
  executionLog: [{ step: "real_autofill_result", detail: "8/8 fields filled", at: "2026-10-03T04:22:55Z" }],
  result: {
    mode: "live_return_autofill",
    requiredAction: "portal_handoff_review",
    message: "review the rest",
    autofillSummary: { total: 8, filled: 8, skipped: 0 },
    submitted: false,
    autofill: {
      mode: "live",
      reviewRequired: false,
      message: "Live entry entered and verified 8/8 approved fields.",
      summary: { total: 8, filled: 8, skipped: 0 },
      salarySummary: { total: 2, filled: 2, skipped: 0 },
      wealth: { enabled: true, mode: "live", summary: { total: 6, filled: 6, skipped: 0 } },
      wealthPrepared: [1, 2, 3, 4, 5, 6].map((n) => ({ irisCode: String(7000 + n) })),
      employers: { enabled: true, mode: "live", prepared: ["A"], summary: { ok: 1, total: 1, needsReview: 0 } },
    },
  },
});

test("confirmed review: completes from the paused run's record, with the scope rebuilt as reviewed", () => {
  const ctx = sandbox(["buildConfirmedHandoffCompletion", "buildHandoffScopeSummary", "getHandoffReviewAction"]);
  const done = ctx.buildConfirmedHandoffCompletion(pausedReviewLog(), "2026-10-03T04:24:30Z");
  assert.equal(done.paused, false);
  assert.equal(done.pauseAction, null);
  assert.equal(done.result.submitted, false);
  assert.equal(done.result.resumedWithoutRerun, true);
  assert.equal(done.result.handoffScope.propertyPaymentsComputations, "reviewed_by_taxpayer");
  assert.equal(done.result.handoffScope.salary, "filled");
  assert.equal(done.result.handoffScope.wealthStatement, "entered_not_calculated");
  assert.equal(done.result.handoffScope.employers, "listed");
  assert.equal(done.result.handoffScope.readyToSubmit, false);
  assert.equal(done.result.autofill.handoffReviewConfirmed, true);
  assert.match(done.result.message, /did not touch the FBR window again/);
  assert.equal(done.executionLog.at(-1).step, "handoff_review_confirmed_no_rerun");
  assert.equal(done.executionLog[0].step, "real_autofill_result", "the earlier run's log stays in the report");
});

test("confirmed review: no completion unless the earlier run is proven to be a clean live fill that paused for this review", () => {
  const ctx = sandbox(["buildConfirmedHandoffCompletion", "buildHandoffScopeSummary", "getHandoffReviewAction"]);
  const f = (mutate) => {
    const log = pausedReviewLog();
    mutate(log);
    return ctx.buildConfirmedHandoffCompletion(log, "t");
  };
  assert.equal(ctx.buildConfirmedHandoffCompletion(null, "t"), null);
  assert.equal(f((l) => (l.finalStatus = "completed")), null);
  assert.equal(f((l) => (l.pauseAction = "portal_employer_review")), null);
  assert.equal(f((l) => (l.result.autofill.mode = "dry")), null);
  assert.equal(f((l) => (l.result.autofill.reviewRequired = true)), null);
  assert.equal(f((l) => delete l.result.autofill), null);
});

test("confirmed review: the resumed run never opens, navigates or fills the FBR window", async () => {
  let touched = 0;
  const statuses = [];
  const make = (saved) =>
    sandbox(
      [
        "runLocalTaxAssistedFilingFlow",
        "finishNavigationOnly",
        "resolveAutofillMode",
        "getRealAutofillMode",
      ],
      {
        process: { env: { TAXROCKET_REAL_AUTOFILL: "live" } },
        realPortalMode: true,
        pushStatus: (_kind, text) => statuses.push(text),
        readSavedJobLog: () => saved,
        updateLocalJobStatus: async () => {},
        runLocalIrisNavigationCheck: async () => {
          touched += 1;
          return { paused: false, executionLog: [], result: {} };
        },
        runRealIrisAutofill: async () => {
          touched += 1;
          return { paused: false, executionLog: [], result: {} };
        },
      },
    );
  const confirmed = {
    livePilotState: { confirmations: [{ action: "portal_handoff_review" }] },
  };
  const out = await make(pausedReviewLog()).runLocalTaxAssistedFilingFlow(confirmed, { id: "job-1" });
  assert.equal(out.paused, false);
  assert.equal(out.result.resumedWithoutRerun, true);
  assert.equal(touched, 0, "the window was not touched");
  assert.ok(statuses.some((s) => /without touching the FBR window/.test(s)));

  // No usable record of the earlier run: fall back to the normal (idempotent) flow.
  await make(null).runLocalTaxAssistedFilingFlow(confirmed, { id: "job-1" });
  assert.equal(touched, 2, "without a record the normal flow runs");

  // An unconfirmed job never takes the shortcut, even when a record exists.
  touched = 0;
  await make(pausedReviewLog()).runLocalTaxAssistedFilingFlow({}, { id: "job-1" });
  assert.equal(touched, 2);
});

// ───────────────────────────────────────────────────────────────
// Stop at the FIRST figure the agent cannot enter. The taxpayer enters it,
// ticks, presses Continue; the next run skips it and carries on.
// ───────────────────────────────────────────────────────────────

function stopHarness({ wealthOn = true, wealthStub, read = {} } = {}) {
  const tour = {
    complete: true,
    sections: [
      {
        id: "salary",
        rows: [{ code: "1009" }, { code: "1049" }],
        mappingVerified: true,
        status: "captured",
        transition: "structure_changed",
      },
    ],
  };
  const seen = { filled: [], read: [], wealthFields: null, wealthCalls: 0, wealthChecked: [] };
  const ok = new Set(["filled", "already_correct"]);
  const make = (failCode, extra = {}) =>
    sandbox(["runRealIrisAutofill"], {
      getWealthAutofillEnabled: () => wealthOn,
      buildAttentionReport: require("../electron-connect/job-report.js").buildAttentionReport,
      buildAttentionMessage: require("../electron-connect/job-report.js").buildAttentionMessage,
      buildFieldLog: require("../electron-connect/job-report.js").buildFieldLog,
      irisWealthDriver: {
        WEALTH_STATUS: { SETUP_FAILED: "wealth_setup_failed" },
        runWealthDriverStepwise: async (_w, fields, options) => {
          seen.wealthCalls += 1;
          seen.wealthFields = fields.map((f) => f.irisCode);
          if (wealthStub) return wealthStub(fields, options);
          return {
            results: fields.map((f) => {
              if (options.verifyOnly(f)) {
                seen.wealthChecked.push(f.irisCode);
                return options.checkEntry({ ...f, status: "already_correct", dryRun: true });
              }
              return { ...f, status: "filled" };
            }),
            setup: [],
            stopped: false,
            notAttempted: 0,
          };
        },
      },
      ensureNavigationJobActive: async () => {},
      ensureWorkerWindow: async () => ({
        isDestroyed: () => false,
        webContents: { executeJavaScript: async () => ({ returnWorkspace: true, inputs: 12 }) },
      }),
      launchState: { accountReference: "1234567890123" },
      activeJobExecutionLog: null,
      pushStatus: () => {},
      captureWindowScreenshot: async () => null,
      lastSectionTour: tour,
      irisNavigation: { ...navigation, navigateToSection: async () => ({ ok: true, status: "switched" }) },
      irisRowFiller: {
        FILL_STATUS: {
          FILLED: "filled",
          ROW_NOT_FOUND: "row_not_found",
          UNVERIFIED_TARGET: "unverified_target",
          OVERWRITE_NEEDS_CONFIRMATION: "overwrite_needs_confirmation",
          ALREADY_CORRECT: "already_correct",
        },
        SUCCESS_STATUSES: ok,
        summarise: (results) => ({
          total: results.length,
          filled: results.filter((r) => ok.has(r.status)).length,
          skipped: results.filter((r) => !ok.has(r.status)).length,
        }),
        describeFillSummary: () => "summary",
        snapshotIrisRows: async () => [],
        findUnexpectedPrefill: () => [],
        fillIrisRows: async (_win, fields, opts) => {
          (opts && opts.dryRun ? seen.read : seen.filled).push(...fields.map((f) => f.irisCode));
          return {
            results: fields.map((f) => {
              if (opts && opts.dryRun)
                return {
                  ...f,
                  status: "already_correct",
                  dryRun: true,
                  existingValue: f.value,
                  plannedValue: f.value,
                  ...(read[f.irisCode] || {}),
                };
              return { ...f, status: f.irisCode === failCode ? "row_not_found" : "filled" };
            }),
            summary: {},
          };
        },
      },
      ...extra,
    });
  const packet = (extra = {}) => ({
    ...extra,
    filingPacket: {
      taxYear: 2026,
      snapshot: {
        portalFieldMap: [
          { key: "1009:incomeFields:Total Amount", irisCode: "1009", column: "Total Amount", value: "1000", label: "Salary", sourceGroup: "incomeFields" },
          { key: "1049:incomeFields:Total Amount", irisCode: "1049", column: "Total Amount", value: "50", label: "Allowances", sourceGroup: "incomeFields" },
          { key: "7051:wealthFields:Amount", irisCode: "7051", column: "Amount", value: "960000", label: "Rent", sourceGroup: "wealthFields" },
        ],
      },
    },
  });
  return { make, packet, seen };
}

// Phase 1 (fix46) stop policy: a figure the agent cannot enter is recorded on
// that figure and the run carries on (only SAFETY/HUMAN conditions stop it).
test("fix46: a figure it cannot enter does not stop the run: later figures, including wealth, are still entered", async () => {
  const { make, packet, seen } = stopHarness();
  const run = await make("1009").runRealIrisAutofill(packet(), { id: "job-1" }, "live");
  assert.deepEqual(seen.filled, ["1009", "1049"], "the figure after the failed one was still attempted");
  assert.equal(seen.wealthCalls, 1, "wealth was still started");
  assert.deepEqual(seen.wealthFields, ["7051"]);
  assert.equal(run.paused, true);
  assert.equal(run.pauseAction, "portal_autofill_review");
  assert.equal(run.result.summary.total, 3);
  assert.equal(run.result.attention.items.length, 1, "only the failed figure needs the taxpayer");
  assert.equal(run.result.attention.remaining, 0, "nothing was left unattempted");
  assert.equal(run.result.attention.done, 2);
  assert.equal(run.result.attention.total, 3);
  assert.equal(run.result.stopped, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(run.result.pendingItems.map((i) => [i.key, i.kind]))),
    [["1009:incomeFields:Total Amount", "salary"]],
  );
  assert.ok(run.executionLog.some((e) => e.step === "real_autofill_field_problem" && /1009/.test(e.detail)));
  assert.ok(!run.executionLog.some((e) => e.step === "real_autofill_stopped"));
  const failed = run.result.fieldLog.find((f) => f.code === "1009");
  assert.equal(failed.outcome, "NOT_FOUND");
  assert.equal(failed.category, "STRUCTURE");
  assert.equal(run.result.fieldLog.find((f) => f.code === "1049").outcome, "TYPED");
});

test("a stop in the wealth statement reports only that figure; the earlier ones stay done", async () => {
  const { make, packet } = stopHarness({
    wealthStub: (fields) => ({
      results: fields.map((f) => ({ ...f, status: "wealth_setup_failed", setupStatus: "gift_donor_not_resolved" })),
      setup: [],
      stopped: true,
      notAttempted: 3,
    }),
  });
  const run = await make(null).runRealIrisAutofill(packet(), { id: "job-1" }, "live");
  assert.equal(run.paused, true);
  assert.equal(run.result.attention.items.length, 1);
  assert.equal(run.result.attention.done, 2, "both salary figures are in");
  assert.equal(run.result.pendingItems[0].kind, "wealth");
});

test("resume: figures the taxpayer entered are skipped (not checked), and the run carries on with the next figure", async () => {
  const { make, packet, seen } = stopHarness();
  const taken = [{ key: "1009:incomeFields:Total Amount", name: "Salary", kind: "salary" }];
  const run = await make("never").runRealIrisAutofill(
    packet({ acknowledgedAutofillItems: taken }),
    { id: "job-1" },
    "live",
  );
  assert.deepEqual(seen.filled, ["1049"], "the taken-over figure was not typed over");
  assert.deepEqual(seen.read, ["1009"], "it was only read back");
  assert.deepEqual(seen.wealthFields, ["7051"], "wealth carried on");
  assert.equal(run.paused, false);
  assert.equal(run.result.takenOver.length, 1);
  const scope = sandbox(["mergeNavigationAutofillOutcome", "buildHandoffScopeSummary"]).mergeNavigationAutofillOutcome(
    { paused: false, result: {}, executionLog: [] },
    run,
    "live",
  ).result.handoffScope;
  assert.equal(scope.salary, "confirmed_by_taxpayer");
  assert.deepEqual(Array.from(scope.manualItems), ["Salary"]);
  assert.equal(scope.readyToSubmit, false);
});

test("fix46 resume: a later problem is reported without stopping, and the earlier takeover is remembered", async () => {
  const { make, packet, seen } = stopHarness();
  const taken = [{ key: "1009:incomeFields:Total Amount", name: "Salary", kind: "salary" }];
  const run = await make("1049").runRealIrisAutofill(
    packet({ acknowledgedAutofillItems: taken }),
    { id: "job-1" },
    "live",
  );
  assert.equal(run.paused, true);
  assert.equal(run.result.takenOver.length, 1, "the first takeover is carried forward");
  assert.equal(seen.wealthCalls, 1, "wealth still ran after the salary problem");
  assert.equal(run.result.attention.done, 2, "the taken-over salary and the wealth figure are in");
  assert.equal(run.result.attention.remaining, 0);
  assert.equal(run.result.pendingItems.length, 1);
  assert.equal(run.result.pendingItems[0].key, "1049:incomeFields:Total Amount");
  // The next resume skips BOTH.
  const saved = {
    finalStatus: "paused",
    pauseAction: "portal_autofill_review",
    result: { autofill: run.result },
  };
  const ctx = sandbox(["collectAcknowledgedAutofillItems", "getAutofillReviewAction"]);
  assert.deepEqual(
    Array.from(ctx.collectAcknowledgedAutofillItems(JSON.parse(JSON.stringify(saved)))).map((i) => i.key),
    ["1009:incomeFields:Total Amount", "1049:incomeFields:Total Amount"],
  );
});

test("collecting taken-over items needs a proven earlier live pause for this review", () => {
  const ctx = sandbox(["collectAcknowledgedAutofillItems", "getAutofillReviewAction"]);
  const good = () => ({
    finalStatus: "paused",
    pauseAction: "portal_autofill_review",
    result: { autofill: { mode: "live", pendingItems: [{ key: "a", name: "A", kind: "wealth" }], takenOver: [{ key: "b", name: "B", kind: "salary" }] } },
  });
  assert.equal(ctx.collectAcknowledgedAutofillItems(good()).length, 2);
  const none = (mutate) => {
    const log = good();
    mutate(log);
    return ctx.collectAcknowledgedAutofillItems(log).length;
  };
  assert.equal(ctx.collectAcknowledgedAutofillItems(null).length, 0);
  assert.equal(none((l) => (l.finalStatus = "completed")), 0);
  assert.equal(none((l) => (l.pauseAction = "portal_handoff_review")), 0);
  assert.equal(none((l) => (l.result.autofill.mode = "dry")), 0);
  assert.equal(none((l) => delete l.result.autofill), 0);
});

test("item keys: the agent and the report agree on what identifies a figure", () => {
  const { buildAttentionReport } = require("../electron-connect/job-report.js");
  const ctx = sandbox(["autofillItemKey"]);
  const samples = [
    { key: "1009:incomeFields:Total Amount", irisCode: "1009", status: "row_not_found" },
    { irisCode: "7030", rowDescriptionIncludes: "PK36SCBL0000001123456702", status: "row_not_found" },
    { irisCode: "7012", status: "row_not_found" },
  ];
  for (const sample of samples) {
    const reportKey = buildAttentionReport([sample]).items[0].lines[0].key;
    assert.equal(ctx.autofillItemKey(sample), reportKey);
  }
});

test("Continue after the missing-items pause runs the normal fill with the taken-over list, not a shortcut", async () => {
  const seen = { context: null, navigated: 0 };
  const saved = {
    finalStatus: "paused",
    pauseAction: "portal_autofill_review",
    result: { autofill: { mode: "live", pendingItems: [{ key: "7037|g", name: "Gift", kind: "wealth" }], takenOver: [] } },
  };
  const ctx = sandbox(
    ["runLocalTaxAssistedFilingFlow", "finishNavigationOnly", "resolveAutofillMode", "getRealAutofillMode"],
    {
      process: { env: { TAXROCKET_REAL_AUTOFILL: "live" } },
      realPortalMode: true,
      pushStatus: () => {},
      readSavedJobLog: () => saved,
      updateLocalJobStatus: async () => {},
      runLocalIrisNavigationCheck: async () => {
        seen.navigated += 1;
        return { paused: false, executionLog: [], result: {} };
      },
      runRealIrisAutofill: async (context) => {
        seen.context = context;
        return { paused: false, executionLog: [], result: { summary: { total: 1, filled: 1, skipped: 0 } } };
      },
    },
  );
  const confirmed = { livePilotState: { confirmations: [{ action: "portal_autofill_review" }] } };
  await ctx.runLocalTaxAssistedFilingFlow(confirmed, { id: "job-1" });
  assert.equal(seen.navigated, 1);
  assert.deepEqual(Array.from(seen.context.acknowledgedAutofillItems).map((i) => i.key), ["7037|g"]);
  // Without a confirmation nothing is carried over.
  seen.context = null;
  await ctx.runLocalTaxAssistedFilingFlow({}, { id: "job-1" });
  assert.equal(seen.context.acknowledgedAutofillItems, undefined);
});

// ───────────────────────────────────────────────────────────────
// Whatever the taxpayer enters by hand is READ BACK. Wrong place or wrong
// amount: the agent tells them again instead of trusting the tick.
// ───────────────────────────────────────────────────────────────

test("taken over and checked: the figure is read (never typed), matches, and counts as checked", async () => {
  const { make, packet, seen } = stopHarness();
  const taken = [{ key: "1009:incomeFields:Total Amount", name: "Salary", kind: "salary" }];
  const run = await make("never").runRealIrisAutofill(packet({ acknowledgedAutofillItems: taken }), { id: "job-1" }, "live");
  assert.deepEqual(seen.read, ["1009"]);
  assert.equal(seen.filled.includes("1009"), false);
  assert.equal(run.paused, false);
  assert.equal(run.result.takenOver[0].checked, true);
  assert.ok(run.executionLog.some((e) => e.step === "real_autofill_taken_over_check"));
});

test("fix46: taken over but IRIS shows a different amount: reported with the two figures, no longer 'taken over', the others still go in", async () => {
  const { make, packet, seen } = stopHarness({
    read: { "1009": { status: "overwrite_needs_confirmation", existingValue: "900", plannedValue: "1000" } },
  });
  const taken = [{ key: "1009:incomeFields:Total Amount", name: "Salary", kind: "salary" }];
  const run = await make("never").runRealIrisAutofill(packet({ acknowledgedAutofillItems: taken }), { id: "job-1" }, "live");
  assert.equal(run.paused, true);
  assert.equal(run.result.takenOver.length, 0, "it did not check out");
  assert.deepEqual(seen.read, ["1009"], "the disputed figure was only read, never typed over");
  assert.deepEqual(seen.filled, ["1049"], "the next figure was still typed");
  assert.equal(seen.wealthCalls, 1);
  assert.equal(run.result.attention.items.length, 1);
  const item = run.result.attention.items[0];
  assert.match(item.what, /You said you entered this yourself, but IRIS shows PKR 900 and the approved figure is PKR 1,000/);
  assert.match(item.todo, /press Continue so the agent checks it again/);
  assert.equal(run.result.pendingItems[0].key, "1009:incomeFields:Total Amount");
});

test("taken over but nothing is in IRIS: the agent says so and does not move on", async () => {
  const { make, packet } = stopHarness({
    read: { "1009": { status: "filled", dryRun: true, existingValue: "" } },
  });
  const taken = [{ key: "1009:incomeFields:Total Amount", name: "Salary", kind: "salary" }];
  const run = await make("never").runRealIrisAutofill(packet({ acknowledgedAutofillItems: taken }), { id: "job-1" }, "live");
  assert.equal(run.paused, true);
  assert.match(run.result.attention.items[0].what, /the amount in IRIS is still empty/);
});

test("taken-over wealth figures are verified through the driver in read-only mode; cash in hand is the one exception", async () => {
  const { make, packet, seen } = stopHarness();
  const taken = [
    { key: "7051:wealthFields:Amount", name: "Rent", kind: "wealth" },
  ];
  await make("never").runRealIrisAutofill(packet({ acknowledgedAutofillItems: taken }), { id: "job-1" }, "live");
  assert.deepEqual(seen.wealthChecked, ["7051"]);
  assert.deepEqual(seen.wealthFields, ["7051"]);
});

test("a hand-entered gift with another donor number is accepted by place and amount, and the donor IRIS shows is named once", async () => {
  const { make, packet } = stopHarness({
    wealthStub: (fields) => ({
      results: fields.map((f) => ({
        ...f,
        status: "already_correct",
        dryRun: true,
        takenOverChecked: true,
        giftDonorId: "4220180718935",
        giftDonorSeen: "4220144218163",
      })),
      setup: [],
      stopped: false,
      notAttempted: 0,
    }),
  });
  const key = "7037:wealthFields:Amount:Gift received on 2025-10-15 from 4220180718935";
  const gift = { key, name: "Gift received from 4220180718935", kind: "wealth" };
  const p = packet({ acknowledgedAutofillItems: [gift] });
  p.filingPacket.snapshot.portalFieldMap.push({
    key, irisCode: "7037", column: "Amount", value: "50000", label: "Gift", sourceGroup: "wealthFields",
    giftDonorId: "4220180718935", rowDescriptionIncludes: "4220180718935",
  });
  const run = await make("never").runRealIrisAutofill(p, { id: "job-1" }, "live");
  const item = run.result.takenOver.find((i) => i.key === key);
  assert.equal(item.checked, true);
  assert.equal(item.name, "Gift received from 4220180718935 (IRIS shows donor 4220144218163)");
  // A later run reads the saved name back and must not add the note twice.
  const again = await make("never").runRealIrisAutofill(
    packet({ acknowledgedAutofillItems: [{ ...item }] }), { id: "job-1" }, "live");
  assert.equal(again.result.takenOver.find((i) => i.key === key).name, item.name);
});

test("a hand-entered bank account with another IBAN is accepted and the IBAN IRIS shows is named once", async () => {
  const { make, packet } = stopHarness({
    wealthStub: (fields) => ({
      results: fields.map((f) => ({ ...f, status: "already_correct", dryRun: true, takenOverChecked: true, bankIbanPlanned: "PK36SCBL0000001123456702", bankIbanSeen: "PK71SCBL0000001303338401" })),
      setup: [], stopped: false, notAttempted: 0,
    }),
  });
  const key = "7030:wealthFields:Amount:PK36SCBL0000001123456702";
  const p = packet({ acknowledgedAutofillItems: [{ key, name: "Bank account PK36SCBL0000001123456702", kind: "wealth" }] });
  p.filingPacket.snapshot.portalFieldMap.push({ key, irisCode: "7030", column: "Amount", value: "75000", label: "Bank", sourceGroup: "wealthFields", rowDescriptionIncludes: "PK36SCBL0000001123456702" });
  const run = await make("never").runRealIrisAutofill(p, { id: "job-1" }, "live");
  const item = run.result.takenOver.find((i) => i.key === key);
  assert.equal(item.checked, true);
  assert.equal(item.name, "Bank account PK36SCBL0000001123456702 (IRIS shows IBAN PK71SCBL0000001303338401)");
  const again = await make("never").runRealIrisAutofill(packet({ acknowledgedAutofillItems: [{ ...item }] }), { id: "job-1" }, "live");
  assert.equal(again.result.takenOver.find((i) => i.key === key).name, item.name);
});

test("autofill switched off: a clean inspection says plainly that nothing was typed, instead of 'Return prepared'", async () => {
  const { markAutofillOff } = sandbox(["markAutofillOff"]);
  const clean = {
    paused: false,
    pauseAction: "portal_sections_inspected",
    pauseMessage: "Your return is prepared for review.",
    result: { requiredAction: "portal_sections_inspected", mode: "live_return_navigation_only" },
    executionLog: [{ step: "inspection_complete" }],
  };
  const out = markAutofillOff(clean);
  assert.equal(out.paused, false, "finishNavigationOnly still turns it into a pause");
  assert.equal(out.pauseAction, "portal_autofill_off");
  assert.match(out.pauseMessage, /autofill switched off/);
  assert.match(out.pauseMessage, /start-live\.ps1/);
  assert.match(out.pauseMessage, /typed nothing/);
  assert.equal(out.result.autofillOff, true);
  assert.equal(out.executionLog.at(-1).step, "real_autofill_off");
  const other = { paused: true, pauseAction: "portal_readiness_unverified" };
  assert.equal(markAutofillOff(other), other);
  assert.equal(markAutofillOff(null), null);
});

test("a protocol-launched second agent copy hands off quietly, while a manual copy still warns", () => {
  const src = fs.readFileSync(path.join(__dirname, "../electron-connect/main.js"), "utf8");
  const lock = src.slice(src.indexOf("requestSingleInstanceLock()"), src.indexOf("app.on(\"second-instance\""));
  const secondInstance = src.slice(src.indexOf("app.on(\"second-instance\""), src.indexOf("app.whenReady()"));
  const { getDeepLinkArgument } = sandbox(["getDeepLinkArgument"]);
  assert.equal(
    getDeepLinkArgument(["electron", ".", "taxrocket-connect://connect?token=test"]),
    "taxrocket-connect://connect?token=test",
  );
  assert.equal(getDeepLinkArgument(["TR Filing Agent.exe"]), "");
  assert.match(lock, /getDeepLinkArgument\(process\.argv\)/);
  assert.match(lock, /Forwarding connection request to the running TR Filing Agent/);
  assert.ok(lock.indexOf("Forwarding connection request") < lock.indexOf("showErrorBox"));
  assert.match(lock, /} else \{[\s\S]*dialog\.showErrorBox\(/, "the manual duplicate must still tell the user why it is closing");
  assert.match(lock, /already running/);
  assert.ok(lock.indexOf("showErrorBox") < lock.indexOf("app.quit()"));
  assert.match(secondInstance, /applyLaunchUrl\(deepLink\)/);
  assert.match(secondInstance, /focusExistingAgentWindow\(\)/);
  assert.match(src, /Autofill: LIVE/);
  assert.match(src, /Autofill: OFF\. This agent only looks at the FBR window and types nothing/);
});

test("slow FBR: a Draft list that first says '0 of 0' and then shows the draft does NOT start a second return", async () => {
  const html = `<!doctype html><html><head><style>a,button{display:inline-block;padding:9px;margin:4px}[hidden]{display:none!important}</style></head><body>
<nav><a id="homeLink" href="/dashboard">Home</a><a id="navbarDropdown1" onclick="actions.push('assets')">Assets Declaration</a>
<a id="navbarDropdown1" onclick="actions.push('declaration')">Declaration</a><button>person_pinarrow_drop_down</button><a>PRIVATE TEST TAXPAYER NAME</a></nav>
<a id="inbox">Inbox (Correspondence from FBR)</a><a id="draft" class="active">Draft (Unsubmitted Documents)</a><a>Completed Tasks</a>
<div id="tabs"></div>
<span class="mat-mdc-paginator-range-label" id="range">0 of 0</span>
<table id="dashboardTable"><thead><tr><th>Task</th><th>Tax Period</th><th>Action</th></tr></thead><tbody id="tb"></tbody></table>
<script>window.actions=[];setTimeout(function(){
document.getElementById('tabs').innerHTML='<button id="it" class="active" onclick="actions.push(\\'it\\')">IT DECLARATION (1)</button>';
document.getElementById('tb').innerHTML='<tr class="doubleclick"><td>114(1) (Return of Income filed voluntarily for complete year)</td><td>01-Jul-2025 - 30-Jun-2026</td><td><button class="edit" onclick="actions.push(\\'EDIT_RETURN\\')">Edit</button></td></tr>';
document.getElementById('range').textContent='1 - 1 of 1';},6000);</script></body></html>`;
  await withPage(html, async (_page, win) => {
    const steps = [];
    await navigation.inspectNavigation(win, {
      taxYear: 2026,
      openReturn: true,
      taxpayerIdentifier: "1234567890123",
      onStep: (step) => steps.push(String(step)),
    });
    assert.ok(!steps.includes("no_matching_draft"), `must not start a new return, steps: ${steps.join(", ")}`);
    assert.ok(!steps.includes("empty_draft_grid"));
    assert.ok(steps.includes("draft_grid_loaded_late"), `steps: ${steps.join(", ")}`);
  });
});

// ── fix41: header-ready is not sidebar-ready after Start Return Filling ──
// Structural synthetic fixtures only. Every browser request is intercepted.
const readinessHeader = `<app-wf-header><h6>Year 2026</h6><p><span>114(1) (Return of Income filed voluntarily for complete year)</span></p><p id="ready-registration">Registration No: 1234567890123</p></app-wf-header>`;
const readinessDataHead = `<app-nitr-wf-body><div class="custom-tabs"><div class="sticky-tabs-head"><div class="head"><button class="title active">Data</button></div></div></div><div class="body interface_21 active" id="ready-data"></div></app-nitr-wf-body>`;
const readinessSalaryRows = `<div id="ready-salary-pane" hidden><div class="wf-sticky-toolbar salary"><div class="heading-bar"><strong>Description</strong><strong>Code</strong><strong>Total Income</strong><strong>Subject to Final Tax</strong><strong>Subject to Exemption</strong><strong>Subject to Normal Income</strong></div></div>${["1000", "1009"].map(code => `<div class="tableRows dataRow" id="${code}"><div class="row-description-text">${code === "1000" ? "Total" : "Salary"}</div><div class="columns-parent">${[0,1,2,3].map(i => `<div class="data-middle-child-wapper"><input type="text" ${code === "1000" || i === 1 || i === 3 ? "disabled" : ""}></div>`).join("")}</div></div>`).join("")}</div>`;
const readinessEmployment = (salaryHidden = false) => `<mat-expansion-panel><mat-expansion-panel-header aria-expanded="false" onclick="actions.push('EXPAND_EMPLOYMENT');this.setAttribute('aria-expanded','true');this.classList.add('mat-expanded')">Employment</mat-expansion-panel-header><div class="mat-expansion-panel-content"><button id="ready-salary-tab" ${salaryHidden ? "hidden" : ""} class="data-tab-left-btn" onclick="actions.push('SALARY_TAB');this.classList.add('active');document.getElementById('ready-salary-pane').hidden=false">Salary</button>${readinessSalaryRows}</div></mat-expansion-panel>`;
const readinessStyle = `<style>.body{min-height:80px}app-nitr-workflow,app-wf-header,app-nitr-wf-body,.body,mat-expansion-panel,mat-expansion-panel-header,.mat-expansion-panel-content{display:block}button,mat-expansion-panel-header{padding:12px;margin:4px;cursor:pointer}mat-expansion-panel-header[aria-expanded="false"]+.mat-expansion-panel-content{display:none}[hidden]{display:none!important}</style>`;
const readinessReturn = (sidebar = "") => `${readinessStyle}<app-nitr-workflow>${readinessHeader}${readinessDataHead.replace('<div class="body interface_21 active" id="ready-data"></div>', `<div class="body interface_21 active" id="ready-data">${sidebar}</div>`)}</app-nitr-workflow><script>window.actions=[]</script>`;
const readinessOptions = (onStep = () => {}) => ({ taxYear: 2026, openReturn: true, taxpayerIdentifier: "1234567890123", onStep });

test("fix41: one Start reaches verified Salary despite late Data body, Employment and Salary controls", async () => {
  const startGate = gate({ checked: true, residency: true, enabled: true }).replace('</body>', `<script>
 document.querySelector('button.btn-start').onclick=()=>{
  actions.push('START_RETURN');history.replaceState({},'', '/nitr/workflow');
  document.body.innerHTML=${JSON.stringify(readinessStyle + '<app-nitr-workflow>' + readinessHeader + '</app-nitr-workflow>')};
  setTimeout(()=>document.querySelector('app-nitr-workflow').insertAdjacentHTML('beforeend',${JSON.stringify(readinessDataHead)}),1800);
  setTimeout(()=>document.getElementById('ready-data').innerHTML=${JSON.stringify(readinessEmployment(true))},3400);
  setTimeout(()=>document.getElementById('ready-salary-tab').hidden=false,5200);
 };</script></body>`);
  await withPage(startGate, async (page, win) => {
    const steps = [];
    const out = await navigation.inspectNavigation(win, {
      ...readinessOptions((step, detail) => steps.push({ step, detail })),
      newReturnContext: { routeFamily: "normal_individual_114", filingIntent: "original", incomeSources: ["salary"], residencyStatus: "resident", wealthStatement: true },
      inspectSections: true, sectionIds: ["salary"],
    });
    assert.equal(out.requiredAction, "portal_sections_inspected");
    assert.deepEqual(await page.evaluate('actions'), ['START_RETURN','EXPAND_EMPLOYMENT','SALARY_TAB']);
    assert.ok(steps.some(e => e.step === 'salary_navigation_wait'));
    assert.equal(out.inspection.frames[0].salary.verified, true);
    assert.equal(out.inspection.sectionTour.complete, true);
  }, { path: '/nitr/summary-economic-transactions' });
});

test("fix41: controls that never arrive have a bounded timeout, no click and useful metadata", async () => {
  await withPage(readinessReturn(), async (page, win) => {
    const now = Date.now; let elapsed = 0, waiting = false;
    const steps = [];
    Date.now = () => now() + elapsed;
    try {
      const out = await navigation.inspectNavigation(win, {
        ...readinessOptions((step, detail) => { steps.push({step,detail}); if (step === 'salary_navigation_wait' && detail.startsWith('expand-employment:')) waiting = true; }),
        beforeStep: async () => { if (waiting) elapsed += 16000; },
      });
      assert.equal(out.requiredAction, 'portal_fields_unverified');
      assert.ok(steps.some(e => e.step === 'salary_navigation_timeout' && e.detail.includes('employmentPanelCount')));
      assert.deepEqual(await page.evaluate('actions || []'), []);
    } finally { Date.now = now; }
  });
});

for (const [name, mutate, expected] of [
  ['taxpayer change', "document.getElementById('ready-registration').textContent='Registration No: 9999999999999'", 'portal_taxpayer_mismatch'],
  ['year change', "document.querySelector('app-wf-header h6').textContent='Year 2025'", 'portal_document_mismatch'],
  ['protected OTP popup', "document.body.insertAdjacentHTML('beforeend','<section role=dialog><h2>OTP verification</h2><input name=otp><button>Continue</button></section>')", 'portal_popup'],
]) {
  test(`fix41: ${name} during sidebar wait stops without a navigation click`, async () => {
    await withPage(readinessReturn(), async (page, win) => {
      let waiting = false, changed = false;
      const out = await navigation.inspectNavigation(win, {
        ...readinessOptions((step, detail) => { if (step === 'salary_navigation_wait' && detail.startsWith('expand-employment:')) waiting = true; }),
        beforeStep: async () => { if (waiting && !changed) { changed = true; await page.evaluate(mutate); } },
      });
      assert.equal(out.requiredAction, expected);
      assert.equal(changed, true);
    });
  });
}

test("fix41: duplicate Employment targets are refused, never the first match", async () => {
  await withPage(readinessReturn(readinessEmployment() + readinessEmployment()), async (page, win) => {
    const steps = [];
    const out = await navigation.inspectNavigation(win, readinessOptions(step => steps.push(step)));
    assert.equal(out.requiredAction, 'portal_fields_unverified');
    assert.ok(steps.includes('salary_navigation_ambiguous'));
    assert.equal(await page.locator('mat-expansion-panel-header[aria-expanded=true]').count(), 0);
    const frame = (await navigation.probeFrames(win, {taxYear:2026,taxpayerIdentifier:'1234567890123',openReturn:true,action:'expand-employment'})).frames[0];
    assert.equal(frame.actionResult.status, 'ambiguous');
  });
});

test("fix41: cancellation runs on readiness polls and is not swallowed", async () => {
  await withPage(readinessReturn(), async (_page, win) => {
    let waiting = false;
    await assert.rejects(navigation.inspectNavigation(win, {
      ...readinessOptions((step, detail) => { if (step === 'salary_navigation_wait' && detail.startsWith('expand-employment:')) waiting = true; }),
      beforeStep: async () => { if (waiting) throw new Error('test cancellation'); },
    }), /test cancellation/);
  });
});

test("fix41: proven no-click not_found race re-probes once, never repeats a successful click", async () => {
  await withPage(`<script>window.actions=[]</script>${readinessReturn(readinessEmployment())}`, async (page, win) => {
    const frame = win.webContents.mainFrame;
    const execute = frame.executeJavaScript;
    let raced = false;
    frame.executeJavaScript = async source => {
      if (!raced && source.includes('"action":"expand-employment"')) {
        raced = true;
        await page.evaluate(() => {
          const header = document.querySelector('mat-expansion-panel-header');
          const parent = header.parentNode; const next = header.nextSibling;
          header.remove(); setTimeout(() => parent.insertBefore(header,next),300);
        });
      }
      return execute(source);
    };
    const steps = [];
    const out = await navigation.inspectNavigation(win, readinessOptions(step => steps.push(step)));
    assert.equal(out.requiredAction,'portal_fields_verified');
    assert.equal(raced,true);
    assert.ok(steps.includes('salary_navigation_reprobe'));
    assert.deepEqual(await page.evaluate('actions'), ['EXPAND_EMPLOYMENT','SALARY_TAB']);
  });
});

// Render the actual completion-card functions with an inert JSX renderer.
// No server, live account, React dependencies or network are required.
function renderHandoffCompletion(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, "../components/tax/fbr-connect-client.tsx"), "utf8");
  const parsed = ts.createSourceFile("completion.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) &&
    ["HandoffRow", "HandoffCompleteCard"].includes(node.name?.text));
  assert.equal(functions.length, 2);
  const code = ts.transpileModule(functions.map((node) => node.getText(parsed)).join("\n"), {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const context = {
    React: { createElement: (type, props, ...children) => typeof type === "function"
      ? type({ ...props, children }) : { type, props, children } },
    Card: "card", CardHeader: "header", CardTitle: "title", CardContent: "content",
    CheckCircle: "icon", Button: "button",
    scope: {
      salary: "filled", employers: "listed", wealthStatement: "entered_not_calculated",
      wealthRows: 10, propertyPaymentsComputations: "pending", readyToSubmit: false,
      manualItems: [], manualUnchecked: [], ...overrides,
    },
  };
  vm.createContext(context);
  const tree = vm.runInContext(`${code}\nHandoffCompleteCard({scope, finishedAt: null, onStartOver: () => {}})`, context);
  const text = [];
  const types = [];
  function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") { types.push(node.type); walk(node.children); }
    else if (typeof node === "string") text.push(node);
  }
  walk(tree);
  return { text: text.join(" "), types };
}

test("completion card: clean entry shows completion while remaining FBR review is informational", () => {
  const { text, types } = renderHandoffCompletion();
  assert.match(text, /Return prepared in FBR/);
  assert.doesNotMatch(text, /Return partly prepared|Needs your attention|confirmed by you as reviewed/);
  assert.match(text, /Review in FBR/);
  assert.match(text, /submit the return yourself/);
  assert.ok(!types.includes("input"), "no confirmation checkbox");
  assert.doesNotMatch(text, /Continue/);
});

test("completion card: incomplete agent entry remains visible without partial-return wording", () => {
  const { text } = renderHandoffCompletion({ salary: "needs_review" });
  assert.match(text, /Data entry finished/);
  assert.doesNotMatch(text, /Return partly prepared|partly prepared/i);
  assert.match(text, /Needs your attention/);
});

test("completion card: unchecked manual entry is never certified as complete", () => {
  const { text } = renderHandoffCompletion({ salary: "confirmed_by_taxpayer", manualUnchecked: ["salary"] });
  assert.match(text, /Data entry finished/);
  assert.doesNotMatch(text, /Return partly prepared|partly prepared/i);
  assert.match(text, /agent could not check/);
});

// fix43: fixed business contracts; no live taxpayer data or external requests.
function businessFixture() {
  const specs = navigation.BUSINESS_CONTRACT;
  const tabs = Object.entries(specs).map(([id, s]) => `<button class="data-tab-left-btn" onclick="actions.push('${id}');document.querySelectorAll('.data-tab-left-btn').forEach(b=>b.classList.remove('active'));this.classList.add('active');document.querySelectorAll('.business-grid').forEach(g=>g.hidden=true);document.getElementById('${id}').hidden=false">${s.tab}</button>`).join('');
  const grids = Object.entries(specs).map(([id,s]) => `<div class="business-grid" id="${id}" hidden><div class="wf-sticky-toolbar"><div class="heading-bar"><strong>Description</strong><strong>Code</strong>${s.columns.map(c=>`<strong>${c}</strong>`).join('')}</div></div>${Object.entries(s.rows).map(([code,r])=>`<div class="tableRows dataRow" id="${code}"><div class="row-description-text">${r.label}</div><div class="columns-parent">${r.disabled.map(d=>`<div class="data-middle-child-wapper"><input type="text" ${d?'disabled':''}></div>`).join('')}</div></div>`).join('')}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8">${readinessStyle}<style>.business-grid{min-height:80px}.heading-bar strong{display:inline-block;margin:8px}.dataRow{display:flex;padding:5px}.columns-parent{display:flex}input{width:100px}button{display:inline-block}</style></head><body><a id="homeLink">Home</a><app-nitr-workflow>${readinessHeader}<app-nitr-wf-body><div class="custom-tabs"><div class="sticky-tabs-head"><div class="head"><div class="title active">Data</div></div></div><div class="body interface_21 active"><mat-expansion-panel><mat-expansion-panel-header aria-expanded="false" onclick="actions.push('BUSINESS_PANEL');this.setAttribute('aria-expanded','true');this.classList.add('mat-expanded')">Business</mat-expansion-panel-header><div class="mat-expansion-panel-content">${tabs}${grids}</div></mat-expansion-panel></div></div></app-nitr-wf-body></app-nitr-workflow><button onclick="actions.push('SAVE')">Save</button><button onclick="actions.push('CALCULATE')">Calculate</button><button onclick="actions.push('SUBMIT')">Submit</button><script>window.actions=[]</script></body></html>`;
}

test('fix43: business-only navigation verifies both grids without requiring Employment/Salary', async () => {
  await withPage(businessFixture(), async (page, win) => {
    const out = await navigation.inspectNavigation(win,{taxYear:2026,taxpayerIdentifier:'1234567890123',openReturn:true,inspectSections:true,sectionIds:['business_trading','business_balance_sheet']});
    assert.equal(out.requiredAction,'portal_sections_inspected');
    assert.deepEqual(out.inspection.sectionTour.sections.map(s=>s.id),['business_trading','business_balance_sheet']);
    assert.ok(out.inspection.sectionTour.sections.every(s=>s.mappingVerified), JSON.stringify(out.inspection.sectionTour.sections.map(s=>({id:s.id,verified:s.mappingVerified,errors:s.headerBindingErrors,unknown:s.unknownCodeCount,rows:s.rows.filter(r=>!navigation.BUSINESS_CONTRACT[s.id].rows[r.code] || JSON.stringify(r.cells.map(c=>c.disabled))!==JSON.stringify(navigation.BUSINESS_CONTRACT[s.id].rows[r.code].disabled)).map(r=>({code:r.code,cells:r.cells}))}))));
    assert.ok(!(await page.evaluate('actions')).some(a=>['SAVE','CALCULATE','SUBMIT','SALARY_TAB'].includes(a)));
  });
});

test('fix43: verified business scalar writes read back; computed totals and Save/Calculate/Submit stay untouched', async () => {
  const filler = require('../electron-connect/iris-row-filler');
  await withPage(businessFixture(), async (page,win) => {
    const nav = await navigation.inspectNavigation(win,{taxYear:2026,taxpayerIdentifier:'1234567890123',openReturn:true,inspectSections:true,sectionIds:['business_trading','business_balance_sheet']});
    assert.equal(nav.requiredAction,'portal_sections_inspected');
    const fields = [{irisCode:'3315',column:'Amount',value:'120000',label:'Stocks'},{irisCode:'3352',column:'Amount',value:'120000',label:'Capital'}];
    const out=await filler.fillIrisRows(win,fields,{sectionVerified:true});
    assert.equal(out.summary.filled,2);
    assert.equal(await page.locator('[id="3315"] input').inputValue(),'120000');
    assert.equal(await page.locator('[id="3349"] input').inputValue(),'');
    assert.equal(await page.locator('[id="3399"] input').inputValue(),'');
    const moved=await navigation.navigateToSection(win,{sectionId:'business_trading',taxYear:2026,taxpayerIdentifier:'1234567890123'});
    assert.ok(moved.ok);
    const sale=await filler.fillIrisRows(win,[{irisCode:'3009',column:'Total Amount',value:'1000000'}],{sectionVerified:true});
    assert.equal(sale.summary.filled,1, JSON.stringify(sale));
    assert.equal(await page.locator('[id="3000"] input').first().inputValue(),'');
    assert.ok(!(await page.evaluate('actions')).some(a=>['SAVE','CALCULATE','SUBMIT'].includes(a)));
  });
});

test('fix43: duplicate writable business row refuses structure verification', async () => {
  await withPage(businessFixture(), async(page,win)=>{
    await page.evaluate(()=>{const r=document.querySelector('[id="3009"]');r.after(r.cloneNode(true));});
    const out=await navigation.inspectNavigation(win,{taxYear:2026,taxpayerIdentifier:'1234567890123',openReturn:true,inspectSections:true,sectionIds:['business_trading']});
    assert.equal(out.requiredAction,'portal_sections_inspected');
    assert.equal(out.inspection.sectionTour.sections[0].mappingVerified,false);
  });
});

test('fix43: wrong business header never verifies the business structure', async () => {
  await withPage(businessFixture().replace('<strong>Total Amount</strong>','<strong>Total Income</strong>'), async(page,win)=>{
    const out=await navigation.inspectNavigation(win,{taxYear:2026,taxpayerIdentifier:'1234567890123',openReturn:true,inspectSections:true,sectionIds:['business_trading']});
    assert.equal(out.inspection.sectionTour.sections[0].mappingVerified,false);
  });
});

test('fix43: clean business autofill finishes field entry, retains pending schedules and never counts business as salary', async()=>{
  const visited=[];
  const ctx=handoffReviewCtx(visited,'filled',{lastSectionTour:{complete:true,sections:[{id:'business_trading',rows:[{code:'3009'}],mappingVerified:true}]}});
  const pending=[{key:'businessCostOfSales',reason:'Computed total; stock/purchase details pending'}];
  const out=await ctx.runRealIrisAutofill({filingPacket:{taxYear:2026,snapshot:{portalFieldMap:[{irisCode:'3009',column:'Total Amount',value:'1000000',sourceGroup:'businessFields'}],business:{version:'business-entry-v1',pending}}}},{id:'business-job',type:'tax_assisted_filing'},'live');
  assert.equal(out.paused,false);
  assert.equal(out.result.salarySummary.total,0);
  assert.equal(out.result.business.total,1);
  assert.equal(out.result.business.filled,1);
  assert.equal(out.result.business.coverage,'partial_manual_required');
  const merged=sandbox(['mergeNavigationAutofillOutcome','buildHandoffScopeSummary']).mergeNavigationAutofillOutcome({executionLog:[],result:{}},out,'live');
  assert.equal(merged.result.handoffScope.business.status,'partial_manual_required');
  assert.equal(merged.result.handoffScope.readyToSubmit,false);
  assert.equal(merged.result.handoffScope.salary,'not_entered');
  assert.match(merged.result.handoffScope.business.pendingItems[0],/stock\/purchase/);
});

test('fix43: business completion card exposes actionable scope without phantom Salary/Employer rows',()=>{
  const {text}=renderHandoffCompletion({salary:'not_entered',employers:'none',business:{preparedFields:1,filledFields:1,status:'partial_manual_required',pendingItems:['Cost of sales breakdown remains manual']}});
  assert.match(text,/Business — numeric field entry/);
  assert.match(text,/Cost of sales breakdown remains manual/);
  assert.match(text,/Data entry finished/);
  assert.doesNotMatch(text,/partly prepared/i);
  assert.doesNotMatch(text,/Salary income and withholding|Employer details/);
});

test('business completion card hides generic schedule and final-review labels from a stored job',()=>{
  const {text}=renderHandoffCompletion({salary:'not_entered',employers:'none',business:{preparedFields:51,filledFields:51,status:'partial_manual_required',pendingItems:['businessScheduleReview: Accounting depreciation is queued, but tax depreciation / initial allowance 3248 is computed from an asset schedule and still needs manual verification.','businessFinalReview: Verify the saved business identity and principal activity, remaining schedules, calculated profit/tax and final reconciliation in FBR yourself.']}});
  assert.match(text,/51\/51 queued business fields/);
  assert.doesNotMatch(text,/businessScheduleReview|businessFinalReview|remaining manual schedules|partly prepared/i);
});

test('business completion card does not show an FBR totals check from a stored job',()=>{
  const {text}=renderHandoffCompletion({salary:'not_entered',employers:'none',business:{preparedFields:51,filledFields:51,status:'partial_manual_required',pendingItems:[]},irisCheck:{available:true,matched:11,differs:8,notSeen:0,rows:[{code:'3259',label:'Admissible Deductions',iris:'3,270,000',expected:3015000,status:'differs',proven:true}],appTaxableIncome:11785000,irisTaxableIncome:11630000}});
  assert.match(text,/51\/51 queued business fields/);
  assert.doesNotMatch(text,/FBR totals check|totals calculated by FBR differ|3259|TaxRocket's full estimate/);
});

test('fix43: stored original Manufacturing and Balance Sheet captures independently verify fixed contracts', async()=>{
  for(const [file,id] of [['02_business_manufacturing_trading.html','business_trading'],['11_business_balance_sheet_plus_depreciation_amortization_details_payment_attachment.html','business_balance_sheet'],['03_business_other_revenues.html','business_other_revenues'],['04_business_admin_expenses.html','business_admin'],['07_business_ADJUSTMENTS_page_losses.html','business_adjustments'],['32_business_inadmissible_admissible_ALL_rows_added.html','business_deductions']]) {
    const capture=path.join('/home/user/iris-business-captures-ty2026',file);
    // Local archive is optional outside this analysis workspace; synthetic
    // contract/navigation/write regressions above always run in the repo.
    if(!fs.existsSync(capture)) continue;
    await withPage(fs.readFileSync(capture,'utf8'),async(page,win)=>{
      const result=await navigation.probeFrames(win,{taxYear:2026});
      const section=result.frames[0].section;
      assert.equal(section.id,id);
      assert.equal(section.business.verified,true,JSON.stringify({id:section.id,grids:section.grids,errors:section.headerBindingErrors,unknown:section.unknownCodeCount}));
    });
  }
});

test('fix43: an old business packet is refused before any portal interaction',async()=>{
  let touches=0;
  const ctx=sandbox(['runLocalIrisNavigationCheck'],{
    assertNavigatorBuild:()=>{},ensureWorkerWindow:async()=>({}),
    irisNavigation:navigation, pushStatus:()=>{touches++},
  });
  const out=await ctx.runLocalIrisNavigationCheck({filingPacket:{snapshot:{filing:{incomeSources:['business'],taxYear:2026}}}},{id:'old-business'});
  assert.equal(out.paused,true);
  assert.equal(out.result.businessCoverage,'missing_payload');
  assert.equal(out.result.submitted,false);
  assert.equal(touches,0);
});

for(const [sources,businessFields,expected] of [
  [['salary'],null,['salary','tax_deductions']],
  [['business'],[{section:'Manufacturing/ Trading Items'}],['business_trading']],
  [['business'],[{section:'Balance Sheet'}],['business_balance_sheet']],
  [['business'],[{section:'Inadmissible/Admissible Deductions'}],['business_deductions']],
  [['business'],[{section:'Other Revenues'},{section:'Admin, Selling & Financial Expenses'},{section:'Adjustments'}],['business_other_revenues','business_admin','business_adjustments']],
  [['salary','business'],[{section:'Manufacturing/ Trading Items'},{section:'Balance Sheet'}],['salary','tax_deductions','business_trading','business_balance_sheet']],
]) test(`fix43: controller requests exact approved section plan for ${sources}/${expected}`,async()=>{
  let plan=null;
  const ctx=sandbox(['runLocalIrisNavigationCheck'],{
    assertNavigatorBuild:()=>{},AGENT_BUILD_TAG:'test-build',
    normalizeExplicitResidencyStatus:()=> 'Resident',lastTourStateKey:null,lastNavigationOptions:{},
    ensureWorkerWindow:async()=>({isDestroyed:()=>false}),getLivePortalWindow:()=>({}),navigationStates:new Map(),
    irisNavigation:{...navigation,inspectNavigation:async(_win,options)=>{plan=options.sectionIds;return{inspection:{frames:[{document:{present:true}}]},requiredAction:'portal_sections_inspected'}}},
    writePortalInspectionToDisk:()=>'/local/inspection.json',getSelectorBundleSignal:()=>null,ensureNavigationJobActive:async()=>{},
    updateLocalJobStatus:async()=>{},pushStatus:()=>{},launchState:{accountReference:'1234567890123'},activeJobExecutionLog:null,
  });
  const out=await ctx.runLocalIrisNavigationCheck({filingPacket:{taxYear:2026,snapshot:{filing:{incomeSources:sources,residencyStatus:'Resident',reconciliationStatus:'RESOLVED',reconciliationGap:0},...(businessFields?{business:{version:'business-entry-v1',fields:businessFields}}:{})}}},{id:'synthetic-plan'});
  assert.equal(out.paused,false);
  assert.deepEqual(Array.from(plan),expected);
});
test('fix43: a changed business row description or additional uncontracted row blocks mapping',async()=>{
  for(const mutate of [
    html=>html.replace('Gross Revenue (excluding Sales Tax, Federal Excise)','UNVERIFIED DIFFERENT INCOME'),
    html=>html.replace('<div class="dataRow" id="3009">','<div class="dataRow" id="1009"><div class="wf-col-header d4">Unexpected income</div><div class="columns-parent">'+Array.from({length:4},()=>'<div class="data-middle-child-wapper"><input type="text"></div>').join('')+'</div></div><div class="dataRow" id="3009">'),
  ])await withPage(mutate(businessFixture('trading')),async(page,win)=>{const r=await navigation.probeFrames(win,{taxpayerIdentifier:'1234567890123',taxYear:2026});assert.equal(r.frames[0].section.business.verified,false);});
});

test('fix44: revenue, admin and origin-year loss tabs verify and field values read back without Save/Submit',async()=>{
  const filler=require('../electron-connect/iris-row-filler');
  await withPage(businessFixture(),async(page,win)=>{
    const ids=['business_other_revenues','business_admin','business_adjustments'];
    const out=await navigation.inspectNavigation(win,{taxYear:2026,taxpayerIdentifier:'1234567890123',openReturn:true,inspectSections:true,sectionIds:ids});
    assert.equal(out.requiredAction,'portal_sections_inspected');assert.ok(out.inspection.sectionTour.sections.every(s=>s.mappingVerified));
    for(const[id,code,value]of [['business_other_revenues','3128','120000'],['business_admin','3151','240000'],['business_admin','3180','100000'],['business_adjustments','327025','50000']]){
      const move=await navigation.navigateToSection(win,{sectionId:id,taxYear:2026,taxpayerIdentifier:'1234567890123'});assert.ok(move.ok,JSON.stringify(move));
      const filled=await filler.fillIrisRows(win,[{irisCode:code,column:'Total Amount',value}],{sectionVerified:true});assert.equal(filled.summary.filled,1,JSON.stringify(filled));
      assert.equal(await page.locator(`[id="${code}"] input`).first().inputValue(),value);
    }
    assert.ok(!(await page.evaluate('actions')).some(a=>['SAVE','CALCULATE','SUBMIT'].includes(a)));
  });
});
test('fix44: contract mismatch in an admin grid refuses before any amount is written',async()=>{
  const html=businessFixture().replace('Admin, Selling & Financial Expenses','Wrong Unverified Expenses');
  await withPage(html,async(page,win)=>{const out=await navigation.inspectNavigation(win,{taxYear:2026,taxpayerIdentifier:'1234567890123',openReturn:true,inspectSections:true,sectionIds:['business_admin']});assert.notEqual(out.requiredAction,'portal_sections_inspected');assert.equal(await page.locator('[id="3151"] input').first().inputValue(),'');assert.ok(!(await page.evaluate('actions')).some(a=>['SAVE','SUBMIT'].includes(a)))});
});

async function missingPersonalFixture(page,otherSelected=false){
 await page.evaluate((otherSelected)=>{
  document.querySelector('[id="3212"]').remove();
  const grid=document.getElementById('business_deductions');
  window.openPersonalPicker=()=>{
   actions.push('OPEN_PERSONAL_PICKER');
   document.body.insertAdjacentHTML('beforeend',`<mat-dialog-container role="dialog"><app-add-amount-code-row><h6>Add Inadmissible Deductions</h6><div class="source-card"><input id="personal-checkbox" type="checkbox" onchange="document.getElementById('personal-add').disabled=!this.checked"><p>Add Backs u/s 21(h) Personal Expenditure</p></div><div class="source-card"><input type="checkbox" ${otherSelected?'checked':''}><p>Other unrequested reason</p></div><button id="personal-add" disabled onclick="addPersonalReason()">ADD</button><button onclick="actions.push('CANCEL_PICKER');this.closest('mat-dialog-container').remove()">Cancel</button></app-add-amount-code-row></mat-dialog-container>`);
  };
  window.addPersonalReason=()=>{actions.push('ADD_PERSONAL_REASON');grid.insertAdjacentHTML('beforeend','<div class="tableRows dataRow" id="3212"><div class="row-description-text">Add Backs u/s 21(h) Personal Expenditure</div><div class="columns-parent"><div class="data-middle-child-wapper"><input type="text"></div><div class="data-middle-child-wapper"><input type="text"></div><div class="data-middle-child-wapper"><input type="text"></div><div class="data-middle-child-wapper"><input type="text" disabled></div></div></div>');document.querySelector('mat-dialog-container').remove()};
  grid.insertAdjacentHTML('beforeend','<button class="btn-section-add" onclick="openPersonalPicker()">+ Inadmissible</button>');
 },otherSelected);
}
const personalField={irisCode:'3212',sourceGroup:'businessFields',leftPanel:'Business',leftSection:'Inadmissible/Admissible Deductions',column:'Total Amount',value:'80000'};
test('fix44: missing personal reason is planned from a verified optional contract, created once and money reads back',async()=>{
 const driver=require('../electron-connect/iris-business-row-driver'),filler=require('../electron-connect/iris-row-filler');
 await withPage(businessFixture(),async(page,win)=>{
  await missingPersonalFixture(page);
  const out=await navigation.inspectNavigation(win,{taxYear:2026,taxpayerIdentifier:'1234567890123',openReturn:true,inspectSections:true,sectionIds:['business_deductions']});assert.equal(out.requiredAction,'portal_sections_inspected');
  assert.ok(out.inspection.sectionTour.sections[0].mappingVerified,JSON.stringify(out.inspection.sectionTour.sections[0].rows.filter(r=>r.labelMatched!==true)));
  assert.ok(!out.inspection.sectionTour.sections[0].rows.some(r=>r.code==='3212'));
  const plan=navigation.planSectionFills([personalField],out.inspection.sectionTour);assert.equal(plan.groups[0].sectionId,'business_deductions');assert.equal(plan.unlocated.length,0);
  const context={mode:'live',taxYear:2026,taxpayerIdentifier:'1234567890123'};
  const added=await driver.ensurePersonalAddbackRow(win,[personalField],context);assert.ok(added.ok,JSON.stringify(added));
  const filled=await filler.fillIrisRows(win,[personalField],{sectionVerified:true});assert.equal(filled.summary.filled,1,JSON.stringify(filled));assert.equal(await page.locator('[id="3212"] input').first().inputValue(),'80000');
  const again=await driver.ensurePersonalAddbackRow(win,[personalField],context);assert.ok(again.ok);
  const actions=await page.evaluate('actions');assert.equal(actions.filter(x=>x==='ADD_PERSONAL_REASON').length,1);assert.ok(!actions.some(x=>['SAVE','SUBMIT','CALCULATE'].includes(x)));
 });
});
test('fix44: addback driver refuses dry mode and unrequested picker selection',async()=>{
 const driver=require('../electron-connect/iris-business-row-driver');
 await withPage(businessFixture(),async(page,win)=>{
  await missingPersonalFixture(page,true);
  const dry=await driver.ensurePersonalAddbackRow(win,[personalField],{mode:'dry'});assert.equal(dry.ok,false);assert.deepEqual(await page.evaluate('actions'),[]);
  const out=await driver.ensurePersonalAddbackRow(win,[personalField],{mode:'live',taxYear:2026,taxpayerIdentifier:'1234567890123'});assert.equal(out.ok,false);assert.equal(out.reason,'unrelated_picker_selection_not_touched');assert.equal(await page.locator('[id="3212"]').count(),0);assert.ok(!(await page.evaluate('actions')).includes('ADD_PERSONAL_REASON'));
  // fix46: the picker the agent opened is closed with its own Cancel; the
  // unrequested ENABLED tick is reported, never cleared or added.
  assert.equal(out.cleanup.clicked,true);assert.equal(out.cleanup.closed,true);assert.equal(await page.locator('mat-dialog-container').count(),0);
  assert.ok((await page.evaluate('actions')).includes('CANCEL_PICKER'));assert.deepEqual(out.diagnostics.unrelated,['Other unrequested reason']);
 });
});

// fix45: regression for the uploaded second-round state. All traffic is routed
// to local synthetic fixtures; no taxpayer values or live portal are touched.
const recoveryContext = { sectionId: 'business_balance_sheet', taxYear: 2026, taxpayerIdentifier: '1234567890123', timeoutMs: 100, pollMs: 10 };
const businessRecoveryPacket = (fields) => ({filingPacket:{taxYear:2026,snapshot:{business:{version:'business-entry-v2',pending:[]},portalFieldMap:fields}}});
const bsFields = () => Object.entries(navigation.BUSINESS_CONTRACT.business_balance_sheet.rows)
  .filter(([_,s])=>s.disabled[0]===false)
  .map(([code,s],i)=>({key:`${code}:businessFields:Amount`,irisCode:code,value:String(1000+i),label:s.label,column:'Amount',sourceGroup:'businessFields'}));
async function activeBalance(page,win) {
  const moved=await navigation.navigateToSection(win,recoveryContext);assert.equal(moved.ok,true);
}
function recoveryMain(visited,win,overrides={}) {
  return handoffReviewCtx(visited,'filled',{
    ensureWorkerWindow:async()=>win,
    irisNavigation:{...navigation,waitForBusinessSectionReady:(w,o)=>navigation.waitForBusinessSectionReady(w,{...o,timeoutMs:500,pollMs:10})},
    irisRowFiller:require('../electron-connect/iris-row-filler'),
    lastSectionTour:{complete:true,sections:[{id:'business_balance_sheet',mappingVerified:false,rows:bsFields().map(f=>({code:f.irisCode}))}]},
    buildFieldLog:require('../electron-connect/job-report').buildFieldLog,
    ...overrides,
  });
}
test('fix45: reproduced all-readonly balance state stays unverified despite correct labels/headers',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);
  await page.evaluate(()=>document.querySelectorAll('#business_balance_sheet input').forEach(i=>i.readOnly=true));
  const s=(await navigation.probeFrames(win,recoveryContext)).frames[0].section;
  assert.equal(s.headerBindingErrors,0);assert.equal(s.business.verified,false);
  const ready=await navigation.waitForBusinessSectionReady(win,recoveryContext);
  assert.equal(ready.ok,false);assert.equal(ready.status,'business_inputs_read_only');
  assert.equal(await page.locator('[id="3303"] input').inputValue(),'');
 });
});
test('fix45: disabled computed summaries may be readonly; writable primary targets remain mandatory',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);
  await page.evaluate(()=>document.querySelectorAll('#business_balance_sheet input:disabled').forEach(i=>i.readOnly=true));
  const ready=await navigation.waitForBusinessSectionReady(win,recoveryContext);assert.equal(ready.ok,true);
  assert.equal(await page.locator('[id="3349"] input').inputValue(),'');
  assert.equal(await page.locator('[id="3399"] input').inputValue(),'');
 });
});
test('fix45: temporary readonly state automatically settles without removing attributes or touching amounts',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);
  await page.evaluate(()=>{
   document.querySelectorAll('#business_balance_sheet input').forEach(i=>i.readOnly=true);
   setTimeout(()=>document.querySelectorAll('#business_balance_sheet input:not(:disabled)').forEach(i=>i.readOnly=false),100);
  });
  const steps=[];const ready=await navigation.waitForBusinessSectionReady(win,{...recoveryContext,timeoutMs:1000,onStep:s=>steps.push(s)});
  assert.equal(ready.ok,true);assert.ok(steps.includes('business_section_readiness_wait'));assert.ok(steps.includes('business_section_ready'));
  assert.equal(await page.locator('[id="3303"] input').inputValue(),'');
  assert.ok(await page.locator('[id="3349"] input').evaluate(i=>i.readOnly));
 });
});
test('fix45: main fills all ten balance scalars using fresh live evidence even when cached tour is false',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);
  await page.evaluate(()=>document.querySelectorAll('#business_balance_sheet input:disabled').forEach(i=>i.readOnly=true));
  const out=await recoveryMain([],win).runRealIrisAutofill(businessRecoveryPacket(bsFields()),{id:'synthetic-recovery'},'live');
  assert.equal(out.paused,false,JSON.stringify(out.result.summary));assert.equal(out.result.summary.filled,10);
  assert.equal(out.result.takenOver.length,0);assert.equal(out.result.salarySummary.total,0);
  for(const f of bsFields())assert.equal(await page.locator(`[id="${f.irisCode}"] input`).inputValue(),f.value);
  assert.equal(await page.locator('[id="3349"] input').inputValue(),'');
  assert.equal(await page.locator('[id="3399"] input').inputValue(),'');
  assert.ok(!(await page.evaluate('actions')).some(a=>['SAVE','CALCULATE','SUBMIT'].includes(a)));
 });
});
test('fix45: current readonly state overrides a previously true cached tour; retry does not require manual confirmation',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);
  await page.evaluate(()=>document.querySelectorAll('#business_balance_sheet input').forEach(i=>i.readOnly=true));
  const out=await recoveryMain([],win,{lastSectionTour:{sections:[{id:'business_balance_sheet',mappingVerified:true,rows:bsFields().map(f=>({code:f.irisCode}))}]}})
   .runRealIrisAutofill(businessRecoveryPacket(bsFields()),{id:'synthetic-locked'},'live');
  assert.equal(out.paused,true);assert.equal(out.pauseAction,'portal_business_retry');assert.equal(out.result.summary.filled,0);
  assert.equal(out.result.pendingItems.length,10);assert.ok(out.result.pendingItems.every(x=>x.kind==='business'));
  assert.equal(out.result.takenOver.length,0);assert.match(out.pauseMessage,/No manual-entry confirmation/);
  assert.equal(await page.locator('[id="3303"] input').inputValue(),'');
 });
});
test('fix45: wrong taxpayer fails readiness immediately and writes nothing',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);
  const ready=await navigation.waitForBusinessSectionReady(win,{...recoveryContext,taxpayerIdentifier:'9999999999999'});
  assert.equal(ready.ok,false);assert.equal(ready.status,'business_document_mismatch');
  assert.equal(await page.locator('[id="3303"] input').inputValue(),'');
 });
});
test('fix45: duplicate writable row never becomes ready',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);
  await page.evaluate(()=>{const r=document.querySelector('[id="3303"]');r.after(r.cloneNode(true))});
  assert.equal((await navigation.waitForBusinessSectionReady(win,recoveryContext)).ok,false);
 });
});
test('fix45: wrong balance header never becomes ready',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);
  await page.evaluate(()=>document.querySelector('#business_balance_sheet .heading-bar strong:last-child').textContent='Wrong Amount');
  assert.equal((await navigation.waitForBusinessSectionReady(win,recoveryContext)).ok,false);
 });
});
test('fix45: business readonly lock after a field waits and continues automatically',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);
  await page.evaluate(()=>document.querySelector('[id="3303"] input').addEventListener('input',()=>{
   document.querySelectorAll('#business_balance_sheet input:not(:disabled)').forEach(i=>i.readOnly=true);
   setTimeout(()=>document.querySelectorAll('#business_balance_sheet input:not(:disabled)').forEach(i=>i.readOnly=false),100);
  }));
  const out=await recoveryMain([],win).runRealIrisAutofill(businessRecoveryPacket(bsFields().slice(0,2)),{id:'synthetic-lock-after-input'},'live');
  assert.equal(out.paused,false);assert.equal(out.result.summary.filled,2);
 });
});
test('fix45: already-correct business figures are never rewritten',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);
  const fields=bsFields().slice(0,1);
  await page.locator('[id="3303"] input').fill(fields[0].value);
  const out=await recoveryMain([],win).runRealIrisAutofill(businessRecoveryPacket(fields),{id:'synthetic-idempotent'},'live');
  assert.equal(out.paused,false);assert.equal(out.result.results[0].status,'already_correct');
 });
});
test('fix45: technical retry never converts untouched fields to taxpayer takeover',()=>{
 const ctx=sandbox(['collectAcknowledgedAutofillItems','getAutofillReviewAction']);
 const out=ctx.collectAcknowledgedAutofillItems({finalStatus:'paused',pauseAction:'portal_business_retry',result:{autofill:{mode:'live',pendingItems:[{key:'3303:businessFields:Amount',kind:'business'}]}}});
 assert.equal(out.length,0);
});
test('fix45: legacy business takeover metadata is migrated away from salary, preserving confirmation',()=>{
 const ctx=sandbox(['collectAcknowledgedAutofillItems','getAutofillReviewAction']);
 const out=ctx.collectAcknowledgedAutofillItems({finalStatus:'paused',pauseAction:'portal_autofill_review',result:{autofill:{mode:'live',pendingItems:[{key:'3303:businessFields:Amount',kind:'salary',name:'Plant'}]}}});
 assert.equal(out[0].kind,'business');
});
test('fix45: technical UI retry has no acknowledgement and is labeled as automatic retry',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../components/tax/fbr-connect-client.tsx'),'utf8');
 const ack=source.slice(source.indexOf('const ACKNOWLEDGEMENT_TEXT'),source.indexOf('const ACKNOWLEDGEMENT_TEXT')+1800);
 assert.doesNotMatch(ack,/portal_business_retry/);assert.match(source,/Retry automatic filing/);
});
test('fix45: diagnostics distinguish pre-write verification failure from post-write readback mismatch',()=>{
 const report=require('../electron-connect/job-report');
 const before=report.buildAttentionReport([{irisCode:'3303',status:'unverified_target'}]);
 assert.match(before.items[0].what,/before typing/);assert.doesNotMatch(before.items[0].todo,/enter.*yourself/);
 const after=report.buildAttentionReport([{irisCode:'3303',status:'readback_mismatch'}]);
 assert.match(after.items[0].what,/landed/);
 const locked=report.buildAttentionReport([{irisCode:'3303',status:'no_editable_cell'}]);
 assert.doesNotMatch(locked.items[0].what,/does not let anyone/);
});
test('fix45: pre-write no-editable-cell refusal is rechecked and retried once automatically',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);const real=require('../electron-connect/iris-row-filler');let calls=0;
  const out=await recoveryMain([],win,{irisRowFiller:{...real,fillIrisRows:async(w,f,o)=>{
   if(++calls===1)return{results:f.map(x=>({...x,status:'no_editable_cell'}))};
   return real.fillIrisRows(w,f,o);
  }}}).runRealIrisAutofill(businessRecoveryPacket(bsFields().slice(0,1)),{id:'synthetic-prewrite-retry'},'live');
  assert.equal(calls,2);assert.equal(out.paused,false);assert.equal(out.result.summary.filled,1);
 });
});
test('fix45: post-write readback mismatch is not retried or certified as entered',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);const real=require('../electron-connect/iris-row-filler');let calls=0;
  const out=await recoveryMain([],win,{irisRowFiller:{...real,fillIrisRows:async(w,f,o)=>{
   calls++;return{results:f.map(x=>({...x,status:'readback_mismatch'}))};
  }}}).runRealIrisAutofill(businessRecoveryPacket(bsFields().slice(0,1)),{id:'synthetic-rejected-readback'},'live');
  assert.equal(calls,1);assert.equal(out.paused,true);assert.equal(out.result.summary.filled,0);
  assert.equal(out.pauseAction,'portal_autofill_review');assert.equal(out.result.pendingItems[0].kind,'business');
 });
});
test('fix45: a transient lock on focus is not bypassed; readiness recovery retries before writing',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);
  await page.evaluate(()=>document.querySelector('[id="3303"] input').addEventListener('focus',e=>{
    e.target.readOnly=true;setTimeout(()=>e.target.readOnly=false,100);
  },{once:true}));
  const out=await recoveryMain([],win).runRealIrisAutofill(businessRecoveryPacket(bsFields().slice(0,1)),{id:'synthetic-focus-lock'},'live');
  assert.equal(out.paused,false);assert.equal(out.result.summary.filled,1);
  assert.equal(await page.locator('[id="3303"] input').inputValue(),bsFields()[0].value);
 });
});
test('fix45: permanent lock appearing on focus leaves value empty and asks automatic retry, not manual entry',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);
  await page.evaluate(()=>document.querySelector('[id="3303"] input').addEventListener('focus',e=>e.target.readOnly=true,{once:true}));
  const out=await recoveryMain([],win).runRealIrisAutofill(businessRecoveryPacket(bsFields().slice(0,1)),{id:'synthetic-permanent-focus-lock'},'live');
  assert.equal(out.paused,true);assert.equal(out.pauseAction,'portal_business_retry');
  assert.equal(await page.locator('[id="3303"] input').inputValue(),'');
 });
});

// fix46 (Phase 1): stop policy, second pass and tracking. Synthetic fixtures
// only; no taxpayer data, no live portal, never Save/Calculate/Submit.
const adminField = {key:'3151:businessFields:Total Amount',irisCode:'3151',value:'240000',label:'Rent',column:'Total Amount',sourceGroup:'businessFields',ourCategory:'BUSINESS_RENT',ourDescription:'Rent'};
const twoSectionTour = () => ({complete:true,sections:[
  {id:'business_balance_sheet',mappingVerified:false,rows:bsFields().map(f=>({code:f.irisCode}))},
  {id:'business_admin',mappingVerified:false,rows:[{code:'3151'}]},
]});
test('fix46: a locked business section does not stop the run; the next section is filled and the locked one gets a second pass',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);
  await page.evaluate(()=>{
   document.querySelectorAll('#business_balance_sheet input:not(:disabled)').forEach(i=>i.readOnly=true);
   // IRIS finishes its work while the agent is busy elsewhere: the balance
   // grid unlocks when the agent comes back to it.
   let visits=0;
   [...document.querySelectorAll('.data-tab-left-btn')].find(b=>b.textContent==='Balance Sheet').addEventListener('click',()=>{
    if(++visits===1)document.querySelectorAll('#business_balance_sheet input:not(:disabled)').forEach(i=>i.readOnly=false);
   });
  });
  const fields=[...bsFields().slice(0,2),adminField];
  const out=await recoveryMain([],win,{lastSectionTour:twoSectionTour()}).runRealIrisAutofill(businessRecoveryPacket(fields),{id:'synthetic-second-pass'},'live');
  assert.equal(out.paused,false,JSON.stringify(out.result.fieldLog));
  assert.equal(out.result.summary.filled,3);
  const log=out.result.fieldLog;
  for(const f of bsFields().slice(0,2)){
   const entry=log.find(x=>x.code===f.irisCode);
   assert.equal(entry.outcome,'TYPED');assert.equal(entry.pass,2);assert.equal(entry.firstPass.status,'unverified_target');
   assert.equal(await page.locator(`[id="${f.irisCode}"] input`).inputValue(),f.value);
  }
  const rent=log.find(x=>x.code==='3151');
  assert.equal(rent.outcome,'TYPED');assert.equal(rent.pass,1);assert.equal(rent.source,'BUSINESS_RENT / Rent');assert.equal(rent.attempts,1);
  const steps=out.executionLog.map(e=>e.step);
  assert.ok(steps.includes('real_autofill_second_pass'));assert.ok(steps.includes('real_autofill_second_pass_done'));
  assert.ok(!steps.includes('real_autofill_stopped'));
  // every readiness wait is recorded with its reason(s) and duration
  assert.ok(out.result.waits.some(w=>w.sectionId==='business_balance_sheet'&&w.pass===1&&!w.ok&&w.status==='business_inputs_read_only'&&w.waitedMs>0&&w.trace.length>0));
  assert.ok(out.result.waits.some(w=>w.sectionId==='business_balance_sheet'&&w.pass===2&&w.ok));
  assert.equal(out.result.secondPass.attempted,2);
  assert.ok(!(await page.evaluate('actions')).some(a=>['SAVE','CALCULATE','SUBMIT'].includes(a)));
 });
});
test('fix46: a wrong taxpayer on screen is a SAFETY stop: nothing more is attempted',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);
  const fields=[...bsFields().slice(0,2),adminField];
  const out=await recoveryMain([],win,{lastSectionTour:twoSectionTour(),launchState:{accountReference:'9999999999999'}})
   .runRealIrisAutofill(businessRecoveryPacket(fields),{id:'synthetic-safety'},'live');
  assert.equal(out.paused,true);
  assert.equal(out.result.stopped,true);
  assert.equal(out.result.stopReason.status,'business_document_mismatch');
  assert.ok(out.executionLog.some(e=>e.step==='real_autofill_stopped'));
  assert.ok(!out.result.results.some(r=>r.irisCode==='3151'),'the next section was not attempted');
  assert.equal(out.result.secondPass.attempted,0,'no second pass after a safety stop');
  assert.equal(out.result.fieldLog.filter(f=>f.category==='SAFETY').length,2);
  for(const f of fields)assert.equal(await page.locator(`[id="${f.irisCode}"] input`).first().inputValue(),'');
 });
});
test('fix46: the retry message names the locked section and figures, the wait and the second attempt',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);
  await page.evaluate(()=>document.querySelectorAll('#business_balance_sheet input').forEach(i=>i.readOnly=true));
  const out=await recoveryMain([],win).runRealIrisAutofill(businessRecoveryPacket(bsFields().slice(0,2)),{id:'synthetic-message'},'live');
  assert.equal(out.pauseAction,'portal_business_retry');
  assert.match(out.pauseMessage,/2 business figure\(s\) were NOT typed/);
  const [a,b]=bsFields().slice(0,2).map(f=>f.irisCode);
  assert.ok(out.pauseMessage.includes(`business_balance_sheet: ${a} (business_inputs_read_only), ${b} (business_inputs_read_only)`),out.pauseMessage);
  assert.match(out.pauseMessage,/second automatic attempt/);
  assert.match(out.pauseMessage,/No manual-entry confirmation/);
  assert.equal(out.result.fieldLog.every(f=>f.outcome==='LOCKED'&&f.category==='PORTAL'&&f.pass===2),true);
 });
});
test('fix46/fix47: when the agent cannot verify and press Save, the result tells the taxpayer to press Save',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await activeBalance(page,win);
  await page.evaluate(()=>document.querySelectorAll('#business_balance_sheet input:not(:disabled)')[1].readOnly=true);
  const out=await recoveryMain([],win,{irisNavigation:{...navigation,waitForBusinessSectionReady:async()=>({ok:true,status:'business_section_ready'})}})
   .runRealIrisAutofill(businessRecoveryPacket(bsFields().slice(0,2)),{id:'synthetic-save-note'},'live');
  assert.equal(out.paused,true);
  assert.match(out.pauseMessage,/typed 1 figure\(s\) but did not press Save \(the Save step is not available in this agent build\): press Save in the FBR window/);
  assert.ok(!(await page.evaluate('actions')).includes('SAVE'));
 });
});
test('fix46 replay of the 14-Oct live run: all 25 business figures go in; IRIS adds 3238 after 3088 and shows it checked+disabled in the 3212 picker; no dialog is left open',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await page.evaluate((rows)=>{
   const grid=document.getElementById('business_deductions');
   const optional=Object.entries(rows).filter(([,s])=>s.optional);
   for(const [code] of optional)grid.querySelector(`[id="${code}"]`)?.remove();
   const rowHtml=(code,s)=>`<div class="tableRows dataRow" id="${code}"><div class="row-description-text">${s.label}</div><div class="columns-parent">${s.disabled.map(d=>`<div class="data-middle-child-wapper"><input type="text" ${d?'disabled':''}></div>`).join('')}</div></div>`;
   // IRIS adds the depreciation add-back row once Accounting Depreciation is typed.
   document.querySelector('[id="3088"] input').addEventListener('change',()=>{if(!grid.querySelector('[id="3238"]'))grid.insertAdjacentHTML('beforeend',rowHtml('3238',rows['3238']));});
   window.openPicker=()=>{
    actions.push('OPEN_PICKER');
    const cards=optional.map(([code,s],i)=>{const present=Boolean(grid.querySelector(`[id="${code}"]`));return `<div class="source-card"><input id="o${i}" type="checkbox" ${present?'checked disabled':''}><p>${s.label}</p></div>`;}).join('');
    document.body.insertAdjacentHTML('beforeend',`<mat-dialog-container role="dialog"><app-add-amount-code-row><h6>Add Inadmissible Deductions<mat-icon>close</mat-icon></h6><input type="text" placeholder="Search Amount Code/Description">${cards}<button onclick="addRows()">ADD</button><button onclick="actions.push('CANCEL_PICKER');this.closest('mat-dialog-container').remove()">Cancel</button></app-add-amount-code-row></mat-dialog-container>`);
   };
   window.addRows=()=>{
    actions.push('ADD_ROWS');
    const dialog=document.querySelector('mat-dialog-container');
    for(const box of dialog.querySelectorAll('input[type=checkbox]:checked:not(:disabled)')){
     const label=box.parentElement.querySelector('p').textContent;
     const [code,s]=optional.find(([,x])=>x.label===label);
     grid.insertAdjacentHTML('beforeend',rowHtml(code,s));
    }
    dialog.remove();
   };
   grid.insertAdjacentHTML('beforeend','<button class="btn-section-add" onclick="openPicker()">+ Inadmissible</button>');
   // Live IRIS keeps ONLY the active grid in the DOM (the 14-Oct log read 18,
   // 16, 13, 8 and 3 rows per section), so other grids are detached here too.
   const all=[...document.querySelectorAll('.business-grid')];
   const parent=all[0].parentElement;
   all.forEach(g=>{if(g.hidden)g.remove();});
   document.querySelectorAll('.data-tab-left-btn').forEach(button=>{
    const target=all.find(g=>g.id===button.getAttribute('onclick').match(/getElementById\('([^']+)'\)/)[1]);
    button.onclick=()=>{
     actions.push(target.id);
     document.querySelectorAll('.data-tab-left-btn').forEach(b=>b.classList.remove('active'));button.classList.add('active');
     all.forEach(g=>{g.hidden=g!==target;if(g!==target&&g.isConnected)g.remove();});
     if(!target.isConnected)parent.appendChild(target);
    };
   });
  },navigation.BUSINESS_CONTRACT.business_deductions.rows);
  // The 25 figures of job cmv88nghm001xiwc29ohin0hi (values from its report).
  const T='Total Amount',A='Amount';
  const spec=[['business_trading',T,[['3009','6000000'],['3039','300000'],['3059','1850000'],['3099','300000'],['3083','150000'],['3088','150000']]],
   ['business_balance_sheet',A,[['3303','600000'],['3315','300000'],['3312','150000'],['3319','100000'],['3321','100000'],['3348','50000'],['3352','5700000'],['3371','1000000'],['3384','400000'],['3398','200000']]],
   ['business_admin',T,[['3151','240000'],['3154','360000'],['3155','100000'],['3158','120000'],['3168','80000'],['3180','100000']]],
   ['business_other_revenues',T,[['3128','120000']]],
   ['business_deductions',T,[['3212','80000']]],
   ['business_adjustments',T,[['327025','50000']]]];
  const fields=spec.flatMap(([,column,list])=>list.map(([code,value])=>({key:`${code}:businessFields:${column}`,irisCode:code,value,column,label:code,sourceGroup:'businessFields',leftPanel:'Business'})));
  assert.equal(fields.length,25);
  const tour={complete:true,sections:spec.map(([id,,list])=>({id,mappingVerified:false,rows:list.map(([code])=>({code}))}))};
  const out=await recoveryMain([],win,{lastSectionTour:tour,irisBusinessRowDriver:require('../electron-connect/iris-business-row-driver')}).runRealIrisAutofill(businessRecoveryPacket(fields),{id:'synthetic-replay-14oct',type:'tax_assisted_filing'},'live');
  assert.equal(out.paused,false,JSON.stringify(out.result.fieldLog.filter(f=>f.outcome!=='TYPED')));
  assert.equal(out.result.summary.filled,25);
  assert.equal(out.result.fieldLog.length,25);
  assert.ok(out.result.fieldLog.every(f=>f.outcome==='TYPED'&&f.pass===1));
  for(const [id,,list] of spec){
   const moved=await navigation.navigateToSection(win,{sectionId:id,taxYear:2026,taxpayerIdentifier:'1234567890123'});assert.ok(moved.ok,id);
   for(const [code,value] of list)assert.equal(await page.locator(`[id="${code}"] input`).first().inputValue(),value,code);
  }
  assert.equal(await page.locator('mat-dialog-container').count(),0,'no dialog left open');
  const picker=out.result.pickers[0];
  assert.equal(picker.ok,true);
  assert.ok(picker.diagnostics.optionsBefore.checkedDisabled.includes('Add Backs Accounting Depreciation'));
  assert.deepEqual(picker.diagnostics.changedOptions,['Add Backs u/s 21(h) Personal Expenditure']);
  assert.deepEqual(picker.diagnostics.rowsAdded.map(r=>r.code),['3212']);
  const actions=await page.evaluate('actions');
  assert.equal(actions.filter(a=>a==='ADD_ROWS').length,1);
  assert.ok(!actions.includes('CANCEL_PICKER'));
  assert.ok(!actions.some(a=>['SAVE','CALCULATE','SUBMIT'].includes(a)));
  assert.match(out.executionLog.find(e=>e.step==='autofill_handoff_complete')?.detail||'',/press Save in the FBR window/);
 });
});

// DP-4 (fix53): a v7 packet with rows of BOTH deduction pickers. main.js makes
// each row ready through its own picker (one at a time), then types it; a row
// whose card is missing is never typed and the others still are.
async function fix53DeductionPage(page,{missingCards=[]}={}){
 await page.evaluate(({rows,missingCards})=>{
  const grid=document.getElementById('business_deductions');
  const optional=Object.entries(rows).filter(([,s])=>s.optional);
  const admissible=['3245','3246','3247','3248','3250','3254','3255','3256','3257','3258'];
  for(const [code] of optional)grid.querySelector(`[id="${code}"]`)?.remove();
  const rowHtml=(code,s)=>`<div class="tableRows dataRow" id="${code}"><div class="row-description-text">${s.label}</div><div class="columns-parent">${s.disabled.map(d=>`<div class="data-middle-child-wapper"><input type="text" ${d?'disabled':''}></div>`).join('')}</div></div>`;
  window.openPicker=(kind)=>{
   actions.push(kind==='admissible'?'OPEN_ADMISSIBLE':'OPEN_INADMISSIBLE');
   const list=optional.filter(([code])=>(kind==='admissible')===admissible.includes(code)&&!missingCards.includes(code));
   const cards=list.map(([code,s],i)=>{const present=Boolean(grid.querySelector(`[id="${code}"]`));return `<div class="source-card" data-code="${code}"><input id="${kind}${i}" type="checkbox" ${present?'checked disabled':''}><p>${s.label}</p></div>`;}).join('');
   document.body.insertAdjacentHTML('beforeend',`<mat-dialog-container role="dialog"><app-add-amount-code-row><h6>${kind==='admissible'?'Add Admissible Deductions':'Add Inadmissible Deductions'}<mat-icon>close</mat-icon></h6><input type="text" placeholder="Search Amount Code/Description">${cards}<button onclick="addRows()">ADD</button><button onclick="actions.push('CANCEL_PICKER');this.closest('mat-dialog-container').remove()">Cancel</button></app-add-amount-code-row></mat-dialog-container>`);
  };
  window.addRows=()=>{
   const dialog=document.querySelector('mat-dialog-container');
   for(const box of dialog.querySelectorAll('input[type=checkbox]:checked:not(:disabled)')){
    const code=box.closest('.source-card').dataset.code;actions.push(`ADD_${code}`);
    grid.insertAdjacentHTML('beforeend',rowHtml(code,rows[code]));
   }
   dialog.remove();
  };
  grid.insertAdjacentHTML('beforeend','<button class="btn-section-add" onclick="openPicker(\'inadmissible\')">+ Inadmissible</button><button class="btn-section-add" onclick="openPicker(\'admissible\')">+ Admissible</button>');
 },{rows:navigation.BUSINESS_CONTRACT.business_deductions.rows,missingCards});
}
const fix53Fields=()=>[['3211','30000'],['3212','50000'],['3256','20000']].map(([code,value])=>({key:`${code}:businessFields:Total Amount`,irisCode:code,value,column:'Total Amount',label:navigation.BUSINESS_CONTRACT.business_deductions.rows[code].label,irisDescription:navigation.BUSINESS_CONTRACT.business_deductions.rows[code].label,sourceGroup:'businessFields',leftPanel:'Business',leftSection:'Inadmissible/Admissible Deductions'}));
const fix53Packet=(fields)=>({filingPacket:{taxYear:2026,snapshot:{business:{version:'business-entry-v7',pending:[]},portalFieldMap:fields}}});
const fix53Tour={complete:true,sections:[{id:'business_deductions',mappingVerified:false,rows:[{code:'3211'},{code:'3212'},{code:'3256'}]}]};
test('fix53: a v7 packet adds rows of both deduction pickers one at a time and types each figure',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await fix53DeductionPage(page);
  const out=await recoveryMain([],win,{lastSectionTour:fix53Tour,irisBusinessRowDriver:require('../electron-connect/iris-business-row-driver')}).runRealIrisAutofill(fix53Packet(fix53Fields()),{id:'synthetic-dp4',type:'tax_assisted_filing'},'live');
  assert.equal(out.result.summary.filled,3,JSON.stringify(out.result.fieldLog));
  for(const [code,value] of [['3211','30000'],['3212','50000'],['3256','20000']])assert.equal(await page.locator(`[id="${code}"] input`).first().inputValue(),value,code);
  const pickers=JSON.parse(JSON.stringify(out.result.pickers));
  assert.deepEqual(pickers.map(p=>[p.code,p.ok,p.reason]),[['3211',true,'deduction_row_added_and_structure_verified'],['3212',true,'personal_reason_added_and_structure_verified'],['3256',true,'deduction_row_added_and_structure_verified']]);
  assert.deepEqual(pickers.map(p=>p.diagnostics.changedOptions),[[navigation.BUSINESS_CONTRACT.business_deductions.rows['3211'].label],['Add Backs u/s 21(h) Personal Expenditure'],['Tax (Loss) on Sale of Assets']]);
  const actions=(await page.evaluate('actions')).filter(a=>/^(OPEN_|ADD_|CANCEL)/.test(a));
  assert.deepEqual(actions,['OPEN_INADMISSIBLE','ADD_3211','OPEN_INADMISSIBLE','ADD_3212','OPEN_ADMISSIBLE','ADD_3256']);
  assert.equal(await page.locator('mat-dialog-container').count(),0);
  assert.ok(!(await page.evaluate('actions')).some(a=>['SAVE','CALCULATE','SUBMIT'].includes(a)));
 });
});
test('fix53: a row whose card is missing is never typed; the rows made ready before it are typed',async()=>{
 await withPage(businessFixture(),async(page,win)=>{
  await fix53DeductionPage(page,{missingCards:['3212']});
  const out=await recoveryMain([],win,{lastSectionTour:fix53Tour,irisBusinessRowDriver:require('../electron-connect/iris-business-row-driver')}).runRealIrisAutofill(fix53Packet(fix53Fields()),{id:'synthetic-dp4-missing',type:'tax_assisted_filing'},'live');
  assert.equal(await page.locator('[id="3211"] input').first().inputValue(),'30000');
  assert.equal(await page.locator('[id="3212"]').count(),0);
  const log=Object.fromEntries(out.result.fieldLog.map(f=>[f.code||f.irisCode,f]));
  assert.equal(log['3211'].outcome,'TYPED',JSON.stringify(out.result.fieldLog));
  assert.notEqual(log['3212'].outcome,'TYPED');
  assert.notEqual(log['3256'].outcome,'TYPED');
  const first=JSON.parse(JSON.stringify(out.result.pickers)).filter(p=>p.pass===1);
  assert.deepEqual(first.map(p=>[p.code,p.ok,p.reason]),[['3211',true,'deduction_row_added_and_structure_verified'],['3212',false,'personal_reason_not_unique']]);
  assert.ok(out.executionLog.some(e=>e.step==='business_addback_setup_problem'&&/not attempted.*3256/.test(e.detail)),JSON.stringify(out.executionLog.filter(e=>/addback/.test(e.step))));
  assert.equal(await page.locator('mat-dialog-container').count(),0,'the picker the agent opened was cancelled');
  assert.ok(!(await page.evaluate('actions')).some(a=>['SAVE','CALCULATE','SUBMIT'].includes(a)));
 });
});

// ---------------------------------------------------------------------------
// Phase 2 (fix47): IRIS totals check + the one end-of-run Save, inside the real
// runRealIrisAutofill flow. The census is read from the fixture page itself;
// the Save bar copies the IRIS lower-bar markup (capture 02). The fixture's
// own plain Save/Calculate/Submit buttons must stay untouched.
// ---------------------------------------------------------------------------
const fix47Census = require('../electron-connect/iris-tour-census');
const fix47Save = require('../electron-connect/iris-save-draft');
function fix47PageCensus(page, mutate = null) {
  return async (_win, options = {}) => {
    const views = await page.evaluate(() => Array.from(document.querySelectorAll('.business-grid')).map((grid) => ({
      key: `Business > ${grid.id}`,
      headings: ['Description', 'Code', ...Array.from(grid.querySelectorAll('.heading-bar strong')).slice(2).map((s) => s.textContent.trim())],
      rows: Array.from(grid.querySelectorAll('.dataRow')).map((row) => ({
        code: row.id,
        description: (row.querySelector('.row-description-text')?.textContent || '').replace(/\s+/g, ' ').trim(),
        cells: Array.from(row.querySelectorAll('input')).map((input) => ({ editable: !input.disabled && !input.readOnly, value: input.value })),
      })),
    })));
    const tour = { label: options.label, complete: true, stoppedReason: null, views };
    return mutate ? mutate(tour, String(options.label || '')) : tour;
  };
}
async function fix47LowerBar(page, toast = 'Record saved successfully') {
  await page.evaluate((message) => {
    const bar = document.createElement('div');
    bar.innerHTML =
      '<button class="correspondance-lowermenu-bar-item" data-act="CLOSE_BAR"><i class="fa fa-times-circle"></i>Close </button>' +
      '<button class="correspondance-lowermenu-bar-item" data-act="PRINT_BAR"><i class="fa fa-print"></i>Print </button>' +
      '<button class="correspondance-lowermenu-bar-item" data-act="SUBMIT_BAR"><i class="fa fa-check-circle"></i>Submit </button>' +
      '<span><button class="correspondance-lowermenu-bar-item" data-act="SAVE_BAR"><i class="fa fa-save"></i>Save </button></span>';
    document.body.appendChild(bar);
    bar.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
      actions.push(button.dataset.act);
      if (button.dataset.act !== 'SAVE_BAR') return;
      setTimeout(() => {
        const note = document.createElement('div');
        note.className = 'toast-message';
        note.textContent = message;
        document.body.appendChild(note);
        setTimeout(() => note.remove(), 1500);
      }, 50);
    }));
  }, toast);
}
const fix47Overrides = (page, mutate, extra = {}) => ({
  irisNavigation: { ...navigation, waitForBusinessSectionReady: async () => ({ ok: true, status: 'business_section_ready' }) },
  irisTourCensus: { ...fix47Census, runCensusTour: fix47PageCensus(page, mutate) },
  getCensusTourEnabled: () => true,
  writeCensusToDisk: () => null,
  ...extra,
});
test('fix47: a clean, verified run presses the IRIS lower-bar Save exactly once at the end; Submit/Calculate untouched; the result says saved', async () => {
 await withPage(businessFixture(), async (page, win) => {
  await activeBalance(page, win);
  await fix47LowerBar(page);
  const out = await recoveryMain([], win, fix47Overrides(page, null, { irisSaveDraft: fix47Save }))
   .runRealIrisAutofill(businessRecoveryPacket(bsFields().slice(0, 3)), { id: 'synthetic-save-once', type: 'tax_assisted_filing' }, 'live');
  const actions = await page.evaluate('actions');
  assert.equal(actions.filter((a) => a === 'SAVE_BAR').length, 1, 'one Save');
  assert.ok(!actions.some((a) => ['SAVE', 'CALCULATE', 'SUBMIT', 'SUBMIT_BAR', 'CLOSE_BAR', 'PRINT_BAR'].includes(a)));
  assert.equal(out.result.save.status, 'saved_confirmed');
  assert.equal(out.result.save.message, 'Record saved successfully');
  // Built inside the VM realm: compare the plain data.
  assert.deepEqual(JSON.parse(JSON.stringify(out.result.save.afterSave)), { complete: true, stoppedReason: null, match: 3, mismatch: 0, notSeen: 0 });
  const steps = out.executionLog.map((e) => e.step);
  assert.ok(steps.indexOf('iris_save_start') > steps.indexOf('real_autofill_readback_after_tab_summary'), 'Save only after the readback');
  assert.ok(steps.includes('iris_save_readback'));
  const done = out.executionLog.find((e) => e.step === 'autofill_handoff_complete')?.detail || '';
  assert.match(done, /Nothing was submitted, calculated or paid\. The agent pressed Save once in IRIS at the end \(IRIS said: "Record saved successfully"\)\./);
 });
});
test('fix47: a figure that reads back differently after the tab switch blocks the Save, and the taxpayer is told why', async () => {
 await withPage(businessFixture(), async (page, win) => {
  await activeBalance(page, win);
  await fix47LowerBar(page);
  const fields = bsFields().slice(0, 2);
  const mutate = (tour, label) => {
   if (!label.startsWith('end')) return tour;
   for (const view of tour.views) for (const row of view.rows)
    if (row.code === fields[0].irisCode) row.cells = row.cells.map((cell) => ({ ...cell, value: cell.value ? '999' : cell.value }));
   return tour;
  };
  const out = await recoveryMain([], win, fix47Overrides(page, mutate, { irisSaveDraft: fix47Save }))
   .runRealIrisAutofill(businessRecoveryPacket(fields), { id: 'synthetic-save-blocked', type: 'tax_assisted_filing' }, 'live');
  assert.ok(!(await page.evaluate('actions')).includes('SAVE_BAR'), 'no Save after a mismatch');
  assert.equal(out.result.save.status, 'not_attempted');
  assert.match(out.result.save.reason, /1 figure\(s\) did not read back the same after the tab switch/);
  assert.match(out.pauseMessage, /did not read back the same after the tab switch/);
  assert.match(out.pauseMessage, /press Save in the FBR window/);
  assert.match(out.pauseMessage, /Nothing was saved, submitted, calculated, or paid\./);
  assert.ok(out.executionLog.some((e) => e.step === 'iris_save_skipped'));
 });
});
test('fix47: a missing post-tab row also blocks Save (not just a value mismatch)', async () => {
 await withPage(businessFixture(), async (page, win) => {
  await activeBalance(page, win);
  await fix47LowerBar(page);
  const fields = bsFields().slice(0, 2);
  const mutate = (tour, label) => {
   if (label.startsWith('end')) {
    const code = String(fields[0].irisCode);
    for (const view of tour.views) view.rows = view.rows.filter((row) => String(row.code) !== code);
   }
   return tour;
  };
  const out = await recoveryMain([], win, fix47Overrides(page, mutate, { irisSaveDraft: fix47Save }))
   .runRealIrisAutofill(businessRecoveryPacket(fields), { id: 'synthetic-save-row-not-seen' }, 'live');
  assert.ok(!(await page.evaluate('actions')).includes('SAVE_BAR'), 'no Save when an entered row is not seen');
  assert.equal(out.result.save.status, 'not_attempted');
  assert.match(out.result.save.reason, /did not read back the same after the tab switch/);
  assert.ok(out.executionLog.some((e) => e.step === 'iris_save_skipped'));
 });
});
test('fix47: IRIS computed rows are compared with the packet expectations; differences, skipped codes and the app estimate are logged', async () => {
 await withPage(businessFixture(), async (page, win) => {
  await activeBalance(page, win);
  const packet = businessRecoveryPacket(bsFields().slice(0, 1));
  Object.assign(packet.filingPacket.snapshot.business, {
   expectedIrisTotals: { version: 'iris-expect-v1', basis: 'typed_business_fields', rows: [
    { code: '3349', label: 'Total Assets', column: 'total', expected: 0, formula: 'typed assets', proven: true },
    { code: '3399', label: 'Total Equity / Liabilities', column: 'total', expected: 5, formula: 'typed liabilities', proven: false },
   ], skipped: [{ code: '9100', reason: 'other income heads are part of this return' }] },
   computedEstimate: { taxableIncome: 1000 },
   pending: [{ key: 'balanceSheet.land', amount: 800000, reason: 'manual' }],
  });
  const out = await recoveryMain([], win, fix47Overrides(page, null))
   .runRealIrisAutofill(packet, { id: 'synthetic-totals', type: 'tax_assisted_filing' }, 'live');
  assert.equal(out.result.totalsCheck.matched, 1);
  assert.equal(out.result.totalsCheck.differs, 1);
  const detail = (step) => out.executionLog.find((e) => e.step === step)?.detail || '';
  assert.match(detail('iris_totals_check'), /1 match, 1 differ, 0 not seen/);
  assert.match(detail('iris_totals_differs'), /3399 Total Equity \/ Liabilities: IRIS blank, expected 5 \(typed liabilities\); this formula is not yet confirmed on a live return/);
  assert.match(detail('iris_totals_not_checked'), /9100 not checked: other income heads/);
  assert.match(detail('iris_vs_app_estimate'), /taxable income 1,000; IRIS after the typed figures: not shown\. Not in IRIS yet \(manual items\): balanceSheet\.land 800,000/);
  assert.equal(out.result.save.reason, 'the Save step is not available in this agent build');
 });
});
test('fix47: the handoff summary carries a compact totals check and the Save state (no formulas); the label says saved', () => {
  const { buildHandoffScopeSummary } = sandbox(['buildHandoffScopeSummary']);
  const scope = buildHandoffScopeSummary({ total: 2, filled: 2, skipped: 0 }, false, [], {
   business: { total: 2, filled: 2, skipped: 0, mode: 'live', pending: [] },
   irisCheck: { available: true, matched: 1, differs: 1, notSeen: 0, rows: [
    { code: '3349', label: 'Total Assets', iris: '', expected: 0, status: 'match', proven: true, formula: 'x' },
    { code: '3399', label: 'Total Equity / Liabilities', iris: '', expected: 5, status: 'differs', proven: false, formula: 'y' },
   ] },
   appEstimate: { taxableIncome: 1000, irisTaxableIncome: null },
   save: { status: 'saved_confirmed', clicked: true, at: '2026-10-15T09:00:00.000Z', message: 'Record saved successfully', reason: null, afterSave: { complete: true, match: 2, mismatch: 0, notSeen: 0 } },
  });
  assert.equal(scope.irisCheck.available, true);
  assert.equal(scope.irisCheck.rows.length, 2);
  assert.equal(scope.irisCheck.rows[1].proven, false);
  assert.equal('formula' in scope.irisCheck.rows[0], false);
  assert.equal(scope.irisCheck.appTaxableIncome, 1000);
  assert.equal(scope.save.status, 'saved_confirmed');
  assert.equal(scope.save.afterSave.match, 2);
  assert.match(scope.label, /Saved once in FBR by the agent/);
  const plain = buildHandoffScopeSummary({ total: 1, filled: 1, skipped: 0 }, false, [], {});
  assert.equal('irisCheck' in plain, false);
  assert.equal('save' in plain, false);
  assert.doesNotMatch(plain.label, /Saved once/);
});

test('business identity verification is shown separately from numeric field completion',()=>{
 const base={salary:'not_entered',employers:'none',business:{preparedFields:13,filledFields:13,status:'partial_manual_required',pendingItems:[]}};
 const ok=renderHandoffCompletion({...base,businessDetails:{required:true,verified:true}}).text;
 assert.match(ok,/Business identity and principal activity/);assert.match(ok,/match the saved Business Details row/);
 const bad=renderHandoffCompletion({...base,businessDetails:{required:true,verified:false,readback:{reason:'business_not_listed_on_readback'}}}).text;
 assert.match(bad,/Business Details is not verified/);assert.match(bad,/business_not_listed_on_readback/);
});

for (const scenario of ['before-save-missing','after-save-missing','verified']) {
 test(`business identity gates real autofill completion and return Save: ${scenario}`,async()=>{
  await withPage(businessFixture(),async(page,win)=>{
   await activeBalance(page,win);await fix47LowerBar(page);
   const calls=[];
   const identityDriver={FIX_VERSION:'test-identity',describeBusinessDetailsOutcome:o=>`${o.status}: ${o.reason}`,fillBusinessDetailsTab:async(_win,_plan,opts)=>{
    calls.push(opts.verifyOnly===true?'read':'entry');
    const ok=!(scenario==='before-save-missing'&&calls.length>=2)&&!(scenario==='after-save-missing'&&calls.length===3);
    return {ok,status:ok?(opts.verifyOnly?'already_correct':'filled'):'not_entered',reason:ok?'business_already_listed':'business_not_listed_on_readback'};
   }};
   const packet=businessRecoveryPacket(bsFields().slice(0,1));
   packet.filingPacket.snapshot.business.version='business-entry-v7';
   packet.filingPacket.snapshot.business.businessDetails={version:'business-details-v1',businessName:'SYNTHETIC BUSINESS',principalActivity:'Services',table:{startDate:'01-Jul-2024'}};
   const out=await recoveryMain([],win,fix47Overrides(page,null,{irisSaveDraft:fix47Save,irisBusinessDetailsDriver:identityDriver})).runRealIrisAutofill(packet,{id:`local-identity-${scenario}`,type:'tax_assisted_filing'},'live');
   const actions=await page.evaluate('actions');
   assert.equal(out.result.summary.filled,1,'numeric field remains independently verified');
   assert.equal(out.result.businessDetails.verified,scenario==='verified');
   assert.equal(out.paused,scenario!=='verified');
   assert.equal(actions.filter(a=>a==='SAVE_BAR').length,scenario==='before-save-missing'?0:1);
   assert.deepEqual(calls,scenario==='before-save-missing'?['entry','read']:['entry','read','read']);
   if(scenario!=='verified'){assert.equal(out.pauseAction,'portal_business_retry');assert.match(out.pauseMessage,/Business Details is NOT verified/)}
  });
 });
}

// Timing fix (previous-return follow-up): the TY2026 economic-transactions gate
// ("Please select your sources of income...") renders asynchronously after the
// period Continue click. The setup loop must wait (bounded) for it instead of
// pausing as "unclassified", so the packet-driven gate handler fills sources
// and residency. Static assertion over the module source.
test("new-return setup waits (bounded) for the economic-transactions gate to finish rendering", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "electron-connect", "iris-navigation.js"),
    "utf8",
  );
  const idx = src.indexOf("const setup = describeSetupSnapshot(snapshot);");
  assert.ok(idx > 0, "setup loop classify anchor present");
  const before = src.slice(Math.max(0, idx - 1600), idx);
  assert.match(before, /wait < 30 &&/);
  assert.match(before, /economicTransactionsGate\?\.present/);
  assert.match(before, /describeSetupSnapshot\(snapshot\)\.current\?\.stage/);
  assert.match(before, /await delay\(500\)/);
});
