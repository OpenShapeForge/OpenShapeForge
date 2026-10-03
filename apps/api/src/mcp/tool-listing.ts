// SPDX-License-Identifier: BUSL-1.1
/**
 * The tool list of one session. Split out of session-surface.ts, verbatim.
 */
import {
  connectHelperTool,
  dryRunHelperTool,
  personalizationHelperTool,
  uploadToolDefinition,
} from "@openshapeforge/operations";
import { GENERIC_DESCRIBE_TOOL_NAME } from "@openshapeforge/operations";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { derivedHelperAvailable } from "./derived-tools.js";
import { ARTIFACT_UPLOAD_APP_URI } from "./artifact-upload.js";
import { productName } from "../config/product-name.js";
import { EDIT_LEASE_TOOL_NAMES, editLeaseToolsForOperationIds } from "./edit-lease-tools.js";
import { identityLinkToolsForSession } from "./identity-link-tools.js";
import { organizationProfileToolsForSession } from "./organization-profile-tools.js";
import { employeeInvitationToolsForSession } from "./employee-invitation-tools.js";
import { onboardingToolsForSession } from "./onboarding.js";
import { updateToolsForSession } from "./update-notices.js";
import { listConnectorContracts } from "../connectors/catalog.js";
import { connectorToolsForSession } from "../connectors/mcp-tools.js";
import type { McpToolCallSource } from "../modules/contract.js";
import { assertUniqueToolNames, decorateMcpTools, moduleTools } from "../modules/mcp-hooks.js";
import { SESSION_INFO_TOOL, SESSION_INFO_TOOL_NAME } from "./session-info.js";
import { searchableOperationTools } from "./operation-search.js";
import { type ProjectedRuntimeOperationTool, catalog, catalogDerivedTools } from "./catalog.js";
import { projectRuntimeOperationTool } from "./catalog-rows.js";
import { derivedToolsForSession } from "./derived-session-tools.js";
import { operationMayInvoke, projectCatalogOperationTool } from "./entity-tool-invocation.js";
import { crudToolsForSession } from "./generic-tool-projection.js";
import { publicOriginIsHttps, supportsMcpApp } from "./handoff-config.js";
import type { ServerScope } from "./server-scope.js";
import type { ListedTool } from "./session-surface.js";
/**
 * The tool list of one session and the registration of `tools/list`: the
 * core tools in their fixed order, the row-derived and connector tools, the
 * static Operations or the searchable pair, then the modules' tools and
 * decorations, every name checked for uniqueness.
 */
export function createToolListing(scope: ServerScope) {
  const {
    assertModuleToolNamesAvailable,
    canUploadArtifacts,
    db,
    editLeaseOperationIds,
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
  const runtimeProviderToolsForSession = async (): Promise<
    ProjectedRuntimeOperationTool[]
  > => modulePlatform
    ? (await modulePlatform.listRuntimeProviderOperations(moduleSession)).map(
        (definition) => projectRuntimeOperationTool(definition, locale),
      )
    : [];

  /**
   * The derived-tool helpers (connect, preferences, dry run) are assistant-
   * callable under their public names for every derived entry — the ones a
   * plugin registers through execution compatibility too, whose Service
   * rows the Operation runtime projects but whose helpers only this listing
   * can offer. Whether THIS session gets one is derivedHelperAvailable, the
   * rule the dispatch applies too. In the dedicated projection a plugin's
   * own Operation tool of the same name is listed to the session instead
   * (when it would be: handler loaded and roles held) and dispatches to the
   * same handler, so the helper is skipped exactly then.
   */
  const dedicatedOperationListed = (key: string | undefined) => {
    if (operationToolProjection.mode !== "dedicated" || key === undefined) return false;
    const tool = catalog.operationTools.find((candidate) => candidate.key === key);
    return tool !== undefined && operations.has(key) && operationMayInvoke(tool, session);
  };
  const helperEntries = catalogDerivedTools.map((entry) => {
    if (!entry.compatibility) return entry;
    return {
      ...entry,
      ...(dedicatedOperationListed(entry.compatibility.connectOperation) ? { connect: undefined } : {}),
      ...(dedicatedOperationListed(entry.compatibility.dryRunOperation) ? { dryRun: undefined } : {}),
      ...(dedicatedOperationListed(entry.compatibility.setPreferenceOperation)
        ? { personalization: undefined }
        : {}),
    };
  });
  const listedTools = async (): Promise<ListedTool[]> => {
    const runtimeOperationTools = await runtimeProviderToolsForSession();
    const coreTools = [
      SESSION_INFO_TOOL, // session-info (whoami / osf://session): every authenticated session
      ...(canUploadArtifacts
        ? [{
            ...uploadToolDefinition(productName()),
            ...(supportsMcpApp(server) && publicOriginIsHttps()
              ? { _meta: { ui: { resourceUri: ARTIFACT_UPLOAD_APP_URI } } }
              : {}),
          }]
        : []),
      ...crudToolsForSession(session, tables, locale),
      ...editLeaseToolsForOperationIds(editLeaseOperationIds),
      ...helperEntries
        .filter((entry) => derivedHelperAvailable(entry, "connect", session.roles))
        .map((entry) => connectHelperTool(entry.connect!.name, entry.connect!.description)),
      ...helperEntries
        .filter((entry) => derivedHelperAvailable(entry, "personalization", session.roles))
        .map((entry) =>
          personalizationHelperTool(entry.personalization!.set.name, entry.personalization!.set.description),
        ),
      ...helperEntries
        .filter((entry) => derivedHelperAvailable(entry, "dryRun", session.roles))
        .map((entry) => dryRunHelperTool(entry.dryRun!.name, entry.dryRun!.description)),
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
      // The second step of the generic projection is a core tool over the
      // CRUD catalogue, not a row-defined one: classified as such here so the
      // authorization path answers for it as it does for osf_list.
      if (name === GENERIC_DESCRIBE_TOOL_NAME) return "crud";
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
    runtimeProviderToolsForSession,
    listedTools,
  };
}
