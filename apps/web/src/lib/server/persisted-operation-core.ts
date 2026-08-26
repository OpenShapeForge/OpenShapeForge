// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { parse, print } from "graphql";
import persistedManifest from "../../generated/persisted-operations.json" with { type: "json" };

type WebFetchInit = RequestInit & { next?: { revalidate: number } };
type WebFetcher = (url: string, init: WebFetchInit) => Promise<Response>;

type TransportResult = {
  response: Response;
  payload: unknown;
  isJsonResponse: boolean;
};

const operations = persistedManifest.operations as Record<string, string>;

/** Match only Yoga's exact persisted allowlist miss contract. */
export function isPersistedOperationMiss(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const errors = (payload as {
    errors?: { message?: unknown; extensions?: { code?: unknown } }[];
  }).errors;
  return Boolean(errors?.some((error) =>
    error.message === "PersistedQueryNotFound" &&
    error.extensions?.code === "PERSISTED_QUERY_NOT_IN_LIST"
  ));
}

/** Canonical APQ envelope for the build-generated first-party allowlist. */
export function createPersistedOperationEnvelope(
  query: string,
  variables?: Record<string, unknown>,
  operationName?: string,
) {
  const canonicalQuery = print(parse(query));
  const sha256Hash = createHash("sha256").update(canonicalQuery).digest("hex");
  return {
    canonicalQuery,
    locallyPersisted: operations[sha256Hash] === canonicalQuery,
    persistedBody: {
      ...(operationName ? { operationName } : {}),
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash } },
    },
  };
}

/**
 * Execute the web server's real transport contract. A raw retry is possible
 * only for a build-generated operation whose hash a rolling API deployment
 * does not know yet; arbitrary runtime documents never gain that path.
 */
export async function executeGraphqlTransport(input: {
  profile: "persisted" | "integration";
  persistedEndpoint: string;
  rawEndpoint: string;
  headers: Headers;
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  requestCache: RequestCache;
  fetcher?: WebFetcher;
}): Promise<TransportResult> {
  const envelope = createPersistedOperationEnvelope(
    input.query,
    input.variables,
    input.operationName,
  );
  const rawBody = {
    query: envelope.canonicalQuery,
    ...(input.operationName ? { operationName: input.operationName } : {}),
    variables: input.variables,
  };
  const fetcher = input.fetcher ?? fetch;
  const request = async (url: string, body: unknown): Promise<TransportResult> => {
    const response = await fetcher(url, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify(body),
      cache: input.requestCache,
      next: input.requestCache === "no-store" ? undefined : { revalidate: 30 },
    });
    const isJsonResponse = (response.headers.get("content-type") ?? "")
      .includes("application/json");
    const payload = isJsonResponse
      ? await response.json().catch(() => null)
      : await response.text().catch(() => null);
    return { response, payload, isJsonResponse };
  };

  let attempt = await request(
    input.profile === "persisted" ? input.persistedEndpoint : input.rawEndpoint,
    input.profile === "persisted" ? envelope.persistedBody : rawBody,
  );
  if (
    input.profile === "persisted" &&
    envelope.locallyPersisted &&
    attempt.response.ok &&
    attempt.isJsonResponse &&
    isPersistedOperationMiss(attempt.payload)
  ) {
    attempt = await request(input.rawEndpoint, rawBody);
  }
  return attempt;
}
