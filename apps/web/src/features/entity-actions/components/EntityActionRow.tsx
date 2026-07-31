// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Full-width action row used by the `relationRows` presentation of
 * {@link EntityActionButtons}, where actions read as a list inside a side
 * panel rather than a cluster of buttons.
 *
 * The upstream design system rendered this through a Figma-authored asset set;
 * here the icon is whichever Lucide glyph the action names, matching how every
 * other generated surface in this app resolves entity-action icons.
 */
export interface EntityActionRowProps {
  label: string;
  /** Matches what `resolveLucideIconByName` returns. */
  icon?: ComponentType<LucideProps> | undefined;
  disabled?: boolean;
  /** Draws a hairline under the row. Omit on the last row of a group. */
  separator?: boolean;
  onClick?: (() => void) | undefined;
}

export function EntityActionRow({
  label,
  icon: Icon,
  disabled = false,
  separator = true,
  onClick,
}: EntityActionRowProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      className={cn(
        "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
        "font-sans text-sm font-normal leading-4 tracking-[-0.2px] text-foreground",
        separator && "border-b border-border-subtle",
        disabled
          ? "cursor-not-allowed text-foreground-muted"
          : "cursor-pointer hover:bg-accent",
      )}
    >
      {Icon ? (
        <Icon
          aria-hidden
          className={cn(
            "size-4 shrink-0",
            disabled ? "text-foreground-muted" : "text-brand-indigo-100",
          )}
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}
