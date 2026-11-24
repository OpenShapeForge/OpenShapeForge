// SPDX-License-Identifier: BUSL-1.1
/**
 * Caller-side proof against a running sandbox container, driven by
 * deploy/script-sandbox/verify.sh: `bun container-proof.ts <socket path>`.
 * Exits non-zero on the first failed expectation.
 */
import { join, dirname } from "node:path";
import { ScriptExecutionError, type JsonValue } from "./index.js";
import { createSandboxRunner } from "./socket-channel.js";

const socketPath = process.argv[2];
if (!socketPath) throw new Error("usage: bun container-proof.ts <socket path>");

function expect(condition: boolean, what: string): void {
  if (!condition) { console.error(`FAIL: ${what}`); process.exit(1); }
  console.log(`ok: ${what}`);
}
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return error instanceof ScriptExecutionError ? error.code : "other"; }
  return "no-error";
}

const run = createSandboxRunner(socketPath);

const source = "async function run(i) { const r = await host.read('exact.balance', { id: i.id }); return { sum: [1, 2, 3].reduce((a, b) => a + b, 0), amount: r.amount }; }";
const reads = { "exact.balance": (args: JsonValue) => ({ amount: (args as { id: number }).id * 10 }) };
expect(JSON.stringify(await run({ source, input: { id: 4 }, reads })) === JSON.stringify({ sum: 6, amount: 40 }), "deterministic value and brokered read through the socket");

const journal = Array.from({ length: 1_000 }, (_, index) => ({
  id: index + 1,
  description: "Synthetic journal reconciliation rule – café – " + "x".repeat(150),
}));
const journalBytes = Buffer.byteLength(JSON.stringify(journal));
expect(journalBytes > 128 * 1024, "journal fixture exceeds the single-payload budget");
const fullPage = await run({
  source: "async function run() { return await host.read('provider.page', null); }",
  input: null,
  reads: { "provider.page": () => journal },
  // The budgets of a brokered page run; the deadline covers a cold worker in
  // the container plus the chunked transfer in both directions.
  limits: { deadlineMs: 12_000, memoryBytes: 32 * 1024 * 1024, maxReadResultBytes: 1024 * 1024,
    maxResultBytes: 1024 * 1024, maxTransferBytes: 3 * 1024 * 1024 },
});
expect(JSON.stringify(fullPage) === JSON.stringify(journal), "whole journal page is transferred through the isolated container");

const controller = new AbortController();
const cancelled = run({
  source: "async function run() { return await host.read('slow', null); }", input: null, signal: controller.signal,
  reads: { slow: () => { controller.abort(); return new Promise<JsonValue>(() => undefined); } },
});
expect(await codeOf(cancelled) === "cancelled", "cancellation mid-read");
expect(await run({ source: "function run() { return 2; }", input: null }) === 2, "a later run is clean");

const missing = createSandboxRunner(join(dirname(socketPath), "absent.sock"));
expect(await codeOf(missing({ source: "function run() { return 1; }", input: null })) === "worker_failed", "missing socket fails closed");
console.log("PROOF OK");
