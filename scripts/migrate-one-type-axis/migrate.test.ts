// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { type Corpus, type CorpusFile, authoringRootOf, indexEntities, renderFile, semanticText, yaml } from "./corpus.ts";
import { migrateCorpus } from "./migrate.ts";

function corpusOf(files: Record<string, string>): Corpus {
  const loaded: CorpusFile[] = Object.entries(files).map(([path, source]) => {
    const doc = yaml.parseDocument(source);
    const kind = yaml.isMap(doc.contents) ? String(doc.contents.get("kind") ?? "") || undefined : undefined;
    return { path, source, semantic: semanticText(doc), doc, kind, authoringRoot: authoringRootOf(path) };
  });
  return { files: loaded, entities: indexEntities(loaded) };
}

const entity = (name: string, fields: string, extra = "") => `schemaVersion: 3
kind: coreEntity
module: core
entity: ${name}
title: ${name}
language: en
labels: { en: ${name}, nl: ${name} }
${extra}fields:
${fields}
`;

const parent = entity("Parent", `  - key: name
    valueType: string
    persisted: { column: name, storageClass: core }
  - key: children
    label: { en: Children, nl: Kinderen }
    semanticType: Child
    cardinality: collection
    relationship:
      inverse: parentId
      ownership: reference
`);
const child = entity("Child", `  - key: parentId
    semanticType: Parent
    required: true
    persisted: { column: parent_id, storageClass: core }
    relationship:
      ownership: reference
`);

function migrated(files: Record<string, string>, options = {}) {
  const corpus = corpusOf(files);
  const result = migrateCorpus(corpus, options);
  const output = Object.fromEntries(corpus.files.map((file) => [file.path, renderFile(file)]));
  const parsed = Object.fromEntries(corpus.files.map((file) => [file.path, file.doc.toJS()]));
  return { ...result, output, parsed };
}

describe("type axis rename", () => {
  test("renames semanticType, derives osfType from valueType and drops valueType everywhere", () => {
    const { parsed, report } = migrated({ "a/entities/parent.yaml": parent, "a/entities/child.yaml": child });
    const fields = parsed["a/entities/parent.yaml"].fields;
    expect(fields[0]).toEqual({ key: "name", osfType: "string", persisted: { column: "name", storageClass: "core" } });
    expect(parsed["a/entities/child.yaml"].fields[0].osfType).toBe("Parent");
    expect(report.rename).toEqual({ renamed: 1, derivedFromValueType: 1, valueTypesDropped: 1, skipped: [], catalogs: [] });
  });

  test("keeps a catalog entry's valueType and migrates its nested shape", () => {
    const catalog = `schemaVersion: 1
kind: semanticTypeCatalog
types:
  money:
    label: { en: Money }
    valueType: object
    shape:
      - key: amount
        valueType: number
      - key: currency
        valueType: string
        semanticType: currencyCode
`;
    const { parsed } = migrated({ "a/catalogs/semantic-types.yaml": catalog });
    const money = parsed["a/catalogs/semantic-types.yaml"].types.money;
    expect(money.valueType).toBe("object");
    expect(money.shape).toEqual([{ key: "amount", osfType: "number" }, { key: "currency", osfType: "currencyCode" }]);
  });

  test("migrates workflow-node fields through the same walk", () => {
    const node = `kind: workflowNode\nfields:\n  - key: subject\n    valueType: string\n    children:\n      - key: nested\n        valueType: integer\n`;
    const { parsed } = migrated({ "nodes/x.yaml": node });
    expect(parsed["nodes/x.yaml"].fields[0]).toEqual({ key: "subject", osfType: "string", children: [{ key: "nested", osfType: "integer" }] });
  });
});

