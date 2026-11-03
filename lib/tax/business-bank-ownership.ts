/**
 * Fail-closed ownership validation and narrowly scoped routing eligibility.
 * Work in progress: downstream packet freshness and end-to-end tests remain.
 * A confirmed classification is not itself permission to place a mixed account.
 */
import { isValidPakistanIban, normalizeIban } from './business-balance-details';

export type BusinessBankOwnership = 'personal' | 'business' | 'mixed';
export type BankOwnershipDecision = {
  bankAccountId: string;
  iban: string;
  ownership: BusinessBankOwnership;
  confirmed: true;
};
export type BankOwnershipAccount = { id: string; iban: string | null };
export type OwnershipIssue = {
  accountId?: string;
  code: 'invalid_account' | 'duplicate_account' | 'duplicate_iban' | 'invalid_decision' | 'duplicate_decision' | 'unknown_account' | 'missing_confirmation' | 'iban_changed' | 'mixed_requires_review' | 'business_evidence_conflict' | 'business_evidence_unregistered';
};

/** Parse only explicit confirmations. Never fill missing decisions from evidence. */
export function parseBankOwnershipDecisions(input: unknown):
  | { ok: true; decisions: BankOwnershipDecision[] }
  | { ok: false } {
  if (!Array.isArray(input) || input.length > 100) return { ok: false };
  const decisions: BankOwnershipDecision[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false };
    const record = item as Record<string, unknown>;
    if (typeof record.bankAccountId !== 'string' || !record.bankAccountId.trim() || record.bankAccountId.length > 200 ||
        typeof record.iban !== 'string' || !['personal', 'business', 'mixed'].includes(String(record.ownership)) || record.confirmed !== true) return { ok: false };
    const iban = normalizeIban(record.iban);
    if (!isValidPakistanIban(iban)) return { ok: false };
    decisions.push({ bankAccountId: record.bankAccountId.trim(), iban, ownership: record.ownership as BusinessBankOwnership, confirmed: true });
  }
  return { ok: true, decisions };
}

/**
 * Inputs must come from the owned draft, not client account lists. Evidence
 * list is optional: undefined means unknown, NOT an empty business list.
 * Result only assesses readiness; it does not choose an IRIS destination.
 */
export function checkBankOwnership(input: {
  accounts: readonly BankOwnershipAccount[];
  decisions: unknown;
  reviewedBusinessIbans?: readonly string[];
}): { ready: boolean; issues: OwnershipIssue[]; decisions: BankOwnershipDecision[] } {
  const issues: OwnershipIssue[] = [];
  const accounts = new Map<string, string>();
  const accountIbans = new Set<string>();
  for (const account of input.accounts) {
    const id = typeof account.id === 'string' ? account.id.trim() : '';
    const iban = normalizeIban(account.iban);
    if (!id || !isValidPakistanIban(iban)) { issues.push({ accountId: id || undefined, code: 'invalid_account' }); continue; }
    if (accounts.has(id)) { issues.push({ accountId: id, code: 'duplicate_account' }); continue; }
    if (accountIbans.has(iban)) issues.push({ accountId: id, code: 'duplicate_iban' });
    accountIbans.add(iban);
    accounts.set(id, iban);
  }
  const parsed = parseBankOwnershipDecisions(input.decisions);
  if (!parsed.ok) return { ready: false, issues: [...issues, { code: 'invalid_decision' }], decisions: [] };
  const byAccount = new Map<string, BankOwnershipDecision>();
  const businessIbans = input.reviewedBusinessIbans === undefined ? undefined : new Set(input.reviewedBusinessIbans.map(normalizeIban));
  for (const decision of parsed.decisions) {
    const id = decision.bankAccountId;
    if (byAccount.has(id)) { issues.push({ accountId: id, code: 'duplicate_decision' }); continue; }
    byAccount.set(id, decision);
    const accountIban = accounts.get(id);
    if (!accountIban) { issues.push({ accountId: id, code: 'unknown_account' }); continue; }
    if (accountIban !== decision.iban) { issues.push({ accountId: id, code: 'iban_changed' }); continue; }
    if (decision.ownership === 'mixed') issues.push({ accountId: id, code: 'mixed_requires_review' });
    if (businessIbans && decision.ownership !== 'mixed' &&
        (decision.ownership === 'business') !== businessIbans.has(accountIban)) {
      issues.push({ accountId: id, code: 'business_evidence_conflict' });
    }
  }
  for (const iban of businessIbans ?? []) if (!accountIbans.has(iban)) issues.push({code:'business_evidence_unregistered'});
  for (const id of accounts.keys()) if (!byAccount.has(id)) issues.push({ accountId: id, code: 'missing_confirmation' });
  return { ready: issues.length === 0, issues, decisions: parsed.decisions };
}

/** Narrow proven case only: the whole bank balance is explicitly personal,
 * the reviewed business Balance Sheet has zero bank assets and no missing or
 * untied breakdown, and no business bank accounts are listed. This only clears
 * the business-cash-record hold; the agent still verifies the exact IRIS IBAN.
 * Unscoped business entries, nonzero/missing business bank figures, a mixed
 * account or inconsistent evidence remain held. Never split or infer an amount.
 */
export function confirmedPersonalBankForWealth(input: {
  accountId: string;
  iban: string;
  decisions: readonly BankOwnershipDecision[];
  businessSheetBank: number | null;
  businessSheetGaps: readonly string[];
  declaredBusinessIbans: readonly string[];
  hasUnscopedBusinessEntries: boolean;
}): boolean {
  const iban = normalizeIban(input.iban);
  if (!input.accountId || !isValidPakistanIban(iban) || input.hasUnscopedBusinessEntries ||
      input.businessSheetBank !== 0 || input.businessSheetGaps.length !== 0 || input.declaredBusinessIbans.length !== 0) return false;
  const rows = input.decisions.filter(row => row.bankAccountId === input.accountId);
  return rows.length === 1 && rows[0].confirmed === true && rows[0].ownership === 'personal' && normalizeIban(rows[0].iban) === iban;
}

/** Selects a destination, never splitting a balance. Unscoped activity keeps
 * every otherwise-personal account held; a business-list account is never
 * emitted as a personal 7030 entry. */
export function businessBankAccountRoute(input: {
  account: BankOwnershipAccount;
  declaredBusinessIbans: readonly string[];
  linkedBusinessActivity: boolean;
  hasUnscopedBusinessEntries: boolean;
  decisions: readonly BankOwnershipDecision[];
  businessSheetBank: number | null;
  businessSheetGaps: readonly string[];
}): 'business' | 'personal' | 'held' {
  const iban=normalizeIban(input.account.iban);
  if (input.declaredBusinessIbans.some(value => normalizeIban(value)===iban)) return 'business';
  if (input.hasUnscopedBusinessEntries) return 'held';
  if (!input.linkedBusinessActivity) return 'personal';
  return confirmedPersonalBankForWealth({accountId:input.account.id,iban,decisions:input.decisions,
    businessSheetBank:input.businessSheetBank,businessSheetGaps:input.businessSheetGaps,
    declaredBusinessIbans:input.declaredBusinessIbans,hasUnscopedBusinessEntries:false}) ? 'personal' : 'held';
}
