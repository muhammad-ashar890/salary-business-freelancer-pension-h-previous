export const BANK_TRANSACTION_EXCLUDED_EVENT_TYPE = "BANK_TRANSACTION_EXCLUDED";

export type BankExclusionAuditEvent = Readonly<{
  eventDataJson: string;
}>;

export function normalizeBankExclusionReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim().replace(/\s+/g, " ").slice(0, 400);
  return reason.length >= 3 ? reason : null;
}

export function buildBankExclusionEventData(
  transactionId: string,
  reason: string,
): string {
  return JSON.stringify({ transactionId, reason });
}

/**
 * Audit events must be supplied newest-first. The first valid reason for a
 * transaction is therefore its latest exclusion decision.
 */
export function latestBankExclusionReasons(
  events: readonly BankExclusionAuditEvent[],
): Map<string, string> {
  const reasons = new Map<string, string>();
  for (const event of events) {
    try {
      const parsed: unknown = JSON.parse(event.eventDataJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const data = parsed as { transactionId?: unknown; reason?: unknown };
      const transactionId =
        typeof data.transactionId === "string" ? data.transactionId.trim() : "";
      const reason = normalizeBankExclusionReason(data.reason);
      if (transactionId && reason && !reasons.has(transactionId)) {
        reasons.set(transactionId, reason);
      }
    } catch {
      // A malformed historical audit row must not break filing review.
    }
  }
  return reasons;
}
