// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { type Corpus, type CorpusFile, authoringRootOf, indexEntities, renderFile, semanticText, yaml } from "./corpus.ts";
import { migrateCorpus } from "./migrate.ts";
import { emptyDataRewriteReport, rewriteFieldDefinitionJson, rewriteFieldDefinitions } from "./data.ts";

function corpusOf(files: Record<string, string>): Corpus {
  const loaded: CorpusFile[] = Object.entries(files).map(([path, source]) => {
    const doc = yaml.parseDocument(source);
    const kind = yaml.isMap(doc.contents) ? String(doc.contents.get("kind") ?? "") || undefined : undefined;
    return { path, source, semantic: semanticText(doc), doc, kind, authoringRoot: authoringRootOf(path) };
  });
  return { files: loaded, entities: indexEntities(loaded) };
}

const entity = (name: string, fields: string) => `schemaVersion: 3
kind: coreEntity
module: core
entity: ${name}
title: ${name}
language: en
labels: { en: ${name}, nl: ${name} }
fields:
${fields}
`;
const child = entity("Child", `  - key: parentId\n    semanticType: Parent\n    persisted: { column: parent_id, storageClass: core }\n`);
const entityParent = entity("Parent", `  - key: name\n    valueType: string\n`);

function migrated(files: Record<string, string>, options = {}) {
  const corpus = corpusOf(files);
  const result = migrateCorpus(corpus, options);
  const parsed = Object.fromEntries(corpus.files.map((file) => [file.path, file.doc.toJS()]));
  const output = Object.fromEntries(corpus.files.map((file) => [file.path, renderFile(file)]));
  return { ...result, parsed, output };
}

describe("stored field-definition values (--data)", () => {
  const stored = [
    { key: "amount", valueType: "number", required: true },
    { key: "notes", valueType: "string", semanticType: "multilineText" },
    { key: "relation", semanticType: "Relation" },
    {
      key: "address", valueType: "object",
      children: [{ key: "street", valueType: "string" }],
      item: { key: "line", valueType: "string", semanticType: "multilineText" },
      shape: [{ key: "zip", valueType: "string" }],
    },
  ];

  test("rewrites a fieldDefinition[] value recursively and reports what it did", () => {
    const report = emptyDataRewriteReport();
    const value = rewriteFieldDefinitions(structuredClone(stored), report);
    expect(value).toEqual([
      { key: "amount", osfType: "number", required: true },
      { key: "notes", osfType: "multilineText" },
      { key: "relation", osfType: "Relation" },
      {
        key: "address", osfType: "object",
        children: [{ key: "street", osfType: "string" }],
        item: { key: "line", osfType: "multilineText" },
        shape: [{ key: "zip", osfType: "string" }],
      },
    ]);
    expect(report).toEqual({ renamed: 3, derivedFromValueType: 4, valueTypesDropped: 6 });
  });

  test("finds definitions nested in a larger document and leaves other data alone", () => {
    const document = { nodes: [{ id: "n1", config: { inputFields: [{ key: "q", valueType: "string" }], valueType: "not a field" } }], tags: ["valueType"] };
    const report = emptyDataRewriteReport();
    rewriteFieldDefinitions(document, report);
    expect(document.nodes[0]!.config).toEqual({ inputFields: [{ key: "q", osfType: "string" }], valueType: "not a field" });
    expect(report.derivedFromValueType).toBe(1);
  });

  test("is idempotent and keeps unchanged JSON text byte-identical", () => {
    const first = rewriteFieldDefinitionJson(JSON.stringify(stored));
    const second = rewriteFieldDefinitionJson(first.text);
    expect(second.text).toBe(first.text);
    expect(second.report).toEqual({ renamed: 0, derivedFromValueType: 0, valueTypesDropped: 0 });
    const untouched = "[ {\"key\": \"x\", \"osfType\": \"string\"} ]";
    expect(rewriteFieldDefinitionJson(untouched).text).toBe(untouched);
  });

  test("refuses a valueType that is not a base type", () => {
    expect(() => rewriteFieldDefinitions([{ key: "x", valueType: "money" }], emptyDataRewriteReport())).toThrow("not a base type");
  });
});

describe("scope of the rename", () => {
  const seed = `rows:\n  - key: endpoint\n    valueType: string\n    semanticType: url\n`;

  test("leaves seed and fixture data alone unless --include-seeds is passed", () => {
    const skipped = migrated({ "plugins/integrations/seeds/adapters.yaml": seed, "a/entities/child.yaml": child });
    expect(skipped.parsed["plugins/integrations/seeds/adapters.yaml"].rows[0]).toEqual({ key: "endpoint", valueType: "string", semanticType: "url" });
    expect(skipped.report.rename.skipped).toEqual(["plugins/integrations/seeds/adapters.yaml"]);
    const included = migrated({ "plugins/integrations/seeds/adapters.yaml": seed }, { includeSeeds: true });
    expect(included.parsed["plugins/integrations/seeds/adapters.yaml"].rows[0]).toEqual({ key: "endpoint", osfType: "url" });
  });

  test("recognizes definitions by kind or by authoring directory", () => {
    const byKind = migrated({ "anywhere/node.yaml": `kind: workflowNode\nfields:\n  - key: a\n    valueType: string\n` });
    expect(byKind.parsed["anywhere/node.yaml"].fields[0]).toEqual({ key: "a", osfType: "string" });
    const byPath = migrated({ "plugin/authoring/catalogs/semantic-types.yaml": `types:\n  x:\n    valueType: object\n    shape:\n      - key: a\n        valueType: string\n` });
    expect(byPath.parsed["plugin/authoring/catalogs/semantic-types.yaml"].types.x.shape[0]).toEqual({ key: "a", osfType: "string" });
  });
});

describe("view references follow a folded belongsTo key", () => {
  test("layout context, tabs, usages and timeline includes point at the field key", () => {
    const entity = `schemaVersion: 2
kind: coreEntity
module: pentest
entity: Assessment
title: Assessment
language: en
labels: { en: Assessment, nl: Assessment }
fields:
  - key: name
    valueType: string
    persisted: { column: name, storageClass: core }
relationships:
  - key: relation
    kind: belongsTo
    target: Parent
    foreignKey: relation_id
interfaces:
  web:
    views:
      record:
        layout:
          context:
            fields: [name]
            relationships: [relation]
          tabs:
            - id: overview
              relationship: relation
              groups:
                - relationships:
                    - name: relation
                      view: compact
                - timeline:
                    include: [self, { relationship: relation }]
`;
    const { parsed } = migrated({ "a/entities/assessment.yaml": entity, "a/entities/parent.yaml": entityParent });
    const views = parsed["a/entities/assessment.yaml"].interfaces.web.views.record.layout;
    expect(views.context.relationships).toEqual(["relationId"]);
    expect(views.tabs[0].relationship).toBe("relationId");
    expect(views.tabs[0].groups[0].relationships[0]).toEqual({ name: "relationId", view: "compact" });
    expect(views.tabs[0].groups[1].timeline.include[1]).toEqual({ relationship: "relationId" });
    expect(parsed["a/entities/assessment.yaml"].fields[1].key).toBe("relationId");
  });
});
