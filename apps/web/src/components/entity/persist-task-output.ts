// SPDX-License-Identifier: BUSL-1.1
"use server";

import { executeGraphqlRequest } from "@/lib/server/graphql-client";

/**
 * Write an embedded human-task form's values back to `task.output`.
 *
 * Only invoked for a related pane whose entity is named `Task`
 * (`persistTaskOutput` in `entity-workspace-page`), which requires the host
 * repo to author such an entity. Issued against the generated GraphQL surface
 * rather than a generated per-entity server action so this module resolves
 * whether or not `Task` is authored — a deployment without it never reaches
 * this call.
 */
export async function persistTaskOutput(
  id: string,
  output: Record<string, unknown>,
): Promise<void> {
  const result = await executeGraphqlRequest<{
    updateTask?: {
      data?: { id?: string } | null;
      error?: { code?: string; message?: string } | null;
    } | null;
  }>({
    query: `mutation PersistTaskOutput($input: UpdateTaskInput!) { updateTask(input: $input) { data { id } error { code message } } }`,
    variables: { input: { id, output } },
  });
  const error = result.updateTask?.error;
  if (error) {
    throw new Error(
      `${error.code ?? "OPERATION_FAILED"}: ${error.message ?? "Operation failed."}`,
    );
  }
}
