// SPDX-License-Identifier: BUSL-1.1
/**
 * Client-side helper to trigger an entity action by resolving a Restate
 * awakeable via the workflow service. Calls the Next.js API route that
 * proxies to the workflow trigger endpoint.
 */

import type { TriggerContinuation } from "../types";

export async function triggerEntityAction(
  awakeableId: string,
  formData?: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; continuation?: TriggerContinuation | null }> {
  const response = await fetch("/api/workflow/entity-actions/trigger", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ awakeableId, formData: formData ?? {} }),
  });

  if (response.status === 409) return { ok: false, error: "already_triggered" };
  if (response.status === 404) return { ok: false, error: "not_found" };
  if (!response.ok) return { ok: false, error: "trigger_failed" };

  const data = await response.json();
  return { ok: true, continuation: data.continuation ?? null };
}
