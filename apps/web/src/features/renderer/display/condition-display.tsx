// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";

import type {
  CompilerConditionInput,
  CompilerConditionOperandInput,
} from "@/generated/compiler/canonical-condition";
import {
  conditionUsesUnaryOperator,
  formatConditionOperandForDisplay,
  getConditionGroupItems,
  getConditionGroupMode,
  getConditionOperatorLabel,
  isConditionGroup,
  isConditionRule,
  type AuthoredConditionRule,
} from "@/features/renderer/runtime/conditions";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import { TextDisplay } from "@/features/renderer/display/text-display";
import { cn } from "@/lib/utils";

type ConditionDisplayLang = "en" | "nl";

type ConditionDisplayProps = {
  value: unknown;
  lang?: string;
  className?: string;
  /**
   * Variable suggestions resolved for the entity whose fields this condition
   * references (typically produced by `getEntityFieldSuggestions`). When
   * provided, operand paths render with their real labels instead of the
   * prettified-path fallback — e.g. `entity.subtasks.count` becomes
   * "Task > Subtasks > Count" instead of "Count".
   */
  variableSuggestions?: VariableSuggestion[];
};

function resolveLang(lang: string | undefined): ConditionDisplayLang {
  return lang === "en" ? "en" : "nl";
}

function formatPathOperandWithSuggestions(
  operand: CompilerConditionOperandInput & { kind: "path" },
  lang: ConditionDisplayLang,
  suggestions: VariableSuggestion[] | undefined,
): string {
  const suggestion = suggestions?.find((candidate) => candidate.path === operand.path);
  if (!suggestion) {
    return formatConditionOperandForDisplay(operand, lang);
  }

  const base = suggestion.sourceNodeLabel
    ? `${suggestion.sourceNodeLabel} ${suggestion.displayLabel ?? suggestion.label}`
    : (suggestion.displayLabel ?? suggestion.label);

  // Offset suffix (e.g. "− 7 days ago") is produced by the shared formatter;
  // strip its leading path repetition by reusing it on a synthetic empty path.
  const offsetSuffix = operand.offset
    ? formatConditionOperandForDisplay(
        { kind: "path", path: "", offset: operand.offset },
        lang,
      )
    : "";
  return `${base}${offsetSuffix}`;
}

/**
 * Format a literal operand's value using the reference-data options attached
 * to `contextSuggestion` (typically the suggestion matching the rule's left
 * operand path). Falls back to the raw formatter when no matching option is
 * found, preserving the output for free-text literals and arrays.
 */
function formatLiteralOperandWithContext(
  operand: CompilerConditionOperandInput & { kind: "literal" },
  lang: ConditionDisplayLang,
  contextSuggestion: VariableSuggestion | undefined,
): string {
  const options = contextSuggestion?.options;
  if (!options?.length) {
    return formatConditionOperandForDisplay(operand, lang);
  }

  const value = operand.value;
  if (typeof value === "string") {
    const match = options.find((opt) => opt.value === value);
    if (match) return match.label;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry !== "string") return String(entry);
        const match = options.find((opt) => opt.value === entry);
        return match ? match.label : entry;
      })
      .join(", ");
  }
  return formatConditionOperandForDisplay(operand, lang);
}

function formatOperandWithSuggestions(
  operand: CompilerConditionOperandInput | undefined,
  lang: ConditionDisplayLang,
  suggestions: VariableSuggestion[] | undefined,
  contextSuggestion?: VariableSuggestion | undefined,
): string {
  if (!operand) return "";

  if (operand.kind === "path") {
    if (!suggestions?.length) {
      return formatConditionOperandForDisplay(operand, lang);
    }
    return formatPathOperandWithSuggestions(operand, lang, suggestions);
  }

  if (operand.kind === "literal") {
    return formatLiteralOperandWithContext(operand, lang, contextSuggestion);
  }

  return formatConditionOperandForDisplay(operand, lang);
}

function formatGroupModeLabel(
  mode: "all" | "any",
  lang: ConditionDisplayLang,
): string {
  if (mode === "any") {
    return lang === "nl" ? "Eén van:" : "Any of:";
  }
  return lang === "nl" ? "Alle van:" : "All of:";
}