describe("inverse collections", () => {
  test("deletes the authored collection and writes only the non-default inverse on the reference", () => {
    const { parsed, output, report } = migrated({ "a/entities/parent.yaml": parent, "a/entities/child.yaml": child });
    expect(parsed["a/entities/parent.yaml"].fields.map((field: { key: string }) => field.key)).toEqual(["name"]);
    expect(parsed["a/entities/child.yaml"].fields[0].relationship).toEqual({
      ownership: "reference",
      inverse: { key: "children", label: { en: "Children", nl: "Kinderen" } },
    });
    expect(report.fold.collectionsFolded).toHaveLength(1);
    expect(output["a/entities/child.yaml"]).toContain("    relationship:\n      ownership: reference\n      inverse:\n        key: children\n");
  });

  test("a collection matching the derived defaults folds to nothing", () => {
    const defaults = entity("Parent", `  - key: childs
    label: { en: Childs, nl: Child }
    semanticType: Child
    cardinality: collection
    relationship: { inverse: parentId }
`);
    const { parsed } = migrated({ "a/entities/parent.yaml": defaults, "a/entities/child.yaml": child });
    expect(parsed["a/entities/child.yaml"].fields[0].relationship).toEqual({ ownership: "reference" });
  });

  test("carries ownership, sortable, childAuthorization and allowedDefinitions", () => {
    const owner = entity("Parent", `  - key: blocks
    semanticType: Child
    cardinality: collection
    sortable: true
    childAuthorization: owner
    relationship: { inverse: parentId, ownership: owned }
    allowedDefinitions: [TextBlock, Embed]
`);
    const { parsed } = migrated({ "a/entities/parent.yaml": owner, "a/entities/child.yaml": child });
    expect(parsed["a/entities/child.yaml"].fields[0].relationship.inverse).toEqual({
      key: "blocks", ownership: "owned", sortable: true, childAuthorization: "owner", allowedDefinitions: ["TextBlock", "Embed"],
    });
  });

  test("keeps via traversals authored", () => {
    const traversal = entity("Parent", `  - key: relationId
    semanticType: Relation
    persisted: { column: relation_id, storageClass: core }
  - key: moments
    semanticType: Child
    cardinality: collection
    relationship: { inverse: relationId, via: relationId }
`);
    const relation = entity("Relation", `  - key: name\n    valueType: string\n`);
    const viaChild = entity("Child", `  - key: relationId\n    semanticType: Relation\n    persisted: { column: relation_id, storageClass: core }\n`);
    const { parsed } = migrated({ "a/entities/parent.yaml": traversal, "a/entities/child.yaml": viaChild, "a/entities/relation.yaml": relation });
    expect(parsed["a/entities/parent.yaml"].fields[1]).toMatchObject({ key: "moments", osfType: "Child", relationship: { inverse: "relationId", via: "relationId" } });
  });

  test("declares inverse: false on ambiguous references that have no collection", () => {
    const link = entity("Link", `  - key: fromId
    semanticType: Parent
    persisted: { column: from_id, storageClass: core }
  - key: toId
    semanticType: Parent
    persisted: { column: to_id, storageClass: core }
    relationship:
      ownership: reference
`);
    const target = entity("Parent", `  - key: outgoing
    semanticType: Link
    cardinality: collection
    relationship: { inverse: fromId }
`);
    const { parsed, report } = migrated({ "a/entities/link.yaml": link, "a/entities/parent.yaml": target });
    const [from, to] = parsed["a/entities/link.yaml"].fields;
    expect(from.relationship).toEqual({ inverse: { key: "outgoing" } });
    expect(to.relationship).toEqual({ ownership: "reference", inverse: false });
    expect(report.fold.ambiguityDeclared).toEqual(["Link.toId -> Parent"]);
  });

  test("value definitions never receive inverse declarations", () => {
    const value = entity("Value", `  - key: aId
    semanticType: Parent
  - key: bId
    semanticType: Parent
`, "baseEntity: false\n");
    const { parsed } = migrated({ "a/entities/value.yaml": value, "a/entities/parent.yaml": entity("Parent", "  - key: n\n    valueType: string\n") });
    expect(parsed["a/entities/value.yaml"].fields.every((field: { relationship?: unknown }) => field.relationship === undefined)).toBe(true);
  });

  test("reports a collection whose inverse is not a single reference back", () => {
    const wrong = entity("Parent", `  - key: children
    semanticType: Child
    cardinality: collection
    relationship: { inverse: nope }
`);
    const { report } = migrated({ "a/entities/parent.yaml": wrong, "a/entities/child.yaml": child });
    expect(report.fold.errors).toEqual(["Parent.children: inverse Child.nope is not a single reference to Parent."]);
  });
});

