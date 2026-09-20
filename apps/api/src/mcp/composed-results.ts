// SPDX-License-Identifier: BUSL-1.1
/**
 * The results of a composed (derived) tool call: the native outputs a step
 * produces, the partial result after a failed required step, and the
 * unavailable-source outcome. Split out of tool-results.ts.
 */

/**
 * A plugin operation run as a native binding: its canonical value, plus —
 * when the handler supplied an MCP projection — those content blocks under
 * the reserved output `content`, so the binding's output mapping can carry
 * them onto the Service and `derivedToolResult` can hand them to the model.
 */
import { OperationFailure, type OperationError } from "@openshapeforge/operations";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import { isConnectionProblemCode } from "./connection-guidance.js";
import type {
  ModuleOperationSuccessResult,
  ModuleUnavailableInvocationSource,
} from "../modules/contract.js";
import { isMcpProjection } from "../operations/runtime.js";
import { type McpOperation } from "./catalog.js";
import { type ToolResult, failed, ok } from "./tool-results.js";
export function nativeOperationOutput(
  result: ModuleOperationSuccessResult,
): Record<string, unknown> {
  const value = result.value;
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };
  return result.mcp ? { ...record, content: result.mcp.content } : record;
}

/**
 * A derived (Service) tool's answer. Outputs are JSON, so by default they go
 * out as one text block. A Service whose merged outputs carry `content` as a
 * list of well-formed MCP content blocks (an image, extracted text — produced
 * by a native plugin operation's MCP projection) answers with those blocks
 * instead, and the remaining outputs as structuredContent: the generic
 * passthrough that keeps binary content out of the JSON text block.
 */
export function derivedToolResult(payload: Record<string, unknown>): ToolResult {
  const { content, ...rest } = payload;
  if (content === undefined || !isMcpProjection({ content })) return ok(payload);
  return {
    content: content as CallToolResult["content"],
    structuredContent: rest,
  };
}

export const __derivedToolResultForTests = derivedToolResult;

/**
 * Shape a native Capability's mapped inputs the way the entity tool expects
 * them: create takes the values directly, get/delete an id, update an id
 * plus values, list a filter.
 */
export function nativeToolArguments(
  operation: McpOperation,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  switch (operation) {
    case "create":
      return inputs;
    case "get":
    case "delete":
      return { id: inputs.id };
    case "update": {
      const { id, ...values } = inputs;
      return { id, values };
    }
    case "list":
      return { filter: inputs };
  }
}

/** The JSON an entity tool produced, as the native executor's output record. */
export function nativeToolOutput(result: ToolResult): Record<string, unknown> {
  if (result.isError) {
    // The entity tool already failed through the shared envelope, so its
    // structured body is the platform's own answer (a role gate, a database
    // rule's refusal, a missing row): rethrow it with the same code and
    // status rather than folding it into a generic provider fault, so the
    // Service's caller learns the reason the way a direct tool call would.
    const failure = (result.structuredContent as { error?: unknown } | undefined)?.error;
    if (failure && typeof failure === "object") {
      const { code, message, detail, hint, retryable, retryAt, violations, data } = failure as {
        code?: unknown;
        message?: unknown;
        detail?: unknown;
        hint?: unknown;
        retryable?: unknown;
        retryAt?: unknown;
        violations?: unknown;
        data?: unknown;
      };
      if (
        typeof code === "string" &&
        typeof message === "string" &&
        typeof retryable === "boolean"
      ) {
        throw new OperationFailure({
          code,
          message,
          retryable,
          ...(typeof detail === "string" ? { detail } : {}),
          ...(typeof retryAt === "string" ? { retryAt } : {}),
          ...(Array.isArray(violations) ? { violations } : {}),
          ...(data && typeof data === "object" && !Array.isArray(data)
            ? { data: data as Record<string, unknown> }
            : typeof hint === "string"
              ? { data: { hint } }
              : {}),
        } as OperationError);
      }
    }
    const text = result.content.find((item) => item.type === "text");
    throw new HttpError(
      502,
      "PROVIDER_ERROR",
      text && "text" in text ? String(text.text) : "Native operation failed.",
    );
  }
  const text = result.content.find((item) => item.type === "text");
  const parsed: unknown =
    text && "text" in text ? JSON.parse(String(text.text)) : null;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    // Operation offers are interface metadata, not values a composed Service
    // maps between steps. Native composition consumes the canonical result's
    // data while direct MCP callers retain the complete envelope.
    if (Object.prototype.hasOwnProperty.call(record, "data") && Array.isArray(record.operations)) {
      const data = record.data;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const projected = data as Record<string, unknown>;
        if (Array.isArray(projected.items)) {
          return {
            ...projected,
            items: projected.items.map((item) => {
              if (!item || typeof item !== "object" || Array.isArray(item)) return item;
              const envelope = item as Record<string, unknown>;
              return Object.prototype.hasOwnProperty.call(envelope, "data") &&
                Array.isArray(envelope.operations)
                ? envelope.data
                : item;
            }),
          };
        }
        return projected;
      }
      return { value: data };
    }
    return record;
  }
  return { value: parsed };
}

export const __nativeToolOutputForTests = nativeToolOutput;

