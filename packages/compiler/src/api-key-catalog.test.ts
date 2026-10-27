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
 *   2. The one-time secret is returned by `issueCredential` and reaches NO web
 *      projection. The generic entity renderer shows whatever its Operation
 *      returns, so a web placement here would print a live credential into the
 *      collection or record view. This test is what keeps that absence
 *      deliberate rather than an oversight somebody "fixes" later.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadOperationCatalogs } from "./authoring/operation-catalog.js";
import { buildWebManifest } from "./authoring/web-manifest.js";
import { collectAuthoredModulePluginOperations } from "./generate-operations.js";
import type { OperationCatalogDefinition } from "./authoring/types.js";

const authoringDir = join(import.meta.dir, "../config/authoring");
const context = { repoRoot: join(import.meta.dir, "../../.."), authoringDir, webPresent: true };

const apiKeyCatalog = (): OperationCatalogDefinition =>
  loadOperationCatalogs(authoringDir).find(({ document }) => document.plugin === "osf-api-keys")!.document;

const compiled = (catalog: OperationCatalogDefinition) =>
  collectAuthoredModulePluginOperations([catalog], context);

const manifest = (catalog: OperationCatalogDefinition) =>
  buildWebManifest([], {}, { catalogs: [catalog], operations: compiled(catalog) });

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

describe("shipped integration and API-key catalog", () => {
  test("binds every Operation to the one provisioning service under the management role", () => {
    const operations = compiled(apiKeyCatalog());
    expect(operations.map(({ key }) => key).sort()).toEqual([
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
      expect(operation.effects.external).toBe("none");
      // Every refusal the handlers can return is declared, the unconfigured
      // deployment included: an undeclared status is a contract violation at
      // runtime, not a 503.
      expect(operation.errors.map(({ status, code }) => `${status} ${code}`)).toEqual([
        "400 VALIDATION",
        "401 UNAUTHENTICATED",
        "403 FORBIDDEN",
        "404 NOT_FOUND",
        "503 NOT_CONFIGURED",
      ]);
      // Not an MCP tool and not a GraphQL field: the existing GraphQL surface
      // already serves this feature, and an LLM transport has no business
      // being offered an Operation whose sibling returns a live credential.
      expect(operation.transports.mcp.enabled).toBe(false);
      expect(operation.transports.graphql.enabled).toBe(false);
      expect(operation.transports.rest.path.startsWith("/api/api-key-integrations/")).toBe(true);
    }
  });

  test("never names a credential in a read contract, and names it once in the issue contract", () => {
    const operations = compiled(apiKeyCatalog());
    for (const operation of operations) {
      const names = propertyNames(operation.outputSchema);
      const leaked = SECRET_NAMES.filter((name) => names.has(name));
      expect(leaked).toEqual(operation.key === "api-keys.issue-credential" ? ["secret"] : []);
    }
    const issue = operations.find(({ key }) => key === "api-keys.issue-credential")!;
    expect(issue.effects.data).toBe("write");
    // `natural` idempotency would invite a transport to replay a mint.
    expect(issue.idempotency.mode).toBe("none");
    expect((issue.outputSchema.properties as Record<string, { description?: string }>).secret?.description)
      .toContain("exactly once");
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
      related: [{ entityId: "ApiKeyCredential", route: "/api-key-integrations/:integrationId/credentials" }],
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

  test("offers only revoke and disable in the generic views, and never the mint", () => {
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
      "disableIntegration",
      "getCredential",
      "getIntegration",
      "listCredentials",
      "listIntegrations",
      "revokeCredential",
    ]);
    expect(placed).not.toContain("issueCredential");
    // Neither entity offers a create: the only way to bring a credential into
    // existence returns it, so no generic form may own that step.
    for (const entity of Object.values(web.entities ?? {})) {
      expect(entity.operations.create).toBeUndefined();
    }
    const entities = manifest(apiKeyCatalog()).entities;
    for (const entity of Object.values(entities)) {
      const ids = JSON.stringify(entity.views);
      expect(ids).not.toContain("api-keys.issue-credential");
    }
    const actions = entities.ApiKeyIntegration!.views.record!.operations.actions!;
    expect(actions.map((action) => action.id)).toEqual(["api-keys.disable-integration"]);
    // The record action is bound to the record it was opened on, by the
    // entity's own id field — the integration's stable database id.
    expect(actions[0]!.target).toEqual({
      entityId: "ApiKeyIntegration",
      entityName: "ApiKeyIntegration",
      scope: "record",
      inputField: "integrationId",
    });
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
