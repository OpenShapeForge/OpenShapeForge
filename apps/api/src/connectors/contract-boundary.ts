// SPDX-License-Identifier: BUSL-1.1
/**
 * The runtime boundary between the platform and a connector implementation
 * package.
 *
 * A connector package is written by someone else, versioned separately, and —
 * depending on the deployment's trust model — possibly not reviewed by us at
 * all. Everything crossing this boundary is untrusted in both directions:
 *
 *   handshake  — does this package implement exactly the contract we compiled?
 *   input      — validated before the package is called
 *   output     — validated before anything reaches a caller
 *   errors     — redacted; upstream text and stack traces never leave here
 *
 * Generated TypeScript types cannot do any of this: they are erased before a
 * package is ever loaded. The schemas come from the compiled catalog, which
 * shares its constraint mapping with the MCP tool catalog, so what a caller is
 * told an operation accepts and what the boundary enforces cannot drift apart.
 *
 * This module executes no packages. It is the boundary the execution stages
 * stand on; loading and invoking real packages is gated on the deployment's
 * execution trust model.
 */
import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

/** Shape a compiled connector operation presents to this boundary. */
export type BoundaryOperation = {
  key: string;
  schemas: { input: Record<string, unknown>; output: Record<string, unknown> };
};

export type BoundaryContract = {
  slug: string;
  implementation: { contractVersion: number };
  checksum: string;
  operations: BoundaryOperation[];
};

/** What a package declares about itself at load time. */
export type PackageDescriptor = {
  slug?: unknown;
  contractVersion?: unknown;
  contractChecksum?: unknown;
  operations?: unknown;
};

export type BoundaryErrorCode =
  | "CONNECTOR_CONTRACT_MISMATCH"
  | "CONNECTOR_INVALID_INPUT"
  | "CONNECTOR_INVALID_OUTPUT";

/**
 * A boundary failure. `message` is safe to return to a caller: it names the
 * connector, the operation and the schema path, never a value. Values can carry
 * secrets (a misdirected credential, a customer record) and upstream text can
 * carry a third-party stack trace.
 */
export class ConnectorBoundaryError extends Error {
  readonly code: BoundaryErrorCode;
  readonly connector: string;
  readonly operation?: string;

  constructor(
    code: BoundaryErrorCode,
    connector: string,
    message: string,
    operation?: string,
  ) {
    super(message);
    this.name = "ConnectorBoundaryError";
    this.code = code;
    this.connector = connector;
    if (operation !== undefined) this.operation = operation;
  }
}

/**
 * Ajv in strict-schema mode would reject our own generated schemas over
 * annotations it does not recognise; `strict: false` keeps validation semantics
 * while tolerating them. `allErrors` lets one rejection report every violation
 * rather than trickling them out one request at a time.
 */
function createAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false });
  // ajv-formats is CJS; under NodeNext the default import is typed as the
  // module namespace rather than the callable it is at runtime.
  (addFormats as unknown as (instance: Ajv) => unknown)(ajv);
  return ajv;
}

/**
 * Render ajv errors without any instance values.
 *
 * `instancePath` and the rule are enough to fix a payload; `data` is not ours
 * to echo. This is the difference between "/apiKey must match pattern" and
 * leaking the key into a log aggregator.
 */
function describeErrors(validate: ValidateFunction): string {
  const errors = validate.errors ?? [];
  if (errors.length === 0) return "schema validation failed";
  return errors
    .map((error) => {
      const path = error.instancePath === "" ? "(root)" : error.instancePath;
      const detail =
        error.keyword === "additionalProperties" &&
        typeof error.params?.additionalProperty === "string"
          ? `unknown property "${error.params.additionalProperty}"`
          : (error.message ?? "is invalid");
      return `${path} ${detail}`;
    })
    .sort()
    .join("; ");
}

/**
 * Compiles every operation's input and output schema once per contract.
 *
 * Compilation is the expensive half of validation, and an operation's schema
 * never changes for the lifetime of a build — recompiling per request would put
 * that cost on the hot path for no benefit.
 */
export class ConnectorContractBoundary {
  private readonly inputValidators = new Map<string, ValidateFunction>();
  private readonly outputValidators = new Map<string, ValidateFunction>();

  constructor(private readonly contract: BoundaryContract) {
    const ajv = createAjv();
    for (const operation of contract.operations) {
      this.inputValidators.set(operation.key, ajv.compile(operation.schemas.input));
      this.outputValidators.set(operation.key, ajv.compile(operation.schemas.output));
    }
  }

