# TR Filing Agent — Windows Installer

The desktop agent's assisted-filing flow is developed and tested by running the Electron app **from source** (`electron-connect\start-live.ps1` — see [`electron-connect/README.md`](electron-connect/README.md)). The Windows `.exe` installer is built from the same folder when a packaged build is needed; a development/testing machine does **not** need the installer.

A **code-signing certificate is not required** for this development build. Windows SmartScreen may show a warning the first time — select _More info → Run anyway_.

## Build on Windows

First close `npm run dev` and any running TR Filing Agent instance — a file lock may cause the build to fail.

```bat
cd path\to\tax-rocket-electron\electron-connect
npm install
npm run dist:win
```

- **Output:** `electron-connect\dist\TR-Filing-Agent-Setup-<version>.exe` (e.g. `TR-Filing-Agent-Setup-1.0.5.exe`). The version comes from `electron-connect\package.json` (`version`) — bump it there before building a new release.
- The installer creates Desktop and Start-Menu shortcuts named **TR Filing Agent** and registers the `taxrocket-connect://` deep-link protocol.
- First build downloads Electron and NSIS binaries and may take several minutes.
- Only the files listed under `build.files` in `electron-connect\package.json` are packaged. **Any new runtime file must be added to that list**, otherwise the installed app fails at runtime while source runs keep working.

## Test after installation

1. Install by double-clicking the `.exe`, then open **TR Filing Agent** from the Start Menu.
2. Start the web app (`npm run dev` in the repository root) with the live-entry server key set if the test needs live mode (`TAXROCKET_ALLOW_LIVE_FILING=true`).
3. In the web app, choose **Create Desktop Session → Open Desktop App**.
4. Sign in to the real FBR IRIS window locally and run a supervised job.
5. Check `C:\Users\<user>\TaxRocketAgentLogs\latest-job.txt` — its first line must show the current build tag.
