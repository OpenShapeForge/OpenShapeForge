// SPDX-License-Identifier: BUSL-1.1
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import { findSuggestion } from "./suggestions";
import type { TokenSegment } from "./types";

function extractVariableTokenPath(raw: string): string | null {
  const match = raw.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
  if (!match) {
    return null;
  }

  const path = match[1]?.trim();
  return path && isSafeVariablePath(path) ? path : null;
}

function isSafeVariablePath(path: string) {
  return path.trim().length > 0 && !/[\s{}]/.test(path);
}

function formatTokenDisplay(
  path: string,
  suggestion: VariableSuggestion | null,
) {
  return suggestion?.label ?? path;
}

function formatTokenTitle(
  path: string,
  suggestion: VariableSuggestion | null,
) {
  if (!suggestion) {
    return path;
  }

  return `Node: ${suggestion.sourceNodeLabel} • ${suggestion.displayPath}`;
}

export function parseSegments(
  value: string,
  suggestions: VariableSuggestion[] = [],
): TokenSegment[] {
  if (value.length === 0) {
    return [{ kind: "text", text: "" }];
  }

  const segments: TokenSegment[] = [];
  const tokenPattern = /\{\{[^}]+\}\}/g;
  let lastIndex = 0;
  let offset = 0;

  for (const match of value.matchAll(tokenPattern)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      const text = value.slice(lastIndex, start);
      segments.push({ kind: "text", text });
      offset += text.length;
    }

    const raw = match[0];
    const path = extractVariableTokenPath(raw);
    if (!path) {
      segments.push({ kind: "text", text: raw });
      offset += raw.length;
      lastIndex = start + raw.length;
      continue;
    }

    const suggestion = findSuggestion(suggestions, path);
    segments.push({
      kind: "token",
      raw,
      path,
      display: formatTokenDisplay(path, suggestion),
      title: formatTokenTitle(path, suggestion),
      suggestion,
      start: offset,
      end: offset + raw.length,
    });
    offset += raw.length;
    lastIndex = start + raw.length;
  }

  if (lastIndex < value.length) {
    segments.push({ kind: "text", text: value.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ kind: "text", text: "" }];
}

export function tokenNeedsLeadingSpacer(
  segments: TokenSegment[],
  index: number,
) {
  const previousSegment = segments[index - 1];
  if (!previousSegment) {
    return false;
  }

  if (previousSegment.kind === "text") {
    return previousSegment.text.length > 0 && !/\s$/.test(previousSegment.text);
  }

  return true;
}

export function tokenNeedsTrailingSpacer(
  segments: TokenSegment[],
  index: number,
) {
  const nextSegment = segments[index + 1];
  if (!nextSegment) {
    return false;
  }

  if (nextSegment.kind === "text") {
    return nextSegment.text.length > 0 && !/^\s/.test(nextSegment.text);
  }

  return true;
}
