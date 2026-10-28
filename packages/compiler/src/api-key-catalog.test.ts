// SPDX-License-Identifier: BUSL-1.1
/**
 * The shipped integration/API-key catalog, as the compiler actually reads it.
 *
 * Two claims are load-bearing and neither is visible by reading the YAML:
 *
 *   1. The paginated collection contract either matches what the web manifest
 *      validates — all four of `first`, `after`, `sortField`, `sortDirection`,
 *      bounded `first`, entity fields in `sortField.enum`, `nextCursor` and
 *      `totalCount` on the way out — or the projection throws. A partial
 *      contract is not a degraded list; it is a build failure.
 *   2. The one-time secrets in the two write results retain their FieldSecret
 *      annotation in the web projection. The shared result view must mask
 *      those outputs before these placements are integrated into a host.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadOperationCatalogs } from "./authoring/operation-catalog.js";
import { buildWebManifest } from "./authoring/web-manifest.js";
import { collectAuthoredModulePluginOperations } from "./generate-operations.js";
import { withRecordActionGrants } from "./record-action-grants.js";
import type { OperationCatalogDefinition } from "./authoring/types.js";

const authoringDir = join(import.meta.dir, "../config/authoring");
const context = { repoRoot: join(import.meta.dir, "../../.."), authoringDir, webPresent: true };

const apiKeyCatalog = (): OperationCatalogDefinition =>
  loadOperationCatalogs(authoringDir).find(({ document }) => document.plugin === "osf-api-keys")!.document;

const compiled = (catalog: OperationCatalogDefinition) =>
  collectAuthoredModulePluginOperations([catalog], context);

const manifest = (catalog: OperationCatalogDefinition) => {
  const assignments = loadOperationCatalogs(authoringDir)
    .find(({ document }) => document.plugin === "osf-record-actions")!.document;
  const catalogs = withRecordActionGrants([catalog, assignments], []);
  return buildWebManifest([], {}, { catalogs, operations: collectAuthoredModulePluginOperations(catalogs, context) });
};

/** Every property name anywhere in a JSON schema, `$defs` and items included. */
function propertyNames(schema: unknown, found: Set<string> = new Set()): Set<string> {
  if (!schema || typeof schema !== "object") return found;
  if (Array.isArray(schema)) {
    for (const item of schema) propertyNames(item, found);
    return found;
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      for (const name of Object.keys(value)) found.add(name);
    }
    propertyNames(value, found);
  }
  return found;
}

const SECRET_NAMES = ["secret", "token", "clientSecret", "secretHash", "lookupId", "password"];

/**
 * Every `x-osf-presentation` component named anywhere in a JSON value, with
 * the path it sits on.
 *
 * The path is the point: a manifest carries the same operation ref under
 * several keys (the operation map, the entity, each view that offers it), so
 * counting occurrences says nothing. What matters is that every one of them is
 * the credential's own secret property and none is a field of a metadata view.
 */
function presentationMarkers(
  value: unknown,
  path: string[] = [],
  found: { path: string; component: string }[] = [],
): { path: string; component: string }[] {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) presentationMarkers(item, [...path, String(index)], found);
    return found;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === "x-osf-presentation" && nested && typeof nested === "object") {
      const component = (nested as { component?: unknown }).component;
      if (typeof component === "string") found.push({ path: path.join("/"), component });
    }
    presentationMarkers(nested, [...path, key], found);
  }
  return found;
}

function presentationComponents(value: unknown): string[] {
  return presentationMarkers(value).map((marker) => marker.component);
}

/** The two Operations that hand over a live credential. */
const MINTING = ["api-keys.create-integration", "api-keys.issue-credential"];

