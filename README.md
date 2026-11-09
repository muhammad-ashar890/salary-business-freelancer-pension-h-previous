# TaxRocket

> ### Engineering Rule #1 — Never Guess, Always Verify Root Cause First
> **Never fix or change anything by guessing.** Always trace, reproduce, and verify the actual bug, root cause, live code path, and existing test assertions directly in the codebase before writing or applying any fix.
>
> ### Engineering Rule #2 — Permanent IRIS Contracts (`rawHtmlPersisted: false`)
> Once an IRIS page or modal has been inspected once, its row codes, column shapes, and modal selectors are saved permanently in code/JSON contracts (`lib/tax/portal-row-evidence.ts`, `electron-connect/iris-*-contract.json`, `scripts/contracts/*.json`). **Raw HTML captures are transient and never kept in the repo — never ask the operator to re-upload HTML captures for sections (`Salary`, `Wealth 116`, `Business`, `Services`, `Employer`) already recorded in these contracts.** Only request a capture when integrating a genuinely brand-new IRIS tab or modal for the first time.

**TaxRocket** is a guided Pakistan income-tax filing workspace. It takes a taxpayer from documents and bank statements to an approved filing packet, then hands the numbers to a supervised Windows desktop agent that types the packet-approved figures into the real **FBR IRIS** return, in front of the taxpayer, and reads every figure back. The taxpayer always reviews and submits the return themselves — TaxRocket never submits.

> **Status:** Pilot. The tax engine currently implements **Tax Year 2026 only** (Finance Act 2025). The product is being built and live-tested route by route against the real IRIS portal.
>
> **Real FBR only:** the desktop agent connects to `https://iris.fbr.gov.pk/`. Mock IRIS pages are not used.
>
> **Scope today:** **single income-source filings** (Salary, Business, Freelancer / Services, or Pension). Combined-source filings are a later phase.

---

## Table of contents

