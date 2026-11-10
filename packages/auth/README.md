# Shared browser sessions

The `./session` export owns the Redis session, Keycloak refresh and Auth.js
callbacks for both application and control-plane hosts. Initial sessions use
the verified provider account ID as their subject. Refresh must preserve that
subject and the host's authority invariant.

A refresh deadline covers both headers and the response body and fits inside
the distributed lease. The write checks the lease owner and session existence
atomically, so an expired lease or logout cannot be undone by a delayed result.
HTTP 429, provider/network failures and configuration failures retain the
session for retry. A definitive `invalid_grant` or invalid successful token
response ends it. During recovery, expired access tokens and roles are withheld;
the session cookie remains usable. `refreshRetryAt` is an epoch in milliseconds.

## Updating existing hosts

The refresh lock is now `{<session key>}:refresh-lock` so it occupies the same
Redis Cluster slot as the unchanged session key. Replace all processes sharing
a session prefix together: drain old authentication requests before starting
the new generation. Old and new processes use different lock keys and must not
refresh sessions concurrently. This applies to rollback too. No session data
rewrite is needed for the key change. Sessions created with an older, incorrect
Auth.js-local subject need a fresh login; they cannot bypass the subject check.

## Regression evidence

Unit tests cover timeout and retry classification, expired authority, competing
writers and logout. `bun run test:redis` requires an explicitly configured
isolated Redis instance and checks the real atomic write. The
[browser recovery fixture](../../apps/web/e2e/recovery/README.md) signs in through
Keycloak, injects temporary transport failures and proves recovery with the same
browser session. It does not claim full application UI or deployed-provider
acceptance.
