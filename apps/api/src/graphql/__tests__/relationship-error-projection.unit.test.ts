// SPDX-License-Identifier: BUSL-1.1
/**
 * DB-free unit tests for error projection on nested relationship resolvers
 * (#471). The root resolvers already project a canonical failure into a
 * GraphQLError carrying its code; the relationship edges (`parent.child`,
 * `parent.childAggregate`) did not, so a FORBIDDEN on the target reached the
 * client masked as "Unexpected error." — indistinguishable from a crash. The
 * target-read gate throws before any transaction opens, so a stub database is
 * enough to exercise the edge.
 */
import { describe, expect, test } from "bun:test";
import { GraphQLError } from "graphql";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { GraphqlContext } from "../context.js";
import { getGeneratedCrudTables } from "../generated-crud.js";
import { generatedEntityResolvers } from "../generated-entity-schema.js";

type Resolver = (parent: Record<string, unknown>, args: unknown, context: GraphqlContext) => Promise<unknown>;

const tables = getGeneratedCrudTables();
const typeNames = new Set(tables.map((table) => table.source?.graphql?.typeName));
const parent = tables.find((table) =>
  (table.source?.graphql?.relationships ?? []).some((relationship) => typeNames.has(relationship.target)),
)!;
const relationship = parent.source!.graphql!.relationships!.find((candidate) => typeNames.has(candidate.target))!;
const typeResolvers = (generatedEntityResolvers as Record<string, Record<string, Resolver>>)[parent.source!.graphql!.typeName]!;
const context: GraphqlContext = {
  session: { tenantId: "tenant", userId: "user", roles: [], groups: [], scope: "tenant", credential: "bearer" },
  db: {} as OpenShapeForgeDatabase,
};

async function captureRejection(run: () => Promise<unknown>): Promise<GraphQLError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(GraphQLError);
    return error as GraphQLError;
  }
  throw new Error("expected the resolver to reject");
}

describe(`relationship edge error projection (${parent.source!.graphql!.typeName}.${relationship.name})`, () => {
  test("a denied target read surfaces as FORBIDDEN with its status, not as a masked internal error", async () => {
    const error = await captureRejection(() => typeResolvers[relationship.name]!({ id: "row" }, {}, context));
    expect(error.extensions.code).toBe("FORBIDDEN");
    expect(error.extensions.status).toBe(403);
    expect(error.message).toContain(relationship.target);
  });

  test("the aggregate edge projects the same refusal", async () => {
    const error = await captureRejection(() => typeResolvers[`${relationship.name}Aggregate`]!({ id: "row" }, {}, context));
    expect(error.extensions.code).toBe("FORBIDDEN");
    expect(error.extensions.status).toBe(403);
  });
});
