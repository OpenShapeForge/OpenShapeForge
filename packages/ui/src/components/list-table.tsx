// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  isValidElement,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

export type ListTableRowType = "standard" | "header";
export type ListTableCellType = "heavy" | "default" | "icon";
export type ListTableFileType = "workflow" | "case";

type ListTableStyle = CSSProperties & {
  "--list-table-columns"?: string;
};

function titleFromChildren(children: ReactNode, title: unknown) {
  if (typeof title === "string") return title;
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (isValidElement(children)) {
    const childTitle = (children as ReactElement<{ title?: unknown }>).props
      .title;
    if (typeof childTitle === "string") return childTitle;
  }
  return undefined;
}

function withTooltip(content: ReactElement, tooltip: string | undefined) {
  if (!tooltip) return content;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-[480px]">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * @figma component set — file-key=CbKdajB2p4lAW3bBGcHBYd node-id=392-6329
 * @figma node-id=392:6329
 */
export function ListTable({
  gridTemplateColumns = "minmax(0, 1fr)",
  className,
  style,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  gridTemplateColumns?: string;
}) {
  const listTableStyle: ListTableStyle = {
    ...style,
    "--list-table-columns": gridTemplateColumns,
  };

  return (
    <div
      data-slot="list-table-container"
      className="relative w-full min-w-0 overflow-x-auto"
    >
      <TooltipProvider>
        <div
          role="table"
          data-slot="list-table"
          style={listTableStyle}
          className={cn(
            "w-full min-w-0 font-sans text-[13px] leading-4 tracking-[-0.39px]",
            className,
          )}
          {...props}
        />
      </TooltipProvider>
    </div>
  );
}

export function ListTableHeader({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      role="rowgroup"
      data-slot="list-table-header"
      className={cn("bg-[var(--color-surface)]", className)}
      {...props}
    />
  );
}

export function ListTableBody({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      role="rowgroup"
      data-slot="list-table-body"
      className={cn(
        "[&_[data-slot=list-table-row]:last-child_[data-slot=list-table-cell]]:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

export function ListTableRow({
  type = "standard",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  type?: ListTableRowType;
}) {
  return (
    <div
      role="row"
      data-slot="list-table-row"
      data-type={type}
      className={cn(
        "grid h-12 min-w-0 grid-cols-[var(--list-table-columns)] transition-colors",
        type === "header" && "bg-[var(--color-surface)]",
        type === "standard" &&
          "bg-[var(--color-card)] hover:bg-[var(--color-surface)] data-[state=selected]:bg-[var(--color-surface)]",
        className,
      )}
      {...props}
    />
  );
}

export function ListTableCell({
  type = "default",
  iconLeft,
  iconRight,
  fileIcon,
  children,
  className,
  contentClassName,
  colSpan,
  title,
  style,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  type?: ListTableCellType;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  fileIcon?: ListTableFileType | false | null;
  contentClassName?: string;
  colSpan?: number;
}) {
  const resolvedTitle = titleFromChildren(children, title);
  const cellStyle: CSSProperties | undefined = colSpan
    ? { ...style, gridColumn: "1 / -1" }
    : style;

  return (
    <div
      role="cell"
      data-slot="list-table-cell"
      data-type={type}
      style={cellStyle}
      className={cn(
        "min-w-0 border-b border-[var(--color-border-subtle)] p-0",
        type === "icon" && "w-12",
        className,
      )}
      {...props}
    >
      {withTooltip(
        <div
          className={cn(
            "flex h-12 min-w-0 items-center gap-2 px-4",
            type === "icon" && "justify-center gap-2 px-4",
            contentClassName,
          )}
        >
          {iconLeft ? (
            <span className="flex size-4 shrink-0 items-center justify-center text-[var(--color-foreground-muted)] [&_svg]:size-4">
              {iconLeft}
            </span>
          ) : null}
          {fileIcon ? <ListTableFileTypeIcon type={fileIcon} /> : null}
          <div
            className={cn(
              "min-w-0 truncate",
              type === "heavy"
                ? "font-medium text-[var(--color-foreground)]"
                : "font-normal text-[var(--color-foreground-muted)]",
              type === "icon" &&
                "flex min-w-0 items-center justify-center text-[var(--color-foreground-muted)]",
            )}
          >
            {children}
          </div>
          {iconRight ? (
            <span className="ml-auto flex size-4 shrink-0 items-center justify-center text-[var(--color-foreground-muted)] [&_svg]:size-4">
              {iconRight}
            </span>
          ) : null}
        </div>,
        resolvedTitle,
      )}
    </div>
  );
}

export function ListTableHead({
  type = "default",
  iconLeft,
  iconRight,
  children,
  className,
  contentClassName,
  title,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  type?: ListTableCellType;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  contentClassName?: string;
}) {
  const resolvedTitle = titleFromChildren(children, title);

  return (
    <div
      role="columnheader"
      data-slot="list-table-head"
      data-type={type}
      className={cn(
        "min-w-0 border-b border-[var(--color-border-subtle)] p-0 text-left",
        type === "icon" && "w-12",
        className,
      )}
      {...props}
    >
      {withTooltip(
        <div
          className={cn(
            "flex h-12 min-w-0 items-center gap-2 px-4",
            type === "icon" && "justify-center gap-2 px-4",
            contentClassName,
          )}
        >
          {iconLeft ? (
            <span className="flex size-4 shrink-0 items-center justify-center text-[var(--color-foreground-muted)] [&_svg]:size-4">
              {iconLeft}
            </span>
          ) : null}
          <span
            className={cn(
              "min-w-0 truncate",
              type === "heavy"
                ? "font-medium text-[var(--color-foreground)]"
                : "font-normal text-[var(--color-foreground-subtle)]",
              type === "icon" && "sr-only",
            )}
          >
            {children}
          </span>
          {iconRight ? (
            <span className="ml-auto flex size-4 shrink-0 items-center justify-center text-[var(--color-foreground-muted)] [&_svg]:size-4">
              {iconRight}
            </span>
          ) : null}
        </div>,
        resolvedTitle,
      )}
    </div>
  );
}

/**
 * @figma component set — file-key=CbKdajB2p4lAW3bBGcHBYd node-id=397-6951
 * @figma node-id=397:6951
 */
export function ListTableFileTypeIcon({
  type,
  className,
  ...props
}: ComponentPropsWithoutRef<"span"> & {
  type: ListTableFileType;
}) {
  return (
    <span
      data-slot="list-table-filetype"
      data-type={type}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-[3px] text-white",
        type === "workflow" ? "bg-[#7E8ED3]" : "bg-[#2ED3A3]",
        className,
      )}
      {...props}
    >
      {type === "workflow" ? <WorkflowGlyph /> : <CaseGlyph />}
    </span>
  );
}

export function ListTableSortIcon({
  className,
  ...props
}: ComponentPropsWithoutRef<"svg">) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={cn("size-4", className)}
      {...props}
    >
      <path
        d="M7.354 11.147c.047.046.084.101.109.162.025.06.038.126.038.191s-.013.131-.038.192a.5.5 0 0 1-.109.162l-2 2a.5.5 0 0 1-.708 0l-2-2a.5.5 0 1 1 .708-.707L4.5 12.294V3.5a.5.5 0 0 1 1 0v8.794l1.146-1.147a.5.5 0 0 1 .708 0Zm6-6-2-2a.5.5 0 0 0-.708 0l-2 2a.5.5 0 1 0 .708.707L10.5 4.707V13.5a.5.5 0 0 0 1 0V4.707l1.146 1.147a.5.5 0 1 0 .708-.707Z"
        fill="currentColor"
      />
    </svg>
  );
}

function WorkflowGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3">
      <path
        d="M10.5 2.249c0-.281-.079-.555-.227-.793a1.5 1.5 0 0 0-2.192-.392 1.5 1.5 0 0 0 .544 2.138V4a.375.375 0 0 1-.375.375h-4.5A.375.375 0 0 1 3.375 4v-.797a1.5 1.5 0 1 0-.75 0V4a1.125 1.125 0 0 0 1.125 1.125h1.875v1.171a1.5 1.5 0 1 0 .75 0V5.125H8.25A1.125 1.125 0 0 0 9.375 4v-.797A1.5 1.5 0 0 0 10.5 2.249Zm-8.25 0a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0Zm4.5 6a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm2.25-5.25a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function CaseGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3">
      <path
        d="m11.515 2.735-1.5-1.5a.375.375 0 0 0-.53.53l.86.86H9.75c-2.312 0-2.862 1.318-3.346 2.481-.44 1.055-.793 1.902-2.319 2.008A1.875 1.875 0 1 0 4.09 7.864c2.028-.124 2.547-1.366 3.006-2.47C7.566 4.266 7.937 3.375 9.75 3.375h.595l-.86.86a.375.375 0 0 0 .53.53l1.5-1.5a.375.375 0 0 0 0-.53ZM2.25 8.625a1.125 1.125 0 1 1 0-2.25 1.125 1.125 0 0 1 0 2.25Z"
        fill="currentColor"
      />
    </svg>
  );
}
