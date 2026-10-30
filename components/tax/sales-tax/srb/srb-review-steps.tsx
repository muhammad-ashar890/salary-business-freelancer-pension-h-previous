"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, ClipboardCopy, Loader2 } from "lucide-react";

import { StepHeading } from "@/components/tax/wizard-ui";
import { Button } from "@/components/ui/button";
import { formatRupees } from "@/lib/sales-tax/money";
import type { SrbMonthState } from "@/lib/sales-tax/srb/state";
import type { SrbReturnLine } from "@/lib/sales-tax/srb";
import { cn } from "@/lib/utils";

import { formatIsoDate } from "../format";
import { ProblemList } from "../invoice-steps";

const amount = (paisa: number | null) => (paisa === null ? "" : formatRupees(paisa).replace("Rs ", ""));

/** How many problems stop the estimate, and how many are reminders. */
export function srbProblemCounts(state: SrbMonthState) {
  const mustFix = state.review.problems.filter((problem) => problem.severity !== "warning").length;
  return { mustFix, toCheck: state.review.problems.length - mustFix };
}

export function SrbCheckStep({ stepNumber, state }: { stepNumber: number; state: SrbMonthState }) {
  const { mustFix, toCheck } = srbProblemCounts(state);
  const problems = state.review.problems;
  const group = (sheet: string) => problems.filter((problem) => problem.sheet === sheet);
  const groups = [
    { title: "Sales", items: group("sales") },
    { title: "Purchases", items: group("purchases") },
    { title: "Whole return", items: problems.filter((problem) => problem.sheet !== "sales" && problem.sheet !== "purchases") },
  ].filter((entry) => entry.items.length > 0);
  return (
    <div className="space-y-6">
      <StepHeading
        eyebrow={`Step ${stepNumber}`}
        title="Check your lines"
        description="Fix anything marked Must fix or Blocks the estimate. Items marked Please check are reminders."
      />
      {groups.length === 0 ? (
        <p className="flex items-center gap-2 rounded-xl border border-amanah/20 bg-amanah/5 p-4 text-sm text-amanah">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          No problems found. Your lines are ready for the next step.
        </p>
      ) : (
        <div className="space-y-6">
          <p className="text-sm text-foreground">
            <span className="font-semibold">{mustFix}</span> to fix · <span className="font-semibold">{toCheck}</span> to check.
            {mustFix > 0 ? " Go back to the sales or purchases step and correct the lines." : " Nothing here needs a change."}
          </p>
          {groups.map((entry) => (
            <section key={entry.title} className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">
                {entry.title} <span className="font-normal text-muted-foreground">({entry.items.length})</span>
              </h3>
              <ProblemList problems={entry.items} />
            </section>
          ))}
        </div>
      )}
      <p className="rounded-xl border bg-muted/30 p-3 text-sm text-muted-foreground">
        Next, you will add the figures that are not on any line, and then review your return worksheet.
      </p>
    </div>
  );
}

/** Row groups in the order of form SST-03. */
const SECTIONS: { title: string; srs: string[] }[] = [
  { title: "Input tax (purchases)", srs: ["1", "2", "3", "4", "5", "6", "7", "7a", "7b", "8"] },
  { title: "Output tax (sales and exports)", srs: ["9a", "9b", "10", "11", "12", "13", "14", "14a", "14b", "15"] },
  { title: "Credit carried forward", srs: ["17", "18", "19"] },
  { title: "Additional amounts and total", srs: ["20", "21", "22", "23", "24", "25", "26", "27"] },
];

function formatApprovedDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Karachi" });
}

function LineRow({ line }: { line: SrbReturnLine }) {
  const strong = line.sr === "15" || line.sr === "26" || line.sr === "8";
  return (
    <tr className={cn("border-t", strong && "bg-muted/30 font-semibold")}>
      <td className="whitespace-nowrap px-3 py-2 align-top text-muted-foreground">{line.sr}</td>
      <td className="px-3 py-2 align-top">
        <span className="text-foreground">{line.description}</span>
        {line.status === "provisional" && (
          <span className="ml-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700">
            Pending confirmation
          </span>
        )}
        {line.status === "input" && (
          <span className="ml-2 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Entered by you
          </span>
        )}
        {line.note && line.status !== "provisional" && <span className="block text-xs font-normal text-muted-foreground">{line.note}</span>}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right align-top tabular-nums">{amount(line.value)}</td>
      <td className="whitespace-nowrap px-3 py-2 text-right align-top tabular-nums">{line.sr === "10" ? "" : amount(line.amount)}</td>
    </tr>
  );
}

