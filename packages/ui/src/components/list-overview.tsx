// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../lib/cn";

export type ListOverviewBreadcrumbItem = {
  label: ReactNode;
  icon?: ReactNode;
};

export type ListOverviewProps = ComponentPropsWithoutRef<"section"> & {
  breadcrumb?: ListOverviewBreadcrumbItem[];
  title: ReactNode;
  actions?: ReactNode;
  notice?: ReactNode;
  toolbar?: ReactNode;
};

/**
 * @figma component — https://www.figma.com/design/CbKdajB2p4lAW3bBGcHBYd/Habe%C5%8Dn-1.3?node-id=389-8328
 * @figma node-id=389:8328
 *
 * Figma `List \ Variant 1`: row-header 48px, title row 64px, table area
 * with 16px inset. The search/filter toolbar is not in Figma yet and is
 * exposed as a product slot.
 */
export function ListOverview({
  breadcrumb,
  title,
  actions,
  notice,
  toolbar,
  children,
  className,
  ...props
}: ListOverviewProps) {
  return (
    <section
      data-slot="list-overview"
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 flex-col bg-[var(--color-card)]",
        className,
      )}
      {...props}
    >
      {breadcrumb && breadcrumb.length > 0 ? (
        <nav
          aria-label="Breadcrumb"
          data-slot="list-overview-breadcrumb"
          className="flex h-12 shrink-0 items-center gap-1 border-b border-[var(--color-border-subtle)] px-4 pr-2 font-sans text-[13px] font-semibold leading-[13px] text-[var(--color-foreground-subtle)]"
        >
          {breadcrumb.map((item, index) => (
            <span
              key={index}
              className={cn(
                "flex min-w-0 items-center gap-1",
                index < breadcrumb.length - 1
                  ? "shrink-0"
                  : "flex-1 truncate",
              )}
            >
              {item.icon ? (
                <span className="flex size-4 shrink-0 items-center justify-center text-[var(--color-foreground-muted)] [&_svg]:size-4">
                  {item.icon}
                </span>
              ) : null}
              <span className="truncate">{item.label}</span>
              {index < breadcrumb.length - 1 ? (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="size-4 shrink-0 text-[var(--color-foreground-muted)]"
                >
                  <path
                    d="M6 4.5 9.5 8 6 11.5"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.25"
                  />
                </svg>
              ) : null}
            </span>
          ))}
        </nav>
      ) : null}

      <div
        data-slot="list-overview-header"
        className="flex h-16 shrink-0 items-center gap-4 px-4 py-4"
      >
        <h1 className="min-w-0 flex-1 truncate font-sans text-[24px] font-medium leading-[24px] text-black">
          {title}
        </h1>
        {actions ? (
          <div className="flex shrink-0 items-center justify-end gap-2">
            {actions}
          </div>
        ) : null}
      </div>

      {notice ? (
        <div data-slot="list-overview-notice" className="shrink-0 px-4 pb-3">
          {notice}
        </div>
      ) : null}

      {toolbar ? (
        <div data-slot="list-overview-toolbar" className="shrink-0 px-4 pb-4">
          {toolbar}
        </div>
      ) : null}

      <div
        data-slot="list-overview-table-area"
        className="min-h-0 flex-1 overflow-auto px-4 pb-4"
      >
        {children}
      </div>
    </section>
  );
}

