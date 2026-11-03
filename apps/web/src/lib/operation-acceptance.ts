// SPDX-License-Identifier: BUSL-1.1
/**
 * An Operation taken over by an operation override (for example a workflow)
 * answers "accepted": the request was taken and the change happens, if at
 * all, when that work completes. It is neither a failure nor the original's
 * result, so the web client must not report it as failed, as deleted or as
 * saved. GraphQL carries it as an error with code `OPERATION_ACCEPTED` and
 * the acceptance in `extensions.accepted`; REST answers 202.
 */
export type OperationAcceptance = {
  by: { kind: string; ref: string };
  status: "running" | "waiting" | "completed";
};

const STATUSES = new Set(["running", "waiting", "completed"]);

export function isOperationAcceptance(value: unknown): value is OperationAcceptance {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { by?: { kind?: unknown; ref?: unknown }; status?: unknown };
  return typeof candidate.by?.kind === "string" && typeof candidate.by.ref === "string" &&
    typeof candidate.status === "string" && STATUSES.has(candidate.status);
}

/** The acceptance a GraphQL response payload carries, if it carries one. */
export function acceptanceFromGraphqlPayload(payload: unknown): OperationAcceptance | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const errors = (payload as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return undefined;
  for (const error of errors) {
    const extensions = (error as { extensions?: { code?: unknown; accepted?: unknown } } | null)?.extensions;
    if (extensions?.code === "OPERATION_ACCEPTED" && isOperationAcceptance(extensions.accepted)) {
      return extensions.accepted;
    }
  }
  return undefined;
}

/** What the person is told: started, not done. */
export function acceptanceMessage(accepted: OperationAcceptance, lang: string | undefined): string {
  const { kind, ref } = accepted.by;
  if (accepted.status === "completed") {
    return lang === "nl" ? `Afgehandeld door ${kind} ${ref}.` : `Handled by ${kind} ${ref}.`;
  }
  return lang === "nl"
    ? `Gestart: ${kind} ${ref}. De wijziging gebeurt wanneer die is afgerond.`
    : `Started: ${kind} ${ref}. The change happens when it completes.`;
}
