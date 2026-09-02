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
import { sql } from "kysely";
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
import { withDbSession } from "../db/session.js";
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
  applyPersonalNotes,
  deriveToolName,
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
import {
  consumeConfiguration,
  consumeConfigurationForSession,
  configurationFormDefinitions,
  latestConfigurationForSession,
  mintConfiguration,
  parseSubmission,
  peekConfiguration,
  renderConfigurationForm,
  renderConfigurationApp,
  renderMessagePage,
  storeSubmission,
  type PendingConfiguration,
} from "./configuration-handoff.js";
import {
  bindingSelected,
  composeBindingRequest,
  definitionFieldKeys,
  executeBinding,
  mergeOutputs,
  orderedBindings,
  providerUrlTemplates,
  resolveTemplate,
  secretFieldKeys,
  secretUrlPlaceholderError,
  templatePlaceholders,
} from "./declarative-execution.js";
import { validateVisibleDefinition } from "./publication-validation.js";
import { failedCheckSummary, testElicitedRow } from "./connection-test.js";
import { discoverProviderSchema } from "./discovery.js";
import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import {
  exchangeCodeForTokens,
  mintAuthorization,
  redeemState,
  scopesCovered,
} from "./entity-oauth.js";
import {
  decryptSecret,
  keyringFromEnv,
  type StoredSecret,
} from "../connectors/secrets.js";
import { refreshTokens } from "./entity-oauth.js";
import { canReadClassifiedColumns } from "../graphql/generated-authz.js";
import { headersFromFastify } from "../http/headers.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import { failureSummary } from "../connectors/provider-outcome.js";
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
import type { RuntimeModule } from "../modules/contract.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { bindOperationHandlers, invokeOperation } from "../operations/runtime.js";

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

type CatalogGuideTool = {
  name: string;
  description: string;
  roles: string[];
  content: string;
  entity?: string;
  table?: string;
  requireBeforeCreate?: boolean;
};

type CatalogDiscoveryTool = {
  name: string;
  description: string;
  entity: string;
  table: string;
};

type CatalogTestTool = {
  name: string;
  description: string;
  entity: string;
  table: string;
};

type Catalog = {
  generatedBy: string;
  source: string;
  tools: CatalogTool[];
  operationTools: {
    key: string;
    plugin: string;
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    auth: { mode: "public" } | { mode: "session"; roles: string[]; scopes?: string[] };
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  }[];
  entities: CatalogEntity[];
  resources?: CatalogResource[];
  derivedTools?: DerivedToolsCatalogEntry[];
  discoveryTools?: CatalogDiscoveryTool[];
  testTools?: CatalogTestTool[];
  guideTools?: CatalogGuideTool[];
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
    column.name.replace(/_([a-z0-9])/g, (_match, char: string) =>
      char.toUpperCase(),
    )
  );
}

function serializeRow(table: GeneratedTable, row: Record<string, unknown>) {
  return Object.fromEntries(
    table.columns.map((column) => [
      fieldNameForColumn(column),
      row[column.name],
    ]),
  );
}

/**
 * serializeRow plus elicited-secret redaction: for an entity whose create
 * elicits configuration, the target field's encrypted values leave the server
 * only as the `__set__` sentinel.
 */
/**
 * Whether a provider's connections are per-employee. Explicit
 * auth.connectionScope wins; absent, personal sign-in implies "user" and
 * everything else "tenant".
 */
function connectionScopeOf(
  auth: Record<string, unknown> | null | undefined,
): "user" | "tenant" {
  if (auth?.connectionScope === "user" || auth?.connectionScope === "tenant") {
    return auth.connectionScope;
  }
  return auth?.profile === "oauth2AuthorizationCode" ? "user" : "tenant";
}

let oauthProviderTablesCache: Set<string> | undefined;
function oauthProviderTables(): Set<string> {
  oauthProviderTablesCache ??= new Set(
    (catalog.derivedTools ?? [])
      .filter((entry) => entry.execution)
      .map((entry) => entry.execution!.providerTable),
  );
  return oauthProviderTablesCache;
}

