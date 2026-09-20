// SPDX-License-Identifier: BUSL-1.1
/**
 * Everything one MCP session's server is built from, resolved once per
 * session: the locale, the SDK server with its instructions, the tables and
 * operations the session may reach, and the closures that resolve derived
 * tool definitions and their authorized invocation sources. The request
 * handlers (tool listing, resource reads, tool dispatch) take this scope and
 * add nothing to it that outlives a request.
 *
 * Split out of generated-mcp-server.ts: the body is the former prologue of
 * buildServer, verbatim, and the scope's type is inferred from what it
 * returns so the handlers destructure exactly the names the prologue declared.
 */
import {
  type CapturedDerivedExecution,
  type GeneratedTable,
  type OperationToolProjection,
  SERVER_INFO,
  authorityFingerprint,
  catalog,
  catalogDerivedTools,
  catalogGuideTools,
  catalogResources,
  connectionScopeOf,
  coreOwnsStaticToolName,
  entityForTable,
  fieldNameForColumn,
  generatedOperationToolProjection,
  hasDynamicModuleToolProjection,
  projectedDerivedTools,
  serializeRow,
  tablesByName,
  toolsForSession,
} from "./catalog.js";
import type { RuntimeDeclarativeServiceRequest } from "@openshapeforge/plugin-runtime";
import { sql, type Transaction } from "kysely";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import { withDbSession } from "../db/session.js";
import {
  derivedToolsFromRows,
  isAuthorizedInternalDerivedRow,
  sessionInAudience,
  type DerivedToolsCatalogEntry,
} from "./derived-tools.js";
import { ARTIFACT_UPLOAD_APP_URI } from "./artifact-upload.js";
import { editLeaseOperationIdsForSession } from "./edit-lease-tools.js";
import { bindingSelected, orderedBindings } from "./declarative-execution.js";
import { scopesCovered } from "./entity-oauth.js";
import { accessTokenNeedsRefresh, refreshLeewaySeconds } from "./connection-token-refresh.js";
import { HttpError } from "../rest/http-error.js";
import { ONBOARDING_RESOURCE_URIS, ONBOARDING_STEP_RESOURCE_TEMPLATE } from "./onboarding-resources.js";
import { connectionProblemMessage } from "./connection-guidance.js";
import { isOrganizationAdministrator } from "./onboarding.js";
import type { RuntimeModule } from "../modules/contract.js";
import type { McpInvocationContext, McpProjectionContext } from "../modules/contract.js";
import { assertUniqueToolNames, type SourcedTool } from "../modules/mcp-hooks.js";
import { createModuleSessionCapability, type ModulePlatformRuntime } from "../modules/platform.js";
import {
  InvocationSourceVault,
  type AuthorizedInvocationSource,
  type AuthorizedInvocationSourceResolution,
  type AuthorizedUnavailableInvocationSource,
} from "../modules/invocation-sources.js";
import { mintInvocationSourceReference, sameInvocationSourceReference } from "../modules/source-reference.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { sessionLocale } from "./session-info.js";
import { sessionClientOf } from "./session-client.js";
import { buildServerInstructions, ENTITY_CATALOG_URI } from "./server-instructions.js";
import { type SearchableOperationToolNames } from "./operation-search.js";
import { bindOperationHandlers } from "../operations/runtime.js";
import { derivedToolsForSession } from "./derived-session-tools.js";
import {
  describeTool,
  entitiesForSession,
  entityResourceUri,
  entityTitle,
} from "./entity-tool-projection.js";
import {
  ENTITY_CONFIGURATION_APP_URI,
  oauthCallbackUrlForInstructions,
  schemaUsesArtifactUpload,
  supportsMcpApp,
} from "./handoff-config.js";
import {
  capturePersonalOAuthConnections,
  connectionToolsFor,
  looksLikeStoredSecret,
  normalizeConnectionValueRows,
  providerDisplayName,
  runtimeRowByFilter,
} from "./session-connections.js";
export function createServerScope(input: {
  db: OpenShapeForgeDatabase;
  session: TrustedSessionContext;
  modules: readonly RuntimeModule[] | undefined;
  modulePlatform: ModulePlatformRuntime | undefined;
  egressOwner: RuntimeModule["egress"] | undefined;
  onDerivedDefinitionChanged: ((table: string, tenantId: string | null) => void) | undefined;
  stateful: boolean;
  tableOverride: Map<string, GeneratedTable> | undefined;
  opening: string | null;
  moduleSessionOverride: TrustedSessionContext | undefined;
  operationToolProjectionOverride: OperationToolProjection | undefined;
}) {
  const {
    db,
    session,
    modules,
    modulePlatform,
    egressOwner,
    onDerivedDefinitionChanged,
    stateful,
    tableOverride,
    opening,
    moduleSessionOverride,
    operationToolProjectionOverride,
  } = input;
  const runtimeModules = modules ?? [];
  // Resolved once, here: the server's `instructions` are written at build time
  // and every authored label this session projects is read through the same
  // answer, so a second resolution could only disagree with the first.
  const locale = sessionLocale(session);
  const moduleSession = moduleSessionOverride ?? createModuleSessionCapability(session);
  const operationToolProjection =
    operationToolProjectionOverride ?? generatedOperationToolProjection;
  const searchableOperationToolNames: SearchableOperationToolNames = {
    search: operationToolProjection.search,
    execute: operationToolProjection.execute,
  };
  const hasDynamicModuleTools =
    hasDynamicModuleToolProjection(runtimeModules) ||
    runtimeModules.some((module) => (module.operationProviders?.length ?? 0) > 0);
  const hasDynamicModuleResources = runtimeModules.some(
    (module) =>
      module.mcp?.resources !== undefined ||
      module.mcp?.resourceTemplates !== undefined,
  );
  const guidesCalled = new Set<string>();
  const tables = tableOverride ?? tablesByName();
  const server = new Server(SERVER_INFO, {
    capabilities: {
      // listChanged is advertised only when the tool list can actually change
      // mid-session — i.e. when stored rows project as tools.
      tools:
        projectedDerivedTools.length > 0 || hasDynamicModuleTools
          ? { listChanged: true }
          : {},
      resources: hasDynamicModuleResources ? { listChanged: true } : {},
      prompts: {},
    },
    // Written once, here, from the fixed guidance and this session's own
    // parts: who the person is, which client is in front of the model and
    // which language they read. See mcp/server-instructions.ts for the order.
    // The server owns the OAuth redirect URL, so it states it rather than
    // leaving assistants to ask the person for a value only this process
    // knows; without a public origin it says that, instead of failing.
    instructions: buildServerInstructions({
      opening,
      hasConnectors: projectedDerivedTools.some((entry) => entry.connect),
      oauthCallbackUrl: oauthCallbackUrlForInstructions(),
      guidesBeforeCreate: catalogGuideTools
        .filter((guide) => guide.requireBeforeCreate)
        .map((guide) => ({ name: guide.name, entity: guide.entity ?? null })),
      // The words this deployment uses for its records: the authored label
      // of every entity this session can reach, in the person's language.
      vocabulary: entitiesForSession(session, tables).map(({ entity }) => ({
        entity: entity.entity,
        label: entityTitle(entity, locale) ?? entity.title,
        description: entity.description,
      })),
      locale,
      client: sessionClientOf(session),
    }),
  });
  const hasArtifactStorage = runtimeModules.some((module) => module.artifactStorage !== undefined);
  // Read on the per-entity schemas, not the compact generic listing, whose
  // stubs no longer carry the upload marker of an entity's own fields.
  const canUploadArtifacts = hasArtifactStorage && toolsForSession(session, tables).some(
    ({ tool, entity }) =>
      schemaUsesArtifactUpload(
        describeTool(tool, entity, tables.get(tool.table), session).inputSchema,
      ),
  );
  // The same rule REST boot applies (roles/api.ts): with no operation module
  // in the process there are the core operation tools and no plugin ones,
  // rather than a 500 on every request because the catalog names a handler
  // nothing loaded.
  const operations = bindOperationHandlers(runtimeModules);
  const searchableStaticOperationIds = new Set(
    catalog.operationTools
      .filter((tool) => operations.has(tool.key))
      .map((tool) => tool.key),
  );
  const projectedEntityOperationIds = toolsForSession(session, tables)
    .map(({ tool }) => tool.operationId)
    .filter((operationId): operationId is string => Boolean(operationId));
  const projectedPluginOperationIds = [...operations.values()]
    .filter(({ operation }) => operation.transports.mcp.enabled)
    .map(({ operation }) => operation.key);
  const editLeaseOperationIds = editLeaseOperationIdsForSession(
    session,
    [...projectedEntityOperationIds, ...projectedPluginOperationIds],
  );
  const allowedEditLeaseOperationIds = new Set(editLeaseOperationIds);
  const sourceVault = new InvocationSourceVault();

  const projectionContext = (): McpProjectionContext => {
    const capabilities = server.getClientCapabilities() as
      | { elicitation?: unknown }
      | undefined;
    return {
      db,
      session: moduleSession,
      clientCapabilities: {
        elicitation: capabilities?.elicitation !== undefined,
        mcpApp: supportsMcpApp(server),
      },
    };
  };

  const invocationContext = (requestId: string | number): McpInvocationContext => {
    const projected = projectionContext();
    return Object.freeze({
      ...projected,
      clientCapabilities: Object.freeze({ ...projected.clientCapabilities }),
      server,
      requestId,
    });
  };

  // Ownership is deployment-wide, not session-visible: a module must never
  // shadow a core URI merely because this caller cannot see the core surface.
  const coreResourceOwnership = {
    exact: [
      ENTITY_CATALOG_URI,
      ENTITY_CONFIGURATION_APP_URI,
      ARTIFACT_UPLOAD_APP_URI,
      ...ONBOARDING_RESOURCE_URIS,
      ...catalog.entities.map(entityResourceUri),
      ...catalogResources.map((resource) => resource.uri),
    ],
    templates: [
      ONBOARDING_STEP_RESOURCE_TEMPLATE.uriTemplate,
      ...catalogResources.map((resource) => resource.templateUri),
    ],
  };

  const definitionFor = (
    entry: DerivedToolsCatalogEntry,
    row: Record<string, unknown>,
  ) => {
    const id = row.id;
    const version = entry.versionField
      ? row[entry.versionField]
      : undefined;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      !Number.isInteger(version) ||
      (version as number) < 1
    ) {
      throw new HttpError(
        404,
        "NOT_FOUND",
        "Invocation source is unavailable.",
      );
    }
    return {
      kind: entry.entity,
      id,
      version: version as number,
    };
  };

  const columnForField = (table: GeneratedTable, field: string) =>
    table.columns.find((column) => fieldNameForColumn(column) === field);

  const snapshotRowsByFilter = async (
    trx: Transaction<DB>,
    tableName: string,
    filter: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> => {
    const table = tables.get(tableName);
    if (!table) return [];
    const predicates = Object.entries(filter).map(([field, value]) => {
      const column = columnForField(table, field);
      return column
        ? sql`${sql.id(column.name)}::text = ${String(value)}`
        : undefined;
    });
    if (predicates.some((predicate) => predicate === undefined)) return [];
    const where = predicates.length
      ? sql`where ${sql.join(predicates as NonNullable<(typeof predicates)[number]>[], sql` and `)}`
      : sql``;
    const result = await sql<{ row: Record<string, unknown> }>`
      select to_jsonb(row_source.*) as row
        from ${sql.id(table.schema, table.table)} as row_source
        ${where}
    `.execute(trx);
    return result.rows.map(({ row }) => serializeRow(table, row));
  };

  const snapshotDefinitionsByToolName = async (
    trx: Transaction<DB>,
    entry: DerivedToolsCatalogEntry,
    toolName: string,
  ): Promise<Record<string, unknown>[]> => {
    const table = tables.get(entry.table);
    const keyColumn = table ? columnForField(table, entry.keyField) : undefined;
    if (!table || !keyColumn) return [];
    const result = await sql<{ row: Record<string, unknown> }>`
      select to_jsonb(row_source.*) as row
        from ${sql.id(table.schema, table.table)} as row_source
       where lower(replace(btrim(${sql.id(keyColumn.name)}::text), '-', '_')) = ${toolName}
       order by ${sql.id(table.primaryKey ?? keyColumn.name)}
       limit 2
    `.execute(trx);
    return result.rows.map(({ row }) => serializeRow(table, row));
  };

  const coreOwnsDerivedToolName = async (toolName: string): Promise<boolean> => {
    if (coreOwnsStaticToolName(toolName, operationToolProjection)) return true;
    if (!session.tenantId || catalogDerivedTools.length === 0) return false;
    return withDbSession(db, session, async (trx) => {
      for (const entry of catalogDerivedTools) {
        if ((await snapshotDefinitionsByToolName(trx, entry, toolName)).length > 0) {
          return true;
        }
      }
      return false;
    });
  };

  const assertModuleToolNamesAvailable = async (
    tools: readonly SourcedTool[],
  ): Promise<void> => {
    assertUniqueToolNames(tools);
    for (const { tool } of tools) {
      if (coreOwnsStaticToolName(tool.name, operationToolProjection)) {
        throw new Error(
          `MCP tool name ${JSON.stringify(tool.name)} is contributed more than once.`,
        );
      }
    }
    if (!session.tenantId || catalogDerivedTools.length === 0 || tools.length === 0) {
      return;
    }
    await withDbSession(db, session, async (trx) => {
      for (const { tool } of tools) {
        for (const entry of catalogDerivedTools) {
          if (
            (await snapshotDefinitionsByToolName(trx, entry, tool.name)).length >
            0
          ) {
            throw new Error(
              `MCP tool name ${JSON.stringify(tool.name)} is contributed more than once.`,
            );
          }
        }
      }
    });
  };

  const derivedDefinition = async (
    toolName: string,
    projectedOnly: boolean,
  ): Promise<
    | {
        entry: DerivedToolsCatalogEntry;
        row: Record<string, unknown>;
      }
    | undefined
  > => {
    if (projectedOnly) {
      const projected = (await derivedToolsForSession(db, session, tables, locale)).find(
        (tool) => tool.name === toolName,
      );
      if (!projected) return undefined;
      const entry = catalogDerivedTools.find(
        (candidate) => candidate.table === projected.table,
      );
      const row = entry
        ? await runtimeRowByFilter(db, session, tables, entry.table, {
            id: projected.rowId,
          })
        : null;
      return entry && row ? { entry, row } : undefined;
    }
    return withDbSession(db, session, async (trx) => {
      for (const entry of catalogDerivedTools) {
        if (!entry.execution || !sessionInAudience(entry, session.roles))
          continue;
        const rows = await snapshotDefinitionsByToolName(trx, entry, toolName);
        if (rows.length !== 1) continue;
        const row = rows[0]!;
        if (isAuthorizedInternalDerivedRow(entry, row, session.roles)) {
          return { entry, row };
        }
      }
      return undefined;
    });
  };

  /**
   * Re-read one canonical provider definition through generated internal
   * compatibility metadata. This deliberately does not project the row as an
   * MCP tool; the runtime Operation provider owns public listing and lookup.
   */
  const compatibilityDefinition = async (
    request: RuntimeDeclarativeServiceRequest,
  ): Promise<
    | { entry: DerivedToolsCatalogEntry; row: Record<string, unknown> }
    | undefined
  > => {
    for (const entry of catalogDerivedTools) {
      if (
        !entry.compatibility ||
        entry.entity !== request.definition.entity ||
        !sessionInAudience(entry, session.roles)
      ) continue;
      const row = await runtimeRowByFilter(db, session, tables, entry.table, {
        id: request.definition.id,
      });
      if (!row) continue;
      const publiclyAvailable = derivedToolsFromRows(
        entry,
        [row],
        new Set(),
        session.roles,
        locale,
      ).length === 1;
      if (
        !publiclyAvailable &&
        !isAuthorizedInternalDerivedRow(entry, row, session.roles)
      ) continue;
      return { entry, row };
    }
    return undefined;
  };

  const authorizedSources = async (
    toolName: string,
    projectedOnly: boolean,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AuthorizedInvocationSourceResolution> => {
    signal?.throwIfAborted();
    if (!session.tenantId) return { sources: [], unavailable: [] };
    const tenantId = session.tenantId;
    return withDbSession(db, session, async (trx) => {
      signal?.throwIfAborted();
      for (const entry of catalogDerivedTools) {
        signal?.throwIfAborted();
        const execution = entry.execution;
        if (!execution || !sessionInAudience(entry, session.roles)) continue;
        const rows = await snapshotDefinitionsByToolName(trx, entry, toolName);
        if (rows.length !== 1) continue;
        const serviceRow = rows[0]!;
        const authorized = projectedOnly
          ? derivedToolsFromRows(
              entry,
              [serviceRow],
              new Set<string>(),
              session.roles,
              locale,
            ).some((tool) => tool.name === toolName)
          : isAuthorizedInternalDerivedRow(entry, serviceRow, session.roles);
        if (!authorized) continue;

        const definition = definitionFor(entry, serviceRow);
        const definitionKind = definition.kind;
        const definitionId = definition.id;
        const definitionVersion = definition.version;
        const sources: AuthorizedInvocationSource[] = [];
        const unavailable: AuthorizedUnavailableInvocationSource[] = [];
        const definitionUnavailable = (
          binding: Record<string, unknown>,
          outcome: AuthorizedUnavailableInvocationSource["outcome"],
          guidance?: string,
        ) => unavailable.push({
          tenantId,
          actorId: session.userId,
          toolName,
          binding: Number(binding.order ?? 0),
          definition,
          outcome,
          ...(guidance !== undefined ? { guidance } : {}),
        });
        // The next step for a connection gap on this provider, worded for
        // the caller — the same text the direct execution path raises.
        const connectionGuidance = (
          providerRow: Record<string, unknown>,
          gap: "organization" | "personal" | "tenant_sign_in" | "reauthorization",
        ): string => {
          const adapter = providerDisplayName(providerRow, execution);
          const connectTool = entry.connect?.name ?? null;
          switch (gap) {
            case "organization":
              return connectionProblemMessage({
                kind: "organization_missing",
                adapter,
                adapterId: String(providerRow.id ?? ""),
                createTool: connectionToolsFor(execution, entry).create,
                adapterArgument:
                  entityForTable(execution.connectionTable)?.elicitOnCreate
                    ?.sourceField ?? "adapterId",
                administrator: isOrganizationAdministrator(session.roles),
              });
            case "personal":
              return connectionProblemMessage({
                kind: "personal_missing",
                adapter,
                toolName,
                connectTool,
              });
            case "tenant_sign_in":
              return connectionProblemMessage({
                kind: "tenant_sign_in",
                adapter,
                toolName,
                connectTool,
                administrator: isOrganizationAdministrator(session.roles),
              });
            case "reauthorization":
              return connectionProblemMessage({
                kind: "reauthorization",
                adapter,
                toolName,
                connectTool,
                scope:
                  connectionScopeOf(
                    (providerRow.auth ?? null) as Record<string, unknown> | null,
                  ) === "tenant"
                    ? "tenant"
                    : "user",
                reason: "expired or no longer covers the scopes this tool needs",
              });
          }
        };
        const selectedBindings = orderedBindings(
          serviceRow,
          execution.bindingsField,
        ).filter((binding) => bindingSelected(binding, args));
        for (const binding of selectedBindings) {
          const operationId = binding[execution.operationRef];
          if (typeof operationId !== "string") {
            definitionUnavailable(binding, "unavailable");
            continue;
          }
          const operationRow = (
            await snapshotRowsByFilter(trx, execution.operationTable, {
              id: operationId,
            })
          )[0];
          if (!operationRow) {
            definitionUnavailable(binding, "unavailable");
            continue;
          }
          const providerId = operationRow?.[execution.providerRef];
          if (typeof providerId !== "string") {
            definitionUnavailable(binding, "unavailable");
            continue;
          }
          const providerRow = (
            await snapshotRowsByFilter(trx, execution.providerTable, {
              id: providerId,
            })
          )[0];
          if (!providerRow) {
            definitionUnavailable(binding, "unavailable");
            continue;
          }
          const connectionRows = normalizeConnectionValueRows(
            await snapshotRowsByFilter(
              trx,
              execution.connectionTable,
              { [execution.connectionProviderRef]: providerId },
            ),
            execution.connectionValuesField,
          );
          const providerAuth = (providerRow.auth ?? null) as Record<
            string,
            unknown
          > | null;
          const declaredScope = connectionScopeOf(providerAuth);
          const allowsPersonal = declaredScope === "user" || declaredScope === "both";
          const allowsTenant = declaredScope === "tenant" || declaredScope === "both";
          const personalOAuth =
            allowsPersonal && providerAuth?.profile === "oauth2AuthorizationCode";
          const bindingNumber = Number(binding.order ?? 0);
          let personalCapture:
            | ReturnType<typeof capturePersonalOAuthConnections>
            | undefined;
          if (personalOAuth) {
            try {
              personalCapture = capturePersonalOAuthConnections(
                connectionRows,
                session.userId,
              );
            } catch {
              // No (single) tenant support row: the organization's side is
              // missing, which comes before any personal sign-in.
              definitionUnavailable(
                binding,
                "connection_required",
                connectionGuidance(providerRow, "organization"),
              );
              continue;
            }
          }
          const eligible = personalCapture
            ? [
                ...personalCapture.personal,
                ...(allowsTenant ? [personalCapture.tenantSupport] : []),
              ]
            : connectionRows
                .filter((row) =>
                  (allowsPersonal && row.ownerUserId === session.userId) ||
                  (allowsTenant &&
                    (row.ownerUserId === null || row.ownerUserId === undefined)),
                )
                .filter(
                  (row): row is Record<string, unknown> & { id: string } =>
                    typeof row.id === "string" && row.id.length > 0,
                )
                .sort((left, right) => left.id.localeCompare(right.id));
          const requiredScopes = Array.isArray(operationRow.requiredScopes)
            ? operationRow.requiredScopes.filter(
                (scope): scope is string => typeof scope === "string",
              )
            : [];
          let missingRequiredScopes = false;
          let needsReauthorization = false;
          let eligibleSourceCount = 0;
          for (const connection of eligible) {
            const connectionValues = (connection[
              execution.connectionValuesField
            ] ?? {}) as Record<string, unknown>;
            if (
              !scopesCovered(requiredScopes, connectionValues?.grantedScopes)
            ) {
              missingRequiredScopes = true;
              continue;
            }
            if (
              providerAuth?.profile === "oauth2AuthorizationCode" &&
              !connectionValues?.accessToken
            ) {
              continue;
            }
            if (
              providerAuth?.profile === "oauth2AuthorizationCode" &&
              accessTokenNeedsRefresh(
                connectionValues,
                refreshLeewaySeconds(providerAuth),
              ) &&
              !looksLikeStoredSecret(connectionValues.refreshToken)
            ) {
              needsReauthorization = true;
              continue;
            }
            const sourceIsPersonal = connection.ownerUserId === session.userId;
            const identity = {
              tenantId,
              actorId: sourceIsPersonal ? session.userId : null,
              scope: sourceIsPersonal ? ("personal" as const) : ("tenant" as const),
              connectionTable: execution.connectionTable,
              connectionId: String(connection.id),
            };
            const sourceReference = mintInvocationSourceReference(identity);
            const internal: CapturedDerivedExecution = {
              entry,
              serviceRow,
              binding,
              operationRow,
              providerRow,
              connectionRows: personalCapture && sourceIsPersonal
                ? [personalCapture.tenantSupport, connection]
                : [connection],
              selectedConnectionId: String(connection.id),
            };
            const fingerprint = authorityFingerprint(internal);
            const validate = async (validationSignal?: AbortSignal) => {
              validationSignal?.throwIfAborted();
              const current = await authorizedSources(
                toolName,
                projectedOnly,
                args,
                validationSignal,
              );
              return current.sources.find(
                (candidate) =>
                  sameInvocationSourceReference(
                    candidate.sourceReference,
                    sourceReference,
                  ) &&
                  candidate.binding === bindingNumber &&
                  candidate.definition.kind === definitionKind &&
                  candidate.definition.id === definitionId &&
                  candidate.definition.version === definitionVersion,
              );
            };
            sources.push({
              sourceReference,
              tenantId: identity.tenantId,
              actorId: identity.actorId,
              toolName,
              scope: identity.scope,
              binding: bindingNumber,
              definition,
              authorityFingerprint: fingerprint,
              internal,
              validate,
            });
            eligibleSourceCount += 1;
          }
          if (eligibleSourceCount === 0) {
            const reauthorize = missingRequiredScopes || needsReauthorization;
            definitionUnavailable(
              binding,
              reauthorize ? "reauthorization_required" : "connection_required",
              connectionGuidance(
                providerRow,
                reauthorize
                  ? "reauthorization"
                  : allowsPersonal && !allowsTenant
                    ? "personal"
                    : providerAuth?.profile === "oauth2AuthorizationCode"
                      ? "tenant_sign_in"
                      : "organization",
              ),
            );
          }
        }
        return { sources, unavailable };
      }
      return { sources: [], unavailable: [] };
    }, { isolationLevel: "repeatable read" });
  };

  const sourceFromReference = async (
    sourceReference: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AuthorizedInvocationSource | undefined> => {
    signal?.throwIfAborted();
    const candidates = await authorizedSources(toolName, false, args, signal);
    const matching = candidates.sources.filter((candidate) =>
      sameInvocationSourceReference(
        candidate.sourceReference,
        sourceReference,
      ),
    );
    return matching.length === 1 ? matching[0] : undefined;
  };

  return {
    db,
    session,
    modulePlatform,
    egressOwner,
    onDerivedDefinitionChanged,
    stateful,
    opening,
    runtimeModules,
    locale,
    moduleSession,
    operationToolProjection,
    searchableOperationToolNames,
    hasDynamicModuleTools,
    hasDynamicModuleResources,
    guidesCalled,
    tables,
    server,
    hasArtifactStorage,
    canUploadArtifacts,
    operations,
    searchableStaticOperationIds,
    projectedEntityOperationIds,
    projectedPluginOperationIds,
    editLeaseOperationIds,
    allowedEditLeaseOperationIds,
    sourceVault,
    projectionContext,
    invocationContext,
    coreResourceOwnership,
    definitionFor,
    columnForField,
    snapshotRowsByFilter,
    snapshotDefinitionsByToolName,
    coreOwnsDerivedToolName,
    assertModuleToolNamesAvailable,
    derivedDefinition,
    compatibilityDefinition,
    authorizedSources,
    sourceFromReference,
  };
}

export type ServerScope = ReturnType<typeof createServerScope>;
