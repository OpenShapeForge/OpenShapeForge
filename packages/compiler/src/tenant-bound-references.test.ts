// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { generateArtifacts } from "./generate.js";
import type { ColumnDefinition, PlatformSchemaManifest, TableDefinition } from "./schema.js";
import { assertTenantBoundReferences, ensureCompositeReferenceKeys } from "./tenant-bound-references.js";

const tenantTable = (name: string, extra: ColumnDefinition[] = []): TableDefinition => ({
  schema: "erp",
  name,
  tenantScoped: true,
  columns: [
    { name: "id", type: "uuid", primaryKey: true },
    { name: "tenant_id", type: "uuid", required: true },
    ...extra,
  ],
});

const composite = (column: string, table: string, local = "tenant_id") => ({
  schema: "erp", table, column: "id",
  localColumns: [local, column], targetColumns: ["tenant_id", "id"],
});

function manifest(...tables: TableDefinition[]): PlatformSchemaManifest {
  return { version: 1, tables };
}

function schemaSql(input: PlatformSchemaManifest): string {
  ensureCompositeReferenceKeys(input);
  return generateArtifacts(input).find((artifact) => artifact.path.endsWith("schema.sql"))!.contents;
}

describe("tenant-bound references", () => {
  it("refuses a single-column reference between two tenant-scoped tables and names the fix", () => {
    const orders = tenantTable("orders", [
      { name: "customer_id", type: "uuid", references: { schema: "erp", table: "customers", column: "id" } },
    ]);
    expect(() => assertTenantBoundReferences(manifest(orders, tenantTable("customers")))).toThrow(
      "erp.orders.customer_id references tenant-scoped erp.customers by (customer_id) alone; " +
        "a tenant-scoped row must reuse its own tenant: set references.localColumns: [tenant_id, customer_id] " +
        "and references.targetColumns: [tenant_id, id].",
    );
  });

  it("refuses a global table reaching a tenant-scoped table without a tenant column pair", () => {
    const registry: TableDefinition = {
      schema: "platform", name: "tenants", tenantScoped: false, tenantIdentityColumn: "id",
      columns: [
        { name: "id", type: "uuid", primaryKey: true },
        { name: "relation_id", type: "uuid", references: { schema: "erp", table: "relations", column: "id" } },
      ],
    };
    expect(() => assertTenantBoundReferences(manifest(registry, tenantTable("relations")))).toThrow(
      "Global table platform.tenants may reference tenant-scoped erp.relations only through an explicit tenant column pair, " +
        "but relation_id references it by (relation_id) alone: set references.localColumns: [id, relation_id] " +
        "and references.targetColumns: [tenant_id, id].",
    );
    registry.columns[1]!.references = {
      schema: "erp", table: "relations", column: "id", localColumns: ["id", "relation_id"], targetColumns: ["tenant_id", "id"],
    };
    expect(schemaSql(manifest(registry, tenantTable("relations")))).toContain(
      'FOREIGN KEY ("id", "relation_id")\n      REFERENCES "erp"."relations"("tenant_id", "id");',
    );
  });

  it("requires a tenant-scoped row to bind through its own tenant_id", () => {
    const orders = tenantTable("orders", [
      { name: "other_tenant", type: "uuid", required: true },
      { name: "customer_id", type: "uuid", references: composite("customer_id", "customers", "other_tenant") },
    ]);
    expect(() => assertTenantBoundReferences(manifest(orders, tenantTable("customers")))).toThrow(
      "erp.orders.customer_id binds erp.customers.tenant_id to other_tenant; a tenant-scoped row must reuse its own tenant_id",
    );
  });

  it("refuses a nullable tenant column on the referencing side", () => {
    const keys: TableDefinition = {
      schema: "platform", name: "api_keys", tenantScoped: false,
      columns: [
        { name: "id", type: "uuid", primaryKey: true },
        { name: "tenant_id", type: "uuid" },
        { name: "integration_id", type: "uuid", references: composite("integration_id", "integrations") },
      ],
    };
    expect(() => assertTenantBoundReferences(manifest(keys, tenantTable("integrations")))).toThrow(
      "which must be a required UUID column of platform.api_keys; a nullable tenant leaves the foreign key unchecked",
    );
  });

  it("accepts tenant → global, the row's own tenant identity, and a bound composite", () => {
    const registry: TableDefinition = {
      schema: "platform", name: "tenants", tenantScoped: false, tenantIdentityColumn: "id",
      columns: [{ name: "id", type: "uuid", primaryKey: true }],
    };
    const orders = tenantTable("orders", [
      { name: "customer_id", type: "uuid", references: composite("customer_id", "customers") },
      { name: "catalog_id", type: "uuid", references: { schema: "platform", table: "tenants", column: "id" } },
    ]);
    // The row's own tenant identity pointing at the registry is the binding itself.
    orders.columns.find((column) => column.name === "tenant_id")!.references = { schema: "platform", table: "tenants", column: "id" };
    const sql = schemaSql(manifest(registry, orders, tenantTable("customers")));
    expect(sql).toContain('FOREIGN KEY ("tenant_id", "customer_id")\n      REFERENCES "erp"."customers"("tenant_id", "id");');
    expect(sql).toContain('FOREIGN KEY ("tenant_id")\n      REFERENCES "platform"."tenants"("id");');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "customers_tenant_id_id_key" ON "erp"."customers" ("tenant_id", "id");');
  });

  it("provisions the target key once and leaves an equivalent authored index alone", () => {
    const customers = tenantTable("customers");
    customers.indexes = [{ name: "customers_identity_uidx", columns: ["tenant_id", "id"], unique: true }];
    const orders = tenantTable("orders", [
      { name: "customer_id", type: "uuid", references: composite("customer_id", "customers") },
      { name: "billing_customer_id", type: "uuid", references: composite("billing_customer_id", "customers") },
    ]);
    const input = manifest(orders, customers);
    ensureCompositeReferenceKeys(input);
    ensureCompositeReferenceKeys(input);
    expect(customers.indexes).toEqual([{ name: "customers_identity_uidx", columns: ["tenant_id", "id"], unique: true }]);
  });

  it("scopes ON DELETE SET NULL to the reference column of a composite key and refuses it on a NOT NULL column", () => {
    const orders = tenantTable("orders", [
      { name: "customer_id", type: "uuid", references: { ...composite("customer_id", "customers"), onDelete: "SET NULL" } },
      { name: "catalog_id", type: "uuid", references: { schema: "platform", table: "catalogs", column: "id", onDelete: "SET NULL" } },
    ]);
    const catalogs: TableDefinition = {
      schema: "platform", name: "catalogs", tenantScoped: false, columns: [{ name: "id", type: "uuid", primaryKey: true }],
    };
    const sql = schemaSql(manifest(orders, catalogs, tenantTable("customers")));
    expect(sql).toContain('REFERENCES "erp"."customers"("tenant_id", "id") ON DELETE SET NULL ("customer_id");');
    expect(sql).toContain('REFERENCES "platform"."catalogs"("id") ON DELETE SET NULL;');
    orders.columns.find((column) => column.name === "customer_id")!.required = true;
    expect(() => schemaSql(manifest(orders, catalogs, tenantTable("customers")))).toThrow(
      "erp.orders.customer_id is NOT NULL and cannot use ON DELETE SET NULL",
    );
  });
});
