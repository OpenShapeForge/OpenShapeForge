#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
/**
 * End-to-end proof of the generated CRUD surface against a running API.
 *
 * Signs trusted-context headers the same way the web server does and walks a
 * full Relation/RelationGroup lifecycle: create group -> create relation in
 * group -> list/filter -> traverse belongsTo + hasMany -> update -> delete.
 *
 * Usage: API_URL=http://127.0.0.1:3001 bun scripts/e2e-crud-proof.ts
 */
import { applyTrustedContextHeaders } from "../packages/auth/src/index.ts";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:3001";
const SECRET =
  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? "openshapeforge-local-dev-context-secret";
const identity = {
  tenantId: process.env.OPENSHAPEFORGE_DEV_TENANT_ID ?? "11111111-1111-4111-8111-111111111111",
  userId: process.env.OPENSHAPEFORGE_DEV_USER_ID ?? "22222222-2222-4222-8222-222222222222",
  roles: ["Relaties.All.ReadWrite"],
};

let failures = 0;

async function gql(label: string, query: string, variables?: Record<string, unknown>) {
  const headers = new Headers({ "content-type": "application/json" });
  applyTrustedContextHeaders(headers, identity, { secret: SECRET });
  const response = await fetch(`${API_URL}/api/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: any; errors?: { message: string }[] };
  if (body.errors?.length) {
    failures += 1;
    console.error(`FAIL ${label}: ${body.errors.map((e) => e.message).join("; ")}`);
    return null;
  }
  console.log(`ok   ${label}`);
  return body.data;
}

const health = await gql("health", "{ health { status role } }");
if (!health) process.exit(1);

const group = await gql(
  "createRelationGroup",
  `mutation { createRelationGroup(input: { name: "E2E Group", status: "active" }) { id name } }`,
);
const groupId = group?.createRelationGroup?.id;

const relation = await gql(
  "createRelation",
  `mutation($gid: ID) { createRelation(input: {
      displayName: "E2E Relation", relationType: "NAT", status: "active", relationGroupId: $gid
    }) { id displayName relationGroupId } }`,
  { gid: groupId },
);
const relationId = relation?.createRelation?.id;

const list = await gql(
  "listRelations(filter)",
  `{ relations(filter: { displayName: "E2E Relation" }, first: 10) {
      totalCount edges { node { id displayName } } } }`,
);
if (list && list.relations.totalCount !== 1) {
  failures += 1;
  console.error(`FAIL listRelations: expected totalCount 1, got ${list.relations.totalCount}`);
}

const traverse = await gql(
  "relation -> relationGroup (belongsTo)",
  `query($id: ID!) { relation(id: $id) { id relationGroup { id name } } }`,
  { id: relationId },
);
if (traverse && traverse.relation?.relationGroup?.id !== groupId) {
  failures += 1;
  console.error("FAIL belongsTo traversal: relationGroup mismatch");
}

const members = await gql(
  "relationGroup -> members (hasMany)",
  `query($id: ID!) { relationGroup(id: $id) { id members { id displayName } membersAggregate { count } } }`,
  { id: groupId },
);
if (members && members.relationGroup?.membersAggregate?.count !== 1) {
  failures += 1;
  console.error("FAIL hasMany traversal: expected 1 member");
}

await gql(
  "updateRelation",
  `mutation($id: ID!) { updateRelation(input: { id: $id, status: "inactive" }) { id status } }`,
  { id: relationId },
);

await gql("deleteRelation", `mutation($id: ID!) { deleteRelation(id: $id) }`, { id: relationId });
await gql("deleteRelationGroup", `mutation($id: ID!) { deleteRelationGroup(id: $id) }`, {
  id: groupId,
});

const empty = await gql(
  "list after delete",
  `{ relations(filter: { displayName: "E2E Relation" }, first: 1) { totalCount } }`,
);
if (empty && empty.relations.totalCount !== 0) {
  failures += 1;
  console.error("FAIL cleanup: relation still present after delete");
}

if (failures > 0) {
  console.error(`\ne2e CRUD proof FAILED (${failures} failures)`);
  process.exit(1);
}
console.log("\ne2e CRUD proof passed");
