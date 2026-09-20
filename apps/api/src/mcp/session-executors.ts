// SPDX-License-Identifier: BUSL-1.1
/**
 * The session's executors for the Operation runtime. Split out of
 * generated-mcp-server.ts, verbatim.
 */
import { deriveToolName } from "./derived-tools.js";
import { HttpError } from "../rest/http-error.js";
import { compatibilityOperationByKey } from "./catalog.js";
import {
  type RuntimeDeclarativeServiceExecutor,
  type RuntimeHostOperationExecutor,
  failed,
  runtimeDeclarativeServiceExecutors,
  runtimeHostOperationExecutors,
  runtimeOperationResult,
} from "./tool-results.js";
import type { ServerScope } from "./server-scope.js";
import type { DispatchTool } from "./tool-dispatch.js";

/**
 * The executors the Operation runtime calls back into this session with: a
 * declarative Service request and a host (compatibility) Operation, each
 * dispatched as an internal tool call and answered in the Operation
 * envelope. Registered per server so the runtime finds the session's own.
 */
export function registerSessionExecutors(
  scope: ServerScope,
  dispatchTool: DispatchTool,
): void {
  const {
    compatibilityDefinition,
    definitionFor,
    derivedDefinition,
    server,
    session,
  } = scope;
  const executeDeclarativeService: RuntimeDeclarativeServiceExecutor = async (
    request,
    requestId,
    assertInvocationActive,
    signal,
  ) => {
    signal?.throwIfAborted();
    assertInvocationActive?.();
    const toolName = deriveToolName(request.definition.key);
    if (!toolName) {
      return runtimeOperationResult(failed(
        new HttpError(404, "OPERATION_NOT_FOUND", "The declarative Service is unavailable."),
      ));
    }
    const current = await compatibilityDefinition(request) ??
      await derivedDefinition(toolName, true);
    if (!current) {
      return runtimeOperationResult(failed(
        new HttpError(404, "OPERATION_NOT_FOUND", "The declarative Service is unavailable."),
      ));
    }
    const definition = definitionFor(current.entry, current.row);
    if (
      definition.kind !== request.definition.entity ||
      definition.id !== request.definition.id ||
      String(definition.version) !== String(request.definition.version) ||
      String(current.row[current.entry.keyField] ?? "") !== request.definition.key
    ) {
      return runtimeOperationResult(failed(
        new HttpError(404, "OPERATION_NOT_FOUND", "The declarative Service is unavailable."),
      ));
    }
    const selectedOptions = request.sourceReference
      ? {
          sourceReference: request.sourceReference,
          expectedDefinition: definition,
        }
      : undefined;
    const outcome = await dispatchTool(
      toolName,
      request.input ?? {},
      requestId,
      true,
      selectedOptions,
      assertInvocationActive,
      signal,
      true,
      request.idempotencyKey,
      false,
      current,
    );
    return runtimeOperationResult(outcome.result);
  };
  runtimeDeclarativeServiceExecutors.set(server, executeDeclarativeService);

  const executeHostOperation: RuntimeHostOperationExecutor = async (
    request,
    requestId,
    assertInvocationActive,
    signal,
  ) => {
    signal?.throwIfAborted();
    assertInvocationActive?.();
    const implementation = compatibilityOperationByKey.get(request.operation);
    if (!implementation) {
      return runtimeOperationResult(failed(
        new HttpError(404, "OPERATION_NOT_FOUND", "The host Operation is unavailable."),
      ));
    }
    const roles = new Set(session.roles);
    const scopes = new Set(session.oauthScopes ?? []);
    if (
      implementation.auth.mode !== "session" ||
      !implementation.auth.roles.some((role) => roles.has(role)) ||
      !(implementation.auth.scopes ?? []).every((scope) => scopes.has(scope))
    ) {
      return runtimeOperationResult(failed(
        new HttpError(404, "OPERATION_NOT_FOUND", "The host Operation is unavailable."),
      ));
    }
    const outcome = await dispatchTool(
      implementation.toolName,
      request.input ?? {},
      requestId,
      true,
      undefined,
      assertInvocationActive,
      signal,
      true,
      request.idempotencyKey,
      true,
    );
    return runtimeOperationResult(outcome.result);
  };
  runtimeHostOperationExecutors.set(server, executeHostOperation);
}
