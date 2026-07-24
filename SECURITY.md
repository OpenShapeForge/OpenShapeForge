# Security Policy

OpenShapeForge is authorization and data-isolation infrastructure — a generated
GraphQL API with Postgres row-level security and tenant isolation. Security
reports are taken seriously.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report privately through GitHub's **[Private vulnerability reporting](https://github.com/OpenShapeForge/OpenShapeForge/security/advisories/new)**
(the "Report a vulnerability" button under the repository's **Security** tab).
This keeps the report confidential until a fix is available.

If Private vulnerability reporting is unavailable to you (for example, the
button is not shown, or you cannot access it), email
**security@openshapeforge.example** instead (maintainer: replace with the real
monitored address before publishing). Do not include exploit details in a
public issue.

Please include:

- a description of the vulnerability and its impact,
- the affected component (compiler, generated schema/RLS, GraphQL API, auth
  path, migrations),
- steps to reproduce (a minimal request or entity config where possible),
- the commit or version you tested.

You will get an acknowledgement within 3 business days of a report being
received, and an initial assessment of severity and next steps within 7
business days. Please allow reasonable time for a fix before any public
disclosure; coordinated disclosure is appreciated.

## Scope

In scope — issues in this repository's code:

- cross-tenant data access (RLS / tenant-isolation bypass),
- authentication bypass or downgrade (bearer verification, trusted-context
  HMAC), privilege or scope escalation,
- SQL injection or unsafe dynamic SQL in the generated CRUD engine,
- the row-access owner/group policy emission,
- denial-of-service reachable through the API.

Out of scope:

- the **local development stack** (`docker-compose.local.yml`) and its
  intentional dev-only credentials — `admin/admin`, `dev-secret`,
  `openshapeforge-local-dev-context-secret`, the `openshapeforge/openshapeforge` Postgres
  user, the `acme-*` demo users, `POSTGRES_HOST_AUTH_METHOD=trust`,
  `sslRequired: none`. These are documented dev values (see `AGENTS.md`) and
  must never be used in production. A report that they are "insecure" in the
  dev stack is not a vulnerability; a report that a **production deployment
  guide or default** ships them **is**.
- vulnerabilities in third-party dependencies — report those upstream (see
  `THIRD-PARTY-NOTICES.md`); we will bump once a fix is released.

## Deploying securely

If you deploy OpenShapeForge, the production posture the code expects (enforced at
startup by `assertProductionEnv` when `NODE_ENV=production`):

- connect the API as a **non-superuser, non-BYPASSRLS** Postgres role so
  `FORCE ROW LEVEL SECURITY` is actually enforced (`DATABASE_URL`); run
  migrations with a separate privileged role (`OPENSHAPEFORGE_MIGRATE_DATABASE_URL`),
- set a real bearer issuer/JWKS **and audience**
  (`OPENSHAPEFORGE_API_VERIFY_BEARER_*`),
- set a strong, non-default `OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET`,
- terminate TLS and require it at the identity provider,
- never expose the local-dev compose ports or credentials.
