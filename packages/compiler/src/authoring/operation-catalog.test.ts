// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOperationCatalogs } from "./operation-catalog.js";

const roots: string[] = [];

function authoringRoot(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), "osf-operation-catalog-"));
  roots.push(root);
  mkdirSync(join(root, "operations"));
  writeFileSync(join(root, "operations", "example.yaml"), yaml);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const operation = `
schemaVersion: 1
kind: operationCatalog
plugin: example
operations:
  guide:
    id: example.guide
    name: { en: Guide, nl: Uitleg }
    description: { en: Show the guide, nl: Toon de uitleg }
    implementation: { type: plugin, plugin: example, handler: guide }
    input: { schema: { type: object, additionalProperties: false } }
    output: { schema: { type: object } }
    errors: []
    auth: { mode: session, roles: [Example.Read] }
    tenancy: { mode: required }
    effects: { data: read, external: none }
    reliability: { idempotency: { mode: natural } }
    confirmation: { mode: none }
interfaces:
  rest:
    operations:
      guide: { method: GET, path: /api/example/guide, response: { kind: json } }
  graphql:
    operations:
      guide: { kind: query, field: exampleGuide }
  mcp:
    operations:
      guide: { name: example_guide }
`;

describe("module Operation catalog authoring", () => {
  test("loads one transport-neutral YAML source for a module-global Operation", () => {
    const loaded = loadOperationCatalogs(authoringRoot(operation));
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.document).toMatchObject({
      kind: "operationCatalog",
      plugin: "example",
      operations: {
        guide: {
          id: "example.guide",
          implementation: { type: "plugin", plugin: "example", handler: "guide" },
          effects: { data: "read", external: "none" },
        },
      },
    });
  });

  test("rejects a mismatched plugin owner and an artificial entity target", () => {
    expect(() => loadOperationCatalogs(authoringRoot(
      operation.replace("plugin: example, handler", "plugin: other, handler"),
    ))).toThrow(/must match catalog plugin/);
    expect(() => loadOperationCatalogs(authoringRoot(
      operation.replace(
        "    input: { schema:",
        "    target: { scope: record, inputField: id }\n    input: { schema:",
      ),
    ))).toThrow(/must NOT be valid|cannot declare an entity target/);
  });
});
