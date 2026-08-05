// SPDX-License-Identifier: BUSL-1.1
/**
 * The Twinfield package's own behaviour, driven through the real executor.
 *
 * The generic half — boot handshake, provenance refusal, output validation,
 * egress binding — is proved once against the example connector. Everything
 * here is a decision THIS package makes that the platform cannot make for it:
 * which host an organisation's cluster resolves to, what its SOAP envelope
 * looks like, what it refuses to forward into somebody else's XML parser, how
 * it reads an outcome Twinfield reports as HTTP 200, and what it says when the
 * far end fails.
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
  hostAllowed,
  invokeOperation,
  type FetchLike,
} from "../../apps/api/src/connectors/executor.js";

const SLUG = "twinfield";
const CONFIG = {
  clusterHost: "accounting.twinfield.com",
  companyCode: "TEST001",
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

async function loadTwinfield() {
  const registry = await loadConnectorPackages([contractFor()]);
  const loaded = registry.loaded.get(SLUG);
  if (!loaded) {
    throw new Error(`Twinfield connector did not load: ${JSON.stringify(registry.failures)}`);
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
  wrapFetch?: (bound: FetchLike) => FetchLike,
) {
  const { contract, pkg, boundary } = await loadTwinfield();
  return invokeOperation({
    contract,
    operation: operationNamed(contract, key),
    boundary,
    pkg,
    config,
    secrets: SECRETS,
    input,
    fetchImpl: stub.fetch,
    ...(wrapFetch ? { wrapFetch } : {}),
  });
}

function bodyOf(call: { init?: RequestInit } | undefined): string {
  return String(call?.init?.body ?? "");
}

function headersOf(call: { init?: RequestInit } | undefined): Headers {
  return new Headers(call?.init?.headers as Record<string, string> | undefined);
}

/** A ProcessXmlDocument answer carrying `inner` as the returned document. */
const processXml = (inner: string) =>
  new Response(
    `<?xml version="1.0" encoding="utf-8"?>` +
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
      `<ProcessXmlDocumentResponse xmlns="http://www.twinfield.com/">` +
      `<ProcessXmlDocumentResult>${inner}</ProcessXmlDocumentResult>` +
      `</ProcessXmlDocumentResponse></soap:Body></soap:Envelope>`,
    { headers: { "content-type": "text/xml; charset=utf-8" } },
  );

/** A function, not a constant: a Response body may only be read once. */
const OFFICES = () =>
  processXml(
    `<offices result="1"><office name="Acme BV">TEST001</office>` +
      `<office name="Acme Holding">TEST002</office></offices>`,
  );

describe("the boot handshake", () => {
  // What the API does at startup: resolve the package and assert it is the one
  // the contract describes — slug, contract version, checksum, and the EXACT
  // operation set. A missing operation and an undeclared one both fail it, the
  // second because it is behaviour the contract never described.
  test("the package matches its contract", async () => {
    const registry = await loadConnectorPackages([contractFor()]);
    expect(registry.failures).toEqual([]);
    const loaded = registry.loaded.get(SLUG);
    expect(loaded?.pkg.slug).toBe(SLUG);
    expect([...loaded!.pkg.operations].sort()).toEqual(
      contractFor()
        .operations.map((operation) => operation.key)
        .sort(),
    );
  });
});

