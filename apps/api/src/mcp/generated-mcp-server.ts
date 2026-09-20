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
 *   - the shared operation result/error contract, projected to MCP results.
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
 *
 * This file is the transport: it builds one server per session and registers
 * the HTTP routes. The engine behind it lives beside it, one module per
 * concern:
 *
 *   catalog.ts                  the compiled catalogue and the per-session
 *                               projection rules (who is shown what)
 *   entity-tool-projection.ts   how entity tools and resources are described
 *   derived-session-tools.ts    the row-defined tools a session sees
 *   session-connections.ts      connections as the execution path reads them
 *   handoff-config.ts           the browser handoff configuration
 *   tool-schema.ts              the argument envelope validation
 *   tool-results.ts             the shapes a call answers with
 *   entity-tool-invocation.ts   executing an entity CRUD tool
 *   server-scope.ts             what one session's server is built from
 *   session-surface.ts          resources, whoami, onboarding, the tool list
 *   tool-dispatch.ts and the    one tool call, section by section
 *   dispatch-*.ts modules
 *   *-routes.ts                 the browser-facing routes (OAuth callback,
 *                               configuration handoff, document upload)
 */
import { randomUUID } from "node:crypto";
import { GENERIC_DESCRIBE_TOOL_NAME, operationErrorOf } from "@openshapeforge/operations";
import type {
  RuntimeDeclarativeServiceRequest,
  RuntimeHostOperationRequest,
  RuntimeOperationExecutionResult,
  RuntimeOperationExecutionOptions,
} from "@openshapeforge/plugin-runtime";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveSessionContext } from "../auth/identity.js";
import { OrganizationBindingError } from "../auth/organization-binding.js";
import { hostMcpResource, usesHostOrganizationContext } from "../config/host-organization.js";
import { buildAuthenticateChallenge, canonicalResourceUri, resourcePathOf } from "./protected-resource-metadata.js";
import {
  isOrganizationAlias,
  MCP_MOUNT_PATH,
  ORGANIZATION_MCP_PATH_PREFIX,
} from "./organization-resource.js";
import {
  assertBearerCredential,
  assertJsonRpcContentType,
  McpTransportError,
  SHORT_ADDRESS_VARY,
  withoutCookieIdentity,
} from "./address.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { getGeneratedEntity, assertRecordPermission } from "../operations/entity/index.js";
import {
  deriveToolName,
  inputSchemaFromStoredFields,
  type DerivedToolsCatalogEntry,
} from "./derived-tools.js";
import { canReadClassifiedColumns } from "../graphql/generated-authz.js";
import { headersFromFastify } from "../http/headers.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import { listConnectorContracts } from "../connectors/catalog.js";
import { resolveConnectorTool } from "../connectors/mcp-tools.js";
import type { RuntimeModule } from "../modules/contract.js";
import type { ModuleToolExecutionOptions, ModuleToolExecutionResult } from "../modules/contract.js";
import {
  createMcpAuthorizationHandler,
  interceptMcpToolCall,
  invokeModuleTool,
  moduleResourceAuthorizationOwner,
  moduleToolAuthorizationOwner,
} from "../modules/mcp-hooks.js";
import { type ModulePlatformRuntime } from "../modules/platform.js";
import { parseModuleToolExecutionOptions, type ResolvedInvocationSource } from "../modules/invocation-sources.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import {
  createStatefulMcpSessionContext,
  sameStatefulMcpAuthorization,
  withFreshRelationGroupMemberships,
} from "./stateful-session-authorization.js";
import { carrySessionIdentity, rememberSessionIdentity } from "./session-info.js";
import { clientInfoFromInitializeBody, rememberSessionClient } from "./session-client.js";
import { sessionOpeningSentence } from "./session-opening.js";
import { ENTITY_CATALOG_URI } from "./server-instructions.js";
import {
  catalog,
  catalogDerivedTools,
  catalogGuideTools,
  compatibilityOperationByKey,
  compatibilityToolNames,
  crudToolCanSucceed,
  crudToolsNamed,
  fieldNameForColumn,
  invocableCrudToolsNamed,
  resourcesForSession,
  sessionMayInvoke,
  withholdClassified,
  type CapturedDerivedExecution,
  type GeneratedTable,
  type McpOperation,
  type OperationToolProjection,
} from "./catalog.js";
import { derivedToolOutputFieldAllowlist } from "./derived-session-tools.js";
import {
  assertWritableValues,
  operationMayInvoke,
  projectCatalogOperationTool,
} from "./entity-tool-invocation.js";
import {
  crudToolsForSession,
  describeGenericEntity,
  describeTool,
  entitiesForSession,
  entityResourceUri,
} from "./entity-tool-projection.js";
import {
  ENTITY_CONFIGURATION_APP_URI,
  ENTITY_CONFIGURATION_PATH,
  ENTITY_OAUTH_CALLBACK_PATH,
} from "./handoff-config.js";
import {
  capturePersonalOAuthConnections,
  normalizeConnectionValueRows,
  selectOAuthConnectionRow,
} from "./session-connections.js";
import {
  failed,
  runtimeDeclarativeServiceExecutors,
  runtimeHostOperationExecutors,
  runtimeOperationResult,
  type RuntimeDeclarativeServiceExecutor,
  type RuntimeHostOperationExecutor,
} from "./tool-results.js";
import { registerArtifactUploadRoutes } from "./artifact-upload-routes.js";
import { registerConfigurationHandoffRoutes } from "./configuration-handoff-routes.js";
import { registerEntityOAuthCallbackRoute } from "./entity-oauth-routes.js";
import type { McpRegistrationOptions } from "./route-context.js";
import { createServerScope } from "./server-scope.js";
import { createSessionSurface, type ListedTool } from "./session-surface.js";
import { directToolCall } from "./tool-dispatch.js";
import { hasMcpSurface } from "./catalog.js";