function serializeRowForEntity(
  entity: CatalogEntity | undefined,
  table: GeneratedTable,
  row: Record<string, unknown>,
) {
  const serialized = serializeRow(table, row);
  const redacted = entity?.elicitOnCreate
    ? redactElicitedValues(serialized, entity.elicitOnCreate.into)
    : serialized;
  // A provider declaring personal sign-in needs its OAuth client registered
  // with THIS server's redirect URL — a fact only this process knows, so it
  // rides along on the row instead of being asked of anyone.
  const auth = redacted.auth as Record<string, unknown> | null | undefined;
  if (
    oauthProviderTables().has(table.name) &&
    auth &&
    typeof auth === "object" &&
    auth.profile === "oauth2AuthorizationCode"
  ) {
    redacted.oauthRedirectUrl = `${callbackOrigin()}${ENTITY_OAUTH_CALLBACK_PATH}`;
  }
  return redacted;
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
  if (!table || !isGeneratedCrudOperationEnabled(table, operation))
    return false;
  const required =
    table?.source?.authorization?.roles?.[OPERATION_ROLE[operation]];
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

  const pruneObjectLevel = (
    node: Record<string, unknown>,
  ): Record<string, unknown> => {
    const properties = node.properties;
    const result = { ...node };
    if (
      properties &&
      typeof properties === "object" &&
      !Array.isArray(properties)
    ) {
      result.properties = Object.fromEntries(
        Object.entries(properties as Record<string, unknown>).filter(
          ([name]) => !withheld.has(name),
        ),
      );
    }
    if (Array.isArray(node.required)) {
      result.required = node.required.filter(
        (name) => !withheld.has(name as string),
      );
    }
    return result;
  };

  const root = pruneObjectLevel(schema);
  const properties = root.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return root;

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
  const entitiesByName = new Map(
    catalog.entities.map((entity) => [entity.entity, entity]),
  );
  return catalog.tools
    .filter((tool) =>
      sessionMayInvoke(tables.get(tool.table), tool.operation, session),
    )
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

const catalogDerivedTools: DerivedToolsCatalogEntry[] =
  catalog.derivedTools ?? [];
const catalogDiscoveryTools: CatalogDiscoveryTool[] =
  catalog.discoveryTools ?? [];
const catalogTestTools: CatalogTestTool[] = catalog.testTools ?? [];
const catalogGuideTools: CatalogGuideTool[] = catalog.guideTools ?? [];

function guideToolsForSession(session: DbSessionInput): CatalogGuideTool[] {
  const granted = new Set(session.roles ?? []);
  return catalogGuideTools.filter((tool) =>
    tool.roles.some((role) => granted.has(role)),
  );
}

/** Discovery follows the entity's read role, like the resource surface. */
function discoveryToolsForSession(
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
): CatalogDiscoveryTool[] {
  return catalogDiscoveryTools.filter((tool) =>
    sessionMayInvoke(tables.get(tool.table), "get", session),
  );
}

/** A test reads the row and exercises it; visibility follows the read role. */
function testToolsForSession(
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
): CatalogTestTool[] {
  return catalogTestTools.filter((tool) =>
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
    let entryTools = derivedToolsFromRows(
      entry,
      rows,
      reserved,
      session.roles ?? [],
    );
    // Honest annotations, derived from the chain instead of assumed: a tool
    // whose every bound operation is a query is read-only, and hosts treat
    // read-only tools with less approval friction. A chain that does not
    // resolve keeps the cautious default.
    if (entry.execution && entryTools.length > 0) {
      const operationTable = tables.get(entry.execution.operationTable);
      if (operationTable) {
        const operationRows = await listGeneratedEntitiesForTable(
          db,
          session,
          operationTable,
          {
            limit: DERIVED_TOOLS_ROW_LIMIT,
          },
        );
        const operationTraits = new Map<
          string,
          { mutation: boolean; destructive: boolean }
        >();
        for (const raw of operationRows.rows) {
          const row = serializeRow(operationTable, raw);
          const operation = (row.operation ?? {}) as Record<string, unknown>;
          operationTraits.set(String(row.id), {
            mutation: row.kind === "mutation",
            destructive:
              typeof operation.method === "string" &&
              operation.method.toUpperCase() === "DELETE",
          });
        }
        const rowById = new Map(rows.map((row) => [String(row.id), row]));
        entryTools = entryTools.map((tool) => {
          const bindingsRaw = rowById.get(tool.rowId)?.[
            entry.execution!.bindingsField
          ];
          const bindings = Array.isArray(bindingsRaw)
            ? (bindingsRaw as Record<string, unknown>[])
            : [];
          let mutation = false;
          let destructive = false;
          let resolved = bindings.length > 0;
          for (const binding of bindings) {
            const traits = operationTraits.get(
              String(binding?.[entry.execution!.operationRef] ?? ""),
            );
            if (!traits) {
              resolved = false;
              continue;
            }
            mutation ||= traits.mutation;
            destructive ||= traits.destructive;
          }
          return { ...tool, readOnly: resolved && !mutation, destructive };
        });
      }
    }
    // The caller's stored standing instructions ride along on THEIR view of
    // the tools — appended under the authored description, never over it.
    if (entry.personalization && entryTools.length > 0) {
      const preferenceTable = tables.get(entry.personalization.table);
      if (preferenceTable) {
        const mine = await listGeneratedEntitiesForTable(
          db,
          session,
          preferenceTable,
          {
            limit: 100,
            fixedWhere: [{ column: "owner_user_id", value: session.userId }],
          },
        );
        entryTools = applyPersonalNotes(
          entryTools,
          entry,
          mine.rows.map((row) => serializeRow(preferenceTable, row)),
        );
      }
    }
    for (const tool of entryTools) {
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
export const ENTITY_CONFIGURATION_PATH = "/api/entity-configuration";
export const ENTITY_CONFIGURATION_APP_URI =
  "ui://openshapeforge/configuration";
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
const MCP_APP_EXTENSION_ID = "io.modelcontextprotocol/ui";

/**
 * Whether a failed elicitation should fall back to the browser handoff.
 * Unsupported clients, auto-answering clients (declared the capability, then
 * "declined" in machine time), dismissed forms and timed-out forms all land
 * here; a person who genuinely declined simply never opens the link and its
 * token expires. Every other failure (missing source row, keyring problems)
 * stays an error.
 */
function elicitationFallback(
  error: unknown,
): "unsupported" | "declined" | "timeout" | null {
  if (error instanceof HttpError) {
    if (error.code === "ELICITATION_UNSUPPORTED") return "unsupported";
    if (error.code === "ELICITATION_DECLINED") return "declined";
    return null;
  }
  const message = error instanceof Error ? error.message : "";
  return /timed?\s*out|timeout/i.test(message) ? "timeout" : null;
}

function elicitedKeyring() {
  return keyringFromEnv(process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS);
}

function callbackOrigin(): string {
  const configured = process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN?.trim().replace(
    /\/$/,
    "",
  );
  if (configured) return configured;
  throw new HttpError(
    503,
    "PUBLIC_ORIGIN_NOT_CONFIGURED",
    "OPENSHAPEFORGE_PUBLIC_ORIGIN is not configured, so no browser callback URL can be built.",
  );
}

function configurationWebUrl(): string {
  const configured = process.env.OPENSHAPEFORGE_WEB_ORIGIN?.trim().replace(
    /\/$/,
    "",
  );
  if (configured) return `${configured}/configuration`;
  throw new HttpError(
    503,
    "WEB_ORIGIN_NOT_CONFIGURED",
    "Set OPENSHAPEFORGE_WEB_ORIGIN before using the external configuration fallback.",
  );
}

function clientSupportsMcpApp(capabilities: unknown): boolean {
  const typed = capabilities as
    | { extensions?: Record<string, unknown> }
    | undefined;
  const ui = typed?.extensions?.[MCP_APP_EXTENSION_ID] as
    | { mimeTypes?: unknown }
    | undefined;
  return (
    Array.isArray(ui?.mimeTypes) && ui.mimeTypes.includes(MCP_APP_MIME_TYPE)
  );
}

function supportsMcpApp(server: Server): boolean {
  return clientSupportsMcpApp(server.getClientCapabilities());
}

export const __clientSupportsMcpAppForTests = clientSupportsMcpApp;

function looksLikeStoredSecret(value: unknown): value is StoredSecret {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredSecret).ciphertext === "string" &&
    typeof (value as StoredSecret).keyId === "string"
  );
}

function accessTokenNeedsRefresh(values: Record<string, unknown>): boolean {
  const expiresAt = values.accessTokenExpiresAt;
  const expiresAtMs =
    typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  return Number.isFinite(expiresAtMs) && expiresAtMs < Date.now() + 60_000;
}

async function refreshConnectionRowLocked(input: {
  db: OpenShapeForgeDatabase;
  session: DbSessionInput;
  table: GeneratedTable;
  rowId: string;
  valuesField: string;
  refresh: (
    values: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  const valuesColumn = input.table.columns.find(
    (column) =>
      (column.sourceField ??
        column.name.replace(/_([a-z0-9])/g, (_match, char: string) =>
          char.toUpperCase(),
        )) === input.valuesField,
  );
  if (!valuesColumn || !input.table.primaryKey) {
    throw new HttpError(
      500,
      "INTERNAL",
      "Connection values column is missing from the manifest.",
    );
  }
  return withDbSession(input.db, input.session, async (trx) => {
    const locked = await sql<{ values: Record<string, unknown> | null }>`
      select ${sql.id(valuesColumn.name)} as values
        from ${sql.id(input.table.schema, input.table.table)}
       where ${sql.id(input.table.primaryKey!)}::text = ${input.rowId}
       for update
    `.execute(trx);
    const current = locked.rows[0]?.values ?? {};
    if (!accessTokenNeedsRefresh(current)) return current;
    const merged = { ...current, ...(await input.refresh(current)) };
    // Persist inside the same transaction that holds the row lock. Re-entering
    // the generic CRUD helper here would open a nested session/transaction and
    // release neither waiters nor the lock in the intended order.
    await sql`
      update ${sql.id(input.table.schema, input.table.table)}
         set ${sql.id(valuesColumn.name)} = ${JSON.stringify(merged)}::jsonb
       where ${sql.id(input.table.primaryKey!)}::text = ${input.rowId}
    `.execute(trx);
    return merged;
  });
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
  const values = (tenantConnection?.[valuesField] ?? {}) as Record<
    string,
    unknown
  >;
  const rawClientId = values.clientId;
  const rawSecret = values.clientSecret;
  const keyring = elicitedKeyring();
  // Classifying the client id confidential is a legitimate authoring choice,
  // so an encrypted clientId is as present as a plain one — found live: a
  // connection that passed every validation dead-ended at sign-in because
  // this reader treated the encrypted form as missing.
  const clientIdReadable =
    typeof rawClientId === "string" || looksLikeStoredSecret(rawClientId);
  if (!clientIdReadable || !looksLikeStoredSecret(rawSecret) || !keyring) {
    throw new HttpError(
      400,
      "CONNECTION_MISSING",
      "An administrator must first create the provider connection holding the OAuth " +
        "client credentials (clientId and a confidential clientSecret).",
    );
  }
  return {
    clientId:
      typeof rawClientId === "string"
        ? rawClientId
        : decryptSecret(keyring, secretScope, "clientId", rawClientId),
    clientSecret: decryptSecret(
      keyring,
      secretScope,
      "clientSecret",
      rawSecret,
    ),
  };
}

/**
 * The URL-resolvable half of a connection's stored values: plain values, plus
 * encrypted values whose FIELD the provider definitions do not classify as
 * secret. Encryption at rest is storage hygiene; the classification is the
 * policy — so reclassifying a field (a subdomain mistaken for a secret) frees
 * its stored value immediately, without anyone re-entering it. Keys that stay
 * barred are returned so template errors can explain the classification cause.
 */
function urlSafeConnectionValues(
  row: Record<string, unknown> | undefined,
  valuesField: string,
  definitions: unknown,
  secretScope: string,
): { plain: Record<string, string>; secretKeys: Set<string> } {
  const values = (row?.[valuesField] ?? {}) as Record<string, unknown>;
  const secretClassified = secretFieldKeys(definitions);
  const defined = definitionFieldKeys(definitions);
  const keyring = elicitedKeyring();
  const plain: Record<string, string> = {};
  const barred = new Set<string>();
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    if (looksLikeStoredSecret(value)) {
      // Only fields the definitions declare can be URL-safe; anything else
      // encrypted (runtime-issued tokens) is secret by construction.
      if (!defined.has(key) || secretClassified.has(key) || !keyring) {
        barred.add(key);
        continue;
      }
      plain[key] = decryptSecret(keyring, secretScope, key, value);
    } else if (typeof value !== "object") {
      plain[key] = String(value);
    }
  }
  return { plain, secretKeys: barred };
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
  const result = await listGeneratedEntitiesForTable(db, session, table, {
    limit,
    filter,
  });
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
  const result = await listGeneratedEntitiesForTable(db, session, table, {
    limit: 1,
    filter,
  });
  const row = result.rows[0];
  return row ? serializeRow(table, row) : null;
}

// The advertised JSON Schema IS the contract: what tools/list promises,
// tools/call enforces. Without this, enum/pattern/length constraints are
// decoration and `status: "banana"` persists with a 200.
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
// ajv-formats is CJS; under NodeNext the default import is typed as the
// module namespace rather than the callable it is at runtime.
(addFormats as unknown as (instance: Ajv) => unknown)(ajv);
function assertSchemaValid(
  schema: Record<string, unknown>,
  value: unknown,
  what: string,
): void {
  const checker: ValidateFunction = ajv.compile(schema);
  try {
    if (!checker(value)) {
      const details = (checker.errors ?? [])
        .slice(0, 5)
        .map((error) => {
          const offender =
            typeof error.params?.additionalProperty === "string"
              ? ` ("${error.params.additionalProperty}")`
              : "";
          return `${error.instancePath || what} ${error.message ?? "invalid"}${offender}`;
        })
        .join("; ");
      throw new HttpError(400, "BAD_USER_INPUT", `Invalid ${what}: ${details}`);
    }
  } finally {
    ajv.removeSchema(schema);
  }
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
    ...(tool.operation === "create" && entity?.elicitOnCreate
      ? { _meta: { ui: { resourceUri: ENTITY_CONFIGURATION_APP_URI } } }
      : {}),
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
  if (canReadClassifiedColumns(table?.source?.authorization, session))
    return entity.fields;
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
    [...entity.displayTemplate.matchAll(/{{\s*([\w.]+)\s*}}/g)].every(
      ([, key]) => visible.has(key!.split(".")[0]!),
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
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export const __okForTests = ok;

function configurationAppResult(
  payload: unknown,
  token: string,
  displayName: string,
): ToolResult {
  const configurationUrl = `${callbackOrigin()}${ENTITY_CONFIGURATION_PATH}/${token}`;
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    _meta: {
      configurationUrl,
      displayName,
    },
  };
}

export const __configurationAppResultForTests = configurationAppResult;

/**
 * Errors are returned as tool results rather than protocol errors: a model
 * that gets "FORBIDDEN: not authorized to delete Relation" back as content can
 * adapt, where a transport-level failure just terminates the call. The code
 * vocabulary is the CRUD layer's, unchanged.
 *
 * The body is the same object REST answers with, carried three ways: as
 * `structuredContent` for clients that read it typed, mirrored as JSON text
 * for clients that only render text, and summarised in one line first so a
 * model sees the code and the retry meaning before anything else. The
 * summary is derived from the same fields, so it cannot contradict them.
 */
function failed(error: unknown): ToolResult {
  const { body } = toHttpError(error);
  return {
    content: [
      { type: "text", text: failureSummary(body.error) },
      { type: "text", text: JSON.stringify(body, null, 2) },
    ],
    structuredContent: body,
    isError: true,
  };
}

export const __failedForTests = failed;

function requireArguments(args: unknown): Record<string, unknown> {
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

/**
 * Guard a create/update that would make a derived-tool definition VISIBLE
 * (`visibleWhen` satisfied on the resulting row): the execution chain and its
 * connections are validated first, so the audience never receives a tool
 * whose first call is a guaranteed misconfiguration failure. Writes that
 * leave the row invisible — drafts, and un-publishing — pass untouched.
 */
async function assertPublishableWrite(
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

async function invokeTool(
  tool: CatalogTool,
  entity: CatalogEntity | undefined,
  table: GeneratedTable,
  tables: Map<string, GeneratedTable>,
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args = requireArguments(rawArgs);

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
      const result = await listGeneratedEntities(db, session, {
        table: table.name,
        ...(typeof args.first === "number" ? { limit: args.first } : {}),
        ...(typeof args.after === "string" ? { cursor: args.after } : {}),
        ...(filter ? { filter } : {}),
        ...(sort ? { sort } : {}),
        includeTotalCount: true,
      });
      return ok({
        items: result.rows.map((row) =>
          serializeRowForEntity(entity, table, row),
        ),
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
        ? Object.fromEntries(
            Object.entries(values).filter(([key]) => key !== elicitField),
          )
        : values;
      assertDeclaredProperties(tool.inputSchema, modelValues, "field");
      assertWritableValues(modelValues, entity, table, session);
      await assertPublishableWrite(db, session, tables, table, values);
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
        (
          tool.inputSchema.properties as
            | Record<string, Record<string, unknown>>
            | undefined
        )?.values,
        values,
        "field",
      );
      assertWritableValues(values, entity, table, session);
      await assertPublishableWrite(db, session, tables, table, values, id);
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
      if (!deleted)
        throw new HttpError(404, "NOT_FOUND", "Resource not found.");
      return ok({ deleted: true });
    }
  }
}

function operationMayInvoke(tool: Catalog["operationTools"][number], session: TrustedSessionContext): boolean {
  if (tool.auth.mode === "public") return true;
  if (session.credential === "api-key" && (tool.auth.scopes ?? []).length > 0) return false;
  const roles = new Set(session.roles);
  const scopes = new Set(session.oauthScopes ?? []);
  return tool.auth.roles.some((role) => roles.has(role)) &&
    (tool.auth.scopes ?? []).every((scope) => scopes.has(scope));
}

function buildServer(
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext,
  modules: readonly RuntimeModule[] | undefined,
  onDerivedDefinitionChanged?: (table: string, tenantId: string | null) => void,
  /**
   * Whether this server lives across requests. The guide-before-create gate
   * needs session memory of the guide call, so it enforces only here — a
   * stateless single-shot request could never satisfy it.
   */
  stateful = false,
): Server {
  const guidesCalled = new Set<string>();
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
    instructions:
      (catalogDerivedTools.some((entry) => entry.connect)
        ? `${INSTRUCTIONS} This server's OAuth redirect (callback) URL is ` +
          `${callbackOrigin()}${ENTITY_OAUTH_CALLBACK_PATH} — when setting up a provider ` +
          `OAuth client, give the person this exact URL to register; never ask them what it is.`
        : INSTRUCTIONS) +
      catalogGuideTools
        .filter((guide) => guide.requireBeforeCreate)
        .map(
          (guide) =>
            ` Before creating a ${guide.entity ?? "definition"}, call ${guide.name} and ` +
            `follow it — it is the fixed process and overrides any cached local instructions.`,
        )
        .join(""),
  });
  const tables = tablesByName();
  const operations = modules === undefined ? new Map() : bindOperationHandlers(modules);

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
        ...(supportsMcpApp(server)
          ? [
              {
                uri: ENTITY_CONFIGURATION_APP_URI,
                name: "secure-configuration-app",
                title: "Secure configuration app",
                description:
                  "Client-only UI for values that must not pass through the model.",
                mimeType: MCP_APP_MIME_TYPE,
              },
            ]
          : []),
      ],
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      ...resourcesForSession(session, tables).map((resource) => ({
        uriTemplate: resource.templateUri,
        name: resource.templateName,
        description: resource.templateDescription,
        mimeType: JSON_MIME_TYPE,
      })),
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === ENTITY_CONFIGURATION_APP_URI) {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: MCP_APP_MIME_TYPE,
            text: await renderConfigurationApp(),
            _meta: {
              ui: {
                csp: { resourceDomains: [callbackOrigin()] },
                prefersBorder: true,
              },
            },
          },
        ],
      };
    }
    const entries = entitiesForSession(session, tables);
    let payload: unknown;
    if (request.params.uri === ENTITY_CATALOG_URI) {
      payload = describeCatalogResource(entries);
    } else if (request.params.uri.startsWith(`${ENTITY_CATALOG_URI}/`)) {
      const entry = entries.find(
        ({ entity }) => entityResourceUri(entity) === request.params.uri,
      );
      if (!entry)
        throw new McpError(ErrorCode.InvalidParams, "Resource not found.");
      payload = describeEntityResource(entry, entries, tables, session);
    } else {
      const uri = request.params.uri;
      const readable = resourcesForSession(session, tables);
      const direct = readable.find((resource) => resource.uri === uri);
      if (direct) {
        const table = tables.get(direct.table);
        if (!table)
          throw new McpError(ErrorCode.InvalidParams, "Resource not found.");
        const result = await listGeneratedEntities(db, session, {
          table: table.name,
          limit: RESOURCE_READ_LIMIT,
        });
        payload = result.rows.map((row) =>
          serializeRowForEntity(entityForTable(direct.table), table, row),
        );
      } else {
        const templated = readable.find((resource) =>
          uri.startsWith(`${resource.uri}/`),
        );
        const id = templated ? uri.slice(templated.uri.length + 1) : "";
        const table = templated ? tables.get(templated.table) : undefined;
        if (!templated || !table || id.length === 0 || id.includes("/")) {
          throw new McpError(ErrorCode.InvalidParams, "Resource not found.");
        }
        const row = await getGeneratedEntity(db, session, {
          table: table.name,
          id,
        });
        if (!row)
          throw new McpError(ErrorCode.InvalidParams, "Resource not found.");
        payload = serializeRowForEntity(
          entityForTable(templated.table),
          table,
          row,
        );
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

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [],
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...toolsForSession(session, tables).map(({ tool, entity }) =>
        describeTool(tool, entity, tables.get(tool.table), session),
      ),
      ...catalogDerivedTools
        .filter(
          (entry) => entry.connect && sessionInAudience(entry, session.roles),
        )
        .map((entry) => ({
          name: entry.connect!.name,
          description: entry.connect!.description,
          inputSchema: {
            type: "object",
            properties: {
              tool: {
                type: "string",
                description:
                  "Name of the tool to create your personal connection for.",
              },
            },
            required: ["tool"],
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
          },
        })),
      ...catalogDerivedTools
        .filter(
          (entry) =>
            entry.personalization && sessionInAudience(entry, session.roles),
        )
        .map((entry) => ({
          name: entry.personalization!.set.name,
          description: entry.personalization!.set.description,
          inputSchema: {
            type: "object",
            properties: {
              tool: {
                type: "string",
                description:
                  "Name of the tool the instruction is for. Omit to apply it to all tools.",
              },
              instruction: {
                type: "string",
                maxLength: 500,
                description:
                  "The person's standing instruction, in their own words. Empty clears it.",
              },
            },
            required: ["instruction"],
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
          },
        })),
      ...catalogDerivedTools
        .filter(
          (entry) =>
            entry.dryRun &&
            entry.execution &&
            entry.dryRun.roles.some((role) =>
              (session.roles ?? []).includes(role),
            ),
        )
        .map((entry) => ({
          name: entry.dryRun!.name,
          description: entry.dryRun!.description,
          inputSchema: {
            type: "object",
            properties: {
              tool: {
                type: "string",
                description:
                  "Name of the tool whose provider requests to compose. Drafts count too.",
              },
              arguments: {
                type: "object",
                description:
                  "The arguments the composed call would be made with.",
              },
            },
            required: ["tool"],
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
          },
        })),
      ...guideToolsForSession(session).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
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
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      })),
      ...testToolsForSession(session, tables).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              format: "uuid",
              description: `Identifier of the ${tool.entity} to verify.`,
            },
          },
          required: ["id"],
          additionalProperties: false,
        },
        // Read-only from the deployment's perspective: the probe is a
        // provider read the definition itself declares harmless.
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      })),
      // Derived tools: definition rows projected per session and per tenant.
      ...(await derivedToolsForSession(db, session, tables)).map((tool) => ({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.readOnly === true,
          destructiveHint: tool.destructive === true,
          idempotentHint: tool.readOnly === true,
        },
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
      ...catalog.operationTools
        .filter((tool) => operations.has(tool.key) && operationMayInvoke(tool, session))
        .map((tool) => ({
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

    const operationTool = catalog.operationTools.find((tool) => tool.name === name);
    if (operationTool) {
      if (!operations.has(operationTool.key) || !operationMayInvoke(operationTool, session)) {
        return failed(new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`));
      }
      try {
        const result = await invokeOperation(
          operations.get(operationTool.key)!,
          request.params.arguments ?? {},
          { db, session, transport: "mcp" },
        );
        return ok(result.value);
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

    const connectEntry = catalogDerivedTools.find(
      (entry) => entry.connect?.name === name,
    );
    if (connectEntry) {
      if (
        !sessionInAudience(connectEntry, session.roles) ||
        !connectEntry.execution
      ) {
        return failed(
          new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`),
        );
      }
      try {
        const execution = connectEntry.execution;
        const toolArg = (
          request.params.arguments as Record<string, unknown> | undefined
        )?.tool;
        if (typeof toolArg !== "string" || toolArg.length === 0) {
          throw new HttpError(
            400,
            "VALIDATION",
            'Argument "tool" is required.',
          );
        }
        // Only a PROJECTED row can start a connection: projection already
        // enforces publication and audience, so an unpublished or invisible
        // definition answers exactly like a nonexistent one. Callers often
        // hold the defining row's KEY rather than the derived name, so the
        // input is normalized through the same derivation.
        const wantedName = deriveToolName(toolArg) ?? toolArg;
        const projectedTools = await derivedToolsForSession(
          db,
          session,
          tables,
        );
        const target = projectedTools.find(
          (tool) =>
            tool.name === wantedName && tool.table === connectEntry.table,
        );
        if (!target) {
          throw new HttpError(
            404,
            "NOT_FOUND",
            `No connectable tool "${toolArg}".`,
          );
        }
        const definitionRow = await runtimeRowByFilter(
          db,
          session,
          tables,
          target.table,
          {
            id: target.rowId,
          },
        );
        if (!definitionRow)
          throw new HttpError(
            404,
            "NOT_FOUND",
            `No connectable tool "${toolArg}".`,
          );

        // The provider derives from the target's exact chain; the caller
        // chooses nothing. Exactly one distinct provider per connection.
        const providerIds = new Set<string>();
        for (const binding of orderedBindings(
          definitionRow,
          execution.bindingsField,
        )) {
          const operationId = binding[execution.operationRef];
          const operationRow =
            typeof operationId === "string"
              ? await runtimeRowByFilter(
                  db,
                  session,
                  tables,
                  execution.operationTable,
                  {
                    id: operationId,
                  },
                )
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
        }
        if (providerIds.size === 0) {
          throw new HttpError(
            400,
            "NOT_CONNECTABLE",
            "This definition names no provider.",
          );
        }
        // A canonical definition may span providers; the person connects
        // them ONE AT A TIME through this same tool — each pass mints the
        // consent for the first provider still missing a usable sign-in,
        // and a call with everything in place answers connected. Providers
        // on shared tenant credentials need no personal sign-in and are
        // skipped.
        const signInProviders: {
          id: string;
          row: Record<string, unknown>;
          auth: Record<string, unknown>;
        }[] = [];
        for (const candidateId of providerIds) {
          const candidateRow = await runtimeRowByFilter(
            db,
            session,
            tables,
            execution.providerTable,
            { id: candidateId },
          );
          const candidateAuth = (candidateRow?.auth ?? null) as Record<
            string,
            unknown
          > | null;
          if (
            candidateRow &&
            candidateAuth?.profile === "oauth2AuthorizationCode"
          ) {
            signInProviders.push({
              id: candidateId,
              row: candidateRow,
              auth: candidateAuth,
            });
          }
        }
        if (signInProviders.length === 0) {
          throw new HttpError(
            400,
            "NOT_CONNECTABLE",
            "This definition's provider does not support sign-in connections.",
          );
        }

        // Resolve every projected definition once, then reuse the per-provider
        // scope union below. Keeping this outside the provider loop avoids a
        // providers × definitions × bindings query multiplier on connect.
        const requiredScopesByProvider = new Map<string, Set<string>>();
        for (const projected of projectedTools) {
          if (projected.table !== connectEntry.table) continue;
          const row =
            projected.rowId === target.rowId
              ? definitionRow
              : await runtimeRowByFilter(db, session, tables, projected.table, {
                  id: projected.rowId,
                });
          if (!row) continue;
          try {
            const rowProviders = new Set<string>();
            const rowScopes: string[] = [];
            for (const binding of orderedBindings(
              row,
              execution.bindingsField,
            )) {
              const operationId = binding[execution.operationRef];
              const operationRow =
                typeof operationId === "string"
                  ? await runtimeRowByFilter(
                      db,
                      session,
                      tables,
                      execution.operationTable,
                      { id: operationId },
                    )
                  : null;
              if (!operationRow) throw new Error("unresolved binding");
              const providerId = operationRow[execution.providerRef];
              if (typeof providerId === "string") rowProviders.add(providerId);
              if (Array.isArray(operationRow.requiredScopes)) {
                for (const scope of operationRow.requiredScopes as unknown[]) {
                  if (typeof scope === "string") rowScopes.push(scope);
                }
              }
            }
            if (rowProviders.size !== 1) continue;
            const [providerId] = rowProviders;
            if (!providerId) continue;
            const providerScopes =
              requiredScopesByProvider.get(providerId) ?? new Set<string>();
            for (const scope of rowScopes) providerScopes.add(scope);
            requiredScopesByProvider.set(providerId, providerScopes);
          } catch {
            // A malformed sibling definition cannot block this sign-in.
          }
        }

        const connectedProviders: string[] = [];
        for (const [providerIndex, signIn] of signInProviders.entries()) {
          const providerRowId = signIn.id;

          // Scopes derive from the UNION of every projected definition on this
          // provider, not the entry-point tool alone: the person signs in once
          // per provider, and a consent shaped by one read tool would mint a
          // token every write tool answers 403 with — leaving over-broadening
          // that read tool as the only "fix" (seen live). A sibling row whose
          // chain does not resolve is skipped: publication validation guards
          // new rows, and a broken legacy row must not block sign-in.
          const requiredScopes =
            requiredScopesByProvider.get(providerRowId) ?? new Set<string>();
          const providerRow = signIn.row;
          const auth = signIn.auth;
          const scope_ = connectionScopeOf(auth);
          if (
            scope_ === "tenant" &&
            !connectEntry.connect!.roles.some((role) =>
              (session.roles ?? []).includes(role),
            )
          ) {
            throw new HttpError(
              403,
              "FORBIDDEN",
              "This shared tenant connection requires an explicitly delegated organization role.",
            );
          }
          const authorizationUrl = auth.authorizationUrl;
          const tokenUrl = auth.tokenUrl;
          if (
            typeof authorizationUrl !== "string" ||
            typeof tokenUrl !== "string"
          ) {
            throw new HttpError(
              400,
              "PROVIDER_MISCONFIGURED",
              "The provider declares no authorization and token endpoints.",
            );
          }
          const adapterScopes = Array.isArray(auth.scopes)
            ? (auth.scopes as unknown[]).filter(
                (scope): scope is string => typeof scope === "string",
              )
            : [];
          const scopes =
            requiredScopes.size > 0
              ? [...requiredScopes].filter(
                  (scope) =>
                    adapterScopes.length === 0 || adapterScopes.includes(scope),
                )
              : adapterScopes;
          // An empty intersection is a definition mismatch, not a scopeless
          // provider: authorizing with no scopes would mint a token the tool
          // cannot use (seen live as a provider "invalid scope" page).
          if (requiredScopes.size > 0 && scopes.length === 0) {
            throw new HttpError(
              400,
              "SCOPES_NOT_ALLOWED",
              `This definition requires scopes the ${execution.providerEntity} does not allow: ` +
                `${[...requiredScopes].join(", ")}. Add them to its allowed scopes first.`,
            );
          }

          const connectionRows = await runtimeRowsByFilter(
            db,
            session,
            tables,
            execution.connectionTable,
            { [execution.connectionProviderRef]: providerRowId },
          );
          const existingForScope =
            scope_ === "user"
              ? connectionRows.find((row) => row.ownerUserId === session.userId)
              : connectionRows.find((row) => !row.ownerUserId);
          const existingValues = (existingForScope?.[
            execution.connectionValuesField
          ] ?? null) as Record<string, unknown> | null;
          // An existing sign-in only satisfies the request while its granted
          // scopes still cover the definition's CURRENT requirements. When a
          // scope evolved after consent, silently reusing the old token
          // guarantees a provider 403 — the fix is a fresh approval, minted
          // below, whose callback replaces the stored tokens in place.
          const hasExistingTokens = Boolean(
            existingForScope &&
            existingValues?.accessToken &&
            (!accessTokenNeedsRefresh(existingValues) ||
              looksLikeStoredSecret(existingValues.refreshToken)),
          );
          if (
            hasExistingTokens &&
            scopesCovered(scopes, existingValues?.grantedScopes)
          ) {
            connectedProviders.push(String(providerRow.name ?? providerRowId));
            continue;
          }
          const reconsent = hasExistingTokens;
          const tenantConnection = connectionRows.find(
            (row) => !row.ownerUserId,
          );
          const secretScope =
            entityForTable(execution.connectionTable)?.elicitOnCreate
              ?.sourceTable ?? execution.providerTable;
          const credentials = readClientCredentials(
            tenantConnection,
            execution.connectionValuesField,
            secretScope,
          );

          // Provider OAuth endpoints are routinely per-tenant
          // (https://{subdomain}.provider.com/...): placeholders resolve from
          // the tenant connection's NON-secret values, like base URLs do —
          // including encrypted-at-rest values whose field is not classified
          // secret. A placeholder that reaches for a secret-classified field
          // fails with the classification named, not as a data-entry gap.
          const tenantUrlValues = urlSafeConnectionValues(
            tenantConnection,
            execution.connectionValuesField,
            providerRow[
              entityForTable(execution.connectionTable)?.elicitOnCreate
                ?.definitionsField ?? ""
            ],
            secretScope,
          );
          const resolvedAuthorizationUrl = resolveTemplate(
            authorizationUrl,
            tenantUrlValues.plain,
            "auth.authorizationUrl",
            tenantUrlValues.secretKeys,
          );
          const resolvedTokenUrl = resolveTemplate(
            tokenUrl,
            tenantUrlValues.plain,
            "auth.tokenUrl",
            tenantUrlValues.secretKeys,
          );

          const handoff = await mintAuthorization({
            db,
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
            connectionScope: scope_,
            authorizationUrl: resolvedAuthorizationUrl,
          });
          return ok({
            action: "authorize",
            provider: String(providerRow.name ?? providerRowId),
            ...(signInProviders.length > 1
              ? {
                  providerProgress: `${providerIndex + 1} of ${signInProviders.length}`,
                }
              : {}),
            scopes,
            authorizationUrl: handoff.authorizationUrl,
            expiresInSeconds: handoff.expiresInSeconds,
            instructions:
              (reconsent
                ? "The required permissions changed since this connection was approved; a " +
                  "fresh approval replaces the stored sign-in in place. "
                : "") +
              (signInProviders.length > 1
                ? "This definition spans multiple providers; each is connected in turn. "
                : "") +
              "Ask the person to open authorizationUrl in their browser and approve access. " +
              "Then wait by checking, not by asking: call this tool again every ten seconds " +
              "or so (sleep between checks if you can) — it continues with the next provider " +
              "or answers connected once every sign-in has landed. Only if nothing has " +
              "landed after about three minutes, ask the person to tell you when they are " +
              "done.",
          });
        }
        return ok({
          connected: true,
          providers: connectedProviders,
          message:
            connectedProviders.length > 1
              ? "All providers for this tool are signed in. Just call the tool."
              : "Your personal connection already exists. Just call the tool.",
        });
      } catch (error) {
        return failed(error);
      }
    }

    const personalizationEntry = catalogDerivedTools.find(
      (entry) => entry.personalization?.set.name === name,
    );
    if (personalizationEntry) {
      if (
        !sessionInAudience(personalizationEntry, session.roles) ||
        !personalizationEntry.personalization
      ) {
        return failed(
          new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`),
        );
      }
      try {
        const personalization = personalizationEntry.personalization;
        const args = requireArguments(request.params.arguments);
        const instruction =
          typeof args.instruction === "string" ? args.instruction.trim() : null;
        if (instruction === null) {
          throw new HttpError(
            400,
            "VALIDATION",
            'Argument "instruction" is required; an empty string clears the stored one.',
          );
        }
        if (instruction.length > 500) {
          throw new HttpError(
            400,
            "VALIDATION",
            "Keep the instruction under 500 characters — it rides along on every tool listing.",
          );
        }
        // Optional target tool; absent means the instruction applies to all.
        let serviceRowId: string | null = null;
        let appliesTo = "all tools";
        if (typeof args.tool === "string" && args.tool.length > 0) {
          const wanted = deriveToolName(args.tool) ?? args.tool;
          const projected = (
            await derivedToolsForSession(db, session, tables)
          ).find(
            (tool) =>
              tool.name === wanted && tool.table === personalizationEntry.table,
          );
          if (!projected) {
            throw new HttpError(
              404,
              "NOT_FOUND",
              `No tool "${args.tool}" to set an instruction for.`,
            );
          }
          serviceRowId = projected.rowId;
          appliesTo = wanted;
        }
        const preferenceTable = tables.get(personalization.table);
        if (!preferenceTable) {
          throw new HttpError(
            500,
            "INTERNAL",
            "Preference table is missing from the manifest.",
          );
        }
        // The row is the CALLER's own, bound to them by the runtime — the
        // same ownership model as personal connections.
        const mine = (
          await listGeneratedEntitiesForTable(db, session, preferenceTable, {
            limit: 100,
            fixedWhere: [{ column: "owner_user_id", value: session.userId }],
          })
        ).rows.map((row) => serializeRow(preferenceTable, row));
        const existing = mine.find(
          (row) => (row[personalization.serviceRef] ?? null) === serviceRowId,
        );
        const writeSession: DbSessionInput = {
          tenantId: session.tenantId as string,
          userId: session.userId as string,
          roles: [],
          groups: [],
          scope: "self",
        };
        if (existing) {
          await updateGeneratedEntityForTable(
            db,
            writeSession,
            preferenceTable,
            String(existing.id),
            {
              [personalization.instructionField]: instruction,
            },
          );
        } else if (instruction.length > 0) {
          await createGeneratedEntityForTable(
            db,
            writeSession,
            preferenceTable,
            {
              key: `pref-${String(session.userId)}-${serviceRowId ?? "all"}`.toLowerCase(),
              name: `Personal instruction (${appliesTo})`,
              ownerUserId: session.userId,
              ...(serviceRowId
                ? { [personalization.serviceRef]: serviceRowId }
                : {}),
              [personalization.instructionField]: instruction,
            },
          );
        }
        // Descriptions changed for this person's sessions; nudge them.
        onDerivedDefinitionChanged?.(
          personalizationEntry.table,
          session.tenantId ?? null,
        );
        return ok({
          saved: instruction.length > 0,
          appliesTo,
          message:
            instruction.length > 0
              ? "Saved. Every assistant this person uses sees it alongside the tool from its next listing."
              : "Cleared.",
        });
      } catch (error) {
        return failed(error);
      }
    }

    const dryRunEntry = catalogDerivedTools.find(
      (entry) => entry.dryRun?.name === name,
    );
    if (dryRunEntry) {
      const allowed = dryRunEntry.dryRun!.roles.some((role) =>
        (session.roles ?? []).includes(role),
      );
      if (!allowed || !dryRunEntry.execution) {
        return failed(
          new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`),
        );
      }
      try {
        const execution = dryRunEntry.execution;
        const args = requireArguments(request.params.arguments);
        const toolArg = args.tool;
        if (typeof toolArg !== "string" || toolArg.length === 0) {
          throw new HttpError(
            400,
            "VALIDATION",
            'Argument "tool" is required.',
          );
        }
        const toolArguments =
          args.arguments &&
          typeof args.arguments === "object" &&
          !Array.isArray(args.arguments)
            ? (args.arguments as Record<string, unknown>)
            : {};

        // Deliberately ungated by visibleWhen: previewing a DRAFT before
        // publishing it is the point of a dry run. The caller's roles gate
        // the tool itself.
        const table = tables.get(dryRunEntry.table);
        if (!table)
          throw new HttpError(404, "NOT_FOUND", `Unknown tool "${toolArg}".`);
        const rows = (
          await listGeneratedEntitiesForTable(db, session, table, {
            limit: DERIVED_TOOLS_ROW_LIMIT,
          })
        ).rows.map((row) => serializeRow(table, row));
        const { visibleWhen: _gate, ...ungated } = dryRunEntry;
        // Accept the defining row's key as well as the derived tool name.
        const wantedName = deriveToolName(toolArg) ?? toolArg;
        const target = derivedToolsFromRows(
          ungated,
          rows,
          new Set(catalog.tools.map((tool) => tool.name)),
          session.roles ?? [],
        ).find((tool) => tool.name === wantedName);
        const definitionRow = target
          ? rows.find((row) => String(row.id ?? "") === target.rowId)
          : undefined;
        if (!target || !definitionRow) {
          throw new HttpError(
            404,
            "NOT_FOUND",
            `No definition provides the tool "${toolArg}".`,
          );
        }
        assertSchemaValid(target.inputSchema, toolArguments, "arguments");

        const requests: Record<string, unknown>[] = [];
        const bindings = orderedBindings(
          definitionRow,
          execution.bindingsField,
        );
        for (const [index, binding] of bindings.entries()) {
          // Selection is part of what a dry run verifies: show WHICH bindings
          // the given arguments route to, and say why the others sit out.
          if (
            !bindingSelected(binding, toolArguments as Record<string, unknown>)
          ) {
            const when = binding.when as Record<string, unknown>;
            requests.push({
              order: index + 1,
              skipped:
                `Not selected by this call: it runs only when ` +
                `${String(when?.field)} is ${JSON.stringify(when?.equals)} or omitted.`,
            });
            continue;
          }
          const notes: string[] = [];
          if (index > 0) {
            notes.push(
              "Values produced by earlier bindings join these inputs at run time; " +
                "placeholders they would resolve may be reported as unresolved here.",
            );
          }
          const operationId = binding[execution.operationRef];
          const operationRow =
            typeof operationId === "string"
              ? await runtimeRowByFilter(
                  db,
                  session,
                  tables,
                  execution.operationTable,
                  {
                    id: operationId,
                  },
                )
              : null;
          if (!operationRow) {
            requests.push({
              order: index + 1,
              problem: `The binding references a missing ${execution.operationEntity}.`,
            });
            continue;
          }
          const providerId = operationRow[execution.providerRef];
          const providerRow =
            typeof providerId === "string"
              ? await runtimeRowByFilter(
                  db,
                  session,
                  tables,
                  execution.providerTable,
                  {
                    id: providerId,
                  },
                )
              : null;
          if (!providerRow) {
            requests.push({
              order: index + 1,
              operation: operationRow.key,
              problem: `The ${execution.operationEntity} references a missing ${execution.providerEntity}.`,
            });
            continue;
          }
          const connectionRows = await runtimeRowsByFilter(
            db,
            session,
            tables,
            execution.connectionTable,
            { [execution.connectionProviderRef]: providerId },
          );
          const tenantConnection = connectionRows.find(
            (row) => !row.ownerUserId,
          );
          if (!tenantConnection) {
            notes.push(
              `No ${execution.connectionEntity} is configured for this ` +
                `${execution.providerEntity}; values it would provide are unresolved.`,
            );
          }
          // Composition resolves URL templates from the tenant row's URL-safe
          // values — plain ones plus encrypted ones whose field is not
          // classified secret; placeholder auth needs no secrets at all.
          const dryRunElicit = entityForTable(
            execution.connectionTable,
          )?.elicitOnCreate;
          const connectionValues = urlSafeConnectionValues(
            tenantConnection,
            execution.connectionValuesField,
            providerRow[dryRunElicit?.definitionsField ?? ""],
            dryRunElicit?.sourceTable ?? execution.providerTable,
          ).plain;
          const providerAuth = (providerRow.auth ?? null) as Record<
            string,
            unknown
          > | null;
          let providerForCompose = providerRow;
          if (providerAuth?.profile === "oauth2AuthorizationCode") {
            providerForCompose = {
              ...providerRow,
              auth: { scheme: "bearer", tokenFrom: "accessToken" },
            };
            notes.push(
              connectionScopeOf(providerAuth) === "user"
                ? "Executing uses the caller's personal sign-in token as the bearer value."
                : "Executing uses the tenant sign-in token as the bearer value.",
            );
          }
          try {
            const composed = await composeBindingRequest({
              binding,
              operationRow,
              providerRow: providerForCompose,
              connectionValues,
              serviceInputs: toolArguments,
              secretScope: execution.connectionTable,
              providerDefinitions:
                providerRow[dryRunElicit?.definitionsField ?? ""],
              mode: "describe",
            });
            requests.push({
              order: index + 1,
              operation: operationRow.key,
              method: composed.method,
              url: composed.url.toString(),
              headers: composed.headers,
              ...(composed.body !== undefined
                ? { body: JSON.parse(composed.body) }
                : {}),
              ...(notes.length > 0 ? { notes } : {}),
            });
          } catch (error) {
            const { body } = toHttpError(error);
            requests.push({
              order: index + 1,
              operation: operationRow.key,
              problem: body.error.message,
              ...(notes.length > 0 ? { notes } : {}),
            });
          }
        }
        return ok({
          tool: toolArg,
          definition: definitionRow.key,
          sent: false,
          requests,
        });
      } catch (error) {
        return failed(error);
      }
    }

    const guideTool = catalogGuideTools.find((tool) => tool.name === name);
    if (guideTool) {
      if (!guideToolsForSession(session).includes(guideTool)) {
        return failed(
          new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`),
        );
      }
      guidesCalled.add(guideTool.name);
      return { content: [{ type: "text", text: guideTool.content }] };
    }

    const discoveryTool = catalogDiscoveryTools.find(
      (tool) => tool.name === name,
    );
    if (discoveryTool) {
      const table = tables.get(discoveryTool.table);
      if (!table || !sessionMayInvoke(table, "get", session)) {
        return failed(
          new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`),
        );
      }
      try {
        const id = (
          request.params.arguments as Record<string, unknown> | undefined
        )?.id;
        if (typeof id !== "string") {
          throw new HttpError(400, "VALIDATION", 'Argument "id" is required.');
        }
        const row = await getGeneratedEntity(db, session, {
          table: table.name,
          id,
        });
        if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found.");
        return ok(await discoverProviderSchema(serializeRow(table, row)));
      } catch (error) {
        return failed(error);
      }
    }

    const testTool = catalogTestTools.find((tool) => tool.name === name);
    if (testTool) {
      const table = tables.get(testTool.table);
      if (!table || !sessionMayInvoke(table, "get", session)) {
        return failed(
          new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`),
        );
      }
      try {
        const id = (
          request.params.arguments as Record<string, unknown> | undefined
        )?.id;
        if (typeof id !== "string") {
          throw new HttpError(400, "VALIDATION", 'Argument "id" is required.');
        }
        const row = await getGeneratedEntity(db, session, {
          table: table.name,
          id,
        });
        if (!row) throw new HttpError(404, "NOT_FOUND", "Resource not found.");
        const serialized = serializeRow(table, row);
        const elicit = entityForTable(testTool.table)?.elicitOnCreate;
        if (!elicit) {
          throw new HttpError(
            400,
            "NOT_TESTABLE",
            `${testTool.entity} declares no elicited configuration to verify.`,
          );
        }
        const sourceId = serialized[elicit.sourceField];
        const sourceRow =
          typeof sourceId === "string"
            ? await runtimeRowByFilter(
                db,
                session,
                tables,
                elicit.sourceTable,
                { id: sourceId },
              )
            : null;
        if (!sourceRow) {
          throw new HttpError(
            400,
            "SOURCE_MISSING",
            `The ${elicit.sourceEntity} this ${testTool.entity} configures does not exist.`,
          );
        }
        // A personal row holds only tokens; URL templates resolve from the
        // tenant sibling's plain configuration, as they do at execution.
        let fallbackPlainValues: Record<string, string> | undefined;
        if (serialized.ownerUserId) {
          const siblings = await runtimeRowsByFilter(
            db,
            session,
            tables,
            testTool.table,
            {
              [elicit.sourceField]: sourceId,
            },
          );
          const tenantSibling = siblings.find(
            (sibling) => !sibling.ownerUserId,
          );
          fallbackPlainValues = Object.fromEntries(
            Object.entries(
              (tenantSibling?.[elicit.into] ?? {}) as Record<string, unknown>,
            )
              .filter(
                ([, value]) =>
                  value !== null &&
                  value !== undefined &&
                  typeof value !== "object",
              )
              .map(([key, value]) => [key, String(value)]),
          );
        }
        return ok(
          await testElicitedRow({
            row: serialized,
            sourceRow,
            elicit,
            table: testTool.table,
            fallbackPlainValues,
          }),
        );
      } catch (error) {
        return failed(error);
      }
    }

    const match = catalog.tools.find((tool) => tool.name === name);
    const table = match ? tables.get(match.table) : undefined;
    // An unknown tool and one the caller may not invoke get the same answer:
    // the listing already omitted both, so distinguishing them would leak
    // which entities exist.
    if (
      !match ||
      !table ||
      !sessionMayInvoke(table, match.operation, session)
    ) {
      // Not a static tool — a derived (row-defined) tool may own the name.
      // Execution of derived tools is a later slice: the definition names an
      // intent, but the connection/execution machinery that fulfils it does
      // not exist yet, so the honest answer is a clear failure, not a stub
      // success an agent would act on.
      if (catalogDerivedTools.length > 0) {
        const derived = (
          await derivedToolsForSession(db, session, tables)
        ).find((tool) => tool.name === name);
        if (derived) {
          const entry = catalogDerivedTools.find(
            (candidate) => candidate.table === derived.table,
          );
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
            const args = (request.params.arguments ?? {}) as Record<
              string,
              unknown
            >;
            assertSchemaValid(derived.inputSchema, args, "arguments");

            const serviceRow = await runtimeRowByFilter(
              db,
              session,
              tables,
              derived.table,
              {
                id: derived.rowId,
              },
            );
            if (!serviceRow)
              throw new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`);

            // Later bindings see earlier outputs alongside the caller's
            // inputs, which is what makes read→act chains expressible. A
            // binding marked optional may fail without failing the call —
            // that is what lets one canonical service span providers and
            // still answer when one of them is down or not yet connected —
            // and every skipped one is reported honestly in `unavailable`.
            const accumulated: Record<string, unknown> = {};
            const unavailable: { binding: number; reason: string }[] = [];
            for (const binding of orderedBindings(
              serviceRow,
              execution.bindingsField,
            )) {
              // A binding the call's selector input does not choose is not
              // part of this call at all — deliberate routing, not an
              // outage, so it does not surface in `unavailable`.
              if (!bindingSelected(binding, args as Record<string, unknown>))
                continue;
              try {
                const operationId = binding[execution.operationRef];
                const operationRow =
                  typeof operationId === "string"
                    ? await runtimeRowByFilter(
                        db,
                        session,
                        tables,
                        execution.operationTable,
                        {
                          id: operationId,
                        },
                      )
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
                    ? await runtimeRowByFilter(
                        db,
                        session,
                        tables,
                        execution.providerTable,
                        {
                          id: providerId,
                        },
                      )
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
                const providerAuth = (providerRow.auth ?? null) as Record<
                  string,
                  unknown
                > | null;
                const elicitScope =
                  entityForTable(execution.connectionTable)?.elicitOnCreate
                    ?.sourceTable ?? execution.providerTable;
                let providerForExecution = providerRow;
                let connectionValues: unknown;
                let secretScope = elicitScope;

                if (
                  providerAuth?.profile === "oauth2AuthorizationCode" &&
                  connectionScopeOf(providerAuth) === "user"
                ) {
                  // Personal mode: execution resolves ONLY the caller's own
                  // connection — another employee's tokens are unreachable by
                  // construction, and their absence is a clear next step.
                  const personal = connectionRows.find(
                    (row) => row.ownerUserId === session.userId,
                  );
                  const personalScope = `${execution.connectionTable}:personal`;
                  let values = (personal?.[execution.connectionValuesField] ??
                    null) as Record<string, unknown> | null;
                  if (!personal || !values?.accessToken) {
                    throw new HttpError(
                      403,
                      "CONNECTION_REQUIRED",
                      `This tool needs your personal ${String(providerRow.name ?? "provider")} ` +
                        `connection. Call ${entry?.connect?.name ?? "the connect tool"} with ` +
                        `{"tool":"${name}"} to start it.`,
                    );
                  }
                  if (
                    accessTokenNeedsRefresh(values) &&
                    looksLikeStoredSecret(values.refreshToken)
                  ) {
                    const keyring = elicitedKeyring();
                    const tenantConnection = connectionRows.find(
                      (row) => !row.ownerUserId,
                    );
                    const credentials = readClientCredentials(
                      tenantConnection,
                      execution.connectionValuesField,
                      elicitScope,
                    );
                    if (!keyring || typeof providerAuth.tokenUrl !== "string") {
                      throw new HttpError(
                        400,
                        "PROVIDER_MISCONFIGURED",
                        "Token refresh is not configured.",
                      );
                    }
                    const tenantUrlValues = urlSafeConnectionValues(
                      tenantConnection,
                      execution.connectionValuesField,
                      providerRow[
                        entityForTable(execution.connectionTable)
                          ?.elicitOnCreate?.definitionsField ?? ""
                      ],
                      elicitScope,
                    );
                    const connectionTableDef = tables.get(
                      execution.connectionTable,
                    );
                    if (!connectionTableDef)
                      throw new HttpError(
                        500,
                        "INTERNAL",
                        "Connection table is missing.",
                      );
                    values = await refreshConnectionRowLocked({
                      db,
                      session,
                      table: connectionTableDef,
                      rowId: String(personal.id),
                      valuesField: execution.connectionValuesField,
                      refresh: async (lockedValues) => {
                        if (!looksLikeStoredSecret(lockedValues.refreshToken))
                          return {};
                        const refreshed = await refreshTokens({
                          tokenUrl: resolveTemplate(
                            providerAuth.tokenUrl as string,
                            tenantUrlValues.plain,
                            "auth.tokenUrl",
                            tenantUrlValues.secretKeys,
                          ),
                          clientId: credentials.clientId,
                          clientSecret: credentials.clientSecret,
                          refreshToken: decryptSecret(
                            keyring,
                            personalScope,
                            "refreshToken",
                            lockedValues.refreshToken,
                          ),
                          egress: Array.isArray(providerRow.egressHosts)
                            ? (providerRow.egressHosts as string[])
                            : [],
                          connectionTable: execution.connectionTable,
                        });
                        return refreshed.values;
                      },
                    });
                  }
                  // The personal connection holds only tokens; tenant-owned
                  // NON-secret configuration (subdomain and friends) still
                  // resolves base-URL and path templates, so merge the tenant
                  // connection's URL-safe half underneath the personal values.
                  // Resolving it HERE keeps the AAD scopes straight: tenant
                  // fields decrypt under the elicitation scope, while the merged
                  // row executes under the personal scope.
                  const tenantConnectionForPlain = connectionRows.find(
                    (row) => !row.ownerUserId,
                  );
                  const tenantUrlSafe = urlSafeConnectionValues(
                    tenantConnectionForPlain,
                    execution.connectionValuesField,
                    providerRow[
                      entityForTable(execution.connectionTable)?.elicitOnCreate
                        ?.definitionsField ?? ""
                    ],
                    elicitScope,
                  );
                  connectionValues = { ...tenantUrlSafe.plain, ...values };
                  secretScope = personalScope;
                  providerForExecution = {
                    ...providerRow,
                    auth: { scheme: "bearer", tokenFrom: "accessToken" },
                  };
                } else {
                  const tenantConnection =
                    connectionRows.find((row) => !row.ownerUserId) ??
                    connectionRows[0];
                  if (!tenantConnection) {
                    throw new HttpError(
                      400,
                      "CONNECTION_MISSING",
                      `No ${execution.connectionEntity} is configured for this ` +
                        `${execution.providerEntity}; an administrator must create one first.`,
                    );
                  }
                  connectionValues =
                    tenantConnection[execution.connectionValuesField];
                  if (providerAuth?.profile === "oauth2AuthorizationCode") {
                    // Tenant-scoped sign-in: one consent covers the tenant; the
                    // tokens live on the tenant connection and execute as bearer.
                    let tenantValues = (connectionValues ?? null) as Record<
                      string,
                      unknown
                    > | null;
                    if (!tenantValues?.accessToken) {
                      throw new HttpError(
                        403,
                        "CONNECTION_REQUIRED",
                        `This provider needs a one-time sign-in for the whole tenant. ` +
                          `An administrator calls ${entry?.connect?.name ?? "the connect tool"} ` +
                          `with {"tool":"${name}"} and approves at the provider.`,
                      );
                    }
                    if (
                      accessTokenNeedsRefresh(tenantValues) &&
                      looksLikeStoredSecret(tenantValues.refreshToken)
                    ) {
                      const keyring = elicitedKeyring();
                      const credentials = readClientCredentials(
                        tenantConnection,
                        execution.connectionValuesField,
                        elicitScope,
                      );
                      const connectionTableDef = tables.get(
                        execution.connectionTable,
                      );
                      if (
                        !keyring ||
                        !connectionTableDef ||
                        typeof providerAuth.tokenUrl !== "string"
                      ) {
                        throw new HttpError(
                          400,
                          "PROVIDER_MISCONFIGURED",
                          "Tenant token refresh is not configured.",
                        );
                      }
                      const tenantUrlValues = urlSafeConnectionValues(
                        tenantConnection,
                        execution.connectionValuesField,
                        providerRow[
                          entityForTable(execution.connectionTable)
                            ?.elicitOnCreate?.definitionsField ?? ""
                        ],
                        elicitScope,
                      );
                      tenantValues = await refreshConnectionRowLocked({
                        db,
                        session,
                        table: connectionTableDef,
                        rowId: String(tenantConnection.id),
                        valuesField: execution.connectionValuesField,
                        refresh: async (lockedValues) => {
                          if (!looksLikeStoredSecret(lockedValues.refreshToken))
                            return {};
                          const refreshed = await refreshTokens({
                            tokenUrl: resolveTemplate(
                              providerAuth.tokenUrl as string,
                              tenantUrlValues.plain,
                              "auth.tokenUrl",
                              tenantUrlValues.secretKeys,
                            ),
                            clientId: credentials.clientId,
                            clientSecret: credentials.clientSecret,
                            refreshToken: decryptSecret(
                              keyring,
                              `${execution.connectionTable}:personal`,
                              "refreshToken",
                              lockedValues.refreshToken,
                            ),
                            egress: Array.isArray(providerRow.egressHosts)
                              ? (providerRow.egressHosts as string[])
                              : [],
                            connectionTable: execution.connectionTable,
                          });
                          return refreshed.values;
                        },
                      });
                    }
                    // The row mixes AAD scopes: elicited fields were encrypted
                    // under the elicitation scope, tokens under the personal
                    // scope. Resolve the elicited URL-safe half here and keep
                    // only the token fields for the personal-scope execution —
                    // bearer execution never needs the OAuth client secrets.
                    const definitions =
                      providerRow[
                        entityForTable(execution.connectionTable)
                          ?.elicitOnCreate?.definitionsField ?? ""
                      ];
                    const tenantUrlSafe = urlSafeConnectionValues(
                      tenantConnection,
                      execution.connectionValuesField,
                      definitions,
                      elicitScope,
                    );
                    const elicitedKeys = definitionFieldKeys(definitions);
                    connectionValues = {
                      ...tenantUrlSafe.plain,
                      ...Object.fromEntries(
                        Object.entries(tenantValues).filter(
                          ([key]) => !elicitedKeys.has(key),
                        ),
                      ),
                    };
                    secretScope = `${execution.connectionTable}:personal`;
                    providerForExecution = {
                      ...providerRow,
                      auth: { scheme: "bearer", tokenFrom: "accessToken" },
                    };
                  }
                }

                const operationScopes = Array.isArray(
                  operationRow.requiredScopes,
                )
                  ? operationRow.requiredScopes.filter(
                      (scope): scope is string => typeof scope === "string",
                    )
                  : [];
                const grantedScopes =
                  connectionValues && typeof connectionValues === "object"
                    ? (connectionValues as Record<string, unknown>)
                        .grantedScopes
                    : undefined;
                if (!scopesCovered(operationScopes, grantedScopes)) {
                  throw new HttpError(
                    403,
                    "REAUTHORIZATION_REQUIRED",
                    `The connection does not cover required scopes: ${operationScopes.join(", ")}.`,
                  );
                }

                const outputs = await executeBinding({
                  binding,
                  operationRow,
                  providerRow: providerForExecution,
                  connectionValues,
                  serviceInputs: { ...args, ...accumulated },
                  secretScope,
                  providerDefinitions:
                    providerRow[
                      entityForTable(execution.connectionTable)?.elicitOnCreate
                        ?.definitionsField ?? ""
                    ],
                });
                mergeOutputs(accumulated, outputs);
              } catch (error) {
                if (binding.optional !== true) throw error;
                unavailable.push({
                  binding: Number(binding.order ?? 0),
                  reason: toHttpError(error).body.error.message,
                });
              }
            }
            return ok(
              unavailable.length > 0
                ? { ...accumulated, unavailable }
                : accumulated,
            );
          } catch (error) {
            return failed(error);
          }
        }
      }
      return failed(new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`));
    }
    const entity = catalog.entities.find(
      (item) => item.entity === match.entity,
    );
    // The "call this first" a description cannot enforce: creating the
    // guide's own entity in a session that has not read the guide is refused
    // with the guide named — agents carrying cached local procedures skip
    // voluntary guidance, and the process must be load-bearing. Stateful
    // sessions only; a stateless single shot has no memory to satisfy it.
    if (stateful && match.operation === "create") {
      const gatingGuide = catalogGuideTools.find(
        (guide) =>
          guide.requireBeforeCreate &&
          guide.table === match.table &&
          !guidesCalled.has(guide.name) &&
          guideToolsForSession(session).includes(guide),
      );
      if (gatingGuide) {
        return failed(
          new HttpError(
            409,
            "GUIDE_REQUIRED",
            `Call ${gatingGuide.name} first and follow it — it is the fixed process for ` +
              `this setup, and it overrides any cached local instructions or memories.`,
          ),
        );
      }
    }
    try {
      let callArguments = request.params.arguments;
      if (match.operation === "create" && entity?.elicitOnCreate) {
        const elicit = entity.elicitOnCreate;
        const modelArguments = {
          ...((callArguments ?? {}) as Record<string, unknown>),
        };
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
        // Definitional fail-fast: a URL template reaching for a
        // secret-classified field can never resolve, so refuse BEFORE the
        // person is asked to fill a secure form for a connection that cannot
        // work. The error names the misclassified field and the fix.
        if (sourceRow) {
          const secretClassified = secretFieldKeys(
            sourceRow[elicit.definitionsField],
          );
          for (const { context, template } of providerUrlTemplates(sourceRow)) {
            for (const key of templatePlaceholders(template)) {
              if (secretClassified.has(key)) {
                throw new HttpError(
                  400,
                  "SECRET_IN_URL_TEMPLATE",
                  `${secretUrlPlaceholderError(key, context).message} Fix the ` +
                    `${elicit.sourceEntity} definition first — nothing has been asked ` +
                    `of the person yet.`,
                );
              }
            }
          }
        }
        const sourceAuth = sourceRow?.auth as
          | Record<string, unknown>
          | null
          | undefined;
        const messagePrefix =
          sourceAuth?.profile === "oauth2AuthorizationCode"
            ? `Before entering these values, register this exact redirect URL on the ` +
              `provider's OAuth client: ${callbackOrigin()}${ENTITY_OAUTH_CALLBACK_PATH}`
            : undefined;
        try {
          callArguments = await collectElicitedValues({
            server,
            elicit,
            sourceRow,
            values: modelArguments,
            relatedRequestId: extra.requestId,
            ...(messagePrefix ? { messagePrefix } : {}),
          });
        } catch (error) {
          const reason = elicitationFallback(error);
          if (!reason || !sourceRow) throw error;
          // The in-band form did not happen — hand the person a browser URL
          // to the same form instead of dead-ending the setup.
          const definitions = Array.isArray(sourceRow[elicit.definitionsField])
            ? (sourceRow[elicit.definitionsField] as Record<string, unknown>[])
            : [];
          const minted = await mintConfiguration({
            db,
            tenantId: session.tenantId as string,
            userId: session.userId as string,
            table: table.name,
            elicit,
            modelValues: modelArguments,
            definitions,
            displayName: String(
              sourceRow.name ?? entity?.entity ?? "this record",
            ),
            messagePrefix,
          });
          const listToolName = catalog.tools.find(
            (candidate) =>
              candidate.table === match.table && candidate.operation === "list",
          )?.name;
          const continuation = {
            action: "configure",
            status: "awaiting_person",
            expiresInSeconds: minted.expiresInSeconds,
            // Machine-readable continuation: the record exists once the
            // person saved the form; this is how to observe that.
            ...(listToolName ? { resumeWith: listToolName } : {}),
          };
          const waitInstruction =
            " Then wait by checking, not by asking: poll resumeWith every ten " +
            "seconds or so — the record exists once they have saved. Only if " +
            "nothing has appeared after about three minutes, ask the person to tell " +
            "you when they are done.";
          const prefix =
            reason === "timeout"
              ? "The secure form expired before it was completed — anything typed into it was NOT saved. "
              : "The secure form could not be completed in this client. ";

          if (supportsMcpApp(server)) {
            return configurationAppResult(
              {
                ...continuation,
                instructions:
                  prefix +
                  "The client has received a private MCP App for the secure form; the " +
                  "URL is not exposed to this chat. The app also offers an external-browser fallback." +
                  waitInstruction,
              },
              minted.token,
              String(sourceRow.name ?? entity?.entity ?? "this record"),
            );
          }

          return ok({
            ...continuation,
            externalUrl: configurationWebUrl(),
            instructions:
              prefix +
              "This client cannot render MCP Apps. Ask the person to open externalUrl; " +
              "it is the stable, signed-in KERN form and contains no bearer handoff token." +
              waitInstruction,
          });
        }
        // Verify the accepted values against the provider BEFORE anything is
        // stored — the same three checks test_connection runs later, so a
        // wrong subdomain or refused credential fails HERE, not on the first
        // real call. What is honestly unverifiable (no probe declared,
        // sign-in credentials before consent) reports skipped and saves.
        const storedValues = (
          callArguments as Record<string, unknown> | undefined
        )?.[elicit.into];
        if (sourceRow && storedValues && typeof storedValues === "object") {
          const report = await testElicitedRow({
            row: { [elicit.into]: storedValues },
            sourceRow,
            elicit,
            table: table.name,
          });
          if (!report.ok) {
            throw new HttpError(
              400,
              "CONNECTION_REJECTED",
              `Nothing was created — the entered configuration failed verification ` +
                `against ${report.source}: ${failedCheckSummary(report)} ` +
                `Run the create again so the person can correct the values.`,
            );
          }
        }
      }
      {
        // Validate what the MODEL sent against the advertised schema — before
        // elicited values join, since those are server-set and outside it.
        const modelSent = (request.params.arguments ?? {}) as Record<
          string,
          unknown
        >;
        const elicitField = entity?.elicitOnCreate?.into;
        const toValidate =
          match.operation === "create" && elicitField
            ? Object.fromEntries(
                Object.entries(modelSent).filter(
                  ([key]) => key !== elicitField,
                ),
              )
            : modelSent;
        assertSchemaValid(match.inputSchema, toValidate, "arguments");
      }
      const outcome = await invokeTool(
        match,
        entity,
        table,
        tables,
        db,
        session,
        callArguments,
      );
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
  options: { db?: OpenShapeForgeDatabase | undefined; modules?: readonly RuntimeModule[] } = {},
): void {
  // The transport exists when EITHER surface has something to advertise; a
  // deployment with connectors but no MCP-exposed entity still needs it.
  if (catalog.tools.length === 0 && catalog.operationTools.length === 0 && listConnectorContracts().length === 0) {
    return;
  }

  async function requireMcpSession(request: FastifyRequest): Promise<{
    db: OpenShapeForgeDatabase;
    session: TrustedSessionContext;
  }> {
    const resolved = await resolveSessionContext(
      headersFromFastify(request.headers),
      { db: options.db },
    );
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
      session: resolved,
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
          done(
            new HttpError(
              400,
              "BAD_USER_INPUT",
              "Request body is not valid JSON.",
            ),
            undefined,
          );
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
        void reply.header(
          "www-authenticate",
          buildAuthenticateChallenge(request),
        );
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
      oauthScopes: string[];
      groups: string[];
      scope: DbSessionInput["scope"];
      lastSeenMs: number;
    };
    const mcpSessions = new Map<string, McpSessionEntry>();
    const sameClaims = (
      left: readonly string[],
      right: readonly string[],
    ): boolean => {
      if (left.length !== right.length) return false;
      const sortedLeft = [...left].sort();
      const sortedRight = [...right].sort();
      return sortedLeft.every((value, index) => value === sortedRight[index]);
    };
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
    const notifyDerivedDefinitionChanged = (
      table: string,
      tenantId: string | null,
    ): void => {
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
      const pending = await redeemState(query.state, options.db);
      if (!pending) {
        return reply
          .status(400)
          .type("text/html")
          .send(
            html(
              "This sign-in link is invalid or expired. Start again from your chat.",
            ),
          );
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
          .send(
            html(
              "The provider sent no authorization code. Nothing was stored.",
            ),
          );
      }
      try {
        const { values } = await exchangeCodeForTokens(pending, query.code);
        const db = options.db;
        if (!db) throw new Error("Database is not configured.");
        const tables = tablesByName();
        const table = tables.get(pending.connectionTable);
        if (!table)
          throw new Error("Connection table is missing from the manifest.");
        const writeSession: DbSessionInput = {
          tenantId: pending.tenantId,
          userId: pending.userId,
          roles: [],
          groups: [],
          scope: "self",
        };
        const rows = (
          await listGeneratedEntitiesForTable(db, writeSession, table, {
            limit: 50,
            filter: { [pending.connectionProviderRef]: pending.providerRowId },
          })
        ).rows.map((row) => serializeRow(table, row));
        const personalScope = pending.connectionScope === "user";
        const existing = personalScope
          ? rows.find((row) => row.ownerUserId === pending.userId)
          : rows.find((row) => !row.ownerUserId);
        if (existing) {
          const currentValues = (existing[pending.connectionValuesField] ??
            {}) as Record<string, unknown>;
          await updateGeneratedEntityForTable(
            db,
            writeSession,
            table,
            String(existing.id),
            {
              // Tenant rows keep their configuration (client credentials,
              // subdomain); the sign-in only adds/replaces the tokens.
              [pending.connectionValuesField]: { ...currentValues, ...values },
            },
          );
        } else {
          await createGeneratedEntityForTable(db, writeSession, table, {
            key: `personal-${pending.userId.replace(/[^a-z0-9-]/g, "").slice(0, 20)}`,
            name: `Personal ${pending.providerName} connection`,
            [pending.connectionProviderRef]: pending.providerRowId,
            ...(personalScope ? { ownerUserId: pending.userId } : {}),
            [pending.connectionValuesField]: values,
          });
        }
        return reply
          .status(200)
          .type("text/html")
          .send(
            html(
              "Connected. You can close this window and return to your chat.",
            ),
          );
      } catch (error) {
        request.log.error(
          { err: error },
          "Personal connection callback failed.",
        );
        return reply
          .status(500)
          .type("text/html")
          .send(
            html("Storing the connection failed. Start again from your chat."),
          );
      }
    });

    // The configuration handoff pages. Unauthenticated by necessity, like
    // the OAuth callback: the person arrives by browser, and the single-use
    // token IS the authorization — it was minted for exactly this tenant,
    // user and pending create. Values travel only in the POST body.
    instance.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => done(null, body),
    );

    type ConfigurationSubmission =
      | { ok: true }
      | {
          ok: false;
          errors: Record<string, string>;
          errorBanner?: string;
          prefill: Record<string, unknown>;
        };
    const savePendingConfiguration = async (
      pending: PendingConfiguration,
      body: string,
      writeSession: DbSessionInput,
    ): Promise<ConfigurationSubmission> => {
      const { content, errors } = parseSubmission(pending, body);
      if (Object.keys(errors).length > 0) {
        return { ok: false, errors, prefill: content };
      }
      const db = options.db;
      if (!db)
        throw new HttpError(
          503,
          "DATABASE_NOT_CONFIGURED",
          "Database is not configured.",
        );
      const tableDef = tablesByName().get(pending.table);
      if (!tableDef)
        throw new HttpError(
          500,
          "INTERNAL",
          "Table is missing from the manifest.",
        );
      const values = storeSubmission(pending, content, elicitedKeyring());
      // Verify against the provider BEFORE the row exists: the person is
      // right here at the form, so a wrong subdomain or refused credential
      // comes back as a correctable banner instead of a stored dud.
      const sourceRowId = pending.modelValues[pending.elicit.sourceField];
      const sourceTable = tablesByName().get(pending.elicit.sourceTable);
      if (typeof sourceRowId === "string" && sourceTable) {
        const sourceResult = await listGeneratedEntitiesForTable(
          db,
          writeSession,
          sourceTable,
          {
            limit: 1,
            filter: { id: sourceRowId },
          },
        );
        const sourceRow = sourceResult.rows[0]
          ? serializeRow(sourceTable, sourceResult.rows[0])
          : null;
        if (sourceRow) {
          const report = await testElicitedRow({
            row: { [pending.elicit.into]: values[pending.elicit.into] },
            sourceRow,
            elicit: pending.elicit,
            table: pending.table,
          });
          if (!report.ok) {
            return {
              ok: false,
              errors: {},
              errorBanner: `${report.source} refused these values — ${failedCheckSummary(report)}`,
              prefill: content,
            };
          }
        }
      }
      await createGeneratedEntityForTable(
        db,
        writeSession,
        tableDef,
        values,
      );
      return { ok: true };
    };

    // Stable, authenticated KERN form API. The web client sends its normal
    // Keycloak bearer; RLS resolves the pending handoff by tenant/user. The URL
    // exposed to the assistant therefore carries no handoff credential.
    instance.get(`${ENTITY_CONFIGURATION_PATH}/pending`, async (request) => {
      const { db, session } = await requireMcpSession(request);
      const found = await latestConfigurationForSession(session, db);
      if (!found) {
        throw new HttpError(
          404,
          "NOT_FOUND",
          "No pending configuration form was found for this user.",
        );
      }
      return {
        id: found.id,
        displayName: found.pending.displayName,
        messagePrefix: found.pending.messagePrefix,
        definitions: configurationFormDefinitions(found.pending),
      };
    });
    instance.post(
      `${ENTITY_CONFIGURATION_PATH}/pending/:id`,
      async (request, reply) => {
        const { db, session } = await requireMcpSession(request);
        const found = await latestConfigurationForSession(session, db);
        const id = (request.params as { id?: string }).id;
        if (!found || found.id !== id) {
          throw new HttpError(
            404,
            "NOT_FOUND",
            "This pending configuration form is unavailable or expired.",
          );
        }
        const body = typeof request.body === "string" ? request.body : "";
        const outcome = await savePendingConfiguration(
          found.pending,
          body,
          session,
        );
        if (!outcome.ok) {
          return reply.status(400).send({
            error: {
              code: "INVALID_CONFIGURATION",
              message:
                outcome.errorBanner ?? "Correct the highlighted values.",
              fields: outcome.errors,
            },
          });
        }
        const consumed = await consumeConfigurationForSession(id, session, db);
        if (!consumed) {
          throw new HttpError(
            409,
            "CONFLICT",
            "This configuration form was already submitted.",
          );
        }
        return reply.send({ saved: true });
      },
    );

    instance.get(
      `${ENTITY_CONFIGURATION_PATH}/:token`,
      async (request, reply) => {
        const pending = await peekConfiguration(
          (request.params as { token?: string }).token,
          options.db,
        );
        if (!pending) {
          return reply
            .status(404)
            .type("text/html")
            .send(
              renderMessagePage(
                "This configuration link is invalid or expired. Ask your assistant to start again.",
              ),
            );
        }
        return reply
          .type("text/html")
          .send(
            renderConfigurationForm(
              pending,
              `${ENTITY_CONFIGURATION_PATH}/${pending.token}`,
            ),
          );
      },
    );
    instance.post(
      `${ENTITY_CONFIGURATION_PATH}/:token`,
      async (request, reply) => {
        const pending = await peekConfiguration(
          (request.params as { token?: string }).token,
          options.db,
        );
        if (!pending) {
          return reply
            .status(404)
            .type("text/html")
            .send(
              renderMessagePage(
                "This configuration link is invalid or expired. Ask your assistant to start again.",
              ),
            );
        }
        const body = typeof request.body === "string" ? request.body : "";
        try {
          const writeSession: DbSessionInput = {
            tenantId: pending.tenantId,
            userId: pending.userId,
            roles: [],
            groups: [],
            scope: "self",
          };
          const outcome = await savePendingConfiguration(
            pending,
            body,
            writeSession,
          );
          if (!outcome.ok) {
            return reply
              .status(400)
              .type("text/html")
              .send(
                renderConfigurationForm(
                  pending,
                  `${ENTITY_CONFIGURATION_PATH}/${pending.token}`,
                  outcome.errors,
                  {
                    ...(outcome.errorBanner
                      ? { errorBanner: outcome.errorBanner }
                      : {}),
                    prefill: outcome.prefill,
                  },
                ),
              );
          }
          await consumeConfiguration(pending.token, options.db);
          return reply
            .type("text/html")
            .send(
              renderMessagePage(
                "Saved. You can close this window and return to your chat.",
              ),
            );
        } catch (error) {
          request.log.error(
            { err: error },
            "Configuration handoff submission failed.",
          );
          const { body: errorBody } = toHttpError(error);
          return reply
            .status(400)
            .type("text/html")
            .send(
              renderMessagePage(
                `Saving failed: ${errorBody.error.message} Return to your chat and try again.`,
              ),
            );
        }
      },
    );

    instance.route({
      url: MCP_MOUNT_PATH,
      method: ["GET", "POST", "DELETE"],
      handler: async (request, reply) => {
        const { db, session } = await requireMcpSession(request);

        const sessionHeader = request.headers["mcp-session-id"];
        const sessionId = Array.isArray(sessionHeader)
          ? sessionHeader[0]
          : sessionHeader;

        if (sessionId) {
          const existing = mcpSessions.get(sessionId);
          if (!existing) {
            // Per spec: an unknown session id answers 404 so the client
            // reinitializes, rather than being silently handled statelessly.
            throw new HttpError(
              404,
              "SESSION_NOT_FOUND",
              "Unknown MCP session; reinitialize.",
            );
          }
          // The session is a credential: it was initialized by one identity
          // and stays bound to it.
          if (
            existing.tenantId !== session.tenantId ||
            existing.userId !== session.userId
          ) {
            throw new HttpError(
              403,
              "FORBIDDEN",
              "MCP session belongs to another identity.",
            );
          }
          if (
            !sameClaims(existing.roles, session.roles ?? []) ||
            !sameClaims(existing.oauthScopes, session.oauthScopes ?? []) ||
            !sameClaims(existing.groups, session.groups ?? []) ||
            existing.scope !== session.scope
          ) {
            mcpSessions.delete(sessionId);
            void existing.transport.close();
            void existing.server.close();
            throw new HttpError(
              404,
              "SESSION_NOT_FOUND",
              "Authorization changed; reinitialize the MCP session.",
            );
          }
          existing.lastSeenMs = Date.now();
          reply.hijack();
          await existing.transport.handleRequest(
            request.raw,
            reply.raw,
            request.body,
          );
          return;
        }

        if (request.method === "POST" && isInitializeBody(request.body)) {
          const server = buildServer(
            db,
            session,
            options.modules,
            notifyDerivedDefinitionChanged,
            true,
          );
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              mcpSessions.set(id, {
                transport,
                server,
                tenantId: session.tenantId as string,
                userId: session.userId as string,
                roles: [...(session.roles ?? [])],
                oauthScopes: [...(session.oauthScopes ?? [])],
                groups: [...(session.groups ?? [])],
                scope: session.scope,
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
          await server.connect(
            transport as unknown as Parameters<Server["connect"]>[0],
          );
          await transport.handleRequest(request.raw, reply.raw, request.body);
          return;
        }

        // Sessionless non-initialize request: the pre-session stateless
        // single-shot behaviour, kept for probes and legacy callers. No
        // server-initiated exchange is possible on this path, but a mutation
        // made through it still nudges the live sessions.
        const server = buildServer(
          db,
          session,
          options.modules,
          notifyDerivedDefinitionChanged,
        );
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
        reply.hijack();
        await server.connect(
          transport as unknown as Parameters<Server["connect"]>[0],
        );
        await transport.handleRequest(request.raw, reply.raw, request.body);
      },
    });
  });
}
