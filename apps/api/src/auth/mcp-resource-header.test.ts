// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, test } from "bun:test";
import { MCP_RESOURCE_HEADER, mcpResourceHeader } from "./mcp-resource-header.js";
const origin = "https://app.example.test";
const saved = new Map(["OPENSHAPEFORGE_PUBLIC_ORIGIN", "OPENSHAPEFORGE_ORGANIZATION_CONTEXT"].map(key => [key, process.env[key]]));
afterEach(() => { for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value; });
const request = (path: string) => new Headers({ [MCP_RESOURCE_HEADER]: `${origin}${path}` });
test("HTTP binding distinguishes tenant and control resources on the configured origin", () => {
  process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = origin; process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = "host";
  expect(mcpResourceHeader(request("/api/mcp"), "tenant")).toEqual({ requiredAudience: `${origin}/api/mcp` });
  for (const path of ["/alpha", "/alpha/mcp"]) expect(mcpResourceHeader(request(path), "tenant")).toEqual({ organization: { alias: "alpha", resource: `${origin}/alpha` } });
  expect(mcpResourceHeader(request("/admin/mcp"), "control")).toEqual({ resource: `${origin}/admin/mcp` });
  for (const path of ["/api/mcp", "/alpha/mcp"]) expect(() => mcpResourceHeader(request(path), "control")).toThrow();
  for (const path of ["/admin/mcp", "/alpha/api/relations", "/api/mcp?next=bad", "/api/mcp#fragment"]) expect(() => mcpResourceHeader(request(path), "tenant")).toThrow();
  expect(() => mcpResourceHeader(new Headers({ [MCP_RESOURCE_HEADER]: "https://other.example.test/api/mcp" }), "tenant")).toThrow();
});

test("binding reports unavailable authentication when the configured origin is missing or invalid", () => {
  process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT = "host";
  for (const value of [undefined, "invalid", "https://app.example.test/path"]) {
    if (value === undefined) delete process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN;
    else process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = value;
    expect(() => mcpResourceHeader(request("/api/mcp"), "tenant")).toThrow("MCP App resource verification is unavailable");
  }
});
