// SPDX-License-Identifier: BUSL-1.1
import type { OperationExecutionReference } from "@openshapeforge/operations";
import type { CallToolResult } from "@modelcontextprotocol/server";

// Only canonical projections set this. Upstream/native MCP content can never
// opt an unrelated tool into another owner's execution by forging JSON.
const references = new WeakMap<CallToolResult, OperationExecutionReference>();
export function withExecutionReference<T extends CallToolResult>(result: T, reference?: OperationExecutionReference): T {
  if (reference) references.set(result, reference);
  return result;
}
export function executionReferenceOf(result: CallToolResult): OperationExecutionReference | undefined {
  return references.get(result);
}
