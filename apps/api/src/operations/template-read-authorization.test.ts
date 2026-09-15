// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { requireOperationAuthorization, type OperationContract } from "./runtime.js";
import { sessionOperationRolesAllow } from "./session-authorization.js";

const session = { tenantId: "tenant-a", userId: "example-user", roles: ["Messaging.Send"], groups: [], scope: "tenant" as const, credential: "trusted-context" as const };
const sources = await Promise.all(["template", "template-version", "template-variant", "block", "text-block", "template-block", "youtube-embed"].map(async slug => ({
  slug, entity: Bun.YAML.parse(await Bun.file(new URL(`../../../../packages/compiler/config/authoring/entities/core/${slug}.yaml`, import.meta.url)).text()) as any,
})));

test("sending alone grants no template source access; Templates.Read covers every source and nested-template definition", () => {
  for (const { entity } of sources) {
    expect(sessionOperationRolesAllow(entity.authorization.roles.read, session.roles)).toBe(false);
    expect(sessionOperationRolesAllow(entity.authorization.roles.read, [...session.roles, "Templates.Read"])).toBe(true);
    for (const action of ["create", "update", "delete"]) {
      const roles = entity.authorization.roles[action];
      if (roles) {
        expect(roles).toEqual(["Organization.All.ReadWrite"]);
        expect(sessionOperationRolesAllow(roles, ["Templates.Read"])).toBe(false);
      }
    }
  }
});

test("the canonical operation guard requires template capability and a verified tenant for every read-only materializer", () => {
  let checked = 0;
  for (const { entity } of sources) for (const [key, value] of Object.entries(entity.operations)) {
    const operation = value as any;
    if (operation.implementation.type !== "plugin" || operation.effects.data !== "read") continue;
    // Exercise the real authorization guard with the source-owned auth contract.
    const contract = { key: `${entity.entity}.${key}`, auth: operation.auth, tenancy: operation.tenancy } as OperationContract;
    expect(() => requireOperationAuthorization(contract, session)).toThrow("required operation role");
    expect(() => requireOperationAuthorization(contract, { ...session, roles: [...session.roles, "Templates.Read"] })).not.toThrow();
    expect(() => requireOperationAuthorization(contract, { ...session, tenantId: null as never, roles: ["Templates.Read"] })).toThrow("tenant context");
    expect(() => requireOperationAuthorization(contract, undefined)).toThrow("authenticated bearer");
    checked++;
  }
  expect(checked).toBe(5);
});
