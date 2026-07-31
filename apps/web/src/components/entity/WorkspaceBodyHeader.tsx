// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/display/badge";
import { Button } from "@openshapeforge/ui";
import { cn } from "@/lib/utils";
import { useEntityHeaderAction } from "./use-entity-header-action";
import type { EntityPageHeader } from "./entity-page-contract";

interface WorkspaceBodyHeaderProps {
  header: EntityPageHeader;
  notice?: string | null;
  /** Rendered before the standard header actions (Edit, Delete). */
  extra?: ReactNode;
}

export function WorkspaceBodyHeader({
  header,
  notice,
  extra,
}: WorkspaceBodyHeaderProps) {
  const { actionError, handleAction, isPending } = useEntityHeaderAction(
    header.actionsContext,
  );

  const hasBadges = (header.badges?.length ?? 0) > 0;
  const hasActions = (header.actions?.length ?? 0) > 0 || Boolean(extra);

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-4">
        <div className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.39px] text-foreground">
          {header.title}
        </div>

        {hasBadges ? (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {header.badges?.map((badge) => (
              <Badge key={badge} variant="outline">
                {badge}
              </Badge>
            ))}
          </div>
        ) : null}

        {hasActions ? (
          <div className="flex shrink-0 items-center gap-2">
            {extra}
            {header.actions?.map((action) => (
              <Button
                key={action.key}
                type="button"
                size="sm"
                variant={action.mutation === "delete" ? "destructive" : "outline"}
                disabled={action.disabled || (action.mutation === "delete" && isPending)}
                title={action.disabledMessage ?? undefined}
                onClick={() => handleAction(action)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      {actionError || notice ? (
        <div className="shrink-0 space-y-2 border-b border-border/60 px-4 py-3">
          {actionError ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {actionError}
            </p>
          ) : null}
          {notice ? (
            <p className={cn(
              "rounded-lg border px-3 py-2 text-sm",
              "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200",
            )}>
              {notice}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
