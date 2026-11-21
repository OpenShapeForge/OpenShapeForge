// SPDX-License-Identifier: BUSL-1.1
/**
 * Sandbox daemon: the small trusted process inside the dedicated, network-less
 * script-sandbox container. It listens on one Unix socket and gives every
 * admitted connection a fresh fixed QuickJS worker (empty environment, own
 * process, CPU/lifetime/idle/concurrency/byte bounds), relaying the binary
 * frame protocol verbatim in both directions. It never parses, rewrites or
 * invents messages: the parent broker validates everything it receives, and the
 * daemon only checks frame lengths so a peer cannot stream unbounded bytes.
 *
 * What the daemon cannot assert about itself (no network, read-only rootfs, no
 * mounts of app code or secrets, non-root uid, memory and pids limits, seccomp)
 * is applied from outside; see deploy/script-sandbox/README.md.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { LIMIT_CEILINGS, MAX_FRAME_BYTES, ProtocolError } from "./protocol.js";
import { WORKER_PATH } from "./local-channel.js";

export interface SandboxDaemonOptions {
  socketPath: string;
  /** Simultaneous runs; a connection beyond this is closed without starting a worker. */
  maxConnections?: number;
  /** A peer must deliver its first complete frame within this time or is dropped. */
  admissionMs?: number;
  /** Hard wall-clock cap per run; the worker is SIGKILLed at this point whatever the parent does. */
  lifetimeMs?: number;
  /** Byte caps per run, counted per direction. */
  maxInboundBytes?: number;
  maxOutboundBytes?: number;
  /** Test seam: argv of the worker. Defaults to the fixed Bun worker under a CPU rlimit. */
  workerArgv?: (cpuSeconds: number) => string[];
}

export interface SandboxDaemon {
  readonly activeRuns: number;
  close(): Promise<void>;
}

const DEFAULTS = {
  maxConnections: 4,
  admissionMs: 5_000,
  lifetimeMs: LIMIT_CEILINGS.deadlineMs + 2_000,
  // Largest legitimate run: source+input, then maxReads results of maxReadResultBytes.
  maxInboundBytes: LIMIT_CEILINGS.maxReads * (LIMIT_CEILINGS.maxReadResultBytes + 1024) + 2 * MAX_FRAME_BYTES,
  maxOutboundBytes: 4 * MAX_FRAME_BYTES,
};
/** After the worker finished, how long a peer may keep its side open before we drop it. */
const LINGER_MS = 2_000;

/** Counts length-prefixed frames without buffering payloads; throws on oversize frames or too many bytes. */
class FrameGate {
  frames = 0;
  private total = 0;
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private payloadLeft = 0;
  constructor(private readonly maxTotal: number) {}

  check(chunk: Uint8Array): void {
    this.total += chunk.byteLength;
    if (this.total > this.maxTotal) throw new ProtocolError("stream too large");
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.payloadLeft > 0) {
        const take = Math.min(this.payloadLeft, chunk.byteLength - offset);
        this.payloadLeft -= take;
        offset += take;
        if (this.payloadLeft === 0) this.frames++;
        continue;
      }
      const take = Math.min(4 - this.headerBytes, chunk.byteLength - offset);
      this.header.set(chunk.subarray(offset, offset + take), this.headerBytes);
      this.headerBytes += take;
      offset += take;
      if (this.headerBytes < 4) continue;
      this.headerBytes = 0;
      this.payloadLeft = this.header.readUInt32BE(0);
      if (this.payloadLeft > MAX_FRAME_BYTES) throw new ProtocolError("frame too large");
      if (this.payloadLeft === 0) this.frames++;
    }
  }
}

function defaultWorkerArgv(cpuSeconds: number): string[] {
  // The rlimit is applied by the shell before exec; if it cannot be set, the worker is not started.
  return ["/bin/sh", "-c", 'ulimit -t "$1" || exit 70; shift; exec "$@"', "sandbox-worker", String(cpuSeconds), process.execPath, WORKER_PATH];
}

