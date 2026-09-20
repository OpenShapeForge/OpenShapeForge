// SPDX-License-Identifier: BUSL-1.1
import { OperationFailure } from "@openshapeforge/operations";
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import {
  ErrorCode,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { entityOperationRef, executeEntityOperation } from "../operations/entity/index.js";
import { sessionInAudience } from "./derived-tools.js";
import { renderConfigurationApp } from "./configuration-handoff.js";
import {
  ARTIFACT_UPLOAD_APP_URI,
  ARTIFACT_UPLOAD_TOOL_NAME,
  renderArtifactUploadApp,
} from "./artifact-upload.js";
import { productName } from "../config/product-name.js";
import { EDIT_LEASE_TOOL_NAMES, editLeaseToolsForOperationIds } from "./edit-lease-tools.js";
import { identityLinkToolsForSession } from "./identity-link-tools.js";
import {
  ORGANIZATION_PROFILE_RESOURCE,
  ORGANIZATION_PROFILE_RESOURCE_URI,
  organizationProfileToolsForSession,
  readOrganizationProfileResource,
} from "./organization-profile-tools.js";
import { employeeInvitationToolsForSession } from "./employee-invitation-tools.js";
import {
  describeOnboarding,
  onboardingEnvironment,
  onboardingToolsForSession,
  withOnboarding,
} from "./onboarding.js";
import {
  ONBOARDING_STEP_RESOURCE_TEMPLATE,
  onboardingResourcesForSession,
  readOnboardingStepResource,
} from "./onboarding-resources.js";
import {
  describeUpdates,
  updateNoticesStore,
  updateToolsForSession,
  withUpdates,
} from "./update-notices.js";
import { listConnectorContracts } from "../connectors/catalog.js";
import { connectorToolsForSession } from "../connectors/mcp-tools.js";
import type { McpToolCallSource } from "../modules/contract.js";
import {
  assertUniqueToolNames,
  decorateMcpTools,
  moduleResources,
  moduleResourceTemplates,
  moduleTools,
  prepareModuleResourceRead,
  type SourcedTool,
} from "../modules/mcp-hooks.js";
import {
  SESSION_INFO_TOOL,
  SESSION_INFO_TOOL_NAME,
  SESSION_RESOURCE,
  SESSION_RESOURCE_URI,
} from "./session-info.js";
import { describeSession, sessionInfoResourceResult } from "./session-describe.js";
import { ENTITY_CATALOG_URI } from "./server-instructions.js";
import { searchableOperationTools } from "./operation-search.js";
import {
  JSON_MIME_TYPE,
  type McpOperation,
  type ProjectedRuntimeOperationTool,
  catalog,
  discoveryToolsForSession,
  entityForTable,
  guideToolsForSession,
  projectRuntimeOperationTool,
  projectedDerivedTools,
  resourcesForSession,
  serializeRowForEntity,
  testToolsForSession,
} from "./catalog.js";
import { derivedToolsForSession } from "./derived-session-tools.js";
import { operationMayInvoke, projectCatalogOperationTool } from "./entity-tool-invocation.js";
import {
  RESOURCE_READ_LIMIT,
  crudToolsForSession,
  describeCatalogResource,
  describeEntityResource,
  entitiesForSession,
  entityResourceUri,
} from "./entity-tool-projection.js";
import {
  ENTITY_CONFIGURATION_APP_URI,
  ENTITY_OAUTH_CALLBACK_PATH,
  MCP_APP_MIME_TYPE,
  callbackOrigin,
  publicOriginIsHttps,
  supportsMcpApp,
} from "./handoff-config.js";
import { type ServerScope } from "./server-scope.js";
import { runtimeRowsByFilter } from "./session-connections.js";
export type ListedTool = SourcedTool & {
  runtimeOperation?: RuntimeOperationDefinition;
};

/**
 * The read surface of one session: the resource list and reads, the
 * onboarding checklist and update notices that ride on whoami, the session
 * description itself, and the tool list — every request handler that
 * answers from the session's projection without invoking anything.
 *
 * Split out of generated-mcp-server.ts: the body is the former middle of
 * buildServer, verbatim; its type is inferred from what it returns.
 */
export function createSessionSurface(scope: ServerScope) {
  const {
    assertModuleToolNamesAvailable,
    canUploadArtifacts,
    coreResourceOwnership,
    db,
    editLeaseOperationIds,
    guidesCalled,
    invocationContext,
    locale,
    modulePlatform,
    moduleSession,
    operationToolProjection,
    operations,
    projectionContext,
    runtimeModules,
    searchableOperationToolNames,
    searchableStaticOperationIds,
    server,
    session,
    tables,
  } = scope;
  // --- session-info: the list is a named builder so `whoami` can count
  // resources through the same per-session filtering `resources/list` uses. ---
  const listedResources = async () => {
    const entries = entitiesForSession(session, tables);
    const authoredResources = resourcesForSession(session, tables);
    return {
      resources: [
        SESSION_RESOURCE,
        ORGANIZATION_PROFILE_RESOURCE,
        // The detail behind whoami's onboarding index. Static per session:
        // the five step keys are fixed, so listing them gathers no facts —
        // which is what keeps whoami's own resource count cheap.
        ...onboardingResourcesForSession(session),
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
        ...(canUploadArtifacts && supportsMcpApp(server)
          ? [
              {
                uri: ARTIFACT_UPLOAD_APP_URI,
                name: "document-upload-app",
                title: "Document upload",
                description: "Private file picker for document bytes that must not pass through the model.",
                mimeType: MCP_APP_MIME_TYPE,
              },
            ]
          : []),
        ...(await moduleResources(
          runtimeModules,
          projectionContext(),
          coreResourceOwnership,
        )),
      ],
    };
  };
  server.setRequestHandler(ListResourcesRequestSchema, listedResources);
  // ---- first-use onboarding (mcp/onboarding.ts): the checklist reads the
  // same per-session projections tools/list uses, and rides on whoami. ----
  const onboarding = onboardingEnvironment({
    db,
    session,
    tables,
    derivedEntries: projectedDerivedTools,
    projectedTools: () => derivedToolsForSession(db, session, tables, locale),
    guideTools: () => guideToolsForSession(session),
    guidesCalled,
    // The administrator step reads the same contract the create tool and
    // the execution path use: which fields the form asks, which tool
    // creates the row, and the redirect URL an OAuth client must register.
    connectionContract: (connectionTable) => {
      const elicit = entityForTable(connectionTable)?.elicitOnCreate;
      const createTool = catalog.tools.find(
        (tool) => tool.table === connectionTable && tool.operation === "create",
      )?.name;
      return elicit && createTool ? { elicit, createTool } : null;
    },
    tenantConnection: (connectionTable, providerRef, providerId) =>
      runtimeRowsByFilter(db, session, tables, connectionTable, {
        [providerRef]: providerId,
      }).then((rows) => rows.find((row) => !row.ownerUserId) ?? null),
    redirectUri: () => {
      try {
        return `${callbackOrigin()}${ENTITY_OAUTH_CALLBACK_PATH}`;
      } catch {
        return null;
      }
    },
  });
  // ---- end first-use onboarding ----
  // ---- update notices (mcp/update-notices.ts): the same per-session view of
  // the person's own stored instructions, joined with the platform's notices. ----
  const updateNotices = {
    session,
    derivedEntries: projectedDerivedTools,
    rowsByFilter: (
      table: string,
      filter: Record<string, unknown>,
      limit = 200,
    ) => runtimeRowsByFilter(db, session, tables, table, filter, limit),
    store: updateNoticesStore(db, session),
  };
  // ---- end update notices ----
  const sessionInfo = async () =>
    withUpdates(
      withOnboarding(
        await describeSession({
          db,
          session,
          access: async () => ({
            tools: (await listedTools()).length,
            resources: (await listedResources()).resources.length,
          }),
        }),
        await describeOnboarding(onboarding),
      ),
      await describeUpdates(updateNotices),
    );
  // --- end session-info ---

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      ...(onboardingResourcesForSession(session).length > 0
        ? [ONBOARDING_STEP_RESOURCE_TEMPLATE]
        : []),
      ...resourcesForSession(session, tables).map((resource) => ({
        uriTemplate: resource.templateUri,
        name: resource.templateName,
        description: resource.templateDescription,
        mimeType: JSON_MIME_TYPE,
      })),
      ...(await moduleResourceTemplates(
        runtimeModules,
        projectionContext(),
        coreResourceOwnership,
      )),
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const ctx = invocationContext(extra.requestId);
    const moduleRead = await prepareModuleResourceRead(
      runtimeModules,
      request.params.uri,
      projectionContext(),
      ctx,
      coreResourceOwnership,
    );
    const moduleFallback = async () => {
      if (!moduleRead) return undefined;
      return modulePlatform
        ? modulePlatform.withActiveInvocation(ctx, moduleRead)
        : moduleRead();
    };
    const fallbackOrNotFound = async () => {
      const result = await moduleFallback();
      if (result !== undefined) return result;
      throw new McpError(ErrorCode.InvalidParams, "Resource not found.");
    };
    // --- session-info (whoami / osf://session) ---
    if (request.params.uri === SESSION_RESOURCE_URI) {
      return sessionInfoResourceResult(await sessionInfo());
    }
    // --- end session-info ---
    // ---- organization profile (mcp/organization-profile-tools.ts) ----
    if (request.params.uri === ORGANIZATION_PROFILE_RESOURCE_URI) {
      return readOrganizationProfileResource(db, session);
    }
    // ---- end organization profile ----
    // ---- onboarding step detail (mcp/onboarding-resources.ts): the same
    // per-session environment the onboarding TOOLS use, so a resource read is
    // authorized exactly as onboarding_status is. ----
    const onboardingStep = await readOnboardingStepResource(
      request.params.uri,
      onboarding,
    );
    if (onboardingStep) return onboardingStep;
    // ---- end onboarding step detail ----
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
    if (request.params.uri === ARTIFACT_UPLOAD_APP_URI && canUploadArtifacts) {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: MCP_APP_MIME_TYPE,
            text: await renderArtifactUploadApp(),
            _meta: {
              ui: {
                csp: { connectDomains: [callbackOrigin()] },
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
      payload = describeCatalogResource(entries, locale);
    } else if (request.params.uri.startsWith(`${ENTITY_CATALOG_URI}/`)) {
      const entry = entries.find(
        ({ entity }) => entityResourceUri(entity) === request.params.uri,
      );
      if (!entry) return fallbackOrNotFound();
      payload = describeEntityResource(entry, entries, tables, session, locale);
    } else {
      const uri = request.params.uri;
      const readable = resourcesForSession(session, tables);
      const direct = readable.find((resource) => resource.uri === uri);
      if (direct) {
        const table = tables.get(direct.table);
        if (!table) return fallbackOrNotFound();
        const result = await executeEntityOperation(db, session, {
          operation: entityOperationRef(table, "list"),
          offerIntents: (Object.entries(table.source?.mcp?.operations ?? {}) as Array<[
            McpOperation,
            boolean,
          ]>).filter(([, enabled]) => enabled).map(([intent]) => intent),
          input: { limit: RESOURCE_READ_LIMIT },
        });
        if (result.intent !== "list") throw new Error("Unexpected entity result.");
        if ("error" in result) throw new OperationFailure(result.error);
        payload = (table.source?.authoringVersion ?? 1) >= 2
          ? {
              data: {
                ...result.data,
                items: result.data.items.map((item) => ({
                  data: serializeRowForEntity(
                    entityForTable(direct.table),
                    table,
                    item.data,
                  ),
                  operations: item.operations,
                })),
              },
              operations: result.operations,
            }
          : result.data.items.map((item) =>
              serializeRowForEntity(entityForTable(direct.table), table, item.data),
            );
      } else {
        const templated = readable.find((resource) =>
          uri.startsWith(`${resource.uri}/`),
        );
        const id = templated ? uri.slice(templated.uri.length + 1) : "";
        const table = templated ? tables.get(templated.table) : undefined;
        if (templated && table && id.length > 0 && !id.includes("/")) {
          const result = await executeEntityOperation(db, session, {
            operation: entityOperationRef(table, "get"),
            offerIntents: (Object.entries(table.source?.mcp?.operations ?? {}) as Array<[
              McpOperation,
              boolean,
            ]>).filter(([, enabled]) => enabled).map(([intent]) => intent),
            input: { id },
          });
          if (result.intent !== "get") throw new Error("Unexpected entity result.");
          if ("error" in result) throw new OperationFailure(result.error);
          if (result.data) {
            const data = serializeRowForEntity(
              entityForTable(templated.table),
              table,
              result.data,
            );
            payload = (table.source?.authoringVersion ?? 1) >= 2
              ? { data, operations: result.operations }
              : data;
          }
        }
        if (payload === undefined) {
          return fallbackOrNotFound();
        }
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

  const runtimeProviderToolsForSession = async (): Promise<
    ProjectedRuntimeOperationTool[]
  > => modulePlatform
    ? (await modulePlatform.listRuntimeProviderOperations(moduleSession)).map(
        (definition) => projectRuntimeOperationTool(definition, locale),
      )
    : [];

  const listedTools = async (): Promise<ListedTool[]> => {
    const runtimeOperationTools = await runtimeProviderToolsForSession();
    const coreTools = [
      SESSION_INFO_TOOL, // session-info (whoami / osf://session): every authenticated session
      ...(canUploadArtifacts
        ? [{
            name: ARTIFACT_UPLOAD_TOOL_NAME,
            title: "Upload document file",
            description:
              `Open a private file picker so the person can upload document bytes directly to ${productName()}. Use the returned artifactId in the requested create operation.`,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: false,
            },
            ...(supportsMcpApp(server) && publicOriginIsHttps()
              ? { _meta: { ui: { resourceUri: ARTIFACT_UPLOAD_APP_URI } } }
              : {}),
          }]
        : []),
      ...crudToolsForSession(session, tables, locale),
      ...editLeaseToolsForOperationIds(editLeaseOperationIds),
      ...projectedDerivedTools
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
                  "Name of the tool to connect.",
              },
              connectionScope: {
                type: "string",
                enum: ["personal", "organization"],
                description:
                  "Connect your own account (default) or an organization-managed shared account. Organization scope requires an administrator role.",
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
      ...projectedDerivedTools
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
      ...projectedDerivedTools
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
      // ---- identity ↔ Relation link (mcp/identity-link-tools.ts) ----
      ...identityLinkToolsForSession(session),
      // ---- end identity ↔ Relation link ----
      // ---- organization profile (mcp/organization-profile-tools.ts) ----
      ...organizationProfileToolsForSession(session),
      // ---- end organization profile ----
      // ---- employee invitations (mcp/employee-invitation-tools.ts) ----
      ...employeeInvitationToolsForSession(session),
      // ---- end employee invitations ----
      // ---- first-use onboarding (mcp/onboarding.ts) ----
      ...onboardingToolsForSession(session),
      // ---- end first-use onboarding ----
      // ---- update notices (mcp/update-notices.ts) ----
      ...updateToolsForSession(session),
      // ---- end update notices ----
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
      ...(await derivedToolsForSession(db, session, tables, locale)).map((tool) => ({
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
      ...(operationToolProjection.mode === "dedicated"
        ? catalog.operationTools
            .filter(
              (tool) =>
                operations.has(tool.key) && operationMayInvoke(tool, session),
            )
            .map(projectCatalogOperationTool)
        : modulePlatform && searchableStaticOperationIds.size > 0
        ? searchableOperationTools(searchableOperationToolNames)
        : []),
    ] as Tool[];
    const sourceOf = (name: string): McpToolCallSource => {
      if (name === SESSION_INFO_TOOL_NAME) return "operation"; // session-info
      if (EDIT_LEASE_TOOL_NAMES.includes(name as (typeof EDIT_LEASE_TOOL_NAMES)[number])) {
        return "operation";
      }
      if (catalog.tools.some((tool) => tool.name === name)) return "crud";
      if (catalog.operationTools.some((tool) => tool.name === name))
        return "operation";
      if (
        operationToolProjection.mode === "searchable" &&
        Object.values(searchableOperationToolNames).includes(name)
      )
        return "operation";
      if (
        connectorToolsForSession(listConnectorContracts(), {
          roles: session.roles ?? [],
        }).some((tool) => tool.name === name)
      ) {
        return "connector";
      }
      return "derived";
    };
    const projectedModuleTools = await moduleTools(
      runtimeModules,
      projectionContext(),
    );
    await assertModuleToolNamesAvailable(projectedModuleTools);
    const sourced: ListedTool[] = [
      ...coreTools.map((tool) => ({ tool, source: sourceOf(tool.name) })),
      ...runtimeOperationTools.map(({ definition, tool }) => ({
        tool,
        source: "operation" as const,
        runtimeOperation: definition,
      })),
      ...projectedModuleTools,
    ];
    assertUniqueToolNames(sourced);
    const decorated = decorateMcpTools(
      sourced,
      runtimeModules,
      projectionContext(),
    );
    assertUniqueToolNames(decorated);
    return decorated as ListedTool[];
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await listedTools()).map((entry) => entry.tool),
  }));

  return {
    listedResources,
    onboarding,
    updateNotices,
    sessionInfo,
    runtimeProviderToolsForSession,
    listedTools,
  };
}

export type SessionSurface = ReturnType<typeof createSessionSurface>;
