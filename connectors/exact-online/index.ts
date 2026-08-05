// SPDX-License-Identifier: BUSL-1.1
/**
 * Exact Online connector implementation.
 *
 * Implements `authoring/connectors/exact-online.yaml` against Exact's OData
 * REST API.
 *
 * ## What is missing from this file, and why that is the point
 *
 * There is no OAuth code here. No client credentials, no token endpoint, no
 * refresh, no expiry arithmetic — even though Exact's access token lives ten
 * minutes and its refresh token is replaced on every use. The platform owns all
 * of it and hands this package a `fetch` that already carries a valid access
 * token.
 *
 * That is not a convenience. Exact's refresh token is SINGLE-USE: a connector
 * that refreshed for itself would have to persist the replacement, and the
 * context's `secrets` are frozen with no write-back. Every Exact integration
 * that gets this wrong works once and fails on its next call.
 *
 * As with every connector package, it also does not authorize the caller,
 * validate its input or output, decide which hosts it may reach, or manage
 * retries and timeouts.
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
  endpoint: string;
  select?: string;
  filter?: string;
  top?: number;
  skipToken?: string;
};

type CreateRecordInput = {
  endpoint: string;
  payload: Record<string, unknown>;
};

/** Exact wraps every OData answer in `d`, and a collection in `d.results`. */
type ODataEnvelope = {
  d?: { results?: unknown; __next?: unknown } | unknown;
};

function baseUrlOf(context: ConnectorContext): string {
  const region = context.config.region;
  if (typeof region !== "string" || region === "") {
    // Configuration was validated against the contract's schema before it was
    // stored, so this guards a stale installation rather than an expected path.
    throw new Error("Connector is not configured: region is missing.");
  }
  return `https://start.exactonline.${region}`;
}

/**
 * Exact answers JSON only when asked. Without this header it returns XML, which
 * parses as a JSON failure several layers away from the cause.
 */
const JSON_HEADERS = { accept: "application/json" };

async function assertOk(response: Response, what: string): Promise<void> {
  if (response.ok) return;
  // Exact's error bodies quote the offending record, which can carry customer
  // data. Only the status crosses this boundary.
  throw new Error(`Exact Online responded ${response.status} to ${what}.`);
}

function unwrap(payload: ODataEnvelope): unknown {
  const d = (payload as { d?: unknown }).d;
  return d === undefined ? payload : d;
}

/**
 * The division every call needs.
 *
 * Configured when the operator knows which administration they mean, and looked
 * up otherwise. The lookup costs a round trip per operation, which is why the
 * contract's help text asks them to fill it in — but a connector that refused
 * to work until they had found a number in another product would be worse.
 */
async function divisionOf(context: ConnectorContext): Promise<number> {
  const configured = context.config.division;
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return configured;
  }
  const me = await currentDivision(context);
  return me.division;
}

async function currentDivision(
  context: ConnectorContext,
): Promise<{ division: number; userName?: string }> {
  const url = new URL(`${baseUrlOf(context)}/api/v1/current/Me`);
  url.searchParams.set("$select", "CurrentDivision,UserName");

  const response = await context.fetch(url, { headers: JSON_HEADERS });
  await assertOk(response, "the current user");

  const body = unwrap((await response.json()) as ODataEnvelope) as {
    results?: { CurrentDivision?: unknown; UserName?: unknown }[];
  };
  const me = body.results?.[0];
  if (!me || typeof me.CurrentDivision !== "number") {
    throw new Error("Exact Online reported no current division for this user.");
  }
  return {
    division: me.CurrentDivision,
    ...(typeof me.UserName === "string" ? { userName: me.UserName } : {}),
  };
}

/**
 * An endpoint reaches the URL path, so it is validated segment by segment.
 *
 * `salesinvoice/SalesInvoices` is two segments and has to stay two, which rules
 * out encoding the whole string — that would turn the separator into `%2F`.
 * Encoding each segment instead is NOT enough on its own: `encodeURIComponent`
 * leaves a dot alone, so a `..` segment survives it, and `new URL()` then
 * resolves the traversal. `salesinvoice/../../Me` became `/api/v1/Me` — outside
 * the division the caller was scoped to.
 *
 * So relative segments are refused rather than escaped. An endpoint is a name,
 * and no legitimate one contains `.` or `..`.
 */
