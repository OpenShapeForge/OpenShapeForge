// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { createKeycloakFetch } from "../keycloak-service-account.js";

describe("the Keycloak connect route", () => {
  it("changes only the socket destination and preserves public TLS identity", async () => {
    let seenUrl = "";
    let seenInit: (RequestInit & { tls?: { serverName?: string } }) | undefined;
    const underlying = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      seenUrl = request.url;
      seenInit = init;
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;
    const routed = createKeycloakFetch(
      {
        baseUrl: "https://identity.example.test",
        connectUrl: "https://identity-ingress.example.test",
        tenantRealm: "tenant-realm",
        clientId: "service-client",
        clientSecret: "obviously-fake",
      },
      underlying,
    );

    await routed("https://identity.example.test/admin/realms/tenant-realm", {
      headers: { authorization: "Bearer obviously-fake" },
    });

    expect(seenUrl).toBe("https://identity-ingress.example.test/admin/realms/tenant-realm");
    expect(new Headers(seenInit?.headers).get("host")).toBe("identity.example.test");
    expect(new Headers(seenInit?.headers).get("authorization")).toBe("Bearer obviously-fake");
    expect(seenInit?.tls?.serverName).toBe("identity.example.test");
  });

  it("preserves Request properties but refuses redirects", async () => {
    let seen: Request | undefined;
    const underlying = (async (input: string | URL | Request, init?: RequestInit) => {
      seen = new Request(input, init);
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;
    const routed = createKeycloakFetch(
      {
        baseUrl: "https://identity.example.test",
        connectUrl: "https://identity-ingress.example.test",
        tenantRealm: "tenant-realm",
        clientId: "service-client",
        clientSecret: "obviously-fake",
      },
      underlying,
    );
    const abort = new AbortController();

    await routed(new Request("https://identity.example.test/token", {
      method: "POST",
      body: "client_secret=obviously-fake",
      credentials: "include",
      redirect: "follow",
      signal: abort.signal,
    }));

    expect(seen?.method).toBe("POST");
    expect(await seen?.text()).toBe("client_secret=obviously-fake");
    expect(seen?.credentials).toBe("include");
    expect(seen?.redirect).toBe("error");
    expect(seen?.signal).toBe(abort.signal);
  });

  it("refuses to route an unrelated origin", async () => {
    const routed = createKeycloakFetch(
      {
        baseUrl: "https://identity.example.test",
        connectUrl: "https://identity-ingress.example.test",
        tenantRealm: "tenant-realm",
        clientId: "service-client",
        clientSecret: "obviously-fake",
      },
      globalThis.fetch,
    );

    await expect(routed("https://other.example.test/admin")).rejects.toThrow(
      "only accepts its configured public origin",
    );
  });
});
