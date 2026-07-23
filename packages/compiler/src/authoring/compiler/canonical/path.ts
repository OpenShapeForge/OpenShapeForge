// @ts-nocheck
/**
 * Canonical path parsing and construction — transforms raw path strings
 * (e.g. "business.name") into structured CanonicalPath objects with
 * typed root, segments, and normalized string representation.
 */
import type {
  CanonicalPath,
  CanonicalPathRoot,
  CanonicalPathSegment,
} from "./types.js";

export const CANONICAL_ROOTS = new Set<CanonicalPathRoot>(["input", "nodes", "business", "taskResult"]);

export function parseCanonicalPath(rawPath: string): CanonicalPath {
  const value = rawPath.trim();
  if (!value) {
    throw new Error("Canonical path cannot be empty");
  }

  const rootMatch = value.match(/^[A-Za-z][A-Za-z0-9]*/);
  const rootToken = rootMatch?.[0] as CanonicalPathRoot | undefined;
  if (!rootToken || !CANONICAL_ROOTS.has(rootToken)) {
    throw new Error(`Canonical path '${rawPath}' must start with a supported root`);
  }

  const remainder = value.slice(rootToken.length);
  const segments = parseCanonicalPathSegments(remainder, rawPath);
  return createCanonicalPath(rootToken, segments);
}

export function createCanonicalPath(
  root: CanonicalPathRoot,
  segments: CanonicalPathSegment[],
): CanonicalPath {
  if (!CANONICAL_ROOTS.has(root)) {
    throw new Error(`Unsupported canonical path root '${root}'`);
  }

  const normalized = segments.reduce<string>((path, segment) => (
    segment.kind === "property"
      ? `${path}.${segment.key}`
      : `${path}[]`
  ), root);

  return {
    root,
    segments: segments.map((segment) => ({ ...segment })),
    normalized,
  };
}

function parseCanonicalPathSegments(
  remainder: string,
  rawPath: string,
): CanonicalPathSegment[] {
  if (!remainder) return [];

  const segments: CanonicalPathSegment[] = [];
  let cursor = 0;

  while (cursor < remainder.length) {
    const char = remainder[cursor];

    if (char === ".") {
      const next = readPropertySegment(remainder, cursor + 1);
      if (!next) {
        throw new Error(`Canonical path '${rawPath}' contains an empty property segment`);
      }
      segments.push({ kind: "property", key: next.segment });
      cursor = next.nextCursor;
      continue;
    }

    if (remainder.startsWith("[]", cursor)) {
      segments.push({ kind: "arrayItem" });
      cursor += 2;
      continue;
    }

    throw new Error(`Canonical path '${rawPath}' has invalid syntax near '${remainder.slice(cursor)}'`);
  }

  return segments;
}

function readPropertySegment(
  value: string,
  cursor: number,
): { segment: string; nextCursor: number } | null {
  let index = cursor;
  while (index < value.length && value[index] !== "." && !value.startsWith("[]", index)) {
    index += 1;
  }

  const segment = value.slice(cursor, index).trim();
  if (!segment) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment)) {
    throw new Error(`Canonical path segment '${segment}' is invalid`);
  }

  return { segment, nextCursor: index };
}
