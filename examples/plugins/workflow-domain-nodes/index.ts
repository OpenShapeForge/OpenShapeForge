// SPDX-License-Identifier: BUSL-1.1
/**
 * Example compiler plugin: the domain workflow node packs.
 *
 * These node types were part of the workflow plugin's standard catalog. They
 * describe capabilities nothing in this repo provides — messaging, model calls,
 * billing, case handling — so they are a catalog a host repo implements
 * against, not an implementation. Packaged separately, a deployment that wants
 * the workflow engine without them drops one line from `authoring.config.yaml`
 * instead of forking a YAML tree.
 *
 * It contributes NO platform tables. `platform.workflow_node_catalog_entries`
 * belongs to the workflow plugin, which declares it once; two plugins
 * contributing one `schema.table` is refused by the compiler, and rightly so.
 * These packs are a third slice of that table (`catalog = 'domain'`, alongside
 * `'standard'` and `'entity'`), each slice authoritative over its own rows.
 * That makes the workflow plugin a hard prerequisite: registered alone, this
 * one emits a seed for a table that does not exist.
 *
 * `authoring/` next to this module is picked up as an authoring LAYER
 * automatically. It ships `domain-workflow-nodes/**` rather than
 * `workflow-nodes/**` on purpose — see the note in `src/domain-node-catalog.ts`:
 * all layers merge into one tree, so the directory name is the only thing
 * keeping the two catalogs from becoming one.
 *
 * Everything it emits lands under its own generated root, which is also why it
 * can share a compiler run with the workflow plugin at all: emitting the same
 * artifact path twice is a collision, and two roots cannot collide.
 *
 * The generator is API-side only. There is no `webPresent` gate here because
 * there is nothing to gate — the designer reads node types from Postgres
 * through the workflow plugin's GraphQL surface, so a web-side copy of this
 * catalog would have no importer.
 */
import type { CompilerPlugin } from "../../../packages/compiler/src/plugins.js";
import type { GeneratedArtifact } from "../../../packages/compiler/src/schema.js";
import { generateDomainNodeCatalogArtifacts } from "./src/domain-node-catalog.js";

const GENERATED_ROOT = "apps/api/src/generated/workflow-domain-nodes";

const plugin: CompilerPlugin = {
  name: "workflow-domain-nodes",
  ownedPaths: {
    // Declaring the root extends `check:generated`'s stale/orphan gates to it,
    // so a node pack that stops being authored cannot leave its seed behind.
    roots: [GENERATED_ROOT],
  },

  generate({ authoringDir }) {
    const artifacts: GeneratedArtifact[] = [];
    for (const [file, contents] of generateDomainNodeCatalogArtifacts(authoringDir)) {
      artifacts.push({ path: `${GENERATED_ROOT}/${file}`, contents });
    }
    return artifacts.sort((a, b) => a.path.localeCompare(b.path));
  },
};

export default plugin;
