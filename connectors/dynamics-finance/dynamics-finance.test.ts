// SPDX-License-Identifier: BUSL-1.1
/**
 * The Dynamics package's own behaviour, driven through the real executor.
 *
 * There is no authentication in this file because there is none in the package:
 * the platform holds the Entra application token and hands it a fetch already
 * carrying one. What the contract's client-credentials declaration produces is
 * covered by the compiler suite and, against a real database, by
 * `apps/api/src/db/__tests__/connector-oauth-flow.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { listConnectorContracts } from "../../apps/api/src/connectors/catalog.js";
import { loadConnectorPackages } from "../../apps/api/src/connectors/loader.js";
import {
  ConnectorExecutionError,
  hostAllowed,
  invokeOperation,
  type FetchLike,
} from "../../apps/api/src/connectors/executor.js";

const SLUG = "dynamics-finance";
const CONFIG = {
  environmentHost: "contoso.operations.dynamics.com",
  tenantId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  clientId: "client-abc",
};
const SECRETS = { clientSecret: "secret-abc" };

function contractFor() {
  const contract = listConnectorContracts().find((entry) => entry.slug === SLUG);
  if (!contract) throw new Error(`missing contract ${SLUG}`);
  return contract;
}

function upstream(handler: (url: URL, init?: RequestInit) => Response): {
  fetch: FetchLike;
  calls: { url: URL; init?: RequestInit }[];
} {
  const calls: { url: URL; init?: RequestInit }[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      calls.push({ url, ...(init ? { init } : {}) });
      return handler(url, init);
    },
  };
}

function operationNamed(contract: ReturnType<typeof contractFor>, key: string) {
  const operation = contract.operations.find((entry) => entry.key === key);
  if (!operation) throw new Error(`missing operation ${key}`);
  return operation;
}

async function invoke(
  key: string,
  input: Record<string, unknown>,
  stub: ReturnType<typeof upstream>,
  config: Record<string, unknown> = CONFIG,
) {
  const registry = await loadConnectorPackages([contractFor()]);
  const loaded = registry.loaded.get(SLUG);
  if (!loaded) {
    throw new Error(`Dynamics connector did not load: ${JSON.stringify(registry.failures)}`);
  }
  return invokeOperation({
    contract: loaded.contract,
    operation: operationNamed(loaded.contract, key),
    boundary: loaded.boundary,
    pkg: loaded.pkg,
    config,
    secrets: SECRETS,
    input,
    fetchImpl: stub.fetch,
  });
}

const odata = (value: unknown[], nextLink?: string) =>
  Response.json({ value, ...(nextLink ? { "@odata.nextLink": nextLink } : {}) });

describe("the contract's application-identity declaration", () => {
  test("declares client credentials, with no authorize URL", () => {
    const auth = contractFor().auth;
    expect(auth?.flow).toBe("clientCredentials");
    // There is no consent screen for one to be the start of.
    expect(auth?.authorizeUrl).toBeUndefined();
  });

  // Entra issues a token for whatever audience the scope names. Get it wrong
  // and the token is valid but rejected by the API much later.
  test("carries a scope templated from the environment", () => {
    expect(contractFor().auth?.scopes).toEqual(["https://{environmentHost}/.default"]);
  });

  // Two hosts, which no earlier connector needed: the token comes from Entra
  // and the data from the customer's own environment.
  test("reaches both Entra and the environment, production or sandbox", () => {
    const egress = contractFor().network.egress;
    expect(hostAllowed("login.microsoftonline.com", egress)).toBe(true);
    expect(hostAllowed("contoso.operations.dynamics.com", egress)).toBe(true);
    // A sandbox is two labels deep — the case `*.` could not express.
    expect(hostAllowed("contoso-uat.sandbox.operations.dynamics.com", egress)).toBe(true);
    expect(hostAllowed("evil-dynamics.com", egress)).toBe(false);
  });
});

describe("reading records", () => {
  test("builds the OData request under /data", async () => {
    const stub = upstream(() => odata([]));
    await invoke(
      "getRecords",
      { entity: "CustomersV3", select: "CustomerAccount", filter: "Name eq 'Acme'", top: 5 },
      stub,
    );
    const url = stub.calls[0]!.url;
    expect(url.host).toBe("contoso.operations.dynamics.com");
    expect(url.pathname).toBe("/data/CustomersV3");
    expect(url.searchParams.get("$select")).toBe("CustomerAccount");
    expect(url.searchParams.get("$filter")).toBe("Name eq 'Acme'");
    expect(url.searchParams.get("$top")).toBe("5");
  });

  test("returns records verbatim, whatever fields the environment defines", async () => {
    const stub = upstream(() => odata([{ CustomerAccount: "C1", Custom_Field: null }]));
    expect(await invoke("getRecords", { entity: "CustomersV3" }, stub)).toEqual({
      records: [{ CustomerAccount: "C1", Custom_Field: null }],
    });
  });

  // Dynamics reports another page as a whole URL. Extracting the token keeps
  // the next call this connector's to compose, rather than following a URL out
  // of a response body — which would be an egress decision made by the upstream.
  test("extracts the continuation token rather than following the URL", async () => {
    const stub = upstream(() =>
      odata([{ a: 1 }], "https://contoso.operations.dynamics.com/data/CustomersV3?$skiptoken=abc"),
    );
    const result = (await invoke("getRecords", { entity: "CustomersV3" }, stub)) as {
      nextSkipToken?: string;
    };
    expect(result.nextSkipToken).toBe("abc");
  });

  test("omits the token when Dynamics reports no further page", async () => {
    const stub = upstream(() => odata([{ a: 1 }]));
    const result = (await invoke("getRecords", { entity: "CustomersV3" }, stub)) as {
      nextSkipToken?: string;
    };
    expect(result.nextSkipToken).toBeUndefined();
  });

  // The trap the Exact connector hit: encodeURIComponent leaves a dot alone, so
  // a relative segment survives it and new URL() resolves the traversal. A
  // Dynamics entity is a single name, so a separator is refused outright.
  test.each([
    ["a separator", "CustomersV3/../$metadata"],
    ["parent", ".."],
    ["current", "."],
  ])("refuses an entity name containing %s", async (_label, entity) => {
    const stub = upstream(() => odata([]));
    await expect(invoke("getRecords", { entity }, stub)).rejects.toThrow(
      ConnectorExecutionError,
    );
    expect(stub.calls).toHaveLength(0);
  });

  test("surfaces an upstream failure carrying no Dynamics text", async () => {
    const stub = upstream(() => new Response("Customer C1 is blocked", { status: 403 }));
    const error = await invoke("getRecords", { entity: "CustomersV3" }, stub).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConnectorExecutionError);
    expect(String((error as Error).message)).not.toContain("Customer C1");
  });
});

describe("creating a record", () => {
  test("posts the payload and returns the created record", async () => {
    const stub = upstream(() => Response.json({ CustomerAccount: "C2" }));
    const result = await invoke(
      "createRecord",
      { entity: "CustomersV3", payload: { Name: "Acme" } },
      stub,
    );
    expect(stub.calls[0]?.init?.method).toBe("POST");
    expect(stub.calls[0]?.init?.body).toBe(JSON.stringify({ Name: "Acme" }));
    expect(result).toEqual({ record: { CustomerAccount: "C2" } });
  });

  test("treats an empty success body as an empty record", async () => {
    const stub = upstream(() => new Response("", { status: 204 }));
    expect(
      await invoke("createRecord", { entity: "CustomersV3", payload: {} }, stub),
    ).toEqual({ record: {} });
  });

  // A Dynamics data entity takes no idempotency key, so a retried POST creates
  // a second journal entry. This fails if somebody later turns retries on.
  test("is declared not retry-eligible", () => {
    const operation = operationNamed(contractFor(), "createRecord");
    expect(operation.kind).toBe("mutation");
    expect(operation.reliability.retry.eligible).toBe(false);
    expect(operation.reliability.idempotency).toBeUndefined();
  });
});
