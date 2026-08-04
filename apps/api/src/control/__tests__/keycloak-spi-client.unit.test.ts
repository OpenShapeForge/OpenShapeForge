// SPDX-License-Identifier: BUSL-1.1
/**
 * The SPI client, driven with a stub fetch so every branch is reachable without
 * a Keycloak.
 *
 * What is worth pinning here, in order of how badly it fails if it regresses:
 *   1. an unset secret THROWS rather than no-opping — the failure mode where the
 *      database half of provisioning succeeds and Keycloak never happens;
 *   2. the token is minted against the TENANT realm with client_credentials, and
 *      the operator's token is nowhere in the request;
 *   3. upstream statuses map to codes a route can present honestly — in
 *      particular, a service-account rejection is NOT the operator's 403;
 *   4. the token is cached, refreshed before expiry, and dropped on a 401 so a
 *      rotated credential is picked up without a restart.
 */
import { describe, expect, it } from "bun:test";
import {
  createKeycloakSpiClient,
  KeycloakSpiError,
  type KeycloakSpiClientConfig,
} from "../keycloak-spi-client.js";

const config: KeycloakSpiClientConfig = {
  baseUrl: "http://keycloak.test:8080",
  tenantRealm: "openshapeforge",
  clientId: "openshapeforge-auth-api",
  clientSecret: "s3cret",
};

type Call = { url: string; init: RequestInit };

/**
 * A fetch stub that answers the token endpoint from `tokenResponses` (or a
 * default 900s token) and everything else from `spiResponses`, recording every
 * call so the request itself can be asserted on.
 */
function stubFetch(options: {
  token?: () => Response;
  spi?: Array<() => Response>;
}): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  let spiIndex = 0;
  const fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/protocol/openid-connect/token")) {
      return (
        options.token?.() ??
        Response.json({ access_token: "service-account-token", expires_in: 900 })
      );
    }
    const next = options.spi?.[Math.min(spiIndex++, (options.spi?.length ?? 1) - 1)];
    return next ? next() : Response.json({ id: "acme", alias: "acme", name: "acme" });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const rootRequest = {
  alias: "acme",
  name: "acme",
  organizationLevel: "root" as const,
  organizationPath: "acme",
};

describe("credential handling", () => {
  it("throws a named error when the client secret is unset", async () => {
    const { fetch } = stubFetch({});
    const client = createKeycloakSpiClient({ ...config, clientSecret: "" }, { fetch });

    const error = (await client
      .createOrganization(rootRequest)
      .catch((caught: unknown) => caught)) as KeycloakSpiError;

    expect(error).toBeInstanceOf(KeycloakSpiError);
    expect(error.code).toBe("KEYCLOAK_SPI_UNAUTHORIZED");
    expect(error.message).toContain("KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API");
  });

  it("mints a client-credentials token against the tenant realm", async () => {
    const { fetch, calls } = stubFetch({});
    await createKeycloakSpiClient(config, { fetch }).createOrganization(rootRequest);

    const tokenCall = calls[0]!;
    expect(tokenCall.url).toBe(
      "http://keycloak.test:8080/realms/openshapeforge/protocol/openid-connect/token",
    );
    const body = String(tokenCall.init.body);
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain("client_id=openshapeforge-auth-api");
    expect(body).toContain("client_secret=s3cret");
  });

  it("presents the service-account token, and nothing else, to the SPI", async () => {
    const { fetch, calls } = stubFetch({});
    await createKeycloakSpiClient(config, { fetch }).createOrganization(rootRequest);

    const spiCall = calls[1]!;
    expect(spiCall.url).toBe(
      "http://keycloak.test:8080/realms/openshapeforge/openshapeforge/organizations",
    );
    expect((spiCall.init.headers as Record<string, string>).authorization).toBe(
      "Bearer service-account-token",
    );
  });

  it("caches the token across calls and re-mints once it has expired", async () => {
    let clock = 0;
    const { fetch, calls } = stubFetch({});
    const client = createKeycloakSpiClient(config, { fetch, now: () => clock });

    await client.createOrganization(rootRequest);
    await client.createOrganization(rootRequest);
    expect(calls.filter((call) => call.url.includes("/token")).length).toBe(1);

    // 900s lifetime minus the 30s refresh margin.
    clock = 871_000;
    await client.createOrganization(rootRequest);
    expect(calls.filter((call) => call.url.includes("/token")).length).toBe(2);
  });

  it("mints one token for concurrent calls, not one each", async () => {
    const { fetch, calls } = stubFetch({});
    const client = createKeycloakSpiClient(config, { fetch });

    await Promise.all([
      client.createOrganization(rootRequest),
      client.createOrganization(rootRequest),
      client.createOrganization(rootRequest),
    ]);

    expect(calls.filter((call) => call.url.includes("/token")).length).toBe(1);
  });

  it("drops the cached token when the SPI answers 401, so a rotation is picked up", async () => {
    const { fetch, calls } = stubFetch({
      spi: [
        () => Response.json({ error: "expired" }, { status: 401 }),
        () => Response.json({ id: "acme", alias: "acme", name: "acme" }),
      ],
    });
    const client = createKeycloakSpiClient(config, { fetch });

    await client.createOrganization(rootRequest).catch(() => undefined);
    await client.createOrganization(rootRequest);

    expect(calls.filter((call) => call.url.includes("/token")).length).toBe(2);
  });

  it("reports rejected client credentials as a deployment fault", async () => {
    const { fetch } = stubFetch({
      token: () =>
        Response.json({ error: "unauthorized_client" }, { status: 401 }),
    });

    const error = (await createKeycloakSpiClient(config, { fetch })
      .createOrganization(rootRequest)
      .catch((caught: unknown) => caught)) as KeycloakSpiError;

    expect(error.code).toBe("KEYCLOAK_SPI_UNAUTHORIZED");
    expect(error.message).toContain("unauthorized_client");
  });
});

