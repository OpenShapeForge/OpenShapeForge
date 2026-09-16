// SPDX-License-Identifier: BUSL-1.1
/**
 * The MCP failure envelope: the same body REST answers with, returned as
 * `structuredContent`, mirrored as JSON text, summarised in one consistent
 * line, and flagged `isError`. Shared by entity, connector and derived tools,
 * because they all fail through the same function.
 */
import { describe, expect, it } from "bun:test";
import { ConnectorExecutionError } from "../../connectors/executor.js";
import {
  ProviderOutcomeError,
  type ConnectorProviderOutcome,
} from "../../connectors/provider-outcome.js";
import { HttpError, toHttpError } from "../../rest/http-error.js";
import {
  __failedForTests as failed,
  __nativeToolOutputForTests as nativeToolOutput,
  __okForTests as ok,
  __unavailableOutcomeForTests as unavailableOutcome,
} from "../generated-mcp-server.js";

/** Tool content is a union of block kinds; the envelope's blocks are text. */
const textOf = (block: unknown): string => (block as { text: string }).text;

const OUTCOME: ConnectorProviderOutcome = {
  code: "CONNECTOR_PROVIDER_RATE_LIMITED",
  category: "rate_limit",
  retryable: true,
  retryAt: "2026-01-01T00:00:30.000Z",
  requiredAction: "wait",
  correlationId: "corr-1",
};

const RATE_LIMITED = new ConnectorExecutionError(
  OUTCOME.code,
  "object-store",
  'Connector "object-store" operation "listObjects" was rate limited by its provider.',
  "listObjects",
  { outcome: OUTCOME, providerStatus: 429 },
);

describe("a successful tool result", () => {
  it("carries an object payload as structuredContent too, without a success envelope", () => {
    // A Service aggregating several query bindings reads structuredContent
    // only; a text-only success reached it as `{}`.
    const result = ok({ id: "example", openFindingsTotal: 3 });
    expect(result).toEqual({
      content: [{ type: "text", text: '{\n  "id": "example",\n  "openFindingsTotal": 3\n}' }],
      structuredContent: { id: "example", openFindingsTotal: 3 },
    });
    expect(result).not.toHaveProperty("isError");
  });

  it("keeps arrays and scalars text-only, since they have no structured form", () => {
    expect(ok([{ id: "a" }])).toEqual({
      content: [{ type: "text", text: '[\n  {\n    "id": "a"\n  }\n]' }],
    });
    expect(ok(true)).toEqual({ content: [{ type: "text", text: "true" }] });
    expect(ok(null)).toEqual({ content: [{ type: "text", text: "null" }] });
  });
});

describe("a classified connector failure", () => {
  const result = failed(RATE_LIMITED);

  it("is a tool result, not a protocol error", () => {
    expect(result.isError).toBe(true);
  });

  it("returns the outcome as structuredContent and mirrors it as JSON text", () => {
    expect(result.structuredContent).toEqual({
      error: {
        code: "CONNECTOR_PROVIDER_RATE_LIMITED",
        message: 'Connector "object-store" operation "listObjects" was rate limited by its provider.',
        category: "rate_limit",
        retryable: true,
        retryAt: "2026-01-01T00:00:30.000Z",
        requiredAction: "wait",
        correlationId: "corr-1",
      },
    });
    expect(JSON.parse(textOf(result.content[1]))).toEqual(result.structuredContent);
  });

  it("leads with a summary that agrees with the structured retry meaning", () => {
    const summary = textOf(result.content[0]);
    expect(summary).toBe(
      "CONNECTOR_PROVIDER_RATE_LIMITED: Connector \"object-store\" operation \"listObjects\" " +
        "was rate limited by its provider. Retry after 2026-01-01T00:00:30.000Z.",
    );
    expect(summary).toContain(OUTCOME.retryAt!);
    expect(summary).not.toContain("Not retryable");
  });

  it("means the same thing REST does, and shows the same fields", () => {
    const rest = toHttpError(RATE_LIMITED);
    expect(rest.status).toBe(429);
    expect(result.structuredContent).toEqual(rest.body);
  });

  it("carries nothing but the envelope", () => {
    const text = JSON.stringify(result);
    expect(text).not.toContain("providerStatus");
    expect(text).not.toContain("429");
    expect(text).not.toContain("http");
  });
});

