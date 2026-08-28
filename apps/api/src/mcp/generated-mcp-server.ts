// SPDX-License-Identifier: BUSL-1.1
/**
 * Generated MCP server — the third transport, beside GraphQL and REST.
 *
 * Catalog-driven: the compiler emits `generated/mcp/tools.json` from the
 * compiled entity contracts, carrying each tool's JSON Schema built from the
 * authored field definitions (labels, validation bounds, enumerations, AI
 * hints). This module is the hand-written engine that serves that catalog.
 *
 * Handlers reuse the exact same building blocks as the GraphQL resolvers and
 * the REST routes:
 *   - resolveSessionContext() for bearer/trusted-context authentication,
 *   - the generated CRUD service layer, which applies tenant scoping and RLS
 *     via withDbSession() and gates every operation on entity roles,
 *   - the CRUD layer's GraphQLError vocabulary, translated by toHttpError().
 *
 * Two things this transport does that the others do not, both because its
 * consumer is a language model reading schemas to decide what to do:
 *
 *   1. `tools/list` is resolved PER SESSION. A caller is shown only the tools
 *      whose entity roles it actually holds, so an agent never sees an
 *      operation it would be refused. requireEntityOperation() in the CRUD
 *      layer remains the enforcement; this is defence in depth and saves the
 *      model a wasted turn on a guaranteed 403.
 *   2. Classified fields are withheld from the schemas handed to a caller who
 *      may not read them, so the schema itself is not an enumeration oracle,
 *      and a write to such a field is refused rather than silently accepted
 *      and redacted back.
 *
 * Row redaction and the classified filter/sort guard are NOT applied here:
 * they live in the shared CRUD core (#164), which every call below goes
 * through, so this transport inherits them by construction.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import rawCatalog from "../generated/mcp/tools.json" with { type: "json" };
import { resolveSessionContext } from "../auth/identity.js";
import { buildAuthenticateChallenge } from "./protected-resource-metadata.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import {
  createGeneratedEntity,
  deleteGeneratedEntity,
  getGeneratedEntity,
  getGeneratedCrudTables,
  isGeneratedCrudOperationEnabled,
  listGeneratedEntities,
  updateGeneratedEntity,
} from "../graphql/generated-crud.js";
import { canReadClassifiedColumns } from "../graphql/generated-authz.js";
import { headersFromFastify } from "../http/headers.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import { listConnectorContracts } from "../connectors/catalog.js";
import {
  connectorToolsForSession,
  resolveConnectorTool,
} from "../connectors/mcp-tools.js";
import {
  connectorGovernor,
  connectorKeyring,
  connectorRegistry,
} from "../connectors/dispatch.js";
import { invokeConnectorOperation } from "../connectors/runtime.js";

export const MCP_MOUNT_PATH = "/api/mcp";

type GeneratedTable = ReturnType<typeof getGeneratedCrudTables>[number];

export type McpOperation = "list" | "get" | "create" | "update" | "delete";

type CatalogTool = {
  name: string;
  operation: McpOperation;
  entity: string;
  table: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
};

type CatalogEntity = {
  entity: string;
  slug: string;
  table: string;
  toolPrefix: string;
  title: string;
  description: string;
  domains: string[];
  displayTemplate?: string;
  filterField?: string;
  classifiedFields: string[];
  fields: CatalogField[];
  relationships: CatalogRelationship[];
};

type CatalogField = {
  key: string;
  label?: string;
  description?: string;
  valueType: string;
  cardinality: string;
  required: boolean;
  readOnly: boolean;
  immutable: boolean;
  schema: Record<string, unknown>;
  classification?: string;
  relationship?: { kind: string; entity: string };
};

type CatalogRelationship = {
  key: string;
  kind: string;
  target: string;
  foreignKey?: string;
  via?: string;
  label?: string;
};

/**
 * The JSON import widens every string literal, so the catalog is re-typed once
 * here. The compiler is the authority on this shape (generate-mcp.ts); a
 * mismatch surfaces as a runtime miss on a tool name, which the CallTool
 * handler already treats as unknown.
 */
type Catalog = {
  generatedBy: string;
  source: string;
  tools: CatalogTool[];
  entities: CatalogEntity[];
};
const catalog = rawCatalog as unknown as Catalog;

/** Which entity role an operation requires — mirrors the CRUD layer's gate. */
const OPERATION_ROLE = {
  list: "read",
  get: "read",
  create: "create",
  update: "update",
  delete: "delete",
} as const;

