// SPDX-License-Identifier: BUSL-1.1
import { Button } from "@openshapeforge/ui";
import { Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/forms/input";
import { labels } from "./labels";
import { updateListValue } from "./state";
import type { PolicyConditionLanguage } from "./types";

export function StringListEditor({
  id,
  label,
  values,
  lang,
  disabled,
  onChange,
}: {
  id?: string;
  label: string;
  values: string[];
  lang: PolicyConditionLanguage;
  disabled?: boolean;
  onChange: (values: string[]) => void;
}) {
  const t = labels(lang);
  const rows = values.length > 0 ? values : [""];

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-foreground-subtle">{label}</div>
      {rows.map((entry, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            id={index === 0 ? id : undefined}
            value={entry}
            disabled={disabled}
            aria-label={`${label} ${index + 1}`}
            onChange={(event) => {
              const nextRows = values.length > 0 ? values : [""];
              onChange(
                updateListValue(nextRows, index, event.currentTarget.value),
              );
            }}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={disabled}
            aria-label={t.removeValue}
            onClick={() =>
              onChange(rows.filter((_, rowIndex) => rowIndex !== index))
            }
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => onChange([...values, ""])}
      >
        <Plus className="mr-2 size-4" />
        {t.addValue}
      </Button>
    </div>
  );
}
