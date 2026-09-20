// SPDX-License-Identifier: BUSL-1.1
import { ARTIFACT_UPLOAD_TOOL_NAME, mintArtifactUpload } from "./artifact-upload.js";
import { callEditLeaseTool } from "./edit-lease-tools.js";
import { HttpError } from "../rest/http-error.js";
import { listConnectorContracts } from "../connectors/catalog.js";
import { resolveConnectorTool } from "../connectors/mcp-tools.js";
import { connectorGovernor, connectorKeyring, connectorRegistry } from "../connectors/dispatch.js";
import { invokeConnectorOperation } from "../connectors/runtime.js";
import { SESSION_INFO_TOOL_NAME } from "./session-info.js";
import { sessionInfoToolResult } from "./session-describe.js";
import { parseOperationExecuteArguments, searchOperationDefinitions } from "./operation-search.js";
import { invokeOperation } from "../operations/runtime.js";
import { catalog } from "./catalog.js";
import { operationMayInvoke } from "./entity-tool-invocation.js";
import {
  callbackOrigin,
  elicitedKeyring,
  publicOriginIsHttps,
  supportsMcpApp,
} from "./handoff-config.js";
import {
  type ToolResult,
  failed,
  ok,
  operationToolResult,
  runtimeOperationToolResult,
} from "./tool-results.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DirectCallScope } from "./tool-dispatch.js";

/**
 * The static-tool section of tool dispatch. Split out of generated-mcp-server.ts.
 */

/**
 * The static tools: whoami, the private upload, edit leases, the searchable
 * Operation tools, provider and catalogue Operations, and connector tools.
 */
