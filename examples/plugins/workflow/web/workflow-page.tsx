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
 */
import { executeGraphqlRequest } from "../../../../apps/web/src/lib/server/graphql-client";
import { WorkflowGraphView } from "../../../../apps/web/src/features/workflow/components/WorkflowGraphView";
import {
  WorkflowNodeCatalogView,
  type WorkflowNodeTypeView,
} from "./node-catalog-view";

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

/**
 * The most recently published definition, if this deployment has one.
 *
 * `publishedWorkflowDefinitions` rather than all of them: an unpublished draft
 * has no version to read a graph from, so it would render an empty canvas and
 * look like a bug.
 */
const PUBLISHED_DEFINITIONS = /* GraphQL */ `
  query PublishedWorkflowDefinitions {
    publishedWorkflowDefinitions {
      id
      name
      publishedVersion
    }
  }
`;

const PUBLISHED_VERSION = /* GraphQL */ `
  query LatestPublishedVersion($definitionId: ID!) {
    latestPublishedWorkflowDefinitionVersion(definitionId: $definitionId) {
      version
      definition
    }
  }
`;

type PublishedDefinition = { id: string; name: string; publishedVersion: number | null };

/**
 * Read the graph of whichever definition is published, for the canvas to draw.
 *
 * Returns null rather than throwing on any failure: the catalog below is the
 * page's real content and must render even when there is nothing to draw, or
 * when the definition surface is unreachable. A canvas is an addition to this
 * page, not a precondition for it.
 */
async function loadPublishedGraph(): Promise<{ name: string; graph: unknown } | null> {
  try {
    const list = await executeGraphqlRequest<{
      publishedWorkflowDefinitions: PublishedDefinition[];
    }>({ query: PUBLISHED_DEFINITIONS });

    const first = (list.publishedWorkflowDefinitions ?? [])[0];
    if (!first) return null;

    const version = await executeGraphqlRequest<{
      latestPublishedWorkflowDefinitionVersion: { definition: unknown } | null;
    }>({ query: PUBLISHED_VERSION, variables: { definitionId: first.id } });

    const graph = version.latestPublishedWorkflowDefinitionVersion?.definition;
    return graph ? { name: first.name, graph } : null;
  } catch {
    return null;
  }
}

export default async function WorkflowPage() {
  let nodes: WorkflowNodeTypeView[] = [];
  let loadError: string | null = null;
  const published = await loadPublishedGraph();

  try {
    const data = await executeGraphqlRequest<{
      workflowNodeTypes: WorkflowNodeTypeView[];
    }>({ query: NODE_TYPES });
    nodes = data.workflowNodeTypes ?? [];
  } catch (error) {
    // A catalog that cannot be read is worth saying out loud rather than
    // rendering as an empty one: "no node types" and "the API did not answer"
    // look identical on screen and mean opposite things.
    loadError = error instanceof Error ? error.message : String(error);
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-2 p-6">
        <h1 className="text-2xl font-semibold">Workflows</h1>
        <p className="text-sm text-destructive">
          The node catalog could not be read: {loadError}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {published ? (
        <section className="flex flex-col gap-2 border-b border-border p-6 pb-0">
          <h2 className="text-lg font-medium">{published.name}</h2>
          <p className="text-sm text-muted-foreground">
            The published graph, drawn read-only. Editing needs a definition
            lock and an undo stack, so the canvas does not move yet.
          </p>
          <div className="h-[420px] w-full">
            <WorkflowGraphView graph={published.graph} nodeTypes={nodes} />
          </div>
        </section>
      ) : null}
      <WorkflowNodeCatalogView nodes={nodes} />
    </div>
  );
}
