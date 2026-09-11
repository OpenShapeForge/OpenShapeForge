// SPDX-License-Identifier: BUSL-1.1
/**
 * Generated REST routes — the REST counterpart of generated-entity-schema.ts.
 *
 * Manifest-driven: every generated-CRUD table whose entity opted in via the
 * authoring `rest:` block (source.rest in manifest.json) gets Fastify routes
 * under /api/rest/v1/{basePath}. Handlers reuse the exact same building
 * blocks as the GraphQL resolvers:
 *   - resolveSessionContext() for bearer/trusted-context authentication,
 *   - the generated CRUD service layer (get/list/create/update/delete),
 *     which applies tenant scoping and RLS via withDbSession(),
 *   - canonical Operation failures, translated to HTTP by toHttpError().
 *
 * Rows come back from the CRUD layer as to_jsonb() objects keyed by
 * snake_case column names; responses are serialized through the same
 * sourceField/camelCase mapping the GraphQL object resolvers use, so both
 * APIs present identical field names.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { OperationFailure } from "@openshapeforge/operations";
import openApiSpec from "../generated/rest/openapi.json" with { type: "json" };
import { resolveSessionContext } from "../auth/identity.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import {
  entityOperationRef,
  executeEntityOperation,
  fieldNameForColumn,
  getGeneratedCrudTables,
  isCallerWritableColumn,
  isOperationWrittenColumn,
  operationWrittenRefusal,
} from "../operations/entity/index.js";
import { headersFromFastify } from "../http/headers.js";
import { HttpError, toHttpError } from "./http-error.js";
import { serializeGeneratedRestRow } from "./serialize-generated-row.js";

import { registerRestDocs } from "./rest-docs.js";
// Re-exported so existing import sites keep working.
export { REST_MOUNT_PATH, REST_OPENAPI_PATH } from "./rest-paths.js";
import { REST_MOUNT_PATH, REST_OPENAPI_PATH } from "./rest-paths.js";

type GeneratedTable = ReturnType<typeof getGeneratedCrudTables>[number];
type GeneratedColumn = GeneratedTable["columns"][number];
type RestMetadata = NonNullable<NonNullable<GeneratedTable["source"]>["rest"]>;

function usesCanonicalResultEnvelope(table: GeneratedTable): boolean {
  return table.source?.authoringVersion === 2;
}

function legacyFailureBody(body: Record<string, unknown>): Record<string, unknown> {
  const error = body.error as Record<string, unknown> | undefined;
  if (!error) return body;
  const data = error.data as Record<string, unknown> | undefined;
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(typeof error.detail === "string" ? { detail: error.detail } : {}),
      ...(typeof data?.hint === "string" ? { hint: data.hint } : {}),
    },
  };
}

const RESERVED_LIST_PARAMS = new Set([
  "first",
  "after",
  "sortField",
  "sortDirection",
]);

/**
 * REST bodies are stricter than GraphQL parity: unknown keys are rejected
 * with 400 instead of being silently dropped by normalizeWritableValues —
 * a typo'd field name in a JSON body would otherwise appear to succeed.
 *
 * The writable set comes from the CRUD layer's caller predicate rather than a
 * local copy, so REST preserves immutable-field asymmetry and never accepts
 * the secure elicitation target.
 */
function assertWritableBody(
  table: GeneratedTable,
  body: unknown,
  operation: "create" | "update",
): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "BAD_USER_INPUT", "Request body must be a JSON object.");
  }
  const writable = new Set(
    table.columns
      .filter((column) => isCallerWritableColumn(table, column, operation))
      .map(fieldNameForColumn),
  );
  // A field written only by an operation gets its own message: "unknown field"
  // would send the caller looking for a typo, when the field exists and the
  // answer is to call the operation that guards it.
  const operationWritten = new Map(
    table.columns
      .filter(isOperationWrittenColumn)
      .map((column) => [fieldNameForColumn(column), column.writtenBy!] as const),
  );
  for (const key of Object.keys(body)) {
    if (!writable.has(key)) {
      const writers = operationWritten.get(key);
      throw new HttpError(
        400,
        "BAD_USER_INPUT",
        writers
          ? operationWrittenRefusal(key, writers)
          : `Unknown or read-only field "${key}" in request body.`,
      );
    }
  }
  return body as Record<string, unknown>;
}

