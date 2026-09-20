// SPDX-License-Identifier: BUSL-1.1
/**
 * The shapes a tool call answers with: success, failure with the shared
 * error body, the canonical Operation envelope, partial composition results,
 * and the configuration handoff results.
 *
 * Split out of generated-mcp-server.ts.
 */
import { OperationFailure, type OperationError } from "@openshapeforge/operations";
import type {
  RuntimeDeclarativeServiceRequest,
  RuntimeHostOperationRequest,
  RuntimeOperationExecutionResult,
} from "@openshapeforge/plugin-runtime";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import { withConfirmationHint } from "./confirmation-hint.js";
import { connectionFieldsOf, isConnectionProblemCode } from "./connection-guidance.js";
import { failureSummary } from "../connectors/provider-outcome.js";
import type {
  ModuleOperationSuccessResult,
  ModuleUnavailableInvocationSource,
} from "../modules/contract.js";
import { DeclaredOperationError, isMcpProjection } from "../operations/runtime.js";
import { type McpOperation } from "./catalog.js";
import { ENTITY_CONFIGURATION_PATH, callbackOrigin, configurationWebUrl } from "./handoff-config.js";

export type ToolResult = {
  content: CallToolResult["content"];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

export type RuntimeDeclarativeServiceExecutor = (
  request: RuntimeDeclarativeServiceRequest,
  requestId: string | number,
  assertInvocationActive?: () => void,
  signal?: AbortSignal,
) => Promise<RuntimeOperationExecutionResult>;

export type RuntimeHostOperationExecutor = (
  request: RuntimeHostOperationRequest,
  requestId: string | number,
  assertInvocationActive?: () => void,
  signal?: AbortSignal,
) => Promise<RuntimeOperationExecutionResult>;

export const runtimeDeclarativeServiceExecutors =
  new WeakMap<Server, RuntimeDeclarativeServiceExecutor>();
export const runtimeHostOperationExecutors =
  new WeakMap<Server, RuntimeHostOperationExecutor>();

/**
 * A success carries its payload as `structuredContent` too when it is a
 * plain object: a Service that aggregates several query bindings reads the
 * typed field only, and a text-only success would reach it as `{}`.
 * Arrays and scalars have no structured form and stay text-only.
 */
export function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(payload && typeof payload === "object" && !Array.isArray(payload)
      ? { structuredContent: payload as Record<string, unknown> }
      : {}),
  };
}

export const __okForTests = ok;

/**
 * An operation's MCP answer: the canonical JSON value as one text block, or —
 * when the handler supplied an MCP projection — its content blocks verbatim
 * (an image next to its metadata, say) with the value as structuredContent.
 */
