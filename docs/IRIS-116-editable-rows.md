# IRIS 116 — which rows can be typed into

**Source:** operator's live check on IRIS 2.0, 27 October 2026 (Tax Year 2026, 114(1) draft).
This is the authority for the Wealth Statement; `lib/tax/portal-row-evidence.ts` is generated from
the capture folder and agrees with it except where noted in the last section.

Three classes:

- **DIRECT** — the amount cell is typeable by a person (and therefore by the agent).
- **MODAL** — the parent row is not typeable; its child rows are created through the row's `+`
  modal / `+ Assets` / `+ Expenses` button, and the child's amount cell is then typeable.
- **COMPUTED** — IRIS calculates the cell; nothing can be entered.

## Personal Assets / Liabilities

| Code | Description | Class | Note |
|---|---|---|---|
| 7003 | Business Capital | COMPUTED | comes from the Balance Sheet (3352) |
| 7006 | Investments / Stocks / Bonds | MODAL | children per fund; aggregate not typeable |
| 7008 | Motor Vehicle(s) | MODAL | children per vehicle; aggregate not typeable |
| 7010 | **Household Effects** | **DIRECT** | **differs from the rest — typed straight into the row** |
| 7012 | Cash in hand | DIRECT | |
| 7013 | Any Other Asset(s) | MODAL | children (funds, prize bonds, …) |
| 7014 | Assets held on others' name | MODAL | child rows (e.g. spouse gold) |
| 7019 | Total Assets | COMPUTED | |
| 7021 | Payables (borrowing / loan / credits) | MODAL | |
| 7029 | Total Liabilities | COMPUTED | |
| 700302 | Business Capital in AOPs/Companies | MODAL | |
| 703001 | Net Assets Current Year | COMPUTED | never editable |

## Reconciliation of Net Assets

| Code | Description | Class |
|---|---|---|
| 703002 | Net Assets Previous Year | **DIRECT but restored** — typeable, yet IRIS rewrites its own figure on CALCULATE / tab switch (operator test 27 Oct 2026), so it is effectively read-only |
| 703003 | Increase / (Decrease) in Assets | COMPUTED |
| 7031 | Income declared — normal tax | DIRECT |
| 7032 | Income declared — exempt | DIRECT |
| 7033 | Income subject to final / fixed tax | DIRECT |
| 7034 | Adjustments in Inflows | MODAL |
| 7035 | Foreign Remittance | MODAL |
| 7036 | Inheritance | MODAL |
| 7037 | Gift (received) | MODAL |
| 7088 | Contribution in expenses by family members | DIRECT |
| 7049 | Total Inflows | COMPUTED |
| 7089 | Personal Expenses (parent) | MODAL | child rows per expense head (7066–7087) |
| 7091 | Gift (given) | MODAL |
| 7098 | Adjustments in Outflows | MODAL |
| 7099 | Total Outflows | COMPUTED |
| 703000 | Unreconciled Amount | COMPUTED |

## What this means for the agent

1. It may type **only** DIRECT rows: `7010`, `7012`, `703002`, `7031`, `7032`, `7033`, `7088`.
   (By policy the agent still never writes `703002` — it is the filed return's own figure and is only
   compared; see `wealth-reconciliation-check.js`.)
2. MODAL rows are reached only by the existing modal drivers: bank accounts `7030`, expense heads
   `7066`–`7087`, outflow adjustment `7098`, gift rows `7037`/`7091`, and the `7034`–`7037` family.
3. COMPUTED rows are read-only read-backs (census), never targets.
4. Everything else (asset aggregates `7006`/`7008`/`7013`/`7014`) is IRIS's own carried-forward
   position; the agent compares it (`wealthCarryForward` check) and never retypes it.

## 703002: typeable, but IRIS puts its own figure back

Operator test, 27 October 2026: a value typed into 703002 and then CALCULATE returned the row to
IRIS's own carried figure (8,780,220). The cell accepts keystrokes, so the capture evidence correctly
records it as writeable, but the portal derives the number from the taxpayer's filed record and
restores it on recalculation.

**Consequence:** the opening cannot be changed from inside the return. So:

- the agent keeps treating 703002 as compare-only (already the policy in
  `wealth-reconciliation-check.js` and the Phase 3b read-back);
- a mismatch with the approved previous return can only be resolved by (a) explaining the change with
  this year's declared flows, or (b) correcting the earlier year's filed record (revision/amendment);
- "previous return se opening set ho jayega" is **not** an available behaviour — no Phase 5c.

## Discrepancy with the generated capture evidence

`lib/tax/portal-row-evidence.ts` has no entry for `7010` (never captured), so the generated set would
treat it as unknown. The live check above shows it is **DIRECT**. Until a fresh capture includes it,
any code that needs Household Effects must rely on this document, not on `PORTAL_WRITEABLE_CODES`.
