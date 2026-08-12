# Auth Package Rules

Canonical identity model + claim parsers + the two verifier paths (HMAC
trusted-context for in-mesh hops, JWKS-backed bearer for trust-boundary
services). Framework-neutral: no Fastify, no Next, no Auth.js wiring.

## Scope

- `types.ts` — `AuthIdentity` is the single shape consumers receive,
  regardless of which verifier produced it.
- `claims.ts` — pure functions over `jose.JWTPayload`. No I/O. Keycloak
  claim shape (`realm_access.roles`, `resource_access.<client>.roles`,
  the `organization` claim, the profile fallback chain) lives here and
  nowhere else.
- `trusted-context.ts` — `applyTrustedContextHeaders` (signs identity
  headers with HMAC-SHA256) and `readTrustedContext` (verifies them).
  Replay window is 5 minutes; fail closed when secret is missing.
- `bearer.ts` — `createBearerVerifier({ jwksUri, issuer, audience })`
  returns a verifier function. Pass `keySet` instead of `jwksUri` in
  tests to bypass the JWKS HTTP fetch.
- `logout.ts` — configuration-free server logout orchestration over standard
  Fetch `Request`/`Response` objects. Apps supply their Auth.js adapter, Redis
  consumer, cookie names, and identity-provider credentials.
- `logout-client.ts` — configuration-free browser logout orchestration,
  including the single bounded retry used by automatic session expiry.

## Out of scope

- Auth.js / Keycloak provider config — stays in `apps/web/src/lib/auth/`.
- Redis session store — stays in `apps/web/src/lib/auth/`.
- HTTP framework plugins (Fastify, Next route handlers) — apps write a thin
  adapter around the standard Fetch contracts; keep this package
  framework-neutral.
- Secret / env loading — callers pass values in. The package never reads
  `process.env` directly so it stays trivially testable.

## Build / consumption

TypeScript source uses **NodeNext-style** relative specifiers (`./claims.js`,
etc.): they refer to the **emitted** sibling `.js` next to each `.ts` file.
Next.js (Webpack and Turbopack) resolves those paths to real files, so the
published entry is **`dist/`** from `bun run --cwd packages/auth build`. The
repo root **`postinstall`** runs that build after `bun install`. Edit `src/`
only; apps import `@openshapeforge/auth` (resolved to `dist/` via `package.json`).
