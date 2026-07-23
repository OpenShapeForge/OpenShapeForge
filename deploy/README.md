# Deploying OpenShapeForge

The API is a Bun service. It expects an **external Postgres** and an
**external OIDC issuer** (Keycloak); this directory does not provision those.

## Container image

Build from the repository root (the build runs `bun run generate`, so the
generated DB schema/types/manifest are baked into the image):

```sh
docker build -f apps/api/Dockerfile -t ghcr.io/openshapeforge/openshapeforge-api:0.1.0 .
```

The image runs the API by default. To run migrations instead, override the
command:

```sh
# API
docker run --rm -p 3001:3001 \
  -e NODE_ENV=production \
  -e DATABASE_URL=postgres://openshapeforge_app:...@host:5432/openshapeforge \
  -e OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI=... \
  -e OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER=... \
  -e OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE=erp-provider \
  -e OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET=... \
  ghcr.io/openshapeforge/openshapeforge-api:0.1.0

# Migrate (privileged role; provisions the restricted app role, rolls the
# generated schema forward, applies versioned migrations)
docker run --rm \
  -e OPENSHAPEFORGE_MIGRATE_DATABASE_URL=postgres://openshapeforge:...@host:5432/openshapeforge \
  ghcr.io/openshapeforge/openshapeforge-api:0.1.0 \
  bun apps/api/src/db/migrate.ts
```

## Helm chart

The chart (`deploy/helm/openshapeforge-api`) deploys the API Deployment + Service
and runs migrations as a **pre-install/pre-upgrade Job**.

Security posture it encodes (see `../SECURITY.md`):

- the API connects as a **restricted** (`NOSUPERUSER NOBYPASSRLS`) role
  (`database.url`) so `FORCE ROW LEVEL SECURITY` is enforced;
- migrations run as a **privileged** role (`database.migrateUrl`) in the Job,
  which provisions the restricted role and applies DDL;
- `NODE_ENV=production` is always set, so the API refuses to start unless a
  bearer **audience** and a strong **internal context secret** are configured.

### Install

Provide credentials via an existing Secret (recommended) with keys
`DATABASE_URL`, `OPENSHAPEFORGE_MIGRATE_DATABASE_URL`,
`OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET`:

```sh
kubectl create secret generic openshapeforge-api \
  --from-literal=DATABASE_URL='postgres://openshapeforge_app:...@host:5432/openshapeforge' \
  --from-literal=OPENSHAPEFORGE_MIGRATE_DATABASE_URL='postgres://openshapeforge:...@host:5432/openshapeforge' \
  --from-literal=OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET='<strong-random>'

helm install openshapeforge deploy/helm/openshapeforge-api \
  --set database.existingSecret=openshapeforge-api \
  --set image.repository=ghcr.io/openshapeforge/openshapeforge-api \
  --set image.tag=0.1.0 \
  --set auth.bearer.jwksUri=https://idp.example.com/realms/openshapeforge/protocol/openid-connect/certs \
  --set auth.bearer.issuer=https://idp.example.com/realms/openshapeforge \
  --set auth.bearer.audience=erp-provider
```

For quick testing you can instead pass `database.url`, `database.migrateUrl`,
and `auth.internalContextSecret` inline and let the chart create the Secret —
do not commit real credentials that way.

Render manifests without installing:

```sh
helm template openshapeforge deploy/helm/openshapeforge-api \
  --set database.existingSecret=openshapeforge-api \
  --set auth.bearer.audience=erp-provider
```

### Notes

- Bring your own Postgres and Keycloak; point the chart at them.
- The migration Job is a Helm hook — on `helm upgrade` it runs before the new
  pods roll. Additive schema changes roll forward automatically; non-additive
  changes require a versioned migration (see `../docs/migrations.md`).
- Enable autoscaling with `autoscaling.enabled=true`, ingress with
  `ingress.enabled=true`.
