// SPDX-License-Identifier: BUSL-1.1
/**
 * Parent side of the script sandbox: opens a channel to a fresh fixed worker
 * (local subprocess fixture or container socket), brokers named reads over it
 * and owns deadline, cancellation, read budget and cleanup. See worker.ts for
 * the isolate side and daemon.ts for the container side.
 */
import type { OpenWorkerChannel, WorkerChannel } from "./channel.js";
import { openLocalWorker } from "./local-channel.js";
import {
  ALIAS_PATTERN, DEFAULT_LIMITS, encodeFrame, FrameDecoder, parseJson, parseWorkerMessage, ProtocolError,
  serializeJson, utf8Bytes, validateLimits,
  type JsonValue, type ParentMessage, type ReadDenialCode, type ScriptErrorCode, type ScriptLimits,
} from "./protocol.js";

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

/** Runs against the local subprocess fixture. Production code uses `createSandboxRunner` (socket-channel.ts). */
export const runScript = (request: RunScriptRequest): Promise<JsonValue> => runScriptWith(openLocalWorker, request);

export async function runScriptWith(open: OpenWorkerChannel, request: RunScriptRequest): Promise<JsonValue> {
  const limits = validateLimits({ ...DEFAULT_LIMITS, ...request.limits });
  const reads = request.reads ?? {};
  if (!limits || typeof request.source !== "string" || utf8Bytes(request.source) > limits.maxSourceBytes) throw new ScriptExecutionError("invalid_request");
  if (!Object.keys(reads).every(alias => ALIAS_PATTERN.test(alias) && typeof reads[alias] === "function")) throw new ScriptExecutionError("invalid_request");
  const input = serializeJson(request.input, limits.maxInputBytes);
  if (input === null) throw new ScriptExecutionError("invalid_input");
  if (request.signal?.aborted) throw new ScriptExecutionError("cancelled");

  // The deadline starts here, so it also covers however long the transport takes to open.
  const deadlineAt = performance.now() + limits.deadlineMs;
  const controller = new AbortController();
  let settled = false;
  let resolveDone!: (value: JsonValue) => void;
  let rejectDone!: (error: ScriptExecutionError) => void;
  const done = new Promise<JsonValue>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  done.catch(() => undefined);

  let worker: WorkerChannel | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => fail("cancelled");

  const stop = () => {
    controller.abort();
    worker?.kill();
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
    watchdog = setTimeout(() => fail("timeout"), Math.max(0, deadlineAt - performance.now()));
    try {
      worker = await open({ signal: controller.signal });
    } catch {
      fail("worker_failed"); // no transport: fail closed (a no-op when a timeout or cancel already won)
      return await done;
    }
    if (settled) return await done; // ended while opening; the finally block releases the channel

    const activeWorker = worker;
    const write = async (message: ParentMessage): Promise<void> => {
      if (settled) return;
      try {
        await activeWorker.write(encodeFrame(message));
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
        for await (const chunk of activeWorker.output) {
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
      worker.end();
      await worker.closed.catch(() => undefined);
    }
  }
}
