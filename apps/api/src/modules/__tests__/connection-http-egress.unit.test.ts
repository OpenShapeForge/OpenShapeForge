// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import {
  isPublicAddress,
  requestConnectionHttp,
} from "../connection-http-egress.js";
import type {
  ModuleConnectionHttpRequest,
  ModuleEgressRequest,
  ModuleSocketGrant,
  RuntimeModule,
} from "../contract.js";
import { mintSocketGrant, socketAllowed } from "../socket-egress.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "22222222-2222-4222-8222-222222222222";
const SECRET_PATH = "/tenant-secret-path?token=fake-url-value";
const FAKE_AUTHORIZATION = "Bearer fake-test-value";

function session(overrides: Partial<TrustedSessionContext> = {}): TrustedSessionContext {
  return {
    tenantId: TENANT,
    userId: "person-a",
    roles: [],
    groups: [],
    scope: "self",
    credential: "bearer",
    ...overrides,
  } as TrustedSessionContext;
}

function grantFor(owner: TrustedSessionContext, expiresAtMs = Date.now() + 60_000): ModuleSocketGrant {
  return mintSocketGrant({
    allowlist: ["mcp.example.com", "*.apps.example.com", "10.0.0.8"],
    adapterKey: "external-mcp",
    adapterName: "external-mcp",
    tenantId: owner.tenantId,
    binding: {
      session: owner,
      connectionId: CONNECTION,
      connectionTable: "connections",
      ownerUserId: owner.userId,
      expiresAtMs,
    },
  });
}

const call = (overrides: Partial<ModuleConnectionHttpRequest> = {}): ModuleConnectionHttpRequest => ({
  url: "https://mcp.example.com/rpc",
  json: { jsonrpc: "2.0", id: 1, method: "tools/call" },
  ...overrides,
});

function harness(respond: (request: ModuleEgressRequest) => Promise<Response> = async () =>
  Response.json({ ok: true })) {
  const seen: ModuleEgressRequest[] = [];
  const owner: NonNullable<RuntimeModule["egress"]> = {
    pinsResolvedAddresses: true,
    fetch: (request) => {
      seen.push(request);
      return respond(request);
    },
  };
  const dependencies = {
    owner,
    transport: (async () => {
      throw new Error("The test owner handles every request.");
    }) as unknown as typeof fetch,
    resolve: async () => ["93.184.216.34"],
    production: true,
  };
  return { seen, owner, dependencies };
}

const failureName = (pending: Promise<unknown>) =>
  pending.then(() => undefined, (error: unknown) => (error as Error).name);

