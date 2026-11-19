// SPDX-License-Identifier: BUSL-1.1
import type { ModuleOperationErrorResult, ModuleOperationSuccessResult } from "./index.js";

/** Optional members of the error body a caller may read next to `code` and `message`. */
export type ModuleOperationErrorDetail = {
  detail?: string | undefined;
  retryable?: boolean | undefined;
  retryAt?: string | undefined;
};

/**
 * The refusal a module Operation handler returns: one status, one code, one
 * message. Optional members are written only when given, so a handler that
 * never states `retryable` does not start claiming `retryable: false`.
 */
export function moduleOperationError(
  status: number,
  code: string,
  message: string,
  extra: ModuleOperationErrorDetail = {},
): ModuleOperationErrorResult {
  return {
    ok: false,
    status,
    code,
    body: {
      error: {
        code,
        message,
        ...(extra.detail ? { detail: extra.detail } : {}),
        ...(extra.retryable === undefined ? {} : { retryable: extra.retryable }),
        ...(extra.retryAt ? { retryAt: extra.retryAt } : {}),
      },
    },
  };
}

type TextContent = readonly [{ type: "text"; text: string }];

/** A successful value with the MCP text and structured projections of that same value. */
export function moduleOperationSuccess(
  value: Record<string, unknown>,
  options: { status?: number; pretty?: boolean } = {},
): ModuleOperationSuccessResult<TextContent> & { ok: true; status: number } {
  return {
    ok: true,
    status: options.status ?? 200,
    value,
    mcp: {
      content: [{ type: "text", text: options.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value) }],
      structuredContent: value,
    },
  };
}
