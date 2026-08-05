// SPDX-License-Identifier: BUSL-1.1
import { Input } from "@/components/ui/forms/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/features/renderer/edit/controls/basic/select";
import { ListSelect } from "@/features/renderer/edit/controls/complex/list-select";
import { TextInput } from "@/features/renderer/edit/controls/complex/text-input";
import type { CompilerConditionOperandInput } from "@/generated/compiler/canonical-condition";
import {
  createFunctionOperand,
  createLiteralOperand,
  createPathOperand,
} from "@/features/renderer/runtime/conditions";
import { LIST_LITERAL_OPERATORS } from "./operator-options";
import { listLiteralValues, operandToInputValue } from "./operands";
import { AggregateFilterEditor } from "./aggregate-filter-editor";
import type { ConditionOperandEditorProps } from "./types";

export function ConditionOperandEditor({
  value,
  onChange,
  lang,
  variableSuggestions,
  variableSuggestionHeaderLabel,
  disabled,
  readOnly,
  allowPath = true,
  allowFunction = false,
  label,
  literalOptions,
  leftFieldType,
  operator,
}: ConditionOperandEditorProps) {
  const operand = value ?? (allowPath ? createPathOperand() : createLiteralOperand(""));
  const operandKind: "path" | "literal" | "function" = allowPath
    ? operand.kind === "function"
      ? allowFunction
        ? "function"
        : "path"
      : operand.kind
    : "literal";

  const selectedPath = operand.kind === "path" ? operand.path : null;
  const selectedSuggestion = selectedPath
    ? variableSuggestions?.find((suggestion) => suggestion.path === selectedPath) ?? null
    : null;
  const filterableFields = selectedSuggestion?.aggregate?.filterableFields;
  const currentFilter = operand.kind === "path" ? operand.filter : undefined;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2">
        {allowPath ? (
          <Select
            value={operandKind}
            onValueChange={(nextKind) => {
              if (nextKind === operandKind) return;
              if (nextKind === "path") {
                onChange(createPathOperand());
              } else if (nextKind === "function") {
                onChange(createFunctionOperand("today"));
              } else {
                onChange(createLiteralOperand(""));
              }
            }}
            disabled={disabled || readOnly}
          >
            <SelectTrigger aria-label={lang === "nl" ? "Type operand" : "Operand type"}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="path">{lang === "nl" ? "Variabele" : "Variable"}</SelectItem>
              <SelectItem value="literal">{lang === "nl" ? "Vaste waarde" : "Literal value"}</SelectItem>
              {allowFunction && (
                <SelectItem value="function">{lang === "nl" ? "Vandaag" : "Today"}</SelectItem>
              )}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex items-center rounded-md border border-border/70 bg-muted/30 px-3 text-sm text-muted-foreground">
            {lang === "nl" ? "Vaste waarde" : "Literal value"}
          </div>
        )}

        {operand.kind === "function" ? (
          <div
            className="flex items-center rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm text-foreground"
            aria-label={lang === "nl" ? "Vandaag" : "Today"}
          >
            {lang === "nl" ? "Vandaag" : "Today"}
          </div>
        ) : operand.kind === "path" ? (
          <TextInput
            behavior="variable-select"
            value={operandToInputValue(operand)}
            suggestions={variableSuggestions}
            suggestionHeaderLabel={variableSuggestionHeaderLabel}
            onValueChange={(nextValue) => {
              const nextOperand: CompilerConditionOperandInput = { kind: "path", path: nextValue };
              const nextSuggestion = variableSuggestions?.find((suggestion) => suggestion.path === nextValue);
              if (
                currentFilter &&
                nextSuggestion?.aggregate?.relationship === selectedSuggestion?.aggregate?.relationship
              ) {
                nextOperand.filter = currentFilter;
              }
              onChange(nextOperand);
            }}
            readOnly={readOnly}
            disabled={disabled}
            lang={lang}
            placeholder={lang === "nl" ? "Zoek variabele" : "Search variable"}
          />
        ) : literalOptions && literalOptions.length > 0 && operator && LIST_LITERAL_OPERATORS.has(operator) ? (
          <ListSelect
            multiple
            value={listLiteralValues(operand)}
            onValueChange={(nextValue) => onChange(createLiteralOperand(nextValue))}
            disabled={disabled}
            readOnly={readOnly}
            placeholder={lang === "nl" ? "Kies een of meer waarden" : "Select one or more values"}
            searchPlaceholder={lang === "nl" ? "Zoek waarde" : "Search value"}
            emptyMessage={lang === "nl" ? "Geen waarden gevonden." : "No values found."}
            options={literalOptions}
            aria-label={lang === "nl" ? "Waarde" : "Value"}
          />
        ) : literalOptions && literalOptions.length > 0 ? (
          <Select
            value={operandToInputValue(operand)}
            onValueChange={(nextValue) => onChange(createLiteralOperand(nextValue))}
            disabled={disabled || readOnly}
          >
            <SelectTrigger aria-label={lang === "nl" ? "Waarde" : "Value"}>
              <SelectValue placeholder={lang === "nl" ? "Kies een waarde" : "Select a value"} />
            </SelectTrigger>
            <SelectContent>
              {literalOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : leftFieldType === "date" ? (
          <Input
            type="date"
            value={operandToInputValue(operand)}
            onChange={(event) => onChange(createLiteralOperand(event.currentTarget.value))}
            readOnly={readOnly}
            disabled={disabled}
            aria-label={lang === "nl" ? "Datum" : "Date"}
          />
        ) : leftFieldType === "datetime" ? (
          <Input
            type="datetime-local"
            value={operandToInputValue(operand)}
            onChange={(event) => onChange(createLiteralOperand(event.currentTarget.value))}
            readOnly={readOnly}
            disabled={disabled}
            aria-label={lang === "nl" ? "Datum en tijd" : "Date and time"}
          />
        ) : leftFieldType === "boolean" ? (
          <Select
            value={operandToInputValue(operand)}
            onValueChange={(nextValue) => onChange(createLiteralOperand(nextValue === "true"))}
            disabled={disabled || readOnly}
          >
            <SelectTrigger aria-label={lang === "nl" ? "Ja/Nee" : "Yes/No"}>
              <SelectValue placeholder={lang === "nl" ? "Kies een waarde" : "Select a value"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">{lang === "nl" ? "Ja" : "Yes"}</SelectItem>
              <SelectItem value="false">{lang === "nl" ? "Nee" : "No"}</SelectItem>
            </SelectContent>
          </Select>
        ) : leftFieldType === "integer" || leftFieldType === "number" ? (
          <Input
            type="number"
            inputMode={leftFieldType === "integer" ? "numeric" : "decimal"}
            step={leftFieldType === "integer" ? 1 : "any"}
            value={operandToInputValue(operand)}
            onChange={(event) => {
              const raw = event.currentTarget.value;
              if (raw === "") {
                onChange(createLiteralOperand(""));
                return;
              }
              const parsed = leftFieldType === "integer" ? parseInt(raw, 10) : Number(raw);
              if (Number.isNaN(parsed)) {
                onChange(createLiteralOperand(raw));
                return;
              }
              onChange(createLiteralOperand(parsed));
            }}
            readOnly={readOnly}
            disabled={disabled}
            placeholder={lang === "nl" ? "Getal" : "Number"}
          />
        ) : (
          <Input
            value={operandToInputValue(operand)}
            onChange={(event) => onChange(createLiteralOperand(event.currentTarget.value))}
            readOnly={readOnly}
            disabled={disabled}
            placeholder={lang === "nl" ? "Vaste waarde" : "Literal value"}
          />
        )}
      </div>

      {filterableFields && filterableFields.length > 0 && operand.kind === "path" && (
        <AggregateFilterEditor
          filter={currentFilter}
          filterableFields={filterableFields}
          onChange={(nextFilter) => {
            onChange({ kind: "path", path: operand.path, filter: nextFilter });
          }}
          lang={lang}
          disabled={disabled}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}
