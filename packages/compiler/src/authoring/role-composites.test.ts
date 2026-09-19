// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { buildRoleComposites, renderRoleComposites } from "./role-composites.js";

describe("buildRoleComposites", () => {
  test("collects realm and client composites per realm, direct members only, sorted", () => {
    const realm = {
      realm: "tenant",
      roles: {
        realm: [
          { name: "plain" },
          { name: "reader", composite: true, composites: { client: { api: ["Records.Read"] } } },
        ],
        client: {
          api: [
            { name: "Records.Read" },
            {
              name: "org_admin",
              composite: true,
              composites: { realm: ["reader"], client: { api: ["Organization.All.ReadWrite", "General.All.ReadWrite"], other: ["x"] } },
            },
          ],
        },
      },
    };
    const composites = buildRoleComposites([
      { path: "keycloak/tenant-realm.json", contents: JSON.stringify(realm) },
      { path: "keycloak/control-realm.json", contents: JSON.stringify({ realm: "control", roles: {} }) },
    ]);
    expect(composites).toEqual({
      control: {},
      tenant: {
        org_admin: ["General.All.ReadWrite", "Organization.All.ReadWrite", "reader", "x"],
        reader: ["Records.Read"],
      },
    });
    expect(renderRoleComposites(composites)).toBe(`${JSON.stringify(composites, null, 2)}\n`);
  });
});
