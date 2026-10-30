"use strict";

const AGENT_NAME = "TR Filing Agent";
const APP_ID = "com.taxrocket.portal-agent";
// Keep the existing identity/profile names: rebranding must not reset sign-in.
const LEGACY_PROFILE_NAMES = ["taxrocket-portal-agent", "Tax Rocket Portal Agent"];

function configureAppBranding({ app, fs, path, platform = process.platform }) {
  const appData = app.getPath("appData");
  const currentProfile = app.getPath("userData");
  const candidates = [...new Set([
    ...LEGACY_PROFILE_NAMES.map((name) => path.join(appData, name)),
    currentProfile,
  ])];
  // Prefer a profile containing the existing trusted-device state. Do not copy,
  // delete or decrypt it. Sessions and persistent partitions remain alongside it.
  const userDataPath =
    candidates.find((dir) => fs.existsSync(path.join(dir, "agent-state.json"))) ||
    candidates.find((dir) => fs.existsSync(dir)) ||
    path.join(appData, LEGACY_PROFILE_NAMES[0]);
  fs.mkdirSync(userDataPath, { recursive: true });
  app.setPath("userData", userDataPath);
  app.setPath("sessionData", userDataPath);
  app.setName(AGENT_NAME);
  if (platform === "win32") app.setAppUserModelId(APP_ID);
  return userDataPath;
}

function brandWindow(windowInstance, title = AGENT_NAME) {
  windowInstance.setTitle(title);
  // A remote IRIS document must not replace the branded native-window title.
  windowInstance.on("page-title-updated", (event) => event.preventDefault());
  return windowInstance;
}

module.exports = { AGENT_NAME, APP_ID, LEGACY_PROFILE_NAMES, configureAppBranding, brandWindow };
