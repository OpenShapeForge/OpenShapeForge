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
 * concern, none above four hundred lines:
 *
 *   catalog.ts, catalog-rows.ts,        the compiled catalogue, its rows and
 *   session-projection.ts               what a session is shown of it
 *   entity-tool-projection.ts,          how entity tools and resources are
 *   generic-tool-projection.ts,         described, the shared osf_* tools in
 *   entity-resources.ts                 their two-step projection
 *   derived-session-tools.ts,           the row-defined tools a session sees
 *   session-connections.ts              and connections as execution reads them
 *   handoff-config.ts, tool-schema.ts   handoff configuration, envelope validation
 *   tool-results.ts, composed-results.ts, the shapes a call answers with
 *   handoff-results.ts
 *   entity-tool-guards.ts,              the checks and execution of an entity
 *   entity-tool-invocation.ts           CRUD tool
 *   server-scope.ts, derived-definitions.ts, what one session's server is
 *   invocation-source-resolution.ts     built from
 *   session-surface.ts, tool-listing.ts, resources, whoami, onboarding, the
 *   resource-read-handler.ts            tool list
 *   tool-dispatcher.ts, tool-dispatch.ts, one tool call: the entry, the
 *   dispatch-*.ts                       sections and the steps of a call
 *   session-executors.ts,               what the session registers with the
 *   platform-registration.ts,           Operation runtime and the module
 *   runtime-executors.ts                platform
 *   session-admission.ts,               how a request is admitted and the
 *   transport-sessions.ts               stateful transport sessions
 *   *-routes.ts, route-context.ts       the browser-facing routes
 */
import { createMcpSessionAdmission } from "./session-admission.js";
import { createTransportSessions } from "./transport-sessions.js";
import { registerSessionWithPlatform } from "./platform-registration.js";
import { registerSessionExecutors } from "./session-executors.js";
import { createDispatchTool } from "./tool-dispatcher.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";
import { buildAuthenticateChallenge } from "./protected-resource-metadata.js";
import { MCP_MOUNT_PATH, ORGANIZATION_MCP_PATH_PREFIX } from "./organization-resource.js";
import { McpTransportError, SHORT_ADDRESS_VARY } from "./address.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import type { RuntimeModule } from "../modules/contract.js";
import { type ModulePlatformRuntime } from "../modules/platform.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import {
  type GeneratedTable,
  type McpOperation,
  type OperationToolProjection,
} from "./catalog.js";
import {
  crudToolCanSucceed,
  resourcesForSession,
  sessionMayInvoke,
  withholdClassified,
} from "./session-projection.js";
import { assertWritableValues } from "./entity-tool-guards.js";
import { describeTool } from "./entity-tool-projection.js";
import { crudToolsForSession, describeGenericEntity } from "./generic-tool-projection.js";
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
import { registerArtifactUploadRoutes } from "./artifact-upload-routes.js";
import { registerConfigurationHandoffRoutes } from "./configuration-handoff-routes.js";
import { registerEntityOAuthCallbackRoute } from "./entity-oauth-routes.js";
import type { McpRegistrationOptions } from "./route-context.js";
import { createServerScope } from "./server-scope.js";
import { createSessionSurface } from "./session-surface.js";
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

/** The session server builder, as the transport sessions call it. */
export type BuildServer = typeof buildServer;

export function buildServer(
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
  const { server } = scope;

  const surface = createSessionSurface(scope);

  const dispatchTool = createDispatchTool(scope, surface);

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const outcome = await dispatchTool(
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
      extra.requestId,
      false,
    );
    return outcome.result;
  });

  registerSessionExecutors(scope, dispatchTool);

  registerSessionWithPlatform(scope, surface, dispatchTool);

  return server;
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

  const requireMcpSession = createMcpSessionAdmission(options);

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

    await registerEntityOAuthCallbackRoute({ instance, options, requireMcpSession });

    await registerConfigurationHandoffRoutes({ instance, options, requireMcpSession });

    const { handleMcpRequest } = createTransportSessions({ options, requireMcpSession, buildServer });

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
export { __entityMutationControlsForTests } from "./catalog-rows.js";
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
export { __describeEntityResourceForTests } from "./entity-resources.js";
export { __failedForTests, __okForTests, __operationToolResultForTests } from "./tool-results.js";
export {
  __derivedToolResultForTests,
  __nativeToolOutputForTests,
  __partialForTests,
  __unavailableOutcomeForTests,
} from "./composed-results.js";
export {
  __configurationAppResultForTests,
  __configurationHandoffResultForTests,
} from "./handoff-results.js";
export { __operationMayInvokeForTests } from "./entity-tool-invocation.js";
