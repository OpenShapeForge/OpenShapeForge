// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import type { ConnectorContract } from "../catalog.js";
import {
  MAX_CONNECTOR_REDIRECTS,
  createBoundFetch,
  fetchPinnedAddress,
  hostAllowed,
  isPubliclyRoutableAddress,
  type HostResolver,
  type ResolvedAddress,
  type ResolvedFetchLike,
} from "../egress.js";
import { ConnectorExecutionError } from "../errors.js";

function contract(egress = ["api.example.com", "cdn.example.com"]): ConnectorContract {
  return {
    slug: "object-store",
    network: { egress },
  } as ConnectorContract;
}

const PUBLIC_V4: ResolvedAddress = { address: "93.184.216.34", family: 4 };
const publicResolver: HostResolver = async () => [PUBLIC_V4];

type TransportCall = {
  url: URL;
  method: string;
  headers: Headers;
  body: Uint8Array | undefined;
  address: ResolvedAddress;
  signal: AbortSignal | null | undefined;
};

function transport(
  handler: (call: TransportCall, index: number) => Response,
): { fetch: ResolvedFetchLike; calls: TransportCall[] } {
  const calls: TransportCall[] = [];
  return {
    calls,
    fetch: async (url, init, address) => {
      const rawBody = init.body;
      const body =
        rawBody === undefined || rawBody === null
          ? undefined
          : rawBody instanceof Uint8Array
            ? rawBody
            : new Uint8Array(rawBody as ArrayBuffer);
      const call = {
        url: new URL(url),
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body,
        address,
        signal: init.signal,
      };
      calls.push(call);
      return handler(call, calls.length - 1);
    },
  };
}

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

function text(body: Uint8Array | undefined): string | undefined {
  return body === undefined ? undefined : new TextDecoder().decode(body);
}

function expectEgressDenied(error: unknown): void {
  expect(error).toBeInstanceOf(ConnectorExecutionError);
  expect((error as ConnectorExecutionError).code).toBe("CONNECTOR_EGRESS_DENIED");
}

