// SPDX-License-Identifier: BUSL-1.1

export type SanitizedErrorReport = {
  category: string;
  errorType: string;
  errorCode?: string;
};

const SAFE_ERROR_TYPES = new Set([
  "AggregateError",
  "Error",
  "GraphQLError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
]);
const SAFE_TRANSPORT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

function errorCode(
  error: unknown,
  allowedHostCodes?: ReadonlySet<string>,
): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === "string" &&
      (SAFE_TRANSPORT_ERROR_CODES.has(candidate) || allowedHostCodes?.has(candidate))
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
  allowedHostCodes?: ReadonlySet<string>,
): SanitizedErrorReport {
  const errorType = error instanceof Error && SAFE_ERROR_TYPES.has(error.name)
    ? error.name
    : "Error";
  const code = errorCode(error, allowedHostCodes);
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
