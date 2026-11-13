# Salary + Business + Freelancer / Services — staged verification

## Scope and evidence boundary

This runbook is for the exact **TY2026 / Myself / Salary + Business + Services** route. It does not authorize another source combination, Calculate, Submit, Prepare PSID or payment. Offline tests establish code and fixture behavior only; they do not establish current live IRIS behavior.

Run stages in order. A failed gate stops the stage: do not bypass a missing/tampered envelope, an unmapped receipt, a shared-cell ambiguity, a stale approval, an unexpected pre-filled value, or an incomplete/duplicate readback.

## Stage 0 — offline acceptance

From the repository root, after installing dependencies and generating Prisma:

```sh
npm run verify:salary-business-services
node --test scripts/verify-services-phase6-electron.cjs \
  scripts/verify-fb-business-merge.cjs \
  scripts/verify-services-business-gate-parity.cjs \
  scripts/verify-phase7-multifiling-remaining.cjs
node --test scripts/verify-iris-navigation.cjs
node scripts/verify-portal-field-map.cjs
npx tsc --noEmit
for f in electron-connect/*.js; do node --check "$f" || exit 1; done
git diff --check
```

Also run the relevant Services evidence suites and existing Salary, Business, Pension single/dual/triple regression suites. Record exact test counts and the commit hash in the run evidence. A fixture mock failure is not a production defect by itself; trace its root cause before changing product or test code.

Required fixture invariants:

- Salary and Business normal-slab income is not double counted.
- Services normal/final-tax income follows only the reviewed invoice/category evidence.
- Each shared Business/Services cell has one folded value. Total Amount and Subject to Final Tax are never added together as separate receipts.
- `snapshot.business`, `snapshot.services` and `snapshot.salaryBusinessServices` remain distinct and versioned.
- The triple Computations plan is the selected plan. A missing or stale envelope blocks activation.
- Fully mapped final-tax-only Services can inherit only finite, positive companion Normal Tax. Normal-tax Services or unmapped portal income leaves Normal Tax/surcharge/super tax to user review and removes unproven automatic expectations.
- Business reporting retains the full Business grid; Services-backed/shared-cell counts are separate.
- Business + Pension + Services, the quadruple, duplicates, non-TY2026 and non-Myself remain blocked. Salary + Pension + Services has its own runbook (docs/salary-pension-services-verification.md) and its own contract suite.

## Stage 1 — supervised dry run on real IRIS

Use reviewed synthetic/test-case evidence whose expected amounts are independently recorded. Do not use a real taxpayer filing without authorization.

1. Generate and approve the exact triple packet through the real web actions. Save the packet/envelopes and independently calculated expected values as evidence.
2. Configure the web server for the intended supervised pilot, but start Electron with `TAXROCKET_REAL_AUTOFILL=dry` and `TAXROCKET_AUTO_SAVE=off`.
3. Taxpayer/operator signs in to real IRIS and handles OTP/CAPTCHA/PIN personally. Open only the intended TY2026 draft.
4. Run the desktop job. Confirm taxpayer, return and period before allowing the flow to continue.
5. Inspect the job log and screenshots. Dry mode must locate/report targets without typing or saving. Compare every planned Business, Services, shared-cell and Computations target with the approved packet.
6. Record section/tab names, row codes, column headings, visible pre-existing values, validation messages and all skipped/manual items. Do not infer behavior for an unvisited section.

**Dry exit criteria:** exact source set and taxpayer/period; valid triple envelope; no unexpected writes or Save; all intended targets accounted for; every mismatch held with an exact reason. If a selector or IRIS layout differs, stop and update the verified contract from evidence rather than guessing.

## Stage 2 — separately authorized supervised live data entry

Proceed only after Stage 0 and Stage 1 evidence is reviewed and live entry is explicitly authorized for this filing.

1. Start through `electron-connect/start-live.ps1`; confirm both live-key gates and the intended taxpayer/draft. Keep the operator present.
2. Allow data entry only. Do not press Calculate, Submit, Prepare PSID or payment.
3. Verify immediate readback and scoped post-tab readback for every entered Salary, Business, Services, Computations, specialist-driver and Wealth value.
4. Confirm Business/Services shared rows show the single folded value, and Business/other-revenue and Computations readback match the triple envelope rather than Business-only expectations.
5. Confirm existing conflicting values are not overwritten. Any missing, duplicate, changed or ambiguous value blocks draft Save.
6. Only after complete readback, allow the one end-of-run draft Save (unless intentionally disabled). Re-read after Save and record the result.
7. Stop at the reviewed draft. The taxpayer reviews and submits personally.

**Live exit criteria:** all entered values uniquely match the approved packet before and after one draft Save; no forbidden action; no duplicate shared-cell amount; report separates full Business and Services-backed/shared-cell counts; every remaining manual item is explicit.

## Evidence to retain

- Git commit, app/agent build, mode and timestamps (without secrets).
- Approved packet and versioned envelopes; independently reviewed expected totals.
- Dry/live job logs and relevant screenshots, redacted for CNIC, account numbers, credentials and personal data.
- Scoped readback and after-Save verification summaries.
- Exact failures, skipped codes and operator decisions.
- Final confirmation that no Calculate, Submit, PSID preparation or payment occurred.

Never store passwords, OTPs, CAPTCHAs, PINs or session tokens in the evidence file or repository.
