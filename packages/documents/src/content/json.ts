// SPDX-License-Identifier: BUSL-1.1
import { contentError } from "./errors.js";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export const CONTENT_LIMITS = Object.freeze({
  jsonDepth: 64,
  jsonValues: 200_000,
  stringCharacters: 5_000_000,
  blocks: 500,
  dependencies: 1_000,
  templateDepth: 32,
});

/** Canonical JSON preserves array order, sorts object keys, and rejects non-JSON values. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  let values = 0;
  let characters = 0;
  function text(value: string) {
    characters += value.length;
    if (characters > CONTENT_LIMITS.stringCharacters) {
      contentError("CONTENT_LIMIT_EXCEEDED", "Content exceeds the text budget.");
    }
    return JSON.stringify(value);
  }
  function serialize(value: unknown, depth: number): string {
    if (++values > CONTENT_LIMITS.jsonValues || depth > CONTENT_LIMITS.jsonDepth) {
      contentError("CONTENT_LIMIT_EXCEEDED", "Content exceeds the JSON size or depth budget.");
    }
    if (value === null) return "null";
    if (typeof value === "string") return text(value);
    if (typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value !== "object") contentError("INVALID_VALUE", "Content requires JSON values.");
    if (ancestors.has(value)) contentError("INVALID_VALUE", "Content rejects cyclic JSON values.");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let index = 0; index < value.length; index++)
          items.push(serialize(value[index], depth + 1));
        return `[${items.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        contentError("INVALID_VALUE", "Content accepts only plain JSON objects.");
      }
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${text(key)}:${serialize(record[key], depth + 1)}`)
        .join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  return serialize(value, 0);
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function immutableContent<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

export async function hashCanonicalJson(
  value: unknown,
  domain = "osf-template-content-v1",
): Promise<string> {
  const bytes = new TextEncoder().encode(`${domain}\n${canonicalJson(value)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
