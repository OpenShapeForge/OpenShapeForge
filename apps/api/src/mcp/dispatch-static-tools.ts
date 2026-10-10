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
import { searchableSessionOperations } from "./searchable-session-operations.js";
import { entityOperationContract } from "../operations/entity/index.js";
import { pluginEntityTransportInput } from "../operations/entity/transport-input.js";
import { entityIsGeneric } from "./generic-tool-projection.js";
import { parseOperationExecuteArguments, searchOperationDefinitions } from "./operation-search.js";
import { invokeOperation } from "../operations/runtime.js";
import {
  catalog,
  isDerivedHelperToolName,
} from "./catalog.js";
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
import type { CallToolResult } from "@modelcontextprotocol/server";
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
    compatibilityCall,
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
      const { definitions, allowedIds } = await searchableSessionOperations(ctx);
      return ok(searchOperationDefinitions({
        definitions,
        allowedIds,
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
      const { definitions, entities } = await searchableSessionOperations(ctx);
      const definition = definitions.find((candidate) => candidate.id === parsed.operationId);
      if (!definition) {
        throw new HttpError(404, "NOT_FOUND", "The requested Operation is not available.");
      }
      const entity = entities.get(definition.id);
      if (entity) {
        // Enter the same adapter as the dedicated/generic tool, including
        // private elicitation, edit controls, classified fields and notifications.
        const input = parsed.idempotencyKey === undefined ? parsed.input : pluginEntityTransportInput(
          entityOperationContract(definition.id), parsed.input, undefined, parsed.idempotencyKey);
        const outcome = await ctx.dispatchTool(
          entity.tool.name,
          { ...input, ...(entityIsGeneric(entity.entity) ? { entity: entity.tool.entity } : {}) },
          ctx.requestId,
          true,
          undefined,
          assertParentInvocationActive,
          signal,
          false,
          parsed.idempotencyKey,
        );
        const result = outcome.result;
        const payload = result.structuredContent;
        if (result.isError || !payload || typeof payload !== "object" || Array.isArray(payload) || ("data" in payload && "operations" in payload)) return result;
        const continuation = payload as Record<string, unknown>;
        // Private configuration may pause before a record exists. Preserve
        // its UI metadata, but answer the generic executor's canonical envelope.
        const data = {
          ...continuation,
          ...(typeof continuation.resumeWith === "string"
            ? { resumeWith: { operationId: `${entity.tool.entity}.list`, input: {} } }
            : {}),
        };
        const structuredContent = { data, operations: [] };
        return { ...result, structuredContent, content: result.content.map((block) => {
          if (block.type !== "text") return block;
          try { JSON.parse(block.text); return { ...block, text: JSON.stringify(structuredContent) }; }
          catch { return block; }
        }) };
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
  // A derived-tool helper's public name may also be a plugin Operation's
  // MCP name: that Operation is implemented by the helper through the
  // execution compatibility bridge, so the bridge's dispatch (compatibilityCall)
  // and a direct call under the name both go to the helper section below —
  // matching the Operation here would run the plugin handler, which bridges
  // straight back to this dispatch.
  const operationTool =
    compatibilityCall || isDerivedHelperToolName(name)
      ? undefined
      : catalog.operationTools.find((tool) => tool.name === name);
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