export { MCP_MOUNT_PATH, ORGANIZATION_MCP_PATH_PREFIX } from "./organization-resource.js";







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
export const __crudToolCanSucceedForTests = crudToolCanSucceed;
export const __crudToolsForSessionForTests = crudToolsForSession;
export const __describeGenericEntityForTests = describeGenericEntity;



export { __resetEmployeeInvitationKeycloakClientForTests } from "./employee-invitation-keycloak.js";

function buildServer(
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext,
  modules: readonly RuntimeModule[] | undefined,
  modulePlatform: ModulePlatformRuntime | undefined,
  egressOwner: RuntimeModule["egress"] | undefined,
  onDerivedDefinitionChanged?: (table: string, tenantId: string | null) => void,
  /**
   * Whether this server lives across requests. The guide-before-create gate
   * needs session memory of the guide call, so it enforces only here — a
   * stateless single-shot request could never satisfy it.
   */
  stateful = false,
  tableOverride?: Map<string, GeneratedTable>,
  /**
   * The opening sentence for this session (mcp/session-opening.ts), read
   * before the server is built because it needs the registry; null when the
   * session has no person to name.
   */
  opening: string | null = null,
  /** Core-internal: reuse an already live Operation capability verbatim. */
  moduleSessionOverride?: TrustedSessionContext,
  /** @internal Test-only projection override. */
  operationToolProjectionOverride?: OperationToolProjection,
): Server {
  const scope = createServerScope({
    db, session, modules, modulePlatform, egressOwner, onDerivedDefinitionChanged,
    stateful, tableOverride, opening, moduleSessionOverride, operationToolProjectionOverride,
  });
  const {
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
  } = scope;

  const surface = createSessionSurface(scope);
  const {
    listedResources,
    onboarding,
    updateNotices,
    sessionInfo,
    runtimeProviderToolsForSession,
    listedTools,
  } = surface;

  const dispatchTool = async (
    name: string,
    args: Record<string, unknown>,
    requestId: string | number,
    internal: boolean,
    selectedOptions?: ModuleToolExecutionOptions,
    assertParentInvocationActive?: () => void,
    signal?: AbortSignal,
    bypassInterceptors = false,
    idempotencyKey?: string,
    compatibilityCall = false,
    internalDerivedDefinition?: {
      entry: DerivedToolsCatalogEntry;
      row: Record<string, unknown>;
    },
  ): Promise<ModuleToolExecutionResult> => {
    signal?.throwIfAborted();
    assertParentInvocationActive?.();
    const request = { params: { name, arguments: args } };
    const extra = { requestId };
    // The sections of the call (mcp/tool-dispatch.ts) read the session's
    // scope and surface plus this call's own facts; `current` is read when
    // the call runs, after the listing below resolved it.
    const directCall = (
      _options?: ModuleToolExecutionOptions,
      selected?: ResolvedInvocationSource,
      assertInterceptorActive?: () => void,
    ): Promise<CallToolResult> =>
      directToolCall(
        {
          ...scope,
          ...surface,
          dispatchTool,
          name,
          args,
          requestId,
          internal,
          selectedOptions,
          assertParentInvocationActive,
          signal,
          bypassInterceptors,
          idempotencyKey,
          compatibilityCall,
          internalDerivedDefinition,
          request,
          extra,
          current,
        },
        _options,
        selected,
        assertInterceptorActive,
      );

    let preselectedReference: ResolvedInvocationSource | undefined;
    let current: ListedTool | undefined;
    try {
      signal?.throwIfAborted();
      const initialSelection = parseModuleToolExecutionOptions(selectedOptions);
      if (initialSelection.kind === "reference") {
        if (!internal) {
          throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
        }
        preselectedReference = await sourceVault.resolveReference(
          session,
          name,
          selectedOptions!,
          (reference) => sourceFromReference(
            reference,
            name,
            (request.params.arguments ?? {}) as Record<string, unknown>,
            signal,
          ),
          signal,
        );
        const hidden = preselectedReference?.internal as
          | CapturedDerivedExecution
          | undefined;
        if (!hidden || hidden.operationRow.kind !== "query") {
          throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
        }
        const collidesWithCore =
          name === GENERIC_DESCRIBE_TOOL_NAME ||
          catalog.tools.some((tool) => tool.name === name) ||
          catalog.operationTools.some((tool) => tool.name === name) ||
          catalogDerivedTools.some(
            (entry) =>
              entry.connect?.name === name ||
              entry.dryRun?.name === name ||
              entry.personalization?.set.name === name,
          ) ||
          catalogGuideTools.some((tool) => tool.name === name) ||
          (catalog.discoveryTools ?? []).some((tool) => tool.name === name) ||
          (catalog.testTools ?? []).some((tool) => tool.name === name) ||
          (operationToolProjection.mode === "searchable" &&
            Object.values(searchableOperationToolNames).includes(name)) ||
          resolveConnectorTool(listConnectorContracts(), name, {
            roles: session.roles ?? [],
          }) !== undefined;
        if (collidesWithCore) {
          throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
        }
        if (hidden.entry.execution) {
          current = {
            source: "derived",
            tool: {
              name,
              description: String(
                hidden.serviceRow[hidden.entry.descriptionField] ?? name,
              ),
              inputSchema: inputSchemaFromStoredFields(
                hidden.serviceRow[hidden.entry.inputFieldsField],
                locale,
              ) as Tool["inputSchema"],
            },
          };
        }
      } else {
        signal?.throwIfAborted();
        current = internalDerivedDefinition
          ? {
              source: "derived",
              tool: {
                name,
                description: String(
                  internalDerivedDefinition.row[
                    internalDerivedDefinition.entry.descriptionField
                  ] ?? name,
                ),
                inputSchema: inputSchemaFromStoredFields(
                  internalDerivedDefinition.row[
                    internalDerivedDefinition.entry.inputFieldsField
                  ],
                  locale,
                ) as Tool["inputSchema"],
              },
            }
          : compatibilityCall && compatibilityToolNames.has(name)
          ? {
              source: "operation",
              tool: {
                name,
                description: "Internal compatibility implementation.",
                inputSchema: { type: "object", additionalProperties: true },
              },
            }
          : await (async (): Promise<ListedTool | undefined> => {
              const listed = (await listedTools()).find(
                (entry) => entry.tool.name === name,
              );
              if (listed || operationToolProjection.mode !== "searchable") {
                return listed;
              }
              // Searchable projection bounds tools/list, but a previously
              // integrated client may still call the authored direct name.
              // Reapply the same live availability guard before selecting it.
              const direct = catalog.operationTools.find(
                (tool) => tool.name === name,
              );
              return direct &&
                  operations.has(direct.key) &&
                  operationMayInvoke(direct, session)
                ? { source: "operation", tool: projectCatalogOperationTool(direct) }
                : undefined;
            })();
        signal?.throwIfAborted();
      }
    } catch (error) {
      return {
        result: failed(
          error,
          current?.source !== "crud" || current.tool.outputSchema !== undefined,
        ),
      };
    }
    if (!current) {
      return {
        result: failed(
          new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`),
        ),
      };
    }
    assertParentInvocationActive?.();
    const ctx = invocationContext(extra.requestId);
    const invoke = async (
      options?: ModuleToolExecutionOptions,
      assertInterceptorActive?: () => void,
    ): Promise<ModuleToolExecutionResult> => {
      signal?.throwIfAborted();
      assertParentInvocationActive?.();
      assertInterceptorActive?.();
      const parsedSelection = parseModuleToolExecutionOptions(options);
      if (parsedSelection.kind === "reference" && !internal) {
        throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
      }
      if (preselectedReference && parsedSelection.kind !== "reference") {
        throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
      }
      if (
        current!.source === "module" &&
        parsedSelection.kind !== "none"
      ) {
        throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
      }
      let selected: ResolvedInvocationSource | undefined;
      if (parsedSelection.kind === "reference") {
        const expected = parsedSelection.expectedDefinition;
        if (
          !preselectedReference ||
          parsedSelection.value !== preselectedReference.sourceReference ||
          expected?.kind !== preselectedReference.definition.kind ||
          expected.id !== preselectedReference.definition.id ||
          expected.version !== preselectedReference.definition.version
        ) {
          throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
        }
        // Interceptors are arbitrary async module code. Re-resolve at the
        // execution linearization point so revocation/version/provider/scope
        // changes during an interceptor cannot run the captured stale graph.
        const currentSelection = await sourceVault.resolveReference(
          moduleSession,
          name,
          options!,
          (reference) => sourceFromReference(
            reference,
            name,
            (request.params.arguments ?? {}) as Record<string, unknown>,
            signal,
          ),
          signal,
        );
        if (
          !currentSelection ||
          currentSelection.authorityFingerprint !==
            preselectedReference.authorityFingerprint
        ) {
          throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
        }
        selected = preselectedReference;
      } else if (parsedSelection.kind === "handle") {
        selected = await sourceVault.consumeHandle(
          moduleSession,
          name,
          options!,
          ctx,
          signal,
        );
      }
      assertParentInvocationActive?.();
      assertInterceptorActive?.();
      const selectedCapture = selected?.internal as
        | CapturedDerivedExecution
        | undefined;
      if (
        internal &&
        parsedSelection.kind === "reference" &&
        (!selectedCapture || selectedCapture.operationRow.kind !== "query")
      ) {
        throw new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");
      }
      if (current!.source === "module") {
        return invokeModuleTool(
            current!,
            name,
            (request.params.arguments ?? {}) as Record<string, unknown>,
            ctx,
          );
      }
      const result = await directCall(
        options,
        selected,
        assertInterceptorActive,
      );
      return {
        result,
        ...(selected && !(result as { isError?: boolean }).isError
          ? {
              execution: {
                sourceHandle: selected.sourceHandle,
                sourceReference: selected.sourceReference,
                binding: selected.binding,
                definition: selected.definition,
              },
            }
          : {}),
      };
    };
    try {
      const run = () => bypassInterceptors
        ? invoke(selectedOptions, assertParentInvocationActive)
        : interceptMcpToolCall(
            runtimeModules,
            {
              name,
              source: current.source,
              arguments: (request.params.arguments ?? {}) as Record<string, unknown>,
              ctx,
            },
            (options = selectedOptions, assertActive) =>
              invoke(options, assertActive),
          );
      assertParentInvocationActive?.();
      signal?.throwIfAborted();
      return modulePlatform
        ? await modulePlatform.withActiveInvocation(ctx, run, name)
        : await run();
    } catch (error) {
      return {
        result: failed(
          error,
          current.source !== "crud" || current.tool.outputSchema !== undefined,
        ),
      };
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const outcome = await dispatchTool(
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
      extra.requestId,
      false,
    );
    return outcome.result;
  });

  const executeDeclarativeService: RuntimeDeclarativeServiceExecutor = async (
    request,
    requestId,
    assertInvocationActive,
    signal,
  ) => {
    signal?.throwIfAborted();
    assertInvocationActive?.();
    const toolName = deriveToolName(request.definition.key);
    if (!toolName) {
      return runtimeOperationResult(failed(
        new HttpError(404, "OPERATION_NOT_FOUND", "The declarative Service is unavailable."),
      ));
    }
    const current = await compatibilityDefinition(request) ??
      await derivedDefinition(toolName, true);
    if (!current) {
      return runtimeOperationResult(failed(
        new HttpError(404, "OPERATION_NOT_FOUND", "The declarative Service is unavailable."),
      ));
    }
    const definition = definitionFor(current.entry, current.row);
    if (
      definition.kind !== request.definition.entity ||
      definition.id !== request.definition.id ||
      String(definition.version) !== String(request.definition.version) ||
      String(current.row[current.entry.keyField] ?? "") !== request.definition.key
    ) {
      return runtimeOperationResult(failed(
        new HttpError(404, "OPERATION_NOT_FOUND", "The declarative Service is unavailable."),
      ));
    }
    const selectedOptions = request.sourceReference
      ? {
          sourceReference: request.sourceReference,
          expectedDefinition: definition,
        }
      : undefined;
    const outcome = await dispatchTool(
      toolName,
      request.input ?? {},
      requestId,
      true,
      selectedOptions,
      assertInvocationActive,
      signal,
      true,
      request.idempotencyKey,
      false,
      current,
    );
    return runtimeOperationResult(outcome.result);
  };
  runtimeDeclarativeServiceExecutors.set(server, executeDeclarativeService);

  const executeHostOperation: RuntimeHostOperationExecutor = async (
    request,
    requestId,
    assertInvocationActive,
    signal,
  ) => {
    signal?.throwIfAborted();
    assertInvocationActive?.();
    const implementation = compatibilityOperationByKey.get(request.operation);
    if (!implementation) {
      return runtimeOperationResult(failed(
        new HttpError(404, "OPERATION_NOT_FOUND", "The host Operation is unavailable."),
      ));
    }
    const roles = new Set(session.roles);
    const scopes = new Set(session.oauthScopes ?? []);
    if (
      implementation.auth.mode !== "session" ||
      !implementation.auth.roles.some((role) => roles.has(role)) ||
      !(implementation.auth.scopes ?? []).every((scope) => scopes.has(scope))
    ) {
      return runtimeOperationResult(failed(
        new HttpError(404, "OPERATION_NOT_FOUND", "The host Operation is unavailable."),
      ));
    }
    const outcome = await dispatchTool(
      implementation.toolName,
      request.input ?? {},
      requestId,
      true,
      undefined,
      assertInvocationActive,
      signal,
      true,
      request.idempotencyKey,
      true,
    );
    return runtimeOperationResult(outcome.result);
  };
  runtimeHostOperationExecutors.set(server, executeHostOperation);

  modulePlatform?.registerServer({
    server,
    session: moduleSession,
    liveNotifications: stateful,
    notifyToolsChanged: () => server.sendToolListChanged(),
    notifyResourcesChanged: () => server.sendResourceListChanged(),
    authorize: createMcpAuthorizationHandler(
      runtimeModules,
      moduleSession,
      async ({ action, subject }) => {
        if (subject.kind === "tool") {
          if (action !== "call" && action !== "invoke") {
            return { allowed: false, code: "NOT_FOUND" };
          }
          // A generic `osf_*` name covers several entities, so "may this
          // session call it" is "may it call the operation on ANY of them" —
          // the same question the listing answered when it merged them into
          // one tool. Resolving the name to its first entry instead would
          // authorize every caller against whichever entity sorts first:
          // a pentest-only session asking about `osf_list` was measured
          // against Deal and told NOT_FOUND for a tool it can use.
          const named = crudToolsNamed(subject.name);
          if (named.length > 0) {
            return invocableCrudToolsNamed(subject.name, session, tables)
              .length > 0
              ? { allowed: true }
              : { allowed: false, code: "NOT_FOUND" };
          }
          const current = (await listedTools()).find(
            (entry) =>
              entry.source !== "module" && entry.tool.name === subject.name,
          );
          if (current?.source === "derived") {
            const definition = await derivedDefinition(subject.name, true);
            if (!definition) return { allowed: false, code: "NOT_FOUND" };
            const fieldAllowlist = derivedToolOutputFieldAllowlist(
              definition.entry,
              definition.row,
            );
            return fieldAllowlist === undefined
              ? { allowed: true }
              : { allowed: true, fieldAllowlist };
          }
          if (current) return { allowed: true };
          // Searchable projection keeps tools/list bounded, while an authored
          // direct Operation name remains callable for integrated clients.
          // Authorization must apply the same live handler and role checks as
          // callTool, otherwise the platform denies a tool it will execute.
          if (operationToolProjection.mode === "searchable") {
            const direct = catalog.operationTools.find(
              (tool) => tool.name === subject.name,
            );
            if (
              direct &&
              operations.has(direct.key) &&
              operationMayInvoke(direct, session)
            ) {
              return { allowed: true };
            }
          }
          const internal = await derivedDefinition(subject.name, false);
          if (!internal) return { allowed: false, code: "NOT_FOUND" };
          const fieldAllowlist = derivedToolOutputFieldAllowlist(
            internal.entry,
            internal.row,
          );
          return fieldAllowlist === undefined
            ? { allowed: true }
            : { allowed: true, fieldAllowlist };
        }

        if (subject.kind === "entity-row") {
          const operation =
            action === "read" || action === "get"
              ? "get"
              : action === "update"
                ? "update"
                : action === "delete"
                  ? "delete"
                  : undefined;
          const entity = catalog.entities.find(
            (candidate) => candidate.entity === subject.entity,
          );
          const table = entity ? tables.get(entity.table) : undefined;
          if (!operation || !table || !sessionMayInvoke(table, operation, session)) {
            return { allowed: false, code: "NOT_FOUND" };
          }
          const row = await getGeneratedEntity(db, session, {
            table: table.name,
            id: subject.id,
          });
          if (!row) return { allowed: false, code: "NOT_FOUND" };
          if (operation !== "get") {
            const permission = operation === "update" ? "edit" : "delete";
            if (table.source?.authorization?.recordPermissions) {
              try {
                await assertRecordPermission(
                  db,
                  session,
                  table,
                  subject.id,
                  permission,
                );
              } catch (error) {
                if (
                  operationErrorOf(error)?.code === "FORBIDDEN"
                ) {
                  return { allowed: false, code: "FORBIDDEN" };
                }
                throw error;
              }
            }
            return { allowed: true };
          }
          const includeClassified = canReadClassifiedColumns(
            table.source?.authorization,
            session,
          );
          return {
            allowed: true,
            fieldAllowlist: table.columns
              .filter(
                (column) =>
                  includeClassified || column.classification === undefined,
              )
              .map(fieldNameForColumn),
          };
        }

        if (action !== "read") return { allowed: false, code: "NOT_FOUND" };
        const uri = subject.uri;
        if (
          uri === ENTITY_CATALOG_URI ||
          entitiesForSession(session, tables).some(
            ({ entity }) => entityResourceUri(entity) === uri,
          )
        ) {
          return { allowed: true };
        }
        const resources = resourcesForSession(session, tables);
        if (resources.some((resource) => resource.uri === uri)) {
          return { allowed: true };
        }
        const templated = resources.find(
          (resource) =>
            uri.startsWith(`${resource.uri}/`) &&
            !uri.slice(resource.uri.length + 1).includes("/"),
        );
        if (templated) {
          const table = tables.get(templated.table);
          const id = uri.slice(templated.uri.length + 1);
          if (table && id.length > 0) {
            const row = await getGeneratedEntity(db, session, {
              table: table.name,
              id,
            });
            if (row) return { allowed: true };
          }
        }
        return { allowed: false, code: "NOT_FOUND" };
      },
      async (request) => {
        if (request.subject.kind === "entity-row") return undefined;
        if (request.subject.kind === "tool") {
          if (await coreOwnsDerivedToolName(request.subject.name)) {
            return undefined;
          }
          return moduleToolAuthorizationOwner(
            runtimeModules,
            request.subject.name,
            projectionContext(),
          );
        }
        return moduleResourceAuthorizationOwner(
          runtimeModules,
          request.subject.uri,
          projectionContext(),
          coreResourceOwnership,
        );
      },
    ),
    resolveInvocationSources: async (
      toolName,
      args,
      selector,
      invocationToken,
      signal,
    ) => {
      signal?.throwIfAborted();
      const tool = (await listedTools()).find(
        (entry) => entry.tool.name === toolName,
      );
      if (!tool || tool.source !== "derived") {
        return { sources: [], unavailable: [] };
      }
      return sourceVault.resolve(
        moduleSession,
        toolName,
        selector,
        () => authorizedSources(toolName, true, args, signal),
        invocationToken,
        signal,
      );
    },
    callTool: (
      name,
      args,
      options,
      requestId,
      _invocationToken,
      assertInvocationActive,
      signal,
    ) =>
      dispatchTool(
        name,
        args,
        requestId,
        true,
        options,
        assertInvocationActive,
        signal,
      ),
    endInvocation: (invocationToken) =>
      sourceVault.clearInvocation(invocationToken),
  });

  return server;
}

/**
 * Host adapter around the one declarative engine. It creates no protocol
 * transport: the temporary server object only scopes the existing core
 * catalog/execution closure, while the caller's exact live Operation session
 * remains the authority for database, OAuth, egress and nested Operations.
 */
export function createRuntimeDeclarativeServiceExecutor(input: {
  db: OpenShapeForgeDatabase;
  modules: readonly RuntimeModule[];
  modulePlatform: ModulePlatformRuntime;
  egressOwner?: RuntimeModule["egress"];
  /** @internal Test-only generated-table override. */
  tablesForTests?: Map<string, GeneratedTable>;
}): (
  session: TrustedSessionContext,
  request: RuntimeDeclarativeServiceRequest,
  options?: RuntimeOperationExecutionOptions,
) => Promise<RuntimeOperationExecutionResult> {
  return async (session, request, options) => {
    const server = buildServer(
      input.db,
      session,
      input.modules,
      input.modulePlatform,
      input.egressOwner,
      undefined,
      false,
      input.tablesForTests,
      null,
      session,
    );
    const execute = runtimeDeclarativeServiceExecutors.get(server);
    if (!execute) {
      input.modulePlatform.unregisterServer(server);
      throw new Error("The core declarative Service executor did not initialise.");
    }
    try {
      return await execute(request, randomUUID(), undefined, options?.signal);
    } finally {
      input.modulePlatform.unregisterServer(server);
      runtimeDeclarativeServiceExecutors.delete(server);
    }
  };
}

/**
 * Executes a generated internal compatibility handler by canonical Operation
 * key. The temporary Server scopes existing core state only; no MCP transport
 * or model-visible tool name is created.
 */
export function createRuntimeHostOperationExecutor(input: {
  db: OpenShapeForgeDatabase;
  modules: readonly RuntimeModule[];
  modulePlatform: ModulePlatformRuntime;
  egressOwner?: RuntimeModule["egress"];
}): (
  session: TrustedSessionContext,
  request: RuntimeHostOperationRequest,
  options?: RuntimeOperationExecutionOptions,
) => Promise<RuntimeOperationExecutionResult> {
  return async (session, request, options) => {
    const server = buildServer(
      input.db,
      session,
      input.modules,
      input.modulePlatform,
      input.egressOwner,
      undefined,
      false,
      undefined,
      null,
      session,
    );
    const execute = runtimeHostOperationExecutors.get(server);
    if (!execute) {
      input.modulePlatform.unregisterServer(server);
      throw new Error("The core host Operation executor did not initialise.");
    }
    try {
      return await execute(request, randomUUID(), undefined, options?.signal);
    } finally {
      input.modulePlatform.unregisterServer(server);
      runtimeHostOperationExecutors.delete(server);
      runtimeDeclarativeServiceExecutors.delete(server);
    }
  };
}

/** Direct in-memory transport seam for adversarial runtime-module tests. */
export function __buildGeneratedMcpServerForTests(input: {
  db: OpenShapeForgeDatabase;
  session: TrustedSessionContext;
  modules: readonly RuntimeModule[];
  modulePlatform: ModulePlatformRuntime;
  egressOwner?: RuntimeModule["egress"];
  stateful?: boolean;
  tables?: Map<string, GeneratedTable>;
  operationToolProjection?: OperationToolProjection;
}): Server {
  return buildServer(
    input.db,
    input.session,
    input.modules,
    input.modulePlatform,
    input.egressOwner,
    undefined,
    input.stateful ?? true,
    input.tables,
    null,
    undefined,
    input.operationToolProjection,
  );
}

export function registerGeneratedMcpServer(
  app: FastifyInstance,
  options: McpRegistrationOptions = {},
): void {
  // The transport exists when EITHER surface has something to advertise; a
  // deployment with connectors but no MCP-exposed entity still needs it.
  if (!hasMcpSurface(options.modules ?? [])) {
    return;
  }

  /**
   * The resource a request is addressed to. `/api/mcp` resolves the tenant
   * from the token alone (legacy). `/api/mcp/organizations/<alias>` binds the
   * session to that organization: the token must be a member of it, carry
   * this resource's URL in `aud` and link to a tenant through the registry
   * (auth/organization-binding.ts). A refusal there is a 403 with the same
   * body for every cause, so the path cannot enumerate organizations.
   */
  async function requireMcpSession(request: FastifyRequest): Promise<{
    db: OpenShapeForgeDatabase;
    session: TrustedSessionContext;
    resource: string;
  }> {
    const alias = (request.params as { alias?: unknown } | undefined)?.alias;
    if (usesHostOrganizationContext() && alias !== undefined) {
      throw new HttpError(404, "NOT_FOUND", "Unknown MCP resource.");
    }
    if (alias !== undefined && !isOrganizationAlias(alias)) {
      throw new HttpError(404, "NOT_FOUND", "Unknown MCP resource.");
    }
    const resource = resourcePathOf(request, alias ?? null);
    const binding = alias
      ? { alias, resource: canonicalResourceUri(request, alias) }
      : null;
    // BOLT 1 (mcp/address.ts). The cookie header is dropped rather than
    // ignored on every MCP path — the app shares this origin, so the browser
    // sends its session cookie here whether or not the page meant to — and an
    // organization resource additionally requires a bearer token, which is the
    // one credential a page cannot obtain by merely being open.
    // Order matters twice. The bearer check reads the ORIGINAL headers,
    // because "you sent a cookie and no token" is the case worth naming in
    // the answer and it is invisible once the cookie has been dropped. And it
    // runs BEFORE the media-type check: a client with no credential yet must
    // receive the 401 challenge (RFC 9728) whatever it sent — hosted clients
    // open with a bare POST to discover where to authenticate — and answering
    // that probe with 415 leaves the resource undiscoverable. Nothing is
    // authenticated by this ordering: the credential is only verified after
    // the media type has been accepted below.
    if (binding || usesHostOrganizationContext()) assertBearerCredential(request.headers);
    // BOLT 2 (mcp/address.ts): a JSON-RPC body only under `application/json`.
    // Checked before anything reads the body or verifies the credential, so a
    // refused media type never becomes an authenticated request.
    assertJsonRpcContentType(request.method, request.headers["content-type"]);
    const mcpHeaders = withoutCookieIdentity(request.headers);

    let resolved: TrustedSessionContext;
    try {
      resolved = await resolveSessionContext(headersFromFastify(mcpHeaders), {
        db: options.db,
        ...(binding ? { organization: binding } : {}),
        ...(usesHostOrganizationContext() ? { requiredAudience: hostMcpResource() } : {}),
      });
    } catch (error) {
      if (error instanceof OrganizationBindingError) {
        throw new HttpError(error.status, error.code, error.message);
      }
      throw error;
    }
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
    // session-info (whoami / osf://session): keep the credential's display
    // facts (name, client, expiry, memberships) beside the verified session,
    // and the organization this endpoint bound it to, when it did.
    rememberSessionIdentity(resolved, headersFromFastify(mcpHeaders), binding);
    return {
      db: options.db,
      session: resolved,
      resource,
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

    await registerArtifactUploadRoutes({ instance, options, requireMcpSession });

    instance.setErrorHandler((error, request, reply) => {
      const { status, body } = toHttpError(
        error instanceof McpTransportError
          ? new HttpError(error.status, error.code, error.message)
          : error,
      );
      // One URL, two representations: say so on the failures too, or a cache
      // that saw this answer serves it to the other kind of client.
      void reply.header("vary", SHORT_ADDRESS_VARY);
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
      } else if (status === 403 && body.error.code === "ORGANIZATION_RESOURCE_FORBIDDEN") {
        // RFC 6750 §3.1: the token verified but is not bound to this
        // resource; the challenge names the scopes that would be.
        void reply.header(
          "www-authenticate",
          buildAuthenticateChallenge(request, { insufficientScope: true }),
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
      /** Resource path the session was initialized on; it is not portable. */
      resource: string;
      /**
       * The session context `buildServer` captured at `initialize`. Held so a
       * later request can refresh the display facts hanging off it — see
       * carrySessionIdentity — rather than leaving `whoami` answering with the
       * expiry of the very first access token forever.
       */
      session: TrustedSessionContext;
      tenantId: string;
      userId: string;
      roles: string[];
      oauthScopes: string[];
      groups: string[];
      scope: TrustedSessionContext["scope"];
      credential: TrustedSessionContext["credential"];
      loginSessionBinding?: string;
      lastSeenMs: number;
    };
    const mcpSessions = new Map<string, McpSessionEntry>();
    const SESSION_IDLE_LIMIT_MS = 30 * 60 * 1000;
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of mcpSessions) {
        if (now - entry.lastSeenMs > SESSION_IDLE_LIMIT_MS) {
          mcpSessions.delete(id);
          options.modulePlatform?.unregisterServer(entry.server);
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

    await registerEntityOAuthCallbackRoute({ instance, options, requireMcpSession });

    await registerConfigurationHandoffRoutes({ instance, options, requireMcpSession });

    const handleMcpRequest = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<void> => {
      void reply.header("vary", SHORT_ADDRESS_VARY);
      const { db, session, resource } = await requireMcpSession(request);

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
        // on one resource and stays bound to both. A session id minted on
        // one organization's resource is not a ticket to another's, nor to
        // the legacy mount.
        if (existing.resource !== resource) {
          throw new HttpError(
            403,
            "FORBIDDEN",
            "MCP session was initialized on another MCP resource.",
          );
        }
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
        if (!sameStatefulMcpAuthorization(existing, session)) {
          mcpSessions.delete(sessionId);
          options.modulePlatform?.unregisterServer(existing.server);
          void existing.transport.close();
          void existing.server.close();
          throw new HttpError(
            404,
            "SESSION_NOT_FOUND",
            "Authorization changed; reinitialize the MCP session.",
          );
        }
        existing.lastSeenMs = Date.now();
        // The credential this request carried is newer than the one the
        // session was initialized with — the client refreshes silently — so
        // the display facts move over to the captured context before the
        // server answers from it.
        carrySessionIdentity(existing.session, session);
        reply.hijack();
        await withFreshRelationGroupMemberships(
          session,
          () => existing.transport.handleRequest(
            request.raw,
            reply.raw,
            request.body,
          ),
        );
        return;
      }

      if (request.method === "POST" && isInitializeBody(request.body)) {
        const statefulSession = createStatefulMcpSessionContext(session);
        // What the client says about itself is said once, here; the server
        // built next reads it for its instructions, and `whoami` for the
        // life of the session (mcp/session-client.ts).
        rememberSessionClient(statefulSession, clientInfoFromInitializeBody(request.body));
        const server = buildServer(
          db,
          statefulSession,
          options.modules,
          options.modulePlatform,
          options.egressOwner,
          notifyDerivedDefinitionChanged,
          true,
          undefined,
          await sessionOpeningSentence({ db, session: statefulSession }),
        );
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            mcpSessions.set(id, {
              transport,
              server,
              resource,
              session: statefulSession,
              tenantId: session.tenantId as string,
              userId: session.userId as string,
              roles: [...(session.roles ?? [])],
              oauthScopes: [...(session.oauthScopes ?? [])],
              groups: [...(session.groups ?? [])],
              scope: session.scope,
              credential: session.credential,
              ...(session.loginSessionBinding !== undefined
                ? { loginSessionBinding: session.loginSessionBinding }
                : {}),
              lastSeenMs: Date.now(),
            });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) mcpSessions.delete(transport.sessionId);
          options.modulePlatform?.unregisterServer(server);
        };
        reply.hijack();
        // The SDK declares Transport's optional callbacks as required-when-present,
        // which collides with this repo's exactOptionalPropertyTypes. The cast is
        // to the SDK's own Transport shape and changes no behaviour.
        await server.connect(
          transport as unknown as Parameters<Server["connect"]>[0],
        );
        await withFreshRelationGroupMemberships(
          session,
          () => transport.handleRequest(request.raw, reply.raw, request.body),
        );
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
        options.modulePlatform,
        options.egressOwner,
        notifyDerivedDefinitionChanged,
      );
      // `sessionIdGenerator` is omitted rather than set to undefined: the SDK
      // reads it as `=== undefined` to mean stateless, and omitting keeps
      // exactOptionalPropertyTypes happy.
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      reply.raw.on("close", () => {
        options.modulePlatform?.unregisterServer(server);
        void transport.close();
        void server.close();
      });
      reply.hijack();
      await server.connect(
        transport as unknown as Parameters<Server["connect"]>[0],
      );
      await transport.handleRequest(request.raw, reply.raw, request.body);
    };

    instance.route({
      url: MCP_MOUNT_PATH,
      method: ["GET", "POST", "DELETE"],
      handler: handleMcpRequest,
    });
    // One resource per Keycloak Organization, same server, same handler;
    // what differs is how the session is admitted (requireMcpSession).
    instance.route({
      url: `${ORGANIZATION_MCP_PATH_PREFIX}/:alias`,
      method: ["GET", "POST", "DELETE"],
      handler: handleMcpRequest,
    });
    // The short spellings `/<alias>` and `/<alias>/mcp` arrive here already
    // rewritten to the long URL (roles/api.ts, rewriteUrl), so there is one
    // handler, one set of routes and one parser for the alias. What a client
    // is TOLD the resource is called comes from organizationMcpPath, which is
    // the short form — the long URL is now an internal spelling that also
    // happens to still be reachable from outside.
  });
}

export { hasDynamicModuleToolProjection, hasMcpSurface } from "./catalog.js";

export type { McpOperation, OperationToolProjection } from "./catalog.js";
export { __entityMutationControlsForTests } from "./catalog.js";
export {
  ENTITY_CONFIGURATION_APP_URI,
  ENTITY_CONFIGURATION_PATH,
  ENTITY_OAUTH_CALLBACK_PATH,
  __clientSupportsMcpAppForTests,
  __configurationFallbackLeadForTests,
  __publicOriginIsHttpsForTests,
} from "./handoff-config.js";
export {
  capturePersonalOAuthConnections,
  normalizeConnectionValueRows,
  selectOAuthConnectionRow,
} from "./session-connections.js";
export {
  __describeEntityResourceForTests,
} from "./entity-tool-projection.js";
export {
  __configurationAppResultForTests,
  __configurationHandoffResultForTests,
  __derivedToolResultForTests,
  __failedForTests,
  __nativeToolOutputForTests,
  __okForTests,
  __operationToolResultForTests,
  __partialForTests,
  __unavailableOutcomeForTests,
} from "./tool-results.js";
export { __operationMayInvokeForTests } from "./entity-tool-invocation.js";
