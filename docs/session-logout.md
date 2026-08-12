# Session logout

The web and control-plane applications use one framework-neutral logout
orchestrator from `@openshapeforge/auth`. Each application keeps its own thin
adapter for Auth.js, Redis, cookie names, Keycloak realm, and client credentials.
Neither application imports the other application's source.

## Local security boundary

Logout is POST-only and requires both the canonical public origin and an
Auth.js CSRF token. After Auth.js accepts the request, the application removes
the exact Redis session with a single-key get-and-delete operation. Refresh and
profile-hydration writers use compare-and-set against that same session value,
so a writer that loses the race cannot recreate the deleted session.

If the local session cannot be removed, the endpoint returns `503`, withholds
all cookie-clearing headers, and reports failure to the user. Automatic
session-expiry logout retries one such `503` after one second with a fresh CSRF
token. It then stops and shows the normal failure state; other errors are not
retried.

## Identity-provider revocation

After local deletion, the server makes one bounded backchannel logout request
to Keycloak using the consumed refresh token. This step is best effort. If it
fails, the server emits the configured warning, still returns local logout
success, and clears the browser cookies. The Keycloak SSO session or refresh
token may therefore remain usable until its own expiry.

The refresh lock reduces overlap between token rotation and revocation, but its
TTL is not an identity-provider revocation guarantee. The proven guarantee is
narrower: Redis deletion plus compare-and-set fencing prevents the deleted
local application session from being recreated.
