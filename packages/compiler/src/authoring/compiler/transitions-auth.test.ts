// SPDX-License-Identifier: BUSL-1.1
/**
 * #944: `auth.roles` on a transition rule REPLACES the entity's update roles,
 * so a rule that only names a second right (Deal.win: Finance.Quotes.ReadWrite)
 * dropped the deal-write requirement. `auth.alsoRequire` is the conjunctive
 * form: the caller holds one of `roles` (default: the update roles) AND one of
 * `alsoRequire`, lowered to the Operation's `roleGroups`, which every runtime
 * surface already checks next to `roles` (REST, offers, MCP).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CoreEntity, Field } from "../types.js";
import { loadEntity } from "../loader.js";
import { compile } from "./index.js";
import { validateTransitionAuthorizationReferences } from "./authorization-validation.js";
import type { AuthorizationConfigFile } from "../types/authoring.js";

const authoringDir = join(import.meta.dir, "../../../config/authoring");
const milestone = loadEntity(authoringDir, "agreement-milestone");
const authorization: AuthorizationConfigFile = {
  schemaVersion: 2,
  kind: "authorizationConfig",
  realm: { name: "transition-role-test" },
  keycloak: { entityRoleClient: "erp-provider" },
  clientRoles: { "erp-provider": ["Agreements.All.ReadWrite", "Finance.All.ReadWrite"] },
};
const rule = { key: "trigger", from: ["pending"], to: "triggered" };

function withRule(auth: Record<string, unknown>): CoreEntity {
  const base = milestone.coreEntity;
  const { web: _web, ...interfaces } = base.interfaces ?? {};
  return {
    ...base,
    interfaces,
    fields: base.fields
      .filter((field) => !["triggeredAt", "triggeredBy", "producedInvoiceId"].includes(field.key))
      .map((field) => field.key === "status"
        ? { ...field, transitions: { initial: "pending", rules: [{ ...rule, auth }] } } as Field
        : field),
  };
}
const lowered = (auth: Record<string, unknown>) => compile({ ...milestone, coreEntity: withRule(auth) });

describe("transition auth.alsoRequire (#944)", () => {
  test("keeps the entity's update roles and adds a conjunctive role group", () => {
    const compiled = lowered({ alsoRequire: ["Finance.All.ReadWrite"] });
    expect(compiled.pluginOperations![0]!.definition.auth).toEqual({
      mode: "session",
      roles: ["Agreements.All.ReadWrite"],
      roleGroups: [["Finance.All.ReadWrite"]],
    });
    expect(validateTransitionAuthorizationReferences([compiled], authorization).errors).toEqual([]);
  });

  test("combines with explicit roles; roles alone still replace the update roles", () => {
    expect(lowered({ roles: ["Finance.All.ReadWrite"], alsoRequire: ["Agreements.All.ReadWrite"] }).pluginOperations![0]!.definition.auth)
      .toEqual({ mode: "session", roles: ["Finance.All.ReadWrite"], roleGroups: [["Agreements.All.ReadWrite"]] });
    expect(lowered({ roles: ["Finance.All.ReadWrite"] }).pluginOperations![0]!.definition.auth)
      .toEqual({ mode: "session", roles: ["Finance.All.ReadWrite"] });
  });

  test("an undeclared alsoRequire role is rejected like an undeclared role", () => {
    const compiled = lowered({ alsoRequire: ["Finance.Quotes.ReadWrtie"] });
    expect(validateTransitionAuthorizationReferences([compiled], authorization).errors).toEqual([
      '[AgreementMilestone] transition Operation "AgreementMilestone.trigger" references role "Finance.Quotes.ReadWrtie", which is not declared in the applicable authorization contract. Declare the role before using it on a transition.',
    ]);
  });
});
