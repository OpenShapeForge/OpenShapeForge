// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOperationCatalogs, moduleOperationId } from "./operation-catalog.js";

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

  test("rejects record permission on a module-global Operation", () => {
    expect(() => loadOperationCatalogs(authoringRoot(
      operation.replace(
        "auth: { mode: session, roles: [Example.Read] }",
        "auth: { mode: session, roles: [Example.Read], recordPermission: view }",
      ),
    ))).toThrow(/cannot declare recordPermission without an entity record target/);
  });

  test("reserves plugin CRUD actions for entity-owned Operations", () => {
    expect(() => loadOperationCatalogs(authoringRoot(
      operation.replace(
        "implementation: { type: plugin, plugin: example, handler: guide }",
        "implementation: { type: plugin, plugin: example, handler: guide, action: create }",
      ),
    ))).toThrow(/must NOT be valid|cannot claim entity CRUD action/);
  });
});

const controlCatalog = `
schemaVersion: 1
kind: operationCatalog
plugin: osf-control
operations:
  listTenants:
    id: control.list-tenants
    name: { en: Tenants, nl: Tenants }
    description: { en: Every tenant of the deployment., nl: Alle tenants van deze omgeving. }
    implementation: { type: plugin, plugin: osf-control, handler: listTenants }
    input: { schema: { type: object, additionalProperties: false } }
    output: { schema: { type: object, additionalProperties: true } }
    errors: []
    auth: { mode: control, roles: [platform-operator] }
    tenancy: { mode: none }
    effects: { data: read, external: none }
    reliability: { idempotency: { mode: natural } }
    confirmation: { mode: none }
  whoami:
    id: control.whoami
    name: { en: Who am I, nl: Wie ben ik }
    description: { en: The signed-in operator., nl: De aangemelde beheerder. }
    implementation: { type: plugin, plugin: osf-control, handler: whoami }
    input: { schema: { type: object, additionalProperties: false } }
    output: { schema: { type: object, additionalProperties: true } }
    errors: []
    auth: { mode: control, roles: [platform-operator] }
    tenancy: { mode: none }
    effects: { data: read, external: none }
    reliability: { idempotency: { mode: natural } }
    confirmation: { mode: none }
  createTenant:
    id: control.create-tenant
    name: { en: Create tenant, nl: Tenant aanmaken }
    description: { en: Creates one tenant., nl: Maakt één tenant aan. }
    implementation: { type: plugin, plugin: osf-control, handler: createTenant }
    input:
      schema:
        type: object
        additionalProperties: false
        required: [slug]
        properties:
          slug: { type: string }
    output: { schema: { type: object, additionalProperties: true } }
    errors: []
    auth: { mode: control, roles: [platform-operator] }
    tenancy: { mode: none }
    effects: { data: write, external: write }
    reliability: { idempotency: { mode: natural } }
    confirmation: { mode: acknowledgement }
interfaces:
  rest:
    operations:
      listTenants: { method: GET, path: /api/control/v1/tenants, response: { status: 200, kind: json } }
      whoami: { method: GET, path: /api/control/v1/whoami, response: { status: 200, kind: json } }
      createTenant: { method: POST, path: /api/control/v1/tenants, response: { status: 201, kind: json } }
  mcp:
    operations:
      listTenants: { name: list_tenants }
      whoami: { name: whoami }
      createTenant: { name: create_tenant }
  web:
    pages:
      tenants: { title: { en: Tenants, nl: Tenants }, icon: buildings, order: 1 }
    operations:
      listTenants: { page: tenants, order: 0, landing: true }
      createTenant: { page: tenants, order: 1 }
      whoami: { page: tenants, order: 2 }
`;

