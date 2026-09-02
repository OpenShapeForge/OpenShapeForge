// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for the declarative execution primitives: template
 * resolution, auth construction (the only place secrets may surface),
 * mapping/extraction, and one full binding execution against an injected
 * fetch — including the egress and secret-placement rules.
 */
import { describe, expect, it } from "bun:test";
import { ProviderOutcomeError } from "../../connectors/provider-outcome.js";
import {
  composeBindingRequest,
  describeAuthHeaders,
  acquireAuthHeaders,
  applyMapping,
  bindingSelected,
  buildAuthHeaders,
  executeBinding,
  fetchWithAllowedRedirects,
  mergeOutputs,
  operationBaseUrlTemplate,
  extractPath,
  orderedBindings,
  providerUrlTemplates,
  resolveTemplate,
  setPath,
  splitConnectionValues,
} from "../declarative-execution.js";
import { encryptSecret, keyringFromEnv } from "../../connectors/secrets.js";
import { toHttpError } from "../../rest/http-error.js";

const KEYRING = keyringFromEnv(
  `test:${Buffer.alloc(32, 9).toString("base64")}`,
)!;

describe("binding selection and mapped paths", () => {
  it("does not fan an empty selector out and rejects prototype paths", () => {
    const binding = { when: { field: "provider", equals: "alpha" } };
    expect(bindingSelected(binding, {})).toBe(true);
    expect(bindingSelected(binding, { provider: "" })).toBe(false);
    expect(bindingSelected(binding, { provider: "alpha" })).toBe(true);
    expect(() => setPath({}, "a.__proto__.polluted", "yes")).toThrow(
      /unsafe segment/,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("redirect egress", () => {
  it("rechecks the allow-list before following every redirect", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: "https://blocked.example/internal" },
      });
    }) as typeof fetch;

    await expect(
      fetchWithAllowedRedirects(
        "https://allowed.example/start",
        { method: "GET" },
        ["allowed.example"],
        fetchImpl,
      ),
    ).rejects.toThrow(/outside the egress allow-list/);
    expect(requested).toEqual(["https://allowed.example/start"]);
  });

  it("keeps same-origin credentials but strips them before an allowed cross-origin hop", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: { location: "/same" } });
      }
      if (calls.length === 2) {
        return new Response(null, {
          status: 307,
          headers: { location: "https://second.example/final" },
        });
      }
      return new Response("ok");
    }) as typeof fetch;
    await fetchWithAllowedRedirects(
      "https://allowed.example/start",
      {
        method: "GET",
        headers: {
          authorization: "Bearer fake",
          cookie: "session=fake",
          "proxy-authorization": "Basic fake",
          "x-safe": "yes",
          accept: "secret-in-accept",
        },
      },
      ["allowed.example", "second.example"],
      fetchImpl,
    );
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer fake");
    expect(calls[2]?.headers.get("authorization")).toBeNull();
    expect(calls[2]?.headers.get("cookie")).toBeNull();
    expect(calls[2]?.headers.get("proxy-authorization")).toBeNull();
    expect(calls[2]?.headers.get("x-safe")).toBeNull();
    expect(calls[2]?.headers.get("accept")).toBeNull();
  });

  it("rejects body-preserving cross-origin redirects before secrets reach the next host", async () => {
    for (const status of [307, 308]) {
      const calls: { url: string; body: BodyInit | null | undefined }[] = [];
      const fetchImpl = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        calls.push({ url: String(input), body: init?.body });
        return new Response(null, {
          status,
          headers: { location: "https://second.example/token" },
        });
      }) as typeof fetch;
      await expect(fetchWithAllowedRedirects(
        "https://allowed.example/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "client_secret=fake&refresh_token=fake",
        },
        ["allowed.example", "second.example"],
        fetchImpl,
      )).rejects.toThrow(/cannot forward a request body/);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://allowed.example/token");
    }
  });

  it("delegates every allowed redirect hop to the egress owner with sanitized headers", async () => {
    const requests: any[] = [];
    await fetchWithAllowedRedirects(
      "https://allowed.example/start",
      {
        method: "GET",
        headers: { authorization: "Bearer fake", accept: "secret-in-accept" },
      },
      ["allowed.example", "second.example"],
      (() => { throw new Error("fallback must not run"); }) as unknown as typeof fetch,
      {
        purpose: "provider",
        scope: {
          tenantId: "tenant-1",
          actorId: "actor-1",
          provider: "provider-1",
          operation: "operation-1",
          kind: "query",
        },
        owner: {
          fetch: async (request) => {
            requests.push(request);
            return requests.length === 1
              ? new Response(null, {
                  status: 302,
                  headers: { location: "https://second.example/final" },
                })
              : new Response("ok");
          },
        },
      },
    );
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.url.href)).toEqual([
      "https://allowed.example/start",
      "https://second.example/final",
    ]);
    expect(new Headers(requests[1].init.headers).get("authorization")).toBeNull();
    expect(new Headers(requests[1].init.headers).get("accept")).toBeNull();
    expect(requests[1]).toMatchObject({
      purpose: "provider",
      scope: {
        tenantId: "tenant-1",
        actorId: "actor-1",
        provider: "provider-1",
        operation: "operation-1",
        kind: "query",
      },
    });
  });
});

