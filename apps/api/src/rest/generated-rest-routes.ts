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
 *   - the CRUD layer's GraphQLError vocabulary, translated to HTTP statuses
 *     by toHttpError().
 *
 * Rows come back from the CRUD layer as to_jsonb() objects keyed by
 * snake_case column names; responses are serialized through the same
 * sourceField/camelCase mapping the GraphQL object resolvers use, so both
 * APIs present identical field names.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import openApiSpec from "../generated/rest/openapi.json" with { type: "json" };
import { resolveSessionContext } from "../auth/identity.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import {
  createGeneratedEntity,
  deleteGeneratedEntity,
  getGeneratedEntity,
  getGeneratedCrudTables,
  listGeneratedEntities,
  updateGeneratedEntity,
} from "../graphql/generated-crud.js";
import { headersFromFastify } from "../http/headers.js";
import { HttpError, toHttpError } from "./http-error.js";

import { registerRestDocs } from "./rest-docs.js";
// Re-exported so existing import sites keep working.
export { REST_MOUNT_PATH, REST_OPENAPI_PATH } from "./rest-paths.js";
import { REST_MOUNT_PATH, REST_OPENAPI_PATH } from "./rest-paths.js";

type GeneratedTable = ReturnType<typeof getGeneratedCrudTables>[number];
type GeneratedColumn = GeneratedTable["columns"][number];
type RestMetadata = NonNullable<NonNullable<GeneratedTable["source"]>["rest"]>;

const RESERVED_LIST_PARAMS = new Set([
  "first",
  "after",
  "sortField",
  "sortDirection",
]);

function fieldNameForColumn(column: GeneratedColumn) {
  return column.sourceField ?? column.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

// Mirrors writableColumnMap in generated-crud.ts: server-managed columns are
// never accepted in request bodies.
function isWritableColumn(column: GeneratedColumn) {
  return (
    !column.primaryKey &&
    column.generated !== "identity" &&
    column.name !== "tenant_id" &&
    column.name !== "created_at" &&
    column.name !== "updated_at"
  );
}

function serializeRow(table: GeneratedTable, row: Record<string, unknown>) {
  return Object.fromEntries(
    table.columns.map((column) => [fieldNameForColumn(column), row[column.name]]),
  );
}

/**
 * REST bodies are stricter than GraphQL parity: unknown keys are rejected
 * with 400 instead of being silently dropped by normalizeWritableValues —
 * a typo'd field name in a JSON body would otherwise appear to succeed.
 */
function assertWritableBody(
  table: GeneratedTable,
  body: unknown,
): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "BAD_USER_INPUT", "Request body must be a JSON object.");
  }
  const writable = new Set(
    table.columns.filter(isWritableColumn).map(fieldNameForColumn),
  );
  for (const key of Object.keys(body)) {
    if (!writable.has(key)) {
      throw new HttpError(
        400,
        "BAD_USER_INPUT",
        `Unknown or read-only field "${key}" in request body.`,
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
function coerceFilterValue(column: GeneratedColumn, raw: string): unknown {
  switch (column.type) {
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

  registerRestDocs(app);

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

    instance.setErrorHandler((error, _request, reply) => {
      const { status, body } = toHttpError(error);
      if (status >= 500) {
        instance.log.error({ err: error }, "Generated REST route failed.");
      }
      void reply.status(status).send(body);
    });

    for (const table of restTables) {
      const rest = table.source.rest;
      const base = `${REST_MOUNT_PATH}/${rest.basePath}`;

      if (rest.operations.list) {
        instance.get(base, async (request, reply) => {
          const context = await requireRestContext(request);
          const query = (request.query ?? {}) as Record<string, unknown>;
          // The REST list body always carries totalCount, so REST always pays
          // for the count pass — unlike GraphQL, where the client selects it
          // (#17). A REST opt-out would be a query-parameter contract change.
          const result = await listGeneratedEntities(context.db, context.session, {
            table: table.name,
            ...buildListInput(table, query),
            includeTotalCount: true,
          });
          return reply.send({
            items: result.rows.map((row) => serializeRow(table, row)),
            totalCount: result.totalCount,
            nextCursor: result.nextCursor,
          });
        });
      }

      if (rest.operations.get) {
        instance.get(`${base}/:id`, async (request, reply) => {
          const context = await requireRestContext(request);
          const { id } = request.params as { id: string };
          const row = await getGeneratedEntity(context.db, context.session, {
            table: table.name,
            id,
          });
          if (!row) {
            throw new HttpError(404, "NOT_FOUND", "Resource not found.");
          }
          return reply.send(serializeRow(table, row));
        });
      }

      if (rest.operations.create) {
        instance.post(base, async (request, reply) => {
          const context = await requireRestContext(request);
          const values = assertWritableBody(table, request.body ?? {});
          const row = await createGeneratedEntity(context.db, context.session, {
            table: table.name,
            values,
          });
          return reply.status(201).send(serializeRow(table, row));
        });
      }

      if (rest.operations.update) {
        instance.patch(`${base}/:id`, async (request, reply) => {
          const context = await requireRestContext(request);
          const { id } = request.params as { id: string };
          const values = assertWritableBody(table, request.body ?? {});
          const row = await updateGeneratedEntity(context.db, context.session, {
            table: table.name,
            id,
            values,
          });
          if (!row) {
            throw new HttpError(404, "NOT_FOUND", "Resource not found.");
          }
          return reply.send(serializeRow(table, row));
        });
      }

      if (rest.operations.delete) {
        instance.delete(`${base}/:id`, async (request, reply) => {
          const context = await requireRestContext(request);
          const { id } = request.params as { id: string };
          const deleted = await deleteGeneratedEntity(context.db, context.session, {
            table: table.name,
            id,
          });
          if (!deleted) {
            throw new HttpError(404, "NOT_FOUND", "Resource not found.");
          }
          return reply.status(204).send();
        });
      }
    }
  });
}