const SERVER_INFO = {
  name: "openshapeforge",
  version: "1",
} as const;

const INSTRUCTIONS =
  "Entity CRUD for an OpenShapeForge deployment. Every tool is scoped to the " +
  "caller's tenant and roles; results are row-level filtered by the database. " +
  "List tools return a page plus a nextCursor — pass it back as `after` to " +
  "continue. Prefer filtering over paging through large result sets.";

const ENTITY_CATALOG_URI = "osf://schema/entities";
const JSON_MIME_TYPE = "application/json";

function tablesByName(): Map<string, GeneratedTable> {
  return new Map(getGeneratedCrudTables().map((table) => [table.name, table]));
}

function fieldNameForColumn(column: GeneratedTable["columns"][number]) {
  return (
    column.sourceField ??
    column.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
  );
}

function serializeRow(table: GeneratedTable, row: Record<string, unknown>) {
  return Object.fromEntries(
    table.columns.map((column) => [fieldNameForColumn(column), row[column.name]]),
  );
}

/**
 * Whether the session holds a role permitting `operation` on this table.
 *
 * Read-only mirror of requireEntityOperation() used to decide what to
 * ADVERTISE. It deliberately never throws: a tool the caller cannot use is
 * omitted from the listing, not surfaced as an error.
 */
function sessionMayInvoke(
  table: GeneratedTable | undefined,
  operation: keyof typeof OPERATION_ROLE,
  session: DbSessionInput,
): boolean {
  if (!table || !isGeneratedCrudOperationEnabled(table, operation)) return false;
  const required = table?.source?.authorization?.roles?.[OPERATION_ROLE[operation]];
  if (!required || required.length === 0) return false;
  const granted = new Set(session.roles ?? []);
  return required.some((role) => granted.has(role));
}

/**
 * Strip classified entity fields from the root create schema and the two
 * wrappers that carry entity-field names (`filter` and `values`). Nested JSON
 * object children are a separate namespace and must not be matched against a
 * top-level classified field with the same name.
 */
function withholdClassified(
  schema: Record<string, unknown>,
  classifiedFields: readonly string[],
): Record<string, unknown> {
  if (classifiedFields.length === 0) return schema;
  const withheld = new Set(classifiedFields);

  const pruneObjectLevel = (node: Record<string, unknown>): Record<string, unknown> => {
    const properties = node.properties;
    const result = { ...node };
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      result.properties = Object.fromEntries(
        Object.entries(properties as Record<string, unknown>).filter(
          ([name]) => !withheld.has(name),
        ),
      );
    }
    if (Array.isArray(node.required)) {
      result.required = node.required.filter((name) => !withheld.has(name as string));
    }
    return result;
  };

  const root = pruneObjectLevel(schema);
  const properties = root.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return root;

  const projected = { ...(properties as Record<string, unknown>) };
  for (const wrapper of ["filter", "values"]) {
    const nested = projected[wrapper];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      projected[wrapper] = pruneObjectLevel(nested as Record<string, unknown>);
    }
  }
  root.properties = projected;
  return root;
}

function toolsForSession(
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
): { tool: CatalogTool; entity: CatalogEntity | undefined }[] {
  const entitiesByName = new Map(catalog.entities.map((entity) => [entity.entity, entity]));
  return catalog.tools
    .filter((tool) => sessionMayInvoke(tables.get(tool.table), tool.operation, session))
    .map((tool) => ({ tool, entity: entitiesByName.get(tool.entity) }));
}

function describeTool(
  tool: CatalogTool,
  entity: CatalogEntity | undefined,
  table: GeneratedTable | undefined,
  session: DbSessionInput,
) {
  const classified =
    entity && !canReadClassifiedColumns(table?.source?.authorization, session)
      ? entity.classifiedFields
      : [];
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: withholdClassified(
      tool.inputSchema as Record<string, unknown>,
      classified,
    ),
    annotations: {
      title: tool.title,
      ...tool.annotations,
    },
  };
}

type SessionEntity = {
  entity: CatalogEntity;
  tools: CatalogTool[];
};

function entityResourceUri(entity: CatalogEntity): string {
  return `${ENTITY_CATALOG_URI}/${encodeURIComponent(entity.slug)}`;
}

function entitiesForSession(
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
): SessionEntity[] {
  const toolsByEntity = new Map<string, CatalogTool[]>();
  for (const { tool } of toolsForSession(session, tables)) {
    const current = toolsByEntity.get(tool.entity) ?? [];
    current.push(tool);
    toolsByEntity.set(tool.entity, current);
  }
  return catalog.entities.flatMap((entity) => {
    const tools = toolsByEntity.get(entity.entity);
    return tools ? [{ entity, tools }] : [];
  });
}

