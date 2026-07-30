// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Ruler } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "../lib/cn";

export interface ChipProps extends ComponentPropsWithoutRef<"span"> {
  /** Chip label. */
  children: ReactNode;
  /** Optional leading icon. Defaults to the Figma ruler icon mapping. */
  icon?: ReactNode;
}

/**
 * Figma `Chip` metadata label.
 *
 * @figma file-key=CbKdajB2p4lAW3bBGcHBYd
 * @figma name="Chip"
 * @figma node-id=650-17658
 */
export function Chip({
  children,
  icon = <Ruler aria-hidden="true" />,
  className,
  ...props
}: ChipProps) {
  return (
    <span
      data-slot="chip"
      className={cn(
        "inline-flex h-6 min-w-0 items-center gap-1 rounded-[var(--radius-small)] border border-[var(--color-border)] bg-transparent px-2 font-sans text-[13px] font-medium leading-[13px] text-[var(--color-foreground-subtle)]",
        className,
      )}
      {...props}
    >
      {icon ? (
        <span className="flex size-4 shrink-0 items-center justify-center text-[var(--color-foreground-subtle)] [&_svg]:size-4">
          {icon}
        </span>
      ) : null}
      <span className="truncate">{children}</span>
    </span>
  );
}
