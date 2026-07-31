// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Button } from "@openshapeforge/ui";
import { DisplayLabel } from "@/features/renderer/display/label";
import {
  Card,
  CardContent,
  CardEmptyState,
  CardHeader,
  CardTitle,
} from "@/components/ui/display/card";
import type { EntityPageHeaderAction } from "@/components/entity/entity-page-contract";
import type { Field } from "@/generated/compiler/field-contract";
import type { RendererChildRelationshipUsage } from "@/features/renderer/form-definition";
import {
  ExpandableChildSection,
  type LoadChildren,
} from "@/features/renderer/display/relationship-list-child-section";
import type { ReactNode } from "react";

export type FieldMeta = {
  key: string;
  label?: { en?: string; nl?: string } | string;
  valueType?: Field["valueType"];
  cardinality?: Field["cardinality"];
  semanticType?: string;
  layoutFraction?: number;
  render?: Field["render"];
  validation?: Field["validation"];
  options?: Field["options"];
  suggestions?: Field["suggestions"];
};

export type RelationshipRenderFieldValue = (
  item: Record<string, unknown>,
  field: FieldMeta,
  value: unknown,
) => ReactNode;

type RowEntry = {
  key: string;
  label: string;
  value: string;
  layoutFraction?: number;
};

type Props = {
  items: Record<string, unknown>[];
  lang: string;
  presentationType?: "list" | "cards" | "summary" | "listItem";
  titleField?: string;
  subtitleField?: string;
  title?: string;
  emptyState?: string;
  actions?: EntityPageHeaderAction[];
  resolveItemActions?: (item: Record<string, unknown>) => EntityPageHeaderAction[] | undefined;
  onAction?: (action: EntityPageHeaderAction) => void;
  fields?: FieldMeta[];
  renderFieldValue?: RelationshipRenderFieldValue;
  /**
   * Per-row collapsible child lists. When present each row gets an expand
   * affordance rendering an {@link ExpandableChildSection}.
   */
  childRelationships?: RendererChildRelationshipUsage[];
  onLoadChildren?: LoadChildren;
};

function resolveLocalizedLabel(
  label: FieldMeta["label"] | undefined,
  lang: string,
): string | null {
  if (!label) return null;
  if (typeof label === "string") return label;
  if (lang === "nl" && label.nl) return label.nl;
  if (label.en) return label.en;
  if (label.nl) return label.nl;
  return null;
}

