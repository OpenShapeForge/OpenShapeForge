// SPDX-License-Identifier: BUSL-1.1
/**
 * The provider-failure taxonomy: every status disposition, every retry-time
 * rule, hint narrowing, the one status table, and the envelope both
 * transports carry. Executor, governor and boundary suites cover where each
 * piece is wired in; this one pins what the pieces mean.
 */
import { describe, expect, it } from "bun:test";
import {
  HTTP_STATUS_BY_CODE,
  PROVIDER_FAILURE_METRIC_LABELS,
  PROVIDER_OUTCOME_CODES,
  ProviderObservations,
  RETRY_AT_HORIZON_MS,
  classifyProviderOutcome,
  describeProviderOutcome,
  failureBody,
  failureSummary,
  httpStatusForCode,
  providerFailureAuditFields,
  providerFailureMetricLabels,
  providerOutcomeOf,
  retainableRetryAfter,
  retryAtFromRetryAfter,
  type ConnectorProviderOutcome,
} from "../provider-outcome.js";
import { ConnectorExecutionError } from "../executor.js";
import { toHttpError } from "../../rest/http-error.js";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function observed(status: number, retryAfter?: string) {
  return { status, ...(retryAfter !== undefined ? { retryAfter } : {}), correlationId: "c-1" };
}

function classify(
  status: number,
  extras: Partial<Parameters<typeof classifyProviderOutcome>[0]> & { retryAfter?: string } = {},
) {
  const { retryAfter, ...rest } = extras;
  return classifyProviderOutcome({
    correlationId: "c-1",
    observation: observed(status, retryAfter),
    retryAllowed: true,
    now: NOW,
    ...rest,
  });
}

describe("status dispositions", () => {
  it("maps each status family to the code, category, retryability and action in the contract", () => {
    const cases: [number, ConnectorProviderOutcome["code"], ConnectorProviderOutcome["category"], boolean, ConnectorProviderOutcome["requiredAction"]][] = [
      [400, "CONNECTOR_PROVIDER_REJECTED_INPUT", "input", false, "change_input"],
      [409, "CONNECTOR_PROVIDER_REJECTED_INPUT", "input", false, "change_input"],
      [422, "CONNECTOR_PROVIDER_REJECTED_INPUT", "input", false, "change_input"],
      [401, "CONNECTOR_PROVIDER_AUTHORIZATION_FAILED", "authorization", false, "contact_admin"],
      [403, "CONNECTOR_PROVIDER_PERMISSION_DENIED", "authorization", false, "contact_admin"],
      [429, "CONNECTOR_PROVIDER_RATE_LIMITED", "rate_limit", true, "wait"],
      [500, "CONNECTOR_PROVIDER_UNAVAILABLE", "availability", true, "wait"],
      [503, "CONNECTOR_PROVIDER_UNAVAILABLE", "availability", true, "wait"],
      [599, "CONNECTOR_PROVIDER_UNAVAILABLE", "availability", true, "wait"],
    ];
    for (const [status, code, category, retryable, requiredAction] of cases) {
      expect(classify(status)).toEqual({
        code,
        category,
        retryable,
        requiredAction,
        correlationId: "c-1",
      });
    }
  });

  // A distinct not-found outcome needs an authorization predicate first, or
  // the code becomes a way to enumerate what exists behind a connector.
  it("keeps a provider 404 on the generic fallback", () => {
    expect(classify(404)).toEqual({
      code: "CONNECTOR_UPSTREAM_ERROR",
      category: "provider_contract",
      retryable: false,
      requiredAction: "contact_admin",
      correlationId: "c-1",
    });
  });

  it("keeps other unclassified statuses on the fallback, never retryable", () => {
    for (const status of [402, 405, 410, 418, 451]) {
      const outcome = classify(status);
      expect(outcome.code).toBe("CONNECTOR_UPSTREAM_ERROR");
      expect(outcome.retryable).toBe(false);
    }
  });

  // 5xx retryability is the policy's to give: a non-idempotent mutation that
  // hit an outage may have taken effect, and nothing the provider said
  // changes that.
  it("makes an outage retryable only when the reliability policy allows it", () => {
    expect(classify(503, { retryAllowed: false })).toMatchObject({
      code: "CONNECTOR_PROVIDER_UNAVAILABLE",
      retryable: false,
      requiredAction: "wait",
    });
    expect(classify(503, { retryAllowed: true }).retryable).toBe(true);
  });

  it("keeps a 429 retryable regardless of policy", () => {
    expect(classify(429, { retryAllowed: false }).retryable).toBe(true);
  });

  // No answer from the provider at all: a dropped connection or a package
  // defect. The governor could already retry those under policy, and the
  // wire says the same thing it does.
  it("falls back without an observation, retryable exactly when policy says so", () => {
    const base = { correlationId: "c-2", now: NOW };
    expect(classifyProviderOutcome({ ...base, retryAllowed: true })).toEqual({
      code: "CONNECTOR_UPSTREAM_ERROR",
      category: "provider_contract",
      retryable: true,
      requiredAction: "wait",
      correlationId: "c-2",
    });
    expect(classifyProviderOutcome({ ...base, retryAllowed: false })).toMatchObject({
      code: "CONNECTOR_UPSTREAM_ERROR",
      retryable: false,
      requiredAction: "contact_admin",
    });
  });
});