describe("control-realm operation catalogs with web pages", () => {
  test("loads control auth, tenancy none and the page placement", () => {
    const [loaded] = loadOperationCatalogs(authoringRoot(controlCatalog));
    const document = loaded!.document;
    expect(document.operations.listTenants).toMatchObject({
      auth: { mode: "control", roles: ["platform-operator"] },
      tenancy: { mode: "none" },
    });
    expect(document.interfaces.web).toEqual({
      pages: { tenants: { title: { en: "Tenants", nl: "Tenants" }, icon: "buildings", order: 1 } },
      operations: {
        listTenants: { page: "tenants", order: 0, landing: true },
        createTenant: { page: "tenants", order: 1 },
        whoami: { page: "tenants", order: 2 },
      },
    });
    expect(moduleOperationId(document, "listTenants", document.operations.listTenants!))
      .toBe("control.list-tenants");
    expect(moduleOperationId({ plugin: "osf-control" }, "listTenants", {}))
      .toBe("osf-control.listTenants");
  });

  test("refuses control auth that still asks for a tenant", () => {
    expect(() => loadOperationCatalogs(authoringRoot(controlCatalog.replace(
      "auth: { mode: control, roles: [platform-operator] }\n    tenancy: { mode: none }",
      "auth: { mode: control, roles: [platform-operator] }\n    tenancy: { mode: required }",
    )))).toThrow(/control auth and so must declare tenancy mode none/);
  });

  test("refuses a placement that names no operation or no page", () => {
    expect(() => loadOperationCatalogs(authoringRoot(controlCatalog.replace(
      "createTenant: { page: tenants, order: 1 }",
      "deleteTenant: { page: tenants, order: 1 }",
    )))).toThrow(/places unknown operation "deleteTenant"/);
    expect(() => loadOperationCatalogs(authoringRoot(controlCatalog.replace(
      "createTenant: { page: tenants, order: 1 }",
      "createTenant: { page: billing, order: 1 }",
    )))).toThrow(/on unknown page "billing"/);
  });

  test("lets only one read-without-input operation land on a page", () => {
    expect(() => loadOperationCatalogs(authoringRoot(controlCatalog.replace(
      "createTenant: { page: tenants, order: 1 }",
      "createTenant: { page: tenants, order: 1, landing: true }",
    )))).toThrow(/landing operation "createTenant" must be a read operation without required input/);
    expect(() => loadOperationCatalogs(authoringRoot(controlCatalog.replace(
      "whoami: { page: tenants, order: 2 }",
      "whoami: { page: tenants, order: 2, landing: true }",
    )))).toThrow(/two landing operations \("listTenants" and "whoami"\)/);
  });

  test("refuses a page nobody places an operation on", () => {
    expect(() => loadOperationCatalogs(authoringRoot(controlCatalog.replace(
      "tenants: { title: { en: Tenants, nl: Tenants }, icon: buildings, order: 1 }",
      "tenants: { title: { en: Tenants, nl: Tenants }, icon: buildings, order: 1 }\n      billing: { title: { en: Billing, nl: Facturatie } }",
    )))).toThrow(/page "billing" has no operations/);
  });
});

describe("shipped control identity read contracts", () => {
  test("single-record reads reuse the same closed non-secret schemas as their list siblings", () => {
    const control = loadOperationCatalogs(
      join(import.meta.dir, "../../config/authoring"),
    ).find(({ document }) => document.plugin === "osf-control")!.document;

    for (const [listKey, collectionKey, getKey] of [
      ["listTenantMembers", "members", "getTenantMember"],
      ["listTenantInvitations", "invitations", "getTenantInvitation"],
      ["listTenantCredentials", "credentials", "getTenantCredential"],
    ] as const) {
      const listSchema = control.operations[listKey]!.output!.schema as {
        properties: Record<string, { items?: Record<string, unknown> }>;
      };
      const itemSchema = listSchema.properties[collectionKey]!.items!;
      expect(itemSchema.additionalProperties).toBe(false);
      expect(control.operations[getKey]!.output!.schema).toEqual(itemSchema);
    }
  });
});
