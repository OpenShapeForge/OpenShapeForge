// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { buildConnector } from "./connector.js";
import { validateConnectorContentIdentifiers } from "../connector-loader.js";
import type { ConnectorDefinition } from "../types/connector.js";

const ORIGIN = "authoring/connectors/object-store.yaml";

function definition(
  overrides: Partial<ConnectorDefinition> = {},
): ConnectorDefinition {
  return {
    schemaVersion: 1,
    kind: "connector",
    connector: "ObjectStore",
    title: "Object storage",
    capabilities: ["operations"],
    implementation: {
      package: "@openshapeforge/connector-object-store",
      contractVersion: 1,
      provenance: "firstParty",
      license: { spdx: "LicenseRef-BatterAI-Commercial" },
    },
    operations: [
      {
        key: "listObjects",
        kind: "query",
        authorization: { roles: { invoke: ["Connectors.All.Read"] } },
        input: [{ key: "prefix", valueType: "string" }],
        output: { cardinality: "many", fields: [{ key: "key", valueType: "string" }] },
      },
    ],
    ...overrides,
  } as ConnectorDefinition;
}

describe("buildConnector — surface projection", () => {
  it("projects GraphQL names, REST method/path, and the namespace", () => {
    const compiled = buildConnector(definition(), "object-store", ORIGIN);

    expect(compiled.namespace).toBe("objectStore");
    const operation = compiled.operations[0]!;
    expect(operation.graphql).toEqual({
      field: "listObjects",
      inputType: "ObjectStoreListObjectsInput",
      resultType: "ObjectStoreListObjectsResult",
    });
    // A query becomes a GET; the path is the kebab-cased operation key.
    expect(operation.rest).toEqual({ method: "GET", path: "list-objects" });
  });

  it("derives POST for mutations", () => {
    const compiled = buildConnector(
      definition({
        operations: [
          {
            key: "putObject",
            kind: "mutation",
            authorization: { roles: { invoke: ["Connectors.All.ReadWrite"] } },
            output: { cardinality: "one", fields: [{ key: "key", valueType: "string" }] },
          },
        ],
      }),
      "object-store",
      ORIGIN,
    );
    expect(compiled.operations[0]!.rest).toEqual({ method: "POST", path: "put-object" });
  });

  it("emits no MCP tool names unless MCP exposure is opted into", () => {
    const withoutMcp = buildConnector(definition(), "object-store", ORIGIN);
    expect(withoutMcp.exposure.mcp).toBeUndefined();
    expect(withoutMcp.operations[0]!.mcp).toBeUndefined();

    const withMcp = buildConnector(
      definition({ exposure: { mcp: true } }),
      "object-store",
      ORIGIN,
    );
    expect(withMcp.exposure.mcp).toEqual({ toolPrefix: "object_store" });
    expect(withMcp.operations[0]!.mcp).toEqual({ toolName: "object_store_list_objects" });
  });

  it("honours a per-operation MCP opt-out", () => {
    const compiled = buildConnector(
      definition({ exposure: { mcp: { operations: { listObjects: false } } } }),
      "object-store",
      ORIGIN,
    );
    expect(compiled.exposure.mcp).toBeDefined();
    expect(compiled.operations[0]!.mcp).toBeUndefined();
  });

  it("rejects an MCP flag for an operation that does not exist", () => {
    expect(() =>
      buildConnector(
        definition({ exposure: { mcp: { operations: { nope: false } } } }),
        "object-store",
        ORIGIN,
      ),
    ).toThrow(/not a declared operation/);
  });

  it("defaults the REST base path to the slug and keeps GraphQL on by default", () => {
    const compiled = buildConnector(
      definition({ exposure: { rest: true } }),
      "object-store",
      ORIGIN,
    );
    expect(compiled.exposure).toEqual({ graphql: true, rest: { basePath: "object-store" } });
  });
});

