// SPDX-License-Identifier: BUSL-1.1
import { Field as FieldFrame } from "@/features/renderer/components/field";
import { Input } from "@/components/ui/forms/input";
import { ReferenceSelect } from "@/features/renderer/edit/controls/complex/reference-select";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import type { ConditionBuilderLang } from "./types";

type AggregateFilterEditorProps = {
  filter: Record<string, unknown> | undefined;
  filterableFields: NonNullable<VariableSuggestion["aggregate"]>["filterableFields"];
  onChange: (filter: Record<string, unknown> | undefined) => void;
  lang: ConditionBuilderLang;
  disabled?: boolean;
  readOnly?: boolean;
};

export function AggregateFilterEditor({
  filter,
  filterableFields,
  onChange,
  lang,
  disabled,
  readOnly,
}: AggregateFilterEditorProps) {
  if (!filterableFields?.length) return null;

  const activeFilterCount = filter
    ? Object.keys(filter).filter((key) => filter[key] !== undefined && filter[key] !== "").length
    : 0;

  function handleFieldChange(key: string, nextValue: string) {
    const nextFilter = { ...filter };
    if (nextValue === "") {
      delete nextFilter[key];
    } else {
      nextFilter[key] = nextValue;
    }
    const hasValues = Object.keys(nextFilter).some(
      (filterKey) => nextFilter[filterKey] !== undefined && nextFilter[filterKey] !== "",
    );
    onChange(hasValues ? nextFilter : undefined);
  }

  return (
    <details className="rounded-md border border-dashed border-border/70 bg-muted/10">
      <summary className="cursor-pointer select-none px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
        Filter
        {activeFilterCount > 0 && (
          <span className="ml-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
            {activeFilterCount}
          </span>
        )}
      </summary>
      <div className="grid gap-x-4 gap-y-1 px-3 pb-3 pt-1 sm:grid-cols-2">
        {filterableFields.map((field) => {
          const currentValue = (filter?.[field.key] as string) ?? "";
          const placeholder = lang === "nl" ? "Alle" : "All";

          return (
            <FieldFrame key={field.key} label={field.label}>
              {(controlProps) =>
                field.options && field.options.length > 0 ? (
                  <ReferenceSelect
                    id={controlProps.id}
                    aria-describedby={controlProps["aria-describedby"]}
                    aria-invalid={controlProps["aria-invalid"]}
                    value={currentValue || undefined}
                    onValueChange={(value) => handleFieldChange(field.key, value)}
                    disabled={disabled || readOnly}
                    clearable
                    placeholder={placeholder}
                    options={field.options}
                  />
                ) : (
                  <Input
                    id={controlProps.id}
                    aria-describedby={controlProps["aria-describedby"]}
                    aria-invalid={controlProps["aria-invalid"]}
                    value={currentValue}
                    onChange={(event) => handleFieldChange(field.key, event.currentTarget.value)}
                    disabled={disabled || readOnly}
                    placeholder={placeholder}
                  />
                )
              }
            </FieldFrame>
          );
        })}
      </div>
    </details>
  );
}
