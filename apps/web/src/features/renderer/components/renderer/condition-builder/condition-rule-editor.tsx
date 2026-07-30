// SPDX-License-Identifier: BUSL-1.1
import { Input } from "@/components/ui/forms/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/features/renderer/edit/controls/basic/select";
import type {
  CompilerConditionInput,
  CompilerConditionOperandInput,
  CompilerConditionOperator,
} from "@/generated/compiler/canonical-condition";
import {
  conditionUsesUnaryOperator,
  type AuthoredConditionRule,
  type ConditionBuilderMode,
} from "@/features/renderer/runtime/conditions";
import {
  filterVariableSuggestions,
  getVariableFilterForSuggestion,
} from "@/features/renderer/runtime/variable-compatibility";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import { ConditionOperandEditor } from "./condition-operand-editor";
import { getOperatorsForValueType } from "./operator-options";
import { normalizeRightOperandForOperator, operandToInputValue } from "./operands";
import type { ConditionBuilderLang } from "./types";

type ConditionRuleEditorProps = {
  value: AuthoredConditionRule;
  onChange: (value: CompilerConditionInput) => void;
  mode: ConditionBuilderMode;
  lang: ConditionBuilderLang;
  variableSuggestions: VariableSuggestion[];
  variableSuggestionHeaderLabel?: string;
  disabled?: boolean;
  readOnly?: boolean;
};

