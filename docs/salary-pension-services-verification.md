# Salary + Pension + Freelancer / Services — staged verification

## Scope and evidence boundary

This runbook is for the exact **TY2026 / Myself / Salary + Pension + Services** route. It does not authorize another source combination, Calculate, Submit, Prepare PSID or payment. Offline tests establish code and fixture behaviour only; they do not establish current live IRIS behaviour.

Run stages in order. A failed gate stops the stage: do not bypass a missing/tampered Services payload, a salary or pension field-map mismatch, a stale pension fingerprint, an unexpected pre-filled value, an incomplete/duplicate readback, or a non-zero Wealth reconciliation.

## What this route reuses

| Piece | Source route it reuses |
| --- | --- |
| Services income (`3101`) and withholding (`64060158`, etc.) | Services alone / Salary + Services / Business + Services |
| Pension `1008` split, `64020007`, `923184`, `64020004` (pension as salary) | Pension + Services (`electron-connect/pension-guard.js`) |
| Salary `1009` gross and its Section 149 credit | Salary + Services (`getSalaryFieldsForServicesRoute`) |
| Services payload slot (`snapshot.business`) | Pension + Services (there is no Business packet) |
| Wealth `7098` outflow rows | one row per statutory section, merged across the whole filing |

## Stage 0 — offline acceptance

```sh
node scripts/verify-salary-pension-services-route.cjs
node scripts/verify-services-business-gate-parity.cjs
node scripts/verify-salary-business-services-route.cjs
node scripts/verify-services-income-safeguards.cjs
node scripts/verify-handoff-completion.cjs
node scripts/verify-portal-field-map.cjs
npx tsc --noEmit
for f in electron-connect/*.js; do node --check "$f" || exit 1; done
git diff --check
```

Record exact counts and the commit hash with the run evidence. A fixture failure is not automatically a production defect; trace the cause first.

Required invariants (all asserted by the contract suite):

- The exact set `{salary, pension, services}` activates only with a `services-tax-deduction-v1` payload; missing/wrong-version payload → the agent does not open entry.
- `salaryIncluded` **and** `pensionIncluded` are both true; `businessIncluded` is false.
- The salary allowlist ignores `PENSION_*` `64020004` rows (the pension allowlist owns them) and still refuses any other stray `1009/64020004` row.
- The pension allowlist ignores non-pension rows and still refuses unknown `PENSION_*` cells or duplicate keys.
- Services income keeps the Computations surcharge on `USER`: no automatic Normal Tax / surcharge figure is typed for a mixed return.
- **L2 fail-closed:** salary gross on `1009` above PKR 10 M with a pension `final_above_10m` source → the agent pauses with a message naming the summed `923184` (salary-slab Section 4AB + pension Section 4AB). It never types an unproven sum.
- `Business + Pension + Services`, the quadruple, duplicate sources, non-TY2026 and non-Myself remain blocked.

## Stage 1 — supervised dry run (no Save)

1. Build and approve the packet for a synthetic or genuine `{salary, pension, services}` draft.
2. Run the agent in dry mode. Confirm the section allowlist: `business_other_revenues`, `business_tax_deduction`, `salary`, `tax_deductions`, `computations`, plus the Wealth driver.
3. Record, read-only, IRIS's own values for: `1008` (Total / Final / Exemption), `1009`, `3101`, `64020007`, `64020004`, `923184`, `9100`, `920000`, `703000`.
4. Nothing is typed beyond the approved figures and **no Calculate, no Submit, no PSID, no payment**. Auto Calculate may refresh on tab change — that is the only mechanism used to observe totals.

**Stop the stage** if any of the §4 invariants above is violated, or if a readback differs.

## Stage 2 — live approved-entry run (separate authorization required)

Only after Stage 1 evidence is recorded and explicitly accepted:

- one draft **Save** at the end, only when every scoped figure read back the same after the tab switch and the Wealth reconciliation check reports zero gap;
- Submit, Calculate, Prepare PSID and payment are never pressed;
- the taxpayer reviews and files the return in IRIS themselves.

## Open live evidence still required

| Item | Why it is open |
| --- | --- |
| `923184` when salary gross > PKR 10 M **and** pension is `final_above_10m` | The summed surcharge (salary-slab 9%/10% + pension 10%) is legally determinate but has never been observed in IRIS. The agent pauses; the taxpayer enters the figure IRIS shows. |
| `703000` reconciliation with three withholding contributions on `7098` | Proven live for two rows (Section 149 + Section 153); the Services `153(1)(b)` row on the same grid plus a pension outflow has not been run live. |
| `9100` when `1008` (final pension) and `1009` (salary) sit in one Employment > Salary grid | Offline fixtures model IRIS, they do not observe it. |