describe("buildConnector — fail closed", () => {
  it("rejects the reserved event capabilities", () => {
    expect(() =>
      buildConnector(
        definition({ capabilities: ["operations", "eventSink"] }),
        "object-store",
        ORIGIN,
      ),
    ).toThrow(/reserved but not implemented/);
  });

  it("rejects a declared events block", () => {
    expect(() =>
      buildConnector(
        definition({ events: [{ key: "objectCreated", direction: "inbound", payload: [] }] }),
        "object-store",
        ORIGIN,
      ),
    ).toThrow(/require the reserved eventSource \/ eventSink capabilities/);
  });

  it("rejects an operation with no invoke roles", () => {
    expect(() =>
      buildConnector(
        definition({
          operations: [
            {
              key: "listObjects",
              kind: "query",
              output: { cardinality: "many", fields: [] },
            },
          ],
        }),
        "object-store",
        ORIGIN,
      ),
    ).toThrow(/declares no invoke roles/);
  });

  it("rejects an operation without an output shape", () => {
    expect(() =>
      buildConnector(
        definition({
          operations: [
            {
              key: "listObjects",
              kind: "query",
              authorization: { roles: { invoke: ["Connectors.All.Read"] } },
            },
          ],
        } as Partial<ConnectorDefinition>),
        "object-store",
        ORIGIN,
      ),
    ).toThrow(/must declare an output shape/);
  });

  it("rejects a connector exposing no surface at all", () => {
    expect(() =>
      buildConnector(
        definition({ exposure: { graphql: false } }),
        "object-store",
        ORIGIN,
      ),
    ).toThrow(/exposes no surface/);
  });

  it("rejects duplicate operation keys", () => {
    const operation = {
      key: "listObjects",
      kind: "query" as const,
      authorization: { roles: { invoke: ["Connectors.All.Read"] } },
      output: { cardinality: "many" as const, fields: [] },
    };
    expect(() =>
      buildConnector(definition({ operations: [operation, operation] }), "object-store", ORIGIN),
    ).toThrow(/Duplicate operation key/);
  });

  it("requires a license and a contract version", () => {
    expect(() =>
      buildConnector(
        definition({
          implementation: {
            package: "@scope/pkg",
            contractVersion: 1,
            provenance: "thirdParty",
            license: {} as { spdx: string },
          },
        }),
        "object-store",
        ORIGIN,
      ),
    ).toThrow(/implementation\.license\.spdx/);
  });
});

describe("buildConnector — structural guards", () => {
  // A scalar where a list belongs used to be spread character by character:
  // `invoke: "AdminRole"` compiled to ["A","R","d","e",…]. Silent corruption of
  // an authorization allow-list is worse than a build failure.
  it("refuses a scalar where a list of roles belongs", () => {
    expect(() =>
      buildConnector(
        definition({
          operations: [
            {
              key: "listObjects",
              kind: "query",
              authorization: { roles: { invoke: "AdminRole" } },
              output: { cardinality: "many", fields: [] },
            },
          ],
        } as unknown as Partial<ConnectorDefinition>),
        "object-store",
        ORIGIN,
      ),
    ).toThrow(/authorization\.roles\.invoke must be a list, got string/);
  });

  it("refuses a scalar where the capability list belongs", () => {
    expect(() =>
      buildConnector(
        definition({ capabilities: "operations" } as unknown as Partial<ConnectorDefinition>),
        "object-store",
        ORIGIN,
      ),
    ).toThrow(/capabilities must be a list, got string/);
  });

  it("refuses an unsupported schemaVersion", () => {
    expect(() =>
      buildConnector(definition({ schemaVersion: 99 }), "object-store", ORIGIN),
    ).toThrow(/only version 1 is supported/);
  });

  it("refuses a missing or non-string title", () => {
    for (const title of [undefined, 42, ""]) {
      expect(() =>
        buildConnector(
          definition({ title } as unknown as Partial<ConnectorDefinition>),
          "object-store",
          ORIGIN,
        ),
      ).toThrow(/title must be a non-empty string/);
    }
  });

  it("refuses a bogus output cardinality and a non-numeric timeout", () => {
    expect(() =>
      buildConnector(
        definition({
          operations: [
            {
              key: "listObjects",
              kind: "query",
              authorization: { roles: { invoke: ["R"] } },
              output: { cardinality: "several", fields: [] },
            },
          ],
        } as unknown as Partial<ConnectorDefinition>),
        "object-store",
        ORIGIN,
      ),
    ).toThrow(/output\.cardinality must be one of one \| many/);

    expect(() =>
      buildConnector(
        definition({
          operations: [
            {
              key: "listObjects",
              kind: "query",
              authorization: { roles: { invoke: ["R"] } },
              output: { cardinality: "many", fields: [] },
              reliability: { timeouts: { attemptMs: "fast" } },
            },
          ],
        } as unknown as Partial<ConnectorDefinition>),
        "object-store",
        ORIGIN,
      ),
    ).toThrow(/non-numeric timeouts.attemptMs/);
  });
});

