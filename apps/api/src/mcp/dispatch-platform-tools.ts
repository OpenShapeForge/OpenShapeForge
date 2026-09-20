// SPDX-License-Identifier: BUSL-1.1
import { employeeInvitationKeycloakClient } from "./employee-invitation-keycloak.js";
import { getGeneratedEntity } from "../operations/entity/index.js";
import { testElicitedRow } from "./connection-test.js";
import { discoverProviderSchema } from "./discovery.js";
import { HttpError } from "../rest/http-error.js";
import { callIdentityLinkTool } from "./identity-link-tools.js";
import { callOrganizationProfileTool } from "./organization-profile-tools.js";
import { callEmployeeInvitationTool } from "./employee-invitation-tools.js";
import { callOnboardingTool } from "./onboarding.js";
import { callUpdateTool } from "./update-notices.js";
import {
  catalog,
  catalogDiscoveryTools,
  catalogGuideTools,
  catalogTestTools,
  entityForTable,
  guideToolsForSession,
  serializeRow,
  sessionMayInvoke,
} from "./catalog.js";
import { runtimeRowByFilter, runtimeRowsByFilter } from "./session-connections.js";
import { type ToolResult, failed, ok } from "./tool-results.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DirectCallScope } from "./tool-dispatch.js";

/**
 * The platform-tool section of tool dispatch. Split out of generated-mcp-server.ts.
 */

/**
 * The platform tools: identity link, organization profile, employee
 * invitations, first-use onboarding, update notices, guides, discovery and
 * connection tests.
 */
export async function platformToolCall(
  ctx: DirectCallScope,
): Promise<CallToolResult | undefined> {
  const {
    db,
    egressOwner,
    guidesCalled,
    name,
    onboarding,
    request,
    session,
    tables,
    updateNotices,
  } = ctx;
  // ---- identity ↔ Relation link (mcp/identity-link-tools.ts) ----
  const identityLinkOutcome = await callIdentityLinkTool(
    name,
    (request.params.arguments ?? {}) as Record<string, unknown>,
    db,
    session,
  );
  if (identityLinkOutcome) return identityLinkOutcome as ToolResult;
  // ---- end identity ↔ Relation link ----

  // ---- organization profile (mcp/organization-profile-tools.ts) ----
  const organizationProfileOutcome = await callOrganizationProfileTool(
    name,
    (request.params.arguments ?? {}) as Record<string, unknown>,
    db,
    session,
  );
  if (organizationProfileOutcome) return organizationProfileOutcome as ToolResult;
  // ---- end organization profile ----

  // ---- employee invitations (mcp/employee-invitation-tools.ts) ----
  const employeeInvitationOutcome = await callEmployeeInvitationTool(
    name,
    (request.params.arguments ?? {}) as Record<string, unknown>,
    db,
    session,
    employeeInvitationKeycloakClient(),
  );
  if (employeeInvitationOutcome) return employeeInvitationOutcome as ToolResult;
  // ---- end employee invitations ----

  // ---- first-use onboarding (mcp/onboarding.ts) ----
  const onboardingOutcome = await callOnboardingTool(
    name,
    (request.params.arguments ?? {}) as Record<string, unknown>,
    onboarding,
  );
  if (onboardingOutcome) return onboardingOutcome as ToolResult;
  // ---- end first-use onboarding ----

  // ---- update notices (mcp/update-notices.ts) ----
  const updateOutcome = await callUpdateTool(
    name,
    (request.params.arguments ?? {}) as Record<string, unknown>,
    updateNotices,
  );
  if (updateOutcome) return updateOutcome as ToolResult;
  // ---- end update notices ----

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
      const serialized = serializeRow(table, row);
      // The platform-owned native provider has no schema document to
      // fetch: its "API" is this deployment's own generated operation
      // catalog, listed the way a Capability's operation.nativeOperation
      // names them and filtered to what this session may invoke.
      if (serialized.transport === "native") {
        const operations = catalog.tools
          .filter((tool) => {
            const toolTable = tables.get(tool.table);
            return toolTable
              ? sessionMayInvoke(toolTable, tool.operation, session)
              : false;
          })
          .map((tool) => ({
            nativeOperation: tool.operationId ?? tool.name,
            ...(tool.operationId && tool.operationId !== tool.name
              ? { legacyNativeOperation: tool.name }
              : {}),
            operation: tool.operation,
            entity: tool.entity,
            description: tool.description,
          }));
        return ok({
          discovery: "native",
          operationCount: operations.length,
          operations,
        });
      }
      return ok(
        await discoverProviderSchema(serialized, fetch, {
          owner: egressOwner,
          purpose: "discovery",
          scope: {
            tenantId: session.tenantId,
            actorId: session.userId,
            provider: String(serialized.id ?? discoveryTool.entity),
            operation: "discover_schema",
            kind: "query",
          },
        }),
      );
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
          egress: {
            owner: egressOwner,
            purpose: "probe",
            scope: {
              tenantId: session.tenantId,
              actorId: session.userId,
              provider: String(sourceRow.id ?? testTool.entity),
              operation: "test_connection",
              kind: "query",
            },
          },
        }),
      );
    } catch (error) {
      return failed(error);
    }
  }

  // The second step of the generic projection: the exact per-entity schema
  // the compact `osf_*` listing only summarises.
  return undefined;
}
