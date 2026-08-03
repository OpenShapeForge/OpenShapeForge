// SPDX-License-Identifier: BUSL-1.1
/**
 * The two catalog slices must enrich an authored field identically.
 *
 * `semantic-type-options.ts` here restates what the workflow plugin applies to
 * the standard catalog, for the reason its docblock gives — reaching that
 * plugin's copy means pulling in entity loading, the active manifest and the
 * whole entity-node generator to reuse forty lines. That trade is defensible;
 * what is not defensible is asserting in a comment that the two agree and
 * leaving nothing to notice when they stop.
 *
 * The invariant is not cosmetic. A node's emitted catalog entry has to be the
 * same whichever slice it lands in: the split moved 29 node types between
 * slices, `node_type` is the primary key both seeds write, and a node moved
 * back later must not silently change shape in the designer. If the two
 * implementations drift, that breaks in exactly one slice and nothing else
 * fails.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow-domain-nodes/src/__tests__ 2>&1
 */
import { describe, expect, test } from "bun:test";
import type {
  Field,
  SemanticTypeDefinition,
} from "../../../../../packages/compiler/src/authoring/types.js";
import { enrichFieldsWithEntityIdOptions } from "../semantic-type-options.js";
// The standard catalog's copy. Note the interfaces are NOT the same: arguments
// are reversed and it takes a Record where this plugin takes a Map. That makes
// them a reimplementation rather than a restatement, which is more room to
// drift, not less.
import { enrichFieldsWithEntityIdRemoteOptions } from "../../../workflow/src/workflow-entity-nodes/catalog.js";

/**
 * One entity-ID type with a list URL, one without, and one that is not an
 * entity ID at all — the three branches the enricher distinguishes.
 */
const semanticTypeEntries: [string, SemanticTypeDefinition][] = [
  [
    "relationId",
    {
      kind: "entityId",
      label: { en: "Relation", nl: "Relatie" },
      valueType: "string",
      listUrl: "/api/options/relations",
    },
  ],
  // An entity ID with nowhere to fetch from: `kind` alone must not be enough
  // to attach a remote source.
  [
    "orphanId",
    { kind: "entityId", label: { en: "Orphan", nl: "Wees" }, valueType: "string" },
  ],
  // Not an entity reference at all — the enricher must leave it untouched.
  [
    "plainText",
    { kind: "scalar", label: { en: "Plain", nl: "Tekst" }, valueType: "string" },
  ],
];

const semanticTypes = new Map<string, SemanticTypeDefinition>(semanticTypeEntries);

/**
 * Deliberately exercises every path: a bare entity ID, one that already
 * authored its own `options`, one whose semantic type has no `listUrl`, a
 * non-entity field, nested `children`, and an array `item`.
 */
const fields = [
  { key: "relation", valueType: "string", semanticType: "relationId" },
  {
    key: "preAuthored",
    valueType: "string",
    semanticType: "relationId",
    options: { type: "static", items: [{ value: "a" }] },
    render: { component: "Input" },
  },
  { key: "orphan", valueType: "string", semanticType: "orphanId" },
  { key: "plain", valueType: "string", semanticType: "plainText" },
  { key: "noSemanticType", valueType: "string" },
  {
    key: "group",
    valueType: "object",
    children: [
      { key: "nestedRelation", valueType: "string", semanticType: "relationId" },
      { key: "nestedPlain", valueType: "string", semanticType: "plainText" },
    ],
  },
  {
    key: "list",
    valueType: "array",
    item: { key: "itemRelation", valueType: "string", semanticType: "relationId" },
  },
] as unknown as Field[];

describe("entity-ID enrichment", () => {
  test("agrees field for field with the standard catalog's implementation", () => {
    const domain = enrichFieldsWithEntityIdOptions(fields, semanticTypes);
    const standard = enrichFieldsWithEntityIdRemoteOptions(
      Object.fromEntries(semanticTypes),
      fields,
    );

    // Serialised rather than compared structurally: key ORDER is part of the
    // emitted JSON, and the catalog seeds are byte-compared by
    // `check:generated`. Two objects that differ only in key order would pass
    // a structural check and still produce different artifacts.
    expect(JSON.stringify(domain)).toBe(JSON.stringify(standard));
  });

  test("enriches an entity ID and leaves everything else alone", () => {
    const [relation, preAuthored, orphan, plain, bare, group, list] =
      enrichFieldsWithEntityIdOptions(fields, semanticTypes) as any[];

    // The picker, sourced from the semantic type rather than the node YAML.
    expect(relation.options).toEqual({ type: "remote", remoteUrl: "/api/options/relations" });
    expect(relation.render.component).toBe("OptionVariablePicker");

    // An authored source wins; the render still becomes the picker, because an
    // entity ID is a picker in the inspector whatever the YAML named.
    expect(preAuthored.options).toEqual({ type: "static", items: [{ value: "a" }] });
    expect(preAuthored.render.component).toBe("OptionVariablePicker");

    // An entity ID with nowhere to fetch from gets neither.
    expect(orphan.options).toBeUndefined();
    expect(orphan.render).toBeUndefined();

    expect(plain.render).toBeUndefined();
    expect(bare.render).toBeUndefined();

    // Nesting: a picker three levels down is still a picker.
    expect(group.children[0].render.component).toBe("OptionVariablePicker");
    expect(group.children[1].render).toBeUndefined();
    expect(list.item.render.component).toBe("OptionVariablePicker");
  });

  test("does not mutate the fields it was handed", () => {
    const before = JSON.stringify(fields);
    enrichFieldsWithEntityIdOptions(fields, semanticTypes);
    // The parsed YAML is shared with the caller's entry list; enrichment
    // reaching back into it would corrupt the entry that was already emitted.
    expect(JSON.stringify(fields)).toBe(before);
  });
});
