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

type Props = {
  items: Record<string, unknown>[];
  lang: string;
  title?: string;
  emptyState?: string;
  actions?: EntityPageHeaderAction[];
  onAction?: (action: EntityPageHeaderAction) => void;
};

const CARD_TITLE_CANDIDATES = [
  "displayName",
  "name",
  "street",
  "code",
  "title",
  "type",
  "city",
];

function formatPrimitiveValue(value: unknown, lang = "en"): string {
  if (value == null || value === "") return "-";
  if (typeof value === "string") return value;
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

function getCardTitle(item: Record<string, unknown>, lang: string): string {
  for (const key of CARD_TITLE_CANDIDATES) {
    const value = item[key];
    if (value != null && value !== "") {
      return formatPrimitiveValue(value, lang);
    }
  }

  return formatPrimitiveValue(item.id ?? "-", lang);
}

function getCardEntries(item: Record<string, unknown>, lang: string) {
  return Object.entries(item)
    .filter(([key, value]) =>
      !["id", "relation_id", "created_at", "updated_at"].includes(key) &&
      value != null &&
      value !== "")
    .slice(0, 6)
    .map(([key, value]) => ({
      key,
      value: formatPrimitiveValue(value, lang),
    }));
}

export function RelationshipCards({ items, lang, title, emptyState, actions, onAction }: Props) {
  if (items.length === 0) {
    return (
      <Card className="p-4">
        {title || actions?.length ? (
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              {title ? <CardTitle className="text-base">{title}</CardTitle> : <div />}
              {actions?.length ? (
                <div className="flex flex-wrap gap-2">
                  {actions.map((action) => (
                    <Button
                      key={action.key}
                      type="button"
                      size="sm"
                      variant={action.mutation === "delete" ? "destructive" : "outline"}
                      onClick={() => onAction?.(action)}
                    >
                      {action.label}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          </CardHeader>
        ) : null}
        <CardContent className="space-y-0">
          <CardEmptyState>
            {emptyState ?? (lang === "nl" ? "Geen gerelateerde items gevonden." : "No related items found.")}
          </CardEmptyState>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {title || actions?.length ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          {title ? <CardTitle className="text-base">{title}</CardTitle> : <div />}
          {actions?.length ? (
            <div className="flex flex-wrap gap-2">
              {actions.map((action) => (
                <Button
                  key={action.key}
                  type="button"
                  size="sm"
                  variant={action.mutation === "delete" ? "destructive" : "outline"}
                  onClick={() => onAction?.(action)}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {items.map((item, index) => {
          const entries = getCardEntries(item, lang);
          return (
            <Card key={`${item.id ?? "relationship"}-${index}`} className="bg-background p-4">
              <CardHeader>
                <CardTitle className="text-base">{getCardTitle(item, lang)}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {entries.length > 0 ? (
                  entries.map((entry) => (
                    <div key={entry.key} className="space-y-1">
                      <DisplayLabel>{entry.key}</DisplayLabel>
                      <p className="text-sm leading-6 text-foreground">
                        {entry.value}
                      </p>
                    </div>
                  ))
                ) : (
                  <CardEmptyState>
                    {lang === "nl" ? "Geen gegevens beschikbaar." : "No data available."}
                  </CardEmptyState>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