/**
 * Query-parameter values arrive as strings; coerce them to the column's
 * scalar type before they reach the CRUD filter layer so `?isActive=true`
 * and `?position=2` behave like their typed GraphQL filter equivalents.
 */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = match ? new Date(`${value}T00:00:00.000Z`) : undefined;
  return Boolean(
    match && parsed &&
    parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() + 1 === Number(match[2]) &&
    parsed.getUTCDate() === Number(match[3]),
  );
}

function coerceFilterValue(column: GeneratedColumn, raw: string): unknown {
  switch (column.type) {
    case "uuid": {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
        return raw;
      }
      throw new HttpError(
        400,
        "BAD_USER_INPUT",
        `Filter field ${fieldNameForColumn(column)} expects a UUID.`,
      );
    }
    case "date": {
      if (isCalendarDate(raw)) {
        return raw;
      }
      throw new HttpError(
        400,
        "BAD_USER_INPUT",
        `Filter field ${fieldNameForColumn(column)} expects a date in YYYY-MM-DD format.`,
      );
    }
    case "timestamptz": {
      const rfc3339 = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
      const match = rfc3339.exec(raw);
      if (
        match &&
        isCalendarDate(match[1]!) &&
        Number(match[2]) <= 23 &&
        Number(match[3]) <= 59 &&
        Number(match[4]) <= 59 &&
        Number(match[5] ?? 0) <= 23 &&
        Number(match[6] ?? 0) <= 59 &&
        Number.isFinite(Date.parse(raw))
      ) {
        return raw;
      }
      throw new HttpError(
        400,
        "BAD_USER_INPUT",
        `Filter field ${fieldNameForColumn(column)} expects an RFC 3339 date-time.`,
      );
    }
    case "boolean": {
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new HttpError(
        400,
        "BAD_USER_INPUT",
        `Filter field ${fieldNameForColumn(column)} expects "true" or "false".`,
      );
    }
    case "integer":
    case "bigint": {
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || String(parsed) !== raw.trim()) {
        throw new HttpError(
          400,
          "BAD_USER_INPUT",
          `Filter field ${fieldNameForColumn(column)} expects an integer.`,
        );
      }
      return parsed;
    }
    case "numeric": {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        throw new HttpError(
          400,
          "BAD_USER_INPUT",
          `Filter field ${fieldNameForColumn(column)} expects a number.`,
        );
      }
      return parsed;
    }
    default:
      return raw;
  }
}

function buildListInput(table: GeneratedTable, query: Record<string, unknown>) {
  const columnsByField = new Map(
    table.columns.map((column) => [fieldNameForColumn(column), column]),
  );
  const filter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (RESERVED_LIST_PARAMS.has(key) || value === undefined) {
      continue;
    }
    // A param named `<field>In` (where <field> is a real entity field and
    // `<field>In` itself is not one) is an explicit IN filter — the same
    // convention the GraphQL filter inputs expose. Without this, a single
    // `?statusIn=x` would reach the CRUD layer as a scalar and be silently
    // dropped, and a repeated one would double-suffix into `statusInIn`.
    const directColumn = columnsByField.get(key);
    const stemColumn =
      !directColumn && key.endsWith("In")
        ? columnsByField.get(key.slice(0, -2))
        : undefined;
    const column = directColumn ?? stemColumn;
    const values = Array.isArray(value) ? value : [value];
    const coerced = values.map((item) =>
      column ? coerceFilterValue(column, String(item)) : String(item),
    );
    // Unknown fields pass through verbatim so buildFilterConditions rejects
    // them with the same BAD_USER_INPUT error GraphQL callers get.
    if (stemColumn) {
      filter[key] = coerced;
    } else if (coerced.length > 1) {
      // Repeated plain parameters use the CRUD layer's `<field>In` convention.
      filter[`${key}In`] = coerced;
    } else {
      filter[key] = coerced[0];
    }
  }

  const first = query.first === undefined ? undefined : Number(query.first);
  if (first !== undefined && !Number.isInteger(first)) {
    throw new HttpError(400, "BAD_USER_INPUT", "Query parameter first expects an integer.");
  }
  const sortField = typeof query.sortField === "string" ? query.sortField : undefined;
  const sortDirection =
    typeof query.sortDirection === "string" ? query.sortDirection : undefined;

  return {
    ...(first === undefined ? {} : { limit: first }),
    ...(typeof query.after === "string" ? { cursor: query.after } : {}),
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
    ...(sortField || sortDirection
      ? { sort: { field: sortField ?? null, direction: sortDirection ?? null } }
      : {}),
  };
}

