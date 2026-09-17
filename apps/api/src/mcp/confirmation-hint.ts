// SPDX-License-Identifier: BUSL-1.1
/**
 * MCP-only guidance on a `CONFIRMATION_REQUIRED` refusal. The Operation's
 * own detail says "retry with confirmed set to true"; an MCP client that then
 * rejects `confirmed` as an unknown argument is validating against a tool
 * list it fetched before the Operation declared that field (ChatGPT
 * snapshots a connector's schemas at registration and does not refetch).
 * The assistant cannot see its own stale schema, so the refusal names the
 * cause and the way out instead of leaving it to retry the same call.
 */
export const STALE_TOOL_LIST_HINT =
  "If your client rejects the `confirmed` argument as unknown, its tool list predates this " +
  "Operation's confirmation field: refresh the connector so it fetches the current tools, " +
  "then retry with confirmed set to true.";

type FailureBody = { error?: { code?: unknown; hint?: unknown } & Record<string, unknown> } & Record<string, unknown>;

/** The body unchanged unless it is a confirmation refusal, which gains the hint. */
export function withConfirmationHint<T extends FailureBody>(body: T): T {
  const error = body.error;
  if (!error || error.code !== "CONFIRMATION_REQUIRED" || typeof error.hint === "string") return body;
  return { ...body, error: { ...error, hint: STALE_TOOL_LIST_HINT } };
}
