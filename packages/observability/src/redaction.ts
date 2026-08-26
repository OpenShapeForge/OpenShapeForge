// SPDX-License-Identifier: BUSL-1.1

export type SanitizedErrorReport = {
  category: string;
  errorType: string;
  errorCode?: string;
};

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === "string" && SAFE_ERROR_CODE.test(candidate)
    ? candidate
    : undefined;
}
/**
 * Reduce an exception to bounded diagnostic attributes.
 *
 * Messages, stacks, causes, request data, variables and headers are omitted on
 * purpose. The host may correlate this category/type tuple with its structured
 * server log without copying personal or authorization data into telemetry.
 */
export function sanitizeError(
  error: unknown,
  category: string,
): SanitizedErrorReport {
  const errorType =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
      ? error.name
      : "Error";
  const code = errorCode(error);
  return {
    category,
    errorType,
    ...(code ? { errorCode: code } : {}),
  };
}

export function boundedLabel(
  value: string | null | undefined,
  allowed: ReadonlySet<string>,
  fallback: string,
): string {
  return value && allowed.has(value) ? value : fallback;
}