function RuleLine({
  rule,
  lang,
  variableSuggestions,
}: {
  rule: AuthoredConditionRule;
  lang: ConditionDisplayLang;
  variableSuggestions?: VariableSuggestion[];
}) {
  // When the rule's left operand is a field path, its matching suggestion
  // provides the reference-data options used to localize a literal right
  // operand (e.g. "normal" → "Normaal"). Unrelated left shapes (functions,
  // literals) simply skip the lookup.
  const leftPath =
    rule.left?.kind === "path" ? rule.left.path : undefined;
  const leftContextSuggestion =
    leftPath && variableSuggestions?.length
      ? variableSuggestions.find((candidate) => candidate.path === leftPath)
      : undefined;

  const leftText = formatOperandWithSuggestions(rule.left, lang, variableSuggestions);
  const operatorText = getConditionOperatorLabel(rule.operator, lang);
  const unary = conditionUsesUnaryOperator(rule.operator);
  const rightText = unary
    ? ""
    : formatOperandWithSuggestions(rule.right, lang, variableSuggestions, leftContextSuggestion);

  return (
    <span className="text-sm leading-6 text-foreground">
      <span className="font-medium">{leftText}</span>{" "}
      <span className="text-muted-foreground">{operatorText}</span>
      {rightText ? (
        <>
          {" "}
          <span className="font-medium">{rightText}</span>
        </>
      ) : null}
    </span>
  );
}

function renderNode(
  node: CompilerConditionInput,
  lang: ConditionDisplayLang,
  depth: number,
  variableSuggestions: VariableSuggestion[] | undefined,
): ReactNode {
  if (isConditionGroup(node)) {
    const items = getConditionGroupItems(node);
    const groupMode = getConditionGroupMode(node);

    if (items.length === 0) {
      return (
        <TextDisplay className="italic text-muted-foreground">
          {lang === "nl" ? "Geen regels" : "No rules"}
        </TextDisplay>
      );
    }

    // A group of one is just that rule — skip the "All of:" framing.
    if (items.length === 1) {
      return renderNode(items[0]!, lang, depth, variableSuggestions);
    }

    return (
      <div
        className={cn(
          "space-y-1",
          depth > 0 && "border-l border-border/60 pl-3",
        )}
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {formatGroupModeLabel(groupMode, lang)}
        </p>
        <ul className="space-y-1 pl-4">
          {items.map((child, index) => (
            <li
              key={("id" in child && typeof child.id === "string" && child.id) || `${depth}-${index}`}
              className="list-disc marker:text-muted-foreground/70"
            >
              {renderNode(child, lang, depth + 1, variableSuggestions)}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (isConditionRule(node)) {
    return <RuleLine rule={node} lang={lang} variableSuggestions={variableSuggestions} />;
  }

  return (
    <TextDisplay className="italic text-muted-foreground">
      {lang === "nl" ? "Ongeldige conditie" : "Invalid condition"}
    </TextDisplay>
  );
}

/**
 * Read-only renderer for the `condition` semantic type. Produces a sentence
 * for a single rule and an indented bullet tree for grouped conditions.
 * Prefer this over `TextDisplay` whenever a canonical condition value is
 * shown in display mode.
 */
export function ConditionDisplay({
  value,
  lang,
  className,
  variableSuggestions,
}: ConditionDisplayProps) {
  const resolvedLang = resolveLang(lang);

  if (value == null || (typeof value === "string" && value.trim() === "")) {
    return (
      <TextDisplay className={cn("italic text-muted-foreground", className)}>
        {resolvedLang === "nl" ? "Geen conditie ingesteld" : "No condition set"}
      </TextDisplay>
    );
  }

  if (typeof value !== "object") {
    return (
      <TextDisplay className={cn("italic text-muted-foreground", className)}>
        {resolvedLang === "nl" ? "Ongeldige conditie" : "Invalid condition"}
      </TextDisplay>
    );
  }

  return (
    <div className={cn("space-y-1", className)}>
      {renderNode(value as CompilerConditionInput, resolvedLang, 0, variableSuggestions)}
    </div>
  );
}
