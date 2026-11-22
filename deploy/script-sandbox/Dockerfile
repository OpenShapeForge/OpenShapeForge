# syntax=docker/dockerfile:1.26@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Script sandbox daemon image. Build from the REPOSITORY ROOT:
#   docker build -f deploy/script-sandbox/Dockerfile -t openshapeforge-script-sandbox:dev .
#
# The image holds only the daemon, the fixed worker, the frame protocol and
# QuickJS. No API code, database client, config or secret is copied in. The
# isolation (no network, read-only rootfs, dropped capabilities, limits) is NOT
# set here: a daemon cannot assert its own container controls. Run it with
# deploy/script-sandbox/run.sh, which applies them from outside.

# Same digest-pinned base as apps/api/Dockerfile (Dependabot bumps tag and digest together).
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS deps
WORKDIR /opt/sandbox
COPY deploy/script-sandbox/package.json deploy/script-sandbox/bun.lock ./
RUN bun install --production --frozen-lockfile

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS runtime
WORKDIR /opt/sandbox
COPY --from=deps /opt/sandbox/node_modules ./node_modules
COPY apps/api/src/script-sandbox/channel.ts apps/api/src/script-sandbox/local-channel.ts \
     apps/api/src/script-sandbox/protocol.ts apps/api/src/script-sandbox/worker.ts \
     apps/api/src/script-sandbox/daemon.ts ./src/
# Distinct identities: 10001 runs the daemon; group 10002 is the only group allowed on the socket.
# The setgid directory makes a fresh named volume inherit this ownership and the group on the socket.
RUN mkdir -p /run/script-sandbox \
 && chown 10001:10002 /run/script-sandbox \
 && chmod 2750 /run/script-sandbox \
 && chmod -R a-w /opt/sandbox
USER 10001:10002
ENV SCRIPT_SANDBOX_SOCKET=/run/script-sandbox/sandbox.sock
VOLUME /run/script-sandbox
ENTRYPOINT ["bun", "/opt/sandbox/src/daemon.ts"]
