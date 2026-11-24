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
 * A payload larger than one safe frame (a whole source page, or the data result
 * computed from it) crosses as an ordered sequence of bounded chunks closed by
 * an end frame that declares the total size. A receiver accumulates chunks
 * against explicit per-payload and per-run aggregate limits and hands on
 * nothing until the declared size matches what it holds, so an oversized or
 * interrupted transfer is refused whole rather than delivered in part.
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
  /** Cap on one read result, whether it crosses in one frame or as chunks. */
  maxReadResultBytes: number;
  maxResultBytes: number;
  maxReads: number;
  maxReadArgsBytes: number;
  /** Payload bytes of one chunk frame; bounds the largest frame either side builds. */
  maxChunkBytes: number;
  /** Aggregate cap on every read result plus the data result of one run. */
  maxTransferBytes: number;
}

export const DEFAULT_LIMITS: Readonly<ScriptLimits> = Object.freeze({
  deadlineMs: 2_000,
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 256 * 1024,
  maxSourceBytes: 64 * 1024,
  maxInputBytes: 128 * 1024,
  maxReadResultBytes: 128 * 1024,
  maxResultBytes: 128 * 1024,
  maxReads: 8,
  maxReadArgsBytes: 8 * 1024,
  maxChunkBytes: 64 * 1024,
  // The nine single-frame payloads a default run could already move: eight read
  // results and one data result. A default run keeps exactly its former budget.
  maxTransferBytes: 9 * 128 * 1024,
});

/** Ceilings no caller may raise; they also bound what the worker accepts. */
export const LIMIT_CEILINGS: Readonly<ScriptLimits> = Object.freeze({
  deadlineMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  maxSourceBytes: 256 * 1024,
  maxInputBytes: 512 * 1024,
  // A whole page and the data result computed from it may each exceed one frame;
  // they are then chunked. `maxTransferBytes` is what actually bounds a run.
  maxReadResultBytes: 2 * 1024 * 1024,
  maxResultBytes: 2 * 1024 * 1024,
  maxReads: 32,
  maxReadArgsBytes: 32 * 1024,
  maxChunkBytes: 128 * 1024,
  maxTransferBytes: 8 * 1024 * 1024,
});

/** Floors that keep a limit usable; a chunk must carry real progress. */
const LIMIT_FLOORS: Readonly<Partial<Record<keyof ScriptLimits, number>>> = Object.freeze({ maxChunkBytes: 1024 });

/** Hard cap on one frame in either direction (source + input + envelope fit well below). */
export const MAX_FRAME_BYTES = 1024 * 1024;
/**
 * Worst-case growth of a payload embedded as a JSON string: every byte escaped
 * as `\uXXXX`. `maxChunkBytes` is capped so that even then a chunk frame stays
 * inside `MAX_FRAME_BYTES`; `encodeFrame` remains the hard backstop.
 */
const MAX_FRAME_ESCAPE_GROWTH = 6;
if (LIMIT_CEILINGS.maxChunkBytes * MAX_FRAME_ESCAPE_GROWTH + 1024 > MAX_FRAME_BYTES) {
  throw new Error("Script sandbox chunk ceiling does not fit a safe frame");
}
export const MAX_JSON_DEPTH = 32;
export const ALIAS_PATTERN = /^[a-z][a-zA-Z0-9_.-]{0,63}$/;

export type ParentMessage =
  | { type: "run"; source: string; input: string; limits: ScriptLimits }
  | { type: "read.ok"; id: number; value: string }
  /** One bounded chunk of the result of read `id`; only `read.end` completes it. */
  | { type: "read.part"; id: number; value: string }
  | { type: "read.end"; id: number; bytes: number }
  | { type: "read.denied"; id: number; code: ReadDenialCode };

