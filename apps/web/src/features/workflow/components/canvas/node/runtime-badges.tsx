// SPDX-License-Identifier: BUSL-1.1
"use client";

import { cn } from "@/lib/utils";
import type { NodeRuntime } from "./types";

/**
 * Run state for one node, as a row of small pills.
 *
 * The active pill is a tinted fill with foreground text rather than the canvas
 * selection colour: that accent fails WCAG AA against white at every shade, so
 * it may border a badge but never fill one behind text.
 */
export function RuntimeBadges({ runtime }: { runtime: NodeRuntime }) {
  const items: Array<{ key: string; label: string; active?: boolean }> = [];

  if (runtime.status) {
    items.push({
      key: "status",
      label: runtime.status,
      active: runtime.isActive === true,
    });
  }
  if (runtime.waitKind) {
    items.push({ key: "wait", label: `waiting: ${runtime.waitKind}` });
  }
  // A pass count of one is what every node has; only a repeat is news.
  if (typeof runtime.executionCount === "number" && runtime.executionCount > 1) {
    items.push({ key: "passes", label: `×${runtime.executionCount}` });
  }

  if (items.length === 0) return null;

  return (
    <div className="mt-1 flex w-full flex-wrap gap-1">
      {items.map((item) => (
        <span
          key={item.key}
          className={cn(
            "inline-flex items-center rounded-full border px-1.5 py-[2px] font-sans text-[10px] font-semibold leading-[10px] tracking-[0.01em]",
            item.active
              ? "border-node-card-focus bg-[var(--color-brand-aquamarine-20)] text-foreground"
              : "border-node-card-border-subtle bg-surface text-foreground-subtle",
          )}
        >
          {item.label}
        </span>
      ))}
    </div>
  );
}