type RestRequestContext = {
  db: OpenShapeForgeDatabase;
  session: DbSessionInput;
};

export function registerGeneratedRestRoutes(
  app: FastifyInstance,
  options: { db?: OpenShapeForgeDatabase | undefined } = {},
): void {
  const restTables = getGeneratedCrudTables().filter(
    (table): table is GeneratedTable & { source: { rest: RestMetadata } } =>
      table.source?.rest !== undefined,
  );

  // The generated spec is a build artifact of the same manifest that drives
  // these routes; serve it unauthenticated like the health endpoints.
  app.get(REST_OPENAPI_PATH, async () => openApiSpec);

  registerRestDocs(app, openApiSpec);

  if (restTables.length === 0) {
    return;
  }

  // Mirrors requireGeneratedDb() in generated-entity-schema.ts.
  async function requireRestContext(request: FastifyRequest): Promise<RestRequestContext> {
    const resolved = await resolveSessionContext(headersFromFastify(request.headers), { db: options.db });
    if (!resolved.tenantId || !resolved.userId) {
      throw new HttpError(
        401,
        "UNAUTHENTICATED",
        "Generated entity access requires an authenticated session.",
      );
    }
    if (!options.db) {
      throw new HttpError(
        503,
        "DATABASE_NOT_CONFIGURED",
        "Database is not configured for generated entity access.",
      );
    }
    return {
      db: options.db,
      session: {
        tenantId: resolved.tenantId,
        userId: resolved.userId,
        roles: [...resolved.roles],
        groups: [...resolved.groups],
        scope: resolved.scope,
      },
    };
  }

  // Encapsulated plugin scope: createApiApp() replaces the global JSON parser
  // with a raw-buffer passthrough for GraphQL Yoga, so REST routes install
  // their own strict JSON parser and error shape without affecting the rest
  // of the app.
  void app.register(async (instance) => {
    instance.removeContentTypeParser("application/json");
    instance.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, body, done) => {
        if (body === "" || body === undefined) {
          done(null, undefined);
          return;
        }
        try {
          done(null, JSON.parse(body as string));
        } catch {
          done(new HttpError(400, "BAD_USER_INPUT", "Request body is not valid JSON."), undefined);
        }
      },
    );

    instance.setErrorHandler((error, request, reply) => {
      const { status, body: canonicalBody } = toHttpError(error);
      const pathname = request.url.split("?", 1)[0] ?? request.url;
      const table = restTables.find((candidate) => {
        const base = `${REST_MOUNT_PATH}/${candidate.source.rest.basePath}`;
        return pathname === base || pathname.startsWith(`${base}/`);
      });
      const body = table && !usesCanonicalResultEnvelope(table)
        ? legacyFailureBody(canonicalBody as unknown as Record<string, unknown>)
        : canonicalBody;
      if (status >= 500) {
        instance.log.error({ err: error }, "Generated REST route failed.");
      }
      void reply.status(status).send(body);
    });

    for (const table of restTables) {
      const rest = table.source.rest;
      const base = `${REST_MOUNT_PATH}/${rest.basePath}`;
      const canonical = usesCanonicalResultEnvelope(table);
      const offerIntents = (Object.entries(rest.operations) as Array<[
        "list" | "get" | "create" | "update" | "delete",
        boolean,
      ]>)
        .filter(([, enabled]) => enabled)
        .map(([intent]) => intent);

      if (rest.operations.list) {
        instance.get(base, async (request, reply) => {
          const context = await requireRestContext(request);
          const query = (request.query ?? {}) as Record<string, unknown>;
          // The REST list body always carries totalCount, so REST always pays
          // for the count pass — unlike GraphQL, where the client selects it
          // (#17). A REST opt-out would be a query-parameter contract change.
          const operationResult = await executeEntityOperation(context.db, context.session, {
            operation: entityOperationRef(table, "list"),
            offerIntents,
            input: {
              ...buildListInput(table, query),
              includeTotalCount: true,
            },
          });
          if (operationResult.intent !== "list") throw new Error("Unexpected entity result.");
          if ("error" in operationResult) throw new OperationFailure(operationResult.error);
          const result = operationResult.data;
          if (!canonical) {
            return reply.send({
              items: result.items.map((item) =>
                serializeGeneratedRestRow(table, item.data),
              ),
              totalCount: result.totalCount,
              nextCursor: result.nextCursor,
            });
          }
          return reply.send({
            data: {
              items: result.items.map((item) => ({
                data: serializeGeneratedRestRow(table, item.data),
                operations: item.operations,
              })),
              totalCount: result.totalCount,
              nextCursor: result.nextCursor,
            },
            operations: operationResult.operations,
          });
        });
      }

      if (rest.operations.get) {
        instance.get(`${base}/:id`, async (request, reply) => {
          const context = await requireRestContext(request);
          const { id } = request.params as { id: string };
          const result = await executeEntityOperation(context.db, context.session, {
            operation: entityOperationRef(table, "get"),
            offerIntents,
            input: { id },
          });
          if (result.intent !== "get") throw new Error("Unexpected entity result.");
          if ("error" in result) throw new OperationFailure(result.error);
          const row = result.data;
          if (!row) {
            throw new HttpError(404, "NOT_FOUND", "Resource not found.");
          }
          if (!canonical) return reply.send(serializeGeneratedRestRow(table, row));
          return reply.send({
            data: serializeGeneratedRestRow(table, row),
            operations: result.operations,
          });
        });
      }

      if (rest.operations.create) {
        instance.post(base, async (request, reply) => {
          const context = await requireRestContext(request);
          const values = assertWritableBody(table, request.body ?? {}, "create");
          const result = await executeEntityOperation(context.db, context.session, {
            operation: entityOperationRef(table, "create"),
            offerIntents,
            input: { values },
          });
          if (result.intent !== "create") throw new Error("Unexpected entity result.");
          if ("error" in result) throw new OperationFailure(result.error);
          const row = result.data;
          if (!row) throw new Error("Create operation returned no record.");
          if (!canonical) {
            return reply.status(201).send(serializeGeneratedRestRow(table, row));
          }
          return reply.status(201).send({
            data: serializeGeneratedRestRow(table, row),
            operations: result.operations,
          });
        });
      }

      if (rest.operations.update) {
        instance.patch(`${base}/:id`, async (request, reply) => {
          const context = await requireRestContext(request);
          const { id } = request.params as { id: string };
          const values = assertWritableBody(table, request.body ?? {}, "update");
          const result = await executeEntityOperation(context.db, context.session, {
            operation: entityOperationRef(table, "update"),
            offerIntents,
            input: { id, values },
          });
          if (result.intent !== "update") throw new Error("Unexpected entity result.");
          if ("error" in result) throw new OperationFailure(result.error);
          const row = result.data;
          if (!row) {
            throw new HttpError(404, "NOT_FOUND", "Resource not found.");
          }
          if (!canonical) return reply.send(serializeGeneratedRestRow(table, row));
          return reply.send({
            data: serializeGeneratedRestRow(table, row),
            operations: result.operations,
          });
        });
      }

      if (rest.operations.delete) {
        instance.delete(`${base}/:id`, async (request, reply) => {
          const context = await requireRestContext(request);
          const { id } = request.params as { id: string };
          const result = await executeEntityOperation(context.db, context.session, {
            operation: entityOperationRef(table, "delete"),
            offerIntents,
            input: { id },
          });
          if (result.intent !== "delete") throw new Error("Unexpected entity result.");
          if ("error" in result) throw new OperationFailure(result.error);
          const deleted = result.data.deleted;
          if (!deleted) {
            throw new HttpError(404, "NOT_FOUND", "Resource not found.");
          }
          if (!canonical) return reply.status(204).send();
          return reply.send({ data: result.data, operations: result.operations });
        });
      }
    }
  });
}
