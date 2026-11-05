// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { createOAuthMetadataFetch } from "../native-oauth-transport.js";

describe("OAuth metadata egress", () => {
  it("uses a pinned public address, the Adapter allowlist, no credentials and no redirects", async () => {
    let request: any;
    const fetch = createOAuthMetadataFetch({
      owner: { pinsResolvedAddresses: true, fetch: async (input: any) => { request = input; return Response.json({ issuer: "https://auth.example.com" }); } } as any,
      allowlist: ["auth.example.com"], tenantId: "tenant", actorId: "person", provider: "provider",
      resolve: async () => ["93.184.216.34"],
    });
    expect(await fetch({ url: "https://auth.example.com/.well-known/oauth-authorization-server", maxResponseBytes: 1024 })).toMatchObject({ status: 200 });
    expect(request.resolvedAddresses).toEqual(["93.184.216.34"]);
    expect(request.init.redirect).toBe("manual");
    expect(new Headers(request.init.headers).has("authorization")).toBe(false);
  });
  it("refuses private DNS, unlisted hosts before DNS, missing pinning and excess responses", async () => {
    let resolved = 0;
    const options = { owner: { pinsResolvedAddresses: true, fetch: async () => new Response("12345") } as any,
      allowlist: ["auth.example.com"], tenantId: "tenant", actorId: "person", provider: "provider",
      resolve: async () => { resolved++; return ["127.0.0.1"]; } };
    await expect(createOAuthMetadataFetch(options)({ url: "https://evil.example/.well-known", maxResponseBytes: 10 })).rejects.toMatchObject({ code: "EGRESS_DENIED" });
    expect(resolved).toBe(0);
    await expect(createOAuthMetadataFetch(options)({ url: "https://auth.example.com/.well-known", maxResponseBytes: 10 })).rejects.toMatchObject({ code: "EGRESS_DENIED" });
    await expect(createOAuthMetadataFetch({ ...options, owner: undefined })({ url: "https://auth.example.com/.well-known", maxResponseBytes: 10 })).rejects.toMatchObject({ code: "EGRESS_OWNER_REQUIRED" });
    await expect(createOAuthMetadataFetch({ ...options, resolve: async () => ["93.184.216.34"] })({ url: "https://auth.example.com/.well-known", maxResponseBytes: 3 })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_TOO_LARGE" });
  });
});
