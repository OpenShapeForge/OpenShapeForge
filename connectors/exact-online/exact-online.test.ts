// SPDX-License-Identifier: BUSL-1.1
/**
 * The Exact package's own behaviour, driven through the real executor.
 *
 * The generic half — boot handshake, provenance refusal, output validation,
 * egress binding — is proved once against the example connector. Everything
 * here is a decision THIS package makes that the platform cannot make for it:
 * which host a country resolves to, how a division is found when nobody
 * configured one, how Exact's OData envelope and continuation token unwrap, and
 * which of its calls may be retried.
 *
 * The OAuth half is deliberately absent, because the package is. The platform
 * hands it a fetch already carrying an access token; there is no refresh, no
 * expiry and no client secret in this file to test.
 */
import { describe, expect, test } from "bun:test";
import { listConnectorContracts } from "../../apps/api/src/connectors/catalog.js";
import { loadConnectorPackages } from "../../apps/api/src/connectors/loader.js";
import {
  ConnectorExecutionError,
  invokeOperation,
  type FetchLike,
} from "../../apps/api/src/connectors/executor.js";

const SLUG = "exact-online";
const CONFIG = { region: "nl", clientId: "client-abc", division: 123456 };
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

async function loadExact() {
  const registry = await loadConnectorPackages([contractFor()]);
  const loaded = registry.loaded.get(SLUG);
  if (!loaded) {
    throw new Error(`Exact connector did not load: ${JSON.stringify(registry.failures)}`);
  }
  return loaded;
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
  const { contract, pkg, boundary } = await loadExact();
  return invokeOperation({
    contract,
    operation: operationNamed(contract, key),
    boundary,
    pkg,
    config,
    secrets: SECRETS,
    input,
    fetchImpl: stub.fetch,
  });
}

/** Exact wraps everything in `d`, and a collection in `d.results`. */
const odata = (results: unknown[], next?: string) =>
  Response.json({ d: { results, ...(next ? { __next: next } : {}) } });

describe("country resolution", () => {
  // Exact runs a separate deployment per country with different data. Getting
  // this wrong points an installation at the wrong company's books.
  test.each([
    ["nl", "start.exactonline.nl"],
    ["be", "start.exactonline.be"],
    ["de", "start.exactonline.de"],
    ["co.uk", "start.exactonline.co.uk"],
    ["com", "start.exactonline.com"],
  ])("%s resolves to %s", async (region, host) => {
    const stub = upstream(() => odata([]));
    await invoke("getRecords", { endpoint: "crm/Accounts" }, stub, { ...CONFIG, region });
    expect(stub.calls[0]?.url.host).toBe(host);
  });

  test("every country in the contract is inside its egress allowlist", async () => {
    const contract = contractFor();
    const regions = (
      contract.configuration.fields.find((field) => field.key === "region") as {
        options?: { items?: { value: string }[] };
      }
    ).options?.items?.map((item) => item.value);
    expect(regions).toBeDefined();
    // A country the allowlist misses surfaces as an egress denial that looks
    // exactly like an Exact outage.
    for (const region of regions!) {
      expect(contract.network.egress).toContain(`*.exactonline.${region}`);
    }
  });
});

describe("the division", () => {
  test("uses the configured one without looking it up", async () => {
    const stub = upstream(() => odata([]));
    await invoke("getRecords", { endpoint: "crm/Accounts" }, stub);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url.pathname).toBe("/api/v1/123456/crm/Accounts");
  });

  // Leaving it empty has to work — an operator cannot be expected to find a
  // number in another product before the connector will run at all.
  test("resolves the current one when none is configured", async () => {
    const stub = upstream((url) =>
      url.pathname.endsWith("/current/Me")
        ? odata([{ CurrentDivision: 999, UserName: "someone" }])
        : odata([]),
    );
    const { division, ...rest } = CONFIG as { division?: number };
    void division;
    await invoke("getRecords", { endpoint: "crm/Accounts" }, stub, rest);

    expect(stub.calls[0]?.url.pathname).toBe("/api/v1/current/Me");
    expect(stub.calls[1]?.url.pathname).toBe("/api/v1/999/crm/Accounts");
  });

  test("reports the current division as its own operation", async () => {
    const stub = upstream(() => odata([{ CurrentDivision: 42, UserName: "someone" }]));
    expect(await invoke("currentDivision", {}, stub)).toEqual({
      division: 42,
      userName: "someone",
    });
  });

  test("says so when Exact reports no division at all", async () => {
    const stub = upstream(() => odata([]));
    await expect(invoke("currentDivision", {}, stub)).rejects.toThrow(
      ConnectorExecutionError,
    );
  });
});

