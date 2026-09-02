// SPDX-License-Identifier: BUSL-1.1
/**
 * Normalized provider failures, and the one place every transport reads a
 * status for a connector error code.
 *
 * A connector package that fails used to be redacted into a single
 * `CONNECTOR_UPSTREAM_ERROR`, which was safe and useless: a provider `429`
 * lost its retry timing, a permission failure looked like an outage, and a
 * caller could not tell whether to wait, change its input, or find an
 * administrator. This module classifies a failure from what the platform
 * itself observed — the numeric status and a `Retry-After` header of the last
 * non-success response the bound fetch saw — and nothing the package or the
 * provider said. Bodies, messages, headers, URLs and request ids never enter
 * the observation, so they cannot leave through it.
 *
 * The classification is deliberately not a `fetch` semantic: a package may
 * absorb a non-success probe and still return a result, and that result is a
 * success. Observations only matter once the package has thrown.
 *
 * Pure by design. The audit and metric side effects live with the runtime;
 * the REST error mapper and the MCP failure renderer import this file, so it
 * must not pull the world in behind it.
 */
import type { ConnectorAuthErrorCode } from "./authorization.js";
import type { BoundaryErrorCode } from "./contract-boundary.js";
import type { ConnectorExecutionErrorCode } from "./executor.js";
import type { ModuleEgressFailureKind } from "../modules/contract.js";

export type ConnectorProviderOutcomeCode =
  | "CONNECTOR_EGRESS_DENIED"
  | "CONNECTOR_TIMEOUT"
  | "CONNECTOR_PROVIDER_REJECTED_INPUT"
  | "CONNECTOR_PROVIDER_AUTHORIZATION_FAILED"
  | "CONNECTOR_PROVIDER_PERMISSION_DENIED"
  | "CONNECTOR_PROVIDER_RATE_LIMITED"
  | "CONNECTOR_PROVIDER_UNAVAILABLE"
  | "CONNECTOR_UPSTREAM_ERROR";

export type ConnectorProviderOutcomeCategory =
  | "policy_blocked"
  | "timeout"
  | "input"
  | "authorization"
  | "rate_limit"
  | "availability"
  | "provider_contract";

export type ConnectorProviderRequiredAction = "wait" | "change_input" | "contact_admin";

/** The stable safe shape every classified connector failure exposes. */
export type ConnectorProviderOutcome = {
  code: ConnectorProviderOutcomeCode;
  category: ConnectorProviderOutcomeCategory;
  retryable: boolean;
  /** RFC 3339 UTC instant, server-minted; the only retry-time representation on the wire. */
  retryAt?: string;
  requiredAction: ConnectorProviderRequiredAction;
  correlationId: string;
};

export const PROVIDER_OUTCOME_CODES: readonly ConnectorProviderOutcomeCode[] = [
  "CONNECTOR_EGRESS_DENIED",
  "CONNECTOR_TIMEOUT",
  "CONNECTOR_PROVIDER_REJECTED_INPUT",
  "CONNECTOR_PROVIDER_AUTHORIZATION_FAILED",
  "CONNECTOR_PROVIDER_PERMISSION_DENIED",
  "CONNECTOR_PROVIDER_RATE_LIMITED",
  "CONNECTOR_PROVIDER_UNAVAILABLE",
  "CONNECTOR_UPSTREAM_ERROR",
];

const CATEGORIES: readonly ConnectorProviderOutcomeCategory[] = [
  "policy_blocked",
  "timeout",
  "input",
  "authorization",
  "rate_limit",
  "availability",
  "provider_contract",
];

const REQUIRED_ACTIONS: readonly ConnectorProviderRequiredAction[] = [
  "wait",
  "change_input",
  "contact_admin",
];

/* -------------------------------------------------------------------------- */
/* Observation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Everything the platform retains about one non-success provider response.
 * Closed on purpose: adding a field here is adding something a caller may
 * later be shown.
 */
export type ProviderResponseObservation = {
  status: number;
  /** A syntactically valid `Retry-After` value, verbatim; never surfaced. */
  retryAfter?: string;
  correlationId: string;
};

const MAX_RETRY_AFTER_LENGTH = 64;
const HTTP_DATE_PATTERNS = [
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/,
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/,
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4}$/,
] as const;

