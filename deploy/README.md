# Deploying OpenShapeForge

The API is a Bun service. It expects an **external Postgres** and an
**external OIDC issuer** (Keycloak); this directory does not provision those.

## Container image

Images are published to GHCR automatically by
[`.github/workflows/docker-api.yml`](../.github/workflows/docker-api.yml):

| Trigger                            | Tags pushed                    |
| ---------------------------------- | ------------------------------ |
| pull request (whatever its base)   | none — build + smoke test only |
| push to `main`                     | `main`, `sha-<commit>`         |
| tag `v0.1.0`                       | `0.1.0`, `0.1`, `latest`       |
| manual run on any other ref        | none — build + smoke test only |

Publishing is gated on the **ref**, not on the event: only `refs/heads/main` and
`refs/tags/v*` authenticate to GHCR at all. A feature branch builds and
smoke-tests the image — that is the gate — but nothing it produces reaches the
registry, however the workflow was triggered. `.github/workflows/ci.yml` and the
image workflows run on pull requests to *any* base branch so that a stacked PR
is gated too (issue #269), which is what makes that distinction load-bearing.

`latest` follows the newest release tag, not the newest `main` commit. Pin an
explicit version in the chart (`image.tag`) for anything but scratch testing.

To build the same image locally, run this from the repository root (the build
runs `bun run generate`, so the generated DB schema/types/manifest are baked
into the image):

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

## Deploy pipeline

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) runs
`helm upgrade --install` against the Scaleway Kapsule cluster. It is
`workflow_dispatch` only — deploys are deliberately a decision, not a
side effect of merging — and runs against the `dev` GitHub Environment, so
required reviewers can gate it.

It builds nothing: it installs images already published by the `API image` and
`Keycloak image` workflows, and verifies both tags exist in GHCR **before**
touching the cluster, so a missing tag fails fast instead of surfacing as an
`ImagePullBackOff` minutes into a doomed rollout.