describe("resolveTemplate", () => {
  it("substitutes known keys and fails closed on unknown ones", () => {
    expect(
      resolveTemplate("https://{sub}.example.com", { sub: "acme" }, "t"),
    ).toBe("https://acme.example.com");
    expect(() =>
      resolveTemplate("https://{missing}.example.com", {}, "t"),
    ).toThrow(/"\{missing\}"/);
  });
});

describe("buildAuthHeaders", () => {
  it("builds basic auth from a template username and secret password", () => {
    const headers = buildAuthHeaders(
      {
        scheme: "basic",
        usernameTemplate: "{email}/token",
        passwordFrom: "apiToken",
      },
      { email: "agent@example.com" },
      { apiToken: "tok-1" },
    );
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("agent@example.com/token:tok-1").toString("base64")}`,
    );
  });

  it("supports bearer and named-header schemes, refuses hostile header names", () => {
    expect(
      buildAuthHeaders({ scheme: "bearer", tokenFrom: "t" }, {}, { t: "x" }),
    ).toEqual({
      authorization: "Bearer x",
    });
    expect(
      buildAuthHeaders(
        { scheme: "header", headerName: "X-Api-Key", tokenFrom: "t" },
        {},
        { t: "x" },
      ),
    ).toEqual({ "x-api-key": "x" });
    expect(() =>
      buildAuthHeaders(
        { scheme: "header", headerName: "Bad\r\nHeader", tokenFrom: "t" },
        {},
        { t: "x" },
      ),
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
    expect(applyMapping({ a: 1, b: 2 }, [{ from: "a", to: "x" }])).toEqual({
      x: 1,
    });
    expect(applyMapping({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it("extracts dot paths", () => {
    expect(extractPath({ data: { tickets: [1] } }, "data.tickets")).toEqual([
      1,
    ]);
    expect(extractPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(extractPath({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it("orders bindings and refuses an empty set", () => {
    expect(
      orderedBindings(
        {
          bindings: [
            { order: 2, id: "b" },
            { order: 1, id: "a" },
          ],
        },
        "bindings",
      ).map((binding) => binding.id),
    ).toEqual(["a", "b"]);
    expect(() => orderedBindings({ bindings: [] }, "bindings")).toThrow(
      /no bindings/,
    );
    expect(() =>
      orderedBindings(
        { bindings: [{ order: 1 }, { order: 1 }] },
        "bindings",
      ),
    ).toThrow(/unique integer order/);
    for (const order of [undefined, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        orderedBindings({ bindings: [{ order }] }, "bindings"),
      ).toThrow(/unique integer order/);
    }
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

  const fetchSpy = (): {
    calls: { url: string; init: RequestInit }[];
    impl: typeof fetch;
  } => {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({ data: { ticket: { number: 42 } } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
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
    expect(spy.calls[0]?.url).toBe(
      "https://acme.example.com/api/search?q=printer",
    );
    const headers = spy.calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok-9");
  });

  it("preserves the default base URL and never lets caller input select an origin", async () => {
    const request = await composeBindingRequest({
      binding: {},
      operationRow: {
        operation: { method: "GET", pathTemplate: "/records" },
      },
      providerRow: {
        ...providerRow,
        baseUrlTemplates: { secondary: "https://secondary.example.com" },
        egressHosts: ["acme.example.com", "secondary.example.com"],
      },
      connectionValues,
      serviceInputs: { baseUrlKey: "secondary" },
      keyring: KEYRING,
      secretScope: "erp.providers",
    });
    expect(request.url.href).toBe(
      "https://acme.example.com/records?baseUrlKey=secondary",
    );
  });

  it("selects an authored named HTTPS base URL through canonical egress", async () => {
    const requests: any[] = [];
    const outputs = await executeBinding({
      binding: { outputMapping: [{ from: "number", to: "ticketNumber" }] },
      operationRow: {
        key: "search",
        operation: {
          method: "GET",
          pathTemplate: "/api/search",
          baseUrlKey: "secondary",
        },
        responseMapping: {
          rootPath: "data.ticket",
          fieldPaths: [{ field: "number", path: "number" }],
        },
      },
      providerRow: {
        ...providerRow,
        baseUrlTemplates: {
          secondary: "https://api.secondary.example.com",
        },
        egressHosts: ["api.secondary.example.com"],
      },
      connectionValues,
      serviceInputs: {},
      keyring: KEYRING,
      fetchImpl: (() => {
        throw new Error("fallback must not run");
      }) as unknown as typeof fetch,
      egress: {
        purpose: "provider",
        scope: {
          tenantId: "tenant-1",
          actorId: "actor-1",
          provider: "provider-1",
          operation: "operation-1",
          kind: "query",
        },
        owner: {
          fetch: async (request) => {
            requests.push(request);
            return new Response(
              JSON.stringify({ data: { ticket: { number: 42 } } }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        },
      },
      secretScope: "erp.providers",
    });
    expect(outputs).toEqual({ ticketNumber: 42 });
    expect(requests).toHaveLength(1);
    expect(requests[0].url.href).toBe(
      "https://api.secondary.example.com/api/search",
    );
  });

  it("rejects a named-base HTTPS downgrade before the HTTP redirect hop", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: "http://api.example.test/plain" },
      });
    }) as typeof fetch;
    await expect(
      executeBinding({
        binding: {},
        operationRow: {
          operation: {
            method: "GET",
            pathTemplate: "/start",
            baseUrlKey: "secondary",
          },
        },
        providerRow: {
          transport: "rest",
          baseUrlTemplate: "http://legacy.example.test",
          baseUrlTemplates: {
            secondary: "https://api.example.test",
          },
          egressHosts: ["api.example.test"],
        },
        connectionValues: {},
        serviceInputs: {},
        fetchImpl,
        secretScope: "unused",
      }),
    ).rejects.toThrow(/every redirect must use HTTPS/);
    expect(requested).toEqual(["https://api.example.test/start"]);
  });

  it("preserves legacy HTTP behavior for the default base URL", async () => {
    const requested: string[] = [];
    await executeBinding({
      binding: {},
      operationRow: {
        operation: { method: "GET", pathTemplate: "/legacy" },
      },
      providerRow: {
        transport: "rest",
        baseUrlTemplate: "http://legacy.example.test",
        egressHosts: ["legacy.example.test"],
      },
      connectionValues: {},
      serviceInputs: {},
      fetchImpl: (async (input: string | URL | Request) => {
        requested.push(String(input));
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
      secretScope: "unused",
    });
    expect(requested).toEqual(["http://legacy.example.test/legacy"]);
  });

  it("validates the complete named URL map before selecting or transporting", async () => {
    const cases: Array<{
      key: unknown;
      templates: unknown;
      egress?: string[];
      message: RegExp;
    }> = [
      {
        key: "missing",
        templates: { secondary: "https://secondary.example.com" },
        message: /is not declared by the adapter/,
      },
      {
        key: "secondary",
        templates: null,
        message: /must be a plain authored key-to-URL object/,
      },
      {
        key: "secondary",
        templates: new Date(0),
        message: /must be a plain authored key-to-URL object/,
      },
      {
        key: "secondary",
        templates: { secondary: "" },
        message: /must be a non-empty string/,
      },
      {
        key: "secondary",
        templates: { secondary: 7 },
        message: /must be a non-empty string/,
      },
      {
        key: "secondary",
        templates: { secondary: "not a URL" },
        message: /valid absolute HTTPS URL/,
      },
      {
        key: "secondary",
        templates: { secondary: "http://secondary.example.com" },
        message: /must use HTTPS/,
      },
      {
        key: "secondary",
        templates: { secondary: "https://{region}.example.com" },
        message: /without template placeholders/,
      },
      {
        key: "secondary",
        templates: {
          secondary: "https://secondary.example.com",
          BadKey: "https://bad.example.com",
        },
        message: /key "BadKey" must match/,
      },
      {
        key: "secondary",
        templates: {
          secondary: "https://secondary.example.com",
          constructor: "https://bad.example.com",
        },
        message: /must not be prototype-sensitive/,
      },
      {
        key: "secondary",
        templates: {
          secondary: "https://secondary.example.com",
          unsafe: "http://bad.example.com",
        },
        message: /base URL "unsafe" must use HTTPS/,
      },
      {
        key: "secondary",
        templates: { secondary: "https://secondary.example.com" },
        egress: ["elsewhere.example.com"],
        message: /egress allow-list/,
      },
    ];
    for (const testCase of cases) {
      const spy = fetchSpy();
      await expect(
        executeBinding({
          binding: {},
          operationRow: {
            operation: {
              method: "GET",
              pathTemplate: "/x",
              baseUrlKey: testCase.key,
            },
          },
          providerRow: {
            ...providerRow,
            baseUrlTemplates: testCase.templates,
            egressHosts: testCase.egress ?? ["secondary.example.com"],
          },
          connectionValues,
          serviceInputs: {},
          keyring: KEYRING,
          fetchImpl: spy.impl,
          secretScope: "erp.providers",
        }),
      ).rejects.toThrow(testCase.message);
      expect(spy.calls).toEqual([]);
    }
  });

  it("uses the complete named-map validator during provider preflight", () => {
    expect(
      providerUrlTemplates({
        baseUrlTemplate: "https://default.example.com",
        baseUrlTemplates: {
          secondary: "https://secondary.example.com",
        },
      }),
    ).toContainEqual({
      context: "baseUrlTemplates.secondary",
      template: "https://secondary.example.com",
    });
    expect(() =>
      providerUrlTemplates({
        baseUrlTemplate: "https://default.example.com",
        baseUrlTemplates: {
          secondary: "https://secondary.example.com",
          unsafe: "https://{secretHost}.example.com",
        },
      }),
    ).toThrow(/without template placeholders/);
    expect(() =>
      operationBaseUrlTemplate(
        { baseUrlTemplate: "https://default.example.com" },
        { baseUrlKey: "toString" },
      ),
    ).toThrow(/is not declared by the adapter/);
  });

  it("never lets connection data choose a named origin", async () => {
    const spy = fetchSpy();
    await expect(
      executeBinding({
        binding: {},
        operationRow: {
          operation: {
            method: "GET",
            pathTemplate: "/x",
            baseUrlKey: "secondary",
          },
        },
        providerRow: {
          ...providerRow,
          baseUrlTemplates: {
            secondary: "https://{subdomain}.example.com",
          },
        },
        connectionValues: { subdomain: "attacker" },
        serviceInputs: {},
        keyring: KEYRING,
        fetchImpl: spy.impl,
        secretScope: "erp.providers",
      }),
    ).rejects.toThrow(/literal absolute HTTPS URL without template placeholders/);
    expect(spy.calls).toEqual([]);
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
        operationRow: {
          operation: { method: "GET", pathTemplate: "/x/{apiToken}" },
        },
        providerRow,
        providerDefinitions: [
          {
            key: "apiToken",
            classification: { sensitivity: "confidential" },
          },
        ],
        connectionValues,
        serviceInputs: {},
        keyring: KEYRING,
        fetchImpl: spy.impl,
        secretScope: "erp.providers",
      }),
    ).rejects.toThrow(/classified as a secret/);
    expect(spy.calls).toEqual([]);
  });

  it("splits connection values by sensitivity", () => {
    const { plain, secret } = splitConnectionValues(
      connectionValues,
      (stored, field) => (field === "apiToken" ? "tok-9" : ""),
    );
    expect(plain).toEqual({ subdomain: "acme" });
    expect(secret).toEqual({ apiToken: "tok-9" });
  });
});

describe("oauth2ClientCredentials", () => {
  it("acquires and caches a token from the egress-checked endpoint", async () => {
    const calls: { url: string; body: string }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return Response.json({ access_token: "cc-tok", expires_in: 3600 });
    }) as typeof fetch;
    const auth = {
      scheme: "oauth2ClientCredentials",
      tokenUrl: "https://auth.example.com/token",
      scopes: ["read"],
    };
    const context = {
      auth,
      plain: { clientId: "id-1" },
      secret: { clientSecret: "sec-1" },
      egress: ["auth.example.com"],
      fetchImpl: impl,
    };
    const first = await acquireAuthHeaders(context);
    const second = await acquireAuthHeaders(context);
    expect(first.authorization).toBe("Bearer cc-tok");
    expect(second.authorization).toBe("Bearer cc-tok");
    expect(calls.length).toBe(1);
    expect(calls[0]?.body).toContain("grant_type=client_credentials");
    expect(calls[0]?.body).toContain("scope=read");
  });

  it("refuses a token endpoint outside the egress allow-list", async () => {
    await expect(
      acquireAuthHeaders({
        auth: {
          scheme: "oauth2ClientCredentials",
          tokenUrl: "https://evil.example.net/token",
        },
        plain: { clientId: "id" },
        secret: { clientSecret: "sec" },
        egress: ["auth.example.com"],
        fetchImpl: fetch,
      }),
    ).rejects.toThrow(/egress allow-list/);
  });
});

describe("graphql transport", () => {
  const KEYRING2 = keyringFromEnv(
    `test:${Buffer.alloc(32, 5).toString("base64")}`,
  )!;

  it("posts the stored operation with variables and unwraps data", async () => {
    const calls: { url: string; body: string }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return Response.json({ data: { tickets: { total: 7 } } });
    }) as typeof fetch;
    const outputs = await executeBinding({
      binding: { outputMapping: [{ from: "total", to: "count" }] },
      operationRow: {
        operation: {
          graphqlOperation: "query($q:String){tickets(q:$q){total}}",
          pathTemplate: "/graphql",
        },
        responseMapping: { rootPath: "tickets" },
      },
      providerRow: {
        transport: "graphql",
        baseUrlTemplate: "https://gql.example.com",
        egressHosts: ["gql.example.com"],
      },
      connectionValues: {},
      serviceInputs: { q: "x" },
      keyring: KEYRING2,
      fetchImpl: impl,
      secretScope: "erp.providers",
    });
    expect(outputs).toEqual({ count: 7 });
    expect(calls[0]?.url).toBe("https://gql.example.com/graphql");
    expect(JSON.parse(calls[0]!.body)).toEqual({
      query: "query($q:String){tickets(q:$q){total}}",
      variables: { q: "x" },
    });
  });

  it("surfaces GraphQL errors as provider errors", async () => {
    const impl = (async () =>
      Response.json({
        errors: [{ message: "boom" }],
      })) as unknown as typeof fetch;
    await expect(
      executeBinding({
        binding: {},
        operationRow: { operation: { graphqlOperation: "query{x}" } },
        providerRow: {
          transport: "graphql",
          baseUrlTemplate: "https://gql.example.com",
          egressHosts: ["gql.example.com"],
        },
        connectionValues: {},
        serviceInputs: {},
        keyring: KEYRING2,
        fetchImpl: impl,
        secretScope: "erp.providers",
      }),
    ).rejects.toThrow(/GraphQL errors/);
  });
});

describe("cursor pagination", () => {
  it("surfaces the next-page cursor from the declared path", async () => {
    const impl = (async () =>
      Response.json({
        data: { items: [1] },
        meta: { after: "cur-2" },
      })) as unknown as typeof fetch;
    const outputs = await executeBinding({
      binding: {},
      operationRow: {
        operation: { method: "GET", pathTemplate: "/items" },
        responseMapping: { rootPath: "data" },
        pagination: { style: "cursor", cursorPath: "meta.after" },
      },
      providerRow: {
        transport: "rest",
        baseUrlTemplate: "https://api.example.com",
        egressHosts: ["api.example.com"],
      },
      connectionValues: {},
      serviceInputs: {},
      fetchImpl: impl,
      secretScope: "erp.providers",
    });
    expect(outputs.nextCursor).toBe("cur-2");
    expect(outputs.items).toEqual([1]);
  });
});

describe("composeBindingRequest (describe mode)", () => {
  const providerRow = {
    transport: "rest",
    baseUrlTemplate: "https://{subdomain}.example.com",
    egressHosts: ["*.example.com"],
    auth: {
      scheme: "basic",
      usernameTemplate: "{email}/token",
      passwordFrom: "apiToken",
    },
  };
  const operationRow = {
    key: "create-thing",
    operation: { method: "POST", pathTemplate: "/api/things" },
  };

  it("composes the full request with placeholder auth and never decrypts", async () => {
    const composed = await composeBindingRequest({
      binding: { order: 1 },
      operationRow,
      providerRow,
      connectionValues: {
        subdomain: "acme",
        email: "a@b.c",
        apiToken: { ciphertext: "should-never-be-read", keyId: "k" },
      },
      serviceInputs: { title: "Hello" },
      secretScope: "unused",
      mode: "describe",
    });
    expect(composed.method).toBe("POST");
    expect(composed.url.toString()).toBe("https://acme.example.com/api/things");
    expect(composed.headers.authorization).toBe(
      "Basic <credentials from the connection>",
    );
    expect(JSON.parse(composed.body!)).toEqual({ title: "Hello" });
    expect(JSON.stringify(composed)).not.toContain("should-never-be-read");
  });

  it("keeps egress and template rules enforced during composition", async () => {
    await expect(
      composeBindingRequest({
        binding: {},
        operationRow,
        providerRow: { ...providerRow, egressHosts: [] },
        connectionValues: { subdomain: "acme" },
        serviceInputs: {},
        secretScope: "unused",
        mode: "describe",
      }),
    ).rejects.toThrow(/egress allow-list/);
    await expect(
      composeBindingRequest({
        binding: {},
        operationRow,
        providerRow,
        connectionValues: {},
        serviceInputs: {},
        secretScope: "unused",
        mode: "describe",
      }),
    ).rejects.toThrow(/\{subdomain\}/);
  });
});

describe("describeAuthHeaders", () => {
  it("describes each scheme without values", () => {
    expect(
      describeAuthHeaders({ scheme: "bearer", tokenFrom: "apiToken" }),
    ).toEqual({
      authorization: 'Bearer <value of "apiToken" from the connection>',
    });
    expect(
      describeAuthHeaders({
        scheme: "header",
        headerName: "X-Key",
        tokenFrom: "k",
      }),
    ).toEqual({
      "x-key": '<value of "k" from the connection>',
    });
    expect(
      describeAuthHeaders({
        scheme: "oauth2ClientCredentials",
        tokenUrl: "https://t/token",
      }),
    ).toEqual({ authorization: "Bearer <token from https://t/token>" });
    expect(describeAuthHeaders(undefined)).toEqual({});
  });
});

describe("mapping honesty", () => {
  it("treats $ and $.-prefixed paths as identity and stripped", () => {
    expect(extractPath([1, 2], "$")).toEqual([1, 2]);
    expect(extractPath({ data: { items: [3] } }, "$.data.items")).toEqual([3]);
  });

  it("projects declared scalar fields from each collection element", async () => {
    const fetchImpl = (async () =>
      Response.json({
        items: [
          { id: "a", title: "First", providerOnly: "hidden-a" },
          { id: "b", title: "Second", providerOnly: "hidden-b" },
        ],
      })) as unknown as typeof fetch;

    const outputs = await executeBinding({
      binding: {},
      operationRow: {
        key: "items",
        operation: { method: "GET", pathTemplate: "/items" },
        responseMapping: {
          rootPath: "items",
          fieldPaths: [
            { field: "ids", path: "id" },
            { field: "titles", path: "title" },
          ],
        },
      },
      providerRow: {
        transport: "rest",
        baseUrlTemplate: "https://api.example.com",
        egressHosts: ["api.example.com"],
      },
      connectionValues: {},
      serviceInputs: {},
      secretScope: "unused",
      fetchImpl,
    });

    expect(outputs).toEqual({
      ids: ["a", "b"],
      titles: ["First", "Second"],
    });
  });

  it("projects nested paths and keeps missing collection values aligned", async () => {
    const fetchImpl = (async () =>
      Response.json({
        items: [
          { start: { dateTime: "2026-09-02T09:00:00Z" } },
          { id: "missing-start" },
          { start: { dateTime: "2026-09-02T10:00:00Z" } },
        ],
      })) as unknown as typeof fetch;

    const outputs = await executeBinding({
      binding: {},
      operationRow: {
        key: "items",
        operation: { method: "GET", pathTemplate: "/items" },
        responseMapping: {
          rootPath: "items",
          fieldPaths: [{ field: "starts", path: "start.dateTime" }],
        },
      },
      providerRow: {
        transport: "rest",
        baseUrlTemplate: "https://api.example.com",
        egressHosts: ["api.example.com"],
      },
      connectionValues: {},
      serviceInputs: {},
      secretScope: "unused",
      fetchImpl,
    });

    expect(outputs).toEqual({
      starts: [
        "2026-09-02T09:00:00Z",
        null,
        "2026-09-02T10:00:00Z",
      ],
    });
  });

  it("rejects a collection field path absent from every element", async () => {
    const fetchImpl = (async () =>
      Response.json({
        items: [
          { id: "a", providerOnly: "must-not-leak" },
          { id: "b", providerOnly: "must-not-leak" },
        ],
      })) as unknown as typeof fetch;

    await expect(
      executeBinding({
        binding: {},
        operationRow: {
          key: "items",
          operation: { method: "GET", pathTemplate: "/items" },
          responseMapping: {
            rootPath: "items",
            fieldPaths: [
              { field: "ids", path: "id" },
              { field: "titles", path: "title" },
            ],
          },
        },
        providerRow: {
          transport: "rest",
          baseUrlTemplate: "https://api.example.com",
          egressHosts: ["api.example.com"],
        },
        connectionValues: {},
        serviceInputs: {},
        secretScope: "unused",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: "SERVICE_MISCONFIGURED",
      message: expect.not.stringContaining("must-not-leak"),
    });
  });

  it("fails loud when a declared mapping matches nothing in a non-empty response", async () => {
    const base = {
      binding: { order: 1, outputMapping: [{ from: "events", to: "events" }] },
      providerRow: {
        transport: "rest",
        baseUrlTemplate: "https://api.example.com",
        egressHosts: ["api.example.com"],
      },
      connectionValues: {},
      serviceInputs: {},
      secretScope: "unused",
    };
    const fetchWith = (body: unknown) =>
      (async () =>
        new Response(JSON.stringify(body), {
          status: 200,
        })) as unknown as typeof fetch;

    // fieldPaths that miss everything in an object response
    await expect(
      executeBinding({
        ...base,
        operationRow: {
          key: "events",
          operation: { method: "GET", pathTemplate: "/events" },
          responseMapping: {
            rootPath: "items",
            fieldPaths: [{ field: "events", path: "nope" }],
          },
        },
        fetchImpl: fetchWith({
          items: [{ id: 1, providerOnly: "must-not-leak" }],
        }),
      }),
    ).rejects.toMatchObject({
      code: "SERVICE_MISCONFIGURED",
      message: expect.not.stringContaining("must-not-leak"),
    });

    // identity path over the extracted collection works end to end
    const outputs = await executeBinding({
      ...base,
      operationRow: {
        key: "events",
        operation: { method: "GET", pathTemplate: "/events" },
        responseMapping: {
          rootPath: "items",
          fieldPaths: [{ field: "events", path: "$" }],
        },
      },
      fetchImpl: fetchWith({ items: [{ id: 1 }, { id: 2 }] }),
    });
    expect(outputs.events).toEqual([{ id: 1 }, { id: 2 }]);

    // an outputMapping that matches nothing the operation produced
    await expect(
      executeBinding({
        ...base,
        binding: {
          order: 1,
          outputMapping: [{ from: "absent", to: "absent" }],
        },
        operationRow: {
          key: "events",
          operation: { method: "GET", pathTemplate: "/events" },
        },
        fetchImpl: fetchWith({ anything: true }),
      }),
    ).rejects.toThrow(/output mapping matched nothing/);

    // a genuinely empty result stays an empty success, not an error
    const empty = await executeBinding({
      ...base,
      binding: { order: 1 },
      operationRow: {
        key: "events",
        operation: { method: "GET", pathTemplate: "/events" },
        responseMapping: {
          rootPath: "items",
          fieldPaths: [
            { field: "ids", path: "id" },
            { field: "starts", path: "start.dateTime" },
          ],
        },
      },
      fetchImpl: fetchWith({ items: [] }),
    });
    expect(empty).toEqual({ ids: [], starts: [] });
  });
});

describe("mergeOutputs", () => {
  it("concatenates arrays under the same key and overwrites everything else", () => {
    const accumulated: Record<string, unknown> = {
      tasks: [1, 2],
      cursor: "a",
      count: 2,
    };
    mergeOutputs(accumulated, { tasks: [3], cursor: "b", extra: true });
    expect(accumulated).toEqual({
      tasks: [1, 2, 3],
      cursor: "b",
      count: 2,
      extra: true,
    });
    // A non-array meeting an array still overwrites - chains stay expressible.
    mergeOutputs(accumulated, { tasks: "done" });
    expect(accumulated.tasks).toBe("done");
  });
});

describe("declarative provider failures", () => {
  const providerRow = {
    transport: "rest",
    baseUrlTemplate: "https://api.example.com",
    egressHosts: ["api.example.com"],
  };
  const operationRow = {
    key: "search",
    operation: { method: "GET", pathTemplate: "/search" },
  };

  async function failing(status: number, headers: Record<string, string> = {}) {
    const fetchImpl = (async () =>
      new Response("provider-body token=must-not-leak", { status, headers })) as unknown as typeof fetch;
    try {
      await executeBinding({
        binding: {},
        operationRow,
        providerRow,
        connectionValues: {},
        serviceInputs: {},
        secretScope: "unused",
        fetchImpl,
      });
    } catch (error) {
      return error as ProviderOutcomeError;
    }
    throw new Error("expected provider failure");
  }

  it("reuses the canonical status taxonomy and transport statuses", async () => {
    const cases: [number, ProviderOutcomeError["code"], number][] = [
      [400, "CONNECTOR_PROVIDER_REJECTED_INPUT", 422],
      [401, "CONNECTOR_PROVIDER_AUTHORIZATION_FAILED", 502],
      [403, "CONNECTOR_PROVIDER_PERMISSION_DENIED", 403],
      [404, "CONNECTOR_UPSTREAM_ERROR", 502],
      [429, "CONNECTOR_PROVIDER_RATE_LIMITED", 429],
      [503, "CONNECTOR_PROVIDER_UNAVAILABLE", 503],
    ];
    for (const [status, code, transportStatus] of cases) {
      const error = await failing(status);
      expect(error).toBeInstanceOf(ProviderOutcomeError);
      expect(error.code).toBe(code);
      expect(error.providerStatus).toBe(status);
      expect(toHttpError(error)).toMatchObject({ status: transportStatus, body: { error: { code } } });
    }
  });

  it("retains only the canonical retry meaning and no provider text or headers", async () => {
    const error = await failing(429, {
      "retry-after": "30",
      "x-provider-request-id": "request-secret",
    });
    const rendered = JSON.stringify(toHttpError(error));
    expect(error.outcome).toMatchObject({
      category: "rate_limit",
      retryable: true,
      requiredAction: "wait",
    });
    expect(error.outcome.retryAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rendered).not.toContain("provider-body");
    expect(rendered).not.toContain("must-not-leak");
    expect(rendered).not.toContain("request-secret");
    expect(rendered).not.toContain("x-provider-request-id");
  });

  it("turns provider contract responses into the canonical generic fallback", async () => {
    const fetchImpl = (async () =>
      Response.json({ errors: [{ message: "provider-body token=must-not-leak" }] })) as unknown as typeof fetch;
    await expect(
      executeBinding({
        binding: {},
        operationRow: { key: "tickets", operation: { graphqlOperation: "query { tickets }" } },
        providerRow: { ...providerRow, transport: "graphql" },
        connectionValues: {},
        serviceInputs: {},
        secretScope: "unused",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: "CONNECTOR_UPSTREAM_ERROR",
      message: expect.not.stringContaining("must-not-leak"),
    });
  });
});