/**
 * Keep a `Retry-After` header value only when it is one of the two legal
 * forms — delta-seconds or an HTTP-date — so an arbitrary header can never be
 * retained under this name.
 */
export function retainableRetryAfter(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  // RFC 9110 defines delta-seconds as 1*DIGIT, with no lexical length cap.
  // Keep that distinction here: the conversion below bounds the normalized
  // numeric value before it ever reaches Number, so leading zeroes and an
  // arbitrarily long but syntactically valid value are both safe.
  if (/^\d+$/.test(trimmed)) return trimmed;
  if (trimmed.length > MAX_RETRY_AFTER_LENGTH) return undefined;
  return HTTP_DATE_PATTERNS.some((pattern) => pattern.test(trimmed)) &&
    Number.isFinite(Date.parse(trimmed))
    ? trimmed
    : undefined;
}

/** Response fields an observation reads; structural so tests need no `Response`. */
export type ObservableResponse = {
  status: number;
  headers: { get(name: string): string | null };
};

/**
 * Records non-success responses for one invocation and answers with the most
 * recent one. A package that probes, absorbs a `404`, then succeeds leaves its
 * observation unread — the executor only consults it after a throw.
 */
export class ProviderObservations {
  private latest: ProviderResponseObservation | undefined;

  constructor(readonly correlationId: string) {}

  observe(response: ObservableResponse): void {
    if (response.status < 400) return;
    const retryAfter = retainableRetryAfter(response.headers.get("retry-after"));
    this.latest = {
      status: response.status,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
      correlationId: this.correlationId,
    };
  }

  last(): ProviderResponseObservation | undefined {
    return this.latest;
  }
}

/* -------------------------------------------------------------------------- */
/* Retry timing                                                               */
/* -------------------------------------------------------------------------- */

/** A retry hint further out than this is not believed; the outcome keeps `wait` without a time. */
export const RETRY_AT_HORIZON_MS = 24 * 60 * 60 * 1000;

/** Parse delta-seconds only after a decimal string comparison bounds it. */
function boundedDeltaSeconds(value: string): number | undefined {
  const normalized = value.replace(/^0+/, "") || "0";
  const horizon = String(RETRY_AT_HORIZON_MS / 1000);
  if (
    normalized.length > horizon.length ||
    (normalized.length === horizon.length && normalized > horizon)
  ) {
    return undefined;
  }
  return Number(normalized);
}

/**
 * Convert a retained `Retry-After` into one server-minted RFC 3339 instant.
 * Invalid, negative, past and over-horizon values yield nothing rather than a
 * time a caller would sleep on.
 */
export function retryAtFromRetryAfter(
  value: string | undefined,
  now: number,
): string | undefined {
  const retained = retainableRetryAfter(value);
  if (retained === undefined) return undefined;
  const isDeltaSeconds = /^\d+$/.test(retained);
  const seconds = isDeltaSeconds ? boundedDeltaSeconds(retained) : undefined;
  if (isDeltaSeconds && seconds === undefined) return undefined;
  const at = isDeltaSeconds ? now + seconds! * 1000 : Date.parse(retained);
  if (!Number.isFinite(at) || at <= now) return undefined;
  if (at - now > RETRY_AT_HORIZON_MS) return undefined;
  return new Date(at).toISOString();
}

/* -------------------------------------------------------------------------- */
/* Package hint                                                               */
/* -------------------------------------------------------------------------- */

/** Property a thrown package error carries its hint under. */
export const PROVIDER_FAILURE_HINT_PROPERTY = "providerFailure";

/**
 * What a package may say about a failure it saw. It names the status it is
 * talking about — which must match what the platform observed — and may only
 * pick a more specific code the status allows, or withdraw retryability.
 */
export type ConnectorProviderFailureHint = {
  status: number;
  code?: Exclude<
    ConnectorProviderOutcomeCode,
    "CONNECTOR_UPSTREAM_ERROR" | "CONNECTOR_EGRESS_DENIED" | "CONNECTOR_TIMEOUT"
  >;
  retryable?: false;
};

