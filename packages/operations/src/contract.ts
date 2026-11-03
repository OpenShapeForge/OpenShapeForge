// SPDX-License-Identifier: BUSL-1.1

/** Stable reference shared by definitions, offers and interface projections. */
export type OperationReference<TIntent extends string = string> = {
  id: string;
  intent: TIntent;
};

/** A canonical prerequisite whose completion is proven by the core host. */
export type OperationPrerequisite = {
  operation: string;
  receipt: { binding: "loginSession" };
};

export type OperationConfirmationBinding =
  | "subject"
  | "tenant"
  | "operation"
  | "target.id"
  | "target.version";

export type OperationConfirmation =
  | { mode: "none" }
  | {
      /**
       * The caller must acknowledge this operation in the same request.
       * This prevents accidental invocation, but is not server-issued proof.
       */
      mode: "acknowledgement";
    }
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

/**
 * Interface-neutral concurrency guarantees enforced by an Operation runtime.
 * Interfaces only carry the required control values; they never own lease or
 * version semantics.
 */
export type OperationConcurrency = {
  version?: {
    mode: "required";
    /** Generated CRUD's canonical read-only datetime version token. */
    field: "updatedAt";
  };
  editLease?: {
    mode: "required";
    /** ISO 8601 duration, measured from the last accepted editor activity. */
    expiresAfterInactivity: string;
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

type OperationInteractionChoiceBase = {
  value: string;
  label: string;
  description?: string;
};

/**
 * A server-authored choice. Existing choices are available by default;
 * unavailable choices remain visible with the same canonical refusal clients
 * already render for unavailable Operations.
 */
export type OperationInteractionChoice =
  | (OperationInteractionChoiceBase & {
      available?: true;
      error?: never;
    })
  | (OperationInteractionChoiceBase & {
      available: false;
      error: OperationError;
    });

export type OperationInteractionBinding = {
  /** Server-verified tenant and subject bindings are mandatory. */
  tenant: string;
  subject: string;
  target?: string;
  instance?: string;
  node?: string;
  version?: string;
};

/**
 * Server-derived record binding for an available Operation. Clients may use
 * the input fragment as a form default, but the runtime re-resolves and
 * authorizes the target before execution.
 */
export type OperationTargetBinding = {
  target: {
    entityId: string;
    id: string;
    version?: string;
  };
  input: Readonly<Record<string, unknown>>;
};
/** Module Operations may bind server-owned input without claiming an Entity target.
 * This fragment is a form default; it carries no record authorization or lease. */
export type OperationInputBinding = {
  target?: never;
  input: Readonly<Record<string, unknown>>;
};

type OperationInteractionBase = {
  /** Opaque, server-issued identifier; clients must never mint or reinterpret it. */
  offerId: string;
  expiresAt: string;
  bindTo: OperationInteractionBinding;
};

/**
 * Temporary, server-authored input carried by an available Operation offer.
 * Secure input always has a schema; workflow user input may be schema-driven
 * or a finite set of choices. Transports only render and return the answer.
 */
export type OperationInteraction =
  | (OperationInteractionBase & {
      kind: "secureInput";
      inputSchema: Readonly<Record<string, unknown>>;
      choices?: readonly OperationInteractionChoice[];
    })
  | (OperationInteractionBase & {
      kind: "userInput";
      inputSchema: Readonly<Record<string, unknown>>;
      choices?: readonly OperationInteractionChoice[];
    })
  | (OperationInteractionBase & {
      kind: "userInput";
      choices: readonly OperationInteractionChoice[];
      inputSchema?: Readonly<Record<string, unknown>>;
    });

export type OperationOffer<TIntent extends string = string> =
  | {
      operation: OperationReference<TIntent>;
      available: true;
      binding?: OperationTargetBinding | OperationInputBinding;
      interaction?: OperationInteraction;
      /** Canonical controls and lease timing for this currently available Operation. */
      concurrency?: OperationConcurrency;
    }
  | {
      operation: OperationReference<TIntent>;
      available: false;
      error: OperationError;
    };

/** Transport-neutral reference to a server-authorized result artifact. */
export type OperationResourceReference = {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

/** The canonical success envelope projected unchanged by every interface. */
export type OperationEnvelope<TData, TIntent extends string = string> = {
  data: TData;
  operations: readonly OperationOffer<TIntent>[];
  /** Optional bounded resources; adapters decide only how to render the links. */
  resources?: readonly OperationResourceReference[];
};

/**
 * Who took an Operation over: the owner's kind (for example `workflow`) and
 * its own reference to the work it started (for example a run id).
 */
export type OperationAcceptedBy = { kind: string; ref: string };

/**
 * The Operation was taken over by another owner (an operation override) and
 * answered before the original effect happened. `running` and `waiting` mean
 * the owner's work is still under way and the change happens, if at all, when
 * it completes; `completed` means the owner's work already finished when it
 * answered. None of them carries the original's own output.
 */
export type OperationAcceptance = {
  by: OperationAcceptedBy;
  status: "running" | "waiting" | "completed";
};

/**
 * The third result arm: neither the original's data nor a failure. It has no
 * `data` and no `error` member, so `isOperationFailure` stays false; a reader
 * of `data` sees it absent and should rule this arm out with
 * `isOperationAccepted` before treating a missing value as "not found".
 *
 * `error` is deliberately not declared, not even as `never`: an optional
 * member keeps this arm on both sides of an `"error" in result` check, so
 * every consumer that narrows a failure that way would see `error` as
 * possibly undefined.
 */
export type OperationAccepted<TIntent extends string = string> = {
  accepted: OperationAcceptance;
  operations: readonly OperationOffer<TIntent>[];
  /** Never present; declared so a reader of `data` must handle its absence. */
  data?: never;
};

/** Validation is one failure category in this same result contract. */
export type OperationResult<TData, TIntent extends string = string> =
  | OperationEnvelope<TData, TIntent>
  | { error: OperationError }
  | OperationAccepted<TIntent>;

/**
 * Internal control flow for code below the OperationResult boundary. It carries
 * only canonical failure meaning; transports attach protocol status/codes.
 */
const OPERATION_FAILURE_BRAND = Symbol.for("openshapeforge.OperationFailure.v1");

export class OperationFailure extends Error {
  readonly operationError: OperationError;

  constructor(error: OperationError) {
    super(error.message);
    this.name = "OperationFailure";
    this.operationError = error;
    Object.defineProperty(this, OPERATION_FAILURE_BRAND, { value: true });
  }
}

export function operationFailure(
  error: Omit<OperationError, "retryable"> & { retryable?: boolean },
): OperationFailure {
  return new OperationFailure({ ...error, retryable: error.retryable ?? false });
}

export function operationErrorOf(error: unknown): OperationError | undefined {
  if (!(error instanceof Error)) return undefined;
  // A packaged plugin and its host can load separate copies of this package.
  // Constructor identity is local to a copy; the non-JSON brand is shared.
  if (
    !(error instanceof OperationFailure) &&
    Object.getOwnPropertyDescriptor(error, OPERATION_FAILURE_BRAND)?.value !== true
  ) return undefined;
  const value: unknown = Object.getOwnPropertyDescriptor(error, "operationError")?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as OperationError;
  return typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean"
    ? candidate
    : undefined;
}

export function isOperationFailure<TData, TIntent extends string>(
  result: OperationResult<TData, TIntent>,
): result is { error: OperationError } {
  return "error" in result;
}

export function isOperationAccepted<TData, TIntent extends string>(
  result: OperationResult<TData, TIntent>,
): result is OperationAccepted<TIntent> {
  return "accepted" in result && !("error" in result) && !("data" in result);
}