describe("buildConnector — reliability", () => {
  function mutation(reliability: Record<string, unknown>): ConnectorDefinition {
    return definition({
      operations: [
        {
          key: "putObject",
          kind: "mutation",
          authorization: { roles: { invoke: ["Connectors.All.ReadWrite"] } },
          input: [{ key: "requestId", valueType: "string" }],
          output: { cardinality: "one", fields: [] },
          reliability,
        },
      ],
    } as Partial<ConnectorDefinition>);
  }

  it("refuses a retry-eligible mutation with no idempotency declaration", () => {
    expect(() => buildConnector(mutation({ retry: { eligible: true } }), "s", ORIGIN)).toThrow(
      /without an idempotency declaration/,
    );
  });

  it("accepts a retry-eligible mutation that declares natural idempotency", () => {
    const compiled = buildConnector(
      mutation({ retry: { eligible: true }, idempotency: { strategy: "natural" } }),
      "s",
      ORIGIN,
    );
    expect(compiled.operations[0]!.reliability.retry.eligible).toBe(true);
  });

  it("requires keyInput to name a real input field", () => {
    expect(() =>
      buildConnector(
        mutation({
          retry: { eligible: true },
          idempotency: { strategy: "key", keyInput: "missingField" },
        }),
        "s",
        ORIGIN,
      ),
    ).toThrow(/is not one of its input fields/);

    const compiled = buildConnector(
      mutation({
        retry: { eligible: true },
        idempotency: { strategy: "key", keyInput: "requestId" },
      }),
      "s",
      ORIGIN,
    );
    // The header defaults to the IETF HTTPAPI draft's name, so an upstream that
    // already speaks the convention needs no per-connector special casing.
    expect(compiled.operations[0]!.reliability.idempotency).toEqual({
      strategy: "key",
      keyInput: "requestId",
      header: "Idempotency-Key",
    });
  });

  it("applies platform defaults and caps the timeout", () => {
    const compiled = buildConnector(definition(), "object-store", ORIGIN);
    const { reliability } = compiled.operations[0]!;
    expect(reliability.timeouts.attemptMs).toBe(30_000);
    // No retries by default, so the overall budget is one attempt.
    expect(reliability.timeouts.totalMs).toBe(30_000);
    expect(reliability.retry.eligible).toBe(false);
    expect(reliability.limits.responseBytes).toBeGreaterThan(0);

    expect(() =>
      buildConnector(mutation({ timeouts: { attemptMs: 600_000 } }), "s", ORIGIN),
    ).toThrow(/must be > 0 and <= 120000/);
  });
});

