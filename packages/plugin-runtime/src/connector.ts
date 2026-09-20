// SPDX-License-Identifier: BUSL-1.1
/**
 * The contract between the platform's connector executor and a connector
 * package. The executor (apps/api) constructs a `ConnectorContext`; a package
 * implements `ConnectorPackage` against it. Both sides import from here, so
 * the shape exists once.
 *
 * Keep this module free of DOM-only globals such as `RequestInfo`: connector
 * packages typecheck without a DOM lib, and naming an ambient global here made
 * the executor unimportable from such a program.
 */

/**
 * The subset of `fetch` a connector gets. Deliberately not `typeof fetch`: the
 * bound version carries no `preconnect` and no other host affordances, and
 * saying so in the type keeps a package from reaching for them.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * What a connector package receives. Deliberately small: resolved
 * configuration, a bound fetch, a redacting logger, an abort signal. No
 * database handle, no session, no filesystem helper, no `process`.
 *
 * Only the secrets this connector's own contract declares are present — the
 * platform never hands over a bag of every credential it holds.
 */
export type ConnectorContext = {
  config: Readonly<Record<string, unknown>>;
  secrets: Readonly<Record<string, string>>;
  fetch: FetchLike;
  signal: AbortSignal;
  log: (message: string, fields?: Record<string, unknown>) => void;
};

export type ConnectorPackage = {
  slug: string;
  contractVersion: number;
  contractChecksum?: string;
  operations: string[];
  invoke(
    operationKey: string,
    context: ConnectorContext,
    input: unknown,
  ): Promise<unknown>;
};