function visibleFields(
  entity: CatalogEntity,
  table: GeneratedTable | undefined,
  session: DbSessionInput,
): CatalogField[] {
  if (canReadClassifiedColumns(table?.source?.authorization, session)) return entity.fields;
  const classified = new Set(entity.classifiedFields);
  return entity.fields.filter((field) => !classified.has(field.key));
}

function describeEntityResource(
  entry: SessionEntity,
  sessionEntities: SessionEntity[],
  tables: Map<string, GeneratedTable>,
  session: DbSessionInput,
) {
  const { entity, tools } = entry;
  const resourceByEntity = new Map(
    sessionEntities.map((candidate) => [
      candidate.entity.entity,
      entityResourceUri(candidate.entity),
    ]),
  );
  const fields = visibleFields(entity, tables.get(entity.table), session);
  const relationships = entity.relationships.filter((relationship) =>
    resourceByEntity.has(relationship.target),
  );
  // displayTemplate and filterField reference fields by name; publishing either
  // to a session whose visibleFields hides that name would hand the caller the
  // classified field's name and point it at a filter/sort its own tools refuse.
  const visible = new Set(fields.map((field) => field.key));
  const templateVisible =
    !entity.displayTemplate ||
    [...entity.displayTemplate.matchAll(/{{\s*([\w.]+)\s*}}/g)].every(([, key]) =>
      visible.has(key!.split(".")[0]!),
    );

  return {
    entity: entity.entity,
    slug: entity.slug,
    title: entity.title,
    description: entity.description,
    domains: entity.domains,
    ...(entity.displayTemplate && templateVisible
      ? { displayTemplate: entity.displayTemplate }
      : {}),
    ...(entity.filterField && visible.has(entity.filterField)
      ? { filterField: entity.filterField }
      : {}),
    // A relationship-bearing field stays readable as a scalar (the row contains
    // it and the write tools require it); only the relationship edge is gated
    // on target visibility — the same split GraphQL settled in
    // generated-entity-schema.ts.
    fields: fields.map((field) => {
      const { relationship, ...rest } = field;
      return {
        ...rest,
        ...(relationship && resourceByEntity.has(relationship.entity)
          ? {
              relationship: {
                ...relationship,
                resourceUri: resourceByEntity.get(relationship.entity),
              },
            }
          : {}),
      };
    }),
    relationships: relationships.map((relationship) => ({
      ...relationship,
      resourceUri: resourceByEntity.get(relationship.target),
    })),
    operations: tools.map((tool) => ({
      name: tool.name,
      operation: tool.operation,
      title: tool.title,
      description: tool.description,
      annotations: tool.annotations,
    })),
  };
}

function describeCatalogResource(entries: SessionEntity[]) {
  return {
    catalogId: "openshapeforge.entity-schemas",
    generatedBy: catalog.generatedBy,
    source: catalog.source,
    entities: entries.map(({ entity, tools }) => ({
      entity: entity.entity,
      slug: entity.slug,
      title: entity.title,
      description: entity.description,
      domains: entity.domains,
      resourceUri: entityResourceUri(entity),
      operations: tools.map((tool) => tool.name),
    })),
  };
}

export const __describeEntityResourceForTests = describeEntityResource;

/**
 * Test-only direct handles on the two classification controls that exist only
 * on this transport. They are the whole reason the MCP surface needs its own
 * coverage: everything else here is the shared CRUD core's behaviour, already
 * proven by the GraphQL and REST suites. Mirrors
 * __requireEntityOperationForTests in generated-crud.ts.
 */
export const __withholdClassifiedForTests = withholdClassified;
export const __assertWritableValuesForTests = assertWritableValues;
export const __sessionMayInvokeForTests = sessionMayInvoke;
export const __describeToolForTests = describeTool;

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Errors are returned as tool results rather than protocol errors: a model
 * that gets "FORBIDDEN: not authorized to delete Relation" back as content can
 * adapt, where a transport-level failure just terminates the call. The code
 * vocabulary is the CRUD layer's, unchanged.
 */
function failed(error: unknown): ToolResult {
  const { body } = toHttpError(error);
  return {
    content: [
      { type: "text", text: `${body.error.code}: ${body.error.message}` },
    ],
    isError: true,
  };
}

