// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { compile } from "./index.js";
import { buildWebManifest, hasWebRestCollection } from "../web-manifest.js";
import { assertEntityAuthoring } from "../entity-authoring.js";
import { deriveEntityOsfTypes } from "../entity-fields.js";
import { collectAuthoredEntityPluginOperations } from "../../generate-operations.js";
import type { CoreEntity } from "../types.js";
import type { LoadedArtifacts } from "../loader.js";

function entity(name = "Account"): CoreEntity {
  const read = (action: "list" | "get") => ({
    name: { en: action, nl: action }, description: { en: "Read records", nl: "Records lezen" },
    implementation: { type: "plugin" as const, plugin: "accounts", handler: action, action },
    input: { schema: {} }, output: { schema: {} }, errors: [],
    effects: { data: "read" as const, external: "none" as const },
    reliability: { idempotency: { mode: "natural" as const } }, confirmation: { mode: "none" as const },
  });
  return {
    schemaVersion: 3, kind: "coreEntity", module: "core", entity: name,
    title: name, labels: { en: name, nl: name }, language: "en", source: { kind: "operations" },
    displayTemplate: "{{label}}", filterField: "label",
    fields: [
      { key: "id", osfType: "string", required: true, readOnly: true, label: { en: "ID", nl: "ID" } },
      { key: "label", osfType: "string", required: true, readOnly: true, label: { en: "Name", nl: "Naam" } },
      { key: "email", osfType: "string", readOnly: true, label: { en: "Email", nl: "E-mail" } },
    ], authorization: { roles: { read: ["Organization.Accounts.Read"] } },
    operations: { list: read("list"), get: read("get") },
    interfaces: { rest: {}, mcp: {}, graphql: {}, web: { views: {
      collection: { route: `/${name.toLowerCase()}`, columns: [{ key: "label" }] },
      record: { title: "{{label}}", routes: { read: `/${name.toLowerCase()}/:id` }, layout: { tabs: [{ id: "main", label: { en: "Details", nl: "Details" }, fields: ["label", "email"] }] } },
    } } },
  };
}
function contract(input: CoreEntity) {
  const artifacts = { coreEntity: input, profiles: [], mappings: [],
    componentCatalog: { defaults: {}, viewDefaults: {}, components: {} }, osfTypes: {},
    retentionPolicies: {}, referentiedata: {}, } as unknown as LoadedArtifacts;
  return compile(artifacts);
}

test("REST-driven source collections require positive Web and REST projections", () => {
  const model = contract(entity());
  expect(hasWebRestCollection(model)).toBe(true);
  for (const transport of ["rest", "web"] as const) {
    for (const projection of [undefined, false] as const) {
      const unavailable = structuredClone(model);
      const interfaces = unavailable.pluginOperations!.find(operation => operation.key === "list")!.interfaces;
      if (projection === undefined) Reflect.deleteProperty(interfaces, transport);
      else Reflect.set(interfaces, transport, projection);
      expect(hasWebRestCollection(unavailable)).toBe(false);
    }
  }
});

test("normal entity schema and read policy produce Operation-backed records on every interface", () => {
  const input = entity();
  assertEntityAuthoring(input, "source.yaml");
  const compiled = contract(input);
  expect(compiled.storage.columns).toEqual([]);
  expect(compiled.entityOperations).toEqual({});
  const list = compiled.pluginOperations!.find(op => op.key === "list")!;
  expect((list.definition.output!.schema as any).properties.items.items.properties.email.anyOf).toHaveLength(2);
  expect(list.definition.auth).toEqual({ mode: "session", roles: ["Organization.Accounts.Read"] });
  expect(list.definition.tenancy).toEqual({ mode: "required" });
  expect(list.interfaces).toMatchObject({ rest: {}, mcp: {}, graphql: {}, web: {} });
  const web = buildWebManifest([{ slug: "account", contract: compiled }], { requireTranslations: true });
  expect(web.entities.Account!.operationSource).toMatchObject({ idField: "id", collection: { resultField: "items" }, record: { bindings: { id: "id" } } });
  expect(web.entities.Account!.views.record!.operations.read!.id).toBe("Account.get");
  expect(web.entities.Account!.views.collection.renderer).toBe("operation.entity.collection");
  expect(web.entities.Account!.views.record!.renderer).toBe("operation.entity.record");
  expect(compiled.pluginOperations!.find(op => op.key === "get")!.definition.errors).toContainEqual({ status: 404, code: "NOT_FOUND", description: "Record not found in this organization." });
  expect(Object.hasOwn(list.definition.implementation, "action")).toBe(false);
  expect(list.definition.errors).toContainEqual({ status: 401, code: "TENANT_REQUIRED", description: "Select an organization to read this entity." });
  const operations = collectAuthoredEntityPluginOperations([{ contract: compiled }], { manifest: { tables: [] } } as any);
  expect(operations.find(op => op.id === "Account.get")!.resultProjection).toEqual({ kind: "entity-record", entityName: "Account", idField: "id" });
  expect(operations.find(op => op.id === "Account.get")!.outputSchema).toMatchObject({ required: ["data", "operations"],
    properties: { data: { required: ["id", "label"] }, operations: { type: "array" } } });
  expect(operations.find(op => op.id === "Account.list")!.transports).toMatchObject({ mcp: { enabled: true }, graphql: { enabled: true, kind: "query" } });
});

