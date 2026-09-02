// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for the declarative execution primitives: template
 * resolution, auth construction (the only place secrets may surface),
 * mapping/extraction, and one full binding execution against an injected
 * fetch — including the egress and secret-placement rules.
 */
import { describe, expect, it } from "bun:test";
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
  extractPath,
  orderedBindings,
  resolveTemplate,
  setPath,
  splitConnectionValues,
} from "../declarative-execution.js";
import { encryptSecret, keyringFromEnv } from "../../connectors/secrets.js";

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
