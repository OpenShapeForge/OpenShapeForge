// SPDX-License-Identifier: BUSL-1.1
import type { OperationExecutionReference } from "@openshapeforge/operations";
import type { RuntimeOperationRequest, RuntimeOperationExecutionResult } from "./index.js";

export type RuntimeExecutionContext = {
  locale?: string;
  /** Always dispatch through the live caller's canonical Operations. */
  execute(request: RuntimeOperationRequest): Promise<RuntimeOperationExecutionResult>;
};

export type RuntimeExecutionSnapshot = {
  status: "working" | "completed" | "cancelled";
  updatedAt: string;
  statusMessage?: string;
  /** The original envelope shape, read again with current permissions. */
  result: RuntimeOperationExecutionResult;
  isError?: boolean;
};

/** An execution owner, not another worker or authorization layer. Terminal states must not reopen. */
export type RuntimeExecutionProvider = {
  kind: string;
  read(context: RuntimeExecutionContext, reference: OperationExecutionReference): Promise<RuntimeExecutionSnapshot>;
  /** Cooperative cancellation through an existing canonical Operation. */
  cancel?(context: RuntimeExecutionContext, reference: OperationExecutionReference): Promise<void>;
};
