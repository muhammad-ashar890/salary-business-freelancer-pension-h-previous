# TR Filing Agent — Electron Desktop Agent

The **TR Filing Agent** is TaxRocket's trusted Windows desktop agent. It opens the real **FBR IRIS** portal (`https://iris.fbr.gov.pk/`) in a local Electron window, lets the taxpayer sign in there themselves, and then types **only the figures from the taxpayer-approved filing packet** into the return — verifying the taxpayer, the return, and every row/column before typing, and reading every figure back afterwards.

It never presses **Calculate, Submit, Prepare PSID,** or any payment control, and it never sees or stores the taxpayer's password, OTP, CAPTCHA, or PIN.

> **Current build:** package version `1.0.5` · agent build tag `pension-services-multifiling-20261106a`
>
> For the product as a whole (web flow, modules, tax rules, setup), see the [repository README](../README.md). This file is only about the desktop agent.

Supported Tax Year 2026 IRIS routes include **Salary, Business, Freelancer / Services, and Pension**. Services is deliberately limited to exact Myself source sets: **Services alone**, **Salary + Services**, **Pension + Services**, **Business + Services**, **Salary + Business + Services**, or **Salary + Pension + Services**. Other Services combinations fail closed. The agent enters only approved, mapped fields and pauses on anything outside those route contracts; support in code/tests is not a claim of live FBR verification.

The **Salary + Business + Services** route requires the versioned `snapshot.salaryBusinessServices` envelope in addition to the separate Business and Services packets. It uses that envelope's fold-aware Computations plan, includes Computations in scoped readback, retains full Business-grid reporting and reports Services-backed/shared-cell counts separately. A missing or stale triple envelope deactivates the route before entry. The new triple has passed offline packet/Electron contracts but still requires supervised dry/live IRIS verification.

---

## Quick start (run from source)

During the pilot the agent is run from source — **no installer build is needed for testing**. Prerequisites: Node.js 20.x on Windows 10/11 x64, and the TaxRocket web app running (`npm run dev` in the repository root).

```powershell
cd electron-connect
npm ci            # first time only
.\start-live.ps1
```

`start-live.ps1` is the deliberate opt-in launcher for supervised real-portal runs. It sets, **only for that Electron process** (and restores the shell afterwards):

- `TAXROCKET_REAL_AUTOFILL=live`
- `TAXROCKET_WEALTH_AUTOFILL=on`
- `TAXROCKET_EMPLOYER_AUTOFILL=on`

