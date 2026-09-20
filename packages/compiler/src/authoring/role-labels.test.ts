// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { applyAuthorizationPatch } from "./authorization-patch.js";
import { strategicMerge } from "./layers.js";
import { buildRoleLabels, renderRoleLabels } from "./role-labels.js";
import type { AuthorizationConfigFile } from "./types/authoring.js";

const base = {
  schemaVersion: 2,
  kind: "authorizationConfig",
  realm: { name: "openshapeforge", displayName: "OpenShapeForge", sslRequired: "none" },
  keycloak: {
    entityRoleClient: "erp-provider",
    clients: [
      {
        id: "erp-provider",
        kind: "bearerOnly",
        devSecret: "erp-provider-secret",
        secret: "${env:KEYCLOAK_CLIENT_SECRET_ERP_PROVIDER}",
      },
    ],
  },
  clientRoles: { "erp-provider": ["Relations.All.ReadWrite"] },
  roleLabels: {
    org_admin: {
      label: { nl: "Organisatiebeheerder", en: "Organization administrator" },
      phrase: { en: "organization administrator", nl: "organisatiebeheerder" },
    },
    "Relations.All.ReadWrite": { phrase: { en: "manage clients and other relations" } },
  },
} as unknown as AuthorizationConfigFile;

describe("role labels", () => {
  test("are emitted keyed by role with languages in a stable order, later realms winning", () => {
    const control = {
      ...base,
      realm: { name: "openshapeforge-control" },
      roleLabels: {
        platform_admin: { label: { en: "Platform administrator" } },
        "Relations.All.ReadWrite": { phrase: { nl: "relaties beheren", en: "manage relations" } },
      },
    } as unknown as AuthorizationConfigFile;
    const table = buildRoleLabels([base, control]);
    expect(Object.keys(table)).toEqual(["org_admin", "Relations.All.ReadWrite", "platform_admin"]);
    expect(Object.keys(table.org_admin!.label!)).toEqual(["en", "nl"]);
    expect(table["Relations.All.ReadWrite"]).toEqual({
      phrase: { en: "manage relations", nl: "relaties beheren" },
    });
    expect(renderRoleLabels(table)).toBe(`${JSON.stringify(table, null, 2)}\n`);
    const { roleLabels: _labels, ...unlabelled } = base;
    expect(buildRoleLabels([unlabelled])).toEqual({});
  });

  test("a host adds and refines labels through an authorizationPatch, and an unusable one is refused", () => {
    const merged = applyAuthorizationPatch(
      base as never,
      {
        kind: "authorizationPatch",
        roleLabels: {
          auditor: { label: { en: "Auditor" }, phrase: { en: "auditor", nl: "auditor" } },
          org_admin: { phrase: { nl: "beheerder" } },
        },
      } as never,
      { strategicMerge, origin: "host/authorization.yaml" },
    ) as unknown as AuthorizationConfigFile;
    expect(merged.roleLabels).toEqual({
      org_admin: {
        label: { nl: "Organisatiebeheerder", en: "Organization administrator" },
        phrase: { en: "organization administrator", nl: "beheerder" },
      },
      "Relations.All.ReadWrite": { phrase: { en: "manage clients and other relations" } },
      auditor: { label: { en: "Auditor" }, phrase: { en: "auditor", nl: "auditor" } },
    });
    expect(() =>
      applyAuthorizationPatch(
        base as never,
        { kind: "authorizationPatch", roleLabels: { auditor: { title: "Auditor" } } } as never,
        { strategicMerge, origin: "host/authorization.yaml" },
      ),
    ).toThrow(/host\/authorization\.yaml/);
  });
});
