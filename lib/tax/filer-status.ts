/**
 * 28-Oct-2026 (operator request): the wizard never asked whether the taxpayer is
 * a filer or a non-filer. The status was only chosen at the very end, as one of
 * three "Calculate for ATL / Late Filer / Non-ATL" buttons on the Review step, so
 * a non-filer could go through the whole filing before anyone noticed, and a
 * filer was never asked for the previous year's return even though ATL status
 * comes from filing it.
 *
 * This module holds the question's meaning in one place:
 *   - the three answers TaxRocket supports,
 *   - which answers REQUIRE an approved previous-year return,
 *   - the exact blocker text, so the screen and the tests cannot drift apart.
 *
 * It deliberately does not touch the tax arithmetic. The rate tables already
 * carry ATL and NON_ATL apart per route (lib/tax/rules/ty2026/catalog.ts), and
 * the calculation action already takes the status as an argument, so answering
 * the question earlier is what makes the calculation use the right side.
 */

export type TaxpayerListStatus = "ATL" | "LATE_FILER" | "NON_ATL";

export const TAXPAYER_LIST_STATUSES: readonly TaxpayerListStatus[] = [
  "ATL",
  "LATE_FILER",
  "NON_ATL",
] as const;

export const TAXPAYER_LIST_STATUS_LABEL: Record<TaxpayerListStatus, string> = {
  ATL: "Filer (ATL)",
  LATE_FILER: "Filer — previous return filed late",
  NON_ATL: "Non-filer",
};

/**
 * 28-Oct-2026 (operator): the screens must use the words the taxpayer answered
 * with — Filer / Late Filer / Non-Filer — not the internal ATL / LATE_FILER /
 * NON_ATL codes. One map, so the card, the badge and the messages cannot drift
 * apart again.
 */
export const TAXPAYER_LIST_STATUS_SCREEN_LABEL: Record<TaxpayerListStatus, string> = {
  ATL: "Filer",
  LATE_FILER: "Late Filer",
  NON_ATL: "Non-Filer",
};

export function filerStatusScreenLabel(
  status: TaxpayerListStatus | null | undefined,
): string {
  const normalized = normalizeTaxpayerListStatus(status);
  return normalized ? TAXPAYER_LIST_STATUS_SCREEN_LABEL[normalized] : "Not answered";
}

export function isTaxpayerListStatus(
  value: unknown,
): value is TaxpayerListStatus {
  return TAXPAYER_LIST_STATUSES.includes(
    String(value ?? "").trim().toUpperCase() as TaxpayerListStatus,
  );
}

export function normalizeTaxpayerListStatus(
  value: unknown,
): TaxpayerListStatus | null {
  const status = String(value ?? "").trim().toUpperCase();
  return isTaxpayerListStatus(status) ? (status as TaxpayerListStatus) : null;
}

/**
 * A filer (on time or late) can only be on the Active Taxpayer List because the
 * previous year's return was filed, so that return is the evidence for the answer
 * and must be uploaded and approved. A non-filer has no such record and is not
 * asked for one.
 */
export function filerStatusRequiresPreviousReturn(
  status: TaxpayerListStatus | null | undefined,
): boolean {
  return status === "ATL" || status === "LATE_FILER";
}

export type FilerStatusGateInput = {
  status: TaxpayerListStatus | null;
  taxYear: number;
  /** The approved (MAPPED) previous-year return, when the draft has one. */
  previousReturn: { taxYear: number | null } | null;
};

export type FilerStatusGateResult = {
  /** True when the filing may continue. */
  ok: boolean;
  /** Screen-ready sentences; empty when ok. */
  blockers: string[];
};

/**
 * The one rule: a Filer answer needs the previous year's approved return.
 * Anything else (no answer yet, a non-filer, a return already present) passes
 * here and is handled by the step that owns that question.
 */
export function filerStatusGate(
  input: FilerStatusGateInput,
): FilerStatusGateResult {
  const status = normalizeTaxpayerListStatus(input.status);
  if (!status) return { ok: true, blockers: [] };
  if (!filerStatusRequiresPreviousReturn(status))
    return { ok: true, blockers: [] };

  const label = TAXPAYER_LIST_STATUS_SCREEN_LABEL[status];
  if (!input.previousReturn) {
    return {
      ok: false,
      blockers: [
        `You answered "${label}". That answer comes from filing the previous year's return, so the Tax Year ${input.taxYear - 1} return must be uploaded and approved before this filing continues. Upload it on the Documents step, or change the answer to Non-Filer if no such return was filed.`,
      ],
    };
  }
  if (
    input.previousReturn.taxYear !== null &&
    input.previousReturn.taxYear !== input.taxYear - 1
  ) {
    return {
      ok: false,
      blockers: [
        `The approved previous return is for Tax Year ${input.previousReturn.taxYear}, but Tax Year ${input.taxYear - 1} is needed to support the "${label}" answer. Replace it with the correct year's return.`,
      ],
    };
  }
  return { ok: true, blockers: [] };
}
