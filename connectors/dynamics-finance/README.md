# Connector: Microsoft Dynamics 365 Finance

Implements the contract in `authoring/connectors/dynamics-finance.yaml` against
the [OData endpoint](https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/data-entities/odata)
under `/data`.

The first connector that authenticates as an **application** rather than on
behalf of a person.

## What is different about it

Entra ID issues a token from the client credentials alone — no consent screen,
no callback, no refresh token. So there is no **Connect** button on the
integrations page for this connector, and there never will be: saving the client
details is the whole setup, and the token is minted on first use.

That is the `flow: clientCredentials` the contract declares. Before it existed,
this contract could not be authored at all.

## Configuring an installation

| Field | Where it comes from |
| --- | --- |
| Environment host | Your Dynamics URL without `https://` — production `contoso.operations.dynamics.com`, sandbox usually deeper |
| Entra tenant ID | The directory the app registration lives in |
| Application (client) ID / secret | The app registration |

Two steps that are easy to miss, because neither is in Azure:

1. The application must also be **registered inside Dynamics** (System
   administration → Setup → Microsoft Entra ID applications), mapped to a
   service account user.
2. That user's security roles decide what the connector can actually read and
   write. A token with no roles authenticates fine and returns nothing.

Press **Test connection** afterwards. It reads `$metadata`, which proves the app
registration, the secret and the scope all line up — not merely that Dynamics is
reachable.

## The scope is load-bearing

`https://{environmentHost}/.default` is interpolated from the environment host.
Entra issues a token for whatever audience the scope names, so a wrong or
unfilled one produces a token that is **valid but rejected by the API later**, as
a 401 that explains nothing. The compiler refuses a scope naming an undeclared
field, and a test asserts the filled value reaches the token request.

## Two hosts

The token comes from `login.microsoftonline.com` and the data from the
customer's own environment, so both are in `network.egress`. The environment
entry is `**.dynamics.com` rather than `*.dynamics.com`, because a sandbox sits
two labels deep (`contoso-uat.sandbox.operations.dynamics.com`) where a
single-label wildcard covers only production.

## Why `createRecord` never retries

A Dynamics data entity takes no idempotency key, so a retried POST creates a
second journal entry and nothing afterwards undoes it. The contract declares
`retry.eligible: false`, and `dynamics-finance.test.ts` pins it.

## Entity names refuse separators

A data entity is a single set name. Anything containing `/`, `.` or `..` is
refused rather than escaped — `encodeURIComponent` leaves a dot alone, so a
relative segment survives it and `new URL()` then resolves the traversal. The
Exact connector hit exactly that, where `salesinvoice/../../Me` escaped the
division it was scoped to.
