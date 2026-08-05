// SPDX-License-Identifier: BUSL-1.1
/**
 * Twinfield connector implementation.
 *
 * Implements `authoring/connectors/twinfield.yaml` against Twinfield's SOAP web
 * services — `processxml.asmx` and `finder.asmx`.
 *
 * ## What is missing from this file, and why that is the point
 *
 * There is no OAuth code here. No client credentials, no token endpoint, no
 * refresh, no expiry arithmetic. The platform owns all of it and hands this
 * package a `fetch` that already carries a valid access token, and it is the
 * platform's `authorization: Bearer` header that authenticates every call
 * below.
 *
 * That has one consequence specific to Twinfield, and it decides the shape of
 * this file. Twinfield's SOAP header can carry an `AccessToken` element, and
 * most Twinfield code puts the token there. This package CANNOT: it never holds
 * the token, and the platform's wrapper sets the HTTP header over anything a
 * package supplies. So the SOAP header carries the `CompanyCode` and nothing
 * else, and the credential stays where the platform put it.
 *
 * The same fact settles cluster discovery. Twinfield reports an organisation's
 * cluster from an endpoint that takes the ACCESS TOKEN AS A QUERY PARAMETER;
 * this package holds no token to put there, and a credential in a URL is
 * written to every log that records a request line. The cluster is therefore a
 * configuration field — see the contract's header for the whole argument.
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

type DocumentInput = { document: string };

type SearchInput = {
  type: string;
  pattern?: string;
  field?: number;
  firstRow?: number;
  maxRows?: number;
};

type DocumentResult = {
  document: string;
  succeeded: boolean;
  messages: string[];
};

const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";
const TWINFIELD_NS = "http://www.twinfield.com/";

/**
 * The document roots that only read.
 *
 * `readDocument` requires one and `submitDocument` refuses one, so the
 * query/mutation split is enforced rather than advisory. It is load-bearing in
 * both directions: a write smuggled through the query would be retried on a
 * timeout and would look read-only to an MCP client, and a read pushed through
 * the mutation would be announced as destructive and lose its retries.
 */
const READ_ROOTS = new Set(["read", "list"]);

// --- Configuration ----------------------------------------------------------

/**
 * The host this organisation's data lives on.
 *
 * Constrained again here even though the contract's validation pattern already
 * demands twinfield.com and `network.egress` refuses anything else at runtime.
 * This is the last thing before a URL is built out of a stored string, and
 * `https://` + an unchecked value is how a userinfo segment or a stray path
 * turns one host into another.
 */
function clusterHostOf(context: ConnectorContext): string {
  const host = context.config.clusterHost;
  if (typeof host !== "string" || !/^[a-z0-9][a-z0-9.-]*$/.test(host)) {
    // Configuration was validated against the contract's schema before it was
    // stored, so this guards a stale installation rather than an expected path.
    throw new Error("Connector is not configured: clusterHost is missing or malformed.");
  }
  return host;
}

/** Optional: `listOffices` is how an operator finds the code in the first place. */
function companyCodeOf(context: ConnectorContext): string | undefined {
  const code = context.config.companyCode;
  return typeof code === "string" && code !== "" ? code : undefined;
}

// --- XML, without a dependency ----------------------------------------------
//
// Everything below is a targeted scanner over element names this connector
// already knows, NOT a general XML parser. That is a deliberate trade: a SOAP
// client's usual parser dependency buys namespace handling and entity
// resolution, and entity resolution is precisely what nobody wants pointed at
// a response from the far end. Nothing here expands an entity, follows a
// DOCTYPE or fetches an external reference, because nothing here interprets
// one. The response document is also handed back verbatim, so a caller that
// needs full fidelity parses it with a parser of its own choosing.

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => XML_ESCAPES[character] ?? character);
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function unescapeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return XML_ENTITIES[body] ?? whole;
  });
}

/** An element's attribute string and its inner content, namespace prefix ignored. */
type XmlElement = { attributes: string; inner: string };

