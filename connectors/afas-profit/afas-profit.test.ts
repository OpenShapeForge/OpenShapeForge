// SPDX-License-Identifier: BUSL-1.1
/**
 * The AFAS package's own behaviour, driven through the real executor.
 *
 * `apps/api/src/connectors/__tests__/example-connector.e2e.test.ts` already
 * proves the generic half — the boot handshake, provenance refusal, output
 * validation, egress binding — against the example package. Repeating it here
 * would test the platform twice and this connector never. So everything below
 * is a decision this package makes that the platform cannot make for it: which
 * host an environment resolves to, how AFAS's positional filter triple is
 * forwarded, what `hasMore` means when the upstream reports no total, and which
 * HTTP verb an insert is.
 *
 * It lives beside the package rather than under `apps/api` because the
 * connector suites run in CI and the enumerated API unit-test paths do not include
 * `src/connectors` — a test nothing executes reads as coverage without being
 * any.
 *
 * Needs no database: nothing here touches tenant state.
 */
import { describe, expect, test } from "bun:test";
import { listConnectorContracts } from "../../apps/api/src/connectors/catalog.js";
import { loadConnectorPackages } from "../../apps/api/src/connectors/loader.js";
import {
  ConnectorExecutionError,
  invokeOperation,
  type FetchLike,
} from "../../apps/api/src/connectors/executor.js";

const SLUG = "afas-profit";

const CONFIG = { environmentId: "12345", environmentType: "production" };
const SECRETS = { token: "dGVzdC10b2tlbg==" };

function contractFor() {
  const contract = listConnectorContracts().find((entry) => entry.slug === SLUG);
  if (!contract) throw new Error(`missing contract ${SLUG}`);
  return contract;
}

/** A stub upstream that records what the connector actually sent. */
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

async function loadAfas() {
  const registry = await loadConnectorPackages([contractFor()]);
  const loaded = registry.loaded.get(SLUG);
  if (!loaded) {
    throw new Error(`AFAS connector did not load: ${JSON.stringify(registry.failures)}`);
  }
  return loaded;
}

function operationNamed(contract: ReturnType<typeof contractFor>, key: string) {
  const operation = contract.operations.find((entry) => entry.key === key);
  if (!operation) throw new Error(`missing operation ${key}`);
  return operation;
}

async function invokeGet(
  input: Record<string, unknown>,
  stub: ReturnType<typeof upstream>,
  config: Record<string, unknown> = CONFIG,
) {
  const { contract, pkg, boundary } = await loadAfas();
  return invokeOperation({
    contract,
    operation: operationNamed(contract, "getConnector"),
    boundary,
    pkg,
    config,
    secrets: SECRETS,
    input,
    fetchImpl: stub.fetch,
  });
}

const ROWS_URL = (rows: unknown[]) => Response.json({ rows });

