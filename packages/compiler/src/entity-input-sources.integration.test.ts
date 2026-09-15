// SPDX-License-Identifier: BUSL-1.1
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { collectAllArtifacts } from "./index.js";
import { loadActivePlatformCompile } from "./active-manifest.js";
import { buildWebManifest } from "./authoring/web-manifest.js";
import { resolveEntityInputSources } from "./entity-input-sources.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  expect(value).toBeObject();
  return value as JsonObject;
}

function operationInput(
  operations: readonly JsonObject[],
  id: string,
): JsonObject {
  const operation = operations.find((candidate) => candidate.id === id);
  expect(operation).toBeDefined();
  return object(operation!.inputSchema);
}

function assertCanonicalDocumentInput(schema: JsonObject): void {
  const properties = object(schema.properties);
  const document = object(properties.document);
  const documentProperties = object(document.properties);
  const version = object(properties.version);
  const versionProperties = object(version.properties);
  expect(schema.required).not.toContain("artifact");
  expect(properties.artifact).toMatchObject({
    type: "object",
    additionalProperties: false,
    required: ["artifactId", "expectedArtifactVersion"],
    properties: {
      artifactId: { type: "string", format: "uuid" },
      expectedArtifactVersion: { type: "integer", minimum: 1, maximum: 9007199254740991 },
    },
  });
  for (const field of ["artifactId", "artifactVersion", "byteSize", "storageLocation"]) {
    expect(versionProperties[field]).toBeUndefined();
  }

  expect(document.required).toEqual(["title", "documentType", "status"]);
  expect(documentProperties.title).toMatchObject({
    type: "string",
    minLength: 1,
    maxLength: 300,
  });
  expect(documentProperties.documentType).toMatchObject({
    type: "string",
    "x-osf-reference": { entity: "DocumentType", valueField: "code" },
  });
  expect(object(documentProperties.documentType).enum).toBeUndefined();
  expect(documentProperties.caseFileId).toMatchObject({
    type: "string",
    format: "uuid",
    title: "Case file",
    "x-osf-reference": { entity: "CaseFile" },
  });

  expect(version.required).toEqual(["versionLabel", "status"]);
  expect(versionProperties.versionLabel).toMatchObject({
    type: "string",
    minLength: 1,
    maxLength: 50,
  });
  expect(versionProperties.status).toMatchObject({
    type: "string",
    enum: ["draft", "final", "superseded", "withdrawn"],
  });
  expect(versionProperties.accountId).toMatchObject({
    type: "string",
    format: "uuid",
    title: "Account",
    "x-osf-reference": { entity: "Account" },
  });
}

test("canonical entity input sources reach every generated operation interface", async () => {
  const root = await mkdtemp(join(tmpdir(), "osf-entity-input-integration-"));
  try {
    await writeFile(
      join(root, "authoring.config.yaml"),
      `layers:\n  - packages/compiler/config/authoring\nplugins:\n  - ${JSON.stringify(new URL("../../documents/src/index.ts", import.meta.url).pathname)}\n`,
    );
    await mkdir(join(root, "apps/product-web"), { recursive: true });

    // A host can generate its frontend directly from the public compile API,
    // before (or without) running the all-artifact generator.
    const active = await loadActivePlatformCompile(root);
    const directWeb = buildWebManifest(active.entities);
    const directCreate = object(JSON.parse(JSON.stringify(directWeb.entities.Document!.operations.create)));
    expect(object(directCreate.input).kind).toBe("json-schema");
    assertCanonicalDocumentInput(object(object(directCreate.input).schema));
    expect(JSON.stringify(directWeb)).not.toContain("x-osf-entityInput");

    const artifacts = await collectAllArtifacts(root);
    const parse = (path: string): JsonObject => {
      const artifact = artifacts.all.find((candidate) => candidate.path === path);
      expect(artifact).toBeDefined();
      return JSON.parse(artifact!.contents) as JsonObject;
    };

    const catalog = parse("apps/api/src/generated/operations/catalog.json");
    const entityOperations = catalog.entityOperations as JsonObject[];
    const documentInput = operationInput(entityOperations, "Document.create");
    const documentVersionInput = operationInput(
      entityOperations,
      "DocumentVersion.create",
    );
    assertCanonicalDocumentInput(documentInput);
    expect(object(object(documentVersionInput.properties).version)).toEqual(
      object(object(documentInput.properties).version),
    );

    const mcp = parse("apps/api/src/generated/mcp/tools.json");
    const tools = mcp.tools as JsonObject[];
    expect(
      tools.find((tool) => tool.operationId === "Document.create")?.inputSchema,
    ).toEqual(documentInput);
    expect(
      tools.find((tool) => tool.operationId === "DocumentVersion.create")
        ?.inputSchema,
    ).toEqual(documentVersionInput);

    const openApi = parse("apps/api/src/generated/rest/openapi.json");
    const restSchemas = object(object(openApi.components).schemas);
    expect(restSchemas.DocumentInput).toEqual(documentInput);
    expect(restSchemas.DocumentVersionInput).toEqual(documentVersionInput);

    const web = parse("apps/product-web/src/generated/web-manifest.json");
    const webEntities = object(web.entities);
    const webDocument = object(webEntities.Document);
    const webDocumentVersion = object(webEntities.DocumentVersion);
    expect(
      object(object(object(webDocument.operations).create).input).schema,
    ).toEqual(documentInput);
    expect(
      object(object(object(webDocumentVersion.operations).create).input).schema,
    ).toEqual(documentVersionInput);

    // Real identity-less definitions author their materialized value shape
    // from ordinary entity fields. Outputs must expand just like inputs.
    for (const [name, selected, route] of [
      ["TextBlock", ["text"], "/api/content-blocks/text/materialize"],
      ["YouTubeEmbed", ["title", "url", "showControls"], "/api/content-blocks/video/materialize"],
    ] as const) {
      const key = `${name}.materialize`;
      const operation = (catalog.operations as JsonObject[]).find(operation => operation.key === key)!;
      expect(operation).toBeDefined();
      const output = object(operation.outputSchema);
      const value = object(object(output.properties).value);
      const expected = resolveEntityInputSources({ "x-osf-entityInput": { entity: name, fields: [...selected] } }, active.entities.map(entity => entity.contract), {});
      expect(value).toEqual(expected);
      expect(Object.keys(object(value.properties))).toEqual([...selected]);
      expect(value.additionalProperties).toBe(false);
      expect(output.required).toEqual(["kind", "value"]);
      expect(object(output.properties).kind).toEqual({ type: "string", const: "block" });
      const source = active.entities.find(entity => entity.contract.entity.name === name)!.contract;
      expect(source.pluginOperations!.find(operation => operation.key === "materialize")?.definition.output?.schema).toEqual(output);
      expect((mcp.operationTools as JsonObject[]).find(tool => tool.key === key)?.outputSchema).toEqual(output);
      const response = object(object(object(object(openApi.paths)[route]).post).responses)["200"];
      expect(object(object(object(response).content)["application/json"]).schema).toEqual(output);
      // No standalone CRUD or Web route is introduced for value definitions.
      expect(webEntities[name]).toBeUndefined();
    }

    expect(
      artifacts.all.filter((artifact) =>
        artifact.contents.includes("x-osf-entityInput")
      ),
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