test("the same source contract serves group-role assignments, without Account branches", () => {
  const assignment = entity("GroupRoleAssignment");
  assignment.fields = assignment.fields.filter(field => field.key !== "email");
  assignment.fields.push(
    { key: "groupId", osfType: "string", required: true, readOnly: true, label: { en: "Group", nl: "Groep" } },
    { key: "role", osfType: "string", required: true, readOnly: true, label: { en: "Role", nl: "Rol" } },
    { key: "version", osfType: "integer", required: true, readOnly: true, label: { en: "Version", nl: "Versie" } },
  );
  assignment.authorization!.roles.read = ["Organization.Access.Read"];
  assignment.interfaces!.web!.views!.record!.layout!.tabs![0]!.fields = ["groupId", "role", "version"];
  for (const op of Object.values(assignment.operations!)) if (op.implementation.type === "plugin") {
    op.implementation.handler = `groupRoles.${op.implementation.action}`;
  }
  const compiled = contract(assignment);
  const list = compiled.pluginOperations!.find(op => op.key === "list")!;
  expect((list.definition.output!.schema as any).properties.items.items.properties.version.type).toBe("integer");
  expect((list.definition.input!.schema as any).properties.groupId.type).toBe("string");
  expect(list.definition.auth).toEqual({ mode: "session", roles: ["Organization.Access.Read"] });
  expect(deriveEntityOsfTypes([assignment], {}).GroupRoleAssignment!.kind).toBe("provider");
  expect(buildWebManifest([{ slug: "group-role-assignment", contract: compiled }]).entities.GroupRoleAssignment!.fields.role!.osfType).toBe("string");
});

test("record input bindings copy required scalar fields without expressions or target-id overrides", () => {
  const input = entity();
  input.fields.push({ key: "revision", osfType: "string", required: true, readOnly: true, label: { en: "Revision", nl: "Revisie" } });
  input.operations!.block = { ...input.operations!.get!, implementation: { type: "plugin", plugin: "accounts", handler: "block" },
    target: { scope: "record", inputField: "id", inputBindings: { revision: "revision" } },
    input: { schema: { type: "object", required: ["id", "revision"], properties: { id: { type: "string" }, revision: { type: "string" } } } },
    output: { schema: { type: "object" } }, auth: { mode: "session", roles: ["Organization.Accounts.Manage"] }, tenancy: { mode: "required" } };
  const compiled = contract(input);
  input.interfaces!.web!.views!.record!.actions = ['block'];
  const web = buildWebManifest([{ slug: 'account', contract: contract(input) }]);
  expect(web.entities.Account!.views.record!.operations.actions!.map(action => action.id)).toEqual(['Account.block']);
  expect(web.entities.Account!.views.record!.operations.actions![0]!.target).toMatchObject({ scope: 'record', inputField: 'id' });
  expect(web.entities.Account!.views.record!.operations.actions![0]!.input!.schema).toMatchObject({ required: ['id', 'revision'] });
  expect(collectAuthoredEntityPluginOperations([{ contract: compiled }], {} as any).find(op => op.id === "Account.block")!.target)
    .toMatchObject({ inputBindings: { revision: "revision" } });
  for (const bindings of [{ revision: "unknown" }, { revision: "revision.value" }, { id: "revision" }, { revision: "email" }]) {
    const invalid = structuredClone(input);
    (invalid.operations!.block!.target as any).inputBindings = bindings;
    expect(() => contract(invalid)).toThrow("inputBindings");
  }
});

