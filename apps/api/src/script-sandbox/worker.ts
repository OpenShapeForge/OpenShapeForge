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
 * A read result or data result larger than one safe frame crosses as bounded
 * chunks. The worker buffers an inbound payload under the per-read cap and a
 * run-wide aggregate, and resolves the guest's promise only once the declared
 * size matches what arrived: an oversized or interrupted page is refused whole,
 * so the guest never sees a page silently short of records.
 *
 * Guest-controlled text never leaves: failures are reported as fixed codes.
 */
import { newQuickJSWASMModule, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSRuntime } from "quickjs-emscripten";
import {
  ChunkedPayload, encodeFrame, FrameDecoder, parseParentMessage, ProtocolError, splitTextByBytes, utf8Bytes,
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
  /** Chunks buffered for a read still arriving; at most one per pending read. */
  transfers: Map<number, ChunkedPayload>;
  /** Bytes of every read result accepted so far, against `maxTransferBytes`. */
  received: number;
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
  const exec: Execution = {
    runtime, vm, limits, pending: new Map(), transfers: new Map(), received: 0, nextId: 0, outcome: null,
  };
  execution = exec;

  const guestFailure = (): ScriptErrorCode => (state.timedOut ? "timeout" : "script_error");

  const nativeRead = vm.newFunction("read", (aliasHandle, argsHandle) => {
    const alias = vm.getString(aliasHandle);
    const args = vm.getString(argsHandle);
    if (utf8Bytes(args) > limits.maxReadArgsBytes || alias.length > 64) return rejectedWith(vm, "invalid_read");
    // The parent fails the run past its read budget, but it only learns of a
    // read once the frame arrives. Bounding what is in flight here keeps a guest
    // that fires reads in a loop from growing this process's memory meanwhile.
    if (exec.pending.size >= limits.maxReads) return rejectedWith(vm, "invalid_read");
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
    if (!outcome.ok) {
      await send({ type: "failed", code: outcome.value as ScriptErrorCode });
      return exitAfterFlush(0);
    }
    // The isolate bounded the result in code units; this is the byte check the
    // wire budget is actually stated in. Over it, nothing is sent at all.
    const bytes = utf8Bytes(outcome.value);
    if (bytes > limits.maxResultBytes) return fail("result_too_large");
    if (bytes <= limits.maxChunkBytes) await send({ type: "result", value: outcome.value });
    else {
      for (const part of splitTextByBytes(outcome.value, limits.maxChunkBytes)) await send({ type: "result.part", value: part });
      await send({ type: "result.end", bytes });
    }
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

type ReplyMessage = Extract<ParentMessage, { type: "read.ok" | "read.part" | "read.end" | "read.denied" }>;

async function onReply(message: ReplyMessage): Promise<void> {
  const exec = execution;
  const deferred = exec?.pending.get(message.id);
  if (!exec || !deferred) return fail("protocol_violation");

  if (message.type === "read.part") {
    const bytes = utf8Bytes(message.value);
    // Still arriving: the guest's promise stays pending and sees no fragment.
    const transfer = exec.transfers.get(message.id) ?? new ChunkedPayload(exec.limits.maxReadResultBytes, exec.limits.maxChunkBytes);
    exec.transfers.set(message.id, transfer);
    // The parent bounds a payload whole before it sends any of it. A chunk past
    // the frame size, the per-read cap or the run aggregate therefore means the
    // stream itself is not trustworthy: the run ends rather than this process
    // buffering on, or the rest of the stream being read as another payload.
    if (bytes === 0 || bytes > exec.limits.maxChunkBytes
      || exec.received + bytes > exec.limits.maxTransferBytes || !transfer.add(message.value)) {
      transfer.drop();
      exec.transfers.delete(message.id);
      return fail("protocol_violation");
    }
    exec.received += bytes;
    return;
  }

  const transfer = exec.transfers.get(message.id);
  if (message.type === "read.end") {
    return settleRead(exec, message.id, deferred, transfer?.finish(message.bytes) ?? null);
  }
  // A single-frame reply or a denial ends any buffer this read had opened, so a
  // transfer the parent abandoned cannot be mixed with what follows.
  transfer?.drop();
  if (message.type === "read.denied") return settleRead(exec, message.id, deferred, null, message.code);
  const bytes = utf8Bytes(message.value);
  const accepted = bytes <= exec.limits.maxReadResultBytes && exec.received + bytes <= exec.limits.maxTransferBytes;
  if (accepted) exec.received += bytes;
  return settleRead(exec, message.id, deferred, accepted ? message.value : null);
}

/** Resolves or rejects one read, releasing its buffer whatever the outcome. */
async function settleRead(
  exec: Execution,
  id: number,
  deferred: QuickJSDeferredPromise,
  value: string | null,
  code = "read_failed",
): Promise<void> {
  exec.pending.delete(id);
  exec.transfers.get(id)?.drop();
  exec.transfers.delete(id);
  const handle = exec.vm.newString(value ?? code);
  if (value === null) deferred.reject(handle);
  else deferred.resolve(handle);
  handle.dispose();
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
