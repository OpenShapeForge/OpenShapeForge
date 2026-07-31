// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useMemo } from "react";

import { cn } from "../../lib/cn";
import { Sidebar } from "../sidebar";
import { Surface } from "../surface";
import {
  buildColumnSignature,
  buildLayoutColumns,
  canResizeColumnPair,
  columnStyle,
  getColumnMaxValue,
  getColumnMinValue,
  getColumnValue,
  normalizeSlotChildren,
} from "./columns";
import { defaultTabs, TabsRow } from "./tabs-row";
import type { BaseLayoutProps, LayoutColumn } from "./types";
import { useResizableColumns } from "./use-resizable-columns";

/**
 * Battery `base-layout` — shared application shell for the four layout variants.
 *
 * Figma specifies fixed reference frames for design inspection. Runtime sizing
 * is intentionally fluid: the layout fills its parent, and the parent owns the
 * actual viewport or panel height.
 *
 * @figma section node-id=2-45 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=2-45
 * @figma main node-id=77-2036 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=77-2036
 * @figma inbox-main node-id=77-2052 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=77-2052
 * @figma main-context node-id=77-2069 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=77-2069
 * @figma inbox-main-context node-id=77-2068 — https://www.figma.com/design/zokrrtGzRevHFAesahnlVi/Battery?node-id=77-2068
 */
export function BaseLayout({
  variant = "inbox-main-context",
  sidebar,
  left,
  main,
  right,
  tabs = defaultTabs,
  topNav,
  "top-nav": topNavFigma,
  resizable = true,
  leftSize,
  mainSize,
  rightSize,
  mainClassName,
  leftClassName,
  rightClassName,
  contentClassName,
  cardClassName,
  storageKey = "base-layout",
  persistKey,
  className,
  "data-slot": dataSlot = "base-layout",
  ...props
}: BaseLayoutProps) {
  const hasLeft = variant === "inbox-main" || variant === "inbox-main-context";
  const hasRight = variant === "main-context" || variant === "inbox-main-context";
  const topNavContent = topNavFigma ?? topNav;
  const effectiveStorageKey = persistKey ? `${storageKey}:${persistKey}` : null;

  const columns = useMemo<LayoutColumn[]>(
    () =>
      buildLayoutColumns({
        hasLeft,
        hasRight,
        left,
        leftClassName,
        leftSize,
        main,
        mainClassName,
        mainSize,
        right,
        rightClassName,
        rightSize,
      }),
    [
      hasLeft,
      hasRight,
      left,
      leftClassName,
      leftSize,
      main,
      mainClassName,
      mainSize,
      right,
      rightClassName,
      rightSize,
    ],
  );

  const sizingSignature = useMemo(
    () => buildColumnSignature(columns),
    [columns],
  );
  const {
    columnWidths,
    handleResizeKeyDown,
    handleResizeStart,
    rowRef,
    rowWidth,
  } = useResizableColumns({
    columns,
    effectiveStorageKey,
    resizable,
    sizingSignature,
  });

  return (
    <Surface
      {...props}
      data-slot={dataSlot}
      data-variant={variant}
      variant="background"
      className={cn(
        "flex size-full min-h-0 min-w-0 items-start gap-2 overflow-hidden rounded-[var(--radius-large)] p-2 outline outline-1 outline-[var(--color-border)]",
        className,
      )}
    >
      {sidebar === false ? null : sidebar ?? <Sidebar />}

      <div className="flex h-full min-h-0 min-w-px flex-1 flex-col items-stretch gap-2">
        {tabs === false ? null : <TabsRow tabs={tabs} />}

        <Surface
          variant="card"
          className={cn(
            "flex min-h-0 w-full flex-1 flex-col items-stretch justify-end overflow-hidden",
            cardClassName,
          )}
        >
          {topNavContent ? (
            <div className="h-16 w-full shrink-0 border-b border-[var(--color-border-subtle)]">
              {topNavContent}
            </div>
          ) : null}

          <div
            ref={rowRef}
            className={cn(
              "flex min-h-0 w-full flex-1 items-stretch overflow-hidden",
              contentClassName,
            )}
          >
            {columns.map((column, index) => {
              const Element = column.element;
              const showHandle =
                resizable &&
                index < columns.length - 1 &&
                canResizeColumnPair(columns, index, rowWidth);

              return (
                <Element
                  key={column.id}
                  aria-label={column.ariaLabel}
                  data-layout-panel={column.id}
                  className={column.className}
                  style={columnStyle(column, columnWidths, index, columns.length)}
                >
                  {normalizeSlotChildren(column.content)}
                  {showHandle ? (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${column.id} and ${columns[index + 1]?.id} columns`}
                      aria-valuemin={getColumnMinValue(column)}
                      aria-valuemax={getColumnMaxValue(column, rowWidth)}
                      aria-valuenow={getColumnValue(column, columnWidths, index)}
                      tabIndex={0}
                      onPointerDown={(event) => handleResizeStart(index, event)}
                      onKeyDown={(event) => handleResizeKeyDown(index, event)}
                      className="group absolute inset-y-0 right-0 z-20 flex w-4 touch-none cursor-col-resize items-stretch justify-end outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]/40"
                    >
                      <div className="w-px bg-transparent transition-colors group-hover:bg-[var(--color-foreground)]/30 group-focus-visible:bg-[var(--color-foreground)]/30" />
                    </div>
                  ) : null}
                </Element>
              );
            })}
          </div>
        </Surface>
      </div>
    </Surface>
  );
}