function endpointPath(endpoint: string): string {
  const segments = endpoint.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) {
    throw new Error("Endpoint is empty.");
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`Endpoint "${endpoint}" contains a relative path segment.`);
    }
  }
  return segments.map(encodeURIComponent).join("/");
}

async function getRecords(
  context: ConnectorContext,
  input: GetRecordsInput,
): Promise<{ records: Record<string, unknown>[]; nextSkipToken?: string }> {
  const division = await divisionOf(context);
  const url = new URL(
    `${baseUrlOf(context)}/api/v1/${division}/${endpointPath(input.endpoint)}`,
  );
  if (input.select) url.searchParams.set("$select", input.select);
  if (input.filter) url.searchParams.set("$filter", input.filter);
  url.searchParams.set("$top", String(input.top ?? 60));
  if (input.skipToken) url.searchParams.set("$skiptoken", input.skipToken);

  const response = await context.fetch(url, { headers: JSON_HEADERS });
  await assertOk(response, `a read of "${input.endpoint}"`);

  const body = unwrap((await response.json()) as ODataEnvelope) as {
    results?: unknown;
    __next?: unknown;
  };
  const records = Array.isArray(body.results)
    ? (body.results as Record<string, unknown>[])
    : [];

  return {
    records,
    // Exact reports more pages as a whole URL carrying a $skiptoken rather than
    // as the token alone. Extracting it keeps the next call this connector's to
    // compose, instead of following a URL from a response body — which would be
    // an egress decision made by the upstream.
    ...(nextSkipToken(body.__next) ? { nextSkipToken: nextSkipToken(body.__next)! } : {}),
  };
}

function nextSkipToken(next: unknown): string | undefined {
  if (typeof next !== "string" || next === "") return undefined;
  try {
    return new URL(next).searchParams.get("$skiptoken") ?? undefined;
  } catch {
    return undefined;
  }
}

async function createRecord(
  context: ConnectorContext,
  input: CreateRecordInput,
): Promise<{ record: Record<string, unknown> }> {
  const division = await divisionOf(context);
  const response = await context.fetch(
    `${baseUrlOf(context)}/api/v1/${division}/${endpointPath(input.endpoint)}`,
    {
      method: "POST",
      headers: { ...JSON_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(input.payload),
    },
  );
  await assertOk(response, `a create on "${input.endpoint}"`);

  const text = await response.text();
  // A created record normally comes back; an empty body is still a success and
  // the contract declares `record` required, so it becomes an empty object
  // rather than a parse failure an operator would read as a write that failed.
  if (text.trim() === "") return { record: {} };
  try {
    return { record: unwrap(JSON.parse(text) as ODataEnvelope) as Record<string, unknown> };
  } catch {
    throw new Error("Exact Online returned a non-JSON body to a create.");
  }
}

const connector = {
  slug: "exact-online",
  contractVersion: 1,
  operations: ["currentDivision", "getRecords", "createRecord"],

  async invoke(
    operationKey: string,
    context: ConnectorContext,
    input: unknown,
  ): Promise<unknown> {
    switch (operationKey) {
      case "currentDivision":
        return currentDivision(context);
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
   * Reads /current/Me, which is authenticated but touches no business data. For
   * an OAuth connector it proves more than reachability: the platform had to
   * hold live tokens to get this far, so a green check means the authorization
   * is good, not merely that Exact is up.
   */
  async verify(context: ConnectorContext): Promise<{ ok: boolean; message?: string }> {
    try {
      const me = await currentDivision(context);
      return { ok: true, message: `Connected to division ${me.division}.` };
    } catch {
      // The platform turns a throw into a redacted "check failed"; answering
      // here keeps the reason at the level of detail an operator can act on
      // without echoing whatever Exact said.
      return { ok: false, message: "Exact Online rejected the request." };
    }
  },
};

export default connector;