export function operationToolResult(
  result: ModuleOperationSuccessResult,
): ToolResult {
  if (!result.mcp) return ok(result.value);
  const structured =
    result.mcp.structuredContent ??
    (result.value && typeof result.value === "object" && !Array.isArray(result.value)
      ? (result.value as Record<string, unknown>)
      : undefined);
  return {
    content: result.mcp.content,
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export const __operationToolResultForTests = operationToolResult;

/**
 * A plugin operation run as a native binding: its canonical value, plus —
 * when the handler supplied an MCP projection — those content blocks under
 * the reserved output `content`, so the binding's output mapping can carry
 * them onto the Service and `derivedToolResult` can hand them to the model.
 */
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

export function configurationAppResult(
  payload: unknown,
  token: string,
  displayName: string,
): ToolResult {
  const configurationUrl = `${callbackOrigin()}${ENTITY_CONFIGURATION_PATH}/${token}`;
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    _meta: {
      configurationUrl,
      displayName,
    },
  };
}

export const __configurationAppResultForTests = configurationAppResult;

/**
 * The model-visible handoff for clients without a usable secure form: the
 * configuration URL in plain text AND structured, so an assistant can tell
 * the person exactly where to go. The URL is the single-use, time-bound
 * handoff token; the values are entered in the browser and never pass
 * through the chat or the model.
 */
export function configurationHandoffResult(input: {
  continuation: Record<string, unknown>;
  token: string;
  expiresInSeconds: number;
  definitions: unknown;
  instructions: string;
  nowMs?: number;
}): ToolResult {
  const configurationUrl = `${callbackOrigin()}${ENTITY_CONFIGURATION_PATH}/${input.token}`;
  const expiresAt = new Date(
    (input.nowMs ?? Date.now()) + input.expiresInSeconds * 1000,
  ).toISOString();
  const externalUrl = configurationWebUrl();
  const payload = {
    ...input.continuation,
    pending: true,
    configurationUrl,
    expiresAt,
    fields: connectionFieldsOf(input.definitions).map(({ key, label, secret }) => ({
      key,
      label,
      secret,
    })),
    ...(externalUrl ? { externalUrl } : {}),
    instructions: input.instructions,
  };
  return {
    content: [
      {
        type: "text",
        text:
          `Configuration needed: open ${configurationUrl} in a browser and enter the ` +
          `values there (link valid until ${expiresAt}); they never pass through the chat.`,
      },
      { type: "text", text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: payload,
  };
}

export const __configurationHandoffResultForTests = configurationHandoffResult;

/**
 * Errors are returned as tool results rather than protocol errors: a model
 * that gets "FORBIDDEN: not authorized to delete Relation" back as content can
 * adapt, where a transport-level failure just terminates the call. The code
 * vocabulary is the CRUD layer's, unchanged.
 *
 * The body is the same object REST answers with, carried three ways: as
 * `structuredContent` for clients that read it typed, mirrored as JSON text
 * for clients that only render text, and summarised in one line first so a
 * model sees the code and the retry meaning before anything else. The
 * summary is derived from the same fields, so it cannot contradict them.
 */
export function legacyFailureBody(body: Record<string, unknown>): Record<string, unknown> {
  const error = body.error as Record<string, unknown> | undefined;
  if (!error) return body;
  const data = error.data as Record<string, unknown> | undefined;
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(typeof error.detail === "string" ? { detail: error.detail } : {}),
      ...(typeof data?.hint === "string" ? { hint: data.hint } : {}),
    },
  };
}

export function failed(error: unknown, canonical = true): ToolResult {
  if (error instanceof DeclaredOperationError) {
    const body = error.body;
    const bodyMessage = body && typeof body === "object" && !Array.isArray(body)
      ? (body as { error?: { message?: unknown } }).error?.message
      : undefined;
    return {
      content: [
        {
          type: "text",
          text: `${error.code}: ${typeof bodyMessage === "string" ? bodyMessage : error.message}`,
        },
        { type: "text", text: JSON.stringify(body, null, 2) },
      ],
      ...(body && typeof body === "object" && !Array.isArray(body)
        ? { structuredContent: body as Record<string, unknown> }
        : {}),
      isError: true,
    };
  }
  const mapped = withConfirmationHint(toHttpError(error).body);
  const body = canonical
    ? mapped
    : legacyFailureBody(mapped as unknown as Record<string, unknown>);
  const failure = body.error as Parameters<typeof failureSummary>[0];
  const hint = (body.error as { hint?: unknown }).hint;
  return {
    content: [
      { type: "text", text: failureSummary(failure) },
      ...(typeof hint === "string" ? [{ type: "text" as const, text: hint }] : []),
      { type: "text", text: JSON.stringify(body, null, 2) },
    ],
    structuredContent: body,
    isError: true,
  };
}

export function runtimeOperationResult(
  result: {
    content: CallToolResult["content"];
    structuredContent?: Record<string, unknown> | undefined;
    isError?: boolean | undefined;
  },
): RuntimeOperationExecutionResult {
  const structured = result.structuredContent;
  if (result.isError) {
    const candidate = structured?.error as Record<string, unknown> | undefined;
    return {
      error: {
        code: typeof candidate?.code === "string" ? candidate.code : "OPERATION_FAILED",
        message: typeof candidate?.message === "string"
          ? candidate.message
          : "The declarative Service failed.",
        ...(typeof candidate?.detail === "string"
          ? { detail: candidate.detail }
          : {}),
        retryable: candidate?.retryable === true,
        ...(typeof candidate?.retryAt === "string"
          ? { retryAt: candidate.retryAt }
          : {}),
      },
    };
  }
  if (
    structured &&
    Object.hasOwn(structured, "data") &&
    Array.isArray(structured.operations)
  ) {
    const resources = result.content.flatMap((block) =>
      block.type === "resource_link"
        ? [{
            uri: block.uri,
            name: block.name,
            ...(block.title ? { title: block.title } : {}),
            ...(block.description ? { description: block.description } : {}),
            ...(block.mimeType ? { mimeType: block.mimeType } : {}),
          }]
        : []
    );
    return {
      ...(structured as RuntimeOperationExecutionResult),
      ...(resources.length > 0 ? { resources } : {}),
    };
  }
  const resources = result.content.flatMap((block) =>
    block.type === "resource_link"
      ? [{
          uri: block.uri,
          name: block.name,
          ...(block.title ? { title: block.title } : {}),
          ...(block.description ? { description: block.description } : {}),
          ...(block.mimeType ? { mimeType: block.mimeType } : {}),
        }]
      : []
  );
  return {
    data: structured ?? { content: result.content },
    operations: [],
    ...(resources.length > 0 ? { resources } : {}),
  };
}

/** Project the canonical Operation envelope through an MCP tool contract. */
export function runtimeOperationToolResult(
  result: RuntimeOperationExecutionResult,
): ToolResult {
  if ("error" in result) return failed(new OperationFailure(result.error));
  const projected = ok(result);
  const resources = (result.resources ?? []).map((resource) => ({
    type: "resource_link" as const,
    uri: resource.uri,
    name: resource.name,
    ...(resource.title ? { title: resource.title } : {}),
    ...(resource.description ? { description: resource.description } : {}),
    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
  }));
  return resources.length > 0
    ? { ...projected, content: [...projected.content, ...resources] }
    : projected;
}

export const __failedForTests = failed;

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