describe("Retry-After", () => {
  it("retains only the two legal syntactic forms", () => {
    expect(retainableRetryAfter("120")).toBe("120");
    expect(retainableRetryAfter(" 120 ")).toBe("120");
    expect(retainableRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(
      "Wed, 21 Oct 2026 07:28:00 GMT",
    );
    expect(retainableRetryAfter("Wednesday, 21-Oct-26 07:28:00 GMT")).toBe(
      "Wednesday, 21-Oct-26 07:28:00 GMT",
    );
    expect(retainableRetryAfter("Wed Oct 21 07:28:00 2026")).toBe(
      "Wed Oct 21 07:28:00 2026",
    );
    expect(retainableRetryAfter("-5")).toBeUndefined();
    expect(retainableRetryAfter("1.5")).toBeUndefined();
    expect(retainableRetryAfter("soon")).toBeUndefined();
    expect(retainableRetryAfter("2026-10-21T07:28:00Z")).toBeUndefined();
    expect(retainableRetryAfter("October 21, 2026 07:28:00 GMT")).toBeUndefined();
    expect(retainableRetryAfter("")).toBeUndefined();
    expect(retainableRetryAfter(null)).toBeUndefined();
    expect(retainableRetryAfter("x".repeat(65))).toBeUndefined();
    expect(retainableRetryAfter("0".repeat(128) + "30")).toBe("0".repeat(128) + "30");
    expect(retainableRetryAfter("9".repeat(128))).toBe("9".repeat(128));
  });

  it("converts delta-seconds and HTTP-date to one server-minted instant", () => {
    expect(retryAtFromRetryAfter("120", NOW)).toBe("2026-01-01T00:02:00.000Z");
    expect(retryAtFromRetryAfter("00000000030", NOW)).toBe(
      "2026-01-01T00:00:30.000Z",
    );
    expect(retryAtFromRetryAfter("0".repeat(128) + "30", NOW)).toBe(
      "2026-01-01T00:00:30.000Z",
    );
    expect(retryAtFromRetryAfter("Thu, 01 Jan 2026 00:10:00 GMT", NOW)).toBe(
      "2026-01-01T00:10:00.000Z",
    );
  });

  it("ignores invalid, zero, negative and past values", () => {
    expect(retryAtFromRetryAfter(undefined, NOW)).toBeUndefined();
    expect(retryAtFromRetryAfter("nope", NOW)).toBeUndefined();
    expect(retryAtFromRetryAfter("0", NOW)).toBeUndefined();
    expect(retryAtFromRetryAfter("-30", NOW)).toBeUndefined();
    expect(retryAtFromRetryAfter("Wed, 31 Dec 2025 23:59:00 GMT", NOW)).toBeUndefined();
  });

  it("treats a hint beyond 24 hours as untrusted and keeps `wait` without a time", () => {
    const horizonSeconds = RETRY_AT_HORIZON_MS / 1000;
    expect(retryAtFromRetryAfter(String(horizonSeconds), NOW)).toBe(
      "2026-01-02T00:00:00.000Z",
    );
    expect(retryAtFromRetryAfter(String(horizonSeconds + 1), NOW)).toBeUndefined();
    expect(retryAtFromRetryAfter("9".repeat(400), NOW)).toBeUndefined();

    const outcome = classify(429, { retryAfter: String(horizonSeconds + 1) });
    expect(outcome.code).toBe("CONNECTOR_PROVIDER_RATE_LIMITED");
    expect(outcome.retryable).toBe(true);
    expect(outcome.requiredAction).toBe("wait");
    expect(outcome.retryAt).toBeUndefined();
  });

  it("puts a bounded retryAt on a 429 and on an outage", () => {
    expect(classify(429, { retryAfter: "30" }).retryAt).toBe("2026-01-01T00:00:30.000Z");
    expect(classify(503, { retryAfter: "30" }).retryAt).toBe("2026-01-01T00:00:30.000Z");
  });

  // A time to retry at makes no sense on a failure that must not be retried.
  it("omits retryAt when the outcome is not retryable", () => {
    expect(classify(503, { retryAfter: "30", retryAllowed: false }).retryAt).toBeUndefined();
    expect(classify(400, { retryAfter: "30" }).retryAt).toBeUndefined();
  });
});

describe("package hint narrowing", () => {
  it("lets a hint pick a more specific code the observed status allows", () => {
    expect(
      classify(400, { hint: { status: 400, code: "CONNECTOR_PROVIDER_AUTHORIZATION_FAILED" } }),
    ).toMatchObject({
      code: "CONNECTOR_PROVIDER_AUTHORIZATION_FAILED",
      category: "authorization",
      requiredAction: "contact_admin",
      retryable: false,
    });
    expect(
      classify(405, { hint: { status: 405, code: "CONNECTOR_PROVIDER_REJECTED_INPUT" } }),
    ).toMatchObject({ code: "CONNECTOR_PROVIDER_REJECTED_INPUT", retryable: false });
  });

  it("lets a hint withdraw retryability, never grant it", () => {
    expect(classify(429, { hint: { status: 429, retryable: false } })).toMatchObject({
      code: "CONNECTOR_PROVIDER_RATE_LIMITED",
      retryable: false,
    });
    // A quota refusal dressed as 403 may be named, but the observed status
    // decided retryability and the hint has no way to change that.
    expect(
      classify(403, { hint: { status: 403, code: "CONNECTOR_PROVIDER_RATE_LIMITED" } }),
    ).toMatchObject({ code: "CONNECTOR_PROVIDER_RATE_LIMITED", retryable: false });
  });

  it("ignores a hint about a status the platform did not observe", () => {
    expect(
      classify(500, { hint: { status: 400, code: "CONNECTOR_PROVIDER_REJECTED_INPUT" } }),
    ).toMatchObject({ code: "CONNECTOR_PROVIDER_UNAVAILABLE", retryable: true });
  });

  it("ignores a hint that broadens, including on a 404", () => {
    expect(
      classify(429, { hint: { status: 429, code: "CONNECTOR_PROVIDER_REJECTED_INPUT" } }),
    ).toMatchObject({ code: "CONNECTOR_PROVIDER_RATE_LIMITED" });
    expect(
      classify(404, { hint: { status: 404, code: "CONNECTOR_PROVIDER_REJECTED_INPUT" } }),
    ).toMatchObject({ code: "CONNECTOR_UPSTREAM_ERROR" });
    expect(
      classify(503, { hint: { status: 503, code: "CONNECTOR_PROVIDER_RATE_LIMITED" } }),
    ).toMatchObject({ code: "CONNECTOR_PROVIDER_UNAVAILABLE" });
    expect(
      classify(429, {
        hint: {
          status: 429,
          code: "CONNECTOR_PROVIDER_REJECTED_INPUT",
          retryable: false,
        },
      }),
    ).toMatchObject({ code: "CONNECTOR_PROVIDER_RATE_LIMITED", retryable: true });
  });

  it("cannot supply retry timing", () => {
    // The hint type has no such field; a caller that forces one in is ignored
    // because the classifier only reads the fields it knows.
    const outcome = classify(429, {
      hint: { status: 429, retryAt: "2026-01-01T00:05:00.000Z" } as never,
    });
    expect(outcome.retryAt).toBeUndefined();
  });
});

describe("observations", () => {
  it("records only status, a valid Retry-After and the correlation id, and only the latest", () => {
    const observations = new ProviderObservations("c-9");
    expect(observations.last()).toBeUndefined();
    observations.observe({
      status: 500,
      headers: new Headers({ "retry-after": "10", "x-request-id": "req-1" }),
    });
    observations.observe({
      status: 429,
      headers: new Headers({ "retry-after": "not a date", "set-cookie": "s=1" }),
    });
    expect(observations.last()).toEqual({ status: 429, correlationId: "c-9" });
  });

  it("does not record a success or a redirect", () => {
    const observations = new ProviderObservations("c-9");
    observations.observe({ status: 200, headers: new Headers() });
    observations.observe({ status: 304, headers: new Headers() });
    expect(observations.last()).toBeUndefined();
  });
});

describe("the one status table", () => {
  // Every code any connector surface can answer with, so a code added
  // anywhere without a decision here fails this test rather than becoming a
  // silent 500. Extend the list when adding a code, not the other way round.
  const PUBLIC_CODES = [
    "BAD_USER_INPUT",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "GENERATED_CRUD_NOT_ENABLED",
    "GENERATED_CRUD_OPERATION_NOT_ENABLED",
    "DATABASE_NOT_CONFIGURED",
    "CONNECTOR_NOT_FOUND",
    "CONNECTOR_NOT_CONFIGURED",
    "CONNECTOR_NEEDS_REPAIR",
    "CONNECTOR_SINGLE_INSTANCE",
    "CONNECTOR_NOT_LICENSED",
    "CONNECTOR_INVALID_CONFIGURATION",
    "CONNECTOR_SECRETS_NOT_CONFIGURED",
    "CONNECTOR_NOT_EXECUTABLE",
    "CONNECTOR_DISABLED",
    "CONNECTOR_VERIFY_UNSUPPORTED",
    "CONNECTOR_PROVENANCE_REFUSED",
    "CONNECTOR_INVALID_INPUT",
    "CONNECTOR_INVALID_OUTPUT",
    "CONNECTOR_CONTRACT_MISMATCH",
    "CONNECTOR_EGRESS_DENIED",
    "CONNECTOR_UPSTREAM_ERROR",
    "CONNECTOR_TIMEOUT",
    "CONNECTOR_RATE_LIMITED",
    "CONNECTOR_CIRCUIT_OPEN",
    "CONNECTOR_OAUTH_FAILED",
    "CONNECTOR_REAUTHORIZATION_REQUIRED",
    "CONNECTOR_PROVIDER_REJECTED_INPUT",
    "CONNECTOR_PROVIDER_AUTHORIZATION_FAILED",
    "CONNECTOR_PROVIDER_PERMISSION_DENIED",
    "CONNECTOR_PROVIDER_RATE_LIMITED",
    "CONNECTOR_PROVIDER_UNAVAILABLE",
  ].sort();

  it("covers every public code exactly once", () => {
    expect(Object.keys(HTTP_STATUS_BY_CODE).sort()).toEqual(PUBLIC_CODES);
    for (const code of PROVIDER_OUTCOME_CODES) {
      expect(httpStatusForCode(code)).toBeDefined();
    }
  });

  it("preserves every shipped mapping and adds the provider outcomes", () => {
    expect(HTTP_STATUS_BY_CODE).toMatchObject({
      CONNECTOR_UPSTREAM_ERROR: 502,
      CONNECTOR_TIMEOUT: 504,
      CONNECTOR_RATE_LIMITED: 429,
      CONNECTOR_CIRCUIT_OPEN: 503,
      CONNECTOR_OAUTH_FAILED: 502,
      CONNECTOR_REAUTHORIZATION_REQUIRED: 409,
      CONNECTOR_NEEDS_REPAIR: 409,
      CONNECTOR_INVALID_OUTPUT: 502,
      CONNECTOR_PROVIDER_REJECTED_INPUT: 422,
      CONNECTOR_PROVIDER_AUTHORIZATION_FAILED: 502,
      CONNECTOR_PROVIDER_PERMISSION_DENIED: 403,
      CONNECTOR_PROVIDER_RATE_LIMITED: 429,
      CONNECTOR_PROVIDER_UNAVAILABLE: 503,
    });
  });

  it("answers nothing for an unknown code, so the caller redacts", () => {
    expect(httpStatusForCode("SOMETHING_NEW")).toBeUndefined();
    expect(httpStatusForCode("toString")).toBeUndefined();
  });
});

describe("the failure envelope", () => {
  const outcome: ConnectorProviderOutcome = {
    code: "CONNECTOR_PROVIDER_RATE_LIMITED",
    category: "rate_limit",
    retryable: true,
    retryAt: "2026-01-01T00:00:30.000Z",
    requiredAction: "wait",
    correlationId: "c-1",
  };

  it("carries the outcome fields exactly when a failure was classified", () => {
    expect(failureBody("CONNECTOR_PROVIDER_RATE_LIMITED", "Rate limited.", outcome)).toEqual({
      error: { message: "Rate limited.", ...outcome },
    });
    expect(failureBody("CONNECTOR_NOT_CONFIGURED", "Not configured.")).toEqual({
      error: { code: "CONNECTOR_NOT_CONFIGURED", message: "Not configured." },
    });
  });

  it("summarises retry meaning from the same fields the structured outcome carries", () => {
    expect(describeProviderOutcome({ retryable: true, retryAt: "2026-01-01T00:00:30.000Z", requiredAction: "wait" }))
      .toBe("Retry after 2026-01-01T00:00:30.000Z.");
    expect(describeProviderOutcome({ retryable: true, requiredAction: "wait" })).toBe("Retry later.");
    expect(describeProviderOutcome({ retryable: false, requiredAction: "change_input" })).toBe(
      "Not retryable; change the input.",
    );
    expect(describeProviderOutcome({ retryable: false, requiredAction: "contact_admin" })).toBe(
      "Not retryable; contact an administrator.",
    );
    expect(describeProviderOutcome({ retryable: false, requiredAction: "wait" })).toBe(
      "Not retryable; wait for the provider to recover.",
    );
  });

  it("keeps the summary consistent with retryable, retryAt and requiredAction", () => {
    const classified = failureBody("CONNECTOR_PROVIDER_RATE_LIMITED", "Rate limited.", outcome);
    const summary = failureSummary(classified.error);
    expect(summary).toBe(
      "CONNECTOR_PROVIDER_RATE_LIMITED: Rate limited. Retry after 2026-01-01T00:00:30.000Z.",
    );
    expect(summary).toContain(outcome.retryAt!);

    const denied = failureBody("CONNECTOR_PROVIDER_PERMISSION_DENIED", "Denied.", {
      code: "CONNECTOR_PROVIDER_PERMISSION_DENIED",
      category: "authorization",
      retryable: false,
      requiredAction: "contact_admin",
      correlationId: outcome.correlationId,
    });
    expect(failureSummary(denied.error)).toBe(
      "CONNECTOR_PROVIDER_PERMISSION_DENIED: Denied. Not retryable; contact an administrator.",
    );
    expect(failureSummary(denied.error)).not.toContain("Retry after");

    // An unclassified failure keeps the plain `CODE: message` form.
    expect(failureSummary({ code: "FORBIDDEN", message: "No." })).toBe("FORBIDDEN: No.");
  });

  // REST and MCP both go through toHttpError, so proving it once proves the
  // two transports mean the same thing.
  it("reaches the REST mapper with the same body", () => {
    const fromExecutor = new ConnectorExecutionError(
      outcome.code,
      "object-store",
      "Rate limited.",
      "listObjects",
      { outcome, providerStatus: 429 },
    );
    const mapped = toHttpError(fromExecutor);
    expect(mapped.status).toBe(429);
    expect(mapped.body).toEqual({ error: { message: "Rate limited.", ...outcome } });
    // The observed status is for the audit trail, never the wire.
    expect(JSON.stringify(mapped.body)).not.toContain("providerStatus");
    expect(providerOutcomeOf(fromExecutor)).toEqual(outcome);
    expect(providerOutcomeOf(new Error("plain"))).toBeUndefined();
  });
});

describe("audit and metric allowlists", () => {
  const outcome: ConnectorProviderOutcome = {
    code: "CONNECTOR_PROVIDER_UNAVAILABLE",
    category: "availability",
    retryable: true,
    retryAt: "2026-01-01T00:00:30.000Z",
    requiredAction: "wait",
    correlationId: "c-7",
  };

  it("journals only the allowlisted fields", () => {
    expect(providerFailureAuditFields("listObjects", outcome, 503)).toEqual({
      correlationId: "c-7",
      operationKey: "listObjects",
      providerStatus: 503,
      code: "CONNECTOR_PROVIDER_UNAVAILABLE",
      retryable: true,
      retryAt: "2026-01-01T00:00:30.000Z",
    });
    expect(Object.keys(providerFailureAuditFields("listObjects", outcome, undefined))).toEqual([
      "correlationId",
      "operationKey",
      "code",
      "retryable",
      "retryAt",
    ]);
  });

  it("labels metrics with the bounded tuple and nothing identifying", () => {
    expect([...PROVIDER_FAILURE_METRIC_LABELS]).toEqual(["connector", "operation", "code"]);
    const labels = providerFailureMetricLabels("object-store", "listObjects", outcome);
    expect(labels).toEqual({
      connector: "object-store",
      operation: "listObjects",
      code: "CONNECTOR_PROVIDER_UNAVAILABLE",
    });
    for (const forbidden of ["tenant", "installation", "correlation", "account", "retryAt"]) {
      expect(JSON.stringify(labels).toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
