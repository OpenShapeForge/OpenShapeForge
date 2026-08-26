// SPDX-License-Identifier: BUSL-1.1
import "server-only";

import { createHash } from "node:crypto";
import { parse, print } from "graphql";

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
    persistedBody: {
      ...(operationName ? { operationName } : {}),
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash } },
    },
  };
}
