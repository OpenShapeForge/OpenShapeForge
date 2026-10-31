import { authorizationProfileDecision } from "../auth/authorization-profile-decision.js";
import inventory from "../generated/compiler/authorization-operations.json" with { type: "json" };
// SPDX-License-Identifier: BUSL-1.1
import { completeEntitySecureInput } from "../operations/entity/runtime.js";
/**
 * Executing an entity CRUD tool: argument checks, the write guards that
 * exist only on this transport, and the delegation to the shared CRUD core.
 *
 * Split out of generated-mcp-server.ts.
 */
import {
  assertDeclaredProperties,
  assertOperationWrittenFields,
  assertPublishableWrite,
  assertWritableValues,
  requireArguments,
  requireId,
} from "./entity-tool-guards.js";
import { OperationFailure } from "@openshapeforge/operations";
import type { Tool } from "@modelcontextprotocol/server";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import {
  entityOperationContract,
  executeEntityOperation,
  requireCreateOperationConfirmation,
} from "../operations/entity/index.js";
import { assertEntityValuesValid } from "../operations/entity/input-validation.js";
import { pluginEntityTransportInput } from "../operations/entity/transport-input.js";
import { HttpError } from "../rest/http-error.js";
import { guardModelTypedValueArguments, withGuardedModelTypedValueWrite } from "./typed-value-write-guard.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { sessionOperationRoleGroupsAllow, sessionOperationRolesAllow } from "../operations/session-authorization.js";
import {
  type Catalog,
  type CatalogEntity,
  type CatalogTool,
  type GeneratedTable,
  type McpOperation,
} from "./catalog.js";
import { entityMutationControls, serializeRowForEntity } from "./catalog-rows.js";
import { ok, type ToolResult } from "./tool-results.js";
import { partial } from "./composed-results.js";


