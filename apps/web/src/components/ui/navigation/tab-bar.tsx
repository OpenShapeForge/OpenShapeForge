// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export type TabBarItem = {
  id: string;
  label: ReactNode;
  href?: string;
  disabled?: boolean;
  prefetch?: boolean;
  scroll?: boolean;
};

export type TabBarProps = Omit<ComponentPropsWithoutRef<"div">, "onChange"> & {
  tabs: TabBarItem[];
  activeTab: string;
  onTabChange?: (tabId: string) => void;
  listClassName?: string;
  tabClassName?: string;
};

function getTabClassName(isActive: boolean, disabled: boolean, tabClassName?: string) {
  return cn(
    "-mb-px px-1 pb-3 pt-1 text-[14px] font-medium transition-colors border-b-2",
    isActive
      ? "border-neutral-950 text-neutral-950"
      : "border-transparent text-muted-foreground hover:text-foreground",
    disabled && "pointer-events-none opacity-50",
    tabClassName,
  );
}

export function TabBar({
  tabs,
  activeTab,
  onTabChange,
  className,
  listClassName,
  tabClassName,
  ...props
}: TabBarProps) {
  return (
    <div className={cn("flex gap-4 border-b", className)} {...props}>
      <div className={cn("flex flex-wrap gap-4", listClassName)}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          const disabled = tab.disabled ?? false;
          const content = tab.label;
          const classes = getTabClassName(isActive, disabled, tabClassName);

          if (tab.href && !disabled) {
            return (
              <Link
                key={tab.id}
                href={tab.href}
                prefetch={tab.prefetch}
                scroll={tab.scroll}
                aria-current={isActive ? "page" : undefined}
                className={classes}
                onClick={() => onTabChange?.(tab.id)}
              >
                {content}
              </Link>
            );
          }

          return (
            <button
              key={tab.id}
              type="button"
              className={classes}
              disabled={disabled}
              aria-pressed={isActive}
              onClick={() => onTabChange?.(tab.id)}
            >
              {content}
            </button>
          );
        })}
      </div>
    </div>
  );
}
