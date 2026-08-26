// SPDX-License-Identifier: BUSL-1.1
import "server-only";

export type GraphqlError = {
  message?: string;
  extensions?: {
    code?: string;
    status?: number;
    details?: unknown;
  };
};

export type GraphqlPayload<TData> = {
  data?: TData;
  errors?: GraphqlError[];
  message?: string;
};

export class GraphqlProxyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = "GraphqlProxyError";
  }
}

export function isGraphqlProxyError(
  error: unknown,
  status?: number,
): error is GraphqlProxyError {
  return (
    error instanceof GraphqlProxyError &&
    (typeof status === "number" ? error.status === status : true)
  );
}

export function extractPayloadMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  const record = payload as GraphqlPayload<unknown>;

  if (
    typeof record.errors?.[0]?.message === "string" &&
    record.errors[0].message.trim()
  ) {
    return record.errors[0].message;
  }

  if (typeof record.message === "string" && record.message.trim()) {
    return record.message;
  }

  return fallback;
}

export function statusFromGraphqlPayload(payload: unknown): number {
  if (!payload || typeof payload !== "object") {
    return 400;
  }

  const errors = (payload as GraphqlPayload<unknown>).errors;
  const code = errors?.find((error) => error.extensions?.code)?.extensions?.code;
  const explicitStatus = errors?.find(
    (error) => typeof error.extensions?.status === "number",
  )?.extensions?.status;
  if (typeof explicitStatus === "number" && explicitStatus >= 400) {
    return explicitStatus;
  }

  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "ALREADY_PUBLISHED":
    case "CONCURRENT_MODIFICATION":
    case "CONFLICT":
      return 409;
    case "DATABASE_NOT_CONFIGURED":
    case "SERVICE_UNAVAILABLE":
      return 503;
    default:
      return 400;
  }
}

/** Exact APQ miss used for one authenticated rolling-deploy fallback. */
export function isPersistedQueryNotFoundPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const errors = (payload as GraphqlPayload<unknown>).errors;
  return Boolean(errors?.some((error) =>
    error.extensions?.code === "PERSISTED_QUERY_NOT_FOUND" ||
    error.message === "PersistedQueryNotFound",
  ));
}
