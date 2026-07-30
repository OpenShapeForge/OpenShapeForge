// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/overlay/popover";
import { fieldShellClasses } from "@/components/ui/forms/field-shell-variants";
import { cn } from "@/lib/utils";

type FieldTypeCardinality =
  | "single"
  | "collection"
  | {
      min?: number;
      max?: number | "unbounded";
    };

export type FieldTypeOption = {
  value: string;
  kind: "base" | "semantic";
  label: string;
  description?: string;
  baseType: string;
  valueType: string;
  cardinality?: FieldTypeCardinality;
  semanticType?: string;
  icon?: string;
};

type FieldTypeSelectProps = {
  value?: string;
  cardinality?: "single" | "collection";
  semanticType?: string;
  usage?: "requestInput" | "workflowConfig" | "entityMapping" | "internalSchema";
  lang: "nl" | "en";
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  onSelectionChange: (selection: {
    valueType: string;
    cardinality: "single" | "collection";
    semanticType?: string;
  }) => void;
};

const FIELD_DEFINITION_SEMANTIC_TYPE = "fieldDefinition";
const FIELD_DEFINITION_COLLECTION_VALUE = "semantic:fieldDefinition:collection";
const FIELD_DEFINITION_COLLECTION_LABELS: Record<"nl" | "en", string> = {
  nl: "Velddefinities",
  en: "Field definitions",
};

const BASE_LABELS: Record<string, { nl: string; en: string }> = {
  string: { nl: "Tekst", en: "Text" },
  integer: { nl: "Geheel getal", en: "Integer" },
  number: { nl: "Decimaal getal", en: "Decimal number" },
  boolean: { nl: "Ja/Nee", en: "Yes/No" },
  date: { nl: "Datum", en: "Date" },
  datetime: { nl: "Datum en tijd", en: "Date and time" },
  object: { nl: "Object", en: "Object" },
  array: { nl: "Lijst", en: "List" },
};

function selectedValue(type?: string, cardinality?: "single" | "collection", semanticType?: string) {
  const semantic = semanticType?.trim();
  if (semantic) {
    return cardinality === "collection"
      ? `semantic:${semantic}:collection`
      : `semantic:${semantic}`;
  }
  if (cardinality === "collection") {
    return type === "object" ? FIELD_DEFINITION_COLLECTION_VALUE : "array";
  }
  return type?.trim() || "string";
}

function isFieldDefinitionCollectionSelection(
  type: string | undefined,
  cardinality: "single" | "collection" | undefined,
  semanticType: string | undefined,
) {
  return (
    cardinality === "collection" &&
    (semanticType?.trim() === FIELD_DEFINITION_SEMANTIC_TYPE ||
      (semanticType?.trim() ? false : type === "object"))
  );
}

function selectedFallbackLabel(
  type: string | undefined,
  cardinality: "single" | "collection" | undefined,
  semanticType: string | undefined,
  lang: "nl" | "en",
) {
  const semantic = semanticType?.trim();
  if (isFieldDefinitionCollectionSelection(type, cardinality, semantic)) {
    return FIELD_DEFINITION_COLLECTION_LABELS[lang];
  }
  if (semantic) return semantic;
  if (cardinality === "collection") {
    return BASE_LABELS.array?.[lang] ?? "List";
  }
  const baseType = type?.trim() || "string";
  return BASE_LABELS[baseType]?.[lang] ?? baseType;
}

function normalizeOptionCardinality(cardinality: FieldTypeCardinality | undefined): "single" | "collection" {
  if (cardinality === "collection") return "collection";
  if (cardinality && typeof cardinality === "object") {
    return cardinality.max === 1 ? "single" : "collection";
  }
  return "single";
}

function groupOptions(options: FieldTypeOption[]) {
  return {
    base: options.filter((option) => option.kind === "base"),
    semantic: options.filter((option) => option.kind === "semantic"),
  };
}