/** Closed schema the contract boundary validates a hint against. */
export const PROVIDER_FAILURE_HINT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "integer", minimum: 100, maximum: 599 },
    code: {
      type: "string",
      // Package hints may narrow only a status core observed from the provider.
      // Policy and timeout meanings originate at trusted platform boundaries.
      enum: [
        "CONNECTOR_PROVIDER_REJECTED_INPUT",
        "CONNECTOR_PROVIDER_AUTHORIZATION_FAILED",
        "CONNECTOR_PROVIDER_PERMISSION_DENIED",
        "CONNECTOR_PROVIDER_RATE_LIMITED",
        "CONNECTOR_PROVIDER_UNAVAILABLE",
      ],
    },
    retryable: { type: "boolean", const: false },
  },
  required: ["status"],
  additionalProperties: false,
} as const;

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

type Disposition = {
  category: ConnectorProviderOutcomeCategory;
  requiredAction: ConnectorProviderRequiredAction;
};

const DISPOSITION_BY_CODE: Record<ConnectorProviderOutcomeCode, Disposition> = {
  CONNECTOR_EGRESS_DENIED: {
    category: "policy_blocked",
    requiredAction: "contact_admin",
  },
  CONNECTOR_TIMEOUT: { category: "timeout", requiredAction: "wait" },
  CONNECTOR_PROVIDER_REJECTED_INPUT: { category: "input", requiredAction: "change_input" },
  CONNECTOR_PROVIDER_AUTHORIZATION_FAILED: {
    category: "authorization",
    requiredAction: "contact_admin",
  },
  CONNECTOR_PROVIDER_PERMISSION_DENIED: {
    category: "authorization",
    requiredAction: "contact_admin",
  },
  CONNECTOR_PROVIDER_RATE_LIMITED: { category: "rate_limit", requiredAction: "wait" },
  CONNECTOR_PROVIDER_UNAVAILABLE: { category: "availability", requiredAction: "wait" },
  CONNECTOR_UPSTREAM_ERROR: { category: "provider_contract", requiredAction: "contact_admin" },
};

/**
 * The platform default for an observed status, first, followed by the codes a
 * package hint may narrow it to. A status not listed here — including `404`,
 * which must not become a resource-existence oracle — has no narrowing.
 */
function codesForStatus(status: number): readonly ConnectorProviderOutcomeCode[] {
  switch (status) {
    case 400:
      // Some providers answer an invalid or expired token with 400 rather than
      // 401; the package is allowed to say so, and nothing more.
      return [
        "CONNECTOR_PROVIDER_REJECTED_INPUT",
        "CONNECTOR_PROVIDER_AUTHORIZATION_FAILED",
        "CONNECTOR_PROVIDER_PERMISSION_DENIED",
      ];
    case 409:
    case 422:
      return ["CONNECTOR_PROVIDER_REJECTED_INPUT"];
    case 401:
      return ["CONNECTOR_PROVIDER_AUTHORIZATION_FAILED", "CONNECTOR_PROVIDER_PERMISSION_DENIED"];
    case 403:
      // A quota refusal dressed as 403 is common enough to allow; the observed
      // status still decides retryability, so it stays non-retryable.
      return [
        "CONNECTOR_PROVIDER_PERMISSION_DENIED",
        "CONNECTOR_PROVIDER_AUTHORIZATION_FAILED",
        "CONNECTOR_PROVIDER_RATE_LIMITED",
      ];
    case 429:
      return ["CONNECTOR_PROVIDER_RATE_LIMITED"];
    case 404:
      return ["CONNECTOR_UPSTREAM_ERROR"];
    default:
      if (status >= 500 && status <= 599) return ["CONNECTOR_PROVIDER_UNAVAILABLE"];
      if (status >= 400 && status <= 499) {
        return [
          "CONNECTOR_UPSTREAM_ERROR",
          "CONNECTOR_PROVIDER_REJECTED_INPUT",
          "CONNECTOR_PROVIDER_PERMISSION_DENIED",
        ];
      }
      return ["CONNECTOR_UPSTREAM_ERROR"];
  }
}

/** Whether the observed status itself permits a retry, before policy and hints. */
function statusRetryable(status: number, retryAllowed: boolean): boolean {
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return retryAllowed;
  return false;
}

