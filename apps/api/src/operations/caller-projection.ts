// SPDX-License-Identifier: BUSL-1.1
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { ModulePlatformServices } from "../modules/contract.js";
import type { RuntimeOperationExecutionResult, RuntimeOperationRequest } from "@openshapeforge/plugin-runtime";
import { isWithheldOperation } from "./entity/runtime.js";

/**
 * What a caller may address by id. An Operation its entity withholds from every
 * interface is written through by another Operation, under that one's lease and
 * version; a caller naming it directly would have neither. Other Operations
 * still reach it through the platform port.
 */
export const addressable = <T extends { id: string }>(definitions: readonly T[]): T[] =>
  definitions.filter((definition) => !isWithheldOperation(definition.id));

export function executeForCaller(
  platform: ModulePlatformServices,
  session: TrustedSessionContext,
  request: RuntimeOperationRequest,
): Promise<RuntimeOperationExecutionResult> {
  if (!isWithheldOperation(request.operation.id)) return platform.operations.execute(session, request);
  return Promise.resolve({ error: { code: "OPERATION_NOT_FOUND", message: "The requested Operation is not available.", retryable: false } });
}
