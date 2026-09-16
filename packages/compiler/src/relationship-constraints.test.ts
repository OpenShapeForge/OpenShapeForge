// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { CompiledEntityInfo } from "./plugins.js";
import { validateRelationshipConstraints } from "./relationship-constraints.js";

function entity(name: string, fields: Array<Record<string, unknown>>, relationships: Array<Record<string, unknown>> = []) {
  return {
    slug: name.toLowerCase(), path: `${name}.yaml`, origin: "core",
    contract: { entity: { name }, model: { fields, relationships } },
  } as unknown as CompiledEntityInfo;
}

const relation = entity("Relation", [
  { key: "relationType", valueType: "string", cardinality: "single" },
], [{ key: "groupMemberships", kind: "hasMany", target: "RelationGroupMembership", foreignKey: "relation_id" }]);
const membership = entity("RelationGroupMembership", [
  { key: "relationGroupId", valueType: "string", cardinality: "single" },
]);

describe("relationship constraints", () => {
  test("accepts exact target fields and one hasMany any predicate", () => {
    const deal = entity("Deal", [], [{
      key: "relationId", fieldKey: "relationId", kind: "belongsTo", target: "Relation", cardinality: "single",
      constraints: {
        relationType: { eq: "organization" },
        groupMemberships: { any: { relationGroupId: { eq: "00000000-0000-4000-8000-000000000001" } } },
      },
    }]);
    expect(() => validateRelationshipConstraints([deal, relation, membership])).not.toThrow();
  });

  test("rejects unknown fields and collection predicates that are not hasMany", () => {
    const deal = entity("Deal", [], [{
      key: "relationId", fieldKey: "relationId", kind: "belongsTo", target: "Relation", cardinality: "single",
      constraints: { missing: { eq: "organization" } },
    }]);
    expect(() => validateRelationshipConstraints([deal, relation, membership])).toThrow("must name a scalar target field");
  });
});
