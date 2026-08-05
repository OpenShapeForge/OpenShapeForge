# Connector: Twinfield

Implements the contract in `authoring/connectors/twinfield.yaml` against
Twinfield's SOAP web services — `processxml.asmx` and `finder.asmx`.

The first connector here whose upstream is **SOAP/XML rather than REST**. Its
OAuth needs no new platform vocabulary: authorization code at
`login.twinfield.com` with refresh tokens, which is what the Exact Online
connector already uses. Everything below is about the parts that differ.

## Why there is no OAuth code in this package

The platform obtains, stores, refreshes and rotates the tokens and hands this
package a `fetch` that already carries a valid access token. There is no client
secret, no expiry arithmetic and no refresh in `index.ts`, and that absence is
the design.

For Twinfield it has one consequence that shapes the whole package. Twinfield's
SOAP header can carry an `AccessToken` element, and most Twinfield code puts the
token there. **This package cannot**: it never holds the token, and the
platform's wrapper sets the HTTP `Authorization` header over anything a package
supplies. So the SOAP header carries the `CompanyCode` and nothing else, and the
credential stays where the platform put it. A test asserts the envelope contains
no credential at all.

## The cluster is configuration, not a discovery round trip

The access token does not say which host to call. An organisation lives on a
Twinfield cluster and every call after sign-in goes there. The issue behind this
connector left the choice open — a discovery round trip per operation, the way
Exact's division lookup works, or a configuration field an operator fills in
once. **It is a configuration field**, for three reasons in descending order of
force:

1. **The package cannot make the discovery call.** Twinfield reports the cluster
   from `/auth/authentication/connect/accesstokenvalidation?token=<access token>`
   — an endpoint that authenticates by carrying the access token **in the query
   string**. This package never holds that token. Under platform-owned OAuth the
   round trip is not merely expensive, it is unavailable.
2. **A credential in a URL is a logging problem.** This repository already
   refuses it: the compiler rejects interpolating a secret configuration field
   into an OAuth endpoint, because a URL is written to every log that records a
   request line. Discovery would be that, once per operation.
3. **It is not a per-call fact.** Exact's "current division" genuinely changes;
   an organisation's cluster does not. Paying a round trip on every operation to
   re-learn a constant is the wrong trade against a rate-limited SOAP API.

What that costs, and how it is contained: a stale or mistyped value can name a
host this organisation does not live on. It cannot name an arbitrary one — the
configuration field is pattern-constrained to `twinfield.com`, `network.egress`
refuses anything else at runtime, and **`verify` proves it** before anyone
relies on it. Tests cover all three.

If a future Twinfield revision accepts a bearer header on the validation
endpoint, discovery becomes possible; the configuration field would still be the
right default, with discovery as the fallback when it is left empty — exactly
the shape Exact uses for its division.

## Egress: one entry, and `**.` rather than `*.`

```yaml
network:
  egress:
    - "**.twinfield.com"
```

Sign-in is at `login.twinfield.com` while the data is on a per-organisation
cluster host, so the allowlist has to cover both. `hostAllowed` in
`apps/api/src/connectors/executor.ts` matches `*.` against **exactly one** extra
label: `*.twinfield.com` reaches `accounting.twinfield.com` and refuses
`api.accounting.twinfield.com`. `**.` matches any depth, which is why it exists —
the executor's own documentation names Twinfield as the reason.

So **one entry covers everything**, and nothing had to be enumerated. Neither
wildcard matches the bare apex or a lookalike, so the grant is still this
vendor's domain and nothing else: `twinfield.com`, `evil-twinfield.com` and
`twinfield.com.evil.example` are all outside it. A test pins each of those, and
pins that `*.` would not have been enough.

## Configuring an installation

| Field | Where it comes from |
| --- | --- |
| Cluster host | The host this organisation's data lives on. Most are `accounting.twinfield.com` |
| Company code | Optional. The administration to work in; `listOffices` reports the codes |
| Client ID / secret | The application you registered with Twinfield |

Register the redirect URI with Twinfield as
`<OPENSHAPEFORGE_PUBLIC_ORIGIN>/api/rest/v1/connectors/oauth/callback`. It must
match character for character.

Then **Save**, **Connect** — which sends you to Twinfield's consent screen — and
**Test connection**, which lists the companies this authorization can reach.

The contract asks for `offline_access` alongside Twinfield's own scopes. Without
it there is no refresh token, and the installation would need a person at a
consent screen every time the access token expired.

## The four operations

