// SPDX-License-Identifier: BUSL-1.1
/**
 * The native provider of a derived tool's binding. Split out of
 * dispatch-derived-binding.ts, verbatim.
 */
import { HttpError } from "../rest/http-error.js";
import { invokeOperation, requireOperationAuthorization } from "../operations/runtime.js";
import { entityForTable } from "./catalog.js";
import { nativeOperationOutput, nativeToolArguments, nativeToolOutput } from "./composed-results.js";
import { invokeTool } from "./entity-tool-invocation.js";
import { resolveNativeCrudTool, withoutEntitySelector } from "./generic-tool-projection.js";
import type { DirectCallScope } from "./tool-dispatch.js";
/**
 * The platform-owned native provider of a derived tool's binding: runs the
 * generated Operation or entity tool in-process through the same executor an
 * entity tool call uses, under the caller's own session — roles, tenant and
 * row-level identity all preserved.
 */
export function nativeBindingInvoker(
  scope: Pick<DirectCallScope, "db" | "session" | "tables" | "operations" | "moduleSession" | "modulePlatform">,
  stepIdempotencyKey: string | undefined,
): (operationKey: string, inputs: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const { db, session, tables, operations, moduleSession, modulePlatform } = scope;
  return async (operationKey, inputs) => {
    const nativeTool = resolveNativeCrudTool(
      operationKey,
      inputs,
    );
    const nativeTable = nativeTool
      ? tables.get(nativeTool.table)
      : undefined;
    if (!nativeTool || !nativeTable) {
      // Not an entity tool: a plugin operation by key. It
      // runs through the operation runtime exactly as its
      // own transports would (roles, tenancy, contract
      // validation), whether or not it carries a dedicated
      // MCP tool — that is what lets a Service hand the
      // model an operation's content blocks without
      // spending a slot of the dedicated-tool budget.
      const bound = operations.get(operationKey);
      if (!bound) {
        throw new HttpError(
          400,
          "OPERATION_MISCONFIGURED",
          `Native operation "${operationKey}" is not a generated operation of this deployment.`,
        );
      }
      requireOperationAuthorization(bound.operation, moduleSession);
      const operationInputs =
        stepIdempotencyKey &&
          bound.operation.idempotency.mode === "idempotency-key"
          ? {
              ...inputs,
              [bound.operation.idempotency.inputField!]:
                stepIdempotencyKey,
            }
          : inputs;
      const produced = await invokeOperation(bound, operationInputs, {
        db,
        session: moduleSession,
        transport: "mcp",
        ...(modulePlatform
          ? { platform: modulePlatform.services }
          : {}),
      });
      return nativeOperationOutput(produced);
    }
    // `entity` picked the catalog entry; it is not a
    // column, so it is dropped before the per-entity shape
    // is built — the same split a direct call makes.
    const nativeArgs = nativeToolArguments(
      nativeTool.operation,
      withoutEntitySelector(nativeTool, inputs) ?? {},
    );
    const produced = await invokeTool(
      nativeTool,
      entityForTable(nativeTool.table),
      nativeTable,
      tables,
      db,
      session,
      nativeArgs,
    );
    return nativeToolOutput(produced);
  };
}
