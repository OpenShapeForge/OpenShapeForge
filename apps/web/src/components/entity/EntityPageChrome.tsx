// SPDX-License-Identifier: BUSL-1.1
/**
 * EntityPageChrome — page chrome wrapper for entity detail and form pages.
 *
 * Provides a consistent layout shell with breadcrumbs, page title, subtitle,
 * optional status badge, header actions (edit, delete), and notice banners.
 * Header actions support navigation (route-based) and mutation (delete via
 * GraphQL) with confirmation dialogs.
 *
 * Used by all compiler-generated entity pages as the outermost layout wrapper.
 *
 * @input  EntityPageHeader (title, breadcrumbs, actions), optional notice, children
 * @output Page shell with header, action buttons, notice banner, and content slot
 */
"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { Badge } from "@/components/ui/display/badge";
import { Button } from "@openshapeforge/ui";
import { BodyHeader } from "@/components/ui/layout/body-header";
import { cn } from "@/lib/utils";
import { useEntityHeaderAction } from "./use-entity-header-action";
import type { EntityPageHeader } from "./entity-page-contract";

interface EntityPageChromeProps {
  header?: EntityPageHeader;
  title?: ReactNode;
  subtitle?: ReactNode;
  notice?: {
    tone?: "error" | "warning" | "info";
    message: ReactNode;
  };
  /** Rendered before the standard header actions (Edit, Delete) in the same row. */
  headerExtra?: ReactNode;
  /** Rendered after domain badges in the badges row (e.g., label rule badges). */
  headerBadges?: ReactNode;
  children: ReactNode;
  className?: string;
  density?: "spacious" | "compact";
  breadcrumb?: ReactNode;
}

export function EntityPageChrome({
  header,
  title,
  subtitle,
  notice,
  headerExtra,
  headerBadges,
  children,
  className,
  density = "spacious",
  breadcrumb,
}: EntityPageChromeProps) {
  useEffect(() => {
    (window as unknown as Record<string, number>)["__HYDRATE_PROBE_PAGE"] = Date.now();
  }, []);

  const resolvedHeader = header ?? { title, subtitle };
  const {
    actionError: headerError,
    handleAction: handleHeaderAction,
    isPending,
  } = useEntityHeaderAction(resolvedHeader.actionsContext);
  const noticeClasses = notice?.tone === "error"
    ? "border-destructive/30 bg-destructive/10 text-destructive"
    : notice?.tone === "info"
      ? "border-border bg-muted/40 text-muted-foreground"
      : "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200";

  return (
    <div
      className={cn(
        density === "compact"
          ? "flex w-full max-w-[1280px] flex-col gap-5 px-8 pt-5 pb-8"
          : "flex w-full max-w-[1180px] flex-col gap-8 px-10 pt-7 pb-10",
        className,
      )}
    >
      <header className="space-y-4">
        {breadcrumb && (
          <div className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            {breadcrumb}
          </div>
        )}

        <BodyHeader
          className="space-y-2"
          title={
            <span
              className={cn(
                "font-semibold tracking-[-0.5px] leading-[1.15]",
                density === "compact"
                  ? "text-[22px] tracking-[-0.3px]"
                  : "text-[30px]",
              )}
            >
              {resolvedHeader.title}
            </span>
          }
        />

        {resolvedHeader.subtitle ? (
          <p
            className={cn(
              "max-w-[680px] text-muted-foreground",
              density === "compact" ? "text-[13px]" : "text-[14.5px]",
            )}
          >
            {resolvedHeader.subtitle}
          </p>
        ) : null}

        {resolvedHeader.badges?.length || headerBadges ? (
          <div className="flex flex-wrap gap-1.5">
            {resolvedHeader.badges?.map((badge) => (
              <Badge key={badge} variant="secondary">
                {badge}
              </Badge>
            ))}
            {headerBadges}
          </div>
        ) : null}

        {headerError ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {headerError}
          </p>
        ) : null}

        {notice ? (
          <p className={cn("rounded-lg border px-4 py-3 text-sm", noticeClasses)}>
            {notice.message}
          </p>
        ) : null}

        {headerExtra || resolvedHeader.actions?.length ? (
          <div className="flex flex-wrap gap-3">
            {headerExtra}
            {resolvedHeader.actions?.map((action) => (
              <Button
                key={action.key}
                type="button"
                variant={action.mutation === "delete" ? "destructive" : "outline"}
                disabled={action.disabled || (action.mutation === "delete" ? isPending : false)}
                title={action.disabledMessage ?? undefined}
                onClick={() => handleHeaderAction(action)}
                data-testid={`entity-action-${action.key}`}
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}
      </header>
      {children}
    </div>
  );
}
