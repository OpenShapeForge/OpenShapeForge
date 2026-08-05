// SPDX-License-Identifier: BUSL-1.1
/**
 * Microsoft Dynamics 365 Finance and Operations connector.
 *
 * Implements `authoring/connectors/dynamics-finance.yaml` against the OData
 * endpoint under `/data`.
 *
 * As with every connector package there is no authentication code here. The
 * platform holds the Entra ID application token and hands this package a
 * `fetch` that already carries it — which for this connector means the client
 * secret never reaches package code at all, not even to be forwarded.
 */

/**
 * Mirrors `ConnectorContext` in apps/api/src/connectors/executor.ts. Declared
 * structurally rather than imported: a real connector package depends on a
 * published types package, not on the API's source tree.
 */
type ConnectorContext = {
  config: Readonly<Record<string, unknown>>;
  secrets: Readonly<Record<string, string>>;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  signal: AbortSignal;
  log: (message: string, fields?: Record<string, unknown>) => void;
};

type GetRecordsInput = {
  entity: string;
  select?: string;
  filter?: string;
  top?: number;
  skipToken?: string;
};

type CreateRecordInput = {
  entity: string;
  payload: Record<string, unknown>;
};

function baseUrlOf(context: ConnectorContext): string {
  const host = context.config.environmentHost;
  if (typeof host !== "string" || host === "") {
    // Configuration was validated against the contract's schema before it was
    // stored, so this guards a stale installation rather than an expected path.
    throw new Error("Connector is not configured: environmentHost is missing.");
  }
  return `https://${host}/data`;
}

const JSON_HEADERS = { accept: "application/json" };

async function assertOk(response: Response, what: string): Promise<void> {
  if (response.ok) return;
  // Dynamics error bodies quote the offending record and frequently the whole
  // request payload. Only the status crosses this boundary.
  throw new Error(`Dynamics responded ${response.status} to ${what}.`);
}

/**
 * A data entity name reaches the URL path, so relative segments are refused
 * rather than escaped.
 *
 * `encodeURIComponent` leaves a dot alone, so a `..` survives it and `new URL()`
 * then resolves the traversal — the same trap the Exact connector hit, where
 * `salesinvoice/../../Me` escaped the division it was scoped to. A Dynamics
 * entity is a single name, so the rule here is simply that it contains no
 * separator at all.
 */
function entityPath(entity: string): string {
  if (entity.includes("/") || entity === "." || entity === "..") {
    throw new Error(`Data entity "${entity}" is not a single entity-set name.`);
  }
  return encodeURIComponent(entity);
}

/**
 * Dynamics reports another page as a whole URL in `@odata.nextLink`.
 *
 * The token is extracted rather than the URL followed, so egress stays this
 * connector's decision rather than the upstream's — a response body that could
 * redirect the next call to a host of its choosing is exactly what the
 * allowlist exists to prevent.
 */
function nextSkipToken(next: unknown): string | undefined {
  if (typeof next !== "string" || next === "") return undefined;
  try {
    return new URL(next).searchParams.get("$skiptoken") ?? undefined;
  } catch {
    return undefined;
  }
}

async function getRecords(
  context: ConnectorContext,
  input: GetRecordsInput,
): Promise<{ records: Record<string, unknown>[]; nextSkipToken?: string }> {
  const url = new URL(`${baseUrlOf(context)}/${entityPath(input.entity)}`);
  if (input.select) url.searchParams.set("$select", input.select);
  if (input.filter) url.searchParams.set("$filter", input.filter);
  url.searchParams.set("$top", String(input.top ?? 100));
  if (input.skipToken) url.searchParams.set("$skiptoken", input.skipToken);

  const response = await context.fetch(url, { headers: JSON_HEADERS });
  await assertOk(response, `a read of "${input.entity}"`);

  const body = (await response.json()) as {
    value?: unknown;
    "@odata.nextLink"?: unknown;
  };
  const records = Array.isArray(body.value)
    ? (body.value as Record<string, unknown>[])
    : [];
  const token = nextSkipToken(body["@odata.nextLink"]);

  return { records, ...(token ? { nextSkipToken: token } : {}) };
}

async function createRecord(
  context: ConnectorContext,
  input: CreateRecordInput,
): Promise<{ record: Record<string, unknown> }> {
  const response = await context.fetch(
    `${baseUrlOf(context)}/${entityPath(input.entity)}`,
    {
      method: "POST",
      headers: { ...JSON_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(input.payload),
    },
  );
  await assertOk(response, `a create on "${input.entity}"`);

  const text = await response.text();
  // A created entity normally comes back; an empty body is still a success and
  // the contract declares `record` required, so it becomes an empty object
  // rather than a parse failure an operator would read as a write that failed.
  if (text.trim() === "") return { record: {} };
  try {
    return { record: JSON.parse(text) as Record<string, unknown> };
  } catch {
    throw new Error("Dynamics returned a non-JSON body to a create.");
  }
}

const connector = {
  slug: "dynamics-finance",
  contractVersion: 1,
  operations: ["getRecords", "createRecord"],

  async invoke(
    operationKey: string,
    context: ConnectorContext,
    input: unknown,
  ): Promise<unknown> {
    switch (operationKey) {
      case "getRecords":
        return getRecords(context, input as GetRecordsInput);
      case "createRecord":
        return createRecord(context, input as CreateRecordInput);
      default:
        throw new Error(`Unknown operation "${operationKey}".`);
    }
  },

  /**
   * The connectivity check behind `configuration.verify: true`.
   *
   * `$metadata` is authenticated but returns the service document rather than
   * business data. For an application-authenticated connector it proves more
   * than reachability: the platform had to obtain a token with the right
   * audience to get this far, so a green check means the app registration,
   * the secret and the scope all line up.
   */
  async verify(context: ConnectorContext): Promise<{ ok: boolean; message?: string }> {
    const response = await context.fetch(`${baseUrlOf(context)}/$metadata`, {
      headers: { accept: "application/xml" },
    });
    if (response.ok) return { ok: true };
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message:
          "Dynamics rejected the application token — check the app registration's " +
          "permissions and that it is registered in Dynamics itself.",
      };
    }
    return { ok: false, message: `Dynamics responded ${response.status}.` };
  },
};

export default connector;
