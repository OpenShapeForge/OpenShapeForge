// SPDX-License-Identifier: BUSL-1.1
/**
 * The two catalog slices must enrich an authored field identically.
 *
 * `osf-type-options.ts` here restates what the workflow plugin applies to
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
  OsfTypeDefinition,
} from "../../../../../packages/compiler/src/authoring/types.js";
import { enrichFieldsWithEntityIdOptions } from "../osf-type-options.js";
// The standard catalog's copy. Note the interfaces are NOT the same: arguments
// are reversed and it takes a Record where this plugin takes a Map. That makes
// them a reimplementation rather than a restatement, which is more room to
// drift, not less.
import { enrichFieldsWithEntityIdRemoteOptions } from "../../../workflow/src/workflow-entity-nodes/catalog.js";

/**
 * One entity-ID type whose entity can be enumerated, one without a source,
 * and one that is not an entity ID at all — the three branches the enricher
 * distinguishes.
 */
const osfTypeEntries: [string, OsfTypeDefinition][] = [
  [
    "relationId",
    {
      kind: "entityId",
      label: { en: "Relation", nl: "Relatie" },
      baseType: "string",
      listUrl: "/relations",
      optionSource: { type: "entity", source: "Relation", valueField: "id" },
    },
  ],
  // An entity ID whose entity has no list Operation: `kind` alone must not
  // be enough to attach a source, and its web route never is one.
  [
    "orphanId",
    { kind: "entityId", label: { en: "Orphan", nl: "Wees" }, baseType: "string", listUrl: "/orphans" },
  ],
  // Not an entity reference at all — the enricher must leave it untouched.
  [
    "plainText",
    { kind: "scalar", label: { en: "Plain", nl: "Tekst" }, baseType: "string" },
  ],
];

const osfTypes = new Map<string, OsfTypeDefinition>(osfTypeEntries);

/**
 * Deliberately exercises every path: a bare entity ID, one that already
 * authored its own `options`, one whose semantic type has no `optionSource`, a
 * non-entity field, nested `children`, and an array `item`.
 */
const fields = [
  { key: "relation", osfType: "relationId" },
  {
    key: "preAuthored",
    osfType: "relationId",
    options: { type: "static", items: [{ value: "a" }] },
    render: { component: "Input" },
  },
  { key: "orphan", osfType: "orphanId" },
  { key: "plain", osfType: "plainText" },
  { key: "bareString", osfType: "string" },
  {
    key: "group",
    osfType: "object",
    children: [
      { key: "nestedRelation", osfType: "relationId" },
      { key: "nestedPlain", osfType: "plainText" },
    ],
  },
  {
    key: "list",
    osfType: "object",
    cardinality: "collection",
    item: { key: "itemRelation", osfType: "relationId" },
  },
] as unknown as Field[];

describe("entity-ID enrichment", () => {
  test("agrees field for field with the standard catalog's implementation", () => {
    const domain = enrichFieldsWithEntityIdOptions(fields, osfTypes);
    const standard = enrichFieldsWithEntityIdRemoteOptions(
      Object.fromEntries(osfTypes),
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
      enrichFieldsWithEntityIdOptions(fields, osfTypes) as any[];

    // The picker, sourced from the semantic type rather than the node YAML.
    expect(relation.options).toEqual({ type: "entity", source: "Relation", valueField: "id" });
    expect(relation.render.component).toBe("OptionVariablePicker");

    // An authored source wins; the render still becomes the picker, because an
    // entity ID is a picker in the inspector whatever the YAML named.
    expect(preAuthored.options).toEqual({ type: "static", items: [{ value: "a" }] });
    expect(preAuthored.render.component).toBe("OptionVariablePicker");

    // An entity ID with nothing to enumerate gets neither; its listUrl is a page.
    expect(orphan.options).toBeUndefined();
    expect(orphan.render).toBeUndefined();

    expect(plain.render).toBeUndefined();
    expect(bare.render).toBeUndefined();

    // Every field leaves with the base type its osfType resolves to.
    expect(relation.baseType).toBe("string");
    expect(bare.baseType).toBe("string");
    expect(group.baseType).toBe("object");
    expect(group.children[0].baseType).toBe("string");

    // Nesting: a picker three levels down is still a picker.
    expect(group.children[0].render.component).toBe("OptionVariablePicker");
    expect(group.children[1].render).toBeUndefined();
    expect(list.item.render.component).toBe("OptionVariablePicker");
  });

  test("does not mutate the fields it was handed", () => {
    const before = JSON.stringify(fields);
    enrichFieldsWithEntityIdOptions(fields, osfTypes);
    // The parsed YAML is shared with the caller's entry list; enrichment
    // reaching back into it would corrupt the entry that was already emitted.
    expect(JSON.stringify(fields)).toBe(before);
  });
});
