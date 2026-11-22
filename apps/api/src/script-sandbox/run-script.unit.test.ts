// SPDX-License-Identifier: BUSL-1.1
// Runs the real worker subprocess (QuickJS/WebAssembly) over live stdin/stdout IPC.
// Inputs are inert: the tests check that defensive limits fire, not how to defeat them.
import { describe, expect, test } from "bun:test";
import { ChunkedPayload, encodeFrame, FrameDecoder, MAX_FRAME_BYTES, ProtocolError, splitTextByBytes } from "./protocol.js";
import { runScript, ScriptExecutionError, SCRIPT_SANDBOX_ISOLATION, type JsonValue } from "./index.js";

async function codeOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ScriptExecutionError);
    return { code: (error as ScriptExecutionError).code, message: (error as Error).message };
  }
  throw new Error("expected the run to fail");
}

const run = (source: string, extra: Partial<Parameters<typeof runScript>[0]> = {}) =>
  runScript({ source, input: null, ...extra });

describe("script sandbox", () => {
  test("returns deterministic JSON for JSON input", async () => {
    const source = "function run(input) { return { sum: input.values.reduce((a, b) => a + b, 0), tag: input.tag }; }";
    const input = { values: [1, 2, 3.5], tag: "x" };
    const first = await run(source, { input });
    expect(first).toEqual({ sum: 6.5, tag: "x" });
    expect(await run(source, { input })).toEqual(first);
  });

  test("awaits a named read brokered over the live channel", async () => {
    const calls: JsonValue[] = [];
    const result = await run(
      `async function run(input) {
        const a = await host.read("exact.balance", { id: input.id });
        const b = await host.read("exact.balance", { id: input.id + 1 });
        return a.amount + b.amount;
      }`,
      {
        input: { id: 1 },
        reads: { "exact.balance": args => { calls.push(args); return { amount: (args as { id: number }).id * 10 }; } },
      },
    );
    expect(result).toBe(30);
    expect(calls).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("denies unknown aliases without reaching the broker and hides broker failure text", async () => {
    let called = 0;
    const result = await run(
      `async function run() {
        const out = {};
        for (const alias of ["missing", "constructor", "Bad Alias", "boom"]) {
          try { await host.read(alias, null); out[alias] = "allowed"; } catch (e) { out[alias] = e.message; }
        }
        return out;
      }`,
      { reads: { boom: () => { called++; throw new Error("SECRET-broker-detail"); } } },
    );
    expect(result).toEqual({
      missing: "unknown_alias", constructor: "unknown_alias", "Bad Alias": "unknown_alias", boom: "read_failed",
    });
    expect(called).toBe(1);
  });

  test("offers no ambient clock, randomness, console, network, filesystem, process or modules", async () => {
    const result = await run(`function run() {
      const names = ["Date", "console", "fetch", "process", "require", "Bun", "setTimeout", "setInterval", "performance",
        "std", "os", "XMLHttpRequest", "WebSocket", "eval", "Proxy"];
      const seen = {};
      for (const name of names) seen[name] = typeof globalThis[name];
      let dynamicImport = "unavailable";
      try { new Function("return 1"); dynamicImport = "function-constructor-allowed"; } catch (e) { /* expected */ }
      return { seen, random: typeof Math.random, readFrozen: Object.isFrozen(host) && Object.isFrozen(host.read), dynamicImport };
    }`);
    const { seen, random, readFrozen, dynamicImport } = result as { seen: Record<string, string>; random: string; readFrozen: boolean; dynamicImport: string };
    for (const [name, type] of Object.entries(seen)) expect([name, type]).toEqual([name, "undefined"]);
    expect(random).toBe("undefined");
    expect(readFrozen).toBe(true);
    expect(dynamicImport).toBe("unavailable");
  });

  test("never leaks guest-controlled error text", async () => {
    const failure = await codeOf(run('function run() { throw new Error("GUEST-SECRET"); }'));
    expect(failure.code).toBe("script_error");
    expect(failure.message).not.toContain("GUEST-SECRET");
    expect((await codeOf(run('syntax error here GUEST-SECRET'))).code).toBe("script_error");
    expect((await codeOf(run("var nothing = 1;"))).code).toBe("script_error");
  });

  test("rejects invalid and oversized results", async () => {
    expect((await codeOf(run("function run() { return undefined; }"))).code).toBe("invalid_result");
    expect((await codeOf(run("function run() { return () => 1; }"))).code).toBe("invalid_result");
    expect((await codeOf(run("function run() { const a = {}; a.a = a; return a; }"))).code).toBe("invalid_result");
    expect((await codeOf(run('function run() { return "x".repeat(2000); }', { limits: { maxResultBytes: 1000 } }))).code).toBe("result_too_large");
  });

  test("rejects oversized or non-JSON requests before spawning", async () => {
    expect((await codeOf(run("function run() { return 1; }", { input: "x".repeat(2000), limits: { maxInputBytes: 1000 } }))).code).toBe("invalid_input");
    expect((await codeOf(run("function run() { return 1; }", { input: { n: 1n } as unknown as JsonValue }))).code).toBe("invalid_input");
    expect((await codeOf(run("x".repeat(2000), { limits: { maxSourceBytes: 1000 } }))).code).toBe("invalid_request");
    expect((await codeOf(run("function run() { return 1; }", { limits: { memoryBytes: 2 ** 40 } }))).code).toBe("invalid_request");
    expect((await codeOf(run("function run() { return 1; }", { reads: { "Not Valid": () => null } }))).code).toBe("invalid_request");
  });

  test("bounds read arguments and read results", async () => {
    const result = await run(
      `async function run() {
        const out = [];
        try { await host.read("big", "x".repeat(5000)); } catch (e) { out.push(e.message); }
        try { await host.read("huge", null); } catch (e) { out.push(e.message); }
        return out;
      }`,
      { limits: { maxReadArgsBytes: 1000, maxReadResultBytes: 1000 }, reads: { big: () => 1, huge: () => "y".repeat(5000) } },
    );
    expect(result).toEqual(["invalid_read", "read_failed"]);
  });

  test("enforces the read budget in the parent", async () => {
    let called = 0;
    const failure = await codeOf(run(
      "async function run() { for (let i = 0; i < 10; i++) await host.read('r', i); return 1; }",
      { limits: { maxReads: 3 }, reads: { r: () => { called++; return 0; } } },
    ));
    expect(failure.code).toBe("read_budget_exceeded");
    expect(called).toBeLessThanOrEqual(3);
  });

  test("stops runaway CPU, memory and stack, and a clean run follows", async () => {
    expect((await codeOf(run("function run() { for (;;) {} }", { limits: { deadlineMs: 300 } }))).code).toBe("timeout");
    const exhausted = await codeOf(run(
      "function run() { const keep = []; for (;;) keep.push(new Array(10000).fill(1)); }",
      { limits: { memoryBytes: 4 * 1024 * 1024, deadlineMs: 5000 } },
    ));
    // A worker stopped by the runtime memory boundary may exit before framing an error.
    expect(["script_error", "worker_failed"]).toContain(exhausted.code);
    expect((await codeOf(run("function run() { function f() { return f() + 1; } return f(); }"))).code).toBe("script_error");
    expect(await run("function run() { return 'clean'; }")).toBe("clean");
  });

  test("times out a run stuck waiting on a read", async () => {
    const failure = await codeOf(run(
      "async function run() { return await host.read('slow', null); }",
      { limits: { deadlineMs: 300 }, reads: { slow: () => new Promise<JsonValue>(() => undefined) } },
    ));
    expect(failure.code).toBe("timeout");
  });

  test("cancels mid-read, aborts the broker signal, and a later run is clean", async () => {
    const controller = new AbortController();
    let brokerSignal: AbortSignal | undefined;
    let release!: (value: JsonValue) => void;
    const pending = run(
      "async function run() { return await host.read('slow', null); }",
      {
        signal: controller.signal,
        reads: { slow: (_args, { signal }) => { brokerSignal = signal; controller.abort(); return new Promise<JsonValue>(resolve => { release = resolve; }); } },
      },
    );
    expect((await codeOf(pending)).code).toBe("cancelled");
    expect(brokerSignal?.aborted).toBe(true);
    release(1); // a late broker result must go nowhere
    expect(await run("function run() { return 2; }")).toBe(2);
    expect((await codeOf(run("function run() { return 1; }", { signal: AbortSignal.abort() }))).code).toBe("cancelled");
  });

  test("does not call the broker for reads queued behind a finished run", async () => {
    const controller = new AbortController();
    let calls = 0;
    const failure = await codeOf(run(
      "async function run() { return await Promise.all([host.read('r', 1), host.read('r', 2), host.read('r', 3)]); }",
      { signal: controller.signal, reads: { r: () => { calls++; controller.abort(); return new Promise<JsonValue>(() => undefined); } } },
    ));
    expect(failure.code).toBe("cancelled");
    expect(calls).toBe(1);
  });
});

describe("chunked transfers", () => {
  const rows = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`, label: "a reasonably descriptive journal line", amount: index + 0.5,
  }));

  test("carries a read result and a data result larger than one chunk", async () => {
    const page = { rows: rows(2_000) };
    const bytes = Buffer.byteLength(JSON.stringify(page), "utf8");
    expect(bytes).toBeGreaterThan(8 * 1024);
    const result = await run(
      "async function run() { const p = await host.read('page', null); return { seen: p.rows.length, echo: p.rows }; }",
      {
        limits: {
          deadlineMs: 20_000, maxChunkBytes: 4 * 1024,
          maxReadResultBytes: bytes, maxResultBytes: 2 * bytes, maxTransferBytes: 4 * bytes,
        },
        reads: { page: () => page },
      },
    );
    // Both directions needed many chunks; every record survives the round trip.
    expect(result).toEqual({ seen: 2_000, echo: page.rows });
  }, 30_000);

  test("refuses a read over the run aggregate without serving part of it", async () => {
    const page = { rows: rows(400) };
    const bytes = Buffer.byteLength(JSON.stringify(page), "utf8");
    const result = await run(
      `async function run() {
        const out = [];
        for (const n of [1, 2]) {
          try { out.push((await host.read('page', null)).rows.length); } catch (e) { out.push(e.message); }
        }
        return out;
      }`,
      {
        // Room for one page and the small result, not for two pages.
        limits: {
          deadlineMs: 20_000, maxChunkBytes: 4 * 1024,
          maxReadResultBytes: bytes, maxResultBytes: 1024, maxTransferBytes: bytes + 1024,
        },
        reads: { page: () => page },
      },
    );
    expect(result).toEqual([400, "read_failed"]);
  }, 30_000);

  test("refuses a data result over the run aggregate", async () => {
    const failure = await codeOf(run(
      "function run() { return { rows: new Array(4000).fill('a reasonably long filler value') }; }",
      { limits: { deadlineMs: 20_000, maxChunkBytes: 4 * 1024, maxResultBytes: 512 * 1024, maxTransferBytes: 16 * 1024 } },
    ));
    expect(failure.code).toBe("result_too_large");
  }, 30_000);

  test("splits text on code-point boundaries and reassembles it exactly", () => {
    const text = `${"€".repeat(1_000)}${"a".repeat(1_000)}`;
    const parts = splitTextByBytes(text, 1024);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(1024);
    expect(parts.join("")).toBe(text);
    // Byte lengths add up, which is what the receiver verifies the total against.
    expect(parts.reduce((total, part) => total + Buffer.byteLength(part, "utf8"), 0))
      .toBe(Buffer.byteLength(text, "utf8"));
  });

  test("hands on nothing when a transfer is oversized, over-chunked or short", () => {
    const oversizedChunk = new ChunkedPayload(1024, 8);
    expect(oversizedChunk.add("123456789")).toBe(false);
    expect(oversizedChunk.size).toBe(0);

    const overCap = new ChunkedPayload(8, 8);
    expect(overCap.add("12345678")).toBe(true);
    expect(overCap.add("1")).toBe(false);
    // The refused payload is released whole: no prefix remains readable.
    expect(overCap.size).toBe(0);
    expect(overCap.finish(8)).toBeNull();

    const interrupted = new ChunkedPayload(1024, 8);
    expect(interrupted.add("12345678")).toBe(true);
    // A declared total the chunks do not add up to yields nothing, not a prefix.
    expect(interrupted.finish(16)).toBeNull();

    const whole = new ChunkedPayload(1024, 8);
    whole.add("1234");
    whole.add("5678");
    expect(whole.finish(8)).toBe("12345678");
  });
});

describe("framing", () => {
  test("round-trips frames split across chunks", () => {
    const frame = encodeFrame({ type: "result", value: "1" });
    const decoder = new FrameDecoder();
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3))).toEqual([{ type: "result", value: "1" }]);
  });

  test("reads frames whose header and payload arrive one byte at a time", () => {
    const frames = [encodeFrame({ type: "result.part", value: "ab" }), encodeFrame({ type: "result.end", bytes: 2 })];
    const decoder = new FrameDecoder();
    const seen: unknown[] = [];
    for (const frame of frames) for (const byte of frame) seen.push(...decoder.push(new Uint8Array([byte])));
    expect(seen).toEqual([{ type: "result.part", value: "ab" }, { type: "result.end", bytes: 2 }]);
  });

  test("rejects an oversized length header before buffering the payload", () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false);
    expect(() => new FrameDecoder().push(header)).toThrow(ProtocolError);
  });

  test("rejects non-JSON payloads", () => {
    const frame = new Uint8Array([0, 0, 0, 1, 0x7b]);
    expect(() => new FrameDecoder().push(frame)).toThrow(ProtocolError);
  });
});

test("declares that OS-level isolation is not provided", () => {
  expect(SCRIPT_SANDBOX_ISOLATION).toEqual({ engine: true, process: true, osSandbox: false });
});
