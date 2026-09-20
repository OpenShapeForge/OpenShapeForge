// SPDX-License-Identifier: BUSL-1.1
/**
 * The resource reads of one session. Split out of session-surface.ts,
 * verbatim.
 */
import { OperationFailure } from "@openshapeforge/operations";
import { ErrorCode, McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { entityOperationRef, executeEntityOperation } from "../operations/entity/index.js";
import { renderConfigurationApp } from "./configuration-app.js";
import { ARTIFACT_UPLOAD_APP_URI, renderArtifactUploadApp } from "./artifact-upload.js";
import {
  ORGANIZATION_PROFILE_RESOURCE_URI,
  readOrganizationProfileResource,
} from "./organization-profile-tools.js";
import { readOnboardingStepResource } from "./onboarding-resources.js";
import { prepareModuleResourceRead } from "../modules/mcp-hooks.js";
import { SESSION_RESOURCE_URI } from "./session-info.js";
import { sessionInfoResourceResult } from "./session-describe.js";
import { ENTITY_CATALOG_URI } from "./server-instructions.js";
import { JSON_MIME_TYPE, type McpOperation, entityForTable } from "./catalog.js";
import { serializeRowForEntity } from "./catalog-rows.js";
import { resourcesForSession } from "./session-projection.js";
import {
  RESOURCE_READ_LIMIT,
  describeCatalogResource,
  describeEntityResource,
  entitiesForSession,
  entityResourceUri,
} from "./entity-resources.js";
import { ENTITY_CONFIGURATION_APP_URI, MCP_APP_MIME_TYPE, callbackOrigin } from "./handoff-config.js";
import type { ServerScope } from "./server-scope.js";
import type { OnboardingEnvironment } from "./onboarding.js";
/**
 * `resources/read` for one session: the session resource, the organization
 * profile, the onboarding step detail, the entity schema catalogue and the
 * authored entity resources, then the modules' own resources — every read
 * authorized the way the matching tool is.
 */
export function registerResourceReadHandler(
  scope: ServerScope,
  surface: {
    onboarding: OnboardingEnvironment;
    sessionInfo: () => Promise<Parameters<typeof sessionInfoResourceResult>[0]>;
  },
): void {
  const {
    canUploadArtifacts,
    coreResourceOwnership,
    db,
    invocationContext,
    locale,
    modulePlatform,
    operations,
    projectionContext,
    runtimeModules,
    server,
    session,
    tables,
  } = scope;
  const { onboarding, sessionInfo } = surface;
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
}
