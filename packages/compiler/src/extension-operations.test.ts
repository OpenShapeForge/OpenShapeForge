// SPDX-License-Identifier: BUSL-1.1
/**
 * The `osf-extensions` Operations and the `extensions` record contract, on
 * the extensible fixture (__fixtures__/rowaccess/entities/extensible-part*.yaml).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { compileAuthoringBackendManifest } from "./authoring/backend-manifest.js";
import { resolveAuthoringLayers } from "./authoring/layers.js";
import type { CompiledEntityContract } from "./authoring/types/compiled.js";
import { EXTENSIONS_PLUGIN, collectExtensionOperations } from "./extension-operations.js";
import { entityOperationJsonSchemas, entityRecordOutputSchema } from "./entity-operation-json-schema.js";
import { CORE_OPERATION_MODULES, assertOperationRuntimeModules, auditOperationSurfaceCollisions } from "./generate-operations.js";
import { renderOpenApiSpec } from "./generate-openapi.js";

const fixtureDir = join(import.meta.dir, "authoring", "__fixtures__", "rowaccess");
const slugs = ["extensible-part", "extensible-part-spec", "rest-custom", "rest-enabled"];
const contracts: CompiledEntityContract[] = [];
const manifest = compileAuthoringBackendManifest(fixtureDir, {
  mode: "promote", entityAllowlist: slugs, generatedCrudAllowlist: slugs,
  onCandidate: ({ contract }) => { contracts.push(contract); },
});
const entities = contracts.map((contract) => ({ contract, slug: contract.storage.table }));
const contract = (name: string) => contracts.find((candidate) => candidate.entity.name === name)!;
const operations = collectExtensionOperations(entities, manifest.extensionRegistry);
const operation = (key: string) => operations.find((candidate) => candidate.key === key)!;
const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

describe("osf-extensions Operations", () => {
  it("defines every field-definition action on the extensible entity and a referenced-by read on each target", () => {
    expect(operations.map((candidate) => candidate.key)).toEqual([
      "ExtensiblePart.fieldDefinitions.list",
      "ExtensiblePart.fieldDefinitions.create",
      "ExtensiblePart.fieldDefinitions.update",
      "ExtensiblePart.fieldDefinitions.deprecate",
      "ExtensiblePart.fieldDefinitions.restore",
      "ExtensiblePart.fieldDefinitions.delete",
      "ExtensiblePart.fieldDefinitions.reorder",
      "ExtensiblePart.fieldDefinitions.affectedRecords",
      "ExtensiblePart.fieldDefinitions.rebuildIndex",
      "ExtensiblePart.referencedBy",
      "ExtensiblePartSpec.referencedBy",
      "RestEnabled.referencedBy",
    ]);
    for (const candidate of operations) {
      expect(candidate.plugin).toBe(EXTENSIONS_PLUGIN);
      expect(candidate.id).toBe(candidate.key);
      expect(candidate.handler).toBe(candidate.key.slice(candidate.key.indexOf(".") + 1));
      expect(candidate.target?.entityName).toBe(candidate.key.slice(0, candidate.key.indexOf(".")));
    }
    // RestCustom is an excluded target, and no corpus without an extensible entity gets anything.
    expect(operations.some((candidate) => candidate.key.startsWith("RestCustom."))).toBe(false);
    expect(collectExtensionOperations(entities, undefined)).toEqual([]);
  });

  it("lets the entity's readers list definitions and only its manage roles change them", () => {
    const readRoles = contract("ExtensiblePart").authorization.roles.read;
    expect(operation("ExtensiblePart.fieldDefinitions.list").auth).toEqual({ mode: "session", roles: readRoles });
    for (const action of ["create", "update", "deprecate", "restore", "delete", "reorder", "affectedRecords", "rebuildIndex"]) {
      expect(operation(`ExtensiblePart.fieldDefinitions.${action}`).auth).toEqual({
        mode: "session", roles: ["General.All.ReadWrite", "Organization.All.ReadWrite"],
      });
    }
    expect(operation("RestEnabled.referencedBy").auth).toEqual({ mode: "session", roles: contract("RestEnabled").authorization.roles.read });
    expect(operation("RestEnabled.referencedBy").target).toEqual({ entityId: "core.RestEnabled", entityName: "RestEnabled", scope: "record", inputField: "id" });
  });

  it("projects to REST under the entity's resource and to GraphQL, never to MCP", () => {
    expect(operations.map((candidate) => `${candidate.transports.rest.method} ${candidate.transports.rest.path}`)).toEqual([
      "POST /api/rest/v1/extensible-parts/field-definitions/list",
      "POST /api/rest/v1/extensible-parts/field-definitions/create",
      "POST /api/rest/v1/extensible-parts/field-definitions/update",
      "POST /api/rest/v1/extensible-parts/field-definitions/deprecate",
      "POST /api/rest/v1/extensible-parts/field-definitions/restore",
      "POST /api/rest/v1/extensible-parts/field-definitions/delete",
      "POST /api/rest/v1/extensible-parts/field-definitions/reorder",
      "POST /api/rest/v1/extensible-parts/field-definitions/affected-records",
      "POST /api/rest/v1/extensible-parts/field-definitions/rebuild-index",
      "POST /api/rest/v1/extensible-parts/:id/referenced-by",
      "POST /api/rest/v1/extensible-part-specs/:id/referenced-by",
      "POST /api/rest/v1/rest-enableds/:id/referenced-by",
    ]);
    expect(operations.map((candidate) => candidate.transports.graphql.enabled ? `${candidate.transports.graphql.kind} ${candidate.transports.graphql.field}` : "-")).toEqual([
      "query extensiblePartFieldDefinitions",
      "mutation extensiblePartFieldDefinitionCreate",
      "mutation extensiblePartFieldDefinitionUpdate",
      "mutation extensiblePartFieldDefinitionDeprecate",
      "mutation extensiblePartFieldDefinitionRestore",
      "mutation extensiblePartFieldDefinitionDelete",
      "mutation extensiblePartFieldDefinitionReorder",
      "query extensiblePartFieldDefinitionAffectedRecords",
      "mutation extensiblePartFieldDefinitionRebuildIndex",
      "query extensiblePartReferencedBy",
      "query extensiblePartSpecReferencedBy",
      "query restEnabledReferencedBy",
    ]);
    for (const candidate of operations) expect(candidate.transports.mcp.enabled).toBe(false);
    expect(operation("ExtensiblePart.fieldDefinitions.delete").effects).toEqual({ data: "delete", external: "none" });
    expect(operation("ExtensiblePart.fieldDefinitions.list").effects).toEqual({ data: "read", external: "none" });
    // The rebuild is a write that starts backfills; its field is optional.
    expect(operation("ExtensiblePart.fieldDefinitions.rebuildIndex").effects).toEqual({ data: "write", external: "none" });
    expect(operation("ExtensiblePart.fieldDefinitions.rebuildIndex").inputSchema).toMatchObject({ required: [], additionalProperties: false });
  });

  it("claims no route or root field another surface owns, and binds to a core runtime module", () => {
    expect(() => auditOperationSurfaceCollisions(operations, manifest, [], 60)).not.toThrow();
    expect(CORE_OPERATION_MODULES).toContain(EXTENSIONS_PLUGIN);
    expect(() => assertOperationRuntimeModules(operations, CORE_OPERATION_MODULES)).not.toThrow();
  });

  it("publishes strict JSON Schemas with the contract's inputs and outputs", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
    (addFormats as unknown as (instance: typeof ajv) => unknown)(ajv);
    ajv.addKeyword({ keyword: "x-osf-i18n", schemaType: "object" });
    for (const candidate of operations) {
      expect(() => ajv.compile(candidate.inputSchema)).not.toThrow();
      expect(() => ajv.compile(candidate.outputSchema)).not.toThrow();
    }
    const create = ajv.compile(operation("ExtensiblePart.fieldDefinitions.create").inputSchema);
    expect(create({ key: "capacityKwh", definition: { label: { en: "Capacity" }, osfType: "number", classification: { sensitivity: "public" } } })).toBe(true);
    expect(create({ key: "Capacity", definition: {} })).toBe(false);
    expect(create({ definition: {} })).toBe(false);
    const remove = ajv.compile(operation("ExtensiblePart.fieldDefinitions.delete").inputSchema);
    expect(remove({ fieldId: "00000000-0000-4000-8000-000000000000" })).toBe(false);
    expect(remove({ fieldId: "00000000-0000-4000-8000-000000000000", confirmAffectedRecords: 3 })).toBe(true);
    const record = ajv.compile(operation("ExtensiblePart.fieldDefinitions.update").outputSchema);
    expect(record({
      fieldId: "00000000-0000-4000-8000-000000000000", key: "colour", version: 2, kind: "stored",
      definition: { osfType: "string" }, appliesWhen: null, state: "updating", position: 0,
      backfill: { id: "00000000-0000-4000-8000-000000000001", state: "running", processed: 10, total: 200 },
    })).toBe(true);
    const references = ajv.compile(operation("RestEnabled.referencedBy").outputSchema);
    expect(references({ items: [{ entity: "ExtensiblePart", fieldId: "00000000-0000-4000-8000-000000000000", fieldKey: "supplier", label: { en: "Supplier" }, count: 4 }] })).toBe(true);
  });
});

describe("a target a host hides on every interface", () => {
  const hide = (slug: string) => {
    const host = mkdtempSync(join(tmpdir(), "osf-extensions-host-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "osf-extensions-repo-"));
    temporary.push(host, repoRoot);
    mkdirSync(join(host, "entities"));
    writeFileSync(join(host, "entities", `${slug}.yaml`), YAML.stringify({
      kind: "entityPatch", interfaces: { rest: null, graphql: null, mcp: null, web: null },
    }));
    const hidden: CompiledEntityContract[] = [];
    const compiled = compileAuthoringBackendManifest(resolveAuthoringLayers(repoRoot, { layers: [fixtureDir, host] }), {
      mode: "promote", entityAllowlist: slugs, generatedCrudAllowlist: slugs,
      onCandidate: ({ contract: candidate }) => { hidden.push(candidate); },
    });
    const compiledEntities = hidden.map((candidate) => ({ contract: candidate, slug: candidate.storage.table }));
    const compiledOperations = collectExtensionOperations(compiledEntities, compiled.extensionRegistry);
    return { compiled, entities: compiledEntities, operations: compiledOperations };
  };

  it("has no referenced-by Operation, so no REST path, GraphQL field or OpenAPI path", () => {
    const { compiled, entities: hiddenEntities, operations: hiddenOperations } = hide("rest-enabled");
    expect(hiddenOperations.map((candidate) => candidate.key)).toEqual(
      operations.map((candidate) => candidate.key).filter((key) => key !== "RestEnabled.referencedBy"),
    );
    expect(hiddenOperations.some((candidate) => candidate.target?.entityName === "RestEnabled")).toBe(false);
    expect(hiddenOperations.some((candidate) => candidate.transports.rest.path.startsWith("/api/rest/v1/rest-enableds"))).toBe(false);
    expect(hiddenOperations.flatMap((candidate) => candidate.transports.graphql.enabled ? [candidate.transports.graphql.field] : [])).not.toContain("restEnabledReferencedBy");
    const spec = JSON.parse(renderOpenApiSpec(compiled, "fixture", { entities: hiddenEntities, operations: hiddenOperations })) as any;
    expect(Object.keys(spec.paths).filter((path) => path.startsWith("/api/rest/v1/rest-enableds"))).toEqual([]);
    expect(spec.paths["/api/rest/v1/extensible-parts/{id}/referenced-by"].post).toBeDefined();
  });

  it("keeps the field definitions of a hidden extensible entity and takes only its referenced-by read", () => {
    const { operations: hiddenOperations } = hide("extensible-part");
    expect(hiddenOperations.map((candidate) => candidate.key)).toContain("ExtensiblePart.fieldDefinitions.list");
    expect(hiddenOperations.map((candidate) => candidate.key)).not.toContain("ExtensiblePart.referencedBy");
    expect(hiddenOperations.map((candidate) => candidate.key)).toContain("RestEnabled.referencedBy");
  });
});

describe("the extensions record contract", () => {
  const part = contract("ExtensiblePart");
  const plain = contract("RestEnabled");
  const schemas = (target: CompiledEntityContract, intent: "list" | "get" | "create" | "update") =>
    entityOperationJsonSchemas(target, target.entityOperations[intent]!, contracts, {});

  it("reads extensions and their state as open objects on an extensible record only", () => {
    const record = entityRecordOutputSchema(part) as { properties: Record<string, any>; required: string[] };
    expect(record.properties.extensions).toMatchObject({ type: "object", additionalProperties: true });
    expect(record.properties.extensionsMeta).toMatchObject({ type: "object", additionalProperties: true });
    expect(record.required).not.toContain("extensions");
    expect(record.properties.extensionValues).toBeUndefined();
    const other = entityRecordOutputSchema(plain) as { properties: Record<string, unknown> };
    expect(other.properties.extensions).toBeUndefined();
    expect(other.properties.extensionsMeta).toBeUndefined();
  });

  it("accepts extensions on create and update, not on a plain entity", () => {
    for (const intent of ["create", "update"] as const) {
      const values = (schemas(part, intent).inputSchema as any).properties.values;
      expect(values.properties.extensions).toMatchObject({ type: "object", additionalProperties: true });
      expect(values.required ?? []).not.toContain("extensions");
      expect((schemas(plain, intent).inputSchema as any).properties.values.properties.extensions).toBeUndefined();
    }
  });

  it("filters and sorts on extensions within the list contract", () => {
    const input = schemas(part, "list").inputSchema as any;
    expect(input.$defs.entityFilter.properties.extensions).toMatchObject({
      type: "object", minProperties: 1, maxProperties: 5,
      additionalProperties: { type: "object", minProperties: 1 },
    });
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validate = ajv.compile(input);
    expect(validate({ filter: { extensions: { capacityKwh: { gte: 10 } } }, sort: { field: "extensions.capacityKwh", direction: "desc" } })).toBe(true);
    expect(validate({ filter: { and: [{ name: { eq: "x" } }, { extensions: { colour: { eq: "red" } } }] } })).toBe(true);
    expect(validate({ sort: { field: "name" } })).toBe(true);
    expect(validate({ sort: { field: "extensions.Bad-Key" } })).toBe(false);
    expect(validate({ filter: { extensions: { a: { eq: 1 }, b: { eq: 1 }, c: { eq: 1 }, d: { eq: 1 }, e: { eq: 1 }, f: { eq: 1 } } } })).toBe(false);
    const other = schemas(plain, "list").inputSchema as any;
    expect(other.$defs.entityFilter.properties.extensions).toBeUndefined();
    expect(ajv.compile(other)({ sort: { field: "extensions.capacityKwh" } })).toBe(false);
  });

  it("reaches OpenAPI: record and bodies carry extensions, the sort parameter accepts extensions.<key>, the Operations get paths", () => {
    const spec = JSON.parse(renderOpenApiSpec(manifest, "fixture", { entities, operations })) as any;
    expect(spec.components.schemas.ExtensiblePart.properties.extensions).toMatchObject({ type: "object", additionalProperties: true });
    expect(spec.components.schemas.RestEnabled.properties.extensions).toBeUndefined();
    const sort = spec.paths["/api/rest/v1/extensible-parts"].get.parameters.find((parameter: any) => parameter.name === "sortField");
    expect(sort.schema.anyOf[1]).toEqual({ pattern: "^extensions\\.[a-z][A-Za-z0-9]*$" });
    expect(sort.schema.anyOf[0].enum).not.toContain("extensionValues");
    const filterNames = spec.paths["/api/rest/v1/extensible-parts"].get.parameters.map((parameter: any) => parameter.name);
    expect(filterNames).not.toContain("extensionValues");
    expect(spec.paths["/api/rest/v1/extensible-parts"].post.requestBody.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/ExtensiblePartInput" });
    expect(spec.components.schemas.ExtensiblePartInput.properties.extensions).toMatchObject({ type: "object", additionalProperties: true });
    expect(spec.components.schemas.ExtensiblePartUpdateInput.properties.extensions).toMatchObject({ type: "object", additionalProperties: true });
    expect(spec.components.schemas.RestEnabledInput.properties.extensions).toBeUndefined();
    expect(spec.paths["/api/rest/v1/extensible-parts/field-definitions/create"].post).toBeDefined();
    expect(spec.paths["/api/rest/v1/rest-enableds/{id}/referenced-by"].post).toBeDefined();
  });
});
