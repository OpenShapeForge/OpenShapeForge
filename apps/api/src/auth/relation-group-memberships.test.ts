// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import {
  resolveRelationGroupMembershipIds,
  type RelationGroupMembershipRow,
} from "./relation-group-memberships.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const relationId = "33333333-3333-4333-8333-333333333333";
const groupId = "44444444-4444-4444-8444-444444444444";

const session = {
  tenantId,
  userId,
  roles: [],
  groups: ["/keycloak/group/path"],
  scope: "self" as const,
};

const identity = {
  issuer: "https://identity.example/realms/test",
  subject: userId,
};

function row(overrides: Partial<RelationGroupMembershipRow> = {}): RelationGroupMembershipRow {
  return {
    ...identity,
    identityTenantId: tenantId,
    linkedRelationId: relationId,
    tenantId,
    relationId,
    relationGroupId: groupId,
    membershipStatus: "active",
    groupStatus: "active",
    ...overrides,
  };
}

const unusedDb = {} as OpenShapeForgeDatabase;

describe("resolveRelationGroupMembershipIds", () => {
  test("accepts only active same-tenant memberships for the authoritative linked Relation", async () => {
    const groups = await resolveRelationGroupMembershipIds(unusedDb, session, identity, {
      read: async () => [
        row(),
        row({ subject: "another-subject" }),
        row(),
        row({ tenantId: "66666666-6666-4666-8666-666666666666" }),
        row({ relationId: "77777777-7777-4777-8777-777777777777" }),
        row({ identityTenantId: "66666666-6666-4666-8666-666666666666" }),
        row({ membershipStatus: "inactive" }),
        row({ groupStatus: "inactive" }),
        row({ relationGroupId: "/untrusted/token/path" }),
      ],
    });

    expect(groups).toEqual([groupId]);
  });

  test("never reads memberships without a verified identity reference", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return [row()];
    };

    expect(
      await resolveRelationGroupMembershipIds(unusedDb, session, null, { read }),
    ).toEqual([]);
    expect(reads).toBe(0);
  });

  test("performs a fresh read on every request and revocation is immediate", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return reads === 1 ? [row()] : [];
    };

    expect(
      await resolveRelationGroupMembershipIds(unusedDb, session, identity, { read }),
    ).toEqual([groupId]);
    expect(
      await resolveRelationGroupMembershipIds(unusedDb, session, identity, { read }),
    ).toEqual([]);
    expect(reads).toBe(2);
  });

  test("fails closed without exposing database details", async () => {
    const warnings: string[] = [];
    const groups = await resolveRelationGroupMembershipIds(unusedDb, session, identity, {
      read: async () => {
        throw new Error("password=must-not-leak");
      },
      warn: (message) => warnings.push(message),
    });

    expect(groups).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("must-not-leak");
  });
});
