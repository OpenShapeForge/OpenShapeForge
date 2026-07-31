// SPDX-License-Identifier: BUSL-1.1
/**
 * The workflow plugin's runtime half.
 *
 * The compiler-side default export (`./index.ts`) contributes platform tables
 * and emits the catalog documents; this one is imported by the API at boot and
 * says what to do with them. The `name` must match the compiler plugin's — the
 * loader refuses the pair otherwise, because two halves that disagree are a
 * stale build rather than a configuration choice.
 *
 * Today it contributes only the catalog seeds, which the API previously called
 * directly. Moving them here is the point of the change: `apps/api` no longer
 * carries a hardcoded path to a plugin's generated output, and a repo that
 * drops the workflow plugin stops seeding without editing the migration chain.
 *
 * It also contributes the definition-authoring GraphQL surface — definitions,
 * versions, validation, patching, edit locks, and the node catalogs the designer
 * reads. Those are not generated CRUD on purpose: the tables are declared
 * `domainInternal`, because every invariant that makes a definition meaningful
 * (versioning, validate-on-publish, the edit lock, refusing to delete a
 * definition with runs) lives above the columns rather than in them.
 *
 * `restRoutes` stays unimplemented until the webhook trigger lands, rather than
 * being stubbed, so the surface advertises nothing that does not answer.
 */
import type { RuntimeModule } from "../../../apps/api/src/modules/contract.js";
import { applyWorkflowCatalogsSeed } from "../../../apps/api/src/db/migrations/workflow-catalogs-seed.js";
import {
  workflowMutationFields,
  workflowQueryFields,
  workflowResolvers,
  workflowTypeDefs,
} from "./runtime/graphql.js";
import { hydrateNodeCatalog } from "./runtime/node-catalog-store.js";

const plugin: RuntimeModule = {
  name: "workflow",

  /**
   * Hydrate the node catalog before anything can be asked about it.
   *
   * Definition validation resolves node types through the catalog, and an
   * unhydrated store answers every lookup with nothing — which would make
   * validation pass while checking nothing at all. Failing here is a load
   * failure: the module is dropped and its surfaces are absent, which is the
   * honest outcome when it cannot answer correctly.
   */
  async init({ db }) {
    if (!db) return; // no database configured; the surfaces degrade with it
    await hydrateNodeCatalog(db);
  },

  graphql() {
    return {
      typeDefs: workflowTypeDefs,
      queryFields: workflowQueryFields,
      mutationFields: workflowMutationFields,
      resolvers: workflowResolvers,
    };
  },

  seeds: [
    {
      name: "workflowCatalogs",
      // One reported result for the whole set: the three tables are filled from
      // four documents produced by one generator run, and a partial outcome is
      // not a state an operator can act on differently.
      apply: async (db) => {
        const result = await applyWorkflowCatalogsSeed(db);
        const parts = [result.nodeCatalogs, result.triggerRegistry, result.fieldSuggestions];
        return {
          present: parts.some((part) => part.present),
          skipped: parts.every((part) => part.skipped),
          rows: parts.reduce((total, part) => total + part.rows, 0),
        };
      },
    },
  ],
};

export default plugin;
