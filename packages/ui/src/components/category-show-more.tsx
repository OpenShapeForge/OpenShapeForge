// SPDX-License-Identifier: BUSL-1.1
import { MoreHorizontal } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Trailing row inside a category that toggles between collapsed and expanded
 * states. Used in the workflow library to show the next batch of node types.
 *
 * @figma category-show-more — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=57-4174
 *
 * Icon mapping: Figma `DotsThree` → lucide `MoreHorizontal`.
 */
export interface CategoryShowMoreProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Custom label content. Falls back to "Show more" / "Show less". */
  label?: ReactNode;
  /** Whether the category is currently expanded. Default false. */
  expanded?: boolean;
  /** Hidden item count to append when collapsed (e.g. " (3)"). */
  hiddenCount?: number;
}

export const CategoryShowMore = forwardRef<
  HTMLButtonElement,
  CategoryShowMoreProps
>(
  (
    { label, expanded = false, hiddenCount, className, type, ...props },
    ref,
  ) => {
    const text =
      label ??
      (expanded
        ? "Show less"
        : hiddenCount && hiddenCount > 0
          ? `Show more (${hiddenCount})`
          : "Show more");

    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cn(
          "flex w-full items-center gap-1 text-left transition-colors hover:text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          className,
        )}
        {...props}
      >
        <span className="flex size-7 shrink-0 items-center justify-center">
          <MoreHorizontal
            aria-hidden="true"
            className="size-4 text-muted-foreground"
          />
        </span>
        <span className="font-sans text-[12px] font-normal leading-[12px] tracking-[-0.36px] text-muted-foreground">
          {text}
        </span>
      </button>
    );
  },
);

CategoryShowMore.displayName = "CategoryShowMore";
