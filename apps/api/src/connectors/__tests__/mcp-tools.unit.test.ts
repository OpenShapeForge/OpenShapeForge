// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import {
  annotationsFor,
  connectorMcpTools,
  connectorToolsForSession,
  resolveConnectorTool,
  sessionMayInvokeConnectorTool,
} from "../mcp-tools.js";
import type { ConnectorContract, ConnectorOperationContract } from "../catalog.js";

const READ_ROLE = "Connectors.All.Read";
const WRITE_ROLE = "Connectors.All.ReadWrite";

function operation(
  key: string,
  kind: "query" | "mutation",
  roles: string[],
  extras: Partial<ConnectorOperationContract> = {},
): ConnectorOperationContract {
  return {
    key,
    kind,
    graphql: { field: key, inputType: `In${key}`, resultType: `Out${key}` },
    rest: { method: kind === "query" ? "GET" : "POST", path: key },
    mcp: { toolName: `object_store_${key}` },
    roles: { invoke: roles },
    schemas: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object" },
    },
    reliability: {
      timeouts: { attemptMs: 1_000, totalMs: 1_000 },
      retry: { eligible: false, maxAttempts: 1, backoff: "fixed" },
      concurrency: { perTenant: 4 },
      limits: { requestBytes: 1024, responseBytes: 1024 },
      pagination: { style: "none" },
    },
    ...extras,
  } as ConnectorOperationContract;
}

function contract(
  operations: ConnectorOperationContract[],
  mcp = true,
): ConnectorContract {
  return {
    slug: "object-store",
    connector: "ObjectStore",
    title: "Object storage",
    domains: [],
    capabilities: ["operations"],
    implementation: {
      package: "@scope/pkg",
      contractVersion: 1,
      provenance: "reviewed",
      license: { spdx: "MIT" },
    },
    availability: {},
    configuration: {
      instances: "single",
      verify: false,
      fields: [],
      secretFields: [],
      schema: {},
    },
    network: { egress: [] },
    operations,
    exposure: mcp ? { graphql: true, mcp: { toolPrefix: "object_store" } } : { graphql: true },
    namespace: "objectStore",
    checksum: "c1",
  } as ConnectorContract;
}

const CONTRACTS = [
  contract([
    operation("list", "query", [READ_ROLE]),
    operation("put", "mutation", [WRITE_ROLE]),
  ]),
];

describe("tool catalog", () => {
  it("advertises only connectors that opted into MCP", () => {
    expect(connectorMcpTools(CONTRACTS).map((tool) => tool.name)).toEqual([
      "object_store_list",
      "object_store_put",
    ]);
    const noMcp = [contract([operation("list", "query", [READ_ROLE])], false)];
    expect(connectorMcpTools(noMcp)).toEqual([]);
  });

  it("derives annotations from the operation kind", () => {
    const [list, put] = connectorMcpTools(CONTRACTS);
    expect(list?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    // A mutation with no declared idempotency must not be hinted as safe to
    // repeat: that hint is what a model reads before retrying.
    expect(put?.annotations.idempotentHint).toBe(false);
    expect(put?.annotations.readOnlyHint).toBe(false);
  });

  it("claims idempotentHint only when the contract declares a strategy", () => {
    const idempotent = operation("put", "mutation", [WRITE_ROLE], {
      reliability: {
        timeouts: { attemptMs: 1_000, totalMs: 1_000 },
        retry: { eligible: true, maxAttempts: 3, backoff: "fixed" },
        idempotency: { strategy: "natural" },
        concurrency: { perTenant: 4 },
        limits: { requestBytes: 1024, responseBytes: 1024 },
        pagination: { style: "none" },
      },
    } as Partial<ConnectorOperationContract>);
    expect(annotationsFor(idempotent).idempotentHint).toBe(true);
  });

  it("warns in the description when a mutation is not safe to repeat", () => {
    const [, put] = connectorMcpTools(CONTRACTS);
    expect(put?.description).toContain("Not safe to repeat");
  });
});

describe("per-session tools/list", () => {
  // The property the existing transport guarantees and the extension must keep.
  it("shows a read-only session no mutation tools", () => {
    const tools = connectorToolsForSession(CONTRACTS, { roles: [READ_ROLE] });
    expect(tools.map((tool) => tool.name)).toEqual(["object_store_list"]);
  });

  it("shows a writer both", () => {
    const tools = connectorToolsForSession(CONTRACTS, { roles: [READ_ROLE, WRITE_ROLE] });
    expect(tools.map((tool) => tool.name)).toEqual([
      "object_store_list",
      "object_store_put",
    ]);
  });

  it("shows a session with no roles an empty catalog", () => {
    expect(connectorToolsForSession(CONTRACTS, { roles: [] })).toEqual([]);
  });

  it("fails closed for an operation that declares no roles", () => {
    expect(sessionMayInvokeConnectorTool(operation("x", "query", []), { roles: ["any"] })).toBe(
      false,
    );
  });
});

describe("invocation lookup", () => {
  it("resolves a tool the session may invoke", () => {
    const resolved = resolveConnectorTool(CONTRACTS, "object_store_list", {
      roles: [READ_ROLE],
    });
    expect(resolved?.operation.key).toBe("list");
  });

  // An unauthorized tool and an unknown one must be indistinguishable, or the
  // error becomes a way to enumerate which connectors a deployment has.
  it("answers identically for an unauthorized and an unknown tool", () => {
    const unauthorized = resolveConnectorTool(CONTRACTS, "object_store_put", {
      roles: [READ_ROLE],
    });
    const unknown = resolveConnectorTool(CONTRACTS, "no_such_tool", {
      roles: [READ_ROLE],
    });
    expect(unauthorized).toBeUndefined();
    expect(unknown).toBeUndefined();
  });

  it("resolves nothing for a session with no roles, whatever the name", () => {
    for (const name of ["object_store_list", "object_store_put", "nonsense"]) {
      expect(resolveConnectorTool(CONTRACTS, name, { roles: [] })).toBeUndefined();
    }
  });
});