The workflow header lists every required repository secret. The database values
all come from Terraform in
[OpenShapeForge-Base](https://github.com/OpenShapeForge/OpenShapeForge-Base) —
read them with `terraform output -raw <name>`.

> The GHCR packages are **private**, so the pipeline creates a `ghcr-pull`
> docker-registry Secret from `GHCR_PULL_TOKEN` (a PAT with `read:packages`) on
> every deploy. Drop that secret only if the packages are made public.

### Inputs

The defaults describe a **production deploy of the current `main`**: leave every
input untouched and you get `sha-<short commit>` on `api.openshapeforge.eu` and
`auth.openshapeforge.eu`, with a production realm and Let's Encrypt production
certificates.

Two inputs change what the deployment *is*, rather than merely where it runs:

| Input | Production | Iterating |
| --- | --- | --- |
| `realm_mode` | `production` — client secrets come from Secret Manager | `development` — permits the committed `devSecret` literals and `sslRequired: none` |
| `tls_issuer` | `letsencrypt-prod` | `letsencrypt-staging` — untrusted root, but no rate limit to burn (prod allows only 5 failed validations per hostname per hour) |

A development realm on a public hostname would publish a Keycloak whose client
secrets are readable in this repository, so the workflow **refuses** to combine
either non-production setting with a live hostname. Iterate against a different
hostname, or with the hosts left empty for a ClusterIP-only release.

## Helm chart

The chart (`deploy/helm/openshapeforge-api`) deploys the API Deployment + Service
and runs migrations as a **pre-install/pre-upgrade Job**. It can also deploy a
**worker workload**, off by default.

### Worker workload (optional, off by default)

The image is one entry point with several roles: `OPENSHAPEFORGE_ROLE` picks
which one `apps/api/src/index.ts` starts. `api` is the default and is the HTTP
server. Any other value names a background worker role contributed by a runtime
module — the workflow plugin contributes `workflow-worker`, the process that
drains `workflow.control_commands`, fires due `workflow.schedules` and resumes
due timer waits. Without it those queues fill and nothing reads them.

```sh
helm upgrade --install openshapeforge deploy/helm/openshapeforge-api \
  --set workers.enabled=true            # off by default
  # --set workers.role=workflow-worker  # the default; a value, not a literal
  # --set workers.replicaCount=2        # the default
```

It renders one extra Deployment (`<release>-openshapeforge-api-worker`) and
nothing else. Decisions worth knowing before you enable it — all of them
restated at their setting in `values.yaml`:

- **No Service, no Ingress, no probes.** The worker listens on nothing, so the
  API's `httpGet` probes do not transfer, an `exec` probe would have nothing to
  observe, and a real liveness signal would mean the worker publishing a tick
  timestamp — a change to the `ModuleWorkerHandle` contract, not to this chart.
  What that accepts: a worker that is alive but **wedged** is invisible to
  Kubernetes. What bounds it: a claim older than the queue's visibility timeout
  is reclaimed by another replica, so a wedged worker costs throughput rather
  than commands.
- **Two replicas, and the chart says so.** `for update skip locked` plus a
  conditional consume make N replicas safe by construction, so the number is
  purely an availability choice: two keeps the queue moving through a node
  drain and turns one wedged worker into half the throughput instead of none.
  Set `workers.replicaCount=1` if a queue that pauses while a node is replaced
  is acceptable.
- **No autoscaling.** `autoscaling.enabled` scales the API Deployment and does
  not reach the worker. CPU is the wrong signal for a poll loop — an idle
  worker and a worker blocked on a slow database both sit near zero, and every
  replica added runs another claim scan per second against the same tables. The
  signal that matters is queue depth, which needs a metrics adapter this chart
  does not deploy.
- **`terminationGracePeriodSeconds: 150`.** `stop()` settles only after the
  in-flight tick, so too short a grace period turns a clean redeploy into one
  abandoned command per replica. 120s is where waiting stops buying anything
  (the queue's own visibility timeout, and the dispatch timeout to a
  durable-execution ingress — the same number in the worker's code); 30s covers
  the schedule and timer sweeps that `stop()` drains first, plus closing the
  pool.
- **Same image, same Secret, same restricted database role** as the API. The
  worker reaches the three queue tables through their RLS policies by presenting
  `app.worker_role` — nothing is bypassed (see
  [`../docs/api.md`](../docs/api.md#the-worker-axis)).
- **`workers.role` fails the render when empty**, or when set to `api`:
  `index.ts` reads `OPENSHAPEFORGE_ROLE?.trim() || "api"`, so either would
  quietly start a second copy of the HTTP server with no Service in front of it.

With `networkPolicy.enabled=true` the worker gets its own policy: **egress
only** — DNS and Postgres from the API's settings (one place names the
database), plus the durable-execution ingress when
`workers.networkPolicy.egress.durableExecution.enabled=true`. It has no ingress
rules, because it has no port to admit anyone to.

A durable-execution service is configured through `workers.extraEnv`, not
through a chart-specific setting, for the same reason the role name is a value:
`OPENSHAPEFORGE_WORKFLOW_RESTATE_*` belongs to the workflow plugin, and the
chart should not know a plugin's variable names any better than it knows its
role names. Absent it, the worker uses its in-process dispatcher, which is the
default and correct on its own.

### Keycloak subchart (optional, off by default)

`charts/keycloak` deploys Keycloak using the image built from
`packages/keycloak-spi` — official Keycloak plus this project's SPI provider jar.
It is vendored as a first-party subchart rather than pulled from upstream
precisely because no upstream chart knows about that image.

It stays **disabled** unless `keycloak.enabled=true`, so the documented
bring-your-own-issuer posture is unchanged for production.

Enabling it does **not** auto-configure `auth.bearer.*` — you must set those
yourself. `issuer` has to match the `iss` claim in issued tokens exactly, which
depends on the external URL clients use, so inferring it would be wrong more
often than right:

```sh
--set auth.bearer.issuer=https://idp.example.com/realms/openshapeforge \
--set auth.bearer.jwksUri=https://idp.example.com/realms/openshapeforge/protocol/openid-connect/certs \
--set auth.bearer.audience=erp-provider
```

The realm is **not** baked into the image — `bun run generate` produces an
environment-specific, gitignored realm file, so it is supplied at deploy time
with `--set-file keycloak.realm.json=keycloak/openshapeforge-realm.json` and
stored in a Secret (a realm export can carry client secrets). Keycloak only
imports a realm that does not already exist, so this is safe across upgrades.

`bun run generate` emits **one file per authored realm**, and there are two:
the tenant realm `openshapeforge` and the control realm `openshapeforge-control`
(the issuer `apps/admin` signs platform operators in against). The chart carries
one, and the one it carries is the tenant realm — name it explicitly. The deploy
workflow does this through `env.TENANT_REALM`; a glob would sort
`openshapeforge-control-realm.json` first and import the wrong realm.

#### What is public, and what is not

Keycloak's ingress routes only the prefixes the chart is told to route.
`keycloak.ingress.publicRealm: <realm>` derives the right set:

| Routed | Not routed |
| --- | --- |
| `/realms/<realm>/.well-known` | `/admin` — the console |
| `/realms/<realm>/protocol` | `/realms/master` |
| `/realms/<realm>/login-actions` | `/realms/<realm>/openshapeforge` — the SPI |
| `/resources` | `/realms/<realm>/account` |

The last exclusion is the reason `publicRealm` exists. The
identity-configuration SPI is a `RealmResourceProvider` mounted *inside* the
realm path, so the obvious prefix `/realms/<realm>` publishes it — which is
what a 2026-07-27 review found. Its only caller is `apps/api`, in-cluster, with
the `openshapeforge-auth-api` service-account credential, so it has no reason to
be reachable from the internet at all. Declaring `keycloak.ingress.hosts[].paths`
explicitly still works, but a prefix that would route the SPI **fails the
render** rather than publishing it quietly.

### `apps/admin` is dev and CI only — no chart, on purpose

`deploy/helm/` deploys the API and, optionally, Keycloak. It does not deploy
`apps/web`, and it does not deploy `apps/admin`. That is a decision, not a gap:

- **No precedent and no image.** `apps/api/Dockerfile` is the only Dockerfile in
  the repository. Neither Next app is containerised, so a chart for `apps/admin`
  would need an image, a build workflow, and a publish step before it had
  anything to install.
- **It would need its own public ingress.** `apps/admin` is a browser
  application; deploying it means publishing an operator console. The control
  plane is the highest-privilege surface in the system — it creates, suspends
  and reparents tenants across every tenant boundary, through an audited
  `withSystemSession` bypass — so putting its front door on the internet is a
  larger decision than adding a chart, and one nobody has taken. It is exactly
  the decision the SPI section above is undoing for a smaller surface.
- **Its dependencies are not in the chart either.** It stores OIDC sessions in
  Redis, which this chart does not deploy, and it needs the control realm, which
  the deploy workflow deliberately does not install.
- **Nothing is blocked by the absence.** Tenants are provisioned through
  `/api/control/v1` with an operator token; `apps/admin` is a client of that API,
  not a component the API depends on.

**Consequence for the API chart:** the control routes are registered
unconditionally but the chart sets none of the `OPENSHAPEFORGE_CONTROL_*`
variables, so `/api/control/v1` answers `503` naming what is missing. It is
inert in every deployment this chart produces. **Before configuring it, take it
off the public ingress too** — the API's ingress routes `/`, so the moment the
control plane is configured it is also published. `/api/control/v1` is its own
mount for exactly this reason: excluding it is a path rule, not a per-route
exception list.

Security posture it encodes (see `../SECURITY.md`):

- the API connects as a **restricted** (`NOSUPERUSER NOBYPASSRLS`) role
  (`database.url`) so `FORCE ROW LEVEL SECURITY` is enforced;
- a **worker** connects as a *second* restricted role (`database.workerUrl`).
  The workflow queue policies compare `current_user` against
  `openshapeforge_worker`, so the connected role — not a session variable — is
  what authorizes a cross-tenant claim, and the API's role can no longer make
  one. A worker process refuses to start on `DATABASE_URL`, including when it
  is copied into `OPENSHAPEFORGE_WORKER_DATABASE_URL`;
- migrations run as a **privileged** role (`database.migrateUrl`) in the Job,
  which provisions both restricted roles and applies DDL. The worker role gets
  DML on only the tables a worker touches, never the platform control plane
  (`platform.connector_secrets`, `platform.api_keys`, `platform.tenants`, …);
- `NODE_ENV=production` is always set, so the API refuses to start unless a
  bearer **audience** and a strong **internal context secret** are configured.

### Install

Provide credentials via an existing Secret (recommended) with keys
`DATABASE_URL`, `OPENSHAPEFORGE_MIGRATE_DATABASE_URL`,
`OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET` — plus
`OPENSHAPEFORGE_WORKER_DATABASE_URL` and `OPENSHAPEFORGE_WORKER_PASSWORD` when a
worker workload is deployed:

```sh
kubectl create secret generic openshapeforge-api \
  --from-literal=DATABASE_URL='postgres://openshapeforge_app:...@host:5432/openshapeforge' \
  --from-literal=OPENSHAPEFORGE_MIGRATE_DATABASE_URL='postgres://openshapeforge:...@host:5432/openshapeforge' \
  --from-literal=OPENSHAPEFORGE_WORKER_DATABASE_URL='postgres://openshapeforge_worker:...@host:5432/openshapeforge' \
  --from-literal=OPENSHAPEFORGE_WORKER_PASSWORD='<strong-random, different from the app role>' \
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
- **Upgrading past the worker role (#223) needs one new value.**
  `database.workerPassword` is required whenever the chart manages the Secret,
  even on an install that runs no worker: the emitted RLS policies name
  `openshapeforge_worker` either way, and the migrate Job is what creates it. A
  role the policies name and nothing creates fails *silently* — a worker would
  read an empty queue rather than an error — so the render fails instead, with a
  message saying so. `database.workerUrl` stays empty until a worker workload is
  deployed; a worker pod without it refuses to boot rather than falling back to
  the API's credentials.
  **`deploy.yml` reads it from Secret Manager as `<prefix>-worker-password`, so
  that entry must exist before the first deploy past this change** — create it
  with a strong random value distinct from `<prefix>-app-password`. The workflow
  fails naming the missing entry rather than proceeding.
- Enable autoscaling with `autoscaling.enabled=true`, ingress with
  `ingress.enabled=true`, the background worker with `workers.enabled=true`
  (see above — autoscaling covers the API Deployment only).
- **Ingress requires TLS.** `ingress.enabled=true` with an empty `ingress.tls`
  fails the render instead of serving bearer tokens and signed context headers
  over plaintext HTTP. Supply a `tls` entry (with a cert-manager annotation, or
  a pre-provisioned secret); where TLS is terminated upstream by a load balancer
  or mesh, say so explicitly with `ingress.allowPlaintext=true`. When TLS is
  configured the chart also adds ingress-nginx `ssl-redirect` annotations —
  override `ingress.sslRedirect.annotations` for a different controller. The
  same rules apply to `keycloak.ingress.*`.
- **Credential rotation rolls the pods.** With chart-managed credentials a
  `checksum/secret` pod annotation changes when a value does, so `helm upgrade`
  restarts the pods onto the new credential. With `database.existingSecret` the
  chart cannot hash contents it does not render — rotate, then
  `kubectl rollout restart deploy/<release>-openshapeforge-api` yourself.
- **The containers run with a read-only root filesystem.** The API writes
  nothing (verified by the `--read-only` smoke test in
  `.github/workflows/docker-api.yml`); the chart mounts an emptyDir at `/tmp`
  regardless. Keycloak gets emptyDirs at `/opt/keycloak/data` and `/tmp`, which
  is all it needs given the image already ran `kc.sh build` and the pod starts
  with `start --optimized`. Set `tmpVolume.enabled=false` or
  `keycloak.writableVolumes.enabled=false` only alongside
  `securityContext.readOnlyRootFilesystem=false`.
