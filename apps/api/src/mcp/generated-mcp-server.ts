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
import { randomUUID } from "node:crypto";
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
  createGeneratedEntityForTable,
  deleteGeneratedEntity,
  getGeneratedEntity,
  getGeneratedCrudTables,
  isGeneratedCrudOperationEnabled,
  listGeneratedEntities,
  listGeneratedEntitiesForTable,
  updateGeneratedEntity,
  updateGeneratedEntityForTable,
} from "../graphql/generated-crud.js";
import {
  derivedToolsFromRows,
  sessionInAudience,
  type DerivedTool,
  type DerivedToolsCatalogEntry,
} from "./derived-tools.js";
import {
  collectElicitedValues,
  redactElicitedValues,
  type ElicitOnCreateEntry,
} from "./elicitation.js";
import { executeBinding, orderedBindings, resolveTemplate } from "./declarative-execution.js";
import { discoverProviderSchema } from "./discovery.js";
import {
  exchangeCodeForTokens,
  mintAuthorization,
  redeemState,
} from "./entity-oauth.js";
import { decryptSecret, keyringFromEnv, type StoredSecret } from "../connectors/secrets.js";
import { refreshTokens } from "./entity-oauth.js";
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
  elicitOnCreate?: ElicitOnCreateEntry;
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
type CatalogResource = {
  uri: string;
  name: string;
  description: string;
  templateUri: string;
  templateName: string;
  templateDescription: string;
  entity: string;
  table: string;
};

type CatalogDiscoveryTool = {
  name: string;
  description: string;
  entity: string;
  table: string;
};

type Catalog = {
  generatedBy: string;
  source: string;
  tools: CatalogTool[];
  entities: CatalogEntity[];
  resources?: CatalogResource[];
  derivedTools?: DerivedToolsCatalogEntry[];
  discoveryTools?: CatalogDiscoveryTool[];
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
 * serializeRow plus elicited-secret redaction: for an entity whose create
 * elicits configuration, the target field's encrypted values leave the server
 * only as the `__set__` sentinel.
 */
function serializeRowForEntity(
  entity: CatalogEntity | undefined,
  table: GeneratedTable,
  row: Record<string, unknown>,
) {
  const serialized = serializeRow(table, row);
  return entity?.elicitOnCreate
    ? redactElicitedValues(serialized, entity.elicitOnCreate.into)
    : serialized;
}

function entityForTable(table: string): CatalogEntity | undefined {
  return catalog.entities.find((entity) => entity.table === table);
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

const catalogResources: CatalogResource[] = catalog.resources ?? [];

/**
 * A resource is a read surface, so visibility and reads are both gated on the
 * entity's read role — the same rule `get`/`list` tools follow. Like the tool
 * listing, an unauthorized resource is omitted rather than erroring.
 */
function resourcesForSession(
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
  resources: CatalogResource[] = catalogResources,
): CatalogResource[] {
  return resources.filter((resource) =>
    sessionMayInvoke(tables.get(resource.table), "get", session),
  );
}

const catalogDerivedTools: DerivedToolsCatalogEntry[] = catalog.derivedTools ?? [];
const catalogDiscoveryTools: CatalogDiscoveryTool[] = catalog.discoveryTools ?? [];

/** Discovery follows the entity's read role, like the resource surface. */
function discoveryToolsForSession(
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
): CatalogDiscoveryTool[] {
  return catalogDiscoveryTools.filter((tool) =>
    sessionMayInvoke(tables.get(tool.table), "get", session),
  );
}

/**
 * Cap on rows a definition table contributes to the derived-tool projection.
 * A deployment authoring more definitions than this needs curation, not a
 * longer tool list — tool selection quality degrades well before the cap.
 */
const DERIVED_TOOLS_ROW_LIMIT = 100;

/**
 * The per-session derived tools: definition rows read tenant-scoped (but
 * deliberately outside the entity-role gate — see
 * listGeneratedEntitiesForTable) for every projection whose audience roles
 * admit the session. Static catalog names are reserved so a stored
 * definition can never shadow a product tool.
 */
async function derivedToolsForSession(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
): Promise<DerivedTool[]> {
  const reserved = new Set(catalog.tools.map((tool) => tool.name));
  const tools: DerivedTool[] = [];
  for (const entry of catalogDerivedTools) {
    if (!sessionInAudience(entry, session.roles)) continue;
    const table = tables.get(entry.table);
    if (!table) continue;
    const result = await listGeneratedEntitiesForTable(db, session, table, {
      limit: DERIVED_TOOLS_ROW_LIMIT,
    });
    const rows = result.rows.map((row) => serializeRow(table, row));
    for (const tool of derivedToolsFromRows(entry, rows, reserved)) {
      reserved.add(tool.name);
      tools.push(tool);
    }
  }
  return tools;
}

/**
 * Ungated tenant-scoped single-row read for the execution path. Same
 * rationale as derivedToolsForSession: the caller holds NONE of the defining
 * entities' CRUD roles, yet the runtime executes their rows on the caller's
 * behalf; withDbSession still scopes every read to the caller's tenant.
 */
export const ENTITY_OAUTH_CALLBACK_PATH = "/api/entity-oauth/callback";

function elicitedKeyring() {
  return keyringFromEnv(process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS);
}

function callbackOrigin(): string {
  const configured = process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN?.trim().replace(/\/$/, "");
  if (configured) return configured;
  return `http://127.0.0.1:${process.env.PORT ?? "3001"}`;
}

function looksLikeStoredSecret(value: unknown): value is StoredSecret {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredSecret).ciphertext === "string" &&
    typeof (value as StoredSecret).keyId === "string"
  );
}

