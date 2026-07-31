// SPDX-License-Identifier: BUSL-1.1
import { Button } from "@openshapeforge/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/features/renderer/edit/controls/basic/select";
import type { CompilerConditionInput } from "@/generated/compiler/canonical-condition";
import {
  createConditionGroup,
  createConditionRule,
  createPathOperand,
  getConditionGroupItems,
  getConditionGroupMode,
  isConditionGroup,
  isConditionRule,
  replaceConditionGroupItems,
  replaceConditionGroupMode,
  type ConditionBuilderMode,
} from "@/features/renderer/runtime/conditions";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import { ConditionRuleEditor } from "./condition-rule-editor";
import type { ConditionBuilderLang } from "./types";

type ConditionBuilderNodeProps = {
  value: CompilerConditionInput;
  onChange: (value: CompilerConditionInput) => void;
  mode: ConditionBuilderMode;
  lang: ConditionBuilderLang;
  variableSuggestions: VariableSuggestion[];
  variableSuggestionHeaderLabel?: string;
  depth?: number;
  disabled?: boolean;
  readOnly?: boolean;
};

export function ConditionBuilderNode({
  value,
  onChange,
  mode,
  lang,
  variableSuggestions,
  variableSuggestionHeaderLabel,
  depth = 0,
  disabled,
  readOnly,
}: ConditionBuilderNodeProps) {
  if (!isConditionGroup(value)) {
    if (!isConditionRule(value)) {
      return null;
    }
    return (
      <ConditionRuleEditor
        value={value}
        onChange={onChange}
        mode={mode}
        lang={lang}
        variableSuggestions={variableSuggestions}
        variableSuggestionHeaderLabel={variableSuggestionHeaderLabel}
        disabled={disabled}
        readOnly={readOnly}
      />
    );
  }

  const items = getConditionGroupItems(value);
  const groupMode = getConditionGroupMode(value);
  const defaultLeftOperand = mode.kind === "boundLeft"
    ? mode.left
    : createPathOperand(mode.defaultPath ?? "");

  return (
    <div className="space-y-3 rounded-xl border border-border/70 bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Select
            value={groupMode}
            onValueChange={(nextValue) =>
              onChange(replaceConditionGroupMode(value, nextValue as "all" | "any"))
            }
            disabled={disabled || readOnly}
          >
            <SelectTrigger className="w-full" aria-label={lang === "nl" ? "Groepsmodus" : "Group mode"}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{lang === "nl" ? "Alle voorwaarden" : "All conditions"}</SelectItem>
              <SelectItem value="any">{lang === "nl" ? "Eén van de voorwaarden" : "Any condition"}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || readOnly}
            onClick={() =>
              onChange(
                replaceConditionGroupItems(value, [
                  ...items,
                  createConditionRule(defaultLeftOperand),
                ]),
              )
            }
          >
            {lang === "nl" ? "Regel toevoegen" : "Add rule"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || readOnly}
            onClick={() =>
              onChange(
                replaceConditionGroupItems(value, [
                  ...items,
                  createConditionGroup("all", defaultLeftOperand),
                ]),
              )
            }
          >
            {lang === "nl" ? "Groep toevoegen" : "Add group"}
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {items.map((item, index) => (
          <div
            key={("id" in item && typeof item.id === "string" && item.id) || `${depth}-${index}`}
            className="space-y-2"
          >
            <ConditionBuilderNode
              value={item}
              onChange={(nextItem) =>
                onChange(
                  replaceConditionGroupItems(
                    value,
                    items.map((candidate, candidateIndex) =>
                      candidateIndex === index ? nextItem : candidate,
                    ),
                  ),
                )
              }
              mode={mode}
              lang={lang}
              variableSuggestions={variableSuggestions}
              variableSuggestionHeaderLabel={variableSuggestionHeaderLabel}
              depth={depth + 1}
              disabled={disabled}
              readOnly={readOnly}
            />
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || readOnly}
                onClick={() =>
                  onChange(
                    replaceConditionGroupItems(
                      value,
                      items.filter((_, candidateIndex) => candidateIndex !== index),
                    ),
                  )
                }
              >
                {lang === "nl" ? "Verwijderen" : "Remove"}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
