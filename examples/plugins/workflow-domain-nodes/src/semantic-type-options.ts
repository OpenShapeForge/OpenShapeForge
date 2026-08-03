// SPDX-License-Identifier: BUSL-1.1
/**
 * Entity-ID picker metadata for authored node-config fields.
 *
 * A node config says `semanticType: relationId` and nothing more; the semantic
 * type catalog is what knows that a relation ID is an entity reference and
 * where its list is served from. Resolving that here is what lets the designer
 * render a picker without every node YAML restating a URL and a component —
 * the single-source-of-truth rule the catalogs exist for.
 *
 * This restates what the workflow plugin applies to the standard catalog rather
 * than importing it. The two slices have to agree field for field — the same
 * authored `semanticType` must yield the same picker whichever slice a node
 * lands in, and a node that moves between slices must not change shape — but
 * that plugin reaches this logic through a barrel that also pulls in entity
 * loading, the active manifest and the whole entity-node generator. Importing
 * it would run all of that to reuse forty lines, and would pin these packs to
 * another plugin's file layout on top of the table they already share.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  Field,
  SemanticTypeCatalog,
  SemanticTypeDefinition,
} from "../../../../packages/compiler/src/authoring/types.js";

/**
 * The core catalog first, then any per-context catalogs in sorted name order.
 * A later definition of the same key wins, so the sort is what keeps two runs
 * agreeing on which one that was.
 */
export function loadSemanticTypes(authoringDir: string): Map<string, SemanticTypeDefinition> {
  const merged = new Map<string, SemanticTypeDefinition>();

  const mergeFile = (path: string): void => {
    if (!existsSync(path)) {
      return;
    }
    const catalog = parseYaml(readFileSync(path, "utf-8")) as SemanticTypeCatalog | null;
    for (const [key, definition] of Object.entries(catalog?.types ?? {})) {
      merged.set(key, definition);
    }
  };

  mergeFile(join(authoringDir, "catalogs", "semantic-types.yaml"));

  const contextsDir = join(authoringDir, "contexts");
  if (existsSync(contextsDir)) {
    for (const context of readdirSync(contextsDir).sort()) {
      mergeFile(join(contextsDir, context, "semantic-types.yaml"));
    }
  }

  return merged;
}

/**
 * `render` is overwritten rather than defaulted: an entity-ID field is a picker
 * in the workflow inspector whatever component the YAML named for the surfaces
 * that render it elsewhere. `options` is only filled in when absent, so a field
 * that authored its own source keeps it.
 */
function enrichField(field: Field, semanticTypes: Map<string, SemanticTypeDefinition>): Field {
  // Round-trip clone: the parsed YAML is shared with the caller's entry list,
  // and enrichment must not reach back into it.
  const enriched = JSON.parse(JSON.stringify(field)) as Field;
  const semanticType = enriched.semanticType
    ? semanticTypes.get(enriched.semanticType)
    : undefined;

  if (semanticType?.kind === "entityId" && semanticType.listUrl) {
    if (!enriched.options) {
      enriched.options = { type: "remote", remoteUrl: semanticType.listUrl };
    }
    enriched.render = {
      component: "OptionVariablePicker",
      props: { valueMode: "insertText" },
    };
  }

  // Nested shapes carry semantic types too, and a picker three levels down is
  // still a picker. `Array.isArray` rather than a truthiness check because the
  // input is parsed YAML: a scalar `children:` would otherwise reach `.map`.
  if (Array.isArray(enriched.children)) {
    enriched.children = enriched.children.map((child) => enrichField(child, semanticTypes));
  }
  if (enriched.item) {
    enriched.item = enrichField(enriched.item, semanticTypes);
  }

  return enriched;
}

export function enrichFieldsWithEntityIdOptions(
  fields: Field[],
  semanticTypes: Map<string, SemanticTypeDefinition>,
): Field[] {
  return fields.map((field) => enrichField(field, semanticTypes));
}
