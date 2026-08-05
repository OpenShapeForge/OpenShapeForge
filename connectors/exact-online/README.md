# Connector: Exact Online

Implements the contract in `authoring/connectors/exact-online.yaml` against
[Exact Online's REST API](https://start.exactonline.nl/docs/HlpRestAPIResources.aspx).

This is the connector the platform's OAuth support was built for.

## Why there is no OAuth code in this package

Exact issues a **single-use** refresh token and replaces it on every refresh. A
connector that refreshed for itself would have to persist the replacement, and
`ConnectorContext` hands packages a frozen `secrets` object with no write-back —
so it would authenticate once and fail on its next call.

The platform owns the whole lifecycle instead: it obtains, stores, refreshes and
rotates the tokens, and this package is handed a `fetch` that already carries a
valid access token. There is no client secret, no expiry arithmetic and no
refresh in this file, and that absence is the design.

## Configuring an installation

| Field | Where it comes from |
| --- | --- |
| Country | The ending of the address you sign in at — Exact runs a separate instance per country, each with its own data |
| Client ID / secret | The app you registered in the Exact App Centre |
| Division | Optional. The administration to work in; left empty, the current one is looked up |

Register the redirect URI with Exact as
`<OPENSHAPEFORGE_PUBLIC_ORIGIN>/api/rest/v1/connectors/oauth/callback`. It must
match character for character.

Then **Save**, **Connect** — which sends you to Exact's consent screen — and
**Test connection**, which reads `/current/Me` and reports the division it
reached.

## The three operations

- **`currentDivision`** — reports the administration the authorized user is in.
  Useful for filling the Division field, and the cheapest proof the tokens work.
- **`getRecords`** — reads any entity set with OData `$select`, `$filter`,
  `$top` and Exact's opaque continuation token. Records come back verbatim,
  because an installation's custom fields are its own.
- **`createRecord`** — posts to an entity set.

## Why `createRecord` never retries

Exact's OData endpoints take no idempotency key, so a retried POST creates a
second invoice and nothing afterwards undoes it. The contract declares
`retry.eligible: false`, and the compiler would refuse the alternative — a
retry-eligible mutation without a declared idempotency strategy is a build
error. `exact-online.test.ts` pins it, so a later change to make writes "more
resilient" fails the suite rather than quietly duplicating invoices.

## Endpoint paths refuse relative segments

`salesinvoice/SalesInvoices` is two path segments and has to stay two, so the
endpoint cannot simply be URL-encoded whole. Encoding each segment is not enough
either: `encodeURIComponent` leaves a dot alone, so `salesinvoice/../../Me`
survived it and `new URL()` resolved the traversal to `/api/v1/Me` — outside the
division the caller was scoped to. Relative segments are refused rather than
escaped, and a test covers each shape.
