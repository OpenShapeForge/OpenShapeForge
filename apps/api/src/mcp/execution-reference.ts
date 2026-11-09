// SPDX-License-Identifier: BUSL-1.1
import type { OperationExecutionReference } from "@openshapeforge/operations";
import type { CallToolResult } from "@modelcontextprotocol/server";

// JSON from upstream/native MCP cannot forge this core-owned symbol. It is
// enumerable so ordinary result spreads (configuration metadata) preserve it;
// JSON serialization ignores symbol keys entirely.
const execution = Symbol("canonical execution reference");
type WithExecution = CallToolResult & { [execution]?: OperationExecutionReference };
export function withExecutionReference<T extends CallToolResult>(result: T, reference?: OperationExecutionReference): T {
  if (reference) (result as WithExecution)[execution] = reference;
  return result;
}
export function executionReferenceOf(result: CallToolResult): OperationExecutionReference | undefined {
  return (result as WithExecution)[execution];
}
