// SPDX-License-Identifier: BUSL-1.1
import { withExecutionReference } from "./execution-reference.js";
/**
 * The shapes a tool call answers with: success, failure with the shared
 * error body, the canonical Operation envelope, partial composition results,
 * and the configuration handoff results.
 *
 * Split out of generated-mcp-server.ts.
 */
import { isOperationAccepted, OperationFailure, type OperationAccepted } from "@openshapeforge/operations";
import type {
  RuntimeDeclarativeServiceExecutionResult,
  RuntimeDeclarativeServiceRequest,
  RuntimeHostOperationRequest,
  RuntimeOperationExecutionResult,
} from "@openshapeforge/plugin-runtime";
import { parseNativeMcpToolResult } from "@openshapeforge/plugin-runtime";
import { Server } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { toHttpError } from "../rest/http-error.js";
import { withConfirmationHint } from "./confirmation-hint.js";
import { failureSummary } from "../connectors/provider-outcome.js";
import type { ModuleOperationSuccessResult } from "../modules/contract.js";
import { DeclaredOperationError } from "../operations/runtime.js";

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
) => Promise<RuntimeDeclarativeServiceExecutionResult>;

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
 * An Operation taken over by an operation override: the envelope as
 * structuredContent, and a text that says the change has not happened yet.
 */
export function acceptedToolResult(result: Pick<OperationAccepted, "accepted" | "operations">): ToolResult {
  const { by } = result.accepted;
  const text = result.accepted.status === "completed"
    ? `Handled by ${by.kind} ${by.ref}; the original change was not performed directly.`
    : `Started ${by.kind} ${by.ref}; the change happens when it completes.`;
  return {
    content: [{ type: "text", text }],
    structuredContent: { accepted: result.accepted, operations: result.operations },
  };
}

/**
 * An operation's MCP answer: the canonical JSON value as one text block, or —
 * when the handler supplied an MCP projection — its content blocks verbatim
 * (an image next to its metadata, say) with the value as structuredContent.
 */
export function operationToolResult(
  result: ModuleOperationSuccessResult,
): ToolResult {
  if (!result.mcp) {
    const value = result.resultKind === "operation-envelope" ? result.value as import("@openshapeforge/operations").OperationEnvelope<unknown> : undefined;
    return withExecutionReference(ok(result.value), value?.execution);
  }
  const structured =
    result.mcp.structuredContent ??
    (result.value && typeof result.value === "object" && !Array.isArray(result.value)
      ? (result.value as Record<string, unknown>)
      : undefined);
  const value = result.resultKind === "operation-envelope" ? result.value as import("@openshapeforge/operations").OperationEnvelope<unknown> : undefined;
  return withExecutionReference({
    content: result.mcp.content,
    ...(structured ? { structuredContent: structured } : {}),
  }, value?.execution);
}

export const __operationToolResultForTests = operationToolResult;


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
export function failed(error: unknown): ToolResult {
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
  const body = withConfirmationHint(toHttpError(error).body);
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
    structuredContent?: unknown;
    isError?: boolean | undefined;
  },
): RuntimeDeclarativeServiceExecutionResult {
  const structured = result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
    ? result.structuredContent as Record<string, unknown>
    : undefined;
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
      ...(structured as RuntimeDeclarativeServiceExecutionResult),
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
  if (isOperationAccepted(result)) return acceptedToolResult(result);
  const projected = ok(result);
  const resources = (result.resources ?? []).map((resource) => ({
    type: "resource_link" as const,
    uri: resource.uri,
    name: resource.name,
    ...(resource.title ? { title: resource.title } : {}),
    ...(resource.description ? { description: resource.description } : {}),
    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
  }));
  return withExecutionReference(resources.length > 0
    ? { ...projected, content: [...projected.content, ...resources] }
    : projected, result.execution);
}

/**
 * A native tool's dedicated answer: the upstream `CallToolResult` itself, with
 * its content blocks, `isError` and metadata unchanged. A value that is not one
 * came back after the tool may already have acted, so the failure says so and
 * is never retryable.
 */
export function nativeOperationToolResult(
  result: RuntimeOperationExecutionResult,
): ToolResult {
  if ("error" in result) return failed(new OperationFailure(result.error));
  const native = "data" in result ? parseNativeMcpToolResult(result.data) : undefined;
  if (native) return native as unknown as ToolResult;
  return failed(new OperationFailure({
    code: "NATIVE_TOOL_RESULT_INVALID",
    message: "The external tool ran, but its answer could not be read. Check its outcome before calling it again.",
    retryable: false,
  }));
}

/**
 * The same tool through the generic executor, which answers one envelope for
 * every Operation: `data` holds the complete upstream result, and `isError`
 * stays visible at the level a client reads it.
 */
export function nativeOperationEnvelopeResult(
  result: RuntimeOperationExecutionResult,
): ToolResult {
  const projected = runtimeOperationToolResult(result);
  const reportedError = "data" in result && parseNativeMcpToolResult(result.data)?.isError === true;
  return reportedError ? { ...projected, isError: true } : projected;
}

export const __failedForTests = failed;
