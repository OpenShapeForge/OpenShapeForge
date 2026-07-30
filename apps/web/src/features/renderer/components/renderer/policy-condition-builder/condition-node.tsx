// SPDX-License-Identifier: BUSL-1.1
import { Button } from "@openshapeforge/ui";
import { Plus, Trash2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/features/renderer/edit/controls/basic/select";
import { FieldConditionEditor } from "./field-condition-editor";
import { labels } from "./labels";
import { CONDITION_TYPES } from "./options";
import { defaultCondition } from "./state";
import { StringListEditor } from "./string-list-editor";
import type {
  PolicyCondition,
  PolicyConditionLanguage,
  PolicyConditionType,
} from "./types";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";

export function ConditionNode({
  id,
  value,
  lang,
  disabled,
  entityType,
  variableSuggestions,
  level,
  onChange,
  onRemove,
}: {
  id?: string;
  value: PolicyCondition;
  lang: PolicyConditionLanguage;
  disabled?: boolean;
  entityType?: string | null;
  variableSuggestions: VariableSuggestion[];
  level: number;
  onChange: (value: PolicyCondition) => void;
  onRemove?: () => void;
}) {
  const t = labels(lang);
  const insetClass = level > 0 ? "border-l pl-3" : "";

  return (
    <div className={`space-y-3 rounded-md border bg-card p-3 ${insetClass}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-xs font-medium text-foreground-subtle">
            {t.conditionType}
          </div>
          <Select
            value={value.type}
            disabled={disabled}
            onValueChange={(nextType) =>
              onChange(defaultCondition(nextType as PolicyConditionType))
            }
          >
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONDITION_TYPES.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {entry.label[lang]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {onRemove ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={disabled}
            aria-label={t.removeCondition}
            onClick={onRemove}
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null}
      </div>

      {value.type === "actorRole" ? (
        <StringListEditor
          label={t.roles}
          values={value.anyOf}
          lang={lang}
          disabled={disabled}
          onChange={(anyOf) => onChange({ type: "actorRole", anyOf })}
        />
      ) : null}

      {value.type === "actorGroup" ? (
        <StringListEditor
          label={t.groups}
          values={value.anyOf}
          lang={lang}
          disabled={disabled}
          onChange={(anyOf) => onChange({ type: "actorGroup", anyOf })}
        />
      ) : null}

      {value.type === "field" ? (
        <div className="space-y-2">
          {!entityType ? (
            <p className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm text-foreground-subtle">
              {lang === "nl"
                ? "Kies een entiteitstype bij deze policy zodat veldvoorwaarden aan gegenereerde entiteitsvelden gekoppeld worden."
                : "Select an entity type for this policy so field conditions can be linked to generated entity fields."}
            </p>
          ) : null}
          <FieldConditionEditor
            value={value}
            lang={lang}
            disabled={disabled}
            variableSuggestions={variableSuggestions}
            onChange={onChange}
          />
        </div>
      ) : null}

      {value.type === "all" || value.type === "any" ? (
        <div className="space-y-3">
          {value.conditions.length === 0 ? (
            <p className="text-sm text-foreground-subtle">{t.emptyGroup}</p>
          ) : null}
          {value.conditions.map((condition, index) => (
            <ConditionNode
              key={index}
              value={condition}
              lang={lang}
              disabled={disabled}
              entityType={entityType}
              variableSuggestions={variableSuggestions}
              level={level + 1}
              onChange={(nextCondition) =>
                onChange({
                  type: value.type,
                  conditions: value.conditions.map((entry, entryIndex) =>
                    entryIndex === index ? nextCondition : entry,
                  ),
                })
              }
              onRemove={() =>
                onChange({
                  type: value.type,
                  conditions: value.conditions.filter(
                    (_, entryIndex) => entryIndex !== index,
                  ),
                })
              }
            />
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              onChange({
                type: value.type,
                conditions: [...value.conditions, { type: "always" }],
              })
            }
          >
            <Plus className="mr-2 size-4" />
            {t.addCondition}
          </Button>
        </div>
      ) : null}

      {value.type === "not" ? (
        <ConditionNode
          value={value.condition}
          lang={lang}
          disabled={disabled}
          entityType={entityType}
          variableSuggestions={variableSuggestions}
          level={level + 1}
          onChange={(condition) => onChange({ type: "not", condition })}
        />
      ) : null}

      {value.type === "always" ||
      value.type === "never" ||
      value.type === "taskAssignee" ? (
        <p className="text-sm text-foreground-subtle">{t.noExtraInput}</p>
      ) : null}
    </div>
  );
}