  /**
   * Assert a package implements exactly this contract, before anything from it
   * is trusted.
   *
   * Both directions are errors. A missing operation means a caller would get a
   * runtime failure from a surface the platform advertises. An UNEXPECTED
   * operation means the package ships behaviour the contract never described —
   * unreviewed, unauthorized, and invisible to every audit that reads the
   * contract. Neither is adapted or coerced.
   */
  assertPackageMatches(descriptor: PackageDescriptor): void {
    const { slug } = this.contract;

    if (descriptor.slug !== slug) {
      throw new ConnectorBoundaryError(
        "CONNECTOR_CONTRACT_MISMATCH",
        slug,
        `Package declares slug ${JSON.stringify(descriptor.slug)}, expected "${slug}".`,
      );
    }

    const expectedVersion = this.contract.implementation.contractVersion;
    if (descriptor.contractVersion !== expectedVersion) {
      throw new ConnectorBoundaryError(
        "CONNECTOR_CONTRACT_MISMATCH",
        slug,
        `Package implements contract version ${JSON.stringify(descriptor.contractVersion)}, ` +
          `this build compiled version ${expectedVersion}.`,
      );
    }

    // Optional: a package may pin the exact contract it was built against.
    if (
      descriptor.contractChecksum !== undefined &&
      descriptor.contractChecksum !== this.contract.checksum
    ) {
      throw new ConnectorBoundaryError(
        "CONNECTOR_CONTRACT_MISMATCH",
        slug,
        "Package was built against a different version of this connector contract.",
      );
    }

    if (!Array.isArray(descriptor.operations)) {
      throw new ConnectorBoundaryError(
        "CONNECTOR_CONTRACT_MISMATCH",
        slug,
        "Package does not declare its operation set.",
      );
    }
    for (const key of descriptor.operations) {
      if (typeof key !== "string") {
        throw new ConnectorBoundaryError(
          "CONNECTOR_CONTRACT_MISMATCH",
          slug,
          "Package operation set must contain only operation keys.",
        );
      }
    }

    const declared = new Set(descriptor.operations as string[]);
    const expected = new Set(this.contract.operations.map((operation) => operation.key));
    const missing = [...expected].filter((key) => !declared.has(key)).sort();
    const unexpected = [...declared].filter((key) => !expected.has(key)).sort();

    if (missing.length > 0 || unexpected.length > 0) {
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`missing ${missing.join(", ")}`);
      if (unexpected.length > 0) parts.push(`undeclared ${unexpected.join(", ")}`);
      throw new ConnectorBoundaryError(
        "CONNECTOR_CONTRACT_MISMATCH",
        slug,
        `Package operation set does not match the contract: ${parts.join("; ")}.`,
      );
    }
  }

  private validator(
    map: Map<string, ValidateFunction>,
    operationKey: string,
  ): ValidateFunction {
    const validate = map.get(operationKey);
    if (!validate) {
      throw new ConnectorBoundaryError(
        "CONNECTOR_CONTRACT_MISMATCH",
        this.contract.slug,
        `Operation "${operationKey}" is not part of this connector's contract.`,
        operationKey,
      );
    }
    return validate;
  }

  /** Validate caller input before the package is invoked. */
  assertValidInput(operationKey: string, input: unknown): void {
    const validate = this.validator(this.inputValidators, operationKey);
    if (!validate(input ?? {})) {
      throw new ConnectorBoundaryError(
        "CONNECTOR_INVALID_INPUT",
        this.contract.slug,
        `Input for "${operationKey}" is invalid: ${describeErrors(validate)}.`,
        operationKey,
      );
    }
  }

  /**
   * Validate package output before it reaches a caller.
   *
   * A package that returns the wrong shape is a defect on their side, but the
   * consequence lands on ours: an unvalidated payload flows into a GraphQL
   * response, an MCP tool result, or a model's context.
   */
  assertValidOutput(operationKey: string, output: unknown): void {
    const validate = this.validator(this.outputValidators, operationKey);
    if (!validate(output)) {
      throw new ConnectorBoundaryError(
        "CONNECTOR_INVALID_OUTPUT",
        this.contract.slug,
        `Connector "${this.contract.slug}" returned an invalid result for ` +
          `"${operationKey}": ${describeErrors(validate)}.`,
        operationKey,
      );
    }
  }
}
