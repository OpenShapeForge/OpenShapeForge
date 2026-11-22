// SPDX-License-Identifier: BUSL-1.1
// Runs the real daemon and worker over a real Unix socket in-process. This proves the relay, bounds and
// cleanup logic; the container controls (no network, read-only rootfs, uid, limits) are applied from outside
// and exercised by deploy/script-sandbox/verify.sh.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSandboxDaemon, type SandboxDaemon, type SandboxDaemonOptions } from "./daemon.js";
import { MAX_FRAME_BYTES } from "./protocol.js";
import { ScriptExecutionError, type JsonValue } from "./index.js";
import { createSandboxRunner } from "./socket-channel.js";

let dir: string;
let socketPath: string;
let daemon: SandboxDaemon | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "osf-sbx-"));
  socketPath = join(dir, "s.sock");
});
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await rm(dir, { recursive: true, force: true });
});

const start = async (options: Partial<SandboxDaemonOptions> = {}) => { daemon = await startSandboxDaemon({ socketPath, ...options }); return daemon; };
const run = (source: string, extra: Partial<Parameters<ReturnType<typeof createSandboxRunner>>[0]> = {}) =>
  createSandboxRunner(socketPath)({ source, input: null, ...extra });
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(ScriptExecutionError);
    return (error as ScriptExecutionError).code;
  }
  throw new Error("expected the run to fail");
}
async function untilIdle(d: SandboxDaemon) {
  for (let i = 0; i < 100 && d.activeRuns > 0; i++) await Bun.sleep(50);
  expect(d.activeRuns).toBe(0);
}
/** Resolves when the daemon ends the connection, whatever the peer does. */
const closedByDaemon = (socket: ReturnType<typeof createConnection>) => new Promise<void>(resolve => { socket.on("close", () => resolve()); socket.resume(); });

describe("sandbox daemon over a Unix socket", () => {
  test("returns a deterministic value and serves a brokered read", async () => {
    const d = await start();
    const source = "async function run(i) { const r = await host.read('exact.balance', { id: i.id }); return { sum: [1, 2, 3].reduce((a, b) => a + b, 0), amount: r.amount }; }";
    const reads = { "exact.balance": (args: JsonValue) => ({ amount: (args as { id: number }).id * 10 }) };
    const first = await run(source, { input: { id: 4 }, reads });
    expect(first).toEqual({ sum: 6, amount: 40 });
    expect(await run(source, { input: { id: 4 }, reads })).toEqual(first);
    await untilIdle(d);
  });

  test("cancelling mid-read ends the run and leaves no worker behind", async () => {
    const d = await start();
    const controller = new AbortController();
    const pending = run("async function run() { return await host.read('slow', null); }", {
      signal: controller.signal,
      reads: { slow: () => { controller.abort(); return new Promise<JsonValue>(() => undefined); } },
    });
    expect(await codeOf(pending)).toBe("cancelled");
    await untilIdle(d);
    expect(await run("function run() { return 1; }")).toBe(1);
  });

  test("the per-run deadline fires and the worker is reaped", async () => {
    const d = await start();
    expect(await codeOf(run("function run() { for (;;) {} }", { limits: { deadlineMs: 300 } }))).toBe("timeout");
    await untilIdle(d);
  });

  test("a stuck read times out and the worker is reaped", async () => {
    const d = await start();
    const code = await codeOf(run("async function run() { return await host.read('slow', null); }", {
      limits: { deadlineMs: 300 }, reads: { slow: () => new Promise<JsonValue>(() => undefined) },
    }));
    expect(code).toBe("timeout");
    await untilIdle(d);
  });

  test("the daemon going away mid-run fails the run closed", async () => {
    const d = await start();
    const code = codeOf(run("async function run() { return await host.read('slow', null); }", {
      reads: { slow: () => { void d.close(); return new Promise<JsonValue>(() => undefined); } },
    }));
    expect(await code).toBe("worker_failed");
  });

  test("a run beyond the concurrency cap is refused without starting a worker", async () => {
    const d = await start({ maxConnections: 1 });
    let release!: (value: JsonValue) => void;
    let held!: () => void;
    const holding = new Promise<void>(resolve => { held = resolve; });
    const first = run("async function run() { return await host.read('hold', null); }", {
      reads: { hold: () => { held(); return new Promise<JsonValue>(resolve => { release = resolve; }); } },
    });
    await holding;
    expect(await codeOf(run("function run() { return 1; }"))).toBe("worker_failed");
    release(7);
    expect(await first).toBe(7);
    await untilIdle(d);
  });
});

describe("closed and invalid transports fail closed", () => {
  test("no daemon listening", async () => {
    expect(await codeOf(run("function run() { return 1; }"))).toBe("worker_failed");
  });

  test("path is not a socket, and an unusable path is rejected up front", async () => {
    await writeFile(socketPath, "not a socket");
    expect(await codeOf(run("function run() { return 1; }"))).toBe("worker_failed");
    expect(() => createSandboxRunner("relative.sock")).toThrow();
    expect(() => createSandboxRunner(`/${"x".repeat(200)}`)).toThrow();
  });

  test("an aborted run never connects", async () => {
    const d = await start();
    expect(await codeOf(run("function run() { return 1; }", { signal: AbortSignal.abort() }))).toBe("cancelled");
    await untilIdle(d);
  });

  test("the daemon refuses to start over a live daemon or a regular file", async () => {
    await start();
    await expect(startSandboxDaemon({ socketPath })).rejects.toThrow();
    await daemon?.close();
    daemon = undefined;
    await rm(socketPath, { force: true });
    await writeFile(socketPath, "x");
    await expect(startSandboxDaemon({ socketPath })).rejects.toThrow();
  });
});

describe("hostile or broken peers", () => {
  test("an oversized frame header is dropped and its worker killed", async () => {
    const d = await start();
    const socket = createConnection({ path: socketPath });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1);
    socket.write(header);
    await closedByDaemon(socket);
    await untilIdle(d);
  });

  test("a peer that never completes a frame is dropped after the admission window", async () => {
    const d = await start({ admissionMs: 200 });
    const socket = createConnection({ path: socketPath });
    socket.write(Buffer.from([0, 0, 0])); // a partial header only
    await closedByDaemon(socket);
    await untilIdle(d);
  });

  test("half-closing without a request ends the run", async () => {
    const d = await start();
    const socket = createConnection({ path: socketPath, allowHalfOpen: true });
    socket.end();
    await closedByDaemon(socket);
    await untilIdle(d);
  });

  test("garbage bytes never produce a result", async () => {
    const d = await start();
    const socket = createConnection({ path: socketPath, allowHalfOpen: true });
    const received: Buffer[] = [];
    socket.on("data", chunk => received.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    const frame = Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from("nope")]);
    socket.end(frame);
    await closedByDaemon(socket);
    // Whatever came back is a frame the worker produced itself, never relayed garbage or raw text.
    const body = Buffer.concat(received);
    if (body.length > 0) {
      expect(body.readUInt32BE(0)).toBe(body.length - 4);
      expect(JSON.parse(body.subarray(4).toString())).toEqual({ type: "failed", code: "protocol_violation" });
    }
    await untilIdle(d);
  });

  test("a peer that disconnects mid-run does not leave the worker running", async () => {
    const d = await start();
    const socket = createConnection({ path: socketPath });
    socket.write(Buffer.from([0, 0, 0, 1]));
    await Bun.sleep(100);
    expect(d.activeRuns).toBe(1);
    socket.destroy();
    await untilIdle(d);
  });
});
