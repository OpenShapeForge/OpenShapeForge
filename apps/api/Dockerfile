# syntax=docker/dockerfile:1.26@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# OpenShapeForge API image (Bun). Build from the REPOSITORY ROOT:
#   docker build -f apps/api/Dockerfile -t openshapeforge-api:dev .
# Requires BuildKit and access to the pinned Dockerfile frontend above.
#
# The build runs `bun run generate` so the image carries the generated DB
# schema, Kysely types, and manifest (which are gitignored, reproducible
# artifacts). The same image runs the API (default) and the migrator:
#   API      : docker run ... openshapeforge-api            # default CMD
#   provision: docker run ... openshapeforge-api bun apps/api/src/db/provision-roles.ts
#   migrate  : docker run ... openshapeforge-api bun apps/api/src/db/migrate.ts
#
# The Helm chart (deploy/helm/openshapeforge-api) runs migrate as a pre-upgrade
# Job, provisioning roles before migration, and the API Deployment with the
# restricted role — see docs/api.md and SECURITY.md for the production posture.

# Base images are pinned by DIGEST as well as tag: a tag is mutable and can be
# repointed at different bytes without any diff here. Dependabot's docker
# ecosystem (.github/dependabot.yml) bumps the tag and the digest together.

# --- builder: install workspace deps + generate artifacts --------------------
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder
WORKDIR /app
# Dependency installation only changes when a workspace manifest or lockfile
# changes. Source edits can reuse this layer without re-downloading packages.
# Keep the workspace globs in sync with the root package.json workspaces.
COPY --parents package.json bun.lock bunfig.toml apps/*/package.json packages/*/package.json connectors/*/package.json examples/plugins/*/package.json examples/connectors/*/package.json ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run generate

# --- runtime -----------------------------------------------------------------
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS runtime
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=builder --chown=bun:bun /app /app
USER bun
EXPOSE 3001

# Liveness/readiness are also wired in the Helm chart; this HEALTHCHECK is for
# plain `docker run` usage.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Module-relative file reads mean cwd is irrelevant; run the entry directly.
CMD ["bun", "apps/api/src/index.ts"]