- [What works today](#what-works-today)
- [How it works](#how-it-works)
- [Technology](#technology)
- [Requirements](#requirements)
- [Local web-app setup](#local-web-app-setup)
- [Desktop agent (TR Filing Agent)](#desktop-agent-tr-filing-agent)
- [Two-key live-entry safety gate](#two-key-live-entry-safety-gate)
- [What the agent will and will never do](#what-the-agent-will-and-will-never-do)
- [Verification and testing](#verification-and-testing)
- [Security and data handling](#security-and-data-handling)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Project structure](#project-structure)
- [Git workflow](#git-workflow)

---

## What works today

Four filing modules are complete end-to-end — web flow, tax calculation, approved packet, and supervised IRIS auto-entry — and have been live-tested against the real IRIS portal during development:

| Module | Income declaration in IRIS | Withholding / tax schedules | Notes |
| --- | --- | --- | --- |
| **Salary** | Salary rows in Employment → Salary | Adjustable Tax → Salary of Employees u/s 149 (`64020004`) | Employer Details added by exact registered name (optional switch, see below) |
| **Business** | Trading account, adjustments and add-backs u/s 21, administrative expenses, other revenues, balance sheet, tax depreciation | Business tax deductions (e.g. u/s 153) | Business identity/principal-activity row entered and verified against the saved IRIS row, before and after Save |
| **Freelancer / Services** | Fee for Technical / Professional Services (`3101`) | u/s 153(1)(b) withholding, incl. IT / IT-enabled services @4% (`64060158`) | Evidence-backed fields only; one draft Save is pressed only after scoped post-tab readback verifies every entered field. Submit, Calculate, Prepare PSID and payment remain blocked. |
| **Pension** | Pension / Annuity u/s 12(2)(f) (`1008`), with the Total / Final Tax / Exemption split | Final Tax `64020007` for the above-10M excess; surcharge `923184` (see [limitations](#known-limitations)) | Full Section 149(IA) treatment, below |

All four modules also prepare the **Wealth Statement (116)**: personal-expense rows derived from the reviewed bank data (e.g. tax payments → `7052`, zakat → `7076`, other personal → `7087`), bank closing balances (`7030`, by IBAN), and cash in hand (`7012`, the year's net cash movement added to the figure already in IRIS, never overwritten blind).

### Pension treatment (Section 149(IA))

The pensioner answers one question — *do you work for a former employer or its associate?*

- **Yes** → the pension is priced on the Section 149 salary slabs, including the Section 4AB surcharge where it applies.
- **No, pension up to PKR 10 million** → exempt (0%). The full amount is written to the `1008` Exemption column so IRIS does not pull it into normal income.
- **No, above PKR 10 million, age below 70** → final tax at 5% **on the excess only**, plus a 10% surcharge on the calculated tax. Row `1008` is split (Exemption 10,000,000 / Final Tax = excess), the excess goes to `64020007`, and the surcharge is planned for `923184`.
- **No, age 70 or above** → exempt under Section 12(2A)(i); the full amount is exempt.
- **Age cannot be confirmed and the pension is above PKR 10 million** → packet generation **refuses** instead of guessing.

Age is assessed from the taxpayer profile date of birth under the first-day-of-tax-year rule. A reviewed pension statement becomes a fingerprinted *pension source*; changing the answer, the statement, or the profile invalidates the approval and forces a fresh review. Actual withholding on a pension is never confused with the calculated liability, and a non-final pension with real withholding is held for manual review rather than entered automatically.

### Bank Intelligence

- Structured bank-statement import (XLSX/CSV) plus PDF extraction, with per-account isolation and IBAN validation.
- Rule-based transaction classification with confidence (salary credits, pension credits, business/services receipts, tax payments, cash withdrawals, transfers, …), with AI assistance where configured.
- Suggestions stay **SUGGESTED** until a human approves them; "Approve All Safe" only bulk-approves the deterministic safe set. Classifications drive the ledgers, the wealth rows, and the cash-in-hand movement.

### Tax engine

- TY2026 rate-card **catalog** (`lib/tax/rules/ty2026/catalog.ts`) with rule IDs and citations, consumed by route-specific calculators (`lib/tax/tax-calculation.ts`) so every charged figure can be traced to a catalogued rule.
- Route pricing for salary, business (including add-backs, brought-forward losses, tax depreciation), services withholding, rent, and pension, with the Section 4AB surcharge where the rate card charges it.
- A **wealth reconciliation gate** that must be resolved before a packet can be approved.
- A versioned **filing packet** (`lib/tax/portal-field-map.ts`) that maps every approved figure to a verified IRIS code, section, and column. Anything without a verified IRIS target is reported as a mapping gap / manual-review item — it is never guessed and never silently dropped. The packet can be exported as a PDF.

### Also in the workspace

- **Sales-tax module** (FBR and SRB) with its own intake, return preparation, and verification suites (some suites need local fixtures, see [Verification](#verification-and-testing)).
- Taxpayer profiles with CNIC-based identity carry-forward, filing history and drafts, document upload slots with review states, calculation breakdowns, and a step-by-step filing wizard.

---

## How it works

```
 Web app (Next.js)                     Desktop agent (Electron)              FBR IRIS
 ─────────────────                     ────────────────────────              ────────
 Taxpayer setup  ─► documents  ─► bank statements ─► classification (human-
 approved) ─► ledgers ─► reconciliation ─► TY2026 calculation ─► APPROVED
 PACKET (versioned, IRIS-coded)
        │  local session (127.0.0.1:37219, trusted device)
        └──────────────────────────────►  opens the real IRIS window
                                          taxpayer logs in / OTP / CAPTCHA
                                          agent verifies taxpayer + return
                                          types ONLY packet figures into
                                          verified rows/columns ──────────► draft
                                          reads every figure back
                                          one Save at the end*
        ◄───────────────────────────────  plain-language job report
 Taxpayer reviews in FBR and SUBMITS IT THEMSELVES
```

\* **Save policy:** on the Salary, Business and Pension routes the agent presses Save **once**, at the very end, only after every typed figure read back the same. On the Freelancer / Services route Save is **never** pressed — the taxpayer saves in FBR. The agent **never** presses Calculate, Submit, Prepare PSID, or any payment control.

**Main filing flow**

1. Sign in with Google; complete taxpayer profile and Tax Year 2026 filing setup (single income source).
2. Upload and review the required documents (salary certificate, pension statement, business books, services evidence, CNIC, …). AI extraction assists; a human reviews and maps the data.
3. Import bank statements; review and approve the suggested classifications.
4. Maintain/verify the ledger entries the classification produced.
5. Resolve the wealth reconciliation gate; review the route-specific tax calculation and withholding.
6. Generate and approve the versioned filing packet (anything unmapped is listed explicitly and, where the product allows, must be acknowledged by the taxpayer for manual entry in IRIS).
7. Connect the trusted desktop agent; sign in to the real IRIS window locally and complete OTP / CAPTCHA / PIN there.
8. The agent answers the IRIS income-source/residency questions from the approved packet, enters the figures section by section, reads them back, saves once (per route policy), and hands back a plain-language report of exactly what it did.
9. The taxpayer reviews the draft in FBR (including anything flagged for manual entry) and submits it themselves.

---

## Technology

- **Web:** Next.js 14.2, React 18, TypeScript 5, Tailwind CSS 3
- **Data:** Prisma 5 with PostgreSQL (25 models, checked-in migrations)
- **Auth:** NextAuth (Google OAuth)
- **AI extraction:** Google Gemini (`@google/generative-ai`) for document/bank-data extraction and classification assistance — always behind human review
- **Files:** `@e965/xlsx` + `exceljs` for statements, `pdfkit` for filing-packet PDFs
- **Desktop agent:** Electron 28 + electron-builder (separate app in `electron-connect/`)
- **Testing:** ~99 Node verification suites in `scripts/`, Playwright UI suites in `scripts/ui/`

---

## Requirements

- **Node.js 20.x LTS** and npm
- **PostgreSQL 16** running locally, with an empty `taxrocket` database
- A Google OAuth application for login
- Gemini API key (optional; without it, extraction falls back to manual entry)
- Windows 10/11 x64 for the desktop agent and for building its installer

---

## Local web-app setup

From the repository root:

```bash
# 1. Clone the repository, then enter it
git clone https://github.com/muhammad-ashar890/tax-rocket-electron.git
cd tax-rocket-electron

# 2. Check Node.js (should be v20.x)
node --version
npm --version

# 3. Install web-app dependencies
npm install

# 4. Create .env in the repository root (template below)

# 5. Create the database once, with PostgreSQL running:
#    CREATE DATABASE taxrocket;

# 6. Generate the Prisma client and apply committed migrations
npx prisma generate
npx prisma migrate deploy
npx prisma migrate status

# 7. Start the web app
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Use `prisma migrate deploy`, not `prisma migrate dev`, for the checked-in migration history (`migrate dev` tries to create migrations and requires a shadow database).

### Root `.env` template

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/taxrocket"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="replace-with-output-of-openssl-rand-base64-32"
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
GEMINI_API_KEY=""
GEMINI_MODEL="gemini-3.5-flash"

# Required only for a supervised live-entry test.
# Keep false/unset for dry-run or navigation-only work.
# TAXROCKET_ALLOW_LIVE_FILING="true"
```

Generate the NextAuth secret with `openssl rand -base64 32`.

Google Cloud Console must contain this local callback URL:

```text
http://localhost:3000/api/auth/callback/google
```

---

## Desktop agent (TR Filing Agent)

The agent is a separate Electron app in `electron-connect/` (product name **TR Filing Agent**, current version **1.0.5**). The web app and the agent must be running at the same time; they talk over a local bridge on `127.0.0.1:37219` with a trusted-device session opened from the web app (*Create Desktop Session → Open Desktop App*, deep link `taxrocket-connect://`).

### Run from source (current development mode)

During the pilot the agent is run from source — no installer build is needed for testing:

```powershell
cd electron-connect
npm install
.\start-live.ps1
```

(`npm run dev:live` does the same; `npm run dev` runs `electron . --dev`, and `npm start` runs the packaged entry point without building an installer.)

### Build the Windows installer

Build on Windows 10/11 x64 (see also `INSTALLER_BUILD.md`). Close any running agent first. Code signing is not configured yet, so Windows SmartScreen may warn on first launch (*More info → Run anyway*).

```bat
cd path\to\tax-rocket-electron\electron-connect
npm install
npm run dist:win
```

Output: `electron-connect\dist\TR-Filing-Agent-Setup-1.0.5.exe`, creating Desktop/Start-Menu shortcuts named **TR Filing Agent**.

### Agent files and build-tag discipline

Every agent entry file carries the same build tag (currently `wealth-recon-20261027f`), and the agent checks that its parts agree. **Never mix agent files from different builds** — when updating a source-run agent, replace the whole `electron-connect/` folder (or at least keep all tagged files in sync), then restart the agent. A single stale file makes the agent behave like its old build.

### Job logs

After every run the agent writes, into `TaxRocketAgentLogs/` on the user's PC:

- `job-<id>.json` / `job-<id>.txt` and `latest-job.*` — a plain-language report: the TaxRocket Continue presses and the exact confirmations the taxpayer ticked, what happened on the IRIS income-source page, employers (agent/taxpayer), a per-figure table (planned value → what IRIS held → typed → readback → after-tab match), section summaries, IRIS's own computed totals, the one Save (or why it was skipped), and an ordered, timestamped step log. The last 8 earlier runs of the same job are kept in `previousRuns`.
- `latest-portal-inspection.json` — the captured page structure used for diagnosis; HTML snapshots are saved locally when a run pauses.

---

## Two-key live-entry safety gate

Typing approved values into the real FBR window requires **both** keys:

1. **Operator key** (shell that launches the agent): `TAXROCKET_REAL_AUTOFILL=dry` (read-only discovery, nothing typed) or `=live`. `start-live.ps1` sets this for live testing.
2. **Deployment key** (web-app/server environment): `TAXROCKET_ALLOW_LIVE_FILING=true`.

The Electron process does not read the web app's `.env`. If the deployment kill switch (`taxAutomationConfig.livePilot.automaticFilingEnabled`) is explicitly `false`, the agent downgrades to dry mode.

Optional agent switches (off by default, set in the agent's shell):

- `TAXROCKET_EMPLOYER_AUTOFILL=on` — add each employer named on the reviewed salary certificate under Employment → Salary → `+ Add Employer Details`. The agent adds by registered **name** only (IRIS fills the registration number) and only on an exact single match; otherwise it cancels the dialog and pauses (`portal_employer_review`) **before any figure is entered**, and the taxpayer adds the employer in IRIS and confirms. (Pension packets never carry employer names, so this step is salary-route only.)
- `TAXROCKET_WEALTH_AUTOFILL=on` — also add Wealth Statement rows through the IRIS dialogs (`+ Expenses`, `+ Assets`, gift-inflow rows) before typing the wealth amounts. In dry mode it only reports what it would add.

---

## What the agent will and will never do

**It will:**

- Verify it is looking at the right taxpayer and the right TY2026 114(1) return before typing anything (a taxpayer mismatch stops it with no values changed).
- Type only packet-approved values, into cells whose row code and column it has verified on the live page, and read every value back (including a re-read after switching tabs and after the final Save).
- Refuse to overwrite a different figure already in IRIS, and report it instead of forcing it.
- Pause with a plain-language reason whenever a target cannot be verified, a dialog does not open, or taxpayer judgement is needed — then resume idempotently after the taxpayer confirms (tick-box confirmations; the exact text and time are stored in the audit trail).
- Add missing picker rows it knows how to add safely (employer, business identity, bank account by IBAN, expense category, depreciation/balance-sheet items) and verify them afterwards.

**It will never:**

- Press **Calculate, Submit, Prepare PSID,** or pay anything.
- Guess a row, code, column, or amount; an unverified target is a pause, never a silent success and never a silent skip — the completion card and job report name anything left for the taxpayer, with the amount and where it goes.
- See, store, or type the taxpayer's password, OTP, CAPTCHA, or PIN — those happen in the FBR window, locally, by the taxpayer.
- Edit or delete existing IRIS rows (including employer/business rows) or type a registration number.

A completed handoff means **entered and (route permitting) saved as a draft — never submitted**. The UI does not report a filing as finished when required handoff fields were skipped.

---

## Verification and testing

The `scripts/` directory holds ~99 Node verification suites plus Playwright UI suites. Useful entry points:

```bash
npx tsc --noEmit                 # type-check the web app
npm run verify:all               # the curated full suite chain
npm run verify:iris-navigation   # agent contracts: navigation, row filler,
                                 # wealth/employer drivers, job report, FBR contracts
npm run verify:pension-review    # pension statement + review policy chain
npm run verify:pension-statement # pension statement suite (103 assertions)
npm run verify:ui                # Playwright browser suites
```

Current reference point (full `scripts/verify-*.cjs` sweep): **77 suites PASS**, including the TY2026 rate-card/calculation suites, the portal field map, bank statement isolation and classification, business and services safeguards, and the pension suites (statement 103/103 · review policy 43/43 · prefill 40/40 · routing 14/14). A handful of suites need local fixtures or a seeded test database (`test-fixtures/`, sales-tax fixtures) and report `FIXTURE_MISSING` without them — that is an environment prerequisite, not a product failure.

Synthetic documents in `test-data/` are clearly labelled test data. They may verify extraction and mapping but must never be treated as valid evidence for an actual FBR return.

---

## Security and data handling

- Passwords, OTPs, CAPTCHAs and PINs are entered by the taxpayer in the FBR window on their own machine; the web app and the agent never receive or store them.
- The agent runs locally and reaches the web app through a session the taxpayer opens from the web app on a trusted device; the agent only ever loads the official IRIS site.
- Only the **approved, versioned packet** can be typed. Approval is invalidated when underlying data changes (e.g. employer names on a mapped salary certificate, pension statement/profile changes), forcing re-approval.
- Every taxpayer confirmation at a pause is stored verbatim with its timestamp (`livePilotState.confirmations`, `JOB_RESUMED_BY_USER` audit event); the server refuses a resume without the ticked confirmation.
- Diagnostic logs are designed to avoid raw identifiers (no file names, references or bank IDs in raw form), and census/inspection files stay on the user's own PC.
- `.env`, credentials, real taxpayer documents and real FBR screenshots are excluded by `.gitignore` — never commit them.

Environment notes: `NEXTAUTH_URL` must be the actual URL (not a Markdown link); `NEXTAUTH_SECRET` must be strong outside local development; Google OAuth callback URLs must match the environment URL in Google Cloud.

---

## Known limitations

- **Tax Year 2026 only**, and **single income-source filings only**. Combined-source behaviour (e.g. Pension + Salary) is not finalised and is out of scope until a later phase; routes outside the modules above remain manual.
- **Pension final-tax surcharge (`923184`):** for the above-10M/below-70 treatment the packet plans the surcharge, but the agent currently cannot verify that row's target in IRIS, so it does not type it. The run pauses and tells the taxpayer the exact amount and row to enter in FBR themselves. (On the salary-slab "Yes" route IRIS computes the surcharge itself.)
- **Employer/payer details on pension:** pension packets carry no payer name (the packet's employer list comes from a reviewed salary certificate). A pensioner who wants the pension-paying employer's details in the return adds them in the FBR window; the agent does not object.
- **Wealth opening figures** (previous year's net assets, opening cash, etc.) are whatever the previous return left in IRIS; a dedicated carry-forward manager has not been built yet. Current-year rows and movements are added on top, never overwriting IRIS's own opening figures.
- A non-final pension with **actual withholding** is held for manual review (no verified IRIS placement yet) instead of dropping the credit.
- The Windows installer is unsigned (SmartScreen warning), and during the pilot the agent is normally run from source with `start-live.ps1`.
- Some verification suites (sales-tax fixtures, DB-backed agent suites) need local fixtures/seed data and cannot run in a bare checkout.

---

## Roadmap

1. Combined (multi-source) filings, once each single-source route is fully proven live.
2. Verified IRIS placement for the pension `923184` surcharge and non-final pension withholding; optional pension-payer capture on the statement review.
3. Wealth carry-forward management (opening balances from the previous return inside TaxRocket).
4. Signed installer + agent update channel; production hardening (HTTPS, OAuth production callbacks, backups, rate limiting, calculation audit history, revised-return support).

---

## Project structure

```text
app/                          Next.js routes and server actions
  tax/                        Dashboard, filing wizard entry, FBR Connect, sales tax, history, profile
components/tax/               Filing wizard, FBR Connect client, review/approval UI, sales-tax UI
lib/tax/                      Tax engine: rules, portal field map, packet, ledgers support
  tax-calculation.ts          Route calculators (salary, business, services, pension, rent)
  portal-field-map.ts         Approved figures → verified IRIS codes/columns (the packet)
  pension-source.ts           Fingerprinted pension source + treatment/age rules
  rules/ty2026/               TY2026 rate-card catalog and selection subcategories
prisma/                       Schema (25 models) and checked-in PostgreSQL migrations
scripts/                      ~99 verification suites, diagnostics, fixture generators
scripts/ui/                   Playwright browser suites
electron-connect/             TR Filing Agent (Electron): IRIS navigation, row filler,
                              business/depreciation/balance-sheet drivers, wealth driver,
                              employer driver, pension guard, one-time Save, job reports
scripts/contracts/            Permanent sanitized IRIS & QA JSON contracts (rawHtmlPersisted: false)
test-data/                    Clearly labelled synthetic test documents
INSTALLER_BUILD.md            Windows installer build notes
```

---

## Git workflow

```bash
git status --short
git add -A                         # stages edits and tracked-file deletions
git diff --cached --name-status    # review M/A/D before committing
git commit -m "Describe the change"
git pull --rebase origin main
git push origin main
```

Work on a feature branch for anything risky and keep commits small and separately verifiable. Do not commit `.env`, credentials, real taxpayer documents, or real FBR screenshots. Do not use `git push --force` on the shared repository.
