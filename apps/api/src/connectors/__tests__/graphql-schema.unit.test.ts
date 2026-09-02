// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import type { GraphqlContext } from "../../graphql/context.js";
import type { RuntimeModule } from "../../modules/contract.js";
import { CONNECTOR_ADMIN_ROLE } from "../authorization.js";
import { __resetConnectorRegistryForTests } from "../dispatch.js";
import { createConnectorResolvers } from "../graphql-schema.js";

afterEach(() => {
  __resetConnectorRegistryForTests();
});

describe("connector GraphQL resolver wiring", () => {
  test("passes the registered egress owner to verifyConnector", async () => {
    __resetConnectorRegistryForTests(Promise.resolve({ loaded: new Map(), failures: [] }));
    const egressOwner: NonNullable<RuntimeModule["egress"]> = {
      fetch: async () => new Response(null, { status: 204 }),
    };
    let receivedOwner: RuntimeModule["egress"] | undefined;
    const resolvers = createConnectorResolvers({
      config: { installedPackages: new Set() },
      egressOwner,
      verifyInstallation: async (context) => {
        receivedOwner = context.egressOwner;
        return { ok: true };
      },
    });
    const context = {
      db: {},
      session: {
        tenantId: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
        roles: [CONNECTOR_ADMIN_ROLE],
        groups: [],
        oauthScopes: [],
        scope: "tenant",
        credential: "bearer",
      },
    } as unknown as GraphqlContext;

    const result = await resolvers.Mutation.verifyConnector(
      null,
      { slug: "example-object-store" },
      context,
    );

    expect(result).toEqual({ ok: true });
    expect(receivedOwner).toBe(egressOwner);
  });
});
