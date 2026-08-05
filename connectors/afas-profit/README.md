# Connector: AFAS Profit

Implements the contract in
`packages/compiler/config/authoring/connectors/afas-profit.yaml` against
[ProfitRestServices](https://help.afas.nl/help/NL/SE/App_Cnr_Rest_Api.htm), the
REST surface over the Get- and UpdateConnectors an administrator publishes
inside their own AFAS environment.

Where `object-store/` exists to prove the package shape is implementable, this
one talks to a system that actually exists — so it is also where the model meets
its first real constraints.

## Configuring an installation

| Field | Where it comes from |
| --- | --- |
| Environment number | The digits of the AFAS environment name: `O12345AA` → `12345` |
| Environment | The leading letter: `O` production, `A` acceptance, `T` test |
| AppConnector token | Issued in AFAS under the AppConnector, pasted verbatim |

The number and the environment are separate fields rather than one parsed
string, because the letter never appears in the URL and the digits never
identify the environment on their own. Splitting them is what makes a
production installation impossible to confuse with a test one.

Press **Test connection** after saving. It reads `/profitversion` — authenticated,
but no business data — so the check works before any GetConnector is published
and needs no rights to read one.

## The two operations

- **`getConnector`** — reads a published GetConnector. Rows come back verbatim:
  the columns are configured in the customer's own environment, so the contract
  declares an untyped object collection rather than inventing a column list that
  the output boundary would then reject real responses against.
- **`updateConnector`** — sends an insert (POST) or update (PUT) payload.

## Why `updateConnector` never retries

An AFAS UpdateConnector carries no idempotency key, so a retried insert creates
a second record and nothing afterwards undoes it. The contract therefore
declares `retry.eligible: false`, and the compiler would refuse the alternative:
a retry-eligible mutation without a declared idempotency strategy is a build
error. Declaring `natural` to unlock retries would be claiming a safety AFAS
does not offer.

`afas-profit.test.ts` pins this, so a later change to make writes "more
resilient" fails the suite rather than quietly duplicating invoices.

## Why AFAS is the first ERP connector and Exact Online is not

AFAS issues an AppConnector token once and does not rotate it, which fits the
connector model as it stands: a secret-marked config field, encrypted at rest,
handed to the package as a value.

Exact Online rotates its OAuth2 refresh token on every refresh, and
`ConnectorContext` hands packages a **frozen** secrets object with no write-back
path. An Exact connector built on today's model would authenticate once and fail
on its next call, so it needs a platform capability first.
