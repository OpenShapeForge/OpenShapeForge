// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import {
  ConnectorBoundaryError,
  ConnectorContractBoundary,
  type BoundaryContract,
} from "../contract-boundary.js";

/** Mirrors what the compiler emits for a two-operation connector. */
const CONTRACT: BoundaryContract = {
  slug: "object-store",
  implementation: { contractVersion: 1 },
  checksum: "abc123",
  operations: [
    {
      key: "listObjects",
      schemas: {
        input: {
          type: "object",
          properties: {
            prefix: { type: "string", maxLength: 100 },
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          additionalProperties: false,
        },
        output: {
          type: "array",
          items: {
            type: "object",
            properties: { key: { type: "string" }, size: { type: "integer" } },
            required: ["key"],
            additionalProperties: false,
          },
        },
      },
    },
    {
      key: "putObject",
      schemas: {
        input: {
          type: "object",
          properties: {
            key: { type: "string", minLength: 1 },
            apiKey: { type: "string", pattern: "^sk-[a-z0-9]+$" },
          },
          required: ["key"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: { key: { type: "string" } },
          additionalProperties: false,
        },
      },
    },
  ],
};

const boundary = new ConnectorContractBoundary(CONTRACT);

const validDescriptor = {
  slug: "object-store",
  contractVersion: 1,
  operations: ["listObjects", "putObject"],
};

describe("package handshake", () => {
  it("accepts a package that matches the contract exactly", () => {
    expect(() => boundary.assertPackageMatches(validDescriptor)).not.toThrow();
  });

  it("accepts a package that pins the matching contract checksum", () => {
    expect(() =>
      boundary.assertPackageMatches({ ...validDescriptor, contractChecksum: "abc123" }),
    ).not.toThrow();
  });

  it("rejects a package built against a different contract checksum", () => {
    expect(() =>
      boundary.assertPackageMatches({ ...validDescriptor, contractChecksum: "stale" }),
    ).toThrow(/built against a different version/);
  });

  it("rejects a slug mismatch", () => {
    expect(() =>
      boundary.assertPackageMatches({ ...validDescriptor, slug: "something-else" }),
    ).toThrow(/expected "object-store"/);
  });

  it("rejects a contract version mismatch rather than adapting", () => {
    expect(() =>
      boundary.assertPackageMatches({ ...validDescriptor, contractVersion: 2 }),
    ).toThrow(/this build compiled version 1/);
  });

  it("rejects a package missing a declared operation", () => {
    expect(() =>
      boundary.assertPackageMatches({ ...validDescriptor, operations: ["listObjects"] }),
    ).toThrow(/missing putObject/);
  });

  // An undeclared operation is behaviour the contract never described: not
  // reviewed, not authorized, invisible to anyone auditing the contract.
  it("rejects a package shipping an operation the contract does not declare", () => {
    expect(() =>
      boundary.assertPackageMatches({
        ...validDescriptor,
        operations: [...validDescriptor.operations, "deleteEverything"],
      }),
    ).toThrow(/undeclared deleteEverything/);
  });

  it("rejects a package that does not declare its operation set at all", () => {
    const { operations: _omitted, ...withoutOperations } = validDescriptor;
    expect(() => boundary.assertPackageMatches(withoutOperations)).toThrow(
      /does not declare its operation set/,
    );
  });

  it("reports mismatches with a stable error code", () => {
    try {
      boundary.assertPackageMatches({ ...validDescriptor, slug: "nope" });
      throw new Error("expected a boundary error");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorBoundaryError);
      expect((error as ConnectorBoundaryError).code).toBe("CONNECTOR_CONTRACT_MISMATCH");
    }
  });
});

describe("input validation", () => {
  it("accepts valid input and an absent input object", () => {
    expect(() => boundary.assertValidInput("listObjects", { prefix: "a/" })).not.toThrow();
    expect(() => boundary.assertValidInput("listObjects", undefined)).not.toThrow();
  });

  it("rejects an unknown property instead of dropping it", () => {
    expect(() =>
      boundary.assertValidInput("listObjects", { prefix: "a/", sneaky: true }),
    ).toThrow(/unknown property "sneaky"/);
  });

  it("enforces 2020-12 unevaluatedProperties closure", () => {
    const strictBoundary = new ConnectorContractBoundary({
      slug: "strict-object",
      implementation: { contractVersion: 1 },
      checksum: "strict",
      operations: [
        {
          key: "write",
          schemas: {
            input: {
              type: "object",
              allOf: [{ properties: { known: { type: "string" } } }],
              unevaluatedProperties: false,
            },
            output: { type: "object" },
          },
        },
      ],
    });

    expect(() => strictBoundary.assertValidInput("write", { known: "ok" })).not.toThrow();
    expect(() =>
      strictBoundary.assertValidInput("write", { known: "ok", unexpected: true }),
    ).toThrow(/unknown property "unexpected"/);
  });

  it("rejects a violated bound and a missing required field", () => {
    expect(() => boundary.assertValidInput("listObjects", { limit: 9000 })).toThrow(
      /\/limit .*<= 500/,
    );
    expect(() => boundary.assertValidInput("putObject", {})).toThrow(/required/);
  });

  it("rejects an operation outside the contract", () => {
    expect(() => boundary.assertValidInput("noSuchOperation", {})).toThrow(
      /not part of this connector's contract/,
    );
  });

  // The whole point of redaction: a bad value must never end up in an error
  // string, because that string reaches logs and clients.
  it("never echoes the offending value", () => {
    // Violates the pattern (uppercase), so validation fails and the message is
    // the thing under test.
    const secret = "sk-SUPERSECRETVALUE";
    try {
      boundary.assertValidInput("putObject", { key: "k", apiKey: secret });
      throw new Error("expected a boundary error");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(secret);
      expect(message).toContain("/apiKey");
      expect((error as ConnectorBoundaryError).code).toBe("CONNECTOR_INVALID_INPUT");
    }
  });
});

describe("output validation", () => {
  it("accepts a well-formed result", () => {
    expect(() =>
      boundary.assertValidOutput("listObjects", [{ key: "a", size: 1 }]),
    ).not.toThrow();
  });

  it("rejects a bare object where the contract promised a list", () => {
    expect(() => boundary.assertValidOutput("listObjects", { key: "a" })).toThrow(
      /must be array/,
    );
  });

  it("rejects rows missing a required field", () => {
    expect(() => boundary.assertValidOutput("listObjects", [{ size: 1 }])).toThrow(
      /CONNECTOR|required/,
    );
  });

  it("rejects extra properties a package invented", () => {
    expect(() =>
      boundary.assertValidOutput("listObjects", [{ key: "a", leaked: "internal" }]),
    ).toThrow(/unknown property "leaked"/);
  });

  it("names the connector and operation, with a stable code", () => {
    try {
      boundary.assertValidOutput("putObject", { key: 42 });
      throw new Error("expected a boundary error");
    } catch (error) {
      const boundaryError = error as ConnectorBoundaryError;
      expect(boundaryError.code).toBe("CONNECTOR_INVALID_OUTPUT");
      expect(boundaryError.connector).toBe("object-store");
      expect(boundaryError.operation).toBe("putObject");
    }
  });

  it("does not echo values a package returned", () => {
    const leaked = "internal-hostname.corp.example";
    try {
      boundary.assertValidOutput("putObject", { key: "a", debug: leaked });
      throw new Error("expected a boundary error");
    } catch (error) {
      expect((error as Error).message).not.toContain(leaked);
    }
  });
});