describe("reading records", () => {
  test("asks for JSON, which Exact answers with XML without", async () => {
    const stub = upstream(() => odata([]));
    await invoke("getRecords", { endpoint: "crm/Accounts" }, stub);
    const sent = new Headers(stub.calls[0]?.init?.headers as Record<string, string>);
    expect(sent.get("accept")).toBe("application/json");
  });

  test("passes OData select, filter and top through", async () => {
    const stub = upstream(() => odata([]));
    await invoke(
      "getRecords",
      { endpoint: "crm/Accounts", select: "ID,Name", filter: "Name eq 'Acme'", top: 5 },
      stub,
    );
    const url = stub.calls[0]!.url;
    expect(url.searchParams.get("$select")).toBe("ID,Name");
    expect(url.searchParams.get("$filter")).toBe("Name eq 'Acme'");
    expect(url.searchParams.get("$top")).toBe("5");
  });

  test("unwraps the OData envelope and returns records verbatim", async () => {
    const stub = upstream(() => odata([{ ID: "a", Name: "Acme", Custom_Field: null }]));
    expect(await invoke("getRecords", { endpoint: "crm/Accounts" }, stub)).toEqual({
      records: [{ ID: "a", Name: "Acme", Custom_Field: null }],
    });
  });

  // Exact reports another page as a whole URL. Extracting the token keeps the
  // next call this connector's to compose, rather than following a URL out of a
  // response body — which would be an egress decision made by the upstream.
  test("extracts the continuation token rather than following the URL", async () => {
    const stub = upstream(() =>
      odata([{ ID: "a" }], "https://start.exactonline.nl/api/v1/1/crm/Accounts?$skiptoken=abc123"),
    );
    const result = (await invoke("getRecords", { endpoint: "crm/Accounts" }, stub)) as {
      nextSkipToken?: string;
    };
    expect(result.nextSkipToken).toBe("abc123");
  });

  test("omits the token when Exact reports no further page", async () => {
    const stub = upstream(() => odata([{ ID: "a" }]));
    const result = (await invoke("getRecords", { endpoint: "crm/Accounts" }, stub)) as {
      nextSkipToken?: string;
    };
    expect(result.nextSkipToken).toBeUndefined();
  });

  test("sends a supplied continuation token back", async () => {
    const stub = upstream(() => odata([]));
    await invoke("getRecords", { endpoint: "crm/Accounts", skipToken: "abc123" }, stub);
    expect(stub.calls[0]?.url.searchParams.get("$skiptoken")).toBe("abc123");
  });

  test("keeps a multi-segment endpoint as multiple segments", async () => {
    const stub = upstream(() => odata([]));
    await invoke("getRecords", { endpoint: "salesinvoice/SalesInvoices" }, stub);
    expect(stub.calls[0]!.url.pathname).toBe(
      "/api/v1/123456/salesinvoice/SalesInvoices",
    );
  });

  // Encoding each segment is not enough: encodeURIComponent leaves a dot alone,
  // so `..` survives it and `new URL()` then resolves the traversal. This
  // exact input reached /api/v1/Me — outside the division the caller was scoped
  // to — until the segments were refused rather than escaped.
  test.each([
    ["parent traversal", "salesinvoice/../../Me"],
    ["current directory", "salesinvoice/./SalesInvoices"],
    ["leading traversal", "../Me"],
  ])("refuses a relative path segment: %s", async (_label, endpoint) => {
    const stub = upstream(() => odata([]));
    await expect(invoke("getRecords", { endpoint }, stub)).rejects.toThrow(
      ConnectorExecutionError,
    );
    // Refused before anything left the process, not after.
    expect(stub.calls).toHaveLength(0);
  });

  test("surfaces an upstream failure carrying no Exact text", async () => {
    const stub = upstream(() => new Response("Account 1001 is blocked", { status: 403 }));
    const error = await invoke("getRecords", { endpoint: "crm/Accounts" }, stub).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConnectorExecutionError);
    expect(String((error as Error).message)).not.toContain("Account 1001");
  });
});

describe("creating a record", () => {
  test("posts the payload and unwraps the created record", async () => {
    const stub = upstream(() => Response.json({ d: { ID: "new-1" } }));
    const result = await invoke(
      "createRecord",
      { endpoint: "crm/Accounts", payload: { Name: "Acme" } },
      stub,
    );
    expect(stub.calls[0]?.init?.method).toBe("POST");
    expect(stub.calls[0]?.init?.body).toBe(JSON.stringify({ Name: "Acme" }));
    expect(result).toEqual({ record: { ID: "new-1" } });
  });

  test("treats an empty success body as an empty record", async () => {
    const stub = upstream(() => new Response("", { status: 201 }));
    expect(
      await invoke("createRecord", { endpoint: "crm/Accounts", payload: {} }, stub),
    ).toEqual({ record: {} });
  });

  // Exact's OData endpoints take no idempotency key, so a retried POST creates
  // a second invoice. This is the assertion that fails if somebody later
  // "fixes" the flakiness by turning retries on.
  test("is declared not retry-eligible", () => {
    const operation = operationNamed(contractFor(), "createRecord");
    expect(operation.kind).toBe("mutation");
    expect(operation.reliability.retry.eligible).toBe(false);
    expect(operation.reliability.idempotency).toBeUndefined();
  });

  test("respects Exact's documented per-minute budget", () => {
    const operation = operationNamed(contractFor(), "getRecords");
    expect(operation.reliability.rateLimit?.perTenantPerMinute).toBe(60);
  });
});

describe("the contract's OAuth declaration", () => {
  // The reason this connector exists in this shape at all.
  test("declares platform-owned OAuth with per-country endpoints", () => {
    const auth = contractFor().auth;
    expect(auth?.type).toBe("oauth2");
    expect(auth?.flow).toBe("authorizationCode");
    expect(auth?.authorizeUrl).toContain("{region}");
    expect(auth?.tokenUrl).toContain("{region}");
    expect(auth?.clientSecretField).toBe("clientSecret");
  });

  // If this ever became false, a package would be handed a refresh token it has
  // no way to persist — the exact failure the platform-owned lifecycle exists
  // to prevent.
  test("keeps the client secret out of the package's own secret view", () => {
    const contract = contractFor();
    expect(contract.configuration.secretFields).toEqual(["clientSecret"]);
    expect(contract.configuration.secretFields).not.toContain("platform.oauth");
  });
});
