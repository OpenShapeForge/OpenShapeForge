// SPDX-License-Identifier: BUSL-1.1
/**
 * The session's registration with the module platform. Split out of
 * generated-mcp-server.ts, verbatim.
 */
import { operationErrorOf } from "@openshapeforge/operations";
import { getGeneratedEntity, assertRecordPermission } from "../operations/entity/index.js";
import { canReadClassifiedColumns } from "../graphql/generated-authz.js";
import {
  createMcpAuthorizationHandler,
  moduleResourceAuthorizationOwner,
  moduleToolAuthorizationOwner,
} from "../modules/mcp-hooks.js";
import { ENTITY_CATALOG_URI } from "./server-instructions.js";
import { fieldNameForColumn } from "./catalog-rows.js";
import { catalog, crudToolsNamed } from "./catalog.js";
import { derivedToolOutputFieldAllowlist } from "./derived-session-tools.js";
import { entitiesForSession, entityResourceUri } from "./entity-resources.js";
import { operationMayInvoke } from "./entity-tool-invocation.js";
import { invocableCrudToolsNamed, resourcesForSession, sessionMayInvoke } from "./session-projection.js";
import type { ServerScope } from "./server-scope.js";
import type { SessionSurface } from "./session-surface.js";
import type { DispatchTool } from "./tool-dispatch.js";

/**
 * What the session's server registers with the module platform: the
 * authorization handler modules ask, the invocation-source resolution, and
 * the tool call and invocation end the platform routes back to this session.
 */
export function registerSessionWithPlatform(
  scope: ServerScope,
  surface: SessionSurface,
  dispatchTool: DispatchTool,
): void {
  const {
    authorizedSources,
    coreOwnsDerivedToolName,
    coreResourceOwnership,
    db,
    derivedDefinition,
    modulePlatform,
    moduleSession,
    operationToolProjection,
    operations,
    projectionContext,
    runtimeModules,
    server,
    session,
    sourceVault,
    stateful,
    tables,
  } = scope;
  const {
    listedTools,
  } = surface;
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
}
