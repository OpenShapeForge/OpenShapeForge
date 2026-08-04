// SPDX-License-Identifier: BUSL-1.1
/**
 * The server component behind the plugin's `/workflow` route.
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
 * ## Why the mutations arrive as props rather than being called from the editor
 *
 * They cannot be called from the client at all: `graphql-client.ts` is
 * `server-only`, the app declares no rewrite to the API, and in local
 * development the browser cannot reach its port. So this server component
 * passes server action references down into the editor, which is the shape
 * `hooks/use-infinite-list.ts` and the generated entity pages already use.
 */
import { executeGraphqlRequest } from "../../../../apps/web/src/lib/server/graphql-client";
import {
  acquireWorkflowDefinitionLock,
  listWorkflowDefinitions,
  loadWorkflowDefinitionDraft,
  publishWorkflowDefinitionVersion,
  readWorkflowDefinitionLock,
  releaseWorkflowDefinitionLock,
  saveWorkflowDefinitionVersion,
  stealWorkflowDefinitionLock,
  validateWorkflowDefinition,
} from "../../../../apps/web/src/features/workflow/actions/workflow-definitions";
import {
  WorkflowEditor,
  type WorkflowEditorNodeType,
} from "../../../../apps/web/src/features/workflow/components/editor/WorkflowEditor";
import {
  WorkflowNodeCatalogView,
  type WorkflowNodeTypeView,
} from "./node-catalog-view";

/**
 * `configFields` is on this read and not on the catalog screen's own, because
 * the inspector renders it. It is by far the largest thing the catalog serves
 * and a screen that only lists node types has no use for it.
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
      configFields
    }
  }
`;

type CatalogEntry = WorkflowNodeTypeView & { configFields: unknown };

export default async function WorkflowPage() {
  let nodes: CatalogEntry[] = [];
  try {
    const data = await executeGraphqlRequest<{ workflowNodeTypes: CatalogEntry[] }>({
      query: NODE_TYPES,
    });
    nodes = data.workflowNodeTypes ?? [];
  } catch (error) {
    // A catalog that cannot be read is worth saying out loud rather than
    // rendering as an empty one: "no node types" and "the API did not answer"
    // look identical on screen and mean opposite things.
    return (
      <div className="flex flex-col gap-2 p-6">
        <h1 className="text-2xl font-semibold">Workflows</h1>
        <p className="text-destructive text-sm">
          The node catalog could not be read:{" "}
          {error instanceof Error ? error.message : String(error)}
        </p>
      </div>
    );
  }

  // The first definition, because this route has no list screen yet and the
  // designer needs something to open. Choosing WHICH definition to edit belongs
  // to a definition list, which is its own slice.
  const definitions = await listWorkflowDefinitions();
  const first = definitions.ok ? definitions.value[0] : undefined;
  const draft = first ? await loadWorkflowDefinitionDraft(first.id) : null;

  if (!first || !draft || !draft.ok) {
    return (
      <div className="flex flex-col">
        <section className="flex flex-col gap-2 border-b border-border p-6">
          <h1 className="text-2xl font-semibold">Workflows</h1>
          <p className="text-muted-foreground text-sm">
            {!definitions.ok
              ? `Definitions could not be read: ${definitions.error}`
              : !first
                ? "No workflow definitions exist yet, so there is nothing to open. The catalog below is what one would be built from."
                : `That definition could not be opened: ${draft && !draft.ok ? draft.error : "unknown reason"}`}
          </p>
        </section>
        <WorkflowNodeCatalogView nodes={nodes} />
      </div>
    );
  }

  const nodeTypes: WorkflowEditorNodeType[] = nodes;

  return (
    // The designer fills the viewport below the app shell's header: a canvas
    // that scrolls with the page cannot be panned, because the wheel belongs to
    // whichever of the two is taller.
    <div className="flex h-[calc(100vh-4rem)] min-h-0 flex-col">
      <WorkflowEditor
        definition={draft.value.definition}
        graph={draft.value.version?.definition ?? { nodes: [], edges: [] }}
        version={draft.value.version?.version ?? null}
        nodeTypes={nodeTypes}
        save={saveWorkflowDefinitionVersion}
        publish={publishWorkflowDefinitionVersion}
        validate={validateWorkflowDefinition}
        lockActions={{
          read: readWorkflowDefinitionLock,
          acquire: acquireWorkflowDefinitionLock,
          steal: stealWorkflowDefinitionLock,
          release: releaseWorkflowDefinitionLock,
        }}
      />
    </div>
  );
}
