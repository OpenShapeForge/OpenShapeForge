# Script sandbox container

Dedicated boundary for running bounded untrusted JavaScript (the QuickJS worker
in `apps/api/src/script-sandbox`). The API keeps the broker and all authority;
this container only runs the worker and relays frames over a private Unix socket.
The OSF API only offers fixture evaluation when configured for a designated pilot tenant. This runner does not activate a tenant on its own.

```
API / runner (broker)  --Unix socket on dedicated volume-->  daemon (container)  -->  fresh worker per run
```

## Controls (applied from outside; the daemon cannot assert them itself)

`run.sh` starts the container with: `--network none`, `--read-only` rootfs with a
16 MiB `noexec` tmpfs, `--user 10001:10002`, `--cap-drop ALL`, `no-new-privileges`,
`--pids-limit 64`, 512 MiB memory (no swap), 2 CPUs, `--init` (reaps workers), and
exactly one mount: the socket volume. No app code, data, secrets or Docker socket.

The caller mounts the same volume read-only at `/run/script-sandbox` and joins group `10002`
(`--group-add 10002`; it must not run as uid 10001). The socket is `0660`, group
`10002`, in a `2750` setgid directory. Admission is this filesystem permission only:
share the volume with nothing else.

## Daemon bounds

Per connection: a fresh `bun worker.ts` with an empty environment and cwd `/`,
CPU rlimit (`ulimit -t`, worker is not started if it cannot be set), hard lifetime
(ceiling deadline + 2 s), 5 s to deliver the first complete frame, at most 4
concurrent runs (extra connections are closed), per-direction byte caps, and frame
length checks in both directions. Backpressure is explicit (`pause`/`drain`).
Bytes are relayed verbatim; the daemon never parses or fabricates JSON. A peer
close, error or protocol violation kills the worker (SIGKILL). A half-close ends the input stream and lets the worker finish sending its output.

## Verify

`deploy/script-sandbox/verify.sh` (repo root, needs Docker) builds the image,
asserts the controls via `docker inspect`/`exec`, then runs
`apps/api/src/script-sandbox/container-proof.ts` from a separate network-less
caller container: deterministic value, brokered read, cancellation, missing-socket
failure, and finally checks that no worker process remains.
In-process tests: `bun test apps/api/src/script-sandbox`.

## API pilot configuration

Set `OPENSHAPEFORGE_SCRIPT_SANDBOX_SOCKET` to the private socket path and
`OPENSHAPEFORGE_SCRIPT_SANDBOX_PILOT_TENANTS` to one tenant UUID. With both
unset, fixture evaluation is unavailable. Use one runner per pilot tenant.

## Known gaps

- Seccomp is Docker's default profile; no custom profile yet.
- Memory is bounded by the container limit, not per worker.