export function SrbReviewStep({
  stepNumber,
  state,
  loading,
  paymentDue,
  reviewed,
  onReviewed,
}: {
  stepNumber: number;
  state: SrbMonthState;
  loading: boolean;
  paymentDue: string | null;
  reviewed: boolean;
  onReviewed: (value: boolean) => void;
}) {
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const { review } = state;
  const approved = review.approval?.current === true;
  const byLine = new Map(review.lines.map((line) => [line.sr, line]));

  async function copyWorksheet() {
    try {
      await navigator.clipboard.writeText(review.worksheet);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <StepHeading eyebrow={`Step ${stepNumber}`} title="Review your return" />
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Preparing your worksheet…
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <StepHeading
        eyebrow={`Step ${stepNumber}`}
        title="Review your return"
        description="This is a worksheet to help you fill form SST-03 on the SRB portal. Nothing has been sent to SRB."
      />

      {approved && review.approval && (
        <p className="flex items-start gap-2 rounded-xl border border-amanah/20 bg-amanah/5 p-3 text-sm text-foreground">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-amanah" />
          <span>You approved this worksheet on {formatApprovedDate(review.approval.approvedAt)}. Nothing has been sent to SRB.</span>
        </p>
      )}
      {review.approval && !approved && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>Your lines or figures changed after you approved this worksheet. Review it again and approve it again.</span>
        </p>
      )}

      {!review.canEstimate ? (
        <div className="space-y-3">
          <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-foreground">
            The worksheet could not be prepared. Read the message below, then go back and correct it.
          </p>
          <ProblemList problems={review.problems} />
        </div>
      ) : (
        <>
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Estimated balance payable (row 26)</p>
            <p className="mt-1 text-2xl font-semibold text-foreground">{formatRupees(review.balancePayable ?? 0)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Pending confirmation. Compare it with the figure the portal shows, and pay the amount the portal shows.
              {paymentDue ? ` Payment is due on ${formatIsoDate(paymentDue)}.` : ""}
            </p>
          </div>

          <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span>
              Rows 1 to 12 follow the form directly. Rows 13 to 26 depend on how the portal treats reduced-rate services
              in row 13, which has not been confirmed against a real portal return yet. Enter your lines on the portal
              first and compare rows 5, 9a, 9b, 11 and 14a with this worksheet.
            </span>
          </p>

          <div className="space-y-4">
            {SECTIONS.map((section) => {
              const lines = section.srs.map((sr) => byLine.get(sr)).filter((line): line is SrbReturnLine => Boolean(line));
              return (
                <section key={section.title} className="space-y-1.5">
                  <h3 className="text-sm font-semibold text-foreground">{section.title}</h3>
                  <div className="overflow-x-auto rounded-xl border bg-card">
                    <table className="w-full min-w-[28rem] text-sm">
                      <thead>
                        <tr className="text-left text-xs text-muted-foreground">
                          <th className="px-3 py-2 font-medium">Row</th>
                          <th className="px-3 py-2 font-medium">Description</th>
                          <th className="px-3 py-2 text-right font-medium">Value</th>
                          <th className="px-3 py-2 text-right font-medium">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lines.map((line) => (
                          <LineRow key={line.sr} line={line} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })}
          </div>

          <section className="space-y-2 rounded-xl border bg-card p-4">
            <h3 className="text-sm font-semibold text-foreground">Worksheet to keep beside the portal</h3>
            <p className="text-xs text-muted-foreground">
              Copy this text into a note or document. It lists every row and every line in the order the portal asks for them.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={copyWorksheet}>
                <ClipboardCopy className="h-3.5 w-3.5" />
                Copy worksheet
              </Button>
              {copied === "done" && <span className="text-xs text-amanah">Copied.</span>}
              {copied === "failed" && <span className="text-xs text-destructive">Could not copy. Select the text below and copy it.</span>}
            </div>
            <textarea
              readOnly
              aria-label="Return worksheet"
              value={review.worksheet}
              rows={10}
              className="w-full rounded-lg border bg-muted/30 p-3 font-mono text-xs"
            />
          </section>

          {review.problems.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">Please check</h3>
              <ProblemList problems={review.problems} />
            </section>
          )}

          {!approved && (
            <label className="flex items-start gap-3 rounded-xl border bg-card p-3.5 text-sm text-foreground">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(event) => onReviewed(event.target.checked)}
                className="mt-0.5 h-5 w-5 shrink-0 accent-[#376952]"
              />
              <span>
                Yes, I have reviewed these figures and the lines behind them. I understand this is a worksheet, rows 13
                to 26 are pending confirmation, and the SRB portal decides the final amounts.
              </span>
            </label>
          )}
        </>
      )}
    </div>
  );
}
