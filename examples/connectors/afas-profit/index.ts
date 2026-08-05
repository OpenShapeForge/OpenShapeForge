// SPDX-License-Identifier: BUSL-1.1
/**
 * AFAS Profit connector implementation.
 *
 * Implements `packages/compiler/config/authoring/connectors/afas-profit.yaml`
 * against ProfitRestServices, AFAS's REST surface over the Get- and
 * UpdateConnectors an administrator publishes inside their own environment.
 *
 * As with every connector package, the things this file does NOT do are the
 * point: it does not authorize the caller, validate its input or output, decide
 * which hosts it may reach, or manage retries and timeouts. The platform does
 * all of that around it, and the context is everything it gets.
 *
 * The one AFAS-specific consequence worth stating here: `updateConnector` is
 * declared NOT retry-eligible in the contract, because an UpdateConnector has
 * no idempotency key. Nothing in this file may quietly retry either — a second
 * POST creates a second record in somebody's ERP.
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

type GetConnectorInput = {
  connectorId: string;
  skip?: number;
  take?: number;
  filterFieldIds?: string;
  filterValues?: string;
  operatorTypes?: string;
};

type UpdateConnectorInput = {
  connectorId: string;
  mode: "insert" | "update";
  payload: Record<string, unknown>;
};

/**
 * The three REST hosts AFAS publishes, keyed by the environment letter its
 * naming uses: O12345AA is production, A12345AA acceptance, T12345AA test.
 * Only the digits reach the URL, which is why the contract asks for the number
 * and the environment separately rather than parsing one out of the other.
 */
const HOST_SUFFIX_BY_ENVIRONMENT: Record<string, string> = {
  production: "rest.afas.online",
  accept: "restaccept.afas.online",
  test: "resttest.afas.online",
};

function baseUrlOf(context: ConnectorContext): string {
  const environmentId = context.config.environmentId;
  const environmentType = context.config.environmentType;
  if (typeof environmentId !== "string" || environmentId === "") {
    // Configuration was validated against the contract's schema before it was
    // stored, so this guards a stale installation rather than an expected path.
    throw new Error("Connector is not configured: environmentId is missing.");
  }
  const suffix =
    typeof environmentType === "string"
      ? HOST_SUFFIX_BY_ENVIRONMENT[environmentType]
      : undefined;
  if (!suffix) {
    throw new Error(`Connector is not configured: unknown environment "${String(environmentType)}".`);
  }
  return `https://${environmentId}.${suffix}/profitrestservices`;
}

/**
 * AFAS takes the AppConnector token verbatim, prefixed with the scheme name.
 * The token arrives as a value from the platform's encrypted store — never from
 * the environment, and never read back out of it.
 */
function authHeaders(context: ConnectorContext): Record<string, string> {
  return { authorization: `AfasToken ${context.secrets.token ?? ""}` };
}

/**
 * The connector id lands in the URL path, so it is encoded rather than
 * interpolated. `encodeURIComponent` escapes `/`, which is what stops a crafted
 * id from walking out of the `connectors/` segment into another endpoint.
 */
function connectorPath(base: string, connectorId: string): string {
  return `${base}/connectors/${encodeURIComponent(connectorId)}`;
}

/**
 * AFAS reports failures as a status plus a body that frequently names the
 * environment, the connector and occasionally a row's contents. None of that
 * belongs in an error message that will be logged, so only the status crosses
 * this boundary — the platform redacts the rest anyway, and this keeps the
 * package from relying on it having done so.
 */
async function assertOk(response: Response, what: string): Promise<void> {
  if (response.ok) return;
  throw new Error(`AFAS responded ${response.status} to ${what}.`);
}

async function getConnector(
  context: ConnectorContext,
  input: GetConnectorInput,
): Promise<{ rows: Record<string, unknown>[]; hasMore: boolean }> {
  const take = input.take ?? 100;
  const url = new URL(connectorPath(baseUrlOf(context), input.connectorId));
  url.searchParams.set("skip", String(input.skip ?? 0));
  url.searchParams.set("take", String(take));
  // The three filter parameters are positional and only meaningful together, so
  // they are forwarded only when a field list is present. Sending values with
  // no fields is the shape AFAS answers with an unhelpful 400.
  if (input.filterFieldIds) {
    url.searchParams.set("filterfieldids", input.filterFieldIds);
    if (input.filterValues) url.searchParams.set("filtervalues", input.filterValues);
    if (input.operatorTypes) url.searchParams.set("operatortypes", input.operatorTypes);
  }

  const response = await context.fetch(url, { headers: authHeaders(context) });
  await assertOk(response, `GetConnector "${input.connectorId}"`);

  const payload = (await response.json()) as { rows?: unknown };
  const rows = Array.isArray(payload.rows)
    ? (payload.rows as Record<string, unknown>[])
    : [];

  // AFAS reports no total and no cursor, so a full page is the only available
  // signal that another may follow. It over-reports by one call when the row
  // count is an exact multiple of `take` — the alternative is under-reporting,
  // which silently truncates a sync.
  return { rows, hasMore: rows.length >= take };
}

async function updateConnector(
  context: ConnectorContext,
  input: UpdateConnectorInput,
): Promise<{ result: Record<string, unknown> }> {
  const response = await context.fetch(
    connectorPath(baseUrlOf(context), input.connectorId),
    {
      method: input.mode === "insert" ? "POST" : "PUT",
      headers: { ...authHeaders(context), "content-type": "application/json" },
      body: JSON.stringify(input.payload),
    },
  );
  await assertOk(response, `UpdateConnector "${input.connectorId}"`);

  // A successful UpdateConnector may answer with an empty body. The contract
  // declares `result` required, so an empty object is the answer rather than a
  // parse failure — "it worked and said nothing" is a real AFAS outcome.
  const text = await response.text();
  if (text.trim() === "") return { result: {} };
  try {
    return { result: JSON.parse(text) as Record<string, unknown> };
  } catch {
    throw new Error("AFAS returned a non-JSON body to an UpdateConnector call.");
  }
}

const connector = {
  slug: "afas-profit",
  contractVersion: 1,
  operations: ["getConnector", "updateConnector"],

  async invoke(
    operationKey: string,
    context: ConnectorContext,
    input: unknown,
  ): Promise<unknown> {
    switch (operationKey) {
      case "getConnector":
        return getConnector(context, input as GetConnectorInput);
      case "updateConnector":
        return updateConnector(context, input as UpdateConnectorInput);
      default:
        throw new Error(`Unknown operation "${operationKey}".`);
    }
  },

  /**
   * The connectivity check behind `configuration.verify: true`.
   *
   * `/profitversion` is authenticated but reads no business data, so an
   * operator can confirm the environment number and token are right without
   * needing a published GetConnector or the rights to read one. A failure is an
   * answer here, not an exception: the platform turns a throw into a redacted
   * "check failed", and a wrong token deserves better than that.
   */
  async verify(context: ConnectorContext): Promise<{ ok: boolean; message?: string }> {
    const response = await context.fetch(`${baseUrlOf(context)}/profitversion`, {
      headers: authHeaders(context),
    });
    if (response.ok) return { ok: true };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: "AFAS rejected the AppConnector token." };
    }
    return { ok: false, message: `AFAS responded ${response.status}.` };
  },
};

export default connector;