describe("cluster resolution", () => {
  // Twinfield does not tell the package which host to call: an organisation
  // lives on a cluster and every call after sign-in goes there. Getting this
  // wrong points an installation at a host that holds nobody's books.
  test.each([
    ["accounting.twinfield.com"],
    ["api.accounting.twinfield.com"],
    ["accounting1.twinfield.com"],
  ])("configured cluster %s is where the call goes", async (clusterHost) => {
    const stub = upstream(() => OFFICES());
    await invoke("listOffices", {}, stub, { ...CONFIG, clusterHost });
    expect(stub.calls[0]?.url.host).toBe(clusterHost);
    expect(stub.calls[0]?.url.pathname).toBe("/webservices/processxml.asmx");
  });

  test("the finder is a different service on the same cluster", async () => {
    const stub = upstream(() => new Response("<Envelope><Body/></Envelope>"));
    await invoke("search", { type: "DIM" }, stub);
    expect(stub.calls[0]?.url.href).toBe(
      "https://accounting.twinfield.com/webservices/finder.asmx",
    );
  });

  // The cost of configuring the cluster rather than discovering it: nothing
  // stops a stale installation naming a host that is not Twinfield's. Egress is
  // the backstop, and it has to be, because the package cannot ask.
  test("a cluster host outside the vendor's domain is denied by egress", async () => {
    const stub = upstream(() => OFFICES());
    const error = await invoke("listOffices", {}, stub, {
      ...CONFIG,
      clusterHost: "accounting.twinfield.com.evil.example",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorExecutionError);
    expect((error as ConnectorExecutionError).code).toBe("CONNECTOR_EGRESS_DENIED");
    expect(stub.calls).toHaveLength(0);
  });

  test("a malformed cluster host is refused before anything leaves the process", async () => {
    const stub = upstream(() => OFFICES());
    await expect(
      invoke("listOffices", {}, stub, { ...CONFIG, clusterHost: "" }),
    ).rejects.toThrow(ConnectorExecutionError);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("the egress allowlist", () => {
  // Sign-in and data are on different hosts, and the second is not a fixed one.
  // This is the assertion that fails if somebody narrows the entry to `*.`.
  test("one `**.` entry covers sign-in and every cluster shape", () => {
    const egress = contractFor().network.egress;
    expect(egress).toEqual(["**.twinfield.com"]);
    for (const host of [
      "login.twinfield.com",
      "accounting.twinfield.com",
      "api.accounting.twinfield.com",
      "api.eu.accounting.twinfield.com",
    ]) {
      expect(hostAllowed(host, egress)).toBe(true);
    }
  });

  test("`*.` would not have covered a cluster more than one label deep", () => {
    // Why the contract says `**.` — a single-label wildcard reaches
    // accounting.twinfield.com and refuses anything below it, and an
    // organisation on such a cluster would present as a Twinfield outage.
    expect(hostAllowed("accounting.twinfield.com", ["*.twinfield.com"])).toBe(true);
    expect(hostAllowed("api.accounting.twinfield.com", ["*.twinfield.com"])).toBe(false);
  });

  test("neither the apex nor a lookalike is inside it", () => {
    const egress = contractFor().network.egress;
    expect(hostAllowed("twinfield.com", egress)).toBe(false);
    expect(hostAllowed("evil-twinfield.com", egress)).toBe(false);
    expect(hostAllowed("twinfield.com.evil.example", egress)).toBe(false);
  });

  test("the OAuth endpoints live on a host the allowlist covers", () => {
    const auth = contractFor().auth;
    const egress = contractFor().network.egress;
    // The platform performs the token exchange through this same allowlist, so
    // a token endpoint outside it is a connector that can never authenticate.
    for (const endpoint of [auth?.authorizeUrl, auth?.tokenUrl]) {
      expect(hostAllowed(new URL(endpoint!).hostname, egress)).toBe(true);
    }
  });
});

describe("the SOAP envelope", () => {
  test("posts a SOAP 1.1 envelope with a quoted SOAPAction", async () => {
    const stub = upstream(() => OFFICES());
    await invoke("listOffices", {}, stub);
    const headers = headersOf(stub.calls[0]);
    expect(stub.calls[0]?.init?.method).toBe("POST");
    expect(headers.get("content-type")).toBe("text/xml; charset=utf-8");
    expect(headers.get("soapaction")).toBe('"http://www.twinfield.com/ProcessXmlDocument"');
    expect(bodyOf(stub.calls[0])).toContain(
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
    );
  });

  test("wraps the document in ProcessXmlDocument/xmlRequest", async () => {
    const stub = upstream(() => processXml('<dimension result="1"><code>1000</code></dimension>'));
    await invoke(
      "readDocument",
      { document: "<read><type>dimension</type><code>1000</code></read>" },
      stub,
    );
    expect(bodyOf(stub.calls[0])).toContain(
      '<ProcessXmlDocument xmlns="http://www.twinfield.com/">' +
        "<xmlRequest><read><type>dimension</type><code>1000</code></read></xmlRequest>" +
        "</ProcessXmlDocument>",
    );
  });

  // The difference from every OData connector here: the administration is not a
  // path segment, it is an element in the SOAP header beside the body.
  test("carries the company code in the SOAP header, not in the URL", async () => {
    const stub = upstream(() => processXml("<read/>"));
    await invoke("readDocument", { document: "<read><type>office</type></read>" }, stub);
    expect(bodyOf(stub.calls[0])).toContain(
      '<soap:Header><Header xmlns="http://www.twinfield.com/">' +
        "<CompanyCode>TEST001</CompanyCode></Header></soap:Header>",
    );
    expect(stub.calls[0]?.url.search).toBe("");
  });

  test("omits the header element entirely when no company is configured", async () => {
    const stub = upstream(() => processXml("<read/>"));
    const { companyCode, ...rest } = CONFIG as { companyCode?: string };
    void companyCode;
    await invoke("readDocument", { document: "<read/>" }, stub, rest);
    expect(bodyOf(stub.calls[0])).not.toContain("soap:Header");
  });

  // listOffices is what an operator runs BEFORE they know their code. Scoping
  // it to a single company would defeat the one operation that answers "which
  // companies can this authorization reach?".
  test("never scopes the company list to a company", async () => {
    const stub = upstream(() => OFFICES());
    await invoke("listOffices", {}, stub);
    expect(bodyOf(stub.calls[0])).not.toContain("CompanyCode");
    expect(bodyOf(stub.calls[0])).toContain("<xmlRequest><list><type>offices</type></list></xmlRequest>");
  });

  test("escapes a company code into the header rather than interpolating it", async () => {
    const stub = upstream(() => processXml("<read/>"));
    await invoke("readDocument", { document: "<read/>" }, stub, {
      ...CONFIG,
      companyCode: 'A&B"</CompanyCode>',
    });
    const body = bodyOf(stub.calls[0]);
    expect(body).toContain("<CompanyCode>A&amp;B&quot;&lt;/CompanyCode&gt;</CompanyCode>");
    // One opening tag, one closing tag: the value did not become structure.
    expect(body.match(/<CompanyCode>/g)).toHaveLength(1);
  });

  // Twinfield's SOAP header can carry an AccessToken element, and most
  // Twinfield code puts one there. This package cannot and must not: it never
  // holds the token, and the platform sets the HTTP header over anything a
  // package supplies.
  test("puts no credential in the envelope and sets no authorization header", async () => {
    const stub = upstream(() => OFFICES());
    await invoke("listOffices", {}, stub);
    expect(bodyOf(stub.calls[0])).not.toContain("AccessToken");
    expect(bodyOf(stub.calls[0])).not.toContain("secret-abc");
    expect(headersOf(stub.calls[0]).get("authorization")).toBeNull();
  });

  test("the platform's wrapper is what authenticates the call", async () => {
    const stub = upstream(() => OFFICES());
    // Mirrors withOAuthAuthorization in apps/api/src/connectors/oauth.ts, which
    // is applied outside the egress binding and sets the header over whatever a
    // package supplied.
    const withToken = (bound: FetchLike): FetchLike => async (input, init) => {
      const headers = new Headers(init?.headers as Record<string, string> | undefined);
      headers.set("authorization", "Bearer token-from-platform");
      return bound(input, { ...init, headers });
    };
    await invoke("listOffices", {}, stub, CONFIG, withToken);
    expect(headersOf(stub.calls[0]).get("authorization")).toBe("Bearer token-from-platform");
    expect(bodyOf(stub.calls[0])).not.toContain("token-from-platform");
  });
});

describe("what a document may contain", () => {
  // The document is embedded verbatim, because xmlRequest takes an element and
  // escaping it would send Twinfield text where it expects a document. These
  // are the three things that therefore cannot be forwarded.
  test.each([
    ["a DOCTYPE", "<!DOCTYPE read [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><read/>"],
    ["an XML declaration", '<?xml version="1.0"?><read/>'],
    ["a processing instruction", "<read/><?php echo 1;?>"],
    ["no element at all", "not xml"],
  ])("refuses %s", async (_label, document) => {
    const stub = upstream(() => processXml("<read/>"));
    await expect(invoke("readDocument", { document }, stub)).rejects.toThrow(
      ConnectorExecutionError,
    );
    // Refused before anything left the process, not after.
    expect(stub.calls).toHaveLength(0);
  });

  // The query/mutation split has to be enforced, not merely declared: a write
  // sent through readDocument would be retried on a timeout and would look
  // read-only to an MCP client, and a read sent through submitDocument would be
  // announced as destructive and lose its retries.
  test("readDocument refuses a document that writes", async () => {
    const stub = upstream(() => processXml("<transaction/>"));
    await expect(
      invoke("readDocument", { document: "<transaction><header/></transaction>" }, stub),
    ).rejects.toThrow(ConnectorExecutionError);
    expect(stub.calls).toHaveLength(0);
  });

  test("submitDocument refuses a document that only reads", async () => {
    const stub = upstream(() => processXml("<read/>"));
    await expect(
      invoke("submitDocument", { document: "<read><type>dimension</type></read>" }, stub),
    ).rejects.toThrow(ConnectorExecutionError);
    expect(stub.calls).toHaveLength(0);
  });

  test("accepts both read roots", async () => {
    for (const document of ["<read><type>office</type></read>", "<list><type>offices</type></list>"]) {
      const stub = upstream(() => processXml("<ok/>"));
      await invoke("readDocument", { document }, stub);
      expect(stub.calls).toHaveLength(1);
    }
  });
});

describe("the outcome Twinfield reports inside the document", () => {
  test("returns the response document verbatim", async () => {
    const stub = upstream(() =>
      processXml('<dimension result="1"><code>1000</code><name>Acme</name></dimension>'),
    );
    const result = (await invoke(
      "readDocument",
      { document: "<read><type>dimension</type></read>" },
      stub,
    )) as { document: string; succeeded: boolean; messages: string[] };
    expect(result.document).toBe(
      '<dimension result="1"><code>1000</code><name>Acme</name></dimension>',
    );
    expect(result.succeeded).toBe(true);
    expect(result.messages).toEqual([]);
  });

  // The trap this connector exists to close: Twinfield answers a REJECTED write
  // with HTTP 200 and reports the failure as an attribute inside the document.
  // A caller reading only the status books nothing and is told it worked.
  test("reports a rejected write as HTTP 200 with succeeded false", async () => {
    const stub = upstream(() =>
      processXml(
        '<transaction result="0"><header><code result="0" msg="Unknown day book">MEMO</code>' +
          "</header></transaction>",
      ),
    );
    const result = (await invoke(
      "submitDocument",
      { document: "<transaction><header><code>MEMO</code></header></transaction>" },
      stub,
    )) as { succeeded: boolean; messages: string[] };
    expect(result.succeeded).toBe(false);
    expect(result.messages).toEqual(["Unknown day book"]);
  });

  test("unescapes a message and reports each one once", async () => {
    const stub = upstream(() =>
      processXml(
        '<transaction result="0"><a result="0" msg="Value &quot;X&quot; &amp; Y"/>' +
          '<b result="0" msg="Value &quot;X&quot; &amp; Y"/></transaction>',
      ),
    );
    const result = (await invoke("submitDocument", { document: "<transaction/>" }, stub)) as {
      messages: string[];
    };
    expect(result.messages).toEqual(['Value "X" & Y']);
  });

  test("says so when the answer carries no ProcessXmlDocument result", async () => {
    const stub = upstream(
      () =>
        new Response(
          '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body/></soap:Envelope>',
        ),
    );
    await expect(invoke("readDocument", { document: "<read/>" }, stub)).rejects.toThrow(
      ConnectorExecutionError,
    );
  });
});

describe("the company list", () => {
  test("reads the code and name of each company", async () => {
    const stub = upstream(() => OFFICES());
    expect(await invoke("listOffices", {}, stub)).toEqual({
      offices: [
        { code: "TEST001", name: "Acme BV" },
        { code: "TEST002", name: "Acme Holding" },
      ],
    });
  });

  // Twinfield's office list has been described with the code as the element's
  // text and with it as an attribute. Both are read rather than returning a
  // list of blanks against the shape this deployment did not expect.
  test("reads a code carried as an attribute too", async () => {
    const stub = upstream(() =>
      processXml('<offices><office code="TEST001" name="Acme BV">Acme BV</office></offices>'),
    );
    expect(await invoke("listOffices", {}, stub)).toEqual({
      offices: [{ code: "TEST001", name: "Acme BV" }],
    });
  });

  test("answers with an empty list rather than failing when there are none", async () => {
    const stub = upstream(() => processXml('<offices result="1"/>'));
    expect(await invoke("listOffices", {}, stub)).toEqual({ offices: [] });
  });
});

describe("the finder", () => {
  const SEARCH_RESULT = (rows: string, total: string) =>
    new Response(
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
        `<SearchResponse xmlns="http://www.twinfield.com/"><SearchResult>` +
        `<TotalRows>${total}</TotalRows><Items>${rows}</Items>` +
        `</SearchResult></SearchResponse></soap:Body></soap:Envelope>`,
    );

  test("sends the finder's own operation with its defaults filled in", async () => {
    const stub = upstream(() => SEARCH_RESULT("", "0"));
    await invoke("search", { type: "DIM" }, stub);
    expect(headersOf(stub.calls[0]).get("soapaction")).toBe('"http://www.twinfield.com/Search"');
    expect(bodyOf(stub.calls[0])).toContain(
      '<Search xmlns="http://www.twinfield.com/"><type>DIM</type><pattern>*</pattern>' +
        "<field>0</field><firstRow>1</firstRow><maxRows>100</maxRows></Search>",
    );
  });

  test("passes the caller's paging and pattern through", async () => {
    const stub = upstream(() => SEARCH_RESULT("", "0"));
    await invoke(
      "search",
      { type: "DIM", pattern: "Acme*", field: 2, firstRow: 51, maxRows: 25 },
      stub,
    );
    const body = bodyOf(stub.calls[0]);
    expect(body).toContain("<pattern>Acme*</pattern>");
    expect(body).toContain("<field>2</field>");
    expect(body).toContain("<firstRow>51</firstRow>");
    expect(body).toContain("<maxRows>25</maxRows>");
  });

  test("reads one row per ArrayOfString, in column order", async () => {
    const stub = upstream(() =>
      SEARCH_RESULT(
        "<ArrayOfString><string>1000</string><string>Acme BV</string></ArrayOfString>" +
          "<ArrayOfString><string>1001</string><string>Beta &amp; Co</string></ArrayOfString>",
        "37",
      ),
    );
    expect(await invoke("search", { type: "DIM" }, stub)).toEqual({
      rows: [{ values: ["1000", "Acme BV"] }, { values: ["1001", "Beta & Co"] }],
      totalRows: 37,
    });
  });

  test("falls back to what it can see when no total is reported", async () => {
    const stub = upstream(() =>
      new Response(
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
          `<SearchResponse><SearchResult>` +
          `<ArrayOfString><string>1000</string></ArrayOfString>` +
          `</SearchResult></SearchResponse></soap:Body></soap:Envelope>`,
      ),
    );
    expect(await invoke("search", { type: "DIM" }, stub)).toEqual({
      rows: [{ values: ["1000"] }],
      totalRows: 1,
    });
  });
});

describe("error redaction", () => {
  test("an HTTP failure carries no Twinfield text", async () => {
    const stub = upstream(
      () =>
        new Response("Customer 1001 at Acme BV is blocked", {
          status: 403,
          statusText: "Forbidden",
        }),
    );
    const error = await invoke("listOffices", {}, stub).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorExecutionError);
    expect(String((error as Error).message)).not.toContain("Customer 1001");
    expect(String((error as Error).message)).not.toContain("Acme BV");
  });

  // A SOAP fault is an HTTP 200 as often as it is a 500, and its detail element
  // quotes the document that caused it — which is the caller's own data.
  test("a SOAP fault is a failure, and its detail does not escape", async () => {
    const stub = upstream(
      () =>
        new Response(
          `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
            `<soap:Fault><faultcode>soap:Server</faultcode>` +
            `<faultstring>Invalid company TEST001 for user jsmith</faultstring>` +
            `</soap:Fault></soap:Body></soap:Envelope>`,
          { status: 200 },
        ),
    );
    const error = await invoke("listOffices", {}, stub).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorExecutionError);
    expect(String((error as Error).message)).not.toContain("jsmith");
    expect(String((error as Error).message)).not.toContain("TEST001");
  });

  test("the client secret never reaches an error message", async () => {
    const stub = upstream(() => new Response("secret-abc", { status: 500 }));
    const error = await invoke("listOffices", {}, stub).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).not.toContain("secret-abc");
  });
});

describe("the contract's declarations", () => {
  // ProcessXmlDocument accepts no idempotency key, so a retried <transaction>
  // books a second journal entry. This is the assertion that fails if somebody
  // later "fixes" the flakiness by turning retries on.
  test("submitDocument is declared not retry-eligible", () => {
    const operation = operationNamed(contractFor(), "submitDocument");
    expect(operation.kind).toBe("mutation");
    expect(operation.reliability.retry.eligible).toBe(false);
    expect(operation.reliability.idempotency).toBeUndefined();
  });

  test("every read is a retryable query", () => {
    for (const key of ["listOffices", "readDocument", "search"]) {
      const operation = operationNamed(contractFor(), key);
      expect(operation.kind).toBe("query");
      expect(operation.reliability.retry.eligible).toBe(true);
    }
  });

  test("declares platform-owned OAuth at Twinfield's fixed sign-in host", () => {
    const auth = contractFor().auth;
    expect(auth?.type).toBe("oauth2");
    expect(auth?.flow).toBe("authorizationCode");
    expect(auth?.authorizeUrl).toBe(
      "https://login.twinfield.com/auth/authentication/connect/authorize",
    );
    expect(auth?.tokenUrl).toBe("https://login.twinfield.com/auth/authentication/connect/token");
    expect(auth?.clientSecretField).toBe("clientSecret");
  });

  // Without offline_access Twinfield issues no refresh token, and an
  // installation would need a person at a consent screen every time the access
  // token expired — which is not an integration.
  test("asks for the scope that makes a refresh token exist", () => {
    expect(contractFor().auth?.scopes).toContain("offline_access");
  });

  // If this ever became false, a package would be handed a refresh token it has
  // no way to persist — the exact failure the platform-owned lifecycle exists
  // to prevent.
  test("keeps the client secret out of the package's own secret view", () => {
    const contract = contractFor();
    expect(contract.configuration.secretFields).toEqual(["clientSecret"]);
    expect(contract.configuration.secretFields).not.toContain("platform.oauth");
  });

  test("the cluster is configuration, and constrained to the vendor's domain", () => {
    const field = contractFor().configuration.fields.find(
      (entry) => entry.key === "clusterHost",
    ) as { required?: boolean; validation?: { pattern?: string } };
    expect(field.required).toBe(true);
    const pattern = new RegExp(field.validation!.pattern!);
    expect(pattern.test("accounting.twinfield.com")).toBe(true);
    expect(pattern.test("api.accounting.twinfield.com")).toBe(true);
    expect(pattern.test("twinfield.com")).toBe(false);
    expect(pattern.test("evil-twinfield.com")).toBe(false);
    expect(pattern.test("accounting.twinfield.com.evil.example")).toBe(false);
  });
});
