// SPDX-License-Identifier: BUSL-1.1
/**
 * The session's executors for the Operation runtime. Split out of
 * generated-mcp-server.ts, verbatim.
 */
import { deriveToolName } from "./derived-tools.js";
import {
  type ConnectionControls,
  type ConnectionUse,
  inheritConnectionControls,
  parseConnectionExpectation,
  withConnectionControls,
} from "./connection-expectation.js";
import { HttpError } from "../rest/http-error.js";
import { compatibilityOperationByKey } from "./catalog.js";
import { sessionOperationRoleGroupsAllow, sessionOperationRolesAllow } from "../operations/session-authorization.js";
import {
  type RuntimeDeclarativeServiceExecutor,
  type RuntimeHostOperationExecutor,
  failed,
  runtimeDeclarativeServiceExecutors,
  runtimeHostOperationExecutors,
  runtimeOperationResult,
} from "./tool-results.js";
import type { RuntimeDeclarativeServiceConnectionUse } from "@openshapeforge/plugin-runtime";
import type { ServerScope } from "./server-scope.js";
import type { DispatchTool } from "./tool-dispatch.js";

/**
 * Project what core observed into the published answer. The one Connection
 * case is handed back in the expectation's own shape, with the only scope
 * core can vouch for: it saw every credential boundary of this invocation,
 * and they were all this Connection.
 */
function declarativeConnectionUse(
  use: ConnectionUse,
): RuntimeDeclarativeServiceConnectionUse {
  if (use.outcome !== "one-connection") return use;
  return {
    outcome: "one-connection",
    expectedConnection: {
      sourceReference: use.sourceReference,
      appliesTo: "every-provider-call",
    },
  };
}

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
    // The caller's opt-in expected Connection, read here under this session —
    // which is what scopes a presented Connection id to its tenant — and
    // composed with the controls of the invocation this one may be nested
    // inside. A malformed or unrecognised expectation refuses instead of
    // running without one, and a nested caller can only confirm the inherited
    // expectation or add a second way of naming the same row, never replace it
    // — both refusals land here, before any provider effect of this call.
    let controls: ConnectionControls;
    try {
      controls = inheritConnectionControls(
        parseConnectionExpectation(request.expectedConnection, session),
      );
    } catch (error) {
      return runtimeOperationResult(failed(error));
    }
    // Core's record of what this invocation uses. Created here and read back
    // here: the recorder itself never crosses into module code, so the answer
    // below is core's own observation of its own credential boundaries. It
    // also feeds the enclosing invocation's recorder, so a Service reached
    // through a native binding cannot leave the outer answer naming one
    // Connection when two were used.
    const recorder = controls.connectionUse!;
    // In force for everything this invocation reaches in-process, not only for
    // what the dispatch arguments below carry: a native binding's canonical
    // Operation opens credentials and invokes Services through paths of its
    // own, and each of those is a credential boundary of THIS invocation.
    const outcome = await withConnectionControls(controls, () =>
      dispatchTool(
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
        controls,
      ),
    );
    const result = runtimeOperationResult(outcome.result);
    // A failure — including a composition that stopped part-way — hands out no
    // identity: there is nothing a caller should bind its next call to.
    if ("error" in result) return result;
    return {
      ...result,
      connectionUse: declarativeConnectionUse(recorder.used()),
    };
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
    const scopes = new Set(session.oauthScopes ?? []);
    // The same decision as every other surface: roles any-of AND each role group (#944).
    if (
      implementation.auth.mode !== "session" ||
      !sessionOperationRolesAllow(implementation.auth.roles, session.roles) ||
      !sessionOperationRoleGroupsAllow(implementation.auth.roleGroups, session.roles) ||
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