export type ClassifyProviderOutcomeInput = {
  correlationId: string;
  /** The most recent non-success response, if any was observed. */
  observation?: ProviderResponseObservation | undefined;
  /** A boundary-validated package hint; ignored unless it matches the observation. */
  hint?: ConnectorProviderFailureHint | undefined;
  /** Whether the operation's reliability policy permits retrying at all. */
  retryAllowed: boolean;
  now: number;
};

/**
 * Classify one failed invocation.
 *
 * With no observation the fallback keeps what the governor could already do:
 * a failure the provider never answered (a dropped connection, a package
 * defect) is retryable exactly when the policy says so. With an observation
 * the status decides, and a hint may only narrow — a different status, an
 * unlisted code, or an attempt to add retryability is ignored whole.
 */
export function classifyProviderOutcome(
  input: ClassifyProviderOutcomeInput,
): ConnectorProviderOutcome {
  const { observation, correlationId } = input;
  if (!observation) {
    const retryable = input.retryAllowed;
    return {
      code: "CONNECTOR_UPSTREAM_ERROR",
      category: "provider_contract",
      retryable,
      requiredAction: retryable ? "wait" : "contact_admin",
      correlationId,
    };
  }

  const allowed = codesForStatus(observation.status);
  let code = allowed[0]!;
  let retryable = statusRetryable(observation.status, input.retryAllowed);

  const hint = input.hint;
  if (
    hint &&
    hint.status === observation.status &&
    (hint.code === undefined || allowed.includes(hint.code))
  ) {
    if (hint.code !== undefined) code = hint.code;
    if (hint.retryable === false) retryable = false;
  }

  const disposition = DISPOSITION_BY_CODE[code];
  const retryAt = retryable
    ? retryAtFromRetryAfter(observation.retryAfter, input.now)
    : undefined;
  return {
    code,
    category: disposition.category,
    retryable,
    ...(retryAt !== undefined ? { retryAt } : {}),
    requiredAction: disposition.requiredAction,
    correlationId,
  };
}

/** Build a safe outcome from the unforgeable marker created at the egress hook. */
export function classifyModuleEgressOutcome(input: {
  kind: ModuleEgressFailureKind;
  correlationId: string;
  retryable: boolean;
}): ConnectorProviderOutcome {
  const code =
    input.kind === "policy_blocked"
      ? "CONNECTOR_EGRESS_DENIED"
      : "CONNECTOR_TIMEOUT";
  const disposition = DISPOSITION_BY_CODE[code];
  return {
    code,
    category: disposition.category,
    retryable: input.kind === "timeout" && input.retryable,
    requiredAction: disposition.requiredAction,
    correlationId: input.correlationId,
  };
}

/* -------------------------------------------------------------------------- */
/* Errors that carry an outcome                                               */
/* -------------------------------------------------------------------------- */

/** Safe, caller-facing message for a code; `subject` names what failed, never why. */
export function providerOutcomeMessage(
  code: ConnectorProviderOutcomeCode,
  subject: string,
): string {
  switch (code) {
    case "CONNECTOR_EGRESS_DENIED":
      return `${subject} was blocked by outbound policy.`;
    case "CONNECTOR_TIMEOUT":
      return `${subject} timed out.`;
    case "CONNECTOR_PROVIDER_REJECTED_INPUT":
      return `${subject} input was rejected by its provider.`;
    case "CONNECTOR_PROVIDER_AUTHORIZATION_FAILED":
      return `${subject} could not be authorized by its provider.`;
    case "CONNECTOR_PROVIDER_PERMISSION_DENIED":
      return `${subject} was denied permission by its provider.`;
    case "CONNECTOR_PROVIDER_RATE_LIMITED":
      return `${subject} was rate limited by its provider.`;
    case "CONNECTOR_PROVIDER_UNAVAILABLE":
      return `${subject} could not be completed because its provider is unavailable.`;
    case "CONNECTOR_UPSTREAM_ERROR":
      return `${subject} failed.`;
  }
}

/**
 * A provider failure from a platform-owned execution path that does not use a
 * connector package. It carries the same safe outcome as connector execution,
 * so the REST and MCP renderers never need a second provider taxonomy.
 */
export class ProviderOutcomeError extends Error {
  readonly code: ConnectorProviderOutcomeCode;
  readonly outcome: ConnectorProviderOutcome;
  readonly providerStatus: number | undefined;

