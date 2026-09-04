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
  requestHeaderMappings,
  resolveTemplate,
  setPath,
  splitConnectionValues,
} from "../declarative-execution.js";
import {
  SecretError,
  encryptSecret,
  keyringFromEnv,
} from "../../connectors/secrets.js";
import { toHttpError } from "../../rest/http-error.js";

const KEYRING = keyringFromEnv(
  `test:${Buffer.alloc(32, 9).toString("base64")}`,
)!;
const WRONG_KEYRING = keyringFromEnv(
  `test:${Buffer.alloc(32, 8).toString("base64")}`,
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
          "if-match": '"version-1"',
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
    expect(calls[2]?.headers.get("if-match")).toBeNull();
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
    const sourceSnapshots: unknown[] = [];
    const source = {
      sourceReference: "msr1.declarative-source",
      scope: "personal" as const,
    };
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
        source,
        owner: {
          fetch: async (request) => {
            requests.push(request);
            sourceSnapshots.push(request.source);
            if (requests.length === 1) {
              // An owner can replace its local request property, but the next
              // hop is reconstructed from core's immutable dispatch.
              delete request.source;
            }
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
    expect(sourceSnapshots).toEqual([source, source]);
    expect(sourceSnapshots.every(Object.isFrozen)).toBe(true);
    expect(requests[1]).toMatchObject({
      purpose: "provider",
      source,
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
        { scheme: "header", headerName: "  X-Api-Key  ", tokenFrom: "t" },
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

  it("validates fixed authored header targets against declared scalar inputs", () => {
    const operation = {
      inputFields: [
        { key: "version", valueType: "string" },
        { key: "sequence", valueType: "integer", cardinality: "single" },
      ],
      requestMapping: {
        headers: [
          { field: "version", header: "If-Match" },
          { field: "sequence", header: "X-Sequence" },
        ],
      },
    };
    expect(requestHeaderMappings(operation, undefined)).toEqual([
      { field: "version", header: "if-match" },
      { field: "sequence", header: "x-sequence" },
    ]);
  });

  it("refuses hostile or caller-directed authored header metadata", () => {
    const operation = (headers: unknown, inputFields: unknown = [
      { key: "version", valueType: "string" },
    ]) => ({ inputFields, requestMapping: { headers } });

    expect(() => requestHeaderMappings(operation("not-an-array"), undefined))
      .toThrow(/must be an array/);
    expect(() =>
      requestHeaderMappings(
        operation([{ field: "version", header: "X-Good", headerNameField: "caller" }]),
        undefined,
      ),
    ).toThrow(/unknown option.*headerNameField/);
    expect(() =>
      requestHeaderMappings(operation([{ field: "missing", header: "If-Match" }]), undefined),
    ).toThrow(/not a declared operation input/);
    expect(() =>
      requestHeaderMappings(
        operation([{ field: "version", header: "If-Match" }], [
          { key: "version", valueType: "object" },
        ]),
        undefined,
      ),
    ).toThrow(/single scalar/);
    expect(() =>
      requestHeaderMappings(
        operation([{ field: "version", header: "If-Match" }], [
          { key: "version", valueType: "string", cardinality: "collection" },
        ]),
        undefined,
      ),
    ).toThrow(/single scalar/);
    expect(() =>
      requestHeaderMappings(operation([{ field: "version", header: "Bad Header" }]), undefined),
    ).toThrow(/valid HTTP header name/);
    expect(() =>
      requestHeaderMappings(
        operation([
          { field: "version", header: "If-Match" },
          { field: "version", header: "if-match" },
        ]),
        undefined,
      ),
    ).toThrow(/duplicates the target/);
    expect(() =>
      requestHeaderMappings(
        operation([{ field: "version", header: "X-Api-Key" }]),
        { scheme: "header", headerName: "  x-API-key  " },
      ),
    ).toThrow(/owned by configured authentication/);

    for (const header of [
      "__proto__",
      "Accept",
      "Authorization",
      "Connection",
      "Content-Length",
      "Content-Type",
      "constructor",
      "Cookie",
      "Host",
      "Keep-Alive",
      "prototype",
      "Proxy-Authenticate",
      "Proxy-Authorization",
      "Proxy-Connection",
      "TE",
      "Trailer",
      "Transfer-Encoding",
      "Upgrade",
    ]) {
      expect(() =>
        requestHeaderMappings(operation([{ field: "version", header }]), undefined),
      ).toThrow(/reserved or unsafe/);
    }
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

describe("native transport", () => {
  const nativeProvider = {
    transport: "native",
    auth: { scheme: "none" },
    egressHosts: [],
    baseUrlTemplates: {},
  };
  const nativeOperation = {
    key: "finding-create",
    operation: { nativeOperation: "finding_create" },
    responseMapping: {
      fieldPaths: [
        { field: "id", path: "id" },
        { field: "title", path: "title" },
      ],
    },
  };
  const binding = {
    inputMapping: [
      { from: "title", to: "title" },
      { from: "severity", to: "severity" },
    ],
    outputMapping: [
      { from: "id", to: "id" },
      { from: "title", to: "title" },
    ],
  };
  const serviceInputs = { target: "this-platform", title: "Native", severity: "low" };

  it("composes a NATIVE descriptor naming the generated operation and the mapped inputs", async () => {
    const request = await composeBindingRequest({
      binding,
      operationRow: nativeOperation,
      providerRow: nativeProvider,
      connectionValues: {},
      serviceInputs,
      keyring: KEYRING,
      secretScope: "erp.providers",
      mode: "describe",
    });
    expect(request.method).toBe("NATIVE");
    expect(request.url.href).toBe("osf-native:/finding_create");
    expect(request.headers).toEqual({});
    expect(JSON.parse(request.body ?? "{}")).toEqual({ title: "Native", severity: "low" });
  });

  it("runs the injected native executor instead of fetching and maps its output", async () => {
    const calls: { operationKey: string; inputs: Record<string, unknown> }[] = [];
    const spy = fetchSpyThatMustNotBeCalled();
    const outputs = await executeBinding({
      binding,
      operationRow: nativeOperation,
      providerRow: nativeProvider,
      connectionValues: {},
      serviceInputs,
      keyring: KEYRING,
      secretScope: "erp.providers",
      fetchImpl: spy.impl,
      native: async (operationKey, inputs) => {
        calls.push({ operationKey, inputs });
        return { id: "f-1", title: inputs.title, severity: inputs.severity, extra: 1 };
      },
    });
    expect(calls).toEqual([
      { operationKey: "finding_create", inputs: { title: "Native", severity: "low" } },
    ]);
    expect(outputs).toEqual({ id: "f-1", title: "Native" });
    expect(spy.calls).toBe(0);
  });

  it("refuses a native Capability without a generated operation key", async () => {
    await expect(
      executeBinding({
        binding,
        operationRow: { key: "broken", operation: { nativeOperation: "Not A Key" } },
        providerRow: nativeProvider,
        connectionValues: {},
        serviceInputs,
        keyring: KEYRING,
        secretScope: "erp.providers",
        native: async () => ({}),
      }),
    ).rejects.toThrow(/nativeOperation/);
  });

  it("fails closed when no native executor is supplied", async () => {
    await expect(
      executeBinding({
        binding,
        operationRow: nativeOperation,
        providerRow: nativeProvider,
        connectionValues: {},
        serviceInputs,
        keyring: KEYRING,
        secretScope: "erp.providers",
      }),
    ).rejects.toThrow(/Native execution is not available/);
  });

  function fetchSpyThatMustNotBeCalled(): { calls: number; impl: typeof fetch } {
    const spy = { calls: 0, impl: (async () => {
      spy.calls += 1;
      return new Response("{}");
    }) as unknown as typeof fetch };
    return spy;
  }
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

  it("does not dispatch when cancelled before declarative execution", async () => {
    const controller = new AbortController();
    controller.abort();
    let hookCalls = 0;
    await expect(
      executeBinding({
        binding: {},
        operationRow: {
          key: "search",
          operation: { method: "GET", pathTemplate: "/api/search" },
        },
        providerRow,
        connectionValues,
        serviceInputs: {},
        keyring: KEYRING,
        signal: controller.signal,
        egress: {
          owner: {
            fetch: async () => {
              hookCalls += 1;
              return new Response("{}");
            },
          },
          purpose: "provider",
          scope: {
            tenantId: "tenant-1",
            actorId: "actor-1",
            provider: "provider-1",
            operation: "search",
            kind: "query",
          },
        },
        secretScope: "erp.providers",
      }),
    ).rejects.toBe(controller.signal.reason);
    expect(hookCalls).toBe(0);
  });

  it("rejects a late egress-owner response after caller cancellation", async () => {
    const controller = new AbortController();
    let markOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      markOwnerStarted = resolve;
    });
    let releaseOwner!: () => void;
    const ownerBarrier = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const outcome = executeBinding({
      binding: {},
      operationRow: {
        key: "search",
        operation: { method: "GET", pathTemplate: "/api/search" },
      },
      providerRow,
      connectionValues,
      serviceInputs: {},
      keyring: KEYRING,
      signal: controller.signal,
      egress: {
        owner: {
          fetch: async () => {
            markOwnerStarted();
            await ownerBarrier;
            return Response.json({ accepted: true });
          },
        },
        purpose: "provider",
        scope: {
          tenantId: "tenant-1",
          actorId: "actor-1",
          provider: "provider-1",
          operation: "search",
          kind: "query",
        },
      },
      secretScope: "erp.providers",
    });

    await ownerStarted;
    controller.abort();
    releaseOwner();

    await expect(outcome).rejects.toBe(controller.signal.reason);
  });

  it("rejects a late response body after caller cancellation", async () => {
    const controller = new AbortController();
    let markBodyStarted!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve;
    });
    let releaseBody!: () => void;
    const bodyBarrier = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const outcome = executeBinding({
      binding: {},
      operationRow: {
        key: "search",
        operation: { method: "GET", pathTemplate: "/api/search" },
      },
      providerRow,
      connectionValues,
      serviceInputs: {},
      keyring: KEYRING,
      signal: controller.signal,
      egress: {
        owner: {
          fetch: async () =>
            new Response(
              new ReadableStream<Uint8Array>(
                {
                  async pull(streamController) {
                    markBodyStarted();
                    await bodyBarrier;
                    streamController.enqueue(
                      new TextEncoder().encode('{"accepted":true}'),
                    );
                    streamController.close();
                  },
                },
                { highWaterMark: 0 },
              ),
              { headers: { "content-type": "application/json" } },
            ),
        },
        purpose: "provider",
        scope: {
          tenantId: "tenant-1",
          actorId: "actor-1",
          provider: "provider-1",
          operation: "search",
          kind: "query",
        },
      },
      secretScope: "erp.providers",
    });

    await bodyStarted;
    controller.abort();
    releaseBody();

    await expect(outcome).rejects.toBe(controller.signal.reason);
  });

  it("preserves secret decryption failures as composition failures", async () => {
    const spy = fetchSpy();
    const failure = await executeBinding({
      binding: {},
      operationRow: {
        key: "search",
        operation: { method: "GET", pathTemplate: "/api/search" },
      },
      providerRow,
      connectionValues,
      serviceInputs: {},
      keyring: WRONG_KEYRING,
      fetchImpl: spy.impl,
      secretScope: "erp.providers",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SecretError);
    expect(spy.calls).toEqual([]);
  });

  it("preserves only trusted redacted module egress failure kinds", async () => {
    for (const [kind, category] of [
      ["policy_blocked", "policy_blocked"],
      ["timeout", "timeout"],
    ] as const) {
      const error = (await executeBinding({
        binding: {},
        operationRow: {
          key: "search",
          operation: { method: "GET", pathTemplate: "/api/search" },
        },
        providerRow,
        connectionValues,
        serviceInputs: {},
        keyring: KEYRING,
        egress: {
          owner: {
            fetch: async (request) => {
              throw request.createFailure(kind);
            },
          },
          purpose: "provider",
          scope: {
            tenantId: "tenant-1",
            actorId: "actor-1",
            provider: "provider-1",
            operation: "search",
            kind: "query",
          },
        },
        secretScope: "erp.providers",
      }).catch((failure: unknown) => failure)) as ProviderOutcomeError;
      expect(error.outcome.category).toBe(category);
      expect(JSON.stringify(error.outcome)).not.toContain("acme.example.com");
      expect(error.message).not.toContain("acme.example.com");
    }
  });

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

  it("composes If-Match through conditional update and delete execution", async () => {
    const spy = fetchSpy();
    const inputFields = [
      { key: "id", valueType: "string" },
      { key: "version", valueType: "string" },
      { key: "title", valueType: "string" },
      { key: "notify", valueType: "boolean" },
    ];
    const requestMapping = {
      headers: [{ field: "version", header: "If-Match" }],
      queryParams: [{ field: "notify", param: "sendUpdates" }],
      bodyPaths: [{ field: "title", path: "resource.title" }],
    };
    await executeBinding({
      binding: {},
      operationRow: {
        key: "update-record",
        operation: { method: "PATCH", pathTemplate: "/records/{id}" },
        inputFields,
        requestMapping,
      },
      providerRow,
      connectionValues,
      serviceInputs: {
        id: "record-1",
        version: '"etag-1"',
        title: "Updated",
        notify: false,
      },
      keyring: KEYRING,
      fetchImpl: spy.impl,
      secretScope: "erp.providers",
    });
    await executeBinding({
      binding: {},
      operationRow: {
        key: "delete-record",
        operation: { method: "DELETE", pathTemplate: "/records/{id}" },
        inputFields: inputFields.slice(0, 2),
        requestMapping: {
          headers: [{ field: "version", header: "If-Match" }],
        },
      },
      providerRow,
      connectionValues,
      serviceInputs: { id: "record-2", version: '"etag-2"' },
      keyring: KEYRING,
      fetchImpl: spy.impl,
      secretScope: "erp.providers",
    });

    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]?.url).toBe(
      "https://acme.example.com/records/record-1?sendUpdates=false",
    );
    expect(new Headers(spy.calls[0]?.init.headers).get("if-match")).toBe('"etag-1"');
    expect(JSON.parse(String(spy.calls[0]?.init.body))).toEqual({
      resource: { title: "Updated" },
    });
    expect(spy.calls[1]?.url).toBe("https://acme.example.com/records/record-2");
    expect(new Headers(spy.calls[1]?.init.headers).get("if-match")).toBe('"etag-2"');
    expect(spy.calls[1]?.init.body).toBeUndefined();
  });

  it("rejects non-scalar and line-breaking header values before transport", async () => {
    const spy = fetchSpy();
    const base = {
      binding: {},
      operationRow: {
        operation: { method: "DELETE", pathTemplate: "/records/1" },
        inputFields: [{ key: "version", valueType: "string" }],
        requestMapping: {
          headers: [{ field: "version", header: "If-Match" }],
        },
      },
      providerRow,
      connectionValues,
      keyring: KEYRING,
      fetchImpl: spy.impl,
      secretScope: "erp.providers",
    };
    await expect(
      executeBinding({ ...base, serviceInputs: { version: "ok\r\nX-Evil: yes" } }),
    ).rejects.toThrow(/forbidden line break/);
    await expect(
      executeBinding({ ...base, serviceInputs: { version: ["not", "scalar"] } }),
    ).rejects.toThrow(/must be a scalar value/);
    expect(spy.calls).toEqual([]);
  });

  it(
    "rejects runtime-owned, prototype-sensitive, and canonical auth collisions before transport",
    async () => {
      const spy = fetchSpy();
      const operation = (header: string) => ({
        operation: { method: "DELETE", pathTemplate: "/records/1" },
        inputFields: [{ key: "value", valueType: "string" }],
        requestMapping: { headers: [{ field: "value", header }] },
      });
      for (const header of [
        "Content-Type",
        "aCcEpT",
        "__proto__",
        "prototype",
        "constructor",
      ]) {
        await expect(
          executeBinding({
            binding: {},
            operationRow: operation(header),
            providerRow,
            connectionValues,
            serviceInputs: { value: "caller-value" },
            keyring: KEYRING,
            fetchImpl: spy.impl,
            secretScope: "erp.providers",
          }),
        ).rejects.toThrow(/reserved or unsafe/);
      }

      await expect(
        executeBinding({
          binding: {},
          operationRow: operation("X-API-KEY"),
          providerRow: {
            ...providerRow,
            auth: {
              scheme: "header",
              headerName: "  x-Api-Key  ",
              tokenFrom: "apiToken",
            },
          },
          connectionValues,
          serviceInputs: { value: "caller-value" },
          keyring: KEYRING,
          fetchImpl: spy.impl,
          secretScope: "erp.providers",
        }),
      ).rejects.toThrow(/owned by configured authentication/);
      expect(spy.calls).toEqual([]);
    },
  );

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

  it("keeps source coordination off OAuth and on the provider request", async () => {
    const requests: any[] = [];
    const source = {
      sourceReference: "msr1.provider-source",
      scope: "personal" as const,
    };
    const output = await executeBinding({
      binding: {},
      operationRow: {
        operation: { method: "GET", pathTemplate: "/items" },
      },
      providerRow: {
        transport: "rest",
        baseUrlTemplate: "https://api.example.com",
        egressHosts: ["auth.example.com", "api.example.com"],
        auth: {
          scheme: "oauth2ClientCredentials",
          tokenUrl: "https://auth.example.com/token",
        },
      },
      connectionValues: {
        clientId: "source-absence-client",
        clientSecret: "obviously-fake-secret",
      },
      serviceInputs: {},
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
        source,
        owner: {
          fetch: async (request) => {
            requests.push(request);
            return request.purpose === "oauth"
              ? Response.json({ access_token: "cc-source-token", expires_in: 3600 })
              : Response.json({ ok: true });
          },
        },
      },
      secretScope: "unused",
    });

    expect(output).toEqual({ ok: true });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.purpose).toBe("oauth");
    expect(requests[0]?.source).toBeUndefined();
    expect(requests[1]?.purpose).toBe("provider");
    expect(requests[1]?.source).toEqual(source);
  });

  it("classifies a source-free OAuth denial within its declarative invocation", async () => {
    let oauthSource: unknown = "not-called";
    const failure = (await executeBinding({
      binding: {},
      operationRow: {
        operation: { method: "GET", pathTemplate: "/items" },
      },
      providerRow: {
        transport: "rest",
        baseUrlTemplate: "https://api.example.com",
        egressHosts: ["auth.example.com", "api.example.com"],
        auth: {
          scheme: "oauth2ClientCredentials",
          tokenUrl: "https://auth.example.com/token",
        },
      },
      connectionValues: {
        clientId: "denied-source-free-client",
        clientSecret: "obviously-fake-secret",
      },
      serviceInputs: {},
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
        source: {
          sourceReference: "msr1.provider-source",
          scope: "personal",
        },
        owner: {
          fetch: async (request) => {
            oauthSource = request.source;
            throw request.createFailure("policy_blocked");
          },
        },
      },
      secretScope: "unused",
    }).catch((error: unknown) => error)) as ProviderOutcomeError;

    expect(oauthSource).toBeUndefined();
    expect(failure.outcome.category).toBe("policy_blocked");
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
    inputFields: [{ key: "version", valueType: "string" }],
    requestMapping: {
      headers: [{ field: "version", header: "If-Match" }],
    },
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
      serviceInputs: { title: "Hello", version: '"etag-1"' },
      secretScope: "unused",
      mode: "describe",
    });
    expect(composed.method).toBe("POST");
    expect(composed.url.toString()).toBe("https://acme.example.com/api/things");
    expect(composed.headers.authorization).toBe(
      "Basic <credentials from the connection>",
    );
    expect(composed.headers["if-match"]).toBe('"etag-1"');
    expect(JSON.parse(composed.body!)).toEqual({ title: "Hello" });
    expect(JSON.stringify(composed)).not.toContain("should-never-be-read");
    const repeated = await composeBindingRequest({
      binding: { order: 1 },
      operationRow,
      providerRow,
      connectionValues: {
        subdomain: "acme",
        email: "a@b.c",
        apiToken: { ciphertext: "should-never-be-read", keyId: "k" },
      },
      serviceInputs: { title: "Hello", version: '"etag-1"' },
      secretScope: "unused",
      mode: "describe",
    });
    expect(JSON.stringify(repeated)).toBe(JSON.stringify(composed));
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
        headerName: "  X-Key  ",
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
