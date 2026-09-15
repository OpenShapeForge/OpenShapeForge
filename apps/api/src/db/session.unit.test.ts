// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { createDbSessionContext } from "./session.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const relationGroupId = "33333333-3333-4333-8333-333333333333";

describe("RelationGroup database session context", () => {
  test("keeps RelationGroups separate from platform groups and normalizes them", () => {
    const context = createDbSessionContext({
      tenantId,
      userId,
      groups: ["/keycloak/path"],
      relationGroupIds: [relationGroupId, relationGroupId],
    });

    expect(context.groups).toEqual([]);
    expect(context.relationGroupIds).toEqual([relationGroupId]);
  });

  test("refuses malformed server-derived RelationGroup ids", () => {
    expect(() =>
      createDbSessionContext({
        tenantId,
        userId,
        relationGroupIds: ["/keycloak/path"],
      })
    ).toThrow("relationGroupId must be a UUID");
  });
});
