// SPDX-License-Identifier: BUSL-1.1
"use client";

import { MoreVertical } from "lucide-react";
import { Button } from "@openshapeforge/ui";
import { resolveLucideIconByName } from "@/components/ui/icons/LucideIconByName";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/overlay/popover";
import { cn } from "@/lib/utils";

export interface TableRowAction {
  key: string;
  label: string;
  icon?: string;
  onClick: () => void;
  disabled?: boolean;
  disabledMessage?: string;
  tone?: "default" | "destructive";
}

export interface TableRowActionsMenuProps {
  actions: TableRowAction[];
  /** Accessible label for the multi-action trigger. Defaults to Dutch copy. */
  triggerLabel?: string;
  className?: string;
}

/**
 * Renders a row-level action affordance:
 * - Zero actions → renders nothing.
 * - One action → renders an inline button (icon-only if `icon` is given,
 *   otherwise a compact text button).
 * - Two or more actions → renders a kebab trigger with a popover menu.
 *
 * Visibility and disabled evaluation happens in the caller; this component
 * simply renders the list it is given.
 */
export function TableRowActionsMenu({
  actions,
  triggerLabel = "Rij acties",
  className,
}: TableRowActionsMenuProps) {
  if (actions.length === 0) return null;

  if (actions.length === 1) {
    const action = actions[0]!;
    const Icon = resolveLucideIconByName(action.icon);
    const tone = action.tone ?? "default";

    if (!Icon) {
      return (
        <div
          className={cn("flex items-center justify-end gap-1", className)}
          onClick={(event) => event.stopPropagation()}
          title={action.disabled ? action.disabledMessage : undefined}
        >
          <Button
            type="button"
            variant={tone === "destructive" ? "destructive" : "ghost"}
            size="xs"
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        </div>
      );
    }

    return (
      <div
        className={cn("flex items-center justify-end gap-1", className)}
        onClick={(event) => event.stopPropagation()}
        title={action.disabled ? action.disabledMessage : undefined}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={action.label}
          title={action.label}
          disabled={action.disabled}
          className={
            tone === "destructive"
              ? "text-destructive hover:text-destructive"
              : undefined
          }
          onClick={action.onClick}
        >
          <Icon />
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn("flex items-center justify-end", className)}
      onClick={(event) => event.stopPropagation()}
    >
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={triggerLabel}
            title={triggerLabel}
          >
            <MoreVertical />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-52 p-1" aria-label={triggerLabel}>
          <div className="space-y-1">
            {actions.map((action) => {
              const Icon = resolveLucideIconByName(action.icon);
              const tone = action.tone ?? "default";
              return (
                <button
                  key={action.key}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60",
                    tone === "destructive" && "text-destructive",
                  )}
                  disabled={action.disabled}
                  title={action.disabled ? action.disabledMessage : undefined}
                  onClick={action.onClick}
                >
                  {Icon ? <Icon className="size-4" /> : null}
                  <span>{action.label}</span>
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
