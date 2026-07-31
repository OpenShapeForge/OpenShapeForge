// SPDX-License-Identifier: BUSL-1.1
import type {
  CompilerConditionOperandInput,
  CompilerConditionOperator,
} from "@/generated/compiler/canonical-condition";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";

/**
 * Human-readable labels for every condition operator, in both supported
 * languages. Shared between the builder UI (edit) and the display renderer so
 * that the two stay in lockstep when the operator set changes.
 */
export const CONDITION_OPERATOR_LABELS: Record<
  CompilerConditionOperator,
  { en: string; nl: string }
> = {
  equals: { en: "is", nl: "is" },
  notEquals: { en: "is not", nl: "is niet" },
  greaterThan: { en: "is greater than", nl: "is groter dan" },
  greaterThanOrEquals: {
    en: "is greater than or equal to",
    nl: "is groter dan of gelijk aan",
  },
  lessThan: { en: "is less than", nl: "is kleiner dan" },
  lessThanOrEquals: {
    en: "is less than or equal to",
    nl: "is kleiner dan of gelijk aan",
  },
  isEmpty: { en: "is empty", nl: "is leeg" },
  isNotEmpty: { en: "is not empty", nl: "is niet leeg" },
  contains: { en: "contains", nl: "bevat" },
  notContains: { en: "does not contain", nl: "bevat niet" },
  startsWith: { en: "starts with", nl: "begint met" },
  endsWith: { en: "ends with", nl: "eindigt op" },
  in: { en: "is one of", nl: "is één van" },
  notIn: { en: "is not one of", nl: "is geen van" },
};

export function getConditionOperatorLabel(
  operator: CompilerConditionOperator,
  lang: "en" | "nl",
): string {
  return CONDITION_OPERATOR_LABELS[operator]?.[lang] ?? operator;
}

/**
 * Turn a dot-separated variable path into a human-readable label.
 *
 * Uses the final segment only (path context is dropped — e.g.
 * `actor.person.firstName` becomes "First name", not "Actor — Person — First
 * name"). This keeps the display code fully static without loading variable
 * suggestions; if richer labels are needed later we can swap this helper for
 * one that reads the entity schema without changing any call sites.
 */
export function prettifyConditionPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";

  const lastSegment = trimmed.split(".").filter(Boolean).pop() ?? trimmed;
  const withSpaces = lastSegment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}

function formatOffset(
  offset: { days: number } | undefined,
  lang: "en" | "nl",
): string {
  if (!offset || offset.days === 0) return "";
  const abs = Math.abs(offset.days);
  const direction =
    offset.days < 0
      ? lang === "nl"
        ? "dagen geleden"
        : "days ago"
      : lang === "nl"
        ? "dagen vanaf nu"
        : "days from now";
  return ` ${offset.days < 0 ? "−" : "+"} ${abs} ${direction}`;
}

/**
 * Format a condition operand (path / literal / function) for read-only
 * display. Returns a plain string — the display component wraps the result
 * with the appropriate markup.
 */
export function formatConditionOperandForDisplay(
  operand: CompilerConditionOperandInput | undefined,
  lang: "en" | "nl",
): string {
  if (!operand) return "";

  if (operand.kind === "path") {
    const label = prettifyConditionPath(operand.path);
    return `${label}${formatOffset(operand.offset, lang)}`;
  }

  if (operand.kind === "function") {
    const base = operand.name === "today"
      ? lang === "nl"
        ? "vandaag"
        : "today"
      : operand.name;
    return `${base}${formatOffset(operand.offset, lang)}`;
  }

  const value = operand.value;
  if (value === null || value === undefined || value === "") {
    return lang === "nl" ? "(leeg)" : "(empty)";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(", ");
  }
  if (typeof value === "boolean") {
    return value
      ? lang === "nl"
        ? "Ja"
        : "Yes"
      : lang === "nl"
        ? "Nee"
        : "No";
  }
  return String(value);
}

export function formatConditionBoundOperandValue(
  path: string,
  suggestions: VariableSuggestion[],
) {
  const suggestion = suggestions.find((candidate) => candidate.path === path);
  if (!suggestion) {
    return path;
  }

  return `${suggestion.sourceNodeLabel} - ${suggestion.label}`;
}
