"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  clearWithholdingDiagnostics,
  downloadWithholdingDiagnostics,
  getWithholdingDiagnosticStatus,
  startWithholdingDiagnostics,
  stopWithholdingDiagnostics,
  type WithholdingDiagnosticStatus,
} from "@/lib/tax/withholding-diagnostic-log";

const EMPTY_STATUS: WithholdingDiagnosticStatus = {
  active: false,
  eventCount: 0,
  startedAt: null,
  truncated: false,
};

export function WithholdingDiagnosticsControls() {
  const [status, setStatus] = useState(EMPTY_STATUS);

  useEffect(() => {
    const refresh = () => setStatus(getWithholdingDiagnosticStatus());
    refresh();
    window.addEventListener("taxrocket-withholding-diagnostic-update", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("taxrocket-withholding-diagnostic-update", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  if (process.env.NODE_ENV !== "development") return null;

  function handleClear() {
    if (status.eventCount > 0 && !window.confirm("Purana diagnostic log clear kar dein?")) {
      return;
    }
    clearWithholdingDiagnostics();
    setStatus(getWithholdingDiagnosticStatus());
  }

  return (
    <section
      aria-label="Freelancer withholding diagnostic logger"
      className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800"
    >
      <span className="font-semibold">
        Diagnostic log: {status.active ? "recording" : "band"}
      </span>
      <span>{status.eventCount} events{status.truncated ? " · puranay events trim huay" : ""}</span>
      {!status.active ? (
        <Button type="button" size="sm" variant="outline" onClick={() => {
          startWithholdingDiagnostics();
          setStatus(getWithholdingDiagnosticStatus());
        }}>
          {status.eventCount ? "Resume logging" : "Start logging"}
        </Button>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => {
          stopWithholdingDiagnostics();
          setStatus(getWithholdingDiagnosticStatus());
        }}>
          Stop logging
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={downloadWithholdingDiagnostics}
        disabled={status.eventCount === 0}
      >
        JSON download
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={handleClear}>
        Clear
      </Button>
      <span className="basis-full text-[10px] text-slate-600">
        Development mode only. File names, invoice and payout references and
        personal or bank identifiers are never stored in raw form; only amounts
        and tax codes are written to the log.
      </span>
    </section>
  );
}
