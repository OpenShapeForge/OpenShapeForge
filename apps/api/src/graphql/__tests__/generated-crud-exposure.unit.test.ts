// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  getGeneratedCrudTables,
  isGeneratedCrudOperationEnabled,
  isGeneratedCrudTableEligible,
} from "../generated-crud.js";
import {
  executeCanonicalGraphqlOperation,
  generatedEntityMutationFields,
  generatedEntityTypeDefs,
  renderGeneratedMutationFields,
  renderGeneratedQueryFields,
  renderMutationFields,
  renderQueryFields,
  renderTypeDefinition,
  splitCanonicalGraphqlMutationInput,
} from "../generated-entity-schema.js";

type GeneratedTable = ReturnType<typeof getGeneratedCrudTables>[number];

const base = getGeneratedCrudTables().find((table) => table.name === "erp.relations")!;

function withOperations(
  operations: Record<"list" | "get" | "create" | "update" | "delete", boolean>,
): GeneratedTable {
  return {
    ...base,
    source: {
      ...base.source,
      crud: { operations },
      graphql: {
        ...base.source!.graphql!,
        operations,
      },
    },
  };
}

describe("generated GraphQL CRUD exposure", () => {
  test("projects server-issued Operation interactions on the shared offer", () => {
    expect(renderTypeDefinition(base)).toContain("operations: [EntityOperationOffer!");
    expect(generatedEntityTypeDefs).toContain("interaction: EntityOperationInteraction");
    expect(generatedEntityTypeDefs).toContain("offerId: String!");
    expect(generatedEntityTypeDefs).toContain("bindTo: EntityOperationInteractionBinding!");
    expect(generatedEntityTypeDefs).toContain("concurrency: EntityOperationConcurrency");
    expect(generatedEntityTypeDefs).toContain("expiresAfterInactivity: String!");
  });
  test("partial policies are visible to current runtimes and hidden from legacy ones", () => {
    const table = withOperations({
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
    });
    table.generatedCrudEligible = true;
    expect(isGeneratedCrudTableEligible(table)).toBe(true);
    expect(isGeneratedCrudOperationEnabled(table, "list")).toBe(true);
    expect(isGeneratedCrudOperationEnabled(table, "create")).toBe(false);
  });

  test("an eligible table without a per-operation policy serves nothing", () => {
    const unpoliced = {
      ...base,
      generatedCrudEligible: true,
      source: { ...base.source, crud: undefined },
    } as unknown as GeneratedTable;
    expect(isGeneratedCrudTableEligible(unpoliced)).toBe(true);
    expect(isGeneratedCrudOperationEnabled(unpoliced, "delete")).toBe(false);
  });

  test("a read-only entity emits queries but no mutations", () => {
    const table = withOperations({
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
    });
    expect(renderGeneratedQueryFields(table)).toHaveLength(2);
    expect(renderGeneratedMutationFields(table)).toEqual([]);
  });

  test("a read-only entity with required children does not resolve a missing create Operation", () => {
    const table = withOperations({ list: true, get: true, create: false, update: false, delete: false });
    table.source!.authoringEntityName = "ReadOnlyCollectionFixture";
    table.source!.graphql!.relationships = [{
      name: "children", fieldKey: "children", target: "Relation", type: "[Relation!]!", resolve: "hasMany",
      foreignKey: "parent_id", cardinality: { min: 1 },
    }];
    expect(renderGeneratedMutationFields(table)).toEqual([]);
  });

  test("independent list/get flags emit only the selected read operation", () => {
    const table = withOperations({
      list: false,
      get: true,
      create: false,
      update: false,
      delete: false,
    });
    expect(renderGeneratedQueryFields(table)).toHaveLength(1);
    expect(renderGeneratedQueryFields(table)[0]).toContain("relation(id:");
  });

  test("write operations are emitted independently", () => {
    const table = withOperations({
      list: false,
      get: false,
      create: true,
      update: false,
      delete: false,
    });
    expect(renderGeneratedQueryFields(table)).toEqual([]);
    expect(renderGeneratedMutationFields(table)).toHaveLength(1);
    expect(renderGeneratedMutationFields(table)[0]).toContain("createRelation");
  });

  test("v2 type rendering does not require a disabled update Operation", () => {
    const table = withOperations({
      list: true,
      get: true,
      create: true,
      update: false,
      delete: true,
    });

    const definition = renderTypeDefinition(table, new Map());
    expect(renderGeneratedMutationFields(table)).toEqual([
      expect.stringContaining("createRelation"),
      expect.stringContaining("deleteRelation"),
    ]);
    expect(definition).not.toContain("updateRelation(input:");
  });

  test("v2 GraphQL interface exposure can narrow the shared CRUD operations", () => {
    const table = withOperations({
      list: true,
      get: true,
      create: true,
      update: false,
      delete: false,
    });
    table.source!.graphql = {
      ...table.source!.graphql!,
      operations: { list: false, get: false, create: false, update: false, delete: false },
    };
    expect(renderGeneratedQueryFields(table)).toEqual([]);
    expect(renderGeneratedMutationFields(table)).toEqual([]);
  });

  test("v2 fields expose the canonical result envelope and operation controls", () => {
    const table = withOperations({
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
    });

    expect(renderQueryFields(table)).toContain("relation(id: ID!): RelationOperationResult");
    expect(renderQueryFields(table)).toContain(
      "relations(filter: RelationFilter, sort: RelationSort, first: Int, after: String): RelationCollectionOperationResult",
    );
    expect(renderMutationFields(table)).toContain(
      "updateRelation(input: UpdateRelationInput!): RelationOperationResult",
    );
    expect(renderMutationFields(table)).toContain(
      "deleteRelation(input: DeleteRelationInput!): RelationDeleteOperationResult",
    );

    const definition = renderTypeDefinition(table, new Map());
    expect(definition).toContain("type RelationOperationResult");
    expect(definition).toContain("type RelationCollectionOperationResult");
    expect(definition).toContain("type RelationDeleteOperationResult");
    expect(definition).toContain("expectedVersion: String!");
    expect(definition).toContain("leaseToken: String!");
    expect(definition).toContain("confirmationToken: String");
    expect(definition).toContain("confirmationAnswer: String");
    expect(generatedEntityTypeDefs).toContain("available: Boolean");
    expect(generatedEntityTypeDefs).toContain("error: EntityOperationError");
  });

  test("v2 mutation controls are separated from authored values before dispatch", () => {
    expect(splitCanonicalGraphqlMutationInput({
      id: "relation-1",
      displayName: "Updated relation",
      expectedVersion: "2026-09-12T10:00:00.000Z",
      leaseToken: "lease-token",
      confirmationToken: "challenge-token",
      confirmationAnswer: "Updated relation",
    }, true)).toEqual({
      id: "relation-1",
      values: { displayName: "Updated relation" },
      controls: {
        expectedVersion: "2026-09-12T10:00:00.000Z",
        leaseToken: "lease-token",
        confirmationToken: "challenge-token",
        confirmationAnswer: "Updated relation",
      },
    });
  });

  test("v2 dispatch uses the canonical Operation id and GraphQL projection flags", async () => {
    const table = withOperations({
      list: true,
      get: true,
      create: true,
      update: false,
      delete: false,
    });
    let request: unknown;
    const result = await executeCanonicalGraphqlOperation(
      table,
      "get",
      { id: "relation-1" },
      {
        db: {} as never,
        session: {
          tenantId: "00000000-0000-4000-8000-000000000001",
          userId: "00000000-0000-4000-8000-000000000002",
          roles: ["Relations.All.Read"],
          groups: [],
          scope: "tenant",
          credential: "bearer",
        },
      },
      (async (_db: never, _session: never, incoming: unknown) => {
        request = incoming;
        return { intent: "get", data: { id: "relation-1" }, operations: [] };
      }) as never,
    );

    expect(request).toEqual({
      operation: { id: "Relation.get", intent: "get" },
      offerIntents: ["list", "get", "create"],
      input: { id: "relation-1" },
    });
    expect(result).toEqual({
      intent: "get",
      data: { id: "relation-1" },
      operations: [],
    });
  });

  test("every generated entity projects the canonical envelope, whatever its authoring version", () => {
    const table = withOperations({
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
    });
    expect(renderGeneratedQueryFields(table)[0]).toContain(": RelationOperationResult");
    expect(renderGeneratedMutationFields(table)).toContain(
      "      deleteRelation(input: DeleteRelationInput!): RelationDeleteOperationResult",
    );
  });
});

describe("the Tenant registry on GraphQL", () => {
  // The registry row is provisioned (control/provisioning.ts); the contract
  // offers only get and list. Name/status changes use the separate control
  // Operations and never the tenant-facing generic CRUD runtime.
  const tenants = getGeneratedCrudTables().find((table) => table.name === "erp.tenants")!;

  test("renders no tenant-facing mutation", () => {
    const mutations = renderGeneratedMutationFields(tenants).join("\n");
    expect(mutations).not.toMatch(/createTenant\(|updateTenant\(|deleteTenant\(/);
    expect(renderMutationFields(tenants)).not.toMatch(/createTenant\(|updateTenant\(|deleteTenant\(/);
    // The whole schema's Mutation block: what a client can call. The
    // Create/Delete input types are rendered per entity regardless, as for
    // every partial policy, and are not callable without a field.
    expect(generatedEntityMutationFields).not.toMatch(/\bcreateTenant\(|\bupdateTenant\(|\bdeleteTenant\(/);
    expect(renderGeneratedQueryFields(tenants).join("\n")).toMatch(/\btenant\(|\btenants\(/);
  });
});
