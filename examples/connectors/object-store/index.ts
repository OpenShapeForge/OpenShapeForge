// SPDX-License-Identifier: BUSL-1.1
/**
 * Example connector implementation package.
 *
 * Implements the contract in
 * `packages/compiler/config/authoring/connectors/example-object-store.yaml`.
 * The split is the whole point of the connector model: that YAML declares WHAT
 * the connector offers and how the platform exposes it, and this package is the
 * only thing that knows how to talk to the remote system.
 *
 * A real connector would live in its own repository, ship from its own release
 * cycle, and carry its own license — the contract's `implementation.license`
 * block is where those terms are declared. This one is in-tree so the example
 * is runnable and covered by the repo's gates, which is why it carries the same
 * BUSL-1.1 header as everything else here.
 *
 * Things this package deliberately does NOT do, because the platform does them:
 *
 *   - authorize the caller          (invoke roles, before this is reached)
 *   - validate input or output      (generated JSON Schemas on both sides)
 *   - decide what it may reach      (`ctx.fetch` is bound to network.egress)
 *   - manage retries or timeouts    (the operation's declared reliability)
 *   - read configuration or secrets from the environment
 *
 * The context is everything it gets, and everything it needs.
 */

/**
 * Mirrors `ConnectorContext` in apps/api/src/connectors/executor.ts. Declared
 * structurally rather than imported: a real connector package depends on a
 * published types package, not on the API's source tree.
 */
type ConnectorContext = {
  config: Readonly<Record<string, unknown>>;
  secrets: Readonly<Record<string, string>>;
  // `string | URL | Request` rather than `RequestInfo`: this context is declared
  // structurally so the package depends on nothing, and `RequestInfo` is an
  // ambient global that only exists once a DOM or host lib is loaded. Spelling
  // it out keeps the file self-sufficient, which is the point of declaring it
  // here at all.
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  signal: AbortSignal;
  log: (message: string, fields?: Record<string, unknown>) => void;
};

type ListObjectsInput = { prefix?: string; limit?: number };
type PutObjectInput = { key: string; requestId?: string };

function endpointOf(context: ConnectorContext): string {
  const endpoint = context.config.endpoint;
  if (typeof endpoint !== "string" || endpoint === "") {
    // Configuration was validated against the contract's schema before it was
    // stored, so this is a guard against a stale installation rather than an
    // expected path.
    throw new Error("Connector is not configured: endpoint is missing.");
  }
  return endpoint.replace(/\/+$/, "");
}

/**
 * Credentials arrive as values, never as environment reads. Only the fields
 * this connector's own contract declares are present — the platform does not
 * hand over a bag of everything it holds.
 */
function authHeaders(context: ConnectorContext): Record<string, string> {
  const keyId = context.secrets.accessKeyId ?? "";
  const secret = context.secrets.secretAccessKey ?? "";
  return {
    authorization: `Basic ${btoa(`${keyId}:${secret}`)}`,
  };
}

async function listObjects(
  context: ConnectorContext,
  input: ListObjectsInput,
): Promise<{ key: string; sizeBytes?: number }[]> {
  const url = new URL(`${endpointOf(context)}/objects`);
  if (input.prefix) url.searchParams.set("prefix", input.prefix);
  url.searchParams.set("limit", String(input.limit ?? 50));

  // ctx.fetch refuses any host the contract does not declare in network.egress,
  // and carries the operation's abort signal — passing our own would be an
  // attempt to opt out of the caller's budget.
  const response = await context.fetch(url, { headers: authHeaders(context) });
  if (!response.ok) {
    throw new Error(`Object store responded ${response.status}.`);
  }

  const payload = (await response.json()) as { objects?: unknown };
  const objects = Array.isArray(payload.objects) ? payload.objects : [];
  return objects.map((entry) => {
    const object = entry as { key?: unknown; size?: unknown };
    return {
      key: String(object.key ?? ""),
      ...(typeof object.size === "number" ? { sizeBytes: object.size } : {}),
    };
  });
}

async function putObject(
  context: ConnectorContext,
  input: PutObjectInput,
): Promise<{ key: string }> {
  const headers: Record<string, string> = {
    ...authHeaders(context),
    "content-type": "application/json",
  };
  // The contract declares idempotency strategy `key` with keyInput `requestId`,
  // which is what makes this operation retry-eligible at all. Forwarding it is
  // this package's side of that bargain: without it a retry would create a
  // second object, and the contract would be claiming a safety it does not have.
  if (input.requestId) {
    headers["Idempotency-Key"] = input.requestId;
  }

  const response = await context.fetch(`${endpointOf(context)}/objects`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ key: input.key }),
  });
  if (!response.ok) {
    throw new Error(`Object store responded ${response.status}.`);
  }
  return { key: input.key };
}

const connector = {
  slug: "example-object-store",
  contractVersion: 1,
  // Declared explicitly and checked against the compiled contract at startup.
  // A missing operation and an undeclared one are both rejected: the second is
  // behaviour the contract never described, and so never reviewed.
  operations: ["listObjects", "putObject"],

  async invoke(
    operationKey: string,
    context: ConnectorContext,
    input: unknown,
  ): Promise<unknown> {
    switch (operationKey) {
      case "listObjects":
        return listObjects(context, (input ?? {}) as ListObjectsInput);
      case "putObject":
        return putObject(context, input as PutObjectInput);
      default:
        throw new Error(`Unknown operation "${operationKey}".`);
    }
  },
};

export default connector;