describe("status mapping", () => {
  const codeFor = async (respond: () => Response) => {
    const { fetch } = stubFetch({ spi: [respond] });
    const error = (await createKeycloakSpiClient(config, { fetch })
      .createOrganization(rootRequest)
      .catch((caught: unknown) => caught)) as KeycloakSpiError;
    return error.code;
  };

  it("maps 400 to a caller-actionable rejection", async () => {
    expect(
      await codeFor(() =>
        Response.json(
          { error: "Sub-organization parent and root organization do not match." },
          { status: 400 },
        ),
      ),
    ).toBe("KEYCLOAK_SPI_REJECTED");
  });

  it("maps 409 to a conflict", async () => {
    expect(
      await codeFor(() =>
        Response.json(
          { error: "organizationPath is already used in this root organization." },
          { status: 409 },
        ),
      ),
    ).toBe("KEYCLOAK_SPI_CONFLICT");
  });

  it("maps 403 to a deployment fault, never the operator's 403", async () => {
    // The operator IS authorized; the platform's own service account is not.
    // Presenting this as 403 would tell an operator to fix their permissions.
    expect(await codeFor(() => new Response("", { status: 403 }))).toBe(
      "KEYCLOAK_SPI_UNAUTHORIZED",
    );
  });

  it("maps 500 and a transport failure to unavailable", async () => {
    expect(await codeFor(() => new Response("boom", { status: 500 }))).toBe(
      "KEYCLOAK_SPI_UNAVAILABLE",
    );

    const fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const error = (await createKeycloakSpiClient(config, { fetch })
      .createOrganization(rootRequest)
      .catch((caught: unknown) => caught)) as KeycloakSpiError;
    expect(error.code).toBe("KEYCLOAK_SPI_UNAVAILABLE");
  });
});

describe("request shape", () => {
  it("sends the hierarchy fields for a sub-organisation", async () => {
    const { fetch, calls } = stubFetch({
      spi: [() => Response.json({ id: "acme--emea", alias: "acme--emea" })],
    });

    const organization = await createKeycloakSpiClient(config, {
      fetch,
    }).createOrganization({
      alias: "acme--emea",
      name: "acme--emea",
      organizationLevel: "sub",
      organizationPath: "acme/emea",
      parentOrganizationId: "acme",
      rootOrganizationId: "acme",
    });

    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      alias: "acme--emea",
      name: "acme--emea",
      organizationLevel: "sub",
      organizationPath: "acme/emea",
      parentOrganizationId: "acme",
      rootOrganizationId: "acme",
    });
    expect(organization.id).toBe("acme--emea");
  });

  it("refuses a sub-organisation with no parent, and a root with one", async () => {
    const { fetch, calls } = stubFetch({});
    const client = createKeycloakSpiClient(config, { fetch });

    await expect(
      client.createOrganization({
        alias: "acme--emea",
        name: "acme--emea",
        organizationLevel: "sub",
        organizationPath: "acme/emea",
      }),
    ).rejects.toThrow(/parentOrganizationId and rootOrganizationId/);

    await expect(
      client.createOrganization({ ...rootRequest, parentOrganizationId: "acme" }),
    ).rejects.toThrow(/root organization cannot have a parentOrganizationId/);

    // Refused locally: neither reached the network.
    expect(calls.length).toBe(0);
  });

  it("fails loudly when the SPI returns no organization id", async () => {
    const { fetch } = stubFetch({ spi: [() => Response.json({ alias: "acme" })] });

    await expect(
      createKeycloakSpiClient(config, { fetch }).createOrganization(rootRequest),
    ).rejects.toThrow(/returned an organization with no id/);
  });
});
