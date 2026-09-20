// SPDX-License-Identifier: BUSL-1.1
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
import { type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import {
  createGeneratedEntityAfterElicitation,
  entityOperationRef,
  entityOperationContract,
  executeEntityOperation,
  currentRecordOffers,
  requireCreateOperationConfirmation,
} from "../operations/entity/index.js";
import { assertEntityValuesValid } from "../operations/entity/input-validation.js";
import { pluginEntityTransportInput } from "../operations/entity/transport-input.js";
import { HttpError } from "../rest/http-error.js";
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
  const canonical = tool.outputSchema !== undefined;
  const operationRef = (intent: McpOperation) =>
    tool.operationId
      ? { id: tool.operationId, intent }
      : entityOperationRef(table, intent);
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
      if (!canonical) {
        return ok({
          items: result.items.map((item) =>
            serializeRowForEntity(entity, table, item.data),
          ),
          totalCount: result.totalCount,
          nextCursor: result.nextCursor,
        });
      }
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
      if (!canonical) return ok(serializeRowForEntity(entity, table, row));
      return ok({
        data: serializeRowForEntity(entity, table, row),
        operations: result.operations,
      });
    }

    case "create": {
      const operation = entityOperationContract(operationRef("create").id);
      if (canonical && operation.implementation?.type === "plugin") {
        const result = await executeEntityOperation(db, session, {
          operation: operationRef("create"), offerIntents,
          input: pluginEntityTransportInput(operation, args),
        });
        if (result.intent !== "create") throw new Error("Unexpected entity result.");
        if ("error" in result) throw new OperationFailure(result.error);
        if (!result.data) throw new Error("Create operation returned no record.");
        return ok({ data: serializeRowForEntity(entity, table, result.data), operations: result.operations });
      }
      const values = canonical
        ? Object.fromEntries(
            Object.entries(requireArguments(args)).filter(
              ([key]) => key !== "confirmed" && key !== "blueprintId",
            ),
          )
        : requireArguments(args);
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
      // The model's payload against the write contract BEFORE the
      // acknowledgement: an invalid create answers VALIDATION, never
      // CONFIRMATION_REQUIRED. The completed-elicitation write below does not
      // pass through executeEntityOperation, so this is its contract check.
      assertEntityValuesValid(operation, table, modelValues, {
        partial: typeof args.blueprintId === "string",
      });
      if (canonical) {
        requireCreateOperationConfirmation(operation, {
          ...(typeof args.confirmed === "boolean"
            ? { confirmed: args.confirmed }
            : {}),
        });
      }
      await assertPublishableWrite(db, session, tables, table, values);
      if (elicitationCompleted && elicitField) {
        const row = await createGeneratedEntityAfterElicitation(db, session, {
              table: table.name,
              values,
              into: elicitField,
            });
        const data = serializeRowForEntity(entity, table, row);
        if (!canonical) return ok(data);
        return ok({
          data,
          operations: await currentRecordOffers(
            db,
            session,
            entity?.entity ?? table.source?.authoringEntityName ?? table.name,
            table,
            {
              id: String(data.id ?? ""),
              row,
              ...(typeof data.updatedAt === "string"
                ? { version: data.updatedAt }
                : {}),
            },
            ["get", "update", "delete"].filter((intent) =>
              offerIntents.includes(intent as McpOperation),
            ) as McpOperation[],
          ),
        });
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
        },
      });
      if (result.intent !== "create") throw new Error("Unexpected entity result.");
      if ("error" in result) throw new OperationFailure(result.error);
      if (!result.data) throw new Error("Create operation returned no record.");
      if (!canonical) {
        return ok(serializeRowForEntity(entity, table, result.data));
      }
      return ok({
        data: serializeRowForEntity(entity, table, result.data),
        operations: result.operations,
      });
    }

    case "update": {
      const operation = entityOperationContract(operationRef("update").id);
      if (canonical && operation.implementation?.type === "plugin") {
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
      await assertPublishableWrite(db, session, tables, table, values, id);
      const result = await executeEntityOperation(db, session, {
        operation: operationRef("update"),
        offerIntents,
        input: {
          id,
          values,
          ...entityMutationControls(args),
        },
      });
      if (result.intent !== "update") throw new Error("Unexpected entity result.");
      if ("error" in result) throw new OperationFailure(result.error);
      const row = result.data;
      if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found.");
      if (!canonical) return ok(serializeRowForEntity(entity, table, row));
      return ok({
        data: serializeRowForEntity(entity, table, row),
        operations: result.operations,
      });
    }

    case "delete": {
      const result = await executeEntityOperation(db, session, {
        operation: operationRef("delete"),
        offerIntents,
        input: {
          id: requireId(args),
          ...entityMutationControls(args),
        },
      });
      if (result.intent !== "delete") throw new Error("Unexpected entity result.");
      if ("error" in result) throw new OperationFailure(result.error);
      const deleted = result.data.deleted;
      if (!deleted)
        throw new HttpError(404, "NOT_FOUND", "Resource not found.");
      if (!canonical) return ok({ deleted: true });
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
    sessionOperationRolesAllow(tool.auth.roles, session.roles) &&
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
