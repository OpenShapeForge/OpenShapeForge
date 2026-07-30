// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";

import { cn } from "../lib/cn";

type IconComponent = ComponentType<{ className?: string; strokeWidth?: string | number }>;
type LinkComponent = ComponentType<AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>;

export type SidebarItemState = "active" | "hover" | "current";
export type SidebarItemMode = "expanded" | "collapsed";

export interface SidebarItemProps {
  /** Figma `state` axis. */
  state?: SidebarItemState;
  /** Figma `mode` axis. */
  mode?: SidebarItemMode;
  /** Icon component rendered in the 20px icon slot. */
  icon: IconComponent;
  /** Expanded-mode label. Hidden in collapsed mode. */
  children: ReactNode;
  href?: string;
  linkComponent?: LinkComponent;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * Battery `sidebar-item` — navigation row / collapsed icon button.
 *
 * @figma component set — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-800
 * @figma state=active,mode=expanded — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-791
 * @figma state=hover,mode=expanded — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-801
 * @figma state=current,mode=expanded — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=4-806
 * @figma state=active,mode=collapsed — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=7-1242
 * @figma state=hover,mode=collapsed — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=7-1261
 * @figma state=current,mode=collapsed — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=7-1257
 */
export function SidebarItem({
  state = "active",
  mode = "expanded",
  icon: Icon,
  children,
  href,
  linkComponent: LinkComponent,
  onClick,
  disabled = false,
  className,
  "aria-label": ariaLabel,
}: SidebarItemProps) {
  const isExpanded = mode === "expanded";
  const label = typeof children === "string" ? children : ariaLabel;
  const content = (
    <span
      className={cn(
        "flex min-w-0 items-center rounded-[var(--radius-small)] transition-colors",
        isExpanded ? "h-full flex-1 gap-2 p-2" : "size-8 justify-center",
        state === "active" &&
          "text-[var(--color-foreground-muted)] group-hover:bg-[var(--color-accent)] group-hover:text-[var(--color-foreground-subtle)]",
        state === "hover" && "bg-[var(--color-accent)] text-[var(--color-foreground-subtle)]",
        state === "current" && "bg-[var(--color-foreground-muted)] text-[var(--color-card)]",
      )}
    >
      <Icon className="size-5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
      {isExpanded ? (
        <span className="min-w-0 truncate font-sans text-[14px] font-normal leading-[14px] tracking-[-0.42px]">
          {children}
        </span>
      ) : null}
    </span>
  );
  const commonProps = {
    title: label,
    "aria-label": ariaLabel ?? label,
    "aria-current": state === "current" ? ("page" as const) : undefined,
    "aria-disabled": disabled ? ("true" as const) : undefined,
    className: cn(
      "group flex shrink-0 items-center p-0 transition-colors",
      isExpanded ? "h-9 w-full" : "size-8 justify-center",
      disabled && "cursor-not-allowed opacity-60",
      className,
    ),
  };

  if (href && !disabled) {
    if (LinkComponent) {
      return (
        <LinkComponent href={href} data-slot="sidebar-item" data-state={state} data-mode={mode} onClick={onClick} {...commonProps}>
          {content}
        </LinkComponent>
      );
    }

    return (
      <a href={href} data-slot="sidebar-item" data-state={state} data-mode={mode} onClick={onClick} {...commonProps}>
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      data-slot="sidebar-item"
      data-state={state}
      data-mode={mode}
      {...commonProps}
    >
      {content}
    </button>
  );
}
