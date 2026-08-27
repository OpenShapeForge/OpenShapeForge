// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for schema discovery: the OpenAPI summary shape, the egress
 * gate, and the unavailable/none cases. The introspection POST shares the
 * same fetch path.
 */
import { describe, expect, it } from "bun:test";
import { discoverProviderSchema, summarizeOpenApi } from "../discovery.js";

describe("summarizeOpenApi", () => {
  it("flattens paths into a capped operation list", () => {
    const { operations, truncated } = summarizeOpenApi({
      paths: {
        "/tickets": {
          get: { summary: "List", operationId: "listTickets", parameters: [{ name: "q" }] },
          post: { summary: "Create", requestBody: {} },
        },
      },
    });
    expect(truncated).toBe(false);
    expect(operations).toEqual([
      { method: "GET", path: "/tickets", summary: "List", operationId: "listTickets", parameters: ["q"] },
      { method: "POST", path: "/tickets", summary: "Create", hasBody: true },
    ]);
  });
});

describe("discoverProviderSchema", () => {
  it("fetches and summarizes an openapi document within egress", async () => {
    const impl = (async () =>
      Response.json({ paths: { "/x": { get: { summary: "X" } } } })) as unknown as typeof fetch;
    const result = await discoverProviderSchema(
      {
        discovery: "openapi",
        schemaUrl: "https://api.example.com/openapi.json",
        egressHosts: ["api.example.com"],
      },
      impl,
    );
    expect(result.operationCount).toBe(1);
  });

  it("refuses none-mode, missing url, and out-of-egress hosts", async () => {
    await expect(discoverProviderSchema({ discovery: "none" })).rejects.toThrow(
      /only openapi and/,
    );
    await expect(
      discoverProviderSchema({ discovery: "openapi", schemaUrl: "" }),
    ).rejects.toThrow(/no schemaUrl/);
    await expect(
      discoverProviderSchema({
        discovery: "openapi",
        schemaUrl: "https://evil.example.net/x.json",
        egressHosts: ["api.example.com"],
      }),
    ).rejects.toThrow(/egress allow-list/);
  });
});
