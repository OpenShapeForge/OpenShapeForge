// SPDX-License-Identifier: BUSL-1.1
/**
 * Fixed, trusted sandbox worker. Runs as its own subprocess (see run-script.ts)
 * and is the only place customer source is handed to an interpreter, and that
 * interpreter is QuickJS compiled to WebAssembly, never Bun/Node `eval`.
 *
 * It speaks only the framed protocol on stdin/stdout. Inside the isolate the
 * only host function is the narrow `host.read` broker call; there is no clock
 * (`Date` is not instantiated, `Math.random` is removed), no console, no
 * module loader, and no timers. The worker enforces QuickJS memory, stack and
 * deadline; the parent separately owns deadline, cancellation and the read
 * budget and kills this process regardless of what happens in here.
 *
 * Guest-controlled text never leaves: failures are reported as fixed codes.
 */
import { newQuickJSWASMModule, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSRuntime } from "quickjs-emscripten";
import {
  encodeFrame, FrameDecoder, parseParentMessage, ProtocolError, utf8Bytes,
  type ParentMessage, type ScriptErrorCode, type ScriptLimits, type WorkerMessage,
} from "./protocol.js";

/**
 * Evaluated inside the isolate before any customer code. It captures the
 * primordials it needs, installs the frozen `host.read`, and returns `main`.
 * Both native callbacks are closure-only, so guest code cannot reach them.
 */
const PRELUDE = `(function (nativeRead, nativeDone) {
  "use strict";
  const parse = JSON.parse, stringify = JSON.stringify;
  const P = Promise, presolve = P.resolve.bind(P), preject = P.reject.bind(P);
  const E = Error;
  // QuickJS needs the Eval intrinsic for host-side compilation. Remove the
  // guest's evaluation entry points before loading its source.
  delete globalThis.eval;
  delete globalThis.Function;
  for (const fn of [function () {}, async function () {}, function* () {}, async function* () {}]) {
    delete Object.getPrototypeOf(fn).constructor;
  }
  delete Math.random;
  function read(alias, args) {
    let text;
    try { text = stringify(args === undefined ? null : args); } catch (e) { return preject(new E("invalid_read")); }
    if (typeof alias !== "string" || typeof text !== "string") return preject(new E("invalid_read"));
    return nativeRead(alias, text).then(parse, function (code) { throw new E(String(code)); });
  }
  Object.defineProperty(globalThis, "host", { value: Object.freeze({ read: Object.freeze(read) }) });
  return function main(json, maxResult) {
    let settled = false;
    function finish(ok, value) { if (!settled) { settled = true; nativeDone(ok, value); } }
    try {
      const run = globalThis.run;
      if (typeof run !== "function") { finish(false, "script_error"); return; }
      presolve(run(parse(json))).then(function (value) {
        let text;
        try { text = stringify(value); } catch (e) { finish(false, "invalid_result"); return; }
        if (typeof text !== "string") finish(false, "invalid_result");
        else if (text.length > maxResult) finish(false, "result_too_large");
        else finish(true, text);
      }, function () { finish(false, "script_error"); });
    } catch (e) { finish(false, "script_error"); }
  };
})`;

let writeChain: Promise<void> = Promise.resolve();
function send(message: WorkerMessage): Promise<void> {
  const frame = encodeFrame(message);
  // Serialised with a completion callback so a slow parent applies backpressure.
  writeChain = writeChain.then(() => new Promise<void>((resolve, reject) => {
    process.stdout.write(frame, error => (error ? reject(error) : resolve()));
  }));
  return writeChain;
}

async function exitAfterFlush(code: number): Promise<never> {
  try { await writeChain; } catch { /* parent is gone; nothing more to report */ }
  process.exit(code);
}

async function fail(code: ScriptErrorCode): Promise<never> {
  try { await send({ type: "failed", code }); } catch { /* see exitAfterFlush */ }
  return exitAfterFlush(code === "worker_failed" ? 1 : 0);
}

interface Execution {
  runtime: QuickJSRuntime;
  vm: QuickJSContext;
  limits: ScriptLimits;
  pending: Map<number, QuickJSDeferredPromise>;
  nextId: number;
  outcome: { ok: boolean; value: string } | null;
}

let execution: Execution | null = null;
let pumpRef: (() => Promise<void>) | null = null;

function rejectedWith(vm: QuickJSContext, code: string): QuickJSHandle {
  const deferred = vm.newPromise();
  const reason = vm.newString(code);
  deferred.reject(reason);
  reason.dispose();
  return deferred.handle;
}