/** A partial result reports failure meaning, never a free-form provider message. */
export function unavailableOutcome(error: unknown): {
  code: string;
  category?: string;
  retryable: boolean;
  retryAt?: string;
  requiredAction: string;
  correlationId?: string;
  /** Server-authored next step for a connection gap; never provider text. */
  guidance?: string;
} {
  const { code, category, retryable, retryAt, requiredAction, correlationId, message } =
    toHttpError(error).body.error;
  return {
    code,
    ...(category !== undefined ? { category } : {}),
    retryable: retryable ?? false,
    ...(retryAt !== undefined ? { retryAt } : {}),
    requiredAction: requiredAction ?? "contact_admin",
    ...(correlationId !== undefined ? { correlationId } : {}),
    // Connection failures are worded by connection-guidance.ts, so the
    // message is the platform's own instruction and safe to pass on.
    ...(isConnectionProblemCode(code) ? { guidance: message } : {}),
  };
}

export const __unavailableOutcomeForTests = unavailableOutcome;

export type CompletedStep = {
  binding: number;
  operation: string;
  kind: "mutation" | "query";
  outputs: Record<string, unknown>;
};

/** The name a person knows a step by: its native operation, else its key. */
export function operationDisplayKey(operationRow: Record<string, unknown>): string {
  const operation = operationRow.operation as Record<string, unknown> | undefined;
  const native = operation?.nativeOperation;
  if (typeof native === "string" && native.length > 0) return native;
  return String(operationRow.key ?? operationRow.id ?? "operation");
}

/**
 * A required step of a composed call has no usable source. Raised BEFORE the
 * first step runs, so the call refuses whole rather than writing half; the
 * guidance is the same server-authored next step the resolution reported.
 */
export function compositionGapError(
  toolName: string,
  binding: number,
  gap: ModuleUnavailableInvocationSource | undefined,
): HttpError {
  const outcome = gap?.outcome ?? "unavailable";
  const status = outcome === "unavailable" ? 400 : 403;
  const code =
    outcome === "reauthorization_required"
      ? "REAUTHORIZATION_REQUIRED"
      : outcome === "connection_required"
        ? "CONNECTION_REQUIRED"
        : "SERVICE_MISCONFIGURED";
  const reason = gap?.guidance ??
    (outcome === "unavailable"
      ? "its Capability or Adapter is missing"
      : "no usable connection is configured for its Adapter");
  return new HttpError(
    status,
    code,
    `${toolName} was not run: step ${binding} cannot execute — ${reason}` +
      ` Nothing was written.`,
  );
}

export function describeOutputs(outputs: Record<string, unknown>): string {
  const scalars = Object.entries(outputs).filter(
    ([, value]) => value !== null && typeof value !== "object",
  );
  return scalars.length > 0
    ? scalars.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")
    : "no scalar outputs";
}

/**
 * A composed call that stopped after an earlier step had already written.
 * It is an error — the call did not do what was asked — that still reports
 * every effect: each step is its own transaction and nothing is rolled back,
 * so silence here would let an agent retry and write step 1 twice.
 */
export function partial(input: {
  tool: string;
  total: number;
  completed: CompletedStep[];
  failed: { binding: number; operation: string; error: unknown };
  notRun: { binding: number; operation?: string }[];
  outputs: Record<string, unknown>;
  unavailable: { binding: number; outcome: ReturnType<typeof unavailableOutcome> }[];
}): ToolResult {
  const cause = toHttpError(input.failed.error).body.error;
  const position = input.completed.length + 1;
  const written = input.completed
    .map(
      (step) =>
        `step ${step.binding} (${step.operation}) wrote ${describeOutputs(step.outputs)}`,
    )
    .join("; ");
  const remaining = [
    `step ${input.failed.binding} (${input.failed.operation})`,
    ...input.notRun.map(
      (step) => `step ${step.binding}${step.operation ? ` (${step.operation})` : ""}`,
    ),
  ].join(", ");
  const message =
    `${input.tool} stopped at step ${position} of ${input.total} ` +
    `(${input.failed.operation}): ${cause.code}: ${cause.message} ` +
    `The earlier step${input.completed.length === 1 ? "" : "s"} had already completed and ` +
    `${input.completed.length === 1 ? "was" : "were"} NOT rolled back — each step is its own ` +
    `transaction: ${written}. Still to do: ${remaining}. Finish the remaining step(s) with ` +
    `their own tools, or remove what was written, before retrying; do not repeat this call ` +
    `as-is — it would run the completed step${input.completed.length === 1 ? "" : "s"} again.`;
  const body = {
    error: {
      code: "SERVICE_PARTIAL",
      message,
      retryable: false,
      requiredAction: "change_input" as const,
    },
    status: "partial",
    completed: input.completed.map((step) => ({
      binding: step.binding,
      operation: step.operation,
      outputs: step.outputs,
    })),
    failed: {
      binding: input.failed.binding,
      operation: input.failed.operation,
      outcome: { ...unavailableOutcome(input.failed.error), message: cause.message },
    },
    notRun: input.notRun,
    outputs: input.outputs,
    ...(input.unavailable.length > 0 ? { unavailable: input.unavailable } : {}),
  };
  return {
    content: [
      { type: "text", text: `SERVICE_PARTIAL: ${message}` },
      { type: "text", text: JSON.stringify(body, null, 2) },
    ],
    structuredContent: body,
    isError: true,
  };
}

export const __partialForTests = partial;
