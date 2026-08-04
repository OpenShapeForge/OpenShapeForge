// SPDX-License-Identifier: BUSL-1.1
/**
 * The server component behind `/workflow/[id]`: one definition, in the editor.
 *
 * The editor used to open `workflowDefinitions()[0]` because `/workflow` was
 * the only route the plugin emitted and there was no way to say which
 * definition was meant. The id is now in the URL, so the editor opens what it
 * was asked for — and a second definition becomes something an author can make
 * and then reach.
 *
 * Two route files are emitted for this plugin and both are bare re-exports; the
 * pages live here, where `typecheck:web` reads them as source. See
 * `WEB_ROUTE_FILES` in the plugin's `index.ts`.
 *
 * ## Every link out of here is a plain anchor
 *
 * `next/link` is not importable from this directory. A bare specifier resolves
 * from `examples/plugins/workflow/node_modules`, which holds what this
 * package.json declares — `react`, pinned to the app's copy, and nothing else.
 * Depending on `next` here to get a client-side transition on a link a user
 * follows once per editing session is not worth adding a framework to a
 * plugin's dependency set. Everything with real interaction is a component in
 * `apps/web`, where the framework already is.
 */
import { executeGraphqlRequest } from "../../../../apps/web/src/lib/server/graphql-client";
import {
  acquireWorkflowDefinitionLock,
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

/**
 * `configFields` IS on this read, unlike the list's: the inspector renders it,
 * and it is by far the largest thing the catalog serves.
 */
const NODE_TYPES = /* GraphQL */ `
  query WorkflowEditorNodeCatalog {
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

/** Next hands a dynamic segment over as a promise. */
type WorkflowDefinitionPageProps = {
  params: Promise<{ id: string }>;
};

export default async function WorkflowDefinitionPage({
  params,
}: WorkflowDefinitionPageProps) {
  const { id } = await params;

  const draft = await loadWorkflowDefinitionDraft(id);
  if (!draft.ok) {
    // Not `notFound()`: that lives in `next/navigation`, which this directory
    // cannot import (see the header). A missing definition and an unreachable
    // API both land here, and the message is the API's own — "No workflow
    // definition with id …" for the first, a transport failure for the second.
    return <Failure message={draft.error} />;
  }

  let nodeTypes: WorkflowEditorNodeType[] = [];
  try {
    const data = await executeGraphqlRequest<{ workflowNodeTypes: WorkflowEditorNodeType[] }>(
      { query: NODE_TYPES },
    );
    nodeTypes = data.workflowNodeTypes ?? [];
  } catch (error) {
    // Fatal here, unlike on the list. The catalog is what the palette offers
    // and what the inspector renders a node's config from, so an editor without
    // it is a canvas that can draw what is already there and add nothing.
    return (
      <Failure
        message={`The node catalog could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`}
      />
    );
  }

  return (
    // The designer fills the viewport below the app shell's header: a canvas
    // that scrolls with the page cannot be panned, because the wheel belongs to
    // whichever of the two is taller.
    <div className="flex h-[calc(100vh-4rem)] min-h-0 flex-col">
      <nav className="border-b border-border px-4 py-2 text-sm">
        <a href="/workflow" className="text-muted-foreground hover:underline">
          ← All workflows
        </a>
      </nav>
      <div className="min-h-0 flex-1">
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
    </div>
  );
}

function Failure({ message }: { message: string }) {
  return (
    <div className="flex flex-col gap-2 p-6">
      <h1 className="text-2xl font-semibold">Workflow</h1>
      <p className="text-destructive text-sm">{message}</p>
      <a href="/workflow" className="text-sm hover:underline">
        ← All workflows
      </a>
    </div>
  );
}