function* elements(xml: string, localName: string): Generator<XmlElement> {
  const open = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${localName}(\\s[^>]*?)?(/?)>`, "g");
  const close = new RegExp(`</(?:[A-Za-z0-9_.-]+:)?${localName}\\s*>`, "g");
  let match: RegExpExecArray | null;
  while ((match = open.exec(xml)) !== null) {
    if (match[2] === "/") {
      yield { attributes: match[1] ?? "", inner: "" };
      continue;
    }
    close.lastIndex = open.lastIndex;
    const end = close.exec(xml);
    if (!end) return;
    yield { attributes: match[1] ?? "", inner: xml.slice(open.lastIndex, end.index) };
    // Past the whole element, so a same-named child cannot be yielded twice and
    // a close tag cannot be claimed by two openings.
    open.lastIndex = close.lastIndex;
  }
}

function firstElement(xml: string, localName: string): XmlElement | undefined {
  for (const element of elements(xml, localName)) return element;
  return undefined;
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attributes);
  const raw = match?.[2] ?? match?.[3];
  return raw === undefined ? undefined : unescapeXml(raw);
}

/** Text content, or "" when the element has children rather than text. */
function plainText(inner: string): string {
  return inner.includes("<") ? "" : unescapeXml(inner).trim();
}

// --- SOAP -------------------------------------------------------------------

/**
 * A SOAP 1.1 envelope.
 *
 * The header element is omitted entirely rather than sent empty when no company
 * is configured — `listOffices` reports the companies an authorization can
 * reach, and scoping that to one of them would defeat it.
 */
function envelope(companyCode: string | undefined, body: string): string {
  const header =
    companyCode === undefined
      ? ""
      : `<soap:Header><Header xmlns="${TWINFIELD_NS}">` +
        `<CompanyCode>${escapeXml(companyCode)}</CompanyCode>` +
        `</Header></soap:Header>`;
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="${SOAP_NS}">` +
    header +
    `<soap:Body>${body}</soap:Body>` +
    `</soap:Envelope>`
  );
}

/**
 * Post one SOAP request and return the response envelope.
 *
 * No `Authorization` header is set here. The platform's wrapper adds it, and a
 * package supplying its own would be overridden anyway — see the file header.
 */
async function callSoap(
  context: ConnectorContext,
  input: { service: string; action: string; body: string; companyCode?: string; what: string },
): Promise<string> {
  const response = await context.fetch(
    `https://${clusterHostOf(context)}/webservices/${input.service}`,
    {
      method: "POST",
      headers: {
        "content-type": "text/xml; charset=utf-8",
        // Quoted, as SOAP 1.1 requires. An .asmx endpoint routes on this and
        // answers an unrecognised action with a fault rather than a 404.
        soapaction: `"${TWINFIELD_NS}${input.action}"`,
      },
      body: envelope(input.companyCode, input.body),
    },
  );
  if (!response.ok) {
    // Twinfield's fault bodies quote the document that caused them, which can
    // carry customer data. Only the status crosses this boundary.
    throw new Error(`Twinfield responded ${response.status} to ${input.what}.`);
  }

  const text = await response.text();
  // A SOAP fault is an HTTP 200 as often as it is a 500, so the status alone
  // does not decide whether the call worked.
  if (firstElement(text, "Fault") !== undefined) {
    throw new Error(`Twinfield returned a SOAP fault for ${input.what}.`);
  }
  return text;
}

// --- ProcessXmlDocument -----------------------------------------------------

/**
 * Refuse a caller document this connector must not forward as-is.
 *
 * The document is embedded VERBATIM in the envelope, because `xmlRequest` takes
 * an element rather than a string and escaping it would send Twinfield a piece
 * of text where it expects a document. Three things are therefore refused
 * before it goes anywhere:
 *
 * - an XML declaration or any processing instruction, which is only legal at
 *   the very start of a document and would corrupt the envelope from inside;
 * - a DOCTYPE, because entity declarations are the XXE vector and forwarding
 *   one would make this connector the deputy that smuggles it into somebody
 *   else's parser;
 * - a root element on the wrong side of the read/write split.
 */
