// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@openshapeforge/ui";
import {
  RelationshipList,
  type RelationshipRenderFieldValue,
} from "@/features/renderer/display/relationship-list";
import type { RendererChildRelationshipUsage } from "@/features/renderer/form-definition";

export type LoadChildrenResult = {
  items: Record<string, unknown>[];
  endCursor: string | null;
  hasNextPage: boolean;
};

export type LoadChildren = (
  childRel: RendererChildRelationshipUsage,
  parentId: string,
  after?: string,
) => Promise<LoadChildrenResult>;

type Props = {
  childRel: RendererChildRelationshipUsage;
  parentId: string;
  lang: string;
  onLoadChildren: LoadChildren;
  renderFieldValue?: RelationshipRenderFieldValue;
};

function childSectionLabel(
  childRel: RendererChildRelationshipUsage,
  lang: string,
): string {
  const title = childRel.title;
  if (title) {
    if (lang === "nl" && title.nl) return title.nl;
    if (title.en) return title.en;
    if (title.nl) return title.nl;
  }
  return childRel.name;
}

/**
 * Collapsible child list shown beneath a parent relationship row. Rows are
 * fetched lazily on first expand via {@link Props.onLoadChildren}, scoped to
 * {@link Props.parentId}. "Meer laden" pages forward with the keyset cursor.
 *
 * Non-recursive by design: the fetched rows render through a flat
 * {@link RelationshipList}, so depth-1 children (e.g. a content block's
 * `MarkdownDisplay` body) render inline without further nesting.
 */
export function ExpandableChildSection({
  childRel,
  parentId,
  lang,
  onLoadChildren,
  renderFieldValue,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [endCursor, setEndCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const label = childSectionLabel(childRel, lang);
  const fields = childRel.fields
    ? [...childRel.fields]
    : undefined;

  const loadPage = async (after?: string) => {
    setLoading(true);
    setError(false);
    try {
      const result = await onLoadChildren(childRel, parentId, after);
      setItems((prev) => (after ? [...prev, ...result.items] : result.items));
      setEndCursor(result.endCursor);
      setHasNextPage(result.hasNextPage);
      setLoaded(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !loaded && !loading) {
      void loadPage();
    }
  };

  const handleLoadMore = () => {
    if (loading || !hasNextPage) return;
    void loadPage(endCursor ?? undefined);
  };

  return (
    <div className="mt-3 border-t pt-3">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="-ml-2 h-8 gap-1.5 px-2 text-sm font-medium text-muted-foreground"
        onClick={handleToggle}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
        )}
        <span>{label}</span>
      </Button>

      {expanded ? (
        <div className="mt-2">
          {error ? (
            <div className="px-1 py-2 text-sm text-destructive">
              {lang === "nl"
                ? "Kon onderliggende items niet laden."
                : "Could not load child items."}
            </div>
          ) : loading && !loaded ? (
            <div className="px-1 py-2 text-sm text-muted-foreground">
              {lang === "nl" ? "Laden…" : "Loading…"}
            </div>
          ) : (
            <>
              <RelationshipList
                items={items}
                lang={lang}
                presentationType={childRel.presentationType ?? "listItem"}
                titleField={childRel.titleField}
                subtitleField={childRel.subtitleField}
                emptyState={childSectionEmptyState(childRel, lang)}
                fields={fields}
                renderFieldValue={renderFieldValue}
              />
              {hasNextPage ? (
                <div className="mt-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleLoadMore}
                    disabled={loading}
                  >
                    {loading
                      ? lang === "nl"
                        ? "Laden…"
                        : "Loading…"
                      : lang === "nl"
                        ? "Meer laden"
                        : "Load more"}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function childSectionEmptyState(
  childRel: RendererChildRelationshipUsage,
  lang: string,
): string | undefined {
  const emptyState = childRel.emptyState;
  if (!emptyState) return undefined;
  if (lang === "nl" && emptyState.nl) return emptyState.nl;
  return emptyState.en ?? emptyState.nl ?? undefined;
}