describe("grant-bound connection HTTP", () => {
  it("sends one POST and returns a bounded JSON body", async () => {
    const live = session();
    const { seen, dependencies } = harness(async () => Response.json(
      { ok: true },
      { headers: { "mcp-session-id": "upstream", "set-cookie": "a=b" } },
    ));
    const response = await requestConnectionHttp(live, grantFor(live), call({
      headers: { authorization: FAKE_AUTHORIZATION },
      exposeHeaders: ["Mcp-Session-Id", "Set-Cookie"],
    }), dependencies);

    expect(response).toMatchObject({ status: 200, format: "json", body: '{"ok":true}' });
    expect(response.headers).toEqual({ "mcp-session-id": "upstream" });
    expect(seen).toHaveLength(1);
    const sent = seen[0]!;
    expect(sent.resolvedAddresses).toEqual(["93.184.216.34"]);
    expect(sent.allowlist).toContain("mcp.example.com");
    expect(sent.purpose).toBe("provider");
    expect(sent.scope).toMatchObject({ tenantId: TENANT, actorId: "person-a", provider: "external-mcp", kind: "mutation" });
    expect(sent.init.method).toBe("POST");
    expect(sent.init.redirect).toBe("manual");
    expect(new Headers(sent.init.headers).get("content-type")).toBe("application/json");
  });

  it("returns a finite SSE body and drops an unknown content type", async () => {
    const live = session();
    const sse = await requestConnectionHttp(live, grantFor(live), call(), harness(async () =>
      new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream; charset=utf-8" } })).dependencies);
    expect(sse).toMatchObject({ format: "sse", body: "data: {}\n\n" });

    let cancelled = false;
    const other = await requestConnectionHttp(live, grantFor(live), call(), harness(async () =>
      new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401, headers: { "content-type": "text/html" } })).dependencies);
    expect(other).toMatchObject({ status: 401, format: null, body: "" });
    expect(cancelled).toBe(true);
  });

  it("admits granted hosts and refuses the rest before any network step", async () => {
    const live = session();
    const { seen, dependencies } = harness();
    let lookups = 0;
    const counted = { ...dependencies, resolve: async () => { lookups += 1; return ["93.184.216.34"]; } };

    await requestConnectionHttp(live, grantFor(live), call({ url: "https://a.apps.example.com/rpc" }), counted);
    expect(seen).toHaveLength(1);
    expect(lookups).toBe(1);
    for (const url of [
      "https://evil.example.org/rpc",
      "https://mcp.example.com.evil.example.org/rpc",
      "https://a.b.apps.example.com/rpc",
    ]) {
      await expect(requestConnectionHttp(live, grantFor(live), call({ url }), counted))
        .rejects.toMatchObject({ code: "EGRESS_DENIED" });
    }
    expect(seen).toHaveLength(1);
    expect(lookups).toBe(1);
  });

  it("refuses plain HTTP, URL credentials and platform-owned headers", async () => {
    const live = session();
    const { seen, dependencies } = harness();
    for (const request of [
      call({ url: "http://mcp.example.com/rpc" }),
      call({ url: "https://user:fake@mcp.example.com/rpc" }),
      call({ url: "not a url" }),
      call({ headers: { host: "internal.example.com" } }),
      call({ headers: { "Transfer-Encoding": "chunked" } }),
      call({ headers: { "x-bad": "a\r\nb" } }),
      call({ json: undefined }),
    ]) {
      await expect(requestConnectionHttp(live, grantFor(live), request, dependencies))
        .rejects.toMatchObject({ code: "EGRESS_DENIED" });
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses a missing, forged or copied grant", async () => {
    const live = session();
    const { seen, dependencies } = harness();
    const genuine = grantFor(live);
    const unbound = mintSocketGrant({
      allowlist: ["mcp.example.com"],
      adapterKey: "external-mcp",
      adapterName: "external-mcp",
      tenantId: TENANT,
    });
    for (const forged of [
      undefined,
      {},
      { allowlist: ["mcp.example.com"], session: live },
      { ...genuine },
      Object.create(genuine),
      unbound,
    ]) {
      await expect(requestConnectionHttp(live, forged as unknown as ModuleSocketGrant, call(), dependencies))
        .rejects.toMatchObject({ code: "EGRESS_DENIED" });
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses foreign tenant, person and session replay, and a grant past its expiry", async () => {
    const live = session();
    const { seen, dependencies } = harness();
    const grant = grantFor(live);
    for (const foreign of [
      session({ tenantId: "33333333-3333-4333-8333-333333333333" }),
      session({ userId: "person-b" }),
      session(),
    ]) {
      await expect(requestConnectionHttp(foreign, grant, call(), dependencies))
        .rejects.toMatchObject({ code: "EGRESS_DENIED" });
    }
    await expect(requestConnectionHttp(live, grantFor(live, 1_000), call(), { ...dependencies, now: () => 1_000 }))
      .rejects.toMatchObject({ code: "EGRESS_DENIED" });
    expect(seen).toHaveLength(0);
  });

  it("requires a freshly resolved grant for each exchange", async () => {
    const live = session();
    const { seen, dependencies } = harness();
    const grant = grantFor(live);
    await requestConnectionHttp(live, grant, call(), dependencies);
    await expect(requestConnectionHttp(live, grant, call(), dependencies))
      .rejects.toMatchObject({ code: "EGRESS_DENIED" });
    expect(seen).toHaveLength(1);
  });

  it("classifies public and non-public addresses", () => {
    for (const address of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) {
      expect(isPublicAddress(address)).toBe(true);
    }
    for (const address of [
      "0.0.0.0", "10.0.0.8", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1",
      "172.31.255.255", "192.168.1.1", "198.18.0.1", "203.0.113.5", "224.0.0.1", "255.255.255.255",
      "::", "::1", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
      "::ffff:8.8.8.8", "64:ff9b::a00:1", "2001:db8::1", "2002:7f00:1::", "2001:0:4136::1",
      "mcp.example.com", "",
    ]) {
      expect(isPublicAddress(address)).toBe(false);
    }
  });

  it("refuses literal private hosts and names with any private answer", async () => {
    const live = session();
    const { seen, dependencies } = harness();
    // Granted by the Adapter, and still refused: the grant names a host, not a network.
    await expect(requestConnectionHttp(live, grantFor(live), call({ url: "https://10.0.0.8/rpc" }), dependencies))
      .rejects.toMatchObject({ code: "EGRESS_DENIED" });
    for (const answers of [["127.0.0.1"], ["93.184.216.34", "10.0.0.8"], ["::ffff:7f00:1"]]) {
      await expect(requestConnectionHttp(live, grantFor(live), call(), { ...dependencies, resolve: async () => answers }))
        .rejects.toMatchObject({ code: "EGRESS_DENIED" });
    }
    expect(seen).toHaveLength(0);
  });

  it("does not reach the transport when a name does not resolve", async () => {
    const live = session();
    const { seen, dependencies } = harness();
    for (const resolve of [async () => [], async () => { throw new Error(`lookup failed for ${SECRET_PATH}`); }]) {
      const failure = await requestConnectionHttp(live, grantFor(live), call(), { ...dependencies, resolve }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "PROVIDER_ERROR" });
      expect(String((failure as Error).message)).not.toContain(SECRET_PATH);
    }
    expect(seen).toHaveLength(0);
  });

  it("requires a pinning owner in every environment and never falls back to a bare fetch", async () => {
    const live = session();
    let transported = 0;
    const transport = (async () => {
      transported += 1;
      return Response.json({});
    }) as unknown as typeof fetch;
    const resolve = async () => ["93.184.216.34"];
    const unpinned = { fetch: async () => Response.json({}) };
    for (const owner of [undefined, unpinned]) {
      await expect(requestConnectionHttp(live, grantFor(live), call(), { owner, transport, resolve, production: true }))
        .rejects.toMatchObject({ code: "EGRESS_OWNER_REQUIRED" });
    }
    expect(transported).toBe(0);

    await expect(requestConnectionHttp(live, grantFor(live), call(), { transport, resolve, production: false }))
      .rejects.toMatchObject({ code: "EGRESS_OWNER_REQUIRED" });
    expect(transported).toBe(0);
  });

  it("refuses every redirect without following it", async () => {
    const live = session();
    for (const status of [301, 302, 303, 307, 308]) {
      let cancelled = false;
      const { seen, dependencies } = harness(async () => new Response(
        new ReadableStream({ cancel() { cancelled = true; } }),
        { status, headers: { location: "https://mcp.example.com/other" } },
      ));
      await expect(requestConnectionHttp(live, grantFor(live), call(), dependencies))
        .rejects.toMatchObject({ code: "EGRESS_DENIED" });
      expect(seen).toHaveLength(1);
      expect(cancelled).toBe(true);
    }
  });

  it("makes exactly one attempt when the transport fails, and exposes nothing it said", async () => {
    const live = session();
    const { seen, dependencies } = harness(async () => {
      throw new Error(`socket closed on https://mcp.example.com${SECRET_PATH} ${FAKE_AUTHORIZATION}`);
    });
    const failure = await requestConnectionHttp(live, grantFor(live), call(), dependencies).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 502, code: "PROVIDER_ERROR" });
    expect(JSON.stringify({ message: (failure as Error).message, cause: (failure as Error).cause })).not.toMatch(/token|Bearer/);
    expect(seen).toHaveLength(1);
  });

  it("does not retry a 5xx answer", async () => {
    const live = session();
    const { seen, dependencies } = harness(async () => Response.json({}, { status: 503 }));
    await expect(requestConnectionHttp(live, grantFor(live), call(), dependencies)).resolves.toMatchObject({ status: 503 });
    expect(seen).toHaveLength(1);
  });

  it("maps owner-issued policy and timeout failures", async () => {
    const live = session();
    for (const [kind, code] of [["policy_blocked", "EGRESS_DENIED"], ["timeout", "PROVIDER_TIMEOUT"]] as const) {
      const { dependencies } = harness(async (request) => { throw request.createFailure(kind); });
      await expect(requestConnectionHttp(live, grantFor(live), call(), dependencies))
        .rejects.toMatchObject({ code });
    }
  });

  it("stops at cancellation when the transport ignores the signal", async () => {
    const live = session();
    const controller = new AbortController();
    const { seen, dependencies } = harness(() => new Promise<Response>(() => {}));
    const pending = requestConnectionHttp(live, grantFor(live), call({ signal: controller.signal }), dependencies);
    while (seen.length === 0) await Bun.sleep(1);
    controller.abort(new Error("caller reason"));
    expect(await failureName(pending)).toBe("AbortError");
    expect(seen).toHaveLength(1);
  });

  it("does not send a request that is already cancelled", async () => {
    const live = session();
    const controller = new AbortController();
    controller.abort();
    const { seen, dependencies } = harness();
    expect(await failureName(requestConnectionHttp(live, grantFor(live), call({ signal: controller.signal }), dependencies)))
      .toBe("AbortError");
    expect(seen).toHaveLength(0);
  });

  it("cancels an open SSE body at cancellation and at the deadline", async () => {
    const live = session();
    const openStream = (onCancel: () => void) => async () => new Response(
      new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("data: {}\n\n")); },
        cancel: onCancel,
      }),
      { headers: { "content-type": "text/event-stream" } },
    );

    let cancels = 0;
    const controller = new AbortController();
    const running = harness(openStream(() => { cancels += 1; }));
    const pending = requestConnectionHttp(live, grantFor(live), call({ signal: controller.signal }), running.dependencies);
    while (running.seen.length === 0) await Bun.sleep(1);
    await Bun.sleep(5);
    controller.abort();
    expect(await failureName(pending)).toBe("AbortError");
    expect(cancels).toBe(1);

    const expiring = harness(openStream(() => { cancels += 1; }));
    await expect(requestConnectionHttp(live, grantFor(live), call({ timeoutMs: 20 }), expiring.dependencies))
      .rejects.toMatchObject({ status: 504, code: "PROVIDER_TIMEOUT" });
    expect(cancels).toBe(2);
    expect(expiring.seen).toHaveLength(1);
  });

  it("enforces the response budget, and a caller cannot raise it", async () => {
    const live = session();
    const oversized = () => harness(async () => new Response("x".repeat(64), { headers: { "content-type": "application/json" } })).dependencies;
    await expect(requestConnectionHttp(live, grantFor(live), call({ maxResponseBytes: 8 }), oversized()))
      .rejects.toMatchObject({ code: "PROVIDER_RESPONSE_TOO_LARGE" });
    const hugeDeclared = harness(async () => new Response("{}", {
      headers: { "content-type": "application/json", "content-length": String(1024 * 1024 * 1024) },
    })).dependencies;
    await expect(requestConnectionHttp(live, grantFor(live), call({ maxResponseBytes: Number.MAX_SAFE_INTEGER }), hugeDeclared))
      .rejects.toMatchObject({ code: "PROVIDER_RESPONSE_TOO_LARGE" });
  });

  it("refuses a request body over the budget without sending it", async () => {
    const live = session();
    const { seen, dependencies } = harness();
    await expect(requestConnectionHttp(live, grantFor(live), call({ json: "x".repeat(5 * 1024 * 1024) }), dependencies))
      .rejects.toMatchObject({ code: "EGRESS_DENIED" });
    expect(seen).toHaveLength(0);
  });

  it("keeps the socket grant semantics of the same allow-list apart", () => {
    expect(socketAllowed("mcp.example.com", 443, ["mcp.example.com"])).toBe(false);
    expect(socketAllowed("mcp.example.com", 443, ["mcp.example.com:443"])).toBe(true);
  });
});
