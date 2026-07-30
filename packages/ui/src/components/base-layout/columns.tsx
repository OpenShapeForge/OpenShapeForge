// SPDX-License-Identifier: BUSL-1.1
import { Children, type ReactNode } from "react";

import { cn } from "../../lib/cn";
import type {
  BaseLayoutColumnSize,
  LayoutColumn,
  LayoutColumnStyle,
} from "./types";

type BuildLayoutColumnsOptions = {
  hasLeft: boolean;
  hasRight: boolean;
  left?: ReactNode;
  main?: ReactNode;
  right?: ReactNode;
  leftSize?: BaseLayoutColumnSize;
  mainSize?: BaseLayoutColumnSize;
  rightSize?: BaseLayoutColumnSize;
  leftClassName?: string;
  mainClassName?: string;
  rightClassName?: string;
};

function SlotPlaceholder() {
  return (
    <div className="flex size-full items-center justify-center p-6">
      <span className="whitespace-nowrap font-sans text-[10px] font-normal leading-[10px] tracking-[-0.3px] text-[var(--color-foreground-muted)]">
        Replace with content
      </span>
    </div>
  );
}

function mergeColumnSize(
  defaults: BaseLayoutColumnSize,
  override?: BaseLayoutColumnSize,
): BaseLayoutColumnSize {
  return {
    ...defaults,
    ...override,
  };
}

export function buildLayoutColumns({
  hasLeft,
  hasRight,
  left,
  main,
  right,
  leftSize,
  mainSize,
  rightSize,
  leftClassName,
  mainClassName,
  rightClassName,
}: BuildLayoutColumnsOptions): LayoutColumn[] {
  const columns: LayoutColumn[] = [];

  if (hasLeft) {
    columns.push({
      id: "left",
      element: "section",
      content: left ?? <SlotPlaceholder />,
      sizing: mergeColumnSize(
        { defaultWidth: 280, minWidth: 200, maxWidth: 800 },
        leftSize,
      ),
      className: cn(
        "relative flex h-full min-h-0 shrink-0 items-stretch overflow-hidden border-r border-[var(--color-border-subtle)]",
        leftClassName,
      ),
    });
  }

  columns.push({
    id: "main",
    element: "main",
    content: main ?? <SlotPlaceholder />,
    sizing: mergeColumnSize({ minWidth: 280, weight: 1 }, mainSize),
    className: cn(
      "relative flex h-full min-h-0 min-w-px items-stretch overflow-hidden p-6",
      mainClassName,
    ),
  });

  if (hasRight) {
    columns.push({
      id: "right",
      element: "aside",
      ariaLabel: "Context panel",
      content: right ?? <SlotPlaceholder />,
      sizing: mergeColumnSize(
        { defaultWidth: 400, minWidth: 280, maxWidth: 1000 },
        rightSize,
      ),
      className: cn(
        "relative flex h-full min-h-0 shrink-0 items-stretch overflow-hidden border-l border-[var(--color-border-subtle)]",
        rightClassName,
      ),
    });
  }

  return columns;
}

export function buildColumnSignature(columns: LayoutColumn[]): string {
  return columns
    .map((column) =>
      [
        column.id,
        column.sizing.defaultWidth ?? "auto",
        column.sizing.minWidth ?? "min",
        column.sizing.maxWidth ?? "max",
        column.sizing.weight ?? 1,
      ].join(":"),
    )
    .join("|");
}

export function columnStyle(
  column: LayoutColumn,
  widths: number[] | null,
  index: number,
  columnCount: number,
): LayoutColumnStyle {
  if (widths && widths.length === columnCount) {
    return {
      width: `${widths[index]}px`,
      flex: "0 0 auto",
      minWidth: column.sizing.minWidth,
      maxWidth: column.sizing.maxWidth,
    };
  }

  if (column.sizing.defaultWidth !== undefined) {
    return {
      flex: `0 0 ${column.sizing.defaultWidth}px`,
      minWidth: column.sizing.minWidth,
      maxWidth: column.sizing.maxWidth,
    };
  }

  return {
    flex: `${column.sizing.weight ?? 1} 1 0%`,
    minWidth: column.sizing.minWidth,
    maxWidth: column.sizing.maxWidth,
  };
}

export function getColumnMinValue(column: LayoutColumn): number {
  return Math.round(column.sizing.minWidth ?? 0);
}

export function getColumnMaxValue(column: LayoutColumn, rowWidth: number): number {
  const maxWidth = column.sizing.maxWidth;
  if (maxWidth !== undefined && Number.isFinite(maxWidth)) {
    return Math.round(maxWidth);
  }

  return Math.max(Math.round(rowWidth), getColumnMinValue(column));
}

export function getColumnValue(
  column: LayoutColumn,
  widths: number[] | null,
  index: number,
): number {
  return Math.round(widths?.[index] ?? column.sizing.defaultWidth ?? 0);
}

export function canResizeColumnPair(
  columns: LayoutColumn[],
  index: number,
  rowWidth: number,
): boolean {
  const leftColumn = columns[index];
  const rightColumn = columns[index + 1];
  if (!leftColumn || !rightColumn) {
    return false;
  }

  return (
    getColumnMaxValue(leftColumn, rowWidth) > getColumnMinValue(leftColumn) &&
    getColumnMaxValue(rightColumn, rowWidth) > getColumnMinValue(rightColumn)
  );
}

export function normalizeSlotChildren(content: ReactNode): ReactNode {
  return Children.toArray(content);
}