function assertDocument(document: string, operation: "read" | "write"): string {
  const trimmed = document.trim();
  if (!trimmed.startsWith("<")) {
    throw new Error("The Twinfield document is not XML.");
  }
  if (/<\?/.test(trimmed)) {
    throw new Error("The Twinfield document carries a processing instruction or XML declaration.");
  }
  if (/<!DOCTYPE/i.test(trimmed)) {
    throw new Error("The Twinfield document declares a DOCTYPE, which this connector will not forward.");
  }
  const root = /^<([A-Za-z_][A-Za-z0-9_.:-]*)/.exec(trimmed)?.[1];
  if (root === undefined) {
    throw new Error("The Twinfield document has no root element.");
  }
  const reads = READ_ROOTS.has(root.toLowerCase());
  if (operation === "read" && !reads) {
    throw new Error(`"${root}" is not a Twinfield read document; submitDocument takes writes.`);
  }
  if (operation === "write" && reads) {
    throw new Error(`"${root}" is a Twinfield read document; readDocument takes reads.`);
  }
  return trimmed;
}

/**
 * The outcome Twinfield reports INSIDE the document.
 *
 * A rejected write comes back as HTTP 200 with `result="0"` on the elements
 * that failed and the reason in a `msg` attribute beside it. A caller reading
 * only the status code books nothing and is told it worked, which is why
 * `succeeded` is a required output field rather than a convenience.
 */
function outcomeOf(document: string): { succeeded: boolean; messages: string[] } {
  let succeeded = true;
  for (const match of document.matchAll(/\bresult\s*=\s*"([^"]*)"/g)) {
    if (match[1] !== "1") succeeded = false;
  }
  const messages: string[] = [];
  for (const match of document.matchAll(/\bmsg\s*=\s*"([^"]*)"/g)) {
    const message = unescapeXml(match[1] ?? "").trim();
    if (message !== "" && !messages.includes(message)) messages.push(message);
  }
  return { succeeded, messages };
}

async function processXml(
  context: ConnectorContext,
  document: string,
  what: string,
  companyCode?: string,
): Promise<DocumentResult> {
  const response = await callSoap(context, {
    service: "processxml.asmx",
    action: "ProcessXmlDocument",
    body:
      `<ProcessXmlDocument xmlns="${TWINFIELD_NS}">` +
      `<xmlRequest>${document}</xmlRequest>` +
      `</ProcessXmlDocument>`,
    ...(companyCode !== undefined ? { companyCode } : {}),
    what,
  });

  const result = firstElement(response, "ProcessXmlDocumentResult");
  if (result === undefined) {
    throw new Error(`Twinfield returned no ProcessXmlDocument result for ${what}.`);
  }
  const inner = result.inner.trim();
  return { document: inner, ...outcomeOf(inner) };
}

async function readDocument(
  context: ConnectorContext,
  input: DocumentInput,
): Promise<DocumentResult> {
  const document = assertDocument(input.document, "read");
  return processXml(context, document, "a read document", companyCodeOf(context));
}

async function submitDocument(
  context: ConnectorContext,
  input: DocumentInput,
): Promise<DocumentResult> {
  const document = assertDocument(input.document, "write");
  return processXml(context, document, "a submitted document", companyCodeOf(context));
}

/**
 * The companies this authorization can reach.
 *
 * Deliberately sent without a `CompanyCode` header: this is the operation an
 * operator runs BEFORE they know their code, the way Exact's currentDivision
 * reports the division that fills its own configuration field.
 */
