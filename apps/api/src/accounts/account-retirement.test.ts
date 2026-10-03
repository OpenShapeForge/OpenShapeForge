// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import catalog from "../generated/operations/catalog.json" with { type: "json" };
import accounts from "./runtime.js";
import { callIdentityLinkTool, identityLinkToolsForSession } from "../mcp/identity-link-tools.js";
import { IDENTITY_LINK_ADMIN_ROLE } from "../auth/organization-roles.js";

test("only canonical Account owns reads and revision-bound direct access mutations", () => {
  const keys = catalog.operations.map(operation => operation.key);
  for (const key of ["accounts.list", "accounts.get", "accounts.assign-account-role", "accounts.revoke-account-role",
    "accounts.assign-member-role", "accounts.revoke-member-role", "accounts.block-member", "accounts.restore-member"]) {
    expect(keys).not.toContain(key);
  }
  for (const handler of ["listAccounts", "getAccount", "assignAccountRole", "revokeAccountRole", "blockMember", "restoreMember"]) {
    expect(accounts.operationHandlers).not.toHaveProperty(handler);
  }
  for (const key of ["Account.list", "Account.get", "Account.block", "Account.restore", "Account.assignRole", "Account.revokeRole",
    "accounts.invite-member", "accounts.resend-member-invitation", "accounts.revoke-member-invitation", "accounts.create"]) {
    expect(keys).toContain(key);
  }
});

test("legacy MCP set_member_role is neither listed nor dispatched", async () => {
  const session: any = { tenantId: crypto.randomUUID(), userId: crypto.randomUUID(), roles: [IDENTITY_LINK_ADMIN_ROLE], groups: [], scope: "tenant" };
  expect(identityLinkToolsForSession(session).map(tool => tool.name)).not.toContain("set_member_role");
  expect(await callIdentityLinkTool("set_member_role", { identityId: crypto.randomUUID(), role: "org_admin" }, {} as any, session)).toBeUndefined();
  expect(identityLinkToolsForSession(session).map(tool => tool.name)).toContain("link_identity");
  expect(identityLinkToolsForSession(session).map(tool => tool.name)).toContain("list_pending_members");
});
