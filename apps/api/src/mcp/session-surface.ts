// SPDX-License-Identifier: BUSL-1.1
import { registerResourceReadHandler } from "./resource-read-handler.js";
import { createToolListing } from "./tool-listing.js";
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ARTIFACT_UPLOAD_APP_URI } from "./artifact-upload.js";
import { ORGANIZATION_PROFILE_RESOURCE } from "./organization-profile-tools.js";
import {
  describeOnboarding,
  onboardingEnvironment,
  onboardingToolProjection,
  withOnboarding,
} from "./onboarding.js";
import {
  ONBOARDING_STEP_RESOURCE_TEMPLATE,
  onboardingResourcesForSession,
} from "./onboarding-resources.js";
import { describeUpdates, updateNoticesStore, withUpdates } from "./update-notices.js";
import { moduleResources, moduleResourceTemplates, type SourcedTool } from "../modules/mcp-hooks.js";
import { SESSION_RESOURCE } from "./session-info.js";
import { describeSession } from "./session-describe.js";
import { ENTITY_CATALOG_URI } from "./server-instructions.js";
import {
  JSON_MIME_TYPE,
  catalog,
  catalogDerivedTools,
  entityForTable,
  projectedDerivedTools,
} from "./catalog.js";
import { resourcesForSession } from "./session-projection.js";
import { derivedToolsForSession } from "./derived-session-tools.js";
import { entitiesForSession, entityResourceUri } from "./entity-resources.js";
import {
  ENTITY_CONFIGURATION_APP_URI,
  ENTITY_OAUTH_CALLBACK_PATH,
  MCP_APP_MIME_TYPE,
  callbackOrigin,
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
  const { runtimeProviderToolsForSession, listedTools } = createToolListing(scope);
  // ---- first-use onboarding (mcp/onboarding.ts): the checklist reads the
  // same per-session projections tools/list uses, and rides on whoami. ----
  const onboarding = onboardingEnvironment({
    db,
    session,
    tables,
    derivedEntries: catalogDerivedTools,
    projectedTools: async () =>
      onboardingToolProjection(
        catalogDerivedTools,
        await derivedToolsForSession(db, session, tables, locale),
        (await runtimeProviderToolsForSession()).map(({ definition, tool }) => ({
          name: tool.name,
          entityName: definition.entityName,
          entityId: definition.entityId,
        })),
      ),
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

  registerResourceReadHandler(scope, { onboarding, sessionInfo });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [],
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
