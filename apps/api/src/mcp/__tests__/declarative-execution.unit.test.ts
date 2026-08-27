// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for the declarative execution primitives: template
 * resolution, auth construction (the only place secrets may surface),
 * mapping/extraction, and one full binding execution against an injected
 * fetch — including the egress and secret-placement rules.
 */
import { describe, expect, it } from "bun:test";
import {
  applyMapping,
  buildAuthHeaders,
  executeBinding,
  extractPath,
  orderedBindings,
  resolveTemplate,
  splitConnectionValues,
} from "../declarative-execution.js";
import { encryptSecret, keyringFromEnv } from "../../connectors/secrets.js";

const KEYRING = keyringFromEnv(`test:${Buffer.alloc(32, 9).toString("base64")}`)!;

describe("resolveTemplate", () => {
  it("substitutes known keys and fails closed on unknown ones", () => {
    expect(resolveTemplate("https://{sub}.example.com", { sub: "acme" }, "t")).toBe(
      "https://acme.example.com",
    );
    expect(() => resolveTemplate("https://{missing}.example.com", {}, "t")).toThrow(
      /"\{missing\}"/,
    );
  });
});

describe("buildAuthHeaders", () => {
  it("builds basic auth from a template username and secret password", () => {
    const headers = buildAuthHeaders(
      { scheme: "basic", usernameTemplate: "{email}/token", passwordFrom: "apiToken" },
      { email: "agent@example.com" },
      { apiToken: "tok-1" },
    );
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("agent@example.com/token:tok-1").toString("base64")}`,
    );
  });

  it("supports bearer and named-header schemes, refuses hostile header names", () => {
    expect(buildAuthHeaders({ scheme: "bearer", tokenFrom: "t" }, {}, { t: "x" })).toEqual({
      authorization: "Bearer x",
    });
    expect(
      buildAuthHeaders({ scheme: "header", headerName: "X-Api-Key", tokenFrom: "t" }, {}, { t: "x" }),
    ).toEqual({ "x-api-key": "x" });
    expect(() =>
      buildAuthHeaders({ scheme: "header", headerName: "Bad\r\nHeader", tokenFrom: "t" }, {}, { t: "x" }),
    ).toThrow(/not a valid header name/);
  });

  it("fails closed on a missing connection value and passes through no scheme", () => {
    expect(() =>
      buildAuthHeaders({ scheme: "bearer", tokenFrom: "absent" }, {}, {}),
    ).toThrow(/"absent"/);
    expect(buildAuthHeaders(null, {}, {})).toEqual({});
  });
});

describe("mapping helpers", () => {
  it("applies from/to mappings and passes through when absent", () => {
    expect(applyMapping({ a: 1, b: 2 }, [{ from: "a", to: "x" }])).toEqual({ x: 1 });
    expect(applyMapping({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it("extracts dot paths", () => {
    expect(extractPath({ data: { tickets: [1] } }, "data.tickets")).toEqual([1]);
    expect(extractPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(extractPath({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it("orders bindings and refuses an empty set", () => {
    expect(
      orderedBindings({ bindings: [{ order: 2, id: "b" }, { order: 1, id: "a" }] }, "bindings").map(
        (binding) => binding.id,
      ),
    ).toEqual(["a", "b"]);
    expect(() => orderedBindings({ bindings: [] }, "bindings")).toThrow(/no bindings/);
  });
});

describe("executeBinding", () => {
  const providerRow = {
    transport: "rest",
    baseUrlTemplate: "https://{subdomain}.example.com",
    auth: { scheme: "bearer", tokenFrom: "apiToken" },
    egressHosts: ["acme.example.com"],
  };
  const connectionValues = {
    subdomain: "acme",
    apiToken: encryptSecret(KEYRING, "erp.providers", "apiToken", "tok-9"),
  };

  const fetchSpy = (): { calls: { url: string; init: RequestInit }[]; impl: typeof fetch } => {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ data: { ticket: { number: 42 } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { calls, impl };
  };

  it("executes a REST operation with mapped inputs, auth, and response mapping", async () => {
    const spy = fetchSpy();
    const outputs = await executeBinding({
      binding: {
        inputMapping: [{ from: "query", to: "q" }],
        outputMapping: [{ from: "number", to: "ticketNumber" }],
      },
      operationRow: {
        key: "search",
        operation: { method: "GET", pathTemplate: "/api/search" },
        responseMapping: {
          rootPath: "data.ticket",
          fieldPaths: [{ field: "number", path: "number" }],
        },
      },
      providerRow,
      connectionValues,
      serviceInputs: { query: "printer" },
      keyring: KEYRING,
      fetchImpl: spy.impl,
      secretScope: "erp.providers",
    });
    expect(outputs).toEqual({ ticketNumber: 42 });
    expect(spy.calls[0]?.url).toBe("https://acme.example.com/api/search?q=printer");
    const headers = spy.calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok-9");
  });

  it("refuses a host outside the egress allow-list before any request", async () => {
    const spy = fetchSpy();
    await expect(
      executeBinding({
        binding: {},
        operationRow: { operation: { method: "GET", pathTemplate: "/x" } },
        providerRow: { ...providerRow, egressHosts: ["other.example.com"] },
        connectionValues,
        serviceInputs: {},
        keyring: KEYRING,
        fetchImpl: spy.impl,
        secretScope: "erp.providers",
      }),
    ).rejects.toThrow(/egress allow-list/);
    expect(spy.calls).toEqual([]);
  });

  it("never lets a secret reach a URL position", async () => {
    const spy = fetchSpy();
    await expect(
      executeBinding({
        binding: {},
        operationRow: { operation: { method: "GET", pathTemplate: "/x/{apiToken}" } },
        providerRow,
        connectionValues,
        serviceInputs: {},
        keyring: KEYRING,
        fetchImpl: spy.impl,
        secretScope: "erp.providers",
      }),
    ).rejects.toThrow(/"\{apiToken\}"/);
    expect(spy.calls).toEqual([]);
  });

  it("splits connection values by sensitivity", () => {
    const { plain, secret } = splitConnectionValues(connectionValues, (stored, field) =>
      field === "apiToken" ? "tok-9" : "",
    );
    expect(plain).toEqual({ subdomain: "acme" });
    expect(secret).toEqual({ apiToken: "tok-9" });
  });
});