/**
 * The tenant-level connection's OAuth client credentials, decrypted. The
 * secret goes only into token-endpoint calls, never anywhere else.
 */
function readClientCredentials(
  tenantConnection: Record<string, unknown> | undefined,
  valuesField: string,
  secretScope: string,
): { clientId: string; clientSecret: string } {
  const values = (tenantConnection?.[valuesField] ?? {}) as Record<string, unknown>;
  const clientId = values.clientId;
  const rawSecret = values.clientSecret;
  const keyring = elicitedKeyring();
  if (typeof clientId !== "string" || !looksLikeStoredSecret(rawSecret) || !keyring) {
    throw new HttpError(
      400,
      "CONNECTION_MISSING",
      "An administrator must first create the provider connection holding the OAuth " +
        "client credentials (clientId and a confidential clientSecret).",
    );
  }
  return {
    clientId,
    clientSecret: decryptSecret(keyring, secretScope, "clientSecret", rawSecret),
  };
}

async function runtimeRowsByFilter(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
  tableName: string,
  filter: Record<string, unknown>,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  const table = tables.get(tableName);
  if (!table) return [];
  const result = await listGeneratedEntitiesForTable(db, session, table, { limit, filter });
  return result.rows.map((row) => serializeRow(table, row));
}

async function runtimeRowByFilter(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
  tableName: string,
  filter: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const table = tables.get(tableName);
  if (!table) return null;
  const result = await listGeneratedEntitiesForTable(db, session, table, { limit: 1, filter });
  const row = result.rows[0];
  return row ? serializeRow(table, row) : null;
}

/**
 * Cap on rows a catalogue resource read returns. A resource has no cursor
 * protocol, so the cap keeps one read bounded; a catalogue larger than this
 * needs the list tool, which pages.
 */