export type WorkerMessage =
  | { type: "read"; id: number; alias: string; args: string }
  | { type: "result"; value: string }
  /** One bounded chunk of the data result; only `result.end` completes it. */
  | { type: "result.part"; value: string }
  | { type: "result.end"; bytes: number }
  | { type: "failed"; code: ScriptErrorCode };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const payloadDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function encodeFrame(message: ParentMessage | WorkerMessage): Uint8Array {
  const payload = encoder.encode(JSON.stringify(message));
  if (payload.byteLength > MAX_FRAME_BYTES) throw new ProtocolError("frame too large");
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

/**
 * Incremental frame reader; throws as soon as a header or payload is not
 * acceptable. Arriving chunks are held as they are and joined only once a whole
 * frame is present, so a payload split over many reads is copied once rather
 * than once per read.
 */
export class FrameDecoder {
  private chunks: Uint8Array[] = [];
  private pending = 0;

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength > 0) {
      this.chunks.push(chunk);
      this.pending += chunk.byteLength;
    }
    const frames: unknown[] = [];
    for (;;) {
      if (this.pending < 4) break;
      const length = this.readLength();
      if (length > MAX_FRAME_BYTES) throw new ProtocolError("frame too large");
      if (this.pending < 4 + length) break;
      const payload = this.take(4 + length).subarray(4);
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoder.decode(payload));
      } catch {
        throw new ProtocolError("frame is not JSON");
      }
      frames.push(parsed);
    }
    return frames;
  }

  /** Reads the big-endian header without consuming it, across chunk edges. */
  private readLength(): number {
    const head = this.chunks[0]!;
    if (head.byteLength >= 4) return new DataView(head.buffer, head.byteOffset, 4).getUint32(0, false);
    let length = 0;
    let read = 0;
    for (const chunk of this.chunks) {
      for (let index = 0; index < chunk.byteLength && read < 4; index++, read++) length = length * 256 + chunk[index]!;
      if (read === 4) break;
    }
    return length;
  }

  /** Removes exactly `count` buffered bytes and returns them as one view. */
  private take(count: number): Uint8Array {
    if (this.chunks[0]!.byteLength >= count) {
      const head = this.chunks[0]!;
      const taken = head.subarray(0, count);
      if (head.byteLength === count) this.chunks.shift();
      else this.chunks[0] = head.subarray(count);
      this.pending -= count;
      return taken;
    }
    const joined = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      const head = this.chunks[0]!;
      const take = Math.min(head.byteLength, count - offset);
      joined.set(head.subarray(0, take), offset);
      offset += take;
      if (take === head.byteLength) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.pending -= count;
    return joined;
  }
}

/**
 * Splits `text` into chunks of at most `maxBytes` UTF-8 bytes, never inside a
 * code point, so the chunk byte lengths add up to the whole text exactly.
 */
export function splitTextByBytes(text: string, maxBytes: number): string[] {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return [text];
  const parts: string[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    let end = Math.min(offset + maxBytes, bytes.byteLength);
    // Back off to a code-point boundary; forward instead if the budget is so
    // small that one code point fills it, which still terminates.
    while (end > offset && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end === offset) {
      end = offset + 1;
      while (end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end++;
    }
    parts.push(payloadDecoder.decode(bytes.subarray(offset, end)));
    offset = end;
  }
  return parts;
}

/**
 * Accumulates the chunks of one payload under an explicit cap. Nothing is
 * readable until `finish` is given the sender's declared size and it matches
 * what arrived, so an oversized, over-chunked or interrupted transfer yields no
 * partial payload to either side.
 */
export class ChunkedPayload {
  private parts: string[] = [];
  private bytes = 0;
  constructor(private readonly maxBytes: number, private readonly maxChunkBytes: number) {}

  /** Buffered bytes so far; a caller counts these against its run aggregate. */
  get size(): number {
    return this.bytes;
  }

  /** Adds one chunk. False means refuse this payload: the buffer is dropped. */
  add(value: string): boolean {
    const size = utf8Bytes(value);
    if (size === 0 || size > this.maxChunkBytes || this.bytes + size > this.maxBytes) {
      this.drop();
      return false;
    }
    this.parts.push(value);
    this.bytes += size;
    return true;
  }

  /** Returns the whole payload only when `declaredBytes` matches what arrived. */
  finish(declaredBytes: number): string | null {
    const text = this.bytes === declaredBytes && this.parts.length > 0 ? this.parts.join("") : null;
    this.drop();
    return text;
  }

  /** Releases the buffer; called on any refusal so no run keeps chunks alive. */
  drop(): void {
    this.parts = [];
    this.bytes = 0;
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
    const floor = LIMIT_FLOORS[key] ?? 1;
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < floor || entry > LIMIT_CEILINGS[key]) return null;
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
  if (raw.type === "read.part" && Number.isSafeInteger(raw.id) && typeof raw.value === "string") {
    return { type: "read.part", id: raw.id as number, value: raw.value };
  }
  if (raw.type === "read.end" && Number.isSafeInteger(raw.id) && isTransferSize(raw.bytes)) {
    return { type: "read.end", id: raw.id as number, bytes: raw.bytes as number };
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
  if (raw.type === "result.part" && typeof raw.value === "string") return { type: "result.part", value: raw.value };
  if (raw.type === "result.end" && isTransferSize(raw.bytes)) return { type: "result.end", bytes: raw.bytes as number };
  if (raw.type === "failed" && (SCRIPT_ERROR_CODES as readonly unknown[]).includes(raw.code)) {
    return { type: "failed", code: raw.code as ScriptErrorCode };
  }
  return null;
}

/** A declared transfer size is a positive integer no run could ever exceed. */
function isTransferSize(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= LIMIT_CEILINGS.maxTransferBytes;
}
