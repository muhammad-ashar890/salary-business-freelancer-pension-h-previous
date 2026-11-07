# Pension + Freelancer / Services multifiling — phase status

**Scope:** TY2026, `Myself`, exact combined source set `Pension + Services` (Freelancer). Other combinations remain fail-closed. This status covers code and local synthetic tests; it does not claim a live IRIS run.

## Preservation / baseline

- The pre-existing project had uncommitted Salary/Services/bank/agent changes. Implementation and tests were done in an isolated copy at `/home/user/pension-services-multifiling-work`; after validation, only that tested delta was applied to the original working tree. No existing edits were reset or overwritten.
- Previous-return behavior is a hard regression requirement. Its parser, TY2025 carry-forward, 703002 expectation and read-only agent comparison remain covered by `scripts/verify-previous-return-fields.cjs`.
- Dependencies were installed/generated only in the isolated copy. `npm ci` could not run because the existing lockfile lacks two optional `@emnapi` entries; `npm install --ignore-scripts` plus `npx prisma generate` enabled the tests. The isolated lockfile was restored afterwards.

## Phases completed

1. **Exact route gate:** Services now permits only Services alone, Salary + Services, or Pension + Services for TY2026 Myself. Pension + Services is accepted independent of source order; duplicates, a third source, other filer types and other tax years remain rejected.
2. **Evidence and calculation flow:** Existing Services invoice/payout evidence, withholding confirmation, bank classification, allocation, tax calculation and packet gates inherit the exact supported route. Pension tax treatment remains controlled by its reviewed statement, age/former-employer decision and withholding validations.
3. **Packet and IRIS agent union:** The Services payload remains restricted to its approved Business rows. The Electron route separately adds only the approved Pension rows (1008, pension 64020007 and 923184 when present, and pension-only 64020004 cells for salary-treated pension withholding). It allows only the necessary Employment, Tax Deductions, Computations and Services Business views. It does not add unrelated Salary or other source fields.
4. **Readback and handoff:** Pension+Services now has its own readback summary in the agent result, completion card and local job report. Existing one-draft-Save-after-scoped-readback gate is retained. Calculate, Submit, PSID and payment remain outside the agent action.
5. **Build identity:** Electron modules and matching tests/docs use build tag `pension-services-multifiling-20261106a` so mixed old/new module builds are rejected.

## Verification results

- Focused regression suites: **410 tests passed, 0 failed**. Includes previous-return, pension review/routing/statement, Services evidence/actions/mapping/packet/agent, and TY2026 multi-route tax calculation.
- `npx tsc --noEmit`: **passed**.
- Added explicit tests for Pension + Services route acceptance, unsupported-source refusal, combined tax lines, Services evidence save/allocation, packet payload, pension field allowlist and combined readback/report labels.
- Broader browser-backed regression run was attempted but could not run in this environment because Playwright Chromium is not installed. The repository sync checker also reports eight pre-existing missing fixtures (employer, wealth and sales-tax test fixtures); these are unrelated to this feature and were not fabricated or changed.

## Not done / next safe validation

- No live IRIS session was opened and no FBR action was taken.
- Next test should use synthetic/reviewed Pension + Freelancer documents through the web wizard and inspect packet fields/readbacks in a supervised draft. Do not Calculate, Submit, Prepare PSID or pay. Only the one gated draft Save is allowed after all entered fields pass the required readback.
- Salary + Pension + Services, business + Services, and other unlisted combinations are intentionally unsupported.