const RESOURCE_READ_LIMIT = 200;

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
export const __resourcesForSessionForTests = resourcesForSession;

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
        items: result.rows.map((row) => serializeRowForEntity(entity, table, row)),
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
      return ok(serializeRowForEntity(entity, table, row));
    }

    case "create": {
      const values = requireArguments(args);
      // The elicited target field is server-set (collected from the person at
      // the client before this ran), so it is exempt from the declared-schema
      // and writable checks that guard MODEL-supplied fields.
      const elicitField = entity?.elicitOnCreate?.into;
      const modelValues = elicitField
        ? Object.fromEntries(Object.entries(values).filter(([key]) => key !== elicitField))
        : values;
      assertDeclaredProperties(tool.inputSchema, modelValues, "field");
      assertWritableValues(modelValues, entity, table, session);
      const row = await createGeneratedEntity(db, session, {
        table: table.name,
        values,
      });
      return ok(serializeRowForEntity(entity, table, row));
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
      return ok(serializeRowForEntity(entity, table, row));
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

function buildServer(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  onDerivedDefinitionChanged?: (table: string, tenantId: string | null) => void,
): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: {
      // listChanged is advertised only when the tool list can actually change
      // mid-session — i.e. when stored rows project as tools.
      tools: catalogDerivedTools.length > 0 ? { listChanged: true } : {},
      resources: {},
      prompts: {},
    },
    // The server owns the OAuth redirect URL, so it states it here rather
    // than leaving assistants to ask the person for a value only this
    // process knows. Providers register this exact URL.
    instructions: catalogDerivedTools.some((entry) => entry.connect)
      ? `${INSTRUCTIONS} This server's OAuth redirect (callback) URL is ` +
        `${callbackOrigin()}${ENTITY_OAUTH_CALLBACK_PATH} — when setting up a provider ` +
        `OAuth client, give the person this exact URL to register; never ask them what it is.`
      : INSTRUCTIONS,
  });
  const tables = tablesByName();

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const entries = entitiesForSession(session, tables);
    const authoredResources = resourcesForSession(session, tables);
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
        ...authoredResources.map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          description: resource.description,
          mimeType: JSON_MIME_TYPE,
        })),
      ],
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: resourcesForSession(session, tables).map((resource) => ({
      uriTemplate: resource.templateUri,
      name: resource.templateName,
      description: resource.templateDescription,
      mimeType: JSON_MIME_TYPE,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const entries = entitiesForSession(session, tables);
    let payload: unknown;
    if (request.params.uri === ENTITY_CATALOG_URI) {
      payload = describeCatalogResource(entries);
    } else if (request.params.uri.startsWith(`${ENTITY_CATALOG_URI}/`)) {
      const entry = entries.find(
        ({ entity }) => entityResourceUri(entity) === request.params.uri,
      );
      if (!entry) throw new McpError(ErrorCode.InvalidParams, "Resource not found.");
      payload = describeEntityResource(entry, entries, tables, session);
    } else {
      const uri = request.params.uri;
      const readable = resourcesForSession(session, tables);
      const direct = readable.find((resource) => resource.uri === uri);
      if (direct) {
        const table = tables.get(direct.table);
        if (!table) throw new McpError(ErrorCode.InvalidParams, "Resource not found.");
        const result = await listGeneratedEntities(db, session, {
          table: table.name,
          limit: RESOURCE_READ_LIMIT,
        });
        payload = result.rows.map((row) =>
          serializeRowForEntity(entityForTable(direct.table), table, row),
        );
      } else {
        const templated = readable.find((resource) => uri.startsWith(`${resource.uri}/`));
        const id = templated ? uri.slice(templated.uri.length + 1) : "";
        const table = templated ? tables.get(templated.table) : undefined;
        if (!table || id.length === 0 || id.includes("/")) {
          throw new McpError(ErrorCode.InvalidParams, "Resource not found.");
        }
        const row = await getGeneratedEntity(db, session, { table: table.name, id });
        if (!row) throw new McpError(ErrorCode.InvalidParams, "Resource not found.");
        payload = serializeRowForEntity(entityForTable(templated.table), table, row);
      }
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
      ...catalogDerivedTools
        .filter((entry) => entry.connect && sessionInAudience(entry, session.roles))
        .map((entry) => ({
          name: entry.connect!.name,
          description: entry.connect!.description,
          inputSchema: {
            type: "object",
            properties: {
              tool: {
                type: "string",
                description: "Name of the tool to create your personal connection for.",
              },
            },
            required: ["tool"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        })),
      ...discoveryToolsForSession(session, tables).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              format: "uuid",
              description: `Identifier of the ${tool.entity} to discover.`,
            },
          },
          required: ["id"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      })),
      // Derived tools: definition rows projected per session and per tenant.
      ...(await derivedToolsForSession(db, session, tables)).map((tool) => ({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      })),
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

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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

    const connectEntry = catalogDerivedTools.find((entry) => entry.connect?.name === name);
    if (connectEntry) {
      if (!sessionInAudience(connectEntry, session.roles) || !connectEntry.execution) {
        return failed(new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`));
      }
      try {
        const execution = connectEntry.execution;
        const toolArg = (request.params.arguments as Record<string, unknown> | undefined)?.tool;
        if (typeof toolArg !== "string" || toolArg.length === 0) {
          throw new HttpError(400, "VALIDATION", 'Argument "tool" is required.');
        }
        // Only a PROJECTED row can start a connection: projection already
        // enforces publication and audience, so an unpublished or invisible
        // definition answers exactly like a nonexistent one.
        const target = (await derivedToolsForSession(db, session, tables)).find(
          (tool) => tool.name === toolArg && tool.table === connectEntry.table,
        );
        if (!target) {
          throw new HttpError(404, "NOT_FOUND", `No connectable tool "${toolArg}".`);
        }
        const definitionRow = await runtimeRowByFilter(db, session, tables, target.table, {
          id: target.rowId,
        });
        if (!definitionRow) throw new HttpError(404, "NOT_FOUND", `No connectable tool "${toolArg}".`);

        // Provider and scopes derive from the exact chain; the caller chooses
        // nothing. Exactly one distinct provider is supported per connection.
        const providerIds = new Set<string>();
        const requiredScopes = new Set<string>();
        for (const binding of orderedBindings(definitionRow, execution.bindingsField)) {
          const operationId = binding[execution.operationRef];
          const operationRow =
            typeof operationId === "string"
              ? await runtimeRowByFilter(db, session, tables, execution.operationTable, {
                  id: operationId,
                })
              : null;
          if (!operationRow) {
            throw new HttpError(
              400,
              "SERVICE_MISCONFIGURED",
              `A binding references a missing ${execution.operationEntity}.`,
            );
          }
          if (typeof operationRow[execution.providerRef] === "string") {
            providerIds.add(operationRow[execution.providerRef] as string);
          }
          if (Array.isArray(operationRow.requiredScopes)) {
            for (const scope of operationRow.requiredScopes as unknown[]) {
              if (typeof scope === "string") requiredScopes.add(scope);
            }
          }
        }
        if (providerIds.size !== 1) {
          throw new HttpError(
            400,
            "NOT_CONNECTABLE",
            "Personal connections support exactly one provider per definition.",
          );
        }
        const providerRowId = [...providerIds][0]!;
        const providerRow = await runtimeRowByFilter(db, session, tables, execution.providerTable, {
          id: providerRowId,
        });
        const auth = (providerRow?.auth ?? null) as Record<string, unknown> | null;
        if (!providerRow || auth?.profile !== "oauth2AuthorizationCode") {
          throw new HttpError(
            400,
            "NOT_CONNECTABLE",
            "This definition's provider does not support personal sign-in.",
          );
        }
        const authorizationUrl = auth.authorizationUrl;
        const tokenUrl = auth.tokenUrl;
        if (typeof authorizationUrl !== "string" || typeof tokenUrl !== "string") {
          throw new HttpError(
            400,
            "PROVIDER_MISCONFIGURED",
            "The provider declares no authorization and token endpoints.",
          );
        }
        const adapterScopes = Array.isArray(auth.scopes)
          ? (auth.scopes as unknown[]).filter((scope): scope is string => typeof scope === "string")
          : [];
        const scopes =
          requiredScopes.size > 0
            ? [...requiredScopes].filter(
                (scope) => adapterScopes.length === 0 || adapterScopes.includes(scope),
              )
            : adapterScopes;

        const connectionRows = await runtimeRowsByFilter(
          db,
          session,
          tables,
          execution.connectionTable,
          { [execution.connectionProviderRef]: providerRowId },
        );
        const personal = connectionRows.find((row) => row.ownerUserId === session.userId);
        const personalValues = (personal?.[execution.connectionValuesField] ?? null) as
          | Record<string, unknown>
          | null;
        if (personal && personalValues?.accessToken) {
          return ok({
            connected: true,
            provider: String(providerRow.name ?? providerRowId),
            message: "Your personal connection already exists. Just call the tool.",
          });
        }
        const tenantConnection = connectionRows.find((row) => !row.ownerUserId);
        const secretScope =
          entityForTable(execution.connectionTable)?.elicitOnCreate?.sourceTable ??
          execution.providerTable;
        const credentials = readClientCredentials(
          tenantConnection,
          execution.connectionValuesField,
          secretScope,
        );

        // Provider OAuth endpoints are routinely per-tenant
        // (https://{subdomain}.provider.com/...): placeholders resolve from
        // the tenant connection's NON-secret values, like base URLs do.
        const tenantPlainValues = Object.fromEntries(
          Object.entries(
            (tenantConnection?.[execution.connectionValuesField] ?? {}) as Record<string, unknown>,
          ).filter(([, value]) => value !== null && typeof value !== "object")
            .map(([key, value]) => [key, String(value)]),
        );
        const resolvedAuthorizationUrl = resolveTemplate(
          authorizationUrl,
          tenantPlainValues,
          "auth.authorizationUrl",
        );
        const resolvedTokenUrl = resolveTemplate(tokenUrl, tenantPlainValues, "auth.tokenUrl");

        const handoff = mintAuthorization({
          tenantId: session.tenantId as string,
          userId: session.userId as string,
          providerTable: execution.providerTable,
          providerRowId,
          connectionTable: execution.connectionTable,
          connectionProviderRef: execution.connectionProviderRef,
          connectionValuesField: execution.connectionValuesField,
          tokenUrl: resolvedTokenUrl,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          egress: Array.isArray(providerRow.egressHosts)
            ? (providerRow.egressHosts as string[])
            : [],
          scopes,
          redirectUri: `${callbackOrigin()}${ENTITY_OAUTH_CALLBACK_PATH}`,
          providerName: String(providerRow.name ?? providerRowId),
          authorizationUrl: resolvedAuthorizationUrl,
        });
        return ok({
          action: "authorize",
          provider: String(providerRow.name ?? providerRowId),
          scopes,
          authorizationUrl: handoff.authorizationUrl,
          expiresInSeconds: handoff.expiresInSeconds,
          instructions:
            "Ask the person to open authorizationUrl in their browser and approve access. " +
            "Once the provider confirms, call the tool again — no further setup is needed.",
        });
      } catch (error) {
        return failed(error);
      }
    }

    const discoveryTool = catalogDiscoveryTools.find((tool) => tool.name === name);
    if (discoveryTool) {
      const table = tables.get(discoveryTool.table);
      if (!table || !sessionMayInvoke(table, "get", session)) {
        return failed(new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`));
      }
      try {
        const id = (request.params.arguments as Record<string, unknown> | undefined)?.id;
        if (typeof id !== "string") {
          throw new HttpError(400, "VALIDATION", "Argument \"id\" is required.");
        }
        const row = await getGeneratedEntity(db, session, { table: table.name, id });
        if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found.");
        return ok(await discoverProviderSchema(serializeRow(table, row)));
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
      // Not a static tool — a derived (row-defined) tool may own the name.
      // Execution of derived tools is a later slice: the definition names an
      // intent, but the connection/execution machinery that fulfils it does
      // not exist yet, so the honest answer is a clear failure, not a stub
      // success an agent would act on.
      if (catalogDerivedTools.length > 0) {
        const derived = (await derivedToolsForSession(db, session, tables)).find(
          (tool) => tool.name === name,
        );
        if (derived) {
          const entry = catalogDerivedTools.find((candidate) => candidate.table === derived.table);
          const execution = entry?.execution;
          if (!execution) {
            return failed(
              new HttpError(
                501,
                "NOT_IMPLEMENTED",
                `Tool "${name}" is defined by a stored ${derived.entity} record, but ` +
                  `its projection does not declare execution. The definition can be ` +
                  `inspected via its ${derived.entity} resource or management tools.`,
              ),
            );
          }
          try {
            const args = (request.params.arguments ?? {}) as Record<string, unknown>;
            assertDeclaredProperties(derived.inputSchema, args, "argument");
            const requiredInputs = Array.isArray(derived.inputSchema.required)
              ? (derived.inputSchema.required as string[])
              : [];
            for (const key of requiredInputs) {
              if (args[key] === undefined || args[key] === null || args[key] === "") {
                throw new HttpError(400, "VALIDATION", `Input "${key}" is required.`);
              }
            }

            const serviceRow = await runtimeRowByFilter(db, session, tables, derived.table, {
              id: derived.rowId,
            });
            if (!serviceRow) throw new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`);

            // Later bindings see earlier outputs alongside the caller's
            // inputs, which is what makes read→act chains expressible.
            const accumulated: Record<string, unknown> = {};
            for (const binding of orderedBindings(serviceRow, execution.bindingsField)) {
              const operationId = binding[execution.operationRef];
              const operationRow =
                typeof operationId === "string"
                  ? await runtimeRowByFilter(db, session, tables, execution.operationTable, {
                      id: operationId,
                    })
                  : null;
              if (!operationRow) {
                throw new HttpError(
                  400,
                  "SERVICE_MISCONFIGURED",
                  `A binding references a missing ${execution.operationEntity}.`,
                );
              }
              const providerId = operationRow[execution.providerRef];
              const providerRow =
                typeof providerId === "string"
                  ? await runtimeRowByFilter(db, session, tables, execution.providerTable, {
                      id: providerId,
                    })
                  : null;
              if (!providerRow) {
                throw new HttpError(
                  400,
                  "SERVICE_MISCONFIGURED",
                  `The ${execution.operationEntity} references a missing ${execution.providerEntity}.`,
                );
              }
              const connectionRows = await runtimeRowsByFilter(
                db,
                session,
                tables,
                execution.connectionTable,
                { [execution.connectionProviderRef]: providerId },
              );
              const providerAuth = (providerRow.auth ?? null) as Record<string, unknown> | null;
              const elicitScope =
                entityForTable(execution.connectionTable)?.elicitOnCreate?.sourceTable ??
                execution.providerTable;
              let providerForExecution = providerRow;
              let connectionValues: unknown;
              let secretScope = elicitScope;

              if (providerAuth?.profile === "oauth2AuthorizationCode") {
                // Personal mode: execution resolves ONLY the caller's own
                // connection — another employee's tokens are unreachable by
                // construction, and their absence is a clear next step.
                const personal = connectionRows.find(
                  (row) => row.ownerUserId === session.userId,
                );
                const personalScope = `${execution.connectionTable}:personal`;
                let values = (personal?.[execution.connectionValuesField] ?? null) as
                  | Record<string, unknown>
                  | null;
                if (!personal || !values?.accessToken) {
                  throw new HttpError(
                    403,
                    "CONNECTION_REQUIRED",
                    `This tool needs your personal ${String(providerRow.name ?? "provider")} ` +
                      `connection. Call ${entry?.connect?.name ?? "the connect tool"} with ` +
                      `{"tool":"${name}"} to start it.`,
                  );
                }
                const expiresAtRaw = values.accessTokenExpiresAt;
                const expiresAtMs =
                  typeof expiresAtRaw === "string" ? Date.parse(expiresAtRaw) : Number.NaN;
                if (
                  Number.isFinite(expiresAtMs) &&
                  expiresAtMs < Date.now() + 60_000 &&
                  looksLikeStoredSecret(values.refreshToken)
                ) {
                  const keyring = elicitedKeyring();
                  const tenantConnection = connectionRows.find((row) => !row.ownerUserId);
                  const credentials = readClientCredentials(
                    tenantConnection,
                    execution.connectionValuesField,
                    elicitScope,
                  );
                  if (!keyring || typeof providerAuth.tokenUrl !== "string") {
                    throw new HttpError(400, "PROVIDER_MISCONFIGURED", "Token refresh is not configured.");
                  }
                  const tenantPlain = Object.fromEntries(
                    Object.entries(
                      (tenantConnection?.[execution.connectionValuesField] ?? {}) as Record<
                        string,
                        unknown
                      >,
                    ).filter(([, value]) => value !== null && typeof value !== "object")
                      .map(([key, value]) => [key, String(value)]),
                  );
                  const refreshed = await refreshTokens({
                    tokenUrl: resolveTemplate(providerAuth.tokenUrl, tenantPlain, "auth.tokenUrl"),
                    clientId: credentials.clientId,
                    clientSecret: credentials.clientSecret,
                    refreshToken: decryptSecret(
                      keyring,
                      personalScope,
                      "refreshToken",
                      values.refreshToken as StoredSecret,
                    ),
                    egress: Array.isArray(providerRow.egressHosts)
                      ? (providerRow.egressHosts as string[])
                      : [],
                    connectionTable: execution.connectionTable,
                  });
                  values = { ...values, ...refreshed.values };
                  const connectionTableDef = tables.get(execution.connectionTable);
                  if (connectionTableDef) {
                    await updateGeneratedEntityForTable(
                      db,
                      session,
                      connectionTableDef,
                      String(personal.id),
                      { [execution.connectionValuesField]: values },
                    );
                  }
                }
                // The personal connection holds only tokens; tenant-owned
                // NON-secret configuration (subdomain and friends) still
                // resolves base-URL and path templates, so merge the tenant
                // connection's plain half underneath the personal values.
                const tenantConnectionForPlain = connectionRows.find((row) => !row.ownerUserId);
                const tenantPlainForExecution = Object.fromEntries(
                  Object.entries(
                    (tenantConnectionForPlain?.[execution.connectionValuesField] ?? {}) as Record<
                      string,
                      unknown
                    >,
                  ).filter(
                    ([, value]) =>
                      value !== null && typeof value !== "object" && value !== undefined,
                  ),
                );
                connectionValues = { ...tenantPlainForExecution, ...values };
                secretScope = personalScope;
                providerForExecution = {
                  ...providerRow,
                  auth: { scheme: "bearer", tokenFrom: "accessToken" },
                };
              } else {
                const tenantConnection =
                  connectionRows.find((row) => !row.ownerUserId) ?? connectionRows[0];
                if (!tenantConnection) {
                  throw new HttpError(
                    400,
                    "CONNECTION_MISSING",
                    `No ${execution.connectionEntity} is configured for this ` +
                      `${execution.providerEntity}; an administrator must create one first.`,
                  );
                }
                connectionValues = tenantConnection[execution.connectionValuesField];
              }

              const outputs = await executeBinding({
                binding,
                operationRow,
                providerRow: providerForExecution,
                connectionValues,
                serviceInputs: { ...args, ...accumulated },
                secretScope,
              });
              Object.assign(accumulated, outputs);
            }
            return ok(accumulated);
          } catch (error) {
            return failed(error);
          }
        }
      }
      return failed(new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`));
    }
    const entity = catalog.entities.find((item) => item.entity === match.entity);
    try {
      let callArguments = request.params.arguments;
      if (match.operation === "create" && entity?.elicitOnCreate) {
        const elicit = entity.elicitOnCreate;
        const modelArguments = { ...((callArguments ?? {}) as Record<string, unknown>) };
        // The model is not a channel for elicited values: whatever it sent for
        // the target field is discarded before the person is asked.
        delete modelArguments[elicit.into];

        const sourceId = modelArguments[elicit.sourceField];
        const sourceTable = tables.get(elicit.sourceTable);
        let sourceRow: Record<string, unknown> | null = null;
        if (typeof sourceId === "string" && sourceTable) {
          try {
            const row = await getGeneratedEntity(db, session, {
              table: sourceTable.name,
              id: sourceId,
            });
            if (row) sourceRow = serializeRow(sourceTable, row);
          } catch {
            // Unauthorized and missing get the same NOT_FOUND from the
            // collector, mirroring the tool-listing principle.
          }
        }
        callArguments = await collectElicitedValues({
          server,
          elicit,
          sourceRow,
          values: modelArguments,
          relatedRequestId: extra.requestId,
        });
      }
      const outcome = await invokeTool(match, entity, table, db, session, callArguments);
      // A successful mutation on a table whose rows project as tools changes
      // other sessions' tool lists — tell them, so they re-list instead of
      // discovering the change on their next reconnect.
      if (
        onDerivedDefinitionChanged &&
        !(outcome as { isError?: boolean }).isError &&
        match.operation !== "get" &&
        match.operation !== "list" &&
        catalogDerivedTools.some((entry) => entry.table === match.table)
      ) {
        onDerivedDefinitionChanged(match.table, session.tenantId ?? null);
      }
      return outcome;
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

    // Stateful sessions, keyed by the SDK-issued mcp-session-id and bound to
    // the authenticated identity that initialized them. Statefulness is what
    // makes server-initiated exchanges possible at all: elicitation sends a
    // request on the SSE stream of one POST and receives the person's answer
    // as the NEXT POST, which must reach the same transport. Sessions are
    // per-process; a multi-replica deployment needs session affinity on this
    // path.
    type McpSessionEntry = {
      transport: StreamableHTTPServerTransport;
      server: Server;
      tenantId: string;
      userId: string;
      roles: string[];
      lastSeenMs: number;
    };
    const mcpSessions = new Map<string, McpSessionEntry>();
    const SESSION_IDLE_LIMIT_MS = 30 * 60 * 1000;
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of mcpSessions) {
        if (now - entry.lastSeenMs > SESSION_IDLE_LIMIT_MS) {
          mcpSessions.delete(id);
          void entry.transport.close();
          void entry.server.close();
        }
      }
    }, 60 * 1000);
    sweep.unref();

    /**
     * Fan a tools/list_changed out to every live session of the SAME tenant
     * whose roles could see tools derived from `table` — audience roles or
     * any role with an operation on the defining entity. A session without an
     * open notification stream simply misses the nudge; delivery is
     * best-effort by design.
     */
    const notifyDerivedDefinitionChanged = (table: string, tenantId: string | null): void => {
      const audiences = catalogDerivedTools
        .filter((entry) => entry.table === table)
        .flatMap((entry) => entry.roles);
      if (audiences.length === 0) return;
      const audience = new Set(audiences);
      for (const entry of mcpSessions.values()) {
        if (tenantId && entry.tenantId !== tenantId) continue;
        if (!entry.roles.some((role) => audience.has(role))) continue;
        void entry.server.sendToolListChanged().catch(() => {
          // No open stream on this session; it will see the change on its
          // next tools/list.
        });
      }
    };

    const isInitializeBody = (body: unknown): boolean => {
      const messages = Array.isArray(body) ? body : [body];
      return messages.some(
        (message) =>
          message !== null &&
          typeof message === "object" &&
          (message as { method?: unknown }).method === "initialize",
      );
    };

    // The OAuth return leg. Unauthenticated by necessity — it is a cross-site
    // browser navigation. It trusts nothing in its query beyond looking up
    // the single-use state minted by the connect tool; tenant, user, token
    // endpoint and credentials all come from that pending record.
    const html = (message: string) =>
      `<!doctype html><meta charset="utf-8"><title>Connection</title>` +
      `<body style="font-family:system-ui;margin:4rem auto;max-width:28rem">` +
      `<p>${message}</p></body>`;
    instance.get(ENTITY_OAUTH_CALLBACK_PATH, async (request, reply) => {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const pending = redeemState(query.state);
      if (!pending) {
        return reply
          .status(400)
          .type("text/html")
          .send(html("This sign-in link is invalid or expired. Start again from your chat."));
      }
      if (typeof query.error === "string" && query.error) {
        return reply
          .status(400)
          .type("text/html")
          .send(html("The provider refused the sign-in. Nothing was stored."));
      }
      if (typeof query.code !== "string" || query.code.length === 0) {
        return reply
          .status(400)
          .type("text/html")
          .send(html("The provider sent no authorization code. Nothing was stored."));
      }
      try {
        const { values } = await exchangeCodeForTokens(pending, query.code);
        const db = options.db;
        if (!db) throw new Error("Database is not configured.");
        const tables = tablesByName();
        const table = tables.get(pending.connectionTable);
        if (!table) throw new Error("Connection table is missing from the manifest.");
        const writeSession: DbSessionInput = {
          tenantId: pending.tenantId,
          userId: pending.userId,
          roles: [],
          groups: [],
          scope: "self",
        };
        const existing = (
          await listGeneratedEntitiesForTable(db, writeSession, table, {
            limit: 50,
            filter: { [pending.connectionProviderRef]: pending.providerRowId },
          })
        ).rows
          .map((row) => serializeRow(table, row))
          .find((row) => row.ownerUserId === pending.userId);
        if (existing) {
          await updateGeneratedEntityForTable(db, writeSession, table, String(existing.id), {
            [pending.connectionValuesField]: values,
          });
        } else {
          await createGeneratedEntityForTable(db, writeSession, table, {
            key: `personal-${pending.userId.replace(/[^a-z0-9-]/g, "").slice(0, 20)}`,
            name: `Personal ${pending.providerName} connection`,
            [pending.connectionProviderRef]: pending.providerRowId,
            ownerUserId: pending.userId,
            [pending.connectionValuesField]: values,
          });
        }
        return reply
          .status(200)
          .type("text/html")
          .send(html("Connected. You can close this window and return to your chat."));
      } catch (error) {
        request.log.error({ err: error }, "Personal connection callback failed.");
        return reply
          .status(500)
          .type("text/html")
          .send(html("Storing the connection failed. Start again from your chat."));
      }
    });

    instance.route({
      url: MCP_MOUNT_PATH,
      method: ["GET", "POST", "DELETE"],
      handler: async (request, reply) => {
        const { db, session } = await requireMcpSession(request);

        const sessionHeader = request.headers["mcp-session-id"];
        const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

        if (sessionId) {
          const existing = mcpSessions.get(sessionId);
          if (!existing) {
            // Per spec: an unknown session id answers 404 so the client
            // reinitializes, rather than being silently handled statelessly.
            throw new HttpError(404, "SESSION_NOT_FOUND", "Unknown MCP session; reinitialize.");
          }
          // The session is a credential: it was initialized by one identity
          // and stays bound to it.
          if (existing.tenantId !== session.tenantId || existing.userId !== session.userId) {
            throw new HttpError(403, "FORBIDDEN", "MCP session belongs to another identity.");
          }
          existing.lastSeenMs = Date.now();
          reply.hijack();
          await existing.transport.handleRequest(request.raw, reply.raw, request.body);
          return;
        }

        if (request.method === "POST" && isInitializeBody(request.body)) {
          const server = buildServer(db, session, notifyDerivedDefinitionChanged);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              mcpSessions.set(id, {
                transport,
                server,
                tenantId: session.tenantId as string,
                userId: session.userId as string,
                roles: [...(session.roles ?? [])],
                lastSeenMs: Date.now(),
              });
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) mcpSessions.delete(transport.sessionId);
          };
          reply.hijack();
          // The SDK declares Transport's optional callbacks as required-when-present,
          // which collides with this repo's exactOptionalPropertyTypes. The cast is
          // to the SDK's own Transport shape and changes no behaviour.
          await server.connect(transport as unknown as Parameters<Server["connect"]>[0]);
          await transport.handleRequest(request.raw, reply.raw, request.body);
          return;
        }

        // Sessionless non-initialize request: the pre-session stateless
        // single-shot behaviour, kept for probes and legacy callers. No
        // server-initiated exchange is possible on this path, but a mutation
        // made through it still nudges the live sessions.
        const server = buildServer(db, session, notifyDerivedDefinitionChanged);
        const transport = new StreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        reply.raw.on("close", () => {
          void transport.close();
          void server.close();
        });
        reply.hijack();
        await server.connect(transport as unknown as Parameters<Server["connect"]>[0]);
        await transport.handleRequest(request.raw, reply.raw, request.body);
      },
    });
  });
}