export async function staticToolCall(
  ctx: DirectCallScope,
): Promise<CallToolResult | undefined> {
  const {
    allowedEditLeaseOperationIds,
    assertInterceptorActive,
    assertParentInvocationActive,
    canUploadArtifacts,
    current,
    db,
    egressOwner,
    egressSource,
    idempotencyKey,
    locale,
    modulePlatform,
    moduleSession,
    name,
    operationToolProjection,
    operations,
    request,
    searchableOperationToolNames,
    searchableStaticOperationIds,
    server,
    session,
    sessionInfo,
    signal,
  } = ctx;
  // --- session-info (whoami / osf://session): no arguments, no roles ---
  if (name === SESSION_INFO_TOOL_NAME) {
    try {
      return sessionInfoToolResult(await sessionInfo());
    } catch (error) {
      return failed(error);
    }
  }
  if (name === ARTIFACT_UPLOAD_TOOL_NAME && canUploadArtifacts) {
    try {
      const keyring = elicitedKeyring();
      if (!keyring) {
        throw new HttpError(
          503,
          "SECRET_STORAGE_NOT_CONFIGURED",
          "Secure upload handoffs are not configured.",
        );
      }
      const minted = await mintArtifactUpload({
        db,
        keyring,
        session,
        origin: callbackOrigin(),
      });
      if (supportsMcpApp(server) && publicOriginIsHttps()) {
        return {
          content: [{ type: "text", text: "A private document upload control is ready." }],
          _meta: {
            uploadUrl: minted.uploadUrl,
            expiresAt: minted.expiresAt,
          },
        };
      }
      return {
        content: [{
          type: "text",
          text: `This MCP client cannot show the private file picker. Ask the person to open ${minted.uploadUrl}; the one-time link expires at ${minted.expiresAt}.`,
        }],
        structuredContent: {
          pending: true,
          uploadUrl: minted.uploadUrl,
          expiresAt: minted.expiresAt,
        },
      };
    } catch (error) {
      return failed(error);
    }
  }
  // --- end session-info ---
  const editLeaseOutcome = await (async () => {
    try {
      return await callEditLeaseTool(
        name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
        db,
        session,
        allowedEditLeaseOperationIds,
      );
    } catch (error) {
      return failed(error);
    }
  })();
  if (editLeaseOutcome) {
    return "content" in editLeaseOutcome
      ? editLeaseOutcome as ToolResult
      : ok({ data: editLeaseOutcome, operations: [] });
  }
  if (
    operationToolProjection.mode === "searchable" &&
    name === searchableOperationToolNames.search
  ) {
    if (!modulePlatform) {
      return failed(
        new HttpError(
          503,
          "OPERATION_UNAVAILABLE",
          "The canonical Operation runtime is unavailable.",
        ),
      );
    }
    try {
      assertParentInvocationActive?.();
      assertInterceptorActive?.();
      const definitions = await modulePlatform.services.operations.list(
        moduleSession,
      );
      return ok(searchOperationDefinitions({
        definitions,
        allowedIds: searchableStaticOperationIds,
        arguments: request.params.arguments ?? {},
        locale,
      }));
    } catch (error) {
      return failed(error);
    }
  }
  if (
    operationToolProjection.mode === "searchable" &&
    name === searchableOperationToolNames.execute
  ) {
    if (!modulePlatform) {
      return failed(
        new HttpError(
          503,
          "OPERATION_UNAVAILABLE",
          "The canonical Operation runtime is unavailable.",
        ),
      );
    }
    try {
      const parsed = parseOperationExecuteArguments(
        request.params.arguments ?? {},
      );
      assertParentInvocationActive?.();
      assertInterceptorActive?.();
      const definition = searchableStaticOperationIds.has(parsed.operationId)
        ? await modulePlatform.services.operations.get(
            moduleSession,
            parsed.operationId,
          )
        : undefined;
      if (!definition || !searchableStaticOperationIds.has(definition.id)) {
        throw new HttpError(
          404,
          "NOT_FOUND",
          "The requested Operation is not available.",
        );
      }
      const result = await modulePlatform.services.operations.execute(
        moduleSession,
        {
          operation: { id: definition.id, intent: definition.intent },
          input: parsed.input,
          ...(parsed.idempotencyKey
            ? { idempotencyKey: parsed.idempotencyKey }
            : {}),
        },
        signal ? { signal } : {},
      );
      return runtimeOperationToolResult(result);
    } catch (error) {
      return failed(error);
    }
  }
  if (current?.runtimeOperation) {
    if (!modulePlatform) {
      return failed(
        new HttpError(
          503,
          "OPERATION_UNAVAILABLE",
          "The canonical Operation runtime is unavailable.",
        ),
      );
    }
    assertParentInvocationActive?.();
    assertInterceptorActive?.();
    const definition = current.runtimeOperation;
    const result = await modulePlatform.services.operations.execute(
      moduleSession,
      {
        operation: { id: definition.id, intent: definition.intent },
        input: request.params.arguments ?? {},
      },
      signal ? { signal } : {},
    );
    return runtimeOperationToolResult(result);
  }
  const operationTool = catalog.operationTools.find(
    (tool) => tool.name === name,
  );
  if (operationTool) {
    if (
      !operations.has(operationTool.key) ||
      !operationMayInvoke(operationTool, session)
    ) {
      return failed(
        new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`),
      );
    }
    try {
      assertParentInvocationActive?.();
      assertInterceptorActive?.();
      const result = await invokeOperation(
        operations.get(operationTool.key)!,
        request.params.arguments ?? {},
        {
          db,
          session: moduleSession,
          transport: "mcp",
          ...(modulePlatform ? { platform: modulePlatform.services } : {}),
        },
      );
      return operationToolResult(result);
    } catch (error) {
      return failed(error);
    }
  }

  // Connector operations dispatch outside CRUD — own input schema, own
  // executor — so they are resolved before the entity table lookup. An
  // unauthorized connector tool resolves to nothing, which falls through to
  // the same NOT_FOUND an unknown name gets.
  const connectorTool = resolveConnectorTool(listConnectorContracts(), name, {
    roles: session.roles ?? [],
  });
  if (connectorTool) {
    try {
      const registry = await connectorRegistry();
      assertParentInvocationActive?.();
      assertInterceptorActive?.();
      const result = await invokeConnectorOperation(
        {
          db,
          session,
          registry,
          governor: connectorGovernor(),
          keyring: connectorKeyring(),
          roles: session.roles ?? [],
          egressOwner,
          ...(egressSource ? { egressSource } : {}),
          ...(signal ? { signal } : {}),
        },
        connectorTool.contract,
        connectorTool.operation,
        request.params.arguments ?? {},
      );
      return ok(result);
    } catch (error) {
      return failed(error);
    }
  }
  return undefined;
}
