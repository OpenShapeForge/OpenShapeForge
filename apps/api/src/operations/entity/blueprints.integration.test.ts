// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";

// Explicit opt-in: run only against an isolated API with the synthetic blueprint
// and customer tenants provisioned. Never target a shared acceptance database.
const base = process.env.BLUEPRINT_TEST_API;
const secret = process.env.BLUEPRINT_TEST_CONTEXT_SECRET;
const source = "11111111-1111-4111-8111-111111111168";
const customer = "22222222-2222-4222-8222-222222222268";
const reader = ["Relations.All.Read"];
const writer = [...reader, "Relations.RelationGroups.ReadWrite"];
async function request(tenant: string, method: string, path: string, body?: unknown, roles = tenant === source ? [...writer, "platform-operator"] : writer) {
  const headers = new Headers({ "content-type": "application/json" });
  applyTrustedContextHeaders(headers, { tenantId: tenant, userId: "33333333-3333-4333-8333-333333333369", roles }, { secret: secret! });
  const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
async function mutate(tenant: string, operationId: string, row: any, path: string, body: any, method = "POST") {
  const lease = await request(tenant, "POST", "/api/operation-leases", { operationId, targetId: row.id });
  expect(lease.status).toBe(201);
  try { return await request(tenant, method, path, { ...body, expectedVersion: row.updatedAt, leaseToken: lease.body.data.leaseToken }); }
  finally { await request(tenant, "POST", "/api/operation-leases/release", { leaseToken: lease.body.data.leaseToken }); }
}
const entityPath = "/api/rest/v1/relation-groups";
const blueprintPath = "/api/blueprints/relation-group";

test.skipIf(!base || !secret)("published copy, local edit, explicit reset and denied cross-tenant access", async () => {
  const externalId = `test-${crypto.randomUUID()}`;
  const made = await request(source, "POST", entityPath, { name: "Test source", description: "Version one", groupType: "general", externalId });
  expect(made.status).toBe(201);
  let original = made.body.data;
  const publication = await mutate(source, "osf-blueprints.RelationGroup.publish", original, `${blueprintPath}/publish`, { id: original.id });
  expect(publication.status).toBe(200);
  expect(publication.body.version).toBe(1);
  const list = await request(customer, "POST", `${blueprintPath}/list`, { search: externalId });
  // Lookup is label-based; exact source lookup happens only at create.
  expect(list.status).toBe(200);
  expect((await request(customer, "GET", `${entityPath}/${original.id}`)).status).toBe(404);
  expect((await request(customer, "POST", `${blueprintPath}/list`, {}, reader)).status).toBe(403);
  const denied = await request(customer, "POST", entityPath, { blueprintId: externalId }, reader);
  expect(denied.status).toBe(403);
  expect((await request(customer, "POST", entityPath, { blueprintId: "missing-source" })).status).toBe(404);
  const copy = await request(customer, "POST", entityPath, { blueprintId: externalId, externalCode: "LOCAL-ONLY" });
  expect(copy.status).toBe(201);
  let local = copy.body.data;
  expect(local.name).toBe("Test source");
  expect(local.externalId).toBeNull();
  expect(local.id).not.toBe(original.id);
  expect(local.tenantId).toBe(customer);
  const edited = await mutate(customer, "RelationGroup.update", local, `${entityPath}/${local.id}`, { name: "Local name" }, "PATCH");
  expect(edited.status).toBe(200);
  local = edited.body.data;
  const sourceEdit = await mutate(source, "RelationGroup.update", original, `${entityPath}/${original.id}`, { name: "New standard", description: "Version two" }, "PATCH");
  expect(sourceEdit.status).toBe(200);
  original = sourceEdit.body.data;
  const second = await mutate(source, "osf-blueprints.RelationGroup.publish", original, `${blueprintPath}/publish`, { id: original.id });
  expect(second.status).toBe(200);
  expect(second.body.version).toBe(2);
  const state = await request(customer, "POST", `${blueprintPath}/status`, { id: local.id });
  expect(state.body.updateAvailable).toBe(true);
  expect(state.body.source.version).toBe(1);
  expect((await request(customer, "GET", `${entityPath}/${local.id}`)).body.data.name).toBe("Local name");
  const stale = await mutate(customer, "osf-blueprints.RelationGroup.reset", local, `${blueprintPath}/reset`, { id: local.id, blueprintVersion: 1, confirmed: true });
  expect(stale.status).toBe(409);
  const unconfirmed = await mutate(customer, "osf-blueprints.RelationGroup.reset", local, `${blueprintPath}/reset`, { id: local.id, blueprintVersion: 2, confirmed: false });
  expect(unconfirmed.status).toBe(400);
  const reset = await mutate(customer, "osf-blueprints.RelationGroup.reset", local, `${blueprintPath}/reset`, { id: local.id, blueprintVersion: 2, confirmed: true });
  expect(reset.status).toBe(200);
  expect(reset.body.id).toBe(local.id);
  expect(reset.body.name).toBe("New standard");
  expect(reset.body.externalCode).toBe("LOCAL-ONLY");
  expect((await request(customer, "POST", `${blueprintPath}/status`, { id: local.id })).body.updateAvailable).toBe(false);
  const noPublish = await request(customer, "POST", `${blueprintPath}/publish`, { id: local.id, expectedVersion: reset.body.updatedAt, leaseToken: "invalid" });
  expect(noPublish.status).toBe(403);
}, 30000);