export async function startSandboxDaemon(options: SandboxDaemonOptions): Promise<SandboxDaemon> {
  const config = { ...DEFAULTS, ...options };
  const workerArgv = options.workerArgv ?? defaultWorkerArgv;
  const runs = new Set<() => void>();
  await clearStaleSocket(config.socketPath);

  const server: Server = createServer({ allowHalfOpen: true }, socket => serve(socket));
  server.on("error", () => undefined);

  function serve(socket: Socket): void {
    if (runs.size >= config.maxConnections) return void socket.destroy();
    const inbound = new FrameGate(config.maxInboundBytes);
    const outbound = new FrameGate(config.maxOutboundBytes);
    let child: ChildProcess | undefined;
    let ended = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    // Every path (peer gone, error, violation, timer, worker exit) funnels here; it is idempotent.
    const finish = () => {
      if (ended) return;
      ended = true;
      for (const timer of timers) clearTimeout(timer);
      runs.delete(finish);
      try { child?.kill("SIGKILL"); } catch { /* already gone */ }
      socket.destroy();
    };
    runs.add(finish);
    socket.on("error", finish);
    socket.on("close", finish);

    try {
      const [command, ...args] = workerArgv(Math.ceil(config.lifetimeMs / 1000) + 1);
      child = spawn(command!, args, { cwd: "/", env: {}, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return finish();
    }
    const worker = child;
    worker.on("error", finish);
    worker.stdin!.on("error", () => undefined); // EPIPE after the worker exited; `close` below reports the end
    timers.push(setTimeout(finish, config.lifetimeMs));
    const admission = setTimeout(() => { if (inbound.frames === 0) finish(); }, config.admissionMs);
    timers.push(admission);

    relay(socket, worker.stdin!, inbound, finish);
    relay(worker.stdout!, socket, outbound, finish);
    // Peer half-close: tell the worker no more input is coming; it can still answer.
    socket.on("end", () => worker.stdin!.end());
    // Worker finished: its output was relayed first (stream order); close our side, then drop a lingering peer.
    worker.on("close", () => {
      if (ended) return;
      socket.end();
      timers.push(setTimeout(finish, LINGER_MS));
    });
  }

  const previous = process.umask(0o117);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.socketPath, () => { server.off("error", reject); resolve(); });
    });
    await chmod(config.socketPath, 0o660);
  } catch (error) {
    server.close();
    throw error;
  } finally {
    process.umask(previous);
  }

  return {
    get activeRuns() { return runs.size; },
    async close() {
      const closing = new Promise<void>(resolve => server.close(() => resolve()));
      for (const finish of [...runs]) finish(); // server.close waits for connections, so end them first
      await closing;
    },
  };
}

/** Moves bytes with explicit backpressure; frame-length violations tear the run down. */
function relay(from: Readable, to: Writable, gate: FrameGate, onViolation: () => void): void {
  from.on("data", (chunk: Buffer) => {
    try { gate.check(chunk); } catch { return onViolation(); }
    if (to.destroyed) return;
    if (!to.write(chunk)) {
      from.pause();
      to.once("drain", () => from.resume());
    }
  });
}

/** Removes a leftover socket file from a crashed daemon; refuses anything else or a live daemon. */
async function clearStaleSocket(path: string): Promise<void> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isSocket()) throw new Error("Sandbox socket path exists and is not a socket");
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(path);
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error("Sandbox daemon is already listening on this socket"));
    });
    probe.once("error", (error: NodeJS.ErrnoException) =>
      error.code === "ECONNREFUSED" ? resolve() : reject(error));
  });
  const current = await lstat(path);
  if (!current.isSocket() || current.ino !== stat.ino || current.dev !== stat.dev) {
    throw new Error("Sandbox socket changed during startup");
  }
  await unlink(path);
}

if (import.meta.main) {
  const daemon = await startSandboxDaemon({ socketPath: process.env.SCRIPT_SANDBOX_SOCKET ?? "/run/script-sandbox/sandbox.sock" });
  const shutdown = () => void daemon.close().then(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