describe("connector host allowlisting", () => {
  it("keeps exact, one-label and any-depth patterns distinct", () => {
    expect(hostAllowed("api.example.com", ["api.example.com"])).toBe(true);
    expect(hostAllowed("eu.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("a.b.example.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("a.b.example.com", ["**.example.com"])).toBe(true);
    expect(hostAllowed("example.com", ["**.example.com"])).toBe(false);
    expect(hostAllowed("evil-example.com", ["**.example.com"])).toBe(false);
  });

  it("denies everything when the contract grants no egress", () => {
    expect(hostAllowed("api.example.com", [])).toBe(false);
  });
});

describe("resolved address policy", () => {
  const denied = [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::a00:1",
    "64:ff9b:1::1",
    "100::1",
    "100:0:0:1::1",
    "2001::1",
    "2001:2::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
    "5f00::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
  ];
  for (const address of denied) {
    it(`refuses non-public address ${address}`, () => {
      expect(isPubliclyRoutableAddress(address)).toBe(false);
    });
  }

  const allowed = [
    "1.1.1.1",
    "8.8.8.8",
    "192.0.0.9",
    "192.0.0.10",
    "64:ff9b::808:808",
    "2001:1::1",
    "2001:3::1",
    "2001:20::1",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "2a00:1450:4001:81b::200e",
  ];
  for (const address of allowed) {
    it(`accepts globally reachable unicast ${address}`, () => {
      expect(isPubliclyRoutableAddress(address)).toBe(true);
    });
  }

  it("refuses a hostname when any DNS answer is non-public", async () => {
    const stub = transport(() => Response.json({ ok: true }));
    const resolveMixed: HostResolver = async () => [
      PUBLIC_V4,
      { address: "127.0.0.1", family: 4 },
    ];
    try {
      await createBoundFetch(contract(), new AbortController().signal, stub.fetch, resolveMixed)(
        "https://api.example.com/data",
      );
      throw new Error("expected egress denial");
    } catch (error) {
      expectEgressDenied(error);
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses empty and malformed DNS results before transport", async () => {
    for (const resolver of [
      async () => [],
      async () => [{ address: "not-an-ip", family: 4 as const }],
      async () => [{ address: "8.8.8.8", family: 6 as const }],
    ]) {
      const stub = transport(() => Response.json({ ok: true }));
      await expect(
        createBoundFetch(contract(), new AbortController().signal, stub.fetch, resolver)(
          "https://api.example.com/data",
        ),
      ).rejects.toMatchObject({ code: "CONNECTOR_EGRESS_DENIED" });
      expect(stub.calls).toHaveLength(0);
    }
  });

  it("pins the production socket to the approved address", async () => {
    let seenHost: string | null = null;
    let seenBody = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        seenHost = request.headers.get("host");
        seenBody = await request.text();
        return Response.json({ reached: true });
      },
    });
    try {
      const url = new URL(`http://not-resolved.invalid:${server.port}/pinned?q=1`);
      const response = await fetchPinnedAddress(
        url,
        {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: new TextEncoder().encode("payload"),
        },
        { address: "127.0.0.1", family: 4 },
      );
      expect(await response.json()).toEqual({ reached: true });
      expect(String(seenHost)).toBe(`not-resolved.invalid:${server.port}`);
      expect(seenBody).toBe("payload");
    } finally {
      server.stop(true);
    }
  });

  it("rejects upstream metadata that cannot be represented without throwing globally", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 700;
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("expected a TCP test server address");
    }

    try {
      await expect(
        fetchPinnedAddress(
          new URL(`http://not-resolved.invalid:${address.port}/invalid-status`),
          { method: "GET" },
          { address: "127.0.0.1", family: 4 },
        ),
      ).rejects.toBeInstanceOf(RangeError);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("explicit redirect handling", () => {
  it("resolves relative redirects and revalidates the host on every hop", async () => {
    const resolved: string[] = [];
    const resolver: HostResolver = async (hostname) => {
      resolved.push(hostname);
      return [PUBLIC_V4];
    };
    const stub = transport((_call, index) =>
      index === 0 ? redirect(302, "../objects?page=2") : Response.json({ ok: true }),
    );

    const response = await createBoundFetch(
      contract(),
      new AbortController().signal,
      stub.fetch,
      resolver,
    )("https://api.example.com/v1/start");

    expect(await response.json()).toEqual({ ok: true });
    expect(stub.calls.map((call) => call.url.href)).toEqual([
      "https://api.example.com/v1/start",
      "https://api.example.com/objects?page=2",
    ]);
    expect(resolved).toEqual(["api.example.com", "api.example.com"]);
    expect(stub.calls.every((call) => call.address.address === PUBLIC_V4.address)).toBe(true);
  });

  const methodCases = [
    { status: 301, initial: "POST", expected: "GET", keepsBody: false },
    { status: 302, initial: "POST", expected: "GET", keepsBody: false },
    { status: 303, initial: "PUT", expected: "GET", keepsBody: false },
    { status: 303, initial: "HEAD", expected: "HEAD", keepsBody: false },
    { status: 307, initial: "POST", expected: "POST", keepsBody: true },
    { status: 308, initial: "POST", expected: "POST", keepsBody: true },
  ] as const;
  for (const entry of methodCases) {
    it(`${entry.status} maps ${entry.initial} to ${entry.expected} with safe body semantics`, async () => {
      const stub = transport((_call, index) =>
        index === 0 ? redirect(entry.status, "/next") : Response.json({ ok: true }),
      );
      const hasInitialBody = entry.initial !== "HEAD";
      const request: RequestInit = {
        method: entry.initial,
        ...(hasInitialBody
          ? {
              headers: { "content-type": "application/json" },
              body: '{"secret":false}',
            }
          : {}),
      };
      await createBoundFetch(
        contract(),
        new AbortController().signal,
        stub.fetch,
        publicResolver,
      )("https://api.example.com/start", request);

      expect(stub.calls).toHaveLength(2);
      expect(stub.calls[1]?.method).toBe(entry.expected);
      expect(text(stub.calls[1]?.body)).toBe(entry.keepsBody ? '{"secret":false}' : undefined);
      expect(stub.calls[1]?.headers.get("content-type")).toBe(
        entry.keepsBody ? "application/json" : null,
      );
    });
  }

  it("allows POST-to-GET on the same URL without misclassifying it as a loop", async () => {
    const stub = transport((_call, index) =>
      index === 0 ? redirect(303, "/resource") : Response.json({ ok: true }),
    );
    await createBoundFetch(
      contract(),
      new AbortController().signal,
      stub.fetch,
      publicResolver,
    )("https://api.example.com/resource", { method: "POST", body: "payload" });
    expect(stub.calls.map(({ method }) => method)).toEqual(["POST", "GET"]);
  });

  it("stops a redirect loop before reconnecting to a visited method and URL", async () => {
    const stub = transport((call) =>
      redirect(302, call.url.pathname === "/a" ? "/b" : "/a"),
    );
    await expect(
      createBoundFetch(
        contract(),
        new AbortController().signal,
        stub.fetch,
        publicResolver,
      )("https://api.example.com/a"),
    ).rejects.toMatchObject({ code: "CONNECTOR_EGRESS_DENIED" });
    expect(stub.calls).toHaveLength(2);
  });

  it("enforces the bounded redirect count", async () => {
    const stub = transport((_call, index) => redirect(302, `/hop-${index + 1}`));
    await expect(
      createBoundFetch(
        contract(),
        new AbortController().signal,
        stub.fetch,
        publicResolver,
      )("https://api.example.com/start"),
    ).rejects.toMatchObject({ code: "CONNECTOR_EGRESS_DENIED" });
    expect(stub.calls).toHaveLength(MAX_CONNECTOR_REDIRECTS + 1);
  });

  it("rejects a redirect to a host outside the contract before resolving it", async () => {
    const resolved: string[] = [];
    const resolver: HostResolver = async (hostname) => {
      resolved.push(hostname);
      return [PUBLIC_V4];
    };
    const stub = transport(() => redirect(302, "https://attacker.example/collect"));
    await expect(
      createBoundFetch(contract(), new AbortController().signal, stub.fetch, resolver)(
        "https://api.example.com/start",
      ),
    ).rejects.toMatchObject({ code: "CONNECTOR_EGRESS_DENIED" });
    expect(stub.calls).toHaveLength(1);
    expect(resolved).toEqual(["api.example.com"]);
  });

  it("rejects a redirect whose newly resolved address is private", async () => {
    const resolver: HostResolver = async (hostname) =>
      hostname === "api.example.com"
        ? [PUBLIC_V4]
        : [{ address: "169.254.169.254", family: 4 }];
    const stub = transport((_call, index) =>
      index === 0
        ? redirect(302, "https://cdn.example.com/next")
        : Response.json({ shouldNot: "run" }),
    );
    await expect(
      createBoundFetch(contract(), new AbortController().signal, stub.fetch, resolver)(
        "https://api.example.com/start",
      ),
    ).rejects.toMatchObject({ code: "CONNECTOR_EGRESS_DENIED" });
    expect(stub.calls).toHaveLength(1);
  });

  it("detects a DNS answer changing from public to private on a same-host redirect", async () => {
    let resolution = 0;
    const resolver: HostResolver = async () =>
      resolution++ === 0 ? [PUBLIC_V4] : [{ address: "10.0.0.1", family: 4 }];
    const stub = transport((_call, index) =>
      index === 0 ? redirect(302, "/next") : Response.json({ shouldNot: "run" }),
    );
    await expect(
      createBoundFetch(contract(), new AbortController().signal, stub.fetch, resolver)(
        "https://api.example.com/start",
      ),
    ).rejects.toMatchObject({ code: "CONNECTOR_EGRESS_DENIED" });
    expect(stub.calls).toHaveLength(1);
  });

  it("refuses an HTTPS-to-HTTP redirect before resolving the destination", async () => {
    const resolved: string[] = [];
    const resolver: HostResolver = async (hostname) => {
      resolved.push(hostname);
      return [PUBLIC_V4];
    };
    const stub = transport((_call, index) =>
      index === 0
        ? redirect(302, "http://cdn.example.com/next")
        : Response.json({ shouldNot: "run" }),
    );

    await expect(
      createBoundFetch(contract(), new AbortController().signal, stub.fetch, resolver)(
        "https://api.example.com/start",
        { headers: { accept: "application/json" } },
      ),
    ).rejects.toMatchObject({ code: "CONNECTOR_EGRESS_DENIED" });
    expect(stub.calls).toHaveLength(1);
    expect(resolved).toEqual(["api.example.com"]);
  });

  for (const location of [
    "https://cdn.example.com/next",
    "//cdn.example.com/next",
  ]) {
    it(`refuses cross-origin forwarding of existing query material via ${location}`, async () => {
      const stub = transport((_call, index) =>
        index === 0 ? redirect(302, location) : Response.json({ shouldNot: "run" }),
      );

      await expect(
        createBoundFetch(
          contract(),
          new AbortController().signal,
          stub.fetch,
          publicResolver,
        )("https://api.example.com/start?api_key=secret", {
          headers: { accept: "application/json" },
        }),
      ).rejects.toMatchObject({ code: "CONNECTOR_EGRESS_DENIED" });
      expect(stub.calls).toHaveLength(1);
    });
  }

  for (const status of [301, 302, 303, 307, 308]) {
    it(`refuses a sensitive POST body on a cross-origin ${status}`, async () => {
      const stub = transport((_call, index) =>
        index === 0
          ? redirect(status, "https://cdn.example.com/next")
          : Response.json({ shouldNot: "run" }),
      );
      await expect(
        createBoundFetch(
          contract(),
          new AbortController().signal,
          stub.fetch,
          publicResolver,
        )("https://api.example.com/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"credential":"value"}',
        }),
      ).rejects.toMatchObject({ code: "CONNECTOR_EGRESS_DENIED" });
      expect(stub.calls).toHaveLength(1);
    });
  }

  for (const header of ["authorization", "cookie", "x-api-key", "x-tenant-context"]) {
    it(`refuses cross-origin forwarding of ${header}`, async () => {
      const stub = transport((_call, index) =>
        index === 0
          ? redirect(302, "https://cdn.example.com/next")
          : Response.json({ shouldNot: "run" }),
      );
      await expect(
        createBoundFetch(
          contract(),
          new AbortController().signal,
          stub.fetch,
          publicResolver,
        )("https://api.example.com/start", { headers: { [header]: "sensitive" } }),
      ).rejects.toMatchObject({ code: "CONNECTOR_EGRESS_DENIED" });
      expect(stub.calls).toHaveLength(1);
    });
  }

  it("allows a bodyless cross-origin GET with representation-negotiation headers", async () => {
    const stub = transport((_call, index) =>
      index === 0
        ? redirect(302, "https://cdn.example.com/next")
        : Response.json({ ok: true }),
    );
    const response = await createBoundFetch(
      contract(),
      new AbortController().signal,
      stub.fetch,
      publicResolver,
    )("https://api.example.com/start", { headers: { accept: "application/json" } });
    expect(await response.json()).toEqual({ ok: true });
    expect(stub.calls).toHaveLength(2);
  });

  it("honours manual and error redirect modes without an implicit follow", async () => {
    const manual = transport(() => redirect(302, "/next"));
    const response = await createBoundFetch(
      contract(),
      new AbortController().signal,
      manual.fetch,
      publicResolver,
    )("https://api.example.com/start", { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(manual.calls).toHaveLength(1);

    const refused = transport(() => redirect(302, "/next"));
    await expect(
      createBoundFetch(
        contract(),
        new AbortController().signal,
        refused.fetch,
        publicResolver,
      )("https://api.example.com/start", { redirect: "error" }),
    ).rejects.toMatchObject({ code: "CONNECTOR_EGRESS_DENIED" });
    expect(refused.calls).toHaveLength(1);
  });

  it("replaces a package-supplied signal with the operation signal", async () => {
    const operation = new AbortController();
    const packageController = new AbortController();
    packageController.abort();
    const stub = transport(() => Response.json({ ok: true }));

    const response = await createBoundFetch(
      contract(),
      operation.signal,
      stub.fetch,
      publicResolver,
    )("https://api.example.com/start", { signal: packageController.signal });

    expect(await response.json()).toEqual({ ok: true });
    expect(stub.calls[0]?.signal).toBe(operation.signal);
  });

  it("removes the abort listener when a pending resolver is aborted", async () => {
    const operation = new AbortController();
    const originalRemove = operation.signal.removeEventListener.bind(operation.signal);
    let removed = 0;
    operation.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      removed += 1;
      return originalRemove(...args);
    }) as AbortSignal["removeEventListener"];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const resolver: HostResolver = async () => {
      markStarted();
      return new Promise<readonly ResolvedAddress[]>(() => {});
    };
    const stub = transport(() => Response.json({ shouldNot: "run" }));
    const request = createBoundFetch(contract(), operation.signal, stub.fetch, resolver)(
      "https://api.example.com/start",
    );

    await started;
    operation.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(removed).toBeGreaterThan(0);
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects credential-bearing and non-HTTP URLs before transport", async () => {
    const stub = transport(() => Response.json({ shouldNot: "run" }));
    for (const url of [
      "https://user:password@api.example.com/data",
      "file:///etc/passwd",
    ]) {
      await expect(
        createBoundFetch(
          contract(),
          new AbortController().signal,
          stub.fetch,
          publicResolver,
        )(url),
      ).rejects.toMatchObject({ code: "CONNECTOR_EGRESS_DENIED" });
    }
    expect(stub.calls).toHaveLength(0);
  });
});