export function FieldTypeSelect({
  value,
  cardinality,
  semanticType,
  usage = "requestInput",
  lang,
  disabled = false,
  placeholder,
  onSelectionChange,
  ...a11y
}: FieldTypeSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [options, setOptions] = useState<FieldTypeOption[]>([]);
  const [loading, setLoading] = useState(false);
  const currentValue = selectedValue(value, cardinality, semanticType);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query), 180);
    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({
      lang,
      usage,
      limit: open ? "50" : "20",
    });
    const semantic = semanticType?.trim();
    const search = open ? debouncedQuery.trim() : semantic;
    if (search) params.set("search", search);

    if (!open && !semantic) {
      params.set("limit", "12");
    }

    setLoading(true);
    fetch(`/api/workflow/designer/field-type-options?${params.toString()}`)
      .then((response) => response.json())
      .then((data: unknown) => {
        if (!active) return;
        setOptions(Array.isArray(data) ? (data as FieldTypeOption[]) : []);
      })
      .catch(() => {
        if (active) setOptions([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [debouncedQuery, lang, open, semanticType, usage]);

  const selectedLabel = useMemo(() => {
    return (
      options.find((option) => option.value === currentValue)?.label ??
      selectedFallbackLabel(value, cardinality, semanticType, lang)
    );
  }, [cardinality, currentValue, lang, options, semanticType, value]);

  const grouped = useMemo(() => groupOptions(options), [options]);
  const hasOptions = grouped.base.length > 0 || grouped.semantic.length > 0;

  function select(option: FieldTypeOption) {
    onSelectionChange({
      valueType: option.valueType ?? option.baseType,
      cardinality: normalizeOptionCardinality(option.cardinality),
      ...(option.semanticType
        ? { semanticType: option.semanticType }
        : {}),
    });
    setOpen(false);
    setQuery("");
    setDebouncedQuery("");
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          setDebouncedQuery("");
        }
      }}
    >
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          role="combobox"
          className={cn(
            fieldShellClasses,
            "flex w-full min-w-0 items-center justify-between gap-2",
            !selectedLabel && "text-muted-foreground",
          )}
          disabled={disabled}
          aria-expanded={open}
          {...a11y}
        >
          <span className="truncate">{selectedLabel || placeholder || "Selecteer..."}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[max(var(--radix-popover-trigger-width),22rem)] p-0"
        align="start"
      >
        <div className="border-b px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={lang === "nl" ? "Zoek type..." : "Search type..."}
              className="h-6 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {loading && !hasOptions ? (
            <p className="px-2 py-3 text-center text-sm text-muted-foreground">
              {lang === "nl" ? "Laden..." : "Loading..."}
            </p>
          ) : null}
          {hasOptions ? (
            <>
              <OptionGroup
                label={lang === "nl" ? "Waardetype" : "Value type"}
                options={grouped.base}
                currentValue={currentValue}
                onSelect={select}
              />
              <OptionGroup
                label={lang === "nl" ? "Betekenis" : "Meaning"}
                options={grouped.semantic}
                currentValue={currentValue}
                onSelect={select}
              />
            </>
          ) : !loading ? (
            <p className="px-2 py-3 text-center text-sm text-muted-foreground">
              {lang === "nl" ? "Geen types gevonden." : "No types found."}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function optionBadgeLabel(option: FieldTypeOption) {
  return option.kind === "semantic"
    ? option.label.toLowerCase()
    : option.baseType;
}

function OptionGroup({
  label,
  options,
  currentValue,
  onSelect,
}: {
  label: string;
  options: FieldTypeOption[];
  currentValue: string;
  onSelect: (option: FieldTypeOption) => void;
}) {
  if (options.length === 0) return null;

  return (
    <div className="py-1">
      <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onSelect(option)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
            option.value === currentValue && "bg-accent/60 font-medium",
          )}
        >
          <Check
            className={cn(
              "size-4 shrink-0",
              option.value === currentValue ? "opacity-100" : "opacity-0",
            )}
          />
          <div className="min-w-0 flex-1">
            <span className="block truncate">{option.label}</span>
            {option.description ? (
              <span className="block truncate text-xs text-muted-foreground">
                {option.description}
              </span>
            ) : null}
          </div>
          <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
            {optionBadgeLabel(option)}
          </span>
        </button>
      ))}
    </div>
  );
}