describe("a non-retryable classified failure", () => {
  it("summarises the required action rather than a retry time", () => {
    const outcome: ConnectorProviderOutcome = {
      code: "CONNECTOR_PROVIDER_PERMISSION_DENIED",
      category: "authorization",
      retryable: false,
      requiredAction: "contact_admin",
      correlationId: "corr-2",
    };
    const denied = failed(new ProviderOutcomeError(
      outcome,
      'Operation "getTicket" was denied permission by its provider.',
      403,
    ));
    expect(textOf(denied.content[0])).toBe(
      'CONNECTOR_PROVIDER_PERMISSION_DENIED: Operation "getTicket" was ' +
        "denied permission by its provider. Not retryable; contact an administrator.",
    );
    expect(denied.structuredContent).toMatchObject({
      error: { retryable: false, requiredAction: "contact_admin" },
    });
    expect(JSON.stringify(denied)).not.toContain("retryAt");
  });
});

describe("an optional binding's unavailability", () => {
  it("returns the full normalized outcome instead of provider text", () => {
    expect(unavailableOutcome(RATE_LIMITED)).toEqual(OUTCOME);
  });

  it("gives an unclassified optional failure a safe, message-free disposition", () => {
    expect(
      unavailableOutcome(new HttpError(400, "SERVICE_MISCONFIGURED", "Provider token=must-not-leak")),
    ).toEqual({
      code: "SERVICE_MISCONFIGURED",
      retryable: false,
      requiredAction: "contact_admin",
    });
  });
});

describe("an unclassified failure", () => {
  it("keeps the plain envelope and the CODE: message summary", () => {
    const result = failed(new HttpError(404, "NOT_FOUND", 'Unknown tool "x".'));
    expect(result.isError).toBe(true);
    expect(textOf(result.content[0])).toBe('NOT_FOUND: Unknown tool "x".');
    expect(result.structuredContent).toEqual({
      error: { code: "NOT_FOUND", message: 'Unknown tool "x".' },
    });
    expect(JSON.parse(textOf(result.content[1]))).toEqual(result.structuredContent);
  });
});

/** A refusal RAISEd by a PL/pgSQL trigger, as Bun's SQL driver throws it. */
function raisedRefusal(message: string, hint: string): Error {
  const error = new Error(message);
  error.name = "PostgresError";
  Object.assign(error, {
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: "P0001",
    hint,
    routine: "exec_stmt_raise",
    where: "PL/pgSQL function pentest.assert_status_transition() line 9 at RAISE",
  });
  return error;
}

describe("a database rule's refusal", () => {
  const result = failed(
    raisedRefusal("A finding cannot move from closed back to open.", "Create a new finding instead."),
  );

  it("is rendered as the same readable body REST answers with, with the trigger's hint", () => {
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: "OPERATION_REFUSED",
        message: "A finding cannot move from closed back to open.",
        hint: "Create a new finding instead.",
      },
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: "OPERATION_REFUSED: A finding cannot move from closed back to open.",
    });
  });

  it("reaches a Service running the entity tool natively with its own code, not a provider fault", () => {
    let thrown: unknown;
    try {
      nativeToolOutput(result);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown).toMatchObject({
      status: 409,
      code: "OPERATION_REFUSED",
      message: "A finding cannot move from closed back to open.",
      hint: "Create a new finding instead.",
    });
    expect(result.structuredContent).toEqual(toHttpError(thrown).body);
  });

  it("still folds a failure without a structured body into a provider fault", () => {
    let thrown: unknown;
    try {
      nativeToolOutput({ content: [{ type: "text" as const, text: "boom" }], isError: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ status: 502, code: "PROVIDER_ERROR", message: "boom" });
  });
});