describe("environment resolution", () => {
  // The environment letter in an AFAS environment name (O/A/T) never reaches
  // the URL; the separate environment field is what selects the host. Getting
  // this wrong points a production installation at test data, or the reverse.
  test.each([
    ["production", "12345.rest.afas.online"],
    ["accept", "12345.restaccept.afas.online"],
    ["test", "12345.resttest.afas.online"],
  ])("%s resolves to %s", async (environmentType, host) => {
    const stub = upstream(() => ROWS_URL([]));
    await invokeGet({ connectorId: "Profit_Debiteuren" }, stub, {
      ...CONFIG,
      environmentType,
    });
    expect(stub.calls[0]?.url.host).toBe(host);
  });

  test("all three hosts are inside the contract's egress allowlist", async () => {
    // The contract declares three wildcards; a missing one would surface as an
    // egress denial that looks exactly like an AFAS outage.
    const egress = contractFor().network.egress;
    expect(egress).toEqual([
      "*.rest.afas.online",
      "*.restaccept.afas.online",
      "*.resttest.afas.online",
    ]);
  });

  test("an unknown environment is refused before any request", async () => {
    const stub = upstream(() => ROWS_URL([]));
    await expect(
      invokeGet({ connectorId: "Profit_Debiteuren" }, stub, {
        ...CONFIG,
        environmentType: "staging",
      }),
    ).rejects.toThrow(ConnectorExecutionError);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("reading a GetConnector", () => {
  test("sends the AppConnector token as AFAS expects it", async () => {
    const stub = upstream(() => ROWS_URL([]));
    await invokeGet({ connectorId: "Profit_Debiteuren" }, stub);
    // Not `as HeadersInit`: that is an ambient DOM global, and this project
    // typechecks without a DOM lib. Record<string,string> is what the package
    // actually sends.
    const sent = new Headers(stub.calls[0]?.init?.headers as Record<string, string>);
    expect(sent.get("authorization")).toBe(`AfasToken ${SECRETS.token}`);
  });

  test("puts the connector id in the path and the paging in the query", async () => {
    const stub = upstream(() => ROWS_URL([]));
    await invokeGet({ connectorId: "Profit_Debiteuren", skip: 200, take: 50 }, stub);
    const url = stub.calls[0]!.url;
    expect(url.pathname).toBe("/profitrestservices/connectors/Profit_Debiteuren");
    expect(url.searchParams.get("skip")).toBe("200");
    expect(url.searchParams.get("take")).toBe("50");
  });

  // A connector id reaches the URL path, so it is encoded rather than
  // interpolated: encoding `/` is what stops a crafted id walking out of the
  // connectors segment into another endpoint.
  test("encodes a connector id that would otherwise traverse the path", async () => {
    const stub = upstream(() => ROWS_URL([]));
    await invokeGet({ connectorId: "../../profitversion" }, stub);
    expect(stub.calls[0]!.url.pathname).toBe(
      "/profitrestservices/connectors/..%2F..%2Fprofitversion",
    );
  });

  test("forwards the filter triple together", async () => {
    const stub = upstream(() => ROWS_URL([]));
    await invokeGet(
      {
        connectorId: "Profit_Debiteuren",
        filterFieldIds: "Nummer,Naam",
        filterValues: "1001,Acme",
        operatorTypes: "1,1",
      },
      stub,
    );
    const url = stub.calls[0]!.url;
    expect(url.searchParams.get("filterfieldids")).toBe("Nummer,Naam");
    expect(url.searchParams.get("filtervalues")).toBe("1001,Acme");
    expect(url.searchParams.get("operatortypes")).toBe("1,1");
  });

  // AFAS answers a values-without-fields filter with an unhelpful 400, so the
  // package declines to send the half of a triple that cannot mean anything.
  test("omits filter values when no filter fields were given", async () => {
    const stub = upstream(() => ROWS_URL([]));
    await invokeGet({ connectorId: "Profit_Debiteuren", filterValues: "1001" }, stub);
    const url = stub.calls[0]!.url;
    expect(url.searchParams.has("filtervalues")).toBe(false);
    expect(url.searchParams.has("filterfieldids")).toBe(false);
  });

  test("returns the rows verbatim, whatever columns the environment defines", async () => {
    // The contract declares `rows` as an untyped object collection precisely so
    // an environment's own column set passes output validation unchanged.
    const stub = upstream(() =>
      ROWS_URL([{ Nummer: 1001, Naam: "Acme", Vrij_veld: null }]),
    );
    const result = await invokeGet({ connectorId: "Profit_Debiteuren", take: 10 }, stub);
    expect(result).toEqual({
      rows: [{ Nummer: 1001, Naam: "Acme", Vrij_veld: null }],
      hasMore: false,
    });
  });

  // AFAS reports no total and no cursor, so a saturated page is the only
  // available signal. It over-reports by one call on an exact multiple, which
  // is the safe direction: under-reporting silently truncates a sync.
  test("reports hasMore when the page came back full", async () => {
    const stub = upstream(() => ROWS_URL([{ a: 1 }, { a: 2 }]));
    const result = (await invokeGet(
      { connectorId: "Profit_Debiteuren", take: 2 },
      stub,
    )) as { hasMore: boolean };
    expect(result.hasMore).toBe(true);
  });

  test("surfaces an upstream failure as a connector error carrying no AFAS text", async () => {
    const stub = upstream(() => new Response("Debiteur 1001 heeft geen rechten", { status: 403 }));
    const error = await invokeGet({ connectorId: "Profit_Debiteuren" }, stub).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConnectorExecutionError);
    expect(String((error as Error).message)).not.toContain("Debiteur 1001");
  });
});

describe("writing to an UpdateConnector", () => {
  async function invokeUpdate(
    input: Record<string, unknown>,
    stub: ReturnType<typeof upstream>,
  ) {
    const { contract, pkg, boundary } = await loadAfas();
    return invokeOperation({
      contract,
      operation: operationNamed(contract, "updateConnector"),
      boundary,
      pkg,
      config: CONFIG,
      secrets: SECRETS,
      input,
      fetchImpl: stub.fetch,
    });
  }

  test.each([
    ["insert", "POST"],
    ["update", "PUT"],
  ])("%s issues a %s", async (mode, method) => {
    const stub = upstream(() => Response.json({ ok: true }));
    await invokeUpdate(
      { connectorId: "KnSalesRelationOrg", mode, payload: { Element: {} } },
      stub,
    );
    expect(stub.calls[0]?.init?.method).toBe(method);
    expect(stub.calls[0]?.init?.body).toBe(JSON.stringify({ Element: {} }));
  });

  // "It worked and said nothing" is a real AFAS outcome, and the contract
  // declares `result` required — so an empty body is an empty object rather
  // than a parse failure the operator would read as a write that did not land.
  test("treats an empty success body as an empty result", async () => {
    const stub = upstream(() => new Response("", { status: 200 }));
    const result = await invokeUpdate(
      { connectorId: "KnSalesRelationOrg", mode: "update", payload: {} },
      stub,
    );
    expect(result).toEqual({ result: {} });
  });

  // The contract refuses retry eligibility because an UpdateConnector has no
  // idempotency key, and a retried POST creates a second record in an ERP.
  // This is the assertion that fails if somebody "fixes" the flakiness later.
  test("is declared not retry-eligible", () => {
    const operation = operationNamed(contractFor(), "updateConnector");
    expect(operation.kind).toBe("mutation");
    expect(operation.reliability.retry.eligible).toBe(false);
    expect(operation.reliability.idempotency).toBeUndefined();
  });
});

describe("the connectivity check", () => {
  async function verifyWith(response: Response) {
    const { pkg, contract } = await loadAfas();
    const stub = upstream(() => response);
    const verify = (pkg as unknown as {
      verify(context: unknown): Promise<{ ok: boolean; message?: string }>;
    }).verify;
    const { createBoundFetch } = await import(
      "../../apps/api/src/connectors/executor.js"
    );
    return {
      result: await verify({
        config: CONFIG,
        secrets: SECRETS,
        fetch: createBoundFetch(contract, AbortSignal.timeout(5_000), stub.fetch),
        signal: AbortSignal.timeout(5_000),
        log: () => {},
      }),
      stub,
    };
  }

  // /profitversion is authenticated but reads no business data, so an operator
  // can confirm the environment and token without a published GetConnector or
  // the rights to read one.
  test("reads /profitversion and reports success", async () => {
    const { result, stub } = await verifyWith(Response.json({ profitVersion: "1.0" }));
    expect(result.ok).toBe(true);
    expect(stub.calls[0]?.url.pathname).toBe("/profitrestservices/profitversion");
  });

  test("names a rejected token rather than reporting a generic failure", async () => {
    const { result } = await verifyWith(new Response("", { status: 401 }));
    expect(result).toEqual({ ok: false, message: "AFAS rejected the AppConnector token." });
  });
});
