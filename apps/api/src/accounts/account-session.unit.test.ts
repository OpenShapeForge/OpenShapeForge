// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { accountSession, ACCOUNT_READ, ACCOUNT_MANAGE } from "./account-session.js";
import type { ModuleOperationContext } from "../modules/contract.js";

const context = (roles: string[]) => ({ db: {}, session: { tenantId: "tenant", userId: "subject", roles } }) as unknown as ModuleOperationContext;
test("Account read and manage are independent of business Relation permissions", () => {
  expect(accountSession(context([ACCOUNT_READ])).tenantId).toBe("tenant");
  expect(accountSession(context([ACCOUNT_MANAGE])).tenantId).toBe("tenant");
  expect(() => accountSession(context([ACCOUNT_READ]), "manage")).toThrow("permission required");
  expect(accountSession(context([ACCOUNT_MANAGE]), "manage").userId).toBe("subject");
  for (const roles of [[], ["Relations.All.Read"], ["Relations.All.ReadWrite"], ["Organization.Access.Manage"]]) {
    expect(() => accountSession(context(roles))).toThrow("permission required");
  }
});
test("missing tenant, principal and database are not accepted", () => {
  const c = context([ACCOUNT_READ]);
  const { session: _session, ...unsigned } = c;
  expect(() => accountSession(unsigned)).toThrow("Sign in");
  expect(() => accountSession({ ...c, db: undefined })).toThrow("unavailable");
});