They are Twinfield's own web services rather than a generic
`getRecords`/`createRecord` pair, because there is nothing generic to name: a
request is an XML document, not a path with a query string.

- **`listOffices`** — `ProcessXmlDocument` with `<list><type>offices</type></list>`.
  The companies this authorization can reach. Sent deliberately **without** a
  `CompanyCode`, because it is what an operator runs before they know their code
  — the same role Exact's `currentDivision` plays. Also the `verify` call.
- **`readDocument`** — `ProcessXmlDocument` with a caller-supplied read document.
- **`search`** — the finder, for looking codes up by pattern. Pages by row
  offset rather than by a continuation token.
- **`submitDocument`** — `ProcessXmlDocument` with a caller-supplied write
  document.

### Reads and writes are separate operations on purpose

Both hit the same web service, and one operation could have carried both. It
would have had to be a `mutation`, which drives more than a label: GraphQL field
placement, the REST method, the MCP read-only and destructive hints, and retry
eligibility. Every read would then be announced as destructive and would forfeit
its retries.

So the split is **enforced, not advisory**: `readDocument` requires a root
element of `read` or `list`, and `submitDocument` refuses one. A write cannot be
smuggled through the retryable, read-only-labelled path.

### `succeeded` is a required output field, not a convenience

Twinfield answers a **rejected** write with HTTP 200 and reports the failure as
`result="0"` on the elements inside the returned document, with the reason in a
`msg` attribute. A caller that checks only the status code books nothing and is
told it worked. `succeeded` and `messages` are therefore part of the declared
output of both document operations, and a test pins the rejected-write case.

The response document itself comes back **verbatim**, because its shape is per
Twinfield document type and an installation's own data is its own.

## Why `submitDocument` never retries

`ProcessXmlDocument` accepts no idempotency key. The SOAP header carries the
company and nothing else, and a document carries no client-supplied request id
Twinfield deduplicates on — the transaction number some document types accept is
a numbering-scheme value, normally assigned by Twinfield, not a dedupe key. A
retried `<transaction>` books a second journal entry and nothing afterwards
undoes it.

The contract therefore declares `retry.eligible: false`. The compiler would
refuse the alternative — a retry-eligible mutation without a declared idempotency
strategy is a build error — and declaring `natural` to unlock retries would be
claiming a safety Twinfield does not offer. `twinfield.test.ts` pins it, so a
later change to make writes "more resilient" fails the suite rather than quietly
duplicating journal entries.

## XML without a dependency

This package adds **no runtime dependency**. The envelope is composed as a
string with XML escaping, and the response is read by a targeted scanner over
element names the connector already knows — not a general XML parser.

That is a deliberate trade rather than a shortcut. A SOAP client's usual parser
dependency buys namespace handling and entity resolution, and entity resolution
is exactly what nobody wants pointed at a response from the far end. Nothing
here expands an entity, follows a DOCTYPE or fetches an external reference,
because nothing here interprets one. A caller needing full fidelity gets the
response document verbatim and can parse it with a parser of its own choosing.

The request side has the matching rule. The caller's document is embedded
**verbatim** in the envelope — `xmlRequest` takes an element, and escaping it
would send Twinfield text where it expects a document — so three things are
refused before anything leaves the process:

| Refused | Why |
| --- | --- |
| A DOCTYPE | Entity declarations are the XXE vector. Forwarding one makes this connector the deputy that smuggles it into somebody else's parser |
| An XML declaration or processing instruction | Legal only at the very start of a document; inside the envelope it corrupts it |
| A root element on the wrong side of the read/write split | See above |

## What is not proven

**Nothing here has reached Twinfield.** The provider is stubbed in tests, as it
is for Exact Online and AFAS Profit, and nothing will have reached it until
someone authorizes a real organisation. What that leaves open, specifically:

- The SOAP envelope, the SOAPAction values and the `CompanyCode` header element
  are built to Twinfield's documented shapes and have never been accepted by
  Twinfield itself.
- Twinfield's office list has been described both with the company code as the
  `<office>` element's text and as an attribute. The package reads either rather
  than returning a list of blanks against the shape this deployment did not
  expect.
- The finder's exact response nesting is read by scanning for `ArrayOfString`
  groups at any depth, which is tolerant of more than one arrangement, and
  `TotalRows` falls back to the row count in hand when it is absent.
- That an access token issued for one organisation is accepted on the configured
  cluster is the assumption `verify` exists to check, and it has only ever been
  checked against a stub.