describe("shipped integration and API-key catalog", () => {
  test("projects role lists as collections of text, including nullable credential subsets", () => {
    const entities = manifest(apiKeyCatalog()).entities;
    expect(entities.ApiKeyIntegration!.fields.grantedRoles).toMatchObject({
      osfType: "string", baseType: "string", cardinality: "many",
    });
    expect(entities.ApiKeyCredential!.fields.roleSubset).toMatchObject({
      osfType: "string", baseType: "string", cardinality: "many",
    });
  });

  test("does not guess a text collection for open, object, or enumerated array items", () => {
    for (const items of [
      {}, { type: "object", properties: { name: { type: "string" } } },
      { type: "string", enum: ["admin", "reader"] }, { type: ["string", "null"] },
      { type: "string", format: "date" }, { type: "string", const: "admin" },
      { type: "string", oneOf: [{ const: "admin" }, { const: "reader" }] },
      { type: "string", anyOf: [{ const: "admin" }, { const: "reader" }] },
      { type: "string", allOf: [{ minLength: 1 }] }, { type: "string", not: { const: "admin" } },
      { type: "string", $ref: "#/$defs/role" },
    ]) {
      const catalog = structuredClone(apiKeyCatalog());
      const schema = catalog.operations.listIntegrations!.output!.schema as any;
      schema.properties.integrations.items.properties.grantedRoles.items = items;
      if ("$ref" in items) {
        // The integration schema is a YAML anchor reused by several outputs.
        for (const operation of Object.values(catalog.operations)) {
          if (operation.output?.schema) (operation.output.schema as any).$defs = { role: { type: "string" } };
        }
      }
      expect(manifest(catalog).entities.ApiKeyIntegration!.fields.grantedRoles).toMatchObject({
        osfType: "array", baseType: "array", cardinality: "one",
      });
    }
  });

  test("preserves existing projection for enum or presentation on the array itself", () => {
    for (const extra of [
      { "x-osf-i18n": { title: { en: "Roles", nl: "Rollen" }, enum: { admin: { en: "Admin", nl: "Beheerder" } } } },
      { "x-osf-presentation": { component: "FieldMultipleChoice" } },
      { "x-osf-exact": { enum: ["admin"] } },
    ]) {
      const catalog = structuredClone(apiKeyCatalog());
      const schema = catalog.operations.listIntegrations!.output!.schema as any;
      Object.assign(schema.properties.integrations.items.properties.grantedRoles, extra);
      expect(manifest(catalog).entities.ApiKeyIntegration!.fields.grantedRoles).toMatchObject({
        osfType: "array", baseType: "array", cardinality: "one",
      });
    }
  });
  test("binds every Operation to the one provisioning service under the management role", () => {
    const operations = compiled(apiKeyCatalog());
    expect(operations.map(({ key }) => key).sort()).toEqual([
      "api-keys.create-integration",
      "api-keys.disable-integration",
      "api-keys.get-credential",
      "api-keys.get-integration",
      "api-keys.issue-credential",
      "api-keys.list-credentials",
      "api-keys.list-integrations",
      "api-keys.revoke-credential",
    ]);
    for (const operation of operations) {
      expect(operation.plugin).toBe("osf-api-keys");
      // The ceiling's own role, so a transport cannot admit a caller the
      // service would then refuse — or, worse, the reverse.
      expect(operation.auth).toEqual({ mode: "session", roles: ["Platform.ApiKeys.Manage"] });
      expect(operation.tenancy).toEqual({ mode: "required" });
      // Every refusal the handlers can return is declared, the unconfigured
      // deployment included: an undeclared status is a contract violation at
      // runtime, not a 503. Only the Operation that mutates the realm may
      // report the identity provider refusing.
      expect(operation.errors.map(({ status, code }) => `${status} ${code}`)).toEqual(
        operation.key === "api-keys.create-integration"
          ? [
            "400 VALIDATION",
            "401 UNAUTHENTICATED",
            "403 FORBIDDEN",
            "404 NOT_FOUND",
            "502 PROVISIONING_FAILED",
            "503 NOT_CONFIGURED",
          ]
          : [
            "400 VALIDATION",
            "401 UNAUTHENTICATED",
            "403 FORBIDDEN",
            "404 NOT_FOUND",
            "503 NOT_CONFIGURED",
          ],
      );
      // Creating an integration is the only path that reaches outward.
      expect(operation.effects.external).toBe(
        operation.key === "api-keys.create-integration" ? "write" : "none",
      );
      // Not an MCP tool and not a GraphQL field: the existing GraphQL surface
      // already serves this feature, and an LLM transport has no business
      // being offered an Operation whose sibling returns a live credential.
      expect(operation.transports.mcp.enabled).toBe(false);
      expect(operation.transports.graphql.enabled).toBe(false);
      expect(operation.transports.rest.path.startsWith("/api/api-key-integrations/")).toBe(true);
    }
  });

  test("names a credential only in the two minting contracts, never in a read", () => {
    for (const operation of compiled(apiKeyCatalog())) {
      const names = propertyNames(operation.outputSchema);
      const leaked = SECRET_NAMES.filter((name) => names.has(name));
      expect({ key: operation.key, leaked })
        .toEqual({ key: operation.key, leaked: MINTING.includes(operation.key) ? ["secret"] : [] });
      // A read contract declares no input lifetime either: nothing about a
      // credential's life is settable on a path that only reports metadata.
      const input = propertyNames(operation.inputSchema);
      expect(input.has("expiresInDays")).toBe(MINTING.includes(operation.key));
    }
  });

  test("declares each minted secret confidential with the shared FieldSecret marker", () => {
    const operations = compiled(apiKeyCatalog());
    for (const key of MINTING) {
      const operation = operations.find((candidate) => candidate.key === key)!;
      const credential = (operation.outputSchema.properties as Record<string, {
        description?: string;
        properties?: Record<string, Record<string, unknown>>;
      }>).credential!;
      const secret = credential.properties!.secret!;
      // The marker the shared web implementation is adding support for. It is
      // an EXISTING schema annotation, carried verbatim by the compiler — no
      // new authoring key, so nothing here depends on unsupported YAML.
      expect(secret["x-osf-presentation"]).toEqual({ component: "FieldSecret" });
      expect(secret.description).toContain("exactly once");
      expect(credential.description).toContain("CONFIDENTIAL");
      expect(operation.effects.data).toBe("write");
      // `natural` idempotency would invite a transport to replay a mint, and a
      // keyed one would store the result — including the secret — in a
      // receipt. Neither is acceptable for a credential.
      expect(operation.idempotency.mode).toBe("none");
      // The lifetime ceiling, pinned here so the schema and the handler
      // constant cannot drift apart silently.
      expect((operation.inputSchema.properties as Record<string, Record<string, unknown>>)
        .expiresInDays).toMatchObject({ type: "integer", minimum: 1, maximum: 366 });
    }
  });

  test("marks the secret nowhere else, and never on a read contract", () => {
    for (const operation of compiled(apiKeyCatalog())) {
      const components = presentationComponents(operation.outputSchema);
      expect({ key: operation.key, components })
        .toEqual({ key: operation.key, components: MINTING.includes(operation.key) ? ["FieldSecret"] : [] });
    }
  });

  test("projects both collections with the pagination contract the web manifest validates", () => {
    const entities = manifest(apiKeyCatalog()).entities;
    expect(entities.ApiKeyIntegration!.operationSource).toMatchObject({
      idField: "integrationId",
      collection: {
        resultField: "integrations",
        query: {
          input: {
            kind: "collection-query",
            filterFields: ["displayName", "status"],
            sortFields: ["displayName", "status", "createdAt", "updatedAt"],
            pagination: { kind: "cursor", defaultLimit: 25, maxLimit: 100 },
          },
          nextCursorField: "nextCursor",
          totalCountField: "totalCount",
        },
      },
      record: { bindings: { integrationId: "integrationId" } },
      related: [
        { entityId: "ApiKeyCredential", route: "/api-key-integrations/:integrationId/credentials" },
        { entityId: "RecordActionAssignment", route: "/integrations/:integrationId/record-actions" },
      ],
    });
    // The nested collection is bound to its integration, and that binding is
    // NOT offered as a filter: it is the subject of the view, not a control.
    expect(entities.ApiKeyCredential!.operationSource).toMatchObject({
      idField: "id",
      collection: {
        resultField: "credentials",
        bindings: { integrationId: "integrationId" },
        query: {
          input: {
            filterFields: ["displayName", "status"],
            sortFields: ["displayName", "status", "createdAt", "expiresAt", "lastUsedAt"],
            pagination: { kind: "cursor", defaultLimit: 25, maxLimit: 100 },
          },
        },
      },
      record: { bindings: { id: "id", integrationId: "integrationId" } },
    });
    expect(entities.ApiKeyCredential!.views.collection.route)
      .toBe("/api-key-integrations/:integrationId/credentials");
    expect(entities.ApiKeyIntegration!.views.collection.defaultSort)
      .toEqual({ key: "displayName", direction: "asc" });
    expect(entities.ApiKeyCredential!.views.collection.defaultSort)
      .toEqual({ key: "createdAt", direction: "desc" });
  });

  test("places creation and credential issuance on the integration view", () => {
    const web = apiKeyCatalog().interfaces.web!;
    // No standalone pages at all: the catalog is projected as entities only.
    expect(web.pages).toBeUndefined();
    expect(web.operations).toBeUndefined();
    const placed = Object.values(web.entities ?? {}).flatMap((entity) => [
      entity.operations.list.operation,
      ...(entity.operations.get ? [entity.operations.get.operation] : []),
      ...(entity.operations.create ? [entity.operations.create.operation] : []),
      ...(entity.operations.collectionActions ?? []),
      ...(entity.operations.recordActions ?? []).map((action) =>
        typeof action === "string" ? action : action.operation
      ),
    ]);
    expect(placed.sort()).toEqual([
      "createIntegration",
      "disableIntegration",
      "getCredential",
      "getIntegration",
      "issueCredential",
      "listCredentials",
      "listIntegrations",
      "revokeCredential",
    ]);
    expect(web.entities!.ApiKeyIntegration!.operations.create).toEqual({ operation: "createIntegration" });
    expect(web.entities!.ApiKeyCredential!.operations.create).toBeUndefined();
    const entities = manifest(apiKeyCatalog()).entities;
    const actions = entities.ApiKeyIntegration!.views.record!.operations.actions!;
    expect(actions.map((action) => action.id)).toEqual(["api-keys.issue-credential", "api-keys.disable-integration"]);
    // The record action is bound to the record it was opened on, by the
    // entity's own id field — the integration's stable database id.
    expect(actions[0]!.target).toEqual({
      entityId: "ApiKeyIntegration",
      entityName: "ApiKeyIntegration",
      scope: "record",
      inputField: "integrationId",
    });
  });

  /**
   * The compiler must carry the confidential marker to both write outputs.
   * The generic web result view must also mask it before this is integrated.
   */
  test("carries the secret marker into the placed operations", () => {
    const projected = manifest(apiKeyCatalog());
    for (const key of MINTING) {
      const ref = projected.operations![key]!;
      const credential = (ref.output.schema as {
        properties: Record<string, { properties?: Record<string, Record<string, unknown>> }>;
      }).properties.credential!;
      expect(credential.properties!.secret!["x-osf-presentation"])
        .toEqual({ component: "FieldSecret" });
    }
    // Still only on the secret, even once the Operations are in the manifest:
    // the ref is carried under several keys, and EVERY marker sits on the
    // credential's own secret property rather than on any metadata node.
    const markers = presentationMarkers(projected).filter(({ component }) => component === "FieldSecret");
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect(marker.path.endsWith("output/schema/properties/credential/properties/secret")).toBe(true);
    }
    // And the metadata views are unchanged by the placement: the collection
    // and record field sets never gain a confidential property.
    expect(presentationComponents(projected.entities.ApiKeyIntegration!.fields))
      .not.toContain("FieldSecret");
    expect(presentationComponents(projected.entities.ApiKeyCredential!.fields))
      .not.toContain("FieldSecret");
  });

  test("refuses an incomplete collection query rather than degrading the list", () => {
    const catalog = structuredClone(apiKeyCatalog());
    const input = catalog.operations.listIntegrations!.input!.schema as {
      properties: Record<string, unknown>;
    };
    delete input.properties.after;
    expect(() => manifest(catalog)).toThrow(/incomplete collection query; missing after/);

    const withoutCursor = structuredClone(apiKeyCatalog());
    const output = withoutCursor.operations.listIntegrations!.output!.schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    delete output.properties.nextCursor;
    output.required = output.required.filter((name) => name !== "nextCursor");
    expect(() => manifest(withoutCursor)).toThrow(/must return nextCursor and totalCount/);
  });
});