  constructor(outcome: ConnectorProviderOutcome, message: string, providerStatus?: number) {
    super(message);
    this.name = "ProviderOutcomeError";
    this.code = outcome.code;
    this.outcome = outcome;
    this.providerStatus = providerStatus;
  }
}

function isOutcome(value: unknown): value is ConnectorProviderOutcome {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    PROVIDER_OUTCOME_CODES.includes(candidate.code as ConnectorProviderOutcomeCode) &&
    CATEGORIES.includes(candidate.category as ConnectorProviderOutcomeCategory) &&
    typeof candidate.retryable === "boolean" &&
    REQUIRED_ACTIONS.includes(candidate.requiredAction as ConnectorProviderRequiredAction) &&
    typeof candidate.correlationId === "string"
  );
}

/**
 * The outcome an error carries, if it is one of ours. Matched on name and
 * shape rather than instanceof so the REST mapper and the MCP renderer do not
 * have to import the executor to recognise its errors.
 */
export function providerOutcomeOf(error: unknown): ConnectorProviderOutcome | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name !== "ConnectorExecutionError" && error.name !== "ProviderOutcomeError") {
    return undefined;
  }
  const outcome = (error as Error & { outcome?: unknown }).outcome;
  return isOutcome(outcome) ? outcome : undefined;
}

/* -------------------------------------------------------------------------- */
/* Transport mapping                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Every public error code the connector surfaces and the generated CRUD layer
 * answer with, and the HTTP status each maps to. Typed against the code
 * unions so a code added to one of them without a decision here fails the
 * typecheck; the unit test pins the full key set so a string-typed code
 * cannot drift either.
 *
 * Deliberately explicit rather than defaulted: an unmapped code becoming a
 * 500 is the right failure, because it means a new failure mode has appeared
 * that nobody decided how to present.
 */
export const HTTP_STATUS_BY_CODE = {
  BAD_USER_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  GENERATED_CRUD_NOT_ENABLED: 404,
  GENERATED_CRUD_OPERATION_NOT_ENABLED: 404,
  DATABASE_NOT_CONFIGURED: 503,
  // Catalog and configuration.
  CONNECTOR_NOT_FOUND: 404,
  CONNECTOR_NOT_CONFIGURED: 409,
  CONNECTOR_NEEDS_REPAIR: 409,
  CONNECTOR_SINGLE_INSTANCE: 409,
  // Not 402: the tenant is not being asked to pay at this endpoint, it is being
  // refused. 403 is the honest answer, with the reason in the body.
  CONNECTOR_NOT_LICENSED: 403,
  CONNECTOR_INVALID_CONFIGURATION: 400,
  CONNECTOR_SECRETS_NOT_CONFIGURED: 503,
  CONNECTOR_NOT_EXECUTABLE: 503,
  CONNECTOR_DISABLED: 409,
  CONNECTOR_VERIFY_UNSUPPORTED: 501,
  // Execution and boundary.
  CONNECTOR_PROVENANCE_REFUSED: 403,
  CONNECTOR_INVALID_INPUT: 400,
  CONNECTOR_INVALID_OUTPUT: 502,
  CONNECTOR_CONTRACT_MISMATCH: 500,
  CONNECTOR_EGRESS_DENIED: 502,
  CONNECTOR_UPSTREAM_ERROR: 502,
  CONNECTOR_TIMEOUT: 504,
  CONNECTOR_RATE_LIMITED: 429,
  CONNECTOR_CIRCUIT_OPEN: 503,
  // The token exchange itself failed at the provider — the same family as any
  // other bad answer from upstream.
  CONNECTOR_OAUTH_FAILED: 502,
  // 409, alongside NOT_CONFIGURED and NEEDS_REPAIR: the installation exists and
  // is in a state a person has to resolve. Not 401 — the CALLER authenticated
  // fine; it is the connector's own authorization to the provider that lapsed,
  // and answering 401 would send a client into its own re-login flow.
  CONNECTOR_REAUTHORIZATION_REQUIRED: 409,
  // Provider outcomes. The provider's own status is not echoed: a resource 401
  // is 502 here for the same reason REAUTHORIZATION_REQUIRED is not 401.
  CONNECTOR_PROVIDER_REJECTED_INPUT: 422,
  CONNECTOR_PROVIDER_AUTHORIZATION_FAILED: 502,
  CONNECTOR_PROVIDER_PERMISSION_DENIED: 403,
  CONNECTOR_PROVIDER_RATE_LIMITED: 429,
  CONNECTOR_PROVIDER_UNAVAILABLE: 503,
} as const satisfies Record<
  | ConnectorExecutionErrorCode
  | BoundaryErrorCode
  | ConnectorAuthErrorCode
  | ConnectorProviderOutcomeCode,
  number