export function ConditionRuleEditor({
  value,
  onChange,
  mode,
  lang,
  variableSuggestions,
  variableSuggestionHeaderLabel,
  disabled,
  readOnly,
}: ConditionRuleEditorProps) {
  const unary = conditionUsesUnaryOperator(value.operator);
  const leftPath = value.left.kind === "path" ? value.left.path : null;
  const leftSuggestion = leftPath
    ? variableSuggestions.find((suggestion) => suggestion.path === leftPath) ?? null
    : null;
  const filteredRightSuggestions = filterVariableSuggestions(
    variableSuggestions,
    getVariableFilterForSuggestion(leftSuggestion),
  );
  const applicableOperators = getOperatorsForValueType(leftSuggestion?.valueType, leftSuggestion?.fieldType);
  const leftIsDate = leftSuggestion?.fieldType === "date" || leftSuggestion?.fieldType === "datetime";

  const handleRightChange = (nextRight: CompilerConditionOperandInput) => {
    onChange({ ...value, right: nextRight });
  };

  const rightOperand = value.right;
  const rightSuggestion = rightOperand?.kind === "path"
    ? variableSuggestions.find((suggestion) => suggestion.path === rightOperand.path) ?? null
    : null;
  const rightIsDateOperand =
    value.right?.kind === "function" ||
    (rightSuggestion?.fieldType === "date" || rightSuggestion?.fieldType === "datetime");
  const showOffset = leftIsDate && rightIsDateOperand && !unary;
  const currentOffset =
    value.right?.kind === "function" || value.right?.kind === "path"
      ? (value.right.offset?.days ?? 0)
      : 0;
  const offsetAbs = Math.abs(currentOffset);
  const offsetDirection: "ago" | "fromNow" = currentOffset < 0 ? "ago" : "fromNow";

  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3">
      {mode.kind === "boundLeft" ? (
        <div className="rounded-md border border-dashed border-border/70 px-3 py-2 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">
            {mode.leftLabel ?? (lang === "nl" ? "Variabele" : "Variable")}
          </p>
          <p>{mode.leftDisplayValue ?? operandToInputValue(mode.left)}</p>
        </div>
      ) : (
        <ConditionOperandEditor
          value={value.left}
          onChange={(nextLeft) => {
            const nextPath = nextLeft.kind === "path" ? nextLeft.path : null;
            const nextSuggestion = nextPath
              ? variableSuggestions.find((suggestion) => suggestion.path === nextPath) ?? null
              : null;
            const nextOperators = getOperatorsForValueType(nextSuggestion?.valueType, nextSuggestion?.fieldType);
            const operatorStillValid = nextOperators.some((operator) => operator.value === value.operator);
            onChange({
              ...value,
              left: nextLeft,
              ...(operatorStillValid ? {} : { operator: "equals" as CompilerConditionOperator }),
            });
          }}
          lang={lang}
          variableSuggestions={variableSuggestions}
          variableSuggestionHeaderLabel={variableSuggestionHeaderLabel}
          disabled={disabled}
          readOnly={readOnly}
          label={lang === "nl" ? "Linker operand" : "Left operand"}
        />
      )}

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          {lang === "nl" ? "Operator" : "Operator"}
        </p>
        <Select
          value={value.operator}
          onValueChange={(nextOperator) => {
            const operator = nextOperator as CompilerConditionOperator;
            onChange({
              ...value,
              operator,
              ...(conditionUsesUnaryOperator(operator)
                ? {}
                : { right: normalizeRightOperandForOperator(operator, value.right) }),
            });
          }}
          disabled={disabled || readOnly}
        >
          <SelectTrigger aria-label={lang === "nl" ? "Operator" : "Operator"}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {applicableOperators.map((operator) => (
              <SelectItem key={operator.value} value={operator.value}>
                {lang === "nl" ? operator.labelNl : operator.labelEn}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {unary ? null : (
        <>
          <ConditionOperandEditor
            value={value.right}
            onChange={handleRightChange}
            lang={lang}
            variableSuggestions={filteredRightSuggestions}
            variableSuggestionHeaderLabel={variableSuggestionHeaderLabel}
            disabled={disabled}
            readOnly={readOnly}
            allowFunction={leftIsDate}
            label={lang === "nl" ? "Rechter operand" : "Right operand"}
            literalOptions={leftSuggestion?.options}
            leftFieldType={leftSuggestion?.fieldType}
            operator={value.operator}
          />

          {showOffset && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {lang === "nl" ? "Offset (optioneel)" : "Offset (optional)"}
              </p>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2">
                <Input
                  type="number"
                  min={0}
                  value={offsetAbs}
                  onChange={(event) => {
                    const days = Math.max(0, Math.round(Number(event.currentTarget.value) || 0));
                    const signed = days === 0 ? undefined : { days: offsetDirection === "ago" ? -days : days };
                    if (value.right?.kind === "function") {
                      const right: CompilerConditionOperandInput = signed
                        ? { kind: "function", name: value.right.name, offset: signed }
                        : { kind: "function", name: value.right.name };
                      onChange({ ...value, right });
                    } else if (value.right?.kind === "path") {
                      const right: CompilerConditionOperandInput = signed
                        ? {
                            kind: "path",
                            path: value.right.path,
                            ...(value.right.filter ? { filter: value.right.filter } : {}),
                            offset: signed,
                          }
                        : {
                            kind: "path",
                            path: value.right.path,
                            ...(value.right.filter ? { filter: value.right.filter } : {}),
                          };
                      onChange({ ...value, right });
                    }
                  }}
                  disabled={disabled}
                  readOnly={readOnly}
                  placeholder="0"
                />
                <Select
                  value={offsetDirection}
                  onValueChange={(direction) => {
                    if (offsetAbs === 0) return;
                    const signed = { days: direction === "ago" ? -offsetAbs : offsetAbs };
                    if (value.right?.kind === "function") {
                      const right: CompilerConditionOperandInput = {
                        kind: "function",
                        name: value.right.name,
                        offset: signed,
                      };
                      onChange({ ...value, right });
                    } else if (value.right?.kind === "path") {
                      const right: CompilerConditionOperandInput = {
                        kind: "path",
                        path: value.right.path,
                        ...(value.right.filter ? { filter: value.right.filter } : {}),
                        offset: signed,
                      };
                      onChange({ ...value, right });
                    }
                  }}
                  disabled={disabled || readOnly || offsetAbs === 0}
                >
                  <SelectTrigger aria-label={lang === "nl" ? "Richting" : "Direction"}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ago">{lang === "nl" ? "dagen geleden" : "days ago"}</SelectItem>
                    <SelectItem value="fromNow">{lang === "nl" ? "dagen vanaf nu" : "days from now"}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