function requireArguments(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new HttpError(400, "BAD_USER_INPUT", "Tool arguments must be an object.");
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
function assertDeclaredProperties(
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

function requireId(args: Record<string, unknown>): string {
  const id = args.id;
  if (typeof id !== "string" || id === "") {
    throw new HttpError(400, "BAD_USER_INPUT", "Tool argument `id` is required.");
  }
  return id;
}

/**
 * Reject writes to fields the caller cannot read back. Accepting one would let
 * a read-only caller set a classified value and confirm it through a filter —
 * and would silently succeed at writing data the response then redacts.
 */
function assertWritableValues(
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

async function invokeTool(
  tool: CatalogTool,
  entity: CatalogEntity | undefined,
  table: GeneratedTable,
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args = requireArguments(rawArgs);

  switch (tool.operation) {
    case "list": {
      const filter =
        args.filter && typeof args.filter === "object" && !Array.isArray(args.filter)
          ? (args.filter as Record<string, unknown>)
          : undefined;
      const sort =
        args.sortField || args.sortDirection
          ? {
              field: typeof args.sortField === "string" ? args.sortField : null,
              direction: typeof args.sortDirection === "string" ? args.sortDirection : null,
            }
          : undefined;
      // Like REST, the MCP list result always publishes totalCount, so the
      // count pass is always requested (#17).
      const result = await listGeneratedEntities(db, session, {
        table: table.name,
        ...(typeof args.first === "number" ? { limit: args.first } : {}),
        ...(typeof args.after === "string" ? { cursor: args.after } : {}),
        ...(filter ? { filter } : {}),
        ...(sort ? { sort } : {}),
        includeTotalCount: true,
      });
      return ok({
        items: result.rows.map((row) => serializeRow(table, row)),
        totalCount: result.totalCount,
        nextCursor: result.nextCursor,
      });
    }

    case "get": {
      const row = await getGeneratedEntity(db, session, {
        table: table.name,
        id: requireId(args),
      });
      if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found.");
      return ok(serializeRow(table, row));
    }

    case "create": {
      const values = requireArguments(args);
      assertDeclaredProperties(tool.inputSchema, values, "field");
      assertWritableValues(values, entity, table, session);
      const row = await createGeneratedEntity(db, session, {
        table: table.name,
        values,
      });
      return ok(serializeRow(table, row));
    }

    case "update": {
      const id = requireId(args);
      assertDeclaredProperties(tool.inputSchema, args, "argument");
      const values = requireArguments(args.values);
      assertDeclaredProperties(
        (tool.inputSchema.properties as Record<string, Record<string, unknown>> | undefined)?.values,
        values,
        "field",
      );
      assertWritableValues(values, entity, table, session);
      const row = await updateGeneratedEntity(db, session, {
        table: table.name,
        id,
        values,
      });
      if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found.");
      return ok(serializeRow(table, row));
    }

    case "delete": {
      const deleted = await deleteGeneratedEntity(db, session, {
        table: table.name,
        id: requireId(args),
      });
      if (!deleted) throw new HttpError(404, "NOT_FOUND", "Resource not found.");
      return ok({ deleted: true });
    }
  }
}

function buildServer(db: OpenShapeForgeDatabase, session: DbSessionInput): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: INSTRUCTIONS,
  });
  const tables = tablesByName();

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const entries = entitiesForSession(session, tables);
    return {
      resources: [
        {
          uri: ENTITY_CATALOG_URI,
          name: "entity-catalog",
          title: "Entity schema catalog",
          description:
            "Authorized index of entity schemas compiled from OpenShapeForge authoring YAML.",
          mimeType: JSON_MIME_TYPE,
        },
        ...entries.map(({ entity }) => ({
          uri: entityResourceUri(entity),
          name: `entity-${entity.slug}`,
          title: `${entity.title} schema`,
          description: entity.description,
          mimeType: JSON_MIME_TYPE,
        })),
      ],
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const entries = entitiesForSession(session, tables);
    let payload: unknown;
    if (request.params.uri === ENTITY_CATALOG_URI) {
      payload = describeCatalogResource(entries);
    } else {
      const entry = entries.find(
        ({ entity }) => entityResourceUri(entity) === request.params.uri,
      );
      if (!entry) throw new McpError(ErrorCode.InvalidParams, "Resource not found.");
      payload = describeEntityResource(entry, entries, tables, session);
    }
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: JSON_MIME_TYPE,
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...toolsForSession(session, tables).map(({ tool, entity }) =>
        describeTool(tool, entity, tables.get(tool.table), session),
      ),
      // Connector operations join the SAME catalog, filtered by the same
      // session, so a caller sees one tool list rather than two surfaces with
      // different rules. The shared 60-tool budget is enforced at compile time.
      ...connectorToolsForSession(listConnectorContracts(), {
        roles: session.roles ?? [],
      }).map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;

    // Connector operations dispatch outside CRUD — own input schema, own
    // executor — so they are resolved before the entity table lookup. An
    // unauthorized connector tool resolves to nothing, which falls through to
    // the same NOT_FOUND an unknown name gets.
    const connectorTool = resolveConnectorTool(listConnectorContracts(), name, {
      roles: session.roles ?? [],
    });
    if (connectorTool) {
      try {
        const result = await invokeConnectorOperation(
          {
            db,
            session,
            registry: await connectorRegistry(),
            governor: connectorGovernor(),
            keyring: connectorKeyring(),
            roles: session.roles ?? [],
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

    const match = catalog.tools.find((tool) => tool.name === name);
    const table = match ? tables.get(match.table) : undefined;
    // An unknown tool and one the caller may not invoke get the same answer:
    // the listing already omitted both, so distinguishing them would leak
    // which entities exist.
    if (!match || !table || !sessionMayInvoke(table, match.operation, session)) {
      return failed(new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`));
    }
    const entity = catalog.entities.find((item) => item.entity === match.entity);
    try {
      return await invokeTool(match, entity, table, db, session, request.params.arguments);
    } catch (error) {
      return failed(error);
    }
  });

  return server;
}

export function registerGeneratedMcpServer(
  app: FastifyInstance,
  options: { db?: OpenShapeForgeDatabase | undefined } = {},
): void {
  // The transport exists when EITHER surface has something to advertise; a
  // deployment with connectors but no MCP-exposed entity still needs it.
  if (catalog.tools.length === 0 && listConnectorContracts().length === 0) {
    return;
  }

  async function requireMcpSession(request: FastifyRequest): Promise<{
    db: OpenShapeForgeDatabase;
    session: DbSessionInput;
  }> {
    const resolved = await resolveSessionContext(headersFromFastify(request.headers), { db: options.db });
    if (!resolved.tenantId || !resolved.userId) {
      throw new HttpError(
        401,
        "UNAUTHENTICATED",
        "MCP access requires an authenticated session.",
      );
    }
    if (!options.db) {
      throw new HttpError(
        503,
        "DATABASE_NOT_CONFIGURED",
        "Database is not configured for MCP access.",
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

  // Encapsulated plugin scope, like the REST routes: createApiApp() replaces
  // the global JSON parser with a raw-buffer passthrough for GraphQL Yoga, and
  // the SDK transport needs a parsed body.
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
      const { status, body } = toHttpError(error);
      if (status >= 500) {
        instance.log.error({ err: error }, "MCP request failed.");
      }
      // RFC 9728 / RFC 6750 §3: a 401 must point the client at where it can
      // learn how to authenticate. Without this header the metadata document
      // is undiscoverable and a spec-following client is stuck on a bare 401.
      if (status === 401) {
        void reply.header("www-authenticate", buildAuthenticateChallenge(request));
      }
      void reply.status(status).send(body);
    });

    instance.route({
      url: MCP_MOUNT_PATH,
      method: ["GET", "POST", "DELETE"],
      handler: async (request, reply) => {
        const { db, session } = await requireMcpSession(request);

        // Stateless: a fresh server and transport per request. The alternative
        // — persisting sessions — would need affinity across replicas, and
        // this transport carries no server-initiated state worth keeping.
        const server = buildServer(db, session);
        // `sessionIdGenerator` is omitted rather than set to undefined: the SDK
        // reads it as `=== undefined` to mean stateless, and omitting keeps
        // exactOptionalPropertyTypes happy.
        const transport = new StreamableHTTPServerTransport({
          enableJsonResponse: true,
        });

        reply.raw.on("close", () => {
          void transport.close();
          void server.close();
        });

        // handleRequest writes straight to the raw socket, so Fastify must be
        // told the reply is taken care of BEFORE anything is written — a
        // hijack afterwards races with Fastify's own response.
        reply.hijack();
        // The SDK declares Transport's optional callbacks as required-when-present,
        // which collides with this repo's exactOptionalPropertyTypes. The cast is
        // to the SDK's own Transport shape and changes no behaviour.
        await server.connect(transport as unknown as Parameters<Server["connect"]>[0]);
        await transport.handleRequest(request.raw, reply.raw, request.body);
      },
    });
  });
}
