// SPDX-License-Identifier: BUSL-1.1
import { X } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Small label chip used to annotate records (e.g. conversation tags, workflow
 * labels). Renders an optional remove button when `onRemove` is supplied.
 *
 * @figma tag — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=110-4371
 */
export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  /** Tag label text. */
  children: ReactNode;
  /** Called when the remove button is clicked. The button is only shown when this is provided. */
  onRemove?: () => void;
  /** Accessible label for the remove button. Defaults to "Verwijderen". */
  removeLabel?: string;
}

export function Tag({
  children,
  onRemove,
  removeLabel = "Verwijderen",
  className,
  ...props
}: TagProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-extrasmall)] bg-background p-1 font-sans text-[12px] font-medium leading-[12px] tracking-[-0.36px] text-foreground",
        className,
      )}
      {...props}
    >
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="flex size-3 shrink-0 items-center justify-center transition-colors hover:text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
