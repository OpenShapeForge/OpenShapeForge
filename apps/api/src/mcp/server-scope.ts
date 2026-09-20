// SPDX-License-Identifier: BUSL-1.1
/**
 * The base of one MCP session's server, resolved once per session: the
 * locale, the SDK server with its instructions, the tables and operations
 * the session may reach, and the closures that resolve derived tool
 * definitions. The request handlers (tool listing, resource reads, tool
 * dispatch) take the scope and add nothing to it that outlives a request.
 *
 * Split out of generated-mcp-server.ts: the body is the former prologue of
 * buildServer, verbatim.
 */
import { createDerivedDefinitionResolution } from "./derived-definitions.js";
import { createInvocationSourceResolution } from "./invocation-source-resolution.js";
import {
  type GeneratedTable,
  type OperationToolProjection,
  SERVER_INFO,
  catalog,
  catalogGuideTools,
  catalogResources,
  generatedOperationToolProjection,
  hasDynamicModuleToolProjection,
  projectedDerivedTools,
  tablesByName,
} from "./catalog.js";
import { toolsForSession } from "./session-projection.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { ARTIFACT_UPLOAD_APP_URI } from "./artifact-upload.js";
import { editLeaseOperationIdsForSession } from "./edit-lease-tools.js";
import { ONBOARDING_RESOURCE_URIS, ONBOARDING_STEP_RESOURCE_TEMPLATE } from "./onboarding-resources.js";
import type { RuntimeModule } from "../modules/contract.js";
import type { McpInvocationContext, McpProjectionContext } from "../modules/contract.js";
import { createModuleSessionCapability, type ModulePlatformRuntime } from "../modules/platform.js";
import { InvocationSourceVault } from "../modules/invocation-sources.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { sessionLocale } from "./session-info.js";
import { sessionClientOf } from "./session-client.js";
import { buildServerInstructions, ENTITY_CATALOG_URI } from "./server-instructions.js";
import { type SearchableOperationToolNames } from "./operation-search.js";
import { bindOperationHandlers } from "../operations/runtime.js";
import { describeTool, entityTitle } from "./entity-tool-projection.js";
import { entitiesForSession, entityResourceUri } from "./entity-resources.js";
import {
  ENTITY_CONFIGURATION_APP_URI,
  oauthCallbackUrlForInstructions,
  schemaUsesArtifactUpload,
  supportsMcpApp,
} from "./handoff-config.js";
function createServerScopePrologue(input: {
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
  };
}

/** The scope before derived definitions and invocation sources are added to it. */
export type ServerScopePrologue = ReturnType<typeof createServerScopePrologue>;

function createServerScopeBase(input: Parameters<typeof createServerScopePrologue>[0]) {
  const prologue = createServerScopePrologue(input);
  return { ...prologue, ...createDerivedDefinitionResolution(prologue) };
}

/** The scope before the invocation-source resolution is added to it. */
export type ServerScopeBase = ReturnType<typeof createServerScopeBase>;

/**
 * Everything one MCP session's server is built from, resolved once per
 * session: the base above plus the resolution of derived tools' invocation
 * sources (invocation-source-resolution.ts). The type is inferred from what
 * is returned so the handlers destructure exactly the names declared here.
 */
export function createServerScope(input: Parameters<typeof createServerScopeBase>[0]) {
  const base = createServerScopeBase(input);
  return { ...base, ...createInvocationSourceResolution(base) };
}

export type ServerScope = ReturnType<typeof createServerScope>;
