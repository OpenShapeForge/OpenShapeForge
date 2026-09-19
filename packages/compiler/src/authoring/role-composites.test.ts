// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { buildRoleComposites, renderRoleComposites } from "./role-composites.js";

describe("buildRoleComposites", () => {
  test("keeps realm and client ownership, names each member's namespace, sorts", () => {
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
          // The same persona name on another client with other members stays
          // that client's, never merged into api's.
          other: [{ name: "org_admin", composite: true, composites: { client: { other: ["y"] } } }],
        },
      },
    };
    const composites = buildRoleComposites([
      { path: "keycloak/tenant-realm.json", contents: JSON.stringify(realm) },
      { path: "keycloak/control-realm.json", contents: JSON.stringify({ realm: "control", roles: {} }) },
    ]);
    expect(composites).toEqual({
      control: { realm: {}, clients: {} },
      tenant: {
        realm: { reader: [{ client: "api", role: "Records.Read" }] },
        clients: {
          api: {
            org_admin: [
              { client: "api", role: "General.All.ReadWrite" },
              { client: "api", role: "Organization.All.ReadWrite" },
              { client: "other", role: "x" },
              { realm: "reader" },
            ],
          },
          other: { org_admin: [{ client: "other", role: "y" }] },
        },
      },
    });
    expect(renderRoleComposites(composites)).toBe(`${JSON.stringify(composites, null, 2)}\n`);
  });

  test("a role declared twice in one namespace is a compile error", () => {
    const realm = {
      realm: "tenant",
      roles: { client: { api: [
        { name: "dup", composite: true, composites: { client: { api: ["a"] } } },
        { name: "dup", composite: true, composites: { client: { api: ["b"] } } },
      ] } },
    };
    expect(() => buildRoleComposites([{ path: "keycloak/tenant-realm.json", contents: JSON.stringify(realm) }]))
      .toThrow(/declared twice/);
  });
});