…then runs `npm run dev`. Live entry still needs the second key on the web-app/server side (`TAXROCKET_ALLOW_LIVE_FILING=true`) — see [Modes and the two-key gate](#modes-and-the-two-key-gate). While this agent instance stays open, every eligible queued job can run live; close it after the intended supervised run.

Other ways to start:

```powershell
npm run dev       # electron . --dev — live autofill OFF unless the env says otherwise
npm run dev:live  # same as .\start-live.ps1
npm start         # electron . — packaged entry point, without building an installer
```

Then, in the web app: **FBR Connect → Create Desktop Session → Open Desktop App**. The taxpayer signs in to IRIS in the agent window, and the job runs from there.

---

## How a job flows

1. The web app creates a desktop session and launches the agent via the `taxrocket-connect://` deep link. The agent registers as a trusted device (`/api/fbr-connect/desktop/register`) and stores its token with Electron `safeStorage`; the local bridge listens on `127.0.0.1:37219`. The IRIS window uses a persistent partition, so the taxpayer's IRIS session survives restarts.
2. The taxpayer signs in to IRIS **in the agent window** and completes any OTP/CAPTCHA/PIN there. The agent is never given those secrets.
3. The agent reports ready (`/api/fbr-connect/desktop/ready`) and polls `/api/local-agent/jobs/next`. For a claimed job it fetches the pinned context (`/api/local-agent/jobs/{id}/context`): the approved packet's portal field map (IRIS code, section, column, amount for every figure), employer names if any, and the server's IRIS selector bundle.
4. It locates the TY2026 return — an existing draft first, otherwise the guarded new-return setup (Declaration → original return, tax period, then the Summary of Economic Transactions page, which it answers **only** from the approved packet; see below).
5. It verifies the taxpayer identity and the return form/period. A mismatch stops the run before anything is typed.
6. Section by section, it types each planned figure into the verified cell, reads it back immediately, and re-reads the whole set after switching tabs. Existing different figures in IRIS are **never overwritten** — they are reported for the taxpayer instead.
7. On every supported route, including all five supported Services source sets, it may press the **draft Save once** at the very end, only after every typed figure has passed the scoped post-tab readback; it then re-reads after Save. Missing/duplicate/conflicting readback blocks Save. It never presses Calculate, Submit, Prepare PSID or payment.
8. It reports the outcome (`/api/local-agent/jobs/{id}/status`) with a handoff summary for the TaxRocket completion card, and writes the local job report (see [Job logs](#job-logs)). The taxpayer reviews the draft in FBR and submits it themselves.

### New-return setup dialog (TY2026+)

IRIS opens a modal titled "Normal Return (Ind/AOP/COY)" with a prefilled Person box and a Tax Period box. The agent recognises that caption (`Tax Year`, `Period` or `Tax Period` + exactly one `Continue`/`Accept and Continue`) and clicks Continue, because nothing is left for a human to answer. It refuses and leaves a Retry checkpoint when any editable box is still empty, when a 4-digit period names a year other than the packet's, or when the dialog contains a password/one-time-code field. The Summary of Economic Transactions screen is handled separately: when the pinned approved packet contains income sources, residency and wealth-statement context, the agent selects only the exact captured IRIS options and the Start Return Filling control. If the packet is incomplete or the live choices cannot be reconciled, it pauses. It never invents an answer.

---

## File map

| File | Role |
| --- | --- |
| `main.js` | App lifecycle, windows/partitions, deep link, local bridge, job orchestration, pause/resume, handoff summary, log writing |
| `portal-agent.js` | Backend polling and job-context/status calls |
| `preload.js`, `renderer.html`, `renderer.js`, `styles.css` | Agent window UI |
| `branding.js` | Product identity (**TR Filing Agent**) and profile-directory continuity across versions |
| `iris-navigation.js` | Page/section detection and navigation in IRIS (drafts, new-return setup, economic-transactions gate, section switching) |
| `iris-row-filler.js` | Types planned figures into verified cells and reads them back (after typing, after tab switch) |
| `iris-employer-driver.js` | Adds salary-certificate employers by exact registered **name** (IRIS fills the registration number) |
| `iris-wealth-driver.js` | Wealth rows via IRIS dialogs (`+ Expenses`, `+ Assets`, bank account by IBAN, gift inflows) and amount entry |
| `iris-business-details-driver.js` | Business identity/principal-activity row, with saved-row verification before/after Save |
| `iris-business-row-driver.js` | Picker-backed business rows (bank account, motor vehicle, …) |
| `iris-balance-sheet-driver.js`, `iris-depreciation-driver.js` | Balance-sheet and tax-depreciation grids |
| `iris-tax-deduction-driver.js`, `iris-computations-driver.js`, `iris-turnover-driver.js` | Withholding-section rows, computations entries, `+ Turnover` picker |
| `iris-business-contract.json`, `iris-services-contract.json` | Captured IRIS structure contracts for the business/services grids |
| `pension-guard.js` | Re-validates the pension packet contract (source version, approval fingerprint, treatment) before anything is typed; stale pension packets are held, not entered |
| `iris-save-draft.js` | The single end-of-run Save (route permitting) and its readback |
| `iris-tour-census.js` | Read-only tour of every IRIS tab, before/after entry (the census) |
| `cash-baseline-store.js` | Persists the cash-in-hand baseline between runs |
| `job-report.js` | Builds the plain-language job report (JSON + TXT) |
| `start-live.ps1` | Opt-in live launcher (see Quick start) |

The IRIS **selector bundle** (login/ready/gate selectors and URL patterns) is built by the web server from `lib/tax/fbr-agent-config.ts` and shipped inside the job context, so selector fixes do not require an agent release.

---

## Modes and the two-key gate

The switch for touching the real portal is read once per job (`main.js:getRealAutofillMode`):

```text
#   off  (unset)            — navigation only; the agent never resolves or writes a field
#   dry                     — locates every IRIS target and reports what it WOULD write; writes nothing
#   live (or 1/true/on/yes) — actually writes, and only into cells verified by the section tour
TAXROCKET_REAL_AUTOFILL=dry
```

The mode is echoed in every autofill log line (`real_autofill_start`), and a job that filled 0 fields is reported as such — do not treat `dry` as "the filing worked".

`live` here is only half the switch. The web app decides the other half (`TAXROCKET_ALLOW_LIVE_FILING=true` in the server environment), and this process reads no `.env` at all — exporting the variable in the shell that launches the agent is what counts. When the deployment has not opted in, the agent says so in the job log and runs the job as `dry`. One more thing can downgrade it: `taxAutomationConfig.livePilot.automaticFilingEnabled` is a deployment kill switch — when explicitly `false`, a `live` request runs as `dry` (and the log says so). It never *enables* writes.

### Optional switches (agent shell; `start-live.ps1` presets the first two)

| Variable | Effect |
| --- | --- |
| `TAXROCKET_WEALTH_AUTOFILL=on` | Add Wealth Statement rows through the IRIS dialogs, then type the wealth amounts. Off: wealth figures are reported as prepared, not entered. In dry mode it only reports what it would add. |
| `TAXROCKET_EMPLOYER_AUTOFILL=on` | Add each employer named on the reviewed salary certificate (Salary route only), by exact registered name. Pension packets never carry employer names, so nothing is attempted there. |
| `TAXROCKET_AUTO_SAVE=off` | Disable the single end-of-run Save on this computer (the report says the taxpayer must save in FBR). |
| `TAXROCKET_CENSUS_TOUR=off` | Disable the read-only before/after tab census (on by default). |

The `FBR_IRIS_*` variables (login/ready URLs, gate selectors, host allowlist, …) belong to the **web server** environment — they shape the selector bundle mentioned above and the installer-download route (`USE_GCS`, `GCS_BUCKET_NAME`). The agent process itself does not read them.

---

## Safety rails

Two rails are deliberate and should stay:

- **Derived cells are never written.** Figures IRIS computes itself and renders disabled (section totals, `Subject to Normal Tax` on row `1008`, tax-chargeable summaries, …) are left to IRIS. Conversely, columns that *look* like summaries but are real inputs in IRIS — e.g. the `1008` **Subject to Final Tax** and **Subject to Exemption** columns — are typed when, and only when, they are verified editable on the live row.
- **A guessed cell is never written in `live`.** If a column can only be located by position (`position_fallback` / `sole_editable`), or the target section cannot be verified (`section_mapping_unverified`), the field is refused as `unverified_target`, listed for the taxpayer with its amount and IRIS row, and the run pauses for review. It is never silently skipped and never reported as entered.

Additionally: an amount already in IRIS that **differs** from the packet is never overwritten (cash in hand is the one designed exception — the packet's *movement* is added to IRIS's own figure). Employer/business picker rows are added by exact match only and are never edited or deleted afterwards. On resuming after a taxpayer confirmation, the agent trusts the confirmation for that item (reads back where it can) and continues idempotently — re-running never duplicates a row or re-types a matched figure.

### Pauses the taxpayer may see

| Pause | Meaning / what to do |
| --- | --- |
| `portal_economic_transactions_gate` | The income-source page could not be answered or its Start button could not be clicked safely. Answer/select in the FBR window, then Continue in TaxRocket. |
| `portal_taxpayer_mismatch` | The IRIS login is not this filing's taxpayer. Nothing was changed. Sign in as the correct taxpayer, then Continue. |
| `portal_employer_review` | An employer could not be added by exact name (before any figure was typed). Add it in FBR under Employment → Salary → Add Employer Details, tick the confirmation, Continue. |
| `portal_autofill_review` | One or more figures could not be entered/verified (each is named, with the amount). Enter them in the FBR window (or fix the cause and retry), tick the confirmation, Continue. |
| `portal_handoff_review` | Entry is done; the agent shows Personal Assets, Payment and Computations read-only for the taxpayer to review and confirm. |

---

## Job logs

Every run writes into `C:\Users\<user>\TaxRocketAgentLogs\`:

- `job-<id>.json`, `job-<id>.txt`, and copies as `latest-job.json` / `latest-job.txt` — the plain-language report: TaxRocket Continue presses and the exact confirmation texts ticked, the income-source page outcome, employers (agent / already listed / taxpayer), business-details verification, a per-figure table (planned → in IRIS before → typed → readback → after-tab match), section summaries, IRIS's own computed totals, the Save outcome, what was *never* done (Calculate/Submit/PSID/payment), and a timestamped step log. The last 8 earlier runs of the same job ride along in `previousRuns`.
- `latest-census.json` / `census-<job>.json` — the before/after read-only census of every IRIS tab.
- `latest-portal-inspection.json` and HTML snapshots of the page at a pause — local diagnostics for figuring out why the agent stopped.

**First diagnostic step, always:** the first line of `latest-job.txt` names the run's **build tag** (e.g. `build pension-services-multifiling-20261106a`). If the agent behaves like an older version, it almost certainly *is* an older version — see below.

---

## Build-tag discipline (do not mix builds)

Every runtime file carries the same agent build tag, and `main.js`, the navigator and the guards cross-check it at handoff (see the `agent_handoff` step in the job log). **Never copy individual agent files from different builds into one folder.** When updating a source-run agent, replace the **whole `electron-connect/` folder** (or sync it via git), then restart the agent. One stale file is enough to resurrect old behaviour — e.g. an old field map sending pension to "Income from Other Sources".

When the tag itself changes, it changes everywhere at once (all pinned files and their verification suites).

---

## Build the Windows installer

See [`../INSTALLER_BUILD.md`](../INSTALLER_BUILD.md) for the full notes. Short version, on Windows 10/11 x64, with any running agent closed:

```bat
cd electron-connect
npm install
npm run dist:win
```

Output: `dist\TR-Filing-Agent-Setup-<version>.exe` (the version comes from this folder's `package.json` — bump it there for a new release). The installer creates **TR Filing Agent** shortcuts and registers the `taxrocket-connect://` protocol. It is currently unsigned, so SmartScreen may warn on first launch (*More info → Run anyway*).

⚠️ **Packaging rule:** electron-builder ships only the files listed under `build.files` in `package.json`. Any **new runtime `.js`/`.json` file must be added there**, or the installed app will fail at runtime even though source runs work.

---

## Verification

From the repository root:

```bash
npm run verify:iris-navigation
# = navigation + FBR contracts + row filler + wealth driver + employer driver + job report suites
node --check electron-connect/main.js   # quick syntax gate for agent files
```

From this folder:

```bash
npm run verify:branding   # product name, shortcuts, protocol, profile continuity
```

Agent unit suites (`verify-iris-row-filler`, `verify-iris-wealth-driver`, `verify-iris-employer-driver`, `verify-fbr-contracts`) run offline against the permanent JSON contracts in `electron-connect/iris-*-contract.json` and `scripts/contracts/*.json` — raw IRIS HTML captures never need to be stored or re-uploaded once a contract is recorded.

---

## Troubleshooting

- **The agent selected the wrong income source / behaves like an old version** → check the build tag on the first line of `latest-job.txt`. Replace the whole `electron-connect/` folder with the current build and restart the agent.
- **Run pauses at the economic-transactions gate with `outside_visible_area`** → the IRIS *Start Return Filling* button is below the agent window's visible area and the page would not scroll. Maximise the agent window (or zoom out) before starting, or click the button in the FBR window yourself and press Continue in TaxRocket — the run resumes from there.
- **`portal_taxpayer_mismatch`** → you are signed in to IRIS as a different taxpayer than this filing's. Sign in as the right taxpayer; nothing was changed.
- **A figure is listed as not entered (`section_mapping_unverified`)** → the agent could not verify that row's target in IRIS, so it refused to guess (for example, today's known case: the pension final-tax surcharge row `923184`). Enter the named amount in the named row in the FBR window, tick the confirmation, and Continue — the amount is never lost, it is in the packet, the completion card and the job report.
- **A `+ Expenses` / `+ Assets` dialog did not open (`*_dialog_not_shown`)** → IRIS dialogs are occasionally flaky. Close any open pop-up in the FBR window, let IRIS finish loading, and retry the run — it is idempotent and will not overwrite or duplicate what is already entered. Alternatively add the row(s) manually and confirm.
- **Job filled 0 fields but "completed"** → you ran in `dry` mode (or live was downgraded: second key missing, or the kill switch). Check the `real_autofill_start` line in the job log for the effective mode and reason.
