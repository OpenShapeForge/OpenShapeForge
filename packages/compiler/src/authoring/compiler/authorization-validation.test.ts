// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { AuthorizationConfigFile } from "../types/authoring.js";
import type { CompiledConnectorContract } from "../types/connector.js";
import {
  validateAuthorizationReferences,
  validateConnectorAuthorizationReferences,
} from "./authorization-validation.js";

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

describe("connector authorization references", () => {
  const connector = (
    name: string,
    read = `Connectors.${name}.Read`,
    write = `Connectors.${name}.Write`,
  ) => ({ connector: name, authorization: { roles: { read, write } } }) as CompiledConnectorContract;
  const connectorConfig = (): AuthorizationConfigFile => ({
    schemaVersion: 2,
    kind: "authorizationConfig",
    keycloak: { entityRoleClient: "erp-provider" },
    clientRoles: { "erp-provider": ["Connectors.Example.Read"] },
    clientRoleComposites: {
      "erp-provider": {
        "Connectors.Example.Write": {
          composites: { "erp-provider": ["Connectors.Example.Read"] },
        },
      },
    },
  });

  test("accepts one declared read role and a write role that includes it", () => {
    expect(
      validateConnectorAuthorizationReferences([connector("Example")], connectorConfig()).errors,
    ).toEqual([]);
  });

  test("rejects undeclared, non-composite, and cross-connector permissions", () => {
    const auth = connectorConfig();
    expect(
      validateConnectorAuthorizationReferences([
        connector("Example"),
        connector("Other", "Connectors.Example.Read", "Connectors.Other.Write"),
      ], auth).errors,
    ).toEqual(expect.arrayContaining([
      expect.stringContaining('authorization.roles.write references "Connectors.Other.Write"'),
      expect.stringContaining('write role "Connectors.Other.Write" must be a client-role composite'),
      expect.stringContaining('Connector role "Connectors.Example.Read" is shared'),
    ]));
  });
});
