// SPDX-License-Identifier: BUSL-1.1
/**
 * Merging module GraphQL contributions.
 *
 * The collision cases are the reason this exists: a plain spread would let the
 * last module replace root fields the earlier ones added, and the symptom would
 * be a query that quietly returns the wrong resolver's answer.
 */
import { describe, expect, test } from "bun:test";
import type { RuntimeModule } from "../contract.js";
import {
  composeModuleGraphql,
  declaredFieldNames,
  ModuleCompositionError,
} from "../graphql-composition.js";

const noReserved = { query: [], mutation: [] };

function module(name: string, graphql: RuntimeModule["graphql"]): RuntimeModule {
  return { name, ...(graphql ? { graphql } : {}) };
}

describe("declaredFieldNames", () => {
  test("reads field names off an SDL fragment, arguments and all", () => {
    expect(
      declaredFieldNames(`
        health: Health!
        workflowDefinition(id: String!): WorkflowDefinitionRecord
        workflowDefinitions(
          first: Int
          after: String
        ): [WorkflowDefinitionRecord!]!
      `),
    ).toEqual(["health", "workflowDefinition", "workflowDefinitions"]);
  });

  test("ignores comments, descriptions and blank lines", () => {
    expect(
      declaredFieldNames(`
        # a comment
        """a description"""
        realField: String
      `),
    ).toEqual(["realField"]);
  });
});

describe("composeModuleGraphql", () => {
  test("joins contributions from several modules", () => {
    const composed = composeModuleGraphql(
      [
        module("a", () => ({
          typeDefs: "type A { id: ID! }",
          queryFields: "a: A",
          resolvers: { Query: { a: () => null }, A: { id: () => "1" } },
        })),
        module("b", () => ({
          typeDefs: "type B { id: ID! }",
          mutationFields: "makeB: B",
          resolvers: { Mutation: { makeB: () => null } },
        })),
      ],
      {},
      noReserved,
    );

    expect(composed.typeDefs).toContain("type A");
    expect(composed.typeDefs).toContain("type B");
    expect(composed.queryFields).toBe("a: A");
    expect(composed.mutationFields).toBe("makeB: B");
    expect(Object.keys(composed.resolvers).sort()).toEqual(["A", "Mutation", "Query"]);
  });

  test("a module with no graphql hook contributes nothing", () => {
    const composed = composeModuleGraphql([module("quiet", undefined)], {}, noReserved);
    expect(composed).toEqual({
      typeDefs: "",
      queryFields: "",
      mutationFields: "",
      resolvers: {},
    });
  });

  test("two modules claiming the same query field is refused", () => {
    expect(() =>
      composeModuleGraphql(
        [
          module("a", () => ({ queryFields: "thing: String" })),
          module("b", () => ({ queryFields: "thing: String" })),
        ],
        {},
        noReserved,
      ),
    ).toThrow(ModuleCompositionError);
  });

  test("a module cannot shadow a field the core already owns", () => {
    // The generated entity surface grows with the authoring YAML; a plugin
    // silently taking over `relations` is the failure this guard is for.
    expect(() =>
      composeModuleGraphql(
        [module("a", () => ({ queryFields: "relations(first: Int): [Relation!]!" }))],
        {},
        { query: ["relations"], mutation: [] },
      ),
    ).toThrow(/relations/);
  });

  test("two modules resolving the same non-root field is refused", () => {
    expect(() =>
      composeModuleGraphql(
        [
          module("a", () => ({ resolvers: { Shared: { field: () => 1 } } })),
          module("b", () => ({ resolvers: { Shared: { field: () => 2 } } })),
        ],
        {},
        noReserved,
      ),
    ).toThrow(ModuleCompositionError);
  });

  test("the same field name on Query and Mutation is not a collision", () => {
    const composed = composeModuleGraphql(
      [
        module("a", () => ({ queryFields: "thing: String" })),
        module("b", () => ({ mutationFields: "thing: String" })),
      ],
      {},
      noReserved,
    );
    expect(composed.queryFields).toBe("thing: String");
    expect(composed.mutationFields).toBe("thing: String");
  });
});