describe("legacy relationships block", () => {
  const legacyChild = `schemaVersion: 2
kind: coreEntity
module: core
entity: Child
title: Child
language: en
labels: { en: Child, nl: Kind }
fields:
  - key: name
    valueType: string
    persisted: { column: name, storageClass: core }
relationships:
  # The parent this child belongs to.
  - key: parent
    kind: belongsTo
    target: Parent
    foreignKey: parent_id
    label: { en: Parent, nl: Ouder }
`;
  const legacyParent = `schemaVersion: 2
kind: coreEntity
module: core
entity: Parent
title: Parent
language: en
labels: { en: Parent, nl: Ouder }
fields:
  - key: name
    valueType: string
    persisted: { column: name, storageClass: core }
relationships:
  - key: kids
    kind: hasMany
    target: Child
    foreignKey: parent_id
    label: { en: Kids, nl: Kinderen }
`;

  test("creates the missing belongsTo field with baseline nullability and the comment as description", () => {
    const { parsed, output, report } = migrated(
      { "a/entities/child.yaml": legacyChild, "a/entities/parent.yaml": legacyParent },
      { columnRequired: (entityName: string, column: string) => (entityName === "Child" && column === "parent_id" ? true : undefined) },
    );
    const created = parsed["a/entities/child.yaml"].fields[1];
    expect(created).toEqual({
      key: "parentId", osfType: "Parent", required: true, label: { en: "Parent", nl: "Ouder" },
      description: { en: "The parent this child belongs to." },
      persisted: { column: "parent_id", storageClass: "core" },
      relationship: { inverse: { key: "kids", label: { en: "Kids", nl: "Kinderen" } } },
    });
    expect(parsed["a/entities/child.yaml"].relationships).toBeUndefined();
    expect(parsed["a/entities/parent.yaml"].relationships).toBeUndefined();
    expect(output["a/entities/child.yaml"]).toContain("# The parent this child belongs to.\n  - key: parentId");
    expect(report.legacy.fieldsCreated).toEqual([{ entity: "Child", key: "parentId", column: "parent_id", required: true, provenance: "baseline" }]);
    expect(report.legacy.hasManyRemoved).toEqual(["Parent.kids"]);
  });

  test("a hasMany label equal to the child's derived plural folds to nothing, one equal to the owner's does not", () => {
    const matchingChild = legacyParent.replace("label: { en: Kids, nl: Kinderen }", "label: { en: Childs, nl: Kind }");
    const matchingOwner = legacyParent.replace("label: { en: Kids, nl: Kinderen }", "label: { en: Parents, nl: Ouder }");
    const folded = migrated({ "a/entities/child.yaml": legacyChild, "a/entities/parent.yaml": matchingChild });
    expect(folded.parsed["a/entities/child.yaml"].fields[1].relationship).toEqual({ inverse: { key: "kids" } });
    const kept = migrated({ "a/entities/child.yaml": legacyChild, "a/entities/parent.yaml": matchingOwner });
    expect(kept.parsed["a/entities/child.yaml"].fields[1].relationship).toEqual({ inverse: { key: "kids", label: { en: "Parents", nl: "Ouder" } } });
  });

  test("without a baseline the created field is optional and reported as unknown", () => {
    const { report } = migrated({ "a/entities/child.yaml": legacyChild, "a/entities/parent.yaml": legacyParent });
    expect(report.legacy.fieldsCreated[0]).toMatchObject({ required: false, provenance: "unknown" });
  });

  test("--strict refuses to create fields", () => {
    const { report } = migrated({ "a/entities/child.yaml": legacyChild, "a/entities/parent.yaml": legacyParent }, { strict: true });
    expect(report.legacy.errors).toEqual([
      "Child.parent: no field persists column parent_id (strict mode refuses to create one).",
      "Parent.kids: Child has no field persisting parent_id; fold Child's belongsTo first.",
    ]);
  });

  test("folds a belongsTo onto its existing field and refuses manyToMany", () => {
    const withField = legacyChild.replace("fields:\n", "fields:\n  - key: parentId\n    valueType: string\n    persisted: { column: parent_id, storageClass: core }\n")
      + "  - key: tags\n    kind: manyToMany\n    target: Tag\n";
    const { parsed, report } = migrated({ "a/entities/child.yaml": withField, "a/entities/parent.yaml": legacyParent });
    expect(parsed["a/entities/child.yaml"].fields[0]).toMatchObject({ key: "parentId", osfType: "Parent" });
    expect(parsed["a/entities/child.yaml"].fields[0].valueType).toBeUndefined();
    expect(report.legacy.errors).toEqual(["Child.tags: manyToMany is never authored; model the junction as an entity with two references."]);
  });
});

describe("idempotency", () => {
  test("a migrated corpus produces no further changes", () => {
    const first = migrated({ "a/entities/parent.yaml": parent, "a/entities/child.yaml": child });
    const second = migrated(first.output);
    expect(second.changed).toEqual([]);
    expect(second.output).toEqual(first.output);
  });
});

describe("rendering", () => {
  test("follows the file's own flow-collection padding", () => {
    const { output } = migrated({ "a/entities/child.yaml": child.replace("labels: { en: Child, nl: Child }", "labels: { en: Child, nl: Child }\ndomains: [core, other]") });
    expect(output["a/entities/child.yaml"]).toContain("domains: [core, other]");
    expect(output["a/entities/child.yaml"]).toContain("persisted: { column: parent_id, storageClass: core }");
  });
});
