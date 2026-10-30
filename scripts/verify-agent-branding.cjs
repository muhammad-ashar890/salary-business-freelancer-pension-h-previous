#!/usr/bin/env node
"use strict";
// Offline branding/config/profile tests; no Electron launch or portal traffic.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const root = path.join(__dirname, "..");
const dir = path.join(root, "electron-connect");
const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
const lock = JSON.parse(
  fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"),
);
const { AGENT_NAME, APP_ID, configureAppBranding, brandWindow } = require(
  path.join(dir, "branding.js"),
);

test("product, executable, installer and shortcuts use TR Filing Agent", () => {
  assert.equal(AGENT_NAME, "TR Filing Agent");
  assert.equal(pkg.productName, AGENT_NAME);
  assert.equal(pkg.build.productName, AGENT_NAME);
  assert.equal(pkg.build.win.executableName, AGENT_NAME);
  assert.equal(
    pkg.build.win.artifactName,
    "TR-Filing-Agent-Setup-${version}.${ext}",
  );
  assert.equal(pkg.build.nsis.shortcutName, AGENT_NAME);
  assert.equal(pkg.build.nsis.uninstallDisplayName, AGENT_NAME);
  assert.equal(pkg.build.win.signAndEditExecutable, true);
  assert.equal(pkg.version, "1.0.5");
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
});

test("connect identity, IPC, build includes and download instructions stay compatible", () => {
  assert.equal(pkg.name, "taxrocket-portal-agent");
  assert.equal(pkg.build.appId, APP_ID);
  assert.equal(APP_ID, "com.taxrocket.portal-agent");
  assert.deepEqual(pkg.build.protocols[0].schemes, ["taxrocket-connect"]);
  assert.equal(pkg.build.protocols[0].name, AGENT_NAME);
  assert.ok(pkg.build.files.includes("branding.js"));
  assert.ok(pkg.build.files.includes("iris-services-contract.json"));
  for (const file of pkg.build.files)
    assert.ok(fs.existsSync(path.join(dir, file)), file);
  assert.match(
    fs.readFileSync(path.join(dir, "preload.js"), "utf8"),
    /exposeInMainWorld\("taxRocketAgent"/,
  );
  const route = fs.readFileSync(
    path.join(root, "app/api/downloads/taxrocket-agent/windows/route.ts"),
    "utf8",
  );
  assert.ok(route.includes(`TR-Filing-Agent-Setup-${pkg.version}.exe`));
});

function fakeProfile(existing, platform = "win32") {
  const base = path.join(path.sep, "synthetic", "app-data");
  const current = path.join(base, AGENT_NAME);
  const files = new Set(existing.map((p) => path.join(base, p)));
  const calls = [];
  const app = {
    getPath: (key) => (key === "appData" ? base : current),
    setPath: (key, value) => calls.push([key, value]),
    setName: (value) => calls.push(["name", value]),
    setAppUserModelId: (value) => calls.push(["appId", value]),
  };
  const fakeFs = {
    existsSync: (p) => files.has(p),
    mkdirSync: (p, opts) => calls.push(["mkdir", p, opts]),
  };
  const selected = configureAppBranding({ app, fs: fakeFs, path, platform });
  assert.ok(
    calls.some(([key, value]) => key === "name" && value === AGENT_NAME),
  );
  assert.ok(
    calls.some(([key, value]) => key === "userData" && value === selected),
  );
  assert.ok(
    calls.some(([key, value]) => key === "sessionData" && value === selected),
  );
  assert.equal(
    calls.some(([key]) => key === "appId"),
    platform === "win32",
  );
  return { selected, base, calls };
}

test("existing package-name profile/trusted-device state is reused", () => {
  const r = fakeProfile(["taxrocket-portal-agent/agent-state.json"]);
  assert.equal(r.selected, path.join(r.base, "taxrocket-portal-agent"));
});
test("existing old product-name profile is reused", () => {
  const r = fakeProfile(["Tax Rocket Portal Agent/agent-state.json"]);
  assert.equal(r.selected, path.join(r.base, "Tax Rocket Portal Agent"));
});
test("profile containing state wins over another empty existing directory", () => {
  const r = fakeProfile([
    "taxrocket-portal-agent",
    "Tax Rocket Portal Agent/agent-state.json",
  ]);
  assert.equal(r.selected, path.join(r.base, "Tax Rocket Portal Agent"));
});
test("existing profile without agent-state (including session-only data) is reused", () => {
  const r = fakeProfile(["Tax Rocket Portal Agent"]);
  assert.equal(r.selected, path.join(r.base, "Tax Rocket Portal Agent"));
});
test("fresh install uses stable internal profile; non-Windows skips Windows identity API", () => {
  const r = fakeProfile([], "linux");
  assert.equal(r.selected, path.join(r.base, "taxrocket-portal-agent"));
});
test("an already branded profile is retained if it holds the state", () => {
  const r = fakeProfile(["TR Filing Agent/agent-state.json"]);
  assert.equal(r.selected, path.join(r.base, AGENT_NAME));
});
test("native-window title prevents remote document overwrite", () => {
  let title,
    handler,
    prevented = false;
  const win = {
    setTitle: (t) => {
      title = t;
    },
    on: (event, fn) => {
      assert.equal(event, "page-title-updated");
      handler = fn;
    },
  };
  assert.equal(brandWindow(win), win);
  assert.equal(title, AGENT_NAME);
  handler({
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  brandWindow(win, `${AGENT_NAME} — IRIS`);
  assert.equal(title, "TR Filing Agent — IRIS");
});
test("all app window types, renderer, default menu and duplicate-instance dialog are branded", () => {
  const main = fs.readFileSync(path.join(dir, "main.js"), "utf8");
  assert.ok(
    main.indexOf("configureAppBranding({ app, fs, path })") <
      main.indexOf("const stateStore ="),
  );
  for (const snippet of [
    "brandWindow(mainWindow)",
    "brandWindow(child,",
    "brandWindow(windowInstance,",
    "brandWindow(\n    workerWindow,",
    "Menu.setApplicationMenu(null)",
    "const LOCAL_AGENT_CONFIRMATION_TITLE = AGENT_NAME",
  ])
    assert.ok(main.includes(snippet), snippet);
  assert.ok(!main.includes("Close every TaxRocket / Electron window"));
  const html = fs.readFileSync(path.join(dir, "renderer.html"), "utf8");
  assert.match(html, /<title>TR Filing Agent<\/title>/);
  assert.match(html, /class="eyebrow">TR Filing Agent<\/p>/);
});