> &
  Record<string, number>;

export type PublicErrorCode = keyof typeof HTTP_STATUS_BY_CODE;

export function httpStatusForCode(code: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(HTTP_STATUS_BY_CODE, code)
    ? HTTP_STATUS_BY_CODE[code as PublicErrorCode]
    : undefined;
}

/* -------------------------------------------------------------------------- */
/* Failure envelope                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The one failure body. REST sends it as the response; MCP returns it as
 * `structuredContent` and mirrors it as text. The outcome fields are present
 * exactly when the failure was classified, so the two transports cannot mean
 * different things.
 */
export type FailureBody = {
  error: { code: string; message: string } & Partial<Omit<ConnectorProviderOutcome, "code">>;
};

export function failureBody(
  code: string,
  message: string,
  outcome?: ConnectorProviderOutcome | undefined,
): FailureBody {
  return { error: { code, message, ...(outcome ?? {}) } };
}

/**
 * The retry meaning of an outcome, in one sentence a model can act on. Built
 * from the same fields the structured outcome carries so the two cannot
 * disagree; the tests hold that line.
 */
export function describeProviderOutcome(
  outcome: Pick<ConnectorProviderOutcome, "retryable" | "retryAt" | "requiredAction">,
): string {
  if (outcome.retryable) {
    return outcome.retryAt !== undefined ? `Retry after ${outcome.retryAt}.` : "Retry later.";
  }
  switch (outcome.requiredAction) {
    case "change_input":
      return "Not retryable; change the input.";
    case "wait":
      return "Not retryable; wait for the provider to recover.";
    case "contact_admin":
      return "Not retryable; contact an administrator.";
  }
}

/** `CODE: message`, plus the retry sentence when the failure was classified. */
export function failureSummary(error: FailureBody["error"]): string {
  const head = `${error.code}: ${error.message}`;
  return error.retryable === undefined || error.requiredAction === undefined
    ? head
    : `${head} ${describeProviderOutcome({
        retryable: error.retryable,
        requiredAction: error.requiredAction,
        ...(error.retryAt !== undefined ? { retryAt: error.retryAt } : {}),
      })}`;
}

/* -------------------------------------------------------------------------- */
/* Audit and metrics allowlists                                               */
/* -------------------------------------------------------------------------- */

/** What an audit record may say about a provider failure. Nothing else. */
export type ProviderFailureAuditFields = {
  correlationId: string;
  operationKey: string;
  providerStatus?: number;
  code: ConnectorProviderOutcomeCode;
  retryable: boolean;
  retryAt?: string;
};

export function providerFailureAuditFields(
  operationKey: string,
  outcome: ConnectorProviderOutcome,
  providerStatus: number | undefined,
): ProviderFailureAuditFields {
  return {
    correlationId: outcome.correlationId,
    operationKey,
    ...(providerStatus !== undefined ? { providerStatus } : {}),
    code: outcome.code,
    retryable: outcome.retryable,
    ...(outcome.retryAt !== undefined ? { retryAt: outcome.retryAt } : {}),
  };
}

/**
 * Low-cardinality labels only. Tenant, installation, correlation id, account
 * identity and `retryAt` are unbounded or identifying and are excluded by
 * construction: the label set is a closed tuple, not a bag.
 */
export const PROVIDER_FAILURE_METRIC_LABELS = ["connector", "operation", "code"] as const;

export type ProviderFailureMetricLabels = Record<
  (typeof PROVIDER_FAILURE_METRIC_LABELS)[number],
  string
>;

export function providerFailureMetricLabels(
  connector: string,
  operationKey: string,
  outcome: ConnectorProviderOutcome,
): ProviderFailureMetricLabels {
  return { connector, operation: operationKey, code: outcome.code };
}