function getValueAtPath(item: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = item;
  for (const part of parts) {
    if (current == null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const TITLE_CANDIDATES = [
  "displayName",
  "name",
  "value",
  "street",
  "code",
  "title",
  "type",
  "city",
];

const AUTHOR_RELATIONSHIP_CANDIDATES = ["author", "reporter", "assignee", "owner"];

const HIDDEN_FIELD_KEYS = new Set([
  "id",
  "relation_id",
  "created_at",
  "updated_at",
  "createdAt",
  "updatedAt",
]);

const DATETIME_SUFFIX_PATTERN = /(At|_at)$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_PATTERN.test(value);
}

function formatDateTime(value: string, lang: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(lang === "nl" ? "nl-NL" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatPrimitiveValue(value: unknown, lang = "en"): string {
  if (value == null || value === "") return "-";
  if (typeof value === "string") {
    return isIsoDateTime(value) ? formatDateTime(value, lang) : value;
  }
  if (typeof value === "number") {
    return new Intl.NumberFormat(lang === "nl" ? "nl-NL" : "en-US").format(value);
  }
  if (typeof value === "boolean") {
    return lang === "nl" ? (value ? "Ja" : "Nee") : (value ? "Yes" : "No");
  }
  if (Array.isArray(value)) {
    return value.map((item) => formatPrimitiveValue(item, lang)).join(", ");
  }
  if (value instanceof Date) {
    return value.toLocaleString(lang === "nl" ? "nl-NL" : "en-US");
  }
  return String(value);
}

function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function getRowTitle(
  item: Record<string, unknown>,
  lang: string,
  fields?: FieldMeta[],
): { value: string; sourceKey: string } | null {
  // Prefer an explicit nested relationship path from the supplied fields
  if (fields) {
    for (const field of fields) {
      if (!field.key.includes(".")) continue;
      const [relKey] = field.key.split(".");
      if (!AUTHOR_RELATIONSHIP_CANDIDATES.includes(relKey)) continue;
      const value = getValueAtPath(item, field.key);
      if (value != null && value !== "") {
        return { value: formatPrimitiveValue(value, lang), sourceKey: field.key };
      }
    }
  }

  for (const relKey of AUTHOR_RELATIONSHIP_CANDIDATES) {
    const nested = item[relKey];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const fieldKey of TITLE_CANDIDATES) {
        const value = (nested as Record<string, unknown>)[fieldKey];
        if (value != null && value !== "") {
          return { value: formatPrimitiveValue(value, lang), sourceKey: `${relKey}.${fieldKey}` };
        }
      }
    }
  }

  for (const key of TITLE_CANDIDATES) {
    const value = item[key];
    if (value != null && value !== "") {
      return { value: formatPrimitiveValue(value, lang), sourceKey: key };
    }
  }

  return null;
}

function getRowMeta(item: Record<string, unknown>, lang: string): string | null {
  const createdAt = item.createdAt ?? item.created_at;
  if (typeof createdAt === "string" && createdAt) {
    return formatDateTime(createdAt, lang);
  }
  return null;
}

function getRowEntries(
  item: Record<string, unknown>,
  lang: string,
  fields?: FieldMeta[],
  excludeKeys?: Set<string>,
): RowEntry[] {
  // When the caller supplies a `fields` ordering, use it as the source of truth.
  // Otherwise fall back to the object's own keys.
  if (fields && fields.length > 0) {
    const entries = fields.reduce<RowEntry[]>((acc, field) => {
      if (excludeKeys?.has(field.key)) return acc;
      const value = getValueAtPath(item, field.key);
      if (value == null || value === "") return acc;
      if (typeof value === "object" && !Array.isArray(value)) return acc;
      const label = resolveLocalizedLabel(field.label, lang) ?? humanizeKey(field.key.split(".").pop() ?? field.key);
      acc.push({
        key: field.key,
        label,
        value: formatPrimitiveValue(value, lang),
        layoutFraction: field.layoutFraction,
      });
      return acc;
    }, []);
    const primaryEntries = entries.filter((entry) => entry.layoutFraction !== 1).slice(0, 4);
    const fullWidthEntries = entries.filter((entry) => entry.layoutFraction === 1);
    return [...primaryEntries, ...fullWidthEntries];
  }

  return Object.entries(item)
    .filter(([key, value]) => {
      if (HIDDEN_FIELD_KEYS.has(key)) return false;
      if (DATETIME_SUFFIX_PATTERN.test(key) && key !== "resolvedAt" && key !== "closedAt") {
        return false;
      }
      if (value == null || value === "") return false;
      if (typeof value === "object" && !Array.isArray(value)) return false;
      return true;
    })
    .slice(0, 3)
    .map(([key, value]) => ({
      key,
      label: humanizeKey(key),
      value: formatPrimitiveValue(value, lang),
    }));
}

export function RelationshipList({
  items,
  lang,
  presentationType,
  titleField,
  subtitleField,
  title,
  emptyState,
  actions,
  resolveItemActions,
  onAction,
  fields,
  renderFieldValue,
  childRelationships,
  onLoadChildren,
}: Props) {
  const renderItemActionButton = (action: EntityPageHeaderAction) => (
    <Button
      key={action.key}
      type="button"
      size="sm"
      variant={action.mutation === "delete" ? "destructive" : "outline"}
      onClick={() => onAction?.(action)}
      disabled={action.disabled}
      title={action.disabledMessage ?? undefined}
    >
      {action.label}
    </Button>
  );

  return (
    <Card>
      {title || actions?.length ? (
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            {title ? <CardTitle>{title}</CardTitle> : <div />}
            {actions?.length ? (
              <div className="flex flex-wrap gap-2">
                {actions.map(renderItemActionButton)}
              </div>
            ) : null}
          </div>
        </CardHeader>
      ) : null}
      <CardContent>
        {items.length > 0 ? (
          <div className="divide-y rounded-xl border">
            {items.map((item, index) => {
              const isListItem = presentationType === "listItem";
              const explicitTitleField = titleField;
              const explicitSubtitleField = subtitleField;
              const rowTitle = explicitTitleField
                ? {
                    value: formatPrimitiveValue(getValueAtPath(item, explicitTitleField), lang),
                    sourceKey: explicitTitleField,
                  }
                : getRowTitle(item, lang, fields);
              const rowMeta = getRowMeta(item, lang);
              const excludeKeys = new Set<string>();
              if (rowTitle?.sourceKey) excludeKeys.add(rowTitle.sourceKey);
              if (explicitSubtitleField) excludeKeys.add(explicitSubtitleField);
              excludeKeys.add("createdAt");
              excludeKeys.add("created_at");
              const entries = getRowEntries(item, lang, fields, excludeKeys);
              const subtitleValue = explicitSubtitleField
                ? formatPrimitiveValue(getValueAtPath(item, explicitSubtitleField), lang)
                : null;
              const itemActions = resolveItemActions?.(item);
              const showRowHeader = Boolean(rowTitle || rowMeta || itemActions?.length);
              return (
                <div
                  key={`${item.id ?? "relationship"}-${index}`}
                  className="space-y-3 px-4 py-4"
                >
                  {showRowHeader ? (
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      {rowTitle ? (
                        <div className="min-w-0">
                          <div className="font-medium text-foreground">{rowTitle.value}</div>
                          {subtitleValue && subtitleValue !== "-" ? (
                            <div className="mt-1 text-xs text-muted-foreground">{subtitleValue}</div>
                          ) : null}
                        </div>
                      ) : (
                        <div />
                      )}
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                        {rowMeta ? (
                          <div className="text-xs text-muted-foreground">{rowMeta}</div>
                        ) : null}
                        {itemActions?.map(renderItemActionButton)}
                      </div>
                    </div>
                  ) : null}
                  {entries.length > 0 ? (
                    <div className="grid gap-3 md:grid-cols-3">
                      {entries.map((entry) => {
                        const fieldMeta = fields?.find((field) => field.key === entry.key);
                        // Route through renderFieldValue (which honors an explicit
                        // display control such as MarkdownDisplay) for listItem rows
                        // and for any field carrying an explicit render component.
                        const useRenderer =
                          Boolean(renderFieldValue) &&
                          (isListItem || Boolean(fieldMeta?.render?.component));
                        return (
                          <div
                            key={entry.key}
                            className={entry.layoutFraction === 1 ? "space-y-1 md:col-span-3" : "space-y-1"}
                          >
                            <DisplayLabel>{entry.label}</DisplayLabel>
                            <div className="text-sm leading-6 text-foreground">
                              {useRenderer && renderFieldValue
                                ? renderFieldValue(item, fieldMeta ?? entry, getValueAtPath(item, entry.key))
                                : entry.value}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : !rowTitle && !rowMeta ? (
                    <CardEmptyState>
                      {lang === "nl" ? "Geen gegevens beschikbaar." : "No data available."}
                    </CardEmptyState>
                  ) : null}
                  {childRelationships?.length &&
                  onLoadChildren &&
                  typeof item.id === "string" &&
                  item.id
                    ? childRelationships.map((childRel) => (
                        <ExpandableChildSection
                          key={`${childRel.name}-${item.id}`}
                          childRel={childRel}
                          parentId={item.id as string}
                          lang={lang}
                          onLoadChildren={onLoadChildren}
                          renderFieldValue={renderFieldValue}
                        />
                      ))
                    : null}
                </div>
              );
            })}
          </div>
        ) : (
          <CardEmptyState>
            {emptyState ?? (lang === "nl" ? "Geen gerelateerde items gevonden." : "No related items found.")}
          </CardEmptyState>
        )}
      </CardContent>
    </Card>
  );
}