export async function invokeTool(
  tool: CatalogTool,
  entity: CatalogEntity | undefined,
  table: GeneratedTable,
  tables: Map<string, GeneratedTable>,
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  rawArgs: unknown,
  elicitationCompleted = false,
): Promise<ToolResult> {
  const args = requireArguments(rawArgs);
  const operationRef = (intent: McpOperation) => ({ id: tool.operationId, intent });
  const offerIntents = (Object.entries(table.source?.mcp?.operations ?? {}) as Array<[
    McpOperation,
    boolean,
  ]>)
    .filter(([, enabled]) => enabled)
    .map(([intent]) => intent);

  switch (tool.operation) {
    case "list": {
      const filter =
        args.filter &&
        typeof args.filter === "object" &&
        !Array.isArray(args.filter)
          ? (args.filter as Record<string, unknown>)
          : undefined;
      const sort =
        args.sortField || args.sortDirection
          ? {
              field: typeof args.sortField === "string" ? args.sortField : null,
              direction:
                typeof args.sortDirection === "string"
                  ? args.sortDirection
                  : null,
            }
          : undefined;
      // Like REST, the MCP list result always publishes totalCount, so the
      // count pass is always requested (#17).
      const operationResult = await executeEntityOperation(db, session, {
        operation: operationRef("list"),
        offerIntents,
        input: {
          ...(typeof args.first === "number" ? { limit: args.first } : {}),
          ...(typeof args.after === "string" ? { cursor: args.after } : {}),
          ...(filter ? { filter } : {}),
          ...(sort ? { sort } : {}),
          includeTotalCount: true,
        },
      });
      if (operationResult.intent !== "list") throw new Error("Unexpected entity result.");
      if ("error" in operationResult) throw new OperationFailure(operationResult.error);
      const result = operationResult.data;
      return ok({
        data: {
          items: result.items.map((item) => ({
            data: serializeRowForEntity(entity, table, item.data),
            operations: item.operations,
          })),
          totalCount: result.totalCount,
          nextCursor: result.nextCursor,
        },
        operations: operationResult.operations,
      });
    }

    case "get": {
      const result = await executeEntityOperation(db, session, {
        operation: operationRef("get"),
        offerIntents,
        input: { id: requireId(args) },
      });
      if (result.intent !== "get") throw new Error("Unexpected entity result.");
      if ("error" in result) throw new OperationFailure(result.error);
      const row = result.data;
      if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found.");
      return ok({
        data: serializeRowForEntity(entity, table, row),
        operations: result.operations,
      });
    }

    case "create": {
      const operation = entityOperationContract(operationRef("create").id);
      if (operation.implementation?.type === "plugin") {
        const result = await executeEntityOperation(db, session, {
          operation: operationRef("create"), offerIntents,
          input: pluginEntityTransportInput(operation, args),
        });
        if (result.intent !== "create") throw new Error("Unexpected entity result.");
        if ("error" in result) throw new OperationFailure(result.error);
        if (!result.data) throw new Error("Create operation returned no record.");
        return ok({ data: serializeRowForEntity(entity, table, result.data), operations: result.operations });
      }
      // A create tool takes its fields flat, so the mutation controls are
      // taken out by name — the field bindings among them, which are
      // controls and not values (see entityMutationControls).
      const values = Object.fromEntries(
        Object.entries(requireArguments(args)).filter(
          ([key]) => !["confirmed", "blueprintId", "bindings", "unbind"].includes(key),
        ),
      );
      // The elicited target field is server-set (collected from the person at
      // the client before this ran), so it is exempt from the declared-schema
      // and writable checks that guard MODEL-supplied fields.
      const elicitField = entity?.elicitOnCreate?.into;
      const modelValues = elicitField
        ? Object.fromEntries(
            Object.entries(values).filter(([key]) => key !== elicitField),
          )
        : values;
      assertOperationWrittenFields(modelValues, table);
      assertDeclaredProperties(tool.inputSchema, modelValues, "field");
      assertWritableValues(modelValues, entity, table, session);
      await guardModelTypedValueArguments(db, session, table, modelValues);
      // The model's payload against the write contract BEFORE the
      // acknowledgement: an invalid create answers VALIDATION, never
      // CONFIRMATION_REQUIRED. The completed-elicitation write below does not
      // pass through executeEntityOperation, so this is its contract check.
      assertEntityValuesValid(operation, table, modelValues, {
        partial: typeof args.blueprintId === "string",
      });
      requireCreateOperationConfirmation(operation, {
        ...(typeof args.confirmed === "boolean"
          ? { confirmed: args.confirmed }
          : {}),
      });
      await assertPublishableWrite(db, session, tables, table, values);
      if (elicitationCompleted && elicitField) {
        if (args.blueprintId !== undefined) throw new HttpError(400, "BAD_USER_INPUT", "Secure completion does not accept a blueprint.");
        // The elicitation write does not pass through executeEntityOperation,
        // so it is not the path that resolves a binding. Refuse rather than
        // store a create whose bindings were never resolved.
        if (args.bindings !== undefined || args.unbind !== undefined) {
          throw new HttpError(400, "BAD_USER_INPUT",
            "A create that collects a value securely does not take field bindings; bind the field afterwards.");
        }
        const result = await completeEntitySecureInput(db, session, {
          operation: operationRef("create"), offerIntents,
          input: { values: modelValues, ...(typeof args.confirmed === "boolean" ? { confirmed: args.confirmed } : {}) },
        }, { into: elicitField, value: values[elicitField] });
        if (result.intent !== "create") throw new Error("Unexpected entity result.");
        if ("error" in result) throw new OperationFailure(result.error);
        if (!result.data) throw new Error("Secure create returned no record.");
        return ok({ data: serializeRowForEntity(entity, table, result.data), operations: result.operations });
      }

      const result = await executeEntityOperation(db, session, {
        operation: operationRef("create"),
        offerIntents,
        input: {
          values,
          ...(typeof args.blueprintId === "string" ? { blueprintId: args.blueprintId } : {}),
          ...(typeof args.confirmed === "boolean"
            ? { confirmed: args.confirmed }
            : {}),
          ...(args.bindings !== undefined ? { bindings: args.bindings } : {}),
          ...(args.unbind !== undefined ? { unbind: args.unbind } : {}),
        },
      });
      if (result.intent !== "create") throw new Error("Unexpected entity result.");
      if ("error" in result) throw new OperationFailure(result.error);
      if (!result.data) throw new Error("Create operation returned no record.");
      return ok({
        data: serializeRowForEntity(entity, table, result.data),
        operations: result.operations,
      });
    }

    case "update": {
      const operation = entityOperationContract(operationRef("update").id);
      if (operation.implementation?.type === "plugin") {
        const result = await executeEntityOperation(db, session, {
          operation: operationRef("update"), offerIntents,
          input: pluginEntityTransportInput(operation, args),
        });
        if (result.intent !== "update") throw new Error("Unexpected entity result.");
        if ("error" in result) throw new OperationFailure(result.error);
        if (!result.data) throw new HttpError(404, "NOT_FOUND", "Resource not found.");
        return ok({ data: serializeRowForEntity(entity, table, result.data), operations: result.operations });
      }
      const id = requireId(args);
      assertDeclaredProperties(tool.inputSchema, args, "argument");
      const values = requireArguments(args.values);
      assertDeclaredProperties(
        (
          tool.inputSchema.properties as
            | Record<string, Record<string, unknown>>
            | undefined
        )?.values,
        values,
        "field",
      );
      assertOperationWrittenFields(values, table);
      assertWritableValues(values, entity, table, session);
      const result = await withGuardedModelTypedValueWrite(db, session, table, values, id, async () => {
        await assertPublishableWrite(db, session, tables, table, values, id);
        return executeEntityOperation(db, session, {
        operation: operationRef("update"),
        offerIntents,
        input: {
          id,
          values,
          ...entityMutationControls(args),
        },
        });
      });
      if (result.intent !== "update") throw new Error("Unexpected entity result.");
      if ("error" in result) throw new OperationFailure(result.error);
      const row = result.data;
      if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found.");
      return ok({
        data: serializeRowForEntity(entity, table, row),
        operations: result.operations,
      });
    }

    case "delete": {
      const id = requireId(args);
      const result = await executeEntityOperation(db, session, {
        operation: operationRef("delete"),
        offerIntents,
        input: {
          id,
          ...entityMutationControls(args),
        },
      });
      if (result.intent !== "delete") throw new Error("Unexpected entity result.");
      if ("error" in result) throw new OperationFailure(result.error);
      const deleted = result.data.deleted;
      if (!deleted)
        throw new HttpError(404, "NOT_FOUND", "Resource not found.");
      return ok({ data: result.data, operations: result.operations });
    }
  }
}

