# OpenShapeForge API image (Bun). Build from the REPOSITORY ROOT:
#   docker build -f apps/api/Dockerfile -t openshapeforge-api:dev .
#
# The build runs `bun run generate` so the image carries the generated DB
# schema, Kysely types, and manifest (which are gitignored, reproducible
# artifacts). The same image runs the API (default) and the migrator:
#   API      : docker run ... openshapeforge-api            # default CMD
#   migrate  : docker run ... openshapeforge-api bun apps/api/src/db/migrate.ts
#
# The Helm chart (deploy/helm/openshapeforge-api) runs migrate as a pre-upgrade
# Job with the privileged DB URL, and the API Deployment with the restricted
# role — see docs/api.md and SECURITY.md for the production posture.

# --- builder: install workspace deps + generate artifacts --------------------
# Pin base images by digest, not just the mutable :1.3.4 tag, so a repushed or
# compromised upstream tag cannot silently alter the build. Refresh the digest
# together with the tag (e.g. via Renovate/Dependabot).
FROM oven/bun:1.3.4@sha256:7608db4aeb44f1fe8169cc8ec7055376b3013557b106407ccf092b00e426407d AS builder
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run generate

# --- runtime -----------------------------------------------------------------
FROM oven/bun:1.3.4@sha256:7608db4aeb44f1fe8169cc8ec7055376b3013557b106407ccf092b00e426407d AS runtime
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