async function listOffices(
  context: ConnectorContext,
): Promise<{ offices: Record<string, unknown>[] }> {
  const result = await processXml(
    context,
    "<list><type>offices</type></list>",
    "the company list",
  );

  const offices: Record<string, unknown>[] = [];
  for (const office of elements(result.document, "office")) {
    // Twinfield's office list has been described with the code as the element's
    // text and with it as an attribute. Both are accepted rather than returning
    // a list of blanks against the shape this deployment did not expect — and
    // this is one of the shapes that stays unproven until a real organisation
    // is authorized.
    const text = plainText(office.inner);
    const code = attribute(office.attributes, "code") ?? text;
    const name = attribute(office.attributes, "name") ?? (code === text ? "" : text);
    if (code === "") continue;
    offices.push({ code, ...(name !== "" ? { name } : {}) });
  }
  return { offices };
}

// --- The finder -------------------------------------------------------------

async function search(
  context: ConnectorContext,
  input: SearchInput,
): Promise<{ rows: Record<string, unknown>[]; totalRows: number }> {
  const response = await callSoap(context, {
    service: "finder.asmx",
    action: "Search",
    body:
      `<Search xmlns="${TWINFIELD_NS}">` +
      `<type>${escapeXml(input.type)}</type>` +
      `<pattern>${escapeXml(input.pattern ?? "*")}</pattern>` +
      `<field>${Math.trunc(input.field ?? 0)}</field>` +
      `<firstRow>${Math.trunc(input.firstRow ?? 1)}</firstRow>` +
      `<maxRows>${Math.trunc(input.maxRows ?? 100)}</maxRows>` +
      `</Search>`,
    // The finder is scoped by the SOAP header the same way everything else is.
    ...(companyCodeOf(context) !== undefined ? { companyCode: companyCodeOf(context)! } : {}),
    what: "a finder search",
  });

  const rows: Record<string, unknown>[] = [];
  for (const row of elements(response, "ArrayOfString")) {
    const values: string[] = [];
    for (const cell of elements(row.inner, "string")) values.push(plainText(cell.inner));
    rows.push({ values });
  }

  const total = firstElement(response, "TotalRows");
  const totalRows = total ? Number.parseInt(plainText(total.inner), 10) : Number.NaN;
  // Twinfield reports the total so a caller can page with firstRow. When it
  // says nothing, the rows in hand are all anyone can claim to know about.
  return { rows, totalRows: Number.isFinite(totalRows) ? totalRows : rows.length };
}

// --- The package ------------------------------------------------------------

const connector = {
  slug: "twinfield",
  contractVersion: 1,
  operations: ["listOffices", "readDocument", "search", "submitDocument"],

  async invoke(
    operationKey: string,
    context: ConnectorContext,
    input: unknown,
  ): Promise<unknown> {
    switch (operationKey) {
      case "listOffices":
        return listOffices(context);
      case "readDocument":
        return readDocument(context, input as DocumentInput);
      case "search":
        return search(context, input as SearchInput);
      case "submitDocument":
        return submitDocument(context, input as DocumentInput);
      default:
        throw new Error(`Unknown operation "${operationKey}".`);
    }
  },

  /**
   * The connectivity check behind `configuration.verify: true`.
   *
   * Lists companies, which is authenticated and touches no business data. It
   * proves three things at once, and the third is why the cluster may be
   * configuration at all: the OAuth tokens are live, Twinfield accepts the SOAP
   * envelope this package builds, and the configured cluster is the one this
   * organisation actually lives on.
   */
  async verify(context: ConnectorContext): Promise<{ ok: boolean; message?: string }> {
    try {
      const { offices } = await listOffices(context);
      return {
        ok: true,
        message: `Connected to ${context.config.clusterHost as string}; ${offices.length} compan${
          offices.length === 1 ? "y" : "ies"
        } available.`,
      };
    } catch {
      // The platform turns a throw into a redacted "check failed"; answering
      // here keeps the reason at a level an operator can act on without echoing
      // whatever Twinfield said.
      return {
        ok: false,
        message:
          "Twinfield did not answer on this cluster host. Check the cluster host, " +
          "and reconnect if the authorization has lapsed.",
      };
    }
  },
};

export default connector;
