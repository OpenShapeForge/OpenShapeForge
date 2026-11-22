// SPDX-License-Identifier: BUSL-1.1
/**
 * Wire contract between the API process and the sandbox worker subprocess.
 *
 * Transport: the worker's stdin/stdout pipes. They are private to the parent
 * (the worker is spawned with no other inherited descriptors), so a message is
 * authenticated by the channel it arrives on; there is no token to leak.
 * Every message is a length-prefixed UTF-8 JSON frame. The length is checked
 * against a hard cap before any payload byte is buffered.
 *
 * This module is shared by the parent and the fixed worker, so it holds only
 * pure framing and validation: no process, filesystem or QuickJS access.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Fixed failure vocabulary. Guest-controlled text never becomes an error message. */
export const SCRIPT_ERROR_CODES = [
  "invalid_request",
  "invalid_input",
  "script_error",
  "timeout",
  "cancelled",
  "invalid_result",
  "result_too_large",
  "read_budget_exceeded",
  "worker_failed",
  "protocol_violation",
] as const;
export type ScriptErrorCode = (typeof SCRIPT_ERROR_CODES)[number];

/** Codes a broker reply may carry into the guest; the guest only sees the code. */
export const READ_DENIAL_CODES = ["unknown_alias", "read_failed", "invalid_read"] as const;
export type ReadDenialCode = (typeof READ_DENIAL_CODES)[number];

export interface ScriptLimits {
  /** Wall-clock budget for the whole run, including time spent waiting on reads. */
  deadlineMs: number;
  /** QuickJS heap limit. */
  memoryBytes: number;
  /** QuickJS stack limit. */
  stackBytes: number;
  maxSourceBytes: number;
  maxInputBytes: number;
  maxResultBytes: number;
  maxReads: number;
  maxReadArgsBytes: number;
  maxReadResultBytes: number;
}

export const DEFAULT_LIMITS: Readonly<ScriptLimits> = Object.freeze({
  deadlineMs: 2_000,
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 256 * 1024,
  maxSourceBytes: 64 * 1024,
  maxInputBytes: 128 * 1024,
  maxResultBytes: 128 * 1024,
  maxReads: 8,
  maxReadArgsBytes: 8 * 1024,
  maxReadResultBytes: 128 * 1024,
});

/** Ceilings no caller may raise; they also bound what the worker accepts. */
export const LIMIT_CEILINGS: Readonly<ScriptLimits> = Object.freeze({
  deadlineMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  maxSourceBytes: 256 * 1024,
  maxInputBytes: 512 * 1024,
  maxResultBytes: 512 * 1024,
  maxReads: 32,
  maxReadArgsBytes: 32 * 1024,
  maxReadResultBytes: 512 * 1024,
});

/** Hard cap on one frame in either direction (source + input + envelope fit well below). */
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_JSON_DEPTH = 32;
export const ALIAS_PATTERN = /^[a-z][a-zA-Z0-9_.-]{0,63}$/;

export type ParentMessage =
  | { type: "run"; source: string; input: string; limits: ScriptLimits }
  | { type: "read.ok"; id: number; value: string }
  | { type: "read.denied"; id: number; code: ReadDenialCode };

export type WorkerMessage =
  | { type: "read"; id: number; alias: string; args: string }
  | { type: "result"; value: string }
  | { type: "failed"; code: ScriptErrorCode };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeFrame(message: ParentMessage | WorkerMessage): Uint8Array {
  const payload = encoder.encode(JSON.stringify(message));
  if (payload.byteLength > MAX_FRAME_BYTES) throw new ProtocolError("frame too large");
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

/** Incremental frame reader; throws as soon as a header or payload is not acceptable. */
export class FrameDecoder {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): unknown[] {
    const joined = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    joined.set(this.buffer, 0);
    joined.set(chunk, this.buffer.byteLength);
    this.buffer = joined;
    const frames: unknown[] = [];
    for (;;) {
      if (this.buffer.byteLength < 4) break;
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(0, false);
      if (length > MAX_FRAME_BYTES) throw new ProtocolError("frame too large");
      if (this.buffer.byteLength < 4 + length) break;
      const payload = this.buffer.subarray(4, 4 + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoder.decode(payload));
      } catch {
        throw new ProtocolError("frame is not JSON");
      }
      frames.push(parsed);
      this.buffer = this.buffer.slice(4 + length);
    }
    return frames;
  }
}

export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Serialises `value` as JSON within `maxBytes` and `MAX_JSON_DEPTH`; returns null when not acceptable. */
export function serializeJson(value: unknown, maxBytes: number): string | null {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (text === undefined || utf8Bytes(text) > maxBytes) return null;
  // Round-trip through the parser so only genuine JSON can cross: this drops
  // toJSON hooks, and the depth walk bounds recursion for downstream consumers.
  return isBoundedJson(JSON.parse(text)) ? text : null;
}

/** Parses worker/broker JSON text with the same size and depth bounds. */
export function parseJson(text: string, maxBytes: number): { ok: true; value: JsonValue } | { ok: false } {
  if (typeof text !== "string" || utf8Bytes(text) > maxBytes) return { ok: false };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  return isBoundedJson(value) ? { ok: true, value: value as JsonValue } : { ok: false };
}

function isBoundedJson(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isBoundedJson(item, depth + 1));
  if (typeof value === "object") return Object.values(value).every(item => isBoundedJson(item, depth + 1));
  return false;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateLimits(value: unknown): ScriptLimits | null {
  if (!isPlainObject(value)) return null;
  const limits = {} as Record<string, number>;
  for (const key of Object.keys(LIMIT_CEILINGS) as (keyof ScriptLimits)[]) {
    const entry = value[key];
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 1 || entry > LIMIT_CEILINGS[key]) return null;
    limits[key] = entry;
  }
  return limits as unknown as ScriptLimits;
}

/** Validates a frame arriving at the worker. Returns null for anything unexpected. */
export function parseParentMessage(raw: unknown): ParentMessage | null {
  if (!isPlainObject(raw)) return null;
  if (raw.type === "run") {
    const limits = validateLimits(raw.limits);
    if (!limits || typeof raw.source !== "string" || typeof raw.input !== "string") return null;
    if (utf8Bytes(raw.source) > limits.maxSourceBytes || utf8Bytes(raw.input) > limits.maxInputBytes) return null;
    return { type: "run", source: raw.source, input: raw.input, limits };
  }
  if (raw.type === "read.ok" && Number.isSafeInteger(raw.id) && typeof raw.value === "string") {
    return { type: "read.ok", id: raw.id as number, value: raw.value };
  }
  if (raw.type === "read.denied" && Number.isSafeInteger(raw.id) && (READ_DENIAL_CODES as readonly unknown[]).includes(raw.code)) {
    return { type: "read.denied", id: raw.id as number, code: raw.code as ReadDenialCode };
  }
  return null;
}

/** Validates a frame arriving at the parent. Returns null for anything unexpected. */
export function parseWorkerMessage(raw: unknown): WorkerMessage | null {
  if (!isPlainObject(raw)) return null;
  if (raw.type === "read" && Number.isSafeInteger(raw.id) && typeof raw.alias === "string" && typeof raw.args === "string") {
    return { type: "read", id: raw.id as number, alias: raw.alias, args: raw.args };
  }
  if (raw.type === "result" && typeof raw.value === "string") return { type: "result", value: raw.value };
  if (raw.type === "failed" && (SCRIPT_ERROR_CODES as readonly unknown[]).includes(raw.code)) {
    return { type: "failed", code: raw.code as ScriptErrorCode };
  }
  return null;
}