export function operationMayInvoke(
  tool: Catalog["operationTools"][number],
  session: TrustedSessionContext,
): boolean {
  if (tool.auth.mode === "public") return true;
  // The platform's own administration is served by `/admin/mcp` on a
  // control-realm session; a tenant session never sees it, whatever its
  // roles are called, so the tenant surface cannot even name it.
  if (tool.auth.mode === "control" || session.credential === "control-bearer") return false;
  // A capability Operation is authenticated by its grant token on REST only
  // (the compiler refuses its MCP projection), so a grant session has
  // nothing to invoke here.
  if (session.credential === "grant") return false;
  if (session.credential === "api-key" && (tool.auth.scopes ?? []).length > 0)
    return false;
  const scopes = new Set(session.oauthScopes ?? []);
  return (
    (authorizationProfileDecision(session, tool.key, inventory.rows.find(operation => operation.id === tool.key)?.entity) ?? sessionOperationRolesAllow(tool.auth.roles, session.roles)) &&
    sessionOperationRoleGroupsAllow(tool.auth.roleGroups, session.roles) &&
    (tool.auth.scopes ?? []).every((scope) => scopes.has(scope))
  );
}

export function projectCatalogOperationTool(
  tool: Catalog["operationTools"][number],
): Tool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    outputSchema: tool.outputSchema as Tool["outputSchema"],
    annotations: { title: tool.title, ...tool.annotations },
  };
}

export const __operationMayInvokeForTests = operationMayInvoke;
