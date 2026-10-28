// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertRelatedWebEntitiesResolve, loadOperationCatalogs } from "./operation-catalog.js";
import { standaloneOperationFixture } from "./standalone-operation.fixtures.js";
import { buildWebManifest } from "./web-manifest.js";

const roots: string[] = [];

/** An authoring tree whose `operations/` holds one file per named catalog. */
function authoringRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "osf-related-web-entities-"));
  roots.push(root);
  mkdirSync(join(root, "operations"));
  for (const [name, yaml] of Object.entries(files)) {
    writeFileSync(join(root, "operations", `${name}.yaml`), yaml);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * The owning side: an API-key integration, provisioned by the plugin that owns
 * integrations, whose record links on to the assignments another plugin serves.
 */
const integrations = `
schemaVersion: 1
kind: operationCatalog
plugin: example-integrations
operations:
  listIntegrations:
    id: example-integrations.list
    name: { en: Integrations, nl: Integraties }
    description: { en: Every API-key integration., nl: Alle API-sleutelintegraties. }
    implementation: { type: plugin, plugin: example-integrations, handler: listIntegrations }
    input: { schema: { type: object, additionalProperties: false } }
    output:
      schema:
        type: object
        additionalProperties: false
        properties:
          integrations:
            type: array
            items: &integration
              type: object
              additionalProperties: false
              properties:
                integrationId: { type: string, x-osf-i18n: { title: { en: Integration, nl: Integratie } } }
                name: { type: string, x-osf-i18n: { title: { en: Name, nl: Naam } } }
    errors: []
    auth: { mode: session, roles: [Platform.ApiKeys.Manage] }
    tenancy: { mode: required }
    effects: { data: read, external: none }
    reliability: { idempotency: { mode: natural } }
    confirmation: { mode: none }
  getIntegration:
    id: example-integrations.get
    name: { en: Integration, nl: Integratie }
    description: { en: One API-key integration., nl: Eén API-sleutelintegratie. }
    implementation: { type: plugin, plugin: example-integrations, handler: getIntegration }
    input:
      schema:
        type: object
        additionalProperties: false
        required: [integrationId]
        properties:
          integrationId: { type: string }
    output: { schema: *integration }
    errors: []
    auth: { mode: session, roles: [Platform.ApiKeys.Manage] }
    tenancy: { mode: required }
    effects: { data: read, external: none }
    reliability: { idempotency: { mode: natural } }
    confirmation: { mode: none }
interfaces:
  rest:
    operations:
      listIntegrations: { method: GET, path: /api/example/integrations, response: { status: 200, kind: json } }
      getIntegration: { method: GET, path: /api/example/integrations/:integrationId, response: { status: 200, kind: json } }
  web:
    entities:
      ExampleIntegration:
        title: { en: Integrations, nl: Integraties }
        route: /example-integrations
        recordRoute: /example-integrations/:integrationId
        idField: integrationId
        displayField: name
        fields: [integrationId, name]
        columns: [name]
        operations:
          list: { operation: listIntegrations, resultField: integrations }
          get: { operation: getIntegration }
        related:
          - entity: ExampleAssignment
            label: { en: Record actions, nl: Recordacties }
            route: /example-integrations/:integrationId/record-actions
`;

/**
 * The destination: served by a different plugin, bound entirely by the owning
 * record's own route parameter.
 */
const assignments = `
schemaVersion: 1
kind: operationCatalog
plugin: example-record-actions
operations:
  listAssignments:
    id: example-record-actions.list
    name: { en: Record actions, nl: Recordacties }
    description: { en: What one integration may act on., nl: Waarop één integratie mag handelen. }
    implementation: { type: plugin, plugin: example-record-actions, handler: listAssignments }
    input:
      schema:
        type: object
        additionalProperties: false
        required: [integrationId]
        properties:
          integrationId: { type: string }
    output:
      schema:
        type: object
        additionalProperties: false
        properties:
          assignments:
            type: array
            items:
              type: object
              additionalProperties: false
              properties:
                id: { type: string, x-osf-i18n: { title: { en: Assignment, nl: Toekenning } } }
                action: { type: string, x-osf-i18n: { title: { en: Action, nl: Actie } } }
    errors: []
    auth: { mode: session, roles: [Platform.ApiKeys.Manage] }
    tenancy: { mode: required }
    effects: { data: read, external: none }
    reliability: { idempotency: { mode: natural } }
    confirmation: { mode: none }
interfaces:
  rest:
    operations:
      listAssignments: { method: GET, path: /api/example/record-actions, response: { status: 200, kind: json } }
  web:
    entities:
      ExampleAssignment:
        title: { en: Record actions, nl: Recordacties }
        route: /example-integrations/:integrationId/record-actions
        recordRoute: /example-integrations/:integrationId/record-actions/:id
        idField: id
        displayField: action
        fields: [id, action]
        columns: [action]
        operations:
          list:
            operation: listAssignments
            resultField: assignments
            bindings: { integrationId: integrationId }
`;

const crossOwner = { integrations, assignments };

/**
 * The authored realm of ONE read, as the two lines that declare it. Rewriting
 * them one read at a time is the only way to tell the record read apart from
 * the collection read: both are authored with the same pair.
 */
const SESSION_READ = "    auth: { mode: session, roles: [Platform.ApiKeys.Manage] }\n    tenancy: { mode: required }\n";
const CONTROL_READ = "    auth: { mode: control, roles: [platform-operator] }\n    tenancy: { mode: none }\n";
const PUBLIC_READ = "    auth: { mode: public }\n    tenancy: { mode: required }\n";
/** The schema does not require `auth`, so an omission is a shape the compiler meets. */
const UNDECLARED_READ = "    tenancy: { mode: required }\n";
const CAPABILITY_READ = "    auth: { mode: capability }\n    tenancy: { mode: required }\n";
const CUSTOM_READ =
  "    auth: { mode: custom, scheme: exampleKey, description: An example key., " +
  "securityScheme: { type: apiKey, in: header, name: X-Example-Key } }\n    tenancy: { mode: required }\n";

/**
 * The owning catalog with one of its two reads rewritten and the other left as
 * authored: `list` serves the collection, `get` serves the record the related
 * tab is shown on, and they are not interchangeable.
 */
function integrationsWith(read: "list" | "get", declaration: string): string {
  const at = integrations.indexOf(read === "get" ? "  getIntegration:" : "  listIntegrations:");
  return integrations.slice(0, at) + integrations.slice(at).replace(SESSION_READ, declaration);
}

/**
 * The same pair, with the destination parameterized by the tenant the owning
 * record merely *projects* — nothing in `/example-integrations/:integrationId`
 * carries it. The host substitutes a related route from the record as well as
 * from the route it is on, and a child collection reached by a foreign key the
 * parent only holds as a field is the ordinary shape of that.
 */
const byRecordField = {
  integrations: integrations
    .replace(
      "                name: { type: string,",
      "                tenantId: { type: string, x-osf-i18n: { title: { en: Tenant, nl: Tenant } } }\n" +
        "                name: { type: string,",
    )
    .replace("fields: [integrationId, name]", "fields: [integrationId, name, tenantId]")
    .replaceAll("/example-integrations/:integrationId/record-actions", "/example-tenants/:tenantId/record-actions"),
  assignments: assignments
    .replaceAll("/example-integrations/:integrationId/record-actions", "/example-tenants/:tenantId/record-actions")
    .replaceAll("integrationId", "tenantId"),
};

/**
 * Both sides of that same link in ONE catalog. The record-field binding is the
 * older, same-owner shape — it predates resolving links across catalogs — so it
 * has to keep compiling exactly as it did.
 */
const sameCatalogByRecordField = `
schemaVersion: 1
kind: operationCatalog
plugin: example-tenancy
operations:
  listIntegrations:
    id: example-tenancy.list
    name: { en: Integrations, nl: Integraties }
    description: { en: Every integration., nl: Alle integraties. }
    implementation: { type: plugin, plugin: example-tenancy, handler: listIntegrations }
    input: { schema: { type: object, additionalProperties: false } }
    output:
      schema:
        type: object
        additionalProperties: false
        properties:
          integrations:
            type: array
            items: &tenancyIntegration
              type: object
              additionalProperties: false
              properties:
                integrationId: { type: string, x-osf-i18n: { title: { en: Integration, nl: Integratie } } }
                tenantId: { type: string, x-osf-i18n: { title: { en: Tenant, nl: Tenant } } }
                name: { type: string, x-osf-i18n: { title: { en: Name, nl: Naam } } }
    errors: []
    auth: { mode: session, roles: [Platform.ApiKeys.Manage] }
    tenancy: { mode: required }
    effects: { data: read, external: none }
    reliability: { idempotency: { mode: natural } }
    confirmation: { mode: none }
  getIntegration:
    id: example-tenancy.get
    name: { en: Integration, nl: Integratie }
    description: { en: One integration., nl: Eén integratie. }
    implementation: { type: plugin, plugin: example-tenancy, handler: getIntegration }
    input:
      schema:
        type: object
        additionalProperties: false
        required: [integrationId]
        properties:
          integrationId: { type: string }
    output: { schema: *tenancyIntegration }
    errors: []
    auth: { mode: session, roles: [Platform.ApiKeys.Manage] }
    tenancy: { mode: required }
    effects: { data: read, external: none }
    reliability: { idempotency: { mode: natural } }
    confirmation: { mode: none }
  listTenantKeys:
    id: example-tenancy.list-keys
    name: { en: Keys, nl: Sleutels }
    description: { en: Every key one tenant holds., nl: Alle sleutels van één tenant. }
    implementation: { type: plugin, plugin: example-tenancy, handler: listTenantKeys }
    input:
      schema:
        type: object
        additionalProperties: false
        required: [tenantId]
        properties:
          tenantId: { type: string }
    output:
      schema:
        type: object
        additionalProperties: false
        properties:
          keys:
            type: array
            items:
              type: object
              additionalProperties: false
              properties:
                keyId: { type: string, x-osf-i18n: { title: { en: Key, nl: Sleutel } } }
                label: { type: string, x-osf-i18n: { title: { en: Label, nl: Label } } }
    errors: []
    auth: { mode: session, roles: [Platform.ApiKeys.Manage] }
    tenancy: { mode: required }
    effects: { data: read, external: none }
    reliability: { idempotency: { mode: natural } }
    confirmation: { mode: none }
interfaces:
  rest:
    operations:
      listIntegrations: { method: GET, path: /api/example/tenancy/integrations, response: { status: 200, kind: json } }
      getIntegration: { method: GET, path: /api/example/tenancy/integrations/:integrationId, response: { status: 200, kind: json } }
      listTenantKeys: { method: GET, path: /api/example/tenancy/keys, response: { status: 200, kind: json } }
  web:
    entities:
      TenancyIntegration:
        title: { en: Integrations, nl: Integraties }
        route: /tenancy-integrations
        recordRoute: /tenancy-integrations/:integrationId
        idField: integrationId
        displayField: name
        fields: [integrationId, tenantId, name]
        columns: [name]
        operations:
          list: { operation: listIntegrations, resultField: integrations }
          get: { operation: getIntegration }
        related:
          - entity: TenancyKey
            label: { en: Keys, nl: Sleutels }
            route: /tenancy-tenants/:tenantId/keys
      TenancyKey:
        title: { en: Keys, nl: Sleutels }
        route: /tenancy-tenants/:tenantId/keys
        idField: keyId
        displayField: label
        fields: [keyId, label]
        columns: [label]
        operations:
          list:
            operation: listTenantKeys
            resultField: keys
            bindings: { tenantId: tenantId }
`;

describe("related web entities across catalog owners", () => {
  test("resolves a related destination another plugin's catalog declares", () => {
    const loaded = loadOperationCatalogs(authoringRoot(crossOwner));
    expect(loaded.map(({ document }) => document.plugin)).toEqual([
      "example-record-actions",
      "example-integrations",
    ]);
    expect(loaded.find(({ document }) => document.plugin === "example-integrations")!
      .document.interfaces.web!.entities!.ExampleIntegration!.related)
      .toEqual([{
        entity: "ExampleAssignment",
        label: { en: "Record actions", nl: "Recordacties" },
        route: "/example-integrations/:integrationId/record-actions",
      }]);
  });

  test("projects the composed route and leaves the destination's own authorization with it", () => {
    const manifest = buildWebManifest([], {}, standaloneOperationFixture(authoringRoot(crossOwner)));
    expect(manifest.entities.ExampleIntegration!.operationSource!.related).toEqual([{
      entityId: "ExampleAssignment",
      label: { en: "Record actions", nl: "Recordacties" },
      route: "/example-integrations/:integrationId/record-actions",
    }]);
    // The link names a destination the manifest really serves, at that route.
    const destination = manifest.entities.ExampleAssignment!;
    expect(destination.views.collection.route).toBe("/example-integrations/:integrationId/record-actions");
    // Nothing of the destination travels with the link: its read stays its own
    // Operation, under its own plugin and roles, and the owning entity gains
    // no operation it did not author.
    expect(Object.keys(manifest.entities.ExampleIntegration!.operations).sort())
      .toEqual(["getIntegration", "listIntegrations"]);
    expect(destination.operations.listAssignments).toMatchObject({
      id: "example-record-actions.list",
      auth: { mode: "session", roles: ["Platform.ApiKeys.Manage"] },
    });
  });

  test("refuses a destination no catalog declares", () => {
    expect(() => loadOperationCatalogs(authoringRoot({
      ...crossOwner,
      integrations: integrations.replace("entity: ExampleAssignment", "entity: MissingAssignment"),
    }))).toThrow(/entity "ExampleIntegration" relates to unknown entity "MissingAssignment"/);
    // Dropping the destination's catalog is the same mistake from the other side.
    expect(() => loadOperationCatalogs(authoringRoot({ integrations })))
      .toThrow(/relates to unknown entity "ExampleAssignment"/);
  });

  test("refuses an ambiguous destination two catalogs both declare", () => {
    expect(() => loadOperationCatalogs(authoringRoot({
      ...crossOwner,
      duplicate: assignments
        .replace("plugin: example-record-actions", "plugin: example-other")
        .replaceAll("plugin: example-record-actions, handler", "plugin: example-other, handler")
        .replaceAll("id: example-record-actions.list", "id: example-other.list")
        .replace("/api/example/record-actions", "/api/example/other-record-actions"),
    }))).toThrow(/Operation-backed web entity "ExampleAssignment" is declared by both .*; entity names are global/);
  });

  test("refuses a link to a route the destination is not served at", () => {
    expect(() => loadOperationCatalogs(authoringRoot({
      ...crossOwner,
      integrations: integrations.replace(
        "route: /example-integrations/:integrationId/record-actions\n",
        "route: /example-integrations/:integrationId/assignments\n",
      ),
    }))).toThrow(/is served at "\/example-integrations\/:integrationId\/record-actions"/);
  });

  test("refuses a destination route the owning record cannot bind", () => {
    expect(() => loadOperationCatalogs(authoringRoot({
      ...crossOwner,
      assignments: assignments.replaceAll(":integrationId/record-actions", ":tenantSlug/:integrationId/record-actions"),
      integrations: integrations.replace(
        "route: /example-integrations/:integrationId/record-actions\n",
        "route: /example-integrations/:tenantSlug/:integrationId/record-actions\n",
      ),
    }))).toThrow(
      /parameter\(s\) ":tenantSlug" are bound by neither the record route "\/example-integrations\/:integrationId" the link is shown on nor a field "ExampleIntegration" projects/,
    );
  });

  test("refuses a link that would cross authentication realms", () => {
    expect(() => loadOperationCatalogs(authoringRoot({
      ...crossOwner,
      assignments: assignments.replace(SESSION_READ, CONTROL_READ),
    }))).toThrow(
      /is read as a record with session auth and relates to "ExampleAssignment".*whose collection is listed with control auth/s,
    );
  });

  test("keeps the destination's Operations with their own catalog", () => {
    // The composed route is the only thing that crosses: borrowing the
    // destination's Operation to place it here is still an ownership error.
    expect(() => loadOperationCatalogs(authoringRoot({
      ...crossOwner,
      integrations: integrations.replace(
        "          get: { operation: getIntegration }",
        "          get: { operation: getIntegration }\n          recordActions: [listAssignments]",
      ),
    }))).toThrow(/entity "ExampleIntegration" references unknown operation "listAssignments"/);
  });

  test("revalidates the link when only the destination's catalog changed", () => {
    const first = authoringRoot(crossOwner);
    expect(loadOperationCatalogs(first)).toHaveLength(2);
    // The owning catalog's bytes are untouched, so it comes from the per-file
    // cache; the link must still fail on the edit next door.
    writeFileSync(
      join(first, "operations", "assignments.yaml"),
      assignments.replace("ExampleAssignment:", "RenamedAssignment:"),
    );
    expect(() => loadOperationCatalogs(first)).toThrow(/relates to unknown entity "ExampleAssignment"/);
  });
});

describe("related destinations parameterized by the owning record's fields", () => {
  test("binds a same-catalog destination from a field the record projects", () => {
    const loaded = loadOperationCatalogs(authoringRoot({ tenancy: sameCatalogByRecordField }));
    expect(loaded).toHaveLength(1);
    const manifest = buildWebManifest([], {}, standaloneOperationFixture(authoringRoot({ tenancy: sameCatalogByRecordField })));
    expect(manifest.entities.TenancyIntegration!.operationSource!.related).toEqual([{
      entityId: "TenancyKey",
      label: { en: "Keys", nl: "Sleutels" },
      route: "/tenancy-tenants/:tenantId/keys",
    }]);
    // `:tenantId` is nowhere in `/tenancy-integrations/:integrationId`; the
    // record supplies it, and the destination still reads under its own list
    // Operation and binding.
    expect(manifest.entities.TenancyKey!.views.collection.route).toBe("/tenancy-tenants/:tenantId/keys");
    expect(manifest.entities.TenancyKey!.operationSource!.collection.bindings).toEqual({ tenantId: "tenantId" });
  });

  test("binds a cross-catalog destination from a field the record projects", () => {
    expect(loadOperationCatalogs(authoringRoot(byRecordField))).toHaveLength(2);
    const manifest = buildWebManifest([], {}, standaloneOperationFixture(authoringRoot(byRecordField)));
    expect(manifest.entities.ExampleIntegration!.operationSource!.related).toEqual([{
      entityId: "ExampleAssignment",
      label: { en: "Record actions", nl: "Recordacties" },
      route: "/example-tenants/:tenantId/record-actions",
    }]);
    expect(manifest.entities.ExampleAssignment!.views.collection.route).toBe("/example-tenants/:tenantId/record-actions");
  });

  test("refuses an identifier the owning record neither routes nor projects", () => {
    // `tenantId` stays in the read Operation's result schema and leaves the
    // entity's `fields`: the destination's route still asks for it, and the
    // record page no longer shows a value to answer with. Only what the entity
    // projects counts, so the whole result schema is not a back door.
    expect(() => loadOperationCatalogs(authoringRoot({
      ...byRecordField,
      integrations: byRecordField.integrations.replace("fields: [integrationId, name, tenantId]", "fields: [integrationId, name]"),
    }))).toThrow(
      /parameter\(s\) ":tenantId" are bound by neither the record route "\/example-integrations\/:integrationId" the link is shown on nor a field "ExampleIntegration" projects/,
    );
  });

  test("does not bind from a field only the destination projects", () => {
    // `action` is the DESTINATION's field. Nothing on the record the link is
    // shown on holds it, so it cannot fill the composed route.
    expect(() => loadOperationCatalogs(authoringRoot({
      integrations: integrations.replaceAll(
        "/example-integrations/:integrationId/record-actions",
        "/example-actions/:action/record-actions",
      ),
      assignments: assignments
        .replaceAll("/example-integrations/:integrationId/record-actions", "/example-actions/:action/record-actions")
        .replace("bindings: { integrationId: integrationId }", "bindings: { action: integrationId }"),
    }))).toThrow(/parameter\(s\) ":action" are bound by neither/);
  });

  test("accepts a parameter the route and the record both carry", () => {
    // `{...route.params, ...record}` — the record wins the collision, and both
    // sides name the owning integration, so the composed route is the same
    // either way.
    const collided = {
      integrations: integrations.replaceAll(
        "/example-integrations/:integrationId/record-actions",
        "/example-tenants/:integrationId/record-actions",
      ),
      assignments: assignments.replaceAll(
        "/example-integrations/:integrationId/record-actions",
        "/example-tenants/:integrationId/record-actions",
      ),
    };
    const manifest = buildWebManifest([], {}, standaloneOperationFixture(authoringRoot(collided)));
    expect(manifest.entities.ExampleIntegration!.operationSource!.related).toEqual([{
      entityId: "ExampleAssignment",
      label: { en: "Record actions", nl: "Recordacties" },
      route: "/example-tenants/:integrationId/record-actions",
    }]);
  });
});

/**
 * A related link joins the read it is shown ON to the read it opens: the
 * source's record read and the destination's collection read. An entity's two
 * reads are separate Operations and may declare separate realms, so neither
 * side may be answered with the other's.
 */
describe("the authentication realms a related link actually joins", () => {
  test("takes the owning side's realm from the record read, not its collection read", () => {
    // Both reads of the owning entity are authored; only the record read moves
    // to the control realm. Comparing the two collections would find session
    // against session and let this through, and the tab is not on a collection.
    expect(() => loadOperationCatalogs(authoringRoot({
      ...crossOwner,
      integrations: integrationsWith("get", CONTROL_READ),
    }))).toThrow(
      /entity "ExampleIntegration" is read as a record with control auth and relates to "ExampleAssignment".*whose collection is listed with session auth/s,
    );
  });

  test("resolves a link whose record read matches even where the owning collection does not", () => {
    // The mirror image, and a case the collection-against-collection check
    // refused for a realm the tab never loads in: the record page the tab is
    // shown on is read with a session, and so is the collection it opens. The
    // owning entity's own collection is a control-realm listing, which the
    // operator reaches on its own page and is no part of this link.
    const recordRealmMatches = { ...crossOwner, integrations: integrationsWith("list", CONTROL_READ) };
    expect(loadOperationCatalogs(authoringRoot(recordRealmMatches))).toHaveLength(2);
    const manifest = buildWebManifest([], {}, standaloneOperationFixture(authoringRoot(recordRealmMatches)));
    expect(manifest.entities.ExampleIntegration!.operationSource!.related).toEqual([{
      entityId: "ExampleAssignment",
      label: { en: "Record actions", nl: "Recordacties" },
      route: "/example-integrations/:integrationId/record-actions",
    }]);
  });

  test("refuses a link whose owning entity has no record read at all", () => {
    // Nothing is shown on a record page the entity does not declare, whatever
    // realm the collection beside it is listed in.
    expect(() => loadOperationCatalogs(authoringRoot({
      ...crossOwner,
      integrations: integrations.replace("          get: { operation: getIntegration }\n", ""),
    }))).toThrow(
      /entity "ExampleIntegration" relates to "ExampleAssignment" but declares no get Operation; a related link is a tab on the record page/,
    );
  });

  test("the authoring schema already requires an auth mode on either read", () => {
    // Not a realm the check has to guess at: `auth` is required of every
    // module Operation, so neither end of a link can reach it unstated. The
    // authoring type carries `auth` as optional only because it is shared with
    // entity CRUD, where declaring one is forbidden.
    expect(() => loadOperationCatalogs(authoringRoot({
      ...crossOwner,
      integrations: integrationsWith("get", UNDECLARED_READ),
    }))).toThrow(/\/operations\/getIntegration: must have required property 'auth'/);
    expect(() => loadOperationCatalogs(authoringRoot({
      ...crossOwner,
      assignments: assignments.replace(SESSION_READ, UNDECLARED_READ),
    }))).toThrow(/\/operations\/listAssignments: must have required property 'auth'/);
  });

  test("does not read two undeclared realms as one shared realm", () => {
    // The check is exported and called with catalogs whose type permits an
    // absent `auth`, so it states the realm requirement itself rather than
    // inheriting the schema's. Two omissions are two unstated realms, and the
    // owning side is named first because that is the read the tab is shown on.
    const loaded = loadOperationCatalogs(authoringRoot(crossOwner));
    for (const { document } of loaded) {
      for (const operation of Object.values(document.operations)) delete operation.auth;
    }
    expect(() => assertRelatedWebEntitiesResolve(
      loaded.map(({ path, document }) => ({ origin: path, document })),
    )).toThrow(
      /entity "ExampleIntegration" is read as a record by Operation "getIntegration", which declares no auth mode/,
    );
  });

  test("refuses a realm a browser cannot carry on either end", () => {
    // `standaloneAuth` refuses to project both of these to a page further
    // down; a link between two of them has no shared realm to establish here.
    expect(() => loadOperationCatalogs(authoringRoot({
      ...crossOwner,
      assignments: assignments.replace(SESSION_READ, CAPABILITY_READ),
    }))).toThrow(
      /entity "ExampleAssignment" is listed by Operation "listAssignments", which is read with capability auth; a browser carries a tenant session, a control-realm bearer or nothing/,
    );
    expect(() => loadOperationCatalogs(authoringRoot({
      ...crossOwner,
      integrations: integrationsWith("get", CUSTOM_READ),
    }))).toThrow(
      /entity "ExampleIntegration" is read as a record by Operation "getIntegration", which is read with custom auth/,
    );
  });

  test("admits a public record page linking on to a public collection", () => {
    // Two reads that need no caller are one realm — none — so the declared
    // modes match and nothing further is assumed about either side.
    expect(loadOperationCatalogs(authoringRoot({
      integrations: integrations.replaceAll(SESSION_READ, PUBLIC_READ),
      assignments: assignments.replace(SESSION_READ, PUBLIC_READ),
    }))).toHaveLength(2);
  });
});

describe("shipped same-catalog related links", () => {
  test("the base catalogs still resolve every related link they author", () => {
    const catalogs = loadOperationCatalogs(join(import.meta.dir, "../../config/authoring"))
      .map(({ document }) => document);
    const authored = catalogs.flatMap((catalog) =>
      Object.entries(catalog.interfaces.web?.entities ?? {}).flatMap(([name, entity]) =>
        (entity.related ?? []).map((related) => `${catalog.plugin}:${name}->${related.entity}`)));
    expect(authored).toEqual([
      "accounts:AccessMember->AccessMemberAudit",
      "osf-api-keys:ApiKeyIntegration->ApiKeyCredential",
      "osf-control:PlatformTenant->TenantMember",
      "osf-control:PlatformTenant->TenantInvitation",
      "osf-control:TenantMember->TenantCredential",
    ]);
  });
});
