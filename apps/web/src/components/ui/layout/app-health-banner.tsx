// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "@openshapeforge/ui/button";

type CheckResult = { ok: boolean; latencyMs: number | null; error?: string };
type HealthBody = {
  status: "healthy" | "degraded" | "unhealthy";
  checks: { keycloak: CheckResult; graphql: CheckResult };
};

const POLL_INTERVAL_MS = 30_000;

function summarize(body: HealthBody): string {
  const failed = (Object.entries(body.checks) as [string, CheckResult][])
    .filter(([, r]) => !r.ok)
    .map(([name]) => name);
  if (failed.length === 0) return "Servicestatus is gedegradeerd.";
  return `Servicestatus is ${body.status === "unhealthy" ? "verstoord" : "gedegradeerd"}: ${failed.join(", ")} reageert niet.`;
}

export function AppHealthBanner() {
  const [body, setBody] = useState<HealthBody | null>(null);
  const [loaded, setLoaded] = useState(false);
  const inFlight = useRef(false);

  const fetchHealth = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const json = (await res.json()) as HealthBody;
      setBody(json);
    } catch {
      // Network failure to our own /api/health is itself a degraded signal but
      // we don't want to spam the banner on transient blips, so just hold the
      // last-known state.
    } finally {
      inFlight.current = false;
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") fetchHealth();
    }, POLL_INTERVAL_MS);
    const onFocus = () => fetchHealth();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchHealth]);

  if (!loaded || !body || body.status === "healthy") {
    return null;
  }

  return (
    <div
      role="alert"
      className="flex items-start gap-3 border-b border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-700" aria-hidden="true" />
      <div className="flex-1">{summarize(body)}</div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={fetchHealth}
        className="border-red-300 text-red-900 hover:bg-red-100"
      >
        Opnieuw proberen
      </Button>
    </div>
  );
}
