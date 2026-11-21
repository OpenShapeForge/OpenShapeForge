// SPDX-License-Identifier: BUSL-1.1
/**
 * Internal entry point for running bounded untrusted JavaScript. Trusted API
 * code calls `runScript`; the isolation backend (QuickJS/WebAssembly in a
 * dedicated subprocess) stays private to this directory. Nothing here is wired
 * to authoring, storage or any route yet.
 */
export { runScript, ScriptExecutionError } from "./run-script.ts";
export type { RunScriptRequest, ScriptRead, ScriptReadContext } from "./run-script.ts";
export { DEFAULT_LIMITS, LIMIT_CEILINGS, SCRIPT_ERROR_CODES } from "./protocol.ts";
export type { JsonValue, ScriptErrorCode, ScriptLimits } from "./protocol.ts";

/**
 * What this backend does and does not isolate. Callers deciding whether to
 * expose customer-authored scripts must read `osSandbox`.
 */
export const SCRIPT_SANDBOX_ISOLATION = Object.freeze({
  /** Guest code runs in a QuickJS WebAssembly heap with no host bindings besides the read broker. */
  engine: true,
  /** The engine runs in a separate OS process with empty env, empty cwd and pipe-only IPC. */
  process: true,
  /**
   * NOT provided: the worker shares the API's uid, filesystem view and network
   * namespace. Containing an engine escape needs a separate deployment boundary
   * (dedicated container/pod, read-only rootfs, no egress, seccomp, distinct uid).
   */
  osSandbox: false,
});
