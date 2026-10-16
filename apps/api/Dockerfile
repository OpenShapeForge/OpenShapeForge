# OpenShapeForge API image (Bun). Build from the REPOSITORY ROOT:
#   docker build -f apps/api/Dockerfile -t openshapeforge-api:dev .
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
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS builder
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run generate

# --- runtime -----------------------------------------------------------------
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS runtime
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=builder /app /app
RUN chown -R bun:bun /app
USER bun
EXPOSE 3001

# Liveness/readiness are also wired in the Helm chart; this HEALTHCHECK is for
# plain `docker run` usage.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Module-relative file reads mean cwd is irrelevant; run the entry directly.
CMD ["bun", "apps/api/src/index.ts"]
