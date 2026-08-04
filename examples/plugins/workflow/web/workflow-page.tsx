// SPDX-License-Identifier: BUSL-1.1
/**
 * The server component behind the plugin's `/workflow` route: the list.
 *
 * The route file under `apps/web/src/app/` is compiler-emitted and does nothing
 * but re-export this, so everything with substance stays hand-written,
 * reviewable and typechecked. That split is the point: a generated file that
 * contained the page would put real code in a template string, where the
 * `typecheck:web` gate reads it as one opaque literal.
 *
 * Data comes from the plugin's own GraphQL surface, which the API serves
 * through the runtime half. The read is session-gated like every other one in
 * this app — `executeGraphqlRequest` attaches the caller's context — so an
 * unauthenticated request gets nothing rather than a catalog.
 *
 * ## Why the mutations arrive as props rather than being called from the client
 *
 * They cannot be called from the client at all: `graphql-client.ts` is
 * `server-only`, the app declares no rewrite to the API, and in local
 * development the browser cannot reach its port. So this server component
 * passes server action references down into the list, which is the shape
 * `hooks/use-infinite-list.ts` and the generated entity pages already use.
 *
 * ## The catalog is read here too, for two things
 *
 * A trigger arrives on a definition as a node type (`triggerSchedule`), and the
 * catalog is what turns that into a word. It also fills the empty state: a
 * deployment with no workflows yet has nothing to list, and what a reader needs
 * there is what a workflow could be built out of. Both are recoverable — the
 * list derives its own labels when the catalog cannot be read, rather than the
 * screen failing over a decoration.
 */
import { executeGraphqlRequest } from "../../../../apps/web/src/lib/server/graphql-client";
import {
  archiveWorkflowDefinition,
  createWorkflowDefinition,
  listWorkflowDefinitions,
  renameWorkflowDefinition,
} from "../../../../apps/web/src/features/workflow/actions/workflow-definitions";
import { WorkflowDefinitionList } from "../../../../apps/web/src/features/workflow/components/WorkflowDefinitionList";
import { resolveWorkflowNodePresentation } from "./presentation";
import {
  WorkflowNodeCatalogView,
  type WorkflowNodeTypeView,
} from "./node-catalog-view";

/**
 * No `configFields` on this read. It is by far the largest thing the catalog
 * serves, the inspector is what renders it, and the editor's own read
 * (`workflow-definition-page.tsx`) asks for it there.
 */
const NODE_TYPES = /* GraphQL */ `
  query WorkflowNodeCatalog {
    workflowNodeTypes {
      type
      catalog
      category
      label
      description
      runtimeSupport
    }
  }
`;

export default async function WorkflowPage() {
  const definitions = await listWorkflowDefinitions();

  let nodes: WorkflowNodeTypeView[] = [];
  try {
    const data = await executeGraphqlRequest<{ workflowNodeTypes: WorkflowNodeTypeView[] }>(
      { query: NODE_TYPES },
    );
    nodes = data.workflowNodeTypes ?? [];
  } catch {
    // Deliberately swallowed. The catalog supplies display names for triggers
    // and the empty state's contents; neither is the list, and a screen that
    // refused to show a tenant's workflows because a second query failed would
    // be trading the thing asked for against a decoration.
  }

  // Assembly, not a decision: `resolveWorkflowNodePresentation` already owns
  // the locale fallback, and this is one lookup per catalog row.
  const triggerLabels: Record<string, string> = {};
  for (const node of nodes) {
    triggerLabels[node.type] = resolveWorkflowNodePresentation({
      nodeType: node.type,
      entry: node,
    }).typeLabel;
  }

  if (!definitions.ok) {
    // "No workflows" and "the API did not answer" look identical as an empty
    // table and mean opposite things, so the failure is said out loud.
    return (
      <div className="flex flex-col gap-2 p-6">
        <h1 className="text-2xl font-semibold">Workflows</h1>
        <p className="text-destructive text-sm">
          Workflows could not be read: {definitions.error}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <WorkflowDefinitionList
        definitions={definitions.value}
        triggerLabels={triggerLabels}
        // Read once, here, so the server render and the hydration that follows
        // format every "last edited" against the same instant.
        nowMs={Date.now()}
        create={createWorkflowDefinition}
        rename={renameWorkflowDefinition}
        archive={archiveWorkflowDefinition}
      />
      {definitions.value.length === 0 && nodes.length > 0 ? (
        <WorkflowNodeCatalogView nodes={nodes} />
      ) : null}
    </div>
  );
}