describe("buildConnector — checksum", () => {
  it("is stable for identical input and moves when the contract changes", () => {
    const a = buildConnector(definition(), "object-store", ORIGIN);
    const b = buildConnector(definition(), "object-store", ORIGIN);
    expect(a.checksum).toBe(b.checksum);

    const changed = buildConnector(
      definition({ title: "Object storage (EU)" }),
      "object-store",
      ORIGIN,
    );
    expect(changed.checksum).not.toBe(a.checksum);
  });
});

describe("connector identifier validation", () => {
  it("rejects a connector name that is not PascalCase", () => {
    expect(() =>
      validateConnectorContentIdentifiers(definition({ connector: "object store" }), ORIGIN),
    ).toThrow(/Unsafe connector name/);
  });

  it("rejects an operation key that could break out of generated code", () => {
    expect(() =>
      validateConnectorContentIdentifiers(
        definition({
          operations: [
            {
              key: "list`; drop",
              kind: "query",
              output: { cardinality: "many", fields: [] },
            },
          ],
        } as Partial<ConnectorDefinition>),
        ORIGIN,
      ),
    ).toThrow(/Unsafe operation key/);
  });

  it("rejects egress entries that are not plain hostnames", () => {
    for (const host of ["https://example.com", "example.com:443", "*", "10.0.0.0/8"]) {
      expect(() =>
        validateConnectorContentIdentifiers(
          definition({ network: { egress: [host] } }),
          ORIGIN,
        ),
      ).toThrow(/Unsafe egress host/);
    }
    expect(() =>
      validateConnectorContentIdentifiers(
        definition({ network: { egress: ["*.example-storage.net", "api.example.com"] } }),
        ORIGIN,
      ),
    ).not.toThrow();
  });

  it("rejects a REST base path that is not a safe segment", () => {
    expect(() =>
      validateConnectorContentIdentifiers(
        definition({ exposure: { rest: { basePath: "../admin" } } }),
        ORIGIN,
      ),
    ).toThrow(/Unsafe rest basePath/);
  });
});

// Temporal's split: one attempt (start-to-close) vs the whole operation
// including retries (schedule-to-close). One number cannot express both.
describe("buildConnector — timeout budgets", () => {
  function retryable(timeouts?: Record<string, unknown>): ConnectorDefinition {
    return definition({
      operations: [
        {
          key: "putObject",
          kind: "mutation",
          authorization: { roles: { invoke: ["W"] } },
          output: { cardinality: "one", fields: [] },
          reliability: {
            retry: { eligible: true, maxAttempts: 3 },
            idempotency: { strategy: "natural" },
            ...(timeouts ? { timeouts } : {}),
          },
        },
      ],
    } as unknown as Partial<ConnectorDefinition>);
  }

  it("defaults the overall budget to what the retries can actually consume", () => {
    const compiled = buildConnector(retryable(), "s", ORIGIN);
    const { timeouts } = compiled.operations[0]!.reliability;
    expect(timeouts.attemptMs).toBe(30_000);
    // 3 attempts × 30s — an author who sets neither still gets a bound.
    expect(timeouts.totalMs).toBe(90_000);
  });

  it("honours an explicit overall budget", () => {
    const compiled = buildConnector(
      retryable({ attemptMs: 5_000, totalMs: 12_000 }),
      "s",
      ORIGIN,
    );
    expect(compiled.operations[0]!.reliability.timeouts).toEqual({
      attemptMs: 5_000,
      totalMs: 12_000,
    });
  });

  it("refuses an overall budget smaller than a single attempt", () => {
    expect(() =>
      buildConnector(retryable({ attemptMs: 30_000, totalMs: 5_000 }), "s", ORIGIN),
    ).toThrow(/cannot be smaller than a single attempt/);
  });

  it("caps the overall budget", () => {
    expect(() =>
      buildConnector(retryable({ attemptMs: 30_000, totalMs: 999_999 }), "s", ORIGIN),
    ).toThrow(/timeouts\.totalMs 999999; must be <= 300000/);
  });
});
