// SPDX-License-Identifier: BUSL-1.1
/**
 * Parent side of the script sandbox: spawns the fixed worker, brokers named
 * reads over the private pipe channel and owns deadline, cancellation, read
 * budget and process cleanup. See worker.ts for the isolate side.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALIAS_PATTERN, DEFAULT_LIMITS, encodeFrame, FrameDecoder, parseJson, parseWorkerMessage, ProtocolError,
  serializeJson, utf8Bytes, validateLimits,
  type JsonValue, type ParentMessage, type ReadDenialCode, type ScriptErrorCode, type ScriptLimits,
} from "./protocol.ts";

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

export interface ScriptReadContext {
  /** Aborted when the run ends for any reason; stop work and do not rely on the result. */
  signal: AbortSignal;
}
/** A named, read-only capability the caller chooses to expose. Arguments and result are JSON only. */
export type ScriptRead = (args: JsonValue, context: ScriptReadContext) => Promise<JsonValue> | JsonValue;

export interface RunScriptRequest {
  /**
   * Untrusted JavaScript (a global script). It must define `function run(input)`,
   * which may be async and returns a JSON value. `host.read(alias, args)` is
   * its only way to reach the outside world.
   */
  source: string;
  input: JsonValue;
  /** Brokered reads by alias. Anything not listed here is denied. */
  reads?: Readonly<Record<string, ScriptRead>>;
  limits?: Partial<ScriptLimits>;
  signal?: AbortSignal;
}

/** Carries only a fixed code. Guest- or broker-controlled text is never included. */
export class ScriptExecutionError extends Error {
  readonly code: ScriptErrorCode;
  constructor(code: ScriptErrorCode) {
    super(`Script execution failed: ${code}`);
    this.name = "ScriptExecutionError";
    this.code = code;
  }
}

const liveWorkers = new Set<{ kill(signal?: number | NodeJS.Signals): void }>();
let exitHookInstalled = false;
function track(worker: { kill(signal?: number | NodeJS.Signals): void }) {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => { for (const live of liveWorkers) { try { live.kill("SIGKILL"); } catch { /* already gone */ } } });
  }
  liveWorkers.add(worker);
}

export async function runScript(request: RunScriptRequest): Promise<JsonValue> {
  const limits = validateLimits({ ...DEFAULT_LIMITS, ...request.limits });
  const reads = request.reads ?? {};
  if (!limits || typeof request.source !== "string" || utf8Bytes(request.source) > limits.maxSourceBytes) throw new ScriptExecutionError("invalid_request");
  if (!Object.keys(reads).every(alias => ALIAS_PATTERN.test(alias) && typeof reads[alias] === "function")) throw new ScriptExecutionError("invalid_request");
  const input = serializeJson(request.input, limits.maxInputBytes);
  if (input === null) throw new ScriptExecutionError("invalid_input");
  if (request.signal?.aborted) throw new ScriptExecutionError("cancelled");

  // An empty directory as cwd and an empty environment: nothing ambient to read or inherit.
  const deadlineAt = performance.now() + limits.deadlineMs;
  const cwd = await mkdtemp(join(tmpdir(), "osf-script-"));
  const controller = new AbortController();
  let settled = false;
  let resolveDone!: (value: JsonValue) => void;
  let rejectDone!: (error: ScriptExecutionError) => void;
  const done = new Promise<JsonValue>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  done.catch(() => undefined);

  let worker: ReturnType<typeof spawnWorker> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => fail("cancelled");

  const stop = () => {
    controller.abort();
    try { worker?.kill("SIGKILL"); } catch { /* already gone */ }
  };
  function fail(code: ScriptErrorCode) {
    if (settled) return;
    settled = true;
    stop();
    rejectDone(new ScriptExecutionError(code));
  }
  function succeed(value: JsonValue) {
    if (settled) return;
    settled = true;
    stop();
    resolveDone(value);
  }

  function executionActive(): boolean {
    if (settled) return false;
    if (request.signal?.aborted) fail("cancelled");
    else if (performance.now() >= deadlineAt) fail("timeout");
    return !settled;
  }

  try {
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (!executionActive()) return await done;
    worker = spawnWorker(cwd);
    track(worker);
    watchdog = setTimeout(() => fail("timeout"), Math.max(0, deadlineAt - performance.now()));

    const activeWorker = worker;
    const write = async (message: ParentMessage): Promise<void> => {
      if (settled) return;
      try {
        activeWorker.stdin.write(encodeFrame(message));
        await activeWorker.stdin.flush();
      } catch {
        fail("worker_failed");
      }
    };

    let readCount = 0;
    let lastId = 0;
    let queue: Promise<void> = Promise.resolve();
    const deny = (id: number, code: ReadDenialCode) => write({ type: "read.denied", id, code });

    const serveRead = async (id: number, alias: string, argsText: string): Promise<void> => {
      // Re-checked here: a run that ended while this read was queued must not reach the broker.
      if (!executionActive()) return;
      const args = parseJson(argsText, limits.maxReadArgsBytes);
      if (!args.ok) return deny(id, "invalid_read");
      if (!ALIAS_PATTERN.test(alias) || !Object.hasOwn(reads, alias)) return deny(id, "unknown_alias");
      let value: string | null;
      try {
        value = serializeJson(await reads[alias]!(args.value, { signal: controller.signal }), limits.maxReadResultBytes);
      } catch {
        return deny(id, "read_failed");
      }
      if (settled) return;
      if (value === null) return deny(id, "read_failed");
      await write({ type: "read.ok", id, value });
    };

    const onMessage = (raw: unknown) => {
      if (!executionActive()) return;
      const message = parseWorkerMessage(raw);
      if (!message) return fail("protocol_violation");
      if (message.type === "failed") return fail(message.code);
      if (message.type === "result") {
        if (utf8Bytes(message.value) > limits.maxResultBytes) return fail("result_too_large");
        const parsed = parseJson(message.value, limits.maxResultBytes);
        return parsed.ok ? succeed(parsed.value) : fail("invalid_result");
      }
      if (message.id <= lastId) return fail("protocol_violation");
      lastId = message.id;
      if (++readCount > limits.maxReads) return fail("read_budget_exceeded");
      // One read at a time, in arrival order, so the broker never sees concurrent calls from one run.
      queue = queue.then(() => serveRead(message.id, message.alias, message.args)).catch(() => fail("worker_failed"));
    };

    const reading = (async () => {
      const decoder = new FrameDecoder();
      try {
        for await (const chunk of activeWorker.stdout) {
          if (settled) return;
          for (const raw of decoder.push(chunk)) onMessage(raw);
        }
      } catch (error) {
        fail(error instanceof ProtocolError ? "protocol_violation" : "worker_failed");
        return;
      }
      // stdout closed without a result: the worker died or went silent.
      fail("worker_failed");
    })();

    await write({ type: "run", source: request.source, input, limits });
    const value = await done;
    await reading.catch(() => undefined);
    return value;
  } finally {
    settled = true;
    clearTimeout(watchdog);
    request.signal?.removeEventListener("abort", onAbort);
    stop();
    if (worker) {
      try { worker.stdin.end(); } catch { /* pipe already closed */ }
      await worker.exited;
      liveWorkers.delete(worker);
    }
    await rm(cwd, { recursive: true, force: true });
  }
}

function spawnWorker(cwd: string) {
  return Bun.spawn([process.execPath, WORKER_PATH], {
    cwd,
    env: {},
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
}
