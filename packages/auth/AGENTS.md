# Auth Package Rules

Canonical identity model + claim parsers + the two verifier paths (HMAC
trusted-context for in-mesh hops, JWKS-backed bearer for trust-boundary
services), plus one composed browser session under `./session`. The root
export stays framework-neutral: no Fastify, no Next, no Auth.js wiring.

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
- `session/` (`@openshapeforge/auth/session`) — the Keycloak-backed
  NextAuth session on Redis that apps/web and apps/admin share: store,
  refresh mutex and retry budget, cookie set, callbacks, Keycloak
  settings and production-env validation. An app composes one
  (`createSessionAuth`) with its realm defaults, key and cookie prefixes,
  admit gate, extra stored fields and refresh invariant; nothing
  app-specific lives here. This subpath is the only one that reads
  `process.env` and depends on `next-auth` / `ioredis` (peers).

## Out of scope

- HTTP framework plugins (Fastify, Next route handlers) — apps write a
  thin adapter; the root export stays framework-neutral.
- Secret / env loading outside `./session` — callers pass values in, so
  the verifiers stay trivially testable.

## Build / consumption

TypeScript source uses **NodeNext-style** relative specifiers (`./claims.js`,
etc.): they refer to the **emitted** sibling `.js` next to each `.ts` file.
Next.js (Webpack and Turbopack) resolves those paths to real files, so the
published entry is **`dist/`** from `bun run --cwd packages/auth build`. The
repo root **`postinstall`** runs that build after `bun install`. Edit `src/`
only; apps import `@openshapeforge/auth` (resolved to `dist/` via `package.json`).
