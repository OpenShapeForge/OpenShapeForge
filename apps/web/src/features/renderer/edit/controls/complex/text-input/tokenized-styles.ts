// SPDX-License-Identifier: BUSL-1.1
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import type { TextInputVariant, TokenSegment } from "./types";

export function getMultilineMinHeightStyle({
  multiline,
  rows,
}: {
  multiline: boolean;
  rows?: number;
}): CSSProperties | undefined {
  if (!multiline) {
    return undefined;
  }

  const resolvedRows = Math.max(2, rows ?? 5);
  return {
    minHeight: `calc(${resolvedRows} * 1.5rem)`,
  };
}

export function isPlaceholderVisible(segments: TokenSegment[]) {
  return (
    segments.length === 1 &&
    segments[0]?.kind === "text" &&
    segments[0].text.length === 0
  );
}

export function getTokenizedContainerClassName({
  ariaInvalid,
  className,
  disabled,
  multiline,
  readOnly,
  variant,
}: {
  ariaInvalid?: boolean;
  className?: string;
  disabled?: boolean;
  multiline: boolean;
  readOnly?: boolean;
  variant: TextInputVariant;
}) {
  return cn(
    "relative w-full text-foreground transition-[border-color,box-shadow,background-color,color]",
    variant === "heading"
      ? "bg-transparent px-0 py-0 text-2xl font-medium leading-tight tracking-tight"
      : "rounded-[var(--radius-field)] border bg-card px-2 py-[6px] text-[13px] leading-[22px] tracking-[-.39px] focus-within:ring-[3px]",
    variant === "default" && multiline ? "min-h-24 py-2" : undefined,
    variant === "default"
      ? ariaInvalid
        ? "border-destructive ring-destructive/20"
        : "border-input hover:border-foreground/20 focus-within:border-ring focus-within:ring-ring/20"
      : undefined,
    variant === "default" && disabled
      ? "cursor-not-allowed bg-muted/55 text-muted-foreground"
      : undefined,
    variant === "default" && readOnly ? "bg-muted/35 text-foreground/80" : undefined,
    className,
  );
}

export function getTokenizedPlaceholderClassName({
  multiline,
  variant,
}: {
  multiline: boolean;
  variant: TextInputVariant;
}) {
  return cn(
    "pointer-events-none absolute text-muted-foreground",
    variant === "heading"
      ? "left-0 inset-y-0 flex items-center text-2xl font-medium leading-tight tracking-tight"
      : "left-2 text-[13px] leading-[22px] tracking-[-.39px]",
    variant === "default" && multiline ? "top-2" : undefined,
    variant === "default" && !multiline ? "inset-y-0 flex items-center" : undefined,
  );
}