test("source entities fail closed for SQL persistence and generic CRUD", () => {
  const persisted = entity(); persisted.fields[1]!.persisted = { column: "label", storageClass: "core" }; persisted.fields[1]!.writeSource = "caller";
  expect(() => contract(persisted)).toThrow("no persisted fields");
  const sql = entity(); sql.operations!.create = { ...sql.operations!.list!, implementation: { type: "entity", action: "create" } };
  expect(() => contract(sql)).toThrow("never generated SQL CRUD");
  const unprotected = entity(); unprotected.authorization!.roles.read = [];
  expect(() => contract(unprotected)).toThrow("authorization.roles.read must be present");
});

test("read contracts cannot override the entity's fields, tenant or roles", () => {
  const input = entity(); input.operations!.list!.auth = { mode: "public" };
  expect(() => assertEntityAuthoring(input, "source.yaml")).toThrow("compiler-derived");
  delete input.operations!.list!.auth;
  input.operations!.list!.output = { schema: { type: "object" } };
  expect(() => assertEntityAuthoring(input, "source.yaml")).toThrow("compiler-derived");
});

test("source reads refuse unenforced row and field policies instead of silently widening access", () => {
  const row = entity(); row.authorization!.rowAccess = { enabled: true, empty: "public" };
  expect(() => contract(row)).toThrow("storage policies");
  const protectedField = entity(); protectedField.fields[2]!.classification = { sensitivity: "pii" };
  expect(() => contract(protectedField)).toThrow("cannot silently bypass authorization");
  const nested = entity();
  nested.fields.push({ key: "contact", osfType: "object", children: [{ key: "secret", osfType: "string", classification: { sensitivity: "confidential" } }] });
  expect(() => contract(nested)).toThrow("cannot silently bypass authorization");
});

test("source identity aliases use the authored key shape, not an invented SQL UUID", () => {
  const input = entity("GroupRoleAssignment");
  const unconstrained = deriveEntityOsfTypes([input], {});
  expect(unconstrained.GroupRoleAssignment!.validation).toBeUndefined();
  expect(unconstrained.groupRoleAssignmentId!.validation).toBeUndefined();
  input.fields[0]!.validation = { pattern: "^grant-[a-z0-9]+$" };
  expect(deriveEntityOsfTypes([input], {}).groupRoleAssignmentId!.validation).toEqual({ pattern: "^grant-[a-z0-9]+$" });
});

test("turning a referenced storage entity into a source names the preservation obligation", () => {
  const input = entity();
  const owner = entity("Owner");
  delete owner.source;
  owner.fields.push({ key: "account", osfType: "Account" });
  expect(() => deriveEntityOsfTypes([input, owner], {})).toThrow("Owner.account: Operation-backed source Account cannot silently replace a stored entity reference");
  expect(() => deriveEntityOsfTypes([input, owner], {})).toThrow("Preserve/migrate existing columns explicitly");
});
test("query capabilities are bounded, explicit, and projected from the executable Operation", () => {
  for (const key of ["first", "after", "sortField", "sortDirection"]) {
    const input = entity(); input.fields.push({ key, osfType: "string" });
    expect(() => contract(input)).toThrow("reserved collection query key");
  }
  const input = entity(); input.source!.query = { filterFields: ["label"], sortFields: ["id", "label"] };
  const compiled = contract(input);
  const list = compiled.pluginOperations!.find(op => op.key === "list")!;
  expect((list.definition.input!.schema as any).properties).not.toHaveProperty("email");
  const web = buildWebManifest([{ slug: "account", contract: compiled }]);
  expect(web.entities.Account!.operationSource!.collection.query!.input).toEqual({
    kind: "collection-query", filterFields: ["label"], sortFields: ["id", "label"], pagination: { kind: "cursor", defaultLimit: 50, maxLimit: 200 },
  });
});
