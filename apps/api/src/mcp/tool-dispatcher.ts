// SPDX-License-Identifier: BUSL-1.1
/**
 * The tool call entry of one session. Split out of generated-mcp-server.ts,
 * verbatim.
 */
import { GENERIC_DESCRIBE_TOOL_NAME } from "@openshapeforge/operations";
import { type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { inputSchemaFromStoredFields, type DerivedToolsCatalogEntry } from "./derived-tools.js";
import { HttpError } from "../rest/http-error.js";
import { listConnectorContracts } from "../connectors/catalog.js";
import { resolveConnectorTool } from "../connectors/mcp-tools.js";
import type { ModuleToolExecutionOptions, ModuleToolExecutionResult } from "../modules/contract.js";
import { interceptMcpToolCall, invokeModuleTool } from "../modules/mcp-hooks.js";
import { parseModuleToolExecutionOptions, type ResolvedInvocationSource } from "../modules/invocation-sources.js";
import {
  type CapturedDerivedExecution,
  catalog,
  catalogDerivedTools,
  catalogGuideTools,
  compatibilityToolNames,
} from "./catalog.js";
import { operationMayInvoke, projectCatalogOperationTool } from "./entity-tool-invocation.js";
import { type ListedTool } from "./session-surface.js";
import { directToolCall } from "./tool-dispatch.js";
import { failed } from "./tool-results.js";
import type { ServerScope } from "./server-scope.js";
import type { SessionSurface } from "./session-surface.js";
import type { DispatchTool } from "./tool-dispatch.js";

/**
 * One tool call from name to result: resolves the listed tool and the
 * invocation source the caller selected (or the vault composes), then runs
 * the modules' interceptors around the direct call (tool-dispatch.ts).
 * Recursive: a derived tool's binding may dispatch another tool.
 */
export function createDispatchTool(scope: ServerScope, surface: SessionSurface): DispatchTool {
  const {
    invocationContext,
    locale,
    modulePlatform,
    moduleSession,
    operationToolProjection,
    operations,
    runtimeModules,
    searchableOperationToolNames,
    session,
    sourceFromReference,
    sourceVault,
  } = scope;
  const {
    listedTools,
  } = surface;
  const dispatchTool = async (
    name: string,
    args: Record<string, unknown>,
    requestId: string | number,
    internal: boolean,
    selectedOptions?: ModuleToolExecutionOptions,
    assertParentInvocationActive?: () => void,
    signal?: AbortSignal,
    bypassInterceptors = false,
    idempotencyKey?: string,
    compatibilityCall = false,
    internalDerivedDefinition?: {
      entry: DerivedToolsCatalogEntry;
      row: Record<string, unknown>;
    },
  ): Promise<ModuleToolExecutionResult> => {
    signal?.throwIfAborted();
    assertParentInvocationActive?.();
    const request = { params: { name, arguments: args } };
    const extra = { requestId };
    // The sections of the call (mcp/tool-dispatch.ts) read the session's
    // scope and surface plus this call's own facts; `current` is read when
    // the call runs, after the listing below resolved it.
    const directCall = (
      _options?: ModuleToolExecutionOptions,
      selected?: ResolvedInvocationSource,
      assertInterceptorActive?: () => void,
    ): Promise<CallToolResult> =>
      directToolCall(
        {
          ...scope,
          ...surface,
          dispatchTool,
          name,
          args,
          requestId,
          internal,
          selectedOptions,
          assertParentInvocationActive,
          signal,
          bypassInterceptors,
          idempotencyKey,
          compatibilityCall,
          internalDerivedDefinition,
          request,
          extra,
          current,
        },
        _options,
        selected,
        assertInterceptorActive,
      );

    let preselectedReference: ResolvedInvocationSource | undefined;
    let current: ListedTool | undefined;
    try {
      signal?.throwIfAborted();
      const initialSelection = parseModuleToolExecutionOptions(selectedOptions);
      if (initialSelection.kind === "reference") {
        if (!internal) {
          throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
        }
        preselectedReference = await sourceVault.resolveReference(
          session,
          name,
          selectedOptions!,
          (reference) => sourceFromReference(
            reference,
            name,
            (request.params.arguments ?? {}) as Record<string, unknown>,
            signal,
          ),
          signal,
        );
        const hidden = preselectedReference?.internal as
          | CapturedDerivedExecution
          | undefined;
        if (!hidden || hidden.operationRow.kind !== "query") {
          throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
        }
        const collidesWithCore =
          name === GENERIC_DESCRIBE_TOOL_NAME ||
          catalog.tools.some((tool) => tool.name === name) ||
          catalog.operationTools.some((tool) => tool.name === name) ||
          catalogDerivedTools.some(
            (entry) =>
              entry.connect?.name === name ||
              entry.dryRun?.name === name ||
              entry.personalization?.set.name === name,
          ) ||
          catalogGuideTools.some((tool) => tool.name === name) ||
          (catalog.discoveryTools ?? []).some((tool) => tool.name === name) ||
          (catalog.testTools ?? []).some((tool) => tool.name === name) ||
          (operationToolProjection.mode === "searchable" &&
            Object.values(searchableOperationToolNames).includes(name)) ||
          resolveConnectorTool(listConnectorContracts(), name, {
            roles: session.roles ?? [],
          }) !== undefined;
        if (collidesWithCore) {
          throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
        }
        if (hidden.entry.execution) {
          current = {
            source: "derived",
            tool: {
              name,
              description: String(
                hidden.serviceRow[hidden.entry.descriptionField] ?? name,
              ),
              inputSchema: inputSchemaFromStoredFields(
                hidden.serviceRow[hidden.entry.inputFieldsField],
                locale,
              ) as Tool["inputSchema"],
            },
          };
        }
      } else {
        signal?.throwIfAborted();
        current = internalDerivedDefinition
          ? {
              source: "derived",
              tool: {
                name,
                description: String(
                  internalDerivedDefinition.row[
                    internalDerivedDefinition.entry.descriptionField
                  ] ?? name,
                ),
                inputSchema: inputSchemaFromStoredFields(
                  internalDerivedDefinition.row[
                    internalDerivedDefinition.entry.inputFieldsField
                  ],
                  locale,
                ) as Tool["inputSchema"],
              },
            }
          : compatibilityCall && compatibilityToolNames.has(name)
          ? {
              source: "operation",
              tool: {
                name,
                description: "Internal compatibility implementation.",
                inputSchema: { type: "object", additionalProperties: true },
              },
            }
          : await (async (): Promise<ListedTool | undefined> => {
              const listed = (await listedTools()).find(
                (entry) => entry.tool.name === name,
              );
              if (listed || operationToolProjection.mode !== "searchable") {
                return listed;
              }
              // Searchable projection bounds tools/list, but a previously
              // integrated client may still call the authored direct name.
              // Reapply the same live availability guard before selecting it.
              const direct = catalog.operationTools.find(
                (tool) => tool.name === name,
              );
              return direct &&
                  operations.has(direct.key) &&
                  operationMayInvoke(direct, session)
                ? { source: "operation", tool: projectCatalogOperationTool(direct) }
                : undefined;
            })();
        signal?.throwIfAborted();
      }
    } catch (error) {
      return {
        result: failed(error),
      };
    }
    if (!current) {
      return {
        result: failed(
          new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`),
        ),
      };
    }
    assertParentInvocationActive?.();
    const ctx = invocationContext(extra.requestId);
    const invoke = async (
      options?: ModuleToolExecutionOptions,
      assertInterceptorActive?: () => void,
    ): Promise<ModuleToolExecutionResult> => {
      signal?.throwIfAborted();
      assertParentInvocationActive?.();
      assertInterceptorActive?.();
      const parsedSelection = parseModuleToolExecutionOptions(options);
      if (parsedSelection.kind === "reference" && !internal) {
        throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
      }
      if (preselectedReference && parsedSelection.kind !== "reference") {
        throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
      }
      if (
        current!.source === "module" &&
        parsedSelection.kind !== "none"
      ) {
        throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
      }
      let selected: ResolvedInvocationSource | undefined;
      if (parsedSelection.kind === "reference") {
        const expected = parsedSelection.expectedDefinition;
        if (
          !preselectedReference ||
          parsedSelection.value !== preselectedReference.sourceReference ||
          expected?.kind !== preselectedReference.definition.kind ||
          expected.id !== preselectedReference.definition.id ||
          expected.version !== preselectedReference.definition.version
        ) {
          throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
        }
        // Interceptors are arbitrary async module code. Re-resolve at the
        // execution linearization point so revocation/version/provider/scope
        // changes during an interceptor cannot run the captured stale graph.
        const currentSelection = await sourceVault.resolveReference(
          moduleSession,
          name,
          options!,
          (reference) => sourceFromReference(
            reference,
            name,
            (request.params.arguments ?? {}) as Record<string, unknown>,
            signal,
          ),
          signal,
        );
        if (
          !currentSelection ||
          currentSelection.authorityFingerprint !==
            preselectedReference.authorityFingerprint
        ) {
          throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
        }
        selected = preselectedReference;
      } else if (parsedSelection.kind === "handle") {
        selected = await sourceVault.consumeHandle(
          moduleSession,
          name,
          options!,
          ctx,
          signal,
        );
      }
      assertParentInvocationActive?.();
      assertInterceptorActive?.();
      const selectedCapture = selected?.internal as
        | CapturedDerivedExecution
        | undefined;
      if (
        internal &&
        parsedSelection.kind === "reference" &&
        (!selectedCapture || selectedCapture.operationRow.kind !== "query")
      ) {
        throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
      }
      if (current!.source === "module") {
        return invokeModuleTool(
            current!,
            name,
            (request.params.arguments ?? {}) as Record<string, unknown>,
            ctx,
          );
      }
      const result = await directCall(
        options,
        selected,
        assertInterceptorActive,
      );
      return {
        result,
        ...(selected && !(result as { isError?: boolean }).isError
          ? {
              execution: {
                sourceHandle: selected.sourceHandle,
                sourceReference: selected.sourceReference,
                binding: selected.binding,
                definition: selected.definition,
              },
            }
          : {}),
      };
    };
    try {
      const run = () => bypassInterceptors
        ? invoke(selectedOptions, assertParentInvocationActive)
        : interceptMcpToolCall(
            runtimeModules,
            {
              name,
              source: current.source,
              arguments: (request.params.arguments ?? {}) as Record<string, unknown>,
              ctx,
            },
            (options = selectedOptions, assertActive) =>
              invoke(options, assertActive),
          );
      assertParentInvocationActive?.();
      signal?.throwIfAborted();
      return modulePlatform
        ? await modulePlatform.withActiveInvocation(ctx, run, name)
        : await run();
    } catch (error) {
      return {
        result: failed(error),
      };
    }
  };
  return dispatchTool;
}
