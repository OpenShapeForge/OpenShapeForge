// SPDX-License-Identifier: BUSL-1.1
/**
 * A full round trip through the REAL example connector package.
 *
 * Everything else about connectors is proved against fixtures. This suite
 * proves the parts that only a real package can: that the runtime contract is
 * implementable as designed, that the boot-time handshake accepts a package
 * built to it, and that an invocation flows all the way out through the
 * egress-bound fetch and back through output validation.
 *
 * Writing the example WAS the test of the runtime contract's ergonomics — a
 * shape nobody has implemented is a shape nobody knows is usable.
 *
 * Needs no database: nothing here touches tenant state.
 */
import { describe, expect, test } from "bun:test";
import { listConnectorContracts } from "../catalog.js";
import { loadConnectorPackages } from "../loader.js";
import {
  ConnectorExecutionError,
  invokeOperation,
  type FetchLike,
} from "../executor.js";

const SLUG = "example-object-store";

function contractFor(slug = SLUG) {
  const contract = listConnectorContracts().find((entry) => entry.slug === slug);
  if (!contract) throw new Error(`missing contract ${slug}`);
  return contract;
}

/** A stub upstream that records what the connector actually sent. */
function upstream(handler: (url: URL, init?: RequestInit) => Response): {
  fetch: FetchLike;
  calls: { url: URL; init?: RequestInit }[];
} {
  const calls: { url: URL; init?: RequestInit }[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      calls.push({ url, ...(init ? { init } : {}) });
      return handler(url, init);
    },
  };
}

const CONFIG = { endpoint: "https://eu.objectstore.example", region: "eu-west" };
const SECRETS = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s3cr3t-example" };

async function loadExample() {
  const registry = await loadConnectorPackages([contractFor()]);
  const loaded = registry.loaded.get(SLUG);
  if (!loaded) {
    throw new Error(
      `example connector did not load: ${JSON.stringify(registry.failures)}`,
    );
  }
  return loaded;
}

describe("loading the example package", () => {
  test("resolves and passes the contract handshake", async () => {
    const registry = await loadConnectorPackages([contractFor()]);
    expect(registry.failures).toEqual([]);
    expect(registry.loaded.get(SLUG)?.pkg.slug).toBe(SLUG);
  });

  test("records a missing package as unavailable rather than failing startup", async () => {
    const registry = await loadConnectorPackages([contractFor()], {
      importModule: async () => {
        throw new Error("not installed");
      },
    });
    expect(registry.loaded.size).toBe(0);
    expect(registry.failures[0]?.reason).toBe("package_missing");
  });

  test("refuses a module that does not export a connector", async () => {
    const registry = await loadConnectorPackages([contractFor()], {
      importModule: async () => ({ default: { slug: SLUG } }),
    });
    expect(registry.failures[0]?.reason).toBe("invalid_module");
  });

  // A package shipping behaviour the contract never described is behaviour
  // nobody reviewed.
  test("refuses a package whose operation set does not match the contract", async () => {
    const registry = await loadConnectorPackages([contractFor()], {
      importModule: async () => ({
        default: {
          slug: SLUG,
          contractVersion: 1,
          operations: ["listObjects", "putObject", "deleteEverything"],
          invoke: async () => ({}),
        },
      }),
    });
    expect(registry.failures[0]?.reason).toBe("contract_mismatch");
    expect(registry.failures[0]?.message).toContain("deleteEverything");
  });

  test("refuses a thirdParty contract before importing anything", async () => {
    let imported = false;
    const thirdParty = {
      ...contractFor(),
      implementation: { ...contractFor().implementation, provenance: "thirdParty" as const },
    };
    const registry = await loadConnectorPackages([thirdParty], {
      importModule: async () => {
        imported = true;
        return {};
      },
    });
    expect(registry.failures[0]?.reason).toBe("provenance_refused");
    // Module-level code in an unreviewed package must never run.
    expect(imported).toBe(false);
  });
});

