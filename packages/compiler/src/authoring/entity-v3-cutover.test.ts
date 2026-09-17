// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { deriveEntityOsfTypes, normalizeEntityFields } from "./entity-fields.js";
import { assertV2Authoring, v2WebOperationActions } from "./entity-v2.js";
import { createAuthoringValidator } from "./schema-validation.js";
import { compileAuthoringBackendManifest } from "./backend-manifest.js";
import { generateArtifacts } from "../generate.js";
import { buildCrud } from "./compiler/crud.js";
import type { CoreEntity, Field } from "./types.js";

const entity = (name: string, fields: Field[] = []): CoreEntity => ({
  schemaVersion: 3, kind: "coreEntity", module: "core", entity: name, title: name, language: "en", fields,
  operations: {}, interfaces: {}, authorization: { roles: { read: ["General.All.Read"] } },
});

test("identity-bearing v3 storage entities have no implicit CRUD; v2 and identityless definitions still reject empty operations", () => {
  const internal = entity("Internal", [{ key: "name", osfType: "string" }]);
  const validator = createAuthoringValidator();
  expect(() => validator.validate(internal, "internal.yaml")).not.toThrow();
  expect(() => assertV2Authoring(internal, "internal.yaml")).not.toThrow();
  expect(buildCrud(internal).operations).toEqual({ list: false, get: false, create: false, update: false, delete: false });
  expect(() => validator.validate({ ...internal, schemaVersion: 2 }, "legacy.yaml")).toThrow();
  expect(() => assertV2Authoring({ ...internal, schemaVersion: 2 }, "legacy.yaml")).toThrow();
  expect(() => assertV2Authoring({ ...internal, baseEntity: false }, "value.yaml")).toThrow();
});

test("presentation-only Web fields do not expose standalone Web operations", () => {
  const internal = entity("Internal", [{ key: "title", osfType: "string" }]);
  internal.interfaces = { web: { fields: { title: { render: { component: "Input" } } } } };
  expect(() => createAuthoringValidator().validate(internal, "internal.yaml")).not.toThrow();
  expect(() => assertV2Authoring(internal, "internal.yaml")).not.toThrow();
  expect(v2WebOperationActions(internal)).toBeUndefined();
  internal.interfaces.web!.fields!.missing = { render: { component: "Input" } };
  expect(() => assertV2Authoring(internal, "internal.yaml")).toThrow("missing");
});

const source = () => entity("Route", [
  { key: "customer", osfType: "Customer" },
  { key: "invoices", osfType: "Bill", cardinality: "collection", relationship: { inverse: "customer", via: "customer", ownership: "reference" } },
]);
const customer = entity("Customer");
const bill = entity("Bill", [{ key: "customer", osfType: "Customer" }]);

test("indirect inverse collections are read-only traversals, never owned links", () => {
  const route = source();
  const catalog = deriveEntityOsfTypes([route, customer, bill], {});
  expect(normalizeEntityFields(route, catalog).fields[1]).toMatchObject({ readOnly: true, relationship: {
    kind: "hasMany", target: "Bill", foreignKey: "customer_id", through: { field: "customer", column: "customer_id", target: "Customer" },
  } });
  for (const patch of [{ sortable: true }, { relationship: { inverse: "customer", via: "customer", ownership: "owned" } },
    { relationship: { inverse: "customer", via: "missing" } }]) {
    const invalid = source(); Object.assign(invalid.fields[1]!, patch);
    expect(() => normalizeEntityFields(invalid, catalog)).toThrow("via requires");
  }
});

test("generated SQL uses both real intermediate FKs without an invented outer FK or junction", () => {
  const dir = mkdtempSync(join(tmpdir(), "osf-v3-through-"));
  try {
    cpSync(join(import.meta.dir, "__fixtures__/rowaccess"), dir, { recursive: true });
    for (const [slug, value] of [["route", source()], ["customer", customer], ["bill", bill]] as const) {
      writeFileSync(join(dir, "entities", `${slug}.yaml`), stringify(value));
    }
    const manifest = compileAuthoringBackendManifest(dir, { mode: "promote", schemaByModule: { core: "erp" }, entityAllowlist: ["route", "customer", "bill"] });
    const route = manifest.tables.find(table => table.name === "routes")!;
    const invoice = manifest.tables.find(table => table.name === "bills")!;
    for (const table of [route, invoice]) {
      expect(table.columns.find(column => column.name === "customer_id")!.references).toMatchObject({ table: "customers", localColumns: ["tenant_id", "customer_id"] });
      expect(table.columns.some(column => column.name === "route_id")).toBe(false);
    }
    expect(manifest.tables).toHaveLength(3);
    expect(route.source?.graphql?.relationships?.find(relation => relation.name === "invoices")).toMatchObject({ through: { field: "customer", column: "customer_id", target: "Customer" } });
    const sql = generateArtifacts(manifest).find(artifact => artifact.path.endsWith("schema.sql"))!.contents;
    expect(sql).toContain('REFERENCES "erp"."customers"("tenant_id", "id")');
    expect(sql).not.toContain('REFERENCES "erp"."routes"');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
