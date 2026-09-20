// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { missingSchemaUiTranslations } from "@openshapeforge/interface-web";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { compileAuthoringBackendManifest } from "./backend-manifest.js";
import { buildWebManifest } from "./web-manifest.js";
import { authoringValidator } from "./schema-validation.js";
import { loadEntity } from "./loader.js";
import { compile as compileEntity } from "./compiler/index.js";
import { collectAuthoredEntityPluginOperations, collectPluginOperations, assertOperationRuntimeModules, buildStaticOperationCatalog } from "../generate-operations.js";
import type { CoreEntity, Field } from "./types.js";
import type { FieldDefinitionInverseCollection } from "./types/field-definition.js";
import type { CompiledEntityInfo, PluginOperationContract } from "../plugins.js";

const context = { repoRoot: "/repo", authoringDir: "/repo/authoring", webPresent: true };
const native = (action: "insert" | "move") => ({
  name: action, description: action, implementation: { type: "collection" as const, action, field: "children" },
  effects: { data: "write" as const, external: "none" as const },
  reliability: { idempotency: { mode: "none" as const } }, confirmation: { mode: "none" as const },
  concurrency: { version: { mode: "required" as const, field: "updatedAt" as const } },
});
function entity(name: string, fields: Field[]): CoreEntity {
  return {
    schemaVersion: 3, kind: "coreEntity", module: "core", entity: name, title: name, labels: { en: name, nl: name },
    language: "en", domains: ["example"], baseEntity: false,
    authorization: { roles: { read: ["Example.Read"], create: ["Example.Create"], update: ["Example.Update"] } },
    fields: [
      { key: "id", osfType: "string", required: true, validation: { format: "uuid" }, persisted: { column: "id", storageClass: "core" } },
      { key: "updatedAt", osfType: "datetime", readOnly: true, required: true, persisted: { column: "updated_at", storageClass: "core" } },
      ...fields,
    ],
    operations: Object.fromEntries(["list", "get", "create", "update"].map((action) => [action, {
      name: action, description: action, implementation: { type: "entity", action },
      effects: { data: ["get", "list"].includes(action) ? "read" : "write", external: "none" },
      reliability: { idempotency: { mode: ["get", "list"].includes(action) ? "natural" : "none" } },
      confirmation: { mode: "none" }, ...(action === "update" ? { concurrency: { version: { mode: "required", field: "updatedAt" } } } : {}),
    }])),
    interfaces: { rest: {}, graphql: {}, mcp: { tools: "generic" }, web: { views: {
      collection: { route: `/${name.toLowerCase()}s`, title: { en: name, nl: name }, columns: [{ key: "id" }] },
    } } },
  } as CoreEntity;
}
function fixture(mutate: (owner: CoreEntity, child: CoreEntity) => void = () => {}, extra: CoreEntity[] = []): CompiledEntityInfo[] {
  const owner = entity("Owner", []);
  Object.assign(owner.operations!, { insertChild: native("insert"), moveChild: native("move") });
  const child = entity("Child", [{ key: "owner", osfType: "Owner", required: true, relationship: { inverse: { key: "children", ownership: "owned", sortable: true } } }, { key: "body", osfType: "string", required: true, validation: { maxLength: 12 }, persisted: { column: "body", storageClass: "core" } }]);
  mutate(owner, child);
  const dir = mkdtempSync(join(tmpdir(), "native-collections-"));
  const entries: CompiledEntityInfo[] = [];
  try {
    mkdirSync(join(dir, "entities")); mkdirSync(join(dir, "catalogs"));
    for (const [file, value] of Object.entries({ "catalogs/components.yaml": { defaults: {}, components: {}, viewDefaults: {} }, "catalogs/transforms.yaml": { transforms: {} }, "catalogs/osf-types.yaml": { types: { entityValue: { kind: "object", valueType: "object" } } }, "entities/owner.yaml": owner, "entities/child.yaml": child, ...Object.fromEntries(extra.map((entity) => [`entities/${entity.entity.toLowerCase()}.yaml`, entity])) })) {
      writeFileSync(join(dir, file), JSON.stringify(value));
    }
    compileAuthoringBackendManifest(dir, { mode: "promote", entityAllowlist: ["owner", "child", ...extra.map((entity) => entity.entity.toLowerCase())], generatedCrudAllowlist: ["owner", "child", ...extra.map((entity) => entity.entity.toLowerCase())], onCandidate: (candidate) => entries.push(candidate as CompiledEntityInfo) });
    return entries;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const compile = (entries = fixture()) => collectAuthoredEntityPluginOperations(entries, context);
/** The derived `Owner.children` collection is shaped on `Child.owner`. */
const children = (child: CoreEntity) => child.fields.find((field) => field.key === "owner")!.relationship!.inverse as FieldDefinitionInverseCollection;

test("real authored template collection Operations compile the direct-edit variant flow under strict AJV", () => {
  const authoringDir = join(import.meta.dir, "../../config/authoring");
  const entries = ["template", "template-version", "template-variant", "block", "text-block", "youtube-embed", "template-block"].map((slug) => {
    const contract = compileEntity(loadEntity(authoringDir, slug));
    // This regression owns native schema lowering, not separately authored plugin routes.
    contract.pluginOperations = contract.pluginOperations?.filter((operation) => operation.definition.implementation.type === "collection") ?? [];
    return { slug, contract };
  });
  // The production collector validates every published schema with strict:true.
  const operations = collectAuthoredEntityPluginOperations(entries, { ...context, authoringDir });
  for (const operation of operations) {
    expect(missingSchemaUiTranslations(operation.inputSchema, `${operation.id}.input`)).toEqual([]);
    expect(missingSchemaUiTranslations(operation.outputSchema, `${operation.id}.output`)).toEqual([]);
  }
  expect(operations.filter((operation) => operation.implementation).map((operation) => operation.id).sort()).toEqual(["Template.insertVariant", "TemplateVariant.insertBlock", "TemplateVariant.moveBlock", "TemplateVariant.removeBlock", "TemplateVariant.updateBlock"]);
  const schema = operations.find((operation) => operation.id === "Template.insertVariant")!.inputSchema;
  const ajv = new Ajv.default({ strict: true }); (addFormats as unknown as (instance: typeof ajv) => unknown)(ajv);
  for (const keyword of ["x-osf-reference", "x-osf-i18n", "x-osf-sourceField", "x-osf-control", "x-osf-type"]) ajv.addKeyword({ keyword, valid: true });
  const validate = ajv.compile(schema);
  const base = { id: "10000000-0000-4000-8000-000000000001", expectedVersion: "2026-09-14T10:00:00Z" };
  for (const values of [{ channel: "document", locale: "nl" }, { channel: "email", locale: "en" }, { channel: "whatsapp", locale: "nl-NL" }]) expect(validate({ ...base, values })).toBe(true);
  for (const values of [{ locale: "nl" }, { channel: "sms", locale: "nl" }, { channel: "email", locale: "dutch" }, { channel: "email", locale: "nl", unknown: true }]) expect(validate({ ...base, values })).toBe(false);
});

test("a block's owner keys and the document lock never enter the owner-scoped values contracts", () => {
  const authoringDir = join(import.meta.dir, "../../config/authoring");
  const entries = ["template", "template-version", "template-variant", "document", "document-version", "document-variant", "block", "text-block", "youtube-embed", "template-block",
    "document-type", "case-file", "case", "relation", "account"].map((slug) => {
    const contract = compileEntity(loadEntity(authoringDir, slug));
    contract.pluginOperations = contract.pluginOperations?.filter((operation) => operation.definition.implementation.type === "collection") ?? [];
    return { slug, contract };
  });
  const operations = collectAuthoredEntityPluginOperations(entries, { ...context, authoringDir });
  const values = (id: string) => Object.keys((operations.find((operation) => operation.id === id)!.inputSchema.properties as Record<string, { properties: Record<string, unknown> }>).values!.properties);
  // Neither owner FK is a caller choice through a collection; the lock is server-managed on a document block only.
  for (const id of ["DocumentVariant.insertBlock", "DocumentVariant.updateBlock"]) {
    expect(values(id)).not.toContain("variant"); expect(values(id)).not.toContain("documentVariant"); expect(values(id)).not.toContain("locked");
  }
  for (const id of ["TemplateVariant.insertBlock", "TemplateVariant.updateBlock"]) {
    expect(values(id)).not.toContain("variant"); expect(values(id)).not.toContain("documentVariant"); expect(values(id)).toContain("locked");
  }
  expect(values("DocumentVariant.insertBlock")).toContain("values");
});

test("lowers native collection declarations to the canonical invoke catalog and validates concrete input", () => {
  const entries = fixture();
  const operations = compile(entries);
  const insert = operations.find((operation) => operation.id === "Owner.insertChild")!;
  expect(insert).toMatchObject({ intent: "invoke", plugin: "core", handler: "collectionMutation", implementation: { type: "collection", entityName: "Owner", field: "children", action: "insert" }, target: { entityName: "Owner", scope: "record", inputField: "id" }, auth: { mode: "session", roles: ["Example.Update"] }, tenancy: { mode: "required" } });
  expect(insert.transports.mcp.enabled).toBe(true);
  expect(insert.transports.graphql.enabled).toBe(true);
  expect(buildStaticOperationCatalog(operations, [], entries, {}).operations).toHaveLength(2);
  expect(() => assertOperationRuntimeModules(operations, [])).not.toThrow();
  const ajv = new Ajv.default({ strict: false }); (addFormats as unknown as (instance: typeof ajv) => unknown)(ajv);
  const validate = ajv.compile(insert.inputSchema);
  const input = { id: "10000000-0000-4000-8000-000000000001", expectedVersion: "2026-09-14T10:00:00Z", values: { body: "hello" } };
  expect(validate(input)).toBe(true);
  for (const values of [{}, { body: "x".repeat(13) }, { body: "hello", owner: input.id }, { body: "hello", unknown: 1 }]) expect(validate({ ...input, values })).toBe(false);
  expect(validate({ ...input, expectedVersion: undefined })).toBe(false);
  const move = ajv.compile(operations.find((operation) => operation.id === "Owner.moveChild")!.inputSchema);
  expect(move({ id: input.id, expectedVersion: input.expectedVersion, childId: input.id, beforeId: null })).toBe(true);
  expect(move({ id: input.id, expectedVersion: input.expectedVersion })).toBe(false);
});

test("binds Web relationship insert/move by field and advertises atomic only for projected declared actions", () => {
  const entries = fixture();
  const web = buildWebManifest(entries);
  expect(web.entities.Owner!.relationships.children).toMatchObject({ mutationSupport: "atomic", operations: { insert: { id: "Owner.insertChild", intent: "invoke" }, move: { id: "Owner.moveChild", intent: "invoke" } } });
  const absent = fixture((owner) => { delete owner.operations!.insertChild; delete owner.operations!.moveChild; });
  expect(buildWebManifest(absent).entities.Owner!.relationships.children).toMatchObject({ mutationSupport: "unsupported" });
  const hidden = fixture();
  for (const entry of hidden) for (const operation of entry.contract.pluginOperations ?? []) operation.interfaces.web = false;
  expect(buildWebManifest(hidden).entities.Owner!.relationships.children).toMatchObject({ mutationSupport: "unsupported" });
});

test("materializes one atomic create Operation for a reference with a hasMany constraint", () => {
  const membership = entity("Membership", [
    { key: "child", osfType: "Child", required: true },
    { key: "groupId", osfType: "string", required: true, validation: { format: "uuid" }, persisted: { column: "group_id", storageClass: "core" } },
  ]);
  const groupId = "10000000-0000-4000-8000-000000000099";
  const entries = fixture((owner, child) => {
    owner.fields.push({
      key: "primaryChild", osfType: "Child", required: true,
      relationship: { constraints: { kind: { eq: "primary" }, memberships: { any: { groupId: { eq: groupId } } } } },
    });
    child.fields.push({ key: "kind", osfType: "string", required: true, persisted: { column: "kind", storageClass: "core" } });
  }, [membership]);
  const operation = compile(entries).find(item => item.id === "core.Owner.primaryChild.create-constrained-reference")!;
  expect(operation).toMatchObject({
    plugin: "core", handler: "constrainedReferenceCreate", intent: "invoke",
    implementation: {
      type: "constrained-reference-create", targetEntityName: "Child", collectionEntityName: "Membership",
      parentField: "child", targetValues: { kind: "primary" }, childValues: { groupId },
    },
  });
  expect(buildWebManifest(entries).entities.Owner!.fields.primaryChild!.relationship).toMatchObject({
    targetEntityId: "Child",
    createOperation: { id: operation.id, intent: "invoke" },
  });
});

test("materializes direct-only constrained create with server-owned values", () => {
  const entries = fixture((owner, child) => {
    owner.fields.push({
      key: "primaryChild", osfType: "Child", required: true,
      relationship: { constraints: { kind: { eq: "primary" } } },
    });
    child.fields.push({ key: "kind", osfType: "string", required: true, persisted: { column: "kind", storageClass: "core" } });
  });
  const operation = compile(entries).find(item => item.id === "core.Owner.primaryChild.create-constrained-reference")!;
  expect(operation).toMatchObject({
    auth: { mode: "session", roleGroups: [["Example.Create"]] },
    implementation: {
      type: "constrained-reference-create", targetEntityName: "Child", targetValues: { kind: "primary" },
    },
  });
  const values = (operation.inputSchema.properties as Record<string, unknown>).values as { properties: Record<string, unknown>; required: string[] };
  expect(values.properties.kind).toBeUndefined();
  expect(values.required).toEqual(["owner", "body"]);
  expect(operation.implementation).not.toHaveProperty("collectionEntityName");
  expect(buildWebManifest(entries).entities.Owner!.fields.primaryChild!.relationship).toMatchObject({
    createOperation: { id: operation.id, intent: "invoke" },
  });
});

test("constrained reference create refuses guarded target and child create Operations", () => {
  const direct = (mutate: (create: NonNullable<CoreEntity["operations"]>[string]) => void) =>
    fixture((owner, child) => {
      delete owner.operations!.insertChild;
      delete owner.operations!.moveChild;
      owner.fields.push({
        key: "primaryChild", osfType: "Child", required: true,
        relationship: { constraints: { kind: { eq: "primary" } } },
      });
      child.fields.push({ key: "kind", osfType: "string", required: true, persisted: { column: "kind", storageClass: "core" } });
      mutate(child.operations!.create!);
    });
  expect(() => compile(direct((create) => { create.confirmation = { mode: "acknowledgement" }; }))).toThrow("target create needs an unguarded native entity create Operation");
  expect(() => compile(direct((create) => { create.reliability.idempotency = { mode: "keyed", inputField: "requestId" }; }))).toThrow("keyed idempotency");

  const membership = entity("Membership", [
    { key: "child", osfType: "Child", required: true },
    { key: "groupId", osfType: "string", required: true, validation: { format: "uuid" }, persisted: { column: "group_id", storageClass: "core" } },
  ]);
  membership.operations!.create!.confirmation = { mode: "acknowledgement" };
  expect(() => compile(fixture((owner) => {
    delete owner.operations!.insertChild;
    delete owner.operations!.moveChild;
    owner.fields.push({
      key: "primaryChild", osfType: "Child", required: true,
      relationship: { constraints: { memberships: { any: { groupId: { eq: "10000000-0000-4000-8000-000000000099" } } } } },
    });
  }, [membership]))).toThrow("child create needs an unguarded native entity create Operation");
});

test("refuses spoofed native metadata and a cloned native Operation without compiler provenance", () => {
  const operation = compile()[0]!;
  expect(() => collectPluginOperations([{ name: "core", operations: [{ ...operation, key: operation.id } as PluginOperationContract] }], context)).toThrow("implementation");
  expect(() => assertOperationRuntimeModules([{ ...operation }], ["core"])).toThrow("native");
});

test("reference-data schemas are independent of Web-first versus catalog-first projection", () => {
  const entries = () => fixture((_owner, child) => { child.fields.find((field) => field.key === "body")!.options = { type: "referentiedata", referentieGroep: "words" }; });
  const snapshot = { words: [{ value: "hello", label: { en: "Hello", nl: "Hallo" } }] };
  const webFirst = entries();
  buildWebManifest(webFirst); // A caller with an empty snapshot must never poison later lowering.
  const firstCatalog = collectAuthoredEntityPluginOperations(webFirst, context, snapshot);
  const firstWeb = buildWebManifest(webFirst, {}, { catalogs: [], operations: [] }, snapshot);
  const catalogFirst = entries();
  const secondCatalog = collectAuthoredEntityPluginOperations(catalogFirst, context, snapshot);
  const secondWeb = buildWebManifest(catalogFirst, {}, { catalogs: [], operations: [] }, snapshot);
  expect(firstCatalog).toEqual(secondCatalog);
  expect(firstWeb).toEqual(secondWeb);
  expect(firstCatalog.find((operation) => operation.id === "Owner.insertChild")!.inputSchema).toMatchObject({ properties: { values: { properties: { body: { enum: ["hello"] } } } } });
});

test("entityValue insert derives logical own values and named UUID references from allowed definitions", () => {
  const definition = entity("Copy", []);
  definition.fields = [{ key: "text", osfType: "string", required: true }, { key: "source", osfType: "Owner", required: true }];
  definition.operations = { materialize: { name: "Project", description: "Project", implementation: { type: "plugin", plugin: "example", handler: "project" }, target: { scope: "collection" }, input: { schema: { type: "object", properties: {} } }, output: { schema: { type: "object" } }, errors: [], auth: { mode: "session", roles: ["Example.Read"] }, tenancy: { mode: "required" }, effects: { data: "read", external: "none" }, reliability: { idempotency: { mode: "natural" } }, confirmation: { mode: "none" } } };
  definition.interfaces = { rest: {}, mcp: { tools: "generic" } };
  const entries = fixture((_owner, child) => {
    children(child).allowedDefinitions = ["Copy"];
    child.fields.push({ key: "definitionKey", osfType: "string", required: true, persisted: { column: "definition_key", storageClass: "core" } }, { key: "values", osfType: "entityValue", entityValue: { definitionField: "definitionKey" }, required: true, persisted: { column: "values", storageClass: "core" } });
  }, [definition]);
  const operation = compile(entries).find((operation) => operation.id === "Owner.insertChild")!;
  const ajv = new Ajv.default({ strict: false }); (addFormats as unknown as (instance: typeof ajv) => unknown)(ajv);
  const validate = ajv.compile(operation.inputSchema);
  const id = "10000000-0000-4000-8000-000000000001";
  const input = { id, expectedVersion: "2026-09-14T10:00:00Z", values: { body: "hello", definitionKey: "Copy", values: { text: "text", source: id } } };
  expect(validate(input)).toBe(true);
  expect(validate({ ...input, values: { ...input.values, definitionKey: "Unknown" } })).toBe(false);
  expect(validate({ ...input, values: { ...input.values, values: { text: "text" } } })).toBe(false);
  expect(validate({ ...input, values: { ...input.values, values: { text: "text", source: "invalid" } } })).toBe(false);
  expect(validate({ ...input, values: { ...input.values, values: { text: "text", source: id, unknown: true } } })).toBe(false);
});

test("fails closed on unsupported ownership, sorting, actions and child guard combinations", () => {
  expect(() => compile(fixture((_owner, child) => { children(child).sortable = false; }))).toThrow("sortable");
  expect(() => compile(fixture((_owner, child) => { children(child).ownership = "reference"; }))).toThrow("owned");
  expect(() => fixture((owner) => { Object.assign(owner.operations!.insertChild!.implementation, { action: "link" }); })).toThrow();
  expect(() => fixture((owner) => { owner.operations!.insertChild!.auth = { mode: "session", roles: ["Other"] }; })).toThrow();
  expect(() => compile(fixture((owner) => { owner.operations!.insertAgain = native("insert"); }))).toThrow("one collection Operation");
  expect(() => compile(fixture((_owner, child) => { child.operations!.create!.confirmation = { mode: "acknowledgement" }; }))).toThrow();
  expect(() => compile(fixture((owner) => { delete owner.operations!.update!.concurrency; }))).toThrow("updatedAt");
});

test("authoring schema accepts identityless baseEntity false and object semantic catalog metadata", () => {
  const document = entity("Example", [{ key: "label", osfType: "string" }]);
  expect(() => authoringValidator().validate(document, "/authoring/entities/core/example.yaml")).not.toThrow();
  expect(() => authoringValidator().validate({ kind: "osfTypeCatalog", schemaVersion: 1, types: { entityValue: { kind: "object", valueType: "object", label: { en: "Entity value" } } } }, "/authoring/catalogs/osf-types.yaml")).not.toThrow();
});
