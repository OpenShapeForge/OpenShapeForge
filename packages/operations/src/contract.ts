// SPDX-License-Identifier: BUSL-1.1

/** Stable reference shared by definitions, offers and interface projections. */
export type OperationReference<TIntent extends string = string> = {
  id: string;
  intent: TIntent;
};

export type OperationConfirmationBinding =
  | "subject"
  | "tenant"
  | "operation"
  | "target.id"
  | "target.version";

export type OperationConfirmation =
  | { mode: "none" }
  | { mode: "explicit" }
  | {
      mode: "challenge";
      challenge: {
        kind: "type-current-field";
        field: string;
        issuedBy: "server";
        bindTo: readonly [
          "subject",
          "tenant",
          "operation",
          "target.id",
          "target.version",
        ];
        /** ISO 8601 duration, for example PT5M. */
        expiresAfter: string;
        singleUse: true;
      };
    };

export type OperationViolation = {
  field?: string;
  code: string;
  message: string;
  detail?: string;
};

/**
 * Safe, transport-independent failure meaning. Messages and data must be
 * server-authored and safe for both people and assistants.
 */
export type OperationError = {
  code: string;
  message: string;
  detail?: string;
  violations?: readonly OperationViolation[];
  retryable: boolean;
  /** RFC 3339 instant minted or validated by the server. */
  retryAt?: string;
  data?: Readonly<Record<string, unknown>>;
};

export type OperationOffer<TIntent extends string = string> =
  | {
      operation: OperationReference<TIntent>;
      available: true;
    }
  | {
      operation: OperationReference<TIntent>;
      available: false;
      error: OperationError;
    };

/** The canonical success envelope projected unchanged by every interface. */
export type OperationEnvelope<TData, TIntent extends string = string> = {
  data: TData;
  operations: readonly OperationOffer<TIntent>[];
};

/** Validation is one failure category in this same result contract. */
export type OperationResult<TData, TIntent extends string = string> =
  | OperationEnvelope<TData, TIntent>
  | { error: OperationError };

/**
 * Internal control flow for code below the OperationResult boundary. It carries
 * only canonical failure meaning; transports attach protocol status/codes.
 */
export class OperationFailure extends Error {
  readonly operationError: OperationError;

  constructor(error: OperationError) {
    super(error.message);
    this.name = "OperationFailure";
    this.operationError = error;
  }
}

export function operationFailure(
  error: Omit<OperationError, "retryable"> & { retryable?: boolean },
): OperationFailure {
  return new OperationFailure({ ...error, retryable: error.retryable ?? false });
}

export function operationErrorOf(error: unknown): OperationError | undefined {
  return error instanceof OperationFailure ? error.operationError : undefined;
}

export function isOperationFailure<TData, TIntent extends string>(
  result: OperationResult<TData, TIntent>,
): result is { error: OperationError } {
  return "error" in result;
}
