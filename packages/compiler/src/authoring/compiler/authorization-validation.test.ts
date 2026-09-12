// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { AuthorizationConfigFile } from "../types/authoring.js";
import { validateAuthorizationReferences } from "./authorization-validation.js";

function config(compositeRole = "Data.All.Read"): AuthorizationConfigFile {
  return {
    schemaVersion: 2,
    kind: "authorizationConfig",
    realm: { name: "validation-test" },
    keycloak: {
      clients: [
        { id: "application-api", kind: "bearerOnly" },
        { id: "resource-api", kind: "bearerOnly" },
      ],
    },
    clientRoles: { "resource-api": ["Data.All.Read"] },
    clientRoleComposites: {
      "application-api": {
        "Application.Reader": {
          composites: { "resource-api": [compositeRole] },
        },
      },
    },
  };
}

describe("authorization client role composite references", () => {
  test("accepts a composite over a declared resource-client role", () => {
    expect(validateAuthorizationReferences([], config()).errors).toEqual([]);
  });

  test("reports an unknown composite target role with its full authoring path", () => {
    expect(validateAuthorizationReferences([], config("Data.All.Write")).errors).toEqual([
      "clientRoleComposites.application-api.Application.Reader.composites.resource-api " +
        'references "Data.All.Write" which is not declared for that client.',
    ]);
  });
});