describe("invoking the example package", () => {
  test("lists objects: input in, upstream call out, validated result back", async () => {
    const { contract, pkg, boundary } = await loadExample();
    const operation = contract.operations.find((entry) => entry.key === "listObjects")!;
    const stub = upstream(() =>
      Response.json({ objects: [{ key: "a/1.txt", size: 12 }, { key: "a/2.txt" }] }),
    );

    const result = await invokeOperation({
      contract,
      operation,
      boundary,
      pkg,
      config: CONFIG,
      secrets: SECRETS,
      input: { prefix: "a/", limit: 10 },
      fetchImpl: stub.fetch,
    });

    // The declared output shape, validated on the way back.
    expect(result).toEqual([{ key: "a/1.txt", sizeBytes: 12 }, { key: "a/2.txt" }]);

    const call = stub.calls[0]!;
    expect(call.url.origin).toBe("https://eu.objectstore.example");
    expect(call.url.searchParams.get("prefix")).toBe("a/");
    expect(call.url.searchParams.get("limit")).toBe("10");
  });

  test("credentials reach the upstream and never the caller", async () => {
    const { contract, pkg, boundary } = await loadExample();
    const operation = contract.operations.find((entry) => entry.key === "listObjects")!;
    const stub = upstream(() => Response.json({ objects: [] }));

    await invokeOperation({
      contract,
      operation,
      boundary,
      pkg,
      config: CONFIG,
      secrets: SECRETS,
      input: {},
      fetchImpl: stub.fetch,
    });

    const sent = new Headers(stub.calls[0]?.init?.headers as HeadersInit);
    expect(sent.get("authorization")).toBe(
      `Basic ${btoa(`${SECRETS.accessKeyId}:${SECRETS.secretAccessKey}`)}`,
    );
  });

  // The contract declares idempotency strategy `key` on requestId, which is
  // what makes putObject retry-eligible. Forwarding it is the package's side of
  // that bargain.
  test("forwards the idempotency key on the retry-eligible mutation", async () => {
    const { contract, pkg, boundary } = await loadExample();
    const operation = contract.operations.find((entry) => entry.key === "putObject")!;
    expect(operation.reliability.idempotency?.keyInput).toBe("requestId");

    const stub = upstream(() => Response.json({ ok: true }));
    await invokeOperation({
      contract,
      operation,
      boundary,
      pkg,
      config: CONFIG,
      secrets: SECRETS,
      input: { key: "a/1.txt", requestId: "req-123" },
      fetchImpl: stub.fetch,
    });

    const sent = new Headers(stub.calls[0]?.init?.headers as HeadersInit);
    expect(sent.get("Idempotency-Key")).toBe("req-123");
  });

  test("rejects input the contract does not allow, before the package runs", async () => {
    const { contract, pkg, boundary } = await loadExample();
    const operation = contract.operations.find((entry) => entry.key === "listObjects")!;
    const stub = upstream(() => Response.json({ objects: [] }));

    await expect(
      invokeOperation({
        contract,
        operation,
        boundary,
        pkg,
        config: CONFIG,
        secrets: SECRETS,
        input: { limit: 9000 },
        fetchImpl: stub.fetch,
      }),
    ).rejects.toThrow(/limit/);
    expect(stub.calls).toHaveLength(0);
  });

  test("refuses a host the contract does not declare", async () => {
    const { contract, pkg, boundary } = await loadExample();
    const operation = contract.operations.find((entry) => entry.key === "listObjects")!;
    const stub = upstream(() => Response.json({ objects: [] }));

    try {
      await invokeOperation({
        contract,
        operation,
        boundary,
        pkg,
        // A misconfigured endpoint outside network.egress.
        config: { ...CONFIG, endpoint: "https://attacker.example" },
        secrets: SECRETS,
        input: {},
        fetchImpl: stub.fetch,
      });
      throw new Error("expected an egress refusal");
    } catch (error) {
      // Surfaced as our own code, not as an opaque upstream failure.
      expect((error as ConnectorExecutionError).code).toBe("CONNECTOR_EGRESS_DENIED");
    }
    expect(stub.calls).toHaveLength(0);
  });

  test("normalizes and redacts an upstream failure", async () => {
    const { contract, pkg, boundary } = await loadExample();
    const operation = contract.operations.find((entry) => entry.key === "listObjects")!;
    const stub = upstream(() => new Response("internal detail", { status: 503 }));

    try {
      await invokeOperation({
        contract,
        operation,
        boundary,
        pkg,
        config: CONFIG,
        secrets: SECRETS,
        input: {},
        fetchImpl: stub.fetch,
      });
      throw new Error("expected a failure");
    } catch (error) {
      const message = (error as Error).message;
      expect((error as ConnectorExecutionError).code).toBe(
        "CONNECTOR_PROVIDER_UNAVAILABLE",
      );
      expect((error as ConnectorExecutionError).outcome).toMatchObject({
        category: "availability",
        retryable: false,
        requiredAction: "wait",
      });
      expect(message).not.toContain("503");
      expect(message).not.toContain("internal detail");
    }
  });

  test("rejects a package result that does not match the declared output", async () => {
    const { contract, boundary } = await loadExample();
    const operation = contract.operations.find((entry) => entry.key === "listObjects")!;
    const rogue = {
      slug: SLUG,
      contractVersion: 1,
      operations: ["listObjects", "putObject"],
      // Declares an array output; returns an object.
      invoke: async () => ({ key: "a" }),
    };

    await expect(
      invokeOperation({
        contract,
        operation,
        boundary,
        pkg: rogue,
        config: CONFIG,
        secrets: SECRETS,
        input: {},
        fetchImpl: upstream(() => Response.json({})).fetch,
      }),
    ).rejects.toThrow(/must be array/);
  });
});
