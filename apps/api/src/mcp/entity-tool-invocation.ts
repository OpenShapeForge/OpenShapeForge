// SPDX-License-Identifier: BUSL-1.1
/**
 * Executing an entity CRUD tool: argument checks, the write guards that
 * exist only on this transport, and the delegation to the shared CRUD core.
 *
 * Split out of generated-mcp-server.ts.
 */
import { OperationFailure } from "@openshapeforge/operations";
import { type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import {
  isOperationWrittenColumn,
  operationWrittenRefusal,
  createGeneratedEntityAfterElicitation,
  entityOperationRef,
  entityOperationContract,
  executeEntityOperation,
  currentRecordOffers,
  getGeneratedEntity,
  requireCreateOperationConfirmation,
} from "../operations/entity/index.js";
import { assertEntityValuesValid } from "../operations/entity/input-validation.js";
import { pluginEntityTransportInput } from "../operations/entity/transport-input.js";
import { validateVisibleDefinition } from "./publication-validation.js";
import { canReadClassifiedColumns } from "../graphql/generated-authz.js";
import { HttpError } from "../rest/http-error.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { sessionOperationRoleGroupsAllow, sessionOperationRolesAllow } from "../operations/session-authorization.js";
import {
  catalog,
  catalogDerivedTools,
  catalogDiscoveryTools,
  catalogGuideTools,
  catalogTestTools,
  entityForTable,
  entityMutationControls,
  fieldNameForColumn,
  serializeRow,
  serializeRowForEntity,
  type Catalog,
  type CatalogEntity,
  type CatalogTool,
  type GeneratedTable,
  type McpOperation,
} from "./catalog.js";
import { runtimeRowsByFilter } from "./session-connections.js";
import { ok, partial, type ToolResult } from "./tool-results.js";

export function requireArguments(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new HttpError(
      400,
      "BAD_USER_INPUT",
      "Tool arguments must be an object.",
    );
  }
  return args as Record<string, unknown>;
}

/**
 * Reject arguments the tool's own schema does not declare.
 *
 * The CRUD layer already drops non-writable keys, so this is not a privilege
 * check — it is honesty. Every tool schema carries
 * `additionalProperties: false`, and accepting additional properties anyway
 * makes the catalog lie to the one consumer that reads it: a model that sets
 * `id` believes it created that id, gets a different one, and builds its next
 * step on a false premise. A typo'd field name looks like a successful write of
 * a value that was never stored. REST refuses the same body for the same
 * reason (`assertWritableBody`).
 *
 * Validated against the ADVERTISED schema rather than a second list, so the
 * check and the advertisement cannot drift apart.
 */
export function assertDeclaredProperties(
  schema: Record<string, unknown> | undefined,
  values: Record<string, unknown>,
  what: string,
): void {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object") return;
  const declared = new Set(Object.keys(properties as Record<string, unknown>));
  const unknown = Object.keys(values).filter((key) => !declared.has(key));
  if (unknown.length > 0) {
    throw new HttpError(
      400,
      "BAD_USER_INPUT",
      `Unknown or non-writable ${what}: ${unknown.sort().join(", ")}. ` +
        `Accepted: ${[...declared].sort().join(", ") || "(none)"}.`,
    );
  }
}

/**
 * A field authored `writtenBy: [...]` is absent from the tool schema, so
 * assertDeclaredProperties below would already refuse it — as "unknown or
 * non-writable", which sends a model looking for a spelling mistake. Run this
 * first so it hears the actual reason and the operation to call instead. The
 * generated CRUD layer refuses it a second time; that is the backstop for any
 * path that does not come through here.
 */
export function assertOperationWrittenFields(
  values: Record<string, unknown>,
  table: GeneratedTable | undefined,
): void {
  for (const column of table?.columns ?? []) {
    if (!isOperationWrittenColumn(column)) continue;
    const field = fieldNameForColumn(column);
    if (!Object.prototype.hasOwnProperty.call(values, field)) continue;
    throw new HttpError(
      400,
      "BAD_USER_INPUT",
      operationWrittenRefusal(field, column.writtenBy!),
    );
  }
}

export function requireId(args: Record<string, unknown>): string {
  const id = args.id;
  if (typeof id !== "string" || id === "") {
    throw new HttpError(
      400,
      "BAD_USER_INPUT",
      "Tool argument `id` is required.",
    );
  }
  return id;
}

/**
 * Reject writes to fields the caller cannot read back. Accepting one would let
 * a read-only caller set a classified value and confirm it through a filter —
 * and would silently succeed at writing data the response then redacts.
 */
export function assertWritableValues(
  values: Record<string, unknown>,
  entity: CatalogEntity | undefined,
  table: GeneratedTable | undefined,
  session: DbSessionInput,
): void {
  if (!entity || entity.classifiedFields.length === 0) return;
  if (canReadClassifiedColumns(table?.source?.authorization, session)) return;
  const offending = Object.keys(values).find((key) =>
    entity.classifiedFields.includes(key),
  );
  if (offending) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      `Not authorized to write classified field "${offending}" on ${entity.entity}.`,
    );
  }
}

/**
 * Guard a create/update that would make a derived-tool definition VISIBLE
 * (`visibleWhen` satisfied on the resulting row): the execution chain and its
 * connections are validated first, so the audience never receives a tool
 * whose first call is a guaranteed misconfiguration failure. Writes that
 * leave the row invisible — drafts, and un-publishing — pass untouched.
 */
export async function assertPublishableWrite(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
  table: GeneratedTable,
  values: Record<string, unknown>,
  rowId?: string,
): Promise<void> {
  const entry = catalogDerivedTools.find(
    (candidate) =>
      candidate.table === table.name &&
      candidate.visibleWhen &&
      candidate.execution,
  );
  if (!entry) return;
  const gate = entry.visibleWhen!;

  let resulting = values;
  if (rowId !== undefined) {
    const current = await getGeneratedEntity(db, session, {
      table: table.name,
      id: rowId,
    });
    if (!current) return; // the update itself will answer NOT_FOUND
    resulting = { ...serializeRow(table, current), ...values };
  }
  if (resulting[gate.field] !== gate.equals) return;

  // Static surface a derived name may never shadow: every advertised
  // non-derived tool name, whichever feature contributed it.
  const reservedNames = new Set<string>([
    ...catalog.tools.map((tool) => tool.name),
    ...catalogDerivedTools.flatMap((candidate) => [
      ...(candidate.connect ? [candidate.connect.name] : []),
      ...(candidate.dryRun ? [candidate.dryRun.name] : []),
      ...(candidate.personalization
        ? [candidate.personalization.set.name]
        : []),
    ]),
    ...catalogGuideTools.map((tool) => tool.name),
    ...catalogDiscoveryTools.map((tool) => tool.name),
    ...catalogTestTools.map((tool) => tool.name),
  ]);
  await validateVisibleDefinition({
    entry,
    row: resulting,
    rowId,
    reservedNames,
    providerDefinitionsField: entityForTable(entry.execution!.connectionTable)
      ?.elicitOnCreate?.definitionsField,
    readRows: (rowTable, filter) =>
      runtimeRowsByFilter(db, session, tables, rowTable, filter),
  });
}

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