async function start(message: Extract<ParentMessage, { type: "run" }>): Promise<void> {
  const { limits } = message;
  const deadlineAt = performance.now() + limits.deadlineMs;
  const deadlineTimer = setTimeout(() => { void fail("timeout"); }, limits.deadlineMs);
  deadlineTimer.unref?.();

  const quickjs = await newQuickJSWASMModule();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  const state = { timedOut: false };
  runtime.setInterruptHandler(() => (state.timedOut = state.timedOut || performance.now() > deadlineAt));
  // Date, Proxy and BigInt are omitted; the prelude removes guest evaluation entry points.
  const vm = runtime.newContext({
    intrinsics: { BaseObjects: true, Eval: true, StringNormalize: true, RegExp: true, JSON: true, MapSet: true, TypedArrays: true, Promise: true },
  });
  const exec: Execution = { runtime, vm, limits, pending: new Map(), nextId: 0, outcome: null };
  execution = exec;

  const guestFailure = (): ScriptErrorCode => (state.timedOut ? "timeout" : "script_error");

  const nativeRead = vm.newFunction("read", (aliasHandle, argsHandle) => {
    const alias = vm.getString(aliasHandle);
    const args = vm.getString(argsHandle);
    if (utf8Bytes(args) > limits.maxReadArgsBytes || alias.length > 64) return rejectedWith(vm, "invalid_read");
    const id = ++exec.nextId;
    const deferred = vm.newPromise();
    exec.pending.set(id, deferred);
    void send({ type: "read", id, alias, args }).catch(() => process.exit(1));
    return deferred.handle;
  });
  const nativeDone = vm.newFunction("done", (okHandle, valueHandle) => {
    exec.outcome = { ok: vm.dump(okHandle) === true, value: vm.getString(valueHandle) };
  });

  const pump = async (): Promise<void> => {
    const jobs = runtime.executePendingJobs();
    if ("error" in jobs && jobs.error) {
      jobs.error.dispose();
      await fail(guestFailure());
    }
    const outcome = exec.outcome;
    if (!outcome) return;
    if (outcome.ok) await send({ type: "result", value: outcome.value });
    else await send({ type: "failed", code: outcome.value as ScriptErrorCode });
    await exitAfterFlush(0);
  };
  pumpRef = pump;

  const factory = vm.unwrapResult(vm.evalCode(PRELUDE, "prelude.js"));
  const main = vm.unwrapResult(vm.callFunction(factory, vm.undefined, nativeRead, nativeDone));

  const loaded = vm.evalCode(message.source, "script.js", { type: "global", strict: true });
  if ("error" in loaded && loaded.error) {
    loaded.error.dispose();
    await fail(guestFailure());
  }
  (loaded as { value: QuickJSHandle }).value.dispose();

  const inputHandle = vm.newString(message.input);
  const maxResult = vm.newNumber(limits.maxResultBytes);
  const called = vm.callFunction(main, vm.undefined, inputHandle, maxResult);
  if ("error" in called && called.error) {
    called.error.dispose();
    await fail(guestFailure());
  } else {
    (called as { value: QuickJSHandle }).value.dispose();
  }
  await pump();
}

async function onReply(message: Extract<ParentMessage, { type: "read.ok" | "read.denied" }>): Promise<void> {
  const exec = execution;
  const deferred = exec?.pending.get(message.id);
  if (!exec || !deferred) return fail("protocol_violation");
  exec.pending.delete(message.id);
  if (message.type === "read.ok" && utf8Bytes(message.value) <= exec.limits.maxReadResultBytes) {
    const value = exec.vm.newString(message.value);
    deferred.resolve(value);
    value.dispose();
  } else {
    const reason = exec.vm.newString(message.type === "read.denied" ? message.code : "read_failed");
    deferred.reject(reason);
    reason.dispose();
  }
  await pumpRef?.();
}

async function main(): Promise<void> {
  const decoder = new FrameDecoder();
  let started = false;
  for await (const chunk of process.stdin) {
    for (const raw of decoder.push(chunk)) {
      const message = parseParentMessage(raw);
      if (!message) return fail("protocol_violation");
      if (message.type === "run") {
        if (started) return fail("protocol_violation");
        started = true;
        await start(message);
      } else {
        if (!started) return fail("protocol_violation");
        await onReply(message);
      }
    }
  }
  // stdin closed before an outcome was delivered: the parent went away.
  process.exit(1);
}

main().catch(error => fail(error instanceof ProtocolError ? "protocol_violation" : "worker_failed"));
