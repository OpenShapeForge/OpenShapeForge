// SPDX-License-Identifier: BUSL-1.1
import type { ControlApiFailure } from "@/lib/clients/control-api";

/**
 * A refusal from the control API, rendered rather than thrown.
 *
 * The message is shown VERBATIM, which is a deliberate choice and safe because
 * of what is on the other side: `apps/api/src/control/rest-routes.ts` maps an
 * explicit list of codes to statuses and redacts everything else into a generic
 * 500, so nothing reaching here carries SQL text or unclassified upstream
 * detail. The messages that do reach here are written for an operator and are
 * the most useful thing on the screen — a 503 naming every missing environment
 * variable, or a slug rule with an example.
 *
 * The code is shown too. It is the vocabulary the API documents and the thing
 * worth quoting in a bug report; a message alone gets paraphrased.
 */
export function ControlApiError({ failure }: { failure: ControlApiFailure }) {
  return (
    <div
      role="alert"
      data-testid="control-api-error"
      data-code={failure.code}
      className="space-y-2 rounded-[var(--radius-medium)] border border-[var(--color-functional-red-40)] bg-[var(--color-functional-red-5)] p-4"
    >
      <p className="text-sm font-medium">The control plane refused this request.</p>
      <p className="text-sm text-[var(--color-foreground-subtle)]">{failure.message}</p>
      <p className="font-mono text-[12px] text-[var(--color-foreground-muted)]">
        HTTP {failure.status} · {failure.code}
      </p>
    </div>
  );
}
