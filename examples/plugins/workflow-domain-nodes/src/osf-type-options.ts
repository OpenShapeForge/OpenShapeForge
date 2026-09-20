// SPDX-License-Identifier: BUSL-1.1
/**
 * Entity-ID picker metadata for authored node-config fields.
 *
 * A node config says `osfType: relationId` and nothing more; the semantic
 * type catalog is what knows that a relation ID is an entity reference and
 * where its list is served from. Resolving that here is what lets the designer
 * render a picker without every node YAML restating a URL and a component —
 * the single-source-of-truth rule the catalogs exist for.
 *
 * This restates what the workflow plugin applies to the standard catalog rather
 * than importing it. The two slices have to agree field for field — the same
 * authored `osfType` must yield the same picker whichever slice a node
 * lands in, and a node that moves between slices must not change shape — but
 * that plugin reaches this logic through a barrel that also pulls in entity
 * loading, the active manifest and the whole entity-node generator. Importing
 * it would run all of that to reuse forty lines, and would pin these packs to
 * another plugin's file layout on top of the table they already share.
 */
import { resolveBaseType, osfTypeDefinitionOf } from "../../../../packages/compiler/src/authoring/entity-fields.js";
import { loadOsfTypes as loadCompilerOsfTypes } from "../../../../packages/compiler/src/authoring/loader.js";
import type {
  Field,
  OsfTypeDefinition,
} from "../../../../packages/compiler/src/authoring/types.js";

/**
 * The compiler's derived catalog: the authored catalogs (core first, then each
 * context in sorted name order, later keys winning) plus one entry per loaded
 * entity, so an `osfType` naming an entity resolves like any other.
 */
export function loadOsfTypes(authoringDir: string): Map<string, OsfTypeDefinition> {
  return new Map(Object.entries(loadCompilerOsfTypes(authoringDir)));
}

/**
 * `render` is overwritten rather than defaulted: an entity-ID field is a picker
 * in the workflow inspector whatever component the YAML named for the surfaces
 * that render it elsewhere. `options` is only filled in when absent, so a field
 * that authored its own source keeps it. Every field leaves with its derived
 * `baseType`, the same way the compiler normalizes an entity field.
 */
function enrichField(field: Field, osfTypes: Map<string, OsfTypeDefinition>): Field {
  // Round-trip clone: the parsed YAML is shared with the caller's entry list,
  // and enrichment must not reach back into it.
  const enriched = JSON.parse(JSON.stringify(field)) as Field;
  const catalog = Object.fromEntries(osfTypes);
  const baseType = resolveBaseType(enriched.osfType, catalog);
  if (!baseType) throw new Error(`Domain workflow-node field "${enriched.key}": unknown osfType ${enriched.osfType}.`);
  enriched.baseType = baseType;
  const osfType = osfTypeDefinitionOf(enriched.osfType, catalog);

  if (osfType?.kind === "entityId" && osfType.optionSource) {
    if (!enriched.options) {
      enriched.options = { ...osfType.optionSource };
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
    enriched.children = enriched.children.map((child) => enrichField(child, osfTypes));
  }
  if (enriched.item) {
    enriched.item = enrichField(enriched.item, osfTypes);
  }

  return enriched;
}

export function enrichFieldsWithEntityIdOptions(
  fields: Field[],
  osfTypes: Map<string, OsfTypeDefinition>,
): Field[] {
  return fields.map((field) => enrichField(field, osfTypes));
}
