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
 * GraphQL and routes arrive with the definition surface and the webhook
 * endpoints; the hooks are declared in the contract and left unimplemented here
 * rather than stubbed, so the schema advertises nothing that does not answer.
 */
import type { RuntimeModule } from "../../../apps/api/src/modules/contract.js";
import { applyWorkflowCatalogsSeed } from "../../../apps/api/src/db/migrations/workflow-catalogs-seed.js";

const plugin: RuntimeModule = {
  name: "workflow",

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
