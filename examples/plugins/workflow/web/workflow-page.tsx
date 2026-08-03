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

export default async function WorkflowPage() {
  let nodes: WorkflowNodeTypeView[] = [];
  let loadError: string | null = null;

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

  return <WorkflowNodeCatalogView nodes={nodes} />;
}
